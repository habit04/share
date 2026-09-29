/**
 * Panel layout tools: insert a footprint for a schematic component, add
 * item balloons and nameplates; panel hardware (DIN rail, wire duct,
 * enclosure, mounting-plate grid), footprint alignment on a rail and the
 * terminal strip footprint (registered by `registerPanelCommands`).
 */
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity, BlockDef } from '../core/entities';
import { explodeInsert } from '../core/entities';
import type { Editor } from '../app/editor';
import type { Tool, ToolContext } from './types';
import { footprintBlock, makeFootprint, makeBalloon, makeNameplate, nextItemNumber, itemNumberFor, BALLOON_BLOCK, NAMEPLATE_BLOCK, terminalStripTable, terminalStrips, terminalStripFootprintFor, footprintSize, type SchematicListRow, type TerminalRow } from '../electrical/panel';
import {
  RAIL_TYPES,
  DUCT_SIZES,
  ENCLOSURE_SIZES,
  railSpec,
  makeRail,
  makeDuct,
  makeEnclosure,
  makePlateGrid,
  makeTerminalStripFootprint,
  parseDuctSize,
  parseEnclosureSize,
  plateOf,
  railAxis,
  alignOnRail,
  railAt,
  isHardware,
  formatLength,
  panelHardwareRows,
  type RailType,
  type DoorHinge,
  type EnclosureSize,
} from '../electrical/panel-hardware';
import { scriptTool, pointOrKeyword, point, text, keyword, number, select, dflt, type Request, type Answer } from './script';
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

// ------------------------------------------------------------ panel hardware

/** Values remembered between runs (like AutoCAD's last-used defaults). */
const last = { rail: 'TS35' as RailType, railCat: '', railLength: 12, duct: '2x3', ductCat: '', ductLength: 12, enclosure: '24x20x8', hinge: 'LEFT' as DoorHinge, grid: 1, gap: 0 };

/** Add a generated block (replacing an older definition of the same name) and the insert in one undo step. */
function placeWithBlock(ctx: ToolContext, block: BlockDef, ins: InsertEntity, replace: string[] = []): void {
  ensurePanelLayer(ctx);
  ctx.doc.transact((s) => ({ ...s, blocks: { ...s.blocks, [block.name]: block }, entities: [...s.entities.filter((e) => !replace.includes(e.id)), ins] }));
}

/** Preview entities of an insert whose block is not in the drawing yet. */
function previewOf(block: BlockDef, ins: InsertEntity): Entity[] {
  return explodeInsert(ins, (n) => (n === block.name ? block : undefined));
}

/** Parse a rail type answer: TS35 / TS32 / TS15, or just 35 / 32 / 15. */
export function parseRailType(answer: string): RailType | null {
  const t = answer.trim().toUpperCase().replace(/^TS/, '');
  const hit = RAIL_TYPES.find((r) => r.type === `TS${t}`);
  return hit ? hit.type : null;
}

const ORTHO = (a: number): number => Math.round(a / (Math.PI / 2)) * (Math.PI / 2);

type Run = { start: Point; length: number; angle: number };

/**
 * Shared prompt sequence of rails and duct: start point (with the type / part options),
 * then an end point, or [Length] followed by a direction.
 */
function* linearRun(
  ctx: ToolContext,
  what: string,
  options: () => string,
  onKeyword: (k: string) => Generator<Request, void, Answer>,
  keywords: string[],
  build: (start: Point, length: number, angle: number) => Entity[],
  lastLength: number,
): Generator<Request, Run | null, Answer> {
  let start: Point | null = null;
  while (!start) {
    const r = yield* pointOrKeyword(`Specify ${what} start point or [${keywords.join('/')}] ${options()}:`, keywords);
    if (!r) return null;
    if ('point' in r) start = r.point;
    else if ('keyword' in r) yield* onKeyword(r.keyword);
    else ctx.log(`Invalid point or option keyword: ${r.text}`);
  }
  const s = start;
  for (;;) {
    const r = yield* pointOrKeyword('Specify end point or [Length]:', ['Length'], {
      trackFrom: s,
      preview: (c) => (Math.hypot(c.x - s.x, c.y - s.y) > 1e-6 ? build(s, Math.hypot(c.x - s.x, c.y - s.y), Math.atan2(c.y - s.y, c.x - s.x)) : []),
      dyn: (c) => [`${Math.hypot(c.x - s.x, c.y - s.y).toFixed(3)} in`],
    });
    if (!r) return null;
    if ('point' in r) {
      const length = Math.hypot(r.point.x - s.x, r.point.y - s.y);
      if (length < 0.5) {
        ctx.log('The run must be at least 0.5 in long.');
        continue;
      }
      return { start: s, length, angle: Math.atan2(r.point.y - s.y, r.point.x - s.x) };
    }
    if ('keyword' in r) {
      const n = yield* number(ctx, `Length ${dflt(lastLength)}:`, lastLength, { min: 0.5 });
      if (!n || !('value' in n)) return null;
      const length = n.value;
      const d = yield* pointOrKeyword('Specify direction or [Horizontal/Vertical] <Horizontal>:', ['Horizontal', 'Vertical'], {
        trackFrom: s,
        preview: (c) => build(s, length, ORTHO(Math.atan2(c.y - s.y, c.x - s.x))),
      });
      const angle = !d ? 0 : 'point' in d ? ORTHO(Math.atan2(d.point.y - s.y, d.point.x - s.x)) : 'keyword' in d && d.keyword === 'VERTICAL' ? Math.PI / 2 : 0;
      return { start: s, length, angle };
    }
    ctx.log(`Invalid point or option keyword: ${r.text}`);
  }
}

/** AEDINRAIL: DIN rail from a start point to an end point, or a start point, a length and a direction. */
export function dinRailTool(): Tool {
  return scriptTool('AEDINRAIL', function* (ctx) {
    const onKeyword = function* (k: string): Generator<Request, void, Answer> {
      if (k === 'TYPE') {
        const t = yield* text(`Rail type [TS35/TS32/TS15] <${last.rail}>:`, last.rail, false);
        const rt = t === null ? null : parseRailType(t);
        if (rt) last.rail = rt;
        else ctx.log('Rail types: TS35 (35 mm), TS32 (32 mm G-section), TS15 (15 mm miniature).');
      } else {
        const t = yield* text(`Part number <${last.railCat || 'none'}>:`, last.railCat);
        if (t !== null) last.railCat = t.trim().toUpperCase();
      }
    };
    const build = (s: Point, len: number, a: number) => {
      const r = makeRail(last.rail, s, len, a, last.railCat);
      return previewOf(r.block, r.insert);
    };
    const run = yield* linearRun(ctx, 'DIN rail', () => `<${last.rail}${last.railCat ? ` ${last.railCat}` : ''}>`, onKeyword, ['Type', 'Part'], build, last.railLength);
    if (!run) return;
    last.railLength = Math.round(run.length * 1000) / 1000;
    const { block, insert } = makeRail(last.rail, run.start, run.length, run.angle, last.railCat);
    placeWithBlock(ctx, block, insert);
    const spec = railSpec(last.rail);
    ctx.log(`DIN rail ${spec.type} (${spec.widthMm} mm wide), ${formatLength(run.length)}${last.railCat ? `, part ${last.railCat}` : ''}.`);
  });
}

/** AEWIREDUCT: wire duct run with a stock size (1x1 ... 4x4 in). */
export function wireDuctTool(): Tool {
  return scriptTool('AEWIREDUCT', function* (ctx) {
    const size = () => parseDuctSize(last.duct) ?? DUCT_SIZES[3]!;
    const onKeyword = function* (k: string): Generator<Request, void, Answer> {
      if (k === 'SIZE') {
        const t = yield* text(`Duct size W x H in [${DUCT_SIZES.map((d) => d.label).join('/')}] <${last.duct}>:`, last.duct, false);
        const d = t === null ? null : parseDuctSize(t);
        if (d) last.duct = d.label;
        else ctx.log(`Stock duct sizes: ${DUCT_SIZES.map((x) => x.label).join(', ')} (width x height, inches).`);
      } else {
        const t = yield* text(`Part number <${last.ductCat || 'none'}>:`, last.ductCat);
        if (t !== null) last.ductCat = t.trim().toUpperCase();
      }
    };
    const build = (s: Point, len: number, a: number) => {
      const r = makeDuct(size(), s, len, a, last.ductCat);
      return previewOf(r.block, r.insert);
    };
    const run = yield* linearRun(ctx, 'wire duct', () => `<${last.duct}${last.ductCat ? ` ${last.ductCat}` : ''}>`, onKeyword, ['Size', 'Part'], build, last.ductLength);
    if (!run) return;
    last.ductLength = Math.round(run.length * 1000) / 1000;
    const { block, insert } = makeDuct(size(), run.start, run.length, run.angle, last.ductCat);
    placeWithBlock(ctx, block, insert);
    ctx.log(`Wire duct ${size().width} x ${size().height} in, ${formatLength(run.length)}.`);
  });
}

/** AEPANEL: enclosure outline from the standard size list (or a custom size) with the door swing. */
export function enclosureTool(): Tool {
  return scriptTool('AEPANEL', function* (ctx) {
    let size: EnclosureSize | null = null;
    while (!size) {
      const t = yield* text(`Enclosure size H x W x D in [${ENCLOSURE_SIZES.map((e) => e.label).join('/')}/Custom] <${last.enclosure}>:`, last.enclosure, false);
      if (t === null) return;
      if (/^c(u(s(t(om?)?)?)?)?$/i.test(t.trim())) {
        const c = yield* text('Custom size H x W [x D] in:', null, false);
        if (c === null) return;
        size = parseEnclosureSize(c);
      } else size = ENCLOSURE_SIZES.find((e) => e.label === t.trim().toLowerCase()) ?? parseEnclosureSize(t);
      if (!size) ctx.log('Enter a size such as 24x20x8 (height x width x depth, inches) or Custom.');
    }
    last.enclosure = size.label;
    const hinge = yield* keyword(ctx, `Door hinge side [Left/Right/None] <${last.hinge.charAt(0) + last.hinge.slice(1).toLowerCase()}>:`, ['Left', 'Right', 'None'], last.hinge);
    if (!hinge) return;
    last.hinge = hinge as DoorHinge;
    const sz = size;
    const corner = yield* point(ctx, 'Specify lower-left corner of the enclosure:', {
      preview: (c) => {
        const r = makeEnclosure(sz, last.hinge, c);
        return previewOf(r.block, r.insert);
      },
    });
    if (!corner) return;
    const { block, insert } = makeEnclosure(sz, last.hinge, corner);
    placeWithBlock(ctx, block, insert);
    const plate = plateOf(sz);
    ctx.log(`Enclosure ${sz.height} x ${sz.width}${sz.depth ? ` x ${sz.depth}` : ''} in, hinge ${last.hinge.toLowerCase()}; mounting plate ${plate.width} x ${plate.height} in (AEPANELGRID Enclosure draws its layout grid).`);
  });
}

/** AEPANELGRID: mounting plate outline with a layout grid (two corners, or the plate of an enclosure). */
export function plateGridTool(): Tool {
  return scriptTool('AEPANELGRID', function* (ctx) {
    let corner: Point | null = null;
    let size: { width: number; height: number } | null = null;
    while (!corner) {
      const r = yield* pointOrKeyword(`Specify first corner of the mounting plate or [Spacing/Enclosure] <grid ${last.grid.toFixed(3)}>:`, ['Spacing', 'Enclosure']);
      if (!r) return;
      if ('point' in r) corner = r.point;
      else if ('keyword' in r && r.keyword === 'SPACING') {
        const n = yield* number(ctx, `Grid spacing ${dflt(last.grid)}:`, last.grid, { min: 0.125 });
        if (n && 'value' in n) last.grid = n.value;
      } else if ('keyword' in r) {
        const p = yield* point(ctx, 'Select the enclosure:');
        if (!p) return;
        const e = pickAt(ctx.doc, p, ctx.aperture() * 2, (x): x is InsertEntity => isHardware(x) && x.attributes.P_HW === 'ENCLOSURE');
        const encSize = e ? parseEnclosureSize(e.attributes.P_TYPE ?? '') : null;
        if (!e || !encSize) {
          ctx.log('No enclosure there (AEPANEL draws one).');
          continue;
        }
        const plate = plateOf(encSize);
        corner = { x: e.position.x + plate.offset.x, y: e.position.y + plate.offset.y };
        size = { width: plate.width, height: plate.height };
      } else ctx.log(`Invalid point or option keyword: ${r.text}`);
    }
    const c0 = corner;
    if (!size) {
      const c1 = yield* point(ctx, 'Specify opposite corner:', {
        trackFrom: c0,
        preview: (c) => {
          const w = Math.abs(c.x - c0.x);
          const h = Math.abs(c.y - c0.y);
          if (w < 0.1 || h < 0.1) return [];
          const r = makePlateGrid({ x: Math.min(c.x, c0.x), y: Math.min(c.y, c0.y) }, w, h, last.grid);
          return previewOf(r.block, r.insert);
        },
      });
      if (!c1) return;
      size = { width: Math.abs(c1.x - c0.x), height: Math.abs(c1.y - c0.y) };
      corner = { x: Math.min(c1.x, c0.x), y: Math.min(c1.y, c0.y) };
      if (size.width < 0.5 || size.height < 0.5) {
        ctx.log('The plate must be at least 0.5 in each way.');
        return;
      }
    }
    const { block, insert } = makePlateGrid(corner, size.width, size.height, last.grid);
    placeWithBlock(ctx, block, insert);
    ctx.log(`Mounting plate ${size.width.toFixed(3)} x ${size.height.toFixed(3)} in with a ${last.grid.toFixed(3)} in grid.`);
  });
}

/**
 * AEFOOTPRINTALIGN: move the selected footprints onto a DIN rail: centred on the rail, turned
 * with it, in their current order from the rail start with a gap (or spread evenly).
 */
export function footprintAlignTool(): Tool {
  return scriptTool('AEFOOTPRINTALIGN', function* (ctx) {
    const ids = yield* select(ctx, 'Select footprints to align:');
    const fps = ids.map((id) => ctx.doc.entity(id)).filter((e): e is InsertEntity => !!e && isFootprint(e));
    if (fps.length === 0) {
      ctx.log('No footprints selected.');
      return;
    }
    let rail: InsertEntity | null = null;
    while (!rail) {
      const p = yield* point(ctx, 'Select the DIN rail:');
      if (!p) return;
      rail = railAt(ctx.doc.entities, p, ctx.aperture() * 2);
      if (!rail) ctx.log('Select a DIN rail (AEDINRAIL).');
    }
    const rot = rail.rotation;
    const n = yield* number(ctx, `Gap between footprints or [Even] ${dflt(last.gap)}:`, last.gap, { keywords: ['Even'], allowZero: true });
    if (!n) return;
    const gap: number | 'even' = 'keyword' in n ? 'even' : n.value;
    if (gap !== 'even') last.gap = gap;
    const res = alignOnRail(
      fps.map((f) => ({ id: f.id, position: f.position, size: footprintSize(f).width })),
      railAxis(rail),
      gap,
    );
    const moved = fps.map((f) => ({ ...f, position: res.positions.get(f.id)!, rotation: rot }));
    ctx.doc.replaceEntities(moved);
    ctx.log(`${moved.length} footprint(s) aligned on the rail, gap ${res.gap.toFixed(3)} in.${res.overflow > 0 ? ` They run ${res.overflow.toFixed(3)} in past the usable rail length; use a longer rail or a second one.` : ''}`);
  });
}

/**
 * AETERMFOOTPRINT: place the panel footprint of a terminal strip (its terminals and numbers
 * from the terminal strip table). A strip placed again replaces its old footprint and keeps
 * its item number. `jumpers` supplies bridged terminal pairs per strip when that data exists.
 */
export function terminalStripTool(rows: readonly TerminalRow[], jumpers?: (strip: string) => Array<[string, string]> | undefined): Tool {
  return scriptTool('AETERMFOOTPRINT', function* (ctx) {
    const strips = terminalStrips(rows);
    if (strips.length === 0) {
      ctx.log('No terminals found (in this drawing or the project).');
      return;
    }
    let strip: string | null = null;
    while (!strip) {
      const t = yield* text(`Terminal strip [${strips.join('/')}] <${strips[0]}>:`, strips[0]!, false);
      if (t === null) return;
      strip = strips.find((s) => s.toUpperCase() === t.trim().toUpperCase()) ?? null;
      if (!strip) ctx.log(`No strip ${t}; strips: ${strips.join(', ')}.`);
    }
    const s = strip;
    const block = terminalStripFootprintFor(rows, s, jumpers?.(s));
    const old = ctx.doc.entities.filter((e): e is InsertEntity => isFootprint(e) && e.block === block.name);
    const item = old[0]?.attributes.P_ITEM || String(nextItemNumber(ctx.doc.entities));
    const count = (block.attributes.find((a) => a.tag === 'P_TERMS')?.default ?? '').split(',').filter(Boolean).length;
    const at = yield* point(ctx, `Specify location of terminal strip ${s} (${count} terminals, item ${item}):`, {
      preview: (c) => previewOf(block, makeTerminalStripFootprint(block, c, item)),
    });
    if (!at) return;
    placeWithBlock(ctx, block, makeTerminalStripFootprint(block, at, item), old.map((e) => e.id));
    ctx.log(`Terminal strip ${s}: ${count} terminal(s), item ${item}${old.length ? ' (old footprint replaced)' : ''}.`);
  });
}

/** Log the panel hardware bill of material (see `panelHardwareRows`); returns the number of rows. */
export function logPanelHardware(log: (t: string) => void, entities: readonly Entity[]): number {
  const rows = panelHardwareRows({ entities });
  if (rows.length === 0) {
    log('No panel hardware in this drawing (AEDINRAIL, AEWIREDUCT, AEPANEL, AEPANELGRID).');
    return 0;
  }
  log('Panel hardware:');
  for (const r of rows) log(`  ${r.label.padEnd(15)} ${r.type.padEnd(10)} qty ${String(r.qty).padStart(3)}${r.length ? `  total ${formatLength(r.length)}` : ''}${r.cat ? `  ${r.mfg ? `${r.mfg} ` : ''}${r.cat}` : ''}`);
  return rows.length;
}

/**
 * Panel layout commands of this module: DIN rail, wire duct, enclosure, mounting-plate grid,
 * footprint alignment, terminal strip footprint and the hardware list. The Editor calls it
 * once next to the other command registrations.
 */
export function registerPanelCommands(editor: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run, startsTool: true });
  reg('AEDINRAIL', ['DINRAIL'], 'Panel: draw a DIN rail (TS35 / TS32 / TS15) from a start and end point or a length', (ed) => ed.startTool(dinRailTool()));
  reg('AEWIREDUCT', ['WIREDUCT', 'DUCT'], 'Panel: draw a wire duct run (1x1 ... 4x4 in) with its cover lines', (ed) => ed.startTool(wireDuctTool()));
  reg('AEPANEL', ['AEENCLOSURE', 'ENCLOSURE'], 'Panel: draw an enclosure outline (standard or custom size) with mounting plate and door swing', (ed) => ed.startTool(enclosureTool()));
  reg('AEPANELGRID', ['PLATEGRID', 'AEMOUNTGRID'], 'Panel: draw a mounting plate with a layout grid', (ed) => ed.startTool(plateGridTool()));
  reg('AEFOOTPRINTALIGN', ['FOOTPRINTALIGN'], 'Panel: align selected footprints on a DIN rail with an even spacing', (ed) => ed.startTool(footprintAlignTool()));
  reg('AETERMFOOTPRINT', ['TERMFOOTPRINT', 'AETERMSTRIPFP'], 'Panel: insert the footprint of a terminal strip (terminals numbered from the terminal strip table)', (ed) => {
    // Project drawings are read through the electrical commands module (loaded on demand to keep the import graph acyclic).
    void import('../app/commands-electrical').then(async ({ projectDocuments }) => {
      const docs = await projectDocuments(ed);
      const rows = docs.flatMap((d) => terminalStripTable(d.doc.entities, d.doc.lookupBlock));
      ed.startTool(terminalStripTool(rows));
    });
  });
  editor.register({ name: 'AEPANELHW', aliases: ['PANELHARDWARE'], description: 'Panel: list the DIN rail, duct, enclosure and plate hardware with total lengths', run: (ed) => void logPanelHardware((t) => ed.log(t), ed.doc.entities) });
}
