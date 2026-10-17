import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildCffTable, charstring } from './helpers/cff-font-fixture';

const require = createRequire(import.meta.url);
const { cffGlyphBounds } = require('../electron/cff-metrics.cjs') as {
  cffGlyphBounds(cffTable: Uint8Array, glyphCount: number, unitsPerEm?: number): { glyphBounds: [number, number, number, number][]; glyphBoundsKnown: boolean[] };
};

/**
 * Regression tests for the 12.2 corrections review: the Type2 operator semantics
 * below are the genuine TN5177 ones, cross-checked against Codex's independent
 * review goldens. Every case here produced unknown or
 * wrong-known bounds on the originally delivered parser.
 */
const bounds = (glyph: Buffer, extras: { localSubrs?: Buffer[]; globalSubrs?: Buffer[] } = {}) =>
  cffGlyphBounds(buildCffTable({ glyphs: [glyph], localSubrs: [], globalSubrs: [], ...extras }), 1);

describe('Type2 flex operator dispatch (TN5177 section 4.1)', () => {
  it('hflex (12 34) takes seven operands and cancels dy2 in the second curve', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 'hflex', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 250, 30]]);
  });

  it('flex (12 35) takes twelve deltas plus the depth operand', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 50, 'flex', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 360, 420]]);
  });

  it('hflex1 (12 36) takes nine operands and returns the endpoint to the starting y', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 'hflex1', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 310, 140]]);
  });

  it('flex1 (12 37) takes five pairs plus d6', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 'flex1', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 250, 410]]);
  });

  it('flex1 returns the nondominant endpoint coordinate to the flex start for later operators', () => {
    // After the y-dominant flex1 the current point is (0, 410), not (250, 410):
    // the following rlineto must start from x = 0, so the hull reaches -200.
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 'flex1', -200, 0, 'rlineto', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[-200, 0, 250, 410]]);
  });

  it('flex1 with an x-dominant sum returns the endpoint y to the flex start', () => {
    const glyph = charstring([0, 0, 'rmoveto', 20, 10, 40, 30, 60, 40, 80, 60, 100, 70, 110, 'flex1', 0, -200, 'rlineto', 'endchar']);
    // Sums: dx = 300, dy = 210, so the endpoint is (last control x + 110, start y = 0);
    // the rlineto then reaches y = -200 from x = 410.
    expect(bounds(glyph).glyphBounds).toEqual([[0, -200, 410, 210]]);
  });
});

describe('hvcurveto/vhcurveto optional final operand', () => {
  it('hvcurveto treats the fifth operand as the final dx, not a first-curve control', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 'hvcurveto', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 80, 70]]);
  });

  it('vhcurveto treats the fifth operand as the final dy', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 'vhcurveto', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 60, 90]]);
  });

  it('hvcurveto applies the ninth operand to the second curve endpoint along its missing axis', () => {
    const glyph = charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 60, 70, 80, 90, 'hvcurveto', 'endchar']);
    expect(bounds(glyph).glyphBounds).toEqual([[0, 0, 170, 280]]);
  });

  it('hhcurveto/vvcurveto keep the optional FIRST operand as the initial cross control (controls)', () => {
    expect(bounds(charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 'hhcurveto', 'endchar'])).glyphBounds).toEqual([[0, 0, 100, 50]]);
    expect(bounds(charstring([0, 0, 'rmoveto', 10, 20, 30, 40, 50, 'vvcurveto', 'endchar'])).glyphBounds).toEqual([[0, 0, 40, 110]]);
  });
});

describe('subroutine operand retention and termination', () => {
  it('keeps a pending operand for an hmoveto inside the first callgsubr (implicit width state)', () => {
    // Raw subr: hmoveto (consumes the caller's 100), 0 100 rlineto, return.
    const glyph = charstring([100, -107, 'callgsubr', 'endchar']);
    const result = bounds(glyph, { globalSubrs: [Buffer.from([0x16, 0x8b, 0xef, 0x05, 0x0b])] });
    expect(result.glyphBounds).toEqual([[100, 0, 100, 100]]);
    expect(result.glyphBoundsKnown).toEqual([true]);
  });

  it('keeps an explicit width for an rmoveto inside the first callgsubr', () => {
    // Raw subr: rmoveto (consumes width 500, then 100 200), 0 100 rlineto, return.
    const glyph = charstring([500, 100, 200, -107, 'callgsubr', 'endchar']);
    const result = bounds(glyph, { globalSubrs: [Buffer.from([0x15, 0x8b, 0xef, 0x05, 0x0b])] });
    expect(result.glyphBounds).toEqual([[100, 200, 100, 300]]);
    expect(result.glyphBoundsKnown).toEqual([true]);
  });

  it('propagates an endchar inside a subr as glyph termination', () => {
    const glyph = charstring([650, -107, 'callsubr']);
    const subr = charstring([0, 0, 'rmoveto', 100, 'hlineto', 100, 'vlineto', 'endchar']);
    const result = bounds(glyph, { localSubrs: [subr] });
    expect(result.glyphBounds).toEqual([[0, 0, 100, 100]]);
    expect(result.glyphBoundsKnown).toEqual([true]);
  });

  it('still refuses the deprecated seac endchar form inside a subr', () => {
    const glyph = charstring([650, -107, 'callsubr']);
    const result = bounds(glyph, { localSubrs: [charstring([1, 2, 3, 4, 'endchar'])] });
    expect(result.glyphBoundsKnown).toEqual([false]);
  });

  it('marks a zero-length charstring unknown instead of a known empty outline', () => {
    const result = cffGlyphBounds(buildCffTable({ glyphs: [Buffer.alloc(0)], localSubrs: [], globalSubrs: [] }), 1);
    expect(result.glyphBounds).toEqual([[0, 0, 0, 0]]);
    expect(result.glyphBoundsKnown).toEqual([false]);
  });
});
