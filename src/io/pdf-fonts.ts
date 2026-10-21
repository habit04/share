import { supportsNativeTextRun, type NativeFontMetrics } from '../core/text-metrics';
import { embeddableFontProgram } from './pdf-font-subset';

/** Installed font programs live only in one captured plot, never in a DrawingState. */
export interface PdfFontFace {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly metrics: NativeFontMetrics;
  /** Cross-checked against the program; legacy TrueType callers may omit it. */
  readonly outline?: 'glyf' | 'cff';
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
  /** Hexadecimal two-byte character codes, without PDF angle brackets. */
  readonly hex: string;
  /** Advance in the font's original units; divide by unitsPerEm for em units. */
  readonly advance: number;
  readonly glyphs: readonly number[];
}
/** One segment of a shaped line plan (built by the capture layer,
    consumed by the writer): segments arrive in VISUAL order. */
export type PdfShapedSegment =
  | {
      readonly kind: 'direct';
      readonly start: number;
      readonly end: number;
      readonly faceKey: string;
      readonly resourceName: string;
      /** Content-stream hex for the segment's codes (direct encode). */
      readonly hex: string;
      /** Segment advance in the face's font units. */
      readonly advance: number;
    }
  | {
      readonly kind: 'shaped';
      readonly start: number;
      readonly end: number;
      readonly faceKey: string;
      readonly resourceName: string;
      readonly direction: 'ltr' | 'rtl';
      /** Codes parallel to the run's glyphs, with the glyphs'
          advances and offsets in font units. */
      readonly glyphs: readonly {
        readonly code: number;
        readonly glyph: number;
        readonly xAdvance: number;
        readonly yAdvance: number;
        readonly xOffset: number;
        readonly yOffset: number;
      }[];
      /** Sum of the glyphs' xAdvance, font units. */
      readonly advance: number;
    };

/** A whole line's shaped plan: its logical text (the ActualText
    value) and its segments in visual order. */
export interface PdfShapedLine {
  readonly logicalText: string;
  readonly baseDirection: 'ltr' | 'rtl';
  readonly segments: readonly PdfShapedSegment[];
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
/** UTF-16BE hex of a string (a ToUnicode bfchar value); '' -> ''. */
export const utf16Hex = (value: string): string => {
  let result = '';
  for (const char of value) {
    const scalar = char.codePointAt(0)!;
    if (scalar > 0xffff) {
      result += hex(0xd800 + ((scalar - 0x10000) >>> 10)) + hex(0xdc00 + ((scalar - 0x10000) & 1023));
    } else result += hex(scalar);
  }
  return result;
};
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

interface NameStrings { ids: ReadonlySet<number>; resolve(id: number): string | undefined }

/**
 * The name IDs a name table carries, plus best-effort resolution of individual IDs.
 * Resolution considers Unicode records only (the records both readers resolve); an ID
 * whose string is absent or undecodable resolves to undefined — present, but unprovable.
 */
function nameStrings(bytes: Uint8Array, data: DataView, range: { start: number; length: number } | undefined): NameStrings {
  const ids = new Set<number>(), records: { id: number; value: string; rank: number }[] = [];
  const unresolved: NameStrings = { ids, resolve: () => undefined };
  if (!range || range.length < 6) return unresolved;
  const { start, length } = range;
  const version = data.getUint16(start), count = data.getUint16(start + 2), storage = data.getUint16(start + 4);
  if ((version !== 0 && version !== 1) || !count || count > 4096 || storage < 6 + count * 12 || storage > length) return unresolved;
  for (let i = 0; i < count; i++) {
    const at = start + 6 + i * 12, platform = data.getUint16(at), encoding = data.getUint16(at + 2), language = data.getUint16(at + 4), id = data.getUint16(at + 6);
    const size = data.getUint16(at + 8), offset = storage + data.getUint16(at + 10);
    if (offset > length || size > length - offset) continue;
    ids.add(id);
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    if (!unicode || !size || size % 2) continue;
    let value: string;
    try { value = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(start + offset, start + offset + size)); } catch { continue; }
    value = value.trim();
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) continue;
    records.push({ id, value, rank: platform === 3 ? language === 0x0409 ? 100 : 80 : 60 });
  }
  return { ids, resolve: (id) => records.filter((record) => record.id === id).sort((a, b) => b.rank - a.rank)[0]?.value };
}

const nameKey = (value: string) => value.normalize('NFC').trim().toLowerCase();

/**
 * Mirror of the bounded fvar validation and the default-coordinate identity policy in
 * electron/font-metrics.cjs: a variable font is embeddable only as its default instance
 * (the base tables PDF consumers render), so its fvar table must be well-formed — exact
 * record sizes, every referenced name ID present — and its default instance must be
 * provably the instance the face claims to be (weight, width, optical size, style axes
 * and named instances at the default coordinates all checked against the claim).
 */
function variableFontProblem(bytes: Uint8Array, data: DataView, fvar: { start: number; length: number }, name: { start: number; length: number } | undefined, os2: { start: number; length: number } | undefined, face: PdfFontFace): string | null {
  const problem = 'malformed variable font (fvar) table; variable fonts are supported only at their default instance';
  const { start, length } = fvar;
  if (length < 16 || data.getUint32(start) !== 0x00010000 || data.getUint16(start + 6) !== 2) return problem;
  const axesOffset = data.getUint16(start + 4), axisCount = data.getUint16(start + 8), axisSize = data.getUint16(start + 10);
  const instanceCount = data.getUint16(start + 12), instanceSize = data.getUint16(start + 14);
  if (!axisCount || axisCount > 32 || axisSize !== 20 || instanceCount > 512 || axesOffset < 16) return problem;
  const coordinates = axisCount * 4;
  // For fvar 1.0 an instance record is exactly axisCount*4 + 4, or +6 with a PostScript
  // name ID. Every other size — including axisCount*4 + 5 — is illegal.
  if (instanceSize !== 4 + coordinates && instanceSize !== 6 + coordinates) return 'invalid variable font instance record size for the declared axis count; variable fonts are supported only at their default instance';
  if (axesOffset + axisCount * axisSize + instanceCount * instanceSize > length) return problem;
  const axes: { tag: string; min: number; value: number; max: number; nameId: number }[] = [];
  for (let i = 0; i < axisCount; i++) {
    const at = start + axesOffset + i * axisSize, tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const min = data.getInt32(at + 4), value = data.getInt32(at + 8), max = data.getInt32(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || axes.some((axis) => axis.tag === tag)) return problem;
    if (min > value || value > max || data.getUint16(at + 16) & ~1) return problem;
    axes.push({ tag, min, value, max, nameId: data.getUint16(at + 18) });
  }
  const instancesAt = start + axesOffset + axisCount * axisSize;
  const instances: { nameId: number; psNameId: number | null; coordinates: number[] }[] = [];
  for (let i = 0; i < instanceCount; i++) {
    const at = instancesAt + i * instanceSize;
    if (!data.getUint16(at) || data.getUint16(at + 2)) return problem;
    const values: number[] = [];
    for (let axis = 0; axis < axisCount; axis++) {
      const coordinate = data.getInt32(at + 4 + axis * 4), range = axes[axis]!;
      if (coordinate < range.min || coordinate > range.max) return problem;
      values.push(coordinate);
    }
    instances.push({ nameId: data.getUint16(at), psNameId: instanceSize === 6 + coordinates ? data.getUint16(at + 4 + coordinates) : null, coordinates: values });
  }
  const strings = nameStrings(bytes, data, name);
  const customNameId = (id: number) => id >= 256 && id <= 32767;
  for (const axis of axes) {
    if (!customNameId(axis.nameId)) return `invalid variable font axis name ID ${axis.nameId}`;
    if (!strings.ids.has(axis.nameId)) return `variable font axis name ID ${axis.nameId} has no name table record; variable fonts are supported only at their default instance`;
  }
  for (const instance of instances) {
    if (instance.nameId !== 2 && instance.nameId !== 17 && !customNameId(instance.nameId)) return `invalid variable font instance subfamily name ID ${instance.nameId}`;
    if (instance.psNameId !== null && instance.psNameId !== 0xffff && instance.psNameId !== 6 && !customNameId(instance.psNameId)) return `invalid variable font instance PostScript name ID ${instance.psNameId}`;
    if (!strings.ids.has(instance.nameId)) return `variable font instance subfamily name ID ${instance.nameId} has no name table record; variable fonts are supported only at their default instance`;
    if (instance.psNameId !== null && instance.psNameId !== 0xffff && !strings.ids.has(instance.psNameId)) return `variable font instance PostScript name ID ${instance.psNameId} has no name table record; variable fonts are supported only at their default instance`;
  }
  // Default-coordinate identity policy (mirrors electron/font-metrics.cjs): the claim
  // is the face's metrics style, and the program's own OS/2 must agree with it.
  if (!os2 || os2.length < 78) return null;
  const claim = face.metrics, selection = data.getUint16(os2.start + 62);
  if (!!(selection & 32) !== claim.bold || !!(selection & (1 | 512)) !== claim.italic) return 'variable font OS/2 style selection does not match the claimed face style; the default instance identity is not provable';
  const fixed = (value: number) => value / 65536;
  const weight = data.getUint16(os2.start + 4), expectedWeight = claim.bold ? 700 : 400;
  if (weight !== expectedWeight) return `variable font default weight ${weight} is not the ${claim.bold ? 'bold (700)' : 'regular (400)'} default instance this face claims to be; a variable font is admitted only when its default instance is provably the requested instance`;
  const axis = (tag: string) => axes.find((candidate) => candidate.tag === tag);
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
  const subfamilies = [strings.resolve(2), strings.resolve(17)].filter((value) => value !== undefined);
  for (const instance of instances) {
    if (!instance.coordinates.every((coordinate, index) => coordinate === axes[index]?.value)) continue;
    const instanceName = strings.resolve(instance.nameId);
    if (instanceName === undefined) return `variable font named instance at the default coordinates has unresolvable name ID ${instance.nameId}; the default instance identity is ambiguous`;
    if (!subfamilies.some((subfamily) => nameKey(subfamily!) === nameKey(instanceName))) return `variable font named instance "${instanceName}" sits at the default coordinates but does not name the face subfamily; the default instance identity is ambiguous`;
    if (instance.psNameId !== null && instance.psNameId !== 0xffff) {
      const declared = strings.resolve(instance.psNameId);
      if (declared === undefined) return `variable font named instance at the default coordinates has unresolvable PostScript name ID ${instance.psNameId}; the default instance identity is ambiguous`;
      if (declared !== face.postscriptName) return `variable font named instance at the default coordinates declares PostScript name "${declared}" but the face PostScript name is "${face.postscriptName}"; the default instance identity is ambiguous`;
    }
  }
  return null;
}

/** Check the actual SFNT permission/format fields, rather than trusting a metrics cache. */
function validateFace(face: PdfFontFace, restricted = false): string | null {
  if (!face || typeof face.key !== 'string' || !face.key || face.key.length > 512 || /[\u0000-\u001f]/.test(face.key)) fail('invalid face key');
  if (!(face.bytes instanceof Uint8Array) || face.bytes.byteLength < 12 || face.bytes.byteLength > MAX_FONT_BYTES) fail('font program must contain 12 bytes to 64 MiB');
  const data = new DataView(face.bytes.buffer, face.bytes.byteOffset, face.bytes.byteLength);
  const signature = data.getUint32(0);
  if (signature === 0x74746366) return 'TrueType collections are not supported for embedding';
  const outline = signature === 0x4f54544f ? 'cff' : signature === 0x00010000 || signature === 0x74727565 ? 'glyf' : null;
  if (!outline) return 'standalone TrueType glyf outlines required';
  if ((face.outline ?? 'glyf') !== outline) fail('font outline format does not match the program');
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
  if (tables.has('CFF2')) return 'CFF2 fonts are not supported for embedding';
  const fvar = tables.get('fvar');
  if (fvar && outline === 'cff') return 'variable CFF outlines are not supported for embedding';
  if (fvar) { const problem = variableFontProblem(face.bytes, data, fvar, tables.get('name'), tables.get('OS/2'), face); if (problem) return problem; }
  if (outline === 'cff' && (tables.has('glyf') || tables.has('loca'))) return 'mixed CFF and TrueType outlines are not supported for embedding';
  if (outline === 'glyf' && tables.has('CFF ')) return 'CFF outlines in a TrueType program are not supported for embedding';
  for (const tag of ['COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC']) if (tables.has(tag)) return `bitmap/color font tables are not supported for embedding (${tag.trim()})`;
  if (tables.has('EBSC')) return 'embedded bitmap scaling is not supported for embedding';
  const table = (tag: string, length: number) => {
    const found = tables.get(tag);
    if (!found || found.length < length) return fail(`missing or truncated ${tag} table`);
    return found.start;
  };
  const head = table('head', 54), os2 = table('OS/2', 78), maxp = table('maxp', outline === 'cff' ? 6 : 32), hhea = table('hhea', 36), post = table('post', 32);
  if (outline === 'cff' && data.getUint32(maxp) !== 0x00005000) fail('CFF maxp version does not match the program');
  if (outline === 'glyf') { table('glyf', 0); table('loca', 4); }
  table('hmtx', 4); table('cmap', 4); table('name', 6);
  const metrics = face.metrics, glyphCount = data.getUint16(maxp + 4);
  if (outline === 'cff') {
    const cff = tables.get('CFF ');
    if (!cff) return 'a CFF font program is required for embedding';
    const problem = validateCffProgram(face.bytes, cff.start, cff.length, glyphCount, metrics.unitsPerEm);
    if (problem) return problem;
  }
  const fsType = data.getUint16(os2 + 8), os2Version = data.getUint16(os2);
  if (!metrics || metrics.fsType !== fsType || face.os2Version !== os2Version) fail('font permissions do not match the program');
  if ((metrics.variable === true) !== tables.has('fvar')) fail('font variable metadata does not match the program');
  const permission = pdfFontEmbeddingProblem(fsType, os2Version);
  if (permission && !(restricted && permission === 'preview/print embedding requires a read-only PDF')) return permission;
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

/**
 * Independently re-check the CFF facts the embedding decision relies on, without
 * trusting the bridge metrics: a name-keyed CFF 1 program whose CharStrings count
 * equals the program's glyph count. CID-keyed programs (a Top DICT ROS operator)
 * assign character codes from a character collection, not glyph ids, and are refused.
 */
function validateCffProgram(bytes: Uint8Array, start: number, length: number, glyphCount: number, unitsPerEm: number): string | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + length;
  const need = (at: number, size: number) => at >= start && size >= 0 && at + size <= end;
  if (length < 4) return 'invalid CFF font program';
  const major = bytes[start]!;
  if (major === 2) return 'CFF2 fonts are not supported for embedding';
  if (major !== 1) return 'invalid CFF font program';
  const headerSize = bytes[start + 2]!;
  if (headerSize < 4 || !need(start, headerSize)) return 'invalid CFF font program';
  const readIndex = (at: number): { count: number; entriesEnd: number } | null => {
    if (!need(at, 3)) return null;
    const count = data.getUint16(at);
    if (!count || count > 65536) return null;
    const offSize = bytes[at + 2]!;
    if (offSize < 1 || offSize > 4 || !need(at + 3, (count + 1) * offSize)) return null;
    const offset = (index: number) => { let value = 0; for (let i = 0; i < offSize; i++) value = value * 256 + bytes[at + 3 + index * offSize + i]!; return value; };
    if (offset(0) !== 1) return null;
    let previous = 1;
    for (let i = 0; i < count; i++) { const next = offset(i + 1); if (next < previous) return null; previous = next; }
    const entriesEnd = at + 3 + (count + 1) * offSize + previous - 1;
    return need(at, entriesEnd - at) ? { count, entriesEnd } : null;
  };
  const names = readIndex(start + headerSize);
  if (!names || names.count !== 1) return 'invalid CFF font program';
  const topIndexAt = names.entriesEnd;
  if (!need(topIndexAt, 3)) return 'invalid CFF font program';
  const topCount = data.getUint16(topIndexAt), topOffSize = bytes[topIndexAt + 2]!;
  if (topCount !== 1 || topOffSize < 1 || topOffSize > 4 || !need(topIndexAt + 3, 2 * topOffSize)) return 'invalid CFF font program';
  const topFirst = (() => { let value = 0; for (let i = 0; i < topOffSize; i++) value = value * 256 + bytes[topIndexAt + 3 + i]!; return value; })();
  const topSecond = (() => { let value = 0; for (let i = 0; i < topOffSize; i++) value = value * 256 + bytes[topIndexAt + 3 + topOffSize + i]!; return value; })();
  if (topFirst !== 1 || topSecond < topFirst) return 'invalid CFF font program';
  const dictAt = topIndexAt + 3 + 2 * topOffSize + topFirst - 1, dictEnd = topIndexAt + 3 + 2 * topOffSize + topSecond - 1;
  if (!need(dictAt, dictEnd - dictAt)) return 'invalid CFF font program';
  // The same structural budgets as the metrics parser, applied before the walk.
  if (dictEnd - dictAt > 65536) return 'CFF Top DICT exceeds the safe size limit';
  let operands: number[] = [], charStringsOffset: number | undefined, fontMatrix: number[] | undefined, entries = 0;
  let position = dictAt;
  while (position < dictEnd) {
    const byte = bytes[position]!;
    if (byte <= 21) {
      if (++entries > 1024) return 'CFF Top DICT exceeds the safe entry limit';
      let op = byte; position++;
      if (byte === 12) { if (position >= dictEnd) return 'invalid CFF font program'; op = 1200 + bytes[position]!; position++; }
      if (op === 1230 || op === 1236 || op === 1237) return 'CID-keyed CFF fonts are not supported for embedding';
      if (op === 17) { if (operands.length !== 1 || !Number.isInteger(operands[0])) return 'invalid CFF font program'; charStringsOffset = operands[0]; }
      // Same semantic contract as the metrics parser: Type 2 charstrings only,
      // no stroking or synthetic programs, and only the uniform FontMatrix
      // scale consistent with unitsPerEm.
      if (op === 1206 && (operands.length !== 1 || operands[0] !== 2)) return 'CFF CharstringType is not Type 2';
      if (op === 1205 && (operands.length !== 1 || operands[0] !== 0)) return 'stroking CFF fonts (PaintType) are not supported for embedding';
      if (op === 1220) return 'synthetic CFF fonts are not supported for embedding';
      if (op === 1207) fontMatrix = operands;
      operands = [];
    } else if (byte === 28) {
      if (!need(position, 3)) return 'invalid CFF font program';
      operands.push(data.getInt16(position + 1)); position += 3;
    } else if (byte === 29) {
      if (!need(position, 5)) return 'invalid CFF font program';
      operands.push(data.getInt32(position + 1)); position += 5;
    } else if (byte === 30) {
      position++;
      let text = '', done = false;
      while (!done) {
        if (position >= dictEnd) return 'invalid CFF font program';
        const packed = bytes[position++]!;
        for (const nibble of [packed >> 4, packed & 15]) {
          if (nibble <= 9) text += String(nibble);
          else if (nibble === 10) text += '.';
          else if (nibble === 11) text += 'E';
          else if (nibble === 12) text += 'E-';
          else if (nibble === 14) text += '-';
          else if (nibble === 15) { done = true; break; }
          else return 'invalid CFF font program';
          if (text.length > 32) return 'CFF Top DICT real number exceeds the safe limit';
        }
      }
      if (!Number.isFinite(Number(text))) return 'invalid CFF font program';
      operands.push(Number(text));
    } else if (byte === 255 || byte >= 22 && byte <= 31) return 'invalid CFF font program';
    else if (byte >= 247) {
      if (!need(position, 2)) return 'invalid CFF font program';
      const second = bytes[position + 1]!;
      operands.push(byte <= 250 ? (byte - 247) * 256 + second + 108 : -((byte - 251) * 256) - second - 108);
      position += 2;
    } else { operands.push(byte - 139); position++; }
    if (operands.length > 48) return 'invalid CFF font program';
  }
  if (operands.length || charStringsOffset === undefined || !Number.isInteger(charStringsOffset) || charStringsOffset < 0) return 'invalid CFF font program';
  // The omitted CFF FontMatrix is .001, not an unspecified SFNT-dependent scale.
  fontMatrix ??= [0.001, 0, 0, 0.001, 0, 0];
  {
    if (fontMatrix.length !== 6 || !fontMatrix.every(Number.isFinite)) return 'invalid CFF font program';
    const [a, b, c, d, e, f] = fontMatrix as [number, number, number, number, number, number];
    if (b !== 0 || c !== 0 || e !== 0 || f !== 0 || !(a > 0) || a !== d) return 'unsupported CFF FontMatrix for embedding';
    if (Math.abs(a * unitsPerEm - 1) > 1e-4) return 'CFF FontMatrix does not match the font unitsPerEm';
  }
  const charStrings = readIndex(start + charStringsOffset);
  if (!charStrings || charStrings.count !== glyphCount) return 'CFF glyph count does not match the program';
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
  /**
   * Assignment identity -> entry. Direct entries are keyed by the
   * Unicode scalar (`c:<scalar>`); shaped entries by occurrence
   * identity (`s:<binding>:<cluster>:<glyph>:<occurrence>`, §5.2).
   * `code` is the character code shown in content streams; `cid`
   * keys widths (and, for TrueType, the CIDToGIDMap); `unicode`
   * is the entry's ToUnicode value (the scalar itself for direct
   * entries; the cluster's logical source for a shaped anchor,
   * empty for every other shaped occurrence, §5.3).
   */
  codes: Map<string, { code: number; cid: number; glyph: number; unicode: string }>;
  /** Any shaped entry assigned: the document carries ActualText
   * and declares at least PDF 1.5 (§5.5). */
  shaped: boolean;
}

/** Mutable CID assignment is private to one plot. Failed runs cannot reserve partial resources. */
export class PdfFontRegistry {
  private faces = new Map<string, PdfFontFace>();
  private used = new Map<string, UsedFace>();
  readonly rejections: ReadonlyMap<string, string>;
  /** Faces admitted from actual program permissions only because this PDF is restricted. */
  readonly previewPrintKeys: readonly string[];

  constructor(faces: readonly PdfFontFace[], options?: { restricted?: boolean }) {
    if (!Array.isArray(faces) || faces.length > MAX_FACES) fail('at most eight font faces are allowed');
    const restricted = options?.restricted === true;
    const rejected = new Map<string, string>(), keys = new Set<string>(), previewPrint: string[] = [];
    let total = 0;
    // Preflight the aggregate budget before allocating any owned font-program snapshots.
    for (const face of faces) {
      if (!face || !(face.bytes instanceof Uint8Array)) fail('invalid font program');
      total += face.bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) fail('font programs exceed 128 MiB');
    }
    for (const face of faces) {
      const problem = validateFace(face, restricted);
      if (keys.has(face.key)) fail('duplicate font face key');
      keys.add(face.key);
      if (problem) { rejected.set(face.key, problem); continue; }
      // Successful validation established these values equal the program's OS/2.
      // A caller's previewPrint flag is never used to classify the face.
      if (restricted && pdfFontEmbeddingProblem(face.metrics.fsType, face.os2Version) === 'preview/print embedding requires a read-only PDF') previewPrint.push(face.key);
      const metrics: NativeFontMetrics = { ...face.metrics, advances: [...face.metrics.advances], cmap: [...face.metrics.cmap], groups: face.metrics.groups.map((group) => [...group] as [number, number, number]), fontBounds: [...face.metrics.fontBounds] as [number, number, number, number], glyphBounds: face.metrics.glyphBounds.map((box) => [...box] as [number, number, number, number]), glyphBoundsKnown: face.metrics.glyphBoundsKnown ? [...face.metrics.glyphBoundsKnown] : undefined };
      this.faces.set(face.key, { ...face, bytes: new Uint8Array(face.bytes), metrics });
    }
    this.rejections = rejected;
    this.previewPrintKeys = previewPrint;
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
    const additional = new Set(codes.filter((code) => !used?.codes.has(`c:${code}`)));
    if ((used?.codes.size ?? 0) + additional.size > MAX_CIDS) return null;
    if (!used) {
      used = { face, name: `JCF${this.used.size + 1}`, codes: new Map(), shaped: false };
      this.used.set(key, used);
    }
    let result = '', advance = 0;
    codes.forEach((code, i) => {
      let mapping = used!.codes.get(`c:${code}`);
      if (!mapping) {
        // Character codes are assigned sequentially per scalar for both outline
        // kinds, so two scalars sharing one glyph still get distinct codes and
        // extract distinctly. For TrueType the code doubles as the CID. For CFF
        // the CID stays the glyph id (a CIDFontType0 has no CIDToGIDMap, so its
        // CIDs index the CharStrings array directly) and the custom Encoding
        // CMap written with the resources maps code -> CID. The scheme is fixed
        // at first encode because runs are emitted incrementally.
        const assigned = used!.codes.size + 1;
        mapping = { code: assigned, cid: face.outline === 'cff' ? glyphs[i]! : assigned, glyph: glyphs[i]!, unicode: String.fromCodePoint(code) };
        used!.codes.set(`c:${code}`, mapping);
      }
      result += hex(mapping.code);
      advance += face.metrics.advances[mapping.glyph]!;
    });
    return { resourceName: used.name, hex: result, advance, glyphs };
  }

  /**
   * Assign character codes for one shaped run's glyphs under the
   * contract's occurrence identity (§5.2): a code per (glyph,
   * cluster, occurrence) under the run's binding identity, where
   * occurrence is the glyph's ordinal among its cluster's glyphs
   * in content order. The cluster anchor (occurrence 0) carries
   * the cluster's full logical source substring as its ToUnicode
   * value; every other occurrence carries the empty string (§5.3's
   * nonduplicating rule). Rendering identity is untouched: every
   * code resolves to the same glyph the engine produced. Returns
   * the codes parallel to `glyphs`, or null — assigning nothing —
   * when the face is unknown, a glyph is unusable, a cluster text
   * is malformed, or the face's code budget (MAX_CIDS, shared with
   * the direct path) would be exceeded.
   */
  encodeShaped(
    key: string,
    identity: string,
    glyphs: readonly { readonly glyph: number; readonly clusterStart: number; readonly clusterEnd: number }[],
    clusterText: (clusterStart: number, clusterEnd: number) => string,
  ): { readonly resourceName: string; readonly codes: readonly number[] } | null {
    const face = this.faces.get(key);
    if (!face || !glyphs.length) return null;
    let used = this.used.get(key);
    const occurrences = new Map<string, number>();
    const pending: { entryKey: string; glyph: number; unicode: string }[] = [];
    for (const glyph of glyphs) {
      if (!Number.isInteger(glyph.glyph) || glyph.glyph < 0 || glyph.glyph >= face.metrics.advances.length) return null;
      if (face.metrics.glyphBoundsKnown?.[glyph.glyph] === false) return null;
      if (!Number.isInteger(glyph.clusterStart) || !Number.isInteger(glyph.clusterEnd) || glyph.clusterStart < 0 || glyph.clusterEnd < glyph.clusterStart) return null;
      const cluster = `${glyph.clusterStart}:${glyph.clusterEnd}`;
      const occurrence = occurrences.get(cluster) ?? 0;
      occurrences.set(cluster, occurrence + 1);
      let unicode = '';
      if (occurrence === 0) {
        unicode = clusterText(glyph.clusterStart, glyph.clusterEnd);
        if (typeof unicode !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(unicode)) return null;
        for (const char of unicode) {
          const scalar = char.codePointAt(0)!;
          if (scalar >= 0xd800 && scalar <= 0xdfff) return null;
        }
      }
      pending.push({ entryKey: `s:${identity}:${cluster}:${glyph.glyph}:${occurrence}`, glyph: glyph.glyph, unicode });
    }
    const additional = new Set(pending.filter(({ entryKey }) => !used?.codes.has(entryKey)).map(({ entryKey }) => entryKey));
    if ((used?.codes.size ?? 0) + additional.size > MAX_CIDS) return null;
    if (!used) {
      used = { face, name: `JCF${this.used.size + 1}`, codes: new Map(), shaped: false };
      this.used.set(key, used);
    }
    const codes = pending.map(({ entryKey, glyph, unicode }) => {
      let mapping = used!.codes.get(entryKey);
      if (!mapping) {
        const assigned = used!.codes.size + 1;
        mapping = { code: assigned, cid: face.outline === 'cff' ? glyph : assigned, glyph, unicode };
        used!.codes.set(entryKey, mapping);
      }
      return mapping.code;
    });
    used.shaped = true;
    return { resourceName: used.name, codes };
  }

  /** Snapshot of used resources for assembly; no saved drawing or global cache holds it. */
  resources(): readonly Readonly<UsedFace>[] { return [...this.used.values()]; }

  /**
   * The lowest PDF version the resources this registry will actually emit
   * require: an emitted FontFile3/OpenType (CFF) resource needs PDF 1.6;
   * everything else stays at the 1.4 baseline. A face that was supplied but
   * never encoded (or was rejected) emits nothing and requires nothing.
   */
  get requiredVersion(): readonly [number, number] {
    let shaped = false;
    for (const used of this.used.values()) {
      if (used.face.outline === 'cff') return [1, 6];
      if (used.shaped) shaped = true;
    }
    // A document emitting shaped runs carries ActualText (§5.4/§5.5).
    return shaped ? [1, 5] : [1, 4];
  }
}

/** Add checked standalone outline resources to the classic-xref PDF assembler. */
export function writePdfFontResources(registry: PdfFontRegistry, writer: PdfFontObjectWriter): ReadonlyMap<string, number> {
  const resources = new Map<string, number>();
  const stream = (id: number, bytes: Uint8Array, extra = '') => writer.set(id, [enc.encode(`<< /Length ${bytes.byteLength}${extra} >>\nstream\n`), bytes, enc.encode('\nendstream')]);
  for (const used of registry.resources()) {
    const face = used.face, em = 1000 / face.metrics.unitsPerEm, cff = face.outline === 'cff';
    const parent = writer.reserve(), descendant = writer.reserve(), descriptor = writer.reserve(), fontFile = writer.reserve(), cidMap = cff ? null : writer.reserve(), unicode = writer.reserve(), encoding = cff ? writer.reserve() : null;
    const program = cff ? face.bytes : embeddableFontProgram(face.bytes, new Set([...used.codes.values()].map(({ glyph }) => glyph)));
    // PDF 9.6.4: actual subsets need six uppercase letters plus '+', unique in
    // this document. A whole-program fallback keeps the original font name.
    let subsetTag = '', serial = resources.size;
    for (let i = 0; i < 6; i++) { subsetTag = String.fromCharCode(65 + serial % 26) + subsetTag; serial = Math.floor(serial / 26); }
    const base = (program === face.bytes ? '' : `${subsetTag}+`) + face.postscriptName.replace(/#/g, '#23');
    const flags = 4 | (face.isFixedPitch ? 1 : 0) | (face.metrics.italic ? 64 : 0);
    let widthRuns: string;
    if (cff) {
      // Widths are keyed by CID, and a CFF face's CID is its glyph id: emit sorted
      // runs of consecutive glyph ids with the width of each glyph.
      const byCid: Map<number, number> = new Map([...used.codes.values()].map(({ cid, glyph }) => [cid, glyph] as const));
      const runs: [number, string[]][] = [];
      for (const cid of [...byCid.keys()].sort((a, b) => a - b)) {
        const width = num(face.metrics.advances[byCid.get(cid)!]! * em);
        const last = runs[runs.length - 1];
        if (last && cid === last[0] + last[1].length) last[1].push(width); else runs.push([cid, [width]]);
      }
      widthRuns = runs.map(([first, run]) => `${first} [${run.join(' ')}]`).join(' ');
    } else widthRuns = `1 [${[...used.codes.values()].map(({ glyph }) => num(face.metrics.advances[glyph]! * em)).join(' ')}]`;
    // TrueType keeps /Identity-H (character code == CID). CFF names the custom
    // Encoding CMap below: character codes are sequential per scalar while CIDs
    // are glyph ids, which is what lets aliased scalars extract distinctly.
    writer.set(parent, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding ${cff ? `${encoding} 0 R` : '/Identity-H'} /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    if (cff) writer.set(descendant, `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW ${num(face.metrics.advances[0]! * em)} /W [${widthRuns}] >>`);
    else writer.set(descendant, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${cidMap} 0 R /DW ${num(face.metrics.advances[0]! * em)} /W [${widthRuns}] >>`);
    writer.set(descriptor, `<< /Type /FontDescriptor /FontName /${base} /Flags ${flags} /FontBBox [${face.metrics.fontBounds.map((n) => num(n * em)).join(' ')}] /ItalicAngle ${num(face.italicAngle)} /Ascent ${num(face.ascender * em)} /Descent ${num(face.descender * em)} /CapHeight ${num(face.metrics.capitalHeight * em)} /StemV ${num(50 + face.weight / 10)} /${cff ? 'FontFile3' : 'FontFile2'} ${fontFile} 0 R >>`);
    if (cff) stream(fontFile, face.bytes, ' /Subtype /OpenType');
    else stream(fontFile, program, ` /Length1 ${program.byteLength}`);
    const mapping = new Uint8Array((used.codes.size + 1) * 2);
    const entries: string[] = [], encodingEntries: string[] = [];
    for (const entry of used.codes.values()) {
      if (!cff) { mapping[entry.cid * 2] = entry.glyph >>> 8; mapping[entry.cid * 2 + 1] = entry.glyph & 255; }
      // ToUnicode is keyed by character code, never by CID: aliasing scalars
      // (distinct codes, one CID) each keep their own Unicode value. Shaped
      // anchors carry their cluster's logical source; every other shaped
      // occurrence carries the empty string as an explicit bfchar entry
      // (§5.3), which renders here as an empty hex string.
      entries.push(`<${hex(entry.code)}> <${utf16Hex(entry.unicode)}>`);
      if (cff) encodingEntries.push(`<${hex(entry.code)}> ${entry.cid}`);
    }
    if (!cff) stream(cidMap!, mapping);
    if (cff) {
      // An Encoding CMap maps codes to CIDs, so it uses begincidchar with
      // decimal CID destinations (TN #5014); beginbfchar would declare
      // code-to-Unicode mappings and strict parsers would find no CID map.
      const encChunks: string[] = [];
      for (let offset = 0; offset < encodingEntries.length; offset += 100) {
        const chunk = encodingEntries.slice(offset, offset + 100);
        encChunks.push(`${chunk.length} begincidchar\n${chunk.join('\n')}\nendcidchar`);
      }
      stream(encoding!, enc.encode(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /JCad-${used.name}-ENC def\n/CMapType 0 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${encChunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`));
    }
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
