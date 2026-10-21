/**
 * Priority 30.4 slice A — constraints at the document level:
 *  - DrawingState.constraints storage: preserved across construction,
 *    unrelated edits, undo/redo and history parking (field plumbing).
 *  - The pure adapter (src/core/constraints/apply.ts) under the design §6
 *    contract: solve OUTSIDE any transaction; failure = the SAME state
 *    object with the solver's status/code; success installs through
 *    exactly ONE transact = ONE undo step.
 *  - Design case 15: solver success + a downstream (prepare-stage)
 *    transaction refusal leaves the document bit-unchanged, and the
 *    surfaced error is the transaction refusal, not a solver code.
 *  - JCAD_CONSTRAINTS persistence: versioned JSON XDATA on the
 *    *Model_Space BLOCK record, labeled JCad-specific (NOT native);
 *    round-trip exact modulo reader-assigned entity ids; malformed /
 *    newer payloads retained raw; a constraints-free drawing emits
 *    nothing (fixed point).
 *
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import {
  addConstraint,
  removeConstraint,
  solveAndApply,
  withConstraintSet,
  withConstraintValue,
} from '../src/core/constraints/apply';
import { writeDxf } from '../src/io/dxf/writer';
import { readDxf } from '../src/io/dxf/reader';
import { decodeConstraints, encodeConstraints } from '../src/io/dxf/constraints-data';
import { importReportOf } from '../src/io/import-report';

// --- Fixtures -----------------------------------------------------------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const point = (id: string, x: number, y: number): PointEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'point', position: { x, y },
});
const circle = (id: string, x: number, y: number, r: number): CircleEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'circle', center: { x, y }, radius: r,
});

const LAYERS = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }];
const baseState = (entities: Entity[], over: Partial<DrawingState> = {}): DrawingState => ({
  entities, layers: LAYERS, blocks: {}, currentLayer: '0', ...over,
});

/** Horizontal L1 + distance(L1.end, P1) = 5. Satisfiable from the fixture
 *  geometry (L1 runs (0,0)-(10,3), P1 at (10,9)). */
const solvableSet = (): ConstraintSet => ({
  constraints: [
    { id: 'c-h', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L1', anchor: 'whole' }] },
    { id: 'c-d', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
  ],
});
const solvableState = (): DrawingState => baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9), circle('C1', -5, -5, 2)], { constraints: solvableSet() });

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const byId = (entities: readonly Entity[], id: string): Entity => entities.find((e) => e.id === id)!;

// --- Adapter: solveAndApply ----------------------------------------------------
describe('solveAndApply (design §6)', () => {
  it('success: solved entities installed, set object unchanged, untouched entities shared', () => {
    const state = solvableState();
    const r = solveAndApply(state);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('underconstrained');
    expect(r.state).not.toBe(state);
    expect(r.state.constraints).toBe(state.constraints);
    const l1 = byId(r.state.entities, 'L1') as LineEntity;
    const p1 = byId(r.state.entities, 'P1') as PointEntity;
    expect(l1.b.y).toBe(l1.a.y); // horizontal satisfied
    expect(dist(l1.b, p1.position)).toBeCloseTo(5, 9); // distance satisfied
    expect(byId(r.state.entities, 'C1')).toBe(byId(state.entities, 'C1')); // uninvolved: identity
    expect(r.state.layers).toBe(state.layers);
    expect(r.state.blocks).toBe(state.blocks);
  });

  it('conflict: SAME state object, solver status/code surfaced', () => {
    const conflicting: ConstraintSet = {
      constraints: [
        { id: 'd5', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'd7', kind: 'distance', role: 'driving', value: 7, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const state = baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9)], { constraints: conflicting });
    const r = solveAndApply(state);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.status).toBe('conflicting');
    expect(r.code).toBe('conflicting-constraints');
  });

  it('no set: adapter-level refusal, solver never invoked', () => {
    const state = baseState([line('L1', 0, 0, 1, 1)]);
    const r = solveAndApply(state);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.code).toBe('no-constraints');
    expect(r.solve).toBeUndefined();
  });

  it('cancelled token: solver code passes through, state identical', () => {
    const state = solvableState();
    const r = solveAndApply(state, { token: { cancelled: true } });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.code).toBe('cancelled');
  });
});

// --- Adapter: constraint edits --------------------------------------------------
describe('constraint edits solve first and install together (§6)', () => {
  it('withConstraintSet installs the new set AND the solved geometry in one result', () => {
    const state = baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9)]);
    const set = solvableSet();
    const r = withConstraintSet(state, set);
    expect(r.ok).toBe(true);
    expect(r.state.constraints).toBe(set);
    const l1 = byId(r.state.entities, 'L1') as LineEntity;
    expect(l1.b.y).toBe(l1.a.y);
  });

  it('withConstraintSet with an invalid set refuses with §4 problems and the same state', () => {
    const state = baseState([line('L1', 0, 0, 10, 3)]);
    const bad: ConstraintSet = {
      constraints: [{ id: 'x', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'GONE', anchor: 'whole' }] }],
    };
    const r = withConstraintSet(state, bad);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.code).toBe('validation-failed');
    expect(r.problems?.map((p) => p.code)).toContain('missing-reference');
    expect(state.constraints).toBeUndefined();
  });

  it('withConstraintSet that would conflict refuses whole: old set and geometry stay', () => {
    const state = solvableState();
    const conflicting: ConstraintSet = {
      constraints: [
        ...solvableSet().constraints,
        { id: 'd7', kind: 'distance', role: 'driving', value: 7, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const r = withConstraintSet(state, conflicting);
    expect(r.ok).toBe(false);
    expect(r.state).toBe(state);
    expect(r.code).toBe('conflicting-constraints');
  });

  it('addConstraint / removeConstraint / withConstraintValue', () => {
    const empty = baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9)]);
    const h: Constraint = { id: 'c-h', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L1', anchor: 'whole' }] };
    const added = addConstraint(empty, h);
    expect(added.ok).toBe(true);
    expect(added.state.constraints?.constraints.map((c) => c.id)).toEqual(['c-h']);

    // Duplicate id is a validation refusal, not a silent overwrite.
    const dup = addConstraint(added.state, h);
    expect(dup.ok).toBe(false);
    expect(dup.state).toBe(added.state);
    expect(dup.problems?.map((p) => p.code)).toContain('duplicate-constraint');

    const d: Constraint = { id: 'c-d', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] };
    const two = addConstraint(added.state, d);
    expect(two.ok).toBe(true);
    const changed = withConstraintValue(two.state, 'c-d', 6);
    expect(changed.ok).toBe(true);
    expect(changed.state.constraints?.constraints.find((c) => c.id === 'c-d')?.value).toBe(6);
    const cl1 = byId(changed.state.entities, 'L1') as LineEntity;
    const cp1 = byId(changed.state.entities, 'P1') as PointEntity;
    expect(dist(cl1.b, cp1.position)).toBeCloseTo(6, 9);

    const noChange = withConstraintValue(two.state, 'c-d', 5);
    expect(noChange.ok).toBe(false);
    expect(noChange.state).toBe(two.state);
    expect(noChange.code).toBe('no-change');
    expect(withConstraintValue(two.state, 'nope', 1).code).toBe('constraint-not-found');
    expect(removeConstraint(two.state, 'nope').code).toBe('constraint-not-found');

    // Removing the last constraint drops the field entirely.
    const one = removeConstraint(two.state, 'c-d');
    expect(one.ok).toBe(true);
    expect(one.state.constraints?.constraints.map((c) => c.id)).toEqual(['c-h']);
    const none = removeConstraint(one.state, 'c-h');
    expect(none.ok).toBe(true);
    expect(none.state.constraints).toBeUndefined();
    expect('constraints' in none.state).toBe(false);
  });

  it('a retained payload refuses every adapter operation', () => {
    const state = baseState([line('L1', 0, 0, 1, 1)], { constraintsRetained: '{"v":99,"kind":"constraints","constraints":[]}' });
    for (const r of [
      solveAndApply(state),
      withConstraintSet(state, { constraints: [] }),
      addConstraint(state, { id: 'x', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L1', anchor: 'start' }] }),
      removeConstraint(state, 'x'),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.state).toBe(state);
      expect(r.code).toBe('constraints-retained');
    }
  });
});

// --- Document integration -------------------------------------------------------
describe('Drawing integration: one transact, one undo (§6)', () => {
  it('solve success installs via exactly one transact; one undo restores the prior snapshot object', () => {
    const doc = new Drawing(solvableState());
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    const r = solveAndApply(doc.snapshot); // outside any transaction
    expect(r.ok).toBe(true);
    doc.transact(() => r.state);
    expect(doc.snapshot).not.toBe(before);
    expect(doc.revision).toBe(revisionBefore + 1);
    expect(doc.dirty).toBe(true);
    expect(doc.snapshot.constraints).toBe(before.constraints);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    expect(l1.b.y).toBe(l1.a.y);
    expect(doc.canUndo()).toBe(true);
    const solvedL1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    doc.undo();
    expect(doc.snapshot).toBe(before);
    doc.redo();
    expect(doc.snapshot.constraints).toBe(before.constraints);
    const redoneL1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    expect(redoneL1.b.y).toBe(redoneL1.a.y); // horizontal again
    expect(redoneL1.b.y).toBe(solvedL1.b.y); // and exactly the solved geometry
  });

  it('solver failure leaves the document bit-unchanged (no transact, no undo entry, no revision/dirty change)', () => {
    const conflicting: ConstraintSet = {
      constraints: [
        { id: 'd5', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'd7', kind: 'distance', role: 'driving', value: 7, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = new Drawing(baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9)], { constraints: conflicting }));
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    const r = solveAndApply(doc.snapshot);
    expect(r.ok).toBe(false);
    // Per the §6 contract the caller does not transact a refusal...
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    // ...and even a mistaken transact of the refused (identical) state is a no-op.
    doc.transact(() => r.state);
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.canUndo()).toBe(false);
  });

  it('case 15: solver succeeds, the installing transact is refused downstream, document unchanged, error is not a solver code', () => {
    // Staging note: the design's literal case 15 (a move rejected because
    // of retained native data on the moved entity) needs a native
    // dynamic/retained fixture to stage exactly. What is pinned here is
    // the case-15 CONTRACT at the only prepare-stage refusal reachable
    // without one: the solved state is installed through a transact whose
    // prepared state validateCadState refuses (an entity carrying a
    // retained cadIdentity with no retained object graph — the same
    // refusal tests/session-cad-state-validation.test.ts pins). The throw
    // must be the transaction refusal — distinguishable from every §5.7
    // solver code — and the document must stay bit-unchanged.
    const doc = new Drawing(solvableState());
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    const r = solveAndApply(doc.snapshot);
    expect(r.ok).toBe(true); // solver success established first
    const orphan: PointEntity = {
      id: 'orphan', cadIdentity: 'retained:orphan', type: 'point', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 },
    } as PointEntity;
    let thrown: unknown;
    try {
      doc.transact(() => ({ ...r.state, entities: [...r.state.entities, orphan] }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/retained object graph/);
    expect((thrown as Error).message).not.toMatch(/conflicting-constraints|iteration-limit|work-limit/);
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });

  it('the constraints field survives unrelated edits, undo/redo and history parking', () => {
    const set = solvableSet();
    const doc = new Drawing(solvableState());
    // The constructor seals the supplied state, so identity is pinned
    // against the snapshot's own (sealed) set object from here on.
    const kept = doc.snapshot.constraints;
    expect(kept).toEqual(set);
    doc.addEntities([circle('C9', 3, 3, 1)]);
    expect(doc.snapshot.constraints).toBe(kept);
    doc.transact((s) => ({ ...s, currentLayer: '0' }));
    expect(doc.snapshot.constraints).toBe(kept);
    const parked = doc.history();
    doc.undo();
    expect(doc.snapshot.constraints).toBe(kept);
    doc.redo();
    expect(doc.snapshot.constraints).toBe(kept);
    const doc2 = new Drawing();
    doc2.restoreHistory(parked);
    expect(doc2.history().undo.every((s) => s.constraints === kept || s.constraints === undefined)).toBe(true);
    expect(parked.undo[parked.undo.length - 1]?.constraints).toBe(kept);
  });
});

// --- Persistence ------------------------------------------------------------------
describe('JCAD_CONSTRAINTS persistence', () => {
  const richSet = (): ConstraintSet => ({
    constraints: [
      { id: 'c-h', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L1', anchor: 'whole' }] },
      { id: 'c-d', kind: 'distance', role: 'driving', value: 5, distanceMode: 'horizontal', refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      { id: 'c-r', kind: 'radius', role: 'driving', value: 2, refs: [{ entityId: 'C1', anchor: 'whole' }] },
      { id: 'c-ref', kind: 'distance', role: 'reference', refs: [{ entityId: 'L1', anchor: 'start' }, { entityId: 'P1', anchor: 'position' }] },
      { id: 'c-sup', kind: 'vertical', role: 'driving', suppressed: true, refs: [{ entityId: 'PL', anchor: 'segment', index: 1 }] },
      { id: 'c-v', kind: 'coincident', role: 'driving', refs: [{ entityId: 'PL', anchor: 'vertex', index: 2 }, { entityId: 'P1', anchor: 'position' }] },
    ],
  });
  const richState = (): DrawingState => baseState(
    [
      line('L1', 0, 0, 10, 3),
      point('P1', 10, 9),
      circle('C1', -5, -5, 2),
      { id: 'PL', layer: '0', color: 'ByLayer', type: 'polyline', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], closed: false } as PolylineEntity,
    ],
    { constraints: richSet() },
  );

  it('encode/decode are exact inverses against the same entities', () => {
    const state = richState();
    const text = encodeConstraints(state.constraints!, state.entities.map((e) => e.id));
    const decoded = decodeConstraints(text, state.entities);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.set).toEqual(state.constraints);
  });

  it('round-trips through writeDxf/readDxf exactly (modulo reader-assigned entity ids)', () => {
    const state = richState();
    const dxf = writeDxf(state);
    expect(dxf).toContain('JCAD_CONSTRAINTS');
    const back = readDxf(dxf);
    expect(back.constraintsRetained).toBeUndefined();
    expect(back.constraints?.constraints).toHaveLength(6);
    // Refs point at the READ entities (fresh ids), in the authored positions.
    const order = back.entities.map((e) => e.id);
    const byKind = new Map(back.entities.map((e) => [e.id, e.type]));
    for (const c of back.constraints!.constraints) {
      for (const ref of c.refs) expect(order).toContain(ref.entityId);
    }
    expect(byKind.get(back.constraints!.constraints[0]!.refs[0]!.entityId)).toBe('line');
    expect(back.constraints!.constraints[1]).toMatchObject({ value: 5, distanceMode: 'horizontal' });
    expect(back.constraints!.constraints[3]).toMatchObject({ role: 'reference' });
    expect(back.constraints!.constraints[3]!.value).toBeUndefined();
    expect(back.constraints!.constraints[4]).toMatchObject({ suppressed: true, refs: [{ anchor: 'segment', index: 1 }] });
    expect(back.constraints!.constraints[5]!.refs[0]).toMatchObject({ anchor: 'vertex', index: 2 });
    // The import report carries the labeled JCAD_CONSTRAINTS entry.
    const items = importReportOf(back)?.items ?? [];
    expect(items.some((i) => i.action === 'simplified' && i.reason.includes('kept in JCAD_CONSTRAINTS'))).toBe(true);
    // And a re-save of the read drawing decodes to the same set (fixed
    // point). Each read mints fresh entity ids, so the comparison is in
    // ordinal space: refs rewritten to the index of the entity they name.
    const back2 = readDxf(writeDxf(back));
    const inOrdinalSpace = (s: DrawingState): unknown => {
      const index = new Map(s.entities.map((e, i) => [e.id, i]));
      return s.constraints?.constraints.map((c) => ({
        ...c,
        refs: c.refs.map((r) => ({ ...r, entityId: index.get(r.entityId) })),
      }));
    };
    expect(inOrdinalSpace(back2)).toEqual(inOrdinalSpace(back));
    expect(inOrdinalSpace(back)).toEqual(inOrdinalSpace(state));
  });

  it('a constraints-free drawing emits nothing new (fixed point)', () => {
    const plain = baseState([line('L1', 0, 0, 10, 3), point('P1', 10, 9)]);
    const dxf = writeDxf(plain);
    expect(dxf).not.toContain('JCAD_CONSTRAINTS');
    const back = readDxf(dxf);
    expect(back.constraints).toBeUndefined();
    expect(back.constraintsRetained).toBeUndefined();
  });

  it('malformed / newer / invalid payloads are retained raw, never modeled', () => {
    const entities = richState().entities;
    for (const raw of [
      'not json at all',
      '{"v":2,"kind":"constraints","constraints":[]}',
      '{"v":1,"kind":"constraints","constraints":[{"id":"x","kind":"horizontal","role":"driving","refs":[{"entityId":"#99","anchor":"whole"}]}]}',
      '{"v":1,"kind":"constraints","constraints":[{"id":"x","kind":"horizontal","role":"driving","refs":[{"entityId":"MISSING","anchor":"whole"}]}]}',
      '{"v":1,"kind":"constraints","constraints":[{"id":"x","kind":"nonsense","role":"driving","refs":[]}]}',
    ]) {
      const decoded = decodeConstraints(raw, entities);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.retained).toBe(raw);
    }
  });

  it('a retained payload round-trips verbatim and reports as retained', () => {
    const raw = '{"v":99,"kind":"constraints","constraints":[]}';
    const state = baseState([line('L1', 0, 0, 1, 1)], { constraintsRetained: raw });
    const dxf = writeDxf(state);
    expect(dxf).toContain('JCAD_CONSTRAINTS');
    expect(dxf).toContain('"v":99');
    const back = readDxf(dxf);
    expect(back.constraints).toBeUndefined();
    expect(back.constraintsRetained).toBe(raw);
    const items = importReportOf(back)?.items ?? [];
    expect(items.some((i) => i.action === 'simplified' && i.reason.includes('could not be read'))).toBe(true);
  });

  it('a solved drawing saves its set; the read-back set solves against the read geometry', () => {
    const r = solveAndApply(solvableState());
    expect(r.ok).toBe(true);
    const back = readDxf(writeDxf(r.state));
    expect(back.constraints?.constraints.map((c) => c.id)).toEqual(['c-h', 'c-d']);
    const again = solveAndApply(back);
    expect(again.ok).toBe(true);
  });
});
