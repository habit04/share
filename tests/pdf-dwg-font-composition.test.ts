import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import type { BlockLookup, Entity, TextEntity } from '../src/core/entities';
import type { FontMetricsRequest, NativeFontMetrics } from '../src/core/text-metrics';
import { capturedPdfLookup, pdfFontKey, type PdfFontReader } from '../src/app/pdf-fonts';
import type { PdfFontFace } from '../src/io/pdf-fonts';
import { textStylesOf } from '../src/io/encoding';
import { drawingContext, vectorPdf, type PdfPageSpec } from '../src/io/pdf-vector';
import { DrawingShxResources } from '../src/render/drawing-shx';
import { dictValue, pageContents, pageFonts, parsePdfBasics } from './helpers/pdf';
import { compositeGlyph, fontCollection, fontTable, manyPointGlyph, nativeFontFixture, simpleGlyph } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { fontRecords, shxFixture } from './helpers/shx-fixture';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Uint8Array, options?: { usedCodepoints?: Iterable<number> }): NativeFontMetrics;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: FontMetricsRequest, options: { fontsDirectory: string }): Promise<Omit<PdfFontFace, 'key'>>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(bytes: Uint8Array, faceIndex: number): Buffer;
};

const FONT_ROOT = path.resolve(tmpdir(), 'jcad-pdf-dwg-font-composition');
const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const relative = path.relative(FONT_ROOT, directory);
    if (!relative.startsWith('case-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected composition fixture directory');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const style = (name = 'SHX', font = 'missing-source.shx') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const text = (id = 'text', extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'SHX', text: 'A中B', position: { x: 10, y: 20 }, height: 7.3, rotation: 0, align: 'left', ...extra });
const drawing = (entities: readonly Entity[] = [text()]) => new Drawing({ entities: [...entities], meta: { textStyles: { SHX: style(), OTHER: style('OTHER', 'other-missing.shx') } } });
const page = (entities: readonly Entity[]): PdfPageSpec => ({ width: 300, height: 200, label: 'Composed fonts', groups: [{ entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] });
type Prepared = Awaited<ReturnType<typeof capturedPdfLookup>>;
function render(doc: Drawing, prepared: Prepared, entities = doc.entities) {
  return vectorPdf([page(entities)], { ...drawingContext(doc.snapshot, prepared.lookup), textGeometry: prepared.geometry, embeddedFonts: prepared.fonts });
}
function programs(pdf: ReturnType<typeof parsePdfBasics>) {
  return [...pdf.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!);
}
function unicode(pdf: ReturnType<typeof parsePdfBasics>) {
  return [...pdf.objects.values()].filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap')).map((object) => new TextDecoder().decode(object.stream)).join('\n');
}
function unchanged(doc: Drawing) {
  const snapshot = doc.snapshot, history = doc.history(), source = JSON.stringify(snapshot), dirty = doc.dirty;
  return () => {
    expect(doc.snapshot).toBe(snapshot); expect(JSON.stringify(doc.snapshot)).toBe(source);
    expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(dirty);
  };
}
async function actualReader(bytes: Buffer) {
  await fs.mkdir(FONT_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(FONT_ROOT, 'case-')); roots.push(directory);
  await fs.writeFile(path.join(directory, 'simsun.ttc'), bytes);
  const requests: FontMetricsRequest[] = [], admitted: Omit<PdfFontFace, 'key'>[] = [];
  const reader: PdfFontReader = async (request) => {
    requests.push({ ...request, usedCodepoints: request.usedCodepoints ? [...request.usedCodepoints] : undefined });
    try {
      const font = await readWindowsPdfFont(request, { fontsDirectory: directory });
      admitted.push(font); return { font };
    } catch (error) { return { font: null, problem: error instanceof Error ? error.message : String(error) }; }
  };
  return { reader, requests, admitted };
}

/** Rebuild authored tables only, including real per-table and whole-SFNT checksums. */
function replaceTables(source: Buffer, replacements: ReadonlyMap<string, Buffer>): Buffer {
  const tables: { tag: string; bytes: Buffer }[] = [];
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, tag = source.toString('ascii', at, at + 4), start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.push({ tag, bytes: Buffer.from(replacements.get(tag) ?? source.subarray(start, start + length)) });
  }
  tables.find(({ tag }) => tag === 'head')!.bytes.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer) => {
    let sum = 0;
    for (let at = 0; at < bytes.length; at += 4) {
      let word = 0;
      for (let part = 0; part < 4; part++) word = (word * 256 + (bytes[at + part] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  const result = Buffer.alloc(12 + tables.length * 16 + tables.reduce((sum, table) => sum + Math.ceil(table.bytes.length / 4) * 4, 0));
  source.copy(result, 0, 0, 12);
  let offset = 12 + tables.length * 16;
  tables.forEach((table, i) => {
    const at = 12 + i * 16;
    result.write(table.tag, at, 'ascii'); result.writeUInt32BE(checksum(table.bytes), at + 4); result.writeUInt32BE(offset, at + 8); result.writeUInt32BE(table.bytes.length, at + 12);
    table.bytes.copy(result, offset); offset += Math.ceil(table.bytes.length / 4) * 4;
  });
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, fontTable(result, 'head').offset + 8);
  return result;
}
function namedSimSun(source: Buffer): Buffer {
  const named = Buffer.from(pdfFontFixture({ family: 'SimSun' }).bytes), name = fontTable(named, 'name');
  return replaceTables(source, new Map([['name', named.subarray(name.offset, name.offset + name.length)]]));
}
function glyphBytes(program: Uint8Array, glyph: number): Uint8Array {
  const bytes = Buffer.from(program), head = fontTable(bytes, 'head'), loca = fontTable(bytes, 'loca'), glyf = fontTable(bytes, 'glyf');
  const short = bytes.readInt16BE(head.offset + 50) === 0;
  const location = (id: number) => short ? bytes.readUInt16BE(loca.offset + id * 2) * 2 : bytes.readUInt32BE(loca.offset + id * 4);
  return new Uint8Array(bytes.subarray(glyf.offset + location(glyph), glyf.offset + location(glyph + 1)));
}

// Every heavy glyph fits maxp's uint16 field individually, but their aggregate
// exceeds the reader's unchanged 2,000,000-point cap. A used-glyph subset can
// genuinely shrink this fixture (unlike the existing 65,536-point fallback case).
const HEAVY_CODES = Array.from({ length: 31 }, (_, i) => 0x4e2e + i);
function heavyFace(): Buffer {
  const source = namedSimSun(nativeFontFixture({ family: 'SimSun', extraGlyphs: [simpleGlyph([0, 0, 600, 700]), ...HEAVY_CODES.map(() => manyPointGlyph(65535))], cmapExtra: [[0x4e2d, 5], ...HEAVY_CODES.map((code, i) => [code, i + 6] as const)] }));
  const maxp = fontTable(source, 'maxp'), maxima = Buffer.from(source.subarray(maxp.offset, maxp.offset + maxp.length));
  maxima.writeUInt16BE(65535, 6);
  return replaceTables(source, new Map([['maxp', maxima]]));
}
const HEAVY = heavyFace();

describe('DWG Unicode fallback × captured PDF font admission (F4)', () => {
  it('merges used sets under the actual fallback face, selects nonzero TTC face, and subsets an over-budget whole face', async () => {
    expect(() => parseFontMetrics(HEAVY)).toThrow(/glyph point work exceeds the safe limit/);
    const other = Buffer.from(pdfFontFixture({ family: 'Other Fixture', fsType: 2 }).bytes), collection = fontCollection(other, HEAVY);
    const source = extractTtcFace(collection, 1), host = await actualReader(collection);
    const doc = drawing([text('first', { text: 'A中' }), text('second', { style: 'OTHER', text: 'B中' })]), verify = unchanged(doc);
    const prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.requests).toEqual([{ font: 'simsun.ttc', family: 'SimSun', bold: false, italic: false, usedCodepoints: [0x41, 0x42, 0x4e2d] }]);
    expect(host.admitted).toHaveLength(1); expect(host.admitted[0]!.metrics).toMatchObject({ family: 'SimSun', faceIndex: 1, fsType: 0 });
    expect(Buffer.from(host.admitted[0]!.bytes)).toEqual(source);
    expect(host.admitted[0]!.metrics.glyphBoundsKnown?.[5]).toBe(true);
    expect(host.admitted[0]!.metrics.glyphBoundsKnown?.[6]).toBe(false);
    expect(prepared.issues).toEqual([]);
    const pdf = parsePdfBasics(render(doc, prepared)), embedded = programs(pdf);
    expect(pdf.errors).toEqual([]); expect(embedded).toHaveLength(1); expect(embedded[0]!.length).toBeLessThan(source.length);
    expect(glyphBytes(embedded[0]!, 5).subarray(0, glyphBytes(source, 5).length)).toEqual(glyphBytes(source, 5));
    expect(glyphBytes(embedded[0]!, 6)).toHaveLength(0);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'AAAAAA+JCadSimSunRegular' });
    expect(unicode(pdf)).toContain('<0001> <0041>\n<0002> <4E2D>\n<0003> <0042>');
    const styles = textStylesOf(doc.snapshot);
    expect([styles.SHX!.font, styles.OTHER!.font]).toEqual(['missing-source.shx', 'other-missing.shx']); verify();
  });

  it('gives an available Unicode SHX run priority in captured PDF without any TrueType read', async () => {
    const resources = new DrawingShxResources(), bytes = shxFixture('unifont', [...fontRecords, { code: 0x4e2d, program: [8, 5, 10, 8, 5, -10, 0] }]);
    const sha256 = createHash('sha256').update(bytes).digest('hex'), resolvedPath = 'C:\\authored\\missing-source.shx';
    await resources.load({ bytes, sha256, resolvedPath, resourceId: JSON.stringify([resolvedPath, sha256]) });
    const doc = drawing([text('native', { text: 'A中' })]), verify = unchanged(doc);
    const styles = { SHX: style() }, geometry = resources.capture(styles, true);
    const lookup: BlockLookup = Object.assign((name: string) => doc.snapshot.blocks[name], { textGeometry: geometry });
    let reads = 0;
    const prepared = await capturedPdfLookup(doc.snapshot, async () => { reads++; throw new Error('Native SHX must retain priority'); }, undefined, lookup);
    expect(prepared.geometry!.resolve(doc.entities[0]! as TextEntity)).toMatchObject({ kind: 'stroke', shxResourceId: expect.any(String) });
    const pdf = parsePdfBasics(render(doc, prepared));
    expect(reads).toBe(0); expect(prepared.issues).toEqual([]); expect(pdf.errors).toEqual([]);
    expect(programs(pdf)).toHaveLength(0); expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({});
    expect(pageContents(pdf, (data) => new Uint8Array(inflateSync(data)))[0]).toMatch(/\bm\b[\s\S]*\bl\b[\s\S]*\bS\b/); verify();
  });

  it('keeps used-set point-budget refusal explicit for missing-SHX Han instead of plotting question-mark strokes', async () => {
    const host = await actualReader(HEAVY), doc = drawing([text('over-cap', { text: String.fromCodePoint(...HEAVY_CODES) })]), verify = unchanged(doc);
    const prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.requests[0]!.usedCodepoints).toEqual(HEAVY_CODES);
    expect(host.admitted).toHaveLength(0); expect(prepared.issues.join(' ')).toContain('glyph point work exceeds the safe limit');
    expect(() => render(doc, prepared)).toThrow(/Unicode text.*Raster image/); expect(prepared.fonts!.usedFaces).toBe(0); verify();
  });

  it('does not encode an unvalidated Han glyph outside the captured fallback used set', async () => {
    const host = await actualReader(HEAVY), doc = drawing([text('captured', { text: 'A中' })]), verify = unchanged(doc);
    const prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(prepared.issues).toEqual([]);
    const appearance = prepared.geometry!.resolve(doc.entities[0]! as TextEntity);
    if (appearance.kind !== 'canvas') throw new Error('Expected the final Unicode face');
    expect(prepared.fonts!.encode(pdfFontKey(appearance), '\u4e2e')).toBeNull();
    expect(() => render(doc, prepared, [text('outside-capture', { text: '\u4e2e' })])).toThrow(/Unicode text.*Raster image/);
    expect(prepared.fonts!.usedFaces).toBe(0); verify();
  });

  it.each(['origin', 'bitmap'] as const)('keeps a used Han glyph with unknown %s bounds on explicit raster guidance', async (kind) => {
    const shifted = compositeGlyph(2, [-10, 0, 630, 730], 0x0202); shifted.writeInt8(10, 14);
    const source = namedSimSun(nativeFontFixture({ family: 'SimSun', extraGlyphs: [kind === 'origin' ? shifted : manyPointGlyph(4)], cmapExtra: [[0x4e2d, 5]], ...(kind === 'bitmap' ? { bitmapGlyphRange: [5, 5] as const } : {}) }));
    const host = await actualReader(source), doc = drawing(), verify = unchanged(doc), prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.admitted).toHaveLength(1); expect(host.admitted[0]!.metrics.glyphBoundsKnown?.[2]).toBe(true);
    expect(host.admitted[0]!.metrics.glyphBoundsKnown?.[5]).toBe(false); expect(prepared.issues).toEqual([]);
    expect(() => render(doc, prepared)).toThrow(/Unicode text.*Raster image/); expect(prepared.fonts!.usedFaces).toBe(0); verify();
  });

  it.each([[2, /restricted/], [4, /read-only/], [0x0208, /bitmap-only/]] as const)('retains fsType %i refusal after fallback selection and reports raster guidance', async (fsType, problem) => {
    const source = Buffer.from(pdfFontFixture({ family: 'SimSun', unicodeCodePoint: 0x4e2d, fsType }).bytes), host = await actualReader(source);
    const doc = drawing(), verify = unchanged(doc), prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.requests[0]).toMatchObject({ font: 'simsun.ttc', family: 'SimSun', usedCodepoints: [0x41, 0x42, 0x4e2d] });
    expect(host.admitted).toHaveLength(0); expect(prepared.issues.join(' ')).toMatch(problem);
    expect(() => render(doc, prepared)).toThrow(/Unicode text.*Raster image/); verify();
  });

  it('also refuses declared TrueType Han when admission fails, without relying on the stroke-fallback flag', async () => {
    const source = Buffer.from(pdfFontFixture({ family: 'SimSun', unicodeCodePoint: 0x4e2d, fsType: 4 }).bytes), host = await actualReader(source);
    const doc = new Drawing({ entities: [text()], meta: { textStyles: { SHX: style('SHX', 'simsun.ttc') } } }), verify = unchanged(doc);
    const prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.requests[0]).toMatchObject({ font: 'simsun.ttc', family: 'SimSun', usedCodepoints: [0x41, 0x42, 0x4e2d] });
    expect(prepared.issues.join(' ')).toContain('read-only'); expect(host.admitted).toHaveLength(0);
    expect(() => render(doc, prepared)).toThrow(/Unicode text.*Raster image/); verify();
  });

  it('retains whole-program no-subsetting permission through missing-SHX fallback and nonzero-face extraction', async () => {
    const selected = Buffer.from(pdfFontFixture({ family: 'SimSun', unicodeCodePoint: 0x4e2d, fsType: 0x0108 }).bytes);
    const collection = fontCollection(Buffer.from(pdfFontFixture({ family: 'Other Fixture' }).bytes), selected), host = await actualReader(collection);
    const doc = drawing(), verify = unchanged(doc), prepared = await capturedPdfLookup(doc.snapshot, host.reader);
    expect(host.admitted[0]!.metrics.faceIndex).toBe(1); expect(prepared.issues).toEqual([]);
    const pdf = parsePdfBasics(render(doc, prepared));
    expect(programs(pdf)).toEqual([new Uint8Array(extractTtcFace(collection, 1))]);
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'JCadSimSunRegular' });
    expect(unicode(pdf)).toContain('<4E2D>'); verify();
  });
});
