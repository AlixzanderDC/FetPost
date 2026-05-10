/**
 * FetLife Local Automation Service
 * Runs on localhost:3747 — communicates with NexusPost main app
 */

import express from 'express';
import { schedulePost, scheduleGroupEventBatch, cancelPost, getQueue, clearJobsByStatus } from './scheduler.js';
import { storeCredentials, listAccounts, removeAccount, testLogin } from './credentials.js';
import { getPostHistory } from './history.js';
import {
  refreshGroupsForAccount, readCachedGroups,
  refreshEventsForAccount, readCachedEvents,
  getEventDetails,
} from './discovery.js';

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

// ── Account management ────────────────────────────────────────────────────────

// Add or update a FetLife account
app.post('/accounts', auth, async (req, res) => {
  const { accountId, username, password, groupName } = req.body;
  if (!accountId || !username || !password) {
    return res.status(400).json({ error: 'accountId, username, password required' });
  }
  try {
    await storeCredentials(accountId, { username, password, groupName });
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
    await schedulePost({ postId, accountId, content, scheduledAt: schedDate, postType: postType || 'status', eventDetails, images: images || [] });
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

app.post('/accounts/:accountId/groups/refresh', auth, async (req, res) => {
  try {
    const result = await refreshGroupsForAccount(req.params.accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/accounts/:accountId/events', auth, async (req, res) => {
  try {
    const cached = await readCachedEvents(req.params.accountId);
    res.json(cached || { accountId: req.params.accountId, fetchedAt: null, events: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/accounts/:accountId/events/refresh', auth, async (req, res) => {
  try {
    const result = await refreshEventsForAccount(req.params.accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
