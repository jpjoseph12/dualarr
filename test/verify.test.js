// Checking files: parsing whisper.cpp and ffmpeg, choosing the device, mapping paths, the model
// download, and checking real (generated) episodes with ffmpeg and a stand-in whisper-cli.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { hasFfmpeg, makeEpisode } from './fixtures/media.mjs';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-verify-'));
process.env.CONFIG_DIR = CONFIG_DIR;
const FAKE_WHISPER = new URL('./fixtures/fake-whisper.mjs', import.meta.url).pathname;
process.env.WHISPER_BIN = FAKE_WHISPER;

// A stand-in for Hugging Face: real-looking models, an error page, and a 404.
let hits = 0;
const models = http.createServer((req, res) => {
  hits++;
  if (req.url.endsWith('ggml-tiny.bin')) {
    const body = Buffer.concat([Buffer.from('lmgg'), Buffer.alloc(100_000, 1)]);
    res.writeHead(200, { 'Content-Length': body.length });
    // Two chunks, a moment apart, so progress can be seen.
    res.write(body.subarray(0, 50_000));
    setTimeout(() => res.end(body.subarray(50_000)), 50);
  } else if (req.url.endsWith('ggml-base.bin')) {
    res.end('<html>Rate limited</html>');
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => models.listen(0, r));
process.env.WHISPER_MODEL_URL = `http://127.0.0.1:${models.address().port}/`;

const verify = await import('../server/verify.js');
const rules = await import('../server/rules.js');
after(() => models.close());

const NVIDIA = `ggml_cuda_init: found 1 CUDA devices (Total VRAM: 4038 MiB):
  Device 0: NVIDIA GeForce GTX 1050 Ti, compute capability 6.1, VMM: yes, VRAM: 4038 MiB
load_backend: loaded CUDA backend from /opt/whisper/libggml-cuda.so`;

describe('devices', () => {
  test('parseDevices reads CUDA and Vulkan devices, in -dev order', () => {
    const devs = verify.parseDevices(`${NVIDIA}
  Device 0: NVIDIA GeForce GTX 1050 Ti
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = Intel(R) UHD Graphics 630 (CML GT2) (Intel open-source Mesa driver) | uma: 1 | fp16: 1
ggml_vulkan: 1 = llvmpipe (LLVM 20.1.2, 256 bits) (llvmpipe) | uma: 0 | fp16: 1`);
    assert.deepEqual(devs, [
      { id: 'CUDA0', name: 'NVIDIA GeForce GTX 1050 Ti', backend: 'CUDA', detail: 'compute 6.1, 4038 MiB', index: 0, software: false },
      { id: 'Vulkan0', name: 'Intel(R) UHD Graphics 630 (CML GT2)', backend: 'Vulkan', detail: 'Intel open-source Mesa driver', index: 1, software: false },
      { id: 'Vulkan1', name: 'llvmpipe (LLVM 20.1.2, 256 bits)', backend: 'Vulkan', detail: 'llvmpipe', index: 2, software: true },
    ]);
    assert.deepEqual(verify.parseDevices('ggml_vulkan: No devices found.\nload_backend: loaded CPU backend'), []);
    assert.equal(verify.parseDevices('  Device 0: Old GPU, compute capability 5.0, VMM: no')[0].detail, 'compute 5.0');
  });

  test('deviceArgs: auto skips software renderers; a missing GPU falls back to the CPU', () => {
    const devs = verify.parseDevices(`ggml_vulkan: 0 = llvmpipe (LLVM) (llvmpipe) | x\nggml_vulkan: 1 = AMD Radeon 780M (RADV) | x`);
    assert.deepEqual(verify.deviceArgs('auto', devs), { args: ['-dev', '1'], label: 'AMD Radeon 780M (Vulkan)' });
    assert.deepEqual(verify.deviceArgs('gpu:0', devs), { args: ['-dev', '0'], label: 'llvmpipe (LLVM) (Vulkan)' }, 'asked for by name');
    assert.deepEqual(verify.deviceArgs('cpu', devs), { args: ['-ng'], label: 'CPU' });
    assert.deepEqual(verify.deviceArgs('gpu:5', devs), { args: ['-ng'], label: 'CPU' });
    assert.deepEqual(verify.deviceArgs('auto', devs.slice(0, 1)), { args: ['-ng'], label: 'CPU' });
    assert.deepEqual(verify.deviceArgs(undefined, []), { args: ['-ng'], label: 'CPU' });
  });

  test('tools: versions, whisper and its GPUs (cached until refreshed)', async () => {
    process.env.FAKE_GPU = 'NVIDIA GeForce GTX 1050 Ti';
    const t = await verify.tools({ refresh: true });
    assert.deepEqual([t.whisper, t.devices.map((d) => d.id), t.gpu], ['installed', ['Vulkan0'], null]);
    if (hasFfmpeg()) assert.match(t.ffmpeg, /^ffmpeg version /);
    delete process.env.FAKE_GPU;
    assert.equal((await verify.tools()).devices.length, 1, 'cached');
    assert.equal((await verify.tools({ refresh: true })).devices.length, 0);

    const bins = { ...verify.BIN };
    try {
      Object.assign(verify.BIN, { ffmpeg: '/nonexistent/ffmpeg', whisper: '/nonexistent/whisper-cli' });
      const none = await verify.tools({ refresh: true });
      assert.deepEqual([none.ffmpeg, none.whisper, none.devices], [null, null, []]);
      Object.assign(verify.BIN, { ffmpeg: process.execPath, whisper: process.execPath });
      const wrong = await verify.tools({ refresh: true });
      assert.deepEqual([wrong.ffmpeg, wrong.whisper], [null, null], 'a program that isn’t ffmpeg or whisper-cli');
    } finally {
      Object.assign(verify.BIN, bins);
      await verify.tools({ refresh: true });
    }
  });
});

describe('running programs', () => {
  test('a missing program and a timeout', async () => {
    await assert.rejects(verify.run('/nonexistent/prog', []), /prog is not installed/);
    await assert.rejects(verify.run(os.tmpdir(), []), /EACCES/);
    const slow = await verify.run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 100 });
    assert.equal(slow.code, 'killed (SIGKILL, timed out)');
    const r = await verify.run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)']);
    assert.deepEqual(r, { code: 2, stdout: 'out', stderr: 'err' });
  });

  test('parseWhisper pairs each file with its language, and finds the backend', () => {
    const log = `${NVIDIA}
whisper_backend_init_gpu: using CUDA0 backend
main: processing '/tmp/a 1.wav' (480000 samples, 30.0 sec), 4 threads ...
whisper_full_with_state: auto-detected language: ja (p = 0.971234)
error: failed to read audio file '/tmp/b.wav'
main: processing '/tmp/c.wav' (480000 samples, 30.0 sec), 4 threads ...
whisper_full_with_state: auto-detected language: en (p = 0.5)`;
    const r = verify.parseWhisper(log);
    assert.deepEqual([...r.langs], [['/tmp/a 1.wav', { lang: 'ja', p: 0.971234 }], ['/tmp/c.wav', { lang: 'en', p: 0.5 }]]);
    assert.equal(r.backend, 'CUDA0');
    assert.equal(verify.parseWhisper('whisper_backend_init_gpu: no GPU found').backend, null);
  });
});

describe('paths', () => {
  test('mapPath uses the longest matching mapping', () => {
    const maps = [{ from: '/tv', to: '/media/tv' }, { from: '/tv/anime/', to: '/anime' }, { from: 'D:\\Anime', to: '/win' }];
    assert.equal(verify.mapPath('/tv/anime/Frieren/S01E01.mkv', maps), '/anime/Frieren/S01E01.mkv');
    assert.equal(verify.mapPath('/tv/Show/S01E01.mkv', maps), '/media/tv/Show/S01E01.mkv');
    assert.equal(verify.mapPath('/tvx/Show.mkv', maps), '/tvx/Show.mkv', 'only whole folder names');
    assert.equal(verify.mapPath('D:\\Anime\\Frieren\\S01E01.mkv', maps), '/win/Frieren/S01E01.mkv');
    assert.equal(verify.mapPath('/tv', maps), '/media/tv');
    assert.equal(verify.mapPath('/data/x.mkv', [{ from: '/', to: '/host' }]), '/host/data/x.mkv');
    assert.equal(verify.mapPath('/data/x.mkv', [{ from: '/data', to: '/' }]), '/x.mkv');
    assert.equal(verify.mapPath('/data/x.mkv'), '/data/x.mkv');
  });
});

describe('the model', () => {
  test('downloads once into /config/models, with progress', async () => {
    assert.equal(verify.modelInfo('tiny').present, false);
    const a = verify.downloadModel('tiny');
    const b = verify.downloadModel('tiny');
    assert.equal(a, b, 'one download at a time');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(verify.downloadState().done, false);
    assert.equal(await a, path.join(CONFIG_DIR, 'models', 'ggml-tiny.bin'));
    assert.deepEqual(verify.downloadState(), { model: 'tiny', received: 100_004, total: 100_004, error: null, done: true });
    assert.deepEqual(verify.modelInfo('tiny'), { name: 'tiny', file: path.join(CONFIG_DIR, 'models', 'ggml-tiny.bin'), present: true, bytes: 100_004 });
    const before = hits;
    assert.equal(await verify.ensureModel('tiny'), path.join(CONFIG_DIR, 'models', 'ggml-tiny.bin'));
    assert.equal(hits, before, 'not downloaded again');
  });

  test('an error page or a 404 is not a model', async () => {
    await assert.rejects(verify.ensureModel('base'), /not a whisper.cpp model/);
    assert.equal(verify.downloadState().error, 'The download is not a whisper.cpp model');
    assert.ok(!fs.existsSync(path.join(CONFIG_DIR, 'models', 'ggml-base.bin.part')), 'no partial file left');
    await assert.rejects(verify.downloadModel('small'), /HTTP 404 downloading the small model/);
    await assert.rejects(verify.downloadModel('large'), /Unknown model "large"/);
  });
});

describe('checking a file', { skip: !hasFfmpeg() && 'needs ffmpeg' }, () => {
  const dir = path.join(CONFIG_DIR, 'media');
  let model;
  before(async () => {
    model = await verify.ensureModel('tiny');
  });
  const opts = () => ({ model, device: verify.deviceArgs('auto', []) });

  test('hears every audio track and reads every subtitle track', async () => {
    const file = makeEpisode(path.join(dir, 'dual.mkv'), {
      audio: [{ sound: 'ja', tag: 'jpn' }, { sound: 'en', tag: 'jpn' }],
      subs: [{ lang: 'en', tag: 'eng' }, { lang: 'en', tag: 'eng', kind: 'signs' }, { lang: 'es', tag: 'eng', title: 'Castellano' }],
    });
    const r = await verify.checkFile(file, opts());
    assert.deepEqual(r.audio, [{ track: 1, tag: 'ja', lang: 'ja', p: 0.97 }, { track: 2, tag: 'ja', lang: 'en', p: 0.95 }]);
    assert.deepEqual(r.subs.map((s) => [s.track, s.tag, s.lang, s.kind, s.codec]), [[1, 'en', 'en', 'full', 'ass'], [2, 'en', null, 'signs', 'ass'], [3, 'en', 'es', 'full', 'ass']]);
    assert.ok(r.subs[0].perMin > 10 && r.subs[1].perMin < 3, JSON.stringify(r.subs));
    assert.deepEqual([r.duration, r.device], [120, 'CPU']);
    assert.ok(r.seconds >= 0);
    const verdict = rules.classifyFile({ id: 1, size: 1, mediaInfo: { audioLanguages: 'jpn/jpn', subtitles: 'eng/eng/eng' } }, {}, { ...r, size: 1 });
    assert.deepEqual([verdict.status, verdict.notes], ['dual', ['Audio 2 is tagged Japanese but sounds English', 'Subtitles 2 (English) are signs & songs only', 'Subtitles 3 are tagged English but read as Spanish']]);
  });

  test('on the GPU when there is one; subtitles can be skipped; short files get one clip', async () => {
    process.env.FAKE_GPU = 'NVIDIA GeForce GTX 1050 Ti';
    const t = await verify.tools({ refresh: true });
    delete process.env.FAKE_GPU;
    const file = makeEpisode(path.join(dir, 'short.mkv'), { audio: [{ sound: 'en' }], subs: [{ lang: 'en' }], duration: 40 });
    process.env.FAKE_GPU = 'NVIDIA GeForce GTX 1050 Ti';
    const r = await verify.checkFile(file, { model, device: verify.deviceArgs('auto', t.devices), subtitles: false });
    delete process.env.FAKE_GPU;
    assert.deepEqual([r.device, r.subs, r.subsChecked, r.audio], ['Vulkan0', [], false, [{ track: 1, tag: null, lang: 'en', p: 0.95 }]]);
  });

  test('a file without audio or subtitles', async () => {
    const file = makeEpisode(path.join(dir, 'silent.mkv'), {});
    assert.deepEqual((await verify.checkFile(file, opts())).audio, []);
  });

  test('failures say what failed', async () => {
    const junk = path.join(dir, 'junk.mkv');
    fs.writeFileSync(junk, 'not a video');
    await assert.rejects(verify.checkFile(junk, opts()), /^Error: ffprobe failed \(1\): .*Invalid data/);
    const file = makeEpisode(path.join(dir, 'ok.mkv'), { audio: [{ sound: 'ja' }] });
    await assert.rejects(verify.checkFile(file, { ...opts(), model: '/nonexistent/model.bin' }), /whisper-cli failed \(3\): .*failed to open/);
  });
});

describe('picture subtitles', () => {
  test('are counted, not read', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-pgs-'));
    // A stand-in ffprobe for a Blu-ray rip: PGS tracks can't be made with ffmpeg.
    const probe = path.join(tmp, 'ffprobe');
    fs.writeFileSync(probe, `#!/usr/bin/env node
const a = process.argv.slice(2);
const s = (index, lang, title) => ({ index, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: lang, title }, disposition: { forced: 0 } });
console.log(JSON.stringify(a.includes('-count_packets')
  ? { streams: [{ index: 2, nb_read_packets: '700' }, { index: 3, nb_read_packets: '40' }] }
  : { format: { duration: '1440.0' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, s(2, 'eng', ''), s(3, 'eng', ''), { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }] }));
`, { mode: 0o755 });
    const bins = { ...verify.BIN };
    verify.BIN.ffprobe = probe;
    try {
      const r = await verify.checkFile(path.join(tmp, 'bd.m2ts'), { model: 'x', device: { args: ['-ng'] } });
      assert.deepEqual(r.subs.map((x) => [x.track, x.tag, x.lang, x.lines, x.perMin, x.kind]), [[1, 'en', null, 350, 14.6, 'full'], [2, 'en', null, 20, 0.8, 'signs'], [3, null, null, null, null, 'full']]);
      assert.deepEqual(r.audio, []);
    } finally {
      Object.assign(verify.BIN, bins);
    }
  });
});
