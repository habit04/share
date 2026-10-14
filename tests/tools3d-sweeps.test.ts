import { beforeEach, describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { WORLD_XY_FRAME } from '../src/model3d/math';
import { meshBounds, meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { model3dOf } from '../src/model3d/model';
import { profileFromEntities } from '../src/model3d/sketch';
import type { Solid3D } from '../src/model3d/types';
import { axesFrame } from '../src/tools3d/context';
import { extrudeTool, resetSweepDefaults, revolveTool } from '../src/tools3d/sweeps';
import { type Fake3DContext, drive3d, fake3dContext } from './helpers/context3d';

const base = () => ({ id: newId(), layer: '0', color: 'ByLayer' as const });
const pline = (pts: [number, number][], closed = true): Entity => ({ ...base(), type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), closed });
const circle = (x: number, y: number, r: number): Entity => ({ ...base(), type: 'circle', center: { x, y }, radius: r });
const solids = (ctx: Fake3DContext): readonly Solid3D[] => model3dOf(ctx.doc.snapshot).solids;
const withEntities = (...es: Entity[]) => {
  const doc = new Drawing();
  doc.addEntities(es);
  return fake3dContext(doc);
};
/** Volume of a solid of revolution of an inscribed n-gon ring: n/2 sin(2 pi / n) (r2^2 - r1^2) h. */
const ringVolume = (r1: number, r2: number, h: number, n = 32) => (n / 2) * Math.sin((2 * Math.PI) / n) * (r2 * r2 - r1 * r1) * h;

beforeEach(() => resetSweepDefaults());

describe('EXTRUDE', () => {
  it('a closed polyline by a typed height; the source is kept and the command says so', async () => {
    const rect = pline([[0, 0], [4, 0], [4, 3], [0, 3]]);
    const ctx = withEntities(rect);
    await drive3d(extrudeTool(), ctx, [{ select: [rect.id] }, '2']);
    const [s] = solids(ctx);
    expect(s!.feature).toMatchObject({ kind: 'extrude', distance: 2 });
    expect(meshIsClosed(s!.mesh)).toBe(true);
    expect(meshVolume(s!.mesh)).toBeCloseTo(24, 9);
    expect(ctx.doc.entities.map((e) => e.id)).toEqual([rect.id]);
    expect(ctx.logs.some((l) => /Source objects are kept/.test(l))).toBe(true);
    expect(ctx.prompts).toContain('Select objects to extrude:');
    expect(ctx.prompts).toContain('Specify height of extrusion or [Delete]:');
  });

  it('a circle, with the pick-first selection', async () => {
    const c = circle(5, 5, 1);
    const ctx = withEntities(c);
    ctx.selection = new Set([c.id]);
    await drive3d(extrudeTool(), ctx, ['3']);
    const [s] = solids(ctx);
    expect(meshIsClosed(s!.mesh)).toBe(true);
    expect(meshVolume(s!.mesh)).toBeCloseTo(ringVolume(0, 1, 3), 9);
    expect(meshBounds(s!.mesh)!.max.z).toBeCloseTo(3, 12);
  });

  it('Delete removes the source in the same undo step; two points give the height', async () => {
    const rect = pline([[0, 0], [2, 0], [2, 2], [0, 2]]);
    const ctx = withEntities(rect);
    await drive3d(extrudeTool(), ctx, [{ select: [rect.id] }, 'D', '0,0', '0,5']);
    expect(ctx.logs).toContain('Source objects will be deleted.');
    expect(ctx.doc.entities).toHaveLength(0);
    const [s] = solids(ctx);
    expect(meshVolume(s!.mesh)).toBeCloseTo(20, 9);
    ctx.doc.undo();
    expect(solids(ctx)).toHaveLength(0);
    expect(ctx.doc.entities.map((e) => e.id)).toEqual([rect.id]);
  });

  it('shows the profile error verbatim and leaves the drawing unchanged (open polyline)', async () => {
    const open = pline([[0, 0], [4, 0], [4, 3]], false);
    const ctx = withEntities(open);
    const before = ctx.doc.snapshot;
    await drive3d(extrudeTool(), ctx, [{ select: [open.id] }]);
    const expected = profileFromEntities([open], WORLD_XY_FRAME);
    expect('error' in expected).toBe(true);
    expect(ctx.logs).toContain((expected as { error: string }).error);
    expect(ctx.doc.snapshot).toBe(before);
    expect(ctx.finished).toBe(true);
  });

  it('builds on WCS XY (and says so) when the construction plane is not the drawing plane', async () => {
    const rect = pline([[0, 0], [1, 0], [1, 1], [0, 1]]);
    const ctx = withEntities(rect);
    ctx.plane = axesFrame('XZ');
    await drive3d(extrudeTool(), ctx, [{ select: [rect.id] }, '1']);
    expect(ctx.logs.some((l) => /profile is built on that plane/.test(l))).toBe(true);
    expect(meshVolume(solids(ctx)[0]!.mesh)).toBeCloseTo(1, 9);
  });

  it('ignores solids in the selection and refuses an empty 2D set', async () => {
    const ctx = fake3dContext();
    await drive3d(extrudeTool(), ctx, [{ select: ['nothing'] }]);
    expect(ctx.logs).toContain('EXTRUDE: no 2D objects selected.');
  });
});

describe('REVOLVE', () => {
  it('a rectangle about the plane Y axis, full turn by default', async () => {
    const rect = pline([[1, 0], [2, 0], [2, 3], [1, 3]]);
    const ctx = withEntities(rect);
    await drive3d(revolveTool(), ctx, [{ select: [rect.id] }, 'Y', '']);
    const [s] = solids(ctx);
    expect(s!.feature).toMatchObject({ kind: 'revolve', angle: 2 * Math.PI, axis: { dir: { x: 0, y: 1, z: 0 } } });
    expect(meshIsClosed(s!.mesh)).toBe(true);
    expect(meshVolume(s!.mesh)).toBeCloseTo(ringVolume(1, 2, 3), 9);
    expect(ctx.prompts).toContain('Specify angle of revolution or [Reverse/Delete] <360>:');
  });

  it('two axis points and a half turn; Reverse turns the other way', async () => {
    const rect = pline([[1, 0], [2, 0], [2, 3], [1, 3]]);
    const ctx = withEntities(rect);
    await drive3d(revolveTool(), ctx, [{ select: [rect.id] }, '0,0', '0,1', '180']);
    await drive3d(revolveTool(), ctx, [{ select: [rect.id] }, '0,0', '0,1', 'R', '180']);
    const [a, b] = solids(ctx);
    expect(meshVolume(a!.mesh)).toBeCloseTo(ringVolume(1, 2, 3) / 2, 9);
    expect(meshIsClosed(a!.mesh)).toBe(true);
    expect((a!.feature as { angle: number }).angle).toBeCloseTo(Math.PI, 12);
    expect((b!.feature as { angle: number }).angle).toBeCloseTo(-Math.PI, 12);
    // The two half turns end on opposite sides of the drawing plane z = 0.
    expect(Math.sign(meshBounds(a!.mesh)!.min.z + meshBounds(a!.mesh)!.max.z)).toBe(-Math.sign(meshBounds(b!.mesh)!.min.z + meshBounds(b!.mesh)!.max.z));
  });

  it('reports a bad axis with the sweep message and asks for the axis again', async () => {
    const rect = pline([[1, 0], [2, 0], [2, 3], [1, 3]]);
    const ctx = withEntities(rect);
    // The plane Z axis is perpendicular to the profile.
    await drive3d(revolveTool(), ctx, [{ select: [rect.id] }, 'Z', '360', 'Y', '90']);
    expect(ctx.logs.some((l) => /^REVOLVE: Cannot revolve: the axis must lie in the plane of the profile\.$/.test(l))).toBe(true);
    expect(solids(ctx)).toHaveLength(1);
    expect(ctx.prompts.filter((p) => p.startsWith('Specify axis start point'))).toHaveLength(2);
  });

  it('rejects an angle of 0 or beyond a full turn', async () => {
    const rect = pline([[1, 0], [2, 0], [2, 3], [1, 3]]);
    const ctx = withEntities(rect);
    await drive3d(revolveTool(), ctx, [{ select: [rect.id] }, 'Y', '0', '400', '90']);
    expect(ctx.logs.filter((l) => /angle of revolution must be/.test(l))).toHaveLength(2);
    expect(solids(ctx)).toHaveLength(1);
  });
});

describe('triangle budget', () => {
  it('REVOLVE of a huge profile: a full turn is refused with the budget message, a half turn fits', async () => {
    // 8,000 points on a circle of radius 100 around (200, 0): 2 x 8,000 x 32 = 512,000 triangles
    // for a full turn (over MAX_SOLID_TRIANGLES), about 272,000 for half a turn.
    const n = 8000;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([200 + 100 * Math.cos((2 * Math.PI * i) / n), 100 * Math.sin((2 * Math.PI * i) / n)]);
    const ring = pline(pts);
    const ctx = withEntities(ring);
    await drive3d(revolveTool(), ctx, [{ select: [ring.id] }, 'Y', '', '180']);
    expect(ctx.logs.some((l) => /^REVOLVE: The revolution would have 512,000 triangles; the safe limit is 500,000 per solid\. Try a smaller angle/.test(l))).toBe(true);
    // The axis was kept: only the angle was asked again.
    expect(ctx.prompts.filter((p) => p.startsWith('Specify axis start point'))).toHaveLength(1);
    expect(ctx.prompts.filter((p) => p.startsWith('Specify angle of revolution'))).toHaveLength(2);
    expect(solids(ctx)).toHaveLength(1);
    expect(meshIsClosed(solids(ctx)[0]!.mesh)).toBe(true);
  }, 30_000);
});
