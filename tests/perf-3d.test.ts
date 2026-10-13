/**
 * Performance budgets for the experimental 3D core (milestone 6 of docs/3D-PLAN.md).
 *
 * Budgets follow tests/perf.test.ts: about 3x the slowest measurement on the development machine
 * (Windows x64, Intel Core i7-12850HX, Node 22.23.3; docs/PERFORMANCE.md "3D" lists the numbers),
 * with a floor, so a slower runner does not flake while an accidental O(n^2) regression (10-100x)
 * still fails. JCAD_PERF_FACTOR scales every budget. Every measurement is printed ("perf3d ...").
 *
 * The light cases (tessellation, extrusion, revolution) run in every `npm test`. The heavy cases
 * (meshes of 500,000 and 2,000,000 triangles, a 100,000-triangle DXF round trip, a Manifold union
 * of two 50,000-triangle spheres) take several seconds of CPU and hundreds of MB, and would disturb
 * the timing budgets of the files running in parallel, so like tests/perf-dense.test.ts they run
 * only with JCAD_BENCH=1, on their own:  npm run bench:3d
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { prepareDrawingState } from '../src/core/geometry-budget';
import type { Point } from '../src/core/geometry';
import { readDxf, writeDxf } from '../src/io/dxf';
import { MAX_MODEL3D_TRIANGLES } from '../src/model3d/budget';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { type Ray, type Vec3, WORLD_XY_FRAME, mat4Translation, normalize3, sub3, v3 } from '../src/model3d/math';
import { type Mesh3D, mergeMeshes, meshIsClosed, meshTriangleCount, meshVolume, transformMesh, weldVertices } from '../src/model3d/mesh';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { MAX_RINGS, MAX_SEGMENTS, boxMesh, coneMesh, cylinderMesh, sphereMesh, torusMesh, wedgeMesh } from '../src/model3d/primitives';
import { extrudeMesh, revolveMesh } from '../src/model3d/sweep';
import type { Model3D, Profile3D, Solid3D } from '../src/model3d/types';
import { meshBvh, pickSolids } from '../src/render3d/picking';

const BENCH = !!process.env.JCAD_BENCH;
/** Per-test timeout of the heavy cases (each builds meshes of millions of numbers first). */
const HEAVY_TIMEOUT = 180_000;
const FACTOR = Number(process.env.JCAD_PERF_FACTOR ?? '1') || 1;

/**
 * Budgets in ms: about 3x the slowest of four runs on the development machine (the light cases
 * also measured while the whole suite ran in parallel), with a 50 ms floor; docs/PERFORMANCE.md
 * "3D" has the measurements. `pickRay` is per ray against the whole 2,000,000-triangle scene
 * (measured 0.01-0.02 ms; the 0.25 ms floor is still far below a 16 ms frame).
 */
const BUDGET = {
  primitives: 50,
  extrude: 50,
  revolve: 150,
  closed500k: 400,
  weld500k: 1500,
  weldExact500k: 400,
  volume500k: 250,
  bvhBuild2M: 21000,
  pickRay: 0.25,
  dxfWrite100k: 1800,
  dxfRead100k: 4500,
  seal2M: 5500,
  union50k: 1700,
};

function best<T>(label: string, fn: () => T, runs = 3): { ms: number; value: T } {
  // Best of a few runs: the first one also pays for JIT warm-up.
  let ms = Infinity;
  let value: T | undefined;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    value = fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  console.log(`perf3d ${label.padEnd(34)} ${ms.toFixed(2).padStart(10)} ms`);
  return { ms, value: value as T };
}

/** Points of a circle (counter-clockwise; `cw` reverses it), starting on +X. */
function circle(cx: number, cy: number, r: number, n: number, cw = false): Point[] {
  const pts = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
  return cw ? pts.reverse() : pts;
}

/** `count` copies of a UV sphere of about `tris` triangles each (256 segments), spaced along X. */
function sphereRow(count: number, rings: number): Mesh3D[] {
  const sphere = sphereMesh(1, MAX_SEGMENTS, rings);
  return Array.from({ length: count }, (_, i) => transformMesh(sphere, mat4Translation(3 * (i % 8), 3 * Math.floor(i / 8), 0)));
}

/** Each triangle with its own three vertices (an imported, unwelded triangle soup). */
function soup(mesh: Mesh3D): Mesh3D {
  const positions: number[] = [];
  const idx = mesh.indices, p = mesh.positions;
  for (let k = 0; k < idx.length; k++) positions.push(p[3 * idx[k]!]!, p[3 * idx[k]! + 1]!, p[3 * idx[k]! + 2]!);
  return { positions, indices: Array.from({ length: idx.length }, (_, k) => k) };
}

function modelOf(meshes: readonly Mesh3D[]): Model3D {
  const solids: Solid3D[] = meshes.map((mesh, i) => newSolid({ id: `perf-${i}`, mesh, feature: { kind: 'mesh', source: 'edited' } }));
  return addSolids({ version: 1, solids: [] }, solids);
}

describe('3D modelling performance (every run)', () => {
  it('tessellates every primitive at the maximum detail', () => {
    const r = best('primitives at 256 x 128', () => [
      boxMesh(1, 2, 3), wedgeMesh(1, 2, 3), cylinderMesh(1, 2, MAX_SEGMENTS), coneMesh(1, 0.5, 2, MAX_SEGMENTS),
      sphereMesh(1, MAX_SEGMENTS, MAX_RINGS), torusMesh(2, 0.5, MAX_SEGMENTS, MAX_RINGS),
    ], 5);
    const tris = r.value.reduce((n, m) => n + meshTriangleCount(m), 0);
    expect(tris).toBe(12 + 8 + 4 * 256 + 4 * 256 + 2 * 256 * 127 + 2 * 256 * 128);
    expect(r.value.every((m) => meshIsClosed(m))).toBe(true);
    expect(r.ms).toBeLessThan(BUDGET.primitives * FACTOR);
  });

  it('extrudes a 200-vertex profile with 10 holes', () => {
    const holes = Array.from({ length: 10 }, (_, k) => circle(60 * Math.cos((2 * Math.PI * k) / 10), 60 * Math.sin((2 * Math.PI * k) / 10), 12, 16, true));
    const profile: Profile3D = { frame: WORLD_XY_FRAME, loops: [circle(0, 0, 100, 200), ...holes] };
    const r = best('extrude 200 + 10 x 16 vertices', () => extrudeMesh(profile, 25), 5);
    expect(meshIsClosed(r.value)).toBe(true);
    expect(meshTriangleCount(r.value)).toBe(2 * (360 + 2 * 10 - 2) + 2 * 360);
    expect(r.ms).toBeLessThan(BUDGET.extrude * FACTOR);
  });

  it('revolves a 100-vertex profile at 256 segments', () => {
    const profile: Profile3D = { frame: WORLD_XY_FRAME, loops: [circle(50, 0, 10, 100)] };
    const r = best('revolve 100 vertices x 256', () => revolveMesh(profile, { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, 2 * Math.PI, 256), 5);
    expect(meshTriangleCount(r.value)).toBe(2 * 100 * 256);
    expect(meshIsClosed(r.value)).toBe(true);
    expect(r.ms).toBeLessThan(BUDGET.revolve * FACTOR);
  });
});

describe.skipIf(!BENCH)('3D performance on large meshes (JCAD_BENCH=1, npm run bench:3d)', () => {
  const kernel = new ManifoldDirectKernel();
  afterAll(() => kernel.dispose());

  it('meshIsClosed, weldVertices and meshVolume on a 500,000-triangle mesh', () => {
    // 8 spheres of 256 x 123: 8 x 62,464 = 499,712 triangles.
    const mesh = mergeMeshes(sphereRow(8, 123));
    expect(meshTriangleCount(mesh)).toBe(499_712);
    const closed = best('meshIsClosed (500k)', () => meshIsClosed(mesh), 2);
    expect(closed.value).toBe(true);
    expect(closed.ms).toBeLessThan(BUDGET.closed500k * FACTOR);
    const loose = soup(mesh);
    const weld = best('weldVertices soup (500k, 1.5M verts)', () => weldVertices(loose), 2);
    expect(meshTriangleCount(weld.value)).toBe(499_712);
    expect(meshIsClosed(weld.value)).toBe(true);
    expect(weld.ms).toBeLessThan(BUDGET.weld500k * FACTOR);
    const exact = best('weldVertices exact (500k soup)', () => weldVertices(loose, 0), 2);
    expect(meshIsClosed(exact.value)).toBe(true);
    expect(exact.ms).toBeLessThan(BUDGET.weldExact500k * FACTOR);
    const volume = best('meshVolume (500k)', () => meshVolume(mesh), 3);
    expect(volume.value).toBeGreaterThan(8 * 4.1);
    expect(volume.ms).toBeLessThan(BUDGET.volume500k * FACTOR);
  }, HEAVY_TIMEOUT);

  it('CPU picking on a 2,000,000-triangle scene: BVHs built once, 200 random rays', () => {
    // 32 spheres of 256 x 123: 1,998,848 triangles (the model limit is 2,000,000).
    const model = modelOf(sphereRow(32, 123));
    const tris = model.solids.reduce((n, s) => n + meshTriangleCount(s.mesh), 0);
    expect(tris).toBe(1_998_848);
    expect(tris).toBeLessThanOrEqual(MAX_MODEL3D_TRIANGLES);
    const t0 = performance.now();
    for (const s of model.solids) meshBvh(s.mesh);
    const build = performance.now() - t0;
    console.log(`perf3d ${'BVH build (2M, 32 solids)'.padEnd(34)} ${build.toFixed(2).padStart(10)} ms`);
    expect(build).toBeLessThan(BUDGET.bvhBuild2M * FACTOR);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Rays from a box around the scene (x 0..21, y 0..9) toward random points inside it.
    const rays: Ray[] = Array.from({ length: 200 }, () => {
      const origin: Vec3 = v3(rnd() * 40 - 10, rnd() * 30 - 10, 20 + rnd() * 10);
      const target: Vec3 = v3(rnd() * 23 - 1, rnd() * 11 - 1, rnd() * 2 - 1);
      return { origin, dir: normalize3(sub3(target, origin)) };
    });
    const r = best('pick 200 rays (2M scene)', () => rays.map((ray) => pickSolids(model, ray)), 3);
    const hits = r.value.filter((h) => h.length > 0).length;
    console.log(`perf3d ${'pick per ray (2M scene)'.padEnd(34)} ${(r.ms / rays.length).toFixed(3).padStart(10)} ms   (${hits} of 200 rays hit)`);
    expect(hits).toBeGreaterThan(40);
    expect(r.ms / rays.length).toBeLessThan(BUDGET.pickRay * FACTOR);
  }, HEAVY_TIMEOUT);

  it('DXF write and read of 100 solids / 100,000 triangles', () => {
    // 100 spheres of 25 x 21: 1,000 triangles and 502 vertices each.
    const sphere = sphereMesh(1, 25, 21);
    expect(meshTriangleCount(sphere)).toBe(1000);
    const meshes = Array.from({ length: 100 }, (_, i) => transformMesh(sphere, mat4Translation(3 * (i % 10), 3 * Math.floor(i / 10), 0)));
    const base = new Drawing().snapshot;
    const state: DrawingState = withModel3D(base, addSolids(model3dOf(base), modelOf(meshes).solids));
    const w = best('writeDxf 100 solids / 100k tris', () => writeDxf(state), 2);
    console.log(`perf3d ${'  file size'.padEnd(34)} ${(w.value.length / 1024 / 1024).toFixed(1).padStart(10)} MB`);
    expect(w.ms).toBeLessThan(BUDGET.dxfWrite100k * FACTOR);
    const r = best('readDxf 100 solids / 100k tris', () => readDxf(w.value), 2);
    expect(r.value.model3d?.solids).toHaveLength(100);
    expect(r.value.model3d!.solids[42]!.mesh).toEqual({ positions: meshes[42]!.positions.map((n) => n + 0), indices: meshes[42]!.indices });
    expect(r.ms).toBeLessThan(BUDGET.dxfRead100k * FACTOR);
  }, HEAVY_TIMEOUT);

  it('prepareDrawingState seals a 2,000,000-triangle model (the sealing cost)', () => {
    let ms = Infinity;
    for (let run = 0; run < 2; run++) {
      // A fresh, unsealed state each time (sealing is cached per object).
      const meshes = sphereRow(32, 123).map((m) => ({ positions: [...m.positions], indices: [...m.indices] }));
      const state: DrawingState = withModel3D(new Drawing().snapshot, modelOf(meshes));
      const t0 = performance.now();
      prepareDrawingState(state);
      ms = Math.min(ms, performance.now() - t0);
      expect(Object.isFrozen(state.model3d!.solids[31]!.mesh.indices)).toBe(true);
    }
    console.log(`perf3d ${'prepareDrawingState seal (2M)'.padEnd(34)} ${ms.toFixed(2).padStart(10)} ms`);
    expect(ms).toBeLessThan(BUDGET.seal2M * FACTOR);
  }, HEAVY_TIMEOUT);

  it('in-process Manifold union of two 50,000-triangle spheres', async () => {
    expect((await kernel.ready()).available).toBe(true);
    const a = sphereMesh(1, 250, 101);
    expect(meshTriangleCount(a)).toBe(50_000);
    const b = transformMesh(a, mat4Translation(0.7, 0.3, 0.1));
    let ms = Infinity;
    let result: Mesh3D | undefined;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      result = await kernel.boolean('union', a, b);
      ms = Math.min(ms, performance.now() - t0);
    }
    console.log(`perf3d ${'Manifold union 2 x 50k (in-process)'.padEnd(34)} ${ms.toFixed(2).padStart(10)} ms   (${meshTriangleCount(result!)} triangles out)`);
    expect(meshIsClosed(result!)).toBe(true);
    expect(meshVolume(result!)).toBeGreaterThan(meshVolume(a));
    expect(ms).toBeLessThan(BUDGET.union50k * FACTOR);
  }, HEAVY_TIMEOUT);
});
