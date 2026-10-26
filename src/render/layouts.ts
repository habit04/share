/**
 * Layout (paper space) view: the sheet on a grey background with a drop shadow, the
 * printable area dashed, each floating viewport's model space clipped to its rectangle at
 * its scale, the paper-space entities on top and the viewport frames (the active one bold).
 * Installed as `Viewport.layoutPainter` by tools/layouts.ts while a layout tab is active.
 */
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, BlockDef, BlockLookup } from '../core/entities';
import { textGeometryForStyles, EMPTY_TEXT_STYLES } from './font-metrics';
import { entityBounds } from '../core/entities';
import type { PdfPageSpec, PdfDrawingContext, PdfPlotStyle } from '../io/pdf-vector';
import type { Drawing } from '../core/document';
import type { Viewport, ViewportOverlay } from './viewport';
import { drawEntity, lineweightDisplay, annotationDisplay, colorDisplay, renderSettings, type Transform, type ImageLoader } from './draw';
import type { UnderlayContentSource } from './underlay-content';
import { plotEntityAppearance, plotRgbCss } from './plot-appearance';
import { resolveAlpha } from '../core/appearance';
import {
  activeLayout,
  modelToPaper,
  viewTwist,
  printableArea,
  sheetSize,
  unitInches,
  viewportModelBounds,
  viewportPaperBounds,
  cannoscaleValue,
  type Layout,
  type LayoutViewport,
} from '../core/layouts';

/** Paper view: paper point at the canvas centre and CSS px per paper unit. */
export interface PaperView {
  center: Point;
  scale: number;
}

export interface LayoutPaintSource {
  readonly doc: Drawing;
  /** Current paper view (in paper space it is the viewport's own view). */
  paperView(): PaperView;
}

export const LAYOUT_COLORS = {
  background: '#3f454e',
  shadow: 'rgba(0, 0, 0, 0.45)',
  paper: '#ffffff',
  margin: 'rgba(90, 90, 90, 0.9)',
  frame: '#5c5c5c',
  activeFrame: '#1f6fd6',
};

export function paperTransform(pv: PaperView, width: number, height: number): Transform & { toPaper(s: Point): Point } {
  const toScreen = (p: Point): Point => ({ x: width / 2 + (p.x - pv.center.x) * pv.scale, y: height / 2 - (p.y - pv.center.y) * pv.scale });
  const toPaper = (s: Point): Point => ({ x: pv.center.x + (s.x - width / 2) / pv.scale, y: pv.center.y - (s.y - height / 2) / pv.scale });
  const a = toPaper({ x: 0, y: height });
  const b = toPaper({ x: width, y: 0 });
  return { scale: pv.scale, toScreen, toPaper, viewBounds: { min: a, max: b } };
}

/** Screen transform of a floating viewport's model space under a paper view. */
export function viewportTransform(vp: LayoutViewport, pv: PaperView, width: number, height: number): Transform {
  const paper = paperTransform(pv, width, height);
  return { scale: pv.scale * vp.view.scale, rotation: viewTwist(vp.view), toScreen: (m) => paper.toScreen(modelToPaper(vp, m)), viewBounds: viewportModelBounds(vp) };
}

/** Screen rectangle of a viewport under a paper view (x, y = top-left). */
export function viewportScreenRect(vp: LayoutViewport, pv: PaperView, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const paper = paperTransform(pv, width, height);
  const b = viewportPaperBounds(vp);
  const tl = paper.toScreen({ x: b.min.x, y: b.max.y });
  return { x: tl.x, y: tl.y, w: vp.width * pv.scale, h: vp.height * pv.scale };
}

function polygonPath(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
}

/** Pixels per millimetre on the paper at a paper view (lineweights are drawn at paper size). */
export function paperPxPerMm(layout: Layout, pv: PaperView): number {
  return (pv.scale * (1 / unitInches(layout.paper.units))) / 25.4;
}

function cullBounds(e: Entity, lookup: Drawing['lookupBlock'], view: Bounds): boolean {
  if (e.type === 'xline' || e.type === 'ray') return true;
  const b = entityBounds(e, lookup);
  return !b || g.boundsIntersect(b, view);
}

/** Paint the active layout. `vp` supplies the canvas size and, in MSPACE, the active viewport's transform. */
export function paintLayout(ctx: CanvasRenderingContext2D, vp: Viewport, ov: ViewportOverlay, src: LayoutPaintSource): void {
  const doc = src.doc;
  const state = doc.snapshot;
  const layout = activeLayout(state);
  if (!layout) return;
  const pv = src.paperView();
  const W = vp.width;
  const H = vp.height;
  const paper = paperTransform(pv, W, H);
  const sheet = sheetSize(layout);
  const tl = paper.toScreen({ x: 0, y: sheet.height });
  const sw = sheet.width * pv.scale;
  const sh = sheet.height * pv.scale;

  ctx.fillStyle = LAYOUT_COLORS.background;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = LAYOUT_COLORS.shadow;
  ctx.fillRect(tl.x + 5, tl.y + 5, sw, sh);
  ctx.fillStyle = LAYOUT_COLORS.paper;
  ctx.fillRect(tl.x, tl.y, sw, sh);
  // Printable area (inside the page setup margins), dashed like AutoCAD.
  const pa = printableArea(layout);
  const a = paper.toScreen({ x: pa.min.x, y: pa.max.y });
  const b = paper.toScreen({ x: pa.max.x, y: pa.min.y });
  ctx.save();
  ctx.strokeStyle = LAYOUT_COLORS.margin;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(vp.px(a.x), vp.px(a.y), Math.round(b.x - a.x), Math.round(b.y - a.y));
  ctx.restore();

  const layers = doc.layers;
  const hidden = new Set(layers.filter((l) => !l.visible).map((l) => l.name));
  // Layout sheets draw through the same wrapped lookup as the model
  // pass when a resolved xref context is published for this document
  // (design sections 3.4 + A.2 rule 6: per-viewport layer state stays
  // host-document data and applies to host entities; it does not reach
  // into a referenced file's layer context).
  const lookup = renderSettings.xrefContext ? renderSettings.xrefContext.expansionLookup(doc.lookupBlock) : doc.lookupBlock;
  const spaceVp = state.space?.viewport;
  const header = doc.header;
  const canno = cannoscaleValue(header.cannoscale);
  const pxPerMm = paperPxPerMm(layout, pv);
  const savedLw = lineweightDisplay.pxPerMm;
  colorDisplay.paper = true;
  if (lineweightDisplay.enabled) lineweightDisplay.pxPerMm = pxPerMm;
  try {
    // ---- model space through each viewport
    for (const v of layout.viewports) {
      if (!v.on) continue;
      const active = v.id === spaceVp;
      const r = viewportScreenRect(v, pv, W, H);
      if (r.x > W || r.y > H || r.x + r.w < 0 || r.y + r.h < 0) continue;
      const tf: Transform = active ? vp.transform : viewportTransform(v, pv, W, H);
      const view = viewportModelBounds(v);
      const frozen = new Set([...hidden, ...(v.frozenLayers ?? [])]);
      annotationDisplay.factor = 1 / v.view.scale;
      annotationDisplay.hide = header.annoAllVisible === false && Math.abs(v.view.scale - canno) > 1e-9;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      if (v.clipBoundary && v.clipOn !== false) {
        polygonPath(ctx, v.clipBoundary.points.map(paper.toScreen));
        ctx.clip('evenodd');
      }
      for (const e of state.entities) {
        if (frozen.has(e.layer) || !cullBounds(e, lookup, view)) continue;
        if (active && ov.selection.has(e.id)) drawEntity(ctx, e, tf, layers, lookup, { dashed: true, alpha: 0.95, hidden: frozen });
        else if (active && ov.hover === e.id) drawEntity(ctx, e, tf, layers, lookup, { lineWidthOverride: 2, alpha: 0.95, hidden: frozen });
        else drawEntity(ctx, e, tf, layers, lookup, { hidden: frozen });
      }
      ctx.restore();
    }
    // ---- paper-space entities
    annotationDisplay.factor = 1;
    annotationDisplay.hide = false;
    const inPaper = !spaceVp;
    for (const e of layout.entities) {
      if (hidden.has(e.layer) || !cullBounds(e, lookup, paper.viewBounds!)) continue;
      if (inPaper && ov.selection.has(e.id)) drawEntity(ctx, e, paper, layers, lookup, { dashed: true, alpha: 0.95, hidden });
      else if (inPaper && ov.hover === e.id) drawEntity(ctx, e, paper, layers, lookup, { lineWidthOverride: 2, alpha: 0.95, hidden });
      else drawEntity(ctx, e, paper, layers, lookup, { hidden });
    }
    for (const v of layout.viewports) {
      if (v.clipBoundary && !hidden.has(v.clipBoundary.layer)) drawEntity(ctx, v.clipBoundary, paper, layers, lookup, { hidden });
    }
    // ---- viewport frames (hidden with their layer, like AutoCAD; the active one is bold)
    for (const v of layout.viewports) {
      const active = v.id === spaceVp;
      const frameLayer = v.clipBoundary && v.clipOn !== false ? v.clipBoundary.layer : v.layer;
      if (hidden.has(frameLayer) && !active) continue;
      const r = viewportScreenRect(v, pv, W, H);
      ctx.save();
      const selected = inPaper && ov.selection.has(v.id);
      if (v.clipBoundary && v.clipOn !== false && !active && !selected && ov.hover !== v.id) { ctx.restore(); continue; }
      ctx.strokeStyle = active ? LAYOUT_COLORS.activeFrame : LAYOUT_COLORS.frame;
      ctx.lineWidth = active ? 3 : inPaper && ov.hover === v.id ? 2 : 1;
      if (selected) ctx.setLineDash([6, 4]);
      if (v.clipBoundary && v.clipOn !== false) {
        polygonPath(ctx, v.clipBoundary.points.map(paper.toScreen));
        ctx.stroke();
      } else ctx.strokeRect(vp.px(r.x, ctx.lineWidth), vp.px(r.y, ctx.lineWidth), Math.round(r.w), Math.round(r.h));
      ctx.restore();
    }
  } finally {
    lineweightDisplay.pxPerMm = savedLw;
    // Rubber bands and ghosts drawn after the painter belong to the active space.
    const act = layout.viewports.find((v) => v.id === spaceVp);
    annotationDisplay.factor = act ? 1 / act.view.scale : 1;
    annotationDisplay.hide = false;
  }
}

// ---------------------------------------------------------------- raster sheets (PRINT, raster PDF of a layout)

/**
 * Render a plot page (io/pdf-vector.ts page spec: groups with their transform and clip) to a
 * canvas at `dpi`, through the same draw pipeline as the screen. Used by PRINT of a layout and
 * the "Raster image" PDF output; monochrome pages draw black.
 */
export function renderPageToCanvas(canvas: HTMLCanvasElement, page: PdfPageSpec, ctxInfo: PdfDrawingContext, style: PdfPlotStyle, dpi: number, imageLoader?: ImageLoader, underlaySource?: UnderlayContentSource): void {
  // The page lookup re-bases the drawing context's lookup on this page's
  // text geometry; the xref channels of the underlying lookup — the
  // def-scope hook and the per-file provenance (A.2) — are forwarded,
  // recursively for scoped lookups, so raster sheets expand and resolve
  // layers exactly as the live pass does.
  const pageTextGeometry = ctxInfo.textGeometry ?? ctxInfo.lookup.textGeometry ?? textGeometryForStyles(ctxInfo.textStyles ?? EMPTY_TEXT_STYLES);
  const wrapCtxLookup = (inner: BlockLookup): BlockLookup => {
    const wrapped: BlockLookup = Object.assign((name: string) => inner(name), { textGeometry: pageTextGeometry });
    if (inner.forDef) Object.assign(wrapped, { forDef: (name: string, def: BlockDef) => wrapCtxLookup(inner.forDef!(name, def)) });
    if (inner.sources) Object.assign(wrapped, { sources: inner.sources });
    return wrapped;
  };
  const lookup: BlockLookup = wrapCtxLookup(ctxInfo.lookup);
  const s = dpi / 72;
  const W = Math.max(1, Math.round(page.width * s));
  const H = Math.max(1, Math.round(page.height * s));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const plot = style.table ? { table: style.table, namedStyle: style.namedStyle, usePlotStyles: style.usePlotStyles, lineweights: style.lineweights, issues: style.issues } : undefined;
  const mono = !plot && style.usePlotStyles && style.mode === 'monochrome';
  const saved = { lw: { ...lineweightDisplay }, anno: { ...annotationDisplay }, paper: colorDisplay.paper,
    ltscale: renderSettings.ltscale, linetypes: renderSettings.linetypes };
  lineweightDisplay.enabled = style.lineweights;
  lineweightDisplay.pxPerMm = dpi / 25.4;
  colorDisplay.paper = true;
  renderSettings.ltscale = ctxInfo.ltscale;
  renderSettings.linetypes = ctxInfo.linetypes;
  try {
    for (const grp of page.groups) {
      const rotation = grp.rotation ?? 0, c = Math.cos(rotation), sn = Math.sin(rotation);
      const tf: Transform = {
        scale: grp.k * s,
        rotation,
        toScreen: (p) => ({ x: (grp.k * (c * p.x - sn * p.y) + grp.e) * s, y: H - (grp.k * (sn * p.x + c * p.y) + grp.f) * s }),
      };
      ctx.save();
      try {
        if (grp.clip) {
          ctx.beginPath();
          ctx.rect(grp.clip.x * s, H - (grp.clip.y + grp.clip.h) * s, grp.clip.w * s, grp.clip.h * s);
          ctx.clip();
        }
        if (grp.clipPolygon) {
          polygonPath(ctx, grp.clipPolygon.map((p) => ({ x: p.x * s, y: H - p.y * s })));
          ctx.clip('evenodd');
        }
        annotationDisplay.factor = grp.annoFactor;
        annotationDisplay.hide = !!grp.hideAnnotative;
        for (const e of grp.entities) {
          if (grp.hidden.has(e.layer)) continue;
          drawEntity(ctx, e, tf, ctxInfo.layers, lookup, { hidden: grp.hidden, imageLoader, underlaySource, underlayDefinitions: ctxInfo.underlays, ...(plot ? { plot } : {}), ...(mono ? { strokeOverride: '#000000' } : {}) });
        }
      } finally { ctx.restore(); }
      for (const f of grp.frames ?? []) {
        if (grp.hidden.has(f.layer)) continue;
        ctx.save();
        try {
          const appearance = plot && plotEntityAppearance({ layer: f.layer, color: 'ByLayer' }, ctxInfo.layers, plot.table, plot);
          for (const issue of appearance?.issues ?? []) plot?.issues?.add(`${issue.path}: ${issue.message}`);
          ctx.strokeStyle = appearance ? plotRgbCss(appearance.rgb) : '#000000';
          ctx.lineWidth = appearance ? Math.max(1, appearance.lineweightMm * dpi / 25.4) : Math.max(1, dpi / 100);
          if (appearance) ctx.globalAlpha *= resolveAlpha({ layer: f.layer }, ctxInfo.layers);
          if (f.polygon) {
            polygonPath(ctx, f.polygon.map((p) => ({ x: p.x * s, y: H - p.y * s })));
            ctx.stroke();
          } else ctx.strokeRect(f.x * s, H - (f.y + f.h) * s, f.w * s, f.h * s);
        } finally { ctx.restore(); }
      }
    }
  } finally {
    lineweightDisplay.enabled = saved.lw.enabled;
    lineweightDisplay.pxPerMm = saved.lw.pxPerMm;
    annotationDisplay.factor = saved.anno.factor;
    annotationDisplay.hide = saved.anno.hide;
    colorDisplay.paper = saved.paper;
    renderSettings.ltscale = saved.ltscale;
    renderSettings.linetypes = saved.linetypes;
  }
}
