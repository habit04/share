import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import * as hershey from '../src/render/hershey';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DOverlay, Gpu2DView, PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { GPU_EDIT_HISTORY_BYTES, GPU_EDIT_HISTORY_ENTRIES, Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'target', type: 'line', layer: '0', color: 'ByLayer', a: { x: -3, y: 1 }, b: { x: 3, y: 1 } };
const text = (id: string, patch: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 1, position: { x: -2, y: 1 }, text: 'A', height: 0.8, rotation: 0, align: 'left', ...patch });
const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [{ ...line, id: 'child', a: { x: -0.5, y: 0 }, b: { x: 0.5, y: 0 } }, text('child-text', { position: { x: 0, y: 0.3 }, height: 0.6, text: 'B' })], attributes: [{ tag: 'TAG', prompt: '', default: 'C', position: { x: 0, y: -0.5 }, height: 0.6, align: 'left' }] };
const owner: InsertEntity = { id: 'owner', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 1, y: 1 }, scale: 1, rotation: 0, attributes: { TAG: 'Z' } };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: true };
const overlay: Gpu2DOverlay = { selection: new Set() };
const scene = (target: LineEntity = line, patch: Partial<DrawingState> = {}): DrawingState => sealImmutableData({ entities: [text('before'), target, owner, text('after', { position: { x: -1, y: 0 }, text: 'D' })], layers: [layer], blocks: { B: block }, currentLayer: '0', header: { ...DEFAULT_HEADER, linetypes: [] }, meta: { textStyles: { Standard: STANDARD_TEXT_STYLE } }, ...patch });
const replace = (state: DrawingState, target: Entity, index = 1): DrawingState => sealImmutableData({ ...state, entities: state.entities.map((entity, i) => i === index ? target : entity) });
const shifted = (source: LineEntity, y = 0.25): LineEntity => ({ ...source, a: { x: source.a.x, y: source.a.y + y }, b: { x: source.b.x, y: source.b.y + y } });
const referencePrepare = geometry.prepareZoom2D;

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
  return { gl, canvas, renderer: new Gpu2DRenderer(canvas) };
}

function patchSlot(geometry: PreparedZoom2D, index = 1) {
  const slot = geometry.entities?.[index];
  if (!slot) throw new Error('Missing original-index owner certificate');
  return slot;
}

afterEach(() => vi.restoreAllMocks());

describe('compiled source-owner LINE subrange edits', () => {
  it.each(['normal', 'selected', 'hovered'] as const)('patches only the nonzero LINE slot between unchanged ordered TEXT/INSERT paints: %s', (appearance) => {
    const selected: Gpu2DOverlay = appearance === 'selected' ? { selection: new Set(['before', 'target']), hover: 'owner', solidSelection: true } : appearance === 'hovered' ? { selection: new Set(), hover: 'target' } : overlay;
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), prepareLine = vi.spyOn(geometry, 'prepareZoomLine'), glyph = vi.spyOn(hershey, 'glyphFor');
    const before = scene(), originalJson = JSON.stringify(before), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, view, selected).rendered).toBe(true);
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D, slot = patchSlot(prepared), original = gl.vertices.slice();
    const batches = structuredClone(prepared.batches), bounds = prepared.entities!.map((entry) => entry && structuredClone(entry.sourceBounds));
    const leafCount = prepared.entityCount, glyphCalls = glyph.mock.calls.length;
    expect(slot).toMatchObject({ entity: before.entities[1], editableLine: true, count: 6 });
    expect(slot.first).toBeGreaterThan(0); expect(leafCount).toBeGreaterThan(before.entities.length);
    expect(prepared.entities!.filter((entry) => entry?.editableLine).map((entry) => entry!.entity.id)).toEqual(['target']);
    const after = replace(before, shifted(line));
    const edited = renderer.render(after, view, selected);
    expect(edited).toMatchObject({ rendered: true, cacheReason: 'document-delta', cacheHit: false, uploadKind: 'subrange', bytes: 168, uploadCalls: 1, subrangeUploadCalls: 1, subrangeUploadBytes: 168, preparedEntities: 1, reusedEntities: leafCount - 1, editMemoHit: false });
    expect(prepare).toHaveBeenCalledOnce(); expect(prepareLine).toHaveBeenCalledOnce(); expect(glyph).toHaveBeenCalledTimes(glyphCalls);
    expect(gl.bufferSubData.mock.calls[0]![1]).toBe(slot.first * geometry.GPU_ZOOM_VERTEX_STRIDE * 4);
    const start = slot.first * geometry.GPU_ZOOM_VERTEX_STRIDE, end = start + slot.count * geometry.GPU_ZOOM_VERTEX_STRIDE;
    expect(gl.vertices.slice(0, start)).toEqual(original.slice(0, start)); expect(gl.vertices.slice(end)).toEqual(original.slice(end));
    expect(prepared.batches).toEqual(batches);
    prepared.entities!.forEach((entry, i) => { if (i !== 1) expect(entry?.sourceBounds).toEqual(bounds[i]); });
    const fresh = referencePrepare(after, view, selected);
    expect(gl.vertices).toEqual(fresh.vertices); expect(prepared.sourceBounds).toEqual(fresh.sourceBounds); expect(prepared.batches).toEqual(fresh.batches);
    expect(JSON.stringify(before)).toBe(originalJson);
    expect(renderer.render(before, view, selected)).toMatchObject({ rendered: true, cacheReason: 'document-delta', editMemoHit: true, preparedEntities: 0, reusedEntities: leafCount, uploadKind: 'subrange', bytes: 168 });
    expect(gl.vertices).toEqual(original);
    expect(renderer.render(after, view, selected)).toMatchObject({ rendered: true, editMemoHit: true, preparedEntities: 0, reusedEntities: leafCount, uploadKind: 'subrange', bytes: 168 });
    expect(renderer.render(after, view, selected)).toMatchObject({ rendered: true, cacheHit: true, preparedEntities: 0, reusedEntities: leafCount, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0 });
    expect(prepareLine).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it('refuses the original Float32-collapsed remote TEXT before any LINE delta or GL submission', () => {
    const bound = 2 ** 36, unitView = { ...view, scale: 1, lineweights: false };
    const farText = text('far-text', { position: { x: bound - view.width / 2 - 10, y: 0 }, height: 1 });
    const before = scene(line, { entities: [farText, line, owner] }), after = replace(before, shifted(line));
    const x = unitView.width / 2 + farText.position.x;
    expect(Math.fround(x)).toBe(Math.fround(x + 0.8));
    const { renderer, gl } = rendererFixture();
    for (const state of [before, after]) for (const scale of [1, 1.1]) expect(renderer.render(state, { ...unitView, scale }, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native float segment topology is unproved', uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('preserves safely certified offscreen TEXT bounds after a visible LINE delta and rejects an unsafe fresh zoom', () => {
    const unitView = { ...view, scale: 1, lineweights: false };
    const farText = text('far-text', { position: { x: 65536, y: 0 }, height: 1 });
    const before = scene(line, { entities: [farText, line, owner] }), after = replace(before, shifted(line));
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, unitView, overlay).rendered).toBe(true);
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D, originalFar = structuredClone(patchSlot(prepared, 0).sourceBounds);
    expect(patchSlot(prepared, 0)).toMatchObject({ editableLine: false, count: 0 });
    expect(originalFar!.max.x).toBeGreaterThan(65536);
    expect(renderer.render(after, unitView, overlay)).toMatchObject({ rendered: true, uploadKind: 'subrange', preparedEntities: 1 });
    expect(patchSlot(prepared, 0).sourceBounds).toEqual(originalFar);
    expect(prepared.sourceBounds.max.x).toBe(originalFar!.max.x);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(after, { ...unitView, scale: 4.1 }, overlay)).toMatchObject({ rendered: false, uploadKind: 'none', bytes: 0, uploadCalls: 0, reason: 'Unsupported Canvas stroke construction: native float point, normal or miter exceeds precision budget' });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['degenerate', 'offscreen'] as const)('updates a visible zero-vertex LINE certificate without uploading: %s', (kind) => {
    const target = kind === 'degenerate' ? { ...line, a: { x: 0, y: 1 }, b: { x: 0, y: 1 } } : { ...line, a: { x: 1000, y: 0 }, b: { x: 1001, y: 0 } };
    const before = scene(target), after = replace(before, shifted(target));
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, view, overlay).rendered).toBe(true);
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D, original = gl.vertices.slice();
    expect(patchSlot(prepared)).toMatchObject({ editableLine: true, count: 0 });
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'document-delta', uploadKind: 'none', bytes: 0, uploadCalls: 0, preparedEntities: 1, reusedEntities: prepared.entityCount - 1 });
    expect(gl.vertices).toEqual(original); expect(gl.vertices).toEqual(referencePrepare(after, view, overlay).vertices);
    expect(prepared.sourceBounds).toEqual(referencePrepare(after, view, overlay).sourceBounds);
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('rejects hidden LINE certificates before partial preparation and keeps their bounds out of the visible union', () => {
    const target = { ...line, layer: 'hidden' }, before = scene(target, { layers: [layer, { ...layer, name: 'hidden', visible: false }] });
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), prepareLine = vi.spyOn(geometry, 'prepareZoomLine'), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay);
    const prepared = prepare.mock.results[0]!.value as PreparedZoom2D;
    expect(patchSlot(prepared)).toMatchObject({ editableLine: false, count: 0, sourceBounds: null });
    expect(renderer.render(replace(before, shifted(target)), view, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', cacheReason: 'document' });
    expect(prepareLine).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each(['duplicate', 'empty'] as const)('disables all compiled owner certificates for ambiguous original IDs: %s', (kind) => {
    const before = scene(line, { entities: [text(kind === 'duplicate' ? 'target' : ''), line, owner] });
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), prepareLine = vi.spyOn(geometry, 'prepareZoomLine'), { renderer, gl } = rendererFixture();
    expect(renderer.render(before, view, overlay).rendered).toBe(true);
    expect((prepare.mock.results[0]!.value as PreparedZoom2D).entities).toBeNull();
    expect(renderer.render(replace(before, shifted(line)), view, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', cacheReason: 'document' });
    expect(prepareLine).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each(['two-lines', 'text', 'insert', 'attribute-value', 'block-child', 'attribute-definition', 'text-style', 'layer', 'linetypes', 'color', 'lineweight', 'order', 'new-id', 'unsealed'] as const)('fully prepares incompatible compiled changes: %s', (kind) => {
    const before = scene(), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay);
    let after = replace(before, shifted(line));
    if (kind === 'two-lines') after = scene(line, { entities: [before.entities[0]!, shifted(line), owner, { ...line, id: 'extra' }] });
    if (kind === 'text') after = replace(before, text('before', { text: 'X' }), 0);
    if (kind === 'insert') after = replace(before, { ...owner, position: { x: 2, y: 1 } }, 2);
    if (kind === 'attribute-value') after = replace(before, { ...owner, attributes: { TAG: 'Y' } }, 2);
    if (kind === 'block-child') after = sealImmutableData({ ...before, blocks: { B: { ...block, entities: [{ ...block.entities[0]!, trueColor: 0xff0000 }, block.entities[1]!] } } });
    if (kind === 'attribute-definition') after = sealImmutableData({ ...before, blocks: { B: { ...block, attributes: [{ ...block.attributes[0]!, position: { x: 0.5, y: -0.5 } }] } } });
    if (kind === 'text-style') after = sealImmutableData({ ...before, meta: { textStyles: { Standard: { ...STANDARD_TEXT_STYLE, widthFactor: 1.1 } } } });
    if (kind === 'layer') after = sealImmutableData({ ...before, layers: [{ ...layer, color: 4 }] });
    if (kind === 'linetypes') after = sealImmutableData({ ...before, header: { ...before.header!, linetypes: [...before.header!.linetypes!] } });
    if (kind === 'color') after = replace(before, { ...line, color: 1 });
    if (kind === 'lineweight') after = replace(before, { ...line, lineWeight: 2 });
    if (kind === 'order') after = sealImmutableData({ ...before, entities: [before.entities[1]!, before.entities[0]!, ...before.entities.slice(2)] });
    if (kind === 'new-id') after = replace(before, { ...line, id: 'new' });
    if (kind === 'unsealed') after = { ...before, entities: [before.entities[0]!, shifted(line), ...before.entities.slice(2)] };
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.vertices).toEqual(referencePrepare(after, view, overlay).vertices);
    renderer.dispose();
  });

  it.each(['selection', 'hover', 'dashed'] as const)('invalidates changed compiled overlay state: %s', (kind) => {
    const before = scene(), after = replace(before, shifted(line)), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay);
    const selected = kind === 'hover' ? { selection: new Set<string>(), hover: 'owner' } : { selection: new Set(['target']), solidSelection: kind !== 'dashed' };
    const result = renderer.render(after, view, selected);
    expect(result).toMatchObject(kind === 'dashed' ? { rendered: false, uploadKind: 'none', bytes: 0 } : { rendered: true, uploadKind: 'full' });
    expect(gl.bufferSubData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 2, 3])('keeps the original twisted trillion-coordinate LINE edit on complete Canvas, DPR %s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, target: LineEntity = { ...line, a: { x: origin.x - 32, y: origin.y }, b: { x: origin.x + 32, y: origin.y }, lineWeight: 1 };
    const before = scene(target, { entities: [text('before', { position: { x: origin.x - 4, y: origin.y + 4 }, height: 4 }), target, { ...owner, position: { x: origin.x + 2, y: origin.y - 4 } }] });
    const camera = { ...view, center: origin, scale: 1, twist: 0.63, dpr }, after = replace(before, shifted(target, 1 / 8192));
    const { renderer, gl } = rendererFixture();
    expect(renderer.render(before, camera, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved', uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    const moved = { ...camera, center: { x: origin.x + 1 / 8192, y: origin.y - 1 / 4096 }, scale: 1.1 };
    expect(renderer.render(after, moved, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved', uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 2, 3])('preserves independently admitted zero-twist compiled bytes and fixed weights at a trillion-unit origin, DPR %s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, target: LineEntity = { ...line, a: { x: origin.x - 32, y: origin.y }, b: { x: origin.x + 32, y: origin.y }, lineWeight: 1 };
    const before = scene(target, { entities: [text('before', { position: { x: origin.x - 4, y: origin.y + 4 }, height: 4 }), target, { ...owner, position: { x: origin.x + 2, y: origin.y - 4 } }] });
    const camera = { ...view, center: origin, scale: 1, dpr }, after = replace(before, shifted(target, 1 / 8192));
    const { renderer, gl } = rendererFixture();
    expect(renderer.render(before, camera, overlay).rendered).toBe(true);
    const moved = { ...camera, center: { x: origin.x + 1 / 8192, y: origin.y - 1 / 4096 }, scale: 1.1 };
    expect(renderer.render(after, moved, overlay)).toMatchObject({ rendered: true, cacheReason: 'document-delta', uploadKind: 'subrange', bytes: 168, preparedEntities: 1 });
    // Rebuild independently at the retained anchor; current pose is supplied by uniforms.
    expect(gl.vertices).toEqual(referencePrepare(after, camera, overlay).vertices);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['subrange-error', 'subrange-throw', 'draw-error', 'draw-throw'] as const)('fully repairs every compiled owner after an ambiguous GPU failure: %s', (kind) => {
    const before = scene(), after = replace(before, shifted(line)), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    if (kind.startsWith('subrange')) {
      gl.bufferSubData.mockImplementationOnce((_target, offset, data) => {
        gl.vertices.set(data.subarray(0, data.length / 2), offset / 4);
        if (kind === 'subrange-throw') throw new Error('partial compiled upload throw');
      });
      if (kind === 'subrange-error') gl.getError.mockReturnValueOnce(gl.OUT_OF_MEMORY);
    } else if (kind === 'draw-error') gl.getError.mockReturnValueOnce(0).mockReturnValueOnce(gl.OUT_OF_MEMORY);
    else gl.drawArrays.mockImplementationOnce(() => { throw new Error('compiled draw throw'); });
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: false, uploadKind: 'subrange', bytes: 168, subrangeUploadCalls: 1 });
    if (kind.startsWith('subrange')) { expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); }
    const expected = referencePrepare(after, view, overlay);
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, uploadKind: 'full', bytes: expected.vertices.byteLength, uploadCalls: 1, preparedEntities: 0, subrangeUploadCalls: 0 });
    expect(gl.vertices).toEqual(expected.vertices); expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, editMemoHit: true, preparedEntities: 0, uploadKind: 'subrange' });
    expect(gl.vertices).toEqual(referencePrepare(before, view, overlay).vertices);
    renderer.dispose();
  });

  it.each([false, true])('repairs context loss during a compiled subrange upload, immediate event %s', (event) => {
    const before = scene(), after = replace(before, shifted(line)), { renderer, gl, canvas } = rendererFixture();
    renderer.render(before, view, overlay);
    gl.bufferSubData.mockImplementationOnce(() => { gl.isContextLost.mockReturnValue(true); if (event) canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: false, uploadKind: 'subrange' });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    gl.isContextLost.mockReturnValue(false); if (event) canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(after, view, overlay)).toMatchObject({ rendered: true, cacheReason: event ? 'cold' : 'hit', uploadKind: 'full', editMemoHit: false });
    expect(gl.vertices).toEqual(referencePrepare(after, view, overlay).vertices);
    expect(gl.createBuffer).toHaveBeenCalledTimes(event ? 2 : 1);
    renderer.dispose();
  });

  it('fully prepares the newest compiled document after a failed partial upload', () => {
    const before = scene(), after = replace(before, shifted(line)), latest = replace(before, shifted(line, 0.5)), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay); gl.getError.mockReturnValueOnce(gl.OUT_OF_MEMORY);
    expect(renderer.render(after, view, overlay).rendered).toBe(false);
    expect(renderer.render(latest, view, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(gl.bufferSubData).toHaveBeenCalledOnce(); expect(gl.vertices).toEqual(referencePrepare(latest, view, overlay).vertices);
    renderer.dispose();
  });

  it('bounds owned compiled LINE undo history and prepares an evicted snapshot again', () => {
    const before = scene(), states = [before], { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay);
    let last;
    for (let i = 1; i <= GPU_EDIT_HISTORY_ENTRIES + 3; i++) {
      const next = replace(before, shifted(line, i / 1000)); states.push(next); last = renderer.render(next, view, overlay);
      expect(last).toMatchObject({ rendered: true, uploadKind: 'subrange', preparedEntities: 1 });
      expect(last.editHistoryBytes).toBeLessThanOrEqual(GPU_EDIT_HISTORY_BYTES); expect(last.editHistoryEntries).toBeLessThanOrEqual(GPU_EDIT_HISTORY_ENTRIES);
    }
    expect(last).toMatchObject({ editHistoryEntries: GPU_EDIT_HISTORY_ENTRIES, editHistoryBytes: GPU_EDIT_HISTORY_ENTRIES * 168 });
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, editMemoHit: false, preparedEntities: 1 });
    expect(gl.vertices).toEqual(referencePrepare(before, view, overlay).vertices);
    expect(renderer.render(states.at(-1)!, view, overlay)).toMatchObject({ rendered: true, editMemoHit: true, preparedEntities: 0 });
    renderer.dispose();
  });
});
