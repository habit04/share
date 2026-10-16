import { supportsNativeTextRun, type NativeFontMetrics } from '../core/text-metrics';
import { embeddableFontProgram } from './pdf-font-subset';

/** Installed font programs live only in one captured plot, never in a DrawingState. */
export interface PdfFontFace {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly metrics: NativeFontMetrics;
  readonly postscriptName: string;
  readonly ascender: number;
  readonly descender: number;
  readonly italicAngle: number;
  readonly weight: number;
  readonly isFixedPitch: boolean;
  readonly os2Version: number;
}

export interface PdfFontRun {
  readonly resourceName: string;
  /** Hexadecimal two-byte CIDs, without PDF angle brackets. */
  readonly hex: string;
  /** Advance in the font's original units; divide by unitsPerEm for em units. */
  readonly advance: number;
  readonly glyphs: readonly number[];
}
export interface PdfFontObjectWriter {
  reserve(): number;
  set(num: number, body: string | Uint8Array[]): void;
}

const MAX_FACES = 8;
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CIDS = 65534;
const enc = new TextEncoder();
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const num = (n: number) => Number(n.toFixed(6)).toString();
const fail = (problem: string): never => { throw new Error(`PDF font: ${problem}`); };
const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
const denseArray = (values: readonly unknown[] | undefined, length?: number) => {
  if (!Array.isArray(values) || length !== undefined && values.length !== length) return false;
  for (let i = 0; i < values.length; i++) if (!Object.hasOwn(values, i)) return false;
  return true;
};

/** Version-aware OS/2 permission gate; full fonts also satisfy the no-subsetting flag. */
export function pdfFontEmbeddingProblem(fsType: number, os2Version: number): string | null {
  if (!integer(fsType, 0, 65535) || !integer(os2Version, 0, 5)) return 'invalid embedding permissions';
  if (fsType & 1) return 'reserved embedding permission bit';
  if (os2Version >= 2 && (fsType & 0xfcf0)) return 'reserved embedding permission bits';
  if (os2Version >= 2 && (fsType & 0x0200)) return 'bitmap-only embedding';
  const permission = fsType & 14;
  if (os2Version >= 3 && permission !== 0 && permission !== 2 && permission !== 4 && permission !== 8) return 'conflicting embedding permissions';
  // OS/2 versions 0..2 permit the least restrictive of multiple usage permissions.
  if (permission & 8) return null;
  if (permission & 4) return 'preview/print embedding requires a read-only PDF';
  if (permission & 2) return 'restricted font embedding';
  return null;
}

/** Check the actual SFNT permission/format fields, rather than trusting a metrics cache. */
function validateFace(face: PdfFontFace): string | null {
  if (!face || typeof face.key !== 'string' || !face.key || face.key.length > 512 || /[\u0000-\u001f]/.test(face.key)) fail('invalid face key');
  if (!(face.bytes instanceof Uint8Array) || face.bytes.byteLength < 12 || face.bytes.byteLength > MAX_FONT_BYTES) fail('font program must contain 12 bytes to 64 MiB');
  const data = new DataView(face.bytes.buffer, face.bytes.byteOffset, face.bytes.byteLength);
  const signature = data.getUint32(0);
  if (signature === 0x74746366) return 'TrueType collections are not supported for embedding';
  if (signature !== 0x00010000 && signature !== 0x74727565) return 'standalone TrueType glyf outlines required';
  const count = data.getUint16(4);
  if (!count || count > 128 || 12 + count * 16 > data.byteLength) fail('invalid SFNT directory');
  const tables = new Map<string, { start: number; length: number }>();
  const ranges: { start: number; length: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...face.bytes.subarray(at, at + 4));
    const start = data.getUint32(at + 8), length = data.getUint32(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tables.has(tag) || start % 4 || start > data.byteLength || length > data.byteLength - start || length && start < 12 + count * 16) fail('invalid SFNT table');
    tables.set(tag, { start, length });
    if (length) ranges.push({ start, length });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1]!.start + ranges[i - 1]!.length)) fail('overlapping SFNT tables');
  if (tables.has('CFF ') || tables.has('CFF2') || tables.has('fvar')) return 'CFF and variable fonts are not supported for embedding';
  for (const tag of ['COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC']) if (tables.has(tag)) return `bitmap/color font tables are not supported for embedding (${tag.trim()})`;
  if (tables.has('EBSC')) return 'embedded bitmap scaling is not supported for embedding';
  const table = (tag: string, length: number) => {
    const found = tables.get(tag);
    if (!found || found.length < length) return fail(`missing or truncated ${tag} table`);
    return found.start;
  };
  const head = table('head', 54), os2 = table('OS/2', 78), maxp = table('maxp', 32), hhea = table('hhea', 36), post = table('post', 32);
  table('glyf', 0); table('loca', 4); table('hmtx', 4); table('cmap', 4); table('name', 6);
  const metrics = face.metrics, glyphCount = data.getUint16(maxp + 4);
  const fsType = data.getUint16(os2 + 8), os2Version = data.getUint16(os2);
  if (!metrics || metrics.fsType !== fsType || face.os2Version !== os2Version) fail('font permissions do not match the program');
  const permission = pdfFontEmbeddingProblem(fsType, os2Version);
  if (permission) return permission;
  if (!integer(metrics.unitsPerEm, 16, 16384) || metrics.unitsPerEm !== data.getUint16(head + 18) || !integer(metrics.capitalHeight, 1, 32767)) fail('invalid native font height');
  if (!glyphCount || !denseArray(metrics.advances, glyphCount) || metrics.advances.some((n) => !integer(n, 0, 65535))) fail('invalid native advances');
  if (!denseArray(metrics.cmap, 65536) || metrics.cmap.some((n) => !integer(n, 0, glyphCount - 1))) fail('invalid native cmap');
  if (!denseArray(metrics.groups) || metrics.groups.length > 65536) fail('invalid native cmap groups');
  let previous = -1;
  for (const group of metrics.groups) {
    if (!denseArray(group, 3) || !integer(group[0], 0, 0x10ffff) || !integer(group[1], group[0], 0x10ffff) || group[0] <= previous || group[0] <= 0xdfff && group[1] >= 0xd800 || !integer(group[2], 0, glyphCount - 1) || group[2] + group[1] - group[0] >= glyphCount) fail('invalid native cmap group');
    previous = group[1];
  }
  if (metrics.glyphBoundsKnown !== undefined && (!denseArray(metrics.glyphBoundsKnown, glyphCount) || metrics.glyphBoundsKnown.some((n) => typeof n !== 'boolean'))) fail('invalid glyph origin flags');
  if (!denseArray(metrics.glyphBounds, glyphCount) || metrics.glyphBounds.some((box) => !denseArray(box, 4) || box.some((n) => !integer(n, -98303, 98303)) || box[0] > box[2] || box[1] > box[3])) fail('invalid native glyph bounds');
  const glyphA = metrics.cmap[65] || glyphIndex(metrics, 65);
  if (!glyphA || metrics.glyphBoundsKnown?.[glyphA] === false || metrics.glyphBounds[glyphA]![3] !== metrics.capitalHeight) fail('invalid native capital height');
  if (!denseArray(metrics.fontBounds, 4) || metrics.fontBounds.some((n) => !integer(n, -32768, 32767)) || metrics.fontBounds[0] > metrics.fontBounds[2] || metrics.fontBounds[1] > metrics.fontBounds[3] || metrics.fontBounds.some((n, i) => n !== data.getInt16(head + 36 + i * 2))) fail('invalid font bounding box');
  if (typeof metrics.bold !== 'boolean' || typeof metrics.italic !== 'boolean') fail('invalid font face flags');
  if (tables.has('EBLC') || tables.has('EBDT')) {
    const locations = table('EBLC', 8), bitmap = table('EBDT', 4), strikes = data.getUint32(locations + 4);
    if (data.getUint32(locations) !== 0x00020000 || data.getUint32(bitmap) !== 0x00020000 || !strikes || strikes > 128 || tables.get('EBLC')!.length < 8 + strikes * 48) fail('invalid native bitmap locations');
    const coverage = new Int32Array(glyphCount + 1);
    for (let i = 0; i < strikes; i++) {
      const at = locations + 8 + i * 48, first = data.getUint16(at + 40), last = data.getUint16(at + 42);
      if (first > last || last >= glyphCount) fail('invalid native bitmap glyph range');
      coverage[first] = coverage[first]! + 1; coverage[last + 1] = coverage[last + 1]! - 1;
    }
    let strikesAtGlyph = 0;
    for (let glyph = 0; glyph < glyphCount; glyph++) {
      strikesAtGlyph += coverage[glyph]!;
      if (strikesAtGlyph && metrics.glyphBoundsKnown?.[glyph] !== false) fail('bitmap glyph origins must use fallback');
    }
  }
  if (typeof face.postscriptName !== 'string' || !/^[\x21-\x7e]{1,63}$/.test(face.postscriptName) || /[[\](){}<>/%]/.test(face.postscriptName)) fail('invalid PostScript font name');
  const nameStart = table('name', 6), nameLength = tables.get('name')!.length, nameVersion = data.getUint16(nameStart), names = data.getUint16(nameStart + 2), storage = data.getUint16(nameStart + 4);
  if (nameVersion > 1 || !names || names > 4096 || 6 + names * 12 > nameLength || storage < 6 + names * 12 || storage > nameLength) fail('invalid native name records');
  let nativeName: string | undefined;
  for (let i = 0; i < names; i++) {
    const at = nameStart + 6 + i * 12, platform = data.getUint16(at), encoding = data.getUint16(at + 2), id = data.getUint16(at + 6);
    const length = data.getUint16(at + 8), offset = storage + data.getUint16(at + 10);
    if (offset > nameLength || length > nameLength - offset) fail('invalid native name string');
    if (id !== 6) continue;
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    if (!unicode && !(platform === 1 && encoding === 0)) continue;
    if (!length || length > (unicode ? 126 : 63) || unicode && length % 2) fail('invalid native PostScript nameID6');
    let value: string;
    try { value = new TextDecoder(unicode ? 'utf-16be' : 'macintosh', { fatal: true }).decode(face.bytes.subarray(nameStart + offset, nameStart + offset + length)); }
    catch { return fail('invalid native PostScript nameID6 encoding'); }
    if (!/^[\x21-\x7e]{1,63}$/.test(value) || /[[\](){}<>/%]/.test(value) || nativeName !== undefined && nativeName !== value) fail('invalid or conflicting native PostScript nameID6');
    nativeName = value;
  }
  if (nativeName !== face.postscriptName) fail('PostScript nameID6 does not match the program');
  if (!integer(face.ascender, 0, 32767) || !integer(face.descender, -32768, 0) || face.ascender !== data.getInt16(hhea + 4) || face.descender !== data.getInt16(hhea + 6)) fail('font vertical metrics do not match the program');
  if (!Number.isFinite(face.italicAngle) || Math.abs(face.italicAngle) > 90 || face.italicAngle !== data.getInt32(post + 4) / 65536 || !integer(face.weight, 1, 1000) || face.weight !== data.getUint16(os2 + 4) || typeof face.isFixedPitch !== 'boolean' || face.isFixedPitch !== !!data.getUint32(post + 12)) fail('font descriptor does not match the program');
  if (![0x00010000, 0x00020000, 0x00025000, 0x00030000].includes(data.getUint32(post))) fail('unsupported post table version');
  return null;
}

function glyphIndex(font: NativeFontMetrics, code: number): number {
  if (code <= 0xffff && font.cmap[code]) return font.cmap[code]!;
  let lo = 0, hi = font.groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, group = font.groups[mid]!;
    if (code < group[0]) hi = mid - 1;
    else if (code > group[1]) lo = mid + 1;
    else return group[2] + code - group[0];
  }
  return 0;
}

interface UsedFace {
  face: PdfFontFace;
  name: string;
  codes: Map<number, { cid: number; glyph: number }>;
}

/** Mutable CID assignment is private to one plot. Failed runs cannot reserve partial resources. */
export class PdfFontRegistry {
  private faces = new Map<string, PdfFontFace>();
  private used = new Map<string, UsedFace>();
  readonly rejections: ReadonlyMap<string, string>;

  constructor(faces: readonly PdfFontFace[]) {
    if (!Array.isArray(faces) || faces.length > MAX_FACES) fail('at most eight font faces are allowed');
    const rejected = new Map<string, string>(), keys = new Set<string>();
    let total = 0;
    // Preflight the aggregate budget before allocating any owned font-program snapshots.
    for (const face of faces) {
      if (!face || !(face.bytes instanceof Uint8Array)) fail('invalid font program');
      total += face.bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) fail('font programs exceed 128 MiB');
    }
    for (const face of faces) {
      const problem = validateFace(face);
      if (keys.has(face.key)) fail('duplicate font face key');
      keys.add(face.key);
      if (problem) { rejected.set(face.key, problem); continue; }
      const metrics: NativeFontMetrics = { ...face.metrics, advances: [...face.metrics.advances], cmap: [...face.metrics.cmap], groups: face.metrics.groups.map((group) => [...group] as [number, number, number]), fontBounds: [...face.metrics.fontBounds] as [number, number, number, number], glyphBounds: face.metrics.glyphBounds.map((box) => [...box] as [number, number, number, number]), glyphBoundsKnown: face.metrics.glyphBoundsKnown ? [...face.metrics.glyphBoundsKnown] : undefined };
      this.faces.set(face.key, { ...face, bytes: new Uint8Array(face.bytes), metrics });
    }
    this.rejections = rejected;
  }

  face(key: string): PdfFontFace | undefined { return this.faces.get(key); }
  get usedFaces(): number { return this.used.size; }

  encode(key: string, text: string): PdfFontRun | null {
    const face = this.faces.get(key);
    // Same unshaped scope as native Canvas metrics; malformed UTF-16 has no ToUnicode value.
    if (!face || typeof text !== 'string' || !text.length || !supportsNativeTextRun(text) || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) return null;
    const codes = Array.from(text, (character) => character.codePointAt(0)!);
    if (codes.some((code) => code >= 0xd800 && code <= 0xdfff)) return null;
    const glyphs = codes.map((code) => glyphIndex(face.metrics, code));
    if (glyphs.some((glyph) => !glyph || face.metrics.glyphBoundsKnown?.[glyph] === false)) return null;
    let used = this.used.get(key);
    const additional = new Set(codes.filter((code) => !used?.codes.has(code)));
    if ((used?.codes.size ?? 0) + additional.size > MAX_CIDS) return null;
    if (!used) {
      used = { face, name: `JCF${this.used.size + 1}`, codes: new Map() };
      this.used.set(key, used);
    }
    let result = '', advance = 0;
    codes.forEach((code, i) => {
      let mapping = used!.codes.get(code);
      if (!mapping) { mapping = { cid: used!.codes.size + 1, glyph: glyphs[i]! }; used!.codes.set(code, mapping); }
      result += hex(mapping.cid);
      advance += face.metrics.advances[mapping.glyph]!;
    });
    return { resourceName: used.name, hex: result, advance, glyphs };
  }

  /** Snapshot of used resources for assembly; no saved drawing or global cache holds it. */
  resources(): readonly Readonly<UsedFace>[] { return [...this.used.values()]; }
}

/** Add standalone TTF resources to the existing classic-xref PDF assembler. */
export function writePdfFontResources(registry: PdfFontRegistry, writer: PdfFontObjectWriter): ReadonlyMap<string, number> {
  const resources = new Map<string, number>();
  const stream = (id: number, bytes: Uint8Array, extra = '') => writer.set(id, [enc.encode(`<< /Length ${bytes.byteLength}${extra} >>\nstream\n`), bytes, enc.encode('\nendstream')]);
  for (const used of registry.resources()) {
    const face = used.face, em = 1000 / face.metrics.unitsPerEm;
    const parent = writer.reserve(), descendant = writer.reserve(), descriptor = writer.reserve(), fontFile = writer.reserve(), cidMap = writer.reserve(), unicode = writer.reserve();
    const program = embeddableFontProgram(face.bytes, new Set([...used.codes.values()].map(({ glyph }) => glyph)));
    // PDF 9.6.4: actual subsets need six uppercase letters plus '+', unique in
    // this document. A whole-program fallback keeps the original font name.
    let subsetTag = '', serial = resources.size;
    for (let i = 0; i < 6; i++) { subsetTag = String.fromCharCode(65 + serial % 26) + subsetTag; serial = Math.floor(serial / 26); }
    const base = (program === face.bytes ? '' : `${subsetTag}+`) + face.postscriptName.replace(/#/g, '#23');
    const flags = 4 | (face.isFixedPitch ? 1 : 0) | (face.metrics.italic ? 64 : 0);
    const widths = [...used.codes.values()].map(({ glyph }) => num(face.metrics.advances[glyph]! * em)).join(' ');
    writer.set(parent, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    writer.set(descendant, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${cidMap} 0 R /DW ${num(face.metrics.advances[0]! * em)} /W [1 [${widths}]] >>`);
    writer.set(descriptor, `<< /Type /FontDescriptor /FontName /${base} /Flags ${flags} /FontBBox [${face.metrics.fontBounds.map((n) => num(n * em)).join(' ')}] /ItalicAngle ${num(face.italicAngle)} /Ascent ${num(face.ascender * em)} /Descent ${num(face.descender * em)} /CapHeight ${num(face.metrics.capitalHeight * em)} /StemV ${num(50 + face.weight / 10)} /FontFile2 ${fontFile} 0 R >>`);
    // Priority 12.3: embed a GID-preserving subset of the used glyphs, unless the
    // program's own OS/2 fsType forbids subsetting or subsetting cannot shrink it
    // safely — both cases embed the whole program exactly as before.
    stream(fontFile, program, ` /Length1 ${program.byteLength}`);
    const mapping = new Uint8Array((used.codes.size + 1) * 2);
    const entries: string[] = [];
    for (const [code, { cid, glyph }] of used.codes) {
      mapping[cid * 2] = glyph >>> 8; mapping[cid * 2 + 1] = glyph & 255;
      const scalar = code <= 0xffff ? hex(code) : hex(0xd800 + ((code - 0x10000) >>> 10)) + hex(0xdc00 + ((code - 0x10000) & 1023));
      entries.push(`<${hex(cid)}> <${scalar}>`);
    }
    stream(cidMap, mapping);
    const chunks: string[] = [];
    for (let offset = 0; offset < entries.length; offset += 100) {
      const chunk = entries.slice(offset, offset + 100);
      chunks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
    }
    stream(unicode, enc.encode(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /JCad-${used.name}-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`));
    resources.set(used.name, parent);
  }
  return resources;
}
