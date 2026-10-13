import type { ArcEntity, CircleEntity, LineEntity, PolylineEntity } from '../../core/entities';
import { polylineSegments } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { normAngle } from '../../core/geometry';
import type { Gpu2DView } from './geometry2d';
import { canvasArcAdmission } from './arc-admission';

type Primitive = LineEntity | PolylineEntity | CircleEntity | ArcEntity;
const RESERVE = 0.0625;
const TAU = Math.PI * 2;
function fail(reason: string): never { throw new Error(`Unsupported Canvas stroke construction: ${reason}`); }

/** Canvas's swapped negative-bulge arc adds a connector absent from GPU tessellation. */
export function canvasPolylineStrokeProblem(entity: PolylineEntity): string | null {
  return entity.bulges?.some((bulge) => Number.isFinite(bulge) && bulge <= -1e-12)
    ? 'Unsupported Canvas stroke construction: negative bulge has native connector' : null;
}
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const magnitude = (point: Point): number => Math.max(Math.abs(point.x), Math.abs(point.y));
const finite = (point: Point): Point => {
  if (![point.x, point.y].every(Number.isFinite)) fail('nonfinite native point');
  return point;
};
const subtract = (point: Point, center: Point): Point => finite({ x: point.x - center.x, y: point.y - center.y });
const unit = (vector: Point): Point => {
  const length = Math.hypot(vector.x, vector.y);
  if (!Number.isFinite(length)) fail('nonfinite stroke direction');
  return length ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
};

function project(point: Point, view: Gpu2DView): Point {
  const c = Math.cos(view.twist), s = Math.sin(view.twist);
  return finite({ x: view.width / 2 + (point.x * c - point.y * s) * view.scale, y: view.height / 2 - (point.x * s + point.y * c) * view.scale });
}

interface Direction { normal: Point; degenerate: boolean; uncertainty: number; curved: boolean }
interface Join { kind: 'none' | 'reversal' | 'miter' | 'bevel'; offset: Point; limitMargin: number }

function join(a: Point, b: Point, half: number): Join {
  const cross = a.x * b.y - a.y * b.x;
  if (Math.abs(cross) < 1e-12) return { kind: 'none', offset: { x: 0, y: 0 }, limitMargin: Infinity };
  const denominator = 1 + a.x * b.x + a.y * b.y;
  if (denominator <= 1e-12) return { kind: 'reversal', offset: { x: 0, y: 0 }, limitMargin: Infinity };
  const side = cross > 0 ? -1 : 1;
  const offset = { x: (a.x + b.x) * side * half / denominator, y: (a.y + b.y) * side * half / denominator };
  const length = Math.hypot(offset.x, offset.y);
  return { kind: length <= half * 10 ? 'miter' : 'bevel', offset: length <= half * 10 ? offset : { x: 0, y: 0 }, limitMargin: Math.abs(length - half * 10) };
}

function linearDirection(a: Point, b: Point, view: Gpu2DView, maxRatio: number): Direction {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  const n = unit({ x: -dy, y: dx });
  // Reserve floating projection/context-rotation arithmetic too. Its direction error
  // becomes significant on microscopic strokes even when point displacement is tiny.
  const rounding = Number.EPSILON * 64 * (Math.max(magnitude(a), magnitude(b)) * maxRatio + Math.max(view.width, view.height) + 128);
  return { normal: n, degenerate: length === 0, uncertainty: length ? Math.min(2, 4 * rounding / length) : 0, curved: false };
}

function offsetsProblem(local: readonly Direction[], native: readonly Direction[], closed: boolean, pointError: number, widthCss: number, view: Gpu2DView, maxRatio: number, compareJoins = true): void {
  if (local.length !== native.length) fail('segment topology changes');
  let error = pointError * maxRatio;
  const half = widthCss / 2;
  if (compareJoins) {
    const hasReal = local.some((direction) => !direction.degenerate);
    let before = false, remaining = local.filter((direction) => !direction.degenerate).length;
    for (let index = 0; index < local.length; index++) {
      if (!local[index]!.degenerate) remaining--;
      if (local[index]!.degenerate || native[index]!.degenerate) {
        if (closed && hasReal || before && remaining > 0) fail('internal degenerate join is unproved');
      }
      if (!local[index]!.degenerate) before = true;
    }
  }
  for (let index = 0; index < local.length; index++) {
    const a = local[index]!, b = native[index]!;
    if (a.degenerate !== b.degenerate) fail('segment degeneracy changes');
    const reserve = (a.uncertainty + b.uncertainty) * half;
    error = Math.max(error, pointError * maxRatio + distance(a.normal, b.normal) * half + reserve);
  }
  for (let index = closed ? 0 : 1; compareJoins && index < local.length; index++) {
    const previous = (index + local.length - 1) % local.length;
    const a0 = local[previous]!, a1 = local[index]!, b0 = native[previous]!, b1 = native[index]!;
    // Canvas prunes zero-length segments before joining; the GPU must not silently
    // omit a join across an internal repeated point. Ambiguous cases use the whole view.
    if (a0.degenerate || a1.degenerate || b0.degenerate || b1.degenerate) {
      if (closed || (index > 1 && index + 1 < local.length)) fail('internal degenerate join is unproved');
      continue;
    }
    if (a0.curved || a1.curved || b0.curved || b1.curved) {
      // Tessellation already bounds smooth curves and caps; a sharp curved join needs
      // an amplified miter bound beyond that existing allowance. Keep Canvas there.
      if (distance(a0.normal, a1.normal) > 1e-12 || distance(b0.normal, b1.normal) > 1e-12) fail('nonsmooth curved join is unproved');
      continue;
    }
    const a = join(a0.normal, a1.normal, half), b = join(b0.normal, b1.normal, half);
    if (a.kind !== b.kind) fail('miter or bevel branch changes');
    const uncertainty = (a0.uncertainty + a1.uncertainty + b0.uncertainty + b1.uncertainty) * half * 200;
    if (Math.min(a.limitMargin, b.limitMargin) <= uncertainty) fail('miter limit is within arithmetic uncertainty');
    error = Math.max(error, pointError * maxRatio + distance(a.offset, b.offset) + uncertainty);
  }
  if (!Number.isFinite(error) || error * view.dpr > RESERVE) fail('point, normal or miter exceeds precision budget');
}

/** Points in GPU anchor-local doubles versus actual Canvas world construction. */
export function assertStrokePathPrecision(localPoints: readonly Point[], nativePoints: readonly Point[], closed: boolean, widthCss: number, view: Gpu2DView, maxRatio: number, nativeIsLocal = false): void {
  if (localPoints.length !== nativePoints.length) fail('point topology changes');
  const a = localPoints.map((point) => project(finite(point), view));
  const b = nativePoints.map((point) => project(nativeIsLocal ? finite(point) : subtract(point, view.center), view));
  let error = 0;
  for (let index = 0; index < a.length; index++) error = Math.max(error, distance(a[index]!, b[index]!));
  const count = closed ? a.length : Math.max(0, a.length - 1);
  const directions = (points: readonly Point[]) => Array.from({ length: count }, (_, index) => linearDirection(points[index]!, points[(index + 1) % points.length]!, view, maxRatio));
  offsetsProblem(directions(a), directions(b), closed, error, widthCss, view, maxRatio);
}

interface Curve { center: Point; radius: number; startAngle: number; endAngle: number }
function angleDistance(a: number, b: number): number {
  const delta = normAngle(a - b);
  return Math.min(delta, TAU - delta);
}

function curveError(local: Curve, native: Curve, view: Gpu2DView, widthCss: number, maxRatio: number): number {
  const a = canvasArcAdmission(local), b = canvasArcAdmission(native);
  if (!a.ok || !b.ok || a.fullCircle !== b.fullCircle) fail('native curve sweep changes');
  // At parameter t the angle difference is startDelta + t*sweepDelta. Reserving
  // their sum covers the endpoint too; taking only their maximum can admit twice
  // the allowed displacement when the two differences have the same sign.
  const angle = a.fullCircle ? 0 : angleDistance(a.startAngle, b.startAngle) + Math.abs(a.sweep - b.sweep);
  const geometry = distance(local.center, subtract(native.center, view.center)) + Math.abs(local.radius - native.radius) + Math.max(local.radius, native.radius) * angle;
  const error = geometry * view.scale * maxRatio + widthCss / 2 * Math.min(2, angle);
  if (!Number.isFinite(error) || error * view.dpr > RESERVE) fail('native curve construction exceeds precision budget');
  return error / maxRatio;
}

export function assertPrimitiveStrokePrecision(local: Primitive, native: Primitive, widthCss: number, view: Gpu2DView, maxRatio: number): void {
  if (local.type !== native.type) fail('primitive topology changes');
  if (local.type === 'line' && native.type === 'line') return assertStrokePathPrecision([local.a, local.b], [native.a, native.b], false, widthCss, view, maxRatio);
  if ((local.type === 'circle' && native.type === 'circle') || (local.type === 'arc' && native.type === 'arc')) {
    curveError({ ...local, startAngle: local.type === 'arc' ? local.startAngle : 0, endAngle: local.type === 'arc' ? local.endAngle : TAU }, { ...native, startAngle: native.type === 'arc' ? native.startAngle : 0, endAngle: native.type === 'arc' ? native.endAngle : TAU }, view, widthCss, maxRatio);
    return;
  }
  if (local.type !== 'polyline' || native.type !== 'polyline' || local.closed !== native.closed || local.points.length !== native.points.length) fail('polyline topology changes');
  const problem = canvasPolylineStrokeProblem(local) ?? canvasPolylineStrokeProblem(native);
  if (problem) fail('negative bulge has native connector');
  if (!local.bulges?.some((value) => value !== 0) && !native.bulges?.some((value) => value !== 0)) return assertStrokePathPrecision(local.points, native.points, local.closed, widthCss, view, maxRatio);
  const a = polylineSegments(local), b = polylineSegments(native);
  if (a.length !== b.length) fail('bulge topology changes');
  let error = 0;
  const incoming: Direction[] = [], outgoing: Direction[] = [], nativeIncoming: Direction[] = [], nativeOutgoing: Direction[] = [];
  const tangent = (point: Point, center: Point, sign: number): Direction => {
    const radial = unit({ x: point.x - center.x, y: point.y - center.y });
    const vector = { x: -radial.y * sign, y: radial.x * sign };
    const c = Math.cos(view.twist), s = Math.sin(view.twist);
    const screen = { x: vector.x * c - vector.y * s, y: -(vector.x * s + vector.y * c) };
    return { normal: { x: -screen.y, y: screen.x }, degenerate: false, uncertainty: 0, curved: true };
  };
  for (let index = 0; index < a.length; index++) {
    const segment = a[index]!, reference = b[index]!;
    if (segment.bulge !== reference.bulge || !!segment.arc !== !!reference.arc) fail('native bulge geometry changes');
    error = Math.max(error, distance(project(segment.a, view), project(subtract(reference.a, view.center), view)), distance(project(segment.b, view), project(subtract(reference.b, view.center), view)));
    if (segment.arc && reference.arc) {
      error = Math.max(error, curveError(segment.arc, reference.arc, view, widthCss, maxRatio));
      const sign = Math.sign(segment.bulge);
      incoming.push(tangent(segment.a, segment.arc.center, sign)); outgoing.push(tangent(segment.b, segment.arc.center, sign));
      nativeIncoming.push(tangent(reference.a, reference.arc.center, sign)); nativeOutgoing.push(tangent(reference.b, reference.arc.center, sign));
    } else {
      const start = project(segment.a, view), end = project(segment.b, view), nativeStart = project(subtract(reference.a, view.center), view), nativeEnd = project(subtract(reference.b, view.center), view);
      const direction = linearDirection(start, end, view, maxRatio), nativeDirection = linearDirection(nativeStart, nativeEnd, view, maxRatio);
      incoming.push(direction); outgoing.push(direction); nativeIncoming.push(nativeDirection); nativeOutgoing.push(nativeDirection);
    }
  }
  // Compare caps and segment normals, then each ideal incoming/outgoing join.
  offsetsProblem(incoming, nativeIncoming, false, error, widthCss, view, maxRatio, false);
  offsetsProblem(outgoing, nativeOutgoing, false, error, widthCss, view, maxRatio, false);
  for (let index = local.closed ? 0 : 1; index < incoming.length; index++) {
    const previous = (index + incoming.length - 1) % incoming.length;
    offsetsProblem([outgoing[previous]!, incoming[index]!], [nativeOutgoing[previous]!, nativeIncoming[index]!], false, error, widthCss, view, maxRatio);
  }
}
