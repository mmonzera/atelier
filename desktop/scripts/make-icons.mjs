// Generates the app/tray PNG icons with no external tooling (zlib + hand-written PNG chunks).
// Mark: dark rounded tile with a light "A" built from two strokes and a crossbar.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size, { tile = true } = {}) {
  const S = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  const stroke = size * (tile ? 0.085 : 0.12);
  const top = [0.5, tile ? 0.22 : 0.1];
  const left = [tile ? 0.27 : 0.14, tile ? 0.78 : 0.92];
  const right = [tile ? 0.73 : 0.86, tile ? 0.78 : 0.92];
  const barY = tile ? 0.58 : 0.64;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bgA = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          // rounded square
          const cx = Math.min(Math.max(px, r), size - r);
          const cy = Math.min(Math.max(py, r), size - r);
          const inTile = Math.hypot(px - cx, py - cy) <= r;
          if (inTile) bgA++;
          const u = px / size;
          const v = py / size;
          const d = Math.min(
            distToSegment(u, v, top[0], top[1], left[0], left[1]),
            distToSegment(u, v, top[0], top[1], right[0], right[1])
          );
          const barHit =
            Math.abs(v - barY) * size <= stroke / 2 &&
            u > left[0] + (top[0] - left[0]) * ((left[1] - barY) / (left[1] - top[1])) &&
            u < right[0] - (right[0] - top[0]) * ((right[1] - barY) / (right[1] - top[1]));
          if (d * size <= stroke / 2 || barHit) fg++;
        }
      }
      const n = S * S;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (tile) {
        const a = bgA / n;
        const f = fg / n;
        // tile #15151b -> letter #f4f4f6
        raw[o] = Math.round(0x15 + (0xf4 - 0x15) * f);
        raw[o + 1] = Math.round(0x15 + (0xf4 - 0x15) * f);
        raw[o + 2] = Math.round(0x1b + (0xf6 - 0x1b) * f);
        raw[o + 3] = Math.round(255 * a);
      } else {
        // tray: white glyph on transparent (Windows taskbar is dark by default)
        raw[o] = raw[o + 1] = raw[o + 2] = 0xf4;
        raw[o + 3] = Math.round((255 * fg) / n);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
fs.writeFileSync(path.join(outDir, 'tray.png'), render(16, { tile: false }));
fs.writeFileSync(path.join(outDir, 'tray@2x.png'), render(32, { tile: false }));
console.log('icons written to', outDir);
