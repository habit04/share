#!/usr/bin/env node
/**
 * make-icons: draws the JCad Electrical application icon - a schematic relay contact (a normally
 * open contact: a raised moving blade between two wires ending in terminal dots) in white on the
 * JCad blue rounded tile - and writes every format the installers and pages need, with no image
 * library:
 *
 *   build/icon.svg          vector master
 *   build/icon.png          1024 x 1024
 *   build/icons/NxN.png     16 ... 1024 (Linux desktop icons; electron-builder reads this folder)
 *   build/icon.ico          Windows: 16, 24, 32, 48, 64, 128, 256 (PNG-compressed entries)
 *   build/icon.icns         macOS: icp4 ... ic14 (PNG-compressed entries)
 *   public/favicon.svg      the application page's icon (Vite copies public/ next to index.html)
 *   site/img/icon.svg       the website's favicon
 *
 *   node scripts/make-icons.mjs            (re)generate the files above
 *   node scripts/make-icons.mjs --check    exit 1 when the committed files differ from a fresh render
 *
 * The artwork is original: the geometry is defined once (strokes and circles in a 1024 x 1024
 * design space) and rendered both to SVG paths and, through a small anti-aliased scanline
 * rasterizer, to PNG. Sizes of 32 px and below use a simplified drawing (no terminal dots,
 * heavier strokes) so the contact stays readable. tests/packaging.test.ts re-renders the
 * icons and compares them with the committed files.
 */
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ design (1024 x 1024)
/** JCad blue: the tile's gradient from top left to bottom right. */
const BLUE_TOP = [92, 162, 255];
const BLUE_BOTTOM = [31, 96, 214];
const SHADOW = [10, 40, 112];
const WHITE = [255, 255, 255];
const TILE = { x0: 64, y0: 64, x1: 960, y1: 960, r: 196 };

/**
 * A rounded rectangle as one clockwise ring (y down). `r` is clamped to half the shorter side.
 * @param {{ x0: number, y0: number, x1: number, y1: number, r: number }} rect
 * @param {number} [steps]  points per quarter circle
 * @returns {number[][]}
 */
function roundedRect({ x0, y0, x1, y1, r }, steps = 24) {
  const rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  const pts = [];
  const corners = [
    [x1 - rr, y0 + rr, -Math.PI / 2],
    [x1 - rr, y1 - rr, 0],
    [x0 + rr, y1 - rr, Math.PI / 2],
    [x0 + rr, y0 + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  return pts;
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} [steps]
 * @returns {number[][]}
 */
function circle(cx, cy, r, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** @param {number[]} a @param {number[]} b @param {number} t */
function mixColor(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
}

/**
 * A thick line from `a` to `b` with round caps, as rings (a quadrilateral and two cap circles).
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} half  half the stroke width
 * @returns {number[][][]}
 */
function stroke(a, b, half) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  // Clockwise on screen (y down), like the other rings: their windings add up instead of cancelling.
  const quad = [
    [a[0] - nx, a[1] - ny],
    [b[0] - nx, b[1] - ny],
    [b[0] + nx, b[1] + ny],
    [a[0] + nx, a[1] + ny],
  ];
  const area = quad.reduce((s, p, i) => s + p[0] * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * p[1], 0);
  return [area > 0 ? quad : quad.reverse(), circle(a[0], a[1], half, 48), circle(b[0], b[1], half, 48)];
}

/**
 * The relay contact (a normally open contact as drawn in IEC schematics): a wire from the left
 * terminal to the pivot of the moving blade, raised (open), and the wire to the right terminal
 * with the fixed contact the blade closes onto.
 * @param {boolean} simple  the small-size variant
 * @param {number} dy  vertical offset (the shadow)
 * @returns {number[][][]} rings (non-zero fill, they may overlap)
 */
function contact(simple, dy) {
  const cy = (simple ? 640 : 632) + dy; // the wires; the blade rises above them
  const half = simple ? 50 : 32; // half the stroke width
  const left = simple ? 118 : 196; // wire ends (terminal centres)
  const right = 1024 - left;
  const pivot = [simple ? 360 : 384, cy];
  const fixedX = simple ? 640 : 628; // the fixed contact, a tick up from the right wire
  const tick = simple ? 96 : 104;
  const angle = ((simple ? 42 : 40) * Math.PI) / 180;
  const reach = simple ? 330 : 318; // horizontal reach of the blade
  const tip = [pivot[0] + reach, cy - reach * Math.tan(angle)];
  const rings = [...stroke([left, cy], pivot, half), ...stroke(pivot, tip, half), ...stroke([fixedX, cy], [right, cy], half), ...stroke([fixedX, cy], [fixedX, cy - tick], half)];
  if (!simple) {
    // Terminal dots at both wire ends.
    rings.push(circle(left, cy, 64), circle(right, cy, 64));
  }
  return rings;
}

/** @typedef {{ poly: number[][][], fill: number[] | ((x: number, y: number) => number[]), alpha: number }} Shape */

/**
 * Shapes, back to front.
 * @param {boolean} simple
 * @returns {{ tile: number[][], shapes: Shape[] }}
 */
function design(simple) {
  const tile = roundedRect(TILE);
  const tileFill = (/** @type {number} */ x, /** @type {number} */ y) => mixColor(BLUE_TOP, BLUE_BOTTOM, ((y - TILE.y0) / (TILE.y1 - TILE.y0)) * 0.8 + ((x - TILE.x0) / (TILE.x1 - TILE.x0)) * 0.2);
  /** @type {Shape[]} */
  const shapes = [{ poly: [tile], fill: tileFill, alpha: 1 }];
  if (!simple) shapes.push({ poly: contact(false, 22), fill: SHADOW, alpha: 0.24 });
  shapes.push({ poly: contact(simple, 0), fill: WHITE, alpha: 1 });
  return { tile, shapes };
}

// ------------------------------------------------------------------ rasterizer
/**
 * Coverage of a set of rings (non-zero winding) on a size x size grid, 4 sub-scanlines per pixel
 * with exact horizontal span coverage. Returns Float32Array(size * size) in [0, 1].
 * @param {number[][][]} rings
 * @param {number} size
 */
function coverage(rings, size) {
  const k = size / 1024;
  const SUB = 4;
  const cov = new Float32Array(size * size);
  const edges = [];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[1] === b[1]) continue;
      edges.push({ x0: a[0] * k, y0: a[1] * k, x1: b[0] * k, y1: b[1] * k, dir: b[1] > a[1] ? 1 : -1 });
    }
  const row = new Float32Array(size + 1);
  for (let py = 0; py < size; py += 1) {
    row.fill(0);
    for (let s = 0; s < SUB; s += 1) {
      const y = py + (s + 0.5) / SUB;
      const xs = [];
      for (const e of edges) {
        const ymin = Math.min(e.y0, e.y1);
        const ymax = Math.max(e.y0, e.y1);
        if (y < ymin || y >= ymax) continue;
        xs.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      }
      xs.sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i += 1) {
        wind += xs[i].dir;
        if (wind === 0) continue;
        span(row, Math.max(0, xs[i].x), Math.min(size, xs[i + 1].x), 1 / SUB);
      }
    }
    for (let px = 0; px < size; px += 1) cov[py * size + px] = Math.min(1, row[px]);
  }
  return cov;
}

/** @param {Float32Array} row @param {number} x0 @param {number} x1 @param {number} w */
function span(row, x0, x1, w) {
  if (x1 <= x0) return;
  const i0 = Math.floor(x0);
  const i1 = Math.floor(x1);
  if (i0 === i1) {
    row[i0] += (x1 - x0) * w;
    return;
  }
  row[i0] += (i0 + 1 - x0) * w;
  for (let i = i0 + 1; i < i1; i += 1) row[i] += w;
  if (i1 < row.length) row[i1] += (x1 - i1) * w;
}

/**
 * RGBA pixels of the icon at `size` x `size`.
 * @param {number} size
 */
export function render(size) {
  const { shapes } = design(size <= 32);
  const px = new Float32Array(size * size * 4); // premultiplied RGBA, 0..1
  const k = 1024 / size;
  for (const sh of shapes) {
    const cov = coverage(sh.poly, size);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        const a = cov[i] * sh.alpha;
        if (!(a > 0)) continue;
        const col = typeof sh.fill === 'function' ? sh.fill((x + 0.5) * k, (y + 0.5) * k) : sh.fill;
        const o = i * 4;
        for (let c = 0; c < 3; c += 1) px[o + c] = (col[c] / 255) * a + px[o + c] * (1 - a);
        px[o + 3] = a + px[o + 3] * (1 - a);
      }
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = px[i * 4 + 3];
    for (let c = 0; c < 3; c += 1) rgba[i * 4 + c] = a > 0 ? Math.round(Math.min(1, px[i * 4 + c] / a) * 255) : 0;
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return rgba;
}

// ------------------------------------------------------------------ encoders
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * RGBA pixels (width * height * 4 bytes) as a PNG (8-bit RGBA, filter 0, zlib level 9).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 */
export function encodePng(width, height, rgba) {
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y += 1) src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * ICO with PNG-compressed images (Windows Vista and later).
 * @param {Array<{ size: number, data: Buffer }>} images
 */
export function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

/**
 * ICNS with PNG entries.
 * @param {Array<[string, Buffer]>} entries  [type, PNG]
 */
export function icns(entries) {
  const parts = entries.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

/** The vector master (the full drawing, as at 1024 px). */
export function svg() {
  const { tile, shapes } = design(false);
  const d = (/** @type {number[][][]} */ rings) => rings.map((r) => `M${r.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`).join('');
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">',
    '  <title>JCad Electrical</title>',
    '  <defs>',
    `    <linearGradient id="tile" x1="${TILE.x0}" y1="${TILE.y0}" x2="${TILE.x0 + 0.2 * (TILE.x1 - TILE.x0)}" y2="${TILE.y1}" gradientUnits="userSpaceOnUse">`,
    `      <stop offset="0" stop-color="rgb(${BLUE_TOP.join(',')})"/>`,
    `      <stop offset="1" stop-color="rgb(${BLUE_BOTTOM.join(',')})"/>`,
    '    </linearGradient>',
    '  </defs>',
  ];
  for (const sh of shapes) {
    const fill = typeof sh.fill === 'function' ? 'url(#tile)' : `rgb(${sh.fill.join(',')})`;
    const attrs = [`d="${sh.poly[0] === tile ? d([tile]) : d(sh.poly)}"`, `fill="${fill}"`];
    if (sh.alpha < 1) attrs.push(`fill-opacity="${sh.alpha}"`);
    lines.push(`  <path ${attrs.join(' ')}/>`);
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ outputs
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = /** @type {Array<[string, number]>} */ ([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]);

/** Every generated file, by its path relative to the repository root. */
export function buildAll() {
  const pngs = new Map(PNG_SIZES.map((s) => [s, encodePng(s, s, render(s))]));
  const vector = Buffer.from(svg());
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  files.set('build/icon.svg', vector);
  files.set('build/icon.png', /** @type {Buffer} */ (pngs.get(1024)));
  for (const s of PNG_SIZES) files.set(`build/icons/${s}x${s}.png`, /** @type {Buffer} */ (pngs.get(s)));
  files.set('build/icon.ico', ico(ICO_SIZES.map((s) => ({ size: s, data: /** @type {Buffer} */ (pngs.get(s)) }))));
  files.set('build/icon.icns', icns(ICNS_TYPES.map(([t, s]) => [t, /** @type {Buffer} */ (pngs.get(s))])));
  files.set('public/favicon.svg', vector);
  files.set('site/img/icon.svg', vector);
  return files;
}

/**
 * Decoded image data of a PNG (the IDAT stream inflated), to compare renders independently of
 * zlib's encoder version.
 * @param {Buffer} buf
 */
export function pngPixels(buf) {
  const parts = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') parts.push(buf.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  return inflateSync(Buffer.concat(parts));
}

/**
 * Same picture? PNGs by pixels, ICO / ICNS by their embedded PNGs' pixels, other files by bytes.
 * @param {string} name
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function sameIcon(name, a, b) {
  if (name.endsWith('.png')) return pngPixels(a).equals(pngPixels(b));
  if (name.endsWith('.ico') || name.endsWith('.icns')) {
    const pngs = (/** @type {Buffer} */ buf) => {
      const at = [];
      for (let i = buf.indexOf(PNG_SIGNATURE); i >= 0; i = buf.indexOf(PNG_SIGNATURE, i + 8)) at.push(i);
      return at.map((start, k) => buf.subarray(start, at[k + 1] ?? buf.length));
    };
    const pa = pngs(a);
    const pb = pngs(b);
    return a.subarray(0, 4).equals(b.subarray(0, 4)) && pa.length === pb.length && pa.every((p, i) => pngPixels(p).equals(pngPixels(pb[i])));
  }
  return a.equals(b);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = buildAll();
  if (process.argv.includes('--check')) {
    const stale = [...files].filter(([name, data]) => !existsSync(join(root, name)) || !sameIcon(name, readFileSync(join(root, name)), data)).map(([n]) => n);
    if (stale.length) {
      console.error(`make-icons: out of date: ${stale.join(', ')} (run node scripts/make-icons.mjs)`);
      process.exit(1);
    }
    console.log(`make-icons: ${files.size} files up to date.`);
  } else {
    for (const [name, data] of files) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), data);
    }
    console.log(`make-icons: wrote ${[...files.keys()].join(', ')}`);
  }
}
