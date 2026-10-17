import { describe, expect, it } from 'vitest';
import { fontTable, nativeFontFixture } from './helpers/native-font-fixture';
import { embeddableFontProgram, subsetGlyfProgram } from '../src/io/pdf-font-subset';

function glyphBytes(program: Buffer, glyph: number): Buffer {
  const glyf = fontTable(program, 'glyf').offset, loca = fontTable(program, 'loca').offset;
  const short = program.readInt16BE(fontTable(program, 'head').offset + 50) === 0;
  const start = short ? program.readUInt16BE(loca + glyph * 2) * 2 : program.readUInt32BE(loca + glyph * 4);
  const end = short ? program.readUInt16BE(loca + (glyph + 1) * 2) * 2 : program.readUInt32BE(loca + (glyph + 1) * 4);
  return program.subarray(glyf + start, glyf + end);
}

/** Both component records reference the same child, with explicit zero XY offsets. */
function doubledComposite(child: number): Buffer {
  const glyph = Buffer.alloc(22);
  glyph.writeInt16BE(-1, 0);
  glyph.writeInt16BE(620, 6); glyph.writeInt16BE(730, 8);
  glyph.writeUInt16BE(0x0022, 10); glyph.writeUInt16BE(child, 12);
  glyph.writeUInt16BE(0x0002, 16); glyph.writeUInt16BE(child, 18);
  return glyph;
}

function repeatedComposite(levels: number): { source: Buffer; root: number } {
  const extraGlyphs: Buffer[] = [];
  let child = 2; // The authored capital-A glyph has four points and one contour.
  for (let level = 0; level < levels; level++) {
    extraGlyphs.push(doubledComposite(child));
    child = 5 + level;
  }
  return { source: nativeFontFixture({ extraGlyphs }), root: child };
}

describe('subset glyph compatibility and representable maxp limits', () => {
  it('subsets a valid ten-byte zero-contour glyph without requiring an instruction field', () => {
    const empty = Buffer.alloc(10), source = nativeFontFixture({ extraGlyphs: [empty] });
    const result = Buffer.from(subsetGlyfProgram(source, new Set([5])));
    expect(result.byteLength).toBeLessThan(source.byteLength);
    expect(glyphBytes(result, 5).subarray(0, empty.length)).toEqual(empty);
    expect(glyphBytes(result, 2)).toHaveLength(0);
    const maxp = fontTable(result, 'maxp').offset;
    expect(result.readUInt16BE(maxp + 26)).toBe(0);
  });

  it('preserves optional zero-contour instructions that operate on phantom points', () => {
    const empty = Buffer.alloc(14);
    empty.writeUInt16BE(2, 10); empty[12] = 0xb0; empty[13] = 0;
    const source = nativeFontFixture({ extraGlyphs: [empty] });
    const result = Buffer.from(subsetGlyfProgram(source, new Set([5])));
    expect(glyphBytes(result, 5).subarray(0, empty.length)).toEqual(empty);
    expect(result.readUInt16BE(fontTable(result, 'maxp').offset + 26)).toBe(2);
  });

  it('falls back whole when a zero-contour glyph declares instructions outside its span', () => {
    const empty = Buffer.alloc(12);
    empty.writeUInt16BE(2, 10);
    const source = nativeFontFixture({ extraGlyphs: [empty] });
    expect(() => subsetGlyfProgram(source, new Set([5]))).toThrow(/truncated.*instructions/);
    expect(embeddableFontProgram(source, new Set([5]))).toBe(source);
  });

  it('rejects composite point totals of 65536 instead of wrapping maxp to zero', () => {
    const { source, root } = repeatedComposite(14);
    // Only 14 small composites are stored; their expanded point count is 4 * 2^14.
    const original = Buffer.from(source);
    expect(() => subsetGlyfProgram(source, new Set([root]))).toThrow(/maxp.*range|representable/);
    expect(embeddableFontProgram(source, new Set([root]))).toBe(source);
    expect(source).toEqual(original);
  });

  it('keeps representable repeated-component totals exact, including nested depth', () => {
    const { source, root } = repeatedComposite(13);
    const result = Buffer.from(subsetGlyfProgram(source, new Set([root])));
    const maxp = fontTable(result, 'maxp').offset;
    expect(result.readUInt16BE(maxp + 10)).toBe(32768);
    expect(result.readUInt16BE(maxp + 12)).toBe(8192);
    expect(result.readUInt16BE(maxp + 28)).toBe(2);
    expect(result.readUInt16BE(maxp + 30)).toBe(13);
    expect(glyphBytes(result, root).subarray(0, glyphBytes(source, root).length)).toEqual(glyphBytes(source, root));
  });
});
