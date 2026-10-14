/**
 * Milestone 4 Properties palette parameter rows (src/tools3d/properties-edit.ts): rows per
 * feature kind, edits that re-evaluate and keep the solid's id (primitives and sweeps in-process,
 * Booleans through the kernel with the "Computing…" guard), refused values, undo.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { meshTriangleCount, meshVolume } from '../src/model3d/mesh';
import { addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { evaluateFeature } from '../src/model3d/feature-eval';
import type { Feature3D, PrimitiveFeature, Solid3D } from '../src/model3d/types';
import { type GeometryKernel, KernelError } from '../src/model3d/kernel/kernel';
import {
  MAX_PARAMETER_ROWS, evaluateLocal, parameterRows, parameterText, parseParameter, setSolidParameter, solidParameterTool, withParameter,
} from '../src/tools3d/properties-edit';
import type { Tool } from '../src/tools/types';
import { directKernel, drive3d, fake3dContext } from './helpers/context3d';

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature => ({
  kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x0 + w / 2, y0 + d / 2, z0) }, width: w, depth: d, height: h,
});
const solidOf = (f: Feature3D): Solid3D => newSolid({ mesh: evaluateLocal(f), feature: f });
function docWith(...solids: Solid3D[]): Drawing {
  const doc = new Drawing();
  doc.updateModel3D((m) => addSolids(m, solids));
  return doc;
}
const only = (doc: Drawing) => model3dOf(doc.snapshot).solids[0]!;

describe('parameterRows', () => {
  it('lists the editable parameters per kind', () => {
    expect(parameterRows(box(0, 0, 0, 1, 2, 3)).map((r) => [r.label, r.key, r.value])).toEqual([
      ['Width', '/width', 1], ['Depth', '/depth', 2], ['Height', '/height', 3],
    ]);
    expect(parameterRows({ kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 2 }).map((r) => r.label)).toEqual(['Radius', 'Height', 'Segments']);
    expect(parameterRows({ kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 2 })[2]!.value).toBe(32);
    expect(parameterRows({ kind: 'torus', frame: WORLD_XY_FRAME, majorRadius: 3, minorRadius: 1 }).map((r) => r.label)).toEqual(['Radius', 'Tube radius', 'Segments']);
    expect(parameterRows({ kind: 'cone', frame: WORLD_XY_FRAME, baseRadius: 1, topRadius: 0, height: 2 }).map((r) => r.label)).toEqual(['Base radius', 'Top radius', 'Height', 'Segments']);
    expect(parameterRows({ kind: 'mesh', source: 'imported' })).toEqual([]);
    const rev = parameterRows({ kind: 'revolve', profile: { frame: WORLD_XY_FRAME, loops: [] }, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI / 2 });
    expect(rev[0]).toMatchObject({ label: 'Angle', kind: 'angle', value: 90 });
    expect(parameterText(rev[0]!)).toBe('90.0000');
    expect(parameterText(rev[1]!)).toBe('32');
  });

  it('Boolean solids list their operands by path; long trees are capped', () => {
    const f: Feature3D = { kind: 'boolean', op: 'subtract', operands: [box(0, 0, 0, 4, 4, 1), { kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 3 }] };
    const rows = parameterRows(f);
    expect(rows.map((r) => r.key)).toEqual(['0/width', '0/depth', '0/height', '1/radius', '1/height', '1/segments']);
    expect(rows[3]!.label).toBe('Operand 2 (Cylinder) radius');
    let deep: Feature3D = box(0, 0, 0, 1, 1, 1);
    for (let i = 0; i < 20; i++) deep = { kind: 'boolean', op: 'union', operands: [deep, box(i, 0, 0, 1, 1, 1)] };
    expect(parameterRows(deep)).toHaveLength(MAX_PARAMETER_ROWS);
  });

  it('withParameter validates values and keys', () => {
    expect(withParameter(box(0, 0, 0, 1, 1, 1), '/width', 5)).toMatchObject({ width: 5 });
    expect(() => withParameter(box(0, 0, 0, 1, 1, 1), '/width', 0)).toThrow(/positive/);
    expect(() => withParameter(box(0, 0, 0, 1, 1, 1), '/width', Number.NaN)).toThrow(RangeError);
    expect(() => withParameter(box(0, 0, 0, 1, 1, 1), '/radius', 1)).toThrow(/Unknown parameter/);
    expect(() => withParameter(box(0, 0, 0, 1, 1, 1), '3/width', 1)).toThrow(/Unknown parameter/);
    const cone: Feature3D = { kind: 'cone', frame: WORLD_XY_FRAME, baseRadius: 1, topRadius: 0.5, height: 2 };
    const pointedDown = withParameter(cone, '/baseRadius', 0);
    expect(pointedDown).toMatchObject({ baseRadius: 0, topRadius: 0.5 });
    expect(() => withParameter(pointedDown, '/topRadius', 0)).toThrow(/base radius or a top radius/);
    expect(() => withParameter({ kind: 'torus', frame: WORLD_XY_FRAME, majorRadius: 3, minorRadius: 1 }, '/minorRadius', 3)).toThrow(/smaller than the torus radius/);
    expect(withParameter({ kind: 'extrude', profile: { frame: WORLD_XY_FRAME, loops: [] }, distance: 2 }, '/distance', -3)).toMatchObject({ distance: -3 });
    const rev: Feature3D = { kind: 'revolve', profile: { frame: WORLD_XY_FRAME, loops: [] }, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: 1 };
    expect(() => withParameter(rev, '/angle', 400)).toThrow(/at most 360/);
    expect(() => withParameter(rev, '/angle', 0)).toThrow(/non-zero/);
    expect(() => withParameter(rev, '/segments', 2.5)).toThrow(/whole number/);
    expect(() => parseParameter('count', '2.5', 'Segments')).toThrow(/whole number/);
    expect(() => parseParameter('count', '1000', 'Segments')).toThrow(/whole number/);
    expect(() => parseParameter('angle', '0', 'Angle')).toThrow(/non-zero/);
    expect(() => parseParameter('length', 'abc', 'Width')).toThrow(/must be a number/);
    expect(parseParameter('length', '1\'-6"', 'Width')).toBe(18);
  });
});

describe('setSolidParameter (the palette edit)', () => {
  const host = (doc: Drawing, tool: Tool | null = null) => {
    const logs: string[] = [];
    const started: Tool[] = [];
    return { logs, started, h: { doc, tool, log: (t: string) => void logs.push(t), startTool: (t: Tool) => void started.push(t) } };
  };

  it('applies primitives in place without starting a command, even while one runs', () => {
    const s = solidOf(box(0, 0, 0, 2, 2, 2));
    const doc = docWith(s);
    const running = { name: 'LINE' } as Tool;
    const { h, logs, started } = host(doc, running);
    expect(setSolidParameter(h, s.id, '/height', '5')).toBe('applied');
    expect(only(doc)).toMatchObject({ id: s.id, feature: { height: 5 } });
    expect(started).toEqual([]);
    expect(setSolidParameter(h, s.id, '/height', 'x')).toBe('refused');
    expect(logs.at(-1)).toMatch(/must be a number/);
  });

  it('a Boolean starts the PROPERTIES command, and is refused while another command runs', async () => {
    const f: Feature3D = { kind: 'boolean', op: 'union', operands: [box(0, 0, 0, 2, 2, 2), box(1, 0, 0, 2, 2, 2)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const doc = docWith(s);
    const busy = host(doc, { name: 'LINE' } as Tool);
    expect(setSolidParameter(busy.h, s.id, '0/width', '3')).toBe('refused');
    expect(busy.logs.at(-1)).toMatch(/finish or cancel the running command/);
    expect(busy.started).toEqual([]);
    const idle = host(doc);
    expect(setSolidParameter(idle.h, s.id, '0/width', '3')).toBe('computing');
    expect(idle.started.map((t) => t.name)).toEqual(['PROPERTIES']);
    expect(only(doc)).toBe(s);
  });
});

describe('solidParameterTool', () => {
  it('re-evaluates a primitive in place, keeps the id, one undo step', async () => {
    const s = solidOf(box(0, 0, 0, 10, 10, 5));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(solidParameterTool(s.id, '/width', '6'), ctx, []);
    const e = only(doc);
    expect(e.id).toBe(s.id);
    expect(e.feature).toMatchObject({ kind: 'box', width: 6 });
    expect(meshVolume(e.mesh)).toBeCloseTo(300, 9);
    expect(ctx.logs).toEqual(['PROPERTIES: Width = 6.0000.']);
    doc.undo();
    expect(only(doc)).toBe(s);
  });

  it('segments and sweep parameters', async () => {
    const cyl = solidOf({ kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 2 });
    const ext = solidOf({ kind: 'extrude', profile: { frame: WORLD_XY_FRAME, loops: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]] }, distance: 2 });
    const rev = solidOf({ kind: 'revolve', profile: { frame: WORLD_XY_FRAME, loops: [[{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }]] }, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: 2 * Math.PI });
    const doc = docWith(cyl, ext, rev);
    const ctx = fake3dContext(doc);
    await drive3d(solidParameterTool(cyl.id, '/segments', '12'), ctx, []);
    const c = model3dOf(doc.snapshot).solids[0]!;
    expect(c.feature).toMatchObject({ segments: 12 });
    expect(meshTriangleCount(c.mesh)).toBe(12 * 4);
    await drive3d(solidParameterTool(ext.id, '/distance', '-5'), ctx, []);
    expect(meshVolume(model3dOf(doc.snapshot).solids[1]!.mesh)).toBeCloseTo(60, 9);
    await drive3d(solidParameterTool(rev.id, '/angle', '90'), ctx, []);
    const r = model3dOf(doc.snapshot).solids[2]!;
    expect(r.feature).toMatchObject({ angle: Math.PI / 2 });
    expect(r.id).toBe(rev.id);
    expect(ctx.logs).toContain('PROPERTIES: Angle = 90.0000.');
  });

  it('refuses invalid values with a message and leaves the solid unchanged', async () => {
    const s = solidOf(box(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    for (const [key, text] of [['/width', '-1'], ['/width', 'abc'], ['/height', '0'], ['/radius', '2']] as const) {
      await drive3d(solidParameterTool(s.id, key, text), ctx, []);
    }
    expect(only(doc)).toBe(s);
    expect(ctx.logs).toEqual([
      'PROPERTIES: Width must be positive and finite (got -1). The solid is unchanged.',
      'PROPERTIES: Width must be a number (got "abc"). The solid is unchanged.',
      'PROPERTIES: Height must be positive and finite (got 0). The solid is unchanged.',
      'PROPERTIES: this solid has no parameter /radius.',
    ]);
    await drive3d(solidParameterTool('gone', '/width', '1'), ctx, []);
    expect(ctx.logs.at(-1)).toBe('PROPERTIES: the solid gone no longer exists.');
  });

  it('a Boolean operand edit re-runs the kernel behind "Computing…", keeping the id', async () => {
    const f: Feature3D = { kind: 'boolean', op: 'union', operands: [box(0, 0, 0, 2, 2, 2), box(1, 0, 0, 2, 2, 2)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    const tool = solidParameterTool(s.id, '1/width', '4');
    tool.start(ctx);
    expect(tool.computing).toBe(true);
    expect(ctx.prompts.at(-1)).toBe('Computing the solid… (Esc abandons it)');
    tool.onText('5', ctx);
    expect(ctx.logs.at(-1)).toMatch(/still computing/);
    await tool.idle();
    const e = only(doc);
    expect(e.id).toBe(s.id);
    // Union of x 0..2 and x 0..4 (the second box now 4 wide around x = 2): x 0..4, volume 16.
    expect(meshVolume(e.mesh)).toBeCloseTo(16, 6);
    expect(e.feature).toMatchObject({ kind: 'boolean', operands: [{ width: 2 }, { width: 4 }] });
    doc.undo();
    expect(only(doc)).toBe(s);
  });

  it('Esc abandons a Boolean re-evaluation; kernel errors leave the solid unchanged', async () => {
    const f: Feature3D = { kind: 'boolean', op: 'intersect', operands: [box(0, 0, 0, 2, 2, 2), box(1, 0, 0, 2, 2, 2)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    const tool = solidParameterTool(s.id, '0/width', '3');
    tool.start(ctx);
    tool.onCancel(ctx);
    await tool.idle();
    expect(only(doc)).toBe(s);
    expect(ctx.logs.at(-1)).toMatch(/abandoned/);
    // A kernel failure (here a stand-in kernel that always fails) is reported verbatim.
    const failing: GeometryKernel = {
      name: 'failing',
      ready: () => directKernel().ready(),
      boolean: () => Promise.reject(new KernelError('empty-result', 'The solids do not overlap, so their intersection is empty.')),
      dispose: () => {},
    };
    const ctx2 = fake3dContext(doc, { kernel: failing });
    await drive3d(solidParameterTool(s.id, '0/width', '3'), ctx2, []);
    expect(ctx2.logs).toEqual(['PROPERTIES: The solids do not overlap, so their intersection is empty.', 'PROPERTIES: the solid is unchanged.']);
    expect(only(doc)).toBe(s);
  });
});
