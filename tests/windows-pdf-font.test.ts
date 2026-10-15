import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fontCollection, fontCollectionV2, fontTable, nativeFontFixture } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';

type Request = { font: string; family?: string; bold?: boolean; italic?: boolean };
type Options = { fontsDirectory?: string };
type Data = { bytes: Uint8Array; metrics: NativeFontMetrics & { resolvedFilename: string } };
type Face = Data & { postscriptName: string; ascender: number; descender: number; italicAngle: number; weight: number; isFixedPitch: boolean; os2Version: number };
const require = createRequire(import.meta.url);
const { readWindowsPdfFont, pdfFontEmbeddingProblem } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options?: Options): Promise<Face>;
  pdfFontEmbeddingProblem(fsType: number, os2Version: number): string | null;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(input: Uint8Array, faceIndex?: number): Buffer;
};
const { readWindowsFontData, readWindowsFontMetrics, MAX_FONT_BYTES } = require('../electron/font-metrics.cjs') as {
  readWindowsFontData(request: Request, options?: Options): Promise<Data>;
  readWindowsFontMetrics(request: Request, options?: Options): Promise<Data['metrics']>;
  MAX_FONT_BYTES: number;
};
const nativeFs = require('node:fs/promises') as typeof fs;
const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-pdf-font-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-pdf-font-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected PDF font test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  fsType?: number;
  os2Version?: number;
  postscriptName?: string | null;
  macPostscriptName?: string;
  italicAngle?: number;
  fixedPitch?: number;
  weight?: number;
  ascender?: number;
  descender?: number;
}
function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let i = 0; i < 4; i++) word = (word * 256 + (bytes[offset + i] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}
/** PDF-specific descriptor/name records, still entirely hand-authored font metadata. */
function pdfFixture(options: FixtureOptions = {}): Buffer {
  const source = nativeFontFixture(), tables = new Map<string, Buffer>();
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.set(source.toString('ascii', at, at + 4), Buffer.from(source.subarray(start, start + length)));
  }
  const os2 = Buffer.alloc(options.os2Version === 5 ? 100 : 96);
  tables.get('OS/2')!.copy(os2); os2.writeUInt16BE(options.os2Version ?? 4, 0); os2.writeUInt16BE(options.fsType ?? 0, 8); os2.writeUInt16BE(options.weight ?? 400, 4); tables.set('OS/2', os2);
  const hhea = tables.get('hhea')!; hhea.writeInt16BE(options.ascender ?? 1000, 4); hhea.writeInt16BE(options.descender ?? -200, 6);
  const post = tables.get('post')!; post.writeInt32BE(Math.round((options.italicAngle ?? -12.5) * 65536), 4); post.writeUInt32BE(options.fixedPitch ?? 0, 12);
  const name = tables.get('name')!, storage = name.readUInt16BE(4);
  const records = Array.from({ length: name.readUInt16BE(2) }, (_, i) => {
    const at = 6 + i * 12, length = name.readUInt16BE(at + 8), start = storage + name.readUInt16BE(at + 10);
    return { platform: name.readUInt16BE(at), encoding: name.readUInt16BE(at + 2), language: name.readUInt16BE(at + 4), id: name.readUInt16BE(at + 6), bytes: Buffer.from(name.subarray(start, start + length)) };
  });
  if (options.postscriptName !== null) records.push({ platform: 3, encoding: 1, language: 0x0409, id: 6, bytes: Buffer.from(options.postscriptName ?? 'JCadFixture-Regular', 'utf16le').swap16() });
  if (options.macPostscriptName !== undefined) records.push({ platform: 1, encoding: 0, language: 0, id: 6, bytes: Buffer.from(options.macPostscriptName, 'latin1') });
  const newStorage = 6 + records.length * 12, names = Buffer.alloc(newStorage + records.reduce((sum, record) => sum + record.bytes.length, 0));
  names.writeUInt16BE(records.length, 2); names.writeUInt16BE(newStorage, 4);
  let position = 0;
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, position].forEach((value, part) => names.writeUInt16BE(value, at + part * 2));
    record.bytes.copy(names, newStorage + position); position += record.bytes.length;
  });
  tables.set('name', names); tables.get('head')!.writeUInt32BE(0, 8);
  const result = Buffer.alloc(12 + tables.size * 16 + [...tables.values()].reduce((sum, bytes) => sum + Math.ceil(bytes.length / 4) * 4, 0));
  result.writeUInt32BE(0x00010000, 0); result.writeUInt16BE(tables.size, 4);
  const selector = Math.floor(Math.log2(tables.size)), searchRange = 2 ** selector * 16;
  result.writeUInt16BE(searchRange, 6); result.writeUInt16BE(selector, 8); result.writeUInt16BE(tables.size * 16 - searchRange, 10);
  position = 12 + tables.size * 16;
  [...tables].forEach(([tag, bytes], i) => {
    const at = 12 + i * 16; result.write(tag, at, 'ascii'); result.writeUInt32BE(checksum(bytes), at + 4); result.writeUInt32BE(position, at + 8); result.writeUInt32BE(bytes.length, at + 12);
    bytes.copy(result, position); position += Math.ceil(bytes.length / 4) * 4;
  });
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, fontTable(result, 'head').offset + 8);
  return result;
}
async function readFixture(bytes: Buffer): Promise<Face> {
  const fontsDirectory = await privateDirectory(); await fs.writeFile(path.join(fontsDirectory, 'fixture.ttf'), bytes);
  return readWindowsPdfFont({ font: 'fixture.ttf', family: 'JCad Fixture' }, { fontsDirectory });
}

describe('version-aware native PDF embedding permissions', () => {
  it.each<[number, number, string | null]>([
    [0, 0, null], [1, 0, null], [2, 0, null], [3, 0, null], [4, 0, null], [5, 0, null],
    [0, 8, null], [1, 0x0208, null], [1, 0xfcf8, null], [2, 14, null], [2, 6, 'read-only'],
    [3, 14, 'conflicting'], [4, 10, 'conflicting'], [5, 12, 'conflicting'],
    [4, 0x0100, null], [4, 0x0108, null], [2, 0x0208, 'bitmap-only'], [4, 0x0200, 'bitmap-only'],
    [0, 2, 'restricted'], [1, 2, 'restricted'], [4, 2, 'restricted'], [4, 4, 'read-only'],
    [0, 1, 'reserved'], [1, 1, 'reserved'], [2, 0x0018, 'reserved'], [5, 0x8008, 'reserved'],
  ])('uses actual OS2 version %i and fsType %i', async (os2Version, fsType, problem) => {
    if (problem) await expect(readFixture(pdfFixture({ os2Version, fsType }))).rejects.toThrow(problem);
    else {
      const bytes = pdfFixture({ os2Version, fsType }), face = await readFixture(bytes);
      expect(face.bytes).toEqual(bytes); expect(face.metrics.fsType).toBe(fsType); expect(face.os2Version).toBe(os2Version);
    }
  });
  it.each([[NaN, 4], [0, NaN], [-1, 4], [65536, 4], [0, -1], [0, 6], [1.5, 4]])('rejects invalid permission values %j', (fsType, version) => {
    expect(pdfFontEmbeddingProblem(fsType!, version!)).toMatch(/invalid/);
  });
  it('returns the complete original font, even when no-subsetting is required', async () => {
    const bytes = pdfFixture({ fsType: 0x0108, weight: 700, italicAngle: -14.5, fixedPitch: 9 }), face = await readFixture(bytes);
    expect(face.bytes).toEqual(bytes);
    expect(face).toMatchObject({ postscriptName: 'JCadFixture-Regular', ascender: 1000, descender: -200, weight: 700, italicAngle: -14.5, isFixedPitch: true, os2Version: 4 });
    expect(face.metrics.advances).toHaveLength(5); expect(face.metrics.resolvedFilename).toBe('fixture.ttf');
  });
});

describe('PDF source font descriptors from exact validated bytes', () => {
  it('retains metadata-only API behavior and provides one private byte snapshot to explicit data callers', async () => {
    const fontsDirectory = await privateDirectory(), filename = path.join(fontsDirectory, 'fixture.ttf'), bytes = pdfFixture();
    await fs.writeFile(filename, bytes);
    const options = { fontsDirectory }, request = { font: 'fixture.ttf', family: 'JCad Fixture' };
    const data = await readWindowsFontData(request, options), metadata = await readWindowsFontMetrics(request, options);
    expect(data.bytes).toEqual(bytes); expect(data.metrics).toEqual(metadata); expect(Object.hasOwn(metadata, 'bytes')).toBe(false);
    data.bytes[0] = 0; expect(await fs.readFile(filename)).toEqual(bytes);
    expect((await readWindowsFontData(request, options)).bytes).toEqual(bytes);
  });
  it('accepts identical Unicode/Mac PostScript names and a valid PDF name escape character', async () => {
    const name = 'JCad#Fixture-Regular', face = await readFixture(pdfFixture({ postscriptName: name, macPostscriptName: name }));
    expect(face.postscriptName).toBe(name);
    const macOnly = await readFixture(pdfFixture({ postscriptName: null, macPostscriptName: 'JCadFixture-Regular' }));
    expect(macOnly.postscriptName).toBe('JCadFixture-Regular');
  });
  it.each([null, '', 'With Space', 'Bad/Name', 'Bad[Name', 'Bad%Name', 'ÅFont', '\ud800', 'a'.repeat(64)])('refuses missing or invalid native nameID6: %j', async (postscriptName) => {
    await expect(readFixture(pdfFixture({ postscriptName }))).rejects.toThrow(/PostScript nameID6/);
  });
  it('refuses platform-specific contradictory PostScript names instead of choosing one', async () => {
    await expect(readFixture(pdfFixture({ macPostscriptName: 'DifferentName' }))).rejects.toThrow('conflicting PostScript nameID6');
  });
  it.each<[string, FixtureOptions]>([
    ['negative ascender', { ascender: -1 }], ['positive descender', { descender: 1 }],
    ['zero weight', { weight: 0 }], ['excessive weight', { weight: 1001 }], ['invalid italic angle', { italicAngle: 90.01 }],
  ])('refuses unsupported descriptor fields: %s', async (_name, options) => {
    await expect(readFixture(pdfFixture(options))).rejects.toThrow(/vertical metrics|weight or italic angle/);
  });
  it.each(['post', 'name'])('refuses missing descriptor table %s', async (tag) => {
    const bytes = pdfFixture(); bytes.write('xxxx', fontTable(bytes, tag).record, 'ascii');
    await expect(readFixture(bytes)).rejects.toThrow(/missing/);
  });
  it('refuses truncated and unsupported post headers', async () => {
    const truncated = pdfFixture(); truncated.writeUInt32BE(16, fontTable(truncated, 'post').record + 12);
    await expect(readFixture(truncated)).rejects.toThrow('truncated post');
    const unsupported = pdfFixture(); unsupported.writeUInt32BE(0x00040000, fontTable(unsupported, 'post').offset);
    await expect(readFixture(unsupported)).rejects.toThrow('post table version');
  });
  it('extracts face 0 of a collection while metadata collection reads stay available', async () => {
    const fontsDirectory = await privateDirectory(), bytes = fontCollection(pdfFixture());
    await fs.writeFile(path.join(fontsDirectory, 'collection.ttc'), bytes);
    expect((await readWindowsFontMetrics({ font: 'collection.ttc' }, { fontsDirectory })).capitalHeight).toBe(730);
    const face = await readWindowsPdfFont({ font: 'collection.ttc' }, { fontsDirectory });
    expect(face.bytes).toEqual(extractTtcFace(bytes, 0));
    expect(face.bytes).not.toEqual(bytes);
    expect(Buffer.from(face.bytes).readUInt32BE(0)).toBe(0x00010000);
    expect(face).toMatchObject({ postscriptName: 'JCadFixture-Regular', ascender: 1000, descender: -200, weight: 400, os2Version: 4 });
    expect(face.metrics.capitalHeight).toBe(730);
    expect(face.metrics.resolvedFilename).toBe('collection.ttc');
  });
  it('extracts face 0 of a v2 collection', async () => {
    const fontsDirectory = await privateDirectory(), bytes = fontCollectionV2(pdfFixture());
    await fs.writeFile(path.join(fontsDirectory, 'collection.ttc'), bytes);
    const face = await readWindowsPdfFont({ font: 'collection.ttc' }, { fontsDirectory });
    expect(face.bytes).toEqual(extractTtcFace(bytes, 0));
    expect(face.postscriptName).toBe('JCadFixture-Regular');
  });
  it('embeds only face 0 when a later collection face is restricted', async () => {
    const fontsDirectory = await privateDirectory();
    const bytes = fontCollection(pdfFixture({ postscriptName: 'FaceZero' }), pdfFixture({ postscriptName: 'FaceOne', fsType: 2 }));
    await fs.writeFile(path.join(fontsDirectory, 'collection.ttc'), bytes);
    const face = await readWindowsPdfFont({ font: 'collection.ttc' }, { fontsDirectory });
    expect(face.postscriptName).toBe('FaceZero');
  });
  it.each([[2, 'restricted'], [4, 'read-only'], [0x0208, 'bitmap-only']])('refuses collection face 0 with prohibited fsType %#', async (fsType, problem) => {
    const fontsDirectory = await privateDirectory();
    await fs.writeFile(path.join(fontsDirectory, 'collection.ttc'), fontCollection(pdfFixture({ fsType })));
    await expect(readWindowsPdfFont({ font: 'collection.ttc' }, { fontsDirectory })).rejects.toThrow(problem);
  });
  it.each(['fvar', 'COLR', 'CPAL', 'CBDT', 'CBLC', 'sbix', 'SVG '])('refuses unsupported native font structure %s before exposing bytes', async (tag) => {
    const bytes = pdfFixture(); bytes.write(tag, fontTable(bytes, 'post').record, 'ascii');
    await expect(readFixture(bytes)).rejects.toThrow(/unsupported/);
  });
  it('refuses CFF outlines', async () => {
    const bytes = pdfFixture(); bytes.write('OTTO', 0, 'ascii');
    await expect(readFixture(bytes)).rejects.toThrow('CFF');
  });
});

describe('read-only PDF font path and file-race authority', () => {
  it.each(['../font.ttf', '..\\font.ttf', 'C:\\Windows\\Fonts\\arial.ttf', 'arial.ttf:stream', 'NUL.ttf', 'font.ttf\0', 'font.ttf.'])('rejects unsafe paths before I/O: %s', async (font) => {
    const realpath = vi.spyOn(nativeFs, 'realpath');
    await expect(readWindowsPdfFont({ font }, { fontsDirectory: path.resolve('does-not-exist') })).rejects.toThrow('basename');
    expect(realpath).not.toHaveBeenCalled();
  });
  it('refuses a junction escape without opening the target', async () => {
    const root = await privateDirectory(), fontsDirectory = path.join(root, 'fonts'), outside = path.join(root, 'outside');
    await fs.mkdir(fontsDirectory); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(fontsDirectory, 'escape.ttf'), process.platform === 'win32' ? 'junction' : 'dir');
    const opened = vi.spyOn(nativeFs, 'open');
    await expect(readWindowsPdfFont({ font: 'escape.ttf' }, { fontsDirectory })).rejects.toThrow('outside the trusted');
    expect(opened).not.toHaveBeenCalled();
  });
  it('refuses replacement between path resolution and reading; rejected handles close', async () => {
    const fontsDirectory = await privateDirectory(), filename = path.join(fontsDirectory, 'fixture.ttf');
    await fs.writeFile(filename, pdfFixture());
    const originalOpen = nativeFs.open;
    let rejectedHandle: Awaited<ReturnType<typeof originalOpen>> | undefined;
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (file, flags) => {
      const handle = await originalOpen(file, flags); rejectedHandle = handle; vi.spyOn(handle, 'read');
      await fs.rename(filename, path.join(fontsDirectory, 'original.ttf')); await fs.writeFile(filename, pdfFixture({ fsType: 2 }));
      return handle;
    });
    await expect(readWindowsPdfFont({ font: 'fixture.ttf' }, { fontsDirectory })).rejects.toThrow('changed before reading');
    expect(rejectedHandle!.read).not.toHaveBeenCalled(); await expect(rejectedHandle!.stat()).rejects.toThrow();
  });
  it('refuses bytes changed during the same descriptor read, even when parsed bytes would remain valid', async () => {
    const fontsDirectory = await privateDirectory(), filename = path.join(fontsDirectory, 'fixture.ttf'); await fs.writeFile(filename, pdfFixture());
    const originalOpen = nativeFs.open;
    let rejectedHandle: Awaited<ReturnType<typeof originalOpen>> | undefined;
    const opened = vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (file, flags) => {
      const handle = await originalOpen(file, flags); rejectedHandle = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: any[]) => {
        const result = await (read as (...values: any[]) => Promise<any>)(...args);
        await fs.writeFile(filename, pdfFixture({ weight: 700 })); await fs.utimes(filename, new Date(), new Date(Date.now() + 5000));
        return result;
      });
      return handle;
    });
    await expect(readWindowsPdfFont({ font: 'fixture.ttf' }, { fontsDirectory })).rejects.toThrow('changed while reading');
    expect(opened).toHaveBeenCalledWith(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    await expect(rejectedHandle!.stat()).rejects.toThrow();
  });
  it('refuses oversized files before allocation', async () => {
    const fontsDirectory = await privateDirectory(), handle = await fs.open(path.join(fontsDirectory, 'large.ttf'), 'w');
    await handle.truncate(MAX_FONT_BYTES + 1); await handle.close();
    await expect(readWindowsPdfFont({ font: 'large.ttf' }, { fontsDirectory })).rejects.toThrow('64 MiB');
  });

  const windowsFonts = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  it.runIf(process.platform === 'win32' && ['arial.ttf', 'times.ttf'].every((name) => existsSync(path.join(windowsFonts, name))))('returns exact private installed Arial/Times bytes and their actual descriptors', async () => {
    const fontsDirectory = await privateDirectory();
    for (const [font, family, expectedName] of [['arial.ttf', 'Arial', 'ArialMT'], ['times.ttf', 'Times New Roman', 'TimesNewRomanPSMT']] as const) {
      const copied = path.join(fontsDirectory, font); await fs.copyFile(path.join(windowsFonts, font), copied);
      const before = await fs.readFile(copied), face = await readWindowsPdfFont({ font, family }, { fontsDirectory });
      expect(Buffer.from(face.bytes).equals(before)).toBe(true); expect((await fs.readFile(copied)).equals(before)).toBe(true); expect(face.postscriptName).toBe(expectedName);
      expect(face.ascender).toBe(before.readInt16BE(fontTable(before, 'hhea').offset + 4)); expect(face.descender).toBe(before.readInt16BE(fontTable(before, 'hhea').offset + 6));
      expect(face.weight).toBe(before.readUInt16BE(fontTable(before, 'OS/2').offset + 4)); expect(face.os2Version).toBe(before.readUInt16BE(fontTable(before, 'OS/2').offset));
      expect(face.italicAngle).toBe(before.readInt32BE(fontTable(before, 'post').offset + 4) / 65536); expect(face.isFixedPitch).toBe(!!before.readUInt32BE(fontTable(before, 'post').offset + 12));
      expect(face.metrics.family).toBe(family); expect(pdfFontEmbeddingProblem(face.metrics.fsType, face.os2Version)).toBeNull();
    }
  });
});
