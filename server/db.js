import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from './config.js';

export const db = new DatabaseSync(path.join(CONFIG_DIR, 'dualarr.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- The latest scan of each Sonarr series: every file's audio/subtitle languages and verdict.
  CREATE TABLE IF NOT EXISTS series (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    data        TEXT NOT NULL,
    scanned_at  TEXT NOT NULL,
    searched_at TEXT
  );

  -- Web UI login sessions (only a hash of the cookie token is stored).
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- What checking a file itself found (verify.js), per Sonarr episode file; size tells whether
  -- the file changed since.
  CREATE TABLE IF NOT EXISTS checks (
    file_id    INTEGER PRIMARY KEY,
    series_id  INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    data       TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger     TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    summary     TEXT
  );
`);

export const now = () => new Date().toISOString();

// ---------- settings ----------

export const SETTING_DEFAULTS = {
  sonarrUrl: '',
  sonarrApiKey: '',
  // Which Sonarr series are checked: 'anime' = series type Anime; 'japanese' also takes any
  // series whose original language is Japanese.
  scope: 'anime',
  requireSubtitles: true,
  subtitleLanguage: 'any',
  dualScore: 2000,
  profileIds: [],
  // Per quality profile: { [profileId]: { mode: 'dual' | 'original', lang: 'ja' | 'zh' | … | 'auto' } }.
  // Profiles not listed want dual audio with Japanese as the original language.
  profileRules: {},
  schedule: '0 4 * * *',
  autoSearch: true,
  searchPerRun: 10,
  searchAgainDays: 7,
  notifiers: [],
  notifyUpgrades: true,
  notifyProblems: true,
  // Checking the files themselves (ffmpeg + whisper.cpp), a few per scheduled scan.
  verify: false,
  verifyModel: 'base',
  // 'auto' (the first GPU found, else the CPU), 'cpu', or 'gpu:N'.
  verifyDevice: 'auto',
  verifyPerRun: 100,
  // Sonarr's folder -> the same folder in this container: [{ from, to }].
  pathMappings: [],
  authUser: '',
  authHash: '',
  apiKey: '',
};

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in SETTING_DEFAULTS) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(patch)) {
    if (key in SETTING_DEFAULTS) stmt.run(key, JSON.stringify(value));
  }
  return getSettings();
}

// ---------- series scans ----------

const rowToSeries = (r) => r ? { ...JSON.parse(r.data), scannedAt: r.scanned_at, searchedAt: r.searched_at } : null;

export const listSeries = () =>
  db.prepare('SELECT * FROM series ORDER BY title COLLATE NOCASE').all().map(rowToSeries);

export const getSeries = (id) => rowToSeries(db.prepare('SELECT * FROM series WHERE id = ?').get(id));

/** Saves one series' scan, keeping when it was last searched. */
export function saveSeries(s) {
  db.prepare(
    `INSERT INTO series (id, title, data, scanned_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, data = excluded.data, scanned_at = excluded.scanned_at`,
  ).run(s.id, s.title, JSON.stringify(s), now());
}

/** Forgets series that are no longer in Sonarr (or no longer in scope), and their checks. */
export function pruneSeries(keepIds) {
  const keep = new Set(keepIds);
  const del = db.prepare('DELETE FROM series WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM series').all()) if (!keep.has(id)) del.run(id);
  const delChecks = db.prepare('DELETE FROM checks WHERE series_id = ?');
  for (const { series_id: id } of db.prepare('SELECT DISTINCT series_id FROM checks').all()) if (!keep.has(id)) delChecks.run(id);
}

// ---------- file checks ----------

/** A series' checks by file id: { size, checkedAt, ...what verify.checkFile found }. */
export const getChecks = (seriesId) =>
  new Map(
    db
      .prepare('SELECT * FROM checks WHERE series_id = ?')
      .all(seriesId)
      .map((r) => [r.file_id, { ...JSON.parse(r.data), size: r.size, checkedAt: r.checked_at }]),
  );

export function saveCheck(fileId, seriesId, size, data) {
  db.prepare(
    `INSERT INTO checks (file_id, series_id, size, data, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET series_id = excluded.series_id, size = excluded.size, data = excluded.data, checked_at = excluded.checked_at`,
  ).run(fileId, seriesId, size, JSON.stringify(data), now());
}

/** Forgets the checks of a series' files that are gone (upgraded files get new ids). */
export function pruneChecks(seriesId, keepFileIds) {
  const keep = new Set(keepFileIds);
  const del = db.prepare('DELETE FROM checks WHERE file_id = ?');
  for (const { file_id: id } of db.prepare('SELECT file_id FROM checks WHERE series_id = ?').all(seriesId)) if (!keep.has(id)) del.run(id);
}

export const markSearched = (id) => db.prepare('UPDATE series SET searched_at = ? WHERE id = ?').run(now(), id);

// ---------- sessions ----------

export function createSession(tokenHash, expiresAt) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, now(), expiresAt);
}
export const getSession = (tokenHash) => db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) || null;
export const deleteSession = (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
export const deleteAllSessions = () => db.prepare('DELETE FROM sessions').run();
export const deleteOtherSessions = (keepHash) => db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(keepHash);

// ---------- runs ----------

export function startRun(trigger) {
  return db
    .prepare("INSERT INTO runs (trigger, status, started_at) VALUES (?, 'running', ?)")
    .run(trigger, now()).lastInsertRowid;
}

export function finishRun(id, status, summary) {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?').run(
    status,
    now(),
    JSON.stringify(summary),
    id,
  );
  // Keep the activity log bounded.
  db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 200)').run();
}

export function listRuns(limit = 50) {
  return db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
}

// A run left 'running' by a crash/restart is not running any more.
db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
