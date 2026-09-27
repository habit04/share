import { describe, it, expect } from 'vitest';
import { rankSuggestions, cycleIndex, pushRecentInput, looksLikeCommandText } from '../src/ui/autocomplete';

const cmds = [
  { name: 'LINE', aliases: ['L'], description: 'Draw line segments' },
  { name: 'PLINE', aliases: ['PL'], description: 'Draw a polyline' },
  { name: 'LAYER', aliases: ['LA'], description: 'Layer properties' },
  { name: 'LIST', aliases: ['LI'], description: 'List selected objects' },
  { name: 'EXPLODE', aliases: ['X'], description: 'Explode' },
  { name: 'AELADDER', aliases: ['LADDER'], description: 'Insert ladder' },
  { name: 'CIRCLE', aliases: ['C'], description: 'Draw a circle' },
];

describe('command autocomplete ranking', () => {
  it('exact alias match first, then prefix, then mid-string', () => {
    const r = rankSuggestions('L', cmds);
    expect(r[0]!.name).toBe('LINE'); // alias L is exact
    expect(r[0]!.matchedAlias).toBe('L');
    const names = r.map((s) => s.name);
    expect(names.indexOf('LAYER')).toBeLessThan(names.indexOf('PLINE'));
    expect(names.indexOf('LIST')).toBeLessThan(names.indexOf('EXPLODE'));
    expect(names).toContain('AELADDER'); // mid-string
  });
  it('recently used commands float within their tier', () => {
    const r = rankSuggestions('LI', cmds, ['LIST']);
    expect(r[0]!.name).toBe('LIST');
    expect(r[0]!.recent).toBe(true);
    // exact alias still beats recency: LI is LIST's alias
    const r2 = rankSuggestions('LI', cmds, ['LINE']);
    expect(r2[0]!.name).toBe('LIST');
    // within the mid-string tier for "E", the recent CIRCLE comes first
    const r3 = rankSuggestions('E', cmds, ['CIRCLE']);
    expect(r3[0]!.name).toBe('EXPLODE'); // prefix tier
    expect(r3[1]!.name).toBe('CIRCLE');
  });
  it('is case-insensitive, ignores arguments and dedupes alias entries', () => {
    const map = new Map<string, (typeof cmds)[number]>();
    for (const c of cmds) {
      map.set(c.name, c);
      for (const a of c.aliases) map.set(a, c);
    }
    const r = rankSuggestions('lin 1,2', map.values());
    expect(r.map((s) => s.name)).toEqual(['LINE', 'PLINE']);
  });
  it('empty query and max limit', () => {
    expect(rankSuggestions('', cmds)).toEqual([]);
    expect(rankSuggestions('L', cmds, [], 2)).toHaveLength(2);
  });
  it('does not suggest for coordinates or numbers', () => {
    expect(looksLikeCommandText('2,3')).toBe(false);
    expect(looksLikeCommandText('@1<45')).toBe(false);
    expect(looksLikeCommandText('.5')).toBe(false);
    expect(looksLikeCommandText('li')).toBe(true);
    expect(looksLikeCommandText('?')).toBe(true);
  });
});

describe('autocomplete helpers', () => {
  it('cycles the highlighted index with wrap-around', () => {
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
  it('recent input list is bounded and de-duplicated', () => {
    let l = pushRecentInput([], 'LINE');
    l = pushRecentInput(l, 'CIRCLE');
    l = pushRecentInput(l, 'LINE');
    expect(l).toEqual(['LINE', 'CIRCLE']);
    expect(pushRecentInput(l, '  ')).toEqual(['LINE', 'CIRCLE']);
    let big: string[] = [];
    for (let i = 0; i < 30; i += 1) big = pushRecentInput(big, `C${i}`, 5);
    expect(big).toHaveLength(5);
    expect(big[0]).toBe('C29');
  });
});
