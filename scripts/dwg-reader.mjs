/**
 * Node-side DWG reader shared by the Electron main process, the CLI and tests.
 * Loads LibreDWG (WebAssembly) lazily and returns a trimmed payload.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let libPromise = null;

async function lib() {
  if (!libPromise) {
    libPromise = (async () => {
      const require = createRequire(import.meta.url);
      // The package's "exports" map hides package.json, so resolve the wasm dir from the entry file.
      const entry = require.resolve('@mlightcad/libredwg-web');
      const pkgDir = join(dirname(entry), '..');
      const { LibreDwg } = await import('@mlightcad/libredwg-web');
      return LibreDwg.create(join(pkgDir, 'wasm') + '/');
    })();
  }
  return libPromise;
}

/**
 * @param {Uint8Array|Buffer} bytes DWG or DXF file content
 * @param {'dwg'|'dxf'} kind
 * @returns {Promise<{payload: object, version: string}>}
 */
export async function readDwgPayload(bytes, kind = 'dwg') {
  const l = await lib();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ptr = l.dwg_read_data(ab, kind === 'dxf' ? 1 : 0);
  if (!ptr) throw new Error('LibreDWG could not read this file (unsupported version or corrupt data).');
  let version = '';
  try {
    version = l.dwg_get_version_type(ptr)?.type ?? '';
  } catch {
    /* ignore */
  }
  const db = l.convert(ptr);
  l.dwg_free(ptr);
  // LibreDWG keeps per-version state in the module; reading files of different
  // versions in one instance can abort the WASM. Start fresh for the next read.
  void resetLibreDwg();
  const payload = payloadFromDatabase(db, version);
  return { payload, version };
}

/**
 * The trimmed import payload of a converted LibreDWG database. Twin of
 * `toImportPayload` in src/io/dwg.ts (the browser path); keep the two in step
 * (tests/dwg.test.ts compares them).
 */
export function payloadFromDatabase(db, version = '') {
  return {
    header: db.header ?? {},
    entities: db.entities ?? [],
    layers: (db.tables?.LAYER?.entries ?? []).map((x) => ({
      name: x.name,
      colorIndex: x.colorIndex,
      off: x.off,
      frozen: x.frozen,
      locked: x.locked,
      lineweight: x.lineweight,
      lineType: x.lineType,
    })),
    blocks: (db.tables?.BLOCK_RECORD?.entries ?? []).map((b) => ({
      name: b.name,
      basePoint: b.basePoint,
      entities: b.entities ?? [],
      description: b.description,
      handle: b.handle,
      flags: b.flags,
    })),
    version,
    imageDefs: (db.objects?.IMAGEDEF ?? []).map((d) => ({ handle: String(d.handle ?? ''), fileName: d.fileName ?? '' })),
  };
}

/** Forget the cached WebAssembly module (after an abort). */
export async function resetLibreDwg() {
  libPromise = null;
  try {
    const { LibreDwg } = await import('@mlightcad/libredwg-web');
    LibreDwg.instance = null;
  } catch {
    /* ignore */
  }
}

export const thisDir = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ DXF text decoding (Node twin of src/io/encoding.ts)
// The Electron main process reads DXF files as bytes and decodes them here, so files in
// Windows code pages (ANSI_1252, ANSI_932 ...) open with the right characters.
// Keep in step with decodeDxfBytes in src/io/encoding.ts (tests/encoding.test.ts compares them).

/** $DWGCODEPAGE value -> WHATWG encoding label. */
export const CODEPAGE_ENCODINGS = {
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

function latin1(bytes, limit) {
  const n = Math.min(bytes.length, limit);
  let s = '';
  for (let i = 0; i < n; i += 4096) s += String.fromCharCode(...bytes.subarray(i, Math.min(n, i + 4096)));
  return s;
}

function sniffHeaderText(text) {
  const lines = text.split(/\r\n|\r|\n/);
  let acadver = '';
  let codepage = '';
  let endOfHeader = false;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const v = lines[i].trim();
    if (v === '$ACADVER' || v === '$DWGCODEPAGE') {
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

/** $ACADVER / $DWGCODEPAGE from the first ~4 KB (up to 64 KB) read as latin1. */
export function sniffDxfHeader(bytes) {
  let r = sniffHeaderText(latin1(bytes, 4096));
  if ((!r.acadver || !r.codepage) && !r.endOfHeader && bytes.length > 4096) r = sniffHeaderText(latin1(bytes, 65536));
  return { acadver: r.acadver, codepage: r.codepage };
}

function tryDecode(label, bytes, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function encodingForCodepage(codepage) {
  const label = CODEPAGE_ENCODINGS[codepage.trim().toUpperCase()];
  if (label && tryDecode(label, new Uint8Array(0)) !== null) return label;
  return 'windows-1252';
}

/**
 * Decode DXF bytes: UTF-8 BOM; AC1021+ is UTF-8; valid UTF-8 with non-ASCII bytes;
 * the $DWGCODEPAGE page; windows-1252. Returns { text, encoding, reason, acadver, codepage }.
 * @param {Uint8Array|Buffer} input
 */
export function decodeDxfBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sniff = sniffDxfHeader(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { ...sniff, text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', reason: 'bom' };
  const ver = /^AC(\d{4})$/i.exec(sniff.acadver.trim());
  if (ver && parseInt(ver[1], 10) >= 1021) return { ...sniff, text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', reason: 'version' };
  if (bytes.some((b) => b > 0x7f)) {
    const utf8 = tryDecode('utf-8', bytes, true);
    if (utf8 !== null) return { ...sniff, text: utf8, encoding: 'utf-8', reason: 'utf8-valid' };
  }
  const label = sniff.codepage ? encodingForCodepage(sniff.codepage) : 'windows-1252';
  const text = tryDecode(label, bytes) ?? new TextDecoder('windows-1252').decode(bytes);
  return { ...sniff, text, encoding: label, reason: sniff.codepage ? 'codepage' : 'default' };
}
