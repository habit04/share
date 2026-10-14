import { describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { ArcEntity, BlockDef, CircleEntity, Entity, InsertEntity, Layer, LineEntity, PolylineEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { drawEntity } from '../src/render/draw';
import { prepare2D, prepareCompiledZoom2D, prepareZoom2D, prepareZoomLine, type Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { assertPrimitiveStrokePrecision, canvasPolylineStrokeProblem } from '../src/render/gpu-prototype/stroke-parity';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const reason = 'Unsupported Canvas stroke construction: native float arc connection is unproved';
const negativeReason = 'Unsupported Canvas stroke construction: negative bulge has native connector';
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.25 };
const view: Gpu2DView = { width: 8192, height: 800, center: { x: 0, y: 0 }, scale: 1, dpr: 1, twist: 0, background: '#212830', lineweights: true };
const polyline: PolylineEntity = { id: 'native-open-arc', type: 'polyline', layer: '0', color: 3, points: [{ x: 0.00015, y: 0 }, { x: 2000.00035, y: 0 }], bulges: [1], closed: false };
const line: LineEntity = { id: 'safe-line', type: 'line', layer: '0', color: 7, a: { x: -10, y: -10 }, b: { x: -5, y: -10 } };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => ({ entities, layers: [layer], blocks, currentLayer: '0' });
const definition = (name: string, entities: readonly Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
const insert = (block: string, position = { x: 0, y: 0 }): InsertEntity => ({ id: block, type: 'insert', layer: '0', color: 3, block, position, rotation: 0, scale: 1, attributes: {} });

function refusalRenderer() {
  const gl = { MAX_VIEWPORT_DIMS: 0xd3a, isContextLost: () => false, getParameter: () => new Int32Array([32768, 32768]), createShader: vi.fn(), createBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), clear: vi.fn(), drawArrays: vi.fn() };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: () => gl }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

describe('native float bulge path topology admission', () => {
  it.each([1, 2.5, 16])('records the actual 8192-wide Canvas moveTo then ARC commands at width %s', (width) => {
    const context = { globalAlpha: 1, save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn() };
    drawEntity(context as unknown as CanvasRenderingContext2D, polyline, { scale: 1, toScreen: (point) => ({ x: 4096 + point.x, y: 400 - point.y }) }, [layer], () => undefined, { lineWidthOverride: width });
    expect(context.moveTo).toHaveBeenCalledExactlyOnceWith(4096.00015, 400);
    expect(context.arc).toHaveBeenCalledExactlyOnceWith(5096.00025, 400, 1000.0001, -Math.PI, -0, true);
    expect(context.moveTo.mock.invocationCallOrder[0]).toBeLessThan(context.arc.mock.invocationCallOrder[0]!);
    expect(context.lineTo).not.toHaveBeenCalled();
    // These are actual painter commands, not a simulated Skia raster proof. The
    // pinned Windows native audit separately observed extra cap pixels at this
    // source/view: width16=64, width2.5=1, unlike standalone ARC and admitted GPU.
    expect(canvasPolylineStrokeProblem(polyline)).toBe(reason);
  });

  it('preserves the negative-connector reason and core straight-bulge threshold', () => {
    expect(canvasPolylineStrokeProblem({ ...polyline, bulges: [-0.5, 1] })).toBe(negativeReason);
    for (const bulge of [0, 1e-15, -1e-15]) expect(canvasPolylineStrokeProblem({ ...polyline, bulges: [bulge] })).toBeNull();
    for (const bulge of [1e-12, 0.01, 0.5, 1, 1e12]) expect(canvasPolylineStrokeProblem({ ...polyline, bulges: [bulge] })).toBe(reason);
    // Invalid numeric bulges remain the existing validation error's responsibility.
    expect(canvasPolylineStrokeProblem({ ...polyline, bulges: [NaN, Infinity] })).toBeNull();
  });

  it.each([1, 2, 3])('refuses every positive source arc before GL over DPR%s, twist, lineweight and origin changes', (dpr) => {
    for (const center of [{ x: 0, y: 0 }, { x: 1e12, y: -1e12 }]) for (const twist of [0, 0.63]) for (const lineWeight of [0.25, 0.625, 4]) {
      const source: PolylineEntity = { ...polyline, lineWeight, points: polyline.points.map((point) => ({ x: center.x + point.x, y: center.y + point.y })) };
      const safe = { ...line, a: { x: center.x - 10, y: center.y - 10 }, b: { x: center.x - 5, y: center.y - 10 } };
      const state = sealImmutableData(drawing([safe, source])), snapshot = JSON.stringify(state), camera = { ...view, center, dpr, twist };
      const { renderer, gl } = refusalRenderer();
      for (const scale of [1, 1.1]) expect(renderer.render(state, { ...camera, scale }, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining(reason), bytes: 0, uploadCalls: 0 });
      for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
      expect(JSON.stringify(state)).toBe(snapshot);
      renderer.dispose();
    }
  });

  it('refuses late nested arcs and smooth closed seams as complete views', () => {
    const nested = insert('LEAF'), root = insert('ROOT');
    for (const source of [polyline, { ...polyline, closed: true, bulges: [1, 1] }]) {
      const state = drawing([line, root], { ROOT: definition('ROOT', [nested]), LEAF: definition('LEAF', [source]) });
      const { renderer, gl } = refusalRenderer();
      expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining(reason), bytes: 0, uploadCalls: 0 });
      for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
      renderer.dispose();
    }
  });

  it('applies the same guard through direct, compiled and explicit primitive admission', () => {
    const state = drawing([line, polyline]);
    for (const prepare of [prepare2D, prepareZoom2D, prepareCompiledZoom2D]) expect(() => prepare(state, view, overlay)).toThrow(reason);
    expect(lowerStrokeScene(state, view, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    expect(() => assertPrimitiveStrokePrecision(polyline, polyline, 16, view, 1.25)).toThrow(reason);
  });

  it('preserves signed terminal topology provenance without treating forged messages as precision retries', () => {
    const lowered = lowerStrokeScene(drawing([line, polyline]), view, overlay);
    expect(lowered.ok).toBe(false);
    if (lowered.ok) throw new Error('Expected native topology refusal');
    expect(isSourceTopologyAdmissionError(lowered.cause)).toBe(true);
    expect(isSourcePrecisionCertificateError(lowered.cause)).toBe(false);
    expect(Object.keys(lowered)).toEqual(['ok', 'reason']);
    let error: unknown;
    try { prepareCompiledZoom2D(drawing([line, polyline]), view, overlay); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(isSourceTopologyAdmissionError((error as Error).cause)).toBe(true);
    for (const forged of [new Error(reason), new TypeError(reason), new RangeError(reason)]) {
      expect(isSourceTopologyAdmissionError(forged)).toBe(false);
      expect(isSourcePrecisionCertificateError(forged)).toBe(false);
    }
  });

  it('retains direct ARC, CIRCLE, LINE and unbulged POLYLINE GPU geometry', () => {
    const arc: ArcEntity = { id: 'direct-arc', type: 'arc', layer: '0', color: 3, center: { x: 0, y: 0 }, radius: 20, startAngle: 0, endAngle: Math.PI };
    const circle: CircleEntity = { id: 'direct-circle', type: 'circle', layer: '0', color: 3, center: { x: 30, y: 0 }, radius: 10 };
    const straight = { ...polyline, bulges: [0] };
    for (const source of [arc, circle, line, straight]) {
      expect(prepare2D(drawing([source]), view, overlay).vertices.length).toBeGreaterThan(0);
      expect(lowerStrokeScene(drawing([source]), view, overlay).ok).toBe(true);
    }
  });

  it('refuses the natively observed straight microedge spur as a complete view before GL', () => {
    const source: PolylineEntity = { ...polyline, points: [{ x: -1e-6, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }], bulges: [0, 0], lineWeight: 4 };
    const camera = { ...view, width: 1216, height: 552, scale: 10 }, state = drawing([line, source]);
    for (const prepare of [prepare2D, prepareZoom2D, prepareCompiledZoom2D]) expect(() => prepare(state, camera, overlay)).toThrow('native float segment topology is unproved');
    const { renderer, gl } = refusalRenderer();
    expect(renderer.render(sealImmutableData(state), camera, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('native float segment topology is unproved'), bytes: 0, uploadCalls: 0 });
    for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses an unproved native context rotation while preserving ordinary zero-twist paths', () => {
    const source = { ...polyline, points: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }], bulges: [0, 0] };
    for (const entity of [line, source]) {
      expect(prepare2D(drawing([entity]), view, overlay).vertices.length).toBeGreaterThan(0);
      for (const twist of [0.00001, 0.63, Math.PI / 2]) expect(() => prepare2D(drawing([entity]), { ...view, twist }, overlay)).toThrow('native context rotation is unproved');
    }
  });

  it('certifies edited two-point source caps at the actual stored maximum zoom ratio', () => {
    const camera = { ...view, width: 1216, height: 552 }, source: LineEntity = { ...line, a: { x: 400, y: 0 }, b: { x: 400.075, y: 0 }, lineWeight: 4 }, state = drawing([source]);
    expect(prepareZoomLine(source, state, camera, overlay, { x: 1000, y: 1000 }, 1.25).vertices.length).toBeGreaterThan(0);
    expect(() => prepareZoomLine(source, state, camera, overlay, { x: 1000, y: 1000 }, 4)).toThrow('native float point, normal or miter exceeds precision budget');
  });
});
