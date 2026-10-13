/** Ear-clipping triangulation with holes: counts, area, orientation, no degenerate triangles, refusals. */
import { describe, expect, it } from 'vitest';
import type { Point } from '../src/core/geometry';
import { loopSignedArea2, triangulatePolygon } from '../src/model3d/triangulate';

const square = (x: number, y: number, s: number): Point[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const cw = (pts: Point[]): Point[] => [...pts].reverse();
const circle = (cx: number, cy: number, r: number, n: number): Point[] => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((2 * Math.PI * k) / n), y: cy + r * Math.sin((2 * Math.PI * k) / n) }));

function check(loops: Point[][]): number[] {
  const tris = triangulatePolygon(loops);
  const pts = loops.flat();
  const n = pts.length, h = loops.length - 1;
  expect(tris.length).toBe(3 * (n + 2 * h - 2));
  const outerSign = Math.sign(loopSignedArea2(loops[0]!));
  let area2 = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = pts[tris[t]!]!, b = pts[tris[t + 1]!]!, c = pts[tris[t + 2]!]!;
    const s = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    // Same orientation as the outer loop and never degenerate.
    expect(Math.sign(s)).toBe(outerSign);
    expect(Math.abs(s)).toBeGreaterThan(1e-12);
    area2 += Math.abs(s);
  }
  const expected = loops.reduce((sum, l, i) => sum + (i === 0 ? 1 : -1) * Math.abs(loopSignedArea2(l)), 0);
  expect(area2).toBeCloseTo(expected, 9);
  // Every vertex is used.
  expect(new Set(tris).size).toBe(n);
  return tris;
}

describe('triangulatePolygon', () => {
  it('triangulates a convex polygon (n - 2 triangles)', () => {
    check([square(0, 0, 1)]);
    check([circle(0, 0, 2, 32)]);
  });

  it('triangulates concave outlines (L shape, comb, star)', () => {
    check([[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }]]);
    const comb = [[0, 0], [5, 0], [5, 3], [4, 3], [4, 1], [3, 1], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]].map(([x, y]) => ({ x: x!, y: y! }));
    check([comb]);
    const star: Point[] = Array.from({ length: 10 }, (_, k) => {
      const r = k % 2 ? 0.4 : 1, t = (Math.PI * k) / 5;
      return { x: r * Math.cos(t), y: r * Math.sin(t) };
    });
    check([star]);
  });

  it('triangulates a square with a square hole (n + 2h - 2 triangles)', () => {
    const tris = check([square(0, 0, 3), cw(square(1, 1, 1))]);
    expect(tris.length / 3).toBe(8);
  });

  it('accepts holes of either orientation and several holes, including circles', () => {
    check([square(0, 0, 10), square(1, 1, 2), cw(square(6, 6, 2)), cw(circle(7, 2.5, 1, 16)), circle(2.5, 7, 1.2, 24)]);
  });

  it('preserves a clockwise outer orientation', () => {
    check([cw(square(0, 0, 3)), square(1, 1, 1)]);
  });

  it('handles holes whose bridge rays meet the same outer vertex', () => {
    // Two holes level with each other and with an outer vertex.
    check([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }], cw(square(2, 4, 2)), cw(square(6, 4, 2))]);
  });

  it('is deterministic', () => {
    const loops = [circle(0, 0, 5, 40), cw(circle(1, 1, 1, 12)), cw(circle(-2, -1, 1, 12))];
    expect(triangulatePolygon(loops)).toEqual(triangulatePolygon(loops));
  });

  it('refuses invalid input instead of returning a partial triangulation', () => {
    expect(() => triangulatePolygon([])).toThrow(/at least 3/);
    expect(() => triangulatePolygon([[{ x: 0, y: 0 }, { x: 1, y: 0 }]])).toThrow(/at least 3/);
    expect(() => triangulatePolygon([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]])).toThrow(/zero area/);
    expect(() => triangulatePolygon([square(0, 0, 1), cw(square(5, 5, 1))])).toThrow(/outside/);
    expect(() => triangulatePolygon([[{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 1 }]])).toThrow(/finite/);
    // A bow tie (self-intersecting).
    expect(() => triangulatePolygon([[{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }]])).toThrow();
  });
});
