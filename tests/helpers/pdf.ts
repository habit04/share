/**
 * A small structural PDF reader for tests: enough to check what JCad Electrical writes
 * (src/io/pdf.ts imagePdf) and what Electron's printToPDF produces through the `plot-pdf`
 * IPC (scripts/e2e-electron.mjs imports this file directly with Node's type stripping, so
 * it must stay plain, erasable TypeScript without Node- or DOM-specific APIs).
 *
 * It reads the classic cross-reference table (not xref streams / object streams, which
 * neither writer uses) and reports problems in `errors` instead of throwing, so a test
 * can print every defect at once.
 */

export interface PdfObject {
  num: number;
  gen: number;
  /** Byte offset of "N G obj". */
  offset: number;
  /** Dictionary text (the first << ... >> of the body), or '' for non-dictionary objects. */
  dict: string;
  /** Raw stream bytes (exactly /Length bytes) when the object is a stream. */
  stream?: Uint8Array;
}

export interface PdfImageInfo {
  num: number;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: string;
  /** Filter names without the slash, e.g. ['FlateDecode']. */
  filters: string[];
  data: Uint8Array;
}

export interface PdfPage {
  num: number;
  /** [llx, lly, urx, ury] in points (inherited from the page tree when absent on the page). */
  mediaBox: number[];
  /** Page width / height in points (MediaBox extent, /Rotate applied). */
  width: number;
  height: number;
  rotate: number;
}

export interface PdfBasics {
  /** Version from the header, e.g. "1.4". */
  version: string;
  objects: Map<number, PdfObject>;
  /** Offset named by startxref, and whether the "xref" keyword really is there. */
  startxref: number;
  startxrefValid: boolean;
  /** Object number -> offset from the xref table (in-use entries only). */
  xref: Map<number, number>;
  /** Trailer dictionary text. */
  trailer: string;
  /** Object number of /Root, or null. */
  root: number | null;
  /** /Size from the trailer. */
  size: number;
  pages: PdfPage[];
  images: PdfImageInfo[];
  endsWithEof: boolean;
  /** Everything that is structurally wrong; empty for a sound file. */
  errors: string[];
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  return out;
}

/** The first balanced << ... >> starting at or after `from` (literal strings skipped). */
function dictAt(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('<<', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    const c = text[i];
    if (c === '<' && text[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (c === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return { start, end: i + 1 };
    } else if (c === '(') {
      let nest = 0;
      for (; i < text.length; i += 1) {
        if (text[i] === '\\') {
          i += 1;
          continue;
        }
        if (text[i] === '(') nest += 1;
        else if (text[i] === ')') {
          nest -= 1;
          if (nest === 0) break;
        }
      }
    }
  }
  return null;
}

/** Raw text of a dictionary value (array, dictionary, reference, name, number or string). */
export function dictValue(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`);
  const m = re.exec(dict);
  if (!m) return null;
  const rest = dict.slice(m.index + m[0].length);
  if (rest.startsWith('[')) return rest.slice(0, rest.indexOf(']') + 1);
  if (rest.startsWith('<<')) {
    const d = dictAt(rest, 0);
    return d ? rest.slice(d.start, d.end) : null;
  }
  const ref = /^(\d+)\s+(\d+)\s+R/.exec(rest);
  if (ref) return ref[0];
  const tok = /^(\/[^\s/<>[\]()]+|[-+]?[\d.]+|\([^)]*\)|true|false|null)/.exec(rest);
  return tok ? tok[0] : null;
}

function numbers(v: string | null): number[] {
  if (!v) return [];
  return (v.match(/[-+]?\d*\.?\d+/g) ?? []).map(Number);
}

/** Parse the structure of a PDF file. Never throws for malformed input: see `errors`. */
export function parsePdfBasics(input: Uint8Array | ArrayBuffer): PdfBasics {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = latin1(bytes);
  const errors: string[] = [];
  const header = /^%PDF-(\d\.\d)/.exec(text);
  if (!header) errors.push('missing %PDF-x.y header at byte 0');

  // ---------------------------------------------------------------- startxref
  const sx = text.lastIndexOf('startxref');
  let startxref = -1;
  if (sx < 0) errors.push('no startxref');
  else {
    const m = /^startxref\s+(\d+)/.exec(text.slice(sx));
    if (m) startxref = Number(m[1]);
    else errors.push('startxref without an offset');
  }
  const startxrefValid = startxref >= 0 && text.startsWith('xref', startxref);
  if (startxref >= 0 && !startxrefValid) errors.push(`startxref ${startxref} does not point at "xref" (found ${JSON.stringify(text.slice(startxref, startxref + 8))})`);
  const endsWithEof = /%%EOF\s*$/.test(text.slice(-32));
  if (!endsWithEof) errors.push('file does not end with %%EOF');

  // ---------------------------------------------------------------- xref table + trailer
  const xref = new Map<number, number>();
  let size = 0;
  let trailer = '';
  if (startxrefValid) {
    const tIdx = text.indexOf('trailer', startxref);
    const table = text.slice(startxref + 4, tIdx < 0 ? undefined : tIdx);
    const lines = table
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let cur = 0;
    let left = 0;
    for (const line of lines) {
      const sub = /^(\d+)\s+(\d+)$/.exec(line);
      if (sub && left === 0) {
        cur = Number(sub[1]);
        left = Number(sub[2]);
        continue;
      }
      const ent = /^(\d{10})\s+(\d{5})\s+([nf])$/.exec(line);
      if (!ent) {
        errors.push(`bad xref line ${JSON.stringify(line)}`);
        break;
      }
      if (ent[3] === 'n') xref.set(cur, Number(ent[1]));
      cur += 1;
      left -= 1;
    }
    if (tIdx < 0) errors.push('no trailer keyword');
    else {
      const d = dictAt(text, tIdx);
      trailer = d ? text.slice(d.start, d.end) : '';
    }
    size = numbers(dictValue(trailer, 'Size'))[0] ?? 0;
    if (size < xref.size + 1) errors.push(`trailer /Size ${size} is smaller than the xref table (${xref.size + 1})`);
  }
  const rootRef = /^(\d+)\s+\d+\s+R/.exec(dictValue(trailer, 'Root') ?? '');
  const root = rootRef ? Number(rootRef[1]) : null;
  if (root === null) errors.push('trailer has no /Root reference');

  // ---------------------------------------------------------------- objects
  const objects = new Map<number, PdfObject>();
  const objRe = /(^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  const starts: Array<{ num: number; gen: number; offset: number; bodyStart: number }> = [];
  let sEnd = 0;
  for (let m = objRe.exec(text); m; m = objRe.exec(text)) {
    const offset = m.index + m[1]!.length;
    // Skip matches inside stream data of the previous object.
    if (offset < sEnd) continue;
    const s = { num: Number(m[2]), gen: Number(m[3]), offset, bodyStart: m.index + m[0].length };
    starts.push(s);
    const e = text.indexOf('endobj', s.bodyStart);
    const d = dictAt(text, s.bodyStart);
    if (d && (e < 0 || d.start < e)) {
      const sm = /^\s*stream(\r\n|\n)/.exec(text.slice(d.end, d.end + 16));
      if (sm) {
        const dict = text.slice(d.start, d.end);
        const lenVal = dictValue(dict, 'Length');
        let len = numbers(lenVal)[0] ?? -1;
        if (/^\d+\s+\d+\s+R$/.test(lenVal ?? '')) len = -1; // resolved below once all objects are known
        sEnd = len >= 0 ? d.end + sm[0].length + len : text.indexOf('endstream', d.end);
      }
    }
  }
  const resolveInt = (ref: string): number => {
    const r = /^(\d+)\s+\d+\s+R$/.exec(ref);
    if (!r) return numbers(ref)[0] ?? -1;
    const off = xref.get(Number(r[1])) ?? starts.find((s) => s.num === Number(r[1]))?.offset;
    const lm = off !== undefined ? /^\d+\s+\d+\s+obj\s+(\d+)/.exec(text.slice(off, off + 40)) : null;
    return lm ? Number(lm[1]) : -1;
  };
  for (const s of starts) {
    const d = dictAt(text, s.bodyStart);
    const endobj = text.indexOf('endobj', s.bodyStart);
    const isDict = !!d && (endobj < 0 || d.start < endobj) && text.slice(s.bodyStart, d.start).trim() === '';
    const dict = isDict ? text.slice(d!.start, d!.end) : '';
    let stream: Uint8Array | undefined;
    if (isDict) {
      const sm = /^\s*stream(\r\n|\n)/.exec(text.slice(d!.end, d!.end + 16));
      if (sm) {
        const dataStart = d!.end + sm[0].length;
        const len = resolveInt(dictValue(dict, 'Length') ?? '');
        if (len < 0) errors.push(`object ${s.num}: stream without a usable /Length`);
        else {
          stream = bytes.subarray(dataStart, dataStart + len);
          if (!/^\s*endstream/.test(text.slice(dataStart + len, dataStart + len + 12))) errors.push(`object ${s.num}: /Length ${len} does not end at "endstream"`);
        }
      }
    }
    if (endobj < 0) errors.push(`object ${s.num} has no endobj`);
    objects.set(s.num, { num: s.num, gen: s.gen, offset: s.offset, dict, stream });
  }
  for (const [num, off] of xref) {
    const at = /^(\d+)\s+(\d+)\s+obj/.exec(text.slice(off, off + 24));
    if (!at || Number(at[1]) !== num) errors.push(`xref entry for object ${num} points at ${off}, which holds ${JSON.stringify(text.slice(off, off + 12))}`);
  }
  for (const num of objects.keys()) if (startxrefValid && !xref.has(num)) errors.push(`object ${num} is missing from the xref table`);
  if (root !== null && !/\/Type\s*\/Catalog/.test(objects.get(root)?.dict ?? '')) errors.push(`/Root ${root} is not a /Catalog`);

  // ---------------------------------------------------------------- pages
  const parentOf = (dict: string): PdfObject | undefined => {
    const r = /^(\d+)\s+\d+\s+R/.exec(dictValue(dict, 'Parent') ?? '');
    return r ? objects.get(Number(r[1])) : undefined;
  };
  const pages: PdfPage[] = [];
  for (const o of objects.values()) {
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) continue;
    let box = numbers(dictValue(o.dict, 'MediaBox'));
    let rotate = numbers(dictValue(o.dict, 'Rotate'))[0] ?? 0;
    for (let p = parentOf(o.dict), guard = 0; p && box.length !== 4 && guard < 32; p = parentOf(p.dict), guard += 1) {
      box = numbers(dictValue(p.dict, 'MediaBox'));
      if (!rotate) rotate = numbers(dictValue(p.dict, 'Rotate'))[0] ?? 0;
    }
    if (box.length !== 4) {
      errors.push(`page ${o.num} has no MediaBox`);
      continue;
    }
    const w = Math.abs(box[2]! - box[0]!);
    const h = Math.abs(box[3]! - box[1]!);
    const turned = Math.abs(rotate) % 180 === 90;
    pages.push({ num: o.num, mediaBox: box, width: turned ? h : w, height: turned ? w : h, rotate });
  }
  if (pages.length === 0) errors.push('no /Type /Page objects');

  // ---------------------------------------------------------------- images
  const images: PdfImageInfo[] = [];
  for (const o of objects.values()) {
    if (!/\/Subtype\s*\/Image/.test(o.dict)) continue;
    images.push({
      num: o.num,
      width: resolveInt(dictValue(o.dict, 'Width') ?? ''),
      height: resolveInt(dictValue(o.dict, 'Height') ?? ''),
      bitsPerComponent: resolveInt(dictValue(o.dict, 'BitsPerComponent') ?? ''),
      colorSpace: (dictValue(o.dict, 'ColorSpace') ?? '').replace(/^\//, ''),
      filters: (dictValue(o.dict, 'Filter') ?? '').match(/\/[A-Za-z0-9]+/g)?.map((f) => f.slice(1)) ?? [],
      data: o.stream ?? new Uint8Array(0),
    });
  }

  return { version: header?.[1] ?? '', objects, startxref, startxrefValid, xref, trailer, root, size, pages, images, endsWithEof, errors };
}
