/**
 * FetLife Local Automation Service
 * Runs on localhost:3747 — communicates with the FetPost UI process.
 */

import express from 'express';
import { schedulePost, scheduleGroupEventBatch, cancelPost, getQueue, clearJobsByStatus, retryJob, confirmJobSent, markFailedModeration, updateJob, syncWebsiteUrlsToFetlife, findCandidateFetlifeEvents, rearmAccountSchedule } from './scheduler.js';
import { storeCredentials, listAccounts, removeAccount, testLogin, updateAccountType, updateAccountFields, getAccount, updatePassword } from './credentials.js';
import * as telegram from './telegram-bot.js';
import * as ical from './ical.js';
import { fetchWebsiteEvents } from './website-calendar.js';
import { getPostHistory } from './history.js';
import {
  refreshGroupsForAccount, readCachedGroups,
  refreshGroupRulesForAccount, readGroupRules,
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
import { listTemplates, addTemplate, removeTemplate, updateTemplate } from './templates.js';
import { getBatchEventDetails } from './event-batch.js';
import { getJob, startBackgroundJob, rehydrateProgressJobs } from './progress.js';
import { startSnapshotScheduler, runSnapshot } from './snapshot.js';
import { startJanitor } from './janitor.js';
import * as license from './license.js';
import * as mentions from './mentions.js';
import * as venueEvents from './venue-events.js';
import * as campaigns from './campaigns.js';

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
  const { accountId, username, password, groupName, accountType } = req.body || {};
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

// ── License ─────────────────────────────────────────────────────────────────
// Owned here because this is where posting fires. nexuspost-ui proxies to these.

// Cached state + derived posting decision — for the dashboard banner.
app.get('/license/state', auth, (req, res) => {
  res.json(license.getState());
});

// Activate a key (wizard). Validates against the Worker before storing.
app.post('/license/activate', auth, async (req, res) => {
  const { licenseKey } = req.body || {};
  try {
    const result = await license.activate(licenseKey);
    if (!result.ok) return res.status(402).json({ error: 'License not valid', reason: result.reason, expiresAt: result.expiresAt });
    res.json({ success: true, state: result.state, unenforced: !!result.unenforced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force an immediate re-check against the Worker (e.g. after the customer renews).
app.post('/license/revalidate', auth, async (req, res) => {
  try {
    const state = await license.validateNow();
    res.json({ success: true, state, posting: license.isPostingAllowed() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mentions ──────────────────────────────────────────────────────────────
app.get('/mentions/:accountId/config', auth, async (req, res) => {
  try {
    const acct = await getAccount(req.params.accountId).catch(() => null);
    const cfg = await mentions.getConfig(req.params.accountId, acct);
    res.json(cfg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/mentions/:accountId/config', auth, async (req, res) => {
  try {
    const cfg = await mentions.setConfig(req.params.accountId, req.body || {});
    res.json(cfg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mentions/:accountId', auth, async (req, res) => {
  try {
    const filter = {
      since: req.query.since,
      until: req.query.until,
      savedOnly: req.query.saved === '1',
      hideIgnored: req.query.hideIgnored !== '0',
    };
    const items = await mentions.listMentions(req.params.accountId, filter);
    res.json({ mentions: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/mentions/:accountId/scan', auth, async (req, res) => {
  try {
    const summary = await mentions.runScan(req.params.accountId, req.body || {});
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[mentions/scan]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/mentions/:accountId/save', auth, async (req, res) => {
  try {
    const item = await mentions.setMentionState(req.params.accountId, req.body.postUrl, { saved: true, ignored: false });
    res.json({ success: true, item });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/mentions/:accountId/ignore', auth, async (req, res) => {
  try {
    const item = await mentions.setMentionState(req.params.accountId, req.body.postUrl, { ignored: true, saved: false });
    res.json({ success: true, item });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/mentions/:accountId/unset', auth, async (req, res) => {
  try {
    const item = await mentions.setMentionState(req.params.accountId, req.body.postUrl, { saved: false, ignored: false });
    res.json({ success: true, item });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Venue Events (per-account watcher for events at a venue's address) ──
app.get('/venue-events/:accountId/config', auth, async (req, res) => {
  try { res.json(await venueEvents.getConfig(req.params.accountId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/venue-events/:accountId/config', auth, async (req, res) => {
  try { res.json(await venueEvents.setConfig(req.params.accountId, req.body || {})); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/venue-events/:accountId', auth, async (req, res) => {
  try {
    const events = await venueEvents.listEvents(req.params.accountId, {
      includeDismissed: req.query.includeDismissed === '1',
      rsvpStatus: req.query.rsvpStatus,
      unrsvpedOnly: req.query.unrsvpedOnly === '1',
    });
    res.json({ events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/venue-events/:accountId/scan', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Venue scan · ${accountId}`, { accountId, kind: 'venue-scan' },
    async (reporter) => {
      const summary = await venueEvents.runScan(accountId, { ...(req.body || {}), reporter });
      return { success: true, summary };
    }
  );
});

app.post('/venue-events/:accountId/rsvp', auth, async (req, res) => {
  try {
    const result = await venueEvents.setRsvp(req.params.accountId, req.body.eventUrl, req.body.status);
    res.json(result);
  } catch (err) {
    console.error('[venue-events/rsvp]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/venue-events/:accountId/dismiss', auth, async (req, res) => {
  try {
    const event = await venueEvents.dismissEvent(req.params.accountId, req.body.eventUrl, req.body.dismissed !== false);
    res.json({ success: true, event });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/venue-events/:accountId/unrsvp', auth, async (req, res) => {
  try {
    const result = await venueEvents.unRsvp(req.params.accountId, req.body.eventUrl);
    res.json(result);
  } catch (err) {
    console.error('[venue-events/unrsvp]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/venue-events/:accountId/hide', auth, async (req, res) => {
  try {
    const result = await venueEvents.setHiddenFromCalendar(req.params.accountId, req.body.eventUrl, req.body.hidden !== false);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Campaigns (festival/conference/hotel-takeover marketing) ──────────────
// Library CRUD per account. Activation generates real scheduled posts (via
// schedulePost so the regular firing path applies — license gate, pause gate,
// auto-signature, placeholder-strip).
app.get('/campaigns/:accountId', auth, async (req, res) => {
  try {
    const list = await campaigns.listCampaigns(req.params.accountId);
    res.json({ campaigns: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/campaigns/:accountId/runs', auth, async (req, res) => {
  try {
    const runs = await campaigns.listRuns(req.params.accountId);
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/campaigns/:accountId', auth, async (req, res) => {
  try {
    const c = await campaigns.createCampaign(req.params.accountId, req.body || {});
    res.json({ success: true, campaign: c });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/campaigns/:accountId/:campaignId', auth, async (req, res) => {
  try {
    const c = await campaigns.updateCampaign(req.params.accountId, req.params.campaignId, req.body || {});
    res.json({ success: true, campaign: c });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/campaigns/:accountId/:campaignId', auth, async (req, res) => {
  try {
    const result = await campaigns.deleteCampaign(req.params.accountId, req.params.campaignId);
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview: return the post list a hypothetical activation would generate, without
// actually scheduling anything. Campaign owns its event dates so no body params needed.
app.post('/campaigns/:accountId/:campaignId/preview', auth, async (req, res) => {
  try {
    const c = await campaigns.getCampaign(req.params.accountId, req.params.campaignId);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const tz = (req.body && req.body.tz) || null;
    const posts = campaigns.previewActivation(c, { tz });
    res.json({ posts });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Activate: schedule every post in one batch. Returns the runId so the UI can
// later unschedule the whole batch in one click. Campaign owns its event dates.
app.post('/campaigns/:accountId/:campaignId/activate', auth, async (req, res) => {
  try {
    const tz = (req.body && req.body.tz) || null;
    const result = await campaigns.activateCampaign(
      req.params.accountId, req.params.campaignId, schedulePost, { tz },
    );
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Sync new slots from the campaign template into the latest active run.
// Triggered when the operator edits a campaign and adds slots AFTER it was
// already activated — without this, the new slots stay in the template only
// and never reach the queue.
app.post('/campaigns/:accountId/:campaignId/sync-new-slots', auth, async (req, res) => {
  try {
    const tz = (req.body && req.body.tz) || null;
    const result = await campaigns.syncNewSlotsToRun(
      req.params.accountId, req.params.campaignId, schedulePost, { tz },
    );
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Unschedule every post created by a previous activation.
app.post('/campaigns/:accountId/runs/:runId/unschedule', auth, async (req, res) => {
  try {
    const result = await campaigns.unscheduleRun(req.params.accountId, req.params.runId, cancelPost);
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Slot a new post into an existing activation run. The new post goes through the
// regular schedulePost path (same validators) and gets registered with the run so
// "Unschedule all" still catches it. PostId prefixed with the runId so it is
// identifiable as a slot-in and filterable on the campaign drill-down.
app.post('/campaigns/:accountId/runs/:runId/slot-in', auth, async (req, res) => {
  try {
    const { accountId, runId } = req.params;
    const { content, scheduledAt, postType, images, eventUrl } = req.body || {};
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt required' });
    const when = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'scheduledAt invalid' });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'scheduledAt must be in the future' });
    const postId = `fetlife-${accountId}-${runId}-slotin-${Date.now().toString(36)}`;
    await schedulePost({
      postId,
      accountId,
      content: content || '',
      scheduledAt: when,
      postType: postType || 'status',
      images: images || [],
      eventUrl: eventUrl || null,
    });
    const result = await campaigns.addPostToRun(accountId, runId, postId);
    res.json({ success: true, postId, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
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

// Update mutable account fields. accountType has its own validated path; arbitrary
// fields (discordWebhookUrl, autoSignature, etc.) go through updateAccountFields.
app.patch('/accounts/:accountId', auth, async (req, res) => {
  const body = req.body || {};
  try {
    let updated;
    if (body.accountType !== undefined) {
      updated = await updateAccountType(req.params.accountId, body.accountType);
    }
    // Patch any other fields after accountType (which has its own enum validation)
    const otherFields = { ...body };
    delete otherFields.accountType;
    if (Object.keys(otherFields).length) {
      updated = await updateAccountFields(req.params.accountId, otherFields);
    }
    if (!updated) return res.status(400).json({ error: 'no fields to update' });
    // If this PATCH unpaused the account, immediately re-arm its scheduled
    // posts so any defer-timer from the paused state gets superseded by the
    // real scheduledAt timer. Without this, freshly-resumed posts could wait
    // up to PAUSE_DEFER_MS (30 min) before firing on the next defer-check.
    if (body.paused === false) {
      try {
        const rearmed = await rearmAccountSchedule(req.params.accountId);
        return res.json({ success: true, account: updated, rearmed });
      } catch (err) {
        console.warn(`[accounts/patch] rearm failed for ${req.params.accountId}: ${err.message}`);
      }
    }
    res.json({ success: true, account: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Issue (or return existing) iCal subscribe token for an account. UI calls this
// when the user clicks "Get iCal URL".
app.post('/accounts/:accountId/ical-token', auth, async (req, res) => {
  try {
    const token = await ical.ensureIcalToken(req.params.accountId);
    res.json({ success: true, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public (no service auth) — anyone with the token can subscribe. Token gates access.
app.get('/calendar/:accountId/:token.ics', async (req, res) => {
  try {
    const ok = await ical.validateIcalToken(req.params.accountId, req.params.token);
    if (!ok) return res.status(404).send('Calendar not found.');
    const body = await ical.generateIcsFor(req.params.accountId);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="fetpost-${encodeURIComponent(req.params.accountId)}.ics"`);
    res.send(body);
  } catch (err) { res.status(500).send('Calendar generation failed: ' + err.message); }
});

app.post('/accounts/:accountId/telegram/test', auth, async (req, res) => {
  const { botToken, chatId } = req.body || {};
  if (!botToken || !chatId) return res.status(400).json({ error: 'botToken and chatId required' });
  try {
    const acct = await getAccount(req.params.accountId).catch(() => null);
    const label = acct?.groupName || acct?.accountId || req.params.accountId;
    const result = await telegram.testBot(botToken, chatId, label);
    res.json({ success: !!result.ok, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// Surgical password update — touches credentials only. Per-account meta and
// queued posts are untouched. Used by the dashboard "Change password" button.
app.put('/accounts/:accountId/password', auth, async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.length < 1) {
    return res.status(400).json({ error: 'password required' });
  }
  try {
    await updatePassword(req.params.accountId, password);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    groupIds, eventUrl, title, body, groupsPerDay, weekdaysOnly,
  } = req.body || {};

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
        parentId: postId, accountId, eventUrl, title, body, groupIds, scheduledAt: schedDate, groupsPerDay, weekdaysOnly,
      });
      // No reminder ladder for group cross-posts — user policy: once per group per month.
      // Repeated reminders to the same groups would violate that. The ladder is only
      // exposed for single-account status/picture posts (handled further down).
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

// Get current queue. group_event posts get their destination groupName hydrated
// here so the UI can always render a real name in the queue cards — the UI's
// separate allGroupsByAccount cache wasn't reliable across all browsing entry
// points (race on cold loads, plus user accounts whose group cache predates
// some referenced ids). One read per account-with-group-events keeps it cheap.
app.get('/posts', auth, async (req, res) => {
  try {
    const queue = await getQueue();
    const accountsWithGroupPosts = new Set(
      queue.filter(p => p.postType === 'group_event' && p.groupId).map(p => p.accountId)
    );
    const groupMaps = {};
    await Promise.all([...accountsWithGroupPosts].map(async (accountId) => {
      try {
        const cached = await readCachedGroups(accountId);
        const map = {};
        for (const g of (cached && cached.groups) || []) map[String(g.id)] = g.name;
        groupMaps[accountId] = map;
      } catch { /* leave map empty — UI falls back to "Group <id>" */ }
    }));
    const hydrated = queue.map(p => {
      if (p.postType !== 'group_event' || !p.groupId) return p;
      const name = (groupMaps[p.accountId] || {})[String(p.groupId)];
      // Field name carefully chosen: NOT `groupName`. The UI's `orgLabelOf`
      // helper treats any `groupName` it sees as an organization label (it uses
      // that field on event records and account records to compute the calendar
      // legend chips). Calling our destination-group label `groupName` made
      // every cross-posted FetLife group end up rendered as a top-level org
      // chip on the dashboard. `destinationGroupName` keeps the namespaces
      // separate so cross-post destinations stay scoped to the queue cards.
      return name ? { ...p, destinationGroupName: name } : p;
    });
    res.json({ posts: hydrated });
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

// Candidate FetLife events for a post pending a website→FetLife link upgrade.
// Returns scored candidates (title × date proximity) so the UI can show a picker
// for matches the auto-sync was too uncertain to apply on its own.
app.get('/posts/:postId/fetlife-candidates', auth, async (req, res) => {
  try {
    const queue = await getQueue();
    const post = queue.find(p => p.postId === req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.sourceEventTitle) return res.json({ candidates: [], reason: 'post was not created from a website event' });
    const hosted = await readCachedEvents(post.accountId);
    const attending = await readCachedAttendingEvents(post.accountId);
    const allEvents = [].concat((hosted && hosted.events) || [], (attending && attending.events) || []);
    const candidates = findCandidateFetlifeEvents(post, allEvents);
    res.json({ candidates, source: { title: post.sourceEventTitle, date: post.sourceEventDate, url: post.sourceEventUrl } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually link a scheduled post to a FetLife event URL. Used when the
// auto-sync couldn't make a confident match. Replaces eventUrl, rewrites the
// URL inside content (if the old URL appears there), and clears the pending
// flag — all in a single update so the post never sits in a half-linked state.
app.post('/posts/:postId/link-fetlife', auth, async (req, res) => {
  try {
    const { fetlifeUrl } = req.body || {};
    if (!fetlifeUrl) return res.status(400).json({ error: 'fetlifeUrl required' });
    // Peek at the current post to pre-compute the content rewrite.
    const queue = await getQueue();
    const post = queue.find(p => p.postId === req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const updates = { eventUrl: fetlifeUrl, pendingFetlifeMatch: false };
    if (post.content) {
      let newContent = post.content;
      // Replace literal {Insert Event Link} placeholder (lenient match) — covers
      // posts that were created with the placeholder unsubstituted.
      newContent = newContent.replace(/\{[^}]*\b(?:link|url)\b[^}]*\}/gi, fetlifeUrl);
      // Also rewrite any inlined iCal URL.
      const oldUrl = post.sourceEventUrl || post.eventUrl;
      if (oldUrl && oldUrl !== fetlifeUrl && newContent.includes(oldUrl)) {
        newContent = newContent.split(oldUrl).join(fetlifeUrl);
      }
      if (newContent !== post.content) updates.content = newContent;
    }
    const result = await updateJob(req.params.postId, updates);
    res.json({ success: true, post: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// Operator-confirm: "I checked FetLife, the post landed." Used to clear a
// submitted_pending_moderation or outcome_unknown post without scheduling a new one.
app.post('/posts/:postId/confirm-sent', auth, async (req, res) => {
  try {
    const job = await confirmJobSent(req.params.postId);
    res.json({ success: true, post: job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Operator-reject: "I checked FetLife, the post was rejected (or never appeared)."
// Flips a pending-moderation or outcome-unknown job to failed_moderation so the
// content team can track the rejection rate distinctly from technical failures.
app.post('/posts/:postId/mark-rejected', auth, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || null;
    const job = await markFailedModeration(req.params.postId, reason);
    res.json({ success: true, post: job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// On-demand snapshot. Useful before a risky migration/edit so the operator can
// roll back to a known-good state without waiting for the nightly job.
app.post('/admin/snapshot', auth, async (req, res) => {
  try {
    const result = await runSnapshot();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot migration: re-extract event descriptions in markdown for every
// scheduled group_event post and rewrite the body. Used after we switched the
// extractor from innerText (plain text) to markdown (bold/italic/links/lists
// preserved). Groups by (accountId, eventUrl) so each unique event is fetched
// once, then applies the new body to every post in that bucket. Detects user
// additions appended after the description and preserves them.
app.post('/admin/migrate-group-bodies', auth, async (req, res) => {
  let queue;
  try {
    queue = await getQueue();
  } catch (err) {
    // A corrupt/unreadable queue.json throws here (loadQueue fails loud by design);
    // return a clean 500 rather than an unhandled rejection out of the handler.
    return res.status(500).json({ error: 'Could not read queue: ' + err.message });
  }
  const groupPosts = queue.filter(p => p.status === 'scheduled' && p.postType === 'group_event' && p.eventUrl);
  if (groupPosts.length === 0) return res.json({ total: 0, migrated: 0, unchanged: 0, failed: 0 });

  // Bucket by (accountId, eventUrl) so we fetch each event only once.
  const buckets = {};
  for (const p of groupPosts) {
    const key = p.accountId + '|' + p.eventUrl;
    if (!buckets[key]) buckets[key] = { accountId: p.accountId, eventUrl: p.eventUrl, posts: [] };
    buckets[key].posts.push(p);
  }

  // Strip markdown syntax so we can compare the new (markdown) description
  // against the old (plain-text) body and locate where the user's additions
  // start. Mirrors the conversion the original innerText extractor produced.
  function mdToPlain(md) {
    return (md || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/^>\s+/gm, '');
  }
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  let migrated = 0, unchanged = 0, failed = 0;
  const errors = [];
  const updatedAt = new Date().toISOString();

  for (const bucket of Object.values(buckets)) {
    let details;
    try {
      details = await getEventDetails(bucket.accountId, bucket.eventUrl);
    } catch (err) {
      failed += bucket.posts.length;
      errors.push({ eventUrl: bucket.eventUrl, error: err.message });
      continue;
    }
    const newMd = details && details.description;
    if (!newMd) { unchanged += bucket.posts.length; continue; }
    const plainNew = mdToPlain(newMd);
    const normPlainNew = norm(plainNew);

    for (const post of bucket.posts) {
      const oldBody = post.body || '';
      const normOld = norm(oldBody);
      let newBody = newMd;
      // If the old body STARTS with the (normalized) description, anything past
      // that endpoint is a user addition (RSVP line etc.) — preserve it.
      if (normOld.startsWith(normPlainNew)) {
        // Find the boundary in the original oldBody by walking word-by-word
        // through plainNew. Robust against whitespace differences without
        // having to maintain a parallel offset map.
        const words = plainNew.split(/\s+/).filter(Boolean);
        let cursor = 0;
        for (const w of words) {
          const idx = oldBody.indexOf(w, cursor);
          if (idx < 0) { cursor = -1; break; }
          cursor = idx + w.length;
        }
        if (cursor > 0 && cursor <= oldBody.length) {
          const extras = oldBody.slice(cursor).trim();
          newBody = extras ? newMd + '\n\n' + extras : newMd;
        }
      }
      // Atomic update via the existing updateJob path so the queue mutex and
      // re-arm machinery stay consistent. Body-only update — schedule/account
      // untouched.
      try {
        await updateJob(post.postId, { body: newBody });
        migrated++;
      } catch (err) {
        failed++;
        errors.push({ postId: post.postId, error: err.message });
      }
    }
  }

  res.json({ total: groupPosts.length, migrated, unchanged, failed, errors, updatedAt });
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

// ── Group rules (sticky / post requirements) ──────────────────────────────
app.get('/accounts/:accountId/group-rules', auth, async (req, res) => {
  try {
    const cached = await readGroupRules(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, groups: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/group-rules/refresh', auth, (req, res) => {
  const accountId = req.params.accountId;
  withProgressOrSync(req, res, `Refresh group rules · ${accountId}`, { accountId, kind: 'group-rules' },
    (reporter) => refreshGroupRulesForAccount(accountId, { reporter })
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
      // Sync pass: any scheduled post that was created from a website iCal event
      // gets its URL upgraded if a matching FetLife event is now in the cache.
      const allFetlifeEvents = []
        .concat((result && result.events) || [])
        .concat((attending && attending.events) || []);
      let syncResult = { synced: 0, checked: 0 };
      try {
        if (reporter) reporter.stage('Syncing website→FetLife links on scheduled posts');
        syncResult = await syncWebsiteUrlsToFetlife(accountId, allFetlifeEvents);
      } catch (err) {
        console.warn(`[events/refresh] sync failed for ${accountId}: ${err.message}`);
      }
      return { ...result, attending, attendingError, fetlifeSync: syncResult };
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

// Pull events from the account's own website calendar (iCal feed). Used by the
// Auto-fill workflow as a backup data source when events aren't on FetLife yet.
// The URL itself is stored per-account via the standard PATCH /accounts route.
app.get('/accounts/:accountId/events/website', auth, async (req, res) => {
  try {
    const acct = await getAccount(req.params.accountId);
    if (!acct) return res.status(404).json({ error: 'Unknown account' });
    if (!acct.websiteCalendarUrl) return res.json({ events: [], configured: false });
    const events = await fetchWebsiteEvents(acct.websiteCalendarUrl);
    res.json({ events, configured: true, sourceUrl: acct.websiteCalendarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-off test: fetch and parse an arbitrary URL without saving. Lets the UI
// validate a URL the operator just typed before persisting it on the account.
app.post('/accounts/:accountId/events/website/test', auth, async (req, res) => {
  try {
    const url = (req.body && req.body.url) || '';
    if (!url) return res.status(400).json({ error: 'url is required in body' });
    const events = await fetchWebsiteEvents(url);
    res.json({ events, count: events.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

app.put('/accounts/:accountId/templates/:id', auth, async (req, res) => {
  try {
    const entry = await updateTemplate(req.params.accountId, req.params.id, req.body || {});
    res.json({ success: true, template: entry });
  } catch (err) { res.status(400).json({ error: err.message }); }
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
  const { url, eventIds, refresh } = req.query;
  // Batched form: ?eventIds=a,b,c[&refresh=true] — preferred path for external integrations.
  if (eventIds) {
    const ids = String(eventIds).split(',').map(s => s.trim()).filter(Boolean);
    try {
      const result = await getBatchEventDetails(req.params.accountId, ids, {
        refresh: String(refresh) === 'true',
      });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  // Legacy single-URL form — kept so existing UI features keep working.
  if (!url) return res.status(400).json({ error: 'url or eventIds query param required' });
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
  // Load cached license state + start the 6h revalidation loop.
  license.init().catch(err => console.warn('[license] init failed:', err.message));
  // Replay any in-flight progress jobs from the previous run so the UI sees an
  // "interrupted" state instead of polling a 404 for 30 min.
  rehydrateProgressJobs().catch(err => console.warn('[progress] rehydrate failed:', err.message));
  // Nightly snapshots: catches intra-day mutations between provider-level snapshots
  // (which typically run once a day at best). 14-day retention. Restore is manual —
  // see snapshot.js comments.
  startSnapshotScheduler();
  // Janitor: caps unbounded-growth directories (post-screenshots first; more
  // surfaces may join over time). Daily sweep.
  startJanitor();
});
