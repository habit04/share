import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { cffPdfFontFixture } from './helpers/cff-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { parsePdfBasics } from './helpers/pdf';
import { PdfFontRegistry, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';
import { assembleVectorPdf, type RenderedPage } from '../src/io/pdf-vector';

/**
 * Regression tests for the 12.2 corrections review: two Unicode scalars that
 * share ONE CFF glyph must still extract as themselves. The delivered writer
 * emitted the glyph id as the character code and kept only the first scalar
 * per CID in ToUnicode, so AB extracted as AA and BA as BB.
 */
function objects() {
  const entries = new Map<number, string | Uint8Array[]>();
  let next = 0;
  const writer: PdfFontObjectWriter = { reserve: () => ++next, set: (id, body) => { expect(entries.has(id)).toBe(false); entries.set(id, body); } };
  const text = (id: number) => {
    const body = entries.get(id)!;
    return typeof body === 'string' ? body : body.filter((_part, index) => index !== 1).map((part) => new TextDecoder().decode(part)).join('');
  };
  const stream = (id: number) => {
    const body = entries.get(id)! as Uint8Array[];
    return new TextDecoder().decode(body[1]);
  };
  const all = () => [...entries.keys()];
  const findText = (needle: string) => all().map((id) => text(id)).find((body) => body.includes(needle));
  const findStream = (needle: string) => all().map((id) => { try { return stream(id); } catch { return ''; } }).find((body) => body.includes(needle));
  return { entries, writer, text, stream, findText, findStream };
}

const aliasFace = (): PdfFontFace => ({ key: 'cff', ...cffPdfFontFixture({ alias: true }) });

describe('CFF Unicode aliases (two scalars, one glyph)', () => {
  it('extracts AB and BA distinctly in both orders', () => {
    // Codes follow first-sight order, so BA assigns code 1 to B; the extraction
    // invariant is that content order + ToUnicode reproduces the original word.
    const toUnicode = { AB: '<0001> <0041>\n<0002> <0042>', BA: '<0001> <0042>\n<0002> <0041>' } as const;
    for (const word of ['AB', 'BA'] as const) {
      const registry = new PdfFontRegistry([aliasFace()]);
      expect(registry.rejections.size).toBe(0);
      const run = registry.encode('cff', word)!;
      expect(run.glyphs).toEqual([2, 2]);
      expect(run.hex).toBe('00010002');
      const out = objects(); writePdfFontResources(registry, out.writer);
      expect(out.findStream('/CMapType 2 def')).toContain(toUnicode[word]);
      // Both character codes map to the one CID (glyph id 2) in the Encoding CMap.
      expect(out.findStream('/CMapType 0 def')).toContain('<0001> 2\n<0002> 2');
      // Widths stay CID-keyed: CID 2 appears once, with glyph 2's advance.
      expect(out.findText('/Subtype /CIDFontType0')).toContain('/W [2 [650]]');
    }
  });

  it('keeps codes stable across separate encode calls', () => {
    const registry = new PdfFontRegistry([aliasFace()]);
    expect(registry.encode('cff', 'A')!.hex).toBe('0001');
    expect(registry.encode('cff', 'B')!.hex).toBe('0002');
    expect(registry.encode('cff', 'BA')!.hex).toBe('00020001');
    expect(registry.encode('cff', 'AB')!.hex).toBe('00010002');
  });

  it('aliases supplementary-plane scalars to one glyph with distinct extraction', () => {
    const registry = new PdfFontRegistry([aliasFace()]);
    const run = registry.encode('cff', '\u{20001}\u{20000}')!;
    expect(run.glyphs).toEqual([4, 4]);
    expect(run.hex).toBe('00010002');
    const out = objects(); writePdfFontResources(registry, out.writer);
    expect(out.findStream('/CMapType 2 def')).toContain('<0001> <D840DC01>\n<0002> <D840DC00>');
    expect(out.findStream('/CMapType 0 def')).toContain('<0001> 4\n<0002> 4');
  });

  it('leaves the TrueType scheme untouched in a mixed registry', () => {
    const ttf: PdfFontFace = { key: 'ttf', ...pdfFontFixture() };
    const registry = new PdfFontRegistry([ttf, aliasFace()]);
    registry.encode('ttf', 'AB'); registry.encode('cff', 'AB');
    const out = objects(); writePdfFontResources(registry, out.writer);
    const parents = [...out.entries.keys()].map((id) => out.text(id)).filter((body) => body.includes('/Subtype /Type0'));
    expect(parents.some((body) => body.includes('/Encoding /Identity-H'))).toBe(true);
    expect(parents.some((body) => /\/Encoding \d+ 0 R/.test(body) && !body.includes('Identity-H'))).toBe(true);
  });
});

describe('PDF header version follows the emitted resources', () => {
  const page = (registry: PdfFontRegistry | undefined, fonts: readonly string[], content = ''): RenderedPage =>
    ({ width: 200, height: 100, content, images: [], fonts: new Set(fonts), embeddedFonts: registry, pathOps: 0 });
  const version = (bytes: Uint8Array) => parsePdfBasics(bytes).version;
  const shown = (hex: string) => `BT /JCF1 100 Tf 10 10 Td <${hex}> Tj ET`;

  it('stays 1.4 for TrueType-only output and rises to 1.6 when a CFF resource is emitted', () => {
    const ttf: PdfFontFace = { key: 'ttf', ...pdfFontFixture() };
    const ttfRegistry = new PdfFontRegistry([ttf]);
    const ttfRun = ttfRegistry.encode('ttf', 'AB')!;
    expect(version(assembleVectorPdf([page(ttfRegistry, ['JCF1'], shown(ttfRun.hex))], 'T'))).toBe('1.4');

    const cffRegistry = new PdfFontRegistry([{ key: 'cff', ...cffPdfFontFixture() }]);
    const cffRun = cffRegistry.encode('cff', 'AB')!;
    expect(version(assembleVectorPdf([page(cffRegistry, ['JCF1'], shown(cffRun.hex))], 'T'))).toBe('1.6');
  });

  it('rises to 1.6 for a mixed CFF/TrueType document, compressed or not', () => {
    const ttf: PdfFontFace = { key: 'ttf', ...pdfFontFixture() };
    const registry = new PdfFontRegistry([ttf, { key: 'cff', ...cffPdfFontFixture() }]);
    const a = registry.encode('ttf', 'A')!, b = registry.encode('cff', 'B')!;
    const rendered = page(registry, ['JCF1', 'JCF2'], `${shown(a.hex)}\n${shown(b.hex)}`);
    expect(version(assembleVectorPdf([rendered], 'T'))).toBe('1.6');
    const packed = new Uint8Array(deflateSync(new TextEncoder().encode(rendered.content)));
    expect(version(assembleVectorPdf([rendered], 'T', [packed]))).toBe('1.6');
  });

  it('stays 1.4 when the CFF candidate was rejected or never used', () => {
    const unused = new PdfFontRegistry([{ key: 'cff', ...cffPdfFontFixture() }]);
    expect(version(assembleVectorPdf([page(unused, [])], 'T'))).toBe('1.4');
    const rejected = new PdfFontRegistry([{ key: 'cff', ...cffPdfFontFixture({ fsType: 2 }) }]);
    expect(rejected.rejections.get('cff')).toContain('restricted');
    expect(rejected.encode('cff', 'AB')).toBeNull();
    expect(version(assembleVectorPdf([page(rejected, [])], 'T'))).toBe('1.4');
  });

  it('requiredVersion reflects only actually-encoded faces', () => {
    const registry = new PdfFontRegistry([{ key: 'cff', ...cffPdfFontFixture() }]);
    expect(registry.requiredVersion).toEqual([1, 4]);
    registry.encode('cff', 'A');
    expect(registry.requiredVersion).toEqual([1, 6]);
  });
});
