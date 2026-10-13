import { describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { colorDisplay, lineweightDisplay } from '../src/render/draw';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { strokeText } from '../src/render/hershey';
import { prepare2D, prepareCompiledZoom2D, prepareZoom2D, screenPoint, GPU_ZOOM_VERTEX_STRIDE, type Gpu2DView, type Prepared2D } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const polyline: PolylineEntity = { id: 'polyline', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: -2, y: 0 }, { x: 2, y: 0 }], closed: false };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[] = [line], layers: readonly Layer[] = [layer]): DrawingState => ({ entities, layers, blocks: {}, currentLayer: '0' });

function xy(geometry: Prepared2D): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < geometry.vertices.length; i += 5) points.push({ x: geometry.vertices[i]!, y: geometry.vertices[i + 1]! });
  return points;
}

/** Test coverage of the uploaded triangles, independently of the stroking implementation. */
function covers(geometry: Prepared2D, point: Point): boolean {
  const points = xy(geometry);
  const cross = (a: Point, b: Point) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  for (let i = 0; i < points.length; i += 3) {
    const a = points[i]!, b = points[i + 1]!, c = points[i + 2]!;
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-8) continue;
    const signs = [cross(a, b), cross(b, c), cross(c, a)];
    if (signs.every((value) => value >= -1e-5) || signs.every((value) => value <= 1e-5)) return true;
  }
  return false;
}

function rendererFixture() {
  let serial = 0;
  const handle = () => ({ serial: ++serial });
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
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn((_target: number, _data: BufferSource, _usage: number) => {}), deleteBuffer: vi.fn(),
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn((_uniform: unknown, _x: number, _y: number) => {}), uniform1f: vi.fn((_uniform: unknown, _value: number) => {}),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(),
    stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; },
    get drawingBufferHeight(): number { return canvas.height; },
  };
  const events = new EventTarget();
  const getContext = vi.fn((): WebGL2RenderingContext | null => gl as unknown as WebGL2RenderingContext);
  const canvas = Object.assign(events, { getContext, width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  return { gl, canvas, getContext };
}

function uploadedGeometry(gl: ReturnType<typeof rendererFixture>['gl']): Prepared2D {
  const size = [...gl.uniform2f.mock.calls].reverse().find((call) => (call[0] as { name: string }).name === 'u_view')!;
  return zoomToScreen(gl.bufferData.mock.lastCall![1] as Float32Array<ArrayBuffer>, { width: size[1], height: size[2] });
}

/** Emulate the actual shader's Float32 center, zoom, pan and fixed-offset arithmetic. */
function zoomToScreen(source: Float32Array<ArrayBuffer>, size: { width: number; height: number }, ratio = 1, pan: Point = { x: 0, y: 0 }): Prepared2D {
  const vertices = new Float32Array(source.length / GPU_ZOOM_VERTEX_STRIDE * 5);
  for (let i = 0, j = 0; i < source.length; i += GPU_ZOOM_VERTEX_STRIDE, j += 5) {
    vertices[j] = Math.fround(Math.fround(Math.fround(Math.fround(source[i]! * Math.fround(ratio)) + Math.fround(pan.x)) + Math.fround(size.width / 2)) + source[i + 2]!);
    vertices[j + 1] = Math.fround(Math.fround(Math.fround(Math.fround(source[i + 1]! * Math.fround(ratio)) + Math.fround(pan.y)) + Math.fround(size.height / 2)) + source[i + 3]!);
    vertices.set(source.subarray(i + 4, i + 7), j + 2);
  }
  return { vertices, batches: [], panPrecisionMargin: { x: 0, y: 0 } };
}

function drawnGeometry(gl: ReturnType<typeof rendererFixture>['gl']): Prepared2D {
  const size = [...gl.uniform2f.mock.calls].reverse().find((call) => (call[0] as { name: string }).name === 'u_view')!;
  const pan = [...gl.uniform2f.mock.calls].reverse().find((call) => (call[0] as { name: string }).name === 'u_pan')!;
  const zoom = [...gl.uniform1f.mock.calls].reverse().find((call) => (call[0] as { name: string }).name === 'u_zoom')!;
  return zoomToScreen(gl.bufferData.mock.lastCall![1] as Float32Array<ArrayBuffer>, { width: size[1], height: size[2] }, zoom[1], { x: pan[1], y: pan[2] });
}

/** Include shader NDC arithmetic and the viewport roundtrip when checking geometric error. */
function ndcGeometry(geometry: Prepared2D, size: { width: number; height: number }): Prepared2D {
  const vertices = geometry.vertices.slice();
  for (let i = 0; i < vertices.length; i += 5) {
    const x = Math.fround(Math.fround(Math.fround(vertices[i]! / Math.fround(size.width)) * 2) - 1);
    const y = Math.fround(1 - Math.fround(Math.fround(vertices[i + 1]! / Math.fround(size.height)) * 2));
    vertices[i] = (x + 1) * size.width / 2;
    vertices[i + 1] = (1 - y) * size.height / 2;
  }
  return { ...geometry, vertices };
}

/** Simulate Float32 vertex-shader translation for independent coverage/precision assertions. */
function translatedGeometry(geometry: Prepared2D, pan: Point): Prepared2D {
  const vertices = geometry.vertices.slice();
  for (let i = 0; i < vertices.length; i += 5) {
    vertices[i] = Math.fround(vertices[i]! + Math.fround(pan.x));
    vertices[i + 1] = Math.fround(vertices[i + 1]! + Math.fround(pan.y));
  }
  return { ...geometry, vertices };
}

describe('GPU double-precision preparation', () => {
  it('preserves subpixel endpoints at trillion-unit coordinates and close zoom', () => {
    const delta = 1 / 8192; // A representable displacement at 1e12.
    const origin = { x: 1e12, y: -1e12 };
    const local: LineEntity = { ...line, a: { x: -1 / 32, y: delta }, b: { x: 1 / 32, y: delta } };
    const translated: LineEntity = { ...local, a: { x: origin.x + local.a.x, y: origin.y + local.a.y }, b: { x: origin.x + local.b.x, y: origin.y + local.b.y } };
    const close = { ...view, scale: 1024, twist: 0.63 };
    const baseline = prepare2D(drawing([local]), close, overlay);
    const shifted = prepare2D(drawing([translated]), { ...close, center: origin }, overlay);
    expect(shifted.vertices).toEqual(baseline.vertices);
    expect(covers(shifted, screenPoint(translated.a, { ...close, center: origin }))).toBe(true);
    // The world coordinates themselves would collapse if packed before rebasing.
    expect(new Float32Array([translated.a.x, translated.b.x])[0]).toBe(new Float32Array([translated.a.x, translated.b.x])[1]);
  });

  it('rebases circle centers and bulge helpers before adding small curve offsets', () => {
    const origin = { x: 1e12, y: -1e12 };
    const small = { ...view, scale: 1024, twist: 0.2 };
    const circle: Entity = { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 1 / 32 };
    const curved: PolylineEntity = { ...polyline, points: [{ x: -1 / 32, y: 0 }, { x: 1 / 32, y: 0 }], bulges: [0.6] };
    const translated = [
      { ...circle, center: origin },
      { ...curved, points: curved.points.map((point) => ({ x: origin.x + point.x, y: origin.y + point.y })) },
    ];
    expect(prepare2D(drawing(translated), { ...small, center: origin }, overlay).vertices).toEqual(prepare2D(drawing([circle, curved]), small, overlay).vertices);
  });

  it('matches viewport twist, center and Y-up coordinates', () => {
    const rotated = { ...view, center: { x: 10, y: 20 }, twist: Math.PI / 2, scale: 4 };
    expect(screenPoint({ x: 12, y: 20 }, rotated).x).toBeCloseTo(160);
    expect(screenPoint({ x: 12, y: 20 }, rotated).y).toBeCloseTo(112);
    expect(screenPoint({ x: 10, y: 22 }, rotated).x).toBeCloseTo(152);
  });

  it('clips remote endpoints in doubles before Float32 packing', () => {
    const geometry = prepare2D(drawing([{ ...line, a: { x: -1e9, y: 0 }, b: { x: 1e9, y: 0 } }]), view, overlay);
    expect(covers(geometry, { x: 160, y: 120 })).toBe(true);
    for (const point of xy(geometry)) {
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(view.width);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(view.height);
    }
  });

  it('refuses extreme projected endpoints before subpixel stroke offsets lose precision', () => {
    const extreme = drawing([{ ...line, a: { x: -1e9, y: -1e9 }, b: { x: 1e9, y: 1e9 } }]);
    const close = { ...view, scale: 1e6 };
    expect(() => prepare2D(extreme, close, overlay)).toThrow(/stroke precision bound/);
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(extreme, close, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('precision bound'), submissionMs: 0, bytes: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });
});

describe('GPU curves and triangle strokes', () => {
  it.each([1, -1])('preserves the signed direction of semicircle bulge %i', (bulge) => {
    const geometry = prepare2D(drawing([{ ...polyline, bulges: [bulge] }]), view, overlay);
    expect(covers(geometry, screenPoint({ x: 0, y: -2 * bulge }, view))).toBe(true);
    expect(covers(geometry, screenPoint({ x: 0, y: 2 * bulge }, view))).toBe(false);
    expect(covers(geometry, screenPoint({ x: 0, y: 0 }, view))).toBe(false);
  });

  it('keeps both arcs of a closed two-vertex polyline', () => {
    const geometry = prepare2D(drawing([{ ...polyline, closed: true, bulges: [1, 1] }]), view, overlay);
    expect(covers(geometry, screenPoint({ x: 0, y: -2 }, view))).toBe(true);
    expect(covers(geometry, screenPoint({ x: 0, y: 2 }, view))).toBe(true);
  });

  it('tessellates a wrapped CCW arc and treats equal angles as a full circle', () => {
    const arc: Entity = { ...line, type: 'arc', center: { x: 0, y: 0 }, radius: 2, startAngle: Math.PI * 1.5, endAngle: Math.PI * 0.5 };
    const geometry = prepare2D(drawing([arc]), view, overlay);
    expect(covers(geometry, screenPoint({ x: 2, y: 0 }, view))).toBe(true);
    expect(covers(geometry, screenPoint({ x: -2, y: 0 }, view))).toBe(false);
    const full = prepare2D(drawing([{ ...arc, endAngle: arc.startAngle }]), view, overlay);
    expect(covers(full, screenPoint({ x: -2, y: 0 }, view))).toBe(true);
  });

  it('increases tessellation with zoom and DPI while keeping curve error within a physical pixel', () => {
    const circle: Entity = { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 2 };
    const coarse = prepare2D(drawing([circle]), { ...view, scale: 10 }, overlay);
    const fineView = { ...view, scale: 30, dpr: 4 };
    const fine = prepare2D(drawing([circle]), fineView, overlay);
    expect(fine.vertices.length).toBeGreaterThan(coarse.vertices.length);
    // Independently sample the true circle. The mesh must cover its entire centerline,
    // while points beyond stroke width + 0.25 physical pixels must stay outside.
    for (let i = 0; i < 180; i++) {
      const angle = i * Math.PI * 2 / 180;
      expect(covers(fine, screenPoint({ x: 2 * Math.cos(angle), y: 2 * Math.sin(angle) }, fineView))).toBe(true);
      const beyond = 2 + (0.5 + 0.25 / fineView.dpr + 0.01) / fineView.scale;
      expect(covers(fine, screenPoint({ x: beyond * Math.cos(angle), y: beyond * Math.sin(angle) }, fineView))).toBe(false);
    }
  });

  it('fills miter joins, uses butt ends, and handles repeated and degenerate vertices', () => {
    const corner: PolylineEntity = { ...polyline, points: [{ x: -2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 }], lineWeight: 1 };
    const geometry = prepare2D(drawing([corner]), { ...view, lineweights: true }, overlay);
    expect(covers(geometry, { x: 161.5, y: 121.5 })).toBe(true);
    expect(covers(geometry, { x: 98, y: 120 })).toBe(false);
    expect(prepare2D(drawing([{ ...line, b: line.a }]), view, overlay).vertices).toHaveLength(0);
    const repeated = { ...corner, points: [corner.points[0]!, corner.points[0]!, ...corner.points.slice(1)] };
    expect(prepare2D(drawing([repeated]), { ...view, lineweights: true }, overlay).vertices).toEqual(geometry.vertices);
  });
});

describe('CAD appearance and strict fallback', () => {
  it('inherits layer RGB, entity true color, ACI and top-level ByBlock foreground', () => {
    const entities = [line, { ...line, id: 'rgb', trueColor: 0x123456 }, { ...line, id: 'aci', color: 1 }, { ...line, id: 'byblock', color: 0 }];
    const geometry = prepare2D(drawing(entities, [{ ...layer, trueColor: 0xabcdef }]), view, overlay);
    const colors = geometry.batches.map((batch) => Array.from(geometry.vertices.slice(batch.first * 5 + 2, batch.first * 5 + 5)));
    const expected = [[0xab, 0xcd, 0xef], [0x12, 0x34, 0x56], [255, 0, 0], [255, 255, 255]];
    colors.forEach((color, i) => color.forEach((channel, j) => expect(channel).toBeCloseTo(expected[i]![j]! / 255)));
  });

  it('uses layer visibility separately from inherited colorLayer', () => {
    const geometry = prepare2D(drawing([{ ...line, colorLayer: 'paint' }], [layer, { ...layer, name: 'paint', color: 1, visible: false }]), view, overlay);
    expect(geometry.vertices.slice(2, 5)).toEqual(new Float32Array([1, 0, 0]));
  });

  it('resolves fixed pixel lineweights and restores the shared Canvas settings', () => {
    const originalWeights = { ...lineweightDisplay }, originalPaper = colorDisplay.paper;
    lineweightDisplay.enabled = true; lineweightDisplay.pxPerMm = 12; colorDisplay.paper = true;
    try {
      const normal = prepare2D(drawing(), view, overlay);
      const weighted = prepare2D(drawing(), { ...view, lineweights: true }, overlay);
      const explicit = prepare2D(drawing([{ ...line, lineWeight: 1 }]), { ...view, lineweights: true }, overlay);
      const height = (geometry: Prepared2D) => Math.max(...xy(geometry).map((point) => point.y)) - Math.min(...xy(geometry).map((point) => point.y));
      expect(height(normal)).toBe(1); expect(height(weighted)).toBe(2); expect(height(explicit)).toBe(4);
      expect(lineweightDisplay).toEqual({ enabled: true, pxPerMm: 12 });
      expect(colorDisplay.paper).toBe(true);
    } finally { Object.assign(lineweightDisplay, originalWeights); colorDisplay.paper = originalPaper; }
  });

  it.each(['text', 'mtext', 'hatch', 'image', 'insert', 'ellipse', 'spline', 'dimension', 'leader', 'table', 'point', 'xline', 'ray'])('refuses full scenes with a layer-visible %s', (type) => {
    const unsupported = { ...line, type, id: 'unsupported' } as unknown as Entity;
    expect(() => prepare2D(drawing([line, unsupported]), view, overlay)).toThrow(`Unsupported entity: ${type}`);
  });

  it('ignores unsupported geometry and dashed selection on layers with visible:false', () => {
    const unsupported = { ...line, type: 'text', id: 'hidden', layer: 'hidden' } as unknown as Entity;
    const geometry = prepare2D(drawing([line, unsupported], [layer, { ...layer, name: 'hidden', visible: false }]), view, { selection: new Set(['hidden']) });
    expect(geometry.batches.map((batch) => batch.id)).toEqual(['line']);
  });

  it('matches legacy visibility after LAYON on an imported frozen layer', () => {
    const frozen = { ...layer, frozen: true, visible: true };
    expect(prepare2D(drawing([line], [frozen]), view, overlay).batches.map((batch) => batch.id)).toEqual(['line']);
    const text = { ...line, type: 'text', id: 'frozen-text' } as unknown as Entity;
    expect(() => prepare2D(drawing([line, text], [frozen]), view, overlay)).toThrow(/Unsupported entity: text/);
  });

  it.each([
    { linetype: 'DASHED' }, { transparency: 128 }, { transparency: 0 }, { annotative: true },
  ])('refuses unsupported line styles: %j', (style) => {
    expect(() => prepare2D(drawing([{ ...line, ...style }]), view, overlay)).toThrow(/Unsupported/);
  });

  it('detects layer/custom dashes and inherited transparency', () => {
    expect(() => prepare2D(drawing([line], [{ ...layer, linetype: 'HIDDEN' }]), view, overlay)).toThrow(/dashed/);
    expect(() => prepare2D(drawing([line], [{ ...layer, transparency: 200 }]), view, overlay)).toThrow(/transparency/);
    const custom = { ...drawing([{ ...line, linetype: 'custom' }]), header: { ...DEFAULT_HEADER, linetypes: [{ name: 'CUSTOM', description: '', pattern: [1, -1] }] } };
    expect(() => prepare2D(custom, view, overlay)).toThrow(/dashed/);
    expect(prepare2D(drawing([{ ...line, linetype: 'Continuous' }], [{ ...layer, linetype: 'DASHED' }]), view, overlay).batches).toHaveLength(1);
  });

  it.each([{ width: 1 }, { widths: [{ start: 1, end: 2 }] }, { filled: true }])('refuses polyline widths/fill: %j', (style) => {
    expect(() => prepare2D(drawing([{ ...polyline, ...style }]), view, overlay)).toThrow(/width|fill/);
  });

  it('refuses transformed width geometry and filled circles', () => {
    const widthFrame = { points: polyline.points, origin: { x: 0, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } };
    expect(() => prepare2D(drawing([{ ...polyline, widthFrame }]), view, overlay)).toThrow(/width/);
    expect(() => prepare2D(drawing([{ ...line, type: 'circle', center: { x: 0, y: 0 }, radius: 1, filled: true }]), view, overlay)).toThrow(/filled circle/);
  });

  it('refuses malformed geometry and excessive tessellation rather than omitting it', () => {
    expect(() => prepare2D(drawing([{ ...line, a: { x: NaN, y: 0 } }]), view, overlay)).toThrow(/Nonfinite/);
    expect(() => prepare2D(drawing([{ ...polyline, bulges: [NaN] }]), view, overlay)).toThrow(/bulge/);
    for (const radius of [-1, NaN, 1e12]) expect(() => prepare2D(drawing([{ ...line, type: 'circle', center: { x: 0, y: 0 }, radius }]), view, overlay)).toThrow(/radius|budget|geometry/);
    expect(() => prepare2D(drawing(), { ...view, scale: Infinity }, overlay)).toThrow(/view/);
  });

  it('preserves original selection/hover widths and opacity and falls back for dashed selection', () => {
    const state = drawing([line, { ...line, id: 'hover', a: { x: -2, y: 1 }, b: { x: 2, y: 1 } }]);
    expect(() => prepare2D(state, view, { selection: new Set(['line']), hover: 'hover' })).toThrow(/Dashed selection/);
    const geometry = prepare2D(state, view, { selection: new Set(['line']), hover: 'hover', solidSelection: true });
    expect(geometry.batches.map((batch) => batch.alpha)).toEqual([0.95, 0.95]);
    expect(covers(geometry, { x: 160, y: 121.2 })).toBe(true);
    expect(covers(geometry, { x: 160, y: 91.1 })).toBe(false);
  });
});

describe('GPU renderer submission, caching and lifecycle', () => {
  it('clears an opaque background, sizes the high-DPI backing store and submits triangles', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const result = renderer.render(drawing(), { ...view, dpr: 2 }, overlay);
    expect(result).toMatchObject({ rendered: true, bytes: 168 });
    expect(result.preparationMs).toBeGreaterThanOrEqual(0); expect(result.submissionMs).toBeGreaterThanOrEqual(0);
    expect(canvas.width).toBe(640); expect(canvas.height).toBe(480);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 640, 480);
    expect(gl.clearColor).toHaveBeenCalledWith(0x21 / 255, 0x28 / 255, 0x30 / 255, 1);
    expect(gl.drawArrays).toHaveBeenCalledExactlyOnceWith(gl.TRIANGLES, 0, 6);
    expect(gl.disable).toHaveBeenCalledWith(gl.DEPTH_TEST);
    renderer.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledOnce(); expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });

  it('coalesces contiguous opaque entities into one draw without changing their order', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = drawing(Array.from({ length: 300 }, (_, index) => ({ ...line, id: String(index), color: index % 2 + 1 })));
    expect(renderer.render(state, view, overlay).rendered).toBe(true);
    expect(gl.drawArrays).toHaveBeenCalledExactlyOnceWith(gl.TRIANGLES, 0, 1800);
    renderer.dispose();
  });

  it('caches immutable preparation/uploads and invalidates view, layer and selection changes', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing());
    expect(renderer.render(state, view, overlay).bytes).toBe(168);
    expect(renderer.render(state, { ...view }, { selection: new Set() }).bytes).toBe(0);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, overlay).bytes).toBe(0);
    const changedLayer = sealImmutableData({ ...state, layers: [{ ...layer, trueColor: 0xff0000 }] });
    expect(renderer.render(changedLayer, view, overlay).bytes).toBe(168);
    const selected = { selection: new Set(['line']), solidSelection: true };
    expect(renderer.render(changedLayer, view, selected).bytes).toBe(168);
    selected.selection.clear();
    expect(renderer.render(changedLayer, view, selected).bytes).toBe(168);
    renderer.dispose();
  });

  it('retains clipped border geometry so a warm pan can reveal previously offscreen strokes', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const entering: LineEntity = { ...line, a: { x: -6, y: -1 }, b: { x: -6, y: 1 } };
    const spanning: LineEntity = { ...line, id: 'spanning', a: { x: -1e6, y: 2 }, b: { x: 1e6, y: 2 } };
    const state = sealImmutableData(drawing([entering, spanning]));
    renderer.render(state, view, overlay);
    const geometry = uploadedGeometry(gl);
    expect(covers(geometry, { x: 10, y: 120 })).toBe(false);
    expect(renderer.render(state, { ...view, center: { x: -1, y: 0 } }, overlay).bytes).toBe(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 30, -0);
    const panned = translatedGeometry(geometry, { x: 30, y: 0 });
    expect(covers(panned, { x: 10, y: 120 })).toBe(true);
    expect(covers(panned, { x: 1, y: 60 })).toBe(true);
    expect(covers(panned, { x: 319, y: 60 })).toBe(true);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it('anchors cumulative pan bounds to copied camera values and resets translation on rebuild', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing());
    const camera = { ...view, center: { x: 0, y: 0 } };
    renderer.render(state, camera, overlay);
    for (const x of [-2, 0, -2, -4]) {
      camera.center.x = x;
      expect(renderer.render(state, camera, overlay).bytes).toBe(0);
      expect(gl.uniform2f.mock.lastCall![1]).toBeCloseTo(-x * view.scale, 12);
      expect(gl.uniform2f.mock.lastCall![2]).toBeCloseTo(0, 12);
    }
    camera.center.x = -6;
    expect(renderer.render(state, camera, overlay).bytes).toBeGreaterThan(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    camera.center.y = 6;
    expect(renderer.render(state, camera, overlay).bytes).toBeGreaterThan(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    renderer.dispose();
  });

  it.each([1, 2, 3])('rebases tiny pans at trillion-unit origins and preserves rotated curves at DPR %s', (dpr) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const center = { x: 1e12, y: -1e12 };
    const state = sealImmutableData(drawing([
      { ...line, a: { x: center.x - 1 / 32, y: center.y }, b: { x: center.x + 1 / 32, y: center.y }, lineWeight: 1 },
      { ...polyline, points: [{ x: center.x - 1 / 32, y: center.y }, { x: center.x + 1 / 32, y: center.y }], bulges: [0.6] },
    ]));
    const close = { ...view, center, scale: 1024, twist: 0.63, dpr, lineweights: true };
    renderer.render(state, close, overlay);
    const original = uploadedGeometry(gl);
    const moved = { ...close, center: { x: center.x + 1 / 8192, y: center.y - 1 / 4096 } };
    expect(renderer.render(state, moved, overlay).bytes).toBe(0);
    const pan = gl.uniform2f.mock.lastCall!;
    expect(pan[1]).toBeCloseTo((-Math.cos(close.twist) / 8 - Math.sin(close.twist) / 4), 12);
    expect(pan[2]).toBeCloseTo((Math.sin(close.twist) / 8 - Math.cos(close.twist) / 4), 12);
    const actual = translatedGeometry(original, { x: pan[1], y: pan[2] });
    const fresh = zoomToScreen(prepareZoom2D(state, moved, overlay).vertices, moved);
    expect(actual.vertices).toHaveLength(fresh.vertices.length);
    actual.vertices.forEach((value, index) => expect(value).toBeCloseTo(fresh.vertices[index]!, 3));
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['x', 'y'] as const)('reuses the exact physical border and rebuilds beyond it on the %s axis', (axis) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing());
    const unit = { ...view, scale: 1, dpr: 2 };
    renderer.render(state, unit, overlay);
    expect(renderer.render(state, { ...unit, center: { x: 0, y: 0, [axis]: -64 } }, overlay).bytes).toBe(0);
    expect(renderer.render(state, { ...unit, center: { x: 0, y: 0, [axis]: -64.5 } }, overlay).bytes).toBeGreaterThan(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    renderer.dispose();
  });

  it('reuses bounded zoom without scaling lineweights and rebuilds beyond the curve interval', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing([
      { ...line, lineWeight: 1 },
      { ...line, id: 'circle', type: 'circle', center: { x: 0, y: 0 }, radius: 1 },
    ]));
    const weighted = { ...view, lineweights: true };
    renderer.render(state, weighted, overlay);
    const initial = uploadedGeometry(gl);
    renderer.render(state, { ...weighted, center: { x: 0.25, y: 0 } }, overlay);
    expect(gl.uniform2f.mock.lastCall![1]).not.toBe(0);
    const bounded = renderer.render(state, { ...weighted, scale: 37.5 }, overlay);
    expect(bounded).toMatchObject({ rendered: true, bytes: 0, uploadCalls: 0, geometryPreparationMs: 0, cacheHit: true, cacheReason: 'hit' });
    const boundedGeometry = drawnGeometry(gl);
    expect(renderer.render(state, { ...weighted, scale: 60 }, overlay).bytes).toBeGreaterThan(0);
    const zoomed = uploadedGeometry(gl);
    const lineHeight = (geometry: Prepared2D) => {
      const points = xy({ ...geometry, vertices: geometry.vertices.slice(0, 30) });
      return Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
    };
    expect(lineHeight(initial)).toBe(4);
    expect(lineHeight(boundedGeometry)).toBe(4);
    expect(lineHeight(zoomed)).toBe(4);
    expect(zoomed.vertices.length).toBeGreaterThan(initial.vertices.length);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    renderer.dispose();
  });

  it.each([
    { width: 400 }, { height: 300 }, { dpr: 2 }, { twist: 0.4 }, { lineweights: true },
  ])('invalidates pan geometry for changed view properties: %j', (change) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing());
    renderer.render(state, view, overlay);
    renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, overlay);
    expect(renderer.render(state, { ...view, ...change }, overlay).bytes).toBeGreaterThan(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    renderer.dispose();
  });

  it('invalidates certified geometry, visibility, linetypes and hover before any cached pan', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData({ ...drawing(), header: { ...DEFAULT_HEADER, linetypes: [] } });
    renderer.render(state, view, overlay);
    const moved = { ...view, center: { x: 0.25, y: 0 } };
    const changed = sealImmutableData({ ...state, entities: [{ ...line, b: { x: 1, y: 0 } }] });
    expect(renderer.render(changed, moved, overlay).bytes).toBeGreaterThan(0);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    expect(renderer.render(changed, moved, { ...overlay, hover: 'line' }).bytes).toBeGreaterThan(0);
    const dashed = sealImmutableData({ ...changed, layers: [{ ...layer, linetype: 'custom' }], header: { ...DEFAULT_HEADER, linetypes: [{ name: 'custom', description: '', pattern: [1, -1] }] } });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(dashed, moved, overlay).reason).toMatch(/dashed/);
    const unsupported = { ...line, id: 'offscreen', type: 'mtext', a: { x: 1000, y: 1000 } } as unknown as Entity;
    expect(renderer.render(sealImmutableData({ ...changed, entities: [line, unsupported] }), moved, overlay).reason).toMatch(/Unsupported entity/);
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([NaN, Infinity, -Infinity])('refuses invalid camera centers on a warm cache: %s', (invalid) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing());
    renderer.render(state, view, overlay);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...view, center: { x: invalid, y: 0 } }, overlay)).toMatchObject({ rendered: false, bytes: 0, reason: expect.stringContaining('Invalid GPU view') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('rechecks offscreen source precision when a cached pan reaches the original coordinate bound', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const bound = 2 ** 36;
    const state = sealImmutableData(drawing([{ ...line, a: { x: 0, y: 0 }, b: { x: bound - view.width / 2 - 1, y: 0 } }]));
    const unit = { ...view, scale: 1 };
    expect(renderer.render(state, unit, overlay).rendered).toBe(true);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...unit, center: { x: -2, y: 0 } }, overlay)).toMatchObject({ rendered: false, bytes: 0, reason: expect.stringContaining('precision bound') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses an undersized drawing buffer without allocating or submitting GPU geometry', () => {
    const { canvas, gl } = rendererFixture();
    Object.defineProperty(gl, 'drawingBufferWidth', { get: () => 0 });
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(sealImmutableData(drawing()), view, overlay)).toMatchObject({ rendered: false, bytes: 0, reason: expect.stringContaining('drawing buffer') });
    expect(gl.createProgram).not.toHaveBeenCalled(); expect(gl.bufferData).not.toHaveBeenCalled();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('does not reuse identity caches for externally mutable geometry', () => {
    const { canvas } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const mutable = { ...line, b: { ...line.b } };
    const state = drawing([mutable]);
    renderer.render(state, view, overlay);
    mutable.b.x = 1;
    expect(renderer.render(state, view, overlay).bytes).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('refreshes mutable layer and custom-linetype data instead of reusing a warm camera cache', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const mutableLayer = { ...layer };
    const linetypes = [{ name: 'custom', description: '', pattern: [] as number[] }];
    const state = { ...drawing(sealImmutableData([{ ...line, linetype: 'custom' }]), [mutableLayer]), header: { ...DEFAULT_HEADER, linetypes } };
    renderer.render(state, view, overlay);
    mutableLayer.trueColor = 0xff0000;
    expect(renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, overlay).bytes).toBeGreaterThan(0);
    linetypes[0]!.pattern.push(1, -1);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, view, overlay).reason).toMatch(/dashed/);
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('makes unsupported full-scene refusal before clearing or submitting any geometry', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const text = { id: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'visible', height: 1, rotation: 0, align: 'left', bold: true } as const;
    const result = renderer.render(drawing([line, text]), view, overlay);
    expect(result).toMatchObject({ rendered: false, reason: expect.stringContaining('text'), submissionMs: 0, bytes: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.createProgram).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('renders solid selection through stencil once per entity, including self-intersections', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const bowtie: PolylineEntity = { ...polyline, points: [{ x: -2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }, { x: 2, y: -2 }] };
    const state = sealImmutableData(drawing([line, bowtie, { ...line, id: 'last' }]));
    const selected = { selection: new Set(['polyline']), solidSelection: true };
    const result = renderer.render(state, view, selected);
    expect(result.rendered).toBe(true);
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_alpha' }, 0.95);
    expect(gl.stencilFunc).toHaveBeenCalledWith(gl.EQUAL, 0, 0xff);
    expect(gl.stencilOp).toHaveBeenCalledWith(gl.KEEP, gl.KEEP, gl.INCR);
    expect(gl.drawArrays).toHaveBeenCalledTimes(3);
    const initial = gl.bufferData.mock.lastCall![1];
    expect(renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, selected).bytes).toBe(0);
    expect(gl.drawArrays).toHaveBeenCalledTimes(6);
    expect(gl.uniform1f.mock.calls.filter((call) => (call as unknown[])[1] === 0.95)).toHaveLength(2);
    expect(gl.bufferData.mock.lastCall![1]).toBe(initial);
    renderer.dispose();
  });

  it('requires stencil for highlight opacity and falls back for default dashed selection', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(drawing(), view, { selection: new Set(['line']) }).reason).toMatch(/Dashed selection/);
    gl.getContextAttributes.mockReturnValue({ stencil: false });
    expect(renderer.render(drawing(), view, { selection: new Set(['line']), solidSelection: true }).reason).toMatch(/stencil/);
    expect(gl.clear).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('returns false for unavailable/lost/disposed devices and rebuilds after restoration', () => {
    const { canvas, gl } = rendererFixture();
    const notify = vi.fn();
    const renderer = new Gpu2DRenderer(canvas, notify);
    const state = sealImmutableData(drawing());
    expect(renderer.render(state, view, overlay).rendered).toBe(true);
    expect(renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, overlay).bytes).toBe(0);
    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, bytes: 0, submissionMs: 0 });
    gl.isContextLost.mockReturnValue(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, bytes: 168 });
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    expect(gl.createProgram).toHaveBeenCalledTimes(2); expect(gl.createBuffer).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
    renderer.dispose();
    expect(renderer.render(state, view, overlay).reason).toMatch(/disposed/);
    const failed = rendererFixture();
    failed.getContext.mockReturnValue(null);
    const unavailable = new Gpu2DRenderer(failed.canvas);
    expect(unavailable.render(state, view, overlay).reason).toMatch(/failed/);
    unavailable.dispose();
  });

  it('reports shader failures without repeated allocation or partial submissions', () => {
    const { canvas, gl } = rendererFixture();
    gl.getShaderParameter.mockReturnValue(false);
    const renderer = new Gpu2DRenderer(canvas);
    for (let i = 0; i < 3; i++) expect(renderer.render(drawing(), view, overlay).reason).toMatch(/invalid shader/);
    expect(gl.createShader).toHaveBeenCalledOnce(); expect(gl.deleteShader).toHaveBeenCalledOnce();
    expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('reports GL upload/submission errors and rejects unsupported backgrounds or oversized views', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(drawing(), { ...view, background: 'invalid' }, overlay).reason).toMatch(/background/);
    expect(renderer.render(drawing(), { ...view, dpr: 1000 }, overlay).reason).toMatch(/limits/);
    expect(gl.clear).not.toHaveBeenCalled();
    gl.getError.mockReturnValue(gl.OUT_OF_MEMORY);
    expect(renderer.render(drawing(), view, overlay).reason).toMatch(/upload failed/);
    gl.getError.mockReturnValueOnce(0).mockReturnValue(gl.OUT_OF_MEMORY);
    expect(renderer.render(drawing(), view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('submission failed'), bytes: 168 });
    renderer.dispose();
  });
});

describe('GPU compiled block and stroke-text integration', () => {
  const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'label', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'ABC', height: 1, rotation: 0, align: 'left', ...patch });
  const insert = (block: string, patch: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'owner', type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {}, ...patch });
  const block = (entities: readonly Entity[], name = 'B'): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities, attributes: [] });
  const scene = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => ({ ...drawing(entities), blocks });

  it('keeps separate ordered child/attribute paint batches and groups each TEXT glyph stroke', () => {
    const definition: BlockDef = { ...block([line, text()]), attributes: [{ tag: 'TAG', prompt: '', default: 'ATTR', position: { x: 0, y: -1 }, height: 1, align: 'left' }] };
    const state = scene([{ ...line, id: 'before' }, insert('B'), { ...line, id: 'after' }], { B: definition });
    const prepared = prepareCompiledZoom2D(state, view, overlay);
    expect(prepared.entities).toBeNull();
    expect(prepared.entityCount).toBe(5);
    expect(prepared.batches.map((batch) => batch.id)).toEqual(['before:0', 'owner:1', 'owner:2', 'owner:3', 'after:4']);
    expect(prepared.batches[2]!.count).toBeGreaterThan(6);
    expect(prepared.compound.blockDependencies.get('B')).toBe(definition);
    expect(prepareZoom2D(state, view, overlay).vertices).toEqual(prepared.vertices);
    expect(prepareZoom2D(drawing(), view, overlay).compound).toBeUndefined();
  });

  it.each([1, 2])('packs trillion-coordinate blocks and native text anchors like an independent near-origin scene at DPR %s', (dpr) => {
    const unit = 1 / 8192;
    const definition = { ...block([{ ...line, a: { x: unit, y: unit }, b: { x: 5 * unit, y: unit } }, text({ height: unit, position: { x: unit, y: unit }, alignmentPoint: { x: 5 * unit, y: 2 * unit }, firstAlignmentPoint: { x: unit, y: unit }, justification: { horizontal: 5, vertical: 0 } })]), basePoint: { x: unit, y: unit } };
    const near = insert('B', { position: { x: 3 * unit, y: -2 * unit }, rotation: 0.3 });
    const origin = { x: 1e12, y: -1e12 };
    const far = { ...near, position: { x: origin.x + near.position.x, y: origin.y + near.position.y } };
    const camera = { ...view, scale: 65536, twist: 0.63, dpr };
    const baseline = prepareZoom2D(scene([near], { B: definition }), camera, overlay);
    const translated = prepareZoom2D(scene([far], { B: definition }), { ...camera, center: origin }, overlay);
    expect(translated.vertices).toEqual(baseline.vertices);
    expect(translated.sourceBounds).toEqual(baseline.sourceBounds);
  });

  it('reuses immutable compiled scenes for redraw, pan and bounded zoom with absent styles', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), state = sealImmutableData(scene([insert('B')], { B: block([line, text()]) }));
    expect(renderer.render(state, view, overlay).rendered).toBe(true);
    const first = gl.bufferData.mock.lastCall![1];
    for (const camera of [view, { ...view, scale: 33 }, { ...view, scale: 33, center: { x: 0.25, y: -0.25 } }]) {
      expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0, uploadCalls: 0, geometryPreparationMs: 0 });
      expect(gl.bufferData.mock.lastCall![1]).toBe(first);
    }
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each([1, 2])('retains entering glyph strokes and fixed lineweights at zoom/pan extremes at DPR %s', (dpr) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const label = text({ text: 'C', position: { x: 5.2, y: 0 }, lineWeight: 1 });
    const state = sealImmutableData(scene([label]));
    const camera = { ...view, dpr, twist: 0.3, lineweights: true };
    expect(renderer.render(state, camera, overlay).rendered).toBe(true);
    for (const ratio of [0.8, 1.25]) {
      const scale = camera.scale * ratio, pan = { x: -120 / dpr, y: 110 / dpr };
      const c = Math.cos(camera.twist), s = Math.sin(camera.twist);
      const current = { ...camera, scale, center: { x: (-c * pan.x + s * pan.y) / scale, y: (s * pan.x + c * pan.y) / scale } };
      expect(renderer.render(state, current, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0, uploadCalls: 0 });
      const actual = ndcGeometry(drawnGeometry(gl), current);
      let visible = 0;
      for (const path of strokeText(label.text, label.position, label.height, label.rotation, label.align)) {
        for (let index = 1; index < path.length; index++) {
          const a = path[index - 1]!, b = path[index]!;
          const midpoint = screenPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, current);
          if (midpoint.x <= 2 || midpoint.x >= current.width - 2 || midpoint.y <= 2 || midpoint.y >= current.height - 2) continue;
          visible++;
          expect(covers(actual, midpoint)).toBe(true);
          const length = Math.hypot(b.x - a.x, b.y - a.y), worldNormal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
          const normal = { x: worldNormal.x * c - worldNormal.y * s, y: -(worldNormal.x * s + worldNormal.y * c) };
          expect(covers(actual, { x: midpoint.x + normal.x * 1.95, y: midpoint.y + normal.y * 1.95 })).toBe(true);
        }
      }
      expect(visible).toBeGreaterThan(5);
    }
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it('invalidates nested block redefinition and undo without relying on top-level entity changes', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const nested = block([line], 'N');
    const before = sealImmutableData(scene([insert('B')], { B: block([insert('N', { id: 'nested' })]), N: nested }));
    const after = sealImmutableData({ ...before, blocks: { ...before.blocks, N: { ...nested, entities: [{ ...line, color: 1, b: { x: 1, y: 1 } }] } } });
    renderer.render(before, view, overlay);
    const original = (gl.bufferData.mock.lastCall![1] as Float32Array).slice();
    for (const current of [after, before, after]) {
      expect(renderer.render(current, view, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'document', uploadCalls: 1 });
      if (current === before) expect(gl.bufferData.mock.lastCall![1]).toEqual(original);
      else expect(gl.bufferData.mock.lastCall![1]).not.toEqual(original);
      expect(renderer.render(current, { ...view, scale: 33 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    }
    const unrelated = sealImmutableData({ ...after, blocks: { ...after.blocks, UNUSED: block([text()], 'UNUSED') } });
    expect(renderer.render(unrelated, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    expect(gl.bufferData).toHaveBeenCalledTimes(4);
    renderer.dispose();
  });

  it('invalidates the raw document STYLE identity and refuses a changed Canvas font before submitting', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const before = sealImmutableData(scene([text()]));
    renderer.render(before, view, overlay);
    const stroke = sealImmutableData({ ...before, meta: { textStyles: { Standard: { ...STANDARD_TEXT_STYLE, font: 'romans.shx' } } } });
    expect(renderer.render(stroke, view, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'document', uploadCalls: 1 });
    const canvasFont = sealImmutableData({ ...stroke, meta: { textStyles: { Standard: { ...STANDARD_TEXT_STYLE, font: 'arial.ttf' } } } });
    gl.clear.mockClear(); gl.drawArrays.mockClear(); gl.bufferData.mockClear();
    expect(renderer.render(canvasFont, view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('Canvas font'), bytes: 0, submissionMs: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.bufferData).not.toHaveBeenCalled();
    expect(renderer.render(stroke, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    expect(renderer.render(before, view, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'document', uploadCalls: 1 });
    renderer.dispose();
  });

  it('does not reuse mutable block definitions or text-style tables', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = { ...sealImmutableData(scene([insert('B')])), blocks: { B: block([line]) } };
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'mutable', uploadCalls: 1 });
    state.blocks.B = block([{ ...line, color: 1 }]);
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'mutable', uploadCalls: 1 });
    const styles = { Standard: { ...STANDARD_TEXT_STYLE, font: 'romans.shx' } };
    const labels = { ...sealImmutableData(scene([text()])), meta: { textStyles: styles } };
    expect(renderer.render(labels, view, overlay)).toMatchObject({ rendered: true, cacheReason: 'mutable', uploadCalls: 1 });
    styles.Standard.font = 'arial.ttf';
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(labels, view, overlay)).toMatchObject({ rendered: false, cacheReason: 'mutable', bytes: 0, submissionMs: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses a late unsupported child before allocating, clearing or drawing any part of the view', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(scene([line, insert('B')], { B: block([text(), text({ id: 'late', bold: true })]) }));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('late'), bytes: 0, submissionMs: 0 });
    expect(gl.createProgram).not.toHaveBeenCalled(); expect(gl.createBuffer).not.toHaveBeenCalled();
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('uses a separate stencil/compositing batch for each selected child stroke and attribute', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const definition = { ...block([line, text()]), attributes: [{ tag: 'TAG', prompt: '', default: 'ATTR', position: { x: 0, y: -1 }, height: 1, align: 'left' as const }] };
    const state = sealImmutableData(scene([{ ...line, id: 'before' }, insert('B'), { ...line, id: 'after' }], { B: definition }));
    const selected = { selection: new Set(['owner']), solidSelection: true };
    const prepared = prepareZoom2D(state, view, selected);
    expect(renderer.render(state, view, selected).rendered).toBe(true);
    expect(gl.drawArrays.mock.calls).toEqual(prepared.batches.map((batch) => [gl.TRIANGLES, batch.first, batch.count]));
    expect(gl.stencilFunc).toHaveBeenCalledTimes(3);
    expect(gl.clear.mock.calls.filter((call) => call[0] === gl.STENCIL_BUFFER_BIT)).toHaveLength(3);
    const alpha = gl.uniform1f.mock.calls.filter((call) => (call[0] as { name: string }).name === 'u_alpha').map((call) => call[1]);
    expect(alpha).toEqual([1, 0.95, 0.95, 0.95, 1]);
    expect(renderer.render(state, { ...view, scale: 33 }, selected)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    renderer.dispose();
  });

  it.each([1, 2])('rebuilds across exact and neighboring QTEXT scales instead of reusing the wrong form at DPR %s', (dpr) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), state = sealImmutableData(scene([text({ height: 1 })]));
    const camera = { ...view, dpr, twist: 0.3, scale: 2.51, center: { x: 0.25, y: -0.25 } };
    renderer.render(state, camera, overlay);
    expect((gl.bufferData.mock.lastCall![1] as Float32Array).length).toBeGreaterThan(42);
    expect(renderer.render(state, { ...camera, scale: 2.5 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'zoom-range', uploadCalls: 1 });
    expect((gl.bufferData.mock.lastCall![1] as Float32Array).length).toBeGreaterThan(42);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...camera, scale: 2.5 - Number.EPSILON * 2 }, overlay)).toMatchObject({ rendered: false, cacheHit: false, cacheReason: 'zoom-range', bytes: 0, submissionMs: 0, reason: expect.stringContaining('QTEXT threshold') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(renderer.render(state, { ...camera, scale: 2.49 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'zoom-range', uploadCalls: 1 });
    expect((gl.bufferData.mock.lastCall![1] as Float32Array).length).toBe(42);
    expect(renderer.render(state, { ...camera, scale: 2.5 }, overlay)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'zoom-range', uploadCalls: 1 });
    expect(renderer.render(state, { ...camera, scale: 2.51 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    renderer.dispose();
  });

  it.each(['circle', 'arc', 'polyline'] as const)('keeps offscreen wide nested %s strokes on complete-view fallback', (type) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const curve: Entity = type === 'circle' ? { ...line, type, center: { x: 1000, y: 1000 }, radius: 0.1 }
      : type === 'arc' ? { ...line, type, center: { x: 1000, y: 1000 }, radius: 0.1, startAngle: 0, endAngle: 1 }
        : { ...polyline, points: [{ x: 999.9, y: 1000 }, { x: 1000.1, y: 1000 }], bulges: [1] };
    const state = sealImmutableData(scene([text(), insert('B', { lineWeight: 10 })], { B: block([curve]) }));
    expect(renderer.render(state, { ...view, lineweights: true }, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('Curve stroke overlap'), bytes: 0, submissionMs: 0 });
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('checks remote original glyph points before clipping rather than hiding a precision failure', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(scene([line, text({ position: { x: 1e10, y: 1e10 } })]));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('precision bound'), bytes: 0, submissionMs: 0 });
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });
});

describe('GPU bounded zoom correctness and separate CPU telemetry', () => {
  it('restores after a warm zoom hit with fresh device limits/stencil, uploads and a unit zoom anchor', () => {
    const { canvas, gl } = rendererFixture();
    const notify = vi.fn();
    const renderer = new Gpu2DRenderer(canvas, notify), state = sealImmutableData(drawing());
    const selected = { selection: new Set(['line']), solidSelection: true };
    expect(renderer.render(state, view, selected)).toMatchObject({ rendered: true, cacheReason: 'cold', bytes: 168 });
    const zoomed = { ...view, scale: 33, center: { x: 0.25, y: -0.25 } };
    expect(renderer.render(state, zoomed, selected)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0, uploadCalls: 0 });
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_zoom' }, 1.1);
    expect(gl.getParameter.mock.calls.filter((call) => call[0] === gl.MAX_VIEWPORT_DIMS)).toHaveLength(1);
    expect(gl.getContextAttributes).toHaveBeenCalledOnce();

    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    gl.clear.mockClear(); gl.drawArrays.mockClear(); gl.uniform1f.mockClear();
    expect(renderer.render(state, zoomed, selected)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, submissionMs: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    // A restored live context can have different limits; the old metadata must not survive.
    gl.getParameter.mockImplementation((parameter) => parameter === gl.MAX_VIEWPORT_DIMS ? new Int32Array([1024, 1024]) : null);
    gl.isContextLost.mockReturnValue(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(state, zoomed, selected)).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'cold', uploadCalls: 1, bytes: 168 });
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_zoom' }, 1);
    expect(gl.uniform2f).toHaveBeenLastCalledWith({ name: 'u_pan' }, 0, 0);
    expect(gl.getParameter.mock.calls.filter((call) => call[0] === gl.MAX_VIEWPORT_DIMS)).toHaveLength(2);
    expect(gl.getContextAttributes).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(2); expect(gl.createBuffer).toHaveBeenCalledTimes(2);
    expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(renderer.render(state, { ...zoomed, scale: 36.3 }, selected)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...zoomed, width: 2048 }, selected)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, reason: expect.stringContaining('device limits') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(state.entities[0]).toEqual(line);
    renderer.dispose();
  });

  it('reports preparation, upload and draw phases and performs no warm geometry work', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), state = sealImmutableData(drawing());
    const first = renderer.render(state, view, overlay);
    expect(first).toMatchObject({ rendered: true, cacheHit: false, cacheReason: 'cold', geometryVertices: 6, bytes: 168, uploadCalls: 1 });
    for (const name of ['cacheLookupMs', 'geometryPreparationMs', 'initializationMs', 'uploadMs', 'drawSubmissionMs', 'preparationMs', 'submissionMs'] as const) {
      expect(Number.isFinite(first[name])).toBe(true);
      expect(first[name]).toBeGreaterThanOrEqual(0);
    }
    for (const scale of [view.scale, 24, 25.7, 33, 37.5]) {
      expect(renderer.render(state, { ...view, scale }, overlay)).toMatchObject({ rendered: true, bytes: 0, uploadCalls: 0, uploadMs: 0, geometryPreparationMs: 0, initializationMs: 0, geometryVertices: 6, cacheHit: true, cacheReason: 'hit' });
    }
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(gl.drawArrays).toHaveBeenCalledTimes(6);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(0, 2, gl.FLOAT, false, 28, 0);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(1, 3, gl.FLOAT, false, 28, 16);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(2, 2, gl.FLOAT, false, 28, 8);
    renderer.dispose();
  });

  it('copies the scale anchor, admits both exact boundaries and rebuilds after crossing either', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), state = sealImmutableData(drawing());
    const camera = { ...view, center: { ...view.center } };
    renderer.render(state, camera, overlay);
    for (const scale of [33, 24, 37.5, 30]) {
      camera.scale = scale;
      expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, bytes: 0, cacheReason: 'hit' });
    }
    camera.scale = 37.5001;
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, bytes: 168, cacheReason: 'zoom-range' });
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_zoom' }, 1);
    camera.scale = 30;
    expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, bytes: 168, cacheReason: 'zoom-range' });
    expect(gl.bufferData).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });

  it('treats selection as membership, preserves batch order and updates only real membership changes', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const state = sealImmutableData(drawing([line, { ...line, id: 'second', color: 1 }]));
    const selection = { selection: new Set(['line', 'second']), solidSelection: true };
    renderer.render(state, view, selection);
    const calls = gl.drawArrays.mock.calls.map((call) => [...call]);
    expect(renderer.render(state, { ...view, scale: 33 }, { ...selection, selection: new Set(['second', 'line']) })).toMatchObject({ rendered: true, bytes: 0, cacheHit: true });
    expect(gl.drawArrays.mock.calls.slice(2)).toEqual(calls);
    expect(gl.stencilFunc).toHaveBeenCalledTimes(4);
    selection.selection.delete('second');
    expect(renderer.render(state, view, selection)).toMatchObject({ rendered: true, bytes: 336, cacheReason: 'view-style' });
    renderer.dispose();
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])('refuses invalid warm-cache zoom %s without clearing or submitting', (scale) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), state = sealImmutableData(drawing());
    renderer.render(state, view, overlay);
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...view, scale }, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, submissionMs: 0, reason: expect.stringContaining('Invalid GPU view') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses offscreen original endpoints that cross the source precision bound inside the zoom band', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const unit = { ...view, scale: 1, dpr: 2 };
    const bound = 2 ** 36 / unit.dpr;
    const state = sealImmutableData(drawing([{ ...line, a: { x: 0, y: 0 }, b: { x: bound - unit.width / 2 - 2, y: 0 } }]));
    expect(renderer.render(state, unit, overlay).rendered).toBe(true);
    expect(renderer.render(state, { ...unit, scale: 0.8 }, overlay)).toMatchObject({ rendered: true, bytes: 0 });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...unit, scale: 1.1 }, overlay)).toMatchObject({ rendered: false, cacheReason: 'precision', bytes: 0, uploadCalls: 0, submissionMs: 0, reason: expect.stringContaining('precision bound') });
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses huge lineweights rather than losing pixel offsets through Float32 cancellation', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(sealImmutableData(drawing([{ ...line, lineWeight: 1e7 }])), { ...view, lineweights: true }, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, submissionMs: 0, reason: expect.stringContaining('Float32 precision budget') });
    expect(gl.createBuffer).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 1.25, 2, 3])('preserves fixed lineweights and tiny rotated offsets at trillion-unit origins, DPR %s', (dpr) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const center = { x: 1e12, y: -1e12 };
    const translated: LineEntity = { ...line, a: { x: center.x - 1 / 32, y: center.y + 1 / 8192 }, b: { x: center.x + 1 / 32, y: center.y + 1 / 8192 }, lineWeight: 1 };
    const state = sealImmutableData(drawing([translated]));
    const close = { ...view, scale: 1024, center, twist: 0.63, dpr, lineweights: true };
    renderer.render(state, close, overlay);
    for (const ratio of [0.8, 1.037, 1.25]) {
      const moved = { ...close, scale: close.scale * ratio, center: { x: center.x + 1 / 8192, y: center.y - 1 / 4096 } };
      expect(renderer.render(state, moved, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
      const actual = ndcGeometry(drawnGeometry(gl), moved);
      const reference = prepare2D(state, moved, overlay);
      expect(actual.vertices).toHaveLength(reference.vertices.length);
      actual.vertices.forEach((value, index) => {
        if (index % 5 < 2) expect(Math.abs(value - reference.vertices[index]!) * dpr).toBeLessThan(0.0625);
      });
      const points = xy(actual);
      expect(Math.hypot(points[0]!.x - points[5]!.x, points[0]!.y - points[5]!.y)).toBeCloseTo(4, 3);
      expect(covers(actual, screenPoint({ x: center.x, y: center.y + 1 / 8192 }, moved))).toBe(true);
    }
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each([1, 2, 3])('retains all edge-entering and remote spanning strokes at zoom/pan extremes, DPR %s', (dpr) => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const padding = 128 / dpr;
    const x = (view.width / 2 + padding - 10) / 0.8 / view.scale;
    const y = (view.height / 2 + padding - 10) / 0.8 / view.scale;
    const state = sealImmutableData(drawing([
      ...[-x, x].map((value, index): LineEntity => ({ ...line, id: `vertical${index}`, a: { x: value, y: -1e8 }, b: { x: value, y: 1e8 } })),
      ...[-y, y].map((value, index): LineEntity => ({ ...line, id: `horizontal${index}`, a: { x: -1e8, y: value }, b: { x: 1e8, y: value } })),
      { ...line, id: 'diagonal', a: { x: -1e8, y: -1e8 }, b: { x: 1e8, y: 1e8 } },
    ]));
    const anchor = { ...view, dpr };
    renderer.render(state, anchor, overlay);
    let enteringSamples = 0;
    for (const ratio of [0.8, 1.25]) for (const signX of [-1, 1]) for (const signY of [-1, 1]) {
      const pan = { x: signX * padding, y: signY * padding };
      const next = { ...anchor, scale: view.scale * ratio, center: { x: -pan.x / (view.scale * ratio), y: pan.y / (view.scale * ratio) } };
      expect(renderer.render(state, next, overlay)).toMatchObject({ rendered: true, bytes: 0, cacheHit: true });
      const actual = ndcGeometry(drawnGeometry(gl), next);
      for (const value of [-x, x]) {
        const sx = view.width / 2 + pan.x + value * next.scale;
        if (sx <= 0 || sx >= view.width) continue;
        enteringSamples++;
        for (const sy of [0.5, 40, 120, view.height - 0.5]) expect(covers(actual, { x: sx, y: sy })).toBe(true);
      }
      for (const value of [-y, y]) {
        const sy = view.height / 2 + pan.y - value * next.scale;
        if (sy <= 0 || sy >= view.height) continue;
        enteringSamples++;
        for (const sx of [0.5, 40, 160, view.width - 0.5]) expect(covers(actual, { x: sx, y: sy })).toBe(true);
      }
      for (let sx = 5; sx < view.width - 5; sx += 10) {
        const sy = view.height / 2 + pan.y + view.width / 2 + pan.x - sx;
        if (sy > 0.5 && sy < view.height - 0.5) expect(covers(actual, { x: sx, y: sy })).toBe(true);
      }
    }
    expect(enteringSamples).toBeGreaterThanOrEqual(8);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each([1, 1.25, 2, 3])('bounds thin and wide native circle envelopes throughout zoom at DPR %s', (dpr) => {
    for (const { radius, weight } of [{ radius: 2, weight: 0.25 }, { radius: 1, weight: 10 }]) {
      const circle: Entity = { ...line, type: 'circle', center: { x: 0, y: 0 }, radius, lineWeight: weight };
      const weighted = { ...view, dpr, lineweights: true };
      const geometry = prepareZoom2D(drawing([circle]), weighted, overlay);
      const half = weight / 0.25 / 2;
      for (const ratio of [0.8, 1.037, 1.25]) {
        const actual = ndcGeometry(zoomToScreen(geometry.vertices, weighted, ratio), weighted);
        const r = radius * view.scale * ratio, allowance = 0.25 / dpr;
        for (let i = 0; i < 180; i++) {
          const angle = (i + 0.5) * Math.PI * 2 / 180;
          const at = (distance: number): Point => ({ x: view.width / 2 + Math.cos(angle) * distance, y: view.height / 2 - Math.sin(angle) * distance });
          expect(covers(actual, at(r + half - allowance))).toBe(true);
          expect(covers(actual, at(r + half + allowance))).toBe(false);
          expect(covers(actual, at(r - half - allowance))).toBe(false);
          expect(covers(actual, { x: view.width / 2, y: view.height / 2 })).toBe(false);
        }
      }
    }
  });

  it.each(['circle', 'arc', 'polyline'] as const)('refuses self-overlapping %s strokes before drawing any part of the view', (type) => {
    const base = { id: 'wide', layer: '0', color: 3, lineWeight: 10 } as const;
    const curve: Entity = type === 'circle' ? { ...base, type, center: { x: 0, y: 0 }, radius: 0.1 }
      : type === 'arc' ? { ...base, type, center: { x: 0, y: 0 }, radius: 0.1, startAngle: 0.2, endAngle: 3.8 }
        : { ...base, type, points: [{ x: -0.1, y: 0 }, { x: 0.1, y: 0 }], closed: false, bulges: [1] };
    const weighted = { ...view, scale: 80, lineweights: true };
    const state = sealImmutableData(drawing([line, curve]));
    expect(() => prepareZoom2D(state, weighted, overlay)).toThrow(/Curve stroke overlap.*Canvas/);
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(state, weighted, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, submissionMs: 0, reason: expect.stringContaining('Curve stroke overlap') });
    expect(gl.createProgram).not.toHaveBeenCalled(); expect(gl.createBuffer).not.toHaveBeenCalled();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 2, 3])('keeps a quarter-physical-pixel inner-radius margin, including equality, at DPR %s', (dpr) => {
    const weighted = { ...view, scale: 80, dpr, lineweights: true };
    for (const projectedRadius of [20, 20 + 0.125 / dpr, 20 + 0.25 / dpr]) {
      const circle: Entity = { ...line, type: 'circle', center: { x: 0, y: 0 }, radius: projectedRadius / weighted.scale, lineWeight: 10 };
      expect(() => prepareZoom2D(drawing([circle]), weighted, overlay)).toThrow(/Curve stroke overlap.*Canvas/);
    }
  });

  it('narrows zoom admission for a safe current curve and refuses before a cached zoom crosses the overlap margin', () => {
    const circle: Entity = { ...line, id: 'circle', type: 'circle', center: { x: 0, y: 0 }, radius: 0.7, lineWeight: 10 };
    const state = sealImmutableData(drawing([line, circle]));
    const weighted = { ...view, lineweights: true };
    const geometry = prepareZoom2D(state, weighted, overlay);
    expect(geometry.minRatio).toBeGreaterThan(0.8);
    expect(geometry.minRatio).toBeLessThan(1);
    expect(circle.radius * weighted.scale * geometry.minRatio).toBeGreaterThan(20 + 0.25 / weighted.dpr);
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(state, weighted, overlay).rendered).toBe(true);
    expect(renderer.render(state, { ...weighted, scale: view.scale * 0.97 }, overlay)).toMatchObject({ rendered: true, cacheHit: true, bytes: 0 });
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, { ...weighted, scale: view.scale * 0.96 }, overlay)).toMatchObject({ rendered: false, cacheReason: 'zoom-range', bytes: 0, uploadCalls: 0, submissionMs: 0, reason: expect.stringContaining('Curve stroke overlap') });
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses offscreen wide curves as well as visible ones so complete-view fallback remains explicit', () => {
    const circle: Entity = { ...line, id: 'offscreen-wide', type: 'circle', center: { x: 1000, y: 1000 }, radius: 0.1, lineWeight: 10 };
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    expect(renderer.render(sealImmutableData(drawing([line, circle])), { ...view, scale: 80, lineweights: true }, overlay)).toMatchObject({ rendered: false, bytes: 0, uploadCalls: 0, reason: expect.stringContaining('offscreen-wide') });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it.each([1, 2, 3])('bounds wide open-arc butt-cap tangent error independently at DPR %s', (dpr) => {
    const arc: Entity = { ...line, type: 'arc', center: { x: 0, y: 0 }, radius: 2, startAngle: 0.2, endAngle: 3.8, lineWeight: 10 };
    const weighted = { ...view, dpr, twist: 0.4, lineweights: true };
    const prepared = prepareZoom2D(drawing([arc]), weighted, overlay);
    for (const angle of [arc.startAngle, arc.endAngle]) {
      const rotated = angle + weighted.twist;
      const endpoint = { x: Math.cos(rotated) * arc.radius * weighted.scale, y: -Math.sin(rotated) * arc.radius * weighted.scale };
      const tangent = { x: -Math.sin(rotated), y: -Math.cos(rotated) };
      let samples = 0;
      for (let i = 0; i < prepared.vertices.length; i += GPU_ZOOM_VERTEX_STRIDE) {
        if (Math.hypot(prepared.vertices[i]! - endpoint.x, prepared.vertices[i + 1]! - endpoint.y) > 0.0001) continue;
        samples++;
        const error = Math.abs(prepared.vertices[i + 2]! * tangent.x + prepared.vertices[i + 3]! * tangent.y) * dpr;
        expect(error).toBeLessThan(0.25);
      }
      expect(samples).toBeGreaterThan(0);
    }
  });

  it('rebuilds immutable edits and preserves warm reuse after edit, undo and redo', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas), before = sealImmutableData(drawing());
    const after = sealImmutableData(drawing([{ ...line, b: { x: 1, y: 1 } }]));
    renderer.render(before, view, overlay);
    for (const state of [after, before, after]) {
      expect(renderer.render(state, { ...view, scale: 33 }, overlay)).toMatchObject({ rendered: true, cacheReason: 'document', bytes: 168 });
      const actual = ndcGeometry(drawnGeometry(gl), view);
      const entity = state.entities[0] as LineEntity;
      const middle = { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 };
      expect(covers(actual, screenPoint(middle, { ...view, scale: 33 }))).toBe(true);
      expect(renderer.render(state, { ...view, scale: 34 }, overlay)).toMatchObject({ rendered: true, bytes: 0, geometryPreparationMs: 0, cacheHit: true });
    }
    expect(gl.bufferData).toHaveBeenCalledTimes(4);
    renderer.dispose();
  });
});
