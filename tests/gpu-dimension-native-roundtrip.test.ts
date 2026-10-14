// Real current DXF reader/writer and immutable Drawing contracts; no app/IPC/native raster claim.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DimensionEntity, DimKind } from '../src/core/dimension';
import * as dimensions from '../src/core/dimension';
import type { Entity } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { dimensionParts } from '../src/core/entities';
import type { TextGeometryContext } from '../src/core/text-metrics';
import { lowerDimensionStrokes } from '../src/render/gpu-prototype/dimension-strokes';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import type { Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { DIMENSION_POINT_PREPARATION_BOUND } from '../src/render/gpu-prototype/dimension-budget';
// @ts-expect-error Independent Node-side JavaScript source fixture, also checked by typecheck:scripts.
import { originalDimensionEntities, dimensionKinds } from '../scripts/gpu-dimension-cases.mjs';
// @ts-expect-error Independent Node-side JavaScript codec contract, also checked by typecheck:scripts.
import { measurement, verifyReopenedDimension, verifySavedNativeDimensions } from '../scripts/gpu-dimension-roundtrip.mjs';
const kinds = dimensionKinds as readonly DimKind[];
const isDimension = (entity: Entity): entity is DimensionEntity => entity.type === 'dimension';
afterEach(() => vi.restoreAllMocks());
function linearSource(entities: readonly Entity[]): DimensionEntity {
  const source = entities.find((entity) => entity.id === 'linear');
  if (!source || source.type !== 'dimension') throw new Error('Original linear dimension is required');
  return source;
}
function pair(data: ReturnType<typeof roundtrip>, index: number): [DimensionEntity, DimensionEntity] {
  const original = data.original[index], actual = data.reopened[index];
  if (!original || !actual) throw new Error('Original and reopened native dimension slots are required');
  return [original, actual];
}
function roundtrip(edited = false) {
  const drawing = new Drawing({ entities: originalDimensionEntities() as Entity[], layers: [{ name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 }], blocks: {}, currentLayer: '0' });
  if (edited) {
    const source = linearSource(drawing.entities);
    if (!source.textPosition) throw new Error('Original explicit text position is required');
    drawing.replaceEntities([{ ...source, p2: { ...source.p2, x: source.p2.x + 1 }, text: 'DIM <>', textPosition: { x: source.textPosition.x - 0.2, y: source.textPosition.y + 0.3 } }]);
  }
  const before = drawing.snapshot, frozen = JSON.stringify(before), bytes = writeDxf(before), after = readDxf(bytes);
  expect(JSON.stringify(before)).toBe(frozen);
  return { before, after, bytes, original: before.entities.filter(isDimension), reopened: after.entities.filter(isDimension) };
}

describe('field-specific DIMENSION native DXF contract (real codec, no apps)', () => {
  it.each(kinds)('preserves %s measurement/style/appearance with only predicted native anchors', (kind) => {
    const data = roundtrip();
    expect(verifySavedNativeDimensions(data.bytes, data.original)).toHaveLength(5);
    const [original, actual] = pair(data, data.original.findIndex((entity) => entity.kind === kind));
    const proof = verifyReopenedDimension(actual, original);
    expect(proof.exactRawAuthoringSource).toBe(false);
    expect(measurement(actual)).toBeCloseTo(measurement(original), 8);
    if (kind === 'linear' || kind === 'aligned') expect(actual.linePoint).not.toEqual(original.linePoint);
    if (kind === 'radius' || kind === 'diameter') expect(actual.p2).not.toEqual(original.p2);
    if (kind === 'angular') expect(actual.linePoint).toEqual(original.linePoint);
  });
  it('preserves actual immutable DIM edit/undo/redo and native edited raw text/explicit text position', () => {
    const data = roundtrip(true), [original, linear] = pair(data, 0);
    expect(verifySavedNativeDimensions(data.bytes, data.original)).toHaveLength(5);
    expect(original.text).toBe('DIM <>'); expect(linear.text).toBe('DIM <>');
    expect(linear.textPosition).toEqual({ x: -5.2, y: -1.7 }); expect(linear.linePoint).toEqual({ x: 0, y: -2 });
    data.reopened.forEach((entity, index) => verifyReopenedDimension(entity, pair(data, index)[0]));
    const drawing = new Drawing(data.before), prior = drawing.snapshot, source = linearSource(drawing.entities);
    drawing.replaceEntities([{ ...source, p2: { ...source.p2, x: source.p2.x + 0.25 } }]); const changed = drawing.snapshot;
    expect(drawing.undo()).toBe(true); expect(drawing.snapshot).toBe(prior); expect(drawing.redo()).toBe(true); expect(drawing.snapshot).toBe(changed);
  });
  const defects: Array<[string, number, (entity: DimensionEntity, original: DimensionEntity) => DimensionEntity]> = [
    ['linear perpendicular locus', 0, (entity) => ({ ...entity, linePoint: { ...entity.linePoint, y: entity.linePoint.y + 0.25 } })],
    ['equal-radius but wrong native q', 2, (entity, original) => ({ ...entity, p2: structuredClone(original.p2) })],
    ['raw text', 0, (entity) => ({ ...entity, text: 'CHANGED' })],
    ['effective extension color', 0, (entity) => ({ ...entity, style: { ...entity.style, extLineColor: 1 } })],
    ['owner trueColor', 0, (entity) => ({ ...entity, trueColor: 0x112233 })],
    ['unknown gained style property', 0, (entity) => { const style = { ...entity.style, unexpected: 1 }; return { ...entity, style }; }],
  ];
  it.each(defects)('rejects %s loss rather than broadly exempting canonicalized fields', (_name, index, alter) => {
    const data = roundtrip(true), [original, actual] = pair(data, index), changed = alter(structuredClone(actual), original);
    expect(() => verifyReopenedDimension(changed, original)).toThrow();
  });
});

describe('native reopened aligned text orientation under camera translation (real codec, no GPU)', () => {
  const camera = (center: { x: number; y: number }): Gpu2DView => ({ width: 800, height: 600, scale: 42, dpr: 1, center, twist: 0, background: '#212830' });
  const capturedContext = (): TextGeometryContext => ({
    cacheKey: {}, resolve: vi.fn(() => ({ kind: 'stroke' as const, widthFactor: 1, oblique: 0 })),
    measure: vi.fn(() => { throw new Error('Hershey native certification must not consume uncertified metrics'); }),
  });
  const alignedSource = (doc: Drawing): DimensionEntity => {
    const source = doc.entities.find((entity): entity is DimensionEntity => entity.type === 'dimension' && entity.kind === 'aligned');
    if (!source) throw new Error('Native aligned dimension is required');
    return source;
  };
  it.each([{ x: -0.1, y: 0.1 }, { x: -18 / 42, y: -12 / 42 }, { x: -18 / (1.25 * 42), y: -12 / (1.25 * 42) }, { x: 2.125, y: -1.375 }])('keeps actual WORLD orientation at pan %j with every original source and certificate check', center => {
    const geometry = capturedContext(), data = roundtrip(true), doc = new Drawing(data.after, () => geometry);
    const source = alignedSource(doc), before = JSON.stringify(doc.snapshot), history = doc.history();
    const world = dimensionParts(source, geometry), worldText = world.find(part => part.type === 'text')!;
    const lower = lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center), minRatio: 0.8, maxRatio: 1.25 });
    expect(lower.ok).toBe(true);
    if (!lower.ok) throw lower.cause;
    const certificate = lower.nativeSourceCertificate!;
    expect(certificate.originalWorldParts).toEqual(world);
    expect(certificate.localParts.find(part => part.type === 'text')!.rotation).toBe(worldText.rotation);
    expect(certificate.textGeometryDependency).toBe(geometry); expect(certificate.metricKeyDependency).toBe(geometry.cacheKey);
    expect(certificate.layoutPasses).toBe(3);
    // Full Hershey glyph/world precision certification still runs before a scene is returned.
    expect(lowerStrokeScene(doc.snapshot, camera(center), { selection: new Set() }, { lookup: doc.lookupBlock }).ok).toBe(true);
    expect(dimensionParts(source, geometry)).toBe(world);
    expect(JSON.stringify(doc.snapshot)).toBe(before); expect(doc.history()).toEqual(history);
    expect(source.textRotation).toBeUndefined(); expect(geometry.measure).not.toHaveBeenCalled();
  });

  it.each([{ textRotation: 0.37 }, { style: { textAlign: 'horizontal' as const } }, { style: { textAlign: 'iso' as const } }])('retains explicit and alternate text layout %j without adding an orientation override', patch => {
    const geometry = capturedContext(), doc = new Drawing(roundtrip(true).after, () => geometry), original = alignedSource(doc);
    doc.replaceEntities([{ ...original, ...patch, style: { ...original.style, ...('style' in patch ? patch.style : {}) } }]);
    const source = alignedSource(doc), before = JSON.stringify(source), center = { x: -0.1, y: 0.1 };
    const spy = vi.spyOn(entities, 'dimensionParts');
    const result = lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center) });
    if ('style' in patch && patch.style?.textAlign === 'iso') {
      // ISO placement is outside this construction change: its actual angle drift
      // keeps the original exact certificate refusal, with no partial parts.
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('layout, string, font, role or painter order changes') });
      expect(result).not.toHaveProperty('parts');
    } else expect(result.ok).toBe(true);
    const localCall = spy.mock.calls.find(([dimension]) => dimension !== source)!;
    expect(localCall[0].textRotation).toBe(source.textRotation);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('reuses the captured WORLD cache within the original three layout passes and point/work budgets', () => {
    const geometry = capturedContext(), doc = new Drawing(roundtrip(true).after, () => geometry), source = alignedSource(doc), center = { x: -0.1, y: 0.1 };
    const partSpy = vi.spyOn(entities, 'dimensionParts'), layoutSpy = vi.spyOn(dimensions, 'dimensionGeometry');
    const result = lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.cause;
    expect(layoutSpy).toHaveBeenCalledTimes(3);
    expect(partSpy.mock.calls.filter(([dimension]) => dimension === source)).toHaveLength(2);
    expect(partSpy.mock.results[0]!.value).toBe(partSpy.mock.results[2]!.value);
    expect(partSpy.mock.calls.every(([, context]) => context === geometry)).toBe(true);
    // The original conservative preparation bound remains larger than the
    // returned point charge; it must not be replaced by that smaller count.
    expect(result.pointCount).toBeLessThanOrEqual(DIMENSION_POINT_PREPARATION_BOUND);
    const bounded = lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center), maxPoints: DIMENSION_POINT_PREPARATION_BOUND, maxWork: result.preparationWork });
    expect(bounded.ok).toBe(true);
    expect(lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center), maxPoints: result.pointCount - 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('point budget') });
    expect(lowerDimensionStrokes(source, doc.snapshot, { lookup: doc.lookupBlock, anchor: center, widthCss: 1, nativeView: camera(center), maxWork: result.preparationWork! - 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('work') });
  });

  it('preserves the pure helper construction rather than silently pinning its text angle', () => {
    const doc = new Drawing(roundtrip(true).after), source = alignedSource(doc), center = { x: -0.1, y: 0.1 }, spy = vi.spyOn(entities, 'dimensionParts');
    const result = lowerDimensionStrokes(source, doc.snapshot, { anchor: center, widthCss: 1 });
    expect(result.ok).toBe(true); expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].textRotation).toBeUndefined();
    const localText = spy.mock.results[0]!.value.find((part: Entity) => part.type === 'text');
    const worldText = dimensionParts(source).find(part => part.type === 'text');
    expect(localText.rotation).not.toBe(worldText!.rotation); // This was the native-admission counterexample.
  });
});
