/**
 * setup-cookies.js
 * Run this once to:
 * 1. Extract cookies for all FetLife accounts
 * 2. On Windows only: register a Task Scheduler entry to refresh cookies weekly.
 *    (On the Linux droplet, cron drives refresh — this step is skipped there.)
 * 
 * Usage: node src/setup-cookies.js
 */

import { extractAllCookies } from './extractor.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.join(__dirname, '..');
const NODE_PATH = process.execPath;
const REFRESH_SCRIPT = path.join(__dirname, 'refresh-cookies.js');

// Returns true only if it actually registered an OS-level schedule. On non-Windows
// hosts (the production droplet is Linux) there's no Task Scheduler — refresh is
// driven by cron there — so we skip rather than run powershell and swallow the error.
async function createScheduledTask() {
  if (process.platform !== 'win32') {
    console.log('[setup] Not on Windows — skipping Task Scheduler registration.');
    console.log('[setup] On the Linux droplet the 12h cron job drives cookie refresh; there is nothing to register here.');
    console.log('[setup] To refresh manually: node src/refresh-cookies.js');
    return false;
  }

  // Windows Task Scheduler keys this by name. Existing installs that already
  // registered the task as "NexusPost Cookie Refresh" should run this once
  // more — Register-ScheduledTask with -Force replaces the existing entry.
  // The old name is left behind only if you uninstall before re-running.
  const taskName = 'FetPost Cookie Refresh';

  // PowerShell command to create weekly task
  const ps = `
$action = New-ScheduledTaskAction -Execute "${NODE_PATH}" -Argument "${REFRESH_SCRIPT}" -WorkingDirectory "${PROJECT_DIR}"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "3:00AM"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "${taskName}" -Action $action -Trigger $trigger -Settings $settings -Force
  `.trim();

  try {
    await execAsync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`);
    console.log('[setup] Weekly cookie refresh task created in Task Scheduler');
    console.log('[setup] Runs every Monday at 3:00 AM');
    return true;
  } catch (err) {
    console.warn('[setup] Could not create Task Scheduler entry automatically.');
    console.warn('[setup] You can run it manually with: node src/refresh-cookies.js');
    console.warn('[setup] Error:', err.message);
    return false;
  }
}

async function main() {
  // Filter to a single account if specified — first via CLI arg, else via env var.
  const onlyAccount = process.argv[2] || process.env.FL_ONLY_ACCOUNT;
  console.log('[setup] === FetPost FetLife Cookie Setup ===');
  if (onlyAccount) {
    console.log(`[setup] Targeting single account: ${onlyAccount}\n`);
  } else {
    console.log('[setup] Step 1: Extracting cookies for all accounts...\n');
  }

  const results = await extractAllCookies({ accountId: onlyAccount || null });

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log('\n[setup] Cookie extraction results:');
  succeeded.forEach(r => console.log(`  ✓ ${r.accountId} (${r.username}) — ${r.cookieCount} cookies saved`));
  failed.forEach(r => console.log(`  ✗ ${r.accountId} — ${r.error}`));

  if (succeeded.length === 0) {
    console.error('\n[setup] No cookies extracted — check credentials and try again');
    process.exit(1);
  }

  console.log('\n[setup] Step 2: Creating automatic refresh schedule...');
  const scheduled = await createScheduledTask();

  console.log('\n[setup] === Setup Complete ===');
  console.log(`[setup] ${succeeded.length} account(s) ready for headless posting`);
  if (scheduled) {
    console.log('[setup] Cookies will auto-refresh every Monday at 3:00 AM (Task Scheduler)');
  } else {
    console.log('[setup] No OS scheduler was registered on this host — cookie refresh runs via cron on the droplet.');
  }
  console.log('[setup] You can now stop using the Chrome Debug window!');
}

main().catch(err => {
  console.error('[setup] Fatal error:', err.message);
  process.exit(1);
});
