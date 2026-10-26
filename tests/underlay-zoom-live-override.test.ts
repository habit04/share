/** B pins — ZOOM Extents unions the live page size ONTO the stored
 * extent, so a live size can never override a larger stored one
 * (#57 review P2, src/app/editor/view.ts:78).
 *
 * doc.extents() (the D4 session seam) frames underlays by the
 * definition's STORED extent. zoomExtents then unions the live
 * display service's settled page bounds onto that box — a union can
 * only grow the box, so with stored 3000x3000 and loaded 612x792 the
 * zoom still receives 3000x3000. The pin binds the replacement
 * shape: visible-entity bounds computed with the live size
 * OVERRIDING the corresponding stored size (Document.extents gains
 * the loaded-page supplier the underlaySizeResolver already
 * implements precedence for), other geometry preserved, and the
 * no-live behaviour bit-identical to today's doc.extents().
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { LineEntity, UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { zoomExtents } from '../src/app/editor/view';
import { renderSettings } from '../src/render/draw';
import type { Editor } from '../src/app/editor/editor';

const PAGE = { width: 612, height: 792 };

const DEF_BIG: UnderlayDefinition = {
  id: 'underlaydef:51', handle: '51', kind: 'pdf', sourcePath: 'big.pdf', retainedGroups: [],
  extent: { width: 3000, height: 3000 },
};
const DEF_SMALL: UnderlayDefinition = {
  id: 'underlaydef:52', handle: '52', kind: 'pdf', sourcePath: 'small.pdf', retainedGroups: [],
  extent: { width: 200, height: 100 },
};

const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '51',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});
const line = (over: Partial<LineEntity> = {}): LineEntity => ({
  id: 'l1', layer: 'U', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 5000, y: 10 }, ...over,
});
const LAYERS = [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }];

/** Run zoomExtents against a stub editor and capture the bounds it zooms to. */
function zoomBounds(doc: Drawing, livePageFor: (e: UnderlayEntity) => { width: number; height: number } | undefined): unknown {
  let captured: unknown = null;
  const ed = {
    viewport: { zoomToBounds: (b: unknown) => { captured = b; } },
    doc,
    render: () => {},
    notify: () => {},
  } as unknown as Editor;
  const prev = renderSettings.underlaySource;
  renderSettings.underlaySource = ((e: UnderlayEntity) => {
    const page = livePageFor(e);
    return page ? { definition: e.definitionHandle === '51' ? DEF_BIG : DEF_SMALL, page } : undefined;
  }) as typeof renderSettings.underlaySource;
  try {
    zoomExtents(ed);
  } finally {
    renderSettings.underlaySource = prev;
  }
  return captured;
}

describe('B: a settled live page size REPLACES the stored-extent bounds in ZOOM Extents', () => {
  it('stored 3000x3000 + loaded 612x792 zooms to the 612x792 frame, not the stored box', () => {
    const doc = new Drawing({ entities: [placement()], blocks: {}, layers: LAYERS, underlays: { a: DEF_BIG } });
    expect(doc.extents()).toEqual({ min: { x: 0, y: 0 }, max: { x: 3000, y: 3000 } }); // session tier (premise)
    expect(zoomBounds(doc, () => PAGE)).toEqual({ min: { x: 0, y: 0 }, max: { x: 612, y: 792 } });
  });

  it('Document.extents accepts the loaded-page supplier directly (loaded wins per-def)', () => {
    const doc = new Drawing({ entities: [placement()], blocks: {}, layers: LAYERS, underlays: { a: DEF_BIG } });
    const extents = (doc as unknown as { extents: (s?: (defId: string) => { width: number; height: number } | undefined) => unknown }).extents;
    expect(extents.call(doc, (defId: string) => (defId === DEF_BIG.id ? PAGE : undefined)))
      .toEqual({ min: { x: 0, y: 0 }, max: { x: 612, y: 792 } });
    expect(extents.call(doc)).toEqual({ min: { x: 0, y: 0 }, max: { x: 3000, y: 3000 } });
  });

  it('MIXED: other geometry is preserved; a def with no live page keeps its stored frame', () => {
    const doc = new Drawing({
      entities: [
        line(),
        placement(),
        placement({ id: 'u2', definitionHandle: '52', position: { x: 4000, y: 2000 } }),
      ],
      blocks: {},
      layers: LAYERS,
      underlays: { a: DEF_BIG, b: DEF_SMALL },
    });
    // Line: {0,0}-{5000,10}; live-framed underlay: {0,0}-{612,792};
    // stored-only underlay: {4000,2000}-{4200,2100}. Union below; the
    // stale 3000x3000 box must contribute NOTHING (else max.y = 3000).
    expect(zoomBounds(doc, (e) => (e.definitionHandle === '51' ? PAGE : undefined)))
      .toEqual({ min: { x: 0, y: 0 }, max: { x: 5000, y: 2100 } });
  });

  it('GUARD: with no live page settled, zoom extents are exactly doc.extents() (stored behaviour)', () => {
    const doc = new Drawing({ entities: [placement()], blocks: {}, layers: LAYERS, underlays: { a: DEF_BIG } });
    expect(zoomBounds(doc, () => undefined)).toEqual(doc.extents());
    expect(zoomBounds(doc, () => undefined)).toEqual({ min: { x: 0, y: 0 }, max: { x: 3000, y: 3000 } });
  });
});
