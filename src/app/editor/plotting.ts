/**
 * PLOT and PRINT: the Plot / Print dialog, layout sheets and the vector PDF (app/plot-vector.ts),
 * and the raster sheet of the Model tab for the PDF writer or the system print dialog.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import type { Point } from '../../core/geometry';
import { layoutPage, type PlotOptions } from '../plot';
import { fileErrorText } from '../file-error-text';
import { plotLayoutsOrVector, captureUnderlayResolver } from '../plot-vector';
import type { Editor } from './editor';
import { capturedPlotLookup } from '../plot-fonts';
import { entityBounds } from '../../core/entities';
import * as geometry from '../../core/geometry';
import { paperSpaceLayout, paperEntities, sheetBounds } from '../../core/layouts';
import { capturePlot, ExportAdmission, type CapturedPlot } from '../export-admission';
import { isCommittedSaveAdmissionError, UNVERIFIED_COMMITTED_SAVE_WARNING } from '../save-admission';

export async function renderPlotImage(ed: Editor, opts: PlotOptions, captured?: CapturedPlot): Promise<{ dataUrl: string; landscape: boolean; sheet: { width: number; height: number }; electron?: string; reducedToFit: boolean } | null> {
  const source = captured ?? capturePlot(ed), state = source.state, capturedGeometry = source.geometry;
  const lookup = await capturedPlotLookup(state, capturedGeometry, source.xref ?? null);
  const hidden = new Set(state.layers.filter((l) => !l.visible).map((l) => l.name));
  const layout = paperSpaceLayout(state), entities = layout ? paperEntities(layout) : state.entities;
  let b: geometry.Bounds | null = null;
  for (const e of entities) if (!hidden.has(e.layer)) b = geometry.unionBounds(b, entityBounds(e, lookup));
  if (layout) b = geometry.unionBounds(b, sheetBounds(layout));
  if (!b) return null;
  const w = b.max.x - b.min.x;
  const h = b.max.y - b.min.y;
  const lay = layoutPage(w, h, opts);
  const dpi = 150;
  const pw = Math.ceil(lay.sheet.width * dpi);
  const ph = Math.ceil(lay.sheet.height * dpi);
  const canvas = document.createElement('canvas');
  // Cap the bitmap (E-size at 150 dpi is 6600 x 5100); scale the dpi down for anything larger.
  const shrink = Math.min(1, 12000 / pw, 12000 / ph);
  canvas.width = Math.round(pw * shrink);
  canvas.height = Math.round(ph * shrink);
  const px = dpi * shrink; // pixels per inch on the bitmap
  const k = lay.scale * px; // pixels per drawing unit
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ox = lay.origin.x * px;
  const oy = lay.origin.y * px;
  const tf = { scale: k, toScreen: (p: Point) => ({ x: ox + (p.x - b.min.x) * k, y: oy + (b.max.y - p.y) * k }) };
  const { drawEntity } = await import('../../render/draw');
  const sheetUnderlays = await captureUnderlayResolver(state, entities, source.underlayBytes, Math.round(px));
  for (const e of entities) {
    if (hidden.has(e.layer)) continue;
    drawEntity(ctx, e, tf, state.layers, lookup, { strokeOverride: '#000000', lineWidthOverride: Math.max(1, Math.round(px / 100)), hidden, imageLoader: source.imageLoader ?? (async () => null), underlaySource: sheetUnderlays.source, underlayDefinitions: state.underlays });
  }
  sheetUnderlays.dispose();
  return { dataUrl: canvas.toDataURL('image/png'), landscape: lay.landscape, sheet: lay.sheet, electron: lay.electron, reducedToFit: lay.reducedToFit };
}

export function plotOptions(ed: Editor): PlotOptions {
  const s = ed.settings;
  return { paper: s.plotPaper, orientation: s.plotOrientation, scale: s.plotScale, margin: s.plotMargin };
}

export async function plot(ed: Editor): Promise<void> {
  await plotOrPrint(ed, 'pdf').catch((err: unknown) => plotFailed(ed, err));
}

export async function print(ed: Editor): Promise<void> {
  await plotOrPrint(ed, 'print').catch((err: unknown) => plotFailed(ed, err));
}

/** A PDF that could not be written (disk full, locked file ...) is reported like a failed save. */
export function plotFailed(ed: Editor, err: unknown): void {
  ed.log(`Plot failed: ${isCommittedSaveAdmissionError(err) ? UNVERIFIED_COMMITTED_SAVE_WARNING : fileErrorText(err, { action: 'save' })}`);
}

export async function plotOrPrint(ed: Editor, mode: 'pdf' | 'print'): Promise<void> {
  const bridge = ed.fileBridge ?? null, admission = new ExportAdmission(bridge);
  try {
  const selected = await (ed.hooks.plot?.(mode) ?? Promise.resolve({ options: plotOptions(ed), action: mode }));
  const choice = selected ? { action: selected.action, options: { ...selected.options } } : null;
  if (!choice) return;
  if (choice.action === 'print') await admission.close();
  const captured = capturePlot(ed, bridge, choice.options.security === 'restricted-p2' ? 'restricted-p2' : 'none');
  // Track E: vector PDF (default output) and layout sheets; the raster Model-tab path below is unchanged.
  if (await plotLayoutsOrVector(ed, choice, { captured, admission })) return;
  const base = captured.base;
  if (choice.action === 'pdf') {
    if (!bridge?.plotPdf) { ed.log('Plotting is not available here.'); return; }
    if (!await admission.choose(`${base}.pdf`)) return;
  }
  const img = await ed.renderPlotImage(choice.options, captured);
  if (!img) {
    ed.log('Nothing to plot: this tab has no visible objects.');
    return;
  }
  if (img.reducedToFit) ed.log('The chosen scale did not fit the paper; the drawing was scaled down to fit.');
  const sheet = { ...img.sheet, electron: img.electron };
  if (choice.action === 'pdf') {
    const out = await admission.plotPdf(img.dataUrl, `${base}.pdf`, img.landscape, sheet);
    if (out) ed.log(`Plotted to ${out} (${img.sheet.width.toFixed(2)} x ${img.sheet.height.toFixed(2)} in).`);
    return;
  }
  if (!bridge?.printDrawing) {
    ed.log('Printing is not available here.');
    return;
  }
  try {
    const ok = await bridge.printDrawing(img.dataUrl, base, img.landscape, sheet);
    ed.log(ok ? 'Sent to the print dialog.' : 'Print cancelled.');
  } catch (err) {
    ed.log(`Print failed: ${(err as Error).message}`);
  }
  } finally { await admission.close(); }
}
