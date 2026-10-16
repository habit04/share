/**
 * Priority 30 review corrections — solver correctness group (R02, R03,
 * R04, R12). Each test is a reproduction of an independent-review finding
 * against the delivered solver: it failed on the delivered code and must
 * pass after the correction. Tolerances asserted are the design §5.5
 * constants or tighter absolute bounds — never looser local ones.
 */
import { describe, expect, it } from 'vitest';
import { blockTransform, polylineVertices, type ArcEntity, type CircleEntity, type Entity, type LineEntity, type PointEntity, type PolylineEntity } from '../src/core/entities';
import { resolveAnchorPoint, type Constraint, type ConstraintSet } from '../src/core/constraints/model';
import { analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';

const base = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ ...base, id, type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ ...base, id, type: 'circle', center: { x: cx, y: cy }, radius: r });
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): ArcEntity => ({ ...base, id, type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) => ({ entityId, anchor, ...(index !== undefined ? { index } : {}) });
const byId = (entities: readonly Entity[]) => new Map(entities.map((e) => [e.id, e]));
const diag = (r: ReturnType<typeof solveConstraints>, id: string) => r.diagnostics.find((d) => d.constraintId === id);
const pdist = (a: PointEntity, b: PointEntity) => Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);

// ---------------------------------------------------------------------------
// R02 — driving-distance accuracy must be independent of world-coordinate
// translation. Residuals are normalized by the component scale S (design
// §5.4); at |coordinates| ≳ 1e9, RESIDUAL_TOL·S ≥ 1 drawing unit, so the
// delivered engine reported a driving distance of 11 "satisfied" while
// the points were still 10 apart. Satisfaction of a length-dimensional
// driving constraint is now also verified unnormalized, against the
// constraint's own (translation-invariant) scale.
// ---------------------------------------------------------------------------

describe('R02 — driving-distance accuracy is translation-invariant', () => {
  for (const ox of [0, 1e7, 1e9]) {
    it(`two free points drawn 10 apart are moved to the driving distance 11 at offset ${ox}`, () => {
      const entities = [point('P', ox, 0), point('Q', ox + 10, 0)];
      const result = solveConstraints(
        entities,
        set({ id: 'd', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] }),
      );
      expect(result.ok).toBe(true);
      const out = byId(result.entities!);
      const d = pdist(out.get('P') as PointEntity, out.get('Q') as PointEntity);
      expect(Math.abs(d - 11)).toBeLessThanOrEqual(1e-6);
      expect(diag(result, 'd')?.state).toBe('satisfied');
      expect(Math.abs((diag(result, 'd')?.measured ?? NaN) - 11)).toBeLessThanOrEqual(1e-6);
    });
  }

  it('analysis of the unsolved geometry at 1e9 does not report the distance satisfied', () => {
    const entities = [point('P', 1e9, 0), point('Q', 1e9 + 10, 0)];
    const analysis = analyzeConstraints(
      entities,
      set({ id: 'd', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] }),
    );
    expect(analysis.status).toBe('unsolved');
    const d = analysis.diagnostics.find((x) => x.constraintId === 'd');
    expect(d?.state).not.toBe('satisfied');
    expect(d?.measured).toBe(10);
  });

  it('a fixed point stays put and the free point moves to 11 at offset 1e9', () => {
    const P = point('P', 1e9, 0);
    const Q = point('Q', 1e9 + 10, 0);
    const result = solveConstraints(
      [P, Q],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'd', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    expect(Math.abs(pdist(out.get('P') as PointEntity, out.get('Q') as PointEntity) - 11)).toBeLessThanOrEqual(1e-6);
    const movedP = out.get('P') as PointEntity;
    expect(Math.hypot(movedP.position.x - 1e9, movedP.position.y)).toBeLessThanOrEqual(1e-6);
  });

  it('two fixed points 10 apart with a driving distance of 11 conflict — at the origin and at 1e9 alike', () => {
    for (const ox of [0, 1e9]) {
      const entities = [point('P', ox, 0), point('Q', ox + 10, 0)];
      const result = solveConstraints(
        entities,
        set(
          { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
          { id: 'fq', kind: 'fixed', role: 'driving', refs: [ref('Q', 'position')] },
          { id: 'd', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] },
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe('conflicting');
      expect(result.failure?.code).toBe('conflicting-constraints');
      expect(result.failure?.constraintIds).toContain('d');
      expect(result.entities).toBeUndefined();
      expect(diag(result, 'd')?.state).toBe('violated');
    }
  });

  it('a driving radius at 1e9 actually changes the radius (10 driven to 11)', () => {
    const C = circle('C', 1e9, 1e9, 10);
    const result = solveConstraints([C], set({ id: 'r', kind: 'radius', role: 'driving', value: 11, refs: [ref('C', 'whole')] }));
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('C') as CircleEntity;
    expect(Math.abs(out.radius - 11)).toBeLessThanOrEqual(1e-6);
    expect(diag(result, 'r')?.state).toBe('satisfied');
  });

  it('a distance already at its driving value at 1e9 solves without moving anything', () => {
    const P = point('P', 1e9, 0);
    const Q = point('Q', 1e9 + 11, 0);
    const result = solveConstraints(
      [P, Q],
      set({ id: 'd', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] }),
    );
    expect(result.ok).toBe(true);
    expect(result.entities![0]).toBe(P);
    expect(result.entities![1]).toBe(Q);
    expect(diag(result, 'd')?.state).toBe('satisfied');
  });

  it('a reference distance at 1e9 still only measures — it never drives', () => {
    const P = point('P', 1e9, 0);
    const Q = point('Q', 1e9 + 10, 0);
    const result = solveConstraints([P, Q], set({ id: 'rd', kind: 'distance', role: 'reference', refs: [ref('P', 'position'), ref('Q', 'position')] }));
    expect(result.ok).toBe(true);
    expect(result.entities![0]).toBe(P);
    expect(result.entities![1]).toBe(Q);
    expect(diag(result, 'rd')?.state).toBe('reference');
    expect(diag(result, 'rd')?.measured).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// R03 — a successful solve must not collapse valid segments. The delivered
// engine returned ok with zero-length geometry whenever the collapsing
// form was not one of the few the mid-solve check happened to watch
// (coincident pulls, H/V pairs, stage-2 constructions). Constructed and
// final geometry are now validated before any success is returned: a
// segment length or radius that was at/above the engine's own degenerate
// band (DEGENERATE_REL·S) at entry and falls below it in the result
// refuses the solve as degenerate-geometry instead.
// ---------------------------------------------------------------------------

describe('R03 — successful solves never collapse valid geometry', () => {
  it('coincident of a line’s own start and end refuses instead of returning a zero-length line', () => {
    const L = line('L', 0, 0, 5, 0);
    const result = solveConstraints([L], set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('L', 'end')] }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unsolved');
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.failure?.constraintIds).toContain('k');
    expect(result.entities).toBeUndefined();
  });

  it('horizontal + vertical on the same line refuses instead of collapsing it to a point', () => {
    const L = line('L', 0, 0, 5, 3);
    const result = solveConstraints(
      [L],
      set(
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
        { id: 'v', kind: 'vertical', role: 'driving', refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.failure?.constraintIds).toEqual(expect.arrayContaining(['h', 'v']));
    expect(result.entities).toBeUndefined();
  });

  it('stage-2 adoption of both endpoints onto one fixed point refuses (constructed collapse)', () => {
    const L = line('L', 0, 0, 5, 0);
    const P = point('P', 100, 100);
    const result = solveConstraints(
      [L, P],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'ka', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('P', 'position')] },
        { id: 'kb', kind: 'coincident', role: 'driving', refs: [ref('L', 'end'), ref('P', 'position')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.entities).toBeUndefined();
  });

  it('an equal-radius copy of a sub-band radius refuses instead of collapsing the partner circle', () => {
    const A = circle('A', 0, 0, 5);
    const B = circle('B', 20, 0, 1e-13);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'rb', kind: 'radius', role: 'driving', value: 1e-13, refs: [ref('B', 'whole')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.failure?.constraintIds).toContain('eq');
    expect(result.entities).toBeUndefined();
  });

  it('equal length against a fully-fixed sub-band segment refuses instead of shrinking the free line into the band', () => {
    const L1 = line('L1', 0, 0, 5, 0);
    const L2 = line('L2', 0, 10, 1e-13, 10);
    const result = solveConstraints(
      [L1, L2],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('L2', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('L2', 'end')] },
        { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('L1', 'whole'), ref('L2', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.entities).toBeUndefined();
  });

  it('a polyline segment pulled coincident with its neighbour refuses', () => {
    const PL = {
      ...base,
      id: 'PL',
      type: 'polyline' as const,
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
      ],
      closed: false,
    };
    const result = solveConstraints([PL], set({ id: 'k', kind: 'coincident', role: 'driving', refs: [ref('PL', 'vertex', 0), ref('PL', 'vertex', 1)] }));
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('degenerate-geometry');
    expect(result.entities).toBeUndefined();
  });

  it('shrinking a segment to a small but above-band length still succeeds', () => {
    const L = line('L', 0, 0, 5, 0);
    const result = solveConstraints([L], set({ id: 'd', kind: 'distance', role: 'driving', value: 1e-6, refs: [ref('L', 'whole')] }));
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('L') as LineEntity;
    expect(Math.hypot(out.b.x - out.a.x, out.b.y - out.a.y)).toBeCloseTo(1e-6, 12);
  });

  it('geometry already below the band at entry is not a collapse when it relocates at the same size', () => {
    // The tiny line is adopted onto two fixed points 1e-13 apart: it
    // moves across the drawing but its (sub-band) length never changes,
    // so nothing that was valid at entry collapsed — the solve succeeds.
    const L = line('L', 0, 0, 1e-13, 0);
    const P = point('P', 100, 100);
    const Q = point('Q', 100 + 1e-13, 100);
    const result = solveConstraints(
      [L, P, Q],
      set(
        { id: 'fp', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'fq', kind: 'fixed', role: 'driving', refs: [ref('Q', 'position')] },
        { id: 'ka', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('P', 'position')] },
        { id: 'kb', kind: 'coincident', role: 'driving', refs: [ref('L', 'end'), ref('Q', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('L') as LineEntity;
    expect(out.a).toEqual({ x: 100, y: 100 });
    const len = Math.hypot(out.b.x - out.a.x, out.b.y - out.a.y);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(1e-12);
  });
});

// ---------------------------------------------------------------------------
// R04 — derived-anchor grounding. `fixed` on an arc endpoint is a point
// constraint on the derived endpoint position (center + radius∠angle):
// two equations. The delivered engine's stage-2 rule 1 marked EVERY
// variable the endpoint expression reads as determined — center x/y,
// radius and angle — freezing the arc, so a feasible radius edit then
// "conflicted" against the frozen center. Only an anchor that IS a
// variable pair grounds variables now; derived anchors (arc endpoints,
// midpoints) are solved by their residuals in stage 3.
// ---------------------------------------------------------------------------

describe('R04 — fixing a derived anchor does not freeze its underlying variables', () => {
  it('fixed arc start + radius edit 5 → 8 solves: endpoint stays, center moves, radius changes', () => {
    const A = arc('A', 0, 0, 5, 0, Math.PI / 2);
    const result = solveConstraints(
      [A],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 8, refs: [ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('A') as ArcEntity;
    expect(out.radius).toBeCloseTo(8, 9);
    const start = resolveAnchorPoint(out, ref('A', 'start'));
    expect(Math.hypot(start.x - 5, start.y)).toBeLessThanOrEqual(1e-6);
    // The center must have moved to (-3, 0): the endpoint can only stay
    // at (5, 0) with radius 8 if it did.
    expect(Math.hypot(out.center.x + 3, out.center.y)).toBeLessThanOrEqual(1e-6);
    expect(diag(result, 'f')?.state).toBe('satisfied');
    expect(diag(result, 'rad')?.state).toBe('satisfied');
  });

  it('fixed arc end + radius edit 5 → 3 solves symmetrically', () => {
    const A = arc('A', 0, 0, 5, 0, Math.PI / 2);
    const result = solveConstraints(
      [A],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 3, refs: [ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('A') as ArcEntity;
    expect(out.radius).toBeCloseTo(3, 9);
    const end = resolveAnchorPoint(out, ref('A', 'end'));
    expect(Math.hypot(end.x, end.y - 5)).toBeLessThanOrEqual(1e-6);
  });

  it('both arc endpoints fixed + feasible radius 8 solves with the endpoints unmoved', () => {
    const A = arc('A', 0, 0, 5, 0, Math.PI / 2);
    const result = solveConstraints(
      [A],
      set(
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fe', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 8, refs: [ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!).get('A') as ArcEntity;
    expect(out.radius).toBeCloseTo(8, 9);
    const start = resolveAnchorPoint(out, ref('A', 'start'));
    const end = resolveAnchorPoint(out, ref('A', 'end'));
    expect(Math.hypot(start.x - 5, start.y)).toBeLessThanOrEqual(1e-6);
    expect(Math.hypot(end.x, end.y - 5)).toBeLessThanOrEqual(1e-6);
  });

  it('both arc endpoints fixed + radius 3 (below the chord’s minimum) still conflicts honestly', () => {
    // Endpoints (5,0) and (0,5) are √50 apart; no circle of radius 3
    // passes through both (r must be ≥ √50/2 ≈ 3.54). The verdict must
    // stay a conflict — the R04 fix must not manufacture success.
    const A = arc('A', 0, 0, 5, 0, Math.PI / 2);
    const result = solveConstraints(
      [A],
      set(
        { id: 'fs', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fe', kind: 'fixed', role: 'driving', refs: [ref('A', 'end')] },
        { id: 'rad', kind: 'radius', role: 'driving', value: 3, refs: [ref('A', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflicting');
    expect(result.failure?.code).toBe('conflicting-constraints');
    expect(result.entities).toBeUndefined();
  });

  it('fixed line midpoint does not freeze the endpoints: a distance edit from the midpoint still solves', () => {
    const L = line('L', 0, 0, 10, 0);
    const P = point('P', 5, 8);
    const result = solveConstraints(
      [L, P],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'midpoint')] },
        { id: 'd', kind: 'distance', role: 'driving', value: 4, refs: [ref('L', 'midpoint'), ref('P', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    const solvedL = out.get('L') as LineEntity;
    const mid = { x: (solvedL.a.x + solvedL.b.x) / 2, y: (solvedL.a.y + solvedL.b.y) / 2 };
    expect(Math.hypot(mid.x - 5, mid.y)).toBeLessThanOrEqual(1e-6);
    const solvedP = out.get('P') as PointEntity;
    expect(Math.hypot(solvedP.position.x - mid.x, solvedP.position.y - mid.y)).toBeCloseTo(4, 6);
  });
});

// ---------------------------------------------------------------------------
// R12 — unknown rank/DOF must be reported honestly when rank work is
// skipped. When the §3.3 rank probe exceeds the work budget, the
// delivered engine set per-entity remaining to the stated unknown (-1)
// but still fabricated the OVERALL figures: skipped components
// contributed 0 to effectiveConsumed, so `remaining` came out as a
// positive invented number and the status read 'underconstrained' —
// for a chain that is in truth fully constrained. Now: when any
// component's rank probe is skipped, effectiveConsumed and remaining
// are the stated unknown (-1) and the status is 'rank-unknown' — the
// solved geometry is still reported, but no DOF verdict is invented.
// ---------------------------------------------------------------------------

describe('R12 — skipped rank work reports unknown DOF, not an invented verdict', () => {
  /** 30 points chained coincident onto a fixed first point: truly
   *  fully constrained (60 variables, rank 60). The solve itself is
   *  cheap (stage-2 adoption); the rank probes are what cost. */
  function chain() {
    const entities: Entity[] = [point('P0', 0, 0)];
    const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('P0', 'position')] }];
    for (let i = 1; i < 30; i += 1) {
      entities.push(point(`P${i}`, i * 1.7, (i % 5) * 2.3));
      constraints.push({ id: `c${i}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i - 1}`, 'position'), ref(`P${i}`, 'position')] });
    }
    return { entities, constraints: set(...constraints) };
  }

  it('control: with the full budget the chain is fully-constrained with real figures', () => {
    const { entities, constraints } = chain();
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('fully-constrained');
    expect(result.dof.effectiveConsumed).toBe(60);
    expect(result.dof.remaining).toBe(0);
  });

  it('with a budget that skips the rank probe: geometry solves, DOF is the stated unknown, status is rank-unknown', () => {
    const { entities, constraints } = chain();
    const result = solveConstraints(entities, constraints, { workLimit: 2500 });
    expect(result.ok).toBe(true);
    // The geometry itself solved — every point adopted onto P0.
    for (const e of result.entities!) expect((e as PointEntity).position).toEqual({ x: 0, y: 0 });
    // But no DOF verdict may be invented.
    expect(result.status).toBe('rank-unknown');
    expect(result.status).not.toBe('underconstrained');
    expect(result.dof.effectiveConsumed).toBe(-1);
    expect(result.dof.remaining).toBe(-1);
    expect(result.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
    // Total and nominal figures are exact counts, not rank claims.
    expect(result.dof.total).toBe(60);
    expect(result.dof.nominalConsumed).toBe(60);
  });

  it('a system with one probed and one skipped component still reports the overall DOF as unknown', () => {
    // Component A (first in input order): two points, fixed + coincident
    // — its probes are cheap and run. Component B: a 40-point chain
    // whose Jacobian probe (79 rows × 80 vars) blows the budget.
    const entities: Entity[] = [point('A0', 0, 0), point('A1', 3, 4), point('B0', 100, 100)];
    const constraints: Constraint[] = [
      { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A0', 'position')] },
      { id: 'ca', kind: 'coincident', role: 'driving', refs: [ref('A0', 'position'), ref('A1', 'position')] },
      { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B0', 'position')] },
    ];
    for (let i = 1; i < 40; i += 1) {
      entities.push(point(`B${i}`, 100 + i * 1.3, 100 + (i % 4) * 1.9));
      constraints.push({ id: `cb${i}`, kind: 'coincident', role: 'driving', refs: [ref(`B${i - 1}`, 'position'), ref(`B${i}`, 'position')] });
    }
    const result = solveConstraints(entities, set(...constraints), { workLimit: 3000 });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('rank-unknown');
    expect(result.dof.effectiveConsumed).toBe(-1);
    expect(result.dof.remaining).toBe(-1);
    // The skipped component's entities report the per-entity unknown.
    expect(result.dof.perEntity.filter((p) => p.entityId.startsWith('B')).every((p) => p.remaining === -1)).toBe(true);
  });
});

describe('R03 residual — H/V construction must not collapse a segment (review case A)', () => {
  it('vertical line + fixed start + horizontal rotates the free end, preserving length; re-solve ok', () => {
    const entities = [line('L', 0, 0, 0, 10)];
    const cs = set(
      { id: 'fx', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
      { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
    );
    const r = solveConstraints(entities, cs);
    expect(r.ok).toBe(true);
    const out = r.entities![0] as LineEntity;
    // Length preserved (10), horizontal, non-degenerate.
    expect(Math.hypot(out.b.x - out.a.x, out.b.y - out.a.y)).toBeCloseTo(10, 9);
    expect(out.b.y).toBeCloseTo(out.a.y, 9);
    // The installed result is itself solvable (no degenerate refusal).
    expect(solveConstraints(r.entities!, cs).ok).toBe(true);
  });

  it('the healthy coordinate copy is unchanged when the copy does not degenerate the segment', () => {
    // Slightly off-vertical line: the copy sets b.y := a.y and keeps b.x.
    const entities = [line('L', 0, 0, 3, 10)];
    const cs = set(
      { id: 'fx', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
      { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
    );
    const r = solveConstraints(entities, cs);
    expect(r.ok).toBe(true);
    const out = r.entities![0] as LineEntity;
    expect(out.b.x).toBeCloseTo(3, 9);
    expect(out.b.y).toBeCloseTo(0, 9);
  });
});

describe('R05 residual — solved framed polylines stay coherent (review case B)', () => {
  const framedSource = (): PolylineEntity => {
    const source: PolylineEntity = { ...base, id: 'P', type: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 3 }], closed: false, width: 1 };
    return blockTransform(source, (p) => ({ x: p.x * 2, y: p.y }), 0, 2, 1, false) as PolylineEntity;
  };

  it('affine (scale 2,1) framed polyline: display points and frame-derived vertices agree after solve', () => {
    const framed = framedSource();
    expect(framed.widthFrame).toBeDefined();
    const cs = set(
      { id: 'fx', kind: 'fixed', role: 'driving', refs: [ref('P', 'start')] },
      { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('P', 'segment', 0)] },
    );
    const r = solveConstraints([framed], cs);
    expect(r.ok).toBe(true);
    const out = r.entities![0] as PolylineEntity;
    expect(out.points[1]!.y).toBe(0);
    // The frame-derived display vertex reads the same point.
    expect(polylineVertices(out)[1]!.y).toBe(0);
    expect(polylineVertices(out)[1]!.x).toBeCloseTo(out.points[1]!.x, 9);
    // The frame is retained (width semantics live there), axes unchanged.
    expect(out.widthFrame).toBeDefined();
    expect(out.widthFrame!.x).toEqual(framed.widthFrame!.x);
    expect(out.widthFrame!.y).toEqual(framed.widthFrame!.y);
  });

  it('a framed polyline whose constraints move no vertex is returned by identity', () => {
    const framed = framedSource();
    const cs = set({ id: 'fx', kind: 'fixed', role: 'driving', refs: [ref('P', 'start')] });
    const r = solveConstraints([framed], cs);
    expect(r.ok).toBe(true);
    expect(r.entities![0]).toBe(framed);
  });

  it('a degenerate width frame is refused as invalid input, never thrown', () => {
    const framed = framedSource();
    const broken: PolylineEntity = { ...framed, widthFrame: { ...framed.widthFrame!, x: { x: 0, y: 0 } } };
    const r = solveConstraints([broken], set({ id: 'fx', kind: 'fixed', role: 'driving', refs: [ref('P', 'start')] }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.code === 'invalid-value')).toBe(true);
  });
});
