import { describe, expect, it } from 'vitest';
import type { Entity, PolylineEntity } from '../src/core/entities';
import type { ConstraintSet } from '../src/core/constraints/model';
import { analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';

// Review round 5, item R4-02 — solver preparation admission.
//
// Round 4 moved the analysis layout behind a totalVars admission, but
// preparation still collected two scalars for every polyline vertex
// into a plain array before that admission. The witnesses below stay
// deliberately tiny (8 and 16 vertices). With no constraints, the old
// scalar collection was the only vertex-proportional array grown via
// Array.prototype.push on this preparation path; the observer records
// the largest length reached by any pushed array while analysis runs.
// Streaming validation must keep that footprint independent of the
// vertex count instead of reaching 16 scalars for 8 vertices and 32
// scalars for 16 vertices.

const base = { layer: '0', color: 'ByLayer' as const };
const emptySet: ConstraintSet = { constraints: [] };

function polyline(vertexCount: number): PolylineEntity {
  return {
    ...base,
    id: 'PL',
    type: 'polyline',
    closed: false,
    points: Array.from({ length: vertexCount }, (_, i) => ({ x: i, y: 0 })),
  };
}

function polylineWithPoint(vertexCount: number, index: number, point: { x: number; y: number }): PolylineEntity {
  const pl = polyline(vertexCount);
  return { ...pl, points: pl.points.map((p, i) => (i === index ? point : p)) };
}

function observeMaxPushedArrayLength<T>(fn: () => T): { result: T; maxLength: number } {
  const arrayPrototype = Array.prototype as { push: (...items: unknown[]) => number };
  const originalPush = arrayPrototype.push;
  let maxLength = 0;
  arrayPrototype.push = function (...items: unknown[]) {
    const result = originalPush.apply(this, items);
    if (Array.isArray(this)) maxLength = Math.max(maxLength, this.length);
    return result;
  };
  try {
    return { result: fn(), maxLength };
  } finally {
    arrayPrototype.push = originalPush;
  }
}

describe('round 5 R4-02 — preparation streams vertex validation', () => {
  it('does not grow a vertex-proportional pushed array for an 8- or 16-vertex polyline', () => {
    const eight = observeMaxPushedArrayLength(() => analyzeConstraints([polyline(8)], emptySet));
    const sixteen = observeMaxPushedArrayLength(() => analyzeConstraints([polyline(16)], emptySet));

    expect(eight.result.problems).toEqual([]);
    expect(eight.result.dof.total).toBe(0); // no constraint makes the polyline participate
    expect(sixteen.result.problems).toEqual([]);
    expect(sixteen.result.dof.total).toBe(0);
    expect(eight.maxLength).toBeLessThanOrEqual(4);
    expect(sixteen.maxLength).toBeLessThanOrEqual(4);
    expect(sixteen.maxLength).toBe(eight.maxLength);
  });

  it('preserves the non-finite and out-of-range polyline refusals at tiny sizes', () => {
    const nonFinite = polylineWithPoint(16, 15, { x: Number.POSITIVE_INFINITY, y: 0 });
    const analysis = analyzeConstraints([nonFinite], emptySet);
    expect(analysis.status).toBeNull();
    expect(analysis.problems).toHaveLength(1);
    expect(analysis.problems[0]).toMatchObject({ code: 'invalid-value', entityId: 'PL' });
    expect(analysis.problems[0]!.message).toContain('a non-finite coordinate or a coordinate beyond 1e15');

    const solved = solveConstraints([nonFinite], emptySet);
    expect(solved.ok).toBe(false);
    expect(solved.failure?.code).toBe('validation-failed');
    expect(solved.problems).toEqual(analysis.problems);

    const outOfRange = polylineWithPoint(8, 7, { x: 2e15, y: 0 });
    const rangeAnalysis = analyzeConstraints([outOfRange], emptySet);
    expect(rangeAnalysis.problems).toHaveLength(1);
    expect(rangeAnalysis.problems[0]).toMatchObject({ code: 'invalid-value', entityId: 'PL' });
  });

  it('preserves malformed-coordinate, empty-polyline, width-frame, and radius problem shapes', () => {
    const missingCoordinate = {
      ...polyline(8),
      points: [{ x: 0 }, ...polyline(8).points.slice(1)],
    } as unknown as Entity;
    const missing = analyzeConstraints([missingCoordinate], emptySet);
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toMatchObject({ code: 'invalid-value', entityId: 'PL' });

    const empty = analyzeConstraints([{ ...polyline(0), points: [] }], emptySet);
    expect(empty.problems).toHaveLength(1);
    expect(empty.problems[0]).toMatchObject({ code: 'invalid-value', entityId: 'PL' });
    expect(empty.problems[0]!.message).toContain('no points');

    const framed = polyline(8);
    const mismatchedFrame: PolylineEntity = {
      ...framed,
      widthFrame: {
        points: framed.points.slice(0, 7),
        origin: { x: 0, y: 0 },
        x: { x: 1, y: 0 },
        y: { x: 0, y: 1 },
      },
    };
    const frameProblems = analyzeConstraints([mismatchedFrame], emptySet).problems;
    expect(frameProblems).toHaveLength(1);
    expect(frameProblems[0]).toMatchObject({ code: 'invalid-value', entityId: 'PL' });
    expect(frameProblems[0]!.message).toContain('a degenerate or vertex-mismatched width frame');

    const badRadius: Entity = {
      ...base,
      id: 'C',
      type: 'circle',
      center: { x: 0, y: 0 },
      radius: Number.NaN,
    };
    const radiusProblems = analyzeConstraints([badRadius], emptySet).problems;
    expect(radiusProblems).toHaveLength(2);
    expect(radiusProblems.every((p) => p.code === 'invalid-value' && p.entityId === 'C')).toBe(true);
    expect(radiusProblems[0]!.message).toContain('a non-positive radius');
    expect(radiusProblems[1]!.message).toContain('a non-finite coordinate or a coordinate beyond 1e15');
  });
});
