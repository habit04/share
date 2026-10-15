import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { Drawing } from '../src/core/document';
import type { Editor } from '../src/app/editor';
import type { TextEntity, Entity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { capturedPdfLookup, pdfFontKey, type PdfFontReader } from '../src/app/pdf-fonts';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import { vectorPdf, vectorPdfCompressed, renderPdfPages, drawingContext, type PdfPageSpec, type PdfDrawingContext } from '../src/io/pdf-vector';
import { parsePdfBasics, dictValue, pageContents, pageFonts, parseContentStream, type PdfBasics } from './helpers/pdf';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { embeddableFontProgram } from '../src/io/pdf-font-subset';
import { fontTable } from './helpers/native-font-fixture';

const style = (name = 'FACE', font = 'arial.ttf', widthFactor = 1, oblique = 0) => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor, oblique, generation: 0 });
const text = (id = 'text', extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left', ...extra });
const plotStyle = { mode: 'color' as const, lineweights: true, usePlotStyles: false };
const options = { paper: 'letter', orientation: 'portrait' as const, scale: 'fit', margin: 0.5, output: 'vector' as const };
function drawing(entities: readonly Entity[] = [text()]) { return new Drawing({ entities: [...entities], meta: { textStyles: { FACE: style() } } }); }
function page(entities: readonly Entity[], extra: Partial<PdfPageSpec['groups'][number]> = {}): PdfPageSpec {
  return { width: 300, height: 200, label: 'Sheet', groups: [{ entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1, ...extra }] };
}
const reader: PdfFontReader = async (request) => ({ font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic }) });
async function prepared(doc: Drawing, callback = reader, groups?: PdfPageSpec['groups']) {
  const result = await capturedPdfLookup(doc.snapshot, callback, groups);
  const context: PdfDrawingContext = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set() };
  return { result, context };
}
function embeddedPrograms(info: PdfBasics) { return [...info.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!); }
function unicodeText(info: PdfBasics) { return [...info.objects.values()].filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap')).map((object) => new TextDecoder().decode(object.stream)).join('\n'); }
function fontReferences(info: PdfBasics, pageNum: number) {
  const resources = dictValue(info.objects.get(pageNum)!.dict, 'Resources')!, fonts = dictValue(resources, 'Font')!;
  return Object.fromEntries([...fonts.matchAll(/\/(\w+)\s+(\d+)\s+0 R/g)].map((match) => [match[1], Number(match[2])]));
}
function close(actual: readonly number[], expected: readonly number[]) { expect(actual).toHaveLength(expected.length); actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 5)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function editorStub(doc: Drawing, pdfFont?: PdfFontReader, saveResult: string | null = 'private.pdf') {
  const saved: { bytes: Uint8Array; name: string }[] = [], logs: string[] = [];
  let name = 'Original.dxf', activeDoc = doc;
  const editor = { get doc() { return activeDoc; }, fileName: () => name, log: (value: string) => logs.push(value), fileBridge: {
    platform: 'win32', ...(pdfFont ? { pdfFont } : {}), savePdf: async (bytes: Uint8Array, suggestName: string) => { saved.push({ bytes, name: suggestName }); return saveResult; },
  } } as unknown as Editor;
  return { editor, saved, logs, rename: (value: string) => { name = value; }, activate: (value: Drawing) => { activeDoc = value; } };
}

describe('captured vector PDF font integration', () => {
  it('snapshots checked bytes and matching metrics before the next awaited font read', async () => {
    const first = pdfFontFixture(), original = new Uint8Array(first.bytes), second = pdfFontFixture({ family: 'Times New Roman' });
    const doc = new Drawing({ entities: [text(), text('second', { style: 'SECOND' })], meta: { textStyles: { FACE: style(), SECOND: style('SECOND', 'times.ttf') } } });
    const { result, context } = await prepared(doc, async (request) => {
      if (request.family === 'Arial') return { font: first };
      const bytes = first.bytes as Buffer, hmtx = fontTable(bytes, 'hmtx').offset;
      bytes.writeUInt16BE(850, hmtx + 8);
      (first.metrics.advances as number[]).fill(850, 2);
      return { font: second };
    });
    const appearance = result.geometry!.resolve({ style: 'FACE' });
    expect(appearance.kind).toBe('canvas'); if (appearance.kind !== 'canvas') throw new Error('Expected native face');
    expect(result.geometry!.measure('A', 730, appearance).advance).toBe(650);
    expect(result.fonts!.encode(pdfFontKey(appearance), 'A')!.advance).toBe(650);
    const pdf = parsePdfBasics(await vectorPdfCompressed([page(doc.entities)], context, plotStyle, 'Snapshot', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]); expect(embeddedPrograms(pdf)).toContainEqual(embeddableFontProgram(original, new Set([2, 3])));
    expect(embeddedPrograms(pdf)).not.toContainEqual(new Uint8Array(first.bytes));
  });

  it('plots the visible face when earlier off-layer/no-plot/inactive-layout faces exceed the font budget', async () => {
    const hidden = Array.from({ length: 8 }, (_, i) => text(`hidden${i}`, { layer: i % 2 ? 'OFF' : 'NOPLOT', style: `H${i}` }));
    const inactive = { ...defaultLayout('Unused'), pristine: false, entities: [text('paper', { style: 'PAPER' })], viewports: [] };
    const styles = Object.fromEntries([...hidden.map((_entity, i) => [`H${i}`, style(`H${i}`, `Face${i}.ttf`)]), ['FACE', style()], ['PAPER', style('PAPER', 'PaperFace.ttf')]]);
    const doc = new Drawing({ entities: [...hidden, text('visible')], layouts: [inactive], meta: { textStyles: styles }, layers: [
      { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }, { name: 'OFF', color: 7, visible: false, locked: false, lineWeight: 0.25 }, { name: 'NOPLOT', color: 7, visible: true, locked: false, plot: false, lineWeight: 0.25 },
    ] });
    const requests: string[] = [], stub = editorStub(doc, async (request) => { requests.push(request.family!); return reader(request); });
    expect(await plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).toBe(true);
    expect(requests).toEqual(['Arial']); expect(stub.saved).toHaveLength(1);
    const pdf = parsePdfBasics(stub.saved[0]!.bytes);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'JCadArialRegular' });
    expect(embeddedPrograms(pdf)).toHaveLength(1); expect(stub.logs.join(' ')).not.toContain('substitute');
    expect(doc.dirty).toBe(false); expect(doc.history()).toEqual({ undo: [], redo: [] });
  });

  it.each(['rectangular clip', 'hidden annotative'] as const)('does not let %s text consume the native font budget', async (mode) => {
    const hidden = Array.from({ length: 8 }, (_, i) => text(`hidden${i}`, { style: `H${i}`, ...(mode === 'rectangular clip' ? { position: { x: 10000, y: 10000 } } : { annotative: true }) }));
    const styles = Object.fromEntries([...hidden.map((_entity, i) => [`H${i}`, style(`H${i}`, `Face${i}.ttf`)]), ['FACE', style()]]);
    const doc = new Drawing({ entities: [...hidden, text('visible')], meta: { textStyles: styles } });
    const printed = page(doc.entities, mode === 'rectangular clip' ? { clip: { x: 0, y: 0, w: 250, h: 150 } } : { hideAnnotative: true, annoFactor: 0.5 });
    const requests: string[] = [], { result, context } = await prepared(doc, async (request) => { requests.push(request.family!); return reader(request); }, printed.groups);
    const pdf = parsePdfBasics(vectorPdf([printed], context, plotStyle));
    expect(requests).toEqual(['Arial']); expect(result.issues).toEqual([]);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'JCadArialRegular' });
    expect(embeddedPrograms(pdf)).toHaveLength(1); expect(context.fontFallbacks!.size).toBe(0);
  });

  it.each([3, 5] as const)('uses native ALIGNED/FIT mode %i anchors through width/shear and group rotation', async (horizontal) => {
    const e = text('fit', { text: 'AB', widthFactor: 0.5, oblique: 0.2, justification: { horizontal, vertical: 0 }, alignmentPoint: { x: 43, y: 34 } });
    const doc = drawing([e]), { context } = await prepared(doc), angle = Math.atan2(30, 40) + Math.PI / 4;
    const rendered = renderPdfPages([page([e], { rotation: Math.PI / 4 })], context, plotStyle)[0]!, ops = parseContentStream(rendered.content);
    expect(ops.errors).toEqual([]);
    const wf = horizontal === 3 ? 0.5 : 50 / 13, height = horizontal === 3 ? 7.3 * 50 / 6.5 : 7.3, slant = Math.tan(0.2), c = Math.cos(angle), s = Math.sin(angle);
    expect(Number(ops.ops.find((op) => op.op === 'Tf')!.args[1])).toBeCloseTo(height * 2 * 1000 / 730, 5);
    close(ops.ops.find((op) => op.op === 'Tm')!.args.map(Number), [wf * c, wf * s, slant * c - s, slant * s + c, 20 + 2 * (3 - 4) / Math.sqrt(2), 30 + 2 * (3 + 4) / Math.sqrt(2)]);
    expect(ops.ops.find((op) => op.op === 'Tj')!.args[0]).toBe('<00010002>');
  });

  it.each([[undefined, 0.5], [1, 1], [1.5, 1.5]] as const)('honors explicit STYLE width override %s and signed-bearing centering', async (widthFactor, expected) => {
    const e = text('center', { align: 'center', rotation: 0.2, oblique: 0, ...(widthFactor === undefined ? {} : { widthFactor }) });
    const doc = new Drawing({ entities: [e], meta: { textStyles: { FACE: style('FACE', 'arial.ttf', 0.5, 0.3) } } }), { context } = await prepared(doc);
    const ops = parseContentStream(renderPdfPages([page([e], { rotation: 0.4 })], context, plotStyle)[0]!.content), c = Math.cos(0.6), s = Math.sin(0.6), off = -6.4 * expected * 2;
    expect(Number(ops.ops.find((op) => op.op === 'Tf')!.args[1])).toBe(20);
    close(ops.ops.find((op) => op.op === 'Tm')!.args.map(Number), [expected * c, expected * s, -s, c, 20 + 2 * (3 * Math.cos(0.4) - 4 * Math.sin(0.4)) + off * c, 30 + 2 * (3 * Math.sin(0.4) + 4 * Math.cos(0.4)) + off * s]);
  });

  it('shares one complete font across pages with supplementary ToUnicode and exact native widths', async () => {
    const doc = drawing([text('first', { text: 'A𠀀' }), text('second', { text: 'B' })]), { context } = await prepared(doc);
    const pages = [page([doc.entities[0]!]), page([doc.entities[1]!])];
    const pdf = parsePdfBasics(await vectorPdfCompressed(pages, context, plotStyle, 'Unicode', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]); expect(pdf.pages).toHaveLength(2); expect(embeddedPrograms(pdf)).toHaveLength(1);
    expect(fontReferences(pdf, pdf.pages[0]!.num).JCF1).toBe(fontReferences(pdf, pdf.pages[1]!.num).JCF1);
    expect(unicodeText(pdf)).toContain('<0001> <0041>\n<0002> <D840DC00>\n<0003> <0042>');
    expect([...pdf.objects.values()].find((object) => /\/Subtype \/CIDFontType2/.test(object.dict))!.dict).toContain('/W [1 [650 650 650]]');
    const contents = pageContents(pdf, (bytes) => new Uint8Array(inflateSync(bytes)));
    expect(contents[0]).toContain('<00010002> Tj'); expect(contents[1]).toContain('<0003> Tj');
  });

  it('preserves Unicode aliases and keeps two native face resources distinct across pages', async () => {
    const first = pdfFontFixture({ alias: true }), second = pdfFontFixture({ family: 'Times New Roman' });
    const doc = new Drawing({ entities: [text('alias'), text('other', { style: 'OTHER', text: 'A' })], meta: { textStyles: { FACE: style(), OTHER: style('OTHER', 'times.ttf') } } });
    const { context } = await prepared(doc, async (request) => ({ font: request.family === 'Arial' ? first : second }));
    const pdf = parsePdfBasics(vectorPdf([page([doc.entities[0]!]), page([doc.entities[1]!])], context, plotStyle));
    expect(pdf.errors).toEqual([]); expect(embeddedPrograms(pdf)).toHaveLength(2);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'JCadArialRegular' });
    expect(pageFonts(pdf, pdf.pages[1]!.num)).toEqual({ JCF2: 'JCadTimesNewRomanRegular' });
    expect(unicodeText(pdf)).toContain('<0001> <0041>\n<0002> <0042>');
    const maps = [...pdf.objects.values()].filter((object) => object.stream?.length === 6);
    expect(maps.map((object) => object.stream)).toContainEqual(new Uint8Array([0, 0, 0, 2, 0, 2]));
  });

  it('captures the original tab/name/title through a deferred reader and leaves both documents intact', async () => {
    const old = drawing([text('old', { text: 'A' })]), current = drawing([text('new', { text: 'C' })]), ready = deferred<void>(), started = deferred<void>();
    const before = old.snapshot, history = old.history(), stub = editorStub(old, async (request) => { started.resolve(); await ready.promise; return reader(request); });
    const operation = plotLayoutsOrVector(stub.editor, { action: 'pdf', options });
    await started.promise; stub.activate(current); stub.rename('NewTab.dxf'); ready.resolve();
    expect(await operation).toBe(true); expect(stub.saved[0]!.name).toBe('Original.pdf');
    const pdf = parsePdfBasics(stub.saved[0]!.bytes);
    expect([...pdf.objects.values()].some((object) => /\/Title \(Original\)/.test(object.dict))).toBe(true);
    expect(unicodeText(pdf)).toContain('<0001> <0041>'); expect(unicodeText(pdf)).not.toContain('<0043>');
    expect(old.snapshot).toBe(before); expect(old.history()).toEqual(history); expect(old.dirty).toBe(false); expect(current.dirty).toBe(false);
  });

  it.each([2, 4, 0x208])('reports native licensing fallback %i and leaves drawing state/history/dirty unchanged', async (fsType) => {
    const doc = drawing(), snapshot = doc.snapshot, history = doc.history(), stub = editorStub(doc, async () => ({ font: pdfFontFixture({ fsType }) }), null);
    expect(await plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).toBe(true);
    const pdf = parsePdfBasics(stub.saved[0]!.bytes);
    expect(embeddedPrograms(pdf)).toEqual([]); expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ F1: 'Helvetica' });
    expect(stub.logs.join(' ')).toContain('substitute fonts'); expect(stub.logs.join(' ')).toMatch(/restricted|read-only|bitmap-only/);
    expect(doc.snapshot).toBe(snapshot); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(false);
  });

  it('reports unsupported glyph fallback while keeping an eligible neighboring resource intact', async () => {
    const doc = drawing([text('native', { text: 'A' }), text('missing', { text: 'C' })]), stub = editorStub(doc, reader);
    await plotLayoutsOrVector(stub.editor, { action: 'pdf', options });
    const pdf = parsePdfBasics(stub.saved[0]!.bytes), fonts = pageFonts(pdf, pdf.pages[0]!.num);
    expect(fonts).toEqual({ JCF1: 'JCadArialRegular', F1: 'Helvetica' }); expect(embeddedPrograms(pdf)).toHaveLength(1);
    expect(stub.logs.join(' ')).toContain('substitute fonts'); expect(unicodeText(pdf)).toContain('<0041>'); expect(unicodeText(pdf)).not.toContain('<0043>');
  });

  it('keeps the bridge-absent legacy vector PDF appearance and resources', async () => {
    const doc = drawing(), plain = drawingContext(doc.snapshot, doc.lookupBlock);
    const absent = await capturedPdfLookup(doc.snapshot);
    expect(absent.fonts).toBeUndefined(); expect(absent.geometry).toBeUndefined();
    const old = vectorPdf([page(doc.entities)], plain, plotStyle, 'Legacy');
    const current = vectorPdf([page(doc.entities)], { ...plain, lookup: absent.lookup, embeddedFonts: absent.fonts, textGeometry: absent.geometry }, plotStyle, 'Legacy');
    expect(current).toEqual(old); expect(embeddedPrograms(parsePdfBasics(current))).toEqual([]);
  });
});
