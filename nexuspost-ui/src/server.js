/**
 * FetPost UI Server
 * Currently ships with FetLife enabled. The cross-platform infrastructure for Bluesky /
 * OnlyFans / Fansly / ManyVids / NiteFlirt is dormant — flip `enabled: true` in the
 * PLATFORMS map (Index.html) and add a SERVICES entry below to bring one back.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as canva from './canva.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 4000;

app.use(express.json({ limit: '50mb' }));

const SERVICES = {
  fetlife: { url: 'http://127.0.0.1:3747', secret: process.env.FL_SERVICE_SECRET },
};

// Cookie script paths for each platform
// Cookie-extraction scripts are resolved relative to this file (so the package works from
// any install location) and per-OS (.cmd on Windows, .sh on Linux/macOS).
const COOKIE_EXT = process.platform === 'win32' ? 'cmd' : 'sh';
const COOKIE_SCRIPTS = {
  fetlife: path.resolve(__dirname, '..', '..', 'fetlife-poster', `start-cookies.${COOKIE_EXT}`),
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

// Append ?progress=1 to a proxied path when the client requested it. Used by every
// scrape-triggering refresh endpoint so the same proxy works for both sync and progress modes.
function withProgressFlag(reqPath, req) {
  return req.query.progress === '1'
    ? reqPath + (reqPath.includes('?') ? '&' : '?') + 'progress=1'
    : reqPath;
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
  const { platform, accountId, groupName, username, password, handle, appPassword, accountType } = req.body;
  if (!platform || !accountId) return res.status(400).json({ error: 'platform and accountId required' });
  try {
    let body;
    if (platform === 'bluesky') {
      if (!handle || !appPassword) return res.status(400).json({ error: 'handle and appPassword required' });
      body = { accountId, handle, appPassword, groupName };
    } else {
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });
      body = { accountId, username, password, groupName, accountType };
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

// Update mutable account fields (e.g. accountType: venue|organization|individual)
app.patch('/api/accounts/:platform/:accountId', requireAuth, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'PATCH', '/accounts/' + encodeURIComponent(accountId), req.body);
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
  const { platform, accountId } = req.params;
  const scriptPath = COOKIE_SCRIPTS[platform];
  if (!scriptPath) return res.status(400).json({ error: 'No cookie script for ' + platform });
  const force = req.query.force === '1' || (req.body && req.body.force);
  // Quote the accountId since it can contain spaces (e.g., "Crucible Rendezvous").
  const cmd = `"${scriptPath}" "${accountId.replace(/"/g, '\\"')}"`;
  // Long timeout — extractor waits up to 5 minutes for the UI "I've logged in" signal.
  req.setTimeout(8 * 60 * 1000);
  res.setTimeout(8 * 60 * 1000);
  const env = { ...process.env };
  if (force) env.FETPOST_FORCE_HEADED = '1';
  try {
    await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 8 * 60 * 1000, env });
    console.log(`[ui] Cookie extraction completed for ${platform}/${accountId}${force ? ' (forced VNC)' : ''}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[ui] Cookie extraction failed for ${platform}/${accountId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// User signals "I've logged in" from the UI; extractor (running headless) picks this up via the signal file.
app.post('/api/cookie-signal', requireAuth, async (req, res) => {
  try {
    fs.writeFileSync('/tmp/fetpost-cookie-signal', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Canva integration (OAuth + design picker) ───────────────────────────────

function canvaConfigured() {
  return !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET && process.env.CANVA_REDIRECT_URI);
}

app.get('/api/canva/status', requireAuth, async (req, res) => {
  try {
    res.json({
      configured: canvaConfigured(),
      connected: canvaConfigured() ? await canva.isConnected() : false,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 1: kick off OAuth — browser visits this and gets redirected to Canva.
// Not behind requireAuth because it has to work as a top-level browser navigation;
// we rely on the OAuth state parameter for CSRF protection.
app.get('/oauth/canva/authorize', (req, res) => {
  if (!canvaConfigured()) return res.status(400).send('Canva not configured. Set CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REDIRECT_URI in .env.');
  try {
    res.redirect(canva.buildAuthUrl(process.env.CANVA_REDIRECT_URI));
  } catch (err) { res.status(500).send('OAuth start failed: ' + err.message); }
});

// Step 2: Canva sends the user back here with a code.
app.get('/oauth/canva/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`<h2>Canva authorization failed</h2><pre>${error}: ${error_description || ''}</pre>`);
  if (!code || !state) return res.status(400).send('Missing code or state.');
  try {
    await canva.exchangeCodeForTokens(code, state, process.env.CANVA_REDIRECT_URI);
    res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center;background:#1a1a1a;color:#eee">
      <h2 style="color:#5fa">✓ Canva connected</h2>
      <p>You can close this tab and return to FetPost.</p>
      <script>setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
  }
});

app.post('/api/canva/disconnect', requireAuth, async (req, res) => {
  try { await canva.clearTokens(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/canva/designs', requireAuth, async (req, res) => {
  try {
    const result = await canva.listDesigns({ continuation: req.query.continuation });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Engagement metrics proxy ────────────────────────────────────────────────

app.get('/api/fetlife/cookies/freshness', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/cookies/freshness');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/cookies/refresh-status', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/cookies/refresh-status');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/metrics/post/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/metrics/post/refresh', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/metrics/post/:postId', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/metrics/post/' + encodeURIComponent(req.params.postId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/metrics/event/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/metrics/event/refresh', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/metrics/event/:eventId', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/metrics/event/' + encodeURIComponent(req.params.eventId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/canva/folder-items', requireAuth, async (req, res) => {
  const folderId = req.query.folderId || 'root';
  try {
    const result = await canva.listFolderItems(folderId, {
      continuation: req.query.continuation,
      itemTypes: req.query.itemTypes,
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pick a design → export → download → return as image attachment
app.post('/api/canva/import-design', requireAuth, async (req, res) => {
  const { designId, name, format } = req.body || {};
  if (!designId) return res.status(400).json({ error: 'designId required' });
  try {
    const urls = await canva.exportAndWait(designId, format || 'png');
    if (!urls.length) return res.status(500).json({ error: 'Export returned no URLs' });
    const attachment = await canva.fetchExportAsAttachment(urls[0], (name || 'canva-design') + (format === 'jpg' ? '.jpg' : '.png'));
    res.json({ success: true, image: attachment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Progress jobs (poll long-running scrapes) ───────────────────────────────
app.get('/api/fetlife/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/jobs/' + encodeURIComponent(req.params.jobId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/groups/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attending (RSVP'd) events — used by Venue accounts in the event picker as "Promoter Event"s.
app.get('/api/fetlife/:accountId/events/attending', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/attending/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tracked events
app.get('/api/fetlife/:accountId/events/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/events/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/tracked/refresh-all', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked/refresh-all', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tracked posts (engagement) proxies ─────────────────────────────────────

app.get('/api/fetlife/:accountId/posts/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/posts/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/posts/tracked', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/posts/tracked/refresh-all', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked/refresh-all', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates proxies ──────────────────────────────────────────────────────

app.get('/api/fetlife/:accountId/templates', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/templates', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/templates/:id', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates/' + encodeURIComponent(req.params.id));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/insights', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/insights');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/past', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/past');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/past/refresh', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/past/refresh', req));
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
  const { platforms, accountIds, content, scheduledAt, images, media, postType, eventDetails, eventUrl } = req.body;
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
          if (eventUrl) body.eventUrl = eventUrl;
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

app.put('/api/posts/:platform/:postId', requireAuth, async (req, res) => {
  const { platform, postId } = req.params;
  try {
    const result = await proxyRequest(platform, 'PUT', '/posts/' + encodeURIComponent(postId), req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:platform/:postId/retry', requireAuth, async (req, res) => {
  const { platform, postId } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/' + encodeURIComponent(postId) + '/retry');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:platform/clear-by-status', requireAuth, async (req, res) => {
  const { platform } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/clear-by-status', req.body);
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
  console.log('[fetpost-ui] Running on http://127.0.0.1:' + PORT);
  if (!process.env.FL_SERVICE_SECRET) {
    console.warn('[fetpost-ui] WARNING: FL_SERVICE_SECRET not set — UI cannot reach the FetLife service. Did you run setup.cmd?');
  }
  if (!process.env.UI_PASSWORD) {
    console.warn('[fetpost-ui] WARNING: UI_PASSWORD not set — using insecure default. Set it in .env');
  }
});
