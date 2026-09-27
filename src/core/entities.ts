import type { Point, Bounds } from './geometry';
import * as g from './geometry';

/** AutoCAD Color Index-like palette (subset), 'ByLayer' means inherit. */
export type ColorSpec = 'ByLayer' | number;

export interface EntityBase {
  readonly id: string;
  readonly layer: string;
  readonly color: ColorSpec;
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

export type Entity = LineEntity | CircleEntity | ArcEntity | PolylineEntity | TextEntity | InsertEntity;

export interface AttributeDef {
  readonly tag: string;
  readonly prompt: string;
  readonly default: string;
  readonly position: Point;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right';
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
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `e${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export type BlockLookup = (name: string) => BlockDef | undefined;

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
  return text.length * height * 0.7;
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

/** Transform a block-space point into world space for a given insert. */
export function insertTransform(ins: InsertEntity, block: BlockDef): (p: Point) => Point {
  return (p) => {
    const local = g.sub(p, block.basePoint);
    const scaled = g.scale(local, ins.scale);
    const rotated = g.rotate(scaled, ins.rotation);
    return g.add(ins.position, rotated);
  };
}

/** Expand an insert into world-space entities (recursively). */
export function explodeInsert(ins: InsertEntity, lookup: BlockLookup, depth = 0): Entity[] {
  const block = lookup(ins.block);
  if (!block || depth > 8) return [];
  const tf = insertTransform(ins, block);
  const out: Entity[] = [];
  for (const e of block.entities) {
    out.push(...transformEntity(e, tf, ins.rotation, ins.scale, lookup, depth + 1, ins.layer, ins.color));
  }
  // Attribute text
  for (const a of block.attributes) {
    const value = ins.attributes[a.tag] ?? a.default;
    if (!value) continue;
    out.push({
      type: 'text',
      id: `${ins.id}:${a.tag}`,
      layer: ins.layer,
      color: ins.color,
      position: tf(a.position),
      text: value,
      height: a.height * ins.scale,
      rotation: ins.rotation,
      align: a.align,
    });
  }
  return out;
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
): Entity[] {
  // Entities on layer "0" inside a block inherit the insert's layer (AutoCAD behaviour).
  const lay = e.layer === '0' ? layer : e.layer;
  const col: ColorSpec = e.color === 'ByLayer' && e.layer === '0' ? color : e.color;
  switch (e.type) {
    case 'line':
      return [{ ...e, layer: lay, color: col, a: tf(e.a), b: tf(e.b) }];
    case 'circle':
      return [{ ...e, layer: lay, color: col, center: tf(e.center), radius: e.radius * scaleFactor }];
    case 'arc':
      return [
        {
          ...e,
          layer: lay,
          color: col,
          center: tf(e.center),
          radius: e.radius * scaleFactor,
          startAngle: e.startAngle + rotation,
          endAngle: e.endAngle + rotation,
        },
      ];
    case 'polyline':
      return [{ ...e, layer: lay, color: col, points: e.points.map(tf) }];
    case 'text':
      return [
        { ...e, layer: lay, color: col, position: tf(e.position), height: e.height * scaleFactor, rotation: e.rotation + rotation },
      ];
    case 'insert': {
      const nested: InsertEntity = {
        ...e,
        layer: lay,
        color: col,
        position: tf(e.position),
        rotation: e.rotation + rotation,
        scale: e.scale * scaleFactor,
      };
      return explodeInsert(nested, lookup, depth);
    }
  }
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
    case 'polyline':
      return g.boundsOfPoints(e.points);
    case 'text':
      return textBounds(e);
    case 'insert': {
      let b: Bounds | null = null;
      for (const sub of explodeInsert(e, lookup)) b = g.unionBounds(b, entityBounds(sub, lookup));
      return b ?? g.boundsOfPoints([e.position]);
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
      const n = e.points.length;
      for (let i = 0; i < n - 1; i += 1) best = Math.min(best, g.distToSegment(p, e.points[i]!, e.points[i + 1]!));
      if (e.closed && n > 2) best = Math.min(best, g.distToSegment(p, e.points[n - 1]!, e.points[0]!));
      if (n === 1) best = g.dist(p, e.points[0]!);
      return best;
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
  }
}

/** Translate an entity by a delta. */
export function translateEntity(e: Entity, d: Point): Entity {
  const tf = (p: Point) => g.add(p, d);
  switch (e.type) {
    case 'line':
      return { ...e, a: tf(e.a), b: tf(e.b) };
    case 'circle':
    case 'arc':
      return { ...e, center: tf(e.center) };
    case 'polyline':
      return { ...e, points: e.points.map(tf) };
    case 'text':
    case 'insert':
      return { ...e, position: tf(e.position) };
  }
}

/** Rotate an entity about a point. */
export function rotateEntity(e: Entity, about: Point, angle: number): Entity {
  const tf = (p: Point) => g.rotate(p, angle, about);
  switch (e.type) {
    case 'line':
      return { ...e, a: tf(e.a), b: tf(e.b) };
    case 'circle':
      return { ...e, center: tf(e.center) };
    case 'arc':
      return { ...e, center: tf(e.center), startAngle: e.startAngle + angle, endAngle: e.endAngle + angle };
    case 'polyline':
      return { ...e, points: e.points.map(tf) };
    case 'text':
      return { ...e, position: tf(e.position), rotation: e.rotation + angle };
    case 'insert':
      return { ...e, position: tf(e.position), rotation: e.rotation + angle };
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
      for (let i = 0; i < e.points.length - 1; i += 1)
        out.push({ point: g.mid(e.points[i]!, e.points[i + 1]!), kind: 'midpoint' });
      if (e.closed && e.points.length > 2)
        out.push({ point: g.mid(e.points[e.points.length - 1]!, e.points[0]!), kind: 'midpoint' });
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
      const segs = pairs(e.points);
      if (e.closed && e.points.length > 2) segs.push([e.points[e.points.length - 1]!, e.points[0]!]);
      return segs;
    }
    case 'text':
      return [];
    case 'insert': {
      const out: Array<[Point, Point]> = [];
      for (const sub of explodeInsert(e, lookup)) out.push(...entitySegments(sub, lookup));
      return out;
    }
  }
}

function pairs(pts: readonly Point[]): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i < pts.length - 1; i += 1) out.push([pts[i]!, pts[i + 1]!]);
  return out;
}
