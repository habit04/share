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
 *
 * F+H fixes (2026-10-22, corpus classes F and H):
 * - renderRegion renders a clipped viewport of a page (pdfjs viewport
 *   offsets), charged against the per-page cap on the REGION's bytes, so
 *   visible tiles of a huge sheet render at inspection scale where the
 *   whole page never could; planUnderlayTiles (underlay-engine.ts) sizes
 *   the tiles.
 * - Every parse runs in its own SESSION with a DEDICATED worker, and a
 *   render is bounded by a real-time watchdog: at the deadline the render
 *   task is cancelled, the loading task destroyed and the worker
 *   hard-terminated, so a render stuck inside the worker (the
 *   billion-laughs case) is wall-clock bounded wherever the worker is a
 *   real thread. A terminated session is gone for good; the document
 *   keeps its source bytes and lazily opens a FRESH session (fresh
 *   worker) for the next operation, so the engine stays usable.
 */
import { DEFAULT_UNDERLAY_CAPS } from './underlay-adapter';
import {
  underlayRefusal,
  type UnderlayCaps,
  type UnderlayCanvasFactory,
  type UnderlayClipRect,
  type UnderlayDocument,
  type UnderlayPageSize,
  type UnderlayRaster,
  type UnderlayRasterEngine,
  type UnderlayRegionRaster,
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

  // The canvas factory is document-level in pdfjs: pdfjs must never fall
  // back to a platform factory of its own — every canvas it creates
  // (main or internal) comes from the injected factory.
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

  /**
   * Open one parse session on a FRESH dedicated worker (H fix). pdfjs
   * binds GlobalWorkerOptions.workerPort synchronously inside
   * getDocument (verified against the pinned 6.4.299 build) and allows
   * exactly one live document per port, so the port is set immediately
   * before the call and each session owns its worker outright: the
   * deadline watchdog can hard-terminate it without touching any other
   * document. In workerSrc mode pdfjs creates and owns the worker per
   * loading task, and loadingTask.destroy() terminates it.
   */
  const createSession = async (pdfjs: PdfjsModule, bytes: Uint8Array): Promise<PdfjsSessionParts> => {
    let worker: Worker | undefined;
    if (deps.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = deps.workerSrc;
    } else {
      const create = deps.createWorker ?? (() => new Worker(new URL('./pdfjs-worker-entry.ts', import.meta.url), { type: 'module' }));
      worker = create();
      pdfjs.GlobalWorkerOptions.workerPort = worker;
    }
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
    try {
      const doc = await loadingTask.promise;
      return { loadingTask, doc, ...(worker ? { worker } : {}) };
    } catch (err) {
      void loadingTask.destroy().catch(() => undefined);
      if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
      }
      throw err;
    }
  };

  const open: UnderlayRasterEngine['open'] = async (bytes, opts) => {
    const clock = op(opts?.signal);
    try {
      clock.check();
      if (bytes.byteLength > caps.maxBytes) {
        return underlayRefusal('too-large', `input is ${bytes.byteLength} bytes, over the ${caps.maxBytes}-byte cap`);
      }
      const pdfjs = await loadPdfjs();
      clock.check();
      // The document retains its own copy of the bytes: after a
      // hard-terminated session it re-parses from them in a fresh one.
      const stored = bytes.slice();
      const first = await createSession(pdfjs, stored);
      clock.check();
      if (first.doc.numPages === 0) {
        await first.loadingTask.destroy();
        if (first.worker) { try { first.worker.terminate(); } catch { /* already gone */ } }
        return underlayRefusal('corrupt', 'the document has no pages');
      }
      if (first.doc.numPages > caps.maxPages) {
        await first.loadingTask.destroy();
        if (first.worker) { try { first.worker.terminate(); } catch { /* already gone */ } }
        return underlayRefusal('too-many-pages', `the document claims ${first.doc.numPages} pages, over the ${caps.maxPages}-page cap`);
      }
      return {
        ok: true,
        value: new PdfjsDocument(first, {
          caps, now, canvasFactory, op,
          createSession: () => createSession(pdfjs, stored),
        }),
      };
    } catch (err) {
      return mapError(err);
    }
  };

  return { kind: 'pdf', open };
}

/** The pieces of one live parse session, before lifecycle tracking. */
interface PdfjsSessionParts {
  readonly loadingTask: PdfjsLoadingTask;
  readonly doc: PdfjsDocumentProxy;
  /** The session's dedicated worker (browser path only; in workerSrc mode pdfjs owns it). */
  readonly worker?: Worker;
}

interface DocDeps {
  readonly caps: UnderlayCaps;
  readonly now: () => number;
  readonly canvasFactory: UnderlayCanvasFactory;
  readonly op: (signal?: AbortSignal) => { check(): void };
  /** Open a fresh session (fresh dedicated worker) — the recovery path after a hard termination. */
  readonly createSession: () => Promise<PdfjsSessionParts>;
}

/** A live parse session plus its lifecycle flag (dead = terminated/torn down). */
interface PdfjsSession extends PdfjsSessionParts {
  dead: boolean;
}

type RenderOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly err: unknown }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'cancelled' };

class PdfjsDocument implements UnderlayDocument {
  readonly pageCount: number;
  private readonly sizes = new Map<number, UnderlayPageSize>();
  private closed = false;
  private session: PdfjsSession | null;
  private sessionLoading: Promise<PdfjsSession> | null = null;

  constructor(first: PdfjsSessionParts, private readonly deps: DocDeps) {
    this.pageCount = first.doc.numPages;
    this.session = { ...first, dead: false };
  }

  /** The live session, lazily re-created (fresh worker) after a hard termination. */
  private async ensureSession(): Promise<PdfjsSession> {
    if (this.session && !this.session.dead) return this.session;
    if (!this.sessionLoading) {
      const loading = (async (): Promise<PdfjsSession> => {
        const parts = await this.deps.createSession();
        const session: PdfjsSession = { ...parts, dead: false };
        if (this.closed) {
          this.teardown(session);
          throw new CancelledHit();
        }
        this.session = session;
        return session;
      })();
      this.sessionLoading = loading;
      void loading.catch(() => undefined).finally(() => {
        if (this.sessionLoading === loading) this.sessionLoading = null;
      });
    }
    return this.sessionLoading;
  }

  /** Destroy a session's loading task and hard-terminate its dedicated worker. Idempotent. */
  private teardown(session: PdfjsSession): void {
    if (session.dead) return;
    session.dead = true;
    if (this.session === session) this.session = null;
    void session.loadingTask.destroy().catch(() => undefined);
    if (session.worker) {
      try { session.worker.terminate(); } catch { /* already gone */ }
    }
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
      const session = await this.ensureSession();
      const pdfPage = await session.doc.getPage(page);
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
    return this.renderInternal(page, null, scale, opts);
  }

  async renderRegion(page: number, region: UnderlayClipRect, scale: number, opts?: { signal?: AbortSignal }): Promise<UnderlayResult<UnderlayRegionRaster>> {
    return this.renderInternal(page, region, scale, opts);
  }

  private async renderInternal(
    page: number,
    clip: UnderlayClipRect | null,
    scale: number,
    opts?: { signal?: AbortSignal },
  ): Promise<UnderlayResult<UnderlayRegionRaster>> {
    const clock = this.deps.op(opts?.signal);
    const realStart = Date.now();
    try {
      clock.check();
      if (this.closed) return underlayRefusal('corrupt', 'the document is closed');
      if (!Number.isFinite(scale) || scale <= 0) return underlayRefusal('corrupt', `render scale ${scale} is not a positive finite number`);
      if (clip && (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0)) {
        return underlayRefusal('corrupt', 'the clip region is not a positive finite rectangle');
      }
      const sized = await this.pageSize(page, opts);
      if (!sized.ok) return sized;
      const size = sized.value;
      // Intersect the clip with the page (clip space: the page's
      // top-left origin, x right, y down — see UnderlayClipRect).
      const region: UnderlayClipRect = clip
        ? {
            x: Math.max(0, clip.x),
            y: Math.max(0, clip.y),
            width: Math.min(size.width, clip.x + clip.width) - Math.max(0, clip.x),
            height: Math.min(size.height, clip.y + clip.height) - Math.max(0, clip.y),
          }
        : { x: 0, y: 0, width: size.width, height: size.height };
      if (region.width <= 0 || region.height <= 0) {
        return underlayRefusal('corrupt', `the clip region does not intersect page ${page}`);
      }
      // Region rasters size to the nearest pixel; whole-page renders
      // keep the established ceil sizing.
      const width = Math.max(1, clip ? Math.round(region.width * scale) : Math.ceil(size.width * scale));
      const height = Math.max(1, clip ? Math.round(region.height * scale) : Math.ceil(size.height * scale));
      // The cap is charged on the RENDERED bytes BEFORE any work (C5):
      // a clip that fits renders even when the whole page could not (F).
      const bytesNeeded = width * height * BYTES_PER_PIXEL;
      if (bytesNeeded > this.deps.caps.maxScanBytes) {
        return underlayRefusal(
          'scan-limit',
          clip
            ? `rendering this clip of page ${page} at scale ${scale} needs ${bytesNeeded} bytes, over the ${this.deps.caps.maxScanBytes}-byte per-page cap — tile it with planUnderlayTiles`
            : `rendering page ${page} at scale ${scale} needs ${bytesNeeded} bytes, over the ${this.deps.caps.maxScanBytes}-byte per-page cap`,
        );
      }
      clock.check();
      const session = await this.ensureSession();
      clock.check();
      const pdfPage = await session.doc.getPage(page);
      clock.check();
      const factory = this.deps.canvasFactory;
      const slot = factory.create(width, height);
      clock.check(); // a factory may consume the operation's clock (tests do); the deadline rules
      const viewport = pdfPage.getViewport({
        scale,
        ...(clip ? { offsetX: -region.x * scale, offsetY: -region.y * scale } : {}),
      });
      const task = pdfPage.render({
        canvas: slot.canvas as HTMLCanvasElement,
        canvasContext: slot.context as CanvasRenderingContext2D,
        viewport,
      });
      const outcome = await this.awaitRender(task, session, realStart, opts?.signal);
      if (outcome.kind === 'deadline') return underlayRefusal('deadline', 'the operation exceeded its deadline');
      if (outcome.kind === 'cancelled') return underlayRefusal('cancelled', 'the operation was cancelled');
      if (outcome.kind === 'error') throw outcome.err;
      clock.check();
      return { ok: true, value: { image: slot.canvas, width: slot.width, height: slot.height, pageSize: size, region } };
    } catch (err) {
      return mapError(err);
    }
  }

  /**
   * Await one pdfjs render under the HARD deadline (H fix). A real-time
   * watchdog is armed for the operation's remaining budget — real time,
   * not the injectable op clock, because bounding wall clock is its
   * whole point. On expiry it cancels the render task, tears the
   * session down and hard-terminates the session's dedicated worker, so
   * a render stuck inside the worker is bounded wherever the worker is
   * a real thread. The render promise is RACED, never awaited
   * unguarded: a killed render may never settle. The cooperative op
   * clock still applies around this await (it governs the test clock).
   */
  private awaitRender(
    task: PdfjsRenderTask,
    session: PdfjsSession,
    realStart: number,
    signal?: AbortSignal,
  ): Promise<RenderOutcome> {
    return new Promise<RenderOutcome>((resolve) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: RenderOutcome): void => {
        if (settled) return;
        settled = true;
        if (watchdog !== undefined) clearTimeout(watchdog);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => {
        try { task.cancel(); } catch { /* task already gone */ }
        finish({ kind: 'cancelled' });
      };
      const remaining = this.deps.caps.deadlineMs - (Date.now() - realStart);
      watchdog = setTimeout(() => {
        try { task.cancel(); } catch { /* task already gone */ }
        this.teardown(session);
        finish({ kind: 'deadline' });
      }, Math.max(0, remaining));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      task.promise.then(
        () => finish({ kind: 'done' }),
        (err: unknown) => finish(signal?.aborted ? { kind: 'cancelled' } : { kind: 'error', err }),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.session) this.teardown(this.session);
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
type PdfjsLoadingTask = ReturnType<PdfjsModule['getDocument']>;
type PdfjsRenderTask = ReturnType<import('pdfjs-dist').PDFPageProxy['render']>;
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
