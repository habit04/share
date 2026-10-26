/** A pins — pristine layout viewports are initialised from the 1x1
 * placeholder, before the plot resolver loads the page (#57 review
 * P2, src/app/plot-vector.ts:383).
 *
 * plottableState initialises each pristine layout against the
 * extents of the SESSION-tier lookup (stored extents only). For an
 * underlay with no stored extent that is the 1x1 placeholder, so
 * the fitted viewport's center/scale are computed for a 1x1 drawing
 * — and the page-tier channel built later cannot change the
 * viewport state already stored. A first PLOT of all layouts with
 * a 100x80 pt PDF writes a ~65847x52678 pt image transform on a
 * 1224x792 pt sheet, clipping almost all of the page (the Model
 * control, which fits through the page-tier channel, is correct).
 *
 * The pins drive the FULL PLOT ENTRY (plotLayoutsOrVector), as the
 * finding demands, and assert the written PDF: the pristine
 * layout's image transform must be the page fit (sheet-scale, on
 * the sheet), and an explicitly edited viewport must keep its
 * stored center/scale verbatim. The entry's resolver is driven
 * through the optional CapturedResolverSeams parameter (the R1
 * harness precedent: optional, production callers pass nothing).
 */
import './pdfjs-node-shims';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { Drawing } from '../src/core/document';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { defaultLayout, type Layout, type LayoutViewport } from '../src/core/layouts';
import type { UnderlayDocument, UnderlayRasterEngine } from '../src/io/underlay-engine';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import { renderSettings } from '../src/render/draw';
import type { Editor } from '../src/app/editor/editor';
import type { PlotOptions } from '../src/app/plot';
import { parsePdfBasics, pageContents } from './helpers/pdf';

const PAGE = { width: 100, height: 80 }; // the finding's 100x80 pt PDF
const DEF: UnderlayDefinition = { id: 'underlaydef:61', handle: '61', kind: 'pdf', sourcePath: 'small.pdf', retainedGroups: [] };

const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '61',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

interface Px { px: Uint8ClampedArray; w: number; h: number }
const filled = (w: number, h: number, v = 200): Px => {
  const px = new Uint8ClampedArray(w * h * 4);
  px.fill(v);
  return { px, w, h };
};

/** A fake engine serving the 100x80 page (claimed dims, pixel holders). */
const engine: UnderlayRasterEngine = {
  kind: 'pdf',
  open: async () => ({
    ok: true,
    value: {
      pageCount: 1,
      pageSize: async () => ({ ok: true, value: PAGE }),
      renderPage: async (_p: number, scale: number) => {
        const w = Math.max(1, Math.ceil(PAGE.width * scale));
        const h = Math.max(1, Math.ceil(PAGE.height * scale));
        return { ok: true, value: { image: filled(w, h) as unknown as CanvasImageSource, width: w, height: h, pageSize: PAGE } };
      },
      renderRegion: async () => { throw new Error('untiled suffices at this size'); },
      close: () => {},
    } as unknown as UnderlayDocument,
  }),
};

/** imageData's extraction canvas, pixel-backed (the tiling idiom). */
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
        toDataURL: () => 'data:image/png;base64,',
      };
    },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5, output: 'vector', what: 'layouts' };

/** An explicitly edited viewport: a distinctive stored view that no
 * page-fit would produce (scale 0.01 paper-in per model-unit). */
const EDITED_VP: LayoutViewport = {
  id: 'vpEdited', center: { x: 8.5, y: 5.5 }, width: 10, height: 6,
  view: { center: { x: 50, y: 40 }, scale: 0.01 }, layer: 'VIEWPORTS', on: true,
};

function drawingWithLayouts(): Drawing {
  const edited: Layout = { ...defaultLayout('Edited'), pristine: undefined, viewports: [EDITED_VP] };
  return new Drawing({
    entities: [placement()],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: DEF },
    layouts: [defaultLayout('Layout1'), edited],
  });
}

/** The image placement matrices (a b c d e f before `cm /Im… Do`) per page. */
function imageMatrices(bytes: Uint8Array): Array<Array<[number, number, number, number, number, number]>> {
  const info = parsePdfBasics(bytes);
  expect(info.errors).toEqual([]);
  const contents = pageContents(info, (b) => new Uint8Array(inflateSync(b)));
  return contents.map((content) => {
    const out: Array<[number, number, number, number, number, number]> = [];
    for (const m of content.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm \/Im\d+ Do/g)) {
      out.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])]);
    }
    return out;
  });
}

describe('A: a first PLOT of all layouts initialises pristine viewports from the LOADED page size', () => {
  it('the pristine layout writes a page-fit image transform, and the edited viewport keeps its stored view', async () => {
    stubDocument();
    const doc = drawingWithLayouts();
    let saved: Uint8Array | undefined;
    const ed = {
      doc,
      fileName: () => 'A.dxf',
      log: () => {},
      fileBridge: { savePdf: async (bytes: Uint8Array) => { saved = bytes; return 'A.pdf'; } },
    } as unknown as Editor;
    // The captured plot freezes its underlay byte source from
    // renderSettings (the composition root's install in the app);
    // the fake engine ignores the content.
    const prevBytes = renderSettings.underlayBytes;
    const prevBytesFor = renderSettings.underlayBytesFor;
    renderSettings.underlayBytes = async () => new Uint8Array([1, 2, 3]);
    renderSettings.underlayBytesFor = undefined;
    let handled: boolean;
    try {
      handled = await plotLayoutsOrVector(ed, { action: 'pdf', options: OPTS }, undefined, { engine });
    } finally {
      renderSettings.underlayBytes = prevBytes;
      renderSettings.underlayBytesFor = prevBytesFor;
    }
    expect(handled).toBe(true);
    expect(saved).toBeDefined();

    const pages = imageMatrices(saved!);
    expect(pages).toHaveLength(2);

    // Layout1 (pristine; tabloid landscape sheet 1224x792 pt): the
    // viewport fit must be computed against the real 100x80 page —
    // a ~823x659 pt image on the sheet — not the 1x1 placeholder
    // fit (~65847x52678 pt, the finding's numbers).
    const pristine = pages[0]!;
    expect(pristine).toHaveLength(1);
    const [a, , , d, e, f] = pristine[0]!;
    expect(Math.abs(a)).toBeGreaterThan(700);
    expect(Math.abs(a)).toBeLessThan(950);
    expect(Math.abs(d)).toBeGreaterThan(550);
    expect(Math.abs(d)).toBeLessThan(760);
    // …and the placed image lands ON the 1224x792 sheet.
    expect(e).toBeGreaterThanOrEqual(-0.01);
    expect(f).toBeGreaterThanOrEqual(-0.01);
    expect(e + Math.abs(a)).toBeLessThanOrEqual(1224.01);
    expect(f + Math.abs(d)).toBeLessThanOrEqual(792.01);

    // Edited (non-pristine): its stored view scale 0.01 in/unit at
    // 72 pt/in gives an image width of 0.72 * 100 = 72 pt — the
    // page fit must NOT be recomputed for it.
    const edited = pages[1]!;
    expect(edited).toHaveLength(1);
    expect(Math.abs(edited[0]![0])).toBeCloseTo(72, 0);
    expect(Math.abs(edited[0]![3])).toBeCloseTo(57.6, 0);
  });
});
