/**
 * Priority 30.2d — chaining semantics, pinned (design
 * design-visibility-lookup-array.md §5 + §8 cases C1–C6).
 *
 * The settlement (§5.2/§5.3): dependency derivation is complete as
 * implemented. Both edge rules are stretch-sourced (the grip rule and the
 * selection-point rule); whole-entity actions (move/rotate/scale/flip/array)
 * SOURCE no edges, because their transforms are computed from a parameter
 * value and definition constants — there is no positional datum another
 * action could move — so they compose in authoring order, and that order is
 * value-independent. Angle and flip parameters have no grip position to
 * couple through (an angle grip has no defined radius; the flip axis lives
 * on the action, not the parameter), so they couple only as selection-point
 * SINKS. These tests pin that contract against the shipped evaluator; a
 * failure here is a finding about the evaluator, not a test to adjust.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import type { Entity, LineEntity } from '../src/core/entities';
import {
  type AngleParameter,
  type DynamicBlockDefinition,
  type FlipParameter,
  type LinearDistanceParameter,
  type LookupParameter,
} from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock, DEFAULT_EVALUATION_LIMITS } from '../src/core/parametric/evaluate';

// --- Factories (established style) -------------------------------------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const linearParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'p',
  name: 'P',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'range', min: 0, max: 30 },
  grips: [{ role: 'value', movesWithValue: true }],
  ...over,
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'CHAIN', values });
const asLine = (e: Entity): LineEntity => e as LineEntity;
const expectPoint = (p: { x: number; y: number }, x: number, y: number): void => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

// --- C1: whole→stretch order is authoring order -------------------------------
describe('chaining — C1: a whole action before/after a stretch is authoring order', () => {
  // Move M (param slide, +10 in x at value 20) translates E whole. Stretch S
  // (param width, +4 at value 14) has a frame covering E only AFTER the move:
  // E is authored at x 0..4, the frame starts at x 8. No edge can be derived
  // in either direction (M sources no edges; E's authored points and slide's
  // value grip — at (20,-10), off the frame's y band — are outside S's frame),
  // so the pair composes in authoring order and the two orders differ.
  const c1Definition = (moveFirst: boolean): DynamicBlockDefinition => {
    const move = {
      kind: 'move', id: 'M', name: 'Move', parameterId: 'slide',
      selection: [{ entityId: 'E' }],
    } as const;
    const stretch = {
      kind: 'stretch', id: 'S', name: 'Stretch', parameterId: 'width',
      frame: { kind: 'rectangle', min: { x: 8, y: -1 }, max: { x: 20, y: 1 } },
      selection: [{ entityId: 'E', points: { kind: 'frame' } }],
    } as const;
    return {
      version: 1,
      parameters: [
        linearParam({ id: 'slide', name: 'Slide', basePoint: { x: 0, y: -10 } }),
        linearParam({ id: 'width', name: 'Width' }),
      ],
      actions: moveFirst ? [move, stretch] : [stretch, move],
    };
  };
  const c1Instance = state({
    slide: { kind: 'distance', value: 20 },
    width: { kind: 'distance', value: 14 },
  });

  it('M first: E is moved into the frame, then stretched', () => {
    const result = evaluateDynamicBlock(c1Definition(true), [line('E', 0, 0, 4, 0)], [], c1Instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['M', 'S']);
    // (0,0)-(4,0) --move +10--> (10,0)-(14,0) --stretch +4--> (14,0)-(18,0)
    expect(asLine(result.entities[0]!).a).toEqual({ x: 14, y: 0 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 18, y: 0 });
  });

  it('S first: the frame misses E, which is then moved whole', () => {
    const result = evaluateDynamicBlock(c1Definition(false), [line('E', 0, 0, 4, 0)], [], c1Instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S', 'M']);
    expect(result.diagnostics.map((d) => d.code)).toContain('frame-missed-selection');
    // (0,0)-(4,0) --stretch: nothing in frame--> unchanged --move +10--> (10,0)-(14,0)
    expect(asLine(result.entities[0]!).a).toEqual({ x: 10, y: 0 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 14, y: 0 });
  });
});

// --- C2: value changes never reorder whole actions ----------------------------
describe('chaining — C2: whole-action order is value-independent', () => {
  const c2Definition = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'slide', name: 'Slide' }),
      {
        kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 },
        defaultValue: 0, constraint: { kind: 'unbounded' },
        grips: [{ role: 'value', movesWithValue: false }],
      } satisfies AngleParameter,
      linearParam({ id: 'grow', name: 'Grow' }),
      {
        kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 5, y: 0 }, defaultValue: false,
      } satisfies FlipParameter,
    ],
    actions: [
      { kind: 'move', id: 'M', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'L1' }] },
      { kind: 'rotate', id: 'R', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'L1' }] },
      { kind: 'scale', id: 'Sc', name: 'Scale', parameterId: 'grow', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'L1' }] },
      { kind: 'flip', id: 'F', name: 'Flip', parameterId: 'handed', axisA: { x: 0, y: 0 }, axisB: { x: 0, y: 1 }, selection: [{ entityId: 'L1' }] },
    ],
  });
  const entities = (): Entity[] => [line('L1', 1, 1, 4, 1)];

  it('the applied order is the authoring order at every value set', () => {
    const valueSets: DynamicInstanceState[] = [
      state({
        slide: { kind: 'distance', value: 20 }, swing: { kind: 'angle', value: 0.5 },
        grow: { kind: 'distance', value: 20 }, handed: { kind: 'flip', value: true },
      }),
      state({
        slide: { kind: 'distance', value: 13 }, swing: { kind: 'angle', value: -0.25 },
        grow: { kind: 'distance', value: 15 }, handed: { kind: 'flip', value: true },
      }),
      state({}), // everything at defaults: no-ops still apply in the same order
    ];
    for (const instance of valueSets) {
      const result = evaluateDynamicBlock(c2Definition(), entities(), [], instance);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.appliedActions).toEqual(['M', 'R', 'Sc', 'F']);
    }
  });
});

// --- C3: definition constants are not coupling data ---------------------------
describe('chaining — C3: a rotate centre inside a stretch frame is not moved by it', () => {
  // R is authored BEFORE S. S's selection covers the rotated entity E, so the
  // selection-point rule orders S first; but R's centre (12,2) — a definition
  // constant, not an entity — stays authored even though it lies inside S's
  // frame. Hand-computed composition (see below) discriminates the two.
  const c3Definition = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'width', name: 'Width' }),
      {
        kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 },
        defaultValue: 0, constraint: { kind: 'unbounded' },
        grips: [{ role: 'value', movesWithValue: false }],
      } satisfies AngleParameter,
    ],
    actions: [
      { kind: 'rotate', id: 'R', name: 'Rotate', parameterId: 'swing', center: { x: 12, y: 2 }, selection: [{ entityId: 'E' }] },
      {
        kind: 'stretch', id: 'S', name: 'Stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 8, y: -4 }, max: { x: 18, y: 6 } },
        selection: [{ entityId: 'E', points: { kind: 'frame' } }],
      },
    ],
  });

  it('S applies first (selection-point rule); R rotates about the authored centre', () => {
    const result = evaluateDynamicBlock(
      c3Definition(), [line('E', 10, 0, 14, 0)], [],
      state({ width: { kind: 'distance', value: 12 }, swing: { kind: 'angle', value: Math.PI / 2 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S', 'R']);
    // S: (10,0)-(14,0) +2 in x -> (12,0)-(16,0).
    // R about AUTHORED centre (12,2) by +90°: (12,0)->(14,2), (16,0)->(14,6).
    // (About a stretch-moved centre (14,2) the result would be (16,0)-(16,4).)
    const e = asLine(result.entities[0]!);
    expectPoint(e.a, 14, 2);
    expectPoint(e.b, 14, 6);
  });
});

// --- C4: grip coupling into a whole action (existing behavior, pinned) --------
describe('chaining — C4: a stretch covering a move parameter grip runs first', () => {
  // M is authored BEFORE S, but S's frame covers slide's value grip
  // (movesWithValue) at its effective position (16,0): the grip rule orders
  // S before M, exactly as in 30.1's stretch→stretch chaining.
  const c4Definition = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'slide', name: 'Slide' }),
      linearParam({ id: 'width', name: 'Width', basePoint: { x: 0, y: 50 } }),
    ],
    actions: [
      { kind: 'move', id: 'M', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'E' }] },
      {
        kind: 'stretch', id: 'S', name: 'Stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 12, y: -2 }, max: { x: 20, y: 2 } },
        selection: [{ entityId: 'W', points: { kind: 'frame' } }],
      },
    ],
  });

  it('appliedActions lists S before M (grip rule), and both effects land', () => {
    const entities: Entity[] = [line('E', 0, 10, 4, 10), line('W', 14, 1, 18, 1)];
    const result = evaluateDynamicBlock(
      c4Definition(), entities, [],
      state({ slide: { kind: 'distance', value: 16 }, width: { kind: 'distance', value: 12 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S', 'M']);
    // W stretched +2 by S; E moved +6 by M.
    expect(asLine(result.entities[1]!).a).toEqual({ x: 16, y: 1 });
    expect(asLine(result.entities[1]!).b).toEqual({ x: 20, y: 1 });
    expect(asLine(result.entities[0]!).a).toEqual({ x: 6, y: 10 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 10, y: 10 });
  });
});

// --- C5: flip axis is not moved by a stretch ----------------------------------
describe('chaining — C5: a flip mirrors across the authored axis', () => {
  // F's axis points (10,0) and (10,10) both lie inside S's frame — but an
  // axis is action data, not an entity, and actions never move action data.
  // S runs (it stretches its own selection G) and the flip still mirrors E
  // across the authored axis x = 10.
  const c5Definition = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      { kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 10, y: 0 }, defaultValue: false } satisfies FlipParameter,
      linearParam({ id: 'width', name: 'Width', basePoint: { x: 0, y: 50 } }),
    ],
    actions: [
      { kind: 'flip', id: 'F', name: 'Flip', parameterId: 'handed', axisA: { x: 10, y: 0 }, axisB: { x: 10, y: 10 }, selection: [{ entityId: 'E' }] },
      {
        kind: 'stretch', id: 'S', name: 'Stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 9, y: -1 }, max: { x: 15, y: 11 } },
        selection: [{ entityId: 'G', points: { kind: 'frame' } }],
      },
    ],
  });

  it('the flip uses the authored axis even with the stretch off default', () => {
    const entities: Entity[] = [line('E', 12, 2, 16, 2), line('G', 11, 8, 13, 8)];
    const result = evaluateDynamicBlock(
      c5Definition(), entities, [],
      state({ handed: { kind: 'flip', value: true }, width: { kind: 'distance', value: 12 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['F', 'S']);
    // E mirrored across x = 10: (12,2)->(8,2), (16,2)->(4,2).
    // (Across a stretch-shifted axis x = 12 it would be (12,2)->(12,2), (16,2)->(8,2).)
    expect(asLine(result.entities[0]!).a).toEqual({ x: 8, y: 2 });
    expect(asLine(result.entities[0]!).b).toEqual({ x: 4, y: 2 });
    // S still stretched its own selection by +2.
    expect(asLine(result.entities[1]!).a).toEqual({ x: 13, y: 8 });
    expect(asLine(result.entities[1]!).b).toEqual({ x: 15, y: 8 });
  });
});

// --- Angle grips: nothing to couple -------------------------------------------
describe('chaining — angle/flip grips create no coupling (§5.3)', () => {
  // The angle parameter's basePoint (10,0) lies inside S's frame and its
  // value grip is even flagged movesWithValue — but an angle grip has no
  // defined radius, hence no position, hence no grip edge: R and S compose
  // in authoring order. (Had an edge R→S been derived, S would run first.)
  const def = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      {
        kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 10, y: 0 },
        defaultValue: 0, constraint: { kind: 'unbounded' },
        grips: [{ role: 'value', movesWithValue: true }],
      } satisfies AngleParameter,
      linearParam({ id: 'width', name: 'Width', basePoint: { x: 0, y: 50 } }),
    ],
    actions: [
      { kind: 'rotate', id: 'R', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'E' }] },
      {
        kind: 'stretch', id: 'S', name: 'Stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 5, y: -5 }, max: { x: 15, y: 5 } },
        selection: [{ entityId: 'G', points: { kind: 'frame' } }],
      },
    ],
  });

  it('authoring order stands: R before S', () => {
    const entities: Entity[] = [line('E', 20, 0, 24, 0), line('G', 6, 1, 9, 1)];
    const result = evaluateDynamicBlock(
      def(), entities, [],
      state({ swing: { kind: 'angle', value: Math.PI / 2 }, width: { kind: 'distance', value: 14 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['R', 'S']);
    // E rotated +90° about the origin; G stretched +4 in x.
    const e = asLine(result.entities[0]!);
    expectPoint(e.a, 0, 20);
    expectPoint(e.b, 0, 24);
    expect(asLine(result.entities[1]!).a).toEqual({ x: 10, y: 1 });
    expect(asLine(result.entities[1]!).b).toEqual({ x: 13, y: 1 });
  });
});

// --- Chain depth with mixed action kinds ---------------------------------------
describe('chaining — chain depth is computed over the derived graph, whole sinks included', () => {
  // A pure grip chain Sa -> Sb -> Mc: each stretch's frame covers the next
  // parameter's value grip (at its effective position), and the last sink is
  // a whole action (move), which extends the dependency path exactly like a
  // stretch sink does (§5.4 rule 4). Authored in reverse to prove the order
  // is derived, not authored.
  const def = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'pa', name: 'PA', basePoint: { x: 0, y: 0 } }),
      linearParam({ id: 'pb', name: 'PB', basePoint: { x: 0, y: 100 } }),
      linearParam({ id: 'pc', name: 'PC', basePoint: { x: 0, y: 200 } }),
    ],
    actions: [
      { kind: 'move', id: 'Mc', name: 'Move', parameterId: 'pc', selection: [{ entityId: 'LM' }] },
      {
        kind: 'stretch', id: 'Sb', name: 'Sb', parameterId: 'pb',
        frame: { kind: 'rectangle', min: { x: 5, y: 190 }, max: { x: 15, y: 210 } },
        selection: [{ entityId: 'Lb', points: { kind: 'frame' } }],
      },
      {
        kind: 'stretch', id: 'Sa', name: 'Sa', parameterId: 'pa',
        frame: { kind: 'rectangle', min: { x: 5, y: 90 }, max: { x: 15, y: 110 } },
        selection: [{ entityId: 'La', points: { kind: 'frame' } }],
      },
    ],
  });
  const entities = (): Entity[] => [
    line('La', 6, 100, 14, 100),
    line('Lb', 6, 200, 14, 200),
    line('LM', 0, 300, 4, 300),
  ];
  const instance = state({
    pa: { kind: 'distance', value: 14 },
    pb: { kind: 'distance', value: 14 },
    pc: { kind: 'distance', value: 14 },
  });

  it('orders the chain Sa, Sb, Mc under the default limits', () => {
    const result = evaluateDynamicBlock(def(), entities(), [], instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['Sa', 'Sb', 'Mc']);
    // Each link moved its selection +4 in x.
    expect(asLine(result.entities[0]!).a).toEqual({ x: 10, y: 100 });
    expect(asLine(result.entities[1]!).a).toEqual({ x: 10, y: 200 });
    expect(asLine(result.entities[2]!).a).toEqual({ x: 4, y: 300 });
  });

  it('refuses chain-depth-exceeded when the mixed chain exceeds the depth limit', () => {
    const shallow = evaluateDynamicBlock(def(), entities(), [], instance, { ...DEFAULT_EVALUATION_LIMITS, maxChainDepth: 2 });
    expect(shallow.ok).toBe(false);
    if (!shallow.ok) expect(shallow.refusal.code).toBe('chain-depth-exceeded');
  });
});

// --- C6: cycle refusal set composition -----------------------------------------
describe('chaining — C6: the cycle refusal lists the cycle plus its dependents', () => {
  // Stretches A and B form a cross-parameter grip cycle (30.1 case 7: A's
  // frame covers q's grip, B's frame covers p's grip). Move M's parameter r
  // has its value grip at (8,0), covered by B's frame, so M depends on B and
  // is unorderable too: the refusal lists all three, sorted (§5.4 rule 3).
  const def = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'p', name: 'P', basePoint: { x: 0, y: 0 } }),
      linearParam({ id: 'q', name: 'Q', basePoint: { x: 0, y: 100 } }),
      linearParam({ id: 'r', name: 'R', basePoint: { x: 2, y: 0 }, defaultValue: 6 }),
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
      { kind: 'move', id: 'M', name: 'Move', parameterId: 'r', selection: [{ entityId: 'LM' }] },
    ],
  });

  it("refuses 'action-cycle' with cycle = ['A', 'B', 'M']", () => {
    const entities: Entity[] = [
      line('LA', 6, 100, 14, 100),
      line('LB', 6, 0, 14, 0),
      line('LM', 0, 300, 4, 300),
    ];
    const result = evaluateDynamicBlock(def(), entities, [], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('action-cycle');
    expect(result.refusal.cycle).toEqual(['A', 'B', 'M']);
  });
});

// --- Lookup override participates in chaining ----------------------------------
describe('chaining — a lookup row value drives a chained stretch', () => {
  // The 30.1 chain fixture (case 8): S1 (width) moves LX into S2's (height)
  // frame and covers height's value grip, so S2 runs after S1 in either
  // authoring order. Here NEITHER value is stored directly: the lookup row
  // 'Tall' sets width through its key and height through its assignments,
  // and the override (finalEffective) is what grip derivation and the
  // stretches read — the chain behaves exactly as with direct values.
  const def = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [
      linearParam({ id: 'width', name: 'Width', constraint: { kind: 'range', min: 5, max: 20 } }),
      {
        kind: 'linear-distance', id: 'height', name: 'Height',
        basePoint: { x: 12, y: 0 }, direction: { x: 0, y: 1 }, defaultValue: 5,
        constraint: { kind: 'range', min: 1, max: 20 },
        grips: [{ role: 'value', movesWithValue: true }],
      } satisfies LinearDistanceParameter,
      {
        kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 20 },
        inputs: ['width'], defaultRow: null,
        rows: [{
          name: 'Tall',
          key: { width: { kind: 'distance', value: 14 } },
          assignments: { height: { kind: 'distance', value: 8 } },
        }],
      } satisfies LookupParameter,
    ],
    actions: [
      {
        kind: 'stretch', id: 'S2', name: 'Height stretch', parameterId: 'height',
        frame: { kind: 'rectangle', min: { x: 13, y: 6 }, max: { x: 20, y: 10 } },
        selection: [{ entityId: 'LX', points: { kind: 'frame' } }],
      },
      {
        kind: 'stretch', id: 'S1', name: 'Width stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 8, y: -1 }, max: { x: 16, y: 10 } },
        selection: [
          { entityId: 'LW', points: { kind: 'frame' } },
          { entityId: 'LX', points: { kind: 'frame' } },
        ],
      },
    ],
  });
  const entities = (): Entity[] => [line('LW', 10, 0, 10, 4), line('LX', 10, 8, 12, 8)];

  it('the row-set values produce the chained result (authored S2 first)', () => {
    const result = evaluateDynamicBlock(
      def(), entities(), [], state({ preset: { kind: 'lookup', value: 'Tall' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('lookup-applied');
    expect(result.appliedActions).toEqual(['S1', 'S2']);
    // As 30.1 case 8 with direct values width 14 / height 8: LX was moved
    // +4 in x by S1 into S2's frame, then +3 in y by S2.
    const lx = asLine(result.entities[1]!);
    expect(lx.a).toEqual({ x: 14, y: 11 });
    expect(lx.b).toEqual({ x: 16, y: 11 });
    const lw = asLine(result.entities[0]!);
    expect(lw.a).toEqual({ x: 14, y: 0 });
    expect(lw.b).toEqual({ x: 14, y: 4 });
  });

  it('control: with no row chosen, the defaults leave the chain unmoved', () => {
    const result = evaluateDynamicBlock(def(), entities(), [], state({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S1', 'S2']);
    const lx = asLine(result.entities[1]!);
    expect(lx.a).toEqual({ x: 10, y: 8 });
    expect(lx.b).toEqual({ x: 12, y: 8 });
  });
});
