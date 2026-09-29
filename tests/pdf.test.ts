import { describe, it, expect } from 'vitest';
import { pdfString, imagePdf, deflate, rgbaToRgb, dataUrlBytes } from '../src/io/pdf';

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('browser PDF writer', () => {
  it('writes a valid single-page PDF with the sheet size and one image', () => {
    const data = new Uint8Array([255, 255, 255, 0, 0, 0]); // 2 x 1 RGB
    const pdf = imagePdf({ width: 2, height: 1, data, kind: 'rgb' }, { width: 17, height: 11 }, 'Test');
    const t = text(pdf);
    expect(t.startsWith('%PDF-1.4')).toBe(true);
    expect(t).toContain('/MediaBox [0 0 1224 792]');
    expect(t).toContain('/Width 2 /Height 1 /ColorSpace /DeviceRGB');
    expect(t).toContain('1224 0 0 792 0 0 cm /Im0 Do');
    expect(t).toContain('/Title (Test)');
    expect(t.trim().endsWith('%%EOF')).toBe(true);
    // xref offsets point at "N 0 obj"
    const xrefPos = Number(/startxref\n(\d+)/.exec(t)![1]);
    expect(t.slice(xrefPos, xrefPos + 4)).toBe('xref');
    const first = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(t)![1]);
    expect(t.slice(first, first + 7)).toBe('1 0 obj');
  });
  it('marks JPEG and deflated images with the right filter', () => {
    const jpeg = imagePdf({ width: 1, height: 1, data: new Uint8Array([1]), kind: 'jpeg' }, { width: 8.5, height: 11 });
    expect(text(jpeg)).toContain('/Filter /DCTDecode');
    const flate = imagePdf({ width: 1, height: 1, data: new Uint8Array([1]), kind: 'rgb', deflated: true }, { width: 8.5, height: 11 });
    expect(text(flate)).toContain('/Filter /FlateDecode');
  });
  it('deflates with the platform stream when available and converts RGBA to RGB', async () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    expect([...rgbaToRgb(rgba)]).toEqual([1, 2, 3, 4, 5, 6]);
    const packed = await deflate(new Uint8Array(1000));
    if (packed) expect(packed.length).toBeLessThan(100);
    expect(dataUrlBytes('data:image/png;base64,AQID')).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('pdfString', () => {
  it('keeps ASCII titles in parentheses and encodes others as UTF-16BE hex', () => {
    expect(pdfString('Drawing (1)')).toBe('(Drawing 1)');
    expect(pdfString('Schéma')).toBe('<FEFF0053006300680000E9006D0061>'.replace('0000E9', '00E9'));
    expect(pdfString('😀')).toBe('<FEFFD83DDE00>');
    const t = new TextDecoder('latin1').decode(imagePdf({ width: 1, height: 1, data: new Uint8Array(3), kind: 'rgb' }, { width: 1, height: 1 }, 'Größe'));
    expect(t).toContain('/Title <FEFF0047007200F600DF0065>');
  });
});
