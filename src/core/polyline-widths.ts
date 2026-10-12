import * as g from './geometry';
import type { Point } from './geometry';
import type { PolylineEntity } from './entities';
import { polylineSegments, bulgeArc } from './entities';
import { GeometryBudgetError } from './geometry-budget-error';
import { isImmutableData } from './immutable-data';

type Frame = NonNullable<PolylineEntity['widthFrame']>;
interface WidthGeometry { polygons: Point[][]; thin: Point[][]; strokes: Array<{ polygon: Point[]; spines: Point[][] }>; maxWidth: number }
const cache = new WeakMap<PolylineEntity, WidthGeometry>();
const checkedPoint = (point: Point): Point => {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new GeometryBudgetError('Polyline width geometry exceeds finite coordinate limits.');
  return point;
};

export function polylineFramePoint(frame: Frame, point: Point): Point {
  return checkedPoint({ x: frame.origin.x + frame.x.x * point.x + frame.y.x * point.y, y: frame.origin.y + frame.x.y * point.x + frame.y.y * point.y });
}
export function polylineFrameSource(entity: PolylineEntity): PolylineEntity {
  const frame = entity.widthFrame!;
  return { ...entity, points: frame.points, bulges: frame.bulges, width: frame.width, widths: frame.widths, widthFrame: undefined };
}
export function transformWidthFrame(frame: Frame, tf: (point: Point) => Point): Frame {
  const origin = checkedPoint(tf(frame.origin));
  return { ...frame, origin, x: checkedPoint(g.sub(tf(g.add(frame.origin, frame.x)), origin)), y: checkedPoint(g.sub(tf(g.add(frame.origin, frame.y)), origin)) };
}
export function polylineWidthFrame(entity: PolylineEntity, tf: (point: Point) => Point): Frame {
  return transformWidthFrame(entity.widthFrame ?? { points: entity.points, bulges: entity.bulges, width: entity.width, widths: entity.widths, origin: { x: 0, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } }, tf);
}

/** Nonnegative segment widths, with explicit per-vertex zero overriding a constant width. */
export function polylineWidthProblem(entity: PolylineEntity): string | null {
  if (entity.widthFrame) {
    for (const point of [entity.widthFrame.origin, entity.widthFrame.x, entity.widthFrame.y]) if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'polyline width frame must contain finite coordinates';
    if (!Array.isArray(entity.widthFrame.points) || entity.widthFrame.points.length !== entity.points.length) return 'polyline width frame must preserve the original vertices';
  }
  const source = entity.widthFrame ? polylineFrameSource(entity) : entity;
  if (source.widths && !Array.isArray(source.widths)) return 'polyline widths must be an array';
  if (source.width !== undefined && (typeof source.width !== 'number' || !Number.isFinite(source.width) || source.width < 0)) return 'polyline width must be finite and nonnegative';
  if (source.widths && source.widths.length !== source.points.length) return 'polyline widths must have one start/end pair per vertex';
  for (let i = 0; i < source.points.length; i++) {
    const width = source.widths?.[i];
    if (source.widths && (!width || typeof width.start !== 'number' || typeof width.end !== 'number' || !Number.isFinite(width.start) || !Number.isFinite(width.end) || width.start < 0 || width.end < 0)) return `invalid start/end width at vertex ${i + 1}`;
    const h = Math.max(width?.start ?? source.width ?? 0, width?.end ?? source.width ?? 0) / 2;
    const point = source.points[i]!;
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'polyline vertices must contain finite coordinates';
    if (!Number.isFinite(Math.abs(point.x) + h) || !Number.isFinite(Math.abs(point.y) + h)) return 'polyline width geometry exceeds finite coordinate limits';
    if (i + 1 < source.points.length || source.closed) {
      const end = source.points[(i + 1) % source.points.length]!;
      if (!Number.isFinite(end.x - point.x) || !Number.isFinite(end.y - point.y)) return 'polyline segment exceeds finite coordinate limits';
      const bulge = source.bulges?.[i] ?? 0;
      if (!Number.isFinite(bulge)) return 'polyline bulges must be finite';
      const arc = bulgeArc(point, end, bulge);
      if (arc && (!Number.isFinite(Math.abs(arc.center.x) + arc.radius + h) || !Number.isFinite(Math.abs(arc.center.y) + arc.radius + h))) return 'polyline arc width exceeds finite coordinate limits';
      if (entity.widthFrame) {
        const frame = entity.widthFrame;
        const x = arc ? Math.abs(arc.center.x) + arc.radius + h : Math.max(Math.abs(point.x), Math.abs(end.x)) + h;
        const y = arc ? Math.abs(arc.center.y) + arc.radius + h : Math.max(Math.abs(point.y), Math.abs(end.y)) + h;
        if (!Number.isFinite(Math.abs(frame.origin.x) + Math.abs(frame.x.x) * x + Math.abs(frame.y.x) * y) || !Number.isFinite(Math.abs(frame.origin.y) + Math.abs(frame.x.y) * x + Math.abs(frame.y.y) * y)) return 'polyline affine width exceeds finite coordinate limits';
      }
    }
  }
  return null;
}

/** Stretch an affine polyline's native vertex in its source coordinates. */
export function moveWidthFrameGrip(frame: Frame, index: number, point: Point): Frame {
  const magnitude = Math.max(Math.abs(frame.x.x), Math.abs(frame.x.y), Math.abs(frame.y.x), Math.abs(frame.y.y));
  const x = g.scale(frame.x, 1 / magnitude), y = g.scale(frame.y, 1 / magnitude);
  const delta = g.scale(g.sub(point, frame.origin), 1 / magnitude), determinant = g.cross(x, y);
  if (!Number.isFinite(determinant) || determinant === 0) throw new GeometryBudgetError('A degenerate polyline width frame cannot be stretched.');
  const local = checkedPoint({ x: g.cross(delta, y) / determinant, y: g.cross(x, delta) / determinant });
  return { ...frame, points: frame.points.map((p, i) => i === index ? local : p) };
}

/** Shared bounded fill outlines. Arc sides are sampled at most 64 times per segment. */
export function polylineWidthGeometry(entity: PolylineEntity): WidthGeometry {
  const immutable = isImmutableData(entity);
  const hit = immutable ? cache.get(entity) : undefined;
  if (hit) return hit;
  const invalid = polylineWidthProblem(entity);
  if (invalid) throw new GeometryBudgetError(invalid);
  const source = entity.widthFrame ? polylineFrameSource(entity) : entity;
  const transform = (point: Point) => entity.widthFrame ? polylineFramePoint(entity.widthFrame, point) : checkedPoint(point);
  const polygons: Point[][] = [], thin: Point[][] = [], strokes: WidthGeometry['strokes'] = [];
  let maxWidth = 0;
  const segments = polylineSegments(source);
  const ends: Array<{ a: Point; leftStart: Point; leftEnd: Point; rightStart: Point; rightEnd: Point; spine: Point[] }> = [];
  segments.forEach((segment, index) => {
    const start = source.widths ? source.widths[index]?.start ?? 0 : source.width ?? 0;
    const end = source.widths ? source.widths[index]?.end ?? 0 : source.width ?? 0;
    maxWidth = Math.max(maxWidth, start, end);
    const steps = segment.arc ? Math.max(2, Math.ceil(Math.abs(segment.arc.sweep) / (Math.PI / 32))) : 1;
    const left: Point[] = [], right: Point[] = [], spine: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, h = (start * (1 - t) + end * t) / 2;
      let point: Point, normal: Point;
      if (segment.arc) {
        const arc = segment.arc;
        const angle = g.angleOf(arc.center, segment.a) + arc.sweep * t;
        point = g.polar(arc.center, angle, arc.radius);
        normal = { x: -Math.sign(arc.sweep) * Math.cos(angle), y: -Math.sign(arc.sweep) * Math.sin(angle) };
      } else {
        point = { x: segment.a.x * (1 - t) + segment.b.x * t, y: segment.a.y * (1 - t) + segment.b.y * t };
        const direction = g.normalize(g.sub(segment.b, segment.a));
        normal = { x: -direction.y, y: direction.x };
      }
      spine.push(transform(point));
      left.push(transform(g.add(point, g.scale(normal, h))));
      right.push(transform(g.sub(point, g.scale(normal, h))));
    }
    if (start === 0 && end === 0) thin.push(spine);
    else { const polygon = [...left, ...[...right].reverse()]; polygons.push(polygon); strokes.push({ polygon, spines: [spine] }); }
    ends.push({ a: spine[0]!, leftStart: left[0]!, leftEnd: left[left.length - 1]!, rightStart: right[0]!, rightEnd: right[right.length - 1]!, spine });
  });
  // Bevel joins avoid an unbounded miter spike at nearly reversing segments. Width changes
  // at a vertex retain both segment widths, with the common vertex filling the small wedge.
  for (let i = source.closed ? 0 : 1; i < ends.length; i++) {
    const before = ends[(i + ends.length - 1) % ends.length]!, after = ends[i]!;
    for (const [a, b] of [[before.leftEnd, after.leftStart], [before.rightEnd, after.rightStart]]) if (!g.eq(a!, b!)) {
      const polygon = [a!, b!, after.a]; polygons.push(polygon); strokes.push({ polygon, spines: [before.spine, after.spine] });
    }
  }
  // This finite upper bound is used only to stroke a dash mask inside the checked outline.
  // Multiply first so a zero width remains zero even for very large finite frame axes.
  if (entity.widthFrame) maxWidth = Math.min(Number.MAX_VALUE, Math.hypot(maxWidth * entity.widthFrame.x.x, maxWidth * entity.widthFrame.x.y) + Math.hypot(maxWidth * entity.widthFrame.y.x, maxWidth * entity.widthFrame.y.y));
  const result = { polygons, thin, strokes, maxWidth };
  if (immutable) cache.set(entity, result);
  return result;
}
