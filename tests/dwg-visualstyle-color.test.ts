import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyDwgMetadataEquivalence as verify } from '../scripts/dwg-metadata-equivalence.mjs';
// @ts-expect-error shared plain-JS native reader, as in native-dwg-runtime.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

type Pair = [number, string | number];
const text = (pairs: Pair[]) => pairs.flat().join('\r\n') + '\r\n';
const record = (type: string, handle: string, pairs: Pair[]): Pair[] => [[0, type], [5, handle], ...pairs];
const colorSlots = [6, 9, 10, 15, 20, 41, 44, 51];
// Authored58-property fixture follows the published ordered AcGi enum, rather
// than calling the production projection to generate either comparison side.
const properties = (): Pair[][] => [
  ...[[90, 3], [90, 2], [90, 1], [90, 0], [40, .6], [40, 30], [62, 7], [90, 1], [90, 2], [62, 7], [62, 257], [90, 1], [90, 1], [40, 30], [90, 0], [62, 257], [40, 1], [90, 1], [90, 6], [90, 2], [62, 7], [90, 1], [90, 0], [90, 0], [290, 0], [90, 1], [40, 0], [90, 0]] as Pair[],
  ...Array.from({ length: 9 }, (): Pair => [290, 0]),
  ...[[90, 0], [40, 0], [40, 0], [90, 0], [62, 18], [90, 0], [90, 0], [62, 5], [290, 0], [90, 0], [90, 0], [90, 0], [290, 0], [90, 0], [62, 256], [40, 1], [90, 0], [1, 'opaque strokes'], [290, 0], [40, 0], [40, 0]] as Pair[],
].map((pair, index) => [pair, [176, index === 14 ? 2 : 1]]);
const body = (bag: Pair[][] = properties(), tail: Pair[] = [], lighting: string | number = 3): Pair[] => [
  [2, 'Authored Δ'], [70, 0], [177, lighting], [291, 0], [70, 58], ...bag.flat(), ...tail,
];
const drawing = (payload: Pair[] = body(), version = 'AC1032', common: Pair[] = []): string => text([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, version], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'OBJECTS'],
  ...record('DICTIONARY', '1', [[330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'Visual'], [350, '2']]),
  ...record('VISUALSTYLE', '2', [...common, [330, '1'], [100, 'AcDbVisualStyle'], ...payload]),
  [0, 'ENDSEC'], [0, 'EOF'],
]);
const colored = (slot: number, rgb: string | number, aci: string | number = 18, tail: Pair[] = []): string => {
  const bag = properties(); bag[slot] = [[62, aci], [420, rgb], [176, 1]]; return drawing(body(bag, tail));
};
const raw = 0x123456, packed = 0xc2123456, signed = packed - 0x100000000;

describe('checked58-property VISUALSTYLE color semantics', () => {
  it.each(colorSlots)('compares known color slot%s across canonical/signed/unsigned nativeRGB and derived companion ACI', slot => {
    expect(() => verify(colored(slot, raw, 18), colored(slot, packed, 0))).not.toThrow();
    expect(() => verify(colored(slot, raw, 18), colored(slot, signed, 7))).not.toThrow();
    expect(() => verify(colored(slot, packed, 0), colored(slot, raw, 18))).not.toThrow();
    expect(() => verify(colored(slot, signed, 0), colored(slot, packed, 257))).not.toThrow();
  });
  it.each(colorSlots.flatMap(slot => [0x123457, 0x123556, 0x133456].map(rgb => [slot, rgb])))('refuses changed RGB bit in property%s (%s)', (slot, rgb) => {
    expect(() => verify(colored(slot!, raw), colored(slot!, rgb!))).toThrow(/group420.*changed/);
  });
  it.each([0, 1, 0xff, 0x100, 0x10000, 0xffffff])('compares all24RGB bits including extrema %s', rgb => {
    expect(() => verify(colored(41, rgb), colored(41, (BigInt(rgb) | 0xc2000000n).toString()))).not.toThrow();
  });
  it.each(colorSlots)('retains standalone indexed color exactly in slot%s', slot => {
    const first = properties(), second = properties(); first[slot] = [[62, 18], [176, 1]]; second[slot] = [[62, 19], [176, 1]];
    expect(() => verify(drawing(body(first)), drawing(body(second)))).toThrow(/group62.*changed/);
    expect(() => verify(drawing(body(first)), drawing(body(first)))).not.toThrow();
    second[slot] = [[62, 18], [420, packed], [176, 1]];
    expect(() => verify(drawing(body(first)), drawing(body(second)))).toThrow(/group count changed/);
  });
  it.each([1, 0xc0, 0xc1, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xff])('refuses unsupported RGB method%s even if both sides match', method => {
    const rgb = ((BigInt(method) << 24n) | BigInt(raw)).toString(), invalid = colored(41, rgb);
    expect(() => verify(invalid, invalid)).toThrow(/unsupported RGB color method/);
    expect(() => verify(colored(41, raw), invalid)).toThrow(/unsupported RGB color method/);
    expect(() => verify(invalid, colored(41, raw))).toThrow(/unsupported RGB color method/);
  });
  it.each(['-2147483649', '4294967296', '99999999999999999999', '123456789012345678901', '1.2', '0x123456', '1e6', '', 'NaN'])('refuses malformed/out-of-range RGB%s', rgb => {
    const invalid = colored(41, rgb); expect(() => verify(invalid, invalid)).toThrow(/RGB.*storage/);
  });
  it.each([-1, 258, '1.2', '1e2', '0x12', '', '123456789012345678901'])('requires bounded RGB companionACI%s', aci => {
    const invalid = colored(41, raw, aci); expect(() => verify(invalid, invalid)).toThrow(/color-index storage/);
  });
  it('proves companion62 is one ByColor fallback, not an unrelated inactive indexed color', () => {
    // AutoCAD sourcePencilColor has18+blackRGB0; native CMC stores ByColorRGB
    // and its C decoder derives ACI0. Official420 precedence selects black.
    expect(() => verify(colored(41, 0, 18), colored(41, -1040187392, 0))).not.toThrow();
    const first = properties(), second = properties();
    first[41] = [[62, 18], [420, 0], [176, 1]];
    second[41] = [[62, 0], [420, -1040187392], [176, 1]];
    second[44] = [[62, 6], [176, 1]]; // No explicitRGB: this separate property is retained.
    expect(() => verify(drawing(body(first)), drawing(body(second)))).toThrow(/group62.*changed/);
  });
  it('rejects duplicate/missing color companions, RGB values and selectors before normalization', () => {
    for (const invalid of [
      [[62, 18], [62, 7], [420, raw], [176, 1]],
      [[62, 18], [420, raw], [420, raw], [176, 1]],
      [[420, raw], [176, 1]], [[62, 18], [420, raw]],
      [[62, 18], [420, raw], [176, 1], [176, 1]],
    ] as Pair[][]) {
      const bag = properties(); bag[41] = invalid;
      expect(() => verify(drawing(body(bag)), drawing(body(bag)))).toThrow(/VISUALSTYLE|selector/);
    }
  });
  it.each([-1, 4, 32768, '1.5', 'NaN'])('refuses invalid operation selector%s even if identical', selector => {
    const bag = properties(); bag[41] = [[62, 18], [420, raw], [176, selector]];
    expect(() => verify(drawing(body(bag)), drawing(body(bag)))).toThrow(/operation selector/);
  });
  it('keeps all known operations0–3 distinct, including bitmask enable/disable', () => {
    for (const selector of [0, 1, 2, 3]) {
      const bag = properties(); bag[41] = [[62, 18], [420, raw], [176, selector]];
      expect(() => verify(drawing(body(bag)), drawing(body(bag)))).not.toThrow();
      const altered = properties(); altered[41] = [[62, 0], [420, packed], [176, (selector + 1) % 4]];
      expect(() => verify(drawing(body(bag)), drawing(body(altered)))).toThrow(/group176.*changed/);
    }
  });
  it('requires exact count, ordered types, prefix, version and a single subclass', () => {
    const defaults = body(), mutations: Pair[][] = [
      defaults.map((pair, index): Pair => index === 4 ? [70, 57] : pair),
      body(properties().slice(0, 57)), body([...properties(), [[90, 0], [176, 1]]]),
      [...defaults.slice(0, 2), ...defaults.slice(3)],
      [...defaults.slice(0, 2), [291, 0], [177, 3], ...defaults.slice(4)],
      [[100, 'AcDbVisualStyle'], ...defaults],
    ];
    const wronglyTyped = properties(); wronglyTyped[5] = [[420, raw], [176, 1]]; mutations.push(body(wronglyTyped));
    const reordered = properties(); [reordered[5], reordered[6]] = [reordered[6]!, reordered[5]!]; mutations.push(body(reordered));
    for (const payload of mutations) expect(() => verify(drawing(payload), drawing(payload))).toThrow(/VISUALSTYLE/);
    for (const version of ['AC1015', 'AC1024', 'AC1040', 'bad']) expect(() => verify(drawing(defaults, version), drawing(defaults, version))).toThrow(/property version/);
    expect(() => verify(drawing(defaults, 'AC1027'), drawing(defaults, 'AC1032'))).not.toThrow();
  });
  it('preserves exact legacy/raw VISUALSTYLE comparison without granting RGB equivalence', () => {
    const legacy: Pair[] = [[2, 'Legacy'], [70, 0], [71, 3], [72, 2], [63, 7], [420, raw]],
      rawObject: Pair[] = [[999, 'unmodeled'], [62, 18], [420, raw]];
    for (const payload of [legacy, rawObject]) {
      expect(() => verify(drawing(payload, 'AC1015'), drawing(payload, 'AC1015'))).not.toThrow();
      const changed = payload.map((pair): Pair => pair[0] === 420 ? [420, packed] : pair);
      expect(() => verify(drawing(payload, 'AC1015'), drawing(changed, 'AC1015'))).toThrow(/group420.*changed/);
    }
  });
  it('refuses misplacedRGB and named/book framing instead of masking an unconsumed field', () => {
    for (const property of [
      [[62, 18], [176, 1], [420, raw]],
      [[62, 18], [420, raw], [430, 'Book$Name'], [176, 1]],
      [[62, 18], [420, raw], [431, 'Book$Name'], [176, 1]],
    ] as Pair[][]) {
      const bag = properties(); bag[41] = property;
      expect(() => verify(drawing(body(bag)), drawing(body(bag)))).toThrow(/VISUALSTYLE/);
    }
  });
  it('keeps lighting177, every scalar, descriptor and opaque strokes exact', () => {
    const original = properties(); original[41] = [[62, 18], [420, raw], [176, 1]];
    const native = properties(); native[41] = [[62, 0], [420, packed], [176, 1]];
    for (const lighting of [0, 2, 4]) expect(() => verify(drawing(body(original)), drawing(body(native, [], lighting)))).toThrow(/group177.*changed/);
    for (const [slot, value] of [[0, 4], [4, .7], [24, 1], [54, 'changed strokes']] as const) {
      const altered = native.map(part => part.map((pair): Pair => [...pair])); altered[slot]![0]![1] = value;
      expect(() => verify(drawing(body(original)), drawing(body(altered)))).toThrow(/changed/);
    }
    expect(() => verify(drawing(body(original)), drawing(body(native).map((pair): Pair => pair[0] === 2 ? [2, 'renamed'] : pair)))).toThrow(/group2.*changed/);
  });
  it('keeps common groups, unknown suffixes and XDATA raw despite equivalent typed colors', () => {
    const first = properties(), second = properties(); first[41] = [[62, 18], [420, raw], [176, 1]]; second[41] = [[62, 0], [420, packed], [176, 1]];
    expect(() => verify(drawing(body(first, [[1001, 'APP'], [420, raw]])), drawing(body(second, [[1001, 'APP'], [420, packed]])))).toThrow(/group420.*changed/);
    const commonA: Pair[] = [[102, '{OPAQUE'], [420, raw], [102, '}']], commonB: Pair[] = [[102, '{OPAQUE'], [420, packed], [102, '}']];
    expect(() => verify(drawing(body(first), 'AC1032', commonA), drawing(body(second), 'AC1032', commonB))).toThrow(/group420.*changed/);
    expect(() => verify(drawing(body(first, [[999, 'one'], [998, 'two']])), drawing(body(second, [[998, 'two'], [999, 'one']])))).toThrow(/framing\/order/);
    const opaque = body(first, [[1001, 'APP'], [420, -1022213034]]); expect(() => verify(drawing(opaque), drawing(opaque))).not.toThrow();
    const reactor: Pair[] = [[102, '{ACAD_REACTORS'], [330, '1'], [102, '}']], noReactor: Pair[] = [[102, '{ACAD_REACTORS'], [330, '0'], [102, '}']];
    expect(() => verify(drawing(body(first), 'AC1032', reactor), drawing(body(second), 'AC1032', noReactor))).toThrow(/reference changed/);
    expect(() => verify(drawing(body(first, [[430, 'opaque book']])), drawing(body(second, [[430, 'changed book']])))).toThrow(/group430.*changed/);
  });
  it.each(['XRECORD', 'CUSTOM_OBJECT'])('does not reinterpret other OBJECTS %s420', type => {
    const opaque = (rgb: number) => text([[0, 'SECTION'], [2, 'OBJECTS'],
      ...record('DICTIONARY', '1', [[330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'Opaque'], [350, '2']]),
      ...record(type, '2', [[330, '1'], [100, 'OpaqueClass'], [420, rgb]]), [0, 'ENDSEC'], [0, 'EOF']]);
    expect(() => verify(opaque(raw), opaque(packed))).toThrow(/group420.*changed/);
    expect(() => verify(opaque(-1022213034), opaque(-1022213034))).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('extracts actual AutoCAD/C properties; comparison target has explicitly authored coherent lighting, not a converted-DWG claim', async () => {
    const url = new URL('./fixtures/interchange/r2018-minsert.dwg', import.meta.url), bytes = await fs.readFile(url);
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(bytes)).toBe('74cafbe617e7a885d622a8a0270b60f64cc285801be42ea8829cc9e9472616d5');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'jcad-visualstyle-color-')), copy = path.join(dir, 'private-original.dwg');
    try {
      await fs.writeFile(copy, bytes, { flag: 'wx' });
      const decoded = await readDwgPayload(await fs.readFile(copy));
      const metadata = decoded.payload.nativeMetadata as { complete: boolean; readError: number; writeError: number; dxf: string; objects: unknown[] };
      expect(metadata).toMatchObject({ complete: true, readError: 0, writeError: 0 }); expect(metadata.objects).toHaveLength(139);
      const descriptors = (dxf: string) => {
        const lines = dxf.trimEnd().split(/\r\n|\n|\r/), records: Array<{ type: string; pairs: Pair[] }> = [];
        expect(lines.length % 2).toBe(0);
        for (let i = 0; i < lines.length; i += 2) {
          const code = Number(lines[i]!.trim()), value = lines[i + 1]!;
          if (code === 0) records.push({ type: value.trim(), pairs: [] });
          else if (records.length) records.at(-1)!.pairs.push([code, value]);
          else expect(code).toBe(999);
        }
        return new Map(records.filter(entry => entry.type === 'VISUALSTYLE').map(entry => {
          const handle = String(entry.pairs.find(([code]) => code === 5)![1]).trim(), at = entry.pairs.findIndex(([code, value]) => code === 100 && String(value).trim() === 'AcDbVisualStyle');
          expect(at).toBeGreaterThanOrEqual(0); return [handle, entry.pairs.slice(at + 1)];
        }));
      };
      const sourceStyles = descriptors(await fs.readFile(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url), 'utf8')), nativeStyles = descriptors(metadata.dxf);
      expect(sourceStyles.size).toBe(24); expect(nativeStyles.size).toBe(24);
      for (const [handle, wanted] of sourceStyles) {
        const actual = nativeStyles.get(handle)!; expect(actual).toBeDefined();
        expect(wanted.filter(([code]) => code === 177).map(([, value]) => Number(value))).toEqual([3]);
        expect(actual.filter(([code]) => code === 177).map(([, value]) => Number(value))).toEqual([2]);
        expect(() => verify(drawing(wanted), drawing(actual))).toThrow(/group177.*changed/);
        // Original native2 vs DXFOUT3 is not conversion evidence. Only make
        // lighting coherent for this authored known-color comparison target.
        const coherent = actual.map((pair): Pair => pair[0] === 177 ? [177, 3] : pair);
        expect(() => verify(drawing(wanted), drawing(coherent))).not.toThrow();
        const altered = coherent.map((pair): Pair => [...pair]), at = altered.findIndex(([code]) => code === 420);
        expect(at).toBeGreaterThanOrEqual(0); altered[at]![1] = String(BigInt(String(altered[at]![1]).trim()) - 1n);
        expect(() => verify(drawing(wanted), drawing(altered))).toThrow(/group420.*changed/);
      }
      expect(await fs.readFile(copy)).toEqual(bytes); expect(await fs.readFile(url)).toEqual(bytes);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
