/**
 * Layout (paper space) view: the sheet on a grey background with a drop shadow, the
 * printable area dashed, each floating viewport's model space clipped to its rectangle at
 * its scale, the paper-space entities on top and the viewport frames (the active one bold).
 * Installed as `Viewport.layoutPainter` by tools/layouts.ts while a layout tab is active.
 */
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { entityBounds } from '../core/entities';
import type { Drawing } from '../core/document';
import type { Viewport, ViewportOverlay } from './viewport';
import { drawEntity, lineweightDisplay, annotationDisplay, colorDisplay, type Transform } from './draw';
import {
  activeLayout,
  modelToPaper,
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
  return { scale: pv.scale * vp.view.scale, toScreen: (m) => paper.toScreen(modelToPaper(vp, m)), viewBounds: viewportModelBounds(vp) };
}

/** Screen rectangle of a viewport under a paper view (x, y = top-left). */
export function viewportScreenRect(vp: LayoutViewport, pv: PaperView, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const paper = paperTransform(pv, width, height);
  const b = viewportPaperBounds(vp);
  const tl = paper.toScreen({ x: b.min.x, y: b.max.y });
  return { x: tl.x, y: tl.y, w: vp.width * pv.scale, h: vp.height * pv.scale };
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
  const lookup = doc.lookupBlock;
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
    // ---- viewport frames (hidden with their layer, like AutoCAD; the active one is bold)
    for (const v of layout.viewports) {
      const active = v.id === spaceVp;
      if (hidden.has(v.layer) && !active) continue;
      const r = viewportScreenRect(v, pv, W, H);
      ctx.save();
      const selected = inPaper && ov.selection.has(v.id);
      ctx.strokeStyle = active ? LAYOUT_COLORS.activeFrame : LAYOUT_COLORS.frame;
      ctx.lineWidth = active ? 3 : inPaper && ov.hover === v.id ? 2 : 1;
      if (selected) ctx.setLineDash([6, 4]);
      ctx.strokeRect(vp.px(r.x, ctx.lineWidth), vp.px(r.y, ctx.lineWidth), Math.round(r.w), Math.round(r.h));
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
