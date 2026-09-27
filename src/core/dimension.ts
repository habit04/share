/**
 * Dimension entities and the geometry that draws them (extension lines,
 * dimension line, closed-filled arrowheads and text), following the AutoCAD
 * "Standard" dimension style: DIMTXT 0.18, DIMASZ 0.18, DIMEXO 0.0625,
 * DIMEXE 0.18, DIMGAP 0.09, DIMCEN 0.09, DIMTAD 0 (text centred in a broken
 * dimension line), DIMTIH/DIMTOH 1 (horizontal text for radial/angular).
 */
import type { Point } from './geometry';
import * as g from './geometry';
import type { EntityBase, LineEntity, PolylineEntity, TextEntity, ArcEntity } from './entities';
import { formatLength, formatAngle, type LinearUnits } from './units';

export type DimKind = 'linear' | 'aligned' | 'radius' | 'diameter' | 'angular';

export interface DimStyle {
  readonly name: string;
  /** DIMTXT */
  readonly textHeight: number;
  /** DIMASZ */
  readonly arrowSize: number;
  /** DIMEXO: gap between the origin and the start of the extension line. */
  readonly extOffset: number;
  /** DIMEXE: how far the extension line runs past the dimension line. */
  readonly extExtend: number;
  /** DIMGAP */
  readonly textGap: number;
  /** DIMCEN: centre mark size for radial dimensions (0 = none). */
  readonly centerMark: number;
  /** DIMSCALE: overall scale applied to all sizes above. */
  readonly scale: number;
  /** DIMDEC */
  readonly decimals: number;
  /** DIMLUNIT */
  readonly lunit: LinearUnits;
  /** DIMADEC */
  readonly angularDecimals: number;
}

export const STANDARD_DIMSTYLE: DimStyle = {
  name: 'Standard',
  textHeight: 0.18,
  arrowSize: 0.18,
  extOffset: 0.0625,
  extExtend: 0.18,
  textGap: 0.09,
  centerMark: 0.09,
  scale: 1,
  decimals: 4,
  lunit: 2,
  angularDecimals: 0,
};

/** ISO-25, the metric default (millimetre drawings). */
export const ISO25_DIMSTYLE: DimStyle = {
  name: 'ISO-25',
  textHeight: 2.5,
  arrowSize: 2.5,
  extOffset: 0.625,
  extExtend: 1.25,
  textGap: 0.625,
  centerMark: 2.5,
  scale: 1,
  decimals: 2,
  lunit: 2,
  angularDecimals: 0,
};

export interface DimensionEntity extends EntityBase {
  readonly type: 'dimension';
  readonly kind: DimKind;
  /**
   * linear/aligned: extension line origins.
   * radius/diameter: p1 = centre, p2 = a point on the circle (sets the direction).
   * angular: points on the two legs.
   */
  readonly p1: Point;
  readonly p2: Point;
  /**
   * linear/aligned: a point on the dimension line.
   * radius/diameter: where the text goes (inside or outside the circle).
   * angular: a point on the dimension arc.
   */
  readonly linePoint: Point;
  /** linear only: direction of the dimension line (0 horizontal, π/2 vertical). */
  readonly rotation: number;
  /** angular: the vertex. */
  readonly center?: Point;
  /** Text override: undefined/'' = measurement, '<>' inserts the measurement, ' ' suppresses. */
  readonly text?: string;
  /** User-moved text centre (undefined = default placement). */
  readonly textPosition?: Point;
  readonly style: DimStyle;
}

export type DimPart = LineEntity | PolylineEntity | TextEntity | ArcEntity;
export type Measure = (text: string, height: number) => number;

/** Measured value of a dimension in drawing units (radians for angular). */
export function dimensionMeasurement(d: DimensionEntity): number {
  switch (d.kind) {
    case 'linear': {
      const u = { x: Math.cos(d.rotation), y: Math.sin(d.rotation) };
      return Math.abs(g.dot(g.sub(d.p2, d.p1), u));
    }
    case 'aligned':
      return g.dist(d.p1, d.p2);
    case 'radius':
      return g.dist(d.p1, d.p2);
    case 'diameter':
      return 2 * g.dist(d.p1, d.p2);
    case 'angular': {
      if (!d.center) return 0;
      const [s, e] = angularSweep(d);
      return g.normAngle(e - s);
    }
  }
}

/** Text shown by the dimension, honouring the override. */
export function dimensionText(d: DimensionEntity): string {
  const v = dimensionMeasurement(d);
  const base =
    d.kind === 'angular'
      ? `${formatAngle(v, d.style.angularDecimals)}%%d`
      : (d.kind === 'radius' ? 'R' : d.kind === 'diameter' ? '%%c' : '') + formatLength(v, { lunits: d.style.lunit, luprec: d.style.decimals });
  if (d.text === undefined || d.text === '') return base;
  if (d.text === ' ') return '';
  return d.text.replace(/<>/g, base);
}

/** Start/end angles (CCW) of the arc of an angular dimension, chosen so the arc passes by linePoint. */
function angularSweep(d: DimensionEntity): [number, number] {
  const c = d.center!;
  const a1 = g.angleOf(c, d.p1);
  const a2 = g.angleOf(c, d.p2);
  const ap = g.angleOf(c, d.linePoint);
  return g.angleInSweep(ap, a1, a2) ? [a1, a2] : [a2, a1];
}

interface Ctx {
  d: DimensionEntity;
  k: number;
  measure: Measure;
  out: DimPart[];
  n: number;
}

function base(d: DimensionEntity, suffix: string): { id: string; layer: string; color: DimensionEntity['color']; linetype?: string; lineWeight?: number } {
  return { id: `${d.id}:${suffix}`, layer: d.layer, color: d.color, linetype: d.linetype, lineWeight: d.lineWeight };
}

function line(c: Ctx, a: Point, b: Point): void {
  if (g.dist(a, b) < 1e-9) return;
  c.n += 1;
  c.out.push({ ...base(c.d, `l${c.n}`), type: 'line', a, b });
}

/** Closed-filled arrowhead with its tip at `tip`, pointing along `dir`. */
function arrow(c: Ctx, tip: Point, dir: Point): void {
  const asz = c.d.style.arrowSize * c.k;
  const u = g.normalize(dir);
  const n = { x: -u.y, y: u.x };
  const back = g.sub(tip, g.scale(u, asz));
  c.n += 1;
  c.out.push({
    ...base(c.d, `a${c.n}`),
    type: 'polyline',
    closed: true,
    filled: true,
    points: [tip, g.add(back, g.scale(n, asz / 6)), g.sub(back, g.scale(n, asz / 6))],
  });
}

function text(c: Ctx, center: Point, str: string, rotation: number, align: 'left' | 'center' | 'right' = 'center'): number {
  if (!str) return 0;
  const h = c.d.style.textHeight * c.k;
  const up = { x: -Math.sin(rotation), y: Math.cos(rotation) };
  // `center` is the middle of the text box; the entity position is its baseline anchor.
  const pos = g.sub(center, g.scale(up, h / 2));
  c.out.push({ ...base(c.d, 't'), type: 'text', position: pos, text: str, height: h, rotation, align });
  return c.measure(str, h);
}

/** Pieces of segment ab outside the interval of half-length `half` centred at the projection of t. */
function brokenLine(c: Ctx, a: Point, b: Point, t: Point, half: number): void {
  const ab = g.sub(b, a);
  const L = g.len(ab);
  if (L < 1e-9) return;
  const u = g.scale(ab, 1 / L);
  const s = g.dot(g.sub(t, a), u);
  const lo = s - half;
  const hi = s + half;
  if (hi <= 0 || lo >= L) {
    line(c, a, b);
    return;
  }
  if (lo > 0) line(c, a, g.add(a, g.scale(u, lo)));
  if (hi < L) line(c, g.add(a, g.scale(u, hi)), b);
}

/** Text direction that reads left-to-right / bottom-to-top like AutoCAD. */
function readable(angle: number): number {
  let a = g.normAngle(angle);
  if (a > Math.PI / 2 + 1e-9 && a <= (3 * Math.PI) / 2 + 1e-9) a += Math.PI;
  return g.normAngle(a);
}

function linearParts(c: Ctx): void {
  const { d, k } = c;
  const s = d.style;
  let u: Point;
  if (d.kind === 'linear') u = { x: Math.cos(d.rotation), y: Math.sin(d.rotation) };
  else {
    const v = g.sub(d.p2, d.p1);
    u = g.len(v) < 1e-12 ? { x: 1, y: 0 } : g.normalize(v);
  }
  const n = { x: -u.y, y: u.x };
  const project = (p: Point) => g.add(d.linePoint, g.scale(u, g.dot(g.sub(p, d.linePoint), u)));
  const a1 = project(d.p1);
  const a2 = project(d.p2);
  const exo = s.extOffset * k;
  const exe = s.extExtend * k;
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  // Extension lines
  for (const [p, a] of [
    [d.p1, a1],
    [d.p2, a2],
  ] as Array<[Point, Point]>) {
    const off = g.dot(g.sub(a, p), n);
    const sign = Math.sign(off) || 1;
    if (Math.abs(off) <= exo + 1e-9) continue;
    line(c, g.add(p, g.scale(n, sign * exo)), g.add(a, g.scale(n, sign * exe)));
  }
  const L = g.dist(a1, a2);
  const dir = L < 1e-12 ? u : g.normalize(g.sub(a2, a1));
  const str = dimensionText(d);
  const h = s.textHeight * k;
  const textW = str ? c.measure(str, h) : 0;
  const rot = readable(Math.atan2(dir.y, dir.x));
  const mid = g.mid(a1, a2);
  const fitsInside = textW + 2 * gap + 2 * asz <= L + 1e-9;
  const arrowsInside = 2 * asz <= L + 1e-9;
  if (d.textPosition) {
    // User-placed text: full dimension line, text where the user put it, broken if it sits on the line.
    text(c, d.textPosition, str, rot);
    const distFromLine = Math.abs(g.dot(g.sub(d.textPosition, a1), n));
    if (distFromLine < h) brokenLine(c, a1, a2, d.textPosition, textW / 2 + gap);
    else line(c, a1, a2);
  } else if (fitsInside) {
    text(c, mid, str, rot);
    brokenLine(c, a1, a2, mid, textW / 2 + gap);
  } else {
    // Text above the line when it does not fit between the arrows (DIMTMOVE-like behaviour).
    const up = { x: -Math.sin(rot), y: Math.cos(rot) };
    text(c, g.add(mid, g.scale(up, h / 2 + gap)), str, rot);
    if (arrowsInside) line(c, a1, a2);
    else {
      line(c, g.sub(a1, g.scale(dir, 2 * asz)), a1);
      line(c, a2, g.add(a2, g.scale(dir, 2 * asz)));
      line(c, a1, a2);
    }
  }
  if (arrowsInside) {
    arrow(c, a1, g.scale(dir, -1));
    arrow(c, a2, dir);
  } else {
    arrow(c, a1, dir);
    arrow(c, a2, g.scale(dir, -1));
  }
}

function centerMark(c: Ctx, center: Point): void {
  const m = c.d.style.centerMark * c.k;
  if (m <= 0) return;
  line(c, { x: center.x - m, y: center.y }, { x: center.x + m, y: center.y });
  line(c, { x: center.x, y: center.y - m }, { x: center.x, y: center.y + m });
}

function radialParts(c: Ctx): void {
  const { d, k } = c;
  const s = d.style;
  const center = d.p1;
  const r = g.dist(d.p1, d.p2);
  if (r < 1e-12) return;
  const toLoc = g.sub(d.linePoint, center);
  const dir = g.len(toLoc) > 1e-9 ? g.normalize(toLoc) : g.normalize(g.sub(d.p2, d.p1));
  const q = g.add(center, g.scale(dir, r));
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  const h = s.textHeight * k;
  const str = dimensionText(d);
  const textW = str ? c.measure(str, h) : 0;
  const textAt = d.textPosition ?? d.linePoint;
  const inside = g.dist(textAt, center) <= r - 1e-9;
  if (inside) {
    const from = d.kind === 'diameter' ? g.sub(center, g.scale(dir, r)) : center;
    text(c, textAt, str, 0);
    brokenLine(c, from, q, textAt, textW / 2 + gap);
    arrow(c, q, dir);
    if (d.kind === 'diameter') arrow(c, from, g.scale(dir, -1));
  } else {
    // Leader from the circle out to the text with a horizontal landing (DIMTOH = 1: horizontal text).
    const landingDir = dir.x >= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
    const elbow = textAt;
    const landingEnd = g.add(elbow, g.scale(landingDir, asz));
    line(c, q, elbow);
    line(c, elbow, landingEnd);
    arrow(c, q, g.scale(dir, -1));
    const tCenter = g.add(landingEnd, { x: landingDir.x * (gap + textW / 2), y: 0 });
    text(c, tCenter, str, 0);
    centerMark(c, center);
  }
}

function angularParts(c: Ctx): void {
  const { d, k } = c;
  if (!d.center) return;
  const s = d.style;
  const center = d.center;
  const r = g.dist(d.linePoint, center);
  if (r < 1e-12) return;
  const [a1, a2] = angularSweep(d);
  const sweep = g.normAngle(a2 - a1) || 2 * Math.PI;
  const exo = s.extOffset * k;
  const exe = s.extExtend * k;
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  const h = s.textHeight * k;
  // Extension lines along the legs when the leg points are inside the arc radius
  for (const p of [d.p1, d.p2]) {
    const dp = g.dist(p, center);
    if (dp >= r - 1e-9) continue;
    const u = g.normalize(g.sub(p, center));
    line(c, g.add(p, g.scale(u, exo)), g.add(center, g.scale(u, r + exe)));
  }
  const str = dimensionText(d);
  const textW = str ? c.measure(str, h) : 0;
  const midA = a1 + sweep / 2;
  const textCenter = d.textPosition ?? g.polar(center, midA, r);
  text(c, textCenter, str, 0);
  const arcId = () => {
    c.n += 1;
    return `${d.id}:c${c.n}`;
  };
  const pushArc = (sa: number, ea: number) => {
    if (g.normAngle(ea - sa) < 1e-6) return;
    c.out.push({ ...base(d, ''), id: arcId(), type: 'arc', center, radius: r, startAngle: sa, endAngle: ea });
  };
  const half = (textW / 2 + gap) / r; // half chord angle of the text gap
  const tA = g.angleOf(center, textCenter);
  const onArc = Math.abs(g.dist(textCenter, center) - r) < h && g.angleInSweep(tA, a1, a2);
  if (onArc && 2 * half < sweep) {
    pushArc(a1, tA - half);
    pushArc(tA + half, a2);
  } else pushArc(a1, a2);
  const arcLen = r * sweep;
  const startTan = { x: -Math.sin(a1), y: Math.cos(a1) };
  const endTan = { x: -Math.sin(a2), y: Math.cos(a2) };
  const p1 = g.polar(center, a1, r);
  const p2 = g.polar(center, a2, r);
  if (arcLen >= 2 * asz) {
    arrow(c, p1, g.scale(startTan, -1));
    arrow(c, p2, endTan);
  } else {
    arrow(c, p1, startTan);
    arrow(c, p2, g.scale(endTan, -1));
  }
}

/** Build the primitive entities that draw a dimension. */
export function dimensionGeometry(d: DimensionEntity, measure: Measure): DimPart[] {
  const c: Ctx = { d, k: d.style.scale || 1, measure, out: [], n: 0 };
  switch (d.kind) {
    case 'linear':
    case 'aligned':
      linearParts(c);
      break;
    case 'radius':
    case 'diameter':
      radialParts(c);
      break;
    case 'angular':
      angularParts(c);
      break;
  }
  return c.out;
}

/** Default text midpoint (DXF group 11) for a dimension. */
export function dimensionTextPoint(d: DimensionEntity, measure: Measure): Point {
  const t = dimensionGeometry(d, measure).find((p): p is TextEntity => p.type === 'text');
  if (!t) return d.linePoint;
  const up = { x: -Math.sin(t.rotation), y: Math.cos(t.rotation) };
  return g.add(t.position, g.scale(up, t.height / 2));
}
