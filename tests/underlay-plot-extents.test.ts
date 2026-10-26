/** D4 pins — plot extents (and ZOOM extents) ignore the loaded page size
 * (real-app gate on #57, lead finding D4).
 *
 * The mechanism: entityBounds' underlay case goes through
 * compoundParts/underlayParts, whose frame is the 1x1 placeholder (the
 * definition-less unit frame that hit-testing / grips / the frame+cross
 * fallback deliberately use). Every extents consumer therefore sees a
 * 1x1 underlay: the plot 'fit' layout scales the sheet to a 1x1 drawing
 * and the real page lands off the sheet (repro: tabloid/landscape/fit
 * puts the image at 'q 42061.091 0 0 54432 ... cm' on a 1224x792
 * MediaBox, raster 99.84% white), and ZOOM extents has the same cause.
 *
 * The pins bind the chosen seam: a page-size channel carried on the
 * BlockLookup (the textGeometry side-channel precedent), page-size-first
 * (a loaded page size wins over the definition's stored extent; a
 * stored extent is the session-known size). Consumers that never
 * receive the channel keep today's behaviour exactly.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { entityBounds, type BlockLookup, type UnderlayEntity } from '../src/core/entities';
import { plotExtents, modelPageSpec } from '../src/io/pdf-vector';
import type { UnderlayDefinition } from '../src/core/underlay';
import type { PlotOptions } from '../src/app/plot';
import { captureUnderlayResolver } from '../src/app/plot-vector';
import { underlayRefusal, type UnderlayDocument, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { zoomExtents } from '../src/app/editor/view';
import { renderSettings } from '../src/render/draw';
import type { Editor } from '../src/app/editor/editor';

const PAGE = { width: 612, height: 792 };
const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };

const DEF: UnderlayDefinition = { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf', retainedGroups: [] };
const DEF_EXTENT: UnderlayDefinition = { ...DEF, id: 'underlaydef:42', handle: '42', extent: { width: 200, height: 100 } };

const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

function stateWith(e: UnderlayEntity, def: UnderlayDefinition = DEF): DrawingState {
  const doc = new Drawing({
    entities: [e],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: def },
  });
  return doc.snapshot;
}

/** A lookup carrying the page-size channel (the seam under test). */
function sizedLookup(size: { width: number; height: number } | undefined): BlockLookup {
  const fn = ((_: string) => undefined) as unknown as BlockLookup & { underlaySizeOf?: unknown };
  fn.underlaySizeOf = () => size;
  return fn as BlockLookup;
}

describe('D4: bounds honour the page size when a channel supplies it', () => {
  it('entityBounds frames an extent-less underlay by the loaded page size, not the 1x1 placeholder', () => {
    const b = entityBounds(placement(), sizedLookup(PAGE));
    expect(b).toEqual({ min: { x: 0, y: 0 }, max: { x: 612, y: 792 } });
  });

  it('the page frame composes with the placement transform (position + scale)', () => {
    const b = entityBounds(placement({ position: { x: 10, y: 20 }, scaleX: 2, scaleY: 2 }), sizedLookup(PAGE));
    expect(b).toEqual({ min: { x: 10, y: 20 }, max: { x: 10 + 1224, y: 20 + 1584 } });
  });

  it('GUARD: with no channel the bounds are exactly the legacy unit frame', () => {
    const plain: BlockLookup = () => undefined;
    expect(entityBounds(placement(), plain)).toEqual({ min: { x: 0, y: 0 }, max: { x: 1, y: 1 } });
  });

  it('GUARD: non-underlay bounds are unchanged by the channel', () => {
    const line = { id: 'l1', layer: 'U', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 5, y: 7 } } as never;
    expect(entityBounds(line, sizedLookup(PAGE))).toEqual({ min: { x: 0, y: 0 }, max: { x: 5, y: 7 } });
  });
});

describe('D4: plot extents and the fit layout', () => {
  it('plotExtents over an extent-less underlay equals the page-derived frame when the channel is supplied', () => {
    const state = stateWith(placement());
    expect(plotExtents(state, sizedLookup(PAGE))).toEqual({ min: { x: 0, y: 0 }, max: { x: 612, y: 792 } });
  });

  it("the 'fit' page maps the PAGE frame inside the sheet (the lead's repro shape)", () => {
    const state = stateWith(placement());
    const spec = modelPageSpec(state, sizedLookup(PAGE), OPTS);
    expect(spec).not.toBeNull();
    const grp = spec!.page.groups[0]!;
    // Group transform: screen = (k*x + e, H - (k*y + f)) in the writer's
    // convention; assert through the page extents the spec was built on:
    // the fit scale must be the one that fits 612x792 (not 1x1) and the
    // mapped frame corners must land on the sheet.
    const W = spec!.page.width;
    const H = spec!.page.height;
    const corners: Array<[number, number]> = [[0, 0], [612, 0], [612, 792], [0, 792]];
    for (const [x, y] of corners) {
      const sx = grp.k * x + grp.e;
      const sy = H - (grp.k * y + grp.f);
      expect(sx).toBeGreaterThanOrEqual(-0.01);
      expect(sx).toBeLessThanOrEqual(W + 0.01);
      expect(sy).toBeGreaterThanOrEqual(-0.01);
      expect(sy).toBeLessThanOrEqual(H + 0.01);
    }
    // A 1x1 fit would scale by ~the whole sheet; the page fit is < 2x.
    expect(grp.k).toBeLessThan(2);
  });
});

describe('D4: ZOOM extents (the session seam)', () => {
  it("the document extents frame an underlay by its definition's stored extent", () => {
    const e = placement({ definitionHandle: '42' });
    const doc = new Drawing({
      entities: [e],
      blocks: {},
      layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
      underlays: { d: DEF_EXTENT },
    });
    expect(doc.extents()).toEqual({ min: { x: 0, y: 0 }, max: { x: 200, y: 100 } });
  });

  it('editor zoomExtents unions the LIVE loaded page size for an extent-less def', () => {
    const e = placement();
    const doc = new Drawing({
      entities: [e],
      blocks: {},
      layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
      underlays: { d: DEF },
    });
    let captured: unknown = null;
    const ed = {
      viewport: { zoomToBounds: (b: unknown) => { captured = b; } },
      doc,
      render: () => {},
      notify: () => {},
    } as unknown as Editor;
    const prev = renderSettings.underlaySource;
    renderSettings.underlaySource = () => ({ definition: DEF, page: PAGE });
    try {
      zoomExtents(ed);
    } finally {
      renderSettings.underlaySource = prev;
    }
    expect(captured).toEqual({ min: { x: 0, y: 0 }, max: { x: 612, y: 792 } });
  });
});

describe('D4: the captured resolver exposes its loaded page sizes', () => {
  it('pageSizeOf reports the ensured page for a definition (page-size-first source for the channel)', async () => {
    const engine: UnderlayRasterEngine = {
      kind: 'pdf',
      open: async () => ({
        ok: true,
        value: {
          pageCount: 1,
          pageSize: async () => ({ ok: true, value: PAGE }),
          renderPage: async (_p: number, scale: number) => {
            const w = Math.ceil(PAGE.width * scale);
            const h = Math.ceil(PAGE.height * scale);
            return { ok: true, value: { image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h, pageSize: PAGE } };
          },
          renderRegion: async () => underlayRefusal('corrupt', 'unused in this pin'),
          close: () => {},
        } as unknown as UnderlayDocument,
      }),
    };
    const e = placement();
    const resolver = await captureUnderlayResolver(stateWith(e), [e], async () => new Uint8Array([1, 2, 3]), 72, { engine });
    const pageSizeOf = (resolver as unknown as { pageSizeOf?: (defId: string) => unknown }).pageSizeOf;
    expect(typeof pageSizeOf).toBe('function');
    expect(pageSizeOf!.call(resolver, DEF.id)).toEqual(PAGE);
    expect(pageSizeOf!.call(resolver, 'underlaydef:missing')).toBeUndefined();
    resolver.dispose();
  });
});
