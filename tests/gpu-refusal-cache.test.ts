import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { colorDisplay, lineweightDisplay } from '../src/render/draw';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';

const layer: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const unsupported: Entity = { ...line, id: 'late-fill', type: 'circle', center: { x: 0, y: 0 }, radius: 1, filled: true };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[] = [line, unsupported]): DrawingState => ({ entities, layers: [layer], blocks: {}, currentLayer: '0', header: { ...DEFAULT_HEADER, linetypes: [] }, meta: { textStyles: { Standard: STANDARD_TEXT_STYLE } } });
const sealed = (entities?: readonly Entity[]): DrawingState => sealImmutableData(drawing(entities));

function rendererFixture() {
  const handle = () => ({});
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0, OUT_OF_MEMORY: 0x505,
    FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44,
    SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89, STENCIL_TEST: 0xb90, BLEND: 0xbe2,
    COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400,
    FUNC_ADD: 0x8006, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1,
    EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false),
    createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => 'invalid shader'),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => 'invalid link'),
    deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), deleteBuffer: vi.fn(),
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(),
    stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    fenceSync: vi.fn(() => null), flush: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; },
    get drawingBufferHeight(): number { return canvas.height; },
  };
  const events = new EventTarget();
  const getContext = vi.fn((): WebGL2RenderingContext | null => gl as unknown as WebGL2RenderingContext);
  const canvas = Object.assign(events, { getContext, width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  return { gl, canvas, renderer: new Gpu2DRenderer(canvas) };
}

afterEach(() => vi.restoreAllMocks());

describe('GPU exact immutable geometry refusal memo', () => {
  it('prepares a late unsupported compound once and keeps complete-view refusal without GL work', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const block: BlockDef = { name: 'late', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line, unsupported] };
    const state = sealImmutableData({ ...drawing(), entities: [line, { ...line, id: 'owner', type: 'insert' as const, block: block.name, position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} }], blocks: { [block.name]: block } });
    const { renderer, gl } = rendererFixture();
    const original = JSON.stringify(state), first = renderer.render(state, view, overlay);
    expect(first).toMatchObject({ rendered: false, reason: expect.stringContaining('Unsupported filled circle'), cacheHit: false, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    for (let i = 0; i < 15; i++) {
      const warm = renderer.render(state, { ...view, center: { ...view.center } }, { selection: new Set() });
      expect(warm).toMatchObject({ rendered: false, reason: first.reason, cacheReason: 'refusal-hit', cacheHit: false, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, reusedEntities: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
      expect(Number.isFinite(warm.cacheLookupMs)).toBe(true); expect(warm.cacheLookupMs).toBeGreaterThanOrEqual(0);
    }
    expect(preparation).toHaveBeenCalledOnce();
    expect(gl.createShader).not.toHaveBeenCalled(); expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(original);
    renderer.dispose();
  });

  it('memoizes deliberate native stroke-construction refusal while preserving the last healthy upload', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const valid = sealed([line]);
    const block: BlockDef = { name: 'repeated', basePoint: { x: 0, y: 0 }, attributes: [], entities: [{
      ...line, type: 'polyline', closed: false,
      points: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    }] };
    const state = sealImmutableData({ ...valid, entities: [line, { ...line, id: 'owner', type: 'insert' as const, block: block.name, position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} }], blocks: { [block.name]: block } });
    const { renderer, gl } = rendererFixture();
    expect(renderer.render(valid, view, overlay).rendered).toBe(true);
    const original = JSON.stringify(state);
    const first = renderer.render(state, view, overlay);
    expect(first).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: internal degenerate join is unproved', cacheHit: false, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    for (let i = 0; i < 3; i++) expect(renderer.render(state, view, overlay)).toMatchObject({
      rendered: false, reason: first.reason, cacheReason: 'refusal-hit', cacheHit: false,
      geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0,
      uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0,
    });
    expect(preparation).toHaveBeenCalledTimes(2);
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(gl.clear).toHaveBeenCalledOnce(); expect(gl.drawArrays).toHaveBeenCalledOnce();
    expect(renderer.render(valid, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, cacheReason: 'hit', geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(preparation).toHaveBeenCalledTimes(2); expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(JSON.stringify(state)).toBe(original);
    renderer.dispose();
  });

  it.each([TypeError, RangeError])('retries wrapped native %s with the stroke-construction prefix and preserves the healthy upload', (NativeError) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const valid = sealed([line]), { renderer, gl } = rendererFixture();
    expect(renderer.render(valid, view, overlay).rendered).toBe(true);
    const error = new NativeError('Unsupported Canvas stroke construction: unexpected native failure');
    const expansion = vi.spyOn(entities, 'expandInsert').mockImplementation(() => { throw error; });
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line] };
    const state = sealImmutableData({ ...valid, entities: [{ ...line, id: 'owner', type: 'insert' as const, block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} }], blocks: { B: block } });
    for (let i = 0; i < 3; i++) {
      const refused = renderer.render(state, view, overlay);
      expect(refused).toMatchObject({ rendered: false, reason: error.message, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      expect(refused.cacheReason).not.toBe('refusal-hit');
    }
    expect(expansion).toHaveBeenCalledTimes(3); expect(preparation).toHaveBeenCalledTimes(4);
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(gl.clear).toHaveBeenCalledOnce(); expect(gl.drawArrays).toHaveBeenCalledOnce();
    expect(renderer.render(valid, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, cacheReason: 'hit', geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(preparation).toHaveBeenCalledTimes(4); expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['width', 'height', 'dpr', 'scale', 'center-x', 'center-y', 'twist', 'background', 'lineweights'] as const)('retries every exact camera/style change and retains only the most recent refused pose: %s', (key) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), state = sealed();
    const { renderer } = rendererFixture();
    const changed = { ...view, center: { ...view.center } };
    if (key === 'center-x') changed.center = { x: 0.001, y: 0 };
    else if (key === 'center-y') changed.center = { x: 0, y: 0.001 };
    else if (key === 'background') changed.background = '#212831';
    else if (key === 'lineweights') changed.lineweights = true;
    else changed[key] += 0.01;
    renderer.render(state, view, overlay);
    expect(renderer.render(state, changed, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(2);
    expect(renderer.render(state, changed, overlay).cacheReason).toBe('refusal-hit');
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it.each(['entities', 'layers', 'blocks', 'block-child', 'linetypes', 'textStyles', 'other-meta', 'outer'] as const)('invalidates every certified scene dependency change: %s', (key) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line] };
    const state = sealImmutableData({ ...drawing(), blocks: { B: block } });
    let changed: DrawingState = { ...state };
    if (key === 'entities') changed = { ...state, entities: [...state.entities] };
    if (key === 'layers') changed = { ...state, layers: [...state.layers] };
    if (key === 'blocks') changed = { ...state, blocks: { ...state.blocks } };
    if (key === 'block-child') changed = { ...state, blocks: { B: { ...block, entities: [{ ...line, b: { x: 3, y: 0 } }] } } };
    if (key === 'linetypes') changed = { ...state, header: { ...state.header!, linetypes: [] } };
    if (key === 'textStyles') changed = { ...state, meta: { ...state.meta, textStyles: { Standard: { ...STANDARD_TEXT_STYLE, font: 'romans.shx' } } } };
    if (key === 'other-meta') changed = { ...state, meta: { ...state.meta, arbitrary: 'new' } };
    sealImmutableData(changed);
    const { renderer } = rendererFixture();
    renderer.render(state, view, overlay);
    expect(renderer.render(changed, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(2);
    expect(renderer.render(changed, view, overlay).cacheReason).toBe('refusal-hit');
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it('copies borrowed camera and selection values while accepting new sets with identical membership', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), state = sealed();
    const { renderer } = rendererFixture();
    const camera = { ...view, center: { ...view.center } }, selected = { selection: new Set(['line', 'other']), hover: null as string | null, solidSelection: true };
    renderer.render(state, camera, selected);
    expect(renderer.render(state, camera, { ...selected, selection: new Set(['other', 'line']) }).cacheReason).toBe('refusal-hit');
    camera.center.x = 0.1;
    expect(renderer.render(state, camera, selected).cacheReason).not.toBe('refusal-hit');
    selected.selection.add('new');
    expect(renderer.render(state, camera, selected).cacheReason).not.toBe('refusal-hit');
    selected.hover = 'hover';
    expect(renderer.render(state, camera, selected).cacheReason).not.toBe('refusal-hit');
    selected.solidSelection = false;
    expect(renderer.render(state, camera, selected).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(5);
    renderer.dispose();
  });

  it('does not certify frozen-but-unsealed inputs or mutable nested geometry', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const mutable = { ...unsupported };
    const state = Object.freeze(drawing([line, mutable]));
    const { renderer } = rendererFixture();
    for (let i = 0; i < 3; i++) expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, cacheReason: 'mutable' });
    mutable.filled = false;
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'mutable' });
    expect(preparation).toHaveBeenCalledTimes(4);
    renderer.dispose();
  });

  it.each(['block', 'style', 'linetype'] as const)('retries mutable nested %s changes and admits corrected input', (key) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const block = { name: 'B', basePoint: { x: 0, y: 0 }, attributes: [], entities: [unsupported] as Entity[] };
    const text: TextEntity = { ...line, id: 'text', type: 'text', position: { x: 0, y: 0 }, text: 'A', height: 1, rotation: 0, align: 'left', style: 'Custom' };
    const styles = { Custom: { ...STANDARD_TEXT_STYLE, name: 'Custom', font: 'arial.ttf' } };
    const linetypes = [{ name: 'custom', description: '', pattern: [1, -1] }];
    const entities: Entity[] = key === 'block' ? [{ ...line, type: 'insert', block: 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }] : key === 'style' ? [text] : [{ ...line, linetype: 'custom' }];
    const state: DrawingState = { ...drawing(sealImmutableData(entities)), layers: sealImmutableData([layer]), blocks: { B: block }, meta: { textStyles: styles }, header: { ...DEFAULT_HEADER, linetypes } };
    const { renderer } = rendererFixture();
    expect(renderer.render(state, view, overlay).rendered).toBe(false);
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    if (key === 'block') block.entities = [line];
    if (key === 'style') styles.Custom.font = 'romans.shx';
    if (key === 'linetype') linetypes[0]!.pattern = [];
    expect(renderer.render(state, view, overlay).rendered).toBe(true);
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it('retains the last valid prepared/uploaded scene through a refusal and document undo', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const valid = sealed([line]), bad = sealImmutableData({ ...valid, entities: [line, unsupported] });
    const { renderer, gl } = rendererFixture();
    expect(renderer.render(valid, view, overlay).rendered).toBe(true);
    renderer.render(bad, view, overlay);
    expect(renderer.render(bad, view, overlay).cacheReason).toBe('refusal-hit');
    expect(renderer.render(valid, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, cacheReason: 'hit', uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    renderer.clearRefusalCache();
    expect(renderer.render(valid, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'hit', uploadKind: 'none' });
    expect(preparation).toHaveBeenCalledTimes(2); expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(renderer.render(bad, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it.each([new TypeError('Unsupported entity: broken getter'), new RangeError('Stroke geometry allocation failed'), new Error('Unexpected graph exception'), new Error(`Unsupported entity: ${'x'.repeat(4096)}`), new Error('WebGL2 transient error'), new Error('Unsupported Canvas stroke construction without colon'), new Error('Unsupported Canvas stroke constructionx: unknown admission')])('does not memoize allocation/programming/unknown errors: %s', (error) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D').mockImplementation(() => { throw error; });
    const state = sealed([line]), { renderer } = rendererFixture();
    for (let i = 0; i < 3; i++) expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it('bounds error-cause inspection and never stores a borrowed mutable error object', () => {
    const error = new Error('Unsupported entity: borrowed admission');
    const preparation = vi.spyOn(geometry, 'prepareZoom2D').mockImplementation(() => { throw error; });
    const state = sealed([line]), { renderer } = rendererFixture();
    renderer.render(state, view, overlay);
    error.message = 'Unexpected mutation to borrowed error';
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, cacheReason: 'refusal-hit', reason: 'Unsupported entity: borrowed admission' });
    expect(preparation).toHaveBeenCalledOnce();
    renderer.clearRefusalCache();
    const cyclic = new Error('Unsupported entity: cyclic cause'); cyclic.cause = cyclic;
    preparation.mockImplementation(() => { throw cyclic; });
    for (let i = 0; i < 3; i++) expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(4);
    renderer.dispose();
  });

  it.each([new TypeError('Unsupported block transform (owner)'), new RangeError('Stroke geometry allocation failed')])('preserves unexpected compound failure provenance instead of memoizing its wrapped reason: %s', (error) => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const expansion = vi.spyOn(entities, 'expandInsert').mockImplementation(() => { throw error; });
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line] };
    const state = sealImmutableData({ ...drawing(), entities: [{ ...line, id: 'owner', type: 'insert' as const, block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} }], blocks: { B: block } });
    const { renderer } = rendererFixture();
    for (let i = 0; i < 3; i++) expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: error.message, cacheReason: 'cold' });
    expect(expansion).toHaveBeenCalledTimes(3); expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it.each(['shader', 'upload', 'draw'] as const)('does not memoize GL %s errors as geometry admission', (phase) => {
    const { renderer, gl } = rendererFixture(), state = sealed([line]);
    if (phase === 'shader') gl.getShaderParameter.mockReturnValue(false);
    if (phase === 'upload') gl.getError.mockReturnValueOnce(gl.OUT_OF_MEMORY);
    if (phase === 'draw') gl.getError.mockReturnValueOnce(0).mockReturnValueOnce(gl.OUT_OF_MEMORY);
    expect(renderer.render(state, view, overlay).rendered).toBe(false);
    const next = renderer.render(state, view, overlay);
    expect(next.cacheReason).not.toBe('refusal-hit');
    if (phase !== 'shader') expect(next.rendered).toBe(true);
    renderer.dispose();
  });

  it('does not memoize GPU fence failure', async () => {
    const { renderer } = rendererFixture(), state = sealed([line]);
    expect(renderer.render(state, view, overlay).rendered).toBe(true);
    expect(await renderer.device.completed()).toBeNull();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'hit', uploadKind: 'none' });
    renderer.dispose();
  });

  it('clears refused admission on mode/reset/loss/restoration/disposal without keeping a history', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), state = sealed();
    const { renderer, canvas, gl } = rendererFixture();
    renderer.render(state, view, overlay);
    expect(renderer.render(state, view, overlay).cacheReason).toBe('refusal-hit');
    renderer.clearRefusalCache(); // The app calls this on an actual Canvas/GPU mode change.
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, cacheReason: 'not-checked' });
    gl.isContextLost.mockReturnValue(false); canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(3);
    renderer.dispose(); expect(renderer.render(state, view, overlay).reason).toMatch(/disposed/);
    const replacement = new Gpu2DRenderer(canvas);
    expect(replacement.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(4);
    replacement.dispose();
  });

  it('clears refused admission on a device error before geometry preparation', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), state = sealed();
    const { renderer, gl } = rendererFixture();
    renderer.render(state, view, overlay);
    gl.isContextLost.mockReturnValue(true);
    expect(renderer.render(state, view, overlay).reason).toMatch(/context is lost/);
    gl.isContextLost.mockReturnValue(false);
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('clears an earlier memo if GL throws before the current geometry attempt', () => {
    const preparation = vi.spyOn(geometry, 'prepareZoom2D'), state = sealed();
    const { renderer, gl } = rendererFixture();
    renderer.render(state, view, overlay);
    gl.isContextLost.mockImplementationOnce(() => { throw new Error('Transient GL state lookup failed'); });
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: 'Transient GL state lookup failed', cacheReason: 'not-checked' });
    expect(renderer.render(state, view, overlay).cacheReason).not.toBe('refusal-hit');
    expect(preparation).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('keys effective lineweights and selection without leaking Canvas global settings', () => {
    const previousWeights = { ...lineweightDisplay }, previousPaper = colorDisplay.paper;
    const preparation = vi.spyOn(geometry, 'prepareZoom2D');
    const state = sealed([{ ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 0.1, lineWeight: 10 }]);
    const { renderer } = rendererFixture();
    try {
      lineweightDisplay.enabled = true; lineweightDisplay.pxPerMm = 123; colorDisplay.paper = true;
      const implicit = { ...view, lineweights: undefined };
      expect(renderer.render(state, implicit, overlay).rendered).toBe(false);
      expect(renderer.render(state, implicit, overlay).cacheReason).toBe('refusal-hit');
      lineweightDisplay.enabled = false;
      expect(renderer.render(state, implicit, overlay).rendered).toBe(true);
      lineweightDisplay.enabled = true;
      expect(renderer.render(state, implicit, overlay).rendered).toBe(false);
      expect(renderer.render(state, implicit, { selection: new Set(['line']), solidSelection: true }).rendered).toBe(true);
      expect(preparation).toHaveBeenCalledTimes(4);
      expect(lineweightDisplay).toMatchObject({ enabled: true, pxPerMm: 123 }); expect(colorDisplay.paper).toBe(true);
      const bad = sealed(); renderer.render(bad, view, overlay); // explicit lineweights=false
      lineweightDisplay.enabled = false;
      expect(renderer.render(bad, view, overlay).cacheReason).toBe('refusal-hit');
    } finally { renderer.dispose(); Object.assign(lineweightDisplay, previousWeights); colorDisplay.paper = previousPaper; }
  });
});
