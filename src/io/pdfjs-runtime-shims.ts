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
 * spec algorithm when (and only when) it is missing.
 *
 * The algorithm (PR #42 cleanup 3) is NewPromiseCapability-shaped,
 * not `try { Promise.resolve(fn(...args)) } catch { reject }`: the
 * receiver is the promise constructor — a non-constructor receiver
 * throws TypeError BEFORE the callback runs; the callback is called
 * with the passed arguments; its result (value, promise or throw)
 * settles a FRESH capability promise of the receiver's class, never
 * the callback's own promise returned as-is, and subclass receivers
 * are honored. Installed with the spec property shape: writable,
 * non-enumerable, configurable.
 * Imported first by underlay-pdfjs.ts (main realm — also covers the
 * in-process fake worker) and by pdfjs-worker-entry.ts (worker realm).
 */
type PromiseTry = (fn: (...args: never[]) => unknown, ...args: never[]) => Promise<unknown>;

function promiseTry(this: unknown, fn: (...args: never[]) => unknown, ...args: never[]): Promise<unknown> {
  const Ctor = this as new (
    executor: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void,
  ) => Promise<unknown>;
  let resolveCapability: ((value: unknown) => void) | undefined;
  let rejectCapability: ((reason: unknown) => void) | undefined;
  // NewPromiseCapability, step 1: `new` on a non-constructor receiver
  // (plain object, arrow function, undefined) throws TypeError here,
  // before the callback is called.
  const capability = new Ctor((resolve, reject) => {
    resolveCapability = resolve;
    rejectCapability = reject;
  });
  // A "constructor" that never calls its executor produced no
  // capability — the spec rejects that with TypeError too.
  if (typeof resolveCapability !== 'function' || typeof rejectCapability !== 'function') {
    throw new TypeError('Promise.try: the receiver did not produce a promise capability');
  }
  try {
    resolveCapability(fn(...args));
  } catch (err) {
    rejectCapability(err);
  }
  return capability;
}

const ctor = Promise as unknown as { try?: PromiseTry };
if (typeof ctor.try !== 'function') {
  Object.defineProperty(Promise, 'try', {
    value: promiseTry,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export {};
