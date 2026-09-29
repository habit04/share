/**
 * Interactive wire / component editing tools (AutoCAD Electrical style):
 * trim wire, wire gap / loop, scoot, align, multiple bus, 3-phase component
 * insertion, wire number editing, toggle NO/NC, swap block, place entities.
 */
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity, LineEntity, TextEntity, BlockLookup } from '../core/entities';
import { distanceToEntity, newId } from '../core/entities';
import type { Drawing } from '../core/document';
import type { Tool, ToolContext } from './types';
import { findAnyWireAt, findWireAt } from '../electrical/ladder';
import {
  trimWireAt,
  insertWireGaps,
  scootComponent,
  scootWireNumber,
  alignComponents,
  buildBus,
  threePhaseWires,
  insertThreePole,
  applyWireEdit,
  applyWireNumberEdit,
  findReplaceWireNumbers,
  copyWireNumber,
  wireNumberLeader,
  wireNumberState,
  isWireNumber,
  liftFromWires,
  breakForInsert,
  type BusSettings,
  type WireEdit,
} from '../electrical/wires';
import { toggleVariant, isComponent, isChild, isTerminal } from '../electrical/families';
import { CABLE_BLOCK, CABLE_LAYER, assignCable, nextCableTag, isCableMarker, addJumper, removeJumpers, jumperIds, withTerminalUpdates, type CableAssignment } from '../electrical/cables';
import { LIBRARY_BLOCKS } from '../electrical/library';
import { readWdSettings, drawingUnitScale } from '../electrical/wdm';
import { isFixedTag, TAG_FIXED_ATTRIBUTE } from '../electrical/tags';
import { withInsertAttributes } from '../electrical/attributes';
import type { ElectricalUi } from '../electrical/ui';
import { componentDialogInit, componentAttributes, lookupSymbol, symbolPick, resolveSymbolPick } from './electrical';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

/** Nearest entity satisfying a predicate within the pick aperture. */
export function pickAt<T extends Entity>(doc: Drawing, p: Point, tol: number, pred: (e: Entity) => e is T): T | null {
  let best: T | null = null;
  let bestD = tol;
  for (const e of doc.entities) {
    if (!pred(e)) continue;
    const d = distanceToEntity(p, e, doc.lookupBlock);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

const isInsertComponent = (e: Entity): e is InsertEntity => isComponent(e);

abstract class PickTool implements Tool {
  abstract readonly name: string;
  abstract start(ctx: ToolContext): void;
  abstract onPoint(p: Point, ctx: ToolContext): void;
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

/** AETRIMWIRE: remove the picked wire segment between its breaks. */
export class TrimWireTool extends PickTool {
  readonly name = 'AETRIMWIRE';
  private count = 0;
  start(ctx: ToolContext): void {
    ctx.prompt('Select wire segment to trim (Enter to finish):');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const wire = findAnyWireAt(ctx.doc, p, ctx.aperture() * 2);
    if (!wire) {
      ctx.log('No wire at that point.');
      return;
    }
    applyWireEdit(ctx.doc, trimWireAt(ctx.doc.entities, wire, p));
    this.count += 1;
    ctx.prompt(`${this.count} segment(s) trimmed. Select wire segment to trim (Enter to finish):`);
  }
}

/** AEWIREGAP / AEWIRELOOP: gap (or loop) the picked wire at every crossing. */
export class WireGapTool extends PickTool {
  readonly name: string;
  constructor(private style: 'gap' | 'loop') {
    super();
    this.name = style === 'gap' ? 'AEWIREGAP' : 'AEWIRELOOP';
  }
  start(ctx: ToolContext): void {
    ctx.prompt(`Select the wire that jumps over the crossing (${this.style}):`);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const wire = findAnyWireAt(ctx.doc, p, ctx.aperture() * 2);
    if (!wire) {
      ctx.log('No wire at that point.');
      return;
    }
    const edit = insertWireGaps(ctx.doc.entities, wire, this.style);
    if (edit.remove.length === 0) {
      ctx.log('That wire does not cross another wire.');
      return;
    }
    applyWireEdit(ctx.doc, edit);
    ctx.log(`Wire ${this.style}s inserted at ${edit.add.filter((e) => e.type === 'arc').length || edit.add.length - 1} crossing(s).`);
    ctx.finish();
  }
}

/** AESCOOT: slide a component or wire number along its wire. */
export class ScootTool extends PickTool {
  readonly name = 'AESCOOT';
  private target: InsertEntity | TextEntity | null = null;
  start(ctx: ToolContext): void {
    const sel = [...ctx.selection].map((id) => ctx.doc.entity(id)).find((e): e is InsertEntity | TextEntity => !!e && (isInsertComponent(e) || isWireNumber(e)));
    if (sel) {
      this.target = sel;
      ctx.setTrackFrom(sel.position);
      ctx.prompt('Specify new position along the wire:');
    } else ctx.prompt('Select component or wire number to scoot:');
  }
  private preview(ctx: ToolContext, p: Point): Entity[] {
    if (!this.target) return [];
    if (this.target.type === 'insert') return [scootComponent(ctx.doc.entities, this.target, ctx.doc.lookupBlock, p.x).moved];
    return [scootWireNumber(ctx.doc.entities, this.target, p.x)];
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (this.target) ctx.setGhost(this.preview(ctx, p));
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.target) {
      const t = pickAt(ctx.doc, p, ctx.aperture() * 2, (e): e is InsertEntity | TextEntity => isInsertComponent(e) || isWireNumber(e));
      if (!t) {
        ctx.log('Select a component or a wire number.');
        return;
      }
      this.target = t;
      ctx.selection = new Set([t.id]);
      ctx.setTrackFrom(t.position);
      ctx.prompt('Specify new position along the wire:');
      return;
    }
    if (this.target.type === 'insert') {
      const r = scootComponent(ctx.doc.entities, this.target, ctx.doc.lookupBlock, p.x);
      applyWireEdit(ctx.doc, r, [r.moved]);
      ctx.log(`${this.target.attributes.TAG1 ?? this.target.block} scooted to x = ${r.moved.position.x.toFixed(3)}.`);
    } else {
      ctx.doc.replaceEntities([scootWireNumber(ctx.doc.entities, this.target, p.x)]);
    }
    ctx.setGhost([]);
    ctx.finish();
  }
}

/** AEALIGN: align selected components with a reference component (vertical = same x, horizontal = same y). */
export class AlignTool extends PickTool {
  readonly name = 'AEALIGN';
  private targets: InsertEntity[] = [];
  constructor(private mode: 'vertical' | 'horizontal') {
    super();
  }
  start(ctx: ToolContext): void {
    const collect = (ids: string[]) => {
      this.targets = ids.map((id) => ctx.doc.entity(id)).filter((e): e is InsertEntity => !!e && isInsertComponent(e));
      if (this.targets.length === 0) {
        ctx.log('No components selected.');
        ctx.finish();
        return;
      }
      ctx.prompt(`Select the reference component to align ${this.targets.length} component(s) ${this.mode}ly with:`);
    };
    if (ctx.selection.size > 0) collect([...ctx.selection]);
    else ctx.requestSelection('Select components to align:', collect);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const ref = pickAt(ctx.doc, p, ctx.aperture() * 2, isInsertComponent);
    if (!ref) {
      ctx.log('Select a component.');
      return;
    }
    const edit = alignComponents(ctx.doc.entities, this.targets, ref, this.mode, ctx.doc.lookupBlock);
    applyWireEdit(ctx.doc, edit);
    ctx.log(`${this.targets.filter((t) => t.id !== ref.id).length} component(s) aligned with ${ref.attributes.TAG1 ?? ref.block}.`);
    ctx.selection = new Set();
    ctx.finish();
  }
}

/** AEMULTIBUS: N parallel wires between two points. */
export class MultiBusTool extends PickTool {
  readonly name = 'AEMULTIBUS';
  private settings: BusSettings | null = null;
  private start_: Point | null = null;
  constructor(
    private ask: (init: BusSettings) => Promise<BusSettings | null>,
    private init: BusSettings,
  ) {
    super();
  }
  start(ctx: ToolContext): void {
    void this.ask(this.init).then((s) => {
      if (!s) {
        ctx.finish();
        return;
      }
      this.settings = s;
      ctx.prompt('Specify bus start point:');
    });
  }
  private end(p: Point): Point {
    const a = this.start_!;
    return this.settings!.direction === 'horizontal' ? { x: p.x, y: a.y } : { x: a.x, y: p.y };
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (this.settings && this.start_) ctx.setPreview(buildBus(this.start_, this.end(p), this.settings));
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.settings) return;
    if (!this.start_) {
      this.start_ = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify bus end point:');
      return;
    }
    const wires = buildBus(this.start_, this.end(p), this.settings);
    if (!ctx.doc.layer(this.settings.layer)) ctx.doc.addLayer({ name: this.settings.layer, color: 1, visible: true, locked: false, lineWeight: 0.35 });
    ctx.doc.addEntities(wires);
    ctx.log(`${wires.length}-wire bus inserted.`);
    ctx.finish();
  }
}

/** AECOMPONENT3: insert a single-pole symbol on three phase wires with a shared tag. */
export class ThreePhaseComponentTool extends PickTool {
  readonly name = 'AECOMPONENT3';
  private block: string | null = null;
  constructor(
    private preset: string | undefined,
    private eui: () => ElectricalUi,
  ) {
    super();
  }
  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks(LIBRARY_BLOCKS);
    const choose = this.preset ? Promise.resolve(this.preset) : ctx.ui.pickSymbol();
    void choose.then((picked) => {
      // Poles sit in horizontal phase wires: the orientation radio is ignored here.
      const pick = symbolPick(picked);
      const def = pick ? ctx.doc.lookupBlock(pick.name) ?? lookupSymbol(pick.name) : undefined;
      if (!def) {
        ctx.finish();
        return;
      }
      ctx.doc.ensureBlocks([def]);
      this.block = def.name;
      ctx.prompt(`Pick the top phase wire where ${def.name} goes (3 wires, evenly spaced):`);
    });
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.block) return;
    const k = drawingUnitScale(ctx.doc);
    const wires = threePhaseWires(ctx.doc.entities, p, 0.3 * k);
    ctx.setPreview(wires ? wires.map((w) => ({ id: newId(), type: 'insert', layer: 'SYMS', color: 'ByLayer', block: this.block!, position: { x: p.x, y: w.a.y }, rotation: 0, scale: k, attributes: {} }) as Entity) : []);
    ctx.setDynText([wires ? '3 phase' : 'no 3-wire bus here']);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.block) return;
    const k = drawingUnitScale(ctx.doc);
    const wires = threePhaseWires(ctx.doc.entities, p, 0.3 * k);
    if (!wires) {
      ctx.log('Pick a point on a bus of three horizontal wires.');
      return;
    }
    ctx.setPreview([]);
    const init = componentDialogInit(ctx.doc, this.block, { x: p.x, y: wires[0]!.a.y });
    void this.eui().editComponent(init).then((r) => {
      if (r) {
        const attrs = componentAttributes(r.attrs);
        const edit = insertThreePole(ctx.doc.entities, this.block!, p.x, wires, attrs, ctx.doc.lookupBlock, k);
        if (!ctx.doc.layer('LINK')) ctx.doc.addLayer({ name: 'LINK', color: 8, visible: true, locked: false, lineWeight: 0.18 });
        applyWireEdit(ctx.doc, edit);
        ctx.log(`3-pole ${attrs.TAG1 ?? this.block} inserted.`);
      }
      ctx.finish();
    });
  }
}

/** AEEDITWIRENO: edit a wire number (label, fixed, position) with find / replace. */
export class WireNumberEditTool extends PickTool {
  readonly name = 'AEEDITWIRENO';
  constructor(private eui: () => ElectricalUi) {
    super();
  }
  start(ctx: ToolContext): void {
    const sel = [...ctx.selection].map((id) => ctx.doc.entity(id)).find((e): e is TextEntity => !!e && isWireNumber(e));
    if (sel) this.edit(sel, ctx);
    else ctx.prompt('Select wire number to edit:');
  }
  private edit(t: TextEntity, ctx: ToolContext): void {
    const state = wireNumberState(ctx.doc.entities, t);
    const all = [...new Set(ctx.doc.entities.filter(isWireNumber).map((e) => e.text))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    void this.eui()
      .wireNumberEdit({ ...state, all })
      .then((r) => {
        if (r) {
          const edit: WireEdit = applyWireNumberEdit(ctx.doc.entities, t, r.edit);
          let replaced: TextEntity[] = [];
          if (r.findReplace?.find) replaced = findReplaceWireNumbers([...ctx.doc.entities.filter((e) => e.id !== t.id), ...edit.add], r.findReplace.find, r.findReplace.replace);
          const rm = new Set(edit.remove);
          const rep = new Map(replaced.map((e) => [e.id, e]));
          ctx.doc.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => !rm.has(e.id)), ...edit.add].map((e) => rep.get(e.id) ?? e) }));
          ctx.log(`Wire number ${r.edit.label}${r.edit.fixed ? ' (fixed)' : ''} updated${replaced.length ? `; ${replaced.length} replaced` : ''}.`);
        }
        ctx.finish();
      });
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const t = pickAt(ctx.doc, p, ctx.aperture() * 2, isWireNumber);
    if (!t) {
      ctx.log('Select a wire number.');
      return;
    }
    this.edit(t, ctx);
  }
}

/** AECOPYWIRENO: copy a wire number to another wire (as a fixed number). */
export class CopyWireNumberTool extends PickTool {
  readonly name = 'AECOPYWIRENO';
  private source: TextEntity | null = null;
  start(ctx: ToolContext): void {
    ctx.prompt('Select wire number to copy:');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.source) {
      const t = pickAt(ctx.doc, p, ctx.aperture() * 2, isWireNumber);
      if (!t) {
        ctx.log('Select a wire number.');
        return;
      }
      this.source = t;
      ctx.prompt(`Select wire to receive number ${t.text}:`);
      return;
    }
    const wire = findWireAt(ctx.doc, p, ctx.aperture() * 2);
    if (!wire) {
      ctx.log('Select a horizontal wire.');
      return;
    }
    const copy = copyWireNumber(ctx.doc.entities, this.source, wire);
    if (copy) {
      if (!ctx.doc.layer('WIREFIXED')) ctx.doc.addLayer({ name: 'WIREFIXED', color: 3, visible: true, locked: false, lineWeight: 0.25 });
      ctx.doc.addEntities([copy]);
      ctx.log(`Wire number ${copy.text} copied.`);
    }
    ctx.finish();
  }
}

/** AEWIRENOLEADER: move a wire number away from the wire with a leader. */
export class WireNumberLeaderTool extends PickTool {
  readonly name = 'AEWIRENOLEADER';
  private source: TextEntity | null = null;
  start(ctx: ToolContext): void {
    ctx.prompt('Select wire number to move with a leader:');
  }
  override onMove(p: Point, ctx: ToolContext): void {
    if (this.source) ctx.setPreview(wireNumberLeader(ctx.doc.entities, this.source, p).add);
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.source) {
      const t = pickAt(ctx.doc, p, ctx.aperture() * 2, isWireNumber);
      if (!t) {
        ctx.log('Select a wire number.');
        return;
      }
      this.source = t;
      ctx.setTrackFrom(t.position);
      ctx.prompt('Specify leader end point:');
      return;
    }
    applyWireEdit(ctx.doc, wireNumberLeader(ctx.doc.entities, this.source, p));
    ctx.finish();
  }
}

/** AETOGGLENC: switch a contact / switch between its NO and NC variants in place. */
export class ToggleNcTool extends PickTool {
  readonly name = 'AETOGGLENC';
  start(ctx: ToolContext): void {
    const sel = [...ctx.selection].map((id) => ctx.doc.entity(id)).filter((e): e is InsertEntity => !!e && e.type === 'insert');
    if (sel.length) {
      this.toggle(sel, ctx);
      ctx.finish();
    } else ctx.prompt('Select contact to toggle NO / NC:');
  }
  private toggle(list: InsertEntity[], ctx: ToolContext): void {
    const exists = (n: string) => !!ctx.doc.lookupBlock(n) || !!lookupSymbol(n);
    const out: InsertEntity[] = [];
    for (const e of list) {
      const v = toggleVariant(e.block, exists);
      if (!v) {
        const m = /^(.*)_(NO|NC)$/.exec(e.block);
        if (m) {
          const twin = `${m[1]}_${m[2] === 'NO' ? 'NC' : 'NO'}`;
          ctx.log(`${e.block} has no NO/NC variant: create ${twin} with Symbol Builder > Create NO/NC twin (AESYMBUILDER ${e.block}).`);
        } else ctx.log(`${e.block} has no NO/NC variant (paired symbols share a stem and end in _NO / _NC).`);
        continue;
      }
      const def = lookupSymbol(v);
      if (def) ctx.doc.ensureBlocks([def]);
      // swap the default pin numbers along with the variant
      const attrs = { ...e.attributes };
      const nc = v.endsWith('_NC');
      if (attrs.X1TERM01 === (nc ? '13' : '11')) attrs.X1TERM01 = nc ? '11' : '13';
      if (attrs.X4TERM02 === (nc ? '14' : '12')) attrs.X4TERM02 = nc ? '12' : '14';
      out.push({ ...e, block: v, attributes: attrs });
    }
    if (out.length) {
      ctx.doc.replaceEntities(out);
      ctx.log(`${out.length} contact(s) toggled.`);
    }
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const e = pickAt(ctx.doc, p, ctx.aperture() * 2, (x): x is InsertEntity => x.type === 'insert');
    if (!e) {
      ctx.log('Select a contact.');
      return;
    }
    this.toggle([e], ctx);
    ctx.finish();
  }
}

/** AESWAP: replace a component's block with another symbol, keeping tag, data and position. */
export class SwapBlockTool extends PickTool {
  readonly name = 'AESWAP';
  start(ctx: ToolContext): void {
    const sel = [...ctx.selection].map((id) => ctx.doc.entity(id)).find((e): e is InsertEntity => !!e && isInsertComponent(e));
    if (sel) this.swap(sel, ctx);
    else ctx.prompt('Select component to swap:');
  }
  private swap(e: InsertEntity, ctx: ToolContext): void {
    void ctx.ui.pickSymbol().then((picked) => {
      const pick = symbolPick(picked);
      const r = pick ? resolveSymbolPick(ctx.doc, pick) : null;
      if (!r) {
        ctx.finish();
        return;
      }
      const def = r.def;
      if (r.note) ctx.log(r.note);
      ctx.doc.ensureBlocks([def]);
      const replaced: InsertEntity = { ...e, block: def.name };
      // keep the wires broken correctly for the new symbol width
      const k = drawingUnitScale(ctx.doc);
      const lifted = liftFromWires(ctx.doc.entities, e, ctx.doc.lookupBlock, k).filter((x) => x.id !== e.id);
      const after = breakForInsert([...lifted, replaced], replaced, ctx.doc.lookupBlock, k);
      ctx.doc.transact((s) => ({ ...s, entities: after }));
      ctx.log(`${e.attributes.TAG1 ?? e.block} swapped to ${def.name}.`);
      ctx.finish();
    });
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const e = pickAt(ctx.doc, p, ctx.aperture() * 2, isInsertComponent);
    if (!e) {
      ctx.log('Select a component.');
      return;
    }
    this.swap(e, ctx);
  }
}

/** AEEDITCOMPONENT: open the Insert/Edit Component dialog for an existing component. */
export class EditComponentTool extends PickTool {
  readonly name = 'AEEDITCOMPONENT';
  constructor(private eui: () => ElectricalUi) {
    super();
  }
  start(ctx: ToolContext): void {
    const sel = [...ctx.selection].map((id) => ctx.doc.entity(id)).find((e): e is InsertEntity => !!e && isInsertComponent(e));
    if (sel) this.edit(sel, ctx);
    else ctx.prompt('Select component to edit:');
  }
  private edit(e: InsertEntity, ctx: ToolContext): void {
    const init = componentDialogInit(ctx.doc, e.block, e.position, e, readWdSettings(ctx.doc));
    void this.eui()
      .editComponent(init)
      .then((r) => {
        if (r) {
          const parent = r.parentId ? ctx.doc.entities.find((x): x is InsertEntity => x.id === r.parentId) : undefined;
          const attrs = componentAttributes(r.attrs, parent);
          // Fixed tag checkbox: the same TAGFIXED attribute AEFIXTAG toggles (RETAG keeps fixed tags).
          const fix = r.fixedTag;
          if (fix === false) delete attrs[TAG_FIXED_ATTRIBUTE];
          const oldTag = e.attributes.TAG1;
          const updates: InsertEntity[] = [{ ...e, attributes: attrs }];
          // Retagging a parent carries its children along.
          if (oldTag && attrs.TAG1 && oldTag !== attrs.TAG1 && !isChild(e)) {
            for (const c of ctx.doc.entities) if (isChild(c) && c.attributes.TAG1 === oldTag) updates.push({ ...c, attributes: { ...c.attributes, TAG1: attrs.TAG1 } });
          }
          const byId = new Map(updates.map((u) => [u.id, u]));
          ctx.doc.transact((s) => {
            const next = { ...s, entities: s.entities.map((x) => byId.get(x.id) ?? x) };
            // withInsertAttributes also gives the block its TAGFIXED definition so the flag survives DXF.
            return fix ? withInsertAttributes(next, new Map([[e.id, { [TAG_FIXED_ATTRIBUTE]: '1' }]])) : next;
          });
          const fixNote = fix !== undefined && fix !== isFixedTag(e) ? (fix ? ', tag fixed' : ', tag released') : '';
          ctx.log(`${attrs.TAG1 ?? attrs.TERM01 ?? e.block} updated${updates.length > 1 ? ` (${updates.length - 1} child contact(s) retagged)` : ''}${fixNote}.`);
        }
        ctx.finish();
      });
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const e = pickAt(ctx.doc, p, ctx.aperture() * 2, isInsertComponent);
    if (!e) {
      ctx.log('Select a component.');
      return;
    }
    this.edit(e, ctx);
  }
}

/** Generic "place these entities at a point" tool (report tables, circuits, footprints). */
export class PlaceTool extends PickTool {
  readonly name: string;
  constructor(
    name: string,
    private build: (origin: Point, doc: Drawing) => Entity[],
    private prompt: string,
    private done?: (origin: Point, ctx: ToolContext) => void,
  ) {
    super();
    this.name = name;
  }
  start(ctx: ToolContext): void {
    ctx.prompt(this.prompt);
  }
  override onMove(p: Point, ctx: ToolContext): void {
    ctx.setPreview(this.build(p, ctx.doc));
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    ctx.setPreview([]);
    ctx.doc.addEntities(this.build(p, ctx.doc));
    this.done?.(p, ctx);
    ctx.finish();
  }
}

// ------------------------------------------------------------ cables / jumpers

/**
 * AECABLE: pick the wires of a cable (Enter when done), then the cable
 * dialog assigns them conductors and places the cable markers.
 */
export class CableTool extends PickTool {
  readonly name = 'AECABLE';
  private wires: LineEntity[] = [];
  constructor(private ask: (wires: number, init: CableAssignment, existing: string[]) => Promise<CableAssignment | null>) {
    super();
  }
  start(ctx: ToolContext): void {
    this.wires = [];
    ctx.prompt('Select wires for the cable in conductor order (Enter when done):');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const w = findAnyWireAt(ctx.doc, p, ctx.aperture() * 2);
    if (!w) {
      ctx.log('No wire at that point.');
      return;
    }
    if (this.wires.some((x) => x.id === w.id)) {
      ctx.log('Wire already picked.');
      return;
    }
    this.wires.push(w);
    ctx.setPreview(this.wires.map((x) => ({ ...x, id: `cab-${x.id}`, color: 2 })));
    ctx.prompt(`${this.wires.length} wire(s) picked. Select next wire (Enter when done):`);
  }
  override onEnter(ctx: ToolContext): void {
    ctx.setPreview([]);
    if (this.wires.length === 0) {
      ctx.finish();
      return;
    }
    const existing = [...new Set(ctx.doc.entities.filter(isCableMarker).map((m) => m.attributes.CABLENO ?? '').filter(Boolean))].sort();
    const init: CableAssignment = { cable: nextCableTag(ctx.doc.entities), type: '', scheme: 'numbers', first: 1 };
    const wires = this.wires;
    void this.ask(wires.length, init, existing).then((a) => {
      if (!a) {
        ctx.finish();
        return;
      }
      ctx.doc.ensureBlocks([CABLE_BLOCK]);
      if (!ctx.doc.layer(CABLE_LAYER)) ctx.doc.addLayer({ name: CABLE_LAYER, color: 6, visible: true, locked: false, lineWeight: 0.25 });
      const r = assignCable(ctx.doc.entities, ctx.doc.lookupBlock, wires, a);
      ctx.doc.replaceWith(r.remove, r.add);
      ctx.log(`Cable ${a.cable}: ${r.add.length} conductor(s) ${r.add.map((m) => m.attributes.CONDUCTOR).join(', ')}.`);
      ctx.finish();
    });
  }
}

const isTerminalInsert = (e: Entity): e is InsertEntity => isTerminal(e);

/** AEJUMPER: pick two terminals of a strip; both get the jumper id in their JUMPER attribute. */
export class JumperTool extends PickTool {
  readonly name = 'AEJUMPER';
  private first: InsertEntity | null = null;
  start(ctx: ToolContext): void {
    this.first = null;
    ctx.prompt('Select first terminal for the jumper:');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const t = pickAt(ctx.doc, p, ctx.aperture() * 3, isTerminalInsert);
    if (!t) {
      ctx.log('No terminal at that point.');
      return;
    }
    if (!this.first) {
      this.first = t;
      ctx.selection = new Set([t.id]);
      ctx.prompt(`Select second terminal on strip ${t.attributes.TAGSTRIP || 'TB1'} (jumper from ${t.attributes.TERM01 ?? '?'}):`);
      return;
    }
    const first = this.first;
    const r = addJumper(ctx.doc.entities, first, t);
    if ('error' in r) {
      ctx.log(r.error);
      return;
    }
    ctx.doc.transact((s) => withTerminalUpdates(s, r.replace));
    ctx.log(`Jumper ${r.id}: ${first.attributes.TAGSTRIP || 'TB1'} terminal ${first.attributes.TERM01 ?? '?'} to ${t.attributes.TERM01 ?? '?'}.`);
    ctx.selection = new Set();
    this.first = null;
    ctx.prompt('Select first terminal for the next jumper (Enter to finish):');
  }
}

/** AEJUMPERDEL: pick a terminal; its jumpers are removed from it and from the partner terminals. */
export class RemoveJumperTool extends PickTool {
  readonly name = 'AEJUMPERDEL';
  start(ctx: ToolContext): void {
    ctx.prompt('Select terminal to remove its jumpers from (Enter to finish):');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    const t = pickAt(ctx.doc, p, ctx.aperture() * 3, isTerminalInsert);
    if (!t) {
      ctx.log('No terminal at that point.');
      return;
    }
    const rep = removeJumpers(ctx.doc.entities, t);
    if (rep.length === 0) {
      ctx.log(`Terminal ${t.attributes.TERM01 ?? '?'} has no jumpers.`);
      return;
    }
    ctx.doc.replaceEntities(rep);
    ctx.log(`${rep.length} terminal(s) updated; jumper(s) ${jumperIds(t).join(', ')} removed.`);
  }
}

export type { BlockLookup, LineEntity };
