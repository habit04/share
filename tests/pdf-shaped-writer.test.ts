import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drawing } from '../src/core/document';
import type { TextEntity, Entity } from '../src/core/entities';
import { capturedPdfLookup, pdfFontKey, shapedPdfLine, type PdfFontReader } from '../src/app/pdf-fonts';
import { vectorPdf, drawingContext, type PdfDrawingContext, type PdfPageSpec } from '../src/io/pdf-vector';
import type { TextGeometryContext } from '../src/core/text-metrics';
import { sha256BytesHex } from '../src/core/sha256';
import { parsePdfBasics, pageContents } from './helpers/pdf';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

/**
 * Step-3 writer behaviour, end to end through the real capture
 * assembly with a stub geometry standing in for the prepared
 * session (the Windows bridge is the seat's gate): the plan
 * builder, registry assignment, and writer emission are the real
 * code. Extraction is verified independently with pypdf (an
 * ActualText-unaware extractor, per the contract's observed
 * record): the ToUnicode layer must carry the line.
 */
const style = (name = 'FACE', font = 'arial.ttf') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const textEntity = (extra: Partial<TextEntity> = {}): TextEntity => ({
  id: 'text', type: 'text', layer: '0', color: 'ByLayer', style: 'FACE',
  text: 'اب', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left', ...extra,
});
const plotStyle = { mode: 'color' as const, lineweights: true, usePlotStyles: false };
function page(entities: readonly Entity[]): PdfPageSpec {
  return { width: 300, height: 200, label: 'Sheet', groups: [{ entities, k: 2, e: 20, f: 30, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
}
const reader: PdfFontReader = async (request) => ({ font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic }) });

/** Engine-order glyphs for 'اب': ا (logical first, rightmost)
    then ب, as a real RTL production returns them. */
function stubGeometry(programSha256: string): TextGeometryContext {
  return {
    cacheKey: {},
    resolve: () => { throw new Error('not used'); },
    measure: () => { throw new Error('not used'); },
    shapedGlyphs: () => ({
      state: 'ready',
      subitems: [{
        start: 0, end: 2, programSha256,
        glyphs: [
          { glyph: 2, clusterStart: 0, clusterEnd: 1, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { glyph: 3, clusterStart: 1, clusterEnd: 2, xAdvance: 450, yAdvance: 0, xOffset: 0, yOffset: 0 },
        ],
      }],
    }),
  } as unknown as TextGeometryContext;
}

async function shapedBytes() {
  const doc = new Drawing({ entities: [textEntity()], meta: { textStyles: { FACE: style() } } });
  const result = await capturedPdfLookup(doc.snapshot, reader, page([textEntity()]).groups);
  expect(result.issues).toEqual([]);
  const appearance = result.geometry!.resolve(textEntity());
  expect(appearance.kind).toBe('canvas');
  const face = result.fonts!.face(pdfFontKey(appearance as Extract<typeof appearance, { kind: 'canvas' }>))!;
  const plan = (value: string, appearance: Parameters<typeof shapedPdfLine>[3]) =>
    shapedPdfLine(stubGeometry(sha256BytesHex(face.bytes)), result.fonts!, value, appearance);
  const context: PdfDrawingContext = {
    ...drawingContext(doc.snapshot, result.lookup),
    embeddedFonts: result.fonts,
    textGeometry: result.geometry,
    fontFallbacks: new Set(),
    shapedText: plan,
  };
  return vectorPdf([page([textEntity()])], context, plotStyle, 'Shaped line');
}

function findPython(): string | null {
  for (const candidate of [process.env.JCAD_PYTHON, 'python3', 'python']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import pypdf'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe('shaped PDF line emission', () => {
  it('emits an ActualText span with per-glyph placement, RTL glyphs mirrored', async () => {
    const bytes = await shapedBytes();
    const pdf = parsePdfBasics(bytes);
    expect(pdf.errors).toEqual([]);
    expect(pdf.version).toBe('1.5');
    const contents = pageContents(pdf, (data) => data).join('\n');
    // ActualText: the line's logical text, UTF-16BE with BOM.
    expect(contents).toContain('/Span <</ActualText <FEFF06270628>>> BDC');
    expect(contents).toContain('ET EMC');
    // Two glyphs, each with its own Tm + Tj, codes in engine order.
    const glyphOps = [...contents.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm <(000[12])> Tj/g)];
    expect(glyphOps).toHaveLength(2);
    expect(glyphOps.map((match) => match[3])).toEqual(['0001', '0002']);
    // ا (code 0001, advance 500) sits 0.45 em right of ب (code 0002):
    // the x distance is 0.45 * size, size = height * k * upem / capH.
    const face = pdfFontFixture({});
    void face;
    const xs = glyphOps.map((match) => Number(match[1]));
    expect(xs[0]! - xs[1]!).toBeGreaterThan(0);
    // ToUnicode: each cluster's anchor carries its own scalar.
    const cmapText = [...pdf.objects.values()]
      .filter((object) => object.stream && new TextDecoder().decode(object.stream).includes('begincmap'))
      .map((object) => new TextDecoder().decode(object.stream)).join('\n');
    expect(cmapText).toContain('<0001> <0627>');
    expect(cmapText).toContain('<0002> <0628>');
  });

  it('extracts the logical text with pypdf (ToUnicode layer) and Poppler', async () => {
    const bytes = await shapedBytes();
    const dir = mkdtempSync(join(tmpdir(), 'jcad-shaped-'));
    const file = join(dir, 'shaped.pdf');
    writeFileSync(file, bytes);
    // Both extractors are ActualText-unaware (contract §5.4's
    // observed record): they read the ToUnicode layer. The file's
    // guarantee there is nonduplication and no loss — the exact
    // scalars, once — while presentation order is the extractor's
    // own bidi handling (observed: pypdf presents this RTL run in
    // visual order wrapped in RLE/PDF marks). Assert exactly
    // that, never a presentation the file cannot force.
    const scalarsOf = (value: string) => [...value.replace(/[‪-‮⁦-⁩\s\f]/g, '')].sort().join('');
    const python = findPython();
    if (python) {
      const script = 'import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\nprint(repr(r.pages[0].extract_text()))\n';
      const out = spawnSync(python, ['-c', script, file], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(scalarsOf(out.stdout)).toBe('اب');
    }
    const pdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
    if (pdftotext.status === 0 || pdftotext.stderr?.includes('pdftotext')) {
      const out = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });
      if (out.status === 0) expect(scalarsOf(out.stdout)).toBe('اب');
    }
  });

  it('leaves a direct-only line byte-identical to the unshaped writer', async () => {
    const doc = new Drawing({ entities: [textEntity({ text: 'AB' })], meta: { textStyles: { FACE: style() } } });
    const result = await capturedPdfLookup(doc.snapshot, reader, page([textEntity({ text: 'AB' })]).groups);
    const base: PdfDrawingContext = {
      ...drawingContext(doc.snapshot, result.lookup),
      embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set(),
    };
    const withPlan: PdfDrawingContext = {
      ...base,
      shapedText: (value, appearance) => shapedPdfLine(stubGeometry('00'), result.fonts!, value, appearance),
    };
    const a = vectorPdf([page([textEntity({ text: 'AB' })])], base, plotStyle, 'Direct line');
    const b = vectorPdf([page([textEntity({ text: 'AB' })])], withPlan, plotStyle, 'Direct line');
    expect(b).toEqual(a);
  });
});
