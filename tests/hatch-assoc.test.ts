/**
 * P17 slice 1 acceptance: associative hatch boundary-edit behaviour.
 *
 * Written BEFORE the implementation (PROPOSAL-P17, LEDGER): at base
 * 038cb7b4 the document keeps no boundary association, so editing a
 * boundary polyline leaves the hatch fill behind and these cases fail.
 * The update must ride the SAME Drawing transaction as the boundary
 * edit: one undo step restores boundary and fill together.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, HatchEntity, PolylineEntity, CircleEntity } from '../src/core/entities';
import {
  MAX_HATCH_ASSOC_REFS_PER_LOOP,
  detachErasedBoundaries,
  hatchAssocProblem,
  refreshAssociativeHatch,
  remapHatchBoundaryRefs,
} from '../src/core/hatch-assoc';

const props = { layer: '0', color: 'ByLayer' as const };
const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];
const boundary = (id: string, x = 0, y = 0, s = 10): PolylineEntity => ({
  id, ...props, type: 'polyline', points: square(x, y, s), closed: true,
});
const assocHatch = (id: string, loops: HatchEntity['loops']): HatchEntity => ({
  id, ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
  loops, associative: true,
});
const hatchOf = (doc: Drawing, id: string): HatchEntity =>
  doc.snapshot.entities.find((e): e is HatchEntity => e.type === 'hatch' && e.id === id)!;
const entityOf = (doc: Drawing, id: string): Entity => doc.snapshot.entities.find((e) => e.id === id)!;

describe('associative hatch: boundary edits update the fill in one undo step', () => {
  it('moving the boundary polyline refreshes the outer loop and a hole loop independently', () => {
    const outer = boundary('b1');
    const hole = boundary('b2', 3, 3, 3);
    const hatch = assocHatch('h1', [
      { points: square(0, 0, 10), boundaryRefs: ['b1'] },
      { points: square(3, 3, 3), boundaryRefs: ['b2'] },
    ]);
    const doc = new Drawing({ entities: [outer, hole, hatch] });
    doc.replaceEntities([{ ...outer, points: square(20, 0, 10) }]);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(20, 0, 10));
    expect(hatchOf(doc, 'h1').loops[1]!.points).toEqual(square(3, 3, 3));
    // One undo restores boundary AND hatch together.
    expect(doc.undo()).toBe(true);
    expect(entityOf(doc, 'b1')).toEqual(outer);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(0, 0, 10));
    expect(doc.redo()).toBe(true);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(20, 0, 10));
  });

  it('a boundary shared by two hatches updates both hatches in the same step', () => {
    const shared = boundary('b1');
    const h1 = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const h2 = assocHatch('h2', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const doc = new Drawing({ entities: [shared, h1, h2] });
    doc.replaceEntities([{ ...shared, points: square(-5, -5, 10) }]);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(-5, -5, 10));
    expect(hatchOf(doc, 'h2').loops[0]!.points).toEqual(square(-5, -5, 10));
    expect(doc.undo()).toBe(true);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(0, 0, 10));
    expect(hatchOf(doc, 'h2').loops[0]!.points).toEqual(square(0, 0, 10));
  });

  it('erasing the boundary detaches the loop: geometry frozen, refs gone, other loops stay live', () => {
    const outer = boundary('b1');
    const hole = boundary('b2', 3, 3, 3);
    const hatch = assocHatch('h1', [
      { points: square(0, 0, 10), boundaryRefs: ['b1'] },
      { points: square(3, 3, 3), boundaryRefs: ['b2'] },
    ]);
    const lone = assocHatch('h2', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const doc = new Drawing({ entities: [outer, hole, hatch, lone] });
    doc.removeEntities(['b1']);
    const after = hatchOf(doc, 'h1');
    expect(after.loops[0]!.points).toEqual(square(0, 0, 10));
    expect(after.loops[0]!.boundaryRefs).toBeUndefined();
    expect(after.loops[1]!.boundaryRefs).toEqual(['b2']);
    expect(after.associative).toBe(true);
    const loneAfter = hatchOf(doc, 'h2');
    expect(loneAfter.loops[0]!.boundaryRefs).toBeUndefined();
    expect(loneAfter.associative).toBeUndefined();
    // The detach is part of the erase step: one undo restores the link.
    expect(doc.undo()).toBe(true);
    expect(hatchOf(doc, 'h2').loops[0]!.boundaryRefs).toEqual(['b1']);
  });

  it('a copied hatch + boundary pair (clone-batch intent) remaps its refs to the copies', () => {
    const source = boundary('b1');
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const doc = new Drawing({ entities: [source, hatch] });
    const copiedBoundary = boundary('b9');
    const copiedHatch = assocHatch('h9', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    doc.addEntities([copiedBoundary, copiedHatch], false, {
      cloneBatches: [{ entityIds: { b1: 'b9', h1: 'h9' } }],
    });
    expect(hatchOf(doc, 'h9').loops[0]!.boundaryRefs).toEqual(['b9']);
    // And the copy now follows its own boundary, not the original.
    doc.replaceEntities([{ ...copiedBoundary, points: square(40, 40, 10) }]);
    expect(hatchOf(doc, 'h9').loops[0]!.points).toEqual(square(40, 40, 10));
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(0, 0, 10));
  });
});

describe('hatch-assoc adapter: derivation, validation, bounded work', () => {
  it('derives a two-arc loop from a circle boundary', () => {
    const circle: CircleEntity = { id: 'c1', ...props, type: 'circle', center: { x: 5, y: 5 }, radius: 3 };
    const hatch = assocHatch('h1', [{ points: square(0, 0, 1), boundaryRefs: ['c1'] }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map([[circle.id, circle]]));
    expect(problems).toEqual([]);
    expect(out.loops[0]!.points).toEqual([{ x: 8, y: 5 }, { x: 2, y: 5 }]);
    expect(out.loops[0]!.bulges).toEqual([1, 1]);
  });

  it('refuses a self-referencing hatch (cycle) and leaves it unchanged', () => {
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['h1'] }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map([[hatch.id, hatch]]));
    expect(problems.map((p) => p.kind)).toEqual(['cycle']);
    expect(out).toBe(hatch);
  });

  it('reports an unsupported boundary type and keeps the association and geometry', () => {
    const line: Entity = { id: 'l1', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['l1'] }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map([[line.id, line]]));
    expect(problems.map((p) => p.kind)).toEqual(['unsupported-boundary']);
    expect(out).toBe(hatch);
    expect(hatchAssocProblem(hatch, new Map([[line.id, line]]))).toContain('unsupported');
  });

  it('reports a missing boundary without detaching inside refresh (detach is the erase path)', () => {
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['gone'] }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map());
    expect(problems.map((p) => p.kind)).toEqual(['missing-boundary']);
    expect(out).toBe(hatch);
  });

  it('refuses unbounded association work: too many refs on one loop', () => {
    const refs = Array.from({ length: MAX_HATCH_ASSOC_REFS_PER_LOOP + 1 }, (_, i) => `b${i}`);
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: refs }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map());
    expect(problems.map((p) => p.kind)).toEqual(['work-limit']);
    expect(out).toBe(hatch);
  });

  it('a loop with several boundary objects is retained but not refreshed in this slice', () => {
    const a = boundary('b1');
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1', 'b2'] }]);
    const { hatch: out, problems } = refreshAssociativeHatch(hatch, new Map([[a.id, a]]));
    expect(problems.map((p) => p.kind)).toEqual(['unsupported-boundary']);
    expect(out.loops[0]!.boundaryRefs).toEqual(['b1', 'b2']);
  });

  it('detachErasedBoundaries only touches loops that referenced an erased id', () => {
    const entities: Entity[] = [
      assocHatch('h1', [
        { points: square(0, 0, 10), boundaryRefs: ['b1'] },
        { points: square(3, 3, 3), boundaryRefs: ['b2'] },
      ]),
      assocHatch('h2', [{ points: square(0, 0, 4), boundaryRefs: ['b3'] }]),
    ];
    const out = detachErasedBoundaries(entities, new Set(['b1']));
    const h1 = out.find((e): e is HatchEntity => e.id === 'h1')!;
    expect(h1.loops[0]!.boundaryRefs).toBeUndefined();
    expect(h1.loops[1]!.boundaryRefs).toEqual(['b2']);
    expect(out.find((e) => e.id === 'h2')).toBe(entities[1]);
  });

  it('remapHatchBoundaryRefs rewrites mapped ids and keeps unmapped ones', () => {
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1', 'bx'] }]);
    const out = remapHatchBoundaryRefs([hatch], new Map([['b1', 'b9']]))[0] as HatchEntity;
    expect(out.loops[0]!.boundaryRefs).toEqual(['b9', 'bx']);
  });
});
