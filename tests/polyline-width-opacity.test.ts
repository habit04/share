import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { Drawing, DEFAULT_HEADER } from '../src/core/document';
import type { PolylineEntity } from '../src/core/entities';
import { drawingContext, plotPages, renderPdfPages, vectorPdf } from '../src/io/pdf-vector';
import { parsePdfBasics, dictValue, pageContents, parseContentStream } from './helpers/pdf';

// Integration regression: the colors writer passes its resolved opacity byte to polyline().
// Groups must remain vector paths, with opaque internal paints and one translucent outer Do.
describe('translucent variable-width PDF vector groups', () => {
  const lookup = () => undefined;
  const drawing = (alpha: number, dashed: boolean, hairline: boolean) => {
    const e: PolylineEntity & { transparency: number } = {
      id: 'corner', type: 'polyline', layer: '0', color: 1, transparency: alpha, closed: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      widths: [{ start: 2, end: 2 }, { start: hairline ? 0 : 2, end: hairline ? 0 : 2 }, { start: 0, end: 0 }],
      ...(dashed ? { linetype: 'DASHED' } : {}),
    };
    return new Drawing({ entities: [e], header: { ...DEFAULT_HEADER, linetypes: [{ name: 'DASHED', description: 'test', pattern: [3, -2] }] } }).snapshot;
  };

  it.each([[true, false], [true, true], [false, true]] as const)('isolates alpha128 dash masks=%s / mixed device hairline=%s without rasterizing', (dashed, hairline) => {
    const state = drawing(128, dashed, hairline);
    const pages = plotPages(state, lookup, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    const context = drawingContext(state, lookup), style = { mode: 'color' as const, lineweights: false, usePlotStyles: false };
    const rendered = renderPdfPages(pages, context, style);
    expect(rendered[0]?.forms).toHaveLength(1);
    expect(rendered[0]?.content).toContain('/A128 gs');
    expect(rendered[0]?.content.match(/\/Wide\d+ Do/g)).toEqual(['/Wide0 Do']);
    expect(rendered[0]?.content).not.toMatch(/ W n| [fS](?:\s|$)/);
    const pdf = parsePdfBasics(vectorPdf(pages, context, style));
    expect(pdf.errors).toEqual([]);
    const forms = [...pdf.objects.values()].filter((object) => dictValue(object.dict, 'Subtype') === '/Form');
    expect(forms).toHaveLength(1);
    expect(dictValue(forms[0]!.dict, 'Group')).toContain('/I true');
    expect(dictValue(forms[0]!.dict, 'Resources')).toMatch(/\/Opaque \d+ 0 R/);
    const content = new TextDecoder().decode(forms[0]!.stream);
    expect(content).toContain('/Opaque gs');
    const summary = parseContentStream(content);
    expect(summary.errors).toEqual([]);
    if (dashed) { expect(summary.counts.W).toBeGreaterThan(1); expect(summary.counts.S).toBeGreaterThan(1); }
    else { expect(summary.counts.f).toBe(1); expect(summary.counts.S).toBe(1); expect(summary.widths).toContain(0); }
    expect([...pdf.objects.values()].some((object) => dictValue(object.dict, 'Subtype') === '/Image')).toBe(false);
    expect(parseContentStream(pageContents(pdf, (data) => new Uint8Array(inflateSync(data)))[0]!).counts.Do).toBe(1);
  });

  it.each([[255, true, true], [128, false, false]] as const)('avoids a group for alpha%i / ordinary outline dashed=%s', (alpha, dashed, hairline) => {
    const state = drawing(alpha, dashed, hairline);
    const pages = plotPages(state, lookup, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    expect(renderPdfPages(pages, drawingContext(state, lookup), { mode: 'color', lineweights: false, usePlotStyles: false })[0]?.forms).toHaveLength(0);
  });
});
