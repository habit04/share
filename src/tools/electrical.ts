import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, InsertEntity, TextEntity } from '../core/entities';
import { newId } from '../core/entities';
import type { Drawing } from '../core/document';
import { LineTool } from './draw';
import type { Tool, ToolContext, LadderSettings } from './types';
import { findSymbol, tagPrefix, ALL_SYMBOLS, WIRE_DOT } from '../electrical/symbols';
import { IEC_SYMBOLS } from '../electrical/iec';

const lookupSymbol = (name: string) => findSymbol(name) ?? IEC_SYMBOLS.find((s) => s.name === name);
import { entityBounds } from '../core/entities';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

export const DEFAULT_LADDER: LadderSettings = {
  width: 9,
  spacing: 1,
  rungs: 10,
  firstReference: 100,
  referenceStep: 1,
  threePhase: false,
  drawRungs: false,
};

/** Wires are lines on the WIRES layer. */
export function isWire(e: Entity): e is LineEntity {
  return e.type === 'line' && e.layer.startsWith('WIRES');
}

export function isHorizontal(l: LineEntity): boolean {
  return Math.abs(l.a.y - l.b.y) < 1e-6;
}

/** True when p lies on the interior of an existing wire segment (a tee). */
export function wireTeeAt(doc: Drawing, p: Point, tol = 1e-6): LineEntity | null {
  for (const e of doc.entities) {
    if (!isWire(e)) continue;
    if (g.dist(p, e.a) < tol || g.dist(p, e.b) < tol) continue;
    if (g.distToSegment(p, e.a, e.b) < tol) return e;
  }
  return null;
}

export function wireDot(p: Point): InsertEntity {
  return { id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'insert', block: WIRE_DOT.name, position: p, rotation: 0, scale: 1, attributes: {} };
}

function hasDotAt(doc: Drawing, p: Point): boolean {
  return doc.entities.some((e) => e.type === 'insert' && e.block === WIRE_DOT.name && g.dist(e.position, p) < 1e-6);
}

/** AEWIRE: like LINE, but always on WIRES layer and ortho-constrained; adds junction dots at tees. */
export class WireTool extends LineTool {
  override readonly name = 'AEWIRE';
  constructor(private wireLayer = 'WIRES') {
    super();
  }
  override start(ctx: ToolContext): void {
    this.layer = this.wireLayer;
    ctx.doc.ensureBlocks([WIRE_DOT]);
    super.start(ctx);
    ctx.prompt('Specify wire start:');
  }
  protected override makeSegment(ctx: ToolContext, a: Point, b: Point): Entity {
    return super.makeSegment(ctx, a, b);
  }
  private dotIfTee(ctx: ToolContext, p: Point): void {
    if (wireTeeAt(ctx.doc, p, ctx.aperture() * 0.5) && !hasDotAt(ctx.doc, p)) ctx.doc.addEntities([wireDot(p)]);
  }
  override onPoint(p: Point, ctx: ToolContext): void {
    // Wires must be orthogonal: force the second point onto the axis with the larger delta.
    const last = this.points[this.points.length - 1];
    let q = p;
    if (last) {
      const dx = Math.abs(p.x - last.x);
      const dy = Math.abs(p.y - last.y);
      q = dx >= dy ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
    }
    const before = ctx.doc.entities.length;
    super.onPoint(q, ctx);
    // A wire that starts or ends in the middle of another wire is a tee: mark it with a dot.
    if (ctx.doc.entities.length !== before || this.points.length === 1) {
      const tee = wireTeeAt(ctx.doc, q, ctx.aperture() * 0.5);
      if (tee && !hasDotAt(ctx.doc, q)) ctx.doc.addEntities([wireDot(q)]);
    }
    if (this.points.length >= 1) ctx.prompt('Specify wire end or [Undo]:');
  }
  override onMove(p: Point, ctx: ToolContext): void {
    const last = this.points[this.points.length - 1];
    if (last) {
      const dx = Math.abs(p.x - last.x);
      const dy = Math.abs(p.y - last.y);
      p = dx >= dy ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
    }
    super.onMove(p, ctx);
  }
}

/** AELADDER: insert a ladder (two rails + rungs + reference numbers). */
export class LadderTool implements Tool {
  readonly name = 'AELADDER';
  private settings: LadderSettings = { ...DEFAULT_LADDER };
  private ready = false;

  start(ctx: ToolContext): void {
    this.ready = false;
    void ctx.ui.ladderSettings(this.settings).then((s) => {
      if (!s) {
        ctx.finish();
        return;
      }
      this.settings = s;
      this.ready = true;
      ctx.prompt('Specify top-left corner of ladder:');
    });
  }

  private build(ctx: ToolContext, origin: Point): Entity[] {
    const s = this.settings;
    const out: Entity[] = [];
    const height = s.spacing * (s.rungs - 1);
    const left = origin.x;
    const right = origin.x + s.width;
    const top = origin.y;
    const bottom = origin.y - height;
    const rail = (x: number): Entity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y: top + s.spacing * 0.5 }, b: { x, y: bottom - s.spacing * 0.5 } });
    out.push(rail(left), rail(right));
    if (s.threePhase) {
      out.push(rail(left - 0.5), rail(left - 1.0));
    }
    for (let i = 0; i < s.rungs; i += 1) {
      const y = top - i * s.spacing;
      const ref = String(s.firstReference + i * s.referenceStep);
      const t: TextEntity = {
        id: newId(),
        layer: 'MISC',
        color: 'ByLayer',
        type: 'text',
        position: { x: left - 0.25 - (s.threePhase ? 1 : 0), y: y - 0.06 },
        text: ref,
        height: 0.125,
        rotation: 0,
        align: 'right',
      };
      out.push(t);
      if (s.drawRungs) out.push({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: left, y }, b: { x: right, y } });
    }
    void ctx;
    return out;
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.doc.addEntities(this.build(ctx, p));
    ctx.log(`Ladder inserted: ${this.settings.rungs} rungs, width ${this.settings.width}.`);
    ctx.finish();
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.setPreview(this.build(ctx, p));
    ctx.setDynText([fmt(p)]);
  }

  onText(_t: string, _ctx: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/**
 * Find the horizontal wire nearest to the point (within tolerance) so a
 * component can be inserted in-line and the wire broken around it.
 */
export function findWireAt(doc: Drawing, p: Point, tol: number): LineEntity | null {
  let best: LineEntity | null = null;
  let bestD = tol;
  for (const e of doc.entities) {
    if (!isWire(e) || !isHorizontal(e)) continue;
    const d = g.distToSegment(p, e.a, e.b);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Break a horizontal wire around [x0, x1]. Returns the replacement pieces (0-2 lines). */
export function breakWire(wire: LineEntity, x0: number, x1: number): LineEntity[] {
  const left = Math.min(wire.a.x, wire.b.x);
  const right = Math.max(wire.a.x, wire.b.x);
  const y = wire.a.y;
  const out: LineEntity[] = [];
  if (x0 - left > 1e-6) out.push({ ...wire, id: newId(), a: { x: left, y }, b: { x: x0, y } });
  if (right - x1 > 1e-6) out.push({ ...wire, id: newId(), a: { x: x1, y }, b: { x: right, y } });
  return out;
}

/** Nearest ladder rung reference number for a y position (based on MISC-layer numeric texts). */
export function nearestReference(doc: Drawing, p: Point): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const e of doc.entities) {
    if (e.type !== 'text' || e.layer !== 'MISC' || !/^\d+$/.test(e.text)) continue;
    const d = Math.abs(e.position.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = e.text;
    }
  }
  return bestD < 0.6 ? best : null;
}

/** Next free tag for a prefix, e.g. PB101 -> PB102 if in use. */
export function uniqueTag(doc: Drawing, prefix: string, ref: string | null): string {
  const used = new Set<string>();
  for (const e of doc.entities) if (e.type === 'insert' && e.attributes.TAG1) used.add(e.attributes.TAG1);
  const base = `${prefix}${ref ?? ''}`;
  if (!used.has(base) && ref) return base;
  let n = ref ? parseInt(ref, 10) : 1;
  for (;;) {
    const t = `${prefix}${n}`;
    if (!used.has(t)) return t;
    n += 1;
  }
}

/** AECOMPONENT: pick a symbol from the icon menu, place it, trim the wire, edit tag/description. */
export class ComponentTool implements Tool {
  readonly name = 'AECOMPONENT';
  private block: string | null = null;
  private lastTarget: LineEntity | null = null;

  constructor(private preset?: string) {}

  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks([...ALL_SYMBOLS, ...IEC_SYMBOLS]);
    ctx.prompt('Select a symbol from the icon menu...');
    const choose = this.preset ? Promise.resolve(this.preset) : ctx.ui.pickSymbol();
    void choose.then((name) => {
      if (!name || !lookupSymbol(name)) {
        ctx.finish();
        return;
      }
      this.block = name;
      ctx.prompt(`Specify insertion point for ${name}:`);
    });
  }

  private makeInsert(pos: Point, attrs: Record<string, string> = {}): InsertEntity {
    return {
      id: newId(),
      layer: 'SYMS',
      color: 'ByLayer',
      type: 'insert',
      block: this.block!,
      position: pos,
      rotation: 0,
      scale: 1,
      attributes: attrs,
    };
  }

  private target(ctx: ToolContext, p: Point): { pos: Point; wire: LineEntity | null } {
    const wire = findWireAt(ctx.doc, p, ctx.aperture() * 2.5);
    if (wire) return { pos: { x: p.x, y: wire.a.y }, wire };
    return { pos: p, wire: null };
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (!this.block) return;
    const { pos, wire } = this.target(ctx, p);
    this.lastTarget = wire;
    ctx.setPreview([this.makeInsert(pos)]);
    ctx.setDynText([wire ? 'On wire' : fmt(pos)]);
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.block) return;
    const block = lookupSymbol(this.block)!;
    const { pos, wire } = this.target(ctx, p);
    const prefix = tagPrefix(this.block);
    const hasTag = block.attributes.some((a) => a.tag === 'TAG1');
    const ref = nearestReference(ctx.doc, pos);
    const initTag = hasTag ? uniqueTag(ctx.doc, prefix, ref) : '';
    const initDesc = '';
    ctx.setPreview([]);

    const place = (tag: string, desc: string, mfg = '', cat = '') => {
      const attrs: Record<string, string> = {};
      if (hasTag) attrs.TAG1 = tag;
      if (block.attributes.some((a) => a.tag === 'DESC1')) attrs.DESC1 = desc;
      if (block.attributes.some((a) => a.tag === 'TERM01')) attrs.TERM01 = tag;
      if (mfg) attrs.MFG = mfg;
      if (cat) attrs.CAT = cat;
      const ins = this.makeInsert(pos, attrs);
      ctx.doc.transact((s) => {
        let entities = s.entities;
        if (wire) {
          // Break the wire over the symbol's actual horizontal extent (stubs included).
          const b = entityBounds(ins, ctx.doc.lookupBlock);
          const half = b ? Math.max(b.max.x - pos.x, pos.x - b.min.x) : 0.375;
          const left = b ? b.min.x : pos.x - 0.375;
          const right = b ? b.max.x : pos.x + 0.375;
          void half;
          const pieces = breakWire(wire, left, right);
          entities = entities.filter((e) => e.id !== wire.id).concat(pieces);
        }
        return { ...s, entities: [...entities, ins] };
      });
      ctx.log(`Inserted ${this.block}${tag ? ` as ${tag}` : ''}.`);
    };

    if (hasTag) {
      void ctx.ui.editComponent({ tag: initTag, desc: initDesc, block: this.block }).then((r) => {
        if (r) place(r.tag, r.desc, r.mfg, r.cat);
        ctx.finish();
      });
    } else {
      place('', '');
      ctx.finish();
    }
  }

  onText(_t: string, _ctx: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    void this.lastTarget;
    ctx.finish();
  }
}

/**
 * AEWIRENO: number every horizontal wire net. Nets are groups of collinear
 * wire pieces (a rung broken by components is one net). Like AutoCAD
 * Electrical, the number is the nearest ladder rung reference; additional
 * nets on the same reference get a letter suffix (100, 100A, 100B ...). When
 * no ladder references exist, numbers run sequentially from `start`.
 */
export function assignWireNumbers(doc: Drawing, start = 100): number {
  const wires = doc.entities.filter((e): e is LineEntity => isWire(e) && isHorizontal(e));
  if (wires.length === 0) return 0;
  const sorted = [...wires].sort((a, b) => b.a.y - a.a.y || Math.min(a.a.x, a.b.x) - Math.min(b.a.x, b.b.x));
  // Group into nets: same y and x-ranges that touch or are separated only by a component gap (< 1.2 in).
  const nets: LineEntity[][] = [];
  for (const w of sorted) {
    const last = nets[nets.length - 1];
    const wl = Math.min(w.a.x, w.b.x);
    if (last && Math.abs(last[0]!.a.y - w.a.y) < 1e-6) {
      const lastRight = Math.max(...last.map((x) => Math.max(x.a.x, x.b.x)));
      if (wl - lastRight < 1.2) {
        last.push(w);
        continue;
      }
    }
    nets.push([w]);
  }
  const refs = doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'MISC' && /^\d+$/.test(e.text));
  const used = new Map<string, number>();
  const texts: Entity[] = [];
  let seq = start;
  for (const net of nets) {
    const first = net[0]!;
    let label: string;
    const ref = refs.length ? nearestReference(doc, { x: first.a.x, y: first.a.y }) : null;
    if (ref) {
      const n = used.get(ref) ?? 0;
      used.set(ref, n + 1);
      label = n === 0 ? ref : `${ref}${String.fromCharCode(64 + n)}`;
    } else {
      label = String(seq);
      seq += 1;
    }
    const x = Math.min(first.a.x, first.b.x) + 0.15;
    texts.push({
      id: newId(),
      type: 'text',
      layer: 'WIRENO',
      color: 'ByLayer',
      position: { x, y: first.a.y + 0.05 },
      text: label,
      height: 0.125,
      rotation: 0,
      align: 'left',
    });
  }
  doc.transact((s) => ({
    ...s,
    entities: [...s.entities.filter((e) => !(e.type === 'text' && e.layer === 'WIRENO')), ...texts],
  }));
  return texts.length;
}
