/**
 * DWG reading for the main process, off its event loop.
 *
 * LibreDWG runs in a worker thread (scripts/dwg-worker.mjs). While it parses, the main process
 * keeps answering IPC, menus and window events, and the read can be cancelled: `cancel(id)`
 * terminates the worker (a fresh one starts for the next file). If a worker cannot be started at
 * all (an unusual packaging layout), the reader module is imported in the main process instead,
 * exactly as before; that path cannot be cancelled.
 *
 * Reads larger than the progress threshold are announced to the renderer, which shows a
 * progress dialog with a Cancel button (src/ui/open-progress.ts).
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Files at least this large get the progress dialog (JCAD_OPEN_PROGRESS_BYTES overrides it). */
const DEFAULT_PROGRESS_BYTES = 1024 * 1024;

class OpenCancelledError extends Error {
  constructor() {
    super('Open cancelled');
    this.name = 'OpenCancelledError';
    this.cancelled = true;
  }
}

/**
 * @param {{ scriptsDir: string }} opts  folder holding dwg-reader.mjs and dwg-worker.mjs (unpacked from the asar)
 */
function createDwgHost({ scriptsDir }) {
  const unpacked = scriptsDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const workerFile = path.join(unpacked, 'dwg-worker.mjs');
  const readerFile = path.join(unpacked, 'dwg-reader.mjs');
  /** @type {import('node:worker_threads').Worker | null} */
  let worker = null;
  /** @type {Promise<import('node:worker_threads').Worker> | null} */
  let starting = null;
  let workersUnavailable = false;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** @type {Promise<any> | null} */
  let inProcess = null;

  const failAll = (/** @type {Error} */ err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  function startWorker() {
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    const { Worker } = require('node:worker_threads');
    starting = new Promise((resolve, reject) => {
      let ready = false;
      /** @type {import('node:worker_threads').Worker} */
      let w;
      try {
        w = new Worker(pathToFileURL(workerFile));
      } catch (err) {
        starting = null;
        reject(err);
        return;
      }
      w.on('message', (msg) => {
        if (msg && msg.ready) {
          ready = true;
          worker = w;
          starting = null;
          resolve(w);
          return;
        }
        const p = msg && pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve({ payload: msg.payload, version: msg.version });
        else p.reject(new Error(msg.message));
      });
      w.on('error', (err) => {
        if (!ready) {
          starting = null;
          reject(err);
        } else failAll(err instanceof Error ? err : new Error(String(err)));
      });
      w.on('exit', () => {
        if (worker === w) worker = null;
        if (!ready) {
          starting = null;
          reject(new Error('DWG worker exited during start-up'));
        }
        failAll(new Error('The DWG reader stopped unexpectedly.'));
      });
    });
    return starting;
  }

  /** The reader in the main process (fallback when worker threads are unavailable). */
  async function readInProcess(/** @type {Uint8Array} */ bytes) {
    if (!inProcess) inProcess = import(pathToFileURL(readerFile).href);
    const mod = await inProcess;
    try {
      return await mod.readDwgPayload(bytes, 'dwg');
    } catch (err) {
      inProcess = null;
      mod.resetLibreDwg?.();
      throw err;
    }
  }

  let nextId = 1;
  /** Ids of reads that have started (the worker may still be starting up). */
  const active = new Set();
  /** Reads cancelled while their worker was still starting: they fail as soon as it is ready. */
  const cancelledEarly = new Set();
  return {
    /**
     * Parse DWG bytes. Resolves { payload, version }; rejects with OpenCancelledError after cancel(id).
     * @param {Uint8Array} bytes
     * @param {number} [id]  caller's id for cancel(); one is made up when omitted
     */
    async read(bytes, id = nextId++) {
      active.add(id);
      try {
        if (!workersUnavailable) {
          let w;
          try {
            w = await startWorker();
          } catch (err) {
            workersUnavailable = true;
            console.warn(`JCad: DWG worker unavailable, reading in the main process (${(err && err.message) || err})`);
          }
          if (cancelledEarly.delete(id)) throw new OpenCancelledError();
          if (w) {
            const copy = new Uint8Array(bytes); // transferable copy; the caller keeps its buffer
            return await new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              w.postMessage({ id, bytes: copy.buffer, kind: 'dwg' }, [copy.buffer]);
            });
          }
        }
        return await readInProcess(bytes);
      } finally {
        active.delete(id);
        cancelledEarly.delete(id);
      }
    },
    /** Cancel a read started with `id`. Returns whether it was running. */
    cancel(/** @type {number} */ id) {
      const p = pending.get(id);
      if (!p) {
        // Not posted yet (the worker is still starting): the read fails once the worker is ready.
        if (!active.has(id)) return false;
        cancelledEarly.add(id);
        return true;
      }
      pending.delete(id);
      p.reject(new OpenCancelledError());
      // Other reads share the worker; they fail with "stopped unexpectedly" and can be retried.
      const w = worker;
      worker = null;
      if (w) void w.terminate();
      return true;
    },
    /** Stop the worker (application quit). */
    dispose() {
      const w = worker;
      worker = null;
      if (w) void w.terminate();
    },
    get usesWorker() {
      return !workersUnavailable;
    },
    newId: () => nextId++,
  };
}

/** Progress threshold in bytes. */
function progressThreshold() {
  const v = Number(process.env.JCAD_OPEN_PROGRESS_BYTES);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PROGRESS_BYTES;
}

module.exports = { createDwgHost, OpenCancelledError, progressThreshold, DEFAULT_PROGRESS_BYTES };
