import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DwgMetadataEquivalenceError, verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';

type Pair = [number, string | number];
const text = (pairs: Pair[]) => pairs.flatMap(([code, value]) => [String(code), String(value)]).join('\r\n') + '\r\n';
const section = (name: string, pairs: Pair[]): Pair[] => [[0, 'SECTION'], [2, name], ...pairs, [0, 'ENDSEC']];
const record = (type: string, handle: string, pairs: Pair[]): Pair[] => [[0, type], [5, handle], ...pairs];
const fixture = () => text([
  ...section('HEADER', [[9, '$CMATERIAL'], [347, 'A'], [9, '$DIMTXSTY'], [7, 'Standard'], [9, '$PSOLHEIGHT'], [40, 4], [9, '$FINGERPRINTGUID'], [2, '{retained}'], [9, '$TDUPDATE'], [40, 123]]),
  ...section('TABLES', [
    ...record('TABLE', '10', [[2, 'STYLE'], [330, '0']]),
    ...record('STYLE', '11', [[2, 'Standard'], [330, '10']]), [0, 'ENDTAB'],
    ...record('TABLE', '12', [[2, 'VIEW'], [330, '0']]),
    ...record('VIEW', '13', [[330, '12'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewTableRecord'], [2, 'FUTURE_3D'], [10, 5], [20, 2.5], [40, 20], [41, 40], [11, 1], [21, 2], [31, 3], [12, 100], [22, 200], [32, 12], [50, 30]]), [0, 'ENDTAB'],
  ]),
  ...section('ENTITIES', [
    ...record('LINE', '30', [[102, '{ACAD_REACTORS'], [330, '6'], [102, '}'], [102, '{ACAD_XDICTIONARY'], [360, '2'], [102, '}'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbLine'], [10, 0], [20, 0], [11, 10], [21, 10], [1001, 'APP'], [1000, 'literal\\U+0041:{"handle":"3"}'], [1004, '00017F80FF'], [1005, '3']]),
  ]),
  ...section('OBJECTS', [
    ...record('DICTIONARY', '1', [[330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'APP'], [350, '2'], [3, 'STYLE'], [350, '6'], [3, 'MATERIAL'], [350, 'A']]),
    ...record('DICTIONARY', '2', [[330, '30'], [100, 'AcDbDictionary'], [281, 1], [3, 'RECORD'], [350, '3'], [3, 'FIELD'], [350, '4']]),
    ...record('XRECORD', '3', [[330, '2'], [100, 'AcDbXrecord'], [280, 1], [1, 'literal\\U+0041:{"handle":"30"}'], [310, '00017F80FF'], [160, '9007199254740993'], [340, '30'], [320, 'FFFF']]),
    ...record('FIELD', '4', [[330, '2'], [100, 'AcDbField'], [1, 'AcObjProp'], [2, '%<\\_FldIdx 0'], [3, '>%'], [90, 1], [360, '5'], [331, '30'], [301, 'cached'], [9, ' value']]),
    ...record('FIELD', '5', [[330, '4'], [100, 'AcDbField'], [1, 'AcVar'], [2, '%<\\AcVar Filename>%'], [301, 'file.dwg']]),
    ...record('MLEADERSTYLE', '6', [[330, '1'], [100, 'AcDbMLeaderStyle'], [46, 4], [293, 1], [294, 1], [340, '11']]),
    ...record('MATERIAL', 'A', [[330, '1'], [100, 'AcDbMaterial'], [1, 'Material Δ']]),
  ]), [0, 'EOF'],
]);
const pairs = (dxf: string): Pair[] => {
  const lines = dxf.trimEnd().split(/\r\n|\n|\r/); const result: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) result.push([Number(lines[i]!.trim()), lines[i + 1]!]);
  return result;
};
const mutateRecord = (dxf: string, type: string, change: (groups: Pair[]) => Pair[]) => {
  const all = pairs(dxf), start = all.findIndex(([code, value]) => code === 0 && value === type);
  expect(start).toBeGreaterThanOrEqual(0);
  let end = all.findIndex(([code], index) => index > start && code === 0); if (end < 0) end = all.length;
  all.splice(start + 1, end - start - 1, ...change(all.slice(start + 1, end))); return text(all);
};
const changeValue = (groups: Pair[], code: number, value: string | number) => {
  const index = groups.findIndex(([group]) => group === code); expect(index).toBeGreaterThanOrEqual(0);
  groups[index] = [code, value]; return groups;
};
const oracle = (name: string) => readFileSync(new URL(`./fixtures/interchange/r2018-${name}.dxf`, import.meta.url), 'utf8');
const annotationFixture = () => {
  const sourcePairs = pairs(fixture()), headerEnd = sourcePairs.findIndex(([code, value]) => code === 0 && value === 'ENDSEC');
  sourcePairs.splice(headerEnd, 0, [9, '$CANNOSCALE'], [2, '1:20'], [9, '$ANNOALLVISIBLE'], [70, '0']);
  const source = text(sourcePairs);
  let target = mutateRecord(source, 'DICTIONARY', groups => [...groups, [3, 'AcDbVariableDictionary'], [350, '40'], [3, 'ACAD_SCALELIST'], [350, '43']]);
  const targetPairs = pairs(target); let end = targetPairs.length - 1;
  while (end >= 0 && !(targetPairs[end]![0] === 0 && targetPairs[end]![1] === 'ENDSEC')) end--;
  targetPairs.splice(end, 0,
    ...record('DICTIONARY', '40', [[330, '1'], [100, 'AcDbDictionary'], [281, 1], [3, 'CANNOSCALE'], [350, '41'], [3, 'ANNOALLVISIBLE'], [350, '42']]),
    ...record('DICTIONARYVAR', '41', [[330, '40'], [100, 'DictionaryVariables'], [280, 0], [1, '1:20']]),
    ...record('DICTIONARYVAR', '42', [[330, '40'], [100, 'DictionaryVariables'], [280, 0], [1, '0']]),
    ...record('DICTIONARY', '43', [[330, '1'], [100, 'AcDbDictionary'], [281, 1], [3, 'A0'], [350, '44']]),
    ...record('SCALE', '44', [[330, '43'], [100, 'AcDbScale'], [70, 0], [300, '1:20'], [140, 1], [141, 20], [290, 0]]),
  );
  for (let index = targetPairs.length - 1; index >= 0; index--) if (targetPairs[index]![0] === 9 && ['$CANNOSCALE', '$ANNOALLVISIBLE'].includes(String(targetPairs[index]![1]))) targetPairs.splice(index, 2);
  target = text(targetPairs); return { source, target };
};

describe('independent raw DWG metadata postflight', () => {
  it('distinguishes DIMSTYLE flags from text-fill colors, allowing only the omitted zero fill defaults', () => {
    const source = text([...section('TABLES', [...record('TABLE', '1', [[2, 'DIMSTYLE'], [330, '0']]), [0, 'DIMSTYLE'], [105, '2'], [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbDimStyleTableRecord'], [2, 'Standard'], [70, 16], [0, 'ENDTAB']]), [0, 'EOF']]);
    const nativeDefault = mutateRecord(source, 'DIMSTYLE', groups => [...groups, [70, 0]]);
    expect(verify(source, nativeDefault).objects).toBe(0);
    expect(() => verify(source, mutateRecord(nativeDefault, 'DIMSTYLE', groups => changeValue(groups, 70, 0)))).toThrow(/group70\[0\].*changed/);
    const nondefault = mutateRecord(source, 'DIMSTYLE', groups => [...groups, [69, 2], [70, 7]]);
    expect(verify(nondefault, nondefault).objects).toBe(0);
    expect(() => verify(nondefault, nativeDefault)).toThrow(/DIMTFILLCLR/);
    expect(() => verify(nondefault, mutateRecord(nondefault, 'DIMSTYLE', groups => changeValue(groups, 69, 0)))).toThrow(/DIMTFILL.*changed/);
    expect(() => verify(source, mutateRecord(nativeDefault, 'DIMSTYLE', groups => [...groups, [70, 0]]))).toThrow(/ambiguous/);
  });
  it('allows omitted null layout active-viewport references while protecting nonnull links and subclass shade settings', () => {
    const source = text([...section('OBJECTS', [...record('DICTIONARY', '1', [[330, '0'], [3, 'SHEET'], [350, '2']]), ...record('LAYOUT', '2', [[330, '1'], [100, 'AcDbPlotSettings'], [76, 0], [77, 5], [78, 240], [333, 0], [100, 'AcDbLayout'], [1, 'Sheet'], [76, 0], [331, 0]])]), [0, 'EOF']]);
    const missing = mutateRecord(source, 'LAYOUT', groups => groups.filter(([code]) => code !== 331));
    expect(verify(source, missing).objects).toBe(2);
    expect(() => verify(mutateRecord(source, 'LAYOUT', groups => changeValue(groups, 331, '1')), missing)).toThrow(/reference changed/);
    expect(() => verify(source, mutateRecord(missing, 'LAYOUT', groups => changeValue(groups, 77, 0)))).toThrow(/group77.*changed/);
    expect(() => verify(source, mutateRecord(missing, 'LAYOUT', groups => [...groups, [79, 0]]))).toThrow(/group count/);
  });
  it.each(['views-fields', 'field-object-reference', 'unicode-metadata'])('covers every original AutoCAD OBJECTS/VIEW/header record in %s', (name) => {
    const result = verify(oracle(name), oracle(name));
    expect(result.objects).toBeGreaterThan(100); expect(result.views).toBe(3); expect(result.metadataOwners).toBeGreaterThan(4); expect(result.headerVariables).toBeGreaterThan(200);
  });
  it('allows exact logical handle remapping while keeping entity identities and opaque strings untouched', () => {
    const source = fixture(), mapping = new Map(['1', '2', '3', '4', '5', '6', 'A', '10', '11', '12', '13'].map((id, i) => [id, (0x100 + i).toString(16).toUpperCase()]));
    const target = text(pairs(source).map(([code, value]) => [code, (code === 5 || code >= 330 && code <= 369 || code === 1005) ? mapping.get(String(value)) ?? value : value]));
    expect(verify(source, target).objects).toBe(7);
    expect(target).toContain('literal\\U+0041:{"handle":"30"}');
  });
  it('accepts known FIELD chunk framing and numeric/binary formatting without relaxing opaque text', () => {
    const source = fixture();
    const target = mutateRecord(source, 'FIELD', groups => groups.filter(([code]) => code !== 3 && code !== 9).map(([code, value]) => [code, code === 2 ? '%<\\_FldIdx 0>%' : code === 301 ? 'cached value' : value]));
    expect(verify(source, target).objects).toBe(7);
    expect(verify(source, source.replace('00017F80FF', '00017f80ff').replace('\r\n4\r\n293', '\r\n4.000000000000000\r\n293')).objects).toBe(7);
  });
  it.each([46, 293, 294])('rejects recognized MLEADERSTYLE group%s loss even if a writer snapshot omitted it', code => {
    const source = fixture(), target = mutateRecord(source, 'MLEADERSTYLE', groups => groups.filter(([group]) => group !== code));
    expect(() => verify(source, target)).toThrow(/MLEADERSTYLE.*group count changed/);
  });
  it('rejects real AutoCAD MLEADERSTYLE/headervar loss with object or property context', () => {
    const source = oracle('views-fields');
    const changed = mutateRecord(source, 'MLEADERSTYLE', groups => changeValue(groups, 46, 99));
    expect(() => verify(source, changed)).toThrow(/MLEADERSTYLE.*group46.*changed/);
    const header = pairs(source), index = header.findIndex(([code, value]) => code === 9 && value === '$PSOLHEIGHT');
    expect(index).toBeGreaterThan(0); header[index + 1] = [40, '0.25'];
    expect(() => verify(source, text(header))).toThrow(/HEADER.\$PSOLHEIGHT/);
  });
  it.each([1, 310, 160, 340, 320])('rejects opaque XRECORD group%s mutation, including exact int64 and arbitrary handles', code => {
    const source = fixture(), target = mutateRecord(source, 'XRECORD', groups => changeValue(groups, code, ({ 1: 'literalA:{"handle":"30"}', 310: '00017F80FE', 160: '9007199254740992', 340: '11', 320: 'FFFE' } as Record<number, string>)[code]!));
    expect(() => verify(source, target)).toThrow(/XRECORD.*group/);
  });
  it('rejects unknown OBJECTS property loss and wrong FIELD child/reference targets', () => {
    const source = fixture();
    expect(() => verify(source, mutateRecord(source, 'MATERIAL', groups => [...groups, [290, 1]]))).toThrow(/MATERIAL.*group count/);
    expect(() => verify(source, mutateRecord(source, 'FIELD', groups => changeValue(groups, 331, '11')))).toThrow(/FIELD.*reference changed/);
    expect(() => verify(source, mutateRecord(source, 'FIELD', groups => changeValue(groups, 360, '3')))).toThrow(/FIELD|XRECORD|aliases/);
  });
  it('compares extension dictionaries, common reactors and entity XDATA independently of appearance', () => {
    const source = fixture();
    expect(() => verify(source, mutateRecord(source, 'LINE', groups => changeValue(groups, 1000, 'literalA:{"handle":"3"}')))).toThrow(/LINE.*group1000/);
    expect(() => verify(source, mutateRecord(source, 'LINE', groups => changeValue(groups, 330, 'A')))).toThrow(/LINE.*reference changed/);
    const changed = mutateRecord(source, 'LINE', groups => { groups.splice(groups.findIndex(([code]) => code === 100), 0, [420, 0x123456], [440, 123]); return groups; });
    expect(verify(source, changed).metadataOwners).toBe(1);
  });
  it('keeps full 3D VIEW target/direction/twist and refuses changed header pointers', () => {
    const source = fixture();
    for (const code of [31, 32, 50]) expect(() => verify(source, mutateRecord(source, 'VIEW', groups => changeValue(groups, code, 0)))).toThrow(/VIEW.*changed/);
    expect(() => verify(source, source.replace('347\r\nA', '347\r\n6'))).toThrow(/HEADER.*reference changed/);
    expect(verify(source, source.replace('40\r\n123', '40\r\n456')).headerVariables).toBe(4);
    expect(() => verify(source, source.replace('{retained}', '{different}'))).toThrow(/FINGERPRINTGUID/);
  });
  it.each(['$TDCREATE', '$TDUCREATE'])('retains real file creation time %s for native CreateDate field semantics', variable => {
    const source = oracle('views-fields'), all = pairs(source), at = all.findIndex(([code, value]) => code === 9 && String(value).trim() === variable);
    expect(at).toBeGreaterThan(0); const stored = all[at + 1]!;
    all[at + 1] = [stored[0], String(Number(stored[1]) + 1)];
    expect(() => verify(source, text(all))).toThrow(new RegExp(`HEADER.\\${variable}.*changed`));
    all.splice(at, 2); expect(() => verify(source, text(all))).toThrow(new RegExp(`HEADER.\\${variable}.*missing`));
  });
  it('accepts the proven native VIEW scalar order while preserving all camera values and unknown framing', () => {
    const source = oracle('views-fields');
    const target = mutateRecord(source, 'VIEW', groups => { const twist = groups.find(([code]) => code === 50)!; const lens = groups.findIndex(([code]) => code === 42); groups = groups.filter(([code]) => code !== 50); groups.splice(lens, 0, twist); return groups; });
    expect(verify(source, target).views).toBe(3);
  });
  it('normalizes only documented PlotSettings shade defaults, with subclass-scoped comparisons', () => {
    const source = text([...section('OBJECTS', [...record('DICTIONARY', '1', [[330, '0'], [3, 'LAYOUT'], [350, '2']]), ...record('LAYOUT', '2', [[330, '1'], [100, 'AcDbPlotSettings'], [40, 6.35], [100, 'AcDbLayout'], [1, 'Layout1'], [76, 0]])]), [0, 'EOF']]);
    const target = source.replace('100\r\nAcDbLayout', '76\r\n0\r\n77\r\n0\r\n78\r\n300\r\n333\r\n0\r\n100\r\nAcDbLayout');
    expect(verify(source, target).objects).toBe(2);
    expect(() => verify(source, target.replace('78\r\n300', '78\r\n600'))).toThrow(/LAYOUT.*group78/);
  });
  it('requires every independently inventoried target object to be present with its exact class', () => {
    const source = fixture();
    expect(verify(source, source, [{ handle: '30', type: 'LINE', dxfType: 'LINE' }, { handle: '10', type: 'STYLE_CONTROL', dxfType: 'STYLE_CONTROL' }]).objects).toBe(7);
    expect(() => verify(source, source, [{ handle: 'FFFF', type: 'MLEADERSTYLE', dxfType: 'MLEADERSTYLE' }])).toThrow(/TARGET:MLEADERSTYLE.*absent/);
    expect(() => verify(source, source, [{ handle: '3', type: 'FIELD', dxfType: 'FIELD' }])).toThrow(/TARGET:FIELD.*changed class/);
  });
  it('derives annotation variables only from their owned typed registry and actual matching SCALE', () => {
    const { source, target } = annotationFixture();
    expect(verify(source, target).headerVariables).toBe(6);
    expect(() => verify(source, target.replace('1\r\n1:20', '1\r\n1:10'))).toThrow(/CANNOSCALE.*matching SCALE/);
    expect(() => verify(source, target.replace('141\r\n20', '141\r\n10'))).toThrow(/SCALE.*ratio/);
    expect(() => verify(source, target.replace('5\r\n42\r\n330\r\n40', '5\r\n42\r\n330\r\n0'))).toThrow(/ANNOALLVISIBLE.*owned/);
    expect(() => verify(source, target.replace('280\r\n0\r\n1\r\n0', '280\r\n0\r\n1\r\n1'))).toThrow(/HEADER.\$ANNOALLVISIBLE/);
    expect(() => verify(source, target.replace('3\r\nANNOALLVISIBLE', '3\r\nOTHER_APPLICATION'))).toThrow(/ANNOALLVISIBLE.*owned/);
  });
  it('rejects contradictory source annotation headers rather than ignoring retained variable payload', () => {
    const { source, target } = annotationFixture();
    const header = pairs(target), index = header.findIndex(([code, value]) => code === 0 && value === 'ENDSEC');
    header.splice(index, 0, [9, '$CANNOSCALE'], [2, '1:10'], [9, '$ANNOALLVISIBLE'], [70, '0']);
    expect(() => verify(text(header), target)).toThrow(/CANNOSCALE.*symbol changed/);
    expect(() => verify(source, source)).toThrow(/annotation variables.*AcDbVariableDictionary/);
  });
  it('requires even unused CLASS definitions, retaining application/proxy/entity flags and ignoring only instance counts', () => {
    const definition = [[0, 'CLASS'], [1, 'APP_ENTITY'], [2, 'AppEntity'], [3, 'CustomApp'], [90, 1024], [91, 0], [280, 0], [281, 1]] as Pair[];
    const source = text([...section('CLASSES', definition), [0, 'EOF']]);
    expect(verify(source, source.replace('91\r\n0', '91\r\n12')).objects).toBe(0);
    expect(() => verify(source, text([...section('CLASSES', []), [0, 'EOF']]))).toThrow(/CLASS\(APP_ENTITY\).*missing/);
    for (const code of [3, 90, 280, 281]) expect(() => verify(source, mutateRecord(source, 'CLASS', groups => changeValue(groups, code, code === 3 ? 'OtherApp' : 5)))).toThrow(/CLASS.*changed/);
    expect(() => verify(source, text([...section('CLASSES', [...definition, ...definition]), [0, 'EOF']]))).toThrow(/ambiguous logical/);
  });
  it('normalizes only DBCOLOR signed truecolor storage, retaining ACI/book names and color methods', () => {
    const source = text([...section('OBJECTS', [...record('DICTIONARY', '1', [[330, '0'], [3, 'COLOR'], [350, '2']]), ...record('DBCOLOR', '2', [[330, '1'], [100, 'AcDbColor'], [62, 3], [420, 42577], [430, 'PANTONE$355 C']])]), [0, 'EOF']]);
    expect(verify(source, source.replace('420\r\n42577', `420\r\n${Number(BigInt.asIntN(32, 0xc2000000n | 42577n))}`)).objects).toBe(2);
    expect(() => verify(source, source.replace('420\r\n42577', `420\r\n${Number(BigInt.asIntN(32, 0xc3000000n | 42577n))}`))).toThrow(/DBCOLOR.*method changed/);
    expect(() => verify(source, source.replace('PANTONE$355 C', 'PANTONE$355 D'))).toThrow(/DBCOLOR.*group430/);
  });
  it.each([['APPID', 70, 64], ['LAYER', 70, 66], ['BLOCK_RECORD', 70, 1], ['BLOCK_RECORD', 280, 0], ['BLOCK_RECORD', 281, 1], ['STYLE', 70, 4], ['STYLE', 71, 2], ['STYLE', 42, 10], ['VPORT', 12, 99], ['VPORT', 41, 99]] as const)('rejects native-side retained %s group%s loss before commit', (type, code, desired) => {
    const original = oracle('views-fields'), source = mutateRecord(original, type, groups => changeValue(groups, code, desired));
    expect(() => verify(source, original)).toThrow(new RegExp(`${type}.*group${code}.*changed`));
  });
  it('retains ordered tiled VPORT cells and unknown native properties while permitting known scalar framing', () => {
    const viewport = (handle: string, x: number): Pair[] => record('VPORT', handle, [[330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewportTableRecord'], [2, '*Active'], [70, 0], [12, x], [22, 10], [40, 20], [41, 1.5], [150, 'opaque']]);
    const source = text([...section('TABLES', [...record('TABLE', '1', [[2, 'VPORT'], [330, '0']]), ...viewport('2', 10), ...viewport('3', 20), [0, 'ENDTAB']]), [0, 'EOF']]);
    expect(verify(source, source).objects).toBe(0);
    expect(() => verify(source, source.replace('150\r\nopaque', '150\r\nlost'))).toThrow(/VPORT.*unmodeled.*changed/);
    expect(() => verify(source, source.replace('12\r\n20', '12\r\n25'))).toThrow(/VPORT.*group12/);
  });
  it.each([0, 1])('preserves explicit VPORT default lighting type%s while allowing documented scalar order', lighting => {
    const viewport: Pair[] = record('VPORT', '2', [[330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewportTableRecord'], [2, '*Active'], [70, 0], [292, 1], [282, lighting], [150, 'first opaque'], [151, 'second opaque']]);
    const source = text([...section('TABLES', [...record('TABLE', '1', [[2, 'VPORT'], [330, '0']]), ...viewport, [0, 'ENDTAB']]), [0, 'EOF']]);
    const reordered = mutateRecord(source, 'VPORT', groups => [...groups.filter(([code]) => code !== 282), [282, lighting]]);
    expect(verify(source, reordered).objects).toBe(0);
    expect(() => verify(source, mutateRecord(reordered, 'VPORT', groups => changeValue(groups, 282, 1 - lighting)))).toThrow(/VPORT.*group282.*changed/);
    expect(() => verify(source, mutateRecord(reordered, 'VPORT', groups => [...groups, [282, lighting]]))).toThrow(/VPORT.*group282 count changed/);
    const omitted = mutateRecord(source, 'VPORT', groups => groups.filter(([code]) => code !== 282));
    expect(() => verify(source, omitted)).toThrow(/VPORT.*group282 count changed/);
    expect(verify(omitted, reordered).objects).toBe(0);
    expect(() => verify(source, mutateRecord(reordered, 'VPORT', groups => [...groups, [152, 'new opaque']]))).toThrow(/VPORT.*unmodeled.*group count changed/);
    expect(() => verify(source, mutateRecord(reordered, 'VPORT', groups => groups.map(pair => pair[0] === 150 ? [151, 'second opaque'] : pair[0] === 151 ? [150, 'first opaque'] : pair)))).toThrow(/VPORT.*unmodeled.*framing\/order/);
  });
  it('bounds malformed projections and rejects duplicate identities rather than comparing partial data', () => {
    const source = fixture();
    expect(() => verify(source, source.slice(0, -12))).toThrow(DwgMetadataEquivalenceError);
    expect(() => verify(source, source.replace('5\r\nA', '5\r\n3'))).toThrow(/duplicate/);
    expect(() => verify(source, ('雷'.repeat(100000) + '\n').repeat(112))).toThrow(/UTF-8 budget/);
    expect(() => verify(source, source.replace('file.dwg', 'x'.repeat(1024 * 1024 + 1)))).toThrow(/value.*budget/);
  });
});
