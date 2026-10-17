/**
 * UAX #9 level resolution — a curated subset of the official
 * BidiCharacterTest-15.1.0 (the full 91,707-case run is a dev-side
 * gate, recorded in the step-2B validation logs; every case below
 * is a verbatim line from that file, with levels compared AFTER
 * the paragraph-scope L1 the test file's format assumes), plus
 * L1-specific checks.
 */
import { describe, expect, it } from 'vitest';
import { bidiLevels, l1AdjustedLevels } from '../src/core/text-bidi';

function levelsOf(hex: string, para?: 0 | 1): (number | 'x')[] {
  const cps = hex.split(' ').map((h) => parseInt(h, 16));
  const raw = bidiLevels(cps, para);
  const levels = l1AdjustedLevels(cps, raw.levels, raw.paragraphLevel, 0, cps.length);
  return cps.map((_, i) => (raw.removedByX9[i] === 1 ? 'x' : levels[i]!));
}

describe('curated BidiCharacterTest lines', () => {
  it('resolves Hebrew with brackets (N0 established-context outcome)', () => {
    expect(levelsOf('05D0 0028 05D1 0029', 0)).toEqual([1, 1, 1, 1]);
    expect(levelsOf('0028 05D0 0029 05D1', 0)).toEqual([0, 1, 0, 1]);
  });
  it('resolves an empty bracket pair between Hebrew letters via N1', () => {
    expect(levelsOf('05D0 0028 0029 05D1', 0)).toEqual([1, 1, 1, 1]);
  });
  it('pairs canonically equivalent angle brackets (BD16)', () => {
    // 2329's canonical equivalent is 3008, whose pair is 3009.
    expect(levelsOf('0061 0020 2329 0062 002E 0031 3009', 1)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(levelsOf('05D0 0020 2329 05D1 002E 0031 3009', 0)).toEqual([1, 1, 1, 1, 1, 2, 1]);
  });
  it('resolves embeddings, overrides and isolates together (X1-X10)', () => {
    expect(levelsOf('202E 0061 202A 0062 202C 2066 0063 2069 202A 0064 202C 0065 202C'))
      .toEqual(['x', 1, 'x', 2, 'x', 1, 2, 1, 'x', 2, 'x', 1, 'x']);
  });
  it('raises an initiator and its PDI flanked by strong text', () => {
    expect(levelsOf('05D0 2066 202A 2069 05D1', 0)).toEqual([1, 1, 'x', 1, 1]);
  });
  it('defaults an FSI with no strong inside to LRI behaviour (X5c)', () => {
    // The AN digit inside the FSI lands on an even inner level.
    expect(levelsOf('202D 0661 202B 0662 202C 2068 0663 2069 202B 0664 202C 0665 202C', 0))
      .toEqual(['x', 2, 'x', 4, 'x', 2, 6, 2, 'x', 4, 'x', 2, 'x']);
  });
  it('resolves Arabic-Indic digits by the weak rules, not itemization folklore', () => {
    // 0661 (AN) after an Arabic letter at an even embedding level
    // rises by two (I1); the trailing Latin letter and the space
    // before it take the paragraph's LTR level — rule-derived and
    // consistent with the full-suite result.
    expect(levelsOf('0627 0661 0020 0061', 0)).toEqual([1, 2, 0, 0]);
  });
  it('resolves a bracketed AN run as a unit (N0 with AN as R)', () => {
    expect(levelsOf('05D0 0028 0661 0029', 0)).toEqual([1, 1, 2, 1]);
  });
  it('applies L1: separators and trailing whitespace reset to the paragraph level', () => {
    expect(levelsOf('0661 0009 0028 0662 0029')).toEqual([2, 0, 1, 2, 1]);
  });
});

describe('L1 line adjustment', () => {
  it('resets only the requested line range', () => {
    const cps = [0x05d0, 0x0020, 0x0061, 0x0020];
    const raw = bidiLevels(cps, 0);
    const line = l1AdjustedLevels(cps, raw.levels, 0, 0, 2);
    expect([...line]).toEqual([1, 0]);
    const whole = l1AdjustedLevels(cps, raw.levels, 0, 0, 4);
    expect(whole[3]).toBe(0);
  });
});
