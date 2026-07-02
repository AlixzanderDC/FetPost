/**
 * Cron entry point: iterate every account, refresh engagement metrics for all of its
 * tracked posts (loves, super loves, comments, views).
 *
 * Run manually:
 *   node --env-file=../.env src/refresh-tracked-posts.js
 * Or scheduled via cron, e.g.:
 *   0 6 * * * cd /root/fetpost/fetlife-poster && /usr/bin/node --env-file=/root/fetpost/.env src/refresh-tracked-posts.js >> /root/fetpost/.logs/tracked-posts.log 2>&1
 */

import { listAccounts } from './credentials.js';
import { refreshAllTrackedPosts, listTrackedPosts } from './tracked-posts.js';

async function main() {
  console.log(`[tracked-posts-cron] === Starting tracked posts refresh at ${new Date().toISOString()} ===`);
  const accounts = await listAccounts();
  for (const a of accounts) {
    const tracked = await listTrackedPosts(a.accountId);
    if (tracked.length === 0) {
      console.log(`[tracked-posts-cron] ${a.accountId}: no tracked posts, skipping`);
      continue;
    }
    console.log(`[tracked-posts-cron] ${a.accountId}: refreshing ${tracked.length} tracked post(s)…`);
    try {
      const r = await refreshAllTrackedPosts(a.accountId);
      const succeeded = r.results.filter(x => x.success).length;
      const failed = r.results.filter(x => !x.success).length;
      console.log(`[tracked-posts-cron] ${a.accountId}: done — ${succeeded} succeeded, ${failed} failed`);
    } catch (err) {
      console.error(`[tracked-posts-cron] ${a.accountId}: fatal — ${err.message}`);
    }
  }
  console.log(`[tracked-posts-cron] === Done at ${new Date().toISOString()} ===`);
}

main().then(() => {
  // Explicit exit: Playwright can leave the event loop alive (lingering browser
  // handles), so without this a cron invocation may hang instead of exiting and
  // successive runs pile up as zombie node processes.
  process.exit(0);
}).catch(err => {
  console.error('[tracked-posts-cron] Top-level error:', err);
  process.exit(1);
});
