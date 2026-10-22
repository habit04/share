/**
 * Runtime prerequisites of the pinned pdfjs-dist build (6.4.299),
 * installed before any pdfjs code executes in this realm.
 *
 * Node 22 defect (PR #42, lead ruling 2026-10-22): pdfjs's worker-side
 * message dispatch calls `Promise.try(action, data)` for EVERY worker
 * action (4 sites in pdf.worker), and its main thread does the same
 * for callbacks. `Promise.try` (ES2025) ships in Node 24 and current
 * browsers, but NOT in Node 22.23.3 — `typeof Promise.try` is
 * "undefined" there, in the main thread and in worker threads alike.
 * Under Node 22 the dispatch therefore throws before any callback is
 * posted and every open/pageSize/render hangs forever. pdfjs does not
 * require a newer Node; it requires this one method, so install the
 * spec-shaped polyfill when (and only when) it is missing:
 *   Promise.try(fn, ...args) === try { Promise.resolve(fn(...args)) }
 *                                catch (e) { Promise.reject(e) }
 * Imported first by underlay-pdfjs.ts (main realm — also covers the
 * in-process fake worker) and by pdfjs-worker-entry.ts (worker realm).
 */
type PromiseTry = (fn: (...args: never[]) => unknown, ...args: never[]) => Promise<unknown>;

const ctor = Promise as unknown as { try?: PromiseTry };
if (typeof ctor.try !== 'function') {
  ctor.try = (fn, ...args) => {
    try {
      return Promise.resolve(fn(...args));
    } catch (err) {
      return Promise.reject(err);
    }
  };
}

export {};
