/**
 * Panel layout tools: insert a footprint for a schematic component, add
 * item balloons and nameplates.
 */
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity } from '../core/entities';
import type { Tool, ToolContext } from './types';
import { footprintBlock, makeFootprint, makeBalloon, makeNameplate, nextItemNumber, itemNumberFor, BALLOON_BLOCK, NAMEPLATE_BLOCK, type SchematicListRow } from '../electrical/panel';
import { isFootprint, isComponent } from '../electrical/families';
import { descriptionOf } from '../electrical/attributes';
import { pickAt } from './electrical-wires';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

export function ensurePanelLayer(ctx: ToolContext): void {
  if (!ctx.doc.layer('PANEL')) ctx.doc.addLayer({ name: 'PANEL', color: 6, visible: true, locked: false, lineWeight: 0.35 });
}

/** AEFOOTPRINT: place a footprint for the chosen schematic component. */
export class FootprintTool implements Tool {
  readonly name = 'AEFOOTPRINT';
  private item = '';
  constructor(private row: SchematicListRow) {}
  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks([footprintBlock(this.row.family)]);
    ensurePanelLayer(ctx);
    this.item = itemNumberFor(ctx.doc.entities, this.row.tag) ?? String(nextItemNumber(ctx.doc.entities));
    ctx.prompt(`Specify footprint location for ${this.row.tag} (item ${this.item}):`);
  }
  private build(p: Point): InsertEntity {
    return makeFootprint(this.row, p, this.item);
  }
  onMove(p: Point, ctx: ToolContext): void {
    ctx.setPreview([this.build(p)]);
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    ctx.setPreview([]);
    // A re-inserted tag replaces its old footprint so the panel never lists a device twice.
    const old = ctx.doc.entities.filter((e) => isFootprint(e) && e.attributes.P_TAG1 === this.row.tag).map((e) => e.id);
    const ins = this.build(p);
    ctx.doc.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => !old.includes(e.id)), ins] }));
    ctx.log(`Footprint ${this.row.tag} (item ${this.item}) inserted.`);
    ctx.finish();
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** AEBALLOON: pick a footprint, then place its item balloon with a leader. */
export class BalloonTool implements Tool {
  readonly name = 'AEBALLOON';
  private target: InsertEntity | null = null;
  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks([BALLOON_BLOCK]);
    ensurePanelLayer(ctx);
    ctx.prompt('Select footprint for the balloon:');
  }
  private item(ctx: ToolContext): string {
    return this.target?.attributes.P_ITEM || String(nextItemNumber(ctx.doc.entities));
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (this.target) ctx.setPreview(makeBalloon(this.target, p, this.item(ctx), ctx.doc.lookupBlock));
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.target) {
      const t = pickAt(ctx.doc, p, ctx.aperture() * 2, (e): e is InsertEntity => isFootprint(e));
      if (!t) {
        ctx.log('Select a panel footprint.');
        return;
      }
      this.target = t;
      ctx.setTrackFrom(t.position);
      ctx.prompt('Specify balloon location:');
      return;
    }
    const item = this.item(ctx);
    const ents: Entity[] = makeBalloon(this.target, p, item, ctx.doc.lookupBlock);
    const updated = this.target.attributes.P_ITEM ? [] : [{ ...this.target, attributes: { ...this.target.attributes, P_ITEM: item } }];
    ctx.doc.transact((s) => ({ ...s, entities: [...s.entities.map((e) => updated.find((u) => u.id === e.id) ?? e), ...ents] }));
    ctx.log(`Balloon ${item} placed for ${this.target.attributes.P_TAG1 ?? ''}.`);
    ctx.finish();
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** AENAMEPLATE: pick a footprint or schematic component, then place a nameplate with its description. */
export class NameplateTool implements Tool {
  readonly name = 'AENAMEPLATE';
  private tag = '';
  private desc = '';
  private picked = false;
  constructor(private ask: (title: string, label: string, init: string) => Promise<string | null>) {}
  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks([NAMEPLATE_BLOCK]);
    ensurePanelLayer(ctx);
    ctx.prompt('Select footprint or component for the nameplate (Enter to type the text):');
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (this.picked) ctx.setPreview([makeNameplate(p, this.tag, this.desc)]);
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.picked) {
      const t = pickAt(ctx.doc, p, ctx.aperture() * 2, (e): e is InsertEntity => isFootprint(e) || isComponent(e));
      if (!t) {
        ctx.log('Select a footprint or component.');
        return;
      }
      this.tag = t.attributes.P_TAG1 ?? t.attributes.TAG1 ?? '';
      this.desc = isFootprint(t) ? [t.attributes.P_DESC1, t.attributes.P_DESC2].filter(Boolean).join(' ') : descriptionOf(t.attributes);
      this.picked = true;
      ctx.prompt(`Specify nameplate location for ${this.tag}:`);
      return;
    }
    ctx.doc.addEntities([makeNameplate(p, this.tag, this.desc)]);
    ctx.log(`Nameplate "${this.desc}" placed.`);
    ctx.finish();
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    if (this.picked) {
      ctx.finish();
      return;
    }
    void this.ask('Nameplate', 'Legend text', '').then((v) => {
      if (v === null) {
        ctx.finish();
        return;
      }
      this.desc = v.trim().toUpperCase();
      this.picked = true;
      ctx.prompt('Specify nameplate location:');
    });
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}
