import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { Entity, Layer, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { lowerStrokeScene, type LocalStrokePath, type StrokePaintOperation } from '../src/render/gpu-prototype/stroke-scene';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DOverlay, Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 1 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 20, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const text: TextEntity = { id: 'text', type: 'text', layer: '0', color: 1, position: { x: 0, y: 0 }, text: 'TAG A1', height: 1, rotation: 0, align: 'left' };
const state = (entities: readonly Entity[]): DrawingState => ({ entities, layers: [layer], blocks: {}, currentLayer: '0' });
const operation = (paths: readonly LocalStrokePath[], widthCss = 1): StrokePaintOperation => ({ ownerId: 'owner', sourceId: 'source', paintId: 'owner:0', paths, widthCss, alpha: 1, color: [1, 0, 0] });
const path = (points: readonly Point[], closed = false): LocalStrokePath => ({ kind: 'path', points, closed });
const count = (paths: readonly LocalStrokePath[], camera = { ...view, scale: 1 }, extent = { x: 5, y: 5 }, width = 1) => geometry.compiledStraightVertexLowerBound([operation(paths, width)], camera, extent);

/** Frozen pre-refactor packing reference, with its own clipping and stroke implementation. */
function legacyStroke(source: readonly Point[], closed: boolean, width: number, color: readonly number[], extent: Point, output: number[]): void {
  const points = source.filter((point, index) => index === 0 || point.x !== source[index - 1]!.x || point.y !== source[index - 1]!.y);
  if (points.length < 2) return;
  const triangle = (a: Point, ao: Point, b: Point, bo: Point, c: Point, co: Point) => {
    for (const [point, offset] of [[a, ao], [b, bo], [c, co]]) output.push(point!.x, point!.y, offset!.x, offset!.y, ...color);
  };
  const clip = (a: Point, b: Point): [Point, Point] | null => {
    let first = 0, last = 1;
    const delta = { x: b.x - a.x, y: b.y - a.y };
    for (const axis of ['x', 'y'] as const) {
      if (delta[axis] === 0) { if (Math.abs(a[axis]) > extent[axis]) return null; continue; }
      const t1 = (-extent[axis] - a[axis]) / delta[axis], t2 = (extent[axis] - a[axis]) / delta[axis];
      first = Math.max(first, Math.min(t1, t2)); last = Math.min(last, Math.max(t1, t2));
      if (first > last) return null;
    }
    const at = (t: number): Point => ({ x: Math.max(-extent.x, Math.min(extent.x, a.x + delta.x * t)), y: Math.max(-extent.y, Math.min(extent.y, a.y + delta.y * t)) });
    return [at(first), at(last)];
  };
  const half = width / 2, segments = closed ? points.length : points.length - 1;
  const normals: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const normal = length ? { x: -dy / length, y: dx / length } : { x: 0, y: 0 };
    normals.push(normal);
    const clipped = clip(a, b);
    if (!clipped) continue;
    const left = { x: normal.x * half, y: normal.y * half }, right = { x: -left.x, y: -left.y };
    triangle(clipped[0], left, clipped[1], left, clipped[1], right);
    triangle(clipped[0], left, clipped[1], right, clipped[0], right);
  }
  for (let i = closed ? 0 : 1; i < segments; i++) {
    const point = points[i]!;
    if (Math.abs(point.x) > extent.x || Math.abs(point.y) > extent.y) continue;
    const previous = normals[(i + segments - 1) % segments]!, next = normals[i]!;
    const cross = previous.x * next.y - previous.y * next.x;
    if (Math.abs(cross) < 1e-12) continue;
    const side = cross > 0 ? -1 : 1;
    const a = { x: previous.x * side * half, y: previous.y * side * half }, b = { x: next.x * side * half, y: next.y * side * half };
    triangle(point, { x: 0, y: 0 }, point, a, point, b);
    const denominator = 1 + previous.x * next.x + previous.y * next.y;
    if (denominator <= 1e-12) continue;
    const miter = { x: (previous.x + next.x) * side * half / denominator, y: (previous.y + next.y) * side * half / denominator };
    if (Math.hypot(miter.x, miter.y) <= half * 10) triangle(point, a, point, miter, point, b);
  }
}

function legacyCompiled(drawing: DrawingState, camera: Gpu2DView, ov = overlay) {
  const lowered = lowerStrokeScene(drawing, camera, ov);
  if (!lowered.ok) throw new Error(lowered.reason);
  const padding = geometry.GPU_PAN_CACHE_BORDER / Math.max(1, camera.dpr);
  const extrusion = lowered.operations.reduce((largest, paint) => Math.max(largest, paint.widthCss * 5), 0);
  const guard = 1 / Math.max(1, camera.dpr);
  const extent = { x: (camera.width / 2 + padding + extrusion + guard) / lowered.minRatio, y: (camera.height / 2 + padding + extrusion + guard) / lowered.minRatio };
  const output: number[] = [], batches: geometry.StrokeBatch[] = [];
  const bounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  for (const paint of lowered.operations) {
    const first = output.length / geometry.GPU_ZOOM_VERTEX_STRIDE;
    for (const source of paint.paths) {
      const points = source.kind === 'path' ? source.points : source.entity.type === 'line' ? [source.entity.a, source.entity.b] : source.entity.type === 'polyline' ? source.entity.points : null;
      if (!points) throw new Error('Legacy reference covers straight paths only');
      const centers = points.map((point) => {
        const c = Math.cos(camera.twist), s = Math.sin(camera.twist);
        const center = { x: camera.width / 2 + (point.x * c - point.y * s) * camera.scale - camera.width / 2, y: camera.height / 2 - (point.x * s + point.y * c) * camera.scale - camera.height / 2 };
        for (const axis of ['x', 'y'] as const) { bounds.min[axis] = Math.min(bounds.min[axis], center[axis]); bounds.max[axis] = Math.max(bounds.max[axis], center[axis]); }
        return center;
      });
      legacyStroke(centers, source.kind === 'path' ? source.closed : source.entity.type === 'polyline' && source.entity.closed, paint.widthCss, paint.color, extent, output);
    }
    const vertices = output.length / geometry.GPU_ZOOM_VERTEX_STRIDE - first;
    if (vertices) batches.push({ id: paint.paintId, first, count: vertices, alpha: paint.alpha });
  }
  if (!Number.isFinite(bounds.min.x)) bounds.min = bounds.max = { x: 0, y: 0 };
  return { vertices: new Float32Array(output), batches, sourceBounds: bounds, extent };
}

function refusalRenderer() {
  const gl = {
    MAX_VIEWPORT_DIMS: 0xd3a, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    isContextLost: vi.fn(() => false),
    getParameter: vi.fn(() => new Int32Array([16384, 16384])),
    // Refused geometry must not get as far as this intentionally unavailable program.
    createShader: vi.fn(() => null), createBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; },
    get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: () => gl as unknown as WebGL2RenderingContext }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

function expectNoSubmission(gl: ReturnType<typeof refusalRenderer>['gl']): void {
  for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
}

function expectNativeRefusal(drawing: DrawingState, camera: Gpu2DView, reason: string, topology = false, ov: Gpu2DOverlay = overlay): void {
  let failure: unknown;
  try { geometry.prepareCompiledZoom2D(drawing, camera, ov); } catch (error) { failure = error; }
  expect((failure as Error).message).toBe(reason);
  expect((topology ? isSourceTopologyAdmissionError : isSourcePrecisionCertificateError)((failure as Error).cause)).toBe(true);
  const { renderer, gl } = refusalRenderer();
  try {
    expect(renderer.render(drawing, camera, ov)).toMatchObject({ rendered: false, reason, bytes: 0, uploadCalls: 0, submissionMs: 0 });
    expectNoSubmission(gl);
  } finally { renderer.dispose(); }
}

/** Separately certified right-angle cycles retain a large stroke/point workload
 * without the original backtracking path's unproved 180-degree joins.
 */
function squareCycles(length: number, x = 0): Point[] {
  const corners = [{ x, y: 0 }, { x: x + 1, y: 0 }, { x: x + 1, y: 1 }, { x, y: 1 }];
  return Array.from({ length }, (_, index) => ({ ...corners[index % 4]! }));
}

afterEach(() => vi.restoreAllMocks());

describe('compiled straight-stroke budget preflight', () => {
  it('counts exact retained segments, miter/bevel joins and adjacent duplicate semantics', () => {
    const corner = [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }];
    expect(count([path(corner)])).toBe(18);
    expect(count([path([corner[0]!, corner[1]!, corner[1]!, corner[2]!])])).toBe(18);
    expect(count([path([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0.01 }])])).toBe(15);
    expect(count([path([{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }])])).toBe(12);
    expect(count([path(corner, true)])).toBe(36);
    expect(count([path([{ x: 1, y: 1 }, { x: 1, y: 1 }])])).toBe(0);
    expect(count([path([])])).toBe(0);
  });

  it.each([
    { name: 'near reversal', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0.01 }], reason: 'near-reversal join is unproved', topology: false },
    { name: 'exact reversal', points: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }], reason: 'near-reversal join is unproved', topology: false },
    { name: 'internal duplicate', points: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }], reason: 'internal degenerate join is unproved', topology: true },
  ])('keeps the original $name counter input separate from strict native rendering admission', ({ points, reason, topology }) => {
    const original: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    expectNativeRefusal(state([original, { ...text, text: '' }]), { ...view, scale: 1 }, `Unsupported Canvas stroke construction: ${reason}`, topology);
  });

  it('counts clipped entering segments and retained joins rather than all source points', () => {
    expect(count([path([{ x: -100, y: 0 }, { x: 100, y: 0 }])])).toBe(6);
    expect(count([path([{ x: 6, y: 0 }, { x: 100, y: 0 }])])).toBe(0);
    expect(count([path([{ x: -100, y: 6 }, { x: 100, y: 6 }])])).toBe(0);
    expect(count([path([{ x: 5, y: 5 }, { x: 10, y: 10 }])])).toBe(6); // tangent retains degenerate triangles
    const entering = [{ x: 8, y: 0 }, { x: 8, y: 1 }];
    expect(count([path(entering)], { ...view, scale: 1 }, { x: 9, y: 9 })).toBe(6);
    expect(count([path([{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 1 }])])).toBe(0);
  });

  it('accepts the last representable six-vertex count below one million and refuses the next segment', () => {
    const points = Array.from({ length: 166_667 }, (_, index) => ({ x: index % 2, y: 0 }));
    expect(count([path(points)])).toBe(999_996);
    expect(() => count([path([...points, { x: 1, y: 0 }])])).toThrow('Stroke geometry exceeds prototype budget');
  });

  it('counts unbulged polylines but leaves all curved primitives to normal complete packing', () => {
    const straight: PolylineEntity = { ...line, type: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: false, bulges: [0, 0, 0] };
    expect(count([{ kind: 'entity', entity: straight }])).toBe(18);
    expect(count([{ kind: 'entity', entity: { ...straight, bulges: [0.01, 0, 0] } }])).toBe(0);
    expectNativeRefusal(state([{ ...straight, bulges: [0.01, 0, 0] }, text]), view, 'Unsupported Canvas stroke construction: native float arc connection is unproved (line)', true);
    expect(count([{ kind: 'entity', entity: { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 1 } }])).toBe(0);
    expect(count([{ kind: 'entity', entity: { ...line, type: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 1 } }])).toBe(0);
    const overlap: Entity = { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 0.01 };
    expect(() => geometry.prepareCompiledZoom2D(state([overlap, text]), view, overlay)).toThrow('Curve stroke overlap');
  });

  it.each([1, 2, 2.5, 6])('uses actual paint width%s for a certified right-angle entity counter and packing parity', (width) => {
    const straight: PolylineEntity = { ...line, type: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: false, lineWeight: width / 4 };
    expect(count([{ kind: 'entity', entity: straight }], { ...view, scale: 1 }, { x: 5, y: 5 }, width)).toBe(18);
    const drawing = state([straight, { ...text, text: '' }]), camera = { ...view, scale: 1, lineweights: true };
    const lowered = lowerStrokeScene(drawing, camera, overlay);
    if (!lowered.ok) throw new Error(lowered.reason);
    expect(lowered.operations[0]!.widthCss).toBe(width);
    const actual = geometry.prepareCompiledZoom2D(drawing, camera, overlay), expected = legacyCompiled(drawing, camera);
    expect(new Uint8Array(actual.vertices.buffer)).toEqual(new Uint8Array(expected.vertices.buffer));
    expect(geometry.compiledStraightVertexLowerBound(lowered.operations, camera, actual.extent)).toBe(actual.vertices.length / geometry.GPU_ZOOM_VERTEX_STRIDE);
    expect(actual.vertices.length / geometry.GPU_ZOOM_VERTEX_STRIDE).toBe(18);
  });

  it.each([1, 2])('preserves original rotated paint inputs as complete Canvas with no submission at DPR%s', (dpr) => {
    const polyline: PolylineEntity = { ...line, id: 'joined', type: 'polyline', points: [{ x: -30, y: -1 }, { x: -2, y: -1 }, { x: -1, y: 0 }, { x: 2, y: 0 }], closed: false, lineWeight: 1.5 };
    const drawing = state([line, { ...text, rotation: 0.4, widthFactor: 1.2, oblique: 0.1 }, polyline, { ...line, id: 'offscreen', a: { x: 100, y: 0 }, b: { x: 101, y: 0 } }]);
    const camera = { ...view, dpr, twist: 0.2, lineweights: true };
    const ov = { selection: new Set(['text']), solidSelection: true };
    expectNativeRefusal(drawing, camera, 'Unsupported Canvas stroke construction: native context rotation is unproved', true, ov);
  });

  it.each([1, 2])('preserves legacy bytes, bounds, paint order and widths on a separately certified zero-view-twist control, DPR%s', (dpr) => {
    const polyline: PolylineEntity = { ...line, id: 'joined', type: 'polyline', points: [{ x: -30, y: -1 }, { x: -2, y: -1 }, { x: -1, y: 0 }, { x: 2, y: 0 }], closed: false, lineWeight: 1.5 };
    const drawing = state([line, { ...text, rotation: 0.4, widthFactor: 1.2, oblique: 0.1 }, polyline, { ...line, id: 'offscreen', a: { x: 100, y: 0 }, b: { x: 101, y: 0 } }]);
    const camera = { ...view, dpr, lineweights: true };
    const ov = { selection: new Set(['text']), solidSelection: true };
    const actual = geometry.prepareCompiledZoom2D(drawing, camera, ov);
    const expected = legacyCompiled(drawing, camera, ov);
    expect(new Uint8Array(actual.vertices.buffer)).toEqual(new Uint8Array(expected.vertices.buffer));
    expect(actual.batches).toEqual(expected.batches);
    expect(actual.sourceBounds).toEqual(expected.sourceBounds);
    expect(actual.extent).toEqual(expected.extent);
    const lowered = lowerStrokeScene(drawing, camera, ov);
    if (!lowered.ok) throw new Error(lowered.reason);
    expect(geometry.compiledStraightVertexLowerBound(lowered.operations, camera, actual.extent)).toBe(actual.vertices.length / geometry.GPU_ZOOM_VERTEX_STRIDE);
  });

  it('preserves the original mostly-offscreen reversal path as a native guard refusal rather than a budget refusal', () => {
    const points = Array.from({ length: 166_668 }, (_, index) => ({ x: 1000 + index % 2, y: 0 }));
    const remote: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    expect(count([path(points)], { ...view, scale: 1 })).toBe(0);
    expectNativeRefusal(state([remote, { ...text, text: '', height: 3 }]), { ...view, scale: 1 }, 'Unsupported Canvas stroke construction: near-reversal join is unproved');
  });

  it('keeps a separately certified mostly-offscreen workload despite its large straight upper bound', () => {
    const points = squareCycles(166_668, 1000), remote: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    expect(points.length * 12).toBeGreaterThan(1_000_000);
    const drawing = state([remote, { ...text, text: '', height: 3 }]), camera = { ...view, scale: 1 };
    const actual = geometry.prepareCompiledZoom2D(drawing, camera, overlay);
    expect(actual.vertices).toHaveLength(0);
    expect(actual.batches).toEqual([]);
    expect(actual.sourceBounds.min.x).toBe(1000);
    expect(actual.sourceBounds.max.x).toBe(1001);
    const lowered = lowerStrokeScene(drawing, camera, overlay);
    if (!lowered.ok) throw new Error(lowered.reason);
    expect(geometry.compiledStraightVertexLowerBound(lowered.operations, camera, actual.extent)).toBe(0);
  });

  it('keeps the full-packing vertex cap when the straight lower bound cannot detect curved excess', () => {
    const circles: Entity[] = Array.from({ length: 5000 }, (_, index) => ({ ...line, id: `circle-${index}`, type: 'circle', center: { x: 0, y: 0 }, radius: 1 }));
    const drawing = state([...circles, { ...text, text: '' }]);
    const lowered = lowerStrokeScene(drawing, view, overlay);
    if (!lowered.ok) throw new Error(lowered.reason);
    expect(geometry.compiledStraightVertexLowerBound(lowered.operations, view, { x: 400, y: 400 })).toBe(0);
    const { renderer, gl } = refusalRenderer();
    expect(renderer.render(drawing, view, overlay)).toMatchObject({ rendered: false, reason: 'Stroke geometry exceeds prototype budget', bytes: 0, uploadCalls: 0, submissionMs: 0 });
    for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('preserves the original immutable reversal input as an exact native refusal memo with no submission', () => {
    const points = Array.from({ length: 166_668 }, (_, index) => ({ x: index % 2, y: 0 }));
    const repeated: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    const drawing = sealImmutableData(state([repeated, { ...text, text: '' }]));
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const { gl, renderer } = refusalRenderer();
    const result = renderer.render(drawing, { ...view, scale: 1 }, overlay);
    expect(result).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: near-reversal join is unproved', uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
    expect(renderer.render(drawing, { ...view, scale: 1 }, overlay)).toMatchObject({ rendered: false, cacheReason: 'refusal-hit', geometryPreparationMs: 0 });
    expect(preparation).toHaveBeenCalledOnce();
    for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('preserves mutable reversal refusal retries and sees the original input repaired without reusing a refusal', () => {
    const points = Array.from({ length: 166_668 }, (_, index) => ({ x: index % 2, y: 0 }));
    const repeated: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    const drawing = state([repeated, { ...text, text: '' }]);
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const { gl, renderer } = refusalRenderer();
    expect(renderer.render(drawing, { ...view, scale: 1 }, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: near-reversal join is unproved', cacheReason: 'mutable' });
    expect(renderer.render(drawing, { ...view, scale: 1 }, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: near-reversal join is unproved', cacheReason: 'mutable' });
    expect(gl.createShader).not.toHaveBeenCalled();
    points.splice(2);
    expect(renderer.render(drawing, { ...view, scale: 1 }, overlay)).toMatchObject({ rendered: false, reason: 'WebGL2 shader allocation failed', preparedEntities: 2 });
    expect(preparation).toHaveBeenCalledTimes(3);
    expect(gl.createShader).toHaveBeenCalledOnce();
    expect(gl.bufferData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses separately certified immutable over-budget strokes before allocation/submission and limits memo reuse to that snapshot', () => {
    const points = squareCycles(100_001), repeated: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    const drawing = sealImmutableData(state([repeated, { ...text, text: '' }])), camera = { ...view, scale: 1 };
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), allocation = vi.spyOn(globalThis, 'Float32Array');
    const { renderer, gl } = refusalRenderer();
    try {
      expect(renderer.render(drawing, camera, overlay)).toMatchObject({ rendered: false, reason: 'Stroke geometry exceeds prototype budget', uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
      expect(allocation).not.toHaveBeenCalled(); allocation.mockRestore();
      expect(renderer.render(drawing, camera, overlay)).toMatchObject({ rendered: false, cacheReason: 'refusal-hit', geometryPreparationMs: 0 });
      expect(preparation).toHaveBeenCalledOnce();
      const changed = sealImmutableData({ ...drawing, entities: [...drawing.entities] });
      // A slow-budget policy may defer the new snapshot. It must not claim the
      // old snapshot's exact refusal as a certificate for this different input.
      expect(renderer.render(changed, camera, overlay).cacheReason).not.toBe('refusal-hit');
      renderer.clearRefusalCache();
      expect(renderer.render(changed, camera, overlay)).toMatchObject({ rendered: false, reason: 'Stroke geometry exceeds prototype budget', bytes: 0, uploadCalls: 0 });
      expectNoSubmission(gl);
    } finally { renderer.dispose(); }
  });

  it('retries a separately certified mutable budget refusal and admits its repaired source geometry', () => {
    const points = squareCycles(100_001), repeated: PolylineEntity = { ...line, type: 'polyline', points, closed: false };
    const drawing = state([repeated, { ...text, text: '' }]), camera = { ...view, scale: 1 };
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = refusalRenderer();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(renderer.render(drawing, camera, overlay)).toMatchObject({ rendered: false, reason: 'Stroke geometry exceeds prototype budget', cacheReason: 'mutable', bytes: 0, uploadCalls: 0 });
        expectNoSubmission(gl);
      }
      points.splice(2);
      expect(renderer.render(drawing, camera, overlay)).toMatchObject({ rendered: false, reason: 'WebGL2 shader allocation failed', preparedEntities: 2 });
      expect(preparation).toHaveBeenCalledTimes(3); expect(gl.createShader).toHaveBeenCalledOnce();
      for (const call of [gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
    } finally { renderer.dispose(); }
  });
});
