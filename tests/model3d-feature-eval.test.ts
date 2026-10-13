/** Feature re-evaluation: every kind, nested Booleans through the kernel, limits and refusals. */
import { afterAll, describe, expect, it } from 'vitest';
import type { Point } from '../src/core/geometry';
import { DEFAULT_FEATURE_MAX_DEPTH, FeatureEvalError, evaluateFeature } from '../src/model3d/feature-eval';
import { KernelError } from '../src/model3d/kernel/kernel';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { primitiveMesh } from '../src/model3d/primitives';
import type { BoxFeature, Feature3D } from '../src/model3d/types';

const kernel = new ManifoldDirectKernel();
afterAll(() => kernel.dispose());

const box = (x = 0, s = 1): BoxFeature => ({ kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x, 0, 0) }, width: s, depth: s, height: s });
const square: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

describe('evaluateFeature', () => {
  it('evaluates primitives exactly like primitiveMesh', async () => {
    const f: Feature3D = { kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 2, segments: 24 };
    expect(await evaluateFeature(f, kernel)).toEqual(primitiveMesh(f));
    expect(meshVolume(await evaluateFeature(box(), kernel))).toBe(1);
  });

  it('evaluates extrusions and revolutions', async () => {
    const ex = await evaluateFeature({ kind: 'extrude', profile: { frame: WORLD_XY_FRAME, loops: [square] }, distance: -3 }, kernel);
    expect(meshVolume(ex)).toBe(3);
    const rev = await evaluateFeature({ kind: 'revolve', profile: { frame: WORLD_XY_FRAME, loops: [square.map((p) => ({ x: p.x + 1, y: p.y }))] }, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI }, kernel);
    expect(meshIsClosed(rev)).toBe(true);
    expect(meshVolume(rev)).toBeGreaterThan(0);
  });

  it('evaluates nested Booleans through the kernel', async () => {
    // Unit boxes centred at x = 0 and x = 0.5 (union 1.5), minus a slab x in [0, 0.5] through both (0.5).
    const union: Feature3D = { kind: 'boolean', op: 'union', operands: [box(0), box(0.5)] };
    expect(meshVolume(await evaluateFeature(union, kernel))).toBeCloseTo(1.5, 9);
    const cut: Feature3D = { kind: 'boolean', op: 'subtract', operands: [union, { kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(0.25, 0, 0) }, width: 0.5, depth: 2, height: 2 }] };
    const m = await evaluateFeature(cut, kernel);
    expect(meshIsClosed(m)).toBe(true);
    expect(meshVolume(m)).toBeCloseTo(1.0, 9);
    const inter: Feature3D = { kind: 'boolean', op: 'intersect', operands: [box(0), box(0.5)] };
    expect(meshVolume(await evaluateFeature(inter, kernel))).toBeCloseTo(0.5, 9);
  });

  it('propagates kernel errors', async () => {
    const empty: Feature3D = { kind: 'boolean', op: 'intersect', operands: [box(0), box(5)] };
    await expect(evaluateFeature(empty, kernel)).rejects.toBeInstanceOf(KernelError);
  });

  it('refuses mesh features, which have no recipe', async () => {
    await expect(evaluateFeature({ kind: 'mesh', source: 'imported' }, kernel)).rejects.toThrow(/cannot be re-evaluated/);
    const nested: Feature3D = { kind: 'boolean', op: 'union', operands: [box(), { kind: 'mesh', source: 'edited' }] };
    await expect(evaluateFeature(nested, kernel)).rejects.toThrow(FeatureEvalError);
  });

  it('enforces the depth and node limits before doing any work', async () => {
    let deep: Feature3D = box();
    for (let i = 0; i < DEFAULT_FEATURE_MAX_DEPTH; i++) deep = { kind: 'boolean', op: 'union', operands: [deep, box()] };
    await expect(evaluateFeature(deep, kernel)).rejects.toThrow(/nested more than 32 levels/);
    // A balanced tree of 2^7 - 1 = 127 features passes depth 7 but not 100 nodes.
    const tree = (d: number): Feature3D => (d === 1 ? box() : { kind: 'boolean', op: 'union', operands: [tree(d - 1), tree(d - 1)] });
    await expect(evaluateFeature(tree(7), kernel, { maxNodes: 100 })).rejects.toThrow(/more than 100 features/);
    await expect(evaluateFeature(tree(3), kernel, { maxDepth: 2 })).rejects.toThrow(/nested more than 2 levels/);
    // A pathological, very deep history is refused without overflowing the stack.
    let huge: Feature3D = box();
    for (let i = 0; i < 100_000; i++) huge = { kind: 'boolean', op: 'union', operands: [huge, box()] };
    await expect(evaluateFeature(huge, kernel)).rejects.toThrow(FeatureEvalError);
  });

  it('refuses malformed Boolean features and unknown kinds', async () => {
    await expect(evaluateFeature({ kind: 'boolean', op: 'union', operands: [box()] }, kernel)).rejects.toThrow(/exactly two operands/);
    await expect(evaluateFeature({ kind: 'boolean', op: 'xor' as never, operands: [box(), box()] }, kernel)).rejects.toThrow(/Unknown Boolean/);
    await expect(evaluateFeature({ kind: 'blob' } as never, kernel)).rejects.toThrow(/unknown feature/);
  });

  it('propagates builder errors for invalid parameters', async () => {
    await expect(evaluateFeature({ ...box(), width: -1 }, kernel)).rejects.toThrow(RangeError);
    await expect(evaluateFeature({ kind: 'extrude', profile: { frame: WORLD_XY_FRAME, loops: [square] }, distance: 0 }, kernel)).rejects.toThrow(/non-zero/);
  });
});
