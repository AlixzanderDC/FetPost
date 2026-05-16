/**
 * FetLife Local Automation Service
 * Runs on localhost:3747 — communicates with NexusPost main app
 */

import express from 'express';
import { schedulePost, scheduleGroupEventBatch, cancelPost, getQueue, clearJobsByStatus, retryJob, updateJob } from './scheduler.js';
import { storeCredentials, listAccounts, removeAccount, testLogin, updateAccountType, getAccount } from './credentials.js';
import { getPostHistory } from './history.js';
import {
  refreshGroupsForAccount, readCachedGroups,
  refreshEventsForAccount, readCachedEvents,
  refreshPastEventsForAccount, readCachedPastEvents,
  refreshAttendingEventsForAccount, readCachedAttendingEvents,
  getEventDetails,
} from './discovery.js';
import {
  refreshPostMetrics, readPostMetrics,
  refreshEventMetrics, readEventMetrics,
} from './metrics.js';
import {
  listTrackedEvents, addTrackedEvents, removeTrackedEvent, refreshAllTrackedRsvps,
} from './tracked-events.js';
import {
  listTrackedPosts, addTrackedPosts, removeTrackedPost, refreshAllTrackedPosts,
} from './tracked-posts.js';
import { listTemplates, addTemplate, removeTemplate } from './templates.js';
import { getJob, startBackgroundJob } from './progress.js';

const app = express();
const PORT = 3747;

app.use(express.json({ limit: '50mb' }));

// Simple auth — shared secret between this service and your main app
const API_SECRET = process.env.FL_SERVICE_SECRET || 'change-this-secret';

function auth(req, res, next) {
  const token = req.headers['x-service-token'];
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Progress jobs (polling-based stage tracking for long scrapes) ─────────────

app.get('/jobs/:jobId', auth, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found or expired' });
  res.json(job);
});

/**
 * Endpoints opt into stage-tracked async execution with ?progress=1. With the flag the
 * endpoint creates an in-memory job, runs the work fire-and-forget with a stage reporter,
 * and responds immediately with { async: true, jobId }. The client then polls /jobs/:jobId.
 * Without the flag the endpoint runs synchronously and returns the result as before
 * (preserves cron/headless callers that don't render progress).
 */
function withProgressOrSync(req, res, label, meta, work) {
  if (req.query.progress === '1') {
    const jobId = startBackgroundJob(label, meta, reporter => work(reporter));
    return res.json({ async: true, jobId });
  }
  // Sync path — pass a noop-style "fake" reporter via undefined opts.reporter so work()
  // can be the exact same code path.
  work().then(result => res.json(result)).catch(err => res.status(500).json({ error: err.message }));
}

// ── Account management ────────────────────────────────────────────────────────

// Add or update a FetLife account
app.post('/accounts', auth, async (req, res) => {
  const { accountId, username, password, groupName, accountType } = req.body;
  if (!accountId || !username || !password) {
    return res.status(400).json({ error: 'accountId, username, password required' });
  }
  try {
    await storeCredentials(accountId, { username, password, groupName, accountType });
    res.json({ success: true, accountId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all stored accounts (no passwords returned)
app.get('/accounts', auth, async (req, res) => {
  try {
    const accounts = await listAccounts();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update mutable account fields (currently just accountType)
app.patch('/accounts/:accountId', auth, async (req, res) => {
  const { accountType } = req.body || {};
  if (!accountType) return res.status(400).json({ error: 'accountType required' });
  try {
    const updated = await updateAccountType(req.params.accountId, accountType);
    res.json({ success: true, account: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an account
app.delete('/accounts/:accountId', auth, async (req, res) => {
  try {
    await removeAccount(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test login for an account
app.post('/accounts/:accountId/test', auth, async (req, res) => {
  try {
    const result = await testLogin(req.params.accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Post scheduling ───────────────────────────────────────────────────────────

// Schedule a post
app.post('/posts', auth, async (req, res) => {
  const {
    postId, accountId, content, scheduledAt, postType, eventDetails, images,
    groupIds, eventUrl, title, body,
  } = req.body;

  if (!postId || !accountId || !scheduledAt) {
    return res.status(400).json({ error: 'postId, accountId, scheduledAt required' });
  }

  const schedDate = new Date(scheduledAt);
  if (isNaN(schedDate.getTime()) || schedDate <= new Date()) {
    return res.status(400).json({ error: 'scheduledAt must be a future ISO date string' });
  }

  // Group-event batch: fan one event out across N groups with 60–120s stagger.
  if (postType === 'group_event') {
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ error: 'groupIds (non-empty array) required for group_event' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required for group_event' });
    }
    try {
      const fanout = await scheduleGroupEventBatch({
        parentId: postId, accountId, eventUrl, title, body, groupIds, scheduledAt: schedDate,
      });
      return res.json({ success: true, postId, fanout });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Existing single-job post types (status / picture / event) still need content.
  if (!content && postType !== 'event') {
    return res.status(400).json({ error: 'content required' });
  }

  try {
    await schedulePost({ postId, accountId, content, scheduledAt: schedDate, postType: postType || 'status', eventDetails, images: images || [], eventUrl });
    res.json({ success: true, postId, scheduledAt: schedDate.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current queue
app.get('/posts', auth, async (req, res) => {
  try {
    const queue = await getQueue();
    res.json({ posts: queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a scheduled post
app.delete('/posts/:postId', auth, async (req, res) => {
  try {
    await cancelPost(req.params.postId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a scheduled post — body may include title/body/content/scheduledAt.
app.put('/posts/:postId', auth, async (req, res) => {
  try {
    const job = await updateJob(req.params.postId, req.body || {});
    res.json({ success: true, post: job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Retry a failed post — flips status back to 'scheduled' and re-arms a timer.
app.post('/posts/:postId/retry', auth, async (req, res) => {
  try {
    const job = await retryJob(req.params.postId);
    res.json({ success: true, post: job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk clear jobs by status (e.g., clear all failed posts)
app.post('/posts/clear-by-status', auth, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['failed', 'cancelled', 'sent'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'status must be one of: ' + allowed.join(', ') });
  }
  try {
    const removed = await clearJobsByStatus(status);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post history / audit log
app.get('/history', auth, async (req, res) => {
  const { accountId, limit = 50 } = req.query;
  try {
    const history = await getPostHistory(accountId, parseInt(limit));
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Discovery: joined groups + organized events ──────────────────────────────

app.get('/accounts/:accountId/groups', auth, async (req, res) => {
  try {
    const cached = await readCachedGroups(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, groups: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/groups/refresh', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Refresh groups · ${accountId}`, { accountId, kind: 'groups' },
    (reporter) => refreshGroupsForAccount(accountId, { reporter })
  );
});

app.get('/accounts/:accountId/events', auth, async (req, res) => {
  try {
    const cached = await readCachedEvents(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, events: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/events/refresh', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Refresh upcoming events · ${accountId}`, { accountId, kind: 'events' },
    async (reporter) => {
      const result = await refreshEventsForAccount(accountId, { reporter });
      // For Venue accounts, also pull RSVP'd ("promoter") events so the picker is complete.
      // Failures here are non-fatal — the hosted refresh already succeeded.
      let attending = null, attendingError = null;
      const acct = await getAccount(accountId);
      if (acct && acct.accountType === 'venue') {
        try {
          if (reporter) reporter.stage('Venue: pulling RSVP\'d events');
          attending = await refreshAttendingEventsForAccount(accountId, { reporter });
        } catch (err) {
          attendingError = err.message;
        }
      }
      return { ...result, attending, attendingError };
    }
  );
});

// Attending (RSVP'd) events — only meaningful for Venue accounts, but the endpoint is
// type-agnostic so callers can always read whatever is cached.
app.get('/accounts/:accountId/events/attending', auth, async (req, res) => {
  try {
    const cached = await readCachedAttendingEvents(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, events: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/events/attending/refresh', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Refresh RSVP'd events · ${accountId}`, { accountId, kind: 'attending' },
    (reporter) => refreshAttendingEventsForAccount(accountId, { reporter })
  );
});

// Aggregator for the Event Insights view: returns every event (upcoming + past) organized
// by the account, each annotated with its full snapshot history if we've scraped any.
app.get('/accounts/:accountId/events/insights', auth, async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const upcomingCache = await readCachedEvents(accountId);
    const pastCache = await readCachedPastEvents(accountId);
    const tracked = await listTrackedEvents(accountId);
    const upcoming = (upcomingCache && upcomingCache.events) || [];
    const past = (pastCache && pastCache.events) || [];
    // Dedupe by URL — discovery wins over tracked (richer fields), tracked fills gaps.
    const todayStr = new Date().toISOString().slice(0, 10);
    const byUrl = new Map();
    for (const t of tracked) {
      const isPast = (t.urlDate || '') < todayStr;
      byUrl.set(t.url, { url: t.url, title: t.title || 'Untitled', urlDate: t.urlDate, source: t.source, isPast, _fromTracked: true });
    }
    for (const e of past) byUrl.set(e.url, { ...byUrl.get(e.url), ...e, isPast: true });
    for (const e of upcoming) byUrl.set(e.url, { ...byUrl.get(e.url), ...e, isPast: false });
    const events = [...byUrl.values()];
    events.sort((a, b) => (b.urlDate || '').localeCompare(a.urlDate || ''));
    for (const event of events) {
      const eventKey = String(event.url).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);
      const snapshots = await readEventMetrics(eventKey);
      event.snapshots = snapshots;
      event.latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
    }
    res.json({
      accountId,
      totalEvents: events.length,
      upcomingFetchedAt: upcomingCache ? upcomingCache.fetchedAt : null,
      pastFetchedAt: pastCache ? pastCache.fetchedAt : null,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tracked events ──────────────────────────────────────────────────────────

app.get('/accounts/:accountId/events/tracked', auth, async (req, res) => {
  try {
    const events = await listTrackedEvents(req.params.accountId);
    res.json({ accountId: req.params.accountId, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/accounts/:accountId/events/tracked', auth, async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });
  try {
    const result = await addTrackedEvents(req.params.accountId, urls, 'manual');
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/accounts/:accountId/events/tracked', auth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await removeTrackedEvent(req.params.accountId, url);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Long-running: return immediately, scrape in background.
app.post('/accounts/:accountId/events/tracked/refresh-all', auth, (req, res) => {
  const accountId = req.params.accountId;
  if (req.query.progress === '1') {
    const jobId = startBackgroundJob(`Refresh tracked RSVPs · ${accountId}`, { accountId, kind: 'tracked-rsvps' }, async (reporter) => {
      reporter.stage('Loading tracked events list');
      return await refreshAllTrackedRsvps(accountId, {
        onProgress: ({ done, total, url }) => {
          reporter.stage(`Scraping ${done}/${total}`, url || null);
        },
      });
    });
    return res.json({ async: true, jobId });
  }
  // Legacy fire-and-forget — return immediately, scrape in background, no progress.
  res.json({ success: true, message: 'Refresh started in background — check fetlife-poster.log for progress' });
  refreshAllTrackedRsvps(accountId)
    .then(r => console.log(`[tracked] Done for ${accountId}: ${r.processed}/${r.total} processed`))
    .catch(err => console.error(`[tracked] Refresh failed for ${accountId}:`, err.message));
});

// ── Tracked posts (engagement tracking for sent posts) ──────────────────────

app.get('/accounts/:accountId/posts/tracked', auth, async (req, res) => {
  try {
    const posts = await listTrackedPosts(req.params.accountId);
    // Attach the most recent snapshot per post so the UI can show current metrics in one shot.
    const enriched = await Promise.all(posts.map(async p => {
      const key = String(p.url).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);
      const snaps = await readPostMetrics(key);
      const latestSnapshot = snaps.length ? snaps[snaps.length - 1] : null;
      return { ...p, latestSnapshot };
    }));
    res.json({ accountId: req.params.accountId, posts: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/accounts/:accountId/posts/tracked', auth, async (req, res) => {
  const { urls, postId, title, sentAt } = req.body || {};
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });
  try {
    const result = await addTrackedPosts(req.params.accountId, urls, 'manual', { postId, title, sentAt });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/accounts/:accountId/posts/tracked', auth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await removeTrackedPost(req.params.accountId, url);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Long-running: return immediately, scrape in background. With ?progress=1 the work is
// staged into a progress job the UI can poll.
app.post('/accounts/:accountId/posts/tracked/refresh-all', auth, (req, res) => {
  const accountId = req.params.accountId;
  if (req.query.progress === '1') {
    const jobId = startBackgroundJob(`Refresh tracked posts · ${accountId}`, { accountId, kind: 'tracked-posts' }, async (reporter) => {
      reporter.stage('Loading tracked posts list');
      return await refreshAllTrackedPosts(accountId, {
        onProgress: ({ done, total, url }) => {
          reporter.stage(`Scraping ${done}/${total}`, url || null);
        },
      });
    });
    return res.json({ async: true, jobId });
  }
  res.json({ success: true, message: 'Refresh started in background — check fetlife-poster.log for progress' });
  refreshAllTrackedPosts(accountId)
    .then(r => console.log(`[tracked-posts] Done for ${accountId}: ${r.processed}/${r.total} processed`))
    .catch(err => console.error(`[tracked-posts] Refresh failed for ${accountId}:`, err.message));
});

// ── Templates (per-account saved post bodies) ───────────────────────────────

app.get('/accounts/:accountId/templates', auth, async (req, res) => {
  try {
    const templates = await listTemplates(req.params.accountId);
    res.json({ accountId: req.params.accountId, templates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/accounts/:accountId/templates', auth, async (req, res) => {
  const { name, postType, content, images } = req.body || {};
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!content && !hasImages) return res.status(400).json({ error: 'content or at least one image required' });
  try {
    const entry = await addTemplate(req.params.accountId, { name, postType, content, images });
    res.json({ success: true, template: entry });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/accounts/:accountId/templates/:id', auth, async (req, res) => {
  try {
    const result = await removeTemplate(req.params.accountId, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/accounts/:accountId/events/past', auth, async (req, res) => {
  try {
    const cached = await readCachedPastEvents(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, events: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/events/past/refresh', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Refresh past events · ${accountId}`, { accountId, kind: 'past-events' },
    (reporter) => refreshPastEventsForAccount(accountId, { reporter })
  );
});

app.get('/accounts/:accountId/events/details', auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const details = await getEventDetails(req.params.accountId, url);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Engagement metrics (on-demand scrape + read snapshots) ──────────────────

app.post('/metrics/post/refresh', auth, async (req, res) => {
  const { accountId, postId, postUrl } = req.body || {};
  if (!accountId || !postId || !postUrl) return res.status(400).json({ error: 'accountId, postId, postUrl required' });
  try {
    const snapshot = await refreshPostMetrics(accountId, postId, postUrl);
    res.json({ success: true, snapshot });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/metrics/post/:postId', auth, async (req, res) => {
  try { res.json({ snapshots: await readPostMetrics(req.params.postId) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/metrics/event/refresh', auth, async (req, res) => {
  const { accountId, eventId, eventUrl } = req.body || {};
  if (!accountId || !eventId || !eventUrl) return res.status(400).json({ error: 'accountId, eventId, eventUrl required' });
  try {
    const snapshot = await refreshEventMetrics(accountId, eventId, eventUrl);
    res.json({ success: true, snapshot });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/metrics/event/:eventId', auth, async (req, res) => {
  try { res.json({ snapshots: await readEventMetrics(req.params.eventId) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Cookie freshness — per-account file mtime so the UI can flag stale sessions
// before the user notices via a broken operation.
app.get('/cookies/freshness', auth, async (req, res) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const { listAccounts } = await import('./credentials.js');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cookiesDir = path.join(__dirname, '..', 'data', 'cookies');
    const accounts = await listAccounts();
    const out = [];
    for (const a of accounts) {
      const f = path.join(cookiesDir, a.accountId + '.json');
      try {
        const st = await fs.stat(f);
        const ageHours = (Date.now() - st.mtimeMs) / (1000 * 60 * 60);
        out.push({ accountId: a.accountId, exists: true, mtime: st.mtime.toISOString(), ageHours: Number(ageHours.toFixed(2)) });
      } catch {
        out.push({ accountId: a.accountId, exists: false, mtime: null, ageHours: null });
      }
    }
    res.json({ accounts: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cookie refresh status — most recent cron run result
app.get('/cookies/refresh-status', auth, async (req, res) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const statusFile = path.join(__dirname, '..', 'data', 'cookies', '_refresh-status.json');
    try {
      const raw = await fs.readFile(statusFile, 'utf8');
      res.json(JSON.parse(raw));
    } catch {
      res.json({ ranAt: null, succeeded: 0, failed: 0, results: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check — no auth needed
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fetlife-poster', version: '1.0.0' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[fetlife-poster] Service running on http://127.0.0.1:${PORT}`);
  if (!process.env.FL_SERVICE_SECRET) {
    console.warn(`[fetlife-poster] WARNING: FL_SERVICE_SECRET not set — using insecure default`);
  }
});
