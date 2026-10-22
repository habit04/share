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
import type { UnderlayRasterEngine } from '../io/underlay-engine';
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
