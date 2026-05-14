/**
 * FetLife browser automation via Playwright
 * Uses saved cookies for each account — no Chrome Debug window needed.
 * Supports text posts and image posts via the status composer.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { getCookiesForAccount, extractAllCookies } from './extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
const FL_BASE = 'https://fetlife.com';

const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

async function humanType(page, selector, text) {
  await page.click(selector);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.value = ''; el.dispatchEvent(new Event('input')); }
  }, selector);
  await page.fill(selector, '');
  for (const char of text) {
    await page.type(selector, char, { delay: 40 + Math.random() * 80 });
  }
}

export async function launchWithCookies(accountId, options = {}) {
  const { headless = true } = options;
  let cookies = await getCookiesForAccount(accountId);

  if (!cookies) {
    console.log(`[poster] No valid cookies for ${accountId}, running extractor...`);
    await extractAllCookies();
    cookies = await getCookiesForAccount(accountId);
    if (!cookies) {
      throw new Error(`Could not get cookies for ${accountId} — run the cookie extractor first`);
    }
  }

  const browser = await chromium.launch({
    headless,
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

  await context.addCookies(cookies);
  return { browser, context };
}

async function checkLoggedIn(page) {
  if (page.url().includes('/login') || page.url().includes('/sign_in')) {
    throw new Error('Not logged in — cookies may have expired. Run cookie extraction again.');
  }
}

async function base64ToTempFile(base64Data, mimeType, index) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('gif') ? 'gif' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const tmpPath = path.join(os.tmpdir(), `nexuspost-img-${Date.now()}-${index}.${ext}`);
  await fs.writeFile(tmpPath, Buffer.from(base64Data, 'base64'));
  return tmpPath;
}

async function cleanupTempFiles(paths) {
  for (const p of paths) {
    try { await fs.unlink(p); } catch {}
  }
}

async function findStatusBox(page) {
  const statusSelectors = [
    'textarea[name="body"]',
    'textarea[placeholder*="kinky"]',
    'textarea[placeholder*="what"]',
    'textarea[placeholder*="share"]',
    'textarea[placeholder*="mind"]',
    'textarea[name="status"]',
    'textarea',
  ];

  for (const sel of statusSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      return sel;
    } catch {}
  }
  return null;
}

async function clickSubmit(page) {
  const submitSelectors = [
    'button:has-text("Say It!")',
    'button:has-text("Say it!")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Post")',
    'button:has-text("Share")',
  ];

  for (const sel of submitSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      return true;
    } catch {}
  }
  return false;
}

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'post-screenshots');

// Verify a /home composer submit actually landed the post. We can't trust the
// textarea-cleared signal alone — FetLife clears the form on silent rejections
// too (rate-limit, duplicate, shadow-block). So we also save a screenshot for
// inspection and look for the caption in the resulting feed before declaring success.
async function verifyHomePostSubmitted(page, statusBoxSelector, originalCaption, label) {
  await new Promise(r => setTimeout(r, 4000));

  // Always save a screenshot — successful or not, useful for diagnosis.
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = (label || 'post').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${safeLabel}-${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  console.log(`[poster] Screenshot saved: ${screenshotPath}`);

  // Look for an explicit FetLife error banner first
  let errMsg = '';
  try {
    errMsg = await page.$eval(
      '.error:not(:empty), .alert-danger, .form-error, .field_with_errors, .has-error, [role="alert"]:not(.alert-success)',
      el => (el.innerText || el.textContent || '').trim()
    ).catch(() => '');
  } catch {}
  if (errMsg) {
    throw new Error(`FetLife rejected post: "${errMsg.slice(0, 200)}" (screenshot: ${screenshotPath})`);
  }

  // If the URL navigated away from /home (e.g. /pictures/123, /users/.../posts/...)
  // and isn't an auth error, treat as success.
  const url = page.url();
  if (!url.includes('/sign_in') && !url.includes('challenge') && !/\/home\/?$/.test(url)) {
    return true;
  }

  // Still on /home — try to find our caption in the visible feed text.
  const captionFragment = (originalCaption || '').trim().slice(0, 60);
  if (captionFragment) {
    try {
      const found = await page.evaluate((frag) => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes(frag.toLowerCase());
      }, captionFragment);
      if (found) return true;
    } catch {}
    throw new Error(`Post not visible in /home feed after submit — likely silent rejection (screenshot: ${screenshotPath})`);
  }

  // No caption (e.g. picture-only post) and URL didn't change — best-effort: check
  // the composer textarea cleared.
  const current = await page.$eval(statusBoxSelector, el => (el.value || '').trim()).catch(() => null);
  if (current === null || current === '') return true;
  throw new Error(`Composer still populated after submit — post did not go through (screenshot: ${screenshotPath})`);
}

// ── Login test ────────────────────────────────────────────────────────────────

export async function loginToFetLife(username, password, options = {}) {
  const { testOnly = false, accountId } = options;
  if (!accountId) return { success: false, error: 'accountId required for cookie-based login' };

  try {
    const { browser, context } = await launchWithCookies(accountId);
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await delay(800, 1500);

    const loggedIn = !page.url().includes('/login') && !page.url().includes('/sign_in');
    await browser.close();

    if (loggedIn) return { success: true, method: 'cookie' };
    return { success: false, error: 'Cookies invalid or expired — run extractor' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Post status (text only) ───────────────────────────────────────────────────

export async function postStatus(username, password, content, accountId) {
  console.log(`[poster] Posting status for ${accountId || username}`);
  const id = accountId || username;
  const { browser, context } = await launchWithCookies(id);

  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await delay(800, 1500);
    await checkLoggedIn(page);

    const statusBox = await findStatusBox(page);
    if (!statusBox) throw new Error('Could not find status input');

    await humanType(page, statusBox, content);
    await delay(600, 1200);

    const submitted = await clickSubmit(page);
    if (!submitted) throw new Error('Could not find submit button');

    await verifyHomePostSubmitted(page, statusBox, content, `status-${id}`);
    await browser.close();
    console.log(`[poster] Status posted for ${id}`);
    return { success: true };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Post picture with caption via status composer ─────────────────────────────

export async function postPicture(username, password, caption, images, accountId) {
  console.log(`[poster] Posting picture for ${accountId || username} (${images.length} image(s))`);
  const id = accountId || username;
  const { browser, context } = await launchWithCookies(id);
  const tempFiles = [];

  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await delay(1000, 2000);
    await checkLoggedIn(page);

    // Step 1: Click the status box to activate the composer
    const statusBox = await findStatusBox(page);
    if (!statusBox) throw new Error('Could not find status box');

    await page.click(statusBox);
    await page.focus(statusBox);
    await page.keyboard.press('Space');
    await page.keyboard.press('Backspace');
    await delay(2000, 3000);

    // Step 2: Find Add Pictures button
    const addPicsButton = await page.$('button:has-text("Add Pictures"), button:has-text("Add Pics")');
    if (!addPicsButton) throw new Error('Could not find Add Pictures button — try clicking the status box first');

    // Step 3: Save image to temp file and upload via file chooser
    const tmpPath = await base64ToTempFile(images[0].data, images[0].mimeType || 'image/jpeg', 0);
    tempFiles.push(tmpPath);

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      addPicsButton.click(),
    ]);
    await fileChooser.setFiles(tmpPath);
    console.log(`[poster] Image uploaded for ${id}`);
    await delay(2000, 4000);

    // Step 4: Check 18+ verification checkbox
    const ageCheckSelectors = [
      'input[name="status[is_certified]"]',
      'input[type="checkbox"][name*="certified"]',
      'input[type="checkbox"][name*="age"]',
      'input[type="checkbox"][name*="adult"]',
      'input[type="checkbox"][name*="18"]',
      'input[type="checkbox"][name*="consent"]',
    ];
    for (const sel of ageCheckSelectors) {
      try {
        const checkbox = await page.$(sel);
        if (checkbox) {
          const checked = await checkbox.isChecked();
          if (!checked) {
            await checkbox.check();
            console.log('[poster] Checked 18+ verification checkbox');
          }
          break;
        }
      } catch {}
    }

    // Step 5: Type caption
    if (caption) {
      await humanType(page, statusBox, caption);
      await delay(400, 800);
    }

    await delay(500, 1000);

    // Step 6: Submit
    const submitted = await clickSubmit(page);
    if (!submitted) throw new Error('Could not find submit button');

    await verifyHomePostSubmitted(page, statusBox, caption || '', `picture-${id}`);
    await browser.close();
    await cleanupTempFiles(tempFiles);
    console.log(`[poster] Picture posted for ${id}`);
    return { success: true };
  } catch (err) {
    await browser.close();
    await cleanupTempFiles(tempFiles);
    throw err;
  }
}

// ── Post event ────────────────────────────────────────────────────────────────

export async function postEvent(username, password, eventDetails, accountId) {
  const { title, description, startDate, location, isPrivate = false } = eventDetails;
  const id = accountId || username;
  console.log(`[poster] Creating event "${title}" for ${id}`);
  const { browser, context } = await launchWithCookies(id);

  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/events/new`, { waitUntil: 'domcontentloaded' });
    await delay(800, 1500);
    await checkLoggedIn(page);

    await humanType(page, 'input[name="event[name]"], input[id*="event_name"]', title);
    await delay(300, 600);
    await humanType(page, 'textarea[name="event[description]"], textarea[id*="event_description"]', description);
    await delay(300, 600);

    if (location) {
      try {
        await humanType(page, 'input[name="event[location]"], input[id*="event_location"]', location);
        await delay(200, 500);
      } catch {}
    }

    if (startDate) {
      try {
        const d = new Date(startDate);
        await page.fill('input[name*="start_date"], input[id*="start_date"]', `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`);
        await delay(200, 400);
        await page.fill('input[name*="start_time"], input[id*="start_time"]', `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`);
      } catch { console.warn('[poster] Could not set start date/time'); }
    }

    if (isPrivate) {
      try { await page.check('input[value="private"], input[id*="private"]'); } catch {}
    }

    await delay(600, 1200);
    await page.click('input[type="submit"][value*="Create"], button[type="submit"]');
    await delay(3000, 5000);

    const finalUrl = page.url();
    const success = finalUrl.includes('/events/') && !finalUrl.includes('/new');
    await browser.close();

    if (success) return { success: true, url: finalUrl };
    throw new Error(`Event creation may have failed. URL: ${finalUrl}`);
  } catch (err) {
    await browser.close();
    throw err;
  }
}

export async function invalidateSession(accountId) {
  try {
    const p = path.join(__dirname, '..', 'data', 'cookies', accountId + '.json');
    await fs.unlink(p);
  } catch {}
}

// ── Group post (cross-post an event into a FetLife group) ─────────────────────

async function findFirstSelector(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try { await page.waitForSelector(sel, { timeout, state: 'attached' }); return sel; } catch {}
  }
  return null;
}

export async function waitOutCloudflare(page, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const title = await page.title().catch(() => '');
    if (!/just a moment|verifying/i.test(title) && !page.url().includes('__cf_chl')) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

export async function postToGroup(accountId, { groupId, title, body, dryRun = false }) {
  if (!accountId) throw new Error('accountId required');
  if (!groupId) throw new Error('groupId required');
  if (!title) throw new Error('title required');
  if (!body) throw new Error('body required');

  console.log(`[poster] postToGroup ${accountId} → group ${groupId}` + (dryRun ? ' (DRY RUN)' : ''));
  // Group routes need non-headless to pass Cloudflare reliably.
  const { browser, context } = await launchWithCookies(accountId, { headless: false });

  try {
    const page = await context.newPage();

    // Warm Cloudflare on /home first.
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await delay(1500, 2500);
    await checkLoggedIn(page);

    // Open the new-discussion form directly.
    await page.goto(`${FL_BASE}/groups/${groupId}/posts/new`, { waitUntil: 'domcontentloaded' });
    const cleared = await waitOutCloudflare(page, 30000);
    if (!cleared) throw new Error('Cloudflare challenge did not clear within 30s');

    // Title input.
    const titleSel = await findFirstSelector(page, [
      'input[name="group_post[title]"]',
      'input[placeholder="Title"]',
    ], 8000);
    if (!titleSel) throw new Error('Could not find title input on new-discussion form');
    await page.click(titleSel);
    await page.fill(titleSel, '');
    await page.type(titleSel, title, { delay: 30 });

    // Body editor (TipTap / ProseMirror — contenteditable, no name attribute).
    const bodySel = await findFirstSelector(page, [
      'div.tiptap.ProseMirror[contenteditable="true"]',
      'div.tiptap[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"]',
    ], 5000);
    if (!bodySel) throw new Error('Could not find body editor on new-discussion form');
    await page.click(bodySel);
    // Preserve paragraph breaks: split on any run of newlines, type each chunk, press Enter
    // between them. TipTap (default) interprets Enter as a new paragraph, which gives proper
    // vertical spacing for descriptions structured with section headers like "✦ ... ✦".
    const paragraphs = body.split(/\n+/).filter(p => p.length > 0);
    for (let i = 0; i < paragraphs.length; i++) {
      if (i > 0) await page.keyboard.press('Enter');
      await page.keyboard.type(paragraphs[i], { delay: 15 });
    }
    await delay(400, 800);

    if (dryRun) {
      const screenshotPath = path.join(__dirname, '..', 'data', 'recon-out', `dryrun-group-${groupId}-${Date.now()}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await browser.close();
      console.log(`[poster] DRY RUN complete — form filled, not submitted. Screenshot: ${screenshotPath}`);
      return { success: true, dryRun: true, screenshot: screenshotPath };
    }

    // Submit.
    const submitSel = await findFirstSelector(page, [
      'button[type="submit"]:has-text("Start New Discussion")',
      'button:has-text("Start New Discussion")',
      'button:has-text("Post")',
      'button[type="submit"]',
    ], 5000);
    if (!submitSel) throw new Error('Could not find submit button');

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
      page.click(submitSel),
    ]);
    await delay(2000, 3000);
    await waitOutCloudflare(page, 20000);

    const finalUrl = page.url();
    const success = /\/groups\/\d+\/(group_posts|posts)\/\d+/.test(finalUrl)
      && !finalUrl.includes('/new');

    await browser.close();
    if (success) return { success: true, url: finalUrl };
    throw new Error(`Submit did not land on a post URL. Final URL: ${finalUrl}`);
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}
