import { describe, expect, it } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DrawingState } from '../src/core/document';

type Pair = readonly [number, string | number];
function authored(positional = false): string {
  const pairs: Pair[] = [[0, 'SECTION'], [2, 'TABLES'], [0, 'LTYPE'], [5, 'AA'], [2, 'CUSTOM'], [70, 0], [3, 'Authored compatibility fixture'], [72, 65], [73, 1], [40, 12],
    [49, -12], [74, 2], [75, 0], [340, 'BB'], [46, 2], [50, 0.1], [44, 1], [45, 2], [9, ' GAS  '], ...(positional ? [[47, 3] as Pair] : []),
    [1001, 'PROBE'], [1000, 'opaque|literal 00FF'], [1005, 'CC'],
    [0, 'STYLE'], [5, 'BB'], [2, 'LABEL'], [70, 0], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, 'arial.ttf'], [4, ''],
    [0, 'STYLE'], [5, 'CC'], [2, ''], [70, 1], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, 'authored.shx'], [4, ''],
    [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'ENDSEC'], [0, 'EOF']];
  return pairs.flatMap(([code, value]) => [String(code), String(value)]).join('\r\n') + '\r\n';
}
const line = (state: DrawingState) => state.header!.linetypes.find(item => item.name === 'CUSTOM')!;

describe('modeled complex linetypes reconcile with retained native records', () => {
  it('uses live text, transforms, dash values and native flags instead of the imported baseline', () => {
    const source = readDxf(authored()), original = line(source);
    const live = { ...original, pattern: [-15], complex: { ...original.complex!, flags: 64, totalPatternLength: 15,
      elements: original.complex!.elements.map(element => ({ ...element, text: ' NEW LABEL  ', rotation: 0.6, scale: 4, offsetX: 5, offsetY: -2 })) } };
    const back = readDxf(writeDxf({ ...source, header: { ...source.header!, linetypes: [live] } }));
    expect(line(back).pattern).toEqual([-15]);
    expect(line(back).complex).toEqual(live.complex);
    const record = back.cadGraph!.nodes.find(node => node.type === 'LTYPE' && node.sourceHandle === 'AA')!;
    expect(record.groups).toContainEqual([1000, 'opaque|literal 00FF']);
    const edge = record.references!.find(ref => record.groups[ref.groupIndex]![0] === 1005)!;
    expect(back.cadGraph!.nodes.find(node => node.id === edge.target)?.anchor).toEqual({ kind: 'shape-style', sourceId: 'CC' });
    const one = writeDxf(back); expect(writeDxf(readDxf(one))).toBe(one);
  });
  it('does not resurrect intentionally removed optional descriptor fields', () => {
    const source = readDxf(authored()), original = line(source);
    const elements = original.complex!.elements.map(({ scale: _scale, rotation: _rotation, offsetX: _x, offsetY: _y, ...element }) => element);
    const back = readDxf(writeDxf({ ...source, header: { ...source.header!, linetypes: [{ ...original, complex: { ...original.complex!, elements } }] } }));
    const element = line(back).complex!.elements[0]!;
    expect(element.text).toBe(' GAS  '); expect(element.style).toEqual(original.complex!.elements[0]!.style);
    for (const field of ['scale', 'rotation', 'offsetX', 'offsetY'] as const) expect(element[field]).toBeUndefined();
    const record = back.cadGraph!.nodes.find(node => node.type === 'LTYPE' && node.sourceHandle === 'AA')!;
    expect(record.groups.some(([code]) => [46, 50, 44, 45].includes(code))).toBe(false);
    expect(record.groups).toContainEqual([1000, 'opaque|literal 00FF']);
  });
  it('refuses unknown positional fields before reordering or discarding retained source data', () => {
    const source = readDxf(authored(true));
    expect(source.cadGraph!.nodes.find(node => node.type === 'LTYPE')!.groups).toContainEqual([47, '3']);
    expect(() => writeDxf(source)).toThrow(/unmodeled positional native fields/);
    expect(line(source).complex!.elements[0]!.text).toBe(' GAS  ');
  });
});
