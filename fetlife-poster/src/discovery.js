/**
 * Scrapes the logged-in account's joined groups and organized events.
 * Group routes need non-headless Chrome to bypass Cloudflare; we always warm
 * /home first to settle CF clearance before navigating into /groups or /events.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchWithCookies, waitOutCloudflare } from './poster.js';
import { autoRefreshCookies } from './extractor.js';
import { noopReporter } from './progress.js';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FL_BASE = 'https://fetlife.com';
const GROUPS_DIR = path.join(__dirname, '..', 'data', 'groups');
const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');

async function withSession(accountId, fn, { reporter = noopReporter() } = {}) {
  // Try the session once with current cookies. If FetLife redirects us to /sign_in,
  // attempt a single passive headless refresh and retry. Headless can extend a still-valid
  // session but cannot recover a fully-expired one — for that the user has to refresh
  // manually via VNC. We throw a clearer error in that case.
  for (let attempt = 1; attempt <= 2; attempt++) {
    reporter.stage('Opening browser session', attempt > 1 ? `retry ${attempt}` : null);
    const { browser, context } = await launchWithCookies(accountId, { headless: false });
    let page;
    try {
      page = await context.newPage();
      reporter.stage('Bypassing Cloudflare on /home');
      await page.goto(`${FL_BASE}/home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      if (page.url().includes('/login') || page.url().includes('/sign_in')) {
        await browser.close().catch(() => {});
        if (attempt === 1) {
          reporter.stage('Session expired — attempting headless cookie refresh');
          const refreshed = await autoRefreshCookies(accountId);
          if (refreshed) { reporter.done('refreshed'); continue; }
        }
        throw new Error(`Not logged in for ${accountId} — headless refresh failed, manual VNC refresh needed`);
      }
      reporter.done();
      const result = await fn(page, reporter);
      await browser.close().catch(() => {});
      return result;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
}

// ── Joined groups ─────────────────────────────────────────────────────────────

// Parse every /groups/<id> anchor visible on the current page into a deduped
// {id, name, url} list. Skips /group_posts comment links and untexted anchors.
async function scrapeGroupAnchors(page) {
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
}

export async function listJoinedGroups(accountId, opts = {}) {
  return withSession(accountId, async (page, reporter) => {
    // FetLife's main-nav "Groups" page (https://fetlife.com/groups) is the
    // complete list of every group the logged-in account has joined, sorted
    // alphabetically. (The profile-tab /<nickname>/groups page only shows
    // groups the account owns/admins — verified on CrucibleCon: 1 vs 60.
    // The /home/groups page is sorted by recent activity and partial.)
    reporter.stage('Loading /groups');
    await page.goto(`${FL_BASE}/groups`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Move cursor to a safe spot before wheel events fire — same precaution as
    // the past-events scroller (otherwise wheel may not register without click).
    try { await page.mouse.move(400, 400); } catch {}

    reporter.stage('Scrolling to load all groups');
    let lastCount = 0;
    let stable = 0;
    const maxIterations = 80;
    for (let i = 0; i < maxIterations; i++) {
      if (!page.url().includes('/groups')) {
        console.log(`[discovery] URL drift detected: ${page.url()} — aborting groups scroll`);
        break;
      }
      await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href*="/groups/"]');
        if (anchors.length) anchors[anchors.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(400);
      try { await page.mouse.wheel(0, 2000); } catch {}
      await page.waitForTimeout(1500);

      const count = await page.$$eval('a[href*="/groups/"]', (els) =>
        els.filter(a => /^\/groups\/\d+(\/?($|\?))/.test(a.getAttribute('href') || ''))
           .filter(a => !(a.getAttribute('href') || '').includes('/group_posts'))
           .length
      );
      console.log(`[discovery] Joined-groups scroll ${i + 1}: ${count} group anchors`);
      if (count === lastCount) {
        stable++;
        if (stable >= 4) break;
      } else {
        stable = 0;
        lastCount = count;
      }
    }
    console.log(`[discovery] Joined-groups scrape converged at ${lastCount} anchors`);

    reporter.stage('Parsing group cards');
    const groups = await scrapeGroupAnchors(page);
    reporter.done(`${groups.length} group(s)`);
    return groups;
  }, opts);
}

export async function refreshGroupsForAccount(accountId, opts = {}) {
  const reporter = opts.reporter || noopReporter();
  const groups = await listJoinedGroups(accountId, opts);
  reporter.stage('Saving cached groups', `${groups.length} group(s)`);
  await fs.mkdir(GROUPS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), groups };
  await writeJsonAtomic(path.join(GROUPS_DIR, `${accountId}.json`), out);
  return out;
}

export async function readCachedGroups(accountId) {
  return await readJsonStrict(path.join(GROUPS_DIR, `${accountId}.json`), {
    defaultIfMissing: null,
    label: `groups/${accountId}.json`,
  });
}

// ── Group rules (sticky / pinned post requirements) ─────────────────────────
// For each joined group we scrape the group page's description + any pinned
// discussion, store the raw text, and run a conservative regex parser to surface
// concrete post requirements (required title prefix, max title length, banned
// content). The UI uses these to warn the operator before they cross-post into
// a group whose mods will reject the title.
//
// Storage: data/group-rules/<accountId>.json
//   { accountId, fetchedAt, groups: [{id, name, fetchedAt, rawText, rules: [...]}] }
//
// Rule shape: { kind: 'titlePrefix'|'titleMaxLen'|'titleMustInclude'|'banPhrase'|'note',
//               value: <varies>, sourceSnippet: '...' }
const GROUP_RULES_DIR = path.join(__dirname, '..', 'data', 'group-rules');

export async function readGroupRules(accountId) {
  return await readJsonStrict(path.join(GROUP_RULES_DIR, `${accountId}.json`), {
    defaultIfMissing: null,
    label: `group-rules/${accountId}.json`,
  });
}

async function writeGroupRules(accountId, payload) {
  await fs.mkdir(GROUP_RULES_DIR, { recursive: true });
  await writeJsonAtomic(path.join(GROUP_RULES_DIR, `${accountId}.json`), payload);
}

// Pure regex parser. Conservative on purpose — emits only high-confidence rules
// because a false-positive rule (e.g. "title must start with [DC]" when the group
// doesn't actually require it) would block legit posts. Each rule keeps a
// sourceSnippet so the operator can verify what we extracted.
export function extractRules(rawText) {
  if (!rawText) return [];
  const text = String(rawText).replace(/\r\n?/g, '\n');
  const rules = [];
  const seen = new Set();
  const push = (rule) => {
    const key = rule.kind + '|' + JSON.stringify(rule.value);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };

  // Title prefix: any [TAG]-shaped bracketed token whose surrounding 200-char
  // context contains BOTH a title/prefix keyword AND a directive verb. This is
  // forgiving enough to catch:
  //   "Title must start with [DC]"
  //   "All posts must be prefixed with [FREE]"
  //   "Please tag your post with [Event] in the title"
  //   "Posts not prefixed with [WTB] will be removed"
  // …while still requiring strong evidence of rule-intent so an offhand
  // "[example]" in a description doesn't get hoisted as a prefix requirement.
  for (const m of text.matchAll(/([\[\(]([A-Z][A-Z0-9 \/\-\.]{1,30})[\]\)])/g)) {
    const tag = m[1];
    const idx = m.index || 0;
    const ctx = text.slice(Math.max(0, idx - 120), Math.min(text.length, idx + tag.length + 120));
    const hasTitleWord = /\b(title|prefix|tag|post[s]? title|begin(?:ning)?|start(?:s|ed|ing)?)\b/i.test(ctx);
    const hasDirective = /\b(?:must|should|need(?:s|ed)?|please|require(?:d|s)?|expect(?:ed)?|will be|are required|begin|start)\b/i.test(ctx);
    if (hasTitleWord && hasDirective) {
      push({ kind: 'titlePrefix', value: tag, sourceSnippet: ctx.replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
  }
  // Specific "<word> must (start|begin|be prefixed) with <TAG>" — narrower,
  // higher confidence, no bracket required (catches uppercase-letter tags
  // without brackets like "DC-Title" or "FREE PARTY").
  for (const m of text.matchAll(/(?:title|post(?:s)?|every (?:title|post))[^.\n]{0,40}(?:must|should|need(?:s)? to|has to|please|are required to)[^.\n]{0,30}(?:start|begin|be prefix(?:ed)?|preface(?:d)?|tag(?:ged)?)[^.\n]{0,15}(?:with|by)\s*[:\-]?\s*([\[\(]?[A-Z][A-Z0-9 \/\-]{1,30}[\]\)]?)/gi)) {
    const tag = m[1].trim();
    if (tag.length >= 2 && tag.length <= 32) {
      push({ kind: 'titlePrefix', value: tag, sourceSnippet: m[0].replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
  }

  // Title max length: "title must be (under|max|no more than|at most) N (chars|characters)"
  for (const m of text.matchAll(/title[^\n]{0,80}(?:under|max(?:imum)?|no more than|at most|less than|<=|≤)\s*(\d{2,3})\s*(?:char|character)/gi)) {
    const n = parseInt(m[1], 10);
    if (n >= 10 && n <= 300) push({ kind: 'titleMaxLen', value: n, sourceSnippet: m[0].slice(0, 160) });
  }

  // Title must include / mention: "title must include city", "include event date in title"
  for (const m of text.matchAll(/title[^\n]{0,60}(?:must|should|please)[^\n]{0,30}(?:include|contain|mention|list)\s+(?:the\s+)?([a-z][a-z\s]{2,30})/gi)) {
    const tok = m[1].replace(/\s+(in|of|on|the).*$/i, '').trim();
    if (tok.length >= 3 && tok.length <= 30) push({ kind: 'titleMustInclude', value: tok, sourceSnippet: m[0].slice(0, 160) });
  }

  // Banned phrases (low-precision; conservative list).
  // "no all caps" / "no profanity" / "no promo" / "no spam" — these are common.
  const banPatterns = [
    { re: /\bno\s+all[\s-]?caps\b/i, value: 'all caps' },
    { re: /\bno\s+profanity\b/i, value: 'profanity' },
    { re: /\bno\s+spam(?:ming)?\b/i, value: 'spam' },
    { re: /\bno\s+(?:cross[\s-]?post(?:ing)?|crossposts?)\b/i, value: 'cross-posts' },
  ];
  for (const { re, value } of banPatterns) {
    const m = re.exec(text);
    if (m) push({ kind: 'banPhrase', value, sourceSnippet: m[0] });
  }
  return rules;
}

// Validate a draft (title + body) against extracted rules. Returns an array of
// violations the UI can show inline. Each violation: {kind, message, ruleValue}.
export function validateAgainstRules(rules, { title = '', body = '' } = {}) {
  const out = [];
  for (const r of rules || []) {
    if (r.kind === 'titlePrefix') {
      const prefix = String(r.value).trim();
      if (!title.trim().toLowerCase().startsWith(prefix.toLowerCase())) {
        out.push({ kind: r.kind, message: `Title should start with "${prefix}"`, ruleValue: r.value });
      }
    } else if (r.kind === 'titleMaxLen') {
      if (title.length > r.value) {
        out.push({ kind: r.kind, message: `Title is ${title.length} chars; group caps at ${r.value}`, ruleValue: r.value });
      }
    } else if (r.kind === 'titleMustInclude') {
      const tok = String(r.value).toLowerCase();
      if (!title.toLowerCase().includes(tok)) {
        out.push({ kind: r.kind, message: `Title should mention "${r.value}"`, ruleValue: r.value });
      }
    } else if (r.kind === 'banPhrase') {
      const v = String(r.value).toLowerCase();
      const haystack = (title + ' ' + body).toLowerCase();
      // Special-case "all caps": flag if the title is mostly uppercase.
      if (v === 'all caps') {
        const letters = (title.match(/[A-Za-z]/g) || []).length;
        const upper = (title.match(/[A-Z]/g) || []).length;
        if (letters >= 6 && upper / letters > 0.7) {
          out.push({ kind: r.kind, message: 'Title is mostly all-caps — this group bans that', ruleValue: r.value });
        }
      } else if (haystack.includes(v)) {
        out.push({ kind: r.kind, message: `Contains banned phrase: "${r.value}"`, ruleValue: r.value });
      }
    }
  }
  return out;
}

// Scrape a single group's rules. The naive "read the group landing page"
// approach captured only sticky discussion TITLES (e.g. "The Crucible's Rules")
// because the actual rule TEXT lives one click deeper inside each pinned post.
// So this scraper:
//   1. Loads /groups/<id>, captures meta description + group name.
//   2. Finds the first ~5 anchors pointing at /group_posts/<n> whose surrounding
//      DOM text contains "Sticky" or "Pinned" — these are the pinned discussions.
//   3. Clicks into each one and grabs the largest visible text block (the post
//      body), capped per-discussion so a chatty welcome thread can't dominate.
//   4. Concatenates everything into rawText for the regex extractor.
async function scrapeOneGroupRules(page, groupId) {
  await page.goto(`${FL_BASE}/groups/${groupId}`, { waitUntil: 'domcontentloaded' });
  await waitOutCloudflare(page, 20000);
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const landing = await page.evaluate(() => {
    const name = ((document.querySelector('h1') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const meta = ((document.querySelector('meta[name="description"]') || {}).content || '').replace(/\s+/g, ' ').trim();
    // Find sticky discussion anchors. FetLife's URL layout:
    //   /groups/<id>/posts/<discussionId>          ← permalink (this is what stickies use)
    //   /groups/<id>/group_posts/<discussionId>    ← discussion-list slot (used by NEW threads, not stickies)
    // The sticky row's anchor wraps both the "Sticky" badge and the title text,
    // so the anchor's own textContent already contains the word "Sticky" — no
    // need to walk up the DOM looking for ancestor labels.
    const stickyAnchors = [];
    document.querySelectorAll('a[href*="/posts/"]').forEach(a => {
      const href = (a.getAttribute('href') || '').split('?')[0];
      // Strict shape: must be exactly /groups/N/posts/M with no extra path segments
      // (rules out /posts/new and anchors pointing elsewhere on FetLife).
      if (!/^\/groups\/\d+\/posts\/\d+\/?$/.test(href)) return;
      const text = (a.textContent || '');
      if (!/\bsticky\b/i.test(text) && !/\bpinned\b/i.test(text)) return;
      // Strip the chrome — "Unread", "Sticky" labels, "last comment ..." suffix —
      // so the persisted title is just the discussion's actual title.
      const title = text
        .replace(/\bunread\b/gi, '')
        .replace(/\bsticky\b/gi, '')
        .replace(/\bpinned\b/gi, '')
        .replace(/last comment[\s\S]*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title || title.length > 200) return;
      stickyAnchors.push({ url: a.href, title });
    });
    // Dedupe by URL, cap to 5 (diminishing returns past that).
    const seen = new Set();
    const filtered = stickyAnchors.filter(s => {
      if (seen.has(s.url)) return false;
      seen.add(s.url); return true;
    }).slice(0, 5);
    return { name, meta, stickyDiscussions: filtered };
  });

  console.log(`[group-rules] g${groupId} (${landing.name || 'unnamed'}) — meta:${landing.meta ? landing.meta.length : 0}ch sticky:${(landing.stickyDiscussions||[]).length}`);
  const parts = [];
  if (landing.meta) parts.push('Group description: ' + landing.meta);

  for (const s of landing.stickyDiscussions || []) {
    try {
      await page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await waitOutCloudflare(page, 15000);
      await page.waitForTimeout(800);
      const body = await page.evaluate(() => {
        // Skip 404 / "Page Not Found" stales — FetLife responds 200 with a
        // friendly error page for deleted discussions, so we have to sniff the
        // title rather than rely on HTTP status.
        if (/file not found|error code: 404|page not found/i.test(document.title || '')) {
          return '';
        }
        // FetLife wraps the OP discussion + comments in a top-level <article>.
        // That includes some chrome ("Mute for 30 days", "Copy Link" controls
        // and the comment thread) but the rule text is invariably near the top,
        // so a slice keeps signal high while staying bounded.
        const article = document.querySelector('article');
        if (article) {
          const txt = (article.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt) return txt.slice(0, 4000);
        }
        // Fallback: largest visible div within <main>. Defensive in case
        // FetLife restructures and the <article> goes away.
        const root = document.querySelector('main, [role="main"]') || document.body;
        let best = '';
        for (const el of root.querySelectorAll('div, section, p')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt.length >= 80 && txt.length > best.length) best = txt;
        }
        return best.slice(0, 4000);
      }).catch(() => '');
      console.log(`[group-rules]   sticky "${s.title.slice(0,50)}" → body:${body ? body.length : 0}ch`);
      if (body) parts.push('Sticky "' + s.title + '": ' + body.slice(0, 4000));
      // Small jitter between sticky visits.
      await page.waitForTimeout(400 + Math.random() * 700);
    } catch (err) { console.warn(`[group-rules]   sticky goto failed:`, err.message); }
  }

  return {
    name: landing.name || '',
    rawText: parts.join('\n\n---\n\n'),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * One-shot crawl: scrape sticky/description for every joined group on this
 * account. Uses the cached groups list as the source (so we never crawl groups
 * the account doesn't actually belong to). Reports progress per group so the
 * UI can render a live counter.
 */
export async function refreshGroupRulesForAccount(accountId, opts = {}) {
  const reporter = opts.reporter || noopReporter();
  const cached = await readCachedGroups(accountId);
  const groups = (cached && cached.groups) || [];
  if (!groups.length) {
    throw new Error(`No cached joined-groups for ${accountId} — refresh groups first`);
  }
  const limit = opts.limit ? Math.min(opts.limit, groups.length) : groups.length;
  const subset = groups.slice(0, limit);
  reporter.stage('Crawling group sticky notes', `0/${subset.length}`);
  const out = [];
  await withSession(accountId, async (page, _reporter) => {
    for (let i = 0; i < subset.length; i++) {
      const g = subset[i];
      reporter.stage('Crawling group sticky notes', `${i + 1}/${subset.length} · g${g.id}`);
      try {
        const scraped = await scrapeOneGroupRules(page, g.id);
        const rules = extractRules(scraped.rawText);
        out.push({
          id: String(g.id),
          name: scraped.name || g.name,
          fetchedAt: scraped.fetchedAt,
          rawText: scraped.rawText,
          rules,
        });
      } catch (err) {
        out.push({ id: String(g.id), name: g.name, fetchedAt: new Date().toISOString(), error: err.message, rules: [] });
      }
      // Small jitter so we don't hammer FetLife at a robotic cadence.
      await page.waitForTimeout(800 + Math.random() * 1200);
    }
  }, opts);
  const payload = { accountId, fetchedAt: new Date().toISOString(), groups: out };
  await writeGroupRules(accountId, payload);
  reporter.done(`${out.length} crawled`);
  return payload;
}

// ── Organized events ──────────────────────────────────────────────────────────

export async function listOrganizedEvents(accountId, opts = {}) {
  return withSession(accountId, async (page, reporter) => {
    reporter.stage('Loading /events/organizing');
    await page.goto(`${FL_BASE}/events/organizing`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    reporter.stage('Parsing event cards');
    // Selector strategy: FetLife restructured event cards so the `<a href="/events/...">`
    // now WRAPS the whole card (was `<h3><a title="..."></a></h3>` before; the `title`
    // attribute is gone and the heading moved INSIDE the anchor). Match any anchor with
    // a date-URL path; derive title from either the legacy `title` attr or a descendant
    // heading; data-testid card scope might now live INSIDE the anchor.
    const events = await page.$$eval('a[href^="/events/"]', (anchors) => {
      const seen = new Map();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/events\/(\d{4})\/(\d{2})\/(\d{2})\/([^?#]+)/);
        if (!m) continue;
        const [, y, mo, d, slug] = m;
        const cleanUrl = `https://fetlife.com/events/${y}/${mo}/${d}/${slug}`;
        if (seen.has(cleanUrl)) continue;

        let title = a.getAttribute('title');
        if (!title) {
          const h = a.querySelector('h1, h2, h3, h4');
          if (h) title = h.textContent.trim();
        }
        if (!title) title = a.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!title) continue;

        // Card scope: descendant first (new layout), ancestor second (old layout), anchor itself last.
        const card = a.querySelector('[data-testid]') || a.closest('[data-testid]') || a;
        let category = null, dateText = null, location = null, eventId = null;
        const tid = card.getAttribute && card.getAttribute('data-testid');
        if (tid) {
          const idMatch = tid.match(/^(\d+)/);
          if (idMatch) eventId = idMatch[1];
        }
        // Fallback: trailing alphanumeric token in the URL slug (e.g. "...-3aajz5").
        if (!eventId) {
          const slugMatch = slug.match(/-([a-z0-9]{4,12})\/?$/i);
          if (slugMatch) eventId = slugMatch[1];
        }
        const cat = card.querySelector && card.querySelector('[data-testid="category pill"]');
        if (cat) category = cat.textContent.trim();
        const rows = (card.querySelectorAll && card.querySelectorAll('div.flex.items-start')) || [];
        if (rows[0]) dateText = rows[0].textContent.trim().replace(/\s+/g, ' ');
        if (rows[1]) location = rows[1].textContent.trim().replace(/\s+/g, ' ');

        seen.set(cleanUrl, {
          id: eventId,
          url: cleanUrl,
          title,
          category, dateText, location,
          urlDate: `${y}-${mo}-${d}`,
        });
      }
      // Filter to upcoming (URL date >= today, UTC).
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      return [...seen.values()].filter(e => e.urlDate >= todayStr);
    });
    reporter.done(`${events.length} upcoming event(s)`);
    return events;
  }, opts);
}

// ── Past organized events (events you've already hosted) ─────────────────────

async function scrapePastEventsPage(page) {
  return await page.$$eval('a[href^="/events/"]', (anchors) => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/events\/(\d{4})\/(\d{2})\/(\d{2})\/([^?#]+)/);
      if (!m) continue;
      const [, y, mo, d, slug] = m;
      const cleanUrl = `https://fetlife.com/events/${y}/${mo}/${d}/${slug}`;
      if (seen.has(cleanUrl)) continue;
      let title = a.getAttribute('title');
      if (!title) { const h = a.querySelector('h1, h2, h3, h4'); if (h) title = h.textContent.trim(); }
      if (!title) title = a.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!title) continue;
      const card = a.querySelector('[data-testid]') || a.closest('[data-testid]') || a;
      let category = null, dateText = null, location = null, eventId = null;
      const tid = card.getAttribute && card.getAttribute('data-testid');
      if (tid) { const idMatch = tid.match(/^(\d+)/); if (idMatch) eventId = idMatch[1]; }
      if (!eventId) { const slugMatch = slug.match(/-([a-z0-9]{4,12})\/?$/i); if (slugMatch) eventId = slugMatch[1]; }
      const cat = card.querySelector && card.querySelector('[data-testid="category pill"]');
      if (cat) category = cat.textContent.trim();
      const rows = (card.querySelectorAll && card.querySelectorAll('div.flex.items-start')) || [];
      if (rows[0]) dateText = rows[0].textContent.trim().replace(/\s+/g, ' ');
      if (rows[1]) location = rows[1].textContent.trim().replace(/\s+/g, ' ');
      seen.set(cleanUrl, {
        id: eventId, url: cleanUrl, title,
        category, dateText, location, urlDate: `${y}-${mo}-${d}`,
      });
    }
    return [...seen.values()];
  });
}

export async function listPastOrganizedEvents(accountId, opts = {}) {
  return withSession(accountId, async (page, reporter) => {
    reporter.stage('Loading /events/organizing/past');
    await page.goto(`${FL_BASE}/events/organizing/past`, { waitUntil: 'domcontentloaded' });
    await waitOutCloudflare(page, 30000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Move the mouse to a safe area (middle of viewport) — required for wheel events
    // to register without first clicking, which could fire a stray navigation.
    try { await page.mouse.move(400, 400); } catch {}

    reporter.stage('Scrolling to load all past events');
    let lastCount = 0;
    let stable = 0;
    const maxIterations = 80;
    for (let i = 0; i < maxIterations; i++) {
      // Confirm we're still on the right URL — abort if something redirected us.
      const currentUrl = page.url();
      if (!currentUrl.includes('/events/organizing/past')) {
        console.log(`[discovery] URL drift detected: ${currentUrl} — aborting scroll loop`);
        break;
      }

      // Try multiple scroll strategies per iteration.
      await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href^="/events/2"]');
        if (anchors.length) anchors[anchors.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(400);
      try { await page.mouse.wheel(0, 2000); } catch {}
      await page.waitForTimeout(1800);

      const count = await page.$$eval('a[href^="/events/2"]', els => {
        const set = new Set();
        for (const a of els) {
          const h = a.getAttribute('href') || '';
          if (/^\/events\/\d{4}\/\d{2}\/\d{2}\//.test(h)) set.add(h);
        }
        return set.size;
      });
      console.log(`[discovery] Past events scroll ${i + 1}: ${count} cards loaded`);
      if (count === lastCount) {
        stable++;
        if (stable >= 4) break;
      } else {
        stable = 0;
        lastCount = count;
      }
    }
    console.log(`[discovery] Past events scrape converged at ${lastCount} cards`);

    try {
      const dims = await page.evaluate(() => ({
        url: window.location.pathname + window.location.search,
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        bodyScrollHeight: document.body.scrollHeight,
      }));
      console.log('[discovery] Final page state:', JSON.stringify(dims));
    } catch {}

    reporter.stage('Parsing past-event cards');
    const events = await scrapePastEventsPage(page);
    reporter.done(`${events.length} past event(s)`);
    return events.sort((a, b) => (b.urlDate || '').localeCompare(a.urlDate || ''));
  }, opts);
}

export async function refreshPastEventsForAccount(accountId, opts = {}) {
  const reporter = opts.reporter || noopReporter();
  const events = await listPastOrganizedEvents(accountId, opts);
  reporter.stage('Saving past-event cache', `${events.length} event(s)`);
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), events };
  await writeJsonAtomic(path.join(EVENTS_DIR, `${accountId}-past.json`), out);
  return out;
}

export async function readCachedPastEvents(accountId) {
  return await readJsonStrict(path.join(EVENTS_DIR, `${accountId}-past.json`), {
    defaultIfMissing: null,
    label: `events/${accountId}-past.json`,
  });
}

export async function refreshEventsForAccount(accountId, opts = {}) {
  const reporter = opts.reporter || noopReporter();
  const events = await listOrganizedEvents(accountId, opts);
  reporter.stage('Saving upcoming-event cache', `${events.length} event(s)`);
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), events };
  await writeJsonAtomic(path.join(EVENTS_DIR, `${accountId}.json`), out);
  return out;
}

export async function readCachedEvents(accountId) {
  return await readJsonStrict(path.join(EVENTS_DIR, `${accountId}.json`), {
    defaultIfMissing: null,
    label: `events/${accountId}.json`,
  });
}

// ── Attending events (events the account RSVP'd "going" / "interested") ──────

async function scrapeEventListPage(page, listUrl, reporter = noopReporter()) {
  reporter.stage('Loading ' + listUrl.replace(FL_BASE, ''));
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await waitOutCloudflare(page, 30000);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  reporter.stage('Parsing event cards');
  return await page.$$eval('a[href^="/events/"]', (anchors) => {
    const seen = new Map();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/events\/(\d{4})\/(\d{2})\/(\d{2})\/([^?#]+)/);
      if (!m) continue;
      const [, y, mo, d, slug] = m;
      const cleanUrl = `https://fetlife.com/events/${y}/${mo}/${d}/${slug}`;
      if (seen.has(cleanUrl)) continue;
      let title = a.getAttribute('title');
      if (!title) { const h = a.querySelector('h1, h2, h3, h4'); if (h) title = h.textContent.trim(); }
      if (!title) title = a.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!title) continue;
      const card = a.querySelector('[data-testid]') || a.closest('[data-testid]') || a;
      let category = null, dateText = null, location = null, eventId = null;
      const tid = card.getAttribute && card.getAttribute('data-testid');
      if (tid) { const idMatch = tid.match(/^(\d+)/); if (idMatch) eventId = idMatch[1]; }
      if (!eventId) { const slugMatch = slug.match(/-([a-z0-9]{4,12})\/?$/i); if (slugMatch) eventId = slugMatch[1]; }
      const cat = card.querySelector && card.querySelector('[data-testid="category pill"]');
      if (cat) category = cat.textContent.trim();
      const rows = (card.querySelectorAll && card.querySelectorAll('div.flex.items-start')) || [];
      if (rows[0]) dateText = rows[0].textContent.trim().replace(/\s+/g, ' ');
      if (rows[1]) location = rows[1].textContent.trim().replace(/\s+/g, ' ');
      seen.set(cleanUrl, {
        id: eventId, url: cleanUrl, title,
        category, dateText, location, urlDate: `${y}-${mo}-${d}`,
      });
    }
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    return [...seen.values()].filter(e => e.urlDate >= todayStr);
  });
}

export async function listAttendingEvents(accountId, opts = {}) {
  return withSession(accountId, async (page, reporter) => {
    // /events/rsvps is FetLife's unified list of every event the account RSVP'd to
    // (Going + Interested + Maybe). The older /events/going + /events/interested
    // tabs are partial views — using /rsvps gives venue accounts the complete
    // "promoter events" picture.
    const events = await scrapeEventListPage(page, `${FL_BASE}/events/rsvps`, reporter);
    reporter.done(`${events.length} RSVP'd event(s)`);
    return events;
  }, opts);
}

export async function refreshAttendingEventsForAccount(accountId, opts = {}) {
  const reporter = opts.reporter || noopReporter();
  const events = await listAttendingEvents(accountId, opts);
  reporter.stage('Saving RSVP\'d-event cache', `${events.length} event(s)`);
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const out = { accountId, fetchedAt: new Date().toISOString(), events };
  await writeJsonAtomic(path.join(EVENTS_DIR, `${accountId}-attending.json`), out);
  return out;
}

export async function readCachedAttendingEvents(accountId) {
  return await readJsonStrict(path.join(EVENTS_DIR, `${accountId}-attending.json`), {
    defaultIfMissing: null,
    label: `events/${accountId}-attending.json`,
  });
}

// ── Single event description (loaded on demand for cross-posting) ─────────────

// Strip @ symbols from imported event copy. FetLife auto-interprets "@" in posted
// text as a user-mention attempt; when an event title/description includes "@ The
// Crucible" or "@the-crucible" it ships through unchanged into the cross-posted
// group post, where FetLife either renders it as a broken mention or trips its
// own parsing. Cleaner to scrub here at the single import chokepoint than to
// remember in every downstream composer.
function stripAtSymbols(s) {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/@/g, '').replace(/ {2,}/g, ' ');
}

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

      // Walk a DOM node and emit markdown — preserves the stylings FetLife users
      // actually use in event copy (bold, italic, links, lists, headings). The
      // cross-posted group post then round-trips back to HTML at post time so
      // the formatting is preserved instead of flattened to plain text.
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
          case 'h4': case 'h5': case 'h6': return '\n#### ' + inner.trim() + '\n\n';
          case 'blockquote': return inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
          default: return inner;
        }
      }
      function extractMarkdown(el) {
        return nodeToMd(el)
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      let description = null;
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const descHeading = headings.find(h => /^description$/i.test(h.textContent.trim()));

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
          if (blocks[0]) description = extractMarkdown(blocks[0]);
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
        if (candidates[0]) description = extractMarkdown(candidates[0]);
      }

      return { title, description, url: window.location.href };
    }).then(raw => ({
      ...raw,
      title: stripAtSymbols(raw.title),
      description: stripAtSymbols(raw.description),
    }));
  });
}
