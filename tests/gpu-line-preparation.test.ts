import { describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { Entity, Layer, LineEntity } from '../src/core/entities';
import { colorDisplay, lineweightDisplay } from '../src/render/draw';
import { GPU_EDIT_ENTITY_LIMIT, GPU_ZOOM_VERTEX_STRIDE, prepareZoom2D, prepareZoomLine, type Gpu2DOverlay, type Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const hidden: Layer = { ...layer, name: 'hidden', visible: false };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 30, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[]): DrawingState => ({ entities, layers: [layer, hidden], blocks: {}, currentLayer: '0' });

function writerGrowthLines(): LineEntity[] {
  const entities: LineEntity[] = [];
  for (let i = 0; i < 1700; i++) {
    const x = (i % 41 - 20) / 2, y = (i % 31 - 15) / 2;
    entities.push({ ...line, id: String(i), layer: i % 37 === 0 ? 'hidden' : '0', color: i % 7 + 1, lineWeight: i % 5 / 10 + 0.1, a: { x, y }, b: i % 43 === 0 ? { x, y } : { x: x + 3.5, y: y + 1.2 } });
  }
  return entities;
}

function expectCompleteCanvasRefusal(state: DrawingState, camera: Gpu2DView, reason: string, selected: Gpu2DOverlay = overlay, rendererReason = reason, singleLineReason: string | null = reason): void {
  let failure: unknown;
  try { prepareZoom2D(state, camera, selected); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe(reason);
  expect(isSourceTopologyAdmissionError(failure) || isSourcePrecisionCertificateError(failure)).toBe(true);
  const visibleLine = state.entities.find((entity): entity is LineEntity => entity.type === 'line' && state.layers.find((entry) => entry.name === entity.layer)?.visible !== false);
  if (visibleLine && singleLineReason !== null) expect(() => prepareZoomLine(visibleLine, state, camera, selected, { x: 1000, y: 1000 })).toThrow(singleLineReason);
  const gl = {
    MAX_VIEWPORT_DIMS: 0xd3a, isContextLost: vi.fn(() => false),
    getParameter: vi.fn(() => new Int32Array([16384, 16384])),
    createShader: vi.fn(), createBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(),
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext) }) as unknown as HTMLCanvasElement;
  const renderer = new Gpu2DRenderer(canvas);
  expect(renderer.render(state, camera, selected)).toMatchObject({ rendered: false, reason: rendererReason, cacheHit: false, uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
  for (const method of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(method).not.toHaveBeenCalled();
  renderer.dispose();
}

describe('GPU straight-line full preparation', () => {
  it.each([1, 2, 3])('keeps the original rotated writer-growth scene on complete Canvas at DPR %s', (dpr) => {
    const entities = writerGrowthLines(), state = drawing(entities), camera = { ...view, twist: 0.63, dpr, lineweights: true };
    const selected = { selection: new Set(['1', '900']), hover: '2', solidSelection: true };
    expectCompleteCanvasRefusal(state, camera, 'Unsupported Canvas stroke construction: native context rotation is unproved', selected);
  });

  it.each([1, 2, 3])('matches generic bytes through writer growth, clipping and hidden slots in a separate zero-twist control at DPR %s', (dpr) => {
    const entities = writerGrowthLines();
    const state = drawing(entities), camera = { ...view, twist: 0, dpr, lineweights: true };
    const selected = { selection: new Set(['1', '900']), hover: '2', solidSelection: true };
    const actual = prepareZoom2D(state, camera, selected);
    const reference = new Float32Array(actual.vertices.length);
    const batches = [];
    let first = 0;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]!;
      if (entity.layer === 'hidden') { expect(actual.entities![i]).toBeNull(); continue; }
      // prepareZoomLine retains the previous generic path/filter/number[] packing.
      const expected = prepareZoomLine(entity, state, camera, selected, actual.extent);
      const count = expected.vertices.length / GPU_ZOOM_VERTEX_STRIDE;
      reference.set(expected.vertices, first * GPU_ZOOM_VERTEX_STRIDE);
      expect(actual.entities![i]).toMatchObject({ entity, first, count, color: expected.color, width: expected.width, alpha: expected.alpha, sourceBounds: expected.sourceBounds });
      if (count) batches.push({ id: entity.id, first, count, alpha: expected.alpha });
      first += count;
    }
    expect(actual.vertices).toEqual(reference);
    expect(actual.batches).toEqual(batches);
    expect(first * GPU_ZOOM_VERTEX_STRIDE).toBe(actual.vertices.length);
    expect(actual.vertices.byteLength).toBe(actual.vertices.buffer.byteLength);
    expect(actual.minRatio).toBe(0.8); expect(actual.maxRatio).toBe(1.25);
  });

  it.each([1, 2])('keeps the original rotated trillion-unit endpoints and wide weights on complete Canvas at DPR %s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, delta = 1 / 8192;
    const local: LineEntity = { ...line, lineWeight: 5, a: { x: -1 / 32, y: delta }, b: { x: 1 / 32, y: delta } };
    const shifted: LineEntity = { ...local, a: { x: origin.x + local.a.x, y: origin.y + local.a.y }, b: { x: origin.x + local.b.x, y: origin.y + local.b.y } };
    const camera = { ...view, scale: 4096, twist: 0.63, dpr, lineweights: true };
    expectCompleteCanvasRefusal(drawing([local]), camera, 'Unsupported Canvas stroke construction: native context rotation is unproved');
    expectCompleteCanvasRefusal(drawing([shifted]), { ...camera, center: origin }, 'Unsupported Canvas stroke construction: native context rotation is unproved');
    expect(shifted.a.y - origin.y).toBe(delta); expect(shifted.b.x - shifted.a.x).toBe(1 / 16);
    expect(Math.fround(shifted.a.x)).toBe(Math.fround(shifted.b.x));
  });

  it.each([1, 2])('preserves trillion-unit displacement and wide CSS offsets in a separate zero-twist control at DPR %s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, delta = 1 / 8192;
    const local: LineEntity = { ...line, lineWeight: 5, a: { x: -1 / 32, y: delta }, b: { x: 1 / 32, y: delta } };
    const shifted: LineEntity = { ...local, a: { x: origin.x + local.a.x, y: origin.y + local.a.y }, b: { x: origin.x + local.b.x, y: origin.y + local.b.y } };
    const camera = { ...view, scale: 4096, twist: 0, dpr, lineweights: true };
    const baseline = prepareZoom2D(drawing([local]), camera, overlay);
    const actual = prepareZoom2D(drawing([shifted]), { ...camera, center: origin }, overlay);
    expect(actual.vertices).toEqual(baseline.vertices);
    expect(actual.sourceBounds).toEqual(baseline.sourceBounds);
    expect(actual.vertices).toEqual(prepareZoomLine(shifted, drawing([shifted]), { ...camera, center: origin }, overlay, actual.extent).vertices);
    // Lineweights remain CSS offsets even though centers are packed at close zoom.
    const width = actual.entities![0]!.width;
    expect(Math.hypot(actual.vertices[2]!, actual.vertices[3]!)).toBeCloseTo(width / 2, 5);
  });

  it('keeps the original far and rotated endpoint construction on complete Canvas', () => {
    const source: LineEntity = { ...line, a: { x: -1e9, y: -1e8 }, b: { x: 1e9, y: 1e8 } };
    const camera = { ...view, scale: 1, twist: 0.4 };
    expectCompleteCanvasRefusal(drawing([source]), camera, 'Unsupported Canvas stroke construction: native context rotation is unproved');
    expectCompleteCanvasRefusal(drawing([source]), { ...camera, twist: 0 }, 'Unsupported Canvas stroke construction: native float point, normal or miter exceeds precision budget');
    expect((source.b.y - source.a.y) / (source.b.x - source.a.x)).toBe(0.1);
  });

  it('keeps original normals and unclipped source bounds for a separate bounded zero-twist spanning control', () => {
    const source: LineEntity = { ...line, lineWeight: 5, a: { x: -1000, y: -100 }, b: { x: 1000, y: 100 } };
    const camera = { ...view, scale: 1, twist: 0, lineweights: true };
    const actual = prepareZoom2D(drawing([source]), camera, overlay);
    const expected = prepareZoomLine(source, drawing([source]), camera, overlay, actual.extent);
    expect(actual.vertices).toEqual(expected.vertices);
    expect(actual.sourceBounds).toEqual(expected.sourceBounds);
    expect(actual.sourceBounds).toEqual({ min: { x: -1000, y: -100 }, max: { x: 1000, y: 100 } });
    expect(Math.max(Math.abs(actual.sourceBounds.min.x), Math.abs(actual.sourceBounds.max.x))).toBeGreaterThan(actual.extent.x);
    for (let i = 0; i < actual.vertices.length; i += GPU_ZOOM_VERTEX_STRIDE) {
      expect(Math.abs(actual.vertices[i]!)).toBeLessThanOrEqual(actual.extent.x + 0.01);
      expect(Math.abs(actual.vertices[i + 1]!)).toBeLessThanOrEqual(actual.extent.y + 0.01);
      const rotatedX = Math.cos(camera.twist) - 0.1 * Math.sin(camera.twist);
      const rotatedY = -(Math.sin(camera.twist) + 0.1 * Math.cos(camera.twist));
      expect(Math.abs(actual.vertices[i + 2]! * rotatedX + actual.vertices[i + 3]! * rotatedY)).toBeLessThan(1e-6);
      expect(Math.hypot(actual.vertices[i + 2]!, actual.vertices[i + 3]!)).toBeCloseTo(10, 5);
    }
  });

  it('retains projected-degenerate certificates and tangent-clip vertex counts', () => {
    const camera = { ...view, scale: 1 };
    const seed = prepareZoom2D(drawing([line]), camera, overlay);
    const e = seed.extent;
    const tangent: LineEntity = { ...line, id: 'tangent', a: { x: e.x - 10, y: -(e.y + 10) }, b: { x: e.x + 10, y: -(e.y - 10) } };
    // Both distinct endpoints project to the same pixel because the displacement is
    // below the double ULP after screenPoint adds the viewport center.
    const tiny: LineEntity = { ...line, id: 'tiny', a: { x: 0, y: 0 }, b: { x: 1e-20, y: 0 } };
    expect(tiny.a.x).not.toBe(tiny.b.x);
    expect(camera.width / 2 + tiny.a.x * camera.scale).toBe(camera.width / 2 + tiny.b.x * camera.scale);
    const outside: LineEntity = { ...line, id: 'outside', a: { x: 1000, y: 1000 }, b: { x: 1001, y: 1001 } };
    const state = drawing([tiny, tangent, outside, line]);
    const actual = prepareZoom2D(state, camera, overlay);
    expect(actual.entities![0]).toMatchObject({ first: 0, count: 0, sourceBounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } } });
    const expectedTangent = prepareZoomLine(tangent, state, camera, overlay, actual.extent);
    expect(expectedTangent.vertices.length).toBe(6 * GPU_ZOOM_VERTEX_STRIDE);
    expect(actual.entities![1]).toMatchObject({ first: 0, count: 6 });
    expect(actual.entities![2]).toMatchObject({ first: 6, count: 0 });
    expect(actual.entities![3]).toMatchObject({ first: 6, count: 6 });
    expect(actual.vertices.subarray(0, expectedTangent.vertices.length)).toEqual(expectedTangent.vertices);
    expect(actual.vertices.buffer.byteLength).toBe(actual.vertices.byteLength);
  });

  it('keeps the original rotated mixed clipping scene on complete Canvas', () => {
    const source = { ...line, lineWeight: 5, a: { x: -10, y: -4 }, b: { x: 10, y: 4 } };
    const circle: Entity = { ...line, id: 'offscreen-circle', type: 'circle', center: { x: 10000, y: 10000 }, radius: 2 };
    const camera = { ...view, twist: 0.37, lineweights: true };
    expectCompleteCanvasRefusal(drawing([source]), camera, 'Unsupported Canvas stroke construction: native context rotation is unproved');
    expectCompleteCanvasRefusal(drawing([source, circle]), camera, 'Unsupported Canvas stroke construction: native context rotation is unproved');
  });

  it('keeps the original zero-twist offscreen-circle control on complete Canvas when native parameters exceed the reserve', () => {
    const source = { ...line, lineWeight: 5, a: { x: -10, y: -4 }, b: { x: 10, y: 4 } };
    const circle: Entity = { ...line, id: 'offscreen-circle', type: 'circle', center: { x: 10000, y: 10000 }, radius: 2 };
    const camera = { ...view, twist: 0, lineweights: true };
    const reason = 'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget';
    expectCompleteCanvasRefusal(drawing([source, circle]), camera, reason, overlay, reason, null);
    expect(prepareZoom2D(drawing([source]), camera, overlay).vertices.length).toBeGreaterThan(0);
  });

  it('matches fast/generic LINE packing with a separately admitted smaller wholly offscreen circle', () => {
    const source = { ...line, lineWeight: 5, a: { x: -10, y: -4 }, b: { x: 10, y: 4 } };
    const circle: Entity = { ...line, id: 'offscreen-circle', type: 'circle', center: { x: 100, y: 100 }, radius: 2 };
    const camera = { ...view, twist: 0, lineweights: true };
    const fast = prepareZoom2D(drawing([source]), camera, overlay);
    const generic = prepareZoom2D(drawing([source, circle]), camera, overlay);
    expect(generic.extent).toEqual(fast.extent);
    expect(generic.vertices).toEqual(fast.vertices);
    expect(generic.batches).toEqual(fast.batches);
    expect(generic.entities![0]).toEqual(fast.entities![0]);
    expect(generic.entities![1]!.count).toBe(0);
    expect(generic.sourceBounds.max.x).toBeGreaterThan(fast.sourceBounds.max.x);
    expect(generic.sourceBounds.min.y).toBeLessThan(fast.sourceBounds.min.y);
  });

  it('returns owned exact-sized storage across preparations', () => {
    const first = prepareZoom2D(drawing([line]), view, overlay);
    const second = prepareZoom2D(drawing([line]), view, overlay), saved = second.vertices.slice();
    first.vertices.fill(999);
    expect(second.vertices).toEqual(saved);
    expect(first.vertices.buffer).not.toBe(second.vertices.buffer);
    expect(second.vertices.buffer.byteLength).toBe(168);
  });

  it('allocates no output for huge offscreen scenes and respects the independent metadata cap', () => {
    const remote = { ...line, a: { x: 1000, y: 1000 }, b: { x: 1001, y: 1001 } };
    const state = drawing(Array.from({ length: GPU_EDIT_ENTITY_LIMIT + 1 }, (_, i) => ({ ...remote, id: String(i) })));
    const actual = prepareZoom2D(state, view, overlay);
    expect(actual.entityCount).toBe(GPU_EDIT_ENTITY_LIMIT + 1);
    expect(actual.entities).toBeNull();
    expect(actual.vertices.length).toBe(0); expect(actual.vertices.buffer.byteLength).toBe(0);
    expect(actual.batches).toEqual([]);
    const expected = prepareZoomLine(remote, state, view, overlay, actual.extent);
    expect(actual.sourceBounds).toEqual(expected.sourceBounds);
  }, 15000);

  it('rejects geometry beyond the existing one-million-vertex budget before uploading reserved capacity', () => {
    const state = drawing(Array.from({ length: 166667 }, (_, i) => ({ ...line, id: String(i) })));
    expect(() => prepareZoom2D(state, view, overlay)).toThrow(/Stroke geometry exceeds prototype budget/);
  }, 15000);

  it('refuses the original tiny-DPR and huge-center input before Float32 packing or any GPU upload', () => {
    const camera = { ...view, width: 1e40, dpr: 1e-40, scale: 1 };
    const source: LineEntity = { ...line, a: { x: -camera.width / 2, y: 0 }, b: { x: -camera.width / 2, y: 1 } };
    expectCompleteCanvasRefusal(drawing([source]), camera, 'Unsupported Canvas stroke construction: native Float32 segment direction is unproved', overlay, 'GPU viewport exceeds device limits');
  });

  it('preflights unsupported offscreen lines and restores Canvas global style state', () => {
    const paper = colorDisplay.paper, weights = { ...lineweightDisplay };
    try {
      colorDisplay.paper = true; lineweightDisplay.enabled = true; lineweightDisplay.pxPerMm = 123;
      const source = { ...line, id: 'offscreen', transparency: 50, a: { x: 1000, y: 1000 }, b: { x: 1001, y: 1001 } };
      expect(() => prepareZoom2D(drawing([line, source]), view, overlay)).toThrow(/Unsupported transparency/);
      expect(colorDisplay.paper).toBe(true); expect(lineweightDisplay).toMatchObject({ enabled: true, pxPerMm: 123 });
      // This refusal occurs inside the straight-line painter, after its style globals
      // have changed, so it verifies the enclosing finally rather than only preflight.
      expectCompleteCanvasRefusal(drawing([{ ...line, b: { x: NaN, y: 0 } }]), view, 'Unsupported Canvas stroke construction: nonfinite native point', overlay, 'Unsupported Canvas stroke construction: nonfinite native point', 'Nonfinite screen geometry');
      expect(colorDisplay.paper).toBe(true); expect(lineweightDisplay).toMatchObject({ enabled: true, pxPerMm: 123 });
      prepareZoom2D(drawing([line]), view, overlay);
      expect(colorDisplay.paper).toBe(true); expect(lineweightDisplay).toMatchObject({ enabled: true, pxPerMm: 123 });
    } finally { colorDisplay.paper = paper; Object.assign(lineweightDisplay, weights); }
  });
});
