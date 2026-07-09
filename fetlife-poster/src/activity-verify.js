/**
 * Activity-feed verification — auto-confirm group posts stuck in
 * submitted_pending_moderation / outcome_unknown by looking at the posting
 * account's OWN activity feed (fetlife.com/<nickname>/activity).
 *
 * Why this works: a group post held in a moderation queue does not appear in
 * the author's activity feed; once a moderator approves it (or if it was live
 * all along and we just couldn't read the redirect), FetLife publishes a
 * "posted in <group>" story whose anchor is the post permalink
 * (/groups/<groupId>/(group_)?posts/<postId>) with the discussion title as the
 * link text. Finding that anchor is positive proof the post is live, so we can
 * flip the job to `sent` without the operator having to check FetLife by hand.
 *
 * Deliberately one-directional: absence from the feed proves nothing (slow
 * moderation vs. silent rejection are indistinguishable), so this sweep NEVER
 * auto-fails a post — rejections remain an operator call via mark-rejected.
 */

import { launchWithCookies, checkLoggedIn, waitOutCloudflare, assertNotBlocked } from './poster.js';
import { getQueue, confirmJobSent } from './scheduler.js';
import { getAccount } from './credentials.js';

const FL_BASE = 'https://fetlife.com';
const VERIFIABLE_STATUSES = new Set(['submitted_pending_moderation', 'outcome_unknown']);
// How many "scroll to bottom and let more stories render" rounds we give the
// feed before concluding the story isn't on it. Each round waits ~2.5s.
const MAX_SCROLL_ROUNDS = 6;

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The feed truncates long titles with an ellipsis, and the same permalink also
// appears with noise text ("12h", "Comment", a body snippet). Require a
// meaningful overlap with the job title specifically, in either direction.
function titleMatchesLinkText(jobTitle, linkText) {
  const title = norm(jobTitle);
  const text = norm(linkText).replace(/(\.{3}|…)$/, '').trim();
  if (!title || !text || text.length < 12) return false;
  return title === text || title.startsWith(text) || text.startsWith(title);
}

// The logged-in user's nickname is embedded exactly once in FetLife's page
// JSON ("nickname":"The-Crucible"). Collect every occurrence on /home — if
// they all agree it's unambiguously the session user; if they somehow don't,
// fall back to the stored login username (correct for every account that logs
// in with its nickname rather than an email).
async function discoverOwnNickname(page, account) {
  try {
    const html = await page.content();
    const hits = new Set();
    for (const m of html.matchAll(/"nickname"\s*:\s*"([^"]{2,40})"/g)) hits.add(m[1]);
    if (hits.size === 1) return [...hits][0];
  } catch { /* fall through to username */ }
  return account?.username || null;
}

async function scanFeedForGroupPostLinks(page) {
  return await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = /\/groups\/(\d+)\/(?:group_)?posts\/(\d+)/.exec(href);
      if (!m) continue;
      out.push({
        groupId: m[1],
        href: href.split('#')[0].split('?')[0],
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    }
    return out;
  }).catch(() => []);
}

/**
 * Verify one account's pending group posts against its activity feed.
 * Returns { accountId, checked, confirmed: [postId...], nickname } — or throws
 * on session/navigation failure (caller decides whether that's fatal).
 */
export async function verifyAccountPendingPosts(accountId, pendingJobs) {
  const account = await getAccount(accountId).catch(() => null);
  const { browser, context } = await launchWithCookies(accountId, { headless: true });
  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 2500));
    await checkLoggedIn(page);

    const nickname = await discoverOwnNickname(page, account);
    if (!nickname || nickname.includes('@')) {
      throw new Error(`Could not resolve FetLife nickname for ${accountId} — page JSON had no unambiguous "nickname" and the stored username isn't usable as one`);
    }

    await page.goto(`${FL_BASE}/${encodeURIComponent(nickname)}/activity`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 20000);
    await assertNotBlocked(page, `activity-${accountId}`);
    await new Promise(r => setTimeout(r, 3000));

    const unresolved = new Map(pendingJobs.map(j => [j.postId, j]));
    const confirmed = [];

    for (let round = 0; round < MAX_SCROLL_ROUNDS && unresolved.size > 0; round++) {
      const links = await scanFeedForGroupPostLinks(page);
      for (const job of [...unresolved.values()]) {
        const hit = links.find(l =>
          String(l.groupId) === String(job.groupId) && titleMatchesLinkText(job.title, l.text)
        );
        if (!hit) continue;
        const permalink = FL_BASE + hit.href;
        await confirmJobSent(job.postId, { confirmedBy: 'activity_feed', permalink });
        confirmed.push({ postId: job.postId, permalink });
        unresolved.delete(job.postId);
        console.log(`[activity-verify] ${accountId}: confirmed ${job.postId} → ${permalink}`);
        // Live-post notification, best-effort — same contract as the scheduler's.
        import('./telegram-bot.js').then(t => t.notifyPostPublished(job, { url: permalink, verifiedVia: 'activity_feed' })).catch(() => {});
      }
      if (unresolved.size === 0) break;
      // Nudge the infinite scroll and let the next batch of stories render.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
    }

    if (unresolved.size > 0) {
      console.log(`[activity-verify] ${accountId}: ${unresolved.size} post(s) still unconfirmed (not on the feed yet — moderation pending or rejected)`);
    }
    return { accountId, nickname, checked: pendingJobs.length, confirmed };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Sweep every account (or one, when accountId is given) that has group posts
 * awaiting confirmation. Per-account failures are recorded, not fatal — one
 * account's expired cookies must not block the others' sweeps.
 */
export async function verifyPendingGroupPosts({ accountId = null, onProgress = null } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const queue = await getQueue();
  const pending = queue.filter(j =>
    VERIFIABLE_STATUSES.has(j.status)
    && j.postType === 'group_event'
    && j.groupId && j.title
    && (!accountId || j.accountId === accountId)
  );
  const byAccount = new Map();
  for (const j of pending) {
    if (!byAccount.has(j.accountId)) byAccount.set(j.accountId, []);
    byAccount.get(j.accountId).push(j);
  }

  const results = [];
  for (const [acct, jobs] of byAccount) {
    progress(`${acct}: checking ${jobs.length} pending post(s)`);
    try {
      const r = await verifyAccountPendingPosts(acct, jobs);
      progress(`${acct}: ${r.confirmed.length}/${r.checked} confirmed`);
      results.push(r);
    } catch (err) {
      console.error(`[activity-verify] ${acct}: sweep failed — ${err.message}`);
      progress(`${acct}: failed — ${err.message.slice(0, 80)}`);
      results.push({ accountId: acct, checked: jobs.length, confirmed: [], error: err.message });
    }
  }
  const confirmedTotal = results.reduce((n, r) => n + (r.confirmed?.length || 0), 0);
  return { pending: pending.length, confirmedTotal, accounts: results };
}
