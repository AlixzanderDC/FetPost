/**
 * refresh-cookies.js
 * Run this script every 7 days via Task Scheduler to keep FetLife cookies fresh.
 * Called automatically — no human input needed.
 */

import { extractAllCookies } from './extractor.js';

console.log('[refresh] Starting scheduled cookie refresh...');
console.log('[refresh] Time:', new Date().toISOString());

extractAllCookies()
  .then(results => {
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`[refresh] Complete: ${succeeded} succeeded, ${failed} failed`);
    if (failed > 0) {
      results.filter(r => !r.success).forEach(r => {
        console.error(`[refresh] FAILED ${r.accountId}: ${r.error}`);
      });
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error('[refresh] Fatal error:', err.message);
    process.exit(1);
  });
