import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import * as hershey from '../src/render/hershey';
import * as geometry from '../src/render/gpu-prototype/geometry2d';
import type { Gpu2DView, PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import * as strokeScene from '../src/render/gpu-prototype/stroke-scene';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'target', type: 'line', layer: '0', color: 'ByLayer', a: { x: -3, y: 1 }, b: { x: 3, y: 1 } };
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'label', type: 'text', layer: '0', color: 1, position: { x: -2, y: 2 }, text: 'AB', height: 1, rotation: 0, align: 'left', ...patch });
const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [{ ...line, id: 'child', a: { x: -0.5, y: 0 }, b: { x: 0.5, y: 0 } }, text({ id: 'child-text', position: { x: 0, y: 1 }, text: 'C' })], attributes: [] };
const owner: InsertEntity = { id: 'owner', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 1, y: -2 }, scale: 1, rotation: 0, attributes: {} };
const originalRotatedView: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0.2, background: '#212830', lineweights: true };
const view: Gpu2DView = { ...originalRotatedView, twist: 0 };
const overlay = { selection: new Set<string>() };
const scene = (patch: Partial<DrawingState> = {}): DrawingState => sealImmutableData({ entities: [text(), line, owner], layers: [layer], blocks: { B: block }, currentLayer: '0', header: { ...DEFAULT_HEADER, linetypes: [] }, meta: { textStyles: { Standard: STANDARD_TEXT_STYLE } }, ...patch });
const edit = (state: DrawingState, replacement: Entity): DrawingState => sealImmutableData({ ...state, entities: [state.entities[0]!, replacement, ...state.entities.slice(2)] });
const shifted: LineEntity = { ...line, a: { x: -3, y: 1.25 }, b: { x: 3, y: 1.25 } };
const referencePrepare = geometry.prepareZoom2D;

function rendererFixture() {
  let vertices = new Float32Array(0);
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
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), deleteBuffer: vi.fn(),
    bufferData: vi.fn((_target: number, data: BufferSource, _usage: number) => { vertices = (data as Float32Array<ArrayBuffer>).slice(); }),
    bufferSubData: vi.fn((_target: number, byteOffset: number, data: Float32Array<ArrayBuffer>) => { vertices.set(data, byteOffset / 4); }),
    get vertices(): Float32Array<ArrayBuffer> { return vertices; },
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string): { name: string } | null => ({ name })),
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

/** Evaluate the captured shader's small arithmetic subset in binary32. This
 * checks its real expressions/uniforms against a Canvas coordinate reference,
 * without substituting a second hard-coded copy of the shader transform. */
function shaderPhysicalPoint(gl: ReturnType<typeof rendererFixture>['gl'], center: readonly [number, number], offset: readonly [number, number] = [0, 0]): readonly [number, number] {
  type Value = number | readonly [number, number];
  const values: Record<string, Value> = { a_center: center.map(Math.fround) as [number, number], a_offset: offset.map(Math.fround) as [number, number] };
  for (const [location, x, y] of gl.uniform2f.mock.calls) values[(location as { name: string }).name] = [Math.fround(x as number), Math.fround(y as number)];
  for (const [location, x] of gl.uniform1f.mock.calls) values[(location as { name: string }).name] = Math.fround(x as number);
  const source = gl.shaderSource.mock.calls.find((call) => String(call[1]).includes('gl_Position'))?.[1] as string;
  expect(source).toBeTypeOf('string');
  const operation = (a: Value, b: Value, symbol: string): Value => {
    const scalar = (x: number, y: number) => Math.fround(symbol === '+' ? x + y : symbol === '-' ? x - y : symbol === '*' ? x * y : x / y);
    if (typeof a === 'number' && typeof b === 'number') return scalar(a, b);
    const av = typeof a === 'number' ? [a, a] : a, bv = typeof b === 'number' ? [b, b] : b;
    return [scalar(av[0]!, bv[0]!), scalar(av[1]!, bv[1]!)];
  };
  const evaluate = (expression: string): Value => {
    const tokens = expression.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[()+\-*/.]/g) ?? [];
    let index = 0;
    const factor = (): Value => {
      const token = tokens[index++]!;
      if (token === '(') { const value = sum(); expect(tokens[index++]).toBe(')'); return value; }
      if (token === '-') return operation(0, factor(), '-');
      if (/^\d/.test(token)) return Math.fround(Number(token));
      const value = values[token];
      if (value === undefined) throw new Error(`Unknown captured shader value ${token}`);
      if (tokens[index] === '.') {
        index++; const axis = tokens[index++];
        if (typeof value === 'number' || axis !== 'x' && axis !== 'y') throw new Error('Invalid captured shader component');
        return value[axis === 'x' ? 0 : 1];
      }
      return value;
    };
    const product = (): Value => {
      let value = factor();
      while (tokens[index] === '*' || tokens[index] === '/') {
        const symbol = tokens[index++]!; value = operation(value, factor(), symbol);
      }
      return value;
    };
    const sum = (): Value => {
      let value = product();
      while (tokens[index] === '+' || tokens[index] === '-') {
        const symbol = tokens[index++]!; value = operation(value, product(), symbol);
      }
      return value;
    };
    const result = sum(); expect(index).toBe(tokens.length); return result;
  };
  for (const match of source.matchAll(/vec2\s+(\w+)\s*=\s*([^;]+);/g)) values[match[1]!] = evaluate(match[2]!);
  const components = /gl_Position\s*=\s*vec4\(([\s\S]*?)\);/.exec(source)?.[1]?.split(',');
  expect(components).toHaveLength(4);
  const x = evaluate(components![0]!) as number, y = evaluate(components![1]!) as number;
  const viewport = gl.viewport.mock.lastCall!;
  return [(x + 1) * (viewport[2] as number) / 2, (1 - y) * (viewport[3] as number) / 2];
}

afterEach(() => vi.restoreAllMocks());

describe('Canvas coefficient mapping into an independently rounded GPU backing', () => {
  it.each([1, 1.2, 1.25, 1.5, 1.75, 2, 3])('preserves logical corners, edge offsets, fixed weights and edit caches at DPR %s', (dpr) => {
    const state = scene(), after = edit(state, shifted), camera = { ...view, width: 1218, height: 553, dpr, scale: 10 };
    const { renderer, gl, canvas } = rendererFixture(), prepare = vi.spyOn(geometry, 'prepareZoom2D');
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, uploadKind: 'full' });
    const backing = [Math.round(camera.width * dpr), Math.round(camera.height * dpr)], nativeDPR = Math.fround(dpr);
    expect([canvas.width, canvas.height]).toEqual(backing);
    expect(gl.uniform2f).toHaveBeenCalledWith({ name: 'u_view' }, camera.width, camera.height);
    expect(gl.uniform2f).toHaveBeenCalledWith({ name: 'u_backing' }, ...backing);
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_nativeDPR' }, nativeDPR);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, ...backing);
    for (const [x, y] of [[0, 0], [camera.width, 0], [0, camera.height], [camera.width, camera.height], [camera.width / 2, camera.height / 2], [camera.width - 0.5, camera.height - 0.5]]) {
      const actual = shaderPhysicalPoint(gl, [x! - camera.width / 2, y! - camera.height / 2]);
      // Canvas first casts its path arguments, then applies its float scale.
      expect(Math.abs(actual[0] - Math.fround(x!) * nativeDPR)).toBeLessThan(1 / 64);
      expect(Math.abs(actual[1] - Math.fround(y!) * nativeDPR)).toBeLessThan(1 / 64);
    }
    if (dpr === 1.25) {
      expect(backing[0]! - camera.width * nativeDPR).toBe(0.5);
      expect(shaderPhysicalPoint(gl, [camera.width / 2, 0])[0]).toBeCloseTo(1522.5, 3);
    }
    const original = gl.vertices.slice(), current = { ...camera, scale: 11, center: { x: -1, y: 1 } };
    expect(renderer.render(state, current, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(gl.vertices).toEqual(original);
    const reference = (world: { x: number; y: number }, cssOffsetY = 0) => [Math.fround(current.width / 2 + (world.x - current.center.x) * current.scale) * nativeDPR, Math.fround(current.height / 2 - (world.y - current.center.y) * current.scale + cssOffsetY) * nativeDPR];
    const beforeEdit = shaderPhysicalPoint(gl, [-30, -10], [0, 1]), expectedBefore = reference(line.a, 1);
    beforeEdit.forEach((value, axis) => expect(Math.abs(value - expectedBefore[axis]!)).toBeLessThan(1 / 64));
    const above = shaderPhysicalPoint(gl, [-30, -10], [0, -1]);
    expect(Math.abs(beforeEdit[1] - above[1] - 2 * nativeDPR)).toBeLessThan(1 / 64);
    expect(renderer.render(after, current, overlay)).toMatchObject({ rendered: true, uploadKind: 'subrange', bytes: 168, preparedEntities: 1 });
    const afterEdit = shaderPhysicalPoint(gl, [-30, -12.5], [0, 1]), expectedAfter = reference(shifted.a, 1);
    afterEdit.forEach((value, axis) => expect(Math.abs(value - expectedAfter[axis]!)).toBeLessThan(1 / 64));
    expect(prepare).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['u_backing', 'u_nativeDPR'])('keeps the complete view on Canvas when the required %s binding is unavailable', (name) => {
    const { renderer, gl } = rendererFixture();
    gl.getUniformLocation.mockImplementation((_program, requested) => requested === name ? null : { name: requested });
    for (let i = 0; i < 2; i++) expect(renderer.render(scene(), view, overlay)).toMatchObject({ rendered: false, reason: 'WebGL2 stroke shader uniforms unavailable', uploadKind: 'none', bytes: 0 });
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('reacquires physical backing and native coefficient uniforms after context restoration', () => {
    const { renderer, gl, canvas } = rendererFixture(), state = scene(), first = { ...view, width: 1218, height: 553, dpr: 1.25 };
    expect(renderer.render(state, first, overlay).rendered).toBe(true);
    gl.isContextLost.mockReturnValue(true); canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    gl.isContextLost.mockReturnValue(false); canvas.dispatchEvent(new Event('webglcontextrestored'));
    const next = { ...first, width: 1221, height: 555, dpr: 1.2 };
    expect(renderer.render(state, next, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', cacheHit: false });
    expect(gl.getUniformLocation.mock.calls.filter((call) => call[1] === 'u_backing')).toHaveLength(2);
    expect(gl.getUniformLocation.mock.calls.filter((call) => call[1] === 'u_nativeDPR')).toHaveLength(2);
    expect(gl.uniform2f).toHaveBeenCalledWith({ name: 'u_backing' }, Math.round(next.width * next.dpr), Math.round(next.height * next.dpr));
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_nativeDPR' }, Math.fround(next.dpr));
    const actual = shaderPhysicalPoint(gl, [next.width / 2, next.height / 2]);
    expect(Math.abs(actual[0] - next.width * Math.fround(next.dpr))).toBeLessThan(1 / 64);
    expect(Math.abs(actual[1] - next.height * Math.fround(next.dpr))).toBeLessThan(1 / 64);
    renderer.dispose();
  });
});

describe('renderer uses only the actually certified straight compiled zoom interval', () => {
  it.each([1, 2, 3])('keeps the original rotated compound view on complete Canvas at DPR %s', (dpr) => {
    const state = scene(), camera = { ...originalRotatedView, dpr }, original = JSON.stringify(state), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    const cold = renderer.render(state, camera, overlay);
    expect(cold).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved', cacheMaxRatio: null, cacheHit: false, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: false, reason: cold.reason, cacheReason: 'refusal-hit', geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(prepare).toHaveBeenCalledOnce(); expect(JSON.stringify(state)).toBe(original);
    for (const method of [gl.createShader, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 2, 3])('reuses a certified straight mesh through zoom 4 and genuinely prepares beyond its boundary, DPR %s', (dpr) => {
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), state = scene(), camera = { ...view, dpr }, { renderer, gl } = rendererFixture();
    const cold = renderer.render(state, camera, overlay);
    expect(cold).toMatchObject({ rendered: true, cacheMinRatio: 0.8, cacheMaxRatio: geometry.GPU_STRAIGHT_ZOOM_CACHE_MAX_RATIO, uploadKind: 'full' });
    expect(prepare.mock.calls[0]![6]).toEqual({ certifyStraightZoomIn: true });
    const original = gl.vertices.slice(), prepared = prepare.mock.results[0]!.value as PreparedZoom2D;
    const batches = structuredClone(prepared.batches);
    for (const ratio of [1.3, 1.6, 1.02 ** 30, 2.5, 4]) {
      expect(renderer.render(state, { ...camera, scale: camera.scale * ratio }, overlay)).toMatchObject({ rendered: true, cacheHit: true, cacheReason: 'hit', cacheMaxRatio: cold.cacheMaxRatio, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      expect(gl.vertices).toEqual(original); expect(prepared.batches).toEqual(batches);
      expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_zoom' }, ratio);
    }
    expect(prepare).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce();
    const beyond = renderer.render(state, { ...camera, scale: camera.scale * cold.cacheMaxRatio! * 1.001 }, overlay);
    expect(beyond).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'zoom-range', uploadKind: 'full', editHistoryEntries: 0 });
    expect(prepare).toHaveBeenCalledTimes(2); expect(gl.bufferData).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('reports a QTEXT-narrowed actual interval and prepares the glyph transition instead of claiming a warm hit', () => {
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), state = scene({ entities: [text({ height: 0.1 }), line] }), camera = { ...view, scale: 20 }, { renderer, gl } = rendererFixture();
    const first = renderer.render(state, camera, overlay);
    expect(first.rendered).toBe(true); expect(first.cacheMaxRatio).toBeLessThan(1.25); expect(first.cacheMaxRatio).toBeGreaterThan(1.2);
    const placeholder = gl.vertices.slice();
    expect(renderer.render(state, { ...camera, scale: camera.scale * 1.2 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', cacheMaxRatio: first.cacheMaxRatio });
    expect(renderer.render(state, { ...camera, scale: camera.scale * 1.3 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'zoom-range', uploadKind: 'full' });
    expect(prepare).toHaveBeenCalledTimes(2); expect(gl.vertices.length).toBeGreaterThan(placeholder.length);
    renderer.dispose();
  });

  it('falls back to the weaker safe interval after a real typed stronger source certificate failure', () => {
    const origin = { x: 5e12, y: -5e12 }, camera = { ...view, center: origin, scale: 1, dpr: 3 };
    const state = scene({ entities: [text({ position: { x: origin.x - 4, y: origin.y + 4 }, height: 4 }), { ...line, a: { x: origin.x - 32, y: origin.y }, b: { x: origin.x + 32, y: origin.y } }], blocks: {} });
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene'), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    const first = renderer.render(state, camera, overlay);
    expect(first).toMatchObject({ rendered: true, cacheMaxRatio: 1.25, uploadKind: 'full' });
    expect(prepare).toHaveBeenCalledOnce(); expect(lower).toHaveBeenCalledTimes(2);
    const stronger = lower.mock.results[0]!.value as strokeScene.LoweredStrokeScene;
    expect(stronger.ok).toBe(false);
    if (stronger.ok) throw new Error('Expected a stronger source precision failure');
    expect(isSourcePrecisionCertificateError(stronger.cause)).toBe(true);
    expect(lower.mock.calls.map((call) => call[3]?.maxRatio)).toEqual([4, 1.25]);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(renderer.render(state, { ...camera, scale: 1.2 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', cacheMaxRatio: 1.25 });
    expect(renderer.render(state, { ...camera, scale: 1.3 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full' });
    renderer.dispose();
  });

  it('keeps the weaker Float32-safe range when the larger numeric certificate cannot pass', () => {
    const state = scene(), camera = { ...view, width: 4000, height: 1000, dpr: 4 }, prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer } = rendererFixture();
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 1.25 });
    expect(renderer.render(state, { ...camera, scale: camera.scale * 1.2 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    expect(renderer.render(state, { ...camera, scale: camera.scale * 1.3 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full' });
    expect(prepare).toHaveBeenCalledTimes(2); renderer.dispose();
  });

  it.each(['line', 'arc', 'circle', 'curved-compound', 'unsealed', 'mutable'] as const)('preserves scoped immutable/ordinary behavior for %s controls', (kind) => {
    const curve: Entity = kind === 'circle' ? { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 2 }
      : { ...line, type: 'arc', center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: 1 };
    const base = kind === 'line' ? scene({ entities: [line] }) : kind === 'arc' || kind === 'circle' ? scene({ entities: [curve] }) : kind === 'curved-compound' ? scene({ entities: [text(), curve] }) : scene();
    const state = kind === 'mutable' ? structuredClone(base) : kind === 'unsealed' ? { ...base } : base;
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer } = rendererFixture();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: kind === 'mutable' ? 1 : kind === 'line' ? 4 : 1.25 });
    if (kind === 'line') expect(referencePrepare(state, view, overlay).maxRatio).toBe(1.25);
    if (kind === 'mutable') expect(prepare.mock.calls[0]!.slice(3)).toEqual([1, 1, 0]);
    if (kind === 'unsealed') expect(prepare.mock.calls[0]).toHaveLength(3);
    expect(renderer.render(state, { ...view, scale: view.scale * 1.3 }, overlay)).toMatchObject({ rendered: true, cacheHit: kind === 'line', uploadKind: kind === 'line' ? 'none' : 'full' });
    expect(prepare).toHaveBeenCalledTimes(kind === 'line' ? 1 : 2);
    renderer.dispose();
  });

  it('leaves a default compiled geometry call at 1.25 when no opt-in was requested', () => {
    expect(referencePrepare(scene(), view, overlay).maxRatio).toBe(1.25);
  });

  it('keeps LINE delta history and the full source mesh at its original extended anchor', () => {
    const state = scene(), after = edit(state, shifted), prepare = vi.spyOn(geometry, 'prepareZoom2D'), { renderer, gl } = rendererFixture();
    const first = renderer.render(state, view, overlay), original = gl.vertices.slice();
    expect(first.cacheMaxRatio).toBe(4);
    expect(renderer.render(after, { ...view, scale: view.scale * 2.5 }, overlay)).toMatchObject({ rendered: true, cacheReason: 'document-delta', cacheMaxRatio: 4, uploadKind: 'subrange', bytes: 168, preparedEntities: 1 });
    expect(gl.vertices).toEqual(referencePrepare(after, view, overlay).vertices);
    expect(renderer.render(state, { ...view, scale: view.scale * 4 }, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4, editMemoHit: true, uploadKind: 'subrange', preparedEntities: 0 });
    expect(gl.vertices).toEqual(original); expect(prepare).toHaveBeenCalledOnce();
    expect(renderer.render(state, { ...view, scale: view.scale * 4.01 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full', editHistoryEntries: 0 });
    expect(prepare).toHaveBeenCalledTimes(2); renderer.dispose();
  });

  it('never patches a replacement certified only through 1.25 into the retained 4 interval', () => {
    const camera = { ...view, width: 1216, height: 552, scale: 1, dpr: 1, twist: 0, lineweights: true };
    const initial: LineEntity = { ...line, a: { x: 400, y: 0 }, b: { x: 450, y: 0 }, lineWeight: 4 };
    const replacement: LineEntity = { ...initial, b: { x: 400.075, y: 0 } };
    const before = scene({ entities: [text({ height: 4 }), initial], blocks: {} }), after = edit(before, replacement);
    const { renderer, gl } = rendererFixture(), full = vi.spyOn(geometry, 'prepareZoom2D'), partial = vi.spyOn(geometry, 'prepareZoomLine');
    expect(renderer.render(before, camera, overlay)).toMatchObject({ rendered: true, cacheMaxRatio: 4, uploadKind: 'full' });
    const original = gl.vertices.slice(), prepared = full.mock.results[0]!.value as PreparedZoom2D;
    expect(geometry.prepareZoomLine(replacement, after, camera, overlay, prepared.extent, 1.25).vertices.length).toBeGreaterThan(0);
    expect(() => geometry.prepareZoomLine(replacement, after, camera, overlay, prepared.extent, 4)).toThrow('native float point, normal or miter exceeds precision budget');
    partial.mockClear();
    const current = renderer.render(after, camera, overlay);
    expect(partial).toHaveBeenCalledExactlyOnceWith(replacement, after, expect.objectContaining({ scale: 1, twist: 0 }), overlay, prepared.extent, 4);
    expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(current.uploadKind).not.toBe('subrange'); expect(current.cacheHit).toBe(false);
    if (current.rendered) {
      expect(current).toMatchObject({ cacheMaxRatio: 1.25, uploadKind: 'full' });
      expect(gl.vertices).toEqual(referencePrepare(after, camera, overlay).vertices);
      const enlarged = renderer.render(after, { ...camera, scale: 4 }, overlay);
      expect(enlarged.cacheHit).toBe(false); expect(enlarged.uploadKind).not.toBe('subrange');
    } else {
      expect(current).toMatchObject({ uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      expect(gl.vertices).toEqual(original);
    }
    expect(full).toHaveBeenCalledTimes(current.rendered ? 3 : 2);
    renderer.dispose();
  });

  it.each(['layers', 'block', 'font-style', 'linetypes', 'text', 'overlay'] as const)('fully invalidates the extended certificate after %s changes', (kind) => {
    const before = scene(), afterLine = edit(before, shifted), { renderer, gl } = rendererFixture();
    renderer.render(before, view, overlay); renderer.render(afterLine, { ...view, scale: 60 }, overlay);
    let after = afterLine;
    if (kind === 'layers') after = sealImmutableData({ ...afterLine, layers: [{ ...layer, color: 4 }] });
    if (kind === 'block') after = sealImmutableData({ ...afterLine, blocks: { B: { ...block, entities: [...block.entities] } } });
    if (kind === 'font-style') after = sealImmutableData({ ...afterLine, meta: { textStyles: { Standard: { ...STANDARD_TEXT_STYLE, widthFactor: 1.1 } } } });
    if (kind === 'linetypes') after = sealImmutableData({ ...afterLine, header: { ...afterLine.header!, linetypes: [...afterLine.header!.linetypes!] } });
    if (kind === 'text') after = sealImmutableData({ ...afterLine, entities: [text({ text: 'Z' }), ...afterLine.entities.slice(1)] });
    const selected = kind === 'overlay' ? { selection: new Set(['target']), solidSelection: true } : overlay;
    expect(renderer.render(after, { ...view, scale: 60 }, selected)).toMatchObject({ rendered: true, cacheHit: false, uploadKind: 'full', editMemoHit: false, editHistoryEntries: 0 });
    expect(gl.bufferData).toHaveBeenCalledTimes(2); renderer.dispose();
  });

  it.each(['subrange', 'draw', 'loss'] as const)('repairs the complete current mesh after %s failure within the extended interval', (failure) => {
    const before = scene(), after = edit(before, shifted), { renderer, gl, canvas } = rendererFixture();
    renderer.render(before, view, overlay);
    if (failure === 'subrange') gl.getError.mockReturnValueOnce(gl.OUT_OF_MEMORY);
    if (failure === 'draw') gl.getError.mockReturnValueOnce(0).mockReturnValueOnce(gl.OUT_OF_MEMORY);
    if (failure === 'loss') gl.bufferSubData.mockImplementationOnce(() => { gl.isContextLost.mockReturnValue(true); canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
    const camera = { ...view, scale: 60 };
    expect(renderer.render(after, camera, overlay)).toMatchObject({ rendered: false, uploadKind: 'subrange' });
    if (failure === 'loss') { gl.isContextLost.mockReturnValue(false); canvas.dispatchEvent(new Event('webglcontextrestored')); }
    expect(renderer.render(after, camera, overlay)).toMatchObject({ rendered: true, uploadKind: 'full', subrangeUploadCalls: 0 });
    const expected = referencePrepare(after, failure === 'loss' ? camera : view, overlay);
    expect(gl.vertices).toEqual(expected.vertices); expect(gl.bufferData).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it.each(['positive-direct', 'positive-compound', 'negative-direct', 'degenerate-compound'] as const)('memoizes an owned %s topology refusal without weaker admission or disturbing the healthy mesh', (kind) => {
    const baseline = scene({ entities: [line] }), { renderer, gl } = rendererFixture();
    expect(renderer.render(baseline, view, overlay).rendered).toBe(true);
    const path: PolylineEntity = kind === 'degenerate-compound'
      ? { ...line, id: 'native-path', type: 'polyline', closed: false, points: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }
      : { ...line, id: 'native-path', type: 'polyline', closed: false, points: [{ x: -2, y: 0 }, { x: 2, y: 0 }], bulges: [kind === 'negative-direct' ? -1 : 1] };
    const compound = kind.endsWith('compound');
    const state = compound ? scene({ entities: [text(), owner], blocks: { B: { ...block, entities: [path] } } }) : scene({ entities: [line, path], blocks: {} });
    const original = JSON.stringify(state), retained = gl.vertices.slice();
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    const first = renderer.render(state, view, overlay);
    const reason = kind === 'degenerate-compound' ? 'Unsupported Canvas stroke construction: internal degenerate join is unproved'
      : `Unsupported Canvas stroke construction: ${kind === 'negative-direct' ? 'negative bulge has native connector' : 'native float arc connection is unproved'} (native-path)`;
    expect(first).toMatchObject({ rendered: false, reason, cacheHit: false, cacheMinRatio: null, cacheMaxRatio: null, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    const failure = prepare.mock.results[0]!.value as Error;
    const originalCause = compound ? failure.cause : failure;
    expect(isSourceTopologyAdmissionError(originalCause)).toBe(true);
    expect(isSourcePrecisionCertificateError(originalCause)).toBe(false);
    expect(lower).toHaveBeenCalledTimes(compound ? 1 : 0);
    if (compound) expect(lower.mock.calls[0]![3]?.maxRatio).toBe(4);
    for (let i = 0; i < 3; i++) {
      expect(renderer.render(state, { ...view, center: { ...view.center } }, { selection: new Set() })).toMatchObject({ rendered: false, reason, cacheReason: 'refusal-hit', cacheHit: false, cacheMinRatio: null, cacheMaxRatio: null, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    }
    expect(prepare).toHaveBeenCalledOnce(); expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.vertices).toEqual(retained); expect(JSON.stringify(state)).toBe(original);
    expect(renderer.render(baseline, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    renderer.dispose();
  });

  it.each([
    new Error('Canvas world-coordinate quantization exceeds TEXT precision budget (label)'),
    new TypeError('Canvas world-coordinate quantization exceeds TEXT precision budget (label)'),
    new RangeError('Unsupported Canvas stroke construction: point, normal or miter exceeds precision budget'),
    new Error('Unsupported Canvas stroke construction: point, normal or miter exceeds precision budget'),
    new Error('Unsupported Canvas stroke construction: negative bulge has native connector'),
    new Error('Unsupported Canvas stroke construction: native float arc connection is unproved'),
    new Error('Unsupported Canvas stroke construction: internal degenerate join is unproved'),
    new Error('Unexpected glyph lookup failure'),
  ])('does not downgrade or memoize an unexpected native/glyph exception, even with matching precision wording: %s', (error) => {
    const baseline = scene({ entities: [line] }), state = scene(), { renderer, gl } = rendererFixture();
    renderer.render(baseline, view, overlay);
    const prepare = vi.spyOn(geometry, 'prepareZoom2D'), lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    vi.spyOn(hershey, 'glyphFor').mockImplementation(() => { throw error; });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    for (let i = 0; i < 3; i++) {
      expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: error.message, cacheMinRatio: null, cacheMaxRatio: null, uploadKind: 'none', bytes: 0 });
      expect(prepare.mock.calls.length).toBe(i + 1); expect(lower.mock.calls.length).toBe(i + 1);
    }
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(renderer.render(baseline, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    renderer.dispose();
  });
});
