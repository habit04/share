/**
 * Review round 3, C06 static cost note — the C06 derived-output
 * finiteness validation must itself be bounded. The original walk was
 * recursive and unaccounted: it rescanned sub-objects shared between
 * derived entries once per referencing entry (an array copy shares
 * its source's dynamic state by reference, so N copies rescanned the
 * same state N times), with no sharing, depth or work accounting.
 * The walk is now iterative, sharing-aware (an identity set spans the
 * whole pass), depth-bounded by MAX_FINITE_WALK_DEPTH and charged
 * into the evaluation's existing work budget at 1 per unique
 * container node. These tests pin the bounded behaviour:
 *  - shared structure is charged once, proved by budget titration (a
 *    limit a per-copy rescan would blow by an order of magnitude);
 *  - a maximal evaluation at the output-entity cap still succeeds
 *    under the default budget;
 *  - pathological depth terminates in a clean 'work-limit-exceeded'
 *    refusal instead of unbounded recursion, while within-bound depth
 *    is still fully checked (a non-finite leaf at depth refuses
 *    'degenerate-transform', exactly as before);
 *  - a reference cycle terminates (identity set) and succeeds.
 * Non-finite refusal behaviour itself is pinned by
 * parametric-review-c06-finite.test.ts and is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { InsertEntity, LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition, LinearDistanceParameter } from '../src/core/parametric/definitions';
import type { DynamicInstanceState, DynamicParameterValue } from '../src/core/parametric/instance';
import {
  DEFAULT_EVALUATION_LIMITS,
  MAX_EVALUATION_OUTPUT_ENTITIES,
  evaluateDynamicBlock,
} from '../src/core/parametric/evaluate';

const spanParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'span',
  name: 'Span',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'unbounded' },
  grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
  ...over,
});

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const arrayDef = (entityId: string, spacing = 1): DynamicBlockDefinition => ({
  version: 1,
  parameters: [spanParam()],
  actions: [{ kind: 'array', id: 'ARR', name: 'Array', parameterId: 'span', spacing, selection: [{ entityId }] }],
});

const spanState = (block: string, v: number): DynamicInstanceState => ({
  block, values: { span: { kind: 'distance', value: v } },
});

describe('C06 bounded walk: shared structure is walked and charged once', () => {
  // A nested insert member carrying a dynamic state with 400 stored
  // values. Array copies share the source's dynamic state object by
  // reference (design §3.4), so a per-copy rescan would walk those
  // ~402 container nodes once per copy (~121k node visits for 300
  // copies); the sharing-aware walk visits them once (~1.0k walk
  // charges total, ~1.6k including step 7's per-copy charges).
  const SHARED_VALUES = 400;
  const COPIES = 300;
  const sharedState = (): DynamicInstanceState => {
    const values: Record<string, DynamicParameterValue> = {};
    for (let i = 0; i < SHARED_VALUES; i += 1) values[`p${i}`] = { kind: 'distance', value: i };
    return { block: 'NESTED', values };
  };
  const member = (): InsertEntity => ({
    id: 'MEMBER', type: 'insert', layer: '0', color: 'ByLayer', block: 'NESTED',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, dynamic: sharedState(),
  });

  it('arraying an insert over a large shared state succeeds under a titrated work limit', () => {
    const result = evaluateDynamicBlock(
      arrayDef('MEMBER'),
      [member()],
      [],
      spanState('PANEL', COPIES - 1),
      { ...DEFAULT_EVALUATION_LIMITS, maxWork: 10_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(COPIES);
    // The copies really do share the one state object (the premise of
    // the titration): copy 1's dynamic state IS the source's.
    const source = result.entities[0] as InsertEntity;
    const copy = result.entities[1] as InsertEntity;
    expect(copy.dynamic).toBe(source.dynamic);
  });

  it('the walk accounting is real: a limit below the sharing-aware cost refuses work-limit-exceeded', () => {
    // Step 7 alone charges ~2 per copy (598); the sharing-aware walk
    // brings the total to ~1.6k, so 1,200 refuses — while a walk that
    // charged nothing would still succeed here, and one that rescanned
    // per copy would need ~121k (see the 10,000 success above).
    const result = evaluateDynamicBlock(
      arrayDef('MEMBER'),
      [member()],
      [],
      spanState('PANEL', COPIES - 1),
      { ...DEFAULT_EVALUATION_LIMITS, maxWork: 1_200 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('work-limit-exceeded');
  });
});

describe('C06 bounded walk: maximal evaluations still fit the default budget', () => {
  it('an array producing exactly the output-entity cap succeeds with default limits', () => {
    const cap = MAX_EVALUATION_OUTPUT_ENTITIES;
    const result = evaluateDynamicBlock(
      arrayDef('line'),
      [line('line', 0, 0, 0, 5)],
      [],
      spanState('PANEL', cap - 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entities).toHaveLength(cap);
  });
});

describe('C06 bounded walk: pathological structures terminate under the bounds', () => {
  const stretchDef = (): DynamicBlockDefinition => ({
    version: 1,
    parameters: [spanParam({ id: 'width', name: 'Width' })],
    actions: [{
      kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width',
      frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
      selection: [{ entityId: 'line', points: { kind: 'frame' } }],
    }],
  });
  const widthState = (v: number): DynamicInstanceState => ({
    block: 'B', values: { width: { kind: 'distance', value: v } },
  });
  // Entities are plain data; a programmatic caller can attach structure
  // deeper than the data model admits. The walk must terminate cleanly.
  const chain = (depth: number, leaf: number): unknown => {
    let o: unknown = { leaf };
    for (let i = 0; i < depth; i += 1) o = { next: o };
    return o;
  };
  const lineWith = (nested: unknown): LineEntity =>
    ({ ...line('line', 0, 0, 10, 0), nested } as unknown as LineEntity);

  it('a 100,000-deep chain refuses work-limit-exceeded (no stack overflow, no hang)', () => {
    const result = evaluateDynamicBlock(stretchDef(), [lineWith(chain(100_000, 1))], [], widthState(14));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('work-limit-exceeded');
  });

  it('a within-bound deep chain of finite numbers succeeds', () => {
    const result = evaluateDynamicBlock(stretchDef(), [lineWith(chain(20, 1))], [], widthState(14));
    expect(result.ok).toBe(true);
  });

  it('a non-finite leaf within the depth bound still refuses degenerate-transform', () => {
    const result = evaluateDynamicBlock(stretchDef(), [lineWith(chain(20, Infinity))], [], widthState(14));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.message).toContain('line');
    }
  });

  it('a reference cycle terminates and succeeds when its numbers are finite', () => {
    const cyclic: Record<string, unknown> = { v: 1 };
    cyclic.self = cyclic;
    const result = evaluateDynamicBlock(stretchDef(), [lineWith(cyclic)], [], widthState(14));
    expect(result.ok).toBe(true);
  });
});
