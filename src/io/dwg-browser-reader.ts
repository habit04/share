/** This module is loaded only inside the browser DWG worker. */
import { toImportPayload, type DwgImportPayload } from './dwg';

export async function parseBrowserDwg(bytes: ArrayBuffer): Promise<{ payload: DwgImportPayload; version: string }> {
  const [{ LibreDwg, createModule }, wasmUrl] = await Promise.all([
    import('@mlightcad/libredwg-web'),
    import('../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url'),
  ]);
  const instance = await createModule({ locateFile: () => wasmUrl.default });
  const l = LibreDwg.createByWasmInstance(instance);
  const ptr = l.dwg_read_data(bytes, 0);
  if (!ptr) throw new Error('LibreDWG could not read this file (unsupported version or corrupt data).');
  try {
    const v: unknown = l.dwg_get_version_type(ptr);
    const version = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string' ? (v as { type: string }).type : '';
    return { payload: toImportPayload(l.convert(ptr), version), version };
  } finally {
    l.dwg_free(ptr);
  }
}
