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
import type { ImageLoader } from '../render/draw';
import { renderPageToCanvas } from '../render/layouts';
import { capturedPlotLookup } from './plot-fonts';
import { capturedPdfLookup } from './pdf-fonts';
import { capturePlot, ExportAdmission, type PlotExportContext } from './export-admission';

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
    table: opts.styleTable,
    namedStyle: opts.namedStyle,
  };
}

/** What a choice plots: 'model', a layout name, or 'layouts'. */
export function plotTarget(state: DrawingState, opts: PlotOptions): 'model' | 'layouts' | string {
  if (opts.what === 'layouts') return 'layouts';
  return state.space ? state.space.layout : 'model';
}

/** Bitmaps of the IMAGE entities on the pages, as PDF image data (RGB, deflated when possible). */
async function collectImages(pages: readonly PdfPageSpec[], lookup: Editor['doc']['lookupBlock'], loader?: ImageLoader): Promise<Map<string, PdfImageData>> {
  const out = new Map<string, PdfImageData>();
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
export async function plotLayoutsOrVector(ed: Editor, choice: PlotChoiceLike, pending?: PlotExportContext): Promise<boolean> {
  const bridge = pending?.captured.bridge ?? ed.fileBridge ?? null;
  const admission = pending?.admission ?? new ExportAdmission(bridge, choice.action === 'pdf');
  try {
  const opts = { ...choice.options };
  const vector = choice.action === 'pdf' && opts.output !== 'raster';
  const captured = pending?.captured ?? capturePlot(ed, bridge, opts.security === 'restricted-p2' ? 'restricted-p2' : 'none'), snapshot = captured.state, base = captured.base;
  // The mode is the captured plot's frozen decision, not the live options.
  const restrictedMode = vector && captured.security === 'restricted-p2';
  // A restricted request on a non-vector route must never degrade into a
  // silent ordinary write (12.4 corrections): refuse here, before any
  // destination is chosen or anything is produced, with the way out named.
  if (captured.security === 'restricted-p2' && !vector) {
    ed.log('Editing restrictions require Vector PDF output, so this plot was not written. Re-plot with PDF output set to "Vector (recommended)" to use the restricted mode.');
    return true;
  }
  const targetHint = vector || !snapshot.space ? plotTarget(snapshot, opts) : snapshot.space.layout;
  const hiddenLayers = new Set(snapshot.layers.filter(layer => !layer.visible).map(layer => layer.name));
  if (choice.action === 'pdf' && targetHint === 'model' && snapshot.entities.every(entity => hiddenLayers.has(entity.layer))) {
    ed.log('Nothing to plot: this tab has no visible objects.'); return true;
  }
  if (!vector && !snapshot.space && !opts.styleTable) return false;
  if (!vector && opts.styleTable && opts.what === 'layouts') {
    ed.log('Raster plotting with CTB/STB tables supports one tab at a time. Choose Vector PDF for all layouts.');
    return true;
  }
  const suggested = vector ? targetHint === 'model' || targetHint === 'layouts' ? `${base}.pdf` : `${base}-${targetHint}.pdf` : `${base} - ${targetHint === 'model' ? 'Model' : targetHint}.pdf`;
  const name = suggested.replace(/[<>:"/\\|?*]/g, '_');
  if (choice.action === 'pdf') {
    if (!(vector ? bridge?.savePdf : bridge?.plotPdf)) { ed.log('Plotting is not available here.'); return true; }
    if (!await admission.choose(name)) return true;
  }
  const capturedGeometry = vector ? captured.vectorGeometry : captured.geometry;
  const initialLookup = await capturedPlotLookup(snapshot, capturedGeometry);
  const state = plottableState(snapshot, initialLookup);
  const target = vector || !snapshot.space ? plotTarget(state, opts) : snapshot.space.layout;
  const initialPages = vector ? plotPages(state, initialLookup, target, opts) : [];
  const prepared = vector ? await capturedPdfLookup(state, captured.pdfFont, initialPages.flatMap((page) => page.groups), initialLookup, { restricted: restrictedMode }) : null;
  const lookup = prepared?.lookup ?? initialLookup;
  const pages = plotPages(state, lookup, target, opts);
  if (pages.length === 0 || pages.every((p) => p.groups.every((grp) => grp.entities.length === 0 && !(grp.frames?.length)))) {
    ed.log(target === 'model' ? 'Nothing to plot: this tab has no visible objects.' : 'Nothing to plot: the layout is empty.');
    return true;
  }
  const layout = target === 'model' || target === 'layouts' ? activeLayout(state) : findLayout(state, target);
  const plotIssues = new Set<string>();
  const style = { ...styleFor(opts, layout), issues: plotIssues };
  const reportPlotStyles = () => {
    if (lookup.textGeometry?.fontIssues?.size) ed.log(`Font substitutes: ${[...lookup.textGeometry.fontIssues].slice(0, 20).join(' ')}`);
    const issues = [...plotIssues];
    if (issues.length) ed.log(`Plot style limitations: ${issues.slice(0, 20).join(' ')}${issues.length > 20 ? ` (${issues.length - 20} additional issues.)` : ''}`);
  };
  if (vector) {
    const images = await collectImages(pages, lookup, captured.imageLoader);
    const ctx = drawingContext(state, lookup, (p) => images.get(p) ?? null);
    const fontFallbacks = new Set<string>();
    Object.assign(ctx, { embeddedFonts: prepared?.fonts, textGeometry: prepared?.geometry, fontFallbacks, ...(prepared?.shapedText ? { shapedText: prepared.shapedText } : {}) });
    const title = target === 'model' ? base : target === 'layouts' ? `${base} - layouts` : `${base} - ${target}`;
    const bytes = await vectorPdfCompressed(pages, ctx, style, title, deflate);
    reportPlotStyles();
    if (fontFallbacks.size) ed.log(`PDF used substitute fonts for ${[...fontFallbacks].join(', ')}. ${prepared?.issues.join(' ') || 'Some glyphs or font formats are unsupported.'}`);
    if (!restrictedMode && prepared?.issues.some((issue) => issue.includes('preview/print embedding requires a read-only PDF'))) {
      ed.log('Fonts that allow preview/print embedding only were not embedded. Re-plot with "PDF with editing restrictions (for preview/print fonts)" enabled to embed them in a PDF that carries editing restrictions.');
    }
    // Restricted save (12.4): only preview/print faces the writer actually
    // used are claimed. With none, nothing in the file needs the mode, so the
    // export stays byte-identical to an ordinary one — and says so.
    let restrictedClaim: { faces: readonly import('../core/text-metrics').FontMetricsRequest[] } | undefined;
    if (restrictedMode) {
      const usedKeys = new Set((prepared?.fonts?.resources() ?? []).map((used) => used.face.key));
      const faces = (prepared?.restrictedFaces ?? []).filter((entry) => usedKeys.has(entry.key)).map((entry) => entry.request);
      if (faces.length) restrictedClaim = { faces };
      else ed.log('Editing restrictions were requested, but no preview/print font was used in this plot; the PDF was exported without restrictions.');
    }
    const out = await admission.savePdf(bytes, name, restrictedClaim);
    if (!out) return true;
    if (restrictedClaim) ed.log('The exported PDF carries editing restrictions (printing, copying and accessibility extraction allowed; editing, comments, form filling and page assembly denied). Some viewers ignore PDF permission flags; the restrictions are a request recorded in the file, not a guarantee.');
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
  renderPageToCanvas(canvas, page, drawingContext(state, lookup), style, dpi, captured.imageLoader ?? (async () => null));
  reportPlotStyles();
  const dataUrl = canvas.toDataURL('image/png');
  const sheet = { width: page.width / 72, height: page.height / 72 };
  const landscape = sheet.width >= sheet.height;
  const paperId = layout?.paper.id;
  const electron = PAPER_SIZES.find((p) => p.id === paperId)?.electron;
  const plotSheet = { ...sheet, ...(electron ? { electron } : {}) };
  const label = `${base} - ${page.label}`;
  if (choice.action === 'pdf') {
    const out = await admission.plotPdf(dataUrl, name, landscape, plotSheet);
    if (out) ed.log(`Plotted to ${out} (${sheet.width.toFixed(2)} x ${sheet.height.toFixed(2)} in).`);
    return true;
  }
  if (!bridge?.printDrawing) {
    ed.log('Printing is not available here.');
    return true;
  }
  try {
    const ok = await bridge.printDrawing(dataUrl, label, landscape, plotSheet);
    ed.log(ok ? `Sent ${page.label} to the print dialog.` : 'Print cancelled.');
  } catch (err) {
    ed.log(`Print failed: ${(err as Error).message}`);
  }
  return true;
  } finally { if (!pending) await admission.close(); }
}
