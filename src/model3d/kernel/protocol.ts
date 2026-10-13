/**
 * Messages between the main thread (manifold-kernel.ts) and the kernel worker
 * (manifold.worker.ts). Structured clone; typed-array buffers are transferred, never copied.
 * Meshes travel as `PackedMesh` (Float64Array positions in world drawing units, Uint32Array
 * triangle indices, counter-clockwise seen from outside).
 */
import type { BooleanOp, PackedMesh } from './kernel';

/** A Boolean request from the main thread; `id` matches the reply. */
export interface WorkerBooleanRequest {
  readonly id: number;
  readonly op: BooleanOp;
  readonly a: PackedMesh;
  readonly b: PackedMesh;
}

/**
 * Test-only probes (scripts/e2e-3d-security.mjs). The worker answers them only after the main
 * thread sent `enable-test-hooks`, which ManifoldWorkerKernel does only when created with
 * `testHooks: true` (the renderer sets that only for `?jcad3dTestHooks=1`, which the Electron main
 * process adds only for JCAD_3D_TEST_HOOKS=1 in a build that allows inspection). Otherwise they are
 * refused like an unknown operation. They are no security boundary: page script can already make
 * the kernel allocate up to its limit with legitimate Booleans.
 * - `probe-memory`: allocate Manifold solids inside the WebAssembly module until its memory is at
 *   least `pages` pages, then free them (drives growth past the limit on purpose).
 * - `probe-csp`: try a remote `fetch` and `import()` from inside the worker and report the CSP
 *   violations seen, plus the worker's own URL (its response headers can then be checked).
 */
export type WorkerProbeRequest =
  | { readonly id: number; readonly op: 'probe-memory'; readonly pages: number }
  | { readonly id: number; readonly op: 'probe-csp' };

export type WorkerRequest = WorkerBooleanRequest | WorkerProbeRequest;

/** Control messages from the main thread (no reply). */
export type WorkerControl = { readonly type: 'enable-test-hooks' };

/** What a probe reports. */
export interface ProbeResult {
  /** probe-memory: memory size reached (bytes). */
  readonly reachedBytes?: number;
  /** probe-csp: the worker script's URL. */
  readonly url?: string;
  /** probe-csp: whether the remote fetch / import() failed. */
  readonly fetchBlocked?: boolean;
  readonly importBlocked?: boolean;
  /** probe-csp: `<effectiveDirective> <blockedURI>` of every securitypolicyviolation event. */
  readonly violations?: readonly string[];
}

/**
 * Every message the worker posts: one `ready` or `init-error` after start-up, then one reply per
 * request (`operand` names the input the kernel refused; `memoryLimit` says the hard WebAssembly
 * memory limit stopped the operation, after which the worker must be discarded).
 */
export type WorkerMessage =
  | { readonly type: 'ready'; readonly version: string }
  | { readonly type: 'init-error'; readonly message: string }
  | { readonly id: number; readonly ok: true; readonly positions: Float64Array; readonly indices: Uint32Array }
  | { readonly id: number; readonly ok: true; readonly probe: ProbeResult }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly operand?: 'a' | 'b'; readonly memoryLimit?: true };
