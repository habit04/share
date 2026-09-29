import { describe, it, expect } from 'vitest';
import type { Entity, LineEntity, PolylineEntity, ArcEntity, InsertEntity, MTextEntity, EllipseEntity } from '../src/core/entities';
import { polylineArea, polylineVertices, splineThroughPoints } from '../src/core/entities';
import { newTable } from '../src/core/table';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { matchKeyword } from '../src/tools/script';
import { plineTool, ellipseTool, donutTool, polygonTool, mtextTool, xlineTool, pointTool, tangentBulge, threePointBulge, polygonPoints, mtextAnchor } from '../src/tools/drafting-draw';
import {
  filletLines,
  chamferLines,
  filletPolyline,
  rectangularArray,
  polarArray,
  stretchEntity,
  breakEntity,
  joinEntities,
  lengthenEntity,
  alignTransform,
  matchProperties,
  filletTool,
  arrayRectTool,
  stretchTool,
  breakTool,
  joinTool,
} from '../src/tools/drafting-modify';
import { blockTool, insertTool, referencedBlocks, unusedLayers, validBlockName } from '../src/tools/blocks';
import { entityArea, listEntity, distTool, areaTool } from '../src/tools/inquiry';

const props = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, a: [number, number], b: [number, number]): LineEntity => ({ id, ...props, type: 'line', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });

describe('keyword matching', () => {
  it('accepts abbreviations, full words and longer prefixes', () => {
    const kws = ['Arc', 'Close', 'Halfwidth', 'Length', 'Undo', 'Width', 'WPolygon', 'CPolygon'];
    expect(matchKeyword('a', kws)).toBe('ARC');
    expect(matchKeyword('CLOSE', kws)).toBe('CLOSE');
    expect(matchKeyword('wp', kws)).toBe('WPOLYGON');
    expect(matchKeyword('w', kws)).toBe('WIDTH');
    expect(matchKeyword('wpol', kws)).toBe('WPOLYGON');
    expect(matchKeyword('x', kws)).toBeNull();
  });
});

describe('PLINE tool', () => {
  it('draws straight and tangent arc segments with width and Close', () => {
    const ctx = fakeContext();
    drive(plineTool(), ctx, [{ x: 0, y: 0 }, 'W', '0.1', '', { x: 2, y: 0 }, 'A', { x: 2, y: 2 }, 'L', { x: 0, y: 2 }, 'C']);
    const pl = ctx.doc.entities[0] as PolylineEntity;
    expect(pl).toBeDefined();
    expect(pl.type).toBe('polyline');
    expect(pl.closed).toBe(true);
    expect(pl.points).toHaveLength(4);
    expect(pl.width).toBeCloseTo(0.1);
    // segment 1 (2,0)->(2,2) is a tangent arc continuing the +X direction: a CCW semicircle of radius 1
    expect(pl.bulges![0]).toBe(0);
    expect(pl.bulges![1]).toBeCloseTo(1);
    expect(pl.bulges![2]).toBe(0);
    expect(ctx.prompts.some((p) => p.startsWith('Specify next point or [Arc/Close/Halfwidth/Length/Undo/Width]:'))).toBe(true);
    expect(ctx.prompts.some((p) => p.startsWith('Specify endpoint of arc or [Angle/CEnter/CLose/Direction/Halfwidth/Line/Radius/Second pt/Undo/Width]:'))).toBe(true);
  });
  it('Undo removes the last vertex and Enter finishes an open polyline', () => {
    const ctx = fakeContext();
    drive(plineTool(), ctx, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 5 }, 'U', { x: 1, y: 1 }, '']);
    const pl = ctx.doc.entities[0] as PolylineEntity;
    expect(pl.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    expect(pl.closed).toBe(false);
    expect(pl.bulges).toBeUndefined();
  });
  it('arc helpers: tangent and three-point bulges', () => {
    expect(tangentBulge({ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 1, y: 0 })).toBeCloseTo(1); // quarter turn each side -> semicircle
    expect(tangentBulge({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 })).toBe(0); // collinear -> straight
    expect(threePointBulge({ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 2, y: 0 })).toBeCloseTo(1);
    expect(threePointBulge({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 })).toBeCloseTo(-1);
  });
});

describe('ELLIPSE, DONUT, POLYGON, POINT, XLINE, MTEXT tools', () => {
  it('ellipse from axis endpoints and a distance', () => {
    const ctx = fakeContext();
    drive(ellipseTool(), ctx, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 1 }]);
    const e = ctx.doc.entities[0] as EllipseEntity;
    expect(e.type).toBe('ellipse');
    expect(e.center).toEqual({ x: 2, y: 0 });
    expect(e.majorAxis.x).toBeCloseTo(2);
    expect(e.ratio).toBeCloseTo(0.5);
    // Center option and elliptical Arc
    const ctx2 = fakeContext();
    drive(ellipseTool(), ctx2, ['A', 'C', { x: 0, y: 0 }, { x: 3, y: 0 }, '1', '0', '90']);
    const arc = ctx2.doc.entities[0] as EllipseEntity;
    expect(arc.center).toEqual({ x: 0, y: 0 });
    expect(arc.ratio).toBeCloseTo(1 / 3);
    expect(arc.startParam).toBeCloseTo(0);
    expect(arc.endParam).toBeCloseTo(Math.PI / 2);
  });
  it('donut produces a wide two-vertex polyline (or a filled dot when the hole is zero)', () => {
    const ctx = fakeContext();
    drive(donutTool(), ctx, ['0.5', '1', { x: 3, y: 3 }, '']);
    const d = ctx.doc.entities[0] as PolylineEntity;
    expect(d.type).toBe('polyline');
    expect(d.bulges).toEqual([1, 1]);
    expect(d.width).toBeCloseTo(0.25);
    expect(Math.abs(polylineArea(d))).toBeCloseTo(Math.PI * 0.375 * 0.375, 4);
    const ctx2 = fakeContext();
    drive(donutTool(), ctx2, ['0', '1', { x: 3, y: 3 }, '']);
    expect(ctx2.doc.entities[0]!.type).toBe('circle');
  });
  it('polygon inscribed / circumscribed / by edge', () => {
    const pts = polygonPoints({ x: 0, y: 0 }, 4, 1, true, 0);
    expect(pts).toHaveLength(4);
    expect(pts[0]!.x).toBeCloseTo(1);
    const circ = polygonPoints({ x: 0, y: 0 }, 4, 1, false, 0);
    expect(Math.hypot(circ[0]!.x, circ[0]!.y)).toBeCloseTo(Math.SQRT2);
    const ctx = fakeContext();
    drive(polygonTool(), ctx, ['6', { x: 0, y: 0 }, '', { x: 2, y: 0 }]);
    const p = ctx.doc.entities[0] as PolylineEntity;
    expect(p.points).toHaveLength(6);
    expect(p.closed).toBe(true);
    const ctx2 = fakeContext();
    drive(polygonTool(), ctx2, ['3', 'E', { x: 0, y: 0 }, { x: 2, y: 0 }]);
    const t = ctx2.doc.entities[0] as PolylineEntity;
    expect(t.points).toHaveLength(3);
    expect(t.points[2]!.y).toBeCloseTo(Math.sqrt(3));
  });
  it('point and xline tools', () => {
    const ctx = fakeContext();
    drive(pointTool(), ctx, [{ x: 1, y: 1 }, { x: 2, y: 2 }, '']);
    expect(ctx.doc.entities.map((e) => e.type)).toEqual(['point', 'point']);
    drive(xlineTool(), ctx, ['H', { x: 0, y: 5 }, '']);
    drive(xlineTool(), ctx, ['A', '45', { x: 0, y: 0 }, '']);
    const xls = ctx.doc.entities.filter((e) => e.type === 'xline');
    expect(xls).toHaveLength(2);
    expect(xls[0]!.type === 'xline' && xls[0]!.direction).toEqual({ x: 1, y: 0 });
    expect(xls[1]!.type === 'xline' && xls[1]!.direction.x).toBeCloseTo(Math.SQRT1_2);
  });
  it('mtext from two corners and typed lines', () => {
    const ctx = fakeContext();
    drive(mtextTool(), ctx, [{ x: 0, y: 5 }, { x: 4, y: 3 }, 'first line', 'second line', '']);
    const m = ctx.doc.entities[0] as MTextEntity;
    expect(m.type).toBe('mtext');
    expect(m.position).toEqual({ x: 0, y: 5 });
    expect(m.width).toBe(4);
    expect(m.text).toBe('first line\nsecond line');
    expect(m.attachment).toBe(1);
    expect(mtextAnchor({ x: 0, y: 0 }, { x: 4, y: 2 }, 9)).toEqual({ x: 4, y: 0 });
  });
});

describe('modify helpers', () => {
  it('fillets two lines with a radius and with a sharp corner', () => {
    const l1 = line('a', [0, 0], [10, 0]);
    const l2 = line('b', [10, 10], [10, -10]);
    const r = filletLines(l1, { x: 2, y: 0 }, l2, { x: 10, y: 5 }, 2)!;
    expect(r.arc).not.toBeNull();
    expect(r.arc!.radius).toBe(2);
    expect(r.arc!.center.x).toBeCloseTo(8);
    expect(r.arc!.center.y).toBeCloseTo(2);
    expect(r.line1.b).toEqual({ x: 8, y: 0 });
    expect(r.line2.b.y).toBeCloseTo(2);
    expect(r.line2.a).toEqual({ x: 10, y: 10 }); // kept end is on the pick side
    const corner = filletLines(line('c', [0, 0], [8, 0]), { x: 1, y: 0 }, line('d', [10, 10], [10, 2]), { x: 10, y: 8 }, 0)!;
    expect(corner.arc).toBeNull();
    expect(corner.line1.b).toEqual({ x: 10, y: 0 }); // extended to the corner
    expect(corner.line2.b).toEqual({ x: 10, y: 0 });
    expect(filletLines(l1, { x: 1, y: 0 }, line('p', [0, 1], [10, 1]), { x: 1, y: 1 }, 1)).toBeNull(); // parallel
    expect(filletLines(l1, { x: 1, y: 0 }, l2, { x: 10, y: 5 }, 50)).toBeNull(); // radius too large
  });
  it('chamfers with two distances', () => {
    const r = chamferLines(line('a', [0, 0], [10, 0]), { x: 2, y: 0 }, line('b', [10, 10], [10, -10]), { x: 10, y: 5 }, 2, 3) as ReturnType<typeof chamferLines> & { bevel?: LineEntity };
    expect(r!.line1.b).toEqual({ x: 8, y: 0 });
    expect(r!.line2.b.y).toBeCloseTo(3);
    expect(r!.bevel!.a).toEqual({ x: 8, y: 0 });
  });
  it('fillets every corner of a rectangle polyline into bulge segments', () => {
    const rect: PolylineEntity = { id: 'r', ...props, type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }] };
    const out = filletPolyline(rect, 0.5)!;
    expect(out.points).toHaveLength(8);
    expect(out.bulges!.filter((b) => Math.abs(b) > 1e-9)).toHaveLength(4);
    expect(Math.abs(polylineArea(out))).toBeCloseTo(8 - (4 - Math.PI) * 0.25, 4);
    expect(polylineVertices(out).length).toBeGreaterThan(8);
  });
  it('arrays objects rectangularly and polar', () => {
    const c: Entity = { id: 'c', ...props, type: 'circle', center: { x: 0, y: 0 }, radius: 0.5 };
    const rect = rectangularArray([c], 2, 3, 2, 3);
    expect(rect).toHaveLength(5);
    expect(rect.map((e) => (e.type === 'circle' ? `${e.center.x},${e.center.y}` : '')).sort()).toEqual(['0,2', '3,0', '3,2', '6,0', '6,2']);
    const pol = polarArray([{ ...c, center: { x: 2, y: 0 } }], { x: 0, y: 0 }, 4, 2 * Math.PI, true);
    expect(pol).toHaveLength(3);
    expect(pol[0]!.type === 'circle' && pol[0]!.center.y).toBeCloseTo(2);
    const half = polarArray([{ ...c, center: { x: 2, y: 0 } }], { x: 0, y: 0 }, 3, Math.PI, true);
    expect(half[1]!.type === 'circle' && half[1]!.center.x).toBeCloseTo(-2);
    expect(new Set(rect.map((e) => e.id)).size).toBe(5);
  });
  it('stretches only the vertices inside the crossing window', () => {
    const l = line('l', [0, 0], [10, 0]);
    const box = { min: { x: 8, y: -1 }, max: { x: 12, y: 1 } };
    const s = stretchEntity(l, box, { x: 0, y: 5 }) as LineEntity;
    expect(s.a).toEqual({ x: 0, y: 0 });
    expect(s.b).toEqual({ x: 10, y: 5 });
    const circle: Entity = { id: 'c', ...props, type: 'circle', center: { x: 9, y: 0 }, radius: 1 };
    expect((stretchEntity(circle, box, { x: 1, y: 0 }) as { center: { x: number } }).center.x).toBe(10);
  });
  it('breaks lines, circles, arcs and polylines', () => {
    const pieces = breakEntity(line('l', [0, 0], [10, 0]), { x: 3, y: 0 }, { x: 6, y: 0 })!;
    expect(pieces).toHaveLength(2);
    expect((pieces[0] as LineEntity).b.x).toBe(3);
    expect((pieces[1] as LineEntity).a.x).toBe(6);
    const split = breakEntity(line('l', [0, 0], [10, 0]), { x: 4, y: 0 }, { x: 4, y: 0 })!;
    expect(split).toHaveLength(2);
    const circ = breakEntity({ id: 'c', ...props, type: 'circle', center: { x: 0, y: 0 }, radius: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 })!;
    expect(circ[0]!.type).toBe('arc');
    expect((circ[0] as ArcEntity).startAngle).toBeCloseTo(Math.PI / 2);
    const arc = breakEntity({ id: 'a', ...props, type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI }, { x: Math.cos(1), y: Math.sin(1) }, { x: Math.cos(2), y: Math.sin(2) })!;
    expect(arc).toHaveLength(2);
    const pl: PolylineEntity = { id: 'p', ...props, type: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] };
    const pp = breakEntity(pl, { x: 2, y: 0 }, { x: 4, y: 1 })!;
    expect(pp).toHaveLength(2);
    expect((pp[0] as PolylineEntity).points).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
    expect((pp[1] as PolylineEntity).points).toEqual([{ x: 4, y: 1 }, { x: 4, y: 4 }]);
  });
  it('joins collinear lines, concentric arcs and chains into polylines', () => {
    const j = joinEntities([line('a', [0, 0], [2, 0]), line('b', [3, 0], [5, 0])])!;
    expect(j).toHaveLength(1);
    expect((j[0] as LineEntity).b.x).toBe(5);
    const arcs: ArcEntity[] = [
      { id: 'a1', ...props, type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 1 },
      { id: 'a2', ...props, type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 1, endAngle: 2 },
    ];
    const ja = joinEntities(arcs)![0] as ArcEntity;
    expect(ja.startAngle).toBe(0);
    expect(ja.endAngle).toBe(2);
    const chain = joinEntities([line('a', [0, 0], [2, 0]), { id: 'arc', ...props, type: 'arc', center: { x: 2, y: 1 }, radius: 1, startAngle: -Math.PI / 2, endAngle: 0 }, line('c', [3, 1], [3, 5])])!;
    expect(chain).toHaveLength(1);
    const pl = chain[0] as PolylineEntity;
    expect(pl.type).toBe('polyline');
    expect(pl.points).toHaveLength(4);
    expect(pl.bulges![1]).toBeCloseTo(Math.tan(Math.PI / 8));
    expect(joinEntities([line('a', [0, 0], [2, 0]), line('b', [5, 5], [6, 6])])).toBeNull();
  });
  it('lengthens, aligns and matches properties', () => {
    const l = lengthenEntity(line('l', [0, 0], [10, 0]), { x: 9, y: 0 }, 2) as LineEntity;
    expect(l.b.x).toBe(12);
    expect(lengthenEntity(line('l', [0, 0], [10, 0]), { x: 1, y: 0 }, -3)!.type === 'line' && (lengthenEntity(line('l', [0, 0], [10, 0]), { x: 1, y: 0 }, -3) as LineEntity).a.x).toBe(3);
    const tf = alignTransform({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 1, y: 0 }, { x: 10, y: 12 }, true);
    const moved = tf(line('l', [0, 0], [1, 0])) as LineEntity;
    expect(moved.a.x).toBeCloseTo(10);
    expect(moved.b.y).toBeCloseTo(12);
    const src: Entity = { id: 's', layer: 'WIRES', color: 1, linetype: 'DASHED', lineWeight: 0.5, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    const dst = matchProperties(src, line('d', [0, 0], [1, 1]));
    expect(dst.layer).toBe('WIRES');
    expect(dst.linetype).toBe('DASHED');
    expect(dst.color).toBe(1);
  });
});

describe('modify tools through the Drawing API', () => {
  it('FILLET tool replaces two lines and adds an arc in one undo step', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([line('a', [0, 0], [10, 0]), line('b', [10, 10], [10, -10])]);
    drive(filletTool(), ctx, ['R', '2', { x: 2, y: 0 }, { x: 10, y: 5 }]);
    expect(ctx.doc.entities).toHaveLength(3);
    expect(ctx.doc.entities.some((e) => e.type === 'arc')).toBe(true);
    ctx.doc.undo();
    expect(ctx.doc.entities).toHaveLength(2);
    expect(ctx.finished).toBe(true);
  });
  it('ARRAYRECT tool copies the selection', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([line('a', [0, 0], [1, 0])]);
    drive(arrayRectTool(), ctx, [{ select: ['a'] }, '2', '2', '1', '1']);
    expect(ctx.doc.entities).toHaveLength(4);
  });
  it('STRETCH tool moves the vertices inside the crossing window', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([line('a', [0, 0], [10, 0]), line('b', [10, 0], [10, 5])]);
    drive(stretchTool(), ctx, [{ x: 8, y: -1 }, { x: 12, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 }]);
    const a = ctx.doc.entity('a') as LineEntity;
    const b = ctx.doc.entity('b') as LineEntity;
    expect(a.b.x).toBe(12);
    expect(b.a.x).toBe(12);
    expect(b.b.x).toBe(10);
  });
  it('BREAK and JOIN tools', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([line('a', [0, 0], [10, 0])]);
    drive(breakTool(), ctx, [{ x: 3, y: 0 }, { x: 6, y: 0 }]);
    expect(ctx.doc.entities).toHaveLength(2);
    drive(joinTool(), ctx, [{ select: ctx.doc.entities.map((e) => e.id) }]);
    expect(ctx.doc.entities).toHaveLength(1);
    expect((ctx.doc.entities[0] as LineEntity).b.x).toBe(10);
  });
});

describe('blocks', () => {
  it('BLOCK defines a block from the selection and replaces it with an insert; INSERT places it', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([line('a', [0, 0], [1, 0]), line('b', [0, 0], [0, 1])]);
    drive(blockTool(), ctx, ['CORNER', { x: 0, y: 0 }, { select: ['a', 'b'] }]);
    expect(ctx.doc.blocks.CORNER).toBeDefined();
    expect(ctx.doc.blocks.CORNER!.entities).toHaveLength(2);
    expect(ctx.doc.entities).toHaveLength(1);
    expect(ctx.doc.entities[0]!.type).toBe('insert');
    ctx.doc.undo();
    expect(ctx.doc.blocks.CORNER).toBeUndefined();
    expect(ctx.doc.entities).toHaveLength(2);
    ctx.doc.redo();
    drive(insertTool(), ctx, ['corner', { x: 5, y: 5 }, '2', '', '90']);
    const ins = ctx.doc.entities[1] as InsertEntity;
    expect(ins.block).toBe('CORNER');
    expect(ins.position).toEqual({ x: 5, y: 5 });
    expect(ins.scale).toBe(2);
    expect(ins.rotation).toBeCloseTo(Math.PI / 2);
    expect(ctx.prompts.some((p) => p.startsWith('Enter X scale factor'))).toBe(true);
  });
  it('INSERT prompts for attribute values', () => {
    const ctx = fakeContext();
    ctx.doc.defineBlock({ name: 'TAGGED', basePoint: { x: 0, y: 0 }, entities: [line('x', [0, 0], [1, 0])], attributes: [{ tag: 'TAG1', prompt: 'Tag', default: 'X1', position: { x: 0, y: 0 }, height: 0.1, align: 'left' }] });
    drive(insertTool('TAGGED'), ctx, [{ x: 1, y: 1 }, '', '', '', 'PB7']);
    const ins = ctx.doc.entities[0] as InsertEntity;
    expect(ins.attributes).toEqual({ TAG1: 'PB7' });
    expect(ctx.prompts).toContain('Tag <X1>:');
  });
  it('purge helpers find unreferenced blocks and layers', () => {
    const d = new Drawing();
    d.defineBlock({ name: 'USED', basePoint: { x: 0, y: 0 }, entities: [], attributes: [] });
    d.defineBlock({ name: 'NESTED', basePoint: { x: 0, y: 0 }, entities: [], attributes: [] });
    d.defineBlock({ name: 'OUTER', basePoint: { x: 0, y: 0 }, entities: [{ id: 'n', ...props, type: 'insert', block: 'NESTED', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }], attributes: [] });
    d.defineBlock({ name: 'UNUSED', basePoint: { x: 0, y: 0 }, entities: [], attributes: [] });
    d.addEntities([
      { id: 'i', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'USED', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} },
      { id: 'o', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'OUTER', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} },
    ]);
    const used = referencedBlocks(d.snapshot);
    expect([...used].sort()).toEqual(['NESTED', 'OUTER', 'USED']);
    expect(unusedLayers(d.snapshot)).toContain('WIRES');
    expect(unusedLayers(d.snapshot)).not.toContain('SYMS');
    expect(unusedLayers(d.snapshot)).not.toContain('0');
    expect(validBlockName('OK-1')).toBe(true);
    expect(validBlockName('bad/name')).toBe(false);
    d.removeBlocks(['UNUSED']);
    expect(d.blocks.UNUSED).toBeUndefined();
    d.removeLayers(['WIRES', '0']);
    expect(d.layer('WIRES')).toBeUndefined();
    expect(d.layer('0')).toBeDefined();
  });
});

describe('inquiry', () => {
  it('areas of circles, polylines and ellipses', () => {
    expect(entityArea({ id: 'c', ...props, type: 'circle', center: { x: 0, y: 0 }, radius: 2 })!.area).toBeCloseTo(4 * Math.PI);
    const rect: PolylineEntity = { id: 'r', ...props, type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }] };
    expect(entityArea(rect)).toEqual({ area: 8, perimeter: 12 });
    const ell: EllipseEntity = { id: 'e', ...props, type: 'ellipse', center: { x: 0, y: 0 }, majorAxis: { x: 2, y: 0 }, ratio: 0.5, startParam: 0, endParam: 2 * Math.PI };
    expect(entityArea(ell)!.area).toBeCloseTo(2 * Math.PI);
    expect(entityArea(line('l', [0, 0], [1, 0]))).toBeNull();
  });
  it('DIST with Multiple points and AREA by points report through the log', () => {
    const ctx = fakeContext();
    drive(distTool(), ctx, [{ x: 0, y: 0 }, 'M', { x: 3, y: 0 }, { x: 3, y: 4 }, '']);
    expect(ctx.logs[ctx.logs.length - 1]).toBe('Distance = 7.0000');
    drive(distTool(), ctx, [{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(ctx.logs.some((l) => l.startsWith('Distance = 5.0000, Angle in XY Plane = 53.13'))).toBe(true);
    drive(areaTool(), ctx, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }, '']);
    expect(ctx.logs[ctx.logs.length - 1]).toBe('Area = 8.0000, Perimeter = 12.0000');
    ctx.doc.addEntities([{ id: 'c', ...props, type: 'circle', center: { x: 10, y: 10 }, radius: 1 }]);
    drive(areaTool(), ctx, ['O', { x: 11, y: 10 }]);
    expect(ctx.logs[ctx.logs.length - 1]).toContain('Circumference = 6.2832');
  });
  it('LIST formats every entity type', () => {
    const d = new Drawing();
    const ents: Entity[] = [
      line('l', [0, 0], [3, 4]),
      { id: 'c', ...props, type: 'circle', center: { x: 0, y: 0 }, radius: 1 },
      { id: 'a', ...props, type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 1 },
      { id: 'p', ...props, type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], bulges: [0.2, 0, 0] },
      { id: 't', ...props, type: 'text', position: { x: 0, y: 0 }, text: 'hi', height: 0.2, rotation: 0, align: 'left' },
      { id: 'm', ...props, type: 'mtext', position: { x: 0, y: 0 }, text: 'a\nb', height: 0.2, width: 2, rotation: 0, attachment: 1, lineSpacing: 1 },
      { id: 'e', ...props, type: 'ellipse', center: { x: 0, y: 0 }, majorAxis: { x: 2, y: 0 }, ratio: 0.5, startParam: 0, endParam: 2 * Math.PI },
      { id: 'pt', ...props, type: 'point', position: { x: 1, y: 2 } },
      { id: 'x', ...props, type: 'xline', base: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      { id: 'd', ...props, type: 'dimension', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 }, linePoint: { x: 1, y: 1 }, rotation: 0, style: { name: 'Standard', textHeight: 0.18, arrowSize: 0.18, extOffset: 0.0625, extExtend: 0.18, textGap: 0.09, centerMark: 0.09, scale: 1, decimals: 4, lunit: 2, angularDecimals: 0 } },
    ];
    for (const e of ents) {
      const out = listEntity(e, d);
      expect(out[0]).toContain(`Layer: "0"`);
      expect(out.length).toBeGreaterThan(3);
    }
    expect(listEntity(ents[0]!, d).some((l) => l.includes('Length = 5.0000'))).toBe(true);
    expect(listEntity(ents[9]!, d).some((l) => l.includes('default text: 2.0000'))).toBe(true);
  });
  it('LIST reports spline, hatch, leader, table and image properties', () => {
    const d = new Drawing();
    const has = (e: Entity, re: RegExp) => expect(listEntity(e, d).some((l) => re.test(l)), String(re)).toBe(true);
    const spline = splineThroughPoints({ id: 's', ...props }, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 }], false)!;
    has(spline, /Degree\s+3$/);
    has(spline, /Number of fit points\s+4$/);
    has(spline, /Number of control points\s+\d+$/);
    has(spline, /length\s+6\.0000$/);
    const hatch: Entity = {
      id: 'h', ...props, type: 'hatch', pattern: 'ANSI31', solid: false, angle: Math.PI / 4, scale: 2,
      loops: [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }, { points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] }],
    };
    has(hatch, /Pattern\s+ANSI31$/);
    has(hatch, /Angle\s+45/);
    has(hatch, /Scale\s+2\.0000$/);
    has(hatch, /Boundary loops\s+2$/);
    has(hatch, /Area of outer loop\s+12\.0000$/);
    const leader: Entity = { id: 'ld', ...props, type: 'leader', kind: 'mleader', vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }], arrow: true, arrowSize: 0.18, text: 'MOTOR\nM1', textHeight: 0.18 };
    has(leader, /Number of vertices\s+3$/);
    has(leader, /Multileader/);
    has(leader, /text\s+MOTOR$/);
    has(leader, /text\s+M1$/);
    const table = newTable({ id: 'tb', ...props }, { position: { x: 0, y: 0 }, columns: 3, dataRows: 4 });
    has(table, new RegExp(`Table size\\s+${table.rowHeights.length} rows x 3 columns$`));
    const image: Entity = { id: 'im', ...props, type: 'image', path: 'logo.png', position: { x: 0, y: 0 }, u: { x: 0.01, y: 0 }, v: { x: 0, y: 0.01 }, size: { x: 200, y: 100 } };
    has(image, /Path\s+logo\.png$/);
    has(image, /Image size \(pixels\)\s+200 x 100$/);
    has(image, /Image size \(units\)\s+2\.0000 x 1\.0000$/);
  });
});
