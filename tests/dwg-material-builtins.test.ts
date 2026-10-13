import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';
// @ts-expect-error shared plain-JS native reader, as in native-dwg-runtime.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

type Pair = [number, string | number];
const text = (pairs: Pair[]) => pairs.flat().join('\r\n') + '\r\n';
const record = (type: string, handle: string, groups: Pair[]): Pair[] => [[0, type], [5, handle], ...groups];
const matrixCodes = [43, 47, 49, 142, 144, 147], sources = [72, 77, 171, 175, 179];
const matrix = (code: number): Pair[] => Array.from({ length: 16 }, (_, index) => [code, code + (index % 5 === 0 ? .25 + index : index * .01)]);
const sourceBody = (name = 'ByBlock'): Pair[] => [[1, name],
  [72, 0], ...matrix(43), [77, 0], ...matrix(47), [171, 0], ...matrix(49),
  [175, 0], ...matrix(142), [179, 0], ...matrix(144), ...matrix(147)];
// Independent authored native grammar from the authenticated C MAT_MAP schema.
// No production projection generates the expected side of these checks.
const nativeBody = (name = 'ByBlock'): Pair[] => [[1, name], [2, ''], [70, 0], [40, 1], [71, 0], [41, 1],
  [42, 1], [73, 2], [74, 1], [75, 1], ...matrix(43), [72, 0],
  [277, 0], [278, 0], [460, 0], [279, 0], [461, 0], [76, 0], [45, 1], [44, .5],
  [46, 1], [78, 2], [79, 1], [170, 1], ...matrix(47), [77, 0],
  [48, 1], [172, 2], [173, 1], [174, 1], ...matrix(49), [171, 0],
  [140, 1], [141, 1], [176, 2], [177, 1], [178, 1], ...matrix(142), [175, 0],
  [143, 1], [270, 2], [271, 1], [272, 1], ...matrix(144), [179, 0],
  [145, 1], [146, 1], [274, 2], [275, 1], [276, 1], ...matrix(147), [273, 0], [94, 127]];
const common: Pair[] = [[102, '{ACAD_XDICTIONARY'], [360, '3'], [102, '}'], [102, '{ACAD_REACTORS'], [330, 'A'], [102, '}'], [330, 'A'], [100, 'AcDbMaterial']];
type DrawingOptions = { name?: string; version?: string; key?: string; owner?: string; prefix?: Pair[]; tail?: Pair[]; payload?: string; rootKey?: string };
function drawing(body: Pair[], { name = 'ByBlock', version = 'AC1032', key = name, owner = 'A', prefix = common, tail = [], payload = 'retained opaque ADVMATERIAL', rootKey = 'ACAD_MATERIAL' }: DrawingOptions = {}) {
  let bracket = 0;
  const owned = prefix.map((pair): Pair => {
    if (pair[0] === 102) bracket += String(pair[1]).startsWith('{') ? 1 : pair[1] === '}' ? -1 : 0;
    return pair[0] === 330 && !bracket ? [330, owner] : pair;
  });
  return text([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, version], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'OBJECTS'],
    ...record('DICTIONARY', '1', [[330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, rootKey], [350, 'A']]),
    ...record('DICTIONARY', 'A', [[330, '1'], [100, 'AcDbDictionary'], [281, 1], [3, key], [350, '2']]),
    ...record('MATERIAL', '2', [...owned, ...body, ...tail]),
    ...record('DICTIONARY', '3', [[330, '2'], [100, 'AcDbDictionary'], [281, 1], [3, 'ADVMATERIAL'], [350, '4']]),
    ...record('XRECORD', '4', [[330, '3'], [100, 'AcDbXrecord'], [280, 1], [1, payload], [310, '00ABFF'], [340, '2']]),
    [0, 'ENDSEC'], [0, 'EOF']]);
}
const clone = (pairs: Pair[]) => pairs.map((pair): Pair => [...pair]);
const changed = (pairs: Pair[], code: number, value: string | number, ordinal = 0) => {
  const result = clone(pairs), positions = result.flatMap((pair, index) => pair[0] === code ? [index] : []);
  expect(positions.length).toBeGreaterThan(ordinal); result[positions[ordinal]!] = [code, value]; return result;
};
const added = nativeBody().flatMap(([code], index) => !matrixCodes.includes(code) && !sources.includes(code) && code !== 1 ? [index] : []);

describe('checked AC1032 compact built-in MATERIAL native projection', () => {
  it.each(['ByBlock', 'ByLayer', 'Global'])('preserves complete%s mapper/common/ADVMATERIAL data across110→151', name => {
    expect(common.length + sourceBody(name).length).toBe(110); expect(common.length + nativeBody(name).length).toBe(151);
    expect(added).toHaveLength(41);
    expect(() => verify(drawing(sourceBody(name), { name }), drawing(nativeBody(name), { name }))).not.toThrow();
  });
  it.each(matrixCodes.flatMap(code => Array.from({ length: 16 }, (_, index) => [code, index] as const)))('refuses mapper%s component%s mutation', (code, index) => {
    expect(() => verify(drawing(sourceBody()), drawing(changed(nativeBody(), code, 99.25, index)))).toThrow(new RegExp(`group${code}.*changed`));
  });
  it('preserves coherent nondefault source/native matrix edits instead of supplying identity matrices', () => {
    let first = sourceBody(), second = nativeBody();
    for (const code of matrixCodes) { first = changed(first, code, -18.375, 11); second = changed(second, code, -18.375, 11); }
    expect(() => verify(drawing(first), drawing(second))).not.toThrow();
  });
  it.each(matrixCodes.slice(1))('refuses cross-mapper replacement of group43 by group%s values', code => {
    const second = nativeBody(), replacements = matrix(code).map(([, value]) => value);
    let cursor = 0;
    for (const pair of second) if (pair[0] === 43) pair[1] = replacements[cursor++]!;
    expect(() => verify(drawing(sourceBody()), drawing(second))).toThrow(/group43.*changed/);
  });
  it.each(added)('checks added native field at position%s, including all36defaults and nestedfivezero values', index => {
    const altered = nativeBody(), [code, value] = altered[index]!; altered[index] = [code, code === 2 ? 'changed description' : Number(value) + 1];
    expect(() => verify(drawing(sourceBody()), drawing(altered))).toThrow(/changed/);
  });
  it.each(sources)('preserves scene-source%s and refuses another source method', code => {
    expect(() => verify(drawing(sourceBody()), drawing(changed(nativeBody(), code, 1)))).toThrow(new RegExp(`group${code}.*changed`));
    expect(() => verify(drawing(changed(sourceBody(), code, 2)), drawing(changed(nativeBody(), code, 2)))).toThrow(/scene-source flag/);
  });
  it.each(matrixCodes)('refuses incomplete, repeated or nonfinite source matrix%s', code => {
    const first = sourceBody(), at = first.findIndex(pair => pair[0] === code);
    for (const altered of [first.filter((_, index) => index !== at), [...first.slice(0, at), first[at]!, ...first.slice(at)], changed(first, code, 'NaN'), changed(first, code, '1e999')]) {
      expect(() => verify(drawing(altered), drawing(nativeBody()))).toThrow(/mapper matrix|scene-source flag|unconsumed/);
    }
    const reordered = sourceBody(), other = at + 16 < reordered.length ? at + 16 : at - 1;
    [reordered[at]!, reordered[other]!] = [reordered[other]!, reordered[at]!];
    expect(() => verify(drawing(reordered), drawing(nativeBody()))).toThrow(/mapper matrix/);
  });
  it('requires every added pair and precise nested texture framing', () => {
    for (const code of [277, 278, 460, 279, 461]) {
      const native = nativeBody(), at = native.findIndex(pair => pair[0] === code);
      expect(() => verify(drawing(sourceBody()), drawing(native.filter((_, index) => index !== at)))).toThrow(/group count/);
      expect(() => verify(drawing(sourceBody()), drawing([...native.slice(0, at), native[at]!, ...native.slice(at)]))).toThrow(/group count/);
      const relocated = [...native.slice(0, at), ...native.slice(at + 1), native[at]!];
      expect(() => verify(drawing(sourceBody()), drawing(relocated))).toThrow(/framing\/order/);
    }
    expect(() => verify(drawing([...sourceBody(), [460, 0]]), drawing(nativeBody()))).toThrow(/unconsumed source/);
    expect(() => verify(drawing(sourceBody()), drawing([...nativeBody(), [460, 0]]))).toThrow(/group count/);
  });
  it.each([460, 461])('refuses tiny nonzero/underflow texture factor%s without applying matrix tolerance', code => {
    for (const value of ['1e-18', '-1e-18', '1e-999']) expect(() => verify(drawing(sourceBody()), drawing(changed(nativeBody(), code, value)))).toThrow(/default.*changed/);
  });
  it.each([40, 41, 42, 45, 46, 48, 140, 141, 143, 145, 146])('requires exact native default%s even at oneULP difference', code => {
    expect(() => verify(drawing(sourceBody()), drawing(changed(nativeBody(), code, '1.0000000000000002')))).toThrow(/default.*changed/);
  });
  it.each(['AC1015', 'AC1024', 'AC1027', 'AC1040'])('does not extend the recipe to unsupported version%s', version => {
    expect(() => verify(drawing(sourceBody(), { version }), drawing(nativeBody()))).toThrow(/group count/);
    expect(() => verify(drawing(sourceBody()), drawing(nativeBody(), { version }))).toThrow(/group count/);
  });
  it('keeps custom/full-native/unknown payloads under exact raw comparison', () => {
    const custom = [[1, 'Custom'], [460, 17], [461, .25], [430, 'Opaque book']] as Pair[];
    expect(() => verify(drawing(custom, { name: 'Custom' }), drawing(custom, { name: 'Custom' }))).not.toThrow();
    expect(() => verify(drawing(custom, { name: 'Custom' }), drawing(changed(custom, 460, 18), { name: 'Custom' }))).toThrow(/changed/);
    expect(() => verify(drawing(nativeBody()), drawing(nativeBody()))).not.toThrow();
    expect(() => verify(drawing(nativeBody()), drawing(changed(nativeBody(), 73, 3)))).toThrow(/changed/);
    expect(() => verify(drawing(sourceBody('Custom'), { name: 'Custom' }), drawing(nativeBody('Custom'), { name: 'Custom' }))).toThrow(/group count/);
  });
  it('keeps compact records and later source edits under the existing full comparison', () => {
    expect(() => verify(drawing(sourceBody()), drawing(sourceBody()))).not.toThrow();
    expect(() => verify(drawing(sourceBody()), drawing(changed(sourceBody(), 72, 1)))).toThrow(/group72.*changed/);
    expect(() => verify(drawing(sourceBody()), drawing(changed(sourceBody(), 47, 88, 9)))).toThrow(/group47.*changed/);
  });
  it.each([{ key: 'Other' }, { rootKey: 'OTHER_MATERIALS' }, { owner: '1' }])('requires native builtin slot/owner%s', options => {
    expect(() => verify(drawing(sourceBody(), options), drawing(nativeBody(), options))).toThrow(/ownership slot/);
  });
  it('retains reference, ADVMATERIAL binary/text, common and XDATA comparisons', () => {
    expect(() => verify(drawing(sourceBody()), drawing(nativeBody(), { payload: 'changed opaque material' }))).toThrow(/XRECORD.*changed/);
    const invalid = common.map((pair): Pair => pair[0] === 360 ? [360, '0'] : pair);
    expect(() => verify(drawing(sourceBody()), drawing(nativeBody(), { prefix: invalid }))).toThrow(/reference changed/);
    const wrongReactor = common.map((pair): Pair => pair[0] === 330 ? [330, '1'] : pair);
    expect(() => verify(drawing(sourceBody()), drawing(nativeBody(), { prefix: wrongReactor }))).toThrow(/reference changed/);
    const tail: Pair[] = [[1001, 'APP'], [1000, 'opaque'], [1005, '4'], [1071, 460]];
    expect(() => verify(drawing(sourceBody(), { tail }), drawing(nativeBody(), { tail }))).not.toThrow();
    expect(() => verify(drawing(sourceBody(), { tail }), drawing(nativeBody(), { tail: changed(tail, 1071, 461) }))).toThrow(/changed/);
    const renumber = (dxf: string) => {
      const lines = dxf.trimEnd().split(/\r\n/); for (let index = 0; index < lines.length; index += 2) if ([5, 330, 340, 350, 360, 1005].includes(Number(lines[index])) && ['1', '2', '3', '4', 'A'].includes(lines[index + 1]!)) lines[index + 1] = 'F' + lines[index + 1];
      return lines.join('\r\n') + '\r\n';
    };
    expect(() => verify(drawing(sourceBody(), { tail }), renumber(drawing(nativeBody(), { tail })))).not.toThrow();
  });
  it('uses exact unchanged AutoCAD compact source bodies with honestly authored native producer defaults', () => {
    const raw = readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('89633c345b6c9fe5aae8ab36f6068ae8444780eba4bf11deeed85f275c01a450');
    const lines = raw.toString('utf8').trimEnd().split(/\r\n|\n|\r/), records: Array<{ type: string; groups: Pair[] }> = [];
    for (let index = 0; index < lines.length; index += 2) {
      const code = Number(lines[index]!.trim()), value = lines[index + 1]!;
      if (code === 0) records.push({ type: value.trim(), groups: [] }); else records.at(-1)?.groups.push([code, value]);
    }
    const materials = records.filter(record => record.type === 'MATERIAL'); expect(materials).toHaveLength(3);
    for (const entry of materials) {
      const start = entry.groups.findIndex(([code, value]) => code === 100 && String(value).trim() === 'AcDbMaterial'), body = entry.groups.slice(start + 1), name = String(body[0]![1]);
      let native = nativeBody(name);
      for (const code of matrixCodes) {
        const values = body.filter(pair => pair[0] === code); expect(values).toHaveLength(16);
        values.forEach((pair, index) => { native = changed(native, code, pair[1], index); });
      }
      expect(() => verify(drawing(body, { name }), drawing(native, { name }))).not.toThrow();
    }
    // This is source grammar + authored producer-default evidence only. The
    // matching compiled helper and independent C postflight remain mandatory.
    expect(readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url))).toEqual(raw);
  });
  it.runIf(process.platform === 'win32')('extracts actual original nativeC MATERIAL bodies without claiming a new-helper conversion', async () => {
    const url = new URL('./fixtures/interchange/r2018-minsert.dwg', import.meta.url), bytes = readFileSync(url);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('74cafbe617e7a885d622a8a0270b60f64cc285801be42ea8829cc9e9472616d5');
    const decoded = await readDwgPayload(Buffer.from(bytes)); // Private byte copy; no input rewrites.
    const metadata = decoded.payload.nativeMetadata as { complete: boolean; readError: number; writeError: number; dxf: string; objects: unknown[] };
    expect(metadata).toMatchObject({ complete: true, readError: 0, writeError: 0 }); expect(metadata.objects).toHaveLength(139);
    const bodies = (dxf: string) => {
      const lines = dxf.trimEnd().split(/\r\n|\n|\r/), records: Array<{ type: string; groups: Pair[] }> = [];
      for (let index = 0; index < lines.length; index += 2) {
        const code = Number(lines[index]!.trim()), value = lines[index + 1]!;
        if (code === 0) records.push({ type: value.trim(), groups: [] }); else records.at(-1)?.groups.push([code, value]);
      }
      return new Map(records.filter(entry => entry.type === 'MATERIAL').map(entry => {
        const start = entry.groups.findIndex(([code, value]) => code === 100 && String(value).trim() === 'AcDbMaterial');
        expect(start).toBeGreaterThanOrEqual(0); const body = entry.groups.slice(start + 1); return [String(body[0]![1]), body];
      }));
    };
    const wanted = bodies(readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url), 'utf8')), observed = bodies(metadata.dxf);
    expect(wanted.size).toBe(3); expect(observed.size).toBe(3);
    for (const [name, body] of wanted) {
      const actual = observed.get(name)!; expect(actual).toBeDefined();
      expect(() => verify(drawing(body, { name }), drawing(actual, { name }))).not.toThrow();
      expect(() => verify(drawing(body, { name }), drawing(changed(actual, 460, '1e-18'), { name }))).toThrow(/default.*changed/);
    }
    expect(readFileSync(url)).toEqual(bytes);
  });
});
