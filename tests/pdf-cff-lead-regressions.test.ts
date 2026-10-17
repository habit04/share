import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { PdfFontRegistry } from '../src/io/pdf-fonts';
import { buildCffTable, charstring, cffFontFixture, cffPdfFontFixture } from './helpers/cff-font-fixture';
import { fontTable, fvarNameEntries, fvarTable, VARIABLE_AXES, VARIABLE_INSTANCES } from './helpers/native-font-fixture';

const require = createRequire(import.meta.url);
const { cffGlyphBounds, parseCff } = require('../electron/cff-metrics.cjs') as {
  cffGlyphBounds(data: Uint8Array, count: number): { glyphBoundsKnown: boolean[] };
  parseCff(data: Uint8Array, count: number, upem?: number): unknown;
};
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): unknown };

describe('CFF effective default FontMatrix byte validation', () => {
  it('refuses an omitted .001 matrix inconsistent with the program units', () => {
    const fixture = cffPdfFontFixture();
    const bytes = Buffer.from(fixture.bytes);
    bytes.writeUInt16BE(2048, fontTable(bytes, 'head').offset + 18);
    const registry = new PdfFontRegistry([{ ...fixture, key: 'cff', bytes, metrics: { ...fixture.metrics, unitsPerEm: 2048 } }]);
    expect(registry.face('cff')).toBeUndefined();
    expect(registry.rejections.get('cff')).toContain('FontMatrix does not match');
    expect(registry.encode('cff', 'AB')).toBeNull();
  });

  it('preserves a coherent implicit .001 matrix with unitsPerEm 1000', () => {
    const registry = new PdfFontRegistry([{ ...cffPdfFontFixture(), key: 'cff' }]);
    expect(registry.rejections.size).toBe(0);
    expect(registry.encode('cff', 'AB')).not.toBeNull();
  });
});

describe('CFF omitted matrix and late endchar width', () => {
  it('checks the effective matrix while preserving optional-UPEM compatibility', () => {
    const table = buildCffTable();
    expect(() => parseCff(table, 7, 2048)).toThrow(/FontMatrix/);
    expect(() => parseCff(table, 7, 1000)).not.toThrow();
    expect(() => parseCff(table, 7)).not.toThrow();
  });

  it('marks a residual endchar operand unknown after a move has consumed width', () => {
    const table = buildCffTable({ glyphs: [charstring([0, 0, 'rmoveto', 10, 10, 'rlineto', 500, 'endchar'])] });
    expect(cffGlyphBounds(table, 1).glyphBoundsKnown).toEqual([false]);
  });

  it('keeps a legitimate initial width-only endchar known', () => {
    const table = buildCffTable({ glyphs: [charstring([500, 'endchar'])] });
    expect(cffGlyphBounds(table, 1).glyphBoundsKnown).toEqual([true]);
  });
});

describe('CFF and variable-font admission remain separate', () => {
  it('refuses CFF plus fvar in the reader and actual-byte writer validator', () => {
    const bytes = cffFontFixture({ fsType: 8, extraTables: { fvar: fvarTable() }, extraNames: fvarNameEntries(VARIABLE_AXES, VARIABLE_INSTANCES) });
    expect(() => parseFontMetrics(bytes)).toThrow(/variable CFF/i);
    const honest = cffPdfFontFixture();
    const registry = new PdfFontRegistry([{ ...honest, key: 'cff-variable', bytes, metrics: { ...honest.metrics, variable: true } }]);
    expect(registry.face('cff-variable')).toBeUndefined();
    expect(registry.rejections.get('cff-variable')).toMatch(/variable CFF/i);
    expect(registry.encode('cff-variable', 'AB')).toBeNull();
  });

  it.each(['glyf', 'loca'])('refuses a CFF program also declaring a %s table', (tag) => {
    const bytes = cffFontFixture({ fsType: 8, extraTables: { [tag]: Buffer.alloc(4) } });
    expect(() => parseFontMetrics(bytes)).toThrow(/mixed CFF and TrueType/i);
    const registry = new PdfFontRegistry([{ ...cffPdfFontFixture(), key: 'mixed', bytes }]);
    expect(registry.rejections.get('mixed')).toMatch(/mixed CFF and TrueType/i);
    expect(registry.face('mixed')).toBeUndefined(); expect(registry.encode('mixed', 'AB')).toBeNull();
  });
});
