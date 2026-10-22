import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing } from '../src/core/document';
import type { CadNode } from '../src/core/cad-graph';
import type { LeaderEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tokenize } from '../src/io/dxf/groups';

const nodeOf = (state: Drawing['snapshot'], handle: string): CadNode => state.cadGraph!.nodes.find(node => node.sourceHandle === handle)!;
// The dimension carrying the DSTYLE XDATA override is located by that XDATA, never by handle:
// a genuine AutoCAD save assigns its own handles (the synthetic's '128' is '323' in the genuine
// r2018-dimensions.dxf; see the lead's checklist for that fixture, item 33).
const dstyleDimensionNode = (state: Drawing['snapshot']): CadNode => state.cadGraph!.nodes.find(node => node.type === 'DIMENSION' && node.groups.some(([code, value]) => code === 1000 && value === 'DSTYLE'))!;
const textOf = (pairs: readonly { code: number; value: string }[]) => pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n';
const dimensionFixture = readFileSync(new URL('./fixtures/interchange/r2018-dimensions.dxf', import.meta.url), 'utf8');
const metadataFixture = readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');

function nativeAnnotationFixture(): string {
  const pairs = tokenize(metadataFixture);
  const variable = pairs.findIndex(pair => pair.code === 5 && pair.value === '17A');
  const payload = pairs.findIndex((pair, index) => index > variable && pair.code === 1);
  pairs[payload] = { code: 1, value: '1:4' };
  const dictionary = pairs.findIndex(pair => pair.code === 5 && pair.value === '175');
  const dictionaryEnd = pairs.findIndex((pair, index) => index > dictionary && pair.code === 0);
  pairs.splice(dictionaryEnd, 0, { code: 3, value: 'ANNOALLVISIBLE' }, { code: 350, value: 'FFFF2' });
  const objects = pairs.findIndex(pair => pair.code === 2 && pair.value === 'OBJECTS');
  const end = pairs.findIndex((pair, index) => index > objects && pair.code === 0 && pair.value === 'ENDSEC');
  pairs.splice(end, 0, ...[{ code: 0, value: 'DICTIONARYVAR' }, { code: 5, value: 'FFFF2' },
    { code: 102, value: '{ACAD_REACTORS' }, { code: 330, value: '175' }, { code: 102, value: '}' },
    { code: 330, value: '175' }, { code: 100, value: 'DictionaryVariables' }, { code: 280, value: '0' }, { code: 1, value: '0' }]);
  return textOf(pairs);
}

describe('native annotation override metadata after edits', () => {
  it('retains the imported native class application and schema flags while deriving only the instance count', () => {
    const state = readDxf(metadataFixture), classes = state.cadGraph!.nodes.filter(node => node.type === 'CLASS');
    expect(classes.length).toBeGreaterThan(0);
    const back = readDxf(writeDxf(state));
    for (const definition of classes) {
      const name = definition.groups.find(([code]) => code === 1)?.[1];
      const retained = back.cadGraph!.nodes.find(node => node.type === 'CLASS' && node.groups.some(([code, value]) => code === 1 && value === name));
      expect(retained?.groups.filter(([code]) => code !== 91)).toEqual(definition.groups.filter(([code]) => code !== 91));
    }
  });

  it('reads native dictionary annotation settings when the DWG projection has no equivalent header variables', () => {
    const state = readDxf(nativeAnnotationFixture());
    expect(state.header).toMatchObject({ cannoscale: '1:4', annoAllVisible: false });
    expect(readDxf(writeDxf(state)).header).toMatchObject({ cannoscale: '1:4', annoAllVisible: false });
  });

  it('synchronizes edited semantic annotation variables without altering unrelated dictionary records, identities or links', () => {
    const state = readDxf(nativeAnnotationFixture()), unknown = nodeOf(state, '177');
    const sourceVariable = nodeOf(state, '17A'), sourceVisibility = nodeOf(state, 'FFFF2');
    const edited = { ...state, header: { ...state.header!, cannoscale: '1:2', annoAllVisible: true } };
    const back = readDxf(writeDxf(edited));
    expect(back.header?.cannoscale).toBe('1:2'); expect(back.header?.annoAllVisible).not.toBe(false);
    expect(nodeOf(back, '17A').groups).toEqual(sourceVariable.groups.map(group => group[0] === 1 ? [1, '1:2'] : group));
    expect(nodeOf(back, 'FFFF2').groups).toEqual(sourceVisibility.groups.map(group => group[0] === 1 ? [1, '1'] : group));
    expect(nodeOf(back, '177').groups).toEqual(unknown.groups);
    expect(nodeOf(state, '17A').groups).toContainEqual([1, '1:4']);
    expect(nodeOf(state, 'FFFF2').groups).toContainEqual([1, '0']);
    const once = writeDxf(back); expect(writeDxf(readDxf(once))).toBe(once);
  });

  it('retains the unmodeled DIMSTYLE leader-arrow hard dependency and protects its referenced block from erase', () => {
    const model = new Drawing(readDxf(dimensionFixture));
    model.ensureBlocks([{ name: 'META_ARROW', basePoint: { x: 0, y: 0 }, attributes: [], entities: [{ id: 'arrow-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] }]);
    const text = writeDxf(model.snapshot), original = readDxf(text), target = original.cadGraph!.nodes.find(node => node.type === 'BLOCK_RECORD' && node.groups.some(([code, value]) => code === 2 && value === 'META_ARROW'))!;
    // The ISO-25 DIMSTYLE record is located by name: its object handle (group 105) is assigned by
    // the writer and differs between the hand-authored and genuine sources ('50' vs '271').
    const pairs = tokenize(text);
    const recordStart = pairs.findIndex((pair, index) => {
      if (pair.code !== 0 || pair.value !== 'DIMSTYLE') return false;
      for (let j = index + 1; j < pairs.length && pairs[j]!.code !== 0; j += 1) if (pairs[j]!.code === 2 && pairs[j]!.value === 'ISO-25') return true;
      return false;
    });
    const style = pairs.findIndex((pair, index) => index > recordStart && pair.code === 105), styleHandle = pairs[style]!.value, app = pairs.findIndex((pair, index) => index > style && pair.code === 1001);
    pairs.splice(app, 0, { code: 341, value: target.sourceHandle! });
    const doc = new Drawing(readDxf(textOf(pairs))), before = doc.snapshot, one = writeDxf(before), back = readDxf(one), retained = nodeOf(back, styleHandle);
    const ref = retained.references!.find(ref => retained.groups[ref.groupIndex]![0] === 341)!;
    expect(ref.kind).toBe('hard-pointer'); expect(back.cadGraph!.nodes.find(node => node.id === ref.target)?.groups).toContainEqual([2, 'META_ARROW']);
    expect(writeDxf(back)).toBe(one);
    expect(() => doc.removeBlocks(['META_ARROW'])).toThrow(/hard dependency/); expect(doc.snapshot).toBe(before); expect(doc.canUndo()).toBe(false);
    const missing = pairs.map(pair => pair.code === 341 ? { ...pair, value: 'FFFFFFFFFFFFFFFF' } : pair);
    expect(() => writeDxf(readDxf(textOf(missing)))).toThrow(/DIMSTYLE.*hard reference.*was not exposed/);
  });
  it('regenerates edited dimension style overrides while keeping unmodeled tuples, opaque ACAD strings and independent handle references', () => {
    const pairs = tokenize(dimensionFixture);
    // The DSTYLE dimension's record is located by its XDATA (see dstyleDimensionNode above);
    // `start` is the index of that record's handle pair (code 5).
    let start = -1;
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'DIMENSION') continue;
      let carries = false;
      for (let j = i + 1; j < pairs.length && pairs[j]!.code !== 0; j += 1) if (pairs[j]!.code === 1000 && pairs[j]!.value === 'DSTYLE') carries = true;
      if (carries) { start = i + 1; break; }
    }
    const app = pairs.findIndex((pair, index) => index > start && pair.code === 1001 && pair.value === 'ACAD');
    const end = pairs.findIndex((pair, index) => index > app && pair.code === 1002 && pair.value === '}');
    pairs.splice(end, 0, { code: 1070, value: '49' }, { code: 1040, value: '99.5' });
    // The independent 1005 reference names the ISOCP style record: handle '265' in the genuine
    // save (the synthetic's was '43'); the assertion below checks it still resolves to ISOCP.
    pairs.splice(end + 3, 0, { code: 1000, value: '{"literal":"\\\\U+0041","handle":"FFFFFFFFFFFFFFFF"}' }, { code: 1005, value: '265' });
    pairs.splice(app + 1, 0, { code: 1000, value: 'opaque \\U+0041' }, { code: 1004, value: '00017F80FF' });
    const doc = new Drawing(readDxf(textOf(pairs))), source = doc.snapshot, root = dstyleDimensionNode(source);
    const entity = source.entities.find(entity => root.anchor?.kind === 'entity' && entity.id === root.anchor.id)!;
    expect(entity.type).toBe('dimension'); if (entity.type !== 'dimension') throw new Error('Expected real fixture DIMENSION');
    expect(entity.style).toMatchObject({ textHeight: 5, decimals: 0 });
    doc.replaceEntities([{ ...entity, style: { ...entity.style, textHeight: 7, arrowSize: 9, decimals: 2, textStyle: 'Standard' } }]);
    const written = writeDxf(doc.snapshot), back = readDxf(written), retained = dstyleDimensionNode(back);
    const reopened = back.entities.find(entity => retained.anchor?.kind === 'entity' && entity.id === retained.anchor.id)!;
    expect(reopened).toMatchObject({ type: 'dimension', style: { textHeight: 7, arrowSize: 9, decimals: 2, textStyle: 'Standard' } });
    expect(retained.groups).toContainEqual([1000, 'opaque \\U+0041']); expect(retained.groups).toContainEqual([1004, '00017F80FF']);
    expect(retained.groups).toContainEqual([1000, '{"literal":"\\\\U+0041","handle":"FFFFFFFFFFFFFFFF"}']);
    const unknown = retained.groups.findIndex(([code, value]) => code === 1070 && value.trim() === '49');
    expect(retained.groups[unknown + 1]).toEqual([1040, '99.5']);
    const textStyle = retained.groups.findIndex(([code, value]) => code === 1070 && value.trim() === '340');
    const styleRef = retained.references!.find(ref => ref.groupIndex === textStyle + 1)!;
    expect(back.cadGraph!.nodes.find(node => node.id === styleRef.target)?.groups).toContainEqual([2, 'Standard']);
    const independent = retained.references!.find(ref => retained.groups[ref.groupIndex]![0] === 1005 && ref !== styleRef)!;
    expect(back.cadGraph!.nodes.find(node => node.id === independent.target)?.groups).toContainEqual([2, 'ISOCP']);
    expect(writeDxf(readDxf(writeDxf(back)))).toBe(writeDxf(back));
    doc.undo(); expect(doc.snapshot).toBe(source);
  });
  it('pure numeric DSTYLE is modeled without forcing an unnecessary retained entity identity', () => {
    const source = readDxf(dimensionFixture), node = dstyleDimensionNode(source);
    const entity = source.entities.find(entity => node.anchor?.kind === 'entity' && entity.id === node.anchor.id)!;
    expect(entity.cadIdentity).toBeUndefined(); expect(entity).toMatchObject({ type: 'dimension', style: { textHeight: 5, decimals: 0 } });
  });
  it('LEADER arrow size edits replace the source DSTYLE value and clearing the override removes its stale block', () => {
    const leader: LeaderEntity = { id: 'leader', type: 'leader', layer: '0', color: 'ByLayer', kind: 'leader', vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }], arrow: true, arrowSize: 1, textHeight: 1 };
    const doc = new Drawing(readDxf(writeDxf(new Drawing({ entities: [leader] }).snapshot))), source = doc.entities[0]!;
    expect(source.type).toBe('leader'); if (source.type !== 'leader') throw new Error('Expected LEADER');
    expect(source.cadIdentity).toBeUndefined(); doc.replaceEntities([{ ...source, arrowSize: 2 }]);
    expect(readDxf(writeDxf(doc.snapshot)).entities[0]).toMatchObject({ type: 'leader', arrowSize: 2 });
    doc.replaceEntities([{ ...doc.entities[0] as LeaderEntity, arrowSize: doc.header.dimStyle.arrowSize * (doc.header.dimStyle.scale || 1) }]);
    const back = readDxf(writeDxf(doc.snapshot));
    expect(back.entities[0]).toMatchObject({ type: 'leader', arrowSize: doc.header.dimStyle.arrowSize * (doc.header.dimStyle.scale || 1) });
    expect(back.cadGraph!.nodes.find(node => node.type === 'LEADER')!.groups.some(([code, value]) => code === 1000 && value === 'DSTYLE')).toBe(false);
  });
});
