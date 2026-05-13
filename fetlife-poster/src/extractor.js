/**
 * FetLife Cookie Extractor
 * Launches Chrome with each FetLife account, extracts session cookies,
 * and saves them for Playwright to use without needing Chrome open.
 * 
 * Run this script:
 *   - On first setup
 *   - Every 7-14 days to refresh cookies (handled automatically by Task Scheduler)
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { getCredentials, listAccounts } from './credentials.js';

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

const SIGNAL_FILE = '/tmp/fetpost-cookie-signal';
async function waitForUiSignal(username) {
  console.log(`[extractor] Waiting up to 5 minutes for UI "I've logged in" signal for ${username}...`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      await fs.access(SIGNAL_FILE);
      await fs.unlink(SIGNAL_FILE);
      return;
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for UI signal for ${username}`);
}

async function waitForLoginComplete(username) {
  if (process.env.FETPOST_CRON === '1') {
    throw new Error(`Cron-mode autofill did not produce a session for ${username} — manual VNC refresh needed`);
  }
  if (process.stdin.isTTY) {
    await waitForEnter(`[extractor] Press ENTER once you are logged in (or Ctrl+C to abort): `);
  } else {
    await waitForUiSignal(username);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.join(__dirname, '..', 'data', 'cookies');
const FL_BASE = 'https://fetlife.com';

const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

async function tryHeadlessRefresh(accountId, username) {
  const savedCookiePath = path.join(COOKIES_DIR, accountId + '.json');
  let existingCookies;
  try {
    existingCookies = JSON.parse(await fs.readFile(savedCookiePath, 'utf8'));
  } catch {
    return null;
  }
  console.log(`[extractor] Trying headless refresh for ${username}...`);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  try {
    await context.addCookies(existingCookies);
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000, 3000);
    const url = page.url();
    if (url.includes('/sign_in') || url.includes('/login') || url.includes('challenge')) {
      await browser.close();
      return null;
    }
    const cookies = await context.cookies();
    const flCookies = cookies.filter(c => c.domain.includes('fetlife.com'));
    await fs.writeFile(savedCookiePath, JSON.stringify(flCookies, null, 2), 'utf8');
    await browser.close();
    console.log(`[extractor] Refreshed ${flCookies.length} cookies for ${username} (headless)`);
    return { success: true, accountId, username, cookieCount: flCookies.length };
  } catch {
    await browser.close().catch(() => {});
    return null;
  }
}

async function extractCookiesForAccount(accountId, username, password) {
  const refreshed = await tryHeadlessRefresh(accountId, username);
  if (refreshed) return refreshed;

  console.log(`[extractor] Headless refresh failed — launching headed Chrome for manual login: ${username}`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const savedCookiePath = path.join(COOKIES_DIR, accountId + '.json');

  try {
    await page.goto(`${FL_BASE}/sign_in`, { waitUntil: 'domcontentloaded' });

    // Best-effort autofill — if Cloudflare or a different page is showing, this
    // just throws and we fall through to manual login.
    try {
      await page.fill('input[name="user[login]"]', username, { timeout: 5000 });
      await delay(300, 700);
      await page.fill('input[name="user[password]"]', password, { timeout: 5000 });
      await delay(400, 900);
      await page.click('input[type="submit"], button[type="submit"]', { timeout: 5000 });
      console.log(`[extractor] Submitted credentials for ${username}`);
    } catch {
      console.log(`[extractor] Autofill not possible — please log in manually in the Chrome window`);
    }

    // Give the autofill submit ~30s to land a session cookie before we ask for human help.
    console.log(`[extractor] Polling for session cookie after autofill (up to 30s)...`);
    let autoLoggedIn = false;
    const autoDeadline = Date.now() + 30 * 1000;
    while (Date.now() < autoDeadline) {
      try {
        const c = await context.cookies();
        const session = c.find(x => (x.name === '_fl_sessionid' || x.name === '_session_id' || x.name === 'remember_user_token') && x.value && x.value.length > 10 && x.domain.includes('fetlife.com'));
        if (session) {
          let url = '';
          try { url = page.url(); } catch {}
          if (!url.includes('/sign_in') && !url.includes('/login')) { autoLoggedIn = true; break; }
        }
      } catch {}
      await delay(2000, 2000);
    }

    if (!autoLoggedIn) {
      console.log(`\n[extractor] >>> Autofill didn't complete (likely Cloudflare). Log in manually in the Chrome window. <<<`);
      await waitForLoginComplete(username);
    } else {
      console.log(`[extractor] Auto-login succeeded for ${username} — no manual step needed`);
    }

    const cookies = await context.cookies();
    const flCookies = cookies.filter(c => c.domain.includes('fetlife.com'));

    await fs.mkdir(COOKIES_DIR, { recursive: true });
    await fs.writeFile(savedCookiePath, JSON.stringify(flCookies, null, 2), 'utf8');

    console.log(`[extractor] Saved ${flCookies.length} cookies for ${username}`);
    await browser.close();
    return { success: true, accountId, username, cookieCount: flCookies.length };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Headed fallback for Cloudflare challenges
async function extractWithHeadedBrowser(accountId, username, password) {
  console.log(`[extractor] Using headed browser for ${username} (Cloudflare bypass)`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${FL_BASE}/sign_in`, { waitUntil: 'domcontentloaded' });

    // Wait for user to solve Cloudflare if needed (up to 30s)
    await page.waitForURL(url => !url.includes('cloudflare') && !url.includes('challenge'), { timeout: 30000 }).catch(() => {});

    await page.fill('input[name="user[login]"]', username);
    await delay(300, 700);
    await page.fill('input[name="user[password]"]', password);
    await delay(400, 900);
    await page.click('input[type="submit"], button[type="submit"]');
    await delay(3000, 5000);

    if (page.url().includes('/sign_in') || page.url().includes('/login')) {
      throw new Error(`Login failed for ${username}`);
    }

    const cookies = await context.cookies();
    const flCookies = cookies.filter(c => c.domain.includes('fetlife.com'));

    await fs.mkdir(COOKIES_DIR, { recursive: true });
    const cookiePath = path.join(COOKIES_DIR, accountId + '.json');
    await fs.writeFile(cookiePath, JSON.stringify(flCookies, null, 2), 'utf8');

    console.log(`[extractor] Saved ${flCookies.length} cookies for ${username} (headed mode)`);
    await browser.close();
    return { success: true, accountId, username, cookieCount: flCookies.length };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Main: extract cookies for all FetLife accounts ────────────────────────────

export async function extractAllCookies({ accountId = null } = {}) {
  const allAccounts = await listAccounts();
  const accounts = accountId ? allAccounts.filter(a => a.accountId === accountId) : allAccounts;
  if (accountId && accounts.length === 0) {
    return [{ success: false, accountId, error: `Account "${accountId}" not found` }];
  }
  const results = [];

  for (const account of accounts) {
    try {
      const creds = await getCredentials(account.accountId);
      const result = await extractCookiesForAccount(account.accountId, creds.username, creds.password);
      results.push(result);
    } catch (err) {
      console.error(`[extractor] Failed for ${account.accountId}:`, err.message);
      results.push({ success: false, accountId: account.accountId, error: err.message });
    }
  }

  return results;
}

export async function getCookiesForAccount(accountId) {
  const cookiePath = path.join(COOKIES_DIR, accountId + '.json');
  try {
    const raw = await fs.readFile(cookiePath, 'utf8');
    const cookies = JSON.parse(raw);

    // Check if cookies are expired
    const now = Date.now() / 1000;
    const sessionCookie = cookies.find(c => c.name === '_fl_sessionid' || c.name === '_session_id' || c.name === 'remember_user_token');
    if (sessionCookie && sessionCookie.expires && sessionCookie.expires < now) {
      console.log(`[extractor] Cookies expired for ${accountId}, need refresh`);
      return null;
    }

    return cookies;
  } catch {
    return null;
  }
}

export async function cookiesExistForAccount(accountId) {
  const cookiePath = path.join(COOKIES_DIR, accountId + '.json');
  try {
    await fs.access(cookiePath);
    return true;
  } catch {
    return false;
  }
}

// Run directly if called as a script
if (process.argv[1] && process.argv[1].includes('extractor')) {
  console.log('[extractor] Starting cookie extraction for all accounts...');
  extractAllCookies().then(results => {
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`[extractor] Done: ${succeeded} succeeded, ${failed} failed`);
    if (failed > 0) {
      results.filter(r => !r.success).forEach(r => console.error(`  - ${r.accountId}: ${r.error}`));
    }
    process.exit(0);
  }).catch(err => {
    console.error('[extractor] Fatal error:', err.message);
    process.exit(1);
  });
}
