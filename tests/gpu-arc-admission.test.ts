import { describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { ArcEntity, BlockDef, Entity, InsertEntity, Layer, LineEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { drawEntity } from '../src/render/draw';
import { canvasArcAdmission } from '../src/render/gpu-prototype/arc-admission';
import { GPU_ZOOM_VERTEX_STRIDE, prepare2D, prepareZoom2D, screenPoint, type Gpu2DView, type PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import { isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const TAU = Math.PI * 2;
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const overlay = { selection: new Set<string>() };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const arc = (patch: Partial<ArcEntity> = {}): ArcEntity => ({ id: 'arc', type: 'arc', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2, ...patch });
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 3, a: { x: -2, y: -2 }, b: { x: 2, y: -2 } };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => ({ entities, blocks, layers: [layer], currentLayer: '0' });

/** Trace the real Canvas entity wrapper's arc call, including its explicit full-circle branch. */
function canvasArcs(entity: Entity, state = drawing([entity]), camera = view) {
  const calls: Array<{ center: Point; radius: number; start: number; end: number; anticlockwise: boolean }> = [];
  let angle = 0;
  const stack: number[] = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push(angle); }, restore() { angle = stack.pop()!; }, rotate(value: number) { angle += value; }, setLineDash() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc(x: number, y: number, radius: number, start: number, end: number, anticlockwise = false) {
      calls.push({ center: { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) }, radius, start, end, anticlockwise });
    },
  };
  drawEntity(context as unknown as CanvasRenderingContext2D, entity, { scale: camera.scale, rotation: camera.twist, toScreen: (point) => screenPoint(point, camera) }, state.layers, (name) => state.blocks[name]);
  return calls;
}

/** Independently reconstruct packed shader coordinates and test the triangle union. */
function covers(geometry: PreparedZoom2D, point: Point, camera: Gpu2DView, ratio = 1, pan: Point = { x: 0, y: 0 }): boolean {
  const vertex = (index: number): Point => {
    const offset = index * GPU_ZOOM_VERTEX_STRIDE;
    return {
      x: Math.fround(Math.fround(Math.fround(Math.fround(geometry.vertices[offset]! * Math.fround(ratio)) + Math.fround(pan.x)) + Math.fround(camera.width / 2)) + geometry.vertices[offset + 2]!),
      y: Math.fround(Math.fround(Math.fround(Math.fround(geometry.vertices[offset + 1]! * Math.fround(ratio)) + Math.fround(pan.y)) + Math.fround(camera.height / 2)) + geometry.vertices[offset + 3]!),
    };
  };
  const cross = (a: Point, b: Point): number => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  for (let index = 0; index < geometry.vertices.length / GPU_ZOOM_VERTEX_STRIDE; index += 3) {
    const a = vertex(index), b = vertex(index + 1), c = vertex(index + 2);
    if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-8) continue;
    const signs = [cross(a, b), cross(b, c), cross(c, a)];
    if (signs.every((value) => value >= -1e-5) || signs.every((value) => value <= 1e-5)) return true;
  }
  return false;
}

function rendererFixture() {
  let serial = 0, vertices = new Float32Array(0);
  const handle = () => ({ serial: ++serial });
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0, FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4,
    DEPTH_TEST: 0xb71, CULL_FACE: 0xb44, SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89,
    STENCIL_TEST: 0xb90, BLEND: 0xbe2, COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400,
    FUNC_ADD: 0x8006, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1, EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false), createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => ''), createProgram: vi.fn(handle),
    attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => ''), deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), deleteBuffer: vi.fn(),
    bufferData: vi.fn((_target: number, data: BufferSource) => { vertices = (data as Float32Array<ArrayBuffer>).slice(); }),
    bufferSubData: vi.fn((_target: number, offset: number, data: Float32Array<ArrayBuffer>) => { vertices.set(data, offset / 4); }),
    get vertices(): Float32Array<ArrayBuffer> { return vertices; },
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null), getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })), bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(),
    stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(), blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: vi.fn(() => gl) }) as unknown as HTMLCanvasElement;
  return { gl, canvas, renderer: new Gpu2DRenderer(canvas) };
}

describe('GPU ARC admission matches the actual Canvas painter', () => {
  it.each([0, Math.PI, 1e20, -1e20, Number.MAX_VALUE])('canonicalizes a zero raw sweep at start %s exactly like Canvas', (start) => {
    const entity = arc({ startAngle: start, endAngle: start });
    expect(canvasArcs(entity)[0]).toMatchObject({ start: 0, end: TAU, anticlockwise: false });
    expect(canvasArcAdmission(entity)).toEqual({ ok: true, startAngle: 0, sweep: TAU, fullCircle: true });
    expect(prepare2D(drawing([entity]), view, overlay).vertices).toEqual(prepare2D(drawing([arc({ endAngle: 0 })]), view, overlay).vertices);
    expect(prepareZoom2D(drawing([entity]), view, overlay).vertices).toEqual(prepareZoom2D(drawing([arc({ endAngle: 0 })]), view, overlay).vertices);
  });

  it.each([TAU, -TAU, TAU * 2, -TAU * 2, 1e-10])('preserves Canvas full-circle shortcut for raw sweep %s', (sweep) => {
    const entity = arc({ startAngle: 0, endAngle: sweep });
    expect(canvasArcs(entity)[0]).toMatchObject({ start: 0, end: TAU, anticlockwise: false });
    expect(canvasArcAdmission(entity)).toEqual({ ok: true, startAngle: 0, sweep: TAU, fullCircle: true });
    expect(prepareZoom2D(drawing([entity]), view, overlay).vertices).toEqual(prepareZoom2D(drawing([arc({ endAngle: 0 })]), view, overlay).vertices);
  });

  it.each([[0, Math.PI / 2], [Math.PI * 1.5, Math.PI / 2], [0, -Math.PI / 2], [-Math.PI / 2, 0], [0, -Math.PI * 2.5], [Math.PI * 1.5, Math.PI * 2.5], [TAU * 2 - 0.5, TAU * 2]])('admits ordinary normalized/wrapped ARC angles %s..%s', (start, end) => {
    const entity = arc({ startAngle: start, endAngle: end });
    const native = canvasArcs(entity)[0]!;
    expect(native).toMatchObject({ start: -start, end: -end, anticlockwise: true });
    const admitted = canvasArcAdmission(entity);
    if (!admitted.ok) throw new Error(admitted.reason);
    expect(admitted.fullCircle).toBe(false);
    const geometry = prepareZoom2D(drawing([entity]), view, overlay);
    for (let index = 1; index < 16; index++) {
      const angle = start + admitted.sweep * index / 16;
      expect(covers(geometry, screenPoint({ x: Math.cos(angle) * entity.radius, y: Math.sin(angle) * entity.radius }, view), view)).toBe(true);
    }
  });

  it('keeps the major negative wrapped ARC rather than turning it into a quarter circle', () => {
    const entity = arc({ endAngle: -Math.PI / 2 });
    const geometry = prepareZoom2D(drawing([entity]), view, overlay);
    for (const angle of [Math.PI / 2, Math.PI, Math.PI * 1.4]) expect(covers(geometry, screenPoint({ x: Math.cos(angle) * entity.radius, y: Math.sin(angle) * entity.radius }, view), view)).toBe(true);
    expect(covers(geometry, screenPoint({ x: Math.cos(Math.PI * 1.8) * entity.radius, y: Math.sin(Math.PI * 1.8) * entity.radius }, view), view)).toBe(false);
  });

  it.each([Math.PI * 2.5, Math.PI * 3, TAU + 1e-6])('refuses Canvas-clamped raw positive sweep %s instead of drawing its modulo arc', (end) => {
    const entity = arc({ endAngle: end });
    expect(canvasArcs(entity)[0]).toMatchObject({ start: -0, end: -end, anticlockwise: true });
    expect(canvasArcAdmission(entity)).toEqual({ ok: false, reason: 'Unsupported Canvas ARC sweep beyond one revolution' });
    expect(() => prepare2D(drawing([line, entity]), view, overlay)).toThrow(/beyond one revolution/);
    expect(() => prepareZoom2D(drawing([line, entity]), view, overlay)).toThrow(/beyond one revolution/);
  });

  it.each([1e12, -1e12, 1e16, TAU * 2 + 1])('refuses unsupported nonfull angle normalization/step precision at start %s', (start) => {
    const entity = arc({ startAngle: start, endAngle: start + 2 });
    expect(canvasArcAdmission(entity)).toEqual({ ok: false, reason: 'Unsupported Canvas ARC angular precision range' });
    expect(() => prepareZoom2D(drawing([entity]), view, overlay)).toThrow(/angular precision range/);
  });

  it.each([{ startAngle: NaN }, { endAngle: Infinity }, { startAngle: -Number.MAX_VALUE, endAngle: Number.MAX_VALUE }])('refuses invalid/overflowing ARC inputs %j', (patch) => {
    expect(canvasArcAdmission(arc(patch)).ok).toBe(false);
    expect(() => prepareZoom2D(drawing([arc(patch)]), view, overlay)).toThrow(/Invalid ARC/);
  });

  it.each([1, 2, 3])('preserves the original rotated huge full-circle poses as complete Canvas with no GL work at DPR %s', (dpr) => {
    const entity = arc({ startAngle: 1e20, endAngle: 1e20, lineWeight: 0.5 });
    const state = sealImmutableData(drawing([entity])), before = JSON.stringify(state);
    const camera = { ...view, dpr, twist: 0.43, lineweights: true }, beforeCamera = JSON.stringify(camera);
    const reason = 'Unsupported Canvas stroke construction: native context rotation is unproved';
    let failure: unknown;
    try { prepareZoom2D(state, camera, overlay); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe(reason);
    expect(isSourceTopologyAdmissionError(failure)).toBe(true);
    expect(() => prepare2D(state, camera, overlay)).toThrow(reason);
    const { gl, renderer } = rendererFixture();
    try {
      expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, reason, cacheHit: false, bytes: 0, uploadCalls: 0, submissionMs: 0 });
      expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, reason, cacheReason: 'refusal-hit', geometryPreparationMs: 0, bytes: 0, uploadCalls: 0 });
      for (const ratio of [0.8, 1, 1.25]) {
        const pan = { x: 30 / dpr, y: -25 / dpr }, scale = camera.scale * ratio, c = Math.cos(camera.twist), s = Math.sin(camera.twist);
        const current = { ...camera, scale, center: { x: (-c * pan.x + s * pan.y) / scale, y: (s * pan.x + c * pan.y) / scale } };
        const poseBefore = JSON.stringify(current);
        expect(canvasArcs(entity, state, current)).toEqual([expect.objectContaining({ radius: 2 * scale, start: 0, end: TAU, anticlockwise: false })]);
        expect(renderer.render(state, current, overlay)).toMatchObject({ rendered: false, reason, cacheHit: false, bytes: 0, uploadCalls: 0, submissionMs: 0 });
        expect(JSON.stringify(current)).toBe(poseBefore);
      }
      for (const method of [gl.createShader, gl.createProgram, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
      expect(JSON.stringify(state)).toBe(before); expect(JSON.stringify(camera)).toBe(beforeCamera);
    } finally { renderer.dispose(); }
  });

  it.each([1, 2, 3])('retains huge full-circle coverage/lineweights on a separately certified zero-twist cache control, DPR %s', (dpr) => {
    const entity = arc({ startAngle: 1e20, endAngle: 1e20, lineWeight: 0.5 });
    const state = sealImmutableData(drawing([entity])), before = JSON.stringify(state);
    const camera = { ...view, dpr, lineweights: true };
    const prepared = prepareZoom2D(state, camera, overlay);
    expect(canvasArcAdmission(entity)).toEqual({ ok: true, startAngle: 0, sweep: TAU, fullCircle: true });
    expect(canvasArcs(entity, state, camera)).toEqual([expect.objectContaining({ start: 0, end: TAU, anticlockwise: false })]);
    const { gl, renderer } = rendererFixture();
    expect(renderer.render(state, camera, overlay).rendered).toBe(true);
    for (const ratio of [0.8, 1, 1.25]) {
      const pan = { x: 30 / dpr, y: -25 / dpr }, scale = camera.scale * ratio, c = Math.cos(camera.twist), s = Math.sin(camera.twist);
      const current = { ...camera, scale, center: { x: (-c * pan.x + s * pan.y) / scale, y: (s * pan.x + c * pan.y) / scale } };
      expect(renderer.render(state, current, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, bytes: 0, uploadCalls: 0 });
      for (let index = 1; index < 24; index++) {
        const angle = index * TAU / 24, world = (radius: number): Point => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
        expect(covers(prepared, screenPoint(world(2), current), camera, ratio, pan)).toBe(true);
        expect(covers(prepared, screenPoint(world(2 + 0.5 / scale), current), camera, ratio, pan)).toBe(true);
        expect(covers(prepared, screenPoint(world(2 - 0.5 / scale), current), camera, ratio, pan)).toBe(true);
        expect(covers(prepared, screenPoint(world(2 - 4 / scale), current), camera, ratio, pan)).toBe(false);
        expect(covers(prepared, screenPoint(world(2 + 4 / scale), current), camera, ratio, pan)).toBe(false);
      }
    }
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(JSON.stringify(state)).toBe(before);
    renderer.dispose();
  });

  it.each(['sweep', 'angle'] as const)('refuses a late %s ARC before any GL allocation/upload/clear/draw', (kind) => {
    const unsafe = kind === 'sweep' ? arc({ endAngle: Math.PI * 2.5 }) : arc({ startAngle: 1e12, endAngle: 1e12 + 2 });
    const { gl, renderer } = rendererFixture();
    expect(renderer.render(drawing([line, unsafe]), view, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, submissionMs: 0 });
    for (const method of [gl.createShader, gl.createProgram, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('uses the same whole-scene refusal for a late nested ARC and canonicalizes huge full arcs inside blocks', () => {
    const owner: InsertEntity = { id: 'owner', type: 'insert', layer: '0', color: 3, block: 'ROOT', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} };
    const nested = { ...owner, id: 'nested', block: 'LEAF' };
    const root: BlockDef = { name: 'ROOT', basePoint: { x: 0, y: 0 }, entities: [line, nested], attributes: [] };
    const leaf = (entity: ArcEntity): BlockDef => ({ name: 'LEAF', basePoint: { x: 0, y: 0 }, entities: [entity], attributes: [] });
    const unsafe = drawing([line, owner], { ROOT: root, LEAF: leaf(arc({ endAngle: Math.PI * 2.5 })) });
    expect(lowerStrokeScene(unsafe, view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('beyond one revolution') });
    const { gl, renderer } = rendererFixture();
    expect(renderer.render(unsafe, view, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0 });
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    const huge = drawing([owner], { ROOT: root, LEAF: leaf(arc({ startAngle: 1e20, endAngle: 1e20 })) });
    const canonical = drawing([owner], { ROOT: root, LEAF: leaf(arc({ endAngle: 0 })) });
    expect(prepareZoom2D(huge, view, overlay).vertices).toEqual(prepareZoom2D(canonical, view, overlay).vertices);
    renderer.dispose();
  });

  it('keeps the resident good frame unchanged after an unsafe edit and reuses it on undo', () => {
    const before = sealImmutableData(drawing([line, arc({ startAngle: 1e20, endAngle: 1e20 })]));
    const unsafe = sealImmutableData({ ...before, entities: [before.entities[0]!, arc({ endAngle: Math.PI * 2.5 })] });
    const { gl, renderer } = rendererFixture();
    expect(renderer.render(before, view, overlay).rendered).toBe(true);
    const image = gl.vertices.slice();
    gl.bufferData.mockClear(); gl.bufferSubData.mockClear(); gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(unsafe, view, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0 });
    expect(gl.vertices).toEqual(image);
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    renderer.dispose();
  });

  it.each([TypeError, RangeError])('preserves original %s provenance through compound failure without exposing it in public JSON or touching GL', (Failure) => {
    const original = new Failure('Unsupported Canvas ARC sweep beyond one revolution');
    const definition: BlockDef = { name: 'B', entities: [arc()], attributes: [], get basePoint(): Point { throw original; } };
    const owner: InsertEntity = { id: 'owner', type: 'insert', layer: '0', color: 3, block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} };
    const state = drawing([line, owner], { B: definition });
    const failure = lowerStrokeScene(state, view, overlay);
    expect(failure).toEqual({ ok: false, reason: original.message });
    if (failure.ok) throw new Error('Expected refusal');
    expect(failure.cause).toBe(original);
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
    expect(JSON.parse(JSON.stringify(failure))).toEqual({ ok: false, reason: original.message });
    let wrapped: unknown;
    try { prepareZoom2D(state, view, overlay); } catch (error) { wrapped = error; }
    expect(Object.getPrototypeOf(wrapped)).toBe(Error.prototype);
    expect((wrapped as Error).cause).toBe(original);
    const { gl, renderer } = rendererFixture();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: original.message, bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createProgram, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('keeps explicit ordinary validation Error provenance available for admission classification', () => {
    const failure = lowerStrokeScene(drawing([arc({ endAngle: Math.PI * 2.5 })]), view, overlay);
    expect(failure).toEqual({ ok: false, reason: expect.stringContaining('beyond one revolution') });
    if (failure.ok) throw new Error('Expected refusal');
    expect(Object.getPrototypeOf(failure.cause)).toBe(Error.prototype);
    expect((failure.cause as Error).message).toBe(failure.reason);
    expect(Object.keys(failure)).toEqual(['ok', 'reason']);
  });
});
