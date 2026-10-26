/**
 * Vector PDF plotting (Track E). One page per plotted sheet (the Model tab, a layout, or
 * every layout), each page a content stream of real PDF paths: lines, polylines (bulge
 * arcs as Bezier curves), circles / arcs / ellipses (Bezier), splines (tessellated),
 * hatches (solid fill or the clipped pattern lines), images (Flate RGB or JPEG, clipped to
 * their boundary) and text (Helvetica for TrueType styles when the text is WinAnsi, the
 * Hershey strokes as paths otherwise). Lineweights are plotted in points (0.25 mm =
 * 0.71 pt), linetypes as dash arrays (LTSCALE, and paper units in layout viewports like
 * PSLTSCALE 1), colours through a plot style (Monochrome, Grayscale, Color, Screening);
 * hidden / frozen / no-plot layers are left out, ByLayer and ByBlock are resolved.
 *
 * Pure module: `plotPages` turns a drawing into page specs, `vectorPdf` writes them. The
 * editor supplies image bitmaps and saves the bytes (src/app/editor/plotting.ts plotOrPrint).
 */
import type { Entity, Layer, BlockLookup, TextEntity, MTextEntity, PolylineEntity, InsertEntity, ImageEntity, HatchEntity, EllipseEntity } from '../core/entities';
import {
  explodeInsert,
  explodeInsertSourced,
  entityBounds,
  polylineSegments,
  dimensionParts,
  mtextParts,
  mtextDecorations,
  mtextMasks,
  ellipseSweep,
  isFullEllipse,
  splinePoints,
  hatchGeometry,
  leaderParts,
  tableParts,
  imageParts,
  imageBoundary,
  underlayParts,
  INFINITE_LENGTH,
  inheritedColor,
} from '../core/entities';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import { underlayDisplayList, type UnderlayDefinition } from '../core/underlay';
import { underlayPlacementOf, type UnderlayEntity } from '../core/entities';
import { polylineWidthGeometry, strokeOutlinePolygons } from '../core/polyline-widths';
import { aciToCss } from '../render/palette';
import { strokeText, strokeTextWidth, expandControlCodes, textRenderer, CAP_HEIGHT_EM } from '../render/hershey';
import { placedText } from '../core/text-placement';
import { metricTextPlacement, textFontKey, type TextAppearance, type TextGeometryContext } from '../core/text-metrics';
import { PdfFontRegistry, utf16Hex, writePdfFontResources, type PdfFontFace, type PdfShapedLine } from './pdf-fonts';
import { hasMTextFill, hasMTextFrame } from '../core/mtext-background';
import { findLinetype, effectiveLinetype, isByBlock, type Linetype } from '../core/linetypes';
import type { TextStyle } from './encoding';
import { textStyleOf, textStylesOf } from './encoding';
import { pdfString } from './pdf';
import {
  annotativeEntity,
  cannoscaleValue,
  layoutsOf,
  findLayout,
  modelToPaper,
  viewTwist,
  sheetSize,
  unitInches,
  viewportPaperBounds,
  printableArea,
  type Layout,
  type PlotStyleMode,
} from '../core/layouts';
import { layoutPage, type PlotOptions } from '../app/plot';
import type { DrawingState } from '../core/document';
import { resolveAlpha } from '../core/appearance';
import { hasHatchGradient, linearHatchGradientPlan, hatchGradientColorRgb, hatchGradientFrameProblem } from '../core/hatch-gradient';
import { expandPlotInsert, expandPlotInsertSourced, plotEntityAppearance, plotObjectProperties } from '../render/plot-appearance';
import { shxTextPaths } from '../render/shx-paths';

// ---------------------------------------------------------------- page model

/** Entities drawn with a uniform scale and planar rotation (page point = k * R(rotation) * p + (e, f)). */
export interface PdfDrawGroup {
  readonly entities: readonly Entity[];
  readonly k: number;
  readonly e: number;
  readonly f: number;
  /** Applied counterclockwise model-to-page angle in radians; omitted = 0. */
  readonly rotation?: number;
  /** Clip rectangle in page points. */
  readonly clip?: { x: number; y: number; w: number; h: number };
  /** Additional native viewport polygon clip in page points (intersected with clip). */
  readonly clipPolygon?: readonly Point[];
  /** Layers left out (off, frozen, no-plot, frozen in this viewport). */
  readonly hidden: ReadonlySet<string>;
  /** Points per linetype pattern unit (model: k; layout viewports: paper units, like PSLTSCALE 1). */
  readonly ltUnit: number;
  /** Display factor of annotative objects in this group (1 / CANNOSCALE, 1 / viewport scale, 1 on paper). */
  readonly annoFactor: number;
  readonly hideAnnotative?: boolean;
  /** Frames of floating viewports (drawn as rectangles when their layer plots). */
  readonly frames?: ReadonlyArray<{ x: number; y: number; w: number; h: number; layer: string; polygon?: readonly Point[] }>;
}

/** Conservative model-space bounds of a group's page clip, shared with font discovery. */
export function pdfGroupView(group: PdfDrawGroup): Bounds | null {
  const r = group.clip;
  if (!r) return null;
  const c = Math.cos(group.rotation ?? 0), s = Math.sin(group.rotation ?? 0);
  const inverse = (x: number, y: number): Point => {
    const dx = (x - group.e) / group.k, dy = (y - group.f) / group.k;
    return { x: c * dx + s * dy, y: -s * dx + c * dy };
  };
  return g.boundsOfPoints([inverse(r.x, r.y), inverse(r.x + r.w, r.y), inverse(r.x + r.w, r.y + r.h), inverse(r.x, r.y + r.h)])!;
}

/** The same top-level culling must apply before reserving bounded PDF font resources. */
export function pdfGroupEntityVisible(entity: Entity, group: PdfDrawGroup, lookup: BlockLookup, view = pdfGroupView(group)): boolean {
  if (group.hidden.has(entity.layer) || (entity.annotative && group.hideAnnotative)) return false;
  if (view && entity.type !== 'xline' && entity.type !== 'ray') {
    const bounds = entityBounds(entity, lookup);
    if (bounds && !g.boundsIntersect(bounds, view)) return false;
  }
  return true;
}

export interface PdfPageSpec {
  /** Page size in points (72 per inch). */
  readonly width: number;
  readonly height: number;
  readonly groups: readonly PdfDrawGroup[];
  readonly label: string;
}

export interface PdfPlotStyle {
  readonly mode: PlotStyleMode;
  /** Screening intensity in percent (the 'screening' mode). */
  readonly screening?: number;
  /** Plot object lineweights; off plots everything at the thinnest line. */
  readonly lineweights: boolean;
  /** Plot with plot styles; off plots the object colours. */
  readonly usePlotStyles: boolean;
  readonly table?: import('../core/plot-styles').PlotStyleTable;
  readonly namedStyle?: string;
  /** Per-plot diagnostics accumulated only for styles actually used. */
  readonly issues?: Set<string>;
}

export interface PdfImageData {
  width: number;
  height: number;
  /** RGB bytes (3 per pixel, top row first; `deflated` when already Flate-compressed) or JPEG file bytes. */
  data: Uint8Array;
  kind: 'rgb' | 'jpeg';
  deflated?: boolean;
}

/** Raster prepared for one underlay definition by the capture layer (design 6.2). */
export interface PdfUnderlayImage {
  readonly data: PdfImageData;
  /** Page size in the referenced file's own units (PDF points). */
  readonly page: { readonly width: number; readonly height: number };
}

export interface PdfDrawingContext {
  readonly layers: readonly Layer[];
  readonly lookup: BlockLookup;
  readonly ltscale: number;
  readonly linetypes: readonly Linetype[];
  readonly textStyles?: Readonly<Record<string, TextStyle>>;
  /** Licensed programs and matching metrics local to this captured vector plot. */
  readonly embeddedFonts?: PdfFontRegistry;
  /** Shaped-line plans for captured text (12.5 step 3), built by
   * the capture layer from prepared shaping state. */
  readonly shapedText?: (text: string, appearance: TextAppearance) => PdfShapedLine | null;
  readonly textGeometry?: TextGeometryContext;
  readonly fontFallbacks?: Set<string>;
  /** Bitmap of an IMAGE entity's file (null: the frame and file name are plotted instead). */
  readonly image?: (path: string) => PdfImageData | null;
  /** The captured state's underlay definitions sibling (frame + label joins, P28). */
  readonly underlays?: Readonly<Record<string, UnderlayDefinition>>;
  /** Prepared page raster for one underlay placement (null: frame parts only). */
  readonly underlayImage?: (e: UnderlayEntity) => PdfUnderlayImage | null;
}

export const MONOCHROME: PdfPlotStyle = { mode: 'monochrome', lineweights: true, usePlotStyles: true };

/** Lineweight in millimetres to points. */
export const mmToPt = (mm: number): number => (mm * 72) / 25.4;

// ---------------------------------------------------------------- plotting a drawing into pages

export interface PlotRequest {
  /** 'model' plots model space with the dialog's paper / scale; a layout name plots that layout's sheet. */
  readonly what: 'model' | 'layouts' | string;
  readonly options: PlotOptions;
}

function hiddenLayers(layers: readonly Layer[]): Set<string> {
  const s = new Set<string>();
  for (const l of layers) if (!l.visible || l.frozen || l.plot === false || l.name.toUpperCase() === 'DEFPOINTS') s.add(l.name);
  return s;
}

/** Model-space extents over plotted layers. */
export function plotExtents(state: DrawingState, lookup: BlockLookup): Bounds | null {
  const hidden = hiddenLayers(state.layers);
  let b: Bounds | null = null;
  for (const e of state.entities) if (!hidden.has(e.layer)) b = g.unionBounds(b, entityBounds(e, lookup));
  return b;
}

/** The Model tab on the dialog's paper (app/plot.ts layoutPage decides sheet, orientation, scale and placement). */
export function modelPageSpec(state: DrawingState, lookup: BlockLookup, opts: PlotOptions): { page: PdfPageSpec; reducedToFit: boolean; sheetInches: { width: number; height: number } } | null {
  const b = plotExtents(state, lookup);
  if (!b) return null;
  const w = Math.max(b.max.x - b.min.x, 1e-9);
  const h = Math.max(b.max.y - b.min.y, 1e-9);
  const lay = layoutPage(w, h, opts);
  const W = lay.sheet.width * 72;
  const H = lay.sheet.height * 72;
  const k = lay.scale * 72;
  const ox = lay.origin.x * 72;
  const oy = lay.origin.y * 72;
  const canno = cannoscaleValue(state.header?.cannoscale);
  const page: PdfPageSpec = {
    width: W,
    height: H,
    label: 'Model',
    groups: [{ entities: state.entities, k, e: ox - b.min.x * k, f: H - oy - b.max.y * k, hidden: hiddenLayers(state.layers), ltUnit: k, annoFactor: 1 / canno }],
  };
  return { page, reducedToFit: lay.reducedToFit, sheetInches: lay.sheet };
}

/** A layout's sheet: paper-space entities 1:1 (or fitted), each viewport's model space clipped at its scale. */
export function layoutPageSpec(state: DrawingState, layout: Layout, lookup: BlockLookup): PdfPageSpec {
  const sheet = sheetSize(layout);
  const u = 72 * unitInches(layout.paper.units); // points per paper unit
  let pk = u;
  let pe = 0;
  let pf = 0;
  if (layout.plotScale === 'fit') {
    let b: Bounds | null = null;
    for (const e of layout.entities) b = g.unionBounds(b, entityBounds(e, lookup));
    for (const v of layout.viewports) b = g.unionBounds(b, viewportPaperBounds(v));
    const area = printableArea(layout);
    if (b) {
      const s = Math.min((area.max.x - area.min.x) / Math.max(b.max.x - b.min.x, 1e-9), (area.max.y - area.min.y) / Math.max(b.max.y - b.min.y, 1e-9));
      pk = u * s;
      pe = u * ((area.min.x + area.max.x) / 2) - pk * ((b.min.x + b.max.x) / 2);
      pf = u * ((area.min.y + area.max.y) / 2) - pk * ((b.min.y + b.max.y) / 2);
    }
  } else {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(layout.plotScale);
    if (m && Number(m[1]) > 0 && Number(m[2]) > 0) pk = (u * Number(m[1])) / Number(m[2]);
  }
  const hidden = hiddenLayers(state.layers);
  const canno = cannoscaleValue(state.header?.cannoscale);
  const groups: PdfDrawGroup[] = [];
  const frames: Array<{ x: number; y: number; w: number; h: number; layer: string; polygon?: readonly Point[] }> = [];
  for (const v of layout.viewports) {
    const vb = viewportPaperBounds(v);
    const rect = { x: pe + pk * vb.min.x, y: pf + pk * vb.min.y, w: pk * v.width, h: pk * v.height };
    const polygon = v.clipOn !== false ? v.clipBoundary?.points.map((p) => ({ x: pe + pk * p.x, y: pf + pk * p.y })) : undefined;
    if (!polygon) frames.push({ ...rect, layer: v.layer });
    if (!v.on) continue;
    const s = v.view.scale;
    const rotation = viewTwist(v.view);
    const origin = modelToPaper(v, { x: 0, y: 0 });
    groups.push({
      entities: state.entities,
      k: pk * s,
      e: pe + pk * origin.x,
      f: pf + pk * origin.y,
      ...(rotation ? { rotation } : {}),
      clip: rect,
      ...(polygon ? { clipPolygon: polygon } : {}),
      hidden: new Set([...hidden, ...(v.frozenLayers ?? [])]),
      ltUnit: pk,
      annoFactor: 1 / s,
      hideAnnotative: state.header?.annoAllVisible === false && Math.abs(s - canno) > 1e-9,
    });
  }
  const paperEntities = [...layout.entities, ...layout.viewports.flatMap((v) => v.clipBoundary ? [v.clipBoundary] : [])];
  groups.push({ entities: paperEntities, k: pk, e: pe, f: pf, hidden, ltUnit: pk, annoFactor: 1, frames });
  return { width: sheet.width * u, height: sheet.height * u, groups, label: layout.name };
}

/** Plot style of a layout's page setup. */
export function layoutPlotStyle(layout: Layout): PdfPlotStyle {
  return { mode: layout.plotStyle ?? 'monochrome', screening: layout.screening, lineweights: layout.plotLineweights !== false, usePlotStyles: layout.usePlotStyles !== false };
}

/** Pages for a request: Model with the dialog settings, one layout, or all layouts (tab order). */
export function plotPages(state: DrawingState, lookup: BlockLookup, what: 'model' | 'layouts' | string, opts: PlotOptions): PdfPageSpec[] {
  if (what === 'model') {
    const m = modelPageSpec(state, lookup, opts);
    return m ? [m.page] : [];
  }
  const layouts = what === 'layouts' ? layoutsOf(state) : [findLayout(state, what)].filter((l): l is Layout => !!l);
  return layouts.map((l) => layoutPageSpec(state, l, lookup));
}

// ---------------------------------------------------------------- colours, widths, dashes

function hexRgb(css: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** Object colour on white paper: ACI 7 (white / black) plots black. */
function objectRgb(color: number | 'ByLayer', trueColor: number | undefined, layer: Layer | undefined): [number, number, number] {
  const rgbOf = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  if (trueColor !== undefined) return rgbOf(trueColor);
  if (color === 'ByLayer' && layer?.trueColor !== undefined) return rgbOf(layer.trueColor);
  const aci = color === 'ByLayer' ? (layer?.color ?? 7) : color;
  if (aci === 7 || aci === 0) return [0, 0, 0];
  return hexRgb(aciToCss(aci));
}

/** Apply the plot style to an object colour. */
export function plotColor(rgb: [number, number, number], style: PdfPlotStyle): [number, number, number] {
  if (!style.usePlotStyles) return rgb;
  // Table object styles require the source ACI identity; RGB-only resources retain their colors.
  if (style.table) return rgb;
  switch (style.mode) {
    case 'monochrome':
      return [0, 0, 0];
    case 'grayscale': {
      const y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      return [y, y, y];
    }
    case 'screening': {
      const s = Math.max(0, Math.min(100, style.screening ?? 50)) / 100;
      return rgb.map((c) => 1 - (1 - c) * s) as [number, number, number];
    }
    default:
      return rgb;
  }
}

const n = (v: number): string => {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
};
const rgbOp = (c: [number, number, number], op: 'RG' | 'rg'): string => `${n(c[0])} ${n(c[1])} ${n(c[2])} ${op}`;

// ---------------------------------------------------------------- Helvetica metrics (WinAnsi, /1000 em)

const HELV: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD_EXTRA = 1.06;

function helveticaWidth(text: string, bold: boolean): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32]! : 556;
  }
  return (w / 1000) * (bold ? HELV_BOLD_EXTRA : 1);
}

/** Text Helvetica can show with WinAnsiEncoding (printable ASCII and Latin-1). */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (!((c >= 32 && c <= 126) || (c >= 160 && c <= 255))) return false;
  }
  return true;
}

function pdfLiteral(text: string): string {
  let out = '(';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c > 126) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

// ---------------------------------------------------------------- content stream writer

interface ImageRes {
  name: string;
  data: PdfImageData;
}

interface VectorForm {
  name: string;
  content: string;
  width: number;
  height: number;
}

interface GradientRes {
  name: string;
  colors: readonly [[number, number, number], [number, number, number]];
}

/** Content stream builder for one page. */
class PageWriter {
  readonly ops: string[] = [];
  readonly images: ImageRes[] = [];
  readonly fonts = new Set<string>();
  readonly forms: VectorForm[] = [];
  readonly gradients: GradientRes[] = [];
  readonly alphas = new Set<number>();
  private alpha = 255;
  private stroke = '';
  private fill = '';
  private width = '';
  private dash = '';
  private tf = { k: 1, e: 0, f: 0, rotation: 0, c: 1, s: 0 };
  private group: PdfDrawGroup | null = null;
  /** Layer table in force for the entity being styled — a referenced file's own table while its segment is written (A.2); null = the drawing context's (host) table. */
  private activeLayers: readonly Layer[] | null = null;
  pathOps = 0;

  constructor(
    private readonly ctx: PdfDrawingContext,
    private readonly style: PdfPlotStyle,
    private readonly page: PdfPageSpec,
  ) {}

  private resetState(): void {
    this.stroke = '';
    this.fill = '';
    this.width = '';
    this.dash = '';
    this.alpha = 255;
  }

  private P(p: Point): string {
    if (this.tf.rotation) {
      const q = this.pt(p);
      return `${n(q.x)} ${n(q.y)}`;
    }
    return `${n(this.tf.k * p.x + this.tf.e)} ${n(this.tf.k * p.y + this.tf.f)}`;
  }
  private pt(p: Point): Point {
    if (this.tf.rotation) {
      const { k, e, f, c, s } = this.tf;
      return { x: k * (c * p.x - s * p.y) + e, y: k * (s * p.x + c * p.y) + f };
    }
    return { x: this.tf.k * p.x + this.tf.e, y: this.tf.k * p.y + this.tf.f };
  }

  run(): void {
    this.ops.push('1 J 1 j');
    for (const grp of this.page.groups) {
      this.group = grp;
      const rotation = grp.rotation ?? 0;
      this.tf = { k: grp.k, e: grp.e, f: grp.f, rotation, c: Math.cos(rotation), s: Math.sin(rotation) };
      this.ops.push('q');
      this.resetState();
      if (grp.clip) this.ops.push(`${n(grp.clip.x)} ${n(grp.clip.y)} ${n(grp.clip.w)} ${n(grp.clip.h)} re W n`);
      if (grp.clipPolygon) this.ops.push(`${this.pagePolygon(grp.clipPolygon)} W* n`);
      const view = pdfGroupView(grp);
      for (const e of grp.entities) {
        if (!pdfGroupEntityVisible(e, grp, this.ctx.lookup, view)) continue;
        const shown = e.annotative && grp.annoFactor !== 1 ? annotativeEntity(e, grp.annoFactor) : e;
        this.entity(shown, null, view);
      }
      this.ops.push('Q');
      if (grp.frames) this.frames(grp);
    }
  }

  private frames(grp: PdfDrawGroup): void {
    for (const f of grp.frames ?? []) {
      if (grp.hidden.has(f.layer)) continue;
      const layer = this.ctx.layers.find((l) => l.name === f.layer);
      this.ops.push('q');
      this.resetState();
      const appearance = this.style.table ? this.tableAppearance({ layer: f.layer, color: 'ByLayer' }) : undefined;
      this.setStroke(appearance ? [...appearance.rgb] : plotColor(objectRgb('ByLayer', undefined, layer), this.style));
      this.setAlpha(resolveAlpha({ layer: f.layer }, this.ctx.layers));
      this.setWidth(this.style.lineweights ? mmToPt(appearance?.lineweightMm ?? layer?.lineWeight ?? 0.25) : 0);
      this.ops.push(f.polygon ? `${this.pagePolygon(f.polygon)} S` : `${n(f.x)} ${n(f.y)} ${n(f.w)} ${n(f.h)} re S`);
      this.pathOps += 1;
      this.ops.push('Q');
    }
  }

  private pagePolygon(points: readonly Point[]): string {
    return points.map((p, i) => `${n(p.x)} ${n(p.y)} ${i ? 'l' : 'm'}`).join(' ') + ' h';
  }

  private setStroke(c: [number, number, number]): void {
    const op = rgbOp(c, 'RG');
    if (op !== this.stroke) {
      this.ops.push(op);
      this.stroke = op;
    }
  }
  private setFill(c: [number, number, number]): void {
    const op = rgbOp(c, 'rg');
    if (op !== this.fill) {
      this.ops.push(op);
      this.fill = op;
    }
  }
  private setWidth(w: number): void {
    const op = `${n(w)} w`;
    if (op !== this.width) {
      this.ops.push(op);
      this.width = op;
    }
  }
  private setDash(d: readonly number[]): void {
    const op = `[${d.map(n).join(' ')}] 0 d`;
    if (op !== this.dash) {
      this.ops.push(op);
      this.dash = op;
    }
  }

  private setAlpha(alpha: number): void {
    const byte = Math.round(alpha * 255);
    if (byte === this.alpha) return;
    this.alphas.add(byte);
    this.ops.push(`/A${byte} gs`);
    this.alpha = byte;
  }

  // ---- entity properties (ByLayer / ByBlock resolved against the parent insert)
  private layersNow(): readonly Layer[] {
    return this.activeLayers ?? this.ctx.layers;
  }

  private layer(name: string): Layer | undefined {
    return this.layersNow().find((l) => l.name === name);
  }

  private applyStyle(e: Entity, parent: InsertEntity | null): void {
    this.setAlpha(resolveAlpha(e, this.layersNow()));
    const layer = this.layer(e.layer);
    // Block content arrives resolved from explodeInsert (core/entities.ts inheritedColor): ByBlock
    // objects carry the reference's colour, or `colorLayer` (the reference's layer) when it is ByLayer.
    const appearance = this.style.table ? this.tableAppearance(e, parent ? plotObjectProperties(parent, this.layersNow()).lineweightMm : undefined) : undefined;
    const rgb: [number, number, number] = appearance ? [...appearance.rgb] : plotColor(objectRgb(e.color, e.trueColor, e.colorLayer !== undefined ? this.layer(e.colorLayer) : layer), this.style);
    this.setStroke(rgb);
    this.setFill(rgb);
    let mm = e.lineWeight;
    if (mm === -2 && parent) mm = parent.lineWeight;
    if (mm === undefined || mm === -1) mm = layer?.lineWeight ?? 0.25;
    if (mm < 0) mm = 0.25;
    this.setWidth(this.style.lineweights ? mmToPt(appearance?.lineweightMm ?? mm) : 0);
    let lt = e.linetype;
    if (isByBlock(lt) && parent) lt = parent.linetype;
    const name = effectiveLinetype(lt, layer?.linetype);
    const def = findLinetype(name, this.ctx.linetypes);
    this.setDash(def ? dashPattern(def.pattern, this.ctx.ltscale * (e.ltscale ?? 1) * (this.group?.ltUnit ?? 1)) : []);
  }

  private tableAppearance(entity: Parameters<typeof plotEntityAppearance>[0], inheritedLineweightMm?: number) {
    const result = plotEntityAppearance(entity, this.layersNow(), this.style.table!, this.style, inheritedLineweightMm);
    for (const issue of result.issues) this.style.issues?.add(`${issue.path}: ${issue.message}`);
    return result;
  }

  private entity(e: Entity, parent: InsertEntity | null, view: Bounds | null): void {
    if (e.type === 'insert') {
      // Resolved-xref content (design A.2, #58 review P2(2)): when the
      // lookup carries per-file provenance, expand ONCE with per-entity
      // source tags and style each entity against its own file's
      // table. Host content keeps group.hidden exactly; referenced
      // content is culled by the plot hidden-layer rule applied to its
      // own table; a layer name the file does not define falls back to
      // the ambient table (layer-0 content floated to the insert's host
      // layer). No table is merged into the host's.
      const sources = this.ctx.lookup.sources;
      if (sources) {
        const sourced = this.style.table ? expandPlotInsertSourced(e, this.ctx.lookup, this.ctx.layers) : explodeInsertSourced(e, this.ctx.lookup);
        for (const { entity: sub, source } of sourced) {
          const fileTable = source === undefined ? this.ctx.layers : sources.fileLayers(source);
          const subTable = source === undefined || fileTable.some((l) => l.name === sub.layer) ? fileTable : this.ctx.layers;
          if (source === undefined || subTable === this.ctx.layers) { if (this.group?.hidden.has(sub.layer)) continue; }
          else if (hiddenLayers(subTable).has(sub.layer)) continue;
          const prev = this.activeLayers;
          this.activeLayers = subTable;
          try { this.entity(sub, e, view); } finally { this.activeLayers = prev; }
        }
        return;
      }
      for (const sub of this.style.table ? expandPlotInsert(e, this.ctx.lookup, this.ctx.layers) : explodeInsert(e, this.ctx.lookup)) {
        if (this.group?.hidden.has(sub.layer)) continue;
        this.entity(sub, e, view);
      }
      return;
    }
    this.applyStyle(e, parent);
    this.geometry(e, parent, view);
  }

  /** Sub-parts (dimension, leader, table, formatted MTEXT) keep the parent's colour unless they set their own. */
  private parts(parts: readonly Entity[], owner: Entity, parent: InsertEntity | null, view: Bounds | null): void {
    for (const p of parts) {
      const styled = this.style.table ? (p.color === 0 ? { ...p, ...inheritedColor(p, owner) } as Entity : p)
        : p.color === 'ByLayer' && p.trueColor === undefined ? ({ ...p, color: owner.color, trueColor: owner.trueColor, layer: owner.layer, colorLayer: owner.colorLayer, lineWeight: p.lineWeight ?? owner.lineWeight } as Entity) : p;
      this.applyStyle(styled, parent);
      this.geometry(styled, parent, view);
    }
  }

  private geometry(e: Entity, parent: InsertEntity | null, view: Bounds | null): void {
    const o = this.ops;
    switch (e.type) {
      case 'line':
        o.push(`${this.P(e.a)} m ${this.P(e.b)} l S`);
        this.pathOps += 1;
        break;
      case 'circle':
        this.arcPath(e.center, e.radius, 0, 2 * Math.PI, true);
        o.push(e.filled ? 'f' : 'h S');
        this.pathOps += 1;
        break;
      case 'arc': {
        let sweep = g.normAngle(e.endAngle - e.startAngle);
        if (sweep < g.EPS) sweep = 2 * Math.PI;
        this.arcPath(e.center, e.radius, e.startAngle, sweep, true);
        o.push('S');
        this.pathOps += 1;
        break;
      }
      case 'polyline':
        this.polyline(e, this.alpha);
        break;
      case 'ellipse':
        this.ellipse(e);
        break;
      case 'spline': {
        const pts = splinePoints(e);
        if (pts.length >= 2) this.polyPath(pts, e.closed, 'S');
        break;
      }
      case 'text':
        this.text(e);
        break;
      case 'mtext':
        this.mtextBackground(e);
        this.parts([...mtextParts(e, this.ctx.textGeometry), ...mtextDecorations(e, this.ctx.textGeometry)], e, parent, view);
        break;
      case 'dimension':
        this.parts(dimensionParts(e, this.ctx.textGeometry), e, parent, view);
        break;
      case 'leader':
        for (const part of leaderParts(e, this.ctx.textGeometry)) if (!this.group?.hidden.has(part.layer)) this.entity(part, parent, view);
        break;
      case 'table':
        this.parts(tableParts(e, this.ctx.textGeometry), e, parent, view);
        break;
      case 'hatch':
        this.hatch(e);
        break;
      case 'image':
        this.image(e, parent, view);
        break;
      case 'underlay':
        this.underlay(e, parent, view);
        break;
      case 'point': {
        const p = this.P(e.position);
        o.push(`q ${n(Math.max(1, Number(this.width.split(' ')[0]) || 1))} w ${p} m ${p} l S Q`);
        this.pathOps += 1;
        break;
      }
      case 'xline':
      case 'ray': {
        const d = g.normalize(e.direction);
        const span = view ? Math.max(view.max.x - view.min.x, view.max.y - view.min.y) * 2 + g.dist(e.base, { x: (view.min.x + view.max.x) / 2, y: (view.min.y + view.max.y) / 2 }) : INFINITE_LENGTH;
        const a = e.type === 'ray' ? e.base : g.add(e.base, g.scale(d, -span));
        const b = g.add(e.base, g.scale(d, span));
        o.push(`${this.P(a)} m ${this.P(b)} l S`);
        this.pathOps += 1;
        break;
      }
      case 'insert':
        this.entity(e, parent, view);
        break;
    }
  }

  /** Bezier arcs (at most 90 degrees each); `move` starts a new subpath at the arc start. */
  private arcPath(c: Point, r: number, start: number, sweep: number, move: boolean): void {
    const segs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / segs;
    const kappa = (4 / 3) * Math.tan(step / 4);
    let a0 = start;
    const at = (a: number) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    if (move) this.ops.push(`${this.P(at(a0))} m`);
    for (let i = 0; i < segs; i += 1) {
      const a1 = a0 + step;
      const p0 = at(a0);
      const p3 = at(a1);
      const c1 = { x: p0.x - kappa * r * Math.sin(a0), y: p0.y + kappa * r * Math.cos(a0) };
      const c2 = { x: p3.x + kappa * r * Math.sin(a1), y: p3.y - kappa * r * Math.cos(a1) };
      this.ops.push(`${this.P(c1)} ${this.P(c2)} ${this.P(p3)} c`);
      a0 = a1;
    }
  }

  private mtextBackground(e: MTextEntity): void {
    const bg = e.background;
    if (!bg) return;
    const masks = mtextMasks(e, this.ctx.textGeometry);
    if (!masks.length) return;
    // The drawing-window mask becomes white paper, including under monochrome plotting.
    const rgb: [number, number, number] = bg.flags & 2 ? [1, 1, 1] : this.style.table ? [...this.tableAppearance({ ...e, color: bg.color, trueColor: bg.trueColor, colorLayer: bg.colorLayer }).rgb]
      : plotColor(objectRgb(bg.color, bg.trueColor, this.layer(bg.colorLayer ?? e.layer)), this.style);
    this.ops.push(`q ${rgbOp(rgb, 'rg')}`);
    const paint = hasMTextFill(e) ? (hasMTextFrame(e) ? 'B' : 'f') : 'S';
    for (const mask of masks) this.polyPath(mask, true, paint);
    this.ops.push('Q');
  }

  private polyPath(pts: readonly Point[], closed: boolean, paint: string): void {
    const parts = [`${this.P(pts[0]!)} m`];
    for (let i = 1; i < pts.length; i += 1) parts.push(`${this.P(pts[i]!)} l`);
    if (closed) parts.push('h');
    parts.push(paint);
    this.ops.push(parts.join(' '));
    this.pathOps += 1;
  }

  private compoundPath(paths: readonly (readonly Point[])[], closed: boolean, paint: string): void {
    const parts: string[] = [];
    for (const pts of paths) {
      if (!pts.length) continue;
      parts.push(`${this.P(pts[0]!)} m`);
      for (let i = 1; i < pts.length; i++) parts.push(`${this.P(pts[i]!)} l`);
      if (closed) parts.push('h');
    }
    if (!parts.length) return;
    this.ops.push(`${parts.join(' ')} ${paint}`);
    this.pathOps += 1;
  }

  private polyline(e: PolylineEntity, opacityByte = 255): void {
    if (e.points.length === 0) return;
    if ((e.widths || e.widthFrame) && !e.filled) {
      const geometry = polylineWidthGeometry(e);
      const dashed = this.dash && this.dash !== '[] 0 d';
      if (!geometry.polygons.length) {
        this.compoundPath(geometry.thin, false, 'S');
        return;
      }
      const thinWidth = Number.parseFloat(this.width) / this.tf.k;
      const polygons = [...geometry.polygons, ...strokeOutlinePolygons(geometry.thin, thinWidth)];
      const isolate = opacityByte < 255 && ((dashed && geometry.strokes.length + Number(geometry.thin.length > 0) > 1) || (!thinWidth && geometry.thin.length > 0));
      const groupStart = this.ops.length;
      if (dashed) {
        // Keep each varying-width segment's own mask. A global maximum-width mask can
        // paint into a nearby segment's gap, even with a compound clip.
        for (const { polygon, spines } of geometry.strokes) {
          this.ops.push('q');
          this.polyPath(polygon, true, 'W n');
          this.ops.push(`${n(Math.min(Number.MAX_VALUE, geometry.maxWidth * this.tf.k))} w`);
          this.compoundPath(spines, false, 'S');
          this.ops.push('Q');
        }
        this.compoundPath(geometry.thin, false, 'S');
      } else this.compoundPath(polygons, true, 'f');
      // A PDF hairline has device-dependent width. The colors integration isolates
      // this mixed case in a vector transparency group instead of inventing a width.
      if (!dashed && !thinWidth) this.compoundPath(geometry.thin, false, 'S');
      if (isolate) {
        if (![this.page.width, this.page.height].every((size) => Number.isFinite(size) && size > 0 && size <= 14400)) throw new Error('Translucent polyline exceeds the bounded PDF page area.');
        const body = this.ops.splice(groupStart).join('\n');
        if (body.length > 64 * 1024 * 1024) throw new Error('Translucent polyline exceeds the PDF form work budget.');
        const name = `Wide${this.forms.length}`;
        this.forms.push({ name, width: this.page.width, height: this.page.height, content: `q /Opaque gs ${this.stroke} ${this.fill} ${this.width} ${this.dash}\n${body}\nQ` });
        this.ops.push(`/${name} Do`);
      }
      return;
    }
    this.ops.push(`${this.P(e.points[0]!)} m`);
    for (const s of polylineSegments(e)) {
      // Bulge arcs from vertex a to b with the signed included angle (negative = clockwise).
      if (s.arc) this.arcPath(s.arc.center, s.arc.radius, g.angleOf(s.arc.center, s.a), s.arc.sweep, false);
      else this.ops.push(`${this.P(s.b)} l`);
    }
    if (e.closed) this.ops.push('h');
    if (e.filled && e.closed) {
      this.ops.push('f');
    } else if (e.width && e.width > 0) {
      this.ops.push(`q ${n(e.width * this.tf.k)} w 1 J 1 j S Q`);
    } else this.ops.push('S');
    this.pathOps += 1;
  }

  private ellipse(e: EllipseEntity): void {
    const a = e.majorAxis;
    const b = { x: -a.y * e.ratio, y: a.x * e.ratio };
    const full = isFullEllipse(e);
    const start = full ? 0 : e.startParam;
    const sweep = full ? 2 * Math.PI : ellipseSweep(e);
    const segs = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
    const step = sweep / segs;
    const kappa = (4 / 3) * Math.tan(step / 4);
    const at = (t: number) => ({ x: e.center.x + a.x * Math.cos(t) + b.x * Math.sin(t), y: e.center.y + a.y * Math.cos(t) + b.y * Math.sin(t) });
    const d = (t: number) => ({ x: -a.x * Math.sin(t) + b.x * Math.cos(t), y: -a.y * Math.sin(t) + b.y * Math.cos(t) });
    const parts = [`${this.P(at(start))} m`];
    let t0 = start;
    for (let i = 0; i < segs; i += 1) {
      const t1 = t0 + step;
      const p0 = at(t0);
      const p3 = at(t1);
      const d0 = d(t0);
      const d1 = d(t1);
      parts.push(`${this.P({ x: p0.x + kappa * d0.x, y: p0.y + kappa * d0.y })} ${this.P({ x: p3.x - kappa * d1.x, y: p3.y - kappa * d1.y })} ${this.P(p3)} c`);
      t0 = t1;
    }
    parts.push(full ? 'h S' : 'S');
    this.ops.push(parts.join(' '));
    this.pathOps += 1;
  }

  private hatch(e: HatchEntity): void {
    const geo = hatchGeometry(e);
    if (e.solid || hasHatchGradient(e) || geo.dense) {
      const parts: string[] = [];
      for (const poly of geo.polys) {
        parts.push(`${this.P(poly[0]!)} m`);
        for (let i = 1; i < poly.length; i += 1) parts.push(`${this.P(poly[i]!)} l`);
        parts.push('h');
      }
      if (!parts.length) return;
      const gradient = linearHatchGradientPlan(e, geo.polys);
      if (gradient) {
        if (this.style.table && this.style.usePlotStyles) this.style.issues?.add('Gradient hatches retain their stored colors; CTB/STB effects on gradients are not verified.');
        const name = `G${this.gradients.length + 1}`;
        const colors = gradient.colors.map((color) => {
          const rgb = hatchGradientColorRgb(color, (aci) => {
            const values = objectRgb(aci, undefined, undefined);
            return (Math.round(values[0] * 255) << 16) | (Math.round(values[1] * 255) << 8) | Math.round(values[2] * 255);
          })!;
          return plotColor([((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255], this.style);
        }) as [[number, number, number], [number, number, number]];
        const origin = this.pt(gradient.frame.origin);
        const x = g.sub(this.pt(g.add(gradient.frame.origin, gradient.frame.x)), origin);
        const y = g.sub(this.pt(g.add(gradient.frame.origin, gradient.frame.y)), origin);
        if (hatchGradientFrameProblem({ origin, x, y })) throw new Error('Cannot plot hatch gradient: its page transform exceeds finite or nondegenerate coordinate limits.');
        const matrix = [x.x, x.y, y.x, y.y, origin.x, origin.y].map(n);
        const values = matrix.map(Number);
        const encoded = { x: { x: values[0]!, y: values[1]! }, y: { x: values[2]!, y: values[3]! }, origin: { x: values[4]!, y: values[5]! } };
        if (matrix.some((value) => /e/i.test(value)) || hatchGradientFrameProblem(encoded)) throw new Error('Cannot plot hatch gradient: its page transform exceeds native PDF numeric precision.');
        this.gradients.push({ name, colors });
        this.ops.push(`q ${parts.join(' ')} W* n ${matrix.join(' ')} cm /${name} sh Q`);
        this.pathOps += 1;
        return;
      }
      parts.push('f*');
      this.ops.push(parts.join(' '));
      this.pathOps += 1;
      return;
    }
    // Pattern lines are already clipped to the boundary; hatch lines plot continuous.
    this.setDash([]);
    const parts: string[] = [];
    for (const [a, b] of geo.segments) parts.push(`${this.P(a)} m ${this.P(b)} l`);
    if (!parts.length) return;
    for (let i = 0; i < parts.length; i += 400) {
      this.ops.push(`${parts.slice(i, i + 400).join(' ')} S`);
      this.pathOps += 1;
    }
  }

  private underlay(e: UnderlayEntity, parent: InsertEntity | null, view: Bounds | null): void {
    // P28 finish (design 6.2): with a prepared raster the placement plots its
    // page image; without one it plots exactly the frame parts it always did.
    const defs = this.ctx.underlays;
    const def = defs ? Object.values(defs).find((d) => (d.handle ?? '').toUpperCase() === e.definitionHandle) : undefined;
    const hit = def ? this.ctx.underlayImage?.(e) ?? null : null;
    if (!def || !hit) {
      this.parts(underlayParts(e), e, parent, view);
      return;
    }
    // D3: an AutoCAD-read definition carries no extent, so the display
    // list would frame the image at the 1x1 unit fallback. Substitute
    // the loaded page size, exactly as the screen path
    // (underlay-render contentFor) and the plot resolver's source
    // already do — a stored extent still wins.
    const framedDef = def.extent ? def : { ...def, extent: hit.page };
    const ops = underlayDisplayList(underlayPlacementOf(e), framedDef, { width: hit.page.width, height: hit.page.height });
    const styleProps = { layer: e.layer, color: e.color, linetype: e.linetype, lineWeight: e.lineWeight };
    const frameParts: Entity[] = [];
    for (const op of ops) {
      if (op.op === 'frame' || op.op === 'clip-frame') {
        frameParts.push({ ...styleProps, id: `${e.id}:${op.op}`, type: 'polyline', points: [...op.points], closed: true } as Entity);
      }
    }
    this.parts(frameParts, e, parent, view);
    const img = ops.find((o) => o.op === 'image');
    if (!img || img.op !== 'image') return;
    const [ll, lr, , ul] = img.corners;
    if (!ll || !lr || !ul) return;
    const name = `Im${this.images.length}`;
    this.images.push({ name, data: hit.data });
    const A = this.pt(ll);
    const B = this.pt(lr);
    const D = this.pt(ul);
    const clipOp = ops.find((o) => o.op === 'clip-frame');
    const clip = clipOp ? `${[`${this.P(clipOp.points[0]!)} m`, ...clipOp.points.slice(1).map((p) => `${this.P(p)} l`), 'h W n'].join(' ')} ` : '';
    // Placement fade is NOT applied: a plain image XObject carries no alpha
    // in this writer (the IMAGE posture); an ExtGState/SMask fade is a
    // separate project (design 6.2, recorded there).
    this.ops.push(`q ${clip}${n(B.x - A.x)} ${n(B.y - A.y)} ${n(D.x - A.x)} ${n(D.y - A.y)} ${n(A.x)} ${n(A.y)} cm /${name} Do Q`);
  }

  private image(e: ImageEntity, parent: InsertEntity | null, view: Bounds | null): void {
    const data = this.ctx.image?.(e.path) ?? null;
    if (!data) {
      this.parts(imageParts(e), e, parent, view);
      return;
    }
    const name = `Im${this.images.length}`;
    this.images.push({ name, data });
    const boundary = imageBoundary(e);
    const clip = [`${this.P(boundary[0]!)} m`, ...boundary.slice(1).map((p) => `${this.P(p)} l`), 'h W n'].join(' ');
    const o = this.pt(e.position);
    const { k, c, s } = this.tf;
    const ux = (c * e.u.x - s * e.u.y) * e.size.x * k;
    const uy = (s * e.u.x + c * e.u.y) * e.size.x * k;
    const vx = (c * e.v.x - s * e.v.y) * e.size.y * k;
    const vy = (s * e.v.x + c * e.v.y) * e.size.y * k;
    this.ops.push(`q ${clip} ${n(ux)} ${n(uy)} ${n(vx)} ${n(vy)} ${n(o.x)} ${n(o.y)} cm /${name} Do Q`);
  }

  /**
   * Emit one prepared shaped line (12.5 step 3): a single
   * marked-content span whose ActualText is the line's complete
   * logical text (§5.4), holding per-segment text ops in visual
   * order. Shaped glyphs are placed individually — their own Tm
   * per glyph, computed in text-direction space and mirrored for
   * RTL items — because GPOS offsets have no Tj/TJ equivalent.
   * Direct segments keep their direct codes as one Tj at their
   * visual position.
   */
  private shapedLine(e: TextEntity, plan: PdfShapedLine, face: PdfFontFace): void {
    const placed = metricTextPlacement(e, this.ctx.textGeometry!);
    const t = placed.text, wf = t.widthFactor ?? 1, slant = Math.tan(t.oblique ?? 0);
    const size = t.height * this.tf.k * face.metrics.unitsPerEm / face.metrics.capitalHeight;
    const c = Math.cos(t.rotation + this.tf.rotation), s = Math.sin(t.rotation + this.tf.rotation);
    const p = this.pt(t.position), off = placed.offset * wf * this.tf.k;
    const a = wf * c, b = wf * s, cc = slant * c - s, d = slant * s + c;
    const ox = p.x + off * c, oy = p.y + off * s;
    const fmt = (value: number): string => {
      if (!Number.isFinite(value) || Math.abs(value) >= 1e21) throw new Error('PDF text transform exceeds the supported numeric range.');
      const result = value.toFixed(6).replace(/\.?0+$/, '');
      return result === '-0' || !result ? '0' : result;
    };
    const code4 = (code: number): string => code.toString(16).toUpperCase().padStart(4, '0');
    const upem = face.metrics.unitsPerEm;
    const totalEm = plan.segments.reduce((sum, segment) => sum + segment.advance / upem, 0);
    let visualPen = 0;
    const ops: string[] = [];
    for (const segment of plan.segments) {
      const segmentEm = segment.advance / upem;
      const segmentLeft = plan.baseDirection === 'rtl' ? totalEm - visualPen - segmentEm : visualPen;
      visualPen += segmentEm;
      this.fonts.add(segment.resourceName);
      ops.push(`/${segment.resourceName} ${fmt(size)} Tf`);
      if (segment.kind === 'direct') {
        // Tm translations are user-space units: an em offset is
        // size user units along the text direction.
        ops.push(`${fmt(a)} ${fmt(b)} ${fmt(cc)} ${fmt(d)} ${fmt(ox + size * a * segmentLeft)} ${fmt(oy + size * b * segmentLeft)} Tm <${segment.hex}> Tj`);
        continue;
      }
      let pen = 0, penY = 0;
      for (const glyph of segment.glyphs) {
        const posTd = pen + glyph.xOffset;
        const u = segment.direction === 'ltr'
          ? segmentLeft + posTd / upem
          : segmentLeft + segmentEm - (posTd + glyph.xAdvance) / upem;
        const v = (penY + glyph.yOffset) / upem;
        ops.push(`${fmt(a)} ${fmt(b)} ${fmt(cc)} ${fmt(d)} ${fmt(ox + size * (a * u + cc * v))} ${fmt(oy + size * (b * u + d * v))} Tm <${code4(glyph.code)}> Tj`);
        pen += glyph.xAdvance;
        penY += glyph.yAdvance;
      }
    }
    this.ops.push(`/Span <</ActualText <FEFF${utf16Hex(plan.logicalText)}>>> BDC BT ${ops.join(' ')} ET EMC`);
  }

  private text(e: TextEntity): void {
    const raw = e.text.includes('%%') ? e.text.replace(/%%[uUoOkK]/g, '') : e.text;
    const text = expandControlCodes(raw);
    if (!text.trim()) return;
    const appearance = this.ctx.textGeometry?.resolve(e);
    const r = appearance ?? textRenderer(textStyleOf(e), this.ctx.textStyles, text);
    const shx = appearance && this.ctx.textGeometry?.shxRun?.(raw, e.height, appearance);
    if (shx?.ok) {
      const placed = metricTextPlacement(e, this.ctx.textGeometry!);
      const fitted = this.ctx.textGeometry!.shxRun!(raw, placed.text.height, placed.appearance);
      if (fitted?.ok) {
        const paths = shxTextPaths(fitted, placed.text, placed.offset), parts: string[] = [];
        for (const path of paths) {
          parts.push(`${this.P(path.from)} m`);
          parts.push(path.controls ? `${this.P(path.controls[0])} ${this.P(path.controls[1])} ${this.P(path.to)} c` : `${this.P(path.to)} l`);
        }
        if (parts.length) {
          this.setDash([]);
          if (e.bold) this.ops.push(`q ${n(Math.max(0.5, (placed.text.height * this.tf.k) / 12))} w ${parts.join(' ')} S Q`);
          else this.ops.push(`${parts.join(' ')} S`);
          this.pathOps += 1;
        }
        return;
      }
    }
    if (appearance?.kind === 'canvas' && this.ctx.embeddedFonts) {
      const key = textFontKey(appearance), face = this.ctx.embeddedFonts.face(key);
      if (face && this.ctx.shapedText) {
        const plan = this.ctx.shapedText(text, appearance);
        if (plan) {
          this.shapedLine(e, plan, face);
          return;
        }
      }
      const run = this.ctx.embeddedFonts.encode(key, text);
      if (face && run) {
        const placed = metricTextPlacement(e, this.ctx.textGeometry!);
        const t = placed.text, wf = t.widthFactor ?? 1, slant = Math.tan(t.oblique ?? 0);
        const size = t.height * this.tf.k * face.metrics.unitsPerEm / face.metrics.capitalHeight;
        const c = Math.cos(t.rotation + this.tf.rotation), s = Math.sin(t.rotation + this.tf.rotation);
        const p = this.pt(t.position), off = placed.offset * wf * this.tf.k;
        const values = [size, wf * c, wf * s, slant * c - s, slant * s + c, p.x + off * c, p.y + off * s];
        const numbers = values.map((value) => {
          if (!Number.isFinite(value) || Math.abs(value) >= 1e21) throw new Error('PDF text transform exceeds the supported numeric range.');
          const result = value.toFixed(6).replace(/\.?0+$/, ''); return result === '-0' || !result ? '0' : result;
        });
        this.fonts.add(run.resourceName);
        this.ops.push(`BT /${run.resourceName} ${numbers[0]} Tf ${numbers.slice(1).join(' ')} Tm <${run.hex}> Tj ET`);
        return;
      }
    }
    if (r.kind === 'canvas' && !isWinAnsi(text) && (r.strokeFallback || /\p{Script=Han}/u.test(text))) {
      throw new Error(`Unicode text cannot be plotted with the available embedded font (${r.family.split(',')[0]}). Choose Raster image output to use the installed Unicode font substitute.`);
    }
    if (r.kind === 'canvas' && this.ctx.fontFallbacks) this.ctx.fontFallbacks.add(r.family.split(',')[0]!);
    const initialWidthFactor = e.widthFactor !== undefined && Number.isFinite(e.widthFactor) && e.widthFactor > 0 ? e.widthFactor : r.widthFactor;
    e = placedText({ ...e, widthFactor: initialWidthFactor }, r.kind === 'canvas' && isWinAnsi(text) ? (_text, height) => helveticaWidth(text, r.bold || !!e.bold) * height / CAP_HEIGHT_EM : strokeTextWidth);
    const wf = e.widthFactor ?? 1;
    const oblique = e.oblique ?? r.oblique;
    const slant = oblique ? Math.tan(oblique) : 0;
    if (r.kind === 'canvas' && isWinAnsi(text)) {
      const bold = r.bold || !!e.bold;
      const font = bold ? 'F2' : 'F1';
      this.fonts.add(font);
      const size = (e.height * this.tf.k) / CAP_HEIGHT_EM;
      const width = helveticaWidth(text, bold) * size * wf;
      const c = Math.cos(e.rotation + this.tf.rotation);
      const s = Math.sin(e.rotation + this.tf.rotation);
      const off = e.align === 'center' ? -width / 2 : e.align === 'right' ? -width : 0;
      const p = this.pt(e.position);
      const x = p.x + off * c;
      const y = p.y + off * s;
      this.ops.push(`BT /${font} ${n(size)} Tf ${n(wf * c)} ${n(wf * s)} ${n(slant * c - s)} ${n(slant * s + c)} ${n(x)} ${n(y)} Tm ${pdfLiteral(text)} Tj ET`);
      return;
    }
    // Hershey strokes (SHX styles, and characters Helvetica cannot show).
    const plain = wf === 1 && slant === 0;
    const strokes = plain ? strokeText(text, e.position, e.height, e.rotation, e.align) : strokeText(text, { x: 0, y: 0 }, e.height, 0, e.align);
    const c = Math.cos(e.rotation);
    const s = Math.sin(e.rotation);
    const world = plain
      ? (q: Point) => q
      : (q: Point) => {
          const lx = q.x * wf + q.y * slant;
          return { x: e.position.x + lx * c - q.y * s, y: e.position.y + lx * s + q.y * c };
        };
    const parts: string[] = [];
    for (const st of strokes) {
      if (st.length === 0) continue;
      parts.push(`${this.P(world(st[0]!))} m`);
      if (st.length === 1) parts.push(`${this.P(world(st[0]!))} l`);
      for (let i = 1; i < st.length; i += 1) parts.push(`${this.P(world(st[i]!))} l`);
    }
    if (!parts.length) return;
    this.setDash([]);
    if (e.bold) this.ops.push(`q ${n(Math.max(0.5, (e.height * this.tf.k) / 12))} w ${parts.join(' ')} S Q`);
    else this.ops.push(`${parts.join(' ')} S`);
    this.pathOps += 1;
  }
}

/** PDF dash array (points) from a linetype pattern scaled to points; [] = continuous. */
export function dashPattern(pattern: readonly number[], toPoints: number): number[] {
  if (pattern.length === 0) return [];
  const out: number[] = [];
  let period = 0;
  // Merge runs of the same kind so the array alternates dash / gap, starting with a dash.
  let wantDash = true;
  for (const seg of pattern) {
    const isDash = seg >= 0;
    const len = Math.abs(seg) * toPoints;
    period += len;
    if (isDash === wantDash) {
      out.push(len);
      wantDash = !wantDash;
    } else if (out.length) out[out.length - 1]! += len;
    else {
      out.push(0, len);
    }
  }
  if (period < 0.5) return [];
  if (out.length % 2 === 1) out.push(0);
  return out;
}

// ---------------------------------------------------------------- file assembly

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface RenderedPage {
  width: number;
  height: number;
  content: string;
  images: ImageRes[];
  fonts: ReadonlySet<string>;
  embeddedFonts?: PdfFontRegistry;
  /** Isolated vector paint groups for translucent dash masks and mixed device hairlines. */
  forms?: readonly VectorForm[];
  /** ExtGState opacity bytes used by both strokes and fills. */
  alphas?: ReadonlySet<number>;
  /** Smooth native axial gradient resources, clipped by the hatch's even-odd boundary. */
  gradients?: readonly GradientRes[];
  pathOps: number;
}

/** Content streams of the pages (step one; `assembleVectorPdf` writes the file). */
export function renderPdfPages(pages: readonly PdfPageSpec[], ctx: PdfDrawingContext, style: PdfPlotStyle): RenderedPage[] {
  return pages.map((page) => {
    const w = new PageWriter(ctx, style, page);
    w.run();
    return { width: page.width, height: page.height, content: w.ops.join('\n'), images: w.images, fonts: w.fonts, embeddedFonts: ctx.embeddedFonts, forms: w.forms, alphas: w.alphas, gradients: w.gradients, pathOps: w.pathOps };
  });
}

/**
 * Write the PDF. `compressed[i]`, when given, is page i's content stream already deflated
 * (FlateDecode); otherwise the stream is stored as plain text.
 */
export function assembleVectorPdf(rendered: readonly RenderedPage[], title = 'Drawing', compressed?: ReadonlyArray<Uint8Array | null>): Uint8Array {
  const objects: Array<Uint8Array | null> = [];
  const reserve = () => {
    objects.push(null);
    return objects.length;
  };
  const set = (num: number, body: string | Uint8Array[]) => {
    objects[num - 1] = typeof body === 'string' ? enc.encode(body) : concat(body);
  };
  const catalog = reserve();
  const pagesObj = reserve();
  const f1 = reserve();
  const f2 = reserve();
  set(f1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  set(f2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const fontObjects = new Map<PdfFontRegistry, ReadonlyMap<string, number>>();
  for (const pg of rendered) if (pg.embeddedFonts && !fontObjects.has(pg.embeddedFonts)) fontObjects.set(pg.embeddedFonts, writePdfFontResources(pg.embeddedFonts, { reserve, set }));
  // Only resources actually emitted can raise the ordinary PDF 1.4 baseline.
  let version: readonly [number, number] = [1, 4];
  for (const registry of fontObjects.keys()) {
    const required = registry.requiredVersion;
    if (required[0] > version[0] || required[0] === version[0] && required[1] > version[1]) version = required;
  }
  const kids: number[] = [];
  rendered.forEach((pg, i) => {
    const pageNum = reserve();
    const contentNum = reserve();
    kids.push(pageNum);
    const xobjects: string[] = [];
    for (const im of pg.images) {
      const num = reserve();
      const d = im.data;
      const filter = d.kind === 'jpeg' ? ' /Filter /DCTDecode' : d.deflated ? ' /Filter /FlateDecode' : '';
      set(num, [enc.encode(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${filter} /Length ${d.data.length} >>\nstream\n`), d.data, enc.encode('\nendstream')]);
      xobjects.push(`/${im.name} ${num} 0 R`);
    }
    if (pg.forms?.length) {
      const opaque = reserve();
      set(opaque, '<< /Type /ExtGState /CA 1 /ca 1 /BM /Normal >>');
      for (const form of pg.forms) {
        const num = reserve(), data = enc.encode(form.content);
        set(num, [enc.encode(`<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${n(form.width)} ${n(form.height)}] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources << /ExtGState << /Opaque ${opaque} 0 R >> >> /Length ${data.length} >>\nstream\n`), data, enc.encode('\nendstream')]);
        xobjects.push(`/${form.name} ${num} 0 R`);
      }
    }
    const fonts = [...pg.fonts].map((f) => {
      const object = f === 'F1' ? f1 : f === 'F2' ? f2 : pg.embeddedFonts ? fontObjects.get(pg.embeddedFonts)?.get(f) : undefined;
      if (!object) throw new Error('Missing PDF font resource.');
      return `/${f} ${object} 0 R`;
    });
    const alphaResources = [...(pg.alphas ?? [])].map((alpha) => {
      const num = reserve();
      set(num, `<< /Type /ExtGState /CA ${n(alpha / 255)} /ca ${n(alpha / 255)} /BM /Normal >>`);
      return `/A${alpha} ${num} 0 R`;
    });
    const gradients = (pg.gradients ?? []).map((gradient) => {
      const num = reserve();
      set(num, `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Domain [0 1] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [${gradient.colors[0].map(n).join(' ')}] /C1 [${gradient.colors[1].map(n).join(' ')}] /N 1 >> >>`);
      return `/${gradient.name} ${num} 0 R`;
    });
    const res = `<< /ProcSet [/PDF /Text /ImageC]${fonts.length ? ` /Font << ${fonts.join(' ')} >>` : ''}${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''}${alphaResources.length ? ` /ExtGState << ${alphaResources.join(' ')} >>` : ''}${gradients.length ? ` /Shading << ${gradients.join(' ')} >>` : ''} >>`;
    set(pageNum, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(pg.width)} ${n(pg.height)}] /Resources ${res} /Contents ${contentNum} 0 R >>`);
    const packed = compressed?.[i] ?? null;
    const body = packed ?? enc.encode(pg.content);
    set(contentNum, [enc.encode(`<< /Length ${body.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), body, enc.encode('\nendstream')]);
  });
  set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const info = reserve();
  set(info, `<< /Title ${pdfString(title)} /Producer (JCad Electrical) /Creator (JCad Electrical vector plot) >>`);

  const head = enc.encode(`%PDF-${version[0]}.${version[1]}\n%\xE2\xE3\xCF\xD3\n`);
  const parts: Uint8Array[] = [head];
  let offset = head.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const h = enc.encode(`${i + 1} 0 obj\n`);
    const t = enc.encode('\nendobj\n');
    const b = body ?? enc.encode('null');
    parts.push(h, b, t);
    offset += h.length + b.length + t.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}

/** Pages -> PDF bytes (uncompressed content streams). */
export function vectorPdf(pages: readonly PdfPageSpec[], ctx: PdfDrawingContext, style: PdfPlotStyle = MONOCHROME, title = 'Drawing'): Uint8Array {
  return assembleVectorPdf(renderPdfPages(pages, ctx, style), title);
}

/** Pages -> PDF bytes with Flate-compressed content streams (`deflate` = pdf.ts deflate or node zlib). */
export async function vectorPdfCompressed(
  pages: readonly PdfPageSpec[],
  ctx: PdfDrawingContext,
  style: PdfPlotStyle,
  title: string,
  deflate: (bytes: Uint8Array) => Promise<Uint8Array | null> | Uint8Array | null,
): Promise<Uint8Array> {
  const rendered = renderPdfPages(pages, ctx, style);
  const packed = await Promise.all(rendered.map(async (r) => await deflate(enc.encode(r.content))));
  return assembleVectorPdf(rendered, title, packed);
}

/** The drawing context of a state (layers, blocks, LTSCALE, linetypes, text styles). */
export function drawingContext(state: DrawingState, lookup: BlockLookup, image?: PdfDrawingContext['image'], underlayImage?: PdfDrawingContext['underlayImage']): PdfDrawingContext {
  return { layers: state.layers, lookup, ltscale: state.header?.ltscale ?? 1, linetypes: state.header?.linetypes ?? [], textStyles: textStylesOf(state), underlays: state.underlays, ...(image ? { image } : {}), ...(underlayImage ? { underlayImage } : {}) };
}
