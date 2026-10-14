/**
 * DXF paper space (Track E): layouts, their paper-space entities, VIEWPORT entities and the
 * LAYOUT objects of the ACAD_LAYOUT dictionary. io/dxf/writer.ts and io/dxf/reader.ts call in
 * here at a few points:
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
  viewTwist,
  formatScale,
  type Layout,
  type LayoutHost,
  type LayoutViewport,
  type LayoutMargins,
  type PaperUnits,
  type PlotStyleMode,
} from '../core/layouts';
import type { ImportReportBuilder } from './import-report';
import { importViewportView } from './viewport-view';
import type { CadGroup } from '../core/cad-graph';

export interface DxfSink {
  pair(code: number, value: string | number): void;
  nextHandle(): string;
  reserveEntityHandle(entity: Entity): string;
  anchor?(handle: string, anchor: import('../core/cad-graph').CadAnchor): void;
}

interface Pair {
  code: number;
  value: string;
}
interface Obj {
  kind: string;
  groups: Pair[];
  line?: number;
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
    entities: layouts.flatMap((l) => [...l.entities, ...l.viewports.flatMap((v) => v.clipBoundary ? [v.clipBoundary] : [])]),
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

function writeViewport(w: DxfSink, owner: string, v: { center: Point; width: number; height: number; viewCenter: Point; viewHeight: number; twist?: number; layer: string; status: number; id: number; flags: number; frozen: string[]; clipHandle?: string }): string {
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
  w.pair(51, (v.twist ?? 0) * 180 / Math.PI);
  w.pair(72, 1000);
  for (const f of v.frozen) w.pair(331, f);
  w.pair(90, v.flags);
  if (v.clipHandle) w.pair(340, v.clipHandle);
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
  const boundaries = new Map<Entity, string>();
  lay.viewports.forEach((v, i) => {
    if (v.clipBoundary && !supportedViewportClip(v.clipBoundary)) throw new Error('Cannot save an invalid or curved viewport clip boundary.');
    // Multiple native viewports can reference the same boundary in one paper owner.
    // A separate layout still emits its own boundary with its own handle and owner.
    const existing = v.clipBoundary && boundaries.get(v.clipBoundary);
    const boundary = !existing && v.clipBoundary ? { ...v.clipBoundary } : undefined;
    const clipHandle = existing ?? (boundary ? w.reserveEntityHandle(boundary) : undefined);
    if (v.clipBoundary && boundary && clipHandle) boundaries.set(v.clipBoundary, clipHandle);
    const frozen = (v.frozenLayers ?? []).map((n) => layerHandles.get(n)).filter((h): h is string => !!h);
    const twist = viewTwist(v.view) % (2 * Math.PI);
    const cos = Math.cos(twist), sin = Math.sin(twist);
    const handle = writeViewport(w, rec.blockRecord, {
      center: v.center,
      width: v.width,
      height: v.height,
      // The exported target is zero, so WCS->DCS is R(+twist) about the origin.
      viewCenter: { x: v.view.center.x * cos - v.view.center.y * sin, y: v.view.center.x * sin + v.view.center.y * cos },
      viewHeight: v.height / v.view.scale,
      twist,
      layer: v.layer,
      status: v.on ? i + 2 : 0,
      id: i + 2,
      flags: 32768 | 32 | (v.view.locked ? VP_LOCKED : 0) | (v.on ? 0 : VP_OFF) | (clipHandle && v.clipOn !== false ? VP_NONRECT_CLIP : 0),
      frozen,
      clipHandle,
    });
    if (boundary) writeEntity(boundary, rec.blockRecord);
    w.anchor?.(handle, { kind: 'viewport', id: v.id });
  });
  for (const e of lay.entities) if (!boundaries.has(e)) writeEntity(e, rec.blockRecord);
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
    w.anchor?.(handle, { kind: 'layout', name });
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

interface LayoutPlotSettings {
  layout: Layout;
  offset: Point;
}

/** Decode physical paper and plot origin independently of paper-space drawing limits. */
function layoutPlotSettings(ps: Obj, name: string, fallbackUnits: PaperUnits): LayoutPlotSettings {
  const units: PaperUnits = num(ps, 72, fallbackUnits === 'mm' ? 1 : 0) === 1 ? 'mm' : 'in';
  const rotation = Math.trunc(num(ps, 73, 0)) & 3;
  const w = num(ps, 44, 0), h = num(ps, 45, 0);
  const turned = rotation === 1 || rotation === 3;
  const orientation = (turned ? h : w) >= (turned ? w : h) ? 'landscape' : 'portrait';
  const media = str(ps, 4);
  const paper =
    (w > 0 && h > 0 ? paperFromSize(fromMm(w, units), fromMm(h, units), units, orientation) : null) ??
    (media ? paperFromMediaName(media, orientation) : null) ??
    defaultLayout(name, units).paper;
  const margins: LayoutMargins = {
    left: fromMm(num(ps, 40, 0), units), bottom: fromMm(num(ps, 41, 0), units),
    right: fromMm(num(ps, 42, 0), units), top: fromMm(num(ps, 43, 0), units),
  };
  const n = num(ps, 142, 1), d = num(ps, 143, 1);
  const sheetName = str(ps, 7).toLowerCase();
  const plotStyle: PlotStyleMode = /monochrome/.test(sheetName) ? 'monochrome' : /gray|grey/.test(sheetName) ? 'grayscale' : /screen/.test(sheetName) ? 'screening' : 'color';
  const flags = Math.trunc(num(ps, 70, 0));
  return {
    layout: {
      name, paper: { ...paper, orientation },
      plotScale: Math.trunc(num(ps, 75, 16)) === 0 && flags & 16 ? 'fit' : n > 0 && d > 0 ? formatScale(n / d) : '1:1',
      margins, entities: [], viewports: [], plotStyle,
      ...(plotStyle === 'screening' ? { screening: Number(/(\d+)%/.exec(sheetName)?.[1] ?? 50) } : {}),
      ...(flags & 128 ? {} : { plotLineweights: false }),
      ...(flags & 32 || !sheetName ? {} : { usePlotStyles: false }),
    },
    offset: { x: margins.left + fromMm(num(ps, 46, 0), units), y: margins.bottom + fromMm(num(ps, 47, 0), units) },
  };
}

/** A unique native subclass, excluding application 102 blocks and XDATA. */
function nativeLayoutSubclass(groups: readonly CadGroup[], name: string, keepOpaque = false): Pair[] | undefined {
  let depth = 0, found = false, active = false;
  const out: Pair[] = [];
  for (const [code, value] of groups) {
    if (code === 102) {
      if (active && keepOpaque) out.push({ code, value });
      if (value.trim().startsWith('{')) depth += 1;
      else if (value.trim() === '}') depth -= 1;
      if (depth < 0) return undefined;
      continue;
    }
    if (depth) { if (active && keepOpaque) out.push({ code, value }); continue; }
    if (code === 1001) break;
    if (code === 100) {
      active = value.trim() === name;
      if (active && found) return undefined;
      if (active) found = true;
    } else if (active) out.push({ code, value });
  }
  return depth === 0 && found ? out : undefined;
}

/** Trusted native projection page setup; the caller must join its exact layout and paper owner. */
export function readNativeLayoutPlotSettings(groups: readonly CadGroup[], name: string, fallbackUnits: PaperUnits): (LayoutPlotSettings & { paperOwner: string }) | undefined {
  const ps = nativeLayoutSubclass(groups, 'AcDbPlotSettings'), layout = nativeLayoutSubclass(groups, 'AcDbLayout');
  if (!ps || !layout) return undefined;
  const unique = (pairs: readonly Pair[], code: number) => pairs.filter(pair => pair.code === code);
  const owners = unique(layout, 330);
  if (owners.length !== 1 || !/^[0-9a-f]{1,16}$/i.test(owners[0]!.value.trim())) return undefined;
  for (const code of [44, 45, 72, 73]) {
    const values = unique(ps, code);
    if (values.length !== 1 || !Number.isFinite(Number(values[0]!.value))) return undefined;
  }
  if (!(Number(unique(ps, 44)[0]!.value) > 0 && Number(unique(ps, 45)[0]!.value) > 0)) return undefined;
  const units = Number(unique(ps, 72)[0]!.value), rotation = Number(unique(ps, 73)[0]!.value);
  if (!(units === 0 || units === 1) || !Number.isInteger(rotation) || rotation < 0 || rotation > 3) return undefined;
  return { ...layoutPlotSettings({ kind: 'LAYOUT', groups: ps }, name, fallbackUnits), paperOwner: owners[0]!.value.trim() };
}

/** Keep exact device-specific media and paper fields only while their modeled inputs are unchanged. */
export function retainNativeLayoutPaper(source: readonly CadGroup[], generated: readonly CadGroup[], layout: Layout | 'model'): CadGroup[] {
  if (layout === 'model') {
    const original = nativeLayoutSubclass(source, 'AcDbPlotSettings', true);
    if (!original) return [...generated];
    const out: CadGroup[] = [];
    let active = false, depth = 0;
    for (const pair of generated) {
      const [code, value] = pair;
      if (!depth && (code === 100 || code === 1001)) {
        active = code === 100 && value.trim() === 'AcDbPlotSettings';
        if (active) { out.push(pair, ...original.map(({ code, value }): CadGroup => [code, value])); continue; }
      }
      if (code === 102) {
        if (value.trim().startsWith('{')) depth += 1;
        else if (value.trim() === '}') depth -= 1;
      }
      if (!active) out.push(pair);
    }
    return out;
  }
  const native = readNativeLayoutPlotSettings(source, layout.name, layout.paper.units);
  if (!native) return [...generated];
  const before = native.layout.paper, after = layout.paper;
  if (before.width !== after.width || before.height !== after.height || before.units !== after.units || before.orientation !== after.orientation) return [...generated];
  const paperCodes = new Set([4, 44, 45, 72, 73]);
  const original = nativeLayoutSubclass(source, 'AcDbPlotSettings')!;
  if ([...paperCodes].some(code => original.filter(pair => pair.code === code).length !== 1)) return [...generated];
  const retained = new Map(original.filter(pair => paperCodes.has(pair.code)).map(pair => [pair.code, pair.value]));
  let active = false, depth = 0;
  return generated.map(([code, value]): CadGroup => {
    if (code === 102) {
      if (value.trim().startsWith('{')) depth += 1;
      else if (value.trim() === '}') depth -= 1;
    }
    if (!depth && (code === 100 || code === 1001)) active = code === 100 && value.trim() === 'AcDbPlotSettings';
    return active && !depth && retained.has(code) ? [code, retained.get(code)!] : [code, value];
  });
}

/** VIEWPORT 90 flag: clipped by a non-rectangular boundary (group 340). */
const VP_NONRECT_CLIP = 65536;

function supportedViewportClip(entity: Entity): entity is import('../core/entities').PolylineEntity {
  if (entity.type !== 'polyline' || !entity.closed || entity.filled || entity.widthFrame || entity.points.length < 3 || entity.points.length > 8192 || entity.bulges?.some((b) => b !== 0)) return false;
  if (!entity.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  const origin = entity.points[0]!;
  let area = 0;
  for (let i = 1; i < entity.points.length - 1; i += 1) {
    const a = entity.points[i]!, b = entity.points[i + 1]!;
    area += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return Number.isFinite(area) && Math.abs(area) > 1e-12;
}

/** Reads the entities of a layout; `where` names the layout for the import report. */
export type LayoutEntityReader = (objs: Obj[], where: string) => Entity[];

/** Collects paper-space data while io/dxf/reader.ts walks the sections, then builds the layouts. */
export class LayoutReader {
  readonly viewportHandles = new Map<string, string>();
  /** `report` receives viewports that are dropped or simplified. */
  constructor(private readonly report?: ImportReportBuilder) {}
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

  /** Build declared layouts; `readEntities` is the DXF reader's entity parser. */
  build(readEntities: LayoutEntityReader, host: LayoutHost): Layout[] | undefined {
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
    // Even an untouched source Layout1 has its own retained LAYOUT/BLOCK_RECORD
    // identities. Keep it explicit so a newly added sheet gets a distinct block.
    return layouts;
  }

  private layoutFrom(ps: Obj, name: string, objs: Obj[], readEntities: LayoutEntityReader, fallbackUnits: PaperUnits): Layout {
    const settings = layoutPlotSettings(ps, name, fallbackUnits);
    const lay = this.withContent(settings.layout, objs, readEntities, settings.offset);
    return lay.entities.length === 0 && lay.viewports.length === 0 ? { ...lay, pristine: true } : lay;
  }

  private withContent(base: Layout, objs: Obj[], readEntities: LayoutEntityReader, offset: Point): Layout {
    const vps = objs.filter((o) => o.kind === 'VIEWPORT');
    const rest = objs.filter((o) => o.kind !== 'VIEWPORT');
    // The overall paper-space viewport has id 1 (else: the first VIEWPORT in the list).
    const overall = vps.find((o) => Math.trunc(num(o, 69)) === 1) ?? vps[0];
    const viewports: LayoutViewport[] = [];
    const clipObjects = new Set<Obj>();
    const clipBoundaries = new Map<Obj, import('../core/entities').PolylineEntity>();
    const byHandle = new Map(rest.map((o) => [str(o, 5).toUpperCase(), o]));
    for (const o of vps) {
      if (o === overall) continue;
      const v = after(o, 'AcDbViewport');
      const width = num(v, 40, 0);
      const height = num(v, 41, 0);
      const viewHeight = num(v, 45, 0);
      const where = `layout "${base.name}"`;
      const handle = str(o, 5);
      const item = { type: 'VIEWPORT', layer: str(o, 8, '0'), where, ...(handle ? { handle } : {}), ...(o.line ? { line: o.line } : {}) };
      if (!(width > 0 && height > 0 && viewHeight > 0)) {
        this.report?.add({ ...item, action: 'dropped', reason: 'invalid viewport size or view height' });
        continue;
      }
      const flags = Math.trunc(num(v, 90, 0));
      const optionalNum = (code: number, fallback = 0) => v.groups.some((p) => p.code === code) ? num(v, code, NaN) : fallback;
      const degrees = optionalNum(51);
      const view = importViewportView(
        { x: optionalNum(12), y: optionalNum(22) },
        { x: optionalNum(17), y: optionalNum(27), z: optionalNum(37) },
        { x: optionalNum(16), y: optionalNum(26), z: optionalNum(36, 1) },
        (degrees % 360) * Math.PI / 180,
        flags,
      );
      const scale = height / viewHeight;
      const center = { x: optionalNum(10) + offset.x, y: optionalNum(20) + offset.y };
      if (!view || ![scale, center.x, center.y].every(Number.isFinite)) {
        this.report?.add({ ...item, action: 'dropped', reason: 'invalid viewport view coordinates or scale' });
        continue;
      }
      for (const reason of view.warnings) this.report?.add({ ...item, action: 'simplified', reason });
      const clipHandle = str(v, 340).trim().toUpperCase();
      const clipObject = clipHandle && clipHandle !== '0' ? byHandle.get(clipHandle) : undefined;
      let clipBoundary = clipObject ? clipBoundaries.get(clipObject) : undefined;
      if (!clipBoundary && clipObject?.kind === 'LWPOLYLINE') {
        const boundary = readEntities([clipObject], where)[0];
        if (boundary && supportedViewportClip(boundary)) {
          clipBoundary = translateEntity(boundary, offset) as import('../core/entities').PolylineEntity;
          clipBoundaries.set(clipObject, clipBoundary);
        }
      }
      if (clipBoundary && clipObject) clipObjects.add(clipObject);
      else if (flags & VP_NONRECT_CLIP || clipHandle && clipHandle !== '0') {
        this.report?.add({ ...item, action: 'simplified', reason: 'its clipping boundary is not a supported closed straight polyline: the viewport shows its whole rectangle; readable boundary geometry is kept' });
      }
      const status = Math.trunc(num(v, 68, 1));
      const frozen = v.groups.filter((x) => x.code === 331).map((x) => this.layerNames.get(x.value.toUpperCase())).filter((x): x is string => !!x);
      const id = newViewportId();
      if (str(o, 5)) this.viewportHandles.set(str(o, 5).trim().toUpperCase(), id);
      viewports.push({
        id,
        center,
        width,
        height,
        view: { center: view.center, scale, ...(view.twist ? { twist: view.twist } : {}), ...(flags & VP_LOCKED ? { locked: true } : {}) },
        layer: str(o, 8, '0'),
        on: status !== 0 && !(flags & VP_OFF),
        ...(frozen.length ? { frozenLayers: frozen } : {}),
        ...(clipBoundary ? { clipBoundary, ...(!(flags & VP_NONRECT_CLIP) ? { clipOn: false } : {}) } : {}),
      });
    }
    const read = readEntities(rest.filter((o) => !clipObjects.has(o)), `layout "${base.name}"`);
    const entities = offset.x || offset.y ? read.map((e) => translateEntity(e, offset)) : read;
    return { ...base, entities, viewports };
  }
}
