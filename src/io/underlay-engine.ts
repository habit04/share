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
  /** Release the document and its worker-side state. Idempotent. */
  close(): void;
}

export interface UnderlayRasterEngine {
  /** Which underlay kind this engine decodes (only 'pdf' is admitted today). */
  readonly kind: 'pdf';
  open(bytes: Uint8Array, opts?: UnderlayOpenOptions): Promise<UnderlayResult<UnderlayDocument>>;
}
