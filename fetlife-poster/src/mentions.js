import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare, checkLoggedIn } from './poster.js';
import { listAccounts } from './credentials.js';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

async function getOwnUsernames() {
  try {
    const accounts = await listAccounts();
    return new Set(accounts.map(a => a.username).filter(Boolean));
  } catch {
    return new Set();
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data', 'mentions');
const FL_BASE = 'https://fetlife.com';

const fileFor = (accountId) => path.join(DATA_DIR, encodeURIComponent(accountId) + '.json');

async function readStore(accountId) {
  return await readJsonStrict(fileFor(accountId), {
    defaultIfMissing: { mentions: [], config: { keywords: null } },
    label: `mentions/${accountId}.json`,
  });
}

async function writeStore(accountId, store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(fileFor(accountId), store);
}

function defaultKeywords(account) {
  const seeds = new Set();
  if (account?.groupName) seeds.add(account.groupName);
  if (account?.label) seeds.add(account.label);
  if (account?.accountId) seeds.add(account.accountId);
  // Also seed each multi-word value's first word (e.g. "Crucible Rendezvous" -> "Crucible")
  for (const v of Array.from(seeds)) {
    const first = String(v).split(/\s+/)[0];
    if (first && first.length >= 4) seeds.add(first);
  }
  return Array.from(seeds);
}

export async function getConfig(accountId, accountMeta = null) {
  const store = await readStore(accountId);
  if (!store.config.keywords) {
    store.config.keywords = defaultKeywords(accountMeta);
    await writeStore(accountId, store);
  }
  return store.config;
}

export async function setConfig(accountId, patch) {
  const store = await readStore(accountId);
  store.config = { ...store.config, ...patch };
  await writeStore(accountId, store);
  return store.config;
}

export async function listMentions(accountId, filter = {}) {
  const store = await readStore(accountId);
  let items = store.mentions;
  // Exclude posts authored by any of the user's own FetLife accounts —
  // those are self-promotion, not external "mentions of the event."
  // includeSelf=true bypass for the rare case of wanting to see them.
  if (!filter.includeSelf) {
    const own = await getOwnUsernames();
    items = items.filter(m => !own.has(m.author));
  }
  if (filter.since) {
    const s = new Date(filter.since).getTime();
    items = items.filter(m => new Date(m.timeISO || m.discoveredAt).getTime() >= s);
  }
  if (filter.until) {
    const u = new Date(filter.until).getTime();
    items = items.filter(m => new Date(m.timeISO || m.discoveredAt).getTime() <= u);
  }
  if (filter.savedOnly) items = items.filter(m => m.saved);
  if (filter.hideIgnored) items = items.filter(m => !m.ignored);
  // Newest first
  items = items.slice().sort((a, b) => (b.timeISO || b.discoveredAt).localeCompare(a.timeISO || a.discoveredAt));
  return items;
}

export async function setMentionState(accountId, postUrl, patch) {
  const store = await readStore(accountId);
  const item = store.mentions.find(m => m.postUrl === postUrl);
  if (!item) throw new Error('Mention not found: ' + postUrl);
  Object.assign(item, patch);
  await writeStore(accountId, store);
  return item;
}

// ── Scanning ──────────────────────────────────────────────────────────────

async function scanTagged(page, accountId) {
  await page.goto(`${FL_BASE}/notifications`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page, 15000);
  await page.waitForTimeout(1500);
  // Content-aware session check — catches the case where stale cookies got us a
  // login form at the requested URL (no redirect) and we'd otherwise silently
  // "scan" the login page and return zero mentions.
  await checkLoggedIn(page);

  // Each notification is a <section class="mb-1"> block. We extract any block whose
  // text body contains "mentioned you in" — the FetLife phrasing for @-tags.
  return await page.$$eval('section.mb-1', (sections) => {
    const out = [];
    for (const s of sections) {
      const textBlock = s.querySelector('p');
      if (!textBlock) continue;
      const text = (textBlock.textContent || '').trim();
      const mentionMatch = text.match(/mentioned you in (?:a )?(comment on (?:a )?status update|comment on (?:a )?group discussion|status update|writing|post)/i);
      if (!mentionMatch) continue;

      const authorLink = s.querySelector('a.font-bold[href^="/"]');
      const author = authorLink ? (authorLink.textContent || '').trim() : null;
      const authorHref = authorLink ? authorLink.getAttribute('href') : null;

      // The quote link with the post URL (titled with the truncated snippet)
      const ps = s.querySelectorAll('p');
      const quoteLink = ps[1]?.querySelector('a[href]') || s.querySelector('a[title*="@"]');
      const postHref = quoteLink ? quoteLink.getAttribute('href') : null;
      const snippet = quoteLink ? (quoteLink.getAttribute('title') || quoteLink.textContent || '').trim() : null;

      // Time: <time title="..." datetime="...">N days ago</time>
      const timeEl = s.querySelector('time');
      const datetime = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent || '') : null;

      let kind = 'mention-other';
      if (/comment on (?:a )?status update/i.test(mentionMatch[0])) kind = 'mention-status-comment';
      else if (/comment on (?:a )?group discussion/i.test(mentionMatch[0])) kind = 'mention-group-comment';
      else if (/status update/i.test(mentionMatch[0])) kind = 'mention-status';
      else if (/writing|post/i.test(mentionMatch[0])) kind = 'mention-writing';

      out.push({
        type: 'tagged',
        kind,
        author,
        authorUrl: authorHref ? new URL(authorHref, location.origin).toString() : null,
        postUrl: postHref ? new URL(postHref, location.origin).toString() : null,
        snippet,
        rawTime: datetime,
      });
    }
    return out;
  });
}

async function scanSearch(page, keyword, kind) {
  // kind = 'writings' or 'statuses'
  // FetLife's search doesn't honor quoted phrases — it always returns loose hits.
  // We treat EVERY keyword as exact-phrase by default (post-filter below). Surrounding
  // double quotes are stripped if present (legacy syntax; harmless).
  const phrase = (keyword.length >= 2 && keyword.startsWith('"') && keyword.endsWith('"'))
    ? keyword.slice(1, -1)
    : keyword;
  const url = `${FL_BASE}/search/${kind}?q=${encodeURIComponent(phrase)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page, 15000);
  await page.waitForTimeout(1500);

  const results = await page.$$eval('article', (articles, args) => {
    const out = [];
    for (const a of articles) {
      // Primary link is usually the post/status title or first-child anchor pointing at /author/posts/ID or /author/s/ID
      const links = Array.from(a.querySelectorAll('a[href]'));
      const postLink = links.find(l => /\/(posts|s)\/\d+/.test(l.getAttribute('href') || ''));
      if (!postLink) continue;
      let postHref = postLink.getAttribute('href');
      // Strip the search-tracking query params (?ref=, ?sp=) for canonical URL
      postHref = postHref.replace(/[?#].*$/, '');

      // Author: fall back to extracting from the post URL itself (/<author>/posts/N or /<author>/s/N)
      // since the on-page user-profile link selector is brittle across FetLife search layouts.
      const urlAuthorMatch = postHref.match(/^\/([^\/]+)\/(?:posts|s)\//);
      const author = urlAuthorMatch ? urlAuthorMatch[1] : null;
      const authorHref = author ? '/' + author : null;

      // Title: first <h3> within the article, or the post link's text
      const titleEl = a.querySelector('h3') || postLink;
      const title = (titleEl.textContent || '').trim();

      // Snippet: paragraph below the title, often <p> with body text
      let snippet = '';
      const para = a.querySelector('p');
      if (para) snippet = (para.textContent || '').trim();

      // Time
      const timeEl = a.querySelector('time');
      const datetime = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent || '') : null;

      out.push({
        type: 'keyword',
        kind: args.kind === 'writings' ? 'writing' : 'status',
        matchedKeyword: args.keyword,
        author,
        authorUrl: authorHref ? new URL(authorHref, location.origin).toString() : null,
        postUrl: new URL(postHref, location.origin).toString(),
        title,
        snippet,
        rawTime: datetime,
      });
    }
    return out;
  }, { keyword, kind });

  // Always exact-phrase: keep only results whose title/snippet contains the phrase.
  const needle = phrase.toLowerCase();
  return results.filter(r => {
    const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
    return text.includes(needle);
  });
}

function parseRawTime(rawTime) {
  if (!rawTime) return null;
  // FetLife uses formats like "Monday, June 1, 2026 at 3:34 PM" in title attrs,
  // or ISO datetime attrs, or "N days ago" text.
  // Try ISO first, then full datetime.
  const isoMatch = String(rawTime).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (isoMatch) {
    const t = new Date(isoMatch[0]);
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  const t = new Date(rawTime);
  if (!isNaN(t.getTime())) return t.toISOString();
  return null;
}

function inDateRange(iso, sinceIso, untilIso) {
  if (!iso) return true; // keep undated items (rare)
  const t = new Date(iso).getTime();
  if (sinceIso && t < new Date(sinceIso).getTime()) return false;
  if (untilIso && t > new Date(untilIso).getTime()) return false;
  return true;
}

/**
 * Run a scan against FetLife for an account.
 * opts: { since, until, keywords, includeTagged=true, includeKeywords=true }
 * Returns: { added, duplicates, total, errors, tagged, keywordHits }
 */
export async function runScan(accountId, opts = {}) {
  const { since, until, keywords, includeTagged = true, includeKeywords = true } = opts;
  const config = (await readStore(accountId)).config;
  const kws = (keywords && keywords.length) ? keywords : (config.keywords || []);

  const errors = [];
  let tagged = [];
  const keywordHits = [];

  const { browser, context } = await launchWithCookies(accountId, { headless: true });
  const page = await context.newPage();

  try {
    if (includeTagged) {
      try {
        tagged = await scanTagged(page, accountId);
      } catch (err) {
        errors.push({ stage: 'tagged', error: err.message });
      }
    }
    if (includeKeywords && kws.length) {
      for (const kw of kws) {
        for (const kind of ['writings', 'statuses']) {
          try {
            const results = await scanSearch(page, kw, kind);
            keywordHits.push(...results);
          } catch (err) {
            errors.push({ stage: `keyword:${kw}:${kind}`, error: err.message });
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Normalize timestamps
  const allRaw = [...tagged, ...keywordHits].map(m => ({
    ...m,
    timeISO: parseRawTime(m.rawTime),
  }));

  // Filter by date range AND drop self-posts (own accounts).
  const own = await getOwnUsernames();
  const inRange = allRaw.filter(m =>
    inDateRange(m.timeISO, since, until) && !own.has(m.author)
  );

  // Clear-on-scan: each scan starts from a fresh slate (drops unreviewed + ignored
  // from prior scans) but PRESERVES anything the user has explicitly Saved — those
  // are kept marketing material and would be painful to lose. Saved items that
  // re-surface in the new scan will dedupe back into themselves cleanly.
  const store = await readStore(accountId);
  const preserved = store.mentions.filter(m => m.saved);
  const byUrl = new Map(preserved.map(m => [m.postUrl, m]));
  let added = 0;
  let duplicates = 0;
  const nowIso = new Date().toISOString();
  for (const m of inRange) {
    if (!m.postUrl) continue;
    if (byUrl.has(m.postUrl)) {
      duplicates++;
      // Refresh snippet/time if previously missing
      const existing = byUrl.get(m.postUrl);
      if (!existing.snippet && m.snippet) existing.snippet = m.snippet;
      if (!existing.timeISO && m.timeISO) existing.timeISO = m.timeISO;
      continue;
    }
    byUrl.set(m.postUrl, {
      ...m,
      discoveredAt: nowIso,
      saved: false,
      ignored: false,
    });
    added++;
  }
  store.mentions = Array.from(byUrl.values());
  store.config = config;
  store.lastScanAt = nowIso;
  await writeStore(accountId, store);

  return {
    added,
    duplicates,
    total: store.mentions.length,
    errors,
    taggedCount: tagged.length,
    keywordCount: keywordHits.length,
    scannedKeywords: kws,
  };
}
