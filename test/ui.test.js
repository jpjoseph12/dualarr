// The web UI in a real browser (Playwright's Chromium), against the real app and a stand-in
// Sonarr: a user's first run, then every screen, in the order they'd use them. The tests share
// one page and build on each other. Skips when Chromium isn't installed
// (`npx playwright install chromium`, or point CHROMIUM_PATH at a Chrome/Chromium binary).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { API_KEY, startSonarr } from './fixtures/mock-sonarr.mjs';
import { startSink } from './fixtures/sink.mjs';
import { hasFfmpeg, makeEpisode } from './fixtures/media.mjs';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-ui-'));
const MEDIA = path.join(CONFIG_DIR, 'media');
process.env.CONFIG_DIR = CONFIG_DIR;
// Chromium first, so a skip (or a CI failure) leaves nothing listening.
let chromium;
let skip = false;
try {
  ({ chromium } = await import('playwright'));
  const b = await chromium.launch(launchOptions());
  await b.close();
} catch (e) {
  if (process.env.CI) throw e; // CI installs Chromium: a silent skip would hide a broken UI
  skip = `needs Chromium for Playwright (${e.message.split('\n')[0]})`;
}
process.env.WHISPER_BIN = new URL('./fixtures/fake-whisper.mjs', import.meta.url).pathname;
// A stand-in for the model download (fake-whisper only checks the file exists).
const models = http.createServer((req, res) => {
  if (!/ggml-\w+\.bin$/.test(req.url)) return res.writeHead(404).end();
  res.end(Buffer.concat([Buffer.from('lmgg'), Buffer.alloc(1000)]));
});
await new Promise((r) => models.listen(0, r));
process.env.WHISPER_MODEL_URL = `http://127.0.0.1:${models.address().port}`;

function launchOptions() {
  return process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
}

const { app } = await import('../server/app.js');

const USER = 'admin';
const PASS = 'correct horse';
let C;
let sonarr;
let sink;
let browser;
let context;
let page;
const servers = [];
const errors = [];

before(async () => {
  if (skip) return;
  sonarr = await startSonarr();
  sink = await startSink();
  const s = await new Promise((r) => {
    const srv = app.listen(0, () => r(srv));
  });
  servers.push(s, sonarr.server, sink.server);
  C = `http://127.0.0.1:${s.address().port}`;
  browser = await chromium.launch(launchOptions());
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // The mock's posters point at a made-up host.
  await page.route('https://artworks.example/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  page.on('pageerror', (e) => errors.push(e.message));
  // Failed requests are logged too; the tests make some on purpose (a wrong password).
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
});
after(async () => {
  await browser?.close();
  [...servers, models].forEach((s) => (s.closeAllConnections?.(), s.close()));
});

// --- helpers ---
const see = (sel, hasText) => page.locator(sel, hasText ? { hasText } : undefined).first().waitFor();
const texts = (sel) => page.locator(sel).allInnerTexts();
const text = (sel) => page.locator(sel).first().innerText();
const clearToasts = () => page.evaluate(() => document.getElementById('toasts').replaceChildren());
const toast = (t) => see('#toasts .toast', t);
const go = async (hash, ready) => {
  await page.goto(`${C}/${hash}`);
  await see(ready);
};
const idle = () => page.waitForFunction(async () => !(await (await fetch('/api/status')).json()).running, null, { polling: 200, timeout: 30_000 });
const rowTitles = () => texts('#lib-table [data-row] .title');
const saveSettings = () => page.click('.save-bar button[type=submit]');
const openRow = async (id) => {
  await page.click(`[data-row="${id}"] .sub`);
  await see(`[data-detail="${id}"] .detail-head`);
  await page.locator(`[data-detail="${id}"] .loading-block`).waitFor({ state: 'detached' });
};

describe('the web UI', { skip }, () => {
  test('first run: create the login, then Settings until Sonarr is connected', async () => {
    await page.goto(C);
    await see('#acct-form');
    assert.equal(await page.locator('header.top').isVisible(), false, 'no app bar before logging in');
    await page.fill('#ac-user', USER);
    await page.fill('#ac-pass', PASS);
    await page.fill('#ac-pass2', 'something else');
    await page.click('#acct-form button[type=submit]');
    await see('#ac-error', 'The passwords don’t match');

    await page.fill('#ac-pass2', PASS);
    await page.click('#acct-form button[type=submit]');
    await see('#settings-form');
    assert.equal(new URL(page.url()).hash, '#/settings');
    assert.equal(await page.locator('#logout').isVisible(), true);

    await page.click('[data-nav="library"]');
    await see('.empty h2', 'Connect Sonarr first');
    await page.locator('.empty a', { hasText: 'Open Settings' }).click();
    await see('#settings-form');
    await see('#setup-body', 'Connect Sonarr above and save first');
  });

  test('connecting Sonarr: Test says what’s wrong, and saving starts the first scan', async () => {
    await page.fill('#sonarr-url', sonarr.url);
    await page.fill('#sonarr-key', 'wrong');
    await page.click('#sonarr-test');
    await see('#sonarr-res.err');
    assert.match(await text('#sonarr-res'), /^Failed: .*401/);

    await page.fill('#sonarr-key', API_KEY);
    await page.click('#sonarr-test');
    await see('#sonarr-res.ok', 'Connected to Sonarr 4.0.15.2941');

    await clearToasts();
    await saveSettings();
    await toast('Settings saved');
    await toast('Scan finished');
    assert.equal(await page.locator('#sonarr-key').getAttribute('placeholder'), 'Saved — leave blank to keep', 'the key is never sent back');
    await see('#setup-body .profiles');
  });

  test('the library: tiles, verdict counts and every in-scope series', async () => {
    await go('#/', '#lib-table');
    assert.match(await text('.page-head p'), /^4 series checked · last scan just now/);
    assert.deepEqual(await texts('.tile b'), ['0', '1', '3', '0']);
    assert.deepEqual(await texts('.file-counts .vb'), ['3 Dual audio', '4 Subbed', '2 No subtitles', '1 No Japanese audio', '0 Unknown']);
    assert.deepEqual(await rowTitles(), ['Dandadan', 'Frieren', 'Mushishi', 'Old Anime']);
    assert.match(await text('[data-row="6"] .sub'), /unmonitored/);
    assert.equal(await page.locator('[data-row="1"] a.title').getAttribute('href'), `${sonarr.url}/series/frieren`, 'titles link to Sonarr');
    assert.equal(await page.locator('#verify-now').count(), 0, 'no Check files button while checking is off');
  });

  test('tabs and the title filter narrow the list', async () => {
    assert.deepEqual(await texts('#lib-tabs button'), ['All4', 'Waiting for dub1', 'Problems3', 'Done0', 'Unknown0']);
    await page.click('[data-tab="waiting"]');
    assert.deepEqual(await rowTitles(), ['Frieren']);
    await page.click('[data-tab="problem"]');
    assert.deepEqual(await rowTitles(), ['Dandadan', 'Mushishi', 'Old Anime']);
    await page.click('[data-tab="done"]');
    await see('#lib-table .empty', 'No series in this group');

    await page.click('[data-tab="all"]');
    await page.fill('#lib-filter', 'MUSH');
    assert.deepEqual(await rowTitles(), ['Mushishi']);
    await page.fill('#lib-filter', 'zzz');
    await see('#lib-table .empty', 'No series match that search');
    await page.fill('#lib-filter', '');
    assert.equal((await rowTitles()).length, 4);
  });

  test('a row opens to its files (dual audio ones are left out) and closes again', async () => {
    await openRow(2);
    assert.equal(await text('[data-detail="2"] .detail-head > span'), '2 files without dual audio');
    const rows = page.locator('[data-detail="2"] table.files tbody tr');
    assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).innerText(), /Dandadan - S01E02\.mkv[\s\S]*JA[\s\S]*EN[\s\S]*Subbed/);
    assert.match(await rows.nth(1).innerText(), /Dandadan\.S01E03\.1080p\.WEB\.English\.Dub[\s\S]*No Japanese audio/);
    assert.equal(await rows.nth(0).locator('[data-replace]').count(), 0, 'subbed files are left alone');
    assert.equal(await rows.nth(1).locator('[data-replace]').count(), 1);

    await page.click('[data-row="2"] .sub');
    await page.locator('[data-detail="2"]').waitFor({ state: 'detached' });
  });

  test('Search asks Sonarr for what the series needs', async () => {
    await clearToasts();
    await page.click('[data-search="1"]');
    await toast('Sonarr is searching Frieren (1 season)');
    assert.deepEqual(sonarr.state.commands, [{ name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 }]);
    assert.equal((await texts('[data-row="1"] td.when'))[1], 'just now');
  });

  test('Search all asks first, and Cancel means no', async () => {
    sonarr.state.commands.length = 0;
    await page.click('#search-all');
    await see('#dialog[open] h2');
    assert.match(await text('#dialog h2'), /^Search for \d+ series\?$/);
    await page.click('#dialog button[value=cancel]');
    await page.locator('#dialog[open]').waitFor({ state: 'detached' });
    assert.equal(sonarr.state.commands.length, 0);

    await clearToasts();
    await page.click('#search-all');
    await page.click('#dialog button[value=ok]');
    await toast('Sonarr is searching');
    // Old Anime needs it too, but isn't monitored.
    assert.deepEqual(sonarr.state.commands, [
      { name: 'EpisodeSearch', episodeIds: [1006, 1007] }, // Dandadan
      { name: 'SeasonSearch', seriesId: 1, seasonNumber: 2 },
      { name: 'SeasonSearch', seriesId: 3, seasonNumber: 1 },
    ]);
  });

  test('Replace confirms, then blocklists the release, deletes the file and searches', async () => {
    await see('#lib-table');
    await openRow(2);
    const replace = '[data-detail="2"] [data-replace][data-files="203"]';
    await page.click(replace);
    await see('#dialog[open] h2', 'Replace 1 file?');
    assert.match(await text('#dialog li'), /Dandadan - S01E03\.mkv — No Japanese audio/);
    await page.click('#dialog button[value=cancel]');
    assert.deepEqual(sonarr.state.deleted, []);

    await clearToasts();
    await page.click(replace);
    await page.click('#dialog button[value=ok]');
    await toast('Deleted 1 file, blocklisted 1 — Sonarr is searching 1 episode');
    assert.deepEqual([sonarr.state.failed, sonarr.state.deleted], [[900], [203]]);
    // The row shows the rescanned series straight away.
    await see('[data-detail="2"] .detail-head', '1 file without dual audio');
    assert.equal(await page.locator('[data-detail="2"] [data-replace]').count(), 0);
  });

  test('Sonarr setup: profiles in use are suggested, and applying makes them ready', async () => {
    await go('#/settings', '#setup-body .profiles');
    await see('#setup-body .notice', 'aren’t in Sonarr yet');
    const checked = await page.locator('[data-profile]:checked').evaluateAll((els) => els.map((e) => Number(e.dataset.profile)));
    assert.deepEqual(checked, [1, 4], 'the profiles the checked series use');

    await clearToasts();
    await page.click('#setup-apply');
    await toast('Applied to Anime, HD-1080p');
    await see('#setup-body .notice.info', 'are in Sonarr');
    assert.equal(await page.locator('#setup-body .ready').count(), 2);
    assert.deepEqual(sonarr.state.customFormats.map((f) => f.name).slice(1).sort(), ['Dual Audio (Dualarr)', 'Dub Only (Dualarr)']);
    assert.equal(sonarr.state.qualityProfiles.find((p) => p.id === 1).upgradeAllowed, true);
  });

  test('changing the rules rescans, and the library follows', async () => {
    await page.selectOption('#scope', 'japanese');
    await clearToasts();
    await saveSettings();
    await toast('Settings saved — rescanning with the new rules');
    await toast('Scan finished');
    await go('#/', '#lib-table');
    assert.deepEqual(await rowTitles(), ['Dandadan', 'Frieren', 'Midnight Diner', 'Mushishi', 'Old Anime']);
    assert.match(await text('[data-row="4"] .vbs'), /1/);
    // Dandadan waits for the dub since its dub-only file was replaced; Midnight Diner has no media info.
    assert.deepEqual(await texts('.tile b'), ['0', '2', '2', '1']);
  });

  test('notifiers: add, send a test, save, and remove', async () => {
    await go('#/settings', '#setup-body .profiles');
    await page.selectOption('#nt-type', 'webhook');
    await page.click('#nt-add');
    await page.fill('.notifier [data-nf="name"]', 'Home');
    await page.fill('.notifier [data-nf="url"]', `${sink.url}/hook`);
    await page.click('[data-ntest="0"]');
    await see('#nt-res-0.ok', 'Sent — check your app');
    assert.equal(sink.received.at(-1).body.event, 'test');

    await clearToasts();
    await saveSettings();
    await toast('Settings saved');
    await go('#/settings', '.notifier');
    assert.equal(await page.inputValue('.notifier [data-nf="url"]'), `${sink.url}/hook`);

    await page.click('[data-nremove="0"]');
    assert.equal(await page.locator('.notifier').count(), 0);
    await clearToasts();
    await saveSettings();
    await toast('Settings saved');
    await go('#/settings', '#settings-form');
    assert.equal(await page.locator('.notifier').count(), 0);
  });

  test('Check files: set up, test on one file, then check the library', { skip: !hasFfmpeg() && 'needs ffmpeg' }, async () => {
    // Dandadan's files as they really are: S01E02 is tagged Japanese but is the English dub.
    const ep = (id, spec) => {
      const f = sonarr.state.files.find((x) => x.id === id);
      f.size = fs.statSync(makeEpisode(path.join(MEDIA, f.relativePath), spec)).size;
    };
    ep(201, { audio: [{ sound: 'ja', tag: 'jpn' }, { sound: 'en', tag: 'eng' }], subs: [{ lang: 'en', tag: 'eng' }] });
    ep(202, { audio: [{ sound: 'en', tag: 'jpn' }], subs: [{ lang: 'en', tag: 'eng' }] });

    await go('#/settings', '#verify-status .checklist');
    assert.match(await text('#verify-status'), /whisper\.cpp installed/);
    await see('#verify-status #model-download');
    await page.check('input[name=verify]');
    await page.click('#map-add');
    await page.fill('[data-map="from"]', '/anime');
    await page.fill('[data-map="to"]', MEDIA);
    await clearToasts();
    await saveSettings();
    await toast('Settings saved');
    await see('#roots li.ok', 'is visible here');
    assert.match(await text('#roots li.bad'), /Sonarr’s \/tv isn’t visible in this container/);

    // Downloads the model the first time.
    await page.click('#verify-test');
    await see('#verify-result .test-box', 'Dandadan');
    assert.match(await text('#verify-result .test-box'), /Audio 1: Japanese \(\d+%\) tagged Japanese[\s\S]*Audio 2: English[\s\S]*Subtitles 1: English, full[\s\S]*Dual audio/);
    await see('#verify-status', 'Model base downloaded');

    await go('#/', '#verify-now');
    await clearToasts();
    await page.click('#verify-now');
    await toast('Checking files — this can take a while');
    await toast('Checking files finished'); // with warnings: most files aren't on disk
    await see('.file-counts', '2 files checked');
    await openRow(2);
    assert.equal(await text('[data-detail="2"] .detail-head > span'), '1 file without dual audio · 2 of 2 files checked');
    const row = page.locator('[data-detail="2"] table.files tbody tr');
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /Audio 1 is tagged Japanese but sounds English[\s\S]*No Japanese audio[\s\S]*checked/);
    assert.equal(await row.locator('[data-replace="2"]').count(), 1, 'what the check found can be replaced');

    // A series' own button checks its files again.
    await clearToasts();
    await page.click('[data-verify="2"]');
    await toast('Checking files finished');
  });

  test('Replace automatically: on in Settings, the next check replaces the English-only file', { skip: !hasFfmpeg() && 'needs ffmpeg' }, async () => {
    await go('#/settings', '#verify-status .checklist');
    await page.check('input[name=autoReplace]');
    await page.fill('input[name=autoReplacePerRun]', '5');
    await clearToasts();
    await saveSettings();
    await toast('Settings saved');
    assert.equal(await page.isChecked('input[name=autoReplace]'), true, 'kept after the page reloads');
    assert.equal(await page.inputValue('input[name=autoReplacePerRun]'), '5');

    await go('#/', '#verify-now');
    await openRow(2);
    await clearToasts();
    await page.click('[data-verify="2"]');
    await toast('Checking files finished');
    assert.ok(sonarr.state.deleted.includes(202), 'S01E02 (tagged Japanese, sounds English) was deleted');
    await go('#/activity', '.table');
    await see('.run-lines', 'Replaced Dandadan — Dandadan - S01E02.mkv: no Japanese audio. Sonarr is searching again.');
  });

  test('Activity lists every job and what it did', async () => {
    await go('#/activity', '.table');
    const what = await texts('.table tbody tr td:nth-child(2)');
    for (const w of ['Scan', 'Search', 'Replace', 'Sonarr setup', 'Rescan (rules)']) assert.ok(what.includes(w), `${w} is listed`);
    const results = await page.locator('.st').evaluateAll((els) => els.map((e) => e.textContent));
    assert.deepEqual(results.filter((r) => !['ok', 'partial'].includes(r)), [], 'nothing failed');
    await see('.run-lines', 'Dandadan: deleted 1 file, blocklisted 1, searching 1 episode');
    await see('.run-lines', 'Scores applied to Anime, HD-1080p');
    if (hasFfmpeg()) await see('.run-lines', 'Dandadan — Dandadan - S01E02.mkv: Audio 1 is tagged Japanese but sounds English');
  });

  test('fits a phone screen: no sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const [hash, ready] of [['#/', '#lib-table'], ['#/settings', '#setup-body .profiles'], ['#/activity', '.table']]) {
        await go(hash, ready);
        const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        assert.ok(scroll <= width, `${hash} is ${scroll}px wide on a ${width}px screen`);
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  test('an updated Dualarr reloads the page', async () => {
    await go('#/', '#lib-table');
    await page.route('**/api/runs', async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, headers: { ...res.headers(), 'x-dualarr-build': 'newer' } });
    }, { times: 1 });
    await clearToasts();
    const reloaded = page.waitForEvent('load');
    await page.click('[data-nav="activity"]');
    await toast('Dualarr was updated — reloading…');
    await reloaded;
    await see('.table');
  });

  test('a session that ends goes back to the login, and logging out works', async () => {
    await context.clearCookies();
    await page.click('[data-nav="library"]');
    await see('#lg-error', 'Your session ended — please log in again.');

    await page.fill('#lg-user', USER);
    await page.fill('#lg-pass', 'not it');
    await page.click('#login-form button[type=submit]');
    await page.waitForFunction(() => document.getElementById('lg-error').textContent && !/session ended/.test(document.getElementById('lg-error').textContent));
    assert.equal(await page.locator('#lib-table').count(), 0);

    await page.fill('#lg-pass', PASS);
    await page.click('#login-form button[type=submit]');
    await see('#lib-table');

    await page.click('#logout');
    await see('#lg-error', 'You have been logged out.');
    await page.goto(`${C}/#/settings`);
    await see('#login-form');
  });

  test('no script errors along the way', () => {
    assert.deepEqual(errors, []);
  });
});
