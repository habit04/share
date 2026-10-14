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
const record = (type: string, handle: string, body: Pair[]): Pair[] => [[0, type], [5, handle], ...body];
const view = (color: string | number, extra: Pair[] = [], handle = '107'): Pair[] => record('VPORT', handle, [
  [330, '8'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewportTableRecord'], [2, '*Active'],
  [70, 0], [63, 250], [421, color], [431, 'Book Δ'], [441, 33554432], [150, 'opaque first'], [151, 'opaque second'], ...extra,
]);
const drawing = (records: Pair[]): string => text([[0, 'SECTION'], [2, 'TABLES'],
  ...record('TABLE', '8', [[2, 'VPORT'], [330, '0']]), ...records, [0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'EOF']]);
const source = (color: string | number = 3355443, extra: Pair[] = []): string => drawing(view(color, extra));
const mutation = (body: Pair[], code: number, value: string | number) => body.map((pair): Pair => pair[0] === code ? [code, value] : pair);
const raw = 3355443, signed = -1036831949, unsigned = 3258135347;

describe('known VPORT TABLES ambient421 native color semantics', () => {
  it.each([[raw, signed], [raw, unsigned], [signed, raw], [unsigned, raw], [signed, unsigned], [raw, '+0003355443']])(
    'compares exact RGB across checked canonical/native storage %s -> %s', (a, b) => {
      expect(() => verify(source(a), source(b))).not.toThrow();
    });
  it.each([0, 1, 0xff, 0x100, 0x10000, 0xabcdef, 0xffffff])('preserves all24 RGB bits for %s', value => {
    const packed = BigInt(value) | 0xc2000000n;
    expect(() => verify(source(value), source(packed.toString()))).not.toThrow();
    expect(() => verify(source(value), source((packed - 0x100000000n).toString()))).not.toThrow();
  });
  it.each([0x333332, 0x333233, 0x323333])('refuses native RGB channel change %s', value => {
    expect(() => verify(source(), source((BigInt(value) | 0xc2000000n).toString()))).toThrow(/ambient RGB changed/);
  });
  it.each([1, 0xc0, 0xc1, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xff])('refuses unsupported method%s even when both sides match', method => {
    const packed = ((BigInt(method) << 24n) | BigInt(raw)).toString();
    expect(() => verify(source(packed), source(packed))).toThrow(/unsupported ambient-color method/);
    expect(() => verify(source(), source(packed))).toThrow(/unsupported ambient-color method/);
    expect(() => verify(source(packed), source())).toThrow(/unsupported ambient-color method/);
  });
  it.each(['-2147483649', '4294967296', '99999999999999999999', '1.5', '3.355443e6', '0x333333', 'NaN', '', '123456789012345678901'])('refuses malformed/out-of-range storage %s even if identical', value => {
    expect(() => verify(source(value), source(value))).toThrow(/ambient-color.*storage/);
  });
  it('requires exact retained field counts and rejects identical ambiguous duplicates', () => {
    const native = view(signed);
    expect(() => verify(source(), drawing(native.filter(([code]) => code !== 421)))).toThrow(/group421 count changed/);
    expect(() => verify(source(), source(signed, [[421, signed]]))).toThrow(/group421 count changed/);
    expect(() => verify(source(raw, [[421, raw]]), source(signed, [[421, signed]]))).toThrow(/ambiguous ambient-color/);
    expect(() => verify(source(raw, [[421, raw]]), source(raw, [[421, raw]]))).toThrow(/ambiguous ambient-color/);
  });
  it.each([[63, 249], [431, 'changed book'], [441, 33554433], [150, 'changed opaque']] as Pair[])(
    'keeps group%s exact beside equivalent native RGB', (code, value) => {
      expect(() => verify(source(), drawing(mutation(view(signed), code, value)))).toThrow(/changed/);
    });
  it('keeps unknown framing and every tiled VPORT distinct while known scalars can move', () => {
    const first = view(raw), second = view(0x123456, [], '108');
    const nativeFirst = view(signed).filter(([code]) => code !== 421);
    nativeFirst.push([421, unsigned]);
    const wanted = drawing([...first, ...second]);
    const native = drawing([...nativeFirst, ...view(0xc2123456, [], '108')]);
    expect(() => verify(wanted, native)).not.toThrow();
    expect(() => verify(wanted, drawing([...nativeFirst, ...view(0xc2123457, [], '108')]))).toThrow(/ambient RGB changed/);
    const reordered = view(signed).map((pair): Pair => pair[0] === 150 ? [151, 'opaque second'] : pair[0] === 151 ? [150, 'opaque first'] : pair);
    expect(() => verify(source(), drawing(reordered))).toThrow(/unmodeled.*framing\/order/);
  });
  it.each(['XRECORD', 'VPORT', 'CUSTOM_OBJECT'])('does not reinterpret opaque OBJECTS %s group421', type => {
    const objects = (value: number) => text([[0, 'SECTION'], [2, 'OBJECTS'],
      ...record('DICTIONARY', '1', [[330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'OpaquePayload'], [350, '2']]),
      ...record(type, '2', [[330, '1'], [100, 'OpaqueClass'], [421, value]]), [0, 'ENDSEC'], [0, 'EOF']]);
    expect(() => verify(objects(raw), objects(signed))).toThrow(/group421.*changed/);
    expect(() => verify(objects(-1020054733), objects(-1020054733))).not.toThrow();
  });
  it('does not reinterpret VIEW or VPORT XDATA integer421', () => {
    const named = (value: number) => text([[0, 'SECTION'], [2, 'TABLES'], ...record('TABLE', '8', [[2, 'VIEW'], [330, '0']]),
      ...record('VIEW', '107', [[330, '8'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewTableRecord'], [2, 'Camera'], [421, value]]), [0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'EOF']]);
    expect(() => verify(named(raw), named(signed))).toThrow(/group421.*changed/);
    expect(() => verify(source(raw, [[1001, 'APP'], [421, raw]]), source(signed, [[1001, 'APP'], [421, signed]]))).toThrow(/group421.*changed/);
    const opaque = source(raw, [[1001, 'APP'], [421, -1020054733]]);
    expect(() => verify(opaque, opaque)).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('checks actual AutoCAD VPORT107 through the independent C projection without rewriting the original', async () => {
    const original = new URL('./fixtures/interchange/r2018-minsert.dwg', import.meta.url);
    const bytes = await fs.readFile(original), digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(bytes)).toBe('74cafbe617e7a885d622a8a0270b60f64cc285801be42ea8829cc9e9472616d5');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'jcad-vport-color-')), copy = path.join(dir, 'private-source.dwg');
    try {
      await fs.writeFile(copy, bytes, { flag: 'wx' });
      const decoded = await readDwgPayload(await fs.readFile(copy));
      const metadata = decoded.payload.nativeMetadata as { complete: boolean; readError: number; writeError: number; dxf: string; objects: unknown[] };
      expect(metadata).toMatchObject({ complete: true, readError: 0, writeError: 0 });
      expect(metadata.objects).toHaveLength(139);
      const descriptor = (dxf: string): Pair[] => {
        const lines = dxf.trimEnd().split(/\r\n|\n|\r/), records: Array<{ type: string; pairs: Pair[] }> = [];
        expect(lines.length % 2).toBe(0);
        for (let index = 0; index < lines.length; index += 2) {
          const code = Number(lines[index]!.trim()), value = lines[index + 1]!;
          if (code === 0) records.push({ type: value.trim(), pairs: [] });
          else if (records.length) records.at(-1)!.pairs.push([code, value]);
          else expect(code).toBe(999); // Native projection's leading diagnostic comment.
        }
        const vport = records.find(entry => entry.type === 'VPORT' && entry.pairs.some(([code, value]) => code === 5 && String(value).trim() === '107'))!;
        expect(vport).toBeDefined();
        return vport.pairs.filter(([code]) => [63, 421, 431].includes(code));
      };
      const originalDxf = await fs.readFile(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url), 'utf8');
      const sourceFields = descriptor(originalDxf), nativeFields = descriptor(metadata.dxf);
      expect(sourceFields.filter(([code]) => code === 421).map(([, value]) => Number(value))).toEqual([raw]);
      expect(nativeFields.filter(([code]) => code === 421).map(([, value]) => Number(value))).toEqual([signed]);
      const isolate = (fields: Pair[]) => drawing(record('VPORT', '107', [[330, '8'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbViewportTableRecord'], [2, '*Active'], [70, 0], ...fields]));
      expect(() => verify(isolate(sourceFields), isolate(nativeFields))).not.toThrow();
      expect(() => verify(isolate(sourceFields), isolate(mutation(nativeFields, 421, -1036831950)))).toThrow(/ambient RGB changed/);
      expect(await fs.readFile(copy)).toEqual(bytes);
      expect(await fs.readFile(original)).toEqual(bytes);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
