/** #57 P2 (2) pins — per-placement raster style on the plot path (plot-vector.ts:170).
 *
 * The finding, verbatim in substance: loadForPlot supplies the raw page
 * image, and both the resolver's source and imageData forward it without
 * adjustUnderlayPixels; the display service's contentFor style path is
 * never used here. A contrast-0 placement therefore plots the raw red
 * pixel [255,0,0], while the declared equation on the white paper
 * background produces [255,255,255]; monochrome is skipped by the same
 * route. Plot variants must be derived per placement style/background —
 * including separate styles for two placements of one definition —
 * through the shared canonical post-process.
 *
 * The resolver is driven through its seams (fake engine + fake variant
 * canvas factory) with a 2x1 pure-red page raster.
 */
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { type UnderlayEntity } from '../src/core/entities';
import { UNDERLAY_FLAG_MONOCHROME, type UnderlayDefinition } from '../src/core/underlay';
import { underlayRefusal, type UnderlayDocument, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { captureUnderlayResolver } from '../src/app/plot-vector';
import type { UnderlayVariantCanvasFactory } from '../src/app/underlay-render';
import { adjustUnderlayPixels } from '../src/app/underlay-adjust';

/** The pixels a served imageData payload carries (gate finding D6:
 * the payload is deflated at capture; these pins assert the styled
 * PIXELS, so they decode the transport encoding first). */
const pixelsOf = (img: { data: { data: Uint8Array; deflated?: boolean } } | null): Uint8Array =>
  (img ? (img.data.deflated ? new Uint8Array(inflateSync(img.data.data)) : img.data.data) : new Uint8Array(0));

interface FakeBitmap { px: Uint8ClampedArray }
const REDPX = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]);
const RED: FakeBitmap = { px: REDPX };

const engine: UnderlayRasterEngine = {
  kind: 'pdf',
  open: async () => ({
    ok: true,
    value: {
      pageCount: 1,
      pageSize: async () => ({ ok: true, value: { width: 2, height: 1 } }),
      renderPage: async () => ({ ok: true, value: { image: RED as unknown as CanvasImageSource, width: 2, height: 1, pageSize: { width: 2, height: 1 } } }),
      renderRegion: async () => underlayRefusal('corrupt', 'not used by this pin'),
      close: () => {},
    } as UnderlayDocument,
  }),
};

/** Pixel-store canvas factory: the slot's canvas IS the pixel holder, so a
 * derived variant's pixels are directly assertable. */
const variantFactory: UnderlayVariantCanvasFactory = {
  create(width: number, height: number) {
    const holder: FakeBitmap = { px: new Uint8ClampedArray(width * height * 4) };
    return {
      canvas: holder,
      width,
      height,
      context: {
        drawImage: (image: unknown) => { holder.px.set((image as FakeBitmap).px); },
        getImageData: () => ({ data: holder.px }),
        putImageData: (image: { data: Uint8ClampedArray }) => { holder.px = new Uint8ClampedArray(image.data); },
      },
    };
  },
};

/** imageData's extraction canvas (the document path), pixel-backed. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    createElement: (name: string) => {
      if (name !== 'canvas') throw new Error(`unexpected element ${name}`);
      const holder: FakeBitmap = { px: new Uint8ClampedArray(0) };
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          fillRect: () => {},
          drawImage: (img: unknown) => { holder.px = (img as FakeBitmap).px; },
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

async function setup() {
  stubDocument();
  const contrast0 = placement({ id: 'u-c0', contrast: 0 });
  const identity = placement({ id: 'u-id' });
  const mono = placement({ id: 'u-mono', flags: 2 | UNDERLAY_FLAG_MONOCHROME });
  const state = { underlays: { d: DEF } } as unknown as DrawingState;
  const resolver = await captureUnderlayResolver(state, [contrast0, identity, mono], async () => new Uint8Array([1, 2, 3]), 72, {
    engine, variantCanvasFactory: variantFactory,
  });
  return { resolver, contrast0, identity, mono };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('captured plot resolver — per-placement raster style (#57 P2 (2))', () => {
  it('source: a contrast-0 placement serves the declared-equation white, not the raw red', async () => {
    const { resolver, contrast0 } = await setup();
    const content = resolver.source(contrast0);
    resolver.dispose();
    expect(content?.image).toBeDefined();
    expect((content!.image!.bitmap as unknown as FakeBitmap).px).toEqual(new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]));
  });

  it('source: an identity placement serves the raw raster object untouched', async () => {
    const { resolver, identity } = await setup();
    const content = resolver.source(identity);
    resolver.dispose();
    expect(content?.image?.bitmap).toBe(RED);
  });

  it('source: a monochrome placement serves the mono-reduced variant', async () => {
    const { resolver, mono } = await setup();
    const content = resolver.source(mono);
    resolver.dispose();
    const expected = adjustUnderlayPixels(new Uint8ClampedArray(REDPX), 2, 1, { mono: true, background: [1, 1, 1] });
    expect((content!.image!.bitmap as unknown as FakeBitmap).px).toEqual(expected);
    expect(expected[0]).toBe(76); // Rec. 601 luma of pure red, pinned literally
  });

  it('imageData: two placements of one definition embed separate style variants', async () => {
    const { resolver, contrast0, identity } = await setup();
    const styled = resolver.imageData(contrast0);
    const raw = resolver.imageData(identity);
    resolver.dispose();
    expect(pixelsOf(styled)).toEqual(new Uint8Array([255, 255, 255, 255, 255, 255]));
    expect(pixelsOf(raw)).toEqual(new Uint8Array([255, 0, 0, 255, 0, 0]));
  });

  it('imageData: a monochrome placement embeds the mono-reduced raster', async () => {
    const { resolver, mono } = await setup();
    const hit = resolver.imageData(mono);
    resolver.dispose();
    expect(pixelsOf(hit)).toEqual(new Uint8Array([76, 76, 76, 76, 76, 76]));
  });
});
