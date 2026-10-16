/**
 * Priority 30 review corrections — dynamic edit-path group.
 *
 * R06: setDynamicParameter must EVALUATE the proposed values before
 * committing: an edit whose evaluation refuses (work/output limit,
 * degenerate transform, unsupported member) leaves the state object —
 * and, through a Drawing, snapshot/revision/dirty/undo — untouched.
 *
 * R08: DYNSET, Properties and dynamic grips must work for inserts in
 * PAPER space (layout block records), not only model space; a
 * parameter-grip drag must never fall through to moving the INSERT.
 *
 * R11: grips, Properties rows and DYNSET prompts must show the same
 * lookup-resolved effective values geometry uses (selected row, default
 * row, and the direct values after an edit clears the row).
 *
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { gripPoints, type BlockDef, type InsertEntity, type LineEntity } from '../src/core/entities';
import { defaultLayout, type Layout } from '../src/core/layouts';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { dynamicGripEdit, dynamicGrips, resolveDynamicGripDrag } from '../src/core/parametric/grips';
import { dynSetTool } from '../src/tools/parametric';
import { dynamicParameterRows, setDynamicParameterValue } from '../src/tools/parametric-properties';
import { fakeContext, drive } from './fake-context';

const line = (id: string, bx = 10): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: bx, y: 0 } });

const widthParam = (over: Record<string, unknown> = {}) => ({
  kind: 'linear-distance' as const, id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range' as const, min: 5, max: 20 },
  grips: [{ role: 'value' as const, movesWithValue: true }],
  ...over,
});

const stretchOnWidth = {
  kind: 'stretch' as const, id: 'S1', name: 'Stretch', parameterId: 'width',
  frame: { kind: 'rectangle' as const, min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
  selection: [{ entityId: 'L1', points: { kind: 'frame' as const } }],
};

const blockOf = (name: string, dynamic: DynamicBlockDefinition, entities = [line('L1')]): BlockDef => ({
  name, basePoint: { x: 0, y: 0 }, entities, attributes: [], dynamic,
});

const insertOf = (id: string, block: string, values: InsertEntity['dynamic'] extends { values: infer V } | undefined ? V : never = {}, over: Partial<InsertEntity> = {}): InsertEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'insert', block,
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
  dynamic: { block, values },
  ...over,
});

const stateOf = (entities: DrawingState['entities'], blocks: DrawingState['blocks']): DrawingState =>
  new Drawing({ entities: [...entities], blocks, currentLayer: '0' }).snapshot;

// ---------------------------------------------------------------------------
// R06 — evaluate before committing
// ---------------------------------------------------------------------------

describe('R06: parameter edits are evaluated before they commit', () => {
  const arrayDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [widthParam({ id: 'span', name: 'Span', constraint: { kind: 'unbounded' } })],
    actions: [{ kind: 'array', id: 'ARR', name: 'Array', parameterId: 'span', spacing: 1, selection: [{ entityId: 'L1' }] }],
  });
  const scaleDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [widthParam({ id: 'size', name: 'Size', constraint: { kind: 'unbounded' } })],
    actions: [{ kind: 'scale', id: 'SC', name: 'Scale', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'L1' }] }],
  });
  const opaqueDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [widthParam()],
    actions: [{ kind: 'opaque-action', id: 'OA', name: 'Legacy', parameterId: 'width', sourceKind: 'rotate', payload: '{}' }],
  });

  it('an edit tripping the array output limit refuses with the evaluation code and the identical state', () => {
    const state = stateOf([insertOf('A', 'ARRBLK')], { ARRBLK: blockOf('ARRBLK', arrayDef()) });
    const r = setDynamicParameter(state, 'A', 'span', 20000); // 20001 copies > 10000 output limit
    expect(r.problem).toBe('work-limit-exceeded');
    expect(r.state).toBe(state);
  });

  it('an edit driving a scale factor to zero refuses as degenerate-transform', () => {
    const state = stateOf([insertOf('A', 'SCBLK')], { SCBLK: blockOf('SCBLK', scaleDef()) });
    const r = setDynamicParameter(state, 'A', 'size', 0); // factor 0 / 10
    expect(r.problem).toBe('degenerate-transform');
    expect(r.state).toBe(state);
  });

  it('an edit on a definition whose evaluation is unsupported refuses with the evaluation code', () => {
    const state = stateOf([insertOf('A', 'OPBLK')], { OPBLK: blockOf('OPBLK', opaqueDef()) });
    const r = setDynamicParameter(state, 'A', 'width', 12);
    expect(r.problem).toBe('unsupported-action');
    expect(r.state).toBe(state);
  });

  it('through a Drawing, a refused edit leaves snapshot, revision, dirty and undo history untouched', () => {
    const doc = new Drawing({ entities: [insertOf('A', 'ARRBLK')], blocks: { ARRBLK: blockOf('ARRBLK', arrayDef()) }, currentLayer: '0' });
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    expect(doc.dirty).toBe(false);
    // The exact commit shape the editor paths use: the pure result decides.
    doc.transact((s) => setDynamicParameter(s, 'A', 'span', 20000).state);
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect((doc.entities[0] as InsertEntity).dynamic?.values.span).toBeUndefined();
  });

  it('an edit whose evaluation succeeds still commits (the dry run is not a blanket refusal)', () => {
    const state = stateOf([insertOf('A', 'STBLK')], { STBLK: blockOf('STBLK', { version: 1, parameters: [widthParam()], actions: [stretchOnWidth] }) });
    const r = setDynamicParameter(state, 'A', 'width', 14);
    expect(r.problem).toBeUndefined();
    expect(r.state).not.toBe(state);
    expect((r.state.entities[0] as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 14 });
  });
});

// ---------------------------------------------------------------------------
// R08 — paper-space DYNSET / Properties / grips
// ---------------------------------------------------------------------------

describe('R08: dynamic editing works in paper space', () => {
  const paperDef = (): DynamicBlockDefinition => ({ version: 1, parameters: [widthParam()], actions: [stretchOnWidth] });
  const paperBlock = () => blockOf('PAPERDYN', paperDef());

  /** A drawing whose dynamic insert lives ONLY in Layout1's paper space;
   *  model space holds an unrelated line. The layout is the active space. */
  const paperDoc = (): Drawing => {
    const lay: Layout = {
      ...defaultLayout('Layout1'), pristine: undefined, viewports: [],
      entities: [insertOf('P', 'PAPERDYN', {}, { position: { x: 50, y: 50 } })],
    };
    return new Drawing({
      entities: [line('M1')], blocks: { PAPERDYN: paperBlock() }, currentLayer: '0',
      layouts: [lay], space: { layout: 'Layout1' },
    });
  };
  const paperInsert = (doc: Drawing): InsertEntity => doc.entities.find((e) => e.id === 'P') as InsertEntity;
  const storedWidth = (doc: Drawing) => paperInsert(doc).dynamic?.values.width;

  it('setup sanity: the insert is in the active (paper) entity list, not in snapshot.entities', () => {
    const doc = paperDoc();
    expect(doc.entities.some((e) => e.id === 'P')).toBe(true);
    expect(doc.snapshot.entities.some((e) => e.id === 'P')).toBe(false);
    expect(doc.snapshot.entities.some((e) => e.id === 'M1')).toBe(true);
  });

  it('DYNSET edits a paper-space insert and commits exactly one undo step into the layout', () => {
    const doc = paperDoc();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['P']);
    drive(dynSetTool(), ctx, ['15']);
    expect(ctx.logs.some((l) => l.includes('Width set to 15'))).toBe(true);
    expect(storedWidth(doc)).toEqual({ kind: 'distance', value: 15 });
    // Model space untouched; the layout in the raw state carries the edit.
    expect(doc.snapshot.entities).toEqual([line('M1')]);
    expect(doc.snapshot.layouts?.[0]?.entities.some((e) => e.id === 'P')).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(storedWidth(doc)).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
  });

  it('the Properties setter commits a paper-space edit; rows render for the paper insert', () => {
    const doc = paperDoc();
    const rows = dynamicParameterRows(doc.blocks.PAPERDYN!, paperInsert(doc));
    expect(rows).toContainEqual({ kind: 'distance', id: 'width', name: 'Width', value: 10 });
    const logs: string[] = [];
    const ok = setDynamicParameterValue({ doc, log: (t) => logs.push(t) }, 'P', 'width', 16);
    expect(ok).toBe(true);
    expect(logs).toEqual([]);
    expect(storedWidth(doc)).toEqual({ kind: 'distance', value: 16 });
  });

  it('a paper-space grip drag commits the parameter — never the insert position', () => {
    const doc = paperDoc();
    const ins = paperInsert(doc);
    const grips = gripPoints(ins, undefined, doc.lookupBlock);
    expect(grips).toHaveLength(2); // position grip + width value grip
    expect(grips[1]).toEqual({ x: 60, y: 50 });
    // The view the pointer must resolve against: the active-space state.
    const view: DrawingState = { ...doc.snapshot, entities: doc.entities };
    const drag = resolveDynamicGripDrag(view, 'P', 1, { x: 65, y: 50 });
    expect(drag?.problem).toBeUndefined();
    const edited = drag!.state.entities.find((e) => e.id === 'P') as InsertEntity;
    expect(edited.dynamic?.values.width).toEqual({ kind: 'distance', value: 15 });
    expect(edited.position).toEqual({ x: 50, y: 50 }); // the INSERT did not move
    // Against the raw snapshot the same drag ALSO resolves (R08
    // residual): the core edit path resolves the active space itself,
    // returning a raw state whose layout carries the edit and whose
    // stored list is the snapshot's own. This pin originally asserted
    // undefined for the raw snapshot — the helper-level gap Codex's
    // review-p30-dynamic case ('resolves an appended grip for an INSERT
    // visible in active paper space') then caught; the full contract is
    // pinned in tests/parametric-review-r08-space.test.ts.
    const raw = dynamicGripEdit(doc.snapshot, 'P', 1, { x: 65, y: 50 });
    expect(raw).toBeDefined();
    expect(raw!.problem).toBeUndefined();
    expect(raw!.state.entities).toBe(doc.snapshot.entities);
    const rawEdited = raw!.state.layouts?.[0]?.entities.find((e) => e.id === 'P') as InsertEntity;
    expect(rawEdited.dynamic?.values.width).toEqual({ kind: 'distance', value: 15 });
    expect(rawEdited.position).toEqual({ x: 50, y: 50 });
  });

  it('an unresolvable dynamic grip index refuses — it never becomes a whole-insert move', () => {
    const doc = paperDoc();
    const view: DrawingState = { ...doc.snapshot, entities: doc.entities };
    const drag = resolveDynamicGripDrag(view, 'P', 7, { x: 65, y: 50 });
    expect(drag).toBeDefined();
    expect(drag!.problem).toBe('grip-not-resolvable');
    expect(drag!.state).toBe(view);
    // A NON-dynamic insert still yields undefined, so ordinary grip
    // handling (moveGrip) remains the caller's path there.
    const plain = stateOf([insertOf('S', 'PLAIN')], { PLAIN: { name: 'PLAIN', basePoint: { x: 0, y: 0 }, entities: [line('L1')], attributes: [] } });
    expect(resolveDynamicGripDrag(plain, 'S', 1, { x: 1, y: 1 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R11 — one lookup-resolved value source for geometry, grips, rows, prompts
// ---------------------------------------------------------------------------

describe('R11: grips, Properties and DYNSET show the lookup-resolved values geometry uses', () => {
  const lookupDef = (defaultRow: string | null): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      widthParam(),
      {
        kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 },
        defaultValue: 0, constraint: { kind: 'range', min: -1, max: 1 },
        grips: [{ role: 'value', movesWithValue: true }],
      },
      {
        kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
        inputs: ['width'], defaultRow,
        rows: [
          { name: 'Wide', key: { width: { kind: 'distance', value: 18 } }, assignments: {} },
          { name: 'Narrow', key: { width: { kind: 'distance', value: 6 } }, assignments: { swing: { kind: 'angle', value: 0.5 } } },
        ],
      },
    ],
    actions: [stretchOnWidth],
  });
  const lookupBlock = (defaultRow: string | null = null) => blockOf('LOOKUPBLK', lookupDef(defaultRow));

  /** Stored row 'Narrow' over raw stored width 10 / swing 0: geometry
   *  resolves width 6 and swing 0.5. */
  const narrowInsert = (): InsertEntity => insertOf('A', 'LOOKUPBLK', {
    preset: { kind: 'lookup', value: 'Narrow' },
    width: { kind: 'distance', value: 10 },
    swing: { kind: 'angle', value: 0 },
  });

  it('geometry ground truth: evaluation applies the row (width 6, not the raw 10)', () => {
    const block = lookupBlock();
    const r = evaluateDynamicBlock(block.dynamic!, block.entities, block.attributes, narrowInsert().dynamic);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.entities[0] as LineEntity).b.x).toBe(6); // 10 + (6 - 10)
  });

  it('selected row: grip positions sit at the ROW values', () => {
    const grips = dynamicGrips(narrowInsert(), lookupBlock());
    const width = grips.find((gr) => gr.parameterId === 'width');
    const swing = grips.find((gr) => gr.parameterId === 'swing');
    expect(width?.localPoint).toEqual({ x: 6, y: 0 });
    expect(swing?.localPoint.x).toBeCloseTo(Math.cos(0.5), 9);
    expect(swing?.localPoint.y).toBeCloseTo(Math.sin(0.5), 9);
  });

  it('selected row: Properties rows show the ROW values', () => {
    const rows = dynamicParameterRows(lookupBlock(), narrowInsert());
    expect(rows).toContainEqual({ kind: 'distance', id: 'width', name: 'Width', value: 6 });
    expect(rows).toContainEqual({ kind: 'angle', id: 'swing', name: 'Swing', value: 0.5 });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'lookup', id: 'preset', value: 'Narrow' }));
  });

  it('selected row: the DYNSET parameter list shows the ROW values', () => {
    const doc = new Drawing({ entities: [narrowInsert()], blocks: { LOOKUPBLK: lookupBlock() }, currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['A']);
    drive(dynSetTool(), ctx, ['width']);
    expect(ctx.logs).toContain('width (Width) = 6');
    expect(ctx.logs).toContain('swing (Swing) = 0.5 rad');
  });

  it('default row: with no stored choice, the default row resolves everywhere', () => {
    const block = lookupBlock('Wide');
    const ins = insertOf('A', 'LOOKUPBLK', {});
    const grips = dynamicGrips(ins, block);
    expect(grips.find((gr) => gr.parameterId === 'width')?.localPoint).toEqual({ x: 18, y: 0 });
    const rows = dynamicParameterRows(block, ins);
    expect(rows).toContainEqual({ kind: 'distance', id: 'width', name: 'Width', value: 18 });
  });

  it('after a direct edit clears the row (§2.7), all three surfaces show the direct values', () => {
    const block = lookupBlock();
    const state = stateOf([narrowInsert()], { LOOKUPBLK: block });
    const r = setDynamicParameter(state, 'A', 'width', 12); // width is a lookup input: clears 'Narrow'
    expect(r.problem).toBeUndefined();
    const edited = r.state.entities[0] as InsertEntity;
    expect(edited.dynamic?.values.preset).toEqual({ kind: 'lookup', value: null });
    const grips = dynamicGrips(edited, block);
    expect(grips.find((gr) => gr.parameterId === 'width')?.localPoint).toEqual({ x: 12, y: 0 });
    const rows = dynamicParameterRows(block, edited);
    expect(rows).toContainEqual({ kind: 'distance', id: 'width', name: 'Width', value: 12 });
    expect(rows).toContainEqual({ kind: 'angle', id: 'swing', name: 'Swing', value: 0 });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'lookup', id: 'preset', value: null }));
  });
});
