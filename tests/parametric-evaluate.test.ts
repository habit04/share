import { describe, it, expect } from 'vitest';
import { sealImmutableData } from '../src/core/immutable-data';
import type { AttributeDef, Entity, HatchEntity, LineEntity, PolylineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition, LinearDistanceParameter, StretchAction } from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock, evaluationKey, DEFAULT_EVALUATION_LIMITS } from '../src/core/parametric/evaluate';

// --- The "door block" fixture from design §5 -------------------------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id,
  layer: '0',
  color: 'ByLayer',
  type: 'line',
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

const doorEntities = (): Entity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 5),
  line('L3', 10, 5, 0, 5),
  line('L4', 0, 5, 0, 0),
];

const doorAttributes = (): AttributeDef[] => [
  { tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' },
];

const widthParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
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

const stretch = (over: Partial<StretchAction> = {}): StretchAction => ({
  kind: 'stretch',
  id: 'S1',
  name: 'Stretch',
  parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
  selection: [
    { entityId: 'L2', points: { kind: 'frame' } },
    { entityId: 'L1', points: { kind: 'frame' } },
    { entityId: 'L3', points: { kind: 'frame' } },
  ],
  ...over,
});

const doorDefinition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam()],
  actions: [stretch()],
  ...over,
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'DOOR', values });
const atWidth = (value: number): DynamicInstanceState => state({ width: { kind: 'distance', value } });

const asLine = (e: Entity): LineEntity => e as LineEntity;

describe('evaluateDynamicBlock — door fixture (design §5)', () => {
  it('case 1: basic stretch moves only the framed points of selected entities', () => {
    const base = doorEntities();
    const result = evaluateDynamicBlock(doorDefinition(), base, doorAttributes(), atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S1']);
    expect(asLine(result.entities[0]!).a).toEqual({ x: 0, y: 0 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 14, y: 0 }); // L1
    expect(asLine(result.entities[1]!).a).toEqual({ x: 14, y: 0 }); // L2
    expect(asLine(result.entities[1]!).b).toEqual({ x: 14, y: 5 });
    expect(asLine(result.entities[2]!).a).toEqual({ x: 14, y: 5 }); // L3
    expect(asLine(result.entities[2]!).b).toEqual({ x: 0, y: 5 });
    expect(result.entities[3]).toBe(base[3]); // L4 untouched, by identity
    expect(result.entities[0]).not.toBe(base[0]);
  });

  it('case 2: default value is the authored geometry, returned by identity', () => {
    const base = doorEntities();
    const attrs = doorAttributes();
    for (const instance of [undefined, atWidth(10)]) {
      const result = evaluateDynamicBlock(doorDefinition(), base, attrs, instance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      result.entities.forEach((e, i) => expect(e).toBe(base[i]));
      result.attributes.forEach((a, i) => expect(a).toBe(attrs[i]));
      expect(result.diagnostics.map((d) => d.code)).toContain('zero-delta');
      expect(result.appliedActions).toEqual(['S1']);
    }
  });

  it('case 3: two instances of one definition evaluate independently', () => {
    const def = doorDefinition();
    const base = doorEntities();
    const wide = evaluateDynamicBlock(def, base, [], atWidth(14));
    const narrow = evaluateDynamicBlock(def, base, [], atWidth(7));
    expect(wide.ok && narrow.ok).toBe(true);
    if (!wide.ok || !narrow.ok) return;
    expect(asLine(wide.entities[1]!).a.x).toBe(14);
    expect(asLine(narrow.entities[1]!).a.x).toBe(7);
    // The shared base and definition were not touched by either evaluation.
    expect(asLine(base[1]!).a.x).toBe(10);
    expect(def.parameters[0]).toMatchObject({ id: 'width', defaultValue: 10 });
  });

  it('case 4 (evaluator half): an out-of-range edit refuses as invalid-instance', () => {
    const result = evaluateDynamicBlock(doorDefinition(), doorEntities(), [], atWidth(25));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('invalid-instance');
    expect(result.refusal.instanceIssues?.map((i) => i.code)).toEqual(['value-out-of-range']);
  });

  it('case 10: a stretch can move an attribute definition placement, never its value', () => {
    const def = doorDefinition({
      actions: [
        stretch({
          frame: { kind: 'rectangle', min: { x: 0, y: -1 }, max: { x: 15, y: 6 } },
          selection: [
            { entityId: 'L2', points: { kind: 'frame' } },
            { entityId: 'TAG', points: { kind: 'frame' } },
          ],
        }),
      ],
    });
    const attrs = doorAttributes();
    const result = evaluateDynamicBlock(def, doorEntities(), attrs, atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes[0]!.position).toEqual({ x: 5, y: 1 });
    expect(result.attributes[0]!.tag).toBe('TAG');
    expect(result.attributes[0]!.default).toBe('D1');
    expect(result.attributes[0]).not.toBe(attrs[0]);
  });

  it('case 10b: an attribute outside the frame keeps its placement by identity', () => {
    const def = doorDefinition({
      actions: [
        stretch({
          selection: [
            { entityId: 'L2', points: { kind: 'frame' } },
            { entityId: 'TAG', points: { kind: 'frame' } },
          ],
        }),
      ],
    });
    const attrs = doorAttributes();
    const result = evaluateDynamicBlock(def, doorEntities(), attrs, atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes[0]).toBe(attrs[0]); // TAG at (1,1) is outside frame x>=5
  });

  it('case 13: an opaque action is retained and evaluation refuses unsupported-action', () => {
    const def = doorDefinition({
      actions: [
        stretch(),
        { kind: 'opaque-action', id: 'V1', name: 'Visibility', parameterId: 'width', sourceKind: 'visibility', payload: '{"states":["A","B"]}' },
      ],
    });
    const result = evaluateDynamicBlock(def, doorEntities(), [], atWidth(14));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unsupported-action');
    expect(result.refusal.actionId).toBe('V1');
  });

  it('an opaque parameter refuses as unsupported-parameter', () => {
    const def = doorDefinition({
      parameters: [
        widthParam(),
        { kind: 'opaque-parameter', id: 'mode', name: 'Mode', sourceKind: 'lookup', payload: '{}' },
      ],
    });
    const result = evaluateDynamicBlock(def, doorEntities(), [], atWidth(14));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unsupported-parameter');
    expect(result.refusal.parameterId).toBe('mode');
  });

  it('case 14: exceeding the work limit refuses atomically with no partial result', () => {
    const many: PolylineEntity = {
      id: 'P1',
      layer: '0',
      color: 'ByLayer',
      type: 'polyline',
      closed: false,
      points: Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 })),
    };
    const def = doorDefinition({
      actions: [stretch({ selection: [{ entityId: 'P1', points: { kind: 'frame' } }] })],
    });
    const result = evaluateDynamicBlock(def, [many], [], atWidth(14), { ...DEFAULT_EVALUATION_LIMITS, maxWork: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('work-limit-exceeded');
  });

  it('refuses when the action count exceeds the limit', () => {
    const result = evaluateDynamicBlock(doorDefinition(), doorEntities(), [], atWidth(14), {
      ...DEFAULT_EVALUATION_LIMITS,
      maxActions: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('work-limit-exceeded');
  });

  it('case 15: degenerate definitions refuse with their specific codes', () => {
    const badDirection = evaluateDynamicBlock(
      doorDefinition({ parameters: [widthParam({ direction: { x: 0, y: 0 } })] }),
      doorEntities(), [], atWidth(14),
    );
    expect(badDirection.ok).toBe(false);
    if (!badDirection.ok) {
      expect(badDirection.refusal.code).toBe('invalid-definition');
      expect(badDirection.refusal.definitionIssues?.map((i) => i.code)).toContain('invalid-direction');
    }
    const badFrame = evaluateDynamicBlock(
      doorDefinition({ actions: [stretch({ frame: { kind: 'rectangle', min: { x: 15, y: -1 }, max: { x: 5, y: 6 } } })] }),
      doorEntities(), [], atWidth(14),
    );
    expect(badFrame.ok).toBe(false);
    if (!badFrame.ok) expect(badFrame.refusal.definitionIssues?.map((i) => i.code)).toContain('invalid-frame');

    const missing = evaluateDynamicBlock(
      doorDefinition({ actions: [stretch({ selection: [{ entityId: 'GHOST', points: { kind: 'frame' } }] })] }),
      doorEntities(), [], atWidth(14),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.definitionIssues?.map((i) => i.code)).toContain('unknown-entity-ref');

    const hatch: HatchEntity = {
      id: 'H1', layer: '0', color: 'ByLayer', type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, loops: [],
    };
    const hatchResult = evaluateDynamicBlock(
      doorDefinition({ actions: [stretch({ selection: [{ entityId: 'H1', points: { kind: 'frame' } }] })] }),
      [...doorEntities(), hatch], [], atWidth(14),
    );
    expect(hatchResult.ok).toBe(false);
    if (!hatchResult.ok) expect(hatchResult.refusal.code).toBe('unstretchable-entity');
  });

  it('case 16: sealed inputs are never mutated; repeated evaluation is deterministic', () => {
    const def = sealImmutableData(doorDefinition());
    const base = sealImmutableData(doorEntities());
    const attrs = sealImmutableData(doorAttributes());
    const instance = sealImmutableData(atWidth(14));
    const first = evaluateDynamicBlock(def, base, attrs, instance);
    const second = evaluateDynamicBlock(def, base, attrs, instance);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    // A refusing evaluation on sealed inputs also does not throw.
    const refused = evaluateDynamicBlock(def, base, attrs, sealImmutableData(atWidth(25)));
    expect(refused.ok).toBe(false);
    expect(base.map((e) => e.id)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(asLine(base[1]!).a).toEqual({ x: 10, y: 0 });
  });
});

describe('evaluateDynamicBlock — chaining (design §3.2)', () => {
  // p's grip is covered by B's frame, q's grip by A's frame: a cross-parameter cycle.
  const cycleDefinition = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      widthParam({ id: 'p', name: 'P', basePoint: { x: 0, y: 0 } }),
      widthParam({ id: 'q', name: 'Q', basePoint: { x: 0, y: 100 } }),
    ],
    actions: [
      {
        kind: 'stretch', id: 'A', name: 'A', parameterId: 'p',
        frame: { kind: 'rectangle', min: { x: 5, y: 90 }, max: { x: 15, y: 110 } },
        selection: [{ entityId: 'LA', points: { kind: 'frame' } }],
      },
      {
        kind: 'stretch', id: 'B', name: 'B', parameterId: 'q',
        frame: { kind: 'rectangle', min: { x: 5, y: -10 }, max: { x: 15, y: 10 } },
        selection: [{ entityId: 'LB', points: { kind: 'frame' } }],
      },
    ],
  });

  it('case 7: a cross-parameter grip cycle refuses with sorted cycle ids', () => {
    const entities = [line('LA', 6, 100, 14, 100), line('LB', 6, 0, 14, 0)];
    const result = evaluateDynamicBlock(cycleDefinition(), entities, [], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('action-cycle');
    expect(result.refusal.cycle).toEqual(['A', 'B']);
  });

  // S1 (width) moves LX into S2's (height) frame, and covers height's value grip.
  const chainDefinition = (reversed: boolean): DynamicBlockDefinition => {
    const s1: StretchAction = {
      kind: 'stretch', id: 'S1', name: 'Width stretch', parameterId: 'width',
      frame: { kind: 'rectangle', min: { x: 8, y: -1 }, max: { x: 16, y: 10 } },
      selection: [
        { entityId: 'LW', points: { kind: 'frame' } },
        { entityId: 'LX', points: { kind: 'frame' } },
      ],
    };
    const s2: StretchAction = {
      kind: 'stretch', id: 'S2', name: 'Height stretch', parameterId: 'height',
      frame: { kind: 'rectangle', min: { x: 13, y: 6 }, max: { x: 20, y: 10 } },
      selection: [{ entityId: 'LX', points: { kind: 'frame' } }],
    };
    return {
      version: 1,
      parameters: [
        widthParam(),
        {
          kind: 'linear-distance', id: 'height', name: 'Height',
          basePoint: { x: 12, y: 0 }, direction: { x: 0, y: 1 }, defaultValue: 5,
          constraint: { kind: 'range', min: 1, max: 20 },
          grips: [{ role: 'value', movesWithValue: true }],
        },
      ],
      actions: reversed ? [s2, s1] : [s1, s2],
    };
  };
  const chainEntities = (): Entity[] => [line('LW', 10, 0, 10, 4), line('LX', 10, 8, 12, 8)];
  const chainInstance = state({
    width: { kind: 'distance', value: 14 },
    height: { kind: 'distance', value: 8 },
  });

  it('case 8: chained actions apply in dependency order regardless of authoring order', () => {
    for (const reversed of [false, true]) {
      const result = evaluateDynamicBlock(chainDefinition(reversed), chainEntities(), [], chainInstance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.appliedActions).toEqual(['S1', 'S2']);
      // LX was moved +4 in x by S1 into S2's frame, then +3 in y by S2.
      const lx = asLine(result.entities[1]!);
      expect(lx.a).toEqual({ x: 14, y: 11 });
      expect(lx.b).toEqual({ x: 16, y: 11 });
      const lw = asLine(result.entities[0]!);
      expect(lw.a).toEqual({ x: 14, y: 0 });
      expect(lw.b).toEqual({ x: 14, y: 4 });
    }
  });

  it('refuses when the dependency chain exceeds the depth limit', () => {
    const param = (id: string, y: number): LinearDistanceParameter => ({
      kind: 'linear-distance', id, name: id, basePoint: { x: 0, y }, direction: { x: 1, y: 0 },
      defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
      grips: [{ role: 'value', movesWithValue: true }],
    });
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [param('pa', 0), param('pb', 50), param('pc', 100)],
      actions: [
        { kind: 'stretch', id: 'Sc', name: 'Sc', parameterId: 'pc', frame: { kind: 'rectangle', min: { x: 100, y: 100 }, max: { x: 110, y: 110 } }, selection: [{ entityId: 'Lc', points: { kind: 'frame' } }] },
        { kind: 'stretch', id: 'Sb', name: 'Sb', parameterId: 'pb', frame: { kind: 'rectangle', min: { x: 5, y: 90 }, max: { x: 15, y: 110 } }, selection: [{ entityId: 'Lb', points: { kind: 'frame' } }] },
        { kind: 'stretch', id: 'Sa', name: 'Sa', parameterId: 'pa', frame: { kind: 'rectangle', min: { x: 5, y: 40 }, max: { x: 15, y: 60 } }, selection: [{ entityId: 'La', points: { kind: 'frame' } }] },
      ],
    };
    const entities = [line('La', 6, 50, 14, 50), line('Lb', 6, 100, 14, 100), line('Lc', 102, 102, 108, 102)];
    const shallow = evaluateDynamicBlock(def, entities, [], undefined, { ...DEFAULT_EVALUATION_LIMITS, maxChainDepth: 2 });
    expect(shallow.ok).toBe(false);
    if (!shallow.ok) expect(shallow.refusal.code).toBe('chain-depth-exceeded');
    const full = evaluateDynamicBlock(def, entities, [], undefined);
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.appliedActions).toEqual(['Sa', 'Sb', 'Sc']);
  });
});

describe('evaluateDynamicBlock — stretch semantics per type', () => {
  it('honors explicit point indices: only listed points are candidates', () => {
    const def = doorDefinition({
      actions: [stretch({ selection: [{ entityId: 'L1', points: { kind: 'points', indices: [1] } }] })],
    });
    const result = evaluateDynamicBlock(def, doorEntities(), [], atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const l1 = asLine(result.entities[0]!);
    expect(l1.a).toEqual({ x: 0, y: 0 });
    expect(l1.b).toEqual({ x: 14, y: 0 });
  });

  it('refuses an out-of-range explicit point index', () => {
    const def = doorDefinition({
      actions: [stretch({ selection: [{ entityId: 'L1', points: { kind: 'points', indices: [7] } }] })],
    });
    const result = evaluateDynamicBlock(def, doorEntities(), [], atWidth(14));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unstretchable-entity');
  });

  it('keeps bulges unchanged on a stretched bulged polyline (keep-bulge rule)', () => {
    const poly: PolylineEntity = {
      id: 'P1', layer: '0', color: 'ByLayer', type: 'polyline', closed: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulges: [0.5],
    };
    const def = doorDefinition({
      actions: [stretch({
        frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 1 } },
        selection: [{ entityId: 'P1', points: { kind: 'frame' } }],
      })],
    });
    const result = evaluateDynamicBlock(def, [poly], [], atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0] as PolylineEntity;
    expect(out.points).toEqual([{ x: 0, y: 0 }, { x: 14, y: 0 }]);
    expect(out.bulges).toEqual([0.5]);
  });

  it('refuses a widthFrame polyline instead of desyncing its display frame', () => {
    const poly: PolylineEntity = {
      id: 'P1', layer: '0', color: 'ByLayer', type: 'polyline', closed: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], widths: [{ start: 1, end: 1 }],
      widthFrame: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], origin: { x: 0, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } },
    };
    const def = doorDefinition({
      actions: [stretch({ selection: [{ entityId: 'P1', points: { kind: 'frame' } }] })],
    });
    const result = evaluateDynamicBlock(def, [poly], [], atWidth(14));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unstretchable-entity');
  });

  it('moves an arc whole when its center is in the frame; refuses an endpoint-only contact', () => {
    const arc: Entity = {
      id: 'A1', layer: '0', color: 'ByLayer', type: 'arc',
      center: { x: 100, y: 100 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2,
    };
    const wholeDef = doorDefinition({
      actions: [stretch({
        frame: { kind: 'rectangle', min: { x: 95, y: 95 }, max: { x: 106, y: 106 } },
        selection: [{ entityId: 'A1', points: { kind: 'frame' } }],
      })],
    });
    const whole = evaluateDynamicBlock(wholeDef, [arc], [], atWidth(14));
    expect(whole.ok).toBe(true);
    if (whole.ok) expect((whole.entities[0] as { center: { x: number } }).center.x).toBe(104);

    const tipDef = doorDefinition({
      actions: [stretch({
        frame: { kind: 'rectangle', min: { x: 103, y: 90 }, max: { x: 107, y: 110 } },
        selection: [{ entityId: 'A1', points: { kind: 'frame' } }],
      })],
    });
    const tip = evaluateDynamicBlock(tipDef, [arc], [], atWidth(14));
    expect(tip.ok).toBe(false);
    if (!tip.ok) expect(tip.refusal.code).toBe('unstretchable-entity');
  });

  it('moves a nested insert whole by its position and leaves it otherwise intact', () => {
    const nested: Entity = {
      id: 'N1', layer: '0', color: 'ByLayer', type: 'insert', block: 'INNER',
      position: { x: 10, y: 2 }, rotation: 0, scale: 1, attributes: { TAG: 'X' },
    };
    const def = doorDefinition({
      actions: [stretch({ selection: [{ entityId: 'N1', points: { kind: 'frame' } }] })],
    });
    const result = evaluateDynamicBlock(def, [nested], [], atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0] as { position: { x: number; y: number }; attributes: Record<string, string> };
    expect(out.position).toEqual({ x: 14, y: 2 });
    expect(out.attributes).toEqual({ TAG: 'X' });
  });

  it('applies distance multiplier and angle offset to the delta', () => {
    const mult = evaluateDynamicBlock(
      doorDefinition({ actions: [stretch({ distanceMultiplier: 2 })] }),
      doorEntities(), [], atWidth(12), // raw delta 2, multiplied to 4
    );
    expect(mult.ok).toBe(true);
    if (mult.ok) expect(asLine(mult.entities[1]!).a).toEqual({ x: 14, y: 0 });

    const rotated = evaluateDynamicBlock(
      doorDefinition({ actions: [stretch({ angleOffset: Math.PI / 2 })] }),
      doorEntities(), [], atWidth(14), // delta (4,0) rotated to (0,4)
    );
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const l2 = asLine(rotated.entities[1]!);
    expect(l2.a.x).toBeCloseTo(10, 9);
    expect(l2.a.y).toBeCloseTo(4, 9);
  });

  it('reports frame-missed-selection when a non-zero action moves nothing', () => {
    const def = doorDefinition({
      actions: [stretch({
        frame: { kind: 'rectangle', min: { x: 500, y: 500 }, max: { x: 600, y: 600 } },
        selection: [{ entityId: 'L2', points: { kind: 'frame' } }],
      })],
    });
    const base = doorEntities();
    const result = evaluateDynamicBlock(def, base, [], atWidth(14));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('frame-missed-selection');
    result.entities.forEach((e, i) => expect(e).toBe(base[i]));
  });
});

describe('evaluationKey', () => {
  it('is stable across value-record key order and changes with values', () => {
    const def = doorDefinition({
      parameters: [widthParam(), widthParam({ id: 'height', name: 'Height', defaultValue: 5 })],
    });
    const a = evaluationKey(def, {
      width: { kind: 'distance', value: 14 },
      height: { kind: 'distance', value: 5 },
    });
    const b = evaluationKey(def, {
      height: { kind: 'distance', value: 5 },
      width: { kind: 'distance', value: 14 },
    });
    expect(a).toBe(b);
    const c = evaluationKey(def, {
      width: { kind: 'distance', value: 15 },
      height: { kind: 'distance', value: 5 },
    });
    expect(c).not.toBe(a);
  });
});
