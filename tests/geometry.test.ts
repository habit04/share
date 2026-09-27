import { describe, it, expect } from 'vitest';
import * as g from '../src/core/geometry';

describe('geometry', () => {
  it('segment intersection finds crossing point', () => {
    const p = g.segmentIntersection({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 });
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(1);
    expect(p!.y).toBeCloseTo(1);
  });
  it('segment intersection rejects parallel and non-overlapping', () => {
    expect(g.segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull();
    expect(g.segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: -1 }, { x: 2, y: 1 })).toBeNull();
  });
  it('closest point on segment clamps to ends', () => {
    expect(g.closestOnSegment({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(g.closestOnSegment({ x: 2, y: 3 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual({ x: 2, y: 0 });
  });
  it('angleInSweep handles wraparound', () => {
    expect(g.angleInSweep(0, g.rad(350), g.rad(10))).toBe(true);
    expect(g.angleInSweep(g.rad(180), g.rad(350), g.rad(10))).toBe(false);
    expect(g.angleInSweep(g.rad(90), 0, Math.PI)).toBe(true);
  });
  it('segment-circle intersections', () => {
    const pts = g.segmentCircleIntersections({ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }, 1);
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => p.x).sort()).toEqual([-1, 1]);
    expect(g.segmentCircleIntersections({ x: -2, y: 5 }, { x: 2, y: 5 }, { x: 0, y: 0 }, 1)).toHaveLength(0);
  });
  it('rotate about a point', () => {
    const p = g.rotate({ x: 2, y: 1 }, Math.PI / 2, { x: 1, y: 1 });
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2);
  });
});
