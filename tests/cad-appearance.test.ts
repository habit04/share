import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { convertDwg, toImportPayload, type DwgImportPayload } from '../src/io/dwg';
import { transparencyFromDxf, transparencyToDxf, resolveAlpha } from '../src/core/appearance';
import { explodeInsert, inheritedColor, bakeInheritedColor, translateEntity, rotateEntity, scaleEntityBy, mirrorEntityAcross, dimensionParts, mtextParts, tableParts, leaderParts, imageParts, type InsertEntity, type LineEntity } from '../src/core/entities';
import { Drawing, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { drawEntity, resolveColor } from '../src/render/draw';
import { vectorPdf, plotPages, drawingContext, renderPdfPages } from '../src/io/pdf-vector';
import { parsePdfBasics, dictValue } from './helpers/pdf';
import { validateUserSymbol, serializeUserLibrary, parseUserLibraryDocument } from '../src/electrical/userlib';
import { fromSelection, symbolGeometry } from '../src/electrical/symbol-builder-core';
import { matchProperties } from '../src/tools/drafting-modify';
import { EntityClipboard } from '../src/ui/clipboard';
import type { Editor } from '../src/app/editor';
import { SessionManager } from '../src/app/sessions';
import type { DwgDatabase, DwgEntity } from '@mlightcad/libredwg-web';

// Authored from the DXF reference and serialized transparency methods, independently of writeDxf.
const fixture = readFileSync(new URL('./fixtures/interchange/r2010-appearance.dxf', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const state = readDxf(fixture);
const lookup = (name: string) => state.blocks[name];
const parts = () => explodeInsert(state.entities[0] as InsertEntity, lookup);
const expected = [96, 128, 96, 200, 64, 64, 64, 64, 200, 64, 160, 128, 160, 200, 64];
const named = state.entities[5] as LineEntity;

describe('CAD appearance codes and independent fixture', () => {
  it.each([[0, 'ByLayer'], [16777216, 'ByBlock'], [33554432, 0], [33554559, 127], [33554687, 255]] as const)('decodes and encodes serialized transparency %i', (encoded, spec) => {
    expect(transparencyFromDxf(encoded)).toBe(spec);
    expect(transparencyToDxf(spec)).toBe(encoded);
  });
  it.each([-1, 128, 33554688, 50331648, 33554687.5, NaN, Infinity, '33554559'])('rejects invalid serialized alpha/method %s', (value) => {
    expect(transparencyFromDxf(value)).toBeUndefined();
  });
  it('does not mask or clamp invalid explicit model alpha into a plausible value', () => {
    for (const alpha of [-1, 256, 0.5, NaN]) expect(() => transparencyToDxf(alpha)).toThrow(/integer from 0 to 255/);
  });
  it('keeps color-book identity, ACI fallback and true color independently on entities/layers', () => {
    expect(named).toMatchObject({ color: 1, trueColor: 0xabcdef, colorName: 'Studio Book$Pearl Δ', transparency: 127 });
    expect(state.layers.find((l) => l.name === 'RICH')).toMatchObject({ color: 5, trueColor: 0x123456, colorName: 'Studio Book$Teal 雷', transparency: 64 });
    expect(resolveColor(named, state.layers)).toBe('#abcdef');
    expect(resolveAlpha(state.entities[2]!, state.layers)).toBe(0);
    expect(resolveAlpha(state.entities[3]!, state.layers)).toBe(1);
    expect(resolveAlpha(state.entities[4]!, state.layers)).toBe(1); // top-level ByBlock
  });
  it('round-trips native entity codes and real layer transparency XDATA in a suitable DXF version', () => {
    const text = writeDxf(state), back = readDxf(text);
    expect(text).toContain('AC1024');
    expect(text).toContain('430\r\nStudio Book$Pearl Δ\r\n440\r\n33554559');
    expect(text).toContain('1001\r\nAcCmTransparency\r\n1071\r\n33554560');
    expect(back.entities[5]).toMatchObject({ color: 1, trueColor: 0xabcdef, colorName: named.colorName, transparency: 127 });
    expect(back.layers.find((l) => l.name === 'RICH')).toMatchObject({ colorName: 'Studio Book$Teal 雷', transparency: 64 });
    expect(explodeInsert(back.entities[0] as InsertEntity, (n) => back.blocks[n]).map((e) => Math.round(resolveAlpha(e, back.layers) * 255))).toEqual(expected);
    expect(JSON.stringify(importReportOf(back)?.items ?? [])).not.toMatch(/transparency.*not kept|color-book names are not kept/);
  });
  it('keeps legacy DXF output when new properties are absent and promotes named colors only to 2004', () => {
    const plain = { ...named, colorName: undefined, transparency: undefined };
    const simple: DrawingState = { entities: [plain], layers: [], blocks: {}, currentLayer: '0' };
    expect(writeDxf(simple)).toContain('AC1015');
    expect(writeDxf({ ...simple, entities: [{ ...plain, colorName: 'Book$Named' }] })).toContain('AC1018');
  });
  it('accepts a layer 440 value but exports its supported AcCmTransparency XDATA representation', () => {
    const alternate = fixture.replace('1001\nAcCmTransparency\n1071\n33554560', '440\n33554560');
    const s = readDxf(alternate);
    expect(s.layers.find((l) => l.name === 'HOST')?.transparency).toBe(128);
    expect(readDxf(writeDxf(s)).layers.find((l) => l.name === 'HOST')?.transparency).toBe(128);
  });
  it('retains geometry while reporting an invalid transparency method instead of inventing alpha', () => {
    const s = readDxf(fixture.replace('440\n33554559', '440\n50331648'));
    expect(s.entities).toHaveLength(state.entities.length);
    expect(s.entities[5]?.transparency).toBeUndefined();
    expect(JSON.stringify(s.meta?.importReport)).toContain('invalid transparency method/alpha');
  });
  it('does not mistake MTEXT background color 430 for the entity color identity', () => {
    const s = readDxf('0\nSECTION\n2\nENTITIES\n0\nMTEXT\n100\nAcDbEntity\n8\n0\n100\nAcDbMText\n10\n0\n20\n0\n40\n1\n41\n5\n1\nText\n90\n1\n430\nBackground$Color\n0\nENDSEC\n0\nEOF\n');
    expect(s.entities[0]?.colorName).toBeUndefined();
    expect(s.entities[0]).toMatchObject({ background: { colorName: 'Background$Color' } });
    expect(JSON.stringify(s.meta?.importReport) ?? '').not.toContain('background fill is not kept');
  });
});

describe('alpha inheritance, generated geometry and persistence', () => {
  it('resolves nested ByBlock, layer-0 ByLayer, own-layer ByLayer and explicit overrides without multiplying', () => {
    expect(parts().map((e) => Math.round(resolveAlpha(e, state.layers) * 255))).toEqual(expected);
    expect(state.blocks.INNER?.entities.map((e) => e.transparency)).toEqual(['ByBlock', 'ByLayer', 'ByBlock', 200, 'ByLayer']);
  });
  it('bakes display-only alpha/color layer references before permanent EXPLODE', () => {
    const baked = parts().map((e) => bakeInheritedColor(e, state.layers));
    expect(baked.every((e) => e.transparencyLayer === undefined && e.colorLayer === undefined)).toBe(true);
    expect(baked.map((e) => Math.round(resolveAlpha(e, state.layers) * 255))).toEqual(expected);
    expect(baked[5]).toMatchObject({ trueColor: 0x123456, colorName: 'Studio Book$Teal 雷', transparency: 64 });
  });
  it('retains appearance across translation, rotation, scaling and mirroring', () => {
    const transforms = [translateEntity(named, { x: 3, y: 5 }), rotateEntity(named, { x: 0, y: 0 }, 0.7), scaleEntityBy(named, { x: 0, y: 0 }, 2), mirrorEntityAcross(named, { x: 0, y: 0 }, { x: 0, y: 1 })];
    for (const e of transforms) expect(e).toMatchObject({ color: 1, trueColor: 0xabcdef, colorName: named.colorName, transparency: 127 });
  });
  it('keeps a supplied name without a palette lookup and retains previously flattened ByLayer references', () => {
    const source: LineEntity = { ...named, color: 0, trueColor: undefined, colorName: 'Independent$Identity' };
    const parent = { ...state.entities[0]!, color: 'ByLayer' as const };
    const inherited = { ...source, ...inheritedColor(source, parent) };
    expect(inherited).toMatchObject({ colorName: 'Independent$Identity', colorLayer: 'HOST' });
    const baked = bakeInheritedColor(inherited, state.layers);
    expect(baked.colorName).toBe('Independent$Identity');
    expect(inheritedColor({ ...source, color: 'ByLayer', colorLayer: 'RICH' }, parent)).toMatchObject({ colorLayer: 'RICH', colorName: 'Independent$Identity' });
  });
  it('matches RGB, named identity and transparency, clearing stale destination overrides for a plain source', () => {
    const target: LineEntity = { ...named, id: 'target', trueColor: 0x112233, colorName: 'Old$Name', transparency: 12 };
    expect(matchProperties(named, target)).toMatchObject({ trueColor: 0xabcdef, colorName: named.colorName, transparency: 127 });
    const plain: LineEntity = { type: 'line', id: 'plain', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    const matched = matchProperties(plain, target);
    expect(matched.trueColor).toBeUndefined();
    expect(matched.colorName).toBeUndefined();
    expect(matched.transparency).toBeUndefined();
    expect(resolveColor(matched, state.layers)).toBe(resolveColor(plain, state.layers));
    expect(resolveAlpha(matched, state.layers)).toBe(resolveAlpha(plain, state.layers));
  });
  it('retains the owner alpha in dimension, formatted MTEXT, table, leader and image primitives', () => {
    const base = { id: 'owner', layer: 'HOST', color: 'ByLayer' as const, transparency: 96, transparencyLayer: 'RICH', colorName: 'Book$Owner' };
    const groups = [
      dimensionParts({ ...base, type: 'dimension', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 5, y: 0 }, linePoint: { x: 0, y: 2 }, rotation: 0, style: STANDARD_DIMSTYLE }),
      mtextParts({ ...base, type: 'mtext', position: { x: 0, y: 0 }, height: 1, width: 8, rotation: 0, attachment: 1, lineSpacing: 1, text: 'Red text', raw: '{\\C1;Red} text' }),
      tableParts({ ...base, type: 'table', position: { x: 0, y: 0 }, rotation: 0, rowHeights: [2], columnWidths: [5], textHeight: 1, cells: [[{ text: 'Cell' }]] }),
      leaderParts({ ...base, type: 'leader', vertices: [{ x: 0, y: 0 }, { x: 2, y: 2 }], arrow: true, arrowSize: 1, text: 'Text', textPosition: { x: 2, y: 2 }, textHeight: 1 }),
      imageParts({ ...base, type: 'image', path: 'image.png', position: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 4, y: 3 } }),
    ];
    for (const group of groups) { expect(group.length).toBeGreaterThan(0); for (const e of group) expect(e).toMatchObject({ transparency: 96, transparencyLayer: 'RICH' }); }
  });
  it('keeps copied entities, symbol creation and user-library JSON appearance', () => {
    const doc = new Drawing(); doc.load(state);
    const editor = { doc, selection: new Set([named.id]), entitiesSelected: () => [named], cursorPosition: () => null, log: () => {}, notify: () => {}, render: () => {} } as unknown as Editor;
    const clipboard = new EntityClipboard(editor); clipboard.copy(); clipboard.paste({ x: 50, y: 50 });
    expect(doc.entities.at(-1)).toMatchObject({ colorName: named.colorName, transparency: 127 });
    const sym = fromSelection([state.entities[0]!], { x: 0, y: 0 }, lookup, { layers: state.layers });
    const geometry = symbolGeometry(sym.state);
    expect(geometry.map((e) => Math.round(resolveAlpha(e, sym.state.layers) * 255))).toEqual(expected);
    expect(geometry.every((e) => e.transparencyLayer === undefined)).toBe(true);
    const entry = validateUserSymbol({ block: { name: 'APPEARANCE', basePoint: { x: 0, y: 0 }, entities: geometry, attributes: [] }, byBlockColors: true, standard: 'JIC', family: 'TEST' });
    const loaded = parseUserLibraryDocument(serializeUserLibrary([entry])).symbols[0]!;
    expect(loaded.block.entities.map((e) => e.transparency)).toEqual(geometry.map((e) => e.transparency));
    expect(loaded.block.entities[5]?.colorName).toBe('Studio Book$Teal 雷');
  });
  it('keeps alpha and named color when parking and restoring a document session', () => {
    const doc = new Drawing(); doc.load(state);
    const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, path: string | null) => doc.load(s, path) };
    const sessions = new SessionManager(host); sessions.add(); sessions.switchTo(0);
    expect(doc.entities[5]).toMatchObject({ colorName: named.colorName, transparency: 127 });
    expect(doc.layers.find((l) => l.name === 'RICH')).toMatchObject({ transparency: 64, colorName: 'Studio Book$Teal 雷' });
  });
});

describe('screen and PDF use the same source alpha', () => {
  it('draws the independently specified nested alpha values and preserves the drawing alpha under a ghost style', () => {
    const strokes: number[] = []; const saved: number[] = [];
    const mock = { globalAlpha: 1, save() { saved.push(mock.globalAlpha); }, restore() { mock.globalAlpha = saved.pop()!; }, beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, stroke() { strokes.push(mock.globalAlpha); } };
    const context = mock as unknown as CanvasRenderingContext2D;
    const tf = { scale: 1, toScreen: (p: { x: number; y: number }) => p };
    drawEntity(context, state.entities[0]!, tf, state.layers, lookup);
    expect(strokes.map((alpha) => Math.round(alpha * 255))).toEqual(expected);
    expect(context.globalAlpha).toBe(1);
    strokes.length = 0; drawEntity(context, state.entities[0]!, tf, state.layers, lookup, { alpha: 0.4 });
    expect(strokes.map((alpha) => Math.round(alpha * 255 / 0.4))).toEqual(expected);
  });
  it.each(['color', 'monochrome', 'grayscale'] as const)('writes actual stroke/fill ExtGState opacity for %s PDF plots and resets opaque', (mode) => {
    const s = { ...state, entities: [state.entities[0]!, state.entities[3]!] };
    const pages = plotPages(s, lookup, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    const style = { mode, lineweights: true, usePlotStyles: true };
    const rendered = renderPdfPages(pages, drawingContext(s, lookup), style);
    expect(rendered[0]?.content.match(/\/A\d+ gs/g)).toEqual([...expected, 255].filter((alpha, i, a) => i === 0 || alpha !== a[i - 1]).map((alpha) => `/A${alpha} gs`));
    const pdf = parsePdfBasics(vectorPdf(pages, drawingContext(s, lookup), style));
    expect(pdf.errors).toEqual([]);
    const resources = [...pdf.objects.values()].filter((o) => dictValue(o.dict, 'Type') === '/ExtGState');
    expect(resources.length).toBeGreaterThan(0);
    const alphaValues = resources.map((o) => Number(dictValue(o.dict, 'ca')));
    for (const alpha of [...new Set([...expected, 255])]) expect(alphaValues.some((value) => Math.abs(value - alpha / 255) < 0.001)).toBe(true);
    for (const resource of resources) expect(dictValue(resource.dict, 'CA')).toBe(dictValue(resource.dict, 'ca'));
  });
});

describe('DWG exposed appearance fields', () => {
  const line = (transparencyType: number, transparency: number): DwgEntity => ({ type: 'LINE', layer: 'L', colorIndex: 1, color: 0xabcdef, colorName: 'Book$Pearl', transparencyType, transparency, startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } } as unknown as DwgEntity);
  it('uses LibreDWG alpha_type 0/1/3 rather than treating a byte as serialized DXF', () => {
    const payload: DwgImportPayload = { header: {}, blocks: [], layers: [{ name: 'L', colorIndex: 256, color: 0x123456, colorName: 'Book$Teal', transparency: 64, off: false, frozen: false, locked: false, lineweight: 0 }], entities: [line(0, 0), line(1, 0), line(3, 0), line(3, 128), line(3, 255), line(3, 256)] };
    const imported = convertDwg(payload);
    expect(imported.state.entities.map((e) => e.transparency)).toEqual([undefined, 'ByBlock', 0, 128, 255, undefined]);
    expect(imported.state.entities.map((e) => Math.round(resolveAlpha(e, imported.state.layers) * 255))).toEqual([64, 255, 0, 128, 255, 64]);
    expect(imported.state.entities[0]).toMatchObject({ color: 1, trueColor: 0xabcdef, colorName: 'Book$Pearl' });
    expect(readDxf(writeDxf(imported.state)).layers.find((l) => l.name === 'L')).toMatchObject({ colorName: 'Book$Teal', transparency: 64 });
    expect(JSON.stringify(imported.report)).toContain('invalid or unexposed DWG transparency');
  });
  it('passes exposed layer fields through payload trimming and does not interpret default zero as fully transparent', () => {
    const db = { header: {}, entities: [line(3, 128)], tables: { LAYER: { entries: [{ name: 'L', colorIndex: 3, colorName: 'Book$Green', transparency: 0, off: false, frozen: false, locked: false, lineweight: 0 }] } } } as unknown as DwgDatabase;
    const payload = toImportPayload(db);
    expect(payload.layers[0]).toMatchObject({ colorName: 'Book$Green', transparency: 0 });
    expect(resolveAlpha({ layer: 'L' }, convertDwg(payload).state.layers)).toBe(1);
  });
});
