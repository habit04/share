/**
 * The Manifold kernel on the main thread: a `GeometryKernel` that forwards each Boolean to a
 * dedicated module Worker (manifold.worker.ts) and checks inputs and results here (kernel.ts).
 *
 * Why a worker: a worker script loaded from its own URL is governed by its own response's CSP,
 * not the renderer document's strict `default-src 'self'`, so WebAssembly compiles there without
 * relaxing the renderer CSP; a long Boolean never blocks the UI; a crash or out-of-memory abort
 * only kills the worker (docs/3D-PLAN.md, "Geometry kernel evaluation"; docs/3D-KERNEL.md).
 *
 * Behaviour:
 * - The worker is created lazily on the first `ready()` or `boolean()` call. Requests carry
 *   increasing ids; replies are matched by id, so concurrent calls resolve independently.
 * - Each call has a timeout (option `timeoutMs`, default 20 s). On timeout the call rejects, the
 *   worker (busy with the runaway operation, which cannot be cancelled) is terminated, every other
 *   pending call rejects too, and the next call starts a fresh worker.
 * - If the worker crashes after it reported `ready` (an `error` or `messageerror` event), every
 *   pending call rejects with a 'worker-crash' KernelError and the next call starts a new worker;
 *   after `maxRestarts` restarts (default 1) a further crash makes the kernel permanently
 *   unavailable for this session.
 * - Start-up failures are final: the worker script failing to load or erroring before `ready`,
 *   the WebAssembly module failing to start (`init-error`), or no `ready` within
 *   `startTimeoutMs` (default 20 s; the worker is then terminated). The kernel reports itself
 *   unavailable with the reason, every pending call rejects with 'unavailable', and it never
 *   retries in this session.
 */
import type { Mesh3D } from '../mesh';
import {
  type BooleanOp, type BooleanOptions, type GeometryKernel, type KernelStatus, KernelError, crashError, finishResult, invalidOperand, opName,
  packMesh, prepareOperands, timeoutError, unavailableError, unpackMesh,
} from './kernel';
import type { WorkerMessage, WorkerRequest } from './protocol';
import { MANIFOLD_VERSION } from './version';

/** The part of the DOM `Worker` the kernel uses (so tests can inject a fake). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface ManifoldWorkerKernelOptions {
  /** Worker factory; default: the bundled module worker. */
  readonly createWorker?: () => WorkerLike;
  /** Default per-call timeout in milliseconds (20 000). */
  readonly timeoutMs?: number;
  /** How many times a crashed worker is replaced before the kernel gives up (1). */
  readonly maxRestarts?: number;
  /** How long a new worker may take to report `ready` before the kernel gives up (20 000 ms). */
  readonly startTimeoutMs?: number;
}

/** Default per-call timeout (milliseconds). */
export const DEFAULT_KERNEL_TIMEOUT_MS = 20_000;

function defaultWorker(): WorkerLike {
  // Literal `new Worker(new URL(...), { type: 'module' })` so Vite bundles the worker as its own chunk.
  return new Worker(new URL('./manifold.worker.ts', import.meta.url), { type: 'module' });
}

interface Pending {
  readonly op: BooleanOp;
  readonly resolve: (mesh: Mesh3D) => void;
  readonly reject: (err: KernelError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ManifoldWorkerKernel implements GeometryKernel {
  readonly name = `Manifold ${MANIFOLD_VERSION} (worker)`;
  private readonly createWorker: () => WorkerLike;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private readonly startTimeoutMs: number;
  private worker: WorkerLike | null = null;
  private started: Promise<KernelStatus> | null = null;
  private settleStart: ((status: KernelStatus) => void) | null = null;
  /** True once the current worker has posted `ready`. */
  private workerReady = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private crashes = 0;
  /** Set when the kernel can no longer be used (init failure, repeated crashes, dispose). */
  private dead: { readonly code: 'unavailable' | 'disposed'; readonly reason: string } | null = null;
  /** Worker generations created so far (exposed for diagnostics and tests). */
  workersCreated = 0;

  constructor(opts: ManifoldWorkerKernelOptions = {}) {
    this.createWorker = opts.createWorker ?? defaultWorker;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts ?? 1;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
  }

  ready(): Promise<KernelStatus> {
    if (this.dead) return Promise.resolve({ available: false, reason: this.dead.reason });
    return this.ensureWorker() ?? Promise.resolve({ available: false, reason: this.deadReason() });
  }

  boolean(op: BooleanOp, a: Mesh3D, b: Mesh3D, opts: BooleanOptions = {}): Promise<Mesh3D> {
    if (this.dead) return Promise.reject(this.dead.code === 'disposed' ? disposedError() : unavailableError(this.dead.reason));
    try {
      prepareOperands(op, a, b);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this.ensureWorker() || !this.worker) return Promise.reject(unavailableError(this.deadReason()));
    const worker = this.worker;
    const id = this.nextId++;
    const pa = packMesh(a), pb = packMesh(b);
    const ms = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<Mesh3D>((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(id, ms), ms);
      this.pending.set(id, { op, resolve, reject, timer });
      try {
        worker.postMessage({ id, op, a: pa, b: pb }, [pa.positions.buffer, pa.indices.buffer, pb.positions.buffer, pb.indices.buffer]);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new KernelError('kernel-failure', `The ${opName(op)} could not be sent to the geometry kernel (${err instanceof Error ? err.message : String(err)}).`));
      }
    });
  }

  dispose(): void {
    if (this.dead?.code === 'disposed') return;
    this.dead = { code: 'disposed', reason: 'the geometry kernel was shut down' };
    this.stopWorker();
    this.rejectAll(disposedError());
  }

  /** Create the worker if there is none; returns its start-up promise, or null if it cannot run. */
  private ensureWorker(): Promise<KernelStatus> | null {
    if (this.dead) return null;
    if (this.worker && this.started) return this.started;
    let worker: WorkerLike;
    try {
      worker = this.createWorker();
    } catch (err) {
      this.dead = { code: 'unavailable', reason: `the geometry kernel worker could not be created (${err instanceof Error ? err.message : String(err)})` };
      return null;
    }
    this.workersCreated++;
    this.worker = worker;
    this.workerReady = false;
    this.started = new Promise((resolve) => { this.settleStart = resolve; });
    this.startTimer = setTimeout(() => {
      if (this.worker === worker && !this.workerReady) this.failStart(`the geometry kernel did not start within ${this.startTimeoutMs / 1000} s`);
    }, this.startTimeoutMs);
    worker.onmessage = (event) => { if (this.worker === worker) this.onMessage(event.data); };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.onWorkerError(event.message || undefined);
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.onWorkerError('a message from the worker could not be read');
    };
    return this.started;
  }

  /** Why the kernel cannot run (read after a call that may have set `dead`). */
  private deadReason(): string {
    return this.dead?.reason ?? 'the geometry kernel could not start';
  }

  private onMessage(msg: WorkerMessage): void {
    if ('type' in msg) {
      if (msg.type === 'ready') {
        this.workerReady = true;
        this.clearStartTimer();
        this.settleStart?.({ available: true, version: msg.version });
        this.settleStart = null;
      } else {
        this.failStart(`the WebAssembly kernel failed to start (${msg.message})`);
      }
      return;
    }
    const call = this.pending.get(msg.id);
    if (!call) return; // timed out or rejected already
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.ok) {
      try {
        call.resolve(finishResult(call.op, unpackMesh(msg)));
      } catch (err) {
        call.reject(err instanceof KernelError ? err : new KernelError('kernel-failure', String(err)));
      }
    } else if (msg.operand) {
      call.reject(invalidOperand(call.op, msg.operand, `the geometry kernel refused it (${msg.error})`));
    } else {
      call.reject(new KernelError('kernel-failure', `The ${opName(call.op)} failed in the geometry kernel (${msg.error}).`));
    }
  }

  private onTimeout(id: number, ms: number): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    call.reject(timeoutError(call.op, ms));
    // The worker is still busy with the runaway operation; replace it.
    this.stopWorker();
    this.rejectAll(new KernelError('timeout', 'The geometry kernel was restarted after an earlier operation timed out; this operation was not applied.'));
  }

  /** A worker error: a start-up failure before `ready` (final), a crash after it (restartable). */
  private onWorkerError(detail?: string): void {
    if (!this.workerReady) {
      this.failStart(`the geometry kernel worker failed to load or start${detail ? ` (${detail})` : ''}`);
      return;
    }
    this.crashes++;
    this.stopWorker();
    if (this.crashes > this.maxRestarts) this.dead = { code: 'unavailable', reason: 'the geometry kernel crashed repeatedly in this session' };
    this.rejectAll(crashError(detail));
  }

  /** Give up for this session: terminate the worker and reject everything as unavailable. */
  private failStart(reason: string): void {
    this.dead = { code: 'unavailable', reason };
    this.stopWorker();
    this.rejectAll(unavailableError(reason));
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private stopWorker(): void {
    this.clearStartTimer();
    const w = this.worker;
    this.worker = null;
    this.started = null;
    this.settleStart?.({ available: false, reason: this.dead?.reason ?? 'the geometry kernel stopped' });
    this.settleStart = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      try { w.terminate(); } catch { /* already gone */ }
    }
  }

  private rejectAll(err: KernelError): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) {
      clearTimeout(c.timer);
      c.reject(err);
    }
  }
}

function disposedError(): KernelError {
  return new KernelError('disposed', 'The geometry kernel was shut down; the operation was not applied.');
}
