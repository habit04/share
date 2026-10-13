/** Sketch to profile: accepted entities, chaining, flattening, nesting, orientation, refusals. */
import { describe, expect, it } from 'vitest';
import type { Entity, SplineEntity } from '../src/core/entities';
import { splineThroughPoints } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { type Frame3, WORLD_XY_FRAME, frameFromPlane, v3 } from '../src/model3d/math';
import { MAX_PROFILE_POINTS, profileFromEntities, validateProfile } from '../src/model3d/sketch';
import { loopSignedArea2 } from '../src/model3d/triangulate';
import type { Profile3D } from '../src/model3d/types';

let n = 0;
const base = () => ({ id: `t${++n}`, layer: '0', color: 'ByLayer' as const });
const line = (a: [number, number], b: [number, number]): Entity => ({ ...base(), type: 'line', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });
const pline = (pts: [number, number][], closed = true, bulges?: number[]): Entity => ({ ...base(), type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), closed, ...(bulges ? { bulges } : {}) });
const circle = (x: number, y: number, r: number): Entity => ({ ...base(), type: 'circle', center: { x, y }, radius: r });
const arc = (x: number, y: number, r: number, s: number, e: number): Entity => ({ ...base(), type: 'arc', center: { x, y }, radius: r, startAngle: s, endAngle: e });

function ok(entities: Entity[], frame: Frame3 = WORLD_XY_FRAME, opts?: { tolerance?: number; segments?: number }): Profile3D {
  const r = profileFromEntities(entities, frame, opts);
  if ('error' in r) throw new Error(r.error);
  expect(validateProfile(r.profile)).toBeNull();
  return r.profile;
}
function err(entities: Entity[], frame: Frame3 = WORLD_XY_FRAME, opts?: { tolerance?: number; segments?: number }): string {
  const r = profileFromEntities(entities, frame, opts);
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}
const area = (loop: readonly Point[]) => loopSignedArea2(loop) / 2;

describe('profileFromEntities: accepted geometry', () => {
  it('takes a closed polyline as the outer loop, counter-clockwise', () => {
    const p = ok([pline([[0, 0], [0, 2], [3, 2], [3, 0]])]); // drawn clockwise
    expect(p.loops).toHaveLength(1);
    expect(area(p.loops[0]!)).toBeCloseTo(6, 12);
    expect(p.frame).toBe(WORLD_XY_FRAME);
  });

  it('flattens bulges with the requested segment count per full turn', () => {
    // A stadium: two straight sides and two half-circle bulges (bulge 1 = 180 degrees).
    const e = pline([[0, 0], [4, 0], [4, 2], [0, 2]], true, [0, 1, 0, 1]);
    const p16 = ok([e], WORLD_XY_FRAME, { segments: 16 });
    expect(p16.loops[0]).toHaveLength(4 + 2 * 7); // each half turn: 8 chords, 7 interior points
    const exact = 8 + Math.PI;
    const p256 = ok([e], WORLD_XY_FRAME, { segments: 256 });
    expect(area(p256.loops[0]!)).toBeLessThan(exact);
    expect(area(p256.loops[0]!)).toBeGreaterThan(exact - 1e-3);
  });

  it('flattens circles deterministically with clamped segments', () => {
    expect(ok([circle(0, 0, 1)]).loops[0]).toHaveLength(32);
    expect(ok([circle(0, 0, 1)], WORLD_XY_FRAME, { segments: 3 }).loops[0]).toHaveLength(8);
    expect(ok([circle(0, 0, 1)], WORLD_XY_FRAME, { segments: 1000 }).loops[0]).toHaveLength(256);
    const a = ok([circle(5, 5, 2)]), b = ok([circle(5, 5, 2)]);
    expect(a.loops).toEqual(b.loops);
    expect(a.loops[0]![0]).toEqual({ x: 7, y: 5 }); // starts on +X
  });

  it('accepts ellipses and closed splines', () => {
    const ell: Entity = { ...base(), type: 'ellipse', center: { x: 0, y: 0 }, majorAxis: { x: 2, y: 0 }, ratio: 0.5, startParam: 0, endParam: 2 * Math.PI };
    const pe = ok([ell], WORLD_XY_FRAME, { segments: 64 });
    expect(pe.loops[0]).toHaveLength(64);
    expect(area(pe.loops[0]!)).toBeCloseTo((64 / 2) * Math.sin((2 * Math.PI) / 64) * 2 * 1, 9);
    const spline = splineThroughPoints(base(), [{ x: 0, y: 0 }, { x: 2, y: -1 }, { x: 4, y: 0 }, { x: 2, y: 2 }], true) as SplineEntity;
    const ps = ok([spline]);
    expect(ps.loops[0]!.length).toBeGreaterThan(16);
    expect(area(ps.loops[0]!)).toBeGreaterThan(0);
  });

  it('chains lines and arcs into a loop whatever their order and direction', () => {
    // A slot: two lines and two half-circle arcs, given shuffled and with mixed directions.
    const parts = [
      line([4, 2], [0, 2]),
      arc(0, 1, 1, Math.PI / 2, (3 * Math.PI) / 2),
      line([0, 0], [4, 0]),
      arc(4, 1, 1, -Math.PI / 2, Math.PI / 2),
    ];
    const p = ok([parts[2]!, parts[0]!, parts[3]!, parts[1]!], WORLD_XY_FRAME, { segments: 32 });
    expect(area(p.loops[0]!)).toBeCloseTo(8 + 16 * Math.sin(Math.PI / 16), 9);
    // Reversed line direction still chains.
    const q = ok([line([0, 0], [1, 0]), line([1, 1], [1, 0]), line([1, 1], [0, 0])]);
    expect(Math.abs(area(q.loops[0]!))).toBeCloseTo(0.5, 12);
  });

  it('matches endpoints within the tolerance only', () => {
    const gap = [line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 1e-7])];
    expect(ok(gap).loops[0]).toHaveLength(3);
    expect(err(gap, WORLD_XY_FRAME, { tolerance: 1e-9 })).toMatch(/not closed/);
  });

  it('chains with tolerance 0 (exact endpoints) and at huge coordinates without false branches', () => {
    const tri = () => [line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 0])];
    expect(ok(tri(), WORLD_XY_FRAME, { tolerance: 0 }).loops[0]).toHaveLength(3);
    // Coordinates beyond 2^52 x tolerance, where neighbouring grid cells round to the same key.
    const big = 2 ** 53 * 1e-6;
    const far = [line([big, big], [big + 64, big]), line([big + 64, big], [big + 64, big + 64]), line([big + 64, big + 64], [big, big])];
    expect(ok(far).loops[0]).toHaveLength(3);
  });

  it('orders the outer loop first and makes holes clockwise', () => {
    const p = ok([circle(2, 2, 0.5), pline([[0, 0], [4, 0], [4, 4], [0, 4]]), pline([[3, 3], [3.5, 3], [3.5, 3.5], [3, 3.5]])]);
    expect(p.loops).toHaveLength(3);
    expect(area(p.loops[0]!)).toBeCloseTo(16, 12);
    expect(area(p.loops[1]!)).toBeLessThan(0);
    expect(area(p.loops[2]!)).toBeLessThan(0);
    // Holes keep the input order.
    expect(p.loops[1]!.length).toBe(32);
  });

  it('drops vertices on straight runs (split lines) and merges duplicate points', () => {
    const p = ok([line([0, 0], [1, 0]), line([1, 0], [2, 0]), line([2, 0], [2, 1]), line([2, 1], [0, 1]), line([0, 1], [0, 0])]);
    expect(p.loops[0]).toHaveLength(4);
    expect(ok([pline([[0, 0], [1, 0], [1, 0], [1, 1], [0, 1], [0, 0]])]).loops[0]).toHaveLength(4);
  });

  it('maps points into a frame on the same plane', () => {
    const frame: Frame3 = { origin: v3(10, 0, 0), xAxis: v3(0, 1, 0), yAxis: v3(-1, 0, 0), zAxis: v3(0, 0, 1) };
    const p = ok([pline([[10, 0], [12, 0], [12, 1], [10, 1]])], frame);
    // World (12, 0) is frame-local (0, -2).
    expect(p.loops[0]!.some((q) => Math.abs(q.x) < 1e-12 && Math.abs(q.y + 2) < 1e-12)).toBe(true);
    expect(area(p.loops[0]!)).toBeCloseTo(2, 12);
  });
});

describe('profileFromEntities: refusals', () => {
  it('rejects open boundaries, naming the entity', () => {
    const l = line([0, 0], [1, 0]);
    expect(err([l, line([1, 0], [1, 1])])).toContain(`line ${l.id}`);
    expect(err([pline([[0, 0], [1, 0], [1, 1]], false)])).toMatch(/not closed/);
    expect(err([arc(0, 0, 1, 0, Math.PI)])).toMatch(/not closed/);
  });

  it('rejects branching boundaries', () => {
    expect(err([line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 0]), line([1, 0], [2, 0])])).toMatch(/branches/);
  });

  it('rejects self-intersecting loops', () => {
    expect(err([pline([[0, 0], [3, 3], [3, 0], [0, 2]])])).toMatch(/intersects itself/);
    // A spike that doubles back on itself.
    expect(err([pline([[0, 0], [2, 0], [2, 2], [1, 2], [1, 3], [1, 2], [0, 2]])])).toMatch(/intersects itself/);
  });

  it('rejects loops that cross or touch', () => {
    expect(err([circle(0, 0, 1), circle(1.5, 0, 1)])).toMatch(/cross or touch/);
    expect(err([pline([[0, 0], [4, 0], [4, 4], [0, 4]]), pline([[0, 1], [1, 1], [1, 2], [0, 2]])])).toMatch(/cross or touch/);
  });

  it('rejects several outer regions and islands inside holes', () => {
    expect(err([circle(0, 0, 1), circle(5, 0, 1)])).toMatch(/2 separate regions/);
    expect(err([circle(0, 0, 3), circle(0, 0, 2), circle(0, 0, 1)])).toMatch(/inside a hole/);
  });

  it('rejects entities off the sketch plane and unsupported kinds', () => {
    const tilted = frameFromPlane({ origin: v3(0, 0, 0), normal: v3(1, 0, 1) });
    expect(err([circle(5, 0, 1)], tilted)).toMatch(/does not lie on the sketch plane/);
    const text: Entity = { ...base(), type: 'point', position: { x: 0, y: 0 } };
    expect(err([text])).toMatch(/cannot be part of a profile/);
    expect(err([])).toMatch(/Select at least one/);
  });

  it('rejects degenerate and oversized input', () => {
    expect(err([pline([[0, 0], [1, 0], [2, 0]])])).toMatch(/fewer than three|no area/);
    expect(err([circle(0, 0, 0)])).toMatch(/invalid radius/);
    expect(err([line([0, 0], [0, 0])])).toMatch(/zero length/);
    const many: Entity[] = [];
    const k = Math.ceil(MAX_PROFILE_POINTS / 256) + 1;
    many.push(circle(0, 0, 10 * k));
    for (let i = 0; i < k; i++) many.push(circle(-5 * k + 10 * i, 0, 1));
    expect(err(many, WORLD_XY_FRAME, { segments: 256 })).toMatch(/limit/);
  });
});

describe('validateProfile', () => {
  const sq: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  it('accepts a normalised profile and names each problem otherwise', () => {
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [sq] })).toBeNull();
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [] })).toMatch(/no loops/);
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [[...sq].reverse()] })).toMatch(/counter-clockwise/);
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [sq.slice(0, 2)] })).toMatch(/fewer than three/);
    const big: Point[] = [{ x: -1, y: -1 }, { x: 3, y: -1 }, { x: 3, y: 3 }, { x: -1, y: 3 }];
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [big, sq] })).toMatch(/hole 1 must be clockwise/);
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [sq, [...big].reverse()] })).toMatch(/first loop must be the outer/);
    const leftHanded: Frame3 = { ...WORLD_XY_FRAME, zAxis: v3(0, 0, -1) };
    expect(validateProfile({ frame: leftHanded, loops: [sq] })).toMatch(/left-handed/);
    expect(validateProfile({ frame: WORLD_XY_FRAME, loops: [[{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 1 }]] })).toMatch(/non-finite/);
  });
});
