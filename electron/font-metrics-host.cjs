const path = require('node:path');
const { Worker } = require('node:worker_threads');

/** Only bounded font descriptors, never a renderer-supplied path or file buffer. */
function fontRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid font metric request.');
  if (typeof value.font !== 'string' || value.font.length > 256 || /[\u0000-\u001f]/.test(value.font)) throw new Error('Invalid font name.');
  if (value.family !== undefined && (typeof value.family !== 'string' || value.family.length > 256 || /[\u0000-\u001f]/.test(value.family))) throw new Error('Invalid font family.');
  for (const key of ['bold', 'italic']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid font face.');
  return { font: value.font, ...(value.family !== undefined ? { family: value.family } : {}),
    ...(value.bold !== undefined ? { bold: value.bold } : {}), ...(value.italic !== undefined ? { italic: value.italic } : {}) };
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
    async dispose() {
      disposed = true;
      for (const item of queue.splice(0)) item.reject(new Error('Font metric reader is closed.'));
      await Promise.all([...workers].map(async (worker) => {
        const exited = new Promise((resolve) => worker.once('exit', resolve));
        try { await worker.terminate(); }
        catch { await exited; }
      }));
    },
  };
}
module.exports = { createFontMetricsHost, fontRequest };
