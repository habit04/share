import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import { strokeTextWidth } from '../render/hershey';
import { dimensionGeometry, dimensionTextPoint, type DimensionEntity } from './dimension';
import { mtextLayoutFull, type MTextEntity, type MTextAttachment, type MTextColumns, type MTextBackground, type MTextStyle, type Measure, type InkMeasure } from './mtext';
import { metricTextPlacement, type TextGeometryContext } from './text-metrics';
import { interpolateFitPoints, isValidNurbs, nurbsPoints, type NurbsCurve } from './spline';
import { bulgeArcSteps, isHatchBulge, findPattern, loopPolygon, patternSegments, pointInLoops, worldPatternLines, type HatchLoop, type WorldPatternLine } from './hatch';
import { tableGeometry, type TableEntity } from './table';
import { isImmutableData } from './immutable-data';
import { GeometryBudgetError } from './geometry-budget-error';
import { placedText, scaledText, transformedTextAnchors, textAnchor, type TextPlacement } from './text-placement';
import { mtextBackgroundPolygons, hasMTextFill, hasMTextFrame, entityMTextBackground } from './mtext-background';
import { polylineWidthGeometry, polylineWidthFrame, transformWidthFrame, polylineFramePoint, polylineFrameSource, polylineWidthProblem, moveWidthFrameGrip } from './polyline-widths';
import { appearanceProperties, inheritedTransparency, resolveAlpha, type TransparencySpec } from './appearance';
import { insertArrayCount, insertArrayInstances, MAX_INSERT_ARRAY_INSTANCES } from './insert-array';
import { evaluateDynamicBlock, type AttributeActionTransform } from './parametric/evaluate';
import { dynamicGrips } from './parametric/grips';
import { hasHatchGradient, hatchGradientDataProblem, hatchGradientFrame, hatchGradientFrameProblem, transformHatchGradientFrame, type HatchGradient, type HatchGradientFrame } from './hatch-gradient';
import type { MLeaderNative } from './multileader';

export type { MLeaderNative, MLeaderContentType, MLeaderStyleData } from './multileader';

export type { DimensionEntity, DimStyle, DimKind } from './dimension';
export type { MTextEntity, MTextAttachment } from './mtext';
export type { TableEntity, TableCell } from './table';
export type { HatchLoop, WorldPatternLine } from './hatch';
export type { HatchGradient, HatchGradientColor, HatchGradientFrame } from './hatch-gradient';

/**
 * AutoCAD Color Index (1..255). 'ByLayer' (DXF 256) inherits the colour of the object's layer;
 * 0 is ByBlock: inside a block the object takes the colour of the block reference (see
 * `inheritedColor`), outside any block it shows in the foreground colour (ACI 7).
 */
export type ColorSpec = 'ByLayer' | number;

/** DXF colour number 0: the object takes the colour of the block reference that shows it. */
export const BYBLOCK = 0;

export interface EntityBase {
  readonly id: string;
  /** Stable document-local identity of imported CAD data; file handles remain in cadGraph. */
  readonly cadIdentity?: string;
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
  /** Named/color-book identity (DXF 430), retained independently of ACI/RGB. */
  readonly colorName?: string;
  /** Opacity byte, or ByLayer/ByBlock inheritance. Undefined means ByLayer. */
  readonly transparency?: TransparencySpec;
  /** Display only: ByBlock alpha inherited from a reference's layer. */
  readonly transparencyLayer?: string;
  /** Annotative object (text, mtext, dimension, leader, insert): its paper size stays constant (see core/layouts.ts). */
  readonly annotative?: boolean;
  /**
   * Display only, set on exploded block content: the layer whose colour a 'ByLayer' colour
   * resolves against instead of the object's own layer. A ByBlock object inside a ByLayer
   * block reference shows the colour of the reference's layer while it stays on its own layer
   * (for visibility). Never stored in drawings or written to files (see `bakeInheritedColor`).
   */
  readonly colorLayer?: string;
}

/** A field expression behind a text value (%<\AcVar Date>% ...): `value` is what the code evaluated to. */
export interface FieldLink {
  /** The expression is carried by retained native FIELD objects, including their reference vectors. */
  readonly native?: boolean;
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
  /** Start/end width of the segment at each vertex (DXF 40/41). Takes precedence over width. */
  readonly widths?: readonly { readonly start: number; readonly end: number }[];
  /**
   * Per-vertex persistent identifiers (DXF LWPOLYLINE group 91), parallel to
   * `points`; an `undefined` entry means that vertex carries no identifier.
   * Present only when at least one vertex has one. AutoCAD's ASSOC geom
   * dependencies address vertices by these IDs (Q11 F4), so reader and
   * writer preserve them verbatim; they are never synthesized or renumbered.
   */
  readonly vertexIds?: readonly (number | undefined)[];
  /** Affine display geometry after a nonuniform transform; native block definitions keep their widths. */
  readonly widthFrame?: {
    readonly points: readonly Point[];
    readonly bulges?: readonly number[];
    readonly width?: number;
    readonly widths?: readonly { readonly start: number; readonly end: number }[];
    readonly origin: Point;
    readonly x: Point;
    readonly y: Point;
  };
  /** Closed polyline drawn as a solid fill (dimension arrowheads, SOLID entities). */
  readonly filled?: boolean;
}

export interface TextEntity extends EntityBase, TextPlacement {
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
  readonly style?: string;
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
  /** MINSERT grid; counts default to one, spacing is independent of the block scale. */
  readonly columns?: number;
  readonly rows?: number;
  readonly columnSpacing?: number;
  readonly rowSpacing?: number;
  /**
   * Visible attributes of the block that this insert does not display (ATTRIB flag 1 on the
   * insert only), e.g. TAG1 on poles 2 and 3 of a 3-pole device. The value is kept for reports.
   */
  readonly hiddenAttributes?: readonly string[];
  /**
   * Native per-insert attribute placement, stored in the block's local coordinate system,
   * relative to the AUTHORED attribute definition: for a dynamic block the evaluation's
   * per-attribute transform (anchors, height and rotation — the whole placement motion,
   * review R07 + round 3 R2-01) is composed with the stored placement wherever the current
   * state is rendered or written (see attributePlacementsForDef), so an imported override
   * describes the attribute's placement in the authored frame — never a pin against
   * the evaluated placement.
   */
  readonly attributePlacements?: Readonly<Record<string, TextPlacement & AttributeAppearance & { readonly style?: string }>>;
  /**
   * Priority 30: this instance's dynamic parameter values (sparse; absent values take the
   * definition's defaults). Lives on the insert itself so the expansion cache, keyed by
   * insert object identity, can never serve stale evaluated geometry. Absent = the block
   * is static for this instance (or has no dynamic definition).
   */
  readonly dynamic?: import('./parametric/instance').DynamicInstanceState;
  /**
   * Priority 30: raw JCAD_DYNAMIC instance payload that could not be modeled (malformed
   * or a newer model version). Retained verbatim for re-export; the instance displays at
   * the definition's authored (default) state.
   */
  readonly dynamicRetained?: string;
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
  /** Native gradient descriptor, retained separately from the hatch pattern. */
  readonly gradient?: HatchGradient;
  /** Affine display frame after a block transform; native block definitions remain unchanged. */
  readonly gradientFrame?: HatchGradientFrame;
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
  /** Native associated MTEXT's mask and layout, kept when the two records become one leader. */
  readonly textBackground?: MTextBackground;
  readonly textAppearance?: AttributeAppearance & Pick<EntityBase, 'colorLayer' | 'transparencyLayer'>;
  readonly textLayer?: string;
  readonly textLineSpacing?: number;
  readonly textColumns?: MTextColumns;
  /** Where it came from (LEADER + MTEXT or MULTILEADER). */
  readonly kind?: 'leader' | 'mleader';
  /**
   * P18: native multileader data (core/multileader.ts). Present only on a
   * `kind: 'mleader'` whose content this build models (slice 1: MTEXT / none):
   * such an entity is written back as a native MULTILEADER + MLEADERSTYLE.
   * Absent (every pre-P18 save; block-content imports) the write-back stays
   * LEADER + MTEXT, exactly as before, and the import report says so.
   */
  readonly mleader?: MLeaderNative;
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

export interface AttributeAppearance {
  readonly layer?: string;
  readonly color?: ColorSpec;
  readonly trueColor?: number;
  readonly colorName?: string;
  readonly transparency?: 'ByLayer' | 'ByBlock' | number;
}

export interface AttributeDef extends TextPlacement, AttributeAppearance {
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
  readonly style?: string;
}

export interface BlockDef {
  readonly name: string;
  readonly basePoint: Point;
  readonly entities: readonly Entity[];
  readonly attributes: readonly AttributeDef[];
  readonly description?: string;
  /**
   * Priority 30: JCad's authored dynamic-block definition for this block (parameters +
   * actions, see core/parametric/definitions.ts). The definition is immutable and shared
   * by every instance; per-instance values live on the insert (`InsertEntity.dynamic`).
   * This is JCad's normalized model, not a decoded native evaluation graph.
   */
  readonly dynamic?: import('./parametric/definitions').DynamicBlockDefinition;
  /**
   * Priority 30: raw JCAD_DYNAMIC definition payload that could not be modeled (malformed
   * or a newer model version). Retained verbatim for re-export, reported as simplified,
   * never half-parsed; the block displays and edits as a static block.
   */
  readonly dynamicRetained?: string;
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
  /** Plot flag (DXF 290): false = shown on screen but never plotted (like DEFPOINTS). */
  readonly plot?: boolean;
  /** True colour 0xRRGGBB (DXF 420 on the LAYER record); shown instead of `color` when set. */
  readonly trueColor?: number;
  readonly colorName?: string;
  /** Explicit opacity byte; layer inheritance values are preserved but resolve opaque. */
  readonly transparency?: TransparencySpec;
  /** Xref-dependent LAYER flags (DXF 70 bits 16 and 32), kept from the source file. */
  readonly xrefFlags?: number;
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `e${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export type BlockLookup = ((name: string) => BlockDef | undefined) & { readonly textGeometry?: TextGeometryContext };

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

/** Placed text's oriented quadrilateral, including alignment and oblique shear. */
export function textCorners(t: TextEntity, context?: TextGeometryContext): Point[] {
  const appearance = context?.resolve(t);
  // SHX/unknown fonts keep the existing stroke geometry and explicit entity appearance.
  if (context && (appearance?.kind === 'canvas' || appearance?.kind === 'stroke' && appearance.shxResourceId && context.shxRun?.(t.text, t.height, appearance)?.ok)) {
    const placed = metricTextPlacement(t, context);
    t = placed.text;
    const { metrics } = placed;
    const widthFactor = t.widthFactor ?? 1;
    const emptyInk = metrics.left === 0 && metrics.right === 0 && metrics.ascent === 0 && metrics.descent === 0;
    const left = (placed.offset + (emptyInk ? 0 : metrics.left)) * widthFactor;
    const right = (placed.offset + (emptyInk ? metrics.advance : metrics.right)) * widthFactor;
    const ascent = emptyInk ? t.height : metrics.ascent, descent = emptyInk ? 0 : metrics.descent;
    return [
      { x: left, y: -descent },
      { x: right, y: -descent },
      { x: right, y: ascent },
      { x: left, y: ascent },
    ].map((c) => g.add(t.position, g.rotate({ x: c.x + c.y * Math.tan(t.oblique ?? 0), y: c.y }, t.rotation)));
  }
  t = placedText(t, textWidth);
  const w = textWidth(t.text, t.height) * (t.widthFactor ?? 1);
  const ox = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  return [
    { x: ox, y: 0 },
    { x: ox + w, y: 0 },
    { x: ox + w, y: t.height },
    { x: ox, y: t.height },
  ].map((c) => g.add(t.position, g.rotate({ x: c.x + c.y * Math.tan(t.oblique ?? 0), y: c.y }, t.rotation)));
}

export function textBounds(t: TextEntity, context?: TextGeometryContext): Bounds {
  return g.boundsOfPoints(textCorners(t, context))!;
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
  // Use the bulge directly: sin(2*atan(b)) loses the small complement of a nearly
  // full circle, and squaring r overflows for otherwise finite large-radius arcs.
  const magnitude = Math.abs(bulge);
  const r = (chord / 4) * magnitude + (chord / 4) / magnitude;
  const m = { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 };
  const offset = (chord / 4) / bulge - (chord / 4) * bulge;
  const nrm = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
  const center = { x: m.x + nrm.x * offset, y: m.y + nrm.y * offset };
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
  if (pl.widthFrame) return polylineSegments({ ...pl, points: polylineVertices(pl), bulges: undefined, widthFrame: undefined });
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
  if (pl.widthFrame) out = polylineVertices(polylineFrameSource(pl)).map((point) => polylineFramePoint(pl.widthFrame!, point));
  else if (!pl.bulges || !pl.bulges.some((b) => Math.abs(b) > 1e-12)) out = [...pl.points];
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

interface GeneratedParts {
  readonly contextKey?: object;
  readonly parts: Entity[];
}
const dimCache = new WeakMap<DimensionEntity, GeneratedParts>();
function dimensionMeasure(d: DimensionEntity, context?: TextGeometryContext) {
  // The dimension's style object is a DIMSTYLE; only DIMTXSTY names the emitted font.
  return context ? (text: string, height: number) => {
      const appearance = context.resolve({ style: d.style.textStyle, text });
      if (appearance.kind === 'stroke' && !appearance.shxResourceId) return textWidth(text, height);
      const metric = context.measure(text, height, appearance);
      // Native ordinate text placement uses the visible span; the font's trailing advance
      // would move the label away from its leader (notably for ordinary SHX numerals).
      return ((d.kind === 'ordinate' ? metric.right : Math.max(metric.advance, metric.right)) - Math.min(0, metric.left)) * appearance.widthFactor;
    }
    : textWidth;
}

/** Primitive entities (lines, arrow solids, text) that draw a dimension. Cached per entity. */
export function dimensionParts(d: DimensionEntity, context?: TextGeometryContext): Entity[] {
  const hit = dimCache.get(d);
  if (hit && hit.contextKey === context?.cacheKey) return hit.parts;
  const parts = dimensionGeometry(d, dimensionMeasure(d, context)) as Entity[];
  dimCache.set(d, { contextKey: context?.cacheKey, parts });
  return parts;
}

interface MTextRendered {
  readonly contextKey?: object;
  texts: TextEntity[];
  lines: LineEntity[];
  masks: Point[][];
}
const mtextCache = new WeakMap<MTextEntity, MTextRendered>();
function mtextRendered(m: MTextEntity, context?: TextGeometryContext): MTextRendered {
  const hit = mtextCache.get(m);
  if (hit && hit.contextKey === context?.cacheKey) return hit;
  const runAppearance = (run?: MTextStyle, text?: string) => {
    const runWidth = run?.widthFactor ?? 1;
    return context?.resolve({
      text,
      ...(m.style ? { style: m.style } : {}),
      ...(run && Math.abs(runWidth - 1) > 1e-9 ? { widthFactor: runWidth } : {}),
      ...(run && (run.oblique || run.italic) ? { oblique: run.oblique || g.rad(15) } : {}),
      ...(run?.bold ? { bold: true } : {}),
    });
  };
  const measure: Measure = context ? (text, height, run) => {
    const runWidth = run?.widthFactor ?? 1, appearance = runAppearance(run, text)!;
    if (appearance.kind === 'stroke' && !appearance.shxResourceId) return textWidth(text, height);
    // Layout applies the run's width factor outside the measurement callback. Return the
    // inherited/effective width divided by that factor so it is applied exactly once.
    return context.measure(text, height, appearance).advance * appearance.widthFactor / runWidth;
  } : textWidth;
  const baseAppearance = runAppearance(undefined, m.text.replace(/[\r\n\t]/g, ''));
  const ink: InkMeasure | undefined = context && (baseAppearance?.kind === 'canvas' || baseAppearance?.kind === 'stroke' && baseAppearance.shxResourceId) ? (text, height, run) => {
    if (!text.trim()) return null;
    const appearance = runAppearance(run, text)!;
    if (appearance.kind === 'stroke' && !appearance.shxResourceId) return null;
    const metric = context.measure(text, height, appearance), slant = Math.tan(appearance.oblique);
    if (metric.left === 0 && metric.right === 0 && metric.ascent === 0 && metric.descent === 0) return null;
    const x0 = -metric.descent * slant, x1 = metric.ascent * slant;
    return { left: metric.left * appearance.widthFactor + Math.min(x0, x1), right: metric.right * appearance.widthFactor + Math.max(x0, x1), ascent: metric.ascent, descent: metric.descent };
  } : undefined;
  const lay = mtextLayoutFull(m, measure, ink);
  const lines: LineEntity[] = lay.strokes.map((st, i) => ({
    ...appearanceProperties(m),
    id: `${m.id}:s${i}`,
    layer: m.layer,
    color: st.color ?? m.color,
    ...(st.trueColor !== undefined ? { trueColor: st.trueColor } : m.trueColor !== undefined && st.color === undefined ? { trueColor: m.trueColor } : {}),
    ...(st.color !== undefined || st.trueColor !== undefined ? { trueColor: st.trueColor, colorName: undefined, colorLayer: undefined } : {}),
    type: 'line',
    a: st.a,
    b: st.b,
  }));
  const entry = { contextKey: context?.cacheKey, texts: lay.texts, lines,
    masks: mtextBackgroundPolygons(m, measure, lay, context ? (text) => textCorners(text, context) : undefined) };
  mtextCache.set(m, entry);
  return entry;
}
/** Single-line text pieces that render an MTEXT (word wrapped, format codes applied). Cached per entity. */
export function mtextParts(m: MTextEntity, context?: TextGeometryContext): TextEntity[] {
  return mtextRendered(m, context).texts;
}

export function mtextMasks(m: MTextEntity, context?: TextGeometryContext): readonly (readonly Point[])[] {
  return mtextRendered(m, context).masks;
}
/** Underline / overline / strike-through / fraction-bar strokes of a formatted MTEXT. */
export function mtextDecorations(m: MTextEntity, context?: TextGeometryContext): LineEntity[] {
  return mtextRendered(m, context).lines;
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
  if (h.solid || hasHatchGradient(h)) return [];
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
  const pat = h.solid || hasHatchGradient(h) ? { segments: [], dense: false } : patternSegments(polys, hatchPatternLines(h));
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

const leaderCache = new WeakMap<LeaderEntity, GeneratedParts>();
/** Leader line(s), arrowhead(s) and the attached MTEXT. Cached per entity. */
export function leaderParts(e: LeaderEntity, context?: TextGeometryContext): Entity[] {
  const hit = leaderCache.get(e);
  if (hit && hit.contextKey === context?.cacheKey) return hit.parts;
  const style = { layer: e.layer, color: e.color, ...appearanceProperties(e), linetype: e.linetype, lineWeight: e.lineWeight };
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
    const textStyle = e.textAppearance
      ? { layer: e.textLayer ?? e.layer, color: e.textAppearance.color ?? 'ByLayer', ...e.textAppearance, linetype: e.linetype, lineWeight: e.lineWeight }
      : style;
    out.push({
      ...textStyle,
      id: `${e.id}:t`,
      type: 'mtext',
      ...(e.textAppearance ?? {}),
      ...(e.textLayer ? { layer: e.textLayer } : {}),
      position: e.textPosition,
      text: e.text,
      ...(e.raw ? { raw: e.raw } : {}),
      height: e.textHeight,
      width: e.textWidth ?? 0,
      rotation: e.textRotation ?? 0,
      attachment: leaderTextAttachment(e),
      lineSpacing: e.textLineSpacing ?? 1,
      ...(e.textBackground ? { background: e.textBackground } : {}),
      ...(e.textColumns ? { columns: e.textColumns } : {}),
    });
  }
  leaderCache.set(e, { contextKey: context?.cacheKey, parts: out });
  return out;
}

// ------------------------------------------------------------------ table

const tableCache = new WeakMap<TableEntity, GeneratedParts>();
/** Border lines and cell MTEXTs of a table. Cached per entity. */
export function tableParts(t: TableEntity, context?: TextGeometryContext): Entity[] {
  const hit = tableCache.get(t);
  if (hit && hit.contextKey === context?.cacheKey) return hit.parts;
  const geo = tableGeometry(t);
  const style = { layer: t.layer, color: t.color, ...appearanceProperties(t), linetype: t.linetype, lineWeight: t.lineWeight };
  const out: Entity[] = geo.lines.map(([a, b], i) => ({ ...style, id: `${t.id}:b${i}`, type: 'line' as const, a, b }));
  out.push(...geo.texts);
  tableCache.set(t, { contextKey: context?.cacheKey, parts: out });
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
  const style = { layer: e.layer, color: e.color, ...appearanceProperties(e), linetype: e.linetype, lineWeight: e.lineWeight };
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
  /** A block's gradient is evaluated in definition coordinates before its insert transform. */
  gradientInBlock?: boolean;
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
      const gradientConformal = Math.abs(A.kx) === Math.abs(A.ky);
      const frame = e.gradientFrame ?? (A.gradientInBlock || !gradientConformal ? hatchGradientFrame(e) : null);
      return {
        ...e,
        loops,
        angle: normAngle(e.angle + A.rotation),
        scale: e.scale * k,
        origin: A.tf(e.origin ?? { x: 0, y: 0 }),
        // Native direct ROTATE/MIRROR/SCALE keep the gradient's world angle; block display instead
        // carries its definition-space frame through the insert transform.
        ...(frame ? { gradientFrame: transformHatchGradientFrame(frame, A.tf) } : {}),
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
        ...(e.textColumns ? { textColumns: scaledMTextColumns(e.textColumns, k) } : {}),
        textRotation: A.mirrored ? readableAngle(dirAngle(rot), rot + A.rotation) : normAngle(rot + A.rotation),
        ...(A.mirrored && att ? { textAttachment: flip(att) } : {}),
        // P18 slice 3 (PROPOSAL-P18-S3 item (3)): a native multileader's
        // additional annotative contexts transform WITH the primary — their
        // points/vectors/placements take the same tf/vec, their sizes scale
        // by k like the primary's entity-level sizes, their text rotation and
        // attachment follow the primary's rules above. The mleader-internal
        // scalars (each context's scaleFactor and landingGap) do not
        // transform — the same posture as the primary's landingGap, which
        // rides through the spread above untouched.
        ...(e.mleader?.contexts ? {
          mleader: {
            ...e.mleader,
            contexts: e.mleader.contexts.map((c) => {
              const cr = c.textRotation ?? 0;
              return {
                ...c,
                paths: c.paths.map((p) => p.map(A.tf)),
                ...(c.dogleg ? { dogleg: A.vec(c.dogleg) } : {}),
                ...(c.textPosition ? { textPosition: A.tf(c.textPosition) } : {}),
                textHeight: c.textHeight * k,
                arrowSize: c.arrowSize * k,
                ...(c.textWidth !== undefined ? { textWidth: c.textWidth * k } : {}),
                ...(c.textRotation !== undefined || A.rotation !== 0 || A.mirrored
                  ? { textRotation: A.mirrored ? readableAngle(dirAngle(cr), cr + A.rotation) : normAngle(cr + A.rotation) }
                  : {}),
                ...(A.mirrored && c.textAttachment ? { textAttachment: flip(c.textAttachment as MTextAttachment) } : {}),
                ...(c.block ? { block: { ...c.block, position: A.tf(c.block.position) } } : {}),
              };
            }),
          },
        } : {}),
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
export function explodeCompound(e: Entity, context?: TextGeometryContext): Entity[] | null {
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
      // Ordinary lines/fills cannot retain an active or inactive native gradient descriptor.
      if (e.gradient !== undefined) return null;
      const geo = hatchGeometry(e);
      const style = { layer: e.layer, color: e.color, ...appearanceProperties(e), linetype: e.linetype, lineWeight: e.lineWeight };
      if (e.solid) return geo.polys.map((points) => ({ ...style, id: newId(), type: 'polyline' as const, points, closed: true, filled: true }));
      return geo.segments.filter(([a, b]) => !g.eq(a, b, 1e-12)).map(([a, b]) => ({ ...style, id: newId(), type: 'line' as const, a, b }));
    }
    case 'leader':
      return leaderParts(e, context).map(fresh);
    case 'table':
      return tableParts(e, context).map(fresh);
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
/** MTEXT columns under a uniform scale (their width, gutter and heights scale with the text). */
function scaledMTextColumns(columns: MTextColumns, scale: number): MTextColumns {
  if (scale === 1) return columns;
  return { ...columns, width: columns.width * scale, gutter: columns.gutter * scale, heights: columns.heights.map((height) => height * scale) };
}

export function blockTransform(e: Entity, tf: (p: Point) => Point, rotation: number, sx: number, sy: number, mirror: boolean): Entity {
  const uniform = Math.abs(sx - sy) < 1e-12;
  const k = Math.sqrt(Math.abs(sx * sy));
  const vec = (v: Point): Point => g.rotate({ x: v.x * sx * (mirror ? -1 : 1), y: v.y * sy }, rotation);
  const directionAngle = (angle: number): number => { const v = vec({ x: Math.cos(angle), y: Math.sin(angle) }); return normAngle(Math.atan2(v.y, v.x)); };
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
      if (e.widthFrame || (!uniform && (e.widths || e.width))) return { ...e, points: e.points.map(tf), widthFrame: polylineWidthFrame(e, tf), bulges: undefined };
      return { ...e, points: e.points.map(tf), bulges: mirror ? e.bulges?.map((bu) => -bu) : e.bulges, width: e.width !== undefined ? e.width * k : e.width, widths: e.widths?.map((w) => ({ start: w.start * k, end: w.end * k })) };
    case 'text':
      return scaledText(e, tf, rotation, Math.abs(sx), Math.abs(sy), mirror) as TextEntity;
    case 'mtext':
      return { ...e, position: tf(e.position), height: e.height * k, width: e.width * k, rotation: e.rotation + rotation, ...(e.columns ? { columns: scaledMTextColumns(e.columns, k) } : {}) };
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
      if (e.kind === 'ordinate' && !uniform) throw new Error('Nonuniform ordinate block transforms require primitive expansion.');
      return {
        ...e,
        p1: tf(e.p1),
        p2: tf(e.p2),
        linePoint: tf(e.linePoint),
        center: e.center ? tf(e.center) : e.center,
        textPosition: e.textPosition ? tf(e.textPosition) : e.textPosition,
        rotation: e.kind === 'ordinate' ? e.rotation : e.kind === 'linear' ? ang(e.rotation) : e.rotation + rotation,
        ...(e.kind === 'ordinate' ? { ordinateRotation: directionAngle(e.ordinateRotation ?? 0),
          ...(e.textRotation !== undefined ? { textRotation: directionAngle(e.textRotation) } : {}) } : {}),
        style: e.kind === 'ordinate' || k === 1 ? e.style : { ...e.style, scale: e.style.scale * k },
        ...(e.kind !== 'ordinate' && k !== 1 && e.styleOverrides !== undefined ? { styleOverrides: { ...e.styleOverrides, DIMSCALE: e.style.scale * k } } : {}),
      };
    case 'spline':
    case 'hatch':
    case 'leader':
    case 'table':
    case 'image':
      return affineCompound(e, { tf, vec, rotation, kx: sx, ky: sy, mirrored: mirror, gradientInBlock: true });
  }
}

/**
 * At most this many objects come out of one block reference, nested references included
 * (security review E-13; JCad 3D's DXF reader has the same 2,000,000-object cap). Blocks that
 * each insert the previous one many times stay within the nesting depth while multiplying into
 * billions of objects; the expansion stops at the cap instead of exhausting memory. The nested
 * references an expansion follows are limited to the same number: a fan-out whose innermost
 * blocks are empty, missing or below the nesting depth draws nothing but would otherwise be
 * walked billions of times. Readers report such blocks (expansionReport).
 */
const workCache = new WeakMap<Entity, number>();
/** Coordinate and text work copied or rendered by each instance of an immutable entity. */
export function entityGeometryWork(entity: Entity): number {
  const immutable = isImmutableData(entity);
  const hit = immutable ? workCache.get(entity) : undefined;
  if (hit !== undefined) return hit;
  let work = 1;
  switch (entity.type) {
    case 'polyline':
      if (entity.widths || entity.widthFrame || entity.width !== undefined) { const invalid = polylineWidthProblem(entity); if (invalid) throw new GeometryBudgetError(invalid); }
      work += entity.points.length * (entity.widths ? (entity.bulges?.some((value) => Math.abs(value) > 1e-12) ? 210 : 12) : entity.bulges?.some((value) => Math.abs(value) > 1e-12) ? 32 : 1);
      if (entity.widthFrame) work += entity.widthFrame.points.length * (entity.widthFrame.bulges?.some((value) => Math.abs(value) > 1e-12) ? 210 : 12);
      break;
    case 'spline':
      work += entity.controlPoints.length + entity.knots.length + (entity.weights?.length ?? 0) + (entity.fitPoints?.length ?? 0);
      break;
    case 'hatch':
      // A loop costs the vertices loopPolygon tessellates it into: one per point, plus
      // (steps - 1) extra vertices for each bulged segment. Charging every point of a
      // loop the full 32-step arc cost when any one segment is bulged rejected
      // legitimate curved filled signatures whose arcs are only a few segments.
      for (const loop of entity.loops) {
        work += loop.points.length;
        for (const bulge of loop.bulges ?? []) if (isHatchBulge(bulge)) work += bulgeArcSteps(bulge) - 1;
      }
      for (const line of entity.patternLines ?? []) work += 1 + line.dashes.length;
      if (entity.gradient) {
        const invalid = hatchGradientDataProblem(entity.gradient);
        if (invalid) throw new GeometryBudgetError(invalid);
        work += entity.gradient.name.length + entity.gradient.colors.length * 3;
      }
      if (entity.gradientFrame) {
        const invalid = hatchGradientFrameProblem(entity.gradientFrame);
        if (invalid || !entity.gradient) throw new GeometryBudgetError(invalid ?? 'gradient hatch frame requires a native gradient descriptor');
        work += 6;
      }
      break;
    case 'leader':
      work += entity.vertices.length + (entity.text?.length ?? 0) + (entity.raw?.length ?? 0) + (entity.textColumns?.heights.length ?? 0) + (entity.mleader?.styleName.length ?? 0);
      for (const path of entity.extraPaths ?? []) work += path.length;
      break;
    case 'text':
      work += entity.text.length;
      break;
    case 'mtext':
      work += entity.text.length + (entity.raw?.length ?? 0) + (entity.columns?.heights.length ?? 0);
      break;
    case 'insert':
      for (const value of Object.values(entity.attributes)) work += value.length;
      work *= insertArrayCount(entity);
      break;
    case 'table':
      work += entity.rowHeights.length + entity.columnWidths.length + entity.rowHeights.length * entity.columnWidths.length;
      for (const row of entity.cells) for (const cell of row) work += 1 + cell.text.length + (cell.raw?.length ?? 0);
      break;
    case 'dimension':
      work += entity.text?.length ?? 0;
      break;
    case 'image':
      work += (entity.clip?.length ?? 0) + entity.path.length;
      break;
  }
  if (immutable) workCache.set(entity, work);
  return work;
}

const dependencyDepths = new WeakMap<Map<string, BlockDef | undefined>, Map<string, number>>();
/** Definitions used within rendering's depth limit, including currently missing nested blocks. */
export function collectBlockDependencies(name: string, lookup: BlockLookup, deps = new Map<string, BlockDef | undefined>()): Map<string, BlockDef | undefined> {
  const pending = [{ name, depth: 0 }];
  const depths = dependencyDepths.get(deps) ?? new Map<string, number>();
  dependencyDepths.set(deps, depths);
  let examined = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 8 || (depths.get(current.name) ?? Infinity) <= current.depth) continue;
    depths.set(current.name, current.depth);
    const block = lookup(current.name);
    deps.set(current.name, block);
    if (!block) continue;
    if (block.xref && !block.entities.length) continue; // only the fixed placeholder is rendered
    for (const attribute of block.attributes) examined += 1 + attribute.default.length;
    for (const entity of block.entities) {
      examined += entityGeometryWork(entity);
      if (examined > MAX_BLOCK_EXPANSION_WORK) throw new GeometryBudgetError('Block definitions exceed the safe geometry budget.');
      if (entity.type === 'insert') pending.push({ name: entity.block, depth: current.depth + 1 });
    }
    if (examined > MAX_BLOCK_EXPANSION_WORK) throw new GeometryBudgetError('Block definitions exceed the safe geometry budget.');
  }
  return deps;
}

export const MAX_BLOCK_EXPANSION_WORK = MAX_INSERT_ARRAY_INSTANCES;

export const MAX_INSERT_EXPANSION = 2_000_000;
/** Nesting levels drawn below a reference (deeper references are not expanded). */
const MAX_INSERT_DEPTH = 8;

/** One expansion: objects it may still produce, the chain of blocks being expanded. */
interface ExpansionBudget {
  remaining: number;
  left: number;
  /** References it may still follow (the top one included). */
  visits: number;
  readonly chain: string[];
  /** Every block name looked up within the depth limit and the definition it had (undefined: missing). */
  readonly deps: Map<string, BlockDef | undefined>;
  /** Stopped at MAX_INSERT_EXPANSION objects or followed references. */
  truncated: boolean;
  /** A block inserts itself (directly or through others): the repeated reference was skipped. */
  cyclic: boolean;
  /** Primitive annotation positions were measured in the current font/style context. */
  contextGeometry: boolean;
  /** Optional plot-only resolver of an insertion's unplotted physical lineweight. */
  readonly resolveLineweight?: (entity: EntityBase) => number;
}
const newBudget = (maxObjects = MAX_INSERT_EXPANSION, resolveLineweight?: (entity: EntityBase) => number): ExpansionBudget => ({ remaining: MAX_BLOCK_EXPANSION_WORK, left: maxObjects, visits: maxObjects, chain: [], deps: new Map(), truncated: false, cyclic: false, contextGeometry: false, resolveLineweight });

function spendExpansion(budget: ExpansionBudget, work = 1): void {
  budget.remaining -= work;
  if (budget.remaining < 0) throw new GeometryBudgetError('Block expansion exceeds the safe geometry budget.');
}

interface InsertCache {
  block: BlockDef;
  readonly contextKey?: object;
  /**
   * The definitions the expansion used, nested ones included (and names that were missing): the
   * entry is stale as soon as one of them resolves differently (a nested block redefined, removed,
   * added or restored by undo).
   */
  deps: ReadonlyMap<string, BlockDef | undefined>;
  exploded: Entity[];
  bounds: Bounds | null;
  /** The expansion was cut short (the cap, or a block that inserts itself). */
  limited: boolean;
  readonly contextGeometry: boolean;
}
/** Only accepted immutable inserts and definitions qualify for identity caching. */
const insertCache = new WeakMap<InsertEntity, InsertCache>();

/**
 * Priority 30.1: the block definition ONE expansion of `ins` must use. When the
 * insert carries dynamic values AND its block carries a dynamic definition, the
 * definition is evaluated FIRST, in definition space, and the evaluated entities
 * plus evaluated attribute placements form a derived BlockDef used for this
 * expansion only. The derived definition is never stored back into document
 * state; attribute VALUES always come from the insert, unchanged. The stored
 * block object is returned by identity whenever there is nothing to evaluate,
 * so static inserts (no dynamic fields on either side) take the exact
 * pre-30.1 path.
 *
 * Evaluation refusal (unsupported member, dependency cycle, limits, invalid
 * stored values, a block-mismatched instance state, or a retained/unreadable
 * payload on either side) falls back to the authored base geometry.
 * Diagnostic gap: the expansion path has no per-expansion diagnostic channel
 * (ExpansionBudget carries only the truncated/cyclic flags, and
 * expansionReport is a separate static analysis), so a refusal here cannot be
 * surfaced in-band; the same states are refused explicitly, with codes, by
 * evaluateDynamicBlock and by core/parametric/apply.ts on the edit path.
 *
 * Exported for the two other consumers that must agree with expansion about
 * the evaluated definition (review R07): the DXF writer, which writes ATTRIB
 * positions from the evaluated definition, and the DXF reader, which rebases
 * imported attribute placements against it.
 */
/**
 * The per-attribute transforms evaluation recorded for one DERIVED
 * definition, keyed by the derived BlockDef object itself (round 4,
 * R3-01). expansionBlock is the single producer of evaluated
 * definitions for expansion, the DXF writer and the DXF reader, and
 * every consumer composes placements against the exact object it
 * returned, so identity keying is exact and the record never becomes
 * document state: it is not serialized, cloned, or compared, and it
 * dies with the derived definition. Presence of an entry — even an
 * empty map — is the provenance marker: the definition came from an
 * evaluation whose recorded transforms are complete for it, so an
 * attribute with no entry was not moved by that evaluation.
 */
const evaluatedAttributeTransforms = new WeakMap<BlockDef, ReadonlyMap<string, AttributeTransform>>();

export function expansionBlock(block: BlockDef, ins: InsertEntity): BlockDef {
  const definition = block.dynamic;
  const instance = ins.dynamic;
  if (!definition || !instance) return block;
  if (block.dynamicRetained !== undefined || ins.dynamicRetained !== undefined) return block;
  if (instance.block !== block.name) return block;
  const result = evaluateDynamicBlock(definition, block.entities, block.attributes, instance);
  if (!result.ok) return block;
  const unchanged =
    result.entities.length === block.entities.length &&
    result.entities.every((e, i) => e === block.entities[i]) &&
    result.attributes.length === block.attributes.length &&
    result.attributes.every((a, i) => a === block.attributes[i]);
  if (unchanged) return block;
  const derived: BlockDef = { ...block, entities: result.entities, attributes: result.attributes };
  evaluatedAttributeTransforms.set(
    derived,
    new Map([...result.attributeTransforms].map(([tag, tx]) => [tag, recordedAttributeTransform(tx)] as const)),
  );
  return derived;
}

// ---------------------------------------------------------------------------
// Attribute placement overrides vs dynamic evaluation (review R07)
// ---------------------------------------------------------------------------

type AttributePlacement = TextPlacement & AttributeAppearance & { readonly style?: string };

/** A 2D linear map: x' = a*x + b*y, y' = c*x + d*y. */
interface LinearMap { readonly a: number; readonly b: number; readonly c: number; readonly d: number }

const IDENTITY_MAP: LinearMap = { a: 1, b: 0, c: 0, d: 1 };

/**
 * The transform evaluation applied to one attribute: everything needed
 * to re-express a placement written against one definition against the
 * other, as an ANCHORED affine map (anchor q -> image + linear·(q −
 * anchor)) plus the scalar parts (height ratio, rotation delta). The
 * anchored form never forms the absolute offset (the image of the
 * origin), which overflows for representable transforms whose fixed
 * point is huge — a rotation by π about (1e308, 0) has absolute offset
 * 2·1e308 (round 5, R4-01).
 *
 * PROVENANCE (round 4, R3-01): the primary source is the transform the
 * evaluation RECORDED while its action pipeline ran
 * (EvaluationResult.attributeTransforms), attached by expansionBlock to
 * the derived definition it produced — see evaluatedAttributeTransforms
 * below. The record is authoritative and complete for that definition:
 * an attribute with no record was not moved. It replaces the round-3
 * snapshot inference as the primary mechanism because inference from
 * before/after definitions is unsound for flip: a reflection and the
 * identity can fix the same anchors (an axis through every anchor of
 * the attribute — left, right, center and FIT placements alike), so
 * identical authored/effective fields cannot prove "nothing moved",
 * and no correspondence solve can recover an axis the snapshots do not
 * show. Snapshot inference (attributeTransformBetween) survives ONLY
 * as a fallback for definitions that carry no record, and only when no
 * flip can be active for the attribute; when a flip may be active and
 * no record exists, composition refuses explicitly (see
 * attributePlacementsForDef / importedPlacementsToAuthoredFrame)
 * rather than report success with wrong geometry.
 */
interface AttributeTransform {
  readonly linear: LinearMap;
  readonly anchor: Point;
  readonly image: Point;
  readonly heightRatio: number;
  readonly rotationDelta: number;
}

/** A recorded evaluation transform in this module's transform shape. */
function recordedAttributeTransform(tx: AttributeActionTransform): AttributeTransform {
  return {
    linear: { a: tx.a, b: tx.b, c: tx.c, d: tx.d },
    anchor: { x: tx.ax, y: tx.ay },
    image: { x: tx.ix, y: tx.iy },
    heightRatio: tx.heightRatio,
    rotationDelta: tx.rotationDelta,
  };
}

/** The exact inverse of a transform, or null when its linear part is
 *  singular or its inverse is not representable in doubles (composed
 *  evaluation transforms are products of translations, rotations,
 *  positive scales and reflections, so a singular record means the
 *  transform did not come from an evaluation this build performed).
 *  The determinant is computed on the magnitude-NORMALIZED linear
 *  part and the adjugate divided by it before the scale is divided
 *  out (round 5, R4-01): the raw determinant of a representable
 *  transform such as a 1e160 scale composed with a flip is −(1e160)²,
 *  which overflows a double even though every entry of the inverse is
 *  representable, and treating that overflow as singularity made the
 *  reader refuse JCad's own written output. The inverse is anchored
 *  at the forward transform's image (whose own image is the forward
 *  anchor), so no absolute offset is formed on this side either. */
function invertAttributeTransform(t: AttributeTransform): AttributeTransform | null {
  const { a, b, c, d } = t.linear;
  const s = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (s === 0 || !Number.isFinite(s)) return null;
  const na = a / s;
  const nb = b / s;
  const nc = c / s;
  const nd = d / s;
  const detN = na * nd - nb * nc;
  if (detN === 0 || !Number.isFinite(detN)) return null;
  // L⁻¹ = adj(L)/det(L) = adj(normalized L) / (det(normalized L) · s).
  const ia = nd / detN / s;
  const ib = -nb / detN / s;
  const ic = -nc / detN / s;
  const id = na / detN / s;
  const heightRatio = 1 / t.heightRatio;
  if (![ia, ib, ic, id, heightRatio].every(Number.isFinite)) return null;
  return {
    linear: { a: ia, b: ib, c: ic, d: id },
    anchor: { x: t.image.x, y: t.image.y },
    image: { x: t.anchor.x, y: t.anchor.y },
    heightRatio,
    rotationDelta: -t.rotationDelta,
  };
}

/**
 * Can a flip action of the authored definition be contributing its
 * reflection to the transform of `tag` at the instance's current state?
 * The action applies its reflection iff its parameter's effective value
 * differs from the parameter default (the pipeline's own rule); a
 * missing value means the default state, and an unreadable (opaque)
 * value — or a selection whose driving parameter cannot be resolved —
 * is treated as "may be active", because it cannot be ruled out.
 */
function flipTransformPossible(authored: BlockDef, ins: InsertEntity, tag: string): boolean {
  const definition = authored.dynamic;
  if (!definition) return false;
  for (const action of definition.actions) {
    if (action.kind !== 'flip') continue;
    if (!action.selection.some((s) => s.entityId === tag)) continue;
    const param = definition.parameters.find((p) => p.id === action.parameterId);
    if (!param || param.kind !== 'flip') return true;
    const value = ins.dynamic?.values[action.parameterId];
    if (value === undefined) continue; // default state: the reflection is not applied
    if (value.kind !== 'flip') return true; // unreadable value: cannot rule the flip out
    if (value.value !== param.defaultValue) return true;
  }
  return false;
}

interface AnchorCorr { readonly ux: number; readonly uy: number; readonly vx: number; readonly vy: number }

const wrapAngleDelta = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

/** The reflection (scaled) taking u to v: reflection across the angle
 *  bisector of the two vectors; when v = -u the axis is perpendicular. */
function reflectionMap(c: AnchorCorr): LinearMap {
  const su = Math.hypot(c.ux, c.uy);
  const sv = Math.hypot(c.vx, c.vy);
  const ux = c.ux / su;
  const uy = c.uy / su;
  const vx = c.vx / sv;
  const vy = c.vy / sv;
  let tx = ux + vx;
  let ty = uy + vy;
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) {
    tx = -uy;
    ty = ux;
  } else {
    tx /= tl;
    ty /= tl;
  }
  const s = sv / su;
  return { a: s * (2 * tx * tx - 1), b: s * (2 * tx * ty), c: s * (2 * tx * ty), d: s * (2 * ty * ty - 1) };
}

/** The linear map taking both correspondences' u to their v, or null
 *  when the two u vectors are (near-)dependent. */
function solveLinearMap(c1: AnchorCorr, c2: AnchorCorr): LinearMap | null {
  const det = c1.ux * c2.uy - c2.ux * c1.uy;
  if (Math.abs(det) <= 1e-12 * Math.hypot(c1.ux, c1.uy) * Math.hypot(c2.ux, c2.uy)) return null;
  return {
    a: (c1.vx * c2.uy - c2.vx * c1.uy) / det,
    b: (-c1.vx * c2.ux + c2.vx * c1.ux) / det,
    c: (c1.vy * c2.uy - c2.vy * c1.uy) / det,
    d: (-c1.vy * c2.ux + c2.vy * c1.ux) / det,
  };
}

/** The transform from attribute definition `a0` to `a1` INFERRED from
 *  the two snapshots, or null when the snapshots are field-identical.
 *  Swapping the arguments yields the inverse transform (the ladder is
 *  symmetric: ratios invert, deltas negate, a reflection is its own
 *  inverse). FALLBACK ONLY (round 4, R3-01): callers consult this when
 *  the definition carries no recorded evaluation transform, and never
 *  when a flip may be active for the attribute — identical snapshots
 *  cannot distinguish a flip whose axis fixes every anchor from the
 *  identity, so in that case this function's null is not evidence that
 *  nothing moved. For orientation-preserving motions (the stretch /
 *  move / rotate / scale pipelines) the inference is exact: the scalar
 *  parts are read off the definition directly (height ratio, rotation
 *  delta), and the definition's own anchor correspondences confirm the
 *  matching similarity. */
function attributeTransformBetween(a0: AttributeDef, a1: AttributeDef): AttributeTransform | null {
  if (a0 === a1) return null;
  const samePoint = (u?: Point, v?: Point) =>
    (u === undefined && v === undefined) || (u !== undefined && v !== undefined && u.x === v.x && u.y === v.y);
  if (
    samePoint(a0.position, a1.position) &&
    samePoint(a0.alignmentPoint, a1.alignmentPoint) &&
    samePoint(a0.firstAlignmentPoint, a1.firstAlignmentPoint) &&
    a0.height === a1.height &&
    (a0.rotation ?? 0) === (a1.rotation ?? 0)
  ) return null;

  const heightRatio = a0.height > 0 && a1.height > 0 ? a1.height / a0.height : 1;
  const rotationDelta = (a1.rotation ?? 0) - (a0.rotation ?? 0);

  const corrs: AnchorCorr[] = [];
  for (const key of ['alignmentPoint', 'firstAlignmentPoint'] as const) {
    const p0 = a0[key];
    const p1 = a1[key];
    if (!p0 || !p1) continue;
    const ux = p0.x - a0.position.x;
    const uy = p0.y - a0.position.y;
    if (ux === 0 && uy === 0) continue;
    corrs.push({ ux, uy, vx: p1.x - a1.position.x, vy: p1.y - a1.position.y });
  }
  const corrScale = (c: AnchorCorr) => Math.hypot(c.vx, c.vy) / Math.hypot(c.ux, c.uy);
  const corrAngle = (c: AnchorCorr) => Math.atan2(c.ux * c.vy - c.uy * c.vx, c.ux * c.vx + c.uy * c.vy);
  const consistentWithFields = (c: AnchorCorr) =>
    Math.abs(corrScale(c) - heightRatio) <= 1e-6 * Math.max(1, heightRatio) &&
    Math.abs(wrapAngleDelta(corrAngle(c) - rotationDelta)) <= 1e-6;

  const cos = Math.cos(rotationDelta);
  const sin = Math.sin(rotationDelta);
  const fromFields: LinearMap = {
    a: heightRatio * cos,
    b: -heightRatio * sin,
    c: heightRatio * sin,
    d: heightRatio * cos,
  };

  let linear = fromFields;
  if (heightRatio === 1 && rotationDelta === 0) {
    // Scalar-neutral motion: a translation (identity linear part) or a
    // flip. Only an anchor correspondence that actually moved can be a
    // flip; translation noise between the correspondences is float dust.
    const moved = corrs.find((c) => Math.hypot(c.vx - c.ux, c.vy - c.uy) > 1e-9 * Math.max(1, Math.hypot(c.ux, c.uy)));
    linear = moved ? reflectionMap(moved) : IDENTITY_MAP;
  } else if (corrs.length >= 2 && !corrs.every(consistentWithFields)) {
    linear = solveLinearMap(corrs[0]!, corrs[1]!) ?? fromFields;
  }
  // The anchored form: the map must send a0's position anchor to a1's,
  // so the anchor is a0's position and its image is a1's — the absolute
  // offset (a1.position − L·a0.position) is never formed; it overflows
  // for huge-centre motions whose endpoints stay finite (round 5, R4-01).
  return {
    linear,
    anchor: { x: a0.position.x, y: a0.position.y },
    image: { x: a1.position.x, y: a1.position.y },
    heightRatio,
    rotationDelta,
  };
}

/**
 * Exact binary exponent decomposition: returns [m, e] with value =
 * m · 2^e and m in [0.5, 1) (m = value and e = 0 for zero and for
 * non-finite inputs, which callers treat as an unrepresentable term).
 * JavaScript has no Math.frexp; the exponent bits are read through a
 * DataView. Scaling by a power of two is exact, so decomposition never
 * rounds. Subnormals are first scaled up by 2^64 (exact) into the
 * normal range. (The same helper exists in parametric/evaluate.ts for
 * the evaluator's own anchored application; the two modules cannot
 * share it without an import cycle.)
 */
const frexpView = new DataView(new ArrayBuffer(8));
function frexpPair(value: number): readonly [number, number] {
  if (value === 0 || !Number.isFinite(value)) return [value, 0];
  frexpView.setFloat64(0, value);
  const hi = frexpView.getUint32(0);
  const expBits = (hi >>> 20) & 0x7ff;
  if (expBits === 0) {
    const [m, e] = frexpPair(value * 2 ** 64);
    return [m, e - 64];
  }
  frexpView.setUint32(0, (hi & 0x800fffff) | (1022 << 20));
  return [frexpView.getFloat64(0), expBits - 1022];
}

/**
 * One component of an anchored affine application, image + a·(qx − ax)
 * + b·(qy − ay), computed in power-of-two scaled space (round 7,
 * R6-01). The plain expression can overflow BEFORE its terms cancel —
 * the product a·qx when the point sits far from the anchor, the
 * subtraction qx − ax when the two are large with opposite signs, or
 * the partial sum image + a·dx before + b·dy can cancel it — even when
 * every field of the transform is finite and the true result is
 * finite. This form splits the subtractions into separate product
 * terms (a·qx, −a·ax, b·qy, −b·ay) beside the image, decomposes every
 * factor exactly, and sums the mantissas at a common exponent, so no
 * intermediate ever leaves the finite range unless the TRUE result
 * does. Its only rounding is the mantissa products and the aligned sum
 * themselves (measured within ~2 ulp of the evaluator's stepwise
 * result on the admitted large-finite class). Returns a non-finite
 * value only when the true component is out of range (or an input was
 * already non-finite); the caller turns that into an explicit refusal.
 */
function scaledTransformComponent(
  image: number, a: number, qx: number, ax: number, b: number, qy: number, ay: number,
): number {
  const terms: Array<readonly [number, number]> = [];
  const pushValue = (v: number): void => {
    const [m, e] = frexpPair(v);
    if (m !== 0) terms.push([m, e]);
  };
  const pushProduct = (u: number, v: number, sign: 1 | -1): void => {
    const [mu, eu] = frexpPair(u);
    const [mv, ev] = frexpPair(v);
    const m = sign * mu * mv;
    if (m !== 0) terms.push([m, eu + ev]);
  };
  pushValue(image);
  pushProduct(a, qx, 1);
  pushProduct(a, ax, -1);
  pushProduct(b, qy, 1);
  pushProduct(b, ay, -1);
  if (terms.length === 0) return 0;
  if (terms.some(([m]) => !Number.isFinite(m))) return NaN;
  let eMax = terms[0]![1];
  for (const [, e] of terms) if (e > eMax) eMax = e;
  let sum = 0;
  for (const [m, e] of terms) sum += m * Math.pow(2, e - eMax);
  if (sum === 0) return 0;
  // Renormalize before scaling back so the back-scaling overflows only
  // when the true result does (a sum near 1 at exponent 1024 must not
  // be multiplied by an already-overflowing power of two).
  const [sm, se] = frexpPair(sum);
  const e = eMax + se;
  const e1 = Math.trunc(e / 2);
  return sm * Math.pow(2, e1) * Math.pow(2, e - e1);
}

/**
 * One component of the anchored application, GATED (round 7, R6-01):
 * the plain expression is returned untouched whenever it is finite —
 * bit-identical for every ordinary value and every previously passing
 * case — and only a non-finite plain result is recomputed in scaled
 * space. A component whose scaled result is still non-finite is
 * genuinely out of range; it is returned as-is and transformPlacement
 * refuses explicitly rather than let Infinity/NaN escape as geometry.
 */
function transformComponent(
  image: number, a: number, qx: number, ax: number, b: number, qy: number, ay: number,
): number {
  const naive = image + a * (qx - ax) + b * (qy - ay);
  if (Number.isFinite(naive)) return naive;
  return scaledTransformComponent(image, a, qx, ax, b, qy, ay);
}

/** The explicit refusal raised when a placement's true image under a
 *  recorded (or inferred) transform lies outside the finite range:
 *  raised before any non-finite placement is produced, stored or
 *  written, in the same spirit as the flip/no-record refusals of the
 *  two callers below. */
function nonFinitePlacementError(tag: string, what: string): Error {
  return new Error(
    `Refusing to apply the recorded transform for attribute '${tag}': the ${what} it produces is non-finite — the true placement lies outside the finite range a double can represent.`,
  );
}

/**
 * Re-express placement `p`, written against attribute definition `a0`,
 * against `a1` under transform `t`: anchors ride the transform's
 * anchored affine map (its linear part applied to the vector from the
 * transform's anchor, landed on the anchor's image — the anchor is
 * exactly the point that sends a0's frame to a1's), height composes
 * by the transform's height ratio, and rotation by its delta — so a
 * placement that restates `a0` lands exactly on `a1`, a genuine offset
 * from the authored placement rides the FULL transform (scale,
 * rotation and reflection included, review rounds 3 and 4), and
 * fields evaluation never transforms (appearance, width factor,
 * oblique, justification, style) carry through untouched.
 */
function transformPlacement(p: AttributePlacement, a0: AttributeDef, a1: AttributeDef, t: AttributeTransform): AttributePlacement {
  // The ONE point-application expression for recorded and inferred
  // transforms (round 7, R6-01): each component goes through the gated
  // transformComponent — plain arithmetic when it stays finite (the
  // historical behaviour, bit for bit), exponent-scaled recomputation
  // when the plain form overflows before cancellation — and a
  // component that is still non-finite in scaled space means the true
  // point is out of range, which refuses explicitly here, before any
  // placement carrying Infinity/NaN can be returned, stored or written.
  const map = (q: Point): Point => {
    const x = transformComponent(t.image.x, t.linear.a, q.x, t.anchor.x, t.linear.b, q.y, t.anchor.y);
    const y = transformComponent(t.image.y, t.linear.c, q.x, t.anchor.x, t.linear.d, q.y, t.anchor.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw nonFinitePlacementError(a0.tag, 'anchor point');
    return { x, y };
  };
  const height = a0.height > 0 ? p.height * t.heightRatio : p.height + (a1.height - a0.height);
  // The scalar side has no cancellation to rescue: an overflowing
  // height product is a genuinely out-of-range height. It is checked
  // explicitly (round 7, R6-01) instead of escaping as Infinity.
  if (!Number.isFinite(height)) throw nonFinitePlacementError(a0.tag, 'height');
  const rotation = p.rotation === undefined && a0.rotation === undefined && a1.rotation === undefined
    ? undefined
    : (a1.rotation ?? 0) + ((p.rotation ?? 0) - (a0.rotation ?? 0));
  return {
    ...p,
    position: map(p.position),
    ...(p.alignmentPoint ? { alignmentPoint: map(p.alignmentPoint) } : {}),
    ...(p.firstAlignmentPoint ? { firstAlignmentPoint: map(p.firstAlignmentPoint) } : {}),
    height,
    ...(rotation === undefined ? {} : { rotation }),
  };
}

/**
 * The insert as attributeText must see it when placements are consumed
 * against `effective` (a definition derived from `authored` by evaluation):
 * each stored placement — authored-frame by definition (see the field
 * comment) — is composed with the evaluation's full transform of its
 * attribute, so a genuine per-instance override rides the evaluated
 * transform instead of pinning the attribute against it. Returns `ins`
 * itself when nothing moves (the static path is untouched, by identity).
 *
 * The transform comes from the evaluation's own record for `effective`
 * (see evaluatedAttributeTransforms): authoritative, and the only sound
 * source when a flip is involved. A definition WITHOUT a record (one
 * not produced by expansionBlock) falls back to snapshot inference —
 * sound for the orientation-preserving action pipelines — UNLESS a
 * flip may be active for the attribute at the instance's state: then
 * the snapshots cannot prove what the transform was, and this function
 * throws rather than compose a placement it cannot verify. That throw
 * is the explicit, atomic refusal for the composition: no placement is
 * produced at all, instead of a successful-looking wrong one. Every
 * in-repo caller passes expansionBlock's own output, so the refusal is
 * reachable only for foreign definitions a caller derived elsewhere
 * while a flip state was live.
 */
export function attributePlacementsForDef(ins: InsertEntity, authored: BlockDef, effective: BlockDef): InsertEntity {
  if (effective === authored || !ins.attributePlacements) return ins;
  const recorded = evaluatedAttributeTransforms.get(effective);
  let changed = false;
  const out: Record<string, AttributePlacement> = {};
  for (const [tag, p] of Object.entries(ins.attributePlacements)) {
    const a0 = authored.attributes.find((a) => a.tag === tag);
    const a1 = effective.attributes.find((a) => a.tag === tag);
    let t: AttributeTransform | null = null;
    if (recorded) {
      // Authoritative and complete for this definition: no entry means
      // the evaluation did not move this attribute.
      t = recorded.get(tag) ?? null;
    } else if (a0 && a1) {
      if (flipTransformPossible(authored, ins, tag)) {
        throw new Error(
          `Refusing to compose the placement override for attribute '${tag}': a flip action of block '${authored.name}' may be active at this instance's state, but the definition was not produced by an evaluation whose actual transform is recorded, and a flip cannot be recovered from before/after attribute snapshots.`,
        );
      }
      t = attributeTransformBetween(a0, a1);
    }
    if (t && a0 && a1) {
      out[tag] = transformPlacement(p, a0, a1, t);
      changed = true;
    } else {
      out[tag] = p;
    }
  }
  return changed ? { ...ins, attributePlacements: out } : ins;
}

/** Placement comparison tolerance for the reader's restatement check:
 *  far above the DXF writer's 10-decimal formatting noise, far below any
 *  deliberate user offset. */
const PLACEMENT_EPS = 1e-7;

function placementRestatesEvaluated(p: AttributePlacement, ins: InsertEntity, a: AttributeDef): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= PLACEMENT_EPS;
  const pointNear = (u?: Point, v?: Point) =>
    (u === undefined && v === undefined) || (u !== undefined && v !== undefined && near(u.x, v.x) && near(u.y, v.y));
  if (!pointNear(p.position, a.position) || !pointNear(p.alignmentPoint, a.alignmentPoint) || !pointNear(p.firstAlignmentPoint, a.firstAlignmentPoint)) return false;
  if (!near(p.height, a.height) || !near(p.rotation ?? 0, a.rotation ?? 0)) return false;
  if (!near(p.widthFactor ?? 1, a.widthFactor ?? 1) || !near(p.oblique ?? 0, a.oblique ?? 0)) return false;
  if (p.align !== a.align) return false;
  if ((p.justification?.horizontal ?? -1) !== (a.justification?.horizontal ?? -1)) return false;
  if ((p.justification?.vertical ?? -1) !== (a.justification?.vertical ?? -1)) return false;
  // Appearance: a restatement matches the definition, or carries exactly the
  // value attributeText would derive from the definition (e.g. an ATTRIB on
  // the conventional attribute layer, or ByLayer colour) — anything else is
  // a deliberate per-instance difference and keeps the override.
  if (p.layer !== a.layer && p.layer !== undefined && !(a.layer === undefined && p.layer === attributeLayer(a.tag, ins.layer))) return false;
  if (p.color !== a.color && !(a.color === undefined && (p.color === undefined || p.color === 'ByLayer'))) return false;
  if (p.trueColor !== a.trueColor || p.colorName !== a.colorName || p.transparency !== a.transparency) return false;
  if (p.style !== a.style) return false;
  return true;
}

/**
 * Rebase placements read from a file (where an ATTRIB's fields record the
 * attribute's placement at the SAVED parameter state — the evaluated
 * placement, plus any genuine user difference) into the stored authored
 * frame: a placement that merely restates the evaluated definition is
 * DROPPED (evaluation reproduces it now and after any later edit), and a
 * placement carrying a genuine difference is mapped back by the INVERSE
 * of the saved-state transform (anchors, height and rotation — not just
 * position: a height recorded at a scaled state is the evaluated height,
 * and storing it unrebased would freeze that scale into the authored
 * frame), so attributePlacementsForDef can ride it on future
 * evaluations. The inverse is the exact inverse of the transform the
 * saved-state evaluation RECORDED (round 4, R3-01) — the only sound
 * source when a flip is involved, since a flip whose axis fixes every
 * anchor leaves the evaluated definition field-identical to the
 * authored one and no snapshot comparison can detect it. Snapshot
 * inference remains as the fallback for a definition without a usable
 * record, and only when no flip may be active at the saved state;
 * otherwise the rebase throws rather than store a placement in the
 * wrong frame. Without a modeled definition + instance state there is
 * nothing to rebase against and the placements pass through unchanged
 * (the static behaviour).
 * Attributes the saved state hid have no evaluated counterpart; their
 * placements are kept as read (documented boundary: rebasing them would
 * require the pre-visibility evaluation).
 */
export function importedPlacementsToAuthoredFrame(
  ins: InsertEntity,
  block: BlockDef,
  placements: Readonly<Record<string, AttributePlacement>>,
): Readonly<Record<string, AttributePlacement>> {
  if (!ins.dynamic || ins.dynamicRetained !== undefined) return placements;
  if (!block.dynamic || block.dynamicRetained !== undefined) return placements;
  const evaluated = expansionBlock(block, ins);
  if (evaluated === block) return placements;
  const recorded = evaluatedAttributeTransforms.get(evaluated);
  let out: Record<string, AttributePlacement> | null = null;
  for (const [tag, p] of Object.entries(placements)) {
    const a1 = evaluated.attributes.find((a) => a.tag === tag);
    const a0 = block.attributes.find((a) => a.tag === tag);
    if (!a1 || !a0) continue;
    if (placementRestatesEvaluated(p, ins, a1)) {
      out ??= { ...placements };
      delete out[tag];
      continue;
    }
    const forward = recorded?.get(tag);
    if (recorded && !forward) {
      // The saved-state evaluation did not move this attribute, so the
      // placement as read is already in the authored frame.
      continue;
    }
    let inverse = forward ? invertAttributeTransform(forward) : null;
    if (!inverse) {
      // No usable record: snapshot inference, unless a flip may be
      // active at the saved state — then refuse explicitly rather than
      // store a placement in the wrong frame (round 4, R3-01).
      if (flipTransformPossible(block, ins, tag)) {
        throw new Error(
          `Refusing to rebase the imported placement for attribute '${tag}': a flip action of block '${block.name}' may be active at the saved state, but no recorded evaluation transform is available to invert, and a flip cannot be recovered from before/after attribute snapshots.`,
        );
      }
      inverse = attributeTransformBetween(a1, a0);
    }
    if (inverse) {
      out ??= { ...placements };
      out[tag] = transformPlacement(p, a1, a0, inverse);
    }
  }
  return out ?? placements;
}

function cachedInsert(ins: InsertEntity, lookup: BlockLookup): InsertCache | null {
  const block = lookup(ins.block);
  if (!block) return null;
  const immutable = isImmutableData(ins);
  const hit = immutable ? insertCache.get(ins) : undefined;
  if (hit && hit.block === block && depsCurrent(hit.deps, lookup)) {
    if (hit.contextKey === lookup.textGeometry?.cacheKey) return hit;
    if (!hit.contextGeometry) {
      // Retained source entities only need new bounds; flattened annotations also need
      // their measured text/leader positions rebuilt with the new context below.
      let bounds: Bounds | null = null;
      for (const sub of hit.exploded) bounds = g.unionBounds(bounds, entityBounds(sub, lookup));
      const refreshed = { ...hit, contextKey: lookup.textGeometry?.cacheKey, bounds: bounds ?? g.boundsOfPoints([ins.position]) };
      insertCache.set(ins, refreshed);
      return refreshed;
    }
  }
  const budget = newBudget();
  const exploded: Entity[] = [];
  explodeInto(exploded, ins, lookup, 0, budget);
  let bounds: Bounds | null = null;
  for (const sub of exploded) bounds = g.unionBounds(bounds, entityBounds(sub, lookup));
  const entry = { block, contextKey: lookup.textGeometry?.cacheKey, deps: budget.deps, exploded, bounds: bounds ?? g.boundsOfPoints([ins.position]), limited: budget.truncated || budget.cyclic, contextGeometry: budget.contextGeometry };
  if (immutable && [...budget.deps.values()].every((definition) => !definition || isImmutableData(definition))) insertCache.set(ins, entry);
  return entry;
}

/** Does every recorded block name still resolve to the same definition? */
function depsCurrent(deps: ReadonlyMap<string, BlockDef | undefined>, lookup: BlockLookup): boolean {
  for (const [name, def] of deps) if (lookup(name) !== def) return false;
  return true;
}

/**
 * The block definitions one reference depends on (the ones its expansion used, nested blocks and
 * missing names included), for caches keyed on them (core/spatial-index.ts).
 */
export function insertDependencies(ins: InsertEntity, lookup: BlockLookup): ReadonlyMap<string, BlockDef | undefined> {
  return cachedInsert(ins, lookup)?.deps ?? new Map([[ins.block, undefined]]);
}

/**
 * Expand an insert into world-space entities (recursively, at most MAX_INSERT_EXPANSION objects;
 * a block that inserts itself is expanded once). Cached per insert.
 */
export function explodeInsert(ins: InsertEntity, lookup: BlockLookup, depth = 0): Entity[] {
  if (depth === 0) return cachedInsert(ins, lookup)?.exploded ?? [];
  const out: Entity[] = [];
  explodeInto(out, ins, lookup, depth, newBudget());
  return out;
}

/**
 * Expand an insert (uncached) into at most `maxObjects` objects and tell whether it was cut short
 * (`truncated`: the limit; `cyclic`: a block inserts itself, its repeated reference skipped).
 * A plot may supply a source-width resolver to retain nested ByBlock physical widths without
 * changing the default expansion or its public caches. Plot table overrides happen afterwards.
 */
export function expandInsert(ins: InsertEntity, lookup: BlockLookup, maxObjects = MAX_INSERT_EXPANSION, resolveLineweight?: (entity: EntityBase) => number): { entities: Entity[]; truncated: boolean; cyclic: boolean } {
  const budget = newBudget(maxObjects, resolveLineweight);
  const entities: Entity[] = [];
  explodeInto(entities, ins, lookup, 0, budget);
  return { entities, truncated: budget.truncated, cyclic: budget.cyclic };
}

/**
 * Was the expansion of this reference cut short: more than MAX_INSERT_EXPANSION objects, or a
 * block that inserts itself? EXPLODE refuses such a reference (it would lose content).
 */
export function insertExpansionLimited(ins: InsertEntity, lookup: BlockLookup): boolean {
  return cachedInsert(ins, lookup)?.limited ?? false;
}

/** Why a dynamic insert's current state cannot be established (EXPLODE probe, 30.4). */
export interface InsertEvaluationRefusal {
  readonly code: string;
  readonly message: string;
  /** The reference whose state cannot be established: the probed insert itself
   *  for a top-level refusal, the nested reference for a nested one (R10). */
  readonly insertId?: string;
  /** The block that reference points at. */
  readonly block?: string;
}

/** The refusal of ONE reference against its own block (no nesting), or null. */
function ownEvaluationRefusal(ins: InsertEntity, block: BlockDef): InsertEvaluationRefusal | null {
  const definition = block.dynamic;
  const instance = ins.dynamic;
  const who = { insertId: ins.id, block: ins.block };
  if (!definition && !instance && block.dynamicRetained === undefined && ins.dynamicRetained === undefined) return null;
  if (block.dynamicRetained !== undefined) {
    return { code: 'definition-retained', ...who, message: `Block "${block.name}" has a dynamic definition this build cannot model; it is retained as data and has no evaluated state.` };
  }
  if (ins.dynamicRetained !== undefined) {
    return { code: 'instance-retained', ...who, message: `Block reference "${ins.id}" carries dynamic values this build cannot model; they are retained as data and have no evaluated state.` };
  }
  if (!definition) {
    return { code: 'no-dynamic-definition', ...who, message: `Block reference "${ins.id}" carries dynamic values but block "${block.name}" has no dynamic definition to evaluate them against.` };
  }
  if (!instance) return null;
  if (instance.block !== block.name) {
    return { code: 'block-mismatch', ...who, message: `Block reference "${ins.id}" carries dynamic values for block "${instance.block}", not "${block.name}".` };
  }
  const result = evaluateDynamicBlock(definition, block.entities, block.attributes, instance);
  return result.ok ? null : { code: result.refusal.code, ...who, message: result.refusal.message };
}

/**
 * Priority 30.4 (design §1.4(d)) — the evaluation-status probe beside
 * insertExpansionLimited. Expansion itself falls back to authored geometry
 * SILENTLY when evaluation refuses (see expansionBlock); a destructive
 * consumer such as EXPLODE must not consume that fallback and discard the
 * parameter state with it, so it asks here first. Returns the refusal when
 * the insert carries dynamic state whose evaluation refuses (or whose data
 * is retained unmodeled), and null when EXPLODE may proceed: no dynamic
 * data on either side, or evaluation succeeds, or a dynamic definition
 * with NO stored instance values (nothing to lose — expansion presents
 * the authored geometry, which is what the explode produces). The gating
 * mirrors expansionBlock exactly.
 *
 * Review R10: the probe walks every nested reference the expansion of
 * `ins` actually consumes — the (possibly evaluated) entities of each
 * block, recursively — and returns the FIRST nested refusal in
 * consumption order, identified by insertId/block. The walk mirrors
 * explodeSingleInto's guards: references deeper than MAX_INSERT_DEPTH
 * are never consumed (not probed), a block already on the chain is
 * skipped (cyclic), a missing block consumes nothing, and the visit
 * budget matches the expansion budget (a walk that would exceed it is
 * already refused by insertExpansionLimited, which EXPLODE checks first).
 */
export function insertEvaluationRefusal(ins: InsertEntity, lookup: BlockLookup): InsertEvaluationRefusal | null {
  return probeEvaluationRefusal(ins, lookup, 0, [], { visits: MAX_INSERT_EXPANSION });
}

function probeEvaluationRefusal(
  ins: InsertEntity,
  lookup: BlockLookup,
  depth: number,
  chain: string[],
  budget: { visits: number },
): InsertEvaluationRefusal | null {
  // Beyond the depth limit expansion never descends: nothing is consumed,
  // so nothing can be lost — not even this reference's own state.
  if (depth > MAX_INSERT_DEPTH) return null;
  if (budget.visits <= 0) return null;
  budget.visits -= 1;
  const block = lookup(ins.block);
  if (!block) return null;
  if (chain.includes(ins.block)) return null;
  const own = ownEvaluationRefusal(ins, block);
  if (own) {
    return depth === 0
      ? own
      : { ...own, message: `Nested block reference "${ins.id}" of block "${ins.block}" cannot be exploded: ${own.message}` };
  }
  // The references expansion consumes are the ones in the EVALUATED
  // definition (actions and the visibility post-pass already applied),
  // not the authored list.
  const expanded = expansionBlock(block, ins);
  chain.push(ins.block);
  try {
    for (const e of expanded.entities) {
      if (e.type !== 'insert') continue;
      const nested = probeEvaluationRefusal(e, lookup, depth + 1, chain, budget);
      if (nested) return nested;
    }
    return null;
  } finally {
    chain.pop();
  }
}

/** Append the expansion of `ins` to `out` (no spread: nested results may be large). */
function explodeInto(out: Entity[], ins: InsertEntity, lookup: BlockLookup, depth: number, budget: ExpansionBudget): void {
  // Refuse multiplicative work before iterating, including empty or missing definitions.
  if (entityGeometryWork(ins) > MAX_BLOCK_EXPANSION_WORK) throw new GeometryBudgetError('Block expansion exceeds the safe geometry budget.');
  for (const instance of insertArrayInstances(ins)) {
    if (budget.visits <= 0 || budget.left <= 0) { budget.truncated = true; break; }
    explodeSingleInto(out, instance, lookup, depth, budget);
  }
}

function explodeSingleInto(out: Entity[], ins: InsertEntity, lookup: BlockLookup, depth: number, budget: ExpansionBudget): void {
  // Every reference followed costs one visit, also one that draws nothing (an empty or missing
  // block, or one below the nesting depth): the walk itself is bounded, not only its output.
  if (budget.visits <= 0) {
    budget.truncated = true;
    return;
  }
  budget.visits -= 1;
  if (depth === 0) spendExpansion(budget, entityGeometryWork(ins));
  if (depth > MAX_INSERT_DEPTH) return;
  const block = lookup(ins.block);
  budget.deps.set(ins.block, block);
  if (!block) return;
  if (budget.chain.includes(ins.block)) {
    budget.cyclic = true;
    return;
  }
  const tf = insertTransform(ins, block);
  if (block.xref && block.entities.length === 0) {
    spendExpansion(budget, 2);
    for (const e of xrefPlaceholder(ins, block, tf)) {
      if (budget.left <= 0) { budget.truncated = true; break; }
      out.push(e);
      budget.left -= 1;
    }

    return;
  }
  budget.chain.push(ins.block);
  const similar = isSimilarInsert(ins);
  // Priority 30.1: evaluate dynamic values in definition space before the
  // insert transform composes them (see expansionBlock). For static inserts
  // this is `block` itself, by identity.
  const expanded = expansionBlock(block, ins);
  for (const e of expanded.entities) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    spendExpansion(budget, entityGeometryWork(e));
    transformInto(out, e, tf, ins, similar, lookup, depth + 1, budget);
  }
  // Attribute text (placements come from the possibly evaluated definition;
  // values always come from the insert, unchanged). Stored per-instance
  // placements are authored-frame: rebase them by the evaluation motion so
  // an imported override cannot pin the attribute against it (R07).
  const textIns = attributePlacementsForDef(ins, block, expanded);
  for (const a of expanded.attributes) {
    spendExpansion(budget, 1 + a.default.length);
    if (a.invisible || ins.hiddenAttributes?.includes(a.tag)) continue;
    const value = ins.attributes[a.tag] ?? a.default;
    if (!value) continue;
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    budget.left -= 1;
    const text = attributeText(textIns, expanded, a, value);
    const inheritedWeight = text.lineWeight === -2 ? budget.resolveLineweight?.(ins) : undefined;
    if (inheritedWeight !== undefined && (!Number.isFinite(inheritedWeight) || inheritedWeight < 0)) throw new Error('Plot lineweight resolver must return finite nonnegative millimetres.');
    out.push(inheritedWeight === undefined ? text : { ...text, lineWeight: inheritedWeight });
  }
  budget.chain.pop();
}

/** What the readers report about block expansion (expansionReport). */
export interface ExpansionReport {
  /** Blocks that insert themselves, directly or through other blocks. */
  readonly cyclic: readonly string[];
  /** Blocks one reference to which expands to more than MAX_INSERT_EXPANSION objects (or follows more references). */
  readonly oversized: readonly string[];
  /** Objects the references of `topLevel` expand to (saturates above MAX_INSERT_EXPANSION * 1000). */
  readonly total: number;
}

/**
 * How the blocks of a drawing expand, without expanding them: the objects one reference to each
 * block produces (nested blocks counted through, saturating), the blocks that insert themselves,
 * and the total for the references in `topLevel` (model space and layouts). Nested references are
 * counted down to MAX_INSERT_DEPTH levels, as they are drawn (explodeInto), one count per block and
 * level: the recursion is never deeper than that, so a chain of thousands of blocks that each
 * insert the next cannot overflow the stack, and the work is linear in the size of the block table.
 */
export function expansionReport(blocks: Readonly<Record<string, BlockDef>>, topLevel: readonly Entity[]): ExpansionReport {
  const CAP = MAX_INSERT_EXPANSION + 1;
  /** Objects a reference produces and references it follows (itself included), as explodeInto counts them. */
  interface Count {
    objects: number;
    visits: number;
  }
  const one: Count = { objects: 0, visits: 1 };
  /** size[depth]: the count of a reference at that nesting depth, per block name. */
  const size = Array.from({ length: MAX_INSERT_DEPTH + 1 }, () => new Map<string, Count>());
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  const sizeOf = (name: string, depth: number): Count => {
    if (depth > MAX_INSERT_DEPTH) return one;
    const memo = size[depth]!;
    const known = memo.get(name);
    if (known !== undefined) return known;
    const block = blocks[name];
    if (!block) return one;
    if (onStack.has(name)) {
      cyclic.add(name);
      return one;
    }
    if (block.xref && block.entities.length === 0) return { objects: 2, visits: 1 };
    onStack.add(name);
    let objects = 0;
    let visits = 1;
    for (const e of block.entities) {
      if (e.type === 'insert') {
        const c = sizeOf(e.block, depth + 1);
        const instances = insertArrayCount(e);
        objects += c.objects * instances;
        visits += c.visits * instances;
      } else objects += 1;
      if (objects >= CAP || visits >= CAP) break;
    }
    const count = { objects: Math.min(CAP, objects + block.attributes.filter((a) => !a.invisible).length), visits: Math.min(CAP, visits) };
    onStack.delete(name);
    memo.set(name, count);
    return count;
  };
  for (const name of Object.keys(blocks)) sizeOf(name, 0);
  let total = 0;
  for (const e of topLevel) if (e.type === 'insert') total = Math.min(CAP * 1000, total + sizeOf(e.block, 0).objects * insertArrayCount(e));
  const oversized = [...size[0]!].filter(([, c]) => c.objects >= CAP || c.visits > MAX_INSERT_EXPANSION).map(([name]) => name);
  return { cyclic: [...cyclic].sort(), oversized: oversized.sort(), total };
}

/** One dynamic-block reference whose displayed geometry is NOT its evaluated
 *  geometry (see dynamicEvaluationNotices). */
export interface DynamicEvaluationNotice {
  readonly insertId: string;
  readonly block: string;
  /** The refusal code (insertEvaluationRefusal / the evaluator's codes). */
  readonly code: string;
  readonly message: string;
}

/**
 * The dynamic-block sibling of expansionReport (priority 30 review §3):
 * every reference in `topLevel` whose expansion fell back to authored
 * geometry — evaluation refused, or the dynamic data is retained unmodeled —
 * with its refusal code and message. This is the queryable per-drawing
 * diagnostic behind the editor's open-time log lines
 * (app/editor/documents.ts) and the LIST evaluation status: expansion itself
 * stays silent by design (it has no diagnostic channel), so this report is
 * what keeps a refused evaluation from being invisible to the user.
 * Read-only: it runs the same evaluation the expansion runs
 * (insertEvaluationRefusal probes each reference, nested refusals included)
 * and changes nothing.
 */
export function dynamicEvaluationNotices(blocks: Readonly<Record<string, BlockDef>>, topLevel: readonly Entity[]): DynamicEvaluationNotice[] {
  const lookup: BlockLookup = (name) => blocks[name];
  const out: DynamicEvaluationNotice[] = [];
  for (const e of topLevel) {
    if (e.type !== 'insert') continue;
    const r = insertEvaluationRefusal(e, lookup);
    if (r) out.push({ insertId: e.id, block: e.block, code: r.code, message: r.message });
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

/** The visible attribute's own native anchors win over the ATTDEF defaults. */
export function attributeText(ins: InsertEntity, block: BlockDef, a: AttributeDef, value = ins.attributes[a.tag] ?? a.default, inheritAppearance = true): TextEntity {
  const placement = ins.attributePlacements?.[a.tag] ?? a;
  const rawLayer = placement.layer ?? attributeLayer(a.tag, ins.layer);
  const local: TextEntity = { ...placement, id: `${ins.id}:${a.tag}`, type: 'text', layer: inheritAppearance && rawLayer === '0' ? ins.layer : rawLayer, color: placement.color ?? 'ByLayer', rotation: placement.rotation ?? 0, text: value };
  if (inheritAppearance) Object.assign(local, inheritedColor(local, ins), inheritedTransparency(local, ins));
  return scaledText(local, insertTransform(ins, block), ins.rotation, ins.scale, ins.scaleY ?? ins.scale, !!ins.mirror) as TextEntity;
}

/** ATTRIB data is in world coordinates; keep overrides local so moving an insert moves its labels. */
export function localAttributePlacement(ins: InsertEntity, basePoint: Point, placement: TextPlacement & AttributeAppearance & { readonly style?: string }): TextPlacement & AttributeAppearance & { readonly style?: string } {
  const inverse = (p: Point) => {
    const q = g.rotate(g.sub(p, ins.position), -ins.rotation);
    return g.add(basePoint, { x: q.x / (ins.scale * (ins.mirror ? -1 : 1)), y: q.y / (ins.scaleY ?? ins.scale) });
  };
  return scaledText({ ...placement, rotation: (placement.rotation ?? 0) - ins.rotation }, inverse, 0, 1 / ins.scale, 1 / (ins.scaleY ?? ins.scale), !!ins.mirror);
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
      return { ...e, points: e.points.map(tf), width: e.width !== undefined ? e.width * Math.abs(k) : e.width, widths: e.widths?.map((w) => ({ start: w.start * Math.abs(k), end: w.end * Math.abs(k) })), ...(e.widthFrame ? { widthFrame: transformWidthFrame(e.widthFrame, tf) } : {}) };
    case 'text':
      return { ...transformedTextAnchors(e, tf), height: e.height * k, rotation: e.rotation + rotation };
    case 'insert':
      return { ...e, position: tf(e.position), rotation: e.rotation + rotation, scale: e.scale * k, ...(e.scaleY !== undefined ? { scaleY: e.scaleY * k } : {}), ...(e.columnSpacing !== undefined ? { columnSpacing: e.columnSpacing * k } : {}), ...(e.rowSpacing !== undefined ? { rowSpacing: e.rowSpacing * k } : {}) };
    case 'ellipse':
      return { ...e, center: tf(e.center), majorAxis: g.rotate(g.scale(e.majorAxis, k), rotation) };
    case 'point':
      return { ...e, position: tf(e.position) };
    case 'xline':
    case 'ray':
      return { ...e, base: tf(e.base), direction: g.rotate(e.direction, rotation) };
    case 'mtext':
      return { ...e, position: tf(e.position), height: e.height * k, width: e.width * k, rotation: e.rotation + rotation, ...(e.columns ? { columns: scaledMTextColumns(e.columns, k) } : {}) };
    case 'dimension':
      return {
        ...e,
        p1: tf(e.p1),
        p2: tf(e.p2),
        linePoint: tf(e.linePoint),
        center: e.center ? tf(e.center) : e.center,
        textPosition: e.textPosition ? tf(e.textPosition) : e.textPosition,
        rotation: e.kind === 'ordinate' ? e.rotation : e.rotation + rotation,
        // Native ordinate SCALE regenerates the measurement without scaling its style
        // sizes, including automatic DIMSCALE=0. INSERT display scales local primitives.
        style: e.kind === 'ordinate' || k === 1 ? e.style : { ...e.style, scale: e.style.scale * k },
        ...(e.kind !== 'ordinate' && k !== 1 && e.styleOverrides !== undefined ? { styleOverrides: { ...e.styleOverrides, DIMSCALE: e.style.scale * k } } : {}),
      };
    case 'spline':
    case 'hatch':
    case 'leader':
    case 'table':
    case 'image':
      return affineCompound(e, { tf, vec: (v) => g.rotate(g.scale(v, k), rotation), rotation, kx: k, ky: k, mirrored: false });
  }
}

/**
 * The colour properties a block-definition object shows with inside block reference `ins`:
 * - an explicit colour (ACI 1..255 or a true colour) is kept;
 * - ByLayer resolves against the object's layer, where an object on layer "0" floats to the
 *   reference's layer (the reference's own colour does not change it, as in AutoCAD);
 * - ByBlock (0) takes the reference's colour: its ACI or true colour, or, when the reference is
 *   ByLayer, the colour of the reference's layer (`colorLayer`); a ByBlock reference passes
 *   ByBlock on to the next level up, so nested blocks resolve outwards.
 */
export function inheritedColor(e: EntityBase, ins: EntityBase): Pick<EntityBase, 'color' | 'trueColor' | 'colorName' | 'colorLayer'> {
  const ownName = e.colorName !== undefined ? { colorName: e.colorName } : {};
  const parentName = ins.colorName !== undefined ? { colorName: ins.colorName } : {};
  if (e.trueColor !== undefined) return { color: e.color, trueColor: e.trueColor, ...ownName };
  if (e.color !== BYBLOCK) return { color: e.color, ...ownName, ...(e.colorLayer !== undefined ? { colorLayer: e.colorLayer } : {}) };
  if (ins.trueColor !== undefined) return { color: ins.color, trueColor: ins.trueColor, ...parentName, ...ownName };
  if (ins.color === 'ByLayer') return { color: 'ByLayer', colorLayer: ins.colorLayer ?? ins.layer, ...parentName, ...ownName };
  return { color: ins.color, ...parentName, ...ownName };
}

/** Exploded block content made permanent (EXPLODE): a `colorLayer` becomes that layer's colour. */
export function bakeInheritedColor<T extends Entity>(e: T, layers: readonly Layer[]): T {
  if (e.type === 'leader' && e.textAppearance) {
    const a = e.textAppearance;
    const layer = layers.find((l) => l.name === a.colorLayer);
    e = { ...e, textAppearance: {
      ...a,
      ...(a.colorLayer !== undefined ? { color: layer?.color ?? 7, trueColor: layer?.trueColor, colorName: a.colorName ?? layer?.colorName } : {}),
      ...(a.transparencyLayer !== undefined ? { transparency: Math.round(resolveAlpha({ layer: e.textLayer ?? e.layer, ...a }, layers) * 255) } : {}),
      colorLayer: undefined, transparencyLayer: undefined,
    } };
  }
  const bg = entityMTextBackground(e);
  if (bg?.colorLayer !== undefined) {
    const { colorLayer, ...background } = bg;
    const layer = layers.find((l) => l.name === colorLayer);
    const baked = { ...background, color: layer?.color ?? 7, ...(layer?.trueColor !== undefined ? { trueColor: layer.trueColor } : {}) };
    e = { ...e, ...(e.type === 'leader' ? { textBackground: baked } : { background: baked }) };
  }
  if (e.colorLayer === undefined && e.transparencyLayer === undefined) return e;
  const { colorLayer, transparencyLayer, ...rest } = e;
  const layer = layers.find((l) => l.name === colorLayer);
  return {
    ...rest,
    ...(colorLayer !== undefined ? { color: layer?.color ?? 7, ...(layer?.trueColor !== undefined ? { trueColor: layer.trueColor } : {}), ...(e.colorName === undefined && layer?.colorName !== undefined ? { colorName: layer.colorName } : {}) } : {}),
    ...(transparencyLayer !== undefined ? { transparency: Math.round(resolveAlpha(e, layers) * 255) } : {}),
  } as T;
}

function transformInto(out: Entity[], e: Entity, tf: (p: Point) => Point, ins: InsertEntity, similar: boolean, lookup: BlockLookup, depth: number, budget: ExpansionBudget): void {
  // Transform each local grid anchor before a nonuniform parent can shear the grid.
  if (e.type === 'insert' && insertArrayCount(e) > 1) {
    for (const instance of insertArrayInstances(e)) {
      if (budget.visits <= 0 || budget.left <= 0) { budget.truncated = true; break; }
      transformInto(out, instance, tf, ins, similar, lookup, depth, budget);
    }
    return;
  }
  // Entities on layer "0" inside a block inherit the insert's layer (AutoCAD behaviour).
  const lay = e.layer === '0' ? ins.layer : e.layer;
  const lt = e.linetype && e.linetype.toUpperCase() === 'BYBLOCK' ? ins.linetype : e.linetype;
  const { trueColor: _t, colorLayer: _c, colorName: _n, transparency: _a, transparencyLayer: _al, ...plain } = e;
  const inheritedWeight = e.lineWeight === -2 ? budget.resolveLineweight?.(ins) : undefined;
  if (inheritedWeight !== undefined && (!Number.isFinite(inheritedWeight) || inheritedWeight < 0)) throw new Error('Plot lineweight resolver must return finite nonnegative millimetres.');
  const styled = { ...plain, layer: lay, ...inheritedColor(e, ins), ...inheritedTransparency(e, ins), linetype: lt, ...(inheritedWeight === undefined ? {} : { lineWeight: inheritedWeight }) } as Entity;
  if (e.type === 'leader' && e.textAppearance) {
    const annotation: EntityBase = { id: e.id, layer: e.textLayer ?? e.layer, color: e.textAppearance.color ?? 'ByLayer', ...e.textAppearance };
    Object.assign(styled, { textAppearance: { ...e.textAppearance, ...inheritedColor(annotation, ins), ...inheritedTransparency(annotation, ins) } });
  }
  const bg = entityMTextBackground(e);
  if (bg) {
    const inherited = inheritedColor({ ...e, color: bg.color, trueColor: bg.trueColor, colorName: bg.colorName, colorLayer: bg.colorLayer }, ins);
    Object.assign(styled, styled.type === 'leader' ? { textBackground: { ...bg, ...inherited } } : { background: { ...bg, ...inherited } });
  }
  if (styled.type === 'leader' && styled.textLayer === '0') Object.assign(styled, { textLayer: ins.layer });
  if ((!similar || Math.abs(ins.scale) !== 1) && styled.type === 'dimension' && styled.kind === 'ordinate') {
    // A scaled native reference displays its original local label, whereas native
    // EXPLODE regenerates a new measurement. Preserve display as bounded primitives;
    // the editable source dimension remains in the saved block definition.
    budget.contextGeometry = true;
    for (const part of dimensionParts(styled, lookup.textGeometry)) {
      if (budget.left <= 0) { budget.truncated = true; break; }
      budget.left -= 1;
      out.push(blockTransform(part, tf, ins.rotation, ins.scale, ins.scaleY ?? ins.scale, Boolean(ins.mirror)));
    }
    return;
  }
  if (!similar && styled.type === 'insert') {
    // Applying anisotropic scale after a rotated nested INSERT produces shear. Combining
    // its rotation/scales as scalar INSERT fields would lose that affine geometry. Expand
    // in the nested reference's own coordinates, then apply this ancestor to its primitives.
    const children: Entity[] = [];
    explodeInto(children, styled, lookup, depth, budget);
    for (const child of children) {
      if (child.type === 'dimension' && child.kind === 'ordinate') {
        budget.contextGeometry = true;
        for (const part of dimensionParts(child, lookup.textGeometry)) {
          if (budget.left <= 0) { budget.truncated = true; break; }
          budget.left -= 1;
          out.push(blockTransform(part, tf, ins.rotation, ins.scale, ins.scaleY ?? ins.scale, Boolean(ins.mirror)));
        }
      } else out.push(blockTransform(child, tf, ins.rotation, ins.scale, ins.scaleY ?? ins.scale, Boolean(ins.mirror)));
    }
    return;
  }
  // Direct similarity commands keep a native gradient world-aligned. Even a uniform
  // INSERT evaluates its gradient in definition space before applying the reference.
  const directSimilarity = similar && !(styled.type === 'hatch' && styled.gradient !== undefined) && !(styled.type === 'dimension' && styled.kind === 'ordinate');
  const moved = directSimilarity ? similarityTransform(styled, tf, ins.rotation, ins.scale) : blockTransform(styled, tf, ins.rotation, ins.scale, ins.scaleY ?? ins.scale, Boolean(ins.mirror));
  if (moved.type === 'insert') {
    explodeInto(out, moved, lookup, depth, budget);
    return;
  }
  budget.left -= 1;
  out.push(moved);
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
      if (e.widths || e.widthFrame) {
        let bounds = g.boundsOfPoints(polylineVertices(e));
        for (const polygon of polylineWidthGeometry(e).polygons) bounds = g.unionBounds(bounds, g.boundsOfPoints(polygon));
        return bounds;
      }
      const b = g.boundsOfPoints(polylineVertices(e));
      if (!b || !e.width) return b;
      const h = e.width / 2;
      return { min: { x: b.min.x - h, y: b.min.y - h }, max: { x: b.max.x + h, y: b.max.y + h } };
    }
    case 'text':
      return textBounds(e, lookup.textGeometry);
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
      for (const t of mtextParts(e, lookup.textGeometry)) b = g.unionBounds(b, textBounds(t, lookup.textGeometry));
      for (const l of mtextDecorations(e, lookup.textGeometry)) b = g.unionBounds(b, g.boundsOfPoints([l.a, l.b]));
      for (const mask of mtextMasks(e, lookup.textGeometry)) b = g.unionBounds(b, g.boundsOfPoints(mask));
      return b ?? { min: e.position, max: e.position };
    }
    case 'dimension': {
      let b: Bounds | null = null;
      for (const p of dimensionParts(e, lookup.textGeometry)) b = g.unionBounds(b, entityBounds(p, lookup));
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
      for (const p of compoundParts(e, lookup.textGeometry)) b = g.unionBounds(b, entityBounds(p, lookup));
      return b;
    }
  }
}

/** Primitive parts of a leader, table or image (for bounds, hit testing, snapping, drawing). */
export function compoundParts(e: LeaderEntity | TableEntity | ImageEntity, context?: TextGeometryContext): Entity[] {
  return e.type === 'leader' ? leaderParts(e, context) : e.type === 'table' ? tableParts(e, context) : imageParts(e);
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
      if (e.widths || e.widthFrame) {
        const geometry = polylineWidthGeometry(e);
        let distance = Infinity;
        for (const polygon of geometry.polygons) {
          if (pointInPolygon(p, polygon)) return 0;
          for (let i = 0; i < polygon.length; i++) distance = Math.min(distance, g.distToSegment(p, polygon[i]!, polygon[(i + 1) % polygon.length]!));
        }
        for (const spine of geometry.thin) for (let i = 1; i < spine.length; i++) distance = Math.min(distance, g.distToSegment(p, spine[i - 1]!, spine[i]!));
        return distance;
      }
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
      const corners = textCorners(e, lookup.textGeometry);
      if (pointInPolygon(p, corners)) return 0;
      return Math.min(...corners.map((a, i) => g.distToSegment(p, a, corners[(i + 1) % corners.length]!)));
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
      for (const mask of mtextMasks(e, lookup.textGeometry)) {
        if (hasMTextFill(e) && pointInPolygon(p, mask)) return 0;
        for (let i = 0; i < mask.length; i++) best = Math.min(best, g.distToSegment(p, mask[i]!, mask[(i + 1) % mask.length]!));
      }
      for (const t of mtextParts(e, lookup.textGeometry)) best = Math.min(best, distanceToEntity(p, t, lookup));
      for (const l of mtextDecorations(e, lookup.textGeometry)) best = Math.min(best, g.distToSegment(p, l.a, l.b));
      return best;
    }
    case 'dimension': {
      let best = Infinity;
      for (const part of dimensionParts(e, lookup.textGeometry)) best = Math.min(best, distanceToEntity(p, part, lookup));
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
      if ((e.solid || hasHatchGradient(e) || geo.dense) && pointInLoops(p, geo.polys)) return 0;
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
      for (const part of compoundParts(e, lookup.textGeometry)) best = Math.min(best, distanceToEntity(p, part, lookup));
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
      return { ...e, points: e.points.map(reflect), bulges: e.bulges?.map((bu) => -bu), ...(e.widthFrame ? { widthFrame: transformWidthFrame(e.widthFrame, reflect) } : {}) };
    case 'text':
      return transformedTextAnchors(e, reflect);
    case 'insert':
      // A reflection is a mirror about the block's Y axis plus a rotation: the block geometry is
      // mirrored while attribute / text glyphs stay readable (MIRRTEXT = 0), like AutoCAD.
      return { ...e, position: reflect(e.position), rotation: normAngle(reflectAngle(e.rotation) + Math.PI), mirror: !e.mirror, ...(e.columnSpacing !== undefined ? { columnSpacing: -e.columnSpacing } : {}) };
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

/**
 * Grip points (AutoCAD-style) for an entity. For an insert, index 0 is the
 * position grip; when a block `lookup` is supplied and the insert's block
 * has a dynamic definition, the dynamic parameter grips (core/parametric/
 * grips.ts) are APPENDED after it — indices are positional, so existing
 * grips never shift. Without a lookup an insert reports only its position
 * grip, exactly as before dynamic blocks.
 */
export function gripPoints(e: Entity, context?: TextGeometryContext, lookup?: BlockLookup): Point[] {
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
      return e.justification && (e.justification.horizontal === 3 || e.justification.horizontal === 5) && e.alignmentPoint ? [e.position, e.alignmentPoint] : [textAnchor(e)];
    case 'insert': {
      const block = lookup?.(e.block);
      if (!block) return [e.position];
      const dynamic = dynamicGrips(e, block);
      if (dynamic.length === 0) return [e.position];
      const tf = insertTransform(e, block);
      return [e.position, ...dynamic.map((grip) => tf(grip.localPoint))];
    }
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
      const textPos = e.kind === 'ordinate' ? e.textPosition ?? dimensionTextPoint(e, dimensionMeasure(e, context))
        : dimensionParts(e, context).find((p): p is TextEntity => p.type === 'text')?.position ?? e.linePoint;
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
  // Layout viewport frames (core/layouts.ts ViewportFrame) stretch as rectangles: the opposite corner stays.
  const viewportFrame = (e as { vport?: { clipBoundary?: unknown; clipOn?: boolean } }).vport;
  if (e.type === 'polyline' && viewportFrame && (!viewportFrame.clipBoundary || viewportFrame.clipOn === false) && e.points.length === 4 && index >= 0 && index < 4) {
    const o = e.points[(index + 2) % 4]!;
    const lo = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y) };
    const hi = { x: Math.max(o.x, p.x), y: Math.max(o.y, p.y) };
    if (hi.x - lo.x < 1e-9 || hi.y - lo.y < 1e-9) return null;
    return { ...e, points: [lo, { x: hi.x, y: lo.y }, hi, { x: lo.x, y: hi.y }] };
  }
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
      return { ...e, points: e.points.map((q, i) => (i === index ? p : q)), ...(e.widthFrame ? { widthFrame: moveWidthFrameGrip(e.widthFrame, index, p) } : {}) };
    case 'text': {
      if (e.justification && (e.justification.horizontal === 3 || e.justification.horizontal === 5) && e.alignmentPoint) return index === 0 ? { ...e, position: p } : { ...e, alignmentPoint: p };
      return translateEntity(e, g.sub(p, textAnchor(e)));
    }
    case 'insert':
      // Only the position grip (index 0) reaches this function for an
      // insert: dynamic parameter grips (indices >= 1, produced only when
      // gripPoints is given a block lookup) are parameter edits, not entity
      // moves — the pointer routes them through
      // core/parametric/grips.ts dynamicGripEdit -> setDynamicParameter,
      // never through here. This function has no block lookup and cannot
      // resolve a parameter, so it must not be handed a dynamic index.
      return { ...e, position: p };
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
      for (const s of polylineSegments(e.widthFrame ? polylineFrameSource(e) : e)) {
        if (s.arc) {
          const midpoint = g.polar(s.arc.center, g.angleOf(s.arc.center, s.a) + s.arc.sweep / 2, s.arc.radius);
          out.push({ point: e.widthFrame ? polylineFramePoint(e.widthFrame, midpoint) : midpoint, kind: 'midpoint' });
          out.push({ point: e.widthFrame ? polylineFramePoint(e.widthFrame, s.arc.center) : s.arc.center, kind: 'center' });
        } else { const midpoint = g.mid(s.a, s.b); out.push({ point: e.widthFrame ? polylineFramePoint(e.widthFrame, midpoint) : midpoint, kind: 'midpoint' }); }
      }
      return out;
    }
    case 'text':
      return [{ point: textAnchor(e), kind: 'insertion' }];
    case 'insert': {
      const exploded = explodeInsert(e, lookup);
      const out: SnapCandidate[] = [];
      for (const instance of insertArrayInstances(e)) out.push({ point: instance.position, kind: 'insertion' });
      for (const sub of exploded) {
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
      for (const part of dimensionParts(e, lookup.textGeometry)) {
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
      for (const part of tableParts(e, lookup.textGeometry)) if (part.type === 'line') out.push({ point: part.a, kind: 'endpoint' }, { point: part.b, kind: 'endpoint' });
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
      return hasMTextFrame(e) ? mtextMasks(e, lookup.textGeometry).flatMap((mask) => mask.map((p, i): [Point, Point] => [p, mask[(i + 1) % mask.length]!])) : [];
    case 'dimension': {
      const out: Array<[Point, Point]> = [];
      for (const part of dimensionParts(e, lookup.textGeometry)) out.push(...entitySegments(part, lookup));
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
      for (const part of compoundParts(e, lookup.textGeometry)) out.push(...entitySegments(part, lookup));
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
