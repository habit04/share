/** Standalone, Y-up camera math. Matrices use WebGL column-major order. */
export type Vec3 = readonly [number, number, number];
export type Projection3d = 'perspective' | 'orthographic';
export interface Bounds3d { min: Vec3; max: Vec3 }
export interface Ray3d {
  origin: Vec3;
  direction: Vec3;
  /** Distances in world units, measured from origin along a unit direction. */
  minDistance?: number;
  maxDistance?: number;
}
export interface Camera3d {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  projection: Projection3d;
  fov: number;
  near: number;
  far: number;
}

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export function normalize3(a: Vec3): Vec3 {
  const length = Math.hypot(...a);
  return length > 0 && Number.isFinite(length) ? scale3(a, 1 / length) : [0, 0, 0];
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const aspectRatio = (aspect: number) => Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
const validSize = (width: number, height: number) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

export function createCamera3d(): Camera3d {
  return { target: [0, 1.15, 0], yaw: 0.45, pitch: 0.42, distance: 13,
    projection: 'perspective', fov: Math.PI / 4, near: 0.05, far: 1000 };
}

export function cameraBasis(camera: Camera3d): { eye: Vec3; forward: Vec3; right: Vec3; up: Vec3 } {
  const offset: Vec3 = [Math.sin(camera.yaw) * Math.cos(camera.pitch), Math.sin(camera.pitch), Math.cos(camera.yaw) * Math.cos(camera.pitch)];
  const eye = add3(camera.target, scale3(offset, camera.distance));
  const forward = scale3(offset, -1);
  const right = normalize3(cross3(forward, [0, 1, 0]));
  return { eye, forward, right, up: cross3(right, forward) };
}

/** Pixel deltas; returns a new camera, leaving the input untouched. */
export function orbitCamera(camera: Camera3d, dx: number, dy: number): Camera3d {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return camera;
  const yaw = camera.yaw - dx * 0.008;
  return { ...camera, yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
    pitch: clamp(camera.pitch + dy * 0.008, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02) };
}

export function panCamera(camera: Camera3d, dx: number, dy: number, viewportHeight: number): Camera3d {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return camera;
  const { right, up } = cameraBasis(camera);
  const units = 2 * camera.distance * Math.tan(camera.fov / 2) / viewportHeight;
  return { ...camera, target: add3(camera.target, add3(scale3(right, -dx * units), scale3(up, dy * units))) };
}

export function zoomCamera(camera: Camera3d, wheelPixels: number): Camera3d {
  if (!Number.isFinite(wheelPixels)) return camera;
  return { ...camera, distance: clamp(camera.distance * Math.exp(clamp(wheelPixels * 0.0015, -4, 4)), 0.25, 250) };
}

/** Both projections have the same vertical span at the target plane. */
export function setCameraProjection(camera: Camera3d, projection: Projection3d): Camera3d {
  return { ...camera, projection };
}

export function fitCamera(camera: Camera3d, bounds: Bounds3d, aspect = 1): Camera3d {
  const target = scale3(add3(bounds.min, bounds.max), 0.5);
  const radius = Math.max(0.1, Math.hypot(...sub3(bounds.max, bounds.min)) / 2);
  const halfFov = camera.fov / 2;
  const halfAngle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspectRatio(aspect)));
  const distance = camera.projection === 'perspective'
    ? radius / Math.sin(halfAngle) * 1.12
    : radius / (Math.tan(halfFov) * Math.min(1, aspectRatio(aspect))) * 1.12;
  return { ...camera, target, distance };
}

export function perspectiveMatrix(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspectRatio(aspect), 0, 0, 0, 0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0,
  ]);
}

export function orthographicMatrix(height: number, aspect: number, near: number, far: number): Float32Array {
  return new Float32Array([
    2 / (height * aspectRatio(aspect)), 0, 0, 0, 0, 2 / height, 0, 0,
    0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1,
  ]);
}

export function viewMatrix(camera: Camera3d): Float32Array {
  const { eye, forward: f, right: r, up: u } = cameraBasis(camera);
  return new Float32Array([
    r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0,
    -dot3(r, eye), -dot3(u, eye), dot3(f, eye), 1,
  ]);
}

export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
    out[col * 4 + row] = sum;
  }
  return out;
}

export function cameraMatrices(camera: Camera3d, aspect: number): { view: Float32Array; projection: Float32Array; viewProjection: Float32Array } {
  const view = viewMatrix(camera);
  const projection = camera.projection === 'perspective'
    ? perspectiveMatrix(camera.fov, aspect, camera.near, camera.far)
    : orthographicMatrix(2 * camera.distance * Math.tan(camera.fov / 2), aspect, camera.near, camera.far);
  return { view, projection, viewProjection: multiplyMatrices(projection, view) };
}

/** CSS pixel coordinates, with (0, 0) at the canvas's upper left. Starts at the near plane. */
export function cameraRay(camera: Camera3d, x: number, y: number, width: number, height: number): Ray3d | null {
  if (!validSize(width, height) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) return null;
  const { eye, forward, right, up } = cameraBasis(camera);
  const halfHeight = (camera.projection === 'perspective' ? camera.near : camera.distance) * Math.tan(camera.fov / 2);
  const offset = add3(scale3(right, (2 * x / width - 1) * halfHeight * width / height), scale3(up, (1 - 2 * y / height) * halfHeight));
  const origin = add3(add3(eye, scale3(forward, camera.near)), offset);
  const direction = camera.projection === 'perspective' ? normalize3(sub3(origin, eye)) : forward;
  return { origin, direction, minDistance: 0, maxDistance: (camera.far - camera.near) / dot3(direction, forward) };
}

export function projectToScreen(camera: Camera3d, point: Vec3, width: number, height: number): { x: number; y: number; depth: number; visible: boolean } | null {
  if (!validSize(width, height)) return null;
  const { eye, right, up, forward } = cameraBasis(camera);
  const offset = sub3(point, eye);
  const depth = dot3(offset, forward);
  const halfHeight = (camera.projection === 'perspective' ? depth : camera.distance) * Math.tan(camera.fov / 2);
  if (halfHeight <= 0) return null;
  const nx = dot3(offset, right) / (halfHeight * width / height);
  const ny = dot3(offset, up) / halfHeight;
  return { x: (nx + 1) * width / 2, y: (1 - ny) * height / 2, depth,
    visible: depth >= camera.near && depth <= camera.far && Math.abs(nx) <= 1 && Math.abs(ny) <= 1 };
}
