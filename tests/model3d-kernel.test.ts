/**
 * Geometry kernel: Manifold Booleans in-process (exact volumes, shells, refusals, precision) and
 * the worker transport with an injected fake Worker (id matching, timeout, crash and restart).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_SOLID_TRIANGLES } from '../src/model3d/budget';
import { mat4Translation } from '../src/model3d/math';
import { type Mesh3D, meshIsClosed, meshTriangleCount, meshVolume, transformMesh, validateMesh } from '../src/model3d/mesh';
import { boxMesh, sphereMesh } from '../src/model3d/primitives';
import { createDefaultKernel } from '../src/model3d/kernel';
import { KernelError, UnavailableKernel, finishResult, packMesh, prepareOperands } from '../src/model3d/kernel/kernel';
import { MANIFOLD_VERSION, loadManifold, manifoldBoolean } from '../src/model3d/kernel/manifold-core';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { ManifoldWorkerKernel, type WorkerLike } from '../src/model3d/kernel/manifold-kernel';
import type { WorkerMessage, WorkerRequest } from '../src/model3d/kernel/protocol';

const cube = (dx = 0, dy = 0, dz = 0, s = 1): Mesh3D => transformMesh(boxMesh(s, s, s), mat4Translation(dx, dy, dz));
const open = (m: Mesh3D): Mesh3D => ({ positions: m.positions, indices: m.indices.slice(3) });

/** Connected components of a mesh by shared vertex indices. */
function shells(m: Mesh3D): number {
  const parent = Array.from({ length: m.positions.length / 3 }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = find(m.indices[t]!);
    parent[find(m.indices[t + 1]!)] = a;
    parent[find(m.indices[t + 2]!)] = a;
  }
  return new Set(m.indices.map(find)).size;
}

async function rejection(p: Promise<unknown>): Promise<KernelError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(KernelError);
    return err as KernelError;
  }
  throw new Error('expected a rejection');
}

const kernel = new ManifoldDirectKernel();
afterAll(() => kernel.dispose());

describe('Manifold in-process kernel', () => {
  it('reports availability and the pinned version', async () => {
    expect(await kernel.ready()).toEqual({ available: true, version: MANIFOLD_VERSION });
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules/manifold-3d/package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(MANIFOLD_VERSION);
    const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies: Record<string, string> };
    // Bundled by Vite (worker chunk + wasm asset), so the installer needs nothing from node_modules.
    expect(own.devDependencies['manifold-3d']).toBe(MANIFOLD_VERSION);
    expect(own.dependencies?.['manifold-3d']).toBeUndefined();
  });

  it('computes union, subtraction and intersection of half-overlapping unit cubes', async () => {
    const a = cube(), b = cube(0.5);
    const expected = { union: 1.5, subtract: 0.5, intersect: 0.5 } as const;
    for (const op of ['union', 'subtract', 'intersect'] as const) {
      const m = await kernel.boolean(op, a, b);
      expect(validateMesh(m)).toBeNull();
      expect(meshIsClosed(m)).toBe(true);
      expect(Math.abs(meshVolume(m) - expected[op])).toBeLessThan(1e-9);
      expect(shells(m)).toBe(1);
    }
  });

  it('keeps both shells of a disjoint union', async () => {
    const m = await kernel.boolean('union', cube(), cube(3));
    expect(meshIsClosed(m)).toBe(true);
    expect(meshVolume(m)).toBeCloseTo(2, 12);
    expect(shells(m)).toBe(2);
  });

  it('unions two cubes touching along an edge into a closed mesh with the summed volume', async () => {
    const m = await kernel.boolean('union', cube(), cube(1, 1));
    expect(validateMesh(m)).toBeNull();
    expect(meshIsClosed(m)).toBe(true);
    expect(Math.abs(meshVolume(m) - 2)).toBeLessThan(1e-9);
  });

  it('returns untouched vertices with their exact double coordinates far from the origin', async () => {
    const far = 1e6 + 0.1;
    const a = cube(far, far, far, 0.001), b = cube(far + 0.0005, far, far, 0.001);
    const m = await kernel.boolean('union', a, b);
    expect(meshIsClosed(m)).toBe(true);
    expect(Math.abs(meshVolume(m) - 1.5e-9) / 1.5e-9).toBeLessThan(1e-4);
    const inputs = new Set<string>();
    for (const src of [a, b]) for (let i = 0; i < src.positions.length; i += 3) inputs.add(`${src.positions[i]},${src.positions[i + 1]},${src.positions[i + 2]}`);
    let exact = 0;
    for (let i = 0; i < m.positions.length; i += 3) if (inputs.has(`${m.positions[i]},${m.positions[i + 1]},${m.positions[i + 2]}`)) exact++;
    // The corners away from the cut (4 per cube end) keep their exact coordinates.
    expect(exact).toBeGreaterThanOrEqual(8);
  });

  it('refuses an open operand, naming it, before calling the kernel', async () => {
    const e = await rejection(kernel.boolean('union', cube(), open(cube(0.5))));
    expect(e.code).toBe('invalid-input');
    expect(e.operand).toBe('b');
    expect(e.message).toMatch(/^The second solid cannot be used in the union: it is not a closed solid/);
    const first = await rejection(kernel.boolean('subtract', open(cube()), cube()));
    expect(first.operand).toBe('a');
    expect(first.message).toMatch(/^The first solid cannot be used in the subtraction/);
    const malformed = await rejection(kernel.boolean('intersect', cube(), { positions: [0, 0], indices: [] }));
    expect(malformed.message).toMatch(/malformed/);
    const inside = await rejection(kernel.boolean('union', { positions: cube().positions, indices: [...cube().indices].reverse() }, cube()));
    expect(inside.message).toMatch(/inside out/);
  });

  it('reports empty results as errors', async () => {
    expect((await rejection(kernel.boolean('intersect', cube(), cube(5)))).code).toBe('empty-result');
    const e = await rejection(kernel.boolean('subtract', cube(), cube()));
    expect(e.code).toBe('empty-result');
    expect(e.message).toMatch(/Nothing is left/);
  });

  it('checks results: budget, closedness and orientation', () => {
    const c = cube();
    expect(() => finishResult('union', { positions: c.positions, indices: c.indices.slice(3) })).toThrow(/open mesh/);
    const inverted = finishResult('union', { positions: c.positions, indices: [...c.indices].reverse() });
    expect(meshVolume(inverted)).toBeCloseTo(1, 12);
    const huge: Mesh3D = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(3 * (MAX_SOLID_TRIANGLES + 1)).fill(0).map((_, i) => i % 3) };
    const err = (() => { try { finishResult('union', huge); } catch (e) { return e as KernelError; } return null; })();
    expect(err?.code).toBe('budget');
    expect(() => prepareOperands('union', huge, c)).toThrow(/safe limit/);
    expect(() => prepareOperands('toString' as never, c, c)).toThrow(/Unknown Boolean operation/);
  });

  it('unions two dense spheres (about 50 000 triangles) into a closed solid', async () => {
    const a = sphereMesh(1, 256, 50), b = transformMesh(sphereMesh(1, 256, 50), mat4Translation(1, 0, 0));
    expect(meshTriangleCount(a) + meshTriangleCount(b)).toBeGreaterThan(50_000);
    const m = await kernel.boolean('union', a, b);
    expect(meshIsClosed(m)).toBe(true);
    // Two unit spheres at distance 1: 2 * (4/3) pi - lens volume (5/12) pi.
    expect(meshVolume(m)).toBeCloseTo((8 / 3 - 5 / 12) * Math.PI, 1);
  });

  it('frees every native Manifold object it creates, including a refused operand', async () => {
    const wasm = await loadManifold();
    const probe = wasm.Manifold.cube([1, 1, 1]);
    const proto = Object.getPrototypeOf(probe) as { delete: () => void };
    probe.delete();
    const original = proto.delete;
    let deleted = 0;
    proto.delete = function (this: unknown) { deleted++; original.call(this); };
    try {
      manifoldBoolean(wasm, 'union', packMesh(cube()), packMesh(cube(0.5)));
      expect(deleted).toBe(3); // both operands and the result
      deleted = 0;
      expect(() => manifoldBoolean(wasm, 'union', packMesh(cube()), packMesh(open(cube(0.5))))).toThrow(/Not manifold/);
      expect(deleted).toBe(2); // the first operand and the refused one
    } finally {
      proto.delete = original;
    }
  });

  it('createDefaultKernel picks the in-process kernel in Node and UnavailableKernel reports its reason', async () => {
    const k = createDefaultKernel();
    expect(k).toBeInstanceOf(ManifoldDirectKernel);
    k.dispose();
    expect((await rejection(k.boolean('union', cube(), cube()))).code).toBe('disposed');
    const u = new UnavailableKernel('WebAssembly is disabled');
    expect(await u.ready()).toEqual({ available: false, reason: 'WebAssembly is disabled' });
    const e = await rejection(u.boolean('union', cube(), cube()));
    expect(e.code).toBe('unavailable');
    expect(e.message).toMatch(/WebAssembly is disabled/);
  });
});

// ---- worker transport -------------------------------------------------------------------------

type Mode = 'normal' | 'reverse' | 'hang' | 'crash' | 'init-error';

/** A fake module worker running the real Manifold core in-process, with scripted failures. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: { readonly data: WorkerMessage }) => void) | null = null;
  onerror: ((event: { readonly message?: string; preventDefault?: () => void }) => void) | null = null;
  terminated = false;
  readonly posted: { msg: WorkerRequest; transfer: Transferable[] }[] = [];
  private held: WorkerRequest[] = [];

  constructor(private readonly mode: Mode) {
    setTimeout(() => this.emit(mode === 'init-error' ? { type: 'init-error', message: 'WebAssembly.instantiate(): blocked' } : { type: 'ready', version: MANIFOLD_VERSION }), 0);
  }

  postMessage(msg: WorkerRequest, transfer: Transferable[]): void {
    this.posted.push({ msg, transfer });
    if (this.mode === 'hang') return;
    if (this.mode === 'crash') { setTimeout(() => this.onerror?.({ message: 'RuntimeError: memory access out of bounds' }), 0); return; }
    if (this.mode === 'reverse') {
      this.held.push(msg);
      if (this.held.length === 2) { const [x, y] = this.held; this.held = []; void this.reply(y!).then(() => this.reply(x!)); }
      return;
    }
    void this.reply(msg);
  }

  terminate(): void { this.terminated = true; }

  private emit(data: WorkerMessage): void {
    if (!this.terminated) this.onmessage?.({ data });
  }

  private async reply(msg: WorkerRequest): Promise<void> {
    const wasm = await loadManifold();
    const out = manifoldBoolean(wasm, msg.op, msg.a, msg.b);
    this.emit({ id: msg.id, ok: true, positions: out.positions, indices: out.indices });
  }
}

function fakeKernel(modes: Mode[], opts: { timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const k = new ManifoldWorkerKernel({
    createWorker: () => {
      const w = new FakeWorker(modes[Math.min(workers.length, modes.length - 1)]!);
      workers.push(w);
      return w;
    },
    ...opts,
  });
  return { k, workers };
}

describe('Manifold worker kernel transport', () => {
  it('starts lazily, reports ready and transfers the operand buffers', async () => {
    const { k, workers } = fakeKernel(['normal']);
    expect(workers).toHaveLength(0);
    expect(k.name).toContain(MANIFOLD_VERSION);
    expect(await k.ready()).toEqual({ available: true, version: MANIFOLD_VERSION });
    const m = await k.boolean('union', cube(), cube(0.5));
    expect(Math.abs(meshVolume(m) - 1.5)).toBeLessThan(1e-9);
    const { msg, transfer } = workers[0]!.posted[0]!;
    expect(transfer).toEqual([msg.a.positions.buffer, msg.a.indices.buffer, msg.b.positions.buffer, msg.b.indices.buffer]);
    k.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });

  it('matches replies to requests by id when they arrive out of order', async () => {
    const { k } = fakeKernel(['reverse']);
    const [u, i] = await Promise.all([k.boolean('union', cube(), cube(0.5)), k.boolean('intersect', cube(), cube(0.5))]);
    expect(meshVolume(u)).toBeCloseTo(1.5, 9);
    expect(meshVolume(i)).toBeCloseTo(0.5, 9);
    k.dispose();
  });

  it('validates operands on the main thread before posting', async () => {
    const { k, workers } = fakeKernel(['normal']);
    const e = await rejection(k.boolean('union', open(cube()), cube()));
    expect(e.operand).toBe('a');
    expect(workers.length === 0 || workers[0]!.posted.length === 0).toBe(true);
    k.dispose();
  });

  it('times out, terminates the busy worker and starts a fresh one for the next call', async () => {
    const { k, workers } = fakeKernel(['hang', 'normal'], { timeoutMs: 30 });
    const first = k.boolean('union', cube(), cube(0.5));
    const second = k.boolean('union', cube(), cube(0.5), { timeoutMs: 10_000 });
    const e = await rejection(first);
    expect(e.code).toBe('timeout');
    expect(e.message).toMatch(/took longer than/);
    const other = await rejection(second);
    expect(other.code).toBe('timeout');
    expect(other.message).toMatch(/restarted after an earlier operation timed out/);
    expect(workers[0]!.terminated).toBe(true);
    const m = await k.boolean('union', cube(), cube(0.5));
    expect(meshVolume(m)).toBeCloseTo(1.5, 9);
    expect(workers).toHaveLength(2);
    k.dispose();
  });

  it('rejects pending calls on a crash, restarts once, then reports the kernel unavailable', async () => {
    const { k, workers } = fakeKernel(['crash']);
    const e1 = await rejection(k.boolean('union', cube(), cube(0.5)));
    expect(e1.code).toBe('worker-crash');
    expect(e1.message).toMatch(/stopped unexpectedly \(RuntimeError: memory access out of bounds\)/);
    expect(workers[0]!.terminated).toBe(true);
    const e2 = await rejection(k.boolean('union', cube(), cube(0.5)));
    expect(e2.code).toBe('worker-crash');
    expect(workers).toHaveLength(2);
    const e3 = await rejection(k.boolean('union', cube(), cube(0.5)));
    expect(e3.code).toBe('unavailable');
    expect(workers).toHaveLength(2);
    expect((await k.ready()).available).toBe(false);
    k.dispose();
  });

  it('recovers after a single crash', async () => {
    const { k, workers } = fakeKernel(['crash', 'normal']);
    expect((await rejection(k.boolean('union', cube(), cube(0.5)))).code).toBe('worker-crash');
    expect(meshVolume(await k.boolean('subtract', cube(), cube(0.5)))).toBeCloseTo(0.5, 9);
    expect(workers).toHaveLength(2);
    k.dispose();
  });

  it('reports a WebAssembly start-up failure as unavailable and never retries', async () => {
    const { k, workers } = fakeKernel(['init-error']);
    const status = await k.ready();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/failed to start \(WebAssembly.instantiate\(\): blocked\)/);
    expect((await rejection(k.boolean('union', cube(), cube(0.5)))).code).toBe('unavailable');
    expect(workers).toHaveLength(1);
    k.dispose();
  });

  it('rejects pending calls on dispose and refuses later ones', async () => {
    const { k } = fakeKernel(['hang']);
    const pending = k.boolean('union', cube(), cube(0.5));
    k.dispose();
    expect((await rejection(pending)).code).toBe('disposed');
    expect((await rejection(k.boolean('union', cube(), cube(0.5)))).code).toBe('disposed');
    expect((await k.ready()).available).toBe(false);
  });

  it('reports a worker that cannot be created as unavailable', async () => {
    const k = new ManifoldWorkerKernel({ createWorker: () => { throw new Error('Workers are disabled'); } });
    expect((await k.ready()).reason).toMatch(/Workers are disabled/);
    expect((await rejection(k.boolean('union', cube(), cube(0.5)))).code).toBe('unavailable');
  });
});
