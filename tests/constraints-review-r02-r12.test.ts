/**
 * Priority 30 review corrections — solver correctness group (R02, R03,
 * R04, R12). Each test is a reproduction of an independent-review finding
 * against the delivered solver: it failed on the delivered code and must
 * pass after the correction. Tolerances asserted are the design §5.5
 * constants or tighter absolute bounds — never looser local ones.
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
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
