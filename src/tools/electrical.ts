import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, InsertEntity, TextEntity } from '../core/entities';
import { newId, insertTransform } from '../core/entities';
import type { Drawing } from '../core/document';
import { LineTool } from './draw';
import type { Tool, ToolContext, LadderSettings } from './types';
import { findSymbol, tagPrefix, ALL_SYMBOLS, WIRE_DOT } from '../electrical/symbols';
import { IEC_SYMBOLS } from '../electrical/iec';
import { isWire, isHorizontal, wireTeeAt, findWireAt, breakWire, nearestReference, wireDot, hasDotAt } from '../electrical/ladder';
import { assignWireNumbers as assignWireNumbersImpl, breakForInsert, type WireNumberOptions } from '../electrical/wires';
import { readWdSettings, type WdSettings } from '../electrical/wdm';
import { nextTag, usedTags, usedTagsOfFamily } from '../electrical/tags';
import { pinAttributes, DATA_ATTRIBUTES } from '../electrical/attributes';
import { isChildBlock } from '../electrical/families';
import { parentCandidates, childAttributes } from '../electrical/xref';
import type { ElectricalUi, ComponentDialogInit } from '../electrical/ui';

// Pure helpers moved to src/electrical/ladder.ts; re-exported for existing callers and tests.
export { isWire, isHorizontal, wireTeeAt, findWireAt, breakWire, nearestReference, wireDot };

export const lookupSymbol = (name: string) => findSymbol(name) ?? IEC_SYMBOLS.find((s) => s.name === name);

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
  private startDot = false;

  override onPoint(p: Point, ctx: ToolContext): void {
    // Wires must be orthogonal: force the second point onto the axis with the larger delta.
    const last = this.points[this.points.length - 1];
    let q = p;
    if (last) {
      const dx = Math.abs(p.x - last.x);
      const dy = Math.abs(p.y - last.y);
      q = dx >= dy ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
      if (g.eq(last, q, 1e-9)) return;
    }
    const tol = ctx.aperture() * 0.5;
    const adds: Entity[] = [];
    const dotAt = (pt: Point) => {
      if (hasDotAt(ctx.doc, pt) || adds.some((d) => d.type === 'insert' && g.dist(d.position, pt) < 1e-6)) return;
      adds.push(wireDot(pt));
    };
    if (last) adds.push(this.makeSegment(ctx, last, q));
    // A wire that starts or ends in the middle of another wire is a tee.
    if (wireTeeAt(ctx.doc, q, tol)) dotAt(q);
    // A wire that passes over the end of an existing wire is a tee as well.
    if (last) {
      for (const e of ctx.doc.entities) {
        if (!isWire(e)) continue;
        for (const end of [e.a, e.b]) {
          if (g.dist(end, last) > tol && g.dist(end, q) > tol && g.distToSegment(end, last, q) < tol) dotAt(end);
        }
      }
    }
    // Segment and its junction dots are one undo step, so [Undo] removes both.
    if (adds.length) ctx.doc.addEntities(adds);
    if (!last) this.startDot = adds.length > 0;
    this.points.push(q);
    ctx.setTrackFrom(q);
    ctx.prompt(this.points.length >= 2 ? 'Specify wire end or [Close/Undo]:' : 'Specify wire end or [Undo]:');
    this.onMove(this.cursor ?? q, ctx);
  }
  override onText(text: string, ctx: ToolContext): void {
    const t = text.trim().toUpperCase();
    if ((t === 'U' || t === 'UNDO') && this.points.length === 1 && this.startDot) {
      ctx.doc.undo(); // the dot placed at the start point
      this.startDot = false;
    }
    super.onText(text, ctx);
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
    ctx.prompt('Insert Ladder...');
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

/** Next free tag for a prefix using the plain "%F%N" rule (kept for callers that predate WD_M settings). */
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

/** Build the Insert/Edit Component dialog state for a block placed at a point (or an existing insert). */
export function componentDialogInit(doc: Drawing, block: string, at: Point, existing?: InsertEntity, settings: WdSettings = readWdSettings(doc)): ComponentDialogInit {
  const def = doc.lookupBlock(block) ?? lookupSymbol(block);
  const family = tagPrefix(block);
  const attrs: Record<string, string> = {};
  if (def) for (const a of def.attributes) attrs[a.tag] = existing?.attributes[a.tag] ?? (existing ? '' : a.default);
  if (existing) for (const [k, v] of Object.entries(existing.attributes)) attrs[k] = v;
  const child = isChildBlock(block);
  const used = usedTagsOfFamily(doc, family);
  const suggested = child ? '' : existing?.attributes.TAG1 || nextTag(usedTags(doc), family, nearestReference(doc, at), settings);
  if (!existing && !child && attrs.TAG1 !== undefined) attrs.TAG1 = suggested;
  if (!existing && settings.iecInstallation && !attrs.INST) attrs.INST = settings.iecInstallation;
  if (!existing && settings.iecLocation && !attrs.LOC) attrs.LOC = settings.iecLocation;
  const pins = def ? pinAttributes(def).map((a) => ({ tag: a.tag, label: a.prompt, value: attrs[a.tag] ?? a.default })) : [];
  for (const k of DATA_ATTRIBUTES) if (attrs[k] === undefined) attrs[k] = '';
  return {
    block,
    blockDescription: def?.description ?? '',
    family,
    isNew: !existing,
    attrs,
    pins,
    used,
    nextTag: suggested,
    parents: child ? parentCandidates(doc) : undefined,
    isChild: child,
  };
}

/** Apply dialog results: parent data for children, drop empty optional attributes. */
export function componentAttributes(result: Record<string, string>, parent?: InsertEntity): Record<string, string> {
  const attrs: Record<string, string> = { ...result };
  if (parent) Object.assign(attrs, childAttributes(parent), result.DESC1 ? { DESC1: result.DESC1 } : {});
  for (const k of Object.keys(attrs)) {
    if (attrs[k] === '' && !['TAG1', 'DESC1', 'TERM01'].includes(k)) delete attrs[k];
  }
  return attrs;
}

/** AECOMPONENT: pick a symbol from the icon menu, place it, trim the wire, edit tag/description. */
export class ComponentTool implements Tool {
  readonly name = 'AECOMPONENT';
  private block: string | null = null;
  private lastTarget: LineEntity | null = null;

  constructor(
    private preset?: string,
    private eui?: () => ElectricalUi,
    private settings?: () => WdSettings,
    /** Parent device a child contact is linked to (Insert Child Contact flow). */
    private parentId?: string,
  ) {}

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
    const { pos } = this.target(ctx, p);
    const hasTag = block.attributes.some((a) => a.tag === 'TAG1');
    const isTerminal = block.attributes.some((a) => a.tag === 'TERM01');
    ctx.setPreview([]);

    const place = (attrs: Record<string, string>) => {
      const ins = this.makeInsert(pos, attrs);
      ctx.doc.transact((s) => ({ ...s, entities: breakForInsert([...s.entities, ins], ins, ctx.doc.lookupBlock) }));
      ctx.log(`Inserted ${this.block}${attrs.TAG1 ? ` as ${attrs.TAG1}` : ''}.`);
    };

    if (!hasTag && !isTerminal) {
      place({});
      ctx.finish();
      return;
    }
    const settings = this.settings?.() ?? readWdSettings(ctx.doc);
    const init = componentDialogInit(ctx.doc, this.block, pos, undefined, settings);
    const presetParent = this.parentId ? ctx.doc.entities.find((e): e is InsertEntity => e.id === this.parentId) : undefined;
    if (presetParent) Object.assign(init.attrs, childAttributes(presetParent));
    if (isTerminal && !hasTag) {
      // Terminals: number them with the plain text prompt (next free number of the strip).
      const nums = ctx.doc.entities.filter((e) => e.type === 'insert' && e.attributes.TERM01).map((e) => parseInt((e as InsertEntity).attributes.TERM01!, 10)).filter(Number.isFinite);
      const next = String((nums.length ? Math.max(...nums) : 0) + 1);
      void ctx.ui.textInput('Terminal', 'Terminal number', next).then((v) => {
        if (v !== null) place({ ...init.attrs, TERM01: v.trim() });
        ctx.finish();
      });
      return;
    }
    const eui = this.eui?.();
    if (eui) {
      void eui.editComponent(init).then((r) => {
        if (r) {
          const pid = r.parentId ?? this.parentId;
          const parent = pid ? ctx.doc.entities.find((e): e is InsertEntity => e.id === pid) : undefined;
          place(componentAttributes(r.attrs, parent));
        }
        ctx.finish();
      });
      return;
    }
    void ctx.ui.editComponent({ tag: init.attrs.TAG1 ?? '', desc: '', block: this.block }).then((r) => {
      if (r) place(componentAttributes({ ...init.attrs, TAG1: r.tag, DESC1: r.desc, MFG: r.mfg, CAT: r.cat }));
      ctx.finish();
    });
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
 * AEWIRENO: number every horizontal wire net (see electrical/wires.ts). The
 * numeric form keeps the old `assignWireNumbers(doc, start)` signature.
 */
export function assignWireNumbers(doc: Drawing, opts: WireNumberOptions | number = {}): number {
  return assignWireNumbersImpl(doc, opts);
}

/** World position of a pin attribute of an insert. */
export function pinPosition(ins: InsertEntity, tag: string, lookup: Drawing['lookupBlock']): Point | null {
  const block = lookup(ins.block);
  const a = block?.attributes.find((x) => x.tag === tag);
  if (!block || !a) return null;
  return insertTransform(ins, block)(a.position);
}
