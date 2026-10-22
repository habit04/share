// Test fixture (P28): run the pinned pdfjs-dist worker entry inside a
// REAL Node worker_threads thread, so tests can interpose on the
// message channel between the adapter and the worker (see
// tests/pdfjs-gated-worker.ts). The pinned entry only auto-attaches
// its handler in a non-Node worker global scope; under Node it instead
// exports WorkerMessageHandler, so this bootstrap bridges
// worker_threads' parentPort to a port object and initializes the
// handler from it — the same entry point pdfjs's own fake worker
// uses. Test-only: production code never sees this file.
import { parentPort, workerData } from 'node:worker_threads';

// The worker code uses the same recent Uint8Array/Map methods the
// main-side test shim patches in (tests/pdfjs-node-shims.ts); a real
// thread starts from bare prototypes, so patch them here too.
const U8 = Uint8Array.prototype;
if (!U8.toHex) {
  U8.toHex = function () { return [...this].map((b) => b.toString(16).padStart(2, '0')).join(''); };
  U8.fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  U8.toBase64 = function () { return Buffer.from(this).toString('base64'); };
  U8.fromBase64 = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
}
const Mp = Map.prototype;
if (!Mp.getOrInsert) {
  Mp.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  Mp.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
}
const WMp = WeakMap.prototype;
if (!WMp.getOrInsert) {
  WMp.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  WMp.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
}

// Promise.try (ES2025): present in browser workers and Node 24,
// absent in Node 22 — the production adapter installs the same
// polyfill in its realms (src/io/pdfjs-runtime-shims.ts); this thread
// mirrors a browser worker, so it gets it too.
if (typeof Promise.try !== 'function') {
  Promise.try = (fn, ...args) => {
    try { return Promise.resolve(fn(...args)); } catch (err) { return Promise.reject(err); }
  };
}

const listeners = new Set();
const port = {
  addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
  removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
  postMessage(message) { parentPort.postMessage(message); },
};
parentPort.on('message', (data) => {
  for (const listener of [...listeners]) listener({ data });
});

const { WorkerMessageHandler } = await import(workerData.pdfjsWorkerSrc);
WorkerMessageHandler.initializeFromPort(port);
