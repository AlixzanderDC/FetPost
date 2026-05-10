/**
 * Canva Connect API client + encrypted token store.
 * OAuth 2.0 with PKCE (Authorization Code flow).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'canva-tokens.enc');

const AUTH_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE = 'https://api.canva.com/rest/v1';
const SCOPES = 'design:meta:read design:content:read folder:read';

// ── Encryption (mirrors fetlife-poster/credentials.js so tokens-at-rest are protected) ──

const KEYLEN = 32;
const IVLEN = 16;
const TAGLEN = 16;
const SALT = 'fetpost-canva-v1';

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
  return process.env.FL_MACHINE_SECRET || (process.platform + '-' + process.arch + '-fetpost');
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
  try { await fs.unlink(TOKENS_FILE); } catch {}
}
export async function isConnected() {
  return (await loadTokens()) !== null;
}

// ── PKCE + OAuth state (in-memory; lost on restart, fine for short-lived auth flow) ──

const pendingAuth = new Map(); // state -> { codeVerifier, createdAt }
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 min

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
  if (!process.env.CANVA_CLIENT_ID) throw new Error('CANVA_CLIENT_ID not set');
  purgeOldPending();
  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  pendingAuth.set(state, { codeVerifier, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CANVA_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
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
    client_id: process.env.CANVA_CLIENT_ID,
  });

  const auth = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const json = await res.json();

  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000, // refresh 1 min early
    scope: json.scope,
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(tokens) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: process.env.CANVA_CLIENT_ID,
  });
  const auth = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const next = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || tokens.refreshToken, // some IdPs don't rotate
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    scope: json.scope || tokens.scope,
  };
  await saveTokens(next);
  return next;
}

async function ensureValidToken() {
  let tokens = await loadTokens();
  if (!tokens) throw new Error('Canva not connected — visit /oauth/canva/authorize first');
  if (Date.now() >= tokens.expiresAt) tokens = await refreshAccessToken(tokens);
  return tokens.accessToken;
}

async function canvaFetch(pathname, opts = {}) {
  const token = await ensureValidToken();
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Canva API ${res.status}: ${json.message || text || res.statusText}`);
  return json;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listDesigns({ continuation } = {}) {
  const params = new URLSearchParams();
  if (continuation) params.set('continuation', continuation);
  const qs = params.toString();
  return await canvaFetch(`/designs${qs ? '?' + qs : ''}`);
}

/**
 * List items inside a folder. Pass folderId="root" for the user's top-level Projects folder.
 * Returns { items: [{ type: 'folder'|'design'|'image', folder?, design?, image? }, ...], continuation? }
 */
export async function listFolderItems(folderId = 'root', { continuation, itemTypes } = {}) {
  const params = new URLSearchParams();
  if (continuation) params.set('continuation', continuation);
  if (itemTypes) params.set('item_types', itemTypes); // comma-separated
  const qs = params.toString();
  return await canvaFetch(`/folders/${encodeURIComponent(folderId)}/items${qs ? '?' + qs : ''}`);
}

export async function createExport(designId, format = 'png') {
  const formatBody = format === 'jpg'
    ? { type: 'jpg', quality: 95 }
    : { type: 'png' };
  return await canvaFetch('/exports', {
    method: 'POST',
    body: JSON.stringify({ design_id: designId, format: formatBody }),
  });
}

export async function getExport(jobId) {
  return await canvaFetch(`/exports/${jobId}`);
}

/**
 * High-level: kick off an export job and poll until it's done. Returns the URL list.
 * Times out after 60s.
 */
export async function exportAndWait(designId, format = 'png') {
  const initial = await createExport(designId, format);
  let job = initial.job || initial;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (job.status === 'success' || job.status === 'failed') break;
    await new Promise(r => setTimeout(r, 1500));
    const next = await getExport(job.id);
    job = next.job || next;
  }
  if (job.status !== 'success') throw new Error(`Export ${job.status || 'timed out'}: ${job.error?.message || ''}`);
  return job.urls || [];
}

/**
 * Download an exported asset and return it as { data: <base64>, mimeType, name } —
 * the same shape FetPost uses for image attachments.
 */
export async function fetchExportAsAttachment(url, name = 'canva-design.png') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || (name.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
  return { data: buf.toString('base64'), mimeType, name, altText: name };
}
