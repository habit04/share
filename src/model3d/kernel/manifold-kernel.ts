/**
 * The Manifold kernel on the main thread: a `GeometryKernel` that forwards each Boolean to a
 * dedicated module Worker (manifold.worker.ts) and checks inputs and results here (kernel.ts).
 *
 * Why a worker: a worker script loaded from its own URL is governed by its own response's CSP
 * (the Electron protocol handler sends a restrictive one, electron/renderer-origin.cjs WORKER_CSP),
 * not the renderer document's strict `default-src 'self'`, so WebAssembly compiles there without
 * relaxing the renderer CSP; a long Boolean never blocks the UI. A worker is a thread of the
 * renderer process, not a separate process: it is not memory or crash isolation. What bounds the
 * kernel is its hard 1 GiB WebAssembly memory limit (memory-guard.ts), the per-call timeout and the
 * restart policy below; an exception or abort inside the module surfaces as a KernelError, but a
 * failure that takes down the renderer process takes the editor with it (docs/3D-KERNEL.md,
 * docs/SECURITY-REVIEW.md E-19 / E-20).
 *
 * Behaviour:
 * - The worker is created lazily on the first `ready()` or `boolean()` call. Requests carry
 *   increasing ids; replies are matched by id, so concurrent calls resolve independently.
 * - Requests are posted only after the worker has reported `ready`; calls made earlier wait in a
 *   queue. So a worker that fails before `ready` can never have answered a request, and every
 *   call made before or after the failure rejects with the start-up reason, whatever order the
 *   worker's events and the caller's timers run in. A result message that arrives while the
 *   worker is not ready is a protocol violation and is ignored.
 * - Each call has a timeout (option `timeoutMs`, default 20 s), counted from when its request is
 *   posted to a ready worker (waiting for start-up is bounded by `startTimeoutMs`). On timeout the call rejects, the
 *   worker (busy with the runaway operation, which cannot be cancelled) is terminated, every other
 *   pending call rejects too, and the next call starts a fresh worker.
 * - If the worker crashes after it reported `ready` (an `error` or `messageerror` event), every
 *   pending call rejects with a 'worker-crash' KernelError and the next call starts a new worker;
 *   after `maxRestarts` restarts (default 1) a further crash makes the kernel permanently
 *   unavailable for this session.
 * - If the worker reports that the memory limit stopped an operation (`memoryLimit`), the call
 *   rejects with a 'memory-limit' KernelError, the worker is terminated (the module may be
 *   inconsistent after a failed allocation), every other pending call rejects too, and the next
 *   call starts a fresh worker, exactly like a timeout (not counted as a crash).
 * - Start-up failures are final: the worker script failing to load or erroring before `ready`,
 *   the WebAssembly module failing to start (`init-error`), or no `ready` within
 *   `startTimeoutMs` (default 20 s; the worker is then terminated). The kernel reports itself
 *   unavailable with the reason, every pending call rejects with 'unavailable', and it never
 *   retries in this session.
 */
import type { Mesh3D } from '../mesh';
import {
  type BooleanOp, type BooleanOptions, type GeometryKernel, type KernelStatus, KernelError, crashError, finishResult, invalidOperand,
  memoryLimitError, opName, packMesh, prepareOperands, timeoutError, unavailableError, unpackMesh,
} from './kernel';
import type { ProbeResult, WorkerMessage, WorkerRequest } from './protocol';
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
  /**
   * Enable the worker's test probes (`probe()`; protocol.ts `WorkerProbeRequest`): the default
   * worker is then created with the Worker name KERNEL_TEST_HOOKS_WORKER_NAME, which the worker
   * reads once at start. Off by default; experimental-3d.ts turns it on only when the page was
   * loaded with `?jcad3dTestHooks=1` (decided once at install; scripts/e2e-3d-security.mjs).
   */
  readonly testHooks?: boolean;
}

/** A probe request without its id (`ManifoldWorkerKernel.probe`). */
export type KernelProbe = { readonly op: 'probe-memory'; readonly pages: number } | { readonly op: 'probe-csp' };

/** Default per-call timeout (milliseconds). */
export const DEFAULT_KERNEL_TIMEOUT_MS = 20_000;

function defaultWorker(testHooks: boolean): WorkerLike {
  // Literal `new Worker(new URL(...), { ...static options })` so Vite bundles the worker as its own
  // chunk (both branches are the same chunk). The name must equal KERNEL_TEST_HOOKS_WORKER_NAME
  // (tests/model3d-memory-limit.test.ts checks it).
  return testHooks
    ? new Worker(new URL('./manifold.worker.ts', import.meta.url), { type: 'module', name: 'jcad-kernel-test-hooks' })
    : new Worker(new URL('./manifold.worker.ts', import.meta.url), { type: 'module' });
}

interface Pending {
  /** The Boolean, or null for a test probe. */
  readonly op: BooleanOp | null;
  readonly resolve: (value: Mesh3D | ProbeResult) => void;
  readonly reject: (err: KernelError) => void;
  /** The call's timeout in milliseconds; its timer runs from the moment the request is posted. */
  readonly ms: number;
  /** Null while the request waits in the queue for the worker's `ready`. */
  timer: ReturnType<typeof setTimeout> | null;
}

function clearCallTimer(call: Pending): void {
  if (call.timer !== null) clearTimeout(call.timer);
  call.timer = null;
}

export class ManifoldWorkerKernel implements GeometryKernel {
  readonly name = `Manifold ${MANIFOLD_VERSION} (worker)`;
  private readonly createWorker: () => WorkerLike;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private readonly startTimeoutMs: number;
  private readonly testHooks: boolean;
  private worker: WorkerLike | null = null;
  private started: Promise<KernelStatus> | null = null;
  private settleStart: ((status: KernelStatus) => void) | null = null;
  /** True once the current worker has posted `ready`. */
  private workerReady = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  /** Requests made before the current worker reported `ready`, posted (in order) when it does. */
  private queued: WorkerRequest[] = [];
  private nextId = 1;
  private crashes = 0;
  /** Set when the kernel can no longer be used (init failure, repeated crashes, dispose). */
  private dead: { readonly code: 'unavailable' | 'disposed'; readonly reason: string } | null = null;
  /** Worker generations created so far (exposed for diagnostics and tests). */
  workersCreated = 0;

  constructor(opts: ManifoldWorkerKernelOptions = {}) {
    const testHooks = opts.testHooks === true;
    this.createWorker = opts.createWorker ?? (() => defaultWorker(testHooks));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts ?? 1;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
    this.testHooks = testHooks;
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
    const id = this.nextId++;
    const pa = packMesh(a), pb = packMesh(b);
    const ms = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<Mesh3D>((resolve, reject) => {
      this.pending.set(id, { op, resolve: resolve as (value: Mesh3D | ProbeResult) => void, reject, ms, timer: null });
      this.enqueue({ id, op, a: pa, b: pb });
    });
  }

  /**
   * Run a test probe in the worker (only with `testHooks: true`; otherwise rejects as
   * unavailable without contacting the worker). A probe that reaches the memory limit rejects with
   * the same 'memory-limit' KernelError as a Boolean and restarts the worker.
   */
  probe(probe: KernelProbe, opts: BooleanOptions = {}): Promise<ProbeResult> {
    if (!this.testHooks) return Promise.reject(unavailableError('the kernel test hooks are disabled'));
    if (this.dead) return Promise.reject(this.dead.code === 'disposed' ? disposedError() : unavailableError(this.dead.reason));
    if (!this.ensureWorker() || !this.worker) return Promise.reject(unavailableError(this.deadReason()));
    const id = this.nextId++;
    const ms = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<ProbeResult>((resolve, reject) => {
      this.pending.set(id, { op: null, resolve: resolve as (value: Mesh3D | ProbeResult) => void, reject, ms, timer: null });
      this.enqueue(probe.op === 'probe-memory' ? { id, op: 'probe-memory', pages: probe.pages } : { id, op: 'probe-csp' });
    });
  }

  private enqueue(request: WorkerRequest): void {
    if (this.workerReady && this.worker) this.send(this.worker, request);
    else this.queued.push(request);
  }

  /** Post one request (its operand buffers are transferred); a failed post rejects that call. */
  private send(worker: WorkerLike, request: WorkerRequest): void {
    const { id } = request;
    const call = this.pending.get(id);
    if (!call) return;
    // The timeout measures the Boolean, not the worker's start-up (startTimeoutMs bounds that).
    call.timer = setTimeout(() => this.onTimeout(id, call.ms), call.ms);
    try {
      const transfer = 'a' in request ? [request.a.positions.buffer, request.a.indices.buffer, request.b.positions.buffer, request.b.indices.buffer] : [];
      worker.postMessage(request, transfer);
    } catch (err) {
      clearCallTimer(call);
      this.pending.delete(id);
      call.reject(new KernelError('kernel-failure', `The ${call.op ? opName(call.op) : 'kernel probe'} could not be sent to the geometry kernel (${err instanceof Error ? err.message : String(err)}).`));
    }
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
        const worker = this.worker, queued = this.queued;
        this.queued = [];

        // Calls that timed out (or were rejected) while waiting are no longer pending: skip them.
        if (worker) for (const request of queued) if (this.pending.has(request.id)) this.send(worker, request);
      } else {
        this.failStart(`the WebAssembly kernel failed to start (${msg.message})`);
      }
      return;
    }
    // A reply before `ready` cannot answer anything this kernel posted (requests wait for ready).
    if (!this.workerReady) return;
    const call = this.pending.get(msg.id);
    if (!call) return; // timed out or rejected already
    this.pending.delete(msg.id);
    clearCallTimer(call);
    if (msg.ok) {
      if ('probe' in msg) {
        if (call.op === null) call.resolve(msg.probe);
        else call.reject(new KernelError('kernel-failure', `The geometry kernel answered the ${opName(call.op)} with a probe result.`));
        return;
      }
      if (call.op === null) {
        call.reject(new KernelError('kernel-failure', 'The geometry kernel answered a probe with a mesh.'));
        return;
      }
      try {
        call.resolve(finishResult(call.op, unpackMesh(msg)));
      } catch (err) {
        call.reject(err instanceof KernelError ? err : new KernelError('kernel-failure', String(err)));
      }
    } else if (msg.memoryLimit) {
      call.reject(memoryLimitError());
      // The module may be inconsistent after a refused allocation: replace the worker.
      this.stopWorker();
      this.rejectAll(new KernelError('memory-limit', 'The geometry kernel was restarted after an earlier operation reached its memory limit; this operation was not applied.'));
    } else if (msg.operand && call.op) {
      call.reject(invalidOperand(call.op, msg.operand, `the geometry kernel refused it (${msg.error})`));
    } else {
      call.reject(new KernelError('kernel-failure', `The ${call.op ? opName(call.op) : 'kernel probe'} failed in the geometry kernel (${msg.error}).`));
    }
  }

  private onTimeout(id: number, ms: number): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    call.reject(call.op ? timeoutError(call.op, ms) : new KernelError('timeout', `The kernel probe took longer than ${Math.round(ms / 100) / 10} s and was stopped.`));
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
    // Their calls are rejected by the caller (rejectAll); a new worker starts with an empty queue.
    this.queued = [];
    this.workerReady = false;
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
      clearCallTimer(c);
      c.reject(err);
    }
  }
}

function disposedError(): KernelError {
  return new KernelError('disposed', 'The geometry kernel was shut down; the operation was not applied.');
}
