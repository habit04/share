/**
 * Read-only Windows TrueType metrics. No font programs or glyph instructions are executed.
 * Layout uses the native glyph A's yMax, rather than OS/2.sCapHeight or rasterized pixels.
 * Table layouts: https://learn.microsoft.com/en-us/typography/opentype/spec/otff
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_FACES = 64;
const MAX_TABLES = 128;
const MAX_GLYPH_POINTS = 2_000_000;
const MAX_BITMAP_STRIKES = 128;

/** @typedef {[number, number, number, number]} FontBounds */
/** @typedef {[number, number, number]} CmapGroup */
/** @typedef {{ family: string, subfamily: string, unitsPerEm: number, capitalHeight: number, winDescent: number, fontBounds: FontBounds, advances: number[], glyphBounds: FontBounds[], glyphBoundsKnown: boolean[], cmap: number[], groups: CmapGroup[], fsType: number, bold: boolean, italic: boolean }} NativeFontMetrics */
/** @typedef {{ font: string, family?: string, bold?: boolean, italic?: boolean }} FontMetricsRequest */

/** @returns {never} */
function fail(message) { throw new Error(`Font metrics: ${message}`); }
/** @param {Buffer} data @param {number} offset @param {number} length @param {string} what */
function need(data, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > data.length || length > data.length - offset) fail(`truncated or invalid ${what}`);
}
/** @param {Buffer} data @param {number} offset @param {string} what @returns {FontBounds} */
function bounds(data, offset, what) {
  need(data, offset, 8, what);
  const value = /** @type {FontBounds} */ ([data.readInt16BE(offset), data.readInt16BE(offset + 2), data.readInt16BE(offset + 4), data.readInt16BE(offset + 6)]);
  if (value[0] > value[2] || value[1] > value[3]) fail(`invalid ${what} coordinates`);
  return value;
}

/** @param {Buffer} data @param {number} faceIndex */
function directory(data, faceIndex) {
  need(data, 0, 12, 'SFNT header');
  let offset = 0;
  if (data.toString('latin1', 0, 4) === 'ttcf') {
    const version = data.readUInt32BE(4), count = data.readUInt32BE(8);
    if (version !== 0x00010000 && version !== 0x00020000) fail('unsupported TrueType collection version');
    if (!count || count > MAX_FACES) fail('invalid TrueType collection face count');
    const headerLength = 12 + count * 4 + (version === 0x00020000 ? 12 : 0);
    need(data, 12, headerLength - 12, 'TrueType collection directory');
    if (version === 0x00020000) {
      const at = 12 + count * 4, tag = data.readUInt32BE(at), length = data.readUInt32BE(at + 4), signatureOffset = data.readUInt32BE(at + 8);
      if (!tag && (length || signatureOffset) || tag && (tag !== 0x44534947 || !length || signatureOffset < headerLength)) fail('invalid TrueType collection signature fields');
      if (tag) need(data, signatureOffset, length, 'TrueType collection signature');
    }
    if (faceIndex >= count) fail('TrueType collection face index is out of range');
    const offsets = new Set();
    for (let i = 0; i < count; i++) {
      const entry = data.readUInt32BE(12 + i * 4);
      if (entry < headerLength || entry % 4 || offsets.has(entry)) fail('invalid or duplicate TrueType collection face offset');
      need(data, entry, 12, 'TrueType collection face');
      offsets.add(entry);
    }
    offset = data.readUInt32BE(12 + faceIndex * 4);
  } else if (faceIndex !== 0) fail('a standalone font has only face index 0');
  const signature = data.readUInt32BE(offset);
  if (signature === 0x4f54544f) fail('CFF outlines are unsupported; a TrueType glyf font is required');
  if (signature !== 0x00010000 && signature !== 0x74727565) fail('unsupported SFNT outline format');
  const count = data.readUInt16BE(offset + 4);
  if (!count || count > MAX_TABLES) fail('invalid SFNT table count');
  need(data, offset + 12, count * 16, 'SFNT table directory');
  /** @type {Map<string, Buffer>} */
  const tables = new Map();
  /** @type {{ offset: number, length: number }[]} */
  const ranges = [];
  for (let i = 0; i < count; i++) {
    const at = offset + 12 + i * 16, tag = data.toString('latin1', at, at + 4), start = data.readUInt32BE(at + 8), length = data.readUInt32BE(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tables.has(tag)) fail('invalid or duplicate SFNT table tag');
    need(data, start, length, `${tag} table`);
    if (start % 4 || (length && start < offset + 12 + count * 16 && start + length > offset)) fail(`invalid ${tag} table offset`);
    if (length) ranges.push({ offset: start, length });
    tables.set(tag, data.subarray(start, start + length));
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].length) fail('overlapping SFNT tables');
  if (tables.has('CFF ') || tables.has('CFF2')) fail('CFF outlines are unsupported');
  if (tables.has('fvar')) fail('variable font instances are unsupported');
  // Color layers, SVG and color strikes are not represented by the monochrome glyf box.
  for (const tag of ['sbix', 'COLR', 'CPAL', 'CBDT', 'CBLC', 'SVG ']) {
    if (tables.has(tag)) fail(`bitmap/color glyph tables are unsupported (${tag.trim()}); use Canvas fallback`);
  }
  if (tables.has('EBSC')) fail('embedded bitmap scaling is unsupported; use Canvas fallback');
  return tables;
}

/** @param {Map<string, Buffer>} tables @param {string} tag @param {number} length */
function table(tables, tag, length) {
  const data = tables.get(tag);
  if (!data) fail(`missing ${tag} table`);
  need(data, 0, length, `${tag} table`);
  return data;
}

/**
 * Only validate monochrome strike locations, never decode bitmap image data. Every
 * declared strike glyph stays on Canvas even if no bitmap is present at a given size.
 * https://learn.microsoft.com/en-us/typography/opentype/spec/eblc
 * @param {Map<string, Buffer>} tables @param {number} glyphCount @param {boolean[]} known
 */
function maskBitmapGlyphs(tables, glyphCount, known) {
  if (!tables.has('EBDT') && !tables.has('EBLC')) return;
  const ebdt = table(tables, 'EBDT', 4), eblc = table(tables, 'EBLC', 8);
  if (ebdt.readUInt32BE(0) !== 0x00020000 || eblc.readUInt32BE(0) !== 0x00020000) fail('unsupported EBDT/EBLC bitmap version');
  const count = eblc.readUInt32BE(4);
  if (!count || count > MAX_BITMAP_STRIKES) fail('invalid EBLC bitmap strike count');
  const recordsEnd = 8 + count * 48;
  need(eblc, 8, count * 48, 'EBLC bitmap strike records');
  const coverage = new Int32Array(glyphCount + 1);
  for (let strike = 0; strike < count; strike++) {
    const at = 8 + strike * 48, listOffset = eblc.readUInt32BE(at), listSize = eblc.readUInt32BE(at + 4), listCount = eblc.readUInt32BE(at + 8);
    const first = eblc.readUInt16BE(at + 40), last = eblc.readUInt16BE(at + 42), depth = eblc[at + 46], flags = eblc[at + 47];
    if (first > last || last >= glyphCount || !eblc[at + 44] || !eblc[at + 45] || ![1, 2, 4, 8].includes(depth) || !flags || flags & 0xfc || eblc.readUInt32BE(at + 12)) fail('invalid EBLC bitmap strike range or metrics');
    if (!listCount || listCount > 4096 || listOffset < recordsEnd || listSize < listCount * 8) fail('invalid EBLC bitmap index list');
    need(eblc, listOffset, listSize, 'EBLC bitmap index list');
    let previous = first - 1;
    for (let index = 0; index < listCount; index++) {
      const entry = listOffset + index * 8, start = eblc.readUInt16BE(entry), end = eblc.readUInt16BE(entry + 2), subtableOffset = eblc.readUInt32BE(entry + 4);
      if (start < first || start <= previous || start > end || end > last || subtableOffset < listCount * 8 || subtableOffset > listSize - 8) fail('invalid EBLC bitmap index range or offset');
      const subtable = listOffset + subtableOffset, format = eblc.readUInt16BE(subtable), imageFormat = eblc.readUInt16BE(subtable + 2), imageOffset = eblc.readUInt32BE(subtable + 4);
      if (format < 1 || format > 5 || ![1, 2, 5, 6, 7, 8, 9].includes(imageFormat)) fail('unsupported EBLC/EBDT bitmap index or image format');
      if (imageOffset < 4 || imageOffset > ebdt.length) fail('invalid EBDT bitmap image offset');
      previous = end;
    }
    coverage[first]++; coverage[last + 1]--;
  }
  let strikes = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) { strikes += coverage[glyph]; if (strikes) known[glyph] = false; }
}

/** @param {Buffer} data @param {number} glyphCount */
function characterMap(data, glyphCount) {
  if (data.readUInt16BE(0) !== 0) fail('unsupported cmap version');
  const count = data.readUInt16BE(2);
  if (!count || count > 128) fail('invalid cmap encoding count');
  need(data, 4, count * 8, 'cmap encoding records');
  const keys = new Set();
  /** @type {{ offset: number, rank: number } | null} */
  let selected4 = null, selected12 = null;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8, platform = data.readUInt16BE(at), encoding = data.readUInt16BE(at + 2), offset = data.readUInt32BE(at + 4), key = `${platform}:${encoding}`;
    if (keys.has(key)) fail('duplicate cmap encoding');
    keys.add(key);
    if (offset < 4 + count * 8) fail('invalid cmap subtable offset');
    need(data, offset, 2, 'cmap subtable');
    const format = data.readUInt16BE(offset), unicode = platform === 0 && encoding !== 5;
    if (format === 4 && (unicode || platform === 3 && encoding === 1)) {
      const rank = platform === 3 ? 100 : 80;
      if (!selected4 || rank > selected4.rank) selected4 = { offset, rank };
    }
    if (format === 12 && (unicode || platform === 3 && encoding === 10)) {
      const rank = platform === 3 ? 100 : 80;
      if (!selected12 || rank > selected12.rank) selected12 = { offset, rank };
    }
  }
  if (!selected4 && !selected12) fail('Unicode cmap formats 4/12 are required; symbol and other encodings are unsupported');
  const cmap = new Array(65536).fill(0);
  if (selected4) {
    const offset = selected4.offset;
    need(data, offset, 16, 'cmap format 4 header');
    const length = data.readUInt16BE(offset + 2), segmentBytes = data.readUInt16BE(offset + 6), segments = segmentBytes / 2;
    if (!segmentBytes || segmentBytes % 2 || segments > 8192 || length < 16 + segments * 8 || length % 2) fail('invalid cmap format 4 segment count/length');
    need(data, offset, length, 'cmap format 4');
    const endAt = offset + 14, startAt = endAt + segmentBytes + 2, deltaAt = startAt + segmentBytes, rangeAt = deltaAt + segmentBytes, glyphAt = rangeAt + segmentBytes;
    if (data.readUInt16BE(endAt + segmentBytes) !== 0) fail('invalid cmap format 4 reserved pad');
    let lastEnd = -1;
    for (let i = 0; i < segments; i++) {
      const start = data.readUInt16BE(startAt + i * 2), end = data.readUInt16BE(endAt + i * 2), delta = data.readInt16BE(deltaAt + i * 2), range = data.readUInt16BE(rangeAt + i * 2);
      if (start > end || start <= lastEnd || range % 2) fail('overlapping or invalid cmap format 4 segment');
      if (i === segments - 1 && (start !== 0xffff || end !== 0xffff)) fail('missing cmap format 4 sentinel');
      lastEnd = end;
      for (let code = start; code <= end; code++) {
        let glyph;
        if (!range) glyph = (code + delta) & 0xffff;
        else {
          const address = rangeAt + i * 2 + range + (code - start) * 2;
          if (address < glyphAt || address + 2 > offset + length) fail('invalid cmap format 4 glyph offset');
          glyph = data.readUInt16BE(address);
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph >= glyphCount) fail('cmap references an absent glyph');
        cmap[code] = glyph;
      }
    }
  }
  /** @type {CmapGroup[]} */
  const groups = [];
  if (selected12) {
    const offset = selected12.offset;
    need(data, offset, 16, 'cmap format 12 header');
    const length = data.readUInt32BE(offset + 4), count = data.readUInt32BE(offset + 12);
    if (data.readUInt16BE(offset + 2) || !count || count > 65536 || length !== 16 + count * 12) fail('invalid cmap format 12 group count/length');
    need(data, offset, length, 'cmap format 12');
    let lastEnd = -1;
    const fullBmp = new Array(65536).fill(0);
    for (let i = 0; i < count; i++) {
      const at = offset + 16 + i * 12, start = data.readUInt32BE(at), end = data.readUInt32BE(at + 4), glyph = data.readUInt32BE(at + 8);
      if (start > end || start <= lastEnd || end > 0x10ffff || start <= 0xdfff && end >= 0xd800 || glyph + end - start >= glyphCount) fail('overlapping or invalid cmap format 12 group');
      lastEnd = end;
      groups.push([start, end, glyph]);
      for (let code = start; code <= Math.min(end, 0xffff); code++) fullBmp[code] = glyph + code - start;
    }
    for (let code = 0; code < 65536; code++) {
      if (selected4 && cmap[code] && cmap[code] !== fullBmp[code]) fail('Unicode cmap formats 4/12 disagree');
      cmap[code] = fullBmp[code];
    }
  }
  return { cmap, groups };
}

/** @param {Buffer} data */
function fontNames(data) {
  const version = data.readUInt16BE(0), count = data.readUInt16BE(2), storage = data.readUInt16BE(4);
  if (version !== 0 && version !== 1) fail('unsupported name table version');
  if (!count || count > 4096 || storage < 6 + count * 12) fail('invalid name table count/storage');
  need(data, 6, count * 12, 'name records');
  if (version === 1) {
    need(data, 6 + count * 12, 2, 'name language tag count');
    const languages = data.readUInt16BE(6 + count * 12);
    need(data, 8 + count * 12, languages * 4, 'name language tags');
    if (storage < 8 + count * 12 + languages * 4) fail('invalid name language storage');
    for (let i = 0; i < languages; i++) {
      const at = 8 + count * 12 + i * 4;
      need(data, storage + data.readUInt16BE(at + 2), data.readUInt16BE(at), 'name language string');
    }
  }
  const keys = new Set();
  /** @type {Map<number, { bytes: Buffer, unicode: boolean, rank: number }>} */
  const selected = new Map();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12, platform = data.readUInt16BE(at), encoding = data.readUInt16BE(at + 2), language = data.readUInt16BE(at + 4), id = data.readUInt16BE(at + 6), length = data.readUInt16BE(at + 8), offset = data.readUInt16BE(at + 10), key = `${platform}:${encoding}:${language}:${id}`;
    if (keys.has(key)) fail('duplicate name record');
    keys.add(key);
    need(data, storage + offset, length, 'name string');
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    if (![1, 2, 16, 17].includes(id) || !unicode && !(platform === 1 && encoding === 0)) continue;
    const rank = platform === 3 ? language === 0x0409 ? 100 : 80 : platform === 0 ? 60 : 20;
    const prior = selected.get(id);
    if (!prior || rank > prior.rank) selected.set(id, { bytes: data.subarray(storage + offset, storage + offset + length), unicode, rank });
  }
  const decode = (id) => {
    const record = selected.get(id);
    if (!record) return '';
    if (!record.bytes.length || record.bytes.length > 4096 || record.unicode && record.bytes.length % 2) fail('invalid font family/subfamily string');
    let value;
    if (record.unicode) value = new TextDecoder('utf-16be', { fatal: true }).decode(record.bytes);
    else value = new TextDecoder('macintosh', { fatal: true }).decode(record.bytes);
    value = value.trim();
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid font family/subfamily name');
    return value;
  };
  const family = decode(1) || decode(16), subfamily = decode(2) || decode(17);
  if (!family || !subfamily) fail('font family and subfamily names are required');
  return { family, subfamily };
}

/** Validate glyph records and resolve the supported unhinted horizontal phantom origins. */
function glyphMetrics(glyf, offsets, glyphCount, bearings) {
  /** @type {FontBounds[]} */
  const boxes = [];
  /** @type {number[][]} */
  const children = [];
  const metricOwners = new Int32Array(glyphCount).fill(-1);
  const known = new Array(glyphCount).fill(true);
  let pointWork = 0, componentWork = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const start = offsets[glyph], end = offsets[glyph + 1], length = end - start;
    if (!length) { boxes.push([0, 0, 0, 0]); children.push([]); continue; }
    const data = glyf.subarray(start, end);
    need(data, 0, 10, 'glyph header');
    const contours = data.readInt16BE(0);
    boxes.push(bounds(data, 2, 'glyph bounding box'));
    /** @type {number[]} */
    const components = [];
    if (contours >= 0) {
      if (!contours) { boxes[boxes.length - 1] = [0, 0, 0, 0]; children.push(components); continue; }
      need(data, 10, contours * 2 + 2, 'glyph contour endpoints');
      let last = -1;
      for (let i = 0; i < contours; i++) {
        const endpoint = data.readUInt16BE(10 + i * 2);
        if (endpoint <= last) fail('invalid glyph contour endpoint order');
        last = endpoint;
      }
      const points = last + 1;
      pointWork += points;
      if (pointWork > MAX_GLYPH_POINTS) fail('glyph point work exceeds the safe limit');
      const instructionsAt = 10 + contours * 2, instructions = data.readUInt16BE(instructionsAt);
      let position = instructionsAt + 2 + instructions, seen = 0, coordinateBytes = 0;
      const flags = new Uint8Array(points);
      need(data, instructionsAt + 2, instructions, 'glyph instructions');
      while (seen < points) {
        need(data, position, 1, 'glyph flags');
        const flag = data[position++];
        if (flag & 0x80) fail('unsupported reserved glyph flag');
        let run = 1;
        if (flag & 8) { need(data, position, 1, 'glyph flag repeat'); run += data[position++]; }
        if (run > points - seen) fail('glyph flag repeat exceeds point count');
        flags.fill(flag, seen, seen + run);
        coordinateBytes += run * ((flag & 2 ? 1 : flag & 16 ? 0 : 2) + (flag & 4 ? 1 : flag & 32 ? 0 : 2));
        seen += run;
      }
      need(data, position, coordinateBytes, 'glyph coordinates');
      const box = boxes[boxes.length - 1];
      for (let axis = 0; axis < 2; axis++) {
        let coordinate = 0;
        for (const flag of flags) {
          const short = !!(flag & (axis ? 4 : 2)), sameOrPositive = !!(flag & (axis ? 32 : 16));
          if (short) coordinate += (sameOrPositive ? 1 : -1) * data[position++];
          else if (!sameOrPositive) { coordinate += data.readInt16BE(position); position += 2; }
          if (coordinate < box[axis] || coordinate > box[axis + 2]) fail('glyph coordinates exceed their stored bounding box');
        }
      }
    } else {
      let position = 10, flags, hasInstructions = false;
      do {
        need(data, position, 4, 'composite glyph component');
        flags = data.readUInt16BE(position);
        const child = data.readUInt16BE(position + 2);
        // Shipped Windows Courier/Times use the legacy unused 0x0010 bit; it adds no payload.
        if (child >= glyphCount || flags & 0xe000 || [8, 64, 128].filter((mask) => flags & mask).length > 1 || (flags & 0x1800) === 0x1800) fail('invalid composite glyph flags/reference');
        if (!components.length && !(flags & 2)) fail('the first composite glyph component must use coordinate arguments');
        if (!(flags & 2)) known[glyph] = false;
        hasInstructions ||= !!(flags & 256);
        components.push(child);
        if (++componentWork > MAX_GLYPH_POINTS || components.length > 1024) fail('composite glyph work exceeds the safe limit');
        const payload = (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
        need(data, position + 4, payload, 'composite glyph arguments/transform');
        if (flags & 512) {
          if (metricOwners[glyph] !== -1) known[glyph] = false;
          const x = flags & 1 ? data.readInt16BE(position + 4) : data.readInt8(position + 4);
          const y = flags & 1 ? data.readInt16BE(position + 6) : data.readInt8(position + 5);
          const at = position + 4 + (flags & 1 ? 4 : 2);
          const identity = flags & 8 ? data.readInt16BE(at) === 0x4000
            : flags & 64 ? data.readInt16BE(at) === 0x4000 && data.readInt16BE(at + 2) === 0x4000
            : flags & 128 ? data.readInt16BE(at) === 0x4000 && data.readInt16BE(at + 2) === 0 && data.readInt16BE(at + 4) === 0 && data.readInt16BE(at + 6) === 0x4000 : true;
          if (!(flags & 2) || x || y || !identity) known[glyph] = false;
          metricOwners[glyph] = child;
        }
        position += 4 + payload;
      } while (flags & 32);
      if (hasInstructions) { need(data, position, 2, 'composite glyph instruction count'); need(data, position + 2, data.readUInt16BE(position), 'composite glyph instructions'); }
    }
    children.push(components);
  }
  const status = new Uint8Array(glyphCount);
  const depths = new Uint16Array(glyphCount);
  const origins = new Int32Array(glyphCount);
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    if (status[glyph] === 2) continue;
    const stack = [{ glyph, next: 0 }];
    status[glyph] = 1;
    while (stack.length) {
      const current = stack[stack.length - 1], child = children[current.glyph][current.next++];
      if (child === undefined) {
        let depth = 0;
        for (const id of children[current.glyph]) depth = Math.max(depth, depths[id] + 1);
        if (depth > 64) fail('composite glyph nesting exceeds the safe limit');
        depths[current.glyph] = depth;
        if (children[current.glyph].some((id) => !known[id])) known[current.glyph] = false;
        const owner = metricOwners[current.glyph];
        origins[current.glyph] = owner >= 0 ? origins[owner] : boxes[current.glyph][0] - bearings[current.glyph];
        status[current.glyph] = 2;
        stack.pop();
        continue;
      }
      if (status[child] === 1) fail('cyclic composite glyph reference');
      if (status[child] === 2) continue;
      if (stack.length >= 65) fail('composite glyph nesting exceeds the safe limit');
      status[child] = 1;
      stack.push({ glyph: child, next: 0 });
    }
  }
  // OpenType pp1.x = raw xMin - hmtx LSB. USE_MY_METRICS retains a component's
  // recursively resolved pp1; see FreeType ttgload.c tt_loader_set_pp/load_truetype_glyph.
  // Layout advances remain parent hmtx values (confirmed by native CAD CID widths).
  return {
    glyphBounds: boxes.map((box, glyph) => !known[glyph] || box.every((value) => value === 0) ? box : /** @type {FontBounds} */ ([box[0] - origins[glyph], box[1], box[2] - origins[glyph], box[3]])),
    glyphBoundsKnown: known,
  };
}

/**
 * Lightweight per-face identity probe for a TrueType collection: family name and
 * OS/2 selection bold/italic flags. Only table directories, the name table and the
 * OS/2 header are read — the full glyph/cmap parse runs on the selected face alone.
 * Faces that cannot be probed (unsupported structures) are skipped by selection; the
 * full parse of the fallback face reports the original error for such a face.
 * The collection header validation mirrors directory(), bounded by MAX_FACES.
 * @param {Buffer} data @returns {Array<{ family: string, bold: boolean, italic: boolean } | null> | null} null when not a collection
 */
function collectionFaceIdentities(data) {
  if (data.toString('latin1', 0, 4) !== 'ttcf') return null;
  const version = data.readUInt32BE(4), count = data.readUInt32BE(8);
  if (version !== 0x00010000 && version !== 0x00020000 || !count || count > MAX_FACES) return null;
  /** @type {Array<{ family: string, bold: boolean, italic: boolean } | null>} */
  const identities = [];
  for (let faceIndex = 0; faceIndex < count; faceIndex++) {
    try {
      const tables = directory(data, faceIndex), { family } = fontNames(table(tables, 'name', 6)), os2 = table(tables, 'OS/2', 78), selection = os2.readUInt16BE(62);
      identities.push({ family, bold: !!(selection & 32), italic: !!(selection & (1 | 512)) });
    } catch { identities.push(null); }
  }
  return identities;
}

/**
 * Deterministic collection-face selection for one metrics request, derived only
 * from the existing font/family/bold/italic request fields (no request-shape change):
 * - Candidates are the collection's probed faces. When an expected family is known,
 *   only faces of that family are candidates; when none matches, face 0 is kept so
 *   the existing family-mismatch failure is reported unchanged.
 * - A requested bold/italic must match the face flags exactly. When no face of the
 *   family has the requested style, the family's regular face (else its first face)
 *   is parsed so the existing explicit style-mismatch failure is reported.
 * - When style is unspecified, the regular face of the requested family is
 *   preferred; a request naming neither family nor style keeps face 0, as before.
 * @param {Buffer} data @param {string | undefined} expectedFamily @param {FontMetricsRequest} request @returns {number}
 */
function selectCollectionFace(data, expectedFamily, request) {
  const identities = collectionFaceIdentities(data);
  if (!identities) return 0;
  /** @type {{ identity: { family: string, bold: boolean, italic: boolean }, index: number }[]} */
  const pool = [];
  identities.forEach((identity, index) => {
    if (identity !== null && (expectedFamily === undefined || familyKey(identity.family) === familyKey(expectedFamily))) pool.push({ identity, index });
  });
  if (!pool.length) return 0;
  const { bold, italic } = request;
  const matches = pool.filter((entry) => (bold === undefined || entry.identity.bold === bold) && (italic === undefined || entry.identity.italic === italic));
  if (expectedFamily === undefined && bold === undefined && italic === undefined) return 0;
  if (matches.length) return matches[0].index;
  return (pool.find((entry) => !entry.identity.bold && !entry.identity.italic) ?? pool[0]).index;
}

/** @param {Buffer | Uint8Array} bytes @param {{ faceIndex?: number }} [options] @returns {NativeFontMetrics} */
function parseFontMetrics(bytes, { faceIndex = 0 } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FONT_BYTES || bytes.byteLength < 12) fail('font must contain 12 bytes to 64 MiB');
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= MAX_FACES) fail('invalid font face index');
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), tables = directory(data, faceIndex);
  const head = table(tables, 'head', 54), maxp = table(tables, 'maxp', 32), hhea = table(tables, 'hhea', 36), os2 = table(tables, 'OS/2', 78);
  if (head.readUInt32BE(0) !== 0x00010000 || head.readUInt32BE(12) !== 0x5f0f3cf5 || head.readInt16BE(52) !== 0) fail('unsupported or invalid head table');
  if (maxp.readUInt32BE(0) !== 0x00010000 || hhea.readUInt32BE(0) !== 0x00010000 || hhea.readInt16BE(32) !== 0) fail('unsupported maxp/hhea table format');
  const unitsPerEm = head.readUInt16BE(18), glyphCount = maxp.readUInt16BE(4), metricsCount = hhea.readUInt16BE(34), locationFormat = head.readInt16BE(50), os2Version = os2.readUInt16BE(0);
  if (unitsPerEm < 16 || unitsPerEm > 16384 || !glyphCount || !metricsCount || metricsCount > glyphCount || locationFormat !== 0 && locationFormat !== 1) fail('invalid font units, glyph/metric count or location format');
  if (os2Version > 5) fail('unsupported OS/2 version');
  need(os2, 0, os2Version === 0 ? 78 : os2Version === 1 ? 86 : os2Version === 5 ? 100 : 96, 'OS/2 version data');
  const hmtx = table(tables, 'hmtx', metricsCount * 4 + (glyphCount - metricsCount) * 2), loca = table(tables, 'loca', (glyphCount + 1) * (locationFormat === 0 ? 2 : 4)), glyf = table(tables, 'glyf', 0);
  const advances = new Array(glyphCount), bearings = new Array(glyphCount);
  for (let i = 0; i < glyphCount; i++) {
    advances[i] = hmtx.readUInt16BE(Math.min(i, metricsCount - 1) * 4);
    bearings[i] = hmtx.readInt16BE(i < metricsCount ? i * 4 + 2 : metricsCount * 4 + (i - metricsCount) * 2);
  }
  const offsets = new Array(glyphCount + 1);
  for (let i = 0; i <= glyphCount; i++) {
    const offset = locationFormat === 0 ? loca.readUInt16BE(i * 2) * 2 : loca.readUInt32BE(i * 4);
    if (offset > glyf.length || i && offset < offsets[i - 1]) fail('invalid loca glyph offset');
    offsets[i] = offset;
  }
  // Origin-adjusted unhinted control bounds retain visible Y overflow. Windows TEXTBOX
  // clipping and device hinting differ; neither is used to crop rendered/selected ink.
  const { glyphBounds, glyphBoundsKnown } = glyphMetrics(glyf, offsets, glyphCount, bearings);
  maskBitmapGlyphs(tables, glyphCount, glyphBoundsKnown);
  const mapping = characterMap(table(tables, 'cmap', 4), glyphCount), names = fontNames(table(tables, 'name', 6));
  const glyphA = mapping.cmap[0x41], capitalHeight = glyphBounds[glyphA][3], selection = os2.readUInt16BE(62);
  if (!glyphA || capitalHeight <= 0 || !glyphBoundsKnown[glyphA]) fail('the native capital A glyph must have a known origin and positive yMax');
  return { ...names, unitsPerEm, capitalHeight, winDescent: os2.readUInt16BE(76), fontBounds: bounds(head, 36, 'font bounding box'), advances, glyphBounds, glyphBoundsKnown, ...mapping, fsType: os2.readUInt16BE(8), bold: !!(selection & 32), italic: !!(selection & (1 | 512)) };
}

/** Common Windows family variants, regular/bold/italic/bold-italic. No guessed font substitutions. */
const FAMILIES = [
  ['Arial', 'arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  ['Arial Narrow', 'arialn.ttf', 'arialnb.ttf', 'arialni.ttf', 'arialnbi.ttf'],
  ['Courier New', 'cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  ['Times New Roman', 'times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  ['Calibri', 'calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  ['Cambria', 'cambria.ttc', 'cambriab.ttf', 'cambriai.ttf', 'cambriaz.ttf'],
  ['Consolas', 'consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'],
  ['Segoe UI', 'segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  ['Tahoma', 'tahoma.ttf', 'tahomabd.ttf', '', ''],
  ['Verdana', 'verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  ['Trebuchet MS', 'trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'],
  ['Georgia', 'georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  ['Comic Sans MS', 'comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf'],
  ['Century Gothic', 'gothic.ttf', 'gothicb.ttf', 'gothici.ttf', 'gothicbi.ttf'],
  ['Palatino Linotype', 'pala.ttf', 'palab.ttf', 'palai.ttf', 'palabi.ttf'],
];
const familyKey = (value) => value.normalize('NFC').trim().toLowerCase();

/** @param {FontMetricsRequest} request */
function fontRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.font !== 'string' || !request.font || request.font.length > 160) fail('a bounded font filename or known Windows family is required');
  if (request.family !== undefined && (typeof request.family !== 'string' || !request.family.trim() || request.family.length > 256 || /[\u0000-\u001f\u007f]/.test(request.family))) fail('invalid requested font family');
  for (const flag of ['bold', 'italic']) if (request[flag] !== undefined && typeof request[flag] !== 'boolean') fail(`invalid requested ${flag} flag`);
  const name = request.font;
  if (name.trim() !== name || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('font must be a safe literal basename');
  const known = FAMILIES.find((family) => familyKey(family[0]) === familyKey(name) || family.slice(1).some((filename) => filename && filename.toLowerCase() === name.toLowerCase()));
  const isFile = /\.(?:ttf|otf|ttc)$/i.test(name);
  if (!known && !isFile) fail('unknown Windows font family; a safe .ttf/.otf/.ttc filename is required');
  let filename = name;
  if (known && (!isFile || request.bold !== undefined || request.italic !== undefined)) {
    const variant = isFile ? known.findIndex((item, index) => index > 0 && item.toLowerCase() === name.toLowerCase()) : 1;
    const bold = request.bold ?? (variant === 2 || variant === 4), italic = request.italic ?? (variant === 3 || variant === 4);
    filename = known[1 + (bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!filename) fail('the requested family has no known installed variant for these style flags');
  }
  return { filename, expectedFamily: request.family ?? known?.[0] };
}

/** @param {string} root @param {string} child */
function inside(root, child) {
  const relative = path.relative(root, child);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a, b) { return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }

/**
 * Read a literal font inside the trusted Windows Fonts directory. The injectable directory is
 * for private tests/main-process configuration; it must never be accepted from renderer IPC.
 * @param {FontMetricsRequest} request
 * @param {{ fontsDirectory?: string }} [options]
 * @returns {Promise<{ metrics: NativeFontMetrics & { resolvedFilename: string, faceIndex: number }, bytes: Uint8Array }>}
 */
async function readWindowsFontData(request, { fontsDirectory } = {}) {
  const { filename, expectedFamily } = fontRequest(request);
  if (fontsDirectory === undefined) {
    if (process.platform !== 'win32') fail('installed Windows font metrics are unavailable on this platform');
    fontsDirectory = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  }
  if (typeof fontsDirectory !== 'string' || !path.isAbsolute(fontsDirectory) || fontsDirectory.length > 4096 || fontsDirectory.includes('\0')) fail('invalid trusted font directory');
  const root = await fs.realpath(fontsDirectory), candidate = path.join(root, filename), resolved = await fs.realpath(candidate);
  if (!inside(root, resolved)) fail('font resolves outside the trusted font directory');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 12n || before.size > BigInt(MAX_FONT_BYTES)) fail('font file must contain 12 bytes to 64 MiB');
    const currentRoot = await fs.realpath(fontsDirectory), currentFile = await fs.realpath(candidate);
    if (!samePath(root, currentRoot) || !samePath(resolved, currentFile) || !inside(root, currentFile) || !sameFile(before, await fs.stat(currentFile, { bigint: true }))) fail('font path changed before reading');
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) fail('font file changed while reading');
      offset += read.bytesRead;
    }
    if (!unchanged(before, await handle.stat({ bigint: true })) || !samePath(root, await fs.realpath(fontsDirectory)) || !samePath(resolved, await fs.realpath(candidate)) || !unchanged(before, await fs.stat(resolved, { bigint: true }))) fail('font file or path changed while reading');
    // A collection contributes the face selected for this family/style request;
    // metrics, cmap and permissions all come from that one face.
    const faceIndex = selectCollectionFace(data, expectedFamily, request);
    const metrics = parseFontMetrics(data, { faceIndex });
    if (expectedFamily && familyKey(metrics.family) !== familyKey(expectedFamily)) fail('installed font family does not match the requested family');
    if (request.bold !== undefined && metrics.bold !== request.bold || request.italic !== undefined && metrics.italic !== request.italic) fail('installed font style does not match the requested style flags');
    return { metrics: { ...metrics, resolvedFilename: path.basename(resolved), faceIndex }, bytes: data };
  } finally { await handle.close(); }
}

/**
 * Metadata-only callers never receive the installed font program.
 * @param {FontMetricsRequest} request @param {{ fontsDirectory?: string }} [options]
 * @returns {Promise<NativeFontMetrics & { resolvedFilename: string, faceIndex: number }>}
 */
async function readWindowsFontMetrics(request, options) { return (await readWindowsFontData(request, options)).metrics; }

module.exports = { parseFontMetrics, readWindowsFontMetrics, readWindowsFontData, MAX_FONT_BYTES };
