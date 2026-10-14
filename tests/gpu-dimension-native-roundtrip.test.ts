// Real current DXF reader/writer and immutable Drawing contracts; no app/IPC/native raster claim.
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DimensionEntity, DimKind } from '../src/core/dimension';
import type { Entity } from '../src/core/entities';
// @ts-expect-error Independent Node-side JavaScript source fixture, also checked by typecheck:scripts.
import { originalDimensionEntities, dimensionKinds } from '../scripts/gpu-dimension-cases.mjs';
// @ts-expect-error Independent Node-side JavaScript codec contract, also checked by typecheck:scripts.
import { measurement, verifyReopenedDimension, verifySavedNativeDimensions } from '../scripts/gpu-dimension-roundtrip.mjs';
const kinds = dimensionKinds as readonly DimKind[];
const isDimension = (entity: Entity): entity is DimensionEntity => entity.type === 'dimension';
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
