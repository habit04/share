import { describe, expect, it } from 'vitest';
import { nearestReference, referenceFinder } from '../src/electrical/ladder';
import { DEFAULT_HEADER } from '../src/core/document';
import type { TextEntity } from '../src/core/entities';
describe('report rung reference index', () => {
  it('matches the scan including duplicate heights, drawing-order ties, metric tolerance and empty input', () => {
    const ys = [2, 1, 3, 1, 0, 5, 4];
    const entities: TextEntity[] = ys.map((y, i) => ({ id: String(i), type: 'text', layer: 'MISC', color: 'ByLayer', text: String(100 + i), position: { x: 0, y }, rotation: 0, height: 0.1, align: 'left' }));
    for (const insunits of [1, 4]) {
      const doc = { entities, header: { ...DEFAULT_HEADER, units: { ...DEFAULT_HEADER.units, insunits } } };
      const indexed = referenceFinder(doc);
      for (let y = -1; y < 7; y += 0.05) expect(indexed({ x: 50, y })).toBe(nearestReference(doc, { x: 50, y }));
      for (const y of [0.5, 1, 1.5, 2.5]) expect(indexed({ x: 0, y })).toBe(nearestReference(doc, { x: 0, y }));
    }
    expect(referenceFinder({ entities: [] })({ x: 0, y: 0 })).toBeNull();
  });
});
