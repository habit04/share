import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { addSolids, model3dOf, newSolid, replaceSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import { UnavailableKernel } from '../src/model3d/kernel/kernel';
import type { BoxFeature, Solid3D } from '../src/model3d/types';
import { intersectTool, subtractTool, unionTool } from '../src/tools3d/booleans';
import { fakeContext } from './fake-context';
import { type Fake3DContext, type Fake3DOptions, drive3d, fake3dContext } from './helpers/context3d';

/** A 2 x 2 x 2 box whose base is centred on (x, 0, 0). */
const box = (x: number, extra: Partial<Solid3D> = {}): Solid3D => {
  const feature: BoxFeature = { kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x, 0, 0) }, width: 2, depth: 2, height: 2 };
  return { ...newSolid({ mesh: primitiveMesh(feature), feature }), ...extra };
};
const setup = (solids: Solid3D[], opts?: Fake3DOptions) => {
  const doc = new Drawing();
  doc.updateModel3D((m) => addSolids(m, solids));
  return fake3dContext(doc, opts);
};
const model = (ctx: Fake3DContext) => model3dOf(ctx.doc.snapshot);

describe('UNION / SUBTRACT / INTERSECT with the in-process Manifold kernel', () => {
  it('UNION of two overlapping boxes: one solid, one undo step, the first operand kept', async () => {
    const a = box(0, { layer: 'MISC', color: 4, name: 'base' }), b = box(1);
    const ctx = setup([a, b]);
    ctx.selection = new Set([a.id, b.id]);
    const tool = unionTool();
    await drive3d(tool, ctx, []);
    const [r, ...rest] = model(ctx).solids;
    expect(rest).toHaveLength(0);
    expect(r!.id).toBe(a.id);
    expect(r!).toMatchObject({ layer: 'MISC', color: 4, name: 'base' });
    expect(r!.feature).toEqual({ kind: 'boolean', op: 'union', operands: [a.feature, b.feature] });
    expect(meshIsClosed(r!.mesh)).toBe(true);
    expect(meshVolume(r!.mesh)).toBeCloseTo(12, 6);
    expect(ctx.prompts.some((p) => p.startsWith('Computing the union'))).toBe(true);
    expect(ctx.logs.at(-1)).toMatch(/2 solids combined into one \(volume 12\.0000\)/);
    expect(ctx.finished).toBe(true);
    // Undo restores both operands, as the same objects.
    ctx.doc.undo();
    expect(model(ctx).solids).toEqual([a, b]);
    expect(model(ctx).solids[0]).toBe(a);
  });

  it('folds three operands left to right', async () => {
    const a = box(0), b = box(1), c = box(2);
    const ctx = setup([a, b, c]);
    await drive3d(unionTool(), ctx, [{ select: [a.id, b.id, c.id] }]);
    const [r] = model(ctx).solids;
    expect(model(ctx).solids).toHaveLength(1);
    expect(r!.feature).toEqual({ kind: 'boolean', op: 'union', operands: [{ kind: 'boolean', op: 'union', operands: [a.feature, b.feature] }, c.feature] });
    expect(meshVolume(r!.mesh)).toBeCloseTo(16, 6);
  });

  it('SUBTRACT: the first set minus the second', async () => {
    const a = box(0), b = box(1);
    const ctx = setup([a, b]);
    await drive3d(subtractTool(), ctx, [{ select: [a.id] }, { select: [b.id] }]);
    const [r] = model(ctx).solids;
    expect(model(ctx).solids).toHaveLength(1);
    expect(r!.feature).toEqual({ kind: 'boolean', op: 'subtract', operands: [a.feature, b.feature] });
    expect(meshVolume(r!.mesh)).toBeCloseTo(4, 6);
    expect(meshIsClosed(r!.mesh)).toBe(true);
    expect(ctx.logs).toContain('Select solids to subtract from ..');
    expect(ctx.logs).toContain('Select solids to subtract ..');
  });

  it('INTERSECT: the common volume', async () => {
    const a = box(0), b = box(1);
    const ctx = setup([a, b]);
    await drive3d(intersectTool(), ctx, [{ select: [b.id, a.id] }]);
    const [r] = model(ctx).solids;
    expect(r!.id).toBe(b.id);
    expect(meshVolume(r!.mesh)).toBeCloseTo(4, 6);
    expect(r!.feature).toMatchObject({ kind: 'boolean', op: 'intersect' });
  });

  it('refuses input while computing and reports a disjoint intersection verbatim, model unchanged', async () => {
    const a = box(0), b = box(10);
    const ctx = setup([a, b]);
    const before = ctx.doc.snapshot;
    const tool = intersectTool();
    ctx.selection = new Set([a.id, b.id]);
    tool.start(ctx);
    expect(tool.computing).toBe(true);
    tool.onText('5', ctx);
    expect(ctx.logs.at(-1)).toMatch(/still computing/);
    await tool.idle();
    expect(ctx.logs).toContain('INTERSECT: The solids do not overlap, so their intersection is empty.');
    expect(ctx.logs).toContain('INTERSECT: the drawing is unchanged.');
    expect(ctx.doc.snapshot).toBe(before);
  });
});

describe('Boolean error paths', () => {
  it('a non-closed operand is refused by the kernel checks; the model is unchanged', async () => {
    const a = box(0), good = box(1);
    const open: Solid3D = { ...good, mesh: { positions: good.mesh.positions, indices: good.mesh.indices.slice(0, -3) } };
    const ctx = setup([a, open]);
    const before = ctx.doc.snapshot;
    await drive3d(unionTool(), ctx, [{ select: [a.id, open.id] }]);
    expect(ctx.logs.some((l) => l === 'UNION: The second solid cannot be used in the union: it is not a closed solid (its mesh has open or non-manifold edges).')).toBe(true);
    expect(ctx.doc.snapshot).toBe(before);
  });

  it('an unavailable kernel is reported verbatim; the model is unchanged', async () => {
    const a = box(0), b = box(1);
    const ctx = setup([a, b], { kernel: new UnavailableKernel('WebAssembly is disabled.') });
    const before = ctx.doc.snapshot;
    await drive3d(unionTool(), ctx, [{ select: [a.id, b.id] }]);
    expect(ctx.logs).toContain('UNION: Solid Boolean operations are unavailable in this environment: WebAssembly is disabled.');
    expect(ctx.doc.snapshot).toBe(before);
  });

  it('a context without a kernel, too few solids, and non-solids in the selection', async () => {
    const a = box(0), b = box(1);
    const doc = new Drawing();
    doc.updateModel3D((m) => addSolids(m, [a, b]));
    const plain = fakeContext(doc);
    await drive3d(unionTool(), plain, [{ select: [a.id, b.id] }]);
    expect(plain.logs.at(-1)).toMatch(/unavailable here: no geometry kernel/);
    const ctx = setup([a]);
    await drive3d(unionTool(), ctx, [{ select: [a.id, 'x1'] }]);
    expect(ctx.logs).toContain('1 object is not a 3D solid and was ignored.');
    expect(ctx.logs).toContain('UNION: select at least two solids (1 selected).');
    expect(ctx.kernelRequests).toBe(0);
  });

  it('applies nothing when an operand changed while the kernel was busy, or after Esc', async () => {
    const a = box(0), b = box(1);
    const ctx = setup([a, b]);
    const tool = unionTool();
    ctx.selection = new Set([a.id, b.id]);
    tool.start(ctx);
    ctx.doc.updateModel3D((m) => replaceSolid(m, { ...a, name: 'renamed' }));
    const edited = ctx.doc.snapshot;
    await tool.idle();
    expect(ctx.logs.at(-1)).toBe('UNION: the solids changed while the union was computed; nothing was applied.');
    expect(ctx.doc.snapshot).toBe(edited);

    const again = unionTool();
    const [a2, b2] = model(ctx).solids;
    ctx.selection = new Set([a2!.id, b2!.id]);
    again.start(ctx);
    again.onCancel(ctx);
    await again.idle();
    expect(ctx.doc.snapshot).toBe(edited);
    expect(ctx.logs.at(-1)).toMatch(/abandoned/);
  });
});
