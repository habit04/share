import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { modelToPaper, paperToModel, viewportModelBounds, viewportPaperBounds, fitViewportView, defaultLayout, applyPaperEntities, paperEntities, type LayoutViewport } from '../src/core/layouts';
import { drawEntity, type Transform } from '../src/render/draw';
import * as g from '../src/core/geometry';

const viewport = (twist: number): LayoutViewport => ({ id: 'rotated', center: { x: 8, y: 5 }, width: 12, height: 6, view: { center: { x: 1000, y: 2000 }, scale: 0.5, twist }, layer: '0', on: true });
const closePoint = (a: g.Point, b: g.Point) => { expect(a.x).toBeCloseTo(b.x, 8); expect(a.y).toBeCloseTo(b.y, 8); };

describe('rotated layout geometry', () => {
  it.each([Math.PI / 2, Math.PI / 6, -Math.PI / 4])('inverts the view projection at angle %s without changing model points', (angle) => {
    const v = viewport(angle), model = { x: 1004, y: 2002 };
    const before = { ...model };
    closePoint(paperToModel(v, modelToPaper(v, model)), model);
    expect(model).toEqual(before);
    closePoint(modelToPaper(v, v.view.center), v.center);
  });
  it('a positive quarter turn displays a model X direction up the sheet and bounds all four corners', () => {
    const v = viewport(Math.PI / 2);
    closePoint(modelToPaper(v, { x: 1004, y: 2000 }), { x: 8, y: 7 });
    const bounds = viewportModelBounds(v);
    closePoint(bounds.min, { x: 994, y: 1988 }); closePoint(bounds.max, { x: 1006, y: 2012 });
    const b = viewportPaperBounds(v);
    for (const p of [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }]) {
      const world = paperToModel(v, p);
      expect(world.x).toBeGreaterThanOrEqual(bounds.min.x - 1e-8);
      expect(world.y).toBeLessThanOrEqual(bounds.max.y + 1e-8);
    }
  });
  it('fits the projected model extents and stretching a frame keeps content anchored on paper', () => {
    const v = viewport(Math.PI / 2);
    const fitted = fitViewportView(v, { min: { x: 0, y: 0 }, max: { x: 20, y: 4 } }, 0);
    expect(fitted.scale).toBeCloseTo(0.3, 9); // 20 model X units occupy the six-unit paper height.
    const layout = { ...defaultLayout('Rotated'), viewports: [v] };
    const [frame] = paperEntities(layout);
    if (!frame || frame.type !== 'polyline') throw new Error('Missing frame');
    const anchor = modelToPaper(v, { x: 1002, y: 2003 });
    const changed = applyPaperEntities(layout, [{ ...frame, points: frame.points.map((p) => p.x > 8 ? { ...p, x: p.x + 2 } : p) }]);
    closePoint(modelToPaper(changed.viewports[0]!, { x: 1002, y: 2003 }), anchor);
    expect(changed.viewports[0]!.view.twist).toBe(Math.PI / 2);
  });
  it('fits an oblique site view equally far from or near the world origin', () => {
    const v = viewport(Math.PI / 6);
    const near = fitViewportView(v, { min: { x: 0, y: 0 }, max: { x: 20, y: 4 } });
    const far = fitViewportView(v, { min: { x: 1e12, y: -1e12 }, max: { x: 1e12 + 20, y: -1e12 + 4 } });
    expect(far.scale).toBe(near.scale);
    expect(far.center).toEqual({ x: 1e12 + 10, y: -1e12 + 2 });
  });
});

/** Record the actual device endpoints of native Canvas curves after every context transform. */
function canvasRecorder() {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [], points: g.Point[] = [];
  const map = (x: number, y: number) => ({ x: matrix[0]! * x + matrix[2]! * y + matrix[4]!, y: matrix[1]! * x + matrix[3]! * y + matrix[5]! });
  const api: Record<string, unknown> = {
    globalAlpha: 1, lineWidth: 1,
    save: () => stack.push([...matrix]), restore: () => { matrix = stack.pop()!; },
    rotate: (angle: number) => {
      const [a, b, c, d, e, f] = matrix, cos = Math.cos(angle), sin = Math.sin(angle);
      matrix = [a! * cos + c! * sin, b! * cos + d! * sin, -a! * sin + c! * cos, -b! * sin + d! * cos, e!, f!];
    },
    moveTo: (x: number, y: number) => points.push(map(x, y)), lineTo: (x: number, y: number) => points.push(map(x, y)),
    arc: (x: number, y: number, radius: number, start: number, end: number) => { points.push(map(x + radius * Math.cos(start), y + radius * Math.sin(start)), map(x + radius * Math.cos(end), y + radius * Math.sin(end))); },
  };
  const ctx = new Proxy(api, { get: (object, key: string) => object[key] ?? (() => {}), set: (object, key: string, value: unknown) => { object[key] = value; return true; } }) as unknown as CanvasRenderingContext2D;
  return { ctx, points };
}

describe('rotated native Canvas geometry', () => {
  it.each([Math.PI / 2, -Math.PI / 6])('rotates both transformed line points and native arc angles exactly once (%s)', (angle) => {
    const center = { x: 1e9, y: -1e9 };
    const tf: Transform = { scale: 10, rotation: angle, toScreen: (point) => { const delta = g.rotate(g.sub(point, center), angle); return { x: 200 + 10 * delta.x, y: 150 - 10 * delta.y }; } };
    const line: Entity = { id: 'line', type: 'line', layer: '0', color: 7, a: center, b: { x: center.x + 2, y: center.y } };
    const arc: Entity = { id: 'arc', type: 'arc', layer: '0', color: 7, center, radius: 2, startAngle: 0, endAngle: Math.PI / 2 };
    const record = canvasRecorder(), drawing = new Drawing();
    drawEntity(record.ctx, line, tf, drawing.layers, drawing.lookupBlock);
    closePoint(record.points[0]!, { x: 200, y: 150 }); closePoint(record.points[1]!, tf.toScreen(line.b));
    record.points.length = 0;
    drawEntity(record.ctx, arc, tf, drawing.layers, drawing.lookupBlock);
    closePoint(record.points[0]!, tf.toScreen({ x: center.x + 2, y: center.y }));
    closePoint(record.points[1]!, tf.toScreen({ x: center.x, y: center.y + 2 }));
  });
});
