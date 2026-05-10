/**
 * setup-cookies.js
 * Run this once to:
 * 1. Extract cookies for all FetLife accounts
 * 2. Create a Windows Task Scheduler entry to refresh cookies every 7 days
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

async function createScheduledTask() {
  const taskName = 'NexusPost Cookie Refresh';

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
  } catch (err) {
    console.warn('[setup] Could not create Task Scheduler entry automatically.');
    console.warn('[setup] You can run it manually with: node src/refresh-cookies.js');
    console.warn('[setup] Error:', err.message);
  }
}

async function main() {
  console.log('[setup] === NexusPost FetLife Cookie Setup ===');
  console.log('[setup] Step 1: Extracting cookies for all accounts...\n');

  const results = await extractAllCookies();

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
  await createScheduledTask();

  console.log('\n[setup] === Setup Complete ===');
  console.log(`[setup] ${succeeded.length} account(s) ready for headless posting`);
  console.log('[setup] Cookies will auto-refresh every Monday at 3:00 AM');
  console.log('[setup] You can now stop using the Chrome Debug window!');
}

main().catch(err => {
  console.error('[setup] Fatal error:', err.message);
  process.exit(1);
});
