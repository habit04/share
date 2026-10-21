import { describe, expect, it } from 'vitest';
import type { ArcEntity, Entity, LineEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { SOLVE_WORK_LIMIT, analyzeConstraints } from '../src/core/constraints/solve';

// Review round 4 (2026-10-16), item R3-02 — analysis admission.
// Round 3 admitted the dense RANK steps of analyzeConstraints, but
// the variable layout and its linear Float64Array(totalVars) were
// still built before any admission: a participating polyline entered
// the layout whole (every vertex read into vars0) even when the
// active constraints touch only its first segment. The layout is now
// admitted on the same work discipline BEFORE allocation — one unit
// per variable of linear state, charged into workUsed — and refused
// with the honest unknown report when it cannot fit. In the same
// item, the manifold probe's subset-Jacobian accounting is exact:
// jacRows allocates exactly the rows·n it is charged (built at
// compact row offsets), not a totalRows·n scratch compacted through
// a second copy. These are my own regression shapes; the review's
// guarded packet case (1,000-vertex tangency) keeps its exact
// verdict and is re-run externally, never committed.

const base = { layer: '0', color: 'ByLayer' as const };
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) =>
  index === undefined ? { entityId, anchor } : { entityId, anchor, index };
const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });

function tangencyFixture(pointCount: number): { entities: Entity[]; constraints: ConstraintSet } {
  const entities: Entity[] = [
    {
      ...base, id: 'L', type: 'polyline', closed: false,
      points: Array.from({ length: pointCount }, (_, i) => ({ x: 10 * i, y: 0 })),
    },
    { ...base, id: 'C', type: 'circle', center: { x: 0, y: 5 }, radius: 5 },
  ];
  const constraints = set(
    { id: 'fixed-start', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
    { id: 'horizontal', kind: 'horizontal', role: 'driving', refs: [ref('L', 'segment', 0)] },
    { id: 'vertical-center', kind: 'vertical', role: 'driving', refs: [ref('L', 'start'), ref('C', 'center')] },
    { id: 'point-on-circle', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('C', 'whole')] },
    { id: 'length', kind: 'distance', role: 'driving', value: 10, refs: [ref('L', 'segment', 0)] },
    { id: 'tangent', kind: 'tangent', role: 'driving', refs: [ref('L', 'segment', 0), ref('C', 'whole')] },
  );
  return { entities, constraints };
}

/** Counting Float64Array observer: records the largest single request
 *  and never throws (this is NOT the review's >8 MiB sentinel — these
 *  tests stay far below it and assert the bounded footprint directly). */
function observeAllocations<T>(fn: () => T): { result: T; maxRequest: number } {
  const Original = globalThis.Float64Array;
  let maxRequest = 0;
  globalThis.Float64Array = new Proxy(Original, {
    construct(target, args) {
      if (typeof args[0] === 'number' && args[0] > maxRequest) maxRequest = args[0];
      return Reflect.construct(target, args, target);
    },
  }) as typeof Float64Array;
  try {
    return { result: fn(), maxRequest };
  } finally {
    globalThis.Float64Array = Original;
  }
}

describe('round 4 R3-02 — analysis layout admission', () => {
  it('the guarded tangency shape: exact verdict, and the whole accounting chain is pinned', () => {
    const { entities, constraints } = tangencyFixture(1000);
    const { result: a, maxRequest } = observeAllocations(() => analyzeConstraints(entities, constraints));
    // The round-3 verdict is preserved bit-for-bit.
    expect(a.status).toBe('underconstrained');
    expect(a.dof.total).toBe(2003);
    expect(a.dof.effectiveConsumed).toBe(6);
    expect(a.dof.remaining).toBe(1997);
    // No buffer larger than the pointwise Jacobian (7 rows · 2,003
    // vars) is ever requested — the probe's QR step stays refused
    // BEFORE allocation, exactly as in round 3.
    expect(maxRequest).toBeLessThanOrEqual(7 * 2003);
    // Exact accounting: layout 2,003 + Jacobian 14,021 + the probe's
    // admitted prefix (subset Jacobian 6·2,003 = 12,018 and two row
    // charges of 6, spent before its QR step is refused) + marginals
    // 7·2,000 and 7·2,003. The 2,003 layout charge is the round-4
    // delta; had the probe's subset Jacobian been charged at the full
    // totalRows·n instead of its exact rows·n, the total would be
    // 2,003 higher again.
    expect(a.workUsed).toBe(2003 + 14021 + 12018 + 6 + 6 + 14000 + 14021);
    expect(a.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });

  it('a layout beyond the work discipline is refused before allocation: honest rank-unknown, no magnitudes', () => {
    // 150,000 vertices = 300,003 total variables > SOLVE_WORK_LIMIT.
    // The constraints touch only segment 0; pre-fix the whole polyline
    // was read into a 300,003-double vars0 before any admission ran.
    const { entities, constraints } = tangencyFixture(150_000);
    const { result: a, maxRequest } = observeAllocations(() => analyzeConstraints(entities, constraints));
    expect(a.problems).toEqual([]);
    expect(a.status).toBe('rank-unknown');
    // Counts stay exact; the effective figures are the stated unknown.
    expect(a.dof.total).toBe(300_003);
    expect(a.dof.nominalConsumed).toBeGreaterThan(0);
    expect(a.dof.effectiveConsumed).toBe(-1);
    expect(a.dof.remaining).toBe(-1);
    expect(a.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
    expect(a.workUsed).toBe(0);
    // No residual was evaluated, so no diagnostic may claim a state
    // from a magnitude: every driving entry is 'unresolved' (an absent
    // magnitude never satisfies), though measured values — computed
    // from geometry, not from the refused layout — are still carried.
    expect(a.diagnostics.length).toBeGreaterThan(0);
    expect(a.diagnostics.every((d) => d.state === 'unresolved' || d.state === 'suppressed' || d.state === 'reference')).toBe(true);
    // The refused linear array was never requested: the largest
    // allocation during the whole analysis is orders below totalVars.
    expect(maxRequest).toBeLessThan(10_000);
  });

  it('a layout just inside the discipline is admitted: rank still refused, but magnitudes are real', () => {
    // 99,000 vertices = 198,003 variables ≤ the cap: the layout is
    // built and charged, residuals are evaluated (diagnostics carry
    // genuine satisfied states), and only the dense rank step is
    // refused (7 · 198,003 exceeds the remaining budget).
    const { entities, constraints } = tangencyFixture(99_000);
    const a = analyzeConstraints(entities, constraints);
    expect(a.status).toBe('rank-unknown');
    expect(a.dof.total).toBe(198_003);
    expect(a.dof.effectiveConsumed).toBe(-1);
    expect(a.dof.remaining).toBe(-1);
    expect(a.workUsed).toBe(198_003);
    expect(a.diagnostics.every((d) => d.state === 'satisfied')).toBe(true);
  });

  it('the probe-affordable fold pair still reads its rank from the manifold probe', () => {
    // Arc + tangent line (the C02 fold control, unpadded): pointwise
    // the tangent row is dependent; the manifold probe — now building
    // its subset Jacobians at compact offsets — supplies the true
    // reading of 6 consumed of 6 rows.
    const arc: ArcEntity = { ...base, id: 'A', type: 'arc', center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 };
    const line: LineEntity = { ...base, id: 'L', type: 'line', a: { x: 4, y: 0 }, b: { x: 4, y: 3 } };
    const constraints = set(
      { id: 'fix-centre', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
      { id: 'radius', kind: 'radius', role: 'driving', value: 4, refs: [ref('A', 'whole')] },
      { id: 'co', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('A', 'start')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('A', 'whole')] },
    );
    const a = analyzeConstraints([arc, line], constraints);
    expect(a.dof.total).toBe(9);
    expect(a.dof.effectiveConsumed).toBe(6);
    expect(a.dof.remaining).toBe(3);
    expect(a.status).toBe('underconstrained');
    // More than the layout (9) + pointwise Jacobian (6·9) was spent:
    // the probe ran and was charged.
    expect(a.workUsed).toBeGreaterThan(9 + 54);
    expect(a.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });
});
