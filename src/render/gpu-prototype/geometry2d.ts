import type { DrawingState } from '../../core/document';
import type { Entity, LineEntity, PolylineEntity } from '../../core/entities';
import { polylineSegments } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { colorDisplay, lineweightDisplay, resolveColor, resolveLineWidth } from '../draw';
import { lowerStrokeScene, type LoweredStrokeScene } from './stroke-scene';
import { canvasArcAdmission } from './arc-admission';
import { assertPrimitiveStrokePrecision, canvasPolylineStrokeProblem } from './stroke-parity';

export interface Gpu2DView {
  width: number;
  height: number;
  dpr: number;
  scale: number;
  center: Point;
  twist: number;
  background: string;
  lineweights?: boolean;
}

export interface Gpu2DOverlay {
  selection: ReadonlySet<string>;
  hover?: string | null;
  solidSelection?: boolean;
}

export interface StrokeBatch { id: string; first: number; count: number; alpha: number }
export interface Prepared2D {
  /** Interleaved CSS-pixel screen XY and RGB. World doubles are rebased before conversion. */
  vertices: Float32Array<ArrayBuffer>;
  batches: StrokeBatch[];
  /** Conservative CSS-pixel translation allowance before a source point exceeds precision limits. */
  panPrecisionMargin: Point;
}

/** Bounded physical-pixel border retained for camera translation, never a zoom allowance. */
export const GPU_PAN_CACHE_BORDER = 128;
/** A copied camera anchor owns this entire interval; crossing it prepares a new mesh. */
export const GPU_ZOOM_CACHE_MIN_RATIO = 0.8;
export const GPU_ZOOM_CACHE_MAX_RATIO = 1.25;
export const GPU_ZOOM_VERTEX_STRIDE = 7;
/** Optional edit metadata must not grow with arbitrarily large zero-vertex scenes. */
export const GPU_EDIT_ENTITY_LIMIT = 100_000;
const MAX_CURVE_SEGMENTS = 32768;
const MAX_VERTICES = 1_000_000;
const PIXEL_ERROR = 0.25; // Physical pixels, including high-DPI views.
// Leave part of the existing quarter-pixel curve budget for Float32 shader arithmetic.
const ZOOM_CURVE_PIXEL_ERROR = 0.1875;
const ZOOM_FLOAT_PIXEL_ERROR = PIXEL_ERROR - ZOOM_CURVE_PIXEL_ERROR;
// Compiled INSERT primitives also reserve .0625 for Canvas world construction.
// .125 curve + .0625 construction + .0625 Float32 stays inside the existing .25.
const COMPILED_CURVE_PIXEL_ERROR = 0.125;
const STRIDE = 5;
// Beyond this, adding subpixel stroke offsets to a projected double becomes unreliable.
// Refuse the entire scene rather than clipping an already distorted triangle strip.
const MAX_PROJECTED_COORDINATE = 2 ** 36;

export function cssRgb(css: string): [number, number, number] | null {
  const short = /^#([0-9a-f]{3})$/i.exec(css);
  const full = /^#([0-9a-f]{6})$/i.exec(css);
  const hex = full?.[1] ?? short?.[1]?.split('').map((digit) => digit + digit).join('');
  if (!hex) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

function checked(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Nonfinite screen geometry');
  return point;
}

/** Viewport.toScreen's convention. Subtraction must happen in doubles, before Float32. */
export function screenPoint(point: Point, view: Gpu2DView): Point {
  return projectLocal({ x: point.x - view.center.x, y: point.y - view.center.y }, view);
}

function projectLocal(point: Point, view: Gpu2DView): Point {
  const c = Math.cos(view.twist), s = Math.sin(view.twist);
  const screen = checked({ x: view.width / 2 + (point.x * c - point.y * s) * view.scale, y: view.height / 2 - (point.x * s + point.y * c) * view.scale });
  const bound = MAX_PROJECTED_COORDINATE / Math.max(1, view.dpr);
  if (Math.abs(screen.x) > bound || Math.abs(screen.y) > bound) throw new Error('Projected coordinates exceed GPU stroke precision bound');
  return screen;
}

function curveCount(radius: number, sweep: number, view: Gpu2DView, pixelError = PIXEL_ERROR, radiusPadding = 0, capHalfWidth = 0): number {
  const pixels = (radius * view.scale + radiusPadding) * view.dpr;
  if (!Number.isFinite(pixels) || radius < 0) throw new Error('Invalid curve radius or scale');
  if (pixels === 0) return 1;
  // Stable sagitta formula, even when the radius dwarfs the pixel tolerance.
  const sagittaStep = 4 * Math.asin(Math.sqrt(Math.min(1, pixelError / pixels / 2)));
  const capStep = capHalfWidth > 0 ? 2 * Math.asin(Math.min(1, pixelError / (capHalfWidth * view.dpr))) : Math.PI / 2;
  const step = Math.min(Math.PI / 2, sagittaStep, capStep);
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  if (!Number.isFinite(count) || count > MAX_CURVE_SEGMENTS) throw new Error('Curve tessellation exceeds prototype budget');
  return count;
}

function arcPath(center: Point, radius: number, start: number, sweep: number, view: Gpu2DView, curveScale = view.scale, pixelError = PIXEL_ERROR, strokeWidth = 0, buttCaps = false, onCurve?: (radius: number) => void): Point[] {
  checked(center);
  if (![radius, start, sweep].every(Number.isFinite)) throw new Error('Invalid arc geometry');
  if (radius < 0) throw new Error('Invalid curve radius or scale');
  onCurve?.(radius);
  // At steps <= pi/2, outer miter excess h*(sec(step/2)-1) is bounded by
  // sqrt(2)*h*(1-cos(step/2)). Wide strokes need this budget as well as center sagitta.
  // Bounded admitted angles leave room for binary64 normalization, interpolation and
  // trigonometric construction inside the existing curve reserve, never in addition to it.
  const angularError = Number.EPSILON * 16 * (1 + Math.abs(start) + Math.abs(sweep));
  const remainingError = pixelError - radius * curveScale * view.dpr * angularError;
  if (!Number.isFinite(remainingError) || remainingError <= 0) throw new Error('Curve angular construction exceeds precision budget');
  const count = curveCount(radius, sweep, { ...view, scale: curveScale }, remainingError, Math.SQRT2 * strokeWidth / 2, buttCaps ? strokeWidth / 2 : 0);
  const path: Point[] = [];
  // Open curves also bound h*sin(step/2): their first/last strip approximates native
  // butt-cap tangents. Uniform refinement prevents a nearby coarse strip crossing the cap.
  for (let i = 0; i <= count; i++) {
    const angle = start + sweep * i / count;
    // center is already relative to the camera: never add small offsets to world coordinates.
    path.push(projectLocal({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }, view));
  }
  return path;
}

function entityPath(entity: Entity, view: Gpu2DView, curveScale = view.scale, pixelError = PIXEL_ERROR, strokeWidth = 0, onCurve?: (radius: number) => void): { points: Point[]; closed: boolean } {
  const local = (point: Point): Point => checked({ x: point.x - view.center.x, y: point.y - view.center.y });
  switch (entity.type) {
    case 'line': return { points: [screenPoint(entity.a, view), screenPoint(entity.b, view)], closed: false };
    case 'circle': {
      const points = arcPath(local(entity.center), entity.radius, 0, Math.PI * 2, view, curveScale, pixelError, strokeWidth, false, onCurve);
      points.pop();
      return { points, closed: true };
    }
    case 'arc': {
      const admission = canvasArcAdmission(entity);
      if (!admission.ok) throw new Error(`${admission.reason} (${entity.id})`);
      return { points: arcPath(local(entity.center), entity.radius, admission.startAngle, admission.sweep, view, curveScale, pixelError, strokeWidth, true, onCurve), closed: false };
    }
    case 'polyline': {
      // Rebase BEFORE bulgeArc computes its midpoint/center, preserving close-zoom arcs.
      const rebased: PolylineEntity = { ...entity, points: entity.points.map(local) };
      if (entity.bulges?.some((bulge) => Math.abs(bulge) >= 1e-12)) {
        // Native Canvas computes bulge centers at the source's world origin. Reserve
        // that construction difference, including cap directions, before tessellation.
        assertPrimitiveStrokePrecision(rebased, entity, strokeWidth, view, curveScale / view.scale);
        pixelError = Math.min(pixelError, COMPILED_CURVE_PIXEL_ERROR);
      }
      const points: Point[] = rebased.points.length ? [projectLocal(rebased.points[0]!, view)] : [];
      for (const segment of polylineSegments(rebased)) {
        if (!Number.isFinite(segment.bulge)) throw new Error('Invalid polyline bulge');
        if (segment.arc) {
          const arc = segment.arc;
          const curve = arcPath(arc.center, arc.radius, arc.sweep > 0 ? arc.startAngle : arc.endAngle, arc.sweep, view, curveScale, pixelError, strokeWidth, true, onCurve);
          // Native endpoints are authoritative; avoid accumulating trigonometric seam errors.
          curve[curve.length - 1] = projectLocal(segment.b, view);
          points.push(...curve.slice(1));
        } else points.push(projectLocal(segment.b, view));
        if (points.length > MAX_VERTICES) throw new Error('Polyline exceeds prototype budget');
      }
      if (entity.closed && points.length > 1) points.pop();
      return { points, closed: entity.closed };
    }
    default: throw new Error(`Unsupported entity: ${entity.type}`);
  }
}

/** Clip in doubles before upload, so remote endpoints cannot consume Float32 precision. */
function clippedTriangle(triangle: Point[], width: number, height: number, padding: number): Point[] {
  let polygon = triangle;
  for (const [axis, limit, greater] of [['x', -padding, true], ['x', width + padding, false], ['y', -padding, true], ['y', height + padding, false]] as const) {
    const input = polygon;
    polygon = [];
    if (!input.length) break;
    let a = input[input.length - 1]!;
    let insideA = greater ? a[axis] >= limit : a[axis] <= limit;
    for (const b of input) {
      const insideB = greater ? b[axis] >= limit : b[axis] <= limit;
      if (insideA !== insideB) {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        const intersection = checked({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        polygon.push({ ...intersection, [axis]: limit });
      }
      if (insideB) polygon.push(b);
      a = b;
      insideA = insideB;
    }
  }
  return polygon;
}

function strokeTriangles(source: readonly Point[], closed: boolean, width: number, color: [number, number, number], view: Gpu2DView, output: number[], padding: number): void {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Invalid lineweight');
  const points = source.filter((point, index) => index === 0 || point.x !== source[index - 1]!.x || point.y !== source[index - 1]!.y);
  if (points.length < 2) return; // Canvas butt-capped degenerate paths paint nothing.
  const triangle = (a: Point, b: Point, c: Point): void => {
    const polygon = clippedTriangle([checked(a), checked(b), checked(c)], view.width, view.height, padding);
    for (let i = 1; i + 1 < polygon.length; i++) {
      for (const p of [polygon[0]!, polygon[i]!, polygon[i + 1]!]) output.push(p.x, p.y, ...color);
    }
    if (output.length / STRIDE > MAX_VERTICES) throw new Error('Stroke geometry exceeds prototype budget');
  };
  const offset = (point: Point, normal: Point, factor: number): Point => ({ x: point.x + normal.x * factor, y: point.y + normal.y * factor });
  const half = width / 2;
  const count = closed ? points.length : points.length - 1;
  const normals: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!Number.isFinite(length)) throw new Error('Stroke length exceeds finite limits');
    const normal = length ? { x: -dy / length, y: dx / length } : { x: 0, y: 0 };
    normals.push(normal);
    const al = offset(a, normal, half), ar = offset(a, normal, -half);
    const bl = offset(b, normal, half), br = offset(b, normal, -half);
    triangle(al, bl, br);
    triangle(al, br, ar);
  }
  // Fill outer joins with a Canvas-style miter (default limit 10), or a bevel at sharp turns.
  for (let i = closed ? 0 : 1; i < count; i++) {
    const p = points[i]!, previous = normals[(i + count - 1) % count]!, next = normals[i]!;
    const cross = previous.x * next.y - previous.y * next.x;
    if (Math.abs(cross) < 1e-12) continue;
    const side = cross > 0 ? -1 : 1;
    const a = offset(p, previous, side * half), b = offset(p, next, side * half);
    triangle(p, a, b);
    const denominator = 1 + previous.x * next.x + previous.y * next.y;
    if (denominator <= 1e-12) continue;
    const miter = { x: (previous.x + next.x) * side * half / denominator, y: (previous.y + next.y) * side * half / denominator };
    if (Math.hypot(miter.x, miter.y) <= half * 10) triangle(a, { x: p.x + miter.x, y: p.y + miter.y }, b);
  }
}

function styleProblem(entity: Entity, state: DrawingState): string | null {
  if (!['line', 'polyline', 'circle', 'arc'].includes(entity.type)) return `Unsupported entity: ${entity.type} (${entity.id})`;
  if (entity.annotative) return `Unsupported annotative style (${entity.id})`;
  const layer = state.layers.find((item) => item.name === entity.layer);
  const name = effectiveLinetype(entity.linetype, layer?.linetype);
  if (findLinetype(name, state.header?.linetypes)?.pattern.length) return `Unsupported dashed linetype: ${name} (${entity.id})`;
  if (resolveAlpha(entity, state.layers) !== 1) return `Unsupported transparency (${entity.id})`;
  if (entity.type === 'circle' && entity.filled) return `Unsupported filled circle (${entity.id})`;
  if (entity.type === 'arc') {
    const admission = canvasArcAdmission(entity);
    if (!admission.ok) return `${admission.reason} (${entity.id})`;
  }
  if (entity.type === 'polyline') {
    const strokeProblem = canvasPolylineStrokeProblem(entity);
    if (strokeProblem) return `${strokeProblem} (${entity.id})`;
    const problem = polylineWidthProblem(entity);
    if (problem) return `${problem} (${entity.id})`;
    if (entity.filled || entity.widthFrame || (entity.width ?? 0) !== 0 || entity.widths?.some((width) => width.start !== 0 || width.end !== 0)) return `Unsupported polyline width or fill (${entity.id})`;
  }
  return null;
}

export function validateGpu2DView(view: Gpu2DView): void {
  if (![view.width, view.height, view.dpr, view.scale, view.center.x, view.center.y, view.twist].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.dpr <= 0 || view.scale <= 0) throw new Error('Invalid GPU view');
}

/** Renderer-owned projected bounds; never an alias into immutable document points. */
export interface ZoomSourceBounds { min: { x: number; y: number }; max: { x: number; y: number } }
export interface PreparedZoomEntity {
  entity: Entity;
  first: number;
  count: number;
  color: [number, number, number];
  width: number;
  alpha: number;
  /** Includes original/offscreen points even when no vertices were emitted. */
  sourceBounds: ZoomSourceBounds | null;
}
export interface PreparedZoomLine {
  vertices: Float32Array<ArrayBuffer>;
  color: [number, number, number];
  width: number;
  alpha: number;
  sourceBounds: ZoomSourceBounds | null;
}

export interface PreparedZoom2D {
  /** Anchor-local center XY, fixed CSS-pixel extrusion XY, RGB. Never world Float32s. */
  vertices: Float32Array<ArrayBuffer>;
  batches: StrokeBatch[];
  /** May narrow the requested interval to keep every curve's inner radius safely positive. */
  minRatio: number;
  maxRatio: number;
  padding: number;
  /** Original projected centers, including discarded/offscreen points, in anchor-local doubles. */
  sourceBounds: ZoomSourceBounds;
  /** Retained centerline rectangle; generated butt ends are outside every admitted viewport. */
  extent: Point;
  /** Original entity indices, including zero-vertex entries; hidden entries are null. */
  entities: (PreparedZoomEntity | null)[] | null;
  entityCount: number;
  /** Only compiled scenes depend on block definitions and drawing-local text styles. */
  compound?: Pick<Extract<LoweredStrokeScene, { ok: true }>, 'blockDependencies' | 'textStylesDependency'>;
}

export interface PreparedCompoundZoom2D extends PreparedZoom2D {
  /** Compound paint slots cannot be patched by the simple-entity edit fast path. */
  entities: null;
  entityCount: number;
  compound: NonNullable<PreparedZoom2D['compound']>;
}

function zoomStrokeStyle(entity: Entity, state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): Pick<PreparedZoomEntity, 'color' | 'width' | 'alpha'> {
  const selected = overlay.selection.has(entity.id), hovered = overlay.hover === entity.id && !selected;
  const color = cssRgb(resolveColor(entity, state.layers));
  if (!color) throw new Error(`Unsupported display color (${entity.id})`);
  const width = selected ? 2.5 : hovered ? 2 : resolveLineWidth(entity, state.layers, { scale: view.scale, toScreen: (point) => screenPoint(point, view) });
  if (!Number.isFinite(width) || width <= 0) throw new Error('Invalid lineweight');
  return { color, width, alpha: selected || hovered ? 0.95 : 1 };
}

function zoomLocalPoints(source: readonly Point[], view: Gpu2DView): { points: Point[]; bounds: ZoomSourceBounds | null } {
  const bounds: ZoomSourceBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  const points = source.map((point) => {
    const center = checked({ x: point.x - view.width / 2, y: point.y - view.height / 2 });
    for (const axis of ['x', 'y'] as const) {
      bounds.min[axis] = Math.min(bounds.min[axis], center[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], center[axis]);
    }
    return center;
  });
  return { points, bounds: points.length ? bounds : null };
}

function includeZoomBounds(target: ZoomSourceBounds, source: ZoomSourceBounds | null): void {
  if (!source) return;
  for (const axis of ['x', 'y'] as const) {
    target.min[axis] = Math.min(target.min[axis], source.min[axis]);
    target.max[axis] = Math.max(target.max[axis], source.max[axis]);
  }
}

/** Union every current source certificate; a clipped/zero-vertex entry still contributes. */
export function replacementZoomBounds(entities: readonly (PreparedZoomEntity | null)[], index: number, replacement: ZoomSourceBounds | null): ZoomSourceBounds {
  const bounds: ZoomSourceBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  for (let i = 0; i < entities.length; i++) includeZoomBounds(bounds, i === index ? replacement : entities[i]?.sourceBounds ?? null);
  if (!Number.isFinite(bounds.min.x)) bounds.min = bounds.max = { x: 0, y: 0 };
  return bounds;
}

/** Recheck the entire source, not just its clipped/uploaded subset, on each camera change. */
export function zoomPrecisionSafe(geometry: PreparedZoom2D, view: Gpu2DView, ratio: number, pan: Point): boolean {
  const bound = (MAX_PROJECTED_COORDINATE - 1) / Math.max(1, view.dpr);
  for (const axis of ['x', 'y'] as const) {
    const half = (axis === 'x' ? view.width : view.height) / 2;
    for (const value of [geometry.sourceBounds.min[axis], geometry.sourceBounds.max[axis]]) {
      const projected = value * ratio + pan[axis] + half;
      if (!Number.isFinite(projected) || Math.abs(projected) > bound) return false;
    }
  }
  return true;
}

/** Clip centers in doubles while retaining original segment normals and original path joins. */
function clippedCenterSegment(a: Point, b: Point, extent: Point): [Point, Point] | null {
  let first = 0, last = 1;
  const delta = { x: b.x - a.x, y: b.y - a.y };
  for (const axis of ['x', 'y'] as const) {
    if (delta[axis] === 0) {
      if (Math.abs(a[axis]) > extent[axis]) return null;
      continue;
    }
    const t1 = (-extent[axis] - a[axis]) / delta[axis];
    const t2 = (extent[axis] - a[axis]) / delta[axis];
    first = Math.max(first, Math.min(t1, t2));
    last = Math.min(last, Math.max(t1, t2));
    if (first > last) return null;
  }
  const at = (t: number): Point => checked({
    x: Math.max(-extent.x, Math.min(extent.x, a.x + delta.x * t)),
    y: Math.max(-extent.y, Math.min(extent.y, a.y + delta.y * t)),
  });
  return [at(first), at(last)];
}

function zoomStrokeTriangles(source: readonly Point[], closed: boolean, width: number, color: [number, number, number], extent: Point, output: number[]): void {
  const points = source.filter((point, index) => index === 0 || point.x !== source[index - 1]!.x || point.y !== source[index - 1]!.y);
  if (points.length < 2) return;
  const vertex = (point: Point, offset: Point): void => { output.push(point.x, point.y, offset.x, offset.y, ...color); };
  const triangle = (a: Point, ao: Point, b: Point, bo: Point, c: Point, co: Point): void => {
    vertex(a, ao); vertex(b, bo); vertex(c, co);
    if (output.length / GPU_ZOOM_VERTEX_STRIDE > MAX_VERTICES) throw new Error('Stroke geometry exceeds prototype budget');
  };
  const half = width / 2, count = closed ? points.length : points.length - 1;
  const normals: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!Number.isFinite(length)) throw new Error('Stroke length exceeds finite limits');
    const normal = length ? { x: -dy / length, y: dx / length } : { x: 0, y: 0 };
    normals.push(normal);
    const clipped = clippedCenterSegment(a, b, extent);
    if (!clipped) continue;
    const [ca, cb] = clipped;
    const left = { x: normal.x * half, y: normal.y * half };
    const right = { x: -left.x, y: -left.y };
    triangle(ca, left, cb, left, cb, right);
    triangle(ca, left, cb, right, ca, right);
  }
  for (let i = closed ? 0 : 1; i < count; i++) {
    const p = points[i]!;
    // A join's entire extrusion is covered by the rectangle's ten-half-width guard.
    if (Math.abs(p.x) > extent.x || Math.abs(p.y) > extent.y) continue;
    const previous = normals[(i + count - 1) % count]!, next = normals[i]!;
    const cross = previous.x * next.y - previous.y * next.x;
    if (Math.abs(cross) < 1e-12) continue;
    const side = cross > 0 ? -1 : 1;
    const a = { x: previous.x * side * half, y: previous.y * side * half };
    const b = { x: next.x * side * half, y: next.y * side * half };
    triangle(p, { x: 0, y: 0 }, p, a, p, b);
    const denominator = 1 + previous.x * next.x + previous.y * next.y;
    if (denominator <= 1e-12) continue;
    const miter = { x: (previous.x + next.x) * side * half / denominator, y: (previous.y + next.y) * side * half / denominator };
    if (Math.hypot(miter.x, miter.y) <= half * 10) triangle(p, a, p, miter, p, b);
  }
}

/** Compile ordered Canvas strokes, then share the tested zoom projection and stroke packing. */
export function prepareCompiledZoom2D(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, minRatio = GPU_ZOOM_CACHE_MIN_RATIO, maxRatio = GPU_ZOOM_CACHE_MAX_RATIO, padding = GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr)): PreparedCompoundZoom2D {
  validateGpu2DView(view);
  if (!Number.isFinite(minRatio) || !Number.isFinite(maxRatio) || minRatio < GPU_ZOOM_CACHE_MIN_RATIO || minRatio > 1 || maxRatio < 1 || maxRatio > GPU_ZOOM_CACHE_MAX_RATIO) throw new Error('Invalid GPU zoom cache interval');
  if (!Number.isFinite(padding) || padding < 0 || padding > GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr)) throw new Error('Invalid GPU pan cache border');
  // Nothing is uploaded or cleared until every visible expansion/font/style has passed.
  const lowered = lowerStrokeScene(state, view, overlay, { minRatio, maxRatio });
  if (!lowered.ok) throw new Error(lowered.reason, { cause: lowered.cause });
  minRatio = lowered.minRatio;
  maxRatio = lowered.maxRatio;
  const extrusion = lowered.operations.reduce((maximum, operation) => Math.max(maximum, operation.widthCss * 5), 0);
  const guard = 1 / Math.max(1, view.dpr);
  const extent = {
    x: (view.width / 2 + padding + extrusion + guard) / minRatio,
    y: (view.height / 2 + padding + extrusion + guard) / minRatio,
  };
  const magnitude = Math.max(extent.x, extent.y) * maxRatio + padding + Math.max(view.width, view.height) / 2 + extrusion;
  if (!Number.isFinite(magnitude) || magnitude * 12 * 2 ** -23 * view.dpr > ZOOM_FLOAT_PIXEL_ERROR) throw new Error('GPU zoom geometry exceeds Float32 precision budget');
  const localView = { ...view, center: { x: 0, y: 0 } };
  const vertices: number[] = [], batches: StrokeBatch[] = [];
  const sourceBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  let admittedMinRatio = minRatio;
  for (const operation of lowered.operations) {
    const first = vertices.length / GPU_ZOOM_VERTEX_STRIDE;
    const color: [number, number, number] = [...operation.color];
    const admitCurve = (radius: number): void => {
      const projectedRadius = radius * view.scale;
      if (!Number.isFinite(projectedRadius)) throw new Error('Invalid curve radius or scale');
      const innerLimit = operation.widthCss / 2 + PIXEL_ERROR / view.dpr;
      if (!(projectedRadius > innerLimit)) throw new Error(`Curve stroke overlap or precision margin requires Canvas rendering (${operation.sourceId})`);
      admittedMinRatio = Math.max(admittedMinRatio, Math.min(1, innerLimit / projectedRadius * (1 + 16 * Number.EPSILON)));
    };
    for (const source of operation.paths) {
      const path = source.kind === 'entity'
        ? entityPath(source.entity, localView, view.scale * maxRatio, COMPILED_CURVE_PIXEL_ERROR, operation.widthCss, admitCurve)
        : { points: source.points.map((point) => projectLocal(point, localView)), closed: source.closed };
      const points = path.points.map((point) => {
        const center = checked({ x: point.x - view.width / 2, y: point.y - view.height / 2 });
        for (const axis of ['x', 'y'] as const) {
          sourceBounds.min[axis] = Math.min(sourceBounds.min[axis], center[axis]);
          sourceBounds.max[axis] = Math.max(sourceBounds.max[axis], center[axis]);
        }
        return center;
      });
      zoomStrokeTriangles(points, path.closed, operation.widthCss, color, extent, vertices);
    }
    const count = vertices.length / GPU_ZOOM_VERTEX_STRIDE - first;
    // All glyph subpaths composite together; separate child strokes never share a stencil.
    if (count) batches.push({ id: operation.paintId, first, count, alpha: operation.alpha });
  }
  if (!Number.isFinite(sourceBounds.min.x)) sourceBounds.min = sourceBounds.max = { x: 0, y: 0 };
  const packed = new Float32Array(vertices);
  if (!packed.every(Number.isFinite)) throw new Error('Float32 stroke geometry exceeds finite limits');
  return {
    vertices: packed, batches, minRatio: admittedMinRatio, maxRatio, padding, sourceBounds, extent,
    entities: null, entityCount: lowered.preparedEntities,
    compound: { blockDependencies: lowered.blockDependencies, textStylesDependency: lowered.textStylesDependency },
  };
}

/** Prepare one line at an existing scene's original anchor and retention rectangle. */
export function prepareZoomLine(entity: LineEntity, state: DrawingState, anchor: Gpu2DView, overlay: Gpu2DOverlay, extent: Point): PreparedZoomLine {
  validateGpu2DView(anchor);
  if (![extent.x, extent.y].every(Number.isFinite) || extent.x <= 0 || extent.y <= 0) throw new Error('Invalid GPU line retention extent');
  const problem = styleProblem(entity, state);
  if (problem) throw new Error(problem);
  if (overlay.selection.has(entity.id) && !overlay.solidSelection) throw new Error(`Dashed selection requires canvas rendering (${entity.id})`);
  const previousPaper = colorDisplay.paper, previousWeights = { ...lineweightDisplay };
  colorDisplay.paper = false;
  lineweightDisplay.enabled = anchor.lineweights ?? previousWeights.enabled;
  lineweightDisplay.pxPerMm = undefined;
  try {
    const style = zoomStrokeStyle(entity, state, anchor, overlay);
    const path = entityPath(entity, anchor);
    const { points, bounds } = zoomLocalPoints(path.points, anchor);
    const output: number[] = [];
    zoomStrokeTriangles(points, path.closed, style.width, style.color, extent, output);
    const vertices = new Float32Array(output);
    if (!vertices.every(Number.isFinite)) throw new Error('Float32 stroke geometry exceeds finite limits');
    return { ...style, vertices, sourceBounds: bounds };
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
}

type StyledZoomLine = Pick<PreparedZoomEntity, 'color' | 'width' | 'alpha'> & { entity: LineEntity };

/** Grow only for emitted strokes; return exactly the owned used bytes for GPU upload. */
class ZoomLineWriter {
  private data = new Float32Array(0);
  length = 0;
  constructor(private readonly initialFloats: number) {}

  private vertex(x: number, y: number, ox: number, oy: number, color: [number, number, number]): void {
    const i = this.length;
    this.data[i] = x; this.data[i + 1] = y;
    this.data[i + 2] = ox; this.data[i + 3] = oy;
    this.data[i + 4] = color[0]; this.data[i + 5] = color[1]; this.data[i + 6] = color[2];
    this.length += GPU_ZOOM_VERTEX_STRIDE;
  }

  stroke(a: Point, b: Point, ox: number, oy: number, color: [number, number, number]): void {
    const required = this.length + 6 * GPU_ZOOM_VERTEX_STRIDE;
    if (required / GPU_ZOOM_VERTEX_STRIDE > MAX_VERTICES) throw new Error('Stroke geometry exceeds prototype budget');
    if (required > this.data.length) {
      const limit = Math.floor(MAX_VERTICES / 6) * 6 * GPU_ZOOM_VERTEX_STRIDE;
      const capacity = Math.min(limit, Math.max(required, this.data.length ? this.data.length * 2 : this.initialFloats));
      const next = new Float32Array(capacity);
      next.set(this.data);
      this.data = next;
    }
    // Validate each distinct packed scalar once. This preserves the generic path's
    // Float32 refusal even for extremely small DPRs, without scanning repeated vertices.
    const ax = Math.fround(a.x), ay = Math.fround(a.y), bx = Math.fround(b.x), by = Math.fround(b.y);
    const x = Math.fround(ox), y = Math.fround(oy);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Float32 stroke geometry exceeds finite limits');
    this.vertex(ax, ay, x, y, color); this.vertex(bx, by, x, y, color); this.vertex(bx, by, -x, -y, color);
    this.vertex(ax, ay, x, y, color); this.vertex(bx, by, -x, -y, color); this.vertex(ax, ay, -x, -y, color);
  }

  finish(): Float32Array<ArrayBuffer> { return this.length === this.data.length ? this.data : this.data.slice(0, this.length); }
}

/** Straight-only scenes need no temporary path, normals array, boxed vertex array or final finite scan. */
function prepareZoomLines(state: DrawingState, view: Gpu2DView, styled: readonly StyledZoomLine[], extent: Point, padding: number, minRatio: number, maxRatio: number): PreparedZoom2D {
  const writer = new ZoomLineWriter(Math.min(styled.length, 1024) * 6 * GPU_ZOOM_VERTEX_STRIDE);
  const batches: StrokeBatch[] = [];
  const entities: PreparedZoom2D['entities'] = state.entities.length <= GPU_EDIT_ENTITY_LIMIT ? Array.from({ length: state.entities.length }, () => null) : null;
  const sourceBounds: ZoomSourceBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  const c = Math.cos(view.twist), s = Math.sin(view.twist), halfX = view.width / 2, halfY = view.height / 2;
  const precisionBound = MAX_PROJECTED_COORDINATE / Math.max(1, view.dpr);
  let sourceIndex = 0;
  for (const { entity, color, width, alpha } of styled) {
    const adx = entity.a.x - view.center.x, ady = entity.a.y - view.center.y;
    const bdx = entity.b.x - view.center.x, bdy = entity.b.y - view.center.y;
    // Keep screenPoint's addition and zoomLocalPoints's subtraction in their original
    // order. Reassociation would change tiny displacements and projected degeneracy.
    const asx = halfX + (adx * c - ady * s) * view.scale, asy = halfY - (adx * s + ady * c) * view.scale;
    const bsx = halfX + (bdx * c - bdy * s) * view.scale, bsy = halfY - (bdx * s + bdy * c) * view.scale;
    if (!Number.isFinite(asx) || !Number.isFinite(asy) || !Number.isFinite(bsx) || !Number.isFinite(bsy)) throw new Error('Nonfinite screen geometry');
    if (Math.abs(asx) > precisionBound || Math.abs(asy) > precisionBound || Math.abs(bsx) > precisionBound || Math.abs(bsy) > precisionBound) throw new Error('Projected coordinates exceed GPU stroke precision bound');
    const ax = asx - halfX, ay = asy - halfY, bx = bsx - halfX, by = bsy - halfY;
    const bounds: ZoomSourceBounds = { min: { x: Math.min(ax, bx), y: Math.min(ay, by) }, max: { x: Math.max(ax, bx), y: Math.max(ay, by) } };
    includeZoomBounds(sourceBounds, bounds);
    const first = writer.length / GPU_ZOOM_VERTEX_STRIDE;
    if (ax !== bx || ay !== by) {
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
      if (!Number.isFinite(length)) throw new Error('Stroke length exceeds finite limits');
      const normalX = length ? -dy / length : 0, normalY = length ? dx / length : 0;
      const clipped = clippedCenterSegment({ x: ax, y: ay }, { x: bx, y: by }, extent);
      // A tangent clip still has six degenerate vertices, matching the generic path.
      if (clipped) writer.stroke(clipped[0], clipped[1], normalX * (width / 2), normalY * (width / 2), color);
    }
    const count = writer.length / GPU_ZOOM_VERTEX_STRIDE - first;
    if (count) batches.push({ id: entity.id, first, count, alpha });
    if (entities) {
      while (state.entities[sourceIndex] !== entity) sourceIndex++;
      entities[sourceIndex++] = { entity, first, count, color, width, alpha, sourceBounds: bounds };
    }
  }
  if (!Number.isFinite(sourceBounds.min.x)) sourceBounds.min = sourceBounds.max = { x: 0, y: 0 };
  return { vertices: writer.finish(), batches, minRatio, maxRatio, padding, sourceBounds, extent, entities, entityCount: styled.length };
}

/**
 * Prepare once for a bounded camera interval. Uniform zoom acts only on center positions;
 * normal/miter offsets stay in CSS pixels. A minimum-scale rectangle retains entering strokes,
 * and maximum-scale tessellation bounds curve error at every reused frame.
 */
export function prepareZoom2D(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, minRatio = GPU_ZOOM_CACHE_MIN_RATIO, maxRatio = GPU_ZOOM_CACHE_MAX_RATIO, padding = GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr)): PreparedZoom2D {
  validateGpu2DView(view);
  if (!Number.isFinite(minRatio) || !Number.isFinite(maxRatio) || minRatio < GPU_ZOOM_CACHE_MIN_RATIO || minRatio > 1 || maxRatio < 1 || maxRatio > GPU_ZOOM_CACHE_MAX_RATIO) throw new Error('Invalid GPU zoom cache interval');
  if (!Number.isFinite(padding) || padding < 0 || padding > GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr)) throw new Error('Invalid GPU pan cache border');
  const hidden = new Set(state.layers.filter((layer) => !layer.visible).map((layer) => layer.name));
  const visible = state.entities.filter((entity) => !hidden.has(entity.layer));
  if (visible.some((entity) => entity.type === 'insert' || entity.type === 'text')) return prepareCompiledZoom2D(state, view, overlay, minRatio, maxRatio, padding);
  // Validate every layer-visible entity before allowing any GPU submission, even offscreen.
  for (const entity of visible) {
    const problem = styleProblem(entity, state);
    if (problem) throw new Error(problem);
    if (overlay.selection.has(entity.id) && !overlay.solidSelection) throw new Error(`Dashed selection requires canvas rendering (${entity.id})`);
  }
  const previousPaper = colorDisplay.paper, previousWeights = { ...lineweightDisplay };
  colorDisplay.paper = false;
  lineweightDisplay.enabled = view.lineweights ?? previousWeights.enabled;
  lineweightDisplay.pxPerMm = undefined;
  try {
    const styled = visible.map((entity) => ({ entity, ...zoomStrokeStyle(entity, state, view, overlay) }));
    const extrusion = styled.reduce((maximum, item) => Math.max(maximum, item.width * 5), 0);
    const guard = 1 / Math.max(1, view.dpr);
    const extent = {
      x: (view.width / 2 + padding + extrusion + guard) / minRatio,
      y: (view.height / 2 + padding + extrusion + guard) / minRatio,
    };
    // Bound packing, uniform rounding, center projection and NDC/viewport arithmetic.
    // Huge lineweights/retention regions must fall back instead of cancelling large Float32s.
    const magnitude = Math.max(extent.x, extent.y) * maxRatio + padding + Math.max(view.width, view.height) / 2 + extrusion;
    if (!Number.isFinite(magnitude) || magnitude * 12 * 2 ** -23 * view.dpr > ZOOM_FLOAT_PIXEL_ERROR) throw new Error('GPU zoom geometry exceeds Float32 precision budget');
    if (styled.every((item): item is StyledZoomLine => item.entity.type === 'line')) return prepareZoomLines(state, view, styled, extent, padding, minRatio, maxRatio);
    const vertices: number[] = [], batches: StrokeBatch[] = [];
    const sourceBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
    const entities: PreparedZoom2D['entities'] = state.entities.length <= GPU_EDIT_ENTITY_LIMIT ? Array.from({ length: state.entities.length }, () => null) : null;
    let sourceIndex = 0;
    let admittedMinRatio = minRatio;
    for (const { entity, color, width, alpha } of styled) {
      const admitCurve = entity.type === 'line' ? undefined : (radius: number): void => {
        const projectedRadius = radius * view.scale;
        if (!Number.isFinite(projectedRadius)) throw new Error('Invalid curve radius or scale');
        // Tested Canvas/Skia wide-circle overlap preserves a hole that this strip union fills.
        // Other overlapping curve strokes are unproven; keep the complete view on Canvas.
        // Reserve the entire quarter-physical-pixel curve/Float32 budget at the inner edge.
        const innerLimit = width / 2 + PIXEL_ERROR / view.dpr;
        if (!(projectedRadius > innerLimit)) throw new Error(`Curve stroke overlap or precision margin requires Canvas rendering (${entity.id})`);
        const required = innerLimit / projectedRadius * (1 + 16 * Number.EPSILON);
        admittedMinRatio = Math.max(admittedMinRatio, Math.min(1, required));
      };
      const path = entityPath(entity, view, view.scale * maxRatio, ZOOM_CURVE_PIXEL_ERROR, width, admitCurve);
      const { points, bounds } = zoomLocalPoints(path.points, view);
      includeZoomBounds(sourceBounds, bounds);
      const first = vertices.length / GPU_ZOOM_VERTEX_STRIDE;
      zoomStrokeTriangles(points, path.closed, width, color, extent, vertices);
      const count = vertices.length / GPU_ZOOM_VERTEX_STRIDE - first;
      if (count) batches.push({ id: entity.id, first, count, alpha });
      if (entities) {
        while (state.entities[sourceIndex] !== entity) sourceIndex++;
        entities[sourceIndex++] = { entity, first, count, color, width, alpha, sourceBounds: bounds };
      }
    }
    if (!Number.isFinite(sourceBounds.min.x)) sourceBounds.min = sourceBounds.max = { x: 0, y: 0 };
    const packed = new Float32Array(vertices);
    if (!packed.every(Number.isFinite)) throw new Error('Float32 stroke geometry exceeds finite limits');
    // The rectangle was retained for the full requested interval. Narrowing admission above
    // keeps it conservative without a second geometry/rebase pass or larger GPU uploads.
    return { vertices: packed, batches, minRatio: admittedMinRatio, maxRatio, padding, sourceBounds, extent, entities, entityCount: visible.length };
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
}

/** All-or-nothing preparation. clipPadding retains a bounded CSS-pixel border for pure pans. */
export function prepare2D(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, clipPadding = 0): Prepared2D {
  validateGpu2DView(view);
  if (!Number.isFinite(clipPadding) || clipPadding < 0 || clipPadding > GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr)) throw new Error('Invalid GPU pan cache border');
  // Match the viewport: LAYON can make an imported frozen layer visible again.
  const hidden = new Set(state.layers.filter((layer) => !layer.visible).map((layer) => layer.name));
  const visible = state.entities.filter((entity) => !hidden.has(entity.layer));
  // Validate the full scene before doing any tessellation or allowing a submission.
  for (const entity of visible) {
    const problem = styleProblem(entity, state);
    if (problem) throw new Error(problem);
    if (overlay.selection.has(entity.id) && !overlay.solidSelection) throw new Error(`Dashed selection requires canvas rendering (${entity.id})`);
  }
  const vertices: number[] = [], batches: StrokeBatch[] = [];
  const precisionBound = MAX_PROJECTED_COORDINATE / Math.max(1, view.dpr);
  const panPrecisionMargin = { x: precisionBound, y: precisionBound };
  const previousPaper = colorDisplay.paper;
  const previousWeights = { ...lineweightDisplay };
  colorDisplay.paper = false;
  lineweightDisplay.enabled = view.lineweights ?? previousWeights.enabled;
  lineweightDisplay.pxPerMm = undefined;
  try {
    for (const entity of visible) {
      const selected = overlay.selection.has(entity.id), hovered = overlay.hover === entity.id && !selected;
      const color = cssRgb(resolveColor(entity, state.layers));
      if (!color) throw new Error(`Unsupported display color (${entity.id})`);
      const width = selected ? 2.5 : hovered ? 2 : resolveLineWidth(entity, state.layers, { scale: view.scale, toScreen: (point) => screenPoint(point, view) });
      const first = vertices.length / STRIDE;
      const path = entityPath(entity, view, view.scale, PIXEL_ERROR, width);
      // Include offscreen source points: clipping must not hide a later precision refusal.
      for (const point of path.points) {
        panPrecisionMargin.x = Math.min(panPrecisionMargin.x, precisionBound - Math.abs(point.x));
        panPrecisionMargin.y = Math.min(panPrecisionMargin.y, precisionBound - Math.abs(point.y));
      }
      strokeTriangles(path.points, path.closed, width, color, view, vertices, clipPadding);
      const count = vertices.length / STRIDE - first;
      if (count) batches.push({ id: entity.id, first, count, alpha: selected || hovered ? 0.95 : 1 });
    }
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
  const packed = new Float32Array(vertices);
  if (!packed.every(Number.isFinite)) throw new Error('Float32 stroke geometry exceeds finite limits');
  // Reserve a physical pixel for double-rounding and discarded curve seam samples near the bound.
  const reserve = 1 / Math.max(1, view.dpr);
  panPrecisionMargin.x = Math.max(0, panPrecisionMargin.x - reserve);
  panPrecisionMargin.y = Math.max(0, panPrecisionMargin.y - reserve);
  return { vertices: packed, batches, panPrecisionMargin };
}
