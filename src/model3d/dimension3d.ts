/**
 * True 3D dimensions (DIM3D, docs/3D-DIMENSIONS.md): the model side. A `Dimension3D`
 * (src/model3d/types.ts) lives in its measurement plane; everything here maps it into that plane's
 * 2D coordinates and hands it to the 2D dimension code, so measurement, text and geometry are the
 * 2D rules exactly:
 *
 * - `dimension3dTo2d`: the equivalent 2D `DimensionEntity` in plane coordinates (x, y along the
 *   plane's X / Y axes, measured from its origin). Definition points off the plane are projected
 *   along the normal; then the dimension is `projected` and its text gets " (projected)".
 * - `dimension3dParts`: the 2D `dimensionGeometry` of that entity (extension lines, dimension line
 *   or arc, arrowheads, text), still in plane coordinates; `planeWorld` maps a plane point to world
 *   coordinates (src/render3d/dimension3d-scene.ts draws and picks them in the 3D view).
 * - `makeDimension3D`: the one constructor every producer uses (the DIM3D tool, the DXF reader,
 *   transforms, the Properties palette), so `offset`, the leg order of angular dimensions and the
 *   `projected` flag are always derived the same way from a dimension-line location point.
 *
 * Everything is pure and returns plain data (it seals and undoes like the solids).
 */
import { type DimPart, type DimStyle, type DimensionEntity, dimensionGeometry, dimensionText, dimensionTextPoint } from '../core/dimension';
import { type ColorSpec, newId, textWidth } from '../core/entities';
import * as g from '../core/geometry';
import type { Point } from '../core/geometry';
import { type Frame3, type Vec3, add3, dot3, finite3, isOrthonormalFrame, len3, scale3, sub3, v3 } from './math';
import type { Dimension3D, Dimension3DKind } from './types';

/**
 * A definition point is in the measurement plane when its distance from it is at most this much
 * relative to the dimension's own size (the largest distance between its definition points), but
 * never less than the rounding of coordinates of that magnitude (`coincidenceTolerance` x 100):
 * a 5-unit dimension at x = 100,000 with a point 0.05 off its plane is projected.
 */
export const DIM3D_PLANE_TOLERANCE = 1e-6;

/** Text appended to the dimension text of a projected dimension. */
export const PROJECTED_SUFFIX = ' (projected)';

/** Plane coordinates (x, y, z = height above the plane) of a world point. */
export function planeLocal(frame: Frame3, q: Vec3): Vec3 {
  const d = sub3(q, frame.origin);
  return v3(dot3(d, frame.xAxis), dot3(d, frame.yAxis), dot3(d, frame.zAxis));
}

/** World point of plane coordinates (x, y) at height `z` above the plane. */
export function planeWorld(frame: Frame3, p: Point, z = 0): Vec3 {
  return add3(add3(add3(frame.origin, scale3(frame.xAxis, p.x)), scale3(frame.yAxis, p.y)), scale3(frame.zAxis, z));
}

const flat = (q: Vec3): Point => ({ x: q.x, y: q.y });

/** What `makeDimension3D` needs: the definition points and where the dimension line (or arc) goes. */
export interface Dimension3DSpec {
  readonly id?: string;
  readonly layer?: string;
  readonly color?: ColorSpec;
  readonly kind: Dimension3DKind;
  readonly plane: Frame3;
  readonly p1: Vec3;
  readonly p2: Vec3;
  /** Angular: the vertex (required). */
  readonly vertex?: Vec3;
  /** Linear: the plane axis measured along (default 'x'). */
  readonly axis?: 'x' | 'y';
  /**
   * A point the dimension line passes through (aligned / linear; only its distance across the
   * measurement direction counts) or a point on the dimension arc (angular: its distance from the
   * vertex is the radius and its side picks which of the two angles between the legs is measured).
   * Projected onto the plane.
   */
  readonly location: Vec3;
  /** Text override; undefined or '' = the measurement. */
  readonly textOverride?: string;
  readonly style: DimStyle;
}

/**
 * Distances below this are rounding noise for coordinates of this magnitude (1e-12 x max(1,
 * |plane origin|, |points|)): two points closer than it coincide.
 */
export function coincidenceTolerance(plane: Frame3, points: readonly (Vec3 | undefined)[]): number {
  let size = Math.max(1, len3(plane.origin));
  for (const p of points) if (p) size = Math.max(size, len3(p));
  return 1e-12 * size;
}

/**
 * The tolerance for "in the plane" of a dimension with these definition points:
 * DIM3D_PLANE_TOLERANCE x their largest distance from each other, at least 100 x the rounding
 * noise of their coordinates (`coincidenceTolerance`).
 */
export function planeTolerance(plane: Frame3, points: readonly (Vec3 | undefined)[]): number {
  const pts = points.filter((p): p is Vec3 => !!p);
  let spread = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) spread = Math.max(spread, len3(sub3(pts[i]!, pts[j]!)));
  return Math.max(DIM3D_PLANE_TOLERANCE * spread, 100 * coincidenceTolerance(plane, pts));
}

/** Distance of `q` from the plane (signed, along the normal). */
export function heightAbovePlane(plane: Frame3, q: Vec3): number {
  return dot3(sub3(q, plane.origin), plane.zAxis);
}

const copy = (q: Vec3): Vec3 => v3(q.x, q.y, q.z);

/**
 * A dimension from its definition points and location. Throws a RangeError when the input cannot
 * make a dimension: a plane that is not orthonormal and right-handed (within 1e-6), non-finite
 * points, an aligned dimension whose points coincide in the plane, an angular one without a vertex,
 * with a leg point or the arc location on the vertex, or with both legs in the same direction.
 * A linear dimension may measure 0 (as in 2D).
 */
export function makeDimension3D(spec: Dimension3DSpec): Dimension3D {
  const { plane, kind } = spec;
  if (!isOrthonormalFrame(plane, 1e-6)) throw new RangeError('The measurement plane is not a valid frame.');
  const pts = [spec.p1, spec.p2, spec.location, ...(spec.vertex ? [spec.vertex] : [])];
  if (!pts.every((p) => !!p && finite3(p))) throw new RangeError('The dimension points must be finite.');
  const tol = planeTolerance(plane, [spec.p1, spec.p2, spec.vertex]);
  const tiny = coincidenceTolerance(plane, [spec.p1, spec.p2, spec.vertex, spec.location]);
  const a = flat(planeLocal(plane, spec.p1)), b = flat(planeLocal(plane, spec.p2)), loc = flat(planeLocal(plane, spec.location));
  let p1 = spec.p1, p2 = spec.p2;
  let offset: number;
  let axis: 'x' | 'y' | undefined;
  switch (kind) {
    case 'aligned': {
      const len = g.dist(a, b);
      if (!(len > tiny)) throw new RangeError('The two points coincide in the measurement plane; there is nothing to dimension.');
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      offset = g.dot(g.sub(loc, g.mid(a, b)), { x: -u.y, y: u.x });
      break;
    }
    case 'linear': {
      axis = spec.axis ?? 'x';
      const n = axis === 'x' ? { x: 0, y: 1 } : { x: -1, y: 0 };
      offset = g.dot(g.sub(loc, g.mid(a, b)), n);
      break;
    }
    case 'angular': {
      if (!spec.vertex) throw new RangeError('An angular dimension needs a vertex.');
      const c = flat(planeLocal(plane, spec.vertex));
      if (!(g.dist(a, c) > tiny) || !(g.dist(b, c) > tiny)) throw new RangeError('A leg point coincides with the vertex in the measurement plane.');
      const ua = g.normalize(g.sub(a, c)), ub = g.normalize(g.sub(b, c));
      if (Math.abs(g.cross(ua, ub)) < 1e-12 && g.dot(ua, ub) > 0) throw new RangeError('The two legs have the same direction; there is no angle to dimension.');
      offset = g.dist(loc, c);
      if (!(offset > tiny)) throw new RangeError('The arc location coincides with the vertex.');
      // The arc runs counter-clockwise from the leg through p1 to the leg through p2: order the
      // legs so that it passes through the location.
      if (!g.angleInSweep(g.angleOf(c, loc), g.angleOf(c, a), g.angleOf(c, b))) [p1, p2] = [p2, p1];
      break;
    }
  }
  if (!Number.isFinite(offset)) throw new RangeError('The dimension line location must be finite.');
  const projected = [p1, p2, spec.vertex].some((p) => p && Math.abs(heightAbovePlane(plane, p)) > tol);
  const text = spec.textOverride !== undefined && spec.textOverride !== '' ? spec.textOverride : undefined;
  return {
    id: spec.id ?? newId(),
    layer: spec.layer ?? '0',
    color: spec.color ?? 'ByLayer',
    kind,
    plane: { origin: copy(plane.origin), xAxis: copy(plane.xAxis), yAxis: copy(plane.yAxis), zAxis: copy(plane.zAxis) },
    p1: copy(p1),
    p2: copy(p2),
    ...(kind === 'angular' && spec.vertex ? { vertex: copy(spec.vertex) } : {}),
    ...(axis ? { axis } : {}),
    offset,
    ...(text !== undefined ? { textOverride: text } : {}),
    style: spec.style,
    ...(projected ? { projected: true as const } : {}),
  };
}

/** The spec that rebuilds `dim` (its location point recovered), for edits through `makeDimension3D`. */
export function dimension3dSpec(dim: Dimension3D): Dimension3DSpec {
  return {
    id: dim.id, layer: dim.layer, color: dim.color, kind: dim.kind, plane: dim.plane, p1: dim.p1, p2: dim.p2,
    ...(dim.vertex ? { vertex: dim.vertex } : {}), ...(dim.axis ? { axis: dim.axis } : {}),
    location: dimension3dLocation(dim), ...(dim.textOverride !== undefined ? { textOverride: dim.textOverride } : {}), style: dim.style,
  };
}

/** The text the dimension shows as a 2D text override: the user's override, plus " (projected)" when projected (a hidden text, ' ', stays hidden). */
export function effectiveTextOverride(dim: Pick<Dimension3D, 'textOverride' | 'projected'>): string | undefined {
  // ' ' hides the text (as in 2D): it stays hidden when projected.
  if (!dim.projected || dim.textOverride === ' ') return dim.textOverride;
  const base = dim.textOverride ?? '<>';
  return base.endsWith(PROJECTED_SUFFIX) ? base : base + PROJECTED_SUFFIX;
}

const to2dCache = new WeakMap<Dimension3D, DimensionEntity>();

/**
 * The equivalent 2D dimension in plane coordinates (same id, layer, colour and style; text =
 * `effectiveTextOverride`). Cached per dimension object (states are immutable).
 */
export function dimension3dTo2d(dim: Dimension3D): DimensionEntity {
  const hit = to2dCache.get(dim);
  if (hit) return hit;
  const { plane } = dim;
  const a = flat(planeLocal(plane, dim.p1)), b = flat(planeLocal(plane, dim.p2));
  const text = effectiveTextOverride(dim);
  const common = { id: dim.id, layer: dim.layer, color: dim.color, type: 'dimension' as const, p1: a, p2: b, ...(text !== undefined ? { text } : {}), style: dim.style };
  let out: DimensionEntity;
  if (dim.kind === 'angular') {
    const c = flat(planeLocal(plane, dim.vertex ?? dim.p1));
    const a1 = g.angleOf(c, a), a2 = g.angleOf(c, b);
    const sweep = g.normAngle(a2 - a1) || 2 * Math.PI;
    out = { ...common, kind: 'angular', center: c, linePoint: g.polar(c, a1 + sweep / 2, dim.offset), rotation: 0 };
  } else {
    let u: Point;
    if (dim.kind === 'linear') u = dim.axis === 'y' ? { x: 0, y: 1 } : { x: 1, y: 0 };
    else {
      const len = g.dist(a, b);
      u = len > 0 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
    }
    const linePoint = g.add(g.mid(a, b), g.scale({ x: -u.y, y: u.x }, dim.offset));
    out = { ...common, kind: dim.kind, linePoint, rotation: dim.kind === 'linear' && dim.axis === 'y' ? Math.PI / 2 : 0 };
  }
  to2dCache.set(dim, out);
  return out;
}

/**
 * The measured value: drawing units for aligned and linear dimensions, radians for angular ones,
 * computed in the plane (see `Dimension3D`).
 */
export function dimension3dMeasurement(dim: Dimension3D): number {
  const { plane } = dim;
  const a = planeLocal(plane, dim.p1), b = planeLocal(plane, dim.p2);
  switch (dim.kind) {
    case 'aligned':
      return Math.hypot(b.x - a.x, b.y - a.y);
    case 'linear':
      return Math.abs(dim.axis === 'y' ? b.y - a.y : b.x - a.x);
    case 'angular': {
      const c = planeLocal(plane, dim.vertex ?? dim.p1);
      return g.normAngle(Math.atan2(b.y - c.y, b.x - c.x) - Math.atan2(a.y - c.y, a.x - c.x));
    }
  }
}

/** The true 3D distance between the definition points (aligned / linear), for messages. */
export function dimension3dTrueDistance(dim: Dimension3D): number {
  return len3(sub3(dim.p2, dim.p1));
}

/** The text the dimension shows (one line, as `dimensionText`), including " (projected)". */
export function dimension3dText(dim: Dimension3D): string {
  return dimensionText(dimension3dTo2d(dim));
}

/** World point the dimension line passes through (the arc's midpoint for angular dimensions). */
export function dimension3dLocation(dim: Dimension3D): Vec3 {
  return planeWorld(dim.plane, dimension3dTo2d(dim).linePoint);
}

const partsCache = new WeakMap<Dimension3D, DimPart[]>();

/** The 2D dimension geometry (lines, arrowheads, arcs, text) in plane coordinates. Cached per object. */
export function dimension3dParts(dim: Dimension3D): DimPart[] {
  const hit = partsCache.get(dim);
  if (hit) return hit;
  const parts = dimensionGeometry(dimension3dTo2d(dim), textWidth);
  partsCache.set(dim, parts);
  return parts;
}

/** Middle of the dimension text in world coordinates (DXF group 11). */
export function dimension3dTextPoint(dim: Dimension3D): Vec3 {
  return planeWorld(dim.plane, dimensionTextPoint(dimension3dTo2d(dim), textWidth));
}

/** A copy with a new text override ('' or undefined removes it); the geometry is untouched. */
export function withTextOverride3D(dim: Dimension3D, text: string | undefined): Dimension3D {
  const { textOverride: _old, ...rest } = dim;
  return text === undefined || text === '' ? rest : { ...rest, textOverride: text };
}

const f4 = (v: number): string => {
  const s = v.toFixed(4);
  return Number(s) === 0 ? '0.0000' : s;
};

/**
 * A short description of a measurement plane for the Properties palette: "XY at z = 5.0000",
 * "XZ at y = 0.0000", "YZ at x = 2.0000" for world-parallel planes (either way up), else
 * "Custom (normal 0.7071, 0.0000, 0.7071)".
 */
export function planeDescription(frame: Frame3): string {
  const n = frame.zAxis, o = frame.origin;
  const near1 = (v: number) => Math.abs(Math.abs(v) - 1) < 1e-9;
  if (near1(n.z)) return `XY at z = ${f4(o.z)}`;
  if (near1(n.y)) return `XZ at y = ${f4(o.y)}`;
  if (near1(n.x)) return `YZ at x = ${f4(o.x)}`;
  return `Custom (normal ${f4(n.x)}, ${f4(n.y)}, ${f4(n.z)})`;
}

/** User-facing kind name ("Aligned", "Linear (plane X)", "Angular"). */
export function dimension3dKindLabel(dim: Pick<Dimension3D, 'kind' | 'axis'>): string {
  if (dim.kind === 'linear') return `Linear (plane ${dim.axis === 'y' ? 'Y' : 'X'})`;
  return dim.kind === 'aligned' ? 'Aligned' : 'Angular';
}
