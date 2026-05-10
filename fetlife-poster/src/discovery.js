/**
 * Scrapes the logged-in account's joined groups and organized events.
 * Group routes need non-headless Chrome to bypass Cloudflare; we always warm
 * /home first to settle CF clearance before navigating into /groups or /events.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare } from './poster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FL_BASE = 'https://fetlife.com';
const GROUPS_DIR = path.join(__dirname, '..', 'data', 'groups');
const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');

async function withSession(accountId, fn) {
  const { browser, context } = await launchWithCookies(accountId, { headless: false });
  try {
    const page = await context.newPage();
    await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    if (page.url().includes('/login') || page.url().includes('/sign_in')) {
      throw new Error(`Not logged in for ${accountId} — refresh cookies`);
    }
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// ── Joined groups ─────────────────────────────────────────────────────────────

export async function listJoinedGroups(accountId) {
  return withSession(accountId, async (page) => {
    await page.goto(`${FL_BASE}/home/groups`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    return await page.$$eval('a[href*="/groups/"]', (anchors) => {
      const seen = new Map();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/groups\/(\d+)(?:\/?($|\?))/);
        if (!m) continue;
        if (href.includes('/group_posts')) continue;
        const id = m[1];
        const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || seen.has(id)) continue;
        seen.set(id, { id, name: text.slice(0, 200), url: 'https://fetlife.com' + href });
      }
      return [...seen.values()];
    });
  });
}

export async function refreshGroupsForAccount(accountId) {
  const groups = await listJoinedGroups(accountId);
  await fs.mkdir(GROUPS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), groups };
  await fs.writeFile(path.join(GROUPS_DIR, `${accountId}.json`), JSON.stringify(out, null, 2));
  return out;
}

export async function readCachedGroups(accountId) {
  try {
    return JSON.parse(await fs.readFile(path.join(GROUPS_DIR, `${accountId}.json`), 'utf8'));
  } catch { return null; }
}

// ── Organized events ──────────────────────────────────────────────────────────

export async function listOrganizedEvents(accountId) {
  return withSession(accountId, async (page) => {
    await page.goto(`${FL_BASE}/events/organizing`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const events = await page.$$eval('h3 a[href*="/events/"][title]', (anchors) => {
      const seen = new Map();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/events\/(\d{4})\/(\d{2})\/(\d{2})\/([^?]+)/);
        if (!m) continue;
        const [, y, mo, d, slug] = m;
        const cleanUrl = `https://fetlife.com/events/${y}/${mo}/${d}/${slug}`;
        if (seen.has(cleanUrl)) continue;
        const card = a.closest('[data-testid]');
        let category = null, dateText = null, location = null, eventId = null;
        if (card) {
          const idMatch = (card.getAttribute('data-testid') || '').match(/^(\d+)/);
          if (idMatch) eventId = idMatch[1];
          const cat = card.querySelector('[data-testid="category pill"]');
          if (cat) category = cat.textContent.trim();
          // Each metadata row sits inside <div class="flex items-start py-1"> with an svg icon then a span of text.
          const rows = card.querySelectorAll('div.flex.items-start');
          if (rows[0]) dateText = rows[0].textContent.trim().replace(/\s+/g, ' ');
          if (rows[1]) location = rows[1].textContent.trim().replace(/\s+/g, ' ');
        }
        seen.set(cleanUrl, {
          id: eventId,
          url: cleanUrl,
          title: a.getAttribute('title') || a.textContent.trim(),
          category,
          dateText,
          location,
          urlDate: `${y}-${mo}-${d}`,
        });
      }
      // Filter to upcoming (URL date >= today, UTC).
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      return [...seen.values()].filter(e => e.urlDate >= todayStr);
    });
    return events;
  });
}

export async function refreshEventsForAccount(accountId) {
  const events = await listOrganizedEvents(accountId);
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), events };
  await fs.writeFile(path.join(EVENTS_DIR, `${accountId}.json`), JSON.stringify(out, null, 2));
  return out;
}

export async function readCachedEvents(accountId) {
  try {
    return JSON.parse(await fs.readFile(path.join(EVENTS_DIR, `${accountId}.json`), 'utf8'));
  } catch { return null; }
}

// ── Attending events (events the account RSVP'd "going" / "interested") ──────

async function scrapeEventListPage(page, listUrl) {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await waitOutCloudflare(page, 30000);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  return await page.$$eval('h3 a[href*="/events/"][title], a[href*="/events/"][title]', (anchors) => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/events\/(\d{4})\/(\d{2})\/(\d{2})\/([^?]+)/);
      if (!m) continue;
      const [, y, mo, d, slug] = m;
      const cleanUrl = `https://fetlife.com/events/${y}/${mo}/${d}/${slug}`;
      if (seen.has(cleanUrl)) continue;
      const card = a.closest('[data-testid]');
      let category = null, dateText = null, location = null, eventId = null;
      if (card) {
        const idMatch = (card.getAttribute('data-testid') || '').match(/^(\d+)/);
        if (idMatch) eventId = idMatch[1];
        const cat = card.querySelector('[data-testid="category pill"]');
        if (cat) category = cat.textContent.trim();
        const rows = card.querySelectorAll('div.flex.items-start');
        if (rows[0]) dateText = rows[0].textContent.trim().replace(/\s+/g, ' ');
        if (rows[1]) location = rows[1].textContent.trim().replace(/\s+/g, ' ');
      }
      seen.set(cleanUrl, {
        id: eventId, url: cleanUrl,
        title: a.getAttribute('title') || a.textContent.trim(),
        category, dateText, location, urlDate: `${y}-${mo}-${d}`,
      });
    }
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    return [...seen.values()].filter(e => e.urlDate >= todayStr);
  });
}

export async function listAttendingEvents(accountId) {
  return withSession(accountId, async (page) => {
    // Try /events/going first; some FetLife layouts use /events/interested as the
    // RSVP'd-but-not-organized list. Fall back if the first returns nothing.
    const going = await scrapeEventListPage(page, `${FL_BASE}/events/going`);
    if (going.length > 0) return going;
    return await scrapeEventListPage(page, `${FL_BASE}/events/interested`);
  });
}

export async function refreshAttendingEventsForAccount(accountId) {
  const events = await listAttendingEvents(accountId);
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), events };
  await fs.writeFile(path.join(EVENTS_DIR, `${accountId}-attending.json`), JSON.stringify(out, null, 2));
  return out;
}

export async function readCachedAttendingEvents(accountId) {
  try {
    return JSON.parse(await fs.readFile(path.join(EVENTS_DIR, `${accountId}-attending.json`), 'utf8'));
  } catch { return null; }
}

// ── Single event description (loaded on demand for cross-posting) ─────────────

export async function getEventDetails(accountId, eventUrl) {
  if (!eventUrl || !/^https:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\//.test(eventUrl)) {
    throw new Error('eventUrl must be a fetlife.com /events/YYYY/MM/DD/... URL');
  }
  return withSession(accountId, async (page) => {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Expand truncated description if a "Continue reading" toggle is present.
    try {
      const expand = page.locator('button:has-text("Continue reading"), a:has-text("Continue reading")').first();
      if (await expand.count()) {
        await expand.click({ timeout: 3000 });
        await page.waitForTimeout(500);
      }
    } catch {}

    return await page.evaluate(() => {
      const title = document.querySelector('h1')?.textContent?.trim() || null;

      // Anchor strictly on the <h2>Description</h2> heading. The description body sits in
      // the next sibling block within the same logical section. We collect block-level
      // text from that point forward until the next heading-like marker.
      let description = null;
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const descHeading = headings.find(h => /^description$/i.test(h.textContent.trim()));

      // Use innerText (not textContent) so block boundaries become real \n separators —
      // the group-post body needs paragraph structure preserved.
      if (descHeading) {
        let section = descHeading.parentElement;
        for (let i = 0; i < 5 && section; i++) {
          if (section.textContent.trim().length > descHeading.textContent.trim().length + 60) break;
          section = section.parentElement;
        }
        if (section) {
          const headingRect = descHeading.getBoundingClientRect();
          const blocks = Array.from(section.querySelectorAll('p, div'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              if (r.top <= headingRect.bottom) return false;
              const txt = el.textContent.trim();
              return txt.length > 40 && !/^(Going|Interested In|Discussions|RSVPs|Manage)/i.test(txt);
            });
          blocks.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
          if (blocks[0]) description = blocks[0].innerText.trim();
        }
      }

      if (!description) {
        const candidates = Array.from(document.querySelectorAll('div'))
          .filter(el => {
            const txt = el.textContent.trim();
            if (txt.length < 200 || txt.length > 6000) return false;
            if (/Discussions\d|RSVPs\d|Going \(|Manage Manage/.test(txt)) return false;
            return true;
          });
        candidates.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
        if (candidates[0]) description = candidates[0].innerText.trim();
      }

      return { title, description, url: window.location.href };
    });
  });
}
