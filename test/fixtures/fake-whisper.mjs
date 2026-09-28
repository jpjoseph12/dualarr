#!/usr/bin/env node
// Stands in for whisper.cpp's whisper-cli in tests. A clip's "language" is its tone: test episodes
// use 440 Hz for Japanese and 880 Hz for English (see media.mjs). The log lines match the real
// ones. FAKE_GPU=<name> pretends a Vulkan GPU is there.
import fs from 'node:fs';

const args = process.argv.slice(2);
const gpu = process.env.FAKE_GPU;
const err = (s) => process.stderr.write(`${s}\n`);

if (gpu) {
  err('ggml_vulkan: Found 1 Vulkan devices:');
  err(`ggml_vulkan: 0 = ${gpu} (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32`);
}
err('load_backend: loaded CPU backend from /opt/whisper/libggml-cpu-haswell.so');
if (args.includes('-h')) {
  err(`\nusage: ${process.argv[1]} [options] file0 file1 ...`);
  process.exit(0);
}
const model = args[args.indexOf('-m') + 1];
if (!model || !fs.existsSync(model)) {
  err(`whisper_init_from_file_with_params_no_state: failed to open '${model}'`);
  process.exit(3);
}
const dev = args.includes('-ng') ? null : Number(args[args.indexOf('-dev') + 1] || 0);
err(gpu && dev === 0 ? 'whisper_backend_init_gpu: using Vulkan0 backend' : 'whisper_backend_init_gpu: no GPU found');

/** The dominant frequency of a 16-bit mono WAV, from its zero crossings. */
function frequency(file) {
  const buf = fs.readFileSync(file);
  const data = buf.indexOf('data');
  const samples = (buf.length - data - 8) / 2;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(data + 8 + i * 2);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return samples ? crossings / 2 / (samples / 16000) : 0;
}

let failed = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '-f') continue;
  const file = args[++i];
  if (!fs.existsSync(file)) {
    err(`error: failed to read audio file '${file}'`);
    failed = true;
    continue;
  }
  err(`main: processing '${file}' (480000 samples, 30.0 sec), 4 threads, 1 processors, lang = auto, task = transcribe ...`);
  const hz = frequency(file);
  const [lang, p] = hz < 100 ? ['en', 0.2] : hz < 660 ? ['ja', 0.97] : hz < 1100 ? ['en', 0.95] : ['es', 0.9];
  err(`whisper_full_with_state: auto-detected language: ${lang} (p = ${p.toFixed(6)})`);
}
process.exit(failed ? 1 : 0);
