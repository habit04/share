import { describe, it, expect } from 'vitest';
import { parsePointInput, isPlainNumber } from '../src/app/input';

const base = { x: 10, y: 5 };

describe('coordinate input parsing', () => {
  it('absolute and relative cartesian', () => {
    expect(parsePointInput('3,4', base)).toEqual({ x: 3, y: 4 });
    expect(parsePointInput(' -1.5 , .25 ', base)).toEqual({ x: -1.5, y: 0.25 });
    expect(parsePointInput('@2,-3', base)).toEqual({ x: 12, y: 2 });
  });
  it('polar', () => {
    const p = parsePointInput('@2<90', base)!;
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(7);
    const q = parsePointInput('1<180', base)!;
    expect(q.x).toBeCloseTo(-1);
    expect(q.y).toBeCloseTo(0);
  });
  it('rejects non-coordinates', () => {
    expect(parsePointInput('LINE', base)).toBeNull();
    expect(parsePointInput('1,2,3', base)).toBeNull();
    expect(parsePointInput('', base)).toBeNull();
    expect(parsePointInput('@', base)).toBeNull();
    expect(parsePointInput('1,', base)).toBeNull();
  });
  it('plain numbers for direct distance entry', () => {
    expect(isPlainNumber('2.5')).toBe(true);
    expect(isPlainNumber('.5')).toBe(true);
    expect(isPlainNumber('-3')).toBe(true);
    expect(isPlainNumber('2,5')).toBe(false);
    expect(isPlainNumber('U')).toBe(false);
  });
});
