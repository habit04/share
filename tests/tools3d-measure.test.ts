/**
 * Milestone 4 measurement (src/tools3d/measure.ts): 3DDIST, 3DMASSPROP and 3DAREA through their
 * prompts with typed values, against analytic values, plus the pure helpers.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { type Vec3, WORLD_XY_FRAME, add3, frameFromPlane, scale3, sub3, v3 } from '../src/model3d/math';
import { type Mesh3D, invertWinding, meshVertex, meshVertexCount } from '../src/model3d/mesh';
import { addSolids, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { PrimitiveFeature, Solid3D } from '../src/model3d/types';
import { pickSolid } from '../src/render3d/picking';
import { axesFrame } from '../src/tools3d/context';
import { area3dTool, boundsInFrame, dist3dTool, distanceReport, massProp3dTool, measureDistance, meshMassProperties, type Distance3 } from '../src/tools3d/measure';
import { rotationAbout, transformSolid } from '../src/tools3d/solid-edit';
import { drive3d, fake3dContext } from './helpers/context3d';

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature => ({
  kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x0 + w / 2, y0 + d / 2, z0) }, width: w, depth: d, height: h,
});
const solidOf = (f: PrimitiveFeature): Solid3D => newSolid({ mesh: primitiveMesh(f), feature: f });
/** Closed authored import geometry: deliberately does not pass through creator size admission. */
function importedBox(w: number, d: number, h: number, origin = v3(0, 0, 0)): Mesh3D {
  const positions = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
    .map((value, index) => value + [origin.x, origin.y, origin.z][index % 3]!);
  return { positions, indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
}
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

  it('formats exact threshold payloads and typed elevation boundaries without a libm-dependent equality claim', async () => {
    for (const [auprec, zero, nonZero, nonZeroText] of [[5, '-8.72664625997167e-8', '-8.7266462599717e-8', '-0.00001'], [6, '-8.726646259971647e-9', '-8.72664625997165e-9', '-0.000001']] as [number, string, string, string][]) {
      const doc = new Drawing();
      doc.setHeader({ units: { ...doc.header.units, auprec } });
      const ctx = fake3dContext(doc);
      // Arithmetic-only payload lands EXACTLY on the old comparison threshold.
      // atan2's last bit differs across libm implementations for the typed control.
      const threshold = 0.5 * 10 ** -auprec;
      const exact: Distance3 = { distance: 1, delta: v3(1, 0, Number(zero)), planar: 1, angleInPlane: 0, angleFromPlane: (-threshold * Math.PI) / 180 };
      const degrees = (exact.angleFromPlane * 180) / Math.PI;
      expect(degrees).toBe(-threshold);
      if (auprec === 6) {
        expect(degrees.toFixed(auprec)).toBe('-0.000000');
        expect(Math.abs(degrees) < threshold).toBe(false); // The old report prints signed zero.
        expect(distanceReport(ctx, exact)[0]).toBe('Distance = 1.0000, Angle in XY Plane = 0.000000, Angle from XY Plane = 0.000000');
      } else {
        // The binary64 AUPREC5 threshold is just above the decimal half-unit.
        expect(distanceReport(ctx, exact)[0]).toBe('Distance = 1.0000, Angle in XY Plane = 0.00000, Angle from XY Plane = -0.00001');
      }
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${zero}`]);
      // Keep both original typed boundary controls, but use their ACTUAL libm
      // result: a last-bit difference may legitimately round to a nonzero angle.
      const zeroDegrees = (measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(1, 0, Number(zero))).angleFromPlane * 180) / Math.PI;
      const zeroFixed = zeroDegrees.toFixed(auprec), zeroText = Number(zeroFixed) === 0 ? (0).toFixed(auprec) : zeroFixed;
      expect(ctx.logs[0]).toBe(`Distance = 1.0000, Angle in XY Plane = ${(0).toFixed(auprec)}, Angle from XY Plane = ${zeroText}`);
      ctx.logs.length = 0;
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${nonZero}`]);
      const nextDegrees = (measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(1, 0, Number(nonZero))).angleFromPlane * 180) / Math.PI;
      const nextFixed = nextDegrees.toFixed(auprec), nextText = Number(nextFixed) === 0 ? (0).toFixed(auprec) : nextFixed;
      expect(ctx.logs[0]).toMatch(new RegExp(`Angle from XY Plane = ${nextText.replace('.', '\\.')}$`));
      // Additional typed controls have a clear margin on either side of the half-unit.
      ctx.logs.length = 0;
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${auprec === 5 ? '-8e-8' : '-8e-9'}`]);
      expect(ctx.logs[0]).toBe(`Distance = 1.0000, Angle in XY Plane = ${(0).toFixed(auprec)}, Angle from XY Plane = ${(0).toFixed(auprec)}`);
      ctx.logs.length = 0;
      await drive3d(dist3dTool(), ctx, ['0,0,0', `1,0,${auprec === 5 ? '-1e-7' : '-1e-8'}`]);
      expect(ctx.logs[0]).toMatch(new RegExp(`Angle from XY Plane = ${nonZeroText.replace('.', '\\.')}$`));
    }
  });

  it('retains a genuine small WORLD component independently of another axis or frame origin magnitude', () => {
    const near = measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(0, 1e-6, 0));
    const far = measureDistance(WORLD_XY_FRAME, v3(1e9, 0, 0), v3(1e9, 1e-6, 0));
    expect(far).toEqual(near); expect(far.delta).toEqual(v3(0, 1e-6, 0));
    expect(far.distance).toBe(1e-6); expect(far.planar).toBe(1e-6); expect(far.angleInPlane).toBe(Math.PI / 2);
    expect(measureDistance(axesFrame('XY', v3(1e12, -1e12, 1e12)), v3(0, 0, 0), v3(0, 1e-6, 0))).toEqual(near);
  });

  it('preserves scientific tiny components and their direction instead of cleaning geometry by magnitude', async () => {
    const doc = new Drawing(); doc.setHeader({ units: { ...doc.header.units, lunits: 1, luprec: 4 } });
    const ctx = fake3dContext(doc);
    const m = measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(1, 0, 1e-15));
    expect(m.delta).toEqual(v3(1, 0, 1e-15));
    expect(distanceReport(ctx, m)[1]).toBe('Delta X = 1.0000E+00, Delta Y = 0.0000E+00, Delta Z = 1.0000E-15');
    await drive3d(dist3dTool(), ctx, ['0,0,0', '1,0,1e-15']);
    expect(ctx.logs[1]).toBe('Delta X = 1.0000E+00, Delta Y = 0.0000E+00, Delta Z = 1.0000E-15');
    const tilted = measureDistance(WORLD_XY_FRAME, v3(0, 0, 0), v3(0, 1e-15, 1));
    expect(tilted.delta).toEqual(v3(0, 1e-15, 1)); expect(tilted.planar).toBe(1e-15);
    expect(distanceReport(ctx, tilted)[0]).toContain('Angle in XY Plane = 90.00');
    expect(distanceReport(ctx, tilted)[1]).toContain('Delta Y = 1.0000E-15');
  });

  it('reports tilted and rotated normal directions coherently while retaining their raw geometric deltas', async () => {
    const frame = frameFromPlane({ origin: v3(5.3, 5.2, 0.85), normal: v3(1, 0, 2) });
    const world = (x: number, y: number, z: number): Vec3 => add3(frame.origin, add3(scale3(frame.xAxis, x), add3(scale3(frame.yAxis, y), scale3(frame.zAxis, z))));
    const ctx = fake3dContext(new Drawing(), { plane: frame }); ctx.planeName = 'Face';
    for (const [x, y] of [[1, 1], [2, 3], [-7.5, 0.25], [1234.5, -987.25]]) {
      const m = measureDistance(frame, world(x!, y!, 0), world(x!, y!, 5));
      expect(m.distance).toBeCloseTo(5, 12);
      expect(distanceReport(ctx, m).slice(0, 2)).toEqual(['Distance = 5.0000, Angle in XY Plane = 0.00, Angle from XY Plane = 90.00', 'Delta X = 0.0000, Delta Y = 0.0000, Delta Z = 5.0000']);
    }
    await drive3d(dist3dTool(), ctx, ['1,1,0', '@0,0,5']);
    expect(ctx.logs.slice(0, 2)).toEqual(['Distance = 5.0000, Angle in XY Plane = 0.00, Angle from XY Plane = 90.00', 'Delta X = 0.0000, Delta Y = 0.0000, Delta Z = 5.0000']);
    const rotated = transformSolid(solidOf(box(3, 0, 0, 4, 10, 3)), rotationAbout(v3(0, 0, 0), v3(1, 0, 0), Math.PI / 2));
    const vertices = Array.from({ length: meshVertexCount(rotated.mesh) }, (_, i) => meshVertex(rotated.mesh, i));
    const near = (p: Vec3, x: number, y: number, z: number) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9 && Math.abs(p.z - z) < 1e-9;
    const lo = vertices.find(p => near(p, 3, 0, 0))!, hi = vertices.find(p => near(p, 3, 0, 10))!;
    expect(lo).toBeDefined(); expect(hi).toBeDefined();
    const wctx = fake3dContext(), forward = measureDistance(WORLD_XY_FRAME, lo, hi), backward = measureDistance(WORLD_XY_FRAME, hi, lo);
    expect(forward.delta).toEqual(sub3(hi, lo)); expect(backward.delta).toEqual(sub3(lo, hi));
    expect(distanceReport(wctx, forward).slice(0, 2)).toEqual(['Distance = 10.0000, Angle in XY Plane = 0.00, Angle from XY Plane = 90.00', 'Delta X = 0.0000, Delta Y = 0.0000, Delta Z = 10.0000']);
    expect(distanceReport(wctx, backward).slice(0, 2)).toEqual(['Distance = 10.0000, Angle in XY Plane = 0.00, Angle from XY Plane = -90.00', 'Delta X = 0.0000, Delta Y = 0.0000, Delta Z = -10.0000']);
  });

  it('refuses text that is not a point', async () => {
    const ctx = fake3dContext();
    await drive3d(dist3dTool(), ctx, ['nonsense', '0,0', '1,0']);
    expect(ctx.logs[0]).toBe('Invalid input "nonsense": requires a point.');
    expect(ctx.logs[1]).toMatch(/^Distance = 1\.0000/);
  });
});

describe('mass properties', () => {
  it('keeps exact positive imported thin-box volume and centroid independent of translation and winding', async () => {
    const width = 65536, height = 2 ** -26;
    for (const origin of [v3(0, 0, 0), v3(1e9, -1e9, 0)]) {
      const mesh = importedBox(width, width, height, origin), before = JSON.stringify(mesh), expected = v3(origin.x + width / 2, origin.y + width / 2, height / 2);
      expect(meshMassProperties(mesh).volume).toBe(64); expect(meshMassProperties(mesh).centroid).toEqual(expected);
      expect(meshMassProperties(invertWinding(mesh)).volume).toBe(-64); expect(meshMassProperties(invertWinding(mesh)).centroid).toEqual(expected);
      // Exact orientation change, without introducing a trigonometric approximation.
      const permuted: Mesh3D = { ...mesh, positions: mesh.positions.flatMap((_value, index, all) => index % 3 ? [] : [all[index + 2]!, all[index]!, all[index + 1]!]) };
      expect(meshMassProperties(permuted).volume).toBe(64);
      expect(meshMassProperties(permuted).centroid).toEqual(v3(expected.z, expected.x, expected.y));
      expect(JSON.stringify(mesh)).toBe(before);
    }
    const mesh = importedBox(width, width, height), imported = newSolid({ mesh, feature: { kind: 'mesh', source: 'imported' } });
    const ctx = fake3dContext(docWith(imported)); await drive3d(massProp3dTool(), ctx, [{ select: [imported.id] }]);
    expect(ctx.logs).toContain('Volume:        64.0000'); expect(ctx.logs).toContain('Centroid:      X: 32768.0000  Y: 32768.0000  Z: 0.0000');
    const remote = newSolid({ mesh: importedBox(2 * width, width, height, v3(2 ** 30, 0, 0)), feature: { kind: 'mesh', source: 'imported' } });
    expect(meshMassProperties(remote.mesh).volume).toBe(128);
    const mixedDoc = docWith(imported, remote); mixedDoc.setHeader({ units: { ...mixedDoc.header.units, luprec: 8 } });
    const mixed = fake3dContext(mixedDoc);
    await drive3d(massProp3dTool(), mixed, [{ select: [imported.id, remote.id] }]);
    // (64 * 32768 + 128 * (2^30 + 65536)) / 192 = 715882496 exactly;
    // both other coordinates coincide, including the positive z centroid 2^-27.
    expect(mixed.logs).toContain('Volume:        192.00000000');
    expect(mixed.logs).toContain('Centroid:      X: 715882496.00000000  Y: 32768.00000000  Z: 0.00000001');
  });

  it('retains a small well-resolved closed import rather than applying the builder aspect-ratio threshold', () => {
    const h = 2 ** -52, mp = meshMassProperties(importedBox(1, 1, h));
    expect(mp.volume).toBe(h); expect(mp.centroid).toEqual(v3(0.5, 0.5, h / 2));
  });

  it('does not turn a nonfinite determinant into an apparently valid zero-volume measurement', () => {
    const mp = meshMassProperties(importedBox(1e200, 1e200, 1e200));
    expect(Number.isFinite(mp.volume)).toBe(false); expect(mp.volume).not.toBe(0);
  });

  it('keeps the exact-zero vertex-mean fallback when the error magnitude overflows', () => {
    const mp = meshMassProperties({ positions: [0, 0, 0, 1e105, 1e105, 1e105, 2e105, 2e105, 2e105, 3e105, 3e105, 3e105], indices: [1, 2, 3] });
    expect(mp.volume).toBe(0); expect(mp.area).toBe(0);
    expect(mp.centroid).toEqual(v3(1.5e105, 1.5e105, 1.5e105));
  });

  it('reports a cancelling tilted flat grid as zero with its vertex average and no winding warning', async () => {
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= 3; j++) for (let i = 0; i <= 3; i++) { const x = i * 0.1, y = j * 1.1; positions.push(x, y, 0.3 * x + 1.1 * y); }
    const id = (i: number, j: number) => j * 4 + i;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    for (const mesh of [{ positions, indices }, invertWinding({ positions, indices })]) {
      const mp = meshMassProperties(mesh); expect(mp.volume).toBe(0);
      expect(mp.centroid.x).toBeCloseTo(0.15, 12); expect(mp.centroid.y).toBeCloseTo(1.65, 12); expect(mp.centroid.z).toBeCloseTo(1.86, 12); expect(mp.area).toBeGreaterThan(1);
      const flat = newSolid({ mesh, feature: { kind: 'mesh', source: 'imported' } }), ctx = fake3dContext(docWith(flat));
      await drive3d(massProp3dTool(), ctx, [{ select: [flat.id] }]);
      expect(ctx.logs).toContain('Volume:        0.0000'); expect(ctx.logs).toContain('Centroid:      X: 0.1500  Y: 1.6500  Z: 1.8600');
      expect(ctx.logs.some(line => /negative signed volume/.test(line))).toBe(false);
    }
  });
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
