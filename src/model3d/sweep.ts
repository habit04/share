/**
 * Extrusion and revolution of planar profiles into closed, outward-facing triangle meshes.
 *
 * Conventions:
 * - Profiles follow types.ts / sketch.ts: loops in the XY plane of the profile frame (drawing
 *   units), outer loop counter-clockwise seen from the frame's +Z, holes clockwise. Profiles are
 *   checked with `validateProfile` first; an invalid one throws a RangeError naming the problem,
 *   it is never repaired.
 * - Results are in world coordinates (AutoCAD WCS, right-handed), welded by construction (every
 *   profile point becomes shared vertices, no duplicates), wound counter-clockwise seen from
 *   outside, so `meshIsClosed` holds and `meshVolume` is positive whatever the sign of the
 *   distance or angle. Caps are triangulated with triangulate.ts and use exactly the profile
 *   vertices, so they meet the side walls edge for edge. A stored profile with exactly collinear
 *   vertices may give zero-area cap triangles (the triangulator's `allowFlat` fallback); they keep
 *   the mesh closed and add no volume.
 * - Angles are radians, right-hand rule about the axis direction. A revolution of 2 pi (within
 *   1e-9) is full: it has no end caps and its last step reuses the first ring (the seam is welded).
 * - Triangle counts are checked against MAX_SOLID_TRIANGLES before anything is built.
 */
import { GeometryBudgetError } from '../core/geometry-budget-error';
import type { Point } from '../core/geometry';
import { MAX_SOLID_TRIANGLES } from './budget';
import { type Vec3, cross3, dot3, frameToWorld, len3, normalize3, scale3, sub3, transformPoint } from './math';
import { type Mesh3D, invertWinding, meshVolume, transformMesh } from './mesh';
import { DEFAULT_SEGMENTS, MAX_SEGMENTS, MIN_SEGMENTS, clampSegments } from './primitives';
import { validateProfile } from './sketch';
import { loopSignedArea2, triangulatePolygon } from './triangulate';
import type { Profile3D } from './types';

function profilePointCount(profile: Profile3D): number {
  return profile.loops.reduce((n, l) => n + l.length, 0);
}

function checkBudget(what: string, triangles: number): void {
  if (triangles > MAX_SOLID_TRIANGLES) {
    throw new GeometryBudgetError(`The ${what} would have ${triangles.toLocaleString('en-US')} triangles; the safe limit is ${MAX_SOLID_TRIANGLES.toLocaleString('en-US')} per solid.`);
  }
}

function requireValidProfile(what: string, profile: Profile3D): void {
  const problem = validateProfile(profile);
  if (problem) throw new RangeError(`Cannot ${what}: ${problem}.`);
}

/**
 * Extrude `profile` by `distance` along its frame's +Z axis (negative: along -Z), giving a prism
 * with a cap on the profile plane, a cap at the far end and one quad (two triangles) per profile
 * edge. Volume = profile area x |distance|. Throws RangeError for an invalid profile or a zero or
 * non-finite distance, GeometryBudgetError when the result would exceed the triangle budget.
 */
export function extrudeMesh(profile: Profile3D, distance: number): Mesh3D {
  if (!(typeof distance === 'number' && Number.isFinite(distance)) || distance === 0) throw new RangeError(`Extrusion distance must be a non-zero finite number (got ${String(distance)}).`);
  requireValidProfile('extrude', profile);
  const n = profilePointCount(profile);
  const holes = profile.loops.length - 1;
  // About 4 triangles per profile point: unreachable while MAX_PROFILE_POINTS (20 000) bounds the
  // profile, kept so the budget still holds if that limit is ever raised.
  checkBudget('extrusion', 2 * (n + 2 * holes - 2) + 2 * n);
  const cap = triangulatePolygon(profile.loops);
  const positions: number[] = [];
  for (const loop of profile.loops) for (const p of loop) positions.push(p.x, p.y, 0);
  for (const loop of profile.loops) for (const p of loop) positions.push(p.x, p.y, distance);
  const indices: number[] = [];
  // Bottom cap faces -Z (reversed triangles), top cap +Z (as triangulated, counter-clockwise).
  for (let t = 0; t < cap.length; t += 3) indices.push(cap[t]!, cap[t + 2]!, cap[t + 1]!);
  for (let t = 0; t < cap.length; t += 3) indices.push(cap[t]! + n, cap[t + 1]! + n, cap[t + 2]! + n);
  // Side walls: the right of each directed edge is outside (outer loop CCW, holes CW).
  let base = 0;
  for (const loop of profile.loops) {
    const m = loop.length;
    for (let i = 0; i < m; i++) {
      const a = base + i, b = base + ((i + 1) % m);
      indices.push(a, b, b + n, a, b + n, a + n);
    }
    base += m;
  }
  // Built for distance > 0; a negative distance mirrors the solid through the profile plane.
  const local: Mesh3D = distance > 0 ? { positions, indices } : invertWinding({ positions, indices });
  return transformMesh(local, frameToWorld(profile.frame));
}

/** Axis of revolution in world coordinates; `dir` need not be unit length. */
export interface RevolveAxis {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

/** Absolute tolerance (drawing units) within which profile points count as lying on the axis or the axis on the profile plane. */
export const REVOLVE_AXIS_TOLERANCE = 1e-9;

/**
 * Revolve `profile` about `axis` by `angle` radians (right-hand rule about `axis.dir`; negative
 * turns the other way), with `segments` steps per full turn (clamped like primitives, default
 * DEFAULT_SEGMENTS; a partial turn uses ceil(segments * |angle| / 2 pi) steps). The axis must lie
 * in the profile plane and the whole profile on one side of it; profile points within
 * REVOLVE_AXIS_TOLERANCE of the axis become single pole vertices and profile edges lying on the
 * axis produce no faces, so a rectangle with one side on the axis gives a closed cylinder. A full
 * turn has no caps; a partial turn adds the profile as start and end caps. Volume is that of the
 * inscribed polygonal solid (each ring an inscribed polygon), slightly below the analytic value.
 * Throws RangeError for invalid input, GeometryBudgetError beyond the triangle budget.
 */
export function revolveMesh(profile: Profile3D, axis: RevolveAxis, angle: number, segments: number = DEFAULT_SEGMENTS): Mesh3D {
  if (!(typeof angle === 'number' && Number.isFinite(angle)) || angle === 0) throw new RangeError(`Revolution angle must be a non-zero finite number of radians (got ${String(angle)}).`);
  if (Math.abs(angle) > 2 * Math.PI + 1e-9) throw new RangeError(`Revolution angle must be at most one full turn (2 pi radians; got ${angle}).`);
  if (!axis || ![axis.origin, axis.dir].every((v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))) throw new RangeError('Cannot revolve: the axis has non-finite coordinates.');
  if (!(len3(axis.dir) > 0)) throw new RangeError('Cannot revolve: the axis direction is zero.');
  requireValidProfile('revolve', profile);
  const frame = profile.frame;
  const u = normalize3(axis.dir);
  const tol = REVOLVE_AXIS_TOLERANCE;
  if (Math.abs(dot3(u, frame.zAxis)) > 1e-9) throw new RangeError('Cannot revolve: the axis must lie in the plane of the profile.');
  if (Math.abs(dot3(sub3(axis.origin, frame.origin), frame.zAxis)) > tol * Math.max(1, len3(sub3(axis.origin, frame.origin)))) throw new RangeError('Cannot revolve: the axis must lie in the plane of the profile.');

  // Radial direction: in the profile plane, perpendicular to the axis, toward the profile.
  const toWorld = frameToWorld(frame);
  const world = profile.loops.map((loop) => loop.map((p) => transformPoint(toWorld, { x: p.x, y: p.y, z: 0 })));
  const side = cross3(frame.zAxis, u); // in-plane, perpendicular to u
  let minS = Infinity, maxS = -Infinity, extent = 0;
  for (const loop of world) {
    for (const p of loop) {
      const d = sub3(p, axis.origin);
      const s = dot3(d, side);
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      extent = Math.max(extent, len3(d));
    }
  }
  const onAxis = tol * Math.max(1, extent);
  if (minS < -onAxis && maxS > onAxis) throw new RangeError('Cannot revolve: the profile crosses the axis; it must lie on one side of it (touching is allowed).');
  if (maxS <= onAxis && minS >= -onAxis) throw new RangeError('Cannot revolve: the profile lies on the axis.');
  const e1 = maxS > onAxis ? side : scale3(side, -1);
  const e2 = cross3(u, e1);

  // Profile in (r, h) half-plane coordinates: r along e1 (>= 0), h along the axis.
  let rh: Point[][] = world.map((loop) => loop.map((p) => {
    const d = sub3(p, axis.origin);
    const r = dot3(d, e1);
    return { x: Math.abs(r) <= onAxis ? 0 : r, y: dot3(d, u) };
  }));
  // The canonical construction needs the outer loop counter-clockwise in (r, h); reversing every
  // loop keeps holes opposite to it.
  if (loopSignedArea2(rh[0]!) < 0) rh = rh.map((loop) => [...loop].reverse());

  const steps0 = clampSegments(segments, DEFAULT_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS);
  const full = Math.abs(angle) >= 2 * Math.PI - 1e-9;
  const steps = full ? steps0 : Math.max(1, Math.ceil((steps0 * Math.abs(angle)) / (2 * Math.PI) - 1e-9));
  const rows = full ? steps : steps + 1;
  const n = profilePointCount(profile);
  const holes = profile.loops.length - 1;
  checkBudget('revolution', 2 * n * steps + (full ? 0 : 2 * (n + 2 * holes - 2)));

  // Vertices: a ring of `rows` vertices per off-axis profile point, a single vertex per pole.
  const positions: number[] = [];
  const cos: number[] = [], sin: number[] = [];
  for (let k = 0; k < rows; k++) {
    const t = full ? (2 * Math.PI * k) / steps : (angle * k) / steps;
    cos.push(Math.cos(t));
    sin.push(Math.sin(t));
  }
  const ringStart: number[][] = [];
  const isPole: boolean[][] = [];
  for (const loop of rh) {
    const starts: number[] = [], poles: boolean[] = [];
    for (const p of loop) {
      starts.push(positions.length / 3);
      const c = { x: axis.origin.x + u.x * p.y, y: axis.origin.y + u.y * p.y, z: axis.origin.z + u.z * p.y };
      if (p.x === 0) {
        poles.push(true);
        positions.push(c.x, c.y, c.z);
      } else {
        poles.push(false);
        for (let k = 0; k < rows; k++) {
          const rx = p.x * cos[k]!, ry = p.x * sin[k]!;
          positions.push(c.x + e1.x * rx + e2.x * ry, c.y + e1.y * rx + e2.y * ry, c.z + e1.z * rx + e2.z * ry);
        }
      }
    }
    ringStart.push(starts);
    isPole.push(poles);
  }
  const vert = (l: number, i: number, k: number): number => (isPole[l]![i] ? ringStart[l]![i]! : ringStart[l]![i]! + (full ? k % steps : k));

  const indices: number[] = [];
  for (const [l, loop] of rh.entries()) {
    const m = loop.length;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      if (isPole[l]![i] && isPole[l]![j]) continue; // an edge on the axis sweeps no surface
      for (let k = 0; k < steps; k++) {
        const a = vert(l, i, k), b = vert(l, i, k + 1), c = vert(l, j, k + 1), d = vert(l, j, k);
        if (a !== b) indices.push(a, b, c);
        if (c !== d) indices.push(a, c, d);
      }
    }
  }
  if (!full) {
    // Caps: the profile at angle 0 faces back along the rotation (triangles as computed in the
    // CCW (r, h) plane, whose normal e1 x u = -e2), the profile at the final angle faces forward.
    const cap = triangulatePolygon(rh);
    const flat: [number, number][] = [];
    for (const [l, loop] of rh.entries()) for (let i = 0; i < loop.length; i++) flat.push([l, i]);
    const at = (t: number, k: number) => { const [l, i] = flat[cap[t]!]!; return vert(l, i, k); };
    for (let t = 0; t < cap.length; t += 3) indices.push(at(t, 0), at(t + 1, 0), at(t + 2, 0));
    for (let t = 0; t < cap.length; t += 3) indices.push(at(t, steps), at(t + 2, steps), at(t + 1, steps));
  }
  let mesh: Mesh3D = { positions, indices };
  // Built outward for a positive turn; a negative partial turn is its mirror image through the
  // profile plane (mirroring reverses the winding). A full turn of either sign is the same solid
  // and is always built with the positive orientation.
  if (angle < 0 && !full) mesh = invertWinding(mesh);
  if (!(meshVolume(mesh) > 0)) throw new RangeError('Cannot revolve: the profile produced a solid without volume.');
  return mesh;
}
