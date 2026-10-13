/** 3D math: matrices against hand-computed values, inverse round trips, ray hits and misses. */
import { describe, expect, it } from 'vitest';
import {
  type Mat4, type Vec3, EPS3, WORLD_XY_FRAME, aabbCenter, aabbFromPoints, aabbSize, aabbTransform, aabbUnion, add3, cross3, dist3, dot3, eq3, finite3,
  frameFromPlane, frameToWorld, intersectRayAabb, isOrthonormalFrame, intersectRayPlane, intersectRayTriangle, len3, lerp3, mat4Determinant, mat4Identity, mat4Invert,
  mat4LookAt, mat4Multiply, mat4Orthographic, mat4Perspective, mat4RotationAxis, mat4RotationX, mat4RotationY, mat4RotationZ, mat4Scaling,
  mat4Translation, mat4Transpose, normalize3, scale3, sub3, transformDirection, transformPoint, v3, worldToFrame,
} from '../src/model3d/math';

function expectVec(actual: Vec3, expected: Vec3, tol = 1e-12): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tol);
  expect(Math.abs(actual.z - expected.z)).toBeLessThanOrEqual(tol);
}

function expectMat(actual: Mat4, expected: Mat4, tol = 1e-12): void {
  expect(actual).toHaveLength(16);
  for (let i = 0; i < 16; i++) expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tol);
}

describe('vectors', () => {
  it('basic operations follow the right-hand rule', () => {
    expect(cross3(v3(1, 0, 0), v3(0, 1, 0))).toEqual(v3(0, 0, 1));
    expect(cross3(v3(0, 1, 0), v3(0, 0, 1))).toEqual(v3(1, 0, 0));
    expect(add3(v3(1, 2, 3), v3(4, 5, 6))).toEqual(v3(5, 7, 9));
    expect(sub3(v3(1, 2, 3), v3(4, 5, 6))).toEqual(v3(-3, -3, -3));
    expect(scale3(v3(1, 2, 3), 2)).toEqual(v3(2, 4, 6));
    expect(dot3(v3(1, 2, 3), v3(4, 5, 6))).toBe(32);
    expect(len3(v3(3, 4, 12))).toBe(13);
    expect(dist3(v3(1, 1, 1), v3(4, 5, 1))).toBe(5);
    expect(lerp3(v3(0, 0, 0), v3(2, 4, 6), 0.5)).toEqual(v3(1, 2, 3));
    expect(v3(1, 2)).toEqual({ x: 1, y: 2, z: 0 });
  });

  it('normalize3 returns a unit vector, or zero for a zero vector', () => {
    expectVec(normalize3(v3(0, 3, 4)), v3(0, 0.6, 0.8));
    expect(normalize3(v3(0, 0, 0))).toEqual(v3(0, 0, 0));
    expect(normalize3(v3(NaN, 0, 0))).toEqual(v3(0, 0, 0));
  });

  it('eq3 and finite3', () => {
    expect(eq3(v3(1, 1, 1), v3(1 + EPS3 / 2, 1, 1))).toBe(true);
    expect(eq3(v3(1, 1, 1), v3(1 + 1e-6, 1, 1))).toBe(false);
    expect(eq3(v3(1, 1, 1), v3(1.1, 1, 1), 0.2)).toBe(true);
    expect(finite3(v3(1, 2, 3))).toBe(true);
    expect(finite3(v3(1, Infinity, 3))).toBe(false);
    expect(finite3(v3(1, 2, NaN))).toBe(false);
  });
});

describe('matrices', () => {
  it('are column-major with translation in elements 12..14', () => {
    const t = mat4Translation(1, 2, 3);
    expect([t[12], t[13], t[14]]).toEqual([1, 2, 3]);
    expect(transformPoint(t, v3(1, 1, 1))).toEqual(v3(2, 3, 4));
    expect(transformDirection(t, v3(1, 1, 1))).toEqual(v3(1, 1, 1));
  });

  it('multiply applies the right-hand matrix first', () => {
    const m = mat4Multiply(mat4Translation(10, 0, 0), mat4Scaling(2, 2, 2));
    expect(transformPoint(m, v3(1, 1, 1))).toEqual(v3(12, 2, 2));
    const n = mat4Multiply(mat4Scaling(2, 2, 2), mat4Translation(10, 0, 0));
    expect(transformPoint(n, v3(1, 1, 1))).toEqual(v3(22, 2, 2));
    expectMat(mat4Multiply(mat4Identity(), m), m);
  });

  it('rotations are right-handed', () => {
    const q = Math.PI / 2;
    expectVec(transformPoint(mat4RotationZ(q), v3(1, 0, 0)), v3(0, 1, 0));
    expectVec(transformPoint(mat4RotationX(q), v3(0, 1, 0)), v3(0, 0, 1));
    expectVec(transformPoint(mat4RotationY(q), v3(0, 0, 1)), v3(1, 0, 0));
    expectMat(mat4RotationAxis(v3(0, 0, 5), 0.7), mat4RotationZ(0.7));
    expectMat(mat4RotationAxis(v3(2, 0, 0), -0.3), mat4RotationX(-0.3));
    expectMat(mat4RotationAxis(v3(0, 1, 0), 1.1), mat4RotationY(1.1));
    // A third of a turn about (1, 1, 1) cycles the axes X -> Y -> Z.
    expectVec(transformPoint(mat4RotationAxis(v3(1, 1, 1), (2 * Math.PI) / 3), v3(1, 0, 0)), v3(0, 1, 0));
    expectMat(mat4RotationAxis(v3(0, 0, 0), 1), mat4Identity());
  });

  it('determinant and transpose', () => {
    expect(mat4Determinant(mat4Identity())).toBe(1);
    expect(mat4Determinant(mat4Scaling(2, 3, 4))).toBe(24);
    expect(mat4Determinant(mat4Scaling(-1, 1, 1))).toBe(-1);
    expect(mat4Determinant(mat4RotationAxis(v3(1, 2, 3), 0.4))).toBeCloseTo(1, 12);
    const m = mat4Multiply(mat4Translation(1, 2, 3), mat4RotationX(0.5));
    expectMat(mat4Transpose(mat4Transpose(m)), m);
    expect(mat4Transpose(m)[3]).toBe(1);
  });

  it('invert round trips composed transforms', () => {
    const transforms = [
      mat4Multiply(mat4Translation(5, -3, 2), mat4Multiply(mat4RotationAxis(v3(1, 2, 3), 0.9), mat4Scaling(2, 0.5, 3))),
      mat4Multiply(mat4RotationX(1.3), mat4Multiply(mat4RotationY(-0.4), mat4Translation(100, 200, -300))),
      mat4Perspective(1, 1.5, 0.1, 100),
      mat4LookAt(v3(3, 4, 5), v3(0, 0, 0), v3(0, 0, 1)),
      mat4Scaling(1e-6, 1e-6, 1e-6),
    ];
    for (const m of transforms) {
      const inv = mat4Invert(m);
      expect(inv).not.toBeNull();
      expectMat(mat4Multiply(m, inv!), mat4Identity(), 1e-9);
      expectMat(mat4Multiply(inv!, m), mat4Identity(), 1e-9);
    }
    expect(mat4Invert(mat4Scaling(1, 0, 1))).toBeNull();
    expect(mat4Invert(new Array<number>(16).fill(0))).toBeNull();
  });

  it('lookAt places the camera at the origin looking down -Z', () => {
    // Camera on +Z looking at the origin with Y up: a pure translation by -5 along Z.
    expectMat(mat4LookAt(v3(0, 0, 5), v3(0, 0, 0), v3(0, 1, 0)), mat4Translation(0, 0, -5));
    // Camera on +X with Z up: world +Y is screen right, world +Z is screen up.
    const m = mat4LookAt(v3(5, 0, 0), v3(0, 0, 0), v3(0, 0, 1));
    expectVec(transformPoint(m, v3(0, 0, 0)), v3(0, 0, -5));
    expectVec(transformPoint(m, v3(0, 1, 0)), v3(1, 0, -5));
    expectVec(transformPoint(m, v3(0, 0, 1)), v3(0, 1, -5));
    expectVec(transformPoint(m, v3(5, 0, 0)), v3(0, 0, 0));
    expect(mat4Determinant(m)).toBeCloseTo(1, 12);
  });

  it('lookAt survives an up vector parallel to the view direction', () => {
    const m = mat4LookAt(v3(0, 0, 10), v3(0, 0, 0), v3(0, 0, 1));
    expect(m.every(Number.isFinite)).toBe(true);
    expect(mat4Determinant(m)).toBeCloseTo(1, 12);
    expectVec(transformPoint(m, v3(0, 0, 0)), v3(0, 0, -10));
    const same = mat4LookAt(v3(1, 1, 1), v3(1, 1, 1), v3(0, 1, 0));
    expect(same.every(Number.isFinite)).toBe(true);
  });

  it('perspective matches the OpenGL matrix', () => {
    const m = mat4Perspective(Math.PI / 2, 2, 1, 10);
    expectMat(m, [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -11 / 9, -1, 0, 0, -20 / 9, 0]);
    expectVec(transformPoint(m, v3(0, 0, -1)), v3(0, 0, -1));
    expectVec(transformPoint(m, v3(0, 0, -10)), v3(0, 0, 1));
    // The top edge of the near plane (tan 45 deg = 1) maps to NDC y = 1; x is halved by the aspect.
    expectVec(transformPoint(m, v3(1, 1, -1)), v3(0.5, 1, -1));
    const inf = mat4Perspective(Math.PI / 2, 1, 1, Infinity);
    expectMat(inf, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -2, 0]);
    expect(transformPoint(inf, v3(0, 0, -1)).z).toBeCloseTo(-1, 12);
    expect(transformPoint(inf, v3(0, 0, -1e9)).z).toBeLessThan(1);
    expect(transformPoint(inf, v3(0, 0, -1e9)).z).toBeGreaterThan(0.999);
  });

  it('orthographic matches glOrtho', () => {
    const m = mat4Orthographic(-2, 2, -1, 1, 1, 11);
    expectMat(m, [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.2, 0, 0, 0, -1.2, 1]);
    expectVec(transformPoint(m, v3(2, 1, -1)), v3(1, 1, -1));
    expectVec(transformPoint(m, v3(-2, -1, -11)), v3(-1, -1, 1));
    expectVec(transformPoint(m, v3(0, 0, -6)), v3(0, 0, 0));
  });
});

describe('rays', () => {
  const down = { origin: v3(0.25, 0.25, 5), dir: v3(0, 0, -1) };

  it('ray / plane hits, misses parallel planes and planes behind', () => {
    expect(intersectRayPlane(down, { origin: v3(0, 0, 0), normal: v3(0, 0, 1) })).toBe(5);
    expect(intersectRayPlane(down, { origin: v3(0, 0, 0), normal: v3(0, 0, -3) })).toBe(5);
    expect(intersectRayPlane({ origin: v3(0, 0, 5), dir: v3(0, 0, -2) }, { origin: v3(0, 0, 1), normal: v3(0, 0, 1) })).toBe(2);
    expect(intersectRayPlane(down, { origin: v3(0, 0, 10), normal: v3(0, 0, 1) })).toBeNull();
    expect(intersectRayPlane(down, { origin: v3(0, 0, 0), normal: v3(1, 0, 0) })).toBeNull();
    expect(intersectRayPlane(down, { origin: v3(0, 0, 5), normal: v3(0, 0, 1) })).toBe(0);
  });

  it('ray / triangle hits both windings with barycentrics', () => {
    const a = v3(0, 0, 0), b = v3(1, 0, 0), c = v3(0, 1, 0);
    const ccw = intersectRayTriangle(down, a, b, c);
    expect(ccw).not.toBeNull();
    expect(ccw!.t).toBeCloseTo(5, 12);
    expect(ccw!.u).toBeCloseTo(0.25, 12);
    expect(ccw!.v).toBeCloseTo(0.25, 12);
    const cw = intersectRayTriangle(down, a, c, b);
    expect(cw).not.toBeNull();
    expect(cw!.t).toBeCloseTo(5, 12);
    // From below, too (no back-face culling).
    expect(intersectRayTriangle({ origin: v3(0.25, 0.25, -2), dir: v3(0, 0, 1) }, a, b, c)!.t).toBeCloseTo(2, 12);
  });

  it('ray / triangle misses outside, behind, parallel and degenerate', () => {
    const a = v3(0, 0, 0), b = v3(1, 0, 0), c = v3(0, 1, 0);
    expect(intersectRayTriangle({ origin: v3(0.75, 0.75, 5), dir: v3(0, 0, -1) }, a, b, c)).toBeNull();
    expect(intersectRayTriangle({ origin: v3(-0.1, 0.5, 5), dir: v3(0, 0, -1) }, a, b, c)).toBeNull();
    expect(intersectRayTriangle({ origin: v3(0.25, 0.25, 5), dir: v3(0, 0, 1) }, a, b, c)).toBeNull();
    expect(intersectRayTriangle({ origin: v3(-1, 0.2, 0), dir: v3(1, 0, 0) }, a, b, c)).toBeNull();
    expect(intersectRayTriangle(down, a, b, v3(2, 0, 0))).toBeNull();
  });

  it('ray / triangle counts hits on a shared edge', () => {
    const hit = intersectRayTriangle({ origin: v3(0.5, 0.5, 1), dir: v3(0, 0, -1) }, v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
    expect(hit).not.toBeNull();
    expect(hit!.u + hit!.v).toBeCloseTo(1, 12);
  });
});

describe('bounding boxes', () => {
  const box = aabbFromPoints([v3(1, 2, 3), v3(-1, 5, 0), v3(0, 0, 4)])!;

  it('from points, union, centre and size', () => {
    expect(box).toEqual({ min: v3(-1, 0, 0), max: v3(1, 5, 4) });
    expect(aabbFromPoints([])).toBeNull();
    expect(aabbFromPoints([v3(NaN, 0, 0)])).toBeNull();
    expect(aabbCenter(box)).toEqual(v3(0, 2.5, 2));
    expect(aabbSize(box)).toEqual(v3(2, 5, 4));
    expect(aabbUnion(null, box)).toBe(box);
    expect(aabbUnion(box, null)).toBe(box);
    expect(aabbUnion(null, null)).toBeNull();
    expect(aabbUnion(box, { min: v3(0, -1, 0), max: v3(3, 1, 1) })).toEqual({ min: v3(-1, -1, 0), max: v3(3, 5, 4) });
  });

  it('transform encloses every corner', () => {
    const r = aabbTransform(box, mat4RotationZ(Math.PI / 2))!;
    expectVec(r.min, v3(-5, -1, 0));
    expectVec(r.max, v3(0, 1, 4));
    expect(aabbTransform(box, mat4Translation(1, 1, 1))).toEqual({ min: v3(0, 1, 1), max: v3(2, 6, 5) });
  });

  it('ray / box entry, inside and misses', () => {
    const unit = { min: v3(0, 0, 0), max: v3(1, 1, 1) };
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 5), dir: v3(0, 0, -1) }, unit)).toBe(4);
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 0.5), dir: v3(1, 0, 0) }, unit)).toBe(0);
    expect(intersectRayAabb({ origin: v3(2, 0.5, 5), dir: v3(0, 0, -1) }, unit)).toBeNull();
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 5), dir: v3(0, 0, 1) }, unit)).toBeNull();
    expect(intersectRayAabb({ origin: v3(-1, -1, -1), dir: v3(1, 1, 1) }, unit)).toBeCloseTo(1, 12);
    expect(intersectRayAabb({ origin: v3(-1, 2, 0.5), dir: v3(1, -1, 0) }, unit)).toBeCloseTo(1, 12);
  });

  it('ray / box rejects non-finite rays and treats a zero direction as a point query', () => {
    const unit = { min: v3(0, 0, 0), max: v3(1, 1, 1) };
    expect(intersectRayAabb({ origin: v3(NaN, 0.5, 0.5), dir: v3(1, 0, 0) }, unit)).toBeNull();
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 5), dir: v3(0, 0, -Infinity) }, unit)).toBeNull();
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 5), dir: v3(0, NaN, -1) }, unit)).toBeNull();
    expect(intersectRayAabb({ origin: v3(0.5, 0.5, 0.5), dir: v3(0, 0, 0) }, unit)).toBe(0);
    expect(intersectRayAabb({ origin: v3(2, 0.5, 0.5), dir: v3(0, 0, 0) }, unit)).toBeNull();
  });
});

describe('frames', () => {
  it('the world frame maps to the identity', () => {
    expectMat(frameToWorld(WORLD_XY_FRAME), mat4Identity());
    expect(Object.isFrozen(WORLD_XY_FRAME)).toBe(true);
    const f = frameFromPlane({ origin: v3(0, 0, 0), normal: v3(0, 0, 2) });
    expectVec(f.xAxis, v3(1, 0, 0));
    expectVec(f.yAxis, v3(0, 1, 0));
    expectVec(f.zAxis, v3(0, 0, 1));
  });

  it('frameFromPlane follows the Arbitrary Axis Algorithm and is orthonormal and right-handed', () => {
    // A plane facing +X: Ax = Wz x N = (0, 1, 0), Ay = N x Ax = (0, 0, 1) (AutoCAD's OCS for that extrusion).
    const side = frameFromPlane({ origin: v3(1, 2, 3), normal: v3(5, 0, 0) });
    expectVec(side.xAxis, v3(0, 1, 0));
    expectVec(side.yAxis, v3(0, 0, 1));
    expectVec(side.zAxis, v3(1, 0, 0));
    for (const normal of [v3(1, 2, 3), v3(0, 0, -1), v3(0.001, 0, 1), v3(-4, 1, 0)]) {
      const f = frameFromPlane({ origin: v3(0, 0, 0), normal });
      for (const axis of [f.xAxis, f.yAxis, f.zAxis]) expect(len3(axis)).toBeCloseTo(1, 12);
      expect(dot3(f.xAxis, f.yAxis)).toBeCloseTo(0, 12);
      expectVec(cross3(f.xAxis, f.yAxis), f.zAxis);
      expect(mat4Determinant(frameToWorld(f))).toBeCloseTo(1, 12);
    }
  });

  it('isOrthonormalFrame accepts rigid frames and rejects degenerate ones', () => {
    expect(isOrthonormalFrame(WORLD_XY_FRAME)).toBe(true);
    expect(isOrthonormalFrame(frameFromPlane({ origin: v3(1, 2, 3), normal: v3(1, -2, 0.5) }))).toBe(true);
    const w = WORLD_XY_FRAME;
    expect(isOrthonormalFrame({ ...w, xAxis: v3(2, 0, 0) })).toBe(false); // scaled
    expect(isOrthonormalFrame({ ...w, yAxis: v3(Math.SQRT1_2, Math.SQRT1_2, 0) })).toBe(false); // sheared
    expect(isOrthonormalFrame({ ...w, zAxis: v3(0, 0, -1) })).toBe(false); // left-handed
    expect(isOrthonormalFrame({ ...w, zAxis: v3(0, 0, 0) })).toBe(false); // collapsed
    expect(isOrthonormalFrame({ ...w, origin: v3(NaN, 0, 0) })).toBe(false);
    expect(isOrthonormalFrame({ ...w, xAxis: v3(1 + 1e-6, 0, 0) })).toBe(false);
    expect(isOrthonormalFrame({ ...w, xAxis: v3(1 + 1e-6, 0, 0) }, 1e-5)).toBe(true);
  });

  it('worldToFrame inverts frameToWorld', () => {
    const f = frameFromPlane({ origin: v3(4, -2, 7), normal: v3(1, -1, 2) });
    expectMat(mat4Multiply(worldToFrame(f), frameToWorld(f)), mat4Identity(), 1e-12);
    expectVec(transformPoint(frameToWorld(f), v3(0, 0, 0)), v3(4, -2, 7));
  });
});
