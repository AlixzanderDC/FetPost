/**
 * Multi-user auth + role-based authorization for the FetPost UI.
 *
 * Storage:
 *   data/users.json     — { users: [...], passwordResetTokens: [...] }
 *   data/sessions.json  — [{ token, userId, createdAt, lastSeenAt }]
 *
 * Roles (precedence: admin > editor > viewer):
 *   - admin   — sees every account; can manage users; bypasses scope
 *   - editor  — read+write on accounts in allowedAccountIds
 *   - viewer  — read-only on accounts in allowedAccountIds
 *
 * Sessions are persisted so a service restart doesn't kick everyone out.
 * Password hashing uses scrypt (Node built-in) — same KDF the legacy admin.json used,
 * so the legacy hash can migrate in-place into the new schema.
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonStrict } from './util/atomic-json.js';
import { verifyBearer } from './service-tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LEGACY_ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const ROLES = ['admin', 'editor', 'viewer'];

let cachedUsers = null;
let cachedSessions = null;
let writeLock = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Serialize all writes — both users.json and sessions.json see a steady stream of
// mutations and we don't want a login racing with a user-update to clobber state.
function withLock(work) {
  const run = writeLock.then(work, work);
  writeLock = run.catch(() => {});
  return run;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { salt, hash, algo: 'scrypt', N: 16384 };
}

function verifyPasswordHash(plain, record) {
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

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function stripUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function loadUsers() {
  if (cachedUsers) return cachedUsers;
  ensureDataDir();
  // Migrate legacy admin.json → users.json on first run after upgrade.
  if (!fs.existsSync(USERS_FILE) && fs.existsSync(LEGACY_ADMIN_FILE)) {
    let legacy = null;
    try {
      legacy = JSON.parse(fs.readFileSync(LEGACY_ADMIN_FILE, 'utf8'));
    } catch {}
    if (legacy && legacy.salt && legacy.hash) {
      const adminUser = {
        id: newId('user'),
        username: process.env.ADMIN_USERNAME || 'admin',
        displayName: 'Admin',
        email: process.env.ADMIN_EMAIL || '',
        passwordHash: legacy,
        role: 'admin',
        allowedAccountIds: [],
        mustChangePassword: false,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: null,
      };
      cachedUsers = { users: [adminUser], passwordResetTokens: [] };
      await writeJsonAtomic(USERS_FILE, cachedUsers);
      return cachedUsers;
    }
  }
  const loaded = await readJsonStrict(USERS_FILE, {
    defaultIfMissing: { users: [], passwordResetTokens: [] },
    label: 'users.json',
  });
  if (!Array.isArray(loaded.users)) loaded.users = [];
  if (!Array.isArray(loaded.passwordResetTokens)) loaded.passwordResetTokens = [];
  cachedUsers = loaded;
  return cachedUsers;
}

async function saveUsers() {
  ensureDataDir();
  await writeJsonAtomic(USERS_FILE, cachedUsers);
}

async function loadSessions() {
  if (cachedSessions) return cachedSessions;
  ensureDataDir();
  const list = await readJsonStrict(SESSIONS_FILE, {
    defaultIfMissing: [],
    label: 'sessions.json',
  });
  const now = Date.now();
  cachedSessions = (Array.isArray(list) ? list : []).filter(s =>
    s && s.token && s.userId && s.lastSeenAt &&
    new Date(s.lastSeenAt).getTime() + SESSION_TTL_MS > now
  );
  return cachedSessions;
}

async function saveSessions() {
  ensureDataDir();
  await writeJsonAtomic(SESSIONS_FILE, cachedSessions);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstrap an admin user from env vars (ADMIN_USERNAME + ADMIN_INITIAL_PASSWORD)
 * if no users exist yet. Returns the created user (or null if nothing to do).
 * Headless deploys use this; the interactive wizard uses createFirstAdmin instead.
 */
export async function bootstrapAdmin() {
  return withLock(async () => {
    const u = await loadUsers();
    if (u.users.length > 0) return null;
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!username || !password) return null;
    if (password.length < 8) {
      throw new Error('ADMIN_INITIAL_PASSWORD must be at least 8 characters');
    }
    const admin = {
      id: newId('user'),
      username,
      displayName: 'Admin',
      email: process.env.ADMIN_EMAIL || '',
      passwordHash: hashPassword(password),
      role: 'admin',
      allowedAccountIds: [],
      mustChangePassword: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    u.users.push(admin);
    await saveUsers();
    return stripUser(admin);
  });
}

/**
 * Wizard hook — create the first admin user during interactive first-run setup.
 * Throws if any user already exists.
 */
export async function createFirstAdmin({ username, password, displayName, email }) {
  return withLock(async () => {
    const u = await loadUsers();
    if (u.users.length > 0) {
      throw new Error('Users already exist; cannot run first-time setup again');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const uname = String(username || 'admin').trim();
    if (!uname) throw new Error('username required');
    const admin = {
      id: newId('user'),
      username: uname,
      displayName: displayName || uname,
      email: email || '',
      passwordHash: hashPassword(password),
      role: 'admin',
      allowedAccountIds: [],
      mustChangePassword: false,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    u.users.push(admin);
    await saveUsers();
    return stripUser(admin);
  });
}

export async function hasAnyUsers() {
  const u = await loadUsers();
  return u.users.length > 0;
}

// ── User CRUD ────────────────────────────────────────────────────────────────

export async function listUsers() {
  const u = await loadUsers();
  return u.users.map(stripUser);
}

export async function getUserById(id) {
  const u = await loadUsers();
  return u.users.find(x => x.id === id) || null;
}

export async function getUserByUsername(username) {
  if (!username) return null;
  const u = await loadUsers();
  const needle = String(username).trim().toLowerCase();
  return u.users.find(x => x.username.toLowerCase() === needle) || null;
}

export async function getUserByEmail(email) {
  if (!email) return null;
  const u = await loadUsers();
  const needle = String(email).trim().toLowerCase();
  return u.users.find(x => x.email && x.email.toLowerCase() === needle) || null;
}

export async function createUser({ username, displayName, email, password, role, allowedAccountIds }) {
  return withLock(async () => {
    if (!username || !password) throw new Error('username and password required');
    if (!ROLES.includes(role)) throw new Error('role must be admin, editor, or viewer');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const u = await loadUsers();
    const uname = String(username).trim();
    if (!uname) throw new Error('username required');
    const dup = u.users.find(x => x.username.toLowerCase() === uname.toLowerCase());
    if (dup) throw new Error('Username already taken');
    const user = {
      id: newId('user'),
      username: uname,
      displayName: displayName || uname,
      email: email || '',
      passwordHash: hashPassword(password),
      role,
      allowedAccountIds: Array.isArray(allowedAccountIds) ? allowedAccountIds.slice() : [],
      mustChangePassword: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    u.users.push(user);
    await saveUsers();
    return stripUser(user);
  });
}

export async function updateUser(id, patch) {
  return withLock(async () => {
    const u = await loadUsers();
    const user = u.users.find(x => x.id === id);
    if (!user) throw new Error('User not found');

    if (patch.username !== undefined) {
      const newName = String(patch.username).trim();
      if (!newName) throw new Error('username cannot be empty');
      if (newName.toLowerCase() !== user.username.toLowerCase()) {
        const dup = u.users.find(x => x.id !== id && x.username.toLowerCase() === newName.toLowerCase());
        if (dup) throw new Error('Username already taken');
      }
      user.username = newName;
    }
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName);
    if (patch.email !== undefined) user.email = String(patch.email || '');
    if (patch.role !== undefined) {
      if (!ROLES.includes(patch.role)) throw new Error('Invalid role');
      // Refuse to demote the last active admin.
      if (user.role === 'admin' && patch.role !== 'admin') {
        const remaining = u.users.filter(x => x.id !== id && x.role === 'admin' && x.active).length;
        if (remaining === 0) throw new Error('Cannot demote the last active admin');
      }
      user.role = patch.role;
    }
    if (patch.allowedAccountIds !== undefined) {
      user.allowedAccountIds = Array.isArray(patch.allowedAccountIds) ? patch.allowedAccountIds.slice() : [];
    }
    if (patch.active !== undefined) {
      const nextActive = !!patch.active;
      if (user.active && !nextActive && user.role === 'admin') {
        const remaining = u.users.filter(x => x.id !== id && x.role === 'admin' && x.active).length;
        if (remaining === 0) throw new Error('Cannot disable the last active admin');
      }
      user.active = nextActive;
      if (!nextActive) await revokeAllSessionsForUser(id);
    }
    user.updatedAt = new Date().toISOString();
    await saveUsers();
    return stripUser(user);
  });
}

export async function deleteUser(id) {
  return withLock(async () => {
    const u = await loadUsers();
    const idx = u.users.findIndex(x => x.id === id);
    if (idx < 0) throw new Error('User not found');
    const user = u.users[idx];
    if (user.role === 'admin' && user.active) {
      const remaining = u.users.filter(x => x.id !== id && x.role === 'admin' && x.active).length;
      if (remaining === 0) throw new Error('Cannot delete the last active admin');
    }
    u.users.splice(idx, 1);
    await saveUsers();
    await revokeAllSessionsForUser(id);
  });
}

async function revokeAllSessionsForUser(userId) {
  const sessions = await loadSessions();
  cachedSessions = sessions.filter(s => s.userId !== userId);
  await saveSessions();
}

// ── Password management ──────────────────────────────────────────────────────

export async function resetUserPassword(id, newPassword, { mustChangePassword = true } = {}) {
  return withLock(async () => {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const u = await loadUsers();
    const user = u.users.find(x => x.id === id);
    if (!user) throw new Error('User not found');
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = !!mustChangePassword;
    user.updatedAt = new Date().toISOString();
    await saveUsers();
    await revokeAllSessionsForUser(id);
  });
}

export async function changeOwnPassword(id, currentPassword, newPassword) {
  return withLock(async () => {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters');
    }
    const u = await loadUsers();
    const user = u.users.find(x => x.id === id);
    if (!user) throw new Error('User not found');
    if (!verifyPasswordHash(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect');
    }
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = false;
    user.updatedAt = new Date().toISOString();
    await saveUsers();
  });
}

/**
 * Issue a one-time password-reset token. Returns the raw token (caller emails it
 * to the user). Stored as a hash so the JSON file can't be used to forge resets.
 */
export async function issuePasswordResetToken(email) {
  return withLock(async () => {
    const user = await getUserByEmail(email);
    // Always return null on miss (don't leak which emails exist) — caller still
    // looks the same to the requester.
    if (!user || !user.active) return null;
    const u = await loadUsers();
    const raw = newToken();
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    u.passwordResetTokens = (u.passwordResetTokens || []).filter(t =>
      t.userId !== user.id && new Date(t.expiresAt).getTime() > Date.now()
    );
    u.passwordResetTokens.push({
      tokenHash: hash,
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    });
    await saveUsers();
    return { rawToken: raw, user: stripUser(user) };
  });
}

export async function consumePasswordResetToken(rawToken, newPassword) {
  return withLock(async () => {
    if (!rawToken || !newPassword) throw new Error('token and newPassword required');
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const u = await loadUsers();
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const now = Date.now();
    const idx = (u.passwordResetTokens || []).findIndex(t =>
      t.tokenHash === hash && new Date(t.expiresAt).getTime() > now
    );
    if (idx < 0) throw new Error('Invalid or expired reset token');
    const tok = u.passwordResetTokens[idx];
    const user = u.users.find(x => x.id === tok.userId);
    if (!user) throw new Error('User no longer exists');
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = false;
    user.updatedAt = new Date().toISOString();
    u.passwordResetTokens.splice(idx, 1);
    await saveUsers();
    await revokeAllSessionsForUser(user.id);
    return stripUser(user);
  });
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function login(usernameOrEmail, password) {
  return withLock(async () => {
    // Accept either form: input with an "@" looks up by email, otherwise by username.
    // Lets operators log in with `admin` while customers log in with the email they
    // were invited under, without forcing one identifier or the other.
    let user;
    if (typeof usernameOrEmail === 'string' && usernameOrEmail.includes('@')) {
      user = await getUserByEmail(usernameOrEmail);
    } else {
      user = await getUserByUsername(usernameOrEmail);
    }
    if (!user || !user.active) return null;
    if (!verifyPasswordHash(password, user.passwordHash)) return null;
    const sessions = await loadSessions();
    const token = newToken();
    const now = new Date().toISOString();
    sessions.push({ token, userId: user.id, createdAt: now, lastSeenAt: now });
    cachedSessions = sessions;
    await saveSessions();
    user.lastLoginAt = now;
    await saveUsers();
    return { token, user: stripUser(user) };
  });
}

export async function logout(token) {
  return withLock(async () => {
    const sessions = await loadSessions();
    cachedSessions = sessions.filter(s => s.token !== token);
    await saveSessions();
  });
}

export async function getUserBySession(token) {
  if (!token) return null;
  const sessions = await loadSessions();
  const session = sessions.find(s => s.token === token);
  if (!session) return null;
  const since = Date.now() - new Date(session.lastSeenAt).getTime();
  if (since > SESSION_TTL_MS) return null;
  if (since > SESSION_TOUCH_INTERVAL_MS) {
    session.lastSeenAt = new Date().toISOString();
    // Fire-and-forget; touching lastSeenAt isn't load-bearing for correctness.
    saveSessions().catch(() => {});
  }
  return await getUserById(session.userId);
}

// ── Middleware ───────────────────────────────────────────────────────────────

function parseBearer(req) {
  const h = req.headers['authorization'];
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function serviceUserFromToken(token) {
  // Synthetic user shape so the rest of the auth pipeline (canAccessAccount,
  // filterAccountIds, route handlers) doesn't need to know about bearer auth.
  return {
    id: 'svc.' + token.id,
    username: 'service:' + token.name,
    displayName: 'Service: ' + token.name,
    email: '',
    role: 'service',
    active: true,
    allowedAccountIds: Array.isArray(token.accountIds) ? token.accountIds.slice() : [],
    scopes: Array.isArray(token.scopes) ? token.scopes.slice() : [],
    isServiceAccount: true,
    serviceTokenId: token.id,
  };
}

export function requireAuth(req, res, next) {
  const bearer = parseBearer(req);
  if (bearer) {
    verifyBearer(bearer).then(token => {
      if (!token) return res.status(401).json({ error: 'Invalid or revoked bearer token' });
      req.user = serviceUserFromToken(token);
      next();
    }).catch(err => res.status(500).json({ error: err.message }));
    return;
  }
  const token = req.headers['x-ui-token'];
  getUserBySession(token).then(user => {
    if (!user || !user.active) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  }).catch(err => res.status(500).json({ error: err.message }));
}

export function requireEditor(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.isServiceAccount) {
      // v1 service tokens are read-only. No write scope exists yet.
      return res.status(403).json({ error: 'Service tokens do not have write access' });
    }
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Editor or admin role required' });
    }
    next();
  });
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    next();
  });
}

/**
 * Per-route scope gate for service-account callers. Session-cookie callers
 * (admin/editor/viewer) pass through unconditionally — their role gates already
 * applied upstream. Use AFTER requireAuth.
 */
export function requireScope(scope) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.isServiceAccount) {
      if (!Array.isArray(req.user.scopes) || !req.user.scopes.includes(scope)) {
        return res.status(403).json({ error: `Missing scope: ${scope}` });
      }
    }
    next();
  };
}

/**
 * Gate a route that operates on a single account via path param.
 * Admin sees all; editor/viewer must have the accountId in allowedAccountIds.
 * Use AFTER requireAuth/requireEditor.
 */
export function requireAccountAccess(req, res, next) {
  const { accountId } = req.params;
  if (!canAccessAccount(req.user, accountId)) {
    return res.status(403).json({ error: 'Access denied to this account' });
  }
  next();
}

// ── Scope helpers (used by Phase 2 routes) ───────────────────────────────────

export function canAccessAccount(user, accountId) {
  if (!user || !accountId) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.allowedAccountIds) && user.allowedAccountIds.includes(accountId);
}

export function filterAccountIds(user, accountIds) {
  if (!user || !Array.isArray(accountIds)) return [];
  if (user.role === 'admin') return accountIds.slice();
  const allowed = new Set(user.allowedAccountIds || []);
  return accountIds.filter(id => allowed.has(id));
}

export function filterAccountList(user, list, idField = 'accountId') {
  if (!user || !Array.isArray(list)) return [];
  if (user.role === 'admin') return list;
  const allowed = new Set(user.allowedAccountIds || []);
  return list.filter(x => allowed.has(x[idField]));
}
