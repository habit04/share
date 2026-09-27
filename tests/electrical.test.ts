import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { breakWire, findWireAt, assignWireNumbers, uniqueTag, nearestReference } from '../src/tools/electrical';
import type { LineEntity, Entity } from '../src/core/entities';

const wire = (id: string, x1: number, y: number, x2: number): LineEntity => ({ id, layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });

describe('electrical helpers', () => {
  it('breakWire returns two pieces with a gap', () => {
    const pieces = breakWire(wire('w', 0, 5, 9), 4 - 0.375, 4 + 0.375);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.b.x).toBeCloseTo(3.625);
    expect(pieces[1]!.a.x).toBeCloseTo(4.375);
    expect(pieces.every((p) => p.layer === 'WIRES')).toBe(true);
  });
  it('breakWire at an end drops the empty side', () => {
    const pieces = breakWire(wire('w', 0, 5, 9), -0.375, 0.375);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.a.x).toBeCloseTo(0.375);
  });
  it('findWireAt ignores vertical wires and far points', () => {
    const d = new Drawing();
    const vert: LineEntity = { id: 'v', layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: 1, y: 0 }, b: { x: 1, y: 9 } };
    d.addEntities([wire('h', 0, 5, 9), vert]);
    expect(findWireAt(d, { x: 4, y: 5.05 }, 0.1)?.id).toBe('h');
    expect(findWireAt(d, { x: 1, y: 3 }, 0.1)).toBeNull();
    expect(findWireAt(d, { x: 4, y: 6 }, 0.1)).toBeNull();
  });
  it('assignWireNumbers numbers each horizontal net once, top to bottom', () => {
    const d = new Drawing();
    d.addEntities([...breakWire(wire('a', 0, 8, 9), 3.6, 4.4), wire('b', 0, 7, 9), wire('c', 0, 6, 9)]);
    const n = assignWireNumbers(d, 100);
    expect(n).toBe(3);
    const nums = d.entities.filter((e): e is Extract<Entity, { type: 'text' }> => e.type === 'text' && e.layer === 'WIRENO');
    expect(nums.map((t) => t.text)).toEqual(['100', '101', '102']);
    expect(nums[0]!.position.y).toBeGreaterThan(nums[1]!.position.y);
    // re-running replaces rather than duplicates
    assignWireNumbers(d, 200);
    expect(d.entities.filter((e) => e.type === 'text' && e.layer === 'WIRENO')).toHaveLength(3);
  });
  it('uniqueTag avoids collisions', () => {
    const d = new Drawing();
    d.addEntities([{ id: 'i', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HPB11_NO', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG1: 'PB100' } }]);
    expect(uniqueTag(d, 'PB', '100')).toBe('PB101');
    expect(uniqueTag(d, 'PB', '105')).toBe('PB105');
    expect(uniqueTag(d, 'CR', null)).toBe('CR1');
  });
  it('nearestReference picks the closest rung number', () => {
    const d = new Drawing();
    d.addEntities([
      { id: 't1', layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0, y: 8 }, text: '100', height: 0.125, rotation: 0, align: 'right' },
      { id: 't2', layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0, y: 7 }, text: '101', height: 0.125, rotation: 0, align: 'right' },
    ]);
    expect(nearestReference(d, { x: 5, y: 7.1 })).toBe('101');
    expect(nearestReference(d, { x: 5, y: 3 })).toBeNull();
  });
});
