/**
 * Priority 30.4 slice A — generalized parameter editing at the apply layer
 * (src/core/parametric/apply.ts): angle / flip / visibility / lookup edits
 * under the same contract as the 30.1 distance editor (same-state-object
 * refusal with stable codes, one new insert object on success), plus the
 * lookup edit-layer contract of design-visibility-lookup-array.md §2.7:
 * choosing a row is one edit; directly editing a parameter covered by the
 * active row clears the stored row choice in the SAME returned state.
 *
 * DYNSET stays distance-only UI; nothing here drives the tool.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, LineEntity } from '../src/core/entities';
import type {
  AngleParameter,
  DynamicBlockDefinition,
  FlipParameter,
  LinearDistanceParameter,
  LookupParameter,
  VisibilityParameter,
} from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import type { DynamicInstanceState, DynamicParameterValue } from '../src/core/parametric/instance';

// --- Fixture: block DOOR with one parameter of each modeled kind ------------
// width (distance, input of the lookup), swing (angle, assignment target),
// handed (flip, covered by NO row), vis (visibility, assignment target),
// preset (lookup over [width]; Narrow assigns vis+swing, Wide assigns vis).
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const widthParam = (): LinearDistanceParameter => ({
  kind: 'linear-distance', id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
  grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
});
const swingParam = (): AngleParameter => ({
  kind: 'angle', id: 'swing', name: 'Swing',
  basePoint: { x: 0, y: 0 }, defaultValue: 0,
  constraint: { kind: 'range', min: 0, max: Math.PI / 2 },
  grips: [{ role: 'value', movesWithValue: false }],
});
const handedParam = (): FlipParameter => ({
  kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 0, y: 0 }, defaultValue: false,
});
const visParam = (): VisibilityParameter => ({
  kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'Open',
  states: [
    { name: 'Open', visible: ['L1', 'L2', 'L3', 'L4', 'TAG'] },
    { name: 'Closed', visible: ['L1', 'L3', 'L4', 'TAG'] },
  ],
});
const presetParam = (over: Partial<LookupParameter> = {}): LookupParameter => ({
  kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
  inputs: ['width'],
  defaultRow: null,
  rows: [
    {
      name: 'Narrow',
      key: { width: { kind: 'distance', value: 8 } },
      assignments: { vis: { kind: 'visibility', value: 'Closed' }, swing: { kind: 'angle', value: 0.5 } },
    },
    {
      name: 'Wide',
      key: { width: { kind: 'distance', value: 12 } },
      assignments: { vis: { kind: 'visibility', value: 'Open' } },
    },
  ],
  ...over,
});

const definition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam(), swingParam(), handedParam(), visParam(), presetParam()],
  actions: [],
  ...over,
});

const doorBlock = (over: Partial<BlockDef> = {}): BlockDef => ({
  name: 'DOOR',
  basePoint: { x: 0, y: 0 },
  entities: [line('L1', 0, 0, 10, 0), line('L2', 10, 0, 10, 5), line('L3', 10, 5, 0, 5), line('L4', 0, 5, 0, 0)],
  attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' }],
  dynamic: definition(),
  ...over,
});

const insert = (values: Record<string, DynamicParameterValue> = {}, over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'DOOR',
  position: { x: 100, y: 100 }, rotation: 0, scale: 1,
  attributes: { TAG: 'D-A' },
  dynamic: { block: 'DOOR', values },
  ...over,
});

const stateWith = (entities: Entity[], block: BlockDef = doorBlock()): DrawingState => ({
  entities,
  layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
  blocks: { [block.name]: block },
  currentLayer: '0',
});

const valuesOf = (state: DrawingState, id = 'A'): Readonly<Record<string, DynamicParameterValue>> => {
  const ins = state.entities.find((e) => e.id === id) as InsertEntity;
  return ins.dynamic?.values ?? {};
};

describe('generalized setDynamicParameter — per-kind accept + refusal', () => {
  it('angle: accepts a number, stores it sparsely on a NEW insert object only', () => {
    const other = line('X1', 0, 0, 1, 1);
    const state = stateWith([insert(), other]);
    const r = setDynamicParameter(state, 'A', 'swing', 0.25);
    expect(r.problem).toBeUndefined();
    expect(r.state).not.toBe(state);
    expect(valuesOf(r.state)).toEqual({ swing: { kind: 'angle', value: 0.25 } });
    // Only the insert changed identity; the other entity and the block are shared.
    expect(r.state.entities.find((e) => e.id === 'X1')).toBe(other);
    expect(r.state.blocks).toBe(state.blocks);
    expect(r.state.entities.find((e) => e.id === 'A')).not.toBe(state.entities[0]);
  });

  it('angle: refusals are same-state with stable codes', () => {
    const state = stateWith([insert()]);
    const outOfRange = setDynamicParameter(state, 'A', 'swing', 2.0); // > pi/2 max
    expect(outOfRange.state).toBe(state);
    expect(outOfRange.problem).toBe('value-out-of-range');
    const nan = setDynamicParameter(state, 'A', 'swing', Number.NaN);
    expect(nan.state).toBe(state);
    expect(nan.problem).toBe('non-finite-value');
    const wrongType = setDynamicParameter(state, 'A', 'swing', true);
    expect(wrongType.state).toBe(state);
    expect(wrongType.problem).toBe('wrong-value-kind');
    const noChange = setDynamicParameter(stateWith([insert({ swing: { kind: 'angle', value: 0.25 } })]), 'A', 'swing', 0.25);
    expect(noChange.problem).toBe('no-change');
  });

  it('flip: accepts a boolean; a number refuses wrong-value-kind; same value is no-change', () => {
    const state = stateWith([insert()]);
    const r = setDynamicParameter(state, 'A', 'handed', true);
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state)).toEqual({ handed: { kind: 'flip', value: true } });
    const wrong = setDynamicParameter(state, 'A', 'handed', 1);
    expect(wrong.state).toBe(state);
    expect(wrong.problem).toBe('wrong-value-kind');
    const same = setDynamicParameter(stateWith([insert({ handed: { kind: 'flip', value: true } })]), 'A', 'handed', true);
    expect(same.problem).toBe('no-change');
    expect(same.state.entities[0]).toBeDefined();
  });

  it('visibility: accepts a state name; unknown state and wrong shapes refuse', () => {
    const state = stateWith([insert()]);
    const r = setDynamicParameter(state, 'A', 'vis', 'Closed');
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state)).toEqual({ vis: { kind: 'visibility', value: 'Closed' } });
    const unknown = setDynamicParameter(state, 'A', 'vis', 'Ajar');
    expect(unknown.state).toBe(state);
    expect(unknown.problem).toBe('unknown-visibility-state');
    // The V5 shape from 30.2a: a NUMBER aimed at a visibility parameter is
    // still wrong-value-kind (never coerced to a state name).
    const numeric = setDynamicParameter(state, 'A', 'vis', 12);
    expect(numeric.state).toBe(state);
    expect(numeric.problem).toBe('wrong-value-kind');
  });

  it('distance behavior is unchanged from 30.1 (accept, no-change, range)', () => {
    const state = stateWith([insert({ width: { kind: 'distance', value: 14 } })]);
    const r = setDynamicParameter(state, 'A', 'width', 16);
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state).width).toEqual({ kind: 'distance', value: 16 });
    const same = setDynamicParameter(state, 'A', 'width', 14);
    expect(same.state).toBe(state);
    expect(same.problem).toBe('no-change');
    const out = setDynamicParameter(state, 'A', 'width', 25);
    expect(out.state).toBe(state);
    expect(out.problem).toBe('value-out-of-range');
  });

  it('a pre-existing invalid stored value blocks an unrelated edit (whole-candidate validation)', () => {
    const bad: DynamicInstanceState = { block: 'DOOR', values: { swing: { kind: 'angle', value: 3 } } };
    const state = stateWith([insert({}, { dynamic: bad })]);
    const r = setDynamicParameter(state, 'A', 'width', 12);
    expect(r.state).toBe(state);
    expect(r.problem).toBe('value-out-of-range');
  });
});

describe('generalized setDynamicParameter — guard chain identity', () => {
  const state = stateWith([insert(), line('X1', 0, 0, 1, 1)]);
  const cases: [string, DrawingState, string, string, unknown, string][] = [
    ['insert-not-found', state, 'ZZ', 'width', 12, 'insert-not-found'],
    ['entity-not-insert', state, 'X1', 'width', 12, 'entity-not-insert'],
    ['unknown-parameter', state, 'A', 'nope', 12, 'unknown-parameter'],
  ];
  it.each(cases)('%s refuses with the same state object', (_label, s, id, param, value, problem) => {
    const r = setDynamicParameter(s, id, param, value as number);
    expect(r.state).toBe(s);
    expect(r.problem).toBe(problem);
  });

  it('block-not-found / no-dynamic-definition / retained / mismatch', () => {
    const orphan = insert({}, { block: 'GHOST' });
    const s1 = stateWith([orphan]);
    expect(setDynamicParameter(s1, 'A', 'width', 12).problem).toBe('block-not-found');

    const s2 = stateWith([insert()], doorBlock({ dynamic: undefined }));
    const r2 = setDynamicParameter(s2, 'A', 'width', 12);
    expect(r2.state).toBe(s2);
    expect(r2.problem).toBe('no-dynamic-definition');

    const s3 = stateWith([insert()], doorBlock({ dynamic: undefined, dynamicRetained: '{"v":99}' }));
    expect(setDynamicParameter(s3, 'A', 'width', 12).problem).toBe('definition-retained');

    const s4 = stateWith([insert({}, { dynamicRetained: '{"v":99}' })]);
    const r4 = setDynamicParameter(s4, 'A', 'width', 12);
    expect(r4.state).toBe(s4);
    expect(r4.problem).toBe('instance-retained');

    const mismatched: DynamicInstanceState = { block: 'OTHER', values: {} };
    const s5 = stateWith([insert({}, { dynamic: mismatched })]);
    expect(setDynamicParameter(s5, 'A', 'width', 12).problem).toBe('block-mismatch');
  });

  it('an opaque parameter refuses any edit as wrong-value-kind', () => {
    const def = definition({
      parameters: [...definition().parameters, { kind: 'opaque-parameter', id: 'op', name: 'Op', sourceKind: 'BLOCKX', payload: 'zz' }],
      actions: [],
    });
    const s = stateWith([insert()], doorBlock({ dynamic: def }));
    const r = setDynamicParameter(s, 'A', 'op', 3);
    expect(r.state).toBe(s);
    expect(r.problem).toBe('wrong-value-kind');
  });
});

describe('lookup edits (design §2.7 rules 1 and 2)', () => {
  it('rule 1: choosing a row changes ONLY the lookup value in the stored record', () => {
    const state = stateWith([insert({ width: { kind: 'distance', value: 14 } })]);
    const r = setDynamicParameter(state, 'A', 'preset', 'Narrow');
    expect(r.problem).toBeUndefined();
    // The row's key/assignments are evaluation-time overrides; the stored
    // record gains no direct width/vis/swing entries from a row choice.
    expect(valuesOf(r.state)).toEqual({
      width: { kind: 'distance', value: 14 },
      preset: { kind: 'lookup', value: 'Narrow' },
    });
  });

  it('choosing an unknown row refuses unknown-lookup-row; a number refuses wrong-value-kind', () => {
    const state = stateWith([insert()]);
    const unknown = setDynamicParameter(state, 'A', 'preset', 'Huge');
    expect(unknown.state).toBe(state);
    expect(unknown.problem).toBe('unknown-lookup-row');
    const numeric = setDynamicParameter(state, 'A', 'preset', 3);
    expect(numeric.state).toBe(state);
    expect(numeric.problem).toBe('wrong-value-kind');
  });

  it('clearing a choice directly (null) is one ordinary edit', () => {
    const state = stateWith([insert({ preset: { kind: 'lookup', value: 'Wide' } })]);
    const r = setDynamicParameter(state, 'A', 'preset', null);
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state).preset).toEqual({ kind: 'lookup', value: null });
  });

  it('rule 2: editing an INPUT of the active row clears the choice in the same state', () => {
    const state = stateWith([insert({ preset: { kind: 'lookup', value: 'Narrow' } })]);
    const r = setDynamicParameter(state, 'A', 'width', 9);
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state)).toEqual({
      width: { kind: 'distance', value: 9 },
      preset: { kind: 'lookup', value: null },
    });
  });

  it('rule 2: editing an ASSIGNMENT TARGET of the active row clears the choice', () => {
    const bySwing = setDynamicParameter(
      stateWith([insert({ preset: { kind: 'lookup', value: 'Narrow' } })]), 'A', 'swing', 0.7);
    expect(valuesOf(bySwing.state).preset).toEqual({ kind: 'lookup', value: null });
    expect(valuesOf(bySwing.state).swing).toEqual({ kind: 'angle', value: 0.7 });
    const byVis = setDynamicParameter(
      stateWith([insert({ preset: { kind: 'lookup', value: 'Narrow' } })]), 'A', 'vis', 'Open');
    expect(valuesOf(byVis.state).preset).toEqual({ kind: 'lookup', value: null });
  });

  it('rule 2: a parameter the active row does NOT cover leaves the choice untouched', () => {
    // 'Wide' covers width (key) and vis (assignment) — not swing, not handed.
    const bySwing = setDynamicParameter(
      stateWith([insert({ preset: { kind: 'lookup', value: 'Wide' } })]), 'A', 'swing', 0.7);
    expect(bySwing.problem).toBeUndefined();
    expect(valuesOf(bySwing.state).preset).toEqual({ kind: 'lookup', value: 'Wide' });
    const byHanded = setDynamicParameter(
      stateWith([insert({ preset: { kind: 'lookup', value: 'Narrow' } })]), 'A', 'handed', true);
    expect(valuesOf(byHanded.state).preset).toEqual({ kind: 'lookup', value: 'Narrow' });
  });

  it('rule 2 with defaultRow: no stored choice — editing a covered parameter materializes the cleared state', () => {
    const def = definition({ parameters: [widthParam(), swingParam(), handedParam(), visParam(), presetParam({ defaultRow: 'Wide' })] });
    const state = stateWith([insert()], doorBlock({ dynamic: def }));
    const r = setDynamicParameter(state, 'A', 'width', 15);
    expect(r.problem).toBeUndefined();
    expect(valuesOf(r.state)).toEqual({
      width: { kind: 'distance', value: 15 },
      preset: { kind: 'lookup', value: null },
    });
    // An uncovered parameter under a defaultRow leaves NO lookup entry behind.
    const r2 = setDynamicParameter(state, 'A', 'handed', true);
    expect(r2.problem).toBeUndefined();
    expect(valuesOf(r2.state)).toEqual({ handed: { kind: 'flip', value: true } });
  });

  it('no active row (stored null, or no choice and no defaultRow): covered edits add no lookup entry', () => {
    const explicitNull = setDynamicParameter(
      stateWith([insert({ preset: { kind: 'lookup', value: null } })]), 'A', 'width', 9);
    expect(valuesOf(explicitNull.state)).toEqual({
      width: { kind: 'distance', value: 9 },
      preset: { kind: 'lookup', value: null },
    });
    const none = setDynamicParameter(stateWith([insert()]), 'A', 'width', 9);
    expect(valuesOf(none.state)).toEqual({ width: { kind: 'distance', value: 9 } });
  });

  it('a clearing edit is ONE transact = ONE undo step at the document level', () => {
    const doc = new Drawing(stateWith([insert({ preset: { kind: 'lookup', value: 'Narrow' } })]));
    const before = doc.snapshot;
    const r = setDynamicParameter(doc.snapshot, 'A', 'width', 9);
    expect(r.problem).toBeUndefined();
    doc.transact(() => r.state);
    expect(doc.snapshot).not.toBe(before);
    expect(valuesOf(doc.snapshot)).toEqual({
      width: { kind: 'distance', value: 9 },
      preset: { kind: 'lookup', value: null },
    });
    expect(doc.canUndo()).toBe(true);
    doc.undo();
    // One undo restores BOTH the width edit and the row choice.
    expect(doc.snapshot).toBe(before);
    expect(valuesOf(doc.snapshot)).toEqual({ preset: { kind: 'lookup', value: 'Narrow' } });
    doc.redo();
    expect(valuesOf(doc.snapshot).preset).toEqual({ kind: 'lookup', value: null });
  });
});
