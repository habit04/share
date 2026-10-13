/**
 * Entry point of the geometry kernel. `createDefaultKernel()` returns the Manifold kernel in a
 * module Worker wherever `Worker` exists (the Electron renderer, browsers) and the in-process
 * Manifold kernel otherwise (Node: tests, scripts). Both load the WebAssembly lazily, so creating
 * a kernel is cheap and nothing starts until `ready()` or the first `boolean()`.
 */
import type { GeometryKernel } from './kernel';
import { ManifoldDirectKernel } from './manifold-direct';
import { ManifoldWorkerKernel } from './manifold-kernel';

export type { BooleanOp, BooleanOptions, GeometryKernel, KernelErrorCode, KernelStatus } from './kernel';
export { KernelError, UnavailableKernel, memoryLimitError } from './kernel';
export { ManifoldDirectKernel } from './manifold-direct';
export type { ManifoldDirectKernelOptions } from './manifold-direct';
export { DEFAULT_KERNEL_TIMEOUT_MS, ManifoldWorkerKernel } from './manifold-kernel';
export type { KernelProbe, ManifoldWorkerKernelOptions, WorkerLike } from './manifold-kernel';
export { KERNEL_MEMORY_LIMIT_BYTES, KERNEL_MEMORY_LIMIT_PAGES } from './memory-guard';

/**
 * True when the page was opened with `?jcad3dTestHooks=1` (the Electron main process adds it only
 * for JCAD_3D_TEST_HOOKS=1 in a development or dedicated test build; scripts/e2e-3d-security.mjs).
 */
export function kernelTestHooksRequested(search: string | undefined = globalThis.location?.search): boolean {
  if (typeof search !== 'string' || !search) return false;
  try {
    return new URLSearchParams(search).get('jcad3dTestHooks') === '1';
  } catch {
    return false;
  }
}

/** The kernel for this environment: worker-based when `Worker` exists, else in-process. */
export function createDefaultKernel(): GeometryKernel {
  return typeof Worker !== 'undefined' ? new ManifoldWorkerKernel({ testHooks: kernelTestHooksRequested() }) : new ManifoldDirectKernel();
}
