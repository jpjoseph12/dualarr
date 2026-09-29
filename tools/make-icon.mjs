// Renders public/icon.png (the Unraid template icon) from the same geometry as logo.svg,
// using only Node built-ins so it needs no image tooling.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const k = S / 64;
const CORNER = 14 * k;
const BG = [0x15, 0x18, 0x21];
const ACCENT = [0x9d, 0x8c, 0xff];
const MUTED = [0x8b, 0x93, 0xa7];

// Signed distances (negative inside), in 64-unit logo coordinates.
function roundRect(x, y, x0, y0, x1, y1, r) {
  const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segment(x, y, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
function triangle(x, y, a, b, c) {
  const d = Math.min(segment(x, y, a, b), segment(x, y, b, c), segment(x, y, c, a));
  const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const s = [side(a, b), side(b, c), side(c, a)];
  return s.every((v) => v >= 0) || s.every((v) => v <= 0) ? -d : d;
}
// The two speech bubbles: the back one (muted) and the front one (accent), each with its tail.
const back = (x, y) => Math.min(roundRect(x, y, 10, 12, 42, 35, 7), triangle(x, y, [23, 35], [14, 43], [17, 35]));
const front = (x, y) => Math.min(roundRect(x, y, 24, 26, 54, 48, 7), triangle(x, y, [47, 48], [50, 55], [41, 48]));
const lines = (x, y) => Math.min(segment(x, y, [31, 34], [47, 34]), segment(x, y, [31, 40], [41, 40])) - 1.5;

function sample(px, py) {
  // Rounded-square background mask.
  const qx = Math.max(Math.abs(px - S / 2) - (S / 2 - CORNER), 0);
  const qy = Math.max(Math.abs(py - S / 2) - (S / 2 - CORNER), 0);
  if (Math.hypot(qx, qy) > CORNER) return null;
  const x = px / k;
  const y = py / k;
  const f = front(x, y);
  if (f <= 0) return lines(x, y) <= 0 ? BG : ACCENT;
  // The front bubble's 1.5-unit outline cuts into the back one.
  if (f <= 1.5) return BG;
  return back(x, y) <= 0 ? MUTED : BG;
}

const SS = 4;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; a++;
      }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(new URL('../public/icon.png', import.meta.url), png);
console.log(`wrote public/icon.png (${png.length} bytes)`);
