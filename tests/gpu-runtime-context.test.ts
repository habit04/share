import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockLookup, LineEntity } from '../src/core/entities';
import { createTextGeometryContext, FontMetricsRegistry } from '../src/render/font-metrics';
import type { TextGeometryContext } from '../src/core/text-metrics';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer, GPU_ADMISSION_DEFERRED_REASON, GPU_ADMISSION_IDLE_MS, GPU_ADMISSION_SLOW_PREPARATION_MS } from '../src/render/gpu-prototype/renderer2d';

const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 7, a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const view: geometry.Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };

/** GL transport double only: actual source preparation, immutable Drawing and runtime registry. */
function fixture(onChange?: () => void) {
  const handle = () => ({});
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0, FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4,
    DEPTH_TEST: 0xb71, CULL_FACE: 0xb44, SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89,
    STENCIL_TEST: 0xb90, BLEND: 0xbe2, COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400,
    FUNC_ADD: 0x8006, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1, EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false), createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => 'invalid shader'),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => 'invalid link'), deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), deleteBuffer: vi.fn(),
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(),
    colorMask: vi.fn(), depthMask: vi.fn(), stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext), width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  const registry = new FontMetricsRegistry(), context = createTextGeometryContext(Object.freeze({}), registry);
  const doc = new Drawing(undefined, () => context); doc.addEntities([line, { ...line, id: 'second', a: { x: -2, y: 1 }, b: { x: 2, y: 1 } }]);
  return { gl, registry, context, doc, renderer: new Gpu2DRenderer(canvas, onChange) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('GPU runtime text context ownership and invalidation', () => {
  it('captures the actual Drawing lookup/context and resets uploaded geometry on a registry epoch without editing data', () => {
    const f = fixture(), prepare = vi.spyOn(geometry, 'prepareZoom2D'), state = f.doc.snapshot, history = f.doc.history(), dirty = f.doc.dirty;
    expect(f.renderer.render(state, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, uploadKind: 'full' });
    expect(prepare.mock.calls[0]![6]?.lookup?.textGeometry).toBe(f.context);
    expect(f.renderer.render(state, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheHit: true, uploadKind: 'none' });
    f.registry.invalidateFallbacks();
    expect(f.renderer.render(state, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'cold', uploadKind: 'full', editMemoHit: false });
    expect(prepare).toHaveBeenCalledTimes(2); expect(f.gl.bufferData).toHaveBeenCalledTimes(2);
    expect(f.doc.snapshot).toBe(state); expect(f.doc.history()).toEqual(history); expect(f.doc.dirty).toBe(dirty);
    f.renderer.dispose();
  });

  it('does not reuse a line delta or undo memo after the text-resource epoch changes', () => {
    const f = fixture();
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock).rendered).toBe(true);
    f.doc.transact(state => ({ ...state, entities: state.entities.map(entity => entity.id === line.id ? { ...line, b: { x: 3, y: 0 } } : entity) }));
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheReason: 'document-delta', uploadKind: 'subrange', editHistoryEntries: 1 });
    f.registry.invalidateFallbacks(); f.doc.undo();
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'cold', uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(f.gl.bufferSubData).toHaveBeenCalledOnce(); f.renderer.dispose();
  });

  it('invalidates an exact immutable refusal when only the registry context changes', () => {
    const f = fixture(), state = { ...f.doc.snapshot, entities: [{ ...line, type: 'circle' as const, center: { x: 0, y: 0 }, radius: 1, filled: true }] };
    const doc = new Drawing(state, () => f.context), prepare = vi.spyOn(geometry, 'prepareZoom2D');
    expect(f.renderer.render(doc.snapshot, view, overlay, doc.lookupBlock).rendered).toBe(false);
    expect(f.renderer.render(doc.snapshot, view, overlay, doc.lookupBlock).cacheReason).toBe('refusal-hit');
    f.registry.invalidateFallbacks();
    expect(f.renderer.render(doc.snapshot, view, overlay, doc.lookupBlock)).toMatchObject({ rendered: false, cacheReason: 'cold', uploadKind: 'none' });
    expect(prepare).toHaveBeenCalledTimes(2); expect(f.gl.drawArrays).not.toHaveBeenCalled(); f.renderer.dispose();
  });

  it('treats distinct session contexts as distinct even if a custom supplier shares the same key', () => {
    const f = fixture(), key = {}, first: TextGeometryContext = { ...f.context, cacheKey: key }, second: TextGeometryContext = { ...f.context, cacheKey: key };
    const lookup = (context: TextGeometryContext): BlockLookup => Object.assign((name: string) => f.doc.snapshot.blocks[name], { textGeometry: context });
    expect(f.renderer.render(f.doc.snapshot, view, overlay, lookup(first)).rendered).toBe(true);
    expect(f.renderer.render(f.doc.snapshot, view, overlay, lookup(first)).cacheHit).toBe(true);
    expect(f.renderer.render(f.doc.snapshot, view, overlay, lookup(second))).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full' });
    f.renderer.dispose();
  });

  it('revokes pending idle admission on a context change observed by the callback before warmup', () => {
    vi.useFakeTimers(); const changed = vi.fn(), f = fixture(changed);
    vi.spyOn(geometry, 'prepareZoom2D').mockImplementationOnce(() => { vi.advanceTimersByTime(GPU_ADMISSION_SLOW_PREPARATION_MS + 1); throw new Error('Stroke geometry exceeds prototype budget'); });
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock).rendered).toBe(false);
    const nextView = { ...view, center: { x: 0.1, y: 0 } };
    expect(f.renderer.render(f.doc.snapshot, nextView, overlay, f.doc.lookupBlock).reason).toBe(GPU_ADMISSION_DEFERRED_REASON);
    expect(vi.getTimerCount()).toBe(1); f.registry.invalidateFallbacks(); vi.advanceTimersByTime(GPU_ADMISSION_IDLE_MS);
    expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(f.renderer.render(f.doc.snapshot, nextView, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheReason: 'cold', uploadKind: 'full' });
    f.renderer.dispose();
  });

  it('falls back before GL allocation/upload if a resource epoch changes inside preparation', () => {
    const f = fixture(), original = geometry.prepareZoom2D;
    vi.spyOn(geometry, 'prepareZoom2D').mockImplementationOnce((...args) => { const prepared = original(...args); f.registry.invalidateFallbacks(); return prepared; });
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: false, reason: 'Canvas text context changed during GPU preparation', uploadKind: 'none', uploadCalls: 0 });
    expect(f.gl.createShader).not.toHaveBeenCalled(); expect(f.gl.bufferData).not.toHaveBeenCalled(); expect(f.gl.drawArrays).not.toHaveBeenCalled();
    expect(f.renderer.render(f.doc.snapshot, view, overlay, f.doc.lookupBlock)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full' }); f.renderer.dispose();
  });
});
