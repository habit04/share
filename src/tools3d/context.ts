/**
 * The 3D side of the tool context (experimental, milestone 3 of docs/3D-PLAN.md).
 *
 * `ToolContext` (src/tools/types.ts) has optional 3D members; `extendContext3d` fills them from a
 * `Context3DSource` (the editor's 3D controller in src/app/experimental-3d.ts, or a test helper).
 * 3D tools also work on a plain 2D context: every accessor below falls back to the WCS XY plane.
 *
 * Coordinates: a tool point (`onPoint` / `onMove`, typed "x,y") is a 2D point in the construction
 * plane's own X / Y axes (AutoCAD UCS coordinates). `planeToWorld` maps it to world coordinates
 * (AutoCAD WCS: right-handed, Z toward the viewer, drawing units). Typed "x,y,z" and "@dx,dy,dz"
 * are plane coordinates too (`parsePoint3`). When the point came from a click in the 3D view, the
 * source returns the exact 3D pick (a solid face hit, else the ray / plane intersection) so tools
 * get the real 3D point and cursor ray, not only the 2D coordinates.
 */
import type { Point } from '../core/geometry';
import { parsePointInput } from '../app/input';
import {
  type Frame3, type Ray, type Vec3, WORLD_XY_FRAME, add3, aabbCenter, aabbSize, dot3, len3, normalize3, scale3, sub3, v3,
} from '../model3d/math';
import { model3dBounds, model3dOf } from '../model3d/model';
import type { Model3D, Solid3D } from '../model3d/types';
import type { GeometryKernel } from '../model3d/kernel/kernel';
import { type PickHit, pickSolids } from '../render3d/picking';
import { hiddenLayerNames } from '../render3d/scene-sink';
import type { ToolContext } from '../tools/types';

/** A 3D pick recorded by the 3D view for one tool point (a click or the cursor). */
export interface Pick3 {
  /** The tool point (plane-local 2D coordinates) handed to the tool. */
  readonly p2: Point;
  /** World point: the face hit, else where the ray meets the construction plane. */
  readonly point: Vec3;
  /** The cursor ray. */
  readonly ray: Ray;
  /** The solid face under the cursor, if any. */
  readonly hit: PickHit | null;
}

/** Where `extendContext3d` gets the 3D state from. */
export interface Context3DSource {
  /** Construction plane in effect (WCS XY while 3D mode is off). */
  plane(): Frame3;
  planeName(): string;
  setPlane(frame: Frame3, name: string): void;
  /** The 3D pick recorded for this tool point, if it came from the 3D view. */
  pickAt(p: Point): Pick3 | null;
  /** The kernel (created on first call). */
  kernel(): GeometryKernel;
  setPreview3d(solids: readonly Solid3D[]): void;
}

/** Plane axes by name (AutoCAD UCS orientation: XZ is the Front view plane, YZ the Right one). */
export type PlaneAxes = 'XY' | 'XZ' | 'YZ';

/** A frame with the axes `axes` at `origin` (right-handed, orthonormal). */
export function axesFrame(axes: PlaneAxes, origin: Vec3 = v3(0, 0, 0)): Frame3 {
  switch (axes) {
    case 'XY': return { origin, xAxis: v3(1, 0, 0), yAxis: v3(0, 1, 0), zAxis: v3(0, 0, 1) };
    case 'XZ': return { origin, xAxis: v3(1, 0, 0), yAxis: v3(0, 0, 1), zAxis: v3(0, -1, 0) };
    case 'YZ': return { origin, xAxis: v3(0, 1, 0), yAxis: v3(0, 0, 1), zAxis: v3(1, 0, 0) };
  }
}

/** The frame with the same axes moved to `origin`. */
export function frameAt(frame: Frame3, origin: Vec3): Frame3 {
  return { origin, xAxis: frame.xAxis, yAxis: frame.yAxis, zAxis: frame.zAxis };
}

/** The frame turned upside down about its X axis (keeps it right-handed): Y and Z reversed. */
export function flipFrame(frame: Frame3): Frame3 {
  return { origin: frame.origin, xAxis: frame.xAxis, yAxis: scale3(frame.yAxis, -1), zAxis: scale3(frame.zAxis, -1) };
}

/** The frame turned half a turn about its Z axis: X and Y reversed. */
export function turnFrame(frame: Frame3): Frame3 {
  return { origin: frame.origin, xAxis: scale3(frame.xAxis, -1), yAxis: scale3(frame.yAxis, -1), zAxis: frame.zAxis };
}

/** World point of plane coordinates (x, y, z). */
export function planeToWorld(frame: Frame3, p: Point, z = 0): Vec3 {
  return add3(add3(add3(frame.origin, scale3(frame.xAxis, p.x)), scale3(frame.yAxis, p.y)), scale3(frame.zAxis, z));
}

/** Plane coordinates (x, y, z) of a world point. */
export function worldToPlane(frame: Frame3, q: Vec3): Vec3 {
  const d = sub3(q, frame.origin);
  return v3(dot3(d, frame.xAxis), dot3(d, frame.yAxis), dot3(d, frame.zAxis));
}

/** The construction plane of a context (WCS XY when it has none). */
export function constructionPlaneOf(ctx: ToolContext): Frame3 {
  return ctx.constructionPlane ?? WORLD_XY_FRAME;
}

/** The world point for a tool point: the context's `point3`, else the point on the plane. */
export function point3Of(ctx: ToolContext, p: Point): Vec3 {
  return ctx.point3 ? ctx.point3(p) : planeToWorld(constructionPlaneOf(ctx), p);
}

/** The drawing's 3D model as the context sees it. */
export function solidsOf(ctx: ToolContext): Model3D {
  return ctx.solids ? ctx.solids() : model3dOf(ctx.doc.snapshot);
}

const NUM = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)';
const XYZ = new RegExp(`^(@)?${NUM},${NUM},${NUM}$`, 'i');

/**
 * Typed point input as world coordinates, in construction plane coordinates: "x,y,z", "@dx,dy,dz"
 * (relative to `last`), and the 2D forms the command line accepts ("x,y", "@dx,dy", "d<a",
 * "@d<a"; z = 0 on the plane, or the height of `last` for relative input). Null when it is not a
 * point.
 */
export function parsePoint3(text: string, frame: Frame3, last: Vec3 | null): Vec3 | null {
  const t = text.replace(/\s+/g, '');
  const m = XYZ.exec(t);
  const lastLocal = last ? worldToPlane(frame, last) : v3(0, 0, 0);
  if (m) {
    const x = Number(m[2]), y = Number(m[3]), z = Number(m[4]);
    if (![x, y, z].every(Number.isFinite)) return null;
    return m[1] ? planeToWorld(frame, { x: lastLocal.x + x, y: lastLocal.y + y }, lastLocal.z + z) : planeToWorld(frame, { x, y }, z);
  }
  const p = parsePointInput(t, { x: lastLocal.x, y: lastLocal.y });
  if (!p) return null;
  return planeToWorld(frame, p, t.startsWith('@') ? lastLocal.z : 0);
}

/**
 * Parameter s of the point base + s * dir closest to the ray (the height picked by a cursor ray
 * along an axis), or null when the ray is parallel to the axis.
 */
export function closestOnAxis(base: Vec3, dir: Vec3, ray: Ray): number | null {
  const w0 = sub3(base, ray.origin);
  const a = dot3(dir, dir), b = dot3(dir, ray.dir), c = dot3(ray.dir, ray.dir);
  const d = dot3(dir, w0), e = dot3(ray.dir, w0);
  const denom = a * c - b * b;
  if (!(a > 0 && c > 0) || Math.abs(denom) <= 1e-12 * a * c) return null;
  return (b * e - c * d) / denom;
}

/**
 * Height between two 3D points measured along `normal`: their offset along it, or (both on one
 * plane perpendicular to it) the distance between them.
 */
export function heightBetween(a: Vec3, b: Vec3, normal: Vec3): number {
  const d = sub3(b, a);
  const along = dot3(d, normal);
  if (Math.abs(along) > 1e-9 * Math.max(1, len3(d))) return along;
  return len3(d);
}

/** In-plane distance from `center` to `q` (the plane through `center` parallel to `frame`). */
export function planarDistance(frame: Frame3, center: Vec3, q: Vec3): number {
  const d = sub3(q, center);
  return Math.hypot(dot3(d, frame.xAxis), dot3(d, frame.yAxis));
}

/**
 * The solid face hit when looking down the plane normal at a world point (what a click on a
 * solid's outline in the plan view means), or null.
 */
export function faceBelow(model: Model3D, layers: Parameters<typeof hiddenLayerNames>[0], frame: Frame3, q: Vec3): PickHit | null {
  const box = model3dBounds(model);
  if (!box) return null;
  const reach = len3(aabbSize(box)) + len3(sub3(aabbCenter(box), q)) + 1;
  const n = normalize3(frame.zAxis);
  const ray: Ray = { origin: add3(q, scale3(n, reach)), dir: scale3(n, -1) };
  return pickSolids(model, ray, { hiddenLayers: hiddenLayerNames(layers) })[0] ?? null;
}

/** Display name of a frame for the status bar: name plus the origin when it is not 0,0,0. */
export function planeLabel(name: string, frame: Frame3): string {
  const o = frame.origin;
  if (len3(o) === 0) return name;
  const f = (v: number) => (Math.abs(v) < 1e-12 ? '0' : String(Number(v.toFixed(4))));
  return `${name} @ ${f(o.x)},${f(o.y)},${f(o.z)}`;
}

/** True when two frames have (numerically) the same axes. */
export function sameAxes(a: Frame3, b: Frame3): boolean {
  const near = (u: Vec3, w: Vec3) => len3(sub3(u, w)) < 1e-9;
  return near(a.xAxis, b.xAxis) && near(a.yAxis, b.yAxis) && near(a.zAxis, b.zAxis);
}

/** True when the frame's XY plane is the WCS drawing plane z = 0 (either way up). */
export function isDrawingPlane(frame: Frame3): boolean {
  return Math.abs(Math.abs(frame.zAxis.z) - 1) < 1e-9 && Math.abs(frame.origin.z) < 1e-9;
}

/**
 * Fill the optional 3D members of `ctx` from `src` (returns `ctx`). Plane and kernel are
 * getters, so they are read when used: the kernel is created only by a tool that needs it.
 */
export function extendContext3d(ctx: ToolContext, src: Context3DSource): ToolContext {
  Object.defineProperties(ctx, {
    constructionPlane: { get: () => src.plane(), enumerable: true, configurable: true },
    constructionPlaneName: { get: () => src.planeName(), enumerable: true, configurable: true },
    kernel: { get: () => src.kernel(), enumerable: true, configurable: true },
  });
  ctx.point3 = (p) => src.pickAt(p)?.point ?? planeToWorld(src.plane(), p);
  ctx.ray3 = (p) => src.pickAt(p)?.ray ?? null;
  ctx.face3 = (p) => {
    const pick = src.pickAt(p);
    if (pick) return pick.hit;
    const state = ctx.doc.snapshot;
    return faceBelow(model3dOf(state), state.layers, src.plane(), planeToWorld(src.plane(), p));
  };
  ctx.setConstructionPlane = (frame, name) => src.setPlane(frame, name);
  ctx.solids = () => model3dOf(ctx.doc.snapshot);
  ctx.setPreview3d = (solids) => src.setPreview3d(solids);
  return ctx;
}
