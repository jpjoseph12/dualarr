// Login for the web UI: one admin account (scrypt-hashed password), cookie sessions, an API
// key for scripts, and a small per-IP limit on login attempts.
import crypto from 'node:crypto';
import * as store from './db.js';

export const COOKIE = 'dualarr_session';
const SESSION_DAYS_REMEMBER = 30;
const SESSION_HOURS = 12;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 8;

// ---------- passwords ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters';
  if (password.length > 256) return 'That password is too long';
  return null;
}

export function usernameProblem(username) {
  if (typeof username !== 'string' || !/^[\w.@-]{2,40}$/.test(username.trim())) {
    return 'Use 2–40 letters, numbers, dots, dashes, @ or underscores';
  }
  return null;
}

// ---------- account ----------

export const isConfigured = () => !!store.getSettings().authHash;

export function createAccount(username, password) {
  store.saveSettings({ authUser: username.trim(), authHash: hashPassword(password) });
}

export function checkLogin(username, password) {
  const s = store.getSettings();
  // Always run scrypt so a wrong username takes as long as a wrong password.
  const okPassword = verifyPassword(password, s.authHash || hashPassword('x'));
  const okUser = !!s.authUser && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(username).trim().toLowerCase()).digest(),
    crypto.createHash('sha256').update(s.authUser.toLowerCase()).digest(),
  );
  return okPassword && okUser;
}

/** Forgets the account and every session (DUALARR_RESET_AUTH=true, or tests). */
export function resetAccount() {
  store.saveSettings({ authUser: '', authHash: '' });
  store.deleteAllSessions();
}

// ---------- sessions ----------

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function createSession(remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ms = remember ? SESSION_DAYS_REMEMBER * 86_400_000 : SESSION_HOURS * 3_600_000;
  store.createSession(sha(token), new Date(Date.now() + ms).toISOString());
  return { token, maxAge: remember ? ms : null };
}

export function sessionValid(token) {
  if (!token) return false;
  const s = store.getSession(sha(token));
  if (!s) return false;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    store.deleteSession(sha(token));
    return false;
  }
  return true;
}

export const endSession = (token) => token && store.deleteSession(sha(token));

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(req, token, maxAge) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAge === 0) parts.push('Max-Age=0');
  else if (maxAge) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

// ---------- API key ----------

export const newKey = () => crypto.randomBytes(24).toString('hex');

/** Makes sure an API key for scripts exists. */
export function ensureKeys() {
  if (!store.getSettings().apiKey) store.saveSettings({ apiKey: newKey() });
}

const sameKey = (a, b) =>
  !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const apiKeyValid = (key) => sameKey(String(key || ''), store.getSettings().apiKey);

// ---------- login attempt limiting ----------

const failures = new Map(); // ip -> [timestamps]

export function loginBlocked(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= LOGIN_MAX_FAILURES;
}
export const recordFailure = (ip) => failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
export const clearFailures = (ip) => failures.delete(ip);

export const endOtherSessions = (token) => store.deleteOtherSessions(sha(token || ''));
