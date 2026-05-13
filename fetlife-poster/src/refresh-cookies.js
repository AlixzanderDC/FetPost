/**
 * refresh-cookies.js
 * Cron entry point for keeping FetLife cookies fresh.
 * Set FETPOST_CRON=1 + DISPLAY=:1 + XAUTHORITY=/root/.Xauthority in the cron env so
 * the autofill-only headed fallback can run on the VNC X server without hanging on
 * the manual UI-signal flow.
 *
 * Writes data/cookies/_refresh-status.json so the UI can surface failures
 * (e.g. Cloudflare blocked the auto-login and a human VNC refresh is needed).
 */

import { extractAllCookies } from './extractor.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(__dirname, '..', 'data', 'cookies', '_refresh-status.json');

console.log('[refresh] Starting scheduled cookie refresh...');
console.log('[refresh] Time:', new Date().toISOString());
console.log('[refresh] FETPOST_CRON=' + (process.env.FETPOST_CRON || '0') + ' DISPLAY=' + (process.env.DISPLAY || '(unset)'));

extractAllCookies()
  .then(async results => {
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`[refresh] Complete: ${succeeded} succeeded, ${failed} failed`);
    results.filter(r => !r.success).forEach(r => {
      console.error(`[refresh] FAILED ${r.accountId}: ${r.error}`);
    });
    try {
      await fs.writeFile(STATUS_FILE, JSON.stringify({
        ranAt: new Date().toISOString(),
        succeeded,
        failed,
        results: results.map(r => ({
          accountId: r.accountId,
          success: !!r.success,
          error: r.error || null,
        })),
      }, null, 2));
    } catch (err) {
      console.error('[refresh] Could not write status file:', err.message);
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async err => {
    console.error('[refresh] Fatal error:', err.message);
    try {
      await fs.writeFile(STATUS_FILE, JSON.stringify({
        ranAt: new Date().toISOString(),
        fatal: err.message,
      }, null, 2));
    } catch {}
    process.exit(1);
  });
