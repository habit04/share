/**
 * Review R05 — affine wide-polyline consistency.
 *
 * The boundary under test (one rule): a widthFrame polyline has ONE
 * authoritative representation — the frame (native source vertices, bulges
 * and widths plus the affine map); `points` are exactly the frame's image of
 * the source vertices. Rendering, bounds, snapping and DXF export all derive
 * display geometry from the frame, so an edit must never move `points`
 * without moving the frame (or vice versa):
 *  - whole-entity transforms compose the frame (supported);
 *  - vertex-preserving display-space edits (grip move, editor STRETCH) are
 *    applied to the frame's source vertices through the frame inverse;
 *  - topology-changing vertex edits (BREAK, polyline FILLET) refuse a
 *    widthFrame polyline — and any polyline carrying per-vertex `widths`,
 *    which they cannot reslice — explicitly, with no state change, exactly
 *    as they already refuse bulged polylines.
 * Before this correction the editor STRETCH moved `points` only (rendering
 * and export silently kept the old shape), and BREAK/FILLET carried the
 * frame/widths onto a changed vertex set, producing entities that fail
 * polylineWidthProblem and cannot be saved.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import {
  entityBounds, explodeInsert, mirrorEntityAcross, polylineVertices, rotateEntity, scaleEntityBy, translateEntity,
  type BlockDef, type Entity, type InsertEntity, type PolylineEntity,
} from '../src/core/entities';
import { polylineFramePoint, polylineWidthGeometry, polylineWidthProblem } from '../src/core/polyline-widths';
import { readDxf, writeDxf } from '../src/io/dxf';
import { breakEntity, filletPolyline, stretchEntity } from '../src/tools/drafting-modify';

const wide: PolylineEntity = {
  id: 'wide', type: 'polyline', layer: '0', color: 'ByLayer', closed: false,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }],
  bulges: [0, 0.5, 0],
  widths: [{ start: 2, end: 1 }, { start: 1, end: 3 }, { start: 0, end: 0 }],
};
const block = (name: string, entities: readonly Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
const ins = (props: Partial<InsertEntity>): InsertEntity => ({
  id: 'ins', type: 'insert', block: 'B', layer: '0', color: 'ByLayer',
  position: { x: 5, y: -3 }, rotation: 0, scale: 1, attributes: {}, ...props,
});
const stateOf = (entities: Entity[], blocks: Record<string, BlockDef> = {}): DrawingState =>
  new Drawing({ layers: [{ name: '0', color: 7, visible: true, locked: false }], entities, blocks }).snapshot;

/** A framed polyline expanded out of a non-uniformly scaled insert (display points (5,-3), (25,-3), (25,15)). */
const framedOf = (props: Partial<InsertEntity> = { scale: 2, scaleY: 3 }): PolylineEntity => {
  const st = stateOf([ins(props)], { B: block('B', [wide]) });
  return explodeInsert(st.entities[0] as InsertEntity, (n) => st.blocks[n])[0] as PolylineEntity;
};

/** The R05 invariant: entity is well-formed and `points` are the frame's image of its source vertices. */
const expectCoherent = (e: PolylineEntity): void => {
  expect(polylineWidthProblem(e)).toBeNull();
  if (e.widthFrame) {
    expect(e.widthFrame.points).toHaveLength(e.points.length);
    e.points.forEach((p, i) => {
      const img = polylineFramePoint(e.widthFrame!, e.widthFrame!.points[i]!);
      expect(Math.abs(img.x - p.x)).toBeLessThan(1e-9);
      expect(Math.abs(img.y - p.y)).toBeLessThan(1e-9);
    });
  }
};

/** Width-geometry points as an order/winding-insensitive multiset (rendering's own output). */
const pointSet = (e: Entity, map: (p: { x: number; y: number }) => { x: number; y: number } = (p) => p): string => {
  const geo = polylineWidthGeometry(e as PolylineEntity);
  const pts: string[] = [];
  const key = (v: number) => (Math.round(v * 1e5) / 1e5).toFixed(5);
  for (const poly of geo.polygons) for (const p of poly) { const q = map(p); pts.push(`${key(q.x)},${key(q.y)}`); }
  for (const s of geo.spines) for (const p of s) { const q = map(p); pts.push(`s:${key(q.x)},${key(q.y)}`); }
  return pts.sort().join('|');
};

describe('R05: whole-entity transforms of framed polylines stay coherent (regression pins)', () => {
  it('non-uniform + rotated + mirrored expansion renders one geometry, before and after DXF round trip', () => {
    const st = stateOf([ins({ scale: 2, scaleY: 3, rotation: Math.PI / 6, mirror: true })], { B: block('B', [wide]) });
    const before = explodeInsert(st.entities[0] as InsertEntity, (n) => st.blocks[n])[0]!;
    expectCoherent(before as PolylineEntity);
    const re = readDxf(writeDxf(st));
    const after = explodeInsert(re.entities[0] as InsertEntity, (n) => re.blocks[n])[0]!;
    expect(pointSet(after)).toBe(pointSet(before));
    const bb = entityBounds(before, () => undefined)!;
    const ba = entityBounds(after, () => undefined)!;
    expect(Math.abs(ba.min.x - bb.min.x)).toBeLessThan(1e-6);
    expect(Math.abs(ba.max.y - bb.max.y)).toBeLessThan(1e-6);
  });

  it('uniform scale / rotate / mirror of a framed polyline are geometry-equivariant', () => {
    const framed = framedOf();
    expect(pointSet(scaleEntityBy(framed, { x: 3, y: -2 }, 4), (p) => ({ x: 3 + (p.x - 3) / 4, y: -2 + (p.y + 2) / 4 }))).toBe(pointSet(framed));
    expect(pointSet(rotateEntity(framed, { x: 0, y: 0 }, Math.PI / 2), (p) => ({ x: p.y, y: -p.x }))).toBe(pointSet(framed));
    expect(pointSet(mirrorEntityAcross(framed, { x: 0, y: 0 }, { x: 0, y: 1 }), (p) => ({ x: -p.x, y: p.y }))).toBe(pointSet(framed));
    expectCoherent(scaleEntityBy(framed, { x: 0, y: 0 }, 4) as PolylineEntity);
    expectCoherent(mirrorEntityAcross(framed, { x: 0, y: 0 }, { x: 0, y: 1 }) as PolylineEntity);
  });
});

describe('R05: editor STRETCH edits the frame source, never points alone', () => {
  it('partial stretch moves the rendered vertex and keeps points == frame image', () => {
    const framed = framedOf();
    const box = { min: { x: 20, y: -10 }, max: { x: 30, y: 0 } }; // display vertex 1 (25,-3) only
    const out = stretchEntity(framed, box, { x: 0, y: 7 }) as PolylineEntity;
    expectCoherent(out);
    expect(out.points[1]).toEqual({ x: 25, y: 4 });
    const rendered = polylineVertices(out);
    expect(rendered.some((p) => Math.abs(p.x - 25) < 1e-9 && Math.abs(p.y - 4) < 1e-9)).toBe(true);
    expect(rendered.some((p) => Math.abs(p.x - 25) < 1e-9 && Math.abs(p.y + 3) < 1e-9)).toBe(false);
    // Untouched vertices render exactly as before.
    expect(out.points[0]).toEqual(framed.points[0]);
    expect(out.points[2]).toEqual(framed.points[2]);
    // The frame still carries the native widths untouched.
    expect(out.widthFrame?.widths).toEqual(wide.widths);
  });

  it('a stretch covering every vertex equals a plain translation of the rendered geometry', () => {
    const framed = framedOf();
    const box = { min: { x: -100, y: -100 }, max: { x: 100, y: 100 } };
    const out = stretchEntity(framed, box, { x: 11, y: -6 }) as PolylineEntity;
    expectCoherent(out);
    expect(pointSet(out)).toBe(pointSet(translateEntity(framed, { x: 11, y: -6 })));
  });

  it('the stretched framed polyline survives DXF save/reopen with identical rendered geometry', () => {
    const framed = framedOf();
    const box = { min: { x: 20, y: -10 }, max: { x: 30, y: 0 } };
    const out = stretchEntity(framed, box, { x: 0, y: 7 }) as PolylineEntity;
    const doc = stateOf([out]);
    const re = readDxf(writeDxf(doc));
    const flat = re.entities.flatMap((e) => (e.type === 'insert' ? explodeInsert(e, (n) => re.blocks[n]) : [e]));
    expect(flat).toHaveLength(1);
    expect(pointSet(flat[0]!)).toBe(pointSet(out));
  });

  it('stretch of an unframed wide polyline is unchanged behaviour', () => {
    const box = { min: { x: 9, y: -1 }, max: { x: 11, y: 1 } };
    const out = stretchEntity(wide, box, { x: 0, y: 2 }) as PolylineEntity;
    expect(out.widthFrame).toBeUndefined();
    expect(out.widths).toEqual(wide.widths);
    expect(out.points[1]).toEqual({ x: 10, y: 2 });
    expectCoherent(out);
  });
});

describe('R05: topology-changing edits refuse wide polylines explicitly (no state change)', () => {
  it('BREAK refuses a widthFrame polyline', () => {
    const framed = framedOf();
    expect(breakEntity(framed, { x: 15, y: -3 }, { x: 25, y: 5 })).toBeNull();
    expectCoherent(framed); // untouched
  });

  it('BREAK refuses per-vertex widths it cannot reslice, but still breaks constant-width and thin polylines', () => {
    const square: PolylineEntity = {
      ...wide, bulges: undefined,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      widths: [{ start: 1, end: 1 }, { start: 1, end: 1 }, { start: 1, end: 1 }, { start: 1, end: 1 }],
    };
    expect(breakEntity(square, { x: 5, y: 0 }, { x: 10, y: 5 })).toBeNull();
    const constantWidth: PolylineEntity = { ...square, widths: undefined, width: 1 };
    const broken = breakEntity(constantWidth, { x: 5, y: 0 }, { x: 10, y: 5 });
    expect(broken).not.toBeNull();
    for (const f of broken!) expect(polylineWidthProblem(f as PolylineEntity)).toBeNull();
    const thin: PolylineEntity = { ...square, widths: undefined, width: undefined };
    expect(breakEntity(thin, { x: 5, y: 0 }, { x: 10, y: 5 })).not.toBeNull();
  });

  it('polyline FILLET refuses widthFrame and per-vertex widths, but still fillets thin/constant-width polylines', () => {
    expect(filletPolyline(framedOf(), 1)).toBeNull();
    const square: PolylineEntity = {
      ...wide, bulges: undefined,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      widths: [{ start: 1, end: 1 }, { start: 1, end: 1 }, { start: 1, end: 1 }, { start: 1, end: 1 }],
    };
    expect(filletPolyline(square, 1)).toBeNull();
    const thin: PolylineEntity = { ...square, widths: undefined };
    const out = filletPolyline(thin, 1);
    expect(out).not.toBeNull();
    expect(polylineWidthProblem(out!)).toBeNull();
  });
});
