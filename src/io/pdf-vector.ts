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
 * editor supplies image bitmaps and saves the bytes (src/app/editor.ts plotOrPrint).
 */
import type { Entity, Layer, BlockLookup, TextEntity, PolylineEntity, InsertEntity, ImageEntity, HatchEntity, EllipseEntity } from '../core/entities';
import {
  explodeInsert,
  entityBounds,
  polylineSegments,
  dimensionParts,
  mtextParts,
  mtextDecorations,
  ellipseSweep,
  isFullEllipse,
  splinePoints,
  hatchGeometry,
  leaderParts,
  tableParts,
  imageParts,
  imageBoundary,
  INFINITE_LENGTH,
} from '../core/entities';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import { aciToCss } from '../render/palette';
import { strokeText, expandControlCodes, textRenderer, CAP_HEIGHT_EM } from '../render/hershey';
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
  sheetSize,
  unitInches,
  viewportPaperBounds,
  printableArea,
  type Layout,
  type PlotStyleMode,
} from '../core/layouts';
import { layoutPage, type PlotOptions } from '../app/plot';
import type { DrawingState } from '../core/document';

// ---------------------------------------------------------------- page model

/** A set of entities drawn with one uniform-scale transform (page point = k * p + (e, f)), optionally clipped. */
export interface PdfDrawGroup {
  readonly entities: readonly Entity[];
  readonly k: number;
  readonly e: number;
  readonly f: number;
  /** Clip rectangle in page points. */
  readonly clip?: { x: number; y: number; w: number; h: number };
  /** Layers left out (off, frozen, no-plot, frozen in this viewport). */
  readonly hidden: ReadonlySet<string>;
  /** Points per linetype pattern unit (model: k; layout viewports: paper units, like PSLTSCALE 1). */
  readonly ltUnit: number;
  /** Display factor of annotative objects in this group (1 / CANNOSCALE, 1 / viewport scale, 1 on paper). */
  readonly annoFactor: number;
  readonly hideAnnotative?: boolean;
  /** Frames of floating viewports (drawn as rectangles when their layer plots). */
  readonly frames?: ReadonlyArray<{ x: number; y: number; w: number; h: number; layer: string }>;
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
}

export interface PdfImageData {
  width: number;
  height: number;
  /** RGB bytes (3 per pixel, top row first; `deflated` when already Flate-compressed) or JPEG file bytes. */
  data: Uint8Array;
  kind: 'rgb' | 'jpeg';
  deflated?: boolean;
}

export interface PdfDrawingContext {
  readonly layers: readonly Layer[];
  readonly lookup: BlockLookup;
  readonly ltscale: number;
  readonly linetypes: readonly Linetype[];
  readonly textStyles?: Readonly<Record<string, TextStyle>>;
  /** Bitmap of an IMAGE entity's file (null: the frame and file name are plotted instead). */
  readonly image?: (path: string) => PdfImageData | null;
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
  const frames: Array<{ x: number; y: number; w: number; h: number; layer: string }> = [];
  for (const v of layout.viewports) {
    const vb = viewportPaperBounds(v);
    const rect = { x: pe + pk * vb.min.x, y: pf + pk * vb.min.y, w: pk * v.width, h: pk * v.height };
    frames.push({ ...rect, layer: v.layer });
    if (!v.on) continue;
    const s = v.view.scale;
    const origin = modelToPaper(v, { x: 0, y: 0 });
    groups.push({
      entities: state.entities,
      k: pk * s,
      e: pe + pk * origin.x,
      f: pf + pk * origin.y,
      clip: rect,
      hidden: new Set([...hidden, ...(v.frozenLayers ?? [])]),
      ltUnit: pk,
      annoFactor: 1 / s,
      hideAnnotative: state.header?.annoAllVisible === false && Math.abs(s - canno) > 1e-9,
    });
  }
  groups.push({ entities: layout.entities, k: pk, e: pe, f: pf, hidden, ltUnit: pk, annoFactor: 1, frames });
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
  if (trueColor !== undefined) return [((trueColor >> 16) & 255) / 255, ((trueColor >> 8) & 255) / 255, (trueColor & 255) / 255];
  const aci = color === 'ByLayer' ? (layer?.color ?? 7) : color;
  if (aci === 7 || aci === 0) return [0, 0, 0];
  return hexRgb(aciToCss(aci));
}

/** Apply the plot style to an object colour. */
export function plotColor(rgb: [number, number, number], style: PdfPlotStyle): [number, number, number] {
  if (!style.usePlotStyles) return rgb;
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

/** Content stream builder for one page. */
class PageWriter {
  readonly ops: string[] = [];
  readonly images: ImageRes[] = [];
  readonly fonts = new Set<'F1' | 'F2'>();
  private stroke = '';
  private fill = '';
  private width = '';
  private dash = '';
  private tf: { k: number; e: number; f: number } = { k: 1, e: 0, f: 0 };
  private group: PdfDrawGroup | null = null;
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
  }

  private P(p: Point): string {
    return `${n(this.tf.k * p.x + this.tf.e)} ${n(this.tf.k * p.y + this.tf.f)}`;
  }
  private pt(p: Point): Point {
    return { x: this.tf.k * p.x + this.tf.e, y: this.tf.k * p.y + this.tf.f };
  }

  run(): void {
    this.ops.push('1 J 1 j');
    for (const grp of this.page.groups) {
      this.group = grp;
      this.tf = { k: grp.k, e: grp.e, f: grp.f };
      this.ops.push('q');
      this.resetState();
      if (grp.clip) this.ops.push(`${n(grp.clip.x)} ${n(grp.clip.y)} ${n(grp.clip.w)} ${n(grp.clip.h)} re W n`);
      const view = grp.clip ? this.modelRect(grp.clip) : null;
      for (const e of grp.entities) {
        if (grp.hidden.has(e.layer)) continue;
        if (e.annotative && grp.hideAnnotative) continue;
        if (view && e.type !== 'xline' && e.type !== 'ray') {
          const b = entityBounds(e, this.ctx.lookup);
          if (b && !g.boundsIntersect(b, view)) continue;
        }
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
      this.setStroke(plotColor(objectRgb('ByLayer', undefined, layer), this.style));
      this.setWidth(this.style.lineweights ? mmToPt(layer?.lineWeight ?? 0.25) : 0);
      this.ops.push(`${n(f.x)} ${n(f.y)} ${n(f.w)} ${n(f.h)} re S`);
      this.pathOps += 1;
      this.ops.push('Q');
    }
  }

  /** Model-space rectangle covered by a clip rectangle of the current group. */
  private modelRect(r: { x: number; y: number; w: number; h: number }): Bounds {
    const { k, e, f } = this.tf;
    return { min: { x: (r.x - e) / k, y: (r.y - f) / k }, max: { x: (r.x + r.w - e) / k, y: (r.y + r.h - f) / k } };
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

  // ---- entity properties (ByLayer / ByBlock resolved against the parent insert)
  private layer(name: string): Layer | undefined {
    return this.ctx.layers.find((l) => l.name === name);
  }

  private applyStyle(e: Entity, parent: InsertEntity | null): void {
    const layer = this.layer(e.layer);
    let color = e.color;
    let trueColor = e.trueColor;
    if (color === 0 && parent) {
      color = parent.color;
      trueColor = parent.trueColor;
    }
    const rgb = plotColor(objectRgb(color, trueColor, color === 'ByLayer' && parent && e.layer === parent.layer ? this.layer(parent.layer) : layer), this.style);
    this.setStroke(rgb);
    this.setFill(rgb);
    let mm = e.lineWeight;
    if (mm === -2 && parent) mm = parent.lineWeight;
    if (mm === undefined || mm === -1) mm = layer?.lineWeight ?? 0.25;
    if (mm < 0) mm = 0.25;
    this.setWidth(this.style.lineweights ? mmToPt(mm) : 0);
    let lt = e.linetype;
    if (isByBlock(lt) && parent) lt = parent.linetype;
    const name = effectiveLinetype(lt, layer?.linetype);
    const def = findLinetype(name, this.ctx.linetypes);
    this.setDash(def ? dashPattern(def.pattern, this.ctx.ltscale * (e.ltscale ?? 1) * (this.group?.ltUnit ?? 1)) : []);
  }

  private entity(e: Entity, parent: InsertEntity | null, view: Bounds | null): void {
    if (e.type === 'insert') {
      for (const sub of explodeInsert(e, this.ctx.lookup)) {
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
      const styled = p.color === 'ByLayer' && p.trueColor === undefined ? ({ ...p, color: owner.color, trueColor: owner.trueColor, layer: owner.layer, lineWeight: p.lineWeight ?? owner.lineWeight } as Entity) : p;
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
        this.polyline(e);
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
        this.parts([...mtextParts(e), ...mtextDecorations(e)], e, parent, view);
        break;
      case 'dimension':
        this.parts(dimensionParts(e), e, parent, view);
        break;
      case 'leader':
        this.parts(leaderParts(e), e, parent, view);
        break;
      case 'table':
        this.parts(tableParts(e), e, parent, view);
        break;
      case 'hatch':
        this.hatch(e);
        break;
      case 'image':
        this.image(e, parent, view);
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

  private polyPath(pts: readonly Point[], closed: boolean, paint: string): void {
    const parts = [`${this.P(pts[0]!)} m`];
    for (let i = 1; i < pts.length; i += 1) parts.push(`${this.P(pts[i]!)} l`);
    if (closed) parts.push('h');
    parts.push(paint);
    this.ops.push(parts.join(' '));
    this.pathOps += 1;
  }

  private polyline(e: PolylineEntity): void {
    if (e.points.length === 0) return;
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
    if (e.solid || geo.dense) {
      const parts: string[] = [];
      for (const poly of geo.polys) {
        parts.push(`${this.P(poly[0]!)} m`);
        for (let i = 1; i < poly.length; i += 1) parts.push(`${this.P(poly[i]!)} l`);
        parts.push('h');
      }
      if (!parts.length) return;
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
    const ux = e.u.x * e.size.x * this.tf.k;
    const uy = e.u.y * e.size.x * this.tf.k;
    const vx = e.v.x * e.size.y * this.tf.k;
    const vy = e.v.y * e.size.y * this.tf.k;
    this.ops.push(`q ${clip} ${n(ux)} ${n(uy)} ${n(vx)} ${n(vy)} ${n(o.x)} ${n(o.y)} cm /${name} Do Q`);
  }

  private text(e: TextEntity): void {
    const raw = e.text.includes('%%') ? e.text.replace(/%%[uUoOkK]/g, '') : e.text;
    const text = expandControlCodes(raw);
    if (!text.trim()) return;
    const r = textRenderer(textStyleOf(e), this.ctx.textStyles);
    const wf = (e.widthFactor && e.widthFactor > 0 ? e.widthFactor : 1) * r.widthFactor;
    const oblique = e.oblique ?? r.oblique;
    const slant = oblique ? Math.tan(oblique) : 0;
    if (r.kind === 'canvas' && isWinAnsi(text)) {
      const bold = r.bold || !!e.bold;
      const font = bold ? 'F2' : 'F1';
      this.fonts.add(font);
      const size = (e.height * this.tf.k) / CAP_HEIGHT_EM;
      const width = helveticaWidth(text, bold) * size * wf;
      const c = Math.cos(e.rotation);
      const s = Math.sin(e.rotation);
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
  fonts: ReadonlySet<'F1' | 'F2'>;
  pathOps: number;
}

/** Content streams of the pages (step one; `assembleVectorPdf` writes the file). */
export function renderPdfPages(pages: readonly PdfPageSpec[], ctx: PdfDrawingContext, style: PdfPlotStyle): RenderedPage[] {
  return pages.map((page) => {
    const w = new PageWriter(ctx, style, page);
    w.run();
    return { width: page.width, height: page.height, content: w.ops.join('\n'), images: w.images, fonts: w.fonts, pathOps: w.pathOps };
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
    const fonts = [...pg.fonts].map((f) => `/${f} ${f === 'F1' ? f1 : f2} 0 R`);
    const res = `<< /ProcSet [/PDF /Text /ImageC]${fonts.length ? ` /Font << ${fonts.join(' ')} >>` : ''}${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''} >>`;
    set(pageNum, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(pg.width)} ${n(pg.height)}] /Resources ${res} /Contents ${contentNum} 0 R >>`);
    const packed = compressed?.[i] ?? null;
    const body = packed ?? enc.encode(pg.content);
    set(contentNum, [enc.encode(`<< /Length ${body.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), body, enc.encode('\nendstream')]);
  });
  set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const info = reserve();
  set(info, `<< /Title ${pdfString(title)} /Producer (JCad Electrical) /Creator (JCad Electrical vector plot) >>`);

  const head = enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
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
export function drawingContext(state: DrawingState, lookup: BlockLookup, image?: PdfDrawingContext['image']): PdfDrawingContext {
  return { layers: state.layers, lookup, ltscale: state.header?.ltscale ?? 1, linetypes: state.header?.linetypes ?? [], textStyles: textStylesOf(state), ...(image ? { image } : {}) };
}
