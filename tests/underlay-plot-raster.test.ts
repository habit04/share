/** R1 pins — the Model-tab RASTER plot path never got the D4/D5
 * treatment (real-app gate #3 on #57, lead finding R1; full text
 * PR #57 comment 6407922900).
 *
 * renderPlotImage (src/app/editor/plotting.ts) computed its extents
 * with entityBounds(e, lookup) BEFORE the underlay resolver was
 * created, so an extent-less PDF underlay bounded by the 1x1
 * placeholder: PLOT tabloid/landscape/fit of a drawing whose content
 * is a real PDF page produced a raster 99.84% white (frame corner
 * only). And it never read sheetUnderlays.issues, so a page that
 * loaded but could not be prepared at draw time (the D5 14400 pt
 * shape) plotted SILENTLY on this path.
 *
 * The ruled fix mirrors plotLayoutsOrVector: create the resolver
 * FIRST, feed the loaded page sizes into the extents (the D4
 * page-size channel on the lookup), and merge the resolver's issues
 * into the editor log ('Plot style limitations: ...') after the draw.
 * PRINT shares renderPlotImage (plotOrPrint is its sole production
 * caller), so it is covered by the same change.
 *
 * Harness: renderPlotImage is driven directly with a hand-built
 * CapturedPlot and a fake Editor carrying a log recorder. The fake
 * raster engine reaches the resolver through the resolver-seams
 * argument threaded through renderPlotImage (the route every
 * D1/D4/D5/D6 pin uses at the resolver level; production callers
 * pass nothing). The document stub is a matrix-tracking canvas rig:
 * drawImage calls are recorded with their transformed on-sheet
 * rect, so the fit itself is the observable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import type { PlotOptions } from '../src/app/plot';
import { renderPlotImage } from '../src/app/editor/plotting';
import type { Editor } from '../src/app/editor/editor';
import type { CapturedPlot } from '../src/app/export-admission';
import { underlayRefusal, type UnderlayClipRect, type UnderlayDocument, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../src/io/underlay-adapter';
import { defaultLayout } from '../src/core/layouts';

const MAX = DEFAULT_UNDERLAY_CAPS.maxScanBytes;
/** The harness canvas ceiling the oversize variant factory trips on. */
const AREA_CAP = 40_000_000;
const LETTER = { width: 612, height: 792 };
const HUGE = { width: 14400, height: 14400 };
const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };

const DEF: UnderlayDefinition = { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf', retainedGroups: [] };
const DEF_HUGE: UnderlayDefinition = { id: 'underlaydef:77', handle: '77', kind: 'pdf', sourcePath: 'huge.pdf', retainedGroups: [] };
const DEF_EXTENT: UnderlayDefinition = { ...DEF, extent: { width: 200, height: 100 } };

const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

const layer = (name: string, visible = true) => ({ name, color: 7, visible, locked: false, lineWeight: 0.5 });

function stateWith(e: UnderlayEntity, def: UnderlayDefinition = DEF, visible = true): DrawingState {
  return new Drawing({ entities: [e], blocks: {}, layers: [layer('U', visible)], underlays: { d: def } }).snapshot;
}

const capturedFor = (state: DrawingState): CapturedPlot => ({
  state, base: 'r1', bridge: null, security: 'none',
  underlayBytes: async () => new Uint8Array([1, 2, 3]),
});

const edFor = (logs: string[]): Editor => ({ log: (m: string) => { logs.push(m); } }) as unknown as Editor;

// ---------------------------------------------------------------- engines

interface Px { px: Uint8ClampedArray; w: number; h: number }
const filled = (w: number, h: number, v = 200): Px => {
  const px = new Uint8ClampedArray(w * h * 4);
  px.fill(v);
  return { px, w, h };
};

/** A fake engine that enforces the REAL cap arithmetic, like the
 * pdfjs adapter (tests/underlay-plot-tiling.test.ts idiom). */
function capEngine(page: { width: number; height: number }, opts: { refuseAll?: boolean } = {}): UnderlayRasterEngine {
  return {
    kind: 'pdf',
    open: async () => ({
      ok: true,
      value: {
        pageCount: 1,
        pageSize: async () => ({ ok: true, value: page }),
        renderPage: async (_p: number, scale: number) => {
          if (opts.refuseAll) return underlayRefusal('corrupt', 'this engine refuses every render');
          const w = Math.max(1, Math.ceil(page.width * scale));
          const h = Math.max(1, Math.ceil(page.height * scale));
          if (w * h * 4 > MAX) return underlayRefusal('scan-limit', `rendering the whole page needs ${w * h * 4} bytes, over the ${MAX}-byte cap`);
          return { ok: true, value: { image: filled(w, h) as unknown as CanvasImageSource, width: w, height: h, pageSize: page } };
        },
        renderRegion: async (_p: number, region: UnderlayClipRect, scale: number) => {
          if (opts.refuseAll) return underlayRefusal('corrupt', 'this engine refuses every render');
          const w = Math.max(1, Math.round(region.width * scale));
          const h = Math.max(1, Math.round(region.height * scale));
          if (w * h * 4 > MAX) return underlayRefusal('scan-limit', `rendering this clip needs ${w * h * 4} bytes, over the ${MAX}-byte cap`);
          return { ok: true, value: { image: filled(w, h) as unknown as CanvasImageSource, width: w, height: h, pageSize: page, region } };
        },
        close: () => {},
      } as unknown as UnderlayDocument,
    }),
  };
}

/** An engine whose page loads fine at any size (claimed dims only —
 * the composite lives in the stub tile factory, which never
 * allocates), the D5 repro shape: the load SUCCEEDS. */
function engineFor(page: { width: number; height: number }): UnderlayRasterEngine {
  return {
    kind: 'pdf',
    open: async () => ({
      ok: true,
      value: {
        pageCount: 1,
        pageSize: async () => ({ ok: true, value: page }),
        renderPage: async (_p: number, scale: number) => {
          const w = Math.ceil(page.width * scale);
          const h = Math.ceil(page.height * scale);
          return { ok: true, value: { image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h, pageSize: page } };
        },
        renderRegion: async (_p: number, region: { width: number; height: number }, scale: number) => {
          const w = Math.ceil(region.width * scale);
          const h = Math.ceil(region.height * scale);
          return { ok: true, value: { image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h } };
        },
        close: () => {},
      } as unknown as UnderlayDocument,
    }),
  };
}

/** Counts engine opens and document closes (dispose observability). */
function counting(inner: UnderlayRasterEngine) {
  const stats = { opens: 0, closes: 0 };
  const engine: UnderlayRasterEngine = {
    kind: 'pdf',
    open: async (bytes, opts) => {
      const r = await inner.open(bytes, opts);
      if (!r.ok) return r;
      stats.opens += 1;
      const doc = r.value;
      return { ok: true, value: { ...doc, close: () => { stats.closes += 1; doc.close(); } } as UnderlayDocument };
    },
  };
  return { engine, stats };
}

/** Tile factory whose canvases ARE pixel holders, so the composited
 * raster is a real pixel buffer (tests/underlay-plot-tiling.test.ts). */
function pixelTileFactory() {
  return {
    create(width: number, height: number) {
      const holder = filled(width, height, 0);
      return {
        canvas: holder, width, height,
        context: {
          drawImage(image: unknown, dx: number, dy: number) {
            const src = image as Px;
            for (let y = 0; y < src.h && dy + y < height; y += 1) {
              holder.px.set(src.px.subarray(y * src.w * 4, (y + 1) * src.w * 4), ((dy + y) * width + dx) * 4);
            }
          },
        },
      };
    },
  };
}

/** Tile factory whose canvases are inert holders (no allocation). */
const holderTileFactory = {
  create: (width: number, height: number) => ({
    canvas: { width, height } as unknown as HTMLCanvasElement,
    context: { drawImage: () => {} },
    width,
    height,
  }),
};

/** Variant factory that refuses oversize canvases, the way a real
 * canvas fails on a 14400x14400 raster (D5 pin idiom). */
const throwingVariantFactory = {
  create: (width: number, height: number) => {
    if (width * height > AREA_CAP) throw new Error('variant canvas allocation failed');
    return {
      canvas: { width, height } as unknown as HTMLCanvasElement,
      context: {
        drawImage: () => {},
        getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      },
      width,
      height,
    };
  },
};

// ---------------------------------------------------------------- canvas rig

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

interface DrawnImage { width: number; height: number; rect: { x: number; y: number; w: number; h: number } }

/** A document stub whose canvases track the current transform, so a
 * drawImage is recorded with its true on-sheet rect (the fit made
 * observable), and whose 2d context serves pixel reads for the
 * resolver's capture-time extraction. */
function stubDocument() {
  const rig = {
    canvases: [] as Array<{ width: number; height: number }>,
    images: [] as DrawnImage[],
    points: [] as Array<{ x: number; y: number }>,
  };
  const makeCanvas = () => {
    let mat: Mat = [...IDENT];
    const stack: Mat[] = [];
    let lastImage: Px | undefined;
    const base: Record<string, unknown> = {
      globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
      measureText: (t: string) => ({ width: t.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      save: () => { stack.push([...mat]); },
      restore: () => { const m = stack.pop(); if (m) mat = m; },
      transform: (a: number, b: number, c: number, d: number, e: number, f: number) => { mat = mul(mat, [a, b, c, d, e, f]); },
      setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { mat = [a, b, c, d, e, f]; },
      translate: (x: number, y: number) => { mat = mul(mat, [1, 0, 0, 1, x, y]); },
      rotate: (r: number) => { const c = Math.cos(r), s = Math.sin(r); mat = mul(mat, [c, s, -s, c, 0, 0]); },
      scale: (x: number, y: number) => { mat = mul(mat, [x, 0, 0, y, 0, 0]); },
      drawImage: (img: unknown, dx: number, dy: number, dw?: number, dh?: number) => {
        const image = img as { width?: number; height?: number; w?: number; h?: number; px?: Uint8ClampedArray };
        if (image.px) lastImage = image as Px;
        const iw = image.width ?? image.w ?? 0;
        const ih = image.height ?? image.h ?? 0;
        const w = dw ?? iw;
        const h = dh ?? ih;
        const pts = [apply(mat, dx, dy), apply(mat, dx + w, dy), apply(mat, dx + w, dy + h), apply(mat, dx, dy + h)];
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        rig.images.push({ width: iw, height: ih, rect: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } });
      },
      moveTo: (x: number, y: number) => { rig.points.push({ x, y }); },
      lineTo: (x: number, y: number) => { rig.points.push({ x, y }); },
      getImageData: (x: number, y: number, w: number, h: number) => ({
        data: lastImage && lastImage.px.length === w * h * 4 ? lastImage.px : new Uint8ClampedArray(w * h * 4),
        width: w, height: h,
      }),
    };
    const ctx = new Proxy(base, {
      get: (t, p) => (typeof p === 'symbol' ? undefined : (Reflect.get(t, p) ?? (() => {}))),
    });
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,AAAA' };
    rig.canvases.push(canvas);
    return canvas;
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
      return makeCanvas();
    },
  });
  return rig;
}

afterEach(() => { vi.unstubAllGlobals(); });

const near = (actual: number, expected: number, tol = 2) => Math.abs(actual - expected) <= tol;
const hasPoint = (points: Array<{ x: number; y: number }>, x: number, y: number) => points.some((p) => near(p.x, x) && near(p.y, y));

describe('R1: the Model-tab raster plot path gets the D4/D5 treatment', () => {
  it('extents: an extent-less underlay is fitted by its LOADED page size, not the 1x1 placeholder', async () => {
    const rig = stubDocument();
    const logs: string[] = [];
    const { engine, stats } = counting(capEngine(LETTER));
    const e = placement();
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(stateWith(e)), {
      engine, tileCanvasFactory: pixelTileFactory(),
    });
    expect(result).not.toBeNull();
    expect(result?.sheet).toEqual({ width: 17, height: 11 });
    expect(result?.landscape).toBe(true);
    // The sheet canvas is the tabloid sheet at the 150-dpi ceiling.
    const sheet = rig.canvases.find((c) => c.width === 2550);
    expect(sheet?.height).toBe(1650);
    // The letter raster (1275x1650 px at 150 dpi) is drawn ON the sheet:
    // fit of the 612x792 page into the 16x10 in avail area, centred —
    // 1159.09 x 1500 px at (695.45, 75). With the 1x1 placeholder the
    // same draw lands at ~918000 px wide, off the sheet entirely.
    const drawn = rig.images.filter((i) => i.width === 1275 && i.height === 1650);
    expect(drawn).toHaveLength(1);
    expect(near(drawn[0]!.rect.x, 695.45)).toBe(true);
    expect(near(drawn[0]!.rect.y, 75)).toBe(true);
    expect(near(drawn[0]!.rect.w, 1159.09)).toBe(true);
    expect(near(drawn[0]!.rect.h, 1500)).toBe(true);
    // One resolver served sizes AND the draw (sheet dpi = ceiling):
    // a single load, disposed exactly once.
    expect(stats.opens).toBe(1);
    expect(stats.closes).toBe(1);
    // A normal page plots with zero issues.
    expect(logs.filter((l) => l.startsWith('Plot style limitations:'))).toEqual([]);
  });

  it('silence: a page that loads but cannot be prepared at draw time is NAMED in the plot log', async () => {
    stubDocument();
    const logs: string[] = [];
    const e = placement({ definitionHandle: '77', contrast: 30 }); // non-identity: the variant path
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(stateWith(e, DEF_HUGE)), {
      engine: engineFor(HUGE), tileCanvasFactory: holderTileFactory, variantCanvasFactory: throwingVariantFactory,
    });
    expect(result).not.toBeNull(); // the frame fallback still plots
    expect(result?.sheet).toEqual({ width: 17, height: 11 });
    const named = logs.filter((l) => l.startsWith('Plot style limitations:') && l.includes('huge.pdf'));
    expect(named).toHaveLength(1);
  });

  it('stored extent: a def whose load fails still bounds by its stored extent, and the failure is logged', async () => {
    const rig = stubDocument();
    const logs: string[] = [];
    const e = placement();
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(stateWith(e, DEF_EXTENT)), {
      engine: capEngine(LETTER, { refuseAll: true }),
    });
    expect(result).not.toBeNull();
    // The frame is the stored 200x100 extent fitted to the sheet
    // (scale 0.08 -> 2400x1200 px at (75, 225)), not the 1x1 unit frame.
    expect(hasPoint(rig.points, 75, 1425)).toBe(true);
    expect(hasPoint(rig.points, 2475, 225)).toBe(true);
    const named = logs.filter((l) => l.startsWith('Plot style limitations:') && l.includes('sheet.pdf'));
    expect(named).toHaveLength(1);
  });

  it('GUARD: non-underlay bounds are unchanged — a plain line fits exactly as before', async () => {
    const rig = stubDocument();
    const logs: string[] = [];
    const line: Entity = { id: 'l1', layer: 'U', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 612, y: 792 } } as Entity;
    const state = new Drawing({ entities: [line], blocks: {}, layers: [layer('U')] }).snapshot;
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(state), { engine: capEngine(LETTER) });
    expect(result).not.toBeNull();
    expect(hasPoint(rig.points, 695.45, 1575)).toBe(true);
    expect(hasPoint(rig.points, 1854.55, 75)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('GUARD: a paper-space layout still bounds by its sheet (the sheetBounds union is intact)', async () => {
    const rig = stubDocument();
    const logs: string[] = [];
    const line: Entity = { id: 'pl1', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 5 } } as Entity;
    const layout = { ...defaultLayout('Sheet'), entities: [line] };
    const state = new Drawing({
      entities: [], blocks: {}, layers: [layer('0')],
      layouts: [layout], space: { layout: 'Sheet' },
    }).snapshot;
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(state), { engine: capEngine(LETTER) });
    expect(result).not.toBeNull();
    // Bounds include the 17x11 sheet: the line fits at sheet scale
    // (136.36 px/unit), not at its own 10x5 extents (240 px/unit).
    expect(hasPoint(rig.points, 115.91, 1575)).toBe(true);
    expect(hasPoint(rig.points, 1479.55, 893.18)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('dispose: the nothing-visible early return still disposes the resolver created first', async () => {
    stubDocument();
    const logs: string[] = [];
    const { engine, stats } = counting(capEngine(LETTER));
    const e = placement();
    const result = await renderPlotImage(edFor(logs), OPTS, capturedFor(stateWith(e, DEF, false)), {
      engine, tileCanvasFactory: pixelTileFactory(),
    });
    expect(result).toBeNull();
    // The resolver was created BEFORE the bounds loop (it loaded the
    // def from the unfiltered entity list) — and disposed on the way
    // out, exactly once: no leaked engine document.
    expect(stats.opens).toBe(1);
    expect(stats.closes).toBe(1);
    expect(logs).toEqual([]);
  });
});
