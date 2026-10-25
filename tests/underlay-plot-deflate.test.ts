/** D6 pins — the vector plot embeds the underlay raster UNCOMPRESSED
 * (real-app gate on #57, lead finding D6).
 *
 * captureUnderlayResolver.imageData returns {kind:'rgb'} with no
 * deflation, while the IMAGE-entity path (collectImages) deflates
 * through io/pdf's deflate and marks the payload deflated — so a
 * letter page embeds at ~25 MB and A0 at ~418 MB. The pins bind:
 * the underlay payload imageData serves is deflated with the same
 * helper and payload shape, materially smaller than raw RGB for a
 * real raster, and inflates back to exactly the same pixels; the
 * written PDF's image stream carries /FlateDecode accordingly.
 *
 * imageData is synchronous (the sync vector walker consumes it), so
 * the deflation is necessarily prepared during the resolver's async
 * capture — the pins only observe the served payload and the file.
 */
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockLookup, UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { captureUnderlayResolver } from '../src/app/plot-vector';
import { drawingContext, plotPages, vectorPdf } from '../src/io/pdf-vector';
import { parsePdfBasics } from './helpers/pdf';
import type { UnderlayDocument, UnderlayRasterEngine } from '../src/io/underlay-engine';

const PAGE = { width: 100, height: 80 };
const RAW_RGB = PAGE.width * PAGE.height * 3;
const DEF: UnderlayDefinition = { id: 'underlaydef:91', handle: '91', kind: 'pdf', sourcePath: 'photo.pdf', retainedGroups: [] };

/** Deterministic, compressible-but-structured pixel pattern. */
const patternAt = (x: number, y: number): number => (x * 3 + y * 5) % 251;
function patternRgba(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(PAGE.width * PAGE.height * 4);
  for (let y = 0; y < PAGE.height; y += 1) {
    for (let x = 0; x < PAGE.width; x += 1) {
      const i = (y * PAGE.width + x) * 4;
      const v = patternAt(x, y);
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  return px;
}
function expectedRgb(): Uint8Array {
  const px = patternRgba();
  const rgb = new Uint8Array(RAW_RGB);
  for (let p = 0; p < PAGE.width * PAGE.height; p += 1) {
    rgb[p * 3] = px[p * 4]!;
    rgb[p * 3 + 1] = px[p * 4 + 1]!;
    rgb[p * 3 + 2] = px[p * 4 + 2]!;
  }
  return rgb;
}

const placement = (): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '91',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [],
});

function stateWith(e: UnderlayEntity): DrawingState {
  return new Drawing({
    entities: [e],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: DEF },
  }).snapshot;
}

const engine: UnderlayRasterEngine = {
  kind: 'pdf',
  open: async () => ({
    ok: true,
    value: {
      pageCount: 1,
      pageSize: async () => ({ ok: true, value: PAGE }),
      renderPage: async () => ({
        ok: true,
        value: {
          image: { px: patternRgba(), width: PAGE.width, height: PAGE.height } as unknown as CanvasImageSource,
          width: PAGE.width, height: PAGE.height, pageSize: PAGE,
        },
      }),
      renderRegion: async () => ({ ok: false, error: { kind: 'corrupt', detail: 'unused' } }),
      close: () => {},
    } as unknown as UnderlayDocument,
  }),
};

/** Pixel-backed DOM canvas stub (the underlay-plot-tiling idiom). */
function stubDocument(): void {
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      px: new Uint8ClampedArray(0),
      getContext: () => ctx,
    };
    const ctx = {
      fillStyle: '',
      fillRect: () => {},
      drawImage: (src: { px?: Uint8ClampedArray }) => { if (src?.px) canvas.px = src.px; },
      getImageData: () => ({ data: canvas.px.length ? canvas.px : patternRgba() }),
    };
    return canvas as unknown as HTMLCanvasElement;
  };
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : {}) });
}

afterEach(() => vi.unstubAllGlobals());

async function capture(e: UnderlayEntity) {
  stubDocument();
  return captureUnderlayResolver(stateWith(e), [e], async () => new Uint8Array([7]), 72, { engine });
}

describe('D6: the embedded underlay raster is deflated like the IMAGE path', () => {
  it('imageData serves a deflated payload that inflates back to the same pixels', async () => {
    const e = placement();
    const resolver = await capture(e);
    const img = resolver.imageData(e);
    expect(img).not.toBeNull();
    expect(img!.data.width).toBe(PAGE.width);
    expect(img!.data.height).toBe(PAGE.height);
    expect(img!.data.kind).toBe('rgb');
    expect(img!.data.deflated).toBe(true);
    expect(img!.data.data.byteLength).toBeLessThan(RAW_RGB / 2);
    expect(new Uint8Array(inflateSync(img!.data.data))).toEqual(expectedRgb());
    resolver.dispose();
  });

  it('the written vector PDF carries /FlateDecode on the underlay image stream, materially under raw size', async () => {
    const e = placement();
    const state = stateWith(e);
    const resolver = await capture(e);
    const lookup: BlockLookup = () => undefined;
    const pages = plotPages(state, lookup, 'model', { paper: 'letter', scale: 'fit' });
    const ctx = drawingContext(state, lookup, () => null, (ent) => resolver.imageData(ent));
    const bytes = vectorPdf(pages, ctx, { style: undefined }, 'd6');
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/FlateDecode');
    expect(bytes.byteLength).toBeLessThan(RAW_RGB);
    const basics = parsePdfBasics(bytes);
    expect(basics.pages).toHaveLength(1);
    resolver.dispose();
  });
});
