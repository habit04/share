import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { ArcEntity, Entity, LineEntity, PointEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { SOLVE_WORK_LIMIT, analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';
import { conStatusTool } from '../src/tools/constraints';
import { fakeContext, drive } from './fake-context';

// Review round 3 (2026-10-16), item R2-02 — my own regression shapes for
// the review's analysis-admission case (the review files themselves are
// never committed). analyzeConstraints ran its rank machinery with no
// admission: the manifold probe was called unbudgeted, so its dense QR
// step allocated (rows + vars) · vars doubles BEFORE any work check —
// 4,024,027 doubles (32 MB) for a 1,000-vertex polyline under a tangent
// constraint, against a 200,000 work cap — and the pointwise Jacobian
// itself was allocated and only then charged. The fix mirrors the
// solver's discipline: every dense allocation is checked and charged
// BEFORE it executes; a skipped rank reports the R12 stated unknown
// (-1 / 'rank-unknown'), never an invented verdict.

const base = { layer: '0', color: 'ByLayer' as const };
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) =>
  index === undefined ? { entityId, anchor } : { entityId, anchor, index };
const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });

describe('round 3 R2-02 — analysis admission', () => {
  it('a 1,000-vertex polyline under tangency: no oversized allocation, pointwise verdict within budget', () => {
    // The review's dense-QR shape: 7 rows over 2,003 variables. The
    // pointwise Jacobian is rows·vars (small); the manifold probe's QR
    // step would be (6 + 2003)·2003 ≈ 4.02M doubles and must be refused
    // by the budget BEFORE it allocates. An allocation sentinel (the
    // review's technique) throws before any oversized array exists, so
    // this test is safe to run: a regression re-opens the hole loudly
    // instead of allocating 32 MB.
    const entities: Entity[] = [
      {
        ...base, id: 'L', type: 'polyline', closed: false,
        points: Array.from({ length: 1000 }, (_, i) => ({ x: 10 * i, y: 0 })),
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
    const Original = globalThis.Float64Array;
    const oversized: number[] = [];
    globalThis.Float64Array = new Proxy(Original, {
      construct(target, args) {
        if (typeof args[0] === 'number' && args[0] * 8 > 8 * 1024 * 1024) {
          oversized.push(args[0]);
          throw new Error('TEST_ALLOCATION_SENTINEL_BEFORE_ALLOCATION');
        }
        return Reflect.construct(target, args, target);
      },
    }) as typeof Float64Array;
    let result: ReturnType<typeof analyzeConstraints> | undefined;
    let caught: unknown;
    try {
      result = analyzeConstraints(entities, constraints);
    } catch (error) {
      caught = error;
    } finally {
      globalThis.Float64Array = Original;
    }
    expect(caught).toBeUndefined();
    expect(oversized).toEqual([]);
    // Pointwise rank is computable within budget and is the verdict:
    // the tangent is manifold-implied here, so it consumes 0 of 7 rows.
    expect(result!.status).toBe('underconstrained');
    expect(result!.dof.total).toBe(2003);
    expect(result!.dof.effectiveConsumed).toBe(6);
    expect(result!.dof.remaining).toBe(1997);
    expect(result!.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });

  it('a system whose Jacobian alone exceeds the work cap reports rank-unknown DOF, not a computed rank', () => {
    // 256 points in a coincident chain: 512 vars, 512 rows — the
    // pointwise Jacobian costs 512·512 = 262,144 > SOLVE_WORK_LIMIT.
    // (The matching solve-side pin lives in constraints-hardening:
    // per-entity remaining is the stated unknown there too.)
    const entities: Entity[] = [];
    const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('P0', 'position')] }];
    for (let i = 0; i < 256; i += 1) entities.push(point(`P${i}`, i * 0.37, (i % 7) * 1.3));
    for (let i = 1; i < 256; i += 1) {
      constraints.push({ id: `c${i}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i - 1}`, 'position'), ref(`P${i}`, 'position')] });
    }
    const a = analyzeConstraints(entities, set(...constraints));
    // The chain is not satisfied at entry, so the satisfaction verdict
    // stands; the DOF verdict is the stated unknown.
    expect(a.status).toBe('unsolved');
    expect(a.dof.effectiveConsumed).toBe(-1);
    expect(a.dof.remaining).toBe(-1);
    expect(a.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
    expect(a.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });

  it('a satisfied system whose rank work exceeds the cap reports rank-unknown, never fully-constrained', () => {
    // 300 fixed points: 600 vars / 600 rows, Jacobian 360,000 > cap.
    const entities: Entity[] = [];
    const constraints: Constraint[] = [];
    for (let i = 0; i < 300; i += 1) {
      entities.push(point(`P${i}`, i * 1.7, (i % 5) * 0.9));
      constraints.push({ id: `f${i}`, kind: 'fixed', role: 'driving', refs: [ref(`P${i}`, 'position')] });
    }
    const a = analyzeConstraints(entities, set(...constraints));
    expect(a.status).toBe('rank-unknown');
    expect(a.dof.effectiveConsumed).toBe(-1);
    expect(a.dof.remaining).toBe(-1);
    expect(a.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
    // Satisfaction diagnostics are residual facts and still reported.
    expect(a.diagnostics.every((d) => d.state === 'satisfied')).toBe(true);
    expect(a.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });

  it('when the manifold probe does not fit the remaining budget, the pointwise reading stands (never invented rank)', () => {
    // The C02 fold control (arc + tangent line, pointwise-dependent
    // tangent) padded with 190 fixed points so the pointwise Jacobian
    // fits (386·389 = 150,154) but the probe's second Jacobian does
    // not. With the probe affordable the same pair reports consumed 6
    // of 6 rows (see constraints-review-r2-solver); here the honest
    // bounded result is the pointwise reading: tangent consumes 0.
    const entities: Entity[] = [];
    const constraints: Constraint[] = [];
    for (let i = 0; i < 190; i += 1) {
      entities.push(point(`P${i}`, 100 + i * 2.3, -50 - (i % 3)));
      constraints.push({ id: `f${i}`, kind: 'fixed', role: 'driving', refs: [ref(`P${i}`, 'position')] });
    }
    const arc: ArcEntity = { ...base, id: 'A', type: 'arc', center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 };
    const line: LineEntity = { ...base, id: 'L', type: 'line', a: { x: 4, y: 0 }, b: { x: 4, y: 3 } };
    entities.push(arc, line);
    constraints.push(
      { id: 'fix-centre', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
      { id: 'radius', kind: 'radius', role: 'driving', value: 4, refs: [ref('A', 'whole')] },
      { id: 'co', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('A', 'start')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('A', 'whole')] },
    );
    const a = analyzeConstraints(entities, set(...constraints));
    expect(a.dof.total).toBe(389);
    expect(a.dof.effectiveConsumed).toBe(385);
    expect(a.dof.remaining).toBe(4);
    expect(a.status).toBe('underconstrained');
    expect(a.workUsed).toBeLessThanOrEqual(SOLVE_WORK_LIMIT);
  });

  it('a mid-size system inside the budget is analyzed exactly as before', () => {
    const entities: Entity[] = [];
    const constraints: Constraint[] = [];
    for (let i = 0; i < 150; i += 1) {
      entities.push(point(`P${i}`, i * 1.3, (i % 4) * 0.7));
      constraints.push({ id: `f${i}`, kind: 'fixed', role: 'driving', refs: [ref(`P${i}`, 'position')] });
    }
    const a = analyzeConstraints(entities, set(...constraints));
    expect(a.status).toBe('fully-constrained');
    expect(a.dof.effectiveConsumed).toBe(300);
    expect(a.dof.remaining).toBe(0);
    expect(a.dof.perEntity[0]!.remaining).toBe(0);
    const solved = solveConstraints(entities, set(...constraints));
    expect(solved.ok).toBe(true);
  });

  it('CONSTATUS surfaces rank-unknown for an over-budget satisfied set', () => {
    const entities: Entity[] = [];
    const constraints: Constraint[] = [];
    for (let i = 0; i < 300; i += 1) {
      entities.push(point(`P${i}`, i * 1.7, (i % 5) * 0.9));
      constraints.push({ id: `f${i}`, kind: 'fixed', role: 'driving', refs: [ref(`P${i}`, 'position')] });
    }
    const doc = new Drawing({ entities, constraints: set(...constraints), currentLayer: '0' });
    const ctx = fakeContext(doc);
    drive(conStatusTool(), ctx, []);
    const out = ctx.logs.join('\n');
    expect(out).toContain('rank-unknown');
    expect(out).not.toContain('fully-constrained');
    expect(doc.canUndo()).toBe(false); // read-only: no transact
  });
});
