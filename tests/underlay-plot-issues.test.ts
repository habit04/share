/** D5 pins — an over-size page is still dropped silently (real-app
 * gate on #57, lead finding D5; breaks D1's 'never silently').
 *
 * loadForPlot SUCCEEDS for a 14400x14400 pt page (the tiled load
 * composites fine), so D1's issue never fires; the failures happen
 * later, when the consumers materialise the raster:
 *   1. imageData's canvas extraction throws on the oversized canvas
 *      and its catch returns null with no issue;
 *   2. source()'s styled-variant derivation throws (the variant
 *      canvas factory refuses the oversize canvas) and the throw
 *      escapes the resolver entirely.
 * Either way the plot ships with no image and no message. The pins
 * bind: NO image, but a NAMED issue on the resolver issues channel
 * (the channel plotLayoutsOrVector merges into plotIssues).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { captureUnderlayResolver } from '../src/app/plot-vector';
import type { UnderlayDocument, UnderlayRasterEngine } from '../src/io/underlay-engine';

const HUGE = { width: 14400, height: 14400 };
const LETTER = { width: 612, height: 792 };
/** The harness canvas ceiling both failure paths trip on. */
const AREA_CAP = 40_000_000;

const DEF: UnderlayDefinition = { id: 'underlaydef:77', handle: '77', kind: 'pdf', sourcePath: 'huge.pdf', retainedGroups: [] };

const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '77',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

function stateWith(e: UnderlayEntity): DrawingState {
  return new Drawing({
    entities: [e],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: DEF },
  }).snapshot;
}

/** An engine whose page loads fine at any size (claimed dims only —
 * the composite lives in the stub tile factory, which never
 * allocates), exactly the lead's repro shape: the load succeeds. */
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
        // The oversize page loads through the TILED path (its untiled
        // raster exceeds the per-page cap); the tiles claim their dims
        // and composite into the inert holder factory — the load
        // genuinely succeeds, which is the lead's repro shape.
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

/** Tile factory whose canvases are inert holders (no allocation). */
const holderTileFactory = {
  create: (width: number, height: number) => ({
    canvas: { width, height } as unknown as HTMLCanvasElement,
    context: { drawImage: () => {} },
    width,
    height,
  }),
};

/** A DOM document stub whose canvas refuses oversize reads, the way
 * a real canvas fails on a 14400x14400 raster. */
function stubCappedDocument(): void {
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => {},
        drawImage: () => {},
        getImageData: (x: number, y: number, w: number, h: number) => {
          if (w * h > AREA_CAP) throw new Error('canvas allocation failed');
          return { data: new Uint8ClampedArray(w * h * 4).fill(120) };
        },
      }),
    };
    return canvas as unknown as HTMLCanvasElement;
  };
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : {}) });
}

afterEach(() => vi.unstubAllGlobals());

describe('D5: an oversized page drops loudly, never silently', () => {
  it('imageData: extraction failure yields no image AND a named issue naming the def', async () => {
    stubCappedDocument();
    const e = placement();
    const resolver = await captureUnderlayResolver(stateWith(e), [e], async () => new Uint8Array([1]), 72, {
      engine: engineFor(HUGE),
      tileCanvasFactory: holderTileFactory,
    });
    expect(resolver.pageSizeOf(DEF.id)).toEqual(HUGE); // the load SUCCEEDED — no D1 issue
    expect(resolver.imageData(e)).toBeNull();
    const issues = [...resolver.issues];
    expect(issues.some((i) => i.includes('huge.pdf'))).toBe(true);
    resolver.dispose();
  });

  it('source: a variant-derivation failure serves the frame AND records a named issue', async () => {
    stubCappedDocument();
    const e = placement({ contrast: 30 }); // non-identity style → the variant path
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
    const resolver = await captureUnderlayResolver(stateWith(e), [e], async () => new Uint8Array([1]), 72, {
      engine: engineFor(HUGE),
      tileCanvasFactory: holderTileFactory,
      variantCanvasFactory: throwingVariantFactory,
    });
    let content: ReturnType<typeof resolver.source> | undefined;
    expect(() => { content = resolver.source(e); }).not.toThrow();
    expect(content?.image).toBeUndefined(); // frame posture: no raster served
    expect(content?.definition.id).toBe(DEF.id);
    const issues = [...resolver.issues];
    expect(issues.some((i) => i.includes('huge.pdf'))).toBe(true);
    resolver.dispose();
  });

  it('GUARD: a normal page extracts and serves with no issues at all', async () => {
    stubCappedDocument();
    const e = placement();
    const resolver = await captureUnderlayResolver(stateWith(e), [e], async () => new Uint8Array([1]), 72, {
      engine: engineFor(LETTER),
      tileCanvasFactory: holderTileFactory,
    });
    expect(resolver.imageData(e)).not.toBeNull();
    expect(resolver.source(e)?.image).toBeDefined();
    expect([...resolver.issues]).toEqual([]);
    resolver.dispose();
  });
});
