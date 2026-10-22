/**
 * The pdfjs-dist adapter: the SINGLE implementation of the underlay
 * rasterization seam (underlay-engine.ts) and the only file in the
 * codebase that imports pdfjs-dist (pinned exactly at 6.4.299, Apache-2.0;
 * see THIRD-PARTY-NOTICES.md). Everything else in P28 depends on the
 * interface alone, so the engine stays swappable.
 *
 * Dep ruling conditions (P28-DEP FINAL, 2026-10-21), as implemented here:
 * - `isEvalSupported: false` AND `enableScripting: false` are set
 *   expressly on every getDocument call.
 * - pdfjs runs in a DEDICATED worker: in the browser/Electron renderer a
 *   module worker built from pdfjs-worker-entry.ts (served under the
 *   path-scoped worker CSP, `script-src 'self' 'wasm-unsafe-eval'` +
 *   `connect-src 'self'`); tests inject a worker source instead. The page
 *   CSP is never widened.
 * - ALL RULING-P28 C5 caps are enforced in this adapter (DEFAULT_UNDERLAY_CAPS
 *   unless overridden): input bytes, page count, per-page rendered bytes,
 *   a per-operation deadline, and caller cancellation via AbortSignal.
 * - Failure is a typed refusal in the probe vocabulary — this module never
 *   throws across the seam.
 */
import { DEFAULT_UNDERLAY_CAPS } from './underlay-adapter';
import {
  underlayRefusal,
  type UnderlayCaps,
  type UnderlayCanvasFactory,
  type UnderlayDocument,
  type UnderlayPageSize,
  type UnderlayRaster,
  type UnderlayRasterEngine,
  type UnderlayResult,
} from './underlay-engine';

export interface PdfjsEngineDeps {
  readonly caps?: UnderlayCaps;
  /** Render target factory. Default: real DOM canvases (browser/Electron). */
  readonly canvasFactory?: UnderlayCanvasFactory;
  /** Create the dedicated worker (browser). Default: the Vite worker entry. */
  readonly createWorker?: () => Worker;
  /** Worker source URL (Node/tests), used instead of a worker object. */
  readonly workerSrc?: string;
  /** Clock for the per-operation deadline; injectable for tests. */
  readonly now?: () => number;
}

class DeadlineHit extends Error {}
class CancelledHit extends Error {}

const BYTES_PER_PIXEL = 4; // RGBA

export function createPdfjsEngine(deps: PdfjsEngineDeps = {}): UnderlayRasterEngine {
  const caps = deps.caps ?? DEFAULT_UNDERLAY_CAPS;
  const now = deps.now ?? (() => Date.now());
  const canvasFactory = deps.canvasFactory ?? domCanvasFactory;
  let workerReady = false;

  const ensureWorker = async (pdfjs: PdfjsModule): Promise<void> => {
    if (workerReady) return;
    if (deps.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = deps.workerSrc;
    } else {
      const create = deps.createWorker ?? (() => new Worker(new URL('./pdfjs-worker-entry.ts', import.meta.url), { type: 'module' }));
      pdfjs.GlobalWorkerOptions.workerPort = create();
    }
    workerReady = true;
  };

  /** One operation's budget checkpoints: deadline + cancellation, checked around every await. */
  const op = (signal?: AbortSignal) => {
    const start = now();
    return {
      check(): void {
        if (signal?.aborted) throw new CancelledHit();
        if (now() - start > caps.deadlineMs) throw new DeadlineHit();
      },
    };
  };

  const open: UnderlayRasterEngine['open'] = async (bytes, opts) => {
    const clock = op(opts?.signal);
    try {
      clock.check();
      if (bytes.byteLength > caps.maxBytes) {
        return underlayRefusal('too-large', `input is ${bytes.byteLength} bytes, over the ${caps.maxBytes}-byte cap`);
      }
      const pdfjs = await loadPdfjs();
      await ensureWorker(pdfjs);
      clock.check();
      // The canvas factory is document-level in pdfjs: pdfjs must never
      // fall back to a platform factory of its own — every canvas it
      // creates (main or internal) comes from the injected factory.
      const pdfjsCanvasFactory = {
        create: (w: number, h: number) => {
          const slot = canvasFactory.create(w, h);
          return { canvas: slot.canvas as HTMLCanvasElement, context: slot.context as CanvasRenderingContext2D };
        },
        reset: (entry: { canvas: HTMLCanvasElement }, w: number, h: number) => {
          entry.canvas.width = w;
          entry.canvas.height = h;
        },
        destroy: () => undefined,
      };
      // isEvalSupported:false AND enableScripting:false are set expressly
      // (P28-DEP FINAL ruling, 2026-10-21): no PDF JavaScript, no formula
      // evaluation, ever. In pdfjs 6 the eval evaluator itself was
      // removed — isEvalSupported no longer exists in its types and the
      // string never occurs in the pinned build (verified) — so that flag
      // is belt-and-braces: passed anyway, it can only ever read as false.
      const init = {
        data: bytes.slice(),
        verbosity: 0,
        isEvalSupported: false,
        enableScripting: false,
        canvasFactory: pdfjsCanvasFactory,
      } as PdfjsInit;
      const loadingTask = pdfjs.getDocument(init);
      const doc = await loadingTask.promise;
      clock.check();
      if (doc.numPages === 0) {
        await loadingTask.destroy();
        return underlayRefusal('corrupt', 'the document has no pages');
      }
      if (doc.numPages > caps.maxPages) {
        await loadingTask.destroy();
        return underlayRefusal('too-many-pages', `the document claims ${doc.numPages} pages, over the ${caps.maxPages}-page cap`);
      }
      return { ok: true, value: new PdfjsDocument(doc, loadingTask, { caps, now, canvasFactory, op }) };
    } catch (err) {
      return mapError(err);
    }
  };

  return { kind: 'pdf', open };
}

interface DocDeps {
  readonly caps: UnderlayCaps;
  readonly now: () => number;
  readonly canvasFactory: UnderlayCanvasFactory;
  readonly op: (signal?: AbortSignal) => { check(): void };
}

class PdfjsDocument implements UnderlayDocument {
  readonly pageCount: number;
  private readonly sizes = new Map<number, UnderlayPageSize>();
  private closed = false;

  constructor(
    private readonly doc: PdfjsDocumentProxy,
    private readonly loadingTask: { destroy(): Promise<void> },
    private readonly deps: DocDeps,
  ) {
    this.pageCount = doc.numPages;
  }

  async pageSize(page: number, opts?: { signal?: AbortSignal }): Promise<UnderlayResult<UnderlayPageSize>> {
    const clock = this.deps.op(opts?.signal);
    try {
      clock.check();
      if (this.closed) return underlayRefusal('corrupt', 'the document is closed');
      if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
        return underlayRefusal('corrupt', `page ${page} is out of range (1..${this.pageCount})`);
      }
      const hit = this.sizes.get(page);
      if (hit) return { ok: true, value: hit };
      const pdfPage = await this.doc.getPage(page);
      clock.check();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const size = { width: viewport.width, height: viewport.height };
      this.sizes.set(page, size);
      return { ok: true, value: size };
    } catch (err) {
      return mapError(err);
    }
  }

  async renderPage(page: number, scale: number, opts?: { signal?: AbortSignal }): Promise<UnderlayResult<UnderlayRaster>> {
    const clock = this.deps.op(opts?.signal);
    try {
      clock.check();
      if (this.closed) return underlayRefusal('corrupt', 'the document is closed');
      if (!Number.isFinite(scale) || scale <= 0) return underlayRefusal('corrupt', `render scale ${scale} is not a positive finite number`);
      const sized = await this.pageSize(page, opts);
      if (!sized.ok) return sized;
      const size = sized.value;
      const width = Math.max(1, Math.ceil(size.width * scale));
      const height = Math.max(1, Math.ceil(size.height * scale));
      // The per-page cap is charged BEFORE any rendering work (C5).
      const bytesNeeded = width * height * BYTES_PER_PIXEL;
      if (bytesNeeded > this.deps.caps.maxScanBytes) {
        return underlayRefusal('scan-limit', `rendering page ${page} at scale ${scale} needs ${bytesNeeded} bytes, over the ${this.deps.caps.maxScanBytes}-byte per-page cap`);
      }
      clock.check();
      const factory = this.deps.canvasFactory;
      const slot = factory.create(width, height);
      clock.check(); // a factory may consume the operation's clock (tests do); the deadline rules
      const pdfPage = await this.doc.getPage(page);
      clock.check();
      const viewport = pdfPage.getViewport({ scale });
      const task = pdfPage.render({
        canvas: slot.canvas as HTMLCanvasElement,
        canvasContext: slot.context as CanvasRenderingContext2D,
        viewport,
      });
      const onAbort = (): void => task.cancel();
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await task.promise;
      } finally {
        opts?.signal?.removeEventListener('abort', onAbort);
      }
      clock.check();
      return { ok: true, value: { image: slot.canvas, width: slot.width, height: slot.height, pageSize: size } };
    } catch (err) {
      return mapError(err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.loadingTask.destroy();
  }
}

const domCanvasFactory: UnderlayCanvasFactory = {
  create(width: number, height: number) {
    if (typeof document === 'undefined') {
      throw new Error('no canvas factory is available in this environment (inject one via createPdfjsEngine deps)');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('a 2d canvas context is unavailable');
    return { canvas, context, width, height };
  },
};

function mapError(err: unknown): UnderlayResult<never> {
  if (err instanceof DeadlineHit) return underlayRefusal('deadline', 'the operation exceeded its deadline');
  if (err instanceof CancelledHit) return underlayRefusal('cancelled', 'the operation was cancelled');
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'PasswordException') {
    return underlayRefusal('corrupt', 'the document is encrypted and needs a password; password entry is not part of this slice');
  }
  if (name === 'AbortException' || /abort/i.test(message)) return underlayRefusal('cancelled', 'the operation was cancelled');
  if (name === 'InvalidPDFException' || name === 'MissingPDFException' || name === 'UnexpectedResponseException' || name === 'FormatError') {
    return underlayRefusal('corrupt', `the file is not a readable PDF (${message})`);
  }
  return underlayRefusal('corrupt', `the PDF could not be processed (${message})`);
}

// pdfjs is loaded lazily: interface consumers and non-PDF sessions never
// pay for it, and Vite code-splits it out of the initial bundle.
type PdfjsModule = typeof import('pdfjs-dist');
type PdfjsDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;
type PdfjsInit = NonNullable<Parameters<PdfjsModule['getDocument']>[0]> & {
  isEvalSupported: boolean;
  enableScripting: boolean;
  canvasFactory: {
    create(w: number, h: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
    reset(entry: { canvas: HTMLCanvasElement }, w: number, h: number): void;
    destroy(): void;
  };
};
let pdfjsPromise: Promise<PdfjsModule> | undefined;
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist');
  return pdfjsPromise;
}
