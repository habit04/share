/** D1 pins — the plot path drops the page of any normal-size PDF (real-app
 * gate on #57, lead finding D1).
 *
 * The mechanism: the vector plot path resolves underlays at 300 dpi
 * through captureUnderlayResolver -> service.loadForPlot, which starts
 * the load with regionBucket 'full' but NO region, so the display
 * service's tiling branch (taken only with a region) never engages and
 * the untiled whole-page renderPage hits the 8 MiB per-page cap
 * (DEFAULT_UNDERLAY_CAPS.maxScanBytes): a letter page (612x792 pt) is
 * 2550x3300 px at 300 dpi = ~33.7 MB, and even at 150 dpi it is
 * 8.415 MB — over the cap by 26 KB. The entry settles failed, the
 * resolver's ensure loop skips the definition WITHOUT A WORD, and the
 * writer falls back to frame parts: a real.pdf plot comes out at
 * ~995 bytes with no image.
 *
 * The pins: (i) a cap-faithful fake engine at the resolver level —
 * a letter page at 300 dpi must resolve to image data and embed as an
 * image XObject in the vector PDF; (ii) the REAL pdfjs engine on a
 * generated real-size letter PDF — loadForPlot must serve the page by
 * tiles at 300 dpi; (iii) silence is a defect: a definition that
 * cannot load must surface on the resolver's issues channel, named,
 * while the frame fallback still plots; (iv) regression guard — a
 * small page under the cap keeps the untiled path and serves the
 * engine's raster object untouched.
 *
 * The composite height is 3301, not the nominal 3300: the service and
 * the adapter both size rasters by Math.ceil(size * scale), and
 * 792 * (300/72) is 3300.0000000000005 in doubles. That is the
 * pre-existing whole-page arithmetic, unchanged by this lane.
 */
import './pdfjs-node-shims';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Drawing, type DrawingState } from '../src/core/document';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { underlayRefusal, type UnderlayClipRect, type UnderlayDocument, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../src/io/underlay-adapter';
import { createPdfjsEngine } from '../src/io/underlay-pdfjs';
import { createUnderlayDisplayService } from '../src/app/underlay-render';
import { captureUnderlayResolver } from '../src/app/plot-vector';
import { plotPages, vectorPdf, drawingContext, type PdfPlotStyle } from '../src/io/pdf-vector';
import type { PlotOptions } from '../src/app/plot';
import { parsePdfBasics, pageContents } from './helpers/pdf';

const MAX = DEFAULT_UNDERLAY_CAPS.maxScanBytes;
const COLOR: PdfPlotStyle = { mode: 'color', lineweights: true, usePlotStyles: true };
const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };

interface Px { px: Uint8ClampedArray; w: number; h: number }
const filled = (w: number, h: number, v = 200): Px => {
  const px = new Uint8ClampedArray(w * h * 4);
  px.fill(v);
  return { px, w, h };
};

/** A fake engine that enforces the REAL cap arithmetic, like the pdfjs
 * adapter: a raster whose bytes exceed maxScanBytes is refused
 * 'scan-limit' BEFORE rendering. Whole-page rasters size by ceil,
 * region rasters by round — the adapter's own sizing rules. */
function capEngine(page: { width: number; height: number }, opts: { refuseAll?: boolean } = {}) {
  const calls = {
    renderPage: [] as Array<{ scale: number }>,
    renderRegion: [] as Array<{ region: UnderlayClipRect; scale: number }>,
  };
  const engine: UnderlayRasterEngine = {
    kind: 'pdf',
    open: async () => ({
      ok: true,
      value: {
        pageCount: 1,
        pageSize: async () => ({ ok: true, value: page }),
        renderPage: async (_p: number, scale: number) => {
          calls.renderPage.push({ scale });
          if (opts.refuseAll) return underlayRefusal('corrupt', 'this engine refuses every render');
          const w = Math.max(1, Math.ceil(page.width * scale));
          const h = Math.max(1, Math.ceil(page.height * scale));
          if (w * h * 4 > MAX) return underlayRefusal('scan-limit', `rendering the whole page needs ${w * h * 4} bytes, over the ${MAX}-byte cap`);
          return { ok: true, value: { image: filled(w, h) as unknown as CanvasImageSource, width: w, height: h, pageSize: page } };
        },
        renderRegion: async (_p: number, region: UnderlayClipRect, scale: number) => {
          calls.renderRegion.push({ region, scale });
          if (opts.refuseAll) return underlayRefusal('corrupt', 'this engine refuses every render');
          const w = Math.max(1, Math.round(region.width * scale));
          const h = Math.max(1, Math.round(region.height * scale));
          if (w * h * 4 > MAX) return underlayRefusal('scan-limit', `rendering this clip needs ${w * h * 4} bytes, over the ${MAX}-byte cap`);
          return { ok: true, value: { image: filled(w, h) as unknown as CanvasImageSource, width: w, height: h, pageSize: page, region } };
        },
        close: () => {},
      } as UnderlayDocument,
    }),
  };
  return { engine, calls };
}

/** Tile composite factory whose canvas IS a pixel holder, so the
 * composited raster (and imageData derived from it) is assertable. */
function pixelTileFactory() {
  const draws: Array<{ dx: number; dy: number }> = [];
  return {
    draws,
    factory: {
      create(width: number, height: number) {
        const holder = filled(width, height, 0);
        return {
          canvas: holder, width, height,
          context: {
            drawImage(image: unknown, dx: number, dy: number) {
              draws.push({ dx, dy });
              const src = image as Px;
              for (let y = 0; y < src.h && dy + y < height; y += 1) {
                holder.px.set(src.px.subarray(y * src.w * 4, (y + 1) * src.w * 4), ((dy + y) * width + dx) * 4);
              }
            },
          },
        };
      },
    },
  };
}

/** imageData's extraction canvas (the document path), pixel-backed —
 * the tests/plot-underlay-variants.test.ts idiom. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    createElement: (name: string) => {
      if (name !== 'canvas') throw new Error(`unexpected element ${name}`);
      const holder: { px: Uint8ClampedArray } = { px: new Uint8ClampedArray(0) };
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          fillRect: () => {},
          drawImage: (img: unknown) => { holder.px = (img as Px).px; },
          getImageData: () => ({ data: holder.px }),
        }),
      };
    },
  });
}

const DEF: UnderlayDefinition = { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf', retainedGroups: [] };
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

function plotState(e: UnderlayEntity): DrawingState {
  const doc = new Drawing({
    entities: [e],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: DEF },
  });
  return doc.snapshot;
}

function writeVectorPdf(state: DrawingState, imageData: (e: UnderlayEntity) => unknown) {
  const lookup = (n: string) => state.blocks[n];
  const pages = plotPages(state, lookup, 'model', OPTS);
  const ctx = drawingContext(state, lookup, undefined, imageData as never);
  const bytes = vectorPdf(pages, ctx, COLOR, 'D1');
  const info = parsePdfBasics(bytes);
  const contents = pageContents(info, (b) => new Uint8Array(inflateSync(b)));
  return { bytes, info, contents };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('D1: the plot path tiles normal-size pages instead of dropping them', () => {
  it('(i) a letter page at 300 dpi resolves through tiles and embeds as an image XObject', async () => {
    stubDocument();
    const { engine, calls } = capEngine({ width: 612, height: 792 });
    const tiles = pixelTileFactory();
    const e = placement();
    const resolver = await captureUnderlayResolver(plotState(e), [e], async () => new Uint8Array([1, 2, 3]), 300, {
      engine, tileCanvasFactory: tiles.factory,
    });
    const content = resolver.source(e);
    const data = resolver.imageData(e);
    const { info } = writeVectorPdf(plotState(e), (x) => resolver.imageData(x));
    resolver.dispose();
    // The cap is predicted from the page size, never crashed into:
    // the doomed whole-page render is not attempted; tiles carried it.
    expect(calls.renderPage).toEqual([]);
    expect(calls.renderRegion.length).toBe(5); // letter at 300 dpi under the 8 MiB cap
    expect(tiles.draws).toHaveLength(5);
    expect(content?.image).toBeDefined();
    expect(content?.image?.width).toBe(2550);
    expect(content?.image?.height).toBe(3301); // ceil arithmetic — see the file header
    expect(data).not.toBeNull();
    expect(data?.data.width).toBe(2550);
    expect(data?.data.height).toBe(3301);
    expect(info.images).toHaveLength(1);
    expect(info.images[0]).toMatchObject({ width: 2550, height: 3301 });
  });

  it('(iii) a definition that cannot load is NAMED on the issues channel; the frame fallback still plots', async () => {
    stubDocument();
    const { engine } = capEngine({ width: 612, height: 792 }, { refuseAll: true });
    const e = placement();
    const resolver = await captureUnderlayResolver(plotState(e), [e], async () => new Uint8Array([1, 2, 3]), 300, { engine });
    const issues = [...resolver.issues];
    const data = resolver.imageData(e);
    const { bytes, info, contents } = writeVectorPdf(plotState(e), (x) => resolver.imageData(x));
    resolver.dispose();
    expect(issues.some((s) => s.includes('sheet.pdf'))).toBe(true);
    expect(data).toBeNull();
    expect(info.images).toHaveLength(0); // no image — the frame parts carry the plot
    expect(bytes.length).toBeGreaterThan(0);
    expect(contents.join('\n')).toContain(' S');
  });

  it('(iv) a small page under the cap keeps the untiled path and serves the engine raster untouched', async () => {
    const page = { width: 100, height: 80 }; // 417x334 px at 300 dpi — well under the cap
    const { engine, calls } = capEngine(page);
    const e = placement();
    const resolver = await captureUnderlayResolver(plotState(e), [e], async () => new Uint8Array([1, 2, 3]), 300, { engine });
    const content = resolver.source(e);
    resolver.dispose();
    expect(calls.renderRegion).toEqual([]);
    expect(calls.renderPage).toHaveLength(1);
    expect(content?.image?.width).toBe(417);
    expect(content?.image?.height).toBe(334);
    expect(resolver.issues.size).toBe(0);
  });

  it('the two plotLayoutsOrVector call sites merge the resolver issues into the plot issues', () => {
    const src = readFileSync('src/app/plot-vector.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function plotLayoutsOrVector'));
    expect(body.split('plotIssues.add(issue)')).toHaveLength(3); // vector + raster call sites
  });
});

/** Minimal correct-xref PDF builder, letter page (tests/underlay-pdfjs.test.ts idiom). */
function buildLetterPdf(): Uint8Array {
  const objs: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>'],
  ];
  const stream = '0 0 1 rg 10 10 50 50 re f';
  objs.push([4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [num, content] of objs) {
    offsets[num] = out.length;
    out += `${num} 0 obj\n${content}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 5\n0000000000 65535 f \n`;
  for (let n = 1; n < 5; n += 1) out += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('D1 (ii): the real pdfjs engine serves a real-size letter page to loadForPlot by tiles', () => {
  it('loadForPlot(def, 300) returns the page, composited from regions at full print size', async () => {
    const WORKER_SRC = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    const record: string[] = [];
    // The stub-canvas shape proven by tests/underlay-pdfjs.test.ts: a
    // base of concrete context methods pdfjs reads values from, with a
    // recording Proxy fallback for the rest.
    const stubFactory = {
      create: (width: number, height: number) => {
        const base: Record<string, unknown> = {
          measureText: (t: string) => ({ width: t.length * 6 }),
          createLinearGradient: () => ({ addColorStop: () => undefined }),
          createRadialGradient: () => ({ addColorStop: () => undefined }),
          createPattern: () => ({}),
          getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }),
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
          getLineDash: () => [],
        };
        const context = new Proxy(base, {
          get: (t, p) => (p in t ? t[p as string] : (...a: unknown[]) => { record.push(String(p)); void a; }),
          set: () => true,
        });
        const canvas = { width, height, getContext: () => context };
        return { canvas, context, width, height };
      },
    };
    const real = createPdfjsEngine({ workerSrc: WORKER_SRC, canvasFactory: stubFactory as never });
    const calls = { renderPage: 0, renderRegion: [] as UnderlayClipRect[] };
    let doc: UnderlayDocument | undefined;
    const counting: UnderlayRasterEngine = {
      kind: 'pdf',
      open: async (bytes, opts) => {
        const r = await real.open(bytes, opts);
        if (!r.ok) return r;
        doc = r.value;
        const inner = r.value;
        return {
          ok: true,
          value: {
            pageCount: inner.pageCount,
            pageSize: (p, o) => inner.pageSize(p, o),
            renderPage: (p, s, o) => { calls.renderPage += 1; return inner.renderPage(p, s, o); },
            renderRegion: (p, reg, s, o) => { calls.renderRegion.push(reg); return inner.renderRegion(p, reg, s, o); },
            close: () => inner.close(),
          } as UnderlayDocument,
        };
      },
    };
    const draws: Array<{ dx: number; dy: number }> = [];
    const svc = createUnderlayDisplayService({
      engine: counting,
      bytesFor: async () => buildLetterPdf(),
      definitions: () => ({ d: DEF }),
      tileCanvasFactory: {
        create(width: number, height: number) {
          const canvas = { composite: true };
          return { canvas, width, height, context: { drawImage: (_i: unknown, dx: number, dy: number) => { draws.push({ dx, dy }); } } };
        },
      },
    });
    try {
      const hit = await svc.loadForPlot(DEF, 300);
      expect(hit).toBeDefined();
      expect(hit?.page).toEqual({ width: 612, height: 792 });
      expect(hit?.image.width).toBe(2550);
      expect(hit?.image.height).toBe(3301); // ceil arithmetic — see the file header
      expect(calls.renderRegion.length).toBe(5);
      expect(draws).toHaveLength(5);
      // The plan works in whole pixel rows, so the tiles' union in
      // page units overhangs the page by less than one pixel row
      // (the adapter intersects each tile with the page on render).
      const covered = calls.renderRegion.reduce((a, r) => a + r.width * r.height, 0);
      expect(covered).toBeGreaterThanOrEqual(612 * 792);
      expect(covered - 612 * 792).toBeLessThan(612 / (300 / 72) + 1);
    } finally {
      svc.dispose();
      doc?.close();
    }
  }, 30_000);
});
