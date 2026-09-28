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
  zh: ['zh', 'chi', 'zho', 'chinese'],
  ko: ['ko', 'kor', 'korean'],
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
/** Files that should be searched for a better release. */
export const NEEDS_SEARCH = ['subbed', 'noSubs', 'noJapanese'];
/** Files that break the rules outright: safe to delete and grab again. */
export const REPLACEABLE = ['noSubs', 'noJapanese'];

const HARDSUB = /\bhard[ ._-]?sub(bed|s)?\b/i;

/**
 * One Sonarr episode file -> its languages and verdict:
 *  dual       Japanese + English audio, with subtitles
 *  subbed     Japanese audio with subtitles, no English audio yet (waiting for the dub)
 *  noSubs     Japanese audio but no (matching) subtitles
 *  noJapanese no Japanese audio track (e.g. an English-only dub)
 *  unknown    Sonarr has no media info, or the audio tracks aren't tagged with a language
 */
export function classifyFile(f, { requireSubtitles = true, subtitleLanguage = 'any' } = {}) {
  const mi = f.mediaInfo;
  const audio = langs(mi?.audioLanguages);
  let subs = langs(mi?.subtitles);
  // Burned-in subtitles have no track; trust the release name when it says so.
  const hardsub = !subs.length && HARDSUB.test(`${f.sceneName || ''} ${f.relativePath || ''}`);
  if (hardsub) subs = ['hardsub'];
  const known = audio.filter((l) => l !== 'und');
  const subsOk = hardsub || (subtitleLanguage === 'any' ? subs.length > 0 : subs.includes(subtitleLanguage));

  let status;
  if (!mi || !known.length) status = 'unknown';
  else if (!known.includes('ja')) status = 'noJapanese';
  else if (requireSubtitles && !subsOk) status = 'noSubs';
  else if (known.includes('en')) status = 'dual';
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
  };
}

/** Whether a Sonarr series is checked at all. */
export const inScope = (s, scope) =>
  s.seriesType === 'anime' || (scope === 'japanese' && /^japanese$/i.test(s.originalLanguage?.name || ''));

const emptyCounts = () => Object.fromEntries(STATUSES.map((k) => [k, 0]));

/** A series and its classified files, as stored and shown. */
export function summariseSeries(s, files, opts) {
  const classified = files.map((f) => classifyFile(f, opts)).sort((a, b) => a.season - b.season || a.path.localeCompare(b.path));
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
    counts,
    total: classified.length,
    files: classified,
  };
}

/** done / waiting (subbed, dub not out yet) / problem (rule broken) / unknown / empty. */
export function seriesState(row) {
  const c = row.counts;
  if (!row.total) return 'empty';
  if (c.noJapanese || c.noSubs) return 'problem';
  if (c.subbed) return 'waiting';
  if (c.unknown === row.total) return 'unknown';
  return 'done';
}

export const needsSearch = (row) => NEEDS_SEARCH.some((k) => row.counts[k] > 0);

export function totals(rows) {
  const files = emptyCounts();
  const series = { done: 0, waiting: 0, problem: 0, unknown: 0, empty: 0 };
  for (const r of rows) {
    for (const k of STATUSES) files[k] += r.counts[k];
    series[seriesState(r)]++;
  }
  return { series: rows.length, files, states: series };
}

/**
 * What changed since the last scan, per series. Upgraded files get new file ids, so this
 * compares counts: fewer files needing work + more dual audio = upgraded. Series seen for the
 * first time are skipped, so the first scan doesn't announce the whole library.
 */
export function diffScans(prevById, rows) {
  const upgraded = [];
  const problems = [];
  for (const r of rows) {
    const p = prevById.get(r.id);
    if (!p) continue;
    const need = (c) => c.subbed + c.noSubs + c.noJapanese;
    const gained = Math.min(r.counts.dual - p.counts.dual, need(p.counts) - need(r.counts));
    if (gained > 0) upgraded.push({ id: r.id, title: r.title, files: gained });
    const noJapanese = r.counts.noJapanese - p.counts.noJapanese;
    const noSubs = r.counts.noSubs - p.counts.noSubs;
    if (noJapanese > 0 || noSubs > 0) problems.push({ id: r.id, title: r.title, noJapanese: Math.max(0, noJapanese), noSubs: Math.max(0, noSubs) });
  }
  return { upgraded, problems };
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
 * A quality profile with Dualarr's scores applied:
 *  - dual audio scores `dualScore`, dub-only DUB_SCORE,
 *  - upgrades are on, and continue until a file scores at least the dual audio score (so a
 *    subbed file keeps being upgraded until dual audio arrives),
 *  - the minimum score is high enough that a dub-only release is never grabbed.
 */
export function profileWithScores(p, ids, dualScore) {
  const ours = new Map([[ids.dual, dualScore], [ids.dub, DUB_SCORE]]);
  const names = { [ids.dual]: CF_NAMES.dual, [ids.dub]: CF_NAMES.dub };
  const items = (p.formatItems || []).map((fi) => (ours.has(fi.format) ? { ...fi, score: ours.get(fi.format) } : fi));
  for (const [format, score] of ours) if (!items.some((fi) => fi.format === format)) items.push({ format, name: names[format], score });
  const top = topOtherScore(p, ours);
  return {
    ...p,
    formatItems: items,
    upgradeAllowed: true,
    cutoffFormatScore: Math.max(p.cutoffFormatScore ?? 0, dualScore, top + 1),
    minFormatScore: Math.max(p.minFormatScore ?? 0, Math.min(0, DUB_SCORE + top + 1)),
  };
}

/** How a quality profile stands with respect to Dualarr's formats. */
export function profileState(p, ids) {
  const ours = new Set([ids.dual, ids.dub].filter(Boolean));
  const score = (id) => (id ? (p.formatItems || []).find((fi) => fi.format === id)?.score ?? null : null);
  const dual = score(ids.dual);
  const dub = score(ids.dub);
  const top = topOtherScore(p, ours);
  const problems = [];
  if (!ids.dual || !ids.dub) problems.push('custom formats not created yet');
  else {
    if (!(dual > top)) problems.push(`dual audio scores ${dual ?? 0}, not above the best other format (${top})`);
    if (!(dub < 0) || (dub ?? 0) + top >= (p.minFormatScore ?? 0)) problems.push('dub-only releases can still be grabbed');
    if (!p.upgradeAllowed) problems.push('upgrades are off');
    if (!((p.cutoffFormatScore ?? 0) > top)) problems.push(`“upgrade until” score (${p.cutoffFormatScore ?? 0}) stops before dual audio`);
  }
  return {
    id: p.id,
    name: p.name,
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
