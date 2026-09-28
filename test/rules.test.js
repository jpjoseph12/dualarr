// The pure rules: languages, verdicts, searches, grabs, and the Sonarr custom formats/scores.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as rules from '../server/rules.js';
import { library } from './fixtures/mock-sonarr.mjs';

const f = (audioLanguages, subtitles, extra = {}) => ({
  id: 1, seasonNumber: 1, relativePath: 'Show/Season 1/Show - S01E01.mkv', mediaInfo: { audioLanguages, subtitles }, ...extra,
});
const verdict = (file, opts) => rules.classifyFile(file, opts).status;

describe('languages', () => {
  test('Sonarr v4 codes, v3 names, regions and junk all normalise', () => {
    assert.deepEqual(rules.langs('jpn/eng'), ['ja', 'en']);
    assert.deepEqual(rules.langs('Japanese / English'), ['ja', 'en']);
    assert.deepEqual(rules.langs('ja-JP, en-US | en'), ['ja', 'en'], 'regions dropped, duplicates removed');
    assert.deepEqual(rules.langs('English (SDH)'), ['en']);
    assert.deepEqual(rules.langs('und/jpn'), ['und', 'ja']);
    assert.deepEqual(rules.langs('fre/ger/spa/por/ita/ara/rus/chi/kor'), ['fr', 'de', 'es', 'pt', 'it', 'ar', 'ru', 'zh', 'ko']);
    assert.deepEqual(rules.langs('tha'), ['tha'], 'unknown codes pass through');
    assert.deepEqual(rules.langs(''), []);
    assert.deepEqual(rules.langs(undefined), []);
  });
});

describe('verdicts', () => {
  test('one of each', () => {
    assert.equal(verdict(f('jpn/eng', 'eng')), 'dual');
    assert.equal(verdict(f('jpn', 'eng')), 'subbed');
    assert.equal(verdict(f('jpn', '')), 'noSubs');
    assert.equal(verdict(f('eng', 'eng')), 'noJapanese');
    assert.equal(verdict(f('', 'eng')), 'unknown', 'untagged audio');
    assert.equal(verdict(f('und', 'eng')), 'unknown', 'only undetermined audio');
    assert.equal(verdict({ id: 1, seasonNumber: 1 }), 'unknown', 'no media info at all');
  });

  test('dual audio without subtitles breaks the rules too', () => {
    assert.equal(verdict(f('jpn/eng', '')), 'noSubs');
    assert.equal(verdict(f('jpn/eng', ''), { requireSubtitles: false }), 'dual');
    assert.equal(verdict(f('jpn', ''), { requireSubtitles: false }), 'subbed');
  });

  test('a subtitle language can be required', () => {
    const opts = { subtitleLanguage: 'en' };
    assert.equal(verdict(f('jpn', 'eng'), opts), 'subbed');
    assert.equal(verdict(f('jpn', 'spa'), opts), 'noSubs');
    assert.equal(verdict(f('jpn/eng', 'spa/por'), opts), 'noSubs');
    assert.equal(verdict(f('jpn', 'spa'), { subtitleLanguage: 'es' }), 'subbed');
  });

  test('"HardSub" in the file or release name counts as subtitled', () => {
    assert.equal(verdict(f('jpn', '', { relativePath: 'Show - S01E01 [HardSub].mkv' })), 'subbed');
    assert.equal(verdict(f('jpn', '', { sceneName: 'Show.S01E01.1080p.WEB.Hard-Subbed' })), 'subbed');
    assert.equal(verdict(f('jpn', '', { sceneName: 'Show.S01E01.1080p.hardsubs' }), { subtitleLanguage: 'en' }), 'subbed');
    assert.deepEqual(rules.classifyFile(f('jpn', '', { sceneName: 'Show HardSub' })).subs, ['hardsub']);
    assert.equal(verdict(f('jpn', '', { sceneName: 'Show.S01E01.Hardware' })), 'noSubs');
  });

  test('the stored file keeps what the UI shows', () => {
    const c = rules.classifyFile({
      ...f('jpn', 'eng'), seasonNumber: 2, sceneName: 'Rel', size: 5, customFormatScore: 1500, quality: { quality: { name: 'Bluray-1080p' } },
    });
    assert.deepEqual(c, { id: 1, season: 2, path: 'Show/Season 1/Show - S01E01.mkv', release: 'Rel', quality: 'Bluray-1080p', score: 1500, size: 5, audio: ['ja'], subs: ['en'], status: 'subbed' });
    const bare = rules.classifyFile({ id: 2, seasonNumber: 1 });
    assert.deepEqual([bare.path, bare.release, bare.quality, bare.score, bare.size], ['', null, null, null, 0]);
  });
});

describe('series', () => {
  const lib = library();
  const row = (id, opts) => rules.summariseSeries(lib.series.find((s) => s.id === id), lib.files.filter((x) => x.seriesId === id), opts);

  test('scope: anime series, or Japanese originals too', () => {
    const anime = lib.series.filter((s) => rules.inScope(s, 'anime')).map((s) => s.title);
    const japanese = lib.series.filter((s) => rules.inScope(s, 'japanese')).map((s) => s.title);
    assert.deepEqual(anime, ['Frieren', 'Dandadan', 'Mushishi', 'Old Anime']);
    assert.deepEqual(japanese, ['Frieren', 'Dandadan', 'Mushishi', 'Midnight Diner', 'Old Anime']);
    assert.equal(rules.inScope({ seriesType: 'standard' }, 'japanese'), false);
  });

  test('summaries count verdicts and sort files', () => {
    const fr = row(1);
    assert.deepEqual(fr.counts, { dual: 2, subbed: 2, noSubs: 0, noJapanese: 0, unknown: 0 });
    assert.deepEqual([fr.title, fr.year, fr.titleSlug, fr.poster, fr.monitored, fr.total], ['Frieren', 2023, 'frieren', 'https://artworks.example/frieren.jpg', true, 4]);
    assert.deepEqual(fr.files.map((x) => x.id), [101, 102, 103, 104]);
    assert.equal(row(3).poster, null);
    assert.equal(rules.summariseSeries({ id: 9, title: 'Bare' }, [], {}).year, null);
  });

  test('states and totals', () => {
    const rows = [1, 2, 3, 4, 6].map((id) => row(id));
    assert.deepEqual(rows.map(rules.seriesState), ['waiting', 'problem', 'problem', 'unknown', 'problem']);
    assert.equal(rules.seriesState({ total: 0, counts: {} }), 'empty');
    assert.equal(rules.seriesState({ total: 2, counts: { dual: 1, subbed: 0, noSubs: 0, noJapanese: 0, unknown: 1 } }), 'done');
    assert.deepEqual(rows.map(rules.needsSearch), [true, true, true, false, true]);
    const t = rules.totals(rows);
    assert.deepEqual(t, {
      series: 5,
      files: { dual: 3, subbed: 4, noSubs: 2, noJapanese: 1, unknown: 1 },
      states: { done: 0, waiting: 1, problem: 3, unknown: 1, empty: 0 },
    });
  });

  test('diffScans: upgrades and new problems, but not first sightings', () => {
    const c = (dual, subbed, noSubs = 0, noJapanese = 0) => ({ dual, subbed, noSubs, noJapanese, unknown: 0 });
    const prev = new Map([
      [1, { id: 1, counts: c(2, 2) }],
      [2, { id: 2, counts: c(1, 1, 0, 1) }],
      [3, { id: 3, counts: c(0, 0, 2) }],
    ]);
    const now = [
      { id: 1, title: 'Frieren', counts: c(4, 0) }, // both subbed files upgraded
      { id: 2, title: 'Dandadan', counts: c(2, 0, 0, 1) }, // one upgraded, the dub still there
      { id: 3, title: 'Mushishi', counts: c(0, 0, 1, 1) }, // a file went from no subs to no Japanese
      { id: 7, title: 'New Show', counts: c(0, 0, 3) }, // first seen: not news
    ];
    assert.deepEqual(rules.diffScans(prev, now), {
      upgraded: [{ id: 1, title: 'Frieren', files: 2 }, { id: 2, title: 'Dandadan', files: 1 }],
      problems: [{ id: 3, title: 'Mushishi', noJapanese: 1, noSubs: 0 }],
    });
    // A new episode arriving as dual audio isn't an upgrade.
    assert.deepEqual(rules.diffScans(new Map([[1, { id: 1, counts: c(1, 1) }]]), [{ id: 1, title: 'x', counts: c(2, 1) }]).upgraded, []);
  });
});

describe('searches', () => {
  const lib = library();
  const plan = (id, statuses) => {
    const r = rules.summariseSeries(lib.series.find((s) => s.id === id), lib.files.filter((x) => x.seriesId === id), {});
    return rules.searchPlan(r.files, lib.episodes.filter((e) => e.seriesId === id), statuses);
  };

  test('a whole season that needs work gets one season search', () => {
    assert.deepEqual(plan(1), { seasons: [2], episodeIds: [] });
  });

  test('otherwise the individual monitored episodes', () => {
    assert.deepEqual(plan(2), { seasons: [], episodeIds: [1006, 1007] });
    assert.deepEqual(plan(2, ['noJapanese']), { seasons: [], episodeIds: [1007] });
    // Mushishi: the hardsubbed E02 is subbed, E01 has no subs (and isn't monitored).
    assert.deepEqual(plan(3), { seasons: [1], episodeIds: [] });
    assert.deepEqual(plan(3, ['noSubs']), { seasons: [], episodeIds: [] });
  });

  test('a single-file season is searched by episode, and nothing when nothing needs it', () => {
    const files = [{ id: 1, season: 1, status: 'subbed' }, { id: 2, season: 2, status: 'dual' }];
    const eps = [{ id: 11, seasonNumber: 1, episodeFileId: 1 }, { id: 12, seasonNumber: 2, episodeFileId: 2 }];
    assert.deepEqual(rules.searchPlan(files, eps), { seasons: [], episodeIds: [11] });
    assert.deepEqual(rules.searchPlan(files, eps, ['noSubs']), { seasons: [], episodeIds: [] });
  });
});

describe('the grab behind a file', () => {
  const lib = library();
  const dub = lib.files.find((x) => x.id === 203);
  const history = lib.history[2];

  test('found through the import record', () => {
    assert.equal(rules.grabFor(history, dub).id, 900);
    // Windows paths and case differences don't matter.
    const win = history.map((h) => (h.data ? { ...h, data: { importedPath: 'D:\\Anime\\DANDADAN\\Season 1\\Dandadan - S01E03.mkv' } } : h));
    assert.equal(rules.grabFor(win, dub).id, 900);
  });

  test('or through the release name; null when unsure', () => {
    assert.equal(rules.grabFor(history.filter((h) => h.eventType === 'grabbed'), dub).id, 900);
    assert.equal(rules.grabFor(history, { relativePath: 'x.mkv', sceneName: 'Dandadan.S01E02.1080p.WEB' }).id, 902);
    assert.equal(rules.grabFor(history, { relativePath: 'x.mkv', sceneName: 'Nothing like it' }), null);
    assert.equal(rules.grabFor(history, { relativePath: 'x.mkv' }), null);
    assert.equal(rules.grabFor([], { relativePath: '' }), null);
    // The import is there but its grab has aged out of the history.
    assert.equal(rules.grabFor(history.filter((h) => h.id !== 900), { relativePath: dub.relativePath }), null);
  });
});

describe('release names', () => {
  const dual = new RegExp(rules.DUAL_RE, 'i');
  const dub = new RegExp(rules.DUB_RE, 'i');
  // What each custom format would match: dual audio, or dubbed without being dual audio.
  const match = (name) => (dual.test(name) ? 'dual' : dub.test(name) ? 'dub' : null);

  test('dual audio releases', () => {
    for (const n of [
      '[Judas] Frieren - S01E01 (1080p) [Dual Audio]',
      'Sousou.no.Frieren.S01.1080p.BluRay.Dual-Audio.x265-GROUP',
      'Dandadan.S01E01.1080p.CR.WEB-DL.MULTi-AUDIO.AAC2.0.H.264-VARYG',
      'Dan.Da.Dan.S01E03.1080p.NF.WEB-DL.JPN+ENG.DDP5.1.H.264-GROUP',
      '[EMBER] Dandadan (2024) (Season 1) [1080p] [Dual Audio HEVC WEBRip DD+] (Dan Da Dan)',
      'Chainsaw.Man.S01.1080p.BluRay.10-Bit.Dual.Audio.FLAC.2.0.x265-YURASUKA',
      'Jujutsu.Kaisen.S02.1080p.CR.WEB-DL.JA-EN.AAC2.0-GROUP',
      'Kaguya-sama.S01.1080p.BluRay.Dual-Lang.x264',
      'Bleach.S01E01.Dubbed.Dual.Audio.1080p',
      'Show.S01.1080p.BluRay.ENG-JPN.x265',
    ]) assert.equal(match(n), 'dual', n);
  });

  test('dub-only releases', () => {
    for (const n of [
      'Spy x Family S01E01 1080p WEB H264-SENPAI [English Dub]',
      'Dandadan.S01E03.1080p.WEB.English.Dub',
      'Oshi.no.Ko.S01E01.1080p.HIDIVE.WEB-DL.AAC2.0.H.264.DUBBED-GROUP',
      '[Group] Show - 01 [Eng-Dubbed] [1080p]',
    ]) assert.equal(match(n), 'dub', n);
  });

  test('ordinary subbed releases match neither', () => {
    for (const n of [
      '[SubsPlease] Frieren - 01 (1080p) [ABCDEF12]',
      'Sousou.no.Frieren.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG',
      '[Erai-raws] Dandadan - 03 [1080p][Multiple Subtitle]',
      'Hunter.x.Hunter.2011.S01E01.1080p.BluRay.x264',
      'Dubai.Bling.S01E01.1080p.WEB',
      'Golden.Kamuy.S01E01.1080p.Japanese.WEB',
    ]) assert.equal(match(n), null, n);
  });

  test('the custom formats Dualarr creates', () => {
    const cfs = rules.customFormats();
    assert.equal(cfs.dual.name, rules.CF_NAMES.dual);
    assert.deepEqual(cfs.dual.specifications.map((s) => [s.implementation, s.fields[0].value]), [['ReleaseTitleSpecification', rules.DUAL_RE]]);
    assert.deepEqual(cfs.dub.specifications.map((s) => [s.negate, s.required]), [[false, true], [true, true]]);
  });
});

describe('quality profile scores', () => {
  const ids = { dual: 100, dub: 101 };
  const lib = library();
  const anime = lib.qualityProfiles[0]; // another format scores 1500, upgrades off

  test('applying scores fixes every problem', () => {
    const before = rules.profileState(anime, ids);
    assert.equal(before.ready, false);
    assert.deepEqual(before.problems, [
      'dual audio scores 0, not above the best other format (1500)',
      'dub-only releases can still be grabbed',
      'upgrades are off',
      '“upgrade until” score (0) stops before dual audio',
    ]);
    const p = rules.profileWithScores(anime, ids, 2000);
    assert.deepEqual(p.formatItems, [
      { format: 10, name: 'Tier 1 Group', score: 1500 },
      { format: 100, name: rules.CF_NAMES.dual, score: 2000 },
      { format: 101, name: rules.CF_NAMES.dub, score: -10000 },
    ]);
    assert.deepEqual([p.upgradeAllowed, p.cutoffFormatScore, p.minFormatScore, p.name, p.cutoff], [true, 2000, 0, 'Anime', 3]);
    const after = rules.profileState(p, ids);
    assert.deepEqual([after.ready, after.problems, after.dual, after.dub, after.top], [true, [], 2000, -10000, 1500]);
  });

  test('existing items are updated, not duplicated, and higher settings are kept', () => {
    const p0 = { ...anime, cutoffFormatScore: 5000, minFormatScore: 10, formatItems: [...anime.formatItems, { format: 100, name: 'x', score: 3 }, { format: 101, name: 'y', score: 0 }] };
    const p = rules.profileWithScores(p0, ids, 2000);
    assert.equal(p.formatItems.length, 3);
    assert.deepEqual([p.cutoffFormatScore, p.minFormatScore], [5000, 10]);
    assert.equal(rules.profileWithScores(p, ids, 2000).formatItems.length, 3, 'idempotent');
  });

  test('a low dual score is raised above the best other format for the cutoff', () => {
    const p = rules.profileWithScores(anime, ids, 1000);
    assert.equal(p.cutoffFormatScore, 1501);
    assert.deepEqual(rules.profileState(p, ids).problems, ['dual audio scores 1000, not above the best other format (1500)']);
  });

  test('a very negative minimum is raised just enough to keep dubs out', () => {
    const p = rules.profileWithScores({ ...anime, minFormatScore: -20000 }, ids, 2000);
    assert.equal(p.minFormatScore, -8499);
    assert.equal(rules.profileState(p, ids).ready, true);
  });

  test('formats scoring 10000+ are flagged: a dub could still win', () => {
    const huge = { ...anime, formatItems: [{ format: 10, score: 12000 }] };
    const p = rules.profileWithScores(huge, ids, 20000);
    assert.deepEqual(rules.profileState(p, ids).problems, ['dub-only releases can still be grabbed']);
  });

  test('before the formats exist', () => {
    const st = rules.profileState({ id: 7, name: 'Ultra-HD' }, { dual: null, dub: null });
    assert.deepEqual([st.ready, st.problems, st.dual, st.dub, st.top, st.cutoffFormatScore, st.minFormatScore], [false, ['custom formats not created yet'], null, null, 0, 0, 0]);
    const p = rules.profileWithScores({ id: 7, name: 'Ultra-HD' }, ids, 2000);
    assert.equal(p.formatItems.length, 2);
  });
});
