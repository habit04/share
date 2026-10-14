/** Indexed meshes: volume / area, closedness, welding, transforms and display normals. */
import { describe, expect, it } from 'vitest';
import { mat4Multiply, mat4RotationAxis, mat4Scaling, mat4Translation, v3 } from '../src/model3d/math';
import {
  type Mesh3D, EMPTY_MESH, flatNormals, invertWinding, meshBounds, meshIsClosed, meshSurfaceArea, meshTriangleCount, meshTriangles, meshVertexCount,
  meshVolume, mergeMeshes, transformMesh, validateMesh, weldVertices,
} from '../src/model3d/mesh';

/** Unit cube [0, 1]^3, 8 shared vertices, outward winding. */
function unitCube(): Mesh3D {
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0);
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5];
  return { positions, indices };
}

/** The same cube with every triangle owning its three corners (36 vertices, nothing shared). */
function soupCube(): Mesh3D {
  const cube = unitCube();
  const positions: number[] = [];
  for (const i of cube.indices) positions.push(cube.positions[3 * i]!, cube.positions[3 * i + 1]!, cube.positions[3 * i + 2]!);
  return { positions, indices: Array.from({ length: cube.indices.length }, (_, k) => k) };
}

describe('mesh measures', () => {
  it('a unit cube has volume 1, area 6 and is closed', () => {
    const cube = unitCube();
    expect(validateMesh(cube)).toBeNull();
    expect(meshTriangleCount(cube)).toBe(12);
    expect(meshVertexCount(cube)).toBe(8);
    expect(meshVolume(cube)).toBeCloseTo(1, 14);
    expect(meshSurfaceArea(cube)).toBeCloseTo(6, 14);
    expect(meshIsClosed(cube)).toBe(true);
    expect(meshBounds(cube)).toEqual({ min: v3(0, 0, 0), max: v3(1, 1, 1) });
  });

  it('volume is signed by winding and exact far from the origin', () => {
    const cube = unitCube();
    expect(meshVolume(invertWinding(cube))).toBeCloseTo(-1, 14);
    expect(meshIsClosed(invertWinding(cube))).toBe(true);
    const far = transformMesh(cube, mat4Translation(1e7, -1e7, 1e7));
    expect(meshVolume(far)).toBeCloseTo(1, 6);
  });

  it('removing a face opens the mesh', () => {
    const cube = unitCube();
    const open = { positions: cube.positions, indices: cube.indices.slice(6) };
    expect(meshIsClosed(open)).toBe(false);
    expect(meshIsClosed(EMPTY_MESH)).toBe(false);
    // One flipped triangle: its edges duplicate their neighbours' directions.
    const flipped = [...cube.indices];
    [flipped[1], flipped[2]] = [flipped[2]!, flipped[1]!];
    expect(meshIsClosed({ positions: cube.positions, indices: flipped })).toBe(false);
    // A triangle repeating a vertex index never counts as closed topology.
    expect(meshIsClosed({ positions: cube.positions, indices: [...cube.indices, 0, 0, 1] })).toBe(false);
  });

  it('meshTriangles iterates corners in stored order', () => {
    const tris = [...meshTriangles(unitCube())];
    expect(tris).toHaveLength(12);
    expect(tris[0]).toEqual({ index: 0, a: v3(0, 0, 0), b: v3(0, 1, 0), c: v3(1, 0, 0) });
  });
});

describe('validateMesh', () => {
  it('reports structural problems', () => {
    expect(validateMesh(EMPTY_MESH)).toBeNull();
    expect(validateMesh({ positions: [0, 0], indices: [] })).toMatch(/triples/);
    expect(validateMesh({ positions: [0, 0, 0], indices: [0, 0] })).toMatch(/triangles/);
    expect(validateMesh({ positions: [0, NaN, 0], indices: [] })).toMatch(/finite/);
    expect(validateMesh({ positions: [0, 0, 0], indices: [0, 0, 1] })).toMatch(/range/);
    expect(validateMesh({ positions: [0, 0, 0], indices: [0, 0, 0.5] })).toMatch(/range/);
    expect(validateMesh({ positions: [0, 0, 0], indices: [0, 0, -1] })).toMatch(/range/);
  });
});

describe('weldVertices', () => {
  it('merges duplicate corners into a closed mesh', () => {
    const soup = soupCube();
    expect(meshVertexCount(soup)).toBe(36);
    expect(meshIsClosed(soup)).toBe(false);
    const welded = weldVertices(soup);
    expect(meshVertexCount(welded)).toBe(8);
    expect(meshTriangleCount(welded)).toBe(12);
    expect(meshIsClosed(welded)).toBe(true);
    expect(meshVolume(welded)).toBeCloseTo(1, 14);
    expect(weldVertices(soup, 0).positions).toHaveLength(24);
  });

  it('uses a tolerance relative to the model size', () => {
    const jitter = (m: Mesh3D, e: number): Mesh3D => ({ positions: m.positions.map((v, i) => v + (i % 7 === 0 ? e : 0)), indices: m.indices });
    for (const size of [1e-3, 1, 1e5]) {
      const soup = transformMesh(soupCube(), mat4Scaling(size, size, size));
      expect(meshVertexCount(weldVertices(jitter(soup, size * 1e-12)))).toBe(8);
      expect(meshVertexCount(weldVertices(jitter(soup, size * 1e-4)))).toBeGreaterThan(8);
    }
  });

  it('drops triangles that collapse and vertices left unused', () => {
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 1e-15, 0, 0, 0, 1, 0, 9, 9, 9], indices: [0, 1, 3, 0, 2, 3] };
    const welded = weldVertices(mesh);
    expect(welded.indices).toEqual([0, 1, 2]);
    expect(welded.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe('transformMesh', () => {
  it('moves vertices and scales the volume by the determinant', () => {
    const cube = unitCube();
    const m = transformMesh(cube, mat4Multiply(mat4Translation(5, 6, 7), mat4Scaling(2, 3, 4)));
    expect(meshVolume(m)).toBeCloseTo(24, 12);
    expect(meshBounds(m)).toEqual({ min: v3(5, 6, 7), max: v3(7, 9, 11) });
    expect(m.indices).toBe(cube.indices);
    const r = transformMesh(cube, mat4RotationAxis(v3(1, 2, 3), 0.8));
    expect(meshVolume(r)).toBeCloseTo(1, 12);
    expect(meshSurfaceArea(r)).toBeCloseTo(6, 12);
  });

  it('keeps solids outward-facing under a mirror', () => {
    const mirrored = transformMesh(unitCube(), mat4Scaling(-1, 1, 1));
    expect(meshVolume(mirrored)).toBeCloseTo(1, 14);
    expect(meshIsClosed(mirrored)).toBe(true);
    expect(meshBounds(mirrored)).toEqual({ min: v3(-1, 0, 0), max: v3(0, 1, 1) });
  });
});

describe('flatNormals', () => {
  it('returns outward unit normals per triangle, memoized by mesh identity', () => {
    const cube = unitCube();
    const n = flatNormals(cube);
    expect(n).toBeInstanceOf(Float32Array);
    expect(n).toHaveLength(36);
    expect([...n.slice(0, 3)]).toEqual([0, 0, -1]); // bottom
    expect([...n.slice(6, 9)]).toEqual([0, 0, 1]); // top
    expect([...n.slice(33, 36)]).toEqual([1, 0, 0]); // right
    expect(flatNormals(cube)).toBe(n);
    expect(flatNormals({ ...cube })).not.toBe(n);
    expect([...flatNormals({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] })]).toEqual([0, 0, 0]);
  });
});

describe('mergeMeshes', () => {
  it('offsets indices per part', () => {
    const cube = unitCube();
    const both = mergeMeshes([cube, transformMesh(cube, mat4Translation(3, 0, 0))]);
    expect(meshTriangleCount(both)).toBe(24);
    expect(meshIsClosed(both)).toBe(true);
    expect(meshVolume(both)).toBeCloseTo(2, 12);
    expect(validateMesh(both)).toBeNull();
  });
});
