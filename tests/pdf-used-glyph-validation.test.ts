import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import type { TextEntity, Entity } from '../src/core/entities';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import { capturedPdfLookup, pdfFontKey, type PdfFontReader } from '../src/app/pdf-fonts';
import { vectorPdfCompressed, drawingContext, type PdfPageSpec, type PdfDrawingContext } from '../src/io/pdf-vector';
import { parsePdfBasics, dictValue, pageContents, pageFonts } from './helpers/pdf';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { compositeGlyph, fontTable, manyPointGlyph, nativeFontFixture } from './helpers/native-font-fixture';

const require = createRequire(import.meta.url);
type Request = { font: string; family?: string; bold?: boolean; italic?: boolean; usedCodepoints?: readonly number[] };
type Options = { fontsDirectory?: string };
type Data = { bytes: Uint8Array; metrics: NativeFontMetrics & { resolvedFilename: string } };
type Face = Data & { postscriptName: string; ascender: number; descender: number; italicAngle: number; weight: number; isFixedPitch: boolean; os2Version: number };
const { parseFontMetrics, readWindowsFontData, readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Uint8Array, options?: { usedCodepoints?: Iterable<number> }): NativeFontMetrics;
  readWindowsFontData(request: Request, options?: Options): Promise<Data>;
  readWindowsFontMetrics(request: Request, options?: Options): Promise<Data['metrics']>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options?: Options): Promise<Face>;
};

/**
 * SimSun-shaped authored fixture: a light native face (space/A/B) plus 31 heavy
 * glyphs of 65,536 points each (2,031,616 heavy points in total, over the
 * 2,000,000 whole-face cap). cmapExtra maps U+4E2D..U+4E4B onto the heavy
 * glyphs 5..35, the way a CJK face maps its ideographs; the bulk is real but
 * no plotted Latin run ever uses it.
 */
const HEAVY_GLYPHS = 31, HEAVY_POINTS = 65536, FIRST_HEAVY_CODE = 0x4e2d;
const heavyCodes = Array.from({ length: HEAVY_GLYPHS }, (_, i) => FIRST_HEAVY_CODE + i);
const heavyPairs = heavyCodes.map((code, i) => [code, 5 + i] as const);
function heavyFixture(extra: { composite?: boolean; fsType?: number } = {}): Buffer {
  const glyphs: Buffer[] = Array.from({ length: HEAVY_GLYPHS }, () => manyPointGlyph(HEAVY_POINTS));
  const pairs: (readonly [number, number])[] = [...heavyPairs];
  if (extra.composite) {
    // Glyph 36 is a composite whose only component is heavy glyph 5.
    glyphs.push(compositeGlyph(5, [-20, 0, 620, 730]));
    pairs.push([0x4e60, 5 + HEAVY_GLYPHS]);
  }
  return nativeFontFixture({ family: 'Simsunlike', fsType: extra.fsType ?? 0, extraGlyphs: glyphs, cmapExtra: pairs });
}
const HEAVY = heavyFixture();
const HEAVY_COMPOSITE = heavyFixture({ composite: true });

/** Graft a nameID6 record onto an authored fixture, rebuilding its table directory. */
function withPostscriptName(source: Buffer, postscriptName: string): Buffer {
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.set(source.toString('ascii', at, at + 4), Buffer.from(source.subarray(start, start + length)));
  }
  const name = tables.get('name')!, storage = name.readUInt16BE(4);
  const records = Array.from({ length: name.readUInt16BE(2) }, (_, i) => {
    const at = 6 + i * 12, length = name.readUInt16BE(at + 8), start = storage + name.readUInt16BE(at + 10);
    return { platform: name.readUInt16BE(at), encoding: name.readUInt16BE(at + 2), language: name.readUInt16BE(at + 4), id: name.readUInt16BE(at + 6), bytes: Buffer.from(name.subarray(start, start + length)) };
  });
  records.push({ platform: 3, encoding: 1, language: 0x0409, id: 6, bytes: Buffer.from(postscriptName, 'utf16le').swap16() });
  const newStorage = 6 + records.length * 12, names = Buffer.alloc(newStorage + records.reduce((sum, record) => sum + record.bytes.length, 0));
  names.writeUInt16BE(records.length, 2); names.writeUInt16BE(newStorage, 4);
  let position = 0;
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, position].forEach((value, part) => names.writeUInt16BE(value, at + part * 2));
    record.bytes.copy(names, newStorage + position); position += record.bytes.length;
  });
  tables.set('name', names); tables.get('head')!.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer) => {
    let sum = 0;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      let word = 0;
      for (let i = 0; i < 4; i++) word = (word * 256 + (bytes[offset + i] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
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

const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-used-glyph-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-used-glyph-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected used-glyph test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function writeFont(bytes: Buffer, filename = 'simsunlike.ttf'): Promise<string> {
  const fontsDirectory = await privateDirectory();
  await fs.writeFile(path.join(fontsDirectory, filename), bytes);
  return fontsDirectory;
}

describe('used-glyph point validation (SimSun-shaped faces)', () => {
  it('still refuses an eager whole-face parse over the unchanged point cap', () => {
    expect(() => parseFontMetrics(HEAVY)).toThrow(/glyph point work exceeds the safe limit/);
  });

  it('admits a used set of light glyphs and marks every heavy glyph unvalidated', () => {
    const metrics = parseFontMetrics(HEAVY, { usedCodepoints: [0x20, 0x41, 0x42] });
    expect(metrics.capitalHeight).toBe(730);
    expect(metrics.cmap[0x41]).toBe(2);
    expect(metrics.cmap[FIRST_HEAVY_CODE]).toBe(5);
    expect(metrics.glyphBoundsKnown![2]).toBe(true);
    for (let glyph = 5; glyph < 5 + HEAVY_GLYPHS; glyph++) expect(metrics.glyphBoundsKnown![glyph]).toBe(false);
    // Advances and cmap are header data: identical to a light fixture's parse.
    const light = parseFontMetrics(nativeFontFixture({ family: 'Simsunlike' }));
    expect(metrics.advances.slice(0, 5)).toEqual(light.advances);
    expect(metrics.advances[5]).toBe(650);
  });

  it('validates exactly the one heavy glyph the used set names', () => {
    const metrics = parseFontMetrics(HEAVY, { usedCodepoints: [0x20, 0x41, FIRST_HEAVY_CODE] });
    expect(metrics.glyphBoundsKnown![5]).toBe(true);
    expect(metrics.glyphBounds[5]).toEqual([0, 0, 100, 100]);
    expect(metrics.glyphBoundsKnown![6]).toBe(false);
  });

  it('still refuses when the used set itself exceeds the unchanged cap', () => {
    expect(() => parseFontMetrics(HEAVY, { usedCodepoints: heavyCodes })).toThrow(/glyph point work exceeds the safe limit/);
  });

  it('validates the component closure of a used composite glyph', () => {
    const metrics = parseFontMetrics(HEAVY_COMPOSITE, { usedCodepoints: [0x20, 0x41, 0x4e60] });
    const composite = 5 + HEAVY_GLYPHS;
    expect(metrics.glyphBoundsKnown![composite]).toBe(true);
    expect(metrics.glyphBoundsKnown![5]).toBe(true);
    expect(metrics.glyphBoundsKnown![6]).toBe(false);
  });

  it('leaves an unused composite glyph unvalidated with its closure', () => {
    const metrics = parseFontMetrics(HEAVY_COMPOSITE, { usedCodepoints: [0x20, 0x41, 0x42] });
    expect(metrics.glyphBoundsKnown![5 + HEAVY_GLYPHS]).toBe(false);
    expect(metrics.glyphBoundsKnown![5]).toBe(false);
  });

  it('always validates capital A, even when the used set omits it', () => {
    const metrics = parseFontMetrics(HEAVY, { usedCodepoints: [0x42] });
    expect(metrics.glyphBoundsKnown![2]).toBe(true);
    expect(metrics.capitalHeight).toBe(730);
    expect(metrics.glyphBoundsKnown![3]).toBe(true);
    expect(metrics.glyphBoundsKnown![4]).toBe(false);
  });

  it('keeps ordinary faces fully validated when no used set is given, and marks only unused glyphs when one is', () => {
    const light = nativeFontFixture();
    const eager = parseFontMetrics(light);
    expect(eager.glyphBoundsKnown!.every(Boolean)).toBe(true);
    const partial = parseFontMetrics(light, { usedCodepoints: [0x42] });
    expect(partial.glyphBoundsKnown![2]).toBe(true);
    expect(partial.glyphBoundsKnown![3]).toBe(true);
    expect(partial.glyphBoundsKnown![4]).toBe(false);
    // The empty space glyph has no points to validate; it stays known either way.
    expect(partial.glyphBoundsKnown![1]).toBe(true);
  });

  it('rejects malformed used sets at the parser boundary', () => {
    const light = nativeFontFixture();
    expect(() => parseFontMetrics(light, { usedCodepoints: [0x110000] })).toThrow(/used codepoint/);
    expect(() => parseFontMetrics(light, { usedCodepoints: [-1] })).toThrow(/used codepoint/);
    expect(() => parseFontMetrics(light, { usedCodepoints: [65.5] })).toThrow(/used codepoint/);
    expect(() => parseFontMetrics(light, { usedCodepoints: Array.from({ length: 65535 }, () => 0x41) })).toThrow(/used codepoint/);
  });

  it('reader level: the metrics readers keep refusing, the PDF reader admits with a used set', async () => {
    const fontsDirectory = await writeFont(HEAVY);
    const request: Request = { font: 'simsunlike.ttf', family: 'Simsunlike' };
    await expect(readWindowsFontData(request, { fontsDirectory })).rejects.toThrow(/glyph point work exceeds the safe limit/);
    await expect(readWindowsFontMetrics({ ...request, usedCodepoints: [0x20, 0x41, 0x42] }, { fontsDirectory }))
      .rejects.toThrow(/glyph point work exceeds the safe limit/);
    const data = await readWindowsFontData({ ...request, usedCodepoints: [0x20, 0x41, 0x42] }, { fontsDirectory });
    expect(data.metrics.glyphBoundsKnown![5]).toBe(false);
    expect(data.metrics.glyphBoundsKnown![2]).toBe(true);
  });

  it('reader level: embedding permissions are not bypassed by a used set', async () => {
    const restricted = withPostscriptName(heavyFixture({ fsType: 2 }), 'Simsunlike-Regular');
    const fontsDirectory = await writeFont(restricted);
    await expect(readWindowsPdfFont({ font: 'simsunlike.ttf', family: 'Simsunlike', usedCodepoints: [0x20, 0x41, 0x42] }, { fontsDirectory }))
      .rejects.toThrow(/restricted/);
    const editable = withPostscriptName(HEAVY, 'Simsunlike-Regular');
    const editableDirectory = await writeFont(editable);
    const face = await readWindowsPdfFont({ font: 'simsunlike.ttf', family: 'Simsunlike', usedCodepoints: [0x20, 0x41, 0x42] }, { fontsDirectory: editableDirectory });
    expect(face.postscriptName).toBe('Simsunlike-Regular');
    expect(face.bytes).toEqual(editable);
    expect(face.metrics.glyphBoundsKnown![5]).toBe(false);
  });
});

describe('captured-PDF used-codepoint plumbing', () => {
  const style = (name = 'FACE', font = 'simsunlike.ttf') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
  const text = (id = 'text', extra: Partial<TextEntity> = {}): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left', ...extra });
  const plotStyle = { mode: 'color' as const, lineweights: true, usePlotStyles: false };
  function page(entities: readonly Entity[]): PdfPageSpec {
    return { width: 300, height: 200, label: 'Sheet', groups: [{ entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
  }
  function embeddedPrograms(info: ReturnType<typeof parsePdfBasics>) { return [...info.objects.values()].filter((object) => dictValue(object.dict, 'Length1') !== null).map((object) => object.stream!); }
  function unicodeText(info: ReturnType<typeof parsePdfBasics>) { return [...info.objects.values()].filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap')).map((object) => new TextDecoder().decode(object.stream)).join('\n'); }

  it('sends the plotted strings codepoints with the PDF font request', async () => {
    const seen: Request[] = [];
    const reader: PdfFontReader = async (request) => { seen.push(request); return { font: pdfFontFixture({ family: 'Arial' }) }; };
    const doc = new Drawing({ entities: [text('first', { text: 'A\u4e2dB' })], meta: { textStyles: { FACE: style('FACE', 'arial.ttf') } } });
    await capturedPdfLookup(doc.snapshot, reader);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.usedCodepoints).toEqual([0x41, 0x42, 0x4e2d]);
  });

  it('keys collection to the finally resolved face, not the style (F1)', async () => {
    // Two styles naming the same font resolve to one final face; both runs'
    // characters must arrive merged in that face's single request.
    const seen: Request[] = [];
    const reader: PdfFontReader = async (request) => { seen.push(request); return { font: pdfFontFixture({ family: 'Arial' }) }; };
    const doc = new Drawing({
      entities: [text('first', { text: 'A' }), text('second', { style: 'ALT', text: 'B' })],
      meta: { textStyles: { FACE: style('FACE', 'arial.ttf'), ALT: style('ALT', 'arial.ttf') } },
    });
    await capturedPdfLookup(doc.snapshot, reader);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.usedCodepoints).toEqual([0x41, 0x42]);
  });

  it('keeps a clear refusal when the plotted used set itself exceeds the cap (F3)', async () => {
    const bytes = withPostscriptName(HEAVY, 'Simsunlike-Regular');
    const fontsDirectory = await writeFont(bytes);
    const reader: PdfFontReader = async (request) => {
      try { return { font: await readWindowsPdfFont(request, { fontsDirectory }) }; }
      catch (error) { return { font: null, problem: error instanceof Error ? error.message : 'font unavailable' }; }
    };
    const allHeavy = String.fromCodePoint(...heavyCodes);
    const doc = new Drawing({ entities: [text('first', { text: `A${allHeavy}` })], meta: { textStyles: { FACE: style() } } });
    const result = await capturedPdfLookup(doc.snapshot, reader);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('glyph point work exceeds the safe limit');
    expect(result.fonts?.usedFaces ?? 0).toBe(0);
  });

  it('embeds an over-cap face for the glyphs a drawing uses and never encodes an unvalidated glyph', async () => {
    const bytes = withPostscriptName(HEAVY, 'Simsunlike-Regular');
    const fontsDirectory = await writeFont(bytes);
    const reader: PdfFontReader = async (request) => {
      try { return { font: await readWindowsPdfFont(request, { fontsDirectory }) }; }
      catch (error) { return { font: null, problem: error instanceof Error ? error.message : 'font unavailable' }; }
    };
    const doc = new Drawing({ entities: [text('first', { text: 'A\u4e2d' })], meta: { textStyles: { FACE: style() } } });
    const result = await capturedPdfLookup(doc.snapshot, reader);
    expect(result.issues).toEqual([]);
    const appearance = result.geometry!.resolve({ style: 'FACE' });
    expect(appearance.kind).toBe('canvas');
    const key = pdfFontKey(appearance as Extract<typeof appearance, { kind: 'canvas' }>);
    // U+4E2E maps to heavy glyph 6, which no plotted string used: the writer refuses the run.
    expect(result.fonts!.encode(key, '\u4e2e')).toBeNull();
    expect(result.fonts!.encode(key, 'A\u4e2d')).not.toBeNull();
    const context: PdfDrawingContext = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set() };
    const pdf = parsePdfBasics(await vectorPdfCompressed([page([doc.entities[0]!])], context, plotStyle, 'SimSun', (data) => new Uint8Array(deflateSync(data))));
    expect(pdf.errors).toEqual([]);
    const programs = embeddedPrograms(pdf);
    expect(programs).toHaveLength(1);
    expect(programs[0]).toEqual(new Uint8Array(bytes)); // whole program; this fix does not subset
    expect(pageFonts(pdf, pdf.pages[0]!.num)).toEqual({ JCF1: 'Simsunlike-Regular' });
    expect(unicodeText(pdf)).toContain('<0001> <0041>\n<0002> <4E2D>');
    const contents = pageContents(pdf, (data) => new Uint8Array(inflateSync(data)));
    expect(contents[0]).toContain('<00010002> Tj');
    // Keep the exact bytes for the independent pypdf/Poppler validation step.
    await fs.mkdir(path.join(process.cwd(), '..', 'validation-simsun'), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), '..', 'validation-simsun', 'simsun-used-glyphs.pdf'), await vectorPdfCompressed([page([doc.entities[0]!])], context, plotStyle, 'SimSun', (data) => new Uint8Array(deflateSync(data))));
  });
});
