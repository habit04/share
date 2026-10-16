import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import type { TextEntity } from '../src/core/entities';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { drawingContext, vectorPdf, type PdfPageSpec } from '../src/io/pdf-vector';
import { PdfFontRegistry, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';
import { embeddableFontProgram } from '../src/io/pdf-font-subset';
import { fontCollection, fontTable } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { parsePdfBasics } from './helpers/pdf';

type Request = { font: string; family?: string; bold?: boolean; italic?: boolean; usedCodepoints?: readonly number[] };
type SelectedMetrics = NativeFontMetrics & { faceIndex: number; resolvedFilename: string };
const require = createRequire(import.meta.url);
const { parseFontMetrics, readWindowsFontData, readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Uint8Array): NativeFontMetrics;
  readWindowsFontData(request: Request, options: { fontsDirectory: string }): Promise<{ bytes: Uint8Array; metrics: SelectedMetrics }>;
  readWindowsFontMetrics(request: Request, options: { fontsDirectory: string }): Promise<SelectedMetrics>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options: { fontsDirectory: string }): Promise<Omit<PdfFontFace, 'key'>>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as { extractTtcFace(bytes: Uint8Array, index: number): Uint8Array };

const roots: string[] = [];
async function install(bytes: Uint8Array) {
  const fontsDirectory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-variable-composition-'));
  roots.push(fontsDirectory);
  await fs.writeFile(path.join(fontsDirectory, 'collection.ttc'), bytes);
  return { fontsDirectory };
}
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (!relative.startsWith('jcad-variable-composition-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected variable composition cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
const request: Request = { font: 'collection.ttc', family: 'Collection Variable', bold: false, italic: false, usedCodepoints: [65, 66] };
function collection(fsType = 8) {
  return fontCollection(Buffer.from(pdfFontFixture({ family: 'Collection Static' }).bytes), Buffer.from(pdfFontFixture({ family: 'Collection Variable', variable: true, fsType }).bytes));
}
function output(registry: PdfFontRegistry) {
  const entries = new Map<number, string | Uint8Array[]>();
  let id = 0;
  const writer: PdfFontObjectWriter = { reserve: () => ++id, set: (index, body) => { expect(entries.has(index)).toBe(false); entries.set(index, body); } };
  writePdfFontResources(registry, writer);
  const bodies = [...entries.values()];
  return {
    dictionaries: bodies.filter((body): body is string => typeof body === 'string'),
    streams: bodies.filter((body): body is Uint8Array[] => Array.isArray(body)),
  };
}

describe('variable fonts compose with selected TTC faces and captured used glyphs', () => {
  it('reads the original TTC, selects face 1 and validates only captured AB glyphs', async () => {
    const source = collection(), options = await install(source);
    const selected = await readWindowsFontData(request, options);
    expect(selected.bytes).toEqual(source);
    expect(selected.metrics).toMatchObject({ faceIndex: 1, family: 'Collection Variable', variable: true, bold: false, italic: false });
    expect(selected.metrics.glyphBoundsKnown?.slice(2, 5)).toEqual([true, true, false]);
    const face = await readWindowsPdfFont(request, options);
    expect(face.metrics).toEqual(selected.metrics);
    expect(face.bytes).toEqual(extractTtcFace(source, 1));
    expect(face.bytes).not.toEqual(extractTtcFace(source, 0));
    const registry = new PdfFontRegistry([{ ...face, key: 'variable' }]);
    expect(registry.rejections.size).toBe(0);
    expect(registry.encode('variable', 'AB')?.glyphs).toEqual([2, 3]);
    expect(registry.encode('variable', 'A\u{20000}B')).toBeNull();
  });

  it('admits the supplementary GID only when the captured used set includes it', async () => {
    const source = collection(), options = await install(source);
    const face = await readWindowsPdfFont({ ...request, usedCodepoints: [65, 66, 0x20000] }, options);
    expect(face.metrics.glyphBoundsKnown?.[4]).toBe(true);
    const registry = new PdfFontRegistry([{ ...face, key: 'variable' }]);
    expect(registry.encode('variable', 'A\u{20000}B')?.glyphs).toEqual([2, 4, 3]);
    const screen = await readWindowsFontMetrics(request, options);
    expect(screen.faceIndex).toBe(1);
    expect(screen.glyphBoundsKnown?.[4]).toBe(true);
  });

  it.each([8, 0x108])('keeps whole variable bytes, names, widths and Unicode with fsType %i', async (fsType) => {
    const source = collection(fsType), options = await install(source);
    const face = await readWindowsPdfFont({ ...request, usedCodepoints: [65, 66, 0x20000] }, options);
    expect(embeddableFontProgram(face.bytes, new Set([2, 3, 4]))).toBe(face.bytes);
    const registry = new PdfFontRegistry([{ ...face, key: 'variable' }]);
    expect(registry.encode('variable', 'A\u{20000}B')?.hex).toBe('000100020003');
    const written = output(registry), decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const fontFile = written.streams.find((body) => decode(body[0]!).includes('/Length1'))!;
    expect(fontFile[1]).toBe(registry.face('variable')!.bytes);
    expect(fontFile[1]).toEqual(new Uint8Array(face.bytes));
    const parent = written.dictionaries.find((body) => body.includes('/Subtype /Type0'))!;
    expect(parent).toContain(`/BaseFont /${face.postscriptName} `);
    expect(parent).not.toMatch(/[A-Z]{6}\+/);
    const descendant = written.dictionaries.find((body) => body.includes('/Subtype /CIDFontType2'))!;
    expect(descendant).toContain('/W [1 [650 650 650]]');
    expect(written.streams.some((body) => decode(body[1]!).includes('<0002> <D840DC00>'))).toBe(true);
    expect(written.streams.some((body) => Buffer.from(body[1]!).equals(Buffer.from([0, 0, 0, 2, 0, 4, 0, 3])))).toBe(true);
  });

  it.each([8, 0x108])('preserves static subsetting and no-subsetting behavior with fsType %i', (fsType) => {
    const face = pdfFontFixture({ fsType }), registry = new PdfFontRegistry([{ ...face, key: 'static' }]);
    expect(registry.encode('static', 'AB')).not.toBeNull();
    const written = output(registry), parent = written.dictionaries.find((body) => body.includes('/Subtype /Type0'))!;
    const fontFile = written.streams.find((body) => new TextDecoder().decode(body[0]).includes('/Length1'))!;
    if (fsType & 0x100) {
      expect(parent).toContain(`/BaseFont /${face.postscriptName} `);
      expect(fontFile[1]).toEqual(new Uint8Array(face.bytes));
    } else {
      expect(parent).toContain(`/BaseFont /AAAAAA+${face.postscriptName} `);
      expect(fontFile[1]!.length).toBeLessThan(face.bytes.length);
    }
  });

  it('refuses selected-face permissions and an unavailable bold style without choosing face 0', async () => {
    const options = await install(collection(2));
    await expect(readWindowsPdfFont(request, options)).rejects.toThrow('restricted font embedding');
    await expect(readWindowsPdfFont({ ...request, bold: true }, options)).rejects.toThrow(/style|match/);
  });

  it('captures the final family and used scalars through the real reader without changing the drawing', async () => {
    const source = collection(), options = await install(source), seen: Request[] = [];
    const reader: PdfFontReader = async (wanted) => {
      seen.push({ ...wanted, usedCodepoints: wanted.usedCodepoints && [...wanted.usedCodepoints] });
      return { font: await readWindowsPdfFont(wanted, options) };
    };
    const entity: TextEntity = { id: 'text', type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'A\u{20000}B', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left' };
    const doc = new Drawing({ entities: [entity], meta: { textStyles: { FACE: { name: 'FACE', font: 'collection.ttc', family: 'Collection Variable', bold: false, italic: false, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 } } } });
    const before = doc.snapshot, serialized = JSON.stringify(before);
    const captured = await capturedPdfLookup(doc.snapshot, reader);
    expect(captured.issues).toEqual([]);
    expect(seen).toEqual([{ font: 'collection.ttc', family: 'Collection Variable', bold: false, italic: false, usedCodepoints: [65, 66, 0x20000] }]);
    expect(captured.fonts).toBeDefined();
    expect(captured.fonts!.rejections.size).toBe(0);
    const page: PdfPageSpec = { width: 300, height: 200, label: 'Sheet', groups: [{ entities: doc.entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
    const context = { ...drawingContext(doc.snapshot, captured.lookup), embeddedFonts: captured.fonts, textGeometry: captured.geometry, fontFallbacks: new Set<string>() };
    const parsed = parsePdfBasics(vectorPdf([page], context, { mode: 'color', lineweights: true, usePlotStyles: false }, 'Variable composition'));
    expect(parsed.errors).toEqual([]);
    const embedded = [...parsed.objects.values()].find((object) => object.dict.includes('/Length1'))!.stream!;
    expect(embedded).toEqual(new Uint8Array(extractTtcFace(source, 1)));
    expect(captured.fonts!.resources()).toHaveLength(1);
    expect(captured.fonts!.resources()[0]!.face.metrics).toMatchObject({ faceIndex: 1, variable: true });
    expect([...parsed.objects.values()].some((object) => object.stream && new TextDecoder().decode(object.stream).includes('<0002> <D840DC00>'))).toBe(true);
    expect(doc.snapshot).toBe(before); expect(JSON.stringify(doc.snapshot)).toBe(serialized); expect(doc.dirty).toBe(false);
  });
});

function renameNameId(bytes: Buffer, prior: number, next: number) {
  const name = fontTable(bytes, 'name').offset;
  let found = false;
  for (let i = 0; i < bytes.readUInt16BE(name + 2); i++) {
    const at = name + 6 + i * 12 + 6;
    if (bytes.readUInt16BE(at) === prior) { bytes.writeUInt16BE(next, at); found = true; }
  }
  expect(found).toBe(true);
}
function checksums(bytes: Buffer) {
  const sum = (data: Buffer) => {
    let result = 0;
    for (let at = 0; at < data.length; at += 4) {
      let word = 0;
      for (let part = 0; part < 4; part++) word = (word * 256 + (data[at + part] ?? 0)) >>> 0;
      result = (result + word) >>> 0;
    }
    return result;
  };
  const head = fontTable(bytes, 'head').offset;
  bytes.writeUInt32BE(0, head + 8);
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const at = 12 + i * 16, offset = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    bytes.writeUInt32BE(sum(bytes.subarray(offset, offset + length)), at + 4);
  }
  bytes.writeUInt32BE((0xb1b0afba - sum(bytes)) >>> 0, head + 8);
  expect(sum(bytes)).toBe(0xb1b0afba);
}
type Mutation = (bytes: Buffer, axisAt: number, instanceAt: number, instanceSize: number) => void;
const idCases: readonly [string, Mutation][] = [
  ['axis ID 2', (bytes, axis) => bytes.writeUInt16BE(2, axis + 18)],
  ['axis ID 32768', (bytes, axis) => { renameNameId(bytes, 256, 32768); bytes.writeUInt16BE(32768, axis + 18); }],
  ['instance subfamily ID 1', (bytes, _axis, instance, size) => bytes.writeUInt16BE(1, instance + size)],
  ['instance subfamily ID 32768', (bytes, _axis, instance, size) => { renameNameId(bytes, 259, 32768); bytes.writeUInt16BE(32768, instance + size); }],
  ['instance PostScript ID 1', (bytes, _axis, instance, size) => bytes.writeUInt16BE(1, instance + size + 12)],
  ['instance PostScript ID 32768', (bytes, _axis, instance, size) => { renameNameId(bytes, 261, 32768); bytes.writeUInt16BE(32768, instance + size + 12); }],
];
function namedVariable() {
  return pdfFontFixture({ variable: true, variableInstances: [{ coordinates: [400, 100], name: 'Regular' }, { coordinates: [700, 75], name: 'Bold Condensed', psName: 'JCadBoldCondensed' }] });
}
function mutated(change: Mutation) {
  const face = namedVariable(), bytes = Buffer.from(face.bytes), fvar = fontTable(bytes, 'fvar').offset;
  change(bytes, fvar + bytes.readUInt16BE(fvar + 4), fvar + bytes.readUInt16BE(fvar + 4) + bytes.readUInt16BE(fvar + 8) * 20, bytes.readUInt16BE(fvar + 14));
  checksums(bytes);
  return { ...face, bytes, key: 'variable' };
}

describe('fvar name IDs must be legal for their record role, as well as present', () => {
  it.each(idCases)('refuses an existing but illegal %s in both validators', (_name, change) => {
    const face = mutated(change);
    expect(() => parseFontMetrics(face.bytes)).toThrow(/invalid variable font .*name ID/);
    const registry = new PdfFontRegistry([face]);
    expect(registry.rejections.get('variable')).toMatch(/invalid variable font .*name ID/);
    expect(registry.face('variable')).toBeUndefined(); expect(registry.encode('variable', 'AB')).toBeNull();
  });

  it.each([2, 17])('admits legal default subfamily name ID %i', (id) => {
    const face = mutated((bytes, _axis, instance) => bytes.writeUInt16BE(id, instance));
    expect(parseFontMetrics(face.bytes).variable).toBe(true);
    expect(new PdfFontRegistry([face]).rejections.size).toBe(0);
  });

  it('admits legal upper-bound custom IDs and the special PostScript ID 6', () => {
    for (const change of [
      (bytes: Buffer, axis: number) => { renameNameId(bytes, 256, 32767); bytes.writeUInt16BE(32767, axis + 18); },
      (bytes: Buffer, _axis: number, instance: number, size: number) => { renameNameId(bytes, 259, 32767); bytes.writeUInt16BE(32767, instance + size); },
      (bytes: Buffer, _axis: number, instance: number, size: number) => { renameNameId(bytes, 261, 32767); bytes.writeUInt16BE(32767, instance + size + 12); },
      (bytes: Buffer, _axis: number, instance: number, size: number) => bytes.writeUInt16BE(6, instance + size + 12),
    ]) {
      const face = mutated(change);
      expect(parseFontMetrics(face.bytes).variable).toBe(true);
      expect(new PdfFontRegistry([face]).rejections.size).toBe(0);
    }
  });
});
