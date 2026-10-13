/** Extrude and revolve: closed outward meshes with analytic volumes, both signs, input refusals. */
import { describe, expect, it } from 'vitest';
import type { Point } from '../src/core/geometry';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { type Frame3, WORLD_XY_FRAME, frameFromPlane, v3 } from '../src/model3d/math';
import { type Mesh3D, meshBounds, meshIsClosed, meshTriangleCount, meshVolume, validateMesh, weldVertices } from '../src/model3d/mesh';
import { profileFromEntities } from '../src/model3d/sketch';
import { extrudeMesh, revolveMesh } from '../src/model3d/sweep';
import type { Profile3D } from '../src/model3d/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const cw = (pts: Point[]): Point[] => [...pts].reverse();
const prof = (loops: Point[][], frame: Frame3 = WORLD_XY_FRAME): Profile3D => ({ frame, loops });
const polygonFactor = (n: number) => (n / 2) * Math.sin((2 * Math.PI) / n);

function expectSolid(mesh: Mesh3D): void {
  expect(validateMesh(mesh)).toBeNull();
  expect(meshIsClosed(mesh)).toBe(true);
  expect(meshVolume(mesh)).toBeGreaterThan(0);
  expect(weldVertices(mesh).positions).toHaveLength(mesh.positions.length); // welded by construction
}

describe('extrudeMesh', () => {
  it('extrudes a unit square to a unit cube, exactly', () => {
    const m = extrudeMesh(prof([rect(0, 0, 1, 1)]), 1);
    expectSolid(m);
    expect(meshVolume(m)).toBe(1);
    expect(meshTriangleCount(m)).toBe(12);
    expect(meshBounds(m)).toEqual({ min: v3(0, 0, 0), max: v3(1, 1, 1) });
  });

  it('extrudes along -Z for a negative distance and stays outward', () => {
    const m = extrudeMesh(prof([rect(0, 0, 2, 3)]), -4);
    expectSolid(m);
    expect(meshVolume(m)).toBe(24);
    expect(meshBounds(m)).toEqual({ min: v3(0, 0, -4), max: v3(2, 3, 0) });
  });

  it('extrudes a square with a square hole', () => {
    const m = extrudeMesh(prof([rect(0, 0, 3, 3), cw(rect(1, 1, 2, 2))]), 2);
    expectSolid(m);
    expect(meshVolume(m)).toBeCloseTo(16, 12);
    expect(meshTriangleCount(m)).toBe(2 * 8 + 2 * 8);
  });

  it('places the solid with the profile frame', () => {
    const frame = frameFromPlane({ origin: v3(5, 5, 5), normal: v3(1, 0, 0) });
    const m = extrudeMesh(prof([rect(0, 0, 1, 2)], frame), 3);
    expectSolid(m);
    expect(meshVolume(m)).toBeCloseTo(6, 12);
    const b = meshBounds(m)!;
    expect(b.min.x).toBeCloseTo(5, 12);
    expect(b.max.x).toBeCloseTo(8, 12);
  });

  it('extrudes a sketch profile: a plate with a grid of round holes', () => {
    const base = { layer: '0', color: 'ByLayer' as const };
    const entities = [{ ...base, id: 'o', type: 'polyline' as const, points: rect(0, 0, 20, 20), closed: true }];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) entities.push({ ...base, id: `h${i}${j}`, type: 'circle', center: { x: 2.5 + 3 * i, y: 2.5 + 3 * j }, radius: 1 } as never);
    const r = profileFromEntities(entities, WORLD_XY_FRAME, { segments: 24 });
    if ('error' in r) throw new Error(r.error);
    const m = extrudeMesh(r.profile, 0.5);
    expectSolid(m);
    expect(meshVolume(m)).toBeCloseTo((400 - 36 * polygonFactor(24)) * 0.5, 9);
  });

  it('refuses invalid input with precise messages', () => {
    const sq = prof([rect(0, 0, 1, 1)]);
    expect(() => extrudeMesh(sq, 0)).toThrow(/non-zero finite/);
    expect(() => extrudeMesh(sq, NaN)).toThrow(/non-zero finite/);
    expect(() => extrudeMesh(prof([cw(rect(0, 0, 1, 1))]), 1)).toThrow(/counter-clockwise/);
    expect(() => extrudeMesh(prof([[{ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 3, y: 0 }, { x: 0, y: 2 }]]), 1)).toThrow(/intersects itself/);
    expect(() => extrudeMesh(prof([rect(0, 0, 3, 3), cw(rect(2, 2, 4, 4))]), 1)).toThrow(/cross or touch/);
  });

  it('enforces the triangle budget before building', () => {
    const big: Point[] = Array.from({ length: 20_000 }, (_, k) => ({ x: Math.cos((2 * Math.PI * k) / 20_000), y: Math.sin((2 * Math.PI * k) / 20_000) }));
    expect(() => revolveMesh(prof([big.map((p) => ({ x: p.x + 2, y: p.y }))]), { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, 2 * Math.PI, 256)).toThrow(GeometryBudgetError);
  });
});

describe('revolveMesh', () => {
  const yAxis = { origin: v3(0, 0, 0), dir: v3(0, 1, 0) };

  it('revolves a rectangle offset from the axis into a washer', () => {
    const r = 1, R = 3, h = 2, n = 64;
    const m = revolveMesh(prof([rect(r, 0, R, h)]), yAxis, 2 * Math.PI, n);
    expectSolid(m);
    const analytic = Math.PI * (R * R - r * r) * h;
    expect(meshVolume(m)).toBeCloseTo(polygonFactor(n) * (R * R - r * r) * h, 9);
    expect(Math.abs(meshVolume(m) - analytic) / analytic).toBeLessThan(2e-3);
    expect(meshTriangleCount(m)).toBe(4 * 2 * n);
  });

  it('gives half the volume for half a turn, outward for both signs', () => {
    const full = meshVolume(revolveMesh(prof([rect(1, 0, 3, 2)]), yAxis, 2 * Math.PI, 64));
    for (const angle of [Math.PI, -Math.PI]) {
      const m = revolveMesh(prof([rect(1, 0, 3, 2)]), yAxis, angle, 64);
      expectSolid(m);
      expect(meshVolume(m)).toBeCloseTo(full / 2, 9);
    }
    const pos = meshBounds(revolveMesh(prof([rect(1, 0, 3, 2)]), yAxis, Math.PI / 2, 64))!;
    const neg = meshBounds(revolveMesh(prof([rect(1, 0, 3, 2)]), yAxis, -Math.PI / 2, 64))!;
    // Right-hand rule about +Y turns +X toward -Z.
    expect(pos.min.z).toBeCloseTo(-3, 9);
    expect(neg.max.z).toBeCloseTo(3, 9);
  });

  it('closes a profile touching the axis (a disc from a rectangle on the axis)', () => {
    const n = 48;
    const m = revolveMesh(prof([rect(0, 0, 2, 1)]), yAxis, 2 * Math.PI, n);
    expectSolid(m);
    expect(meshVolume(m)).toBeCloseTo(polygonFactor(n) * 4, 9);
    // Poles are single vertices: 2 rings of n plus 2 poles.
    expect(m.positions.length / 3).toBe(2 * n + 2);
    const quarter = revolveMesh(prof([rect(0, 0, 2, 1)]), yAxis, Math.PI / 2, n);
    expectSolid(quarter);
    expect(meshVolume(quarter)).toBeCloseTo((polygonFactor(n) * 4) / 4, 9);
  });

  it('revolves a profile with a hole and a profile on the negative side of the axis', () => {
    const outer = rect(2, -1, 6, 3), hole = cw(rect(3, 0, 5, 2));
    const m = revolveMesh(prof([outer, hole]), yAxis, 2 * Math.PI, 32);
    expectSolid(m);
    const k = polygonFactor(32);
    expect(meshVolume(m)).toBeCloseTo(k * ((36 - 4) * 4 - (25 - 9) * 2), 9);
    const mirrored = revolveMesh(prof([rect(-6, -1, -2, 3), cw(rect(-5, 0, -3, 2))]), yAxis, 2 * Math.PI, 32);
    expectSolid(mirrored);
    expect(meshVolume(mirrored)).toBeCloseTo(meshVolume(m), 9);
  });

  it('revolves about an axis given in world coordinates through a placed frame', () => {
    const frame: Frame3 = { origin: v3(0, 0, 10), xAxis: v3(1, 0, 0), yAxis: v3(0, 0, 1), zAxis: v3(0, -1, 0) };
    const m = revolveMesh(prof([rect(1, 0, 2, 1)], frame), { origin: v3(0, 0, 10), dir: v3(0, 0, 5) }, 2 * Math.PI, 32);
    expectSolid(m);
    expect(meshVolume(m)).toBeCloseTo(polygonFactor(32) * 3, 9);
    const b = meshBounds(m)!;
    expect(b.min.z).toBeCloseTo(10, 9);
    expect(b.max.z).toBeCloseTo(11, 9);
  });

  it('refuses invalid input with precise messages', () => {
    const p = prof([rect(1, 0, 2, 1)]);
    expect(() => revolveMesh(p, yAxis, 0)).toThrow(/non-zero finite/);
    expect(() => revolveMesh(p, yAxis, 7)).toThrow(/at most one full turn/);
    expect(() => revolveMesh(p, { origin: v3(0, 0, 0), dir: v3(0, 0, 0) }, 1)).toThrow(/direction is zero/);
    expect(() => revolveMesh(p, { origin: v3(0, 0, 0), dir: v3(0, 0, 1) }, 1)).toThrow(/plane of the profile/);
    expect(() => revolveMesh(p, { origin: v3(0, 0, 1), dir: v3(0, 1, 0) }, 1)).toThrow(/plane of the profile/);
    expect(() => revolveMesh(prof([rect(-1, 0, 1, 1)]), yAxis, 1)).toThrow(/crosses the axis/);
    expect(() => revolveMesh(prof([cw(rect(1, 0, 2, 1))]), yAxis, 1)).toThrow(/counter-clockwise/);
  });

  it('is deterministic', () => {
    const p = prof([rect(1, 0, 2, 1)]);
    expect(revolveMesh(p, yAxis, 1.2, 40)).toEqual(revolveMesh(p, yAxis, 1.2, 40));
  });
});
