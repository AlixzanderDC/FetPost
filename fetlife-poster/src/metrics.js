/**
 * Engagement metrics scraper.
 * Refreshes on-demand: load a post or event page, pull counts, append a JSONL snapshot.
 * Snapshots stored per-id in data/metrics/posts/<id>.jsonl and data/metrics/events/<id>.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare, checkLoggedIn } from './poster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, '..', 'data', 'metrics', 'posts');
const EVENTS_DIR = path.join(__dirname, '..', 'data', 'metrics', 'events');

function safeKey(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);
}

async function appendSnapshot(dir, key, snapshot) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeKey(key) + '.jsonl');
  await fs.appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...snapshot }) + '\n');
}

async function readSnapshots(dir, key) {
  const file = path.join(dir, safeKey(key) + '.jsonl');
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Post scraper ──────────────────────────────────────────────────────────────

export async function scrapePostMetrics(accountId, postUrl) {
  if (!postUrl || !/^https?:\/\/fetlife\.com\//.test(postUrl)) {
    throw new Error('postUrl must be a fetlife.com URL');
  }
  // Headed Chrome — FetLife's Cloudflare gates headless. Same lesson as the event scraper.
  const { browser, context } = await launchWithCookies(accountId, { headless: false });
  try {
    const page = await context.newPage();
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Content-aware: catches the case where FetLife served the login form at the
    // requested URL without redirecting. URL-only checks miss this and produce a
    // misleading "no engagement found" result.
    await checkLoggedIn(page);

    // Debug text dump — same approach as the event scraper, makes selector tuning offline.
    try {
      const debugDir = path.join(__dirname, '..', 'data', 'metrics', 'debug-posts');
      await fs.mkdir(debugDir, { recursive: true });
      const debugFile = path.join(debugDir, safeKey(postUrl) + '.txt');
      const text = await page.evaluate(() => document.body.innerText || '');
      await fs.writeFile(debugFile, text, 'utf8');
    } catch {}

    return await page.evaluate(() => {
      // Find counts via several strategies; FetLife's class names change but text patterns are durable.
      const text = document.body.innerText || '';

      const matchN = (rx) => {
        const m = text.match(rx);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
      };

      // Counts (text-based, robust to class-name churn).
      // FetLife labels: "12 loves", "3 super loves", "5 comments", "42 views" (or "viewed by 42")
      let loves = matchN(/(\d[\d,]*)\s+loves?\b(?!\s*you)/i);          // exclude "loves you"
      let superLoves = matchN(/(\d[\d,]*)\s+super\s+loves?\b/i);
      let comments = matchN(/(\d[\d,]*)\s+comments?\b/i);
      let views = matchN(/(\d[\d,]*)\s+views?\b/i) ?? matchN(/viewed\s+by\s+(\d[\d,]*)/i);

      // Fallback: data-testid scan for each metric.
      const scanTestid = (needle) => {
        for (const el of document.querySelectorAll(`[data-testid*="${needle}" i]`)) {
          const m = (el.textContent || '').match(/(\d[\d,]*)/);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        }
        return null;
      };
      if (loves === null) loves = scanTestid('love');
      if (superLoves === null) superLoves = scanTestid('super');
      if (comments === null) comments = scanTestid('comment');
      if (views === null) views = scanTestid('view');

      // "1 super love" embedded in the regular "loves" count can cause a double-count if the
      // page renders them as a single string like "13 loves (1 super love)". Subtract super
      // from total when both are present and total >= super.
      if (loves !== null && superLoves !== null && loves >= superLoves
          && /(\d[\d,]*)\s+loves?\s*\(.*?super/i.test(text)) {
        loves = loves - superLoves;
      }

      const title = document.querySelector('h1, h2, [data-testid*="title" i]')?.textContent?.trim() || null;

      return {
        title,
        loves: loves ?? 0,
        superLoves: superLoves ?? 0,
        comments: comments ?? 0,
        views: views ?? null,                  // null = page didn't expose views (not all post types do)
        url: window.location.href,
      };
    });
  } finally {
    await browser.close();
  }
}

export async function refreshPostMetrics(accountId, postId, postUrl) {
  const snap = await scrapePostMetrics(accountId, postUrl);
  await appendSnapshot(POSTS_DIR, postId, snap);
  return snap;
}

export async function readPostMetrics(postId) {
  return await readSnapshots(POSTS_DIR, postId);
}

// ── Event scraper ─────────────────────────────────────────────────────────────

export async function scrapeEventMetrics(accountId, eventUrl) {
  if (!eventUrl || !/^https?:\/\/fetlife\.com\/events\//.test(eventUrl)) {
    throw new Error('eventUrl must be a fetlife.com /events/... URL');
  }
  // Non-headless to mirror the discovery scrapers — FetLife's Cloudflare blocks headless Chrome.
  const { browser, context } = await launchWithCookies(accountId, { headless: false });
  try {
    const page = await context.newPage();
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);

    await checkLoggedIn(page);

    // Dump the full page text to a debug file so we can tune selectors offline.
    try {
      const debugDir = path.join(__dirname, '..', 'data', 'metrics', 'debug');
      await fs.mkdir(debugDir, { recursive: true });
      const debugFile = path.join(debugDir, safeKey(eventUrl) + '.txt');
      const text = await page.evaluate(() => document.body.innerText || '');
      await fs.writeFile(debugFile, text, 'utf8');
    } catch {}

    return await page.evaluate(() => {
      const fullText = document.body.innerText || '';

      // FetLife uses parenthesized section headers: "Going (21)" / "Interested In (78)".
      // Match exactly that pattern for each label.
      const findParenCount = (label) => {
        const rx = new RegExp('\\b' + label.replace(/\s+/g, '\\s+') + '\\s*\\((\\d[\\d,]*)\\)', 'i');
        const m = fullText.match(rx);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
      };

      // Total RSVPs appears two ways on the page:
      //   1) Header strip: "RSVPs\n99" near the top
      //   2) Footer line: "99 kinksters RSVPed"
      const findTotal = () => {
        let m = fullText.match(/\bRSVPs\s*\n\s*(\d[\d,]*)\b/);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        m = fullText.match(/(\d[\d,]*)\s+kinksters?\s+RSVPed/i);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        return null;
      };

      const title = document.querySelector('h1')?.textContent?.trim() || null;
      const going = findParenCount('Going');
      // "Interested In" is FetLife's label for what other platforms call "Curious/Maybe".
      const curious = findParenCount('Interested In') || findParenCount('Curious') || findParenCount('Interested');
      const maybe = findParenCount('Maybe'); // typically absent on FetLife — defaults to 0.
      const total = findTotal() ?? (going + curious + maybe);

      return {
        title,
        going, maybe, curious, total,
        url: window.location.href,
      };
    });
  } finally {
    await browser.close();
  }
}

export async function refreshEventMetrics(accountId, eventId, eventUrl) {
  const snap = await scrapeEventMetrics(accountId, eventUrl);
  await appendSnapshot(EVENTS_DIR, eventId, snap);
  return snap;
}

export async function readEventMetrics(eventId) {
  return await readSnapshots(EVENTS_DIR, eventId);
}
