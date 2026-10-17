/** Hand-authored CFF (Type2) font fixtures. No installed/proprietary font bytes are included. */
import { createRequire } from 'node:module';
import type { NativeFontMetrics } from '../../src/core/text-metrics';
import type { PdfFontFace } from '../../src/io/pdf-fonts';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

/** Type2/Dict integer encoding shared by DICT operands and charstring operands. */
export function cffInt(value: number): number[] {
  if (!Number.isInteger(value)) throw new Error('CFF fixture numbers must be integers');
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) return [247 + Math.floor((value - 108) / 256), (value - 108) % 256];
  if (value >= -1131 && value <= -108) return [251 + Math.floor((-value - 108) / 256), (-value - 108) % 256];
  if (value >= -32768 && value <= 32767) return [28, (value >> 8) & 255, value & 255];
  return [29, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

const CHARSTRING_OPS: Record<string, readonly number[]> = {
  hstem: [1], vstem: [3], vmoveto: [4], rlineto: [5], hlineto: [6], vlineto: [7], rrcurveto: [8],
  callsubr: [10], return: [11], endchar: [14], hstemhm: [18], hintmask: [19], cntrmask: [20],
  rmoveto: [21], hmoveto: [22], vstemhm: [23], rcurveline: [24], rlinecurve: [25], vvcurveto: [26],
  hhcurveto: [27], callgsubr: [29], vhcurveto: [30], hvcurveto: [31],
  dotsection: [12, 0], hflex: [12, 34], flex: [12, 35], hflex1: [12, 36], flex1: [12, 37],
};

/** DICT real-number encoding (byte 30 + packed nibbles) for a decimal literal. */
export function cffReal(text: string): number[] {
  const nibbles: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char >= '0' && char <= '9') nibbles.push(char.charCodeAt(0) - 48);
    else if (char === '.') nibbles.push(10);
    else if (char === 'E' && text[i + 1] === '-') { nibbles.push(12); i++; }
    else if (char === 'E') nibbles.push(11);
    else if (char === '-') nibbles.push(14);
    else throw new Error(`Unsupported CFF fixture real literal ${text}`);
  }
  nibbles.push(15);
  const bytes = [30];
  for (let i = 0; i < nibbles.length; i += 2) bytes.push(nibbles[i]! * 16 + (nibbles[i + 1] ?? 15));
  return bytes;
}

/** One charstring token: an integer operand, an operator name, or raw bytes (e.g. a hintmask). */
export type CharstringToken = number | string | { raw: readonly number[] };
export function charstring(tokens: readonly CharstringToken[]): Buffer {
  const bytes: number[] = [];
  for (const token of tokens) {
    if (typeof token === 'number') bytes.push(...cffInt(token));
    else if (typeof token === 'string') {
      const op = CHARSTRING_OPS[token];
      if (!op) throw new Error(`Unknown fixture charstring operator ${token}`);
      bytes.push(...op);
    } else bytes.push(...token.raw);
  }
  return Buffer.from(bytes);
}

function index(buffers: readonly Buffer[]): Buffer {
  if (!buffers.length) return Buffer.from([0, 0]);
  let total = 1;
  const offsets = buffers.map((buffer) => { const at = total; total += buffer.length; return at; });
  const data = Buffer.alloc(2 + 1 + (buffers.length + 1) * 4 + buffers.reduce((sum, buffer) => sum + buffer.length, 0));
  data.writeUInt16BE(buffers.length, 0); data[2] = 4;
  [...offsets, total].forEach((offset, i) => data.writeUInt32BE(offset, 3 + i * 4));
  let position = 3 + (buffers.length + 1) * 4;
  for (const buffer of buffers) { buffer.copy(data, position); position += buffer.length; }
  return data;
}

function dict(entries: readonly (readonly number[])[]): Buffer {
  return Buffer.concat(entries.map((entry) => Buffer.from(entry)));
}
const dictOp = (operands: readonly number[], op: readonly number[]): number[] => [...operands.flatMap((value) => cffInt(value)), ...op];

export interface CffTableOptions {
  glyphs?: readonly Buffer[];
  globalSubrs?: readonly Buffer[];
  localSubrs?: readonly Buffer[];
  /** Adds a Registry/Ordering/Supplement top dict entry (a CID-keyed font). */
  ros?: boolean;
  /** CFF major version byte; 2 builds a CFF2-headed table for refusal tests. */
  major?: number;
  /** Charset encoding: 0 = SID array, 1 = uint8 range left-counts. */
  charsetFormat?: 0 | 1;
  /** Declared charset value when the caller wants a predefined/out-of-range charset offset. */
  charsetOffsetOverride?: number;
  /** Top DICT CharstringType value (12 6); only 2 (Type 2) may parse. */
  charstringType?: number;
  /** Top DICT PaintType value (12 5); nonzero must refuse. */
  paintType?: number;
  /** Adds a Top DICT SyntheticBase entry (12 20); its presence must refuse. */
  syntheticBase?: boolean;
  /** Top DICT FontMatrix (12 7) as six decimal literals, encoded as DICT reals. */
  fontMatrix?: readonly string[];
}

/** Default authored glyph set; advances/bearings live in the SFNT hmtx, not here. */
export function defaultCffGlyphs(capitalHeight = 730): Buffer[] {
  return [
    // .notdef: rectangle [0, 0, 500, 700].
    charstring([500, 0, 0, 'rmoveto', 500, 'hlineto', 700, 'vlineto', -500, 'hlineto', 'endchar']),
    // space: width only, no outline.
    charstring([300, 'endchar']),
    // A: rectangle [-20, 0, 620, capitalHeight].
    charstring([650, -20, 0, 'rmoveto', 640, 'hlineto', capitalHeight, 'vlineto', -640, 'hlineto', 'endchar']),
    // B: one curve whose control hull is [40, 0, 600, 700].
    charstring([650, 40, 0, 'rmoveto', 560, 0, 0, 350, 0, 350, 'rrcurveto', 'endchar']),
    // Composite-like glyph: its outline lives in local subr 0 ([0, -100, 700, 700]).
    charstring([650, -107, 'callsubr', 'endchar']),
    // Deprecated seac endchar form (width + 4 operands): bounds must come out unknown.
    charstring([650, 0, 0, 0, 2, 3, 'endchar']),
    // Global-subr glyph: global subr 0 draws [100, 100, 300, 400].
    charstring([650, -107, 'callgsubr', 'endchar']),
  ];
}

export function defaultLocalSubrs(): Buffer[] {
  return [charstring([0, -100, 'rmoveto', 700, 'hlineto', 800, 'vlineto', -700, 'hlineto', 'return'])];
}
export function defaultGlobalSubrs(): Buffer[] {
  return [charstring([100, 100, 'rmoveto', 200, 'hlineto', 300, 'vlineto', -200, 'hlineto', 'return'])];
}

/** A complete hand-built 'CFF ' table: header, name/top-dict/string/global-subr INDEXes, charset, CharStrings, Private+Subrs. */
export function buildCffTable(options: CffTableOptions = {}): Buffer {
  const glyphs = options.glyphs ?? defaultCffGlyphs();
  const globalSubrs = options.globalSubrs ?? defaultGlobalSubrs();
  const localSubrs = options.localSubrs ?? defaultLocalSubrs();
  const strings = options.ros ? [Buffer.from('Adobe'), Buffer.from('Identity')] : [];
  // Fixed-width (5-byte) integer encodings for every offset keep the two-pass layout stable.
  const fixed = (value: number) => [29, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const build = (charsetOffset: number, charStringsOffset: number, privateOffset: number, privateSize: number, subrsOffset: number): Buffer => {
    const topEntries: number[][] = [
      dictOp([-50, -200, 900, 1000], [5]),
      ...(options.charstringType !== undefined ? [dictOp([options.charstringType], [12, 6])] : []),
      ...(options.paintType !== undefined ? [dictOp([options.paintType], [12, 5])] : []),
      ...(options.syntheticBase ? [dictOp([0], [12, 20])] : []),
      ...(options.fontMatrix ? [[...options.fontMatrix.flatMap((value) => cffReal(value)), 12, 7]] : []),
      ...(options.ros ? [[...fixed(391), ...fixed(392), ...fixed(0), 12, 30]] : []),
      [...fixed(charsetOffset), 15],
      [...fixed(charStringsOffset), 17],
      [...fixed(privateSize), ...fixed(privateOffset), 18],
    ];
    const header = Buffer.from([options.major ?? 1, 0, 4, 4]);
    const nameIndex = index([Buffer.from('JCadCFFFixture', 'ascii')]);
    const topIndex = index([dict(topEntries)]);
    const stringIndex = index(strings);
    const globalSubrIndex = index(globalSubrs);
    const sids = [1, 34, 35, 36, 37, 38, 39, 40];
    let charset: Buffer;
    if ((options.charsetFormat ?? 0) === 0) {
      charset = Buffer.alloc(1 + (glyphs.length - 1) * 2);
      charset[0] = 0;
      for (let i = 1; i < glyphs.length; i++) charset.writeUInt16BE(sids[i - 1] ?? 1, 1 + (i - 1) * 2);
    } else {
      const ranges: [number, number][] = [];
      for (let i = 1; i < glyphs.length;) {
        const sid = sids[i - 1] ?? 1;
        let left = 0;
        while (i + left + 1 < glyphs.length && (sids[i + left] ?? 1) === sid + left + 1 && left < 255) left++;
        ranges.push([sid, left]); i += left + 1;
      }
      charset = Buffer.alloc(1 + ranges.length * 3);
      charset[0] = 1;
      ranges.forEach(([sid, left], i) => { charset.writeUInt16BE(sid, 1 + i * 3); charset[1 + i * 3 + 2] = left; });
    }
    const charStringsIndex = index(glyphs);
    const subrIndex = index(localSubrs);
    const privateDict = dict([dictOp([subrsOffset], [19])]);
    const parts: [Buffer, number][] = [];
    let position = 0;
    const place = (buffer: Buffer) => { parts.push([buffer, position]); position += buffer.length; };
    place(header); place(nameIndex); place(topIndex); place(stringIndex); place(globalSubrIndex);
    const charsetAt = position; place(charset);
    const charStringsAt = position; place(charStringsIndex);
    const privateAt = position; place(privateDict); place(subrIndex);
    if (charsetOffset === -1) {
      // The Private DICT size covers the DICT bytes only; the Subrs INDEX sits after
      // them (addressed by an offset relative to the Private start), outside the size.
      return build(options.charsetOffsetOverride ?? charsetAt, charStringsAt, privateAt, privateDict.length, privateDict.length);
    }
    if (charsetOffset !== (options.charsetOffsetOverride ?? charsetAt) || charStringsOffset !== charStringsAt || privateOffset !== privateAt
      || privateSize !== privateDict.length || subrsOffset !== privateDict.length) throw new Error('CFF fixture layout drift');
    const data = Buffer.alloc(position);
    for (const [buffer, at] of parts) buffer.copy(data, at);
    return data;
  };
  return build(-1, 0, 0, 0, 0);
}

function cffCmap12(alias = false): Buffer {
  // The alias form maps A and B to the SAME glyph (GID 2), and two supplementary
  // scalars to GID 4: the writer must still extract each scalar distinctly.
  const groups = alias
    ? [[32, 32, 1], [65, 65, 2], [66, 66, 2], [67, 67, 5], [68, 68, 6], [0x20000, 0x20000, 4], [0x20001, 0x20001, 4]]
    : [[32, 32, 1], [65, 66, 2], [67, 67, 5], [68, 68, 6], [0x20000, 0x20000, 4]];
  const data = Buffer.alloc(16 + groups.length * 12);
  data.writeUInt16BE(12, 0); data.writeUInt32BE(data.length, 4); data.writeUInt32BE(groups.length, 12);
  groups.forEach((group, i) => group.forEach((value, part) => data.writeUInt32BE(value, 16 + i * 12 + part * 4)));
  return data;
}

function cffCmap(alias = false): Buffer {
  // Format 4 mirrors the format 12 BMP coverage (per-segment idDeltas).
  const ends = alias ? [32, 65, 66, 0xffff] : [32, 66, 0xffff];
  const starts = alias ? [32, 65, 66, 0xffff] : [32, 65, 0xffff];
  const deltas = alias ? [-31, -63, -64, 1] : [-31, -63, 1];
  const segCount = ends.length, selector = Math.floor(Math.log2(segCount)), searchRange = 2 ** (selector + 1);
  const sub4 = Buffer.alloc(16 + segCount * 8);
  sub4.writeUInt16BE(4, 0); sub4.writeUInt16BE(sub4.length, 2); sub4.writeUInt16BE(segCount * 2, 6);
  sub4.writeUInt16BE(searchRange, 8); sub4.writeUInt16BE(selector, 10); sub4.writeUInt16BE(segCount * 2 - searchRange, 12);
  ends.forEach((value, i) => sub4.writeUInt16BE(value, 14 + i * 2));
  starts.forEach((value, i) => sub4.writeUInt16BE(value, 16 + segCount * 2 + i * 2));
  deltas.forEach((value, i) => sub4.writeInt16BE(value, 16 + segCount * 4 + i * 2));
  const sub12 = cffCmap12(alias), headerLength = 4 + 2 * 8, data = Buffer.alloc(headerLength + sub4.length + sub12.length);
  data.writeUInt16BE(2, 2);
  data.writeUInt16BE(3, 4); data.writeUInt16BE(1, 6); data.writeUInt32BE(headerLength, 8); sub4.copy(data, headerLength);
  data.writeUInt16BE(3, 12); data.writeUInt16BE(10, 14); data.writeUInt32BE(headerLength + sub4.length, 16); sub12.copy(data, headerLength + sub4.length);
  return data;
}

function cffNames(family: string, subfamily: string, postscriptName: string | null, extra: readonly (readonly [number, string])[] = []): Buffer {
  const entries: ReadonlyArray<readonly [number, string]> = [[1, family], [2, subfamily], [16, `${family} Typographic`], [17, `${subfamily} Typographic`], ...(postscriptName === null ? [] : [[6, postscriptName] as const]), ...extra];
  const strings = entries.map(([, value]) => Buffer.from(value, 'utf16le').swap16());
  const storage = 6 + entries.length * 12, data = Buffer.alloc(storage + strings.reduce((sum, value) => sum + value.length, 0));
  data.writeUInt16BE(entries.length, 2); data.writeUInt16BE(storage, 4);
  let position = 0;
  entries.forEach(([id], i) => {
    const at = 6 + i * 12;
    data.writeUInt16BE(3, at); data.writeUInt16BE(1, at + 2); data.writeUInt16BE(0x0409, at + 4);
    data.writeUInt16BE(id, at + 6); data.writeUInt16BE(strings[i]!.length, at + 8); data.writeUInt16BE(position, at + 10);
    strings[i]!.copy(data, storage + position); position += strings[i]!.length;
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

/** A PdfFontFace-shaped CFF face for writer tests: real metrics from the electron parser. */
export function cffPdfFontFixture(options: CffFontFixtureOptions = {}): Omit<PdfFontFace, 'key'> {
  const bytes = cffFontFixture({ fsType: 8, ...options });
  const metrics = parseFontMetrics(bytes);
  return {
    bytes, metrics, outline: 'cff',
    postscriptName: options.postscriptName === undefined ? 'JCadCFFFixture-Regular' : options.postscriptName ?? '',
    ascender: 1000, descender: -200, italicAngle: options.italicAngle ?? (options.italic ? -12 : 0),
    weight: options.bold ? 700 : 400, isFixedPitch: false, os2Version: options.os2Version ?? 2,
  };
}

export interface CffFontFixtureOptions {
  family?: string;
  subfamily?: string;
  bold?: boolean;
  italic?: boolean;
  fsType?: number;
  os2Version?: number;
  capitalHeight?: number;
  postscriptName?: string | null;
  italicAngle?: number;
  /** cmap maps two BMP scalars (A, B) to one GID, and two supplementary scalars to one GID. */
  alias?: boolean;
  cff?: CffTableOptions;
  /** Replace the whole 'CFF ' table (mutation tests). */
  cffTable?: Buffer;
  /** Additional authored tables for combined-format refusal cases. */
  extraTables?: Record<string, Buffer>;
  /** Names referenced by additional authored tables. */
  extraNames?: readonly (readonly [number, string])[];
}

/** A standalone OTTO-flavoured SFNT whose outlines live in a hand-built CFF table (7 glyphs). */
export function cffFontFixture(options: CffFontFixtureOptions = {}): Buffer {
  const capitalHeight = options.capitalHeight ?? 730;
  const bold = !!options.bold, italic = !!options.italic;
  const subfamily = options.subfamily ?? (bold ? italic ? 'Bold Italic' : 'Bold' : italic ? 'Italic' : 'Regular');
  const glyphCount = (options.cff?.glyphs ?? defaultCffGlyphs(capitalHeight)).length;
  const head = Buffer.alloc(54), maxp = Buffer.alloc(6), hhea = Buffer.alloc(36), os2 = Buffer.alloc(96);
  const metricsCount = 3, hmtx = Buffer.alloc(metricsCount * 4 + (glyphCount - metricsCount) * 2), post = Buffer.alloc(32);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1000, 18);
  [-50, -200, 900, 1000].forEach((value, i) => head.writeInt16BE(value, 36 + i * 2));
  head.writeUInt16BE((bold ? 1 : 0) | (italic ? 2 : 0), 44);
  maxp.writeUInt32BE(0x00005000, 0); maxp.writeUInt16BE(glyphCount, 4);
  hhea.writeUInt32BE(0x00010000, 0); hhea.writeInt16BE(1000, 4); hhea.writeInt16BE(-200, 6); hhea.writeUInt16BE(650, 10); hhea.writeInt16BE(1, 18); hhea.writeUInt16BE(metricsCount, 34);
  os2.writeUInt16BE(options.os2Version ?? 2, 0); os2.writeUInt16BE(bold ? 700 : 400, 4); os2.writeUInt16BE(options.fsType ?? 0, 8);
  os2.writeUInt16BE((bold ? 32 : 0) | (italic ? 1 : 0), 62); os2.writeUInt16BE(240, 76); os2.writeInt16BE(700, 88);
  [500, 300, 650].forEach((value, i) => hmtx.writeUInt16BE(value, i * 4));
  hmtx.writeInt16BE(-20, 10); hmtx.writeInt16BE(40, 12);
  post.writeUInt32BE(0x00030000, 0); post.writeInt32BE(Math.round((options.italicAngle ?? (italic ? -12 : 0)) * 65536), 4);
  const cff = options.cffTable ?? buildCffTable({ ...options.cff, glyphs: options.cff?.glyphs ?? defaultCffGlyphs(capitalHeight) });
  const tables: [string, Buffer][] = [
    ['CFF ', cff], ['OS/2', os2], ['cmap', cffCmap(options.alias)], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['maxp', maxp],
    ['name', cffNames(options.family ?? 'JCad CFF Fixture', subfamily, options.postscriptName === undefined ? 'JCadCFFFixture-Regular' : options.postscriptName, options.extraNames)], ['post', post],
    ...Object.entries(options.extraTables ?? {}),
  ];
  const data = Buffer.alloc(12 + tables.length * 16 + tables.reduce((sum, [, bytes]) => sum + Math.ceil(bytes.length / 4) * 4, 0));
  data.writeUInt32BE(0x4f54544f, 0); data.writeUInt16BE(tables.length, 4);
  const selector = Math.floor(Math.log2(tables.length)), searchRange = 2 ** selector * 16;
  data.writeUInt16BE(searchRange, 6); data.writeUInt16BE(selector, 8); data.writeUInt16BE(tables.length * 16 - searchRange, 10);
  let position = 12 + tables.length * 16, headOffset = 0;
  tables.forEach(([tag, bytes], i) => {
    const record = 12 + i * 16;
    if (tag === 'head') headOffset = position;
    data.write(tag, record, 'ascii'); data.writeUInt32BE(checksum(bytes), record + 4); data.writeUInt32BE(position, record + 8); data.writeUInt32BE(bytes.length, record + 12);
    bytes.copy(data, position); position += Math.ceil(bytes.length / 4) * 4;
  });
  data.writeUInt32BE((0xb1b0afba - checksum(data)) >>> 0, headOffset + 8);
  return data;
}

