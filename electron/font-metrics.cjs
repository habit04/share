/**
 * Read-only Windows metrics for TrueType glyf and standalone CFF outlines.
 * Font hinting programs are not executed; bounded CFF charstrings yield control hulls.
 * Layout uses the native glyph A's yMax, rather than OS/2.sCapHeight or rasterized pixels.
 * Table layouts: https://learn.microsoft.com/en-us/typography/opentype/spec/otff
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { cffGlyphBounds } = require('./cff-metrics.cjs');

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_FACES = 64;
const MAX_TABLES = 128;
const MAX_GLYPH_POINTS = 2_000_000;
/** Matches the captured-PDF per-face CID cap in src/io/pdf-fonts.ts. */
const MAX_USED_CODEPOINTS = 65534;
const MAX_BITMAP_STRIKES = 128;
const MAX_VARIATION_AXES = 32;
const MAX_VARIATION_INSTANCES = 512;

/** @typedef {[number, number, number, number]} FontBounds */
/** @typedef {[number, number, number]} CmapGroup */
/** @typedef {{ family: string, subfamily: string, unitsPerEm: number, capitalHeight: number, winDescent: number, fontBounds: FontBounds, advances: number[], glyphBounds: FontBounds[], glyphBoundsKnown: boolean[], cmap: number[], groups: CmapGroup[], fsType: number, bold: boolean, italic: boolean, variable?: boolean }} NativeFontMetrics */
/** @typedef {{ font: string, family?: string, bold?: boolean, italic?: boolean, usedCodepoints?: number[], restricted?: boolean }} FontMetricsRequest */

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

/**
 * Validate an fvar table far enough to trust that the face's static tables describe a
 * real default instance. Variation data itself (gvar/HVAR/avar/…) is never applied:
 * the base glyf/hmtx tables of a variable font ARE its default instance, which is the
 * only instance the request model can name and the only one PDF consumers render.
 * Named-instance selection and variation coordinates are unsupported.
 * Every name ID the fvar records reference (axis names, instance subfamily names and
 * declared instance PostScript names) must resolve to a record in the font's own name
 * table; a dangling reference leaves the named design space unverifiable.
 * https://learn.microsoft.com/en-us/typography/opentype/spec/fvar
 * @param {Buffer} data @param {Buffer | undefined} nameData
 * @returns {{ axes: { tag: string, min: number, value: number, max: number }[], instances: { nameId: number, psNameId: number | null, coordinates: number[] }[] }}
 */
function validateVariableFont(data, nameData) {
  need(data, 0, 16, 'fvar table');
  if (data.readUInt32BE(0) !== 0x00010000) fail('unsupported variable font (fvar) version');
  const axesOffset = data.readUInt16BE(4), axisCount = data.readUInt16BE(8), axisSize = data.readUInt16BE(10);
  const instanceCount = data.readUInt16BE(12), instanceSize = data.readUInt16BE(14);
  if (data.readUInt16BE(6) !== 2) fail('invalid variable font (fvar) reserved field');
  if (!axisCount || axisCount > MAX_VARIATION_AXES) fail('invalid variable font axis count');
  if (axisSize !== 20) fail('invalid variable font axis record size');
  if (instanceCount > MAX_VARIATION_INSTANCES) fail('invalid variable font instance count');
  if (axesOffset < 16) fail('invalid variable font axes offset');
  const coordinates = axisCount * 4;
  // For fvar 1.0 an instance record is exactly the subfamily name ID, the reserved
  // flags word and one Fixed per axis (axisCount*4 + 4), optionally followed by the
  // PostScript name ID (+6). Every other size — including axisCount*4 + 5 — is illegal.
  if (instanceSize !== 4 + coordinates && instanceSize !== 6 + coordinates) fail('invalid variable font instance record size');
  need(data, axesOffset, axisCount * axisSize + instanceCount * instanceSize, 'fvar axes and instances');
  /** @type {{ tag: string, min: number, value: number, max: number, nameId: number }[]} */
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const at = axesOffset + i * axisSize, tag = data.toString('latin1', at, at + 4);
    const min = data.readInt32BE(at + 4), value = data.readInt32BE(at + 8), max = data.readInt32BE(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || axes.some((axis) => axis.tag === tag)) fail('invalid or duplicate variable font axis tag');
    if (min > value || value > max) fail('variable font axis default is outside its range');
    if (data.readUInt16BE(at + 16) & ~1) fail('invalid variable font axis flags');
    axes.push({ tag, min, value, max, nameId: data.readUInt16BE(at + 18) });
  }
  const instancesAt = axesOffset + axisCount * axisSize;
  /** @type {{ nameId: number, psNameId: number | null, coordinates: number[] }[]} */
  const instances = [];
  for (let i = 0; i < instanceCount; i++) {
    const at = instancesAt + i * instanceSize;
    if (!data.readUInt16BE(at) || data.readUInt16BE(at + 2)) fail('invalid variable font instance record');
    /** @type {number[]} */
    const values = [];
    for (let axis = 0; axis < axisCount; axis++) {
      const coordinate = data.readInt32BE(at + 4 + axis * 4), range = /** @type {{ min: number, max: number }} */ (axes[axis]);
      if (coordinate < range.min || coordinate > range.max) fail('variable font instance coordinate is outside its axis range');
      values.push(coordinate);
    }
    instances.push({ nameId: data.readUInt16BE(at), psNameId: instanceSize === 6 + coordinates ? data.readUInt16BE(at + 4 + coordinates) : null, coordinates: values });
  }
  const nameIds = variableNameIndex(nameData).ids;
  const customNameId = (id) => id >= 256 && id <= 32767;
  for (const axis of axes) {
    if (!customNameId(axis.nameId)) fail(`invalid variable font axis name ID ${axis.nameId}`);
    if (!nameIds.has(axis.nameId)) fail(`variable font axis name ID ${axis.nameId} has no name table record`);
  }
  for (const instance of instances) {
    if (instance.nameId !== 2 && instance.nameId !== 17 && !customNameId(instance.nameId)) fail(`invalid variable font instance subfamily name ID ${instance.nameId}`);
    if (instance.psNameId !== null && instance.psNameId !== 0xffff && instance.psNameId !== 6 && !customNameId(instance.psNameId)) fail(`invalid variable font instance PostScript name ID ${instance.psNameId}`);
    if (!nameIds.has(instance.nameId)) fail(`variable font instance subfamily name ID ${instance.nameId} has no name table record`);
    if (instance.psNameId !== null && instance.psNameId !== 0xffff && !nameIds.has(instance.psNameId)) fail(`variable font instance PostScript name ID ${instance.psNameId} has no name table record`);
  }
  return { axes, instances };
}

/**
 * The default-coordinate identity policy (12.6a). A variable face is admitted only
 * when its default instance is PROVABLY the instance the face's own style claim names
 * (the OS/2 selection bits are the claim; PDF/Canvas consumers receive no variation
 * coordinates, so anything less than provable identity would silently substitute one
 * instance for another):
 * - weight: the OS/2 weight class must be exactly 400 (regular claim) or 700 (bold
 *   claim), and a wght axis default must equal it. A wght-500 default is a Medium
 *   instance; a regular request does not name it, however consistent the font is.
 * - width: a wdth axis default must be exactly 100 (normal width).
 * - optical size: an opsz axis must be degenerate (min = max); renderers auto-vary a
 *   real opsz axis by point size, so no fixed instance is the requested one.
 * - ital/slnt: an ital axis default must equal the claim (1 italic, 0 upright); an
 *   slnt axis default must be 0 (an oblique default is not provably the named style).
 * - named instances: an instance sitting exactly at the default coordinates is a
 *   second name for the default instance; its resolved subfamily name must name the
 *   face's own subfamily (name ID 2 or 17), and a declared PostScript name must equal
 *   the face's name ID 6 when the face carries one. A contradiction — or a name that
 *   cannot be resolved at all — makes the default instance's identity ambiguous.
 * Axes with no counterpart in the request model (e.g. a custom design axis) are
 * unconstrained: their default IS the face's base design, as in a static font.
 * @param {{ axes: { tag: string, min: number, value: number, max: number }[], instances: { nameId: number, psNameId: number | null, coordinates: number[] }[] }} model
 * @param {Buffer} os2 @param {{ resolve: (id: number) => string | undefined }} nameIndex
 * @param {{ bold: boolean, italic: boolean }} claim
 * @returns {string | null}
 */
function variableDefaultIdentityProblem(model, os2, nameIndex, claim) {
  const fixed = (value) => value / 65536;
  const weight = os2.readUInt16BE(4), expectedWeight = claim.bold ? 700 : 400;
  if (weight !== expectedWeight) return `variable font default weight ${weight} is not the ${claim.bold ? 'bold (700)' : 'regular (400)'} default instance this face claims to be; a variable font is admitted only when its default instance is provably the requested instance`;
  const axis = (tag) => model.axes.find((candidate) => candidate.tag === tag);
  const wght = axis('wght');
  if (wght && wght.value !== weight * 65536) return `variable font wght axis default ${fixed(wght.value)} disagrees with OS/2 weight class ${weight}`;
  const wdth = axis('wdth');
  if (wdth && wdth.value !== 100 * 65536) return `variable font default width ${fixed(wdth.value)} is not the normal width (100) this face claims to be`;
  const opsz = axis('opsz');
  if (opsz && opsz.min !== opsz.max) return `variable font optical-size axis varies (min ${fixed(opsz.min)}, default ${fixed(opsz.value)}, max ${fixed(opsz.max)}); no request can name an optical size, so its default instance is not provably the requested instance`;
  const ital = axis('ital');
  if (ital && ital.value !== (claim.italic ? 65536 : 0)) return `variable font ital axis default ${fixed(ital.value)} does not match the ${claim.italic ? 'italic' : 'upright'} face claimed`;
  const slnt = axis('slnt');
  if (slnt && slnt.value !== 0) return `variable font slnt axis default ${fixed(slnt.value)} is an oblique default that is not provably the ${claim.italic ? 'italic' : 'upright'} face claimed`;
  const subfamilies = [nameIndex.resolve(2), nameIndex.resolve(17)].filter((value) => value !== undefined);
  const facePostScript = nameIndex.resolve(6);
  for (const instance of model.instances) {
    if (!instance.coordinates.every((coordinate, index) => coordinate === model.axes[index]?.value)) continue;
    const name = nameIndex.resolve(instance.nameId);
    if (name === undefined) return `variable font named instance at the default coordinates has unresolvable name ID ${instance.nameId}; the default instance identity is ambiguous`;
    if (!subfamilies.some((subfamily) => familyKey(subfamily) === familyKey(name))) return `variable font named instance "${name}" sits at the default coordinates but does not name the face subfamily; the default instance identity is ambiguous`;
    if (instance.psNameId !== null && instance.psNameId !== 0xffff && facePostScript !== undefined) {
      const declared = nameIndex.resolve(instance.psNameId);
      if (declared === undefined) return `variable font named instance at the default coordinates has unresolvable PostScript name ID ${instance.psNameId}; the default instance identity is ambiguous`;
      if (declared !== facePostScript) return `variable font named instance at the default coordinates declares PostScript name "${declared}" but the face PostScript name is "${facePostScript}"; the default instance identity is ambiguous`;
    }
  }
  return null;
}

/** @param {Buffer} data @param {number} faceIndex */
function directory(data, faceIndex) {
  need(data, 0, 12, 'SFNT header');
  let offset = 0;
  const collection = data.toString('latin1', 0, 4) === 'ttcf';
  if (collection) {
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
  const outline = signature === 0x4f54544f ? 'cff' : 'glyf';
  if (outline === 'cff' && collection) fail('CFF outlines in collections are unsupported; a standalone CFF face is required');
  if (outline === 'glyf' && signature !== 0x00010000 && signature !== 0x74727565) fail('unsupported SFNT outline format');
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
  if (tables.has('CFF2')) fail('CFF2 outlines are unsupported');
  if (outline === 'glyf' && tables.has('CFF ')) fail('CFF outlines require the OpenType CFF signature');
  if (outline === 'cff' && !tables.has('CFF ')) fail('a CFF-outline font must contain a CFF table');
  if (outline === 'cff' && (tables.has('glyf') || tables.has('loca'))) fail('mixed CFF and TrueType outlines are unsupported');
  if (tables.has('fvar')) {
    if (outline !== 'glyf') fail('variable CFF font instances are unsupported');
    validateVariableFont(/** @type {Buffer} */ (tables.get('fvar')), tables.get('name'));
  }
  // Color layers, SVG and color strikes are not represented by monochrome outline bounds.
  for (const tag of ['sbix', 'COLR', 'CPAL', 'CBDT', 'CBLC', 'SVG ']) {
    if (tables.has(tag)) fail(`bitmap/color glyph tables are unsupported (${tag.trim()}); use Canvas fallback`);
  }
  if (tables.has('EBSC')) fail('embedded bitmap scaling is unsupported; use Canvas fallback');
  return { tables, outline };
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

/**
 * Structurally validate and scan the name records once; consumers select and decode.
 * @param {Buffer} data
 * @returns {{ platform: number, encoding: number, language: number, id: number, bytes: Buffer, unicode: boolean }[]}
 */
function scanNameRecords(data) {
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
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12, platform = data.readUInt16BE(at), encoding = data.readUInt16BE(at + 2), language = data.readUInt16BE(at + 4), id = data.readUInt16BE(at + 6), length = data.readUInt16BE(at + 8), offset = data.readUInt16BE(at + 10), key = `${platform}:${encoding}:${language}:${id}`;
    if (keys.has(key)) fail('duplicate name record');
    keys.add(key);
    need(data, storage + offset, length, 'name string');
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    records.push({ platform, encoding, language, id, bytes: data.subarray(storage + offset, storage + offset + length), unicode });
  }
  return records;
}

/**
 * The set of name IDs a name table actually carries, plus a best-effort resolver the
 * variable-font identity policy uses for axis/instance names. Resolution considers
 * Unicode records only (the same records the writer layer can resolve), and an ID
 * whose string cannot be decoded resolves to undefined: present, but unprovable.
 * @param {Buffer | undefined} data
 */
function variableNameIndex(data) {
  if (!data) return { ids: new Set(), resolve: () => undefined };
  const records = scanNameRecords(data);
  const ids = new Set(records.map((record) => record.id));
  const resolve = (id) => {
    /** @type {{ rank: number, value: string } | undefined} */
    let best;
    for (const record of records) {
      if (record.id !== id || !record.unicode) continue;
      const rank = record.platform === 3 ? record.language === 0x0409 ? 100 : 80 : 60;
      if (best && best.rank >= rank) continue;
      let value;
      try { value = new TextDecoder('utf-16be', { fatal: true }).decode(record.bytes); } catch { continue; }
      value = value.trim();
      if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) continue;
      best = { rank, value };
    }
    return best?.value;
  };
  return { ids, resolve };
}

/** @param {Buffer} data */
function fontNames(data) {
  const records = scanNameRecords(data);
  /** @type {Map<number, { bytes: Buffer, unicode: boolean, rank: number }>} */
  const selected = new Map();
  for (const record of records) {
    if (![1, 2, 16, 17].includes(record.id) || !record.unicode && !(record.platform === 1 && record.encoding === 0)) continue;
    const rank = record.platform === 3 ? record.language === 0x0409 ? 100 : 80 : record.platform === 0 ? 60 : 20;
    const prior = selected.get(record.id);
    if (!prior || rank > prior.rank) selected.set(record.id, { bytes: record.bytes, unicode: record.unicode, rank });
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

/**
 * Validate glyph records and resolve the supported unhinted horizontal phantom origins.
 * When `validatedSeeds` is given (a captured-PDF used set), the point decode below runs
 * only for those glyphs and their composite closure; every other simple glyph keeps its
 * header box and is marked unknown, the state consumers already fall back on. Without a
 * seed set every glyph is decoded, exactly as before, under the same point cap.
 * @param {Set<number> | undefined} validatedSeeds
 */
function glyphMetrics(glyf, offsets, glyphCount, bearings, validatedSeeds) {
  /** @type {FontBounds[]} */
  const boxes = [];
  /** @type {number[][]} */
  const children = [];
  /** @type {({ points: number, contours: number } | null)[]} */
  const simple = [];
  const metricOwners = new Int32Array(glyphCount).fill(-1);
  const known = new Array(glyphCount).fill(true);
  let componentWork = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const start = offsets[glyph], end = offsets[glyph + 1], length = end - start;
    if (!length) { boxes.push([0, 0, 0, 0]); children.push([]); simple.push(null); continue; }
    const data = glyf.subarray(start, end);
    need(data, 0, 10, 'glyph header');
    const contours = data.readInt16BE(0);
    boxes.push(bounds(data, 2, 'glyph bounding box'));
    /** @type {number[]} */
    const components = [];
    if (contours >= 0) {
      if (!contours) { boxes[boxes.length - 1] = [0, 0, 0, 0]; children.push(components); simple.push(null); continue; }
      need(data, 10, contours * 2 + 2, 'glyph contour endpoints');
      let last = -1;
      for (let i = 0; i < contours; i++) {
        const endpoint = data.readUInt16BE(10 + i * 2);
        if (endpoint <= last) fail('invalid glyph contour endpoint order');
        last = endpoint;
      }
      // The point decode itself is deferred to the validated second pass below.
      simple.push({ points: last + 1, contours });
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
      simple.push(null);
    }
    children.push(components);
  }
  // Second pass: the point decode-and-validate work, charged against the unchanged
  // cap. With a seed set the validated set is its composite closure; glyphs outside
  // it are never decoded and are marked unknown above their (untrusted) header box.
  /** @type {Set<number> | null} */
  let validated = null;
  if (validatedSeeds) {
    validated = new Set(validatedSeeds);
    const pending = [...validated];
    while (pending.length) {
      const parent = /** @type {number} */ (pending.pop());
      for (const child of children[parent] ?? []) if (!validated.has(child)) { validated.add(child); pending.push(child); }
    }
  }
  let pointWork = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const info = simple[glyph];
    if (!info) continue;
    if (validated && !validated.has(glyph)) { known[glyph] = false; continue; }
    const points = info.points;
    pointWork += points;
    if (pointWork > MAX_GLYPH_POINTS) fail('glyph point work exceeds the safe limit');
    const data = glyf.subarray(offsets[glyph], offsets[glyph + 1]);
    const instructionsAt = 10 + info.contours * 2, instructions = data.readUInt16BE(instructionsAt);
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
    const box = boxes[glyph];
    for (let axis = 0; axis < 2; axis++) {
      let coordinate = 0;
      for (const flag of flags) {
        const short = !!(flag & (axis ? 4 : 2)), sameOrPositive = !!(flag & (axis ? 32 : 16));
        if (short) coordinate += (sameOrPositive ? 1 : -1) * data[position++];
        else if (!sameOrPositive) { coordinate += data.readInt16BE(position); position += 2; }
        if (coordinate < box[axis] || coordinate > box[axis + 2]) fail('glyph coordinates exceed their stored bounding box');
      }
    }
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
      const { tables } = directory(data, faceIndex), { family } = fontNames(table(tables, 'name', 6)), os2 = table(tables, 'OS/2', 78), selection = os2.readUInt16BE(62);
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
  if (matches.length) {
    // Prefer the unstyled value of each unspecified flag, independently of face
    // order. Explicit flags still match exactly; a wholly unspecified request
    // without a family has already retained face 0 above.
    return (matches.find((entry) => (bold !== undefined || !entry.identity.bold) && (italic !== undefined || !entry.identity.italic)) ?? matches[0]).index;
  }
  return (pool.find((entry) => !entry.identity.bold && !entry.identity.italic) ?? pool[0]).index;
}

/** Binary-search the supplementary cmap groups, which are stored sorted by range start. @param {CmapGroup[]} groups @param {number} code */
function groupGlyph(groups, code) {
  let lo = 0, hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, group = /** @type {CmapGroup} */ (groups[mid]);
    if (code < group[0]) hi = mid - 1;
    else if (code > group[1]) lo = mid + 1;
    else return group[2] + code - group[0];
  }
  return 0;
}

/**
 * Resolve a bounded captured-PDF used-codepoint set to this face's glyph ids.
 * Capital A is always seeded: the native capital-height gate below must keep a
 * validated glyph whether or not a plotted run used it. Unmapped codepoints name
 * no glyph and are ignored; the set never widens any other validation or budget.
 * @param {{ cmap: number[], groups: CmapGroup[] }} mapping @param {Iterable<number> | undefined} usedCodepoints
 * @returns {Set<number> | undefined}
 */
function usedGlyphSeeds(mapping, usedCodepoints) {
  if (usedCodepoints === undefined) return undefined;
  if (!usedCodepoints || typeof usedCodepoints[Symbol.iterator] !== 'function') fail('invalid used codepoint set');
  const glyphs = new Set();
  let count = 0;
  for (const code of usedCodepoints) {
    if (++count > MAX_USED_CODEPOINTS) fail('used codepoint set exceeds the safe limit');
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) fail('invalid used codepoint');
    const glyph = code <= 0xffff ? mapping.cmap[code] : groupGlyph(mapping.groups, code);
    if (glyph) glyphs.add(glyph);
  }
  const glyphA = mapping.cmap[0x41];
  if (glyphA) glyphs.add(glyphA);
  return glyphs;
}

/** @param {Buffer | Uint8Array} bytes @param {{ faceIndex?: number, usedCodepoints?: Iterable<number> }} [options] @returns {NativeFontMetrics} */
function parseFontMetrics(bytes, { faceIndex = 0, usedCodepoints } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FONT_BYTES || bytes.byteLength < 12) fail('font must contain 12 bytes to 64 MiB');
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= MAX_FACES) fail('invalid font face index');
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { tables, outline } = directory(data, faceIndex);
  const head = table(tables, 'head', 54), maxp = table(tables, 'maxp', outline === 'cff' ? 6 : 32), hhea = table(tables, 'hhea', 36), os2 = table(tables, 'OS/2', 78);
  if (head.readUInt32BE(0) !== 0x00010000 || head.readUInt32BE(12) !== 0x5f0f3cf5 || head.readInt16BE(52) !== 0) fail('unsupported or invalid head table');
  // CFF uses maxp 0.5, whose only required metric is the glyph count.
  if (maxp.readUInt32BE(0) !== (outline === 'cff' ? 0x00005000 : 0x00010000) || hhea.readUInt32BE(0) !== 0x00010000 || hhea.readInt16BE(32) !== 0) fail('unsupported maxp/hhea table format');
  const unitsPerEm = head.readUInt16BE(18), glyphCount = maxp.readUInt16BE(4), metricsCount = hhea.readUInt16BE(34), locationFormat = head.readInt16BE(50), os2Version = os2.readUInt16BE(0);
  if (unitsPerEm < 16 || unitsPerEm > 16384 || !glyphCount || !metricsCount || metricsCount > glyphCount || locationFormat !== 0 && locationFormat !== 1) fail('invalid font units, glyph/metric count or location format');
  if (os2Version > 5) fail('unsupported OS/2 version');
  need(os2, 0, os2Version === 0 ? 78 : os2Version === 1 ? 86 : os2Version === 5 ? 100 : 96, 'OS/2 version data');
  const hmtx = table(tables, 'hmtx', metricsCount * 4 + (glyphCount - metricsCount) * 2);
  const advances = new Array(glyphCount), bearings = new Array(glyphCount);
  for (let i = 0; i < glyphCount; i++) {
    advances[i] = hmtx.readUInt16BE(Math.min(i, metricsCount - 1) * 4);
    bearings[i] = hmtx.readInt16BE(i < metricsCount ? i * 4 + 2 : metricsCount * 4 + (i - metricsCount) * 2);
  }
  // The cmap is resolved before glyph validation so a captured-PDF used set can
  // name the glyphs it needs; it depends only on the cmap table and glyph count.
  const mapping = characterMap(table(tables, 'cmap', 4), glyphCount);
  const validatedSeeds = usedGlyphSeeds(mapping, usedCodepoints);
  let glyphBounds, glyphBoundsKnown;
  if (outline === 'cff') {
    // CFF remains eager even for captured used sets: all CharStrings share the
    // parser's work cap. Its control hull starts at the glyph origin.
    ({ glyphBounds, glyphBoundsKnown } = cffGlyphBounds(table(tables, 'CFF ', 0), glyphCount, unitsPerEm));
  } else {
    const loca = table(tables, 'loca', (glyphCount + 1) * (locationFormat === 0 ? 2 : 4)), glyf = table(tables, 'glyf', 0);
    const offsets = new Array(glyphCount + 1);
    for (let i = 0; i <= glyphCount; i++) {
      const offset = locationFormat === 0 ? loca.readUInt16BE(i * 2) * 2 : loca.readUInt32BE(i * 4);
      if (offset > glyf.length || i && offset < offsets[i - 1]) fail('invalid loca glyph offset');
      offsets[i] = offset;
    }
    // Origin-adjusted unhinted control bounds retain visible Y overflow. Windows TEXTBOX
    // clipping and device hinting differ; neither is used to crop rendered/selected ink.
    ({ glyphBounds, glyphBoundsKnown } = glyphMetrics(glyf, offsets, glyphCount, bearings, validatedSeeds));
  }
  maskBitmapGlyphs(tables, glyphCount, glyphBoundsKnown);
  const names = fontNames(table(tables, 'name', 6));
  const glyphA = mapping.cmap[0x41], capitalHeight = glyphBounds[glyphA][3], selection = os2.readUInt16BE(62);
  if (!glyphA || capitalHeight <= 0 || !glyphBoundsKnown[glyphA]) fail('the native capital A glyph must have a known origin and positive yMax');
  const bold = !!(selection & 32), italic = !!(selection & (1 | 512));
  if (tables.has('fvar')) {
    // The fvar was structurally validated in directory(); re-derive its model and hold
    // the face to the default-coordinate identity policy before any metrics are trusted.
    const model = validateVariableFont(/** @type {Buffer} */ (tables.get('fvar')), tables.get('name'));
    const problem = variableDefaultIdentityProblem(model, os2, variableNameIndex(tables.get('name')), { bold, italic });
    if (problem) fail(problem);
  }
  return { ...names, unitsPerEm, capitalHeight, winDescent: os2.readUInt16BE(76), fontBounds: bounds(head, 36, 'font bounding box'), advances, glyphBounds, glyphBoundsKnown, ...mapping, fsType: os2.readUInt16BE(8), bold, italic, ...(tables.has('fvar') ? { variable: true } : {}) };
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
  if (request.usedCodepoints !== undefined && (!Array.isArray(request.usedCodepoints) || request.usedCodepoints.length > MAX_USED_CODEPOINTS || Array.from(request.usedCodepoints).some((code) => !Number.isInteger(code) || code < 0 || code > 0x10ffff))) fail('invalid used codepoint set');
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
  return { filename, expectedFamily: request.family ?? known?.[0], usedCodepoints: request.usedCodepoints };
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
  const { filename, expectedFamily, usedCodepoints } = fontRequest(request);
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
    const metrics = parseFontMetrics(data, { faceIndex, usedCodepoints });
    if (expectedFamily && familyKey(metrics.family) !== familyKey(expectedFamily)) fail('installed font family does not match the requested family');
    if (request.bold !== undefined && metrics.bold !== request.bold || request.italic !== undefined && metrics.italic !== request.italic) fail('installed font style does not match the requested style flags');
    return { metrics: { ...metrics, resolvedFilename: path.basename(resolved), faceIndex }, bytes: data };
  } finally { await handle.close(); }
}

/**
 * Metadata-only callers never receive the installed font program, and never a
 * used set: screen metrics keep the eager whole-face validation, so an over-cap
 * face keeps falling back to Canvas there exactly as before. Used sets exist
 * only on the captured-PDF read (readWindowsPdfFont via readWindowsFontData).
 * @param {FontMetricsRequest} request @param {{ fontsDirectory?: string }} [options]
 * @returns {Promise<NativeFontMetrics & { resolvedFilename: string, faceIndex: number }>}
 */
async function readWindowsFontMetrics(request, options) {
  const stripped = request && typeof request === 'object' ? { ...request, usedCodepoints: undefined } : request;
  return (await readWindowsFontData(/** @type {FontMetricsRequest} */ (stripped), options)).metrics;
}

module.exports = { parseFontMetrics, readWindowsFontMetrics, readWindowsFontData, MAX_FONT_BYTES, MAX_USED_CODEPOINTS };
