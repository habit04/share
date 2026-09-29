/**
 * HATCH patterns and pattern-line generation.
 *
 * Pattern definitions follow the AutoCAD .pat semantics: each line family is
 * `angle, x-origin, y-origin, delta-x, delta-y [, dash-1, dash-2, ...]` where
 * delta-x runs along the line, delta-y is the perpendicular spacing between
 * successive lines, positive dashes are pen-down, negative pen-up and 0 a dot.
 * A hatch's angle rotates the whole pattern and its scale multiplies every
 * length. Lines are clipped to the boundary loops with the even-odd rule
 * (AutoCAD's "Normal" island detection).
 */
import type { Point } from './geometry';
import * as g from './geometry';

/** One line family of a pattern, in .pat units (degrees, drawing units at scale 1). */
export interface PatternLine {
  readonly angle: number;
  readonly origin: Point;
  readonly offset: Point;
  readonly dashes: readonly number[];
}

export interface HatchPattern {
  readonly name: string;
  readonly description: string;
  readonly lines: readonly PatternLine[];
}

const L = (angle: number, ox: number, oy: number, dx: number, dy: number, ...dashes: number[]): PatternLine => ({ angle, origin: { x: ox, y: oy }, offset: { x: dx, y: dy }, dashes });

/** Predefined patterns (imperial acad.pat definitions). */
export const HATCH_PATTERNS: Readonly<Record<string, HatchPattern>> = {
  ANSI31: { name: 'ANSI31', description: 'ANSI Iron, Brick, Stone masonry', lines: [L(45, 0, 0, 0, 0.125)] },
  ANSI32: { name: 'ANSI32', description: 'ANSI Steel', lines: [L(45, 0, 0, 0, 0.375), L(45, 0.176776695, 0, 0, 0.375)] },
  ANSI33: { name: 'ANSI33', description: 'ANSI Bronze, Brass, Copper', lines: [L(45, 0, 0, 0, 0.25), L(45, 0.176776695, 0, 0, 0.25, 0.125, -0.0625)] },
  ANSI34: {
    name: 'ANSI34',
    description: 'ANSI Plastic, Rubber',
    lines: [L(45, 0, 0, 0, 0.75), L(45, 0.176776695, 0, 0, 0.75), L(45, 0.353553391, 0, 0, 0.75), L(45, 0.530330086, 0, 0, 0.75)],
  },
  ANSI35: { name: 'ANSI35', description: 'ANSI Fire brick, Refractory material', lines: [L(45, 0, 0, 0, 0.25), L(45, 0.176776695, 0, 0, 0.25, 0.3125, -0.0625, 0, -0.0625)] },
  ANSI36: { name: 'ANSI36', description: 'ANSI Marble, Slate, Glass', lines: [L(45, 0, 0, 0.21875, 0.125, 0.3125, -0.0625, 0, -0.0625)] },
  ANSI37: { name: 'ANSI37', description: 'ANSI Lead, Zinc, Magnesium, Sound/Heat/Elec Insulation', lines: [L(45, 0, 0, 0, 0.125), L(135, 0, 0, 0, 0.125)] },
  ANSI38: { name: 'ANSI38', description: 'ANSI Aluminum', lines: [L(45, 0, 0, 0, 0.125), L(135, 0, 0, 0.25, 0.125, 0.3125, -0.1875)] },
  NET: { name: 'NET', description: 'Horizontal / vertical grid', lines: [L(0, 0, 0, 0, 0.125), L(90, 0, 0, 0, 0.125)] },
  NET3: { name: 'NET3', description: 'Network pattern 0-60-120', lines: [L(0, 0, 0, 0, 0.125), L(60, 0, 0, 0, 0.125), L(120, 0, 0, 0, 0.125)] },
  DOTS: { name: 'DOTS', description: 'Series of dots', lines: [L(0, 0, 0, 0.03125, 0.0625, 0, -0.0625)] },
  LINE: { name: 'LINE', description: 'Parallel horizontal lines', lines: [L(0, 0, 0, 0, 0.125)] },
  BRICK: { name: 'BRICK', description: 'Brick or masonry-type surface', lines: [L(0, 0, 0, 0, 0.25), L(90, 0, 0, 0.25, 0.25, 0.25, -0.25)] },
  SOLID: { name: 'SOLID', description: 'Solid fill', lines: [] },
};

export const PATTERN_NAMES = Object.keys(HATCH_PATTERNS);

export function findPattern(name: string): HatchPattern | undefined {
  return HATCH_PATTERNS[name.trim().toUpperCase()];
}

/** A pattern line family in world space (what DXF stores in the 53/43/44/45/46/49 groups). */
export interface WorldPatternLine {
  /** Radians. */
  readonly angle: number;
  readonly base: Point;
  /** Offset between successive lines, world vector. */
  readonly offset: Point;
  readonly dashes: readonly number[];
}

/** World-space line families for a named pattern at a hatch angle (radians), scale and origin. */
export function worldPatternLines(pattern: HatchPattern, angle: number, scale: number, origin: Point = { x: 0, y: 0 }): WorldPatternLine[] {
  const s = scale > 0 ? scale : 1;
  return pattern.lines.map((l) => {
    const a = g.rad(l.angle) + angle;
    return {
      angle: a,
      base: g.add(origin, g.rotate(g.scale(l.origin, s), angle)),
      offset: g.rotate(g.scale(l.offset, s), a),
      dashes: l.dashes.map((d) => d * s),
    };
  });
}

/** A boundary loop: closed polyline, optional per-vertex bulges. */
export interface HatchLoop {
  readonly points: readonly Point[];
  readonly bulges?: readonly number[];
}

/** Tessellate a bulged closed loop into polygon vertices (no repeated start point). */
export function loopPolygon(loop: HatchLoop): Point[] {
  const pts = loop.points;
  const n = pts.length;
  if (!loop.bulges || !loop.bulges.some((b) => Math.abs(b) > 1e-12)) return [...pts];
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    out.push(a);
    const bulge = loop.bulges[i] ?? 0;
    if (Math.abs(bulge) < 1e-12 || g.eq(a, b)) continue;
    const sweep = 4 * Math.atan(bulge);
    const chord = g.dist(a, b);
    const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    const m = g.mid(a, b);
    const dd = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
    const nrm = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
    const side = Math.abs(sweep) <= Math.PI ? Math.sign(sweep) : -Math.sign(sweep);
    const c = { x: m.x + nrm.x * dd * side, y: m.y + nrm.y * dd * side };
    const a0 = g.angleOf(c, a);
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 16)));
    for (let k = 1; k < steps; k += 1) out.push(g.polar(c, a0 + (sweep * k) / steps, r));
  }
  return out;
}

/** Even-odd point containment against several loops. */
export function pointInLoops(p: Point, polys: readonly (readonly Point[])[]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export interface PatternGeometry {
  /** Dash segments (a dot is a zero-length segment). */
  segments: Array<[Point, Point]>;
  /** The pattern was too dense to generate (AutoCAD: "Hatch spacing too dense"). */
  dense: boolean;
}

/**
 * Clip every line family to the loops (even-odd) and cut dashes. `maxSegments` bounds the
 * work for absurd scales; beyond it the result is flagged dense and left empty.
 */
export function patternSegments(polys: readonly (readonly Point[])[], lines: readonly WorldPatternLine[], maxSegments = 40000): PatternGeometry {
  const segments: Array<[Point, Point]> = [];
  const all: Point[] = [];
  for (const poly of polys) all.push(...poly);
  const box = g.boundsOfPoints(all);
  if (!box) return { segments, dense: false };
  const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
  const edges: Array<[Point, Point]> = [];
  for (const poly of polys) for (let i = 0; i < poly.length; i += 1) edges.push([poly[i]!, poly[(i + 1) % poly.length]!]);
  for (const fam of lines) {
    const u = { x: Math.cos(fam.angle), y: Math.sin(fam.angle) };
    const nrm = { x: -u.y, y: u.x };
    const spacing = g.dot(fam.offset, nrm);
    if (Math.abs(spacing) < 1e-9) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of corners) {
      const v = g.dot(g.sub(c, fam.base), nrm) / spacing;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const k0 = Math.ceil(lo - 1e-9);
    const k1 = Math.floor(hi + 1e-9);
    if (k1 - k0 > maxSegments) return { segments: [], dense: true };
    const period = fam.dashes.reduce((s, d) => s + Math.abs(d), 0);
    for (let k = k0; k <= k1; k += 1) {
      const origin = g.add(fam.base, g.scale(fam.offset, k));
      // Crossings of the line with the boundary edges, as distances along u from `origin`.
      const ts: number[] = [];
      for (const [a, b] of edges) {
        const aa = g.dot(g.sub(a, origin), nrm);
        const bb = g.dot(g.sub(b, origin), nrm);
        if (aa > 0 === bb > 0) continue;
        const ta = g.dot(g.sub(a, origin), u);
        const tb = g.dot(g.sub(b, origin), u);
        ts.push(ta + ((tb - ta) * aa) / (aa - bb));
      }
      if (ts.length < 2) continue;
      ts.sort((x, y) => x - y);
      const at = (t: number): Point => g.add(origin, g.scale(u, t));
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i]!;
        const t1 = ts[i + 1]!;
        if (t1 - t0 < 1e-12) continue;
        if (fam.dashes.length === 0 || period < 1e-12) {
          segments.push([at(t0), at(t1)]);
        } else {
          // The dash pattern starts at the line's origin; the along-line part of the offset shifts it per line.
          let pos = Math.floor(t0 / period) * period;
          let guard = 0;
          while (pos <= t1 && guard < 100000) {
            for (const d of fam.dashes) {
              const len = Math.abs(d);
              if (d > 0) {
                const s0 = Math.max(pos, t0);
                const s1 = Math.min(pos + len, t1);
                if (s1 > s0) segments.push([at(s0), at(s1)]);
              } else if (d === 0 && pos >= t0 && pos <= t1) {
                const p = at(pos);
                segments.push([p, p]);
              }
              pos += len;
              if (pos > t1) break;
            }
            guard += 1;
          }
        }
        if (segments.length > maxSegments) return { segments: [], dense: true };
      }
    }
  }
  return { segments, dense: false };
}

/** Signed area of a polygon (positive = counter-clockwise). */
export function polygonArea(poly: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Builds a closed loop (vertices + bulges) from boundary edges. */
export class LoopBuilder {
  pts: Point[] = [];
  bulges: number[] = [];
  segment(a: Point, b: Point, bulge: number): void {
    const last = this.pts[this.pts.length - 1];
    if (!last) {
      this.pts.push(a);
      this.bulges.push(0);
    } else if (!g.eq(last, a, 1e-7)) {
      this.pts.push(a);
      this.bulges.push(0);
    }
    this.bulges[this.bulges.length - 1] = bulge;
    this.pts.push(b);
    this.bulges.push(0);
  }
  polyline(points: readonly Point[]): void {
    for (let i = 0; i + 1 < points.length; i += 1) this.segment(points[i]!, points[i + 1]!, 0);
  }
  /** Arc edge: angles in radians, sweep signed (negative = clockwise). Split so every piece is under a half turn. */
  arc(c: Point, r: number, a0: number, sweep: number): void {
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - 1e-9));
    for (let k = 0; k < n; k += 1) {
      const s = a0 + (sweep * k) / n;
      const e = a0 + (sweep * (k + 1)) / n;
      this.segment(g.polar(c, s, r), g.polar(c, e, r), Math.tan(sweep / n / 4));
    }
  }
  loop(): HatchLoop | null {
    const pts = [...this.pts];
    const bul = [...this.bulges];
    if (pts.length > 1 && g.eq(pts[0]!, pts[pts.length - 1]!, 1e-7)) {
      pts.pop();
      bul.pop();
    }
    if (pts.length < 2) return null;
    return { points: pts, ...(bul.some((b) => Math.abs(b) > 1e-12) ? { bulges: bul } : {}) };
  }
}

/** Arc sweep from DXF hatch-edge angles (degrees); clockwise edges store negated angles. */
export function edgeArc(startDeg: number, endDeg: number, ccw: boolean): { a0: number; sweep: number } {
  if (ccw) {
    const a0 = g.rad(startDeg);
    let sweep = g.normAngle(g.rad(endDeg) - a0);
    if (sweep < 1e-9) sweep = 2 * Math.PI;
    return { a0, sweep };
  }
  const a0 = -g.rad(startDeg);
  const a1 = -g.rad(endDeg);
  let sweep = g.normAngle(a0 - a1);
  if (sweep < 1e-9) sweep = 2 * Math.PI;
  return { a0, sweep: -sweep };
}

/**
 * Reconcile a named pattern with the definition lines stored in a file. The file's lines win:
 * an ISO drawing's ANSI31 is 25.4 times the imperial one at "scale 1", so the effective scale and
 * angle are derived from the lines; double hatches or lines that do not match the table are kept
 * as world-space lines.
 */
export function fitPatternToLines(
  pattern: HatchPattern | undefined,
  angle: number,
  scale: number,
  lines: readonly WorldPatternLine[],
  double: boolean,
): { angle: number; scale: number; origin?: Point; patternLines?: WorldPatternLine[] } {
  if (!lines.length) return { angle, scale };
  if (!pattern || !pattern.lines.length || double || lines.length !== pattern.lines.length) return { angle, scale, patternLines: [...lines] };
  const t0 = pattern.lines[0]!;
  const unit = g.len(t0.offset);
  const eff = unit > 1e-12 ? g.len(lines[0]!.offset) / unit : scale;
  const effAngle = g.normAngle(lines[0]!.angle - g.rad(t0.angle));
  const origin = g.sub(lines[0]!.base, g.rotate(g.scale(t0.origin, eff), effAngle));
  const expect = worldPatternLines(pattern, effAngle, eff, origin);
  const same = expect.every((l, i) => {
    const f = lines[i]!;
    const da = Math.abs(Math.sin(l.angle - f.angle));
    return da < 1e-6 && g.dist(l.offset, f.offset) < 1e-6 * Math.max(1, eff) && l.dashes.length === f.dashes.length && l.dashes.every((d, k) => Math.abs(d - f.dashes[k]!) < 1e-6 * Math.max(1, eff));
  });
  if (!same || !(eff > 0)) return { angle, scale, patternLines: [...lines] };
  return { angle: effAngle, scale: eff, ...(g.len(origin) > 1e-12 ? { origin } : {}) };
}

