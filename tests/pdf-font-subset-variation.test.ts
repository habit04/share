import { describe, expect, it } from 'vitest';
import { fontTable, nativeFontFixture } from './helpers/native-font-fixture';
import { embeddableFontProgram, subsetGlyfProgram } from '../src/io/pdf-font-subset';

/** Repack authored tables; these fixtures test the subsetter, not font admission. */
function withTables(source: Buffer, extra: ReadonlyMap<string, Buffer>): Buffer {
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const record = 12 + i * 16, start = source.readUInt32BE(record + 8), length = source.readUInt32BE(record + 12);
    tables.set(source.toString('ascii', record, record + 4), Buffer.from(source.subarray(start, start + length)));
  }
  for (const [tag, bytes] of extra) tables.set(tag, bytes);
  tables.get('head')!.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer): number => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      let word = 0;
      for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  const result = Buffer.alloc(12 + tables.size * 16 + [...tables.values()].reduce((size, bytes) => size + Math.ceil(bytes.length / 4) * 4, 0));
  result.writeUInt32BE(0x00010000, 0); result.writeUInt16BE(tables.size, 4);
  const selector = Math.floor(Math.log2(tables.size)), searchRange = 2 ** selector * 16;
  result.writeUInt16BE(searchRange, 6); result.writeUInt16BE(selector, 8); result.writeUInt16BE(tables.size * 16 - searchRange, 10);
  let start = 12 + tables.size * 16;
  [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).forEach(([tag, bytes], index) => {
    const record = 12 + index * 16;
    result.write(tag, record, 'ascii'); result.writeUInt32BE(checksum(bytes), record + 4);
    result.writeUInt32BE(start, record + 8); result.writeUInt32BE(bytes.length, record + 12);
    bytes.copy(result, start); start += Math.ceil(bytes.length / 4) * 4;
  });
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, fontTable(result, 'head').offset + 8);
  return result;
}

/** Correct 20-byte gvar header, with a nonzero point delta on unused glyph 4. */
function glyphVariations(): Buffer {
  const glyphCount = 5, dataOffset = 20 + (glyphCount + 1) * 2;
  const tuple = Buffer.alloc(20);
  tuple.writeUInt16BE(1, 0); // one tuple, no shared point-number array
  tuple.writeUInt16BE(10, 2); // serialized data follows the embedded peak tuple
  tuple.writeUInt16BE(10, 4); tuple.writeUInt16BE(0x8000, 6);
  tuple.writeInt16BE(0x4000, 8); // embedded peak wght = +1, normalized
  // Four outline and four phantom points: eight byte x deltas and eight zero y deltas.
  tuple[10] = 7; tuple[11] = 1; tuple[19] = 0x87;
  const result = Buffer.alloc(dataOffset + tuple.length);
  result.writeUInt16BE(1, 0); result.writeUInt16BE(1, 4); // version 1.0, one axis
  result.writeUInt32BE(dataOffset, 8); result.writeUInt16BE(glyphCount, 12);
  result.writeUInt32BE(dataOffset, 16);
  result.writeUInt16BE(tuple.length / 2, 20 + glyphCount * 2);
  tuple.copy(result, dataOffset);
  return result;
}

describe('variation tables at the glyf subsetting boundary', () => {
  it.each(['fvar', 'gvar', 'avar', 'cvar', 'HVAR', 'VVAR', 'MVAR'])('preserves the exact source object when %s is present', (tag) => {
    const source = withTables(nativeFontFixture(), new Map([[tag, Buffer.alloc(4)]]));
    const before = Buffer.from(source);
    expect(embeddableFontProgram(source, new Set([0, 2]))).toBe(source);
    expect(() => subsetGlyfProgram(source, new Set([0, 2]))).toThrow(/variation|variable/i);
    expect(source).toEqual(before);
  });

  it('keeps unused outlines that still have gvar point deltas', () => {
    const gvar = glyphVariations(), source = withTables(nativeFontFixture(), new Map([['gvar', gvar]]));
    const glyphLength = (program: Buffer, glyph: number) => {
      const loca = fontTable(program, 'loca').offset;
      return program.readUInt32BE(loca + (glyph + 1) * 4) - program.readUInt32BE(loca + glyph * 4);
    };
    expect(glyphLength(source, 4)).toBe(34);
    expect(gvar.readUInt16BE(4)).toBe(1);
    expect(gvar.readUInt16BE(12)).toBe(5);
    expect(gvar.readUInt32BE(16)).toBe(32);
    expect(gvar[43]).toBe(1); // nonzero delta for an actual outline point
    const out = embeddableFontProgram(source, new Set([0, 2]));
    expect(glyphLength(Buffer.from(out), 4)).toBe(34);
    expect(out).toBe(source);
  });
});
