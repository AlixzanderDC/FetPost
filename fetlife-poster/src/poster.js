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

  // Context setup can throw (bad cookie shape, addInitScript failure). If it does
  // after the browser is launched, close the browser before rethrowing — otherwise
  // a Chrome process leaks on every failed launch.
  try {
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
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

export async function checkLoggedIn(page) {
  if (page.url().includes('/login') || page.url().includes('/sign_in')) {
    throw new Error('Not logged in — cookies may have expired. Run cookie extraction again.');
  }
  // URL-only checks miss the case where FetLife serves the login form at the originally
  // requested URL (no redirect) when cookies are stale. Inspect page content for the
  // login-page tells so we surface a clear session-expired error instead of a misleading
  // downstream "selector not found" / "redirected to group page" message.
  const looksLikeLogin = await page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    const body = (document.body?.innerText || '').slice(0, 600).toLowerCase();
    const hasLoginForm = !!(document.querySelector('input[type="password"]')
      && (document.querySelector('input[type="email"]') || document.querySelector('input[name*="login" i]') || document.querySelector('input[name*="email" i]')));
    return hasLoginForm
      || /welcome back, we['’]ve missed you/.test(body)
      || /^login \| fetlife$/.test(title);
  }).catch(() => false);
  if (looksLikeLogin) {
    throw new Error('FetLife session expired — landed on the login form. Run cookie extraction again (the freshness widget on the dashboard will surface this; the 12h cron normally handles it, check VPN/NordVPN if it keeps recurring).');
  }
}

async function base64ToTempFile(base64Data, mimeType, index) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('gif') ? 'gif' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const tmpPath = path.join(os.tmpdir(), `fetpost-img-${Date.now()}-${index}.${ext}`);
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

  // Look for an explicit FetLife error banner first. Filter to VISIBLE elements —
  // FetLife ships hidden error/alert templates in the DOM that a plain selector
  // match would treat as a real rejection (false failure → the scheduler retries a
  // post that actually landed → duplicate).
  let errMsg = '';
  try {
    errMsg = await page.$$eval(
      '.error, .alert-danger, .form-error, .field_with_errors, .has-error, [role="alert"]:not(.alert-success)',
      els => {
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // hidden template, not a live banner
          const t = (el.innerText || el.textContent || '').trim();
          if (t) return t;
        }
        return '';
      }
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

  // Still on /home — look for our caption in the feed. The feed renders async, so
  // poll rather than checking once; normalize whitespace on both sides so wrapping
  // differences don't cause a false miss.
  const norm = s => (s || '').replace(/\s+/g, ' ').toLowerCase().trim();
  const captionFragment = (originalCaption || '').trim().slice(0, 60);
  if (captionFragment) {
    const needle = norm(captionFragment);
    for (let attempt = 0; attempt < 9; attempt++) {
      try {
        const found = await page.evaluate((n) => {
          const text = (document.body.innerText || '').replace(/\s+/g, ' ').toLowerCase();
          return text.includes(n);
        }, needle);
        if (found) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    // Feed never showed the caption. Before declaring a silent rejection, fall back
    // to the composer-cleared signal — a cleared textarea is strong evidence the
    // submit went through even when feed rendering lags.
    const cleared = await page.$eval(statusBoxSelector, el => (el.value || '').trim()).catch(() => null);
    if (cleared === null || cleared === '') return true;
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

  let browser;
  try {
    let context;
    ({ browser, context } = await launchWithCookies(accountId));
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await delay(800, 1500);

    // checkLoggedIn also catches the case where FetLife serves the login form at the
    // requested URL without redirecting — a plain URL check would call that a success.
    await checkLoggedIn(page);
    return { success: true, method: 'cookie' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await browser?.close().catch(() => {});
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
    await browser.close().catch(() => {});
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

    // Step 3: Save first image to temp file and upload via file chooser
    const tmpPath = await base64ToTempFile(images[0].data, images[0].mimeType || 'image/jpeg', 0);
    tempFiles.push(tmpPath);

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      addPicsButton.click(),
    ]);
    await fileChooser.setFiles(tmpPath);
    console.log(`[poster] Image 1/${images.length} uploaded for ${id}`);
    await delay(2000, 4000);

    // Step 3b: For each additional image, click the in-composer "add more" tile (CSS
    // signature includes `@container/add-more`) and feed the next file via filechooser.
    // FetLife re-renders the tile after each upload, so we re-query it every iteration.
    for (let i = 1; i < images.length; i++) {
      const nextPath = await base64ToTempFile(images[i].data, images[i].mimeType || 'image/jpeg', i);
      tempFiles.push(nextPath);
      const addMore = await page.waitForSelector('[class*="container/add-more"]', { timeout: 10000 });
      const [nextChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        addMore.click(),
      ]);
      await nextChooser.setFiles(nextPath);
      console.log(`[poster] Image ${i + 1}/${images.length} uploaded for ${id}`);
      await delay(1500, 2500);
    }

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

    // Step 5b: Wait for FetLife's "Uploading..." indicator to clear before submit.
    // Submitting mid-upload races: FetLife accepts the click but silently drops the
    // post because the image record isn't finalized yet. Wait up to 90s.
    try {
      await page.waitForFunction(
        () => !/Uploading/.test(document.body.innerText || ''),
        { timeout: 90000, polling: 500 }
      );
      console.log(`[poster] Image upload finalized for ${id}`);
    } catch {
      console.warn(`[poster] "Uploading..." indicator still present after 90s — submitting anyway`);
    }
    await delay(400, 700);

    // Step 6: Submit
    const submitted = await clickSubmit(page);
    if (!submitted) throw new Error('Could not find submit button');

    await verifyHomePostSubmitted(page, statusBox, caption || '', `picture-${id}`);
    await browser.close();
    await cleanupTempFiles(tempFiles);
    console.log(`[poster] Picture posted for ${id}`);
    return { success: true };
  } catch (err) {
    await browser.close().catch(() => {});
    await cleanupTempFiles(tempFiles);
    throw err;
  }
}

// ── Post picture to /pictures/new (Pictures gallery, NOT the timeline) ──────
//
// Different from postPicture above: that one opens the home status composer and
// attaches images to a timeline post. THIS one goes to https://fetlife.com/pictures/new,
// uploads the image to the user's Pictures gallery, fills the Caption field, ticks the
// 18+ consent checkbox, and clicks "Upload Your Picture". Used for drip campaigns
// where the operator wants the post to land in the user's gallery (not the feed).
//
// The caption field on this page does NOT enforce the 369-char timeline cap.

export async function postPictureToGallery(username, password, caption, images, accountId) {
  console.log(`[poster] Uploading ${images.length} image(s) to /pictures/new for ${accountId || username}`);
  const id = accountId || username;
  const { browser, context } = await launchWithCookies(id);
  const tempFiles = [];

  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/pictures/new`, { waitUntil: 'domcontentloaded' });
    await delay(1500, 2500);
    await checkLoggedIn(page);

    // Step 1: Upload the first image. The /pictures/new page opens a file chooser
    // when any of the upload UI is clicked (the drop area, the "+" tile, the "Add"
    // button, or a hidden <input type=file>). Trigger a chooser and feed the file.
    const tmpPath0 = await base64ToTempFile(images[0].data, images[0].mimeType || 'image/jpeg', 0);
    tempFiles.push(tmpPath0);

    // Prefer the bare <input type=file> if present (most reliable across rerenders).
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(tmpPath0);
    } else {
      // Fallback: click any "Add" / "+" affordance to open a chooser.
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        page.click('button:has-text("Add"), [class*="add"][role="button"], label:has-text("Pictures")'),
      ]);
      await chooser.setFiles(tmpPath0);
    }
    console.log(`[poster] Picture 1/${images.length} uploaded to gallery for ${id}`);
    await delay(2000, 3500);

    // Step 1b: any additional images go through the "Add More" tile.
    for (let i = 1; i < images.length; i++) {
      const tmpPath = await base64ToTempFile(images[i].data, images[i].mimeType || 'image/jpeg', i);
      tempFiles.push(tmpPath);
      // FetLife renders an "Add More" tile after the first upload — same chooser
      // pattern as postPicture's add-more loop above.
      const addMore = await page.waitForSelector('button:has-text("Add More"), [aria-label*="Add"], [class*="add-more"]', { timeout: 10000 }).catch(() => null);
      if (!addMore) {
        // Fall back to the original file input if the tile isn't found.
        const inp = await page.$('input[type="file"]');
        if (inp) { await inp.setInputFiles(tmpPath); }
        else throw new Error('Could not find "Add More" tile for additional images');
      } else {
        const [nextChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          addMore.click(),
        ]);
        await nextChooser.setFiles(tmpPath);
      }
      console.log(`[poster] Picture ${i + 1}/${images.length} uploaded to gallery for ${id}`);
      await delay(1500, 2500);
    }

    // Step 2: Fill Caption. Try a few selectors — the field is labeled "Caption"
    // with placeholder "What say you?". No 369-char cap enforced here.
    if (caption) {
      const captionSelectors = [
        'textarea[placeholder*="What say you"]',
        'input[placeholder*="What say you"]',
        'textarea[name*="caption"]',
        'textarea[name*="body"]',
        'textarea[aria-label*="Caption"]',
        'textarea',
      ];
      let typed = false;
      for (const sel of captionSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.fill(sel, '');
          for (const char of caption) {
            await page.type(sel, char, { delay: 35 + Math.random() * 75 });
          }
          typed = true;
          break;
        }
      }
      if (!typed) console.warn('[poster] /pictures/new — could not find caption field; submitting without caption');
      await delay(400, 800);
    }

    // Step 3: Tick the 18+ consent checkbox ("I certify that everyone in the picture
    // consented to have it uploaded to FetLife, that everyone was 18 or older …").
    const consentSelectors = [
      'input[type="checkbox"][name*="consent"]',
      'input[type="checkbox"][name*="certify"]',
      'input[type="checkbox"][name*="age"]',
      'input[type="checkbox"][name*="adult"]',
      'input[type="checkbox"][name*="18"]',
    ];
    let consentChecked = false;
    for (const sel of consentSelectors) {
      try {
        const cb = await page.$(sel);
        if (cb) {
          const already = await cb.isChecked();
          if (!already) await cb.check();
          consentChecked = true;
          console.log('[poster] Checked 18+ consent checkbox');
          break;
        }
      } catch {}
    }
    if (!consentChecked) {
      // Last-ditch: find the checkbox by the label text. /pictures/new has only two
      // checkboxes (Use as Avatar + the consent one); the consent label is much longer.
      const checked = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const consent = labels.find(l => /certify|consent|18 or older/i.test(l.textContent || ''));
        if (!consent) return false;
        const cb = consent.querySelector('input[type="checkbox"]') ||
                   (consent.htmlFor && document.getElementById(consent.htmlFor));
        if (cb && !cb.checked) cb.click();
        return !!cb;
      });
      if (!checked) throw new Error('Could not find the 18+ consent checkbox on /pictures/new');
    }

    // Step 4: Wait for any "Uploading…" indicator to clear (same race-condition guard
    // as the timeline picture flow — FetLife silently drops the submission if the
    // image upload isn't finalized yet).
    try {
      await page.waitForFunction(
        () => !/Uploading/i.test(document.body.innerText || ''),
        { timeout: 90000, polling: 500 }
      );
      console.log(`[poster] Gallery upload finalized for ${id}`);
    } catch {
      console.warn(`[poster] "Uploading…" still present after 90s — submitting anyway`);
    }
    await delay(500, 900);

    // Step 5: Click "Upload Your Picture".
    const submitted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const btn = buttons.find(b => /upload your picture/i.test(b.textContent || b.value || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!submitted) throw new Error('Could not find the "Upload Your Picture" submit button');

    // Step 6: Verify the upload landed. FetLife typically redirects to /pictures/<id>
    // or back to the gallery on success. If we're still on /pictures/new after 30s
    // something went wrong (validation error showing inline, etc).
    let verifiedUrl = null;
    try {
      await page.waitForFunction(
        () => !/\/pictures\/new$/.test(window.location.pathname),
        { timeout: 30000, polling: 500 }
      );
      verifiedUrl = page.url();
      console.log(`[poster] Gallery picture posted for ${id}, landed on ${verifiedUrl}`);
    } catch {
      // Still on /pictures/new — check for visible error text and surface it.
      const errText = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[class*="error"], [role="alert"], .field_with_errors'));
        return els.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 300);
      });
      throw new Error('Upload did not redirect off /pictures/new within 30s' + (errText ? ' — page error: ' + errText : ''));
    }

    await browser.close();
    await cleanupTempFiles(tempFiles);
    return { success: true, url: verifiedUrl };
  } catch (err) {
    await browser.close().catch(() => {});
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
    // Wait for the navigation OFF /events/new instead of a fixed sleep. A slow submit
    // that lands after the old fixed delay would read as "still on /events/new" → we'd
    // throw "creation failed" even though FetLife created the event → the caller retries
    // → duplicate event. Give the redirect up to 30s; the delay below still lets the
    // destination settle.
    await page.waitForURL(u => !/\/events\/new(\?|$)/.test(u.toString()), { timeout: 30000 }).catch(() => {});
    await delay(3000, 5000);

    const finalUrl = page.url();
    const success = finalUrl.includes('/events/') && !finalUrl.includes('/new');
    await browser.close();

    if (success) return { success: true, url: finalUrl };
    throw new Error(`Event creation may have failed. URL: ${finalUrl}`);
  } catch (err) {
    await browser.close().catch(() => {});
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

/**
 * Anti-detection: detect when a page is showing a Cloudflare challenge, rate-limit
 * block, access-denied, or captcha — and throw with a screenshot. Call this AFTER
 * waitOutCloudflare on any critical-path action (posting, RSVPing) where silently
 * continuing through a challenge page is worse than failing loudly. Read-only scrapes
 * (discovery, mentions) can keep ignoring waitOutCloudflare's return value.
 */
export async function assertNotBlocked(page, label = 'unknown') {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800)).catch(() => '');
  const blocked = /just a moment|verifying|access denied|forbidden|rate ?limit|too many requests|temporarily blocked|locked your account/i.test(title + ' ' + bodyText)
    || url.includes('__cf_chl')
    || url.includes('/challenge')
    || url.includes('/blocked')
    || url.includes('/rate-limited');
  if (!blocked) return;
  let screenshotPath = null;
  try {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    screenshotPath = path.join(SCREENSHOTS_DIR, `block-${safeLabel}-${stamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch { /* screenshot is best-effort; still throw the block */ }
  throw new Error(`FetLife block detected (${label}). title="${title.slice(0,80)}" url=${url.slice(0,80)} — likely Cloudflare/rate-limit/account-lock; needs human attention${screenshotPath ? `. Screenshot: ${screenshotPath}` : ''}`);
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
    // Catch the broader block patterns (rate-limit, account-lock, etc.) before the
    // composer code runs — produces a screenshot + structured error vs. cryptic
    // "selector not found" downstream.
    await assertNotBlocked(page, `group-${groupId}-pre-post`);

    // Membership / session gate. The composer URL can degrade in three ways:
    //   1) Cookies expired → FetLife serves the login form at the requested URL (no
    //      URL change). checkLoggedIn() catches this; re-run here in case the session
    //      died between /home and the composer load.
    //   2) Account isn't a member → /groups/<id>/posts/new redirects to /groups/<id>
    //      and the landing page shows a "Join Group" button.
    //   3) Group deleted / private / moved → redirect with no Join button.
    await checkLoggedIn(page);
    const landedUrl = page.url();
    const isComposer = /\/groups\/\d+\/posts\/new(\?|$)/.test(landedUrl);
    if (!isComposer) {
      const joinable = await page.evaluate(() => {
        // FetLife's Join button wraps the label in nested spans ("Join Group" + "Join"
        // sibling for responsive widths), so textContent reads as "Join GroupJoin" and
        // an exact regex misses it. Match the substring instead, scoped to controls whose
        // total label is short enough to be a button rather than a paragraph link.
        const btns = Array.from(document.querySelectorAll('button, a'));
        return btns.some(b => {
          const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 60) return false;
          return /\b(join group|request to join|request membership|join)\b/i.test(txt);
        });
      }).catch(() => false);
      // Try to grab the group's display name to make the error self-explanatory.
      const groupName = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1 ? (h1.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) : '';
      }).catch(() => '');
      if (joinable) {
        throw new Error(`Account "${accountId}" is not a member of group ${groupId}${groupName ? ` ("${groupName}")` : ''} — FetLife redirected the composer URL to the group page. Join the group on FetLife as ${accountId}, then retry. (Or remove this group from the cross-post target list.)`);
      }
      // Redirected but no Join button — group might be private, deleted, or moved.
      throw new Error(`Group composer URL redirected to ${landedUrl} (expected /groups/${groupId}/posts/new). Group may be private/deleted/moved, or the account lacks posting permission.`);
    }

    // Title input. FetLife reshuffles the form HTML occasionally, so we try a list of
    // known-historical selectors first, then fall back to a DOM scan that picks the most
    // plausible "title" input on the page. If both fail we dump the form HTML for diagnosis.
    let titleHandle = await findFirstSelector(page, [
      'input[name="group_post[title]"]',
      'input[name="post[title]"]',
      'input[name="discussion[title]"]',
      'input[name="thread[title]"]',
      'input[id*="title" i]',
      'input[placeholder="Title"]',
      'input[placeholder*="Title" i]',
      'input[aria-label*="title" i]',
    ], 3000);

    if (!titleHandle) {
      // DOM fallback: the new-discussion form has exactly one prominent text input
      // above the contenteditable body. Find the first visible <input> that's text-ish
      // and isn't a search/filter input (FetLife's header has a global search box).
      titleHandle = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const el of inputs) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (!['text', '', 'search'].includes(type)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const name = (el.getAttribute('name') || '').toLowerCase();
          const id = (el.getAttribute('id') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          // Skip obvious search inputs in headers/sidebars
          if (/search|filter|query|kink|location/.test(name + ' ' + id + ' ' + placeholder)) continue;
          // Build a stable selector we can hand back to Playwright
          if (id) return '#' + CSS.escape(id);
          if (name) return 'input[name="' + name.replace(/"/g, '\\"') + '"]';
          // Last resort: tag selector with index
          el.setAttribute('data-fp-title', '1');
          return 'input[data-fp-title="1"]';
        }
        return null;
      });
    }

    if (!titleHandle) {
      // Dump the form HTML so the next failure is debuggable without VNC.
      try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dumpPath = path.join(SCREENSHOTS_DIR, `group-${groupId}-no-title-${stamp}.html`);
        const html = await page.content();
        await fs.writeFile(dumpPath, html, 'utf8');
        console.warn(`[poster] dumped form HTML to ${dumpPath} for diagnosis`);
      } catch {}
      throw new Error('Could not find title input on new-discussion form (FetLife may have changed the form HTML — see data/post-screenshots/group-*-no-title-*.html for the dump)');
    }
    const titleSel = titleHandle;
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
    // Strip @ symbols defensively — covers both extracted descriptions and any
    // @ the operator typed themselves. FetLife treats @ as a mention attempt
    // and either renders a broken mention or fails the post outright.
    const cleanBody = String(body).replace(/@/g, '').replace(/ {2,}/g, ' ');
    // Paste the body as HTML so TipTap renders bold/italic/links/lists instead
    // of typing the raw markdown characters into the editor (which would show
    // as literal text). The page.evaluate runs in the browser and dispatches a
    // synthetic ClipboardEvent — TipTap's paste handler parses the HTML.
    await page.evaluate(({ md, sel }) => {
      // Minimal markdown→HTML converter sufficient for the stylings FetLife
      // event copy actually uses: bold, italic, links, headings, lists,
      // blockquotes, paragraph breaks. Unknown markup falls through as text.
      function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function mdInline(s) {
        return s
          .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
          .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
          .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
          .replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      }
      function mdToHtml(md) {
        const escaped = escapeHtml(md || '');
        const blocks = escaped.split(/\n{2,}/);
        const out = [];
        for (const block of blocks) {
          if (!block.trim()) continue;
          // Heading
          const h = /^(#{1,6})\s+(.+)$/m.exec(block.trim());
          if (h && block.trim().split('\n').length === 1) {
            out.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>');
            continue;
          }
          // Bullet list (each line starts with "- " or "* ")
          if (/^[-*]\s+/m.test(block) && block.split('\n').every(l => /^[-*]\s+/.test(l) || !l.trim())) {
            const items = block.split('\n').filter(l => l.trim()).map(l => '<li>' + mdInline(l.replace(/^[-*]\s+/, '')) + '</li>').join('');
            out.push('<ul>' + items + '</ul>');
            continue;
          }
          // Numbered list
          if (/^\d+\.\s+/m.test(block) && block.split('\n').every(l => /^\d+\.\s+/.test(l) || !l.trim())) {
            const items = block.split('\n').filter(l => l.trim()).map(l => '<li>' + mdInline(l.replace(/^\d+\.\s+/, '')) + '</li>').join('');
            out.push('<ol>' + items + '</ol>');
            continue;
          }
          // Blockquote
          if (/^>\s+/m.test(block) && block.split('\n').every(l => /^>\s+/.test(l) || !l.trim())) {
            const text = block.split('\n').filter(l => l.trim()).map(l => l.replace(/^>\s+/, '')).join('<br>');
            out.push('<blockquote>' + mdInline(text) + '</blockquote>');
            continue;
          }
          // Plain paragraph — single newlines become <br>
          out.push('<p>' + mdInline(block.replace(/\n/g, '<br>')) + '</p>');
        }
        return out.join('\n');
      }
      const html = mdToHtml(md);
      const editor = document.querySelector(sel);
      if (!editor) return;
      editor.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', md);
      const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(evt);
    }, { md: cleanBody, sel: bodySel });
    await delay(400, 800);

    // Verify the body actually took.  The synthetic ClipboardEvent path silently
    // no-ops in some TipTap configurations (depending on its `enableContentCheck`,
    // version of @tiptap/extension-paste, and the FetLife group's exact form
    // wiring).  We discovered this via Camp Crucible (g1427) — the form rendered
    // empty even though the paste event was dispatched and the submit clicked.
    // Fall back to Playwright keyboard typing if the paste didn't land; that's a
    // real user-input event and ProseMirror has to accept it.  Sacrifices
    // formatting (bold/italic/links become plain text) but a published plain
    // post beats a silently-dropped formatted one every time.
    const expectedFirstChars = cleanBody.replace(/^[#>*_\s]+/, '').slice(0, 12);
    const pastedOk = await page.evaluate(({ sel, needle }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const txt = (el.textContent || '').trim();
      return txt.length >= 20 && (!needle || txt.includes(needle));
    }, { sel: bodySel, needle: expectedFirstChars }).catch(() => false);
    if (!pastedOk) {
      console.warn(`[poster] Body paste did not register for group ${groupId} — falling back to keyboard typing (plain-text only).`);
      // Clear whatever's there (in case a partial paste sneaked in), then re-focus
      // and type the markdown source as plain text.  We type the markdown source
      // rather than HTML because TipTap interprets typed text literally — at the
      // cost of losing bold/italic/link formatting that the markdown carried.
      await page.click(bodySel);
      await page.keyboard.press('Control+A').catch(() => null);
      await page.keyboard.press('Delete').catch(() => null);
      // type() can choke on huge bodies — use insertText which is a single op.
      await page.locator(bodySel).first().pressSequentially(cleanBody, { delay: 0 }).catch(async () => {
        // Last-ditch fallback for very old Playwright builds: insertText.
        await page.keyboard.insertText(cleanBody);
      });
      await delay(500, 900);
      const typedOk = await page.evaluate(({ sel, needle }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const txt = (el.textContent || '').trim();
        return txt.length >= 20 && (!needle || txt.includes(needle));
      }, { sel: bodySel, needle: expectedFirstChars }).catch(() => false);
      if (!typedOk) {
        // Both insertion paths failed — abort before we waste a submit click on
        // an empty form (which is what burned the operator on the original bug).
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = path.join(SCREENSHOTS_DIR, `group-${groupId}-empty-body-${stamp}.png`);
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {});
        await page.screenshot({ path: failShot, fullPage: false }).catch(() => {});
        throw new Error(`Body editor on group ${groupId} stayed empty after both paste + keyboard fallbacks — FetLife may have shipped a TipTap version that rejects programmatic input.  Screenshot: ${failShot}`);
      }
    }

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

    // Click + wait for the URL to actually change away from /posts/new before
    // calling the navigation done.  Previously we waited for networkidle in
    // parallel and then read page.url() — which fired before the click's nav had
    // committed on slow groups, so we'd read the stale composer URL even when
    // the submit had actually worked.  The fix: explicitly waitForURL with a
    // matcher that excludes /posts/new, so we keep waiting until either we
    // navigate AWAY from the composer (success or moderation) or we time out
    // (real silent rejection).
    const composerUrl = page.url();
    await page.click(submitSel);
    try {
      await page.waitForURL(u => {
        try {
          const url = u.toString();
          if (url === composerUrl) return false;
          // Anything off /posts/new counts as a real navigation.
          return !/\/groups\/\d+\/posts\/new(\?|$)/.test(url);
        } catch { return false; }
      }, { timeout: 30000 });
    } catch {
      // Timed out — URL stayed on /posts/new for the full 30s.  Genuine stuck-
      // on-composer case; the downstream logic below will classify it as a
      // failure and capture the screenshot.
    }
    // Even after waitForURL returns, give the new page a moment to actually
    // paint (some FetLife redirects chain two navs back-to-back).
    await delay(1500, 2500);
    await waitOutCloudflare(page, 20000);

    const finalUrl = page.url();
    // Three buckets for the post-submit URL — they require very different operator
    // actions, so we classify carefully:
    //   1) /groups/<id>/(group_)?posts/<numericId>  → a post permalink.  Submitted + live.
    //   2) /groups/<id>/posts/new                    → STILL on the composer page.  Click
    //      didn't navigate ⇒ FetLife rejected the form (client-side validation, dup-detect,
    //      banned word, etc.) or the click missed.  This is a real failure — treating it as
    //      "moderation pending" hid actual broken posts from view for weeks.
    //   3) anything else (/groups/<id>, /groups/<id>/group_posts) → submitted but URL
    //      doesn't carry a permalink ⇒ moderation queue likely.  Admins should never hit
    //      this since they bypass mod; if they do, it's also probably a soft failure.
    const onPostPermalink = /\/groups\/\d+\/(group_posts|posts)\/\d+/.test(finalUrl) && !/\/posts\/new(\?|$)/.test(finalUrl);
    const stillOnComposer = /\/groups\/\d+\/posts\/new(\?|$)/.test(finalUrl);

    // Reaching a post permalink is positive proof the post landed. Only screen for a
    // Cloudflare/interstitial block when we did NOT reach one — otherwise a challenge
    // that pops up on the permalink page would throw, the scheduler would treat the
    // confirmed-success as a failure, and the auto-retry would double-post.
    if (!onPostPermalink) {
      await assertNotBlocked(page, `group-${groupId}-submit`);
    }

    // Always save a post-submit screenshot — successful or not.  When the operator
    // asks "where did my post go?", the screenshot answers it without needing a re-run.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(SCREENSHOTS_DIR, `group-${groupId}-post-submit-${stamp}.png`);
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {});
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});

    // If we're still on the composer, read any inline error banner FetLife showed
    // so the failure message is self-explanatory in the queue.
    let composerError = null;
    if (stillOnComposer) {
      composerError = await page.evaluate(() => {
        const sel = '[role="alert"], .alert-danger, .alert, .errors, .error, [class*="error"], [class*="Error"]';
        const candidates = Array.from(document.querySelectorAll(sel));
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length < 400) return txt;
        }
        return null;
      }).catch(() => null);
    }

    await browser.close();

    if (onPostPermalink) {
      return { success: true, url: finalUrl, screenshot: screenshotPath };
    }
    if (stillOnComposer) {
      const detail = composerError ? ` FetLife displayed: "${composerError}".` : ' No inline error was shown — likely a silent rejection or a missed click.';
      throw new Error(`Group ${groupId} submit did not go through — page is still on the new-discussion composer after submit.${detail} Screenshot: ${screenshotPath}`);
    }
    console.warn(`[poster] Submit landed on group page (moderation queue likely): ${finalUrl}`);
    return { success: true, url: finalUrl, moderated: true, screenshot: screenshotPath };
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}
