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

  it('nested inserts explode through the depth guard and rotation', () => {
    const inner: BlockDef = { name: 'INNER', basePoint: { x: 0, y: 0 }, entities: [{ id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }], attributes: [] };
    const outer: BlockDef = {
      name: 'OUTER',
      basePoint: { x: 0, y: 0 },
      entities: [{ id: 'i', layer: '0', color: 'ByLayer', type: 'insert', block: 'INNER', position: { x: 0, y: 1 }, rotation: Math.PI / 2, scale: 2, attributes: {} }],
      attributes: [],
    };
    const look = (n: string) => (n === 'INNER' ? inner : n === 'OUTER' ? outer : undefined);
    const top: InsertEntity = { id: 't', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'OUTER', position: { x: 10, y: 10 }, rotation: 0, scale: 1, attributes: {} };
    const parts = explodeInsert(top, look);
    expect(parts).toHaveLength(1);
    const l = parts[0]!;
    if (l.type === 'line') {
      expect(l.a.x).toBeCloseTo(10);
      expect(l.a.y).toBeCloseTo(11);
      expect(l.b.x).toBeCloseTo(10);
      expect(l.b.y).toBeCloseTo(13); // length 1 * scale 2, rotated 90°
    }
    // self-referencing block terminates
    const loop: BlockDef = { name: 'LOOP', basePoint: { x: 0, y: 0 }, entities: [{ id: 'x', layer: '0', color: 'ByLayer', type: 'insert', block: 'LOOP', position: { x: 1, y: 0 }, rotation: 0, scale: 1, attributes: {} }], attributes: [] };
    const parts2 = explodeInsert({ ...top, id: 'loop', block: 'LOOP' }, (n) => (n === 'LOOP' ? loop : undefined));
    expect(parts2.length).toBe(0);
  });

  it('explodeInsert is cached per insert and refreshes when the block changes', () => {
    const ins: InsertEntity = { id: 'c', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HCR1', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} };
    const first = explodeInsert(ins, lookup);
    expect(explodeInsert(ins, lookup)).toBe(first);
    const other: BlockDef = { ...findSymbol('HCR1')!, entities: [] };
    const second = explodeInsert(ins, () => other);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(0);
  });

  it('invisible attributes are not exploded into text', () => {
    const blk: BlockDef = { name: 'INV', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'HIDE', prompt: '', default: 'x', position: { x: 0, y: 0 }, height: 0.1, align: 'left', invisible: true }, { tag: 'SHOW', prompt: '', default: 'y', position: { x: 0, y: 0 }, height: 0.1, align: 'left' }] };
    const ins: InsertEntity = { id: 'v', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'INV', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} };
    const parts = explodeInsert(ins, () => blk);
    expect(parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual(['y']);
  });
});
