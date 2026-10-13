/**
 * Analytic primitives tessellated into closed, outward-facing indexed meshes.
 *
 * Placement convention (frame-local coordinates, drawing units, right-handed, Z up the frame):
 * - box, wedge, cylinder and cone stand on the local XY plane (z from 0 to height), centred on the
 *   origin in X and Y, and extend toward +Z;
 * - sphere and torus are centred on the origin (AutoCAD SPHERE / TORUS take a centre point), the
 *   torus axis along local Z.
 * Every mesh is welded by construction (shared vertices, no duplicates, poles are single vertices)
 * and wound counter-clockwise seen from outside, so `meshIsClosed` holds and `meshVolume` is
 * positive. Circles are inscribed polygons starting on the local +X axis, so curved volumes are
 * slightly below the analytic ones. Invalid dimensions throw a Model3DInputError (input-error.ts,
 * a RangeError); tessellation counts are clamped (see `clampSegments`), never rejected.
 */
import { frameToWorld, isOrthonormalFrame } from './math';
import { type Mesh3D, meshBounds, meshVolume, transformMesh, validateMesh } from './mesh';
import { Model3DInputError } from './input-error';
import type { PrimitiveFeature } from './types';

/** Default and limits for divisions around a circle. */
export const DEFAULT_SEGMENTS = 32;
export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 256;
/** Default and limits for sphere latitude bands / torus tube divisions. */
export const DEFAULT_RINGS = 16;
export const MIN_RINGS = 2;
export const MAX_RINGS = 128;
/**
 * Fewest divisions around a torus tube: a triangular cross-section is the smallest closed profile
 * (two would flatten the tube into a zero-volume sheet).
 */
export const MIN_TUBE_RINGS = 3;

/**
 * Clamp a tessellation count to an integer in [min, max]; non-numeric or non-finite input gives
 * `fallback`. Keeps a stored feature regenerable whatever was saved, and bounds mesh size
 * (MAX_SEGMENTS x MAX_RINGS x 2 triangles at most per primitive).
 */
export function clampSegments(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function requirePositive(name: string, value: number): void {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new Model3DInputError(`${name} must be a positive finite number (got ${String(value)}).`);
}

/**
 * Box of `w` (X) x `d` (Y) x `h` (Z), base on z = 0 centred on the origin: 8 vertices, 12
 * triangles, outward winding. Throws Model3DInputError unless every size is positive and finite.
 */
export function boxMesh(w: number, d: number, h: number): Mesh3D {
  requirePositive('Box width', w);
  requirePositive('Box depth', d);
  requirePositive('Box height', h);
  const x = w / 2, y = d / 2;
  const positions: number[] = [];
  // Vertex i has +X when bit 0 is set, +Y for bit 1, top (z = h) for bit 2.
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? x : -x, i & 2 ? y : -y, i & 4 ? h : 0);
  const indices = [
    0, 2, 1, 1, 2, 3, // bottom (-Z)
    4, 5, 6, 5, 7, 6, // top (+Z)
    0, 1, 5, 0, 5, 4, // front (-Y)
    2, 6, 7, 2, 7, 3, // back (+Y)
    0, 4, 6, 0, 6, 2, // left (-X)
    1, 3, 7, 1, 7, 5, // right (+X)
  ];
  return { positions, indices };
}

/**
 * Wedge of `w` (X) x `d` (Y) x `h` (Z), base on z = 0 centred on the origin, full height at
 * x = -w / 2 sloping down to the base edge at x = +w / 2 (AutoCAD WEDGE): 6 vertices, 8 triangles,
 * volume w * d * h / 2. Throws Model3DInputError unless every size is positive and finite.
 */
export function wedgeMesh(w: number, d: number, h: number): Mesh3D {
  requirePositive('Wedge width', w);
  requirePositive('Wedge depth', d);
  requirePositive('Wedge height', h);
  const x = w / 2, y = d / 2;
  const positions = [
    -x, -y, 0, x, -y, 0, -x, y, 0, x, y, 0, // 0..3 base corners (same numbering as the box)
    -x, -y, h, -x, y, h, // 4, 5 top edge over x = -w / 2
  ];
  const indices = [
    0, 2, 1, 1, 2, 3, // bottom (-Z)
    0, 4, 5, 0, 5, 2, // back face (-X)
    0, 1, 4, // side (-Y)
    2, 5, 3, // side (+Y)
    1, 3, 5, 1, 5, 4, // slope (+X +Z)
  ];
  return { positions, indices };
}

/**
 * Surface of revolution about local Z from a profile of (radius, z) points. `open` profiles run
 * from a point on the axis (r = 0) up the outside to another axis point; each axis point becomes a
 * single pole vertex, every other point a ring of `segments` vertices. A `closed` profile (torus
 * tube) has no poles and wraps around. Outward winding requires the profile to run
 * counter-clockwise in the (r, z) half-plane (r to the right, z up): bottom-to-top along the
 * outside for an open profile, increasing angle around the tube for a closed one.
 */
function lathe(profile: readonly (readonly [number, number])[], segments: number, closed: boolean): Mesh3D {
  const positions: number[] = [];
  const rows: number[][] = [];
  const cos: number[] = [], sin: number[] = [];
  for (let j = 0; j < segments; j++) {
    const a = (2 * Math.PI * j) / segments;
    cos.push(Math.cos(a));
    sin.push(Math.sin(a));
  }
  for (const [r, z] of profile) {
    const row: number[] = [];
    if (r === 0) {
      row.push(positions.length / 3);
      positions.push(0, 0, z);
    } else {
      for (let j = 0; j < segments; j++) {
        row.push(positions.length / 3);
        positions.push(r * cos[j]!, r * sin[j]!, z);
      }
    }
    rows.push(row);
  }
  const indices: number[] = [];
  const bands = closed ? rows.length : rows.length - 1;
  for (let i = 0; i < bands; i++) {
    const lo = rows[i]!, hi = rows[(i + 1) % rows.length]!;
    for (let j = 0; j < segments; j++) {
      const k = (j + 1) % segments;
      // Quad (lo j, lo k, hi k, hi j); a pole row repeats its single vertex, dropping one triangle.
      const a = lo[lo.length === 1 ? 0 : j]!, b = lo[lo.length === 1 ? 0 : k]!;
      const c = hi[hi.length === 1 ? 0 : k]!, d = hi[hi.length === 1 ? 0 : j]!;
      if (a !== b) indices.push(a, b, c);
      if (c !== d) indices.push(a, c, d);
    }
  }
  return { positions, indices };
}

/**
 * Cylinder of radius `r` and height `h` (base on z = 0 centred on the origin) with `segments`
 * sides (clamped to [MIN_SEGMENTS, MAX_SEGMENTS], default DEFAULT_SEGMENTS). Volume of the
 * inscribed prism: (segments / 2) r^2 sin(2 pi / segments) h. Throws Model3DInputError for r, h <= 0.
 */
export function cylinderMesh(r: number, h: number, segments = DEFAULT_SEGMENTS): Mesh3D {
  requirePositive('Cylinder radius', r);
  requirePositive('Cylinder height', h);
  return lathe([[0, 0], [r, 0], [r, h], [0, h]], clampSegments(segments, DEFAULT_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS), false);
}

/**
 * Cone or frustum: radius `r1` at z = 0, `r2` at z = `h`, centred on the origin. Either radius may
 * be 0 (that end becomes a single apex vertex) but not both. Segments as for `cylinderMesh`;
 * volume is that of the inscribed pyramid frustum. Throws Model3DInputError for invalid sizes.
 */
export function coneMesh(r1: number, r2: number, h: number, segments = DEFAULT_SEGMENTS): Mesh3D {
  requirePositive('Cone height', h);
  if (!(Number.isFinite(r1) && Number.isFinite(r2) && r1 >= 0 && r2 >= 0) || (r1 === 0 && r2 === 0)) {
    throw new Model3DInputError(`Cone radii must be finite, non-negative and not both 0 (got ${r1}, ${r2}).`);
  }
  const profile: [number, number][] = [[0, 0]];
  if (r1 > 0) profile.push([r1, 0]);
  if (r2 > 0) profile.push([r2, h]);
  profile.push([0, h]);
  return lathe(profile, clampSegments(segments, DEFAULT_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS), false);
}

/**
 * UV sphere of radius `r` centred on the origin: `segments` meridians (clamped like
 * `cylinderMesh`) and `rings` latitude bands (clamped to [MIN_RINGS, MAX_RINGS], default
 * DEFAULT_RINGS), single-vertex poles on the local Z axis. Throws Model3DInputError for r <= 0.
 */
export function sphereMesh(r: number, segments = DEFAULT_SEGMENTS, rings = DEFAULT_RINGS): Mesh3D {
  requirePositive('Sphere radius', r);
  const n = clampSegments(rings, DEFAULT_RINGS, MIN_RINGS, MAX_RINGS);
  const profile: [number, number][] = [[0, -r]];
  for (let k = 1; k < n; k++) {
    const phi = -Math.PI / 2 + (Math.PI * k) / n;
    profile.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  profile.push([0, r]);
  return lathe(profile, clampSegments(segments, DEFAULT_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS), false);
}

/**
 * Ring torus centred on the origin around local Z: tube centre at distance `R` from the axis,
 * tube radius `r` (0 < r < R; a horn or spindle torus would self-intersect). `segs` divisions
 * around the axis (clamped like `cylinderMesh`), `rings` around the tube (clamped to
 * [MIN_TUBE_RINGS, MAX_RINGS], default DEFAULT_RINGS). Throws Model3DInputError for invalid radii.
 */
export function torusMesh(R: number, r: number, segs = DEFAULT_SEGMENTS, rings = DEFAULT_RINGS): Mesh3D {
  requirePositive('Torus major radius', R);
  requirePositive('Torus minor radius', r);
  if (!(r < R)) throw new Model3DInputError(`Torus minor radius must be smaller than the major radius (got ${r} >= ${R}).`);
  const n = clampSegments(rings, DEFAULT_RINGS, MIN_TUBE_RINGS, MAX_RINGS);
  const profile: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const phi = (2 * Math.PI * k) / n;
    profile.push([R + r * Math.cos(phi), r * Math.sin(phi)]);
  }
  return lathe(profile, clampSegments(segs, DEFAULT_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS), true);
}

/**
 * Check a finished world-space mesh before a builder returns it. Sizes that are valid on their own
 * can still fail once placed, and what is detected is exactly this: coordinates that overflowed
 * to a non-finite value; a volume that is zero up to rounding, |V| <= VOLUME_EPS * d^3 with d the
 * bounding-box diagonal (every vertex collapsed onto a few positions, e.g. a 0.5 radius sphere at
 * z = -1e300, or a denormal 1e-320 width, whose rounding noise can even be slightly negative);
 * and an infinite volume (a 1e200 box). Those throw a Model3DInputError. A partial loss of
 * precision that leaves a larger positive volume is not detected. A clearly negative volume, or a
 * structural problem other than non-finite coordinates, means the builder itself is wrong: a plain
 * Error (an internal error for `describeModel3DError`). Found by tests/fuzz-model3d-file.test.ts;
 * before this check such meshes reached the caller.
 */
export function requireSolidMesh(what: string, mesh: Mesh3D): Mesh3D {
  const problem = validateMesh(mesh);
  if (problem === 'mesh positions must be finite numbers') throw new Model3DInputError(`The ${what} has coordinates that are not finite numbers at this size and position.`);
  if (problem !== null) throw new Error(`Internal error: the ${what} builder produced an invalid mesh (${problem}).`);
  const volume = meshVolume(mesh);
  const box = meshBounds(mesh);
  const d = box ? Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) : 0;
  const noUsableVolume = `The ${what} has no usable volume at this size and position (sizes too small, or sizes or coordinates too large, for double precision).`;
  if (!Number.isFinite(volume) || !(Math.abs(volume) > VOLUME_EPS * d * d * d)) throw new Model3DInputError(noUsableVolume);
  if (volume < 0) throw new Error(`Internal error: the ${what} builder produced an inside-out mesh (volume ${volume}).`);
  return mesh;
}

/** Relative volume below which a placed builder result counts as collapsed (see `requireSolidMesh`). */
export const VOLUME_EPS = 1e-12;

/**
 * Evaluate a primitive feature to a world-space mesh: build it in frame-local coordinates per the
 * module convention, then place it with `frameToWorld(feature.frame)`. Throws Model3DInputError for
 * invalid dimensions (see the individual builders), for a frame that is not orthonormal and
 * right-handed (`isOrthonormalFrame`), which would shear, scale or mirror the solid, and for a
 * placed mesh without finite coordinates and a finite positive volume (`requireSolidMesh`).
 */
export function primitiveMesh(feature: PrimitiveFeature): Mesh3D {
  if (!feature.frame || !isOrthonormalFrame(feature.frame)) throw new Model3DInputError(`The ${feature.kind} placement frame must be orthonormal and right-handed.`);
  let local: Mesh3D;
  switch (feature.kind) {
    case 'box': local = boxMesh(feature.width, feature.depth, feature.height); break;
    case 'wedge': local = wedgeMesh(feature.width, feature.depth, feature.height); break;
    case 'cylinder': local = cylinderMesh(feature.radius, feature.height, feature.segments); break;
    case 'cone': local = coneMesh(feature.baseRadius, feature.topRadius, feature.height, feature.segments); break;
    case 'sphere': local = sphereMesh(feature.radius, feature.segments, feature.rings); break;
    case 'torus': local = torusMesh(feature.majorRadius, feature.minorRadius, feature.segments, feature.rings); break;
  }
  return requireSolidMesh(feature.kind, transformMesh(local, frameToWorld(feature.frame)));
}
