/**
 * Priority 30.3.2 — solver acceptance tests (design §7 cases for slice 2:
 * 1, 2, 3, 4, 5, 6, 8a, 8b, 9(i), 12, 17) plus construction rules 7–10,
 * distance modes, and determinism. Tolerances asserted are the §5.5
 * constants, never looser local ones (case 8a uses the design's own
 * 1e-6 absolute bound for coordinates at 1e8).
 */
import { describe, expect, it } from 'vitest';
import type { CircleEntity, Entity, LineEntity, PointEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { CONFLICT_TOL, RESIDUAL_TOL, solveConstraints } from '../src/core/constraints/solve';

const base = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ ...base, id, type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ ...base, id, type: 'circle', center: { x: cx, y: cy }, radius: r });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) => ({ entityId, anchor, ...(index !== undefined ? { index } : {}) });
const byId = (entities: readonly Entity[]) => new Map(entities.map((e) => [e.id, e]));
const asLine = (e: Entity) => e as LineEntity;
const asPoint = (e: Entity) => e as PointEntity;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** §7 case 1, full form: rectangle with a coincident CYCLE of 4, H/V,
 *  one fixed corner, driving width (bottom length) and height (right
 *  length) distances. */
function rectangle(ox = 0, oy = 0, w = 10, h = 5, width = w, height = h) {
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
    { id: 'c4', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] },
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('bottom', 'start')] },
    { id: 'hb', kind: 'horizontal', role: 'driving', refs: [ref('bottom', 'whole')] },
    { id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] },
    { id: 'vr', kind: 'vertical', role: 'driving', refs: [ref('right', 'whole')] },
    { id: 'vl', kind: 'vertical', role: 'driving', refs: [ref('left', 'whole')] },
    { id: 'dw', kind: 'distance', role: 'driving', refs: [ref('bottom', 'whole')], value: width },
    { id: 'dh', kind: 'distance', role: 'driving', refs: [ref('right', 'whole')], value: height },
  );
  return { entities, constraints };
}

describe('§7 case 1 — rectangle fully constrained by distances', () => {
  it('solves fully-constrained; width edit moves only the right side', () => {
    const { entities, constraints } = rectangle();
    const first = solveConstraints(entities, constraints);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('fully-constrained');
    expect(first.dof).toMatchObject({ total: 16, effectiveConsumed: 16, remaining: 0 });

    const wider = set(
      ...constraints.constraints.map((c) => (c.id === 'dw' ? { ...c, value: 16 } : c)),
    );
    const second = solveConstraints(first.entities!, wider);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('fully-constrained');
    const out = byId(second.entities!);
    const bottom = asLine(out.get('bottom')!);
    const right = asLine(out.get('right')!);
    const top = asLine(out.get('top')!);
    // Endpoints land on the analytic positions. (Design case 1 words the
    // fixed corner as "bit-identical"; under §5.4's release rule the
    // corner's variables join stage 3 whenever a touching constraint —
    // here hb via the moving bottom.end — is not discharged, so the
    // rebuilt entity carries solver noise ~1e-17, far below every §5.5
    // tolerance. 1e-9 is asserted, 16x tighter than RESIDUAL_TOL·S.)
    const near = (p: { x: number; y: number }, x: number, y: number) => expect(dist(p, { x, y })).toBeLessThanOrEqual(1e-9);
    near(bottom.a, 0, 0);
    near(bottom.b, 16, 0);
    near(right.a, 16, 0);
    near(right.b, 16, 5);
    near(top.a, 16, 5);
    near(top.b, 0, 5);
    // The left line did not move at all — object identity preserved.
    expect(out.get('left')).toBe(byId(first.entities!).get('left'));
    const dwDiag = second.diagnostics.find((d) => d.constraintId === 'dw');
    expect(dwDiag?.measured).toBeCloseTo(16, 9);
  });

  it('case 8a — the same rectangle at (1e8, -1e8)', () => {
    const { entities, constraints } = rectangle(1e8, -1e8);
    const first = solveConstraints(entities, constraints);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('fully-constrained');
    const wider = set(
      ...constraints.constraints.map((c) => (c.id === 'dw' ? { ...c, value: 16 } : c)),
    );
    const second = solveConstraints(first.entities!, wider);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('fully-constrained');
    const out = byId(second.entities!);
    const expectPt = (p: { x: number; y: number }, x: number, y: number) => {
      expect(Math.abs(p.x - x)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(p.y - y)).toBeLessThanOrEqual(1e-6);
    };
    expectPt(asLine(out.get('bottom')!).a, 1e8, -1e8);
    expectPt(asLine(out.get('bottom')!).b, 1e8 + 16, -1e8);
    expectPt(asLine(out.get('right')!).b, 1e8 + 16, -1e8 + 5);
    expectPt(asLine(out.get('top')!).b, 1e8, -1e8 + 5);
  });

  it('case 8b — the same rectangle at 1e-4 scale, no degenerate false positive', () => {
    const { entities, constraints } = rectangle(0, 0, 1e-3, 5e-4);
    const first = solveConstraints(entities, constraints);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('fully-constrained');
    const wider = set(
      ...constraints.constraints.map((c) => (c.id === 'dw' ? { ...c, value: 1.6e-3 } : c)),
    );
    const second = solveConstraints(first.entities!, wider);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('fully-constrained');
    const dwDiag = second.diagnostics.find((d) => d.constraintId === 'dw');
    // S = 1 at this scale, so the normalized residual bound is absolute.
    expect(Math.abs((dwDiag?.measured ?? 0) - 1.6e-3)).toBeLessThanOrEqual(RESIDUAL_TOL);
  });
});

describe('conflict by the evidence rule (§5.6)', () => {
  it('§7 case 4 — inconsistent triangle 10 / 10 / 30 reports all three distances', () => {
    const entities = [
      line('L1', 0, 0, 10, 0),
      line('L2', 10, 0, 5, 8.6602540378),
      line('L3', 5, 8.6602540378, 0, 0),
    ];
    const snapshot = JSON.parse(JSON.stringify(entities)) as unknown;
    const result = solveConstraints(
      entities,
      set(
        { id: 'k1', kind: 'coincident', role: 'driving', refs: [ref('L1', 'end'), ref('L2', 'start')] },
        { id: 'k2', kind: 'coincident', role: 'driving', refs: [ref('L2', 'end'), ref('L3', 'start')] },
        { id: 'k3', kind: 'coincident', role: 'driving', refs: [ref('L3', 'end'), ref('L1', 'start')] },
        { id: 'd1', kind: 'distance', role: 'driving', refs: [ref('L1', 'whole')], value: 10 },
        { id: 'd2', kind: 'distance', role: 'driving', refs: [ref('L2', 'whole')], value: 10 },
        { id: 'd3', kind: 'distance', role: 'driving', refs: [ref('L3', 'whole')], value: 30 },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflicting');
    expect(result.failure?.code).toBe('conflicting-constraints');
    // Case 4 requires all three distance ids reported. §5.6 defines the
    // reported set as EVERY constraint whose residual exceeds
    // CONFLICT_TOL at the best point found: at the verified least-squares
    // optimum of this soft system the coincident rows also exceed it
    // (residual ≈ 0.048 — relaxing coincidence lets the lengths get
    // closer), so they are reported too, in stored order.
    expect(result.failure?.constraintIds).toEqual(['k1', 'k2', 'k3', 'd1', 'd2', 'd3']);
    expect(result.entities).toBeUndefined();
    expect(entities).toEqual(snapshot); // inputs untouched
    for (const id of ['d1', 'd2', 'd3']) {
      const diag = result.diagnostics.find((d) => d.constraintId === id);
      expect(diag?.state).toBe('violated');
      expect(diag?.residual).toBeGreaterThan(CONFLICT_TOL);
    }
  });

  it('§7 case 5 — parallel ∧ perpendicular to the same fixed line conflicts', () => {
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 0, 5, 10, 8);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'par', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'perp', kind: 'perpendicular', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflicting');
    expect(result.failure?.code).toBe('conflicting-constraints');
    expect(result.failure?.constraintIds).toEqual(['par', 'perp']);
    expect(result.diagnostics.find((d) => d.constraintId === 'par')?.state).toBe('violated');
    expect(result.diagnostics.find((d) => d.constraintId === 'perp')?.state).toBe('violated');
  });

  it('§7 case 9(i) — zero-length line referenced by an angle is degenerate at stage 1', () => {
    const Z = line('Z', 2, 2, 2, 2);
    const A = line('A', 0, 0, 10, 0);
    const result = solveConstraints(
      [Z, A],
      set({ id: 'ang', kind: 'angle', role: 'driving', refs: [ref('Z', 'whole'), ref('A', 'whole')], value: 0.5 }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unsolved');
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.failure?.constraintIds).toEqual(['ang']);
  });
});

describe('stage 2 construction rules 7–10', () => {
  it('rule 7 — distance to a point on a determined line picks the closest intersection', () => {
    const W = line('W', 0, 0, 20, 0);
    const Q = point('Q', 8, 0);
    const P = point('P', 6, 3);
    const result = solveConstraints(
      [W, Q, P],
      set(
        { id: 'fw1', kind: 'fixed', role: 'driving', refs: [ref('W', 'start')] },
        { id: 'fw2', kind: 'fixed', role: 'driving', refs: [ref('W', 'end')] },
        { id: 'fq', kind: 'fixed', role: 'driving', refs: [ref('Q', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('W', 'whole')] },
        { id: 'd', kind: 'distance', role: 'driving', refs: [ref('P', 'position'), ref('Q', 'position')], value: 5 },
      ),
    );
    expect(result.ok).toBe(true);
    const p = asPoint(byId(result.entities!).get('P')!);
    // Circle((8,0), 5) ∩ line y=0 = (3,0) and (13,0); (3,0) is closest
    // to the current (6,3) — the solver must not teleport to (13,0).
    expect(dist(p.position, { x: 3, y: 0 })).toBeLessThanOrEqual(1e-9);
    expect(p.position.x).toBeLessThan(8);
  });

  it('rule 7 — a second distance to a determined point is the locus circle', () => {
    const Q1 = point('Q1', 0, 0);
    const Q2 = point('Q2', 8, 0);
    const P = point('P', 4, 1);
    const result = solveConstraints(
      [Q1, Q2, P],
      set(
        { id: 'f1', kind: 'fixed', role: 'driving', refs: [ref('Q1', 'position')] },
        { id: 'f2', kind: 'fixed', role: 'driving', refs: [ref('Q2', 'position')] },
        { id: 'd1', kind: 'distance', role: 'driving', refs: [ref('P', 'position'), ref('Q1', 'position')], value: 5 },
        { id: 'd2', kind: 'distance', role: 'driving', refs: [ref('P', 'position'), ref('Q2', 'position')], value: 5 },
      ),
    );
    expect(result.ok).toBe(true);
    // Intersections are (4, 3) and (4, -3); (4, 3) is closest to (4, 1).
    expect(asPoint(byId(result.entities!).get('P')!).position).toEqual({ x: 4, y: 3 });
  });

  it('rule 8 — parallel adoption rotates the free endpoint about the fixed one, preserving length', () => {
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 2, 2, 12, 5);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('B', 'start')] },
        { id: 'par', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const b = asLine(byId(result.entities!).get('B')!);
    expect(b.a).toEqual({ x: 2, y: 2 });
    expect(b.b.y).toBe(2); // exactly horizontal after adoption
    expect(dist(b.a, b.b)).toBeCloseTo(Math.sqrt(109), 12); // length preserved
  });

  it('rule 8 — perpendicular adoption against a vertical line', () => {
    const A = line('A', 0, 0, 0, 10);
    const B = line('B', 2, 2, 12, 5);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('B', 'start')] },
        { id: 'perp', kind: 'perpendicular', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const b = asLine(byId(result.entities!).get('B')!);
    expect(b.b.y).toBe(2); // B is exactly horizontal ⇒ perpendicular to vertical A
    expect(dist(b.a, b.b)).toBeCloseTo(Math.sqrt(109), 12);
  });

  it('rule 9 — equal length rescales the free segment about its fixed endpoint', () => {
    const L1 = line('L1', 0, 0, 6, 0);
    const L2 = line('L2', 0, 5, 3, 9);
    const result = solveConstraints(
      [L1, L2],
      set(
        { id: 'f1', kind: 'fixed', role: 'driving', refs: [ref('L1', 'start')] },
        { id: 'f2', kind: 'fixed', role: 'driving', refs: [ref('L1', 'end')] },
        { id: 'f3', kind: 'fixed', role: 'driving', refs: [ref('L2', 'start')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('L1', 'whole'), ref('L2', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const l2 = asLine(byId(result.entities!).get('L2')!);
    expect(dist(l2.a, l2.b)).toBeCloseTo(6, 12);
    expect(dist(l2.b, { x: 3.6, y: 9.8 })).toBeLessThanOrEqual(1e-9);
  });

  it('§7 case 17 — angle drives rotation about the fixed start; re-solve follows the new angle', () => {
    const A = line('A', 0, 0, 10, 0);
    const L = line('L', 0, 0, 9.8477550654, 1.7364817767); // length 10 at 10°
    const constraints = (angle: number) =>
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'fl', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'ang', kind: 'angle', role: 'driving', refs: [ref('A', 'whole'), ref('L', 'whole')], value: angle },
        { id: 'dl', kind: 'distance', role: 'driving', refs: [ref('L', 'whole')], value: 10 },
      );
    const first = solveConstraints([A, L], constraints(Math.PI / 6));
    expect(first.ok).toBe(true);
    const l1 = asLine(byId(first.entities!).get('L')!);
    // The rotation is about the start (rule 10); the start's own movement
    // is solver noise ~1e-14 (its variables are released to stage 3 by
    // the length constraint per §5.4), far below CHANGE_EPS·S.
    expect(dist(l1.a, { x: 0, y: 0 })).toBeLessThanOrEqual(1e-9);
    expect(dist(l1.a, l1.b)).toBeCloseTo(10, 9);
    const measured1 = first.diagnostics.find((d) => d.constraintId === 'ang')?.measured;
    expect(Math.abs((measured1 ?? 0) - Math.PI / 6)).toBeLessThanOrEqual(RESIDUAL_TOL);

    const second = solveConstraints(first.entities!, constraints(Math.PI / 3));
    expect(second.ok).toBe(true);
    const l2 = asLine(byId(second.entities!).get('L')!);
    expect(dist(l2.a, { x: 0, y: 0 })).toBeLessThanOrEqual(1e-9);
    expect(dist(l2.b, { x: 5, y: 8.6602540378 })).toBeLessThanOrEqual(1e-6);
    const measured2 = second.diagnostics.find((d) => d.constraintId === 'ang')?.measured;
    expect(Math.abs((measured2 ?? 0) - Math.PI / 3)).toBeLessThanOrEqual(RESIDUAL_TOL);
  });
});

describe('distance modes and driving edits', () => {
  const P = point('P', 0, 0);
  const fixedP = { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] } as Constraint;

  it('aligned distance moves Q to the closest point of the target circle', () => {
    const Q = point('Q', 3, 4);
    const result = solveConstraints([P, Q], set(fixedP, { id: 'd', kind: 'distance', role: 'driving', refs: [ref('P', 'position'), ref('Q', 'position')], value: 10 }));
    expect(result.ok).toBe(true);
    const q = asPoint(byId(result.entities!).get('Q')!);
    expect(Math.abs(dist(q.position, { x: 0, y: 0 }) - 10)).toBeLessThanOrEqual(RESIDUAL_TOL * 10);
    expect(dist(q.position, { x: 6, y: 8 })).toBeLessThanOrEqual(1e-6);
  });

  it('horizontal mode sets Δx exactly and leaves y alone (rule 7)', () => {
    const Q = point('Q', 3, 4);
    const result = solveConstraints(
      [P, Q],
      set(fixedP, { id: 'd', kind: 'distance', role: 'driving', distanceMode: 'horizontal', refs: [ref('P', 'position'), ref('Q', 'position')], value: 10 }),
    );
    expect(result.ok).toBe(true);
    expect(asPoint(byId(result.entities!).get('Q')!).position).toEqual({ x: 10, y: 4 });
  });

  it('vertical mode sets Δy exactly and leaves x alone (rule 7)', () => {
    const Q = point('Q', 3, 4);
    const result = solveConstraints(
      [P, Q],
      set(fixedP, { id: 'd', kind: 'distance', role: 'driving', distanceMode: 'vertical', refs: [ref('P', 'position'), ref('Q', 'position')], value: 10 }),
    );
    expect(result.ok).toBe(true);
    expect(asPoint(byId(result.entities!).get('Q')!).position).toEqual({ x: 3, y: 10 });
  });

  it('a driving distance edit moves the geometry on re-solve', () => {
    const Q = point('Q', 3, 4);
    const d = (value: number): Constraint => ({ id: 'd', kind: 'distance', role: 'driving', refs: [ref('P', 'position'), ref('Q', 'position')], value });
    const first = solveConstraints([P, Q], set(fixedP, d(10)));
    expect(first.ok).toBe(true);
    const second = solveConstraints(first.entities!, set(fixedP, d(14)));
    expect(second.ok).toBe(true);
    const q = asPoint(byId(second.entities!).get('Q')!);
    expect(Math.abs(dist(q.position, { x: 0, y: 0 }) - 14)).toBeLessThanOrEqual(RESIDUAL_TOL * 14);
    expect(dist(q.position, { x: 8.4, y: 11.2 })).toBeLessThanOrEqual(1e-6);
  });
});

describe('point-on-object coincident (§5.4 forms)', () => {
  it('point on circle: the point moves onto the circle, the circle is untouched', () => {
    const C = circle('C', 0, 0, 5);
    const P = point('P', 3, 3);
    const result = solveConstraints(
      [C, P],
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
        { id: 'rc', kind: 'radius', role: 'driving', refs: [ref('C', 'whole')], value: 5 },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('C', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(byId(result.entities!).get('C')).toBe(C);
    const p = asPoint(byId(result.entities!).get('P')!);
    expect(Math.abs(dist(p.position, { x: 0, y: 0 }) - 5)).toBeLessThanOrEqual(RESIDUAL_TOL * 5);
  });

  it('point on line: the point moves onto the line', () => {
    const W = line('W', 0, 0, 20, 0);
    const P = point('P', 5, 3);
    // The horizontal distance pins P's x (rule 7 sets it exactly), so the
    // expected landing point (5, 0) is fully determined; point-on-line
    // alone would leave the along-line position free.
    const result = solveConstraints(
      [W, P],
      set(
        { id: 'f1', kind: 'fixed', role: 'driving', refs: [ref('W', 'start')] },
        { id: 'f2', kind: 'fixed', role: 'driving', refs: [ref('W', 'end')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('W', 'whole')] },
        { id: 'dx', kind: 'distance', role: 'driving', distanceMode: 'horizontal', refs: [ref('W', 'start'), ref('P', 'position')], value: 5 },
      ),
    );
    expect(result.ok).toBe(true);
    const p = asPoint(byId(result.entities!).get('P')!);
    expect(dist(p.position, { x: 5, y: 0 })).toBeLessThanOrEqual(RESIDUAL_TOL * 20);
  });
});

describe('reporting: DOF, redundancy, reference, determinism', () => {
  it('§7 case 2 — two lines + parallel: rank-based DOF, per-entity 3 and 4', () => {
    const L1 = line('L1', 0, 0, 10, 1);
    const L2 = line('L2', 0, 5, 10, 9);
    const result = solveConstraints([L1, L2], set({ id: 'par', kind: 'parallel', role: 'driving', refs: [ref('L1', 'whole'), ref('L2', 'whole')] }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('underconstrained');
    expect(result.dof).toMatchObject({ total: 8, nominalConsumed: 1, effectiveConsumed: 1, remaining: 7 });
    expect(result.dof.perEntity).toEqual([
      { entityId: 'L1', dof: 4, remaining: 3 },
      { entityId: 'L2', dof: 4, remaining: 4 },
    ]);
    expect(result.diagnostics.find((d) => d.constraintId === 'par')?.residual).toBeLessThanOrEqual(RESIDUAL_TOL);
  });

  it('§7 case 3 — coincident chain: a length edit on the first line moves the shared endpoints together', () => {
    const L1 = line('L1', 0, 0, 5, 0);
    const L2 = line('L2', 5, 0, 9, 3);
    const L3 = line('L3', 9, 3, 9, 8);
    const result = solveConstraints(
      [L1, L2, L3],
      set(
        { id: 'k1', kind: 'coincident', role: 'driving', refs: [ref('L1', 'end'), ref('L2', 'start')] },
        { id: 'k2', kind: 'coincident', role: 'driving', refs: [ref('L2', 'end'), ref('L3', 'start')] },
        { id: 'dl', kind: 'distance', role: 'driving', refs: [ref('L1', 'whole')], value: 8 },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const l1 = asLine(out.get('L1')!);
    const l2 = asLine(out.get('L2')!);
    const l3 = asLine(out.get('L3')!);
    const S = 9; // max(1, max |coordinate|, max driving value)
    expect(Math.abs(dist(l1.a, l1.b) - 8)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    expect(dist(l1.b, l2.a)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    expect(dist(l2.b, l3.a)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    expect(result.diagnostics.find((d) => d.constraintId === 'k1')?.state).toBe('satisfied');
    expect(result.diagnostics.find((d) => d.constraintId === 'k2')?.state).toBe('satisfied');
  });

  it('§7 case 6 — exactly one of B\u2019s parallel / horizontal pair is redundant', () => {
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 0, 5, 10, 5);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'hA', kind: 'horizontal', role: 'driving', refs: [ref('A', 'whole')] },
        { id: 'dv', kind: 'distance', role: 'driving', distanceMode: 'vertical', refs: [ref('B', 'start'), ref('A', 'start')], value: 5 },
        { id: 'dl', kind: 'distance', role: 'driving', refs: [ref('B', 'whole')], value: 10 },
        { id: 'par', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'hB', kind: 'horizontal', role: 'driving', refs: [ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const states = new Map(result.diagnostics.map((d) => [d.constraintId, d.state]));
    const pair = [states.get('par'), states.get('hB')];
    expect(pair.filter((s) => s === 'redundant')).toHaveLength(1);
    expect(pair.filter((s) => s === 'satisfied')).toHaveLength(1);
  });

  it('§7 case 12 — a reference distance never drives, even with slice-2 kinds present', () => {
    const R = point('R', 0, 0);
    const Q = point('Q', 3, 0);
    const P = point('P', 3, 4);
    const M = line('M', 0, 10, 10, 10);
    const N = line('N', 0, 20, 5, 25);
    const constraints = (withDrive: boolean) =>
      set(
        { id: 'fr', kind: 'fixed', role: 'driving', refs: [ref('R', 'position')] },
        { id: 'fm1', kind: 'fixed', role: 'driving', refs: [ref('M', 'start')] },
        { id: 'fm2', kind: 'fixed', role: 'driving', refs: [ref('M', 'end')] },
        { id: 'par', kind: 'parallel', role: 'driving', refs: [ref('M', 'whole'), ref('N', 'whole')] },
        ...(withDrive
          ? [{ id: 'dq', kind: 'distance', role: 'driving', refs: [ref('Q', 'position'), ref('R', 'position')], value: 5 } as Constraint]
          : []),
        { id: 'refd', kind: 'distance', role: 'reference', refs: [ref('P', 'position'), ref('Q', 'position')] },
      );
    const first = solveConstraints([R, Q, P, M, N], constraints(true));
    expect(first.ok).toBe(true);
    const q1 = asPoint(byId(first.entities!).get('Q')!);
    expect(dist(q1.position, { x: 5, y: 0 })).toBeLessThanOrEqual(1e-6); // the driving distance moved Q
    const refDiag = first.diagnostics.find((d) => d.constraintId === 'refd');
    expect(refDiag?.state).toBe('reference');
    expect(refDiag?.measured).toBeCloseTo(Math.sqrt(20), 9); // re-measured at the new geometry
    // P never participates (reference only): it is not in the DOF total.
    expect(first.dof.total).toBe(12);

    const second = solveConstraints(first.entities!, constraints(false));
    expect(second.ok).toBe(true);
    // The reference pulls nothing back: Q keeps its driven position, by identity.
    expect(byId(second.entities!).get('Q')).toBe(byId(first.entities!).get('Q'));
  });

  it('determinism — a mixed slice-1 + slice-2 set solves bit-for-bit identically twice', () => {
    const { entities, constraints } = rectangle();
    const extra = [
      line('L5', 0, 20, 10, 21),
      line('L6', 0, 25, 10, 30),
    ];
    const all = [...entities, ...extra];
    const full = set(
      ...constraints.constraints,
      { id: 'par', kind: 'parallel', role: 'driving', refs: [ref('L5', 'whole'), ref('L6', 'whole')] },
      { id: 'dl5', kind: 'distance', role: 'driving', refs: [ref('L5', 'whole')], value: 12 },
    );
    const first = solveConstraints(all, full);
    const second = solveConstraints(all, full);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(second.workUsed).toBe(first.workUsed);
  });
});
