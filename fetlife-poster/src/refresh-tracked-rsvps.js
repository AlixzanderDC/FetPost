/**
 * Cron entry point: iterate every account, refresh RSVPs for all of its tracked events.
 * Long-running — expect this to take many minutes for accounts with lots of tracked events
 * (each event is a separate Playwright browser launch + 25–55s stagger between events).
 *
 * Run manually:
 *   node --env-file=../.env src/refresh-tracked-rsvps.js
 * Or scheduled via cron, e.g.:
 *   0 5 * * * cd /root/fetpost/fetlife-poster && /usr/bin/node --env-file=/root/fetpost/.env src/refresh-tracked-rsvps.js >> /root/fetpost/.logs/tracked-rsvps.log 2>&1
 */

import { listAccounts } from './credentials.js';
import { refreshAllTrackedRsvps, listTrackedEvents } from './tracked-events.js';

async function main() {
  console.log(`[tracked-cron] === Starting tracked RSVPs refresh at ${new Date().toISOString()} ===`);
  const accounts = await listAccounts();
  for (const a of accounts) {
    const tracked = await listTrackedEvents(a.accountId);
    if (tracked.length === 0) {
      console.log(`[tracked-cron] ${a.accountId}: no tracked events, skipping`);
      continue;
    }
    console.log(`[tracked-cron] ${a.accountId}: refreshing ${tracked.length} tracked event(s)…`);
    try {
      const r = await refreshAllTrackedRsvps(a.accountId);
      const succeeded = r.results.filter(x => x.success).length;
      const failed = r.results.filter(x => !x.success).length;
      console.log(`[tracked-cron] ${a.accountId}: done — ${succeeded} succeeded, ${failed} failed`);
    } catch (err) {
      console.error(`[tracked-cron] ${a.accountId}: fatal — ${err.message}`);
    }
  }
  console.log(`[tracked-cron] === Done at ${new Date().toISOString()} ===`);
}

main().then(() => {
  // Explicit exit: Playwright can leave the event loop alive (lingering browser
  // handles), so without this a cron invocation may hang instead of exiting and
  // successive runs pile up as zombie node processes.
  process.exit(0);
}).catch(err => {
  console.error('[tracked-cron] Top-level error:', err);
  process.exit(1);
});
