/**
 * True 3D dimensions, model side (src/model3d/dimension3d.ts) and their display geometry
 * (src/render3d/dimension3d-scene.ts): measurements in tilted planes against analytic values,
 * the projected flag and text, construction errors, transforms (src/tools3d/solid-edit.ts),
 * picking and the model helpers.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { STANDARD_DIMSTYLE, dimensionGeometry } from '../src/core/dimension';
import { textWidth } from '../src/core/entities';
import { aciToCss } from '../src/render/palette';
import { type Frame3, type Vec3, dist3, dot3, frameFromPlane, len3, mat4RotationAxis, sub3, v3 } from '../src/model3d/math';
import {
  dimension3dLocation, dimension3dMeasurement, dimension3dParts, dimension3dSpec, dimension3dText, dimension3dTo2d, makeDimension3D,
  planeDescription, planeLocal, planeWorld, withTextOverride3D,
} from '../src/model3d/dimension3d';
import { addDimensions3D, addSolids, dimensionById, model3dOf, newSolid, removeObjects3D, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import type { Dimension3D } from '../src/model3d/types';
import { dimension3dGeometry, pickDimension3D, visibleDimensions3D } from '../src/render3d/dimension3d-scene';
import { aboutPoint, mirrorAcrossPlane, scalingAbout, transformDimension3D, translationMatrix } from '../src/tools3d/solid-edit';
import { axesFrame } from '../src/tools3d/context';

/** A tilted measurement plane (normal (1, 1, 1), origin off the world origin). */
const tilted: Frame3 = frameFromPlane({ origin: v3(1, 2, 3), normal: v3(1, 1, 1) });
/** The same plane with the opposite normal (a negative extrusion). */
const flipped: Frame3 = frameFromPlane({ origin: v3(-4, 0.5, 2), normal: v3(-0.2, -0.9, -0.4) });
const P = (f: Frame3, x: number, y: number, z = 0): Vec3 => planeWorld(f, { x, y }, z);
const style = STANDARD_DIMSTYLE;

const aligned = (f = tilted, extra: Partial<Parameters<typeof makeDimension3D>[0]> = {}): Dimension3D =>
  makeDimension3D({ kind: 'aligned', plane: f, p1: P(f, 0, 0), p2: P(f, 3, 4), location: P(f, 1.5 - 0.8 * 2, 2 + 0.6 * 2), style, ...extra });

describe('3D dimensions: measurement in the plane', () => {
  it('aligned: the true length of an in-plane segment, offset to the left, not projected', () => {
    for (const f of [tilted, flipped, axesFrame('XZ', v3(0, 7, 0)), axesFrame('YZ')]) {
      const d = aligned(f);
      expect(dimension3dMeasurement(d)).toBeCloseTo(5, 12);
      expect(dist3(d.p1, d.p2)).toBeCloseTo(5, 12);
      expect(d.offset).toBeCloseTo(2, 12);
      expect(d.projected).toBeUndefined();
      expect(dimension3dText(d)).toBe('5.0000');
      // The location point recovered from the offset is the one given (it was on the dimension line).
      expect(dist3(dimension3dLocation(d), P(f, 1.5 - 1.6, 2 + 1.2))).toBeCloseTo(0, 12);
    }
  });

  it('linear: the separation along the plane X or Y axis', () => {
    const base = { kind: 'linear' as const, plane: tilted, p1: P(tilted, 1, 1), p2: P(tilted, 4, 5), style };
    const x = makeDimension3D({ ...base, axis: 'x', location: P(tilted, 2, 8) });
    const y = makeDimension3D({ ...base, axis: 'y', location: P(tilted, 7, 3) });
    expect(dimension3dMeasurement(x)).toBeCloseTo(3, 12);
    expect(dimension3dMeasurement(y)).toBeCloseTo(4, 12);
    // Offsets measured from the midpoint (2.5, 3) across the axis: +5 above for X, -4.5 beside for Y.
    expect(x.offset).toBeCloseTo(5, 12);
    expect(y.offset).toBeCloseTo(-4.5, 12);
    expect(dimension3dText(x)).toBe('3.0000');
    expect(dimension3dText(y)).toBe('4.0000');
    expect(dimension3dTo2d(y).rotation).toBeCloseTo(Math.PI / 2, 15);
  });

  it('angular: the counter-clockwise angle from leg 1 to leg 2 that contains the arc location', () => {
    const a60 = Math.PI / 3;
    const base = { kind: 'angular' as const, plane: tilted, vertex: P(tilted, 0, 0), p1: P(tilted, 2, 0), p2: P(tilted, Math.cos(a60), Math.sin(a60)), style };
    const inner = makeDimension3D({ ...base, location: P(tilted, Math.cos(a60 / 2), Math.sin(a60 / 2)) });
    expect(dimension3dMeasurement(inner)).toBeCloseTo(a60, 12);
    expect(inner.offset).toBeCloseTo(1, 12);
    expect(dimension3dText(inner)).toBe('60%%d');
    // The other side: the reflex angle, legs swapped so the arc still runs counter-clockwise.
    const outer = makeDimension3D({ ...base, location: P(tilted, -1.5, -0.2) });
    expect(dimension3dMeasurement(outer)).toBeCloseTo(2 * Math.PI - a60, 12);
    expect(outer.p1).toEqual(base.p2);
    expect(dimension3dText(outer)).toBe('300%%d');
    // Angle between two edges of a cube corner in a tilted plane through three points.
    const o = v3(0, 0, 0), ex = v3(1, 0, 0), ey = v3(0, 1, 0);
    const corner = makeDimension3D({ kind: 'angular', plane: frameFromPlane({ origin: o, normal: v3(0, 0, 1) }), vertex: o, p1: ex, p2: ey, location: v3(0.5, 0.5, 0), style });
    expect(dimension3dMeasurement(corner)).toBeCloseTo(Math.PI / 2, 14);
  });

  it('projected: a point off the plane is measured in projection and the text says so', () => {
    const f = tilted;
    const d = makeDimension3D({ kind: 'aligned', plane: f, p1: P(f, 0, 0), p2: P(f, 3, 4, 2), location: P(f, 0, 3), style });
    expect(d.projected).toBe(true);
    expect(dimension3dMeasurement(d)).toBeCloseTo(5, 12);
    expect(dist3(d.p1, d.p2)).toBeCloseTo(Math.sqrt(29), 12);
    expect(dimension3dText(d)).toBe('5.0000 (projected)');
    expect(dimension3dText(withTextOverride3D(d, 'Gap <>'))).toBe('Gap 5.0000 (projected)');
    expect(withTextOverride3D(d, '').textOverride).toBeUndefined();
    // Within the tolerance a point is in the plane.
    expect(makeDimension3D({ kind: 'aligned', plane: f, p1: P(f, 0, 0), p2: P(f, 3, 4, 1e-9), location: P(f, 0, 3), style }).projected).toBeUndefined();
    // Linear and angular dimensions flag projections too.
    expect(makeDimension3D({ kind: 'linear', axis: 'x', plane: f, p1: P(f, 0, 0, -1), p2: P(f, 3, 4), location: P(f, 0, 6), style }).projected).toBe(true);
    expect(makeDimension3D({ kind: 'angular', plane: f, vertex: P(f, 0, 0, 0.5), p1: P(f, 1, 0), p2: P(f, 0, 1), location: P(f, 1, 1), style }).projected).toBe(true);
  });

  it('refuses input that cannot make a dimension', () => {
    const f = tilted;
    expect(() => makeDimension3D({ kind: 'aligned', plane: f, p1: P(f, 1, 1), p2: P(f, 1, 1, 5), location: P(f, 0, 0), style })).toThrow(/coincide in the measurement plane/);
    expect(() => makeDimension3D({ kind: 'angular', plane: f, p1: P(f, 1, 0), p2: P(f, 0, 1), location: P(f, 1, 1), style })).toThrow(/needs a vertex/);
    expect(() => makeDimension3D({ kind: 'angular', plane: f, vertex: P(f, 0, 0), p1: P(f, 0, 0, 3), p2: P(f, 0, 1), location: P(f, 1, 1), style })).toThrow(/coincides with the vertex/);
    expect(() => makeDimension3D({ kind: 'angular', plane: f, vertex: P(f, 0, 0), p1: P(f, 1, 1), p2: P(f, 2, 2), location: P(f, 1, 1), style })).toThrow(/same direction/);
    expect(() => makeDimension3D({ kind: 'aligned', plane: { ...f, xAxis: v3(2, 0, 0) }, p1: P(f, 0, 0), p2: P(f, 1, 0), location: P(f, 0, 1), style })).toThrow(/not a valid frame/);
    expect(() => makeDimension3D({ kind: 'aligned', plane: f, p1: v3(NaN, 0, 0), p2: P(f, 1, 0), location: P(f, 0, 1), style })).toThrow(/finite/);
    // A linear dimension may measure zero, as in 2D.
    expect(dimension3dMeasurement(makeDimension3D({ kind: 'linear', axis: 'x', plane: f, p1: P(f, 1, 0), p2: P(f, 1, 3), location: P(f, 4, 1), style }))).toBeCloseTo(0, 12);
  });
});

describe('3D dimensions: display geometry', () => {
  it('is the 2D dimension geometry of the plane, mapped onto the plane in world coordinates', () => {
    const d = aligned();
    const segs = dimension3dGeometry(d);
    expect(segs.length).toBeGreaterThan(20); // lines, arrowheads, stroke text
    for (const s of segs) for (const q of [s.a, s.b]) expect(Math.abs(dot3(sub3(q, tilted.origin), tilted.zAxis))).toBeLessThan(1e-9);
    // Same parts as the 2D dimension of the plane coordinates.
    const parts2d = dimensionGeometry(dimension3dTo2d(d), textWidth);
    expect(dimension3dParts(d).map((p) => p.type)).toEqual(parts2d.map((p) => p.type));
    // The dimension line runs parallel to p1 -> p2 at the offset (2 to the left).
    const u = sub3(d.p2, d.p1);
    const parallel = segs.filter((s) => len3(sub3(s.b, s.a)) > 0.5 && Math.abs(Math.abs(dot3(sub3(s.b, s.a), u)) / (len3(sub3(s.b, s.a)) * 5) - 1) < 1e-9);
    expect(parallel.length).toBeGreaterThan(0);
    for (const s of parallel) {
      const l = planeLocal(tilted, s.a);
      // Distance from the line through (0,0) and (3,4): |-4x + 3y| / 5 = 2.
      expect(Math.abs(-4 * l.x + 3 * l.y) / 5).toBeCloseTo(2, 9);
    }
  });

  it('uses the 2D dimension colours: style overrides and ByLayer resolved against the layers', () => {
    const doc = new Drawing();
    const layers = [{ ...doc.layers[0]!, name: 'DIMS', color: 3 }];
    const d = aligned(tilted, { layer: 'DIMS', style: { ...style, extLineColor: 1 } });
    const colors = new Set(dimension3dGeometry(d, d.style, layers).map((s) => s.color));
    expect(colors).toEqual(new Set([aciToCss(1), aciToCss(3)]));
    // Another style can be asked for without touching the cache of the dimension's own one.
    expect(dimension3dGeometry(d, { ...style, textHeight: 1 }).length).toBeGreaterThan(0);
    expect(visibleDimensions3D([d], [{ ...layers[0]!, visible: false }])).toEqual([]);
    expect(visibleDimensions3D([d], layers)).toEqual([d]);
  });

  it('picks the dimension whose segments pass within the aperture', () => {
    // Plan projection of the world XY plane: 10 px per unit, y down.
    const project = (p: Vec3) => ({ x: p.x * 10, y: -p.y * 10 });
    const d = makeDimension3D({ kind: 'aligned', plane: axesFrame('XY'), p1: v3(0, 0, 0), p2: v3(10, 0, 0), location: v3(5, 2, 0), style });
    expect(pickDimension3D([d], project, 50, -20, 3)).toBe(d.id); // on the dimension line
    expect(pickDimension3D([d], project, 50, -60, 3)).toBeNull();
    expect(pickDimension3D([], project, 50, -20, 3)).toBeNull();
  });

  it('describes the measurement plane', () => {
    expect(planeDescription(axesFrame('XY', v3(0, 0, 5)))).toBe('XY at z = 5.0000');
    expect(planeDescription(axesFrame('XZ'))).toBe('XZ at y = 0.0000');
    expect(planeDescription(axesFrame('YZ', v3(2, 0, 0)))).toBe('YZ at x = 2.0000');
    expect(planeDescription(frameFromPlane({ origin: v3(0, 0, 0), normal: v3(1, 0, 1) }))).toBe('Custom (normal 0.7071, 0.0000, 0.7071)');
  });
});

describe('3D dimensions: transforms', () => {
  const c = v3(2, -1, 4);
  it('move, rotate and scale carry plane, points and offset; the measurement follows', () => {
    const d = aligned();
    const moved = transformDimension3D(d, translationMatrix(v3(5, 6, 7)));
    expect(moved.id).toBe(d.id);
    expect(dimension3dMeasurement(moved)).toBeCloseTo(5, 12);
    expect(dist3(moved.p1, v3(d.p1.x + 5, d.p1.y + 6, d.p1.z + 7))).toBeCloseTo(0, 12);
    expect(moved.offset).toBeCloseTo(d.offset, 12);
    const turned = transformDimension3D(d, aboutPoint(mat4RotationAxis(v3(0.3, -1, 0.2), 1.1), c));
    expect(dimension3dMeasurement(turned)).toBeCloseTo(5, 12);
    expect(turned.offset).toBeCloseTo(2, 12);
    const scaled = transformDimension3D(d, scalingAbout(c, 2.5));
    expect(dimension3dMeasurement(scaled)).toBeCloseTo(12.5, 12);
    expect(scaled.offset).toBeCloseTo(5, 12);
    expect(scaled.style).toBe(d.style);
    // A copy gets a new id.
    expect(transformDimension3D(d, translationMatrix(v3(1, 0, 0)), 'copy-1').id).toBe('copy-1');
  });

  it('a mirror keeps a right-handed plane and the same dimension line and angle', () => {
    const m = mirrorAcrossPlane(c, v3(1, 0.2, -0.3));
    const d = aligned();
    const mirrored = transformDimension3D(d, m);
    expect(dimension3dMeasurement(mirrored)).toBeCloseTo(5, 12);
    const z = mirrored.plane.zAxis, x = mirrored.plane.xAxis, y = mirrored.plane.yAxis;
    expect(dot3(z, v3(x.y * y.z - x.z * y.y, x.z * y.x - x.x * y.z, x.x * y.y - x.y * y.x))).toBeCloseTo(1, 12);
    // The dimension line location is the mirror image of the original one.
    const loc = dimension3dLocation(d), mloc = dimension3dLocation(mirrored);
    const n = v3(1, 0.2, -0.3), nl = Math.hypot(1, 0.2, 0.3);
    const h = dot3(sub3(loc, c), n) / nl;
    expect(dist3(mloc, v3(loc.x - (2 * h * n.x) / nl, loc.y - (2 * h * n.y) / nl, loc.z - (2 * h * n.z) / nl))).toBeCloseTo(0, 10);
    const a60 = Math.PI / 3;
    const ang = makeDimension3D({ kind: 'angular', plane: tilted, vertex: P(tilted, 0, 0), p1: P(tilted, 2, 0), p2: P(tilted, Math.cos(a60), Math.sin(a60)), location: P(tilted, 1, 0.3), style });
    const mang = transformDimension3D(ang, m);
    expect(dimension3dMeasurement(mang)).toBeCloseTo(a60, 12);
    expect(dist3(dimension3dLocation(mang), dimension3dLocation(transformDimension3D(ang, m)))).toBe(0);
  });

  it('rebuilding from the spec gives the same dimension', () => {
    const d = aligned(flipped, { textOverride: 'A <>' });
    const again = makeDimension3D(dimension3dSpec(d));
    expect({ ...again, offset: 0 }).toEqual({ ...d, offset: 0 });
    expect(again.offset).toBeCloseTo(d.offset, 12);
    // A text edit changes nothing else.
    expect({ ...withTextOverride3D(d, 'B'), textOverride: 'A <>' }).toEqual(d);
  });
});

describe('3D dimensions in the model', () => {
  it('a model with only dimensions is kept; removing the last 3D object drops model3d', () => {
    const doc = new Drawing();
    const d = aligned();
    const s1 = withModel3D(doc.snapshot, addDimensions3D(model3dOf(doc.snapshot), [d]));
    expect(s1.model3d?.dimensions).toEqual([d]);
    expect(s1.model3d?.solids).toEqual([]);
    expect(dimensionById(model3dOf(s1), d.id)).toBe(d);
    const s2 = withModel3D(s1, removeObjects3D(model3dOf(s1), [d.id]));
    expect(s2.model3d).toBeUndefined();
    // Ids are unique across solids and dimensions.
    const solid = newSolid({ id: 'x1', mesh: boxMesh(1, 1, 1), feature: { kind: 'mesh', source: 'edited' } });
    const m = addSolids(model3dOf(s1), [solid]);
    expect(() => addDimensions3D(m, [{ ...d, id: 'x1' }])).toThrow(/already in use/);
    expect(() => addSolids(addDimensions3D(model3dOf(doc.snapshot), [{ ...d, id: 'x2' }]), [{ ...solid, id: 'x2' }])).toThrow(/already in use/);
    // Undo / redo restore dimensions (states are whole snapshots).
    doc.updateModel3D((mm) => addDimensions3D(mm, [d]));
    expect(doc.snapshot.model3d?.dimensions).toHaveLength(1);
    doc.undo();
    expect(doc.snapshot.model3d).toBeUndefined();
    doc.redo();
    expect(doc.snapshot.model3d?.dimensions?.[0]).toEqual(d);
    expect(Object.isFrozen(doc.snapshot.model3d?.dimensions?.[0])).toBe(true);
  });
});
