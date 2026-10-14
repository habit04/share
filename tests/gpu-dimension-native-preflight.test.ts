import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE, type DimensionEntity } from '../src/core/dimension';
import * as dimensions from '../src/core/dimension';
import * as entities from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import type { Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { lowerDimensionStrokes } from '../src/render/gpu-prototype/dimension-strokes';
import { certifyDimensionNativeSource } from '../src/render/gpu-prototype/dimension-native-source';

const zero = { x: 0, y: 0 };
const view: Gpu2DView = { width: 800, height: 600, dpr: 1, scale: 20, center: zero, twist: 0, background: '#212830' };
const dimension = (patch: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: 'D', type: 'dimension', kind: 'linear', layer: '0', color: 3,
  p1: zero, p2: { x: 8, y: 1 }, linePoint: { x: 4, y: 4 }, rotation: 0,
  style: { ...STANDARD_DIMSTYLE }, ...patch,
});
const drawing = (source: DimensionEntity): DrawingState => sealImmutableData({
  entities: [source], layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }], blocks: {}, currentLayer: '0',
});

afterEach(() => vi.restoreAllMocks());
describe('native-only dimension preallocation dependency', () => {
  it.each([
    ['unknown style', { style: { ...STANDARD_DIMSTYLE, unexpected: 1 } }, 'unknown style key'],
    ['nested style', { style: { ...STANDARD_DIMSTYLE, scale: { nested: 1 } } }, 'style numeric value'],
    ['amplified template', { text: '<>'.repeat(100), style: { ...STANDARD_DIMSTYLE, post: '<>'.repeat(100) } }, 'amplification'],
  ] as const)('rejects %s before native lowerer resolves/layouts', (_name, patch, reason) => {
    const source = dimension(patch as unknown as Partial<DimensionEntity>);
    const state = drawing(source);
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    expect(lowerDimensionStrokes(source, state, { anchor: zero, widthCss: 1, nativeView: view })).toMatchObject({
      ok: false, reason: expect.stringContaining(reason),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
    expect(state.entities[0]).toBe(source);
  });

  it.each([
    ['work', { maxWork: 1 }, 'work budget'],
    ['points', { maxPoints: 388 }, 'point budget'],
    ['parts', { maxParts: 15 }, 'part budget'],
    ['characters', { maxTextCharacters: 1 }, 'character budget'],
  ] as const)('enforces native %s preparation allowance before layout', (_name, limits, reason) => {
    const source = dimension();
    const state = drawing(source);
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    expect(lowerDimensionStrokes(source, state, { anchor: zero, widthCss: 1, nativeView: view, ...limits })).toMatchObject({
      ok: false, reason: expect.stringContaining(reason),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
  });

  it('bounds standalone original-WORLD certification before its canonical allocation', () => {
    const source = dimension({ style: { ...STANDARD_DIMSTYLE, unexpected: 1 } } as unknown as Partial<DimensionEntity>);
    const state = drawing(source);
    const resolver = vi.spyOn(dimensions, 'resolveDimStyle');
    const parts = vi.spyOn(entities, 'dimensionParts');
    expect(() => certifyDimensionNativeSource(source, [], state, {
      view, widthCss: 1, minRatio: 0.8, maxRatio: 4, maxPoints: 4_096, maxParts: 16,
    })).toThrow('unknown style key');
    expect(resolver).not.toHaveBeenCalled();
    expect(parts).not.toHaveBeenCalled();
  });

  it('leaves the legacy pure helper outside the new native-only caps', () => {
    const source = dimension();
    const state = drawing(source);
    const result = lowerDimensionStrokes(source, state, { anchor: zero, widthCss: 1, maxWork: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.cause;
    expect(result).not.toHaveProperty('preparationWork');
    expect(result).not.toHaveProperty('nativeSourceCertificate');
  });
});
