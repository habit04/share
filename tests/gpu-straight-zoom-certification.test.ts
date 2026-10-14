import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import * as hershey from '../src/render/hershey';
import { GPU_STRAIGHT_ZOOM_CACHE_MAX_RATIO, prepareCompiledZoom2D, prepareZoom2D, zoomPrecisionSafe, type Gpu2DOverlay, type Gpu2DView, type PreparedZoom2D } from '../src/render/gpu-prototype/geometry2d';
import * as strokeScene from '../src/render/gpu-prototype/stroke-scene';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError, sourcePrecisionCertificateError, sourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 10, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay: Gpu2DOverlay = { selection: new Set<string>() };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const text: TextEntity = { id: 'text', type: 'text', layer: '0', color: 1, position: { x: 0, y: 0 }, text: 'TAG A1', height: 1, rotation: 0, align: 'left' };
const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [{ ...line, id: 'child-line' }, { ...text, id: 'child-text', position: { x: 0, y: 2 }, text: 'B2' }], attributes: [{ tag: 'LABEL', prompt: '', default: 'A3', position: { x: 1, y: -2 }, height: 1, align: 'left' }] };
const insert: InsertEntity = { id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 3, y: 1 }, scale: 1, rotation: 0.2, attributes: { LABEL: 'C4' } };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => sealImmutableData({ entities, blocks, layers: [layer], currentLayer: '0' });
const certified = (state: DrawingState, camera = view, ov = overlay) => prepareZoom2D(state, camera, ov, undefined, undefined, undefined, { certifyStraightZoomIn: true });
const bytes = (geometry: PreparedZoom2D) => new Uint8Array(geometry.vertices.buffer, geometry.vertices.byteOffset, geometry.vertices.byteLength);

function expectUnchangedMesh(actual: PreparedZoom2D, ordinary: PreparedZoom2D): void {
  expect(bytes(actual)).toEqual(bytes(ordinary));
  expect(actual.batches).toEqual(ordinary.batches);
  expect(actual.entities).toEqual(ordinary.entities);
  expect(actual.sourceBounds).toEqual(ordinary.sourceBounds);
  expect(actual.extent).toEqual(ordinary.extent);
  expect(actual.padding).toBe(ordinary.padding);
  expect(actual.minRatio).toBe(ordinary.minRatio);
  expect(actual.entityCount).toBe(ordinary.entityCount);
}

afterEach(() => vi.restoreAllMocks());

describe('proved straight compound zoom-IN interval', () => {
  it.each([1, 2, 3])('certifies ratio4 with identical straight packing/order/alpha/weights at DPR%s', (dpr) => {
    const poly: PolylineEntity = { ...line, id: 'poly', type: 'polyline', color: 4, points: [{ x: -4, y: -2 }, { x: 0, y: 3 }, { x: 4, y: -2 }], closed: true };
    const state = drawing([line, insert, poly, text], { B: block });
    const camera = { ...view, dpr, lineweights: true };
    const ov = { selection: new Set(['insert']), hover: 'text', solidSelection: true };
    const snapshot = JSON.stringify(state);
    const ordinary = prepareZoom2D(state, camera, ov), result = certified(state, camera, ov);
    expect(result.maxRatio).toBe(GPU_STRAIGHT_ZOOM_CACHE_MAX_RATIO);
    expectUnchangedMesh(result, ordinary);
    expect(result.batches.some((batch) => batch.alpha === 0.95)).toBe(true);
    expect(zoomPrecisionSafe(result, camera, 4, { x: result.padding, y: -result.padding })).toBe(true);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it.each([1, 2, 3])('preserves the original twisted scene as complete Canvas at DPR%s', (dpr) => {
    const poly: PolylineEntity = { ...line, id: 'poly', type: 'polyline', color: 4, points: [{ x: -4, y: -2 }, { x: 0, y: 3 }, { x: 4, y: -2 }], closed: true };
    const state = drawing([line, insert, poly, text], { B: block });
    const camera = { ...view, dpr, twist: 0.17, lineweights: true };
    const ov = { selection: new Set(['insert']), hover: 'text', solidSelection: true };
    const snapshot = JSON.stringify(state), lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    let failure: unknown;
    try { certified(state, camera, ov); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isSourceTopologyAdmissionError((failure as Error).cause)).toBe(true);
    expect(isSourcePrecisionCertificateError((failure as Error).cause)).toBe(false);
    expect(lower).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it.each([1, 2, 3])('keeps large-world anchor subtraction and source parity at DPR%s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 };
    const state = drawing([{ ...insert, position: origin }, { ...text, position: origin, height: 4 }], { B: { ...block, attributes: [], entities: [line] } });
    const camera = { ...view, dpr, scale: 1, center: origin };
    const ordinary = prepareZoom2D(state, camera, overlay), result = certified(state, camera);
    expect(result.maxRatio).toBe(4);
    expectUnchangedMesh(result, ordinary);
    expect(Array.from(result.vertices).every(Number.isFinite)).toBe(true);
  });

  it('preserves ordinary admission when the stronger native construction certificate fails', () => {
    const origin = { x: 7e11, y: 0 };
    const state = drawing([{ ...insert, rotation: 0, position: origin }], { B: { ...block, entities: [line], attributes: [] } });
    const camera = { ...view, center: origin };
    const ordinary = prepareZoom2D(state, camera, overlay);
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    const result = certified(state, camera);
    expect(lower.mock.calls.map((call) => call[3]?.maxRatio)).toEqual([4, 1.25]);
    const strongFailure = lower.mock.results[0]!.value as ReturnType<typeof strokeScene.lowerStrokeScene>;
    expect(strongFailure.ok).toBe(false);
    if (!strongFailure.ok) expect(isSourcePrecisionCertificateError(strongFailure.cause)).toBe(true);
    expect(result.maxRatio).toBe(1.25);
    expectUnchangedMesh(result, ordinary);
  });

  it('rejects the larger Float32 certificate before packing, while keeping ordinary bytes', () => {
    const state = drawing([line, text]), camera = { ...view, width: 7500, height: 600, dpr: 2 };
    const ordinary = prepareZoom2D(state, camera, overlay), result = certified(state, camera);
    expect(result.maxRatio).toBe(1.25);
    expectUnchangedMesh(result, ordinary);
  });

  it('preserves the collapsed original offscreen LINE as complete Canvas topology fallback', () => {
    const remote = { ...line, id: 'remote', a: { x: 2e10, y: 0 }, b: { x: 2e10 + 1, y: 0 } };
    const state = drawing([remote, { ...text, height: 4 }]), camera = { ...view, scale: 1 };
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    let failure: unknown;
    try { certified(state, camera); } catch (error) { failure = error; }
    expect((failure as Error).message).toContain('native float segment topology is unproved');
    expect(isSourceTopologyAdmissionError((failure as Error).cause)).toBe(true);
    expect(isSourcePrecisionCertificateError((failure as Error).cause)).toBe(false);
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('certifies unpainted noncollapsing offscreen LINE precision before allowing any mesh', () => {
    const remote = { ...line, id: 'remote', a: { x: 2e10 - view.width / 2, y: 0 }, b: { x: 2e10 - view.width / 2 + 8192, y: 0 } };
    const camera = { ...view, scale: 1 }, state = drawing([remote, { ...text, height: 4 }]);
    // Actual native Float32 endpoint topology is distinct; the whole interval's
    // .0625 source error nevertheless dominates the looser 2^36 projection guard.
    expect(Math.fround(remote.a.x + camera.width / 2)).not.toBe(Math.fround(remote.b.x + camera.width / 2));
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    let failure: unknown;
    try { certified(state, camera); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isSourcePrecisionCertificateError((failure as Error).cause)).toBe(true);
    expect(isSourceTopologyAdmissionError((failure as Error).cause)).toBe(false);
    expect(lower.mock.calls.map((call) => call[3]?.maxRatio)).toEqual([4, 1.25]);
  });

  it.each([2.49, 2.5, 2.51])('preserves the exact QTEXT decision and lower interval at %spx', (px) => {
    const state = drawing([{ ...text, height: px / view.scale }]);
    const ordinary = prepareZoom2D(state, view, overlay), result = certified(state);
    expectUnchangedMesh(result, ordinary);
    if (px < 2.5) {
      expect(result.maxRatio).toBe(ordinary.maxRatio);
      expect(result.maxRatio).toBeLessThan(2.5 / px);
    } else {
      expect(result.maxRatio).toBe(4);
      expect(result.minRatio).toBe(ordinary.minRatio);
    }
  });

  it.each(['circle', 'arc'] as const)('preserves %s density and the ordinary1.25 interval', (type) => {
    const curve: Entity = type === 'circle' ? { ...line, type, center: { x: 0, y: 0 }, radius: 2 }
      : { ...line, type, center: { x: 0, y: 0 }, radius: 3, startAngle: 0.2, endAngle: 1.1 };
    const state = drawing([curve, text]), ordinary = prepareZoom2D(state, view, overlay), result = certified(state);
    expect(result.maxRatio).toBe(1.25);
    expectUnchangedMesh(result, ordinary);
  });

  it('keeps the ordinary direct all-LINE fast path and strict mutable/custom requests unchanged', () => {
    const state = drawing([line]);
    expect(prepareZoom2D(state, view, overlay).maxRatio).toBe(1.25);
    const compound = drawing([line, text]);
    const strict = prepareZoom2D(compound, view, overlay, 1, 1, 0, { certifyStraightZoomIn: true });
    expect(strict.maxRatio).toBe(1);
    expect(strict.minRatio).toBe(1);
    expect(strict.padding).toBe(0);
    expectUnchangedMesh(strict, prepareZoom2D(compound, view, overlay, 1, 1, 0));
    expect(prepareCompiledZoom2D(compound, view, overlay).maxRatio).toBe(1.25);
  });

  it('does not retry unsupported shape/topology failures', () => {
    const state = drawing([{ ...line, type: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], bulges: [-0.5], closed: false }, text]);
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    expect(() => certified(state)).toThrow('negative bulge has native connector');
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('retains complete Canvas for positive native-float arc topology, without weaker retry', () => {
    const state = drawing([{ ...line, type: 'polyline', points: [{ x: -2, y: 0 }, { x: 2, y: 0 }], bulges: [0.5], closed: false }, text]);
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    let failure: unknown;
    try { certified(state); } catch (error) { failure = error; }
    expect((failure as Error).message).toContain('native float arc connection is unproved');
    expect(isSourceTopologyAdmissionError((failure as Error).cause)).toBe(true);
    expect(isSourcePrecisionCertificateError((failure as Error).cause)).toBe(false);
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it.each([Error, RangeError, TypeError])('does not retry or certify an unexpected %s with identical precision wording', (ErrorType) => {
    const message = 'Canvas world-coordinate quantization exceeds TEXT precision budget (text)';
    const unexpected = new ErrorType(message);
    const glyph = vi.spyOn(hershey, 'glyphFor').mockImplementation(() => { throw unexpected; });
    const lower = vi.spyOn(strokeScene, 'lowerStrokeScene');
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure: unknown;
      try { certified(drawing([text])); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBe(unexpected);
    }
    expect(glyph).toHaveBeenCalledTimes(2);
    expect(lower).toHaveBeenCalledTimes(2);
    expect(isSourcePrecisionCertificateError(unexpected)).toBe(false);
  });

  it('uses weak identity provenance, preserving ordinary plain-Error cause semantics', () => {
    const intentional = sourcePrecisionCertificateError('precision');
    expect(isSourcePrecisionCertificateError(intentional)).toBe(true);
    expect(Object.getPrototypeOf(intentional)).toBe(Error.prototype);
    expect(isSourcePrecisionCertificateError(new Error(intentional.message))).toBe(false);
    expect(isSourcePrecisionCertificateError(new RangeError(intentional.message))).toBe(false);
    expect(isSourcePrecisionCertificateError(new TypeError(intentional.message))).toBe(false);
    expect(isSourcePrecisionCertificateError(new Error('wrapper', { cause: intentional }))).toBe(false);
  });

  it('keeps topology provenance separate from any weaker precision retry', () => {
    const topology = sourceTopologyAdmissionError('topology');
    expect(isSourceTopologyAdmissionError(topology)).toBe(true);
    expect(isSourcePrecisionCertificateError(topology)).toBe(false);
    expect(isSourceTopologyAdmissionError(sourcePrecisionCertificateError('topology'))).toBe(false);
    expect(Object.getPrototypeOf(topology)).toBe(Error.prototype);
    for (const forged of [new Error(topology.message), new RangeError(topology.message), new TypeError(topology.message)]) expect(isSourceTopologyAdmissionError(forged)).toBe(false);
  });
});
