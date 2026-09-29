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
    assert.deepEqual(rules.langs('tha/hin/fil/Mandarin Chinese'), ['th', 'hi', 'tl', 'zh']);
    assert.deepEqual(rules.langs('mri'), ['mri'], 'unknown codes pass through');
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
    assert.deepEqual(c, { id: 1, season: 2, path: 'Show/Season 1/Show - S01E01.mkv', release: 'Rel', quality: 'Bluray-1080p', score: 1500, size: 5, audio: ['ja'], subs: ['en'], status: 'subbed', verified: false, notes: [] });
    const bare = rules.classifyFile({ id: 2, seasonNumber: 1 });
    assert.deepEqual([bare.path, bare.release, bare.quality, bare.score, bare.size], ['', null, null, null, 0]);
  });
});

describe('checked files', () => {
  const file = { id: 1, seasonNumber: 1, size: 100, relativePath: 'x.mkv', mediaInfo: { audioLanguages: 'jpn/eng', subtitles: 'eng' } };
  const check = (audio, subs = [{ track: 1, tag: 'en', lang: 'en', kind: 'full' }]) => ({ size: 100, audio, subs });

  test('what the file really has replaces the tags', () => {
    const c = rules.classifyFile(file, {}, check([{ track: 1, tag: 'ja', lang: 'en', p: 0.95 }, { track: 2, tag: 'en', lang: 'en', p: 0.9 }]));
    assert.deepEqual([c.status, c.audio, c.verified], ['noJapanese', ['en'], true]);
    assert.deepEqual(c.notes, ['Audio 1 is tagged Japanese but sounds English']);
    const ok = rules.classifyFile(file, {}, check([{ track: 1, tag: 'ja', lang: 'ja', p: 0.97 }, { track: 2, tag: 'en', lang: 'en', p: 0.95 }]));
    assert.deepEqual([ok.status, ok.notes, ok.verified], ['dual', [], true]);
  });

  test('an unsure guess keeps the tag; an untagged track takes the guess', () => {
    const c = rules.classifyFile(file, {}, check([{ track: 1, tag: 'ja', lang: 'en', p: 0.3 }, { track: 2, tag: null, lang: 'en', p: 0.9 }, { track: 3, tag: 'und', lang: null, p: 0 }]));
    assert.deepEqual([c.status, c.audio], ['dual', ['ja', 'en', 'und']]);
    assert.deepEqual(c.notes, ['Audio 2 has no language tag; it sounds English']);
    // Untagged tracks Sonarr calls unknown become known.
    const bare = { ...file, mediaInfo: { audioLanguages: '', subtitles: 'eng' } };
    assert.equal(rules.classifyFile(bare, {}).status, 'unknown');
    assert.equal(rules.classifyFile(bare, {}, check([{ track: 1, tag: null, lang: 'ja', p: 0.9 }])).status, 'subbed');
    assert.equal(rules.classifyFile({ ...file, mediaInfo: null }, {}, check([{ track: 1, tag: null, lang: 'ja', p: 0.9 }])).status, 'subbed', 'even without media info');
  });

  test('signs & songs tracks are not subtitles; mislabelled ones are noted', () => {
    const ja = [{ track: 1, tag: 'ja', lang: 'ja', p: 0.97 }];
    const signs = rules.classifyFile(file, {}, check(ja, [{ track: 1, tag: 'en', lang: null, kind: 'signs' }]));
    assert.deepEqual([signs.status, signs.subs, signs.notes], ['noSubs', [], ['Subtitles 1 (English) are signs & songs only']]);
    const wrong = rules.classifyFile(file, { subtitleLanguage: 'en' }, check(ja, [{ track: 1, tag: 'en', lang: 'es', kind: 'full' }]));
    assert.deepEqual([wrong.status, wrong.notes], ['noSubs', ['Subtitles 1 are tagged English but read as Spanish']]);
    const untagged = rules.classifyFile(file, {}, check(ja, [{ track: 1, tag: null, lang: null, kind: 'full' }]));
    assert.deepEqual([untagged.status, untagged.subs], ['subbed', ['und']]);
  });

  test('subtitles that weren’t read (not required at the time) keep their tags', () => {
    const c = rules.classifyFile(file, { requireSubtitles: true }, { size: 100, audio: [{ track: 1, tag: 'ja', lang: 'ja', p: 0.9 }], subs: [], subsChecked: false });
    assert.deepEqual([c.status, c.subs, c.verified], ['subbed', ['en'], true]);
  });

  test('a check of a different file (size changed), or one that failed, is ignored', () => {
    const c = check([{ track: 1, tag: 'ja', lang: 'en', p: 0.95 }]);
    const changed = rules.classifyFile(file, {}, { ...c, size: 99 });
    assert.deepEqual([changed.status, changed.verified, changed.notes], ['dual', false, []]);
    const failed = rules.classifyFile(file, {}, { size: 100, error: 'boom' });
    assert.deepEqual([failed.status, failed.verified, failed.notes], ['dual', false, ['Couldn’t check the file: boom']]);
    assert.deepEqual(rules.classifyFile(file, {}, { size: 1, error: 'old' }).notes, []);
  });

  test('summaries and totals count checked files', () => {
    const row = rules.summariseSeries({ id: 1, title: 'x' }, [file, { ...file, id: 2 }], {}, new Map([[1, check([{ track: 1, tag: 'ja', lang: 'ja', p: 1 }])]]));
    assert.equal(row.verified, 1);
    assert.equal(rules.totals([row, { ...row, verified: undefined }]).verified, 1);
  });
});

describe('reading files', () => {
  test('clips come from the middle of the episode', () => {
    assert.deepEqual(rules.clipStarts(1440), [432, 720, 1007]);
    assert.deepEqual(rules.clipStarts(60), [0]);
    assert.deepEqual(rules.clipStarts(0), [0]);
    assert.deepEqual(rules.clipStarts(NaN), [0]);
  });

  test('audioLanguage: most probability wins, averaged over every clip', () => {
    assert.deepEqual(rules.audioLanguage([{ lang: 'en', p: 0.95 }, { lang: 'ja', p: 0.6 }, { lang: 'en', p: 0.93 }]), { lang: 'en', p: 0.63 });
    assert.deepEqual(rules.audioLanguage([{ lang: 'ja', p: 0.97 }, null, { lang: 'ja', p: 0.99 }]), { lang: 'ja', p: 0.65 });
    assert.deepEqual(rules.audioLanguage([null]), { lang: null, p: 0 });
    assert.deepEqual(rules.audioLanguage([]), { lang: null, p: 0 });
  });

  test('parseSrt strips styling and skips junk', () => {
    const cues = rules.parseSrt('1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}<i>Hello</i>\\Nthere\r\n\r\n2\n01:02:03.250 --> 01:02:05,000\nSecond\nline\n\nnot a cue\n\n3\n00:00:09,000 --> 00:00:10,000\n{\\p1}\n');
    assert.deepEqual(cues, [{ start: 1.5, text: 'Hello there' }, { start: 3723.25, text: 'Second line' }]);
    assert.deepEqual(rules.parseSrt(''), []);
    assert.deepEqual(rules.parseSrt(null), []);
  });

  test('dialogueRate counts distinct lines in the middle of the episode', () => {
    const cues = [
      { start: 10, text: 'Opening song' }, // before 15%
      ...Array.from({ length: 60 }, (_, i) => ({ start: 200 + i * 10, text: `Line ${i % 50}` })),
      { start: 1300, text: 'Ending song' }, // after 85%
    ];
    assert.deepEqual(rules.dialogueRate(cues, 1400), { lines: 50, perMin: 3.1 });
    assert.deepEqual(rules.dialogueRate(cues, 0), { lines: 52, perMin: null });
  });

  test('subtitleKind: titles, forced flags, then how much it talks', () => {
    assert.equal(rules.subtitleKind({ title: 'Signs & Songs' }, 12), 'signs');
    assert.equal(rules.subtitleKind({ title: 'English [S&S]' }, 12), 'signs');
    assert.equal(rules.subtitleKind({ title: 'Forced' }, null), 'signs');
    assert.equal(rules.subtitleKind({ forced: true }, 12), 'signs');
    assert.equal(rules.subtitleKind({ title: 'Full Subtitles (Dialogue + Signs)' }, 1), 'full');
    assert.equal(rules.subtitleKind({ title: 'English' }, 1.5), 'signs');
    assert.equal(rules.subtitleKind({ title: 'English' }, 12), 'full');
    assert.equal(rules.subtitleKind({}, null), 'full', 'unknown rate: trust it');
    assert.equal(rules.subtitleKind(undefined), 'full');
  });

  test('textLanguage', () => {
    const say = (s) => `${s} `.repeat(3);
    assert.equal(rules.textLanguage(say('I don’t know what you are talking about. We have to go now, it is not safe here. What do you want from me? This is the way, and you have to be ready for it.')), 'en');
    assert.equal(rules.textLanguage(say('No sé de qué estás hablando. Tenemos que irnos ahora, no es seguro aquí. ¿Qué quieres de mí? Este es el camino y tienes que estar listo para eso.')), 'es');
    assert.equal(rules.textLanguage(say('Eu não sei do que você está falando. Temos que ir agora, não é seguro aqui. O que você quer de mim? Este é o caminho e você tem que estar pronto para isso.')), 'pt');
    assert.equal(rules.textLanguage(say('Je ne sais pas de quoi tu parles. Nous devons partir maintenant, ce n’est pas sûr ici. Qu’est-ce que vous voulez de moi? C’est la voie et tu dois être prêt.')), 'fr');
    assert.equal(rules.textLanguage(say('Ich weiß nicht, wovon du redest. Wir müssen jetzt gehen, es ist hier nicht sicher. Was willst du von mir? Das ist der Weg und du musst bereit sein.')), 'de');
    assert.equal(rules.textLanguage(say('Non so di cosa stai parlando. Dobbiamo andare adesso, non è sicuro qui. Cosa vuoi da me? Questo è il modo e tu devi essere pronto per questo.')), 'it');
    assert.equal(rules.textLanguage(say('何を言っているのか分からない。今すぐ行かなきゃ、ここは危ない。私に何をしてほしいの？')), 'ja');
    assert.equal(rules.textLanguage(say('무슨 말을 하는지 모르겠어요. 지금 가야 해요, 여기는 안전하지 않아요.')), 'ko');
    assert.equal(rules.textLanguage(say('我不知道你在说什么。我们现在必须走了，这里不安全。你想从我这里得到什么？')), 'zh');
    assert.equal(rules.textLanguage(say('Я не знаю, о чем ты говоришь. Нам нужно идти сейчас, здесь небезопасно.')), 'ru');
    assert.equal(rules.textLanguage(say('لا أعرف ما الذي تتحدث عنه. علينا أن نذهب الآن، المكان هنا ليس آمنا.')), 'ar');
    assert.equal(rules.textLanguage('Too short to tell'), null);
    assert.equal(rules.textLanguage(say('Kamehameha Rasengan Chidori Bankai Zanpakuto Shinigami Hollow Quincy Arrancar')), null, 'no common words');
    assert.equal(rules.textLanguage(null), null);
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
      verified: 0,
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
      upgraded: [{ id: 1, title: 'Frieren', files: 2, mode: 'dual' }, { id: 2, title: 'Dandadan', files: 1, mode: 'dual' }],
      problems: [{ id: 3, title: 'Mushishi', noJapanese: 1, noSubs: 0 }],
    });
    // A new episode arriving as dual audio isn't an upgrade.
    assert.deepEqual(rules.diffScans(new Map([[1, { id: 1, counts: c(1, 1) }]]), [{ id: 1, title: 'x', counts: c(2, 1) }]).upgraded, []);
  });
});

describe('per-profile rules: mode and original language', () => {
  const counts = (c) => ({ dual: 0, subbed: 0, noSubs: 0, noJapanese: 0, unknown: 0, ...c });
  const row = (c, mode) => ({ total: Object.values(counts(c)).reduce((a, b) => a + b, 0), counts: counts(c), mode });

  test('profileRule: dual audio with Japanese unless set; junk falls back', () => {
    const r = { 4: { mode: 'original', lang: 'zh' }, 5: { lang: 'auto' }, 6: { mode: 'bogus', lang: 'und' } };
    assert.deepEqual(rules.profileRule(1, r), { mode: 'dual', lang: 'ja' });
    assert.deepEqual(rules.profileRule(4, r), { mode: 'original', lang: 'zh' });
    assert.deepEqual(rules.profileRule(5, r), { mode: 'dual', lang: 'auto' });
    assert.deepEqual(rules.profileRule(6, r), { mode: 'dual', lang: 'ja' });
    assert.deepEqual(rules.profileRule(1, undefined), { mode: 'dual', lang: 'ja' });
  });

  test("'auto' takes the series' original language from Sonarr, else Japanese", () => {
    assert.equal(rules.seriesLanguage('auto', 'Chinese'), 'zh');
    assert.equal(rules.seriesLanguage('auto', 'Korean'), 'ko');
    assert.equal(rules.seriesLanguage('auto', 'Unknown'), 'ja');
    assert.equal(rules.seriesLanguage('auto', null), 'ja');
    assert.equal(rules.seriesLanguage('zh', 'Japanese'), 'zh', 'a fixed language wins');
  });

  test('verdicts follow the original language: a Chinese show needs Chinese audio', () => {
    const zh = { lang: 'zh' };
    assert.equal(verdict(f('chi', 'eng'), zh), 'subbed');
    assert.equal(verdict(f('chi/eng', 'eng'), zh), 'dual');
    assert.equal(verdict(f('jpn', 'eng'), zh), 'noJapanese', 'a Japanese dub of a donghua has no original audio');
    assert.equal(verdict(f('jpn', 'eng')), 'subbed', 'Japanese stays the default');
    assert.equal(verdict(f('eng/spa', 'eng'), { lang: 'en' }), 'dual', 'an English original: any second language is the dub');
    assert.equal(verdict(f('eng', 'eng'), { lang: 'en' }), 'subbed');
  });

  test('summaries carry the rule and the series’ original language', () => {
    const s = { id: 1, title: 'Link Click', seriesType: 'anime', originalLanguage: { name: 'Chinese' } };
    const r = rules.summariseSeries(s, [f('chi', 'eng')], { mode: 'original', lang: 'zh' });
    assert.deepEqual([r.mode, r.lang, r.originalLanguage, r.counts.subbed], ['original', 'zh', 'Chinese', 1]);
    assert.equal(rules.summariseSeries(s, [], { mode: 'bogus' }).mode, 'dual');
  });

  test('original only: subbed is done; dual audio is a problem to search for and replace', () => {
    assert.equal(rules.seriesState(row({ subbed: 3 }, 'original')), 'done');
    assert.equal(rules.seriesState(row({ subbed: 3 }, 'dual')), 'waiting');
    assert.equal(rules.seriesState(row({ subbed: 2, dual: 1 }, 'original')), 'problem');
    assert.equal(rules.needsSearch(row({ subbed: 3 }, 'original')), false);
    assert.equal(rules.needsSearch(row({ dual: 1 }, 'original')), true);
    assert.equal(rules.needsSearch(row({ dual: 1 })), false, 'rows scanned before modes existed want dual audio');
    assert.deepEqual(rules.MODES.original.replaceable, ['dual', 'noSubs', 'noJapanese']);
    const files = [{ id: 1, season: 1, status: 'dual' }, { id: 2, season: 1, status: 'subbed' }];
    const eps = [{ id: 11, seasonNumber: 1, episodeFileId: 1 }, { id: 12, seasonNumber: 1, episodeFileId: 2 }];
    assert.deepEqual(rules.searchPlan(files, eps, rules.MODES.original.needsSearch), { seasons: [], episodeIds: [11] });
  });

  test('diffScans: the goal replacing dual audio is an upgrade; new dual audio is a problem', () => {
    const prev = new Map([[1, { id: 1, counts: counts({ dual: 2 }) }], [2, { id: 2, counts: counts({ subbed: 2 }) }]]);
    const rows = [
      { id: 1, title: 'Link Click', mode: 'original', lang: 'zh', counts: counts({ subbed: 2 }) },
      { id: 2, title: 'Mushishi', mode: 'original', lang: 'ja', counts: counts({ subbed: 1, dual: 1 }) },
    ];
    assert.deepEqual(rules.diffScans(prev, rows), {
      upgraded: [{ id: 1, title: 'Link Click', files: 2, mode: 'original', lang: 'zh' }],
      problems: [{ id: 2, title: 'Mushishi', noJapanese: 0, noSubs: 0, dualAudio: 1 }],
    });
  });

  test('original-only profiles block dual audio in Sonarr, and "upgrade until" comes back down', () => {
    const ids = { dual: 10, dub: 11 };
    const dualProfile = rules.profileWithScores(
      { id: 1, name: 'Anime', upgradeAllowed: false, cutoffFormatScore: 0, minFormatScore: 0, formatItems: [{ format: 1, score: 500 }] },
      ids,
      2000,
    );
    const p = rules.profileWithScores(dualProfile, ids, 2000, 'original');
    assert.deepEqual(p.formatItems.map((fi) => fi.score), [500, rules.DUB_SCORE, rules.DUB_SCORE]);
    assert.deepEqual([p.cutoffFormatScore, p.minFormatScore, p.upgradeAllowed], [500, 0, true], 'upgrades are left as they were');
    assert.deepEqual([rules.profileState(p, ids, 'original').ready, rules.profileState(p, ids, 'original').mode], [true, 'original']);
    assert.equal(rules.profileState(p, ids).ready, false, 'not ready for dual audio any more');
    assert.deepEqual(rules.profileState(dualProfile, ids, 'original').problems, [
      'dual audio releases can still be grabbed',
      '“upgrade until” score (2000) can only be reached by dual audio',
    ]);
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
