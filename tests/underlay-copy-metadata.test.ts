/**
 * v0.6.4 re-review follow-up (1): a COPY of an imported underlay keeps the
 * source's retainedGroups but drops its cadIdentity (api.ts add()), so the
 * copy has no cad-graph node. The retained 102 {ACAD_REACTORS} /
 * {ACAD_XDICTIONARY 360} blocks and the owner 330 then went out through
 * the codec's common-head slot: 102 blocks after the layer, an emptied
 * reactor block, and a 360 pointing at a dictionary that is not in the
 * output. The cad graph is the sole owner of 102 / 330 / 360 for
 * underlays: writeUnderlay drops them from the retained groups; the
 * identity-bearing original gets them back from the graph merge and stays
 * byte-stable.
 */
import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';

const DXF = [
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'PDFUNDERLAY', '5', '40', '102', '{ACAD_REACTORS', '330', 'D5', '102', '}', '102', '{ACAD_XDICTIONARY', '360', 'D6', '102', '}',
  '330', '1F', '100', 'AcDbEntity', '8', 'U', '160', '8', '310', '0800000000000000', '100', 'AcDbUnderlayReference',
  '340', '41', '10', '10.0', '20', '20.0', '30', '0.0', '41', '2.0', '42', '2.0', '280', '3', '281', '40', '282', '10',
  '11', '0.0', '21', '50.0', '11', '100.0', '21', '0.0',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_GROUP', '350', 'D4',
  '0', 'DICTIONARY', '5', 'D4', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'G1', '350', 'D5',
  '0', 'GROUP', '5', 'D5', '330', 'D4', '100', 'AcDbGroup', '300', 'group', '70', '0', '71', '1', '340', '40',
  '0', 'DICTIONARY', '5', 'D6', '102', '{ACAD_REACTORS', '330', '40', '102', '}', '330', '40', '100', 'AcDbDictionary', '280', '1', '281', '1', '3', 'MYAPP', '360', 'D7',
  '0', 'XRECORD', '5', 'D7', '102', '{ACAD_REACTORS', '330', 'D6', '102', '}', '330', 'D6', '100', 'AcDbXrecord', '280', '1', '1', 'payload',
  '0', 'PDFDEFINITION', '5', '41', '330', 'C', '100', 'AcDbUnderlayDefinition', '1', 'real.pdf', '2', '1',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

type Rec = { kind: string; groups: Array<[number, string]> };
function records(text: string): Rec[] {
  const lines = text.split(/\r?\n/);
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (code === 0) { cur = { kind: value, groups: [] }; out.push(cur); } else cur?.groups.push([code, value]);
  }
  return out;
}
const codes = (r: Rec): number[] => r.groups.map(([c]) => c);

describe('re-review (1): copying an underlay never copies its graph-owned 102 / 330 / 360 groups', () => {
  it('the original (identity-bearing) keeps its reactor and xdictionary blocks and is byte-stable', () => {
    const state = readDxf(DXF);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(e.cadIdentity).toBeDefined();
    const out1 = writeDxf(state);
    const u = records(out1).find((r) => r.kind === 'PDFUNDERLAY')!;
    expect(codes(u)).toEqual([5, 102, 330, 102, 102, 360, 102, 330, 100, 8, 160, 310, 100, 340, 10, 20, 30, 41, 42, 280, 281, 282, 11, 21, 11, 21]);
    expect(writeDxf(readDxf(out1))).toBe(out1);
  });

  it('the copy (no identity) writes a clean record: no 102 / 360, codes start [5, 330, 100, 8, ...]', () => {
    const state = readDxf(DXF);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    const { cadIdentity: _identity, ...rest } = e;
    const copy: UnderlayEntity = { ...rest, id: 'copy', position: { x: 50, y: 20 } };
    const out = writeDxf({ ...state, entities: [...state.entities, copy] });
    const recs = records(out).filter((r) => r.kind === 'PDFUNDERLAY');
    expect(recs).toHaveLength(2);
    const copied = recs.find((r) => r.groups.some(([c, v]) => c === 10 && v === '50'))!;
    expect(copied).toBeDefined();
    expect(codes(copied)).toEqual([5, 330, 100, 8, 160, 310, 100, 340, 10, 20, 30, 41, 42, 280, 281, 282, 11, 21, 11, 21]);
    expect(copied.groups.some(([c]) => c === 102 || c === 360)).toBe(false);
    // The original beside it is unchanged.
    const original = recs.find((r) => r !== copied)!;
    expect(codes(original)).toEqual([5, 102, 330, 102, 102, 360, 102, 330, 100, 8, 160, 310, 100, 340, 10, 20, 30, 41, 42, 280, 281, 282, 11, 21, 11, 21]);
    // The reopened copy is a plain placement joined to the same definition.
    const back = readDxf(out).entities.filter((x) => x.type === 'underlay') as UnderlayEntity[];
    expect(back).toHaveLength(2);
    expect(back.every((x) => x.definitionHandle === back[0]!.definitionHandle)).toBe(true);
  });
});
