/**
 * PLOT / PRINT with layouts and vector PDF (Track E). Editor.plotOrPrint hands every choice
 * here first:
 *   - PDF output "vector" (the default): the Model tab, the active layout or all layouts as
 *     real PDF paths (io/pdf-vector.ts), saved through FileBridge.savePdf (desktop: the
 *     save-pdf IPC, no Electron printToPDF; browser: a download).
 *   - a layout with PRINT or PDF output "raster": the layout sheet rendered to a bitmap and
 *     handed to the existing plotPdf / printDrawing bridges.
 * The raster plot / print of the Model tab stays in Editor.renderPlotImage (returns false).
 */
import type { Editor } from './editor';
import type { PlotOptions } from './plot';
import { PAPER_SIZES } from './plot';
import type { DrawingState } from '../core/document';
import type { Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { entityBounds } from '../core/entities';
import { findLayout, layoutsOf, activeLayout, type Layout } from '../core/layouts';
import { initializeLayout } from '../tools/layouts';
import {
  plotPages,
  drawingContext,
  vectorPdfCompressed,
  layoutPlotStyle,
  type PdfPageSpec,
  type PdfPlotStyle,
  type PdfImageData,
} from '../io/pdf-vector';
import { deflate, rgbaToRgb } from '../io/pdf';
import { renderSettings } from '../render/draw';
import { renderPageToCanvas } from '../render/layouts';

export interface PlotChoiceLike {
  options: PlotOptions;
  action: 'pdf' | 'print';
}

/** State with every layout that has never been shown initialised (its default viewport), as PLOT sees it. */
export function plottableState(state: DrawingState, lookup: (n: string) => ReturnType<Editor['doc']['lookupBlock']>): DrawingState {
  let s = state;
  let ext: Bounds | null | undefined;
  for (const l of layoutsOf(state)) {
    if (!l.pristine) continue;
    if (ext === undefined) {
      const hidden = new Set(state.layers.filter((x) => !x.visible).map((x) => x.name));
      ext = null;
      for (const e of state.entities) if (!hidden.has(e.layer)) ext = g.unionBounds(ext, entityBounds(e, lookup));
    }
    s = initializeLayout(s, l.name, ext);
  }
  return s;
}

/** The plot style from the dialog, falling back to the layout's page setup. */
export function styleFor(opts: PlotOptions, layout: Layout | undefined): PdfPlotStyle {
  const fromLayout = layout ? layoutPlotStyle(layout) : { mode: 'monochrome' as const, lineweights: true, usePlotStyles: true };
  return {
    mode: opts.style ?? fromLayout.mode,
    screening: opts.screening ?? fromLayout.screening,
    lineweights: opts.lineweights ?? fromLayout.lineweights,
    usePlotStyles: opts.usePlotStyles ?? fromLayout.usePlotStyles,
  };
}

/** What a choice plots: 'model', a layout name, or 'layouts'. */
export function plotTarget(state: DrawingState, opts: PlotOptions): 'model' | 'layouts' | string {
  if (opts.what === 'layouts') return 'layouts';
  return state.space ? state.space.layout : 'model';
}

/** Bitmaps of the IMAGE entities on the pages, as PDF image data (RGB, deflated when possible). */
async function collectImages(pages: readonly PdfPageSpec[], lookup: Editor['doc']['lookupBlock']): Promise<Map<string, PdfImageData>> {
  const out = new Map<string, PdfImageData>();
  const loader = renderSettings.imageLoader;
  if (!loader || typeof document === 'undefined') return out;
  const paths = new Set<string>();
  const visit = (list: readonly Entity[], depth = 0) => {
    for (const e of list) {
      if (e.type === 'image' && e.path) paths.add(e.path);
      else if (e.type === 'insert' && depth < 8) visit(lookup(e.block)?.entities ?? [], depth + 1);
    }
  };
  for (const p of pages) for (const grp of p.groups) visit(grp.entities);
  for (const path of paths) {
    try {
      const bmp = await loader(path);
      if (!bmp) continue;
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0);
      const rgb = rgbaToRgb(ctx.getImageData(0, 0, c.width, c.height).data);
      const packed = await deflate(rgb);
      out.set(path, packed ? { width: c.width, height: c.height, data: packed, kind: 'rgb', deflated: true } : { width: c.width, height: c.height, data: rgb, kind: 'rgb' });
    } catch {
      /* unreadable image: the frame and file name are plotted */
    }
  }
  return out;
}

const inches = (pt: number) => (pt / 72).toFixed(2);

/** Handle a PLOT / PRINT choice when it involves a layout or vector PDF; false = the caller's raster model path. */
export async function plotLayoutsOrVector(ed: Editor, choice: PlotChoiceLike): Promise<boolean> {
  const opts = choice.options;
  const vector = choice.action === 'pdf' && opts.output !== 'raster';
  const snapshot = ed.doc.snapshot;
  if (!vector && !snapshot.space) return false;
  const lookup = ed.doc.lookupBlock;
  const state = plottableState(snapshot, lookup);
  const target = vector ? plotTarget(state, opts) : snapshot.space!.layout;
  const pages = plotPages(state, lookup, target, opts);
  if (pages.length === 0 || pages.every((p) => p.groups.every((grp) => grp.entities.length === 0 && !(grp.frames?.length)))) {
    ed.log(target === 'model' ? 'Nothing to plot: this tab has no visible objects.' : 'Nothing to plot: the layout is empty.');
    return true;
  }
  const layout = target === 'model' || target === 'layouts' ? activeLayout(state) : findLayout(state, target);
  const style = styleFor(opts, layout);
  const base = ed.fileName().replace(/\.[^.]+$/, '');
  if (vector) {
    const images = await collectImages(pages, lookup);
    const ctx = drawingContext(state, lookup, (p) => images.get(p) ?? null);
    const title = target === 'model' ? base : target === 'layouts' ? `${base} - layouts` : `${base} - ${target}`;
    const bytes = await vectorPdfCompressed(pages, ctx, style, title, deflate);
    const save = ed.fileBridge?.savePdf;
    if (!save) {
      ed.log('Plotting is not available here.');
      return true;
    }
    const name = target === 'model' || target === 'layouts' ? `${base}.pdf` : `${base}-${target}.pdf`;
    const out = await save(bytes, name.replace(/[<>:"/\\|?*]/g, '_'));
    if (!out) return true;
    const first = pages[0]!;
    if (pages.length === 1) ed.log(`Plotted to ${out} (${inches(first.width)} x ${inches(first.height)} in).`);
    else ed.log(`Plotted ${pages.length} pages to ${out} (${pages.map((p) => `${p.label} ${inches(p.width)} x ${inches(p.height)} in`).join(', ')}).`);
    return true;
  }
  // A layout sheet as a raster image: PRINT, or PDF output "Raster image".
  const page = pages[0]!;
  const canvas = document.createElement('canvas');
  const maxPx = 12000;
  const dpi = Math.min(150, (maxPx / Math.max(page.width, page.height)) * 72);
  renderPageToCanvas(canvas, page, drawingContext(state, lookup), style, dpi);
  const dataUrl = canvas.toDataURL('image/png');
  const sheet = { width: page.width / 72, height: page.height / 72 };
  const landscape = sheet.width >= sheet.height;
  const paperId = layout?.paper.id;
  const electron = PAPER_SIZES.find((p) => p.id === paperId)?.electron;
  const plotSheet = { ...sheet, ...(electron ? { electron } : {}) };
  const label = `${base} - ${page.label}`;
  if (choice.action === 'pdf') {
    if (!ed.fileBridge?.plotPdf) {
      ed.log('Plotting is not available here.');
      return true;
    }
    const out = await ed.fileBridge.plotPdf(dataUrl, `${label}.pdf`, landscape, plotSheet);
    if (out) ed.log(`Plotted to ${out} (${sheet.width.toFixed(2)} x ${sheet.height.toFixed(2)} in).`);
    return true;
  }
  if (!ed.fileBridge?.printDrawing) {
    ed.log('Printing is not available here.');
    return true;
  }
  try {
    const ok = await ed.fileBridge.printDrawing(dataUrl, label, landscape, plotSheet);
    ed.log(ok ? `Sent ${page.label} to the print dialog.` : 'Print cancelled.');
  } catch (err) {
    ed.log(`Print failed: ${(err as Error).message}`);
  }
  return true;
}
