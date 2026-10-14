import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import { hatchGeometry, type Entity, type HatchEntity, type Layer, type LineEntity } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DOverlay, Gpu2DView, PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import * as strokeScene from '../src/render/gpu-prototype/stroke-scene';
import { isSourcePrecisionCertificateError } from '../src/render/gpu-prototype/stroke-precision-error';

// Real canonical hatches, drawing transactions and CPU geometry; GL is an inert
// submission/owned-buffer model. These tests do not establish native raster accuracy.
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay: Gpu2DOverlay = { selection: new Set() };
const rectangle = (x: number, y: number, width: number, height: number) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const hatch = (loop = rectangle(-2, -2, 4, 4), patch: Partial<HatchEntity> = {}): HatchEntity => ({ id: 'hatch', type: 'hatch', layer: '0', color: 'ByLayer', solid: false, pattern: 'LINE', scale: 1, angle: 0, loops: [loop], patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [] }], ...patch });
const line = (id: string, a: number, b: number, y = -0.01): LineEntity => ({ id, type: 'line', layer: '0', color: 'ByLayer', a: { x: a, y }, b: { x: b, y } });
const scene = (items: readonly Entity[], layers: readonly Layer[] = [layer]): DrawingState => sealImmutableData({ entities: items, layers, blocks: {}, currentLayer: '0', header: { ...DEFAULT_HEADER, linetypes: [] } });
const referencePrepare = geometry.prepareZoom2D;
const certified = (state: DrawingState, camera: Gpu2DView) => geometry.prepareZoom2D(state, camera, overlay, undefined, undefined, undefined, { certifyStraightZoomIn: true });
function slot(prepared: PreparedZoom2D, index: number) { const owner = prepared.entities?.[index]; if (!owner) throw new Error('Missing original-index owner certificate'); return owner; }

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
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(), stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext), width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}
afterEach(() => vi.restoreAllMocks());

function boundaryCase(kind: 'empty' | 'offscreen') {
  if (kind === 'empty') return { source: hatch(rectangle(10_000_000, 0.25, 1, 0.1)), camera: { ...view, scale: 3000 }, left: line('left', -0.03, -0.01), right: line('right', 0.01, 0.03) };
  return { source: hatch(rectangle(200, 0.25, 2, 2)), camera: view, left: line('left', -2, -1), right: line('right', 1, 2) };
}

describe('GPU nonpainted hatch source bounds and owner reuse', () => {
  it('keeps a real empty-phase boundary in the ordinary range when its 4x source projection is unsafe', () => {
    const { source, camera, left, right } = boundaryCase('empty');
    expect(hatchGeometry(source).segments).toHaveLength(0);
    const state = scene([left, source, right]);
    const ordinary = referencePrepare(state, camera, overlay), prepared = certified(state, camera);
    expect(prepared.compound).toBeDefined(); expect(prepared.maxRatio).toBe(1.25);
    expect(prepared.vertices).toEqual(ordinary.vertices); expect(prepared.batches).toEqual(ordinary.batches);
    expect(prepared.batches.map(batch => batch.id)).toEqual(['left:0', 'right:2']);
    expect(slot(prepared, 1)).toMatchObject({ entity: source, editableLine: false, first: 6, count: 0 });
    expect(slot(prepared, 1).sourceBounds).toEqual({ min: { x: 30_000_000_000, y: -1050 }, max: { x: 30_000_003_000, y: -750 } });
    expect(prepared.sourceBounds.max.x).toBe(30_000_003_000);
    expect(geometry.zoomPrecisionSafe(prepared, camera, 1.25, { x: 0, y: 0 })).toBe(true);
    expect(geometry.zoomPrecisionSafe(prepared, camera, 4, { x: 0, y: 0 })).toBe(false);
  });

  it('retains all original bounds when real painted hatch segments are discarded by clipping', () => {
    const { source, camera, left, right } = boundaryCase('offscreen');
    expect(hatchGeometry(source).segments.length).toBeGreaterThan(0);
    const prepared = certified(scene([left, source, right]), camera);
    expect(slot(prepared, 1)).toMatchObject({ entity: source, editableLine: false, first: 6, count: 0 });
    expect(slot(prepared, 1).sourceBounds).toEqual({ min: { x: 6000, y: -67.5 }, max: { x: 6060, y: -7.5 } });
    expect(prepared.sourceBounds.max.x).toBe(6060);
    expect(prepared.vertices.length / geometry.GPU_ZOOM_VERTEX_STRIDE).toBe(12);
    expect(prepared.batches.map(batch => batch.id)).toEqual(['left:0', 'right:2']);
  });

  it.each(['empty', 'offscreen'] as const)('retains %s hatch owner/global bounds through actual LINE edit, undo, redo and warm reuse', (kind) => {
    const { source, camera, left, right } = boundaryCase(kind);
    const doc = new Drawing(scene([left, source, right])), before = doc.snapshot;
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), prepareLine = vi.spyOn(geometry, 'prepareZoomLine');
    const { renderer, gl } = rendererFixture();
    try {
      expect(renderer.render(before, camera, overlay)).toMatchObject({ rendered: true, uploadKind: 'full' });
      const prepared = preparation.mock.results[0]!.value as PreparedZoom2D;
      const originalVertices = gl.vertices.slice(), hatchBounds = structuredClone(slot(prepared, 1).sourceBounds), batches = structuredClone(prepared.batches);
      expect(slot(prepared, 0)).toMatchObject({ editableLine: true, count: 6 });
      expect(slot(prepared, 1)).toMatchObject({ editableLine: false, count: 0 });
      const warm = { ...camera, scale: camera.scale * 1.05, center: { x: -5 / (camera.scale * 1.05), y: 0 } };
      expect(renderer.render(before, warm, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      const target = doc.entities[0] as LineEntity;
      doc.replaceEntities([{ ...target, a: { ...target.a, y: target.a.y + 9 / camera.scale }, b: { ...target.b, y: target.b.y + 9 / camera.scale } }]);
      const after = doc.snapshot;
      for (const action of ['edit', 'undo', 'redo'] as const) {
        if (action === 'undo') { expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before); }
        if (action === 'redo') { expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after); }
        const frame = renderer.render(doc.snapshot, warm, overlay);
        expect(frame).toMatchObject({ rendered: true, cacheReason: 'document-delta', uploadKind: 'subrange', bytes: 168, uploadCalls: 1, subrangeUploadBytes: 168, subrangeUploadCalls: 1, editMemoHit: action !== 'edit' });
        expect(slot(prepared, 1).sourceBounds).toEqual(hatchBounds); expect(prepared.sourceBounds.max.x).toBe(hatchBounds!.max.x);
        expect(prepared.batches).toEqual(batches);
        const fresh = referencePrepare(doc.snapshot, camera, overlay);
        expect(gl.vertices).toEqual(fresh.vertices); expect(prepared.sourceBounds).toEqual(fresh.sourceBounds);
        if (action === 'undo') expect(gl.vertices).toEqual(originalVertices);
        expect(doc.dirty).toBe(true);
      }
      expect(preparation).toHaveBeenCalledOnce(); expect(prepareLine).toHaveBeenCalledOnce();
      expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).toHaveBeenCalledTimes(3);
      expect(renderer.render(after, warm, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0 });
    } finally { renderer.dispose(); }
  });

  it.each(['pattern', 'layer-style'] as const)('fully rebuilds a real %s edit and undo beside the retained LINE owners', (kind) => {
    const doc = new Drawing(scene([line('left', -3, -2.5), hatch(), line('right', 2.5, 3)]));
    const before = doc.snapshot, { renderer, gl } = rendererFixture();
    try {
      expect(renderer.render(before, view, overlay).rendered).toBe(true);
      const original = gl.vertices.slice();
      if (kind === 'pattern') { const source = doc.entities[1] as HatchEntity; doc.replaceEntities([{ ...source, patternLines: source.patternLines!.map(family => ({ ...family, base: { ...family.base, y: family.base.y + 0.25 } })) }]); }
      else doc.updateLayer('0', { color: 1 });
      expect(renderer.render(doc.snapshot, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'document', uploadKind: 'full', subrangeUploadCalls: 0, editMemoHit: false });
      expect(gl.vertices).not.toEqual(original); expect(gl.vertices).toEqual(referencePrepare(doc.snapshot, view, overlay).vertices);
      expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
      expect(renderer.render(doc.snapshot, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'document', uploadKind: 'full', subrangeUploadCalls: 0 });
      expect(gl.vertices).toEqual(original); expect(gl.bufferSubData).not.toHaveBeenCalled();
    } finally { renderer.dispose(); }
  });

  it('keeps hidden unsupported hatches out of compiled admission and ordinary LINE geometry', () => {
    const hidden = hatch(undefined, { layer: 'OFF', solid: true });
    const state = scene([line('left', -2, -1), hidden, line('right', 1, 2)], [layer, { ...layer, name: 'OFF', visible: false }]);
    const generator = vi.spyOn(entities, 'hatchGeometry'), { renderer, gl } = rendererFixture();
    try {
      const prepared = certified(state, view);
      expect(prepared.compound).toBeUndefined(); expect(generator).not.toHaveBeenCalled();
      expect(renderer.render(state, view, overlay).rendered).toBe(true);
      const visibleOnly = scene([state.entities[0]!, state.entities[2]!], state.layers);
      expect(gl.vertices).toEqual(referencePrepare(visibleOnly, view, overlay).vertices); expect(generator).not.toHaveBeenCalled();
    } finally { renderer.dispose(); }
  });

  it('retries a genuine hatch source precision certificate with the ordinary interval and unchanged padding', () => {
    const source = hatch(rectangle(10_000_000, 0.25, 1, 0.1));
    const camera = { ...view, scale: 40_000, center: { x: 10_000_000, y: 0 } };
    const state = scene([line('left', 10_000_000 - 0.001, 10_000_000 + 0.001, 0), source]);
    expect(hatchGeometry(source).segments).toHaveLength(0);
    const ordinary = referencePrepare(state, camera, overlay), lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    const prepared = certified(state, camera);
    expect(lower.mock.calls.map(call => call[3]?.maxRatio)).toEqual([4, 1.25]);
    expect(lower.mock.calls.map(call => call[3]?.panPadding)).toEqual([128, 128]);
    const initial = lower.mock.results[0]!.value as ReturnType<typeof strokeScene.lowerStrokeScene>;
    expect(initial).toMatchObject({ ok: false, reason: 'Canvas hatch projection exceeds precision bound' });
    if (initial.ok) throw new Error('Expected genuine stronger source failure');
    expect(isSourcePrecisionCertificateError(initial.cause)).toBe(true);
    expect(prepared.maxRatio).toBe(1.25); expect(prepared.vertices).toEqual(ordinary.vertices); expect(prepared.sourceBounds).toEqual(ordinary.sourceBounds);
  });

  it.each([Error, TypeError, RangeError])('does not retry a native %s with the exact deliberate hatch precision wording', (FailureType) => {
    const error = new FailureType('Canvas hatch projection exceeds precision bound');
    const generator = vi.spyOn(entities, 'hatchGeometry').mockImplementation(() => { throw error; });
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    const state = scene([hatch()]);
    let failure: unknown;
    try { certified(state, view); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(Error); expect(lower).toHaveBeenCalledOnce(); expect(generator).toHaveBeenCalledOnce();
    expect((failure as Error).cause).toBeInstanceOf(Error); expect(((failure as Error).cause as Error).cause).toBe(error);
    expect(isSourcePrecisionCertificateError(error)).toBe(false);
  });

  it('keeps unsupported hatch view twist on complete Canvas without overwriting a healthy retained buffer', () => {
    const state = scene([hatch()]), { renderer, gl } = rendererFixture();
    try {
      expect(renderer.render(state, view, overlay).rendered).toBe(true);
      const before = gl.vertices.slice(); gl.bufferData.mockClear(); gl.bufferSubData.mockClear(); gl.clear.mockClear(); gl.drawArrays.mockClear();
      expect(renderer.render(state, { ...view, twist: 0.43 }, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved', uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
      expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.vertices).toEqual(before);
      expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, uploadKind: 'none', bytes: 0 });
    } finally { renderer.dispose(); }
  });
});
