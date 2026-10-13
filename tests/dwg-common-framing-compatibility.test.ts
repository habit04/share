import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';
// @ts-expect-error shared plain-JS native reader, as in native-dwg-runtime.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

type Pair = [number, string | number];
const text = (pairs: Pair[]) => pairs.flat().join('\n') + '\n';
const reactors: Pair[] = [[102, '{ACAD_REACTORS'], [330, '2'], [330, '6'], [102, '}']];
const extension: Pair[] = [[102, '{ACAD_XDICTIONARY'], [360, '4'], [102, '}']];
const owner: Pair = [330, '2'];
const carrier: Pair[] = [[102, '{JCAD_TABLESTYLE_NATIVE_V1'], [90, 0], [91, 101], [360, '0'], [92, 3], [93, 1], [93, 2], [93, 3], [102, '}']];
const body: Pair[] = [[100, 'AcDbTableStyle'], [70, 0], [3, 'Standard'], [1, 'TABLEFORMAT_BEGIN'], [40, .06], [41, .06], [309, 'TABLEFORMAT_END']];
const xdata: Pair[] = [[1001, 'APP'], [1000, 'Opaque'], [1005, '5'], [1070, 7]];
const clone = (pairs: Pair[]) => pairs.map((pair): Pair => [...pair]);
const common = (xdFirst = false): Pair[] => [...clone(xdFirst ? extension : reactors), ...clone(xdFirst ? reactors : extension), [...owner]];
type Options = { type?: string; body?: Pair[]; tail?: Pair[] };
// Authored common-reference graph. Its modern body is a raw framing fixture,
// not a claim that this abbreviated object can be encoded by the native writer.
function drawing(prefix: Pair[], { type = 'TABLESTYLE', body: payload = body, tail = xdata }: Options = {}) {
  return text([[0, 'SECTION'], [2, 'OBJECTS'],
    [0, 'DICTIONARY'], [5, '1'], [330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_TABLESTYLE'], [350, '2'],
    [0, 'DICTIONARY'], [5, '2'], [330, '1'], [100, 'AcDbDictionary'], [281, 1], [3, 'Standard'], [350, '3'], [3, 'OtherReactor'], [350, '6'],
    [0, 'DICTIONARY'], [5, '4'], [330, '3'], [100, 'AcDbDictionary'], [281, 1], [3, 'OpaquePayload'], [350, '5'],
    [0, 'XRECORD'], [5, '5'], [330, '4'], [100, 'AcDbXrecord'], [280, 1], [1, 'Retained payload'], [310, '00ABFF'],
    [0, 'XRECORD'], [5, '6'], [330, '2'], [100, 'AcDbXrecord'], [280, 1], [1, 'Second reactor'],
    [0, type], [5, '3'], ...prefix, ...payload, ...tail, [0, 'ENDSEC'], [0, 'EOF']]);
}
function changed(pairs: Pair[], index: number, value: string | number) { const result = clone(pairs); result[index]![1] = value; return result; }
function renumber(dxf: string) {
  const lines = dxf.trimEnd().split('\n');
  for (let index = 0; index < lines.length; index += 2) if ([5, 330, 350, 360, 1005].includes(Number(lines[index])) && lines[index + 1] !== '0') lines[index + 1] = 'F' + lines[index + 1];
  return lines.join('\n') + '\n';
}

describe('TABLESTYLE-only complete adjacent common reference framing', () => {
  it.each([false, true])('compares both complete block orders symmetrically%s and retains the native carrier', first => {
    expect(() => verify(drawing([...common(first), ...carrier]), drawing([...common(!first), ...carrier]))).not.toThrow();
    expect(() => verify(drawing([...common(first), ...carrier]), renumber(drawing([...common(!first), ...carrier])))).not.toThrow();
  });
  it('preserves an independently decoded ordered reactor list rather than sorting it', () => {
    const altered = common(true), at = altered.findIndex(([code]) => code === 330);
    [altered[at]!, altered[at + 1]!] = [altered[at + 1]!, altered[at]!];
    expect(() => verify(drawing(common()), drawing(altered))).toThrow(/reference changed/);
  });
  it.each([['reactor', 1, '1'], ['second reactor', 2, '5'], ['owner', 7, '1']] as const)('retains%s target identity', (_name, at, value) => {
    expect(() => verify(drawing(common()), drawing(changed(common(), at, value)))).toThrow(/reference changed/);
  });
  it('refuses an extension dictionary target that creates a changed ownership graph', () => {
    expect(() => verify(drawing(common()), drawing(changed(common(), 5, '1')))).toThrow(/logical metadata ownership exceeds its depth budget/);
  });
  it('does not supply missing blocks, payload entries or owners', () => {
    for (const altered of [[...reactors, owner], [...extension, owner], common().filter((_, index) => index !== 2), common().slice(0, -1)]) {
      expect(() => verify(drawing(common()), drawing(altered))).toThrow();
    }
  });
  const malformed: Array<[string, Pair[]]> = [
    ['duplicate reactors', [...reactors, ...reactors, ...extension, owner]],
    ['duplicate extension', [...reactors, ...extension, ...extension, owner]],
    ['duplicate owner', [...common(), owner]],
    ['empty reactors', [[102, '{ACAD_REACTORS'], [102, '}'], ...extension, owner]],
    ['empty extension', [...reactors, [102, '{ACAD_XDICTIONARY'], [102, '}'], owner]],
    ['two extension handles', [...reactors, [102, '{ACAD_XDICTIONARY'], [360, '4'], [360, '4'], [102, '}'], owner]],
    ['wrong reactor code', changed(reactors, 1, '2').map((pair, index): Pair => index === 1 ? [360, pair[1]] : pair).concat(extension, [owner])],
    ['null reactor', [...changed(reactors, 1, '0'), ...extension, owner]],
    ['null extension', [...reactors, ...changed(extension, 1, '0'), owner]],
    ['nested common block', [[102, '{ACAD_REACTORS'], ...extension, [330, '2'], [102, '}'], owner]],
    ['unclosed reactors', [...reactors.slice(0, -1), ...extension, owner]],
    ['scalar interleaving', [...reactors, [999, 'Opaque fence'], ...extension, owner]],
    ['owner interleaving', [...reactors, owner, ...extension]],
    ['opaque interleaving', [...reactors, [102, '{OPAQUE'], [1, 'fence'], [102, '}'], ...extension, owner]],
    ['early opaque group', [[102, '{OPAQUE'], [1, 'fence'], [102, '}'], ...common()]],
    ['late known group', [...common(), ...carrier, ...extension]],
    ['unbracketed extension pointer', [...common(), [360, '4']]],
    ['nested opaque tail', [...common(), [102, '{OPAQUE'], [102, '{NESTED'], [1, 'kept'], [102, '}'], [102, '}']]],
  ];
  it.each(malformed)('refuses ambiguous%s even when both raw sides are identical', (_name, prefix) => {
    expect(() => verify(drawing(prefix), drawing(prefix))).toThrow(/TABLESTYLE.*common/);
    expect(() => verify(drawing(common()), drawing(prefix))).toThrow();
  });
  it('bounds actual ordered reactor payload work at1024 without dropping any entries', () => {
    const many: Pair[] = [[102, '{ACAD_REACTORS'], ...Array.from({ length: 1024 }, (): Pair => [330, '2']), [102, '}'], ...extension, owner];
    expect(() => verify(drawing(many), drawing(many))).not.toThrow();
    const excess = clone(many); excess.splice(1, 0, [330, '2']); expect(() => verify(drawing(excess), drawing(excess))).toThrow(/common reference payload/);
  });
  it('keeps opaque carrier/app payload, owner, following subclasses and XDATA exact', () => {
    for (const [at, value] of [[1, 1], [2, 102], [3, '4'], [4, 4], [5, 9]] as Array<[number, string | number]>) {
      expect(() => verify(drawing([...common(), ...carrier]), drawing([...common(true), ...changed(carrier, at, value)]))).toThrow();
    }
    const suffix: Pair[] = [[100, 'OpaqueSubclass'], [102, '{ACAD_REACTORS'], [330, '6'], [102, '}'], [470, 'retained']];
    expect(() => verify(drawing(common(), { body: [...body, ...suffix] }), drawing(common(true), { body: [...body, ...suffix] }))).not.toThrow();
    expect(() => verify(drawing(common(), { body: [...body, ...suffix] }), drawing(common(true), { body: [...body, ...changed(suffix, 4, 'changed')] }))).toThrow(/changed/);
    expect(() => verify(drawing(common()), drawing(common(true), { tail: changed(xdata, 1, 'changed') }))).toThrow(/changed/);
  });
  it('preserves raw unknown-only common framing without granting an order or value waiver', () => {
    const raw: Pair[] = [owner, [102, '{OPAQUE'], [470, 'kept'], [102, '}']];
    expect(() => verify(drawing(raw), drawing(raw))).not.toThrow();
    expect(() => verify(drawing(raw), drawing(changed(raw, 2, 'changed')))).toThrow(/changed/);
  });
  it('retains a large opaque-only raw prefix under the original global comparison budget', () => {
    const opaque: Pair[] = [[102, '{OPAQUE'], ...Array.from({ length: 17000 }, (): Pair => [470, 'kept']), [102, '}']];
    const raw = [owner, ...opaque];
    expect(() => verify(drawing(raw), drawing(raw))).not.toThrow();
    expect(() => verify(drawing(raw), drawing(changed(raw, 16000, 'changed')))).toThrow(/group470.*changed/);
    const claimed = [...common(), ...opaque];
    expect(() => verify(drawing(claimed), drawing(claimed))).toThrow(/common prefix exceeds its framing budget/);
  });
  it.each([100, 1001])('retains opaque-tail group%s as data, with following real subclass/XDATA unchanged', code => {
    const opaque: Pair[] = [[102, '{OPAQUE'], [code, 'opaque-data'], [470, 'kept'], [102, '}']];
    expect(() => verify(drawing([...common(), ...opaque]), drawing([...common(true), ...opaque]))).not.toThrow();
    expect(() => verify(drawing([...common(), ...opaque]), drawing([...common(true), ...changed(opaque, 1, 'changed')]))).toThrow(/changed/);
    const early = [...opaque, ...common()];
    expect(() => verify(drawing(early), drawing(early))).toThrow(/interleaved.*common/);
  });
  it.each(['XRECORD', 'CUSTOM_OBJECT', 'MLEADERSTYLE', 'MLINESTYLE'])('does not reorder the same blocks on%s', type => {
    expect(() => verify(drawing(common(), { type }), drawing(common(true), { type }))).toThrow(/group102.*changed/);
  });
  it('uses the entire actual159 AutoCAD legacy body, with only authored graph IDs remapped', () => {
    const bytes = readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url));
    expect(createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex')).toBe('d0539d4040a7c59264de839864bfacfa2728b820e527c84df4c157397cb52a96');
    const lines = bytes.toString('utf8').trimEnd().split(/\r\n|\n|\r/); let start = -1;
    for (let index = 0; index < lines.length; index += 2) if (lines[index]!.trim() === '0' && lines[index + 1] === 'TABLESTYLE' && lines[index + 3] === '159') { start = index + 4; break; }
    expect(start).toBeGreaterThan(0); const fields: Pair[] = [];
    for (let index = start; index < lines.length && lines[index]!.trim() !== '0'; index += 2) fields.push([Number(lines[index]), lines[index + 1]!]);
    const marker = fields.findIndex(([code, value]) => code === 100 && value === 'AcDbTableStyle'), prefix = fields.slice(0, marker).map(([code, value]): Pair => [code, code === 360 ? '4' : code === 330 ? '2' : value]);
    expect(prefix[0]).toEqual([102, '{ACAD_XDICTIONARY']);
    const reordered = [...prefix.slice(3, 6), ...prefix.slice(0, 3), ...prefix.slice(6)];
    expect(() => verify(drawing(prefix, { body: fields.slice(marker), tail: [] }), drawing(reordered, { body: fields.slice(marker), tail: [] }))).not.toThrow();
    expect(readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url))).toEqual(bytes);
  });
  it.runIf(process.platform === 'win32')('accepts actual original C TABLESTYLE carrier framing without claiming addedXD or a converted helper', async () => {
    const url = new URL('./fixtures/interchange/r2018-minsert.dwg', import.meta.url), bytes = readFileSync(url);
    const decoded = await readDwgPayload(Buffer.from(bytes));
    const metadata = decoded.payload.nativeMetadata as { complete: boolean; readError: number; writeError: number; dxf: string; objects: never[] };
    expect(metadata).toMatchObject({ complete: true, readError: 0, writeError: 0 });
    expect(() => verify(metadata.dxf, metadata.dxf, metadata.objects)).not.toThrow();
    expect(readFileSync(url)).toEqual(bytes);
  });
});
