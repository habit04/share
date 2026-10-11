/** DWG browser parsing runs in a disposable worker, leaving the UI responsive. */
import type { DwgImportPayload } from './dwg';
import { readDwgWithWorker } from './dwg-worker-client';
import { createBrowserDwgWorker } from './dwg-browser-worker-factory';
declare const __JCAD_WEB__: boolean | undefined;

/** Which reader a picked file name needs, or null for anything we cannot open. */
export function drawingKindOf(name: string): 'dwg' | 'dxf' | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === 'dwg' || ext === 'dxf' ? ext : null;
}

/** LibreDWG returns e.g. `{ type: 'R_2000' }`; keep the string the desktop reader logs. */
export function versionLabel(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') return (v as { type: string }).type;
  return '';
}

/** True when the browser can instantiate WebAssembly at all (the wasm needs ~1 GB of address space). */
export function wasmSupported(scope: { WebAssembly?: unknown } = globalThis as { WebAssembly?: unknown }): boolean {
  const w = scope.WebAssembly as { instantiate?: unknown } | undefined;
  return !!w && typeof w.instantiate === 'function';
}

/** Explain a LibreDWG / WebAssembly failure to the user in one line. */
export function describeDwgError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/memory|RangeError|allocat/i.test(msg)) return `Not enough memory to load the DWG reader in this browser (${msg}). Try a desktop browser or the desktop app.`;
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return `The browser edition was updated while this page was open. Reload the page (F5) and open the drawing again.`;
  if (/wasm|WebAssembly|CompileError|LinkError/i.test(msg)) return `The DWG reader (WebAssembly) could not be loaded: ${msg}`;
  return msg;
}


/** Parse a DWG outside the renderer event loop; aborting terminates the parser. */
export async function readDwgInBrowser(bytes: ArrayBuffer, signal?: AbortSignal): Promise<{ payload: DwgImportPayload; version: string }> {
  if (typeof __JCAD_WEB__ === 'undefined' || !__JCAD_WEB__) throw new Error('DWG files are opened by the desktop application in this build.');
  if (!wasmSupported()) throw new Error('This browser does not support WebAssembly.');
  return readDwgWithWorker(bytes, createBrowserDwgWorker, { signal });
}
