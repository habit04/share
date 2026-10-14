import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { cadAnchorKey } from '../src/core/cad-graph';
import { readDxf, writeDxf } from '../src/io/dxf';
import { shapeStylesOf } from '../src/io/encoding';

type Pair = readonly [number, string | number];
function authored(): string {
  const style = (handle: string, font: string): Pair[] => [[0, 'STYLE'], [5, handle], [2, ''], [70, 1], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, font], [4, '']];
  const ltype = (name: string, handle: string, resource: string, number: number): Pair[] => [[0, 'LTYPE'], [5, handle], [2, name], [70, 0], [3, 'Authored shapes'], [72, 65], [73, 1], [40, 12], [49, -12], [74, 4], [75, number], [340, resource], [46, 1]];
  const pairs: Pair[] = [[0, 'SECTION'], [2, 'TABLES'], ...ltype('SHAPE_A', 'AA', 'CC', 133), ...ltype('SHAPE_B', 'AB', 'DD', 134), ...style('CC', 'one.shx'), ...style('DD', 'two.shx'),
    [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'ENDSEC'], [0, 'EOF']];
  return pairs.flatMap(([code, value]) => [String(code), String(value)]).join('\r\n') + '\r\n';
}

describe('anonymous shape STYLE source identities', () => {
  it('keeps identically named resources independent and resolves each LTYPE to its original STYLE', () => {
    let state = readDxf(authored());
    for (let pass = 0; pass < 3; pass++) {
      const styles = state.cadGraph!.nodes.filter(node => node.anchor?.kind === 'shape-style');
      expect(styles).toHaveLength(2);
      expect(new Set(styles.map(node => cadAnchorKey(node.anchor))).size).toBe(2);
      expect(Object.values(shapeStylesOf(state)).map(resource => resource.font).sort()).toEqual(['one.shx', 'two.shx']);
      for (const [name, font] of [['SHAPE_A', 'one.shx'], ['SHAPE_B', 'two.shx']]) {
        const reference = state.header!.linetypes.find(line => line.name === name)!.complex!.elements[0]!.style!;
        expect(reference.kind).toBe('shape');
        if (reference.kind === 'shape') expect(shapeStylesOf(state)[reference.sourceId]!.font).toBe(font);
        const node = state.cadGraph!.nodes.find(node => node.type === 'LTYPE' && node.groups.some(([code, value]) => code === 2 && value === name))!;
        const edge = node.references!.find(ref => node.groups[ref.groupIndex]![0] === 340)!;
        expect(state.cadGraph!.nodes.find(node => node.id === edge.target)?.anchor?.kind).toBe('shape-style');
      }
      state = readDxf(writeDxf(state));
    }
  });
  it('edits only the selected anonymous resource and preserves identity through undo/redo', () => {
    const doc = new Drawing(readDxf(authored())), before = doc.snapshot;
    const resources = shapeStylesOf(before);
    doc.transactDrawing(state => ({ ...state, meta: { ...state.meta, shapeStyles: { ...resources, DD: { ...resources.DD!, font: 'updated.shx', lastHeight: 9 } } } }));
    const edited = doc.snapshot, back = readDxf(writeDxf(edited));
    expect(shapeStylesOf(back).CC!.font).toBe('one.shx');
    expect(shapeStylesOf(back).DD).toMatchObject({ font: 'updated.shx', lastHeight: 9 });
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(edited);
    expect(back.cadGraph!.nodes.filter(node => node.type === 'STYLE' && node.anchor?.kind === 'shape-style')).toHaveLength(2);
  });
});
