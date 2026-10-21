/**
 * Paper-space layouts (AutoCAD LAYOUT / MVIEW / annotative scaling), pure model code.
 *
 * A drawing has model space (`DrawingState.entities`) plus any number of layouts. A layout
 * is a sheet of paper (size, orientation, margins, plot scale and style) holding paper-space
 * entities (title block, notes) and floating viewports that show model space at a scale.
 * Layouts live in the drawing state, so every transaction keeps them and undo/redo covers
 * layout edits like any other change.
 *
 * Paper-space editing reuses every drawing tool: while a layout is active in paper space the
 * Drawing exposes `paperEntities(layout)` as its entity list (the layout's entities plus one
 * closed rectangle per viewport, the "frame", carrying the viewport data) and folds edits of
 * that list back into the layout with `applyPaperEntities` (moving a frame moves the viewport,
 * stretching it resizes the viewport, erasing it deletes the viewport, copying it copies it).
 */
import type { Entity, PolylineEntity, Layer, InsertEntity, TextEntity, MTextEntity, LeaderEntity, DimensionEntity } from './entities';
import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import type { MLeaderContext } from './multileader';
import type { MTextAttachment } from './mtext';

export type PaperUnits = 'in' | 'mm';

/** A sheet size. `width` x `height` is the portrait size in `units`. */
export interface LayoutPaper {
  /** Catalog id (see LAYOUT_PAPERS) or 'custom'. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly units: PaperUnits;
  readonly orientation: 'landscape' | 'portrait';
}

/** Unprintable border of the sheet, paper units (AutoCAD draws the printable area dashed). */
export interface LayoutMargins {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

/** What a floating viewport shows of model space. */
export interface ViewportView {
  /** Model-space point at the viewport centre. */
  readonly center: Point;
  /** Paper units per model unit (0.25 = 1:4). */
  readonly scale: number;
  /** View twist in radians: positive rotates model content counterclockwise on the sheet. */
  readonly twist?: number;
  /** Display locked: zooming in the viewport zooms the paper instead (MVIEW Lock). */
  readonly locked?: boolean;
}

/** A floating (MVIEW) viewport: a rectangle on the paper looking into model space. */
export interface LayoutViewport {
  readonly id: string;
  /** Centre and size on the paper, paper units. */
  readonly center: Point;
  readonly width: number;
  readonly height: number;
  readonly view: ViewportView;
  /** Layer of the viewport frame. */
  readonly layer: string;
  /** Off viewports show their frame but no model space (MVIEW ON/OFF). */
  readonly on: boolean;
  /** Layers frozen in this viewport only (VPLAYER / DXF 331). */
  readonly frozenLayers?: readonly string[];
  /** Native, closed straight-polyline clip in paper coordinates. Curved clips remain reported. */
  readonly clipBoundary?: PolylineEntity;
  /** A retained native boundary may be disabled; omitted means enabled. */
  readonly clipOn?: boolean;
}

export type PlotStyleMode = 'monochrome' | 'grayscale' | 'color' | 'screening';

export interface Layout {
  readonly name: string;
  readonly paper: LayoutPaper;
  /** Plot scale for PLOT of this layout: '1:1' (paper at full size) or 'fit'. */
  readonly plotScale: string;
  readonly margins: LayoutMargins;
  /** Paper-space entities (title block insert, notes, borders). */
  readonly entities: readonly Entity[];
  readonly viewports: readonly LayoutViewport[];
  /** Page setup plot style (Monochrome by default, like monochrome.ctb). */
  readonly plotStyle?: PlotStyleMode;
  /** Screening percentage for the 'screening' style (100 = full ink). */
  readonly screening?: number;
  /** Plot object lineweights (default true). */
  readonly plotLineweights?: boolean;
  /** Plot with plot styles (default true); off plots the object colours as they are. */
  readonly usePlotStyles?: boolean;
  /** Never shown yet: the first activation creates the default viewport (AutoCAD's layout initialisation). */
  readonly pristine?: boolean;
}

/** The active space when not in the Model tab: a layout, and the floating viewport being edited (MSPACE). */
export interface SpaceRef {
  readonly layout: string;
  readonly viewport?: string;
}

// ---------------------------------------------------------------- paper sizes

export interface PaperDef {
  readonly id: string;
  readonly label: string;
  /** Portrait size in `units`. */
  readonly width: number;
  readonly height: number;
  readonly units: PaperUnits;
  /** AutoCAD canonical media name (LAYOUT group 4). */
  readonly media: string;
}

const inch = (id: string, label: string, w: number, h: number, media: string): PaperDef => ({ id, label, width: w, height: h, units: 'in', media });
const iso = (id: string, label: string, w: number, h: number, media: string): PaperDef => ({ id, label, width: w, height: h, units: 'mm', media });

/** Sheet sizes offered for layouts (ids match app/plot.ts PAPER_SIZES). */
export const LAYOUT_PAPERS: readonly PaperDef[] = [
  inch('letter', 'Letter 8.5 x 11 in', 8.5, 11, 'Letter_(8.50_x_11.00_Inches)'),
  inch('legal', 'Legal 8.5 x 14 in', 8.5, 14, 'Legal_(8.50_x_14.00_Inches)'),
  inch('tabloid', 'ANSI B (Tabloid) 11 x 17 in', 11, 17, 'ANSI_B_(11.00_x_17.00_Inches)'),
  inch('ansi-c', 'ANSI C 17 x 22 in', 17, 22, 'ANSI_C_(17.00_x_22.00_Inches)'),
  inch('ansi-d', 'ANSI D 22 x 34 in', 22, 34, 'ANSI_D_(22.00_x_34.00_Inches)'),
  inch('ansi-e', 'ANSI E 34 x 44 in', 34, 44, 'ANSI_E_(34.00_x_44.00_Inches)'),
  inch('arch-c', 'ARCH C 18 x 24 in', 18, 24, 'ARCH_C_(18.00_x_24.00_Inches)'),
  inch('arch-d', 'ARCH D 24 x 36 in', 24, 36, 'ARCH_D_(24.00_x_36.00_Inches)'),
  iso('a4', 'ISO A4 210 x 297 mm', 210, 297, 'ISO_A4_(210.00_x_297.00_MM)'),
  iso('a3', 'ISO A3 297 x 420 mm', 297, 420, 'ISO_A3_(297.00_x_420.00_MM)'),
  iso('a2', 'ISO A2 420 x 594 mm', 420, 594, 'ISO_A2_(420.00_x_594.00_MM)'),
  iso('a1', 'ISO A1 594 x 841 mm', 594, 841, 'ISO_A1_(594.00_x_841.00_MM)'),
  iso('a0', 'ISO A0 841 x 1189 mm', 841, 1189, 'ISO_A0_(841.00_x_1189.00_MM)'),
];

export const MM_PER_INCH = 25.4;

export function paperDef(id: string): PaperDef | undefined {
  return LAYOUT_PAPERS.find((p) => p.id === id);
}

/** A layout paper for a catalog id (unknown ids fall back to tabloid). */
export function paperFor(id: string, orientation: 'landscape' | 'portrait' = 'landscape', units?: PaperUnits): LayoutPaper {
  const def = paperDef(id) ?? paperDef('tabloid')!;
  const u = units ?? def.units;
  const k = u === def.units ? 1 : u === 'mm' ? MM_PER_INCH : 1 / MM_PER_INCH;
  return { id: def.id, width: def.width * k, height: def.height * k, units: u, orientation };
}

/** Find the catalog paper for a size (either orientation, either unit), else a custom paper. */
export function paperFromSize(width: number, height: number, units: PaperUnits, orientation?: 'landscape' | 'portrait'): LayoutPaper {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const orient = orientation ?? (width >= height ? 'landscape' : 'portrait');
  for (const d of LAYOUT_PAPERS) {
    const k = d.units === units ? 1 : units === 'mm' ? MM_PER_INCH : 1 / MM_PER_INCH;
    const tol = units === 'mm' ? 1.5 : 0.06;
    if (Math.abs(d.width * k - w) <= tol && Math.abs(d.height * k - h) <= tol) return { id: d.id, width: w, height: h, units, orientation: orient };
  }
  return { id: 'custom', width: w, height: h, units, orientation: orient };
}

/** The paper for an AutoCAD canonical media name ("ANSI_B_(11.00_x_17.00_Inches)"), or null. */
export function paperFromMediaName(name: string, orientation: 'landscape' | 'portrait'): LayoutPaper | null {
  const known = LAYOUT_PAPERS.find((p) => p.media.toUpperCase() === name.toUpperCase());
  if (known) return paperFor(known.id, orientation);
  const m = /\((\d+(?:\.\d+)?)_x_(\d+(?:\.\d+)?)_(Inches|MM)\)/i.exec(name);
  if (!m) return null;
  return paperFromSize(Number(m[1]), Number(m[2]), /^mm$/i.test(m[3]!) ? 'mm' : 'in', orientation);
}

export function mediaName(p: LayoutPaper): string {
  const def = paperDef(p.id);
  if (def && def.units === p.units) return def.media;
  const f = (v: number) => v.toFixed(2);
  return `USER_(${f(p.width)}_x_${f(p.height)}_${p.units === 'mm' ? 'MM' : 'Inches'})`;
}

export function paperLabel(p: LayoutPaper): string {
  const def = paperDef(p.id);
  if (def) return def.label;
  return `Custom ${+p.width.toFixed(2)} x ${+p.height.toFixed(2)} ${p.units}`;
}

/** Oriented sheet size in paper units. */
export function sheetSize(layout: Pick<Layout, 'paper'>): { width: number; height: number } {
  const { width, height, orientation } = layout.paper;
  return orientation === 'landscape' ? { width: Math.max(width, height), height: Math.min(width, height) } : { width: Math.min(width, height), height: Math.max(width, height) };
}

/** Inches per paper unit. */
export const unitInches = (u: PaperUnits): number => (u === 'mm' ? 1 / MM_PER_INCH : 1);

export function sheetInches(layout: Pick<Layout, 'paper'>): { width: number; height: number } {
  const s = sheetSize(layout);
  const k = unitInches(layout.paper.units);
  return { width: s.width * k, height: s.height * k };
}

/** The printable area inside the margins, in paper coordinates (origin = lower-left sheet corner). */
export function printableArea(layout: Pick<Layout, 'paper' | 'margins'>): Bounds {
  const s = sheetSize(layout);
  const m = layout.margins;
  return { min: { x: m.left, y: m.bottom }, max: { x: Math.max(m.left, s.width - m.right), y: Math.max(m.bottom, s.height - m.top) } };
}

export function sheetBounds(layout: Pick<Layout, 'paper'>): Bounds {
  const s = sheetSize(layout);
  return { min: { x: 0, y: 0 }, max: { x: s.width, y: s.height } };
}

export function uniformMargins(v: number): LayoutMargins {
  return { left: v, bottom: v, right: v, top: v };
}

/** A new, not yet initialised layout (tabloid landscape in inch drawings, A3 landscape in metric ones). */
export function defaultLayout(name: string, units: PaperUnits = 'in'): Layout {
  return {
    name,
    paper: units === 'mm' ? paperFor('a3', 'landscape') : paperFor('tabloid', 'landscape'),
    plotScale: '1:1',
    margins: uniformMargins(units === 'mm' ? 6.35 : 0.25),
    entities: [],
    viewports: [],
    plotStyle: 'monochrome',
    pristine: true,
  };
}

// ---------------------------------------------------------------- scales

/** Scale list for viewports and CANNOSCALE (AutoCAD SCALELISTEDIT defaults, imperial first). */
export const STANDARD_SCALES: readonly string[] = ['1:1', '1:2', '1:4', '1:5', '1:8', '1:10', '1:16', '1:20', '1:32', '1:50', '1:100', '2:1', '4:1', '8:1'];

/** "1:4" -> 0.25, "2:1" -> 2, "0.5" / "0.5x" -> 0.5 (VPSCALE / ZOOM nXP style). Null for anything else. */
export function parseScale(text: string): number | null {
  const s = text.trim().replace(/xp$/i, '').replace(/x$/i, '');
  const m = /^(\d+(?:\.\d+)?)\s*[:=/]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 0 && b > 0 ? a / b : null;
  }
  const v = Number(s);
  return s !== '' && Number.isFinite(v) && v > 0 ? v : null;
}

/** 0.25 -> "1:4", 2 -> "2:1", 0.3 -> "1:3.333". */
export function formatScale(k: number): string {
  if (!(k > 0)) return '1:1';
  const r = (v: number) => String(+v.toFixed(4));
  return k >= 1 ? `${r(k)}:1` : `1:${r(1 / k)}`;
}

// ---------------------------------------------------------------- state access

/** Minimal state shape (DrawingState satisfies it; kept structural so core/document can import this file). */
export interface LayoutHost {
  readonly entities: readonly Entity[];
  readonly layouts?: readonly Layout[];
  readonly space?: SpaceRef;
  readonly header?: { readonly units: { readonly insunits: number } };
}

export const unitsOfHost = (s: LayoutHost): PaperUnits => (s.header?.units.insunits === 4 ? 'mm' : 'in');

const implicitLayouts = new WeakMap<object, readonly Layout[]>();

/** Layouts of a drawing; a drawing that never had any shows the implicit Layout1 (like every AutoCAD drawing). */
export function layoutsOf(s: LayoutHost): readonly Layout[] {
  if (s.layouts && s.layouts.length > 0) return s.layouts;
  // Stable per state so identity-based caches keep working.
  const key = (s.header ?? s) as object;
  let list = implicitLayouts.get(key);
  if (!list) {
    list = [defaultLayout('Layout1', unitsOfHost(s))];
    implicitLayouts.set(key, list);
  }
  return list;
}

export function findLayout(s: LayoutHost, name: string): Layout | undefined {
  const n = name.toUpperCase();
  return layoutsOf(s).find((l) => l.name.toUpperCase() === n);
}

/** The layout of the active space (undefined in the Model tab). */
export function activeLayout(s: LayoutHost): Layout | undefined {
  return s.space ? findLayout(s, s.space.layout) : undefined;
}

/** The layout whose paper space is being edited (a layout is active and no viewport is). */
export function paperSpaceLayout(s: LayoutHost): Layout | undefined {
  return s.space && !s.space.viewport ? findLayout(s, s.space.layout) : undefined;
}

/** The floating viewport being edited in MSPACE, with its layout. */
export function activeViewport(s: LayoutHost): { layout: Layout; viewport: LayoutViewport } | undefined {
  if (!s.space?.viewport) return undefined;
  const layout = findLayout(s, s.space.layout);
  const viewport = layout?.viewports.find((v) => v.id === s.space!.viewport);
  return layout && viewport ? { layout, viewport } : undefined;
}

/** Replace (or add) a layout by name, materialising the implicit Layout1 list. */
export function withLayout<S extends LayoutHost>(s: S, layout: Layout, previousName = layout.name): S {
  const list = layoutsOf(s);
  const n = previousName.toUpperCase();
  const i = list.findIndex((l) => l.name.toUpperCase() === n);
  const layouts = i >= 0 ? list.map((l, k) => (k === i ? layout : l)) : [...list, layout];
  return { ...s, layouts };
}

export function uniqueLayoutName(s: LayoutHost, base = 'Layout'): string {
  const names = new Set(layoutsOf(s).map((l) => l.name.toUpperCase()));
  if (!/\d$/.test(base) && !names.has(base.toUpperCase()) && base !== 'Layout') return base;
  const stem = base.replace(/\d+$/, '');
  for (let i = 1; ; i += 1) if (!names.has(`${stem}${i}`.toUpperCase())) return `${stem}${i}`;
}

/** AutoCAD layout names: 1-255 characters, none of <>/\":;?*|,=` and not "Model". */
export function validLayoutName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !/[<>/\\":;?*|,=`]/.test(name) && name.trim().toUpperCase() !== 'MODEL';
}

// ---------------------------------------------------------------- viewports

/** Model -> paper mapping of a viewport. */
export function modelToPaper(vp: Pick<LayoutViewport, 'center' | 'view'>, p: Point): Point {
  const delta = g.sub(p, vp.view.center);
  const angle = viewTwist(vp.view);
  return g.add(vp.center, g.scale(angle ? g.rotate(delta, angle) : delta, vp.view.scale));
}

export function paperToModel(vp: Pick<LayoutViewport, 'center' | 'view'>, p: Point): Point {
  const delta = g.scale(g.sub(p, vp.center), 1 / vp.view.scale);
  const angle = viewTwist(vp.view);
  return g.add(vp.view.center, angle ? g.rotate(delta, -angle) : delta);
}

/** Untwisted drawings and older saved states use zero; malformed optional values cannot poison a transform. */
export function viewTwist(view: Pick<ViewportView, 'twist'>): number {
  return Number.isFinite(view.twist) ? view.twist! : 0;
}

export function viewportPaperBounds(vp: Pick<LayoutViewport, 'center' | 'width' | 'height'>): Bounds {
  return { min: { x: vp.center.x - vp.width / 2, y: vp.center.y - vp.height / 2 }, max: { x: vp.center.x + vp.width / 2, y: vp.center.y + vp.height / 2 } };
}

/** The part of model space a viewport shows. */
export function viewportModelBounds(vp: LayoutViewport): Bounds {
  if (viewTwist(vp.view)) {
    const b = viewportPaperBounds(vp);
    const points = [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }].map((p) => paperToModel(vp, p));
    return { min: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) }, max: { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)) } };
  }
  const hw = vp.width / 2 / vp.view.scale;
  const hh = vp.height / 2 / vp.view.scale;
  return { min: { x: vp.view.center.x - hw, y: vp.view.center.y - hh }, max: { x: vp.view.center.x + hw, y: vp.view.center.y + hh } };
}

export function pointInViewport(vp: Pick<LayoutViewport, 'center' | 'width' | 'height' | 'clipBoundary' | 'clipOn'>, p: Point): boolean {
  const tolerance = vp.clipBoundary && vp.clipOn !== false ? 1e-9 : 0;
  if (Math.abs(p.x - vp.center.x) > vp.width / 2 + tolerance || Math.abs(p.y - vp.center.y) > vp.height / 2 + tolerance) return false;
  const points = vp.clipOn === false ? undefined : vp.clipBoundary?.points;
  if (!points) return true;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!, b = points[i]!;
    if (g.distToSegment(p, a, b) <= 1e-9) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

/** The topmost (last) viewport under a paper point. */
export function viewportAt(layout: Layout, p: Point): LayoutViewport | undefined {
  for (let i = layout.viewports.length - 1; i >= 0; i -= 1) if (pointInViewport(layout.viewports[i]!, p)) return layout.viewports[i];
  return undefined;
}

/** Zoom a viewport to show `model` (ZOOM Extents inside it / MVIEW Fit). */
export function fitViewportView(vp: LayoutViewport, model: Bounds | null, margin = 0.05): ViewportView {
  if (!model) return vp.view;
  const angle = viewTwist(vp.view);
  const points = [model.min, { x: model.max.x, y: model.min.y }, model.max, { x: model.min.x, y: model.max.y }].map((p) => {
    const local = g.sub(p, model.min);
    return angle ? g.rotate(local, angle) : local;
  });
  const w = Math.max(Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)), 1e-6);
  const h = Math.max(Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)), 1e-6);
  const scale = Math.min(vp.width / (w * (1 + 2 * margin)), vp.height / (h * (1 + 2 * margin)));
  return { ...vp.view, center: { x: (model.min.x + model.max.x) / 2, y: (model.min.y + model.max.y) / 2 }, scale: scale > 0 && Number.isFinite(scale) ? scale : vp.view.scale };
}

let vpCounter = 0;
export function newViewportId(): string {
  vpCounter += 1;
  return `vp${Date.now().toString(36)}${vpCounter.toString(36)}`;
}

/** A viewport filling the paper rectangle a..b, zoomed to the model extents (or 1:1 at the origin). */
export function makeViewport(a: Point, b: Point, layer: string, model: Bounds | null, scale?: number): LayoutViewport {
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const width = Math.max(Math.abs(b.x - a.x), 1e-6);
  const height = Math.max(Math.abs(b.y - a.y), 1e-6);
  const base: LayoutViewport = { id: newViewportId(), center, width, height, view: { center: { x: 0, y: 0 }, scale: 1 }, layer, on: true };
  const fitted = { ...base, view: fitViewportView(base, model) };
  if (scale && scale > 0) return { ...fitted, view: { ...fitted.view, scale } };
  return fitted;
}

/** Layer the viewport frames go on: a no-plot layer, so frames show on screen but not on paper. */
export const VIEWPORT_LAYER: Layer = { name: 'VIEWPORTS', color: 8, visible: true, locked: false, lineWeight: 0.25, plot: false };

// ---------------------------------------------------------------- paper-space entity projection

/** The rectangle that stands for a viewport in the paper-space entity list. */
export type ViewportFrame = PolylineEntity & { readonly vport: LayoutViewport };

export function isViewportFrame(e: Entity): e is ViewportFrame {
  return e.type === 'polyline' && (e as Partial<ViewportFrame>).vport !== undefined;
}

const frameCache = new WeakMap<LayoutViewport, ViewportFrame>();

export function viewportFrame(vp: LayoutViewport): ViewportFrame {
  let f = frameCache.get(vp);
  if (!f) {
    const b = viewportPaperBounds(vp);
    f = {
      ...(vp.clipOn !== false ? vp.clipBoundary : undefined),
      id: vp.id,
      type: 'polyline',
      layer: vp.clipOn !== false && vp.clipBoundary ? vp.clipBoundary.layer : vp.layer,
      color: vp.clipOn !== false && vp.clipBoundary ? vp.clipBoundary.color : 'ByLayer',
      closed: true,
      points: (vp.clipOn !== false ? vp.clipBoundary?.points : undefined) ?? [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }],
      vport: vp,
    };
    frameCache.set(vp, f);
  }
  return f;
}

const paperCache = new WeakMap<Layout, readonly Entity[]>();

/** Paper-space entity list of a layout: viewport frames first (paper objects draw over them), then the layout's entities. */
export function paperEntities(layout: Layout): readonly Entity[] {
  let list = paperCache.get(layout);
  if (!list) {
    list = [...layout.viewports.map(viewportFrame), ...layout.entities];
    paperCache.set(layout, list);
  }
  return list;
}

/** A frame edited by a tool (moved, stretched, copied, re-layered) back to a viewport. */
function viewportFromFrame(f: ViewportFrame): LayoutViewport {
  const vp = f.vport;
  if (f === frameCache.get(vp)) return vp;
  if (vp.clipBoundary && vp.clipOn !== false) {
    // A move carries the rectangle and view. A reshape updates the enclosing rectangle
    // while keeping model content anchored at the same paper coordinates.
    const old = g.boundsOfPoints(vp.clipBoundary.points)!;
    const next = g.boundsOfPoints(f.points)!;
    const moved = f.points.length === vp.clipBoundary.points.length && f.points.every((p, i) => {
      const original = vp.clipBoundary!.points[i]!;
      return Math.abs(p.x - original.x - (next.min.x - old.min.x)) < 1e-9 && Math.abs(p.y - original.y - (next.min.y - old.min.y)) < 1e-9;
    });
    const center = moved ? g.add(vp.center, g.sub(next.min, old.min)) : g.mid(next.min, next.max);
    const delta = g.scale(g.sub(center, vp.center), 1 / vp.view.scale);
    const angle = viewTwist(vp.view);
    const view = moved ? vp.view : { ...vp.view, center: g.add(vp.view.center, angle ? g.rotate(delta, -angle) : delta) };
    const { vport: _view, ...outline } = f;
    return { ...vp, id: f.id, center, view, ...(!moved ? { width: Math.max(next.max.x - next.min.x, 1e-6), height: Math.max(next.max.y - next.min.y, 1e-6) } : {}), clipBoundary: { ...outline, id: f.id === vp.id ? vp.clipBoundary.id : `${f.id}:clip` } };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of f.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const resized = Math.abs(width - vp.width) > 1e-9 || Math.abs(height - vp.height) > 1e-9;
  // A move carries the view along (same model centre); a stretch keeps the model where it is on the paper.
  const delta = g.scale(g.sub(center, vp.center), 1 / vp.view.scale);
  const angle = viewTwist(vp.view);
  const view = resized ? { ...vp.view, center: g.add(vp.view.center, angle ? g.rotate(delta, -angle) : delta) } : vp.view;
  const clipBoundary = vp.clipBoundary ? { ...vp.clipBoundary, id: f.id === vp.id ? vp.clipBoundary.id : `${f.id}:clip`, points: vp.clipBoundary.points.map((p) => ({ x: center.x + (p.x - vp.center.x) * width / vp.width, y: center.y + (p.y - vp.center.y) * height / vp.height })) } : undefined;
  return { ...vp, id: f.id, layer: f.layer, center, width, height, view, ...(clipBoundary ? { clipBoundary } : {}) };
}

/** Fold an edited paper-space entity list (see `paperEntities`) back into the layout. */
export function applyPaperEntities(layout: Layout, list: readonly Entity[]): Layout {
  if (list === paperCache.get(layout)) return layout;
  const entities: Entity[] = [];
  const viewports: LayoutViewport[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (isViewportFrame(e) && e.points.length >= 2 && !seen.has(e.id)) {
      seen.add(e.id);
      viewports.push(viewportFromFrame(e));
    } else if (isViewportFrame(e) || (e as Partial<ViewportFrame>).vport) {
      // Exploded or converted frames stay as plain paper objects.
      const { vport: _drop, ...plain } = e as ViewportFrame;
      entities.push(plain as Entity);
    } else entities.push(e);
  }
  const sameVps = viewports.length === layout.viewports.length && viewports.every((v, i) => v === layout.viewports[i]);
  const sameEnts = entities.length === layout.entities.length && entities.every((e, i) => e === layout.entities[i]);
  if (sameVps && sameEnts) return layout;
  const next: Layout = { ...layout, entities: sameEnts ? layout.entities : entities, viewports: sameVps ? layout.viewports : viewports };
  return next;
}

/** Update one viewport of a layout. */
export function withViewport(layout: Layout, id: string, fn: (vp: LayoutViewport) => LayoutViewport): Layout {
  let changed = false;
  const viewports = layout.viewports.map((v) => {
    if (v.id !== id) return v;
    const n = fn(v);
    if (n !== v) changed = true;
    return n;
  });
  return changed ? { ...layout, viewports } : layout;
}

// ---------------------------------------------------------------- annotative scaling

/** Entities that can be annotative (AutoCAD: text, mtext, dimensions, leaders, block inserts). */
export function canBeAnnotative(e: Entity): boolean {
  return e.type === 'text' || e.type === 'mtext' || e.type === 'dimension' || e.type === 'leader' || e.type === 'insert';
}

export type AnnotationSpace = 'model' | 'paper' | 'viewport';

/**
 * Display factor for an annotative object (the AutoCAD rule: its paper height stays constant).
 * Model space shows it at 1 / CANNOSCALE, a floating viewport at 1 / viewport scale, paper
 * space at 1. Non-annotative objects always get 1.
 */
export function annotativeScaleFor(e: Entity, space: AnnotationSpace, viewportScale: number, cannoscale = 1): number {
  if (!e.annotative || !canBeAnnotative(e)) return 1;
  if (space === 'paper') return 1;
  const k = space === 'viewport' ? viewportScale : cannoscale;
  return k > 0 && Number.isFinite(k) ? 1 / k : 1;
}

// ---------------------------------------------------------------- multileader contexts (P18 slice 3)

/**
 * The primary context of a native multileader as an MLeaderContext record:
 * the entity fields ARE the primary context's representation, materialized so
 * context selection and swapping treat every context uniformly.
 */
export function mleaderPrimaryContext(e: LeaderEntity): MLeaderContext {
  const n = e.mleader!;
  return {
    scaleFactor: n.scaleFactor,
    landingGap: n.landingGap,
    textHeight: e.textHeight,
    arrowSize: e.arrowSize,
    paths: [[...e.vertices], ...(e.extraPaths ?? [])],
    ...(e.dogleg ? { dogleg: e.dogleg } : {}),
    ...(e.text ? { text: e.text } : {}),
    ...(e.raw ? { raw: e.raw } : {}),
    ...(n.textStyleName ? { textStyleName: n.textStyleName } : {}),
    ...(e.textPosition ? { textPosition: e.textPosition } : {}),
    ...(e.textRotation ? { textRotation: e.textRotation } : {}),
    ...(e.textWidth ? { textWidth: e.textWidth } : {}),
    ...(e.textAttachment ? { textAttachment: e.textAttachment } : {}),
    ...(n.block ? { block: { position: n.block.position, scale: n.block.scale, rotation: n.block.rotation } } : {}),
  };
}

/**
 * The context of a native multileader whose scale factor IS the annotation
 * scale `scaleValue` (paper units per model unit — the quantity
 * cannoscaleValue returns for a scale name), or undefined when no context
 * carries that scale. Matching is by canonical scale NAME (formatScale
 * equality at this module's formatting precision), so all scale arithmetic
 * stays in this module (RULING-P18 C4: no private scale mechanism); the
 * primary is searched first, then the additional contexts in file order.
 * For a primary match the returned record is mleaderPrimaryContext(e).
 */
export function mleaderContextForScale(e: LeaderEntity, scaleValue: number): MLeaderContext | undefined {
  const n = e.mleader;
  if (!n || !(scaleValue > 0)) return undefined;
  const target = formatScale(scaleValue);
  if (formatScale(n.scaleFactor) === target) return mleaderPrimaryContext(e);
  return n.contexts?.find((c) => formatScale(c.scaleFactor) === target);
}

/**
 * The multileader as represented by context `ctx`: a pure projection — the
 * entity's geometry, placement and sizes become the context's (a field the
 * context does not carry does NOT leak in from the primary), its native
 * scale becomes the context's, and the remaining contexts (the old primary
 * first, then the others in their relative order) stay on the result, so
 * projecting again at another scale is stable. `ctx` is either the primary
 * view (mleaderPrimaryContext(e) — returns `e` itself) or an element of
 * e.mleader.contexts, as mleaderContextForScale returns. Document state is
 * never written from a projection.
 */
export function leaderWithMLeaderContext(e: LeaderEntity, ctx: MLeaderContext): LeaderEntity {
  const n = e.mleader!;
  const rest = n.contexts ?? [];
  if (!rest.includes(ctx)) return e;
  const remaining = [mleaderPrimaryContext(e), ...rest.filter((c) => c !== ctx)];
  const { vertices: _v, extraPaths: _xp, dogleg: _dg, text: _t, raw: _r, textPosition: _tp, textRotation: _tr, textWidth: _tw, textAttachment: _ta, mleader: _ml, ...base } = e;
  return {
    ...base,
    vertices: ctx.paths[0] ? [...ctx.paths[0]] : [],
    ...(ctx.paths.length > 1 ? { extraPaths: ctx.paths.slice(1).map((p) => [...p]) } : {}),
    ...(ctx.dogleg ? { dogleg: ctx.dogleg } : {}),
    textHeight: ctx.textHeight,
    arrowSize: ctx.arrowSize,
    ...(ctx.text !== undefined ? { text: ctx.text } : {}),
    ...(ctx.raw !== undefined ? { raw: ctx.raw } : {}),
    ...(ctx.textPosition !== undefined ? { textPosition: ctx.textPosition } : {}),
    ...(ctx.textRotation !== undefined ? { textRotation: ctx.textRotation } : {}),
    ...(ctx.textWidth !== undefined ? { textWidth: ctx.textWidth } : {}),
    ...(ctx.textAttachment !== undefined ? { textAttachment: ctx.textAttachment as MTextAttachment } : {}),
    mleader: {
      ...n,
      scaleFactor: ctx.scaleFactor,
      landingGap: ctx.landingGap,
      ...(ctx.textStyleName !== undefined ? { textStyleName: ctx.textStyleName } : {}),
      ...(n.block && ctx.block ? { block: { ...n.block, position: ctx.block.position, scale: ctx.block.scale, rotation: ctx.block.rotation } } : {}),
      contexts: remaining,
    },
  };
}

/** The entity as displayed at annotation factor `f` (sizes scaled about its insertion point). */
export function annotativeEntity(e: Entity, f: number): Entity {
  // P18 slice 3: a multi-context multileader's representation at a scale is
  // its context FOR that scale, not a uniform scaling of the primary — the
  // match is by context identity, so it applies even at f = 1 (1:1 / paper
  // space). No matching context: the uniform scaling below, unchanged.
  if (e.type === 'leader' && f > 0) {
    const le = e as LeaderEntity;
    if (le.mleader?.contexts?.length) {
      const match = mleaderContextForScale(le, 1 / f);
      if (match) return leaderWithMLeaderContext(le, match);
    }
  }
  if (f === 1 || !(f > 0)) return e;
  switch (e.type) {
    case 'text':
      return { ...(e as TextEntity), height: e.height * f, ...(e.alignmentPoint ? { alignmentPoint: g.add(e.position, g.scale(g.sub(e.alignmentPoint, e.position), f)) } : {}) };
    case 'mtext':
      return { ...(e as MTextEntity), height: e.height * f, width: e.width * f, ...(e.columns ? { columns: { ...e.columns, width: e.columns.width * f, gutter: e.columns.gutter * f, heights: e.columns.heights.map((h) => h * f) } } : {}) };
    case 'dimension':
      return { ...(e as DimensionEntity), style: { ...e.style, scale: (e.style.scale || 1) * f } };
    case 'leader':
      return { ...(e as LeaderEntity), textHeight: e.textHeight * f, arrowSize: e.arrowSize * f, ...(e.textWidth ? { textWidth: e.textWidth * f } : {}), ...(e.textColumns ? { textColumns: { ...e.textColumns, width: e.textColumns.width * f, gutter: e.textColumns.gutter * f, heights: e.textColumns.heights.map((h) => h * f) } } : {}) };
    case 'insert': {
      const ins = e as InsertEntity;
      return { ...ins, scale: ins.scale * f, ...(ins.scaleY !== undefined ? { scaleY: ins.scaleY * f } : {}) };
    }
    default:
      return e;
  }
}

/**
 * Is this a usable annotation scale name ("1:4", "1/8\" = 1'-0\"")? Printable, at most 64
 * characters, no markup characters (< > &): a $CANNOSCALE from a file that is not is ignored.
 */
export function isScaleName(name: unknown): name is string {
  return typeof name === 'string' && /^[^\x00-\x1f\x7f<>&]{1,64}$/.test(name) && name.trim() !== '';
}

/** CANNOSCALE as paper units per model unit (header name like "1:4"; default 1). */
export function cannoscaleValue(name: string | undefined): number {
  return (name && parseScale(name)) || 1;
}
