import { describe, expect, it } from 'vitest';
import { compositeGlyph, fontTable, nativeFontFixture, simpleGlyph } from './helpers/native-font-fixture';
import { embeddableFontProgram, programNoSubsetting, subsetGlyfProgram, FS_TYPE_NO_SUBSETTING } from '../src/io/pdf-font-subset';

function glyphData(program: Buffer, glyph: number, length: number): Buffer { return glyphBytes(program, glyph).subarray(0, length) as Buffer; }
function glyphBytes(program: Buffer, glyph: number): Buffer {
  const glyf = fontTable(program, 'glyf'), loca = fontTable(program, 'loca'), head = fontTable(program, 'head');
  const format = program.readInt16BE(head.offset + 50);
  const start = format === 0 ? program.readUInt16BE(loca.offset + glyph * 2) * 2 : program.readUInt32BE(loca.offset + glyph * 4);
  const end = format === 0 ? program.readUInt16BE(loca.offset + (glyph + 1) * 2) * 2 : program.readUInt32BE(loca.offset + (glyph + 1) * 4);
  return Buffer.from(program.subarray(glyf.offset + start, glyf.offset + end));
}

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

const box: readonly [number, number, number, number] = [0, 0, 500, 700];

describe('GID-preserving glyf subsetter', () => {
  it('retains used glyphs byte-identically and empties the rest without renumbering', () => {
    const source = nativeFontFixture({ extraGlyphs: [simpleGlyph(box), simpleGlyph(box), simpleGlyph(box)] });
    const glyphCount = source.readUInt16BE(fontTable(source, 'maxp').offset + 4);
    expect(glyphCount).toBe(8);
    const out = Buffer.from(subsetGlyfProgram(source, new Set([0, 2])));
    expect(out.readUInt16BE(fontTable(out, 'maxp').offset + 4)).toBe(8);
    expect(glyphData(out, 0, glyphBytes(source, 0).length)).toEqual(glyphBytes(source, 0));
    expect(glyphData(out, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2));
    for (const glyph of [1, 3, 4, 5, 6, 7]) expect(glyphBytes(out, glyph)).toHaveLength(0);
    expect(out.byteLength).toBeLessThan(source.byteLength);
    // Whole-font checksum must validate against the OpenType magic constant.
    expect(checksum(out)).toBe(0xb1b0afba);
    // Non-glyph tables ride verbatim (permissions and names must not change).
    for (const tag of ['OS/2', 'cmap', 'name', 'hmtx', 'hhea', 'post']) {
      const before = fontTable(source, tag), after = fontTable(out, tag);
      expect(out.subarray(after.offset, after.offset + after.length)).toEqual(source.subarray(before.offset, before.offset + before.length));
    }
  });

  it('keeps the source loca format (short) and still resolves retained glyphs', () => {
    const source = nativeFontFixture({ shortLoca: true });
    const out = Buffer.from(subsetGlyfProgram(source, new Set([0, 3])));
    expect(out.readInt16BE(fontTable(out, 'head').offset + 50)).toBe(0);
    expect(glyphData(out, 3, glyphBytes(source, 3).length)).toEqual(glyphBytes(source, 3));
    expect(glyphBytes(out, 2)).toHaveLength(0);
  });

  it('retains composite components and nested composites through the closure', () => {
    const source = nativeFontFixture({ extraGlyphs: [compositeGlyph(2, box), compositeGlyph(5, box)] });
    // Glyph 5 is a composite over glyph 2; glyph 6 is a composite over glyph 5.
    const out = Buffer.from(subsetGlyfProgram(source, new Set([0, 6])));
    expect(glyphData(out, 6, glyphBytes(source, 6).length)).toEqual(glyphBytes(source, 6));
    expect(glyphData(out, 5, glyphBytes(source, 5).length)).toEqual(glyphBytes(source, 5));
    expect(glyphData(out, 2, glyphBytes(source, 2).length)).toEqual(glyphBytes(source, 2));
    expect(glyphBytes(out, 3)).toHaveLength(0);
    expect(glyphBytes(out, 4)).toHaveLength(0);
  });

  it('recomputes maxp glyph maxima over retained glyphs only', () => {
    const plain = Buffer.from(subsetGlyfProgram(nativeFontFixture({}), new Set([0, 2])));
    const maxp = fontTable(plain, 'maxp').offset;
    expect(plain.readUInt16BE(maxp + 6)).toBe(4); // maxPoints
    expect(plain.readUInt16BE(maxp + 8)).toBe(1); // maxContours
    expect(plain.readUInt16BE(maxp + 10)).toBe(0); // maxCompositePoints
    expect(plain.readUInt16BE(maxp + 28)).toBe(0); // maxComponentElements
    expect(plain.readUInt16BE(maxp + 30)).toBe(0); // maxComponentDepth
    const withComposite = Buffer.from(subsetGlyfProgram(nativeFontFixture({ composite: true }), new Set([0, 4])));
    const cmaxp = fontTable(withComposite, 'maxp').offset;
    expect(withComposite.readUInt16BE(cmaxp + 10)).toBe(4); // composite over the 4-point glyph 2
    expect(withComposite.readUInt16BE(cmaxp + 12)).toBe(1); // maxCompositeContours
    expect(withComposite.readUInt16BE(cmaxp + 28)).toBe(1); // maxComponentElements
    expect(withComposite.readUInt16BE(cmaxp + 30)).toBe(1); // maxComponentDepth
  });

  it('rejects cyclic composites and falls back to the whole program', () => {
    const source = nativeFontFixture({ extraGlyphs: [compositeGlyph(5, box), compositeGlyph(5, box)] });
    // Glyph 5 references itself; glyph 6 references glyph 5.
    expect(() => subsetGlyfProgram(source, new Set([0, 6]))).toThrow(/cyclic|nesting/);
    expect(embeddableFontProgram(source, new Set([0, 6]))).toEqual(source);
  });

  it('falls back to the whole program for malformed input', () => {
    const source = nativeFontFixture({});
    const broken = Buffer.from(source);
    const loca = fontTable(broken, 'loca'), glyf = fontTable(broken, 'glyf');
    broken.writeUInt32BE(glyf.length + 100, loca.offset + 3 * 4);
    expect(() => subsetGlyfProgram(broken, new Set([0, 2]))).toThrow();
    expect(embeddableFontProgram(broken, new Set([0, 2]))).toEqual(broken);
    expect(embeddableFontProgram(new Uint8Array([1, 2, 3]), new Set([0]))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('honours the OS/2 no-subsetting bit from the program itself', () => {
    expect(FS_TYPE_NO_SUBSETTING).toBe(0x0100);
    const flagged = nativeFontFixture({ fsType: 8 | FS_TYPE_NO_SUBSETTING });
    const plain = nativeFontFixture({ fsType: 8 });
    expect(programNoSubsetting(flagged)).toBe(true);
    expect(programNoSubsetting(plain)).toBe(false);
    const out = embeddableFontProgram(flagged, new Set([0, 2]));
    expect(out).toEqual(flagged);
  });

  it('embeds whole when subsetting would not shrink the program', () => {
    const source = nativeFontFixture({});
    const all = new Set([0, 1, 2, 3, 4]);
    expect(embeddableFontProgram(source, all)).toEqual(source);
  });

  it('rejects out-of-range used glyph IDs instead of corrupting output', () => {
    const source = nativeFontFixture({});
    expect(() => subsetGlyfProgram(source, new Set([0, 99]))).toThrow(/glyph/);
    expect(embeddableFontProgram(source, new Set([0, 99]))).toEqual(source);
  });
});
