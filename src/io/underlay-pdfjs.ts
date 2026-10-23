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
 *
 * PR #42 fixes (2026-10-22):
 * - Fix 1: the deadline/abort supervisor (OpGuard) now covers the WHOLE
 *   operation — module load, session open, session re-open, getPage and
 *   render are all raced against ONE real-time deadline armed before
 *   createSession; on expiry the worker is hard-terminated, the call
 *   settles with the typed refusal, and the next call recovers on a
 *   fresh worker. (Before, only the render await was watched and a
 *   stalled open/pageSize/getPage hung forever.)
 * - Node 22: pdfjs-runtime-shims installs Promise.try where the runtime
 *   lacks it (Node 22.23.3 has none; without it pdfjs's worker message
 *   dispatch throws and every operation hangs — see that module).
 * - Cleanup 1: an unsuccessful open owns its session's disposal —
 *   hard-terminate first, synchronously, destroy fire-and-forget,
 *   never awaited (a withheld Terminate reply hung the cap refusals'
 *   previously awaited destroy past the deadline, unabortable, with
 *   the worker never terminated).
 */
import './pdfjs-runtime-shims';
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

/**
 * One operation's supervisor (PR #42 fix 1): the cooperative injected
 * clock (`check`, unchanged — the corpus tests drive it) PLUS a
 * real-time race arm. Before the fix only the final render await had a
 * watchdog; an open, pageSize or getPage that never settled hung the
 * operation forever. Now every await that crosses the worker boundary
 * goes through `race`: ONE real-time deadline (caps.deadlineMs from
 * the operation's start) and the caller's abort signal share a single
 * expiry; when it fires, the race rejects with the typed hit and the
 * caller's onExpire runs (cancel + teardown + hard-terminate), so the
 * refusal lands at the cap on any machine, at any CPU speed.
 */
interface OpGuard {
  check(): void;
  race<T>(promise: Promise<T>, onExpire: () => void): Promise<T>;
  dispose(): void;
}

const BYTES_PER_PIXEL = 4; // RGBA

export function createPdfjsEngine(deps: PdfjsEngineDeps = {}): UnderlayRasterEngine {
  const caps = deps.caps ?? DEFAULT_UNDERLAY_CAPS;
  const now = deps.now ?? (() => Date.now());
  const canvasFactory = deps.canvasFactory ?? domCanvasFactory;

  /** One operation's supervisor: cooperative checkpoints + the real-time race arm (see OpGuard). */
  const op = (signal?: AbortSignal): OpGuard => {
    const start = now();
    const realStart = Date.now();
    let fire: (hit: Error) => void = () => undefined;
    const expiry = new Promise<never>((_resolve, reject) => { fire = reject; });
    void expiry.catch(() => undefined); // an expiry nobody races is not an error
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed = false;
    const onAbort = (): void => fire(new CancelledHit());
    const arm = (): void => {
      if (armed) return;
      armed = true;
      if (signal?.aborted) {
        fire(new CancelledHit());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const remaining = caps.deadlineMs - (Date.now() - realStart);
      timer = setTimeout(() => fire(new DeadlineHit()), Math.max(0, remaining));
      (timer as { unref?: () => void }).unref?.();
    };
    return {
      check(): void {
        if (signal?.aborted) throw new CancelledHit();
        if (now() - start > caps.deadlineMs) throw new DeadlineHit();
      },
      async race<T>(promise: Promise<T>, onExpire: () => void): Promise<T> {
        arm();
        try {
          return await Promise.race([promise, expiry]);
        } catch (err) {
          if (err instanceof DeadlineHit || err instanceof CancelledHit) onExpire();
          throw err;
        }
      },
      dispose(): void {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
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
  const createSession = async (pdfjs: PdfjsModule, bytes: Uint8Array, guard?: OpGuard): Promise<PdfjsSessionParts> => {
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
    // One destroy path for every failure of this attempt — a parse
    // error, or the operation supervisor expiring mid-open (fix 1: a
    // worker that never answers GetDocRequest is terminated exactly
    // once and the open settles with the typed refusal).
    let attemptDestroyed = false;
    const destroyAttempt = (): void => {
      if (attemptDestroyed) return;
      attemptDestroyed = true;
      void loadingTask.destroy().catch(() => undefined);
      if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
      }
    };
    try {
      const doc = guard ? await guard.race(loadingTask.promise, destroyAttempt) : await loadingTask.promise;
      return { loadingTask, doc, ...(worker ? { worker } : {}) };
    } catch (err) {
      destroyAttempt();
      throw err;
    }
  };

  const open: UnderlayRasterEngine['open'] = async (bytes, opts) => {
    // The supervisor is armed BEFORE any session exists (fix 1), so a
    // stalled module load or first open is bounded like every phase.
    const guard = op(opts?.signal);
    try {
      guard.check();
      if (bytes.byteLength > caps.maxBytes) {
        return underlayRefusal('too-large', `input is ${bytes.byteLength} bytes, over the ${caps.maxBytes}-byte cap`);
      }
      const pdfjs = await guard.race(loadPdfjs(), () => undefined);
      guard.check();
      // The document retains its own copy of the bytes: after a
      // hard-terminated session it re-parses from them in a fresh one.
      const stored = bytes.slice();
      const first = await createSession(pdfjs, stored, guard);
      // The operation OWNS this session until open succeeds and hands
      // it to the returned document (PR #42 cleanup 1): EVERY
      // unsuccessful open — a cap refusal, the deadline, an abort, a
      // late success after the deadline — disposes it here. Disposal
      // hard-terminates the worker FIRST, synchronously, and lets the
      // graceful destroy trail fire-and-forget: the destroy is never
      // awaited, because a worker that withholds its Terminate reply
      // would otherwise hold the open (and the deadline, and the
      // abort) hostage forever — the previously awaited destroy WAS
      // that hang, and it left the adapter's terminate unreached.
      let firstDisposed = false;
      const disposeFirst = (): void => {
        if (firstDisposed) return;
        firstDisposed = true;
        if (first.worker) { try { first.worker.terminate(); } catch { /* already gone */ } }
        void first.loadingTask.destroy().catch(() => undefined);
      };
      try {
        guard.check();
        if (first.doc.numPages === 0) {
          disposeFirst();
          return underlayRefusal('corrupt', 'the document has no pages');
        }
        if (first.doc.numPages > caps.maxPages) {
          disposeFirst();
          return underlayRefusal('too-many-pages', `the document claims ${first.doc.numPages} pages, over the ${caps.maxPages}-page cap`);
        }
      } catch (err) {
        disposeFirst();
        throw err;
      }
      return {
        ok: true,
        value: new PdfjsDocument(first, {
          caps, now, canvasFactory, op,
          createSession: (sessionGuard) => createSession(pdfjs, stored, sessionGuard),
        }),
      };
    } catch (err) {
      return mapError(err);
    } finally {
      guard.dispose();
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
  readonly op: (signal?: AbortSignal) => OpGuard;
  /** Open a fresh session (fresh dedicated worker) — the recovery path after a hard termination. */
  readonly createSession: (guard?: OpGuard) => Promise<PdfjsSessionParts>;
}

/** A live parse session plus its lifecycle flag (dead = terminated/torn down). */
interface PdfjsSession extends PdfjsSessionParts {
  dead: boolean;
}

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
  private async ensureSession(guard: OpGuard): Promise<PdfjsSession> {
    if (this.session && !this.session.dead) return this.session;
    if (!this.sessionLoading) {
      const loading = (async (): Promise<PdfjsSession> => {
        const parts = await this.deps.createSession(guard);
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
    const loading = this.sessionLoading;
    return guard.race(loading, () => {
      // The supervisor gave up on this load: if the session still
      // lands afterwards, tear it down on arrival — nobody owns it.
      void loading.then((session) => this.teardown(session), () => undefined);
    });
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
    const guard = this.deps.op(opts?.signal);
    try {
      return await this.pageSizeUnder(page, guard);
    } catch (err) {
      return mapError(err);
    } finally {
      guard.dispose();
    }
  }

  /** pageSize under a caller-owned supervisor, so a render's internal size lookup shares the render's ONE deadline. */
  private async pageSizeUnder(page: number, guard: OpGuard): Promise<UnderlayResult<UnderlayPageSize>> {
    guard.check();
    if (this.closed) return underlayRefusal('corrupt', 'the document is closed');
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
      return underlayRefusal('corrupt', `page ${page} is out of range (1..${this.pageCount})`);
    }
    const hit = this.sizes.get(page);
    if (hit) return { ok: true, value: hit };
    const session = await this.ensureSession(guard);
    const pdfPage = await guard.race(session.doc.getPage(page), () => this.teardown(session));
    guard.check();
    const viewport = pdfPage.getViewport({ scale: 1 });
    const size = { width: viewport.width, height: viewport.height };
    this.sizes.set(page, size);
    return { ok: true, value: size };
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
    const guard = this.deps.op(opts?.signal);
    try {
      guard.check();
      if (this.closed) return underlayRefusal('corrupt', 'the document is closed');
      if (!Number.isFinite(scale) || scale <= 0) return underlayRefusal('corrupt', `render scale ${scale} is not a positive finite number`);
      if (clip && (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0)) {
        return underlayRefusal('corrupt', 'the clip region is not a positive finite rectangle');
      }
      const sized = await this.pageSizeUnder(page, guard);
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
      guard.check();
      const session = await this.ensureSession(guard);
      guard.check();
      const pdfPage = await guard.race(session.doc.getPage(page), () => this.teardown(session));
      guard.check();
      const factory = this.deps.canvasFactory;
      const slot = factory.create(width, height);
      guard.check(); // a factory may consume the operation's clock (tests do); the deadline rules
      const viewport = pdfPage.getViewport({
        scale,
        ...(clip ? { offsetX: -region.x * scale, offsetY: -region.y * scale } : {}),
      });
      const task = pdfPage.render({
        canvas: slot.canvas as HTMLCanvasElement,
        canvasContext: slot.context as CanvasRenderingContext2D,
        viewport,
      });
      // The render itself is raced under the SAME supervisor (fix 1
      // subsumes the H fix's render-only watchdog): on expiry the task
      // is cancelled, the session torn down and its worker
      // hard-terminated — a killed render may never settle, so it is
      // raced, never awaited unguarded.
      try {
        await guard.race(task.promise, () => {
          try { task.cancel(); } catch { /* task already gone */ }
          this.teardown(session);
        });
      } catch (err) {
        if (opts?.signal?.aborted) return underlayRefusal('cancelled', 'the operation was cancelled');
        throw err;
      }
      guard.check();
      return { ok: true, value: { image: slot.canvas, width: slot.width, height: slot.height, pageSize: size, region } };
    } catch (err) {
      return mapError(err);
    } finally {
      guard.dispose();
    }
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
