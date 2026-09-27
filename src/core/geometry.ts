/** Basic 2D geometry helpers. World coordinates are Y-up. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const EPS = 1e-9;

export const pt = (x: number, y: number): Point => ({ x, y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
export const len = (a: Point): number => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const eq = (a: Point, b: Point, tol = EPS): boolean => dist(a, b) <= tol;

export function normalize(a: Point): Point {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotate(p: Point, angle: number, about: Point = { x: 0, y: 0 }): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

export const polar = (from: Point, angle: number, distance: number): Point => ({
  x: from.x + Math.cos(angle) * distance,
  y: from.y + Math.sin(angle) * distance,
});

export const angleOf = (from: Point, to: Point): number => Math.atan2(to.y - from.y, to.x - from.x);

/** Normalise an angle to [0, 2π). */
export function normAngle(a: number): number {
  const t = 2 * Math.PI;
  let r = a % t;
  if (r < 0) r += t;
  return r;
}

/** True when angle `a` lies on the CCW sweep from `start` to `end`. */
export function angleInSweep(a: number, start: number, end: number): boolean {
  const s = normAngle(start);
  let e = normAngle(end);
  let t = normAngle(a);
  if (e <= s + EPS) e += 2 * Math.PI;
  if (t < s - EPS) t += 2 * Math.PI;
  return t >= s - EPS && t <= e + EPS;
}

/** Closest point on segment ab to p. */
export function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return a;
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return add(a, scale(ab, t));
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  return dist(p, closestOnSegment(p, a, b));
}

/** Intersection of two segments (not lines). Returns null when parallel or outside. */
export function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const qp = sub(b1, a1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return add(a1, scale(r, t));
}

/** Intersections of a segment with a circle. */
export function segmentCircleIntersections(a: Point, b: Point, c: Point, r: number): Point[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  disc = Math.sqrt(disc);
  const out: Point[] = [];
  for (const t of [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) {
    if (t >= -EPS && t <= 1 + EPS) out.push(add(a, scale(d, t)));
  }
  if (out.length === 2 && eq(out[0]!, out[1]!)) out.pop();
  return out;
}

export function circleCircleIntersections(c1: Point, r1: number, c2: Point, r2: number): Point[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const u = normalize(sub(c2, c1));
  const p = add(c1, scale(u, a));
  const perp = { x: -u.y, y: u.x };
  if (h < EPS) return [p];
  return [add(p, scale(perp, h)), sub(p, scale(perp, h))];
}

export interface Bounds {
  min: Point;
  max: Point;
}

export function boundsOfPoints(points: readonly Point[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y) },
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y;
}

export function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.min.x >= outer.min.x && inner.max.x <= outer.max.x && inner.min.y >= outer.min.y && inner.max.y <= outer.max.y
  );
}

export function pointInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
}

export function roundTo(v: number, step: number): number {
  if (step <= 0) return v;
  return Math.round(v / step) * step;
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;
