/**
 * The Manifold kernel running in-process: the same `GeometryKernel` contract as the worker kernel
 * (manifold-kernel.ts), with inputs and results checked by kernel.ts, but the Boolean runs
 * synchronously on the calling thread. Used by the Node unit tests and wherever no Worker exists.
 *
 * Documented alternative to the worker: in the Electron renderer this would block the UI for the
 * duration of each Boolean and needs WebAssembly compilation allowed by the renderer CSP
 * (`'wasm-unsafe-eval'`), which the strict renderer policy does not grant (docs/3D-KERNEL.md).
 *
 * The WebAssembly module is loaded lazily (dynamic import) on the first `ready()` / `boolean()`, so
 * importing this file costs nothing. `timeoutMs` cannot interrupt a synchronous call; it is
 * checked afterwards, and a call that ran longer is still rejected as a timeout so behaviour
 * matches the worker kernel.
 */
import type { ManifoldToplevel } from 'manifold-3d';
import type { Mesh3D } from '../mesh';
import {
  type BooleanOp, type BooleanOptions, type GeometryKernel, type KernelStatus, KernelError, finishResult, invalidOperand, opName, packMesh,
  prepareOperands, timeoutError, unavailableError, unpackMesh,
} from './kernel';
import { MANIFOLD_VERSION } from './version';

export class ManifoldDirectKernel implements GeometryKernel {
  readonly name = `Manifold ${MANIFOLD_VERSION} (in-process)`;
  private loading: Promise<{ wasm: ManifoldToplevel; core: typeof import('./manifold-core') } | string> | null = null;
  private disposed = false;

  private load(): Promise<{ wasm: ManifoldToplevel; core: typeof import('./manifold-core') } | string> {
    this.loading ??= import('./manifold-core').then(
      async (core) => ({ wasm: await core.loadManifold(), core }),
      (err: unknown) => `the kernel module could not be loaded (${err instanceof Error ? err.message : String(err)})`,
    ).catch((err: unknown) => `the WebAssembly kernel failed to start (${err instanceof Error ? err.message : String(err)})`);
    return this.loading;
  }

  async ready(): Promise<KernelStatus> {
    if (this.disposed) return { available: false, reason: 'the geometry kernel was shut down' };
    const loaded = await this.load();
    return typeof loaded === 'string' ? { available: false, reason: loaded } : { available: true, version: MANIFOLD_VERSION };
  }

  async boolean(op: BooleanOp, a: Mesh3D, b: Mesh3D, opts: BooleanOptions = {}): Promise<Mesh3D> {
    if (this.disposed) throw new KernelError('disposed', 'The geometry kernel was shut down; the operation was not applied.');
    prepareOperands(op, a, b);
    const loaded = await this.load();
    if (typeof loaded === 'string') throw unavailableError(loaded);
    const started = performance.now();
    let raw;
    try {
      raw = loaded.core.manifoldBoolean(loaded.wasm, op, packMesh(a), packMesh(b));
    } catch (err) {
      if (err instanceof loaded.core.ManifoldInputError) throw invalidOperand(op, err.operand, `the geometry kernel refused it (${err.message})`);
      throw new KernelError('kernel-failure', `The ${opName(op)} failed in the geometry kernel (${err instanceof Error ? err.message : String(err)}).`);
    }
    const elapsed = performance.now() - started;
    if (opts.timeoutMs !== undefined && elapsed > opts.timeoutMs) throw timeoutError(op, opts.timeoutMs);
    return finishResult(op, unpackMesh(raw));
  }

  dispose(): void {
    this.disposed = true;
  }
}
