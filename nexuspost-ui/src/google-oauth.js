/**
 * Google OAuth 2.0 (PKCE) + Sheets API client + encrypted token store.
 * Same shape as canva.js — separate SALT and TOKENS_FILE so the two
 * integrations don't collide.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'google-tokens.enc');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4';

// spreadsheets: read+write any sheet the user has access to (most flexible — they paste a URL)
// drive.file:   create new sheets via the API (drive.file = "only files this app creates",
//               narrowest scope that allows spreadsheets.create — required by Google for
//               the Create-new-sheet flow; not needed for push-only).
// userinfo.email: so we can show "Connected as foo@gmail.com" in the UI
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── Encryption (mirrors canva.js / fetlife-poster's credentials.js) ──

const KEYLEN = 32;
const IVLEN = 16;
const TAGLEN = 16;
const SALT = 'fetpost-google-v1';

function deriveKey(secret) {
  return crypto.scryptSync(secret, SALT, KEYLEN);
}
function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IVLEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function decrypt(b64, secret) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0, IVLEN);
  const tag = buf.slice(IVLEN, IVLEN + TAGLEN);
  const ct = buf.slice(IVLEN + TAGLEN);
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

function machineSecret() {
  // Fail closed: without FL_MACHINE_SECRET the old fallback derived the token-encryption
  // key from process.platform+arch — a value any attacker knows — so the OAuth tokens
  // at rest would be trivially decryptable. Refuse rather than encrypt with a public key.
  const s = process.env.FL_MACHINE_SECRET;
  if (!s) throw new Error('FL_MACHINE_SECRET is not set — refusing to encrypt/decrypt Google tokens with a predictable key');
  return s;
}

async function loadTokens() {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(decrypt(raw.trim(), machineSecret()));
  } catch { return null; }
}
async function saveTokens(tokens) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKENS_FILE, encrypt(JSON.stringify(tokens), machineSecret()), 'utf8');
}
export async function clearTokens() {
  const tokens = await loadTokens();
  if (tokens?.accessToken) {
    // Best-effort revoke at Google's end too
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(tokens.accessToken)}`, { method: 'POST' });
    } catch {}
  }
  try { await fs.unlink(TOKENS_FILE); } catch {}
}
export async function isConnected() {
  const t = await loadTokens();
  return !!(t && t.refreshToken);
}
export async function connectedEmail() {
  const t = await loadTokens();
  return t?.email || null;
}

// ── PKCE + OAuth state ──

const pendingAuth = new Map(); // state -> { codeVerifier, createdAt }
const PKCE_TTL_MS = 10 * 60 * 1000;

function purgeOldPending() {
  const cutoff = Date.now() - PKCE_TTL_MS;
  for (const [state, entry] of pendingAuth) {
    if (entry.createdAt < cutoff) pendingAuth.delete(state);
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function buildAuthUrl(redirectUri) {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) throw new Error('GOOGLE_OAUTH_CLIENT_ID not set');
  purgeOldPending();
  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  pendingAuth.set(state, { codeVerifier, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // 'offline' = give us a refresh_token. 'consent' = always show the consent screen
    // so Google reissues a refresh_token (Google only returns it on first consent
    // unless prompted again — biting people in production all the time).
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function fetchUserEmail(accessToken) {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const json = await res.json();
    return json.email || null;
  } catch { return null; }
}

export async function exchangeCodeForTokens(code, state, redirectUri) {
  const entry = pendingAuth.get(state);
  if (!entry) throw new Error('Unknown or expired OAuth state');
  pendingAuth.delete(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: entry.codeVerifier,
    redirect_uri: redirectUri,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const json = await res.json();

  if (!json.refresh_token) {
    // Should not happen with prompt=consent + access_type=offline, but guard anyway
    throw new Error('Google did not return a refresh_token — try disconnecting first, then reconnect (Google only issues it on fresh consent)');
  }

  const email = await fetchUserEmail(json.access_token);
  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    scope: json.scope,
    email,
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(tokens) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const next = {
    ...tokens,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    scope: json.scope || tokens.scope,
    // refresh_token usually not rotated by Google; keep the existing one
    refreshToken: json.refresh_token || tokens.refreshToken,
  };
  await saveTokens(next);
  return next;
}

async function ensureValidToken() {
  let tokens = await loadTokens();
  if (!tokens) throw new Error('Google not connected — visit /oauth/google/authorize first');
  if (Date.now() >= tokens.expiresAt) tokens = await refreshAccessToken(tokens);
  return tokens.accessToken;
}

async function googleFetch(url, opts = {}) {
  const token = await ensureValidToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json.error?.message || json.error_description || text || res.statusText;
    throw new Error(`Google API ${res.status}: ${msg}`);
  }
  return json;
}

// ── Sheets helpers ────────────────────────────────────────────────────────────

/**
 * Extract a spreadsheet ID from either a raw ID or a full Sheets URL.
 * Returns null if it can't find one.
 */
export function parseSheetId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Already an ID (no slashes, reasonable length)
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  // Full URL: https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

export async function getSheetInfo(spreadsheetId) {
  return await googleFetch(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties.title,sheets.properties.sheetId,spreadsheetUrl`);
}

/**
 * Create a new spreadsheet in the connected user's Drive. The first tab is
 * named `firstTabName` (defaults to "Mentions"). Returns { spreadsheetId, spreadsheetUrl, title }.
 */
export async function createSpreadsheet(title, firstTabName = 'Mentions') {
  const body = {
    properties: { title },
    sheets: [{ properties: { title: firstTabName } }],
  };
  const json = await googleFetch(`${SHEETS_BASE}/spreadsheets`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    spreadsheetId: json.spreadsheetId,
    spreadsheetUrl: json.spreadsheetUrl,
    title: json.properties?.title,
  };
}

/**
 * Append rows to a sheet. `rows` is a 2D array (rows × columns). The sheet
 * named `tabName` is created if it doesn't exist. valueInputOption=USER_ENTERED
 * makes Google parse dates, URLs, formulas, etc. as it would for a manual paste.
 */
export async function appendRows(spreadsheetId, tabName, rows) {
  if (!rows || !rows.length) return { updates: { updatedRows: 0 } };

  // Ensure tab exists; if not, create it. We also write the header row on creation.
  const info = await getSheetInfo(spreadsheetId);
  const existingTabs = (info.sheets || []).map(s => s.properties?.title).filter(Boolean);
  if (!existingTabs.includes(tabName)) {
    await googleFetch(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tabName } } }],
      }),
    });
  }

  const range = `${tabName}!A1`;
  return await googleFetch(
    `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({ values: rows }),
    }
  );
}

/**
 * Read the existing first column of a tab so we can dedupe against post URLs
 * already pushed. Returns a Set of strings.
 */
export async function readExistingValuesInColumn(spreadsheetId, tabName, column = 'C') {
  try {
    const range = `${tabName}!${column}:${column}`;
    const json = await googleFetch(
      `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
    );
    const values = json.values || [];
    return new Set(values.flat().filter(Boolean));
  } catch {
    return new Set();
  }
}
