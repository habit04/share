import type { Point } from './geometry';

/** Full native camera data is retained even while the editor renders planar views. */
export interface NativeViewCamera {
  readonly displayCenter: Point;
  readonly direction: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  readonly width: number;
  readonly twist: number;
  readonly lensLength: number;
  readonly frontClip: number;
  readonly backClip: number;
  readonly mode: number;
  readonly flags: number;
}

/** A top-view camera can be shown by the current 2D editor without approximation. */
export function planarNamedCamera(camera: NativeViewCamera): boolean {
  const { direction: d } = camera;
  return d.z > 0 && Math.abs(d.x / d.z) < 1e-9 && Math.abs(d.y / d.z) < 1e-9 && !(camera.mode & 1);
}

export function namedCameraCenter(camera: NativeViewCamera): Point {
  const { x, y } = camera.displayCenter, c = Math.cos(camera.twist), s = Math.sin(camera.twist);
  return { x: camera.target.x + x * c + y * s, y: camera.target.y - x * s + y * c };
}

export function namedCameraDisplayCenter(camera: NativeViewCamera, center: Point): Point {
  const x = center.x - camera.target.x, y = center.y - camera.target.y, c = Math.cos(camera.twist), s = Math.sin(camera.twist);
  return { x: x * c - y * s, y: x * s + y * c };
}
