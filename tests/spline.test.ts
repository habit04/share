import { describe, it, expect } from 'vitest';
import type { SplineEntity, Entity } from '../src/core/entities';
import {
  splinePoints,
  splineThroughPoints,
  entityBounds,
  distanceToEntity,
  translateEntity,
  rotateEntity,
  scaleEntityBy,
  mirrorEntityAcross,
  gripPoints,
  moveGrip,
  snapCandidates,
  entityTypeName,
  explodeCompound,
  explodeInsert,
} from '../src/core/entities';
import { nurbsPoint, interpolateFitPoints, isValidNurbs, clampedUniformKnots, nurbsPoints, distanceToPolyline } from '../src/core/spline';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { splineTool } from '../src/tools/drafting-draw';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';

const props = { layer: '0', color: 'ByLayer' as const };
const lookup = () => undefined;
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < tol;

describe('NURBS evaluation', () => {
  it('evaluates a clamped quadratic Bezier and a rational quarter circle', () => {
    const bez = { degree: 2, knots: [0, 0, 0, 1, 1, 1], controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }] };
    expect(isValidNurbs(bez)).toBe(true);
    expect(nurbsPoint(bez, 0)).toEqual({ x: 0, y: 0 });
    expect(nurbsPoint(bez, 1)).toEqual({ x: 2, y: 0 });
    const m = nurbsPoint(bez, 0.5);
    expect(m.x).toBeCloseTo(1);
    expect(m.y).toBeCloseTo(1);
    const w = Math.SQRT1_2;
    const arc = { degree: 2, knots: [0, 0, 0, 1, 1, 1], controlPoints: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], weights: [1, w, 1] };
    for (const t of [0.1, 0.3, 0.5, 0.8]) {
      const p = nurbsPoint(arc, t);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
    }
  });
  it('rejects inconsistent knot vectors and builds clamped uniform ones', () => {
    expect(isValidNurbs({ degree: 3, knots: [0, 1], controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(false);
    expect(clampedUniformKnots(5, 3)).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
  });
  it('interpolates through every fit point (open and closed)', () => {
    const fit = [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 1 }, { x: 7, y: 4 }, { x: 9, y: 0 }];
    const c = interpolateFitPoints(fit)!;
    expect(c.degree).toBe(3);
    const pts = nurbsPoints(c, 64);
    for (const f of fit) expect(distanceToPolyline(f, pts)).toBeLessThan(1e-3);
    const closed = interpolateFitPoints(fit.slice(0, 4), { closed: true })!;
    const cp = nurbsPoints(closed, 64);
    expect(near(cp[0]!, cp[cp.length - 1]!, 1e-9)).toBe(true);
    for (const f of fit.slice(0, 4)) expect(distanceToPolyline(f, cp)).toBeLessThan(1e-3);
    // Two points: a straight line; three: a quadratic.
    expect(interpolateFitPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }])!.degree).toBe(1);
    expect(interpolateFitPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])!.degree).toBe(2);
  });
});

describe('SPLINE entity', () => {
  const s = splineThroughPoints({ id: 's', ...props }, [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 0 }, { x: 6, y: 2 }], false)!;
  it('has bounds, hit test, snaps, grips and a type name', () => {
    const b = entityBounds(s, lookup)!;
    expect(b.min.x).toBeCloseTo(0);
    expect(b.max.x).toBeCloseTo(6);
    expect(distanceToEntity({ x: 2, y: 2 }, s, lookup)).toBeLessThan(0.01);
    expect(distanceToEntity({ x: 2, y: 10 }, s, lookup)).toBeGreaterThan(7);
    const snaps = snapCandidates(s, lookup);
    expect(snaps.filter((c) => c.kind === 'endpoint')).toHaveLength(2);
    expect(gripPoints(s)).toHaveLength(4); // fit points
    expect(entityTypeName(s)).toBe('SPLINE');
  });
  it('moves, rotates, scales and mirrors with its control and fit points', () => {
    const t = translateEntity(s, { x: 1, y: 1 }) as SplineEntity;
    expect(t.fitPoints![0]).toEqual({ x: 1, y: 1 });
    expect(near(splinePoints(t)[0]!, { x: 1, y: 1 })).toBe(true);
    const r = rotateEntity(s, { x: 0, y: 0 }, Math.PI / 2) as SplineEntity;
    expect(near(r.controlPoints[r.controlPoints.length - 1]!, { x: -2, y: 6 })).toBe(true);
    const k = scaleEntityBy(s, { x: 0, y: 0 }, 2) as SplineEntity;
    expect(entityBounds(k, lookup)!.max.x).toBeCloseTo(12);
    const m = mirrorEntityAcross(s, { x: 0, y: 0 }, { x: 0, y: 1 }) as SplineEntity;
    expect(entityBounds(m, lookup)!.min.x).toBeCloseTo(-6);
  });
  it('moving a fit-point grip re-fits the curve through the new point', () => {
    const g2 = moveGrip(s, 1, { x: 2, y: 4 }) as SplineEntity;
    expect(distanceToEntity({ x: 2, y: 4 }, g2, lookup)).toBeLessThan(0.05);
    expect(g2.id).toBe('s');
  });
  it('explodes to a polyline', () => {
    const parts = explodeCompound(s)!;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('polyline');
  });
  it('transforms inside a mirrored, non-uniformly scaled block insert', () => {
    const block = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [s as Entity], attributes: [] };
    const out = explodeInsert({ id: 'i', ...props, type: 'insert', block: 'B', position: { x: 10, y: 0 }, rotation: 0, scale: 2, scaleY: 1, mirror: true, attributes: {} }, (n) => (n === 'B' ? block : undefined));
    const sp = out[0] as SplineEntity;
    expect(sp.type).toBe('spline');
    expect(entityBounds(sp, lookup)!.min.x).toBeCloseTo(-2);
  });
});

describe('SPLINE command', () => {
  it('draws through fit points and finishes on Enter', () => {
    const ctx = fakeContext(new Drawing());
    drive(splineTool(), ctx, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 1 }, '']);
    const s = ctx.doc.entities[0] as SplineEntity;
    expect(s.type).toBe('spline');
    expect(s.fitPoints).toHaveLength(4);
    expect(s.controlPoints.length).toBeGreaterThanOrEqual(4);
    expect(ctx.prompts[0]).toBe('Specify first point or [Method/Knots/Object]:');
    expect(ctx.prompts).toContain('Enter next point or [end Tangency/toLerance/Undo/Close]:');
  });
  it('Undo removes the last point and Close closes the curve', () => {
    const ctx = fakeContext(new Drawing());
    drive(splineTool(), ctx, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 9, y: 9 }, 'U', { x: 4, y: 4 }, { x: 0, y: 4 }, 'C']);
    const s = ctx.doc.entities[0] as SplineEntity;
    expect(s.closed).toBe(true);
    expect(s.fitPoints).toHaveLength(4);
    const pts = splinePoints(s);
    expect(near(pts[0]!, pts[pts.length - 1]!, 1e-6)).toBe(true);
  });
  it('CV method places control vertices', () => {
    const ctx = fakeContext(new Drawing());
    drive(splineTool(), ctx, ['M', 'CV', { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }, '']);
    const s = ctx.doc.entities[0] as SplineEntity;
    expect(s.fitPoints).toBeUndefined();
    expect(s.controlPoints).toHaveLength(4);
    expect(s.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
  it('EXPLODE turns a spline into a polyline', () => {
    const doc = new Drawing();
    const s = splineThroughPoints({ id: 'sx', ...props }, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], false)!;
    doc.addEntities([s]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['sx']);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]!.type).toBe('polyline');
  });
});

describe('SPLINE in DXF and DWG', () => {
  it('round-trips control points, knots, weights and fit points', () => {
    const d = new Drawing();
    const s = splineThroughPoints({ id: 's1', layer: 'CURVES', color: 3 }, [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: -1 }, { x: 6, y: 0 }], false)!;
    const rational: SplineEntity = { id: 's2', ...props, type: 'spline', degree: 2, knots: [0, 0, 0, 1, 1, 1], controlPoints: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], weights: [1, Math.SQRT1_2, 1], closed: false };
    d.addEntities([s, rational]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('\r\nSPLINE\r\n');
    const back = readDxf(text).entities.filter((e): e is SplineEntity => e.type === 'spline');
    expect(back).toHaveLength(2);
    expect(back[0]!.layer).toBe('CURVES');
    expect(back[0]!.fitPoints).toHaveLength(4);
    expect(back[0]!.knots).toEqual(s.knots.map((k) => expect.closeTo(k, 9)));
    expect(back[0]!.controlPoints[1]!.x).toBeCloseTo(s.controlPoints[1]!.x, 8);
    expect(back[1]!.weights![1]).toBeCloseTo(Math.SQRT1_2, 9);
    const p = nurbsPoint({ degree: 2, knots: back[1]!.knots, controlPoints: back[1]!.controlPoints, weights: back[1]!.weights }, 0.5);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
  });
  it('reads a fit-point-only SPLINE (codes 70/71/74/11/21)', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'SPLINE', '8', '0', '100', 'AcDbSpline', '70', '8', '71', '3', '72', '0', '73', '0', '74', '3', '11', '0', '21', '0', '11', '1', '21', '1', '11', '2', '21', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const s = readDxf(dxf).entities[0] as SplineEntity;
    expect(s.type).toBe('spline');
    expect(s.controlPoints).toHaveLength(0);
    expect(distanceToEntity({ x: 1, y: 1 }, s, lookup)).toBeLessThan(1e-3);
  });
  it('converts a LibreDWG SPLINE', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 29 }],
      blocks: [],
      entities: [{ type: 'SPLINE', handle: 'A1', layer: '0', flag: 8, degree: 2, knots: [0, 0, 0, 1, 1, 1], controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 2, y: 0, z: 0 }], fitPoints: [] } as never],
    };
    const { state, skipped } = convertDwg(payload);
    expect(skipped.SPLINE).toBeUndefined();
    const s = state.entities[0] as SplineEntity;
    expect(s.type).toBe('spline');
    expect(nurbsPoint(s, 0.5).y).toBeCloseTo(1);
  });
});
