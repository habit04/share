/**
 * DWG reading in the browser edition (GitHub Pages / `npm run dev`).
 *
 * The desktop build parses DWG files with LibreDWG in the Electron main process
 * (scripts/dwg-reader.mjs). Without Electron there is no main process, so this
 * module loads the same @mlightcad/libredwg-web WebAssembly build in the
 * renderer and produces the payload that `convertDwg` (src/io/dwg.ts) expects.
 *
 * Everything heavy is behind a dynamic import: the ~10 MB wasm and the wrapper
 * are only fetched the first time a .dwg file is opened. The Electron renderer
 * build never includes them (`__JCAD_WEB__` is false there, see vite.config.ts),
 * so the desktop bundle is unchanged.
 */
import { toImportPayload, type DwgImportPayload } from './dwg';

/** Set by Vite: true for the website build and the dev server, false for the Electron renderer. */
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

interface LibreDwgLike {
  dwg_read_data(content: ArrayBuffer, fileType: number): number | undefined;
  dwg_get_version_type(ptr: number): unknown;
  convert(ptr: number): Parameters<typeof toImportPayload>[0];
  dwg_free(ptr: number): void;
}

let libPromise: Promise<LibreDwgLike> | null = null;

async function lib(): Promise<LibreDwgLike> {
  if (!libPromise) {
    libPromise = (async () => {
      // `if (__JCAD_WEB__)` becomes `if (false)` in the Electron renderer build, so Rollup drops
      // the imports and the wasm from dist/ (a bare `throw` would not be enough for that).
      if (typeof __JCAD_WEB__ !== 'undefined' && __JCAD_WEB__) {
        // The wasm is a Vite asset (hashed file name in site-dist/app/assets/); the
        // package's exports map hides its wasm folder, hence the file-system path.
        const [{ LibreDwg, createModule }, wasmUrlMod] = await Promise.all([
          import('@mlightcad/libredwg-web'),
          import('../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url'),
        ]);
        const wasmUrl = wasmUrlMod.default;
        const instance = await createModule({ locateFile: () => wasmUrl });
        return LibreDwg.createByWasmInstance(instance) as unknown as LibreDwgLike;
      }
      throw new Error('DWG files are opened by the desktop application in this build.');
    })();
    libPromise.catch(() => {
      libPromise = null;
    });
  }
  return libPromise;
}

/** Forget the module: LibreDWG keeps per-version state, so every read starts fresh (like scripts/dwg-reader.mjs). */
async function reset(): Promise<void> {
  libPromise = null;
  if (typeof __JCAD_WEB__ !== 'undefined' && __JCAD_WEB__) {
    try {
      const { LibreDwg } = await import('@mlightcad/libredwg-web');
      (LibreDwg as unknown as { instance: unknown }).instance = null;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse DWG bytes in the browser and return the same payload the Electron main
 * process sends over IPC, ready for `convertDwg`.
 */
export async function readDwgInBrowser(bytes: ArrayBuffer): Promise<{ payload: DwgImportPayload; version: string }> {
  if (!wasmSupported()) throw new Error('This browser does not support WebAssembly.');
  const l = await lib();
  try {
    const ptr = l.dwg_read_data(bytes, 0 /* Dwg_File_Type.DWG */);
    if (!ptr) throw new Error('LibreDWG could not read this file (unsupported version or corrupt data).');
    let version = '';
    try {
      version = versionLabel(l.dwg_get_version_type(ptr));
    } catch {
      /* ignore */
    }
    const db = l.convert(ptr);
    l.dwg_free(ptr);
    return { payload: toImportPayload(db, version), version };
  } finally {
    void reset();
  }
}
