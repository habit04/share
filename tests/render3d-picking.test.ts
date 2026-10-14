import { describe, it, expect } from 'vitest';
import { BVH_LEAF_SIZE, intersectMesh, meshBvh, pickSolid, pickSolids } from '../src/render3d/picking';
import { type Ray, type Vec3, WORLD_XY_FRAME, add3, dot3, frameFromPlane, intersectRayTriangle, normalize3, scale3, sub3, v3 } from '../src/model3d/math';
import { invertWinding, meshTriangles, meshVertex, meshVertexCount } from '../src/model3d/mesh';
import { boxMesh, primitiveMesh, sphereMesh } from '../src/model3d/primitives';
import { newSolid } from '../src/model3d/model';
import type { Model3D, PrimitiveFeature, Solid3D } from '../src/model3d/types';

const at = (x: number, y: number, z = 0) => ({ ...WORLD_XY_FRAME, origin: v3(x, y, z) });
const solid = (id: string, feature: PrimitiveFeature, layer = '0'): Solid3D => newSolid({ id, mesh: primitiveMesh(feature), feature, layer });
const model = (...solids: Solid3D[]): Model3D => ({ version: 1, solids });
const down = (x: number, y: number, z = 100): Ray => ({ origin: v3(x, y, z), dir: v3(0, 0, -1) });

/** Brute force: nearest triangle hit without the BVH. */
function brute(mesh: Solid3D['mesh'], ray: Ray): number | null {
  let best: number | null = null;
  for (const { a, b, c } of meshTriangles(mesh)) {
    const h = intersectRayTriangle(ray, a, b, c);
    if (h && (best === null || h.t < best)) best = h.t;
  }
  return best;
}

/** Brute force with the documented tie rule: nearest t, ties to the lowest triangle index. */
function bruteHit(mesh: Solid3D['mesh'], ray: Ray): { t: number; triangle: number } | null {
  let best: { t: number; triangle: number } | null = null;
  for (const { index, a, b, c } of meshTriangles(mesh)) {
    const h = intersectRayTriangle(ray, a, b, c);
    if (h && (!best || h.t < best.t)) best = { t: h.t, triangle: index };
  }
  return best;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('pickSolids', () => {
  const box = solid('box', { kind: 'box', frame: at(0, 0), width: 2, depth: 2, height: 1 });
  const sphere = solid('sphere', { kind: 'sphere', frame: at(5, 0, 1), radius: 1 });

  it('hits the top face of a box from above with the outward normal', () => {
    const [hit, ...rest] = pickSolids(model(box, sphere), down(0.3, -0.2));
    expect(rest).toEqual([]);
    expect(hit!.id).toBe('box');
    expect(hit!.t).toBeCloseTo(99, 12);
    expect(hit!.point.z).toBeCloseTo(1, 12);
    expect(dot3(hit!.normal, v3(0, 0, 1))).toBeCloseTo(1, 12);
    expect(hit!.triangle).toBeGreaterThanOrEqual(0);
  });

  it('misses empty space and solids behind the ray origin', () => {
    expect(pickSolids(model(box, sphere), down(2.5, 0))).toEqual([]);
    expect(pickSolids(model(box), { origin: v3(0, 0, -5), dir: v3(0, 0, -1) })).toEqual([]);
    expect(pickSolids(model(), down(0, 0))).toEqual([]);
  });

  it('returns every hit solid nearest first', () => {
    const near = solid('near', { kind: 'box', frame: at(0, 0, 10), width: 1, depth: 1, height: 1 });
    const far = solid('far', { kind: 'box', frame: at(0, 0, -10), width: 1, depth: 1, height: 1 });
    // Model order deliberately differs from depth order.
    const hits = pickSolids(model(far, box, near), down(0, 0));
    expect(hits.map((h) => h.id)).toEqual(['near', 'box', 'far']);
    expect(hits[0]!.t).toBeLessThan(hits[1]!.t);
    // From below the order reverses.
    expect(pickSolids(model(far, box, near), { origin: v3(0, 0, -100), dir: v3(0, 0, 1) }).map((h) => h.id)).toEqual(['far', 'box', 'near']);
  });

  it('hits meshes of either winding, and from inside', () => {
    const inward: Solid3D = { ...box, id: 'inward', mesh: invertWinding(box.mesh) };
    const a = pickSolid(box, down(0.1, 0.1))!;
    const b = pickSolid(inward, down(0.1, 0.1))!;
    expect(b.t).toBeCloseTo(a.t, 12);
    // The stored winding decides the normal: inward mesh, inward normal.
    expect(dot3(b.normal, v3(0, 0, 1))).toBeCloseTo(-1, 12);
    const inside = pickSolid(box, { origin: v3(0, 0, 0.5), dir: v3(0, 0, 1) })!;
    expect(inside.t).toBeCloseTo(0.5, 12);
  });

  it('skips solids on hidden layers', () => {
    const hidden = solid('h', { kind: 'box', frame: at(0, 0, 3), width: 1, depth: 1, height: 1 }, 'OFF');
    expect(pickSolids(model(hidden, box), down(0, 0), { hiddenLayers: new Set(['OFF']) }).map((h) => h.id)).toEqual(['box']);
  });

  it('a ray through a shared edge still hits (no gap between triangles)', () => {
    // The box top is split along its diagonal; aim exactly at the diagonal and at a corner.
    expect(pickSolid(box, down(0, 0))).not.toBeNull();
    expect(pickSolid(box, down(1, 1))).not.toBeNull();
    expect(pickSolid(box, down(-1, 1))).not.toBeNull();
  });
});

describe('mesh BVH', () => {
  it('splits into leaves of at most 8 triangles and covers every triangle once', () => {
    const mesh = sphereMesh(2, 48, 24);
    const bvh = meshBvh(mesh);
    expect(meshBvh(mesh)).toBe(bvh); // cached per mesh object
    const seen = new Set<number>();
    for (let n = 0; n < bvh.nodeCount; n++) {
      if (bvh.count[n]! === 0) continue;
      expect(bvh.count[n]!).toBeLessThanOrEqual(BVH_LEAF_SIZE);
      for (let i = bvh.start[n]!; i < bvh.start[n]! + bvh.count[n]!; i++) seen.add(bvh.order[i]!);
    }
    expect(seen.size).toBe(mesh.indices.length / 3);
  });

  it('agrees with brute force on random rays', () => {
    const mesh = primitiveMesh({ kind: 'torus', frame: at(1, 2, 3), majorRadius: 3, minorRadius: 1, segments: 40, rings: 20 });
    const r = rng(42);
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      const origin = v3((r() - 0.5) * 20 + 1, (r() - 0.5) * 20 + 2, (r() - 0.5) * 20 + 3);
      const target = v3((r() - 0.5) * 6 + 1, (r() - 0.5) * 6 + 2, (r() - 0.5) * 2 + 3);
      const ray = { origin, dir: normalize3({ x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z }) };
      const fast = intersectMesh(mesh, ray);
      const slow = brute(mesh, ray);
      if (slow === null) expect(fast).toBeNull();
      else {
        hits++;
        expect(fast!.t).toBeCloseTo(slow, 9);
      }
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('a ray grazing a solid outline hits like brute force (the box test is padded, the triangle test decides)', () => {
    // Just outside the box top's silhouette but inside the triangle test's EPS3 slack (2e-9 on a
    // 2-unit edge): the exact box test rejects the ray while the triangle test accepts it.
    const box = boxMesh(2, 2, 1);
    const graze: Ray = { origin: v3(1 + 1.9e-9, 0.3, 100), dir: v3(0, 0, -1) };
    expect(bruteHit(box, graze)).not.toBeNull();
    expect(intersectMesh(box, graze)).toEqual(bruteHit(box, graze));
    // An oblique ray through a box corner.
    const corner: Ray = { origin: v3(-4.612999759614468, -1.6477847062051296, -5.061008527874947), dir: v3(0.7425394505159308, 0.019550325893431447, 0.669516952126651) };
    const wide = boxMesh(2, 3, 4);
    expect(bruteHit(wide, corner)).not.toBeNull();
    expect(intersectMesh(wide, corner)).toEqual(bruteHit(wide, corner));
  });

  it('rays down an oblique construction plane through every box corner hit (typed corners at "Select a face")', () => {
    // faceBelow casts origin + reach * n toward -n through the typed point; the plane coordinates of a
    // corner round-trip world -> plane -> world. Every corner must be hit, as brute force hits it.
    const r = rng(5);
    let corners = 0, misses = 0, mismatches = 0;
    for (let k = 0; k < 40; k++) {
      const plane = frameFromPlane({ origin: v3(r() * 10, r() * 10, r() * 10), normal: normalize3(v3(r() - 0.5, r() - 0.5, r() + 0.2)) });
      const b = solid('b', { kind: 'box', frame: at(Math.round(r() * 100), Math.round(r() * 100)), width: 10 + Math.round(r() * 50), depth: 10 + Math.round(r() * 50), height: 5 + Math.round(r() * 20) });
      for (let i = 0; i < meshVertexCount(b.mesh); i++) {
        const p = meshVertex(b.mesh, i);
        const d = sub3(p, plane.origin);
        const local = { x: dot3(d, plane.xAxis), y: dot3(d, plane.yAxis) };
        const q: Vec3 = add3(plane.origin, add3(scale3(plane.xAxis, local.x), scale3(plane.yAxis, local.y)));
        const ray: Ray = { origin: add3(q, scale3(plane.zAxis, 500)), dir: scale3(plane.zAxis, -1) };
        const slow = bruteHit(b.mesh, ray);
        if (!slow) continue;
        corners++;
        const hit = pickSolid(b, ray);
        if (!hit) misses++;
        else if (hit.t !== slow.t || hit.triangle !== slow.triangle) mismatches++;
      }
    }
    expect(corners).toBeGreaterThan(200);
    expect(misses).toBe(0);
    expect(mismatches).toBe(0);
  });

  it('handles empty and tiny meshes', () => {
    expect(intersectMesh({ positions: [], indices: [] }, down(0, 0))).toBeNull();
    expect(intersectMesh(boxMesh(1e-6, 1e-6, 1e-6), down(0, 0))).not.toBeNull();
  });
});
