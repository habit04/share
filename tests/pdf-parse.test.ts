import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { imagePdf } from '../src/io/pdf';
import { layoutPage, type PlotOptions } from '../src/app/plot';
import { parsePdfBasics } from './helpers/pdf';

// Structural checks of the browser edition's PDF writer (src/io/pdf.ts) for the sheet sizes the
// Plot dialog offers: the page must be exactly the chosen paper (72 pt per inch), carry one RGB
// image of the rendered sheet, and have a cross-reference table a strict reader accepts.

/** A deterministic RGB test card: a gradient with a black frame, so inflating can be checked byte for byte. */
function testCard(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      rgb[o] = edge ? 0 : (x * 255) / width;
      rgb[o + 1] = edge ? 0 : (y * 255) / height;
      rgb[o + 2] = edge ? 0 : 200;
    }
  }
  return rgb;
}

interface Case {
  name: string;
  /** Drawing extents in drawing units (inches at 1:1). */
  drawing: { w: number; h: number };
  options: PlotOptions;
  /** Expected sheet in inches after layoutPage. */
  sheet: { width: number; height: number };
}

const cases: Case[] = [
  { name: 'Letter portrait', drawing: { w: 6, h: 9 }, options: { paper: 'letter', orientation: 'portrait', scale: 'fit', margin: 0.25 }, sheet: { width: 8.5, height: 11 } },
  { name: 'Tabloid 11 x 17 landscape', drawing: { w: 30, h: 18 }, options: { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 }, sheet: { width: 17, height: 11 } },
  { name: 'ISO A3 (auto -> portrait)', drawing: { w: 10, h: 14 }, options: { paper: 'a3', orientation: 'auto', scale: 'fit', margin: 0.25 }, sheet: { width: 11.69, height: 16.54 } },
  { name: 'ISO A3 landscape', drawing: { w: 10, h: 14 }, options: { paper: 'a3', orientation: 'landscape', scale: 'fit', margin: 0.25 }, sheet: { width: 16.54, height: 11.69 } },
  { name: 'Fit to drawing 1:2', drawing: { w: 30, h: 20 }, options: { paper: 'fit', orientation: 'auto', scale: '1:2', margin: 0.25 }, sheet: { width: 15.5, height: 10.5 } },
];

describe('imagePdf output parsed as a PDF', () => {
  for (const c of cases) {
    it(`${c.name}: page size, one Flate image, exact xref`, () => {
      const lay = layoutPage(c.drawing.w, c.drawing.h, c.options);
      expect(lay.sheet.width).toBeCloseTo(c.sheet.width, 6);
      expect(lay.sheet.height).toBeCloseTo(c.sheet.height, 6);
      // 20 dpi keeps the test fast; the plot uses the same code path at 150+ dpi.
      const px = { w: Math.round(lay.sheet.width * 20), h: Math.round(lay.sheet.height * 20) };
      const raw = testCard(px.w, px.h);
      const pdf = imagePdf({ width: px.w, height: px.h, data: deflateSync(raw), kind: 'rgb', deflated: true }, lay.sheet, `${c.name}.pdf`);
      const info = parsePdfBasics(pdf);

      expect(info.errors).toEqual([]);
      expect(new TextDecoder().decode(pdf.subarray(0, 8))).toBe('%PDF-1.4');
      expect(info.version).toBe('1.4');
      expect(info.endsWithEof).toBe(true);

      // startxref names the xref table; every in-use entry points exactly at "N 0 obj".
      expect(info.startxrefValid).toBe(true);
      expect(info.xref.size).toBe(info.objects.size);
      for (const [num, off] of info.xref) expect(new TextDecoder('latin1').decode(pdf.subarray(off, off + `${num} 0 obj`.length))).toBe(`${num} 0 obj`);
      expect(info.size).toBe(info.objects.size + 1);
      expect(info.root).not.toBeNull();
      expect(info.objects.get(info.root!)!.dict).toMatch(/\/Type \/Catalog/);

      // One page, MediaBox in points at 72 per inch (writer rounds to 2 decimals).
      expect(info.pages).toHaveLength(1);
      const page = info.pages[0]!;
      expect(page.mediaBox[0]).toBe(0);
      expect(page.mediaBox[1]).toBe(0);
      expect(Math.abs(page.width - c.sheet.width * 72)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(page.height - c.sheet.height * 72)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(page.rotate).toBe(0);
      expect(page.width > page.height).toBe(lay.landscape);

      // Exactly one image XObject with the pixel size, RGB 8 bit, Flate data that inflates to w*h*3.
      expect(info.images).toHaveLength(1);
      const img = info.images[0]!;
      expect(img).toMatchObject({ width: px.w, height: px.h, bitsPerComponent: 8, colorSpace: 'DeviceRGB', filters: ['FlateDecode'] });
      const inflated = inflateSync(img.data);
      expect(inflated.length).toBe(px.w * px.h * 3);
      expect(Buffer.compare(inflated, Buffer.from(raw))).toBe(0);
    });
  }

  it('the page content paints the image over the whole MediaBox', () => {
    const pdf = imagePdf({ width: 4, height: 2, data: deflateSync(testCard(4, 2)), kind: 'rgb', deflated: true }, { width: 17, height: 11 });
    const info = parsePdfBasics(pdf);
    const page = [...info.objects.values()].find((o) => /\/Type \/Page\b(?!s)/.test(o.dict))!;
    const contentsRef = /\/Contents (\d+) 0 R/.exec(page.dict)!;
    const contents = info.objects.get(Number(contentsRef[1]))!;
    expect(new TextDecoder().decode(contents.stream)).toBe('q 1224 0 0 792 0 0 cm /Im0 Do Q');
    expect(page.dict).toMatch(/\/Im0 (\d+) 0 R/);
    const imRef = Number(/\/Im0 (\d+) 0 R/.exec(page.dict)![1]);
    expect(info.images[0]!.num).toBe(imRef);
  });

  it('keeps offsets exact when the title contains characters outside ASCII', () => {
    // The header's binary comment and a non-ASCII title are multi-byte in UTF-8: offsets must count bytes.
    const pdf = imagePdf({ width: 1, height: 1, data: deflateSync(new Uint8Array([1, 2, 3])), kind: 'rgb', deflated: true }, { width: 8.5, height: 11 }, 'Schaltplan Übersicht (Blatt 1)');
    const info = parsePdfBasics(pdf);
    expect(info.errors).toEqual([]);
    expect(info.images[0]!.data.length).toBe(deflateSync(new Uint8Array([1, 2, 3])).length);
  });

  it('reports a broken xref instead of accepting it', () => {
    const pdf = imagePdf({ width: 1, height: 1, data: deflateSync(new Uint8Array(3)), kind: 'rgb', deflated: true }, { width: 8.5, height: 11 });
    const broken = new Uint8Array(pdf.length + 1);
    broken.set(pdf.subarray(0, 20));
    broken[20] = 0x20; // one extra byte early in the file shifts every object
    broken.set(pdf.subarray(20), 21);
    const info = parsePdfBasics(broken);
    expect(info.errors.some((e) => e.startsWith('startxref'))).toBe(true);
    // Same shift, with startxref patched to the moved table: now the object offsets are wrong.
    const t = Buffer.from(broken).toString('latin1');
    const fixed = Buffer.from(t.replace(/startxref\n(\d+)/, (_m, n: string) => `startxref\n${Number(n) + 1}`), 'latin1');
    const info2 = parsePdfBasics(new Uint8Array(fixed));
    expect(info2.startxrefValid).toBe(true);
    expect(info2.errors.some((e) => e.includes('xref entry'))).toBe(true);
  });
});
