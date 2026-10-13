import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { Layer, LineEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DOverlay, Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { GPU_ADMISSION_DEFERRED_REASON, GPU_ADMISSION_IDLE_MS, GPU_ADMISSION_SLOW_PREPARATION_MS, Gpu2DRenderer, type Gpu2DRenderResult } from '../src/render/gpu-prototype/renderer2d';

const budget = 'Stroke geometry exceeds prototype budget';
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const scene = (entities: readonly LineEntity[] = [line]): DrawingState => sealImmutableData({ entities, layers: [layer], blocks: {}, currentLayer: '0' });
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay: Gpu2DOverlay = { selection: new Set() };
const referenceLine = geometry.prepareZoomLine;

function rendererFixture(onStateChange?: () => void) {
  const handle = () => ({});
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
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), deleteBuffer: vi.fn(),
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
  return { gl, canvas, renderer: new Gpu2DRenderer(canvas, onStateChange) };
}

function expectDeferred(result: Gpu2DRenderResult): void {
  expect(result).toMatchObject({ rendered: false, reason: GPU_ADMISSION_DEFERRED_REASON, cacheHit: false, cacheReason: 'admission-deferred', geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, reusedEntities: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0, subrangeUploadBytes: 0, subrangeUploadCalls: 0, submissionMs: 0 });
  expect(Number.isFinite(result.cacheLookupMs)).toBe(true); expect(result.cacheLookupMs).toBeGreaterThanOrEqual(0);
}

function slowRefusalOnce(error = new Error(budget), elapsed = GPU_ADMISSION_SLOW_PREPARATION_MS + 1) {
  return vi.spyOn(geometry, 'prepareZoom2D').mockImplementationOnce(() => { vi.advanceTimersByTime(elapsed); throw error; });
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded admission deferral after a measured slow immutable stroke-budget refusal', () => {
  it('keeps exact refusal hits but freshly admits the latest drawing/view/overlay once after idle', () => {
    const prepare = slowRefusalOnce();
    let currentState = scene(), currentView = view, currentOverlay = overlay;
    const completed: Gpu2DRenderResult[] = [];
    const onChange = vi.fn(() => { completed.push(renderer.render(currentState, currentView, currentOverlay)); });
    const { renderer, gl } = rendererFixture(onChange);
    const initial = renderer.render(currentState, currentView, currentOverlay);
    expect(initial).toMatchObject({ rendered: false, reason: budget, geometryPreparationMs: 51 });
    expect(renderer.render(currentState, currentView, currentOverlay)).toMatchObject({ rendered: false, reason: budget, cacheReason: 'refusal-hit', geometryPreparationMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    currentView = { ...view, center: { x: 0.1, y: 0 }, scale: 33 };
    expectDeferred(renderer.render(currentState, currentView, currentOverlay));
    expect(prepare).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GPU_ADMISSION_IDLE_MS - 1); expect(onChange).not.toHaveBeenCalled();
    // The owner must read present state when notified, even if it changed without a render.
    currentState = scene([{ ...line, b: { x: 3, y: 0 } }]);
    currentOverlay = { selection: new Set(['line']), solidSelection: true };
    currentView = { ...currentView, center: { x: 0.2, y: 0.1 }, twist: 0.2 };
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledOnce(); expect(completed[0]).toMatchObject({ rendered: true, uploadKind: 'full' });
    expect(prepare).toHaveBeenCalledTimes(2); expect(prepare.mock.calls[1]!.slice(0, 3)).toEqual([currentState, currentView, currentOverlay]);
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000); expect(onChange).toHaveBeenCalledOnce();
    expect(renderer.render(currentState, currentView, currentOverlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    renderer.dispose();
  });

  it('bounds the timer to one entry and resets its idle deadline during continued camera/document/overlay changes', () => {
    const prepare = slowRefusalOnce(), onChange = vi.fn(), { renderer } = rendererFixture(onChange);
    const original = scene(); renderer.render(original, view, overlay);
    let current = original, camera = view, selected = overlay;
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(50);
      current = scene([{ ...line, b: { x: 3 + i, y: 0 } }]);
      camera = { ...view, center: { x: i + 1, y: 0 } };
      selected = { selection: new Set([i % 2 ? 'line' : 'other']), solidSelection: true };
      expectDeferred(renderer.render(current, camera, selected));
      expect(vi.getTimerCount()).toBe(1); expect(prepare).toHaveBeenCalledOnce(); expect(onChange).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(99); expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(onChange).toHaveBeenCalledOnce();
    expect(renderer.render(current, camera, selected).rendered).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it('does not self-schedule another retry when idle admission produces a renewed slow refusal', () => {
    const prepare = vi.spyOn(geometry, 'prepareZoom2D').mockImplementation(() => { vi.advanceTimersByTime(51); throw new Error(budget); });
    const state = scene(), camera = { ...view, scale: 33 }, results: Gpu2DRenderResult[] = [];
    const onChange = vi.fn(() => results.push(renderer.render(state, camera, overlay)));
    const { renderer } = rendererFixture(onChange);
    renderer.render(state, view, overlay); expectDeferred(renderer.render(state, camera, overlay));
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledOnce(); expect(results[0]).toMatchObject({ rendered: false, reason: budget, geometryPreparationMs: 51 });
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000); expect(onChange).toHaveBeenCalledOnce();
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, cacheReason: 'refusal-hit', geometryPreparationMs: 0 });
    expectDeferred(renderer.render(state, { ...camera, scale: 34 }, overlay)); expect(vi.getTimerCount()).toBe(1);
    renderer.dispose();
  });

  it.each([
    { label: 'fast', elapsed: 0, error: new Error(budget) },
    { label: 'threshold exactly50', elapsed: 50, error: new Error(budget) },
    { label: 'near-prefix', elapsed: 51, error: new Error(`${budget} (other condition)`) },
    { label: 'direct TypeError', elapsed: 51, error: new TypeError(budget) },
    { label: 'direct RangeError', elapsed: 51, error: new RangeError(budget) },
    { label: 'wrapped TypeError', elapsed: 51, error: new Error(budget, { cause: new TypeError(budget) }) },
    { label: 'wrapped RangeError', elapsed: 51, error: new Error(budget, { cause: new RangeError(budget) }) },
    { label: 'non-error cause', elapsed: 51, error: new Error(budget, { cause: {} }) },
    { label: 'other admission', elapsed: 51, error: new Error('Unsupported Canvas stroke construction: point, normal or miter exceeds precision budget') },
  ])('never defers unqualified geometry failures: $label', ({ elapsed, error }) => {
    const prepare = slowRefusalOnce(error, elapsed), onChange = vi.fn(), { renderer } = rendererFixture(onChange), state = scene();
    expect(renderer.render(state, view, overlay).rendered).toBe(false);
    expect(renderer.render(state, { ...view, scale: 33 }, overlay).rendered).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); expect(onChange).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([false, true])('does not arm policy for mutable or frozen-but-unsealed snapshots: frozen %s', (frozen) => {
    const prepare = slowRefusalOnce(), base = scene(), state = frozen ? Object.freeze({ ...base }) : { ...base }, { renderer } = rendererFixture();
    renderer.render(state, view, overlay);
    expect(renderer.render(state, { ...view, scale: 33 }, overlay).rendered).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it('clears an armed policy instead of deferring mutable current input', () => {
    const prepare = slowRefusalOnce(), base = scene(), { renderer } = rendererFixture();
    renderer.render(base, view, overlay);
    const mutable = { ...base, entities: [{ ...line, b: { x: 3, y: 0 } }] };
    expect(renderer.render(mutable, { ...view, scale: 33 }, overlay).rendered).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it.each(['mode/reset', 'loss/restore', 'unannounced-loss', 'dispose'] as const)('cancels pending policy and timer on %s', (event) => {
    const prepare = slowRefusalOnce(), onChange = vi.fn(), { renderer, gl, canvas } = rendererFixture(onChange), state = scene(), camera = { ...view, scale: 33 };
    renderer.render(state, view, overlay); expectDeferred(renderer.render(state, camera, overlay));
    if (event === 'mode/reset') renderer.clearRefusalCache();
    else if (event === 'loss/restore') {
      gl.isContextLost.mockReturnValue(true); canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      gl.isContextLost.mockReturnValue(false); canvas.dispatchEvent(new Event('webglcontextrestored'));
    } else if (event === 'unannounced-loss') {
      gl.isContextLost.mockReturnValue(true); expect(renderer.render(state, camera, overlay).rendered).toBe(false); gl.isContextLost.mockReturnValue(false);
    } else renderer.dispose();
    const notifications = onChange.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(1000); expect(onChange).toHaveBeenCalledTimes(notifications);
    if (event !== 'dispose') {
      expect(renderer.render(state, camera, overlay).rendered).toBe(true); expect(prepare).toHaveBeenCalledTimes(2);
      renderer.dispose();
    } else expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('disposed') });
  });

  it.each(['lost-at-deadline', 'callback-throw'] as const)('clears policy when an idle retry cannot notify its healthy owner: %s', (failure) => {
    const prepare = slowRefusalOnce(), onChange = vi.fn();
    if (failure === 'callback-throw') onChange.mockImplementationOnce(() => { throw new Error('owner scheduling failure'); });
    const { renderer, gl } = rendererFixture(onChange), state = scene(), camera = { ...view, scale: 33 };
    renderer.render(state, view, overlay); expectDeferred(renderer.render(state, camera, overlay));
    if (failure === 'lost-at-deadline') gl.isContextLost.mockReturnValue(true);
    vi.advanceTimersByTime(100); expect(onChange).toHaveBeenCalledTimes(failure === 'lost-at-deadline' ? 0 : 1);
    gl.isContextLost.mockReturnValue(false);
    expect(renderer.render(state, camera, overlay).rendered).toBe(true); expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it('does not arm policy for an expensive GL exception with a geometry-budget-shaped message', () => {
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    gl.getError.mockImplementationOnce(() => { vi.advanceTimersByTime(51); throw new Error(budget); });
    expect(renderer.render(scene(), view, overlay).rendered).toBe(false);
    expect(renderer.render(scene([line, { ...line, id: 'second' }]), view, overlay).rendered).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it.each(['cache', 'delta'] as const)('uses a healthy positive %s before deferral and cancels its pending timer', (kind) => {
    const before = scene(), { renderer, gl } = rendererFixture(vi.fn()); renderer.render(before, view, overlay);
    const prepare = slowRefusalOnce(), large = sealImmutableData({ ...before, entities: [line, { ...line, id: 'other' }] });
    renderer.render(large, view, overlay); expectDeferred(renderer.render(large, { ...view, scale: 33 }, overlay));
    const next = kind === 'cache' ? before : sealImmutableData({ ...before, entities: [{ ...line, a: { x: -2, y: 0.2 }, b: { x: 2, y: 0.2 } }] });
    expect(renderer.render(next, view, overlay)).toMatchObject(kind === 'cache' ? { rendered: true, cacheHit: true, uploadKind: 'none', geometryPreparationMs: 0 } : { rendered: true, cacheReason: 'document-delta', uploadKind: 'subrange', bytes: 168, preparedEntities: 1 });
    expect(prepare).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it('bypasses policy when a failed LINE candidate already did measured work and reports full admission honestly', () => {
    const before = scene(), { renderer } = rendererFixture(); renderer.render(before, view, overlay);
    slowRefusalOnce(); renderer.render(sealImmutableData({ ...before, entities: [line, { ...line, id: 'other' }] }), view, overlay);
    const prepareLine = vi.spyOn(geometry, 'prepareZoomLine').mockImplementation((...args) => { vi.advanceTimersByTime(5); return referenceLine(...args); });
    const colorChanged = sealImmutableData({ ...before, entities: [{ ...line, color: 1 as const }] });
    expect(renderer.render(colorChanged, view, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', preparedEntities: 2, partialPreparationMs: 5, geometryPreparationMs: 5 });
    expect(prepareLine).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });

  it('drops prior slow-budget policy after a fresh idle admission refuses for a different fast reason', () => {
    const prepare = slowRefusalOnce(), state = scene(), camera = { ...view, scale: 33 }, result: Gpu2DRenderResult[] = [];
    const onChange = vi.fn(() => result.push(renderer.render(state, camera, overlay))), { renderer } = rendererFixture(onChange);
    renderer.render(state, view, overlay); expectDeferred(renderer.render(state, camera, overlay));
    prepare.mockImplementationOnce(() => { throw new Error('Unsupported entity: unsupported current scene'); });
    vi.advanceTimersByTime(100);
    expect(result[0]).toMatchObject({ rendered: false, reason: 'Unsupported entity: unsupported current scene' });
    expect(renderer.render(state, { ...camera, scale: 34 }, overlay).rendered).toBe(true); expect(prepare).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0); renderer.dispose();
  });
});
