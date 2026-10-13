/**
 * 3D vector, matrix and intersection math for the experimental 3D model.
 *
 * Conventions (shared by every module under src/model3d):
 * - World coordinates are AutoCAD's WCS: X right, Y up, Z toward the viewer, right-handed. The 2D
 *   drawing plane is the world XY plane at z = 0, so a 2D `Point {x, y}` is the 3D point (x, y, 0).
 * - Lengths are drawing units (the header's units); angles are radians, positive counter-clockwise
 *   when looking from the tip of the rotation axis toward the origin (right-hand rule).
 * - `Mat4` is a 16-element column-major array, the layout WebGL's `uniformMatrix4fv` expects:
 *   element (row r, column c) is `m[c * 4 + r]`, points are column vectors and `mat4Multiply(a, b)`
 *   applies `b` first. Matrices are plain arrays so they can live inside sealed drawing state.
 * - Every function returns new values and never mutates its inputs.
 */

/** A point or direction in world (or frame-local) coordinates. Plain data, never mutated. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 4x4 matrix, column-major (WebGL layout); always 16 numbers when built by this module. */
export type Mat4 = readonly number[];

/**
 * Tolerance for exact-geometry comparisons (coincident points, parallel tests). It matches the 2D
 * core's EPS so a 2D point lifted to z = 0 compares the same way in both modules; tolerances that
 * must scale with model size (mesh welding) are relative instead and documented where used.
 */
export const EPS3 = 1e-9;

/** Build a vector; `z` defaults to 0 so a 2D coordinate pair lifts onto the world XY plane. */
export function v3(x: number, y: number, z = 0): Vec3 {
  return { x, y, z };
}

/** Component-wise sum a + b. */
export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** Component-wise difference a - b (the vector from b to a). */
export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Uniform scale of a vector by `s`. */
export function scale3(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** Dot product. */
export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Right-handed cross product a x b (X x Y = Z). */
export function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Euclidean length; uses Math.hypot so very large or tiny components do not overflow. */
export function len3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Euclidean distance between two points. */
export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Unit vector in the direction of `a`. A zero-length (or non-finite) input has no direction, so
 * the result is the zero vector rather than NaNs; callers that need a direction must check
 * `len3(result) > 0`.
 */
export function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  if (!(l > 0) || !Number.isFinite(l)) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Linear interpolation: t = 0 gives a, t = 1 gives b (t is not clamped). */
export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** True when every component differs by at most `tol` (an absolute tolerance in drawing units). */
export function eq3(a: Vec3, b: Vec3, tol = EPS3): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;
}

/** True when all three components are finite numbers (no NaN / Infinity). */
export function finite3(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

// ---- matrices --------------------------------------------------------------------------------

type Sixteen = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
type Twelve = [number, number, number, number, number, number, number, number, number, number, number, number];

/** The identity matrix. */
export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Matrix product a * b (column-major). Applied to a point, the result transforms by `b` first and
 * then by `a`, so `mat4Multiply(view, model)` maps model coordinates to view coordinates.
 */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Translation by (x, y, z) in drawing units. */
export function mat4Translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/**
 * Non-uniform scale about the origin. A negative factor (or an odd number of them) mirrors space,
 * which reverses triangle winding; `transformMesh` compensates for that automatically.
 */
export function mat4Scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** Rotation by `angle` radians about the world X axis (right-hand rule: +Y turns toward +Z). */
export function mat4RotationX(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/** Rotation by `angle` radians about the world Y axis (right-hand rule: +Z turns toward +X). */
export function mat4RotationY(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** Rotation by `angle` radians about the world Z axis (right-hand rule: +X turns toward +Y, as in 2D). */
export function mat4RotationZ(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Rotation by `angle` radians about `axis` through the origin (Rodrigues formula, right-hand
 * rule). The axis need not be unit length; a zero axis has no direction and yields the identity.
 */
export function mat4RotationAxis(axis: Vec3, angle: number): Mat4 {
  const n = normalize3(axis);
  if (n.x === 0 && n.y === 0 && n.z === 0) return mat4Identity();
  const { x, y, z } = n;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/**
 * View matrix of a camera at `eye` looking at `target` (gluLookAt convention): in view space the
 * camera sits at the origin looking down -Z with +Y up and +X right, right-handed. `up` only needs
 * to be roughly up; when it is parallel to the viewing direction another world axis is used so the
 * matrix stays valid (e.g. looking straight down the Z axis with up = +Z). When eye equals target
 * the camera looks down world -Z (the plan view).
 */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  let f = normalize3(sub3(target, eye));
  if (len3(f) === 0) f = { x: 0, y: 0, z: -1 };
  let s = normalize3(cross3(f, up));
  if (len3(s) === 0 || Math.abs(dot3(f, normalize3(up))) > 1 - EPS3) {
    // `up` is parallel to the view direction: use the world axis least aligned with it instead.
    const alt = Math.abs(f.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
    s = normalize3(cross3(f, alt));
  }
  const u = cross3(s, f);
  return [
    s.x, u.x, -f.x, 0,
    s.y, u.y, -f.y, 0,
    s.z, u.z, -f.z, 0,
    -dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1,
  ];
}

/**
 * Perspective projection (OpenGL / WebGL clip space: view-space -Z forward, NDC z in [-1, 1] with
 * near -> -1 and far -> +1). `fovY` is the full vertical field of view in radians, `aspect` is
 * width / height, `near` and `far` are positive distances in front of the camera. `far` may be
 * Infinity for an infinite far plane (no far clipping).
 */
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const out = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -2 * near, 0];
  if (Number.isFinite(far)) {
    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  }
  return out;
}

/**
 * Orthographic projection (glOrtho convention): maps the view-space box x in [l, r], y in [b, t],
 * z in [-n, -f] (the camera looks down -Z, so n and f are distances in front of it) to NDC
 * [-1, 1]^3 with near -> -1.
 */
export function mat4Orthographic(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  return [
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ];
}

/** Transpose (rows become columns). */
export function mat4Transpose(m: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[r * 4 + c] = m[c * 4 + r]!;
  return out;
}

/** The twelve 2x2 sub-determinants shared by the determinant and the inverse. */
function subDeterminants(m: Mat4): Twelve {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as Sixteen;
  return [
    a00 * a11 - a01 * a10, a00 * a12 - a02 * a10, a00 * a13 - a03 * a10,
    a01 * a12 - a02 * a11, a01 * a13 - a03 * a11, a02 * a13 - a03 * a12,
    a20 * a31 - a21 * a30, a20 * a32 - a22 * a30, a20 * a33 - a23 * a30,
    a21 * a32 - a22 * a31, a21 * a33 - a23 * a31, a22 * a33 - a23 * a32,
  ];
}

/**
 * Determinant. Negative for transforms that mirror space (they reverse triangle winding), zero
 * for singular ones (projections onto a plane).
 */
export function mat4Determinant(m: Mat4): number {
  const [b00, b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11] = subDeterminants(m);
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

/**
 * Inverse matrix, or null when `m` is singular (determinant exactly 0) or the inverse is not
 * finite. No tolerance is applied: a tiny but valid scale (e.g. 1e-6 units) must still invert.
 */
export function mat4Invert(m: Mat4): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as Sixteen;
  const [b00, b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11] = subDeterminants(m);
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) return null;
  const d = 1 / det;
  const out = [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
  return out.every(Number.isFinite) ? out : null;
}

/**
 * Transform a point (w = 1), including translation. When the matrix is projective (the resulting
 * w is neither 1 nor 0) the result is divided by w, so a projection matrix yields NDC directly.
 */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!;
  const y = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!;
  const z = m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!;
  const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!;
  if (w === 1 || w === 0) return { x, y, z };
  return { x: x / w, y: y / w, z: z / w };
}

/**
 * Transform a direction (w = 0): translation is ignored and the result is not normalised. Surface
 * normals under non-uniform scale need the inverse transpose instead (`flatNormals` sidesteps that
 * by recomputing normals from the transformed triangles).
 */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0]! * d.x + m[4]! * d.y + m[8]! * d.z,
    y: m[1]! * d.x + m[5]! * d.y + m[9]! * d.z,
    z: m[2]! * d.x + m[6]! * d.y + m[10]! * d.z,
  };
}

// ---- planes, rays, boxes ---------------------------------------------------------------------

/** An infinite plane through `origin`; `normal` need not be unit length but must be non-zero. */
export interface Plane {
  readonly origin: Vec3;
  readonly normal: Vec3;
}

/**
 * A half-line origin + t * dir for t >= 0. `dir` need not be unit length; every returned `t` is in
 * multiples of `dir`, so with a unit direction it is a distance in drawing units.
 */
export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

/**
 * Ray parameter where the ray meets the plane, or null when it is parallel to the plane (angle
 * below ~EPS3 radians), the plane is behind the ray origin, or an input is degenerate. A ray
 * starting on the plane returns 0. Both sides of the plane are hit (no back-face culling).
 */
export function intersectRayPlane(ray: Ray, plane: Plane): number | null {
  const denom = dot3(plane.normal, ray.dir);
  const scale = len3(plane.normal) * len3(ray.dir);
  if (!(scale > 0) || Math.abs(denom) <= EPS3 * scale) return null;
  const t = dot3(plane.normal, sub3(plane.origin, ray.origin)) / denom;
  // `+ 0` turns -0 (a ray starting on the plane) into 0.
  return t >= 0 && Number.isFinite(t) ? t + 0 : null;
}

/**
 * Ray / triangle intersection (Moller-Trumbore) for either winding: no back-face culling, so a
 * picking ray hits a face seen from inside a solid too. Returns the ray parameter `t` (t >= 0) and
 * the barycentric coordinates (u, v) of the hit point a + u (b - a) + v (c - a); null on a miss,
 * for a degenerate triangle, or when the ray is parallel to the triangle's plane. Hits on an edge
 * count (EPS3 slack in barycentric space), so a ray through a shared edge cannot slip between two
 * triangles.
 */
export function intersectRayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): { t: number; u: number; v: number } | null {
  const e1 = sub3(b, a), e2 = sub3(c, a);
  const p = cross3(ray.dir, e2);
  const det = dot3(e1, p);
  // |det| = |dir . (e1 x e2)|: compare against the product of the lengths so the test is scale-free.
  const scale = len3(ray.dir) * len3(cross3(e1, e2));
  if (!(scale > 0) || Math.abs(det) <= EPS3 * scale) return null;
  const inv = 1 / det;
  const s = sub3(ray.origin, a);
  const u = dot3(s, p) * inv;
  if (u < -EPS3 || u > 1 + EPS3) return null;
  const q = cross3(s, e1);
  const v = dot3(ray.dir, q) * inv;
  if (v < -EPS3 || u + v > 1 + EPS3) return null;
  const t = dot3(e2, q) * inv;
  return t >= 0 && Number.isFinite(t) ? { t: t + 0, u, v } : null;
}

/** Axis-aligned bounding box in world coordinates; min <= max on every axis. */
export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Smallest box containing every point, or null for no points. Non-finite points are skipped. */
export function aabbFromPoints(points: Iterable<Vec3>): Aabb | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (!finite3(p)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (minX > maxX) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/** Union of two boxes; null stands for "empty", so this folds over a list starting from null. */
export function aabbUnion(a: Aabb | null, b: Aabb | null): Aabb | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}

/** Centre point of a box. */
export function aabbCenter(box: Aabb): Vec3 {
  return lerp3(box.min, box.max, 0.5);
}

/** Extent of a box along each axis (max - min), in drawing units. */
export function aabbSize(box: Aabb): Vec3 {
  return sub3(box.max, box.min);
}

/**
 * Axis-aligned box enclosing `box` after transforming it by `m` (all eight corners are
 * transformed, so the result is conservative under rotation and exact for translation / scale).
 * Returns null only when every transformed corner is non-finite.
 */
export function aabbTransform(box: Aabb, m: Mat4): Aabb | null {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(transformPoint(m, { x: i & 1 ? box.max.x : box.min.x, y: i & 2 ? box.max.y : box.min.y, z: i & 4 ? box.max.z : box.min.z }));
  }
  return aabbFromPoints(corners);
}

/**
 * Ray parameter where the ray enters the box (slab method), 0 when the origin is already inside,
 * or null on a miss. Boundary contact (grazing a face or edge) counts as a hit. A non-finite
 * origin or direction returns null. A zero direction is a point query: 0 when the origin is
 * inside (or on) the box, null otherwise.
 */
export function intersectRayAabb(ray: Ray, box: Aabb): number | null {
  if (!finite3(ray.origin) || !finite3(ray.dir)) return null;
  let tMin = 0, tMax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = ray.origin[axis], d = ray.dir[axis], lo = box.min[axis], hi = box.max[axis];
    if (d === 0) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

// ---- frames ----------------------------------------------------------------------------------

/**
 * A placement: an origin plus three orthonormal, right-handed axes (zAxis = xAxis x yAxis), all in
 * world coordinates. Primitive features are modelled in their frame's local coordinates and
 * placed with `frameToWorld`; a profile's 2D points live in the frame's XY plane.
 */
export interface Frame3 {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
}

/**
 * True when the frame is usable as a rigid placement: finite origin and axes, each axis of unit
 * length and the axes mutually perpendicular within `tol`, and right-handed (xAxis x yAxis equals
 * zAxis within `tol`). A frame failing this would shear, scale or mirror the geometry placed with
 * it, so mesh builders reject it instead of producing a distorted or inside-out solid.
 */
export function isOrthonormalFrame(frame: Frame3, tol = 1e-9): boolean {
  const { origin, xAxis: x, yAxis: y, zAxis: z } = frame;
  if (![origin, x, y, z].every((v) => !!v && finite3(v))) return false;
  if ([x, y, z].some((v) => Math.abs(len3(v) - 1) > tol)) return false;
  if (Math.abs(dot3(x, y)) > tol || Math.abs(dot3(y, z)) > tol || Math.abs(dot3(z, x)) > tol) return false;
  return eq3(cross3(x, y), z, tol);
}

/** The world coordinate system itself: the 2D drawing plane, Z toward the viewer. Frozen. */
export const WORLD_XY_FRAME: Frame3 = Object.freeze({
  origin: Object.freeze(v3(0, 0, 0)),
  xAxis: Object.freeze(v3(1, 0, 0)),
  yAxis: Object.freeze(v3(0, 1, 0)),
  zAxis: Object.freeze(v3(0, 0, 1)),
});

/** Matrix mapping frame-local coordinates to world coordinates (columns: the axes, then the origin). */
export function frameToWorld(frame: Frame3): Mat4 {
  const { origin: o, xAxis: x, yAxis: y, zAxis: z } = frame;
  return [x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, o.x, o.y, o.z, 1];
}

/**
 * Matrix mapping world coordinates into the frame's local coordinates: the inverse of
 * `frameToWorld`, computed as a transpose because the axes are orthonormal.
 */
export function worldToFrame(frame: Frame3): Mat4 {
  const { origin: o, xAxis: x, yAxis: y, zAxis: z } = frame;
  return [x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, -dot3(x, o), -dot3(y, o), -dot3(z, o), 1];
}

/**
 * A frame on `plane`: origin at the plane origin, Z axis along the normalised plane normal. The
 * in-plane X axis follows AutoCAD's Arbitrary Axis Algorithm (the rule DXF uses to derive an
 * entity's OCS from its extrusion direction), so the result is deterministic, the world XY plane
 * gives the world frame, and a frame built from a DXF extrusion matches AutoCAD's OCS for it.
 * A zero normal falls back to world +Z.
 */
export function frameFromPlane(plane: Plane): Frame3 {
  let z = normalize3(plane.normal);
  if (len3(z) === 0) z = v3(0, 0, 1);
  const limit = 1 / 64;
  const x = normalize3(Math.abs(z.x) < limit && Math.abs(z.y) < limit ? cross3(v3(0, 1, 0), z) : cross3(v3(0, 0, 1), z));
  const y = normalize3(cross3(z, x));
  return { origin: plane.origin, xAxis: x, yAxis: y, zAxis: z };
}
