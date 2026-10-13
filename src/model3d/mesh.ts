/**
 * Indexed triangle meshes: the evaluated geometry of every 3D solid.
 *
 * Conventions:
 * - Plain arrays only (no typed arrays), so a mesh can sit inside sealed, deep-frozen drawing
 *   state (`sealImmutableData` rejects anything that is not a plain object or array).
 * - Coordinates are world (WCS) drawing units, right-handed, Z toward the viewer.
 * - Triangles are wound counter-clockwise when seen from outside the solid, so the right-hand
 *   normal (b - a) x (c - a) points outward and a closed outward mesh has positive volume.
 * - Topology is by vertex index: two triangles share an edge only when they reference the same
 *   vertex indices, so meshes are welded (`weldVertices`) before closedness tests.
 */
import { type Aabb, type Mat4, type Vec3, cross3, dot3, len3, mat4Determinant, sub3 } from './math';

/** An indexed triangle mesh: xyz triples in `positions`, three vertex indices per triangle. */
export interface Mesh3D {
  /** Flat x, y, z triples in drawing units; vertex i is positions[3i .. 3i + 2]. */
  readonly positions: readonly number[];
  /** Flat triangle vertex indices, three per triangle, counter-clockwise seen from outside. */
  readonly indices: readonly number[];
}

/** A mesh with no geometry (valid, open, zero volume). */
export const EMPTY_MESH: Mesh3D = Object.freeze({ positions: Object.freeze([]) as readonly number[], indices: Object.freeze([]) as readonly number[] });

/** Number of complete triangles (a trailing partial triple in an invalid mesh is not counted). */
export function meshTriangleCount(mesh: Mesh3D): number {
  return Math.floor(mesh.indices.length / 3);
}

/** Number of vertices (complete xyz triples). */
export function meshVertexCount(mesh: Mesh3D): number {
  return Math.floor(mesh.positions.length / 3);
}

/** Vertex i as a vector (no range check; callers validate the mesh first). */
export function meshVertex(mesh: Mesh3D, i: number): Vec3 {
  const p = mesh.positions;
  return { x: p[3 * i]!, y: p[3 * i + 1]!, z: p[3 * i + 2]! };
}

/**
 * Bounding box of every vertex in the mesh (referenced or not), or null for a mesh without
 * vertices. World drawing units.
 */
export function meshBounds(mesh: Mesh3D): Aabb | null {
  const p = mesh.positions;
  const n = meshVertexCount(mesh);
  if (n === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n * 3; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!(minX <= maxX && minY <= maxY && minZ <= maxZ)) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * Structural check: null when the mesh is well-formed, otherwise a short reason. Well-formed means
 * positions are a whole number of finite xyz triples and indices are a whole number of triangles
 * whose entries are integers referencing existing vertices. Degenerate or open meshes are still
 * well-formed (see `meshIsClosed` for topology).
 */
export function validateMesh(mesh: Mesh3D): string | null {
  if (!Array.isArray(mesh.positions) || !Array.isArray(mesh.indices)) return 'mesh positions and indices must be arrays';
  if (mesh.positions.length % 3 !== 0) return 'mesh positions are not a whole number of xyz triples';
  if (mesh.indices.length % 3 !== 0) return 'mesh indices are not a whole number of triangles';
  for (const v of mesh.positions) if (typeof v !== 'number' || !Number.isFinite(v)) return 'mesh positions must be finite numbers';
  const n = mesh.positions.length / 3;
  for (const i of mesh.indices) if (!Number.isInteger(i) || i < 0 || i >= n) return 'mesh index out of range';
  return null;
}

/**
 * The mesh with every vertex transformed by `m` (an affine matrix; a projective one is divided by
 * w like `transformPoint`). When `m` mirrors space (negative determinant) the triangle winding is
 * reversed as well, so an outward-facing solid stays outward-facing and keeps a positive volume.
 */
export function transformMesh(mesh: Mesh3D, m: Mat4): Mesh3D {
  const p = mesh.positions;
  const out = new Array<number>(p.length);
  const projective = m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    let tx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    let ty = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    let tz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    if (projective) {
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (w !== 0 && w !== 1) { tx /= w; ty /= w; tz /= w; }
    }
    out[i] = tx; out[i + 1] = ty; out[i + 2] = tz;
  }
  const transformed: Mesh3D = { positions: out, indices: mesh.indices };
  return mat4Determinant(m) < 0 ? invertWinding(transformed) : transformed;
}

/** The mesh with every triangle's winding reversed (normals flip, signed volume changes sign). */
export function invertWinding(mesh: Mesh3D): Mesh3D {
  const idx = mesh.indices;
  const out = new Array<number>(idx.length - (idx.length % 3));
  for (let t = 0; t + 2 < idx.length; t += 3) {
    out[t] = idx[t]!;
    out[t + 1] = idx[t + 2]!;
    out[t + 2] = idx[t + 1]!;
  }
  return { positions: mesh.positions, indices: out };
}

/**
 * Merge vertices closer than `tol` times the mesh's bounding-box diagonal (a relative tolerance,
 * so the same value works for a 1 mm part and a 100 m building; 0 merges only exact duplicates).
 * Each vertex snaps to the first earlier vertex within the tolerance; triangles that collapse
 * (two equal indices) are dropped and unreferenced vertices removed. Winding is unchanged.
 */
export function weldVertices(mesh: Mesh3D, tol = 1e-9): Mesh3D {
  const n = meshVertexCount(mesh);
  const bounds = meshBounds(mesh);
  const diag = bounds ? len3(sub3(bounds.max, bounds.min)) : 0;
  const abs = Math.max(0, tol) * diag;
  const p = mesh.positions;
  const remap = new Int32Array(n);
  const kept: number[] = [];
  if (abs > 0) {
    // Uniform grid with cells of size `abs`: any vertex within `abs` lies in one of the 27 cells around it.
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const x = p[3 * i]!, y = p[3 * i + 1]!, z = p[3 * i + 2]!;
      const cx = Math.floor(x / abs), cy = Math.floor(y / abs), cz = Math.floor(z / abs);
      let found = -1;
      for (let dx = -1; dx <= 1 && found < 0; dx++) {
        for (let dy = -1; dy <= 1 && found < 0; dy++) {
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!cell) continue;
            for (const k of cell) {
              const q = kept[k]!;
              if (Math.abs(p[3 * q]! - x) <= abs && Math.abs(p[3 * q + 1]! - y) <= abs && Math.abs(p[3 * q + 2]! - z) <= abs) { found = k; break; }
            }
          }
        }
      }
      if (found < 0) {
        found = kept.length;
        kept.push(i);
        const key = `${cx},${cy},${cz}`;
        const cell = grid.get(key);
        if (cell) cell.push(found); else grid.set(key, [found]);
      }
      remap[i] = found;
    }
  } else {
    const exact = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const key = `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
      let k = exact.get(key);
      if (k === undefined) { k = kept.length; kept.push(i); exact.set(key, k); }
      remap[i] = k;
    }
  }
  const indices: number[] = [];
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = remap[idx[t]!]!, b = remap[idx[t + 1]!]!, c = remap[idx[t + 2]!]!;
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  // Drop vertices no surviving triangle references, keeping first-use order stable.
  const used = new Int32Array(kept.length).fill(-1);
  const positions: number[] = [];
  for (let j = 0; j < indices.length; j++) {
    const k = indices[j]!;
    if (used[k] === -1) {
      used[k] = positions.length / 3;
      const q = kept[k]!;
      positions.push(p[3 * q]!, p[3 * q + 1]!, p[3 * q + 2]!);
    }
    indices[j] = used[k]!;
  }
  return { positions, indices };
}

/** One triangle of a mesh, as world points plus its triangle index. */
export interface MeshTriangle {
  readonly index: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
}

/** Iterate the triangles of a (valid) mesh in index order, corners in stored winding order. */
export function* meshTriangles(mesh: Mesh3D): Generator<MeshTriangle> {
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    yield { index: t / 3, a: meshVertex(mesh, idx[t]!), b: meshVertex(mesh, idx[t + 1]!), c: meshVertex(mesh, idx[t + 2]!) };
  }
}

/**
 * Signed volume by the divergence theorem: the sum of signed tetrahedra (origin, a, b, c) / 6.
 * Positive for a closed mesh wound outward (counter-clockwise from outside), negative when wound
 * inward; meaningless for an open mesh. Cubic drawing units. Coordinates are taken relative to the
 * first vertex, which avoids cancellation for small parts far from the world origin.
 */
export function meshVolume(mesh: Mesh3D): number {
  if (meshVertexCount(mesh) === 0) return 0;
  const o = meshVertex(mesh, 0);
  let six = 0;
  for (const { a, b, c } of meshTriangles(mesh)) six += dot3(sub3(a, o), cross3(sub3(b, o), sub3(c, o)));
  return six / 6;
}

/** Total triangle area in square drawing units (degenerate triangles add nothing). */
export function meshSurfaceArea(mesh: Mesh3D): number {
  let area = 0;
  for (const { a, b, c } of meshTriangles(mesh)) area += len3(cross3(sub3(b, a), sub3(c, a))) / 2;
  return area;
}

/**
 * True when the mesh is a closed, consistently oriented 2-manifold by index topology: it has at
 * least one triangle, no triangle repeats a vertex index, every directed edge (i -> j) occurs
 * exactly once, and each has exactly one opposite edge (j -> i). Coincident but unwelded vertices
 * count as different vertices, so weld first. Says nothing about outward vs inward orientation
 * (use the sign of `meshVolume`) or self-intersection.
 */
export function meshIsClosed(mesh: Mesh3D): boolean {
  const idx = mesh.indices;
  if (idx.length < 3) return false;
  const n = meshVertexCount(mesh);
  const edges = new Set<number>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    if (a === b || b === c || a === c) return false;
    for (const [i, j] of [[a, b], [b, c], [c, a]] as const) {
      const key = i * n + j;
      if (edges.has(key)) return false;
      edges.add(key);
    }
  }
  for (const key of edges) {
    const i = Math.floor(key / n), j = key - i * n;
    if (!edges.has(j * n + i)) return false;
  }
  return true;
}

const normalsCache = new WeakMap<Mesh3D, Float32Array>();

/**
 * Per-triangle unit normals for flat-shaded display: three floats (nx, ny, nz) per triangle, in
 * triangle order, following the right-hand rule on the stored winding (outward for an outward
 * mesh); degenerate triangles get (0, 0, 0). Display-only data: memoized in a WeakMap keyed by the
 * mesh object (sealed meshes never change, so the identity is a safe key) and never stored in
 * drawing state, which only accepts plain arrays. Callers must not modify the returned array.
 */
export function flatNormals(mesh: Mesh3D): Float32Array {
  const hit = normalsCache.get(mesh);
  if (hit) return hit;
  const out = new Float32Array(meshTriangleCount(mesh) * 3);
  for (const { index, a, b, c } of meshTriangles(mesh)) {
    const nrm = cross3(sub3(b, a), sub3(c, a));
    const l = len3(nrm);
    if (l > 0 && Number.isFinite(l)) {
      out[index * 3] = nrm.x / l;
      out[index * 3 + 1] = nrm.y / l;
      out[index * 3 + 2] = nrm.z / l;
    }
  }
  normalsCache.set(mesh, out);
  return out;
}

/**
 * Concatenate meshes into one (indices offset per part). Winding and positions are kept as they
 * are; coincident vertices of different parts stay separate until `weldVertices`.
 */
export function mergeMeshes(meshes: readonly Mesh3D[]): Mesh3D {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of meshes) {
    const base = positions.length / 3;
    for (let i = 0; i < m.positions.length - (m.positions.length % 3); i++) positions.push(m.positions[i]!);
    for (let i = 0; i < m.indices.length - (m.indices.length % 3); i++) indices.push(m.indices[i]! + base);
  }
  return { positions, indices };
}
