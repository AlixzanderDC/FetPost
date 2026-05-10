/**
 * NexusPost UI Server v3
 * Supports: FetLife, Bluesky, OnlyFans, Fansly, ManyVids, NiteFlirt
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 4000;

app.use(express.json({ limit: '50mb' }));

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { return []; }
}

function saveTemplates(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list, null, 2));
}

function genTplId() {
  return 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const SERVICES = {
  fetlife: { url: 'http://127.0.0.1:3747', secret: process.env.FL_SERVICE_SECRET },
};

const COOKIE_SCRIPTS = {
  fetlife: 'C:\\Users\\benja\\Documents\\nexuspost\\fetlife-poster\\start-cookies.cmd',
};

const UI_PASSWORD = process.env.UI_PASSWORD || 'nexuspost';
const sessions = new Set();

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === UI_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

function requireAuth(req, res, next) {
  const token = req.headers['x-ui-token'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function proxyRequest(serviceKey, method, reqPath, body) {
  const service = SERVICES[serviceKey];
  if (!service) throw new Error('Unknown service: ' + serviceKey);
  const opts = { method, headers: { 'Content-Type': 'application/json', 'x-service-token': service.secret } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(service.url + reqPath, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ── Accounts ──────────────────────────────────────────────────────────────────

app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const results = await Promise.allSettled(
      Object.keys(SERVICES).map(p => proxyRequest(p, 'GET', '/accounts'))
    );
    const platforms = Object.keys(SERVICES);
    const accounts = [];
    results.forEach((r, i) => {
      const platform = platforms[i];
      const list = r.status === 'fulfilled' ? (r.value.data.accounts || []) : [];
      list.forEach(a => accounts.push(Object.assign({}, a, { platform })));
    });
    res.json({ accounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', requireAuth, async (req, res) => {
  const { platform, accountId, groupName, username, password, handle, appPassword } = req.body;
  if (!platform || !accountId) return res.status(400).json({ error: 'platform and accountId required' });
  try {
    let body;
    if (platform === 'bluesky') {
      if (!handle || !appPassword) return res.status(400).json({ error: 'handle and appPassword required' });
      body = { accountId, handle, appPassword, groupName };
    } else {
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });
      body = { accountId, username, password, groupName };
    }
    const result = await proxyRequest(platform, 'POST', '/accounts', body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/accounts/:platform/:accountId', requireAuth, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'DELETE', '/accounts/' + encodeURIComponent(accountId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:platform/:accountId/test', requireAuth, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/accounts/' + encodeURIComponent(accountId) + '/test');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:platform/:accountId/extract-cookies', requireAuth, async (req, res) => {
  const { platform } = req.params;
  const scriptPath = COOKIE_SCRIPTS[platform];
  if (!scriptPath) return res.status(400).json({ error: 'No cookie script for ' + platform });
  res.json({ success: true, message: 'Cookie extraction started' });
  setTimeout(() => {
    execAsync(scriptPath)
      .then(() => console.log('[ui] Cookie extraction completed for ' + platform))
      .catch(err => console.error('[ui] Cookie extraction failed for ' + platform + ':', err.message));
  }, 3000);
});

// ── FetLife groups + organized events (cross-post discovery) ─────────────────

app.get('/api/fetlife/:accountId/groups', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/groups');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/groups/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/groups/refresh');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/refresh');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/attending', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/attending/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending/refresh');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/details', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const result = await proxyRequest('fetlife', 'GET',
      '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/details?url=' + encodeURIComponent(url));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates (UI-local) ─────────────────────────────────────────────────────
// Each template: { id, name, title, body, accountId, groupId|null, createdAt, updatedAt }
// accountId is required (PIN to one account). groupId is optional; when set, the
// template only appears for group cross-posts targeting that group.

app.get('/api/templates', requireAuth, (req, res) => {
  res.json({ templates: loadTemplates() });
});

app.post('/api/templates', requireAuth, (req, res) => {
  const { name, title, body, accountId, groupId } = req.body || {};
  if (!name || !body || !accountId) {
    return res.status(400).json({ error: 'name, body, accountId required' });
  }
  const list = loadTemplates();
  const now = new Date().toISOString();
  const tpl = {
    id: genTplId(),
    name: String(name).trim(),
    title: title ? String(title).trim() : '',
    body: String(body),
    accountId: String(accountId),
    groupId: groupId ? String(groupId) : null,
    createdAt: now,
    updatedAt: now,
  };
  list.push(tpl);
  saveTemplates(list);
  res.json({ template: tpl });
});

app.patch('/api/templates/:id', requireAuth, (req, res) => {
  const list = loadTemplates();
  const i = list.findIndex(t => t.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Template not found' });
  const { name, title, body, accountId, groupId } = req.body || {};
  if (name !== undefined)      list[i].name = String(name).trim();
  if (title !== undefined)     list[i].title = String(title || '').trim();
  if (body !== undefined)      list[i].body = String(body);
  if (accountId !== undefined) list[i].accountId = String(accountId);
  if (groupId !== undefined)   list[i].groupId = groupId ? String(groupId) : null;
  list[i].updatedAt = new Date().toISOString();
  saveTemplates(list);
  res.json({ template: list[i] });
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const list = loadTemplates();
  const i = list.findIndex(t => t.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Template not found' });
  const [removed] = list.splice(i, 1);
  saveTemplates(list);
  res.json({ template: removed });
});

// ── Posts ─────────────────────────────────────────────────────────────────────

app.get('/api/queue', requireAuth, async (req, res) => {
  try {
    const results = await Promise.allSettled(
      Object.keys(SERVICES).map(p => proxyRequest(p, 'GET', '/posts'))
    );
    const platforms = Object.keys(SERVICES);
    const posts = [];
    results.forEach((r, i) => {
      const platform = platforms[i];
      const list = r.status === 'fulfilled' ? (r.value.data.posts || []) : [];
      list.forEach(p => posts.push(Object.assign({}, p, { platform })));
    });
    posts.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    res.json({ posts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  const { platforms, accountIds, content, scheduledAt, images, media, postType, eventDetails } = req.body;
  if (!platforms || !accountIds || !scheduledAt) return res.status(400).json({ error: 'platforms, accountIds, scheduledAt required' });

  const results = [];

  for (const platform of platforms) {
    const platformAccounts = accountIds.filter(id => id.substring(0, id.indexOf(':')) === platform);

    for (const fullId of platformAccounts) {
      const accountId = fullId.substring(fullId.indexOf(':') + 1);
      const postId = platform + '-' + accountId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      try {
        let body = { postId, accountId, content: content || '', scheduledAt };

        if (platform === 'fetlife') {
          body.postType = postType || 'status';
          if (eventDetails) body.eventDetails = eventDetails;
          if (images && images.length) body.images = images;
        } else if (platform === 'bluesky') {
          if (images && images.length) body.images = images;
        } else {
          // OnlyFans, Fansly, ManyVids, NiteFlirt — use media array
          const allMedia = media || images || [];
          if (allMedia.length) body.media = allMedia;
        }

        const result = await proxyRequest(platform, 'POST', '/posts', body);
        results.push(Object.assign({ platform, accountId, success: result.ok, postId }, result.data));
      } catch (err) {
        results.push({ platform, accountId, success: false, error: err.message });
      }
    }
  }

  res.json({ results });
});

app.delete('/api/posts/:platform/:postId', requireAuth, async (req, res) => {
  const { platform, postId } = req.params;
  try {
    const result = await proxyRequest(platform, 'DELETE', '/posts/' + postId);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/posts/:platform/:postId', requireAuth, async (req, res) => {
  const { platform, postId } = req.params;
  try {
    const result = await proxyRequest(platform, 'PATCH', '/posts/' + postId, req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FetLife-only: fan one event out to N groups under a single account.
app.post('/api/fetlife/group-event', requireAuth, async (req, res) => {
  const { accountId, eventUrl, title, body, groupIds, scheduledAt } = req.body;
  if (!accountId || !eventUrl || !title || !body || !scheduledAt) {
    return res.status(400).json({ error: 'accountId, eventUrl, title, body, scheduledAt required' });
  }
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: 'groupIds (non-empty array) required' });
  }
  const postId = 'fetlife-' + accountId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  try {
    const result = await proxyRequest('fetlife', 'POST', '/posts', {
      postId, accountId, postType: 'group_event',
      eventUrl, title, body, groupIds, scheduledAt,
    });
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── History ───────────────────────────────────────────────────────────────────

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const results = await Promise.allSettled(
      Object.keys(SERVICES).map(p => proxyRequest(p, 'GET', '/history?limit=50'))
    );
    const platforms = Object.keys(SERVICES);
    const history = [];
    results.forEach((r, i) => {
      const platform = platforms[i];
      const list = r.status === 'fulfilled' ? (r.value.data.history || []) : [];
      list.forEach(h => history.push(Object.assign({}, h, { platform })));
    });
    history.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/health/:service', async (req, res) => {
  const service = SERVICES[req.params.service];
  if (!service) return res.status(404).json({ error: 'Unknown service' });
  try {
    const r = await fetch(service.url + '/health');
    res.json(await r.json());
  } catch { res.status(503).json({ error: 'Service unreachable' }); }
});

app.get('/api/services', requireAuth, async (req, res) => {
  const statuses = {};
  await Promise.all(Object.entries(SERVICES).map(async ([name, svc]) => {
    try {
      const r = await fetch(svc.url + '/health');
      statuses[name] = r.ok ? 'online' : 'error';
    } catch { statuses[name] = 'offline'; }
  }));
  res.json({ statuses });
});

// ── Frontend ──────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('[nexuspost-ui] Running on http://0.0.0.0:' + PORT);
  console.log('[nexuspost-ui] FL secret:', process.env.FL_SERVICE_SECRET ? process.env.FL_SERVICE_SECRET.slice(0,6) + '...' : 'NOT SET');
});
