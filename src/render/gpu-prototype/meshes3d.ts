import { add3, cross3, dot3, normalize3, scale3, sub3, type Bounds3d, type Ray3d, type Vec3 } from './camera3d';

/** Fixed demo geometry only; positions are already in world space. */
export interface Mesh3d {
  id: string;
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
  color: Vec3;
  bounds: Bounds3d;
}
export interface Pick3d { id: string; name: string; distance: number; point: Vec3; triangleIndex: number }

function mesh(id: string, name: string, positions: number[], normals: number[], indices: number[], color: Vec3): Mesh3d {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const vertices = new Float32Array(positions);
  for (let i = 0; i < vertices.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis]!, vertices[i]!);
    max[axis] = Math.max(max[axis]!, vertices[i]!);
  }
  return { id, name, positions: vertices, normals: new Float32Array(normals), indices: new Uint16Array(indices), color, bounds: { min, max } };
}
function positive(n: number): void {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError('Mesh dimensions must be finite and positive.');
}
function segmentCount(n: number, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`Mesh subdivisions must be between ${min} and ${max}.`);
}
function centerValid(center: Vec3): void {
  if (!center.every(Number.isFinite)) throw new RangeError('Mesh center must be finite.');
}

export function createBox(center: Vec3 = [-3, 1, 0], size: Vec3 = [2, 2, 2]): Mesh3d {
  centerValid(center);
  size.forEach(positive);
  const p: number[] = [], n: number[] = [], indices: number[] = [];
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [normal, u, v] of faces) {
    const base = p.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.push(...add3(center, [
        (normal[0] + u[0] * a! + v[0] * b!) * size[0] / 2,
        (normal[1] + u[1] * a! + v[1] * b!) * size[1] / 2,
        (normal[2] + u[2] * a! + v[2] * b!) * size[2] / 2,
      ]));
      n.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh('box', 'Box', p, n, indices, [0.28, 0.62, 0.95]);
}

export function createSphere(center: Vec3 = [0, 1.15, 0], radius = 1.15, segments = 32, rings = 20): Mesh3d {
  centerValid(center);
  positive(radius);
  segmentCount(segments, 3, 128);
  segmentCount(rings, 2, 128);
  const p: number[] = [], n: number[] = [], indices: number[] = [];
  for (let row = 0; row <= rings; row++) {
    const theta = Math.PI * row / rings;
    for (let col = 0; col <= segments; col++) {
      const phi = 2 * Math.PI * col / segments;
      const normal: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      p.push(...add3(center, scale3(normal, radius)));
      n.push(...normal);
    }
  }
  for (let row = 0; row < rings; row++) for (let col = 0; col < segments; col++) {
    const a = row * (segments + 1) + col, b = a + segments + 1;
    // Omit the degenerate triangles at the two poles.
    if (row > 0) indices.push(a, a + 1, b);
    if (row < rings - 1) indices.push(a + 1, b + 1, b);
  }
  return mesh('sphere', 'Sphere', p, n, indices, [0.94, 0.51, 0.24]);
}

export function createCylinder(center: Vec3 = [3, 1.1, 0], radius = 0.9, height = 2.2, segments = 32): Mesh3d {
  centerValid(center);
  positive(radius);
  positive(height);
  segmentCount(segments, 3, 256);
  const p: number[] = [], n: number[] = [], indices: number[] = [];
  for (let col = 0; col <= segments; col++) {
    const phi = col * 2 * Math.PI / segments;
    const normal: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
    for (const y of [-height / 2, height / 2]) {
      p.push(...add3(center, [normal[0] * radius, y, normal[2] * radius]));
      n.push(...normal);
    }
  }
  for (let col = 0; col < segments; col++) {
    const a = col * 2, b = a + 2;
    indices.push(a, a + 1, b + 1, a, b + 1, b);
  }
  for (const sign of [-1, 1]) {
    const base = p.length / 3;
    p.push(...add3(center, [0, sign * height / 2, 0]));
    n.push(0, sign, 0);
    for (let col = 0; col <= segments; col++) {
      const phi = col * 2 * Math.PI / segments;
      p.push(...add3(center, [Math.cos(phi) * radius, sign * height / 2, Math.sin(phi) * radius]));
      n.push(0, sign, 0);
    }
    for (let col = 0; col < segments; col++) {
      const a = base + col + 1, b = a + 1;
      indices.push(base, sign > 0 ? b : a, sign > 0 ? a : b);
    }
  }
  return mesh('cylinder', 'Cylinder', p, n, indices, [0.32, 0.77, 0.55]);
}

export function createDemoMeshes(): Mesh3d[] { return [createBox(), createSphere(), createCylinder()]; }

export function meshBounds(meshes: readonly Mesh3d[]): Bounds3d {
  if (!meshes.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis]!, m.bounds.min[axis]!);
    max[axis] = Math.max(max[axis]!, m.bounds.max[axis]!);
  }
  return { min, max };
}

export function createGrid(extent = 8): Float32Array {
  segmentCount(extent, 1, 100);
  const points: number[] = [];
  for (let i = -extent; i <= extent; i++) {
    points.push(-extent, 0, i, extent, 0, i, i, 0, -extent, i, 0, extent);
  }
  return new Float32Array(points);
}

/** Double-sided Möller–Trumbore intersection, including shared edges. */
export function intersectTriangle(ray: Ray3d, a: Vec3, b: Vec3, c: Vec3): number | null {
  const ab = sub3(b, a), ac = sub3(c, a);
  const p = cross3(ray.direction, ac), det = dot3(ab, p);
  if (Math.abs(det) < 1e-10) return null;
  const t = sub3(ray.origin, a), u = dot3(t, p) / det;
  if (u < -1e-8 || u > 1 + 1e-8) return null;
  const q = cross3(t, ab), v = dot3(ray.direction, q) / det;
  if (v < -1e-8 || u + v > 1 + 1e-8) return null;
  const distance = dot3(ac, q) / det;
  return distance >= (ray.minDistance ?? 0) && distance <= (ray.maxDistance ?? Infinity) ? distance : null;
}

function intersectsBounds(ray: Ray3d, bounds: Bounds3d): boolean {
  let near = ray.minDistance ?? 0, far = ray.maxDistance ?? Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const d = ray.direction[axis]!, o = ray.origin[axis]!;
    if (Math.abs(d) < 1e-12) {
      if (o < bounds.min[axis]! || o > bounds.max[axis]!) return false;
    } else {
      const a = (bounds.min[axis]! - o) / d, b = (bounds.max[axis]! - o) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (far < near) return false;
    }
  }
  return true;
}
const vertex = (m: Mesh3d, index: number): Vec3 => [m.positions[index * 3]!, m.positions[index * 3 + 1]!, m.positions[index * 3 + 2]!];

export function pickMeshes(meshes: readonly Mesh3d[], input: Ray3d | null): Pick3d | null {
  if (!input || !input.origin.every(Number.isFinite) || !input.direction.every(Number.isFinite)) return null;
  const direction = normalize3(input.direction);
  if (!Math.hypot(...direction)) return null;
  const ray = { ...input, direction };
  let hit: Pick3d | null = null;
  for (const m of meshes) {
    if (!intersectsBounds(ray, m.bounds)) continue;
    for (let i = 0; i < m.indices.length; i += 3) {
      const distance = intersectTriangle(ray, vertex(m, m.indices[i]!), vertex(m, m.indices[i + 1]!), vertex(m, m.indices[i + 2]!));
      if (distance === null || (hit && distance >= hit.distance)) continue;
      hit = { id: m.id, name: m.name, distance, point: add3(ray.origin, scale3(direction, distance)), triangleIndex: i / 3 };
    }
  }
  return hit;
}
