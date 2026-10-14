/**
 * Milestone 4 measurement (src/tools3d/measure.ts): 3DDIST, 3DMASSPROP and 3DAREA through their
 * prompts with typed values, against analytic values, plus the pure helpers.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { invertWinding } from '../src/model3d/mesh';
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

  it('an elevation that rounds to zero prints an unsigned zero (AUPREC 5 and 6, the threshold value)', async () => {
    // At AUPREC 5 and 6 the double 0.5e-p lies just below the decimal half-unit, so an elevation equal
    // to it slipped past the threshold test and printed "-0.00000"; a value one step larger still rounds away.
    for (const [auprec, zero, nonZero, nonZeroText] of [[5, '-8.72664625997167e-8', '-8.7266462599717e-8', '-0.00001'], [6, '-8.726646259971647e-9', '-8.72664625997165e-9', '-0.000001']] as [number, string, string, string][]) {
      // The typed point must land exactly on the threshold double, or the case would not tell the fix apart.
      expect((measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(1, 0, Number(zero))).angleFromPlane * 180) / Math.PI).toBe(-(0.5 * 10 ** -auprec));
      const doc = new Drawing();
      doc.setHeader({ units: { ...doc.header.units, auprec } });
      const ctx = fake3dContext(doc);
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${zero}`]);
      expect(ctx.logs[0]).toBe(`Distance = 1.0000, Angle in XY Plane = ${(0).toFixed(auprec)}, Angle from XY Plane = ${(0).toFixed(auprec)}`);
      ctx.logs.length = 0;
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${nonZero}`]);
      expect(ctx.logs[0]).toMatch(new RegExp(`Angle from XY Plane = ${nonZeroText.replace('.', '\\.')}$`));
    }
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

  it('3DMASSPROP counts an inside-out solid as positive volume and weights the centroid by magnitude', async () => {
    // A foreign polyface wound inside out keeps its winding on import (signed volume -48 here).
    const a = solidOf(box(0, 0, 0, 2, 3, 4));
    const out = solidOf(box(10, 0, 0, 2, 3, 8));
    const inward: Solid3D = { ...out, mesh: invertWinding(out.mesh) };
    const ctx = fake3dContext(docWith(a, inward));
    await drive3d(massProp3dTool(), ctx, [{ select: [inward.id] }]);
    expect(ctx.logs).toContain('Volume:        48.0000');
    expect(ctx.logs).toContain('Centroid:      X: 11.0000  Y: 1.5000  Z: 4.0000');
    expect(ctx.logs).toContain('1 solid has a negative signed volume (wound inside out, or not closed); the magnitude is counted.');
    ctx.logs.length = 0;
    await drive3d(massProp3dTool(), ctx, [{ select: [a.id, inward.id] }]);
    // 24 units at (1, 1.5, 2) and 48 units at (11, 1.5, 4): the volume-weighted centroid, not the mean.
    expect(ctx.logs).toContain('Volume:        72.0000');
    expect(ctx.logs).toContain('Centroid:      X: 7.6667  Y: 1.5000  Z: 3.3333');
  });

  it('3DMASSPROP of a zero-volume solid reports its own centroid, not the origin', async () => {
    // An open quad far from the origin (what a foreign 3D face polyface imports as).
    const quad = newSolid({ mesh: { positions: [100, 100, 100, 102, 100, 100, 102, 103, 100, 100, 103, 100], indices: [0, 1, 2, 0, 2, 3] }, feature: { kind: 'mesh', source: 'imported' } });
    const ctx = fake3dContext(docWith(quad));
    await drive3d(massProp3dTool(), ctx, [{ select: [quad.id] }]);
    expect(ctx.logs).toContain('Volume:        0.0000');
    expect(ctx.logs).toContain('Surface area:  6.0000');
    expect(ctx.logs).toContain('Centroid:      X: 101.0000  Y: 101.5000  Z: 100.0000');
    expect(ctx.logs.some((l) => /negative signed volume/.test(l))).toBe(false);
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
