import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildCffTable, cffFontFixture, cffPdfFontFixture } from './helpers/cff-font-fixture';
import { PdfFontRegistry, type PdfFontFace } from '../src/io/pdf-fonts';

const require = createRequire(import.meta.url);
const { cffGlyphBounds, parseCff } = require('../electron/cff-metrics.cjs') as {
  cffGlyphBounds(cffTable: Uint8Array, glyphCount: number, unitsPerEm?: number): { glyphBounds: [number, number, number, number][]; glyphBoundsKnown: boolean[] };
  parseCff(data: Uint8Array, glyphCount: number, unitsPerEm?: number): unknown;
};
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): unknown };

/** Minimal CFF assembler for structural DICT cases the SFNT fixture cannot express. */
function indexOf(entries: readonly Buffer[]): Buffer {
  if (!entries.length) return Buffer.from([0, 0]);
  let total = 1;
  const offsets = entries.map((entry) => { const at = total; total += entry.length; return at; });
  const data = Buffer.alloc(3 + (entries.length + 1) * 4 + entries.reduce((sum, entry) => sum + entry.length, 0));
  data.writeUInt16BE(entries.length, 0); data[2] = 4;
  [...offsets, total].forEach((offset, i) => data.writeUInt32BE(offset, 3 + i * 4));
  let position = 3 + (entries.length + 1) * 4;
  for (const entry of entries) { entry.copy(data, position); position += entry.length; }
  return data;
}
const fixed = (value: number) => [29, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
function assemble(buildTop: (charStringsAt: number, privateAt: number) => Buffer, privateDict?: Buffer): Buffer {
  const header = Buffer.from([1, 0, 4, 4]);
  const name = indexOf([Buffer.from('X')]), strings = indexOf([]), gsubrs = indexOf([]);
  const charStrings = indexOf([Buffer.from([14])]);
  // Offsets inside the top dict use fixed 5-byte ints, so the dict length (and
  // therefore the whole layout) is known before the offset values are.
  const probe = buildTop(0, 0);
  const charStringsAt = header.length + name.length + indexOf([probe]).length + strings.length + gsubrs.length;
  const top = buildTop(charStringsAt, charStringsAt + charStrings.length);
  if (top.length !== probe.length) throw new Error('layout drift');
  return Buffer.concat([header, name, indexOf([top]), strings, gsubrs, charStrings, ...(privateDict ? [privateDict] : [])]);
}

describe('CFF DICT semantic guards (metrics parser)', () => {
  it('requires Type 2 charstrings: CharstringType 1 refuses, explicit 2 parses', () => {
    expect(() => parseFontMetrics(cffFontFixture({ cff: { charstringType: 1 } }))).toThrow(/CharstringType/);
    expect(() => cffGlyphBounds(buildCffTable({ charstringType: 1 }), 7)).toThrow(/CharstringType/);
    expect(parseFontMetrics(cffFontFixture({ cff: { charstringType: 2 } }))).toBeTruthy();
  });

  it('refuses stroking PaintType and accepts an explicit fill PaintType 0', () => {
    expect(() => parseFontMetrics(cffFontFixture({ cff: { paintType: 2 } }))).toThrow(/PaintType/);
    expect(parseFontMetrics(cffFontFixture({ cff: { paintType: 0 } }))).toBeTruthy();
  });

  it('refuses SyntheticBase presence', () => {
    expect(() => parseFontMetrics(cffFontFixture({ cff: { syntheticBase: true } }))).toThrow(/SyntheticBase/);
  });

  it('accepts the uniform FontMatrix consistent with unitsPerEm and refuses the rest', () => {
    expect(parseFontMetrics(cffFontFixture({ cff: { fontMatrix: ['0.001', '0', '0', '0.001', '0', '0'] } }))).toBeTruthy();
    expect(() => parseFontMetrics(cffFontFixture({ cff: { fontMatrix: ['0.001', '0.001', '0', '0.001', '0', '0'] } }))).toThrow(/FontMatrix/);
    expect(() => parseFontMetrics(cffFontFixture({ cff: { fontMatrix: ['0.002', '0', '0', '0.002', '0', '0'] } }))).toThrow(/FontMatrix/);
    expect(() => parseFontMetrics(cffFontFixture({ cff: { fontMatrix: ['0.001', '0', '0', '0.002', '0', '0'] } }))).toThrow(/FontMatrix/);
    const table = buildCffTable({ fontMatrix: ['0.001', '0', '0', '0.001', '0', '0'] });
    expect(cffGlyphBounds(table, 7, 1000).glyphBoundsKnown).toContain(true);
    expect(() => cffGlyphBounds(table, 7, 2048)).toThrow(/FontMatrix/);
  });
});

describe('CFF DICT structural budgets (metrics parser)', () => {
  it('refuses an oversized Private DICT before parsing its entries', () => {
    const table = assemble((charStringsAt, privateAt) => Buffer.from([...fixed(charStringsAt), 17, ...fixed(70000), ...fixed(privateAt), 18]), Buffer.alloc(70000, 139));
    expect(() => parseCff(table, 1)).toThrow(/safe size limit/);
  });

  it('refuses a DICT real token beyond the digit budget before building a huge string', () => {
    const nibbles: number[] = [];
    for (let i = 0; i < 40; i++) nibbles.push(1);
    nibbles.push(15);
    const real: number[] = [30];
    for (let i = 0; i < nibbles.length; i += 2) real.push(nibbles[i]! * 16 + (nibbles[i + 1] ?? 15));
    const table = assemble((charStringsAt) => Buffer.from([...real, 0, ...fixed(charStringsAt), 17]));
    expect(() => parseCff(table, 1)).toThrow(/real number exceeds the safe limit/);
  });

  it('refuses a Top DICT beyond the entry budget', () => {
    const filler = Array.from({ length: 1030 }, () => [139, 0]).flat();
    const table = assemble((charStringsAt) => Buffer.from([...filler, ...fixed(charStringsAt), 17]));
    expect(() => parseCff(table, 1)).toThrow(/entry count exceeds the safe limit/);
  });
});

describe('CFF writer validator mirrors the parser guards', () => {
  const honest = cffPdfFontFixture();
  const forged = (cff: NonNullable<Parameters<typeof cffFontFixture>[0]>['cff']): PdfFontFace => ({ key: 'cff', ...honest, bytes: cffFontFixture({ fsType: 8, cff }) });

  it('rejects CharstringType, PaintType, SyntheticBase and inconsistent FontMatrix at embedding', () => {
    expect(new PdfFontRegistry([forged({ charstringType: 1 })]).rejections.get('cff')).toContain('CharstringType');
    expect(new PdfFontRegistry([forged({ paintType: 2 })]).rejections.get('cff')).toContain('PaintType');
    expect(new PdfFontRegistry([forged({ syntheticBase: true })]).rejections.get('cff')).toContain('synthetic');
    expect(new PdfFontRegistry([forged({ fontMatrix: ['0.001', '0.001', '0', '0.001', '0', '0'] })]).rejections.get('cff')).toContain('FontMatrix');
    expect(new PdfFontRegistry([forged({ fontMatrix: ['0.002', '0', '0', '0.002', '0', '0'] })]).rejections.get('cff')).toContain('FontMatrix');
  });

  it('accepts an explicit Type 2 CharstringType and a consistent FontMatrix', () => {
    expect(new PdfFontRegistry([forged({ charstringType: 2 })]).rejections.size).toBe(0);
    expect(new PdfFontRegistry([forged({ fontMatrix: ['0.001', '0', '0', '0.001', '0', '0'] })]).rejections.size).toBe(0);
  });
});
