/**
 * Priority 30 review §3 — the geometry-edit constraint policy, enforced
 * at the Drawing commit choke point (src/core/constraints/policy.ts):
 *
 *  (a) deleting an entity referenced by an ACTIVE constraint refuses
 *      atomically — through the actual ERASE tool and through the
 *      document API — naming the constraint;
 *  (b) a geometry edit on a constrained entity re-solves inside the
 *      SAME transact: a feasible MOVE commits move + solve as ONE undo
 *      step; an infeasible MOVE refuses the whole edit and the document
 *      is bit-unchanged.
 *
 * Plus the stated boundary: suppressed-only references do not guard,
 * dropping the set and the entity in one transition is allowed, and a
 * reference (non-driving) constraint never blocks an edit.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { CircleEntity, LineEntity, PointEntity } from '../src/core/entities';
import type { ConstraintSet } from '../src/core/constraints/model';
import { ConstraintPolicyError } from '../src/core/constraints/policy';
import { EraseTool, MoveTool } from '../src/tools/modify';
import { fakeContext, drive } from './fake-context';

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const point = (id: string, x: number, y: number): PointEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'point', position: { x, y },
});
const circle = (id: string, x: number, y: number, r: number): CircleEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'circle', center: { x, y }, radius: r,
});
const byId = <T extends { id: string }>(entities: readonly T[], id: string): T => entities.find((e) => e.id === id)!;

/** L1 (0,0)-(10,0) and L2 (10,0)-(20,0) joined by a coincident at the shared endpoint. */
const coincidentSet = (): ConstraintSet => ({
  constraints: [
    { id: 'c-co', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'L2', anchor: 'start' }] },
  ],
});
const joinedDoc = (): Drawing =>
  new Drawing({ entities: [line('L1', 0, 0, 10, 0), line('L2', 10, 0, 20, 0), circle('C1', -5, -5, 2)], constraints: coincidentSet(), currentLayer: '0' });

describe('policy (a): deleting a referenced entity refuses atomically', () => {
  it('ERASE tool on a constrained entity: throws ConstraintPolicyError naming the constraint, document untouched', () => {
    const doc = joinedDoc();
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1']);
    let thrown: unknown;
    try {
      drive(new EraseTool(), ctx, []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConstraintPolicyError);
    const err = thrown as ConstraintPolicyError;
    expect(err.code).toBe('referenced-entity-missing');
    expect(err.constraintIds).toEqual(['c-co']);
    expect(err.message).toContain("'c-co'");
    expect(doc.snapshot).toBe(before);
    expect(doc.snapshot.entities.some((e) => e.id === 'L1')).toBe(true);
    expect(doc.canUndo()).toBe(false);
    expect(doc.dirty).toBe(false);
    expect(doc.revision).toBe(0);
  });

  it('document API removeEntities refuses the same way', () => {
    const doc = joinedDoc();
    expect(() => doc.removeEntities(['L2'])).toThrow(ConstraintPolicyError);
    expect(doc.snapshot.entities).toHaveLength(3);
    expect(doc.canUndo()).toBe(false);
  });

  it('ERASE of an UNreferenced entity in a constrained drawing still works', () => {
    const doc = joinedDoc();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['C1']);
    drive(new EraseTool(), ctx, []);
    expect(doc.snapshot.entities.some((e) => e.id === 'C1')).toBe(false);
    expect(doc.canUndo()).toBe(true);
  });

  it('dropping the constraint set and the entity in ONE transition is allowed', () => {
    const doc = joinedDoc();
    doc.transact((s) => ({ ...s, constraints: { constraints: [] }, entities: s.entities.filter((e) => e.id !== 'L1') }));
    expect(doc.snapshot.entities.some((e) => e.id === 'L1')).toBe(false);
  });

  it('an entity referenced only by a SUPPRESSED constraint is not guarded', () => {
    const set: ConstraintSet = {
      constraints: [{ id: 'c-sup', kind: 'coincident', role: 'driving', suppressed: true, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'L2', anchor: 'start' }] }],
    };
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0), line('L2', 10, 0, 20, 0)], constraints: set, currentLayer: '0' });
    doc.removeEntities(['L1']);
    expect(doc.snapshot.entities.some((e) => e.id === 'L1')).toBe(false);
  });
});

describe('policy (b): geometry edits re-solve inside the same transact', () => {
  it('MOVE a joined line: the coincident partner follows in the SAME undo step', () => {
    const doc = joinedDoc();
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1']);
    drive(new MoveTool(), ctx, [{ x: 0, y: 0 }, { x: 0, y: 3 }]);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    const l2 = byId(doc.snapshot.entities, 'L2') as LineEntity;
    expect(l1.a).toEqual({ x: 0, y: 3 });
    expect(l1.b).toEqual({ x: 10, y: 3 });
    expect(l2.a).toEqual({ x: 10, y: 3 }); // re-solved, not left behind
    expect(l2.b).toEqual({ x: 20, y: 0 });
    expect(doc.dirty).toBe(true);
    // Exactly one undo step restores the pre-move state object.
    expect(doc.canUndo()).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('MOVE a fully fixed line: the whole edit refuses, document bit-unchanged', () => {
    const set: ConstraintSet = {
      constraints: [
        { id: 'c-f1', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L1', anchor: 'start' }] },
        { id: 'c-f2', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L1', anchor: 'end' }] },
      ],
    };
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0)], constraints: set, currentLayer: '0' });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1']);
    let thrown: unknown;
    try {
      drive(new MoveTool(), ctx, [{ x: 0, y: 0 }, { x: 0, y: 3 }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConstraintPolicyError);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.dirty).toBe(false);
  });

  it('a raw transact replacing a referenced entity is re-solved before commit', () => {
    const doc = joinedDoc();
    doc.transact((s) => ({ ...s, entities: s.entities.map((e) => (e.id === 'L1' ? line('L1', 0, 7, 10, 7) : e)) }));
    const l2 = byId(doc.snapshot.entities, 'L2') as LineEntity;
    expect(l2.a).toEqual({ x: 10, y: 7 });
  });

  it('an edit under a REFERENCE constraint succeeds and is not driven by it', () => {
    const set: ConstraintSet = {
      constraints: [
        { id: 'c-ref', kind: 'distance', role: 'reference', refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0), point('P1', 10, 9)], constraints: set, currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['P1']);
    drive(new MoveTool(), ctx, [{ x: 10, y: 9 }, { x: 30, y: 30 }]);
    const p1 = byId(doc.snapshot.entities, 'P1') as PointEntity;
    expect(p1.position).toEqual({ x: 30, y: 30 }); // moved freely; reference measures, never drives
  });

  it('an unconstrained drawing is untouched by the policy', () => {
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0)], currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1']);
    drive(new EraseTool(), ctx, []);
    expect(doc.snapshot.entities).toHaveLength(0);
  });
});
