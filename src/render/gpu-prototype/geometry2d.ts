import type { DrawingState } from '../../core/document';
import type { Entity, PolylineEntity } from '../../core/entities';
import { polylineSegments } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { EPS, normAngle } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { colorDisplay, lineweightDisplay, resolveColor, resolveLineWidth } from '../draw';

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
}

const MAX_CURVE_SEGMENTS = 32768;
const MAX_VERTICES = 1_000_000;
const PIXEL_ERROR = 0.25; // Physical pixels, including high-DPI views.
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

function curveCount(radius: number, sweep: number, view: Gpu2DView): number {
  const pixels = radius * view.scale * view.dpr;
  if (!Number.isFinite(pixels) || radius < 0) throw new Error('Invalid curve radius or scale');
  if (pixels === 0) return 1;
  // Stable sagitta formula, even when the radius dwarfs the pixel tolerance.
  const step = Math.min(Math.PI / 2, 4 * Math.asin(Math.sqrt(Math.min(1, PIXEL_ERROR / pixels / 2))));
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  if (!Number.isFinite(count) || count > MAX_CURVE_SEGMENTS) throw new Error('Curve tessellation exceeds prototype budget');
  return count;
}

function arcPath(center: Point, radius: number, start: number, sweep: number, view: Gpu2DView): Point[] {
  checked(center);
  if (![radius, start, sweep].every(Number.isFinite)) throw new Error('Invalid arc geometry');
  const count = curveCount(radius, sweep, view);
  const path: Point[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = start + sweep * i / count;
    // center is already relative to the camera: never add small offsets to world coordinates.
    path.push(projectLocal({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }, view));
  }
  return path;
}

function entityPath(entity: Entity, view: Gpu2DView): { points: Point[]; closed: boolean } {
  const local = (point: Point): Point => checked({ x: point.x - view.center.x, y: point.y - view.center.y });
  switch (entity.type) {
    case 'line': return { points: [screenPoint(entity.a, view), screenPoint(entity.b, view)], closed: false };
    case 'circle': {
      const points = arcPath(local(entity.center), entity.radius, 0, Math.PI * 2, view);
      points.pop();
      return { points, closed: true };
    }
    case 'arc': {
      if (![entity.startAngle, entity.endAngle].every(Number.isFinite)) throw new Error('Invalid arc angles');
      let sweep = normAngle(entity.endAngle - entity.startAngle);
      if (sweep < EPS) sweep = Math.PI * 2;
      return { points: arcPath(local(entity.center), entity.radius, entity.startAngle, sweep, view), closed: false };
    }
    case 'polyline': {
      // Rebase BEFORE bulgeArc computes its midpoint/center, preserving close-zoom arcs.
      const rebased: PolylineEntity = { ...entity, points: entity.points.map(local) };
      const points: Point[] = rebased.points.length ? [projectLocal(rebased.points[0]!, view)] : [];
      for (const segment of polylineSegments(rebased)) {
        if (!Number.isFinite(segment.bulge)) throw new Error('Invalid polyline bulge');
        if (segment.arc) {
          const arc = segment.arc;
          const curve = arcPath(arc.center, arc.radius, arc.sweep > 0 ? arc.startAngle : arc.endAngle, arc.sweep, view);
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
function clippedTriangle(triangle: Point[], width: number, height: number): Point[] {
  let polygon = triangle;
  for (const [axis, limit, greater] of [['x', 0, true], ['x', width, false], ['y', 0, true], ['y', height, false]] as const) {
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

function strokeTriangles(source: readonly Point[], closed: boolean, width: number, color: [number, number, number], view: Gpu2DView, output: number[]): void {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Invalid lineweight');
  const points = source.filter((point, index) => index === 0 || point.x !== source[index - 1]!.x || point.y !== source[index - 1]!.y);
  if (points.length < 2) return; // Canvas butt-capped degenerate paths paint nothing.
  const triangle = (a: Point, b: Point, c: Point): void => {
    const polygon = clippedTriangle([checked(a), checked(b), checked(c)], view.width, view.height);
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
  if (entity.type === 'polyline') {
    const problem = polylineWidthProblem(entity);
    if (problem) return `${problem} (${entity.id})`;
    if (entity.filled || entity.widthFrame || (entity.width ?? 0) !== 0 || entity.widths?.some((width) => width.start !== 0 || width.end !== 0)) return `Unsupported polyline width or fill (${entity.id})`;
  }
  return null;
}

/** All-or-nothing preparation. A refusal never exposes a partial drawing. */
export function prepare2D(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): Prepared2D {
  if (![view.width, view.height, view.dpr, view.scale, view.center.x, view.center.y, view.twist].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.dpr <= 0 || view.scale <= 0) throw new Error('Invalid GPU view');
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
      const path = entityPath(entity, view);
      strokeTriangles(path.points, path.closed, width, color, view, vertices);
      const count = vertices.length / STRIDE - first;
      if (count) batches.push({ id: entity.id, first, count, alpha: selected || hovered ? 0.95 : 1 });
    }
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
  const packed = new Float32Array(vertices);
  if (!packed.every(Number.isFinite)) throw new Error('Float32 stroke geometry exceeds finite limits');
  return { vertices: packed, batches };
}
