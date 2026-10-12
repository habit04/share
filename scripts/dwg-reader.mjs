/**
 * Node-side DWG reader shared by the Electron main process, the CLI and tests.
 * Loads LibreDWG (WebAssembly) lazily and returns a trimmed payload.
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertDwgMTextDatabase } from './dwg-mtext-background.mjs';
import { convertDwgDatabase } from './dwg-array-conversion.mjs';
import { convertDwgAppearanceDatabase } from './dwg-appearance-conversion.mjs';
import { readNativeDwg } from './dwg-native-read.mjs';
import { boundDwgWasmMemory } from './dwg-wasm-memory.mjs';
import createNativeModule from '../vendor/libredwg-web-bg/factory/libredwg-web.js';

let libPromise = null;

async function lib() {
  if (!libPromise) {
    libPromise = (async () => {
      const { LibreDwg } = await import('@mlightcad/libredwg-web');
      const wasmBinary = await readFile(new URL('../vendor/libredwg-web-bg/factory/libredwg-web.wasm', import.meta.url));
      // The native factory owns a defined memory; Module.wasmMemory cannot constrain it.
      // Lower the declaration on a checked copy before any initial memory is allocated.
      const instance = await createNativeModule({ wasmBinary: boundDwgWasmMemory(wasmBinary) });
      return LibreDwg.createByWasmInstance(instance);
    })();
  }
  return libPromise;
}

/** The largest DWG the reader accepts (electron/resource-limits.cjs MAX_DRAWING_BYTES). */
export const MAX_DWG_BYTES = 128 * 1024 * 1024;

/**
 * @param {Uint8Array|Buffer} bytes DWG or DXF file content
 * @param {'dwg'|'dxf'} kind
 * @returns {Promise<{payload: object, version: string}>}
 */
export async function readDwgPayload(bytes, kind = 'dwg') {
  if (bytes.byteLength > MAX_DWG_BYTES) throw new Error(`The DWG file is larger than the supported ${MAX_DWG_BYTES / (1024 * 1024)} MB.`);
  let l;
  let ptr;
  try {
    l = await lib();
    ptr = readNativeDwg(l, bytes, kind);
    let version = '';
    try {
      version = l.dwg_get_version_type(ptr)?.type ?? '';
    } catch {
      /* the file can still be converted without a version label */
    }
    const { Dwg_Object_Type } = await import('@mlightcad/libredwg-web');
    const db = convertDwgMTextDatabase(l, ptr, (reader, input) => convertDwgAppearanceDatabase(reader, input, (appearanceReader, drawing) => convertDwgDatabase(appearanceReader, drawing, Dwg_Object_Type)));
    return { payload: payloadFromDatabase(db, version), version };
  } finally {
    // A failed conversion releases the native memory like a successful one (ported from PR #2,
    // codex/electrical-review-fixes 2f89b0e). LibreDWG keeps per-version state in the module;
    // reading files of different versions in one instance can abort the WASM: start fresh.
    try {
      if (ptr) l.dwg_free(ptr);
    } finally {
      void resetLibreDwg();
    }
  }
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
      ...(x.handle ? { handle: String(x.handle) } : {}),
      colorIndex: x.colorIndex,
      color: x.color,
      colorName: x.colorName,
      transparency: x.transparency,
      transparencyType: x.transparencyType,
      standardFlag: x.standardFlag,
      plotFlag: x.plotFlag,
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
    styles: (db.tables?.STYLE?.entries ?? []).map((t) => ({
      name: t.name,
      ...(t.handle ? { handle: String(t.handle) } : {}),
      standardFlag: t.standardFlag,
      fixedTextHeight: t.fixedTextHeight,
      widthFactor: t.widthFactor,
      obliqueAngle: t.obliqueAngle,
      textGenerationFlag: t.textGenerationFlag,
      font: t.font,
      bigFont: t.bigFont,
    })),
    dimStyles: (db.tables?.DIMSTYLE?.entries ?? []).map((d) => ({ ...d, name: d.name })),
    linetypes: (db.tables?.LTYPE?.entries ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      standardFlag: t.standardFlag,
      pattern: (t.pattern ?? []).map((x) => ({ elementLength: x.elementLength, elementTypeFlag: x.elementTypeFlag })),
    })),
    layouts: (db.objects?.LAYOUT ?? []).map((l) => ({ name: l.layoutName, tabOrder: l.tabOrder, blockHandle: String(l.paperSpaceTableId ?? ''), minLimit: l.minLimit, maxLimit: l.maxLimit, ...(l.paperWidth !== undefined ? { plotSettings: l } : {}) })),
    omittedObjectTypes: Object.fromEntries(Object.entries(db.objects ?? {}).filter(([kind]) => !['LAYOUT', 'IMAGEDEF', 'IMAGEDEF_REACTOR'].includes(kind)).map(([kind, values]) => [kind, Array.isArray(values) ? values.length : 1])),
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
