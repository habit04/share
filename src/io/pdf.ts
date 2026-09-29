/**
 * Minimal PDF writer for plot output: one page of a given size holding one image
 * that fills it. Used by the browser edition (the desktop app lets Electron write PDFs).
 * The image is stored losslessly (RGB, Flate) when a deflate stream is available,
 * otherwise as JPEG.
 */
export interface PdfImage {
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** Either raw RGB bytes (3 per pixel, row-major, top row first) or JPEG file bytes. */
  data: Uint8Array;
  kind: 'rgb' | 'jpeg';
  /** Already deflated (FlateDecode) RGB bytes; only for kind 'rgb'. */
  deflated?: boolean;
}

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A PDF text string: plain ASCII in parentheses, anything else as UTF-16BE hex (PDF readers decode
 *  parenthesised strings as PDFDocEncoding, so UTF-8 bytes would show garbled). */
export function pdfString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[()\\]/g, '')})`;
  let hex = 'FEFF';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

/** Build a single-page PDF (sheet size in inches) with the image scaled to the full page. */
export function imagePdf(image: PdfImage, sheetInches: { width: number; height: number }, title = 'Drawing'): Uint8Array {
  const pw = +(sheetInches.width * 72).toFixed(2);
  const ph = +(sheetInches.height * 72).toFixed(2);
  const filter = image.kind === 'jpeg' ? '/Filter /DCTDecode' : image.deflated ? '/Filter /FlateDecode' : '';
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array[]) => {
    objects.push(typeof body === 'string' ? enc.encode(body) : concat(body));
    return objects.length;
  };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pages = add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  const contents = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const img = add([
    enc.encode(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${filter} /Length ${image.data.length} >>\nstream\n`),
    image.data,
    enc.encode('\nendstream'),
  ]);
  const info = add(`<< /Title ${pdfString(title)} /Producer (JCad Electrical) >>`);
  void catalog;
  void pages;
  void page;
  void contents;
  void img;

  const parts: Uint8Array[] = [enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const head = enc.encode(`${i + 1} 0 obj\n`);
    const tail = enc.encode('\nendobj\n');
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefPos = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}

/** Deflate bytes with the platform CompressionStream, or null when unavailable. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (!CS) return null;
  try {
    const cs = new CS('deflate');
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return concat(chunks);
  } catch {
    return null;
  }
}

/** RGB bytes (alpha dropped) from an RGBA buffer. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]!;
    out[o + 1] = rgba[i + 1]!;
    out[o + 2] = rgba[i + 2]!;
  }
  return out;
}

/** Bytes of a data: URL (base64). */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
