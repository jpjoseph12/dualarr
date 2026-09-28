import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import * as rules from './rules.js';
import { sonarrClient } from './sonarr.js';
import { currentJob, replaceJob, scanJob, searchJob, setupJob, setupState } from './jobs.js';
import { nextRun, schedule, validateCron } from './scheduler.js';
import { NOTIFIER_TYPES, SECRET_FIELDS, send as sendNotification } from './notify.js';
import * as auth from './auth.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- validation ----------

const intList = (v) =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0))] : [];
const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};

const MASK = '••••••••';

function publicSettings() {
  const s = store.getSettings();
  const { authHash, ...out } = s;
  out.sonarrApiKey = '';
  out.sonarrApiKeySet = !!s.sonarrApiKey;
  // Webhook URLs and tokens are secrets: the browser only learns whether one is set.
  out.notifiers = (s.notifiers || []).map((n) => {
    const copy = { ...n };
    for (const f of SECRET_FIELDS) if (f in copy) copy[f] = copy[f] ? MASK : '';
    return copy;
  });
  return out;
}

const httpUrl = (v) => /^https?:\/\/[^\s]+$/i.test(v);

/** Validates notifier settings; a masked or blank secret keeps the saved value. */
function sanitizeNotifiers(list, saved = []) {
  const prev = new Map(saved.map((n) => [n.id, n]));
  if (!Array.isArray(list)) throw bad('notifiers must be a list');
  return list.slice(0, 20).map((n) => {
    const type = n?.type;
    if (!NOTIFIER_TYPES[type]) throw bad(`Unknown notification type "${type}"`);
    const old = prev.get(n.id) || {};
    const out = {
      id: /^[a-z0-9-]{4,40}$/i.test(n.id || '') ? n.id : randomUUID(),
      type,
      name: String(n.name || '').trim().slice(0, 60),
      enabled: n.enabled !== false,
    };
    for (const f of NOTIFIER_TYPES[type].fields) {
      let v = String(n[f] ?? '').trim();
      if (SECRET_FIELDS.includes(f) && (v === MASK || v === '')) v = old[f] || '';
      out[f] = v.slice(0, 500);
    }
    const label = NOTIFIER_TYPES[type].label;
    if (type === 'discord' && !/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(out.webhookUrl)) throw bad(`${label}: paste the channel's webhook URL`);
    if (type === 'telegram' && (!out.botToken || !out.chatId)) throw bad(`${label}: bot token and chat ID are required`);
    if (type === 'ntfy' && (!out.topic || (out.server && !httpUrl(out.server)))) throw bad(`${label}: a topic (and a valid server URL, if set) is required`);
    if (type === 'gotify' && (!httpUrl(out.server) || !out.token)) throw bad(`${label}: server URL and app token are required`);
    if (type === 'webhook' && !httpUrl(out.url)) throw bad(`${label}: a valid http(s) URL is required`);
    return out;
  });
}

// Settings that change a file's verdict: saving a change rescans the library.
const RULE_KEYS = ['scope', 'requireSubtitles', 'subtitleLanguage'];

/** Validates a settings patch; only the fields present are changed. */
function sanitizeSettings(b, saved) {
  const patch = {};
  if (b.sonarrUrl !== undefined) {
    const u = String(b.sonarrUrl).trim().replace(/\/+$/, '');
    if (u && !httpUrl(u)) throw bad('The Sonarr URL must start with http:// or https://');
    patch.sonarrUrl = u;
  }
  // Blank means "keep the saved key"; the explicit clear flag removes it.
  if (b.sonarrApiKey) patch.sonarrApiKey = String(b.sonarrApiKey).trim();
  if (b.clearSonarrApiKey) patch.sonarrApiKey = '';
  if (b.scope !== undefined) {
    if (!['anime', 'japanese'].includes(b.scope)) throw bad('scope must be anime or japanese');
    patch.scope = b.scope;
  }
  if (b.subtitleLanguage !== undefined) {
    if (b.subtitleLanguage !== 'any' && !(b.subtitleLanguage in rules.SUBTITLE_LANGUAGES)) throw bad(`Unknown subtitle language "${b.subtitleLanguage}"`);
    patch.subtitleLanguage = b.subtitleLanguage;
  }
  for (const k of ['requireSubtitles', 'autoSearch', 'notifyUpgrades', 'notifyProblems']) if (b[k] !== undefined) patch[k] = !!b[k];
  if (b.dualScore !== undefined) patch.dualScore = clampInt(b.dualScore, 1, 1_000_000, saved.dualScore);
  if (b.profileIds !== undefined) patch.profileIds = intList(b.profileIds).filter((n) => n > 0);
  if (b.searchPerRun !== undefined) patch.searchPerRun = clampInt(b.searchPerRun, 1, 100, saved.searchPerRun);
  if (b.searchAgainDays !== undefined) patch.searchAgainDays = clampInt(b.searchAgainDays, 1, 365, saved.searchAgainDays);
  if (b.schedule !== undefined) {
    const expr = String(b.schedule).trim();
    const err = expr && validateCron(expr);
    if (err) throw bad(`Invalid schedule: ${err}`);
    patch.schedule = expr;
  }
  if (b.notifiers !== undefined) patch.notifiers = sanitizeNotifiers(b.notifiers, saved.notifiers);
  return patch;
}

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Not found');
  return id;
};
const sonarrOr400 = (settings = store.getSettings()) => {
  const client = sonarrClient(settings);
  if (!client) throw bad('Connect Sonarr in Settings first');
  return client;
};
/** A finished job as a response: its error becomes a 400, anything else its summary. */
function jobResult(run) {
  if (run.status === 'error') throw bad(run.summary.error);
  return { status: run.status, summary: run.summary };
}

const causeOf = (e) => {
  const cause = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message;
  return cause ? `${e.message} (${cause})` : e.message;
};

// ---------- app ----------

/** The Express app: API and the web UI. index.js starts it; tests import it directly. */
// Changes every time the server starts (version + start time). Pages compare it with the build
// they were loaded from, so a tab left open across an update reloads itself.
export const BUILD = `${VERSION}-${Date.now().toString(36)}`;

export const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Dualarr-Build', BUILD);
  next();
});
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));

// ---------- login ----------

const OPEN_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/logout']);
const sessionToken = (req) => auth.parseCookies(req.headers.cookie)[auth.COOKIE];

/** Who is calling: a logged-in browser session, or a script with the API key. */
function caller(req) {
  const token = sessionToken(req);
  if (token && auth.sessionValid(token)) return { via: 'session', token };
  const key = req.get('x-api-key') || req.query.apikey;
  if (key && auth.apiKeyValid(key)) return { via: 'apikey' };
  return null;
}

app.use('/api', (req, res, next) => {
  if (OPEN_API.has(req.originalUrl.split('?')[0])) return next();
  const who = caller(req);
  if (!who) {
    const configured = auth.isConfigured();
    return res.status(401).json({ error: configured ? 'Log in to continue' : 'Create an account first', code: configured ? 'login' : 'setup' });
  }
  // A browser session can only change things with the header Dualarr's own UI sends: a
  // cross-site page can't add it without a CORS preflight, which this server never allows.
  if (who.via === 'session' && !['GET', 'HEAD'].includes(req.method) && req.get('x-dualarr') !== '1') {
    return res.status(403).json({
      error: 'This page is out of date — Dualarr was updated since it was opened. Reload the page (Ctrl+F5) and try again.',
      code: 'reload',
    });
  }
  req.caller = who;
  next();
});

app.get('/api/auth/status', (req, res) => {
  const s = store.getSettings();
  const who = caller(req);
  res.json({
    configured: !!s.authHash,
    authenticated: !!who,
    user: who ? s.authUser : null,
    version: VERSION,
  });
});

const startSession = (req, res, remember) => {
  const { token, maxAge } = auth.createSession(remember);
  res.set('Set-Cookie', auth.sessionCookie(req, token, maxAge));
};

app.post('/api/auth/setup', (req, res) => {
  if (auth.isConfigured()) throw new HttpError(409, 'An account already exists — log in instead');
  const { username, password } = req.body || {};
  const problem = auth.usernameProblem(username) || auth.passwordProblem(password);
  if (problem) throw bad(problem);
  auth.createAccount(username, password);
  auth.ensureKeys();
  log(`Account "${username.trim()}" created`);
  startSession(req, res, true);
  res.status(201).json({ ok: true, user: username.trim() });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (auth.loginBlocked(ip)) throw new HttpError(429, 'Too many failed attempts — wait 10 minutes and try again');
  const { username, password, remember } = req.body || {};
  if (!auth.isConfigured()) throw new HttpError(409, 'No account yet — create one first');
  if (!auth.checkLogin(username || '', password || '')) {
    auth.recordFailure(ip);
    log(`Failed login for "${String(username || '').slice(0, 40)}" from ${ip}`);
    throw new HttpError(401, 'Wrong username or password');
  }
  auth.clearFailures(ip);
  startSession(req, res, !!remember);
  res.json({ ok: true, user: store.getSettings().authUser });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(sessionToken(req));
  res.set('Set-Cookie', auth.sessionCookie(req, '', 0));
  res.status(204).end();
});

app.put('/api/auth/account', (req, res) => {
  const { current, username, password } = req.body || {};
  const s = store.getSettings();
  if (!auth.verifyPassword(current || '', s.authHash)) throw bad('Your current password is wrong');
  const patch = {};
  if (username !== undefined && username.trim() !== s.authUser) {
    const problem = auth.usernameProblem(username);
    if (problem) throw bad(problem);
    patch.authUser = username.trim();
  }
  if (password) {
    const problem = auth.passwordProblem(password);
    if (problem) throw bad(problem);
    patch.authHash = auth.hashPassword(password);
  }
  store.saveSettings(patch);
  // Signing everyone else out is the point of changing a password.
  if (patch.authHash) auth.endOtherSessions(req.caller.token);
  res.json({ ok: true, user: store.getSettings().authUser });
});

app.post('/api/auth/keys/:which', (req, res) => {
  if (req.params.which !== 'api') throw new HttpError(404, 'Unknown key');
  store.saveSettings({ apiKey: auth.newKey() });
  res.json(publicSettings());
});

app.get('/api/status', (_req, res) => {
  const s = store.getSettings();
  res.json({
    version: VERSION,
    timezone: TZ,
    schedule: s.schedule,
    nextRun: nextRun(),
    running: currentJob(),
    lastRun: store.listRuns(1)[0] || null,
  });
});

// ---------- library ----------

// The library list leaves the files out (a big library has tens of thousands); a row's files
// come from /api/series/:id when it is expanded.
app.get('/api/library', (_req, res) => {
  const all = store.listSeries();
  const s = store.getSettings();
  res.json({
    series: all.map(({ files, ...r }) => ({ ...r, state: rules.seriesState(r), needsSearch: rules.needsSearch(r) })),
    totals: rules.totals(all),
    sonarrUrl: s.sonarrUrl,
  });
});

app.get('/api/series/:id', (req, res) => {
  const row = store.getSeries(idParam(req));
  if (!row) throw new HttpError(404, 'Series not found — scan again');
  res.json({ ...row, state: rules.seriesState(row), needsSearch: rules.needsSearch(row) });
});

app.post('/api/scan', (_req, res) => {
  sonarrOr400();
  scanJob('scan');
  res.status(202).json({ started: true });
});

app.post('/api/search', async (req, res) => {
  sonarrOr400();
  const ids =
    req.body?.ids !== undefined
      ? intList(req.body.ids)
      : store.listSeries().filter((r) => r.monitored && rules.needsSearch(r)).map((r) => r.id);
  if (!ids.length) throw bad('Nothing to search for');
  res.json(jobResult(await searchJob(ids)));
});

app.post('/api/series/:id/replace', async (req, res) => {
  const id = idParam(req);
  sonarrOr400();
  const fileIds = intList(req.body?.fileIds);
  if (!fileIds.length) throw bad('Pick the files to replace');
  const run = jobResult(await replaceJob(id, fileIds));
  const row = store.getSeries(id);
  res.json({ ...run, series: row && { ...row, state: rules.seriesState(row), needsSearch: rules.needsSearch(row) } });
});

// ---------- Sonarr setup (custom formats & profile scores) ----------

app.get('/api/setup', async (_req, res) => {
  const settings = store.getSettings();
  res.json(await setupState(sonarrOr400(settings), settings));
});

app.post('/api/setup', async (req, res) => {
  const b = req.body || {};
  sonarrOr400();
  const saved = store.getSettings();
  const patch = sanitizeSettings({ profileIds: b.profileIds ?? saved.profileIds, dualScore: b.dualScore ?? saved.dualScore }, saved);
  if (!patch.profileIds.length) throw bad('Pick at least one quality profile');
  store.saveSettings(patch);
  const run = jobResult(await setupJob());
  const settings = store.getSettings();
  res.json({ ...run, ...(await setupState(sonarrOr400(settings), settings)) });
});

// ---------- settings ----------

app.get('/api/settings', (_req, res) => res.json(publicSettings()));

app.put('/api/settings', (req, res) => {
  const before = store.getSettings();
  const saved = store.saveSettings(sanitizeSettings(req.body || {}, before));
  if (saved.schedule !== before.schedule) schedule(saved.schedule);
  // Stored verdicts were made with the old rules; rescan (quietly: nothing about the files changed).
  const rulesChanged = RULE_KEYS.some((k) => saved[k] !== before[k]);
  if (rulesChanged && sonarrClient(saved)) scanJob('rules', { notify: false });
  res.json({ ...publicSettings(), rescanning: rulesChanged && !!sonarrClient(saved) });
});

app.post('/api/settings/test', async (req, res) => {
  const saved = store.getSettings();
  const b = req.body || {};
  const client = sonarrClient({ sonarrUrl: b.url ?? saved.sonarrUrl, sonarrApiKey: b.apiKey || saved.sonarrApiKey });
  if (!client) throw bad('URL and API key are required');
  try {
    const st = await client.status();
    res.json({ ok: true, appName: st.appName || 'Sonarr', version: st.version });
  } catch (e) {
    res.json({ ok: false, error: causeOf(e) });
  }
});

// ---------- notifications ----------

app.post('/api/notify/test', async (req, res) => {
  const [n] = sanitizeNotifiers([req.body], store.getSettings().notifiers);
  try {
    await sendNotification(n, { kind: 'test' });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: causeOf(e) });
  }
});

app.get('/api/runs', (_req, res) => res.json(store.listRuns(50)));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// index.html references its assets with a per-start version so browsers that cached an older
// app.js/app.css (before an update) always fetch the new ones.
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const indexHtml = fs
  .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="(app\.(?:js|css))"/g, `$1="$2?v=${BUILD}"`)
  .replace('<meta name="dualarr-build" content="" />', `<meta name="dualarr-build" content="${BUILD}" />`);
app.get(['/', '/index.html'], (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml));

// no-cache = revalidate by ETag on every load, so a container update never serves a stale UI.
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }),
);

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log(`Error: ${err.stack || err.message}`);
  res.status(status).json({ error: err.message || 'Internal error' });
});

export default app;
