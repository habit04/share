/**
 * DWG parsing in a cancellable worker with bounded input, heap and processing time.
 * Worker startup failure is reported; parsing never falls back onto the main event loop.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MAX_DRAWING_BYTES } = require('./resource-limits.cjs');
const DEFAULT_PROGRESS_BYTES = 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
class OpenCancelledError extends Error {
  constructor() { super('Open cancelled'); this.name = 'OpenCancelledError'; this.cancelled = true; }
}
/** @param {{ scriptsDir: string, timeoutMs?: number, maxBytes?: number }} opts */
function createDwgHost({ scriptsDir, timeoutMs = DEFAULT_READ_TIMEOUT_MS, maxBytes = MAX_DRAWING_BYTES }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid DWG resource limits');
  const workerFile = path.join(scriptsDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), 'dwg-worker.mjs');
  /** @type {import('node:worker_threads').Worker | null} */
  let worker = null;
  /** @type {Promise<import('node:worker_threads').Worker> | null} */
  let starting = null;
  /** @type {(() => void) | null} */
  let cancelStarting = null;
  let disposed = false;
  /** @type {Map<number, (error: Error) => void>} */
  const waiting = new Map();
  let nextId = 1;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  const active = new Set();

  const failAll = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  function terminate(error) {
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
    let w;
    try { w = new Worker(pathToFileURL(workerFile), { resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } }); }
    catch (error) { return Promise.reject(error); }
    starting = new Promise((resolve, reject) => {
      let ready = false;
      let stopped = false;
      cancelStarting = () => {
        if (ready || stopped) return;
        stopped = true; clearTimeout(startup); starting = null;
        void w.terminate(); reject(new Error('The DWG reader was closed during start-up.'));
      };
      const startup = setTimeout(() => {
        if (stopped) return;
        stopped = true; starting = null; cancelStarting = null;
        void w.terminate();
        reject(new Error('The DWG reader did not start before its time limit.'));
      }, Math.min(timeoutMs, 15_000));
      w.on('message', (msg) => {
        if (msg && msg.ready) {
          if (stopped || disposed) return;
          clearTimeout(startup); ready = true; worker = w; starting = null; cancelStarting = null; resolve(w); return;
        }
        if (worker !== w) return;
        const item = msg && pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id); clearTimeout(item.timer);
        if (msg.ok) item.resolve({ payload: msg.payload, version: msg.version });
        else item.reject(new Error(msg.message));
      });
      w.on('error', (err) => {
        clearTimeout(startup);
        if (!ready && !stopped) { stopped = true; starting = null; cancelStarting = null; void w.terminate(); reject(err); }
        else if (worker === w) terminate(err);
      });
      w.on('exit', () => {
        clearTimeout(startup);
        if (!ready && !stopped) { stopped = true; starting = null; cancelStarting = null; reject(new Error('DWG worker exited during start-up')); }
        else if (worker === w) { worker = null; failAll(new Error('The DWG reader stopped unexpectedly.')); }
      });
    });
    return starting;
  }
  return {
    /** @param {Uint8Array} bytes @param {number} [id] */
    async read(bytes, id = nextId++) {
      if (disposed) throw new Error('The DWG reader was closed.');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw new Error('DWG exceeds the supported size limit.');
      if (active.has(id)) throw new Error('A DWG read already uses this request ID.');
      active.add(id);
      try {
        /** @type {Promise<never>} */
        const cancellation = new Promise((_, reject) => waiting.set(id, reject));
        const w = await Promise.race([startWorker(), cancellation]);
        waiting.delete(id);
        if (disposed) throw new Error('The DWG reader was closed.');
        const copy = new Uint8Array(bytes);
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => terminate(new Error('DWG parsing exceeded its time limit.')), timeoutMs);
          pending.set(id, {resolve, reject, timer});
          try { w.postMessage({id, bytes:copy.buffer, kind:'dwg'}, [copy.buffer]); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      } finally { active.delete(id); waiting.delete(id); }
    },
    cancel(id) {
      if (!active.has(id)) return false;
      const item = pending.get(id);
      if (!item) { waiting.get(id)?.(new OpenCancelledError()); return true; }
      pending.delete(id); clearTimeout(item.timer); item.reject(new OpenCancelledError());
      terminate(new Error('The DWG reader stopped after another read was cancelled; try again.'));
      return true;
    },
    dispose() { disposed = true; terminate(new Error('The DWG reader was closed.')); },
    get usesWorker() { return true; },
    newId: () => nextId++,
  };
}
function progressThreshold() {
  const value = Number(process.env.JCAD_OPEN_PROGRESS_BYTES);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PROGRESS_BYTES;
}
module.exports = { createDwgHost, OpenCancelledError, progressThreshold, DEFAULT_PROGRESS_BYTES, DEFAULT_READ_TIMEOUT_MS };
