import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import { strokeTextWidth } from '../render/hershey';
import { dimensionGeometry, type DimensionEntity } from './dimension';
import { mtextLayout, type MTextEntity } from './mtext';

export type { DimensionEntity, DimStyle, DimKind } from './dimension';
export type { MTextEntity, MTextAttachment } from './mtext';

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
}

export interface InsertEntity extends EntityBase {
  readonly type: 'insert';
  readonly block: string;
  readonly position: Point;
  readonly rotation: number;
  readonly scale: number;
  /** Attribute values (tag -> value), e.g. TAG1 = "PB101". */
  readonly attributes: Readonly<Record<string, string>>;
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
  | DimensionEntity;

export interface AttributeDef {
  readonly tag: string;
  readonly prompt: string;
  readonly default: string;
  readonly position: Point;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right';
  /** ATTDEF flag 1: value is stored but not displayed (ACADE symbols carry many of these). */
  readonly invisible?: boolean;
}

export interface BlockDef {
  readonly name: string;
  readonly basePoint: Point;
  readonly entities: readonly Entity[];
  readonly attributes: readonly AttributeDef[];
  readonly description?: string;
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
  const w = textWidth(t.text, t.height);
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

const mtextCache = new WeakMap<MTextEntity, TextEntity[]>();
/** Single-line text pieces that render an MTEXT (word wrapped). Cached per entity. */
export function mtextParts(m: MTextEntity): TextEntity[] {
  const hit = mtextCache.get(m);
  if (hit) return hit;
  const parts = mtextLayout(m, textWidth) as TextEntity[];
  mtextCache.set(m, parts);
  return parts;
}

/** Transform a block-space point into world space for a given insert. */
export function insertTransform(ins: InsertEntity, block: BlockDef): (p: Point) => Point {
  return (p) => {
    const local = g.sub(p, block.basePoint);
    const scaled = g.scale(local, ins.scale);
    const rotated = g.rotate(scaled, ins.rotation);
    return g.add(ins.position, rotated);
  };
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
  const out: Entity[] = [];
  for (const e of block.entities) {
    out.push(...transformEntity(e, tf, ins.rotation, ins.scale, lookup, depth + 1, ins.layer, ins.color, ins.linetype));
  }
  // Attribute text
  for (const a of block.attributes) {
    if (a.invisible) continue;
    const value = ins.attributes[a.tag] ?? a.default;
    if (!value) continue;
    out.push({
      type: 'text',
      id: `${ins.id}:${a.tag}`,
      layer: attributeLayer(a.tag, ins.layer),
      color: 'ByLayer',
      position: tf(a.position),
      text: value,
      height: a.height * ins.scale,
      rotation: ins.rotation,
      align: a.align,
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
      return { ...e, position: tf(e.position), rotation: e.rotation + rotation, scale: e.scale * k };
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
  }
}

function transformEntity(
  e: Entity,
  tf: (p: Point) => Point,
  rotation: number,
  scaleFactor: number,
  lookup: BlockLookup,
  depth: number,
  layer: string,
  color: ColorSpec,
  linetype: string | undefined,
): Entity[] {
  // Entities on layer "0" inside a block inherit the insert's layer (AutoCAD behaviour).
  const lay = e.layer === '0' ? layer : e.layer;
  const col: ColorSpec = e.color === 'ByLayer' && e.layer === '0' ? color : e.color;
  const lt = e.linetype && e.linetype.toUpperCase() === 'BYBLOCK' ? linetype : e.linetype;
  const moved = similarityTransform({ ...e, layer: lay, color: col, linetype: lt }, tf, rotation, scaleFactor);
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
      return b ?? { min: e.position, max: e.position };
    }
    case 'dimension': {
      let b: Bounds | null = null;
      for (const p of dimensionParts(e)) b = g.unionBounds(b, entityBounds(p, lookup));
      return b ?? g.boundsOfPoints([e.p1, e.p2]);
    }
  }
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
      return best;
    }
    case 'dimension': {
      let best = Infinity;
      for (const part of dimensionParts(e)) best = Math.min(best, distanceToEntity(p, part, lookup));
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
      // Mirrored (negative) scales are not modelled; keep the orientation so attribute text stays readable.
      return { ...e, position: reflect(e.position) };
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
  }
}
