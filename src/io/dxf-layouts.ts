/**
 * DXF paper space (Track E): layouts, their paper-space entities, VIEWPORT entities and the
 * LAYOUT objects of the ACAD_LAYOUT dictionary. io/dxf.ts calls in here at a few points:
 *
 *   writing: planLayouts (handles) -> header vars -> BLOCK_RECORD rows -> *Paper_SpaceN blocks
 *            -> the active layout's paper space at the end of ENTITIES -> ACAD_LAYOUT + LAYOUTs
 *   reading: BLOCK_RECORD / LAYER handles -> *Paper_Space* blocks -> ENTITIES split by group 67
 *            -> LAYOUT objects -> buildLayouts
 *
 * Paper coordinates: JCad keeps the sheet's lower-left corner at 0,0. AutoCAD puts paper-space
 * 0,0 at the plot origin, i.e. the lower-left corner of the printable area plus the plot offset
 * (groups 46/47). The writer stores offset = -margin so both agree; the reader shifts
 * AutoCAD's coordinates by margin + offset.
 */
import type { Entity } from '../core/entities';
import { translateEntity } from '../core/entities';
import type { Point } from '../core/geometry';
import {
  layoutsOf,
  mediaName,
  paperFromMediaName,
  paperFromSize,
  sheetSize,
  unitsOfHost,
  defaultLayout,
  newViewportId,
  formatScale,
  type Layout,
  type LayoutHost,
  type LayoutViewport,
  type LayoutMargins,
  type PaperUnits,
  type PlotStyleMode,
} from '../core/layouts';

export interface DxfSink {
  pair(code: number, value: string | number): void;
  nextHandle(): string;
}

interface Pair {
  code: number;
  value: string;
}
interface Obj {
  kind: string;
  groups: Pair[];
}

const MM = 25.4;
const toMm = (v: number, u: PaperUnits): number => (u === 'mm' ? v : v * MM);
const fromMm = (v: number, u: PaperUnits): number => (u === 'mm' ? v : v / MM);

// ---------------------------------------------------------------- writing

export interface LayoutRecord {
  layout: Layout;
  /** BLOCK_RECORD handle (*Paper_Space for the first layout, *Paper_SpaceN for the others). */
  blockRecord: string;
  blockName: string;
  /** LAYOUT object handle. */
  handle: string;
}

export interface LayoutPlan {
  records: LayoutRecord[];
  modelLayout: string;
  dictionary: string;
  /** Every paper-space entity (for the writer's dimension / image / table pre-pass). */
  entities: Entity[];
  /** Block-record owners whose entities carry group 67 = 1. */
  paperOwners: Set<string>;
}

/** Allocate handles for the layouts of a drawing (the first layout owns *Paper_Space). */
export function planLayouts(state: LayoutHost, w: DxfSink, paperSpaceRecord: string): LayoutPlan {
  const layouts = layoutsOf(state);
  const records: LayoutRecord[] = layouts.map((layout, i) => ({
    layout,
    blockRecord: i === 0 ? paperSpaceRecord : w.nextHandle(),
    blockName: i === 0 ? '*Paper_Space' : `*Paper_Space${i - 1}`,
    handle: w.nextHandle(),
  }));
  const plan: LayoutPlan = {
    records,
    modelLayout: w.nextHandle(),
    dictionary: w.nextHandle(),
    entities: layouts.flatMap((l) => [...l.entities]),
    paperOwners: new Set(records.map((r) => r.blockRecord)),
  };
  return plan;
}

/** Header variables: $CANNOSCALE / $ANNOALLVISIBLE (AutoCAD 2008+ names; older readers skip them). */
export function writeLayoutHeader(hv: (name: string, code: number, value: string | number) => void, state: { header?: { cannoscale?: string; annoAllVisible?: boolean } }): void {
  hv('$CANNOSCALE', 2, state.header?.cannoscale ?? '1:1');
  hv('$ANNOALLVISIBLE', 70, state.header?.annoAllVisible === false ? 0 : 1);
}

/** Extra BLOCK_RECORD rows for *Paper_Space0.. (the caller writes *Model_Space / *Paper_Space). */
export function extraBlockRecords(plan: LayoutPlan): Array<{ handle: string; name: string; layout: string }> {
  return plan.records.slice(1).map((r) => ({ handle: r.blockRecord, name: r.blockName, layout: r.handle }));
}

/** LAYOUT handle for a block-record handle (group 340 of the BLOCK_RECORD). */
export function layoutHandleOf(plan: LayoutPlan, blockRecord: string, modelRecord: string): string | undefined {
  if (blockRecord === modelRecord) return plan.modelLayout;
  return plan.records.find((r) => r.blockRecord === blockRecord)?.handle;
}

function writeViewport(w: DxfSink, owner: string, v: { center: Point; width: number; height: number; viewCenter: Point; viewHeight: number; layer: string; status: number; id: number; flags: number; frozen: string[] }): string {
  const h = w.nextHandle();
  w.pair(0, 'VIEWPORT');
  w.pair(5, h);
  w.pair(330, owner);
  w.pair(100, 'AcDbEntity');
  w.pair(67, 1);
  w.pair(8, v.layer);
  w.pair(100, 'AcDbViewport');
  w.pair(10, v.center.x);
  w.pair(20, v.center.y);
  w.pair(30, 0);
  w.pair(40, v.width);
  w.pair(41, v.height);
  w.pair(68, v.status);
  w.pair(69, v.id);
  w.pair(12, v.viewCenter.x);
  w.pair(22, v.viewCenter.y);
  w.pair(13, 0);
  w.pair(23, 0);
  w.pair(14, 0.5);
  w.pair(24, 0.5);
  w.pair(15, 0.5);
  w.pair(25, 0.5);
  w.pair(16, 0);
  w.pair(26, 0);
  w.pair(36, 1);
  w.pair(17, 0);
  w.pair(27, 0);
  w.pair(37, 0);
  w.pair(42, 50);
  w.pair(43, 0);
  w.pair(44, 0);
  w.pair(45, v.viewHeight);
  w.pair(50, 0);
  w.pair(51, 0);
  w.pair(72, 1000);
  for (const f of v.frozen) w.pair(331, f);
  w.pair(90, v.flags);
  w.pair(1, '');
  w.pair(281, 0);
  w.pair(71, 1);
  w.pair(74, 0);
  w.pair(110, 0);
  w.pair(120, 0);
  w.pair(130, 0);
  w.pair(111, 1);
  w.pair(121, 0);
  w.pair(131, 0);
  w.pair(112, 0);
  w.pair(122, 1);
  w.pair(132, 0);
  w.pair(79, 0);
  w.pair(146, 0);
  return h;
}

/** VIEWPORT status flags: 32768 always, 16384 display locked, 131072 off. */
export const VP_LOCKED = 16384;
export const VP_OFF = 131072;

/**
 * Paper-space content of one layout: the overall paper viewport (id 1), the floating
 * viewports (id 2..) and the paper entities. `writeEntity(e, owner)` is the DXF writer's own.
 */
export function writeLayoutContent(w: DxfSink, rec: LayoutRecord, writeEntity: (e: Entity, owner: string) => void, layerHandles: ReadonlyMap<string, string>): void {
  const lay = rec.layout;
  const sheet = sheetSize(lay);
  writeViewport(w, rec.blockRecord, {
    center: { x: sheet.width / 2, y: sheet.height / 2 },
    width: sheet.width * 1.05,
    height: sheet.height * 1.05,
    viewCenter: { x: sheet.width / 2, y: sheet.height / 2 },
    viewHeight: sheet.height * 1.05,
    layer: '0',
    status: 1,
    id: 1,
    flags: 32768 | 32,
    frozen: [],
  });
  lay.viewports.forEach((v, i) => {
    const frozen = (v.frozenLayers ?? []).map((n) => layerHandles.get(n)).filter((h): h is string => !!h);
    writeViewport(w, rec.blockRecord, {
      center: v.center,
      width: v.width,
      height: v.height,
      viewCenter: v.view.center,
      viewHeight: v.height / v.view.scale,
      layer: v.layer,
      status: v.on ? i + 2 : 0,
      id: i + 2,
      flags: 32768 | 32 | (v.view.locked ? VP_LOCKED : 0) | (v.on ? 0 : VP_OFF),
      frozen,
    });
  });
  for (const e of lay.entities) writeEntity(e, rec.blockRecord);
}

const STYLE_SHEETS: Record<PlotStyleMode, string> = {
  monochrome: 'monochrome.ctb',
  grayscale: 'grayscale.ctb',
  color: 'acad.ctb',
  screening: 'Screening 50%.ctb',
};

function writePlotSettings(w: DxfSink, lay: Layout | null, model: boolean): void {
  const units: PaperUnits = lay?.paper.units ?? 'in';
  const paper = lay?.paper;
  const portraitW = paper ? Math.min(paper.width, paper.height) : 8.5;
  const portraitH = paper ? Math.max(paper.width, paper.height) : 11;
  const m: LayoutMargins = lay?.margins ?? { left: 0.25, bottom: 0.25, right: 0.25, top: 0.25 };
  const landscape = paper ? paper.orientation === 'landscape' : true;
  w.pair(100, 'AcDbPlotSettings');
  w.pair(1, '');
  w.pair(2, 'none_device');
  w.pair(4, paper ? mediaName(paper) : 'Letter_(8.50_x_11.00_Inches)');
  w.pair(6, '');
  w.pair(40, toMm(m.left, units));
  w.pair(41, toMm(m.bottom, units));
  w.pair(42, toMm(m.right, units));
  w.pair(43, toMm(m.top, units));
  w.pair(44, toMm(portraitW, units));
  w.pair(45, toMm(portraitH, units));
  // Plot offset: paper 0,0 is the sheet corner here, so the origin sits -margin from the printable corner.
  w.pair(46, model ? 0 : -toMm(m.left, units));
  w.pair(47, model ? 0 : -toMm(m.bottom, units));
  w.pair(48, 0);
  w.pair(49, 0);
  w.pair(140, 0);
  w.pair(141, 0);
  const k: [number, number] = lay && lay.plotScale !== 'fit' ? scaleParts(lay.plotScale) : [1, 1];
  w.pair(142, k[0]);
  w.pair(143, k[1]);
  const style = lay?.plotStyle ?? 'monochrome';
  let flags = 2 | 16 | 512 | 4096 | (model ? 1024 : 0);
  if (lay?.plotLineweights !== false) flags |= 128;
  if (lay?.usePlotStyles !== false) flags |= 32;
  w.pair(70, flags);
  w.pair(72, units === 'mm' ? 1 : 0);
  w.pair(73, landscape ? 1 : 0);
  w.pair(74, model ? 0 : 5);
  w.pair(7, STYLE_SHEETS[style]);
  w.pair(75, lay?.plotScale === 'fit' ? 0 : 16);
  w.pair(147, k[0] / k[1]);
  w.pair(148, 0);
  w.pair(149, 0);
}

function scaleParts(s: string): [number, number] {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? [Number(m[1]) || 1, Number(m[2]) || 1] : [1, 1];
}

/** ACAD_LAYOUT dictionary and its LAYOUT objects (root dictionary entry: 3 ACAD_LAYOUT / 350 plan.dictionary). */
export function writeLayoutObjects(w: DxfSink, plan: LayoutPlan, modelRecord: string, rootDictionary: string): void {
  w.pair(0, 'DICTIONARY');
  w.pair(5, plan.dictionary);
  w.pair(330, rootDictionary);
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  for (const r of plan.records) {
    w.pair(3, r.layout.name);
    w.pair(350, r.handle);
  }
  w.pair(3, 'Model');
  w.pair(350, plan.modelLayout);
  const layoutObject = (handle: string, name: string, tab: number, lay: Layout | null, record: string) => {
    w.pair(0, 'LAYOUT');
    w.pair(5, handle);
    w.pair(102, '{ACAD_REACTORS');
    w.pair(330, plan.dictionary);
    w.pair(102, '}');
    w.pair(330, plan.dictionary);
    writePlotSettings(w, lay, !lay);
    w.pair(100, 'AcDbLayout');
    w.pair(1, name);
    w.pair(70, 1);
    w.pair(71, tab);
    const s = lay ? sheetSize(lay) : { width: 12, height: 9 };
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(11, s.width);
    w.pair(21, s.height);
    w.pair(12, 0);
    w.pair(22, 0);
    w.pair(32, 0);
    w.pair(14, 0);
    w.pair(24, 0);
    w.pair(34, 0);
    w.pair(15, s.width);
    w.pair(25, s.height);
    w.pair(35, 0);
    w.pair(146, 0);
    w.pair(13, 0);
    w.pair(23, 0);
    w.pair(33, 0);
    w.pair(16, 1);
    w.pair(26, 0);
    w.pair(36, 0);
    w.pair(17, 0);
    w.pair(27, 1);
    w.pair(37, 0);
    w.pair(76, 0);
    w.pair(330, record);
  };
  plan.records.forEach((r, i) => layoutObject(r.handle, r.layout.name, i + 1, r.layout, r.blockRecord));
  layoutObject(plan.modelLayout, 'Model', 0, null, modelRecord);
}

// ---------------------------------------------------------------- reading

const num = (o: Obj, code: number, dflt = 0): number => {
  const p = o.groups.find((x) => x.code === code);
  const v = p ? parseFloat(p.value) : NaN;
  return Number.isFinite(v) ? v : dflt;
};
const str = (o: Obj, code: number, dflt = ''): string => o.groups.find((x) => x.code === code)?.value ?? dflt;
const after = (o: Obj, subclass: string): Obj => {
  const i = o.groups.findIndex((x) => x.code === 100 && x.value === subclass);
  return { kind: o.kind, groups: i >= 0 ? o.groups.slice(i + 1) : o.groups };
};
const before = (o: Obj, subclass: string): Obj => {
  const i = o.groups.findIndex((x) => x.code === 100 && x.value === subclass);
  return { kind: o.kind, groups: i >= 0 ? o.groups.slice(0, i) : o.groups };
};

/** Collects paper-space data while io/dxf.ts walks the sections, then builds the layouts. */
export class LayoutReader {
  private recordNames = new Map<string, string>();
  private layerNames = new Map<string, string>();
  private blocks = new Map<string, Obj[]>();
  private activePaper: Obj[] = [];
  private layoutObjs: Obj[] = [];

  /** TABLES: BLOCK_RECORD names and LAYER handles (VIEWPORT 331 frozen layers). */
  scanTables(objs: readonly Obj[]): void {
    for (const o of objs) {
      const h = str(o, 5).toUpperCase();
      if (o.kind === 'BLOCK_RECORD' && h) this.recordNames.set(h, str(o, 2));
      else if (o.kind === 'LAYER' && h) this.layerNames.set(h, str(o, 2));
    }
  }

  /** BLOCKS: a *Model_Space / *Paper_Space* block and its content. */
  layoutBlock(name: string, inner: readonly Obj[]): void {
    if (/^\*PAPER_SPACE/i.test(name)) this.blocks.set(name.toUpperCase(), [...inner]);
  }

  /** ENTITIES: keep model space, remember the paper-space objects (group 67 = 1, with their ATTRIB / VERTEX / SEQEND). */
  splitEntities<T extends Obj>(objs: readonly T[]): T[] {
    const model: T[] = [];
    let paper = false;
    for (const o of objs) {
      const follower = o.kind === 'ATTRIB' || o.kind === 'VERTEX' || o.kind === 'SEQEND';
      if (!follower) paper = num(o, 67) === 1;
      if (paper) this.activePaper.push(o);
      else model.push(o);
    }
    return model;
  }

  /** OBJECTS: LAYOUT objects. */
  scanObjects(objs: readonly Obj[]): void {
    for (const o of objs) if (o.kind === 'LAYOUT') this.layoutObjs.push(o);
  }

  /** Build the layouts; `readEntities` is the DXF reader's entity parser. Undefined = only an untouched Layout1. */
  build(readEntities: (objs: Obj[]) => Entity[], host: LayoutHost): Layout[] | undefined {
    const units = unitsOfHost(host);
    const out: Array<{ layout: Layout; tab: number }> = [];
    for (const lo of this.layoutObjs) {
      const lay = after(lo, 'AcDbLayout');
      const name = str(lay, 1);
      const record = str(lay, 330).toUpperCase();
      const recName = this.recordNames.get(record) ?? '';
      if (!name || /^model$/i.test(name) || /^\*MODEL_SPACE$/i.test(recName)) continue;
      const objs = /^\*PAPER_SPACE$/i.test(recName) || (!recName && out.length === 0) ? this.activePaper : (this.blocks.get(recName.toUpperCase()) ?? []);
      out.push({ layout: this.layoutFrom(before(lo, 'AcDbLayout'), name, objs, readEntities, units), tab: num(lay, 71, out.length + 1) });
    }
    if (out.length === 0 && this.activePaper.length > 0) {
      // Paper-space entities without LAYOUT objects (R12-style files): one default layout.
      const base = defaultLayout('Layout1', units);
      out.push({ layout: this.withContent({ ...base, pristine: undefined }, this.activePaper, readEntities, { x: 0, y: 0 }), tab: 1 });
    }
    out.sort((a, b) => a.tab - b.tab);
    const layouts = out.map((o) => o.layout);
    if (layouts.length === 0) return undefined;
    if (layouts.length === 1 && layouts[0]!.pristine && /^layout1$/i.test(layouts[0]!.name)) return undefined;
    return layouts;
  }

  private layoutFrom(ps: Obj, name: string, objs: Obj[], readEntities: (objs: Obj[]) => Entity[], fallbackUnits: PaperUnits): Layout {
    const units: PaperUnits = num(ps, 72, fallbackUnits === 'mm' ? 1 : 0) === 1 ? 'mm' : 'in';
    const rotation = Math.trunc(num(ps, 73, 0)) & 3;
    const w = num(ps, 44, 0);
    const h = num(ps, 45, 0);
    const turned = rotation === 1 || rotation === 3;
    const sheetW = turned ? h : w;
    const sheetH = turned ? w : h;
    const orientation = sheetW >= sheetH ? 'landscape' : 'portrait';
    const media = str(ps, 4);
    const paper =
      (w > 0 && h > 0 ? paperFromSize(fromMm(w, units), fromMm(h, units), units, orientation) : null) ??
      (media ? paperFromMediaName(media, orientation) : null) ??
      defaultLayout(name, units).paper;
    const margins: LayoutMargins = {
      left: fromMm(num(ps, 40, 0), units),
      bottom: fromMm(num(ps, 41, 0), units),
      right: fromMm(num(ps, 42, 0), units),
      top: fromMm(num(ps, 43, 0), units),
    };
    const offset = { x: margins.left + fromMm(num(ps, 46, 0), units), y: margins.bottom + fromMm(num(ps, 47, 0), units) };
    const n = num(ps, 142, 1);
    const d = num(ps, 143, 1);
    const sheetName = str(ps, 7).toLowerCase();
    const plotStyle: PlotStyleMode = /monochrome/.test(sheetName) ? 'monochrome' : /gray|grey/.test(sheetName) ? 'grayscale' : /screen/.test(sheetName) ? 'screening' : 'color';
    const flags = Math.trunc(num(ps, 70, 0));
    const base: Layout = {
      name,
      paper: { ...paper, orientation },
      plotScale: Math.trunc(num(ps, 75, 16)) === 0 && flags & 16 ? 'fit' : n > 0 && d > 0 ? formatScale(n / d) : '1:1',
      margins,
      entities: [],
      viewports: [],
      plotStyle,
      ...(plotStyle === 'screening' ? { screening: Number(/(\d+)%/.exec(sheetName)?.[1] ?? 50) } : {}),
      ...(flags & 128 ? {} : { plotLineweights: false }),
      ...(flags & 32 || !sheetName ? {} : { usePlotStyles: false }),
    };
    const lay = this.withContent(base, objs, readEntities, offset);
    return lay.entities.length === 0 && lay.viewports.length === 0 ? { ...lay, pristine: true } : lay;
  }

  private withContent(base: Layout, objs: Obj[], readEntities: (objs: Obj[]) => Entity[], offset: Point): Layout {
    const vps = objs.filter((o) => o.kind === 'VIEWPORT');
    const rest = objs.filter((o) => o.kind !== 'VIEWPORT');
    // The overall paper-space viewport has id 1 (else: the first VIEWPORT in the list).
    const overall = vps.find((o) => Math.trunc(num(o, 69)) === 1) ?? vps[0];
    const viewports: LayoutViewport[] = [];
    for (const o of vps) {
      if (o === overall) continue;
      const v = after(o, 'AcDbViewport');
      const width = num(v, 40, 0);
      const height = num(v, 41, 0);
      const viewHeight = num(v, 45, 0);
      if (!(width > 0 && height > 0 && viewHeight > 0)) continue;
      const flags = Math.trunc(num(v, 90, 0));
      const status = Math.trunc(num(v, 68, 1));
      const frozen = v.groups.filter((x) => x.code === 331).map((x) => this.layerNames.get(x.value.toUpperCase())).filter((x): x is string => !!x);
      viewports.push({
        id: newViewportId(),
        center: { x: num(v, 10) + offset.x, y: num(v, 20) + offset.y },
        width,
        height,
        view: { center: { x: num(v, 12), y: num(v, 22) }, scale: height / viewHeight, ...(flags & VP_LOCKED ? { locked: true } : {}) },
        layer: str(o, 8, '0'),
        on: status !== 0 && !(flags & VP_OFF),
        ...(frozen.length ? { frozenLayers: frozen } : {}),
      });
    }
    const read = readEntities(rest);
    const entities = offset.x || offset.y ? read.map((e) => translateEntity(e, offset)) : read;
    return { ...base, entities, viewports };
  }
}
