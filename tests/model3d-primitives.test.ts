/** Primitive solids: closed, outward (positive volume), analytic volumes, bounds, clamping, placement. */
import { describe, expect, it } from 'vitest';
import { type Frame3, WORLD_XY_FRAME, frameFromPlane, v3 } from '../src/model3d/math';
import { type Mesh3D, meshBounds, meshIsClosed, meshTriangleCount, meshVolume, validateMesh, weldVertices } from '../src/model3d/mesh';
import {
  DEFAULT_SEGMENTS, MAX_SEGMENTS, boxMesh, clampSegments, coneMesh, cylinderMesh, primitiveMesh, sphereMesh, torusMesh, wedgeMesh,
} from '../src/model3d/primitives';

/** Area factor of an inscribed regular n-gon: area = k * r^2. */
const polygonFactor = (n: number) => (n / 2) * Math.sin((2 * Math.PI) / n);

/**
 * Exact volume of the polygonal surface of revolution built from an (r, z) profile: every band is a
 * frustum of similar, aligned n-gons, so V = k * sum (z2 - z1)(r1^2 + r1 r2 + r2^2) / 3.
 */
function latheVolume(profile: readonly (readonly [number, number])[], n: number, closed: boolean): number {
  let sum = 0;
  const count = closed ? profile.length : profile.length - 1;
  for (let i = 0; i < count; i++) {
    const [r1, z1] = profile[i]!, [r2, z2] = profile[(i + 1) % profile.length]!;
    sum += ((z2 - z1) * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
  }
  return polygonFactor(n) * sum;
}

function expectSolid(mesh: Mesh3D): void {
  expect(validateMesh(mesh)).toBeNull();
  expect(meshIsClosed(mesh)).toBe(true);
  expect(meshVolume(mesh)).toBeGreaterThan(0);
  // Already welded: welding removes nothing.
  expect(weldVertices(mesh).positions).toHaveLength(mesh.positions.length);
}

function expectRelative(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(tol);
}

describe('box and wedge', () => {
  it('box is closed with the exact volume and documented placement', () => {
    const m = boxMesh(2, 3, 4);
    expectSolid(m);
    expectRelative(meshVolume(m), 24, 1e-6);
    expect(meshTriangleCount(m)).toBe(12);
    expect(meshBounds(m)).toEqual({ min: v3(-1, -1.5, 0), max: v3(1, 1.5, 4) });
  });

  it('wedge is closed with half the box volume, full height at -X', () => {
    const m = wedgeMesh(2, 3, 4);
    expectSolid(m);
    expectRelative(meshVolume(m), 12, 1e-6);
    expect(meshTriangleCount(m)).toBe(8);
    expect(meshBounds(m)).toEqual({ min: v3(-1, -1.5, 0), max: v3(1, 1.5, 4) });
    for (let i = 0; i < m.positions.length; i += 3) if (m.positions[i + 2] === 4) expect(m.positions[i]).toBe(-1);
  });

  it('rejects non-positive or non-finite sizes', () => {
    expect(() => boxMesh(0, 1, 1)).toThrow(RangeError);
    expect(() => boxMesh(1, -1, 1)).toThrow(RangeError);
    expect(() => wedgeMesh(1, 1, NaN)).toThrow(RangeError);
    expect(() => wedgeMesh(Infinity, 1, 1)).toThrow(RangeError);
  });
});

describe('curved primitives', () => {
  it('cylinder volume equals the inscribed prism and approaches pi r^2 h', () => {
    for (const n of [3, 4, 7, 32, 100]) {
      const m = cylinderMesh(2, 5, n);
      expectSolid(m);
      expectRelative(meshVolume(m), polygonFactor(n) * 4 * 5, 1e-9);
      expect(meshTriangleCount(m)).toBe(4 * n);
    }
    expectRelative(meshVolume(cylinderMesh(2, 5, 256)), Math.PI * 4 * 5, 1e-3);
    const b = meshBounds(cylinderMesh(2, 5))!;
    expect(b.max.x).toBeCloseTo(2, 12);
    expect(b.min.x).toBeCloseTo(-2, 12);
    expect(b.min.z).toBe(0);
    expect(b.max.z).toBe(5);
    expect(Math.max(-b.min.y, b.max.y)).toBeLessThanOrEqual(2);
  });

  it('cone and frustum volumes equal the inscribed pyramid frustum', () => {
    const n = 24;
    for (const [r1, r2] of [[3, 0], [0, 3], [3, 1], [1, 3], [2, 2]] as const) {
      const m = coneMesh(r1, r2, 6, n);
      expectSolid(m);
      const a1 = polygonFactor(n) * r1 * r1, a2 = polygonFactor(n) * r2 * r2;
      expectRelative(meshVolume(m), (6 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), 1e-9);
      const b = meshBounds(m)!;
      expect(b.min.z).toBe(0);
      expect(b.max.z).toBe(6);
    }
    // A pointed end is a single apex vertex: one ring of n plus two axis vertices.
    expect(coneMesh(3, 0, 6, n).positions).toHaveLength(3 * (n + 2));
    expect(meshTriangleCount(coneMesh(3, 0, 6, n))).toBe(2 * n);
    expect(() => coneMesh(0, 0, 1)).toThrow(RangeError);
    expect(() => coneMesh(-1, 1, 1)).toThrow(RangeError);
    expect(() => coneMesh(1, 1, 0)).toThrow(RangeError);
  });

  it('sphere matches its polygonal approximation, centred on the origin', () => {
    const r = 3, n = 32, rings = 16;
    const m = sphereMesh(r, n, rings);
    expectSolid(m);
    const profile: [number, number][] = [];
    for (let k = 0; k <= rings; k++) {
      const phi = -Math.PI / 2 + (Math.PI * k) / rings;
      profile.push([k === 0 || k === rings ? 0 : r * Math.cos(phi), r * Math.sin(phi)]);
    }
    expectRelative(meshVolume(m), latheVolume(profile, n, false), 1e-9);
    const exact = (4 / 3) * Math.PI * r ** 3;
    expect(meshVolume(m)).toBeLessThan(exact);
    expect(meshVolume(m)).toBeGreaterThan(0.97 * exact);
    expect(meshTriangleCount(m)).toBe(2 * n * (rings - 1));
    const b = meshBounds(m)!;
    expect(b.min.z).toBeCloseTo(-r, 12);
    expect(b.max.z).toBeCloseTo(r, 12);
    expect(b.max.x).toBeCloseTo(r, 12);
    expect(() => sphereMesh(0)).toThrow(RangeError);
  });

  it('torus matches its polygonal approximation and Pappus in the limit', () => {
    const R = 5, r = 1, n = 48, rings = 24;
    const m = torusMesh(R, r, n, rings);
    expectSolid(m);
    const profile: [number, number][] = [];
    for (let k = 0; k < rings; k++) profile.push([R + r * Math.cos((2 * Math.PI * k) / rings), r * Math.sin((2 * Math.PI * k) / rings)]);
    expectRelative(meshVolume(m), latheVolume(profile, n, true), 1e-9);
    const pappus = 2 * Math.PI * R * Math.PI * r * r;
    expect(meshVolume(m)).toBeLessThan(pappus);
    expect(meshVolume(m)).toBeGreaterThan(0.98 * pappus);
    expect(meshTriangleCount(m)).toBe(2 * n * rings);
    const b = meshBounds(m)!;
    expect(b.max.x).toBeCloseTo(R + r, 12);
    expect(b.min.z).toBeCloseTo(-r, 12);
    expect(b.max.z).toBeCloseTo(r, 12);
    expect(() => torusMesh(1, 1)).toThrow(RangeError);
    expect(() => torusMesh(1, 2)).toThrow(RangeError);
    expect(() => torusMesh(1, 0)).toThrow(RangeError);
  });
});

describe('tessellation clamping', () => {
  it('clampSegments rounds, clamps and falls back', () => {
    expect(clampSegments(2.6, 32, 3, 256)).toBe(3);
    expect(clampSegments(1, 32, 3, 256)).toBe(3);
    expect(clampSegments(1e9, 32, 3, 256)).toBe(256);
    expect(clampSegments(10.4, 32, 3, 256)).toBe(10);
    expect(clampSegments(NaN, 32, 3, 256)).toBe(32);
    expect(clampSegments(undefined, 32, 3, 256)).toBe(32);
    expect(clampSegments('7' as unknown as number, 32, 3, 256)).toBe(32);
  });

  it('builders clamp out-of-range counts instead of failing', () => {
    expect(meshTriangleCount(cylinderMesh(1, 1, 1))).toBe(4 * 3);
    expect(meshTriangleCount(cylinderMesh(1, 1, 1e6))).toBe(4 * MAX_SEGMENTS);
    expect(meshTriangleCount(cylinderMesh(1, 1, NaN))).toBe(4 * DEFAULT_SEGMENTS);
    expect(meshTriangleCount(sphereMesh(1, 3, 1))).toBe(2 * 3 * (2 - 1));
    expectSolid(sphereMesh(1, 3, 1));
    expect(meshTriangleCount(torusMesh(2, 1, 3, 1))).toBe(2 * 3 * 3);
    expectSolid(torusMesh(2, 1, 3, 1));
    expect(meshTriangleCount(sphereMesh(1, 1e9, 1e9))).toBe(2 * 256 * 127);
  });
});

describe('primitiveMesh placement', () => {
  const moved: Frame3 = { ...WORLD_XY_FRAME, origin: v3(10, 20, 30) };

  it('places every primitive with its frame', () => {
    const features = [
      { kind: 'box', frame: moved, width: 2, depth: 2, height: 2 },
      { kind: 'wedge', frame: moved, width: 2, depth: 2, height: 2 },
      { kind: 'cylinder', frame: moved, radius: 1, height: 2 },
      { kind: 'cone', frame: moved, baseRadius: 1, topRadius: 0, height: 2 },
      { kind: 'sphere', frame: moved, radius: 1 },
      { kind: 'torus', frame: moved, majorRadius: 2, minorRadius: 0.5 },
    ] as const;
    for (const f of features) {
      const m = primitiveMesh(f);
      expectSolid(m);
      const b = meshBounds(m)!;
      expect((b.min.x + b.max.x) / 2).toBeCloseTo(10, 6);
      if (f.kind === 'sphere' || f.kind === 'torus') expect((b.min.z + b.max.z) / 2).toBeCloseTo(30, 9);
      else expect(b.min.z).toBeCloseTo(30, 12);
    }
  });

  it('honours feature tessellation and a tilted frame', () => {
    expect(meshTriangleCount(primitiveMesh({ kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 1, segments: 6 }))).toBe(24);
    // A frame facing +X: the box height runs along world +X.
    const side = frameFromPlane({ origin: v3(0, 0, 0), normal: v3(1, 0, 0) });
    const m = primitiveMesh({ kind: 'box', frame: side, width: 2, depth: 4, height: 6 });
    expectSolid(m);
    expectRelative(meshVolume(m), 48, 1e-9);
    const b = meshBounds(m)!;
    expect(b.min.x).toBeCloseTo(0, 12);
    expect(b.max.x).toBeCloseTo(6, 12);
    expect(b.max.y - b.min.y).toBeCloseTo(2, 12); // frame X = world Y
    expect(b.max.z - b.min.z).toBeCloseTo(4, 12); // frame Y = world Z
  });
});
