/**
 * Review round 5, R4-03 (static + tiny observations) — round 4 moved
 * the finiteness walk's fan-out charge BEFORE the record's VALUES were
 * enumerated, but the charge's size still came from
 * `Object.keys(value).length`, and Object.keys itself allocates the
 * full key array: every key of a record was materialized before the
 * charge could refuse. Tiny witnesses (8- vs 16-field records) observe
 * that defect; they are not, by themselves, the fixed property.
 *
 * The walk now expands a record through a resumable frame that
 * produces keys one at a time (Object.keys order and membership) and
 * charges each slot as it is scheduled, holding at most one
 * unconsumed lookahead key. These tests pin the FIXED properties:
 *  - under the first budget that reaches a 16-field record's
 *    expansion, the walk refuses on work having consumed only the
 *    lookahead key's worth of per-key work — observed through a
 *    Proxy's getOwnPropertyDescriptor trap, which Object.keys would
 *    have driven once per key (16) before any charge;
 *  - the per-slot accounting is unchanged: the minimum admitting
 *    budget for a 16-field record still exceeds the 8-field minimum
 *    by exactly the extra slots x FINITE_WALK_NODE_WEIGHT, so a
 *    separating budget exists (the totals round 4 pinned survive —
 *    only the record charge's granularity moved);
 *  - the success path still enumerates every key, and a non-finite
 *    value inside the record still refuses 'degenerate-transform'.
 * No weight or cap changed: FINITE_WALK_NODE_WEIGHT stays 0.5 and the
 * default budget stays 100,000.
 */
import { describe, expect, it } from 'vitest';
import type { LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition, LinearDistanceParameter } from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import {
  DEFAULT_EVALUATION_LIMITS,
  FINITE_WALK_NODE_WEIGHT,
  evaluateDynamicBlock,
  type EvaluationLimits,
  type EvaluationResult,
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

const stretchDef: DynamicBlockDefinition = {
  version: 1,
  parameters: [spanParam({ id: 'width', name: 'Width' })],
  actions: [{
    kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'line', points: { kind: 'frame' } }],
  }],
};

const widthState = (v: number): DynamicInstanceState => ({
  block: 'B', values: { width: { kind: 'distance', value: v } },
});

const line = (id: string): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
});

// Entities are plain data; a caller can attach a record. The stretch
// derives the line, so step 7.5 walks the copy and its record — the
// record is the line's LAST key, so its expansion is the last
// fan-out the walk reaches.
const lineWithRecord = (record: Record<string, unknown>): LineEntity =>
  ({ ...line('line'), nested: record } as unknown as LineEntity);

const plainRecord = (fields: number): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  for (let i = 0; i < fields; i += 1) record[`k${i}`] = i;
  return record;
};

describe('R4-03: record keys are produced incrementally, charged as scheduled', () => {
  // A 16-field record behind a Proxy that counts per-key descriptor
  // work. Object.keys drives getOwnPropertyDescriptor once per key
  // (16 calls) before returning; incremental enumeration drives it
  // only for the keys actually produced (the engine's enumeration
  // step plus the own-enumerable check: 2 calls per produced key).
  const makeProxyRun = () => {
    let descriptorCalls = 0;
    const target = plainRecord(16);
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(t, p) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
    });
    return {
      calls: () => descriptorCalls,
      run: (limits: EvaluationLimits): EvaluationResult =>
        evaluateDynamicBlock(stretchDef, [lineWithRecord(proxy)], [], widthState(14), limits),
    };
  };

  it('the first budget reaching the record refuses having produced only the lookahead key', () => {
    // Scan upward for the first budget at which the walk reaches the
    // record's expansion at all (descriptor work becomes observable).
    // Charges are half-unit granular and the record's subtree is the
    // last work of the walk, so at that budget less than one slot of
    // headroom remains: the walk must refuse on the record's first
    // slot charge, having produced only its lookahead key.
    let firstReach = -1;
    let callsAtFirstReach = 0;
    let resultAtFirstReach: EvaluationResult | undefined;
    for (let budget = 0; budget <= 4_000; budget += 1) {
      const attempt = makeProxyRun();
      const result = attempt.run({ ...DEFAULT_EVALUATION_LIMITS, maxWork: budget });
      if (attempt.calls() > 0) {
        firstReach = budget;
        callsAtFirstReach = attempt.calls();
        resultAtFirstReach = result;
        break;
      }
    }
    expect(firstReach).toBeGreaterThanOrEqual(0);
    // Bounded: only the lookahead key was produced (2 descriptor
    // calls per produced key in this runtime, asserted with slack).
    // Object.keys would have driven all 16 before any charge.
    expect(callsAtFirstReach).toBeLessThanOrEqual(6);
    expect(callsAtFirstReach).toBeLessThan(16);
    // And the refusal at that budget is the walk's work refusal.
    expect(resultAtFirstReach?.ok).toBe(false);
    if (resultAtFirstReach && !resultAtFirstReach.ok) {
      expect(resultAtFirstReach.refusal.code).toBe('work-limit-exceeded');
    }
  });

  it('the success path still enumerates every key of the record', () => {
    const attempt = makeProxyRun();
    const result = attempt.run(DEFAULT_EVALUATION_LIMITS);
    expect(result.ok).toBe(true);
    // Every one of the 16 keys was produced on the success path:
    // at least one descriptor call per key.
    expect(attempt.calls()).toBeGreaterThanOrEqual(16);
  });
});

describe('R4-03: per-slot totals are unchanged (8 vs 16 fields)', () => {
  /** Smallest integer maxWork at which the run succeeds (work only
   *  accumulates, so success is monotone in the budget). */
  const minWork = (run: (limits: EvaluationLimits) => boolean): number => {
    let lo = 0;
    let hi = 400_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (run({ ...DEFAULT_EVALUATION_LIMITS, maxWork: mid })) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const runFields = (fields: number) => (limits: EvaluationLimits) =>
    evaluateDynamicBlock(stretchDef, [lineWithRecord(plainRecord(fields))], [], widthState(14), limits).ok;

  it('the 16-field minimum exceeds the 8-field minimum by exactly the extra slots', () => {
    const min8 = minWork(runFields(8));
    const min16 = minWork(runFields(16));
    expect(min16 - min8).toBe(8 * FINITE_WALK_NODE_WEIGHT);
    // A separating budget exists, as in round 4.
    const atMin8 = { ...DEFAULT_EVALUATION_LIMITS, maxWork: min8 };
    expect(runFields(8)(atMin8)).toBe(true);
    const wide = evaluateDynamicBlock(stretchDef, [lineWithRecord(plainRecord(16))], [], widthState(14), atMin8);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.refusal.code).toBe('work-limit-exceeded');
  });

  it('a non-finite value inside the record still refuses degenerate-transform', () => {
    const record = plainRecord(16);
    record.k9 = Infinity;
    const result = evaluateDynamicBlock(stretchDef, [lineWithRecord(record)], [], widthState(14));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.message).toContain('line');
    }
  });
});
