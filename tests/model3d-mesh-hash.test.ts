/**
 * `weldVertices` and `meshIsClosed` were rewritten for speed in milestone 6 (typed-array hash tables
 * instead of string-keyed Maps and a Set of edge keys; 6-9 s -> 0.3-0.5 s and 0.75 s -> 0.1 s on
 * 500,000 triangles, docs/PERFORMANCE.md "3D"). This property test keeps the previous
 * implementations as the reference and checks the new ones give exactly the same results on
 * random meshes: jittered and duplicated vertices, -0, degenerate and repeated triangles, open and
 * inconsistently wound meshes, and both tolerance paths of the weld.
 */
import { describe, it } from 'vitest';
import { len3, mat4Translation, sub3 } from '../src/model3d/math';
import { type Mesh3D, meshBounds, meshIsClosed, meshVertexCount, mergeMeshes, transformMesh, weldVertices } from '../src/model3d/mesh';
import { boxMesh, cylinderMesh, sphereMesh, torusMesh } from '../src/model3d/primitives';
import { type Rng, check, fuzzSync } from './helpers/fuzz';

/** The weld before milestone 6 (string-keyed grid / exact map), verbatim. */
function referenceWeld(mesh: Mesh3D, tol = 1e-9): Mesh3D {
  const n = meshVertexCount(mesh);
  const bounds = meshBounds(mesh);
  const diag = bounds ? len3(sub3(bounds.max, bounds.min)) : 0;
  const abs = Math.max(0, tol) * diag;
  const p = mesh.positions;
  const remap = new Int32Array(n);
  const kept: number[] = [];
  if (abs > 0) {
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

/** meshIsClosed before milestone 6 (a Set of i * n + j edge keys), verbatim. */
function referenceClosed(mesh: Mesh3D): boolean {
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

/** Each triangle with its own vertices, optionally jittered (some by less than the weld tolerance). */
function soup(rng: Rng, mesh: Mesh3D, jitter: number): Mesh3D {
  const positions: number[] = [];
  for (const i of mesh.indices) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[3 * i + k]!;
      positions.push(rng.bool(0.3) ? v + (rng.next() - 0.5) * jitter : v === 0 && rng.bool(0.5) ? -0 : v);
    }
  }
  return { positions, indices: mesh.indices.map((_, k) => k) };
}

function randomMesh(rng: Rng): Mesh3D {
  const parts: Mesh3D[] = [];
  for (let k = rng.int(1, 3); k > 0; k--) {
    const m = rng.pick([() => boxMesh(1, 2, 3), () => cylinderMesh(1, 2, rng.int(3, 20)), () => sphereMesh(1, rng.int(3, 12), rng.int(2, 8)), () => torusMesh(2, 0.5, rng.int(3, 10), rng.int(3, 6))])();
    parts.push(transformMesh(m, mat4Translation(rng.int(-2, 2) * rng.pick([0, 0.5, 1e-10, 1e6]), rng.int(-2, 2), 0)));
  }
  let mesh = mergeMeshes(parts);
  if (rng.bool(0.5)) mesh = soup(rng, mesh, rng.pick([1e-12, 1e-9, 1e-6, 1e-3]));
  const idx = [...mesh.indices];
  // Topology damage: drop, repeat, flip or collapse triangles.
  for (let d = rng.int(0, 3); d > 0 && idx.length >= 6; d--) {
    const t = 3 * rng.int(0, idx.length / 3 - 1);
    const what = rng.int(0, 3);
    if (what === 0) idx.splice(t, 3);
    else if (what === 1) idx.push(idx[t]!, idx[t + 1]!, idx[t + 2]!);
    else if (what === 2) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
    else idx[t + 1] = idx[t]!;
  }
  return { positions: mesh.positions, indices: idx };
}

describe('hash-table weldVertices and meshIsClosed match the previous implementations', () => {
  it('on random meshes, for every tolerance', () => {
    fuzzSync('model3d-weld-closed-equivalence', 400, (rng) => {
      const mesh = randomMesh(rng);
      check(meshIsClosed(mesh) === referenceClosed(mesh), 'meshIsClosed differs');
      for (const tol of [0, 1e-12, 1e-9, 1e-6, 1e-3]) {
        const a = weldVertices(mesh, tol), b = referenceWeld(mesh, tol);
        check(a.indices.length === b.indices.length && a.indices.every((v, i) => v === b.indices[i]), () => `weld indices differ at tol ${tol}`);
        check(a.positions.length === b.positions.length && a.positions.every((v, i) => Object.is(v, b.positions[i])), () => `weld positions differ at tol ${tol}`);
        check(meshIsClosed(a) === referenceClosed(a), 'meshIsClosed differs after welding');
      }
    });
  });

  it('refuses meshes whose indices are not vertex numbers', () => {
    check(!meshIsClosed({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, -1] }), 'negative index');
    check(!meshIsClosed({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 1.5] }), 'fractional index');
  });
});
