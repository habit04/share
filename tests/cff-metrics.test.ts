import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildCffTable, cffFontFixture, charstring, defaultCffGlyphs } from './helpers/cff-font-fixture';
import { fontTable } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';

const require = createRequire(import.meta.url);
const { cffGlyphBounds } = require('../electron/cff-metrics.cjs') as {
  cffGlyphBounds(cffTable: Uint8Array, glyphCount: number): { glyphBounds: [number, number, number, number][]; glyphBoundsKnown: boolean[] };
};
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

const tableOf = (font: Buffer) => font.subarray(fontTable(font, 'CFF ').offset, fontTable(font, 'CFF ').offset + fontTable(font, 'CFF ').length);

describe('bounded CFF charstring bounds evaluator', () => {
  it('evaluates the authored glyph set: lines, curves, local/global subrs, width-only and seac', () => {
    const result = cffGlyphBounds(buildCffTable(), 7);
    expect(result.glyphBounds).toEqual([
      [0, 0, 500, 700], [0, 0, 0, 0], [-20, 0, 620, 730], [40, 0, 600, 700],
      [0, -100, 700, 700], [0, 0, 0, 0], [100, 100, 300, 400],
    ]);
    expect(result.glyphBoundsKnown).toEqual([true, true, true, true, true, false, true]);
  });

  it('accepts a format 1 range charset with the same coverage', () => {
    const result = cffGlyphBounds(buildCffTable({ charsetFormat: 1 }), 7);
    expect(result.glyphBounds[2]).toEqual([-20, 0, 620, 730]);
    expect(result.glyphBoundsKnown).toEqual([true, true, true, true, true, false, true]);
  });

  it('skips hintmask mask bytes using the declared stem count', () => {
    const glyphs = [charstring([650, 0, 100, 'hstemhm', 'hintmask', { raw: [0] }, 10, 20, 'rmoveto', 100, 'hlineto', 100, 'vlineto', 'endchar'])];
    const result = cffGlyphBounds(buildCffTable({ glyphs, localSubrs: [], globalSubrs: [] }), 1);
    expect(result.glyphBounds).toEqual([[10, 20, 110, 120]]);
    expect(result.glyphBoundsKnown).toEqual([true]);
  });

  it('evaluates flex and hhcurveto control hulls', () => {
    const flex = charstring([650, 0, 0, 'rmoveto', 10, 20, 30, 40, 50, 0, 0, 50, -50, 0, -30, -40, 0, 'flex', 'endchar']);
    const hh = charstring([650, 0, 0, 'rmoveto', 100, 50, 200, 50, 'hhcurveto', 'endchar']);
    const result = cffGlyphBounds(buildCffTable({ glyphs: [flex, hh], localSubrs: [], globalSubrs: [] }), 2);
    expect(result.glyphBounds).toEqual([[0, 0, 90, 110], [0, 0, 200, 200]]);
    expect(result.glyphBoundsKnown).toEqual([true, true]);
  });

  it('rounds fractional fixed-point coordinates outward to integer bounds', () => {
    const glyphs = [charstring([650, { raw: [255, 0, 100, 128, 0] }, 0, 'rmoveto', 'endchar'])];
    const result = cffGlyphBounds(buildCffTable({ glyphs, localSubrs: [], globalSubrs: [] }), 1);
    expect(result.glyphBounds).toEqual([[100, 0, 101, 0]]);
  });

  it.each([
    ['self-recursive subr', charstring([500, -107, 'callsubr', 'endchar']), [charstring([-107, 'callsubr', 'return'])]],
    ['operand stack overflow', charstring([500, ...Array.from({ length: 60 }, () => 0), 'rlineto', 'endchar']), []],
    ['missing endchar', charstring([500, 0, 0, 'rmoveto']), []],
    ['reserved operator', charstring([500, { raw: [2] }, 'endchar']), []],
    ['subr index out of range', charstring([500, 100, 'callsubr', 'endchar']), []],
    ['return at top level', charstring([500, 'return']), []],
  ])('marks %s unknown instead of guessing or hanging', (_name, glyph, localSubrs) => {
    const result = cffGlyphBounds(buildCffTable({ glyphs: [glyph], localSubrs, globalSubrs: [] }), 1);
    expect(result.glyphBounds).toEqual([[0, 0, 0, 0]]);
    expect(result.glyphBoundsKnown).toEqual([false]);
  });

  it('refuses fonts whose total charstring work exceeds the safe limit', () => {
    const glyph = charstring([500, ...Array.from({ length: 11000 }, () => [0, 0, 'rlineto']).flat(), 'endchar']);
    expect(() => cffGlyphBounds(buildCffTable({ glyphs: Array.from({ length: 200 }, () => glyph), localSubrs: [], globalSubrs: [] }), 200)).toThrow('safe limit');
  });

  it('refuses a single charstring beyond the size limit before evaluating it', () => {
    expect(() => cffGlyphBounds(buildCffTable({ glyphs: [Buffer.alloc(1024 * 1024 + 1, 32)], localSubrs: [], globalSubrs: [] }), 1)).toThrow('safe size limit');
  });

  it.each([
    ['CharStrings count mismatch', () => cffGlyphBounds(buildCffTable(), 8), /count does not match/],
    ['charset offset out of range', () => cffGlyphBounds(buildCffTable({ charsetOffsetOverride: 999999 }), 7), /charset/],
    ['CID-keyed ROS', () => cffGlyphBounds(buildCffTable({ ros: true }), 7), /CID-keyed/],
    ['CFF2 header', () => cffGlyphBounds(buildCffTable({ major: 2 }), 7), /CFF2/],
    ['truncated table', () => cffGlyphBounds(buildCffTable().subarray(0, 24), 7), /truncated|invalid/],
  ])('refuses structurally invalid CFF: %s', (_name, run, pattern) => {
    expect(run).toThrow(pattern);
  });
});

describe('CFF metrics through the shared SFNT reader', () => {
  it('derives advances, cmap, names and bounds from an OTTO program', () => {
    const metrics = parseFontMetrics(cffFontFixture());
    expect(metrics.family).toBe('JCad CFF Fixture');
    expect(metrics.subfamily).toBe('Regular');
    expect(metrics.unitsPerEm).toBe(1000);
    expect(metrics.capitalHeight).toBe(730);
    expect(metrics.advances).toEqual([500, 300, 650, 650, 650, 650, 650]);
    expect(metrics.cmap[32]).toBe(1); expect(metrics.cmap[65]).toBe(2); expect(metrics.cmap[66]).toBe(3); expect(metrics.cmap[67]).toBe(5);
    expect(metrics.groups).toContainEqual([0x20000, 0x20000, 4]);
    expect(metrics.glyphBounds).toEqual([
      [0, 0, 500, 700], [0, 0, 0, 0], [-20, 0, 620, 730], [40, 0, 600, 700],
      [0, -100, 700, 700], [0, 0, 0, 0], [100, 100, 300, 400],
    ]);
    expect(metrics.glyphBoundsKnown).toEqual([true, true, true, true, true, false, true]);
    expect(metrics.fsType).toBe(0); expect(metrics.bold).toBe(false); expect(metrics.italic).toBe(false);
  });

  it('honors a capital height authored into the CFF A glyph', () => {
    expect(parseFontMetrics(cffFontFixture({ capitalHeight: 640 })).capitalHeight).toBe(640);
  });

  it('refuses CID-keyed and CFF2 programs through the SFNT reader', () => {
    expect(() => parseFontMetrics(cffFontFixture({ cff: { ros: true } }))).toThrow(/CID-keyed/);
    expect(() => parseFontMetrics(cffFontFixture({ cff: { major: 2 } }))).toThrow(/CFF2/);
    const tagged = cffFontFixture(); tagged.write('CFF2', fontTable(tagged, 'CFF ').record, 'ascii');
    expect(() => parseFontMetrics(tagged)).toThrow(/CFF2/);
  });

  it('refuses an OTTO program whose CFF table was renamed away', () => {
    const font = cffFontFixture(); font.write('XXXX', fontTable(font, 'CFF ').record, 'ascii');
    expect(() => parseFontMetrics(font)).toThrow();
    expect(tableOf(cffFontFixture()).length).toBeGreaterThan(100);
    expect(defaultCffGlyphs()).toHaveLength(7);
  });
});
