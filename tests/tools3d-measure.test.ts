/**
 * Milestone 4 measurement (src/tools3d/measure.ts): 3DDIST, 3DMASSPROP and 3DAREA through their
 * prompts with typed values, against analytic values, plus the pure helpers.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { addSolids, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { PrimitiveFeature, Solid3D } from '../src/model3d/types';
import { pickSolid } from '../src/render3d/picking';
import { axesFrame } from '../src/tools3d/context';
import { area3dTool, boundsInFrame, dist3dTool, massProp3dTool, measureDistance, meshMassProperties } from '../src/tools3d/measure';
import { rotationAbout, transformSolid } from '../src/tools3d/solid-edit';
import { drive3d, fake3dContext } from './helpers/context3d';

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature => ({
  kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x0 + w / 2, y0 + d / 2, z0) }, width: w, depth: d, height: h,
});
const solidOf = (f: PrimitiveFeature): Solid3D => newSolid({ mesh: primitiveMesh(f), feature: f });
function docWith(...solids: Solid3D[]): Drawing {
  const doc = new Drawing();
  doc.updateModel3D((m) => addSolids(m, solids));
  return doc;
}

describe('3DDIST', () => {
  it('reports distance, deltas, angles and the planar distance', async () => {
    const ctx = fake3dContext();
    await drive3d(dist3dTool(), ctx, ['0,0,0', '3,4,12']);
    expect(ctx.logs).toEqual([
      'Distance = 13.0000, Angle in XY Plane = 53.13, Angle from XY Plane = 67.38',
      'Delta X = 3.0000, Delta Y = 4.0000, Delta Z = 12.0000',
      'Planar distance (XY plane of the World construction plane) = 5.0000',
    ]);
    expect(ctx.finished).toBe(true);
  });

  it('measures below the plane (negative elevation) and in construction-plane coordinates', async () => {
    const ctx = fake3dContext(new Drawing(), { plane: axesFrame('XZ') });
    ctx.planeName = 'XZ';
    // Plane coordinates: x along world X, y along world Z, z along world -Y.
    await drive3d(dist3dTool(), ctx, ['1,1,1', '1,1,-1']);
    expect(ctx.logs[0]).toBe('Distance = 2.0000, Angle in XY Plane = 0.00, Angle from XY Plane = -90.00');
    expect(ctx.logs[2]).toBe('Planar distance (XY plane of the XZ construction plane) = 0.0000');
    const m = measureDistance(axesFrame('XZ'), v3(0, 0, 0), v3(0, -2, 0));
    expect(m.delta).toEqual(v3(0, 0, 2));
  });

  it('uses the drawing units (architectural) and ends on Enter', async () => {
    const doc = new Drawing();
    doc.setHeader({ units: { ...doc.header.units, lunits: 4, luprec: 0 } });
    const ctx = fake3dContext(doc);
    await drive3d(dist3dTool(), ctx, ['0,0,0', '0,0,30']);
    expect(ctx.logs[0]).toMatch(/^Distance = 2'-6"/);
    const ctx2 = fake3dContext();
    await drive3d(dist3dTool(), ctx2, ['']);
    expect(ctx2.logs).toEqual([]);
    expect(ctx2.finished).toBe(true);
  });

  it('refuses text that is not a point', async () => {
    const ctx = fake3dContext();
    await drive3d(dist3dTool(), ctx, ['nonsense', '0,0', '1,0']);
    expect(ctx.logs[0]).toBe('Invalid input "nonsense": requires a point.');
    expect(ctx.logs[1]).toMatch(/^Distance = 1\.0000/);
  });
});

describe('mass properties', () => {
  it('box: volume, area and centroid are exact, also after a rotation', () => {
    const s = solidOf(box(1, 2, 3, 2, 3, 4));
    const mp = meshMassProperties(s.mesh);
    expect(mp.volume).toBeCloseTo(24, 12);
    expect(mp.area).toBeCloseTo(52, 12);
    expect(mp.centroid.x).toBeCloseTo(2, 12);
    expect(mp.centroid.y).toBeCloseTo(3.5, 12);
    expect(mp.centroid.z).toBeCloseTo(5, 12);
    const r = transformSolid(s, rotationAbout(v3(0, 0, 0), v3(1, 1, 1), 1.1));
    const mr = meshMassProperties(r.mesh);
    expect(mr.volume).toBeCloseTo(24, 9);
    expect(mr.area).toBeCloseTo(52, 9);
    const b = boundsInFrame(s.mesh, WORLD_XY_FRAME)!;
    expect(b).toEqual({ min: v3(1, 2, 3), max: v3(3, 5, 7) });
    expect(meshMassProperties({ positions: [], indices: [] })).toEqual({ volume: 0, area: 0, centroid: v3(0, 0, 0) });
  });

  it('sphere centroid is its centre; volume approaches 4/3 pi r^3 from below', () => {
    const f: PrimitiveFeature = { kind: 'sphere', frame: { ...WORLD_XY_FRAME, origin: v3(5, -2, 7) }, radius: 2, segments: 64, rings: 32 };
    const mp = meshMassProperties(primitiveMesh(f));
    expect(mp.centroid.x).toBeCloseTo(5, 9);
    expect(mp.centroid.y).toBeCloseTo(-2, 9);
    expect(mp.centroid.z).toBeCloseTo(7, 9);
    expect(mp.volume).toBeLessThan((4 / 3) * Math.PI * 8);
    expect(mp.volume / ((4 / 3) * Math.PI * 8)).toBeGreaterThan(0.99);
  });

  it('3DMASSPROP reports one solid and sums several', async () => {
    const a = solidOf(box(0, 0, 0, 2, 3, 4));
    const b = solidOf(box(10, 0, 0, 2, 3, 4));
    const doc = docWith(a, b);
    const ctx = fake3dContext(doc);
    await drive3d(massProp3dTool(), ctx, [{ select: [a.id] }]);
    expect(ctx.logs).toContain('Volume:        24.0000');
    expect(ctx.logs).toContain('Surface area:  52.0000');
    expect(ctx.logs).toContain('Bounding box:  X: 0.0000 -- 2.0000');
    expect(ctx.logs).toContain('Centroid:      X: 1.0000  Y: 1.5000  Z: 2.0000');
    ctx.logs.length = 0;
    await drive3d(massProp3dTool(), ctx, [{ select: [a.id, b.id] }]);
    expect(ctx.logs).toContain('Solids:        2');
    expect(ctx.logs).toContain('Volume:        48.0000');
    expect(ctx.logs).toContain('Bounding box:  X: 0.0000 -- 12.0000');
    expect(ctx.logs).toContain('Centroid:      X: 6.0000  Y: 1.5000  Z: 2.0000');
    expect(ctx.logs.at(-1)).toMatch(/summed/);
    expect(ctx.selection.size).toBe(0);
  });

  it('3DMASSPROP in construction-plane coordinates and with nothing to measure', async () => {
    const a = solidOf(box(0, 0, 0, 2, 3, 4));
    const doc = docWith(a);
    doc.addEntities([{ id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    const ctx = fake3dContext(doc, { plane: axesFrame('XZ') });
    ctx.planeName = 'XZ';
    await drive3d(massProp3dTool(), ctx, [{ select: [a.id] }]);
    // XZ plane: plane Y = world Z (0..4), plane Z = -world Y (-3..0).
    expect(ctx.logs).toContain('               Y: 0.0000 -- 4.0000');
    expect(ctx.logs).toContain('               Z: -3.0000 -- 0.0000');
    expect(ctx.logs).toContain('(coordinates of the XZ construction plane)');
    ctx.logs.length = 0;
    await drive3d(massProp3dTool(), ctx, [{ select: ['L1'] }]);
    expect(ctx.logs).toEqual(['1 object is not a 3D solid and was ignored.', '3DMASSPROP: no 3D solids selected.']);
  });
});

describe('3DAREA', () => {
  it('measures the top face under a typed point (looking down the plane normal)', async () => {
    const s = solidOf(box(40, 0, 0, 4, 3, 2));
    const ctx = fake3dContext(docWith(s));
    await drive3d(area3dTool(), ctx, ['42,1']);
    expect(ctx.logs[0]).toBe('Area = 12.0000, Perimeter = 14.0000');
    expect(ctx.logs[1]).toBe('Face: 2 triangles, 1 outline loop, normal 0.0000,0.0000,1.0000 (WCS).');
  });

  it('measures a side face picked in the 3D view', async () => {
    const s = solidOf(box(0, 0, 0, 4, 3, 2));
    const ctx = fake3dContext(docWith(s));
    const ray = { origin: v3(10, 1, 1), dir: v3(-1, 0, 0) };
    const hit = pickSolid(s, ray)!;
    ctx.picks.push({ p2: { x: 4, y: 1 }, point: hit.point, ray, hit });
    await drive3d(area3dTool(), ctx, [{ x: 4, y: 1 }]);
    expect(ctx.logs[0]).toBe('Area = 6.0000, Perimeter = 10.0000');
    expect(ctx.logs[1]).toMatch(/normal 1\.0000,0\.0000,0\.0000/);
  });

  it('a cylinder cap: area of the inscribed polygon', async () => {
    const f: PrimitiveFeature = { kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 1, height: 1, segments: 32 };
    const ctx = fake3dContext(docWith(solidOf(f)));
    await drive3d(area3dTool(), ctx, ['0.1,0.2']);
    const poly = 0.5 * 32 * Math.sin((2 * Math.PI) / 32);
    expect(ctx.logs[0]).toBe(`Area = ${poly.toFixed(4)}, Perimeter = ${(32 * 2 * Math.sin(Math.PI / 32)).toFixed(4)}`);
  });

  it('asks again when no face is there; Enter ends', async () => {
    const ctx = fake3dContext(docWith(solidOf(box(0, 0, 0, 1, 1, 1))));
    await drive3d(area3dTool(), ctx, ['50,50', '']);
    expect(ctx.logs).toEqual(['No solid face there; pick a face of a solid.']);
    expect(ctx.finished).toBe(true);
  });
});
