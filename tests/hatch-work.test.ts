import { describe, expect, it } from 'vitest';
import { entityGeometryWork, MAX_BLOCK_EXPANSION_WORK, type HatchEntity } from '../src/core/entities';
import { bulgeArcSteps, loopPolygon, type HatchLoop } from '../src/core/hatch';
import type { Point } from '../src/core/geometry';

/**
 * Hatch geometry work must charge per segment: a loop costs the vertices loopPolygon
 * tessellates it into. The old model charged every point of a loop the full 32-step
 * arc cost when any single segment had a bulge, which rejected a real customer
 * signature (11,568 points, 3 bulged segments, charged 107,298 work units for a
 * true tessellation of 11,573 vertices).
 */

const hatch = (loops: readonly HatchLoop[]): HatchEntity => ({
  id: 'h', type: 'hatch', layer: '0', color: 'ByLayer',
  pattern: 'SOLID', solid: true, angle: 0, scale: 1, loops,
});

/** `n` distinct points around a circle (consecutive points never coincide). */
const circlePoints = (n: number, r = 100): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });

describe('bulgeArcSteps', () => {
  it('counts one step per 11.25 degrees of sweep', () => {
    // bulge 1 = tan(pi/4): sweep is a half turn (pi), pi / (pi/16) = 16 steps.
    expect(bulgeArcSteps(1)).toBe(16);
    expect(bulgeArcSteps(-1)).toBe(16);
    // bulge tan(pi/8) = a quarter turn: 8 steps.
    expect(bulgeArcSteps(Math.tan(Math.PI / 8))).toBe(8);
  });

  it('has a floor of 2 steps for a tiny bulge', () => {
    expect(bulgeArcSteps(0.001)).toBe(2);
    expect(bulgeArcSteps(1e-9)).toBe(2);
  });

  it('caps at 32 steps for a near-full circle', () => {
    expect(bulgeArcSteps(1e6)).toBe(32);
    expect(bulgeArcSteps(-1e6)).toBe(32);
  });
});

describe('hatch geometry work', () => {
  it('charges a straight loop exactly its point count', () => {
    const pts = circlePoints(50);
    expect(entityGeometryWork(hatch([{ points: pts }]))).toBe(1 + 50);
    expect(entityGeometryWork(hatch([{ points: pts, bulges: pts.map(() => 0) }]))).toBe(1 + 50);
  });

  it('charges one bulged segment per segment, not the whole loop times 32', () => {
    const pts = circlePoints(1000);
    const bulges = pts.map(() => 0);
    bulges[0] = 1; // one semicircle among 999 straight segments
    const work = entityGeometryWork(hatch([{ points: pts, bulges }]));
    expect(work).toBe(1 + 1000 + (16 - 1));
    expect(work).toBeLessThan(1000 * 32);
  });

  it('equals the loopPolygon vertex count for hand-built loops', () => {
    const mixed = circlePoints(37);
    const loops: HatchLoop[] = [
      { points: circlePoints(12) },
      { points: mixed, bulges: mixed.map((_, i) => (i === 3 ? 0.5 : i === 20 ? -0.25 : 0)) },
      // Bulge on the closing segment (last vertex back to the first point).
      { points: circlePoints(9, 40), bulges: [0, 0, 0, 0, 0, 0, 0, 0, 2] },
      // Bulges array shorter than the point list: missing entries are straight.
      { points: circlePoints(15, 60), bulges: [1] },
    ];
    const expected = loops.reduce((sum, loop) => sum + loopPolygon(loop).length, 0);
    expect(entityGeometryWork(hatch(loops)) - 1).toBe(expected);
  });

  it('accepts the customer signature profile: ~11,568 points, 3 bulged segments', () => {
    const perLoop = 3856;
    const loops: HatchLoop[] = [0, 1, 2].map((k) => {
      const pts = circlePoints(perLoop, 100 + k);
      const bulges = pts.map(() => 0);
      bulges[k * 100] = 1;
      return { points: pts, bulges };
    });
    const totalPoints = loops.reduce((sum, loop) => sum + loop.points.length, 0);
    expect(totalPoints).toBe(11_568);
    const work = entityGeometryWork(hatch(loops));
    expect(work).toBe(1 + 11_568 + 3 * (16 - 1));
    expect(work).toBeLessThan(20_000);
  });

  it('still charges genuinely expensive geometry over the block cap', () => {
    // 4,000 segments that are each a near-full circle really do tessellate into
    // ~128,000 vertices; the per-block budget must keep rejecting them.
    const pts = circlePoints(4000, 1000);
    const work = entityGeometryWork(hatch([{ points: pts, bulges: pts.map(() => 1e6) }]));
    expect(work).toBe(1 + 4000 + 4000 * (32 - 1));
    expect(work).toBeGreaterThan(MAX_BLOCK_EXPANSION_WORK);
  });

  it('uses the same numerical threshold in mixed curved loops and admission', () => {
    const points = circlePoints(60_000, 1000);
    const bulges = points.map((_, i) => i === points.length - 1 ? 1 : i % 2 ? 1e-12 : -1e-12);
    const loop = { points, bulges };
    // Previously these threshold segments emitted an uncharged vertex each when the one
    // ordinary bulge enabled curved rendering: 60,016 charged but 120,014 emitted.
    expect(entityGeometryWork(hatch([loop]))).toBe(1 + loopPolygon(loop).length);
    expect(loopPolygon(loop)).toHaveLength(60_015);
  });
});
