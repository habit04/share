/**
 * Planar profiles from 2D drawing entities: the "sketch" step before EXTRUDE and REVOLVE.
 *
 * Conventions:
 * - 2D entities live on the world XY plane (z = 0, AutoCAD WCS, right-handed, Z toward the
 *   viewer). Their flattened points are mapped into the target frame's local coordinates; every
 *   point must lie on the frame's XY plane within `tolerance`, otherwise the entity is refused.
 * - The resulting `Profile3D` has its loops in frame-local XY (drawing units): the outer loop
 *   first and counter-clockwise (seen from the frame's +Z), holes after it and clockwise. Loops
 *   are implicitly closed (the first point is not repeated).
 * - Curves are flattened deterministically: `segments` chords per full turn (default 32, clamped to
 *   [8, 256]) for circles, arcs, polyline bulges and ellipses (a partial turn gets
 *   ceil(segments * sweep / 2 pi) chords, at least one); splines get max(4, segments / 4) samples
 *   per knot span (the core NURBS sampler, which takes at least 64 samples per curve).
 * - `tolerance` (default 1e-6 drawing units, absolute) is used for endpoint matching when lines,
 *   arcs and open curves are chained into loops, for the on-plane test, for merging coincident
 *   consecutive points and for dropping vertices that lie on the straight line through their
 *   neighbours (so caps and side walls share the same vertices without zero-area triangles).
 *   Nothing else is altered: open, branching, self-intersecting, crossing or touching loops, more
 *   than one outer region and islands inside holes are refused with a message, never repaired.
 */
import { type ArcEntity, type EllipseEntity, type Entity, type PolylineEntity, type SplineEntity, ellipsePoint, ellipseSweep, polylineSegments, splineCurve } from '../core/entities';
import type { Point } from '../core/geometry';
import { normAngle } from '../core/geometry';
import { nurbsPoints, splineWorkProblem } from '../core/spline';
import { type Frame3, cross3, dot3, len3, transformPoint, worldToFrame } from './math';
import { loopSignedArea2 } from './triangulate';
import type { Profile3D } from './types';

/** Default absolute tolerance (drawing units) for chaining, on-plane tests and point merging. */
export const DEFAULT_SKETCH_TOLERANCE = 1e-6;
/** Default, minimum and maximum chords per full turn when flattening curves. */
export const DEFAULT_SKETCH_SEGMENTS = 32;
export const MIN_SKETCH_SEGMENTS = 8;
export const MAX_SKETCH_SEGMENTS = 256;
/**
 * Most points a profile may have (all loops together). Bounds the self-intersection test and the
 * ear-clipping triangulation, whose cost grows with points times reflex vertices.
 */
export const MAX_PROFILE_POINTS = 20_000;

export interface SketchOptions {
  /** Absolute tolerance in drawing units (default DEFAULT_SKETCH_TOLERANCE). */
  readonly tolerance?: number;
  /** Chords per full turn for curves (default DEFAULT_SKETCH_SEGMENTS, clamped to [8, 256]). */
  readonly segments?: number;
}

/** A flattened entity: world XY points, closed (a loop by itself) or open (to be chained). */
interface Piece {
  readonly label: string;
  readonly points: Point[];
  readonly closed: boolean;
}

interface Loop {
  readonly label: string;
  points: Point[];
}

class SketchError extends Error {}

const fmt = (v: number): string => String(Math.round(v * 1e6) / 1e6);
const at = (p: Point): string => `(${fmt(p.x)}, ${fmt(p.y)})`;
const labelOf = (e: Entity): string => `${e.type} ${e.id}`;

function chordsFor(sweep: number, segments: number): number {
  return Math.max(1, Math.ceil((segments * Math.abs(sweep)) / (2 * Math.PI) - 1e-9));
}

function polylinePiece(pl: PolylineEntity, segments: number): Piece {
  const label = labelOf(pl);
  const segs = polylineSegments(pl);
  if (segs.length === 0) throw new SketchError(`${label} has fewer than two vertices.`);
  const pts: Point[] = [];
  for (const s of segs) {
    pts.push(s.a);
    if (!s.arc) continue;
    const n = chordsFor(s.arc.sweep, segments);
    const a0 = Math.atan2(s.a.y - s.arc.center.y, s.a.x - s.arc.center.x);
    for (let k = 1; k < n; k++) {
      const t = a0 + (s.arc.sweep * k) / n;
      pts.push({ x: s.arc.center.x + s.arc.radius * Math.cos(t), y: s.arc.center.y + s.arc.radius * Math.sin(t) });
    }
  }
  if (!pl.closed) pts.push(segs[segs.length - 1]!.b);
  return { label, points: pts, closed: pl.closed };
}

function arcPiece(e: ArcEntity, segments: number): Piece {
  const label = labelOf(e);
  if (!(e.radius > 0) || !Number.isFinite(e.radius)) throw new SketchError(`${label} has an invalid radius.`);
  let sweep = normAngle(e.endAngle - e.startAngle);
  const full = sweep < 1e-9;
  if (full) sweep = 2 * Math.PI;
  const n = full ? segments : chordsFor(sweep, segments);
  const pts: Point[] = [];
  for (let k = 0; k <= (full ? n - 1 : n); k++) {
    const t = e.startAngle + (sweep * k) / n;
    pts.push({ x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t) });
  }
  return { label, points: pts, closed: full };
}

function ellipsePiece(e: EllipseEntity, segments: number): Piece {
  const label = labelOf(e);
  if (!(e.ratio > 0 && e.ratio <= 1) || !(Math.hypot(e.majorAxis.x, e.majorAxis.y) > 0)) throw new SketchError(`${label} has an invalid axis or ratio.`);
  const sweep = ellipseSweep(e);
  const full = sweep >= 2 * Math.PI - 1e-9;
  const n = full ? segments : chordsFor(sweep, segments);
  const pts: Point[] = [];
  for (let k = 0; k <= (full ? n - 1 : n); k++) pts.push(ellipsePoint(e, e.startParam + (sweep * k) / n));
  return { label, points: pts, closed: full };
}

function splinePiece(e: SplineEntity, segments: number, tol: number): Piece {
  const label = labelOf(e);
  let curve;
  try {
    curve = splineCurve(e);
  } catch (err) {
    throw new SketchError(`${label} cannot be evaluated: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (!curve) throw new SketchError(`${label} has no valid control or fit data.`);
  const perSpan = Math.max(4, Math.round(segments / 4));
  const problem = splineWorkProblem(curve, 0, {}, perSpan);
  if (problem) throw new SketchError(`${label}: ${problem}.`);
  const pts = nurbsPoints(curve, perSpan);
  const first = pts[0], last = pts[pts.length - 1];
  const closed = pts.length > 2 && !!first && !!last && Math.hypot(first.x - last.x, first.y - last.y) <= tol;
  if (closed) pts.pop();
  return { label, points: pts, closed };
}

function entityPiece(e: Entity, segments: number, tol: number): Piece {
  switch (e.type) {
    case 'polyline': return polylinePiece(e, segments);
    case 'line': return { label: labelOf(e), points: [e.a, e.b], closed: false };
    case 'circle': {
      if (!(e.radius > 0) || !Number.isFinite(e.radius)) throw new SketchError(`${labelOf(e)} has an invalid radius.`);
      const pts: Point[] = [];
      for (let k = 0; k < segments; k++) {
        const t = (2 * Math.PI * k) / segments;
        pts.push({ x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t) });
      }
      return { label: labelOf(e), points: pts, closed: true };
    }
    case 'arc': return arcPiece(e, segments);
    case 'ellipse': return ellipsePiece(e, segments);
    case 'spline': return splinePiece(e, segments, tol);
    default:
      throw new SketchError(`${labelOf(e)} cannot be part of a profile; use closed polylines, circles, ellipses, closed splines, or lines, arcs and open curves that join into closed loops.`);
  }
}

/** Grid key for endpoint matching (cells of size `cell`). */
const cellKey = (x: number, y: number): string => `${x},${y}`;

/**
 * Join open pieces into closed loops by matching endpoints within `tol`. Every endpoint must meet
 * exactly one other endpoint (of another piece, or the other end of the same piece).
 */
function chainPieces(open: readonly Piece[], tol: number): Loop[] {
  if (open.length === 0) return [];
  const ends: Point[] = [];
  for (const p of open) ends.push(p.points[0]!, p.points[p.points.length - 1]!);
  // Tolerance 0 matches exact coordinates only: key the points themselves instead of grid cells.
  const exact = tol === 0;
  const cellOf = (q: Point): [number, number] => (exact ? [q.x, q.y] : [Math.floor(q.x / tol), Math.floor(q.y / tol)]);
  const grid = new Map<string, number[]>();
  for (const [k, q] of ends.entries()) {
    const key = cellKey(...cellOf(q));
    const list = grid.get(key);
    if (list) list.push(k); else grid.set(key, [k]);
  }
  const partner = new Int32Array(ends.length).fill(-1);
  for (const [k, q] of ends.entries()) {
    const [cx, cy] = cellOf(q);
    // Neighbouring cell keys can coincide (coordinates so large that cx +- 1 rounds to cx), so each
    // distinct cell is scanned once and matches are collected as a set.
    const cells = new Set<string>();
    if (exact) cells.add(cellKey(cx, cy));
    else for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(cellKey(cx + dx, cy + dy));
    const found = new Set<number>();
    for (const key of cells) {
      for (const j of grid.get(key) ?? []) {
        if (j === k) continue;
        const r = ends[j]!;
        if (Math.hypot(r.x - q.x, r.y - q.y) <= tol) found.add(j);
      }
    }
    const matches = [...found];
    const piece = open[k >> 1]!;
    if (matches.length === 0) throw new SketchError(`The profile is not closed: the ${k & 1 ? 'end' : 'start'} of ${piece.label} at ${at(q)} does not meet another curve.`);
    if (matches.length > 1) throw new SketchError(`The boundary branches at ${at(q)}: ${matches.length + 1} curve ends meet there, and a profile loop must not branch.`);
    partner[k] = matches[0]!;
  }
  const used = new Uint8Array(open.length);
  const loops: Loop[] = [];
  for (let start = 0; start < open.length; start++) {
    if (used[start]) continue;
    const pts: Point[] = [];
    const labels: string[] = [];
    // Walk from the start piece's start endpoint (index 2 * start) forward.
    let piece = start, entry = 2 * start;
    for (;;) {
      used[piece] = 1;
      const p = open[piece]!;
      labels.push(p.label);
      const forward = entry === 2 * piece;
      const seq = forward ? p.points : [...p.points].reverse();
      for (let i = 0; i < seq.length - 1; i++) pts.push(seq[i]!);
      const exit = forward ? 2 * piece + 1 : 2 * piece;
      const next = partner[exit]!;
      if (next === 2 * start) break;
      piece = next >> 1;
      entry = next;
      if (used[piece]) throw new SketchError(`The boundary through ${p.label} does not close into a single loop.`);
    }
    const label = labels.length === 1 ? labels[0]! : labels.length <= 3 ? `the loop formed by ${labels.join(', ')}` : `the loop formed by ${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
    loops.push({ label, points: pts });
  }
  return loops;
}

/** Distance from p to the segment a-b. */
function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * Remove consecutive points closer than `tol` (including last-to-first), then drop vertices that
 * lie on the straight line through their neighbours: a run of vertices is dropped only when every
 * one of them is within `tol` of the chord that replaces it and the outline keeps going forward
 * (a vertex where the outline doubles back is kept so the intersection test reports it). The
 * loop keeps its starting point when that point survives, and at least three points.
 */
function cleanLoop(points: readonly Point[], tol: number): Point[] {
  const pts: { p: Point; i: number }[] = [];
  for (const [i, p] of points.entries()) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.p.x, p.y - last.p.y) > tol) pts.push({ p, i });
  }
  while (pts.length > 1 && Math.hypot(pts[0]!.p.x - pts[pts.length - 1]!.p.x, pts[0]!.p.y - pts[pts.length - 1]!.p.y) <= tol) pts.pop();
  const n = pts.length;
  if (n <= 3) return pts.map((q) => q.p);
  // Start at the lowest-leftmost point: a corner of the convex hull, never dropped.
  let s = 0;
  for (let i = 1; i < n; i++) if (pts[i]!.p.x < pts[s]!.p.x || (pts[i]!.p.x === pts[s]!.p.x && pts[i]!.p.y < pts[s]!.p.y)) s = i;
  const keep = [pts[s]!];
  let pending: Point[] = [];
  let removed = 0;
  for (let k = 1; k < n; k++) {
    const a = keep[keep.length - 1]!.p, b = pts[(s + k) % n]!.p, c = pts[(s + k + 1) % n]!.p;
    const straight = n - removed > 3
      && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0
      && distToSegment(b, a, c) <= tol
      && pending.every((q) => distToSegment(q, a, c) <= tol);
    if (straight) { pending.push(b); removed++; continue; }
    keep.push(pts[(s + k) % n]!);
    pending = [];
  }
  // Restore the original starting point, so the loop order does not depend on the hull corner.
  let first = 0;
  for (let i = 1; i < keep.length; i++) if (keep[i]!.i < keep[first]!.i) first = i;
  return [...keep.slice(first), ...keep.slice(0, first)].map((q) => q.p);
}

interface Seg {
  readonly loop: number;
  readonly index: number;
  readonly a: Point;
  readonly b: Point;
  readonly minX: number;
  readonly maxX: number;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True when two segments cross, touch or come within `tol` of each other. */
function segmentsMeet(p1: Point, p2: Point, q1: Point, q2: Point, tol: number): boolean {
  const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2), d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return Math.min(distToSegment(p1, q1, q2), distToSegment(p2, q1, q2), distToSegment(q1, p1, p2), distToSegment(q2, p1, p2)) <= tol;
}

/**
 * Find the first pair of segments that cross or touch (sweep over X with pruning): null when every
 * loop is simple and no two loops meet. Adjacent segments of one loop share a vertex; they only
 * count when one folds back onto the other.
 */
function findIntersection(loops: readonly Loop[], tol: number): { a: Seg; b: Seg; where: Point } | null {
  const segs: Seg[] = [];
  for (const [li, loop] of loops.entries()) {
    const n = loop.points.length;
    for (let i = 0; i < n; i++) {
      const a = loop.points[i]!, b = loop.points[(i + 1) % n]!;
      segs.push({ loop: li, index: i, a, b, minX: Math.min(a.x, b.x) - tol, maxX: Math.max(a.x, b.x) + tol });
    }
  }
  segs.sort((s, t) => s.minX - t.minX);
  const active: Seg[] = [];
  for (const s of segs) {
    for (let k = active.length - 1; k >= 0; k--) if (active[k]!.maxX < s.minX) active.splice(k, 1);
    for (const t of active) {
      if (Math.min(s.a.y, s.b.y) - tol > Math.max(t.a.y, t.b.y) || Math.min(t.a.y, t.b.y) - tol > Math.max(s.a.y, s.b.y)) continue;
      if (s.loop === t.loop) {
        const n = loops[s.loop]!.points.length;
        const next = (t.index + 1) % n === s.index, prev = (s.index + 1) % n === t.index;
        if (next || prev) {
          // Shared vertex: a problem only when the far end of one lies on the other (a spike).
          const [first, second] = next ? [t, s] : [s, t];
          if (n > 2 && (distToSegment(second.b, first.a, first.b) <= tol || distToSegment(first.a, second.a, second.b) <= tol)) return { a: first, b: second, where: first.b };
          continue;
        }
      }
      if (segmentsMeet(s.a, s.b, t.a, t.b, tol)) return { a: t, b: s, where: s.a };
    }
    active.push(s);
  }
  return null;
}

/** Even-odd point-in-polygon test (the point is assumed not to lie on the boundary). */
function pointInLoop(p: Point, loop: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!, b = loop[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Check simple, non-meeting loops for nesting and order them: exactly one outer loop (contained in
 * no other), every other loop directly inside it. Returns the outer index and the holes in order.
 */
function nestLoops(loops: readonly Loop[]): { outer: number; holes: number[] } {
  const depth = loops.map((l, i) => loops.reduce((d, other, j) => (j !== i && pointInLoop(l.points[0]!, other.points) ? d + 1 : d), 0));
  const outers = depth.flatMap((d, i) => (d === 0 ? [i] : []));
  if (outers.length !== 1) throw new SketchError(`The selection forms ${outers.length} separate regions; a profile needs exactly one outer boundary (extrude or revolve them one at a time).`);
  const island = depth.findIndex((d) => d > 1);
  if (island >= 0) throw new SketchError(`${loops[island]!.label} lies inside a hole of the profile; islands inside holes are not supported.`);
  return { outer: outers[0]!, holes: depth.flatMap((d, i) => (d === 1 ? [i] : [])) };
}

function checkLoops(loops: readonly Loop[], tol: number): void {
  let total = 0;
  for (const l of loops) {
    if (l.points.length < 3) throw new SketchError(`${l.label} is degenerate: it has fewer than three distinct corners.`);
    let perimeter = 0;
    for (let i = 0; i < l.points.length; i++) {
      const a = l.points[i]!, b = l.points[(i + 1) % l.points.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (Math.abs(loopSignedArea2(l.points)) / 2 <= tol * perimeter) throw new SketchError(`${l.label} encloses no area.`);
    total += l.points.length;
  }
  if (total > MAX_PROFILE_POINTS) throw new SketchError(`The profile has ${total.toLocaleString('en-US')} points after flattening; the limit is ${MAX_PROFILE_POINTS.toLocaleString('en-US')} (use fewer segments or simpler curves).`);
  const hit = findIntersection(loops, tol);
  if (hit) {
    const la = loops[hit.a.loop]!.label, lb = loops[hit.b.loop]!.label;
    throw new SketchError(hit.a.loop === hit.b.loop ? `${la} intersects itself near ${at(hit.where)}.` : `${la} and ${lb} cross or touch near ${at(hit.where)}.`);
  }
}

/** Frame check shared by the sketch step and sweeps: finite, orthonormal and right-handed. */
export function validateFrame(frame: Frame3): string | null {
  const { origin, xAxis, yAxis, zAxis } = frame;
  for (const v of [origin, xAxis, yAxis, zAxis]) if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return 'the profile frame has non-finite coordinates';
  const unit = (v: typeof xAxis) => Math.abs(len3(v) - 1) <= 1e-9;
  if (!unit(xAxis) || !unit(yAxis) || !unit(zAxis)) return 'the profile frame axes are not unit length';
  if (Math.abs(dot3(xAxis, yAxis)) > 1e-9 || Math.abs(dot3(xAxis, zAxis)) > 1e-9 || Math.abs(dot3(yAxis, zAxis)) > 1e-9) return 'the profile frame axes are not perpendicular';
  if (dot3(cross3(xAxis, yAxis), zAxis) < 0) return 'the profile frame is left-handed (z must equal x cross y)';
  return null;
}

/**
 * Build a planar profile from 2D entities, mapped into `frame`. Returns `{ profile }` or
 * `{ error }` with a user-facing message naming the offending entity or position. See the module
 * comment for the accepted entities, flattening, tolerance and loop conventions.
 */
export function profileFromEntities(entities: readonly Entity[], frame: Frame3, opts: SketchOptions = {}): { profile: Profile3D } | { error: string } {
  const tol = opts.tolerance ?? DEFAULT_SKETCH_TOLERANCE;
  if (!(tol >= 0) || !Number.isFinite(tol)) return { error: 'The sketch tolerance must be a finite, non-negative number.' };
  const raw = opts.segments ?? DEFAULT_SKETCH_SEGMENTS;
  const segments = Number.isFinite(raw) ? Math.min(MAX_SKETCH_SEGMENTS, Math.max(MIN_SKETCH_SEGMENTS, Math.round(raw))) : DEFAULT_SKETCH_SEGMENTS;
  const frameProblem = validateFrame(frame);
  if (frameProblem) return { error: `Cannot build a profile: ${frameProblem}.` };
  if (entities.length === 0) return { error: 'Select at least one closed boundary (closed polyline, circle, ellipse, closed spline, or lines and arcs forming a closed loop).' };
  try {
    const toLocal = worldToFrame(frame);
    const pieces: Piece[] = [];
    for (const e of entities) {
      const piece = entityPiece(e, segments, tol);
      for (const p of piece.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new SketchError(`${piece.label} has non-finite coordinates.`);
        const off = Math.abs(transformPoint(toLocal, { x: p.x, y: p.y, z: 0 }).z);
        if (off > tol) throw new SketchError(`${piece.label} does not lie on the sketch plane (it is ${fmt(off)} units away).`);
      }
      if (!piece.closed && piece.points.length >= 2) {
        const a = piece.points[0]!, b = piece.points[piece.points.length - 1]!;
        if (piece.points.length === 2 && Math.hypot(a.x - b.x, a.y - b.y) <= tol) throw new SketchError(`${piece.label} has zero length.`);
      }
      pieces.push(piece);
    }
    const loops: Loop[] = pieces.filter((p) => p.closed).map((p) => ({ label: p.label, points: p.points }));
    loops.push(...chainPieces(pieces.filter((p) => !p.closed), tol));
    // Map into frame-local coordinates, then clean and check in the plane of the profile.
    for (const l of loops) {
      l.points = cleanLoop(l.points.map((p) => {
        const q = transformPoint(toLocal, { x: p.x, y: p.y, z: 0 });
        return { x: q.x, y: q.y };
      }), tol);
    }
    checkLoops(loops, tol);
    const { outer, holes } = nestLoops(loops);
    const oriented = (pts: Point[], ccw: boolean) => (loopSignedArea2(pts) > 0 === ccw ? pts : [...pts].reverse());
    const out = [oriented(loops[outer]!.points, true), ...holes.map((h) => oriented(loops[h]!.points, false))];
    return { profile: { frame, loops: out } };
  } catch (err) {
    if (err instanceof SketchError) return { error: err.message };
    throw err;
  }
}

/**
 * Check a stored or hand-built profile before it is swept: a valid right-handed orthonormal frame,
 * at least one loop, every loop with three or more finite points and non-zero area, the outer loop
 * counter-clockwise and holes clockwise, no loop intersecting itself or another (`tolerance`,
 * default 0, makes near-contacts count as well), every hole inside the outer loop and no hole
 * inside another, and at most MAX_PROFILE_POINTS points. Null when valid, else the reason.
 */
export function validateProfile(profile: Profile3D, tolerance = 0): string | null {
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile.loops)) return 'the profile is malformed';
  const frameProblem = validateFrame(profile.frame);
  if (frameProblem) return frameProblem;
  if (profile.loops.length === 0) return 'the profile has no loops';
  const loops: Loop[] = [];
  for (const [i, pts] of profile.loops.entries()) {
    if (!Array.isArray(pts)) return 'the profile is malformed';
    for (const p of pts) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return `profile loop ${i + 1} has non-finite coordinates`;
    loops.push({ label: i === 0 ? 'the outer loop' : `hole ${i}`, points: [...pts] });
  }
  try {
    for (const l of loops) {
      if (l.points.length < 3) return `${l.label} has fewer than three points`;
      if (loopSignedArea2(l.points) === 0) return `${l.label} encloses no area`;
      for (let i = 0; i < l.points.length; i++) {
        const a = l.points[i]!, b = l.points[(i + 1) % l.points.length]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(tolerance, 0)) return `${l.label} repeats a point`;
      }
    }
    checkLoops(loops, Math.max(tolerance, 0));
    const { outer, holes } = nestLoops(loops);
    if (outer !== 0) return 'the first loop must be the outer boundary';
    if (holes.length !== loops.length - 1) return 'a hole lies outside the outer boundary';
  } catch (err) {
    if (err instanceof SketchError) return err.message.replace(/\.$/, '');
    throw err;
  }
  if (loopSignedArea2(loops[0]!.points) < 0) return 'the outer loop must be counter-clockwise';
  for (let i = 1; i < loops.length; i++) if (loopSignedArea2(loops[i]!.points) > 0) return `hole ${i} must be clockwise`;
  return null;
}
