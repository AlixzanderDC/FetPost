/**
 * Batched, ID-keyed, cache-coalesced event details for external integrations
 * (e.g. QM). One page visit per (event, refresh-tick) — title, description,
 * startsAt/endsAt, venue, and RSVP counts all come from the same scrape.
 *
 * eventId → URL resolution walks tracked + hosted + attending + past caches.
 * Any ID not found in those caches is reported in notFound[].
 *
 * Cache: data/events/details/<eventId>.json. Fresh-window: 15 min. Within the
 * window, ?refresh=true is a no-op (returns the cached payload).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare } from './poster.js';
import { autoRefreshCookies } from './extractor.js';
import {
  readCachedEvents,
  readCachedAttendingEvents,
  readCachedPastEvents,
} from './discovery.js';
import { listTrackedEvents } from './tracked-events.js';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DETAILS_DIR = path.join(__dirname, '..', 'data', 'events', 'details');
const FRESH_MS = 15 * 60 * 1000;
const MAX_BATCH = 25;

export function extractEventId(url) {
  // FetLife URLs come in two shapes:
  //   Legacy: /events/YYYY/MM/DD/<numericId>-<slug>          (e.g. ...12345-event-name)
  //   New:    /events/YYYY/MM/DD/<slug>-<shortAlphaId>       (e.g. ...cruciblecon-2026-3aajz5)
  // Return whichever id form is present so the resolver can index both forms
  // (discovery.js stores numeric data-testid for legacy cards, slug-suffix for new ones).
  const slugMatch = (url || '').match(/\/events\/\d{4}\/\d{2}\/\d{2}\/([^\/?#]+)/);
  if (!slugMatch) return null;
  const slug = slugMatch[1];
  const trail = slug.match(/-([a-z0-9]{4,12})$/i);
  if (trail) return trail[1];
  const lead = slug.match(/^(\d+)/);
  if (lead) return lead[1];
  return null;
}

async function buildIdIndex(accountId) {
  const sources = await Promise.all([
    readCachedEvents(accountId).catch(() => []),
    readCachedAttendingEvents(accountId).catch(() => []),
    readCachedPastEvents(accountId).catch(() => []),
    listTrackedEvents(accountId).catch(() => []),
  ]);
  const index = new Map();
  for (const list of sources) {
    for (const e of (Array.isArray(list) ? list : [])) {
      const id = e.id || extractEventId(e.url);
      if (!id || !e.url) continue;
      if (!index.has(id)) {
        index.set(id, { url: e.url, listTitle: e.title || null, listLocation: e.location || null, listDate: e.dateText || null });
      }
    }
  }
  return index;
}

function detailsFile(eventId) {
  return path.join(DETAILS_DIR, `${eventId}.json`);
}

async function readDetailsCache(eventId) {
  return await readJsonStrict(detailsFile(eventId), {
    defaultIfMissing: null,
    label: `events/details/${eventId}.json`,
  }).catch(() => null);
}

async function writeDetailsCache(eventId, payload) {
  await fs.mkdir(DETAILS_DIR, { recursive: true });
  await writeJsonAtomic(detailsFile(eventId), payload);
}

function isFresh(cached) {
  if (!cached || !cached.lastRefreshedAt) return false;
  return Date.now() - new Date(cached.lastRefreshedAt).getTime() < FRESH_MS;
}

// One page visit → everything. Mirrors discovery.withSession + metrics.scrapeEventMetrics
// but folded into a single Playwright session so we don't double the bot-load.
async function scrapeFullEventDetails(accountId, eventUrl) {
  if (!/^https:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\//.test(eventUrl)) {
    throw new Error('eventUrl must be a canonical fetlife.com /events/YYYY/MM/DD/... URL');
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { browser, context } = await launchWithCookies(accountId, { headless: false });
    try {
      const page = await context.newPage();
      await page.goto('https://fetlife.com/home', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      if (page.url().includes('/login') || page.url().includes('/sign_in')) {
        await browser.close().catch(() => {});
        if (attempt === 1) {
          const refreshed = await autoRefreshCookies(accountId);
          if (refreshed) continue;
        }
        throw new Error(`Not logged in for ${accountId} — manual VNC refresh needed`);
      }
      await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
      await waitOutCloudflare(page, 30000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2500);

      // Expand description if there's a "Continue reading" toggle.
      try {
        const expand = page.locator('button:has-text("Continue reading"), a:has-text("Continue reading")').first();
        if (await expand.count()) {
          await expand.click({ timeout: 3000 });
          await page.waitForTimeout(500);
        }
      } catch {}

      const scraped = await page.evaluate(() => {
        const fullText = document.body.innerText || '';

        // Title — page heading.
        const title = document.querySelector('h1')?.textContent?.trim() || null;

        // Dates — FetLife uses <time datetime="..."> elements on event detail pages.
        // First two <time> tags are typically "starts" then "ends".
        const timeEls = Array.from(document.querySelectorAll('time'))
          .map(t => t.getAttribute('datetime') || t.dateTime || null)
          .filter(Boolean);
        const startsAt = timeEls[0] || null;
        const endsAt = timeEls[1] || null;

        // Venue — look for a "Where" / "Location" heading and read the following block.
        let venue = null;
        const headings = Array.from(document.querySelectorAll('h2, h3, h4, div, span'));
        const whereHeading = headings.find(h => {
          const t = h.textContent.trim();
          return /^(Where|Location)$/i.test(t);
        });
        if (whereHeading) {
          const sib = whereHeading.parentElement?.nextElementSibling || whereHeading.nextElementSibling;
          const txt = sib ? sib.textContent.trim().replace(/\s+/g, ' ') : '';
          if (txt) {
            // Heuristic split: first line is venue name, rest is address.
            const lines = txt.split(/\n+/).map(s => s.trim()).filter(Boolean);
            if (lines.length === 1) venue = { name: lines[0], address: null };
            else venue = { name: lines[0], address: lines.slice(1).join(', ') };
          }
        }

        // Description — same approach as discovery.getEventDetails.
        function nodeToMd(node) {
          if (!node) return '';
          if (node.nodeType === 3) return node.textContent || '';
          if (node.nodeType !== 1) return '';
          const tag = node.tagName.toLowerCase();
          const inner = Array.from(node.childNodes).map(nodeToMd).join('');
          switch (tag) {
            case 'br': return '\n';
            case 'p': case 'div': return inner + '\n\n';
            case 'strong': case 'b': return inner.trim() ? '**' + inner + '**' : '';
            case 'em': case 'i': return inner.trim() ? '*' + inner + '*' : '';
            case 'a': {
              const href = node.getAttribute('href') || '';
              if (!href || href === inner.trim()) return inner;
              return '[' + inner + '](' + href + ')';
            }
            case 'ul': case 'ol': return '\n' + inner + '\n';
            case 'li': return '- ' + inner.trim() + '\n';
            case 'h1': return '\n# ' + inner.trim() + '\n\n';
            case 'h2': return '\n## ' + inner.trim() + '\n\n';
            case 'h3': return '\n### ' + inner.trim() + '\n\n';
            case 'blockquote': return inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
            default: return inner;
          }
        }
        const descHeadings = Array.from(document.querySelectorAll('h2, h3'));
        const descHeading = descHeadings.find(h => /^description$/i.test(h.textContent.trim()));
        let description = null;
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
            if (blocks[0]) {
              description = nodeToMd(blocks[0])
                .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            }
          }
        }

        // RSVP counts — same heuristics as metrics.scrapeEventMetrics.
        const findParenCount = (label) => {
          const rx = new RegExp('\\b' + label.replace(/\s+/g, '\\s+') + '\\s*\\((\\d[\\d,]*)\\)', 'i');
          const m = fullText.match(rx);
          return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
        };
        const findTotal = () => {
          let m = fullText.match(/\bRSVPs\s*\n\s*(\d[\d,]*)\b/);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
          m = fullText.match(/(\d[\d,]*)\s+kinksters?\s+RSVPed/i);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
          return null;
        };
        const going = findParenCount('Going');
        const curious = findParenCount('Interested In') || findParenCount('Curious') || findParenCount('Interested');
        const maybe = findParenCount('Maybe');
        const total = findTotal() ?? (going + curious + maybe);

        return {
          title, description,
          startsAt, endsAt,
          venue,
          rsvpCounts: { going, maybe, curious, total },
          finalUrl: window.location.href,
        };
      });

      await browser.close().catch(() => {});
      return scraped;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
}

function fallbackFromListEntry(eventId, entry) {
  // What we can synthesize without scraping the detail page. Useful when no
  // cache exists yet and the caller didn't pass refresh=true.
  return {
    eventId,
    url: entry.url,
    title: entry.listTitle || null,
    description: null,
    startsAt: null,
    endsAt: null,
    venue: entry.listLocation ? { name: entry.listLocation, address: null } : null,
    rsvpCounts: null,
    lastRefreshedAt: null,
  };
}

/**
 * Batch-fetch enriched details for one account's event IDs.
 * Returns { events: [...], notFound: [...] }.
 * Throws on empty/oversize input.
 */
export async function getBatchEventDetails(accountId, eventIds, { refresh = false } = {}) {
  const wanted = (Array.isArray(eventIds) ? eventIds : [])
    .map(s => String(s).trim()).filter(Boolean);
  if (wanted.length === 0) throw new Error('eventIds must include at least one id');
  if (wanted.length > MAX_BATCH) throw new Error(`Maximum ${MAX_BATCH} eventIds per batch`);

  const index = await buildIdIndex(accountId);
  const events = [];
  const notFound = [];

  for (const id of wanted) {
    const entry = index.get(id);
    if (!entry) { notFound.push(id); continue; }

    let cached = await readDetailsCache(id);
    if (refresh && !isFresh(cached)) {
      try {
        const scraped = await scrapeFullEventDetails(accountId, entry.url);
        cached = {
          eventId: id,
          url: entry.url,
          title: scraped.title || entry.listTitle || null,
          description: scraped.description || null,
          startsAt: scraped.startsAt || null,
          endsAt: scraped.endsAt || null,
          venue: scraped.venue || (entry.listLocation ? { name: entry.listLocation, address: null } : null),
          rsvpCounts: scraped.rsvpCounts || null,
          lastRefreshedAt: new Date().toISOString(),
        };
        await writeDetailsCache(id, cached);
      } catch (err) {
        // Scrape failed (Cloudflare, login expired, etc) — return cached if any, else
        // a fallback synthesized from the list cache. Don't let one bad event 500
        // the whole batch.
        if (!cached) cached = fallbackFromListEntry(id, entry);
        cached.scrapeError = err.message;
      }
    } else if (!cached) {
      cached = fallbackFromListEntry(id, entry);
    }
    events.push(cached);
  }

  return { events, notFound };
}
