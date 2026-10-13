/**
 * The geometry kernel's hard WebAssembly memory limit (docs/SECURITY-REVIEW.md E-20,
 * src/model3d/kernel/memory-guard.ts): the constant and the user message, the `grow` guard itself,
 * a refused growth becoming a 'memory-limit' KernelError with a restart (in-process kernel, and the
 * real worker request handler behind a fake Worker), and the test hooks being off by default.
 *
 * With JCAD_BENCH=1 (`npx cross-env JCAD_BENCH=1 vitest run tests/model3d-memory-limit.test.ts`)
 * it also measures the peak WebAssembly memory of the fixture and performance Booleans under the
 * 1 GiB limit, each on a fresh module; docs/3D-KERNEL.md "Memory limit" has the table.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { MAX_SOLID_TRIANGLES } from '../src/model3d/budget';
import { mat4RotationAxis, mat4Translation } from '../src/model3d/math';
import { type Mesh3D, mergeMeshes, meshTriangleCount, meshVolume, transformMesh } from '../src/model3d/mesh';
import { MAX_SEGMENTS, boxMesh, sphereMesh } from '../src/model3d/primitives';
import { kernelTestHooksRequested } from '../src/model3d/kernel';
import { type BooleanOp, type GeometryKernel, KernelError, memoryLimitError } from '../src/model3d/kernel/kernel';
import { MANIFOLD_VERSION, loadManifold } from '../src/model3d/kernel/manifold-core';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { ManifoldWorkerKernel, type WorkerLike } from '../src/model3d/kernel/manifold-kernel';
import {
  KERNEL_MEMORY_LIMIT_BYTES, KERNEL_MEMORY_LIMIT_PAGES, MANIFOLD_INITIAL_MEMORY_BYTES, WASM_PAGE_BYTES, memoryLimitReached, memoryLimitText, memoryScope,
  runWithMemoryLimit, uninstallMemoryGuard,
} from '../src/model3d/kernel/memory-guard';
import type { WorkerControl, WorkerMessage, WorkerRequest } from '../src/model3d/kernel/protocol';
import { createWorkerHandler } from '../src/model3d/kernel/worker-core';
import { cableTraySolids, enclosureSolids } from './helpers/model3d-fixtures';

const MiB = 1024 * 1024;
const BENCH = !!process.env.JCAD_BENCH;

afterAll(() => uninstallMemoryGuard());

const cube = (dx = 0, s = 1): Mesh3D => transformMesh(boxMesh(s, s, s), mat4Translation(dx, 0, 0));

async function rejection(p: Promise<unknown>): Promise<KernelError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(KernelError);
    return err as KernelError;
  }
  throw new Error('expected a rejection');
}

describe('kernel memory limit: constant and message', () => {
  it('is exactly 1 GiB (16,384 WebAssembly pages), one exported constant', () => {
    expect(KERNEL_MEMORY_LIMIT_BYTES).toBe(2 ** 30);
    expect(KERNEL_MEMORY_LIMIT_PAGES).toBe(16_384);
    expect(KERNEL_MEMORY_LIMIT_PAGES * WASM_PAGE_BYTES).toBe(KERNEL_MEMORY_LIMIT_BYTES);
    expect(MANIFOLD_INITIAL_MEMORY_BYTES).toBe(16 * MiB);
  });

  it('tells the user the limit, that the operation was abandoned and that the model is unchanged', () => {
    const e = memoryLimitError();
    expect(e.code).toBe('memory-limit');
    expect(e.message).toBe('The 3D kernel reached its 1 GiB memory limit; the operation was abandoned and the model is unchanged.');
    expect(memoryLimitText(64 * MiB)).toBe('64 MiB');
    expect(memoryLimitError(64 * MiB).message).toMatch(/^The 3D kernel reached its 64 MiB memory limit;/);
  });
});

describe('WebAssembly.Memory grow guard', () => {
  it('refuses growth past the limit inside a scope only, and records it', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 64 });
    const scope = memoryScope(4 * WASM_PAGE_BYTES);
    runWithMemoryLimit(scope, () => memory.grow(2));
    expect(memory.buffer.byteLength).toBe(3 * WASM_PAGE_BYTES);
    expect(scope.peakBytes).toBe(3 * WASM_PAGE_BYTES);
    expect(memoryLimitReached(scope)).toBe(false);
    runWithMemoryLimit(scope, () => memory.grow(1)); // exactly at the limit: allowed
    expect(() => runWithMemoryLimit(scope, () => memory.grow(1))).toThrow(RangeError);
    expect(memory.buffer.byteLength).toBe(4 * WASM_PAGE_BYTES);
    expect(scope.refusedBytes).toBe(5 * WASM_PAGE_BYTES);
    expect(memoryLimitReached(scope)).toBe(true);
    // Outside any scope the guard is transparent.
    memory.grow(4);
    expect(memory.buffer.byteLength).toBe(8 * WASM_PAGE_BYTES);
  });

  it('refuses limits that are not whole pages', () => {
    expect(() => memoryScope(0)).toThrow(RangeError);
    expect(() => memoryScope(1000)).toThrow(RangeError);
  });

  it('stops a real Manifold allocation at the limit (the module is unusable afterwards)', async () => {
    const wasm = await loadManifold();
    const scope = memoryScope(48 * MiB);
    const held: Array<{ delete(): void }> = [];
    let failure: unknown = null;
    try {
      runWithMemoryLimit(scope, () => { for (let i = 0; i < 2_000; i++) held.push(wasm.Manifold.sphere(1, 128)); });
    } catch (err) {
      failure = err;
    }
    expect(failure).not.toBeNull();
    expect(memoryLimitReached(scope)).toBe(true);
    expect(scope.peakBytes).toBeLessThanOrEqual(48 * MiB);
    expect(scope.refusedBytes!).toBeGreaterThan(48 * MiB);
  });
});

describe('in-process kernel under a memory limit', () => {
  const a = sphereMesh(1, 250, 101), b = transformMesh(sphereMesh(1, 250, 101), mat4Translation(0.7, 0.3, 0.1));

  it('rejects with memory-limit, loads a fresh module and then succeeds', async () => {
    const k = new ManifoldDirectKernel({ memoryLimitBytes: 20 * MiB });
    const e = await rejection(k.boolean('union', a, b));
    expect(e.code).toBe('memory-limit');
    expect(e.message).toBe('The 3D kernel reached its 20 MiB memory limit; the operation was abandoned and the model is unchanged.');
    expect(k.modulesLoaded).toBe(1);
    const m = await k.boolean('union', cube(), cube(0.5));
    expect(Math.abs(meshVolume(m) - 1.5)).toBeLessThan(1e-9);
    expect(k.modulesLoaded).toBe(2); // the module that hit the limit was discarded
    k.dispose();
  });

  it('lets the same operation through under the 1 GiB limit and reports its peak', async () => {
    const k = new ManifoldDirectKernel({ memoryLimitBytes: KERNEL_MEMORY_LIMIT_BYTES });
    const m = await k.boolean('union', a, b);
    expect(meshTriangleCount(m)).toBeGreaterThan(50_000);
    expect(k.lastPeakBytes).toBeGreaterThan(MANIFOLD_INITIAL_MEMORY_BYTES);
    expect(k.lastPeakBytes).toBeLessThan(KERNEL_MEMORY_LIMIT_BYTES);
    k.dispose();
  });
});

// ---- the real worker request handler behind a fake Worker -------------------------------------

/** Runs worker-core.ts's handler on a fresh in-process module, with structured-clone messaging. */
class CoreWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly controls: WorkerControl[] = [];
  private readonly handle: (data: WorkerRequest | WorkerControl) => void;

  constructor(limitBytes: number) {
    const wasm = loadManifold();
    this.handle = createWorkerHandler(wasm, memoryScope(limitBytes), (msg, transfer = []) => this.emit(msg, transfer));
    wasm.then(() => this.emit({ type: 'ready', version: MANIFOLD_VERSION }), (err: unknown) => this.emit({ type: 'init-error', message: String(err) }));
  }

  postMessage(message: WorkerRequest | WorkerControl, transfer: Transferable[]): void {
    const data = structuredClone(message, { transfer });
    if ('type' in data) this.controls.push(data);
    setTimeout(() => { if (!this.terminated) this.handle(data); }, 0);
  }

  terminate(): void { this.terminated = true; }

  private emit(data: WorkerMessage, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const cloned = structuredClone(data, { transfer });
    setTimeout(() => { if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: cloned })); }, 0);
  }
}

function coreKernel(limitBytes: number, testHooks: boolean) {
  const workers: CoreWorker[] = [];
  const k = new ManifoldWorkerKernel({ createWorker: () => { const w = new CoreWorker(limitBytes); workers.push(w); return w; }, testHooks, timeoutMs: 60_000 });
  return { k, workers };
}

describe('worker kernel under a memory limit (worker-core.ts behind a fake Worker)', () => {
  it('turns a refused growth into memory-limit, terminates the worker and restarts it, not counting a crash', async () => {
    const { k, workers } = coreKernel(64 * MiB, true);
    expect(meshVolume(await k.boolean('union', cube(), cube(0.5)))).toBeCloseTo(1.5, 9);
    expect(workers[0]!.controls).toEqual([{ type: 'enable-test-hooks' }]);
    // Under the limit the probe succeeds and reports the size reached.
    const ok = await k.probe({ op: 'probe-memory', pages: 512 });
    expect(ok.reachedBytes!).toBeGreaterThanOrEqual(32 * MiB);
    expect(ok.reachedBytes!).toBeLessThanOrEqual(64 * MiB);
    // Past it: the probe is refused, another pending call is rejected too, the worker is replaced.
    const probe = k.probe({ op: 'probe-memory', pages: 64 * MiB / WASM_PAGE_BYTES + 1 });
    const other = k.boolean('union', cube(), cube(0.5));
    const e = await rejection(probe);
    expect(e.code).toBe('memory-limit');
    expect(e.message).toBe('The 3D kernel reached its 1 GiB memory limit; the operation was abandoned and the model is unchanged.');
    const second = await rejection(other);
    expect(second.code).toBe('memory-limit');
    expect(second.message).toMatch(/restarted after an earlier operation reached its memory limit/);
    expect(workers[0]!.terminated).toBe(true);
    // The follow-up Boolean runs on a fresh worker.
    expect(meshVolume(await k.boolean('subtract', cube(), cube(0.5)))).toBeCloseTo(0.5, 9);
    expect(workers).toHaveLength(2);
    expect((await k.ready()).available).toBe(true);
    k.dispose();
  }, 60_000);

  it('fails a Boolean that needs more than the limit with memory-limit', async () => {
    const { k, workers } = coreKernel(20 * MiB, false);
    const a = sphereMesh(1, 250, 101), b = transformMesh(a, mat4Translation(0.7, 0.3, 0.1));
    expect((await rejection(k.boolean('union', a, b))).code).toBe('memory-limit');
    expect(workers[0]!.terminated).toBe(true);
    expect(meshVolume(await k.boolean('union', cube(), cube(0.5)))).toBeCloseTo(1.5, 9);
    expect(workers).toHaveLength(2);
    k.dispose();
  }, 60_000);

  it('keeps the test hooks off unless asked: probes are refused on both sides', async () => {
    const { k, workers } = coreKernel(64 * MiB, false);
    const e = await rejection(k.probe({ op: 'probe-memory', pages: 1 }));
    expect(e.code).toBe('unavailable');
    expect(e.message).toMatch(/test hooks are disabled/);
    expect(workers).toHaveLength(0); // refused before a worker was even started
    // A worker that never received enable-test-hooks refuses a probe it is sent anyway.
    const replies: WorkerMessage[] = [];
    const handle = createWorkerHandler(loadManifold(), memoryScope(64 * MiB), (msg) => replies.push(msg));
    handle({ id: 7, op: 'probe-memory', pages: 1_000_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(replies).toEqual([{ id: 7, ok: false, error: 'unknown operation "probe-memory"' }]);
    k.dispose();
  });

  it('enables the hooks only for ?jcad3dTestHooks=1', () => {
    expect(kernelTestHooksRequested('?jcad3dTestHooks=1')).toBe(true);
    expect(kernelTestHooksRequested('?demo&jcad3dTestHooks=1')).toBe(true);
    for (const s of ['', '?jcad3dTestHooks=0', '?jcad3dTestHooks', '?demo', '?JCAD3DTESTHOOKS=1', undefined]) expect(kernelTestHooksRequested(s)).toBe(false);
    // Node has no location: off.
    expect(kernelTestHooksRequested()).toBe(false);
  });
});

// ---- measurements (JCAD_BENCH=1) ---------------------------------------------------------------

/**
 * `count` UV spheres of 256 x `rings` (spaced 3 apart, 8 per row) merged into one mesh, each moved
 * by `dx` and turned by `turn` radians about an oblique axis (a small turn makes the facets of two
 * copies cross nearly everywhere: the most intersection work per triangle).
 */
function sphereRow(count: number, rings: number, dx = 0, turn = 0): Mesh3D {
  const sphere = turn ? transformMesh(sphereMesh(1, MAX_SEGMENTS, rings), mat4RotationAxis({ x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) }, turn)) : sphereMesh(1, MAX_SEGMENTS, rings);
  return mergeMeshes(Array.from({ length: count }, (_, i) => transformMesh(sphere, mat4Translation(3 * (i % 8) + dx, 3 * Math.floor(i / 8), 0))));
}

/** A GeometryKernel recording the peak memory of every call it forwards (one module throughout). */
class MeasuringKernel implements GeometryKernel {
  readonly name = 'measuring';
  peak = 0;
  calls = 0;
  constructor(private readonly inner: ManifoldDirectKernel) {}
  ready() { return this.inner.ready(); }
  async boolean(op: BooleanOp, a: Mesh3D, b: Mesh3D) {
    this.calls++;
    try {
      return await this.inner.boolean(op, a, b);
    } finally {
      this.peak = Math.max(this.peak, this.inner.lastPeakBytes);
    }
  }
  dispose() { this.inner.dispose(); }
}

interface Row { readonly operation: string; readonly operands: string; readonly peak: string; readonly outcome: string }

const fmt = (bytes: number): string => `${(Math.max(bytes, MANIFOLD_INITIAL_MEMORY_BYTES) / MiB).toFixed(0)} MiB`;

describe.skipIf(!BENCH)('peak WebAssembly memory of real operations under the 1 GiB limit', () => {
  const rows: Row[] = [];
  afterAll(() => {
    console.log('memlimit | Operation | Operands (triangles) | Peak WASM memory | Outcome |');
    for (const r of rows) console.log(`memlimit | ${r.operation} | ${r.operands} | ${r.peak} | ${r.outcome} |`);
  });

  /** Run one Boolean on a fresh module under the 1 GiB limit. */
  async function measure(operation: string, op: BooleanOp, a: Mesh3D, b: Mesh3D): Promise<void> {
    const k = new ManifoldDirectKernel({ memoryLimitBytes: KERNEL_MEMORY_LIMIT_BYTES });
    const operands = `${meshTriangleCount(a).toLocaleString('en-US')} + ${meshTriangleCount(b).toLocaleString('en-US')}`;
    const t0 = performance.now();
    let outcome: string;
    try {
      const m = await k.boolean(op, a, b);
      outcome = `ok, ${meshTriangleCount(m).toLocaleString('en-US')} triangles out`;
    } catch (err) {
      outcome = err instanceof KernelError ? `${err.code}: ${err.message}` : err instanceof GeometryBudgetError ? `budget: ${err.message}` : String(err);
    }
    outcome += ` (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
    rows.push({ operation, operands, peak: fmt(k.lastPeakBytes), outcome });
    k.dispose();
    expect(k.lastPeakBytes).toBeLessThanOrEqual(KERNEL_MEMORY_LIMIT_BYTES);
  }

  it('unit cubes', async () => {
    await measure('union of two half-overlapping unit cubes', 'union', cube(), cube(0.5));
  });

  it('two 50,000-triangle spheres (perf case)', async () => {
    const a = sphereMesh(1, 250, 101), b = transformMesh(a, mat4Translation(0.7, 0.3, 0.1));
    for (const op of ['union', 'subtract', 'intersect'] as const) await measure(`${op} of two 50,000-triangle spheres`, op, a, b);
  }, 120_000);

  it('enclosure and cable-tray fixtures (every Boolean of the build, one module)', async () => {
    for (const [label, build] of [['enclosure fixture build', enclosureSolids], ['cable-tray fixture build', cableTraySolids]] as const) {
      const k = new MeasuringKernel(new ManifoldDirectKernel({ memoryLimitBytes: KERNEL_MEMORY_LIMIT_BYTES }));
      const solids = await build(k);
      const tris = solids.reduce((n, s) => n + meshTriangleCount(s.mesh), 0);
      rows.push({ operation: `${label} (${k.calls} Booleans)`, operands: `${tris.toLocaleString('en-US')} in the result solids`, peak: fmt(k.peak), outcome: 'ok' });
      k.dispose();
    }
  }, 120_000);

  it('operands at the 500,000-triangle cap', async () => {
    // 8 spheres of 256 x 123 = 499,712 triangles each (the per-solid limit is 500,000).
    const a = sphereRow(8, 123), b = sphereRow(8, 123, 0.5);
    expect(meshTriangleCount(a)).toBe(499_712);
    expect(meshTriangleCount(a)).toBeLessThanOrEqual(MAX_SOLID_TRIANGLES);
    for (const op of ['union', 'subtract', 'intersect'] as const) await measure(`${op}, two 499,712-triangle rows of 8 spheres`, op, a, b);
    // One operand at the cap against a small one (the common case of drilling a dense part).
    await measure('subtract a 2,000-triangle sphere from a 499,712-triangle row', 'subtract', a, transformMesh(sphereMesh(1, 50, 21), mat4Translation(0.5, 0, 0)));
    // A union whose result stays under the cap: two 249,856-triangle rows.
    await measure('union, two 249,856-triangle rows of 4 spheres', 'union', sphereRow(4, 123), sphereRow(4, 123, 0.5));
    // Worst case found: the same rows, the second turned slightly, so nearly every facet crosses another.
    const turned = sphereRow(8, 123, 0, 0.01);
    for (const op of ['union', 'subtract', 'intersect'] as const) await measure(`${op}, two 499,712-triangle rows, second turned 0.01 rad (facets cross everywhere)`, op, a, turned);
    const a50 = sphereMesh(1, 250, 101), b50 = transformMesh(a50, mat4RotationAxis({ x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) }, 0.01));
    await measure('union, two 50,000-triangle spheres, second turned 0.01 rad', 'union', a50, b50);
    // Where the crossing case meets the limit: rows of 2 and 4 spheres.
    for (const n of [2, 4]) await measure(`union, two ${(n * 62_464).toLocaleString('en-US')}-triangle rows, second turned 0.01 rad`, 'union', sphereRow(n, 123), sphereRow(n, 123, 0, 0.01));
  }, 600_000);
});
