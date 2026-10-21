/**
 * Priority 30.3.1 — constraint model + validation tests (design §2/§4).
 * Codes are asserted, never messages (design §5.7 note applies to §4 too).
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, LineEntity, PointEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import {
  anchorValidFor,
  entityDof,
  resolveAnchorPoint,
  type Constraint,
  type ConstraintSet,
} from '../src/core/constraints/model';
import { validateConstraints, type ConstraintProblem } from '../src/core/constraints/validate';

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
const text = (id: string): TextEntity => ({ ...base, id, type: 'text', position: { x: 0, y: 0 }, text: 'x', height: 1, rotation: 0, align: 'left' });

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const codes = (problems: readonly ConstraintProblem[]) => problems.map((p) => p.code);

describe('model: anchors and DOF', () => {
  it('computes per-entity DOF from the parametrization (§3.1)', () => {
    expect(entityDof(point('p', 0, 0))).toBe(2);
    expect(entityDof(line('l', 0, 0, 1, 1))).toBe(4);
    expect(entityDof(circle('c', 0, 0, 1))).toBe(3);
    expect(entityDof(arc('a', 0, 0, 1, 0, 1))).toBe(5);
    expect(entityDof(polyline('pl', [[0, 0], [1, 0], [1, 1]]))).toBe(6);
    expect(entityDof(text('t'))).toBe(0);
  });

  it('resolves derived anchors (arc endpoints, midpoints, closed-polyline end)', () => {
    const a = arc('a', 10, 20, 5, 0, Math.PI / 2);
    expect(resolveAnchorPoint(a, { entityId: 'a', anchor: 'start' })).toEqual({ x: 15, y: 20 });
    const end = resolveAnchorPoint(a, { entityId: 'a', anchor: 'end' });
    expect(end.x).toBeCloseTo(10, 12);
    expect(end.y).toBeCloseTo(25, 12);
    const l = line('l', 0, 0, 10, 4);
    expect(resolveAnchorPoint(l, { entityId: 'l', anchor: 'midpoint' })).toEqual({ x: 5, y: 2 });
    const closed = polyline('pl', [[0, 0], [10, 0], [10, 10]], true);
    expect(resolveAnchorPoint(closed, { entityId: 'pl', anchor: 'end' })).toEqual({ x: 0, y: 0 });
    expect(resolveAnchorPoint(closed, { entityId: 'pl', anchor: 'vertex', index: 3 })).toEqual({ x: 0, y: 0 }); // modulo n
  });

  it('enforces the §2.1 anchor table', () => {
    const l = line('l', 0, 0, 1, 0);
    expect(anchorValidFor(l, { entityId: 'l', anchor: 'center' })).toBe(false);
    expect(anchorValidFor(l, { entityId: 'l', anchor: 'segment' })).toBe(false);
    expect(anchorValidFor(l, { entityId: 'l', anchor: 'start', index: 0 })).toBe(false);
    const pl = polyline('pl', [[0, 0], [1, 0], [1, 1]]);
    expect(anchorValidFor(pl, { entityId: 'pl', anchor: 'vertex', index: 2 })).toBe(true);
    expect(anchorValidFor(pl, { entityId: 'pl', anchor: 'vertex', index: 3 })).toBe(false);
    expect(anchorValidFor(pl, { entityId: 'pl', anchor: 'segment', index: 2 })).toBe(false); // open: n−1 segments
    expect(anchorValidFor(circle('c', 0, 0, 1), { entityId: 'c', anchor: 'start' })).toBe(false);
  });
});

describe('validation (§4)', () => {
  const L = line('L', 0, 0, 10, 0);
  const L2 = line('L2', 0, 5, 10, 5);
  const C = circle('C', 0, 0, 5);
  const C2 = circle('C2', 20, 0, 5);

  it('accepts well-formed sets of every slice-1 shape', () => {
    const problems = validateConstraints(
      [L, L2, C, C2],
      set(
        { id: 'k1', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L', anchor: 'end' }, { entityId: 'L2', anchor: 'start' }] },
        { id: 'k2', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }] },
        { id: 'k3', kind: 'concentric', role: 'driving', refs: [{ entityId: 'C', anchor: 'whole' }, { entityId: 'C2', anchor: 'center' }] },
        { id: 'k4', kind: 'radius', role: 'driving', value: 7, refs: [{ entityId: 'C', anchor: 'whole' }] },
        { id: 'k5', kind: 'radius', role: 'reference', refs: [{ entityId: 'C2', anchor: 'whole' }] },
        { id: 'k6', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }] },
      ),
    );
    expect(problems).toEqual([]);
  });

  it('reports missing-reference and blocks nothing else from being reported', () => {
    const problems = validateConstraints(
      [L],
      set(
        { id: 'k1', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L', anchor: 'end' }, { entityId: 'ghost', anchor: 'start' }] },
        { id: 'k2', kind: 'radius', role: 'driving', value: -1, refs: [{ entityId: 'C', anchor: 'whole' }] },
      ),
    );
    expect(codes(problems)).toContain('missing-reference');
    expect(problems[0]!.code).toBe('missing-reference'); // stored order
    expect(problems.some((p) => p.constraintId === 'k2')).toBe(true); // all problems, not first-failure
  });

  it('rejects constraints on non-constrainable entities', () => {
    const problems = validateConstraints([text('T')], set({ id: 'k', kind: 'fixed', role: 'driving', refs: [{ entityId: 'T', anchor: 'position' }] }));
    expect(codes(problems)).toEqual(['unsupported-entity']);
  });

  it('rejects invalid anchors and indices', () => {
    const problems = validateConstraints(
      [L, polyline('PL', [[0, 0], [1, 0]])],
      set(
        { id: 'a', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L', anchor: 'center' }] },
        { id: 'b', kind: 'coincident', role: 'driving', refs: [{ entityId: 'PL', anchor: 'vertex', index: 7 }, { entityId: 'L', anchor: 'start' }] },
      ),
    );
    expect(codes(problems)).toEqual(['invalid-anchor', 'invalid-anchor']);
  });

  it('enforces the driving/reference contract strictly (§2.3)', () => {
    const problems = validateConstraints(
      [L, C],
      set(
        { id: 'g', kind: 'horizontal', role: 'reference', refs: [{ entityId: 'L', anchor: 'whole' }] },
        { id: 'r', kind: 'radius', role: 'reference', value: 3, refs: [{ entityId: 'C', anchor: 'whole' }] },
      ),
    );
    expect(codes(problems)).toEqual(['invalid-role', 'invalid-role']);
  });

  it('rejects bad dimensional values', () => {
    const problems = validateConstraints(
      [L, C],
      set(
        { id: 'a', kind: 'radius', role: 'driving', refs: [{ entityId: 'C', anchor: 'whole' }] }, // missing value
        { id: 'b', kind: 'distance', role: 'driving', value: -2, refs: [{ entityId: 'L', anchor: 'start' }, { entityId: 'L', anchor: 'end' }] },
        { id: 'c', kind: 'diameter', role: 'driving', value: 0, refs: [{ entityId: 'C', anchor: 'whole' }] },
        { id: 'd', kind: 'angle', role: 'driving', value: Number.NaN, refs: [{ entityId: 'L', anchor: 'whole' }, { entityId: 'L', anchor: 'whole' }] },
      ),
    );
    expect(problems.filter((p) => p.code === 'invalid-value')).toHaveLength(4);
  });

  it('rejects wrong arity and wrong ref shapes', () => {
    const problems = validateConstraints(
      [L, C],
      set(
        { id: 'a', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }] },
        { id: 'b', kind: 'equal', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }, { entityId: 'C', anchor: 'whole' }] }, // mixed length ↔ radius
        { id: 'c', kind: 'radius', role: 'driving', value: 3, refs: [{ entityId: 'L', anchor: 'whole' }] }, // radius on a line
        { id: 'd', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }, { entityId: 'L', anchor: 'end' }] },
      ),
    );
    expect(codes(problems)).toEqual(['invalid-arity', 'invalid-arity', 'invalid-arity', 'invalid-arity']);
  });

  it('detects duplicates (kind + unordered refs + value) and duplicate ids', () => {
    const problems = validateConstraints(
      [L],
      set(
        { id: 'a', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }] },
        { id: 'b', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }] },
        { id: 'a', kind: 'vertical', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }] },
        // a suppressed copy is not a duplicate (it is inactive)
        { id: 's', kind: 'horizontal', role: 'driving', suppressed: true, refs: [{ entityId: 'L', anchor: 'whole' }] },
      ),
    );
    expect(codes(problems)).toEqual(['duplicate-constraint', 'duplicate-constraint']);
    expect(problems[0]!.constraintId).toBe('b');
    expect(problems[1]!.constraintId).toBe('a');
  });

  it('detects self-reference, including coincident on the same anchor twice', () => {
    const problems = validateConstraints(
      [L],
      set({ id: 'k', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }, { entityId: 'L', anchor: 'start' }] }),
    );
    expect(codes(problems)).toEqual(['self-reference']);
  });

  it('rejects coincident between vertex 0 and vertex n−1 of one closed polyline (§2.5)', () => {
    const pl = polyline('PL', [[0, 0], [10, 0], [10, 10], [0, 10]], true);
    const problems = validateConstraints(
      [pl],
      set({ id: 'k', kind: 'coincident', role: 'driving', refs: [{ entityId: 'PL', anchor: 'vertex', index: 0 }, { entityId: 'PL', anchor: 'vertex', index: 3 }] }),
    );
    expect(codes(problems)).toEqual(['invalid-anchor']);
  });

  it('rejects whole-entity constraints on bulged segments but allows point anchors (§2.5)', () => {
    const bulged = polyline('PL', [[0, 0], [10, 0], [10, 10]], false, [0.5, 0]);
    const other = line('L', 0, 20, 10, 20);
    const bad = validateConstraints(
      [bulged, other],
      set({ id: 'p', kind: 'parallel', role: 'driving', refs: [{ entityId: 'PL', anchor: 'segment', index: 0 }, { entityId: 'L', anchor: 'whole' }] }),
    );
    expect(codes(bad)).toEqual(['unsupported-anchor']);
    const badH = validateConstraints(
      [bulged],
      set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'PL', anchor: 'segment', index: 0 }] }),
    );
    expect(codes(badH)).toEqual(['unsupported-anchor']);
    const ok = validateConstraints(
      [bulged, other],
      set(
        { id: 'c', kind: 'coincident', role: 'driving', refs: [{ entityId: 'PL', anchor: 'vertex', index: 1 }, { entityId: 'L', anchor: 'start' }] },
        { id: 'h2', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'PL', anchor: 'vertex', index: 0 }, { entityId: 'PL', anchor: 'vertex', index: 1 }] },
      ),
    );
    expect(ok).toEqual([]);
  });

  it('rejects distanceMode on non-distance kinds; accepts it on distance', () => {
    const bad = validateConstraints([C], set({ id: 'k', kind: 'radius', role: 'driving', value: 3, distanceMode: 'horizontal', refs: [{ entityId: 'C', anchor: 'whole' }] }));
    expect(codes(bad)).toEqual(['invalid-value']);
    const ok = validateConstraints(
      [L],
      set({ id: 'k', kind: 'distance', role: 'driving', value: 4, distanceMode: 'vertical', refs: [{ entityId: 'L', anchor: 'start' }, { entityId: 'L', anchor: 'end' }] }),
    );
    expect(ok).toEqual([]);
  });
});
