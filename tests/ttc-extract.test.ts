import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fontCollection, fontCollectionV2, fontTable, nativeFontFixture } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

const require = createRequire(import.meta.url);
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(input: Uint8Array, faceIndex?: number, options?: { maxFaces?: number; maxTables?: number; maxOutputBytes?: number }): Buffer;
};
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): unknown };

const faceA = Buffer.from(pdfFontFixture({ family: 'Arial' }).bytes);
const faceB = Buffer.from(pdfFontFixture({ family: 'Times New Roman', bold: true }).bytes);

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let i = 0; i < 4; i++) word = (word * 256 + (bytes[offset + i] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}
function tablesOf(font: Buffer, base = 0): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < font.readUInt16BE(base + 4); i++) {
    const at = base + 12 + i * 16, start = font.readUInt32BE(at + 8);
    tables.set(font.toString('ascii', at, at + 4), Buffer.from(font.subarray(start, start + font.readUInt32BE(at + 12))));
  }
  return tables;
}
function directoryTags(font: Buffer): string[] {
  return Array.from({ length: font.readUInt16BE(4) }, (_, i) => font.toString('ascii', 12 + i * 16, 12 + i * 16 + 4));
}
/** A valid standalone program whose tables, checksums and metrics match the source face. */
function expectStandalone(output: Buffer, face: Buffer): void {
  const source = tablesOf(face), extracted = tablesOf(output);
  expect(output.readUInt32BE(0)).toBe(0x00010000);
  expect([...extracted.keys()].sort()).toEqual([...source.keys()].sort());
  for (const [tag, bytes] of source) {
    // head carries a layout-specific checkSumAdjustment; every other byte must match.
    if (tag !== 'head') { expect(extracted.get(tag), tag).toEqual(bytes); continue; }
    const mine = Buffer.from(extracted.get(tag)!), theirs = Buffer.from(bytes);
    mine.writeUInt32BE(0, 8); theirs.writeUInt32BE(0, 8);
    expect(mine, tag).toEqual(theirs);
  }
  expect(directoryTags(output)).toEqual([...directoryTags(output)].sort());
  const count = output.readUInt16BE(4), selector = Math.floor(Math.log2(count));
  expect(output.readUInt16BE(6)).toBe(2 ** selector * 16);
  expect(output.readUInt16BE(8)).toBe(selector);
  expect(output.readUInt16BE(10)).toBe(count * 16 - 2 ** selector * 16);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = output.toString('ascii', at, at + 4), table = fontTable(output, tag), bytes = Buffer.from(output.subarray(table.offset, table.offset + table.length));
    if (tag === 'head') bytes.writeUInt32BE(0, 8);
    expect(output.readUInt32BE(at + 4), tag).toBe(checksum(bytes));
  }
  expect(checksum(output)).toBe(0xb1b0afba);
  expect(parseFontMetrics(output)).toEqual(parseFontMetrics(face));
}

/** TTC whose listed tags are stored once and referenced by every face directory. */
function sharedCollection(faces: Buffer[], shareTags: readonly string[]): Buffer {
  const parsed = faces.map((face) => tablesOf(face)), headerLength = 12 + faces.length * 4;
  let position = headerLength;
  const shared = new Map<string, { offset: number; length: number }>();
  for (const tag of shareTags) {
    const bytes = parsed[0]!.get(tag)!;
    shared.set(tag, { offset: position, length: bytes.length }); position += Math.ceil(bytes.length / 4) * 4;
  }
  const layouts = parsed.map((tables) => {
    const faceAt = position; position += 12 + tables.size * 16;
    const records = new Map<string, { offset: number; length: number }>();
    for (const [tag, bytes] of tables) {
      if (shared.has(tag)) records.set(tag, shared.get(tag)!);
      else { records.set(tag, { offset: position, length: bytes.length }); position += Math.ceil(bytes.length / 4) * 4; }
    }
    return { faceAt, records };
  });
  const data = Buffer.alloc(position);
  data.write('ttcf', 0, 'ascii'); data.writeUInt32BE(0x00010000, 4); data.writeUInt32BE(faces.length, 8);
  parsed.forEach((tables, faceIndex) => {
    const { faceAt, records } = layouts[faceIndex]!;
    data.writeUInt32BE(faceAt, 12 + faceIndex * 4);
    data.writeUInt32BE(0x00010000, faceAt); data.writeUInt16BE(tables.size, faceAt + 4);
    const selector = Math.floor(Math.log2(tables.size));
    data.writeUInt16BE(2 ** selector * 16, faceAt + 6); data.writeUInt16BE(selector, faceAt + 8); data.writeUInt16BE(tables.size * 16 - 2 ** selector * 16, faceAt + 10);
    [...tables].forEach(([tag, bytes], i) => {
      const at = faceAt + 12 + i * 16, record = records.get(tag)!;
      data.write(tag, at, 'ascii'); data.writeUInt32BE(record.offset, at + 8); data.writeUInt32BE(record.length, at + 12);
      bytes.copy(data, record.offset);
    });
  });
  return data;
}

describe('TTC face extraction', () => {
  it('extracts each face of a v1 collection as an equivalent standalone program', () => {
    const ttc = fontCollection(faceA, faceB), before = Buffer.from(ttc);
    const zero = extractTtcFace(ttc, 0), one = extractTtcFace(ttc, 1);
    expectStandalone(zero, faceA); expectStandalone(one, faceB);
    expect(zero).not.toEqual(one);
    expect(ttc).toEqual(before); // the input is never mutated
    expect(extractTtcFace(ttc, 0)).toEqual(zero); // deterministic output
    expect(zero).not.toEqual(ttc);
  });
  it('extracts face 0 of a v2 collection', () => {
    expectStandalone(extractTtcFace(fontCollectionV2(faceA, faceB), 0), faceA);
  });
  it('keeps the TrueType flavor of the source face', () => {
    const ttc = fontCollection(faceA); ttc.write('true', ttc.readUInt32BE(12), 'ascii');
    expect(extractTtcFace(ttc, 0).readUInt32BE(0)).toBe(0x74727565);
  });
  it('resolves tables shared between faces into each standalone program', () => {
    const ttc = sharedCollection([faceA, faceB], ['glyf', 'loca', 'hmtx']);
    expect(fontTable(ttc, 'glyf', 0).offset).toBe(fontTable(ttc, 'glyf', 1).offset);
    expect(ttc.length).toBeLessThan(fontCollection(faceA, faceB).length);
    const zero = extractTtcFace(ttc, 0), one = extractTtcFace(ttc, 1);
    expectStandalone(zero, faceA); expectStandalone(one, faceB);
    expect(tablesOf(zero).get('glyf')).toEqual(tablesOf(one).get('glyf'));
    expect(tablesOf(zero).get('name')).not.toEqual(tablesOf(one).get('name'));
  });
  it('recomputes directory checksums instead of trusting the collection records', () => {
    const ttc = fontCollection(faceA), glyf = fontTable(ttc, 'glyf', 0);
    ttc[glyf.offset + 2] = (ttc[glyf.offset + 2]! + 1) % 256; // source checksum is now stale
    const output = extractTtcFace(ttc, 0), placed = fontTable(output, 'glyf');
    expect(output.readUInt32BE(placed.record + 4)).toBe(checksum(Buffer.from(output.subarray(placed.offset, placed.offset + placed.length))));
    expect(checksum(output)).toBe(0xb1b0afba);
  });
  it('preserves OS/2 embedding permission bits verbatim', () => {
    const restricted = Buffer.from(pdfFontFixture({ fsType: 2 }).bytes);
    const output = extractTtcFace(fontCollection(restricted), 0);
    expect(tablesOf(output).get('OS/2')).toEqual(tablesOf(restricted).get('OS/2'));
    expect(tablesOf(output).get('OS/2')!.readUInt16BE(8)).toBe(2);
  });
});

describe('TTC extraction bounds and malformed input', () => {
  const ttc = () => fontCollection(faceA, faceB);
  it('rejects non-collection input', () => {
    expect(() => extractTtcFace(faceA, 0)).toThrow('not a TrueType collection');
    expect(() => extractTtcFace(Buffer.alloc(0), 0)).toThrow(/truncated/);
  });
  it('rejects an unsupported collection version', () => {
    const bad = ttc(); bad.writeUInt32BE(0x00030000, 4);
    expect(() => extractTtcFace(bad, 0)).toThrow('unsupported TrueType collection version');
  });
  it.each([[0], [65]])('rejects face count %i', (count) => {
    const bad = ttc(); bad.writeUInt32BE(count, 8);
    expect(() => extractTtcFace(bad, 0)).toThrow('face count');
  });
  it('rejects an out-of-range face index', () => {
    expect(() => extractTtcFace(ttc(), 2)).toThrow('out of range');
  });
  it.each([
    ['inside the header', 8], ['unaligned', 14], ['beyond the file', 0x7ffffff0],
  ])('rejects a face offset %s', (_name, offset) => {
    const bad = ttc(); bad.writeUInt32BE(offset, 16);
    expect(() => extractTtcFace(bad, 0)).toThrow(/face offset|truncated/);
  });
  it('rejects duplicate face offsets', () => {
    const bad = ttc(); bad.writeUInt32BE(bad.readUInt32BE(12), 16);
    expect(() => extractTtcFace(bad, 0)).toThrow('duplicate TrueType collection face offset');
  });
  it('rejects a CFF face', () => {
    const bad = ttc(); bad.write('OTTO', bad.readUInt32BE(12), 'ascii');
    expect(() => extractTtcFace(bad, 0)).toThrow('CFF');
  });
  it.each([[0], [200]])('rejects SFNT table count %i', (count) => {
    const bad = ttc(); bad.writeUInt16BE(count, bad.readUInt32BE(12) + 4);
    expect(() => extractTtcFace(bad, 0)).toThrow('table count');
  });
  it('rejects duplicate table tags within a face', () => {
    const bad = ttc(), base = bad.readUInt32BE(12);
    bad.write(bad.toString('ascii', base + 12, base + 16), base + 28, 'ascii');
    expect(() => extractTtcFace(bad, 0)).toThrow('duplicate SFNT table tag');
  });
  it.each([
    ['offset beyond the file', (bad: Buffer) => bad.writeUInt32BE(bad.length + 4096, fontTable(bad, 'glyf', 0).record + 8)],
    ['length beyond the file', (bad: Buffer) => bad.writeUInt32BE(0x7fffffff, fontTable(bad, 'glyf', 0).record + 12)],
    ['unaligned start', (bad: Buffer) => { const record = fontTable(bad, 'glyf', 0); bad.writeUInt32BE(record.offset + 1, record.record + 8); }],
    ['overlapping another table', (bad: Buffer) => { const glyf = fontTable(bad, 'glyf', 0); bad.writeUInt32BE(glyf.offset, fontTable(bad, 'hmtx', 0).record + 8); }],
    ['overlapping the face directory', (bad: Buffer) => bad.writeUInt32BE(bad.readUInt32BE(12) + 4, fontTable(bad, 'glyf', 0).record + 8)],
  ])('rejects a table with %s', (_name, mutate) => {
    const bad = ttc(); mutate(bad);
    expect(() => extractTtcFace(bad, 0)).toThrow(/truncated|table offset|overlapping/);
  });
  it('rejects a truncated collection', () => {
    const bad = ttc();
    expect(() => extractTtcFace(bad.subarray(0, Math.floor(bad.length / 2)), 0)).toThrow(/truncated/);
  });
  it('rejects malformed v2 signature fields', () => {
    const badTag = fontCollectionV2(faceA); badTag.write('XXXX', 12 + 4, 'ascii');
    expect(() => extractTtcFace(badTag, 0)).toThrow('signature fields');
    const badOffset = fontCollectionV2(faceA);
    badOffset.write('DSIG', 12 + 4, 'ascii'); badOffset.writeUInt32BE(8, 12 + 8); badOffset.writeUInt32BE(4, 12 + 12);
    expect(() => extractTtcFace(badOffset, 0)).toThrow('signature fields');
  });
  it.each([
    ['face limit', { maxFaces: 1 }, 'face count'],
    ['table limit', { maxTables: 5 }, 'table count'],
    ['output size limit', { maxOutputBytes: 128 }, 'output size limit'],
    ['invalid limits', { maxFaces: 0 }, 'invalid extraction limits'],
  ])('enforces the %s', (_name, options, problem) => {
    expect(() => extractTtcFace(ttc(), 0, options)).toThrow(problem);
  });
  it('extracts from the authored native fixture as well as PDF faces', () => {
    const ttc = fontCollection(nativeFontFixture({ family: 'JCad Fixture' }));
    const output = extractTtcFace(ttc, 0);
    expect(parseFontMetrics(output)).toEqual(parseFontMetrics(nativeFontFixture({ family: 'JCad Fixture' })));
  });
});
