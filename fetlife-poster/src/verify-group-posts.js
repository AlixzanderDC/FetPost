/**
 * Cron entry point: trigger the activity-feed verification sweep for pending
 * group posts (submitted_pending_moderation / outcome_unknown) and log the
 * outcome.
 *
 * This is a thin HTTP client against the running poster service — it must NOT
 * import scheduler.js/activity-verify.js directly: scheduler.js has
 * module-level side effects (restoreScheduledJobs + timer arming) that would
 * fire due posts from this cron process in parallel with the service,
 * double-posting on FetLife. The sweep therefore always executes inside the
 * service; this script just kicks it off (?progress=1) and polls the progress
 * job until it settles.
 *
 * Run manually:
 *   node --env-file=../.env src/verify-group-posts.js
 * Or scheduled via cron, e.g.:
 *   30 6,12,18 * * * cd /root/fetpost/fetlife-poster && /usr/bin/node --env-file=/root/fetpost/.env src/verify-group-posts.js >> /root/fetpost/.logs/verify-group-posts.log 2>&1
 */

const BASE = process.env.POSTER_URL || 'http://localhost:3747';
const TOKEN = process.env.FL_SERVICE_SECRET;
const POLL_MS = 5000;
const MAX_WAIT_MS = 20 * 60 * 1000;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-service-token': TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || 'unknown error'}`);
  return data;
}

async function main() {
  if (!TOKEN) throw new Error('FL_SERVICE_SECRET not set — run with --env-file=/root/fetpost/.env');
  console.log(`[verify-cron] === Starting activity-feed verification at ${new Date().toISOString()} ===`);

  const { jobId } = await api('POST', '/posts/verify-pending?progress=1', {});
  console.log(`[verify-cron] Sweep started as progress job ${jobId}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStage = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const job = await api('GET', `/jobs/${jobId}`);
    const stage = job.stages?.length ? job.stages[job.stages.length - 1].name : '';
    if (stage && stage !== lastStage) { console.log(`[verify-cron] ${stage}`); lastStage = stage; }
    if (job.status === 'running') continue;
    if (job.status !== 'done') {
      throw new Error(`Sweep ${job.status}: ${job.error || 'no detail'}`);
    }
    const r = job.result || {};
    for (const a of r.accounts || []) {
      console.log(`[verify-cron] ${a.accountId}: ${a.error ? 'ERROR — ' + a.error : `${a.confirmed.length}/${a.checked} confirmed`}`);
      for (const c of a.confirmed || []) console.log(`[verify-cron]   ${c.postId} → ${c.permalink}`);
    }
    console.log(`[verify-cron] Total: ${r.confirmedTotal ?? 0}/${r.pending ?? 0} auto-confirmed`);
    console.log(`[verify-cron] === Done at ${new Date().toISOString()} ===`);
    return;
  }
  throw new Error(`Sweep did not finish within ${MAX_WAIT_MS / 60000} minutes — check the service logs`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('[verify-cron] Top-level error:', err.message);
  process.exit(1);
});
