import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { nativeFontFixture, fontTable, simpleGlyph } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import { PdfFontRegistry, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';

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
function face(options: { fsType?: number; composite?: boolean; alias?: boolean; extraGlyphs?: readonly Buffer[] } = {}): PdfFontFace {
  let bytes = nativeFontFixture({ fsType: options.fsType, format12: !options.alias, rangeOffset: options.alias, composite: options.composite, extraGlyphs: options.extraGlyphs });
  if (!options.alias) {
    const cmap = fontTable(bytes, 'cmap').offset, sub = cmap + bytes.readUInt32BE(cmap + 16);
    bytes.writeUInt32BE(0x20000, sub + 40); bytes.writeUInt32BE(0x20000, sub + 44);
  }
  if (options.alias) {
    const cmap = fontTable(bytes, 'cmap').offset;
    bytes.writeUInt16BE(1, cmap + bytes.readUInt32BE(cmap + 8) + 42);
  }
  bytes = replaceTable(bytes, 'name', nameTable('JCadFixture', false, false));
  const metrics = parseFontMetrics(bytes);
  return { key: 'fixture', bytes, metrics, postscriptName: 'JCadFixture', ascender: 1000, descender: -200, italicAngle: 0, weight: 400, isFixedPitch: false, os2Version: 2 };
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
    expect(new TextDecoder().decode(body[0])).toContain(`/Length ${body[1]!.length}`);
    return body[1]!;
  } };
}
function glyphData(program: Uint8Array, glyph: number, length: number): Buffer { return glyphBytes(program, glyph).subarray(0, length) as Buffer; }
function glyphBytes(program: Uint8Array, glyph: number): Buffer {
  const data = Buffer.from(program), glyf = fontTable(data, 'glyf'), loca = fontTable(data, 'loca'), head = fontTable(data, 'head');
  const format = data.readInt16BE(head.offset + 50);
  const start = format === 0 ? data.readUInt16BE(loca.offset + glyph * 2) * 2 : data.readUInt32BE(loca.offset + glyph * 4);
  const end = format === 0 ? data.readUInt16BE(loca.offset + (glyph + 1) * 2) * 2 : data.readUInt32BE(loca.offset + (glyph + 1) * 4);
  return Buffer.from(data.subarray(glyf.offset + start, glyf.offset + end));
}
function embedded(registry: PdfFontRegistry) {
  const out = objects(); writePdfFontResources(registry, out.writer);
  return { out, program: out.stream(4) };
}

describe('PDF writer glyf subsetting (priority 12.3)', () => {
  it('embeds only the used glyphs plus .notdef, preserving GIDs, maps and widths', () => {
    const box = [0, 0, 500, 700] as const;
    const font = face({ extraGlyphs: [simpleGlyph(box), simpleGlyph(box), simpleGlyph(box)] });
    const source = Buffer.from(font.bytes), registry = new PdfFontRegistry([font]);
    registry.encode(font.key, 'A');
    const { out, program } = embedded(registry);
    expect(program.byteLength).toBeLessThan(source.byteLength);
    expect(out.text(4)).toContain(`/Length1 ${program.byteLength}`);
    expect(glyphData(program, 0, glyphBytes(source, 0).length)).toEqual(glyphBytes(source, 0));
    expect(glyphData(program, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2));
    for (const glyph of [3, 4, 5, 6, 7]) expect(glyphBytes(program, glyph)).toHaveLength(0);
    // CIDToGIDMap and ToUnicode are byte-identical to the whole-font behaviour.
    expect(out.stream(5)).toEqual(new Uint8Array([0, 0, 0, 2]));
    expect(new TextDecoder().decode(out.stream(6))).toContain('<0001> <0041>');
    expect(new Uint8Array(font.bytes)).toEqual(new Uint8Array(source));
  });

  it('retains composite components that no codepoint references directly', () => {
    const font = face({ composite: true }), source = Buffer.from(font.bytes), registry = new PdfFontRegistry([font]);
    const run = registry.encode(font.key, '\u{20000}')!;
    expect(run.glyphs).toEqual([4]);
    const { program } = embedded(registry);
    expect(glyphData(program, 4, glyphBytes(source, 4).length)).toEqual(glyphBytes(source, 4));
    expect(glyphData(program, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2)); // closure component
    expect(glyphBytes(program, 3)).toHaveLength(0);
  });

  it('keeps Unicode aliases: two codepoints sharing one retained glyph', () => {
    const font = face({ alias: true }), source = Buffer.from(font.bytes), registry = new PdfFontRegistry([font]);
    expect(font.metrics.cmap[65]).toBe(2); expect(font.metrics.cmap[66]).toBe(2);
    registry.encode(font.key, 'AB');
    const { out, program } = embedded(registry);
    expect(glyphData(program, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2));
    expect(glyphBytes(program, 3)).toHaveLength(0);
    expect(out.stream(5)).toEqual(new Uint8Array([0, 0, 0, 2, 0, 2]));
    const unicode = new TextDecoder().decode(out.stream(6));
    expect(unicode).toContain('<0001> <0041>'); expect(unicode).toContain('<0002> <0042>');
  });

  it('retains supplementary-plane glyphs', () => {
    const font = face(), source = Buffer.from(font.bytes), registry = new PdfFontRegistry([font]);
    registry.encode(font.key, '\u{20000}A');
    const { program } = embedded(registry);
    expect(glyphData(program, 4, glyphBytes(source, 4).length)).toEqual(glyphBytes(source, 4));
    expect(glyphData(program, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2));
    expect(glyphBytes(program, 3)).toHaveLength(0);
  });

  it('embeds the whole program byte-identically when the program forbids subsetting', () => {
    const font = face({ fsType: 8 | 0x0100 }), registry = new PdfFontRegistry([font]);
    registry.encode(font.key, 'A');
    const { program } = embedded(registry);
    expect(program).toEqual(new Uint8Array(font.bytes));
  });

  it('shrinks the embedded program substantially when most glyphs are unused', () => {
    const box = [0, 0, 500, 700] as const;
    const extras = Array.from({ length: 40 }, () => simpleGlyph(box));
    const font = face({ extraGlyphs: extras }), registry = new PdfFontRegistry([font]);
    registry.encode(font.key, 'A');
    const { program } = embedded(registry);
    expect(font.bytes.byteLength - program.byteLength).toBeGreaterThan(1000);
  });
});
