import { afterEach, describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockDef, Entity } from '../src/core/entities';
import { defaultLayout, type Layout } from '../src/core/layouts';
import { drawingContext, layoutPageSpec, renderPdfPages, vectorPdf, type PdfPlotStyle } from '../src/io/pdf-vector';
import { textStylesOf } from '../src/io/encoding';
import { renderPageToCanvas, viewportTransform } from '../src/render/layouts';
import { setTextStyles } from '../src/render/hershey';
import { parseContentStream, parsePdfBasics } from './helpers/pdf';

const appearance = { layer: '0', color: 'ByLayer' as const };
const style: PdfPlotStyle = { mode: 'color', lineweights: true, usePlotStyles: true };
const arial = { name: 'ARIAL', font: 'arial.ttf', bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 };

function scene(entities: readonly Entity[], twist: number | undefined = Math.PI / 2, blocks: Record<string, BlockDef> = {}) {
  const layout: Layout = {
    ...defaultLayout('Rotated'), pristine: undefined,
    entities: [{ id: 'paper-line', ...appearance, type: 'line', a: { x: 1, y: 1 }, b: { x: 2, y: 1 } }],
    viewports: [{ id: 'v', center: { x: 5, y: 5 }, width: 8, height: 4, view: { center: { x: 100, y: 200 }, scale: 0.5, ...(twist === undefined ? {} : { twist }) }, layer: 'VIEWPORTS', on: true }],
  };
  const doc = new Drawing({ entities: [...entities], blocks, layouts: [layout], layers: [
    { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
    { name: 'VIEWPORTS', color: 8, visible: true, locked: false, lineWeight: 0.25, plot: false },
  ], meta: { textStyles: { ARIAL: arial } } });
  const state: DrawingState = doc.snapshot;
  const lookup = (name: string) => state.blocks[name];
  const page = layoutPageSpec(state, layout, lookup);
  const context = drawingContext(state, lookup);
  return { state, layout, page, context, render: () => renderPdfPages([page], context, style)[0]! };
}

function close(actual: readonly number[], expected: readonly number[], precision = 3) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, precision));
}

/** Records final device positions, including nested canvas transforms used by real drawEntity. */
function canvasRecorder() {
  type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
  let matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack: Matrix[] = [];
  const points: number[][] = [], rectangles: number[][] = [], arcs: number[][] = [];
  const texts: Array<{ text: string; matrix: Matrix }> = [];
  const point = (x: number, y: number) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
  const multiply = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const m = matrix;
    matrix = { a: m.a * a + m.c * b, b: m.b * a + m.d * b, c: m.a * c + m.c * d, d: m.b * c + m.d * d, e: m.a * e + m.c * f + m.e, f: m.b * e + m.d * f + m.f };
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const api: Record<string, unknown> = {
    canvas, globalAlpha: 1, lineWidth: 1,
    save: () => stack.push({ ...matrix }), restore: () => { matrix = stack.pop()!; },
    translate: (x: number, y: number) => multiply(1, 0, 0, 1, x, y),
    rotate: (angle: number) => multiply(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0),
    scale: (x: number, y: number) => multiply(x, 0, 0, y, 0, 0),
    transform: multiply, getTransform: () => ({ ...matrix }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { matrix = { a, b, c, d, e, f }; },
    moveTo: (x: number, y: number) => points.push(point(x, y)), lineTo: (x: number, y: number) => points.push(point(x, y)),
    rect: (x: number, y: number, width: number, height: number) => rectangles.push([...point(x, y), width, height]),
    arc: (x: number, y: number, radius: number, start: number, end: number) => {
      arcs.push([...point(x + radius * Math.cos(start), y + radius * Math.sin(start)), ...point(x + radius * Math.cos(end), y + radius * Math.sin(end))]);
    },
    fillText: (text: string) => texts.push({ text, matrix: { ...matrix } }),
    measureText: () => ({ width: 20 }), getLineDash: () => [],
  };
  const context = new Proxy(api, { get: (o, k) => o[String(k)] ?? (() => {}), set: (o, k, v) => { o[String(k)] = v; return true; } }) as unknown as CanvasRenderingContext2D;
  return { canvas, points, rectangles, arcs, texts };
}

afterEach(() => setTextStyles({}));

describe('rotated layout vector PDF', () => {
  it('rotates model geometry, inverse-culls the complete clip, and leaves the paper and source coordinates unchanged', () => {
    const line: Entity = { id: 'model-line', ...appearance, type: 'line', a: { x: 99, y: 207 }, b: { x: 100, y: 207 } };
    const s = scene([line]);
    const original = JSON.stringify(s.state);
    const content = parseContentStream(s.render().content);
    expect(content.errors).toEqual([]);
    expect(s.page.groups[0]!.rotation).toBe(Math.PI / 2);
    expect(content.ops.filter(o => o.op === 're').map(o => o.args.map(Number))).toEqual([[72, 216, 576, 288]]);
    const moves = content.ops.filter(o => o.op === 'm').map(o => o.args.map(Number));
    const ends = content.ops.filter(o => o.op === 'l').map(o => o.args.map(Number));
    expect(moves).toContainEqual([108, 324]); expect(ends).toContainEqual([108, 360]);
    expect(moves).toContainEqual([72, 72]); expect(ends).toContainEqual([144, 72]);
    expect(s.page.groups[0]!.entities).toBe(s.state.entities);
    expect(JSON.stringify(s.state)).toBe(original);
    expect(parsePdfBasics(vectorPdf([s.page], s.context, style)).errors).toEqual([]);
  });

  it('keeps geometry visible near an oblique clip corner instead of culling with two inverse corners', () => {
    const s = scene([{ id: 'oblique-line', ...appearance, type: 'line', a: { x: 97, y: 206 }, b: { x: 97.1, y: 206 } }], Math.PI / 4);
    const moves = parseContentStream(s.render().content).ops.filter(o => o.op === 'm').map(o => o.args.map(Number));
    expect(moves).toHaveLength(2);
    close(moves[0]!, [360 - 9 * 36 / Math.SQRT2, 360 + 3 * 36 / Math.SQRT2]);
  });

  it('adds view twist to native-font text and block attribute orientation', () => {
    const block: BlockDef = { name: 'TAGGED', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'TAG', prompt: 'Tag', default: '', position: { x: 0, y: 0 }, height: 0.2, align: 'left', rotation: 0, style: 'ARIAL' }] };
    const s = scene([
      { id: 'text', ...appearance, type: 'text', position: { x: 100, y: 200 }, text: 'VIEW', height: 0.2, rotation: Math.PI / 6, align: 'left', style: 'ARIAL' },
      { id: 'insert', ...appearance, type: 'insert', block: 'TAGGED', position: { x: 100, y: 200 }, scale: 1, rotation: Math.PI / 3, attributes: { TAG: 'VALUE' } },
    ], Math.PI / 2, { TAGGED: block });
    const content = parseContentStream(s.render().content);
    expect(content.texts).toEqual(['VIEW', 'VALUE']);
    const matrices = content.ops.filter(o => o.op === 'Tm').map(o => o.args.map(Number));
    close(matrices[0]!, [-0.5, Math.sqrt(3) / 2, -Math.sqrt(3) / 2, -0.5, 360, 360]);
    close(matrices[1]!, [-Math.sqrt(3) / 2, 0.5, -0.5, -Math.sqrt(3) / 2, 360, 360]);
  });

  it('rotates image axes and image clipping together inside the fixed paper clip', () => {
    const s = scene([{ id: 'image', ...appearance, type: 'image', path: 'image.png', position: { x: 100, y: 200 }, u: { x: 0.1, y: 0 }, v: { x: 0, y: 0.1 }, size: { x: 2, y: 1 } }]);
    const context = { ...s.context, image: () => ({ width: 2, height: 1, kind: 'rgb' as const, data: new Uint8Array(6).fill(128) }) };
    const rendered = renderPdfPages([s.page], context, style)[0]!;
    const content = parseContentStream(rendered.content);
    const matrix = content.ops.find(o => o.op === 'cm')!.args.map(Number);
    close(matrix, [0, 7.2, -3.6, 0, 360, 360]);
    expect(content.counts.W).toBe(2);
    expect(content.counts.Do).toBe(1);
    expect(content.ops.filter(o => o.op === 're').map(o => o.args.map(Number))).toEqual([[72, 216, 576, 288]]);
    expect(parsePdfBasics(vectorPdf([s.page], context, style)).errors).toEqual([]);
  });

  it('rotates Bezier arc endpoints and controls without changing their model angles', () => {
    const arc: Entity = { id: 'arc', ...appearance, type: 'arc', center: { x: 100, y: 200 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2 };
    const s = scene([arc]);
    const content = parseContentStream(s.render().content);
    close(content.ops.find(o => o.op === 'm')!.args.map(Number), [360, 432]);
    const kappa = 4 / 3 * Math.tan(Math.PI / 8);
    close(content.ops.find(o => o.op === 'c')!.args.map(Number), [360 - 72 * kappa, 432, 288, 360 + 72 * kappa, 288, 360]);
    expect(s.state.entities[0]).toEqual(arc);
  });

  it('keeps explicit zero twist identical to an older layout without the optional field', () => {
    const entities: Entity[] = [{ id: 'line', ...appearance, type: 'line', a: { x: 99, y: 200 }, b: { x: 101, y: 200 } }];
    const zero = scene(entities, 0);
    const olderLayout = { ...zero.layout, viewports: zero.layout.viewports.map(v => ({ ...v, view: { center: v.view.center, scale: v.view.scale } })) };
    const olderPage = layoutPageSpec(zero.state, olderLayout, zero.context.lookup);
    expect(zero.page.groups[0]!.rotation).toBeUndefined();
    expect(zero.render().content).toBe(renderPdfPages([olderPage], zero.context, style)[0]!.content);
  });
});

describe('rotated layout raster printing and display', () => {
  it('passes the same applied twist to the viewport display transform', () => {
    const s = scene([]);
    const tf = viewportTransform(s.layout.viewports[0]!, { center: { x: 5, y: 5 }, scale: 20 }, 800, 600);
    expect(tf.rotation).toBe(Math.PI / 2);
    close(Object.values(tf.toScreen({ x: 100, y: 200 })), [400, 300]);
    close(Object.values(tf.toScreen({ x: 101, y: 200 })), [400, 290]);
  });

  it('rotates actual canvas paths, arc angles and native text while clipping in paper coordinates', () => {
    const s = scene([
      { id: 'line', ...appearance, type: 'line', a: { x: 100, y: 200 }, b: { x: 101, y: 200 } },
      { id: 'arc', ...appearance, type: 'arc', center: { x: 100, y: 200 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2 },
      { id: 'text', ...appearance, type: 'text', position: { x: 100, y: 200 }, text: 'VIEW', height: 0.2, rotation: 0, align: 'left', style: 'ARIAL' },
    ]);
    setTextStyles(textStylesOf(s.state));
    const r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.context, style, 72);
    expect([r.canvas.width, r.canvas.height]).toEqual([1224, 792]);
    expect(r.rectangles).toEqual([[72, 288, 576, 288]]);
    close(r.points[0]!, [360, 432]); close(r.points[1]!, [360, 396]);
    close(r.arcs[0]!, [360, 360, 288, 432]);
    const text = r.texts.find(t => t.text === 'VIEW')!;
    expect(text).toBeDefined();
    close([text.matrix.a, text.matrix.b, text.matrix.c, text.matrix.d, text.matrix.e, text.matrix.f], [0, -1, 1, 0, 360, 432]);
    close(r.points.at(-2)!, [72, 720]); close(r.points.at(-1)!, [144, 720]);
  });
});
