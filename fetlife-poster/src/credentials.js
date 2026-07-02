/**
 * Credential storage — uses OS keychain via keytar where available,
 * falls back to AES-256-GCM encrypted JSON file.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, writeRawAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');
const META_FILE = path.join(DATA_DIR, 'accounts.json');

// Serialize every credentials/meta mutation so a Playwright finishing in the
// background and a dashboard click on the same account can't both load the same
// snapshot and overwrite each other. There's only one creds file + one meta file,
// so a single chain suffices (no per-account split).
let credsOpChain = Promise.resolve();
function mutateCreds(work) {
  const next = credsOpChain.then(async () => work());
  credsOpChain = next.catch(() => {});
  return next;
}

// Derive encryption key from machine-specific secret. The fallback `getMachineId()`
// returns a publicly-knowable string (e.g. "linux-x64-fetpost") — fine for local dev
// but it makes credentials.enc effectively decryptable by anyone who reads the repo.
// In production we REQUIRE FL_MACHINE_SECRET to be set to a long random hex string;
// the boot guard below halts the service if it's missing so a botched .env restore
// can't silently re-key the credentials store with a weak key (and corrupt every
// already-encrypted entry the next time `storeCredentials` runs).
const FL_MACHINE_SECRET_RAW = process.env.FL_MACHINE_SECRET || '';
const MACHINE_SECRET = FL_MACHINE_SECRET_RAW || getMachineId();
const KEYLEN = 32; // AES-256
const IVLEN = 16;
const TAGLEN = 16;
const SALT = 'fetlife-poster-v1';

function getMachineId() {
  // Note: this fallback is ONLY used when FETPOST_DEV=1 is set (production path
  // refuses to boot without FL_MACHINE_SECRET — see the guard below). The string
  // matters because changing it changes the derived AES key — any existing
  // credentials.enc encrypted with the previous string ("-nexuspost") becomes
  // undecryptable. The Sprint 1 decrypt-failure path throws with a recovery hint.
  return process.platform + '-' + process.arch + '-fetpost';
}

// Boot guard. Allow the weak fallback only when `FETPOST_DEV=1` is set explicitly
// (dev convenience), and even then print a loud warning. In any other context refuse
// to start. 32 hex chars = 128 bits of entropy is the minimum we accept.
if (!FL_MACHINE_SECRET_RAW) {
  if (process.env.FETPOST_DEV === '1') {
    console.warn(
      '[credentials] FL_MACHINE_SECRET is unset — using a hardcoded fallback key. ' +
      'This is acceptable for local dev only. Set FL_MACHINE_SECRET in .env before ' +
      'storing any real credentials.'
    );
  } else {
    throw new Error(
      'FL_MACHINE_SECRET is required (32+ hex chars). Generate with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and append to .env. Set FETPOST_DEV=1 if you intentionally want the weak ' +
      'fallback for local development.'
    );
  }
} else if (!/^[0-9a-fA-F]{32,}$/.test(FL_MACHINE_SECRET_RAW)) {
  // A short or non-hex value is almost certainly a misconfiguration (typo, blank line,
  // placeholder text). Fail loud — a weak secret silently degrades AES to "discoverable".
  throw new Error(
    'FL_MACHINE_SECRET must be at least 32 hex characters (got length ' +
    FL_MACHINE_SECRET_RAW.length + '). Fix .env and restart.'
  );
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
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadAllCredentials() {
  let raw;
  try {
    raw = await fs.readFile(CREDS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  // Distinguish "file missing" (legitimate first-boot) from "file present but unreadable"
  // (corruption / wrong machine secret / partial write). The old behaviour returned `{}`
  // for both, which meant the next save overwrote the original — silent total data loss.
  let decrypted;
  try {
    decrypted = decrypt(raw.trim(), MACHINE_SECRET);
  } catch (err) {
    throw new Error(
      'credentials.enc failed to decrypt (' + err.message + '). Possible causes: ' +
      'FL_MACHINE_SECRET changed since the file was written, the file was corrupted ' +
      'by a partial write, or the file was copied between machines without the secret. ' +
      'Refusing to load empty state — restore from backup before restarting.'
    );
  }
  try {
    return JSON.parse(decrypted);
  } catch (err) {
    throw new Error(
      'credentials.enc decrypted but the plaintext was not JSON (' + err.message + '). ' +
      'File is likely corrupt — restore from backup before restarting.'
    );
  }
}

async function saveAllCredentials(creds) {
  await ensureDataDir();
  const json = JSON.stringify(creds);
  const encrypted = encrypt(json, MACHINE_SECRET);
  // Atomic write: stage to .tmp, fsync, then rename(2) over credentials.enc. A crash
  // mid-write now leaves the live file untouched instead of truncated-and-unreadable.
  await writeRawAtomic(CREDS_FILE, encrypted);
}

async function loadMeta() {
  // accounts.json is recoverable from credentials.enc + usernames if it gets nuked,
  // so a missing file is treated as "fresh start". But a present-but-corrupt file
  // throws — we never want to silently overwrite an operator-edited file.
  return await readJsonStrict(META_FILE, { defaultIfMissing: {}, label: 'accounts.json' });
}

async function saveMeta(meta) {
  await ensureDataDir();
  await writeJsonAtomic(META_FILE, meta);
}

// ── Public API ────────────────────────────────────────────────────────────────

// 'festival' covers conferences, festivals, and hotel takeovers — accounts whose
// marketing follows a multi-month arc with drip announcements (educators, special
// events), registration campaigns (ticket tiers, hotel block, early bird), and
// rolling info campaigns. Treated like 'organization' for the legacy posting paths
// but unlocks the Campaigns tab in the UI.
const VALID_ACCOUNT_TYPES = ['venue', 'organization', 'individual', 'festival'];

export async function storeCredentials(accountId, { username, password, groupName, accountType }) {
  return await mutateCreds(async () => {
    const [creds, meta] = await Promise.all([loadAllCredentials(), loadMeta()]);

    // Credentials stored encrypted
    creds[accountId] = { username, password };
    await saveAllCredentials(creds);

    // Preserve every existing per-account meta field when re-storing — common
    // case is the operator updating just the password by re-adding the account
    // with the same accountId. Wiping the meta would silently lose autoSignature,
    // eventPromoTemplate, digestTitle, digestFooter, websiteCalendarUrl, paused,
    // hiddenCalendarEvents, etc. Only fields explicitly passed get overwritten.
    const existing = meta[accountId] || {};
    const type = accountType && VALID_ACCOUNT_TYPES.includes(accountType)
      ? accountType
      : (existing.accountType && VALID_ACCOUNT_TYPES.includes(existing.accountType) ? existing.accountType : 'organization');

    meta[accountId] = {
      ...existing,
      accountId,
      username,
      groupName: groupName !== undefined && groupName !== null ? groupName : (existing.groupName || null),
      accountType: type,
      addedAt: existing.addedAt || new Date().toISOString(),
      lastUsed: existing.lastUsed || null,
      lastStatus: existing.lastStatus || null,
    };
    await saveMeta(meta);
  });
}

// Surgical password-only update — used by the dashboard "Change password" UI.
// Doesn't touch any per-account meta (autoSignature, eventPromoTemplate, etc.)
// and doesn't require the operator to re-enter their username/groupName/etc.
// just to swap a password after rotating it on FetLife.
export async function updatePassword(accountId, newPassword) {
  if (!newPassword) throw new Error('newPassword required');
  return await mutateCreds(async () => {
    const creds = await loadAllCredentials();
    if (!creds[accountId]) throw new Error('Unknown account: ' + accountId);
    creds[accountId].password = newPassword;
    await saveAllCredentials(creds);
  });
}

export async function updateAccountType(accountId, accountType) {
  if (!VALID_ACCOUNT_TYPES.includes(accountType)) {
    throw new Error('accountType must be one of: ' + VALID_ACCOUNT_TYPES.join(', '));
  }
  return await mutateCreds(async () => {
    const meta = await loadMeta();
    if (!meta[accountId]) throw new Error('Unknown account: ' + accountId);
    meta[accountId].accountType = accountType;
    await saveMeta(meta);
    return meta[accountId];
  });
}

/**
 * Merge arbitrary key/value fields into an account's metadata. Used by features
 * (Discord webhook URL, auto-signature text, notification prefs, etc.) that need
 * per-account config without each one inventing its own store. Refuses to touch
 * the few fields owned by credentials/auth flow.
 */
const PROTECTED_FIELDS = new Set(['accountId', 'username', 'password', 'addedAt', 'lastStatus', 'lastUsed', 'accountType']);
export async function updateAccountFields(accountId, patch) {
  return await mutateCreds(async () => {
    const meta = await loadMeta();
    if (!meta[accountId]) throw new Error('Unknown account: ' + accountId);
    for (const [k, v] of Object.entries(patch || {})) {
      if (PROTECTED_FIELDS.has(k)) continue;
      if (v === null || v === '') {
        delete meta[accountId][k];
      } else {
        meta[accountId][k] = v;
      }
    }
    await saveMeta(meta);
    return meta[accountId];
  });
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
  return await mutateCreds(async () => {
    const [creds, meta] = await Promise.all([loadAllCredentials(), loadMeta()]);
    delete creds[accountId];
    delete meta[accountId];
    await Promise.all([saveAllCredentials(creds), saveMeta(meta)]);
  });
}

export async function updateAccountStatus(accountId, status) {
  return await mutateCreds(async () => {
    const meta = await loadMeta();
    if (meta[accountId]) {
      meta[accountId].lastUsed = new Date().toISOString();
      meta[accountId].lastStatus = status;
      await saveMeta(meta);
    }
  });
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
