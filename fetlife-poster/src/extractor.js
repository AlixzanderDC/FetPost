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
import { fileURLToPath } from 'url';
import { getCredentials, listAccounts } from './credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.join(__dirname, '..', 'data', 'cookies');
const FL_BASE = 'https://fetlife.com';

const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

async function extractCookiesForAccount(accountId, username, password) {
  console.log(`[extractor] Extracting cookies for ${username}...`);

  const browser = await chromium.launch({
    headless: true,
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

  try {
    // Check if we have saved cookies that still work
    const savedCookiePath = path.join(COOKIES_DIR, accountId + '.json');
    let cookiesValid = false;

    try {
      const savedCookies = JSON.parse(await fs.readFile(savedCookiePath, 'utf8'));
      await context.addCookies(savedCookies);
      await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
      await delay(1000, 2000);

      if (!page.url().includes('/login') && !page.url().includes('/sign_in')) {
        console.log(`[extractor] Existing cookies still valid for ${username}`);
        cookiesValid = true;
      } else {
        console.log(`[extractor] Saved cookies expired for ${username}, logging in fresh`);
        await context.clearCookies();
      }
    } catch {
      console.log(`[extractor] No saved cookies found for ${username}, logging in fresh`);
    }

    if (!cookiesValid) {
      // Fresh login
      await page.goto(`${FL_BASE}/sign_in`, { waitUntil: 'domcontentloaded' });
      await delay(1000, 2000);

      // Handle Cloudflare if present
      const url = page.url();
      if (url.includes('cloudflare') || url.includes('challenge')) {
        console.log(`[extractor] Cloudflare challenge detected for ${username} — switching to headed mode`);
        await browser.close();
        return await extractWithHeadedBrowser(accountId, username, password);
      }

      await page.fill('input[name="user[login]"]', username);
      await delay(300, 700);
      await page.fill('input[name="user[password]"]', password);
      await delay(400, 900);
      await page.click('input[type="submit"], button[type="submit"]');
      await delay(3000, 5000);

    if (page.url().includes('/sign_in') || page.url().includes('/login')) {
  // Try navigating to home directly after login
  await page.goto('https://fetlife.com/home', { waitUntil: 'domcontentloaded' });
  await delay(2000, 3000);
  if (page.url().includes('/sign_in') || page.url().includes('/login')) {
    throw new Error(`Login failed for ${username}`);
  }
}

      console.log(`[extractor] Login successful for ${username}`);
    }

    // Extract and save cookies
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

export async function extractAllCookies() {
  const accounts = await listAccounts();
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
    const sessionCookie = cookies.find(c => c.name === '_session_id' || c.name === 'remember_user_token');
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
