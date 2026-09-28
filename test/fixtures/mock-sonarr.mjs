// A stand-in for the Sonarr v4 API: just enough for Dualarr's client, with a small anime library
// whose files cover every verdict, and every write recorded in `state` so tests can assert what
// Dualarr asked for.
//   node test/fixtures/mock-sonarr.mjs   (on :8989, API key "sonarrkey")
import http from 'node:http';

export const API_KEY = 'sonarrkey';

const mi = (audioLanguages, subtitles) => ({ audioLanguages, subtitles, videoCodec: 'x264' });
const file = (id, seriesId, seasonNumber, relativePath, mediaInfo, extra = {}) => ({
  id, seriesId, seasonNumber, relativePath, path: `/anime/${relativePath}`, size: 1e9,
  quality: { quality: { name: 'WEBDL-1080p' } }, customFormatScore: 0, mediaInfo, ...extra,
});
const poster = (n) => [{ coverType: 'poster', remoteUrl: `https://artworks.example/${n}.jpg` }];

/** A fresh library, so every test file starts from the same state. */
export function library() {
  const series = [
    { id: 1, title: 'Frieren', year: 2023, titleSlug: 'frieren', seriesType: 'anime', monitored: true, qualityProfileId: 1, originalLanguage: { name: 'Japanese' }, images: poster('frieren') },
    { id: 2, title: 'Dandadan', year: 2024, titleSlug: 'dandadan', seriesType: 'anime', monitored: true, qualityProfileId: 1, originalLanguage: { name: 'Japanese' }, images: poster('dandadan') },
    { id: 3, title: 'Mushishi', year: 2005, titleSlug: 'mushishi', seriesType: 'anime', monitored: true, qualityProfileId: 4, originalLanguage: { name: 'Japanese' }, images: [] },
    { id: 4, title: 'Midnight Diner', year: 2009, titleSlug: 'midnight-diner', seriesType: 'standard', monitored: true, qualityProfileId: 4, originalLanguage: { name: 'Japanese' }, images: [] },
    { id: 5, title: 'Breaking Bad', year: 2008, titleSlug: 'breaking-bad', seriesType: 'standard', monitored: true, qualityProfileId: 4, originalLanguage: { name: 'English' }, images: [] },
    { id: 6, title: 'Old Anime', year: 1998, titleSlug: 'old-anime', seriesType: 'anime', monitored: false, qualityProfileId: 1, originalLanguage: { name: 'Japanese' }, images: [] },
  ];
  const files = [
    // Frieren: season 1 dual audio, season 2 subbed (waiting for the dub) → one season search.
    file(101, 1, 1, 'Frieren/Season 1/Frieren - S01E01.mkv', mi('jpn/eng', 'eng')),
    file(102, 1, 1, 'Frieren/Season 1/Frieren - S01E02.mkv', mi('jpn/eng', 'eng/spa')),
    file(103, 1, 2, 'Frieren/Season 2/Frieren - S02E01.mkv', mi('jpn', 'eng')),
    file(104, 1, 2, 'Frieren/Season 2/Frieren - S02E02.mkv', mi('Japanese', 'English')),
    // Dandadan: one of each, and an English-only dub that came from a grab Sonarr remembers.
    file(201, 2, 1, 'Dandadan/Season 1/Dandadan - S01E01.mkv', mi('jpn/eng', 'eng')),
    file(202, 2, 1, 'Dandadan/Season 1/Dandadan - S01E02.mkv', mi('jpn', 'eng')),
    file(203, 2, 1, 'Dandadan/Season 1/Dandadan - S01E03.mkv', mi('eng', 'eng'), { sceneName: 'Dandadan.S01E03.1080p.WEB.English.Dub' }),
    // Mushishi: no subtitle track, one of them burned in.
    file(301, 3, 1, 'Mushishi/Season 1/Mushishi - S01E01.mkv', mi('jpn', '')),
    file(302, 3, 1, 'Mushishi/Season 1/Mushishi - S01E02 [HardSub].mkv', mi('jpn', '')),
    // Midnight Diner (a Japanese "standard" series): no media info yet.
    file(401, 4, 1, 'Midnight Diner/Season 1/Midnight Diner - S01E01.mkv', null),
    file(501, 5, 1, 'Breaking Bad/Season 1/Breaking Bad - S01E01.mkv', mi('eng', 'eng')),
    file(601, 6, 1, 'Old Anime/Season 1/Old Anime - S01E01.mkv', mi('jpn', '')),
  ];
  let epId = 1000;
  const episodes = files.map((f) => ({ id: ++epId, seriesId: f.seriesId, seasonNumber: f.seasonNumber, episodeNumber: Number(f.relativePath.match(/E(\d+)/)[1]), episodeFileId: f.id, hasFile: true, monitored: true }));
  // An unmonitored episode with a file that needs work: never searched on its own.
  episodes.find((e) => e.episodeFileId === 301).monitored = false;
  const history = {
    2: [
      { id: 900, eventType: 'grabbed', date: '2026-09-01T10:00:00Z', downloadId: 'DL1', sourceTitle: 'Dandadan.S01E03.1080p.WEB.English.Dub', episodeId: 1007 },
      { id: 901, eventType: 'downloadFolderImported', date: '2026-09-01T10:05:00Z', downloadId: 'DL1', sourceTitle: 'Dandadan.S01E03.1080p.WEB.English.Dub', data: { importedPath: '/anime/Dandadan/Season 1/Dandadan - S01E03.mkv' } },
      { id: 902, eventType: 'grabbed', date: '2026-08-01T10:00:00Z', downloadId: 'DL0', sourceTitle: 'Dandadan.S01E02.1080p.WEB' },
    ],
  };
  const customFormats = [{ id: 10, name: 'Tier 1 Group', includeCustomFormatWhenRenaming: false, specifications: [] }];
  const qualityProfiles = [
    { id: 1, name: 'Anime', upgradeAllowed: false, cutoff: 3, minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [{ format: 10, name: 'Tier 1 Group', score: 1500 }], items: [] },
    { id: 4, name: 'HD-1080p', upgradeAllowed: true, cutoff: 3, minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [{ format: 10, name: 'Tier 1 Group', score: 0 }], items: [] },
    { id: 7, name: 'Ultra-HD', upgradeAllowed: true, cutoff: 3, minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], items: [] },
  ];
  return { series, files, episodes, history, customFormats, qualityProfiles };
}

export function startSonarr(port = 0) {
  const state = {
    ...library(),
    nextId: 100,
    writes: [], // every non-GET request: { method, path, body }
    commands: [],
    failed: [], // history ids marked failed
    deleted: [], // episode file ids
    failSeries: new Set(), // series ids whose files can't be read
    failHistory: false,
    failCommands: false,
    failMarkFailed: false,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'Unauthorized' });
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const p = url.pathname.replace(/^\/api\/v3/, '');
      const seriesId = Number(url.searchParams.get('seriesId'));
      if (req.method !== 'GET') state.writes.push({ method: req.method, path: p, body });
      let m;
      if (p === '/system/status') return send(200, { appName: 'Sonarr', version: '4.0.15.2941' });
      if (p === '/series') return send(200, state.series);
      if ((m = p.match(/^\/series\/(\d+)$/))) {
        const s = state.series.find((x) => x.id === Number(m[1]));
        return s ? send(200, s) : send(404, { message: 'NotFound' });
      }
      if (p === '/episodefile' && req.method === 'GET') {
        if (state.failSeries.has(seriesId)) return send(500, { message: 'disk on fire' });
        return send(200, state.files.filter((f) => f.seriesId === seriesId));
      }
      if ((m = p.match(/^\/episodefile\/(\d+)$/)) && req.method === 'DELETE') {
        const id = Number(m[1]);
        state.deleted.push(id);
        state.files = state.files.filter((f) => f.id !== id);
        for (const e of state.episodes) if (e.episodeFileId === id) Object.assign(e, { episodeFileId: 0, hasFile: false });
        return send(200, {});
      }
      if (p === '/episode') return send(200, state.episodes.filter((e) => e.seriesId === seriesId));
      if (p === '/history/series') return state.failHistory ? send(500, { message: 'history broken' }) : send(200, state.history[seriesId] || []);
      if ((m = p.match(/^\/history\/failed\/(\d+)$/)) && req.method === 'POST') {
        if (state.failMarkFailed) return send(500, { message: 'cannot mark failed' });
        state.failed.push(Number(m[1]));
        return send(200);
      }
      if (p === '/command' && req.method === 'POST') {
        if (state.failCommands) return send(500, { message: 'indexers down' });
        state.commands.push(body);
        return send(201, { id: state.commands.length, ...body });
      }
      if (p === '/customformat' && req.method === 'GET') return send(200, state.customFormats);
      if (p === '/customformat' && req.method === 'POST') {
        const cf = { ...body, id: state.nextId++ };
        state.customFormats.push(cf);
        // Like Sonarr: a new format joins every profile with a score of 0.
        for (const qp of state.qualityProfiles) qp.formatItems.push({ format: cf.id, name: cf.name, score: 0 });
        return send(201, cf);
      }
      if ((m = p.match(/^\/customformat\/(\d+)$/)) && req.method === 'PUT') {
        const i = state.customFormats.findIndex((c) => c.id === Number(m[1]));
        state.customFormats[i] = { ...body, id: Number(m[1]) };
        return send(202, state.customFormats[i]);
      }
      if (p === '/qualityprofile') return send(200, state.qualityProfiles);
      if ((m = p.match(/^\/qualityprofile\/(\d+)$/))) {
        const i = state.qualityProfiles.findIndex((q) => q.id === Number(m[1]));
        if (i < 0) return send(404, { message: 'NotFound' });
        if (req.method === 'PUT') state.qualityProfiles[i] = { ...body, id: Number(m[1]) };
        return send(req.method === 'PUT' ? 202 : 200, state.qualityProfiles[i]);
      }
      send(404, { message: 'NotFound' });
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1]?.endsWith('mock-sonarr.mjs')) {
  await startSonarr(8989);
  console.log(`mock Sonarr on :8989 (API key ${API_KEY})`);
}
