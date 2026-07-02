/**
 * Service-token store for machine-to-machine API access.
 *
 * Storage: data/service-tokens.json — { tokens: [...] }
 *
 * Token format on the wire: `fpst.<tokenId>.<secret>`
 *   - tokenId is the public lookup key (no secret material).
 *   - secret is scrypt-hashed at rest, so the JSON file can't be used to forge a token.
 *
 * Scopes (v1): "events:read", "accounts:read".
 *   - accountIds[] is required and non-empty; bearer never gets implicit access to all.
 *   - service callers fail requireEditor (no write scopes exist yet).
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'service-tokens.json');

export const SCOPES = ['events:read', 'accounts:read'];
const TOKEN_PREFIX = 'fpst';
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 1000;

let cachedTokens = null;
let writeLock = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function withLock(work) {
  const run = writeLock.then(work, work);
  writeLock = run.catch(() => {});
  return run;
}

function newId() {
  return 'tok_' + crypto.randomBytes(9).toString('base64url');
}

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { salt, hash, algo: 'scrypt', N: 16384 };
}

function verifySecretHash(plain, record) {
  if (!record || !record.salt || !record.hash) return false;
  try {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = crypto.scryptSync(plain, record.salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function stripToken(token) {
  if (!token) return null;
  const { secretHash, ...rest } = token;
  return rest;
}

async function load() {
  if (cachedTokens) return cachedTokens;
  ensureDataDir();
  const loaded = await readJsonStrict(TOKENS_FILE, {
    defaultIfMissing: { tokens: [] },
    label: 'service-tokens.json',
  });
  if (!Array.isArray(loaded.tokens)) loaded.tokens = [];
  cachedTokens = loaded;
  return cachedTokens;
}

async function save() {
  ensureDataDir();
  await writeJsonAtomic(TOKENS_FILE, cachedTokens);
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array');
  }
  for (const s of scopes) {
    if (!SCOPES.includes(s)) throw new Error(`Unknown scope: ${s}`);
  }
}

function validateAccountIds(accountIds) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error('accountIds must be a non-empty array (service tokens never get implicit-all)');
  }
  for (const id of accountIds) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('accountIds entries must be non-empty strings');
  }
}

export async function listTokens() {
  const store = await load();
  return store.tokens.map(stripToken);
}

export async function createToken({ name, scopes, accountIds, createdByUserId }) {
  return withLock(async () => {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('name required');
    validateScopes(scopes);
    validateAccountIds(accountIds);
    const store = await load();
    const id = newId();
    const secret = newSecret();
    const record = {
      id,
      name: cleanName,
      secretHash: hashSecret(secret),
      scopes: scopes.slice(),
      accountIds: accountIds.slice(),
      createdAt: new Date().toISOString(),
      createdByUserId: createdByUserId || null,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
    };
    store.tokens.push(record);
    await save();
    // The full token is returned ONCE; we never store it.
    return {
      token: `${TOKEN_PREFIX}.${id}.${secret}`,
      record: stripToken(record),
    };
  });
}

export async function revokeToken(id, { revokedByUserId } = {}) {
  return withLock(async () => {
    const store = await load();
    const token = store.tokens.find(t => t.id === id);
    if (!token) throw new Error('Token not found');
    if (token.revokedAt) return stripToken(token);
    token.revokedAt = new Date().toISOString();
    token.revokedByUserId = revokedByUserId || null;
    await save();
    return stripToken(token);
  });
}

export async function deleteToken(id) {
  return withLock(async () => {
    const store = await load();
    const idx = store.tokens.findIndex(t => t.id === id);
    if (idx < 0) throw new Error('Token not found');
    store.tokens.splice(idx, 1);
    await save();
  });
}

/**
 * Verify a bearer token string. Returns the (stripped) token record on success,
 * null otherwise. Side-effect: touches lastUsedAt if more than 60s since last touch.
 */
export async function verifyBearer(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, id, secret] = parts;
  const store = await load();
  const token = store.tokens.find(t => t.id === id);
  if (!token || token.revokedAt) return null;
  if (!verifySecretHash(secret, token.secretHash)) return null;
  const now = Date.now();
  const lastTouch = token.lastUsedAt ? new Date(token.lastUsedAt).getTime() : 0;
  if (now - lastTouch > LAST_USED_TOUCH_INTERVAL_MS) {
    token.lastUsedAt = new Date(now).toISOString();
    // Fire-and-forget; not load-bearing for correctness.
    save().catch(() => {});
  }
  return stripToken(token);
}

export function hasScope(token, scope) {
  return !!(token && Array.isArray(token.scopes) && token.scopes.includes(scope));
}

export function canAccessAccount(token, accountId) {
  if (!token || !accountId) return false;
  return Array.isArray(token.accountIds) && token.accountIds.includes(accountId);
}
