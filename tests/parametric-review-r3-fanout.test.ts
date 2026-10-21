/**
 * Review round 4, R3-03 (static note + tiny observation) — the C06
 * finiteness walk bounded depth and unique containers, but not WIDTH:
 * expanding a container materialized ALL its children (Object.values)
 * and pushed them all after a single per-container charge of 1, and
 * scalar leaves cost nothing, so an 8-wide and a 16-wide record cost
 * the walk exactly the same (Codex's tiny observation: plain 8- and
 * 16-entry empty-string ATTRIB maps both refused at maxWork 4 and
 * both admitted at 5). This is a static cost observation only — no
 * stress/freeze/timing failure was executed or is claimed.
 *
 * The walk now charges every node FINITE_WALK_NODE_WEIGHT exactly
 * once, when it is scheduled: the root up front, and every child as
 * part of its parent's fan-out charge, levied as ONE charge BEFORE
 * the children are enumerated (the count comes from the array length
 * or Object.keys, never from materializing the values first). These
 * tests pin the FIXED property (Codex's diagnostic asserted the gap
 * and is not preserved):
 *  - fan-out is proportional: the minimum budget admitting a 16-wide
 *    ATTRIB map exceeds the one admitting an otherwise identical
 *    8-wide map by exactly the extra slots x the per-node weight, so
 *    a separating budget exists (at the 8-wide minimum, the 16-wide
 *    evaluation refuses 'work-limit-exceeded');
 *  - the same proportionality holds for a single very wide container
 *    (width is admitted per container, not just in aggregate);
 *  - width alone is not refused when the budget admits it, and a
 *    non-finite number inside a wide structure still refuses
 *    'degenerate-transform' — fan-out accounting does not mask the
 *    walk's quarry.
 * Sharing, the depth bound and non-finite refusal behaviour are
 * pinned by parametric-review-c06-bounded-walk.test.ts and
 * parametric-review-c06-finite.test.ts and are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { InsertEntity, LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition, LinearDistanceParameter } from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import {
  DEFAULT_EVALUATION_LIMITS,
  FINITE_WALK_NODE_WEIGHT,
  evaluateDynamicBlock,
  type EvaluationLimits,
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

const spanState = (block: string, v: number): DynamicInstanceState => ({
  block, values: { span: { kind: 'distance', value: v } },
});

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

describe('R3-03: fan-out is charged before enumeration (ATTRIB map width)', () => {
  // An insert member whose ATTRIB map holds `width` empty strings,
  // arrayed to one derived copy (value 1 = copy 0 + 1 derived copy),
  // so step 7.5 walks the copy — including the map — while everything
  // except the map's width is identical between the two evaluations.
  const memberWith = (width: number): InsertEntity => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < width; i += 1) attributes[`A${i}`] = '';
    return {
      id: 'MEMBER', type: 'insert', layer: '0', color: 'ByLayer', block: 'NESTED',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes,
      dynamic: { block: 'NESTED', values: {} },
    };
  };
  const arrayDef: DynamicBlockDefinition = {
    version: 1,
    parameters: [spanParam()],
    actions: [{ kind: 'array', id: 'ARR', name: 'Array', parameterId: 'span', spacing: 1, selection: [{ entityId: 'MEMBER' }] }],
  };
  const runWidth = (width: number) => (limits: EvaluationLimits) =>
    evaluateDynamicBlock(arrayDef, [memberWith(width)], [], spanState('PANEL', 1), limits).ok;

  it('a separating budget exists: the 16-wide map costs exactly its extra slots over the 8-wide map', () => {
    const min8 = minWork(runWidth(8));
    const min16 = minWork(runWidth(16));
    // The ONLY difference between the two evaluations is 8 extra
    // string slots in one record. Under the fixed accounting each
    // slot is charged FINITE_WALK_NODE_WEIGHT once, before the record
    // is enumerated — so the minima differ by exactly that fan-out.
    // (Before the fix both minima were equal: the width was free.)
    expect(min16 - min8).toBe(8 * FINITE_WALK_NODE_WEIGHT);
    // At the 8-wide minimum budget the 8-wide evaluation succeeds and
    // the identically shaped 16-wide one refuses on work: the refusal
    // can only come from the pre-enumeration fan-out charge, since the
    // extra strings carry no other cost anywhere in the evaluation.
    const atMin8 = { ...DEFAULT_EVALUATION_LIMITS, maxWork: min8 };
    expect(evaluateDynamicBlock(arrayDef, [memberWith(8)], [], spanState('PANEL', 1), atMin8).ok).toBe(true);
    const wide = evaluateDynamicBlock(arrayDef, [memberWith(16)], [], spanState('PANEL', 1), atMin8);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.refusal.code).toBe('work-limit-exceeded');
  });

  it('width alone is not refused when the budget admits it', () => {
    expect(runWidth(16)(DEFAULT_EVALUATION_LIMITS)).toBe(true);
    expect(runWidth(8)(DEFAULT_EVALUATION_LIMITS)).toBe(true);
  });
});

describe('R3-03: a single very wide container is admitted on its own fan-out', () => {
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
  // Entities are plain data; a caller can attach a wide record. The
  // stretch derives the line, so step 7.5 walks the copy and its record.
  const lineWithRecord = (entries: number): LineEntity => {
    const record: Record<string, string> = {};
    for (let i = 0; i < entries; i += 1) record[`k${i}`] = '';
    return { ...line('line'), nested: record } as unknown as LineEntity;
  };
  const runRecord = (entries: number) => (limits: EvaluationLimits) =>
    evaluateDynamicBlock(stretchDef, [lineWithRecord(entries)], [], widthState(14), limits).ok;

  it('the wide record minimum exceeds the narrow one by exactly the slot difference', () => {
    const minNarrow = minWork(runRecord(8));
    const minWide = minWork(runRecord(2_000));
    expect(minWide - minNarrow).toBe((2_000 - 8) * FINITE_WALK_NODE_WEIGHT);
    // And at the narrow minimum the wide record refuses on work —
    // its own fan-out charge alone (2,000 slots) exceeds that budget,
    // so the refusal happens at that container's admission, before
    // its children are enumerated.
    const wide = evaluateDynamicBlock(stretchDef, [lineWithRecord(2_000)], [], widthState(14), {
      ...DEFAULT_EVALUATION_LIMITS, maxWork: minNarrow,
    });
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.refusal.code).toBe('work-limit-exceeded');
  });

  it('a non-finite number inside a wide structure still refuses degenerate-transform', () => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) record[`k${i}`] = '';
    record.k50 = Infinity;
    const entity = { ...line('line'), nested: record } as unknown as LineEntity;
    const result = evaluateDynamicBlock(stretchDef, [entity], [], widthState(14));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.message).toContain('line');
    }
  });
});
