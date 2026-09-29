import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, InsertEntity, TextEntity, BlockDef } from '../core/entities';
import { newId, insertTransform } from '../core/entities';
import type { Drawing } from '../core/document';
import { LineTool } from './draw';
import type { Tool, ToolContext, LadderSettings, SymbolPick } from './types';
import { tagPrefix, registerTagPrefixes, WIRE_DOT } from '../electrical/symbols';
import { LIBRARY_BLOCKS, findLibrarySymbol } from '../electrical/library';
import { isWire, isHorizontal, wireTeeAt, findWireAt, breakWire, nearestReference, wireDot, hasDotAt, ladderMetrics } from '../electrical/ladder';
import { assignWireNumbers as assignWireNumbersImpl, breakForInsert, connectsVertically, findOrientedWireAt, type WireNumberOptions } from '../electrical/wires';
import { readWdSettings, drawingUnitScale, type WdSettings } from '../electrical/wdm';
import { nextTag, usedTags, usedTagsOfFamily } from '../electrical/tags';
import { pinAttributes, DATA_ATTRIBUTES, isVerticalBlock, verticalVariant, verticalVariantName } from '../electrical/attributes';
import { isChildBlock, isCoilBlock, registerSymbolRole } from '../electrical/families';
import { parentCandidates, childAttributes } from '../electrical/xref';
import type { ElectricalUi, ComponentDialogInit } from '../electrical/ui';

// Pure helpers moved to src/electrical/ladder.ts; re-exported for existing callers and tests.
export { isWire, isHorizontal, wireTeeAt, findWireAt, breakWire, nearestReference, wireDot };

export const lookupSymbol = (name: string) => findLibrarySymbol(name);

/** Normalise an icon-menu result: a bare block name means the horizontal orientation. */
export function symbolPick(v: SymbolPick | string | null | undefined): SymbolPick | null {
  if (!v) return null;
  return typeof v === 'string' ? { name: v, orientation: 'H' } : v;
}

/**
 * Resolve the block to insert for an icon-menu choice. The drawing's own
 * definition wins over the library (like AutoCAD, and like componentDialogInit).
 * For the Vertical orientation of a horizontal symbol: a vertical twin in the
 * library or the drawing (VPB11_NO for HPB11_NO, or NAME_V) is used; otherwise
 * the twin is built by rotating the symbol -90 degrees (`verticalVariant`) and
 * defined in the drawing under the twin's name, so TAG1 / DESC stay readable
 * and the wire connections sit on top / bottom.
 */
export function resolveSymbolPick(doc: Drawing, pick: SymbolPick): { def: BlockDef; note: string | null } | null {
  const lookup = (n: string) => doc.lookupBlock(n) ?? lookupSymbol(n);
  const def = lookup(pick.name);
  if (!def) return null;
  if (pick.orientation !== 'V' || isVerticalBlock(def)) return { def, note: null };
  const twinName = verticalVariantName(def.name);
  const twin = lookup(twinName) ?? (def.name.startsWith('H') ? lookup(`${def.name}_V`) : undefined);
  if (twin) return { def: twin, note: `Vertical: ${twin.name} inserted for ${def.name}.` };
  // The generated twin tags and cross-references like its horizontal source.
  registerTagPrefixes([[new RegExp(`^${twinName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), tagPrefix(def.name)]]);
  registerSymbolRole(twinName, isCoilBlock(def.name) ? 'coil' : isChildBlock(def.name) ? 'child' : 'none');
  return { def: verticalVariant(def, twinName), note: `Vertical: no ${twinName} in the library; ${def.name} rotated -90 degrees as block ${twinName} (tag and description kept readable).` };
}

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

/**
 * Ladder dialog defaults for a drawing: width and rung spacing from its WD_M
 * settings (millimetre values in metric drawings, see docs/METRIC.md).
 */
export function ladderDefaultsFor(doc: Drawing): LadderSettings {
  const wd = readWdSettings(doc);
  return { ...DEFAULT_LADDER, width: wd.ladderWidth, spacing: wd.rungSpacing };
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
    const unitScale = drawingUnitScale(ctx.doc);
    const dotAt = (pt: Point) => {
      if (hasDotAt(ctx.doc, pt) || adds.some((d) => d.type === 'insert' && g.dist(d.position, pt) < 1e-6)) return;
      adds.push(wireDot(pt, unitScale));
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
  private settings: LadderSettings | null = null;
  private ready = false;
  private unitScale = 1;

  start(ctx: ToolContext): void {
    this.ready = false;
    this.unitScale = drawingUnitScale(ctx.doc);
    this.settings ??= ladderDefaultsFor(ctx.doc);
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
    const s = this.settings ?? DEFAULT_LADDER;
    const m = ladderMetrics(this.unitScale);
    const out: Entity[] = [];
    const height = s.spacing * (s.rungs - 1);
    const left = origin.x;
    const right = origin.x + s.width;
    const top = origin.y;
    const bottom = origin.y - height;
    const rail = (x: number): Entity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y: top + s.spacing * 0.5 }, b: { x, y: bottom - s.spacing * 0.5 } });
    out.push(rail(left), rail(right));
    if (s.threePhase) {
      out.push(rail(left - m.phaseSpacing), rail(left - 2 * m.phaseSpacing));
    }
    for (let i = 0; i < s.rungs; i += 1) {
      const y = top - i * s.spacing;
      const ref = String(s.firstReference + i * s.referenceStep);
      const t: TextEntity = {
        id: newId(),
        layer: 'MISC',
        color: 'ByLayer',
        type: 'text',
        position: { x: left - m.referenceOffset - (s.threePhase ? 2 * m.phaseSpacing : 0), y: y - m.referenceDrop },
        text: ref,
        height: m.referenceHeight,
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
    const s = this.settings ?? DEFAULT_LADDER;
    ctx.log(`Ladder inserted: ${s.rungs} rungs, width ${s.width}.`);
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
  /** Library symbols are drawn in inches: x 25.4 in metric drawings (WD_M UNITS / $INSUNITS). */
  private unitScale = 1;

  constructor(
    private preset?: string,
    private eui?: () => ElectricalUi,
    private settings?: () => WdSettings,
    /** Parent device a child contact is linked to (Insert Child Contact flow). */
    private parentId?: string,
  ) {}

  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks(LIBRARY_BLOCKS);
    this.unitScale = drawingUnitScale(ctx.doc);
    ctx.prompt('Select a symbol from the icon menu...');
    const choose: Promise<SymbolPick | string | null> = this.preset ? Promise.resolve(this.preset) : ctx.ui.pickSymbol();
    void choose.then((picked) => {
      const pick = symbolPick(picked);
      const r = pick ? resolveSymbolPick(ctx.doc, pick) : null;
      if (!pick || !r) {
        if (pick) ctx.log(`Unknown symbol ${pick.name}.`);
        ctx.finish();
        return;
      }
      // User-library symbols (and generated vertical twins) are not part of LIBRARY_BLOCKS: define the block in this drawing.
      ctx.doc.ensureBlocks([r.def]);
      this.block = r.def.name;
      if (r.note) ctx.log(r.note);
      ctx.prompt(`Specify insertion point for ${r.def.name}:`);
    });
  }

  /** The drawing's block definition (it wins over the library copy, like componentDialogInit). */
  private definition(ctx: ToolContext): BlockDef | undefined {
    return this.block ? ctx.doc.lookupBlock(this.block) ?? lookupSymbol(this.block) : undefined;
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
      scale: this.unitScale,
      attributes: attrs,
    };
  }

  private target(ctx: ToolContext, p: Point): { pos: Point; wire: LineEntity | null } {
    // A symbol that connects at its top / bottom snaps to a vertical wire; the usual inline symbol to a horizontal one.
    if (connectsVertically(this.makeInsert(p), ctx.doc.lookupBlock)) {
      const v = findOrientedWireAt(ctx.doc.entities, p, ctx.aperture() * 2.5, 'vertical');
      if (v) return { pos: { x: v.a.x, y: p.y }, wire: v };
      return { pos: p, wire: null };
    }
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
    const block = this.definition(ctx);
    if (!block) return;
    ctx.doc.ensureBlocks([block]);
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
