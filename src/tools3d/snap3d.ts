/**
 * 3D object snaps on solids (experimental, milestone 4 of docs/3D-PLAN.md), pure so they are
 * tested in Node; the 3D view (src/app/experimental-3d.ts) calls `snapPick3` for every cursor
 * position and click a 3D command receives, and draws the 2D-style marker at the snapped point.
 *
 * A snap works on the FACE under the cursor: the planar region of connected, coplanar triangles
 * around the hit triangle (`faceRegion`; a box side is one region of two triangles, a cylinder
 * cap one region, each facet strip of a curved surface its own region). Candidates:
 * - END (endpoint): the corners of the face outline (collinear outline vertices are skipped, so a
 *   long edge split by a Boolean still has its true ends);
 * - MID (midpoint): the midpoints of the outline edges between those corners;
 * - CEN (center): the face centre (area-weighted centroid of the region; a circular cap gives the
 *   circle centre);
 * - NEA (nearest): the hit point itself, used only when no other enabled candidate is close.
 * A candidate is close when its distance from the cursor ray is within the aperture (world units
 * at the hit's depth, the 2D aperture box measured in the 3D view). The closest candidate wins;
 * ties go END, then MID, then CEN. The 2D OSNAP toggles decide which modes are on (F3 off: none).
 *
 * Tolerances are relative to the mesh's bounding-box diagonal (coplanarity 1e-6 of it, normals
 * within 1e-4 radians), loose enough for Boolean results, whose coordinates come from the kernel's
 * single-precision-like arithmetic, even far from the origin.
 *
 * Topology is by vertex index (meshes are welded: primitives and sweeps by construction, Boolean
 * results by the kernel), so two triangles are neighbours when they share an edge's two indices.
 */
import { type Ray, type Vec3, add3, cross3, dist3, dot3, len3, normalize3, scale3, sub3 } from '../model3d/math';
import { type Mesh3D, meshBounds, meshTriangleCount, meshVertex } from '../model3d/mesh';
import { solidById } from '../model3d/model';
import type { Model3D } from '../model3d/types';
import type { SnapSettings } from '../core/snap';
import type { Frame3 } from '../model3d/math';
import type { PickHit } from '../render3d/picking';
import { type Pick3, worldToPlane } from './context';

/** The snap modes a 3D snap understands (a subset of the 2D OSNAP settings). */
export type Snap3DModes = Pick<SnapSettings, 'osnap' | 'endpoint' | 'midpoint' | 'center' | 'nearest'>;

/** Snap kinds produced on solids (the 2D marker shapes of the same names are drawn). */
export type Snap3DKind = 'endpoint' | 'midpoint' | 'center' | 'nearest';

export interface Snap3DResult {
  readonly point: Vec3;
  readonly kind: Snap3DKind;
}

/** A planar face of a mesh: connected coplanar triangles around one triangle. */
export interface FaceRegion {
  /** Triangle indices in the region (the seed first). */
  readonly triangles: readonly number[];
  /** Unit normal of the face (by the stored winding: outward for an outward mesh). */
  readonly normal: Vec3;
  /** Total area (square drawing units). */
  readonly area: number;
  /** Area-weighted centroid of the face. */
  readonly centroid: Vec3;
  /** Outline loops (outer boundary and holes) as corner points, collinear points removed. */
  readonly loops: readonly (readonly Vec3[])[];
  /** Total outline length (drawing units). */
  readonly perimeter: number;
}

const adjacencyCache = new WeakMap<Mesh3D, Int32Array>();
const diagonalCache = new WeakMap<Mesh3D, number>();

/** Bounding-box diagonal of a mesh (cached per mesh). */
function meshDiagonal(mesh: Mesh3D): number {
  let d = diagonalCache.get(mesh);
  if (d === undefined) {
    const b = meshBounds(mesh);
    d = b ? dist3(b.min, b.max) : 0;
    diagonalCache.set(mesh, d);
  }
  return d;
}

/** For each triangle edge (3 per triangle) the neighbouring triangle across it, or -1. */
export function triangleAdjacency(mesh: Mesh3D): Int32Array {
  const hit = adjacencyCache.get(mesh);
  if (hit) return hit;
  const n = meshTriangleCount(mesh);
  const idx = mesh.indices;
  const adj = new Int32Array(n * 3).fill(-1);
  const edges = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k]!, b = idx[t * 3 + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = edges.get(key);
      if (other === undefined) edges.set(key, t * 3 + k);
      else {
        const ot = Math.floor(other / 3);
        // Only pair the first two users of an edge (a non-manifold edge keeps -1 for the rest).
        if (adj[other] === -1 && ot !== t) {
          adj[other] = t;
          adj[t * 3 + k] = ot;
        }
      }
    }
  }
  adjacencyCache.set(mesh, adj);
  return adj;
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross3(sub3(b, a), sub3(c, a));
}

/**
 * The planar face containing triangle `tri`: neighbours are added while their normal is parallel
 * to the seed's (within `angleTol` radians) and their vertices lie on the seed's plane (within
 * 1e-6 of the mesh's bounding-box diagonal). Throws RangeError for a triangle index out of range.
 */
export function faceRegion(mesh: Mesh3D, tri: number, angleTol = 1e-4): FaceRegion {
  const n = meshTriangleCount(mesh);
  if (!(Number.isInteger(tri) && tri >= 0 && tri < n)) throw new RangeError(`Triangle ${tri} is not in the mesh.`);
  const idx = mesh.indices;
  const corner = (t: number, k: number) => meshVertex(mesh, idx[t * 3 + k]!);
  const a0 = corner(tri, 0), b0 = corner(tri, 1), c0 = corner(tri, 2);
  const nrm = normalize3(triangleNormal(a0, b0, c0));
  const planeTol = 1e-6 * Math.max(meshDiagonal(mesh), 1e-12);
  const cosTol = Math.cos(angleTol);
  const adj = triangleAdjacency(mesh);
  const inRegion = new Set<number>([tri]);
  const order = [tri];
  for (let i = 0; i < order.length; i++) {
    const t = order[i]!;
    for (let k = 0; k < 3; k++) {
      const u = adj[t * 3 + k]!;
      if (u < 0 || inRegion.has(u)) continue;
      const a = corner(u, 0), b = corner(u, 1), c = corner(u, 2);
      const un = normalize3(triangleNormal(a, b, c));
      if (dot3(un, nrm) < cosTol) continue;
      if ([a, b, c].some((p) => Math.abs(dot3(sub3(p, a0), nrm)) > planeTol)) continue;
      inRegion.add(u);
      order.push(u);
    }
  }
  let area = 0;
  let cx = 0, cy = 0, cz = 0;
  // Directed outline edges: an edge whose neighbour is outside the region (start -> end vertex).
  const next = new Map<number, number[]>();
  for (const t of order) {
    const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
    const ar = len3(triangleNormal(a, b, c)) / 2;
    area += ar;
    cx += ar * (a.x + b.x + c.x) / 3;
    cy += ar * (a.y + b.y + c.y) / 3;
    cz += ar * (a.z + b.z + c.z) / 3;
    for (let k = 0; k < 3; k++) {
      const u = adj[t * 3 + k]!;
      if (u >= 0 && inRegion.has(u)) continue;
      const s = idx[t * 3 + k]!, e = idx[t * 3 + ((k + 1) % 3)]!;
      const list = next.get(s);
      if (list) list.push(e);
      else next.set(s, [e]);
    }
  }
  const centroid = area > 0 ? { x: cx / area, y: cy / area, z: cz / area } : scale3(add3(add3(a0, b0), c0), 1 / 3);
  // Chain the outline edges into loops.
  const loops: Vec3[][] = [];
  let perimeter = 0;
  for (const [start] of next) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [start];
      let cur = start;
      for (let guard = 0; guard <= idx.length; guard++) {
        const outs = next.get(cur);
        if (!outs || outs.length === 0) break;
        const nxt = outs.shift()!;
        perimeter += dist3(meshVertex(mesh, cur), meshVertex(mesh, nxt));
        if (nxt === start) break;
        loop.push(nxt);
        cur = nxt;
      }
      loops.push(dropCollinear(loop.map((v) => meshVertex(mesh, v))));
    }
  }
  return { triangles: order, normal: nrm, area, centroid, loops, perimeter };
}

/** A closed loop without its collinear (straight-through) points. */
function dropCollinear(loop: readonly Vec3[]): Vec3[] {
  if (loop.length <= 3) return [...loop];
  const out: Vec3[] = [];
  const m = loop.length;
  for (let i = 0; i < m; i++) {
    const p = loop[(i + m - 1) % m]!, q = loop[i]!, r = loop[(i + 1) % m]!;
    const u = sub3(q, p), w = sub3(r, q);
    const lu = len3(u), lw = len3(w);
    if (lu === 0 || lw === 0) continue;
    if (len3(cross3(u, w)) <= 1e-6 * lu * lw && dot3(u, w) > 0) continue;
    out.push(q);
  }
  return out.length >= 3 ? out : [...loop];
}

/** Perpendicular distance from `q` to the ray's line, or Infinity when `q` is behind the origin. */
export function distanceToRay(q: Vec3, ray: Ray): number {
  const d = normalize3(ray.dir);
  const v = sub3(q, ray.origin);
  const t = dot3(v, d);
  if (t < 0) return Infinity;
  return len3(sub3(v, scale3(d, t)));
}

/** The snap candidates of a face (exported for tests and the marker overlay). */
export function faceSnapCandidates(region: FaceRegion): { kind: Snap3DKind; point: Vec3 }[] {
  const out: { kind: Snap3DKind; point: Vec3 }[] = [];
  for (const loop of region.loops) for (const p of loop) out.push({ kind: 'endpoint', point: p });
  for (const loop of region.loops) {
    for (let i = 0; i < loop.length; i++) out.push({ kind: 'midpoint', point: scale3(add3(loop[i]!, loop[(i + 1) % loop.length]!), 0.5) });
  }
  out.push({ kind: 'center', point: region.centroid });
  return out;
}

/**
 * The 3D object snap for a cursor ray that hit `mesh` at `hit` (see the module comment), or null
 * when no enabled mode applies. `apertureWorld` is the aperture radius in world units at the hit.
 */
export function snapOnSolid(hit: Pick<PickHit, 'point' | 'triangle'>, mesh: Mesh3D, ray: Ray, apertureWorld: number, modes: Snap3DModes): Snap3DResult | null {
  if (!modes.osnap) return null;
  const want = (k: Snap3DKind) => (k === 'endpoint' ? modes.endpoint : k === 'midpoint' ? modes.midpoint : k === 'center' ? modes.center : modes.nearest);
  if (!want('endpoint') && !want('midpoint') && !want('center') && !want('nearest')) return null;
  let best: Snap3DResult | null = null;
  let bestD = Infinity;
  if ((want('endpoint') || want('midpoint') || want('center')) && apertureWorld > 0) {
    let region: FaceRegion;
    try {
      region = faceRegion(mesh, hit.triangle);
    } catch {
      return want('nearest') ? { point: hit.point, kind: 'nearest' } : null;
    }
    // Candidates come END first, then MID, then CEN: a later one must be clearly closer to win.
    const slack = 1e-9 * Math.max(1, apertureWorld);
    for (const c of faceSnapCandidates(region)) {
      if (!want(c.kind)) continue;
      const d = distanceToRay(c.point, ray);
      if (d > apertureWorld || d >= bestD - slack) continue;
      best = c;
      bestD = d;
    }
  }
  if (best) return { point: best.point, kind: best.kind };
  return want('nearest') ? { point: hit.point, kind: 'nearest' } : null;
}

/** A 3D pick with the snap applied (the kind of snap is recorded in `snap`). */
export type SnappedPick3 = Pick3 & { readonly snap?: Snap3DKind };

/**
 * The pick a 3D command receives: when the cursor is over a solid and a snap applies, the point
 * becomes the snapped point (and the plane-local tool point follows it); otherwise unchanged.
 */
export function snapPick3(pick: Pick3, model: Model3D, modes: Snap3DModes, apertureWorld: number, plane: Frame3): SnappedPick3 {
  const hit = pick.hit;
  if (!hit) return pick;
  const solid = solidById(model, hit.id);
  if (!solid) return pick;
  const s = snapOnSolid(hit, solid.mesh, pick.ray, apertureWorld, modes);
  if (!s) return pick;
  const local = worldToPlane(plane, s.point);
  return { ...pick, point: s.point, p2: { x: local.x, y: local.y }, snap: s.kind };
}
