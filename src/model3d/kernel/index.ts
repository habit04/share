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
export { KernelError, UnavailableKernel } from './kernel';
export { ManifoldDirectKernel } from './manifold-direct';
export { DEFAULT_KERNEL_TIMEOUT_MS, ManifoldWorkerKernel } from './manifold-kernel';
export type { ManifoldWorkerKernelOptions, WorkerLike } from './manifold-kernel';

/** The kernel for this environment: worker-based when `Worker` exists, else in-process. */
export function createDefaultKernel(): GeometryKernel {
  return typeof Worker !== 'undefined' ? new ManifoldWorkerKernel() : new ManifoldDirectKernel();
}
