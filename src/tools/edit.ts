/**
 * Additional AutoCAD-style modify commands: TRIM, EXTEND, OFFSET, MIRROR,
 * SCALE, EXPLODE, plus ZOOM Window.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, PolylineEntity, ArcEntity, CircleEntity } from '../core/entities';
import { newId, explodeInsert, entitySegments, arcPoints, mirrorEntityAcross, scaleEntityBy } from '../core/entities';
import { pickEntity } from '../core/selection';
import type { Tool, ToolContext } from './types';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

// ------------------------------------------------------------------ helpers

/** Parameter t of the closest point on an infinite line ab to p. */
function paramOnLine(p: Point, a: Point, b: Point): number {
  const ab = g.sub(b, a);
  const l2 = g.dot(ab, ab);
  return l2 < g.EPS ? 0 : g.dot(g.sub(p, a), ab) / l2;
}

/** Intersections of the infinite line through a,b with an entity (as parameters t along ab). */
function lineEntityParams(a: Point, b: Point, e: Entity, lookup: (n: string) => ReturnType<ToolContext['doc']['lookupBlock']>): number[] {
  const out: number[] = [];
  const dir = g.sub(b, a);
  const L = g.len(dir);
  if (L < g.EPS) return out;
  if (e.type === 'circle' || e.type === 'arc') {
    // exact: infinite line vs circle
    const far = 1e6;
    const p0 = g.add(a, g.scale(dir, -far));
    const p1 = g.add(a, g.scale(dir, far));
    for (const x of g.segmentCircleIntersections(p0, p1, e.center, e.radius)) {
      if (e.type === 'arc' && !g.angleInSweep(g.angleOf(e.center, x), e.startAngle, e.endAngle)) continue;
      out.push(paramOnLine(x, a, b));
    }
    return out;
  }
  for (const [s0, s1] of entitySegments(e, lookup)) {
    // infinite line vs segment
    const r = dir;
    const s = g.sub(s1, s0);
    const denom = g.cross(r, s);
    if (Math.abs(denom) < g.EPS) continue;
    const qp = g.sub(s0, a);
    const t = g.cross(qp, s) / denom;
    const u = g.cross(qp, r) / denom;
    if (u >= -1e-9 && u <= 1 + 1e-9) out.push(t);
  }
  return out;
}

/** Split a line at parameters, returning the piece NOT containing the pick parameter. */
function trimLine(line: LineEntity, cutParams: number[], pickT: number): LineEntity[] {
  const cuts = cutParams.filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y);
  if (cuts.length === 0) return [line];
  let lo = 0;
  let hi = 1;
  for (const t of cuts) {
    if (t <= pickT) lo = t;
    if (t > pickT) {
      hi = t;
      break;
    }
  }
  const out: LineEntity[] = [];
  const at = (t: number) => g.add(line.a, g.scale(g.sub(line.b, line.a), t));
  if (lo > 1e-9) out.push({ ...line, id: newId(), a: line.a, b: at(lo) });
  if (hi < 1 - 1e-9) out.push({ ...line, id: newId(), a: at(hi), b: line.b });
  return out;
}

function arcFromParams(arc: ArcEntity | CircleEntity, angles: number[], pickAngle: number): Entity[] {
  const start = arc.type === 'arc' ? arc.startAngle : 0;
  const sweepTotal = arc.type === 'arc' ? g.normAngle(arc.endAngle - arc.startAngle) || 2 * Math.PI : 2 * Math.PI;
  const rel = (a: number) => g.normAngle(a - start);
  const cuts = angles.map(rel).filter((t) => t > 1e-6 && t < sweepTotal - 1e-6).sort((x, y) => x - y);
  if (cuts.length === 0) return [arc];
  const pick = rel(pickAngle);
  if (arc.type === 'circle') {
    if (cuts.length < 2) return [arc];
    // Remove the piece between the two cuts surrounding the pick.
    let lo = cuts[cuts.length - 1]!;
    let hi = cuts[0]!;
    for (let i = 0; i < cuts.length; i += 1) {
      if (cuts[i]! <= pick) lo = cuts[i]!;
      if (cuts[i]! > pick) {
        hi = cuts[i]!;
        break;
      }
    }
    return [{ id: newId(), layer: arc.layer, color: arc.color, type: 'arc', center: arc.center, radius: arc.radius, startAngle: start + hi, endAngle: start + lo }];
  }
  let lo = 0;
  let hi = sweepTotal;
  for (const t of cuts) {
    if (t <= pick) lo = t;
    if (t > pick) {
      hi = t;
      break;
    }
  }
  const out: Entity[] = [];
  if (lo > 1e-6) out.push({ ...arc, id: newId(), startAngle: start, endAngle: start + lo });
  if (hi < sweepTotal - 1e-6) out.push({ ...arc, id: newId(), startAngle: start + hi, endAngle: arc.endAngle });
  return out;
}

// ------------------------------------------------------------------ TRIM

/** TRIM: select cutting edges (Enter = all), then click the parts to remove. */
export class TrimTool implements Tool {
  readonly name = 'TRIM';
  private edges: string[] = [];
  private phase: 'edges' | 'pick' = 'edges';

  start(ctx: ToolContext): void {
    this.phase = 'edges';
    if (ctx.selection.size > 0) {
      this.edges = [...ctx.selection];
      this.beginPick(ctx);
      return;
    }
    ctx.requestSelection('Select cutting edges or <Enter to select all>:', (ids) => {
      this.edges = ids;
      this.beginPick(ctx);
    });
  }

  private beginPick(ctx: ToolContext): void {
    this.phase = 'pick';
    ctx.selection = new Set(this.edges);
    ctx.prompt('Select object to trim or [Undo]:');
  }

  private cutters(ctx: ToolContext, target: Entity): Entity[] {
    const edgeSet = new Set(this.edges);
    const all = edgeSet.size ? ctx.doc.entities.filter((e) => edgeSet.has(e.id)) : ctx.doc.entities;
    return all.filter((e) => e.id !== target.id);
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (this.phase !== 'pick') return;
    const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
    const target = pickEntity(p, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
    if (!target) return;
    const cutters = this.cutters(ctx, target);
    let replacement: Entity[] | null = null;
    if (target.type === 'line') {
      const params: number[] = [];
      for (const c of cutters) params.push(...lineEntityParams(target.a, target.b, c, ctx.doc.lookupBlock));
      const pieces = trimLine(target, params, paramOnLine(p, target.a, target.b));
      if (pieces.length === 1 && pieces[0] === target) {
        ctx.log('Object does not intersect a cutting edge.');
        return;
      }
      replacement = pieces;
    } else if (target.type === 'arc' || target.type === 'circle') {
      const angles: number[] = [];
      for (const c of cutters) {
        for (const [s0, s1] of entitySegments(c, ctx.doc.lookupBlock)) {
          for (const x of g.segmentCircleIntersections(s0, s1, target.center, target.radius)) {
            if (target.type === 'arc' && !g.angleInSweep(g.angleOf(target.center, x), target.startAngle, target.endAngle)) continue;
            angles.push(g.angleOf(target.center, x));
          }
        }
      }
      const pieces = arcFromParams(target, angles, g.angleOf(target.center, p));
      if (pieces.length === 1 && pieces[0] === target) {
        ctx.log('Object does not intersect enough cutting edges.');
        return;
      }
      replacement = pieces;
    } else if (target.type === 'polyline') {
      // Trim a polyline segment: split polyline into lines around the picked segment.
      const segs = polylineSegments(target);
      let best = -1;
      let bestD = Infinity;
      segs.forEach(([a, b], i) => {
        const d = g.distToSegment(p, a, b);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best < 0) return;
      const [a, b] = segs[best]!;
      const segLine: LineEntity = { id: newId(), layer: target.layer, color: target.color, type: 'line', a, b };
      const params: number[] = [];
      for (const c of cutters) params.push(...lineEntityParams(a, b, c, ctx.doc.lookupBlock));
      const pieces = trimLine(segLine, params, paramOnLine(p, a, b));
      if (pieces.length === 1 && pieces[0] === segLine) {
        ctx.log('Segment does not intersect a cutting edge.');
        return;
      }
      replacement = target.bulges?.some((bu) => Math.abs(bu) > 1e-9) ? [...explodePolylineExcept(target, best), ...pieces] : trimPolylineSegment(target, best, pieces);
    } else {
      ctx.log('Cannot trim this object type.');
      return;
    }
    ctx.doc.transact((s) => ({
      ...s,
      entities: [...s.entities.filter((e) => e.id !== target.id), ...replacement!],
    }));
    ctx.prompt('Select object to trim or [Undo]:');
  }

  onMove(p: Point, ctx: ToolContext): void {
    ctx.setDynText([fmt(p)]);
  }
  onText(text: string, ctx: ToolContext): void {
    if (text.trim().toUpperCase() === 'U') ctx.doc.undo();
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

function polylineSegments(pl: PolylineEntity): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i < pl.points.length - 1; i += 1) out.push([pl.points[i]!, pl.points[i + 1]!]);
  if (pl.closed && pl.points.length > 2) out.push([pl.points[pl.points.length - 1]!, pl.points[0]!]);
  return out;
}

/**
 * Replace segment `index` of a straight polyline by the trimmed pieces, keeping
 * the rest as polylines (AutoCAD keeps a polyline a polyline when trimmed).
 */
function trimPolylineSegment(pl: PolylineEntity, index: number, pieces: LineEntity[]): Entity[] {
  const pts = pl.closed ? [...pl.points.slice(index + 1), ...pl.points.slice(0, index + 1)] : pl.points;
  // For a closed polyline, rotate so the trimmed segment is the closing one: it becomes open.
  const i = pl.closed ? pts.length - 1 : index;
  const before = pts.slice(0, i + 1); // ... up to the segment start
  const after = pts.slice(i + 1); // segment end onwards
  const keepStart = pieces.find((q) => g.eq(q.a, pts[i]!, 1e-9));
  const keepEnd = pieces.find((q) => g.eq(q.b, pts[i + 1]!, 1e-9));
  const out: Entity[] = [];
  const mk = (points: Point[]): Entity | null =>
    points.length >= 2 ? { id: newId(), layer: pl.layer, color: pl.color, type: 'polyline', points, closed: false } : null;
  const first = mk(keepStart ? [...before, keepStart.b] : before);
  const second = mk(keepEnd ? [keepEnd.a, ...after] : after);
  if (pl.closed && first && second && !keepStart && !keepEnd) {
    // both sides survive as one open polyline running from the segment end around to its start
    const joined = mk([...(second.type === 'polyline' ? second.points : []), ...(first.type === 'polyline' ? first.points : [])]);
    return joined ? [joined] : [];
  }
  if (first) out.push(first);
  if (second) out.push(second);
  return out;
}

function explodePolylineExcept(pl: PolylineEntity, skip: number): LineEntity[] {
  return polylineSegments(pl)
    .map(([a, b], i) => (i === skip ? null : ({ id: newId(), layer: pl.layer, color: pl.color, type: 'line', a, b } as LineEntity)))
    .filter((x): x is LineEntity => x !== null);
}

// ------------------------------------------------------------------ EXTEND

/** EXTEND: select boundary edges, then click the end of a line to extend. */
export class ExtendTool implements Tool {
  readonly name = 'EXTEND';
  private edges: string[] = [];
  private phase: 'edges' | 'pick' = 'edges';

  start(ctx: ToolContext): void {
    this.phase = 'edges';
    if (ctx.selection.size > 0) {
      this.edges = [...ctx.selection];
      this.beginPick(ctx);
      return;
    }
    ctx.requestSelection('Select boundary edges or <Enter to select all>:', (ids) => {
      this.edges = ids;
      this.beginPick(ctx);
    });
  }
  private beginPick(ctx: ToolContext): void {
    this.phase = 'pick';
    ctx.selection = new Set(this.edges);
    ctx.prompt('Select object to extend:');
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (this.phase !== 'pick') return;
    const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
    const target = pickEntity(p, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
    if (!target || target.type !== 'line') {
      if (target) ctx.log('Only lines can be extended.');
      return;
    }
    const edgeSet = new Set(this.edges);
    const boundaries = (edgeSet.size ? ctx.doc.entities.filter((e) => edgeSet.has(e.id)) : ctx.doc.entities).filter((e) => e.id !== target.id);
    const params: number[] = [];
    for (const b of boundaries) params.push(...lineEntityParams(target.a, target.b, b, ctx.doc.lookupBlock));
    const pickT = paramOnLine(p, target.a, target.b);
    const at = (t: number) => g.add(target.a, g.scale(g.sub(target.b, target.a), t));
    let next: LineEntity | null = null;
    if (pickT >= 0.5) {
      const beyond = params.filter((t) => t > 1 + 1e-9).sort((x, y) => x - y)[0];
      if (beyond !== undefined) next = { ...target, b: at(beyond) };
    } else {
      const before = params.filter((t) => t < -1e-9).sort((x, y) => y - x)[0];
      if (before !== undefined) next = { ...target, a: at(before) };
    }
    if (!next) {
      ctx.log('No boundary edge in that direction.');
      return;
    }
    ctx.doc.replaceEntities([next]);
  }
  onMove(p: Point, ctx: ToolContext): void {
    ctx.setDynText([fmt(p)]);
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

// ------------------------------------------------------------------ OFFSET

/** OFFSET: type a distance, pick an object, click the side. */
export class OffsetTool implements Tool {
  readonly name = 'OFFSET';
  private distance = 0.5;
  private target: Entity | null = null;

  start(ctx: ToolContext): void {
    this.target = null;
    ctx.prompt(`Specify offset distance <${this.distance}>:`);
  }

  private offsetEntity(e: Entity, side: Point): Entity | null {
    const base = { id: newId(), layer: e.layer, color: e.color };
    if (e.type === 'line') {
      const d = g.normalize(g.sub(e.b, e.a));
      const n = { x: -d.y, y: d.x };
      const sign = g.dot(g.sub(side, e.a), n) >= 0 ? 1 : -1;
      const off = g.scale(n, this.distance * sign);
      return { ...base, type: 'line', a: g.add(e.a, off), b: g.add(e.b, off) };
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const outward = g.dist(side, e.center) > e.radius;
      const r = e.radius + (outward ? this.distance : -this.distance);
      if (r <= 0) return null;
      return e.type === 'circle' ? { ...base, type: 'circle', center: e.center, radius: r } : { ...base, type: 'arc', center: e.center, radius: r, startAngle: e.startAngle, endAngle: e.endAngle };
    }
    if (e.type === 'polyline') {
      const pts = offsetPolyline(e.points, e.closed, this.distance, side);
      return pts ? { ...base, type: 'polyline', points: pts, closed: e.closed } : null;
    }
    return null;
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.target) {
      const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
      const hit = pickEntity(p, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
      if (!hit) return;
      if (!['line', 'circle', 'arc', 'polyline'].includes(hit.type)) {
        ctx.log('Cannot offset that object.');
        return;
      }
      this.target = hit;
      ctx.selection = new Set([hit.id]);
      ctx.prompt('Specify point on side to offset:');
      return;
    }
    const e = this.offsetEntity(this.target, p);
    if (e) ctx.doc.addEntities([e]);
    else ctx.log('Cannot offset that object by this distance.');
    this.target = null;
    ctx.selection = new Set();
    ctx.setPreview([]);
    ctx.prompt('Select object to offset or <exit>:');
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (this.target) {
      const e = this.offsetEntity(this.target, p);
      ctx.setPreview(e ? [e] : []);
    }
    ctx.setDynText([this.target ? `offset ${this.distance}` : fmt(p)]);
  }

  onText(text: string, ctx: ToolContext): void {
    const v = parseFloat(text);
    if (Number.isFinite(v) && v > 0) {
      this.distance = v;
      this.distanceAccepted = true;
      ctx.prompt('Select object to offset or <exit>:');
      return;
    }
    ctx.log('Requires a positive distance.');
  }
  private distanceAccepted = false;
  onEnter(ctx: ToolContext): void {
    if (!this.target && !this.distanceAccepted) {
      // Enter at the distance prompt accepts the default; the next Enter exits.
      this.distanceAccepted = true;
      ctx.prompt('Select object to offset or <exit>:');
      return;
    }
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** Offset an open/closed polyline with straight segments by intersecting offset lines. */
function offsetPolyline(points: readonly Point[], closed: boolean, distance: number, side: Point): Point[] | null {
  const n = points.length;
  if (n < 2) return null;
  // Determine sign from the closest segment
  let bestD = Infinity;
  let sign = 1;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const d = g.distToSegment(side, a, b);
    if (d < bestD) {
      bestD = d;
      const dir = g.normalize(g.sub(b, a));
      const nn = { x: -dir.y, y: dir.x };
      sign = g.dot(g.sub(side, a), nn) >= 0 ? 1 : -1;
    }
  }
  const offLines: Array<[Point, Point]> = [];
  for (let i = 0; i < segCount; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const dir = g.normalize(g.sub(b, a));
    const off = g.scale({ x: -dir.y, y: dir.x }, distance * sign);
    offLines.push([g.add(a, off), g.add(b, off)]);
  }
  const out: Point[] = [];
  const inter = (l1: [Point, Point], l2: [Point, Point]): Point => {
    const r = g.sub(l1[1], l1[0]);
    const s = g.sub(l2[1], l2[0]);
    const denom = g.cross(r, s);
    if (Math.abs(denom) < g.EPS) return l1[1];
    const t = g.cross(g.sub(l2[0], l1[0]), s) / denom;
    return g.add(l1[0], g.scale(r, t));
  };
  if (closed) {
    for (let i = 0; i < segCount; i += 1) out.push(inter(offLines[(i - 1 + segCount) % segCount]!, offLines[i]!));
  } else {
    out.push(offLines[0]![0]);
    for (let i = 1; i < segCount; i += 1) out.push(inter(offLines[i - 1]!, offLines[i]!));
    out.push(offLines[segCount - 1]![1]);
  }
  return out;
}

// ------------------------------------------------------------------ MIRROR / SCALE / EXPLODE

abstract class SelectionTool implements Tool {
  abstract readonly name: string;
  protected ids: string[] = [];
  readonly acceptsDistance: boolean = false;
  start(ctx: ToolContext): void {
    if (ctx.selection.size > 0) {
      this.ids = [...ctx.selection];
      ctx.log(`${this.ids.length} found`);
      this.begin(ctx);
    } else {
      ctx.requestSelection('Select objects:', (ids) => {
        if (ids.length === 0) {
          ctx.finish();
          return;
        }
        this.ids = ids;
        ctx.selection = new Set(ids);
        this.begin(ctx);
      });
    }
  }
  protected entities(ctx: ToolContext): Entity[] {
    const set = new Set(this.ids);
    return ctx.doc.entities.filter((e) => set.has(e.id));
  }
  protected abstract begin(ctx: ToolContext): void;
  onPoint(_p: Point, _ctx: ToolContext): void {}
  onMove(_p: Point, _ctx: ToolContext): void {}
  onText(text: string, ctx: ToolContext): void {
    ctx.log(`Invalid option keyword: ${text}`);
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

export function mirrorEntity(e: Entity, a: Point, b: Point): Entity {
  return mirrorEntityAcross(e, a, b);
}

export class MirrorTool extends SelectionTool {
  readonly name = 'MIRROR';
  private a: Point | null = null;
  protected begin(ctx: ToolContext): void {
    this.a = null;
    ctx.prompt('Specify first point of mirror line:');
  }
  override onPoint(p: Point, ctx: ToolContext): void {
    if (!this.a) {
      this.a = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify second point of mirror line:');
      return;
    }
    if (g.eq(this.a, p)) return;
    const a = this.a;
    ctx.doc.addEntities(this.entities(ctx).map((e) => ({ ...mirrorEntity(e, a, p), id: newId() })));
    ctx.finish();
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.a) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const a = this.a;
    ctx.setGhost(this.entities(ctx).map((e) => mirrorEntity(e, a, p)));
    ctx.setPreview([{ id: 'mirror-line', layer: '0', color: 8, type: 'line', a, b: p }]);
  }
}

export function scaleEntity(e: Entity, base: Point, k: number): Entity {
  return scaleEntityBy(e, base, k);
}

export class ScaleTool extends SelectionTool {
  readonly name = 'SCALE';
  private base: Point | null = null;
  protected begin(ctx: ToolContext): void {
    this.base = null;
    ctx.prompt('Specify base point:');
  }
  override onPoint(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      this.base = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify scale factor or pick a reference point:');
      return;
    }
    const k = g.dist(this.base, p);
    if (k < 1e-9) return;
    const b = this.base;
    ctx.doc.replaceEntities(this.entities(ctx).map((e) => scaleEntity(e, b, k)));
    ctx.finish();
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const k = g.dist(this.base, p);
    const b = this.base;
    ctx.setGhost(this.entities(ctx).map((e) => scaleEntity(e, b, k)));
    ctx.setDynText([`× ${k.toFixed(3)}`]);
  }
  override onText(text: string, ctx: ToolContext): void {
    const k = parseFloat(text);
    if (this.base && Number.isFinite(k) && k > 0) {
      const b = this.base;
      ctx.doc.replaceEntities(this.entities(ctx).map((e) => scaleEntity(e, b, k)));
      ctx.finish();
      return;
    }
    ctx.log('Requires a positive scale factor.');
  }
}

/** EXPLODE: inserts -> their entities (attributes become text), polylines -> lines. */
export class ExplodeTool extends SelectionTool {
  readonly name = 'EXPLODE';
  protected begin(ctx: ToolContext): void {
    const targets = this.entities(ctx);
    const out: Entity[] = [];
    const exploded = new Set<string>();
    for (const e of targets) {
      if (e.type === 'insert') {
        out.push(...explodeInsert(e, ctx.doc.lookupBlock).map((x) => ({ ...x, id: newId() })));
        exploded.add(e.id);
      } else if (e.type === 'polyline') {
        out.push(...explodePolylineExcept(e, -1));
        exploded.add(e.id);
      }
    }
    const n = exploded.size;
    if (n === 0) {
      ctx.log('Nothing to explode.');
      ctx.finish();
      return;
    }
    ctx.doc.transact((s) => ({ ...s, entities: [...s.entities.filter((x) => !exploded.has(x.id)), ...out] }));
    ctx.selection = new Set([...this.ids.filter((id) => !exploded.has(id)), ...out.map((x) => x.id)]);
    ctx.log(`${n} object(s) exploded.`);
    ctx.finish();
  }
}

// ------------------------------------------------------------------ PAN

/** PAN: drag with the left button to pan (the editor moves the view while this tool is active); Esc / Enter ends it. */
export class PanTool implements Tool {
  readonly name = 'PAN';
  start(ctx: ToolContext): void {
    ctx.prompt('Drag to pan. Press Esc or Enter to exit.');
  }
  onPoint(_p: Point, _ctx: ToolContext): void {}
  onMove(_p: Point, _ctx: ToolContext): void {}
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

// ------------------------------------------------------------------ ZOOM WINDOW

export class ZoomWindowTool implements Tool {
  readonly name = 'ZOOM';
  private a: Point | null = null;
  constructor(private apply: (b: { min: Point; max: Point }) => void) {}
  start(ctx: ToolContext): void {
    this.a = null;
    ctx.prompt('Specify first corner:');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.a) {
      this.a = p;
      ctx.prompt('Specify opposite corner:');
      return;
    }
    const b = g.boundsOfPoints([this.a, p])!;
    if (b.max.x - b.min.x > 1e-9 && b.max.y - b.min.y > 1e-9) this.apply(b);
    ctx.finish();
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (this.a) ctx.setPreview([{ id: 'zw', layer: '0', color: 8, type: 'polyline', closed: true, points: [this.a, { x: p.x, y: this.a.y }, p, { x: this.a.x, y: p.y }] }]);
    else ctx.setDynText([fmt(p)]);
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

export { arcPoints };
