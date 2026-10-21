/**
 * Priority 30.2b — lookup parameter acceptance (design
 * design-visibility-lookup-array.md §2 + §8 cases L1–L9).
 *
 * Model 3 (design §2.2): the instance stores a row choice; evaluation
 * applies the chosen row over the direct effective values in a single
 * pass (row wins). Keys play no role in evaluation — they serve the grip
 * menu and the pure `matchingLookupRow` display query.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import type { AttributeDef, Entity, LineEntity } from '../src/core/entities';
import {
  validateDefinition,
  type AngleParameter,
  type DynamicBlockDefinition,
  type DynamicParameter,
  type FlipParameter,
  type LinearDistanceParameter,
  type LookupParameter,
  type VisibilityParameter,
} from '../src/core/parametric/definitions';
import {
  validateInstanceValues,
  type DynamicInstanceState,
  type DynamicParameterValue,
} from '../src/core/parametric/instance';
import { evaluateDynamicBlock, matchingLookupRow } from '../src/core/parametric/evaluate';
import {
  decodeDynamicDefinition,
  decodeDynamicInstance,
  encodeDynamicDefinition,
  encodeDynamicInstance,
} from '../src/io/dxf/dynamic-data';

// --- Fixture DOOR2 (design §8) ------------------------------------------------
// The 30.1 DOOR extended: angle `swing`, flip `handed` (flip action on L2),
// visibility `vis` (Open = everything, Closed = all but L2), lookup `preset`
// with inputs [width], defaultRow null, rows Narrow / Wide. A rotate action
// R1 on `swing` (centre (0,5), selection L3) makes the angle observable in
// geometry — L9 requires width, visibility AND angle effects in one result.
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const door2Entities = (): Entity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 5),
  line('L3', 10, 5, 0, 5),
  line('L4', 0, 5, 0, 0),
];
const door2Attributes = (): AttributeDef[] => [
  { tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' },
];
const DOOR2_IDS = new Set(['L1', 'L2', 'L3', 'L4', 'TAG']);

const widthParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance', id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
  grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
  ...over,
});
const swingParam = (over: Partial<AngleParameter> = {}): AngleParameter => ({
  kind: 'angle', id: 'swing', name: 'Swing',
  basePoint: { x: 0, y: 0 }, defaultValue: 0,
  constraint: { kind: 'range', min: 0, max: Math.PI / 2 },
  grips: [{ role: 'value', movesWithValue: false }],
  ...over,
});
const handedParam = (over: Partial<FlipParameter> = {}): FlipParameter => ({
  kind: 'flip', id: 'handed', name: 'Handed',
  basePoint: { x: 0, y: 0 }, defaultValue: false,
  ...over,
});
const visParam = (over: Partial<VisibilityParameter> = {}): VisibilityParameter => ({
  kind: 'visibility', id: 'vis', name: 'Visibility',
  basePoint: { x: 0, y: 6 }, defaultState: 'Open',
  states: [
    { name: 'Open', visible: ['L1', 'L2', 'L3', 'L4', 'TAG'] },
    { name: 'Closed', visible: ['L1', 'L3', 'L4', 'TAG'] },
  ],
  ...over,
});
const presetParam = (over: Partial<LookupParameter> = {}): LookupParameter => ({
  kind: 'lookup', id: 'preset', name: 'Preset',
  basePoint: { x: 0, y: 7 },
  inputs: ['width'],
  defaultRow: null,
  rows: [
    {
      name: 'Narrow',
      key: { width: { kind: 'distance', value: 8 } },
      assignments: {
        vis: { kind: 'visibility', value: 'Closed' },
        swing: { kind: 'angle', value: 0.5 },
      },
    },
    {
      name: 'Wide',
      key: { width: { kind: 'distance', value: 12 } },
      assignments: { vis: { kind: 'visibility', value: 'Open' } },
    },
  ],
  ...over,
});

const door2Definition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam(), swingParam(), handedParam(), visParam(), presetParam()],
  actions: [
    {
      kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
      frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
      selection: [
        { entityId: 'L2', points: { kind: 'frame' } },
        { entityId: 'L1', points: { kind: 'frame' } },
        { entityId: 'L3', points: { kind: 'frame' } },
      ],
    },
    { kind: 'rotate', id: 'R1', name: 'Swing', parameterId: 'swing', center: { x: 0, y: 5 }, selection: [{ entityId: 'L3' }] },
    { kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed', axisA: { x: 0, y: 0 }, axisB: { x: 0, y: 1 }, selection: [{ entityId: 'L2' }] },
  ],
  ...over,
});

/** DOOR2 with the preset parameter replaced (malformed-table variants). */
const withPreset = (preset: LookupParameter): DynamicBlockDefinition =>
  door2Definition({
    parameters: [widthParam(), swingParam(), handedParam(), visParam(), preset],
  });
const withParams = (parameters: DynamicParameter[]): DynamicBlockDefinition =>
  door2Definition({ parameters });

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'DOOR2', values });
const asLine = (e: Entity): LineEntity => e as LineEntity;
const idsOf = (entities: readonly Entity[]): string[] => entities.map((e) => e.id);
const codesOf = (def: DynamicBlockDefinition): string[] => validateDefinition(def, DOOR2_IDS).map((i) => i.code);
const expectPoint = (p: { x: number; y: number }, x: number, y: number): void => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

// --- Evaluation semantics (L1–L5, L7, L9) ------------------------------------
describe('evaluateDynamicBlock — lookup override pass (30.2b)', () => {
  it('the DOOR2 fixture itself is a valid definition', () => {
    expect(validateDefinition(door2Definition(), DOOR2_IDS)).toEqual([]);
  });

  it('L1: choosing a row applies its key and assignments; the diagnostic names the row', () => {
    const result = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), state({ preset: { kind: 'lookup', value: 'Wide' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Width 12 came from the row's KEY (choosing the row sets the inputs too).
    const l2 = asLine(result.entities.find((e) => e.id === 'L2')!);
    expectPoint(l2.a, 12, 0);
    expectPoint(l2.b, 12, 5);
    // The row's visibility assignment (Open) applies in the same evaluation.
    expect(idsOf(result.entities)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(result.attributes.map((a) => a.tag)).toEqual(['TAG']);
    const applied = result.diagnostics.find((d) => d.code === 'lookup-applied');
    expect(applied).toBeDefined();
    expect(applied!.parameterId).toBe('preset');
    expect(applied!.message).toContain('Wide');
    // 'value-defaulted' is suppressed for row-set parameters (width came from
    // the row, not a default) but still reported for uncovered ones (swing).
    expect(result.diagnostics.some((d) => d.code === 'value-defaulted' && d.parameterId === 'width')).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'value-defaulted' && d.parameterId === 'swing')).toBe(true);
  });

  it('L2: the row wins over a direct value, and evaluation never writes the stored state', () => {
    const instance = state({ width: { kind: 'distance', value: 8 }, preset: { kind: 'lookup', value: 'Wide' } });
    const snapshot = JSON.stringify(instance);
    const result = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Geometry is the width-12 result, not the stored width-8.
    const l2 = asLine(result.entities.find((e) => e.id === 'L2')!);
    expectPoint(l2.a, 12, 0);
    // The direct value is shadowed, not deleted: the stored state is intact.
    expect(JSON.stringify(instance)).toBe(snapshot);
    expect(instance.values.width).toEqual({ kind: 'distance', value: 8 });
  });

  it('L3: a partial row leaves unlisted parameters at their direct values', () => {
    const instance = state({ preset: { kind: 'lookup', value: 'Narrow' }, handed: { kind: 'flip', value: true } });
    const result = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Narrow sets width 8 (key), vis Closed, swing 0.5: L2 is filtered out,
    // L1 is stretched to width 8, L3 is stretched then rotated by 0.5.
    expect(idsOf(result.entities)).toEqual(['L1', 'L3', 'L4']);
    const l1 = asLine(result.entities.find((e) => e.id === 'L1')!);
    expectPoint(l1.b, 8, 0);
    const l3 = asLine(result.entities.find((e) => e.id === 'L3')!);
    expectPoint(l3.a, 8 * Math.cos(0.5), 5 + 8 * Math.sin(0.5));
    expectPoint(l3.b, 0, 5);
    // `handed` is not assigned by the row: its direct value survives in the
    // stored state (evaluation never writes state)…
    expect(instance.values.handed).toEqual({ kind: 'flip', value: true });
    // …and geometrically, under a row that leaves L2 visible: Wide + handed
    // flips the stretched L2 across the y-axis to x = -12.
    const wide = evaluateDynamicBlock(
      door2Definition(), door2Entities(), door2Attributes(),
      state({ preset: { kind: 'lookup', value: 'Wide' }, handed: { kind: 'flip', value: true } }),
    );
    expect(wide.ok).toBe(true);
    if (!wide.ok) return;
    const flipped = asLine(wide.entities.find((e) => e.id === 'L2')!);
    expectPoint(flipped.a, -12, 0);
    expectPoint(flipped.b, -12, 5);
  });

  it('L4: no choice and no default row means no override; a default row applies without a choice', () => {
    const plain = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), state({ width: { kind: 'distance', value: 10 } }));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.diagnostics.some((d) => d.code === 'lookup-applied')).toBe(false);
    expect(idsOf(plain.entities)).toEqual(['L1', 'L2', 'L3', 'L4']);

    const withDefault = withPreset(presetParam({ defaultRow: 'Narrow' }));
    const defaulted = evaluateDynamicBlock(withDefault, door2Entities(), door2Attributes(), state({ width: { kind: 'distance', value: 10 } }));
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.diagnostics.some((d) => d.code === 'lookup-applied')).toBe(true);
    expect(idsOf(defaulted.entities)).toEqual(['L1', 'L3', 'L4']); // Narrow -> Closed
  });

  it('L5: a stored choice naming no row is refused as an invalid instance, never a silent no-op', () => {
    const instance = state({ preset: { kind: 'lookup', value: 'Huge' } });
    const validation = validateInstanceValues(door2Definition(), instance);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'unknown-lookup-row', parameterId: 'preset' }));
    }
    const result = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), instance);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('invalid-instance');
    expect(result.refusal.instanceIssues?.some((i) => i.code === 'unknown-lookup-row')).toBe(true);
    // The stored choice is retained (evaluation never writes state).
    expect(instance.values.preset).toEqual({ kind: 'lookup', value: 'Huge' });
  });

  it('L7: an explicit null choice overrides the default row — no row applies', () => {
    const def = withPreset(presetParam({ defaultRow: 'Narrow' }));
    const instance = state({ preset: { kind: 'lookup', value: null } });
    const validation = validateInstanceValues(def, instance);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.effective.preset).toEqual({ kind: 'lookup', value: null });
    const result = evaluateDynamicBlock(def, door2Entities(), door2Attributes(), instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.some((d) => d.code === 'lookup-applied')).toBe(false);
    expect(idsOf(result.entities)).toEqual(['L1', 'L2', 'L3', 'L4']); // defaults: width 10, vis Open
  });

  it('L9: one row application is atomic — width, visibility and angle land in a single result', () => {
    const viaRow = evaluateDynamicBlock(door2Definition(), door2Entities(), door2Attributes(), state({ preset: { kind: 'lookup', value: 'Narrow' } }));
    const direct = evaluateDynamicBlock(
      door2Definition(), door2Entities(), door2Attributes(),
      state({
        width: { kind: 'distance', value: 8 },
        swing: { kind: 'angle', value: 0.5 },
        vis: { kind: 'visibility', value: 'Closed' },
      }),
    );
    expect(viaRow.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (!viaRow.ok || !direct.ok) return;
    // No intermediate state is observable: the single result equals the
    // equivalent direct-values evaluation, action list included.
    expect(viaRow.entities).toEqual(direct.entities);
    expect(viaRow.attributes).toEqual(direct.attributes);
    expect(viaRow.appliedActions).toEqual(direct.appliedActions);
    expect(idsOf(viaRow.entities)).toEqual(['L1', 'L3', 'L4']);
  });
});

// --- Derived-row query (L8) ----------------------------------------------------
describe('matchingLookupRow — derived current-row query (30.2b)', () => {
  const preset = presetParam();
  const effectiveOf = (values: DynamicInstanceState['values']): Readonly<Record<string, DynamicParameterValue>> => {
    const v = validateInstanceValues(door2Definition(), state(values));
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('fixture values must validate');
    return v.effective;
  };

  it('L8: exact key + assignment values match the row', () => {
    const effective = effectiveOf({
      width: { kind: 'distance', value: 8 },
      vis: { kind: 'visibility', value: 'Closed' },
      swing: { kind: 'angle', value: 0.5 },
    });
    expect(matchingLookupRow(preset, effective)).toBe('Narrow');
  });

  it('L8: a changed assignment value is Custom (undefined)', () => {
    const effective = effectiveOf({
      width: { kind: 'distance', value: 8 },
      vis: { kind: 'visibility', value: 'Closed' },
      swing: { kind: 'angle', value: 0.6 },
    });
    expect(matchingLookupRow(preset, effective)).toBeUndefined();
  });

  it('L8: numeric key values match within EVALUATION_TOLERANCE', () => {
    const effective = effectiveOf({
      width: { kind: 'distance', value: 8 + 5e-10 },
      vis: { kind: 'visibility', value: 'Closed' },
      swing: { kind: 'angle', value: 0.5 },
    });
    expect(matchingLookupRow(preset, effective)).toBe('Narrow');
  });

  it('L8: parameters a row does not assign do not affect its match', () => {
    // Wide assigns only vis; swing is unconstrained for Wide.
    const effective = effectiveOf({
      width: { kind: 'distance', value: 12 },
      vis: { kind: 'visibility', value: 'Open' },
      swing: { kind: 'angle', value: 0.3 },
      handed: { kind: 'flip', value: true },
    });
    expect(matchingLookupRow(preset, effective)).toBe('Wide');
    // And values matching no row at all are Custom.
    const none = effectiveOf({ width: { kind: 'distance', value: 10 } });
    expect(matchingLookupRow(preset, none)).toBeUndefined();
  });
});

// --- Malformed tables (L6) -----------------------------------------------------
describe('validateDefinition — lookup table rules (30.2b, design §2.5)', () => {
  it('L6: a row key value violating the target constraint is refused at definition time', () => {
    // Variant fixture: width is a list [8, 10, 12]; the key value 9 is not
    // reachable under it. (Design L6 phrases this as an "assignment width: 9";
    // width is an input, so its row value lives in the key — the §2.5 rule
    // covers key and assignment values identically.)
    const def = door2Definition({
      parameters: [
        widthParam({ constraint: { kind: 'list', values: [8, 10, 12] } }),
        swingParam(), handedParam(), visParam(),
        presetParam({
          rows: [
            { name: 'Odd', key: { width: { kind: 'distance', value: 9 } }, assignments: { vis: { kind: 'visibility', value: 'Closed' } } },
            { name: 'Wide', key: { width: { kind: 'distance', value: 12 } }, assignments: { vis: { kind: 'visibility', value: 'Open' } } },
          ],
        }),
      ],
    });
    expect(codesOf(def)).toContain('invalid-lookup-row');
    // …and evaluation of the malformed definition refuses 'invalid-definition'.
    const result = evaluateDynamicBlock(def, door2Entities(), door2Attributes(), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('invalid-definition');
      expect(result.refusal.definitionIssues?.some((i) => i.code === 'invalid-lookup-row')).toBe(true);
    }
  });

  it('L6: an assignment value violating its target constraint is refused (swing beyond its range)', () => {
    const def = withPreset(presetParam({
      rows: [
        { name: 'Narrow', key: { width: { kind: 'distance', value: 8 } }, assignments: { swing: { kind: 'angle', value: 2 } } },
        { name: 'Wide', key: { width: { kind: 'distance', value: 12 } }, assignments: {} },
      ],
    }));
    expect(codesOf(def)).toContain('invalid-lookup-row');
  });

  it('L6: an assignment naming a visibility state that does not exist is refused', () => {
    const def = withPreset(presetParam({
      rows: [
        { name: 'Narrow', key: { width: { kind: 'distance', value: 8 } }, assignments: { vis: { kind: 'visibility', value: 'Ajar' } } },
      ],
    }));
    expect(codesOf(def)).toContain('invalid-lookup-row');
  });

  it('L6: an assignment targeting the lookup itself is refused', () => {
    const def = withPreset(presetParam({
      rows: [
        { name: 'Narrow', key: { width: { kind: 'distance', value: 8 } }, assignments: { preset: { kind: 'lookup', value: 'Wide' } } },
        { name: 'Wide', key: { width: { kind: 'distance', value: 12 } }, assignments: {} },
      ],
    }));
    expect(codesOf(def)).toContain('invalid-lookup-row');
  });

  it('L6: an assignment targeting an input is refused (inputs are set through the key)', () => {
    const def = withPreset(presetParam({
      rows: [
        { name: 'Narrow', key: { width: { kind: 'distance', value: 8 } }, assignments: { width: { kind: 'distance', value: 9 } } },
      ],
    }));
    expect(codesOf(def)).toContain('invalid-lookup-row');
  });

  it('L6: a key missing an input, or naming an extra parameter, is refused', () => {
    const missing = withPreset(presetParam({
      rows: [{ name: 'Narrow', key: {}, assignments: {} }],
    }));
    expect(codesOf(missing)).toContain('invalid-lookup-row');
    const extra = withPreset(presetParam({
      rows: [{
        name: 'Narrow',
        key: { width: { kind: 'distance', value: 8 }, swing: { kind: 'angle', value: 0.5 } },
        assignments: {},
      }],
    }));
    expect(codesOf(extra)).toContain('invalid-lookup-row');
  });

  it('L6: a key value of the wrong kind for its input is refused', () => {
    const def = withPreset(presetParam({
      rows: [{ name: 'Narrow', key: { width: { kind: 'angle', value: 8 } }, assignments: {} }],
    }));
    expect(codesOf(def)).toContain('invalid-lookup-row');
  });

  it('L6: duplicate row names and duplicate key tuples are refused with their own codes', () => {
    const dupName = withPreset(presetParam({
      rows: [
        { name: 'Wide', key: { width: { kind: 'distance', value: 8 } }, assignments: {} },
        { name: 'Wide', key: { width: { kind: 'distance', value: 12 } }, assignments: {} },
      ],
    }));
    expect(codesOf(dupName)).toContain('duplicate-lookup-row');
    const dupKey = withPreset(presetParam({
      rows: [
        { name: 'A', key: { width: { kind: 'distance', value: 8 } }, assignments: {} },
        { name: 'B', key: { width: { kind: 'distance', value: 8 } }, assignments: { vis: { kind: 'visibility', value: 'Closed' } } },
      ],
    }));
    expect(codesOf(dupKey)).toContain('duplicate-lookup-key');
  });

  it('L6: empty rows, empty inputs and an unknown default row are table errors', () => {
    expect(codesOf(withPreset(presetParam({ rows: [] })))).toContain('invalid-lookup-table');
    expect(codesOf(withPreset(presetParam({ inputs: [] })))).toContain('invalid-lookup-table');
    expect(codesOf(withPreset(presetParam({ defaultRow: 'Huge' })))).toContain('invalid-lookup-table');
  });

  it('L6: inputs must be known modeled parameters — unknown, self and opaque inputs are refused', () => {
    expect(codesOf(withPreset(presetParam({ inputs: ['nope'] })))).toContain('invalid-lookup-input');
    expect(codesOf(withPreset(presetParam({ inputs: ['preset'] })))).toContain('invalid-lookup-input');
    const withOpaque = withParams([
      widthParam(), swingParam(), handedParam(), visParam(),
      { kind: 'opaque-parameter', id: 'op1', name: 'Opaque', sourceKind: 'future', payload: '{}' },
      presetParam({ inputs: ['op1'] }),
    ]);
    expect(codesOf(withOpaque)).toContain('invalid-lookup-input');
  });

  it('L6: a second lookup parameter is refused', () => {
    const def = withParams([
      widthParam(), swingParam(), handedParam(), visParam(),
      presetParam(),
      presetParam({ id: 'preset2', name: 'Preset 2' }),
    ]);
    expect(codesOf(def)).toContain('duplicate-lookup-parameter');
  });

  it('an action driven by the lookup parameter is a kind mismatch (a lookup drives no action)', () => {
    const def = door2Definition({
      actions: [{ kind: 'move', id: 'M1', name: 'Move', parameterId: 'preset', selection: [{ entityId: 'L1' }] }],
    });
    expect(codesOf(def)).toContain('parameter-kind-mismatch');
  });
});

// --- Serialization (design §6.2: v1 additive) ----------------------------------
describe('JCAD_DYNAMIC serialization — lookup (30.2b, model version stays 1)', () => {
  const base = { entityIdsInOrder: ['L1', 'L2', 'L3', 'L4'], attributeTags: new Set(['TAG']) };

  it('round-trips the lookup parameter; row values reuse the tagged encoding, keys sorted', () => {
    const def = door2Definition();
    const payload = encodeDynamicDefinition(def, base.entityIdsInOrder);
    expect(payload).toContain('"kind":"lookup"');
    expect(payload).toContain('"inputs":["width"]');
    expect(payload).toContain('"key":{"width":{"kind":"distance","value":8}}');
    // Assignment keys are written sorted by parameter id (swing < vis).
    expect(payload).toContain('"assignments":{"swing":{"kind":"angle","value":0.5},"vis":{"kind":"visibility","value":"Closed"}}');
    expect(payload).toContain('"defaultRow":null');
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.definition).toEqual(def);
  });

  it('round-trips a lookup instance choice (row name and explicit null)', () => {
    const chosen = state({ preset: { kind: 'lookup', value: 'Wide' }, width: { kind: 'distance', value: 8 } });
    const payload = encodeDynamicInstance(chosen);
    expect(payload).toContain('"preset":{"kind":"lookup","value":"Wide"}');
    const decoded = decodeDynamicInstance(payload, door2Definition(), 'DOOR2');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(chosen);

    const none = state({ preset: { kind: 'lookup', value: null } });
    const decodedNone = decodeDynamicInstance(encodeDynamicInstance(none), door2Definition(), 'DOOR2');
    expect(decodedNone.ok).toBe(true);
    if (decodedNone.ok) expect(decodedNone.state).toEqual(none);
  });

  it('an instance naming an unknown row is retained on decode, never modeled', () => {
    const payload = encodeDynamicInstance(state({ preset: { kind: 'lookup', value: 'Huge' } }));
    const decoded = decodeDynamicInstance(payload, door2Definition(), 'DOOR2');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('a definition whose table is malformed (row value out of constraint) is retained on decode, never half-modeled', () => {
    const bad = withPreset(presetParam({
      rows: [{ name: 'Narrow', key: { width: { kind: 'distance', value: 30 } }, assignments: {} }],
    }));
    const payload = encodeDynamicDefinition(bad, base.entityIdsInOrder);
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('an unknown member kind retains the whole payload (the fallback that protects lookup payloads on older builds)', () => {
    // §6.1: a build fails structural decode on ANY member kind it does not
    // know and retains the payload verbatim — exactly how a pre-30.2b build
    // treats a 'lookup' member. Pinned with the next slice's action kind.
    const payload = JSON.stringify({
      v: 1, kind: 'definition',
      parameters: [],
      actions: [{ kind: 'array', id: 'A1', name: 'Array', parameterId: 'width' }],
    });
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('a structurally incomplete lookup member retains the whole payload', () => {
    const payload = JSON.stringify({
      v: 1, kind: 'definition',
      parameters: [{ kind: 'lookup', id: 'preset', name: 'Preset' }],
      actions: [],
    });
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });
});
