/**
 * Module Worker running the Manifold WebAssembly kernel off the UI thread (see docs/3D-KERNEL.md).
 * A dedicated worker is a thread of the renderer process: it keeps long Booleans off the UI thread
 * and gives the kernel its own JavaScript global scope, but it shares the renderer's process and
 * memory. What bounds it: the hard WebAssembly memory limit installed below, the per-call timeout
 * and restart policy of manifold-kernel.ts, and its own CSP response header
 * (electron/renderer-origin.cjs WORKER_CSP).
 *
 * Protocol: protocol.ts. On start the worker installs the memory limit (memory-guard.ts; before the
 * module is instantiated, so every growth of its memory is checked), initialises the WebAssembly
 * module once and posts `ready` or `init-error`; requests that arrive before initialisation finishes
 * wait for it. Request handling is worker-core.ts. Validation of inputs and results happens on the
 * main thread (kernel.ts), not here. The wasm file is located through Vite's `?url` asset import,
 * so it is emitted into the build output and found in development too (docs/3D-KERNEL.md).
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { MANIFOLD_VERSION, loadManifold } from './manifold-core';
import { KERNEL_MEMORY_LIMIT_BYTES, memoryScope, setAmbientMemoryLimit } from './memory-guard';
import { KERNEL_TEST_HOOKS_WORKER_NAME, type WorkerMessage, type WorkerRequest } from './protocol';
import { createWorkerHandler } from './worker-core';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  readonly name?: string;
};

// Test probes only for a worker the main thread created with the test-hooks name (read once, now).
const testHooks = scope.name === KERNEL_TEST_HOOKS_WORKER_NAME;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Before instantiation: the module's own memory is created by instantiate and grows only through
// WebAssembly.Memory.prototype.grow, which this patches for the whole worker.
const memory = memoryScope(KERNEL_MEMORY_LIMIT_BYTES);
setAmbientMemoryLimit(memory);

const wasm = loadManifold({ wasmUrl });
wasm.then(
  () => scope.postMessage({ type: 'ready', version: MANIFOLD_VERSION }),
  (err: unknown) => scope.postMessage({ type: 'init-error', message: errorText(err) }),
);

const handle = createWorkerHandler(wasm, memory, (message, transfer) => scope.postMessage(message, transfer ?? []), { testHooks });
scope.onmessage = (event) => handle(event.data);
