/**
 * Module Worker running the Manifold WebAssembly kernel off the UI thread (see docs/3D-KERNEL.md).
 *
 * Protocol: protocol.ts. On start the worker initialises the WebAssembly module once and posts
 * `ready` or `init-error`; requests that arrive before initialisation finishes wait for it.
 * Validation of inputs and results happens on the main thread (kernel.ts), not here. The wasm
 * file is located through Vite's `?url` asset import, so it is emitted into the build output and
 * found in development too (docs/3D-KERNEL.md).
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { MANIFOLD_VERSION, ManifoldInputError, loadManifold, manifoldBoolean } from './manifold-core';
import type { WorkerMessage, WorkerRequest } from './protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const wasm = loadManifold({ wasmUrl });
wasm.then(
  () => scope.postMessage({ type: 'ready', version: MANIFOLD_VERSION }),
  (err: unknown) => scope.postMessage({ type: 'init-error', message: errorText(err) }),
);

scope.onmessage = (event) => {
  const { id, op, a, b } = event.data;
  void wasm.then(
    (module) => {
      try {
        const out = manifoldBoolean(module, op, a, b);
        scope.postMessage({ id, ok: true, positions: out.positions, indices: out.indices }, [out.positions.buffer, out.indices.buffer]);
      } catch (err) {
        scope.postMessage(err instanceof ManifoldInputError ? { id, ok: false, error: err.message, operand: err.operand } : { id, ok: false, error: errorText(err) });
      }
    },
    (err: unknown) => scope.postMessage({ id, ok: false, error: `the kernel failed to start (${errorText(err)})` }),
  );
};
