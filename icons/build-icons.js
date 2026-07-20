// One-shot generator: renders the SpeedUndo mark (rounded dark tile + cyan/violet
// bars, mirroring icons/icon.svg) into PNGs at every size the site needs,
// plus a multi-size favicon.ico. Zero dependencies — raw PNG/ICO encoding.
// Usage: node icons/build-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = __dirname;

// ---- tiny PNG encoder (truecolor+alpha) -------------------------------------

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolor + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- mark renderer (4x supersampled for clean edges) ------------------------

const INK = { bg: [0x0d, 0x14, 0x20], rx: [0x1f, 0xa5, 0xbc], tx: [0x7d, 0x5b, 0xe6] };

// Geometry in a 64-unit box, matching icons/icon.svg.
const TILE = { x: 0, y: 0, w: 64, h: 64, r: 14 };
const BARS = [
  { x: 12, y: 30, w: 16, h: 22, r: 4, color: INK.rx },
  { x: 36, y: 12, w: 16, h: 40, r: 4, color: INK.tx },
];

function insideRoundRect(px, py, rc) {
  const { x, y, w, h, r } = rc;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r || (px >= x + r && px <= x + w - r) || (py >= y + r && py <= y + h - r);
}

function render(size, { transparentBg = false } = {}) {
  const SS = 4; // supersample factor
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 64 / (size * SS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x * SS + sx + 0.5) * scale;
          const uy = (y * SS + sy + 0.5) * scale;
          let c = null;
          for (const bar of BARS) if (insideRoundRect(ux, uy, bar)) { c = bar.color; break; }
          if (!c && insideRoundRect(ux, uy, TILE)) c = transparentBg ? null : INK.bg;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      if (alpha > 0) {
        // premultiplied average back to straight alpha
        rgba[i] = Math.round(r / (a / 255));
        rgba[i + 1] = Math.round(g / (a / 255));
        rgba[i + 2] = Math.round(b / (a / 255));
      }
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, size, rgba);
}

// ---- ICO container (PNG-compressed entries, valid since Vista) --------------

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size;
    d[1] = size >= 256 ? 0 : size;
    d[2] = 0;               // palette
    d[3] = 0;               // reserved
    d.writeUInt16LE(1, 4);  // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

// ---- build ------------------------------------------------------------------

const jobs = [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['favicon-48.png', 48],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];
for (const [name, size] of jobs) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log(`wrote icons/${name} (${size}x${size})`);
}
const ico = encodeIco([16, 32, 48].map((s) => ({ size: s, png: render(s) })));
fs.writeFileSync(path.join(OUT, '..', 'favicon.ico'), ico);
console.log('wrote favicon.ico (16+32+48)');
