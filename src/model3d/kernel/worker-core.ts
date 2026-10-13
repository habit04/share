/**
 * The request handling of the kernel worker (manifold.worker.ts), kept free of worker globals so
 * the Node tests run exactly this code behind a fake Worker (tests/model3d-kernel.test.ts).
 *
 * - Booleans run synchronously on the Manifold module under the kernel's memory limit
 *   (memory-guard.ts). If the limit stopped the request (it threw after a refused growth, or its
 *   last growth attempt was refused), the reply is a `memoryLimit` failure and the handler is
 *   poisoned: every later request gets the same failure. The main thread terminates and replaces
 *   the worker on that reply. A refusal that Emscripten's smaller retry recovered from is not a
 *   failure.
 * - Probes (protocol.ts `WorkerProbeRequest`) are answered only by a handler created with
 *   `testHooks: true`.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { ManifoldInputError, manifoldBoolean } from './manifold-core';
import { MANIFOLD_INITIAL_MEMORY_BYTES, type MemoryScope, WASM_PAGE_BYTES, memoryLimitStopped, resetMemoryEvents, runWithMemoryLimit } from './memory-guard';
import type { ProbeResult, WorkerMessage, WorkerRequest } from './protocol';

export type Post = (message: WorkerMessage, transfer?: Transferable[]) => void;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A host name that can never resolve (RFC 2606), so a probe that CSP fails to block reaches no one. */
export const CSP_PROBE_ORIGIN = 'https://jcad-csp-probe.invalid';

/** Upper bound of probe-memory allocations (each about 1.5 MB of native memory). */
const MAX_PROBE_ALLOCATIONS = 20_000;

/**
 * Allocate Manifold solids (kept alive) until the module's memory is at least `targetBytes`, then
 * free them. Returns the size reached. Throws whatever the module throws when an allocation fails.
 */
function probeMemory(wasm: ManifoldToplevel, scope: MemoryScope, targetBytes: number): number {
  const held: Manifold[] = [];
  const size = (): number => Math.max(scope.peakBytes, MANIFOLD_INITIAL_MEMORY_BYTES);
  try {
    for (let i = 0; size() < targetBytes && !scope.lastRefused && i < MAX_PROBE_ALLOCATIONS; i++) held.push(wasm.Manifold.sphere(1, 128));
    return size();
  } finally {
    // After a final refusal the module may be unusable; the handler is then poisoned anyway.
    for (const m of held) {
      try { m.delete(); } catch { /* module state lost */ }
    }
  }
}

/** Try a remote fetch and import() and collect the CSP violations they cause. */
async function probeCsp(): Promise<ProbeResult> {
  const scope = globalThis as unknown as {
    addEventListener?: (type: string, fn: (event: Event) => void) => void;
    removeEventListener?: (type: string, fn: (event: Event) => void) => void;
    location?: { href: string };
  };
  const violations: string[] = [];
  const onViolation = (event: Event): void => {
    const e = event as Event & { effectiveDirective?: string; blockedURI?: string };
    violations.push(`${e.effectiveDirective ?? '?'} ${e.blockedURI ?? '?'}`);
  };
  scope.addEventListener?.('securitypolicyviolation', onViolation);
  let fetchBlocked = false, importBlocked = false;
  try {
    await fetch(`${CSP_PROBE_ORIGIN}/fetch`, { cache: 'no-store' });
  } catch {
    fetchBlocked = true;
  }
  try {
    const target = `${CSP_PROBE_ORIGIN}/import.js`;
    await import(/* @vite-ignore */ target);
  } catch {
    importBlocked = true;
  }
  // Violation events are queued as tasks; let them run.
  await new Promise((resolve) => setTimeout(resolve, 100));
  scope.removeEventListener?.('securitypolicyviolation', onViolation);
  return { url: scope.location?.href ?? '', fetchBlocked, importBlocked, violations };
}

/** Options of `createWorkerHandler`. */
export interface WorkerHandlerOptions {
  /**
   * Answer the test probes. Fixed when the worker is created (manifold.worker.ts reads its Worker
   * `name`, protocol.ts KERNEL_TEST_HOOKS_WORKER_NAME); no message can turn it on later.
   */
  readonly testHooks?: boolean;
}

/**
 * The worker's message handler: `wasm` is the module being loaded, `memory` the scope its growth
 * is checked against, `post` the reply channel.
 */
export function createWorkerHandler(wasm: Promise<ManifoldToplevel>, memory: MemoryScope, post: Post, opts: WorkerHandlerOptions = {}): (data: WorkerRequest) => void {
  const testHooks = opts.testHooks === true;
  let poisoned = false;
  const limitFailure = (id: number, detail: string): void => {
    poisoned = true;
    post({ id, ok: false, error: `the WebAssembly memory limit was reached (${detail})`, memoryLimit: true });
  };
  return (data) => {
    // Only requests are accepted; anything else (for example an attempt to switch on test hooks) is ignored.
    if (!data || typeof data !== 'object' || 'type' in data || typeof data.id !== 'number') return;
    const { id } = data;
    void wasm.then(
      async (module) => {
        if (poisoned) {
          post({ id, ok: false, error: 'the WebAssembly memory limit was reached by an earlier operation', memoryLimit: true });
          return;
        }
        if (data.op === 'probe-memory' || data.op === 'probe-csp') {
          if (!testHooks) {
            post({ id, ok: false, error: `unknown operation "${data.op}"` });
            return;
          }
          resetMemoryEvents(memory);
          try {
            const probe = data.op === 'probe-csp'
              ? await probeCsp()
              : { reachedBytes: runWithMemoryLimit(memory, () => probeMemory(module, memory, Math.max(0, Math.floor(data.pages)) * WASM_PAGE_BYTES)) };
            if (memoryLimitStopped(memory, false)) limitFailure(id, 'the last growth attempt was refused');
            else post({ id, ok: true, probe });
          } catch (err) {
            if (memoryLimitStopped(memory, true)) limitFailure(id, errorText(err));
            else post({ id, ok: false, error: errorText(err) });
          }
          return;
        }
        resetMemoryEvents(memory);
        try {
          const out = runWithMemoryLimit(memory, () => manifoldBoolean(module, data.op, data.a, data.b));
          // A refusal that a smaller retry recovered from is fine; a final refusal is not, even if
          // Manifold carried on: its state is suspect.
          if (memoryLimitStopped(memory, false)) limitFailure(id, 'the last growth attempt was refused');
          else post({ id, ok: true, positions: out.positions, indices: out.indices }, [out.positions.buffer, out.indices.buffer]);
        } catch (err) {
          if (memoryLimitStopped(memory, true)) limitFailure(id, errorText(err));
          else post(err instanceof ManifoldInputError ? { id, ok: false, error: err.message, operand: err.operand } : { id, ok: false, error: errorText(err) });
        }
      },
      (err: unknown) => post({ id, ok: false, error: `the kernel failed to start (${errorText(err)})` }),
    );
  };
}
