// Test fixture (P28): a message-gated worker for the pdfjs adapter's
// createWorker path. Each gated worker runs the REAL pinned pdfjs
// worker entry in a REAL worker_threads thread (via
// fixtures/pdfjs-worker-bootstrap.mjs) and forwards the adapter's
// messages to it — except messages whose action the test has gated:
// a gated message is swallowed, so the worker NEVER replies to it.
// That makes a stalled open / pageSize / getPage / render deterministic
// on any machine: no CPU speed can make a swallowed message answer.
//
// The surface implemented is exactly what pdfjs's MessageHandler and
// the adapter use on a worker port: addEventListener('message'),
// removeEventListener, postMessage, terminate. pdfjs validates
// workerPort with `instanceof Worker` when a global Worker exists;
// under Node there is none, so a minimal base class is installed and
// the gated worker extends it (test-only scaffolding).
import { Worker as ThreadsWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP_URL = new URL('./fixtures/pdfjs-worker-bootstrap.mjs', import.meta.url);
const PDFJS_WORKER_PATH = fileURLToPath(new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url));

const globals = globalThis as Record<string, unknown>;
const WorkerBase = (globals.Worker as typeof Worker | undefined) ?? class {};
if (!globals.Worker) globals.Worker = WorkerBase;

export class GatedWorker extends WorkerBase {
  /** How many times terminate() was called on this worker. */
  terminations = 0;
  readonly #inner: ThreadsWorker;
  readonly #listeners = new Map<unknown, (value: unknown) => void>();
  readonly #sent = new Map<string, number>();
  readonly #allow = new Map<string, number>();

  constructor() {
    super();
    this.#inner = new ThreadsWorker(fileURLToPath(BOOTSTRAP_URL), { workerData: { pdfjsWorkerSrc: PDFJS_WORKER_PATH } });
    // A gated (terminated-mid-flight) thread must never crash the test
    // process with an unhandled 'error' event; stalls surface as
    // deadline refusals, which is what the tests assert.
    this.#inner.on('error', () => undefined);
  }

  /** Swallow every message with this action: the worker never replies to it. */
  drop(action: string): void { this.#allow.set(action, 0); }

  /** Let the first `allow` messages with this action through; swallow the rest. */
  dropAfter(action: string, allow: number): void { this.#allow.set(action, allow); }

  /** How many messages with this action the adapter has sent (gated or not). */
  sentCount(action: string): number { return this.#sent.get(action) ?? 0; }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type !== 'message') return;
    const handler = (value: unknown): void => listener({ data: value });
    this.#listeners.set(listener, handler);
    this.#inner.on('message', handler);
  }

  removeEventListener(type: string, listener: unknown): void {
    if (type !== 'message') return;
    const handler = this.#listeners.get(listener);
    if (handler) {
      this.#inner.off('message', handler);
      this.#listeners.delete(listener);
    }
  }

  postMessage(message: { action?: string }): void {
    const action = message?.action;
    if (typeof action === 'string') {
      const seen = (this.#sent.get(action) ?? 0) + 1;
      this.#sent.set(action, seen);
      const allow = this.#allow.get(action);
      if (allow !== undefined && seen > allow) return; // swallowed: no reply, ever
    }
    this.#inner.postMessage(message);
  }

  terminate(): Promise<number> {
    this.terminations += 1;
    return this.#inner.terminate();
  }
}

/**
 * A createWorker factory for createPdfjsEngine: hands out gated
 * workers in order, letting `configure` arm each one's gates before
 * the adapter sees it. `workers` accumulates every worker created, so
 * a test can assert per-session termination counts and prove that a
 * recovery really used a FRESH worker.
 */
export function gatedWorkerFactory(configure?: (worker: GatedWorker, index: number) => void): {
  createWorker: () => Worker;
  workers: GatedWorker[];
} {
  const workers: GatedWorker[] = [];
  return {
    workers,
    createWorker: () => {
      const worker = new GatedWorker();
      configure?.(worker, workers.length);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  };
}
