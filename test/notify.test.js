// Notification messages, the request each service gets, and sending to a local receiver.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { startSink } from './fixtures/sink.mjs';

// notify.js loads config.js, which creates CONFIG_DIR (default /config: not writable on CI).
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-notify-'));
const { message, notifyAll, request, send } = await import('../server/notify.js');

let sink;
before(async () => {
  sink = await startSink();
});
after(() => (sink.server.closeAllConnections?.(), sink.server.close()));

const upgraded = { kind: 'upgraded', series: [{ title: 'Frieren', files: 2 }, { title: 'Dandadan', files: 1 }] };
const problems = { kind: 'problems', series: [{ title: 'Mushishi', noJapanese: 1, noSubs: 0 }, { title: 'Dandadan', noJapanese: 1, noSubs: 3 }] };

describe('messages', () => {
  test('one per event', () => {
    assert.deepEqual(message(upgraded), { title: 'Dual audio: 3 files upgraded', text: 'Frieren (2 files)\nDandadan (1 file)', color: 0x4ade80 });
    assert.deepEqual(message(problems), {
      title: 'Dualarr: 2 series need attention',
      text: 'Mushishi: 1 without Japanese audio\nDandadan: 1 without Japanese audio, 3 without subtitles',
      color: 0xfbbf24,
    });
    assert.equal(message({ kind: 'problems', series: [problems.series[0]] }).title, 'Dualarr: 1 series needs attention');
    assert.deepEqual(message({ kind: 'error', error: 'boom' }), { title: 'Dualarr: scan failed', text: 'boom', color: 0xf87171 });
    assert.equal(message({ kind: 'test' }).text, 'Notifications are working.');
  });

  test('original-only series name their language', () => {
    const zh = { kind: 'upgraded', series: [{ title: 'Link Click', files: 2, mode: 'original', lang: 'zh' }] };
    assert.equal(message(zh).title, 'Chinese audio: 2 files upgraded');
    const two = { kind: 'upgraded', series: [...zh.series, { title: 'Mushishi', files: 1, mode: 'original' }] };
    assert.equal(message(two).title, 'Original audio: 3 files upgraded');
    const mixed = { kind: 'upgraded', series: [...zh.series, { title: 'Frieren', files: 1, mode: 'dual' }] };
    assert.deepEqual([message(mixed).title, message(mixed).text], ['Dual audio: 3 files upgraded', 'Link Click (2 files, Chinese only)\nFrieren (1 file)']);
    const bad = { kind: 'problems', series: [{ title: 'Link Click', noJapanese: 1, noSubs: 0, dualAudio: 2, lang: 'zh' }] };
    assert.equal(message(bad).text, 'Link Click: 1 without Chinese audio, 2 with dual audio (Chinese only)');
  });

  test('long lists are clipped', () => {
    const series = Array.from({ length: 25 }, (_, i) => ({ title: `Show ${i}`, files: 1 }));
    const m = message({ kind: 'upgraded', series });
    assert.equal(m.text.split('\n').length, 21);
    assert.match(m.text, /…and 5 more$/);
  });
});

describe('requests', () => {
  test('Discord, Telegram, Gotify and webhooks get JSON', () => {
    const d = request({ type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/x' }, upgraded);
    assert.equal(d.body.embeds[0].title, 'Dual audio: 3 files upgraded');
    const t = request({ type: 'telegram', botToken: 'T', chatId: '42' }, { kind: 'error', error: '<b>' });
    assert.equal(t.url, 'https://api.telegram.org/botT/sendMessage');
    assert.equal(t.body.text, '<b>Dualarr: scan failed</b>\n&lt;b&gt;');
    const g = request({ type: 'gotify', server: 'http://g/', token: 'a b' }, problems);
    assert.deepEqual([g.url, g.body.priority], ['http://g/message?token=a%20b', 7]);
    assert.equal(request({ type: 'gotify', server: 'http://g', token: 't' }, upgraded).body.priority, 4);
    const w = request({ type: 'webhook', url: 'http://w' }, upgraded);
    assert.deepEqual(w.body, { event: 'upgraded', title: 'Dual audio: 3 files upgraded', ...upgraded });
    assert.throws(() => request({ type: 'pigeon' }, upgraded), /Unknown notifier type pigeon/);
  });

  test('ntfy gets text, with ASCII-only headers', () => {
    const n = request({ type: 'ntfy', topic: 'my topic', token: 'tk' }, upgraded);
    assert.equal(n.url, 'https://ntfy.sh/my%20topic');
    assert.deepEqual([n.raw, n.headers.Title, n.headers.Tags, n.headers.Authorization], ['Frieren (2 files)\nDandadan (1 file)', 'Dual audio: 3 files upgraded', 'tada', 'Bearer tk']);
    const t = request({ type: 'ntfy', server: 'http://n/', topic: 't' }, { kind: 'test' });
    assert.deepEqual([t.url, t.headers.Tags, 'Authorization' in t.headers], ['http://n/t', 'tv', false]);
    const e = request({ type: 'ntfy', topic: 't' }, { kind: 'problems', series: [{ title: 'Shōgun', noJapanese: 1 }] });
    assert.equal(e.headers.Tags, 'warning');
    // Text that isn't ASCII goes in the body, never a header.
    assert.deepEqual([e.raw, e.headers.Title], ['Shōgun: 1 without Japanese audio', 'Dualarr: 1 series needs attention']);
  });
});

describe('sending', () => {
  test('webhook and ntfy reach the receiver', async () => {
    sink.received.length = 0;
    await send({ type: 'webhook', url: `${sink.url}/hook` }, upgraded);
    await send({ type: 'ntfy', server: sink.url, topic: 'dualarr' }, { kind: 'test' });
    assert.equal(sink.received[0].body.event, 'upgraded');
    assert.deepEqual([sink.received[1].url, sink.received[1].body, sink.received[1].headers.title], ['/dualarr', 'Notifications are working.', 'Dualarr test']);
  });

  test('failures are reported, never thrown; disabled notifiers are skipped', async () => {
    sink.received.length = 0;
    sink.fail = true;
    await assert.rejects(send({ type: 'ntfy', server: sink.url, topic: 'x' }, upgraded), /HTTP 500/);
    await assert.rejects(send({ type: 'webhook' }, upgraded), /missing its URL/);
    const failures = await notifyAll(
      [
        { type: 'webhook', name: 'Mine', url: `${sink.url}/a` },
        { type: 'webhook', url: `${sink.url}/b` },
        { type: 'webhook', url: `${sink.url}/c`, enabled: false },
      ],
      upgraded,
    );
    sink.fail = false;
    assert.equal(failures.length, 2);
    assert.match(failures[0], /^Mine: HTTP 500/);
    assert.match(failures[1], /^Webhook \(JSON\): HTTP 500/);
    assert.deepEqual(sink.received.map((r) => r.url), ['/x', '/a', '/b']);
    assert.deepEqual(await notifyAll([{ type: 'webhook', url: `${sink.url}/d` }], upgraded), []);
  });
});
