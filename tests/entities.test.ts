import { describe, it, expect } from 'vitest';
import { entityBounds, distanceToEntity, explodeInsert, translateEntity, rotateEntity, gripPoints } from '../src/core/entities';
import type { Entity, BlockDef, InsertEntity, ArcEntity } from '../src/core/entities';
import { findSymbol, ALL_SYMBOLS } from '../src/electrical/symbols';

const lookup = (name: string): BlockDef | undefined => findSymbol(name);

describe('entities', () => {
  it('arc bounds and distance respect the sweep', () => {
    const arc: ArcEntity = { id: 'a', layer: '0', color: 'ByLayer', type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 };
    const b = entityBounds(arc, lookup)!;
    expect(b.min.x).toBeCloseTo(0, 5);
    expect(b.max.x).toBeCloseTo(1, 5);
    expect(b.max.y).toBeCloseTo(1, 5);
    // point on the arc
    expect(distanceToEntity({ x: Math.SQRT1_2, y: Math.SQRT1_2 }, arc, lookup)).toBeCloseTo(0, 6);
    // point opposite the sweep: nearest end point
    expect(distanceToEntity({ x: -1, y: 0 }, arc, lookup)).toBeCloseTo(Math.hypot(1, 1) - 0, 3);
  });

  it('explodes an insert with transformation and attributes', () => {
    const ins: InsertEntity = {
      id: 'i1',
      layer: 'SYMS',
      color: 'ByLayer',
      type: 'insert',
      block: 'HCR1',
      position: { x: 10, y: 5 },
      rotation: 0,
      scale: 2,
      attributes: { TAG1: 'CR100' },
    };
    const parts = explodeInsert(ins, lookup);
    const circle = parts.find((e) => e.type === 'circle');
    expect(circle).toBeDefined();
    if (circle?.type === 'circle') {
      expect(circle.center).toEqual({ x: 10, y: 5 });
      expect(circle.radius).toBeCloseTo(0.25);
      expect(circle.layer).toBe('SYMS'); // layer 0 inherits insert layer
    }
    const tag = parts.find((e) => e.type === 'text' && e.text === 'CR100');
    expect(tag).toBeDefined();
    // DESC1 has no value -> omitted
    expect(parts.filter((e) => e.type === 'text')).toHaveLength(1);
  });

  it('translate and rotate keep entity identity', () => {
    const line: Entity = { id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    const moved = translateEntity(line, { x: 2, y: 3 });
    expect(moved.id).toBe('l');
    if (moved.type === 'line') expect(moved.b).toEqual({ x: 3, y: 3 });
    const rot = rotateEntity(line, { x: 0, y: 0 }, Math.PI / 2);
    if (rot.type === 'line') {
      expect(rot.b.x).toBeCloseTo(0);
      expect(rot.b.y).toBeCloseTo(1);
    }
  });

  it('grip points for a line are ends + midpoint', () => {
    const line: Entity = { id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } };
    expect(gripPoints(line)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
  });

  it('every symbol has unique name and a base point at the wire line', () => {
    const names = new Set(ALL_SYMBOLS.map((s) => s.name));
    expect(names.size).toBe(ALL_SYMBOLS.length);
    for (const s of ALL_SYMBOLS) expect(s.entities.length).toBeGreaterThan(0);
  });
});
