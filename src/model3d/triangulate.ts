/**
 * Ear-clipping triangulation of a simple polygon with holes, used for the planar caps of extruded
 * and revolved profiles.
 *
 * Conventions:
 * - Input loops are 2D points (any units, Y up). The first loop is the outer boundary, the others
 *   are holes; loops are implicitly closed (the last point connects to the first, which is not
 *   repeated). Holes may be given in either orientation; they are traversed opposite to the outer
 *   loop internally.
 * - The output is a flat list of triangle corner indices into the concatenation of the loops
 *   (outer points first, then each hole in order), three per triangle. Every triangle has the same
 *   orientation as the outer loop: counter-clockwise for a counter-clockwise outer loop (the
 *   profile convention, see sketch.ts), clockwise for a clockwise one.
 * - No point is added, moved or dropped, so the triangles use exactly the loop vertices and the
 *   cap edges match the side walls of a sweep vertex for vertex. A polygon of n points with h holes
 *   gives n + 2h - 2 triangles.
 *
 * Method (D. Eberly, "Triangulation by Ear Clipping", 2002): every hole is joined to the outer
 * boundary by a bridge from its rightmost vertex to a vertex of the boundary visible from it
 * (found by casting a ray toward +X, then preferring the reflex vertex inside the bridge triangle
 * with the smallest angle to the ray), duplicating the two bridge vertices. The resulting single
 * polygon is clipped ear by ear; an ear is a convex corner whose triangle contains no reflex
 * vertex. Bridging works on the polygon rotated by 180 degrees (which keeps orientation), so the
 * search can be written for the leftmost vertex and a ray toward -X.
 *
 * The input must be a valid profile: loops simple, not crossing or touching each other, holes
 * inside the outer loop (sketch.ts `validateProfile` checks this). Invalid input throws an Error
 * instead of returning a partial or overlapping triangulation. Exactly collinear vertices are
 * kept; if they leave no strictly convex ear the clipper accepts a zero-area ear rather than fail.
 */
import type { Point } from '../core/geometry';

interface Node {
  /** Index into the concatenated loop points. */
  readonly i: number;
  /** Coordinates (rotated by 180 degrees, see the module comment). */
  readonly x: number;
  readonly y: number;
  prev: Node;
  next: Node;
  reflex: boolean;
  removed: boolean;
}

/** Twice the signed area of triangle (a, b, c): positive when a -> b -> c turns left (counter-clockwise). */
function cross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Twice the signed area of a closed loop (positive for counter-clockwise). */
export function loopSignedArea2(loop: readonly Point[]): number {
  let s = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const p = loop[j]!, q = loop[i]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

function makeNode(i: number, x: number, y: number): Node {
  const n = { i, x, y, reflex: false, removed: false } as Node;
  n.prev = n;
  n.next = n;
  return n;
}

/** Link a loop's points into a ring traversed counter-clockwise (ccw) or clockwise; returns one node. */
function ring(loop: readonly Point[], base: number, ccw: boolean, flip: number): Node {
  const forward = (loopSignedArea2(loop) * flip > 0) === ccw;
  let first: Node | null = null, last: Node | null = null;
  const n = loop.length;
  for (let k = 0; k < n; k++) {
    const j = forward ? k : n - 1 - k;
    const p = loop[j]!;
    // Rotate by 180 degrees (and mirror X for a clockwise outer loop, see triangulatePolygon).
    const node = makeNode(base + j, -p.x * flip, -p.y);
    if (!first) first = node;
    else { last!.next = node; node.prev = last!; }
    last = node;
  }
  last!.next = first!;
  first!.prev = last!;
  return first!;
}

/** Inclusive point-in-triangle test for either triangle orientation. */
function inTriangle(a: Node, b: Node, c: Node, p: { x: number; y: number }): boolean {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

/** True when the diagonal from `a` toward `b` starts inside the polygon's interior angle at `a`. */
function locallyInside(a: Node, b: Node): boolean {
  return cross(a.prev, a, a.next) >= 0
    ? cross(a, b, a.next) <= 0 && cross(a, a.prev, b) <= 0
    : cross(a, b, a.prev) > 0 || cross(a, a.next, b) > 0;
}

/** For two nodes at the same position, true when the wedge at `p` lies inside the wedge at `m`. */
function sectorContainsSector(m: Node, p: Node): boolean {
  return cross(m.prev, m, p.prev) > 0 && cross(p.next, m, m.next) > 0;
}

/**
 * The outer-ring node to bridge the hole vertex `h` to (the hole's leftmost vertex in rotated
 * coordinates, i.e. its rightmost one in the input): cast a ray toward -X, take the nearest edge
 * it hits, then the visible vertex of smallest angle. Throws when no edge is hit (hole outside
 * the outer loop) or the hole touches the boundary.
 */
function findBridge(h: Node, outer: Node): Node {
  const hx = h.x, hy = h.y;
  let qx = -Infinity;
  let m: Node | null = null;
  let p = outer;
  do {
    // Edges going downward (in rotated coordinates) can be hit from inside, the interior being on their left.
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) throw new Error('Triangulation failed: a hole touches the outer boundary.');
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) throw new Error('Triangulation failed: a hole lies outside the outer boundary.');
  // Reflex vertices inside the triangle (hole point, ray hit, m) would block the bridge to m; the
  // one with the smallest angle to the ray is visible instead.
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x) {
      const a = makeNode(-1, hy < my ? hx : qx, hy), c = makeNode(-1, hy < my ? qx : hx, hy), b = makeNode(-1, mx, my);
      if (inTriangle(a, b, c, p)) {
        const tan = Math.abs(hy - p.y) / (hx - p.x);
        if (locallyInside(p, h) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
          m = p;
          tanMin = tan;
        }
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

/** Join ring `b` (a hole, at its bridge vertex) into the ring of `a` with a two-way bridge a -> b ... b' -> a'. */
function splice(a: Node, b: Node): void {
  const a2 = makeNode(a.i, a.x, a.y), b2 = makeNode(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
}

/** The leftmost node of a ring (lowest y on ties, then first in ring order). */
function leftmost(start: Node): Node {
  let p = start, best = start;
  do {
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) best = p;
    p = p.next;
  } while (p !== start);
  return best;
}

/**
 * Triangulate a polygon with holes; see the module comment for conventions. Returns triangle
 * corner indices into the concatenated loops (three per triangle). Throws an Error for fewer than
 * three outer points, a hole with fewer than three points, non-finite or zero-area loops, a hole
 * outside or touching the outer loop, or a polygon that cannot be clipped (self-intersecting).
 */
export function triangulatePolygon(loops: readonly (readonly Point[])[]): number[] {
  const outerLoop = loops[0];
  if (!outerLoop || outerLoop.length < 3) throw new Error('Triangulation needs an outer loop of at least 3 points.');
  let total = 0;
  for (const [k, loop] of loops.entries()) {
    if (loop.length < 3) throw new Error(`Triangulation failed: loop ${k + 1} has fewer than 3 points.`);
    for (const p of loop) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Triangulation failed: a point is not finite.');
    if (loopSignedArea2(loop) === 0) throw new Error(`Triangulation failed: loop ${k + 1} has zero area.`);
    total += loop.length;
  }
  // A clockwise outer loop is mirrored in X so the algorithm always sees a counter-clockwise one;
  // triangles found counter-clockwise there are clockwise in the input, preserving orientation.
  const flip = loopSignedArea2(outerLoop) > 0 ? 1 : -1;
  const outer = ring(outerLoop, 0, true, flip);
  let base = outerLoop.length;
  const holes: Node[] = [];
  for (let k = 1; k < loops.length; k++) {
    const loop = loops[k]!;
    holes.push(leftmost(ring(loop, base, false, flip)));
    base += loop.length;
  }
  holes.sort((a, b) => a.x - b.x || a.y - b.y || a.i - b.i);
  for (const h of holes) splice(findBridge(h, outer), h);

  const out: number[] = [];
  const expected = total + 2 * holes.length - 2;
  const reflexNodes: Node[] = [];
  let p = outer;
  do {
    p.reflex = cross(p.prev, p, p.next) <= 0;
    if (p.reflex) reflexNodes.push(p);
    p = p.next;
  } while (p !== outer);

  const isEar = (b: Node, allowFlat: boolean): boolean => {
    const a = b.prev, c = b.next;
    const turn = cross(a, b, c);
    if (turn < 0 || (turn === 0 && !allowFlat)) return false;
    for (const r of reflexNodes) {
      if (r.removed || !r.reflex || r === a || r === b || r === c) continue;
      // Bridge duplicates share a corner's position; they cannot be strictly inside.
      if ((r.x === a.x && r.y === a.y) || (r.x === b.x && r.y === b.y) || (r.x === c.x && r.y === c.y)) continue;
      if (inTriangle(a, b, c, r)) return false;
    }
    return true;
  };

  let ear = outer;
  let remaining = total + 2 * holes.length;
  let stop = ear;
  let allowFlat = false;
  while (remaining > 3) {
    if (isEar(ear, allowFlat)) {
      const a = ear.prev, c = ear.next;
      out.push(a.i, ear.i, c.i);
      a.next = c; c.prev = a;
      ear.removed = true;
      remaining--;
      // Only the neighbours' corners change; a convex corner never becomes reflex by clipping.
      if (a.reflex) a.reflex = cross(a.prev, a, a.next) <= 0;
      if (c.reflex) c.reflex = cross(c.prev, c, c.next) <= 0;
      allowFlat = false;
      ear = c.next;
      stop = ear;
      continue;
    }
    ear = ear.next;
    if (ear === stop) {
      if (allowFlat) throw new Error('Triangulation failed: the polygon intersects itself or its holes overlap.');
      allowFlat = true;
    }
  }
  out.push(ear.prev.i, ear.i, ear.next.i);
  if (out.length !== 3 * expected) throw new Error('Triangulation failed: unexpected triangle count.');
  return out;
}
