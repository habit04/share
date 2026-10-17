/**
 * UAX #29 grapheme segmentation — the FULL official
 * GraphemeBreakTest-15.1.0 (vendored under scripts/ucd-15.1.0/)
 * plus API-level checks. The full-run dev-side record for both
 * conformance suites is in the step-2B validation logs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  graphemeBoundaries,
  graphemeBoundaryIndices,
  graphemeStartAtOrBefore,
  isGraphemeBoundary,
} from '../src/core/text-grapheme';

describe('GraphemeBreakTest-15.1.0 (full, vendored)', () => {
  it('matches every break/no-break decision in the official file', () => {
    const path = fileURLToPath(new URL('../scripts/ucd-15.1.0/auxiliary/GraphemeBreakTest.txt', import.meta.url));
    const text = readFileSync(path, 'utf8');
    let cases = 0;
    const failures: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.split('#')[0]!.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const cps: number[] = [];
      const breaks: boolean[] = [];
      for (const token of tokens) {
        if (token === '÷') breaks.push(true);
        else if (token === '×') breaks.push(false);
        else cps.push(parseInt(token, 16));
      }
      cases += 1;
      const boundaries = graphemeBoundaryIndices(cps);
      for (let i = 0; i < cps.length; i += 1) {
        if (boundaries.includes(i) !== breaks[i] && failures.length < 8) {
          failures.push(`case ${cases} pos ${i}: want break=${breaks[i]} in [${cps.map((c) => c.toString(16)).join(' ')}]`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(cases).toBe(1187);
  });
});

describe('grapheme API', () => {
  it('keeps an 8-mark Arabic run in one cluster', () => {
    const text = 'ب' + 'ً'.repeat(8);
    expect(graphemeBoundaries(text)).toEqual([0, text.length]);
  });
  it('keeps a Devanagari conjunct and a ZWJ emoji sequence whole', () => {
    expect(graphemeBoundaries('क्ष')).toEqual([0, 3]);
    const family = '👨‍👩‍👧';
    expect(graphemeBoundaries(family)).toEqual([0, family.length]);
  });
  it('splits CRLF atomically and RI flags pairwise', () => {
    expect(graphemeBoundaries('a\r\nb')).toEqual([0, 1, 3, 4]);
    const flags = '🇦🇧🇨';
    expect(graphemeBoundaries(flags)).toEqual([0, 4, 6]);
  });
  it('moves a proposed split back to the grapheme start', () => {
    const text = 'a' + 'e' + '́' + 'b';
    const boundaries = graphemeBoundaries(text);
    expect(isGraphemeBoundary(boundaries, 2)).toBe(false);
    expect(graphemeStartAtOrBefore(boundaries, 2)).toBe(1);
    expect(graphemeStartAtOrBefore(boundaries, 3)).toBe(3);
  });
});
