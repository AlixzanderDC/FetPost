/**
 * Tracked events: a per-account list of FetLife event URLs we want to scrape RSVPs for.
 * Two ways URLs enter the list:
 *   1. Auto — scheduleGroupEventBatch calls addTrackedEvents() when posting for an event
 *   2. Manual — user pastes URLs in the Insights UI
 *
 * Storage: data/events/<accountId>-tracked.json — flat array of records.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { refreshEventMetrics } from './metrics.js';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');

function trackedFile(accountId) {
  return path.join(EVENTS_DIR, `${accountId}-tracked.json`);
}

function urlDateFromEventUrl(url) {
  const m = (url || '').match(/\/events\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function normalizeEventUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  // Strip query / fragment / trailing slash. Canonical: https://fetlife.com/events/YYYY/MM/DD/slug
  const m = trimmed.match(/(https?:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\/[^\s?#/]+)/);
  return m ? m[1].replace(/^http:/, 'https:') : null;
}

export async function listTrackedEvents(accountId) {
  return await readJsonStrict(trackedFile(accountId), {
    defaultIfMissing: [],
    label: `events/${accountId}-tracked.json`,
  });
}

async function saveTrackedEvents(accountId, list) {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  await writeJsonAtomic(trackedFile(accountId), list);
}

export async function addTrackedEvents(accountId, urls, source = 'manual') {
  const existing = await listTrackedEvents(accountId);
  const existingUrls = new Set(existing.map(e => e.url));
  let added = 0;
  let skipped = 0;
  const skippedInvalid = [];
  for (const rawUrl of (urls || [])) {
    const url = normalizeEventUrl(rawUrl);
    if (!url) { skipped++; skippedInvalid.push(rawUrl); continue; }
    if (existingUrls.has(url)) { skipped++; continue; }
    existing.push({
      url,
      urlDate: urlDateFromEventUrl(url),
      title: null,
      addedAt: new Date().toISOString(),
      source,
    });
    existingUrls.add(url);
    added++;
  }
  await saveTrackedEvents(accountId, existing);
  return { added, skipped, total: existing.length, invalidExamples: skippedInvalid.slice(0, 3) };
}

export async function removeTrackedEvent(accountId, url) {
  const existing = await listTrackedEvents(accountId);
  const filtered = existing.filter(e => e.url !== url);
  await saveTrackedEvents(accountId, filtered);
  return { removed: existing.length - filtered.length, total: filtered.length };
}

/**
 * Iterate tracked events for an account and scrape RSVPs for each. Long-running.
 * Snapshots are stored via metrics.js (same as on-demand refresh).
 * Stagger between events to avoid burst traffic.
 */
export async function refreshAllTrackedRsvps(accountId, opts = {}) {
  const { staggerMinMs = 25_000, staggerMaxMs = 55_000, maxPerRun = 200, onProgress } = opts;
  const events = await listTrackedEvents(accountId);
  const results = [];
  let i = 0;
  for (const event of events) {
    if (i >= maxPerRun) break;
    const eventKey = String(event.url).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);
    try {
      const snap = await refreshEventMetrics(accountId, eventKey, event.url);
      if (snap.title && !event.title) event.title = snap.title;
      results.push({ url: event.url, success: true, total: snap.total ?? null });
      console.log(`[tracked] ${accountId} ${i + 1}/${events.length}: ${event.url} → total=${snap.total}`);
    } catch (err) {
      results.push({ url: event.url, success: false, error: err.message });
      console.error(`[tracked] ${accountId} ${i + 1}/${events.length} FAILED ${event.url}: ${err.message}`);
    }
    if (onProgress) onProgress({ done: i + 1, total: events.length });
    i++;
    if (i < events.length && i < maxPerRun) {
      const delay = staggerMinMs + Math.floor(Math.random() * (staggerMaxMs - staggerMinMs));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  await saveTrackedEvents(accountId, events);
  return { processed: i, total: events.length, results };
}
