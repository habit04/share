/** Hand-authored binary metadata fixtures. No installed/proprietary font bytes are included. */
type Box = readonly [number, number, number, number];
export interface NativeFontFixtureOptions {
  family?: string;
  subfamily?: string;
  bold?: boolean;
  italic?: boolean;
  fsType?: number;
  capitalHeight?: number;
  declaredCapHeight?: number;
  winDescent?: number;
  shortLoca?: boolean;
  format12?: boolean;
  onlyFormat12?: boolean;
  rangeOffset?: boolean;
  missingB?: boolean;
  composite?: boolean;
  compositeFlags?: number;
  extraGlyphs?: readonly Buffer[];
  /** Additional single-code BMP cmap format 4 segments: [codepoint, glyph] pairs, codes >= 0x100, non-overlapping. */
  cmapExtra?: readonly (readonly [number, number])[];
  bitmapGlyphRange?: readonly [number, number];
}

export function simpleGlyph(box: Box): Buffer {
  const data = Buffer.alloc(34);
  data.writeInt16BE(1, 0);
  box.forEach((value, index) => data.writeInt16BE(value, 2 + index * 2));
  data.writeUInt16BE(3, 10);
  data.fill(1, 14, 18);
  const points = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  for (let axis = 0; axis < 2; axis++) {
    let previous = 0;
    for (let i = 0; i < points.length; i++) {
      data.writeInt16BE(points[i]![axis]! - previous, 18 + axis * 8 + i * 2);
      previous = points[i]![axis]!;
    }
  }
  return data;
}

export function compositeGlyph(child: number, box: Box, flags = 2): Buffer {
  const data = Buffer.alloc(16);
  data.writeInt16BE(-1, 0);
  box.forEach((value, index) => data.writeInt16BE(value, 2 + index * 2));
  data.writeUInt16BE(flags, 10);
  data.writeUInt16BE(child, 12);
  return data;
}

function cmap4(rangeOffset: boolean, missingB: boolean, extra: readonly (readonly [number, number])[] = []): Buffer {
  const segments = [
    { start: 32, end: 32, delta: -31, range: false },
    { start: 65, end: 66, delta: rangeOffset ? 1 : -63, range: rangeOffset },
    ...extra.map(([code, glyph]) => ({ start: code, end: code, delta: glyph - code, range: false })),
    { start: 0xffff, end: 0xffff, delta: 1, range: false },
  ].sort((a, b) => a.end - b.end);
  const count = segments.length, segBytes = count * 2;
  const data = Buffer.alloc(16 + count * 8 + (rangeOffset ? 4 : 0));
  const selector = Math.floor(Math.log2(count)), searchRange = 2 ** selector * 2;
  data.writeUInt16BE(4, 0); data.writeUInt16BE(data.length, 2);
  data.writeUInt16BE(segBytes, 6); data.writeUInt16BE(searchRange, 8); data.writeUInt16BE(selector, 10); data.writeUInt16BE(segBytes - searchRange, 12);
  segments.forEach((segment, i) => data.writeUInt16BE(segment.end, 14 + i * 2));
  segments.forEach((segment, i) => data.writeUInt16BE(segment.start, 16 + segBytes + i * 2));
  segments.forEach((segment, i) => data.writeInt16BE(segment.delta, 16 + segBytes * 2 + i * 2));
  segments.forEach((segment, i) => data.writeUInt16BE(segment.range ? 4 : 0, 16 + segBytes * 3 + i * 2));
  if (rangeOffset) {
    const glyphAt = 16 + segBytes * 4;
    data.writeUInt16BE(1, glyphAt);
    data.writeUInt16BE(missingB ? 0 : 2, glyphAt + 2);
  }
  return data;
}

/**
 * One contour whose points all sit on one corner of the stored box: real point
 * work for the parser's decode/validate pass, at minimal byte cost, because a
 * zero-delta flag run encodes 256 points in two bytes. A glyph holds at most
 * 65,536 points (uint16 contour endpoints), so over-cap faces are assembled
 * from many such glyphs rather than one huge glyph.
 */
export function manyPointGlyph(points: number, box: Box = [0, 0, 100, 100]): Buffer {
  if (!Number.isInteger(points) || points < 1 || points > 65536) throw new Error('Invalid many-point glyph size');
  const runs = Math.ceil(points / 256), data = Buffer.alloc(14 + runs * 2);
  data.writeInt16BE(1, 0);
  box.forEach((value, index) => data.writeInt16BE(value, 2 + index * 2));
  data.writeUInt16BE(points - 1, 10);
  data.writeUInt16BE(0, 12);
  let position = 14;
  for (let remaining = points; remaining > 0; remaining -= 256) {
    data[position++] = 0x39; // on-curve, repeat-run, zero x/y deltas
    data[position++] = Math.min(remaining, 256) - 1;
  }
  return data;
}

function cmap12(): Buffer {
  const data = Buffer.alloc(52);
  data.writeUInt16BE(12, 0); data.writeUInt32BE(data.length, 4); data.writeUInt32BE(3, 12);
  [[32, 32, 1], [65, 66, 2], [0x1f600, 0x1f600, 4]].forEach((group, index) => group.forEach((value, part) => data.writeUInt32BE(value, 16 + index * 12 + part * 4)));
  return data;
}

function names(family: string, subfamily: string): Buffer {
  const entries = [[1, family], [2, subfamily], [16, `${family} Typographic`], [17, `${subfamily} Typographic`]] as const;
  const strings = entries.map(([, value]) => Buffer.from(value, 'utf16le').swap16());
  const storage = 6 + entries.length * 12, data = Buffer.alloc(storage + strings.reduce((sum, value) => sum + value.length, 0));
  data.writeUInt16BE(entries.length, 2); data.writeUInt16BE(storage, 4);
  let position = 0;
  entries.forEach(([id], index) => {
    const offset = 6 + index * 12;
    data.writeUInt16BE(3, offset); data.writeUInt16BE(1, offset + 2); data.writeUInt16BE(0x0409, offset + 4);
    data.writeUInt16BE(id, offset + 6); data.writeUInt16BE(strings[index]!.length, offset + 8); data.writeUInt16BE(position, offset + 10);
    strings[index]!.copy(data, storage + position);
    position += strings[index]!.length;
  });
  return data;
}

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let i = 0; i < 4; i++) word = (word * 256 + (bytes[offset + i] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

/** A monochrome one-pixel strike with hand-authored small metrics and format1 offsets. */
function bitmapTables([first, last]: readonly [number, number]): Record<string, Buffer> {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last - first > 16) throw new Error('Invalid bitmap fixture range');
  const glyphs = last - first + 1, ebdt = Buffer.alloc(4 + glyphs * 6), eblc = Buffer.alloc(72 + (glyphs + 1) * 4);
  ebdt.writeUInt32BE(0x00020000, 0); eblc.writeUInt32BE(0x00020000, 0); eblc.writeUInt32BE(1, 4);
  eblc.writeUInt32BE(56, 8); eblc.writeUInt32BE(eblc.length - 56, 12); eblc.writeUInt32BE(1, 16);
  eblc.writeUInt16BE(first, 48); eblc.writeUInt16BE(last, 50);
  eblc[52] = 12; eblc[53] = 12; eblc[54] = 1; eblc[55] = 1;
  eblc.writeUInt16BE(first, 56); eblc.writeUInt16BE(last, 58); eblc.writeUInt32BE(8, 60);
  eblc.writeUInt16BE(1, 64); eblc.writeUInt16BE(1, 66); eblc.writeUInt32BE(4, 68);
  for (let i = 0; i <= glyphs; i++) eblc.writeUInt32BE(i * 6, 72 + i * 4);
  for (let i = 0; i < glyphs; i++) { const at = 4 + i * 6; ebdt[at] = 1; ebdt[at + 1] = 1; ebdt[at + 3] = 1; ebdt[at + 4] = 1; ebdt[at + 5] = 0x80; }
  return { EBDT: ebdt, EBLC: eblc };
}

export function nativeFontFixture(options: NativeFontFixtureOptions = {}): Buffer {
  const capitalHeight = options.capitalHeight ?? 730;
  const glyphs = [simpleGlyph([0, 0, 500, 700]), Buffer.alloc(0), simpleGlyph([-20, 0, 620, capitalHeight]), simpleGlyph([40, 0, 600, 700]), options.composite ? compositeGlyph(2, [-20, 0, 620, capitalHeight], options.compositeFlags) : simpleGlyph([0, -100, 700, 700]), ...(options.extraGlyphs ?? [])];
  const head = Buffer.alloc(54), maxp = Buffer.alloc(32), hhea = Buffer.alloc(36), os2 = Buffer.alloc(96), hmtx = Buffer.alloc(12 + (glyphs.length - 3) * 2), loca = Buffer.alloc((glyphs.length + 1) * (options.shortLoca ? 2 : 4)), post = Buffer.alloc(32);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1000, 18);
  [-50, -200, 900, 1000].forEach((value, i) => head.writeInt16BE(value, 36 + i * 2));
  head.writeUInt16BE((options.bold ? 1 : 0) | (options.italic ? 2 : 0), 44); head.writeInt16BE(options.shortLoca ? 0 : 1, 50);
  maxp.writeUInt32BE(0x00010000, 0); maxp.writeUInt16BE(glyphs.length, 4); maxp.writeUInt16BE(4, 6); maxp.writeUInt16BE(1, 8); maxp.writeUInt16BE(2, 14);
  maxp.writeUInt16BE(1, 28); maxp.writeUInt16BE(1, 30);
  hhea.writeUInt32BE(0x00010000, 0); hhea.writeInt16BE(1000, 4); hhea.writeInt16BE(-200, 6); hhea.writeUInt16BE(650, 10); hhea.writeInt16BE(1, 18); hhea.writeUInt16BE(3, 34);
  os2.writeUInt16BE(2, 0); os2.writeUInt16BE(options.bold ? 700 : 400, 4); os2.writeUInt16BE(options.fsType ?? 0, 8);
  os2.writeUInt16BE((options.bold ? 32 : 0) | (options.italic ? 1 : 0), 62); os2.writeInt16BE(options.declaredCapHeight ?? 700, 88);
  os2.writeUInt16BE(options.winDescent ?? 240, 76);
  [500, 300, 650].forEach((value, i) => hmtx.writeUInt16BE(value, i * 4));
  hmtx.writeInt16BE(-20, 10); hmtx.writeInt16BE(40, 12);
  post.writeUInt32BE(0x00030000, 0);
  let position = 0;
  for (let i = 0; i <= glyphs.length; i++) {
    if (options.shortLoca) loca.writeUInt16BE(position / 2, i * 2); else loca.writeUInt32BE(position, i * 4);
    position += glyphs[i]?.length ?? 0;
  }
  const sub4 = cmap4(!!options.rangeOffset, !!options.missingB, options.cmapExtra ?? []), sub12 = options.format12 || options.onlyFormat12 ? cmap12() : null;
  const encodingCount = options.onlyFormat12 ? 1 : sub12 ? 2 : 1, headerLength = 4 + encodingCount * 8, cmap = Buffer.alloc(headerLength + (options.onlyFormat12 ? 0 : sub4.length) + (sub12?.length ?? 0));
  cmap.writeUInt16BE(encodingCount, 2);
  if (!options.onlyFormat12) { cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(headerLength, 8); sub4.copy(cmap, headerLength); }
  if (sub12) { const offset = options.onlyFormat12 ? 4 : 12; cmap.writeUInt16BE(3, offset); cmap.writeUInt16BE(10, offset + 2); cmap.writeUInt32BE(headerLength + (options.onlyFormat12 ? 0 : sub4.length), offset + 4); sub12.copy(cmap, headerLength + (options.onlyFormat12 ? 0 : sub4.length)); }
  const tables = Object.entries({ 'OS/2': os2, cmap, glyf: Buffer.concat(glyphs), head, hhea, hmtx, loca, maxp, name: names(options.family ?? 'JCad Fixture', options.subfamily ?? (options.bold ? options.italic ? 'Bold Italic' : 'Bold' : options.italic ? 'Italic' : 'Regular')), post,
    ...(options.bitmapGlyphRange ? bitmapTables(options.bitmapGlyphRange) : {}) });
  const data = Buffer.alloc(12 + tables.length * 16 + tables.reduce((sum, [, bytes]) => sum + Math.ceil(bytes.length / 4) * 4, 0));
  data.writeUInt32BE(0x00010000, 0); data.writeUInt16BE(tables.length, 4); data.writeUInt16BE(128, 6); data.writeUInt16BE(3, 8); data.writeUInt16BE(tables.length * 16 - 128, 10);
  position = 12 + tables.length * 16;
  tables.forEach(([tag, bytes], i) => {
    const record = 12 + i * 16;
    data.write(tag, record, 'ascii'); data.writeUInt32BE(checksum(bytes), record + 4); data.writeUInt32BE(position, record + 8); data.writeUInt32BE(bytes.length, record + 12);
    bytes.copy(data, position); position += Math.ceil(bytes.length / 4) * 4;
  });
  data.writeUInt32BE((0xb1b0afba - checksum(data)) >>> 0, fontTable(data, 'head').offset + 8);
  return data;
}

export function fontTable(data: Buffer, tag: string, faceIndex = 0): { record: number; offset: number; length: number } {
  const base = data.toString('ascii', 0, 4) === 'ttcf' ? data.readUInt32BE(12 + faceIndex * 4) : 0;
  for (let i = 0; i < data.readUInt16BE(base + 4); i++) {
    const record = base + 12 + i * 16;
    if (data.toString('ascii', record, record + 4) === tag) return { record, offset: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) };
  }
  throw new Error(`No fixture table ${tag}`);
}

function collection(version: number, faces: Buffer[]): Buffer {
  const header = 12 + faces.length * 4 + (version === 0x00020000 ? 12 : 0), data = Buffer.alloc(header + faces.reduce((sum, font) => sum + Math.ceil(font.length / 4) * 4, 0));
  data.write('ttcf', 0, 'ascii'); data.writeUInt32BE(version, 4); data.writeUInt32BE(faces.length, 8);
  let position = header;
  faces.forEach((font, index) => {
    data.writeUInt32BE(position, 12 + index * 4); font.copy(data, position);
    for (let i = 0; i < font.readUInt16BE(4); i++) data.writeUInt32BE(font.readUInt32BE(12 + i * 16 + 8) + position, position + 12 + i * 16 + 8);
    position += Math.ceil(font.length / 4) * 4;
  });
  return data;
}

export function fontCollection(...faces: Buffer[]): Buffer { return collection(0x00010000, faces); }
export function fontCollectionV2(...faces: Buffer[]): Buffer { return collection(0x00020000, faces); }
