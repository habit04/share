/**
 * The underlay rasterization seam (P28, P28-DEP FINAL ruling 2026-10-21).
 *
 * Everything in P28 except ONE adapter file depends only on this interface:
 * open a referenced file's bytes, learn its page count and page sizes, and
 * render one page to a bitmap at a requested scale. Failure is a typed
 * refusal in the slice-1 probe vocabulary (underlay-adapter.ts) — never a
 * thrown exception crossing this seam, never a cap breach. The engine is
 * swappable behind this contract: today the single implementation is the
 * pdfjs-dist adapter (underlay-pdfjs.ts); DWF/DGN have NO admitted engine
 * and stay on the bounded-probe posture (probeUnderlay).
 *
 * Caps (RULING-P28 C5, pinned by DEFAULT_UNDERLAY_CAPS): 64 MiB input,
 * 10,000 pages, 8 MiB per page (rendered pixels), 5 s per operation,
 * caller cancellation via AbortSignal. An implementation MUST enforce all
 * of them itself; callers do not re-check.
 */
import type { UnderlayCaps, UnderlayProbeErrorCode } from './underlay-adapter';

/** The refusal vocabulary is the slice-1 probe's, unchanged. */
export type UnderlayRefusalCode = UnderlayProbeErrorCode;
export type { UnderlayCaps };

export interface UnderlayEngineRefusal {
  readonly ok: false;
  readonly code: UnderlayRefusalCode;
  readonly reason: string;
}

export type UnderlayResult<T> = { readonly ok: true; readonly value: T } | UnderlayEngineRefusal;

export const underlayRefusal = (code: UnderlayRefusalCode, reason: string): UnderlayEngineRefusal => ({ ok: false, code, reason });

/** A page's size in the referenced file's own units (PDF points for PDF). */
export interface UnderlayPageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A rasterized page. `image` is platform image data (a canvas in the
 * browser/Electron renderer); this seam stays platform-neutral by treating
 * it as opaque — the draw path hands it to the canvas it renders into.
 */
export interface UnderlayRaster {
  readonly image: unknown;
  /** Pixel dimensions of the raster. */
  readonly width: number;
  readonly height: number;
  /** The page size the raster was rendered from, in file units. */
  readonly pageSize: UnderlayPageSize;
}

/**
 * A rectangular clip region of a page, in the file's own units, with the
 * origin at the page's TOP-LEFT corner, x growing right and y growing
 * DOWN — raster orientation, so a region maps directly onto pixel bounds
 * at any scale: pixel (px, py) covers page point (x + px/scale,
 * y + py/scale). (PDF user space is bottom-left/y-up; the adapter
 * converts.) Regions are intersected with the page bounds by the adapter;
 * a region that does not intersect the page at all is refused.
 */
export interface UnderlayClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A rasterized page region: an UnderlayRaster plus the clip it covers. */
export interface UnderlayRegionRaster extends UnderlayRaster {
  /** The region actually rendered, after intersection with the page. */
  readonly region: UnderlayClipRect;
}

/** Rendered-pixel bytes per pixel charged against the per-page cap (RGBA). */
export const UNDERLAY_BYTES_PER_PIXEL = 4;

/**
 * Plan a grid of tiles covering `region` (page units, top-left origin)
 * such that every tile's raster at `scale` is at most `maxBytes` bytes —
 * the F-class fix: a whole ARCH E / A0 page at scale 4 needs ~0.5 GB and
 * can never be rendered under the 8 MiB per-page cap, but any visible
 * window of it can, tile by tile. Tiles are whole pixel rows/columns of
 * the region's raster, emitted row-major; their union is exactly
 * `region`. Pure and deterministic; an empty plan means the region is
 * empty. Callers render each tile with renderRegion and composite.
 */
export function planUnderlayTiles(
  region: UnderlayClipRect,
  scale: number,
  maxBytes: number,
): readonly UnderlayClipRect[] {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(maxBytes) || maxBytes < UNDERLAY_BYTES_PER_PIXEL) return [];
  const regionPxW = Math.ceil(region.width * scale);
  const regionPxH = Math.ceil(region.height * scale);
  if (regionPxW <= 0 || regionPxH <= 0) return [];
  const maxPx = Math.floor(maxBytes / UNDERLAY_BYTES_PER_PIXEL);
  // Widest tile column that can still hold at least one pixel row, then
  // as many rows per tile as the budget allows at that width.
  const tilePxW = Math.min(regionPxW, maxPx);
  const tilePxH = Math.min(regionPxH, Math.max(1, Math.floor(maxPx / tilePxW)));
  const tiles: UnderlayClipRect[] = [];
  for (let py = 0; py < regionPxH; py += tilePxH) {
    const hPx = Math.min(tilePxH, regionPxH - py);
    for (let px = 0; px < regionPxW; px += tilePxW) {
      const wPx = Math.min(tilePxW, regionPxW - px);
      tiles.push({
        x: region.x + px / scale,
        y: region.y + py / scale,
        width: wPx / scale,
        height: hPx / scale,
      });
    }
  }
  return tiles;
}

/**
 * A canvas the engine renders into, created by the caller's factory. This
 * mirrors the pdfjs canvasFactory contract so an adapter needs no DOM of
 * its own: the app supplies real canvases, tests supply stubs.
 */
export interface UnderlayCanvasSlot {
  readonly canvas: unknown;
  readonly context: unknown;
  readonly width: number;
  readonly height: number;
}

export interface UnderlayCanvasFactory {
  create(width: number, height: number): UnderlayCanvasSlot;
  destroy?(slot: UnderlayCanvasSlot): void;
}

export interface UnderlayOpenOptions {
  readonly signal?: AbortSignal;
  /** Page the caller cares about first (adapters may warm it; sizes are per-page regardless). */
  readonly signalPage?: number;
}

export interface UnderlayDocument {
  readonly pageCount: number;
  /** 1-based page size; a typed refusal (corrupt/deadline/cancelled), never a throw. */
  pageSize(page: number, opts?: { readonly signal?: AbortSignal }): Promise<UnderlayResult<UnderlayPageSize>>;
  /**
   * Render a 1-based page at `scale` (file units -> pixels). The rendered
   * pixel bytes are charged against the per-page cap BEFORE rendering.
   */
  renderPage(page: number, scale: number, opts?: { readonly signal?: AbortSignal }): Promise<UnderlayResult<UnderlayRaster>>;
  /**
   * Render ONLY the given clip region of a 1-based page at `scale`
   * (F-class fix, 2026-10-22): the region's rendered bytes are charged
   * against the per-page cap BEFORE rendering, so a clip that fits is
   * rendered even when the whole page at that scale never could be.
   * Callers tile large regions with planUnderlayTiles. The returned
   * raster's `region` is the clip after intersection with the page.
   */
  renderRegion(page: number, region: UnderlayClipRect, scale: number, opts?: { readonly signal?: AbortSignal }): Promise<UnderlayResult<UnderlayRegionRaster>>;
  /** Release the document and its worker-side state. Idempotent. */
  close(): void;
}

export interface UnderlayRasterEngine {
  /** Which underlay kind this engine decodes (only 'pdf' is admitted today). */
  readonly kind: 'pdf';
  open(bytes: Uint8Array, opts?: UnderlayOpenOptions): Promise<UnderlayResult<UnderlayDocument>>;
}
