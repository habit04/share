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
import type { Entity, UnderlayEntity } from '../core/entities';
import { entityBounds, underlayPlacementOf, underlaySizeResolver, withUnderlaySizeChannel } from '../core/entities';
import { underlayMonochrome } from '../core/underlay';
import { adjustUnderlayPixels, underlayBackgroundKey, underlayStyleKey } from './underlay-adjust';
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
import { createPdfjsEngine } from '../io/underlay-pdfjs';
import type { UnderlayCanvasFactory, UnderlayRasterEngine } from '../io/underlay-engine';
import { createUnderlayDisplayService, type UnderlayByteSource, type UnderlayVariantCanvasFactory } from './underlay-render';
import { nullUnderlayBytes } from './underlay-bytes';
import type { UnderlayContentSource } from '../render/underlay-content';
import type { PdfUnderlayImage } from '../io/pdf-vector';
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

/**
 * The captured underlay resolver (P28 finish, design 6.1): its OWN display
 * service over the CAPTURED state — never the live editor's service — with
 * definitions read from the captured snapshot and bytes from the byte
 * source frozen at capture. Every PDF definition the plotted placements
 * reference is ensured at plot resolution before any page is produced, so
 * the synchronous consumers (vector walker, raster sheet) only ever read
 * settled entries. Disposed by the caller when the plot finishes.
 */
export interface CapturedUnderlayResolver {
  /** Synchronous source over the ensured entries (raster consumers). */
  readonly source: UnderlayContentSource;
  /** Prepared PDF image data for one placement (vector consumer). */
  readonly imageData: (e: UnderlayEntity) => PdfUnderlayImage | null;
  /** One entry per definition whose plot load did not produce a raster
   * (gate finding D1: a plot never falls back to frame parts SILENTLY).
   * Purely observational — recording a failure never changes what the
   * source/imageData seams serve. Callers merge these into the plot
   * issues, which reach the editor log. */
  readonly issues: ReadonlySet<string>;
  /** The loaded page size of an ensured definition, when its plot
   * load produced one (gate finding D4: the page-size-first source
   * for the extents channel). */
  pageSizeOf(defId: string): { width: number; height: number } | undefined;
  dispose(): void;
}

/** Test seams for the captured resolver: the raster engine, the
 * pixel-access canvas factory for style variants, and the tile
 * composite factory for over-cap plot loads. Production passes none
 * (the pdfjs engine and DOM factories are built here). */
export interface CapturedResolverSeams {
  readonly engine?: UnderlayRasterEngine;
  readonly variantCanvasFactory?: UnderlayVariantCanvasFactory;
  readonly tileCanvasFactory?: UnderlayCanvasFactory;
}

/** The declared paper background every plot variant derives against (design A.2.1). */
const PAPER_BACKGROUND: readonly [number, number, number] = [1, 1, 1];

/** DOM pixel-access canvas factory for plot style variants (design 5.3),
 * the same shape the composition root installs for the screen service. */
const domVariantCanvasFactory: UnderlayVariantCanvasFactory = {
  create(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('a 2d canvas context is unavailable for underlay variants');
    return {
      canvas,
      width,
      height,
      context: {
        drawImage: (image: unknown, dx: number, dy: number) => { context.drawImage(image as CanvasImageSource, dx, dy); },
        getImageData: (x: number, y: number, w: number, h: number) => context.getImageData(x, y, w, h),
        putImageData: (image: { data: Uint8ClampedArray }, dx: number, dy: number) => { context.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), dx, dy); },
      },
    };
  },
};

export async function captureUnderlayResolver(
  state: DrawingState,
  placements: readonly Entity[],
  bytesFor: UnderlayByteSource | undefined,
  dpi: number,
  seams?: CapturedResolverSeams,
): Promise<CapturedUnderlayResolver> {
  const defs = state.underlays ?? {};
  const service = createUnderlayDisplayService({
    engine: seams?.engine ?? createPdfjsEngine(),
    bytesFor: bytesFor ?? nullUnderlayBytes,
    definitions: () => state.underlays,
    targetBackground: () => PAPER_BACKGROUND, // the declared paper background (design A.2.1)
    tileCanvasFactory: seams?.tileCanvasFactory,
  });
  const ensured = new Map<string, { page: { width: number; height: number }; image: { bitmap: CanvasImageSource; width: number; height: number } }>();
  const issues = new Set<string>();
  const wanted = new Set<string>();
  for (const e of placements) {
    if (e.type !== 'underlay') continue;
    const def = Object.values(defs).find((d) => (d.handle ?? '').toUpperCase() === e.definitionHandle);
    if (def && def.kind === 'pdf') wanted.add(def.id);
  }
  for (const defId of wanted) {
    const def = Object.values(defs).find((d) => d.id === defId)!;
    const hit = await service.loadForPlot(def, dpi);
    if (hit) ensured.set(defId, hit);
    // D1: the miss is RECORDED, never silent — the definition is named
    // and the caller surfaces it with the plot issues. The fallback
    // itself is unchanged: no hit, no join, frame parts plot.
    else issues.add(`PDF underlay ${def.sourcePath} could not be loaded for plotting; its placements plot as frames.`);
  }
  const join = (e: Entity): { def: (typeof defs)[string]; hit: { page: { width: number; height: number }; image: { bitmap: CanvasImageSource; width: number; height: number } } } | undefined => {
    if (e.type !== 'underlay') return undefined;
    const def = Object.values(defs).find((d) => (d.handle ?? '').toUpperCase() === e.definitionHandle);
    const hit = def ? ensured.get(def.id) : undefined;
    return def && hit ? { def, hit } : undefined;
  };
  // Per-placement style variants (#57 P2 (2)): the raw page raster is the
  // canonical input; each placement's contrast/monochrome variant derives
  // from it through the SHARED canonical post-process (underlay-adjust,
  // design 5.3) against the paper background — the same derivation the
  // display service's contentFor performs for the screen. Identity
  // placements serve the raw raster object untouched; variants are cached
  // per definition + style, so two placements of one definition with
  // different styles each receive their own. Fade is NOT applied here
  // (draw-time alpha at the raster consumers; the vector writer's
  // recorded posture). No factory (headless) = raw serves, exactly the
  // display service's posture when no variant factory is installed.
  const variantFactory = seams?.variantCanvasFactory ?? (typeof document !== 'undefined' ? domVariantCanvasFactory : undefined);
  const variants = new Map<string, { bitmap: CanvasImageSource; width: number; height: number }>();
  const styledImage = (e: UnderlayEntity, joined: { def: (typeof defs)[string]; hit: { page: { width: number; height: number }; image: { bitmap: CanvasImageSource; width: number; height: number } } }): { bitmap: CanvasImageSource; width: number; height: number } => {
    const style = { contrast: e.contrast, mono: underlayMonochrome(underlayPlacementOf(e)), background: PAPER_BACKGROUND };
    const identity = (style.contrast === undefined || style.contrast === 100) && !style.mono;
    if (identity || !variantFactory) return joined.hit.image;
    const key = [joined.def.id, underlayStyleKey(style), underlayBackgroundKey(style.background)].join('|');
    let variant = variants.get(key);
    if (!variant) {
      const raw = joined.hit.image;
      const slot = variantFactory.create(raw.width, raw.height);
      slot.context.drawImage(raw.bitmap, 0, 0);
      const pixels = slot.context.getImageData(0, 0, raw.width, raw.height);
      const adjusted = adjustUnderlayPixels(pixels.data, raw.width, raw.height, style);
      slot.context.putImageData({ data: adjusted }, 0, 0);
      variant = { bitmap: slot.canvas as CanvasImageSource, width: raw.width, height: raw.height };
      variants.set(key, variant);
    }
    return variant;
  };
  // D5: a placement whose raster cannot be materialised (an oversize
  // canvas the platform refuses) plots as a frame — but never
  // silently: the failure is named on the same issues channel D1
  // built, which plotLayoutsOrVector merges into plotIssues after
  // the writer and renderer have run.
  const notePreparationFailure = (def: (typeof defs)[string]): void => {
    issues.add(`PDF underlay ${def.sourcePath} loaded, but its raster could not be prepared for plotting (the page is too large for a canvas); its placements plot as frames.`);
  };
  /** Canvas-extract a styled raster to RGB (white-matted), the
   * extraction imageData has always done. Throws when the platform
   * refuses the canvas — callers own the failure posture. */
  const extractRgb = (styled: { bitmap: CanvasImageSource; width: number; height: number }): { width: number; height: number; rgb: Uint8Array } => {
    const c = document.createElement('canvas');
    c.width = styled.width;
    c.height = styled.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(styled.bitmap, 0, 0);
    return { width: c.width, height: c.height, rgb: rgbaToRgb(ctx.getImageData(0, 0, c.width, c.height).data) };
  };
  // D6: imageData is synchronous (the vector walker consumes it), but
  // deflate is async — so the per-placement payloads are prepared
  // HERE, during the resolver's async capture: extract each captured
  // placement's styled raster and deflate it with the same helper
  // and payload shape collectImages uses for IMAGE entities
  // ({kind:'rgb', deflated:true}, raw RGB when deflate is
  // unavailable). A preparation failure records the D5 issue and
  // caches the frame outcome (null).
  const packed = new Map<string, PdfUnderlayImage | null>();
  if (typeof document !== 'undefined') {
    const seen = new Set<string>();
    for (const e of placements) {
      if (e.type !== 'underlay' || seen.has(e.id)) continue;
      seen.add(e.id);
      const joined = join(e);
      if (!joined) continue; // not ensured: imageData's own path answers null
      try {
        const { width, height, rgb } = extractRgb(styledImage(e, joined));
        const deflatedBytes = await deflate(rgb);
        packed.set(e.id, {
          data: deflatedBytes
            ? { width, height, data: deflatedBytes, kind: 'rgb', deflated: true }
            : { width, height, data: rgb, kind: 'rgb' },
          page: joined.hit.page,
        });
      } catch {
        notePreparationFailure(joined.def);
        packed.set(e.id, null);
      }
    }
  }
  return {
    issues,
    pageSizeOf: (defId) => ensured.get(defId)?.page,
    source: (e) => {
      const joined = join(e);
      if (!joined) return undefined;
      const view = joined.def.extent ? joined.def : { ...joined.def, extent: joined.hit.page };
      try {
        return { definition: view, page: joined.hit.page, image: styledImage(e, joined) };
      } catch {
        // D5 catch #2: the styled-variant derivation materialises a
        // canvas the platform can refuse (oversize); serve the frame
        // and name the failure instead of letting the throw escape.
        notePreparationFailure(joined.def);
        return { definition: view, page: joined.hit.page };
      }
    },
    imageData: (e) => {
      // D6: placements prepared at capture serve their deflated
      // payload (or their recorded frame outcome) from the cache.
      if (packed.has(e.id)) return packed.get(e.id) ?? null;
      const joined = join(e);
      if (!joined || typeof document === 'undefined') return null;
      const hit = joined.hit;
      try {
        const { width, height, rgb } = extractRgb(styledImage(e, joined));
        return { data: { width, height, data: rgb, kind: 'rgb' }, page: hit.page };
      } catch {
        // D5 catch #1: extraction (or the styled derivation above)
        // failed — the raster plots as frame parts, and says so.
        notePreparationFailure(joined.def);
        return null;
      }
    },
    dispose: () => { service.dispose(); },
  };
}

/** Handle a PLOT / PRINT choice when it involves a layout or vector PDF; false = the caller's raster model path. */
export async function plotLayoutsOrVector(ed: Editor, choice: PlotChoiceLike, pending?: PlotExportContext, seams?: CapturedResolverSeams): Promise<boolean> {
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
  const initialLookup = await capturedPlotLookup(snapshot, capturedGeometry, captured.xref ?? null);
  // A (#57 review P2) + D4: the captured resolver is created FIRST,
  // over the snapshot — it needs only the captured underlays, the
  // placements and the frozen byte source, none of which layout
  // initialisation changes (initializeLayout appends a viewport; it
  // never adds or removes layouts or entities, so the target and
  // the placement set derived from the snapshot are exactly the
  // ones the initialised state produces). Its settled page sizes
  // feed the page-tier channel (page-size-first) that BOTH extents
  // consumers then use: plottableState, whose pristine-layout
  // initialisation fits each new viewport to the extents — a
  // viewport fitted against the 1x1 placeholder (an extent-less
  // underlay under the old session-tier order) is stored state no
  // later lookup can repair — and plotPages, whose 'fit' layouts
  // scale to the real page frame. Explicitly edited (non-pristine)
  // viewports are never re-initialised; plottableState passes them
  // through verbatim. The SAME resolver serves the pages below:
  // one load per definition.
  const target = targetHint;
  const placements: Entity[] = [...snapshot.entities];
  {
    const layoutTargets = target === 'layouts' ? layoutsOf(snapshot) : target === 'model' ? [] : [findLayout(snapshot, target)].filter((l): l is Layout => !!l);
    for (const l of layoutTargets) placements.push(...l.entities);
  }
  const underlayResolver = await captureUnderlayResolver(snapshot, placements, captured.underlayBytes, vector ? 300 : 150, seams);
  const pageTierSizeOf = underlaySizeResolver(snapshot.underlays, (defId) => underlayResolver.pageSizeOf(defId));
  const state = plottableState(snapshot, withUnderlaySizeChannel(initialLookup, pageTierSizeOf));
  const initialPages = vector ? plotPages(state, initialLookup, target, opts) : [];
  const prepared = vector ? await capturedPdfLookup(state, captured.pdfFont, initialPages.flatMap((page) => page.groups), initialLookup, { restricted: restrictedMode }) : null;
  const lookup = withUnderlaySizeChannel(prepared?.lookup ?? initialLookup, pageTierSizeOf);
  const pages = plotPages(state, lookup, target, opts);
  if (pages.length === 0 || pages.every((p) => p.groups.every((grp) => grp.entities.length === 0 && !(grp.frames?.length)))) {
    underlayResolver.dispose();
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
    const ctx = drawingContext(state, lookup, (p) => images.get(p) ?? null, (e) => underlayResolver.imageData(e));
    const fontFallbacks = new Set<string>();
    Object.assign(ctx, { embeddedFonts: prepared?.fonts, textGeometry: prepared?.geometry, fontFallbacks, ...(prepared?.shapedText ? { shapedText: prepared.shapedText } : {}) });
    const title = target === 'model' ? base : target === 'layouts' ? `${base} - layouts` : `${base} - ${target}`;
    const bytes = await vectorPdfCompressed(pages, ctx, style, title, deflate);
    underlayResolver.dispose();
    // D5: resolver issues are merged only now — after the consumers
    // have run — because preparation failures are recorded by the
    // imageData/source calls the writer makes during the write.
    for (const issue of underlayResolver.issues) plotIssues.add(issue);
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
  underlayResolver.dispose(); // the page-tier resolver has served its sizes; the sheet gets its own at sheet dpi
  const rasterUnderlays = await captureUnderlayResolver(state, page.groups.flatMap((grp) => grp.entities), captured.underlayBytes, dpi, seams);
  renderPageToCanvas(canvas, page, drawingContext(state, lookup), style, dpi, captured.imageLoader ?? (async () => null), rasterUnderlays.source);
  rasterUnderlays.dispose();
  for (const issue of rasterUnderlays.issues) plotIssues.add(issue);
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
