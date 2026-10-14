// PRIVATE DRAFT: intended tracked location tests/gpu-dimension-native-source.test.ts.
// Not run. Native Canvas raster, shader topology, cache/GL behavior require later compiler tests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE, type DimensionEntity } from '../src/core/dimension';
import { dimensionParts } from '../src/core/entities';
import * as entities from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import type { Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { lowerDimensionStrokes } from '../src/render/gpu-prototype/dimension-strokes';
import { certifyDimensionTriangleSource, isNativeDimensionSourceCertificate } from '../src/render/gpu-prototype/dimension-native-source';
import { assertStrokePathPrecision } from '../src/render/gpu-prototype/stroke-parity';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const zero = { x: 0, y: 0 };
const view: Gpu2DView = { width: 800, height: 600, scale: 20, dpr: 1, center: zero, twist: 0, background: '#212830' };
const dimension = (patch: Partial<DimensionEntity> = {}): DimensionEntity => ({ id: 'D', type: 'dimension', kind: 'linear', layer: '0', color: 3, p1: zero, p2: { x: 8, y: 1 }, linePoint: { x: 4, y: 4 }, rotation: 0, style: { ...STANDARD_DIMSTYLE }, ...patch });
const state = (source: DimensionEntity): DrawingState => sealImmutableData({ entities: [source], blocks: {}, layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }], currentLayer: '0' });
const lower = (source: DimensionEntity, drawing = state(source), nativeView = view) => lowerDimensionStrokes(source, drawing, { anchor: nativeView.center, widthCss: 1, nativeView, minRatio: 0.8, maxRatio: 4 });
afterEach(() => vi.restoreAllMocks());

describe('GPU independently generated original WORLD dimension source', () => {
  it.each(['linear', 'aligned', 'radius', 'diameter', 'angular'] as const)('pairs original %s parts in exact painter order at zero twist', kind => {
    const source = dimension({ kind, ...(kind === 'angular' ? { center: zero, p1: { x: 5, y: 0 }, p2: { x: 0, y: 5 }, linePoint: { x: 9, y: 9 } } : {}) });
    const drawing = state(source), before = JSON.stringify(drawing), actual = dimensionParts(source);
    const result = lower(source, drawing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.cause;
    const certificate = result.nativeSourceCertificate!;
    expect(isNativeDimensionSourceCertificate(certificate)).toBe(true);
    expect(isNativeDimensionSourceCertificate({ ...certificate })).toBe(false);
    expect(certificate.originalWorldParts).toEqual(actual);
    expect(certificate.originalWorldParts).not.toBe(actual);
    expect(certificate.originalWorldParts.map(part => part.id)).toEqual(result.parts.map(part => part.source.id));
    expect(certificate.triangleCertificates.filter(Boolean)).toHaveLength(result.parts.filter(part => part.kind === 'fillTriangle').length);
    expect(certificate.sourcePoints).toEqual(expect.arrayContaining([source.p1, source.p2, source.linePoint]));
    expect(Object.isFrozen(certificate.localParts)).toBe(true);
    expect(Object.isFrozen(certificate.triangleCertificates)).toBe(true);
    expect(JSON.stringify(drawing)).toBe(before);
  });

  it('preserves the pure helper contract while refusing its old huge-origin native claim', () => {
    const anchor = { x: 1e12, y: -1e12 }, at = (x: number, y: number) => ({ x: anchor.x + x / 8192, y: anchor.y + y / 8192 });
    const source = dimension({ p1: at(1, -2), p2: at(25, 14), linePoint: at(13, 28), textPosition: at(11, 13), textRotation: 0.31, style: { ...STANDARD_DIMSTYLE, scale: 1 / 8192 } });
    const drawing = state(source), nativeView = { ...view, center: anchor, scale: 1e6 };
    expect(lowerDimensionStrokes(source, drawing, { anchor, widthCss: 1 }).ok).toBe(true);
    expect(lower(source, drawing, nativeView).ok).toBe(false);
  });

  it.each([0.17, 0.37, 0.63])('keeps the original nonzero twist %s as complete Canvas', twist => {
    const source = dimension();
    expect(lower(source, state(source), { ...view, twist })).toMatchObject({ ok: false, reason: expect.stringContaining('rotation') });
  });

  it('refuses block descendants and mutable sources without hiding the cause', () => {
    const source = dimension();
    const mutable: DrawingState = { entities: [source], blocks: {}, layers: [], currentLayer: '0' };
    expect(lower(source, mutable)).toMatchObject({ ok: false, reason: expect.stringContaining('mutable') });
    const drawing = state(source);
    expect(lower(source, { ...drawing, entities: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('block') });
  });

  it('refuses a real cache populated before source text mutation and sealing', () => {
    const source = dimension({ text: 'CACHED' });
    dimensionParts(source);
    (source as unknown as { text: string }).text = 'LIVE';
    const drawing = state(source);
    expect(lower(source, drawing)).toMatchObject({ ok: false, reason: expect.stringContaining('stale Canvas dimension part cache') });
  });

  it('refuses native role/string/font/order drift instead of pairing by reconstructed coordinates', () => {
    const source = dimension(), drawing = state(source), original = dimensionParts(source);
    vi.spyOn(entities, 'dimensionParts').mockImplementation(entity => entity === source ? original : original.map(part => part.type === 'text' ? { ...part, text: 'WRONG' } : part));
    expect(lower(source, drawing)).toMatchObject({ ok: false, reason: expect.stringContaining('layout, string, font, role or painter order') });
  });

  it('keeps a native RangeError and a lookalike Error as original unknown causes', () => {
    for (const cause of [new RangeError('native allocation failed'), new Error('Unsupported Canvas stroke construction: dimension filled triangle area margin is unproved')]) {
      vi.spyOn(entities, 'dimensionParts').mockImplementation(() => { throw cause; });
      const source = dimension(), result = lower(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected refusal');
      expect(result.cause).toBe(cause);
      expect(isSourcePrecisionCertificateError(result.cause)).toBe(false);
      expect(isSourceTopologyAdmissionError(result.cause)).toBe(false);
      expect(Object.keys(result)).toEqual(['ok', 'reason']);
      vi.restoreAllMocks();
    }
  });

  it('charges original/fresh/copy/nonpainted points before copying complete original parts', () => {
    const source = dimension(), drawing = state(source);
    const result = lower(source, drawing);
    if (!result.ok) throw result.cause;
    const charge = result.pointCount;
    expect(lowerDimensionStrokes(source, drawing, { anchor: zero, widthCss: 1, nativeView: view, maxPoints: charge - 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('point budget') });
  });

  it('keeps unsupported real TrueType dimension fonts on Canvas', () => {
    const source = dimension({ style: { ...STANDARD_DIMSTYLE, textStyle: 'NativeTTF' } });
    const drawing = sealImmutableData({ ...state(source), meta: { textStyles: { NativeTTF: { ...STANDARD_TEXT_STYLE, name: 'NativeTTF', font: 'arial.ttf' } } } });
    expect(lower(source, drawing)).toMatchObject({ ok: false, reason: expect.stringContaining('font') });
  });
});

describe('strict three-vertex filled arrow source area', () => {
  const triangle: readonly [Point, Point, Point] = [zero, { x: 5, y: 0 }, { x: 0, y: 2 }];
  it.each([1, 1.25, 2, 2.5, 4 / 3])('certifies both windings over .8..4 and original native DPR %s', dpr => {
    const a = certifyDimensionTriangleSource(triangle, triangle, 1, { ...view, dpr }, 0.8, 4);
    const reversed: readonly [Point, Point, Point] = [triangle[0], triangle[2], triangle[1]];
    const b = certifyDimensionTriangleSource(reversed, reversed, 1, { ...view, dpr }, 0.8, 4);
    expect(a.winding).toBe(-b.winding); expect(a.minimumAreaMarginCssSquared).toBeGreaterThan(0); expect(b.minimumAreaMarginCssSquared).toBeGreaterThan(0);
  });
  const unsafeTriangles: readonly (readonly [Point, Point, Point])[] = [
    [zero, zero, { x: 1, y: 1 }],
    [zero, { x: 1, y: 0 }, { x: 2, y: 0 }],
    [zero, { x: 100, y: 0 }, { x: 200, y: 0.3 }],
  ];
  it.each(unsafeTriangles.map(points => ({ points })))('refuses degenerate or insufficient area source %j', ({ points }) => {
    try { certifyDimensionTriangleSource(points, points, 1, { ...view, scale: 1 }, 0.8, 4); throw new Error('Unsafe triangle admitted'); }
    catch (error) { expect(isSourcePrecisionCertificateError(error) || isSourceTopologyAdmissionError(error)).toBe(true); }
  });
  it('refuses insufficient fill area even when the existing closed-stroke reserve passes', () => {
    const skinny: readonly [Point, Point, Point] = [zero, { x: 0.1, y: 0 }, { x: 0, y: 0.1 }];
    const fixed = { ...view, scale: 1 };
    expect(() => assertStrokePathPrecision(skinny, skinny, true, 1, fixed, 4)).not.toThrow();
    expect(() => certifyDimensionTriangleSource(skinny, skinny, 1, fixed, 0.8, 4)).toThrow('filled triangle area margin is unproved');
  });
  it('does not manufacture original WORLD arrows by re-adding the camera to local parts', () => {
    const original: readonly [Point, Point, Point] = [zero, { x: 0, y: 0 }, { x: 0, y: 0 }];
    expect(() => certifyDimensionTriangleSource(triangle, original, 1, view, 0.8, 4)).toThrow();
  });
  it('refuses nonfinite/subnormal source topology conservatively', () => {
    for (const points of [[zero, { x: Infinity, y: 0 }, { x: 0, y: 1 }], [zero, { x: Number.MIN_VALUE, y: 0 }, { x: 0, y: Number.MIN_VALUE }]] as (readonly [Point, Point, Point])[]) expect(() => certifyDimensionTriangleSource(points, points, 1, view, 0.8, 4)).toThrow();
  });
});
