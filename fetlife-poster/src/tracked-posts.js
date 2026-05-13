/**
 * Tracked posts: a per-account list of FetLife post URLs we want to scrape engagement for
 * (loves, super loves, comments, views).
 *
 * Today this covers group cross-posts and events — both capture their final URL in poster.js.
 * Status/picture posts don't currently capture URLs so they're out of scope.
 *
 * Two ways URLs enter the list:
 *   1. Manual — user clicks "Track engagement" on a sent post in the UI
 *   2. Bulk paste — user pastes URLs in the Post Engagement insights view
 *
 * Storage: data/posts/<accountId>-tracked.json — flat array of records.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { refreshPostMetrics } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(__dirname, '..', 'data', 'posts');

function trackedFile(accountId) {
  return path.join(POSTS_DIR, `${accountId}-tracked.json`);
}

export function normalizePostUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  // Accept the URL patterns poster.js produces:
  //   /groups/<id>/group_posts/<id>  /groups/<id>/posts/<id>  /events/YYYY/MM/DD/<slug>  /users/<id>/posts/<id>
  const patterns = [
    /(https?:\/\/fetlife\.com\/groups\/\d+\/(?:group_posts|posts)\/\d+)/,
    /(https?:\/\/fetlife\.com\/events\/\d{4}\/\d{2}\/\d{2}\/[^\s?#/]+)/,
    /(https?:\/\/fetlife\.com\/users\/\d+\/posts\/\d+)/,
  ];
  for (const rx of patterns) {
    const m = trimmed.match(rx);
    if (m) return m[1].replace(/^http:/, 'https:');
  }
  return null;
}

function postIdFromUrl(url) {
  // Use a stable, filesystem-safe slug derived from the URL. Matches the safeKey() pattern
  // in metrics.js so snapshots from /metrics/post/refresh and tracked refresh share storage.
  return String(url).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);
}

export async function listTrackedPosts(accountId) {
  try {
    const raw = await fs.readFile(trackedFile(accountId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTrackedPosts(accountId, list) {
  await fs.mkdir(POSTS_DIR, { recursive: true });
  await fs.writeFile(trackedFile(accountId), JSON.stringify(list, null, 2));
}

/**
 * Add one or more post URLs to the tracked list.
 *   urls: array of FetLife post URLs (loose — we normalize)
 *   meta: optional shared metadata to attach to each new entry (e.g., {postId, title, sentAt})
 *         When tracking from the queue, pass the queue's postId so we can link back.
 */
export async function addTrackedPosts(accountId, urls, source = 'manual', meta = {}) {
  const existing = await listTrackedPosts(accountId);
  const existingUrls = new Set(existing.map(e => e.url));
  let added = 0;
  let skipped = 0;
  const skippedInvalid = [];
  for (const rawUrl of (urls || [])) {
    const url = normalizePostUrl(rawUrl);
    if (!url) { skipped++; skippedInvalid.push(rawUrl); continue; }
    if (existingUrls.has(url)) { skipped++; continue; }
    existing.push({
      url,
      postId: meta.postId || null,         // links back to queue.json entry, when known
      queuePostId: meta.postId || null,    // alias for clarity in UI
      title: meta.title || null,
      sentAt: meta.sentAt || null,
      addedAt: new Date().toISOString(),
      source,
    });
    existingUrls.add(url);
    added++;
  }
  await saveTrackedPosts(accountId, existing);
  return { added, skipped, total: existing.length, invalidExamples: skippedInvalid.slice(0, 3) };
}

export async function removeTrackedPost(accountId, url) {
  const existing = await listTrackedPosts(accountId);
  const filtered = existing.filter(e => e.url !== url);
  await saveTrackedPosts(accountId, filtered);
  return { removed: existing.length - filtered.length, total: filtered.length };
}

/**
 * Iterate tracked posts for an account and scrape engagement for each. Long-running.
 * Snapshots are appended via metrics.refreshPostMetrics, keyed by the URL slug.
 * Stagger between posts to avoid burst traffic — same pattern as refreshAllTrackedRsvps.
 */
export async function refreshAllTrackedPosts(accountId, opts = {}) {
  const { staggerMinMs = 25_000, staggerMaxMs = 55_000, maxPerRun = 200, onProgress } = opts;
  const posts = await listTrackedPosts(accountId);
  const results = [];
  let i = 0;
  for (const post of posts) {
    if (i >= maxPerRun) break;
    const postKey = postIdFromUrl(post.url);
    try {
      const snap = await refreshPostMetrics(accountId, postKey, post.url);
      if (snap.title && !post.title) post.title = snap.title;
      results.push({
        url: post.url, success: true,
        loves: snap.loves, superLoves: snap.superLoves, comments: snap.comments, views: snap.views,
      });
      console.log(`[tracked-posts] ${accountId} ${i + 1}/${posts.length}: ${post.url} → loves=${snap.loves} super=${snap.superLoves} comments=${snap.comments} views=${snap.views ?? 'n/a'}`);
    } catch (err) {
      results.push({ url: post.url, success: false, error: err.message });
      console.error(`[tracked-posts] ${accountId} ${i + 1}/${posts.length} FAILED ${post.url}: ${err.message}`);
    }
    if (onProgress) onProgress({ done: i + 1, total: posts.length });
    i++;
    if (i < posts.length && i < maxPerRun) {
      const delay = staggerMinMs + Math.floor(Math.random() * (staggerMaxMs - staggerMinMs));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  await saveTrackedPosts(accountId, posts);
  return { processed: i, total: posts.length, results };
}
