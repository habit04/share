/**
 * Pure wire editing operations (AutoCAD Electrical style): trim a wire
 * segment, wire gaps / loops at crossings, scoot (slide a component or wire
 * number along its wire), align, multiple bus, 3-phase (3-pole) insertion
 * and wire-number editing (fixed numbers, find/replace, copy, leaders).
 *
 * Every operation works on an entity list and returns the ids to remove
 * and the entities to add, so the tools can apply them in one undo step.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, InsertEntity, TextEntity, BlockLookup, ArcEntity } from '../core/entities';
import { newId, entityBounds, textWidth, insertTransform, explodeInsert } from '../core/entities';
import type { Drawing } from '../core/document';
import { isWire, isHorizontal, isVertical, breakWire, breakVerticalWire, nearestReference, wireNumberText, WIRENO_HEIGHT } from './ladder';
import { WIRE_DOT } from './symbols';

export interface WireEdit {
  remove: string[];
  add: Entity[];
  /** Entities that keep their id but changed (moved components, edited texts). */
  replace?: Entity[];
}

const EPS = 1e-6;
const same = (a: Point, b: Point, tol = 1e-4) => g.dist(a, b) < tol;

/** How many wire ends meet at a point (a wire passing straight through counts twice). */
export function wireDegree(entities: readonly Entity[], p: Point, tol = 1e-4): number {
  let n = 0;
  for (const e of entities) {
    if (!isWire(e)) continue;
    if (same(e.a, p, tol) || same(e.b, p, tol)) n += 1;
    else if (g.distToSegment(p, e.a, e.b) < tol) n += 2;
  }
  return n;
}

/** Junction dots that no longer sit on a tee (fewer than 3 wire ends). */
export function staleDots(entities: readonly Entity[]): string[] {
  return entities.filter((e) => e.type === 'insert' && e.block === WIRE_DOT.name && wireDegree(entities, e.position) < 3).map((e) => e.id);
}

/** Interior points of a wire where other wires tee into it, sorted along the wire. */
export function teePoints(entities: readonly Entity[], wire: LineEntity): Point[] {
  const pts: Point[] = [];
  for (const e of entities) {
    if (!isWire(e) || e.id === wire.id) continue;
    for (const p of [e.a, e.b]) {
      if (same(p, wire.a) || same(p, wire.b)) continue;
      if (g.distToSegment(p, wire.a, wire.b) < 1e-4 && !pts.some((q) => same(q, p))) pts.push(p);
    }
  }
  return pts.sort((p, q) => g.dist(wire.a, p) - g.dist(wire.a, q));
}

/**
 * TRIM WIRE: remove the part of a wire between the two nearest breaks
 * (tees or wire ends) around the picked point; dots left on a plain corner
 * or end are removed too.
 */
export function trimWireAt(entities: readonly Entity[], wire: LineEntity, p: Point): WireEdit {
  const splits = [wire.a, ...teePoints(entities, wire), wire.b];
  const t = g.dist(wire.a, g.closestOnSegment(p, wire.a, wire.b));
  let i = 0;
  for (let k = 0; k < splits.length - 1; k += 1) {
    if (t >= g.dist(wire.a, splits[k]!) - EPS && t <= g.dist(wire.a, splits[k + 1]!) + EPS) {
      i = k;
      break;
    }
  }
  const add: Entity[] = [];
  const s0 = splits[i]!;
  const s1 = splits[i + 1]!;
  if (!same(s0, wire.a)) add.push({ ...wire, id: newId(), a: wire.a, b: s0 });
  if (!same(s1, wire.b)) add.push({ ...wire, id: newId(), a: s1, b: wire.b });
  const after = [...entities.filter((e) => e.id !== wire.id), ...add];
  const remove = [wire.id, ...staleDots(after)];
  return { remove, add };
}

/** True crossings of a wire with other wires (no endpoint of either wire at the crossing). */
export function wireCrossings(entities: readonly Entity[], wire: LineEntity): Point[] {
  const out: Point[] = [];
  for (const e of entities) {
    if (!isWire(e) || e.id === wire.id) continue;
    const x = g.segmentIntersection(wire.a, wire.b, e.a, e.b);
    if (!x) continue;
    if ([wire.a, wire.b, e.a, e.b].some((q) => same(q, x, 1e-3))) continue;
    if (!out.some((q) => same(q, x, 1e-3))) out.push(x);
  }
  return out.sort((p, q) => g.dist(wire.a, p) - g.dist(wire.a, q));
}

/**
 * Insert a gap (or a jump-over loop) in a wire at each crossing with another
 * wire. The wire is cut around the crossing; a loop adds a semicircle.
 */
export function insertWireGaps(entities: readonly Entity[], wire: LineEntity, style: 'gap' | 'loop', radius = 0.09): WireEdit {
  const crossings = wireCrossings(entities, wire);
  if (crossings.length === 0) return { remove: [], add: [] };
  let pieces: LineEntity[] = [wire];
  const add: Entity[] = [];
  const horizontal = isHorizontal(wire);
  for (const c of crossings) {
    const target = pieces.find((w) => g.distToSegment(c, w.a, w.b) < 1e-4);
    if (!target) continue;
    const cut = horizontal ? breakWire(target, c.x - radius, c.x + radius) : breakVerticalWire(target, c.y - radius, c.y + radius);
    pieces = pieces.filter((w) => w !== target).concat(cut);
    if (style === 'loop') {
      const arc: ArcEntity = {
        id: newId(),
        type: 'arc',
        layer: wire.layer,
        color: 'ByLayer',
        center: c,
        radius,
        startAngle: horizontal ? 0 : -Math.PI / 2,
        endAngle: horizontal ? Math.PI : Math.PI / 2,
      };
      add.push(arc);
    }
  }
  return { remove: [wire.id], add: [...pieces, ...add] };
}

/**
 * Geometric extent of a symbol: its block lines / arcs / circles only, so
 * a wide tag or description text never widens the wire break.
 */
export function symbolSpan(ins: InsertEntity, lookup: BlockLookup): g.Bounds {
  let b: g.Bounds | null = null;
  for (const e of explodeInsert(ins, lookup)) {
    if (e.type === 'text') continue;
    b = g.unionBounds(b, entityBounds(e, lookup));
  }
  return b ?? g.boundsOfPoints([ins.position])!;
}

/** World-space y levels of a symbol's wire connections (from its X?TERM pin attributes), or its own y. */
export function connectionLevels(ins: InsertEntity, lookup: BlockLookup): number[] {
  const block = lookup(ins.block);
  if (!block) return [ins.position.y];
  const tf = insertTransform(ins, block);
  const ys = block.attributes.filter((a) => /^X[14]TERM\d+$/.test(a.tag)).map((a) => tf(a.position).y);
  const uniq: number[] = [];
  for (const y of ys) if (!uniq.some((u) => Math.abs(u - y) < 1e-4)) uniq.push(y);
  return uniq.length ? uniq : [ins.position.y];
}

/**
 * Lift a component off its wires: the wire pieces touching its left and
 * right edges on each connection level are merged back into one wire.
 */
export function liftFromWires(entities: readonly Entity[], ins: InsertEntity, lookup: BlockLookup): Entity[] {
  const b = symbolSpan(ins, lookup);
  let out = [...entities];
  for (const y of connectionLevels(ins, lookup)) {
    const left = out.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - y) < 0.05 && Math.abs(Math.max(e.a.x, e.b.x) - b.min.x) < 0.02);
    const right = out.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - y) < 0.05 && Math.abs(Math.min(e.a.x, e.b.x) - b.max.x) < 0.02);
    if (!left && !right) continue;
    const x0 = left ? Math.min(left.a.x, left.b.x) : b.min.x;
    const x1 = right ? Math.max(right.a.x, right.b.x) : b.max.x;
    const proto = left ?? right!;
    const merged: LineEntity = { ...proto, id: newId(), a: { x: x0, y: proto.a.y }, b: { x: x1, y: proto.a.y } };
    out = out.filter((e) => e !== left && e !== right);
    out.push(merged);
  }
  return out;
}

/** Break every horizontal wire the (placed) component crosses on its connection levels. */
export function breakForInsert(entities: readonly Entity[], ins: InsertEntity, lookup: BlockLookup): Entity[] {
  const b = symbolSpan(ins, lookup);
  let out = [...entities];
  for (const y of connectionLevels(ins, lookup)) {
    const wire = out.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - y) < 0.05 && Math.min(e.a.x, e.b.x) < b.max.x - 1e-6 && Math.max(e.a.x, e.b.x) > b.min.x + 1e-6);
    if (!wire) continue;
    out = out.filter((e) => e !== wire).concat(breakWire(wire, b.min.x, b.max.x));
  }
  return out;
}

/** The x-extent a component may occupy on its wire (rail to rail) after lifting. */
function wireExtentAt(entities: readonly Entity[], y: number, x: number): { x0: number; x1: number } | null {
  const w = entities.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - y) < 0.05 && Math.min(e.a.x, e.b.x) <= x + 1e-6 && Math.max(e.a.x, e.b.x) >= x - 1e-6);
  return w ? { x0: Math.min(w.a.x, w.b.x), x1: Math.max(w.a.x, w.b.x) } : null;
}

/** Difference between two entity lists: removed ids, added entities and changed (same id) entities. */
function diff(before: readonly Entity[], after: readonly Entity[]): WireEdit {
  const beforeById = new Map(before.map((e) => [e.id, e]));
  const afterIds = new Set(after.map((e) => e.id));
  const replace = after.filter((e) => beforeById.has(e.id) && beforeById.get(e.id) !== e);
  return { remove: before.filter((e) => !afterIds.has(e.id)).map((e) => e.id), add: after.filter((e) => !beforeById.has(e.id)), ...(replace.length ? { replace } : {}) };
}

/** Apply a WireEdit to an entity list (pure). */
export function applyEdit(entities: readonly Entity[], edit: WireEdit): Entity[] {
  const rm = new Set(edit.remove);
  const rep = new Map((edit.replace ?? []).map((e) => [e.id, e]));
  return [...entities.filter((e) => !rm.has(e.id)).map((e) => rep.get(e.id) ?? e), ...edit.add];
}

/**
 * SCOOT: slide a component along its wire to a new x, keeping the wire
 * broken correctly. The position is clamped so the symbol stays on the wire.
 */
export function scootComponent(entities: readonly Entity[], ins: InsertEntity, lookup: BlockLookup, newX: number): WireEdit & { moved: InsertEntity } {
  const lifted = liftFromWires(entities, ins, lookup).filter((e) => e.id !== ins.id);
  const b = symbolSpan(ins, lookup);
  const halfL = ins.position.x - b.min.x;
  const halfR = b.max.x - ins.position.x;
  let x = newX;
  const ext = wireExtentAt(lifted, connectionLevels(ins, lookup)[0]!, ins.position.x);
  if (ext) x = Math.max(ext.x0 + halfL, Math.min(ext.x1 - halfR, x));
  const moved: InsertEntity = { ...ins, position: { x, y: ins.position.y } };
  const after = breakForInsert([...lifted, moved], moved, lookup);
  const d = diff(entities, after);
  return { ...d, moved };
}

/** Move a component to a new point (any direction), re-breaking wires there. */
export function relocateComponent(entities: readonly Entity[], ins: InsertEntity, lookup: BlockLookup, to: Point): WireEdit & { moved: InsertEntity } {
  const lifted = liftFromWires(entities, ins, lookup).filter((e) => e.id !== ins.id);
  const moved: InsertEntity = { ...ins, position: to };
  const after = breakForInsert([...lifted, moved], moved, lookup);
  return { ...diff(entities, after), moved };
}

/** ALIGN: move components so they line up with a reference component vertically (same x) or horizontally (same y). */
export function alignComponents(entities: readonly Entity[], targets: InsertEntity[], reference: InsertEntity, mode: 'vertical' | 'horizontal', lookup: BlockLookup): WireEdit {
  let current: Entity[] = [...entities];
  for (const t of targets) {
    if (t.id === reference.id) continue;
    const live = current.find((e): e is InsertEntity => e.id === t.id);
    if (!live) continue;
    const r = mode === 'vertical' ? scootComponent(current, live, lookup, reference.position.x) : relocateComponent(current, live, lookup, { x: live.position.x, y: reference.position.y });
    current = applyEdit(current, r);
  }
  return diff(entities, current);
}

// ------------------------------------------------------------------ bus

export interface BusSettings {
  count: number;
  spacing: number;
  direction: 'horizontal' | 'vertical';
  layer: string;
}

export const DEFAULT_BUS: BusSettings = { count: 3, spacing: 0.5, direction: 'vertical', layer: 'WIRES' };

/** Multiple bus: N parallel wires from a to b, stacked below (horizontal) or to the right (vertical). */
export function buildBus(a: Point, b: Point, s: BusSettings): LineEntity[] {
  const out: LineEntity[] = [];
  for (let i = 0; i < s.count; i += 1) {
    const off = i * s.spacing;
    const p = s.direction === 'horizontal' ? { x: a.x, y: a.y - off } : { x: a.x + off, y: a.y };
    const q = s.direction === 'horizontal' ? { x: b.x, y: a.y - off } : { x: a.x + off, y: b.y };
    out.push({ id: newId(), type: 'line', layer: s.layer, color: 'ByLayer', a: p, b: q });
  }
  return out;
}

// ------------------------------------------------------------ 3-phase

/** The three horizontal bus wires nearest to a pick point (the picked one plus the two below at even spacing). */
export function threePhaseWires(entities: readonly Entity[], p: Point, tol = 0.3): LineEntity[] | null {
  const wires = entities.filter((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.min(e.a.x, e.b.x) <= p.x && Math.max(e.a.x, e.b.x) >= p.x);
  if (wires.length < 3) return null;
  wires.sort((a, b) => Math.abs(a.a.y - p.y) - Math.abs(b.a.y - p.y));
  const first = wires[0]!;
  if (Math.abs(first.a.y - p.y) > tol) return null;
  const below = wires.filter((w) => w.a.y < first.a.y - 1e-6).sort((a, b) => b.a.y - a.a.y);
  const above = wires.filter((w) => w.a.y > first.a.y + 1e-6).sort((a, b) => a.a.y - b.a.y);
  const even = (t: LineEntity[]) => Math.abs(t[0]!.a.y - t[1]!.a.y - (t[1]!.a.y - t[2]!.a.y)) < 1e-3;
  // The picked wire may be the top, middle or bottom pole: take the evenly spaced triple.
  const candidates: LineEntity[][] = [];
  if (below.length >= 2) candidates.push([first, below[0]!, below[1]!]);
  if (below.length >= 1 && above.length >= 1) candidates.push([above[0]!, first, below[0]!]);
  if (above.length >= 2) candidates.push([above[1]!, above[0]!, first]);
  return candidates.find(even) ?? null;
}

/**
 * Insert one symbol on each of three phase wires (poles 1-3 share the tag;
 * poles 2 and 3 carry POLE=2/3 so reports count the device once) joined by
 * a dashed mechanical link.
 */
export function insertThreePole(entities: readonly Entity[], block: string, x: number, wires: LineEntity[], attrs: Record<string, string>, lookup: BlockLookup): WireEdit & { inserts: InsertEntity[] } {
  let current: Entity[] = [...entities];
  const inserts: InsertEntity[] = [];
  wires.forEach((w, i) => {
    const ins: InsertEntity = { id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y: w.a.y }, rotation: 0, scale: 1, attributes: { ...attrs, POLE: String(i + 1) } };
    inserts.push(ins);
    current = breakForInsert([...current, ins], ins, lookup);
  });
  // dashed link between the poles (short dashes on the LINK layer)
  const top = wires[0]!.a.y;
  const bottom = wires[wires.length - 1]!.a.y;
  const dash = 0.06;
  for (let y = top - 0.2; y > bottom + 0.2; y -= dash * 2) {
    current.push({ id: newId(), type: 'line', layer: 'LINK', color: 'ByLayer', a: { x, y }, b: { x, y: Math.max(y - dash, bottom + 0.2) } });
  }
  return { ...diff(entities, current), inserts };
}

// -------------------------------------------------------- wire numbers

export const WIRENO_LAYER = 'WIRENO';
export const WIREFIXED_LAYER = 'WIREFIXED';

export const isWireNumber = (e: Entity): e is TextEntity => e.type === 'text' && (e.layer === WIRENO_LAYER || e.layer === WIREFIXED_LAYER);

export interface WireNet {
  y: number;
  x0: number;
  x1: number;
  wires: LineEntity[];
}

/** Group horizontal wire pieces into nets: same y, gaps (component breaks) under 1.2 units. */
export function collectNets(entities: readonly Entity[]): WireNet[] {
  const wires = entities.filter((e): e is LineEntity => isWire(e) && isHorizontal(e));
  const sorted = [...wires].sort((a, b) => b.a.y - a.a.y || Math.min(a.a.x, a.b.x) - Math.min(b.a.x, b.b.x));
  const nets: WireNet[] = [];
  for (const w of sorted) {
    const last = nets[nets.length - 1];
    const wl = Math.min(w.a.x, w.b.x);
    const wr = Math.max(w.a.x, w.b.x);
    if (last && Math.abs(last.y - w.a.y) < 1e-6 && wl - last.x1 < 1.2) {
      last.wires.push(w);
      last.x1 = Math.max(last.x1, wr);
      continue;
    }
    nets.push({ y: w.a.y, x0: wl, x1: wr, wires: [w] });
  }
  return nets;
}

/** The net a wire-number text labels (nearest net vertically whose x-range covers the text). */
export function netOfWireNumber(nets: WireNet[], t: TextEntity): WireNet | null {
  let best: WireNet | null = null;
  let bestD = 0.4;
  for (const n of nets) {
    if (t.position.x < n.x0 - 0.5 || t.position.x > n.x1 + 0.5) continue;
    const d = Math.abs(n.y - t.position.y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Text position for a wire number relative to its net. */
export function wireNumberPosition(net: WireNet, position: 'above' | 'below' | 'inline', x = net.x0 + 0.15): Point {
  if (position === 'below') return { x, y: net.y - 0.05 - WIRENO_HEIGHT };
  if (position === 'inline') return { x, y: net.y - WIRENO_HEIGHT / 2 };
  return { x, y: net.y + 0.05 };
}

export interface WireNumberOptions {
  start?: number;
  position?: 'above' | 'below' | 'inline';
  format?: string;
}

/**
 * AEWIRENO: number every horizontal wire net. Like AutoCAD Electrical, the
 * number is the nearest ladder rung reference; additional nets on the same
 * reference get a letter suffix (100, 100A, 100B ...). When no ladder
 * references exist, numbers run sequentially from `start`. Fixed wire numbers
 * (layer WIREFIXED) are kept and their nets are skipped.
 */
export function assignWireNumbers(doc: Drawing, opts: WireNumberOptions | number = {}): number {
  const o: WireNumberOptions = typeof opts === 'number' ? { start: opts } : opts;
  const start = o.start ?? 100;
  const position = o.position ?? 'above';
  const nets = collectNets(doc.entities);
  if (nets.length === 0) return 0;
  const fixed = doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === WIREFIXED_LAYER);
  const fixedNets = new Set<WireNet>();
  const usedLabels = new Set<string>();
  for (const f of fixed) {
    usedLabels.add(f.text);
    const n = netOfWireNumber(nets, f);
    if (n) fixedNets.add(n);
  }
  const hasRefs = doc.entities.some((e) => e.type === 'text' && e.layer === 'MISC' && /^\d+$/.test(e.text));
  const used = new Map<string, number>();
  const texts: Entity[] = [];
  let seq = start;
  const fmt = (n: string) => (o.format ?? '%N').replace(/%N/g, n);
  for (const net of nets) {
    if (fixedNets.has(net)) continue;
    let label: string;
    const ref = hasRefs ? nearestReference(doc, { x: net.x0, y: net.y }) : null;
    if (ref) {
      let n = used.get(ref) ?? 0;
      do {
        label = fmt(n === 0 ? ref : `${ref}${String.fromCharCode(64 + n)}`);
        n += 1;
      } while (usedLabels.has(label));
      used.set(ref, n);
    } else {
      do {
        label = fmt(String(seq));
        seq += 1;
      } while (usedLabels.has(label));
    }
    usedLabels.add(label);
    texts.push(wireNumberText(wireNumberPosition(net, position), label));
  }
  doc.transact((s) => ({
    ...s,
    entities: [...s.entities.filter((e) => !(e.type === 'text' && e.layer === WIRENO_LAYER) && !(e.type === 'line' && e.layer === WIRENO_LAYER)), ...texts],
  }));
  return texts.length;
}

export interface WireNumberEdit {
  label: string;
  fixed: boolean;
  position: 'above' | 'below' | 'inline';
}

/** Current edit state of a wire-number text. */
export function wireNumberState(entities: readonly Entity[], t: TextEntity): WireNumberEdit {
  const net = netOfWireNumber(collectNets(entities), t);
  let position: WireNumberEdit['position'] = 'above';
  if (net) {
    const d = t.position.y - net.y;
    position = d > 0.02 ? 'above' : d < -WIRENO_HEIGHT / 2 - 0.02 ? 'below' : 'inline';
  }
  return { label: t.text, fixed: t.layer === WIREFIXED_LAYER, position };
}

/**
 * Apply an edit to a wire number: new label, fixed flag (layer), position.
 * An in-line number gaps the wire under the text; moving it back restores the gap.
 */
export function applyWireNumberEdit(entities: readonly Entity[], t: TextEntity, edit: WireNumberEdit): WireEdit {
  const nets = collectNets(entities);
  const net = netOfWireNumber(nets, t);
  const before = wireNumberState(entities, t);
  let current: Entity[] = [...entities];
  if (net && before.position === 'inline' && edit.position !== 'inline') {
    // close the gap: merge the pieces around the text
    const w = textWidth(t.text, WIRENO_HEIGHT) + 0.1;
    const left = current.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - net.y) < 1e-6 && Math.abs(Math.max(e.a.x, e.b.x) - (t.position.x - 0.05)) < 0.02);
    const right = current.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - net.y) < 1e-6 && Math.abs(Math.min(e.a.x, e.b.x) - (t.position.x - 0.05 + w)) < 0.02);
    if (left && right) {
      current = current.filter((e) => e !== left && e !== right);
      current.push({ ...left, id: newId(), a: { x: Math.min(left.a.x, left.b.x), y: net.y }, b: { x: Math.max(right.a.x, right.b.x), y: net.y } });
    }
  }
  const x = t.position.x;
  const pos = net ? wireNumberPosition(net, edit.position, x) : t.position;
  const moved: TextEntity = { ...t, id: newId(), text: edit.label, layer: edit.fixed ? WIREFIXED_LAYER : WIRENO_LAYER, position: pos };
  current = current.filter((e) => e.id !== t.id);
  if (net && edit.position === 'inline' && before.position !== 'inline') {
    const w = textWidth(edit.label, WIRENO_HEIGHT) + 0.1;
    const wire = current.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - net.y) < 1e-6 && Math.min(e.a.x, e.b.x) <= x && Math.max(e.a.x, e.b.x) >= x + w);
    if (wire) current = current.filter((e) => e !== wire).concat(breakWire(wire, x - 0.05, x - 0.05 + w));
  }
  current.push(moved);
  return diff(entities, current);
}

/** Find / replace inside every wire number (substring, case-insensitive). Returns the replacements. */
export function findReplaceWireNumbers(entities: readonly Entity[], find: string, replace: string): TextEntity[] {
  if (!find) return [];
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const out: TextEntity[] = [];
  for (const e of entities) {
    if (!isWireNumber(e) || !re.test(e.text)) continue;
    re.lastIndex = 0;
    out.push({ ...e, text: e.text.replace(re, replace) });
  }
  return out;
}

/** Copy a wire number onto another wire net (as a fixed number so renumbering keeps them equal). */
export function copyWireNumber(entities: readonly Entity[], source: TextEntity, targetWire: LineEntity, position: 'above' | 'below' = 'above'): TextEntity | null {
  const nets = collectNets(entities);
  const net = nets.find((n) => n.wires.includes(targetWire)) ?? nets.find((n) => n.wires.some((w) => w.id === targetWire.id));
  if (!net) return null;
  const x = Math.max(net.x0 + 0.15, Math.min(net.x1 - 0.5, Math.min(targetWire.a.x, targetWire.b.x) + 0.15));
  return wireNumberText(wireNumberPosition(net, position, x), source.text, WIREFIXED_LAYER);
}

/** Move a wire number to a leader position: the text moves and a leader line points back at its wire. */
export function wireNumberLeader(entities: readonly Entity[], t: TextEntity, to: Point): WireEdit {
  const net = netOfWireNumber(collectNets(entities), t);
  const anchor = net ? { x: Math.max(net.x0, Math.min(net.x1, t.position.x)), y: net.y } : t.position;
  const leader: LineEntity = { id: newId(), type: 'line', layer: t.layer, color: 'ByLayer', a: anchor, b: to };
  const moved: TextEntity = { ...t, id: newId(), position: { x: to.x + 0.05, y: to.y + 0.03 }, align: 'left' };
  return { remove: [t.id], add: [leader, moved] };
}

/** Slide a wire number along its net. */
export function scootWireNumber(entities: readonly Entity[], t: TextEntity, newX: number): TextEntity {
  const net = netOfWireNumber(collectNets(entities), t);
  if (!net) return { ...t, position: { x: newX, y: t.position.y } };
  const w = textWidth(t.text, t.height);
  const x = Math.max(net.x0, Math.min(net.x1 - w, newX));
  return { ...t, position: { x, y: t.position.y } };
}

/** Wire numbers with their nets, for reports and audits. */
export function wireNumberMap(entities: readonly Entity[]): Array<{ text: TextEntity; net: WireNet | null }> {
  const nets = collectNets(entities);
  return entities.filter(isWireNumber).map((text) => ({ text, net: netOfWireNumber(nets, text) }));
}

/** Simple helper used by tests / tools: apply a WireEdit to a drawing as one undo step. */
export function applyWireEdit(doc: Drawing, edit: WireEdit, replace: Entity[] = []): void {
  doc.transact((s) => ({ ...s, entities: applyEdit(s.entities, { ...edit, replace: [...(edit.replace ?? []), ...replace] }) }));
}
