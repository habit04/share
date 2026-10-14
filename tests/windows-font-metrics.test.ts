import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compositeGlyph, fontCollection, fontCollectionV2, fontTable, nativeFontFixture } from './helpers/native-font-fixture';

interface Metrics {
  family: string;
  subfamily: string;
  unitsPerEm: number;
  capitalHeight: number;
  winDescent: number;
  fontBounds: number[];
  advances: number[];
  glyphBounds: number[][];
  glyphBoundsKnown: boolean[];
  cmap: number[];
  groups: number[][];
  fsType: number;
  bold: boolean;
  italic: boolean;
}
const require = createRequire(import.meta.url);
const { parseFontMetrics, readWindowsFontMetrics, MAX_FONT_BYTES } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Buffer | Uint8Array, options?: { faceIndex?: number }): Metrics;
  readWindowsFontMetrics(request: { font: string; family?: string; bold?: boolean; italic?: boolean }, options?: { fontsDirectory?: string }): Promise<Metrics & { resolvedFilename: string }>;
  MAX_FONT_BYTES: number;
};
const nativeFs = require('node:fs/promises') as typeof fs;
const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'jcad-font-metrics-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-font-metrics-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected font test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('bounded native TrueType metadata parser', () => {
  it('uses A yMax rather than declared cap height and expands repeated hmtx advances', () => {
    const bytes = nativeFontFixture({ declaredCapHeight: 999, fsType: 0x0104 });
    const before = Buffer.from(bytes), metrics = parseFontMetrics(bytes);
    expect(metrics).toMatchObject({ family: 'JCad Fixture', subfamily: 'Regular', unitsPerEm: 1000, capitalHeight: 730, winDescent: 240, fontBounds: [-50, -200, 900, 1000], fsType: 0x0104, bold: false, italic: false });
    expect(metrics.advances).toEqual([500, 300, 650, 650, 650]);
    expect(metrics.glyphBounds[2]).toEqual([-20, 0, 620, 730]);
    expect(metrics.glyphBounds[1]).toEqual([0, 0, 0, 0]);
    expect(metrics.glyphBoundsKnown).toEqual([true, true, true, true, true]);
    expect(metrics.cmap).toHaveLength(65536);
    expect(metrics.cmap[32]).toBe(1); expect(metrics.cmap[65]).toBe(2); expect(metrics.cmap[66]).toBe(3); expect(metrics.cmap[67]).toBe(0);
    expect(metrics.groups).toEqual([]);
    expect(bytes).toEqual(before);
  });

  it('resolves ordinary glyph phantom origins from explicit and trailing hmtx bearings', () => {
    const bytes = nativeFontFixture(), hmtx = fontTable(bytes, 'hmtx').offset;
    bytes.writeInt16BE(25, hmtx + 10);
    bytes.writeInt16BE(-10, hmtx + 12);
    const metrics = parseFontMetrics(bytes);
    expect(metrics.glyphBounds[2]).toEqual([25, 0, 665, 730]);
    expect(metrics.glyphBounds[3]).toEqual([-10, 0, 550, 700]);
    expect(metrics.fontBounds).toEqual([-50, -200, 900, 1000]);
  });

  it('keeps zero-contour phantom-only glyphs empty despite nonzero bearings', () => {
    const font = nativeFontFixture(), glyph = fontTable(font, 'glyf').offset, hmtx = fontTable(font, 'hmtx').offset;
    font.writeInt16BE(0, glyph); font.writeInt16BE(123, hmtx + 2);
    expect(parseFontMetrics(font).glyphBounds[0]).toEqual([0, 0, 0, 0]);
  });

  it('handles short loca offsets, composites and shipped Windows legacy no-payload flags', () => {
    const metrics = parseFontMetrics(nativeFontFixture({ shortLoca: true, composite: true, compositeFlags: 0x0212, bold: true, italic: true }));
    expect(metrics).toMatchObject({ capitalHeight: 730, bold: true, italic: true, subfamily: 'Bold Italic' });
    expect(metrics.glyphBounds[4]).toEqual([-20, 0, 620, 730]);
    // Layout APIs/native Chrome use hmtx advances even when an outline sets USE_MY_METRICS.
    expect(metrics.advances[4]).toBe(650);
  });

  it('resolves recursive metric-owning origins while preserving the parent layout advance', () => {
    const nested = compositeGlyph(4, [-30, 0, 650, 730], 0x0202);
    const metrics = parseFontMetrics(nativeFontFixture({ composite: true, compositeFlags: 0x0202, extraGlyphs: [nested] }));
    expect(metrics.glyphBounds[4]).toEqual([-20, 0, 620, 730]);
    expect(metrics.glyphBounds[5]).toEqual([-30, 0, 650, 730]);
    expect(metrics.glyphBoundsKnown).toEqual([true, true, true, true, true, true]);
    const font = nativeFontFixture({ composite: true, compositeFlags: 0x0202 }), glyph = fontTable(font, 'glyf').offset + font.readUInt32BE(fontTable(font, 'loca').offset + 16);
    font.writeUInt16BE(0, glyph + 12);
    [0, 0, 500, 700].forEach((value, index) => font.writeInt16BE(value, glyph + 2 + index * 2));
    const parentAdvance = parseFontMetrics(font);
    expect(parentAdvance.advances[4]).toBe(650);
    expect(parentAdvance.advances[0]).toBe(500);
  });

  it('marks unsupported component origins per glyph without disabling native ASCII/A metrics', () => {
    const offsetOwner = compositeGlyph(2, [-10, 0, 630, 730], 0x0202); offsetOwner.writeInt8(10, 14);
    const inheritedUnknown = compositeGlyph(5, [-10, 0, 630, 730], 0x0202);
    const transformed = Buffer.concat([compositeGlyph(2, [-10, 0, 310, 365], 0x020a), Buffer.from([0x20, 0])]);
    const multiple = Buffer.concat([compositeGlyph(2, [-20, 0, 620, 730], 0x0222), compositeGlyph(3, [-20, 0, 620, 730], 0x0202).subarray(10)]);
    const pointMatched = Buffer.concat([compositeGlyph(2, [-20, 0, 620, 730], 0x0022), compositeGlyph(3, [-20, 0, 620, 730], 0).subarray(10)]);
    const metrics = parseFontMetrics(nativeFontFixture({ extraGlyphs: [offsetOwner, inheritedUnknown, transformed, multiple, pointMatched] }));
    expect(metrics.capitalHeight).toBe(730);
    expect(metrics.glyphBoundsKnown.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(metrics.glyphBoundsKnown.slice(5)).toEqual([false, false, false, false, false]);
    expect(metrics.glyphBounds[5]).toEqual([-10, 0, 630, 730]);
    expect(metrics.advances[5]).toBe(650);
    // An explicit identity transform still has an exactly resolvable phantom origin.
    const identity = Buffer.concat([compositeGlyph(2, [-20, 0, 620, 730], 0x020a), Buffer.from([0x40, 0])]);
    expect(parseFontMetrics(nativeFontFixture({ extraGlyphs: [identity] })).glyphBoundsKnown[5]).toBe(true);
  });

  it('refuses a face whose capital A uses an unresolved component origin', () => {
    const offsetOwner = compositeGlyph(2, [-10, 0, 630, 730], 0x0202); offsetOwner.writeInt8(10, 14);
    const font = nativeFontFixture({ extraGlyphs: [offsetOwner] }), cmap4 = fontTable(font, 'cmap').offset + 12;
    font.writeUInt16BE(65, cmap4 + 16); font.writeInt16BE(5 - 65, cmap4 + 30);
    expect(() => parseFontMetrics(font)).toThrow('capital A glyph must have a known origin');
  });

  it('handles format4 idRangeOffset and applies idDelta only to nonzero glyph entries', () => {
    expect(parseFontMetrics(nativeFontFixture({ rangeOffset: true })).cmap.slice(65, 67)).toEqual([2, 3]);
    expect(parseFontMetrics(nativeFontFixture({ rangeOffset: true, missingB: true })).cmap.slice(65, 67)).toEqual([2, 0]);
  });

  it.each([{ format12: true }, { onlyFormat12: true }])('handles full Unicode format12 with BMP and supplementary mapping: %j', (options) => {
    const metrics = parseFontMetrics(nativeFontFixture(options));
    expect(metrics.cmap.slice(65, 67)).toEqual([2, 3]);
    expect(metrics.groups).toEqual([[32, 32, 1], [65, 66, 2], [0x1f600, 0x1f600, 4]]);
  });

  it('selects a bounded TTC face and rejects invalid face indices and duplicate collection offsets', () => {
    const collection = fontCollection(nativeFontFixture(), nativeFontFixture({ family: 'Second Fixture', capitalHeight: 820 }));
    expect(parseFontMetrics(collection).family).toBe('JCad Fixture');
    expect(parseFontMetrics(collection, { faceIndex: 1 })).toMatchObject({ family: 'Second Fixture', capitalHeight: 820 });
    for (const faceIndex of [-1, 1.2, 2, 64, Infinity]) expect(() => parseFontMetrics(collection, { faceIndex })).toThrow();
    expect(() => parseFontMetrics(nativeFontFixture(), { faceIndex: 1 })).toThrow('standalone');
    collection.writeUInt32BE(collection.readUInt32BE(12), 16);
    expect(() => parseFontMetrics(collection)).toThrow('duplicate');
  });

  it('includes TTCv2 signature fields in the protected header and validates their ranges', () => {
    expect(parseFontMetrics(fontCollectionV2(nativeFontFixture()))).toMatchObject({ family: 'JCad Fixture', capitalHeight: 730 });
    const overlapped = fontCollection(nativeFontFixture());
    overlapped.writeUInt32BE(0x00020000, 4);
    expect(() => parseFontMetrics(overlapped)).toThrow();
    const badSignature = fontCollectionV2(nativeFontFixture());
    badSignature.writeUInt32BE(0x44534947, 16); badSignature.writeUInt32BE(10, 20); badSignature.writeUInt32BE(0xffffff00, 24);
    expect(() => parseFontMetrics(badSignature)).toThrow('collection signature');
  });

  it('uses OS/2 Windows style flags and preserves embedding rights without guessing permission', () => {
    const bytes = nativeFontFixture({ fsType: 2 }), os2 = fontTable(bytes, 'OS/2').offset;
    bytes.writeUInt16BE(32 | 1, os2 + 62);
    expect(parseFontMetrics(bytes)).toMatchObject({ bold: true, italic: true, fsType: 2 });
  });

  it('returns the native Windows descent independently of individual glyph/font bounds', () => {
    const metrics = parseFontMetrics(nativeFontFixture({ winDescent: 456 }));
    expect(metrics.winDescent).toBe(456);
    expect(metrics.fontBounds[1]).toBe(-200);
    expect(metrics.glyphBounds[metrics.cmap[65]!]![1]).toBe(0);
  });

  it.each<[string, (font: Buffer) => void]>([
    ['duplicate table', (font) => font.copy(font, 28, 12, 16)],
    ['nonASCII table tag', (font) => { font[12] = 0xcf; }],
    ['overlapping table', (font) => font.writeUInt32BE(fontTable(font, 'head').offset, fontTable(font, 'hmtx').record + 8)],
    ['table out of bounds', (font) => font.writeUInt32BE(0xfffffff0, fontTable(font, 'glyf').record + 8)],
    ['missing required table', (font) => font.write('xxxx', fontTable(font, 'OS/2').record, 'ascii')],
    ['invalid magic', (font) => font.writeUInt32BE(0, fontTable(font, 'head').offset + 12)],
    ['invalid units', (font) => font.writeUInt16BE(0, fontTable(font, 'head').offset + 18)],
    ['unsupported loca', (font) => font.writeInt16BE(2, fontTable(font, 'head').offset + 50)],
    ['invalid glyph count', (font) => font.writeUInt16BE(0, fontTable(font, 'maxp').offset + 4)],
    ['invalid metrics count', (font) => font.writeUInt16BE(6, fontTable(font, 'hhea').offset + 34)],
    ['truncated metrics', (font) => font.writeUInt32BE(2, fontTable(font, 'hmtx').record + 12)],
    ['loca exceeds glyf', (font) => font.writeUInt32BE(0xffffffff, fontTable(font, 'loca').offset + 4)],
    ['loca is descending', (font) => font.writeUInt32BE(0, fontTable(font, 'loca').offset + 12)],
    ['glyph coordinates reversed', (font) => font.writeInt16BE(900, fontTable(font, 'glyf').offset + 2)],
    ['glyph point exceeds bbox', (font) => font.writeInt16BE(30000, fontTable(font, 'glyf').offset + 18)],
    ['glyph contour endpoint order', (font) => font.writeInt16BE(2, fontTable(font, 'glyf').offset)],
    ['glyph flag repeat overflow', (font) => { const at = fontTable(font, 'glyf').offset; font[at + 14] = 9; font[at + 15] = 255; }],
    ['cmap overlap', (font) => { const at = fontTable(font, 'cmap').offset + 12; font.writeUInt16BE(32, at + 24); }],
    ['cmap glyph outside maxp', (font) => { const at = fontTable(font, 'cmap').offset + 12; font.writeInt16BE(20, at + 30); }],
    ['cmap missing sentinel', (font) => { const at = fontTable(font, 'cmap').offset + 12; font.writeUInt16BE(100, at + 18); }],
    ['name storage bounds', (font) => font.writeUInt16BE(65535, fontTable(font, 'name').offset + 4)],
    ['duplicate name record', (font) => { const at = fontTable(font, 'name').offset; font.copy(font, at + 18, at + 6, at + 18); }],
    ['missing A', (font) => { const at = fontTable(font, 'cmap').offset + 12; font.writeInt16BE(-65, at + 30); }],
    ['no capital outline', (font) => { const glyf = fontTable(font, 'glyf').offset, loca = fontTable(font, 'loca').offset; font.writeInt16BE(0, glyf + font.readUInt32BE(loca + 8)); }],
    ['CFF outlines', (font) => font.write('OTTO', 0, 'ascii')],
    ['variable font', (font) => font.write('fvar', fontTable(font, 'post').record, 'ascii')],
  ])('rejects malformed/unsupported font metadata: %s', (_name, change) => {
    const font = nativeFontFixture();
    change(font);
    expect(() => parseFontMetrics(font)).toThrow();
  });

  it.each(['sbix', 'COLR', 'CPAL', 'CBDT', 'CBLC', 'SVG '])('keeps unsupported bitmap/color glyph table %s on Canvas fallback even with valid glyf metrics', (tag) => {
    const font = nativeFontFixture();
    font.write(tag, fontTable(font, 'post').record, 'ascii');
    expect(() => parseFontMetrics(font)).toThrow(`bitmap/color glyph tables are unsupported (${tag.trim()}); use Canvas fallback`);
  });

  it('marks only declared monochrome bitmap glyph ranges unknown while retaining native A and parent metrics', () => {
    const normal = parseFontMetrics(nativeFontFixture()), metrics = parseFontMetrics(nativeFontFixture({ bitmapGlyphRange: [3, 4] }));
    expect(metrics.glyphBoundsKnown).toEqual([true, true, true, false, false]);
    expect(metrics.capitalHeight).toBe(normal.capitalHeight);
    expect(metrics.advances).toEqual(normal.advances); expect(metrics.glyphBounds).toEqual(normal.glyphBounds);
    expect(() => parseFontMetrics(nativeFontFixture({ bitmapGlyphRange: [2, 3] }))).toThrow('capital A glyph must have a known origin');
  });

  it.each<[string, (font: Buffer, location: number, data: number) => void]>([
    ['missing EBDT', (font) => font.write('xBDT', fontTable(font, 'EBDT').record, 'ascii')],
    ['missing EBLC', (font) => font.write('xBLC', fontTable(font, 'EBLC').record, 'ascii')],
    ['unsupported bitmap scaling', (font) => font.write('EBSC', fontTable(font, 'post').record, 'ascii')],
    ['wrong EBDT version', (font, _location, data) => font.writeUInt32BE(0x00030000, data)],
    ['wrong EBLC version', (font, location) => font.writeUInt32BE(0x00030000, location)],
    ['zero strikes', (font, location) => font.writeUInt32BE(0, location + 4)],
    ['too many strikes', (font, location) => font.writeUInt32BE(129, location + 4)],
    ['truncated strike records', (font) => font.writeUInt32BE(55, fontTable(font, 'EBLC').record + 12)],
    ['reversed glyph range', (font, location) => font.writeUInt16BE(2, location + 50)],
    ['glyph outside maxp', (font, location) => font.writeUInt16BE(5, location + 50)],
    ['zero ppem', (font, location) => { font[location + 52] = 0; }],
    ['unsupported depth', (font, location) => { font[location + 54] = 3; }],
    ['reserved flags', (font, location) => { font[location + 55] = 8; }],
    ['nonzero color reference', (font, location) => font.writeUInt32BE(1, location + 20)],
    ['index list in strike directory', (font, location) => font.writeUInt32BE(8, location + 8)],
    ['index list outside table', (font, location) => font.writeUInt32BE(0xfffffffc, location + 8)],
    ['index list size outside table', (font, location) => font.writeUInt32BE(0xfffffffc, location + 12)],
    ['index count outside budget', (font, location) => font.writeUInt32BE(4097, location + 16)],
    ['index range outside strike', (font, location) => font.writeUInt16BE(2, location + 56)],
    ['subtable offset in index directory', (font, location) => font.writeUInt32BE(0, location + 60)],
    ['subtable offset outside list', (font, location) => font.writeUInt32BE(0xfffffffc, location + 60)],
    ['unsupported index format', (font, location) => font.writeUInt16BE(6, location + 64)],
    ['unsupported image format', (font, location) => font.writeUInt16BE(17, location + 66)],
    ['image offset outside EBDT', (font, location) => font.writeUInt32BE(0xfffffffc, location + 68)],
  ])('rejects malformed or unsupported monochrome bitmap locations: %s', (_name, change) => {
    const font = nativeFontFixture({ bitmapGlyphRange: [3, 4] });
    change(font, fontTable(font, 'EBLC').offset, fontTable(font, 'EBDT').offset);
    expect(() => parseFontMetrics(font)).toThrow();
  });

  it('rejects malformed full-Unicode groups and disagreeing BMP mappings', () => {
    for (const change of [(font: Buffer, at: number) => font.writeUInt32BE(0, at + 16 + 12), (font: Buffer, at: number) => font.writeUInt32BE(0x110000, at + 16 + 2 * 12 + 4), (font: Buffer, at: number) => font.writeUInt32BE(0xd800, at + 16 + 2 * 12), (font: Buffer, at: number) => font.writeUInt32BE(3, at + 16 + 12 + 8)]) {
      const font = nativeFontFixture({ format12: true }), cmap = fontTable(font, 'cmap').offset, full = cmap + font.readUInt32BE(cmap + 16);
      change(font, full);
      expect(() => parseFontMetrics(font)).toThrow();
    }
  });

  it('rejects composite cycles, absent children and invalid first-component point matching', () => {
    for (const child of [4, 9]) {
      const font = nativeFontFixture({ composite: true }), glyph = fontTable(font, 'glyf').offset + font.readUInt32BE(fontTable(font, 'loca').offset + 16);
      font.writeUInt16BE(child, glyph + 12);
      expect(() => parseFontMetrics(font)).toThrow();
    }
    expect(() => parseFontMetrics(nativeFontFixture({ composite: true, compositeFlags: 0 }))).toThrow('first composite');
  });

  it('checks instructions declared by an earlier composite component', () => {
    const first = compositeGlyph(2, [-20, 0, 620, 730], 0x0122), second = compositeGlyph(3, [-20, 0, 620, 730], 2);
    const body = Buffer.concat([first, second.subarray(10), Buffer.from([0xff, 0xff])]);
    expect(() => parseFontMetrics(nativeFontFixture({ extraGlyphs: [body] }))).toThrow('composite glyph instructions');
  });

  it('checks composite depth independently of ascending/descending glyph traversal order', () => {
    const chain = Array.from({ length: 80 }, (_, index) => compositeGlyph(index + 4, [-20, 0, 620, 730]));
    expect(() => parseFontMetrics(nativeFontFixture({ composite: true, extraGlyphs: chain }))).toThrow('nesting');
    const reverse = chain.map((_, index) => compositeGlyph(index === chain.length - 1 ? 2 : index + 6, [-20, 0, 620, 730]));
    expect(() => parseFontMetrics(nativeFontFixture({ extraGlyphs: reverse }))).toThrow('nesting');
  });

  it('bounds input allocation and rejects truncation, invalid arrays and face indices', () => {
    expect(() => parseFontMetrics(Buffer.alloc(MAX_FONT_BYTES + 1))).toThrow('64 MiB');
    expect(() => parseFontMetrics(Buffer.alloc(11))).toThrow();
    expect(() => parseFontMetrics(nativeFontFixture().subarray(0, 200))).toThrow();
    expect(() => parseFontMetrics([] as unknown as Uint8Array)).toThrow();
    expect(() => parseFontMetrics(nativeFontFixture(), { faceIndex: NaN })).toThrow();
  });
});

describe('read-only Windows font authority and exact family/style resolution', () => {
  it('reads a safe filename and selects common installed bold/italic variants', async () => {
    const fontsDirectory = await privateDirectory();
    for (const [filename, bold, italic] of [['arial.ttf', false, false], ['arialbd.ttf', true, false], ['ariali.ttf', false, true], ['arialbi.ttf', true, true]] as const) await fs.writeFile(path.join(fontsDirectory, filename), nativeFontFixture({ family: 'Arial', bold, italic }));
    expect(await readWindowsFontMetrics({ font: 'Arial', family: 'Arial', bold: true, italic: true }, { fontsDirectory })).toMatchObject({ family: 'Arial', bold: true, italic: true, resolvedFilename: 'arialbi.ttf' });
    expect(await readWindowsFontMetrics({ font: 'arialbd.ttf', italic: false }, { fontsDirectory })).toMatchObject({ bold: true, italic: false, resolvedFilename: 'arialbd.ttf' });
    expect(await readWindowsFontMetrics({ font: 'arialbi.ttf', bold: true }, { fontsDirectory })).toMatchObject({ bold: true, italic: true, resolvedFilename: 'arialbi.ttf' });
    expect(await readWindowsFontMetrics({ font: 'arialbi.ttf', bold: false }, { fontsDirectory })).toMatchObject({ bold: false, italic: true, resolvedFilename: 'ariali.ttf' });
    await expect(readWindowsFontMetrics({ font: 'arial.ttf', family: 'Times New Roman' }, { fontsDirectory })).rejects.toThrow('family does not match');
  });

  it('rejects substitutions, unknown family guesses and missing actual style variants', async () => {
    const fontsDirectory = await privateDirectory();
    await fs.writeFile(path.join(fontsDirectory, 'custom.ttf'), nativeFontFixture());
    expect(await readWindowsFontMetrics({ font: 'custom.ttf', family: 'JCad Fixture' }, { fontsDirectory })).toMatchObject({ family: 'JCad Fixture', resolvedFilename: 'custom.ttf' });
    await expect(readWindowsFontMetrics({ font: 'custom.ttf', bold: true }, { fontsDirectory })).rejects.toThrow('style does not match');
    await expect(readWindowsFontMetrics({ font: 'Unknown Family' }, { fontsDirectory })).rejects.toThrow('unknown Windows font family');
    await expect(readWindowsFontMetrics({ font: 'Tahoma', italic: true }, { fontsDirectory })).rejects.toThrow('no known installed variant');
    await expect(readWindowsFontMetrics({ font: 'Arial', bold: true }, { fontsDirectory })).rejects.toThrow();
  });

  it.each(['../outside.ttf', '..\\outside.ttf', 'C:\\Windows\\Fonts\\arial.ttf', '\\\\host\\fonts\\arial.ttf', 'file.ttf:stream', 'arial.ttf\0', 'arial.ttf ', 'arial.ttf.', 'NUL.ttf', 'COM1.ttf', 'file?.ttf', '.\\arial.ttf', '%WINDIR%/arial.ttf'])('rejects paths, streams, devices and unsafe basenames before I/O: %s', async (font) => {
    const lookup = vi.spyOn(nativeFs, 'realpath');
    await expect(readWindowsFontMetrics({ font }, { fontsDirectory: path.resolve('does-not-exist') })).rejects.toThrow('basename');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a link/junction escaping the trusted Fonts directory before opening it', async () => {
    const root = await privateDirectory(), fontsDirectory = path.join(root, 'fonts'), outside = path.join(root, 'outside');
    await fs.mkdir(fontsDirectory); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(fontsDirectory, 'escape.ttf'), process.platform === 'win32' ? 'junction' : 'dir');
    const opened = vi.spyOn(nativeFs, 'open');
    await expect(readWindowsFontMetrics({ font: 'escape.ttf' }, { fontsDirectory })).rejects.toThrow('outside the trusted');
    expect(opened).not.toHaveBeenCalled();
  });

  it('revalidates opened file identity before reading and closes rejected file handles', async () => {
    const fontsDirectory = await privateDirectory(), filename = path.join(fontsDirectory, 'custom.ttf');
    await fs.writeFile(filename, nativeFontFixture());
    const originalOpen = nativeFs.open;
    let rejectedHandle: Awaited<ReturnType<typeof originalOpen>> | undefined;
    const opened = vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (file, flags) => {
      const handle = await originalOpen(file, flags);
      rejectedHandle = handle;
      vi.spyOn(handle, 'read');
      await fs.rename(filename, path.join(fontsDirectory, 'original.ttf'));
      await fs.writeFile(filename, nativeFontFixture({ family: 'Replacement' }));
      return handle;
    });
    await expect(readWindowsFontMetrics({ font: 'custom.ttf' }, { fontsDirectory })).rejects.toThrow('changed before reading');
    expect(opened).toHaveBeenCalledWith(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    expect(rejectedHandle!.read).not.toHaveBeenCalled();
    await expect(rejectedHandle!.stat()).rejects.toThrow();
  });

  it('bounds a sparse oversized file before allocating or parsing its contents', async () => {
    const fontsDirectory = await privateDirectory(), handle = await fs.open(path.join(fontsDirectory, 'large.ttf'), 'w');
    await handle.truncate(MAX_FONT_BYTES + 1); await handle.close();
    await expect(readWindowsFontMetrics({ font: 'large.ttf' }, { fontsDirectory })).rejects.toThrow('64 MiB');
  });

  const windowsFonts = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  it.runIf(process.platform === 'win32' && existsSync(path.join(windowsFonts, 'seguiemj.ttf')))('rejects installed Segoe UI Emoji color metrics using only a private file copy', async () => {
    const fontsDirectory = await privateDirectory();
    await fs.copyFile(path.join(windowsFonts, 'seguiemj.ttf'), path.join(fontsDirectory, 'seguiemj.ttf'));
    await expect(readWindowsFontMetrics({ font: 'seguiemj.ttf', family: 'Segoe UI Emoji' }, { fontsDirectory })).rejects.toThrow('bitmap/color glyph tables are unsupported');
  });

  it.runIf(process.platform === 'win32' && ['arial.ttf', 'cour.ttf', 'times.ttf'].every((font) => existsSync(path.join(windowsFonts, font))))('matches installed native Arial/Courier/Times metrics using only private file copies', async () => {
    const fontsDirectory = await privateDirectory();
    for (const [font, family, capitalHeight, winDescent, advanceA, boxA] of [['arial.ttf', 'Arial', 1466, 434, 1366, [-3, 0, 1369, 1466]], ['cour.ttf', 'Courier New', 1170, 615, 1229, [17, 0, 1215, 1170]], ['times.ttf', 'Times New Roman', 1387, 443, 1479, [16, 0, 1456, 1387]]] as const) {
      await fs.copyFile(path.join(windowsFonts, font), path.join(fontsDirectory, font));
      const metrics = await readWindowsFontMetrics({ font, family }, { fontsDirectory });
      expect(metrics).toMatchObject({ family, unitsPerEm: 2048, capitalHeight, winDescent, bold: false, italic: false });
      expect(metrics.advances[metrics.cmap[65]!]).toBe(advanceA);
      expect(metrics.glyphBounds[metrics.cmap[65]!]).toEqual(boxA);
      expect(metrics.glyphBoundsKnown[metrics.cmap[65]!]).toBe(true);
      if (font === 'cour.ttf') {
        // Its embedded monochrome strikes cover only these shading glyphs, not ASCII/A.
        expect([0x2591, 0x2592, 0x2593].map((code) => metrics.glyphBoundsKnown[metrics.cmap[code]!])).toEqual([false, false, false]);
      }
      if (font === 'times.ttf') {
        // Native/Chrome X uses own pp1; raw Y remains visible beyond the Windows TEXTBOX clip.
        const bar = metrics.cmap[0x2502]!;
        expect(metrics.glyphBounds[bar]).toEqual([638, -621, 813, 1864]);
        expect(metrics.glyphBoundsKnown[bar]).toBe(true);
        expect(metrics.advances[bar]).toBe(1451);
      }
    }
  });

  it.runIf(process.platform === 'win32' && existsSync(path.join(windowsFonts, 'arialbd.ttf')))('matches native Arial Bold accented Greek/Cyrillic CAD bounds and parent advances', async () => {
    const fontsDirectory = await privateDirectory();
    await fs.copyFile(path.join(windowsFonts, 'arialbd.ttf'), path.join(fontsDirectory, 'arialbd.ttf'));
    const metrics = await readWindowsFontMetrics({ font: 'arialbd.ttf', family: 'Arial', bold: true }, { fontsDirectory });
    const greek = metrics.cmap[0x03ad]!, cyrillic = metrics.cmap[0x0403]!;
    expect(metrics.advances[greek]).toBe(924);
    expect(metrics.glyphBounds[greek]).toEqual([78, -24, 948, 1491]);
    expect(metrics.advances[cyrillic]).toBe(1161);
    expect(metrics.glyphBounds[cyrillic]).toEqual([154, 0, 1186, 1849]);
    expect(metrics.glyphBoundsKnown[greek]).toBe(true);
    expect(metrics.glyphBoundsKnown[cyrillic]).toBe(true);
    // AutoCAD height10 TEXTBOX: first ink X1.05048 and second glyph maximum16.0095.
    expect(metrics.glyphBounds[cyrillic]![0]! * 10 / metrics.capitalHeight).toBeCloseTo(1.05047748977, 8);
    expect((metrics.advances[cyrillic]! + metrics.glyphBounds[cyrillic]![2]!) * 10 / metrics.capitalHeight).toBeCloseTo(16.00954979536, 8);
  });
});
