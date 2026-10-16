import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { nativeFontFixture, fontTable, fontCollection } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import { PdfFontRegistry, pdfFontEmbeddingProblem, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';
import { embeddableFontProgram } from '../src/io/pdf-font-subset';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

function replaceTable(source: Buffer, tag: string, replacement: Buffer): Buffer {
  const tables: { tag: string; bytes: Buffer }[] = [];
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, name = source.toString('ascii', at, at + 4), start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.push({ tag: name, bytes: name === tag ? replacement : Buffer.from(source.subarray(start, start + length)) });
  }
  tables.find((table) => table.tag === 'head')!.bytes.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer) => { let sum = 0; for (let i = 0; i < bytes.length; i += 4) { let word = 0; for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0; sum = (sum + word) >>> 0; } return sum; };
  const bytes = Buffer.alloc(12 + tables.length * 16 + tables.reduce((n, table) => n + Math.ceil(table.bytes.length / 4) * 4, 0));
  source.copy(bytes, 0, 0, 12);
  let offset = 12 + tables.length * 16;
  tables.forEach((table, i) => { const at = 12 + i * 16; bytes.write(table.tag, at, 'ascii'); bytes.writeUInt32BE(checksum(table.bytes), at + 4); bytes.writeUInt32BE(offset, at + 8); bytes.writeUInt32BE(table.bytes.length, at + 12); table.bytes.copy(bytes, offset); offset += Math.ceil(table.bytes.length / 4) * 4; });
  bytes.writeUInt32BE((0xb1b0afba - checksum(bytes)) >>> 0, fontTable(bytes, 'head').offset + 8);
  return bytes;
}
function nameTable(postscriptName: string, bold: boolean, italic: boolean): Buffer {
  const entries = [[1, 'JCad Fixture'], [2, bold ? italic ? 'Bold Italic' : 'Bold' : italic ? 'Italic' : 'Regular'], [6, postscriptName]] as const;
  const strings = entries.map(([, value]) => Buffer.from(value, 'utf16le').swap16()), storage = 6 + entries.length * 12;
  const data = Buffer.alloc(storage + strings.reduce((n, value) => n + value.length, 0));
  data.writeUInt16BE(entries.length, 2); data.writeUInt16BE(storage, 4);
  let offset = 0;
  entries.forEach(([id], i) => { const at = 6 + i * 12; data.writeUInt16BE(3, at); data.writeUInt16BE(1, at + 2); data.writeUInt16BE(0x409, at + 4); data.writeUInt16BE(id, at + 6); data.writeUInt16BE(strings[i]!.length, at + 8); data.writeUInt16BE(offset, at + 10); strings[i]!.copy(data, storage + offset); offset += strings[i]!.length; });
  return data;
}
function face(options: { key?: string; fsType?: number; version?: number; bold?: boolean; italic?: boolean; units?: number; alias?: boolean; postscriptName?: string; bitmapGlyphRange?: readonly [number, number] } = {}): PdfFontFace {
  let bytes = nativeFontFixture({ fsType: options.fsType, bold: options.bold, italic: options.italic, format12: !options.alias, rangeOffset: options.alias, bitmapGlyphRange: options.bitmapGlyphRange });
  if (options.version !== undefined) bytes.writeUInt16BE(options.version, fontTable(bytes, 'OS/2').offset);
  if (options.units !== undefined) bytes.writeUInt16BE(options.units, fontTable(bytes, 'head').offset + 18);
  if (options.italic) bytes.writeInt32BE(-12 * 65536, fontTable(bytes, 'post').offset + 4);
  if (!options.alias) {
    const cmap = fontTable(bytes, 'cmap').offset, sub = cmap + bytes.readUInt32BE(cmap + 16);
    bytes.writeUInt32BE(0x20000, sub + 40); bytes.writeUInt32BE(0x20000, sub + 44);
  }
  if (options.alias) {
    const cmap = fontTable(bytes, 'cmap').offset;
    bytes.writeUInt16BE(1, cmap + bytes.readUInt32BE(cmap + 8) + 42);
  }
  const postscriptName = options.postscriptName ?? (options.bold ? 'JCadFixture-Bold' : 'JCadFixture');
  bytes = replaceTable(bytes, 'name', nameTable(postscriptName, !!options.bold, !!options.italic));
  const metrics = parseFontMetrics(bytes);
  return { key: options.key ?? 'fixture', bytes, metrics, postscriptName, ascender: 1000, descender: -200, italicAngle: options.italic ? -12 : 0, weight: options.bold ? 700 : 400, isFixedPitch: false, os2Version: options.version ?? 2 };
}
function objects() {
  const entries = new Map<number, string | Uint8Array[]>();
  let next = 0;
  const writer: PdfFontObjectWriter = { reserve: () => ++next, set: (id, body) => { expect(entries.has(id)).toBe(false); entries.set(id, body); } };
  return { entries, writer, text: (id: number) => {
    const body = entries.get(id)!;
    return typeof body === 'string' ? body : body.filter((_part, index) => index !== 1).map((part) => new TextDecoder().decode(part)).join('');
  }, stream: (id: number) => {
    const body = entries.get(id)!;
    if (typeof body === 'string') throw new Error('Expected a stream');
    const header = new TextDecoder().decode(body[0]);
    expect(header).toContain(`/Length ${body[1]!.length}`);
    expect(new TextDecoder().decode(body[2])).toBe('\nendstream');
    return body[1]!;
  } };
}

/** Valid full SFNT with many distinct scalars sharing one glyph; no proprietary program. */
function manyCidFace(): PdfFontFace {
  const base = face(), groups = 65536, sub = Buffer.alloc(16 + groups * 12), cmap = Buffer.alloc(12 + sub.length);
  sub.writeUInt16BE(12, 0); sub.writeUInt32BE(sub.length, 4); sub.writeUInt32BE(groups, 12);
  sub.writeUInt32BE(65, 16); sub.writeUInt32BE(66, 20); sub.writeUInt32BE(2, 24);
  for (let i = 1; i < groups; i++) { sub.writeUInt32BE(0x20000 + i - 1, 16 + i * 12); sub.writeUInt32BE(0x20000 + i - 1, 20 + i * 12); sub.writeUInt32BE(2, 24 + i * 12); }
  cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(10, 6); cmap.writeUInt32BE(12, 8); sub.copy(cmap, 12);
  const bytes = replaceTable(base.bytes as Buffer, 'cmap', cmap);
  return { ...base, bytes, metrics: parseFontMetrics(bytes) };
}

describe('per-plot PDF TrueType font resources', () => {
  it('writes a used-glyph subset TTF, native widths and connected Type0/CID/descriptor resources', () => {
    const font = face(), original = new Uint8Array(font.bytes), registry = new PdfFontRegistry([font]);
    const run = registry.encode(font.key, 'AB A')!;
    expect(run).toEqual({ resourceName: 'JCF1', hex: '0001000200030001', advance: 2250, glyphs: [2, 3, 1, 2] });
    const out = objects(), names = writePdfFontResources(registry, out.writer);
    expect(names).toEqual(new Map([['JCF1', 1]]));
    expect(out.entries.size).toBe(6);
    expect(out.text(1)).toContain('/Subtype /Type0 /BaseFont /AAAAAA+JCadFixture /Encoding /Identity-H /DescendantFonts [2 0 R] /ToUnicode 6 0 R');
    expect(out.text(2)).toContain('/FontDescriptor 3 0 R /CIDToGIDMap 5 0 R /DW 500 /W [1 [650 650 300]]');
    expect(out.text(3)).toContain('/FontBBox [-50 -200 900 1000] /ItalicAngle 0 /Ascent 1000 /Descent -200 /CapHeight 730');
    expect(out.text(3)).toContain('/FontFile2 4 0 R');
    const embeddedProgram = embeddableFontProgram(original, new Set([1, 2, 3]));
    expect(embeddedProgram.byteLength).toBeLessThan(original.length);
    expect(out.text(4)).toContain(`/Length1 ${embeddedProgram.byteLength}`);
    expect(out.stream(4)).toEqual(embeddedProgram);
    expect(out.stream(5)).toEqual(new Uint8Array([0, 0, 0, 2, 0, 3, 0, 1]));
    const unicode = new TextDecoder().decode(out.stream(6));
    expect(unicode).toContain('3 beginbfchar\n<0001> <0041>\n<0002> <0042>\n<0003> <0020>');
    expect(unicode).toContain('<0000> <FFFF>');
    expect(new Uint8Array(font.bytes)).toEqual(original);
  });

  it('normalizes native descriptor/width fields into 1000-em PDF coordinates', () => {
    const font = face({ units: 2048, bold: true, italic: true }), registry = new PdfFontRegistry([font]);
    registry.encode(font.key, 'A');
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(out.text(2)).toContain('/DW 244.140625 /W [1 [317.382813]]');
    expect(out.text(3)).toContain('/Flags 68 /FontBBox [-24.414063 -97.65625 439.453125 488.28125] /ItalicAngle -12 /Ascent 488.28125 /Descent -97.65625 /CapHeight 356.445313');
  });

  it('maps supplementary scalars to UTF16BE without exposing Unicode as a glyph ID', () => {
    const registry = new PdfFontRegistry([face()]);
    expect(registry.encode('fixture', '𠀀A𠀀')).toEqual({ resourceName: 'JCF1', hex: '000100020001', advance: 1950, glyphs: [4, 2, 4] });
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(new TextDecoder().decode(out.stream(6))).toContain('<0001> <D840DC00>\n<0002> <0041>');
    expect(out.stream(5)).toEqual(new Uint8Array([0, 0, 0, 4, 0, 2]));
  });

  it('gives Unicode aliases distinct CIDs even when they map to the same native glyph', () => {
    const font = face({ alias: true });
    expect(font.metrics.cmap[65]).toBe(2); expect(font.metrics.cmap[66]).toBe(2);
    const registry = new PdfFontRegistry([font]);
    expect(registry.encode(font.key, 'AB')).toMatchObject({ hex: '00010002', glyphs: [2, 2] });
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(out.stream(5)).toEqual(new Uint8Array([0, 0, 0, 2, 0, 2]));
    expect(new TextDecoder().decode(out.stream(6))).toContain('<0001> <0041>\n<0002> <0042>');
  });

  it('reuses a font across repeated runs and keeps two face programs separate deterministically', () => {
    const fonts = [face(), face({ key: 'bold', bold: true })];
    const run = () => {
      const registry = new PdfFontRegistry(fonts);
      expect(registry.encode('bold', 'B')!.resourceName).toBe('JCF1');
      expect(registry.encode('fixture', 'A')!.resourceName).toBe('JCF2');
      expect(registry.encode('bold', 'AB')!.hex).toBe('00020001');
      const out = objects(), refs = writePdfFontResources(registry, out.writer);
      expect(refs).toEqual(new Map([['JCF1', 1], ['JCF2', 7]]));
      expect(out.text(1)).toContain('/AAAAAA+JCadFixture-Bold'); expect(out.text(7)).toContain('/AAAAAB+JCadFixture ');
      expect(registry.usedFaces).toBe(2);
      return [...out.entries];
    };
    expect(run()).toEqual(run());
  });

  it('owns a program/advance/mapping snapshot independent of later caller mutation', () => {
    const font = face(), original = new Uint8Array(font.bytes), registry = new PdfFontRegistry([font]);
    font.bytes.fill(0);
    (font.metrics.advances as number[])[2] = 99;
    (font.metrics.cmap as number[])[65] = 0;
    expect(registry.encode(font.key, 'A')!.advance).toBe(650);
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(out.stream(4)).toEqual(embeddableFontProgram(original, new Set([2])));
  });

  it('keeps unsupported shaping, missing glyphs, bad UTF16 and unknown origins on fallback without allocating resources', () => {
    const font = face(); (font.metrics.glyphBoundsKnown as boolean[])[3] = false;
    const registry = new PdfFontRegistry([font]);
    for (const text of ['C', 'A\u0301', 'א', 'अ', 'ᄀ', '𐐀', '😀', '\ud800', '\udc00', 'A\u200dA', '\n', 'B', 'AC']) expect(registry.encode(font.key, text)).toBeNull();
    expect(registry.encode('absent', 'A')).toBeNull();
    expect(registry.usedFaces).toBe(0);
    expect(registry.encode(font.key, 'A')!.hex).toBe('0001');
  });

  it('does not embed unused programs', () => {
    const registry = new PdfFontRegistry([face()]), out = objects();
    expect(writePdfFontResources(registry, out.writer).size).toBe(0);
    expect(out.entries.size).toBe(0);
  });

  it('escapes PDF-name hash syntax after applying the subset prefix', () => {
    const registry = new PdfFontRegistry([face({ postscriptName: 'JCad#Fixture' })]);
    registry.encode('fixture', 'A');
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(out.text(1)).toContain('/BaseFont /AAAAAA+JCad#23Fixture');
    expect(out.text(3)).toContain('/FontName /AAAAAA+JCad#23Fixture');
    expect(out.text(1)).toMatch(/\/AAAAAA\+JCad#23Fixture/);
  });

  it('bounds CIDs atomically and writes ToUnicode mappings in blocks of at most 100', () => {
    const font = manyCidFace(), registry = new PdfFontRegistry([font]);
    const codes = Array.from({ length: 65535 }, (_, i) => String.fromCodePoint(0x20000 + i)), text = codes.join('');
    expect(registry.encode(font.key, text)).toBeNull();
    expect(registry.usedFaces).toBe(0);
    const accepted = registry.encode(font.key, codes.slice(0, 65534).join(''))!;
    expect(accepted.hex).toHaveLength(65534 * 4); expect(accepted.hex.endsWith('FFFE')).toBe(true);
    expect(registry.encode(font.key, codes[65534]!)).toBeNull();
    expect(registry.encode(font.key, codes[0]!)!.hex).toBe('0001');
    const out = objects(); writePdfFontResources(registry, out.writer);
    const unicode = new TextDecoder().decode(out.stream(6)), counts = [...unicode.matchAll(/(\d+) beginbfchar/g)].map((match) => Number(match[1]));
    expect(counts).toHaveLength(656); expect(counts.every((count) => count > 0 && count <= 100)).toBe(true);
    expect(counts.reduce((n, count) => n + count, 0)).toBe(65534);
    expect(out.stream(5)).toHaveLength(65535 * 2);
    expect(unicode).toContain('<0001> <D840DC00>');
  });
});

describe('font embedding eligibility and bounds', () => {
  it.each([0, 8, 0x100, 0x108])('allows full installable/editable font programs with fsType %i', (fsType) => {
    const registry = new PdfFontRegistry([face({ fsType })]);
    expect(registry.rejections.size).toBe(0);
    expect(registry.encode('fixture', 'A')).not.toBeNull();
  });

  it.each([[2, 'restricted'], [4, 'read-only'], [0x204, 'bitmap-only'], [0x208, 'bitmap-only'], [1, 'reserved'], [0x10, 'reserved']])('refuses unsupported native permissions %i with a reason', (fsType, reason) => {
    const registry = new PdfFontRegistry([face({ fsType: fsType as number })]);
    expect(registry.rejections.get('fixture')).toContain(reason);
    expect(registry.encode('fixture', 'A')).toBeNull();
  });

  it('honors legacy OS2 version rules while rejecting ambiguous modern flags', () => {
    expect(pdfFontEmbeddingProblem(0x208, 0)).toBeNull();
    expect(pdfFontEmbeddingProblem(0x208, 1)).toBeNull();
    expect(pdfFontEmbeddingProblem(0x208, 2)).toContain('bitmap');
    expect(pdfFontEmbeddingProblem(10, 2)).toBeNull();
    expect(pdfFontEmbeddingProblem(14, 2)).toBeNull();
    expect(pdfFontEmbeddingProblem(6, 2)).toContain('read-only');
    expect(pdfFontEmbeddingProblem(10, 3)).toContain('conflicting');
    expect(pdfFontEmbeddingProblem(0x8008, 2)).toContain('reserved');
    expect(new PdfFontRegistry([face({ fsType: 10, version: 2 })]).encode('fixture', 'A')).not.toBeNull();
    expect(new PdfFontRegistry([face({ fsType: 10, version: 3 })]).rejections.get('fixture')).toContain('conflicting');
  });

  it('reads native permissions from the actual program and rejects forged cache metadata', () => {
    const font = face();
    (font.bytes as Buffer).writeUInt16BE(2, fontTable(font.bytes as Buffer, 'OS/2').offset + 8);
    expect(() => new PdfFontRegistry([font])).toThrow('permissions do not match');
    expect(() => new PdfFontRegistry([{ ...face(), os2Version: 5 }])).toThrow('permissions do not match');
  });

  it('reports collection/CFF/variable formats without pretending the program is standalone TTF', () => {
    const font = face();
    expect(new PdfFontRegistry([{ ...font, bytes: fontCollection(font.bytes as Buffer) }]).rejections.get(font.key)).toContain('collections');
    const cff = new Uint8Array(font.bytes); new DataView(cff.buffer).setUint32(0, 0x4f54544f);
    expect(new PdfFontRegistry([{ ...font, bytes: cff }]).rejections.get(font.key)).toContain('glyf');
    const variable = Buffer.from(font.bytes); variable.write('fvar', fontTable(variable, 'post').record, 'ascii');
    expect(new PdfFontRegistry([{ ...font, bytes: variable }]).rejections.get(font.key)).toContain('variable');
  });

  it.each(['COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC', 'EBSC'])('keeps unsupported color/scaled bitmap table %s on fallback', (tag) => {
    const font = face(), bytes = Buffer.from(font.bytes); bytes.write(tag, fontTable(bytes, 'post').record, 'ascii');
    const registry = new PdfFontRegistry([{ ...font, bytes }]);
    expect(registry.rejections.get(font.key)).toMatch(/bitmap|color/);
    expect(registry.encode(font.key, 'A')).toBeNull();
  });

  it('retains monochrome bitmap masks and refuses a forged known origin for a bitmap glyph', () => {
    const font = face({ bitmapGlyphRange: [3, 4] });
    expect(font.metrics.glyphBoundsKnown).toEqual([true, true, true, false, false]);
    const registry = new PdfFontRegistry([font]);
    expect(registry.encode(font.key, 'A')).not.toBeNull();
    expect(registry.encode(font.key, 'B')).toBeNull();
    expect(registry.encode(font.key, '𠀀')).toBeNull();
    const changed = [...font.metrics.glyphBoundsKnown!]; changed[3] = true;
    expect(() => new PdfFontRegistry([{ ...font, metrics: { ...font.metrics, glyphBoundsKnown: changed } }])).toThrow('bitmap glyph origins');
    expect(() => new PdfFontRegistry([{ ...font, metrics: { ...font.metrics, glyphBoundsKnown: undefined } }])).toThrow('bitmap glyph origins');
    const bytes = Buffer.from(font.bytes); bytes.write('xBLC', fontTable(bytes, 'EBLC').record, 'ascii');
    expect(() => new PdfFontRegistry([{ ...font, bytes }])).toThrow('EBLC');
  });

  it('requires matching, bounded PostScript nameID6 from the actual program', () => {
    expect(() => new PdfFontRegistry([face({ postscriptName: 'A'.repeat(63) })])).not.toThrow();
    expect(() => new PdfFontRegistry([face({ postscriptName: 'A'.repeat(64) })])).toThrow('PostScript font name');
    expect(() => new PdfFontRegistry([{ ...face(), postscriptName: 'OtherName' }])).toThrow('nameID6 does not match');
    const font = face(), bytes = Buffer.from(font.bytes), name = fontTable(bytes, 'name').offset;
    bytes.writeUInt16BE(17, name + 6 + 2 * 12 + 6);
    expect(() => new PdfFontRegistry([{ ...font, bytes }])).toThrow('nameID6 does not match');
    const conflicting = Buffer.from(font.bytes), start = fontTable(conflicting, 'name').offset;
    conflicting.writeUInt16BE(6, start + 6 + 12 + 6);
    expect(() => new PdfFontRegistry([{ ...font, bytes: conflicting }])).toThrow('conflicting native PostScript');
    const badOffset = Buffer.from(font.bytes), at = fontTable(badOffset, 'name').offset;
    badOffset.writeUInt16BE(65535, at + 6 + 2 * 12 + 10);
    expect(() => new PdfFontRegistry([{ ...font, bytes: badOffset }])).toThrow('native name string');
  });

  it('rejects an unsupported native post table version despite matching descriptor values', () => {
    const font = face(), bytes = Buffer.from(font.bytes); bytes.writeUInt32BE(0x00040000, fontTable(bytes, 'post').offset);
    expect(() => new PdfFontRegistry([{ ...font, bytes }])).toThrow('post table version');
  });

  it('rejects malformed programs, metric mappings, names and mismatching descriptors', () => {
    const font = face(), broken = Buffer.from(font.bytes);
    broken.writeUInt32BE(broken.length - 4, fontTable(broken, 'glyf').record + 8);
    expect(() => new PdfFontRegistry([{ ...font, bytes: broken }])).toThrow('SFNT table');
    expect(() => new PdfFontRegistry([{ ...font, metrics: { ...font.metrics, cmap: [0] } }])).toThrow('cmap');
    expect(() => new PdfFontRegistry([{ ...font, metrics: { ...font.metrics, groups: [[0x1f600, 0x1f604, 4]] } }])).toThrow('cmap group');
    expect(() => new PdfFontRegistry([{ ...font, postscriptName: 'bad /Font' }])).toThrow('PostScript');
    expect(() => new PdfFontRegistry([{ ...font, ascender: 10 }])).toThrow('vertical');
    expect(() => new PdfFontRegistry([{ ...font, weight: 900 }])).toThrow('descriptor');
    expect(() => new PdfFontRegistry([{ ...font, bytes: new Uint8Array(11) }])).toThrow('12 bytes');
    expect(() => new PdfFontRegistry([{ ...font, bytes: new Uint8Array(64 * 1024 * 1024 + 1) }])).toThrow('64 MiB');
  });

  it('bounds face count, duplicate keys and aggregate programs before building resources', () => {
    const font = face();
    expect(() => new PdfFontRegistry(Array.from({ length: 9 }, (_, i) => ({ ...font, key: `face${i}` })))).toThrow('eight');
    expect(() => new PdfFontRegistry([font, font])).toThrow('duplicate');
    const bytes = new Uint8Array(64 * 1024 * 1024); bytes.set(font.bytes);
    expect(() => new PdfFontRegistry(['a', 'b', 'c'].map((key) => ({ ...font, key, bytes })))).toThrow('128 MiB');
  });

  it('rejects sparse bridge arrays and nested tuples before CID assignment', () => {
    const font = face();
    const damaged = <T,>(values: readonly T[], index: number) => { const copy = [...values]; delete copy[index]; return copy; };
    const sparse = [
      { advances: damaged(font.metrics.advances, 2) },
      { cmap: damaged(font.metrics.cmap, 65) },
      { groups: damaged(font.metrics.groups, 1) },
      { groups: [damaged(font.metrics.groups[0]!, 1) as unknown as [number, number, number]] },
      { fontBounds: damaged(font.metrics.fontBounds, 0) as unknown as [number, number, number, number] },
      { glyphBounds: damaged(font.metrics.glyphBounds, 2) },
      { glyphBounds: font.metrics.glyphBounds.map((box, i) => i === 2 ? damaged(box, 0) as unknown as [number, number, number, number] : box) },
      { glyphBoundsKnown: damaged(font.metrics.glyphBoundsKnown!, 2) },
    ];
    for (const change of sparse) expect(() => new PdfFontRegistry([{ ...font, metrics: { ...font.metrics, ...change } }])).toThrow(/PDF font/);
  });
});

