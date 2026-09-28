// The jobs against a stand-in Sonarr: scanning, paced searching, replacing and setup.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { API_KEY, library, startSonarr } from './fixtures/mock-sonarr.mjs';
import { startSink } from './fixtures/sink.mjs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-jobs-'));
const store = await import('../server/db.js');
const jobs = await import('../server/jobs.js');
const rules = await import('../server/rules.js');

let sonarr;
let sink;
before(async () => {
  sonarr = await startSonarr();
  sink = await startSink();
});
after(() => [sonarr.server, sink.server].forEach((s) => (s.closeAllConnections?.(), s.close())));

/** Every test starts from the same library, settings and an empty scan. */
function reset(settings = {}) {
  Object.assign(sonarr.state, library(), { writes: [], commands: [], failed: [], deleted: [], failSeries: new Set(), failHistory: false, failCommands: false, failMarkFailed: false });
  sink.received.length = 0;
  sink.fail = false;
  store.db.exec('DELETE FROM series; DELETE FROM runs; DELETE FROM settings');
  store.saveSettings({
    sonarrUrl: sonarr.url,
    sonarrApiKey: API_KEY,
    notifiers: [{ id: 'hook', type: 'webhook', url: `${sink.url}/hook`, enabled: true }],
    ...settings,
  });
}
beforeEach(() => reset());

const events = () => sink.received.map((r) => r.body.event);

describe('the job runner', () => {
  test('needs Sonarr, records every run, and runs one job at a time', async () => {
    store.saveSettings({ sonarrUrl: '' });
    const r = await jobs.scanJob('scan');
    assert.deepEqual([r.status, r.summary.error], ['error', 'Connect Sonarr in Settings first']);
    store.saveSettings({ sonarrUrl: sonarr.url });
    const order = [];
    const a = jobs.job('first', async () => {
      assert.equal(jobs.currentJob(), 'first');
      await new Promise((res) => setTimeout(res, 20));
      order.push('first');
    });
    const b = jobs.job('second', async () => order.push('second'));
    await Promise.all([a, b]);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(jobs.currentJob(), null);
    assert.deepEqual(store.listRuns().map((x) => [x.trigger, x.status]), [['second', 'ok'], ['first', 'ok'], ['scan', 'error']]);
  });
});

describe('scanning', () => {
  test('stores a verdict for every file of every in-scope series', async () => {
    const r = await jobs.scanJob('scan');
    assert.equal(r.status, 'ok');
    assert.equal(r.summary.scanned, 4);
    assert.deepEqual(r.summary.totals.files, { dual: 3, subbed: 4, noSubs: 2, noJapanese: 1, unknown: 0 });
    assert.deepEqual(store.listSeries().map((s) => s.title), ['Dandadan', 'Frieren', 'Mushishi', 'Old Anime']);
    assert.deepEqual(store.getSeries(2).files.map((f) => f.status), ['dual', 'subbed', 'noJapanese']);
    assert.deepEqual([r.summary.upgraded, r.summary.problems], [[], []], 'the first scan announces nothing');
    assert.equal(sink.received.length, 0);
  });

  test('the Japanese scope adds Japanese originals; narrowing it forgets them', async () => {
    store.saveSettings({ scope: 'japanese' });
    await jobs.scanJob('scan');
    assert.equal(store.getSeries(4).files[0].status, 'unknown');
    store.saveSettings({ scope: 'anime' });
    await jobs.scanJob('scan');
    assert.equal(store.getSeries(4), null);
  });

  test('a series that fails is a warning, and keeps its last scan', async () => {
    await jobs.scanJob('scan');
    sonarr.state.failSeries.add(1);
    const r = await jobs.scanJob('scan');
    assert.equal(r.status, 'partial');
    assert.match(r.summary.warnings[0], /^Frieren: Sonarr \/episodefile: HTTP 500/);
    assert.equal(r.summary.scanned, 4);
    assert.equal(store.getSeries(1).total, 4);
  });

  test('upgrades and new problems are announced', async () => {
    await jobs.scanJob('scan');
    // Frieren season 2 arrives in dual audio; Mushishi gets an English dub.
    for (const f of sonarr.state.files) {
      if (f.seriesId === 1 && f.seasonNumber === 2) Object.assign(f, { id: f.id + 1000, mediaInfo: { audioLanguages: 'jpn/eng', subtitles: 'eng' } });
      if (f.id === 302) f.mediaInfo = { audioLanguages: 'eng', subtitles: '' };
    }
    const r = await jobs.scanJob('scan');
    assert.deepEqual(r.summary.upgraded, [{ id: 1, title: 'Frieren', files: 2 }]);
    assert.deepEqual(r.summary.problems, [{ id: 3, title: 'Mushishi', noJapanese: 1, noSubs: 0 }]);
    assert.deepEqual(events(), ['upgraded', 'problems']);
    assert.equal(r.summary.notified, 2);
  });

  test('notifications can be turned off, per kind or for a quiet rescan', async () => {
    await jobs.scanJob('scan');
    sonarr.state.files.find((f) => f.id === 202).mediaInfo.audioLanguages = 'eng';
    await jobs.scanJob('rules', { notify: false });
    store.saveSettings({ notifyProblems: false });
    sonarr.state.files.find((f) => f.id === 201).mediaInfo.audioLanguages = 'eng';
    await jobs.scanJob('scan');
    assert.deepEqual(sink.received, []);
  });

  test('a failed notification is a warning', async () => {
    await jobs.scanJob('scan');
    sonarr.state.files.find((f) => f.id === 202).mediaInfo.audioLanguages = 'jpn/eng';
    sink.fail = true;
    const r = await jobs.scanJob('scan');
    assert.equal(r.status, 'partial');
    assert.match(r.summary.warnings[0], /^Notification failed: Webhook \(JSON\): HTTP 500/);
    assert.equal(r.summary.notified, undefined, 'nothing was sent');
  });

  test('a scheduled scan that cannot reach Sonarr says so', async () => {
    store.saveSettings({ sonarrApiKey: 'wrong' });
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    assert.equal(r.status, 'error');
    assert.deepEqual(events(), ['error']);
    assert.match(sink.received[0].body.error, /HTTP 401/);
    await jobs.scanJob('scan');
    assert.equal(sink.received.length, 1, 'only the scheduled one');
  });
});

describe('searching', () => {
  const row = (id, searchedAt, extra = {}) => ({ id, monitored: true, counts: { subbed: 1, noSubs: 0, noJapanese: 0 }, searchedAt, ...extra });
  const settings = { searchPerRun: 2, searchAgainDays: 7 };
  const now = Date.parse('2026-09-28T04:00:00Z');

  test('dueForSearch: least recently searched first, paced and capped', () => {
    const rows = [
      row(1, '2026-09-25T04:00:00Z'), // searched 3 days ago: not yet
      row(2, '2026-09-01T04:00:00Z'),
      row(3, null), // never searched: first
      row(4, '2026-08-01T04:00:00Z'),
      row(5, null, { monitored: false }),
      row(6, null, { counts: { subbed: 0, noSubs: 0, noJapanese: 0 } }), // nothing to do
    ];
    assert.deepEqual(jobs.dueForSearch(rows, settings, now).map((r) => r.id), [3, 4]);
    assert.deepEqual(jobs.dueForSearch(rows, { ...settings, searchPerRun: 10 }, now).map((r) => r.id), [3, 4, 2]);
    assert.deepEqual(jobs.dueForSearch(rows, { ...settings, searchPerRun: 10, searchAgainDays: 1 }, now).map((r) => r.id), [3, 4, 2, 1]);
  });

  test('the scheduled scan searches what is due, then waits searchAgainDays', async () => {
    store.saveSettings({ searchPerRun: 2 });
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(r.summary.searched.map((s) => s.title), ['Dandadan', 'Frieren'], 'two of three, by title order on a tie');
    assert.deepEqual(sonarr.state.commands, [
      { name: 'EpisodeSearch', episodeIds: [1006, 1007] },
      { name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 },
    ]);
    assert.ok(store.getSeries(1).searchedAt);
    const again = await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(again.summary.searched.map((s) => s.title), ['Mushishi']);
    const third = await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(third.summary.searched, []);
    assert.equal(store.getSeries(6).searchedAt, null, 'unmonitored series are left alone');
  });

  test('auto search can be off; manual scans never search', async () => {
    await jobs.scanJob('scan');
    store.saveSettings({ autoSearch: false });
    await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(sonarr.state.commands, []);
  });

  test('searchJob: the Search buttons', async () => {
    await jobs.scanJob('scan');
    const r = await jobs.searchJob([1, 2, 999]);
    assert.deepEqual(r.summary.searched, [
      { id: 1, title: 'Frieren', seasons: 1, episodes: 0 },
      { id: 2, title: 'Dandadan', seasons: 0, episodes: 2 },
    ]);
    const none = await jobs.searchJob([999]);
    assert.equal(none.status, 'error');
    assert.match(none.summary.error, /Nothing to search for/);
  });

  test('a failed search is a warning', async () => {
    await jobs.scanJob('scan');
    sonarr.state.failCommands = true;
    const r = await jobs.searchJob([2]);
    assert.equal(r.status, 'partial');
    assert.match(r.summary.warnings[0], /^Search for Dandadan: Sonarr \/command: HTTP 500/);
    assert.equal(store.getSeries(2).searchedAt, null, 'not marked as searched');
  });
});

describe('replacing', () => {
  test('blocklists the grab, deletes the file, searches the episode and rescans', async () => {
    await jobs.scanJob('scan');
    const r = await jobs.replaceJob(2, [203, 201]);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.summary.replaced, { title: 'Dandadan', files: 1, blocklisted: 1, episodes: 1 });
    assert.deepEqual(sonarr.state.failed, [900]);
    assert.deepEqual(sonarr.state.deleted, [203], 'the dual audio file is not touched');
    assert.deepEqual(sonarr.state.commands, [{ name: 'EpisodeSearch', episodeIds: [1007] }]);
    // Blocklist before delete: once the file is gone Sonarr can't tie the grab to it.
    assert.deepEqual(sonarr.state.writes.map((w) => `${w.method} ${w.path}`), ['POST /history/failed/900', 'DELETE /episodefile/203', 'POST /command']);
    assert.deepEqual(store.getSeries(2).counts, { dual: 1, subbed: 1, noSubs: 0, noJapanese: 0, unknown: 0 });
  });

  test('without history the file is still replaced', async () => {
    sonarr.state.failHistory = true;
    const r = await jobs.replaceJob(3, [301]);
    assert.deepEqual(r.summary.replaced, { title: 'Mushishi', files: 1, blocklisted: 0, episodes: 1 });
    assert.deepEqual(sonarr.state.failed, []);
    assert.deepEqual(sonarr.state.commands, [{ name: 'EpisodeSearch', episodeIds: [1008] }]);
  });

  test('refuses files that are fine now', async () => {
    const r = await jobs.replaceJob(2, [201, 202]);
    assert.deepEqual([r.status, r.summary.error], ['error', 'None of those files break the rules any more — scan again']);
    assert.deepEqual(sonarr.state.deleted, []);
  });

  test('a grab that cannot be blocklisted is a warning; the file is still replaced', async () => {
    sonarr.state.failMarkFailed = true;
    const r = await jobs.replaceJob(2, [203]);
    assert.equal(r.status, 'partial');
    assert.match(r.summary.warnings[0], /^Could not blocklist Dandadan\.S01E03\.1080p\.WEB\.English\.Dub: .*HTTP 500/);
    assert.deepEqual([r.summary.replaced.blocklisted, sonarr.state.deleted], [0, [203]]);
  });
});

describe('setup', () => {
  test('creates the formats and scores the chosen profiles; again updates them', async () => {
    store.saveSettings({ profileIds: [1, 4] });
    const r = await jobs.setupJob();
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.summary.profiles, ['Anime', 'HD-1080p']);
    const ids = r.result;
    assert.deepEqual(sonarr.state.customFormats.map((c) => c.name), ['Tier 1 Group', rules.CF_NAMES.dual, rules.CF_NAMES.dub]);
    const anime = sonarr.state.qualityProfiles[0];
    assert.equal(rules.profileState(anime, ids).ready, true);
    assert.equal(anime.formatItems.length, 3, 'the items Sonarr added are updated, not duplicated');
    assert.equal(sonarr.state.qualityProfiles[2].formatItems.find((f) => f.format === ids.dual).score, 0, 'unchosen profiles untouched');

    sonarr.state.writes.length = 0;
    const again = await jobs.setupJob();
    assert.deepEqual(again.result, ids);
    assert.equal(sonarr.state.customFormats.length, 3);
    assert.deepEqual(sonarr.state.writes.map((w) => `${w.method} ${w.path}`), [
      `PUT /customformat/${ids.dual}`, `PUT /customformat/${ids.dub}`, 'PUT /qualityprofile/1', 'PUT /qualityprofile/4',
    ]);
  });

  test('needs a profile; a missing one is a warning', async () => {
    const none = await jobs.setupJob();
    assert.equal(none.summary.error, 'Pick at least one quality profile');
    store.saveSettings({ profileIds: [99, 7] });
    const r = await jobs.setupJob();
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.summary.profiles, ['Ultra-HD']);
    assert.match(r.summary.warnings[0], /^Quality profile 99: Sonarr \/qualityprofile\/99: HTTP 404/);
  });

  test('setupState: formats, and each profile with the series that use it', async () => {
    const client = (await import('../server/sonarr.js')).sonarrClient(store.getSettings());
    const before = await jobs.setupState(client, store.getSettings());
    assert.deepEqual(before.formats, { dual: null, dub: null });
    assert.deepEqual(before.profiles.map((p) => [p.name, p.series, p.ready]), [['Anime', 3, false], ['HD-1080p', 1, false], ['Ultra-HD', 0, false]]);
    store.saveSettings({ profileIds: [1], scope: 'japanese' });
    await jobs.setupJob();
    const st = await jobs.setupState(client, store.getSettings());
    assert.deepEqual(st.profiles.map((p) => [p.name, p.series, p.ready]), [['Anime', 3, true], ['HD-1080p', 2, false], ['Ultra-HD', 0, false]]);
  });
});
