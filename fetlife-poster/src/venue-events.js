/**
 * Venue Events watcher.
 * Per-account, scans FetLife for events matching configured search terms (typically
 * the venue's name + address keywords) so a venue owner can see all third-party
 * events being held at their address and RSVP to them in one place.
 *
 * Storage:  data/venue-events/<accountId>.json — { config, events: [...] }
 * Endpoints (mounted in server.js): GET/PUT config, POST scan, GET list, POST rsvp.
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare, checkLoggedIn } from './poster.js';
import { getAccount, updateAccountFields } from './credentials.js';
import { writeJsonAtomic, readJsonStrict, createKeyedMutex } from './util/atomic-json.js';

// Per-accountId mutex. Every mutating path (setRsvp / unRsvp / dismiss / hide /
// setConfig / runScan) wraps its read-modify-write in mutateStore(accountId, ...)
// so two concurrent requests on the same account can't clobber each other. Without
// this, a fast user clicking "Going" while a scan was finishing produced lost RSVPs
// (the scan's writeStore overwrote the freshly-set rsvpStatus). Different accounts
// still run in parallel.
const mutateStore = createKeyedMutex();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'venue-events');
const FL_BASE = 'https://fetlife.com';

const fileFor = (accountId) => path.join(DATA_DIR, encodeURIComponent(accountId) + '.json');

const DEFAULT_CONFIG = { venueAddress: '', searchTerms: [], cityUrl: '' };

async function readStore(accountId) {
  const parsed = await readJsonStrict(fileFor(accountId), {
    defaultIfMissing: null,
    label: `venue-events/${accountId}.json`,
  });
  if (!parsed) return { config: { ...DEFAULT_CONFIG }, events: [] };
  return {
    config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
    events: parsed.events || [],
    lastScanAt: parsed.lastScanAt,
  };
}

async function writeStore(accountId, store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(fileFor(accountId), store);
}

export async function getConfig(accountId) {
  return (await readStore(accountId)).config;
}

export async function setConfig(accountId, patch) {
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    store.config = { ...store.config, ...patch };
    await writeStore(accountId, store);
    return store.config;
  });
}

export async function listEvents(accountId, filter = {}) {
  const store = await readStore(accountId);
  let items = store.events;
  if (!filter.includeDismissed) items = items.filter(e => !e.dismissed);
  if (filter.rsvpStatus) items = items.filter(e => e.rsvpStatus === filter.rsvpStatus);
  if (filter.unrsvpedOnly) items = items.filter(e => !e.rsvpStatus);
  // Sort by event date ascending (upcoming first); fall back to discoveredAt
  items = items.slice().sort((a, b) => (a.dateISO || a.discoveredAt || '').localeCompare(b.dateISO || b.discoveredAt || ''));
  return items;
}

// ── Scanning ──────────────────────────────────────────────────────────────

// Pull date out of /events/YYYY/MM/DD/slug
function dateFromEventUrl(eventUrl) {
  const m = (eventUrl || '').match(/\/events\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Extract event hits from the currently-loaded /search/events page.
async function scrapeSearchResultsPage(page, term) {
  return await page.$$eval('a[href*="/events/"]', (links, args) => {
    const seen = new Set();
    const out = [];
    for (const link of links) {
      const href = (link.getAttribute('href') || '').replace(/[?#].*$/, '');
      if (!/^\/events\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const eventUrl = new URL(href, location.origin).toString();
      const heading = link.closest('h3') || link.closest('h2') || link;
      const title = (heading.textContent || link.textContent || '').trim().replace(/\s+/g, ' ');
      let container = link.closest('li, article, section, div');
      let organizer = null, organizerUrl = null, snippet = '', rawTime = null;
      if (container) {
        const userLink = Array.from(container.querySelectorAll('a[href]')).find(a => {
          const h = a.getAttribute('href') || '';
          return /^\/[^\/]+$/.test(h) && !h.startsWith('/events/') && !h.startsWith('/p/') && !h.startsWith('/groups/');
        });
        if (userLink) {
          organizer = (userLink.textContent || '').trim();
          organizerUrl = new URL(userLink.getAttribute('href'), location.origin).toString();
        }
        const timeEl = container.querySelector('time');
        if (timeEl) rawTime = (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent || '').trim();
        const para = container.querySelector('p');
        if (para) snippet = (para.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240);
      }
      out.push({ eventUrl, title, organizer, organizerUrl, snippet, rawTime, matchedTerm: args.term });
    }
    return out;
  }, { term });
}

// Paginated search. Walks /search/events?q=<term>&page=N until either:
//   - No new event URLs appear on a page (FetLife stopped paginating)
//   - Every event on a page is past the toDate (we've sailed past the window)
//   - maxPages cap (defensive against pagination loops)
async function scanSearchForEvents(page, term, opts = {}) {
  const { toDate, maxPages = 20, reporter } = opts;
  const seenUrls = new Set();
  const allHits = [];

  for (let p = 1; p <= maxPages; p++) {
    if (reporter) reporter.stage(`Searching "${term}" — page ${p}`, `${allHits.length} hits so far`);
    const url = `${FL_BASE}/search/events?q=${encodeURIComponent(term)}` + (p > 1 ? `&page=${p}` : '');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitOutCloudflare(page, 15000);
    await page.waitForTimeout(1200);
    // Content-aware session check on the first page only — if cookies were stale,
    // every later page would also be the login form and we'd "scan" 20 logged-out
    // pages returning zero hits. Fail fast on page 1 with a clear session error.
    if (p === 1) await checkLoggedIn(page);
    const hits = await scrapeSearchResultsPage(page, term);
    if (hits.length === 0) break;

    let addedOnPage = 0;
    for (const h of hits) {
      if (seenUrls.has(h.eventUrl)) continue;
      seenUrls.add(h.eventUrl);
      allHits.push(h);
      addedOnPage++;
    }
    if (addedOnPage === 0) break;

    // If we have a toDate and every event on this page is already beyond it,
    // we've walked past the user's window — stop paginating.
    if (toDate) {
      const allBeyond = hits.every(h => {
        const m = (h.eventUrl || '').match(/\/events\/(\d{4})\/(\d{2})\/(\d{2})\//);
        if (!m) return false;
        return `${m[1]}-${m[2]}-${m[3]}` > toDate;
      });
      if (allBeyond) break;
    }
  }
  return allHits;
}

/**
 * Fetch the user's existing FetLife RSVPs (across all statuses). Returns a Map of
 * eventUrl → status. Per-status tabs are queried in priority order so a "going"
 * RSVP wins over a later "maybe" entry if the unified list ever duplicates.
 *
 * Per project memory the unified /events/rsvps page is the authoritative list;
 * we also hit the per-status filtered URLs so we can populate the specific status,
 * falling back to "rsvped" for anything only the unified list surfaces.
 */
async function fetchUserRsvpedEvents(page) {
  const out = new Map();
  // Per-status fetches first so we capture the specific status; unified fills gaps.
  for (const status of ['going', 'maybe', 'interested']) {
    try {
      const url = `${FL_BASE}/events/rsvps?status=${status}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitOutCloudflare(page, 10000);
      await page.waitForTimeout(1200);
      const urls = await page.$$eval('a[href*="/events/"]', (links) => {
        const seen = new Set();
        const found = [];
        for (const l of links) {
          const href = (l.getAttribute('href') || '').replace(/[?#].*$/, '');
          if (!/^\/events\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i.test(href)) continue;
          const u = new URL(href, location.origin).toString();
          if (seen.has(u)) continue;
          seen.add(u);
          found.push(u);
        }
        return found;
      });
      for (const u of urls) {
        if (!out.has(u)) out.set(u, status);
      }
    } catch {}
  }
  // Unified pass to catch anything per-status missed (project memory: per-status partial)
  try {
    await page.goto(`${FL_BASE}/events/rsvps`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitOutCloudflare(page, 10000);
    await page.waitForTimeout(1200);
    const urls = await page.$$eval('a[href*="/events/"]', (links) => {
      const seen = new Set();
      const found = [];
      for (const l of links) {
        const href = (l.getAttribute('href') || '').replace(/[?#].*$/, '');
        if (!/^\/events\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i.test(href)) continue;
        const u = new URL(href, location.origin).toString();
        if (seen.has(u)) continue;
        seen.add(u);
        found.push(u);
      }
      return found;
    });
    for (const u of urls) {
      if (!out.has(u)) out.set(u, 'rsvped');
    }
  } catch {}
  return out;
}

/**
 * Verify a candidate event is actually held at the configured venue by fetching the
 * event page and matching its location-section text against venueAddress + searchTerms.
 * Returns { matched: bool, locationText: string|null } so non-matches can be logged.
 */
async function verifyEventLocation(page, eventUrl, matchTokens) {
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page, 10000);
  await page.waitForTimeout(800);

  const locationText = await page.evaluate(() => {
    // FetLife's location section sits as a venue-name + address-paragraph block. The
    // address paragraph reliably contains the text "map" (the inline map link). Find
    // that, then collect its enclosing container's text — that's the location.
    const addrParas = Array.from(document.querySelectorAll('p')).filter(p => {
      const t = (p.textContent || '').trim();
      return /map$/i.test(t) && /\d+\s+\w/.test(t) && t.length < 400;
    });
    if (!addrParas.length) {
      // Fall back: any element whose text matches an address-like pattern
      const all = Array.from(document.querySelectorAll('p, div'));
      const candidates = all.filter(el => {
        const t = (el.textContent || '').trim();
        return /\d+\s+[A-Z][a-zA-Z]+\s+(Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Place|Pl\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?)/i.test(t) && t.length < 400;
      });
      if (!candidates.length) return null;
      candidates.sort((a, b) => a.textContent.length - b.textContent.length);
      return (candidates[0].parentElement || candidates[0]).textContent.replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    // Use the address paragraph + its parent (which usually has the venue name above it)
    addrParas.sort((a, b) => a.textContent.length - b.textContent.length);
    const para = addrParas[0];
    const parent = para.parentElement || para;
    return parent.textContent.replace(/\s+/g, ' ').trim().slice(0, 500);
  });

  if (!locationText) return { matched: false, locationText: null };

  const haystack = locationText.toLowerCase();
  for (const token of matchTokens) {
    const t = token.trim().toLowerCase();
    if (!t || t.length < 3) continue;
    // Word-boundary match so "Crucible" doesn't accidentally match "Camp Crucible" — wait,
    // that's actually the opposite issue. We WANT broad matches on individual tokens, so a
    // simple .includes() is fine here; the venueAddress tokens are specific enough.
    if (haystack.includes(t)) return { matched: true, locationText, matchedToken: token };
  }
  return { matched: false, locationText };
}

async function scanCityEvents(page, cityUrl) {
  await page.goto(cityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page, 15000);
  await page.waitForTimeout(1500);

  return await page.$$eval('a[href*="/events/"][href*="/20"]', (anchors) => {
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = (a.getAttribute('href') || '').replace(/[?#].*$/, '');
      if (!/\/events\/\d{4}\/\d{2}\/\d{2}\//.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const eventUrl = new URL(href, location.origin).toString();
      const title = (a.getAttribute('title') || a.textContent || '').trim();
      out.push({ eventUrl, title, organizer: null, organizerUrl: null, snippet: '', rawTime: null, matchedTerm: '(city)' });
    }
    return out;
  });
}

export async function runScan(accountId, opts = {}) {
  const reporter = opts.reporter || null;
  const config = (await readStore(accountId)).config;
  const terms = (opts.searchTerms && opts.searchTerms.length) ? opts.searchTerms : (config.searchTerms || []);
  const cityUrl = opts.cityUrl || config.cityUrl || '';
  if (!terms.length && !cityUrl) {
    throw new Error('Configure at least one search term or a city URL before scanning.');
  }

  // Date range: opts override config override (today → end of next year).
  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultTo = new Date(new Date().getFullYear() + 1, 11, 31).toISOString().slice(0, 10);
  const fromIso = opts.fromDate || config.scanFromDate || todayIso;
  const toIso = opts.toDate || config.scanToDate || defaultTo;
  if (fromIso > toIso) throw new Error('fromDate must be <= toDate');

  const errors = [];
  const allFound = [];

  if (reporter) reporter.stage('Launching browser', `${terms.length} term(s)${cityUrl ? ' + city scan' : ''}`);
  const { browser, context } = await launchWithCookies(accountId, { headless: true });
  const page = await context.newPage();

  try {
    let termIdx = 0;
    for (const term of terms) {
      termIdx++;
      try {
        if (reporter) reporter.stage(`Searching term ${termIdx}/${terms.length}: "${term}"`);
        const hits = await scanSearchForEvents(page, term, { toDate: toIso, reporter });
        allFound.push(...hits);
      } catch (err) {
        errors.push({ stage: `term:${term}`, error: err.message });
      }
    }
    if (cityUrl) {
      try {
        if (reporter) reporter.stage('Scanning city events page');
        const hits = await scanCityEvents(page, cityUrl);
        allFound.push(...hits);
      } catch (err) {
        errors.push({ stage: 'cityUrl', error: err.message });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Normalize: date from URL, dedupe by eventUrl
  const byUrl = new Map();
  for (const e of allFound) {
    if (!e.eventUrl) continue;
    if (byUrl.has(e.eventUrl)) continue;
    byUrl.set(e.eventUrl, { ...e, dateISO: dateFromEventUrl(e.eventUrl) });
  }

  // Apply the user-chosen date range: events must be on/after fromIso AND
  // on/before toIso. Falls back to (today, end-of-next-year) when unset.
  // Events without a parseable date pass through so a verification fetch can
  // attempt to recover the date downstream.
  const futureOnly = Array.from(byUrl.values()).filter(e => {
    if (!e.dateISO) return true;
    return e.dateISO >= fromIso && e.dateISO <= toIso;
  });

  // Verification pass: fetch each candidate's event page and confirm the location
  // section actually mentions the configured venue. This is what makes scans
  // surface only events held AT the venue, not anything keyword-mentioning it.
  const matchTokens = [
    ...(config.venueAddress ? [config.venueAddress] : []),
    ...(terms || []),
  ];
  // Reuse the same page (which is still open) for verification fetches
  if (reporter) reporter.stage(`Verifying ${futureOnly.length} candidate event(s)`, 'opening verification browser');
  const { browser: vbrowser, context: vcontext } = await launchWithCookies(accountId, { headless: true });
  const vpage = await vcontext.newPage();
  const verified = [];
  let rejected = 0;
  let userRsvps = new Map();
  try {
    // Fetch the user's actual RSVP list once per scan so we can mark verified
    // events with their real current FetLife state (so the "Not yet RSVPed"
    // filter doesn't show events the user has already RSVPed to directly).
    if (reporter) reporter.stage('Fetching your existing RSVPs');
    userRsvps = await fetchUserRsvpedEvents(vpage);

    let vIdx = 0;
    for (const e of futureOnly) {
      vIdx++;
      try {
        if (reporter) reporter.stage(`Verifying location ${vIdx}/${futureOnly.length}`, e.title || e.eventUrl);
        const v = await verifyEventLocation(vpage, e.eventUrl, matchTokens);
        if (v.matched) {
          const fetlifeStatus = userRsvps.get(e.eventUrl);
          verified.push({
            ...e,
            locationText: v.locationText,
            matchedToken: v.matchedToken,
            // FetLife's status is the source of truth; overwrite any local rsvpStatus
            rsvpStatus: fetlifeStatus || null,
          });
        } else {
          rejected++;
        }
      } catch (err) {
        errors.push({ stage: `verify:${e.eventUrl}`, error: err.message });
      }
    }
  } finally {
    await vbrowser.close().catch(() => {});
  }

  // Clear-on-scan + merge: serialized so a concurrent RSVP click can't be clobbered
  // by the scan's writeStore (or vice versa). The mutex only wraps the final read+
  // write — the long-running Playwright scan above runs unlocked so other ops on
  // the same account aren't blocked for minutes.
  let added = 0;
  let refreshed = 0;
  let pruned = 0;
  let storeTotal = 0;
  await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const preserved = store.events.filter(e => e.rsvpStatus || e.dismissed);
    const existing = new Map(preserved.map(e => [e.eventUrl, e]));
    const nowIso = new Date().toISOString();
    for (const e of verified) {
      if (existing.has(e.eventUrl)) {
        const prev = existing.get(e.eventUrl);
        // Fresh FetLife rsvpStatus wins; preserve user's dismissed flag
        Object.assign(prev, e, { dismissed: prev.dismissed });
        refreshed++;
      } else {
        existing.set(e.eventUrl, { ...e, discoveredAt: nowIso, dismissed: false });
        added++;
      }
    }

    // Also drop existing events whose date is now in the past (cleanup)
    for (const [url, e] of existing) {
      if (e.dateISO && e.dateISO < todayIso) {
        existing.delete(url);
        pruned++;
      }
    }

    store.events = Array.from(existing.values());
    store.config = config;
    store.lastScanAt = nowIso;
    await writeStore(accountId, store);
    storeTotal = store.events.length;
  });

  return {
    added,
    refreshed,
    pruned,
    rejected,
    candidates: futureOnly.length,
    verified: verified.length,
    total: storeTotal,
    errors,
    scannedTerms: terms,
    cityScanned: !!cityUrl,
  };
}

// ── RSVP ──────────────────────────────────────────────────────────────────

// Text variants FetLife actually renders for each RSVP control. "Interested In" is the
// live label even though we store the status as 'interested' — matching the same
// expansion that unRsvp already uses below.
const RSVP_BUTTON_LABELS = {
  going:      ['Going'],
  maybe:      ['Maybe'],
  interested: ['Interested In', 'Interested'],
};

/**
 * Set the user's RSVP status on a FetLife event by navigating to the page and
 * clicking the appropriate button via Playwright. status = 'going' | 'maybe' | 'interested'.
 *
 * We DOM-query for buttons/anchors whose exact text content matches one of the known
 * label variants for the target status. The earlier has-text() approach failed because
 * FetLife wraps the label in inner spans and uses "Interested In" (not "Interested"),
 * so a plain Playwright selector missed it. Querying with evaluate lets us also pick
 * the visible/clickable element if there are multiple matches (modal vs. inline).
 */
export async function setRsvp(accountId, eventUrl, status) {
  if (!RSVP_BUTTON_LABELS[status]) throw new Error(`status must be one of going/maybe/interested, got ${status}`);
  if (!/^https:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\//.test(eventUrl)) {
    throw new Error('eventUrl must be a FetLife /events/YYYY/MM/DD/... URL');
  }

  const { browser, context } = await launchWithCookies(accountId, { headless: true });
  const page = await context.newPage();
  let clicked = false;
  let finalUrl = null;
  try {
    // 60s navigation timeout — NordVPN routing to fetlife.com sometimes pushes the
    // initial GET past the default 30s, which surfaced as silent button "no-ops".
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitOutCloudflare(page, 15000);
    await page.waitForTimeout(1500);
    // Stale-session check: a logged-out browser sees the login form at /events/...
    // and our "click Going" would then fail with the very confusing "no RSVP button
    // found" error. Surface the real cause instead.
    await checkLoggedIn(page);

    const labels = RSVP_BUTTON_LABELS[status];

    // Locate + click via DOM evaluation so we can normalize whitespace and accept
    // either <button> or <a role="button"> with the label in any descendant text node.
    clicked = await page.evaluate((wanted) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const targets = wanted.map(norm);
      const candidates = Array.from(document.querySelectorAll('button, a[role="button"], a'));
      for (const el of candidates) {
        const txt = norm(el.textContent);
        if (!txt) continue;
        // Exact-match the label after whitespace normalization (avoids matching
        // "Going to a fish-fry" or other prose anchors that happen to contain the word).
        if (!targets.includes(txt)) continue;
        // Skip hidden / display:none elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
      return false;
    }, labels);

    if (!clicked) {
      // Fallback to Playwright selectors for completeness (covers cases where the
      // element is fine but disabled while a JS handler attaches).
      for (const label of labels) {
        for (const sel of [`button:has-text("${label}")`, `a:has-text("${label}")`, `button[aria-label*="${label}" i]`]) {
          try { await page.click(sel, { timeout: 3000 }); clicked = true; break; } catch {}
        }
        if (clicked) break;
      }
    }
    if (!clicked) throw new Error(`Could not find a "${status}" RSVP button on the event page`);

    // Brief wait for the click to register / page state to update
    await page.waitForTimeout(2000);
    finalUrl = page.url();
  } finally {
    await browser.close().catch(() => {});
  }

  // Update the stored event's RSVP state under the mutex so a concurrent scan
  // or dismiss on the same account can't race the write.
  let event = null;
  await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    event = store.events.find(e => e.eventUrl === eventUrl);
    if (event) {
      event.rsvpStatus = status;
      event.rsvpUpdatedAt = new Date().toISOString();
      await writeStore(accountId, store);
    }
  });

  return { success: true, status, eventUrl, finalUrl, event: event || null };
}

export async function dismissEvent(accountId, eventUrl, dismissed = true) {
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const event = store.events.find(e => e.eventUrl === eventUrl);
    if (!event) throw new Error('Event not in store');
    event.dismissed = dismissed;
    await writeStore(accountId, store);
    return event;
  });
}

/**
 * Mark an event URL as hidden-from-calendar for the account. Stored in account
 * meta (via updateAccountFields) so the dashboard's loadAllOrganizedEvents can
 * filter the event out without needing a separate venue-events fetch. Hidden
 * events stay in venue-events store so the user can still un-hide from there.
 */
export async function setHiddenFromCalendar(accountId, eventUrl, hidden = true) {
  const acct = await getAccount(accountId);
  if (!acct) throw new Error('Unknown account');
  const list = Array.isArray(acct.hiddenCalendarEvents) ? acct.hiddenCalendarEvents.slice() : [];
  const idx = list.indexOf(eventUrl);
  if (hidden && idx === -1) list.push(eventUrl);
  if (!hidden && idx !== -1) list.splice(idx, 1);
  await updateAccountFields(accountId, { hiddenCalendarEvents: list.length ? list : null });
  return { hidden, list };
}

/**
 * Remove the user's RSVP on FetLife by navigating to the event and toggling off
 * the active button or clicking a Decline/Not-going option. Best effort — FetLife's
 * UI varies and there's no canonical Decline element on every event page.
 */
export async function unRsvp(accountId, eventUrl) {
  if (!/^https:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\//.test(eventUrl)) {
    throw new Error('eventUrl must be a FetLife /events/YYYY/MM/DD/... URL');
  }
  const { browser, context } = await launchWithCookies(accountId, { headless: true });
  const page = await context.newPage();
  let clicked = false;
  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitOutCloudflare(page, 15000);
    await page.waitForTimeout(1500);
    await checkLoggedIn(page);

    // Strategy 1: explicit Decline / Not Going / Cancel RSVP control
    for (const sel of [
      'button:has-text("Decline")',
      'button:has-text("Not Going")',
      'button:has-text("Cancel RSVP")',
      'button:has-text("Remove RSVP")',
      'a:has-text("Decline")',
      'a:has-text("Not Going")',
    ]) {
      try { await page.click(sel, { timeout: 2500 }); clicked = true; break; } catch {}
    }

    // Strategy 2: detect which Going/Maybe/Interested button is "active" and click
    // it to toggle off. FetLife marks the active one with a lighter border class.
    if (!clicked) {
      const activeLabel = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const labels = ['Going', 'Maybe', 'Interested In', 'Interested'];
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          if (!labels.some(l => txt === l || txt.toLowerCase() === l.toLowerCase())) continue;
          const cls = b.className || '';
          // Active state markers — bg-transparent is unselected, lighter border is selected
          if (/border-gray-500|text-gray-100/.test(cls) && !/bg-transparent/.test(cls)) {
            return txt;
          }
        }
        return null;
      });
      if (activeLabel) {
        try {
          await page.click(`button:has-text("${activeLabel}")`, { timeout: 3000 });
          clicked = true;
        } catch {}
      }
    }
    if (!clicked) throw new Error('Could not find any way to un-RSVP on this event page (no Decline button + no active Going/Maybe/Interested detected). Try un-RSVPing on FetLife directly.');
    await page.waitForTimeout(2000);
  } finally {
    await browser.close().catch(() => {});
  }

  // Clear the stored rsvpStatus under the mutex (symmetric with setRsvp).
  await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const event = store.events.find(e => e.eventUrl === eventUrl);
    if (event) {
      event.rsvpStatus = null;
      event.rsvpUpdatedAt = new Date().toISOString();
      await writeStore(accountId, store);
    }
  });
  return { success: true, eventUrl };
}
