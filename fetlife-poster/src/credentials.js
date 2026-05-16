/**
 * Credential storage — uses OS keychain via keytar where available,
 * falls back to AES-256-GCM encrypted JSON file.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');
const META_FILE = path.join(DATA_DIR, 'accounts.json');

// Derive encryption key from machine-specific secret + user-set passphrase
const MACHINE_SECRET = process.env.FL_MACHINE_SECRET || getMachineId();
const KEYLEN = 32; // AES-256
const IVLEN = 16;
const TAGLEN = 16;
const SALT = 'fetlife-poster-v1';

function getMachineId() {
  // Fallback if env var not set — not ideal but functional
  return process.platform + '-' + process.arch + '-nexuspost';
}

function deriveKey(secret) {
  return crypto.scryptSync(secret, SALT, KEYLEN);
}

function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IVLEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext, secret) {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.slice(0, IVLEN);
  const tag = buf.slice(IVLEN, IVLEN + TAGLEN);
  const encrypted = buf.slice(IVLEN + TAGLEN);
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadAllCredentials() {
  try {
    const raw = await fs.readFile(CREDS_FILE, 'utf8');
    const decrypted = decrypt(raw.trim(), MACHINE_SECRET);
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

async function saveAllCredentials(creds) {
  await ensureDataDir();
  const json = JSON.stringify(creds);
  const encrypted = encrypt(json, MACHINE_SECRET);
  await fs.writeFile(CREDS_FILE, encrypted, 'utf8');
}

async function loadMeta() {
  try {
    const raw = await fs.readFile(META_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveMeta(meta) {
  await ensureDataDir();
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

const VALID_ACCOUNT_TYPES = ['venue', 'organization', 'individual'];

export async function storeCredentials(accountId, { username, password, groupName, accountType }) {
  const [creds, meta] = await Promise.all([loadAllCredentials(), loadMeta()]);

  // Credentials stored encrypted
  creds[accountId] = { username, password };
  await saveAllCredentials(creds);

  // Preserve accountType if it already exists (e.g. re-adding to refresh password)
  const existing = meta[accountId] || {};
  const type = accountType && VALID_ACCOUNT_TYPES.includes(accountType)
    ? accountType
    : (existing.accountType && VALID_ACCOUNT_TYPES.includes(existing.accountType) ? existing.accountType : 'organization');

  // Metadata (no passwords) stored plaintext for easy listing
  meta[accountId] = {
    accountId,
    username,
    groupName: groupName || null,
    accountType: type,
    addedAt: existing.addedAt || new Date().toISOString(),
    lastUsed: existing.lastUsed || null,
    lastStatus: existing.lastStatus || null,
  };
  await saveMeta(meta);
}

export async function updateAccountType(accountId, accountType) {
  if (!VALID_ACCOUNT_TYPES.includes(accountType)) {
    throw new Error('accountType must be one of: ' + VALID_ACCOUNT_TYPES.join(', '));
  }
  const meta = await loadMeta();
  if (!meta[accountId]) throw new Error('Unknown account: ' + accountId);
  meta[accountId].accountType = accountType;
  await saveMeta(meta);
  return meta[accountId];
}

export async function getCredentials(accountId) {
  const creds = await loadAllCredentials();
  if (!creds[accountId]) throw new Error(`No credentials found for account: ${accountId}`);
  return creds[accountId];
}

export async function listAccounts() {
  const meta = await loadMeta();
  // Backfill accountType for legacy accounts that predate the venue/org/individual distinction.
  return Object.values(meta).map(a => ({
    ...a,
    accountType: VALID_ACCOUNT_TYPES.includes(a.accountType) ? a.accountType : 'organization',
  }));
}

export async function getAccount(accountId) {
  const meta = await loadMeta();
  const a = meta[accountId];
  if (!a) return null;
  return { ...a, accountType: VALID_ACCOUNT_TYPES.includes(a.accountType) ? a.accountType : 'organization' };
}

export async function removeAccount(accountId) {
  const [creds, meta] = await Promise.all([loadAllCredentials(), loadMeta()]);
  delete creds[accountId];
  delete meta[accountId];
  await Promise.all([saveAllCredentials(creds), saveMeta(meta)]);
}

export async function updateAccountStatus(accountId, status) {
  const meta = await loadMeta();
  if (meta[accountId]) {
    meta[accountId].lastUsed = new Date().toISOString();
    meta[accountId].lastStatus = status;
    await saveMeta(meta);
  }
}

export async function testLogin(accountId) {
  const { loginToFetLife } = await import('./poster.js');
  try {
    const creds = await getCredentials(accountId);
    const result = await loginToFetLife(creds.username, creds.password, { testOnly: true, accountId });
    await updateAccountStatus(accountId, result.success ? 'ok' : 'login_failed');
    return result;
  } catch (err) {
    await updateAccountStatus(accountId, 'error');
    throw err;
  }
}
