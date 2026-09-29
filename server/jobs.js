// Everything that talks to Sonarr on the user's behalf: scanning the library, checking files
// themselves, searching for dual audio, replacing files that break the rules, and setting up the
// custom formats. Jobs run one
// at a time and each is recorded in the activity log.
import fs from 'node:fs';
import { sonarrClient } from './sonarr.js';
import * as rules from './rules.js';
import * as store from './db.js';
import { notifyAll } from './notify.js';
import * as verify from './verify.js';
import { log } from './config.js';

let queue = Promise.resolve();
let running = null;
/** The trigger of the job in progress (e.g. 'schedule', 'scan'), or null. */
export const currentJob = () => running;

/** Runs `work(summary, client, settings)` after any job in progress; resolves with its run. */
export function job(trigger, work) {
  const p = queue.then(async () => {
    running = trigger;
    const runId = store.startRun(trigger);
    const summary = { warnings: [] };
    let status = 'ok';
    let result;
    try {
      const settings = store.getSettings();
      const client = sonarrClient(settings);
      if (!client) throw new Error('Connect Sonarr in Settings first');
      result = await work(summary, client, settings);
      if (summary.warnings.length) status = 'partial';
    } catch (e) {
      status = 'error';
      summary.error = e.message;
      log(`${trigger} failed: ${e.message}`);
    } finally {
      store.finishRun(runId, status, summary);
      running = null;
    }
    return { runId, status, summary, result };
  });
  queue = p.catch(() => {});
  return p;
}

/**
 * How a series' files are judged. The mode (dual audio or original only) and the original language
 * come from its quality profile; `series` is a Sonarr series or a stored row.
 */
function ruleOptions(settings, series = {}) {
  const rule = rules.profileRule(series.qualityProfileId, settings.profileRules);
  const original = typeof series.originalLanguage === 'string' ? series.originalLanguage : series.originalLanguage?.name;
  return {
    requireSubtitles: settings.requireSubtitles,
    subtitleLanguage: settings.subtitleLanguage,
    mode: rule.mode,
    lang: rules.seriesLanguage(rule.lang, original),
  };
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------- scanning ----------

/** Stores a series' verdicts from its Sonarr files and the checks made of them. */
function saveVerdicts(s, files, settings) {
  const row = rules.summariseSeries(s, files, ruleOptions(settings, s), store.getChecks(s.id));
  store.saveSeries(row);
  store.pruneChecks(s.id, files.map((f) => f.id));
  return row;
}

/** Reads the in-scope series (or just `ids`) and their files from Sonarr: [{ s, files }]. */
async function fetchSeries(client, settings, summary, ids = null) {
  const all = await client.series();
  const wanted = all.filter((s) => rules.inScope(s, settings.scope) && (!ids || ids.includes(s.id)));
  const fetched = await pool(wanted, 4, async (s) => {
    try {
      return { s, files: await client.episodeFiles(s.id) };
    } catch (e) {
      summary.warnings.push(`${s.title}: ${e.message}`);
      return null;
    }
  });
  return { wanted, fetched: fetched.filter(Boolean) };
}

/**
 * Re-reads every in-scope series' files from Sonarr and stores the verdicts. With `verify`, the
 * files due for a check are checked first, so the scan's verdicts (and notifications) include
 * what was found.
 */
export async function scanLibrary(client, settings, summary, { verify: withVerify = false } = {}) {
  const prev = new Map(store.listSeries().map((s) => [s.id, s]));
  const { wanted, fetched } = await fetchSeries(client, settings, summary);
  if (withVerify) await verifyDue(fetched, settings, summary);
  const rows = fetched.map(({ s, files }) => saveVerdicts(s, files, settings));
  // A series Sonarr couldn't read this time keeps its last scan.
  const read = new Set(rows.map((r) => r.id));
  const kept = wanted.filter((s) => !read.has(s.id) && prev.has(s.id)).map((s) => prev.get(s.id));
  store.pruneSeries(wanted.map((s) => s.id));
  const scanned = [...rows, ...kept];
  const changes = rules.diffScans(prev, scanned);
  Object.assign(summary, { scanned: scanned.length, totals: rules.totals(scanned), upgraded: changes.upgraded, problems: changes.problems });
  log(`Scanned ${scanned.length} series: ${JSON.stringify(summary.totals.files)}`);
  return changes;
}

/** Sends the upgrade / new-problem notifications for a scan. */
async function notifyChanges(settings, changes, summary) {
  const events = [];
  if (settings.notifyUpgrades && changes.upgraded.length) events.push({ kind: 'upgraded', series: changes.upgraded });
  if (settings.notifyProblems && changes.problems.length) events.push({ kind: 'problems', series: changes.problems });
  const enabled = (settings.notifiers || []).filter((n) => n.enabled !== false).length;
  let sent = 0;
  for (const evt of events) {
    const failures = await notifyAll(settings.notifiers || [], evt);
    summary.warnings.push(...failures.map((f) => `Notification failed: ${f}`));
    // Sent means at least one notifier delivered it.
    if (failures.length < enabled) sent++;
  }
  if (sent) summary.notified = sent;
}

/**
 * Scan + notify (+ the paced file checks and automatic search, for the scheduled run).
 * `notify: false` is for the rescan after the rules change: new verdicts then aren't news about
 * the files.
 */
export function scanJob(trigger, { autoSearch = false, notify = true } = {}) {
  return job(trigger, async (summary, client, settings) => {
    let changes;
    try {
      changes = await scanLibrary(client, settings, summary, { verify: autoSearch && settings.verify });
    } catch (e) {
      // Nobody is watching a scheduled scan, so say when it couldn't reach Sonarr.
      if (trigger === 'schedule' && settings.notifyProblems) await notifyAll(settings.notifiers || [], { kind: 'error', error: e.message });
      throw e;
    }
    if (notify) await notifyChanges(settings, changes, summary);
    // Wrong files go first, so the search after it doesn't look for what is being replaced anyway.
    if (autoSearch && settings.autoReplace !== 'off') await replaceDue(client, settings, summary, { notify });
    if (autoSearch && settings.autoSearch) summary.searched = await searchDue(client, settings, summary);
  });
}

// ---------- checking files ----------

/**
 * The files to check next: never checked (or changed since), files Sonarr knows nothing about
 * first, then the newest. `force` re-checks everything.
 */
export function dueForVerify(fetched, settings, { force = false, limit = settings.verifyPerRun } = {}) {
  const due = [];
  for (const { s, files } of fetched) {
    const opts = ruleOptions(settings, s);
    const checks = force ? new Map() : store.getChecks(s.id);
    for (const f of files) {
      const c = checks.get(f.id);
      if (c && c.size === (f.size || 0)) continue;
      due.push({ s, f, unknown: rules.classifyFile(f, opts).status === 'unknown' });
    }
  }
  return due
    .sort((a, b) => b.unknown - a.unknown || String(b.f.dateAdded || '').localeCompare(String(a.f.dateAdded || '')))
    .slice(0, limit);
}

/** What checking needs: the tools, the model (downloaded the first time) and the device to use. */
async function verifySetup(settings) {
  const t = await verify.tools();
  const missing = ['ffmpeg', 'ffprobe', 'whisper'].filter((k) => !t[k]);
  if (missing.length) throw new Error(`Checking files needs ${missing.join(', ')} — they come with the Dualarr Docker image`);
  const model = await verify.ensureModel(settings.verifyModel);
  return { model, device: verify.deviceArgs(settings.verifyDevice, t.devices), subtitles: settings.requireSubtitles };
}

/**
 * Checks files and stores what was found. `due`: [{ s, f }] from dueForVerify. Files this
 * container can't see (a missing volume or path mapping) are counted, not checked.
 */
async function verifyFiles(due, settings, summary) {
  if (!due.length) return;
  const setup = await verifySetup(settings);
  const t0 = Date.now();
  const v = { files: 0, missing: 0, failed: 0, device: setup.device.label, mismatches: [] };
  summary.verified = v;
  let missingExample = null;
  for (const { s, f } of due) {
    const file = verify.mapPath(f.path || '', settings.pathMappings);
    if (!f.path || !fs.existsSync(file)) {
      v.missing++;
      missingExample ??= file;
      continue;
    }
    let check;
    try {
      check = await verify.checkFile(file, setup);
      v.files++;
    } catch (e) {
      v.failed++;
      check = { error: e.message };
      summary.warnings.push(`Checking ${f.relativePath}: ${e.message}`);
    }
    store.saveCheck(f.id, s.id, f.size || 0, check);
    const notes = rules.classifyFile(f, ruleOptions(settings, s), { ...check, size: f.size || 0 }).notes;
    if (!check.error && notes.length && v.mismatches.length < 50) v.mismatches.push({ title: s.title, file: f.relativePath, notes });
  }
  v.seconds = Math.round((Date.now() - t0) / 1000);
  if (v.missing) summary.warnings.push(`${v.missing} file(s) not found in this container, e.g. ${missingExample} — mount the media folder and check the path mappings in Settings`);
  log(`Checked ${v.files} file(s) on ${v.device} in ${v.seconds}s: ${v.mismatches.length} disagree with their tags`);
}

async function verifyDue(fetched, settings, summary, opts) {
  await verifyFiles(dueForVerify(fetched, settings, opts), settings, summary);
}

/**
 * Checks files now (Verify buttons): the next `verifyPerRun` files due, or every file of the given
 * series again. Then stores the new verdicts and notifies like a scan.
 */
export function verifyJob({ seriesIds = null, force = false } = {}) {
  return job('verify', async (summary, client, settings) => {
    if (!settings.verify) throw new Error('Turn on “Check files” in Settings first');
    const prev = new Map(store.listSeries().map((s) => [s.id, s]));
    const { fetched } = await fetchSeries(client, settings, summary, seriesIds);
    const due = dueForVerify(fetched, settings, { force, limit: seriesIds ? Infinity : settings.verifyPerRun });
    if (!due.length) throw new Error('Every file has been checked already');
    await verifyFiles(due, settings, summary);
    const rows = fetched.map(({ s, files }) => saveVerdicts(s, files, settings));
    const changes = rules.diffScans(prev, rows);
    Object.assign(summary, { upgraded: changes.upgraded, problems: changes.problems });
    await notifyChanges(settings, changes, summary);
    return rows;
  });
}

/** Tries checking on one file of the library (the Settings test button); nothing is stored. */
export function verifyTestJob() {
  return job('verify-test', async (summary, client, settings) => {
    const setup = await verifySetup(settings);
    const rows = store.listSeries().filter((r) => r.total);
    if (!rows.length) throw new Error('Scan the library first');
    let example = null;
    // If the first few series' files aren't visible, none are: don't read the whole library.
    for (const row of rows.slice(0, 25)) {
      const files = (await client.episodeFiles(row.id)).filter((x) => x.path);
      example ??= files[0] && verify.mapPath(files[0].path, settings.pathMappings);
      const f = files.find((x) => fs.existsSync(verify.mapPath(x.path, settings.pathMappings)));
      if (!f) continue;
      const check = await verify.checkFile(verify.mapPath(f.path, settings.pathMappings), setup);
      const found = rules.classifyFile(f, ruleOptions(settings, row), { ...check, size: f.size || 0 });
      summary.tested = { title: row.title, file: f.relativePath, device: setup.device.label, seconds: check.seconds };
      return { title: row.title, file: f.relativePath, check, status: found.status, notes: found.notes, device: setup.device.label };
    }
    throw new Error(`None of the library's files are visible in this container${example ? ` (looked for ${example})` : ''} — mount the media folder and check the path mappings`);
  });
}

// ---------- searching ----------

/** Asks Sonarr to search for better releases of the files in a series that need them. */
export async function searchSeries(client, row) {
  const plan = rules.searchPlan(row.files, await client.episodes(row.id), rules.MODES[row.mode || 'dual'].needsSearch);
  for (const seasonNumber of plan.seasons) await client.command({ name: 'SeasonSearch', seriesId: row.id, seasonNumber });
  if (plan.episodeIds.length) await client.command({ name: 'EpisodeSearch', episodeIds: plan.episodeIds });
  store.markSearched(row.id);
  return { id: row.id, title: row.title, seasons: plan.seasons.length, episodes: plan.episodeIds.length };
}

/**
 * The scheduled search: the monitored series that still need work and haven't been searched in
 * `searchAgainDays`, least recently searched first, at most `searchPerRun` of them — so a large
 * library is worked through over several nights without hammering the indexers.
 */
export function dueForSearch(rows, settings, now = Date.now()) {
  const before = now - settings.searchAgainDays * 86_400_000;
  return rows
    .filter((r) => r.monitored && rules.needsSearch(r) && (!r.searchedAt || Date.parse(r.searchedAt) < before))
    .sort((a, b) => String(a.searchedAt || '').localeCompare(String(b.searchedAt || '')))
    .slice(0, settings.searchPerRun);
}

async function searchDue(client, settings, summary) {
  const out = [];
  for (const row of dueForSearch(store.listSeries(), settings)) {
    try {
      out.push(await searchSeries(client, row));
    } catch (e) {
      summary.warnings.push(`Search for ${row.title}: ${e.message}`);
    }
  }
  return out;
}

/** Searches the given series now (the Search buttons), whatever the schedule says. */
export function searchJob(ids) {
  return job('search', async (summary, client) => {
    const rows = ids.map(store.getSeries).filter((r) => r && rules.needsSearch(r));
    if (!rows.length) throw new Error('Nothing to search for — every file is already as it should be');
    summary.searched = [];
    for (const row of rows) {
      try {
        summary.searched.push(await searchSeries(client, row));
      } catch (e) {
        summary.warnings.push(`Search for ${row.title}: ${e.message}`);
      }
    }
    return summary.searched;
  });
}

// ---------- replacing ----------

/**
 * Replaces files that break the rules (no original-language audio / no subtitles / dual audio in
 * an original-only series): blocklists the release that produced each one (when Sonarr's history
 * says which), deletes the file, and searches for the episodes again. Files are judged as the
 * library shows them (with their checks), and ones that are fine by now are left alone.
 */
export function replaceJob(seriesId, fileIds) {
  return job('replace', async (summary, client, settings) => {
    const { series, targets } = await filesToReplace(client, settings, seriesId, fileIds);
    if (!targets.length) throw new Error('None of those files break the rules any more — scan again');
    const r = await replaceFiles(client, settings, series, targets, summary);
    summary.replaced = { title: r.row.title, files: r.files, blocklisted: r.blocklisted, episodes: r.episodes };
    log(`Replaced ${r.files} file(s) of ${r.row.title} (${r.blocklisted} blocklisted)`);
    return r.row;
  });
}

/**
 * A series' files among `fileIds` that break its rules right now (read fresh from Sonarr, judged
 * with their checks, as the library shows them). `statuses`: the verdicts to take.
 */
async function filesToReplace(client, settings, seriesId, fileIds, statuses = null) {
  const [series, files] = await Promise.all([client.seriesById(seriesId), client.episodeFiles(seriesId)]);
  const opts = ruleOptions(settings, series);
  const wanted = statuses || rules.MODES[opts.mode].replaceable;
  const checks = store.getChecks(seriesId);
  const targets = files.filter((f) => fileIds.includes(f.id) && wanted.includes(rules.classifyFile(f, opts, checks.get(f.id)).status));
  return { series, targets };
}

/**
 * Blocklists the grab behind each file (so Sonarr won't download that release again), deletes the
 * file and searches its episodes again, then rescans the series. With `requireGrab`, a file whose
 * grab can't be found or blocklisted is left alone: deleting it could bring the same release back.
 */
async function replaceFiles(client, settings, series, targets, summary, { requireGrab = false } = {}) {
  const [episodes, history] = await Promise.all([client.episodes(series.id), client.seriesHistory(series.id).catch(() => [])]);
  let blocklisted = 0;
  const done = [];
  const skipped = [];
  for (const f of targets) {
    const grab = rules.grabFor(history, f);
    let listed = false;
    if (grab) {
      try {
        await client.markFailed(grab.id);
        blocklisted++;
        listed = true;
      } catch (e) {
        summary.warnings.push(`Could not blocklist ${grab.sourceTitle}: ${e.message}`);
      }
    }
    if (requireGrab && !listed) {
      skipped.push(f);
      continue;
    }
    await client.deleteEpisodeFile(f.id);
    done.push(f);
  }
  const replacedIds = new Set(done.map((f) => f.id));
  const episodeIds = episodes.filter((e) => replacedIds.has(e.episodeFileId)).map((e) => e.id);
  if (episodeIds.length) await client.command({ name: 'EpisodeSearch', episodeIds });
  const row = done.length ? saveVerdicts(series, await client.episodeFiles(series.id), settings) : null;
  return { row, files: done.length, blocklisted, episodes: episodeIds.length, skipped: skipped.length };
}

/**
 * The scheduled replacement (settings.autoReplace): files in monitored series that break the
 * chosen rules are replaced, at most `replacePerRun` a scan. The new downloads are checked at the
 * next scan, and replaced again if they are wrong too — each wrong release is blocklisted, so it
 * never comes back. Files Sonarr's history can't tie to a release are left for a manual Replace.
 */
async function replaceDue(client, settings, summary, { notify = true } = {}) {
  const out = [];
  let budget = settings.replacePerRun;
  let skipped = 0;
  for (const row of store.listSeries()) {
    if (budget <= 0) break;
    const statuses = rules.autoReplaceable(row.mode, settings.autoReplace);
    const ids = row.monitored ? row.files.filter((f) => statuses.includes(f.status)).map((f) => f.id) : [];
    if (!ids.length) continue;
    try {
      const { series, targets } = await filesToReplace(client, settings, row.id, ids, statuses);
      if (!targets.length) continue;
      const r = await replaceFiles(client, settings, series, targets.slice(0, budget), summary, { requireGrab: true });
      budget -= r.files;
      skipped += r.skipped;
      if (r.files) out.push({ id: row.id, title: row.title, files: r.files, episodes: r.episodes });
    } catch (e) {
      summary.warnings.push(`Replacing files of ${row.title}: ${e.message}`);
    }
  }
  summary.autoReplaced = out;
  if (skipped) summary.autoReplaceSkipped = skipped;
  if (out.length) log(`Replaced ${out.reduce((n, r) => n + r.files, 0)} wrong file(s) automatically`);
  if (out.length && notify && settings.notifyProblems) {
    const failures = await notifyAll(settings.notifiers || [], { kind: 'replaced', series: out });
    summary.warnings.push(...failures.map((f) => `Notification failed: ${f}`));
    if (failures.length < (settings.notifiers || []).filter((n) => n.enabled !== false).length) summary.notified = (summary.notified || 0) + 1;
  }
}

// ---------- custom formats ----------

/** Creates/updates the custom formats and applies their scores to the chosen profiles. */
export function setupJob() {
  return job('setup', async (summary, client, settings) => {
    if (!settings.profileIds.length) throw new Error('Pick at least one quality profile');
    const existing = await client.customFormats();
    const ids = {};
    for (const [key, body] of Object.entries(rules.customFormats())) {
      const cur = existing.find((c) => c.name === body.name);
      ids[key] = (await client.saveCustomFormat(cur ? { ...body, id: cur.id } : body)).id;
    }
    summary.profiles = [];
    for (const id of settings.profileIds) {
      // One missing profile (deleted in Sonarr since) shouldn't stop the others.
      try {
        const p = await client.qualityProfile(id);
        await client.saveQualityProfile(rules.profileWithScores(p, ids, settings.dualScore, rules.profileRule(id, settings.profileRules).mode));
        summary.profiles.push(p.name);
      } catch (e) {
        summary.warnings.push(`Quality profile ${id}: ${e.message}`);
      }
    }
    log(`Custom formats set up; scores applied to ${summary.profiles.join(', ')}`);
    return ids;
  });
}

/** The custom formats' ids in Sonarr (null if missing). */
export async function formatIds(client) {
  const all = await client.customFormats();
  const find = (name) => all.find((c) => c.name === name)?.id ?? null;
  return { dual: find(rules.CF_NAMES.dual), dub: find(rules.CF_NAMES.dub) };
}

/** What the setup page shows: the formats, and every profile with how many checked series use it. */
export async function setupState(client, settings) {
  const [ids, profiles, series] = await Promise.all([formatIds(client), client.qualityProfiles(), client.series()]);
  const used = new Map();
  for (const s of series) if (rules.inScope(s, settings.scope)) used.set(s.qualityProfileId, (used.get(s.qualityProfileId) || 0) + 1);
  return {
    formats: ids,
    profiles: profiles.map((p) => {
      const rule = rules.profileRule(p.id, settings.profileRules);
      return { ...rules.profileState(p, ids, rule.mode), lang: rule.lang, series: used.get(p.id) || 0 };
    }),
  };
}
