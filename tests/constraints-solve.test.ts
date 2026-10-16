/**
 * Priority 30.3.1 — solver acceptance tests (design §7, slice-1 cases).
 * "Unchanged" always means: ok:false and no result entities; inputs are
 * never mutated (asserted by value). Tolerances asserted are the §5.5
 * constants, never looser local ones.
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import {
  MAX_VARIABLES,
  RESIDUAL_TOL,
  analyzeConstraints,
  solveConstraints,
} from '../src/core/constraints/solve';

const base = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ ...base, id, type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ ...base, id, type: 'circle', center: { x: cx, y: cy }, radius: r });
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): ArcEntity => ({ ...base, id, type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });
const polyline = (id: string, pts: readonly (readonly [number, number])[], closed = false, bulges?: readonly number[]): PolylineEntity => ({
  ...base,
  id,
  type: 'polyline',
  points: pts.map(([x, y]) => ({ x, y })),
  closed,
  ...(bulges ? { bulges } : {}),
});

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) => ({ entityId, anchor, ...(index !== undefined ? { index } : {}) });
const byId = (entities: readonly Entity[]) => new Map(entities.map((e) => [e.id, e]));
const asLine = (e: Entity) => e as LineEntity;
const asCircle = (e: Entity) => e as CircleEntity;
const asPoint = (e: Entity) => e as PointEntity;

/** The §7 case-1 rectangle geometry (without its slice-2 distances):
 *  4 lines, coincident corners, H top/bottom, V sides, one fixed corner. */
function rectangle(ox = 0, oy = 0, w = 10, h = 5) {
  const entities = [
    line('bottom', ox, oy, ox + w, oy),
    line('right', ox + w, oy, ox + w, oy + h),
    line('top', ox + w, oy + h, ox, oy + h),
    line('left', ox, oy + h, ox, oy),
  ];
  const constraints = set(
    { id: 'c1', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('right', 'start')] },
    { id: 'c2', kind: 'coincident', role: 'driving', refs: [ref('right', 'end'), ref('top', 'start')] },
    { id: 'c3', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('left', 'start')] },
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('bottom', 'start')] },
    { id: 'hb', kind: 'horizontal', role: 'driving', refs: [ref('bottom', 'whole')] },
    { id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] },
    { id: 'vr', kind: 'vertical', role: 'driving', refs: [ref('right', 'whole')] },
    { id: 'vl', kind: 'vertical', role: 'driving', refs: [ref('left', 'whole')] },
  );
  return { entities, constraints };
}

describe('stage 2 construction', () => {
  it('horizontal copies the grounded coordinate (rule 4) and moves only the free end', () => {
    const L = line('L', 0, 0, 10, 3);
    const other = circle('C', 50, 50, 2);
    const result = solveConstraints(
      [L, other],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('underconstrained');
    expect(result.dof).toMatchObject({ total: 4, nominalConsumed: 3, effectiveConsumed: 3, remaining: 1 });
    const out = byId(result.entities!);
    expect(out.get('C')).toBe(other); // untouched entity keeps identity
    const solved = asLine(out.get('L')!);
    expect(solved).not.toBe(L);
    expect(solved.a).toEqual({ x: 0, y: 0 });
    expect(solved.b).toEqual({ x: 10, y: 0 });
    expect(result.entities).not.toEqual([L, other]); // new array, new line
  });

  it('vertical copies x; two fixed endpoints fully constrain a line without moving it', () => {
    const L = line('L', 2, 2, 2, 9);
    const result = solveConstraints(
      [L],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('L', 'end')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('fully-constrained');
    expect(result.dof.remaining).toBe(0);
    expect(result.entities![0]).toBe(L); // identity: nothing moved
  });

  it('horizontal in two-point form copies y across entities', () => {
    const P = point('P', 0, 5);
    const Q = point('Q', 7, 9);
    const result = solveConstraints(
      [P, Q],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('P', 'position'), ref('Q', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    expect(out.get('P')).toBe(P);
    expect(asPoint(out.get('Q')!).position).toEqual({ x: 7, y: 5 });
  });

  it('coincident adoption propagates through union-find node groups (§7 case 3, slice-1 form)', () => {
    // A point fixed in place; three line starts coincident with it (directly
    // or through a shared node) all adopt its coordinates in one solve.
    const P = point('P', 4, 4);
    const L1 = line('L1', 0, 0, 8, 0);
    const L2 = line('L2', -3, 2, 8, 2);
    const L3 = line('L3', 1, 9, 8, 9);
    const result = solveConstraints(
      [P, L1, L2, L3],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'k1', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('L1', 'start')] },
        { id: 'k2', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('L2', 'start')] },
        { id: 'k3', kind: 'coincident', role: 'driving', refs: [ref('L1', 'start'), ref('L3', 'start')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    for (const id of ['L1', 'L2', 'L3']) expect(asLine(out.get(id)!).a).toEqual({ x: 4, y: 4 });
    expect(result.diagnostics.filter((d) => d.state === 'satisfied')).toHaveLength(4);
  });

  it('concentric + equal + driving radius fully constrains two circles (§7 case 13)', () => {
    const C1 = circle('C1', 0, 0, 3);
    const C2 = circle('C2', 8, 4, 6);
    const mk = (radiusValue: number) =>
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('C1', 'center')] },
        { id: 'cc', kind: 'concentric', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] },
        { id: 'r', kind: 'radius', role: 'driving', value: radiusValue, refs: [ref('C1', 'whole')] },
      );
    const first = solveConstraints([C1, C2], mk(5));
    expect(first.ok).toBe(true);
    expect(first.status).toBe('fully-constrained');
    expect(first.dof).toMatchObject({ total: 6, nominalConsumed: 6, effectiveConsumed: 6, remaining: 0 });
    let out = byId(first.entities!);
    expect(asCircle(out.get('C1')!)).toMatchObject({ center: { x: 0, y: 0 }, radius: 5 });
    expect(asCircle(out.get('C2')!)).toMatchObject({ center: { x: 0, y: 0 }, radius: 5 });

    const second = solveConstraints(first.entities!, mk(7));
    expect(second.ok).toBe(true);
    out = byId(second.entities!);
    expect(asCircle(out.get('C1')!).radius).toBe(7);
    expect(asCircle(out.get('C2')!).radius).toBe(7);
    expect(asCircle(out.get('C2')!).center).toEqual({ x: 0, y: 0 }); // centers unmoved
  });

  it('driving diameter sets radius exactly; a reference radius only measures (§7 case 18, slice-1 part)', () => {
    const C = circle('C', 1, 1, 4);
    const result = solveConstraints(
      [C],
      set(
        { id: 'd', kind: 'diameter', role: 'driving', value: 20, refs: [ref('C', 'whole')] },
        { id: 'rr', kind: 'radius', role: 'reference', refs: [ref('C', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(asCircle(result.entities![0]!).radius).toBe(10);
    const diag = result.diagnostics.find((d) => d.constraintId === 'rr')!;
    expect(diag.state).toBe('reference');
    expect(diag.measured).toBe(10);
  });
});

describe('stage 3 skeleton: cycles, scale, determinism', () => {
  it('solves the coincident cycle rectangle; the open chain gives identical geometry (§7 case 7)', () => {
    const { entities, constraints } = rectangle();
    const closedCycle = set(...constraints.constraints, { id: 'c4', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] });
    const a = solveConstraints(entities, closedCycle);
    const b = solveConstraints(entities, constraints); // open chain (no c4)
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.status).toBe('underconstrained'); // width/height still free (distances are slice 2)
    expect(a.dof.remaining).toBe(2);
    expect(a.entities).toEqual(b.entities); // identical geometry, cycle or chain
    for (let i = 0; i < entities.length; i += 1) expect(a.entities![i]).toBe(entities[i]); // nothing moved
    const rerun = solveConstraints(entities, closedCycle);
    expect(rerun.workUsed).toBe(a.workUsed); // determinism, bit-for-bit
    expect(rerun.entities).toEqual(a.entities);
  });

  it('reconciles a perturbed coincident cycle in stage 3', () => {
    const entities = [
      line('bottom', 0, 0, 10, 0),
      line('right', 10, 0, 10, 5),
      line('top', 10.2, 5.1, 0, 5),
      line('left', 0, 5, 0.1, -0.1),
    ];
    const constraints = set(
      { id: 'c1', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('right', 'start')] },
      { id: 'c2', kind: 'coincident', role: 'driving', refs: [ref('right', 'end'), ref('top', 'start')] },
      { id: 'c3', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('left', 'start')] },
      { id: 'c4', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] },
      { id: 'hb', kind: 'horizontal', role: 'driving', refs: [ref('bottom', 'whole')] },
      { id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] },
      { id: 'vr', kind: 'vertical', role: 'driving', refs: [ref('right', 'whole')] },
      { id: 'vl', kind: 'vertical', role: 'driving', refs: [ref('left', 'whole')] },
    );
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const corner = (id: string, which: 'a' | 'b') => asLine(out.get(id)!)[which];
    const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(gap(corner('bottom', 'b'), corner('right', 'a'))).toBeLessThanOrEqual(1e-6);
    expect(gap(corner('right', 'b'), corner('top', 'a'))).toBeLessThanOrEqual(1e-6);
    expect(gap(corner('top', 'b'), corner('left', 'a'))).toBeLessThanOrEqual(1e-6);
    expect(gap(corner('left', 'b'), corner('bottom', 'a'))).toBeLessThanOrEqual(1e-6);
    for (const d of result.diagnostics) expect(d.residual).toBeLessThanOrEqual(RESIDUAL_TOL);
  });

  it('handles the rectangle at 1e8 coordinates (§7 case 8a, slice-1 form)', () => {
    const { entities, constraints } = rectangle(1e8, -1e8);
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('underconstrained');
    for (let i = 0; i < entities.length; i += 1) expect(result.entities![i]).toBe(entities[i]);
  });

  it('handles the rectangle at 1e-4 scale without a degenerate false positive (§7 case 8b)', () => {
    const { entities, constraints } = rectangle(0, 0, 1e-3, 5e-4);
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('solves a coincident through a derived arc endpoint', () => {
    const A = arc('A', 0, 0, 5, 0, Math.PI / 2);
    const P = point('P', 9, 9);
    const result = solveConstraints(
      [A, P],
      set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('A', 'start')] }),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const p = asPoint(out.get('P')!).position;
    const aOut = out.get('A')! as ArcEntity;
    const start = { x: aOut.center.x + aOut.radius * Math.cos(aOut.startAngle), y: aOut.center.y + aOut.radius * Math.sin(aOut.startAngle) };
    expect(Math.hypot(p.x - start.x, p.y - start.y)).toBeLessThanOrEqual(1e-6);
  });
});

describe('honest failure reporting', () => {
  it('conflicting fixed points + coincident: stationary residual above CONFLICT_TOL (§5.6)', () => {
    const P = point('P', 0, 0);
    const Q = point('Q', 10, 0);
    const snapshot = JSON.stringify([P, Q]);
    const result = solveConstraints(
      [P, Q],
      set(
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'fq', kind: 'fixed', role: 'driving', refs: [ref('Q', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('Q', 'position')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.entities).toBeUndefined();
    expect(result.status).toBe('conflicting');
    expect(result.failure?.code).toBe('conflicting-constraints');
    // At the least-squares point all three are violated — §5.6 reports every
    // constraint unsatisfied at the best point found, not a minimal subset.
    expect(new Set(result.failure?.constraintIds)).toEqual(new Set(['fp', 'fq', 'k']));
    expect(result.diagnostics.every((d) => d.state === 'violated')).toBe(true);
    expect(JSON.stringify([P, Q])).toBe(snapshot); // inputs untouched
  });

  it('conflicting radii through equal: the least-squares point violates all three (§5.6)', () => {
    // Optimum of (r1−5)² + (r2−7)² + (r2−r1)² is r1=17/3, r2=19/3, where
    // every residual is 2/3 — so at the best point found, all three
    // constraints are unsatisfied and all three are reported.
    const result = solveConstraints(
      [circle('C1', 0, 0, 3), circle('C2', 30, 0, 4)],
      set(
        { id: 'r1', kind: 'radius', role: 'driving', value: 5, refs: [ref('C1', 'whole')] },
        { id: 'r2', kind: 'radius', role: 'driving', value: 7, refs: [ref('C2', 'whole')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflicting');
    expect(result.failure?.code).toBe('conflicting-constraints');
    expect(new Set(result.failure?.constraintIds)).toEqual(new Set(['r1', 'r2', 'eq']));
    for (const d of result.diagnostics) {
      expect(d.state).toBe('violated');
      expect(d.residual).toBeCloseTo(2 / 3 / 30, 9); // S = 30 for this component
    }
  });

  it('missing reference blocks the whole set (§7 case 16)', () => {
    const L = line('L', 0, 0, 10, 0);
    const result = solveConstraints(
      [L],
      set(
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('L', 'end'), ref('ghost', 'start')] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.problems?.map((p) => p.code)).toContain('missing-reference');
    expect(result.entities).toBeUndefined(); // the well-formed 'h' is NOT solved either
  });

  it('zero-length line + horizontal is degenerate; + coincident only solves (§7 case 9)', () => {
    const Z = line('Z', 2, 2, 2, 2);
    const degenerate = solveConstraints([Z], set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('Z', 'whole')] }));
    expect(degenerate.ok).toBe(false);
    expect(degenerate.status).toBe('unsolved');
    expect(degenerate.failure?.code).toBe('degenerate-geometry');

    const P = point('P', 5, 5);
    const ok = solveConstraints(
      [Z, P],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('Z', 'start'), ref('P', 'position')] },
      ),
    );
    expect(ok.ok).toBe(true);
    const z = asLine(byId(ok.entities!).get('Z')!);
    expect(z.a).toEqual({ x: 5, y: 5 });
    expect(z.b).toEqual({ x: 2, y: 2 }); // coincidence needs no direction — end untouched in value
  });

  it('refuses kinds belonging to later slices instead of skipping them', () => {
    const L = line('L', 0, 0, 10, 0);
    const C = circle('C', 0, 10, 5);
    const tangent = solveConstraints([L, C], set({ id: 't', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] }));
    expect(tangent.ok).toBe(false);
    expect(tangent.status).toBe('unsolved'); // explicitly NOT conflicting
    expect(tangent.failure?.code).toBe('unsupported-constraint');
    expect(tangent.failure?.constraintIds).toEqual(['t']);

    const onObject = solveConstraints(
      [point('P', 1, 1), C],
      set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('C', 'whole')] }),
    );
    expect(onObject.failure?.code).toBe('unsupported-constraint');
  });

  it('a suppressed constraint is reported, excluded, and consumes no DOF', () => {
    const L = line('L', 0, 0, 10, 3);
    const result = solveConstraints(
      [L],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'h', kind: 'horizontal', role: 'driving', suppressed: true, refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.entities![0]).toBe(L);
    expect(result.dof).toMatchObject({ total: 4, nominalConsumed: 2, remaining: 2 });
    expect(result.diagnostics.find((d) => d.constraintId === 'h')?.state).toBe('suppressed');
  });
});

describe('reference constraints never drive (§7 case 12, slice-1 form)', () => {
  it('a reference radius measures but does not move its circle; a reference distance re-measures after motion', () => {
    const C1 = circle('C1', 0, 0, 3);
    const C2 = circle('C2', 40, 0, 8);
    const L = line('L', 0, 0, 6, 0);
    const P = point('P', 1, 1);
    const result = solveConstraints(
      [C1, C2, L, P],
      set(
        { id: 'rr', kind: 'radius', role: 'reference', refs: [ref('C1', 'whole')] },
        { id: 'r2', kind: 'radius', role: 'driving', value: 5, refs: [ref('C2', 'whole')] },
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'fe', kind: 'fixed', role: 'driving', refs: [ref('L', 'end')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('L', 'end')] },
        { id: 'rd', kind: 'distance', role: 'reference', refs: [ref('L', 'start'), ref('P', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    expect(out.get('C1')).toBe(C1); // reference pulled nothing
    expect(asCircle(out.get('C2')!).radius).toBe(5);
    expect(asPoint(out.get('P')!).position).toEqual({ x: 6, y: 0 }); // adopted the determined endpoint
    const rd = result.diagnostics.find((d) => d.constraintId === 'rd')!;
    expect(rd.state).toBe('reference');
    expect(rd.measured).toBe(6); // the NEW measured value after motion
    const rr = result.diagnostics.find((d) => d.constraintId === 'rr')!;
    expect(rr.measured).toBe(3);
    expect(result.dof.nominalConsumed).toBe(1 + 2 + 2 + 2); // driving radius + 2×fixed + coincident; references count 0
  });
});

describe('limits and cancellation (§5.5)', () => {
  it('refuses a system above MAX_VARIABLES before starting, workUsed 0 (§7 case 11)', () => {
    const pts: Entity[] = [];
    const cs: Constraint[] = [];
    const n = MAX_VARIABLES / 2 + 1; // 257 points = 514 variables
    for (let i = 0; i < n; i += 1) pts.push(point(`P${i}`, i * 3, 0));
    for (let i = 0; i + 1 < n; i += 1) {
      cs.push({ id: `k${i}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i}`, 'position'), ref(`P${i + 1}`, 'position')] });
    }
    const result = solveConstraints(pts, set(...cs));
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('work-limit-exceeded');
    expect(result.status).toBe('unsolved');
    expect(result.workUsed).toBe(0);
  });

  it('exhausting the work budget in relaxation is unsolved, never conflicting, and deterministic', () => {
    const entities = [
      line('bottom', 0, 0, 10, 0),
      line('right', 10, 0, 10, 5),
      line('top', 10.2, 5.1, 0, 5),
      line('left', 0, 5, 0.1, -0.1),
    ];
    const constraints = set(
      { id: 'c1', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('right', 'start')] },
      { id: 'c2', kind: 'coincident', role: 'driving', refs: [ref('right', 'end'), ref('top', 'start')] },
      { id: 'c3', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('left', 'start')] },
      { id: 'c4', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] },
    );
    const a = solveConstraints(entities, constraints, { workLimit: 5 });
    const b = solveConstraints(entities, constraints, { workLimit: 5 });
    expect(a.ok).toBe(false);
    expect(a.failure?.code).toBe('work-limit-exceeded');
    expect(a.status).toBe('unsolved');
    expect(a.workUsed).toBe(b.workUsed);
    expect(a.workUsed).toBeGreaterThan(5);
  });

  it('a token cancelled before the call returns cancelled (§7 case 10)', () => {
    const { entities, constraints } = rectangle();
    const result = solveConstraints(entities, constraints, { token: { cancelled: true } });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('cancelled');
    expect(result.entities).toBeUndefined();
  });

  it('a token tripped at a stage-3 poll point cancels with partial work charged', () => {
    // A 40-line coincident chain of horizontal segments at alternating
    // heights, so every joint mismatches by 2 units: nothing past the
    // first point is determined, so stage 3 relaxation needs several
    // iterations and polls the token before each one (§5.5).
    const entities: Entity[] = [];
    const cs: Constraint[] = [{ id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L0', 'start')] }];
    for (let i = 0; i < 40; i += 1) {
      entities.push(line(`L${i}`, i * 10, (i % 2) * 2, (i + 1) * 10, (i % 2) * 2));
      if (i > 0) cs.push({ id: `k${i}`, kind: 'coincident', role: 'driving', refs: [ref(`L${i - 1}`, 'end'), ref(`L${i}`, 'start')] });
    }
    const full = solveConstraints(entities, set(...cs));
    expect(full.ok).toBe(true);

    let reads = 0;
    const token = {
      get cancelled() {
        reads += 1;
        return reads > 5; // trips at the 6th poll (a stage-3 iteration poll)
      },
    };
    const cut = solveConstraints(entities, set(...cs), { token });
    expect(cut.ok).toBe(false);
    expect(cut.failure?.code).toBe('cancelled');
    expect(cut.entities).toBeUndefined();
    expect(cut.workUsed).toBeLessThan(full.workUsed);
    expect(cut.workUsed).toBeGreaterThan(0);
  });
});

describe('DOF reporting without motion (analyzeConstraints)', () => {
  it('reports rank-based DOF and per-entity remaining in input order (§7 case 2, slice-1 form)', () => {
    const L1 = line('L1', 0, 0, 10, 0);
    const L2 = line('L2', 10, 0, 20, 3);
    const analysis = analyzeConstraints(
      [L1, L2],
      set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('L1', 'end'), ref('L2', 'start')] }),
    );
    expect(analysis.problems).toEqual([]);
    expect(analysis.dof).toMatchObject({ total: 8, nominalConsumed: 2, effectiveConsumed: 2, remaining: 6 });
    // Sequential marginal rank in input order: L1's endpoint carries the
    // coincident's rank (2), L2's adds none.
    expect(analysis.dof.perEntity).toEqual([
      { entityId: 'L1', dof: 4, remaining: 2 },
      { entityId: 'L2', dof: 4, remaining: 4 },
    ]);
    expect(analysis.status).toBe('underconstrained');
    expect(analysis.diagnostics[0]?.state).toBe('satisfied');
  });

  it('reports unsolved (never conflicting) when geometry violates a constraint, and null status on problems', () => {
    const slanted = line('L', 0, 0, 10, 3);
    const analysis = analyzeConstraints([slanted], set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] }));
    expect(analysis.status).toBe('unsolved');
    const broken = analyzeConstraints([slanted], set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('ghost', 'start')] }));
    expect(broken.status).toBeNull();
    expect(broken.problems[0]?.code).toBe('missing-reference');
  });

  it('flags redundant constraints on a successful solve (§7 case 6, slice-1 form)', () => {
    // L is fully grounded by two fixed constraints and P is fixed exactly
    // at L's midpoint: the horizontal and the coincident each add no rank.
    const L = line('L', 0, 0, 10, 0);
    const P = point('P', 5, 0);
    const result = solveConstraints(
      [L, P],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('L', 'end')] },
        { id: 'hl', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('L', 'midpoint')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('fully-constrained');
    const redundant = new Set(result.diagnostics.filter((d) => d.state === 'redundant').map((d) => d.constraintId));
    expect(redundant.has('hl')).toBe(true);
    expect(redundant.has('k')).toBe(true);
  });

  it('emits a bulge-carried note when a solve moves a bulged vertex (§2.5)', () => {
    const PL = polyline('PL', [[0, 0], [10, 0], [10, 10]], false, [0.5, 0]);
    const F = point('F', 20, 20);
    const result = solveConstraints(
      [PL, F],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('F', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('PL', 'vertex', 2), ref('F', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = result.entities![0]! as PolylineEntity;
    expect(out.points[2]).toEqual({ x: 20, y: 20 });
    expect(out.bulges).toEqual([0.5, 0]); // carried verbatim, never solved
    expect(result.notes).toContainEqual({ code: 'bulge-carried', entityId: 'PL', constraintId: 'k' });
  });
});
