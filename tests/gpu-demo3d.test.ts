import { describe, expect, it } from 'vitest';
import {
  add3, cameraBasis, cameraMatrices, cameraRay, createCamera3d, cross3, dot3, fitCamera,
  orbitCamera, panCamera, projectToScreen, scale3, setCameraProjection, sub3, zoomCamera,
  type Bounds3d, type Camera3d, type Vec3,
} from '../src/render/gpu-prototype/camera3d';
import {
  createBox, createCylinder, createDemoMeshes, createGrid, createSphere, intersectTriangle,
  meshBounds, pickMeshes, type Mesh3d,
} from '../src/render/gpu-prototype/meshes3d';

function expectVector(actual: Vec3, expected: Vec3, digits = 6): void {
  for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis]!, digits);
}
function transform(matrix: Float32Array, point: Vec3): [number, number, number, number] {
  return [0, 1, 2, 3].map(row => matrix[row]! * point[0] + matrix[4 + row]! * point[1] + matrix[8 + row]! * point[2] + matrix[12 + row]!) as [number, number, number, number];
}
function vertex(data: Float32Array, i: number): Vec3 { return [data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!]; }
function corners(bounds: Bounds3d): Vec3[] {
  const result: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) result.push([x, y, z]);
  return result;
}
const frontCamera = (): Camera3d => ({ ...createCamera3d(), target: [0, 0, 0], yaw: 0, pitch: 0, distance: 10 });

describe('standalone 3D meshes', () => {
  it.each(createDemoMeshes().map(m => [m.name, m] as const))('%s has finite, bounded vertices, outward triangles, and unit normals', (_name, m) => {
    expect(m.positions.length % 3).toBe(0);
    expect(m.normals.length).toBe(m.positions.length);
    expect(m.indices.length % 3).toBe(0);
    expect(m.indices.length).toBeGreaterThan(0);
    for (let i = 0; i < m.positions.length / 3; i++) {
      const p = vertex(m.positions, i), n = vertex(m.normals, i);
      expect(p.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      for (let axis = 0; axis < 3; axis++) {
        expect(p[axis]).toBeGreaterThanOrEqual(m.bounds.min[axis]!);
        expect(p[axis]).toBeLessThanOrEqual(m.bounds.max[axis]!);
      }
    }
    for (let i = 0; i < m.indices.length; i += 3) {
      const a = m.indices[i]!, b = m.indices[i + 1]!, c = m.indices[i + 2]!;
      for (const index of [a, b, c]) expect(index).toBeLessThan(m.positions.length / 3);
      const normal = cross3(sub3(vertex(m.positions, b), vertex(m.positions, a)), sub3(vertex(m.positions, c), vertex(m.positions, a)));
      expect(Math.hypot(...normal)).toBeGreaterThan(1e-6);
      expect(dot3(normal, add3(add3(vertex(m.normals, a), vertex(m.normals, b)), vertex(m.normals, c)))).toBeGreaterThan(0);
    }
  });

  it('creates separated solids on the ground and a valid line grid', () => {
    const meshes = createDemoMeshes();
    expect(meshes.map(m => m.id)).toEqual(['box', 'sphere', 'cylinder']);
    expect(meshes[0]!.bounds.max[0]).toBeLessThan(meshes[1]!.bounds.min[0]);
    expect(meshes[1]!.bounds.max[0]).toBeLessThan(meshes[2]!.bounds.min[0]);
    for (const m of meshes) expect(m.bounds.min[1]).toBeCloseTo(0);
    expect(meshBounds(meshes).min[0]).toBe(-4);
    expect(meshBounds([])).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    const grid = createGrid();
    expect(grid.length % 6).toBe(0);
    for (let i = 1; i < grid.length; i += 3) expect(grid[i]).toBe(0);
  });

  it('bounds subdivisions and rejects invalid dimensions before allocating', () => {
    expect(() => createBox([0, 0, 0], [0, 1, 1])).toThrow(RangeError);
    expect(() => createSphere([0, 0, 0], NaN)).toThrow(RangeError);
    expect(() => createSphere([0, 0, 0], 1, 2)).toThrow(RangeError);
    expect(() => createSphere([0, 0, 0], 1, 100000, 100000)).toThrow(RangeError);
    expect(() => createCylinder([0, 0, 0], 1, -1)).toThrow(RangeError);
    expect(() => createCylinder([Infinity, 0, 0])).toThrow(RangeError);
    expect(() => createGrid(0)).toThrow(RangeError);
  });
});

describe('pure 3D camera', () => {
  it('orbits without mutation, wraps yaw, and clamps both poles', () => {
    const original = createCamera3d(), snapshot = structuredClone(original);
    const orbited = orbitCamera(original, 120, 40);
    expect(original).toEqual(snapshot);
    expect(orbited.yaw).not.toBe(original.yaw);
    expect(orbited.pitch).not.toBe(original.pitch);
    expect(orbited.target).toEqual(original.target);
    for (const dy of [-1e6, 1e6]) {
      const camera = orbitCamera(original, 1e6, dy);
      expect(Math.abs(camera.yaw)).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(camera.pitch)).toBeLessThan(Math.PI / 2);
      const { forward, right, up } = cameraBasis(camera);
      for (const axis of [forward, right, up]) expect(Math.hypot(...axis)).toBeCloseTo(1);
      expect(dot3(forward, right)).toBeCloseTo(0);
      expect(dot3(forward, up)).toBeCloseTo(0);
      expect(dot3(right, up)).toBeCloseTo(0);
    }
  });

  it.each(['perspective', 'orthographic'] as const)('pans in screen space with constant target-plane scale in %s', projection => {
    const camera = setCameraProjection(createCamera3d(), projection);
    const moved = panCamera(camera, 60, 25, 600);
    const screen = projectToScreen(moved, camera.target, 800, 600)!;
    expect(screen.x).toBeCloseTo(460);
    expect(screen.y).toBeCloseTo(325);
    expect(moved.distance).toBe(camera.distance);
    expect(moved.yaw).toBe(camera.yaw);
    expect(camera.target).toEqual([0, 1.15, 0]);
  });

  it('zooms both projections with finite bounded distances', () => {
    for (const projection of ['perspective', 'orthographic'] as const) {
      const camera = setCameraProjection(createCamera3d(), projection);
      const zoomed = zoomCamera(camera, -120);
      expect(zoomed.distance).toBeLessThan(camera.distance);
      expect(zoomed.target).toEqual(camera.target);
      let small = camera, large = camera;
      for (let i = 0; i < 50; i++) { small = zoomCamera(small, -1e10); large = zoomCamera(large, 1e10); }
      expect(small.distance).toBe(0.25);
      expect(large.distance).toBe(250);
    }
  });

  it('ignores invalid gesture deltas and zero-height viewports', () => {
    const camera = createCamera3d();
    expect(orbitCamera(camera, NaN, 0)).toBe(camera);
    expect(panCamera(camera, 2, 3, 0)).toBe(camera);
    expect(panCamera(camera, Infinity, 3, 600)).toBe(camera);
    expect(zoomCamera(camera, Infinity)).toBe(camera);
    expect(cameraRay(camera, 0, 0, 0, 0)).toBeNull();
    expect(cameraRay(camera, -1, 0, 800, 600)).toBeNull();
    expect(cameraRay(camera, NaN, 0, 800, 600)).toBeNull();
  });

  it('switches projection without a target-plane scale jump', () => {
    const camera = createCamera3d(), { right, up } = cameraBasis(camera);
    const point = add3(camera.target, add3(scale3(right, 2), scale3(up, 0.7)));
    const a = projectToScreen(camera, point, 800, 600)!;
    const b = projectToScreen(setCameraProjection(camera, 'orthographic'), point, 800, 600)!;
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });

  it.each(['perspective', 'orthographic'] as const)('maps near/far to clip bounds and agrees with screen projection in %s', projection => {
    const camera = setCameraProjection(createCamera3d(), projection), { eye, forward } = cameraBasis(camera);
    const matrices = cameraMatrices(camera, 800 / 600);
    const viewEye = transform(matrices.view, eye);
    expectVector([viewEye[0], viewEye[1], viewEye[2]], [0, 0, 0], 5);
    const viewTarget = transform(matrices.view, camera.target);
    expectVector([viewTarget[0], viewTarget[1], viewTarget[2]], [0, 0, -camera.distance], 5);
    for (const [depth, expected] of [[camera.near, -1], [camera.far, 1]]) {
      const clip = transform(matrices.projection, [0, 0, -depth!]);
      expect(clip[2] / clip[3]).toBeCloseTo(expected!, 5);
    }
    const point = add3(camera.target, [0.5, 0.2, 0.3]);
    const clip = transform(matrices.viewProjection, point), screen = projectToScreen(camera, point, 800, 600)!;
    expect((clip[0] / clip[3] + 1) * 400).toBeCloseTo(screen.x, 4);
    expect((1 - clip[1] / clip[3]) * 300).toBeCloseTo(screen.y, 4);
    const ray = cameraRay(camera, 400, 300, 800, 600)!;
    expectVector(ray.direction, forward);
    expectVector(ray.origin, add3(eye, scale3(forward, camera.near)));
  });

  it.each(['perspective', 'orthographic'] as const)('fits the entire scene for wide and tall %s viewports', projection => {
    const bounds = meshBounds(createDemoMeshes());
    for (const aspect of [0.35, 1, 3.1]) {
      const camera = fitCamera(setCameraProjection(orbitCamera(createCamera3d(), 100, 80), projection), bounds, aspect);
      for (const point of corners(bounds)) expect(projectToScreen(camera, point, aspect * 600, 600)!.visible).toBe(true);
    }
  });

  it('perspective rays diverge while orthographic rays stay parallel', () => {
    const camera = frontCamera();
    const left = cameraRay(camera, 0, 300, 800, 600)!, right = cameraRay(camera, 800, 300, 800, 600)!;
    expect(left.direction[0]).toBeLessThan(0);
    expect(right.direction[0]).toBeGreaterThan(0);
    const ortho = setCameraProjection(camera, 'orthographic');
    const a = cameraRay(ortho, 0, 300, 800, 600)!, b = cameraRay(ortho, 800, 300, 800, 600)!;
    expectVector(a.direction, b.direction);
    expect(a.origin[0]).toBeLessThan(b.origin[0]);
  });
});

describe('nearest triangle picking', () => {
  it.each(['perspective', 'orthographic'] as const)('picks each visible demo solid after orbit/pan/zoom in %s', projection => {
    const meshes = createDemoMeshes();
    let camera = fitCamera(setCameraProjection(createCamera3d(), projection), meshBounds(meshes), 4 / 3);
    camera = zoomCamera(panCamera(orbitCamera(camera, 12, 8), 8, -4, 600), -30);
    for (const m of meshes) {
      const point = scale3(add3(m.bounds.min, m.bounds.max), 0.5);
      const screen = projectToScreen(camera, point, 800, 600)!;
      expect(screen.visible).toBe(true);
      const hit = pickMeshes(meshes, cameraRay(camera, screen.x, screen.y, 800, 600));
      expect(hit?.id).toBe(m.id);
      expect(hit!.distance).toBeGreaterThan(0);
    }
  });

  it('chooses the nearest surface regardless of scene order or non-unit input direction', () => {
    const near = { ...createBox([0, 0, 4]), id: 'near' }, far = { ...createBox([0, 0, 0]), id: 'far' };
    const ray = { origin: [0, 0, 10] as Vec3, direction: [0, 0, -7] as Vec3 };
    for (const meshes of [[far, near], [near, far]]) {
      const hit = pickMeshes(meshes, ray)!;
      expect(hit.id).toBe('near');
      expect(hit.distance).toBeCloseTo(5);
      expectVector(hit.point, [0, 0, 5]);
    }
  });

  it('rejects bounding-box false positives on sphere corners and cylinder corners', () => {
    const sphere = createSphere([0, 0, 0], 1), cylinder = createCylinder([0, 0, 0], 1, 2);
    const fromFront = { origin: [0.95, 0.95, 5] as Vec3, direction: [0, 0, -1] as Vec3 };
    expect(pickMeshes([sphere], fromFront)).toBeNull();
    const fromAbove = { origin: [0.95, 5, 0.95] as Vec3, direction: [0, -1, 0] as Vec3 };
    expect(pickMeshes([cylinder], fromAbove)).toBeNull();
  });

  it('hits cylinder caps, sides, sphere surfaces, and the exit surface from inside a solid', () => {
    const cylinder = createCylinder([0, 0, 0], 1, 2), sphere = createSphere([0, 0, 0], 1);
    const top = pickMeshes([cylinder], { origin: [0, 5, 0], direction: [0, -1, 0] })!;
    expectVector(top.point, [0, 1, 0]);
    const side = pickMeshes([cylinder], { origin: [5, 0, 0], direction: [-1, 0, 0] })!;
    expectVector(side.point, [1, 0, 0]);
    const front = pickMeshes([sphere], { origin: [0, 0, 5], direction: [0, 0, -1] })!;
    expectVector(front.point, [0, 0, 1]);
    const inside = pickMeshes([createBox([0, 0, 0])], { origin: [0, 0, 0], direction: [1, 0, 0] })!;
    expectVector(inside.point, [1, 0, 0]);
  });

  it('honors near/far clipping and rejects surfaces behind the ray', () => {
    const box = createBox([0, 0, 0]);
    expect(pickMeshes([box], { origin: [0, 0, 5], direction: [0, 0, 1] })).toBeNull();
    expect(pickMeshes([box], { origin: [0, 0, 5], direction: [0, 0, -1], maxDistance: 3 })).toBeNull();
    expect(pickMeshes([box], { origin: [0, 0, 5], direction: [0, 0, -1], minDistance: 7 })).toBeNull();
    const camera = { ...frontCamera(), near: 2, far: 4 };
    const ray = cameraRay(camera, 400, 300, 800, 600);
    expect(pickMeshes([createBox([0, 0, 10], [1, 1, 1]), createBox([0, 0, 0])], ray)).toBeNull();
  });

  it('includes shared edges, rejects parallel/degenerate triangles and invalid rays', () => {
    const ray = { origin: [0.5, 0.5, 1] as Vec3, direction: [0, 0, -1] as Vec3 };
    const a: Vec3 = [0, 0, 0], b: Vec3 = [1, 0, 0], c: Vec3 = [0, 1, 0];
    expect(intersectTriangle(ray, a, b, c)).toBeCloseTo(1);
    expect(intersectTriangle({ ...ray, direction: [1, 0, 0] }, a, b, c)).toBeNull();
    expect(intersectTriangle(ray, a, a, a)).toBeNull();
    expect(pickMeshes(createDemoMeshes(), null)).toBeNull();
    expect(pickMeshes(createDemoMeshes(), { ...ray, direction: [0, 0, 0] })).toBeNull();
    expect(pickMeshes(createDemoMeshes(), { ...ray, origin: [NaN, 0, 0] })).toBeNull();
  });

  it('uses the tessellated surface rather than an analytic bounding sphere', () => {
    const coarse = createSphere([0, 0, 0], 1, 4, 2);
    const hit = pickMeshes([coarse], { origin: [0.4, 0.4, 5], direction: [0, 0, -1] })!;
    // This octahedron's front face is x + y + z = 1.
    expectVector(hit.point, [0.4, 0.4, 0.2]);
  });

  it('clears selection on empty scene space', () => {
    const camera = fitCamera(createCamera3d(), meshBounds(createDemoMeshes()), 4 / 3);
    expect(pickMeshes(createDemoMeshes(), cameraRay(camera, 0, 0, 800, 600))).toBeNull();
    expect(pickMeshes([] as Mesh3d[], cameraRay(camera, 400, 300, 800, 600))).toBeNull();
  });
});
