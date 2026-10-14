/**
 * CPU picking for the 3D viewport: exact ray casting against solid meshes.
 *
 * Each mesh gets a bounding-volume hierarchy (median split on the longest centroid axis, leaves of
 * at most BVH_LEAF_SIZE triangles), built on first use and cached in a WeakMap keyed by the sealed
 * mesh object (meshes in drawing state never change, so identity is a safe key and the cache dies
 * with the mesh). Triangles are tested from both sides (`intersectRayTriangle` does no culling), so
 * a solid is hit whichever way its triangles are wound and from inside too. Node boxes are padded
 * (`BOX_PAD`, `COORD_PAD`) before the ray test, so the hierarchy only accelerates: for every ray
 * that is not within about 1e-8 rad of a triangle's plane the result is the one a brute-force pass
 * over every triangle gives; for such grazing rays the triangle test's own t is uncertain by more
 * than the pad and the hit returned can be slightly farther along the ray, never a miss.
 *
 * This is the exact path and the fallback for the GPU id-buffer (`Viewport3D.pick`); both must
 * agree, which scripts/e2e-3d.mjs checks on a rendered scene.
 */
import { type Aabb, type Ray, type Vec3, EPS3, add3, cross3, intersectRayAabb, intersectRayTriangle, normalize3, scale3, sub3 } from '../model3d/math';
import { type Mesh3D, meshTriangleCount, meshVertex } from '../model3d/mesh';
import type { Model3D, Solid3D } from '../model3d/types';

/** Maximum triangles in a BVH leaf. */
export const BVH_LEAF_SIZE = 8;

/** One solid hit by a ray: its nearest intersection. */
export interface PickHit {
  readonly id: string;
  /** Ray parameter (a distance when the ray direction is unit length). */
  readonly t: number;
  readonly point: Vec3;
  /** Unit normal of the hit triangle by its stored winding (outward for an outward mesh). */
  readonly normal: Vec3;
  /** Index of the hit triangle in the mesh. */
  readonly triangle: number;
}

/**
 * Flattened BVH. Node n has bounds `bounds[6n .. 6n + 5]` (min xyz, max xyz). For an inner node
 * `left[n]` / `right[n]` are child indices and `count[n]` is 0; for a leaf `count[n]` triangles
 * start at `start[n]` in `order` (triangle indices).
 */
export interface MeshBvh {
  readonly bounds: Float64Array;
  readonly left: Int32Array;
  readonly right: Int32Array;
  readonly start: Int32Array;
  readonly count: Int32Array;
  readonly order: Int32Array;
  readonly nodeCount: number;
}

const bvhCache = new WeakMap<Mesh3D, MeshBvh>();

/** The cached BVH of a mesh (built on first request). Callers must not modify it. */
export function meshBvh(mesh: Mesh3D): MeshBvh {
  const hit = bvhCache.get(mesh);
  if (hit) return hit;
  const bvh = buildBvh(mesh);
  bvhCache.set(mesh, bvh);
  return bvh;
}

function buildBvh(mesh: Mesh3D): MeshBvh {
  const n = meshTriangleCount(mesh);
  const idx = mesh.indices, pos = mesh.positions;
  // Per-triangle bounds and centroids.
  const tb = new Float64Array(n * 6);
  const cen = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]! * 3;
      const x = pos[v]!, y = pos[v + 1]!, z = pos[v + 2]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    tb.set([x0, y0, z0, x1, y1, z1], t * 6);
    cen[t * 3] = (x0 + x1) / 2; cen[t * 3 + 1] = (y0 + y1) / 2; cen[t * 3 + 2] = (z0 + z1) / 2;
  }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const bounds: number[] = [], left: number[] = [], right: number[] = [], start: number[] = [], count: number[] = [];
  const node = (lo: number, hi: number): number => {
    const id = left.length;
    left.push(-1); right.push(-1); start.push(lo); count.push(hi - lo);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = order[i]!;
      x0 = Math.min(x0, tb[t * 6]!); y0 = Math.min(y0, tb[t * 6 + 1]!); z0 = Math.min(z0, tb[t * 6 + 2]!);
      x1 = Math.max(x1, tb[t * 6 + 3]!); y1 = Math.max(y1, tb[t * 6 + 4]!); z1 = Math.max(z1, tb[t * 6 + 5]!);
      const cx = cen[t * 3]!, cy = cen[t * 3 + 1]!, cz = cen[t * 3 + 2]!;
      c0x = Math.min(c0x, cx); c0y = Math.min(c0y, cy); c0z = Math.min(c0z, cz);
      c1x = Math.max(c1x, cx); c1y = Math.max(c1y, cy); c1z = Math.max(c1z, cz);
    }
    bounds.push(x0, y0, z0, x1, y1, z1);
    if (hi - lo <= BVH_LEAF_SIZE) return id;
    const ex = c1x - c0x, ey = c1y - c0y, ez = c1z - c0z;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    if (!(Math.max(ex, ey, ez) > 0)) return id; // all centroids coincide: keep a (large) leaf
    // Median split: sort the range by centroid on the axis, halve it.
    const slice = Array.from(order.subarray(lo, hi)).sort((a, b) => cen[a * 3 + axis]! - cen[b * 3 + axis]!);
    order.set(slice, lo);
    const mid = (lo + hi) >> 1;
    count[id] = 0;
    const l = node(lo, mid);
    const r = node(mid, hi);
    left[id] = l; right[id] = r;
    return id;
  };
  if (n > 0) node(0, n);
  return {
    bounds: Float64Array.from(bounds), left: Int32Array.from(left), right: Int32Array.from(right),
    start: Int32Array.from(start), count: Int32Array.from(count), order, nodeCount: left.length,
  };
}

/**
 * Padding of a node box in the ray test, relative to the box extents: `intersectRayTriangle` accepts
 * hits up to EPS3 (barycentric) outside a triangle and both tests round, so an exact box test can
 * reject a ray that grazes a solid's outline (the typed corner of a box at a "Select a face" prompt
 * on an oblique construction plane) or report an entry beyond a hit inside the box and prune it.
 * `COORD_PAD` adds a small coordinate-rounding allowance. This conservative expansion can still
 * exceed tiny part extents at large offsets; it is not a universal near-parallel error bound or a
 * guarantee of unchanged traversal cost. Hits are decided by the triangle test alone.
 */
const BOX_PAD = 4 * EPS3;
const COORD_PAD = 16 * Number.EPSILON;

/** Ray entry parameter of node `n`'s padded box, or null. `mag` is the ray origin's largest |coordinate|. */
function nodeEntry(bvh: MeshBvh, n: number, ray: Ray, mag: number): number | null {
  const b = bvh.bounds, o = n * 6;
  let m = mag;
  for (let k = 0; k < 6; k++) m = Math.max(m, Math.abs(b[o + k]!));
  const pad = BOX_PAD * ((b[o + 3]! - b[o]!) + (b[o + 4]! - b[o + 1]!) + (b[o + 5]! - b[o + 2]!)) + COORD_PAD * m;
  const box: Aabb = { min: { x: b[o]! - pad, y: b[o + 1]! - pad, z: b[o + 2]! - pad }, max: { x: b[o + 3]! + pad, y: b[o + 4]! + pad, z: b[o + 5]! + pad } };
  return intersectRayAabb(ray, box);
}

/** Nearest hit of `ray` on one mesh as { t, triangle }, or null. */
export function intersectMesh(mesh: Mesh3D, ray: Ray): { t: number; triangle: number } | null {
  const bvh = meshBvh(mesh);
  if (bvh.nodeCount === 0) return null;
  let best: { t: number; triangle: number } | null = null;
  const mag = Math.max(Math.abs(ray.origin.x), Math.abs(ray.origin.y), Math.abs(ray.origin.z));
  const rootEntry = nodeEntry(bvh, 0, ray, mag);
  if (rootEntry === null) return null;
  // Stack of [node, entry t]; the nearer child is pushed last so it is searched first, and any
  // node entered beyond the best hit so far is skipped.
  const stack: Array<[number, number]> = [[0, rootEntry]];
  while (stack.length) {
    const [n, entry] = stack.pop()!;
    if (best && entry > best.t) continue;
    const c = bvh.count[n]!;
    if (c > 0 || bvh.left[n]! < 0) {
      const s = bvh.start[n]!;
      for (let i = s; i < s + c; i++) {
        const tri = bvh.order[i]!;
        const a = meshVertex(mesh, mesh.indices[tri * 3]!), b = meshVertex(mesh, mesh.indices[tri * 3 + 1]!), cc = meshVertex(mesh, mesh.indices[tri * 3 + 2]!);
        const hit = intersectRayTriangle(ray, a, b, cc);
        // Ties go to the lower triangle index so the result does not depend on traversal order.
        if (hit && (!best || hit.t < best.t || (hit.t === best.t && tri < best.triangle))) best = { t: hit.t, triangle: tri };
      }
    } else {
      const l = bvh.left[n]!, r = bvh.right[n]!;
      const tl = nodeEntry(bvh, l, ray, mag), tr = nodeEntry(bvh, r, ray, mag);
      if (tl !== null && tr !== null) {
        if (tl <= tr) stack.push([r, tr], [l, tl]);
        else stack.push([l, tl], [r, tr]);
      } else if (tl !== null) stack.push([l, tl]);
      else if (tr !== null) stack.push([r, tr]);
    }
  }
  return best;
}

/** Options for `pickSolids`. */
export interface PickOptions {
  /** Layers whose solids cannot be hit (off / frozen layers). */
  readonly hiddenLayers?: ReadonlySet<string>;
}

/**
 * Every solid the ray hits, nearest first, with its nearest intersection. Solids whose bounding box
 * the ray misses are rejected before any triangle test.
 */
export function pickSolids(model: Model3D, ray: Ray, opts: PickOptions = {}): PickHit[] {
  const out: PickHit[] = [];
  for (const solid of model.solids) {
    if (opts.hiddenLayers?.has(solid.layer)) continue;
    const hit = pickSolid(solid, ray);
    if (hit) out.push(hit);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Nearest hit of the ray on one solid, or null. */
export function pickSolid(solid: Solid3D, ray: Ray): PickHit | null {
  // The BVH root box is the solid's bounding box: `intersectMesh` rejects misses with it first.
  const hit = intersectMesh(solid.mesh, ray);
  if (!hit) return null;
  // Double precision from the hit triangle, as `faceRegion` computes it (`flatNormals` is Float32
  // display data, a few 1e-8 rad off): a plane built on this normal holds the face to EPS3. The
  // triangle test has already rejected degenerate triangles, so the cross product is non-zero.
  const m = solid.mesh, i = hit.triangle * 3;
  const a = meshVertex(m, m.indices[i]!), b = meshVertex(m, m.indices[i + 1]!), c = meshVertex(m, m.indices[i + 2]!);
  const normal = normalize3(cross3(sub3(b, a), sub3(c, a)));
  return { id: solid.id, t: hit.t, point: add3(ray.origin, scale3(ray.dir, hit.t)), normal, triangle: hit.triangle };
}
