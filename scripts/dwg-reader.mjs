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
  const payload = {
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
    })),
    version,
  };
  return { payload, version };
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
