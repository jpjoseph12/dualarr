// The jobs against a stand-in Sonarr: scanning, paced searching, replacing and setup.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { API_KEY, library, startSonarr } from './fixtures/mock-sonarr.mjs';
import { startSink } from './fixtures/sink.mjs';
import { hasFfmpeg, makeEpisode } from './fixtures/media.mjs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-jobs-'));
process.env.WHISPER_BIN = new URL('./fixtures/fake-whisper.mjs', import.meta.url).pathname;
const store = await import('../server/db.js');
const verify = await import('../server/verify.js');
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
  store.db.exec('DELETE FROM series; DELETE FROM runs; DELETE FROM settings; DELETE FROM checks');
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
    assert.deepEqual(r.summary.upgraded, [{ id: 1, title: 'Frieren', files: 2, mode: 'dual' }]);
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

describe('automatic replacement', () => {
  test('off by default: a scheduled scan deletes nothing', async () => {
    await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(sonarr.state.deleted, []);
  });

  test('wrong language: blocklisted, deleted and searched again after a scheduled scan', async () => {
    store.saveSettings({ autoReplace: 'language', autoSearch: false });
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual(r.summary.autoReplaced, [{ id: 2, title: 'Dandadan', files: 1, episodes: 1 }]);
    assert.deepEqual([sonarr.state.failed, sonarr.state.deleted], [[900], [203]], 'the English dub; no-subs files are left alone');
    assert.deepEqual(sonarr.state.commands, [{ name: 'EpisodeSearch', episodeIds: [1007] }]);
    assert.equal(store.getSeries(2).counts.noJapanese, 0);
    assert.ok(events().includes('replaced'));
    // Manual scans never replace.
    sonarr.state.deleted.length = 0;
    await jobs.scanJob('scan');
    assert.deepEqual(sonarr.state.deleted, []);
  });

  test('a file without a grab to blocklist is left for a manual Replace; unmonitored series are skipped', async () => {
    store.saveSettings({ autoReplace: 'all', autoSearch: false });
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    // Mushishi S01E01 has no subtitles but no grab in the history; Old Anime is unmonitored.
    assert.deepEqual(sonarr.state.deleted, [203]);
    assert.equal(r.summary.autoReplaceSkipped, 1);
    assert.equal(r.status, 'ok', 'not a warning: it is reported, not a failure');
  });

  test('capped per scan, and dual audio counts as wrong in an original-only profile', async () => {
    store.saveSettings({ autoReplace: 'language', replacePerRun: 1, autoSearch: false, profileRules: { 1: { mode: 'original', lang: 'ja' } } });
    // Give the dual audio files grabs, so they can be blocklisted.
    sonarr.state.history[1] = [101, 102].map((id) => ({ id: 800 + id, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', sourceTitle: `Frieren.${id}.Dual.Audio` }));
    for (const f of sonarr.state.files) if (f.seriesId === 1 && f.seasonNumber === 1) f.sceneName = `Frieren.${f.id}.Dual.Audio`;
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    assert.equal(r.summary.autoReplaced.reduce((n, x) => n + x.files, 0), 1, 'one file this scan');
    assert.equal(sonarr.state.deleted.length, 1);
  });
});

describe('per-profile rules', () => {
  test('an original-only profile: subbed is done, dual audio is replaced like a dub', async () => {
    store.saveSettings({ profileRules: { 1: { mode: 'original', lang: 'ja' } } });
    await jobs.scanJob('scan');
    const frieren = store.getSeries(1);
    assert.deepEqual([frieren.mode, rules.seriesState(frieren)], ['original', 'problem'], 'season 1 is dual audio');
    assert.equal(store.getSeries(3).mode, 'dual', 'other profiles keep dual audio');
    const r = await jobs.replaceJob(2, [201, 202, 203]);
    assert.equal(r.status, 'ok');
    assert.deepEqual(sonarr.state.deleted, [201, 203], 'the subbed file is kept');
    assert.deepEqual(store.getSeries(2).counts, { dual: 0, subbed: 1, noSubs: 0, noJapanese: 0, unknown: 0 });
    assert.equal(rules.seriesState(store.getSeries(2)), 'done');
  });

  test("'auto' language: a Chinese show needs Chinese audio, anime still Japanese", async () => {
    sonarr.state.series.push({ id: 7, title: 'Link Click', year: 2021, titleSlug: 'link-click', seriesType: 'anime', monitored: true, qualityProfileId: 1, originalLanguage: { name: 'Chinese' }, images: [] });
    const lc = (id, audio) => ({ id, seriesId: 7, seasonNumber: 1, relativePath: `Link Click/Season 1/Link Click - S01E0${id - 700}.mkv`, size: 1e9, mediaInfo: { audioLanguages: audio, subtitles: 'eng' } });
    sonarr.state.files.push(lc(701, 'chi'), lc(702, 'jpn'));
    store.saveSettings({ profileRules: { 1: { mode: 'original', lang: 'auto' } } });
    await jobs.scanJob('scan');
    const row = store.getSeries(7);
    assert.deepEqual([row.lang, row.originalLanguage, row.files.map((f) => f.status)], ['zh', 'Chinese', ['subbed', 'noJapanese']], 'a Japanese dub of a donghua has no original audio');
    assert.deepEqual([store.getSeries(2).lang, store.getSeries(2).files.map((f) => f.status)], ['ja', ['dual', 'subbed', 'noJapanese']]);
  });

  test('setup blocks dual audio only in original-only profiles', async () => {
    store.saveSettings({ profileIds: [1, 4], profileRules: { 4: { mode: 'original', lang: 'ja' } } });
    const r = await jobs.setupJob();
    const ids = r.result;
    const dualScore = (id) => sonarr.state.qualityProfiles.find((p) => p.id === id).formatItems.find((fi) => fi.format === ids.dual).score;
    assert.deepEqual([dualScore(1), dualScore(4)], [2000, rules.DUB_SCORE]);
    const client = (await import('../server/sonarr.js')).sonarrClient(store.getSettings());
    const st = await jobs.setupState(client, store.getSettings());
    assert.deepEqual(st.profiles.map((p) => [p.name, p.mode, p.lang, p.ready]), [
      ['Anime', 'dual', 'ja', true],
      ['HD-1080p', 'original', 'ja', true],
      ['Ultra-HD', 'dual', 'ja', false],
    ]);
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

describe('checking files', { skip: !hasFfmpeg() && 'needs ffmpeg' }, () => {
  const MEDIA = path.join(process.env.CONFIG_DIR, 'media');
  const ep = (rel, spec) => makeEpisode(path.join(MEDIA, rel), spec);
  const on = { verify: true, pathMappings: [{ from: '/anime', to: MEDIA }], verifyPerRun: 20 };

  before(() => {
    // The model is a stand-in; fake-whisper.mjs only checks it exists.
    fs.mkdirSync(path.join(process.env.CONFIG_DIR, 'models'), { recursive: true });
    fs.writeFileSync(verify.modelPath('base'), 'lmgg');
    // Dandadan's files as they really are, whatever their tags say:
    ep('Dandadan/Season 1/Dandadan - S01E01.mkv', { audio: [{ sound: 'ja', tag: 'jpn' }, { sound: 'en', tag: 'eng' }], subs: [{ lang: 'en', tag: 'eng', kind: 'signs' }] });
    ep('Dandadan/Season 1/Dandadan - S01E02.mkv', { audio: [{ sound: 'en', tag: 'jpn' }], subs: [{ lang: 'en', tag: 'eng' }] });
    ep('Dandadan/Season 1/Dandadan - S01E03.mkv', { audio: [{ sound: 'ja', tag: 'eng' }], subs: [{ lang: 'en', tag: 'eng' }] });
  });
  // The mock's file sizes are made up; the checks must match them.
  const sizes = () => sonarr.state.files.forEach((f) => (f.size = 1e9));

  test('the scheduled scan checks what is due, and its verdicts use what it found', async () => {
    reset(on);
    sizes();
    await jobs.scanJob('scan'); // the tags alone first
    assert.deepEqual(store.getSeries(2).counts, { dual: 1, subbed: 1, noSubs: 0, noJapanese: 1, unknown: 0 });
    const r = await jobs.scanJob('schedule', { autoSearch: true });
    const v = r.summary.verified;
    assert.deepEqual([v.files, v.missing, v.failed, v.device], [3, 7, 0, 'CPU']);
    assert.deepEqual(v.mismatches, [
      { title: 'Dandadan', file: 'Dandadan/Season 1/Dandadan - S01E01.mkv', notes: ['Subtitles 1 (English) are signs & songs only'] },
      { title: 'Dandadan', file: 'Dandadan/Season 1/Dandadan - S01E02.mkv', notes: ['Audio 1 is tagged Japanese but sounds English'] },
      { title: 'Dandadan', file: 'Dandadan/Season 1/Dandadan - S01E03.mkv', notes: ['Audio 1 is tagged English but sounds Japanese'] },
    ]);
    assert.match(r.summary.warnings.find((w) => /not found/.test(w)), /^7 file\(s\) not found in this container, e\.g\. .*media\/.* — mount the media folder/);
    const row = store.getSeries(2);
    assert.deepEqual([row.counts, row.verified], [{ dual: 0, subbed: 1, noSubs: 1, noJapanese: 1, unknown: 0 }, 3]);
    assert.deepEqual(row.files.map((f) => [f.status, f.verified]), [['noSubs', true], ['noJapanese', true], ['subbed', true]]);
    assert.deepEqual(r.summary.problems, [{ id: 2, title: 'Dandadan', noJapanese: 0, noSubs: 1 }], 'what the check found is news');
    assert.deepEqual(events(), ['problems']);
    assert.ok(r.summary.searched.length, 'and searches as usual');

    // Next time only the files it couldn't see are due.
    const again = await jobs.scanJob('schedule', { autoSearch: true });
    assert.deepEqual([again.summary.verified.files, again.summary.verified.missing], [0, 7]);
    assert.equal(store.getSeries(2).verified, 3, 'checks are kept');
  });

  test('manual scans don’t check; with checking off the schedule doesn’t either', async () => {
    reset({ ...on });
    sizes();
    assert.equal((await jobs.scanJob('scan')).summary.verified, undefined);
    store.saveSettings({ verify: false });
    assert.equal((await jobs.scanJob('schedule', { autoSearch: true })).summary.verified, undefined);
  });

  test('dueForVerify: never checked or changed, Sonarr’s unknowns first, then the newest', () => {
    reset(on);
    const s = { id: 9 };
    const f = (id, extra) => ({ id, size: 10, relativePath: `${id}.mkv`, mediaInfo: { audioLanguages: 'jpn', subtitles: 'eng' }, ...extra });
    store.saveCheck(1, 9, 10, { audio: [] });
    store.saveCheck(2, 9, 99, { audio: [] }); // the file changed since
    const fetched = [{ s, files: [f(1), f(2, { dateAdded: '2026-01-01' }), f(3, { dateAdded: '2026-06-01' }), f(4, { mediaInfo: null }), f(5)] }];
    assert.deepEqual(jobs.dueForVerify(fetched, store.getSettings()).map((d) => d.f.id), [4, 3, 2, 5]);
    assert.deepEqual(jobs.dueForVerify(fetched, store.getSettings(), { limit: 2 }).map((d) => d.f.id), [4, 3]);
    assert.deepEqual(jobs.dueForVerify(fetched, store.getSettings(), { force: true }).map((d) => d.f.id), [4, 3, 2, 1, 5]);
  });

  test('verifyJob: the next files, or a series again', async () => {
    reset(on);
    sizes();
    await jobs.scanJob('scan');
    const off = await jobs.verifyJob({ seriesIds: [2] });
    assert.equal(off.status, 'ok');
    assert.equal(off.summary.verified.files, 3);
    assert.deepEqual(off.summary.problems, [{ id: 2, title: 'Dandadan', noJapanese: 0, noSubs: 1 }]);
    const none = await jobs.verifyJob({ seriesIds: [2] });
    assert.equal(none.summary.error, 'Every file has been checked already');
    const force = await jobs.verifyJob({ seriesIds: [2], force: true });
    assert.equal(force.summary.verified.files, 3, 'force checks them again');
    const next = await jobs.verifyJob();
    assert.deepEqual([next.summary.verified.files, next.summary.verified.missing], [0, 7], 'the rest are not visible');
    store.saveSettings({ verify: false });
    assert.match((await jobs.verifyJob()).summary.error, /Turn on “Check files” in Settings first/);
  });

  test('a file that can’t be read is noted and not tried again; missing tools stop the job', async () => {
    reset(on);
    sizes();
    const junk = path.join(MEDIA, 'Frieren/Season 1/Frieren - S01E01.mkv');
    fs.mkdirSync(path.dirname(junk), { recursive: true });
    fs.writeFileSync(junk, 'not a video');
    try {
      const r = await jobs.verifyJob({ seriesIds: [1] });
      assert.equal(r.status, 'partial');
      assert.deepEqual([r.summary.verified.files, r.summary.verified.failed], [0, 1]);
      assert.match(r.summary.warnings[0], /^Checking Frieren\/Season 1\/Frieren - S01E01\.mkv: ffprobe failed/);
      assert.match(store.getSeries(1).files[0].notes[0], /^Couldn’t check the file: ffprobe failed/);
      assert.deepEqual(jobs.dueForVerify([{ s: { id: 1 }, files: sonarr.state.files.filter((f) => f.seriesId === 1) }], store.getSettings()).map((d) => d.f.id), [102, 103, 104]);
    } finally {
      fs.rmSync(junk);
    }
    const bin = verify.BIN.whisper;
    verify.BIN.whisper = '/nonexistent/whisper-cli';
    await verify.tools({ refresh: true });
    try {
      const r = await jobs.verifyJob({ seriesIds: [2] });
      assert.equal(r.summary.error, 'Checking files needs whisper — they come with the Dualarr Docker image');
    } finally {
      verify.BIN.whisper = bin;
      await verify.tools({ refresh: true });
    }
  });

  test('verifyTestJob tries one visible file and stores nothing', async () => {
    reset(on);
    assert.equal((await jobs.verifyTestJob()).summary.error, 'Scan the library first');
    await jobs.scanJob('scan');
    const r = await jobs.verifyTestJob();
    assert.deepEqual([r.result.title, r.result.file, r.result.status, r.result.device], ['Dandadan', 'Dandadan/Season 1/Dandadan - S01E01.mkv', 'noSubs', 'CPU']);
    assert.deepEqual(r.result.notes, ['Subtitles 1 (English) are signs & songs only']);
    assert.equal(r.summary.tested.title, 'Dandadan');
    assert.equal(store.getChecks(2).size, 0);
    store.saveSettings({ pathMappings: [] });
    assert.match((await jobs.verifyTestJob()).summary.error, /^None of the library's files are visible in this container \(looked for \/anime\/Dandadan\/.*\) — mount the media folder/);
  });

  test('checks are forgotten with their files and series', async () => {
    reset(on);
    sizes();
    await jobs.scanJob('scan');
    await jobs.verifyJob({ seriesIds: [2] });
    assert.equal(store.getChecks(2).size, 3);
    sonarr.state.files = sonarr.state.files.filter((f) => f.id !== 201);
    await jobs.scanJob('scan');
    assert.deepEqual([...store.getChecks(2).keys()], [202, 203]);
    sonarr.state.series = sonarr.state.series.filter((s) => s.id !== 2);
    await jobs.scanJob('scan');
    assert.equal(store.getChecks(2).size, 0);
  });
});
