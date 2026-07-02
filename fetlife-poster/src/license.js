/**
 * License enforcement — talks to the FetPost license Worker and gates posting.
 *
 * This service (fetlife-poster) owns the license because it's where posts actually
 * fire. nexuspost-ui proxies to the /license/* endpoints for the wizard + dashboard.
 *
 * Storage: data/license.json — the last-known license state, so the box keeps a sane
 * decision across restarts and short Worker/network outages:
 *   { key, status, plan, expiresAt, lastCheckedAt, lastKnownGoodAt, lastReason }
 *
 * Enforcement model (honest about its limits):
 *   - Enforcement is ACTIVE only when LICENSE_SERVER_URL is set. With it unset the box
 *     posts freely — that's the dev / public-repo / "unlicensed self-host" path, and it
 *     means a customer with root could disable enforcement by editing .env. That's fine:
 *     the point is to gate the distributed product and let us expire/revoke keys, not to
 *     be uncrackable against someone who owns the server.
 *   - A definite "no" from the Worker (expired / revoked / unknown) halts posting now.
 *   - If the Worker is unreachable we DON'T halt immediately — we honor a grace window off
 *     the last good check so a Worker blip (or our own account lapsing) never bricks a
 *     paying customer mid-cycle.
 */

import fs from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

const SERVER_URL = (process.env.LICENSE_SERVER_URL || '').replace(/\/+$/, '');
const REVALIDATE_MS = 6 * 60 * 60 * 1000;        // re-check every 6h
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;        // tolerate Worker unreachability this long
const VALIDATE_TIMEOUT_MS = 10_000;
// The grace-banner smoothing (don't alarm the operator until an "unreachable" run
// has lasted ~48h — NordVPN tunnel hiccups cause brief outages while the license
// itself is fine) is applied in the front end off `firstUnreachableAt`; see
// LICENSE_GRACE_BANNER_DELAY_MS in nexuspost-ui/public/index.html. Halt threshold
// (GRACE_MS) is unchanged and enforced server-side in isPostingAllowed().

// In-memory mirror of license.json so isPostingAllowed() is synchronous + fire-time cheap.
let state = {
  key: '',
  status: 'unconfigured',   // active | expired | revoked | unknown | unreachable | unconfigured | unenforced
  plan: null,
  expiresAt: null,
  lastCheckedAt: null,
  lastKnownGoodAt: null,
  lastReason: null,
  firstUnreachableAt: null, // when the current run of 'unreachable' started; null when reachable
};

function nowMs() { return Date.now(); }

// Hydrate `state` from disk synchronously at import time so the scheduler's boot-time
// restore (which can fire a due job immediately) sees the last persisted decision rather
// than the default 'unconfigured' — otherwise a valid license's due-at-boot post would be
// needlessly deferred 30 min. The async init() below layers network revalidation on top.
//
// File-missing is a normal first-boot state — defaults stand. File-present-but-corrupt
// is NOT normal; throwing here halts service start so the operator restores from backup
// before persist() overwrites the damaged file with whatever's in `state`.
if (existsSync(LICENSE_FILE)) {
  try {
    const data = JSON.parse(readFileSync(LICENSE_FILE, 'utf8'));
    state = { ...state, ...data };
  } catch (err) {
    throw new Error(
      'license.json present but failed to parse (' + err.message + '). ' +
      'Refusing to start with default state — restore from backup or delete the ' +
      'file to reset license state.'
    );
  }
}

async function persist() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await writeJsonAtomic(LICENSE_FILE, state);
  } catch (err) {
    console.warn('[license] could not persist license.json:', err.message);
  }
}

async function loadFromDisk() {
  // Mirrors the sync hydrate: missing = fresh start; present-but-corrupt = throw.
  const data = await readJsonStrict(LICENSE_FILE, { defaultIfMissing: null, label: 'license.json' });
  if (data) state = { ...state, ...data };
}

// POST {licenseKey} to the Worker. Returns the parsed body or throws on transport error.
async function callValidate(key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(SERVER_URL + '/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('license server HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Re-check the stored key against the Worker and fold the result into `state`. Never
 * throws — a transport failure becomes status 'unreachable' (which the grace window in
 * isPostingAllowed forgives). Returns the updated state.
 */
async function validateNow() {
  state.lastCheckedAt = new Date().toISOString();

  if (!SERVER_URL) { state.status = 'unenforced'; state.lastReason = 'no LICENSE_SERVER_URL'; await persist(); return state; }
  if (!state.key) { state.status = 'unconfigured'; state.lastReason = 'no license key'; await persist(); return state; }

  let body;
  try {
    body = await callValidate(state.key);
  } catch (err) {
    state.status = 'unreachable';
    state.lastReason = 'license server unreachable: ' + err.message;
    if (!state.firstUnreachableAt) state.firstUnreachableAt = new Date().toISOString();
    await persist();
    return state;
  }

  // Got a response — clear the unreachable timer regardless of valid/invalid.
  state.firstUnreachableAt = null;

  if (body && body.valid) {
    state.status = 'active';
    state.plan = body.plan || state.plan;
    state.expiresAt = body.expiresAt || state.expiresAt;
    state.lastKnownGoodAt = new Date().toISOString();
    state.lastReason = null;
  } else {
    // Definite negative from the Worker — trust it and record why.
    state.status = (body && body.reason) || 'unknown';
    if (body && body.expiresAt) state.expiresAt = body.expiresAt;
    state.lastReason = (body && body.reason) || 'invalid';
  }
  await persist();
  return state;
}

/**
 * Activate a key entered during the wizard. Validates against the Worker; only stores the
 * key if the Worker says it's live. Returns { ok, state, reason }.
 */
async function activate(key) {
  const trimmed = String(key || '').trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: 'missing_key' };
  if (!SERVER_URL) {
    // Unenforced mode (dev / public repo): accept the key without a round-trip so setup
    // still completes when no license server is wired up.
    state.key = trimmed;
    state.status = 'unenforced';
    state.lastReason = 'no LICENSE_SERVER_URL';
    await persist();
    return { ok: true, state, unenforced: true };
  }

  let body;
  try {
    body = await callValidate(trimmed);
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
  if (!body || !body.valid) {
    return { ok: false, reason: (body && body.reason) || 'invalid', expiresAt: body && body.expiresAt };
  }
  // Good key — store it and seed state from the response.
  state.key = trimmed;
  state.status = 'active';
  state.plan = body.plan || null;
  state.expiresAt = body.expiresAt || null;
  state.lastCheckedAt = new Date().toISOString();
  state.lastKnownGoodAt = new Date().toISOString();
  state.lastReason = null;
  state.firstUnreachableAt = null;
  await persist();
  return { ok: true, state };
}

/**
 * Synchronous fire-time decision from the cached state — no network call. Returns
 * { allowed, reason, status, expiresAt }.
 */
function isPostingAllowed() {
  // Enforcement off entirely.
  if (state.status === 'unenforced' || !SERVER_URL) {
    return { allowed: true, reason: 'unenforced', status: 'unenforced', expiresAt: state.expiresAt };
  }
  // Locally-known expiry always wins, even if the last check was 'active'.
  if (state.expiresAt && new Date(state.expiresAt).getTime() < nowMs()) {
    return { allowed: false, reason: 'expired', status: 'expired', expiresAt: state.expiresAt };
  }
  if (state.status === 'active') {
    return { allowed: true, reason: 'active', status: 'active', expiresAt: state.expiresAt };
  }
  // Worker unreachable — forgive within the grace window off the last good check.
  if (state.status === 'unreachable') {
    const anchor = state.lastKnownGoodAt ? new Date(state.lastKnownGoodAt).getTime() : 0;
    if (anchor && nowMs() - anchor < GRACE_MS) {
      return { allowed: true, reason: 'grace', status: 'grace', expiresAt: state.expiresAt };
    }
    return { allowed: false, reason: 'grace_expired', status: 'unreachable', expiresAt: state.expiresAt };
  }
  // revoked / unknown / unconfigured — hard halt.
  return { allowed: false, reason: state.status, status: state.status, expiresAt: state.expiresAt };
}

// Public read of the cached state, plus the derived posting decision, for the dashboard.
function getState() {
  return { ...state, posting: isPostingAllowed(), serverConfigured: !!SERVER_URL };
}

// Boot: load disk state, kick a best-effort validation, then revalidate every 6h.
async function init() {
  await loadFromDisk();
  validateNow().catch(err => console.warn('[license] initial validation failed:', err.message));
  setInterval(() => {
    validateNow().catch(err => console.warn('[license] periodic validation failed:', err.message));
  }, REVALIDATE_MS);
  if (SERVER_URL) console.log('[license] enforcement active against ' + SERVER_URL);
  else console.log('[license] enforcement OFF (no LICENSE_SERVER_URL) — posting unrestricted');
}

export { init, activate, validateNow, isPostingAllowed, getState };
