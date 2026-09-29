// Checking a file itself instead of trusting its language tags: ffmpeg cuts a few clips from each
// audio track and whisper.cpp says which language is spoken; the subtitle tracks are read to
// see their language and whether they are full dialogue or only signs & songs.
// whisper.cpp runs on the CPU, or on a GPU through its CUDA (NVIDIA) or Vulkan (Intel, AMD,
// NVIDIA) backend, depending on the Docker image.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { CONFIG_DIR, log } from './config.js';
import * as rules from './rules.js';

export const BIN = {
  ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
  whisper: process.env.WHISPER_BIN || 'whisper-cli',
};
/** Which GPU backend the Docker image was built with: 'cuda', 'vulkan', or null outside Docker. */
export const IMAGE_GPU = process.env.DUALARR_GPU || null;

// Multilingual models only: the English-only ones can't tell languages apart.
export const MODELS = {
  tiny: { label: 'Tiny (75 MB)', bytes: 77_691_713 },
  base: { label: 'Base (142 MB)', bytes: 147_951_465 },
  small: { label: 'Small (466 MB)', bytes: 487_601_967 },
};
const MODEL_URL = (process.env.WHISPER_MODEL_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main').replace(/\/+$/, '');
export const modelPath = (name) => path.join(CONFIG_DIR, 'models', `ggml-${name}.bin`);

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** Runs a program; resolves { code, stdout, stderr } (never rejects on a non-zero exit). */
export function run(cmd, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    // whisper and ffmpeg can be chatty; the end of the log is what matters.
    child.stderr.on('data', (d) => (err = (err + d).slice(-500_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${path.basename(cmd)} is not installed`) : e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? `killed (${signal}${signal === 'SIGKILL' ? ', timed out' : ''})` : code, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}

const lastLines = (text, n = 3) => text.trim().split('\n').slice(-n).join(' | ');
async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${path.basename(cmd)} failed (${r.code}): ${lastLines(r.stderr) || 'no output'}`);
  return r;
}

// ---------- tools & devices ----------

/**
 * The GPUs whisper.cpp's backends report while loading. Their order is the order of `-dev N`:
 * CUDA devices before Vulkan ones. Software renderers (Mesa's llvmpipe) are marked: they are
 * slower than the CPU backend.
 */
export function parseDevices(log) {
  const devices = new Map();
  for (const m of log.matchAll(/^\s*Device (\d+): ([^,\n]+), compute capability ([\d.]+)(?:.*VRAM: (\d+) MiB)?/gm)) {
    devices.set(`CUDA${m[1]}`, { name: m[2].trim(), backend: 'CUDA', detail: `compute ${m[3]}${m[4] ? `, ${m[4]} MiB` : ''}` });
  }
  for (const m of log.matchAll(/^ggml_vulkan: (\d+) = (.+?)(?: \(([^)]*)\))? \|/gm)) {
    devices.set(`Vulkan${m[1]}`, { name: m[2].trim(), backend: 'Vulkan', detail: m[3] || '' });
  }
  return [...devices].map(([id, d], index) => ({ id, ...d, index, software: /llvmpipe|lavapipe|swiftshader/i.test(`${d.name} ${d.detail}`) }));
}

let toolCache = null;

/** What is installed: ffmpeg, ffprobe, whisper-cli and the GPUs whisper can use. Cached. */
export async function tools({ refresh = false } = {}) {
  if (toolCache && !refresh) return toolCache;
  const version = async (bin) => {
    try {
      const r = await run(bin, ['-version'], { timeout: 15_000 });
      return r.code === 0 ? r.stdout.split('\n')[0].replace(/ Copyright.*/, '').trim() : null;
    } catch {
      return null;
    }
  };
  let whisper = null;
  let devices = [];
  try {
    // -h still loads every backend, and each logs the devices it found.
    const r = await run(BIN.whisper, ['-h'], { timeout: 60_000 });
    const all = `${r.stdout}\n${r.stderr}`;
    if (/usage: .*\[options\] file0/.test(all)) {
      whisper = process.env.WHISPER_VERSION || 'installed';
      devices = parseDevices(all);
    }
  } catch {
    /* not installed */
  }
  toolCache = { ffmpeg: await version(BIN.ffmpeg), ffprobe: await version(BIN.ffprobe), whisper, devices, gpu: IMAGE_GPU };
  return toolCache;
}

/**
 * The whisper-cli arguments for the chosen device: 'cpu', 'gpu:N', or 'auto' (the first real GPU,
 * else the CPU). A GPU that isn't there any more falls back to the CPU.
 */
export function deviceArgs(choice, devices) {
  const cpu = { args: ['-ng'], label: 'CPU' };
  if (choice === 'cpu') return cpu;
  const m = /^gpu:(\d+)$/.exec(choice || '');
  const d = m ? devices.find((x) => x.index === Number(m[1])) : devices.find((x) => !x.software);
  return d ? { args: ['-dev', String(d.index)], label: `${d.name} (${d.backend})` } : cpu;
}

// ---------- the model ----------

let download = null; // { model, received, total, error, done }
export const downloadState = () => download && { model: download.model, received: download.received, total: download.total, error: download.error || null, done: !!download.done };

/** Checks a model file really is a whisper.cpp model (not an HTML error page). */
function isModel(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.readUInt32LE(0) === 0x67676d6c; // "ggml"
  } catch {
    return false;
  }
}

export function modelInfo(name) {
  const file = modelPath(name);
  const present = fs.existsSync(file) && isModel(file);
  return { name, file, present, bytes: present ? fs.statSync(file).size : 0 };
}

/** Downloads a model into /config/models (once; callers share the download in progress). */
export function downloadModel(name) {
  if (!MODELS[name]) return Promise.reject(new Error(`Unknown model "${name}"`));
  if (download?.promise && !download.done && download.model === name) return download.promise;
  const file = modelPath(name);
  const part = `${file}.part`;
  const state = { model: name, received: 0, total: MODELS[name].bytes, error: null, done: false };
  download = state;
  state.promise = (async () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const res = await fetch(`${MODEL_URL}/ggml-${name}.bin`, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading the ${name} model`);
      state.total = Number(res.headers.get('content-length')) || state.total;
      const out = fs.createWriteStream(part);
      for await (const chunk of res.body) {
        state.received += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
      if (!isModel(part)) throw new Error('The download is not a whisper.cpp model');
      fs.renameSync(part, file);
      log(`Downloaded the whisper ${name} model (${(state.received / 1e6).toFixed(0)} MB)`);
      return file;
    } catch (e) {
      state.error = e.message;
      fs.rmSync(part, { force: true });
      throw e;
    } finally {
      state.done = true;
    }
  })();
  return state.promise;
}

export async function ensureModel(name) {
  const info = modelInfo(name);
  return info.present ? info.file : downloadModel(name);
}

// ---------- paths ----------

const trimSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

/**
 * Sonarr's path for a file -> the same file inside this container, through the longest matching
 * mapping ({ from: Sonarr's folder, to: Dualarr's }). Unmapped paths are used as they are.
 */
export function mapPath(p, mappings = []) {
  const norm = (x) => trimSlash(String(x).replace(/\\/g, '/'));
  const file = String(p).replace(/\\/g, '/');
  const hit = mappings
    .map((m) => ({ from: norm(m.from), to: norm(m.to) }))
    .filter((m) => m.from && (file === m.from || file.startsWith(m.from === '/' ? '/' : `${m.from}/`)))
    .sort((a, b) => b.from.length - a.from.length)[0];
  if (!hit) return file;
  const rest = file.slice(hit.from === '/' ? 1 : hit.from.length).replace(/^\//, '');
  return rest ? `${hit.to === '/' ? '' : hit.to}/${rest}` : hit.to;
}

// ---------- checking a file ----------

/** ffprobe's view of a file: its duration and streams. */
async function probe(file) {
  const r = await runOk(BIN.ffprobe, [
    '-v', 'error', '-show_entries',
    'format=duration:stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=forced',
    '-of', 'json', file,
  ], { timeout: 60_000 });
  const j = JSON.parse(r.stdout || '{}');
  return { duration: Number(j.format?.duration) || 0, streams: j.streams || [] };
}

/**
 * Parses whisper-cli's log: the language it detected for each input file, and the backend it used.
 * Each file's "processing '<file>'" line comes before its "auto-detected language" line.
 */
export function parseWhisper(logText) {
  const langs = new Map();
  let current = null;
  for (const line of logText.split('\n')) {
    const p = line.match(/processing '(.+?)' \(/);
    if (p) current = p[1];
    const d = line.match(/auto-detected language: (\w+) \(p = ([\d.]+)\)/);
    if (d && current) langs.set(current, { lang: d[1], p: Number(d[2]) });
  }
  return { langs, backend: logText.match(/using (\S+) backend/)?.[1] || null };
}

/** Detects the spoken language of each clip (one whisper-cli run, so the model loads once). */
async function detect(clips, model, device) {
  const args = ['-m', model, '-dl', '-t', String(Math.min(os.availableParallelism(), 8)), ...device.args];
  for (const c of clips) args.push('-f', c);
  const r = await run(BIN.whisper, args, { timeout: 600_000 });
  const parsed = parseWhisper(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 && !parsed.langs.size) throw new Error(`whisper-cli failed (${r.code}): ${lastLines(r.stderr)}`);
  return parsed;
}

/** Reads every subtitle track: its text language and how much dialogue it has. */
async function readSubtitles(file, streams, duration, tmp) {
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  if (!subs.length) return [];
  const texts = subs.map((s, i) => (TEXT_SUBS.has(s.codec_name) ? path.join(tmp, `s${i}.srt`) : null));
  if (texts.some(Boolean)) {
    const args = ['-nostdin', '-v', 'error', '-i', file];
    texts.forEach((out, i) => out && args.push('-map', `0:s:${i}`, '-c:s', 'srt', '-f', 'srt', '-y', out));
    await runOk(BIN.ffmpeg, args, { timeout: 900_000 });
  }
  // Picture-based subtitles (Blu-ray PGS, DVD) can't be read, but their events can be counted.
  let packets = new Map();
  if (subs.some((s) => BITMAP_SUBS.has(s.codec_name))) {
    const r = await runOk(BIN.ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 's', '-show_entries', 'stream=index,nb_read_packets', '-of', 'json', file], { timeout: 900_000 });
    packets = new Map((JSON.parse(r.stdout || '{}').streams || []).map((s) => [s.index, Number(s.nb_read_packets) || 0]));
  }
  return subs.map((s, i) => {
    const base = { track: i + 1, tag: rules.langs(s.tags?.language)[0] || null, codec: s.codec_name, title: s.tags?.title || '' };
    const forced = s.disposition?.forced === 1;
    if (texts[i]) {
      const cues = rules.parseSrt(fs.existsSync(texts[i]) ? fs.readFileSync(texts[i], 'utf8') : '');
      const rate = rules.dialogueRate(cues, duration);
      return { ...base, lang: rules.textLanguage(cues.map((c) => c.text).join('\n')), ...rate, kind: rules.subtitleKind({ title: base.title, forced }, rate.perMin) };
    }
    // A picture subtitle event is about two packets (show, then clear).
    const events = packets.has(s.index) ? Math.round(packets.get(s.index) / 2) : null;
    const perMin = events !== null && duration > 0 ? Math.round((events / (duration / 60)) * 10) / 10 : null;
    return { ...base, lang: null, lines: events, perMin, kind: rules.subtitleKind({ title: base.title, forced }, perMin) };
  });
}

/**
 * Checks one file: which language each audio track really speaks, and what each subtitle track
 * really is. `opts`: { model (file), device (from deviceArgs), subtitles (read them or not) }.
 */
export async function checkFile(file, opts) {
  const t0 = Date.now();
  const { duration, streams } = await probe(file);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarr-'));
  try {
    const clips = []; // [trackIndex, wav]
    for (const [k, start] of rules.clipStarts(duration).entries()) {
      // One seek per position, every audio track out of it: 16 kHz mono WAV is what whisper wants.
      const args = ['-nostdin', '-v', 'error', '-ss', String(start), '-t', String(rules.CLIP_SECONDS), '-i', file];
      audio.forEach((_, i) => {
        const out = path.join(tmp, `a${i}-${k}.wav`);
        args.push('-map', `0:a:${i}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', out);
        clips.push([i, out]);
      });
      if (audio.length) await runOk(BIN.ffmpeg, args, { timeout: 120_000 });
    }
    const heard = clips.length ? await detect(clips.map((c) => c[1]), opts.model, opts.device) : { langs: new Map(), backend: null };
    const audioResults = audio.map((s, i) => ({
      track: i + 1,
      tag: rules.langs(s.tags?.language)[0] || null,
      ...rules.audioLanguage(clips.filter((c) => c[0] === i).map((c) => heard.langs.get(c[1]) || null)),
    }));
    const subs = opts.subtitles === false ? [] : await readSubtitles(file, streams, duration, tmp);
    return {
      audio: audioResults,
      subs,
      subsChecked: opts.subtitles !== false,
      duration: Math.round(duration),
      device: heard.backend || 'CPU',
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
