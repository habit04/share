/**
 * Camera3D: the orbit camera of the experimental 3D viewport, as plain data plus pure functions.
 *
 * Conventions (see src/model3d/math.ts for the shared ones):
 * - World = AutoCAD WCS: right-handed, X right, Y up and Z toward the viewer in the plan (top) view.
 * - The camera orbits `target` at `distance`. `yaw` is the azimuth of the eye seen from the target,
 *   measured counter-clockwise from +X in the XY plane; `pitch` is its elevation above the XY plane
 *   (+PI/2 = straight above, looking down -Z). The eye direction from the target is
 *   (cos p cos y, cos p sin y, sin p).
 * - The screen "up" vector is the derivative of the eye direction with respect to pitch, so it is
 *   defined at every pitch including the poles: the top view (yaw -PI/2, pitch PI/2) has +Y up and +X
 *   right on screen, exactly like the 2D viewport with twist 0. Pitch is clamped to [-PI/2, PI/2],
 *   so orbiting never flips the view over the pole.
 * - Screen coordinates are CSS pixels with the origin top-left and y down (like the 2D viewport).
 * - `orthoHeight` is the visible world height in the orthographic projection; `fovY` the full
 *   vertical field of view (radians) of the perspective projection. Zooming scales both
 *   `orthoHeight` and `distance`, so switching projection keeps roughly the same framing.
 * - All functions return new cameras and never mutate their inputs.
 */
import {
  type Aabb, type Mat4, type Ray, type Vec3,
  add3, cross3, dot3, intersectRayPlane, len3, mat4LookAt, mat4Orthographic, mat4Perspective, normalize3, scale3, sub3, v3,
} from '../model3d/math';

export type Projection = 'orthographic' | 'perspective';

/** Orbit camera state (plain data; safe to copy, compare and store). */
export interface Camera3D {
  readonly target: Vec3;
  /** Eye distance from the target in drawing units (> 0). */
  readonly distance: number;
  /** Azimuth of the eye around the target (radians, CCW from +X). */
  readonly yaw: number;
  /** Elevation of the eye above the target's XY plane (radians, clamped to [-PI/2, PI/2]). */
  readonly pitch: number;
  readonly projection: Projection;
  /** Perspective vertical field of view in radians. */
  readonly fovY: number;
  /** Orthographic visible height in drawing units. */
  readonly orthoHeight: number;
}

/** Orthonormal camera frame in world coordinates: `forward` looks from the eye toward the target. */
export interface CameraBasis {
  readonly eye: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

const HALF_PI = Math.PI / 2;
/** Default perspective field of view (40 degrees, a moderate lens). */
export const DEFAULT_FOV = (40 * Math.PI) / 180;
/** Zoom limits for `orthoHeight` / `distance` (drawing units), like the 2D viewport's scale clamp. */
export const MIN_VIEW_SIZE = 1e-6;
export const MAX_VIEW_SIZE = 1e9;

/** The named views of AutoCAD's VIEW / ViewCube, as orbit angles. */
export interface ViewPreset {
  readonly label: string;
  readonly yaw: number;
  readonly pitch: number;
}

const ISO_PITCH = Math.asin(1 / Math.sqrt(3));

/**
 * AutoCAD's named views. `top` matches the 2D plan view (+X right, +Y up). The isometric views
 * look from the named compass octant: SW isometric looks from (-1, -1, 1) toward the target.
 */
export const VIEW_PRESETS = {
  top: { label: 'Top', yaw: -HALF_PI, pitch: HALF_PI },
  bottom: { label: 'Bottom', yaw: HALF_PI, pitch: -HALF_PI },
  front: { label: 'Front', yaw: -HALF_PI, pitch: 0 },
  back: { label: 'Back', yaw: HALF_PI, pitch: 0 },
  left: { label: 'Left', yaw: Math.PI, pitch: 0 },
  right: { label: 'Right', yaw: 0, pitch: 0 },
  swIso: { label: 'SW Isometric', yaw: (-3 * Math.PI) / 4, pitch: ISO_PITCH },
  seIso: { label: 'SE Isometric', yaw: -Math.PI / 4, pitch: ISO_PITCH },
  neIso: { label: 'NE Isometric', yaw: Math.PI / 4, pitch: ISO_PITCH },
  nwIso: { label: 'NW Isometric', yaw: (3 * Math.PI) / 4, pitch: ISO_PITCH },
} as const satisfies Record<string, ViewPreset>;

export type ViewPresetName = keyof typeof VIEW_PRESETS;

/** Preset name for user input ("swiso", "SW", "top", case-insensitive), or null. */
export function parseViewPreset(text: string): ViewPresetName | null {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const alias: Record<string, ViewPresetName> = { sw: 'swIso', se: 'seIso', ne: 'neIso', nw: 'nwIso', plan: 'top' };
  if (alias[t]) return alias[t];
  for (const name of Object.keys(VIEW_PRESETS) as ViewPresetName[]) if (name.toLowerCase() === t || name.toLowerCase() === `${t}iso`) return name;
  return null;
}

/** The preset the camera currently matches (angles within 1e-6), or null for a free orbit. */
export function matchingPreset(cam: Camera3D): ViewPresetName | null {
  for (const [name, p] of Object.entries(VIEW_PRESETS) as [ViewPresetName, ViewPreset][]) {
    if (Math.abs(cam.pitch - p.pitch) > 1e-6) continue;
    // At the poles only the yaw that gives the same screen orientation counts.
    if (Math.abs(wrapAngle(cam.yaw - p.yaw)) <= 1e-6) return name;
  }
  return null;
}

function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** A top-view orthographic camera looking at `target` with `orthoHeight` visible units. */
export function defaultCamera(target: Vec3 = v3(0, 0, 0), orthoHeight = 10): Camera3D {
  const h = clampSize(orthoHeight);
  return { target, distance: h / (2 * Math.tan(DEFAULT_FOV / 2)), yaw: VIEW_PRESETS.top.yaw, pitch: VIEW_PRESETS.top.pitch, projection: 'orthographic', fovY: DEFAULT_FOV, orthoHeight: h };
}

/**
 * The top-view camera that shows exactly what a 2D viewport with this centre, scale (px per unit),
 * pixel height and twist shows on the z = 0 plane. A positive twist rotates the content
 * counter-clockwise on screen, as in `Viewport.toScreen`.
 */
export function cameraFrom2D(center: { x: number; y: number }, scale: number, heightPx: number, twist = 0): Camera3D {
  const cam = defaultCamera(v3(center.x, center.y, 0), heightPx / scale);
  return { ...cam, yaw: VIEW_PRESETS.top.yaw - twist };
}

function clampSize(v: number): number {
  return Number.isFinite(v) ? Math.min(MAX_VIEW_SIZE, Math.max(MIN_VIEW_SIZE, v)) : 1;
}

/** Unit vector from the target toward the eye. */
export function eyeDirection(cam: Camera3D): Vec3 {
  const cp = Math.cos(cam.pitch);
  return v3(cp * Math.cos(cam.yaw), cp * Math.sin(cam.yaw), Math.sin(cam.pitch));
}

/** Eye position in world coordinates. */
export function cameraEye(cam: Camera3D): Vec3 {
  return add3(cam.target, scale3(eyeDirection(cam), cam.distance));
}

/** Eye, forward, right and up vectors (orthonormal, right-handed: right = forward x up). */
export function cameraBasis(cam: Camera3D): CameraBasis {
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch), sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
  const back = v3(cp * cy, cp * sy, sp);
  const up = v3(-sp * cy, -sp * sy, cp);
  const forward = scale3(back, -1);
  return { eye: add3(cam.target, scale3(back, cam.distance)), forward, right: cross3(forward, up), up };
}

/** View matrix (world to view space; the camera looks down view -Z). */
export function cameraView(cam: Camera3D): Mat4 {
  const b = cameraBasis(cam);
  return mat4LookAt(b.eye, cam.target, b.up);
}

/**
 * View matrix for positions given relative to `origin` (that is, world point p is passed as
 * p - origin). The renderer uses it with origin = target so float32 vertex data stays precise for
 * drawings far from the world origin.
 */
export function cameraViewRelative(cam: Camera3D, origin: Vec3): Mat4 {
  const b = cameraBasis(cam);
  return mat4LookAt(sub3(b.eye, origin), sub3(cam.target, origin), b.up);
}

/** Visible world height at the target depth (ortho: `orthoHeight`; perspective: from the fov). */
export function viewHeightAtTarget(cam: Camera3D): number {
  return cam.projection === 'orthographic' ? cam.orthoHeight : 2 * cam.distance * Math.tan(cam.fovY / 2);
}

/** Projection matrix (WebGL clip space). `near` / `far` are distances along the view direction. */
export function cameraProjection(cam: Camera3D, aspect: number, near: number, far: number): Mat4 {
  if (cam.projection === 'perspective') return mat4Perspective(cam.fovY, aspect, near, far);
  const hh = cam.orthoHeight / 2, hw = hh * aspect;
  return mat4Orthographic(-hw, hw, -hh, hh, near, far);
}

/** Orbit by yaw / pitch increments (radians); distance and target are kept, pitch is clamped. */
export function orbit(cam: Camera3D, dYaw: number, dPitch: number): Camera3D {
  const pitch = Math.min(HALF_PI, Math.max(-HALF_PI, cam.pitch + dPitch));
  return { ...cam, yaw: wrapAngle(cam.yaw + dYaw), pitch };
}

/** Apply a named view (orientation only; target, distance and zoom are kept). */
export function applyPreset(cam: Camera3D, name: ViewPresetName): Camera3D {
  const p = VIEW_PRESETS[name];
  return { ...cam, yaw: p.yaw, pitch: p.pitch };
}

/**
 * Pan by a cursor drag of (dx, dy) CSS pixels: the content under the cursor follows it. The target
 * moves in the view plane by the world distance the pixels represent at the target depth.
 */
export function pan(cam: Camera3D, dxPixels: number, dyPixels: number, viewportHeightPx: number): Camera3D {
  if (!(viewportHeightPx > 0)) return cam;
  const wpp = viewHeightAtTarget(cam) / viewportHeightPx;
  const b = cameraBasis(cam);
  const move = add3(scale3(b.right, -dxPixels * wpp), scale3(b.up, dyPixels * wpp));
  return { ...cam, target: add3(cam.target, move) };
}

/**
 * Zoom in by `factor` (> 1 zooms in, < 1 out). With `anchorRay` (the ray under the cursor) the
 * point where that ray meets the plane through the target facing the camera stays under the
 * cursor: the camera is scaled about that point (exact for both projections).
 */
export function zoom(cam: Camera3D, factor: number, anchorRay?: Ray): Camera3D {
  if (!(factor > 0) || !Number.isFinite(factor)) return cam;
  const orthoHeight = clampSize(cam.orthoHeight / factor);
  const distance = clampSize(cam.distance / factor);
  // The factor actually applied after clamping (perspective zoom is driven by the distance).
  const applied = cam.projection === 'perspective' ? cam.distance / distance : cam.orthoHeight / orthoHeight;
  let target = cam.target;
  if (anchorRay) {
    const t = intersectRayPlane(anchorRay, { origin: cam.target, normal: eyeDirection(cam) });
    if (t !== null) {
      const p = add3(anchorRay.origin, scale3(anchorRay.dir, t));
      target = add3(p, scale3(sub3(cam.target, p), 1 / applied));
    }
  }
  return { ...cam, target, orthoHeight, distance };
}

/** Switch projection keeping the framing at the target depth. */
export function setProjection(cam: Camera3D, projection: Projection): Camera3D {
  if (cam.projection === projection) return cam;
  const tan = Math.tan(cam.fovY / 2);
  if (projection === 'perspective') return { ...cam, projection, distance: clampSize(cam.orthoHeight / (2 * tan)) };
  return { ...cam, projection, orthoHeight: clampSize(2 * cam.distance * tan) };
}

/**
 * Frame `box` in the current view direction with a relative `margin` on every side. Null or empty
 * boxes leave the camera unchanged. The eye ends up outside the box in both projections.
 */
export function zoomToBounds(cam: Camera3D, box: Aabb | null, aspect: number, margin = 0.08): Camera3D {
  if (!box) return cam;
  const b = cameraBasis(cam);
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, minF = Infinity, maxF = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const r = dot3(p, b.right), u = dot3(p, b.up), f = dot3(p, b.forward);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minF = Math.min(minF, f); maxF = Math.max(maxF, f);
  }
  if (![minR, maxR, minU, maxU, minF, maxF].every(Number.isFinite)) return cam;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const w = Math.max(maxR - minR, 1e-3), h = Math.max(maxU - minU, 1e-3);
  const orthoHeight = clampSize(Math.max(h, w / a) * (1 + 2 * margin));
  const midF = (minF + maxF) / 2;
  const target = add3(add3(scale3(b.right, (minR + maxR) / 2), scale3(b.up, (minU + maxU) / 2)), scale3(b.forward, midF));
  const tan = Math.tan(cam.fovY / 2);
  const depthHalf = (maxF - minF) / 2;
  // Perspective: the box's view-plane extent fits at its nearest depth; ortho keeps the eye outside.
  const distance = clampSize(orthoHeight / (2 * tan) + depthHalf);
  return { ...cam, target, orthoHeight, distance };
}

/**
 * The same camera with the eye far enough back that every point of `box` lies in front of it.
 * Only orthographic cameras are changed (their image does not depend on the distance); call it
 * before rendering or picking so nothing sits behind the ortho eye plane.
 */
export function withOrthoClearance(cam: Camera3D, box: Aabb | null): Camera3D {
  if (cam.projection !== 'orthographic' || !box) return cam;
  const back = eyeDirection(cam);
  let need = 0;
  for (let i = 0; i < 8; i++) {
    const p = v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    need = Math.max(need, dot3(sub3(p, cam.target), back));
  }
  const want = need + Math.max(cam.orthoHeight, 1e-3);
  return want > cam.distance && Number.isFinite(want) ? { ...cam, distance: clampSize(want) } : cam;
}

/**
 * Near / far clip distances that contain `box` (falls back to a range around the target). The
 * perspective near plane is kept at least far / 1e5 so the depth buffer keeps its precision.
 */
export function clipRange(cam: Camera3D, box: Aabb | null): { near: number; far: number } {
  const b = cameraBasis(cam);
  let lo = Infinity, hi = -Infinity;
  if (box) {
    for (let i = 0; i < 8; i++) {
      const p = v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const d = dot3(sub3(p, b.eye), b.forward);
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
  }
  if (!(lo <= hi)) { lo = cam.distance * 0.5; hi = cam.distance * 2; }
  const pad = Math.max((hi - lo) * 0.01, viewHeightAtTarget(cam) * 1e-3, 1e-6);
  let near = lo - pad, far = hi + pad;
  if (cam.projection === 'perspective') {
    far = Math.max(far, cam.distance * 1e-3);
    near = Math.max(near, far / 1e5);
  }
  return { near, far };
}

/**
 * The picking ray through screen point (sx, sy) of a width x height CSS-pixel viewport. The
 * direction is unit length, so hit parameters are distances. Perspective rays start at the eye;
 * orthographic rays start on the eye plane (see `withOrthoClearance`) and run along `forward`.
 */
export function rayFromScreen(cam: Camera3D, sx: number, sy: number, width: number, height: number): Ray {
  const b = cameraBasis(cam);
  const h = Math.max(height, 1), w = Math.max(width, 1);
  const ny = 1 - (2 * sy) / h, nx = (2 * sx) / w - 1;
  const halfH = viewHeightAtTarget(cam) / 2, halfW = halfH * (w / h);
  if (cam.projection === 'orthographic') {
    const origin = add3(b.eye, add3(scale3(b.right, nx * halfW), scale3(b.up, ny * halfH)));
    return { origin, dir: b.forward };
  }
  // A point on the target plane under the cursor, seen from the eye.
  const onPlane = add3(cam.target, add3(scale3(b.right, nx * halfW), scale3(b.up, ny * halfH)));
  const dir = normalize3(sub3(onPlane, b.eye));
  return { origin: b.eye, dir: len3(dir) > 0 ? dir : b.forward };
}

/**
 * Screen position (CSS px, y down) of world point `p`, with `depth` = its distance in front of the
 * eye along the view direction. Null when a perspective camera has the point at or behind the eye.
 */
export function projectToScreen(cam: Camera3D, p: Vec3, width: number, height: number): { x: number; y: number; depth: number } | null {
  const b = cameraBasis(cam);
  const d = sub3(p, b.eye);
  const vx = dot3(d, b.right), vy = dot3(d, b.up), depth = dot3(d, b.forward);
  let ppu: number;
  if (cam.projection === 'orthographic') ppu = height / cam.orthoHeight;
  else {
    if (!(depth > 1e-12)) return null;
    ppu = height / (2 * depth * Math.tan(cam.fovY / 2));
  }
  return { x: width / 2 + vx * ppu, y: height / 2 - vy * ppu, depth };
}
