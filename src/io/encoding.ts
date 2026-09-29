/**
 * DXF text encodings and text-style records.
 *
 * Reading: AutoCAD writes DXF files older than AutoCAD 2007 (AC1021) in the
 * Windows code page named by the $DWGCODEPAGE header variable (ANSI_1252,
 * ANSI_932 ...), and characters outside that page as \U+XXXX escapes (or, in
 * old Asian files, \M+nXXXX multibyte escapes). AC1021 and newer are UTF-8.
 * `decodeDxfBytes` sniffs the header as latin1 before decoding the whole file
 * with TextDecoder; `decodeUnicodeEscapes` turns the escapes back into text.
 *
 * Writing: our writer produces AC1015 (AutoCAD 2000) files, which AutoCAD
 * reads in the $DWGCODEPAGE code page. `escapeNonAscii` makes the output pure
 * ASCII (every other character as \U+XXXX) so the file reads the same in
 * AutoCAD whatever its code page, and it is still valid UTF-8 for other tools.
 *
 * Node twin: scripts/dwg-reader.mjs exports the same `decodeDxfBytes` for the
 * Electron main process (tests/encoding.test.ts keeps the two in step).
 *
 * The STYLE table helpers at the end live here because the DXF reader/writer
 * use them next to the encoding hooks; rendering choices are in render/hershey.ts.
 */

/** $DWGCODEPAGE value -> WHATWG encoding label understood by TextDecoder. */
export const CODEPAGE_ENCODINGS: Readonly<Record<string, string>> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  ISO8859_1: 'iso-8859-1',
  ISO8859_2: 'iso-8859-2',
  ISO8859_3: 'iso-8859-3',
  ISO8859_4: 'iso-8859-4',
  ISO8859_5: 'iso-8859-5',
  ISO8859_6: 'iso-8859-6',
  ISO8859_7: 'iso-8859-7',
  ISO8859_8: 'iso-8859-8',
  ISO8859_9: 'iso-8859-9',
  DOS866: 'ibm866',
  KOI8_R: 'koi8-r',
  UTF8: 'utf-8',
  'UTF-8': 'utf-8',
};

/** \M+n multibyte escape: n selects the Asian code page of the two following bytes. */
const MIF_ENCODINGS: Readonly<Record<string, string>> = { '1': 'shift_jis', '2': 'big5', '3': 'euc-kr', '5': 'gbk' };

export interface DxfHeaderSniff {
  /** $ACADVER, e.g. "AC1015" (empty when absent). */
  acadver: string;
  /** $DWGCODEPAGE, upper-cased, e.g. "ANSI_1252" (empty when absent). */
  codepage: string;
}

export interface DecodedDxf extends DxfHeaderSniff {
  text: string;
  /** The TextDecoder label actually used. */
  encoding: string;
  /** Why that encoding was chosen (for the command-line log). */
  reason: 'bom' | 'version' | 'utf8-valid' | 'codepage' | 'default';
}

/** AutoCAD release number of an $ACADVER string (AC1015 -> 1015; 0 when unknown). */
export function acadVersionNumber(acadver: string): number {
  const m = /^AC(\d{4})$/i.exec(acadver.trim());
  return m ? parseInt(m[1]!, 10) : 0;
}

/** True for AutoCAD 2007 (AC1021) and newer, whose DXF files are UTF-8. */
export function isUtf8Version(acadver: string): boolean {
  return acadVersionNumber(acadver) >= 1021;
}

function latin1(bytes: Uint8Array, limit: number): string {
  const n = Math.min(bytes.length, limit);
  let s = '';
  for (let i = 0; i < n; i += 4096) s += String.fromCharCode(...bytes.subarray(i, Math.min(n, i + 4096)));
  return s;
}

/** Find $ACADVER / $DWGCODEPAGE in header text (group code line, value line pairs). */
export function sniffHeaderText(text: string): DxfHeaderSniff & { endOfHeader: boolean } {
  const lines = text.split(/\r\n|\r|\n/);
  let acadver = '';
  let codepage = '';
  let endOfHeader = false;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const v = lines[i]!.trim();
    if (v === '$ACADVER' || v === '$DWGCODEPAGE') {
      // "9 / $NAME / <code> / <value>": the value is two lines further down.
      const value = (lines[i + 2] ?? '').trim();
      if (v === '$ACADVER') acadver = value;
      else codepage = value.toUpperCase();
    } else if (v === 'ENDSEC' || v === 'ENTITIES' || v === 'TABLES') {
      endOfHeader = true;
      break;
    }
    if (acadver && codepage) break;
  }
  return { acadver, codepage, endOfHeader };
}

/** Read the header variables that select the encoding from the first bytes (latin1, ~4 KB, up to 64 KB). */
export function sniffDxfHeader(bytes: Uint8Array): DxfHeaderSniff {
  let r = sniffHeaderText(latin1(bytes, 4096));
  if ((!r.acadver || !r.codepage) && !r.endOfHeader && bytes.length > 4096) r = sniffHeaderText(latin1(bytes, 65536));
  return { acadver: r.acadver, codepage: r.codepage };
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasNonAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i]! > 0x7f) return true;
  return false;
}

function tryDecode(label: string, bytes: Uint8Array, fatal = false): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/** TextDecoder label for a $DWGCODEPAGE value (windows-1252 when unknown or unsupported). */
export function encodingForCodepage(codepage: string): string {
  const label = CODEPAGE_ENCODINGS[codepage.trim().toUpperCase()];
  if (label && tryDecode(label, new Uint8Array(0)) !== null) return label;
  return 'windows-1252';
}

/**
 * Decode a DXF file. Order: UTF-8 byte order mark; AC1021+ (always UTF-8);
 * bytes that are valid UTF-8 and contain non-ASCII (files written by tools, and
 * earlier JCad versions, that ignore the code page); the $DWGCODEPAGE page;
 * windows-1252. The BOM is stripped. \U+ escapes are left for the parser.
 */
export function decodeDxfBytes(input: Uint8Array | ArrayBuffer): DecodedDxf {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sniff = sniffDxfHeader(bytes);
  if (hasBom(bytes)) return { ...sniff, text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', reason: 'bom' };
  if (isUtf8Version(sniff.acadver)) return { ...sniff, text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', reason: 'version' };
  if (hasNonAscii(bytes)) {
    const utf8 = tryDecode('utf-8', bytes, true);
    if (utf8 !== null) return { ...sniff, text: utf8, encoding: 'utf-8', reason: 'utf8-valid' };
  }
  const label = sniff.codepage ? encodingForCodepage(sniff.codepage) : 'windows-1252';
  const text = tryDecode(label, bytes) ?? new TextDecoder('windows-1252').decode(bytes);
  return { ...sniff, text, encoding: label, reason: sniff.codepage ? 'codepage' : 'default' };
}

const ESCAPE_RE = /\\(?:U\+([0-9A-Fa-f]{4})|M\+([1-5])([0-9A-Fa-f]{4}))/g;

/**
 * Replace \U+XXXX (UTF-16 code unit) and \M+nXXXX (two bytes in an Asian code
 * page) escapes with the characters. Control characters stay escaped so a
 * decoded value can never split a DXF line. Pairs of \U+ surrogates combine.
 */
export function decodeUnicodeEscapes(s: string): string {
  if (!s.includes('\\U+') && !s.includes('\\M+')) return s;
  return s.replace(ESCAPE_RE, (m, u: string | undefined, n: string | undefined, mb: string | undefined) => {
    if (u) {
      const code = parseInt(u, 16);
      return code < 0x20 || code === 0x7f ? m : String.fromCharCode(code);
    }
    const label = MIF_ENCODINGS[n!];
    if (!label) return m;
    const hi = parseInt(mb!.slice(0, 2), 16);
    const lo = parseInt(mb!.slice(2), 16);
    const out = tryDecode(label, hi ? new Uint8Array([hi, lo]) : new Uint8Array([lo]), true);
    return out && !/[\u0000-\u001f]/.test(out) ? out : m;
  });
}

/** Escape every non-ASCII UTF-16 code unit as \U+XXXX (upper-case hex), so the result is 7-bit ASCII. */
export function escapeNonAscii(s: string): string {
  return s.replace(/[^\u0000-~]/g, (c) => `\\U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * Prepare writer output for a target $ACADVER: AC1021+ stays UTF-8 as is;
 * older versions get non-ASCII escaped (AutoCAD would otherwise read the
 * UTF-8 bytes in the $DWGCODEPAGE page).
 */
export function encodeDxfText(text: string, acadver = 'AC1015'): string {
  return isUtf8Version(acadver) ? text : escapeNonAscii(text);
}

// ---------------------------------------------------------------- text styles (STYLE table)

export interface TextStyle {
  /** Style name (group 2). */
  readonly name: string;
  /** Primary font file (group 3): "txt", "romans.shx", "arial.ttf" ... */
  readonly font: string;
  /** Big font file (group 4) for Asian SHX fonts; '' when none. */
  readonly bigFont: string;
  /** Standard flags (group 70): 4 = vertical text. */
  readonly flags: number;
  /** Fixed text height (group 40); 0 = not fixed. */
  readonly height: number;
  /** Width factor (group 41). */
  readonly widthFactor: number;
  /** Oblique angle in degrees (group 50). */
  readonly oblique: number;
  /** Text generation flags (group 71): 2 backward, 4 upside down. */
  readonly generation: number;
  /** TrueType family name from the ACAD XDATA (group 1000), when present. */
  readonly family?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export const STANDARD_TEXT_STYLE: TextStyle = { name: 'Standard', font: 'txt', bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 };

/** Key of the style map in DrawingState.meta (the header has no field for it). */
export const TEXT_STYLES_META_KEY = 'textStyles';

/** XDATA 1071 font flags of a TrueType style (AutoCAD): italic and bold bits. */
const TT_ITALIC = 0x1000000;
const TT_BOLD = 0x2000000;

/** Build a style from the group codes of a DXF STYLE record (null for unnamed / shape-file records). */
export function textStyleFromGroups(groups: ReadonlyArray<{ code: number; value: string }>): TextStyle | null {
  const first = (code: number) => groups.find((g) => g.code === code)?.value;
  const num = (code: number, d: number) => {
    const v = parseFloat(first(code) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const name = (first(2) ?? '').trim();
  const flags = Math.trunc(num(70, 0));
  if (!name || (flags & 1) === 1) return null; // flag 1: a shape file entry, not a text style
  const family = groups.find((g) => g.code === 1000)?.value;
  const ttFlags = Math.trunc(num(1071, 0));
  const style: TextStyle = {
    name,
    font: (first(3) ?? '').trim(),
    bigFont: (first(4) ?? '').trim(),
    flags,
    height: num(40, 0),
    widthFactor: num(41, 1) || 1,
    oblique: num(50, 0),
    generation: Math.trunc(num(71, 0)),
    ...(family ? { family } : {}),
    ...(ttFlags & TT_BOLD ? { bold: true } : {}),
    ...(ttFlags & TT_ITALIC ? { italic: true } : {}),
  };
  return style;
}

/** Group codes of a STYLE record after its name / flags (the writer adds 0, 5, 330, 100, 2, 70). */
export function textStyleGroups(s: TextStyle): Array<[number, string | number]> {
  const out: Array<[number, string | number]> = [
    [40, s.height],
    [41, s.widthFactor || 1],
    [50, s.oblique],
    [71, s.generation],
    [42, s.height || 0.2],
    [3, s.font || (s.family ? '' : 'txt')],
    [4, s.bigFont],
  ];
  if (s.family || s.bold || s.italic) {
    out.push([1001, 'ACAD'], [1000, s.family ?? ''], [1071, (s.bold ? TT_BOLD : 0) | (s.italic ? TT_ITALIC : 0) | 0x22]);
  }
  return out;
}

/** A style that is exactly the default Standard (not worth keeping in the document). */
export function isPlainStandard(s: TextStyle): boolean {
  return s.name.toUpperCase() === 'STANDARD' && /^(txt(\.shx)?)?$/i.test(s.font) && !s.bigFont && !s.height && (s.widthFactor || 1) === 1 && !s.oblique && !s.family;
}

/** Text styles kept in a drawing state (empty when none were read). */
export function textStylesOf(state: { readonly meta?: Readonly<Record<string, unknown>> }): Readonly<Record<string, TextStyle>> {
  const v = state.meta?.[TEXT_STYLES_META_KEY];
  return v && typeof v === 'object' ? (v as Record<string, TextStyle>) : {};
}

/** The meta patch that stores a style map (undefined when there is nothing worth keeping). */
export function textStylesMeta(styles: Readonly<Record<string, TextStyle>>): Record<string, unknown> | undefined {
  const keep = Object.values(styles).filter((s) => !isPlainStandard(s));
  if (keep.length === 0) return undefined;
  return { [TEXT_STYLES_META_KEY]: Object.fromEntries(Object.values(styles).map((s) => [s.name, s])) };
}

/** STYLE records to write: Standard first (the drawing's own when present), then the others by name. */
export function textStylesForWrite(state: { readonly meta?: Readonly<Record<string, unknown>> }): TextStyle[] {
  const styles = Object.values(textStylesOf(state));
  const standard = styles.find((s) => s.name.toUpperCase() === 'STANDARD') ?? STANDARD_TEXT_STYLE;
  return [standard, ...styles.filter((s) => s.name.toUpperCase() !== 'STANDARD').sort((a, b) => a.name.localeCompare(b.name))];
}

/** Style name carried by a TEXT / MTEXT entity read from DXF (group 7); undefined = Standard. */
export function textStyleOf(e: object): string | undefined {
  const s = (e as { style?: unknown }).style;
  return typeof s === 'string' && s ? s : undefined;
}

/** Copy of a TEXT / MTEXT entity carrying a style name (the entity types have no field for it yet). */
export function withTextStyle<T extends object>(e: T, style: string | undefined): T {
  if (!style || /^STANDARD$/i.test(style)) return e;
  return { ...e, style } as T;
}
