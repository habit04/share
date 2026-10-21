import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import type { TextEntity, Entity } from '../src/core/entities';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { vectorPdfCompressed, drawingContext, type PdfPageSpec } from '../src/io/pdf-vector';
import { PdfFontRegistry, type PdfFontFace } from '../src/io/pdf-fonts';
import { parsePdfBasics, dictValue, type PdfBasics } from './helpers/pdf';
import { fontCollection, fontTable, fvarNameEntries, fvarTable, nativeFontFixture, VARIABLE_AXES, VARIABLE_INSTANCES } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';

const require = createRequire(import.meta.url);
const { parseFontMetrics, readWindowsFontData, readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Uint8Array, options?: { faceIndex?: number; usedCodepoints?: readonly number[] }): NativeFontMetrics;
  readWindowsFontData(request: { font: string; family?: string; bold?: boolean; italic?: boolean; usedCodepoints?: readonly number[] }, options?: { fontsDirectory?: string }): Promise<{ metrics: NativeFontMetrics & { resolvedFilename: string; faceIndex: number }; bytes: Uint8Array }>;
  readWindowsFontMetrics(request: { font: string; family?: string; bold?: boolean; italic?: boolean }, options?: { fontsDirectory?: string }): Promise<NativeFontMetrics & { resolvedFilename: string; faceIndex: number }>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: { font: string; family?: string; bold?: boolean; italic?: boolean; usedCodepoints?: readonly number[] }, options?: { fontsDirectory?: string }): Promise<Omit<PdfFontFace, 'key'>>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as { extractTtcFace(input: Uint8Array, faceIndex?: number): Buffer };

const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-var-font-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-var-font-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected variable font test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function writeFont(bytes: Uint8Array, name = 'fixturevar.ttf'): Promise<string> {
  const directory = await privateDirectory();
  await fs.writeFile(path.join(directory, name), bytes);
  return directory;
}

describe('variable fonts at their default instance (12.6 slice 1a)', () => {
  it('admits a well-formed variable font for metrics with default-instance geometry identical to the static font', () => {
    const variable = parseFontMetrics(nativeFontFixture({ variable: true })), statik = parseFontMetrics(nativeFontFixture());
    expect(variable.variable).toBe(true);
    expect(statik.variable).toBeUndefined();
    expect(variable.advances).toEqual(statik.advances);
    expect(variable.glyphBounds).toEqual(statik.glyphBounds);
    expect(variable.glyphBoundsKnown).toEqual(statik.glyphBoundsKnown);
    expect(variable.capitalHeight).toBe(statik.capitalHeight);
    expect(variable.cmap).toEqual(statik.cmap);
    expect(variable.groups).toEqual(statik.groups);
    expect(variable.family).toBe(statik.family); expect(variable.subfamily).toBe(statik.subfamily);
    expect(variable.bold).toBe(false); expect(variable.italic).toBe(false);
  });

  it.each([
    ['unsupported fvar version', (table: Buffer) => table.writeUInt32BE(0x00020000, 0)],
    ['axis count above the limit', (table: Buffer) => table.writeUInt16BE(0x7fff, 8)],
    ['axis record size is not 20', (table: Buffer) => table.writeUInt16BE(24, 10)],
    ['instance record size too small for its coordinates', (table: Buffer) => table.writeUInt16BE(4, 14)],
    ['axis default outside its range', (table: Buffer) => table.writeInt32BE(800 * 65536, 16 + 8)],
    ['axis minimum above its maximum', (table: Buffer) => table.writeInt32BE(900 * 65536, 16 + 4)],
    ['duplicate axis tag', (table: Buffer) => table.write('wght', 16 + 20, 'ascii')],
    ['instance coordinate outside its axis range', (table: Buffer) => table.writeInt32BE(100 * 65536, 16 + table.readUInt16BE(8) * 20 + 4)],
    ['reserved instance flags set', (table: Buffer) => table.writeUInt16BE(1, 16 + table.readUInt16BE(8) * 20 + 2)],
    ['declared instances truncated', (table: Buffer) => table.subarray(0, table.length - 4)],
  ])('refuses a malformed fvar table: %s', (_name, change) => {
    const table = fvarTable(); const replacement: unknown = change(table);
    expect(() => parseFontMetrics(nativeFontFixture({ fvarTable: Buffer.isBuffer(replacement) ? replacement : Buffer.from(table) }))).toThrow(/variable|fvar/i);
  });

  it('still refuses a variable font that also carries color tables', () => {
    const font = nativeFontFixture({ variable: true, extraTables: { COLR: Buffer.alloc(16), CPAL: Buffer.alloc(16) } });
    expect(() => parseFontMetrics(font)).toThrow(/bitmap\/color glyph tables are unsupported \(COLR\)/);
  });

  it('reads a variable font through the confined reader and records the default-instance fact', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes);
    const fontsDirectory = await writeFont(program);
    const metrics = await readWindowsFontMetrics({ font: 'fixturevar.ttf' }, { fontsDirectory });
    expect(metrics.variable).toBe(true); expect(metrics.resolvedFilename).toBe('fixturevar.ttf');
    const data = await readWindowsFontData({ font: 'fixturevar.ttf' }, { fontsDirectory });
    expect(Buffer.from(data.bytes).equals(program)).toBe(true);
    expect(data.metrics.advances).toEqual(parseFontMetrics(nativeFontFixture()).advances);
  });

  it('does not silently select a named instance: a bold request still follows default-instance style flags', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes);
    const fontsDirectory = await writeFont(program);
    // The fixture fvar declares a Bold Condensed named instance (wght 700, wdth 75); the
    // request model carries no variation coordinates, so admitting it as bold would embed
    // the default instance while claiming bold — the existing style refusal must stand.
    await expect(readWindowsFontData({ font: 'fixturevar.ttf', bold: true }, { fontsDirectory }))
      .rejects.toThrow('installed font style does not match the requested style flags');
  });

  it('embeds the whole variable program byte-identically through the PDF reader', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes);
    const fontsDirectory = await writeFont(program);
    const face = await readWindowsPdfFont({ font: 'fixturevar.ttf' }, { fontsDirectory });
    expect(Buffer.from(face.bytes).equals(program)).toBe(true);
    expect(face.metrics.variable).toBe(true);
    expect(face.postscriptName).toBe('JCadArialRegular');
  });

  it('proves the same face at the same default coordinates across the metrics and PDF paths', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes);
    // The fixture's second named instance is NOT at the default coordinates (Bold Condensed
    // is wght 700 / wdth 75); if either path implicitly selected it, its metrics or bytes
    // would diverge from the default-instance face the other path produced.
    const fvar = fontTable(program, 'fvar'), axes = program.readUInt16BE(fvar.offset + 8), instancesAt = fvar.offset + 16 + axes * 20;
    const instanceSize = program.readUInt16BE(fvar.offset + 14);
    expect(axes).toBe(2);
    expect(program.readInt32BE(instancesAt + 4) / 65536).toBe(400);
    expect(program.readInt32BE(instancesAt + instanceSize + 4) / 65536).toBe(700);
    expect(program.readInt32BE(instancesAt + instanceSize + 8) / 65536).toBe(75);
    const fontsDirectory = await writeFont(program);
    const viaMetrics = await readWindowsFontData({ font: 'fixturevar.ttf' }, { fontsDirectory });
    const viaPdf = await readWindowsPdfFont({ font: 'fixturevar.ttf' }, { fontsDirectory });
    expect(viaPdf.metrics).toEqual(viaMetrics.metrics);
    expect(Buffer.from(viaPdf.bytes).equals(program)).toBe(true);
    expect(Buffer.from(viaMetrics.bytes).equals(program)).toBe(true);
    expect(viaPdf.metrics.variable).toBe(true);
    expect(viaPdf.metrics.advances).toEqual(parseFontMetrics(nativeFontFixture()).advances);
  });

  it('selects the variable face of a collection by index and measures its default instance', () => {
    const collection = fontCollection(nativeFontFixture({ family: 'Static Face' }), nativeFontFixture({ family: 'Variable Face', variable: true }));
    const face0 = parseFontMetrics(collection, { faceIndex: 0 }), face1 = parseFontMetrics(collection, { faceIndex: 1 });
    expect(face0.family).toBe('Static Face'); expect(face0.variable).toBeUndefined();
    expect(face1.family).toBe('Variable Face'); expect(face1.variable).toBe(true);
    expect(face1.advances).toEqual(face0.advances);
  });

  it('admits a variable face extracted from a collection, byte-identical to its standalone extraction', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes), collection = fontCollection(program);
    const fontsDirectory = await writeFont(collection, 'arial.ttc');
    const face = await readWindowsPdfFont({ font: 'arial.ttc' }, { fontsDirectory });
    expect(Buffer.from(face.bytes).equals(extractTtcFace(collection, 0))).toBe(true);
    expect(face.metrics.variable).toBe(true);
    expect(fontTable(Buffer.from(face.bytes), 'fvar').length).toBeGreaterThan(0);
  });

  it('reads a variable face from a NONZERO collection index through the production reader and encodes exactly the used codepoint set', async () => {
    // The confined reader must select face 1 from the original TTC itself, then use
    // that face's glyphs and permissions. An independently extracted face is the control.
    const statik = Buffer.from(pdfFontFixture({ family: 'Collection Static' }).bytes);
    const variable = Buffer.from(pdfFontFixture({ family: 'Collection Variable', variable: true }).bytes);
    const collection = fontCollection(statik, variable);
    expect(parseFontMetrics(collection, { faceIndex: 0 }).variable).toBeUndefined();
    const parsed = parseFontMetrics(collection, { faceIndex: 1 });
    expect(parsed.variable).toBe(true); expect(parsed.family).toBe('Collection Variable');
    const extracted = extractTtcFace(collection, 1);
    expect(Buffer.from(extracted).equals(variable)).toBe(false); // extraction rewrites the directory; it is a standalone program of face 1
    expect(fontTable(Buffer.from(extracted), 'fvar').length).toBeGreaterThan(0);
    const usedCodepoints = [0x41, 0x42, 0x20000];
    const fontsDirectory = await writeFont(collection, 'collection.ttc');
    const face = await readWindowsPdfFont({ font: 'collection.ttc', family: 'Collection Variable', bold: false, italic: false, usedCodepoints }, { fontsDirectory });
    expect(face.metrics).toEqual({ ...parseFontMetrics(collection, { faceIndex: 1, usedCodepoints }), resolvedFilename: 'collection.ttc', faceIndex: 1 });
    expect(Buffer.from(face.bytes).equals(Buffer.from(extracted))).toBe(true);
    const registry = new PdfFontRegistry([{ key: 'collection-variable', ...face }]);
    expect(registry.rejections.get('collection-variable')).toBeUndefined();
    // The used codepoint set for this plot: 'A', 'B' and the supplementary scalar U+20000.
    const run = registry.encode('collection-variable', 'AB\u{20000}');
    expect(run).not.toBeNull();
    expect(run!.glyphs).toEqual([2, 3, 4]);
    expect(run!.advance).toBe(650 + 650 + 650);
    // A codepoint outside the used set that the face does not map stays a refusal.
    expect(registry.encode('collection-variable', 'C')).toBeNull();
  });
});

describe('fvar record validation (12.6a corrections, metrics layer)', () => {
  /** Hand-crafted one-axis fvar with a caller-chosen instance record size (the generated builder only emits the legal +6 form). */
  function craftedFvar(instanceSize: number): Buffer {
    const data = Buffer.alloc(16 + 20 + instanceSize);
    data.writeUInt32BE(0x00010000, 0); data.writeUInt16BE(16, 4); data.writeUInt16BE(2, 6);
    data.writeUInt16BE(1, 8); data.writeUInt16BE(20, 10); data.writeUInt16BE(1, 12); data.writeUInt16BE(instanceSize, 14);
    data.write('wght', 16, 'ascii'); data.writeInt32BE(300 * 65536, 20); data.writeInt32BE(400 * 65536, 24); data.writeInt32BE(700 * 65536, 28);
    data.writeUInt16BE(256, 16 + 18);
    data.writeUInt16BE(257, 36); data.writeInt32BE(400 * 65536, 40);
    if (instanceSize >= 10) data.writeUInt16BE(0xffff, 44);
    return data;
  }
  const craftedNames = [[256, 'Weight'], [257, 'Regular']] as const;

  it('refuses instanceSize = axisCount*4 + 5 (only +4 or +6 are legal for fvar 1.0)', () => {
    const font = nativeFontFixture({ fvarTable: craftedFvar(9), extraNames: craftedNames });
    expect(() => parseFontMetrics(font)).toThrow(/instance record size/);
  });

  it('admits the +4 instance record form (no PostScript name ID field)', () => {
    const metrics = parseFontMetrics(nativeFontFixture({ fvarTable: craftedFvar(8), extraNames: craftedNames }));
    expect(metrics.variable).toBe(true);
    expect(metrics.advances).toEqual(parseFontMetrics(nativeFontFixture()).advances);
  });

  it('admits the +6 form with a 0xFFFF (absent) PostScript name ID', () => {
    const metrics = parseFontMetrics(nativeFontFixture({ fvarTable: craftedFvar(10), extraNames: craftedNames }));
    expect(metrics.variable).toBe(true);
  });

  it('refuses an axis name ID with no name table record', () => {
    const table = fvarTable(); table.writeUInt16BE(999, 16 + 18);
    const font = nativeFontFixture({ fvarTable: table, extraNames: fvarNameEntries(VARIABLE_AXES, VARIABLE_INSTANCES) });
    expect(() => parseFontMetrics(font)).toThrow(/axis name ID 999/);
  });

  it('refuses an instance subfamily name ID with no name table record', () => {
    const table = fvarTable(); table.writeUInt16BE(999, 16 + VARIABLE_AXES.length * 20);
    const font = nativeFontFixture({ fvarTable: table, extraNames: fvarNameEntries(VARIABLE_AXES, VARIABLE_INSTANCES) });
    expect(() => parseFontMetrics(font)).toThrow(/instance subfamily name ID 999/);
  });

  it('refuses an instance PostScript name ID with no name table record', () => {
    const instances = [{ coordinates: [400, 100], name: 'Regular', psName: 'JCadFixture-Regular' }, VARIABLE_INSTANCES[1]!] as const;
    const table = fvarTable(VARIABLE_AXES, instances);
    table.writeUInt16BE(999, 16 + VARIABLE_AXES.length * 20 + 4 + VARIABLE_AXES.length * 4);
    const font = nativeFontFixture({ fvarTable: table, extraNames: fvarNameEntries(VARIABLE_AXES, instances) });
    expect(() => parseFontMetrics(font)).toThrow(/instance PostScript name ID 999/);
  });
});

describe('default-coordinate identity policy (12.6a corrections, metrics layer)', () => {
  const wght500 = () => nativeFontFixture({
    variable: true, subfamily: 'Medium', os2Weight: 500,
    variableAxes: [{ tag: 'wght', min: 100, value: 500, max: 900 }, { tag: 'wdth', min: 50, value: 100, max: 150 }],
    variableInstances: [{ coordinates: [500, 100], name: 'Medium' }, { coordinates: [700, 100], name: 'Bold' }],
  });

  it('refuses a wght=500 default on a regular face (the Codex probe case)', () => {
    expect(() => parseFontMetrics(wght500())).toThrow(/default weight 500/);
  });

  it('refuses the wght=500 default through the confined reader on a regular request', async () => {
    const fontsDirectory = await writeFont(wght500(), 'probe.ttf');
    await expect(readWindowsFontData({ font: 'probe.ttf', family: 'JCad Fixture', bold: false, italic: false }, { fontsDirectory }))
      .rejects.toThrow(/default weight 500/);
  });

  it('refuses a wght axis default that disagrees with the OS/2 weight class', () => {
    const font = nativeFontFixture({
      variable: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 500, max: 700 }],
      variableInstances: [{ coordinates: [500], name: 'Regular' }],
    });
    expect(() => parseFontMetrics(font)).toThrow(/disagrees with OS\/2 weight class 400/);
  });

  it('admits a bold face whose wght default and OS/2 weight are both 700', () => {
    const metrics = parseFontMetrics(nativeFontFixture({
      variable: true, bold: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 700, max: 900 }],
      variableInstances: [{ coordinates: [700], name: 'Bold' }],
    }));
    expect(metrics.variable).toBe(true); expect(metrics.bold).toBe(true);
    expect(metrics.advances).toEqual(parseFontMetrics(nativeFontFixture({ bold: true })).advances);
  });

  it('refuses a non-normal wdth default', () => {
    const font = nativeFontFixture({
      variable: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 400, max: 700 }, { tag: 'wdth', min: 50, value: 75, max: 150 }],
      variableInstances: [{ coordinates: [400, 75], name: 'Regular' }],
    });
    expect(() => parseFontMetrics(font)).toThrow(/default width 75/);
  });

  it('refuses a variable optical-size axis (no request can name an optical size)', () => {
    const font = nativeFontFixture({
      variable: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 400, max: 700 }, { tag: 'opsz', min: 8, value: 14, max: 100 }],
      variableInstances: [{ coordinates: [400, 14], name: 'Regular' }],
    });
    expect(() => parseFontMetrics(font)).toThrow(/optical-size axis/);
  });

  it('admits a degenerate optical-size axis that cannot vary (min = default = max)', () => {
    const metrics = parseFontMetrics(nativeFontFixture({
      variable: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 400, max: 700 }, { tag: 'opsz', min: 14, value: 14, max: 14 }],
      variableInstances: [{ coordinates: [400, 14], name: 'Regular' }],
    }));
    expect(metrics.variable).toBe(true);
  });

  it('refuses an ital axis default that contradicts the upright face', () => {
    const font = nativeFontFixture({
      variable: true,
      variableAxes: [{ tag: 'wght', min: 300, value: 400, max: 700 }, { tag: 'ital', min: 0, value: 1, max: 1 }],
      variableInstances: [{ coordinates: [400, 1], name: 'Regular' }],
    });
    expect(() => parseFontMetrics(font)).toThrow(/ital axis default/);
  });

  it('refuses a named instance at the default coordinates whose name contradicts the face subfamily', () => {
    const font = nativeFontFixture({
      variable: true,
      variableInstances: [{ coordinates: [400, 100], name: 'Medium' }, { coordinates: [700, 75], name: 'Bold Condensed' }],
    });
    expect(() => parseFontMetrics(font)).toThrow(/named instance "Medium" .*default coordinates/);
  });

  it('refuses the wght=500 default through the production PDF reader as well', async () => {
    const program = Buffer.from(pdfFontFixture({ variable: true }).bytes);
    const fvar = fontTable(program, 'fvar'), os2 = fontTable(program, 'OS/2'), instancesAt = fvar.offset + 16 + 2 * 20;
    program.writeUInt16BE(500, os2.offset + 4);
    program.writeInt32BE(500 * 65536, fvar.offset + 16 + 8);
    program.writeInt32BE(500 * 65536, instancesAt + 4);
    const fontsDirectory = await writeFont(program);
    await expect(readWindowsPdfFont({ font: 'fixturevar.ttf' }, { fontsDirectory })).rejects.toThrow(/default weight 500/);
  });

  it('admits a named instance at the default coordinates named by the typographic subfamily', () => {
    const metrics = parseFontMetrics(nativeFontFixture({
      variable: true,
      variableInstances: [{ coordinates: [400, 100], name: 'Regular Typographic' }, { coordinates: [700, 75], name: 'Bold Condensed' }],
    }));
    expect(metrics.variable).toBe(true);
  });
});

describe('genuine gvar variation data (12.6a correction)', () => {
  // A small independent gvar reader/interpolator, written against the OpenType spec rather
  // than the fixture builder, so the fixture's variation data is cross-checked by a second
  // implementation. fontTools performs the same check externally (validation artifacts).
  interface GvarAxis { tag: string; min: number; value: number; max: number }
  function gvarModel(program: Buffer) {
    const fvar = fontTable(program, 'fvar');
    const axes: GvarAxis[] = [];
    const axisCount = program.readUInt16BE(fvar.offset + 8);
    for (let axis = 0; axis < axisCount; axis++) {
      const at = fvar.offset + 16 + axis * 20, fixed = (offset: number) => program.readInt32BE(at + offset) / 65536;
      axes.push({ tag: program.toString('ascii', at, at + 4), min: fixed(4), value: fixed(8), max: fixed(12) });
    }
    const gvar = fontTable(program, 'gvar'), data = program.subarray(gvar.offset, gvar.offset + gvar.length);
    const header = {
      axisCount: data.readUInt16BE(4), sharedTupleCount: data.readUInt16BE(6), sharedTuplesOffset: data.readUInt32BE(8),
      glyphCount: data.readUInt16BE(12), flags: data.readUInt16BE(14), dataOffset: data.readUInt32BE(16),
    };
    const sharedTuples: number[][] = [];
    for (let tuple = 0; tuple < header.sharedTupleCount; tuple++) {
      const coords: number[] = [];
      for (let axis = 0; axis < header.axisCount; axis++) coords.push(data.readInt16BE(header.sharedTuplesOffset + tuple * header.axisCount * 2 + axis * 2) / 16384);
      sharedTuples.push(coords);
    }
    const offsetsAt = 20; // the offsets array immediately follows the 20-byte header
    const readOffset = (glyph: number) => header.flags & 1 ? data.readUInt32BE(offsetsAt + glyph * 4) : data.readUInt16BE(offsetsAt + glyph * 2) * 2;
    const readPoints = (block: Buffer, at: number): [number[], number] => {
      let count = block[at++]!;
      if (!count) { count = block.readUInt16BE(at); at += 2; }
      const points: number[] = [];
      while (points.length < count) {
        const control = block[at++]!, words = control & 0x80, run = (control & 0x7f) + 1;
        for (let i = 0; i < run; i++) { points.push((points[points.length - 1] ?? 0) + (words ? block.readUInt16BE(at) : block[at]!)); at += words ? 2 : 1; }
      }
      return [points, at];
    };
    const readDeltas = (block: Buffer, at: number, count: number): [number[], number] => {
      const deltas: number[] = [];
      while (deltas.length < count) {
        const control = block[at++]!, run = (control & 0x3f) + 1;
        if (control & 0x80) for (let i = 0; i < run; i++) deltas.push(0);
        else if (control & 0x40) { for (let i = 0; i < run; i++) { deltas.push(block.readInt16BE(at)); at += 2; } }
        else { for (let i = 0; i < run; i++) { deltas.push(block.readInt8(at)); at += 1; } }
      }
      return [deltas, at];
    };
    /** Varied (advance, bounds) for a 4-point simple glyph: outline points are the box corners, phantom points follow (advance = pp2.x - pp1.x over the hmtx advance). */
    function vary(glyph: number, baseAdvance: number, baseBox: readonly number[], userCoords: Readonly<Record<string, number>>) {
      const normalized = axes.map((axis) => {
        const value = userCoords[axis.tag] ?? axis.value;
        return value < axis.value ? (value - axis.value) / (axis.value - axis.min) : (value - axis.value) / (axis.max - axis.value);
      });
      const block = data.subarray(header.dataOffset + readOffset(glyph), header.dataOffset + readOffset(glyph + 1));
      const points: [number, number][] = [[baseBox[0]!, baseBox[1]!], [baseBox[2]!, baseBox[1]!], [baseBox[2]!, baseBox[3]!], [baseBox[0]!, baseBox[3]!], [0, 0], [baseAdvance, 0], [0, 0], [0, 0]];
      if (!block.length) return { advance: baseAdvance, box: [...baseBox] };
      const tupleCount = block.readUInt16BE(0) & 0x3fff, dataAt = block.readUInt16BE(2);
      let headerAt = 4, segmentAt = dataAt;
      const headers: { size: number; flags: number; peak?: number[] }[] = [];
      for (let tuple = 0; tuple < tupleCount; tuple++) {
        const size = block.readUInt16BE(headerAt), flags = block.readUInt16BE(headerAt + 2);
        const entry: { size: number; flags: number; peak?: number[] } = { size, flags };
        let at = headerAt + 4;
        if (flags & 0x8000) { entry.peak = axes.map((_, axis) => block.readInt16BE(at + axis * 2) / 16384); at += axes.length * 2; }
        if (flags & 0x4000) at += axes.length * 4;
        headers.push(entry); headerAt = at;
      }
      // Shared point numbers, when the count word flags them, sit at the data offset ahead
      // of the first tuple segment; the fixture's tuples all carry private point numbers.
      let sharedPoints: number[] | null = null;
      if (block.readUInt16BE(0) & 0x8000) [sharedPoints, segmentAt] = readPoints(block, dataAt);
      for (const entry of headers) {
        const peak = entry.peak ?? sharedTuples[entry.flags & 0xfff]!;
        let scalar = 1;
        axes.forEach((_, axis) => {
          const p = peak[axis]!, c = normalized[axis]!;
          const start = p < 0 ? p : 0, end = p > 0 ? p : 0;
          let factor: number;
          if (p === 0) factor = 1; // a zero peak coordinate leaves this axis neutral
          else if (c < start || c > end) factor = 0;
          else if (c === p) factor = 1;
          else if (c < p) factor = (c - start) / (p - start);
          else factor = (end - c) / (end - p);
          scalar *= factor;
        });
        let at = segmentAt;
        let tuplePoints: number[];
        if (entry.flags & 0x2000) [tuplePoints, at] = readPoints(block, at);
        else if (sharedPoints) tuplePoints = sharedPoints;
        else tuplePoints = points.map((_, index) => index);
        const [xDeltas, afterX] = readDeltas(block, at, tuplePoints.length);
        const [yDeltas] = readDeltas(block, afterX, tuplePoints.length);
        tuplePoints.forEach((point, index) => { points[point]![0] += scalar * xDeltas[index]!; points[point]![1] += scalar * yDeltas[index]!; });
        segmentAt += entry.size;
      }
      const outline = points.slice(0, 4);
      return {
        advance: points[5]![0] - points[4]![0],
        box: [Math.min(...outline.map((p) => p[0])), Math.min(...outline.map((p) => p[1])), Math.max(...outline.map((p) => p[0])), Math.max(...outline.map((p) => p[1]))],
      };
    }
    return { axes, header, vary };
  }

  it('carries a genuine 20-byte gvar header consistent with fvar and maxp', () => {
    const program = nativeFontFixture({ variable: true }), model = gvarModel(program);
    expect(model.header.axisCount).toBe(2);
    expect(model.header.axisCount).toBe(model.axes.length);
    expect(model.header.glyphCount).toBe(5);
    expect(model.header.glyphCount).toBe(program.readUInt16BE(fontTable(program, 'maxp').offset + 4));
    expect(model.header.sharedTuplesOffset).toBeGreaterThanOrEqual(20);
    expect(model.header.sharedTuplesOffset + model.header.sharedTupleCount * model.header.axisCount * 2).toBeLessThanOrEqual(model.header.dataOffset);
    expect(model.header.dataOffset).toBeLessThan(fontTable(program, 'gvar').length);
    expect(model.header.sharedTupleCount).toBe(1);
    const loca = fontTable(program, 'loca').offset, glyf = fontTable(program, 'glyf').offset;
    for (const glyph of [2, 3]) {
      const start = glyf + program.readUInt32BE(loca + glyph * 4);
      expect(program.readInt16BE(start)).toBe(1);
      expect(program.readUInt16BE(start + 10) + 1 + 4).toBe(8); // four outline points plus four phantom points
    }
  });

  it('leaves the default instance exact and moves advances/bounds measurably at nondefault coordinates', () => {
    const program = nativeFontFixture({ variable: true }), model = gvarModel(program);
    // Glyph 2 is 'A' (advance 650, box [-20, 0, 620, 730]); glyph 3 is 'B' (650, [40, 0, 600, 700]).
    expect(model.vary(2, 650, [-20, 0, 620, 730], {})).toEqual({ advance: 650, box: [-20, 0, 620, 730] });
    expect(model.vary(3, 650, [40, 0, 600, 700], {})).toEqual({ advance: 650, box: [40, 0, 600, 700] });
    expect(model.vary(2, 650, [-20, 0, 620, 730], { wght: 700 })).toEqual({ advance: 770, box: [10, 0, 680, 730] });
    expect(model.vary(3, 650, [40, 0, 600, 700], { wght: 700 })).toEqual({ advance: 650, box: [90, 0, 690, 700] });
    expect(model.vary(2, 650, [-20, 0, 620, 730], { wdth: 75 }).advance).toBe(570);
    expect(model.vary(2, 650, [-20, 0, 620, 730], { wdth: 50 }).advance).toBe(490);
    expect(model.vary(2, 650, [-20, 0, 620, 730], { wght: 700, wdth: 50 }).advance).toBe(610);
  });
});

describe('renderer-side PDF validation of variable fonts (12.6 slice 1a)', () => {
  const face = (options: Parameters<typeof pdfFontFixture>[0] = {}): PdfFontFace => ({ key: 'fixture', ...pdfFontFixture(options) });

  it('admits a well-formed variable face and encodes its glyphs', () => {
    const variable = face({ variable: true }), registry = new PdfFontRegistry([variable]);
    expect(registry.rejections.get('fixture')).toBeUndefined();
    expect(Buffer.from(registry.face('fixture')!.bytes).equals(Buffer.from(variable.bytes))).toBe(true);
    expect(registry.face('fixture')!.metrics.variable).toBe(true);
    const run = registry.encode('fixture', 'AB');
    expect(run).not.toBeNull(); expect(run!.glyphs).toEqual([2, 3]);
  });

  it('refuses forged metrics that hide the variable program', () => {
    const variable = face({ variable: true });
    const forged: PdfFontFace = { ...variable, metrics: { ...variable.metrics, variable: undefined } };
    expect(() => new PdfFontRegistry([forged])).toThrow('variable metadata does not match the program');
    const statik = face();
    const forgedStatic: PdfFontFace = { ...statik, metrics: { ...statik.metrics, variable: true } };
    expect(() => new PdfFontRegistry([forgedStatic])).toThrow('variable metadata does not match the program');
  });

  it('rejects a variable face whose fvar table is malformed, naming the variable format', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    bytes.writeUInt16BE(0x7fff, fontTable(bytes, 'fvar').offset + 8);
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/variable/);
    expect(registry.encode('fixture', 'A')).toBeNull();
  });

  it('still rejects color tables on a variable face', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    bytes.write('COLR', fontTable(bytes, 'post').record, 'ascii');
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/bitmap|color/);
  });

  it('rejects instanceSize = axisCount*4 + 5 (writer layer)', () => {
    const variable = face({ variable: true, variableInstances: [{ coordinates: [400, 100], name: 'Regular' }] }), bytes = Buffer.from(variable.bytes);
    bytes.writeUInt16BE(13, fontTable(bytes, 'fvar').offset + 14);
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/instance record size/);
    expect(registry.encode('fixture', 'A')).toBeNull();
  });

  it('rejects an instance subfamily name ID with no name table record (writer layer)', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    bytes.writeUInt16BE(999, fontTable(bytes, 'fvar').offset + 16 + 2 * 20);
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/instance subfamily name ID 999/);
  });

  it('rejects an axis name ID with no name table record (writer layer)', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    bytes.writeUInt16BE(999, fontTable(bytes, 'fvar').offset + 16 + 18);
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/axis name ID 999/);
  });

  it('rejects a default weight of 500 claimed as a regular face (writer layer)', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    const fvar = fontTable(bytes, 'fvar'), instancesAt = fvar.offset + 16 + 2 * 20;
    bytes.writeUInt16BE(500, fontTable(bytes, 'OS/2').offset + 4);
    bytes.writeInt32BE(500 * 65536, fvar.offset + 16 + 8);
    bytes.writeInt32BE(500 * 65536, instancesAt + 4);
    const registry = new PdfFontRegistry([{ ...variable, bytes, weight: 500 }]);
    expect(registry.rejections.get('fixture')).toMatch(/default weight 500/);
  });

  it('rejects a named instance at the default coordinates that contradicts the subfamily (writer layer)', () => {
    const variable = face({ variable: true }), bytes = Buffer.from(variable.bytes);
    // Legal instance name ID 259 resolves to "Bold Condensed", contradicting the
    // regular default. Keep this separate from the illegal-ID range checks.
    bytes.writeUInt16BE(259, fontTable(bytes, 'fvar').offset + 16 + 2 * 20);
    const registry = new PdfFontRegistry([{ ...variable, bytes }]);
    expect(registry.rejections.get('fixture')).toMatch(/named instance .*default coordinates/);
  });
});

describe('variable font end-to-end PDF (12.6 slice 1a)', () => {
  const style = (name = 'FACE', font = 'arial.ttf') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
  const text = (id = 'text'): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left' });
  function page(entities: readonly Entity[]): PdfPageSpec {
    return { width: 300, height: 200, label: 'Sheet', groups: [{ entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
  }
  function embeddedPrograms(info: PdfBasics) { return [...info.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!); }
  function unicodeText(info: PdfBasics) { return [...info.objects.values()].filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap')).map((object) => new TextDecoder().decode(object.stream)).join('\n'); }

  it('embeds the whole variable program unchanged and keeps Unicode extraction', async () => {
    const program = pdfFontFixture({ variable: true });
    const reader: PdfFontReader = async () => ({ font: program });
    const doc = new Drawing({ entities: [text()], meta: { textStyles: { FACE: style() } } });
    const result = await capturedPdfLookup(doc.snapshot, reader);
    expect(result.issues).toEqual([]);
    const context = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set<string>() };
    const pdf = parsePdfBasics(await vectorPdfCompressed([page(doc.entities)], context, { mode: 'color', lineweights: true, usePlotStyles: false }, 'Variable', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]);
    expect(embeddedPrograms(pdf)).toEqual([new Uint8Array(program.bytes)]);
    expect(unicodeText(pdf)).toContain('<0001> <0041>\n<0002> <0042>');
    // The embedded program still carries its fvar table: PDF consumers render the
    // default instance, which is exactly what the native metrics measured.
    expect(fontTable(Buffer.from(embeddedPrograms(pdf)[0]!), 'fvar').length).toBeGreaterThan(0);
    expect(doc.dirty).toBe(false);
  });

  it('embeds the extracted nonzero-index collection face for a plot whose used set includes a supplementary scalar', async () => {
    const statik = Buffer.from(pdfFontFixture({ family: 'Collection Static' }).bytes);
    const variable = Buffer.from(pdfFontFixture({ variable: true }).bytes); // family Arial, the family the FACE style names
    const collection = fontCollection(statik, variable), extracted = extractTtcFace(collection, 1);
    const directory = await writeFont(collection, 'collection.ttc');
    const face = await readWindowsPdfFont({ font: 'collection.ttc', family: 'Arial', bold: false, italic: false, usedCodepoints: [0x41, 0x20000, 0x42] }, { fontsDirectory: directory });
    const reader: PdfFontReader = async () => ({ font: face });
    const entity: TextEntity = { ...text(), text: 'A\u{20000}B' };
    const doc = new Drawing({ entities: [entity], meta: { textStyles: { FACE: style() } } });
    const result = await capturedPdfLookup(doc.snapshot, reader);
    expect(result.issues).toEqual([]);
    const context = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set<string>() };
    const pdf = parsePdfBasics(await vectorPdfCompressed([page(doc.entities)], context, { mode: 'color', lineweights: true, usePlotStyles: false }, 'VariableTTC', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]);
    expect(embeddedPrograms(pdf)).toEqual([new Uint8Array(extracted)]);
    expect(unicodeText(pdf)).toContain('<0002> <D840DC00>');
    expect(doc.dirty).toBe(false);
  });
});
