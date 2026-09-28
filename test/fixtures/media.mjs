// Makes small test episodes with ffmpeg: audio tracks whose "language" is a tone (440 Hz sounds
// Japanese and 880 Hz English to fake-whisper.mjs), and text subtitle tracks that are either full
// dialogue or a few signs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const hasFfmpeg = () => spawnSync('ffmpeg', ['-version']).status === 0;

export const TONE = { ja: 440, en: 880 };
const LINES = {
  en: ['I don’t know what you are talking about.', 'We have to go now, it is not safe here.', 'What do you want from me?', 'This is the way, and you have to be ready for it.'],
  es: ['No sé de qué estás hablando.', 'Tenemos que irnos ahora, no es seguro aquí.', '¿Qué quieres de mí?', 'Este es el camino y tienes que estar listo para eso.'],
};
const ts = (x) => `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor((x % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')},000`;

function srt(kind, lang, duration) {
  const cues = [];
  if (kind === 'signs') {
    for (const [i, t] of [0.05, 0.4, 0.6, 0.95].entries()) cues.push(`${i + 1}\n${ts(duration * t)} --> ${ts(duration * t + 2)}\nSIGN: Station ${i}\n`);
  } else {
    for (let t = 1, n = 1; t < duration - 3; t += 4, n++) cues.push(`${n}\n${ts(t)} --> ${ts(t + 3)}\n${LINES[lang][n % 4]} (${n})\n`);
  }
  return cues.join('\n');
}

/**
 * Writes an MKV: `audio` [{ sound: 'ja'|'en', tag }], `subs` [{ lang, kind: 'full'|'signs', tag, title }].
 * Tags are what the file claims; `sound` and the subtitle text are what it really has.
 */
export function makeEpisode(file, { audio = [], subs = [], duration = 120 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dir = fs.mkdtempSync(`${file}.tmp`);
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=32x18:r=1:d=${duration}`];
  audio.forEach((a) => args.push('-f', 'lavfi', '-i', `sine=f=${TONE[a.sound]}:d=${duration}`));
  subs.forEach((s, i) => {
    const f = path.join(dir, `s${i}.srt`);
    fs.writeFileSync(f, srt(s.kind || 'full', s.lang || 'en', duration));
    args.push('-i', f);
  });
  for (let i = 0; i <= audio.length + subs.length; i++) args.push('-map', String(i));
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'ass');
  audio.forEach((a, i) => a.tag && args.push(`-metadata:s:a:${i}`, `language=${a.tag}`));
  subs.forEach((s, i) => {
    if (s.tag) args.push(`-metadata:s:s:${i}`, `language=${s.tag}`);
    if (s.title) args.push(`-metadata:s:s:${i}`, `title=${s.title}`);
  });
  args.push(file);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return file;
}
