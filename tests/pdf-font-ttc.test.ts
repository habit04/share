import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import type { Editor } from '../src/app/editor';
import type { TextEntity, Entity } from '../src/core/entities';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import { vectorPdfCompressed, drawingContext, type PdfPageSpec, type PdfDrawingContext } from '../src/io/pdf-vector';
import type { PdfFontFace } from '../src/io/pdf-fonts';
import { parsePdfBasics, dictValue, pageContents, pageFonts, type PdfBasics } from './helpers/pdf';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { fontCollection } from './helpers/native-font-fixture';

const require = createRequire(import.meta.url);
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: { font: string; family?: string; bold?: boolean; italic?: boolean }, options?: { fontsDirectory?: string }): Promise<Omit<PdfFontFace, 'key'>>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as { extractTtcFace(input: Uint8Array, faceIndex?: number): Buffer };

const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-pdf-ttc-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-pdf-ttc-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected PDF TTC test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const style = (name = 'FACE', font = 'arial.ttc') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const text = (id = 'text', extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left', ...extra });
const plotStyle = { mode: 'color' as const, lineweights: true, usePlotStyles: false };
const options = { paper: 'letter', orientation: 'portrait' as const, scale: 'fit', margin: 0.5, output: 'vector' as const };
function drawing(entities: readonly Entity[]) { return new Drawing({ entities: [...entities], meta: { textStyles: { FACE: style() } } }); }
function page(entities: readonly Entity[]): PdfPageSpec {
  return { width: 300, height: 200, label: 'Sheet', groups: [{ entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
}
function embeddedPrograms(info: PdfBasics) { return [...info.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!); }
function unicodeText(info: PdfBasics) { return [...info.objects.values()].filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap')).map((object) => new TextDecoder().decode(object.stream)).join('\n'); }

/** The production reader contract over a private fonts directory holding one collection. */
async function collectionReader(bytes: Buffer): Promise<{ fontsDirectory: string; reader: PdfFontReader }> {
  const fontsDirectory = await privateDirectory();
  await fs.writeFile(path.join(fontsDirectory, 'arial.ttc'), bytes);
  const reader: PdfFontReader = async (request) => {
    try { return { font: await readWindowsPdfFont(request, { fontsDirectory }) }; }
    catch (error) { return { font: null, problem: error instanceof Error ? error.message : 'font unavailable' }; }
  };
  return { fontsDirectory, reader };
}
function editorStub(doc: Drawing, pdfFont: PdfFontReader) {
  const saved: { bytes: Uint8Array; name: string }[] = [], logs: string[] = [];
  const editor = { get doc() { return doc; }, fileName: () => 'Original.dxf', log: (value: string) => logs.push(value), fileBridge: {
    platform: 'win32', pdfFont, savePdf: async (bytes: Uint8Array, suggestName: string) => { saved.push({ bytes, name: suggestName }); return 'private.pdf'; },
  } } as unknown as Editor;
  return { editor, saved, logs };
}

describe('PDF embedding of an extracted TTC face', () => {
  it('embeds the extracted standalone program and maps Unicode CIDs, including a supplementary character', async () => {
    const face = Buffer.from(pdfFontFixture({ family: 'Arial' }).bytes), ttc = fontCollection(face);
    const { reader } = await collectionReader(ttc);
    const doc = drawing([text('first', { text: 'A𠀀' }), text('second', { text: 'B' })]);
    const result = await capturedPdfLookup(doc.snapshot, reader);
    expect(result.issues).toEqual([]);
    const context: PdfDrawingContext = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set() };
    const pdf = parsePdfBasics(await vectorPdfCompressed([page([doc.entities[0]!]), page([doc.entities[1]!])], context, plotStyle, 'TTC', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]);
    const programs = embeddedPrograms(pdf);
    expect(programs).toHaveLength(1); // one shared program across both pages
    expect(programs[0]).toEqual(new Uint8Array(extractTtcFace(ttc, 0)));
    expect(new TextDecoder().decode(programs[0]!.subarray(0, 4))).not.toBe('ttcf');
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'JCadArialRegular' });
    expect(unicodeText(pdf)).toContain('<0001> <0041>\n<0002> <D840DC00>\n<0003> <0042>');
    const contents = pageContents(pdf, (bytes) => new Uint8Array(inflateSync(bytes)));
    expect(contents[0]).toContain('<00010002> Tj'); expect(contents[1]).toContain('<0003> Tj');
  });
  it('falls back with a logged substitution when the collection face is restricted', async () => {
    const ttc = fontCollection(Buffer.from(pdfFontFixture({ family: 'Arial', fsType: 2 }).bytes));
    const { reader } = await collectionReader(ttc);
    const doc = drawing([text()]), stub = editorStub(doc, reader);
    expect(await plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).toBe(true);
    const pdf = parsePdfBasics(stub.saved[0]!.bytes);
    expect(embeddedPrograms(pdf)).toEqual([]);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ F1: 'Helvetica' });
    expect(stub.logs.join(' ')).toContain('substitute fonts');
    expect(stub.logs.join(' ')).toContain('restricted');
    expect(doc.dirty).toBe(false);
  });
  it('falls back with a logged substitution when the collection is malformed', async () => {
    const ttc = fontCollection(Buffer.from(pdfFontFixture({ family: 'Arial' }).bytes));
    ttc.writeUInt32BE(3, 8); // claims three faces; only one is present
    const { reader } = await collectionReader(ttc);
    const doc = drawing([text()]), stub = editorStub(doc, reader);
    expect(await plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).toBe(true);
    const pdf = parsePdfBasics(stub.saved[0]!.bytes);
    expect(embeddedPrograms(pdf)).toEqual([]);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ F1: 'Helvetica' });
    expect(stub.logs.join(' ')).toContain('substitute fonts');
    expect(doc.dirty).toBe(false);
  });
});
