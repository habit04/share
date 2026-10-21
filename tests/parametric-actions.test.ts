import { describe, it, expect } from 'vitest';
import { sealImmutableData } from '../src/core/immutable-data';
import type { Point } from '../src/core/geometry';
import type { AttributeDef, CircleEntity, Entity, InsertEntity, LineEntity, PolylineEntity } from '../src/core/entities';
import {
  validateDefinition,
  type AngleParameter,
  type DynamicBlockDefinition,
  type FlipParameter,
  type LinearDistanceParameter,
} from '../src/core/parametric/definitions';
import { validateInstanceValues, type DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock, DEFAULT_EVALUATION_LIMITS } from '../src/core/parametric/evaluate';
import {
  decodeDynamicDefinition,
  decodeDynamicInstance,
  encodeDynamicDefinition,
  encodeDynamicInstance,
} from '../src/io/dxf/dynamic-data';

// --- Fixtures ---------------------------------------------------------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'circle', center: { x: cx, y: cy }, radius: r,
});
const polyline = (id: string, pts: readonly (readonly [number, number])[]): PolylineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), closed: false,
});
const insert = (id: string, block: string, x: number, y: number, over: Partial<InsertEntity> = {}): InsertEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: {}, ...over,
});

/** The "panel" block: one of each shape the whole-entity actions exercise. */
const panelEntities = (): Entity[] => [
  line('L1', 0, 0, 4, 0),
  circle('C1', 10, 2, 3),
  polyline('PL', [[0, 5], [4, 5], [4, 8]]),
  insert('INS', 'SCREW', 2, 20),
];
const panelAttributes = (): AttributeDef[] => [
  { tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' },
];

const slideParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'slide',
  name: 'Slide',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'range', min: 0, max: 30 },
  grips: [{ role: 'value', movesWithValue: true }],
  ...over,
});

const swingParam = (over: Partial<AngleParameter> = {}): AngleParameter => ({
  kind: 'angle',
  id: 'swing',
  name: 'Swing',
  basePoint: { x: 0, y: 0 },
  defaultValue: 0,
  constraint: { kind: 'unbounded' },
  grips: [{ role: 'value', movesWithValue: false }],
  ...over,
});

const handedParam = (over: Partial<FlipParameter> = {}): FlipParameter => ({
  kind: 'flip',
  id: 'handed',
  name: 'Handed',
  basePoint: { x: 5, y: 0 },
  defaultValue: false,
  ...over,
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'PANEL', values });

const expectPoint = (p: Point, x: number, y: number): void => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};
const asLine = (e: Entity): LineEntity => e as LineEntity;
const asCircle = (e: Entity): CircleEntity => e as CircleEntity;
const asPolyline = (e: Entity): PolylineEntity => e as PolylineEntity;
const asInsert = (e: Entity): InsertEntity => e as InsertEntity;

// --- Move -------------------------------------------------------------------
describe('evaluateDynamicBlock — move action (30.2)', () => {
  const moveDef = (over: Record<string, unknown> = {}): DynamicBlockDefinition => ({
    version: 1,
    parameters: [slideParam()],
    actions: [{ kind: 'move', id: 'M1', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'L1' }], ...over }],
  });

  it('translates the selection whole by the parameter delta along its direction', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(moveDef(), base, [], state({ slide: { kind: 'distance', value: 16 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['M1']);
    expect(asLine(result.entities[0]!).a).toEqual({ x: 6, y: 0 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 10, y: 0 });
    // Everything not selected is returned by identity.
    expect(result.entities[1]).toBe(base[1]);
    expect(result.entities[2]).toBe(base[2]);
    expect(result.entities[3]).toBe(base[3]);
  });

  it('honours the distance multiplier and the angle offset', () => {
    const doubled = evaluateDynamicBlock(
      moveDef({ distanceMultiplier: 2 }), panelEntities(), [], state({ slide: { kind: 'distance', value: 16 } }),
    );
    expect(doubled.ok).toBe(true);
    if (doubled.ok) {
      expect(asLine(doubled.entities[0]!).a).toEqual({ x: 12, y: 0 });
      expect(asLine(doubled.entities[0]!).b).toEqual({ x: 16, y: 0 });
    }
    const turned = evaluateDynamicBlock(
      moveDef({ angleOffset: Math.PI / 2 }), panelEntities(), [], state({ slide: { kind: 'distance', value: 16 } }),
    );
    expect(turned.ok).toBe(true);
    if (turned.ok) {
      expectPoint(asLine(turned.entities[0]!).a, 0, 6);
      expectPoint(asLine(turned.entities[0]!).b, 4, 6);
    }
  });

  it('moves an attribute definition placement by tag, never its value', () => {
    const base = panelEntities();
    const attrs = panelAttributes();
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [slideParam()],
      actions: [{ kind: 'move', id: 'M1', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'TAG' }] }],
    };
    const moved = evaluateDynamicBlock(def, base, attrs, state({ slide: { kind: 'distance', value: 16 } }));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.attributes[0]!.position).toEqual({ x: 7, y: 1 });
    expect(moved.attributes[0]!.tag).toBe('TAG');
    expect(moved.attributes[0]!.default).toBe('D1');
    // No entity was selected, so every entity is returned by identity.
    moved.entities.forEach((e, i) => expect(e).toBe(base[i]));
  });

  it('at the default value is an identity no-op with an action-no-op diagnostic', () => {
    const base = panelEntities();
    for (const instance of [undefined, state({ slide: { kind: 'distance', value: 10 } })]) {
      const result = evaluateDynamicBlock(moveDef(), base, [], instance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      result.entities.forEach((e, i) => expect(e).toBe(base[i]));
      expect(result.appliedActions).toEqual(['M1']);
      expect(result.diagnostics.map((d) => d.code)).toContain('action-no-op');
    }
  });

  it('refuses when the work limit is exhausted', () => {
    const result = evaluateDynamicBlock(
      moveDef(), panelEntities(), [], state({ slide: { kind: 'distance', value: 16 } }),
      { ...DEFAULT_EVALUATION_LIMITS, maxWork: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('work-limit-exceeded');
  });
});

// --- Rotate -----------------------------------------------------------------
describe('evaluateDynamicBlock — rotate action (30.2)', () => {
  const rotateDef = (param: AngleParameter = swingParam()): DynamicBlockDefinition => ({
    version: 1,
    parameters: [param],
    actions: [{
      kind: 'rotate', id: 'R1', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 },
      selection: [{ entityId: 'L1' }, { entityId: 'C1' }],
    }],
  });

  it('rotates the selection about its centre by the angle delta, in radians', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(rotateDef(), base, [], state({ swing: { kind: 'angle', value: Math.PI / 2 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['R1']);
    expectPoint(asLine(result.entities[0]!).a, 0, 0);
    expectPoint(asLine(result.entities[0]!).b, 0, 4);
    const c = asCircle(result.entities[1]!);
    expect(c.type).toBe('circle');
    expectPoint(c.center, -2, 10);
    expect(c.radius).toBe(3);
    expect(result.entities[2]).toBe(base[2]);
    expect(result.entities[3]).toBe(base[3]);
  });

  it('rotates by the delta from a non-zero default, not the absolute value', () => {
    const param = swingParam({ defaultValue: Math.PI / 2, constraint: { kind: 'range', min: 0, max: Math.PI } });
    const result = evaluateDynamicBlock(rotateDef(param), panelEntities(), [], state({ swing: { kind: 'angle', value: Math.PI } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectPoint(asLine(result.entities[0]!).b, 0, 4);
  });

  it('at the default angle is an identity no-op', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(rotateDef(), base, [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.entities.forEach((e, i) => expect(e).toBe(base[i]));
    expect(result.diagnostics.map((d) => d.code)).toContain('action-no-op');
  });
});

// --- Scale ------------------------------------------------------------------
describe('evaluateDynamicBlock — uniform scale action (30.2)', () => {
  const scaleDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [slideParam()],
    actions: [{
      kind: 'scale', id: 'SC1', name: 'Scale', parameterId: 'slide', basePoint: { x: 0, y: 0 },
      selection: [{ entityId: 'C1' }, { entityId: 'L1' }],
    }],
  });

  it('scales uniformly about the base point: a circle stays a circle, radius scaled', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(scaleDef(), base, [], state({ slide: { kind: 'distance', value: 20 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = asCircle(result.entities[1]!);
    expect(c.type).toBe('circle');
    expect(c.center).toEqual({ x: 20, y: 4 });
    expect(c.radius).toBe(6);
    expect(asLine(result.entities[0]!).a).toEqual({ x: 0, y: 0 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 8, y: 0 });
    expect(result.entities[3]).toBe(base[3]);
  });

  it('refuses a zero effective value as a degenerate transform (factor 0)', () => {
    const result = evaluateDynamicBlock(scaleDef(), panelEntities(), [], state({ slide: { kind: 'distance', value: 0 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.actionId).toBe('SC1');
    }
  });

  it('at the default value the factor is 1: identity no-op', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(scaleDef(), base, [], state({ slide: { kind: 'distance', value: 10 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.entities.forEach((e, i) => expect(e).toBe(base[i]));
    expect(result.diagnostics.map((d) => d.code)).toContain('action-no-op');
  });
});

// --- Flip -------------------------------------------------------------------
describe('evaluateDynamicBlock — flip action (30.2)', () => {
  const flipDef = (param: FlipParameter = handedParam()): DynamicBlockDefinition => ({
    version: 1,
    parameters: [param],
    actions: [{
      kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed',
      axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 10 },
      selection: [{ entityId: 'PL' }, { entityId: 'INS' }],
    }],
  });

  it('mirrors a polyline across a vertical axis when the state differs from the default', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(flipDef(), base, [], state({ handed: { kind: 'flip', value: true } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asPolyline(result.entities[2]!).points).toEqual([{ x: 10, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 8 }]);
    expect(result.entities[0]).toBe(base[0]);
    expect(result.entities[1]).toBe(base[1]);
  });

  it('a nested insert member flips by toggling its mirror flag — no expansion', () => {
    const result = evaluateDynamicBlock(flipDef(), panelEntities(), [], state({ handed: { kind: 'flip', value: true } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ins = asInsert(result.entities[3]!);
    expect(ins.position).toEqual({ x: 8, y: 20 });
    expect(ins.mirror).toBe(true);
    expect(ins.block).toBe('SCREW');
  });

  it('flipping away from an authored mirrored default un-mirrors (involution)', () => {
    const entities: Entity[] = [
      polyline('PL', [[10, 5], [6, 5], [6, 8]]),
      insert('INS', 'SCREW', 8, 20, { mirror: true }),
    ];
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [handedParam({ defaultValue: true })],
      actions: [{
        kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed',
        axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 10 },
        selection: [{ entityId: 'PL' }, { entityId: 'INS' }],
      }],
    };
    const result = evaluateDynamicBlock(def, entities, [], state({ handed: { kind: 'flip', value: false } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asPolyline(result.entities[0]!).points).toEqual([{ x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 8 }]);
    const ins = asInsert(result.entities[1]!);
    expect(ins.position).toEqual({ x: 2, y: 20 });
    expect(ins.mirror).toBe(false);
  });

  it('at the default state is an identity no-op', () => {
    const base = panelEntities();
    for (const instance of [undefined, state({ handed: { kind: 'flip', value: false } })]) {
      const result = evaluateDynamicBlock(flipDef(), base, [], instance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      result.entities.forEach((e, i) => expect(e).toBe(base[i]));
      expect(result.diagnostics.map((d) => d.code)).toContain('action-no-op');
    }
  });

  it('does not mutate sealed inputs', () => {
    const def = sealImmutableData(flipDef());
    const base = sealImmutableData(panelEntities());
    const instance = sealImmutableData(state({ handed: { kind: 'flip', value: true } }));
    const result = evaluateDynamicBlock(def, base, [], instance);
    expect(result.ok).toBe(true);
    expect(asInsert(base[3]!).mirror).toBeUndefined();
    expect(asPolyline(base[2]!).points[0]).toEqual({ x: 0, y: 5 });
  });
});

// --- Composition ------------------------------------------------------------
describe('evaluateDynamicBlock — composition of stretch and whole actions (30.2)', () => {
  const doorEntities = (): Entity[] => [
    line('L1', 0, 0, 10, 0), line('L2', 10, 0, 10, 5), line('L3', 10, 5, 0, 5), line('L4', 0, 5, 0, 0),
  ];
  const composedDef = (reversed: boolean): DynamicBlockDefinition => {
    const stretch = {
      kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
      frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
      selection: [
        { entityId: 'L2', points: { kind: 'frame' } },
        { entityId: 'L1', points: { kind: 'frame' } },
        { entityId: 'L3', points: { kind: 'frame' } },
      ],
    } as const;
    const move = {
      kind: 'move', id: 'M1', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'L2' }],
    } as const;
    return {
      version: 1,
      parameters: [
        {
          kind: 'linear-distance', id: 'width', name: 'Width', basePoint: { x: 0, y: 0 },
          direction: { x: 1, y: 0 }, defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
          grips: [{ role: 'value', movesWithValue: true }],
        },
        slideParam(),
      ],
      actions: reversed ? [move, stretch] : [stretch, move],
    };
  };

  it('stretch runs before a move whose selection it governs, regardless of authoring order', () => {
    const instance = state({ width: { kind: 'distance', value: 14 }, slide: { kind: 'distance', value: 16 } });
    for (const reversed of [false, true]) {
      const result = evaluateDynamicBlock(composedDef(reversed), doorEntities(), [], instance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.appliedActions).toEqual(['S1', 'M1']);
      // L2: stretched to x=14 by S1, then translated +6 by M1.
      expect(asLine(result.entities[1]!).a).toEqual({ x: 20, y: 0 });
      expect(asLine(result.entities[1]!).b).toEqual({ x: 20, y: 5 });
      // L1: stretched only.
      expect(asLine(result.entities[0]!).b).toEqual({ x: 14, y: 0 });
    }
  });

  it('a cross-parameter grip cycle still refuses when whole actions are present', () => {
    const gripParam = (id: string, y: number): LinearDistanceParameter => ({
      kind: 'linear-distance', id, name: id, basePoint: { x: 0, y }, direction: { x: 1, y: 0 },
      defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
      grips: [{ role: 'value', movesWithValue: true }],
    });
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [gripParam('p', 0), gripParam('q', 100), swingParam()],
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
        {
          kind: 'rotate', id: 'R', name: 'R', parameterId: 'swing', center: { x: 0, y: 0 },
          selection: [{ entityId: 'LZ' }],
        },
      ],
    };
    const entities = [line('LA', 6, 100, 14, 100), line('LB', 6, 0, 14, 0), line('LZ', 100, 200, 110, 200)];
    const result = evaluateDynamicBlock(def, entities, [], undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('action-cycle');
      expect(result.refusal.cycle).toEqual(['A', 'B']);
    }
  });
});

// --- Instance validation for the new kinds ----------------------------------
describe('validateInstanceValues — angle and flip values (30.2)', () => {
  const def: DynamicBlockDefinition = {
    version: 1,
    parameters: [
      slideParam(),
      swingParam({ constraint: { kind: 'range', min: 0, max: Math.PI } }),
      handedParam(),
    ],
    actions: [],
  };
  const codes = (values: DynamicInstanceState['values']): string[] => {
    const v = validateInstanceValues(def, state(values));
    return v.ok ? [] : v.issues.map((i) => i.code);
  };

  it('fills angle and flip defaults into the effective values', () => {
    const v = validateInstanceValues(def, undefined);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.effective['swing']).toEqual({ kind: 'angle', value: 0 });
    expect(v.effective['handed']).toEqual({ kind: 'flip', value: false });
    expect(v.effective['slide']).toEqual({ kind: 'distance', value: 10 });
  });

  it('refuses values of the wrong kind for each parameter kind', () => {
    expect(codes({ swing: { kind: 'distance', value: 1 } })).toEqual(['wrong-value-kind']);
    expect(codes({ slide: { kind: 'angle', value: 1 } })).toEqual(['wrong-value-kind']);
    expect(codes({ handed: { kind: 'distance', value: 1 } })).toEqual(['wrong-value-kind']);
    expect(codes({ swing: { kind: 'flip', value: true } })).toEqual(['wrong-value-kind']);
    expect(codes({ handed: { kind: 'flip', value: 'yes' as unknown as boolean } })).toEqual(['wrong-value-kind']);
  });

  it('refuses non-finite and out-of-range angles, checked and never wrapped', () => {
    expect(codes({ swing: { kind: 'angle', value: Number.NaN } })).toEqual(['non-finite-value']);
    expect(codes({ swing: { kind: 'angle', value: 2 * Math.PI } })).toEqual(['value-out-of-range']);
    expect(codes({ swing: { kind: 'angle', value: -0.5 } })).toEqual(['value-out-of-range']);
    expect(codes({ swing: { kind: 'angle', value: Math.PI / 2 } })).toEqual([]);
  });
});

// --- Definition validation for the new kinds --------------------------------
describe('validateDefinition — 30.2 action/parameter rules', () => {
  const ids = new Set(['L1', 'C1', 'PL', 'INS']);
  const codesOf = (def: DynamicBlockDefinition): string[] => validateDefinition(def, ids).map((i) => i.code);

  it('accepts a fully valid 30.2 definition', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [slideParam(), swingParam(), handedParam()],
      actions: [
        { kind: 'move', id: 'M1', name: 'M', parameterId: 'slide', selection: [{ entityId: 'L1' }] },
        { kind: 'rotate', id: 'R1', name: 'R', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'C1' }] },
        { kind: 'scale', id: 'SC1', name: 'S', parameterId: 'slide', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'PL' }] },
        { kind: 'flip', id: 'F1', name: 'F', parameterId: 'handed', axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 10 }, selection: [{ entityId: 'INS' }] },
      ],
    };
    expect(validateDefinition(def, ids)).toEqual([]);
  });

  it('refuses a scale action whose driving parameter default is zero or negative', () => {
    for (const defaultValue of [0, -5]) {
      const def: DynamicBlockDefinition = {
        version: 1,
        parameters: [slideParam({ defaultValue, constraint: { kind: 'unbounded' } })],
        actions: [{ kind: 'scale', id: 'SC1', name: 'S', parameterId: 'slide', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'L1' }] }],
      };
      expect(codesOf(def)).toContain('invalid-scale-base');
    }
  });

  it('refuses non-finite action geometry and a degenerate flip axis', () => {
    const rotate: DynamicBlockDefinition = {
      version: 1,
      parameters: [swingParam()],
      actions: [{ kind: 'rotate', id: 'R1', name: 'R', parameterId: 'swing', center: { x: Number.NaN, y: 0 }, selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(rotate)).toContain('invalid-action-geometry');
    const scale: DynamicBlockDefinition = {
      version: 1,
      parameters: [slideParam()],
      actions: [{ kind: 'scale', id: 'SC1', name: 'S', parameterId: 'slide', basePoint: { x: 0, y: Number.POSITIVE_INFINITY }, selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(scale)).toContain('invalid-action-geometry');
    const flip: DynamicBlockDefinition = {
      version: 1,
      parameters: [handedParam()],
      actions: [{ kind: 'flip', id: 'F1', name: 'F', parameterId: 'handed', axisA: { x: 5, y: 5 }, axisB: { x: 5, y: 5 }, selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(flip)).toContain('invalid-action-geometry');
  });

  it('refuses actions driven by a parameter of the wrong kind', () => {
    const rotateByDistance: DynamicBlockDefinition = {
      version: 1,
      parameters: [slideParam()],
      actions: [{ kind: 'rotate', id: 'R1', name: 'R', parameterId: 'slide', center: { x: 0, y: 0 }, selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(rotateByDistance)).toContain('parameter-kind-mismatch');
    const flipByAngle: DynamicBlockDefinition = {
      version: 1,
      parameters: [swingParam()],
      actions: [{ kind: 'flip', id: 'F1', name: 'F', parameterId: 'swing', axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 10 }, selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(flipByAngle)).toContain('parameter-kind-mismatch');
    const moveByAngle: DynamicBlockDefinition = {
      version: 1,
      parameters: [swingParam()],
      actions: [{ kind: 'move', id: 'M1', name: 'M', parameterId: 'swing', selection: [{ entityId: 'L1' }] }],
    };
    expect(codesOf(moveByAngle)).toContain('parameter-kind-mismatch');
    const stretchByFlip: DynamicBlockDefinition = {
      version: 1,
      parameters: [handedParam()],
      actions: [{
        kind: 'stretch', id: 'S1', name: 'S', parameterId: 'handed',
        frame: { kind: 'rectangle', min: { x: 0, y: 0 }, max: { x: 9, y: 9 } },
        selection: [{ entityId: 'L1', points: { kind: 'frame' } }],
      }],
    };
    expect(codesOf(stretchByFlip)).toContain('parameter-kind-mismatch');
  });
});

// --- Serialization ------------------------------------------------------------
describe('JCAD_DYNAMIC serialization — 30.2 kinds (model version stays 1)', () => {
  const entityIds = ['L1', 'C1', 'PL', 'INS'];
  const fullDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [slideParam(), swingParam(), handedParam()],
    actions: [
      {
        kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'slide',
        frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
        selection: [{ entityId: 'L1', points: { kind: 'frame' } }],
      },
      { kind: 'move', id: 'M1', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'L1' }], distanceMultiplier: 2 },
      { kind: 'rotate', id: 'R1', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'C1' }] },
      { kind: 'scale', id: 'SC1', name: 'Scale', parameterId: 'slide', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'PL' }] },
      {
        kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed',
        axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 10 }, selection: [{ entityId: 'INS' }],
      },
    ],
  });

  it('round-trips every new parameter and action kind through encode/decode', () => {
    const def = fullDef();
    const decoded = decodeDynamicDefinition(encodeDynamicDefinition(def, entityIds), { entityIdsInOrder: entityIds });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.definition).toEqual(def);
  });

  it('round-trips angle and flip instance values', () => {
    const def = fullDef();
    const instance = state({
      slide: { kind: 'distance', value: 16 },
      swing: { kind: 'angle', value: Math.PI / 3 },
      handed: { kind: 'flip', value: true },
    });
    const decoded = decodeDynamicInstance(encodeDynamicInstance(instance), def, 'PANEL');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(instance);
  });

  it('a pre-30.2 v1 payload (linear + stretch only) still decodes, unchanged', () => {
    const legacy = '{"v":1,"kind":"definition","parameters":[{"kind":"linear-distance","id":"width","name":"Width","basePoint":{"x":0,"y":0},"direction":{"x":1,"y":0},"defaultValue":10,"constraint":{"kind":"range","min":5,"max":20},"grips":[{"role":"base","movesWithValue":false},{"role":"value","movesWithValue":true}]}],"actions":[{"kind":"stretch","id":"S1","name":"Stretch","parameterId":"width","frame":{"kind":"rectangle","min":{"x":5,"y":-1},"max":{"x":15,"y":6}},"selection":[{"entityId":"#1","points":{"kind":"frame"}}]}]}';
    const decoded = decodeDynamicDefinition(legacy, { entityIdsInOrder: ['L1', 'L2', 'L3', 'L4'] });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.definition.parameters[0]).toMatchObject({ kind: 'linear-distance', id: 'width', defaultValue: 10 });
    expect(decoded.definition.actions[0]).toMatchObject({ kind: 'stretch', id: 'S1', selection: [{ entityId: 'L2' }] });
  });

  it('an unknown action kind is retained, never half-modeled (the pre-30.2 fallback)', () => {
    const payload = JSON.stringify({
      v: 1, kind: 'definition', parameters: [],
      actions: [{ kind: 'visibility', id: 'V1', name: 'V', parameterId: 'swing' }],
    });
    const decoded = decodeDynamicDefinition(payload, { entityIdsInOrder: entityIds });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('an instance payload with a non-boolean flip value is retained', () => {
    const payload = '{"v":1,"kind":"instance","block":"PANEL","values":{"handed":{"kind":"flip","value":"yes"}}}';
    const decoded = decodeDynamicInstance(payload);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });
});
