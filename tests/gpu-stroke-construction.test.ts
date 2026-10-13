import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { ArcEntity, BlockDef, CircleEntity, Entity, InsertEntity, Layer, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import { polylineSegments } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { drawEntity, lineweightDisplay } from '../src/render/draw';
import * as hershey from '../src/render/hershey';
import { GPU_ZOOM_VERTEX_STRIDE, prepareZoom2D, type Gpu2DView, type PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import { assertPrimitiveStrokePrecision, assertStrokePathPrecision, canvasPolylineStrokeProblem } from '../src/render/gpu-prototype/stroke-parity';

const origin = { x: 1e12, y: 1e12 };
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 1 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 1, center: origin, twist: 0, background: '#212830', lineweights: true };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => ({ entities, blocks, layers: [layer], currentLayer: '0' });
const line = (patch: Partial<LineEntity> = {}): LineEntity => ({ id: 'line', type: 'line', layer: '0', color: 3, a: { x: -5, y: -5 }, b: { x: 5, y: -5 }, ...patch });
const polyline = (points: readonly Point[], patch: Partial<PolylineEntity> = {}): PolylineEntity => ({ id: 'poly', type: 'polyline', layer: '0', color: 3, points, closed: false, ...patch });
const owner = (name: string, patch: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'owner', type: 'insert', layer: '0', color: 3, block: name, position: origin, scale: 1, rotation: 0, attributes: {}, lineWeight: 1, ...patch });
const block = (name: string, entities: readonly Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
const narrow = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 3, position: origin, text: 'J', height: 21, widthFactor: 1e-6, rotation: 0, align: 'left', lineWeight: 1, ...patch });

/** Inspect actual Canvas commands after core's world expansion and actual Hershey construction. */
interface CanvasArcCommand { center: Point; radius: number; start: number; end: number; anticlockwise: boolean }
function canvasPaths(entity: Entity, state: DrawingState, camera = view, arcs: CanvasArcCommand[] = []): Point[][] {
  const output: Point[][] = [];
  let current: Point[][] = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, setLineDash() {}, beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([{ x, y }]); }, lineTo(x: number, y: number) { current[current.length - 1]!.push({ x, y }); },
    arc(x: number, y: number, radius: number, start: number, end: number, anticlockwise: boolean) { arcs.push({ center: { x, y }, radius, start, end, anticlockwise }); },
    closePath() {}, stroke() { output.push(...current); },
  };
  const previous = { ...lineweightDisplay };
  lineweightDisplay.enabled = camera.lineweights ?? false; lineweightDisplay.pxPerMm = undefined;
  try {
    drawEntity(context as unknown as CanvasRenderingContext2D, entity, { scale: camera.scale, toScreen: (point) => ({ x: camera.width / 2 + (point.x - camera.center.x) * camera.scale, y: camera.height / 2 - (point.y - camera.center.y) * camera.scale }) }, state.layers, (name) => state.blocks[name]);
  } finally { Object.assign(lineweightDisplay, previous); }
  return output;
}

/** Independent point-in-triangle oracle for the old near-origin strip's spur. */
function covers(geometry: Pick<PreparedZoom2D, 'vertices'>, point: Point): boolean {
  const vertex = (index: number): Point => {
    const offset = index * GPU_ZOOM_VERTEX_STRIDE;
    return { x: 160 + geometry.vertices[offset]! + geometry.vertices[offset + 2]!, y: 120 + geometry.vertices[offset + 1]! + geometry.vertices[offset + 3]! };
  };
  const cross = (a: Point, b: Point): number => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  for (let index = 0; index < geometry.vertices.length / GPU_ZOOM_VERTEX_STRIDE; index += 3) {
    const a = vertex(index), b = vertex(index + 1), c = vertex(index + 2);
    if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-8) continue;
    const signs = [cross(a, b), cross(b, c), cross(c, a)];
    if (signs.every((value) => value >= -1e-8) || signs.every((value) => value <= 1e-8)) return true;
  }
  return false;
}

function refusalRenderer() {
  const gl = {
    MAX_VIEWPORT_DIMS: 0xd3a, isContextLost: vi.fn(() => false), getParameter: vi.fn(() => new Int32Array([16384, 16384])),
    createShader: vi.fn(), createBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(),
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: vi.fn(() => gl) }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

afterEach(() => vi.restoreAllMocks());

describe('actual Canvas stroke construction parity', () => {
  it('reproduces the collapsed block segment and independently proves the two-pixel GPU miter spur', () => {
    const local = polyline([{ x: -1e-5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }]);
    const reference = owner('B'), state = drawing([reference], { B: block('B', [local]) });
    const native = canvasPaths(reference, state)[0]!;
    expect(native).toEqual([{ x: 160, y: 120 }, { x: 160, y: 120 }, { x: 160, y: 110 }]);
    // Independent ideal two-direction miter: incoming normal (0,1), outgoing
    // (1,0), halfwidth2 gives tip(2,2). Production now refuses this unsafe source
    // before packing; retain the original spur proof without bypassing its guard.
    const before = { vertices: new Float32Array([0, 0, 0, 2, 0, 1, 0, 0, 0, 2, 2, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0]) };
    // Native's recorded path is a vertical butt-capped strip at y<=120. Its actual
    // collapsed first segment adds no join. The old rebased strip covers this whole pixel.
    const pixelCenter = { x: 161.5, y: 121.5 };
    expect(pixelCenter.y).toBeGreaterThan(Math.max(...native.map((point) => point.y)));
    expect(covers(before, pixelCenter)).toBe(true);
    expect(lowerStrokeScene(state, view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('Unsupported Canvas stroke construction:') });
  });

  it.each([1, 2])('refuses collapsed or rotated microscopic LINE directions at DPR %s', (dpr) => {
    for (const endpoints of [[{ x: 0, y: 0 }, { x: 1e-5, y: 0 }], [{ x: 0, y: 0 }, { x: 0.00008, y: 0.00002 }]] as const) {
      const source = line({ a: endpoints[0], b: endpoints[1] });
      const state = drawing([owner('B')], { B: block('B', [source]) });
      expect(lowerStrokeScene(state, { ...view, dpr }, overlay).ok).toBe(false);
    }
  });

  it('preserves ordinary and safe trillion-coordinate line/corner construction without mutating source', () => {
    const source = polyline([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }]);
    const state = sealImmutableData(drawing([owner('B')], { B: block('B', [source, line()]) }));
    const snapshot = JSON.stringify(state);
    for (const dpr of [1, 2]) {
      expect(lowerStrokeScene(state, { ...view, dpr }, overlay).ok).toBe(true);
      expect(lowerStrokeScene(state, { ...view, dpr, twist: 0.43 }, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('native context rotation is unproved') });
    }
    const direct = line({ a: { x: origin.x - 1 / 8192, y: origin.y }, b: { x: origin.x + 1 / 8192, y: origin.y } });
    const near = { ...direct, a: { x: -1 / 8192, y: 0 }, b: { x: 1 / 8192, y: 0 } };
    const close = { ...view, scale: 4096 };
    expect(prepareZoom2D(drawing([direct]), close, overlay).vertices).toEqual(prepareZoom2D(drawing([near]), { ...close, center: { x: 0, y: 0 } }, overlay).vertices);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('guards real miter-limit branches and internal degenerate joins while admitting safe leading zero segments', () => {
    const local = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }];
    expect(() => assertStrokePathPrecision(local, local, false, 4, { ...view, center: { x: 0, y: 0 } }, 1.25)).toThrow(/internal degenerate/);
    const leading = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 }];
    expect(() => assertStrokePathPrecision(leading, leading, false, 4, { ...view, center: { x: 0, y: 0 } }, 1.25)).not.toThrow();
    const before = polyline([{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: -0.981, y: 0.194 }]);
    const after = polyline([{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: -0.979, y: 0.204 }]);
    expect(() => assertPrimitiveStrokePrecision(before, after, 4, { ...view, center: { x: 0, y: 0 } }, 1.25)).toThrow(/miter or bevel branch/);
  });

  it('retains complete Canvas rendering for open and sharp positive-bulge connection topology', () => {
    const points = [{ x: -2, y: 0 }, { x: 2, y: 0 }];
    const source = polyline(points, { bulges: [0.5] });
    const nearOrigin = { x: 30, y: -20 }, camera = { ...view, center: nearOrigin, scale: 20, twist: 0.4 };
    const state = drawing([owner('B', { position: nearOrigin })], { B: block('B', [source]) });
    expect(lowerStrokeScene(state, camera, overlay)).toEqual({ ok: false, reason: expect.stringContaining('native float arc connection is unproved') });
    const sharp = polyline([...points, { x: 3, y: 2 }], { bulges: [0.5, 0] });
    expect(lowerStrokeScene(drawing([owner('B', { position: nearOrigin })], { B: block('B', [sharp]) }), camera, overlay)).toEqual({ ok: false, reason: expect.stringContaining('native float arc connection is unproved') });
    const collapsed = polyline([{ x: 0, y: 0 }, { x: 1e-5, y: 0 }], { bulges: [0.5] });
    expect(lowerStrokeScene(drawing([owner('B')], { B: block('B', [collapsed]) }), view, overlay).ok).toBe(false);
  });

  it('combines native ARC start and sweep displacement rather than accepting each separately', () => {
    const source: ArcEntity = { id: 'arc', type: 'arc', layer: '0', color: 3, center: { x: 0, y: 0 }, radius: 1000, startAngle: 0, endAngle: 1 };
    const native = { ...source, startAngle: 0.000035, endAngle: 1.00007 };
    const endpoint = (arc: ArcEntity) => ({ x: arc.radius * Math.cos(arc.endAngle), y: arc.radius * Math.sin(arc.endAngle) });
    expect(Math.hypot(endpoint(source).x - endpoint(native).x, endpoint(source).y - endpoint(native).y)).toBeGreaterThan(0.0625);
    expect(() => assertPrimitiveStrokePrecision(source, native, 4, { ...view, center: { x: 0, y: 0 } }, 1)).toThrow(/curve construction exceeds/);
  });

  it('applies the same curve-construction reserve over cached zoom and physical DPR', () => {
    const source: CircleEntity = { id: 'circle', type: 'circle', layer: '0', color: 3, center: { x: 0, y: 0 }, radius: 2 };
    const native = { ...source, center: { x: 0.04, y: 0 } };
    expect(() => assertPrimitiveStrokePrecision(source, native, 4, { ...view, center: { x: 0, y: 0 } }, 1.25)).not.toThrow();
    expect(() => assertPrimitiveStrokePrecision(source, native, 4, { ...view, center: { x: 0, y: 0 }, dpr: 2 }, 1.25)).toThrow(/curve construction exceeds/);
  });

  it('proves actual negative-bulge Canvas connector commands independently of GPU curve tessellation', () => {
    const entity = polyline([{ x: -2, y: 0 }, { x: 2, y: 0 }], { bulges: [-0.5], lineWeight: 1 });
    const camera = { ...view, center: { x: 0, y: 0 }, scale: 20 };
    const arcs: CanvasArcCommand[] = [], paths = canvasPaths(entity, drawing([entity]), camera, arcs);
    expect(paths[0]![0]).toEqual({ x: 120, y: 120 });
    expect(arcs).toHaveLength(1);
    const native = arcs[0]!, at = (angle: number) => ({ x: native.center.x + native.radius * Math.cos(angle), y: native.center.y + native.radius * Math.sin(angle) });
    expect(native.anticlockwise).toBe(true);
    expect(at(native.start).x).toBeCloseTo(200, 12); expect(at(native.start).y).toBeCloseTo(120, 12);
    expect(at(native.end).x).toBeCloseTo(120, 12); expect(at(native.end).y).toBeCloseTo(120, 12);
    // Actual Canvas connects moveTo(A) to arc-start(B), so its four-pixel stroke covers
    // the chord midpoint. The old signed GPU sweep traversed the same circle in reverse,
    // with no chord; an independently prepared standalone ARC proves that missing strip.
    const sameCurve: ArcEntity = { id: 'reference', type: 'arc', layer: '0', color: 3, center: { x: 0, y: -1.5 }, radius: 2.5, startAngle: -native.start, endAngle: -native.end, lineWeight: 1 };
    expect(covers(prepareZoom2D(drawing([sameCurve]), camera, overlay), { x: 160, y: 120 })).toBe(false);
    expect(() => prepareZoom2D(drawing([entity]), camera, overlay)).toThrow(/negative bulge has native connector/);
    const positive = { ...entity, bulges: [0.5] };
    expect(canvasPolylineStrokeProblem(positive)).toContain('native float arc connection is unproved');
    expect(() => prepareZoom2D(drawing([positive]), camera, overlay)).toThrow(/native float arc connection is unproved/);
    expect(lowerStrokeScene(drawing([owner('B', { position: { x: 0, y: 0 } })], { B: block('B', [positive]) }), camera, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('native float arc connection is unproved') });
    expect(canvasPolylineStrokeProblem({ ...entity, bulges: [-1e-15] })).toBeNull();
    expect(canvasPolylineStrokeProblem({ ...entity, bulges: [-Infinity, NaN] })).toBeNull();
  });

  it.each(['direct', 'nested'] as const)('refuses a late negative-bulge %s source before any GL submission', (kind) => {
    const entity = polyline([{ x: -2, y: 0 }, { x: 2, y: 0 }], { bulges: [-0.5] });
    const near = { ...view, center: { x: 0, y: 0 }, scale: 20 };
    const nested = owner('LEAF', { position: { x: 0, y: 0 } }), root = owner('ROOT', { position: { x: 0, y: 0 } });
    const state = drawing([line(), kind === 'direct' ? entity : root], { ROOT: block('ROOT', [nested]), LEAF: block('LEAF', [entity]) });
    const { renderer, gl } = refusalRenderer();
    expect(renderer.render(state, near, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('Unsupported Canvas stroke construction: negative bulge has native connector'), bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses direct world bulge-center quantization that already consumes a quarter pixel before tessellation', () => {
    const entity = polyline([{ x: origin.x - 1 / 8192, y: origin.y }, { x: origin.x + 1 / 8192, y: origin.y }], { bulges: [0.5], lineWeight: undefined });
    const local = { ...entity, points: entity.points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })) };
    const nativeArc = polylineSegments(entity)[0]!.arc!, referenceArc = polylineSegments(local)[0]!.arc!;
    const camera = { ...view, center: origin, scale: 8192, lineweights: false };
    const arcs: CanvasArcCommand[] = [];
    canvasPaths(entity, drawing([entity]), camera, arcs);
    expect(arcs[0]!.center).toEqual({ x: 160, y: 119 });
    expect(arcs[0]!.radius).toBe(1.25);
    expect((nativeArc.center.y - origin.y) * camera.scale).toBe(1);
    expect(referenceArc.center.y * camera.scale).toBe(0.75);
    expect(Math.abs((nativeArc.center.y - origin.y - referenceArc.center.y) * camera.scale)).toBe(0.25);
    expect(() => prepareZoom2D(drawing([entity]), camera, overlay)).toThrow(/Unsupported Canvas stroke construction:/);
    const harmlessText = narrow({ id: 'safe-qtext', height: 1 / 8192, widthFactor: 1 });
    expect(lowerStrokeScene(drawing([harmlessText, entity]), camera, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('Unsupported Canvas stroke construction:') });
    expect(() => prepareZoom2D(drawing([local]), { ...camera, center: { x: 0, y: 0 } }, overlay)).toThrow(/native float arc connection is unproved/);
    const { renderer, gl } = refusalRenderer();
    expect(renderer.render(drawing([line({ a: origin, b: { x: origin.x + 1, y: origin.y } }), entity]), camera, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('matches repeated/hidden primitive slots through rotated nested definitions', () => {
    const leaf = block('LEAF', [{ ...line(), id: 'same', layer: 'OFF' }, { ...line(), id: 'same' }]);
    const nested = owner('LEAF', { id: 'nested', position: { x: 1, y: 1 }, rotation: 0.2 });
    const root = block('ROOT', [nested, { ...nested, position: { x: 3, y: -1 } }]);
    const state = { ...drawing([owner('ROOT', { position: { x: 30, y: -20 }, rotation: 0.3 })], { ROOT: root, LEAF: leaf }), layers: [layer, { ...layer, name: 'OFF', visible: false }] };
    expect(lowerStrokeScene(state, { ...view, center: { x: 30, y: -20 }, scale: 20, twist: 0.4 }, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('native context rotation is unproved') });
    const result = lowerStrokeScene(state, { ...view, center: { x: 30, y: -20 }, scale: 20 }, overlay);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.operations.map((operation) => operation.sourceId)).toEqual(['same', 'same']);
  });

  it('derives the narrow J counterexample from actual Canvas glyph commands before any full glyph allocation', () => {
    const entity = narrow(), state = drawing([entity]);
    const paths = canvasPaths(entity, state);
    expect(paths).toHaveLength(1);
    expect(new Set(paths[0]!.map((point) => point.x))).toEqual(new Set([160]));
    expect(paths[0]![4]).toEqual(paths[0]![5]);
    expect(Math.max(...paths[0]!.map((point) => point.y))).toBe(120);
    const glyphs = vi.spyOn(hershey, 'strokeText');
    expect(lowerStrokeScene(state, view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('Unsupported Canvas stroke construction:') });
    expect(glyphs).not.toHaveBeenCalled();
  });

  it('uses actual native ATTRIB world placement for the same narrow glyph refusal', () => {
    const definition: BlockDef = { ...block('ATTR', []), attributes: [{ tag: 'TAG', prompt: '', default: 'J', position: { x: 0, y: 0 }, height: 21, widthFactor: 1e-6, align: 'left' }] };
    const reference = owner('ATTR'), state = drawing([reference], { ATTR: definition });
    expect(canvasPaths(reference, state)[0]![4]).toEqual(canvasPaths(reference, state)[0]![5]);
    expect(lowerStrokeScene(state, view, overlay).ok).toBe(false);
  });

  it('retains safely constructed readable text, oblique text and QTEXT at giant origins', () => {
    for (const entity of [narrow({ widthFactor: 1 }), narrow({ widthFactor: 1.2, oblique: 0.5 }), narrow({ height: 1, widthFactor: 1.3 })]) expect(lowerStrokeScene(drawing([entity]), view, overlay), JSON.stringify(entity)).toMatchObject({ ok: true });
    expect(lowerStrokeScene(drawing([narrow({ position: { x: 0, y: 0 }, widthFactor: 1.2, oblique: Math.atan(1000) })]), { ...view, center: { x: 0, y: 0 } }, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('near-reversal join is unproved') });
    expect(lowerStrokeScene(drawing([narrow({ position: { x: 0, y: 0 }, widthFactor: 1.2, oblique: 0.5 })]), { ...view, center: { x: 0, y: 0 } }, overlay).ok).toBe(true);
  });

  it.each(['polyline', 'text', 'attribute'] as const)('refuses late unsafe %s without GL allocation, upload, clearing or drawing', (kind) => {
    const definition = kind === 'attribute'
      ? { ...block('B', []), attributes: [{ tag: 'TAG', prompt: '', default: 'J', position: { x: 0, y: 0 }, height: 21, widthFactor: 1e-6, align: 'left' as const }] }
      : block('B', [polyline([{ x: -1e-5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }])]);
    const state = drawing([line({ a: origin, b: { x: origin.x + 10, y: origin.y } }), kind === 'text' ? narrow() : owner('B')], { B: definition });
    const { gl, renderer } = refusalRenderer();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('Unsupported Canvas stroke construction:'), bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });
});
