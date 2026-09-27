import { describe, it, expect } from 'vitest';
import { formatLength, formatAngle, parseDistance, insunitsFactor, formatArea } from '../src/core/units';
import { STANDARD_LINETYPES, findLinetype, dashArray, effectiveLinetype, patternLength, nearestLineweight } from '../src/core/linetypes';

describe('units formatting', () => {
  it('formats decimal with LUPREC digits', () => {
    expect(formatLength(2, { lunits: 2, luprec: 4 })).toBe('2.0000');
    expect(formatLength(-1.23456, { lunits: 2, luprec: 2 })).toBe('-1.23');
  });
  it('formats architectural feet-inches-fractions', () => {
    expect(formatLength(15.5, { lunits: 4, luprec: 4 })).toBe(`1'-3 1/2"`);
    expect(formatLength(12, { lunits: 4, luprec: 4 })).toBe(`1'-0"`);
    expect(formatLength(0.75, { lunits: 4, luprec: 4 })).toBe(`0'-3/4"`);
    expect(formatLength(11.99, { lunits: 4, luprec: 3 })).toBe(`1'-0"`); // rounds into the next foot
  });
  it('formats engineering, fractional and scientific', () => {
    expect(formatLength(15.5, { lunits: 3, luprec: 2 })).toBe(`1'-3.50"`);
    expect(formatLength(15.5, { lunits: 5, luprec: 4 })).toBe('15 1/2');
    expect(formatLength(15.5, { lunits: 1, luprec: 4 })).toBe('1.5500E+01');
  });
  it('formats angles in decimal degrees', () => {
    expect(formatAngle(Math.PI / 2)).toBe('90');
    expect(formatAngle(-Math.PI / 2, 1)).toBe('270.0');
    expect(formatAngle(2 * Math.PI)).toBe('0');
  });
  it('parses plain and architectural distances', () => {
    expect(parseDistance('2.5')).toBe(2.5);
    expect(parseDistance(`1'-3 1/2"`)).toBeCloseTo(15.5);
    expect(parseDistance(`6"`)).toBe(6);
    expect(parseDistance(`3/4"`)).toBe(0.75);
    expect(parseDistance(`2'`)).toBe(24);
    expect(parseDistance('abc')).toBeNull();
  });
  it('converts insertion units and formats areas', () => {
    expect(insunitsFactor(1, 4)).toBeCloseTo(25.4);
    expect(insunitsFactor(4, 1)).toBeCloseTo(1 / 25.4);
    expect(formatArea(144, { lunits: 4, luprec: 2 })).toContain('1.00 sq ft');
  });
});

describe('linetypes', () => {
  it('has the standard AutoCAD set with acad.lin patterns', () => {
    expect(findLinetype('dashed')?.pattern).toEqual([0.5, -0.25]);
    expect(findLinetype('CENTER')?.pattern).toEqual([1.25, -0.25, 0.25, -0.25]);
    expect(STANDARD_LINETYPES.map((l) => l.name)).toContain('PHANTOM');
    expect(patternLength(findLinetype('CENTER')!.pattern)).toBeCloseTo(2);
  });
  it('resolves entity / layer precedence', () => {
    expect(effectiveLinetype(undefined, undefined)).toBe('Continuous');
    expect(effectiveLinetype('ByLayer', 'HIDDEN')).toBe('HIDDEN');
    expect(effectiveLinetype('DASHED', 'HIDDEN')).toBe('DASHED');
  });
  it('scales dashes with LTSCALE and zoom, and goes continuous when too fine', () => {
    const dashed = findLinetype('DASHED')!.pattern;
    expect(dashArray(dashed, 1, 100)).toEqual([50, 25]);
    expect(dashArray(dashed, 2, 100)).toEqual([100, 50]);
    expect(dashArray(dashed, 1, 1)).toEqual([]); // 0.75 px period -> drawn solid, like AutoCAD
    // dots become 1 px dashes and odd-length patterns are doubled for the canvas
    expect(dashArray(findLinetype('DOT')!.pattern, 1, 100)).toEqual([1, 25]);
    expect(dashArray([0.5], 1, 100)).toEqual([50, 50]);
  });
  it('snaps lineweights to the AutoCAD table', () => {
    expect(nearestLineweight(0.33)).toBe(0.35);
    expect(nearestLineweight(0.26)).toBe(0.25);
  });
});
