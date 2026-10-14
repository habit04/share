import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { Layer, LineEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DOverlay, Gpu2DView, PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'target', type: 'line', layer: '0', color: 'ByLayer', a: { x: -3, y: 1 }, b: { x: 3, y: 1 } };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 16, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: true };
const overlay: Gpu2DOverlay = { selection: new Set() };
const scene = (entities: readonly LineEntity[] = [line, { ...line, id: 'other', color: 1, a: { x: -4, y: -2 }, b: { x: 4, y: -2 } }], patch: Partial<DrawingState> = {}): DrawingState => sealImmutableData({ entities, layers: [layer], blocks: {}, currentLayer: '0', header: { ...DEFAULT_HEADER, linetypes: [] }, ...patch });
const shifted = (entity: LineEntity, y = 0.25): LineEntity => ({ ...entity, a: { x: entity.a.x, y: entity.a.y + y }, b: { x: entity.b.x, y: entity.b.y + y } });
const replace = (state: DrawingState, replacement: LineEntity, index = 0): DrawingState => sealImmutableData({ ...state, entities: state.entities.map((entity, i) => i === index ? replacement : entity) });
const referencePrepare = geometry.prepareZoom2D;
const renderers: Gpu2DRenderer[] = [];

// Capture the complete recovery image rather than merely counting uploads. The
// fake context asserts CPU/cache contracts; it is not a native raster benchmark.
function rendererFixture() {
  let vertices = new Float32Array(0), serial = 0;
  const handle = () => ({ serial: ++serial });
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0, OUT_OF_MEMORY: 0x505,
    FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44,
    SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89, STENCIL_TEST: 0xb90, BLEND: 0xbe2,
    COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400, FUNC_ADD: 0x8006,
    SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1, EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false), createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => 'invalid shader'),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => 'invalid link'), deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), deleteBuffer: vi.fn(),
    bufferData: vi.fn((_target: number, data: BufferSource, _usage: number) => { vertices = (data as Float32Array<ArrayBuffer>).slice(); }),
    bufferSubData: vi.fn((_target: number, byteOffset: number, data: Float32Array<ArrayBuffer>) => { vertices.set(data, byteOffset / Float32Array.BYTES_PER_ELEMENT); }),
    get vertices(): Float32Array<ArrayBuffer> { return vertices; },
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(),
    stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext), width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  const renderer = new Gpu2DRenderer(canvas);
  renderers.push(renderer);
  return { gl, canvas, renderer };
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  vi.restoreAllMocks();
});

describe('immutable direct-LINE certified zoom cache', () => {
  it.each([1, 1.25, 2, 3])('reuses the unchanged ordered mesh at .8/4 and exact per-axis pan limits, DPR %s', (dpr) => {
    const state = scene([
      line,
      { ...line, id: 'clip', a: { x: -25, y: -1 }, b: { x: 25, y: -1 }, lineWeight: 2 },
      { ...line, id: 'offscreen', a: { x: 100, y: 0 }, b: { x: 101, y: 0 } },
      { ...line, id: 'zero', a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
      { ...line, id: 'hidden', layer: 'hidden', a: { x: -1e9, y: 0 }, b: { x: 1e9, y: 0 } },
    ], { layers: [layer, { ...layer, name: 'hidden', visible: false }] });
    const appearance: Gpu2DOverlay = { selection: new Set(['target']), hover: 'clip', solidSelection: true };
    const camera = { ...view, dpr }, ordinary = referencePrepare(state, camera, appearance);
    expect(ordinary.maxRatio).toBe(1.25);
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(state, camera, appearance)).toMatchObject({ rendered: true, cacheMinRatio: 0.8, cacheMaxRatio: 4, uploadKind: 'full' });
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D, retained = gl.vertices.slice();
    expect(prepared.compound).toBeUndefined();
    expect(prepared.vertices).toEqual(ordinary.vertices); expect(prepared.vertices.byteLength).toBe(ordinary.vertices.byteLength);
    expect(prepared.batches).toEqual(ordinary.batches); expect(prepared.sourceBounds).toEqual(ordinary.sourceBounds);
    expect(prepared.entities).toEqual(ordinary.entities); expect(prepared.extent).toEqual(ordinary.extent);
    expect(prepared.padding).toBe(geometry.GPU_PAN_CACHE_BORDER / Math.max(1, dpr));
    expect(prepare.mock.calls[0]![6]).toEqual({ certifyStraightZoomIn: true });
    for (const ratio of [0.8, 1, 1.25, 1.02 ** 30, 2.5, 4]) {
      expect(renderer.render(state, { ...camera, scale: camera.scale * ratio }, appearance)).toMatchObject({ rendered: true, cacheHit: true, cacheReason: 'hit', cacheMaxRatio: 4, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_zoom' }, ratio);
    }
    // Power-of-two scales make the exact stored padding reproducible even at
    // nonbinary DPR. All four corners exercise both pan extrema together.
    for (const ratio of [2, 4]) for (const x of [-prepared.padding, prepared.padding]) for (const y of [-prepared.padding, prepared.padding]) {
      const scale = camera.scale * ratio, pose = { ...camera, scale, center: { x: -x / scale, y: y / scale } };
      expect(renderer.render(state, pose, appearance)).toMatchObject({ rendered: true, cacheHit: true, cacheMaxRatio: 4, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0 });
      expect(gl.uniform2f).toHaveBeenCalledWith({ name: 'u_pan' }, x, y);
    }
    expect(gl.vertices).toEqual(retained); expect(prepared.batches).toEqual(ordinary.batches);
    expect(prepare).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled();
  });

  it.each(['zoom-below', 'zoom-above', 'pan-left', 'pan-right', 'pan-top', 'pan-bottom'] as const)('rebuilds the complete mesh just outside the certified %s boundary', (boundary) => {
    const state = scene(), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4 });
    const pose = { ...view, center: { ...view.center } };
    if (boundary === 'zoom-below') pose.scale *= 0.8 - 1e-8;
    if (boundary === 'zoom-above') pose.scale *= 4 + 1e-8;
    const outside = (geometry.GPU_PAN_CACHE_BORDER + 1e-6) / pose.scale;
    if (boundary === 'pan-left') pose.center.x = outside;
    if (boundary === 'pan-right') pose.center.x = -outside;
    if (boundary === 'pan-top') pose.center.y = -outside;
    if (boundary === 'pan-bottom') pose.center.y = outside;
    expect(renderer.render(state, pose, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: boundary.startsWith('zoom') ? 'zoom-range' : 'pan-range', uploadKind: 'full', editHistoryEntries: 0 });
    expect(prepare).toHaveBeenCalledTimes(2); expect(gl.bufferData).toHaveBeenCalledTimes(2); expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(gl.vertices).toEqual(referencePrepare(state, pose, overlay).vertices);
  });

  it.each(['outer-only', 'all-data'] as const)('retains the ordinary mutable %s preparation contract', (kind) => {
    const sealed = scene(), state = kind === 'outer-only' ? { ...sealed } : structuredClone(sealed);
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: kind === 'outer-only' ? 1.25 : 1, uploadKind: 'full' });
    if (kind === 'outer-only') expect(prepare.mock.calls[0]).toHaveLength(3);
    else expect(prepare.mock.calls[0]!.slice(3)).toEqual([1, 1, 0]);
    expect(renderer.render(state, { ...view, scale: view.scale * 1.2 }, overlay)).toMatchObject({ rendered: true, cacheHit: kind === 'outer-only', uploadKind: kind === 'outer-only' ? 'none' : 'full' });
    expect(renderer.render(state, { ...view, scale: view.scale * 1.3 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full', editHistoryEntries: 0 });
    expect(prepare).toHaveBeenCalledTimes(kind === 'outer-only' ? 2 : 3); expect(gl.bufferSubData).not.toHaveBeenCalled();
  });

  it.each([true, false])('edits and undoes above 1.25 at the retained anchor using actual max4, lineweights %s', (lineweights) => {
    const camera = { ...view, dpr: 1.25, lineweights }, before = scene(), replacement = shifted(line), after = replace(before, replacement);
    const originalJson = JSON.stringify(before), prepare = vi.spyOn(geometry, 'prepareZoom2D'), partial = vi.spyOn(geometry, 'prepareZoomLine'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, camera, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4 });
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D, slot = prepared.entities![0]!, original = gl.vertices.slice();
    const current = { ...camera, scale: camera.scale * 2.5, center: { x: 0.5, y: -0.25 } };
    expect(renderer.render(after, current, overlay)).toMatchObject({ rendered: true, cacheReason: 'document-delta', cacheHit: false, cacheMaxRatio: 4, uploadKind: 'subrange', bytes: 168, uploadCalls: 1, preparedEntities: 1, reusedEntities: 1, editMemoHit: false });
    expect(partial).toHaveBeenCalledExactlyOnceWith(replacement, after, expect.objectContaining({ scale: camera.scale, center: camera.center, lineweights }), overlay, prepared.extent, 4);
    expect(gl.bufferSubData.mock.calls[0]![1]).toBe(slot.first * geometry.GPU_ZOOM_VERTEX_STRIDE * 4);
    const expected = referencePrepare(after, camera, overlay);
    expect(gl.vertices).toEqual(expected.vertices); expect(prepared.sourceBounds).toEqual(expected.sourceBounds); expect(prepared.batches).toEqual(expected.batches);
    expect(renderer.render(before, { ...camera, scale: camera.scale * 4 }, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4, cacheReason: 'document-delta', editMemoHit: true, preparedEntities: 0, reusedEntities: 2, uploadKind: 'subrange', bytes: 168 });
    expect(gl.vertices).toEqual(original); expect(prepared.sourceBounds).toEqual(referencePrepare(before, camera, overlay).sourceBounds);
    expect(renderer.render(after, current, overlay)).toMatchObject({ rendered: true, editMemoHit: true, preparedEntities: 0, uploadKind: 'subrange' });
    expect(renderer.render(after, { ...camera, scale: camera.scale * 4 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    expect(partial).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(JSON.stringify(before)).toBe(originalJson);
  });

  it('never patches a real 1.25-only source into a retained direct-LINE max4 mesh', () => {
    const camera = { ...view, width: 1216, height: 552, scale: 1 };
    const initial: LineEntity = { ...line, a: { x: 400, y: 0 }, b: { x: 450, y: 0 }, lineWeight: 4 };
    const replacement: LineEntity = { ...initial, b: { x: 400.075, y: 0 } };
    const before = scene([initial]), after = replace(before, replacement), prepare = vi.spyOn(geometry, 'prepareZoom2D'), partial = vi.spyOn(geometry, 'prepareZoomLine'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, camera, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4, uploadKind: 'full' });
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D;
    expect(geometry.prepareZoomLine(replacement, after, camera, overlay, prepared.extent, 1.25).vertices.length).toBeGreaterThan(0);
    let failure: unknown;
    try { geometry.prepareZoomLine(replacement, after, camera, overlay, prepared.extent, 4); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(isSourcePrecisionCertificateError(failure)).toBe(true); expect(isSourceTopologyAdmissionError(failure)).toBe(false);
    partial.mockClear();
    expect(renderer.render(after, camera, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheMaxRatio: 1.25, uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(partial).toHaveBeenCalledExactlyOnceWith(replacement, after, expect.objectContaining({ scale: 1, twist: 0 }), overlay, prepared.extent, 4);
    expect(prepare).toHaveBeenCalledTimes(2); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(gl.vertices).toEqual(referencePrepare(after, camera, overlay).vertices);
    const outside = renderer.render(after, { ...camera, scale: 4 }, overlay);
    expect(outside.cacheHit).toBe(false); expect(outside.uploadKind).not.toBe('subrange'); expect(prepare).toHaveBeenCalledTimes(3);
  });

  it.each(['remote-precision', 'float-collapse', 'rotation'] as const)('keeps the entire view unsubmitted on a real native %s source refusal', (kind) => {
    const camera = { ...view, width: 1216, height: 552, scale: kind === 'float-collapse' ? 10 : 1, twist: kind === 'rotation' ? 0.2 : 0 };
    const unsafe = kind === 'remote-precision' ? { ...line, id: 'remote', a: { x: 1e8, y: 0 }, b: { x: 1e8 + 1000, y: 0 } }
      : kind === 'float-collapse' ? { ...line, id: 'tiny', a: { x: -1e-6, y: 0 }, b: { x: 0, y: 0 }, lineWeight: 16 }
        : { ...line, id: 'rotated' };
    const state = scene([line, unsafe]), original = JSON.stringify(state), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    const reason = kind === 'remote-precision' ? 'Unsupported Canvas stroke construction: native float point, normal or miter exceeds precision budget'
      : `Unsupported Canvas stroke construction: ${kind === 'float-collapse' ? 'native float segment topology is unproved' : 'native context rotation is unproved'}`;
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, reason, cacheMinRatio: null, cacheMaxRatio: null, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    const failure = prepare.mock.results[0]!.value;
    expect(isSourcePrecisionCertificateError(failure)).toBe(kind === 'remote-precision'); expect(isSourceTopologyAdmissionError(failure)).toBe(kind !== 'remote-precision');
    for (let i = 0; i < 2; i++) expect(renderer.render(state, { ...camera, center: { ...camera.center } }, overlay)).toMatchObject({ rendered: false, reason, cacheReason: 'refusal-hit', geometryPreparationMs: 0, partialPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(prepare).toHaveBeenCalledOnce(); expect(JSON.stringify(state)).toBe(original);
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
  });

  it.each(['same-document', 'newest-document'] as const)('repairs the full image after a partial max4 upload throws: %s', (kind) => {
    const before = scene(), after = replace(before, shifted(line)), latest = replace(before, shifted(line, 0.5));
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4 });
    gl.bufferSubData.mockImplementationOnce((_target, offset, data) => {
      gl.vertices.set(data.subarray(0, data.length / 2), offset / Float32Array.BYTES_PER_ELEMENT);
      throw new Error('partially applied LINE delta');
    });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    const pose = { ...view, scale: view.scale * 2.5 };
    expect(renderer.render(after, pose, overlay)).toMatchObject({ rendered: false, reason: 'partially applied LINE delta', cacheMaxRatio: 4, uploadKind: 'subrange', bytes: 168, subrangeUploadCalls: 1 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    const state = kind === 'same-document' ? after : latest;
    expect(renderer.render(state, pose, overlay)).toMatchObject({ rendered: true, cacheHit: kind === 'same-document', cacheMaxRatio: 4, uploadKind: 'full', subrangeUploadCalls: 0, editMemoHit: false });
    const expected = referencePrepare(state, kind === 'same-document' ? view : pose, overlay);
    expect(gl.vertices).toEqual(expected.vertices); expect(gl.bufferData).toHaveBeenCalledTimes(2); expect(gl.bufferSubData).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(kind === 'same-document' ? 1 : 2);
    if (kind === 'same-document') {
      expect(renderer.render(before, { ...view, scale: view.scale * 4 }, overlay)).toMatchObject({ rendered: true, editMemoHit: true, uploadKind: 'subrange', preparedEntities: 0 });
      expect(gl.vertices).toEqual(referencePrepare(before, view, overlay).vertices);
    } else expect(renderer.render(state, pose, overlay)).toMatchObject({ rendered: true, cacheHit: true, uploadKind: 'none', editHistoryEntries: 0 });
  });

  it('rebuilds the extended source certificate after context restoration and releases it on disposal', () => {
    const before = scene(), after = replace(before, shifted(line)), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl, canvas } = rendererFixture();
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4 });
    const pose = { ...view, scale: view.scale * 2.5 };
    expect(renderer.render(after, pose, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4, uploadKind: 'subrange', editHistoryEntries: 1 });
    gl.isContextLost.mockReturnValue(true); canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(renderer.render(after, pose, overlay)).toMatchObject({ rendered: false, reason: 'WebGL2 device is lost', uploadKind: 'none', editHistoryEntries: 0 });
    gl.isContextLost.mockReturnValue(false); canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(after, pose, overlay)).toMatchObject({ rendered: true, cacheReason: 'cold', cacheHit: false, cacheMaxRatio: 4, uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(prepare).toHaveBeenCalledTimes(2); expect(gl.createBuffer).toHaveBeenCalledTimes(2); expect(gl.vertices).toEqual(referencePrepare(after, pose, overlay).vertices);
    expect(renderer.render(before, { ...pose, scale: pose.scale * 2 }, overlay)).toMatchObject({ rendered: true, cacheReason: 'document-delta', cacheMaxRatio: 4, editMemoHit: false, preparedEntities: 1, uploadKind: 'subrange' });
    renderer.dispose();
    gl.bufferData.mockClear(); gl.bufferSubData.mockClear(); gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(before, pose, overlay)).toMatchObject({ rendered: false, reason: 'WebGL2 device is disposed', uploadKind: 'none', editHistoryEntries: 0 });
    for (const method of [gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
  });
});
