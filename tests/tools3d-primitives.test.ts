import { beforeEach, describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { v3 } from '../src/model3d/math';
import { meshBounds, meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { model3dOf } from '../src/model3d/model';
import type { Solid3D } from '../src/model3d/types';
import { axesFrame } from '../src/tools3d/context';
import { boxTool, coneTool, cylinderTool, resetModellingDefaults, sphereTool, torusTool, wedgeTool } from '../src/tools3d/primitives';
import { fakeContext } from './fake-context';
import { type Fake3DContext, drive3d, fake3dContext } from './helpers/context3d';

const solids = (ctx: Fake3DContext): readonly Solid3D[] => model3dOf(ctx.doc.snapshot).solids;
const only = (ctx: Fake3DContext): Solid3D => {
  const s = solids(ctx);
  expect(s).toHaveLength(1);
  expect(meshIsClosed(s[0]!.mesh)).toBe(true);
  expect(meshVolume(s[0]!.mesh)).toBeGreaterThan(0);
  return s[0]!;
};
const bounds = (s: Solid3D) => meshBounds(s.mesh)!;
const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

beforeEach(() => resetModellingDefaults());

describe('BOX', () => {
  it('two corners and a typed height: the feature, a closed mesh, current layer and colour', async () => {
    const doc = new Drawing();
    doc.addLayer({ name: 'SOLIDS', color: 5, visible: true, locked: false, lineWeight: 0.25 });
    doc.setCurrentLayer('SOLIDS');
    doc.currentColor = 3;
    const ctx = fake3dContext(doc);
    await drive3d(boxTool(), ctx, [{ x: 0, y: 0 }, { x: 10, y: 5 }, '3']);
    const s = only(ctx);
    expect(s.feature).toMatchObject({ kind: 'box', width: 10, depth: 5, height: 3, frame: { origin: { x: 5, y: 2.5, z: 0 } } });
    near(meshVolume(s.mesh), 150);
    expect(s.layer).toBe('SOLIDS');
    expect(s.color).toBe(3);
    expect(ctx.finished).toBe(true);
    expect(ctx.prompts).toEqual(['Specify first corner or [Center]:', 'Specify other corner or [Cube/Length]:', 'Specify height or [2Point]:']);
    // One undo step.
    doc.undo();
    expect(solids(ctx)).toHaveLength(0);
  });

  it('typed coordinates, the last height as default, and Enter to accept it', async () => {
    const ctx = fake3dContext();
    await drive3d(boxTool(), ctx, ['0,0', '10,10', '5']);
    await drive3d(boxTool(), ctx, ['20,0', '@2,2', '']);
    const [a, b] = solids(ctx);
    near(meshVolume(a!.mesh), 500);
    near(meshVolume(b!.mesh), 20);
    expect(ctx.prompts.at(-1)).toBe('Specify height or [2Point] <5.0000>:');
  });

  it('Cube, Length and Center options', async () => {
    const ctx = fake3dContext();
    await drive3d(boxTool(), ctx, ['0,0', 'C', '4']);
    await drive3d(boxTool(), ctx, ['10,0', 'L', '6', '2', '3']);
    await drive3d(boxTool(), ctx, ['C', '0,0,10', '2,3', '4']);
    const [cube, len, centered] = solids(ctx);
    near(meshVolume(cube!.mesh), 64);
    expect(bounds(cube!)).toEqual({ min: v3(0, 0, 0), max: v3(4, 4, 4) });
    near(meshVolume(len!.mesh), 36);
    expect(bounds(len!)).toEqual({ min: v3(10, 0, 0), max: v3(16, 2, 3) });
    expect(bounds(centered!)).toEqual({ min: v3(-2, -3, 8), max: v3(2, 3, 12) });
  });

  it('an other corner off the plane gives the height; a negative height builds below', async () => {
    const ctx = fake3dContext();
    await drive3d(boxTool(), ctx, ['0,0', '2,3,4']);
    await drive3d(boxTool(), ctx, ['5,0', '7,2', '-3']);
    const [a, b] = solids(ctx);
    expect(bounds(a!)).toEqual({ min: v3(0, 0, 0), max: v3(2, 3, 4) });
    const bb = bounds(b!);
    near(bb.min.z, -3);
    near(bb.max.z, 0);
  });

  it('2Point height, and errors reported on the command line with the prompt repeated', async () => {
    const ctx = fake3dContext();
    await drive3d(boxTool(), ctx, ['0,0', '0,5', 'abc', '3,5', '0', '2P', '0,0,0', '0,0,7']);
    expect(ctx.logs.some((l) => /non-zero length and width/.test(l))).toBe(true);
    expect(ctx.logs.some((l) => /Invalid input "abc"/.test(l))).toBe(true);
    expect(ctx.logs.some((l) => /Height must be a non-zero/.test(l))).toBe(true);
    expect(only(ctx).feature).toMatchObject({ kind: 'box', width: 3, depth: 5, height: 7 });
  });

  it('works on another construction plane (XZ: the base stands on the front plane)', async () => {
    const ctx = fake3dContext(new Drawing(), { plane: axesFrame('XZ') });
    await drive3d(boxTool(), ctx, ['0,0', '4,2', '3']);
    const b = bounds(only(ctx));
    expect(b.min.x).toBeCloseTo(0, 12);
    expect(b.max.x).toBeCloseTo(4, 12);
    expect(b.min.z).toBeCloseTo(0, 12);
    expect(b.max.z).toBeCloseTo(2, 12);
    // Height along the plane normal (-Y).
    expect(b.min.y).toBeCloseTo(-3, 12);
    expect(b.max.y).toBeCloseTo(0, 12);
  });

  it('a 3D pick (a solid face under the cursor) and a cursor ray give 3D points and heights', async () => {
    const ctx = fake3dContext();
    ctx.picks.push({ p2: { x: 1, y: 1 }, point: v3(1, 1, 5), ray: { origin: v3(1, 1, 50), dir: v3(0, 0, -1) }, hit: null });
    // Ray from the side at height 4 passing over the base centre (2, 2): the height is 4.
    ctx.picks.push({ p2: { x: 9, y: 9 }, point: v3(9, 9, 0), ray: { origin: v3(2, -100, 9), dir: v3(0, 1, 0) }, hit: null });
    await drive3d(boxTool(), ctx, [{ x: 1, y: 1 }, '3,3', { x: 9, y: 9 }]);
    const b = bounds(only(ctx));
    expect(b).toEqual({ min: v3(1, 1, 5), max: v3(3, 3, 9) });
  });

  it('shows a ghost while the cursor moves and clears it at the end; the ghost is not in the model', async () => {
    const ctx = fake3dContext();
    const tool = boxTool();
    await drive3d(tool, ctx, ['0,0', { move: { x: 3, y: 2 } }]);
    expect(ctx.preview3d).toHaveLength(1);
    expect(solids(ctx)).toHaveLength(0);
    tool.onPoint({ x: 3, y: 2 }, ctx);
    tool.onMove({ x: 3, y: 7 }, ctx);
    expect(ctx.preview3d).toHaveLength(1);
    // Plan view (no cursor ray): the in-plane distance from the base centre (1.5, 1).
    expect((ctx.preview3d[0]!.feature as { height: number }).height).toBeCloseTo(Math.hypot(1.5, 6), 12);
    tool.onText('6', ctx);
    expect(ctx.preview3d).toEqual([]);
    expect(solids(ctx)).toHaveLength(1);
  });

  it('runs on a plain 2D context too (WCS XY, z = 0) and refuses paper space', async () => {
    const ctx = fakeContext();
    await drive3d(boxTool(), ctx, ['0,0', '1,1', '1']);
    expect(model3dOf(ctx.doc.snapshot).solids).toHaveLength(1);
    const paper = fake3dContext();
    paper.doc.setSpace({ layout: 'Layout1' });
    await drive3d(boxTool(), paper, ['0,0']);
    expect(paper.logs.some((l) => /model space only/.test(l))).toBe(true);
  });
});

describe('WEDGE', () => {
  it('half a box, closed, the tall face at the first corner', async () => {
    const ctx = fake3dContext();
    await drive3d(wedgeTool(), ctx, ['0,0', '4,2', '3']);
    await drive3d(wedgeTool(), ctx, ['10,0', '6,2', '3']);
    const [a, b] = solids(ctx);
    near(meshVolume(a!.mesh), 12);
    near(meshVolume(b!.mesh), 12);
    expect(ctx.prompts[0]).toBe('Specify first corner of wedge or [Center]:');
    // Highest vertex at the first corner's x in both.
    const topX = (s: Solid3D) => {
      const p = s.mesh.positions;
      let best = -Infinity, x = NaN;
      for (let i = 0; i < p.length; i += 3) if (p[i + 2]! > best + 1e-9) { best = p[i + 2]!; x = p[i]!; }
      return x;
    };
    near(topX(a!), 0);
    near(topX(b!), 10);
  });
});

describe('CYLINDER and CONE', () => {
  it('center, radius (typed or Diameter), height', async () => {
    const ctx = fake3dContext();
    await drive3d(cylinderTool(), ctx, ['0,0', '2', '5']);
    await drive3d(cylinderTool(), ctx, ['10,0', 'D', '4', '3']);
    await drive3d(cylinderTool(), ctx, ['20,0', { x: 23, y: 4 }, '1']);
    const [a, b, c] = solids(ctx);
    expect(a!.feature).toMatchObject({ kind: 'cylinder', radius: 2, height: 5 });
    expect(b!.feature).toMatchObject({ kind: 'cylinder', radius: 2, height: 3 });
    expect(c!.feature).toMatchObject({ kind: 'cylinder', radius: 5, height: 1 });
    const n = 32;
    near(meshVolume(a!.mesh), (n / 2) * 4 * Math.sin((2 * Math.PI) / n) * 5, 1e-9);
    expect(ctx.prompts).toContain('Specify base radius or [Diameter] <2.0000>:');
    expect(ctx.prompts).toContain('Specify height or [2Point/Axis endpoint] <5.0000>:');
  });

  it('Axis endpoint sets direction and height', async () => {
    const ctx = fake3dContext();
    await drive3d(cylinderTool(), ctx, ['0,0', '1', 'A', '3,0,0']);
    const s = only(ctx);
    const b = bounds(s);
    near(b.min.x, 0);
    near(b.max.x, 3);
    expect(s.feature).toMatchObject({ kind: 'cylinder', radius: 1, height: 3, frame: { zAxis: { x: 1, y: 0, z: 0 } } });
  });

  it('rejects a zero or negative radius and asks again', async () => {
    const ctx = fake3dContext();
    await drive3d(cylinderTool(), ctx, ['0,0', '0', '-1', '1', '1']);
    expect(ctx.logs.filter((l) => /Value must be positive/.test(l))).toHaveLength(2);
    expect(only(ctx).feature).toMatchObject({ radius: 1, height: 1 });
  });

  it('CONE with a top radius is a frustum; without, a pointed cone', async () => {
    const ctx = fake3dContext();
    await drive3d(coneTool(), ctx, ['0,0', '2', 'T', '1', '4']);
    resetModellingDefaults();
    await drive3d(coneTool(), ctx, ['10,0', '2', '4']);
    const [f, c] = solids(ctx);
    expect(f!.feature).toMatchObject({ kind: 'cone', baseRadius: 2, topRadius: 1, height: 4 });
    expect(c!.feature).toMatchObject({ kind: 'cone', baseRadius: 2, topRadius: 0, height: 4 });
    for (const s of [f!, c!]) expect(meshIsClosed(s.mesh)).toBe(true);
    expect(ctx.prompts).toContain('Specify height or [2Point/Axis endpoint/Top radius]:');
  });
});

describe('SPHERE and TORUS', () => {
  it('SPHERE: center and radius or diameter', async () => {
    const ctx = fake3dContext();
    await drive3d(sphereTool(), ctx, ['0,0,5', '3']);
    await drive3d(sphereTool(), ctx, ['10,0', 'D', '2']);
    const [a, b] = solids(ctx);
    expect(a!.feature).toMatchObject({ kind: 'sphere', radius: 3, frame: { origin: { x: 0, y: 0, z: 5 } } });
    expect(b!.feature).toMatchObject({ kind: 'sphere', radius: 1 });
    near(bounds(a!).max.z, 8);
    for (const s of [a!, b!]) expect(meshIsClosed(s.mesh)).toBe(true);
  });

  it('TORUS: radius and tube radius; a tube as wide as the ring is refused', async () => {
    const ctx = fake3dContext();
    await drive3d(torusTool(), ctx, ['0,0', '5', '6', '1']);
    expect(ctx.logs.some((l) => /tube radius must be positive and smaller/.test(l))).toBe(true);
    const s = only(ctx);
    expect(s.feature).toMatchObject({ kind: 'torus', majorRadius: 5, minorRadius: 1 });
    expect(ctx.prompts).toContain('Specify tube radius or [2Point/Diameter]:');
  });
});
