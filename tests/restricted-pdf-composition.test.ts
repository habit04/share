/** Authored programs only. These tests cover font composition, not qpdf/native viewer acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Drawing } from '../src/core/document';
import type { BlockLookup, Entity, TextEntity } from '../src/core/entities';
import type { FontMetricsRequest, NativeFontMetrics } from '../src/core/text-metrics';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { PdfFontRegistry, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';
import { drawingContext, vectorPdf, type PdfPageSpec } from '../src/io/pdf-vector';
import { embeddableFontProgram } from '../src/io/pdf-font-subset';
import { DrawingShxResources } from '../src/render/drawing-shx';
import { cffFontFixture, cffPdfFontFixture } from './helpers/cff-font-fixture';
import { fontCollection, fontTable } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { dictValue, parsePdfBasics } from './helpers/pdf';
import { fontRecords, shxFixture } from './helpers/shx-fixture';

const require = createRequire(import.meta.url);
type ReaderFace = Omit<PdfFontFace, 'key'> & { previewPrint?: boolean };
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: FontMetricsRequest, options: { fontsDirectory: string }): Promise<ReaderFace>;
};
const { readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  readWindowsFontMetrics(request: FontMetricsRequest, options: { fontsDirectory: string }): Promise<NativeFontMetrics>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(bytes: Uint8Array, index: number): Uint8Array;
};
type Host = { read(value: unknown): Promise<unknown>; readPdf(value: unknown): Promise<unknown>; admittedPreviewPrint(value: unknown): boolean; dispose(): Promise<void> };
const { createFontMetricsHost } = require('../electron/font-metrics-host.cjs') as {
  createFontMetricsHost(options: { workerFactory: (request: FontMetricsRequest & { usage?: string }) => FakeWorker }): Host;
};

// Always confine authored files to this worktree, even when TEMP is shared.
const FONT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.codex-local/p12-2308000-review/composition-fixtures');
const roots: string[] = [], hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const directory of roots.splice(0)) {
    const relative = path.relative(FONT_ROOT, directory);
    if (!relative.startsWith('case-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected restricted-font fixture path');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function install(bytes: Uint8Array, filename = 'collection.ttc') {
  await fs.mkdir(FONT_ROOT, { recursive: true });
  const fontsDirectory = await fs.mkdtemp(path.join(FONT_ROOT, 'case-')); roots.push(fontsDirectory);
  await fs.writeFile(path.join(fontsDirectory, filename), bytes);
  return { fontsDirectory };
}
/** Keep authored permission mutations otherwise valid SFNT programs. */
function refreshChecksums(bytes: Buffer) {
  const checksum = (data: Buffer) => {
    let sum = 0;
    for (let at = 0; at < data.length; at += 4) {
      let word = 0;
      for (let part = 0; part < 4; part++) word = (word * 256 + (data[at + part] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  const head = fontTable(bytes, 'head').offset; bytes.writeUInt32BE(0, head + 8);
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const at = 12 + i * 16, start = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    bytes.writeUInt32BE(checksum(bytes.subarray(start, start + length)), at + 4);
  }
  bytes.writeUInt32BE((0xb1b0afba - checksum(bytes)) >>> 0, head + 8);
}
function output(registry: PdfFontRegistry) {
  const entries = new Map<number, string | Uint8Array[]>();
  let id = 0;
  const writer: PdfFontObjectWriter = { reserve: () => ++id, set: (index, body) => { expect(entries.has(index)).toBe(false); entries.set(index, body); } };
  writePdfFontResources(registry, writer);
  return {
    dictionaries: [...entries.values()].filter((body): body is string => typeof body === 'string'),
    streams: [...entries.values()].filter((body): body is Uint8Array[] => Array.isArray(body)),
  };
}
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const request: FontMetricsRequest = { font: 'collection.ttc', family: 'Preview Fixture', bold: false, italic: false, usedCodepoints: [65, 66], restricted: true };
const unsupportedCffCases: [string, Record<string, Buffer>, RegExp][] = [
  ['variable CFF', { fvar: Buffer.alloc(16) }, /variable CFF/],
  ['CFF2', { CFF2: Buffer.alloc(8) }, /CFF2/],
  ['mixed outlines', { glyf: Buffer.alloc(0), loca: Buffer.alloc(4) }, /mixed CFF/],
];
function previewCollection(fsType = 4, variable = false) {
  return fontCollection(Buffer.from(pdfFontFixture({ family: 'Other Family', fsType: 2 }).bytes), Buffer.from(pdfFontFixture({ family: 'Preview Fixture', fsType, variable }).bytes));
}
function stable(doc: Drawing) {
  const snapshot = doc.snapshot, serialized = JSON.stringify(snapshot), history = doc.history(), dirty = doc.dirty;
  return () => { expect(doc.snapshot).toBe(snapshot); expect(JSON.stringify(doc.snapshot)).toBe(serialized); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(dirty); };
}
const style = (name = 'SHX', font = 'missing-source.shx') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const text = (id: string, extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'SHX', text: 'A中B', position: { x: 10, y: 20 }, height: 7.3, rotation: 0, align: 'left', ...extra });
const drawing = (entities: readonly Entity[] = [text('text')]) => new Drawing({ entities: [...entities], meta: { textStyles: { SHX: style(), OTHER: style('OTHER', 'other-missing.shx') } } });
function render(doc: Drawing, prepared: Awaited<ReturnType<typeof capturedPdfLookup>>) {
  const page: PdfPageSpec = { width: 300, height: 200, label: 'Restricted font composition', groups: [{ entities: doc.entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
  return vectorPdf([page], { ...drawingContext(doc.snapshot, prepared.lookup), textGeometry: prepared.geometry, embeddedFonts: prepared.fonts });
}

describe('restricted PDF composes with current TTC/used-glyph/resource handling', () => {
  it('reads the original TTC, preserves selected face 1 and refuses a mapped glyph outside its used seeds', async () => {
    const source = previewCollection(), before = Buffer.from(source), options = await install(source);
    await expect(readWindowsPdfFont({ ...request, restricted: false }, options)).rejects.toThrow('read-only PDF');
    const face = await readWindowsPdfFont(request, options);
    expect(face).toMatchObject({ outline: 'glyf', previewPrint: true, metrics: { family: 'Preview Fixture', faceIndex: 1, fsType: 4 } });
    expect(face.bytes).toEqual(extractTtcFace(source, 1)); expect(face.bytes).not.toEqual(extractTtcFace(source, 0));
    expect(face.metrics.glyphBoundsKnown?.slice(2, 5)).toEqual([true, true, false]);
    const fonts = new PdfFontRegistry([{ ...face, key: 'preview' }], { restricted: true });
    expect(fonts.rejections.size).toBe(0); expect(fonts.previewPrintKeys).toEqual(['preview']);
    expect(fonts.encode('preview', 'AB')?.glyphs).toEqual([2, 3]);
    expect(fonts.encode('preview', 'A\u{20000}B')).toBeNull();
    const screen = await readWindowsFontMetrics(request, options);
    expect(screen.faceIndex).toBe(1); expect(screen.glyphBoundsKnown?.[4]).toBe(true);
    expect(source).toEqual(before); expect(await fs.readFile(path.join(options.fontsDirectory, 'collection.ttc'))).toEqual(before);
  });

  it.each([4, 0x104])('preserves static subsetting/no-subsetting with preview fsType %i', async (fsType) => {
    const source = previewCollection(fsType), options = await install(source), face = await readWindowsPdfFont(request, options);
    const fonts = new PdfFontRegistry([{ ...face, key: 'preview' }], { restricted: true });
    expect(fonts.encode('preview', 'AB')).not.toBeNull();
    const written = output(fonts), parent = written.dictionaries.find((body) => body.includes('/Subtype /Type0'))!;
    const stream = written.streams.find((body) => decode(body[0]!).includes('/Length1'))!;
    if (fsType & 0x100) {
      expect(stream[1]).toBe(fonts.face('preview')!.bytes); expect(stream[1]).toEqual(new Uint8Array(face.bytes));
      expect(parent).toContain(`/BaseFont /${face.postscriptName} `); expect(parent).not.toMatch(/[A-Z]{6}\+/);
    } else {
      const subset = embeddableFontProgram(face.bytes, new Set([2, 3]));
      expect(subset).not.toBe(face.bytes); expect(stream[1]).toEqual(subset); expect(stream[1]!.length).toBeLessThan(face.bytes.length);
      expect(parent).toContain(`/BaseFont /AAAAAA+${face.postscriptName} `);
    }
    expect(fonts.previewPrintKeys).toEqual(['preview']);
  });

  it('keeps a selected default-variable preview face whole, including its live gvar program', async () => {
    const source = previewCollection(4, true), options = await install(source);
    const face = await readWindowsPdfFont({ ...request, usedCodepoints: [65, 66, 0x20000] }, options);
    expect(face.metrics).toMatchObject({ faceIndex: 1, variable: true });
    const original = extractTtcFace(source, 1), variation = fontTable(Buffer.from(original), 'gvar');
    expect(variation.length).toBeGreaterThan(20);
    expect(embeddableFontProgram(face.bytes, new Set([2, 3, 4]))).toBe(face.bytes);
    const fonts = new PdfFontRegistry([{ ...face, key: 'variable' }], { restricted: true });
    expect(fonts.encode('variable', 'A\u{20000}B')?.glyphs).toEqual([2, 4, 3]);
    const written = output(fonts), stream = written.streams.find((body) => decode(body[0]!).includes('/Length1'))!;
    expect(stream[1]).toBe(fonts.face('variable')!.bytes); expect(stream[1]).toEqual(new Uint8Array(original));
    expect(written.dictionaries.find((body) => body.includes('/Subtype /Type0'))).toContain(`/BaseFont /${face.postscriptName} `);
    expect(fonts.previewPrintKeys).toEqual(['variable']); expect(fonts.requiredVersion).toEqual([1, 4]);
  });

  it('retains CFF aliases, whole OpenType bytes and actual-used PDF 1.6 in restricted mode', async () => {
    const source = cffFontFixture({ family: 'CFF Preview', fsType: 4, alias: true }), before = Buffer.from(source);
    const options = await install(source, 'preview.otf'), wanted = { font: 'preview.otf', family: 'CFF Preview', restricted: true, usedCodepoints: [65, 66] };
    await expect(readWindowsPdfFont({ ...wanted, restricted: false }, options)).rejects.toThrow('read-only PDF');
    const face = await readWindowsPdfFont(wanted, options);
    expect(face).toMatchObject({ outline: 'cff', previewPrint: true }); expect(face.bytes).toEqual(source);
    const fonts = new PdfFontRegistry([{ ...face, key: 'cff' }], { restricted: true });
    expect(fonts.requiredVersion).toEqual([1, 4]);
    expect(fonts.encode('cff', 'AB')?.hex).toBe('00010002'); expect(fonts.encode('cff', 'BA')?.hex).toBe('00020001');
    expect(fonts.requiredVersion).toEqual([1, 6]); expect(fonts.previewPrintKeys).toEqual(['cff']);
    const written = output(fonts);
    expect(written.streams.some((body) => decode(body[0]!).includes('/Subtype /OpenType') && Buffer.from(body[1]!).equals(source))).toBe(true);
    expect(written.streams.some((body) => decode(body[1]!).includes('<0001> 2\n<0002> 2'))).toBe(true);
    expect(written.streams.some((body) => decode(body[1]!).includes('<0001> <0041>\n<0002> <0042>'))).toBe(true);
    expect(source).toEqual(before);
  });

  it.each(unsupportedCffCases)('does not widen unsupported %s admission in restricted mode', async (_name, extraTables, problem) => {
    const face = cffPdfFontFixture({ family: 'CFF Preview', fsType: 4 });
    const bytes = cffFontFixture({ family: 'CFF Preview', fsType: 4, extraTables });
    const options = await install(bytes, 'preview.otf');
    await expect(readWindowsPdfFont({ font: 'preview.otf', family: 'CFF Preview', restricted: true }, options)).rejects.toThrow(problem);
    const fonts = new PdfFontRegistry([{ ...face, bytes, key: 'cff' }], { restricted: true });
    expect(fonts.rejections.get('cff')).toMatch(problem); expect(fonts.previewPrintKeys).toEqual([]); expect(fonts.encode('cff', 'AB')).toBeNull();
  });

  it.each([
    [2, 2, /restricted font/], [0x0204, 2, /bitmap-only/], [1, 2, /reserved/], [0x10, 2, /reserved/], [6, 3, /conflicting/],
  ] as const)('retains native/writer refusal for fsType %i at OS/2 version %i', async (fsType, os2Version, problem) => {
    const face = pdfFontFixture({ fsType }), bytes = Buffer.from(face.bytes);
    bytes.writeUInt16BE(os2Version, fontTable(bytes, 'OS/2').offset);
    refreshChecksums(bytes);
    const options = await install(bytes, 'preview.ttf');
    await expect(readWindowsPdfFont({ font: 'preview.ttf', family: 'Arial', restricted: true }, options)).rejects.toThrow(problem);
    const forgedFace = { ...face, bytes, os2Version, key: 'bad', previewPrint: true };
    const fonts = new PdfFontRegistry([forgedFace], { restricted: true });
    expect(fonts.rejections.get('bad')).toMatch(problem); expect(fonts.previewPrintKeys).toEqual([]); expect(fonts.resources()).toEqual([]);
  });

  it('derives preview admission from actual permissions, with v2 precedence and editable controls', () => {
    const preview = { ...pdfFontFixture({ fsType: 6 }), key: 'preview', previewPrint: false };
    const editable = { ...pdfFontFixture({ fsType: 8 }), key: 'editable', previewPrint: true };
    const ordinary = new PdfFontRegistry([preview, editable]);
    expect(ordinary.rejections.get('preview')).toContain('read-only PDF'); expect(ordinary.previewPrintKeys).toEqual([]);
    expect(ordinary.face('editable')).toBeDefined();
    const restricted = new PdfFontRegistry([preview, editable], { restricted: true });
    expect(restricted.rejections.size).toBe(0); expect(restricted.previewPrintKeys).toEqual(['preview']);
    const forged = { ...preview, metrics: { ...preview.metrics, fsType: 8 } };
    expect(() => new PdfFontRegistry([forged], { restricted: true })).toThrow('permissions do not match');
  });

  it('combines restricted CFF aliases, static subsets and variable whole programs in one PDF', async () => {
    const cff = cffPdfFontFixture({ family: 'Arial', alias: true, fsType: 4 });
    const statik = pdfFontFixture({ family: 'Times New Roman', fsType: 4 });
    const variable = pdfFontFixture({ family: 'Courier New', variable: true, fsType: 4 });
    const entities = [text('cff', { style: 'CFF', text: 'AB' }), text('static', { style: 'STATIC', text: 'AB' }), text('variable', { style: 'VARIABLE', text: 'AB' })];
    const doc = new Drawing({ entities, meta: { textStyles: { CFF: style('CFF', 'arial.ttf'), STATIC: style('STATIC', 'times.ttf'), VARIABLE: style('VARIABLE', 'cour.ttf') } } });
    const unchanged = stable(doc), seen: FontMetricsRequest[] = [];
    const prepared = await capturedPdfLookup(doc.snapshot, async (wanted) => {
      seen.push(wanted); return { font: wanted.family === 'Arial' ? cff : wanted.family === 'Times New Roman' ? statik : variable };
    }, undefined, undefined, { restricted: true });
    expect(seen).toHaveLength(3); expect(seen.every((wanted) => wanted.restricted === true && wanted.usedCodepoints?.join(',') === '65,66')).toBe(true);
    expect(prepared.issues).toEqual([]); expect(prepared.restrictedFaces).toHaveLength(3);
    const pdf = parsePdfBasics(render(doc, prepared));
    expect(pdf.errors).toEqual([]); expect(pdf.version).toBe('1.6');
    const programs = [...pdf.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!);
    expect(programs).toHaveLength(2); expect(programs).toContainEqual(new Uint8Array(variable.bytes));
    expect(programs).toContainEqual(embeddableFontProgram(statik.bytes, new Set([2, 3])));
    expect([...pdf.objects.values()].find((object) => object.dict.includes('/Subtype /OpenType'))!.stream).toEqual(new Uint8Array(cff.bytes));
    const names = [...pdf.objects.values()].map((object) => object.dict).join('\n');
    expect(names).toContain('/BaseFont /JCadCFFFixture-Regular ');
    expect(names).toContain('/BaseFont /AAAAAB+JCadTimesNewRomanRegular ');
    expect(names).toContain('/BaseFont /JCadCourierNewRegular ');
    expect(prepared.fonts!.previewPrintKeys).toEqual(prepared.restrictedFaces.map((entry) => entry.key));
    expect(prepared.fonts!.resources()).toHaveLength(3); unchanged();
  });

  it('merges final missing-SHX Han fallback seeds with restricted mode, and leaves ordinary refusal explicit', async () => {
    const source = fontCollection(Buffer.from(pdfFontFixture({ family: 'Other Family', fsType: 2 }).bytes), Buffer.from(pdfFontFixture({ family: 'SimSun', fsType: 4, unicodeCodePoint: 0x4e2d }).bytes));
    const before = Buffer.from(source), options = await install(source, 'simsun.ttc'), seen: FontMetricsRequest[] = [];
    const reader: PdfFontReader = async (wanted) => {
      seen.push({ ...wanted, usedCodepoints: wanted.usedCodepoints && [...wanted.usedCodepoints] });
      try { return { font: await readWindowsPdfFont(wanted, options) }; }
      catch (error) { return { font: null, problem: error instanceof Error ? error.message : String(error) }; }
    };
    const doc = drawing([text('a', { text: 'A中' }), text('b', { text: '中B', style: 'OTHER' })]), unchanged = stable(doc);
    const prepared = await capturedPdfLookup(doc.snapshot, reader, undefined, undefined, { restricted: true });
    const descriptor = { font: 'simsun.ttc', family: 'SimSun', bold: false, italic: false };
    expect(seen).toEqual([{ ...descriptor, usedCodepoints: [65, 66, 0x4e2d], restricted: true }]);
    expect(prepared.issues).toEqual([]); expect(prepared.restrictedFaces).toEqual([{ key: expect.any(String), request: descriptor }]);
    expect(prepared.fonts!.previewPrintKeys).toEqual([prepared.restrictedFaces[0]!.key]);
    const pdf = parsePdfBasics(render(doc, prepared));
    expect(pdf.errors).toEqual([]); expect(prepared.fonts!.resources()).toHaveLength(1);
    expect(prepared.fonts!.resources()[0]!.face.metrics.faceIndex).toBe(1);
    expect([...pdf.objects.values()].some((object) => object.stream && decode(object.stream).includes('<0002> <4E2D>'))).toBe(true);
    const ordinary = await capturedPdfLookup(doc.snapshot, reader);
    expect(ordinary.issues.join(' ')).toContain('read-only PDF'); expect(ordinary.restrictedFaces).toEqual([]);
    expect(() => render(doc, ordinary)).toThrow(/Unicode text.*Raster image/);
    unchanged(); expect(source).toEqual(before); expect(await fs.readFile(path.join(options.fontsDirectory, 'simsun.ttc'))).toEqual(before);
  });

  it('keeps available Unicode SHX first, with zero native reads and restricted claims', async () => {
    const resources = new DrawingShxResources(), bytes = shxFixture('unifont', [...fontRecords, { code: 0x4e2d, program: [8, 5, 10, 8, 5, -10, 0] }]);
    const sha256 = createHash('sha256').update(bytes).digest('hex'), resolvedPath = 'C:\\authored\\missing-source.shx';
    await resources.load({ bytes, sha256, resolvedPath, resourceId: JSON.stringify([resolvedPath, sha256]) });
    const doc = drawing([text('shx', { text: 'A中' })]), unchanged = stable(doc), geometry = resources.capture({ SHX: style() }, true);
    const lookup: BlockLookup = Object.assign((name: string) => doc.snapshot.blocks[name], { textGeometry: geometry });
    let reads = 0;
    const prepared = await capturedPdfLookup(doc.snapshot, async () => { reads++; throw new Error('SHX must have priority'); }, undefined, lookup, { restricted: true });
    expect(prepared.geometry!.resolve(doc.entities[0]! as TextEntity)).toMatchObject({ kind: 'stroke', shxResourceId: expect.any(String) });
    const pdf = parsePdfBasics(render(doc, prepared));
    expect(pdf.errors).toEqual([]); expect(reads).toBe(0); expect(prepared.issues).toEqual([]); expect(prepared.restrictedFaces).toEqual([]);
    expect(prepared.fonts!.previewPrintKeys).toEqual([]); expect(prepared.fonts!.resources()).toEqual([]);
    expect([...pdf.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null)).toHaveLength(0); unchanged();
  });
});

class FakeWorker extends EventEmitter {
  constructor(readonly request: FontMetricsRequest & { usage?: string }) { super(); }
  async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
}
function hostFixture() {
  const created: FakeWorker[] = [];
  const host = createFontMetricsHost({ workerFactory: (wanted) => { const worker = new FakeWorker(wanted); created.push(worker); return worker; } });
  hosts.push(host); return { host, created };
}
describe('restricted host mode composes with captured used-set isolation', () => {
  it('coalesces only the same canonical seeds/mode while admission remains descriptor-specific', async () => {
    const { host, created } = hostFixture(), descriptor = { font: 'preview.ttf', family: 'Preview Fixture', bold: false, italic: false };
    const first = host.readPdf({ ...descriptor, usedCodepoints: [66, 65, 65], restricted: true });
    const equivalent = host.readPdf({ ...descriptor, usedCodepoints: [65, 66], restricted: true });
    const differentSeeds = host.readPdf({ ...descriptor, usedCodepoints: [65], restricted: true });
    const ordinary = host.readPdf({ ...descriptor, usedCodepoints: [65, 66] });
    expect(first).toBe(equivalent); expect(first).not.toBe(differentSeeds); expect(first).not.toBe(ordinary); expect(created).toHaveLength(2);
    expect(created[0]!.request).toEqual({ ...descriptor, usedCodepoints: [65, 66], restricted: true, usage: 'pdf' });
    created[0]!.emit('message', { metrics: { previewPrint: true } });
    created[1]!.emit('message', { metrics: { previewPrint: false } });
    await first;
    expect(created).toHaveLength(3); expect(created[2]!.request).toEqual({ ...descriptor, usedCodepoints: [65, 66], usage: 'pdf' });
    created[2]!.emit('message', { metrics: { previewPrint: true } });
    await Promise.all([differentSeeds, ordinary]);
    expect(host.admittedPreviewPrint(descriptor)).toBe(true);
    expect(host.admittedPreviewPrint({ ...descriptor, usedCodepoints: [0x20000], restricted: false })).toBe(true);
    expect(host.admittedPreviewPrint({ ...descriptor, bold: true })).toBe(false);
    await host.dispose(); expect(host.admittedPreviewPrint(descriptor)).toBe(false);
  });

  it('strips PDF seeds from metadata and never records metadata or ordinary-PDF results', async () => {
    const { host, created } = hostFixture(), descriptor = { font: 'preview.ttf', family: 'Preview Fixture' };
    const screen = host.read({ ...descriptor, usedCodepoints: [65], restricted: true });
    expect(created[0]!.request).toEqual({ ...descriptor, restricted: true });
    created[0]!.emit('message', { metrics: { previewPrint: true } }); await screen;
    expect(host.admittedPreviewPrint(descriptor)).toBe(false);
    const ordinary = host.readPdf({ ...descriptor, usedCodepoints: [65] });
    created[1]!.emit('message', { metrics: { previewPrint: true } }); await ordinary;
    expect(host.admittedPreviewPrint(descriptor)).toBe(false);
  });
});
