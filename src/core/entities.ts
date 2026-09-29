import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import { strokeTextWidth } from '../render/hershey';
import { dimensionGeometry, type DimensionEntity } from './dimension';
import { mtextLayoutFull, type MTextEntity, type MTextAttachment } from './mtext';
import { interpolateFitPoints, isValidNurbs, nurbsPoints, type NurbsCurve } from './spline';
import { findPattern, loopPolygon, patternSegments, pointInLoops, worldPatternLines, type HatchLoop, type WorldPatternLine } from './hatch';
import { tableGeometry, type TableEntity } from './table';

export type { DimensionEntity, DimStyle, DimKind } from './dimension';
export type { MTextEntity, MTextAttachment } from './mtext';
export type { TableEntity, TableCell } from './table';
export type { HatchLoop, WorldPatternLine } from './hatch';

/** AutoCAD Color Index-like palette (subset), 'ByLayer' means inherit. */
export type ColorSpec = 'ByLayer' | number;

export interface EntityBase {
  readonly id: string;
  readonly layer: string;
  readonly color: ColorSpec;
  /** Linetype name (DXF code 6). Undefined or 'ByLayer' inherits from the layer. */
  readonly linetype?: string;
  /** Lineweight in mm (DXF code 370 / 100). Undefined inherits from the layer. */
  readonly lineWeight?: number;
  /** Linetype scale for this entity (CELTSCALE, DXF 48). */
  readonly ltscale?: number;
  /** True colour 0xRRGGBB (DXF 420); overrides `color` for display when set. */
  readonly trueColor?: number;
}

/** A field expression behind a text value (%<\AcVar Date>% ...): `value` is what the code evaluated to. */
export interface FieldLink {
  /** Text (or DXF MTEXT content) with the field expressions. */
  readonly code: string;
  /** The evaluated text; the link is stale once the entity's text no longer equals it. */
  readonly value: string;
}

export interface LineEntity extends EntityBase {
  readonly type: 'line';
  readonly a: Point;
  readonly b: Point;
}

export interface CircleEntity extends EntityBase {
  readonly type: 'circle';
  readonly center: Point;
  readonly radius: number;
  /** Solid-filled (wire junction dots); saved to DXF as a zero-hole donut. */
  readonly filled?: boolean;
}

export interface ArcEntity extends EntityBase {
  readonly type: 'arc';
  readonly center: Point;
  readonly radius: number;
  /** Radians, counter-clockwise from +X. */
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface PolylineEntity extends EntityBase {
  readonly type: 'polyline';
  readonly points: readonly Point[];
  readonly closed: boolean;
  /**
   * Per-vertex bulge (tan of a quarter of the included angle) for the segment
   * starting at that vertex; positive = counter-clockwise. Omitted = all straight.
   */
  readonly bulges?: readonly number[];
  /** Constant width (PLINE Width / DXF 43). 0 or undefined = thin. */
  readonly width?: number;
  /** Closed polyline drawn as a solid fill (dimension arrowheads, SOLID entities). */
  readonly filled?: boolean;
}

export interface TextEntity extends EntityBase {
  readonly type: 'text';
  readonly position: Point;
  readonly text: string;
  readonly height: number;
  readonly rotation: number;
  readonly align: 'left' | 'center' | 'right';
  /** Relative X scale (DXF 41, MTEXT \W). */
  readonly widthFactor?: number;
  /** Oblique angle in radians (DXF 51, MTEXT \Q). */
  readonly oblique?: number;
  /** Bold (MTEXT \f...|b1): drawn with a heavier stroke. */
  readonly bold?: boolean;
  /** Field expression the text was evaluated from. */
  readonly field?: FieldLink;
}

export interface InsertEntity extends EntityBase {
  readonly type: 'insert';
  readonly block: string;
  readonly position: Point;
  readonly rotation: number;
  /** Uniform (X) scale factor, always positive. */
  readonly scale: number;
  /** Y scale when it differs from `scale` (non-uniform insert, DXF group 42). Positive. */
  readonly scaleY?: number;
  /** Mirrored about the block's Y axis before rotation (DXF: negative X scale). */
  readonly mirror?: boolean;
  /** Attribute values (tag -> value), e.g. TAG1 = "PB101". */
  readonly attributes: Readonly<Record<string, string>>;
  /**
   * Visible attributes of the block that this insert does not display (ATTRIB flag 1 on the
   * insert only), e.g. TAG1 on poles 2 and 3 of a 3-pole device. The value is kept for reports.
   */
  readonly hiddenAttributes?: readonly string[];
}

export interface EllipseEntity extends EntityBase {
  readonly type: 'ellipse';
  readonly center: Point;
  /** End point of the major axis relative to the center. */
  readonly majorAxis: Point;
  /** Minor/major axis ratio (0 < ratio <= 1). */
  readonly ratio: number;
  /** Parametric start/end (radians); 0 and 2π for a full ellipse. */
  readonly startParam: number;
  readonly endParam: number;
}

export interface PointEntity extends EntityBase {
  readonly type: 'point';
  readonly position: Point;
}

/** Construction line: infinite in both directions. */
export interface XlineEntity extends EntityBase {
  readonly type: 'xline';
  readonly base: Point;
  /** Unit direction. */
  readonly direction: Point;
}

/** Semi-infinite construction line. */
export interface RayEntity extends EntityBase {
  readonly type: 'ray';
  readonly base: Point;
  readonly direction: Point;
}

/** NURBS curve (SPLINE). Control data wins; fit points alone are interpolated. */
export interface SplineEntity extends EntityBase {
  readonly type: 'spline';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly controlPoints: readonly Point[];
  /** Rational weights (omitted = all 1). */
  readonly weights?: readonly number[];
  /** Fit points (SPLINE command / DXF 11): the curve passes through them. */
  readonly fitPoints?: readonly Point[];
  readonly closed: boolean;
  /** DXF flag 2. */
  readonly periodic?: boolean;
  readonly startTangent?: Point;
  readonly endTangent?: Point;
}

/** Area fill (HATCH): boundary loops filled solid or with a line pattern. */
export interface HatchEntity extends EntityBase {
  readonly type: 'hatch';
  /** Pattern name (SOLID, ANSI31, NET ...). */
  readonly pattern: string;
  readonly solid: boolean;
  /** Pattern angle, radians. */
  readonly angle: number;
  readonly scale: number;
  /** Pattern origin (the point pattern lines are laid out from). Default 0,0. */
  readonly origin?: Point;
  /** Closed boundary loops (polyline form, bulges for arc edges); even-odd filled. */
  readonly loops: readonly HatchLoop[];
  /** World-space line families for a pattern not in the built-in table (from the DXF definition). */
  readonly patternLines?: readonly WorldPatternLine[];
  readonly associative?: boolean;
  /** 0 normal, 1 outer, 2 ignore (DXF 75). */
  readonly style?: number;
  /** 0 user defined, 1 predefined, 2 custom (DXF 76). */
  readonly patternType?: number;
  readonly double?: boolean;
}

/** LEADER / MLEADER: a leader line with arrowhead, optional landing and attached text. */
export interface LeaderEntity extends EntityBase {
  readonly type: 'leader';
  /** Leader path; the first vertex is the arrowhead tip. */
  readonly vertices: readonly Point[];
  readonly arrow: boolean;
  readonly arrowSize: number;
  /** Landing (dogleg) vector drawn from the last vertex. */
  readonly dogleg?: Point;
  /** Splined leader path. */
  readonly spline?: boolean;
  /** Further leader lines of a multileader (each starts at its own arrowhead). */
  readonly extraPaths?: readonly (readonly Point[])[];
  /** Attached text (plain paragraphs), its formatted source and placement. */
  readonly text?: string;
  readonly raw?: string;
  readonly textPosition?: Point;
  readonly textHeight: number;
  readonly textAttachment?: MTextAttachment;
  readonly textWidth?: number;
  readonly textRotation?: number;
  /** Where it came from (LEADER + MTEXT or MULTILEADER); written back as LEADER + MTEXT either way. */
  readonly kind?: 'leader' | 'mleader';
}

/** Raster image reference (IMAGE + IMAGEDEF). Drawn as a frame with the file name unless a loader supplies the bitmap. */
export interface ImageEntity extends EntityBase {
  readonly type: 'image';
  /** IMAGEDEF file name as stored in the drawing. */
  readonly path: string;
  /** Lower-left corner. */
  readonly position: Point;
  /** World vectors of one pixel along the image X and Y axes. */
  readonly u: Point;
  readonly v: Point;
  /** Size in pixels. */
  readonly size: { readonly x: number; readonly y: number };
  /** Clip boundary in pixel coordinates (origin top-left, 2 points = rectangle). */
  readonly clip?: readonly Point[];
  readonly clipOn?: boolean;
  /** DXF 70 display flags, 281-283 brightness / contrast / fade. */
  readonly flags?: number;
  readonly brightness?: number;
  readonly contrast?: number;
  readonly fade?: number;
}

export type Entity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity
  | TextEntity
  | InsertEntity
  | EllipseEntity
  | PointEntity
  | XlineEntity
  | RayEntity
  | MTextEntity
  | DimensionEntity
  | SplineEntity
  | HatchEntity
  | LeaderEntity
  | TableEntity
  | ImageEntity;

export interface AttributeDef {
  readonly tag: string;
  readonly prompt: string;
  readonly default: string;
  readonly position: Point;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right';
  /** ATTDEF flag 1: value is stored but not displayed (ACADE symbols carry many of these). */
  readonly invisible?: boolean;
  /** Text rotation in radians (DXF group 50), like TextEntity; undefined = 0. Adds to the insert rotation. */
  readonly rotation?: number;
}

export interface BlockDef {
  readonly name: string;
  readonly basePoint: Point;
  readonly entities: readonly Entity[];
  readonly attributes: readonly AttributeDef[];
  readonly description?: string;
  /** External reference (BLOCK flag 4; 8 = overlay): the referenced file's path (DXF group 1). */
  readonly xref?: { readonly path: string; readonly overlay?: boolean };
}

export interface Layer {
  readonly name: string;
  readonly color: number;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly lineWeight: number;
  /** Layer linetype (default Continuous). */
  readonly linetype?: string;
  /** Frozen (LAYER Freeze) as opposed to merely off; both hide the layer. */
  readonly frozen?: boolean;
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `e${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export type BlockLookup = (name: string) => BlockDef | undefined;

/** Length of the infinite part of XLINE/RAY used for hit testing and bounds (world units). */
export const INFINITE_LENGTH = 1e4;

/** Segment-ize an arc for hit testing and snapping. */
export function arcPoints(arc: { center: Point; radius: number; startAngle: number; endAngle: number }, segments = 32): Point[] {
  let sweep = g.normAngle(arc.endAngle - arc.startAngle);
  if (sweep < g.EPS) sweep = 2 * Math.PI;
  const out: Point[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = arc.startAngle + (sweep * i) / segments;
    out.push(g.polar(arc.center, a, arc.radius));
  }
  return out;
}

export function arcEndpoints(arc: ArcEntity): [Point, Point] {
  return [g.polar(arc.center, arc.startAngle, arc.radius), g.polar(arc.center, arc.endAngle, arc.radius)];
}

export function arcMidpoint(arc: ArcEntity): Point {
  let sweep = g.normAngle(arc.endAngle - arc.startAngle);
  if (sweep < g.EPS) sweep = 2 * Math.PI;
  return g.polar(arc.center, arc.startAngle + sweep / 2, arc.radius);
}

/** Estimate text width in drawing units (monospace-ish approximation). */
export function textWidth(text: string, height: number): number {
  return strokeTextWidth(text, height);
}

export function textBounds(t: TextEntity): Bounds {
  const w = textWidth(t.text, t.height) * (t.widthFactor ?? 1);
  const ox = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  const corners = [
    { x: ox, y: 0 },
    { x: ox + w, y: 0 },
    { x: ox + w, y: t.height },
    { x: ox, y: t.height },
  ].map((c) => g.add(t.position, g.rotate(c, t.rotation)));
  return g.boundsOfPoints(corners)!;
}

// ------------------------------------------------------------------ polyline arcs (bulges)

export interface BulgeArc {
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  /** Included angle, signed (positive = CCW). */
  sweep: number;
}

/** Arc described by a bulge between two vertices (null for a straight segment). */
export function bulgeArc(a: Point, b: Point, bulge: number): BulgeArc | null {
  if (Math.abs(bulge) < 1e-12) return null;
  const chord = g.dist(a, b);
  if (chord < 1e-12) return null;
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const m = g.mid(a, b);
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  const nrm = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
  const side = Math.abs(theta) <= Math.PI ? Math.sign(theta) : -Math.sign(theta);
  const center = { x: m.x + nrm.x * d * side, y: m.y + nrm.y * d * side };
  const a0 = g.angleOf(center, a);
  const a1 = g.angleOf(center, b);
  return theta > 0
    ? { center, radius: r, startAngle: a0, endAngle: a1, sweep: theta }
    : { center, radius: r, startAngle: a1, endAngle: a0, sweep: theta };
}

/** Bulge value for an arc from a to b through a third point (or by included angle). */
export function bulgeFromSweep(sweep: number): number {
  return Math.tan(sweep / 4);
}

export interface PolySegment {
  a: Point;
  b: Point;
  bulge: number;
  arc: BulgeArc | null;
}

/** Segments of a polyline with their arc data. */
export function polylineSegments(pl: PolylineEntity): PolySegment[] {
  const n = pl.points.length;
  const out: PolySegment[] = [];
  // A closed two-vertex polyline (a DONUT) has two arc segments, so the closing segment counts from n = 2.
  const count = pl.closed && n >= 2 ? n : n - 1;
  for (let i = 0; i < count; i += 1) {
    const a = pl.points[i]!;
    const b = pl.points[(i + 1) % n]!;
    const bulge = pl.bulges?.[i] ?? 0;
    out.push({ a, b, bulge, arc: bulgeArc(a, b, bulge) });
  }
  return out;
}

const polyCache = new WeakMap<PolylineEntity, Point[]>();

/** Tessellated vertices of a polyline (arc segments expanded). Cached per entity. */
export function polylineVertices(pl: PolylineEntity): Point[] {
  const hit = polyCache.get(pl);
  if (hit) return hit;
  let out: Point[];
  if (!pl.bulges || !pl.bulges.some((b) => Math.abs(b) > 1e-12)) out = [...pl.points];
  else {
    out = [];
    const segs = polylineSegments(pl);
    for (const s of segs) {
      out.push(s.a);
      if (!s.arc) continue;
      const steps = Math.max(2, Math.ceil(Math.abs(s.arc.sweep) / (Math.PI / 16)));
      const a0 = g.angleOf(s.arc.center, s.a);
      for (let k = 1; k < steps; k += 1) out.push(g.polar(s.arc.center, a0 + (s.arc.sweep * k) / steps, s.arc.radius));
    }
    if (!pl.closed) out.push(pl.points[pl.points.length - 1]!);
  }
  polyCache.set(pl, out);
  return out;
}

export function polylineLength(pl: PolylineEntity): number {
  let L = 0;
  for (const s of polylineSegments(pl)) L += s.arc ? Math.abs(s.arc.sweep) * s.arc.radius : g.dist(s.a, s.b);
  return L;
}

/** Signed area of a closed polyline (arc segments included). */
export function polylineArea(pl: PolylineEntity): number {
  let area = 0;
  const segs = polylineSegments({ ...pl, closed: true });
  for (const s of segs) {
    area += (s.a.x * s.b.y - s.b.x * s.a.y) / 2;
    if (s.arc) {
      // circular segment between chord and arc
      const th = Math.abs(s.arc.sweep);
      const seg = (s.arc.radius * s.arc.radius * (th - Math.sin(th))) / 2;
      area += s.arc.sweep > 0 ? seg : -seg;
    }
  }
  return area;
}

// ------------------------------------------------------------------ ellipse

export function ellipsePoint(e: EllipseEntity, t: number): Point {
  const a = g.len(e.majorAxis);
  const b = a * e.ratio;
  const rot = Math.atan2(e.majorAxis.y, e.majorAxis.x);
  return g.add(e.center, g.rotate({ x: a * Math.cos(t), y: b * Math.sin(t) }, rot));
}

export function ellipseSweep(e: EllipseEntity): number {
  const s = g.normAngle(e.endParam - e.startParam);
  return s < g.EPS ? 2 * Math.PI : s;
}

export const isFullEllipse = (e: EllipseEntity): boolean => ellipseSweep(e) >= 2 * Math.PI - 1e-9;

const ellipseCache = new WeakMap<EllipseEntity, Point[]>();
export function ellipsePoints(e: EllipseEntity, segments = 64): Point[] {
  const hit = ellipseCache.get(e);
  if (hit) return hit;
  const sweep = ellipseSweep(e);
  const out: Point[] = [];
  for (let i = 0; i <= segments; i += 1) out.push(ellipsePoint(e, e.startParam + (sweep * i) / segments));
  ellipseCache.set(e, out);
  return out;
}

// ------------------------------------------------------------------ xline / ray

function rayEndpoints(e: XlineEntity | RayEntity): [Point, Point] {
  const d = g.normalize(e.direction);
  const far = g.add(e.base, g.scale(d, INFINITE_LENGTH));
  if (e.type === 'ray') return [e.base, far];
  return [g.sub(e.base, g.scale(d, INFINITE_LENGTH)), far];
}

// ------------------------------------------------------------------ dimension / mtext component geometry

const dimCache = new WeakMap<DimensionEntity, Entity[]>();
/** Primitive entities (lines, arrow solids, text) that draw a dimension. Cached per entity. */
export function dimensionParts(d: DimensionEntity): Entity[] {
  const hit = dimCache.get(d);
  if (hit) return hit;
  const parts = dimensionGeometry(d, textWidth) as Entity[];
  dimCache.set(d, parts);
  return parts;
}

const mtextCache = new WeakMap<MTextEntity, { texts: TextEntity[]; lines: LineEntity[] }>();
function mtextRendered(m: MTextEntity): { texts: TextEntity[]; lines: LineEntity[] } {
  const hit = mtextCache.get(m);
  if (hit) return hit;
  const lay = mtextLayoutFull(m, textWidth);
  const lines: LineEntity[] = lay.strokes.map((st, i) => ({
    id: `${m.id}:s${i}`,
    layer: m.layer,
    color: st.color ?? m.color,
    ...(st.trueColor !== undefined ? { trueColor: st.trueColor } : m.trueColor !== undefined && st.color === undefined ? { trueColor: m.trueColor } : {}),
    type: 'line',
    a: st.a,
    b: st.b,
  }));
  const entry = { texts: lay.texts, lines };
  mtextCache.set(m, entry);
  return entry;
}
/** Single-line text pieces that render an MTEXT (word wrapped, format codes applied). Cached per entity. */
export function mtextParts(m: MTextEntity): TextEntity[] {
  return mtextRendered(m).texts;
}
/** Underline / overline / strike-through / fraction-bar strokes of a formatted MTEXT. */
export function mtextDecorations(m: MTextEntity): LineEntity[] {
  return mtextRendered(m).lines;
}

// ------------------------------------------------------------------ spline

/** The NURBS behind a spline: its control data, or an interpolation of its fit points. */
export function splineCurve(e: SplineEntity): NurbsCurve | null {
  const c: NurbsCurve = { degree: e.degree, knots: e.knots, controlPoints: e.controlPoints, ...(e.weights ? { weights: e.weights } : {}) };
  if (isValidNurbs(c)) return c;
  const fit = e.fitPoints ?? [];
  if (fit.length < 2) return null;
  let chord = 0;
  for (let i = 1; i < fit.length; i += 1) chord += g.dist(fit[i - 1]!, fit[i]!);
  const tan = (t: Point | undefined) => (t && g.len(t) > 1e-12 ? g.scale(g.normalize(t), chord) : undefined);
  const st = tan(e.startTangent);
  const et = tan(e.endTangent);
  return interpolateFitPoints(fit, { closed: e.closed, ...(st && et ? { startTangent: st, endTangent: et } : {}) });
}

const splineCache = new WeakMap<SplineEntity, Point[]>();
/** Tessellated spline (cached per entity). */
export function splinePoints(e: SplineEntity): Point[] {
  const hit = splineCache.get(e);
  if (hit) return hit;
  const c = splineCurve(e);
  const pts = c ? nurbsPoints(c) : [...(e.fitPoints?.length ? e.fitPoints : e.controlPoints)];
  splineCache.set(e, pts);
  return pts;
}

/** A spline through fit points with its control data computed (what the SPLINE command creates). */
export function splineThroughPoints(base: EntityBase, fit: readonly Point[], closed: boolean): SplineEntity | null {
  const c = interpolateFitPoints(fit, { closed });
  if (!c) return null;
  return { ...base, type: 'spline', degree: c.degree, knots: c.knots, controlPoints: c.controlPoints, fitPoints: [...fit], closed };
}

// ------------------------------------------------------------------ hatch

/** World line families of a hatch's pattern ([] for SOLID). */
export function hatchPatternLines(h: HatchEntity): WorldPatternLine[] {
  if (h.solid) return [];
  // Lines from the file win (double hatches, custom and non-matching definitions).
  if (h.patternLines?.length) return [...h.patternLines];
  const pat = findPattern(h.pattern);
  return pat && pat.lines.length ? worldPatternLines(pat, h.angle, h.scale, h.origin) : [];
}

export interface HatchGeometry {
  /** Tessellated boundary loops. */
  polys: Point[][];
  /** Clipped pattern dashes (a dot is a zero-length segment). */
  segments: Array<[Point, Point]>;
  /** Too dense to draw line by line. */
  dense: boolean;
}

const hatchCache = new WeakMap<HatchEntity, HatchGeometry>();
export function hatchGeometry(h: HatchEntity): HatchGeometry {
  const hit = hatchCache.get(h);
  if (hit) return hit;
  const polys = h.loops.map((l) => loopPolygon(l)).filter((p) => p.length >= 3);
  const pat = h.solid ? { segments: [], dense: false } : patternSegments(polys, hatchPatternLines(h));
  const geom = { polys, segments: pat.segments, dense: pat.dense };
  hatchCache.set(h, geom);
  return geom;
}

// ------------------------------------------------------------------ leader

/** The main leader path including the landing (dogleg). */
export function leaderPath(e: LeaderEntity): Point[] {
  const pts = [...e.vertices];
  if (e.dogleg && pts.length && g.len(e.dogleg) > 1e-12) pts.push(g.add(pts[pts.length - 1]!, e.dogleg));
  return pts;
}

/** Default attachment for leader text: to the right of the landing reads from its left edge. */
export function leaderTextAttachment(e: LeaderEntity): MTextAttachment {
  if (e.textAttachment) return e.textAttachment;
  const path = leaderPath(e);
  const last = path[path.length - 1];
  return last && e.textPosition && e.textPosition.x < last.x ? 3 : 1;
}

const leaderCache = new WeakMap<LeaderEntity, Entity[]>();
/** Leader line(s), arrowhead(s) and the attached MTEXT. Cached per entity. */
export function leaderParts(e: LeaderEntity): Entity[] {
  const hit = leaderCache.get(e);
  if (hit) return hit;
  const style = { layer: e.layer, color: e.color, ...(e.trueColor !== undefined ? { trueColor: e.trueColor } : {}), linetype: e.linetype, lineWeight: e.lineWeight };
  const out: Entity[] = [];
  const paths: Point[][] = [leaderPath(e), ...(e.extraPaths ?? []).map((p) => [...p])];
  paths.forEach((path, i) => {
    if (path.length < 2) return;
    let pts = path;
    if (e.spline && i === 0 && e.vertices.length > 2) {
      const c = interpolateFitPoints(e.vertices, {});
      if (c) pts = [...nurbsPoints(c, 8), ...path.slice(e.vertices.length)];
    }
    out.push({ ...style, id: `${e.id}:l${i}`, type: 'polyline', points: pts, closed: false });
    if (e.arrow && e.arrowSize > 0) {
      const tip = pts[0]!;
      const dir = g.normalize(g.sub(tip, pts[1]!));
      if (g.len(dir) > 0) {
        const back = g.sub(tip, g.scale(dir, e.arrowSize));
        const n = { x: -dir.y, y: dir.x };
        out.push({ ...style, id: `${e.id}:a${i}`, type: 'polyline', closed: true, filled: true, points: [tip, g.add(back, g.scale(n, e.arrowSize / 6)), g.sub(back, g.scale(n, e.arrowSize / 6))] });
      }
    }
  });
  if (e.text && e.textPosition) {
    out.push({
      ...style,
      id: `${e.id}:t`,
      type: 'mtext',
      position: e.textPosition,
      text: e.text,
      ...(e.raw ? { raw: e.raw } : {}),
      height: e.textHeight,
      width: e.textWidth ?? 0,
      rotation: e.textRotation ?? 0,
      attachment: leaderTextAttachment(e),
      lineSpacing: 1,
    });
  }
  leaderCache.set(e, out);
  return out;
}

// ------------------------------------------------------------------ table

const tableCache = new WeakMap<TableEntity, Entity[]>();
/** Border lines and cell MTEXTs of a table. Cached per entity. */
export function tableParts(t: TableEntity): Entity[] {
  const hit = tableCache.get(t);
  if (hit) return hit;
  const geo = tableGeometry(t);
  const style = { layer: t.layer, color: t.color, ...(t.trueColor !== undefined ? { trueColor: t.trueColor } : {}), linetype: t.linetype, lineWeight: t.lineWeight };
  const out: Entity[] = geo.lines.map(([a, b], i) => ({ ...style, id: `${t.id}:b${i}`, type: 'line' as const, a, b }));
  out.push(...geo.texts);
  tableCache.set(t, out);
  return out;
}

// ------------------------------------------------------------------ image

/** World corners of an image: lower-left, lower-right, upper-right, upper-left. */
export function imageCorners(e: ImageEntity): Point[] {
  const w = g.scale(e.u, e.size.x);
  const h = g.scale(e.v, e.size.y);
  return [e.position, g.add(e.position, w), g.add(g.add(e.position, w), h), g.add(e.position, h)];
}

/** Clip boundary in world space (pixel coordinates have their origin at the top-left pixel centre). */
export function imageBoundary(e: ImageEntity): Point[] {
  if (!e.clipOn || !e.clip || e.clip.length < 2) return imageCorners(e);
  const origin = g.add(e.position, g.sub(g.scale(e.u, 0.5), g.scale(e.v, 0.5)));
  const toWorld = (p: Point) => g.add(origin, g.add(g.scale(e.u, p.x), g.scale(e.v, e.size.y - p.y)));
  if (e.clip.length === 2) {
    const [a, b] = e.clip as [Point, Point];
    return [toWorld(a), toWorld({ x: b.x, y: a.y }), toWorld(b), toWorld({ x: a.x, y: b.y })];
  }
  const pts = e.clip.map(toWorld);
  return g.eq(pts[0]!, pts[pts.length - 1]!) ? pts.slice(0, -1) : pts;
}

/** File name shown in an image frame. */
export const imageLabel = (e: ImageEntity): string => e.path.split(/[\\/]/).pop() || e.path || 'IMAGE';

const imageCache = new WeakMap<ImageEntity, Entity[]>();
/** Frame (clip boundary) and file-name label of an image. Cached per entity. */
export function imageParts(e: ImageEntity): Entity[] {
  const hit = imageCache.get(e);
  if (hit) return hit;
  const style = { layer: e.layer, color: e.color, ...(e.trueColor !== undefined ? { trueColor: e.trueColor } : {}), linetype: e.linetype, lineWeight: e.lineWeight };
  const frame = imageBoundary(e);
  const out: Entity[] = [{ ...style, id: `${e.id}:f`, type: 'polyline', points: frame, closed: true }];
  const W = g.len(e.u) * e.size.x;
  const H = g.len(e.v) * e.size.y;
  const rot = Math.atan2(e.u.y, e.u.x);
  const label = imageLabel(e);
  let th = Math.min(H * 0.08, (W * 0.9) / Math.max(1, label.length * 0.9));
  if (!(th > 0)) th = 0.1;
  // Label in the lower-left corner of the frame (in the image's own orientation).
  const ud = { x: Math.cos(rot), y: Math.sin(rot) };
  const vd = g.normalize(e.v);
  let corner = frame[0]!;
  for (const q of frame) if (g.dot(q, vd) * 1e6 + g.dot(q, ud) < g.dot(corner, vd) * 1e6 + g.dot(corner, ud) - 1e-9) corner = q;
  const at = g.add(corner, g.rotate({ x: th * 0.5, y: th * 0.5 }, rot));
  out.push({ ...style, id: `${e.id}:n`, type: 'text', position: at, text: label, height: th, rotation: rot, align: 'left' });
  imageCache.set(e, out);
  return out;
}

// ------------------------------------------------------------------ xref placeholder

/** Frame and name drawn for an external reference whose contents are not loaded. */
function xrefPlaceholder(ins: InsertEntity, block: BlockDef, tf: (p: Point) => Point): Entity[] {
  const h = 0.25;
  const name = block.name;
  const w = textWidth(name, h) + 2 * h;
  const bp = block.basePoint;
  const corners = [
    { x: bp.x, y: bp.y },
    { x: bp.x + w, y: bp.y },
    { x: bp.x + w, y: bp.y + 3 * h },
    { x: bp.x, y: bp.y + 3 * h },
  ];
  const k = Math.sqrt(ins.scale * (ins.scaleY ?? ins.scale));
  return [
    { id: `${ins.id}:xf`, layer: ins.layer, color: ins.color, linetype: 'DASHED', ltscale: 0.2 * k, type: 'polyline', points: corners.map(tf), closed: true },
    { id: `${ins.id}:xn`, layer: ins.layer, color: ins.color, type: 'text', position: tf({ x: bp.x + h, y: bp.y + h }), text: name, height: h * k, rotation: ins.rotation, align: 'left' },
  ];
}

// ------------------------------------------------------------------ transforms of the compound types

interface Affine {
  tf: (p: Point) => Point;
  /** Linear part (for direction / size vectors). */
  vec: (v: Point) => Point;
  rotation: number;
  kx: number;
  ky: number;
  mirrored: boolean;
}

type Compound = SplineEntity | HatchEntity | LeaderEntity | TableEntity | ImageEntity;

/** Between a direction angle and its reverse, the one nearest `ref` (keeps text readable after a mirror). */
function readableAngle(a: number, ref: number): number {
  const diff = (x: number) => Math.abs(g.normAngle(x - ref + Math.PI) - Math.PI);
  return normAngle(diff(a) <= diff(a + Math.PI) ? a : a + Math.PI);
}

function affineCompound(e: Compound, A: Affine): Entity {
  const k = Math.sqrt(Math.abs(A.kx * A.ky));
  const conformal = Math.abs(Math.abs(A.kx) - Math.abs(A.ky)) < 1e-12;
  const dirAngle = (t: number) => {
    const v = A.vec({ x: Math.cos(t), y: Math.sin(t) });
    return Math.atan2(v.y, v.x);
  };
  switch (e.type) {
    case 'spline':
      return {
        ...e,
        controlPoints: e.controlPoints.map(A.tf),
        ...(e.fitPoints ? { fitPoints: e.fitPoints.map(A.tf) } : {}),
        ...(e.startTangent ? { startTangent: A.vec(e.startTangent) } : {}),
        ...(e.endTangent ? { endTangent: A.vec(e.endTangent) } : {}),
      };
    case 'hatch': {
      const loops = e.loops.map((l): HatchLoop => {
        if (!conformal && l.bulges?.some((b) => Math.abs(b) > 1e-12)) return { points: loopPolygon(l).map(A.tf) };
        return { points: l.points.map(A.tf), ...(l.bulges ? { bulges: A.mirrored ? l.bulges.map((b) => -b) : l.bulges } : {}) };
      });
      return {
        ...e,
        loops,
        angle: normAngle(e.angle + A.rotation),
        scale: e.scale * k,
        origin: A.tf(e.origin ?? { x: 0, y: 0 }),
        ...(e.patternLines ? { patternLines: e.patternLines.map((l) => ({ angle: dirAngle(l.angle), base: A.tf(l.base), offset: A.vec(l.offset), dashes: l.dashes.map((d) => d * k) })) } : {}),
      };
    }
    case 'leader': {
      const att = e.textAttachment;
      const flip = (a: MTextAttachment): MTextAttachment => {
        const col = (a - 1) % 3;
        return (a - col + (col === 0 ? 2 : col === 2 ? 0 : 1)) as MTextAttachment;
      };
      const rot = e.textRotation ?? 0;
      return {
        ...e,
        vertices: e.vertices.map(A.tf),
        ...(e.dogleg ? { dogleg: A.vec(e.dogleg) } : {}),
        ...(e.extraPaths ? { extraPaths: e.extraPaths.map((p) => p.map(A.tf)) } : {}),
        ...(e.textPosition ? { textPosition: A.tf(e.textPosition) } : {}),
        textHeight: e.textHeight * k,
        arrowSize: e.arrowSize * k,
        ...(e.textWidth !== undefined ? { textWidth: e.textWidth * k } : {}),
        textRotation: A.mirrored ? readableAngle(dirAngle(rot), rot + A.rotation) : normAngle(rot + A.rotation),
        ...(A.mirrored && att ? { textAttachment: flip(att) } : {}),
      };
    }
    case 'table': {
      const sx = Math.abs(A.kx);
      const sy = Math.abs(A.ky);
      const scaled: TableEntity = {
        ...e,
        rowHeights: e.rowHeights.map((h) => h * sy),
        columnWidths: e.columnWidths.map((w) => w * sx),
        textHeight: e.textHeight * k,
        ...(e.margin !== undefined ? { margin: e.margin * k } : {}),
        cells: e.cells.map((r) => r.map((c) => (c.height !== undefined ? { ...c, height: c.height * k } : c))),
      };
      if (!A.mirrored) return { ...scaled, position: A.tf(e.position), rotation: normAngle(dirAngle(e.rotation)) };
      // Mirrored: the table stays readable; its top-left corner is wherever the mirrored box's top-left lands.
      const rot = readableAngle(dirAngle(e.rotation), e.rotation + A.rotation);
      const W = e.columnWidths.reduce((a, b) => a + b, 0) * sx;
      const H = e.rowHeights.reduce((a, b) => a + b, 0) * sy;
      const corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: -H }, { x: 0, y: -H }].map((c) => A.tf(g.add(e.position, g.rotate({ x: c.x / (sx || 1), y: c.y / (sy || 1) }, e.rotation))));
      let best = corners[0]!;
      let score = Infinity;
      for (const c of corners) {
        const l = g.rotate(c, -rot);
        const sc = l.x - l.y;
        if (sc < score) {
          score = sc;
          best = c;
        }
      }
      return { ...scaled, position: best, rotation: rot };
    }
    case 'image':
      return { ...e, position: A.tf(e.position), u: A.vec(e.u), v: A.vec(e.v) };
  }
}

/** EXPLODE for the entity types that break into simpler ones; null when the type does not explode here. */
export function explodeCompound(e: Entity): Entity[] | null {
  const fresh = <T extends Entity>(x: T): T => ({ ...x, id: newId() });
  switch (e.type) {
    case 'spline': {
      const pts = splinePoints(e);
      if (pts.length < 2) return [];
      const closed = e.closed && pts.length > 2 && g.eq(pts[0]!, pts[pts.length - 1]!, 1e-9);
      const { id: _id, type: _t, degree: _d, knots: _k, controlPoints: _c, weights: _w, fitPoints: _f, closed: _cl, periodic: _p, startTangent: _s, endTangent: _e, ...style } = e;
      return [{ ...style, id: newId(), type: 'polyline', points: closed ? pts.slice(0, -1) : pts, closed }];
    }
    case 'hatch': {
      const geo = hatchGeometry(e);
      const style = { layer: e.layer, color: e.color, ...(e.trueColor !== undefined ? { trueColor: e.trueColor } : {}), linetype: e.linetype, lineWeight: e.lineWeight };
      if (e.solid) return geo.polys.map((points) => ({ ...style, id: newId(), type: 'polyline' as const, points, closed: true, filled: true }));
      return geo.segments.filter(([a, b]) => !g.eq(a, b, 1e-12)).map(([a, b]) => ({ ...style, id: newId(), type: 'line' as const, a, b }));
    }
    case 'leader':
      return leaderParts(e).map(fresh);
    case 'table':
      return tableParts(e).map(fresh);
    default:
      return null;
  }
}

/** Transform a block-space point into world space for a given insert (mirror, scale X/Y, rotate, move). */
export function insertTransform(ins: InsertEntity, block: BlockDef): (p: Point) => Point {
  const sx = ins.scale * (ins.mirror ? -1 : 1);
  const sy = ins.scaleY ?? ins.scale;
  return (p) => {
    const local = g.sub(p, block.basePoint);
    const scaled = { x: local.x * sx, y: local.y * sy };
    const rotated = g.rotate(scaled, ins.rotation);
    return g.add(ins.position, rotated);
  };
}

/** True when the insert is a plain similarity (no mirror, uniform scale). */
export const isSimilarInsert = (ins: InsertEntity): boolean => !ins.mirror && (ins.scaleY === undefined || Math.abs(ins.scaleY - ins.scale) < 1e-12);

/** Normalise an angle into [0, 2pi). */
const normAngle = (t: number): number => {
  const two = 2 * Math.PI;
  let a = t % two;
  if (a < 0) a += two;
  return Math.abs(a) < 1e-12 || Math.abs(a - two) < 1e-12 ? 0 : a;
};

const flipAlign = (al: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' => (al === 'left' ? 'right' : al === 'right' ? 'left' : al);

/** Sample an arc / circle into a polyline (used when a non-uniform scale would turn it into an ellipse). */
function sampledPolyline(e: CircleEntity | ArcEntity, tf: (p: Point) => Point): PolylineEntity {
  const full = e.type === 'circle';
  const start = full ? 0 : e.startAngle;
  let sweep = full ? 2 * Math.PI : g.normAngle(e.endAngle - e.startAngle);
  if (sweep < g.EPS) sweep = 2 * Math.PI;
  const n = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 48));
  const points: Point[] = [];
  for (let i = 0; i <= (full ? n - 1 : n); i += 1) {
    const t = start + (sweep * i) / n;
    points.push(tf({ x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t) }));
  }
  return { id: e.id, layer: e.layer, color: e.color, linetype: e.linetype, lineWeight: e.lineWeight, ltscale: e.ltscale, type: 'polyline', points, closed: full };
}

/**
 * Apply a general block transform (mirror about the block Y axis, independent X/Y scale,
 * rotation, translation). Text stays readable (position moves, glyphs are not mirrored),
 * arcs keep their visible sweep, and circles / arcs under a non-uniform scale become polylines.
 */
export function blockTransform(e: Entity, tf: (p: Point) => Point, rotation: number, sx: number, sy: number, mirror: boolean): Entity {
  const uniform = Math.abs(sx - sy) < 1e-12;
  const k = Math.sqrt(Math.abs(sx * sy));
  const vec = (v: Point): Point => g.rotate({ x: v.x * sx * (mirror ? -1 : 1), y: v.y * sy }, rotation);
  // Angle of a block-space direction after the transform (mirror flips it, then rotation adds).
  const ang = (t: number): number => normAngle((mirror ? Math.PI - t : t) + rotation);
  switch (e.type) {
    case 'line':
      return { ...e, a: tf(e.a), b: tf(e.b) };
    case 'circle':
      return uniform ? { ...e, center: tf(e.center), radius: e.radius * k } : sampledPolyline(e, tf);
    case 'arc':
      if (!uniform) return sampledPolyline(e, tf);
      return mirror
        ? { ...e, center: tf(e.center), radius: e.radius * k, startAngle: ang(e.endAngle), endAngle: ang(e.startAngle) }
        : { ...e, center: tf(e.center), radius: e.radius * k, startAngle: e.startAngle + rotation, endAngle: e.endAngle + rotation };
    case 'polyline':
      return { ...e, points: e.points.map(tf), bulges: mirror ? e.bulges?.map((bu) => -bu) : e.bulges, width: e.width !== undefined ? e.width * k : e.width };
    case 'text':
      return { ...e, position: tf(e.position), height: e.height * k, rotation: e.rotation + rotation, align: mirror ? flipAlign(e.align) : e.align };
    case 'mtext':
      return { ...e, position: tf(e.position), height: e.height * k, width: e.width * k, rotation: e.rotation + rotation };
    case 'insert':
      return {
        ...e,
        position: tf(e.position),
        rotation: normAngle(mirror ? Math.PI - e.rotation + rotation : e.rotation + rotation),
        scale: e.scale * Math.abs(sx),
        ...(uniform && e.scaleY === undefined ? {} : { scaleY: (e.scaleY ?? e.scale) * Math.abs(sy) }),
        ...(mirror ? { mirror: !e.mirror } : {}),
      };
    case 'ellipse': {
      const c = tf(e.center);
      return { ...e, center: c, majorAxis: vec(e.majorAxis), ...(mirror ? { startParam: -e.endParam, endParam: -e.startParam } : {}) };
    }
    case 'point':
      return { ...e, position: tf(e.position) };
    case 'xline':
    case 'ray':
      return { ...e, base: tf(e.base), direction: vec(e.direction) };
    case 'dimension':
      return {
        ...e,
        p1: tf(e.p1),
        p2: tf(e.p2),
        linePoint: tf(e.linePoint),
        center: e.center ? tf(e.center) : e.center,
        textPosition: e.textPosition ? tf(e.textPosition) : e.textPosition,
        rotation: e.kind === 'linear' ? ang(e.rotation) : e.rotation + rotation,
        style: k === 1 ? e.style : { ...e.style, scale: e.style.scale * k },
      };
    case 'spline':
    case 'hatch':
    case 'leader':
    case 'table':
    case 'image':
      return affineCompound(e, { tf, vec, rotation, kx: sx, ky: sy, mirrored: mirror });
  }
}

interface InsertCache {
  block: BlockDef;
  exploded: Entity[];
  bounds: Bounds | null;
}
/** Entities are immutable, so an insert's exploded geometry can be cached by identity. */
const insertCache = new WeakMap<InsertEntity, InsertCache>();

function cachedInsert(ins: InsertEntity, lookup: BlockLookup): InsertCache | null {
  const block = lookup(ins.block);
  if (!block) return null;
  const hit = insertCache.get(ins);
  if (hit && hit.block === block) return hit;
  const exploded = explodeInsertUncached(ins, lookup, 0);
  let bounds: Bounds | null = null;
  for (const sub of exploded) bounds = g.unionBounds(bounds, entityBounds(sub, lookup));
  const entry = { block, exploded, bounds: bounds ?? g.boundsOfPoints([ins.position]) };
  insertCache.set(ins, entry);
  return entry;
}

/** Expand an insert into world-space entities (recursively). Cached per insert. */
export function explodeInsert(ins: InsertEntity, lookup: BlockLookup, depth = 0): Entity[] {
  if (depth === 0) return cachedInsert(ins, lookup)?.exploded ?? [];
  return explodeInsertUncached(ins, lookup, depth);
}

function explodeInsertUncached(ins: InsertEntity, lookup: BlockLookup, depth: number): Entity[] {
  const block = lookup(ins.block);
  if (!block || depth > 8) return [];
  const tf = insertTransform(ins, block);
  if (block.xref && block.entities.length === 0) return xrefPlaceholder(ins, block, tf);
  const out: Entity[] = [];
  const similar = isSimilarInsert(ins);
  for (const e of block.entities) {
    out.push(...transformEntity(e, tf, ins, similar, lookup, depth + 1));
  }
  // Attribute text
  for (const a of block.attributes) {
    if (a.invisible || ins.hiddenAttributes?.includes(a.tag)) continue;
    const value = ins.attributes[a.tag] ?? a.default;
    if (!value) continue;
    out.push({
      type: 'text',
      id: `${ins.id}:${a.tag}`,
      layer: attributeLayer(a.tag, ins.layer),
      color: 'ByLayer',
      position: tf(a.position),
      text: value,
      height: a.height * Math.sqrt(ins.scale * (ins.scaleY ?? ins.scale)),
      rotation: ins.rotation + (a.rotation ?? 0),
      align: ins.mirror ? flipAlign(a.align) : a.align,
    });
  }
  return out;
}

/** Attribute text lives on the conventional AutoCAD Electrical layers. */
export function attributeLayer(tag: string, fallback: string): string {
  const t = tag.toUpperCase();
  if (t.startsWith('TAG')) return 'TAGS';
  if (t.startsWith('DESC')) return 'DESC';
  if (t.startsWith('TERM')) return 'TERMS';
  return fallback;
}

/** Apply a similarity transform (translate/rotate/uniform scale) to any entity. */
export function similarityTransform(e: Entity, tf: (p: Point) => Point, rotation: number, k: number): Entity {
  switch (e.type) {
    case 'line':
      return { ...e, a: tf(e.a), b: tf(e.b) };
    case 'circle':
      return { ...e, center: tf(e.center), radius: e.radius * k };
    case 'arc':
      return { ...e, center: tf(e.center), radius: e.radius * k, startAngle: e.startAngle + rotation, endAngle: e.endAngle + rotation };
    case 'polyline':
      return { ...e, points: e.points.map(tf), width: e.width !== undefined ? e.width * k : e.width };
    case 'text':
      return { ...e, position: tf(e.position), height: e.height * k, rotation: e.rotation + rotation };
    case 'insert':
      return { ...e, position: tf(e.position), rotation: e.rotation + rotation, scale: e.scale * k, ...(e.scaleY !== undefined ? { scaleY: e.scaleY * k } : {}) };
    case 'ellipse':
      return { ...e, center: tf(e.center), majorAxis: g.rotate(g.scale(e.majorAxis, k), rotation) };
    case 'point':
      return { ...e, position: tf(e.position) };
    case 'xline':
    case 'ray':
      return { ...e, base: tf(e.base), direction: g.rotate(e.direction, rotation) };
    case 'mtext':
      return { ...e, position: tf(e.position), height: e.height * k, width: e.width * k, rotation: e.rotation + rotation };
    case 'dimension':
      return {
        ...e,
        p1: tf(e.p1),
        p2: tf(e.p2),
        linePoint: tf(e.linePoint),
        center: e.center ? tf(e.center) : e.center,
        textPosition: e.textPosition ? tf(e.textPosition) : e.textPosition,
        rotation: e.rotation + rotation,
        style: k === 1 ? e.style : { ...e.style, scale: e.style.scale * k },
      };
    case 'spline':
    case 'hatch':
    case 'leader':
    case 'table':
    case 'image':
      return affineCompound(e, { tf, vec: (v) => g.rotate(g.scale(v, k), rotation), rotation, kx: k, ky: k, mirrored: false });
  }
}

function transformEntity(e: Entity, tf: (p: Point) => Point, ins: InsertEntity, similar: boolean, lookup: BlockLookup, depth: number): Entity[] {
  // Entities on layer "0" inside a block inherit the insert's layer (AutoCAD behaviour).
  const lay = e.layer === '0' ? ins.layer : e.layer;
  const col: ColorSpec = e.color === 'ByLayer' && e.layer === '0' ? ins.color : e.color;
  const lt = e.linetype && e.linetype.toUpperCase() === 'BYBLOCK' ? ins.linetype : e.linetype;
  const styled = { ...e, layer: lay, color: col, linetype: lt } as Entity;
  const moved = similar ? similarityTransform(styled, tf, ins.rotation, ins.scale) : blockTransform(styled, tf, ins.rotation, ins.scale, ins.scaleY ?? ins.scale, Boolean(ins.mirror));
  if (moved.type === 'insert') return explodeInsert(moved, lookup, depth);
  return [moved];
}

export function entityBounds(e: Entity, lookup: BlockLookup): Bounds | null {
  switch (e.type) {
    case 'line':
      return g.boundsOfPoints([e.a, e.b]);
    case 'circle':
      return {
        min: { x: e.center.x - e.radius, y: e.center.y - e.radius },
        max: { x: e.center.x + e.radius, y: e.center.y + e.radius },
      };
    case 'arc':
      return g.boundsOfPoints(arcPoints(e, 16));
    case 'polyline': {
      const b = g.boundsOfPoints(polylineVertices(e));
      if (!b || !e.width) return b;
      const h = e.width / 2;
      return { min: { x: b.min.x - h, y: b.min.y - h }, max: { x: b.max.x + h, y: b.max.y + h } };
    }
    case 'text':
      return textBounds(e);
    case 'insert':
      return cachedInsert(e, lookup)?.bounds ?? g.boundsOfPoints([e.position]);
    case 'ellipse':
      return g.boundsOfPoints(ellipsePoints(e));
    case 'point':
      return { min: e.position, max: e.position };
    case 'xline':
    case 'ray':
      return g.boundsOfPoints(rayEndpoints(e));
    case 'mtext': {
      let b: Bounds | null = null;
      for (const t of mtextParts(e)) b = g.unionBounds(b, textBounds(t));
      for (const l of mtextDecorations(e)) b = g.unionBounds(b, g.boundsOfPoints([l.a, l.b]));
      return b ?? { min: e.position, max: e.position };
    }
    case 'dimension': {
      let b: Bounds | null = null;
      for (const p of dimensionParts(e)) b = g.unionBounds(b, entityBounds(p, lookup));
      return b ?? g.boundsOfPoints([e.p1, e.p2]);
    }
    case 'spline':
      return g.boundsOfPoints(splinePoints(e));
    case 'hatch': {
      let b: Bounds | null = null;
      for (const poly of hatchGeometry(e).polys) b = g.unionBounds(b, g.boundsOfPoints(poly));
      return b;
    }
    case 'leader':
    case 'table':
    case 'image': {
      let b: Bounds | null = null;
      for (const p of compoundParts(e)) b = g.unionBounds(b, entityBounds(p, lookup));
      return b;
    }
  }
}

/** Primitive parts of a leader, table or image (for bounds, hit testing, snapping, drawing). */
export function compoundParts(e: LeaderEntity | TableEntity | ImageEntity): Entity[] {
  return e.type === 'leader' ? leaderParts(e) : e.type === 'table' ? tableParts(e) : imageParts(e);
}

/** Distance from point to entity outline (world units). */
export function distanceToEntity(p: Point, e: Entity, lookup: BlockLookup): number {
  switch (e.type) {
    case 'line':
      return g.distToSegment(p, e.a, e.b);
    case 'circle':
      return Math.abs(g.dist(p, e.center) - e.radius);
    case 'arc': {
      const a = g.angleOf(e.center, p);
      if (g.angleInSweep(a, e.startAngle, e.endAngle)) return Math.abs(g.dist(p, e.center) - e.radius);
      const [s, en] = arcEndpoints(e);
      return Math.min(g.dist(p, s), g.dist(p, en));
    }
    case 'polyline': {
      let best = Infinity;
      const pts = polylineVertices(e);
      const n = pts.length;
      for (let i = 0; i < n - 1; i += 1) best = Math.min(best, g.distToSegment(p, pts[i]!, pts[i + 1]!));
      if (e.closed && n > 2) best = Math.min(best, g.distToSegment(p, pts[n - 1]!, pts[0]!));
      if (n === 1) best = g.dist(p, pts[0]!);
      if (e.filled && e.closed && pointInPolygon(p, pts)) return 0;
      return Math.max(0, best - (e.width ?? 0) / 2);
    }
    case 'text': {
      const b = textBounds(e);
      if (g.pointInBounds(p, b)) return 0;
      const cx = Math.max(b.min.x, Math.min(p.x, b.max.x));
      const cy = Math.max(b.min.y, Math.min(p.y, b.max.y));
      return g.dist(p, { x: cx, y: cy });
    }
    case 'insert': {
      let best = Infinity;
      for (const sub of explodeInsert(e, lookup)) best = Math.min(best, distanceToEntity(p, sub, lookup));
      return best;
    }
    case 'ellipse': {
      let best = Infinity;
      const pts = ellipsePoints(e);
      for (let i = 0; i < pts.length - 1; i += 1) best = Math.min(best, g.distToSegment(p, pts[i]!, pts[i + 1]!));
      return best;
    }
    case 'point':
      return g.dist(p, e.position);
    case 'xline':
    case 'ray': {
      const [a, b] = rayEndpoints(e);
      return g.distToSegment(p, a, b);
    }
    case 'mtext': {
      let best = Infinity;
      for (const t of mtextParts(e)) best = Math.min(best, distanceToEntity(p, t, lookup));
      for (const l of mtextDecorations(e)) best = Math.min(best, g.distToSegment(p, l.a, l.b));
      return best;
    }
    case 'dimension': {
      let best = Infinity;
      for (const part of dimensionParts(e)) best = Math.min(best, distanceToEntity(p, part, lookup));
      return best;
    }
    case 'spline': {
      const pts = splinePoints(e);
      let best = pts.length === 1 ? g.dist(p, pts[0]!) : Infinity;
      for (let i = 0; i < pts.length - 1; i += 1) best = Math.min(best, g.distToSegment(p, pts[i]!, pts[i + 1]!));
      return best;
    }
    case 'hatch': {
      const geo = hatchGeometry(e);
      if ((e.solid || geo.dense) && pointInLoops(p, geo.polys)) return 0;
      let best = Infinity;
      for (const poly of geo.polys) for (let i = 0; i < poly.length; i += 1) best = Math.min(best, g.distToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
      for (const [a, b] of geo.segments) best = Math.min(best, g.distToSegment(p, a, b));
      return best;
    }
    case 'leader':
    case 'table':
    case 'image': {
      if (e.type === 'image' && pointInPolygon(p, imageBoundary(e))) return 0;
      let best = Infinity;
      for (const part of compoundParts(e)) best = Math.min(best, distanceToEntity(p, part, lookup));
      return best;
    }
  }
}

export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Translate an entity by a delta. */
export function translateEntity(e: Entity, d: Point): Entity {
  return similarityTransform(e, (p) => g.add(p, d), 0, 1);
}

/** Rotate an entity about a point. */
export function rotateEntity(e: Entity, about: Point, angle: number): Entity {
  return similarityTransform(e, (p) => g.rotate(p, angle, about), angle, 1);
}

/** Scale an entity uniformly about a base point. */
export function scaleEntityBy(e: Entity, base: Point, k: number): Entity {
  return similarityTransform(e, (p) => g.add(base, g.scale(g.sub(p, base), k)), 0, k);
}

/** Mirror an entity across the line a-b (MIRRTEXT = 0: text stays readable). */
export function mirrorEntityAcross(e: Entity, a: Point, b: Point): Entity {
  const d = g.normalize(g.sub(b, a));
  const reflect = (p: Point): Point => {
    const v = g.sub(p, a);
    const proj = g.scale(d, g.dot(v, d));
    const perp = g.sub(v, proj);
    return g.add(a, g.sub(proj, perp));
  };
  const lineAngle = Math.atan2(d.y, d.x);
  const reflectAngle = (t: number) => 2 * lineAngle - t;
  switch (e.type) {
    case 'line':
      return { ...e, a: reflect(e.a), b: reflect(e.b) };
    case 'circle':
      return { ...e, center: reflect(e.center) };
    case 'arc':
      return { ...e, center: reflect(e.center), startAngle: reflectAngle(e.endAngle), endAngle: reflectAngle(e.startAngle) };
    case 'polyline':
      return { ...e, points: e.points.map(reflect), bulges: e.bulges?.map((bu) => -bu) };
    case 'text':
      return { ...e, position: reflect(e.position) };
    case 'insert':
      // A reflection is a mirror about the block's Y axis plus a rotation: the block geometry is
      // mirrored while attribute / text glyphs stay readable (MIRRTEXT = 0), like AutoCAD.
      return { ...e, position: reflect(e.position), rotation: normAngle(reflectAngle(e.rotation) + Math.PI), mirror: !e.mirror };
    case 'ellipse': {
      const tip = reflect(g.add(e.center, e.majorAxis));
      const c = reflect(e.center);
      // parameter direction flips; keep the same visible arc
      return { ...e, center: c, majorAxis: g.sub(tip, c), startParam: -e.endParam, endParam: -e.startParam };
    }
    case 'point':
      return { ...e, position: reflect(e.position) };
    case 'xline':
    case 'ray': {
      const tip = reflect(g.add(e.base, e.direction));
      const base = reflect(e.base);
      return { ...e, base, direction: g.sub(tip, base) };
    }
    case 'mtext':
      return { ...e, position: reflect(e.position) };
    case 'dimension':
      return {
        ...e,
        p1: reflect(e.p1),
        p2: reflect(e.p2),
        linePoint: reflect(e.linePoint),
        center: e.center ? reflect(e.center) : e.center,
        textPosition: e.textPosition ? reflect(e.textPosition) : e.textPosition,
        rotation: e.kind === 'linear' ? reflectAngle(e.rotation) : e.rotation,
      };
    case 'spline':
    case 'hatch':
    case 'leader':
    case 'table':
    case 'image': {
      const rv = (v: Point): Point => g.sub(g.scale(d, 2 * g.dot(v, d)), v);
      return affineCompound(e, { tf: reflect, vec: rv, rotation: 0, kx: 1, ky: 1, mirrored: true });
    }
  }
}

/** Grip points (AutoCAD-style) for an entity. */
export function gripPoints(e: Entity): Point[] {
  switch (e.type) {
    case 'line':
      return [e.a, g.mid(e.a, e.b), e.b];
    case 'circle':
      return [
        e.center,
        { x: e.center.x + e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.radius },
        { x: e.center.x - e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y - e.radius },
      ];
    case 'arc': {
      const [s, en] = arcEndpoints(e);
      return [s, arcMidpoint(e), en, e.center];
    }
    case 'polyline':
      return [...e.points];
    case 'text':
      return [e.position];
    case 'insert':
      return [e.position];
    case 'ellipse':
      return [e.center, g.add(e.center, e.majorAxis), g.sub(e.center, e.majorAxis), ellipsePoint(e, Math.PI / 2), ellipsePoint(e, -Math.PI / 2)];
    case 'point':
      return [e.position];
    case 'xline':
      return [e.base];
    case 'ray':
      return [e.base];
    case 'mtext':
      return [e.position];
    case 'dimension': {
      const textPos = dimensionParts(e).find((p): p is TextEntity => p.type === 'text')?.position ?? e.linePoint;
      return e.kind === 'angular' && e.center ? [e.p1, e.p2, e.linePoint, e.center, textPos] : [e.p1, e.p2, e.linePoint, textPos];
    }
    case 'spline':
      return [...(e.fitPoints?.length ? e.fitPoints : e.controlPoints)];
    case 'hatch': {
      const b = entityBounds(e, () => undefined);
      return b ? [g.mid(b.min, b.max)] : [];
    }
    case 'leader': {
      const pts = [...e.vertices];
      if (e.dogleg) pts.push(g.add(e.vertices[e.vertices.length - 1] ?? { x: 0, y: 0 }, e.dogleg));
      if (e.textPosition) pts.push(e.textPosition);
      return pts;
    }
    case 'table':
      return [e.position];
    case 'image':
      return imageCorners(e);
  }
}

/** Move grip `index` of an entity to `p` (AutoCAD grip stretch semantics). */
export function moveGrip(e: Entity, index: number, p: Point): Entity | null {
  switch (e.type) {
    case 'line':
      if (index === 0) return { ...e, a: p };
      if (index === 2) return { ...e, b: p };
      {
        const d = g.sub(p, g.mid(e.a, e.b));
        return { ...e, a: g.add(e.a, d), b: g.add(e.b, d) };
      }
    case 'circle':
      if (index === 0) return { ...e, center: p };
      return { ...e, radius: Math.max(1e-6, g.dist(e.center, p)) };
    case 'arc': {
      if (index === 3) return { ...e, center: p };
      const a = g.angleOf(e.center, p);
      if (index === 0) return { ...e, startAngle: a };
      if (index === 2) return { ...e, endAngle: a };
      return { ...e, radius: Math.max(1e-6, g.dist(e.center, p)) };
    }
    case 'polyline':
      return { ...e, points: e.points.map((q, i) => (i === index ? p : q)) };
    case 'text':
    case 'insert':
    case 'point':
    case 'mtext':
      return { ...e, position: p };
    case 'ellipse': {
      if (index === 0) return { ...e, center: p };
      if (index === 1) return { ...e, majorAxis: g.sub(p, e.center) };
      if (index === 2) return { ...e, majorAxis: g.sub(e.center, p) };
      const a = g.len(e.majorAxis);
      const b = g.dist(p, e.center);
      return a > 1e-9 ? { ...e, ratio: Math.min(1, Math.max(1e-6, b / a)) } : e;
    }
    case 'xline':
    case 'ray':
      return { ...e, base: p };
    case 'dimension': {
      if (index === 0) return { ...e, p1: p };
      if (index === 1) return { ...e, p2: p };
      if (index === 2) return { ...e, linePoint: p, textPosition: undefined };
      if (e.kind === 'angular' && e.center && index === 3) return { ...e, center: p };
      return { ...e, textPosition: p };
    }
    case 'spline': {
      if (e.fitPoints?.length) {
        const fit = e.fitPoints.map((q, i) => (i === index ? p : q));
        const rebuilt = splineThroughPoints(e, fit, e.closed);
        return rebuilt ? { ...rebuilt, id: e.id } : { ...e, fitPoints: fit };
      }
      return { ...e, controlPoints: e.controlPoints.map((q, i) => (i === index ? p : q)) };
    }
    case 'leader': {
      const nv = e.vertices.length;
      if (index < nv) return { ...e, vertices: e.vertices.map((q, i) => (i === index ? p : q)) };
      const doglegIndex = e.dogleg ? nv : -1;
      if (index === doglegIndex && nv) return { ...e, dogleg: g.sub(p, e.vertices[nv - 1]!) };
      if (e.textPosition) return translateEntity(e, g.sub(p, e.textPosition)) as LeaderEntity;
      return e;
    }
    case 'hatch':
    case 'table':
    case 'image': {
      const from = gripPoints(e)[index];
      return from ? translateEntity(e, g.sub(p, from)) : e;
    }
  }
}

/** Points used by object snap: endpoints, midpoints, centers, quadrants. */
export interface SnapCandidate {
  point: Point;
  kind: 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'node' | 'insertion';
}

export function snapCandidates(e: Entity, lookup: BlockLookup): SnapCandidate[] {
  switch (e.type) {
    case 'line':
      return [
        { point: e.a, kind: 'endpoint' },
        { point: e.b, kind: 'endpoint' },
        { point: g.mid(e.a, e.b), kind: 'midpoint' },
      ];
    case 'circle':
      return [
        { point: e.center, kind: 'center' },
        { point: { x: e.center.x + e.radius, y: e.center.y }, kind: 'quadrant' },
        { point: { x: e.center.x, y: e.center.y + e.radius }, kind: 'quadrant' },
        { point: { x: e.center.x - e.radius, y: e.center.y }, kind: 'quadrant' },
        { point: { x: e.center.x, y: e.center.y - e.radius }, kind: 'quadrant' },
      ];
    case 'arc': {
      const [s, en] = arcEndpoints(e);
      return [
        { point: s, kind: 'endpoint' },
        { point: en, kind: 'endpoint' },
        { point: arcMidpoint(e), kind: 'midpoint' },
        { point: e.center, kind: 'center' },
      ];
    }
    case 'polyline': {
      const out: SnapCandidate[] = e.points.map((p) => ({ point: p, kind: 'endpoint' as const }));
      for (const s of polylineSegments(e)) {
        if (s.arc) {
          out.push({ point: g.polar(s.arc.center, g.angleOf(s.arc.center, s.a) + s.arc.sweep / 2, s.arc.radius), kind: 'midpoint' });
          out.push({ point: s.arc.center, kind: 'center' });
        } else out.push({ point: g.mid(s.a, s.b), kind: 'midpoint' });
      }
      return out;
    }
    case 'text':
      return [{ point: e.position, kind: 'insertion' }];
    case 'insert': {
      const out: SnapCandidate[] = [{ point: e.position, kind: 'insertion' }];
      for (const sub of explodeInsert(e, lookup)) {
        if (sub.type === 'text') continue;
        for (const c of snapCandidates(sub, lookup)) if (c.kind === 'endpoint') out.push(c);
      }
      return out;
    }
    case 'ellipse': {
      const out: SnapCandidate[] = [{ point: e.center, kind: 'center' }];
      if (isFullEllipse(e)) {
        for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) out.push({ point: ellipsePoint(e, t), kind: 'quadrant' });
      } else {
        out.push({ point: ellipsePoint(e, e.startParam), kind: 'endpoint' }, { point: ellipsePoint(e, e.endParam), kind: 'endpoint' });
        out.push({ point: ellipsePoint(e, e.startParam + ellipseSweep(e) / 2), kind: 'midpoint' });
      }
      return out;
    }
    case 'point':
      return [{ point: e.position, kind: 'node' }];
    case 'xline':
      return [];
    case 'ray':
      return [{ point: e.base, kind: 'endpoint' }];
    case 'mtext':
      return [{ point: e.position, kind: 'insertion' }];
    case 'dimension': {
      const out: SnapCandidate[] = [];
      for (const part of dimensionParts(e)) {
        if (part.type === 'line') out.push({ point: part.a, kind: 'endpoint' }, { point: part.b, kind: 'endpoint' });
        else if (part.type === 'text') out.push({ point: part.position, kind: 'insertion' });
      }
      return out;
    }
    case 'spline': {
      const pts = splinePoints(e);
      if (!pts.length) return [];
      if (e.closed) return [{ point: pts[0]!, kind: 'endpoint' }];
      return [
        { point: pts[0]!, kind: 'endpoint' },
        { point: pts[pts.length - 1]!, kind: 'endpoint' },
      ];
    }
    case 'hatch':
      return [];
    case 'leader': {
      const out: SnapCandidate[] = leaderPath(e).map((q) => ({ point: q, kind: 'endpoint' as const }));
      if (e.textPosition) out.push({ point: e.textPosition, kind: 'insertion' });
      return out;
    }
    case 'table': {
      const out: SnapCandidate[] = [{ point: e.position, kind: 'insertion' }];
      for (const part of tableParts(e)) if (part.type === 'line') out.push({ point: part.a, kind: 'endpoint' }, { point: part.b, kind: 'endpoint' });
      return out;
    }
    case 'image':
      return [{ point: e.position, kind: 'insertion' }, ...imageCorners(e).map((q) => ({ point: q, kind: 'endpoint' as const }))];
  }
}

/** Straight segments of an entity (arcs/circles approximated) for intersections. */
export function entitySegments(e: Entity, lookup: BlockLookup): Array<[Point, Point]> {
  switch (e.type) {
    case 'line':
      return [[e.a, e.b]];
    case 'circle': {
      const pts = arcPoints({ ...e, startAngle: 0, endAngle: 2 * Math.PI }, 48);
      return pairs(pts);
    }
    case 'arc':
      return pairs(arcPoints(e, 32));
    case 'polyline': {
      const pts = polylineVertices(e);
      const segs = pairs(pts);
      if (e.closed && pts.length > 2) segs.push([pts[pts.length - 1]!, pts[0]!]);
      return segs;
    }
    case 'text':
      return [];
    case 'insert': {
      const out: Array<[Point, Point]> = [];
      for (const sub of explodeInsert(e, lookup)) out.push(...entitySegments(sub, lookup));
      return out;
    }
    case 'ellipse':
      return pairs(ellipsePoints(e));
    case 'point':
      return [];
    case 'xline':
    case 'ray':
      return [rayEndpoints(e)];
    case 'mtext':
      return [];
    case 'dimension': {
      const out: Array<[Point, Point]> = [];
      for (const part of dimensionParts(e)) out.push(...entitySegments(part, lookup));
      return out;
    }
    case 'spline':
      return pairs(splinePoints(e));
    case 'hatch': {
      const out: Array<[Point, Point]> = [];
      for (const poly of hatchGeometry(e).polys) for (let i = 0; i < poly.length; i += 1) out.push([poly[i]!, poly[(i + 1) % poly.length]!]);
      return out;
    }
    case 'leader':
    case 'table':
    case 'image': {
      const out: Array<[Point, Point]> = [];
      for (const part of compoundParts(e)) out.push(...entitySegments(part, lookup));
      return out;
    }
  }
}

function pairs(pts: readonly Point[]): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i < pts.length - 1; i += 1) out.push([pts[i]!, pts[i + 1]!]);
  return out;
}

/** AutoCAD entity name for LIST / status output. */
export function entityTypeName(e: Entity): string {
  switch (e.type) {
    case 'line':
      return 'LINE';
    case 'circle':
      return 'CIRCLE';
    case 'arc':
      return 'ARC';
    case 'polyline':
      return 'LWPOLYLINE';
    case 'text':
      return 'TEXT';
    case 'insert':
      return 'INSERT';
    case 'ellipse':
      return 'ELLIPSE';
    case 'point':
      return 'POINT';
    case 'xline':
      return 'XLINE';
    case 'ray':
      return 'RAY';
    case 'mtext':
      return 'MTEXT';
    case 'dimension':
      return 'DIMENSION';
    case 'spline':
      return 'SPLINE';
    case 'hatch':
      return 'HATCH';
    case 'leader':
      return e.kind === 'mleader' ? 'MULTILEADER' : 'LEADER';
    case 'table':
      return 'ACAD_TABLE';
    case 'image':
      return 'IMAGE';
  }
}
