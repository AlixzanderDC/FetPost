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
// Wait up to 5 min for one of three things: a UI "Signal Sent" file, OR an auto-detected
// session cookie (set by FetLife when the user finishes manual login in VNC), OR an explicit
// timeout. The cookie-poll is what saves us when the user logs in directly in VNC without
// touching the UI button — without it, the headed browser hangs open after login.
async function waitForUiSignalOrSession(username, context) {
  console.log(`[extractor] Waiting up to 5 minutes for UI signal OR session cookie for ${username}…`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      await fs.access(SIGNAL_FILE);
      await fs.unlink(SIGNAL_FILE);
      console.log(`[extractor] UI signal received for ${username}`);
      return;
    } catch {}
    if (context) {
      try {
        const c = await context.cookies();
        const session = c.find(x =>
          (x.name === '_fl_sessionid' || x.name === '_session_id' || x.name === 'remember_user_token')
          && x.value && x.value.length > 10
          && x.domain.includes('fetlife.com'));
        if (session) {
          // Confirm we're actually past /sign_in on at least one open page so we don't latch
          // onto a half-set cookie mid-redirect.
          const pages = context.pages();
          const stillSigningIn = pages.some(p => {
            try { const u = p.url(); return u.includes('/sign_in') || u.includes('/login'); }
            catch { return false; }
          });
          if (!stillSigningIn) {
            console.log(`[extractor] Auto-detected session cookie for ${username} — closing VNC Chrome`);
            return;
          }
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for login for ${username}`);
}

async function waitForLoginComplete(username, context) {
  if (process.env.FETPOST_CRON === '1') {
    throw new Error(`Cron-mode autofill did not produce a session for ${username} — manual VNC refresh needed`);
  }
  if (process.stdin.isTTY) {
    await waitForEnter(`[extractor] Press ENTER once you are logged in (or Ctrl+C to abort): `);
  } else {
    await waitForUiSignalOrSession(username, context);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.join(__dirname, '..', 'data', 'cookies');
const FL_BASE = 'https://fetlife.com';

const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// Pre-save validation. The recurring failure mode of every cookie refresh path
// is to save the cookies present after a `goto` even when those cookies don't
// represent a logged-in session — Cloudflare-only cookies (`__cfruid` etc.) +
// remember_user_token wiped, no session id. The next post attempt then fails
// with "session expired" 12 hours later, by which point the operator has lost
// the diagnostic context. Refuse to save unless a real session cookie is
// present with a non-trivial value length.
//
// Returns { ok: bool, reason: string } so the caller can decide whether to
// fall back to a different refresh path (headless → headed → manual VNC).
function looksLikeRealSession(flCookies) {
  if (!Array.isArray(flCookies) || flCookies.length === 0) {
    return { ok: false, reason: 'no FetLife cookies at all (browser probably never reached the site)' };
  }
  const sessionNames = ['_fl_sessionid', '_session_id', 'remember_user_token'];
  const session = flCookies.find(c =>
    sessionNames.includes(c.name) && typeof c.value === 'string' && c.value.length >= 16
  );
  if (!session) {
    return {
      ok: false,
      reason: 'no usable session cookie found (need _fl_sessionid / _session_id / remember_user_token ≥16 chars). Cookies present: ' +
        flCookies.map(c => c.name).join(', '),
    };
  }
  return { ok: true, reason: 'session cookie ' + session.name + ' (len=' + session.value.length + ')' };
}

export async function tryHeadlessRefresh(accountId, username) {
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
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
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
    const check = looksLikeRealSession(flCookies);
    if (!check.ok) {
      // Refuse to overwrite the existing file with anonymous cookies. The 12h cron
      // will retry; if the issue is persistent the operator gets surfaced freshness
      // failure rather than silent stale-session-saved-as-fresh.
      console.warn(`[extractor] Headless refresh for ${username} produced anonymous cookies (${check.reason}). NOT saving — falling back.`);
      await browser.close();
      return null;
    }
    await fs.writeFile(savedCookiePath, JSON.stringify(flCookies, null, 2), 'utf8');
    await browser.close();
    console.log(`[extractor] Refreshed ${flCookies.length} cookies for ${username} (headless) — ${check.reason}`);
    return { success: true, accountId, username, cookieCount: flCookies.length };
  } catch {
    await browser.close().catch(() => {});
    return null;
  }
}

async function extractCookiesForAccount(accountId, username, password) {
  if (process.env.FETPOST_FORCE_HEADED === '1') {
    console.log(`[extractor] FETPOST_FORCE_HEADED=1 — skipping headless refresh for ${username}, going straight to VNC login`);
  } else {
    const refreshed = await tryHeadlessRefresh(accountId, username);
    if (refreshed) return refreshed;
  }

  console.log(`[extractor] Launching headed Chrome for manual login: ${username}`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const savedCookiePath = path.join(COOKIES_DIR, accountId + '.json');

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      // Auto-tick the "Remember me, I'll be back." checkbox on FetLife's /sign_in page so
      // every login — autofill or manual — leaves a long-lived remember_user_token cookie.
      // That's what the passive headless refresh later uses to re-establish a session
      // without needing a new manual login. Re-arm on DOM mutations because React can
      // re-render the form and lose the checked state.
      function tickRememberMe() {
        const cb = document.querySelector('input[name="user[remember_me]"]')
                || document.querySelector('input[type="checkbox"][name*="remember" i]')
                || document.querySelector('input[type="checkbox"][id*="remember" i]');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      document.addEventListener('DOMContentLoaded', tickRememberMe);
      try { new MutationObserver(tickRememberMe).observe(document.documentElement, { childList: true, subtree: true }); } catch {}
    });

    const page = await context.newPage();

    await page.goto(`${FL_BASE}/sign_in`, { waitUntil: 'domcontentloaded' });

    // Best-effort autofill — if Cloudflare or a different page is showing, this
    // just throws and we fall through to manual login.
    try {
      await page.fill('input[name="user[login]"]', username, { timeout: 5000 });
      await delay(300, 700);
      await page.fill('input[name="user[password]"]', password, { timeout: 5000 });
      await delay(400, 900);
      // Belt-and-suspenders: also check the Remember-me box explicitly via Playwright
      // (the init-script MutationObserver should have caught it, but checkbox state can
      // be lost across re-renders right before submit).
      try {
        await page.check('input[name="user[remember_me]"]', { timeout: 1500 });
        console.log(`[extractor] Ticked "Remember me" for ${username}`);
      } catch {
        try {
          await page.evaluate(() => {
            const cb = document.querySelector('input[name="user[remember_me]"]')
                    || document.querySelector('input[type="checkbox"][name*="remember" i]');
            if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
          });
        } catch {}
      }
      await page.click('input[type="submit"], button[type="submit"]', { timeout: 5000 });
      console.log(`[extractor] Submitted credentials for ${username}`);
    } catch {
      console.log(`[extractor] Autofill not possible — please log in manually in the Chrome window (Remember-me will be auto-ticked)`);
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
      await waitForLoginComplete(username, context);
    } else {
      console.log(`[extractor] Auto-login succeeded for ${username} — no manual step needed`);
    }

    const cookies = await context.cookies();
    const flCookies = cookies.filter(c => c.domain.includes('fetlife.com'));
    const check = looksLikeRealSession(flCookies);
    if (!check.ok) {
      // Don't clobber a previously-valid file with anonymous cookies. Throw so the
      // operator sees the failure (the cron logs it; the dashboard freshness widget
      // will continue to show the existing file's age + warn the operator).
      await browser.close();
      throw new Error(`Cookie save aborted for ${username}: ${check.reason}. The previous cookie file was preserved. Verify on FetLife that this account can actually log in.`);
    }

    await fs.mkdir(COOKIES_DIR, { recursive: true });
    await fs.writeFile(savedCookiePath, JSON.stringify(flCookies, null, 2), 'utf8');

    console.log(`[extractor] Saved ${flCookies.length} cookies for ${username} — ${check.reason}`);
    await browser.close();
    return { success: true, accountId, username, cookieCount: flCookies.length };
  } catch (err) {
    await browser.close().catch(() => {});
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
    if (sessionCookie && sessionCookie.expires > 0 && sessionCookie.expires < now) {
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

// ── Auto-recovery: in-process headless refresh for "Not logged in" handlers ──
// Coalesces concurrent callers per account (they all await the same in-flight
// promise), then applies a per-outcome cooldown so a burst doesn't hot-loop:
//   - Success: 30s — fresh session in hand, retrying would only burn cycles.
//   - Failure: 5s  — short, so a scan burst (10 venues all hitting expired
//     cookies) doesn't have callers 2-10 silently skip after caller 1 fails.
//     The in-flight coalescing means there's no concurrent-thrash risk.
// Returns true if a fresh session was written, false otherwise. Never throws.
const _autoRefreshInFlight = new Map();
const _autoRefreshCooldown = new Map();
const COOLDOWN_AFTER_SUCCESS_MS = 30 * 1000;
const COOLDOWN_AFTER_FAILURE_MS = 5 * 1000;
export async function autoRefreshCookies(accountId) {
  if (_autoRefreshInFlight.has(accountId)) return _autoRefreshInFlight.get(accountId);
  const cooldownUntil = _autoRefreshCooldown.get(accountId) || 0;
  if (Date.now() < cooldownUntil) return false;
  const p = (async () => {
    let ok = false;
    try {
      const creds = await getCredentials(accountId);
      if (!creds || !creds.username) return false;
      console.log(`[auto-refresh] Trying headless refresh for ${accountId}…`);
      const result = await tryHeadlessRefresh(accountId, creds.username);
      ok = !!(result && result.success);
      if (ok) console.log(`[auto-refresh] Succeeded for ${accountId}`);
      else console.log(`[auto-refresh] Headless refresh did not produce a session for ${accountId} — manual VNC refresh needed`);
      return ok;
    } catch (err) {
      console.warn(`[auto-refresh] Threw for ${accountId}:`, err.message);
      return false;
    } finally {
      _autoRefreshInFlight.delete(accountId);
      _autoRefreshCooldown.set(accountId, Date.now() + (ok ? COOLDOWN_AFTER_SUCCESS_MS : COOLDOWN_AFTER_FAILURE_MS));
    }
  })();
  _autoRefreshInFlight.set(accountId, p);
  return p;
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
