// End-to-end tests of the HTTP API: the real app against a stand-in Sonarr and webhook receiver.
// Login, sessions and the API key first, then every route the web UI uses.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import http from 'node:http';
import { API_KEY, startSonarr } from './fixtures/mock-sonarr.mjs';
import { startSink } from './fixtures/sink.mjs';
import { hasFfmpeg, makeEpisode } from './fixtures/media.mjs';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-api-'));
process.env.CONFIG_DIR = CONFIG_DIR;
process.env.WHISPER_BIN = new URL('./fixtures/fake-whisper.mjs', import.meta.url).pathname;
// A stand-in for the model download.
const models = http.createServer((req, res) => {
  if (!req.url.endsWith('ggml-tiny.bin')) return res.writeHead(404).end();
  res.end(Buffer.concat([Buffer.from('lmgg'), Buffer.alloc(1000)]));
});
await new Promise((r) => models.listen(0, r));
process.env.WHISPER_MODEL_URL = `http://127.0.0.1:${models.address().port}`;

const auth = await import('../server/auth.js');
const store = await import('../server/db.js');
const { app } = await import('../server/app.js');

const servers = [];
let C;
let sonarr;
let sink;
before(async () => {
  sonarr = await startSonarr();
  sink = await startSink();
  const s = await new Promise((r) => {
    const srv = app.listen(0, () => r(srv));
  });
  servers.push(s, sonarr.server, sink.server, models);
  C = `http://127.0.0.1:${s.address().port}`;
});
after(() => servers.forEach((s) => (s.closeAllConnections?.(), s.close())));

/** A tiny client: remembers its own session cookie, like one browser. */
function browser() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(C + p, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let parsed = text || null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* HTML page */
    }
    return { status: res.status, body: parsed, headers: res.headers, setCookie: set };
  };
  return { call, ui: (method, p, body) => call(method, p, body, { 'X-Dualarr': '1' }) };
}

const PASSWORD = 'correct horse';
let me; // the logged-in UI
const ok = async (method, p, body) => {
  const r = await me.ui(method, p, body);
  assert.ok(r.status < 400, `${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const waitIdle = async () => {
  for (let i = 0; i < 200; i++) {
    if (!(await ok('GET', '/api/status')).running) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the job never finished');
};

// ---------------------------------------------------------------------------

describe('password helpers', () => {
  test('scrypt hashes verify, reject wrong passwords and are salted', () => {
    const h = auth.hashPassword('hunter2hunter2');
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.ok(auth.verifyPassword('hunter2hunter2', h));
    assert.ok(!auth.verifyPassword('hunter2hunter3', h));
    assert.notEqual(h, auth.hashPassword('hunter2hunter2'), 'random salt');
    assert.ok(!auth.verifyPassword('x', ''), 'no stored hash');
    assert.ok(!auth.verifyPassword('x', 'md5$abc'), 'unknown scheme');
  });

  test('username and password rules', () => {
    assert.equal(auth.passwordProblem('short'), 'Use at least 8 characters');
    assert.equal(auth.passwordProblem('x'.repeat(300)), 'That password is too long');
    assert.equal(auth.passwordProblem(12345678), 'Use at least 8 characters');
    assert.equal(auth.passwordProblem('long enough'), null);
    assert.ok(auth.usernameProblem('a'));
    assert.ok(auth.usernameProblem('has space'));
    assert.equal(auth.usernameProblem('jp.admin@home'), null);
  });

  test('cookies', () => {
    assert.deepEqual(auth.parseCookies('a=1; dualarr_session=x%3Dy; junk'), { a: '1', dualarr_session: 'x=y' });
    const req = (secure, proto) => ({ secure, get: (h) => (h === 'x-forwarded-proto' ? proto : undefined) });
    assert.equal(auth.sessionCookie(req(false), 't', null), 'dualarr_session=t; Path=/; HttpOnly; SameSite=Lax');
    assert.match(auth.sessionCookie(req(false, 'https'), 't', 86_400_000), /; Secure; Max-Age=86400$/);
    assert.match(auth.sessionCookie(req(true), '', 0), /Max-Age=0$/);
  });
});

describe('web UI', () => {
  test('index is served with version-stamped assets and no-cache', async () => {
    const r = await browser().call('GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    // Every response names the server build; the page embeds the same one, so an open tab can
    // tell when Dualarr was updated underneath it and reload.
    const build = r.headers.get('x-dualarr-build');
    assert.match(build, /^\d+\.\d+\.\d+-[0-9a-z]+$/);
    assert.ok(r.body.includes(`<meta name="dualarr-build" content="${build}" />`));
    assert.ok(r.body.includes(`app.js?v=${build}`));
    assert.ok(r.body.includes(`app.css?v=${build}`));
    for (const f of ['/app.js', '/app.css', '/logo.svg', '/icon.png']) assert.equal((await browser().call('GET', f)).status, 200, f);
    assert.equal((await browser().call('GET', '/api/nope')).status, 401, 'unknown API routes are locked too');
  });
});

describe('first run', () => {
  test('before an account exists, only health and auth are open', async () => {
    const b = browser();
    const health = await b.call('GET', '/api/health');
    assert.deepEqual([health.status, health.body.ok], [200, true]);
    const st = (await b.call('GET', '/api/auth/status')).body;
    assert.deepEqual([st.configured, st.authenticated, st.user], [false, false, null]);
    const lib = await b.call('GET', '/api/library');
    assert.deepEqual([lib.status, lib.body.code], [401, 'setup']);
    assert.equal((await b.call('POST', '/api/auth/login', { username: 'a', password: 'b' })).status, 409);
  });

  test('creating the account validates, logs in, and can only happen once', async () => {
    const b = browser();
    assert.equal((await b.call('POST', '/api/auth/setup', { username: 'x', password: 'long enough' })).status, 400);
    assert.equal((await b.call('POST', '/api/auth/setup', { username: 'admin', password: 'short' })).status, 400);
    const r = await b.call('POST', '/api/auth/setup', { username: ' admin ', password: PASSWORD });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /^dualarr_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const st = (await b.call('GET', '/api/auth/status')).body;
    assert.deepEqual([st.configured, st.authenticated, st.user], [true, true, 'admin']);
    assert.equal((await browser().call('POST', '/api/auth/setup', { username: 'other', password: 'long enough' })).status, 409);
    assert.match(store.getSettings().apiKey, /^[0-9a-f]{48}$/, 'API key generated');
    me = b;
  });
});

describe('sessions', () => {
  test('login, remember-me, logout and wrong passwords', async () => {
    const b = browser();
    assert.equal((await b.call('GET', '/api/library')).body.code, 'login');
    const wrong = await b.call('POST', '/api/auth/login', { username: 'admin', password: 'nope nope' });
    assert.deepEqual([wrong.status, wrong.body.error], [401, 'Wrong username or password']);
    assert.equal((await b.call('POST', '/api/auth/login', { username: 'nobody', password: PASSWORD })).status, 401);
    const short = await b.call('POST', '/api/auth/login', { username: 'ADMIN', password: PASSWORD, remember: false });
    assert.equal(short.status, 200, 'usernames are case-insensitive');
    assert.doesNotMatch(short.setCookie, /Max-Age/, 'a browser-session cookie when not remembered');
    assert.equal((await b.call('GET', '/api/library')).status, 200);
    assert.equal((await b.call('POST', '/api/auth/logout')).status, 204);
    assert.equal((await b.call('GET', '/api/library')).status, 401);
  });

  test('changes need the X-Dualarr header (no cross-site requests)', async () => {
    const blocked = await me.call('PUT', '/api/settings', { searchPerRun: 3 });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'reload');
    assert.match(blocked.body.error, /out of date.*Reload the page/);
    assert.equal((await me.ui('PUT', '/api/settings', { searchPerRun: 3 })).status, 200);
    assert.equal((await me.call('GET', '/api/settings')).status, 200, 'reads are fine without it');
  });

  test('expired sessions are refused and cleaned up', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    const hash = store.db.prepare('SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1').get().token_hash;
    store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run('2000-01-01T00:00:00.000Z', hash);
    assert.equal((await b.call('GET', '/api/library')).status, 401);
    assert.equal(store.getSession(hash), null, 'the expired session is deleted');
  });

  test('the password hash is never sent to the browser', async () => {
    const s = (await me.call('GET', '/api/settings')).body;
    assert.ok(!('authHash' in s));
    assert.equal(s.authUser, 'admin');
  });
});

describe('API key', () => {
  test('scripts use X-Api-Key or ?apikey= (no header or cookie needed)', async () => {
    const key = store.getSettings().apiKey;
    const anon = browser();
    assert.equal((await anon.call('PUT', '/api/settings', { searchPerRun: 10 }, { 'X-Api-Key': key })).status, 200);
    assert.equal((await anon.call('GET', `/api/status?apikey=${key}`)).status, 200);
    assert.equal((await anon.call('GET', '/api/status', undefined, { 'X-Api-Key': 'wrong' })).status, 401);
  });

  test('a new key replaces the old one', async () => {
    const old = store.getSettings().apiKey;
    const s = (await me.ui('POST', '/api/auth/keys/api')).body;
    assert.notEqual(s.apiKey, old);
    assert.equal((await browser().call('GET', '/api/status', undefined, { 'X-Api-Key': old })).status, 401);
    assert.equal((await browser().call('GET', '/api/status', undefined, { 'X-Api-Key': s.apiKey })).status, 200);
    assert.equal((await me.ui('POST', '/api/auth/keys/feed')).status, 404, 'Dualarr has no feed key');
  });
});

describe('settings', () => {
  test('every field is validated', async () => {
    for (const bad of [
      { schedule: 'nope' },
      { scope: 'everything' },
      { subtitleLanguage: 'klingon' },
      { sonarrUrl: 'ftp://sonarr' },
      { notifiers: 'nope' },
      { notifiers: [{ type: 'pigeon' }] },
      { notifiers: [{ type: 'discord', webhookUrl: 'https://example.com/hook' }] },
      { notifiers: [{ type: 'telegram', botToken: 'x' }] },
      { notifiers: [{ type: 'ntfy', topic: '' }] },
      { notifiers: [{ type: 'gotify', server: 'nope', token: 't' }] },
      { notifiers: [{ type: 'webhook', url: 'nope' }] },
    ]) assert.equal((await me.ui('PUT', '/api/settings', bad)).status, 400, JSON.stringify(bad));
    const s = await ok('PUT', '/api/settings', {
      sonarrUrl: `${sonarr.url}///`,
      sonarrApiKey: ` ${API_KEY} `,
      dualScore: 'x',
      searchPerRun: 500,
      searchAgainDays: 0,
      profileIds: [4, 4, '1', -1, 'x', 0],
      autoSearch: 0,
      notifyUpgrades: 'yes',
      schedule: ' 30 4 * * * ',
    });
    assert.equal(s.sonarrUrl, sonarr.url, 'trailing slashes trimmed');
    assert.deepEqual([s.sonarrApiKey, s.sonarrApiKeySet], ['', true], 'the key is never sent back');
    assert.equal(store.getSettings().sonarrApiKey, API_KEY);
    assert.deepEqual([s.dualScore, s.searchPerRun, s.searchAgainDays, s.profileIds, s.autoSearch, s.notifyUpgrades, s.schedule], [2000, 100, 1, [4, 1], false, true, '30 4 * * *']);
    assert.equal((await ok('GET', '/api/status')).schedule, '30 4 * * *');
    assert.ok((await ok('GET', '/api/status')).nextRun, 'rescheduled');
    await ok('PUT', '/api/settings', { schedule: '' });
    assert.equal((await ok('GET', '/api/status')).nextRun, null, 'off');
    await ok('PUT', '/api/settings', { schedule: '0 4 * * *', searchPerRun: 10, searchAgainDays: 7, autoSearch: true, profileIds: [] });
  });

  test('blank keeps the Sonarr key; clearing removes it', async () => {
    assert.equal((await ok('PUT', '/api/settings', { sonarrApiKey: '' })).sonarrApiKeySet, true);
    assert.equal((await ok('PUT', '/api/settings', { clearSonarrApiKey: true })).sonarrApiKeySet, false);
    assert.equal((await me.ui('POST', '/api/scan')).status, 400, 'nothing works without it');
    assert.match((await me.ui('GET', '/api/setup')).body.error, /Connect Sonarr/);
    await ok('PUT', '/api/settings', { sonarrApiKey: API_KEY });
  });

  test('testing the Sonarr connection', async () => {
    assert.deepEqual(await ok('POST', '/api/settings/test', {}), { ok: true, appName: 'Sonarr', version: '4.0.15.2941' });
    const wrong = await ok('POST', '/api/settings/test', { url: sonarr.url, apiKey: 'wrong' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /HTTP 401/);
    const down = await ok('POST', '/api/settings/test', { url: 'http://127.0.0.1:1', apiKey: 'x' });
    assert.match(down.error, /^fetch failed \(.+\)$/, 'the cause is shown');
    assert.equal((await me.ui('POST', '/api/settings/test', { url: '' })).status, 400);
  });

  test('notifiers: secrets kept but never returned, and a test send', async () => {
    const saved = await ok('PUT', '/api/settings', {
      notifiers: [
        { type: 'webhook', name: 'Sink', url: `${sink.url}/hook` },
        { type: 'ntfy', topic: 'dualarr', token: 'secret-token', enabled: false },
      ],
    });
    const ntfy = saved.notifiers[1];
    assert.deepEqual([ntfy.token, ntfy.enabled, ntfy.server], ['••••••••', false, '']);
    assert.match(ntfy.id, /^[0-9a-f-]{36}$/);
    await ok('PUT', '/api/settings', { notifiers: saved.notifiers });
    assert.equal(store.getSettings().notifiers[1].token, 'secret-token', 'masked value keeps the secret');
    sink.received.length = 0;
    assert.deepEqual(await ok('POST', '/api/notify/test', saved.notifiers[0]), { ok: true });
    assert.equal(sink.received[0].body.event, 'test');
    const fail = await ok('POST', '/api/notify/test', { type: 'webhook', url: 'http://127.0.0.1:1/x' });
    assert.equal(fail.ok, false);
    assert.equal((await me.ui('POST', '/api/notify/test', { type: 'pigeon' })).status, 400);
  });
});

describe('library', () => {
  test('empty before the first scan', async () => {
    const lib = await ok('GET', '/api/library');
    assert.deepEqual([lib.series, lib.totals.series, lib.sonarrUrl], [[], 0, sonarr.url]);
  });

  test('scan runs in the background; status shows it', async () => {
    const r = await me.ui('POST', '/api/scan');
    assert.deepEqual([r.status, r.body], [202, { started: true }]);
    assert.equal((await ok('GET', '/api/status')).running, 'scan');
    await waitIdle();
    const st = await ok('GET', '/api/status');
    assert.deepEqual([st.lastRun.trigger, st.lastRun.status, st.lastRun.summary.scanned], ['scan', 'ok', 4]);
    assert.equal(st.timezone.length > 0, true);
  });

  test('series come with their state; files come with a series', async () => {
    const lib = await ok('GET', '/api/library');
    assert.deepEqual(lib.series.map((s) => [s.title, s.state, s.needsSearch]), [
      ['Dandadan', 'problem', true],
      ['Frieren', 'waiting', true],
      ['Mushishi', 'problem', true],
      ['Old Anime', 'problem', true],
    ]);
    assert.ok(lib.series.every((s) => !('files' in s)), 'the list leaves files out');
    assert.deepEqual(lib.totals.states, { done: 0, waiting: 1, problem: 3, unknown: 0, empty: 0 });
    const fr = await ok('GET', '/api/series/1');
    assert.deepEqual([fr.state, fr.files.length, fr.files[2].status], ['waiting', 4, 'subbed']);
    assert.equal((await me.ui('GET', '/api/series/999')).status, 404);
    assert.equal((await me.ui('GET', '/api/series/abc')).status, 404);
  });

  test('search: chosen series, or every monitored one that needs it', async () => {
    sonarr.state.commands.length = 0;
    const one = await ok('POST', '/api/search', { ids: [1] });
    assert.deepEqual(one.summary.searched, [{ id: 1, title: 'Frieren', seasons: 1, episodes: 0 }]);
    assert.deepEqual(sonarr.state.commands, [{ name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 }]);
    const all = await ok('POST', '/api/search', {});
    assert.deepEqual(all.summary.searched.map((s) => s.title), ['Dandadan', 'Frieren', 'Mushishi'], 'unmonitored Old Anime left out');
    assert.ok((await ok('GET', '/api/series/2')).searchedAt);
    assert.equal((await me.ui('POST', '/api/search', { ids: [] })).status, 400);
    const none = await me.ui('POST', '/api/search', { ids: [999] });
    assert.deepEqual([none.status, none.body.error], [400, 'Nothing to search for — every file already has dual audio']);
  });

  test('replace: blocklists, deletes, searches and returns the rescanned series', async () => {
    sonarr.state.commands.length = 0;
    const r = await ok('POST', '/api/series/2/replace', { fileIds: [203] });
    assert.deepEqual(r.summary.replaced, { title: 'Dandadan', files: 1, blocklisted: 1, episodes: 1 });
    assert.deepEqual([sonarr.state.failed, sonarr.state.deleted], [[900], [203]]);
    assert.deepEqual(sonarr.state.commands, [{ name: 'EpisodeSearch', episodeIds: [1007] }]);
    assert.deepEqual([r.series.state, r.series.files.length], ['waiting', 2]);
    const again = await me.ui('POST', '/api/series/2/replace', { fileIds: [201] });
    assert.deepEqual([again.status, again.body.error], [400, 'None of those files break the rules any more — scan again']);
    assert.equal((await me.ui('POST', '/api/series/2/replace', {})).status, 400);
  });
});

describe('Sonarr setup', () => {
  test('state before, apply, state after', async () => {
    const before = await ok('GET', '/api/setup');
    assert.deepEqual(before.formats, { dual: null, dub: null });
    assert.deepEqual(before.profiles.map((p) => [p.name, p.series, p.ready]), [['Anime', 3, false], ['HD-1080p', 1, false], ['Ultra-HD', 0, false]]);
    assert.equal((await me.ui('POST', '/api/setup', { profileIds: [] })).status, 400);

    const r = await ok('POST', '/api/setup', { profileIds: [1, 4], dualScore: 2500 });
    assert.deepEqual([r.status, r.summary.profiles], ['ok', ['Anime', 'HD-1080p']]);
    assert.ok(r.formats.dual && r.formats.dub);
    assert.deepEqual(r.profiles.map((p) => [p.name, p.ready, p.dual]), [['Anime', true, 2500], ['HD-1080p', true, 2500], ['Ultra-HD', false, 0]]);
    assert.deepEqual([store.getSettings().profileIds, store.getSettings().dualScore], [[1, 4], 2500]);

    // Again with the saved choices: formats updated in place, nothing duplicated.
    const again = await ok('POST', '/api/setup', {});
    assert.deepEqual(again.summary.profiles, ['Anime', 'HD-1080p']);
    assert.equal(sonarr.state.customFormats.length, 3);
  });
});

describe('rules changes', () => {
  test('changing a rule rescans quietly; other settings do not', async () => {
    assert.equal((await ok('PUT', '/api/settings', { searchPerRun: 5 })).rescanning, false);
    sink.received.length = 0;
    const s = await ok('PUT', '/api/settings', { requireSubtitles: false });
    assert.equal(s.rescanning, true);
    await waitIdle();
    const run = (await ok('GET', '/api/runs'))[0];
    assert.deepEqual([run.trigger, run.status], ['rules', 'ok']);
    assert.equal((await ok('GET', '/api/series/3')).counts.subbed, 2, 'no-subs files are just subbed now');
    assert.deepEqual(sink.received, [], 'a rule change is not news');
    await ok('PUT', '/api/settings', { requireSubtitles: true });
    await waitIdle();
  });

  test('the activity log', async () => {
    const runs = await ok('GET', '/api/runs');
    assert.deepEqual(runs.slice(0, 3).map((r) => r.trigger), ['rules', 'rules', 'setup']);
    assert.ok(runs.every((r) => r.finished_at && r.summary));
  });
});

describe('checking files', () => {
  const MEDIA = path.join(CONFIG_DIR, 'media');

  test('settings are validated', async () => {
    for (const bad of [
      { verifyModel: 'large' },
      { verifyDevice: 'gpu' },
      { verifyDevice: 'npu:0' },
      { pathMappings: 'nope' },
      { pathMappings: [{ from: 'anime', to: '/media' }] },
      { pathMappings: [{ from: '/anime', to: 'media' }] },
    ]) assert.equal((await me.ui('PUT', '/api/settings', bad)).status, 400, JSON.stringify(bad));
    const s = await ok('PUT', '/api/settings', {
      verify: 1,
      verifyModel: 'tiny',
      verifyDevice: 'gpu:1',
      verifyPerRun: 0,
      pathMappings: [{ from: ' /anime ', to: `${MEDIA} ` }, { from: '', to: '' }, { from: 'D:\\Anime', to: '/win' }],
    });
    assert.deepEqual([s.verify, s.verifyModel, s.verifyDevice, s.verifyPerRun], [true, 'tiny', 'gpu:1', 1]);
    assert.deepEqual(s.pathMappings, [{ from: '/anime', to: MEDIA }, { from: 'D:\\Anime', to: '/win' }]);
    assert.equal(s.rescanning, false, 'checking settings don’t rescan');
    await ok('PUT', '/api/settings', { verifyDevice: 'auto', verifyPerRun: 100, pathMappings: [{ from: '/anime', to: MEDIA }] });
  });

  test('status: tools, GPUs, the model, and which Sonarr folders are visible', async () => {
    fs.mkdirSync(MEDIA, { recursive: true });
    process.env.FAKE_GPU = 'NVIDIA GeForce GTX 1050 Ti';
    const st = await ok('GET', '/api/verify?refresh=1');
    delete process.env.FAKE_GPU;
    assert.equal(st.tools.whisper, 'installed');
    assert.deepEqual(st.tools.devices.map((d) => d.name), ['NVIDIA GeForce GTX 1050 Ti']);
    assert.equal(st.device, 'NVIDIA GeForce GTX 1050 Ti (Vulkan)');
    assert.deepEqual(Object.keys(st.models), ['tiny', 'base', 'small']);
    assert.deepEqual([st.model.name, st.model.present, st.download], ['tiny', false, null]);
    assert.deepEqual(st.roots, [{ path: '/anime', mapped: MEDIA, visible: true }, { path: '/tv', mapped: '/tv', visible: false }]);
    await ok('GET', '/api/verify?refresh=1');
  });

  test('the model downloads in the background', async () => {
    assert.equal((await me.ui('POST', '/api/verify/model', { model: 'huge' })).status, 400);
    const r = await me.ui('POST', '/api/verify/model', {});
    assert.equal(r.status, 202);
    for (let i = 0; i < 100 && !(await ok('GET', '/api/verify')).model.present; i++) await new Promise((res) => setTimeout(res, 20));
    const st = await ok('GET', '/api/verify');
    assert.deepEqual([st.model.present, st.download.done, st.download.error], [true, true, null]);
    assert.equal((await me.ui('POST', '/api/verify/model', {})).status, 202, 'already there: nothing to do');
  });

  test('verify now, a series again, and the test button', { skip: !hasFfmpeg() && 'needs ffmpeg' }, async () => {
    for (const f of sonarr.state.files) f.size = 1e9;
    makeEpisode(path.join(MEDIA, 'Frieren/Season 2/Frieren - S02E01.mkv'), { audio: [{ sound: 'en', tag: 'jpn' }], subs: [{ lang: 'en', tag: 'eng' }] });
    await ok('POST', '/api/scan');
    await waitIdle();
    const t = await ok('POST', '/api/verify/test');
    assert.deepEqual([t.title, t.file, t.status, t.device], ['Frieren', 'Frieren/Season 2/Frieren - S02E01.mkv', 'noJapanese', 'CPU']);
    assert.deepEqual(t.notes, ['Audio 1 is tagged Japanese but sounds English']);

    assert.equal((await me.ui('POST', '/api/verify', { seriesIds: [] })).status, 400);
    assert.equal((await me.ui('POST', '/api/verify', { seriesIds: [1] })).status, 202);
    await waitIdle();
    const run = (await ok('GET', '/api/runs'))[0];
    assert.deepEqual([run.trigger, run.status, run.summary.verified.files, run.summary.verified.missing], ['verify', 'partial', 1, 3], 'the rest of Frieren isn’t in the test media');
    const fr = await ok('GET', '/api/series/1');
    assert.deepEqual([fr.verified, fr.files.find((f) => f.verified).status], [1, 'noJapanese']);
    assert.equal((await ok('GET', '/api/library')).totals.verified, 1);
    assert.equal((await me.ui('POST', '/api/verify', {})).status, 202, 'the next files due');
    await waitIdle();
  });

  test('refused when checking is off', async () => {
    await ok('PUT', '/api/settings', { verify: false });
    const r = await me.ui('POST', '/api/verify', {});
    assert.deepEqual([r.status, r.body.error], [400, 'Turn on “Check files” in Settings first']);
    await ok('PUT', '/api/settings', { pathMappings: [] });
    assert.match((await me.ui('POST', '/api/verify/test')).body.error, /^None of the library's files are visible/);
  });
});

describe('changing the login', () => {
  test('needs the current password; a new password signs out other browsers', async () => {
    const other = browser();
    await other.call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    assert.equal((await me.ui('PUT', '/api/auth/account', { current: 'wrong', password: 'new password 1' })).status, 400);
    assert.equal((await me.ui('PUT', '/api/auth/account', { current: PASSWORD, password: 'short' })).status, 400);
    assert.equal((await me.ui('PUT', '/api/auth/account', { current: PASSWORD, username: 'no spaces allowed' })).status, 400);
    const r = await me.ui('PUT', '/api/auth/account', { current: PASSWORD, username: 'owner', password: 'new password 1' });
    assert.deepEqual([r.status, r.body.user], [200, 'owner']);
    assert.equal((await me.call('GET', '/api/library')).status, 200, 'this browser stays signed in');
    assert.equal((await other.call('GET', '/api/library')).status, 401, 'others are signed out');
    assert.equal((await browser().call('POST', '/api/auth/login', { username: 'owner', password: 'new password 1' })).status, 200);
    // renaming alone keeps every session
    await me.ui('PUT', '/api/auth/account', { current: 'new password 1', username: 'admin' });
    assert.equal((await me.call('GET', '/api/auth/status')).body.user, 'admin');
  });

  test('too many wrong passwords from one address are blocked for a while', async () => {
    const b = browser();
    for (let i = 0; i < 8; i++) await b.call('POST', '/api/auth/login', { username: 'admin', password: `guess ${i}` });
    const r = await b.call('POST', '/api/auth/login', { username: 'admin', password: 'new password 1' });
    assert.equal(r.status, 429, 'even the right password waits');
    assert.match(r.body.error, /Too many failed attempts/);
  });
});

describe('start-up', () => {
  const freePort = () =>
    new Promise((r) => {
      const s = net.createServer().listen(0, () => {
        const { port } = s.address();
        s.close(() => r(port));
      });
    });
  const startServer = async (env) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
      env: { ...process.env, CONFIG_DIR, PORT: String(port), TZ: 'Europe/London', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 100 && !/listening on/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
    return { child, port, log: () => log };
  };

  test('schedules the scan; DUALARR_RESET_AUTH=true removes the login', async () => {
    const normal = await startServer({});
    try {
      assert.match(normal.log(), /Dualarr \d+\.\d+\.\d+ listening on :\d+ \(TZ Europe\/London\)/);
      assert.match(normal.log(), /Scheduled scan "0 4 \* \* \*" \(Europe\/London\)/);
      const st = await (await fetch(`http://127.0.0.1:${normal.port}/api/auth/status`)).json();
      assert.equal(st.configured, true);
    } finally {
      normal.child.kill();
    }
    const reset = await startServer({ DUALARR_RESET_AUTH: 'true' });
    try {
      assert.match(reset.log(), /the login was removed/);
      const st = await (await fetch(`http://127.0.0.1:${reset.port}/api/auth/status`)).json();
      assert.equal(st.configured, false);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'all sessions ended');
    } finally {
      reset.child.kill();
    }
  });
});
