import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Drawing } from '../src/core/document';
import { mtextParts, textBounds, type MTextEntity, type TextEntity } from '../src/core/entities';
import { STANDARD_TEXT_STYLE, textStylesOf } from '../src/io/encoding';
import { metricTextPlacement } from '../src/core/text-metrics';
import { createTextGeometryContext, FontMetricsRegistry } from '../src/render/font-metrics';
import { drawStyledText, hasStrokeGlyphs, textRenderer, UNICODE_FONT_STACK } from '../src/render/hershey';
import { DrawingShxResources } from '../src/render/drawing-shx';
import { capturedPdfLookup } from '../src/app/pdf-fonts';
import { drawingContext, vectorPdf, type PdfPageSpec } from '../src/io/pdf-vector';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { fontRecords, shxFixture } from './helpers/shx-fixture';

const styles = { HZ: { ...STANDARD_TEXT_STYLE, name: 'HZ', font: 'authored.shx', widthFactor: 0.8, oblique: 10 } };
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 't', type: 'text', layer: '0', color: 'ByLayer', style: 'HZ', text: '中', position: { x: 10, y: 20 }, height: 10, rotation: 0, align: 'left', ...patch });
const resource = (bytes: Uint8Array) => {
  const sha256 = createHash('sha256').update(bytes).digest('hex'), resolvedPath = 'C:\\authored\\authored.shx';
  return { bytes, sha256, resolvedPath, resourceId: JSON.stringify([resolvedPath, sha256]) };
};
/** Authored deterministic Canvas backend: exercises routing/metrics, not Windows glyph fidelity. */
function canvasBackend() {
  const measure = { font: '', fontKerning: 'none', measureText(value: string) {
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 256);
    const width = Array.from(value).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 127 ? 1 : 0.5), 0) * size;
    return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: 0, fontBoundingBoxDescent: size * 0.2 };
  } };
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return measure; } });
}
afterEach(() => vi.unstubAllGlobals());

describe('glyph-aware Unicode stroke substitutes', () => {
  it('keeps supported CAD strokes and chooses Unicode only for missing glyphs', () => {
    expect(hasStrokeGlyphs('A%%c%%d%%p %%uB')).toBe(true);
    expect(hasStrokeGlyphs('A\nB\tC')).toBe(true);
    expect(hasStrokeGlyphs('系统图')).toBe(false);
    expect(textRenderer('HZ', styles, 'A%%c').kind).toBe('stroke');
    const face = textRenderer('HZ', styles, '系统图');
    expect(face).toMatchObject({ kind: 'canvas', family: UNICODE_FONT_STACK, strokeFallback: true, widthFactor: 0.8 });
    expect(face.oblique).toBeCloseTo(Math.PI / 18);
    expect(textRenderer('MISSING', {}, '系统图').kind).toBe('canvas');
  });

  it('uses the same complete Unicode run for painting, fitting and bounds without changing the source', () => {
    canvasBackend();
    const geometry = createTextGeometryContext(styles, new FontMetricsRegistry());
    const t = text({ text: '中A中', align: 'center', widthFactor: 1, oblique: 0 });
    const before = JSON.stringify(t), placed = metricTextPlacement(t, geometry), bounds = textBounds(t, geometry);
    expect(placed.appearance.kind).toBe('canvas');
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(2.5 * t.height / 0.7);
    expect((bounds.max.x + bounds.min.x) / 2).toBeCloseTo(t.position.x);
    const draws: string[] = [];
    const ctx = { font: '', textAlign: 'left', textBaseline: 'alphabetic', save() {}, restore() {}, translate() {}, rotate() {}, transform() {}, scale() {}, fillText(value: string) { draws.push(value); } } as unknown as CanvasRenderingContext2D;
    expect(drawStyledText(ctx, t, { scale: 5, toScreen: (p) => p }, 'HZ', geometry)).toBe(true);
    expect(draws).toEqual(['中A中']);
    expect(ctx.font).toContain('SimSun');
    expect(JSON.stringify(t)).toBe(before);
    expect([...geometry.fontIssues!].join(' ')).toContain('Unicode font substitute');
    const fit = metricTextPlacement(text({ text: '中A中', widthFactor: 1, justification: { horizontal: 5, vertical: 0 }, alignmentPoint: { x: 110, y: 20 } }), geometry);
    expect(fit.text.widthFactor * fit.metrics.advance).toBeCloseTo(100);
  });

  it('wraps MTEXT with the same Unicode advances used to paint its generated pieces', () => {
    canvasBackend();
    const geometry = createTextGeometryContext(styles, new FontMetricsRegistry());
    const m: MTextEntity = { id: 'm', type: 'mtext', layer: '0', color: 1, style: 'HZ', text: '中中 中中', position: { x: 0, y: 0 }, height: 1, width: 3, rotation: 0, attachment: 1, lineSpacing: 1 };
    const pieces = mtextParts(m, geometry);
    expect(pieces.map((p) => p.text)).toEqual(['中中', '中中']);
    expect(pieces[1]!.position.y).toBeLessThan(pieces[0]!.position.y);
    for (const piece of pieces) {
      expect(geometry.resolve(piece).kind).toBe('canvas');
      expect(textBounds(piece, geometry).max.x - textBounds(piece, geometry).min.x).toBeLessThanOrEqual(m.width);
    }
  });

  it('prefers an authored SHX glyph when available and falls back for a missing run', async () => {
    const fonts = new DrawingShxResources();
    await fonts.load(resource(shxFixture('unifont', [...fontRecords, { code: '中'.codePointAt(0)!, program: [8, 5, 10, 8, 5, -10, 0] }])));
    const geometry = fonts.geometry(styles);
    const supported = geometry.resolve(text());
    expect(supported).toMatchObject({ kind: 'stroke', shxResourceId: expect.any(String) });
    expect(geometry.shxRun!('中', 10, supported)).toMatchObject({ ok: true });
    expect(geometry.resolve(text({ text: '中系统图' }))).toMatchObject({ kind: 'canvas', strokeFallback: true });
    expect([...geometry.fontIssues!].join(' ')).toContain('Unicode font substitute');
  });
});

describe('Unicode font selection in captured PDF output', () => {
  const page = (entities: readonly TextEntity[]): PdfPageSpec => ({ width: 200, height: 200, label: 'Unicode', groups: [{ entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] });
  it('requests and embeds an authored Unicode substitute rather than the source SHX identity', async () => {
    const doc = new Drawing({ entities: [text({ text: 'A中B' })], meta: { textStyles: styles } });
    const requests: string[] = [];
    const prepared = await capturedPdfLookup(doc.snapshot, async (request) => {
      requests.push(request.font);
      return { font: pdfFontFixture({ family: 'SimSun', unicodeCodePoint: '中'.codePointAt(0)! }) };
    });
    expect(requests).toEqual(['simsun.ttc']);
    const ctx = { ...drawingContext(doc.snapshot, prepared.lookup), textGeometry: prepared.geometry, embeddedFonts: prepared.fonts };
    const pdf = new TextDecoder('latin1').decode(vectorPdf([page(doc.entities as TextEntity[])], ctx));
    expect(pdf).toContain('/FontFile2');
    expect(pdf).toContain('<4E2D>');
    expect(prepared.fonts!.usedFaces).toBe(1);
    expect(textStylesOf(doc.snapshot).HZ!.font).toBe('authored.shx');
  });

  it('refuses unreadable vector substitutes and names the readable raster option when embedding is unavailable', async () => {
    const doc = new Drawing({ entities: [text()], meta: { textStyles: styles } });
    const prepared = await capturedPdfLookup(doc.snapshot, async () => ({ font: null, problem: 'not installed' }));
    expect(prepared.issues.join(' ')).toContain('not installed');
    const ctx = { ...drawingContext(doc.snapshot, prepared.lookup), textGeometry: prepared.geometry, embeddedFonts: prepared.fonts };
    expect(() => vectorPdf([page(doc.entities as TextEntity[])], ctx)).toThrow(/Unicode text.*Raster image/);
  });
});
