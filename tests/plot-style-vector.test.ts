import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Editor } from '../src/app/editor';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, LeaderEntity } from '../src/core/entities';
import { explodeInsert } from '../src/core/entities';
import { plotLayoutsOrVector, styleFor } from '../src/app/plot-vector';
import { drawingContext, renderPdfPages, vectorPdf, type PdfPageSpec, type PdfPlotStyle } from '../src/io/pdf-vector';
import { readPlotStyleTable } from '../src/io/plot-styles';
import { plotStyleProgram, plotStyleText } from './helpers/plot-style-fixture';
import { parseContentStream, parsePdfBasics, pageContents } from './helpers/pdf';

const layers: readonly Layer[] = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'RED', color: 1, visible: true, locked: false, lineWeight: 0.35 },
  { name: 'BLUE', color: 5, visible: true, locked: false, lineWeight: 0.6 }];
const line = (extra: Partial<LineEntity> = {}): LineEntity => ({ id: 'line', type: 'line', layer: 'RED', color: 'ByLayer', a: { x: 10, y: 10 }, b: { x: 60, y: 10 }, ...extra });
const insert = (block: string, extra: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'insert', type: 'insert', layer: 'RED', color: 'ByLayer', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, ...extra });
const table = (kind: 'ctb' | 'stb' = 'ctb') => {
  const entries: Record<number, Record<string, string>> = { [kind === 'ctb' ? 0 : 1]: { color_policy: '5', mode_color: String(0xc2008000 | 0), lineweight: '2' } };
  if (kind === 'ctb') entries[4] = { color_policy: '5', mode_color: String(0xc2ff8000 | 0) };
  return readPlotStyleTable(plotStyleProgram(plotStyleText({ kind, weights: [0, 0.7], entries }), kind));
};
const page = (entities: readonly Entity[], extra: Partial<PdfPageSpec['groups'][number]> = {}): PdfPageSpec => ({ width: 300, height: 200, label: 'Model',
  groups: [{ entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1, ...extra }] });
const baseStyle: PdfPlotStyle = { mode: 'monochrome', usePlotStyles: true, lineweights: true };
function parsed(doc: Drawing, style: PdfPlotStyle, printed = page(doc.entities)) {
  const rendered = renderPdfPages([printed], drawingContext(doc.snapshot, doc.lookupBlock), style)[0]!;
  const result = parseContentStream(rendered.content); expect(result.errors).toEqual([]); return result.ops;
}
const commands = (ops: ReturnType<typeof parsed>, name: string) => ops.filter((op) => op.op === name).map((op) => op.args.map(Number));

describe('native table vector plotting', () => {
  it('uses actual CTB ACI slots and physical weights, while matching TrueColor bypasses both', async () => {
    const doc = new Drawing({ layers: [...layers], entities: [line(), line({ id: 'rgb', trueColor: 0xff0000, lineWeight: 0.4, a: { x: 10, y: 30 }, b: { x: 60, y: 30 } })] });
    const ops = parsed(doc, { ...baseStyle, table: await table() });
    expect(commands(ops, 'RG')).toEqual([[0, 0.502, 0], [1, 0, 0]]);
    expect(commands(ops, 'w')).toEqual([[1.984], [1.134]]);
  });
  it('preserves intermediate source ByBlock width even with a warm default block cache', async () => {
    const leaf = line({ layer: '0', color: 0, lineWeight: -2 });
    const blocks: Record<string, BlockDef> = { Inner: { name: 'Inner', basePoint: { x: 0, y: 0 }, entities: [leaf], attributes: [] },
      Outer: { name: 'Outer', basePoint: { x: 0, y: 0 }, entities: [insert('Inner', { layer: '0', color: 0, lineWeight: 0.9 })], attributes: [] } };
    const doc = new Drawing({ layers: [...layers], blocks, entities: [insert('Outer', { lineWeight: 0.35 })] });
    const source = doc.entities[0] as InsertEntity, cached = explodeInsert(source, doc.lookupBlock);
    expect(cached[0]!.lineWeight).toBe(-2);
    const native = await readPlotStyleTable(plotStyleProgram(plotStyleText({ entries: { 0: { color_policy: '5', mode_color: String(0xc2000000 | 0) } } })));
    expect(commands(parsed(doc, { ...baseStyle, table: native }), 'w')).toEqual([[2.551]]);
    expect(explodeInsert(source, doc.lookupBlock)).toBe(cached); expect(cached[0]!.lineWeight).toBe(-2);
  });
  it('resolves separately layered leader text by its own CTB identity', async () => {
    const leader: LeaderEntity = { id: 'leader', type: 'leader', layer: 'RED', color: 'ByLayer', vertices: [{ x: 10, y: 10 }, { x: 30, y: 30 }],
      arrow: false, arrowSize: 1, text: 'A', textPosition: { x: 30, y: 30 }, textHeight: 10, textLayer: 'BLUE', textAppearance: { color: 'ByLayer' } };
    const doc = new Drawing({ layers: [...layers], entities: [leader] });
    expect(commands(parsed(doc, { ...baseStyle, table: await table() }), 'RG')).toEqual([[0, 0.502, 0], [1, 0.502, 0]]);
  });
  it('styles viewport frames without losing the polygon clip or source layer', async () => {
    const printed = page([], { clip: { x: 0, y: 0, w: 200, h: 100 }, clipPolygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }],
      frames: [{ x: 0, y: 0, w: 200, h: 100, layer: 'RED' }] });
    const ops = parsed(new Drawing({ layers: [...layers] }), { ...baseStyle, table: await table() }, printed);
    expect(commands(ops, 'RG')).toEqual([[0, 0.502, 0]]); expect(commands(ops, 'w')).toEqual([[1.984]]);
    expect(ops.some((op) => op.op === 'W*')).toBe(true);
  });
  it('keeps STB Normal properties, explicit whole-plot selection and disabled options distinct', async () => {
    const doc = new Drawing({ layers: [...layers], entities: [line({ trueColor: 0xff0000 })] }), native = await table('stb');
    expect(commands(parsed(doc, { ...baseStyle, table: native }), 'RG')).toEqual([[1, 0, 0]]);
    expect(commands(parsed(doc, { ...baseStyle, table: native, namedStyle: 'Style_1' }), 'RG')).toEqual([[0, 0.502, 0]]);
    const disabled = parsed(doc, { ...baseStyle, table: native, namedStyle: 'Style_1', usePlotStyles: false, lineweights: false });
    expect(commands(disabled, 'RG')).toEqual([[1, 0, 0]]); expect(commands(disabled, 'w')).toEqual([[0]]);
  });
  it('captures selected table/style and output name across pending plotting', async () => {
    const native = await table('stb'), doc = new Drawing({ entities: [line({ color: 1 })] }), state = doc.snapshot;
    const options = { paper: 'letter', orientation: 'portrait' as const, scale: 'fit', margin: 0.5, output: 'vector' as const,
      styleTable: native, namedStyle: 'Style_1' };
    let name = 'Original.dxf', bytes: Uint8Array | undefined, savedName = '';
    const editor = { doc, fileName: () => name, log: () => {}, fileBridge: { platform: 'win32', savePdf: async (data: Uint8Array, filename: string) => {
      bytes = data; savedName = filename; return filename;
    } } } as unknown as Editor;
    const pending = plotLayoutsOrVector(editor, { action: 'pdf', options }); name = 'Later.dxf'; options.namedStyle = 'Normal';
    expect(await pending).toBe(true); expect(savedName).toBe('Original.pdf'); expect(doc.snapshot).toBe(state); expect(doc.dirty).toBe(false);
    const pdf = parsePdfBasics(bytes!); expect(pdf.errors).toEqual([]);
    expect(commands(parseContentStream(pageContents(pdf, (data) => new Uint8Array(inflateSync(data)))[0]!).ops, 'RG')).toContainEqual([0, 0.502, 0]);
  });
  it('reports only used unsupported table effects and preserves the normal legacy path', async () => {
    const native = await readPlotStyleTable(plotStyleProgram(plotStyleText({ entries: { 0: { physical_pen_number: '3' }, 4: { virtual_pen_number: '5' } } })));
    const issues = new Set<string>(), doc = new Drawing({ entities: [line({ color: 1 })] });
    vectorPdf([page(doc.entities)], drawingContext(doc.snapshot, doc.lookupBlock), { ...baseStyle, table: native, issues });
    expect([...issues].some((message) => message.includes('physical_pen_number'))).toBe(true);
    expect([...issues].some((message) => message.includes('virtual_pen_number'))).toBe(false);
    expect(commands(parsed(doc, baseStyle), 'RG')).toEqual([[0, 0, 0]]);
    expect(styleFor({ paper: 'letter', orientation: 'auto', scale: 'fit', margin: 0.5, styleTable: native }, undefined).table).toBe(native);
  });
});
