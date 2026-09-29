// The rules, with no I/O so they are easy to test:
//  - reading audio/subtitle languages from Sonarr's media info and giving each file a verdict,
//  - the custom formats + profile scores that make Sonarr swap subbed releases for dual audio,
//  - which searches to send, and which grab to blocklist when a file is replaced.

// ---------- languages ----------

const ALIASES = {
  ja: ['ja', 'jp', 'jpn', 'jap', 'japanese'],
  en: ['en', 'eng', 'english'],
  es: ['es', 'spa', 'spanish', 'español', 'espanol'],
  pt: ['pt', 'por', 'portuguese', 'português', 'portugues'],
  fr: ['fr', 'fre', 'fra', 'french', 'français', 'francais'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  it: ['it', 'ita', 'italian', 'italiano'],
  ar: ['ar', 'ara', 'arabic'],
  ru: ['ru', 'rus', 'russian'],
  zh: ['zh', 'chi', 'zho', 'chinese', 'cmn', 'yue', 'mandarin', 'cantonese'],
  ko: ['ko', 'kor', 'korean'],
  hi: ['hi', 'hin', 'hindi'],
  th: ['th', 'tha', 'thai'],
  vi: ['vi', 'vie', 'vietnamese'],
  id: ['id', 'ind', 'indonesian'],
  tl: ['tl', 'tgl', 'fil', 'tagalog', 'filipino'],
  tr: ['tr', 'tur', 'turkish'],
  pl: ['pl', 'pol', 'polish'],
  nl: ['nl', 'dut', 'nld', 'dutch'],
  sv: ['sv', 'swe', 'swedish'],
  no: ['no', 'nor', 'nob', 'norwegian'],
  da: ['da', 'dan', 'danish'],
  fi: ['fi', 'fin', 'finnish'],
  he: ['he', 'heb', 'hebrew'],
  und: ['und', 'unknown', 'undetermined', 'mul', 'zxx'],
};
const CODE = new Map(Object.entries(ALIASES).flatMap(([code, names]) => names.map((n) => [n, code])));

/** Subtitle languages a user can require (besides "any"). */
export const SUBTITLE_LANGUAGES = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ar: 'Arabic', ru: 'Russian' };

/**
 * Sonarr v4 reports media info languages as "jpn/eng" (from ffprobe); v3 as "Japanese / English".
 * Returns distinct normalised codes: ['ja', 'en'].
 */
export function langs(value) {
  const out = [];
  for (const raw of String(value || '').split(/[/,|]+/)) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const code = CODE.get(k) || CODE.get(k.split(/[-_ (]/)[0]) || k;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

// ---------- verdicts ----------

/** What a file can be, best first. */
export const STATUSES = ['dual', 'subbed', 'noSubs', 'noJapanese', 'unknown'];

/**
 * What a series aims for, set per Sonarr quality profile (with its original language, Japanese
 * unless set otherwise):
 *  dual      original + English audio: subbed files wait for the dub, then upgrade
 *  original  the original language only: subbed is the goal, and dual audio is replaced like a dub
 *   good         the verdict that is the goal
 *   needsSearch  files that should be searched for a better release
 *   replaceable  files that break the rules outright: safe to delete and grab again
 */
export const MODES = {
  dual: { good: 'dual', needsSearch: ['subbed', 'noSubs', 'noJapanese'], replaceable: ['noSubs', 'noJapanese'] },
  original: { good: 'subbed', needsSearch: ['dual', 'noSubs', 'noJapanese'], replaceable: ['dual', 'noSubs', 'noJapanese'] },
};
export const NEEDS_SEARCH = MODES.dual.needsSearch;

/** The automatic replacement settings: off, wrong audio language, or that and no subtitles. */
export const AUTO_REPLACE = ['off', 'language', 'all'];

/**
 * The verdicts automatic replacement takes in a series of the given mode. Wrong language means no
 * original-language audio, and dual audio in an original-only series.
 */
export function autoReplaceable(mode, setting) {
  if (!AUTO_REPLACE.includes(setting) || setting === 'off') return [];
  const language = mode === 'original' ? ['noJapanese', 'dual'] : ['noJapanese'];
  return setting === 'all' ? [...language, 'noSubs'] : language;
}
export const REPLACEABLE = MODES.dual.replaceable;

/**
 * A quality profile's rule (`profileRules`: { [profileId]: { mode, lang } }): dual audio with
 * Japanese unless set. `lang` 'auto' takes each series' original language from Sonarr.
 */
export function profileRule(profileId, profileRules) {
  const r = profileRules?.[profileId] || {};
  return { mode: MODES[r.mode] ? r.mode : 'dual', lang: r.lang === 'auto' || (r.lang && r.lang !== 'und' && LANG_NAMES[r.lang]) ? r.lang : 'ja' };
}

/** The language a series should be in: the rule's, or with 'auto' its original language in Sonarr. */
export function seriesLanguage(lang, originalLanguage) {
  if (lang !== 'auto') return lang || 'ja';
  const code = langs(originalLanguage)[0];
  return code && code !== 'und' && LANG_NAMES[code] ? code : 'ja';
}
const goal = (row) => MODES[row.mode] || MODES.dual;

const HARDSUB = /\bhard[ ._-]?sub(bed|s)?\b/i;

/** Names for the notes a file check writes. */
export const LANG_NAMES = {
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  it: 'Italian', ar: 'Arabic', ru: 'Russian', hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tl: 'Tagalog',
  tr: 'Turkish', pl: 'Polish', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', he: 'Hebrew',
  und: 'undetermined',
};
export const langName = (code) => LANG_NAMES[code] || code;

/** Below this (averaged over the clips), a detected audio language is a guess and the tag wins. */
export const AUDIO_MIN_P = 0.5;

/**
 * The languages a file really has, once it has been checked: detected audio languages replace
 * the tags when whisper is sure enough, and signs & songs tracks don't count as subtitles.
 * Returns the effective languages and a note for everything that disagrees with the tags.
 */
export function checkedLanguages(check) {
  const notes = [];
  const audio = [];
  for (const a of check.audio || []) {
    const sure = a.lang && a.p >= AUDIO_MIN_P;
    if (sure && a.tag && a.tag !== 'und' && a.tag !== a.lang) notes.push(`Audio ${a.track} is tagged ${langName(a.tag)} but sounds ${langName(a.lang)}`);
    else if (sure && (!a.tag || a.tag === 'und')) notes.push(`Audio ${a.track} has no language tag; it sounds ${langName(a.lang)}`);
    audio.push(sure ? a.lang : a.tag || 'und');
  }
  // Subtitles aren't read when they aren't required: then the tags stand.
  if (check.subsChecked === false) return { audio: [...new Set(audio)], subs: null, notes };
  const subs = [];
  for (const t of check.subs || []) {
    const name = langName(t.lang || t.tag || 'und');
    if (t.kind === 'signs') {
      notes.push(`Subtitles ${t.track} (${name}) are signs & songs only`);
      continue;
    }
    if (t.lang && t.tag && t.tag !== 'und' && t.tag !== t.lang) notes.push(`Subtitles ${t.track} are tagged ${langName(t.tag)} but read as ${langName(t.lang)}`);
    subs.push(t.lang || t.tag || 'und');
  }
  return { audio: [...new Set(audio)], subs: [...new Set(subs)], notes };
}

/**
 * One Sonarr episode file -> its languages and verdict. "Original" is `lang`, Japanese unless the
 * profile says otherwise (the status keys keep their Japanese names, as stored since 0.1):
 *  dual       original + English audio, with subtitles
 *  subbed     original audio with subtitles, no English audio (waiting for the dub, or the goal)
 *  noSubs     original audio but no (matching) subtitles
 *  noJapanese no original-language audio track (e.g. an English-only dub)
 *  unknown    Sonarr has no media info, or the audio tracks aren't tagged with a language
 * With a `check` (the file itself was listened to and its subtitles read, see verify.js) of the
 * same file, its findings replace Sonarr's tags.
 */
export function classifyFile(f, { requireSubtitles = true, subtitleLanguage = 'any', lang = 'ja' } = {}, check = null) {
  const mi = f.mediaInfo;
  // A check of an older file with the same id (replaced in place) doesn't count.
  const checked = check && !check.error && check.size === (f.size || 0) ? check : null;
  const found = checked && checkedLanguages(checked);
  const audio = found ? found.audio : langs(mi?.audioLanguages);
  let subs = found?.subs ?? langs(mi?.subtitles);
  // Burned-in subtitles have no track; trust the release name when it says so.
  const hardsub = !subs.length && HARDSUB.test(`${f.sceneName || ''} ${f.relativePath || ''}`);
  if (hardsub) subs = ['hardsub'];
  const known = audio.filter((l) => l !== 'und');
  const subsOk = hardsub || (subtitleLanguage === 'any' ? subs.length > 0 : subs.includes(subtitleLanguage));

  let status;
  if ((!mi && !checked) || !known.length) status = 'unknown';
  else if (!known.includes(lang)) status = 'noJapanese';
  else if (requireSubtitles && !subsOk) status = 'noSubs';
  // For an English original, any second language counts as the "dub".
  else if (lang === 'en' ? known.some((l) => l !== 'en') : known.includes('en')) status = 'dual';
  else status = 'subbed';

  return {
    id: f.id,
    season: f.seasonNumber,
    path: f.relativePath || '',
    release: f.sceneName || null,
    quality: f.quality?.quality?.name || null,
    score: f.customFormatScore ?? null,
    size: f.size || 0,
    audio,
    subs,
    status,
    verified: !!checked,
    notes: found ? found.notes : check?.error && check.size === (f.size || 0) ? [`Couldn’t check the file: ${check.error}`] : [],
  };
}

/** Whether a Sonarr series is checked at all. */
export const inScope = (s, scope) =>
  s.seriesType === 'anime' || (scope === 'japanese' && /^japanese$/i.test(s.originalLanguage?.name || ''));

const emptyCounts = () => Object.fromEntries(STATUSES.map((k) => [k, 0]));

/** A series and its classified files, as stored and shown. `opts.mode`/`opts.lang`: its profile's rule. */
export function summariseSeries(s, files, opts, checks = new Map()) {
  const classified = files.map((f) => classifyFile(f, opts, checks.get(f.id))).sort((a, b) => a.season - b.season || a.path.localeCompare(b.path));
  const counts = emptyCounts();
  for (const f of classified) counts[f.status]++;
  return {
    id: s.id,
    title: s.title,
    year: s.year || null,
    titleSlug: s.titleSlug || null,
    poster: s.images?.find((i) => i.coverType === 'poster')?.remoteUrl || null,
    monitored: s.monitored !== false,
    seriesType: s.seriesType,
    qualityProfileId: s.qualityProfileId,
    mode: MODES[opts?.mode] ? opts.mode : 'dual',
    lang: opts?.lang || 'ja',
    originalLanguage: s.originalLanguage?.name || null,
    counts,
    total: classified.length,
    verified: classified.filter((f) => f.verified).length,
    files: classified,
  };
}

/**
 * done / waiting (subbed, dub not out yet) / problem (rule broken) / unknown / empty. Original-only
 * series never wait: a subbed file is done, and a dual audio one is a problem.
 */
export function seriesState(row) {
  const c = row.counts;
  if (!row.total) return 'empty';
  if (c.noJapanese || c.noSubs || (row.mode === 'original' && c.dual)) return 'problem';
  if (c.subbed && row.mode !== 'original') return 'waiting';
  if (c.unknown === row.total) return 'unknown';
  return 'done';
}

export const needsSearch = (row) => goal(row).needsSearch.some((k) => row.counts[k] > 0);

export function totals(rows) {
  const files = emptyCounts();
  const series = { done: 0, waiting: 0, problem: 0, unknown: 0, empty: 0 };
  let verified = 0;
  for (const r of rows) {
    for (const k of STATUSES) files[k] += r.counts[k];
    series[seriesState(r)]++;
    verified += r.verified || 0;
  }
  return { series: rows.length, files, states: series, verified };
}

/**
 * What changed since the last scan, per series. Upgraded files get new file ids, so this
 * compares counts: fewer files needing work + more of the goal (dual audio, or subbed for an
 * original-only series) = upgraded. Series seen for the first time are skipped, so the first
 * scan doesn't announce the whole library.
 */
export function diffScans(prevById, rows) {
  const upgraded = [];
  const problems = [];
  for (const r of rows) {
    const p = prevById.get(r.id);
    if (!p) continue;
    const g = goal(r);
    const need = (c) => g.needsSearch.reduce((n, k) => n + c[k], 0);
    const gained = Math.min(r.counts[g.good] - p.counts[g.good], need(p.counts) - need(r.counts));
    // The language is only named when it isn't Japanese, the default.
    const lang = r.lang && r.lang !== 'ja' ? { lang: r.lang } : {};
    if (gained > 0) upgraded.push({ id: r.id, title: r.title, files: gained, mode: r.mode || 'dual', ...lang });
    const more = (k) => Math.max(0, r.counts[k] - p.counts[k]);
    const found = { noJapanese: more('noJapanese'), noSubs: more('noSubs'), ...(r.mode === 'original' ? { dualAudio: more('dual') } : {}) };
    if (Object.values(found).some(Boolean)) problems.push({ id: r.id, title: r.title, ...found, ...lang });
  }
  return { upgraded, problems };
}

// ---------- checking files (the parts of verify.js that need no I/O) ----------

export const CLIP_SECONDS = 30;

/**
 * Where to take the audio clips from. The middle of the episode, because dubs keep the Japanese
 * opening and ending songs.
 */
export function clipStarts(duration) {
  if (!(duration > CLIP_SECONDS * 3)) return [0];
  return [0.3, 0.5, 0.7].map((f) => Math.floor(duration * f));
}

/**
 * One track's language from whisper's guesses for its clips ({ lang, p } or null each): the
 * language with the most probability overall, and its average probability across all clips, so a
 * clip of music guessed wrong only lowers the confidence.
 */
export function audioLanguage(results) {
  const sum = new Map();
  for (const r of results) if (r?.lang) sum.set(r.lang, (sum.get(r.lang) || 0) + r.p);
  const [lang, total] = [...sum].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return { lang, p: results.length ? Math.round((total / results.length) * 100) / 100 : 0 };
}

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** SRT text -> [{ start (seconds), text }], with styling tags removed. */
export function parseSrt(text) {
  const cues = [];
  for (const block of String(text || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    const m = i >= 0 && lines[i].match(TIME);
    if (!m) continue;
    const body = lines
      .slice(i + 1)
      .join(' ')
      .replace(/\{[^}]*\}/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\\[Nnh]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) cues.push({ start: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000, text: body });
  }
  return cues;
}

/**
 * How much a subtitle track talks: distinct lines per minute in the middle 70% of the episode
 * (so the opening and ending song lyrics don't count). Dialogue runs at 8-20 lines a minute;
 * a signs & songs track has a handful.
 */
export function dialogueRate(cues, duration) {
  if (!(duration > 0)) return { lines: new Set(cues.map((c) => c.text.toLowerCase())).size, perMin: null };
  const from = duration * 0.15;
  const to = duration * 0.85;
  const lines = new Set(cues.filter((c) => c.start >= from && c.start <= to).map((c) => c.text.toLowerCase())).size;
  return { lines, perMin: Math.round((lines / ((to - from) / 60)) * 10) / 10 };
}

export const SIGNS_PER_MIN = 3;
const SIGNS_TITLE = /\b(signs?|songs?|forced|s\s*&\s*s)\b/i;

/** 'signs' for a signs & songs (or forced) track, else 'full'. */
export function subtitleKind({ title = '', forced = false } = {}, perMin = null) {
  if (/\b(full|dialogue)\b/i.test(title)) return 'full';
  if (forced || SIGNS_TITLE.test(title)) return 'signs';
  return perMin !== null && perMin < SIGNS_PER_MIN ? 'signs' : 'full';
}

// Common words that tell the Latin-script subtitle languages apart. Words several languages
// share count for less.
const STOPWORDS = {
  en: 'the you i to a and is it that what of in this be not we have me are my do for your on with no was just he',
  es: 'que de no la el es y en lo un por me una te los se con para mi las qué está pero su eso',
  pt: 'que não de o a é e um eu você do da em se me uma isso com para os mas está meu vai',
  fr: 'je de est pas le la tu que vous et à un il les ne une en ce ça des qui mais on',
  de: 'ich die und nicht du das ist der es sie zu ein was wir mir ja er den mich auf dich',
  it: 'che non di è il la un e mi per ti sono io in una lo ma cosa se con ho questo',
};
const WORD_LANGS = new Map();
for (const [lang, words] of Object.entries(STOPWORDS)) {
  for (const w of words.split(' ')) WORD_LANGS.set(w, [...(WORD_LANGS.get(w) || []), lang]);
}

/** The language of a subtitle track's text, or null when unsure. */
export function textLanguage(text) {
  const t = String(text || '');
  const count = (re) => (t.match(re) || []).length;
  const letters = count(/\p{L}/gu);
  if (letters < 50) return null;
  if (count(/[\u3040-\u30ff]/g) > letters * 0.1) return 'ja';
  const scripts = [['ko', /[\uac00-\ud7af]/g], ['zh', /[\u4e00-\u9fff]/g], ['ru', /[\u0400-\u04ff]/g], ['ar', /[\u0600-\u06ff]/g]];
  for (const [lang, re] of scripts) if (count(re) > letters * 0.3) return lang;
  const score = {};
  let hits = 0;
  for (const w of t.toLowerCase().match(/\p{L}+/gu) || []) {
    const ls = WORD_LANGS.get(w);
    if (!ls) continue;
    hits++;
    for (const l of ls) score[l] = (score[l] || 0) + 1 / ls.length;
  }
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (hits < 20 || !best || (second && best[1] < second[1] * 1.5)) return null;
  return best[0];
}

// ---------- searching & replacing ----------

/**
 * Turns the files that need work into Sonarr searches: a whole season that needs it gets one
 * season search (which finds batch releases, where dual audio usually turns up); otherwise the
 * individual (monitored) episodes are searched.
 */
export function searchPlan(files, episodes, statuses = NEEDS_SEARCH) {
  const want = new Set(files.filter((f) => statuses.includes(f.status)).map((f) => f.id));
  const seasons = [];
  const episodeIds = [];
  const bySeason = Map.groupBy(files, (f) => f.season);
  for (const [season, sf] of [...bySeason].sort((a, b) => a[0] - b[0])) {
    const needed = sf.filter((f) => want.has(f.id));
    if (!needed.length) continue;
    if (needed.length === sf.length && sf.length > 1) {
      seasons.push(season);
      continue;
    }
    for (const e of episodes) {
      if (e.seasonNumber === season && e.monitored !== false && want.has(e.episodeFileId)) episodeIds.push(e.id);
    }
  }
  return { seasons, episodeIds };
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * The Sonarr "grabbed" history record that produced a file, so replacing it can blocklist that
 * exact release. Matched through the import record's path (or the release name); null if unsure.
 */
export function grabFor(history, file) {
  const recs = [...history].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const rel = normPath(file.relativePath);
  const imported = rel && recs.find((h) => h.eventType === 'downloadFolderImported' && h.downloadId && normPath(h.data?.importedPath).endsWith(rel));
  if (imported) {
    const grab = recs.find((h) => h.eventType === 'grabbed' && h.downloadId === imported.downloadId);
    if (grab) return grab;
  }
  if (file.sceneName) return recs.find((h) => h.eventType === 'grabbed' && h.sourceTitle === file.sceneName) || null;
  return null;
}

// ---------- Sonarr custom formats & quality profiles ----------

export const CF_NAMES = { dual: 'Dual Audio (Dualarr)', dub: 'Dub Only (Dualarr)' };
export const DUB_SCORE = -10000;

// Release names Sonarr matches these against (case-insensitive .NET regex).
export const DUAL_RE = String.raw`\b(dual[ ._-]?(audio|lang(uage)?s?)|multi[ ._-]?audio|(jpn?|jap|ja)[ ._+&-]?eng?|eng?[ ._+&-]?(jpn?|jap|ja))\b`;
export const DUB_RE = String.raw`\b(dub(bed|s)?|eng(lish)?[ ._-]?dub(bed)?)\b`;

const titleSpec = (name, value, { negate = false, required = false } = {}) => ({
  name,
  implementation: 'ReleaseTitleSpecification',
  negate,
  required,
  fields: [{ name: 'value', value }],
});

/** The two custom formats Dualarr keeps in Sonarr. */
export function customFormats() {
  return {
    dual: {
      name: CF_NAMES.dual,
      includeCustomFormatWhenRenaming: false,
      specifications: [titleSpec('Dual audio in the release name', DUAL_RE)],
    },
    dub: {
      name: CF_NAMES.dub,
      includeCustomFormatWhenRenaming: false,
      specifications: [
        titleSpec('Dubbed', DUB_RE, { required: true }),
        titleSpec('Not dual audio', DUAL_RE, { negate: true, required: true }),
      ],
    },
  };
}

/** Highest score any *other* custom format in the profile can add. */
const topOtherScore = (p, ours) => Math.max(0, ...(p.formatItems || []).filter((fi) => !ours.has(fi.format)).map((fi) => fi.score || 0));

/**
 * A quality profile with Dualarr's scores applied. For a dual audio profile:
 *  - dual audio scores `dualScore`, dub-only DUB_SCORE,
 *  - upgrades are on, and continue until a file scores at least the dual audio score (so a
 *    subbed file keeps being upgraded until dual audio arrives),
 *  - the minimum score is high enough that a dub-only release is never grabbed.
 * For an original-only profile, dual audio scores DUB_SCORE too (never grabbed), and "upgrade
 * until" comes back down to what other formats can reach, so Sonarr doesn't keep searching for a
 * dual audio upgrade it may no longer take. Upgrades are left as they are.
 */
export function profileWithScores(p, ids, dualScore, mode = 'dual') {
  const original = mode === 'original';
  const ours = new Map([[ids.dual, original ? DUB_SCORE : dualScore], [ids.dub, DUB_SCORE]]);
  const names = { [ids.dual]: CF_NAMES.dual, [ids.dub]: CF_NAMES.dub };
  const items = (p.formatItems || []).map((fi) => (ours.has(fi.format) ? { ...fi, score: ours.get(fi.format) } : fi));
  for (const [format, score] of ours) if (!items.some((fi) => fi.format === format)) items.push({ format, name: names[format], score });
  const top = topOtherScore(p, ours);
  const minFormatScore = Math.max(p.minFormatScore ?? 0, Math.min(0, DUB_SCORE + top + 1));
  if (original) return { ...p, formatItems: items, cutoffFormatScore: Math.min(p.cutoffFormatScore ?? 0, top), minFormatScore };
  return {
    ...p,
    formatItems: items,
    upgradeAllowed: true,
    cutoffFormatScore: Math.max(p.cutoffFormatScore ?? 0, dualScore, top + 1),
    minFormatScore,
  };
}

/** How a quality profile stands with respect to Dualarr's formats, in the given mode. */
export function profileState(p, ids, mode = 'dual') {
  const ours = new Set([ids.dual, ids.dub].filter(Boolean));
  const score = (id) => (id ? (p.formatItems || []).find((fi) => fi.format === id)?.score ?? null : null);
  const dual = score(ids.dual);
  const dub = score(ids.dub);
  const top = topOtherScore(p, ours);
  const blocked = (s) => s < 0 && s + top < (p.minFormatScore ?? 0);
  const problems = [];
  if (!ids.dual || !ids.dub) problems.push('custom formats not created yet');
  else if (mode === 'original') {
    if (!blocked(dual ?? 0)) problems.push('dual audio releases can still be grabbed');
    if (!blocked(dub ?? 0)) problems.push('dub-only releases can still be grabbed');
    if ((p.cutoffFormatScore ?? 0) > top) problems.push(`“upgrade until” score (${p.cutoffFormatScore}) can only be reached by dual audio`);
  } else {
    if (!(dual > top)) problems.push(`dual audio scores ${dual ?? 0}, not above the best other format (${top})`);
    if (!blocked(dub ?? 0)) problems.push('dub-only releases can still be grabbed');
    if (!p.upgradeAllowed) problems.push('upgrades are off');
    if (!((p.cutoffFormatScore ?? 0) > top)) problems.push(`“upgrade until” score (${p.cutoffFormatScore ?? 0}) stops before dual audio`);
  }
  return {
    id: p.id,
    name: p.name,
    mode,
    dual,
    dub,
    top,
    upgradeAllowed: !!p.upgradeAllowed,
    cutoffFormatScore: p.cutoffFormatScore ?? 0,
    minFormatScore: p.minFormatScore ?? 0,
    ready: !problems.length,
    problems,
  };
}
