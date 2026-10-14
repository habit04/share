import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { Entity, Layer, LineEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { colorDisplay, lineweightDisplay } from '../src/render/draw';
import { GPU_EDIT_ENTITY_LIMIT, GPU_ZOOM_VERTEX_STRIDE, prepareZoom2D, prepareZoomLine, zoomPrecisionSafe, type Gpu2DOverlay, type Gpu2DView, type PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import { nativeFloatStrokeBound } from '../src/render/gpu-prototype/native-float-stroke-bound';
import * as parity from '../src/render/gpu-prototype/stroke-parity';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError, sourcePrecisionCertificateError, sourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const hidden: Layer = { ...layer, name: 'hidden', visible: false };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 10, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay: Gpu2DOverlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[]): DrawingState => sealImmutableData({ entities, layers: [layer, hidden], blocks: {}, currentLayer: '0' });
const certified = (state: DrawingState, camera = view, selected = overlay) => prepareZoom2D(state, camera, selected, undefined, undefined, undefined, { certifyStraightZoomIn: true });
const bytes = (geometry: PreparedZoom2D) => new Uint8Array(geometry.vertices.buffer, geometry.vertices.byteOffset, geometry.vertices.byteLength);

function expectUnchangedMesh(actual: PreparedZoom2D, ordinary: PreparedZoom2D): void {
  expect(bytes(actual)).toEqual(bytes(ordinary));
  expect(actual.vertices.buffer.byteLength).toBe(actual.vertices.byteLength);
  for (const key of ['batches', 'entities', 'sourceBounds', 'extent', 'minRatio', 'padding', 'entityCount'] as const) expect(actual[key]).toEqual(ordinary[key]);
}

function failureOf(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error('Expected source admission to refuse');
}

afterEach(() => vi.restoreAllMocks());

describe('bounded immutable direct-LINE zoom certificate', () => {
  it.each([1, 1.2, 1.25, 2, 3])('extends only metadata with identical bytes, slots, painter order and lineweights at DPR%s', (dpr) => {
    const entities: LineEntity[] = Array.from({ length: 1100 }, (_, i) => {
      const x = (i % 41 - 20) / 2, y = (i % 31 - 15) / 2;
      return { ...line, id: String(i), color: i % 7 + 1, lineWeight: i % 5 / 10 + 0.1, a: { x, y }, b: { x: x + 3.5, y: y + 1.2 } };
    });
    entities.splice(1, 0, { ...line, id: 'hidden', layer: 'hidden', a: { x: 2e10, y: 0 }, b: { x: 2e10 + 1, y: 0 } });
    entities.splice(3, 0, { ...line, id: 'zero', a: { x: 0, y: 1 }, b: { x: 0, y: 1 } });
    entities.push({ ...line, id: 'offscreen', a: { x: 80, y: 80 }, b: { x: 81, y: 81 } });
    const state = drawing(entities), camera = { ...view, dpr, lineweights: true }, original = JSON.stringify(state);
    const selected = { selection: new Set(['0', '900']), hover: '2', solidSelection: true };
    const ordinary = prepareZoom2D(state, camera, selected), result = certified(state, camera, selected);
    expect(result.maxRatio).toBe(4); expectUnchangedMesh(result, ordinary);
    expect(result.entities![1]).toBeNull(); expect(result.entities![3]!.count).toBe(0);
    expect(result.entities!.at(-1)!.count).toBe(0); expect(result.sourceBounds.max.x).toBe(810);
    expect(result.batches.some((batch) => batch.alpha === 0.95)).toBe(true);
    // Independent generic per-LINE packing still matches every owned source span.
    for (const index of [0, 2, 3, 900, entities.length - 1]) {
      const entity = entities[index]!, slot = result.entities![index]!;
      const reference = prepareZoomLine(entity, state, camera, selected, result.extent, 4);
      expect(result.vertices.slice(slot.first * GPU_ZOOM_VERTEX_STRIDE, (slot.first + slot.count) * GPU_ZOOM_VERTEX_STRIDE)).toEqual(reference.vertices);
    }
    for (const ratio of [0.8, 1, 1.25, 4]) for (const x of [-result.padding, result.padding]) for (const y of [-result.padding, result.padding]) expect(zoomPrecisionSafe(result, camera, ratio, { x, y })).toBe(true);
    // Full original points, not clipped packed endpoints, own the same source reserve.
    const points = [entities.at(-1)!.a, entities.at(-1)!.b].map((point) => ({ x: camera.width / 2 + point.x * camera.scale, y: camera.height / 2 - point.y * camera.scale }));
    const proof = nativeFloatStrokeBound(points, points, false, result.entities!.at(-1)!.width, camera, 4);
    expect(proof.problem).toBeNull(); expect(proof.errorCss * dpr).toBeLessThanOrEqual(0.0625);
    const extrusion = Math.max(...result.entities!.filter((slot) => !!slot).map((slot) => slot!.width * 5));
    const shader = (Math.max(result.extent.x, result.extent.y) * 4 + result.padding + Math.max(camera.width, camera.height) / 2 + extrusion) * 12 * 2 ** -23 * dpr;
    expect(shader).toBeLessThanOrEqual(0.0625); expect(proof.errorCss * dpr + shader).toBeLessThanOrEqual(0.125);
    expect(JSON.stringify(state)).toBe(original);
  });

  it.each([1, 2, 3])('preserves trillion-unit rebasing and fixed CSS offsets at DPR%s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, delta = 1 / 8192;
    const local = { ...line, lineWeight: 5, a: { x: -1 / 32, y: delta }, b: { x: 1 / 32, y: delta } };
    const shifted = { ...local, a: { x: origin.x + local.a.x, y: origin.y + local.a.y }, b: { x: origin.x + local.b.x, y: origin.y + local.b.y } };
    const camera = { ...view, dpr, scale: 4096, lineweights: true };
    const baseline = certified(drawing([local]), camera), actual = certified(drawing([shifted]), { ...camera, center: origin });
    expect(actual.maxRatio).toBe(4); expectUnchangedMesh(actual, prepareZoom2D(drawing([shifted]), { ...camera, center: origin }, overlay));
    // Entity identity differs between local/shifted snapshots; compare packed spans independently.
    expect(actual.vertices).toEqual(baseline.vertices); expect(actual.sourceBounds).toEqual(baseline.sourceBounds);
    expect(Math.hypot(actual.vertices[2]!, actual.vertices[3]!)).toBeCloseTo(10, 5);
    expect(shifted.a.y - origin.y).toBe(delta);
  });

  it('retains the ordinary band for default, mutable, merely frozen, strict and custom requests', () => {
    const state = drawing([line]);
    expect(prepareZoom2D(state, view, overlay).maxRatio).toBe(1.25);
    for (const snapshot of [{ ...state }, Object.freeze({ ...state }), { ...state, entities: [line] }]) expect(certified(snapshot).maxRatio).toBe(1.25);
    expect(prepareZoom2D(state, view, overlay, undefined, undefined, undefined, { certifyStraightZoomIn: false }).maxRatio).toBe(1.25);
    for (const [min, max, padding] of [[1, 1, 0], [0.9, 1.2, 100], [0.8, 1.25, 100]]) {
      const ordinary = prepareZoom2D(state, view, overlay, min, max, padding), result = prepareZoom2D(state, view, overlay, min, max, padding, { certifyStraightZoomIn: true });
      expect(result.maxRatio).toBe(max); expectUnchangedMesh(result, ordinary);
    }
    for (const type of ['circle', 'arc'] as const) {
      const entity: Entity = type === 'circle' ? { ...line, type, center: { x: 0, y: 0 }, radius: 2 } : { ...line, type, center: { x: 0, y: 0 }, radius: 3, startAngle: 0.2, endAngle: 1.1 };
      const mixed = drawing([line, entity]), ordinary = prepareZoom2D(mixed, view, overlay), result = certified(mixed);
      expect(result.maxRatio).toBe(1.25); expectUnchangedMesh(result, ordinary);
    }
  });

  it('bounds the stronger certificate by all original owner slots, including hidden owners', () => {
    // Scope/count control only: real native Float32 arithmetic is exercised above.
    const prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision').mockImplementation(() => {});
    const zero = { ...line, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
    const sources = Array.from({ length: GPU_EDIT_ENTITY_LIMIT }, (_, i) => ({ ...zero, id: String(i) }));
    const atLimit = certified(drawing(sources));
    expect(atLimit.maxRatio).toBe(4); expect(atLimit.vertices.length).toBe(0); expect(atLimit.entities!.length).toBe(GPU_EDIT_ENTITY_LIMIT);
    expect(prove.mock.calls.every((call) => call[4] === 4)).toBe(true);
    prove.mockClear();
    const above = certified(drawing([...sources, { ...zero, id: 'hidden-limit', layer: 'hidden' }]));
    expect(above.maxRatio).toBe(1.25); expect(above.vertices.length).toBe(0); expect(above.entities).toBeNull();
    expect(prove).toHaveBeenCalledTimes(GPU_EDIT_ENTITY_LIMIT); expect(prove.mock.calls.every((call) => call[4] === 1.25)).toBe(true);
  }, 15000);

  it('keeps ordinary bytes when the larger shader Float32 certificate fails', () => {
    const state = drawing([line]), camera = { ...view, width: 7500, height: 600, dpr: 2 };
    const prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision');
    const ordinary = prepareZoom2D(state, camera, overlay), result = certified(state, camera);
    expect(result.maxRatio).toBe(1.25); expectUnchangedMesh(result, ordinary);
    expect(prove.mock.calls.map((call) => call[4])).toEqual([1.25, 1.25]);
    expect(() => certified(state, { ...camera, width: 30000 })).toThrow('GPU zoom geometry exceeds Float32 precision budget');
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it('allows a weaker interval only after a real native Float32 precision proof fails at4', () => {
    const source = { ...line, lineWeight: 4, a: { x: 400, y: 0 }, b: { x: 400.075, y: 0 } };
    const state = drawing([source]), camera = { ...view, width: 1216, height: 552, scale: 1, lineweights: true };
    const ordinary = prepareZoom2D(state, camera, overlay), prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision');
    const result = certified(state, camera);
    expect(result.maxRatio).toBe(1.25); expectUnchangedMesh(result, ordinary);
    expect(prove.mock.calls.map((call) => call[4])).toEqual([4, 1.25]);
    expect(prove.mock.results[0]!.type).toBe('throw'); expect(isSourcePrecisionCertificateError(prove.mock.results[0]!.value)).toBe(true);
    expect(isSourceTopologyAdmissionError(prove.mock.results[0]!.value)).toBe(false);
  });

  it.each([
    { source: { ...line, a: { x: 2e10, y: 0 }, b: { x: 2e10 + 1, y: 0 } }, camera: { ...view, scale: 1 }, kind: 'topology', calls: [4] },
    { source: { ...line, a: { x: 2e10 - 160, y: 0 }, b: { x: 2e10 - 160 + 8192, y: 0 } }, camera: { ...view, scale: 1 }, kind: 'precision', calls: [4, 1.25] },
    { source: { ...line, lineWeight: 4, a: { x: -1e-6, y: 0 }, b: { x: 0, y: 0 } }, camera: { ...view, width: 1216, height: 552, lineweights: true }, kind: 'topology', calls: [4] },
    { source: line, camera: { ...view, twist: 0.17 }, kind: 'topology', calls: [4] },
    { source: line, camera: { ...view, dpr: Number.MIN_VALUE }, kind: 'topology', calls: [4] },
  ])('preserves complete refusal for original native source: $kind / $camera.twist', ({ source, camera, kind, calls }) => {
    const state = drawing([{ ...source, id: 'refused' }]), prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision');
    const failure = failureOf(() => certified(state, camera));
    expect(failure).toBeInstanceOf(Error);
    expect(isSourceTopologyAdmissionError(failure)).toBe(kind === 'topology'); expect(isSourcePrecisionCertificateError(failure)).toBe(kind === 'precision');
    expect(prove.mock.calls.filter((call) => call[1].id === 'refused').map((call) => call[4])).toEqual(calls);
    expect(JSON.stringify(state)).toBe(JSON.stringify(drawing([{ ...source, id: 'refused' }])));
  });

  it('checks both original source extrema and pan corners before clipping', () => {
    // Isolate the coordinate-range guard; real native source refusals above occur sooner.
    const prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision').mockImplementation(() => {});
    const bound = 2 ** 36 - 1, padding = 128, half = view.width / 2;
    const axis = (sign: number) => sign > 0 ? (bound - padding - half) / 4 : (-bound + padding - half) / 4;
    for (const sign of [-1, 1]) {
      const source = { ...line, a: { x: axis(sign), y: 0 }, b: { x: axis(sign), y: 0 } }, camera = { ...view, scale: 1 };
      const safe = certified(drawing([source]), camera);
      expect(safe.maxRatio).toBe(4); expect(safe.vertices.length).toBe(0);
      expect(zoomPrecisionSafe(safe, camera, 4, { x: sign * padding, y: 0 })).toBe(true);
      const outside = { ...source, a: { x: source.a.x + sign, y: 0 }, b: { x: source.b.x + sign, y: 0 } };
      const weaker = certified(drawing([outside]), camera);
      expect(weaker.maxRatio).toBe(1.25); expect(weaker.vertices.length).toBe(0);
    }
    expect(prove.mock.calls.some((call) => call[4] === 1.25)).toBe(true);
  });

  it.each([Error, RangeError, TypeError])('does not weaken or hide unexpected %s with precision wording', (ErrorType) => {
    const unexpected = new ErrorType('Unsupported Canvas stroke construction: native float point, normal or miter exceeds precision budget');
    const prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision').mockImplementation(() => { throw unexpected; });
    expect(failureOf(() => certified(drawing([line])))).toBe(unexpected); expect(prove).toHaveBeenCalledOnce();
    expect(prove.mock.calls[0]![4]).toBe(4); expect(isSourcePrecisionCertificateError(unexpected)).toBe(false);
  });

  it('rechecks all sources on an owned precision retry and propagates an unexpected weaker failure', () => {
    const state = drawing([line, { ...line, id: 'last', a: { x: 0, y: 1 }, b: { x: 1, y: 1 } }]);
    const original = parity.assertPrimitiveStrokePrecision, intentional = sourcePrecisionCertificateError('precision'), unexpected = new RangeError('precision');
    const prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision').mockImplementation((local, native, width, camera, ratio) => {
      if (native.id === 'last') throw ratio === 4 ? intentional : unexpected;
      original(local, native, width, camera, ratio);
    });
    expect(failureOf(() => certified(state))).toBe(unexpected);
    expect(prove.mock.calls.map((call) => [call[1].id, call[4]])).toEqual([['line', 4], ['last', 4], ['line', 1.25], ['last', 1.25]]);
  });

  it('never retries a deliberate topology refusal or a later packing exception', () => {
    const topology = sourceTopologyAdmissionError('topology'), prove = vi.spyOn(parity, 'assertPrimitiveStrokePrecision').mockImplementation(() => { throw topology; });
    expect(failureOf(() => certified(drawing([line])))).toBe(topology); expect(prove).toHaveBeenCalledOnce();
    prove.mockRestore();
    const proof = vi.spyOn(parity, 'assertPrimitiveStrokePrecision'), nativeRound = Math.fround, packing = new RangeError('precision');
    // Passing source proof is separate from typed-packing; a later native error must escape.
    const rounds = vi.spyOn(Math, 'fround').mockImplementation((value) => {
      if (value === -20) throw packing;
      return nativeRound(value);
    });
    expect(failureOf(() => certified(drawing([line])))).toBe(packing); expect(proof).toHaveBeenCalledOnce(); expect(proof.mock.calls[0]![4]).toBe(4);
    rounds.mockRestore();
  });

  it('restores global Canvas styles after both successful and failed source preflight', () => {
    const paper = colorDisplay.paper, weights = { ...lineweightDisplay };
    try {
      colorDisplay.paper = true; lineweightDisplay.enabled = true; lineweightDisplay.pxPerMm = 123;
      certified(drawing([line]));
      expect(colorDisplay.paper).toBe(true); expect(lineweightDisplay).toEqual({ ...weights, enabled: true, pxPerMm: 123 });
      expect(() => certified(drawing([line]), { ...view, twist: 0.17 })).toThrow('native context rotation is unproved');
      expect(colorDisplay.paper).toBe(true); expect(lineweightDisplay).toEqual({ ...weights, enabled: true, pxPerMm: 123 });
    } finally { colorDisplay.paper = paper; Object.assign(lineweightDisplay, weights); }
  });
});
