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
import { blockTransform, mirrorEntityAcross, rotateEntity, scaleEntityBy, translateEntity } from '../src/core/entities';
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

describe('P17 additions (Codex P1-a/P1-b/P1-c): transforms, multi-batch clones, transact-boundary maintenance', () => {
  it('P1-a: affine transforms carry boundaryRefs and boundaryHandles through the rebuilt loops', () => {
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'], boundaryHandles: ['7E'] }]);
    const moved = translateEntity(hatch, { x: 5, y: 2 }) as HatchEntity;
    expect(moved.loops[0]!.boundaryRefs).toEqual(['b1']);
    expect(moved.loops[0]!.boundaryHandles).toEqual(['7E']);
    expect(moved.loops[0]!.points).toEqual(square(5, 2, 10));
    const rotated = rotateEntity(hatch, { x: 0, y: 0 }, Math.PI / 2) as HatchEntity;
    expect(rotated.loops[0]!.boundaryRefs).toEqual(['b1']);
    expect(rotated.loops[0]!.boundaryHandles).toEqual(['7E']);
    const scaled = scaleEntityBy(hatch, { x: 0, y: 0 }, 2) as HatchEntity;
    expect(scaled.loops[0]!.boundaryRefs).toEqual(['b1']);
    expect(scaled.loops[0]!.boundaryHandles).toEqual(['7E']);
    const mirrored = mirrorEntityAcross(hatch, { x: 0, y: 0 }, { x: 0, y: 1 }) as HatchEntity;
    expect(mirrored.loops[0]!.boundaryRefs).toEqual(['b1']);
    expect(mirrored.loops[0]!.boundaryHandles).toEqual(['7E']);
  });

  it('P1-a: a bulged loop keeps its association through mirror bulge-negation and the non-uniform polygonize branch', () => {
    const arc = assocHatch('h1', [{ points: [{ x: 8, y: 5 }, { x: 2, y: 5 }], bulges: [1, 1], boundaryRefs: ['c1'] }]);
    const mirrored = mirrorEntityAcross(arc, { x: 0, y: 0 }, { x: 1, y: 0 }) as HatchEntity;
    expect(mirrored.loops[0]!.boundaryRefs).toEqual(['c1']);
    expect(mirrored.loops[0]!.bulges).toEqual([-1, -1]);
    const stretched = blockTransform(arc, (p) => ({ x: p.x * 2, y: p.y }), 0, 2, 1, false) as HatchEntity;
    expect(stretched.loops[0]!.boundaryRefs).toEqual(['c1']);
    expect(stretched.loops[0]!.points.length).toBeGreaterThan(2);
  });

  it('P1-a: MOVE of boundary + hatch together (replaceEntities with transformed copies) keeps the association live', () => {
    const b = boundary('b1');
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const doc = new Drawing({ entities: [b, hatch] });
    doc.replaceEntities([translateEntity(b, { x: 20, y: 0 }), translateEntity(hatch, { x: 20, y: 0 })]);
    const after = hatchOf(doc, 'h1');
    expect(after.loops[0]!.boundaryRefs).toEqual(['b1']);
    expect(after.loops[0]!.points).toEqual(square(20, 0, 10));
    // Still live: the next boundary edit refreshes the fill.
    doc.replaceEntities([{ ...(entityOf(doc, 'b1') as PolylineEntity), points: square(50, 0, 10) }]);
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(50, 0, 10));
  });

  it('P1-b: one addEntities call with several clone batches remaps each copied hatch with its OWN batch map', () => {
    const source = boundary('b1');
    const hatch = assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }]);
    const doc = new Drawing({ entities: [source, hatch] });
    // The copies an ARRAYRECT/ARRAYPOLAR cell produces: geometry moved, fresh
    // ids, loop refs still naming the SOURCE boundary until the batch remap.
    const cell = (dx: number, bId: string, hId: string): Entity[] => [
      { ...boundary(bId), points: square(dx, 0, 10) },
      assocHatch(hId, [{ points: square(dx, 0, 10), boundaryRefs: ['b1'] }]),
    ];
    doc.addEntities([...cell(20, 'b2', 'h2'), ...cell(40, 'b3', 'h3')], false, {
      cloneBatches: [
        { entityIds: { b1: 'b2', h1: 'h2' } },
        { entityIds: { b1: 'b3', h1: 'h3' } },
      ],
    });
    expect(hatchOf(doc, 'h2').loops[0]!.boundaryRefs).toEqual(['b2']);
    expect(hatchOf(doc, 'h3').loops[0]!.boundaryRefs).toEqual(['b3']);
    // Each copy follows its own cell's boundary afterwards, not the last cell's.
    doc.replaceEntities([{ ...(entityOf(doc, 'b3') as PolylineEntity), points: square(90, 90, 10) }]);
    expect(hatchOf(doc, 'h3').loops[0]!.points).toEqual(square(90, 90, 10));
    expect(hatchOf(doc, 'h2').loops[0]!.points).toEqual(square(20, 0, 10));
  });

  it('P1-c: a raw transact replacing a boundary refreshes its hatch (the API replace path)', () => {
    const doc = new Drawing({ entities: [boundary('b1'), assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }])] });
    doc.transact((s) => ({ ...s, entities: s.entities.map((e) => (e.id === 'b1' ? { ...e, points: square(30, 0, 10) } : e)) }));
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(30, 0, 10));
    expect(hatchOf(doc, 'h1').loops[0]!.boundaryRefs).toEqual(['b1']);
  });

  it('P1-c: a raw transact erasing a boundary detaches its hatch (the API remove path)', () => {
    const doc = new Drawing({ entities: [boundary('b1'), assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }])] });
    doc.transact((s) => ({ ...s, entities: s.entities.filter((e) => e.id !== 'b1') }));
    const after = hatchOf(doc, 'h1');
    expect(after.loops[0]!.points).toEqual(square(0, 0, 10));
    expect(after.loops[0]!.boundaryRefs).toBeUndefined();
    expect(after.associative).toBeUndefined();
  });

  it('P1-c: a clipboard-style paste transact remaps the pasted hatch to the pasted boundary', () => {
    const doc = new Drawing({ entities: [boundary('b1'), assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }])] });
    const pastedBoundary = { ...boundary('b7'), points: square(100, 100, 10) };
    const pastedHatch = assocHatch('h7', [{ points: square(100, 100, 10), boundaryRefs: ['b1'] }]);
    doc.transact((s) => ({ ...s, entities: [...s.entities, pastedBoundary, pastedHatch] }), {
      cloneBatches: [{ entityIds: { b1: 'b7', h1: 'h7' } }],
    });
    expect(hatchOf(doc, 'h7').loops[0]!.boundaryRefs).toEqual(['b7']);
    expect(hatchOf(doc, 'h1').loops[0]!.boundaryRefs).toEqual(['b1']);
    // The pasted hatch follows the pasted boundary, not the source's.
    doc.replaceEntities([{ ...pastedBoundary, points: square(200, 200, 10) }]);
    expect(hatchOf(doc, 'h7').loops[0]!.points).toEqual(square(200, 200, 10));
    expect(hatchOf(doc, 'h1').loops[0]!.points).toEqual(square(0, 0, 10));
  });

  it('P1-c guard: a transaction that does not change the entity list leaves hatch state untouched', () => {
    const doc = new Drawing({ entities: [boundary('b1'), assocHatch('h1', [{ points: square(0, 0, 10), boundaryRefs: ['b1'] }])] });
    const before = doc.snapshot.entities;
    doc.addLayer({ name: 'NEWLAYER', color: 7, visible: true, locked: false, lineWeight: 0.25 });
    expect(doc.snapshot.entities).toBe(before);
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
