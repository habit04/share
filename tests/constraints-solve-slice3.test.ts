/**
 * Priority 30.3.3 — solver acceptance tests (design §7, slice-3 cases):
 * tangent (line–curve, circle–circle with the entry branch), equal in
 * its mixed forms, concentric solved by relaxation, diameter ≡ radius,
 * case 9(iii), and point-on-object coincident on a polyline 'whole'
 * (minimum over segments, bulge-carried reporting).
 * Tolerances asserted are the §5.5 constants, never looser local ones.
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { RESIDUAL_TOL, analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';

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
const asArc = (e: Entity) => e as ArcEntity;
const asPoint = (e: Entity) => e as PointEntity;
const asPolyline = (e: Entity) => e as PolylineEntity;
const diag = (r: { diagnostics: readonly { constraintId: string }[] }, id: string) => r.diagnostics.find((d) => d.constraintId === id)! as { state: string; residual: number; measured?: number; branch?: string };

/** Distance from a point to the infinite line through a solved line entity. */
function distToLine(p: { x: number; y: number }, l: LineEntity): number {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const L = Math.hypot(dx, dy);
  return Math.abs(dx * (p.y - l.a.y) - dy * (p.x - l.a.x)) / L;
}

/** Foot of the perpendicular from p onto the line through l. */
function foot(p: { x: number; y: number }, l: LineEntity): { x: number; y: number } {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const t = ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / (dx * dx + dy * dy);
  return { x: l.a.x + t * dx, y: l.a.y + t * dy };
}

/** Minimum distance from p to a polyline's segments (the §2.1 'whole'
 *  reading), computed independently of the solver. */
function distToPolyline(p: { x: number; y: number }, pl: PolylineEntity): number {
  const pts = pl.points;
  const segCount = pl.closed ? pts.length : pts.length - 1;
  let best = Infinity;
  for (let i = 0; i < segCount; i += 1) {
    const A = pts[i]!;
    const B = pts[(i + 1) % pts.length]!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.min(1, Math.max(0, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy)));
  }
  return best;
}

describe('tangent line–circle (§7 case 14)', () => {
  const S = 20; // max(1, |coords| ≤ 10, values ≤ 20)
  const fixture = (radius: number) => ({
    entities: [circle('C', 0, 0, 5), line('L', -10, 5, 10, 5)],
    constraints: set(
      { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
      { id: 'rad', kind: 'radius', role: 'driving', value: radius, refs: [ref('C', 'whole')] },
      { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
      { id: 'len', kind: 'distance', role: 'driving', value: 20, refs: [ref('L', 'whole')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] },
    ),
  });

  it('already tangent at the driving radius: nothing moves', () => {
    const { entities, constraints } = fixture(5);
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(result.entities![0]).toBe(entities[0]);
    expect(result.entities![1]).toBe(entities[1]);
    expect(diag(result, 'tan').state).toBe('satisfied');
  });

  it('radius 5 → 9: the line re-tangents, the tangent point slides, the start stays', () => {
    const { entities, constraints } = fixture(9);
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(diag(result, 'tan').residual).toBeLessThanOrEqual(RESIDUAL_TOL);
    expect(diag(result, 'rad').measured).toBeCloseTo(9, 9);
    const out = byId(result.entities!);
    const solved = asLine(out.get('L')!);
    // Distance from the circle center to the solved line is the radius.
    expect(Math.abs(distToLine({ x: 0, y: 0 }, solved) - 9)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    // Length is still the driving 20.
    expect(diag(result, 'len').measured!).toBeCloseTo(20, 7);
    // The fixed start is a stage-3 row: it holds to the residual bound
    // (§5.4 releases determined variables a residual touches; case 14's
    // "bit-identical" is asserted here to the §5.5 bound instead — see
    // the slice-3.2 finding on bit-identity under the release rule).
    expect(Math.hypot(solved.a.x - -10, solved.a.y - 5)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    // The line rotated: its end left y = 5, and the tangent point slid
    // away from (0, 5).
    expect(Math.abs(solved.b.y - 5)).toBeGreaterThan(0.5);
    const f = foot({ x: 0, y: 0 }, solved);
    expect(Math.hypot(f.x - 0, f.y - 5)).toBeGreaterThan(0.5);
    // The circle kept its center and took the driving radius.
    const c = asCircle(out.get('C')!);
    expect(Math.hypot(c.center.x, c.center.y)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    expect(Math.abs(c.radius - 9)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
  });

  it('a non-tangent start is pulled into tangency (hand-computed direction)', () => {
    // Line y = 3 (distance 3 from the center), radius 5: the line must
    // rotate about its fixed start until the center distance is 5.
    const entities = [circle('C', 0, 0, 5), line('L', -10, 3, 10, 3)];
    const result = solveConstraints(
      entities,
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 5, refs: [ref('C', 'whole')] },
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'len', kind: 'distance', role: 'driving', value: 20, refs: [ref('L', 'whole')] },
        { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const solved = asLine(byId(result.entities!).get('L')!);
    expect(Math.abs(distToLine({ x: 0, y: 0 }, solved) - 5)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
    expect(Math.hypot(solved.a.x - -10, solved.a.y - 3)).toBeLessThanOrEqual(RESIDUAL_TOL * S);
  });
});

describe('tangent circle–circle: entry branch (§5.4)', () => {
  it('external: the free radius closes dist = r1 + r2; branch is recorded', () => {
    const entities = [circle('A', 0, 0, 3), circle('B', 10, 0, 6)];
    const constraints = set(
      { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
      { id: 'ra', kind: 'radius', role: 'driving', value: 3, refs: [ref('A', 'whole')] },
      { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B', 'center')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
    );
    const analysis = analyzeConstraints(entities, constraints);
    expect(diag(analysis, 'tan').branch).toBe('external');

    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(diag(result, 'tan').branch).toBe('external');
    expect(diag(result, 'tan').residual).toBeLessThanOrEqual(RESIDUAL_TOL);
    const b = asCircle(byId(result.entities!).get('B')!);
    expect(Math.abs(b.radius - 7)).toBeLessThanOrEqual(RESIDUAL_TOL * 10); // dist 10 − rA 3
    expect(Math.hypot(b.center.x - 10, b.center.y)).toBeLessThanOrEqual(RESIDUAL_TOL * 10); // fixed row, §5.5 bound
  });

  it('external under a radius edit: rA 3 → 4 moves rB 7 → 6', () => {
    const entities = [circle('A', 0, 0, 4), circle('B', 10, 0, 7)];
    const result = solveConstraints(
      entities,
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
        { id: 'ra', kind: 'radius', role: 'driving', value: 4, refs: [ref('A', 'whole')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B', 'center')] },
        { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const b = asCircle(byId(result.entities!).get('B')!);
    expect(Math.abs(b.radius - 6)).toBeLessThanOrEqual(RESIDUAL_TOL * 10);
  });

  it('internal: a circle inside another stays on the internal branch', () => {
    // dist 3, entry radii 10 and 6: 3 < |10 − 6| ⇒ internal at entry;
    // the free radius solves |10 − rB| = 3 ⇒ rB = 7.
    const entities = [circle('A', 0, 0, 10), circle('B', 3, 0, 6)];
    const result = solveConstraints(
      entities,
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
        { id: 'ra', kind: 'radius', role: 'driving', value: 10, refs: [ref('A', 'whole')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B', 'center')] },
        { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('B', 'whole'), ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(diag(result, 'tan').branch).toBe('internal');
    const b = asCircle(byId(result.entities!).get('B')!);
    expect(Math.abs(b.radius - 7)).toBeLessThanOrEqual(RESIDUAL_TOL * 10);
  });

  it('tangent to an arc uses its circle carrier', () => {
    const entities = [arc('Arc', 0, 0, 5, 1.2, 2.0), line('L', -10, 5, 10, 5)];
    const constraints = (radius: number) =>
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('Arc', 'center')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: radius, refs: [ref('Arc', 'whole')] },
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'len', kind: 'distance', role: 'driving', value: 20, refs: [ref('L', 'whole')] },
        // §2.2: for tangent, refs[0] is the line/segment.
        { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('Arc', 'whole')] },
      );
    const atFive = solveConstraints(entities, constraints(5));
    expect(atFive.ok).toBe(true);
    expect(atFive.entities![1]).toBe(entities[1]); // already tangent: line untouched
    const atSix = solveConstraints(entities, constraints(6));
    expect(atSix.ok).toBe(true);
    const solved = asLine(byId(atSix.entities!).get('L')!);
    expect(Math.abs(distToLine({ x: 0, y: 0 }, solved) - 6)).toBeLessThanOrEqual(RESIDUAL_TOL * 20);
    const a = asArc(byId(atSix.entities!).get('Arc')!);
    expect(a.startAngle).toBe(1.2); // carrier only: angles are not tangent variables
    expect(a.endAngle).toBe(2.0);
  });

  it('tangent on a polyline segment side', () => {
    const entities = [circle('C', 0, 0, 5), polyline('PL', [[-10, 5], [10, 5], [10, 15]])];
    const result = solveConstraints(
      entities,
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 7, refs: [ref('C', 'whole')] },
        { id: 'fv', kind: 'fixed', role: 'driving', refs: [ref('PL', 'vertex', 0)] },
        { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('PL', 'segment', 0), ref('C', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const pl = asPolyline(byId(result.entities!).get('PL')!);
    const seg: LineEntity = { ...base, id: 'seg', type: 'line', a: pl.points[0]!, b: pl.points[1]! };
    expect(Math.abs(distToLine({ x: 0, y: 0 }, seg) - 7)).toBeLessThanOrEqual(RESIDUAL_TOL * 15);
    expect(Math.hypot(pl.points[0]!.x - -10, pl.points[0]!.y - 5)).toBeLessThanOrEqual(RESIDUAL_TOL * 15);
    expect(pl.points[2]).toEqual({ x: 10, y: 15 }); // not part of the segment: unmoved in value
  });

  it('stage 1: degenerate partners refuse before any motion', () => {
    const tiny = solveConstraints(
      [line('L', -10, 0, 10, 0), circle('C', 0, 5, 1e-13)],
      set({ id: 't', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] }),
    );
    expect(tiny.ok).toBe(false);
    expect(tiny.failure?.code).toBe('degenerate-geometry');
    expect(tiny.failure?.constraintIds).toEqual(['t']);

    const zeroLine = solveConstraints(
      [line('Z', 2, 2, 2, 2), circle('C', 0, 10, 5)],
      set({ id: 't', kind: 'tangent', role: 'driving', refs: [ref('Z', 'whole'), ref('C', 'whole')] }),
    );
    expect(zeroLine.ok).toBe(false);
    expect(zeroLine.failure?.code).toBe('degenerate-geometry');
    expect(zeroLine.failure?.constraintIds).toEqual(['t']);
  });
});

describe('equal in mixed forms (§8: equal length, full)', () => {
  it('line length drives a polyline segment length (rule 9 across forms)', () => {
    const L1 = line('L1', 0, 0, 10, 0);
    const PL = polyline('PL', [[0, 5], [6, 5], [6, 9]]);
    const result = solveConstraints(
      [L1, PL],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('L1', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('L1', 'end')] },
        { id: 'fv', kind: 'fixed', role: 'driving', refs: [ref('PL', 'vertex', 0)] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('PL', 'segment', 0)] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('L1', 'whole'), ref('PL', 'segment', 0)] },
      ),
    );
    expect(result.ok).toBe(true);
    const pl = asPolyline(byId(result.entities!).get('PL')!);
    expect(pl.points[1]).toEqual({ x: 10, y: 5 }); // rescaled about vertex 0 to length 10, exactly
    expect(pl.points[2]).toEqual({ x: 6, y: 9 });
    expect(diag(result, 'eq').state).toBe('satisfied');
  });

  it('equal radius between arc and circle follows the driving radius', () => {
    const A = arc('A', 0, 0, 9, 0.3, 1.1);
    const C = circle('C', 30, 0, 4);
    const result = solveConstraints(
      [A, C],
      set(
        { id: 'rad', kind: 'radius', role: 'driving', value: 6, refs: [ref('C', 'whole')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('C', 'whole'), ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(asArc(byId(result.entities!).get('A')!).radius).toBe(6);
    expect(asCircle(byId(result.entities!).get('C')!).radius).toBe(6);
    expect(asArc(byId(result.entities!).get('A')!).center).toEqual({ x: 0, y: 0 });
  });

  it('equal radius with nothing driving meets by relaxation', () => {
    const result = solveConstraints(
      [circle('C1', 0, 0, 4), circle('C2', 30, 0, 9)],
      set({ id: 'eq', kind: 'equal', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] }),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const r1 = asCircle(out.get('C1')!).radius;
    const r2 = asCircle(out.get('C2')!).radius;
    expect(Math.abs(r1 - r2)).toBeLessThanOrEqual(RESIDUAL_TOL * 30);
    expect(diag(result, 'eq').state).toBe('satisfied');
  });
});

describe('concentric solved, not just constructed (§7 case 13, full form)', () => {
  it('centers coupled through separate fixed points meet by relaxation', () => {
    // Neither center is groundable by construction: each is held only by
    // a distance to its own fixed point, on a shared circle around P —
    // construction has no locus for either, so stage 3 must solve the
    // concentric pair. The radii are settled by rules 5–6.
    const P = point('P', 0, 10);
    const A = circle('A', 10, 10, 5);
    const B = circle('B', 0, 20, 4);
    const result = solveConstraints(
      [P, A, B],
      set(
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'da', kind: 'distance', role: 'driving', value: 10, refs: [ref('A', 'center'), ref('P', 'position')] },
        { id: 'db', kind: 'distance', role: 'driving', value: 10, refs: [ref('B', 'center'), ref('P', 'position')] },
        { id: 'con', kind: 'concentric', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 3, refs: [ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('underconstrained'); // the shared point may still slide around P
    expect(result.dof.remaining).toBe(1);
    const out = byId(result.entities!);
    const a = asCircle(out.get('A')!);
    const b = asCircle(out.get('B')!);
    expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeLessThanOrEqual(RESIDUAL_TOL * 20);
    expect(Math.abs(Math.hypot(a.center.x - 0, a.center.y - 10) - 10)).toBeLessThanOrEqual(RESIDUAL_TOL * 20);
    expect(a.radius).toBeCloseTo(3, 9);
    expect(b.radius).toBeCloseTo(3, 9);
    expect(out.get('P')).toBe(P);
  });

  it('diameter ≡ 2 × radius, bit-identical outcomes (§7 case 18, full form)', () => {
    const mk = () => circle('C', 3, 4, 8);
    const viaDiameter = solveConstraints(
      [mk()],
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
        { id: 'dia', kind: 'diameter', role: 'driving', value: 20, refs: [ref('C', 'whole')] },
        { id: 'rr', kind: 'radius', role: 'reference', refs: [ref('C', 'whole')] },
      ),
    );
    expect(viaDiameter.ok).toBe(true);
    expect(asCircle(viaDiameter.entities![0]!).radius).toBe(10); // exactly value/2
    expect(diag(viaDiameter, 'rr').measured).toBe(10); // reference radius measures the result
    expect(diag(viaDiameter, 'dia').measured).toBe(20);

    const viaRadius = solveConstraints(
      [mk()],
      set(
        { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 10, refs: [ref('C', 'whole')] },
      ),
    );
    expect(viaRadius.ok).toBe(true);
    expect(viaRadius.entities![0]).toEqual(viaDiameter.entities![0]); // bit-identical geometry
  });
});

describe('degenerate by driving (§7 case 9(iii))', () => {
  it('line-length distance 0 refuses degenerate-geometry; point–point 0 is legal', () => {
    const L = line('L', 0, 0, 10, 0);
    const snapshot = JSON.stringify(L);
    const refused = solveConstraints([L], set({ id: 'dl', kind: 'distance', role: 'driving', value: 0, refs: [ref('L', 'whole')] }));
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe('unsolved');
    expect(refused.failure?.code).toBe('degenerate-geometry');
    expect(refused.failure?.constraintIds).toEqual(['dl']);
    expect(refused.entities).toBeUndefined();
    expect(JSON.stringify(L)).toBe(snapshot); // unchanged

    // The same value between two points is a coincidence request, and solves.
    const P = point('P', 0, 0);
    const Q = point('Q', 10, 0);
    const ok = solveConstraints(
      [P, Q],
      set(
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'dz', kind: 'distance', role: 'driving', value: 0, refs: [ref('P', 'position'), ref('Q', 'position')] },
      ),
    );
    expect(ok.ok).toBe(true);
    const q = asPoint(byId(ok.entities!).get('Q')!).position;
    expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(RESIDUAL_TOL * 10); // Q lands on P, §5.5 bound
  });

  it('a polyline segment length driven to 0 refuses the same way', () => {
    const PL = polyline('PL', [[0, 0], [10, 0], [10, 10]]);
    const refused = solveConstraints([PL], set({ id: 'dl', kind: 'distance', role: 'driving', value: 0, refs: [ref('PL', 'segment', 0)] }));
    expect(refused.ok).toBe(false);
    expect(refused.failure?.code).toBe('degenerate-geometry');
    expect(refused.failure?.constraintIds).toEqual(['dl']);
  });
});

describe('point-on-object on a polyline whole (§2.1 per segment)', () => {
  const PL = () => polyline('PL', [[0, 0], [10, 0], [10, 10]]);
  /** Pin every vertex so the polyline is the static object and the point
   *  does the traveling. (Unpinned, the form is symmetric: solver and
   *  object meet halfway — pinned down by the free-polyline test below.) */
  const pinned = (n: number): Constraint[] =>
    Array.from({ length: n }, (_, i) => ({ id: `fv${i}`, kind: 'fixed' as const, role: 'driving' as const, refs: [ref('PL', 'vertex', i)] }));
  const near = (p: { x: number; y: number }, x: number, y: number, s: number) =>
    expect(Math.hypot(p.x - x, p.y - y)).toBeLessThanOrEqual(RESIDUAL_TOL * s);

  it('the point lands on the nearest segment (interior projection)', () => {
    const P = point('P', 5, 4);
    const pl = PL();
    const result = solveConstraints([P, pl], set(...pinned(3), { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] }));
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    near(asPoint(out.get('P')!).position, 5, 0, 10);
    expect(out.get('PL')).toBe(pl); // the object did not have to move
    expect(result.notes).toEqual([]); // no bulges anywhere: no note
  });

  it('clamped projection: beyond the corner, the end segment wins', () => {
    const P = point('P', 14, 6);
    const pl = PL();
    const result = solveConstraints([P, pl], set(...pinned(3), { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] }));
    expect(result.ok).toBe(true);
    const p = asPoint(byId(result.entities!).get('P')!).position;
    // On segment 1 (x = 10), within the residual bound. The along-track
    // position is a null direction of the residual once the point is on
    // the segment, so only its span is asserted, not the exact landing.
    expect(distToPolyline(p, pl)).toBeLessThanOrEqual(RESIDUAL_TOL * 14);
    expect(Math.abs(p.x - 10)).toBeLessThanOrEqual(RESIDUAL_TOL * 14);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(10);
  });

  it('the closing segment of a closed polyline participates', () => {
    const P = point('P', -3, 5);
    const tri = polyline('PL', [[0, 0], [10, 0], [0, 10]], true);
    const result = solveConstraints([P, tri], set(...pinned(3), { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] }));
    expect(result.ok).toBe(true);
    near(asPoint(byId(result.entities!).get('P')!).position, 0, 5, 10);
  });

  it('a free polyline moves its nearest segment onto a fixed point', () => {
    const P = point('P', 5, 3);
    const pl = PL();
    const result = solveConstraints(
      [P, pl],
      set(
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const solved = asPolyline(out.get('PL')!);
    expect(distToPolyline({ x: 5, y: 3 }, solved)).toBeLessThanOrEqual(RESIDUAL_TOL * 10);
    expect(Math.hypot(asPoint(out.get('P')!).position.x - 5, asPoint(out.get('P')!).position.y - 3)).toBeLessThanOrEqual(RESIDUAL_TOL * 10);
    expect(solved.points[2]).toEqual({ x: 10, y: 10 }); // far vertex untouched in value
  });

  it('a bulged segment reports bulge-carried instead of pretending the arc is the chord', () => {
    const P = point('P', 5, 4);
    const pl = polyline('PL', [[0, 0], [10, 0], [10, 10]], false, [1, 0]); // segment 0 bulged
    const result = solveConstraints([P, pl], set(...pinned(3), { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] }));
    expect(result.ok).toBe(true);
    near(asPoint(byId(result.entities!).get('P')!).position, 5, 0, 10); // the segment reading
    expect(result.notes).toContainEqual({ code: 'bulge-carried', entityId: 'PL', constraintId: 'k' });
    // The bulge itself is carried data: the object is unmoved, bulges intact.
    expect(byId(result.entities!).get('PL')).toBe(pl);
  });
});

describe('determinism on a mixed slice 1–3 set', () => {
  it('two runs are identical, workUsed included', () => {
    const entities = [circle('C', 0, 0, 5), line('L', -10, 5, 10, 5), point('P', 5, 4), polyline('PL', [[0, 20], [10, 20], [10, 30]])];
    const constraints = set(
      { id: 'fc', kind: 'fixed', role: 'driving', refs: [ref('C', 'center')] },
      { id: 'rad', kind: 'radius', role: 'driving', value: 6, refs: [ref('C', 'whole')] },
      { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
      { id: 'len', kind: 'distance', role: 'driving', value: 20, refs: [ref('L', 'whole')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] },
      { id: 'k', kind: 'coincident', role: 'driving', refs: [ref('P', 'position'), ref('PL', 'whole')] },
    );
    const r1 = solveConstraints(entities, constraints);
    const r2 = solveConstraints(entities, constraints);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual(r1);
    expect(r2.workUsed).toBe(r1.workUsed);
  });
});
