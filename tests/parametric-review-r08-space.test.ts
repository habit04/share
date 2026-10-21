/**
 * Priority 30 review correction — R08 RESIDUAL: the core edit path must
 * resolve the ACTIVE SPACE from a raw snapshot.
 *
 * The first R08 fix routed the editor's call sites (the pointer's drag
 * resolution, DYNSET and Properties — both of which run the pure edit
 * inside Drawing.transact, whose callback receives the projected state)
 * around the gap, but the shared helpers themselves still searched only
 * `state.entities`: `dynamicGripEdit(doc.snapshot, ...)` on a drawing
 * whose dynamic insert lives in the active layout returned undefined,
 * because a raw snapshot's entity list is the model-space list. Codex's
 * review suite (review-p30-dynamic: 'resolves an appended grip for an
 * INSERT visible in active paper space') pins the helper-level contract.
 *
 * The fix lives in the core: setDynamicParameter resolves the insert in
 * the state's own list first, else in the active layout's paper entities,
 * folding a success back into the layout; dynamicGripEdit /
 * dynamicGripDescriptor / resolveDynamicGripDrag resolve through the
 * same entityInActiveSpace. These tests pin:
 *  - the review case, at helper level, with the folded state's shape;
 *  - refusal identity against the CALLER's state (never a projection);
 *  - the composition with already-projected states (the pointer path):
 *    the edit lands in the projected list, layouts are NOT folded by the
 *    core, and the pointer's transact commits it into the layout exactly
 *    once — no double projection;
 *  - the scope boundary: only the ACTIVE space is searched, and an id
 *    present in the stored list keeps the pre-existing behaviour;
 *  - the unchanged tool wrappers (DYNSET / Properties) still composing.
 *
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { gripPoints, type BlockDef, type InsertEntity, type LineEntity } from '../src/core/entities';
import { defaultLayout, type Layout } from '../src/core/layouts';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { dynamicGripDescriptor, dynamicGripEdit, resolveDynamicGripDrag } from '../src/core/parametric/grips';
import { setDynamicParameterValue } from '../src/tools/parametric-properties';

const line = (id: string, bx = 10): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: bx, y: 0 } });

const widthParam = {
  kind: 'linear-distance' as const, id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range' as const, min: 5, max: 20 },
  grips: [{ role: 'value' as const, movesWithValue: true }],
};

const paperDef = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam],
  actions: [{
    kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'L1', points: { kind: 'frame' } }],
  }],
});

const paperBlock = (): BlockDef => ({ name: 'PAPERDYN', basePoint: { x: 0, y: 0 }, entities: [line('L1')], attributes: [], dynamic: paperDef() });

const insertOf = (id: string, values: InsertEntity['dynamic'] extends { values: infer V } | undefined ? V : never = {}, over: Partial<InsertEntity> = {}): InsertEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'insert', block: 'PAPERDYN',
  position: { x: 50, y: 50 }, rotation: 0, scale: 1, attributes: {},
  dynamic: { block: 'PAPERDYN', values },
  ...over,
});

/** A drawing whose dynamic insert 'P' lives ONLY in Layout1's paper
 *  space (the active space); model space holds an unrelated line. */
const paperDoc = (model: DrawingState['entities'] = [line('M1')]): Drawing => {
  const lay: Layout = { ...defaultLayout('Layout1'), pristine: undefined, viewports: [], entities: [insertOf('P')] };
  return new Drawing({
    entities: model, blocks: { PAPERDYN: paperBlock() }, currentLayer: '0',
    layouts: [lay], space: { layout: 'Layout1' },
  });
};

const layoutInsert = (state: DrawingState, layoutName: string, id: string): InsertEntity | undefined =>
  state.layouts?.find((l) => l.name === layoutName)?.entities.find((e) => e.id === id) as InsertEntity | undefined;

describe('R08 residual: dynamicGripEdit resolves the active space from a raw snapshot', () => {
  it('the review case: gripPoints shows the appended grip and dynamicGripEdit is defined', () => {
    // Codex review-p30-dynamic's fixture shape: model space empty, the
    // dynamic insert (width 14) alone in layout 'Sheet', active space.
    const lay: Layout = {
      ...defaultLayout('Sheet'), pristine: undefined, viewports: [],
      entities: [insertOf('paper', { width: { kind: 'distance', value: 14 } }, { position: { x: 0, y: 0 } })],
    };
    const doc = new Drawing({ entities: [], blocks: { PAPERDYN: paperBlock() }, currentLayer: '0', layouts: [lay] });
    doc.setSpace({ layout: 'Sheet' });
    const ins = doc.entities[0] as InsertEntity;
    expect(gripPoints(ins, undefined, doc.lookupBlock)).toHaveLength(2);
    const r = dynamicGripEdit(doc.snapshot, 'paper', 1, { x: 16, y: 0 });
    expect(r).toBeDefined();
    expect(r!.problem).toBeUndefined();
    expect(r!.state.entities).toEqual([]);
    expect(layoutInsert(r!.state, 'Sheet', 'paper')!.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
  });

  it('the returned state is a raw state: model list untouched by identity, the layout carries the edit', () => {
    const doc = paperDoc();
    const snap = doc.snapshot;
    const r = dynamicGripEdit(snap, 'P', 1, { x: 66, y: 50 }); // width grip dragged 60 -> 66: width 16
    expect(r).toBeDefined();
    expect(r!.problem).toBeUndefined();
    expect(r!.state).not.toBe(snap);
    expect(r!.state.entities).toBe(snap.entities); // model list shared, not rebuilt
    const edited = layoutInsert(r!.state, 'Layout1', 'P')!;
    expect(edited.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(edited.position).toEqual({ x: 50, y: 50 }); // a grip drag never moves the INSERT
    // The input snapshot is not mutated.
    expect(layoutInsert(snap, 'Layout1', 'P')!.dynamic?.values.width).toBeUndefined();
    // The descriptor resolves the same way.
    expect(dynamicGripDescriptor(snap, 'P', 1)?.parameterId).toBe('width');
    expect(dynamicGripDescriptor(snap, 'P', 0)).toBeUndefined();
  });

  it('committing the returned state through a Drawing lands the edit in the layout exactly once', () => {
    const doc = paperDoc();
    const r = dynamicGripEdit(doc.snapshot, 'P', 1, { x: 66, y: 50 })!;
    doc.transactDrawing(() => r.state);
    const now = doc.entities.find((e) => e.id === 'P') as InsertEntity;
    expect(now.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(doc.snapshot.entities.map((e) => e.id)).toEqual(['M1']);
    expect(doc.canUndo()).toBe(true);
    expect(doc.undo()).toBe(true);
    expect((doc.entities.find((e) => e.id === 'P') as InsertEntity).dynamic?.values.width).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
  });
});

describe('R08 residual: setDynamicParameter resolves the active space from a raw snapshot', () => {
  it('edits the paper-space insert in its layout only; the stored list is shared by identity', () => {
    const doc = paperDoc();
    const snap = doc.snapshot;
    const r = setDynamicParameter(snap, 'P', 'width', 16);
    expect(r.problem).toBeUndefined();
    expect(r.state).not.toBe(snap);
    expect(r.state.entities).toBe(snap.entities);
    expect(layoutInsert(r.state, 'Layout1', 'P')!.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(layoutInsert(snap, 'Layout1', 'P')!.dynamic?.values.width).toBeUndefined();
  });

  it('a refusal returns the caller\u2019s own state object, never the internal projection', () => {
    const doc = paperDoc();
    const snap = doc.snapshot;
    const r = setDynamicParameter(snap, 'P', 'width', 99); // outside the 5..20 range
    expect(r.problem).toBe('value-out-of-range');
    expect(r.state).toBe(snap);
    const drag = dynamicGripEdit(snap, 'P', 1, { x: 149, y: 50 }); // local width 99
    expect(drag).toBeDefined();
    expect(drag!.problem).toBe('value-out-of-range');
    expect(drag!.state).toBe(snap);
    // A stale grip index on the paper-space dynamic insert refuses
    // through resolveDynamicGripDrag — it never falls through.
    const stale = resolveDynamicGripDrag(snap, 'P', 7, { x: 66, y: 50 });
    expect(stale).toBeDefined();
    expect(stale!.problem).toBe('grip-not-resolvable');
    expect(stale!.state).toBe(snap);
  });

  it('scope: an insert living only in a NON-active layout is not found', () => {
    const lay1: Layout = { ...defaultLayout('Layout1'), pristine: undefined, viewports: [], entities: [] };
    const lay2: Layout = { ...defaultLayout('Layout2'), pristine: undefined, viewports: [], entities: [insertOf('Q')] };
    const doc = new Drawing({
      entities: [], blocks: { PAPERDYN: paperBlock() }, currentLayer: '0',
      layouts: [lay1, lay2], space: { layout: 'Layout1' },
    });
    const snap = doc.snapshot;
    const r = setDynamicParameter(snap, 'Q', 'width', 16);
    expect(r.problem).toBe('insert-not-found');
    expect(r.state).toBe(snap);
    expect(dynamicGripEdit(snap, 'Q', 1, { x: 66, y: 50 })).toBeUndefined();
    expect(resolveDynamicGripDrag(snap, 'Q', 1, { x: 66, y: 50 })).toBeUndefined();
  });

  it('an id present in the stored list keeps the pre-existing behaviour (stored list wins)', () => {
    const doc = paperDoc([insertOf('P', { width: { kind: 'distance', value: 12 } }, { position: { x: 0, y: 0 } })]);
    const snap = doc.snapshot;
    const r = setDynamicParameter(snap, 'P', 'width', 16);
    expect(r.problem).toBeUndefined();
    expect((r.state.entities.find((e) => e.id === 'P') as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(layoutInsert(r.state, 'Layout1', 'P')!.dynamic?.values.width).toBeUndefined(); // the layout copy is untouched
  });
});

describe('R08 residual: composition with already-projected states (the pointer path)', () => {
  it('the edit lands in the projected list; the core does NOT fold layouts (no double projection)', () => {
    const doc = paperDoc();
    // The view the pointer builds (pointer.ts activeSpaceState): the
    // snapshot with the active space's entities in place of the stored list.
    const view: DrawingState = { ...doc.snapshot, entities: doc.entities };
    const drag = resolveDynamicGripDrag(view, 'P', 1, { x: 66, y: 50 });
    expect(drag).toBeDefined();
    expect(drag!.problem).toBeUndefined();
    const edited = drag!.state.entities.find((e) => e.id === 'P') as InsertEntity;
    expect(edited.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(edited.position).toEqual({ x: 50, y: 50 });
    // Layouts are the view's own, by identity: transact's projection
    // remains the single fold.
    expect(drag!.state.layouts).toBe(view.layouts);
    // Committing the way the pointer does (transact returning the drag
    // state) lands the edit in the layout exactly once.
    doc.transact(() => drag!.state);
    expect((doc.entities.find((e) => e.id === 'P') as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(doc.snapshot.entities.map((e) => e.id)).toEqual(['M1']);
    expect(doc.undo()).toBe(true);
    expect((doc.entities.find((e) => e.id === 'P') as InsertEntity).dynamic?.values.width).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
  });

  it('the unchanged tool wrappers still compose: Properties commits exactly one undo step into the layout', () => {
    const doc = paperDoc();
    const logs: string[] = [];
    const ok = setDynamicParameterValue({ doc, log: (t) => logs.push(t) }, 'P', 'width', 16);
    expect(ok).toBe(true);
    expect(logs).toEqual([]);
    expect((doc.entities.find((e) => e.id === 'P') as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(doc.snapshot.entities.map((e) => e.id)).toEqual(['M1']);
    expect(doc.undo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
  });
});
