/**
 * NURBS curves for the SPLINE entity: evaluation (de Boor / Cox-de Boor basis),
 * tessellation into a polyline for rendering, snapping and hit testing, and
 * global interpolation through fit points (the SPLINE command's fit-point method).
 * Pure geometry; no entity types here.
 */
import type { Point } from './geometry';
import * as g from './geometry';

export interface NurbsCurve {
  readonly degree: number;
  readonly knots: readonly number[];
  readonly controlPoints: readonly Point[];
  /** Rational weights, one per control point (omitted = all 1). */
  readonly weights?: readonly number[];
}

/** True when the knot vector matches the control points and degree (m + 1 = n + p + 2). */
export function isValidNurbs(c: NurbsCurve): boolean {
  const n = c.controlPoints.length;
  if (c.degree < 1 || n < c.degree + 1) return false;
  if (c.knots.length !== n + c.degree + 1) return false;
  for (let i = 1; i < c.knots.length; i += 1) if (c.knots[i]! < c.knots[i - 1]! - 1e-12) return false;
  if (c.weights && c.weights.length !== n) return false;
  return c.knots[n]! - c.knots[c.degree]! > 1e-12;
}

/** Knot span index containing u (Piegl & Tiller A2.1), for the domain [U[p], U[n+1]]. */
export function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]!) {
    // last non-empty span
    let i = n;
    while (i > p && U[i]! >= U[n + 1]!) i -= 1;
    return i;
  }
  if (u <= U[p]!) {
    let i = p;
    while (i < n && U[i + 1]! <= U[p]!) i += 1;
    return i;
  }
  let low = p;
  let high = n + 1;
  let mid = Math.floor((low + high) / 2);
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
  }
  return mid;
}

/** Non-zero B-spline basis functions N[i-p..i] at u (Piegl & Tiller A2.2). */
export function basisFunctions(i: number, u: number, p: number, U: readonly number[]): number[] {
  const N = new Array<number>(p + 1).fill(0);
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j += 1) {
    left[j] = u - U[i + 1 - j]!;
    right[j] = U[i + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r += 1) {
      const den = right[r + 1]! + left[j - r]!;
      const temp = Math.abs(den) < 1e-300 ? 0 : N[r]! / den;
      N[r] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Parameter domain [U[p], U[n+1]] of a curve. */
export function nurbsDomain(c: NurbsCurve): [number, number] {
  const n = c.controlPoints.length - 1;
  return [c.knots[c.degree]!, c.knots[n + 1]!];
}

/** Point on the curve at parameter u. */
export function nurbsPoint(c: NurbsCurve, u: number): Point {
  const n = c.controlPoints.length - 1;
  const p = c.degree;
  const span = findSpan(n, p, u, c.knots);
  const N = basisFunctions(span, u, p, c.knots);
  let x = 0;
  let y = 0;
  let w = 0;
  for (let j = 0; j <= p; j += 1) {
    const k = span - p + j;
    const cp = c.controlPoints[k]!;
    const wt = c.weights?.[k] ?? 1;
    const f = N[j]! * wt;
    x += f * cp.x;
    y += f * cp.y;
    w += f;
  }
  return Math.abs(w) < 1e-300 ? c.controlPoints[0]! : { x: x / w, y: y / w };
}

/**
 * Tessellate a curve: every non-empty knot span is sampled `perSpan` times
 * (degree-1 curves keep their control polygon).
 */
export function nurbsPoints(c: NurbsCurve, perSpan = 12, maxPoints = 4000): Point[] {
  if (!isValidNurbs(c)) return [...c.controlPoints];
  const n = c.controlPoints.length - 1;
  const p = c.degree;
  const U = c.knots;
  const spans: Array<[number, number]> = [];
  for (let i = p; i <= n; i += 1) if (U[i + 1]! - U[i]! > 1e-12) spans.push([U[i]!, U[i + 1]!]);
  const steps = p === 1 ? 1 : Math.max(2, Math.min(perSpan, Math.floor(maxPoints / Math.max(1, spans.length))));
  const out: Point[] = [];
  for (const [a, b] of spans) {
    for (let k = 0; k < steps; k += 1) out.push(nurbsPoint(c, a + ((b - a) * k) / steps));
  }
  const [, end] = nurbsDomain(c);
  out.push(nurbsPoint(c, end));
  return out;
}

/** Clamped knot vector with uniformly spaced interior knots. */
export function clampedUniformKnots(controlCount: number, degree: number): number[] {
  const n = controlCount - 1;
  const m = n + degree + 1;
  const U: number[] = [];
  const interior = n - degree;
  for (let i = 0; i <= m; i += 1) {
    if (i <= degree) U.push(0);
    else if (i >= m - degree) U.push(1);
    else U.push((i - degree) / (interior + 1));
  }
  return U;
}

/** Solve A x = b (dense, partial pivoting). Returns null for a singular system. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) M[r]![k] = M[r]![k]! - f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

function solvePoints(A: number[][], rhs: Point[]): Point[] | null {
  const xs = solve(A, rhs.map((p) => p.x));
  const ys = solve(A, rhs.map((p) => p.y));
  if (!xs || !ys) return null;
  return xs.map((x, i) => ({ x, y: ys[i]! }));
}

/** Chord-length parameters in [0, 1]. */
function chordParams(Q: readonly Point[]): number[] {
  const d: number[] = [0];
  let total = 0;
  for (let i = 1; i < Q.length; i += 1) {
    total += g.dist(Q[i - 1]!, Q[i]!);
    d.push(total);
  }
  return d.map((v) => (total > 0 ? v / total : 0));
}

/** Drop consecutive duplicate points. */
function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) if (!out.length || !g.eq(out[out.length - 1]!, p, 1e-9)) out.push(p);
  return out;
}

export interface InterpolationOptions {
  /** Close the curve (the start point is repeated at the end, with a matching tangent). */
  closed?: boolean;
  /** End tangent directions (any length); estimated when omitted on a closed curve. */
  startTangent?: Point;
  endTangent?: Point;
  /** Maximum degree (3 = cubic, AutoCAD's default). */
  degree?: number;
}

/**
 * Global interpolation through fit points (Piegl & Tiller 9.2.1 / 9.2.2) with chord-length
 * parameters and averaged knots. Returns a clamped NURBS whose curve passes through every
 * fit point. Fewer than four points lower the degree (2 points = a line).
 */
export function interpolateFitPoints(fit: readonly Point[], opts: InterpolationOptions = {}): NurbsCurve | null {
  let Q = dedupe(fit);
  const closed = Boolean(opts.closed) && Q.length >= 3;
  if (closed) {
    if (g.eq(Q[0]!, Q[Q.length - 1]!, 1e-9)) Q = Q.slice(0, -1);
    Q = [...Q, Q[0]!];
  }
  if (Q.length < 2) return null;
  const n = Q.length - 1;
  const ub = chordParams(Q);
  let D0 = opts.startTangent;
  let Dn = opts.endTangent;
  if (closed && (!D0 || !Dn)) {
    // Central difference across the seam, in parameter units.
    const du = ub[1]! + (1 - ub[n - 1]!);
    const t = du > 1e-12 ? g.scale(g.sub(Q[1]!, Q[n - 1]!), 1 / du) : g.sub(Q[1]!, Q[n - 1]!);
    D0 = t;
    Dn = t;
  }
  const withDerivs = Boolean(D0 && Dn);
  const maxDeg = opts.degree ?? 3;
  if (!withDerivs) {
    const p = Math.min(maxDeg, n);
    const m = n + p + 1;
    const U: number[] = [];
    for (let i = 0; i <= p; i += 1) U.push(0);
    for (let j = 1; j <= n - p; j += 1) {
      let s = 0;
      for (let i = j; i <= j + p - 1; i += 1) s += ub[i]!;
      U.push(s / p);
    }
    for (let i = 0; i <= p; i += 1) U.push(1);
    if (U.length !== m + 1) return null;
    const A: number[][] = [];
    for (let k = 0; k <= n; k += 1) {
      const row = new Array<number>(n + 1).fill(0);
      const span = findSpan(n, p, ub[k]!, U);
      const N = basisFunctions(span, ub[k]!, p, U);
      for (let j = 0; j <= p; j += 1) row[span - p + j] = N[j]!;
      A.push(row);
    }
    const P = solvePoints(A, Q);
    return P ? { degree: p, knots: U, controlPoints: P } : null;
  }
  // End derivatives given: n + 3 control points.
  const p = Math.min(maxDeg, n + 2);
  const nc = n + 3; // control point count
  const m = nc - 1 + p + 1;
  const U: number[] = [];
  for (let i = 0; i <= p; i += 1) U.push(0);
  const interior = m + 1 - 2 * (p + 1);
  for (let j = 0; j < interior; j += 1) {
    let s = 0;
    let cnt = 0;
    for (let i = j; i <= j + p - 1; i += 1) {
      s += ub[Math.min(i, n)]!;
      cnt += 1;
    }
    U.push(s / cnt);
  }
  for (let i = 0; i <= p; i += 1) U.push(1);
  if (U.length !== m + 1) return null;
  const last = nc - 1;
  const A: number[][] = [];
  const rhs: Point[] = [];
  const row = () => new Array<number>(nc).fill(0);
  let r = row();
  r[0] = 1;
  A.push(r);
  rhs.push(Q[0]!);
  r = row();
  r[0] = -1;
  r[1] = 1;
  A.push(r);
  rhs.push(g.scale(D0!, U[p + 1]! / p));
  for (let k = 1; k < n; k += 1) {
    r = row();
    const span = findSpan(last, p, ub[k]!, U);
    const N = basisFunctions(span, ub[k]!, p, U);
    for (let j = 0; j <= p; j += 1) r[span - p + j] = N[j]!;
    A.push(r);
    rhs.push(Q[k]!);
  }
  r = row();
  r[last - 1] = -1;
  r[last] = 1;
  A.push(r);
  rhs.push(g.scale(Dn!, (1 - U[m - p - 1]!) / p));
  r = row();
  r[last] = 1;
  A.push(r);
  rhs.push(Q[n]!);
  const P = solvePoints(A, rhs);
  return P ? { degree: p, knots: U, controlPoints: P } : null;
}

/** Closest parameter-free distance from a point to a tessellated curve. */
export function distanceToPolyline(p: Point, pts: readonly Point[]): number {
  if (pts.length === 1) return g.dist(p, pts[0]!);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) best = Math.min(best, g.distToSegment(p, pts[i]!, pts[i + 1]!));
  return best;
}
