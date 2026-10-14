import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { shapeStylesOf, textStylesOf } from '../src/io/encoding';

const source = readFileSync(new URL('./fixtures/interchange/r2018-complex-linetypes.dxf', import.meta.url), 'utf8');
function signature(state: DrawingState) {
  const values = state.header!.linetypes.filter((lt) => lt.complex).map((lt) => ({ ...lt, complex: { ...lt.complex,
    elements: lt.complex!.elements.map((element) => ({ ...element, style: element.style?.kind === 'text'
      ? { kind: 'text', resource: textStylesOf(state)[element.style.name] }
      : element.style?.kind === 'shape' ? { kind: 'shape', resource: shapeStylesOf(state)[element.style.sourceId] } : element.style })) } }));
  // Native decimal normalization is bounded to 1e-11; presence, order and resource content stay exact.
  return JSON.parse(JSON.stringify(values, (_key, value: unknown) => typeof value === 'number' ? Number(value.toFixed(11)) : value)) as unknown;
}
describe('AutoCAD-normalized complex linetype reference', () => {
  it('imports both independently audited descriptors, padded text, radians and anonymous shape identity', () => {
    const state = readDxf(source), [gas, fence] = state.header!.linetypes.filter((lt) => lt.complex);
    expect(state.entities).toHaveLength(2);
    expect(gas!.complex!.elements[1]).toMatchObject({ flags: 3, shapeNumber: 0, text: ' GAS  ', scale: 2.54, offsetX: -2.54, offsetY: -1.27 });
    expect(gas!.complex!.elements[1]!.rotation).toBeCloseTo(Math.PI / 4, 11);
    expect(fence!.complex!.elements[1]).toMatchObject({ flags: 5, shapeNumber: 133, scale: 2.54, offsetX: -2.54, offsetY: 0 });
    expect(fence!.complex!.elements[1]!.rotation).toBeCloseTo(Math.PI / 6, 11);
    expect(Object.values(shapeStylesOf(state))).toHaveLength(1);
    expect(Object.values(shapeStylesOf(state))[0]).toMatchObject({ name: '', flags: 1, font: 'ltypeshp.shx' });
  });
  it('keeps the complete resource signature through geometry edits, undo/redo and two fresh saves', () => {
    const doc = new Drawing(readDxf(source)), before = signature(doc.snapshot);
    const line = doc.entities.find((entity) => entity.type === 'line' && entity.linetype === 'GAS_LINE');
    if (!line || line.type !== 'line') throw new Error('Native GAS test line is absent.');
    const edited = { ...line, b: { x: line.b.x + 25, y: line.b.y + 5 } };
    doc.replaceEntities([edited]); expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true); expect(signature(doc.snapshot)).toEqual(before);
    expect(doc.redo()).toBe(true); expect(signature(doc.snapshot)).toEqual(before);
    for (let i = 0; i < 2; i++) {
      const next = readDxf(writeDxf(doc.snapshot));
      expect(signature(next)).toEqual(before);
      expect(next.entities).toContainEqual(expect.objectContaining({ type: 'line', linetype: 'GAS_LINE', b: edited.b }));
      doc.load(next, 'private-native-linetype.dxf'); expect(doc.dirty).toBe(false);
    }
  });
});
