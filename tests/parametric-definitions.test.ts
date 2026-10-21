import { describe, it, expect } from 'vitest';
import { sealImmutableData } from '../src/core/immutable-data';
import {
  validateDefinition,
  type DistanceConstraint,
  type DynamicBlockDefinition,
  type LinearDistanceParameter,
  type StretchAction,
} from '../src/core/parametric/definitions';
import { validateInstanceValues, type DynamicInstanceState } from '../src/core/parametric/instance';

const linearParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'width',
  name: 'Width',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'range', min: 5, max: 20 },
  grips: [
    { role: 'base', movesWithValue: false },
    { role: 'value', movesWithValue: true },
  ],
  ...over,
});

const baseAction = (): StretchAction => ({
  kind: 'stretch',
  id: 'S1',
  name: 'Stretch',
  parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
  selection: [{ entityId: 'L2', points: { kind: 'frame' } }],
});

const definition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [linearParam()],
  actions: [baseAction()],
  ...over,
});

const IDS = new Set(['L1', 'L2', 'L3', 'L4', 'TAG']);
const codes = (def: DynamicBlockDefinition): string[] => validateDefinition(def, IDS).map((i) => i.code);

describe('validateDefinition', () => {
  it('accepts the door definition', () => {
    expect(validateDefinition(definition(), IDS)).toEqual([]);
  });

  it('refuses duplicate parameter and action ids', () => {
    const dupParam = definition({ parameters: [linearParam(), linearParam()] });
    expect(codes(dupParam)).toContain('duplicate-parameter-id');
    const dupAction = definition({
      actions: [
        baseAction(),
        { ...baseAction(), name: 'Again' },
      ],
    });
    expect(codes(dupAction)).toContain('duplicate-action-id');
  });

  it('refuses an action referring to an unknown parameter', () => {
    const def = definition({
      actions: [{ ...baseAction(), parameterId: 'depth' }],
    });
    expect(codes(def)).toEqual(['unknown-parameter-ref']);
  });

  it('refuses a selection naming a missing entity', () => {
    const def = definition({
      actions: [
        {
          ...baseAction(),
          selection: [{ entityId: 'NOPE', points: { kind: 'frame' } }],
        },
      ],
    });
    expect(codes(def)).toEqual(['unknown-entity-ref']);
  });

  it('refuses zero and non-finite directions', () => {
    expect(codes(definition({ parameters: [linearParam({ direction: { x: 0, y: 0 } })] }))).toContain('invalid-direction');
    expect(codes(definition({ parameters: [linearParam({ direction: { x: NaN, y: 0 } })] }))).toContain('invalid-direction');
  });

  it('refuses degenerate constraints, without repairing them', () => {
    const withConstraint = (constraint: DistanceConstraint) => definition({ parameters: [linearParam({ constraint })] });
    expect(codes(withConstraint({ kind: 'range', min: 20, max: 5 }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'range' }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'range', min: NaN }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'increment', min: 5, max: 20, increment: 0 }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'increment', min: 20, max: 5, increment: 2 }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'list', values: [] }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'list', values: [10, 8] }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'list', values: [8, 8, 10] }))).toContain('invalid-constraint');
    expect(codes(withConstraint({ kind: 'list', values: [8, 10, 12] }))).toEqual([]);
    expect(codes(withConstraint({ kind: 'unbounded' }))).toEqual([]);
  });

  it('refuses an inverted or non-finite frame', () => {
    const withFrame = (min: { x: number; y: number }, max: { x: number; y: number }) =>
      definition({ actions: [{ ...baseAction(), frame: { kind: 'rectangle', min, max } }] });
    expect(codes(withFrame({ x: 15, y: -1 }, { x: 5, y: 6 }))).toContain('invalid-frame');
    expect(codes(withFrame({ x: 5, y: 6 }, { x: 15, y: -1 }))).toContain('invalid-frame');
    expect(codes(withFrame({ x: 5, y: -1 }, { x: Infinity, y: 6 }))).toContain('invalid-frame');
  });

  it('refuses non-positive or non-finite multipliers and angle offsets', () => {
    const withAction = (over: object) => definition({ actions: [{ ...baseAction(), ...over }] });
    expect(codes(withAction({ distanceMultiplier: 0 }))).toContain('invalid-multiplier');
    expect(codes(withAction({ distanceMultiplier: -2 }))).toContain('invalid-multiplier');
    expect(codes(withAction({ distanceMultiplier: NaN }))).toContain('invalid-multiplier');
    expect(codes(withAction({ distanceMultiplier: 2 }))).toEqual([]);
    expect(codes(withAction({ angleOffset: NaN }))).toContain('invalid-angle-offset');
  });

  it('refuses negative or non-integer explicit point indices', () => {
    const def = definition({
      actions: [
        {
          ...baseAction(),
          selection: [{ entityId: 'L2', points: { kind: 'points', indices: [-1, 0.5] } }],
        },
      ],
    });
    expect(codes(def).filter((c) => c === 'invalid-selection-index')).toHaveLength(2);
  });
});

describe('validateInstanceValues', () => {
  const state = (values: DynamicInstanceState['values'], block = 'DOOR'): DynamicInstanceState => ({ block, values });
  const dist = (value: number) => ({ kind: 'distance', value }) as const;

  it('treats a missing state as all defaults, filled into a fresh object', () => {
    const result = validateInstanceValues(definition(), undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective).toEqual({ width: { kind: 'distance', value: 10 } });
    const again = validateInstanceValues(definition(), undefined);
    if (!again.ok) throw new Error('expected ok');
    expect(again.effective).not.toBe(result.effective);
    expect(again.effective).toEqual(result.effective);
  });

  it('accepts a sparse in-range value and fills the rest with defaults', () => {
    const result = validateInstanceValues(definition(), state({ width: dist(14) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective['width']).toEqual({ kind: 'distance', value: 14 });
  });

  it('reports an out-of-range value instead of clamping it (acceptance case 4, validation half)', () => {
    const result = validateInstanceValues(definition(), state({ width: dist(25) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(['value-out-of-range']);
  });

  it('reports list and increment violations instead of snapping (acceptance case 5)', () => {
    const listDef = definition({ parameters: [linearParam({ constraint: { kind: 'list', values: [8, 10, 12] } })] });
    const listResult = validateInstanceValues(listDef, state({ width: dist(9) }));
    expect(listResult.ok).toBe(false);
    if (!listResult.ok) expect(listResult.issues.map((i) => i.code)).toEqual(['value-not-in-list']);
    expect(validateInstanceValues(listDef, state({ width: dist(12) })).ok).toBe(true);

    const incDef = definition({
      parameters: [linearParam({ constraint: { kind: 'increment', min: 5, max: 20, increment: 2.5 } })],
    });
    const incResult = validateInstanceValues(incDef, state({ width: dist(11) }));
    expect(incResult.ok).toBe(false);
    if (!incResult.ok) expect(incResult.issues.map((i) => i.code)).toEqual(['value-off-increment']);
    expect(validateInstanceValues(incDef, state({ width: dist(12.5) })).ok).toBe(true);
    expect(validateInstanceValues(incDef, state({ width: dist(20) })).ok).toBe(true);
    const incRange = validateInstanceValues(incDef, state({ width: dist(22.5) }));
    expect(incRange.ok).toBe(false);
    if (!incRange.ok) expect(incRange.issues.map((i) => i.code)).toEqual(['value-out-of-range']);
  });

  it('reports unknown parameters, wrong kinds and non-finite values (acceptance case 6, validation half)', () => {
    const unknown = validateInstanceValues(definition(), state({ depth: dist(3) }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.map((i) => i.code)).toEqual(['unknown-parameter']);

    const wrongKind = validateInstanceValues(definition(), state({ width: { kind: 'opaque', payload: 'x' } }));
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.issues.map((i) => i.code)).toEqual(['wrong-value-kind']);

    for (const bad of [NaN, Infinity, 'wide' as unknown as number]) {
      const nonFinite = validateInstanceValues(definition(), state({ width: dist(bad) }));
      expect(nonFinite.ok).toBe(false);
      if (!nonFinite.ok) expect(nonFinite.issues.map((i) => i.code)).toEqual(['non-finite-value']);
    }
  });

  it('checks the owning block name when the caller supplies it', () => {
    const mismatch = validateInstanceValues(definition(), state({ width: dist(14) }, 'OTHER'), 'DOOR');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.issues.map((i) => i.code)).toContain('block-mismatch');
    expect(validateInstanceValues(definition(), state({ width: dist(14) }, 'DOOR'), 'DOOR').ok).toBe(true);
    // Without a supplied block name there is nothing to mismatch against.
    expect(validateInstanceValues(definition(), state({ width: dist(14) }, 'OTHER')).ok).toBe(true);
  });

  it('rejects a negative value for an unbounded parameter', () => {
    const def = definition({ parameters: [linearParam({ constraint: { kind: 'unbounded' } })] });
    const result = validateInstanceValues(def, state({ width: dist(-1) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(['value-out-of-range']);
    expect(validateInstanceValues(def, state({ width: dist(10_000) })).ok).toBe(true);
  });

  it('gives an opaque parameter its payload as default and refuses a distance value for it', () => {
    const def = definition({
      parameters: [
        linearParam(),
        { kind: 'opaque-parameter', id: 'mode', name: 'Mode', sourceKind: 'lookup', payload: '{"row":1}' },
      ],
    });
    const result = validateInstanceValues(def, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective['mode']).toEqual({ kind: 'opaque', payload: '{"row":1}' });
    const wrong = validateInstanceValues(def, state({ mode: dist(3) }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues.map((i) => i.code)).toEqual(['wrong-value-kind']);
  });

  it('does not mutate a sealed input state', () => {
    const sealed = sealImmutableData(state({ width: dist(14) }));
    const result = validateInstanceValues(definition(), sealed);
    expect(result.ok).toBe(true);
    expect(sealed.values['width']).toEqual({ kind: 'distance', value: 14 });
  });
});
