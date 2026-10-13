import { describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { Entity, Layer, LineEntity, PolylineEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { colorDisplay, lineweightDisplay } from '../src/render/draw';
import { prepare2D, screenPoint, type Gpu2DView, type Prepared2D } from '../src/render/gpu-prototype/geometry2d';
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
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    getParameter: vi.fn((parameter: number) => parameter === 0xd3a ? new Int32Array([16384, 16384]) : null),
    getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(),
    stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(),
    blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
  };
  const events = new EventTarget();
  const getContext = vi.fn((): WebGL2RenderingContext | null => gl as unknown as WebGL2RenderingContext);
  const canvas = Object.assign(events, { getContext, width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  return { gl, canvas, getContext };
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
    expect(result).toMatchObject({ rendered: true, bytes: 120 });
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
    expect(renderer.render(state, view, overlay).bytes).toBe(120);
    expect(renderer.render(state, { ...view }, { selection: new Set() }).bytes).toBe(0);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(renderer.render(state, { ...view, center: { x: 0.25, y: 0 } }, overlay).bytes).toBe(120);
    const changedLayer = sealImmutableData({ ...state, layers: [{ ...layer, trueColor: 0xff0000 }] });
    expect(renderer.render(changedLayer, view, overlay).bytes).toBe(120);
    const selected = { selection: new Set(['line']), solidSelection: true };
    expect(renderer.render(changedLayer, view, selected).bytes).toBe(120);
    selected.selection.clear();
    expect(renderer.render(changedLayer, view, selected).bytes).toBe(120);
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

  it('makes unsupported full-scene refusal before clearing or submitting any geometry', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const text = { id: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'visible', height: 1, rotation: 0, align: 'left' } as const;
    const result = renderer.render(drawing([line, text]), view, overlay);
    expect(result).toMatchObject({ rendered: false, reason: expect.stringContaining('text'), submissionMs: 0, bytes: 0 });
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); expect(gl.createProgram).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('renders solid selection through stencil once per entity, including self-intersections', () => {
    const { canvas, gl } = rendererFixture();
    const renderer = new Gpu2DRenderer(canvas);
    const bowtie: PolylineEntity = { ...polyline, points: [{ x: -2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }, { x: 2, y: -2 }] };
    const result = renderer.render(drawing([line, bowtie, { ...line, id: 'last' }]), view, { selection: new Set(['polyline']), solidSelection: true });
    expect(result.rendered).toBe(true);
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'u_alpha' }, 0.95);
    expect(gl.stencilFunc).toHaveBeenCalledWith(gl.EQUAL, 0, 0xff);
    expect(gl.stencilOp).toHaveBeenCalledWith(gl.KEEP, gl.KEEP, gl.INCR);
    expect(gl.drawArrays).toHaveBeenCalledTimes(3);
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
    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, bytes: 0, submissionMs: 0 });
    gl.isContextLost.mockReturnValue(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: true, bytes: 120 });
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
    expect(renderer.render(drawing(), view, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('submission failed'), bytes: 120 });
    renderer.dispose();
  });
});
