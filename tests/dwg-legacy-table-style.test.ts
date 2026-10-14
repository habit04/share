import { describe, expect, it } from 'vitest';
import { verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';

type Pair = [number, string | number];
const dxf = (objects: Pair[], table: Pair[] = []) => [
  [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'STYLE'], [5, '10'], [330, '0'],
  [0, 'STYLE'], [5, '11'], [330, '10'], [2, 'Standard'], [70, 0], ...table,
  [0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'OBJECTS'], ...objects, [0, 'ENDSEC'], [0, 'EOF'],
].flat().join('\n') + '\n';

// Authored native-format fixtures, independent of the production projection.
// These are raw grammar/semantic checks; genuine binary readback is covered by
// the helper's legacy-minsert regression and the real portable-export gate.
const cell = (name: string, id: number, alignment: number, height: number): Pair[] => [
  [1, 'TABLEFORMAT_BEGIN'], [90, 5], [170, 1], [91, 0], [92, name === '_TITLE' ? 32768 : 0], [62, 257], [93, 1],
  [300, 'CONTENTFORMAT'], [1, 'CONTENTFORMAT_BEGIN'], [90, 0], [91, 0], [92, 512], [93, 0], [300, ''],
  [40, 0], [140, 1], [94, alignment], [62, 0], [340, '11'], [144, height], [309, 'CONTENTFORMAT_END'],
  [171, 0], [94, 0], [309, 'TABLEFORMAT_END'], [1, 'CELLSTYLE_BEGIN'], [90, id], [91, name === '_DATA' ? 2 : 1], [300, name], [309, 'CELLSTYLE_END'],
];
const base = (horizontal = .06, vertical = .06): Pair[] => [
  [1, 'TABLEFORMAT_BEGIN'], [90, 5], [170, 1], [91, 0], [92, 0], [62, 257], [93, 1],
  [300, 'CONTENTFORMAT'], [1, 'CONTENTFORMAT_BEGIN'], [90, 0], [91, 0], [92, 512], [93, 0], [300, ''],
  [40, 0], [140, 1], [94, 1], [62, 0], [340, '0'], [144, .18], [309, 'CONTENTFORMAT_END'],
  [171, 1], [301, 'MARGIN'], [1, 'CELLMARGIN_BEGIN'], [40, vertical], [40, horizontal], [40, vertical], [40, horizontal], [40, .18], [40, .18], [309, 'CELLMARGIN_END'],
  [94, 0], [309, 'TABLEFORMAT_END'], [1, 'CELLSTYLE_BEGIN'], [90, 4], [91, 2], [300, 'Table'], [309, 'CELLSTYLE_END'],
];
const row = (alignment: number, height: number): Pair[] => [
  [7, 'Standard'], [140, height], [170, alignment], [62, 0], [63, 7], [283, 0], [90, 512], [91, 0], [1, ''],
  ...Array.from({ length: 6 }, (_, index): Pair[] => [[274 + index, -2], [284 + index, 1], [64 + index, 0]]).flat(),
];
const fixture = ({ flags = 0, horizontal = .06, vertical = .06, height = .18 } = {}) => {
  const cells = [...cell('_TITLE', 1, 5, .25), ...cell('_HEADER', 2, 5, .18), ...cell('_DATA', 3, 2, height)];
  const common: Pair[] = [[5, '3'], [102, '{ACAD_REACTORS'], [330, '2'], [102, '}'], [102, '{ACAD_XDICTIONARY'], [360, '4'], [102, '}'], [330, '2']];
  const objects: Pair[] = [
    [0, 'DICTIONARY'], [5, '1'], [330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_TABLESTYLE'], [350, '2'],
    [0, 'DICTIONARY'], [5, '2'], [330, '1'], [100, 'AcDbDictionary'], [281, 1], [3, 'Standard'], [350, '3'],
    [0, 'DICTIONARY'], [5, '4'], [330, '3'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_ROUNDTRIP_2008_TABLESTYLE_CELLSTYLEMAP'], [350, '5'],
    [0, 'CELLSTYLEMAP'], [5, '5'], [330, '4'], [100, 'AcDbCellStyleMap'], [90, 3],
    [300, 'CELLSTYLE'], ...cell('_TITLE', 1, 5, .25), [300, 'CELLSTYLE'], ...cell('_HEADER', 2, 5, .18), [300, 'CELLSTYLE'], ...cell('_DATA', 3, 2, height),
  ];
  const legacy: Pair[] = [[0, 'TABLESTYLE'], ...common, [100, 'AcDbTableStyle'], [280, 0], [3, 'Standard'], [70, 0], [71, flags], [40, horizontal], [41, vertical], [280, flags & 1 ? 1 : 0], [281, flags & 2 ? 1 : 0], ...row(2, height), ...row(5, .25), ...row(5, .18), [1001, 'APP'], [1000, 'Opaque \\U+0041 Δ'], [1070, 7]];
  const native: Pair[] = [[0, 'TABLESTYLE'], ...common, [102, '{JCAD_TABLESTYLE_NATIVE_V1'], [90, flags], [91, 101], [360, '0'], [92, 3], [93, 1], [93, 2], [93, 3], [102, '}'], [100, 'AcDbTableStyle'], [70, 0], [3, 'Standard'], ...base(horizontal, vertical), ...cells, [1001, 'APP'], [1000, 'Opaque \\U+0041 Δ'], [1070, 7]];
  return { objects, legacy, native, source: dxf([...objects, ...legacy]), target: dxf([...objects, ...native]) };
};
const modify = (pairs: Pair[], code: number, value: string | number, occurrence = 0) => {
  const copy = pairs.map(pair => [...pair] as Pair); let found = 0;
  const at = copy.findIndex(pair => pair[0] === code && found++ === occurrence);
  expect(at).toBeGreaterThanOrEqual(0); copy[at] = [code, value]; return copy;
};
const explicitGrids = (pairs: Pair[], skipBase: boolean, nondefault = false) => {
  let cell = 0;
  return pairs.flatMap((pair): Pair[] => {
    if (pair[0] === 1 && pair[1] === 'TABLEFORMAT_BEGIN') cell++;
    if (pair[0] !== 94 || pair[1] !== 0 || cell <= (skipBase ? 1 : 0)) return [pair];
    return [[94, 6], ...[1, 2, 4, 8, 16, 32].flatMap((mask): Pair[] => [
      [95, mask], [302, 'GRIDFORMAT'], [1, 'GRIDFORMAT_BEGIN'], [90, 0], [91, 1], [62, nondefault && mask === 1 ? 1 : 0],
      [92, nondefault && mask === 1 ? 50 : -2], [340, '0'], [93, nondefault && mask === 1 ? 1 : 0], [40, 0], [309, 'GRIDFORMAT_END'],
    ])];
  });
};

describe('checked legacy TABLESTYLE native projection', () => {
  it('preserves three complete legacy rows, ordered cell formats, references and opaque XDATA', () => {
    const { source, target } = fixture(); expect(verify(source, target).objects).toBe(5);
  });
  it('preserves nondefault margins, full flag words and a source-native row height', () => {
    const { source, target } = fixture({ flags: 8, horizontal: .37, vertical: .23, height: .8 }); expect(verify(source, target).objects).toBe(5);
  });
  it('retains title/header suppression through explicit native flag bits', () => {
    for (const flags of [1, 2, 3, 11]) { const { source, target } = fixture({ flags }); expect(verify(source, target).objects).toBe(5); }
  });
  it('permits common group serialization order while preserving ordered reactor values and links', () => {
    const { objects, legacy, target } = fixture();
    const reordered = [legacy[0]!, legacy[1]!, ...legacy.slice(5, 8), ...legacy.slice(2, 5), ...legacy.slice(8)];
    expect(verify(dxf([...objects, ...reordered]), target).objects).toBe(5);
  });
  it('preserves explicit native border weight/color and the inverse legacy visibility flag', () => {
    const { objects, legacy, native } = fixture();
    const changed = legacy.map(([code, value]): Pair => [code, code === 274 ? 50 : code === 284 ? 0 : code === 64 ? 1 : value]);
    const nativeObjects = explicitGrids(objects, false, true);
    expect(verify(dxf([...nativeObjects, ...changed]), dxf([...nativeObjects, ...explicitGrids(native, true, true)])).objects).toBe(5);
    expect(() => verify(dxf([...nativeObjects, ...changed]), dxf([...nativeObjects, ...explicitGrids(native, true, false)]))).toThrow();
  });
  it('checks generated full row formats when the source has no roundtrip CELLSTYLEMAP', () => {
    const { objects, legacy, native } = fixture();
    const limit = objects.findIndex(([code, value], index) => code === 0 && value === 'DICTIONARY' && objects[index + 1]?.[1] === '4');
    const withoutExtension = (pairs: Pair[]) => [...pairs.slice(0, 5), ...pairs.slice(8)];
    const source = dxf([...objects.slice(0, limit), ...withoutExtension(legacy)]);
    const target = dxf([...objects.slice(0, limit), ...explicitGrids(withoutExtension(native), true)]);
    expect(verify(source, target).objects).toBe(3);
    expect(() => verify(source, dxf([...objects.slice(0, limit), ...withoutExtension(native)]))).toThrow();
  });
  it('retains an explicit fill and refuses a changed native fill method or color', () => {
    const { objects, legacy, native } = fixture();
    const fillCells = (pairs: Pair[], skipBase: boolean) => {
      let cell = 0;
      return pairs.map(([code, value]): Pair => {
        if (code === 1 && value === 'TABLEFORMAT_BEGIN') cell++;
        return [code, code === 62 && value === 257 && cell > (skipBase ? 1 : 0) ? 1 : value];
      });
    };
    const changed = legacy.map(([code, value]): Pair => [code, code === 283 ? 1 : code === 63 ? 1 : value]);
    const nativeObjects = fillCells(objects, false);
    expect(verify(dxf([...nativeObjects, ...changed]), dxf([...nativeObjects, ...fillCells(native, true)])).objects).toBe(5);
    expect(() => verify(dxf([...nativeObjects, ...changed]), dxf([...nativeObjects, ...native]))).toThrow();
  });
  it.each([
    [280, 1, 0], [70, 1, 0], [71, 1, 0], [280, 1, 1], [281, 1, 0],
    [7, 'Missing', 0], [140, .8, 0], [170, 9, 0], [62, 1, 0], [63, 1, 0], [283, 1, 0],
    [90, 2, 0], [91, 4, 0], [1, 'Literal format', 0], [274, 50, 0], [284, 0, 0], [64, 1, 0],
  ] as Array<[number, string | number, number]>)('refuses unmapped source group %s value %s', (code, value, occurrence) => {
    const { objects, legacy, target } = fixture(); expect(() => verify(dxf([...objects, ...modify(legacy, code, value, occurrence)]), target)).toThrow(/TABLESTYLE/);
  });
  it('refuses unknown properties and duplicate source fields rather than accepting a normalized baseline', () => {
    const { objects, legacy, target } = fixture(), subclass = legacy.findIndex(([code, value]) => code === 100 && value === 'AcDbTableStyle');
    for (const property of [[300, 'retained description'], [71, 0]] as Pair[]) {
      const changed = legacy.slice(); changed.splice(subclass + 2, 0, property); expect(() => verify(dxf([...objects, ...changed]), target)).toThrow(/TABLESTYLE/);
    }
  });
  it.each([
    [90, 1, 0], [91, 102, 0], [360, '0', 0], [93, 9, 0], [40, .5, 0], [144, .8, 3], [340, '0', 3], [1070, 8, 0], [1000, 'changed', 0], [330, '1', 0],
  ] as Array<[number, string | number, number]>)('rejects actual native metadata mutation group %s value %s', (code, value, occurrence) => {
    const { objects, native, source } = fixture(); expect(() => verify(source, dxf([...objects, ...modify(native, code, value, occurrence)]))).toThrow();
  });
  it('requires the complete preserved CELLSTYLEMAP even when convenience rows would look unchanged', () => {
    const { objects, native, source } = fixture();
    expect(() => verify(source, dxf([...modify(objects, 144, .8, 2), ...native]))).toThrow();
    const extra = objects.slice(); extra.splice(extra.findIndex(([code, value]) => code === 100 && value === 'AcDbCellStyleMap') + 1, 0, [301, 'retained unknown field']);
    expect(() => verify(dxf([...extra, ...fixture().legacy]), fixture().target)).toThrow();
  });
});
