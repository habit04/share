const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { shapeFields } = require('./shaping/shape-font.cjs');

/** Matches the captured-PDF per-face CID cap in src/io/pdf-fonts.ts. */
const MAX_USED_CODEPOINTS = 65534;

/** Only bounded font descriptors, never a renderer-supplied path or file buffer. */
function fontRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid font metric request.');
  if (typeof value.font !== 'string' || value.font.length > 256 || /[\u0000-\u001f]/.test(value.font)) throw new Error('Invalid font name.');
  if (value.family !== undefined && (typeof value.family !== 'string' || value.family.length > 256 || /[\u0000-\u001f]/.test(value.family))) throw new Error('Invalid font family.');
  for (const key of ['bold', 'italic']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid font face.');
  if (value.restricted !== undefined && typeof value.restricted !== 'boolean') throw new Error('Invalid font face.');
  if (value.usedCodepoints !== undefined && (!Array.isArray(value.usedCodepoints) || value.usedCodepoints.length > MAX_USED_CODEPOINTS
    || Array.from(value.usedCodepoints).some((code) => !Number.isInteger(code) || code < 0 || code > 0x10ffff))) throw new Error('Invalid used codepoints.');
  // Deduplicated and sorted host-side so the pending-request key distinguishes used sets exactly.
  const usedCodepoints = value.usedCodepoints === undefined ? undefined : [...new Set(value.usedCodepoints)].sort((a, b) => a - b);
  return { font: value.font, ...(value.family !== undefined ? { family: value.family } : {}),
    ...(value.bold !== undefined ? { bold: value.bold } : {}), ...(value.italic !== undefined ? { italic: value.italic } : {}),
    ...(usedCodepoints !== undefined ? { usedCodepoints } : {}), ...(value.restricted ? { restricted: true } : {}) };
}

/** Descriptor identity for host admissions, independent of plot mode and glyph seeds. */
function fontRecordKey(request) {
  return JSON.stringify({ font: request.font, ...(request.family !== undefined ? { family: request.family } : {}),
    ...(request.bold !== undefined ? { bold: request.bold } : {}), ...(request.italic !== undefined ? { italic: request.italic } : {}) });
}

/** Parsing runs outside Electron's main thread, with two workers and bounded waiters. */
function createFontMetricsHost({ workerFactory = (request) => new Worker(path.join(__dirname, 'font-metrics-worker.cjs'), {
  workerData: request, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
}), timeoutMs = 10_000 } = {}) {
  /** @type {Array<{request: ReturnType<typeof fontRequest>, resolve: (metrics:any)=>void, reject:(error:Error)=>void}>} */
  const queue = [];
  /** @type {Set<import('node:worker_threads').Worker>} */
  const workers = new Set();
  /** @type {Map<string, Promise<any>>} */
  const pending = new Map();
  // These records prove a host read occurred, not that a renderer discarded its bytes.
  /** @type {Map<string, number>} */
  const previewPrintRecords = new Map();
  const RECORD_TTL_MS = 30 * 60 * 1000, RECORD_MAX = 256;
  function recordPreviewPrint(request) {
    const nowMs = Date.now();
    for (const [key, at] of previewPrintRecords) if (nowMs - at > RECORD_TTL_MS) previewPrintRecords.delete(key);
    previewPrintRecords.set(fontRecordKey(request), nowMs);
    while (previewPrintRecords.size > RECORD_MAX) {
      const oldest = previewPrintRecords.keys().next().value;
      if (oldest === undefined) break;
      previewPrintRecords.delete(oldest);
    }
  }
  let disposed = false;
  function pump() {
    while (!disposed && workers.size < 2 && queue.length) {
      const item = queue.shift();
      if (!item) break;
      let worker;
      try { worker = workerFactory(item.request); }
      catch (error) { item.reject(error); continue; }
      workers.add(worker);
      let settled = false;
      let exited = false;
      let released = false;
      const release = () => { if (!released) { released = true; workers.delete(worker); pump(); } };
      const finish = async (error, metrics) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        let stopError = null;
        try { await worker.terminate(); release(); }
        catch { if (exited) release(); else stopError = new Error('Font metric worker termination could not be confirmed.'); }
        if (error || stopError || disposed) item.reject(error ?? stopError ?? new Error('Font metric reader is closed.')); else item.resolve(metrics);
      };
      const timer = setTimeout(() => { void finish(new Error('Font metric parsing timed out.'), null); }, timeoutMs);
      worker.once('message', (message) => { void finish(message?.error ? new Error(String(message.error)) : null, message?.metrics ?? null); });
      worker.once('error', (error) => { void finish(error, null); });
      worker.once('exit', () => { exited = true; if (settled) release(); else void finish(new Error('Font metric worker exited before returning metrics.'), null); });
    }
  }
  function read(value, pdf = false) {
      /** @type {ReturnType<typeof fontRequest> & {usage?: string}} */
      let request;
      try { request = fontRequest(value); } catch (error) { return Promise.reject(error); }
      if (pdf) request = { ...request, usage: 'pdf' };
      // Used sets belong to captured-PDF reads only; screen metrics requests keep
      // the eager whole-face behaviour even if a caller supplies one.
      else delete request.usedCodepoints;
      if (disposed) return Promise.reject(new Error('Font metric reader is closed.'));
      const key = JSON.stringify(request), existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= 32) return Promise.reject(new Error('Too many pending font metric requests.'));
      const promise = new Promise((resolve, reject) => { queue.push({ request, resolve, reject }); });
      pending.set(key, promise);
      void promise.finally(() => { pending.delete(key); }).catch(() => {});
      if (pdf && request.restricted === true) {
        void promise.then((result) => {
          if (result && typeof result === 'object' && result.previewPrint === true) recordPreviewPrint(request);
        }).catch(() => {});
      }
      pump(); return promise;
  }
  /** Shaping mode (contract v4 §9.1): the descriptor is validated by
      fontRequest and the shape block by the worker module's own
      validator, so host and worker apply one definition. The usage
      stamp is host-side, exactly like pdf mode; a renderer-supplied
      usage never reaches a worker. The job rides the same queue,
      worker cap, pending cap, timeout, and terminate-after-first-
      message discipline as every other mode. */
  function readShape(value) {
      /** @type {ReturnType<typeof fontRequest> & {usage: string, shape: ReturnType<typeof shapeFields>}} */
      let request;
      try { request = { ...fontRequest(value), usage: 'shape', shape: shapeFields(value) }; }
      catch (error) { return Promise.reject(error); }
      if (disposed) return Promise.reject(new Error('Font metric reader is closed.'));
      const key = JSON.stringify(request), existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= 32) return Promise.reject(new Error('Too many pending font metric requests.'));
      const promise = new Promise((resolve, reject) => { queue.push({ request, resolve, reject }); });
      pending.set(key, promise);
      void promise.finally(() => { pending.delete(key); }).catch(() => {});
      pump(); return promise;
  }
  return {
    read: (value) => read(value),
    readPdf: (value) => read(value, true),
    readShape: (value) => readShape(value),
    admittedPreviewPrint(value) {
      let request;
      try { request = fontRequest(value); } catch { return false; }
      const at = previewPrintRecords.get(fontRecordKey(request));
      return at !== undefined && Date.now() - at <= RECORD_TTL_MS;
    },
    async dispose() {
      disposed = true;
      previewPrintRecords.clear();
      for (const item of queue.splice(0)) item.reject(new Error('Font metric reader is closed.'));
      await Promise.all([...workers].map(async (worker) => {
        const exited = new Promise((resolve) => worker.once('exit', resolve));
        try { await worker.terminate(); }
        catch { await exited; }
      }));
    },
  };
}
module.exports = { createFontMetricsHost, fontRequest, fontRecordKey };
