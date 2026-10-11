/**
 * DWG reading for the main process, off its event loop, with bounded input, memory and time
 * (security review E-7).
 *
 * LibreDWG (C compiled to WebAssembly) runs in a worker thread (scripts/dwg-worker.mjs). While it
 * parses, the main process keeps answering IPC, menus and window events, and the read can be
 * cancelled: `cancel(id)` terminates the worker (a fresh one starts for the next file). Limits:
 *
 * - input: at most 128 MiB (MAX_DRAWING_BYTES, electron/resource-limits.cjs), checked before the
 *   worker sees the bytes;
 * - JavaScript heap of the worker: 2048 MB old generation, 64 MB young generation, 8 MB stack
 *   (`resourceLimits`); a worker over it is stopped by V8 and the read fails;
 * - WebAssembly memory: the worker refuses to grow LibreDWG's memory beyond 2 GiB (it starts with
 *   1 GiB; the wasm32 maximum is 4 GiB): an allocation over it fails inside LibreDWG, and the read
 *   with it (scripts/dwg-worker.mjs);
 * - time: 60 s plus 1 s per MB of input (at most 10 minutes), then the worker is terminated; the
 *   progress dialog's Cancel stops it sooner; start-up of the worker itself has 15 s.
 *
 * There is no fallback to parsing in the main process: a worker that cannot start fails the open
 * with a message.
 *
 * Ported from PR #2 (codex/electrical-review-fixes 2f89b0e, electron/dwg-host.cjs), adapted: the
 * 128 MiB input limit, a time limit that grows with the file (a 100 MB drawing may legitimately need
 * more than a minute), a JavaScript heap of 2 GB (the payload of a DWG is about twelve times its
 * size: 512 MB would refuse files over about 40 MB), and the WebAssembly memory cap.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MAX_DRAWING_BYTES } = require('./resource-limits.cjs');

/** Files at least this large get the progress dialog (JCAD_OPEN_PROGRESS_BYTES overrides it). */
const DEFAULT_PROGRESS_BYTES = 1024 * 1024;
/** Wall-clock limit of one read: 60 s plus 1 s per MB, at most 10 minutes. */
const READ_TIMEOUT_BASE_MS = 60_000;
const READ_TIMEOUT_PER_MB_MS = 1_000;
const READ_TIMEOUT_MAX_MS = 10 * 60_000;
const START_TIMEOUT_MS = 15_000;
/** V8 limits of the worker thread. */
const WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });

class OpenCancelledError extends Error {
  constructor() { super('Open cancelled'); this.name = 'OpenCancelledError'; this.cancelled = true; }
}

/** The time limit for reading `bytes` bytes. */
function readTimeoutFor(bytes) {
  return Math.min(READ_TIMEOUT_MAX_MS, READ_TIMEOUT_BASE_MS + Math.ceil(bytes / (1024 * 1024)) * READ_TIMEOUT_PER_MB_MS);
}

/**
 * @param {{ scriptsDir: string, timeoutMs?: number, maxBytes?: number, resourceLimits?: import('node:worker_threads').ResourceLimits }} opts
 *   scriptsDir: folder holding dwg-worker.mjs (unpacked from the asar); timeoutMs: a fixed time
 *   limit per read instead of readTimeoutFor (tests); maxBytes: input limit (default 128 MiB);
 *   resourceLimits: the worker's V8 limits (default WORKER_RESOURCE_LIMITS; tests lower them)
 */
function createDwgHost({ scriptsDir, timeoutMs, maxBytes = MAX_DRAWING_BYTES, resourceLimits = WORKER_RESOURCE_LIMITS }) {
  if ((timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid DWG resource limits');
  const workerFile = path.join(scriptsDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), 'dwg-worker.mjs');
  /** @type {import('node:worker_threads').Worker | null} */
  let worker = null;
  /** @type {Promise<import('node:worker_threads').Worker> | null} */
  let starting = null;
  /** @type {(() => void) | null} */
  let cancelStarting = null;
  let disposed = false;
  /** Reads waiting for the worker to start: their cancel. */
  /** @type {Map<number, (error: Error) => void>} */
  const waiting = new Map();
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();
  /** Ids of reads that have started (the worker may still be starting up). */
  const active = new Set();

  const failAll = (/** @type {Error} */ error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  /** Stop the worker (and a start-up in progress); every read on it fails with `error`. */
  function terminate(/** @type {Error} */ error) {
    cancelStarting?.();
    cancelStarting = null;
    const previous = worker;
    worker = null;
    failAll(error);
    if (previous) void previous.terminate();
  }

  function startWorker() {
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    const { Worker } = require('node:worker_threads');
    /** @type {import('node:worker_threads').Worker} */
    let w;
    try {
      w = new Worker(pathToFileURL(workerFile), { resourceLimits: { ...resourceLimits } });
    } catch (error) {
      return Promise.reject(error);
    }
    starting = new Promise((resolve, reject) => {
      let ready = false;
      let stopped = false;
      const stop = (/** @type {Error} */ error) => {
        if (ready || stopped) return;
        stopped = true;
        clearTimeout(startup);
        starting = null;
        cancelStarting = null;
        void w.terminate();
        reject(error);
      };
      cancelStarting = () => stop(new Error('The DWG reader was closed during start-up.'));
      const startup = setTimeout(() => stop(new Error('The DWG reader did not start in time.')), START_TIMEOUT_MS);
      w.on('message', (msg) => {
        if (msg && msg.ready) {
          if (stopped || disposed) return;
          clearTimeout(startup);
          ready = true;
          worker = w;
          starting = null;
          cancelStarting = null;
          resolve(w);
          return;
        }
        if (worker !== w) return;
        const item = msg && pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.ok) item.resolve({ payload: msg.payload, version: msg.version });
        else item.reject(new Error(msg.message));
      });
      w.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        // ERR_WORKER_OUT_OF_MEMORY: over resourceLimits.
        if (/** @type {any} */ (err)?.code === 'ERR_WORKER_OUT_OF_MEMORY') error.message = 'The DWG reader ran out of its memory limit: the file is too large or damaged.';
        if (!ready) stop(error);
        else if (worker === w) terminate(error);
      });
      w.on('exit', () => {
        if (!ready) stop(new Error('The DWG reader stopped during start-up.'));
        else if (worker === w) {
          worker = null;
          failAll(new Error('The DWG reader stopped unexpectedly.'));
        }
      });
    });
    return starting;
  }

  return {
    /**
     * Parse DWG bytes. Resolves { payload, version }; rejects with OpenCancelledError after
     * cancel(id), or with a message when a limit is exceeded or the worker fails.
     * @param {Uint8Array} bytes
     * @param {number} [id]  caller's id for cancel(); one is made up when omitted
     */
    async read(bytes, id = nextId++) {
      if (disposed) throw new Error('The DWG reader was closed.');
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid DWG payload');
      if (bytes.byteLength > maxBytes) throw new Error(`The DWG file is larger than the supported ${Math.round(maxBytes / (1024 * 1024))} MB.`);
      if (active.has(id)) throw new Error('A DWG read already uses this request id.');
      active.add(id);
      try {
        /** @type {Promise<never>} */
        const cancellation = new Promise((_resolve, reject) => waiting.set(id, reject));
        const w = await Promise.race([startWorker(), cancellation]);
        waiting.delete(id);
        if (disposed) throw new Error('The DWG reader was closed.');
        const copy = new Uint8Array(bytes); // transferable copy; the caller keeps its buffer
        const limit = timeoutMs ?? readTimeoutFor(bytes.byteLength);
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => terminate(new Error(`Reading the DWG file took longer than ${Math.round(limit / 1000)} s and was stopped: the file is too large or damaged.`)), limit);
          pending.set(id, { resolve, reject, timer });
          try {
            w.postMessage({ id, bytes: copy.buffer, kind: 'dwg' }, [copy.buffer]);
          } catch (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      } finally {
        active.delete(id);
        waiting.delete(id);
      }
    },
    /** Cancel a read started with `id`. Returns whether it was running. */
    cancel(/** @type {number} */ id) {
      if (!active.has(id)) return false;
      const item = pending.get(id);
      if (!item) {
        // The worker is still starting: the read fails now.
        waiting.get(id)?.(new OpenCancelledError());
        return true;
      }
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(new OpenCancelledError());
      // Other reads share the worker; they fail and can be retried.
      terminate(new Error('The DWG reader stopped after another read was cancelled; try again.'));
      return true;
    },
    /** Stop the worker (application quit). */
    dispose() {
      disposed = true;
      terminate(new Error('The DWG reader was closed.'));
    },
    /** Reads always run in the worker (they can be cancelled). */
    get usesWorker() {
      return true;
    },
    newId: () => nextId++,
  };
}
function progressThreshold() {
  const value = Number(process.env.JCAD_OPEN_PROGRESS_BYTES);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PROGRESS_BYTES;
}

module.exports = { createDwgHost, OpenCancelledError, progressThreshold, readTimeoutFor, DEFAULT_PROGRESS_BYTES, WORKER_RESOURCE_LIMITS, START_TIMEOUT_MS };
