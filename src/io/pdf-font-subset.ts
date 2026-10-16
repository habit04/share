/**
 * GID-preserving glyf subsetting for embedded PDF font programs (priority 12.3).
 *
 * Pure and bounded: no I/O, no dependencies. The subset keeps the source program's
 * glyph count and glyph IDs — used glyphs (plus GID 0 and the composite-component
 * closure) are copied verbatim, unused glyphs become zero-length. Because GIDs do
 * not move, the writer's CIDToGIDMap, ToUnicode, /W widths and post names stay
 * byte-identical, and `hmtx`/`hhea`/`name`/`OS/2` ride verbatim (permissions are
 * preserved byte-for-byte). Only `glyf`/`loca` are rebuilt and the glyph-derived
 * `maxp` maxima recomputed; directory checksums and the head checkSumAdjustment
 * follow the same pattern as electron/ttc-extract.cjs. A stale DSIG is dropped.
 * Glyph renumbering/compaction and cmap trimming are deliberately out of scope.
 */

export const FS_TYPE_NO_SUBSETTING = 0x0100;

const MAX_TABLES = 128;
const MAX_COMPONENTS_PER_GLYPH = 1024;
const MAX_COMPOSITE_DEPTH = 64;
const CHECKSUM_MAGIC = 0xb1b0afba;

const fail = (problem: string): never => { throw new Error(`PDF font subset: ${problem}`); };
const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

interface TableRange { tag: string; start: number; length: number }
interface GlyphInfo {
  components: readonly number[];
  points: number;
  contours: number;
  depth: number;
  instructions: number;
}

function directory(bytes: Uint8Array): Map<string, TableRange> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) fail('font program must contain at least 12 bytes');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = data.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x74727565) fail('standalone TrueType glyf outlines required');
  const count = data.getUint16(4);
  if (!count || count > MAX_TABLES || 12 + count * 16 > data.byteLength) fail('invalid SFNT directory');
  const tables = new Map<string, TableRange>();
  const ranges: TableRange[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const start = data.getUint32(at + 8), length = data.getUint32(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tables.has(tag) || start % 4 || start > data.byteLength || length > data.byteLength - start || length && start < 12 + count * 16) fail('invalid SFNT table');
    const range = { tag, start, length };
    tables.set(tag, range);
    if (length) ranges.push(range);
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1]!.start + ranges[i - 1]!.length)) fail('overlapping SFNT tables');
  return tables;
}

function table(tables: Map<string, TableRange>, tag: string, length: number): TableRange {
  const found = tables.get(tag);
  if (!found || found.length < length) return fail(`missing or truncated ${tag} table`);
  return found;
}

/** fsType is read from the program actually being embedded, never a metrics cache. */
export function programNoSubsetting(bytes: Uint8Array): boolean {
  try {
    const tables = directory(bytes);
    const os2 = tables.get('OS/2');
    if (!os2 || os2.length < 10) return false;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return !!(data.getUint16(os2.start + 8) & FS_TYPE_NO_SUBSETTING);
  } catch { return false; }
}

function checksum(data: DataView, start: number, length: number): number {
  let sum = 0;
  for (let at = start; at < start + length; at += 4) sum = (sum + data.getUint32(at)) >>> 0;
  return sum;
}

/**
 * Build the GID-preserving subset. Throws on any malformed layout, cyclic or
 * over-deep composite, or when the result would not be smaller than the source;
 * callers that cannot tolerate failure must use embeddableFontProgram().
 */
export function subsetGlyfProgram(bytes: Uint8Array, usedGlyphs: ReadonlySet<number>): Uint8Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = directory(bytes);
  const head = table(tables, 'head', 54), maxp = table(tables, 'maxp', 32);
  const glyf = table(tables, 'glyf', 0), locaTable = table(tables, 'loca', 4);
  if (data.getUint32(maxp.start) !== 0x00010000) fail('unsupported maxp table format');
  const glyphCount = data.getUint16(maxp.start + 4);
  if (!glyphCount) fail('invalid glyph count');
  const locaFormat = data.getInt16(head.start + 50);
  if (locaFormat !== 0 && locaFormat !== 1) fail('invalid loca format');
  const locaEntry = locaFormat === 0 ? 2 : 4;
  if (locaTable.length < (glyphCount + 1) * locaEntry) fail('truncated loca table');
  const locaAt = (index: number) => locaFormat === 0 ? data.getUint16(locaTable.start + index * 2) * 2 : data.getUint32(locaTable.start + index * 4);
  const offsets = new Array<number>(glyphCount + 1);
  for (let glyph = 0; glyph <= glyphCount; glyph++) {
    offsets[glyph] = locaAt(glyph);
    if (offsets[glyph]! > glyf.length || glyph && offsets[glyph]! < offsets[glyph - 1]!) fail('invalid loca glyph offset');
  }
  const glyphRange = (glyph: number) => ({ start: glyf.start + offsets[glyph]!, length: offsets[glyph + 1]! - offsets[glyph]! });

  for (const glyph of usedGlyphs) if (!integer(glyph, 0, glyphCount - 1)) fail('used glyph index out of range');

  // Parse one glyph header (and, for composites, its component records) using the
  // same bounds the native metrics reader enforces in electron/font-metrics.cjs.
  const parseGlyph = (glyph: number): GlyphInfo => {
    const { start, length } = glyphRange(glyph);
    if (!length) return { components: [], points: 0, contours: 0, depth: 0, instructions: 0 };
    if (length < 10) fail('truncated glyph data');
    const contours = data.getInt16(start);
    if (contours >= 0) {
      if (!contours) {
        // OpenType permits a zero-contour glyph to contain only its header.
        // Optional instructions can still operate on the phantom points.
        if (length === 10) return { components: [], points: 0, contours: 0, depth: 0, instructions: 0 };
        if (length < 12) fail('truncated glyph instruction count');
        const instructions = data.getUint16(start + 10);
        if (12 + instructions > length) fail('truncated glyph instructions');
        return { components: [], points: 0, contours: 0, depth: 0, instructions };
      }
      if (length < 10 + contours * 2 + 2) fail('truncated glyph contour endpoints');
      const points = data.getUint16(start + 10 + (contours - 1) * 2) + 1;
      const instructions = data.getUint16(start + 10 + contours * 2);
      if (12 + contours * 2 + instructions > length) fail('truncated glyph instructions');
      return { components: [], points, contours, depth: 0, instructions };
    }
    if (contours !== -1) fail('invalid glyph contour count');
    const components: number[] = [];
    let position = start + 10, flags = 0, hasInstructions = false;
    do {
      if (position + 4 > start + length) fail('truncated composite glyph component');
      flags = data.getUint16(position);
      const child = data.getUint16(position + 2);
      if (child >= glyphCount || flags & 0xe000 || [8, 64, 128].filter((mask) => flags & mask).length > 1 || (flags & 0x1800) === 0x1800) fail('invalid composite glyph flags/reference');
      hasInstructions ||= !!(flags & 0x0100);
      components.push(child);
      if (components.length > MAX_COMPONENTS_PER_GLYPH) fail('composite glyph component limit exceeded');
      const payload = (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
      if (position + 4 + payload > start + length) fail('truncated composite glyph arguments/transform');
      position += 4 + payload;
    } while (flags & 0x0020);
    let instructions = 0;
    if (hasInstructions) {
      if (position + 2 > start + length) fail('truncated composite glyph instruction count');
      instructions = data.getUint16(position);
      if (position + 2 + instructions > start + length) fail('truncated composite glyph instructions');
    }
    return { components, points: 0, contours: 0, depth: 0, instructions };
  };

  // Composite closure with cycle/depth rejection, resolving points/contours/depth
  // over components with memoisation. Unused glyphs are never parsed.
  const infos = new Map<number, GlyphInfo>();
  const resolve = (root: number): void => {
    if (infos.has(root)) return;
    const stack: { glyph: number; next: number }[] = [{ glyph: root, next: 0 }];
    const parsed = new Map<number, GlyphInfo>();
    const visiting = new Set<number>([root]);
    const infoOf = (glyph: number) => infos.get(glyph) ?? parsed.get(glyph)!;
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      let info = parsed.get(current.glyph);
      if (!info) { info = parseGlyph(current.glyph); parsed.set(current.glyph, info); }
      const child = info.components[current.next++];
      if (child === undefined) {
        let points = info.points, contours = info.contours, depth = 0;
        if (info.components.length) {
          points = 0; contours = 0;
          for (const component of info.components) {
            const childInfo = infoOf(component);
            points += childInfo.points; contours += childInfo.contours;
            if (!Number.isSafeInteger(points) || !Number.isSafeInteger(contours) || points > 0xffff || contours > 0xffff) fail('maxp composite counts exceed the representable uint16 range');
            depth = Math.max(depth, childInfo.depth + 1);
          }
        }
        if (depth > MAX_COMPOSITE_DEPTH) fail('composite glyph nesting exceeds the safe limit');
        infos.set(current.glyph, { ...info, points, contours, depth });
        visiting.delete(current.glyph);
        stack.pop();
        continue;
      }
      if (infos.has(child)) continue;
      if (visiting.has(child)) fail('cyclic composite glyph reference');
      if (stack.length >= MAX_COMPOSITE_DEPTH + 1) fail('composite glyph nesting exceeds the safe limit');
      visiting.add(child);
      stack.push({ glyph: child, next: 0 });
    }
  };
  const retained = new Set<number>([0, ...usedGlyphs]);
  for (const glyph of [...retained]) resolve(glyph);
  // resolve() registers every closure member it finished; pull them into retained.
  for (const glyph of infos.keys()) retained.add(glyph);

  let maxPoints = 0, maxContours = 0, maxCompositePoints = 0, maxCompositeContours = 0, maxComponentElements = 0, maxComponentDepth = 0, maxSizeOfInstructions = 0;
  for (const glyph of retained) {
    const info = infos.get(glyph)!;
    maxSizeOfInstructions = Math.max(maxSizeOfInstructions, info.instructions);
    maxComponentDepth = Math.max(maxComponentDepth, info.depth);
    if (info.components.length) {
      maxCompositePoints = Math.max(maxCompositePoints, info.points);
      maxCompositeContours = Math.max(maxCompositeContours, info.contours);
      maxComponentElements = Math.max(maxComponentElements, info.components.length);
    } else {
      maxPoints = Math.max(maxPoints, info.points);
      maxContours = Math.max(maxContours, info.contours);
    }
  }

  // Rebuild glyf/loca, preserving glyph order, IDs and the source loca format.
  const glyfParts: Uint8Array[] = [];
  const newOffsets = new Array<number>(glyphCount + 1);
  let position = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    newOffsets[glyph] = position;
    if (!retained.has(glyph)) continue;
    const { start, length } = glyphRange(glyph);
    if (!length) continue;
    glyfParts.push(bytes.subarray(start, start + length));
    position += length;
    const padding = (4 - position % 4) % 4;
    if (padding) { glyfParts.push(new Uint8Array(padding)); position += padding; }
  }
  newOffsets[glyphCount] = position;
  if (locaFormat === 0 && newOffsets.some((offset) => offset % 2 || offset / 2 > 0xffff)) fail('subset glyf table exceeds the short loca range');
  const newGlyf = new Uint8Array(position);
  let writeAt = 0;
  for (const part of glyfParts) { newGlyf.set(part, writeAt); writeAt += part.byteLength; }
  const newLoca = new Uint8Array((glyphCount + 1) * locaEntry);
  const locaView = new DataView(newLoca.buffer);
  newOffsets.forEach((offset, glyph) => { if (locaFormat === 0) locaView.setUint16(glyph * 2, offset / 2); else locaView.setUint32(glyph * 4, offset); });

  const newMaxp = new Uint8Array(bytes.subarray(maxp.start, maxp.start + maxp.length));
  const maxpView = new DataView(newMaxp.buffer, newMaxp.byteOffset, newMaxp.byteLength);
  const maxpFields: readonly (readonly [number, number])[] = [[6, maxPoints], [8, maxContours], [10, maxCompositePoints], [12, maxCompositeContours],
    [26, maxSizeOfInstructions], [28, maxComponentElements], [30, maxComponentDepth]];
  for (const [offset, value] of maxpFields) {
    if (!Number.isSafeInteger(value) || !integer(value, 0, 0xffff)) fail('maxp count exceeds the representable uint16 range');
    maxpView.setUint16(offset, value);
  }
  const newHead = new Uint8Array(bytes.subarray(head.start, head.start + head.length));
  new DataView(newHead.buffer, newHead.byteOffset, newHead.byteLength).setUint32(8, 0);

  const outTables: { tag: string; bytes: Uint8Array }[] = [];
  for (const range of tables.values()) {
    if (range.tag === 'DSIG') continue;
    if (range.tag === 'glyf') outTables.push({ tag: 'glyf', bytes: newGlyf });
    else if (range.tag === 'loca') outTables.push({ tag: 'loca', bytes: newLoca });
    else if (range.tag === 'maxp') outTables.push({ tag: 'maxp', bytes: newMaxp });
    else if (range.tag === 'head') outTables.push({ tag: 'head', bytes: newHead });
    else outTables.push({ tag: range.tag, bytes: bytes.subarray(range.start, range.start + range.length) });
  }
  outTables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const outLength = 12 + outTables.length * 16 + outTables.reduce((sum, entry) => sum + Math.ceil(entry.bytes.byteLength / 4) * 4, 0);
  if (outLength >= bytes.byteLength) fail('subset program is not smaller than the source program');
  const result = new Uint8Array(outLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.getUint32(0));
  view.setUint16(4, outTables.length);
  const selector = Math.floor(Math.log2(outTables.length)), searchRange = 2 ** selector * 16;
  view.setUint16(6, searchRange); view.setUint16(8, selector); view.setUint16(10, outTables.length * 16 - searchRange);
  let outPosition = 12 + outTables.length * 16, headPlaced = -1;
  outTables.forEach((entry, index) => {
    const at = 12 + index * 16, padded = Math.ceil(entry.bytes.byteLength / 4) * 4;
    result.set(entry.bytes, outPosition);
    for (let i = 0; i < 4; i++) view.setUint8(at + i, entry.tag.charCodeAt(i));
    view.setUint32(at + 4, checksum(view, outPosition, padded));
    view.setUint32(at + 8, outPosition); view.setUint32(at + 12, entry.bytes.byteLength);
    if (entry.tag === 'head') headPlaced = outPosition;
    outPosition += padded;
  });
  if (headPlaced < 0) fail('missing head table');
  view.setUint32(headPlaced + 8, (CHECKSUM_MAGIC - checksum(view, 0, result.byteLength)) >>> 0);

  // All-or-nothing self-check: the output must re-parse, keep every retained
  // glyph byte-identical, empty every other glyph and validate its checksum.
  const checkTables = directory(result);
  const checkData = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const checkHead = table(checkTables, 'head', 54), checkMaxp = table(checkTables, 'maxp', 32);
  const checkGlyf = table(checkTables, 'glyf', 0), checkLoca = table(checkTables, 'loca', 4);
  if (checkData.getUint16(checkMaxp.start + 4) !== glyphCount || checkData.getInt16(checkHead.start + 50) !== locaFormat) fail('subset self-check failed (header)');
  for (const [offset, value] of maxpFields) if (checkData.getUint16(checkMaxp.start + offset) !== value) fail('subset self-check failed (maxp)');
  if (checksum(checkData, 0, result.byteLength) !== CHECKSUM_MAGIC) fail('subset self-check failed (checksum)');
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const start = locaFormat === 0 ? checkData.getUint16(checkLoca.start + glyph * 2) * 2 : checkData.getUint32(checkLoca.start + glyph * 4);
    const end = locaFormat === 0 ? checkData.getUint16(checkLoca.start + (glyph + 1) * 2) * 2 : checkData.getUint32(checkLoca.start + (glyph + 1) * 4);
    const { start: sourceStart, length: sourceLength } = glyphRange(glyph);
    if (retained.has(glyph)) {
      // The loca span of a retained glyph is its data plus zero padding to the
      // next 4-byte boundary; the data prefix must be byte-identical.
      if (end - start < sourceLength || end - start > sourceLength + 3) fail('subset self-check failed (retained glyph length)');
      for (let i = 0; i < sourceLength; i++) if (result[checkGlyf.start + start + i] !== bytes[sourceStart + i]) fail('subset self-check failed (retained glyph bytes)');
      for (let i = sourceLength; i < end - start; i++) if (result[checkGlyf.start + start + i] !== 0) fail('subset self-check failed (glyph padding)');
    } else if (end !== start) fail('subset self-check failed (unused glyph not empty)');
  }
  return result;
}

/**
 * The program to embed for one face: the subset when the program permits it and
 * subsetting succeeds and shrinks the program; the whole source program in
 * every other case. Never throws and never returns a partial rebuild.
 */
export function embeddableFontProgram(bytes: Uint8Array, usedGlyphs: ReadonlySet<number>): Uint8Array {
  if (programNoSubsetting(bytes)) return bytes;
  try {
    const subset = subsetGlyfProgram(bytes, usedGlyphs);
    return subset.byteLength < bytes.byteLength ? subset : bytes;
  } catch { return bytes; }
}
