/**
 * The PDF underlay display service (P28 wiring): resolves placements to
 * definitions from the DrawingState `underlays` sibling and rasterizes PDF
 * pages through the engine interface (src/io/underlay-engine.ts) — never
 * through an engine directly, so the implementation stays swappable and
 * tests drive this service against a fake engine with zero pdfjs import.
 *
 * Behaviour mirrors the IMAGE bitmap cache (render/images.ts): a placement
 * whose content has not loaded yet displays as frame + label; when the
 * raster lands, `requestRedraw` fires and the display gains the bitmap.
 * Failures (no bytes, a typed engine refusal, a page that does not exist)
 * settle the entry as frame + label permanently until `clear()`.
 *
 * DWF/DGN definitions resolve for the frame + label but are NEVER opened:
 * no decoder is admitted for them — they stay on the bounded-probe posture.
 *
 * The byte source is injected: the desktop bridge exposes no generic
 * file-byte read today (read-image returns data URLs for raster images),
 * so the composition root supplies bytes when it has a channel; until
 * then placements still render their frame + label.
 */
import type { UnderlayDefinition } from '../core/underlay';
import type { UnderlayEntity } from '../core/entities';
import { planUnderlayTiles, type UnderlayCanvasFactory, type UnderlayClipRect, type UnderlayRasterEngine } from '../io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../io/underlay-adapter';
import type { UnderlayDisplayContent } from '../render/underlay-content';

/** Bytes of the referenced file, or null when they cannot be obtained. NO referenced-file I/O happens anywhere else in P28. */
export type UnderlayByteSource = (def: UnderlayDefinition) => Promise<Uint8Array | null>;

export interface UnderlayDisplayService {
  /** The DrawStyle/renderSettings source: synchronous, cache-backed. */
  source(e: UnderlayEntity): UnderlayDisplayContent | undefined;
  /** Drop every cached raster (e.g. the drawing changed). */
  clear(): void;
}

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  page?: { width: number; height: number };
  image?: { bitmap: CanvasImageSource; width: number; height: number };
}

/** The definition's page field as a 1-based page index: numeric names only in this slice; anything else is page 1. */
export function underlayPageIndex(def: UnderlayDefinition): number {
  const n = def.page !== undefined && /^\d+$/.test(def.page.trim()) ? Number.parseInt(def.page.trim(), 10) : 1;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function createUnderlayDisplayService(deps: {
  engine: UnderlayRasterEngine;
  bytesFor: UnderlayByteSource;
  definitions: () => Readonly<Record<string, UnderlayDefinition>> | undefined;
  requestRedraw?: () => void;
  /** Long-edge pixel target for rasters (the engine's per-page cap still rules). */
  targetPixels?: number;
  /**
   * The page region currently visible for a definition (engine clip
   * space: page units, top-left origin), when the composition root can
   * supply one (F-class tile wiring, 2026-10-22). When a region is
   * supplied, the load requests ONLY the tiles covering that region via
   * renderRegion — planned under the C5 per-page cap — and composites
   * them into the page bitmap (the rest stays transparent); when it is
   * not, the load renders the whole page exactly as before.
   */
  visibleRegion?: (def: UnderlayDefinition) => UnderlayClipRect | undefined;
  /** Canvas factory for the tile composite. Default: DOM canvases. */
  tileCanvasFactory?: UnderlayCanvasFactory;
}): UnderlayDisplayService {
  const target = deps.targetPixels ?? 1024;
  const cache = new Map<string, Entry>();

  const startLoad = (def: UnderlayDefinition): Entry => {
    const entry: Entry = { state: 'loading' };
    cache.set(def.id, entry);
    void (async () => {
      try {
        const bytes = await deps.bytesFor(def);
        if (!bytes) {
          entry.state = 'failed';
          return;
        }
        const opened = await deps.engine.open(bytes);
        if (!opened.ok) {
          entry.state = 'failed';
          return;
        }
        const doc = opened.value;
        try {
          const page = underlayPageIndex(def);
          if (page > doc.pageCount) {
            entry.state = 'failed';
            return;
          }
          const sized = await doc.pageSize(page);
          if (!sized.ok) {
            entry.state = 'failed';
            return;
          }
          const size = sized.value;
          const scale = target / Math.max(size.width, size.height);
          // F-class tile path: with a visible-region hint, request ONLY
          // the tiles covering the visible part of the page and
          // composite them; a tile refusal fails the load closed
          // (frame + label), exactly like a whole-page refusal.
          const hint = deps.visibleRegion?.(def);
          const region: UnderlayClipRect | undefined = hint
            ? {
                x: Math.max(0, hint.x),
                y: Math.max(0, hint.y),
                width: Math.min(size.width, hint.x + hint.width) - Math.max(0, hint.x),
                height: Math.min(size.height, hint.y + hint.height) - Math.max(0, hint.y),
              }
            : undefined;
          if (region && region.width > 0 && region.height > 0) {
            const tiles = planUnderlayTiles(region, scale, DEFAULT_UNDERLAY_CAPS.maxScanBytes);
            if (tiles.length === 0) {
              entry.state = 'failed';
              return;
            }
            const factory = deps.tileCanvasFactory ?? domTileCanvasFactory;
            const width = Math.max(1, Math.ceil(size.width * scale));
            const height = Math.max(1, Math.ceil(size.height * scale));
            const composite = factory.create(width, height);
            const ctx = composite.context as { drawImage(image: unknown, dx: number, dy: number): void };
            for (const tile of tiles) {
              const r = await doc.renderRegion(page, tile, scale);
              if (!r.ok) {
                entry.state = 'failed';
                return;
              }
              ctx.drawImage(r.value.image, Math.round(tile.x * scale), Math.round(tile.y * scale));
            }
            entry.page = size;
            entry.image = { bitmap: composite.canvas as CanvasImageSource, width: composite.width, height: composite.height };
            entry.state = 'ready';
            deps.requestRedraw?.();
            return;
          }
          const raster = await doc.renderPage(page, scale);
          if (!raster.ok) {
            entry.state = 'failed';
            return;
          }
          entry.page = size;
          entry.image = { bitmap: raster.value.image as CanvasImageSource, width: raster.value.width, height: raster.value.height };
          entry.state = 'ready';
          deps.requestRedraw?.();
        } finally {
          doc.close();
        }
      } catch {
        entry.state = 'failed'; // the seam promises refusals, but a display cache never throws
      }
    })();
    return entry;
  };

  return {
    source(e: UnderlayEntity): UnderlayDisplayContent | undefined {
      const defs = deps.definitions();
      if (!defs) return undefined;
      const def = Object.values(defs).find((d) => (d.handle ?? '').toUpperCase() === e.definitionHandle);
      if (!def) return undefined; // dangling: frame + cross, no label (C2)
      if (def.kind !== 'pdf') return { definition: def }; // DWF/DGN: no admitted decoder
      const entry = cache.get(def.id) ?? startLoad(def);
      if (entry.state !== 'ready' || !entry.image || !entry.page) return { definition: def };
      // The display joins the true page extent once it is known; the stored
      // definition itself is never mutated by rendering.
      const view = def.extent ? def : { ...def, extent: entry.page };
      return { definition: view, page: entry.page, image: entry.image };
    },
    clear(): void {
      cache.clear();
    },
  };
}

const domTileCanvasFactory: UnderlayCanvasFactory = {
  create(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('a 2d canvas context is unavailable for the tile composite');
    return { canvas, context, width, height };
  },
};
