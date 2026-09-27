import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId, entityBounds } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { breakWire, wireDot } from '../src/electrical/ladder';
import {
  trimWireAt,
  wireCrossings,
  insertWireGaps,
  scootComponent,
  relocateComponent,
  alignComponents,
  buildBus,
  DEFAULT_BUS,
  threePhaseWires,
  insertThreePole,
  assignWireNumbers,
  collectNets,
  netOfWireNumber,
  wireNumberState,
  applyWireNumberEdit,
  findReplaceWireNumbers,
  copyWireNumber,
  wireNumberLeader,
  scootWireNumber,
  applyWireEdit,
  wireDegree,
  staleDots,
  liftFromWires,
  breakForInsert,
  connectionLevels,
  isWireNumber,
} from '../src/electrical/wires';

const wire = (x1: number, y1: number, x2: number, y2: number, layer = 'WIRES'): LineEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const ins = (block: string, x: number, y: number, attrs: Record<string, string> = {}): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });

function doc(entities: Entity[]): Drawing {
  const d = new Drawing();
  d.ensureBlocks(ALL_SYMBOLS);
  d.addEntities(entities);
  return d;
}

describe('trim wire', () => {
  it('removes only the segment between tees and drops stale dots', () => {
    const main = wire(1, 8, 10, 8);
    const d = doc([main, wire(4, 8, 4, 7), wire(7, 8, 7, 7), wireDot({ x: 4, y: 8 }), wireDot({ x: 7, y: 8 })]);
    expect(wireDegree(d.entities, { x: 4, y: 8 })).toBe(3);
    const edit = trimWireAt(d.entities, main, { x: 5.5, y: 8 });
    applyWireEdit(d, edit);
    const wires = d.entities.filter((e): e is LineEntity => e.type === 'line' && Math.abs(e.a.y - 8) < 1e-9 && Math.abs(e.b.y - 8) < 1e-9);
    expect(wires.map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((a, b) => a[0]! - b[0]!)).toEqual([[1, 4], [7, 10]]);
    // the dots at 4 and 7 now sit on corners (degree 2) and are removed
    expect(d.entities.filter((e) => e.type === 'insert' && e.block === 'WDDOT')).toHaveLength(0);
    expect(staleDots(d.entities)).toHaveLength(0);
  });
  it('trims a whole wire when there are no tees', () => {
    const w = wire(0, 5, 3, 5);
    const d = doc([w, wire(3, 5, 3, 2)]);
    const edit = trimWireAt(d.entities, w, { x: 1, y: 5 });
    expect(edit.remove).toContain(w.id);
    expect(edit.add).toHaveLength(0);
  });
});

describe('wire gaps and loops', () => {
  it('finds true crossings and gaps the wire there', () => {
    const h = wire(0, 5, 10, 5);
    const v1 = wire(3, 0, 3, 9);
    const v2 = wire(6, 0, 6, 9);
    const tee = wire(8, 5, 8, 9); // endpoint on h: a tee, not a crossing
    const d = doc([h, v1, v2, tee]);
    expect(wireCrossings(d.entities, h).map((p) => p.x)).toEqual([3, 6]);
    const edit = insertWireGaps(d.entities, h, 'loop', 0.1);
    applyWireEdit(d, edit);
    const pieces = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 5 && e.b.y === 5);
    expect(pieces).toHaveLength(3);
    expect(pieces.map((p) => Math.max(p.a.x, p.b.x)).sort((a, b) => a - b)).toEqual([2.9, 5.9, 10]);
    expect(d.entities.filter((e) => e.type === 'arc')).toHaveLength(2);
    // vertical wire loops use a right-hand semicircle
    const v = wire(3, 0, 3, 9);
    const e2 = insertWireGaps([wire(0, 5, 10, 5), v], v, 'loop');
    const arc = e2.add.find((e) => e.type === 'arc');
    expect(arc && arc.type === 'arc' && arc.startAngle).toBeCloseTo(-Math.PI / 2);
  });
  it('does nothing without crossings', () => {
    const h = wire(0, 5, 10, 5);
    expect(insertWireGaps([h], h, 'gap').remove).toHaveLength(0);
  });
});

describe('scoot / align', () => {
  const rungDoc = () => {
    const pb = ins('HPB11_NO', 4, 8, { TAG1: 'PB100' });
    const cr = ins('HCR1', 8, 8, { TAG1: 'CR100' });
    const pieces = [...breakWire(wire(1, 8, 10, 8), 3.625, 4.375)];
    const right = pieces[1]!;
    const d = doc([pieces[0]!, ...breakWire(right, 7.625, 8.375), pb, cr, wire(1, 7, 10, 7), ins('HCR1_NO', 6, 7, { TAG1: 'CR100' })]);
    // break the second rung around the contact
    const w7 = d.entities.find((e): e is LineEntity => e.type === 'line' && e.a.y === 7)!;
    d.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => e.id !== w7.id), ...breakWire(w7, 5.625, 6.375)] }));
    return { d, pb, cr };
  };
  it('lifts a component off its wire and breaks it again where it lands', () => {
    const { d, pb } = rungDoc();
    const lifted = liftFromWires(d.entities, pb, d.lookupBlock);
    const merged = lifted.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 8);
    expect(merged).toHaveLength(2); // [1,7.625] and [8.375,10]
    expect(merged.some((w) => Math.min(w.a.x, w.b.x) === 1 && Math.max(w.a.x, w.b.x) === 7.625)).toBe(true);
    expect(connectionLevels(pb, d.lookupBlock)).toEqual([8]);
    const placed = breakForInsert([...lifted.filter((e) => e.id !== pb.id), { ...pb, position: { x: 2, y: 8 } }], { ...pb, position: { x: 2, y: 8 } }, d.lookupBlock);
    const ws = placed.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 8).map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]);
    expect(ws).toContainEqual([1, 1.625]);
    expect(ws).toContainEqual([2.375, 7.625]);
  });
  it('scoots a component along the rung and clamps at the rail', () => {
    const { d, pb } = rungDoc();
    const r = scootComponent(d.entities, pb, d.lookupBlock, 6);
    expect(r.moved.position.x).toBe(6);
    applyWireEdit(d, r, [r.moved]);
    const ws = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 8).map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((a, b) => a[0]! - b[0]!);
    expect(ws).toEqual([[1, 5.625], [6.375, 7.625], [8.375, 10]]);
    // scoot beyond the left rail is clamped so the symbol stays on the wire
    const moved = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.attributes.TAG1 === 'PB100')!;
    const r2 = scootComponent(d.entities, moved, d.lookupBlock, -5);
    expect(r2.moved.position.x).toBeCloseTo(1.375);
  });
  it('relocates a component to another rung', () => {
    const { d, pb } = rungDoc();
    const r = relocateComponent(d.entities, pb, d.lookupBlock, { x: 3, y: 7 });
    applyWireEdit(d, r, [r.moved]);
    const w8 = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 8).map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((a, b) => a[0]! - b[0]!);
    expect(w8).toEqual([[1, 7.625], [8.375, 10]]);
    const w7 = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 7).map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((a, b) => a[0]! - b[0]!);
    expect(w7).toEqual([[1, 2.625], [3.375, 5.625], [6.375, 10]]);
  });
  it('aligns components vertically with a reference', () => {
    const { d, pb } = rungDoc();
    const contact = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1_NO')!;
    const edit = alignComponents(d.entities, [contact], pb, 'vertical', d.lookupBlock);
    applyWireEdit(d, edit);
    const moved = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1_NO')!;
    expect(moved.position.x).toBe(4);
    const w7 = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.a.y === 7).map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((a, b) => a[0]! - b[0]!);
    expect(w7).toEqual([[1, 3.625], [4.375, 10]]);
  });
});

describe('multiple bus and 3-phase insertion', () => {
  it('builds N parallel wires', () => {
    const v = buildBus({ x: 2, y: 9 }, { x: 2, y: 1 }, { ...DEFAULT_BUS, count: 3, spacing: 0.5 });
    expect(v.map((w) => w.a.x)).toEqual([2, 2.5, 3]);
    expect(v.every((w) => w.a.y === 9 && w.b.y === 1)).toBe(true);
    const h = buildBus({ x: 0, y: 9 }, { x: 8, y: 9 }, { ...DEFAULT_BUS, direction: 'horizontal', count: 4, spacing: 0.5, layer: 'WIRES_BLK_12AWG' });
    expect(h.map((w) => w.a.y)).toEqual([9, 8.5, 8, 7.5]);
    expect(h[0]!.layer).toBe('WIRES_BLK_12AWG');
  });
  it('finds the three phase wires around a pick and inserts three poles', () => {
    const bus = buildBus({ x: 0, y: 9 }, { x: 8, y: 9 }, { ...DEFAULT_BUS, direction: 'horizontal', count: 3, spacing: 0.5 });
    const d = doc([...bus, wire(0, 5, 8, 5)]);
    const wires = threePhaseWires(d.entities, { x: 3, y: 9.05 })!;
    expect(wires.map((w) => w.a.y)).toEqual([9, 8.5, 8]);
    expect(threePhaseWires(d.entities, { x: 3, y: 8.5 })!.map((w) => w.a.y)).toEqual([9, 8.5, 8]);
    expect(threePhaseWires(d.entities, { x: 3, y: 5 })).toBeNull();
    const r = insertThreePole(d.entities, 'HDS1', 3, wires, { TAG1: 'DS100', DESC1: 'MAIN' }, d.lookupBlock);
    applyWireEdit(d, r);
    expect(r.inserts.map((i) => i.attributes.POLE)).toEqual(['1', '2', '3']);
    expect(r.inserts.every((i) => i.attributes.TAG1 === 'DS100')).toBe(true);
    for (const y of [9, 8.5, 8]) {
      const ws = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && e.a.y === y);
      expect(ws).toHaveLength(2);
    }
    expect(d.entities.some((e) => e.type === 'line' && e.layer === 'LINK')).toBe(true);
  });
});

describe('wire numbers', () => {
  it('keeps fixed numbers, skips their nets and avoids their labels', () => {
    const d = doc([ref(8, '100'), ref(7, '101'), ref(6, '101'), wire(1, 8, 10, 8), wire(1, 7, 10, 7), wire(1, 6, 10, 6)]);
    d.addEntities([{ id: newId(), type: 'text', layer: 'WIREFIXED', color: 'ByLayer', position: { x: 1.15, y: 7.05 }, text: '101', height: 0.125, rotation: 0, align: 'left' } as TextEntity]);
    const n = assignWireNumbers(d, { start: 100, position: 'below' });
    expect(n).toBe(2);
    const labels = d.entities.filter(isWireNumber).map((t) => `${t.layer}:${t.text}`).sort();
    expect(labels).toEqual(['WIREFIXED:101', 'WIRENO:100', 'WIRENO:101A']);
    const below = d.entities.find((t): t is TextEntity => isWireNumber(t) && t.text === '100')!;
    expect(below.position.y).toBeLessThan(8);
    expect(netOfWireNumber(collectNets(d.entities), below)?.y).toBe(8);
    expect(assignWireNumbers(d, { start: 100, format: 'W%N' })).toBe(2);
    expect(d.entities.some((t) => isWireNumber(t) && t.text === 'W100')).toBe(true);
  });
  it('edits label, fixed flag and position (in-line gaps the wire)', () => {
    const d = doc([ref(8, '100'), wire(1, 8, 10, 8)]);
    assignWireNumbers(d, 100);
    const t = d.entities.find(isWireNumber)!;
    expect(wireNumberState(d.entities, t)).toEqual({ label: '100', fixed: false, position: 'above' });
    applyWireEdit(d, applyWireNumberEdit(d.entities, t, { label: '100X', fixed: true, position: 'inline' }));
    const t2 = d.entities.find(isWireNumber)!;
    expect(t2.text).toBe('100X');
    expect(t2.layer).toBe('WIREFIXED');
    expect(wireNumberState(d.entities, t2).position).toBe('inline');
    expect(d.entities.filter((e) => e.type === 'line' && e.layer === 'WIRES')).toHaveLength(2);
    // back to above closes the gap
    applyWireEdit(d, applyWireNumberEdit(d.entities, t2, { label: '100X', fixed: true, position: 'above' }));
    expect(d.entities.filter((e) => e.type === 'line' && e.layer === 'WIRES')).toHaveLength(1);
    expect(wireNumberState(d.entities, d.entities.find(isWireNumber)!).position).toBe('above');
  });
  it('find / replace, copy and leader', () => {
    const d = doc([ref(8, '100'), ref(7, '101'), wire(1, 8, 10, 8), wire(1, 7, 10, 7)]);
    assignWireNumbers(d, 100);
    const rep = findReplaceWireNumbers(d.entities, '10', 'L');
    expect(rep.map((t) => t.text).sort()).toEqual(['L0', 'L1']);
    const src = d.entities.find((t): t is TextEntity => isWireNumber(t) && t.text === '100')!;
    const target = d.entities.find((e): e is LineEntity => e.type === 'line' && e.a.y === 7)!;
    const copy = copyWireNumber(d.entities, src, target)!;
    expect(copy.text).toBe('100');
    expect(copy.layer).toBe('WIREFIXED');
    expect(copy.position.y).toBeCloseTo(7.05);
    const leader = wireNumberLeader(d.entities, src, { x: 3, y: 9 });
    expect(leader.remove).toEqual([src.id]);
    const line = leader.add.find((e) => e.type === 'line') as LineEntity;
    expect(line.a.y).toBe(8);
    expect(line.b).toEqual({ x: 3, y: 9 });
    expect(scootWireNumber(d.entities, src, 50).position.x).toBeLessThan(10);
  });
});

describe('entity bounds sanity for symbols', () => {
  it('inline symbols span +-0.375', () => {
    const d = doc([]);
    const b = entityBounds(ins('HCR1_NO', 5, 5), d.lookupBlock)!;
    expect(b.min.x).toBeCloseTo(4.625);
    expect(b.max.x).toBeCloseTo(5.375);
  });
});
