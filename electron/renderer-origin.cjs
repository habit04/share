/** Serve only bundled renderer assets from a secure origin, with a one-time preference migration. */
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { preferenceDictionary } = require('./renderer-preferences.cjs');
const APP_URL = 'jcad://app/index.html';

/**
 * Content-Security-Policy sent with worker scripts (docs/SECURITY-REVIEW.md E-19). The renderer
 * page keeps its own strict policy (index.html <meta>), which does not govern a dedicated worker
 * loaded from its own URL: the worker gets only what its response carries. The Manifold kernel
 * worker needs to load nothing but bundled scripts, fetch its bundled manifold.wasm and compile it,
 * so everything else is refused: no remote fetch or import(), no images, fonts, frames or nested
 * workers. 'self' is the jcad://app origin (a registered standard, secure scheme).
 */
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'";

/** Worker bundles: Vite emits every worker entry and chunk as assets/worker/<name>-<hash>.js (vite.config.ts). */
const WORKER_SCRIPT = /^\/assets\/worker\/[A-Za-z0-9._-]+\.m?js$/i;

/**
 * Extra response headers for the bundled file at `pathname`: WORKER_CSP for worker scripts,
 * nothing for anything else (the page, its scripts and styles, the wasm). The handler passes the
 * path of the file actually served (its real path relative to the real bundle root), never the
 * requested URL, so aliases that resolve to a worker file (a Windows 8.3 short name such as
 * `MANIFO~1.JS`, another letter case) still get the header. Case-insensitive as a second line of
 * defence for case-insensitive file systems.
 * @param {string} pathname
 * @returns {Record<string, string>}
 */
function assetResponseHeaders(pathname) {
  return WORKER_SCRIPT.test(pathname) ? { 'Content-Security-Policy': WORKER_CSP } : {};
}

/**
 * The URL the main window loads. The 3D security probe (scripts/e2e-3d-security.mjs) needs the
 * kernel's test hooks, which the renderer enables only for `?jcad3dTestHooks=1`; that query is
 * added only when JCAD_3D_TEST_HOOKS=1 is set AND the build allows inspection (a development run
 * or the dedicated test build), never in a shipping build.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} allowInspection
 */
function rendererStartUrl(env, allowInspection) {
  return allowInspection === true && env.JCAD_3D_TEST_HOOKS === '1' ? `${APP_URL}?jcad3dTestHooks=1` : APP_URL;
}

/**
 * `response` with the extra headers for `pathname` (the same response when there are none).
 * @param {Response} response
 * @param {string} pathname
 */
function withAssetHeaders(response, pathname) {
  const extra = Object.entries(assetResponseHeaders(pathname));
  if (!extra.length) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of extra) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetPath(root, url) {
  const u = new URL(url);
  if (u.protocol !== 'jcad:' || u.hostname !== 'app' || u.port || u.username || u.password) throw new Error('Unknown renderer origin');
  const name = decodeURIComponent(u.pathname);
  if (!name.startsWith('/') || /[\\\0:]/.test(name) || name.split('/').includes('..')) throw new Error('Invalid renderer asset path');
  const file = path.resolve(root, `.${name === '/' ? '/index.html' : name}`);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Renderer asset is outside the bundle');
  return file;
}

/**
 * The served file as a URL-style path: `/` + its real path relative to the real bundle root.
 * @param {string} relative  path.relative(realRoot, realFile)
 */
function servedPath(relative) {
  return `/${relative.split(path.sep).join('/')}`;
}

/** Native realpath returns stored spelling. Do not apply JavaScript Unicode case folding:
 * Windows can store distinct names that path.relative incorrectly treats as equal.
 * @param {string} realRoot
 * @param {string} realFile
 */
function containedAssetRelative(realRoot, realFile) {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realFile.startsWith(prefix) ? realFile.slice(prefix.length) : null;
}

function installAssetHandler({ protocol, net, root }) {
  protocol.handle('jcad', async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const file = assetPath(root, request.url);
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      const relative = containedAssetRelative(realRoot, realFile);
      if (!relative) return new Response('Forbidden', { status: 403 });
      // Decide headers from the file that is served, not from the URL that asked for it.
      return withAssetHeaders(await net.fetch(pathToFileURL(realFile).href), servedPath(relative));
    } catch { return new Response('Not found', { status: 404 }); }
  });
}


const fsSync = require('node:fs');
const { readLegacyLocalStorage, LEGACY_STORE_TOO_LARGE } = require('./legacy-leveldb.cjs');
/** Read the old file-origin storage without executing the old application or any plugins.
 *
 * Round 12: the read is a pure-JS parse of the legacy leveldb in this
 * process (electron/legacy-leveldb.cjs) — plain fs reads with full
 * sharing. Nothing opens the store with Chromium: no LOCK, no
 * append-open of MANIFEST/.log, no CURRENT rewrite, and the whole
 * copy/partition/hidden-window path of rounds 6-11 is gone, taking
 * the stall class it could not escape (Chromium's leveldb open of a
 * fresh copy colliding with the OS's on-close scans) with it. Any
 * parse failure throws, and the caller takes the failed-leg path
 * (no marker, retry next launch) — there is no window fallback.
 * The 8 MiB accounting is the dump's own, unchanged: the UTF-8 JSON
 * size of the dictionary, brackets included.
 *
 * Round 12b (R12-4): the read itself runs BEFORE whenReady
 * (readLegacyStoreBeforeReady, called from main.cjs right after the
 * pre-ready snapshot), so it never overlaps the default session's
 * own open of the store at whenReady. This leg only consumes that
 * result: a caught read error is rethrown here (the gate's failed
 * leg: no marker, retry next launch), a dictionary goes through the
 * unchanged accounting and validation. No result at all (the store
 * was not read before ready) is also a failed leg, never an empty
 * success.
 * @param {{ read: { values: Record<string, string> } | { error: unknown } | null }} options */
async function legacyStorage({ read }) {
  if (!read) throw new Error('The legacy store was not read before ready');
  if ('error' in read) throw read.error;
  const values = read.values;
  let size = 2;
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(values)) {
    size += encoder.encode(JSON.stringify([key, value])).byteLength;
    if (size > 8 * 1024 * 1024) throw new Error('Legacy preferences exceed 8 MiB');
  }
  return preferenceDictionary(values);
}

/**
 * Round 12b (R12-7, data preservation): a read error that says the
 * store's BYTES are bad — any parse/decode failure of the reader —
 * as opposed to a filesystem error (ENOENT-type absence, an AV
 * lock's EBUSY/EPERM: Node system errors carry a `syscall`), which
 * says nothing about the bytes, and as opposed to the reader's
 * size bound (a large store is not a corrupt one).
 * A file the store's metadata names but that is missing (a live
 * table, a listed log) is corruption to leveldb: the reader rethrows
 * that ENOENT as LEGACY_STORE_MISSING_FILE, with no syscall, so it is
 * a decode failure here too (R12-7 widening). Absence of the
 * directory or of CURRENT stays an fs error.
 * @param {unknown} error
 */
function legacyStoreDecodeFailure(error) {
  if (!error || typeof error !== 'object') return true;
  const { syscall, code } = /** @type {{ syscall?: unknown, code?: unknown }} */ (error);
  if (typeof syscall === 'string') return false;
  return code !== LEGACY_STORE_TOO_LARGE;
}

/**
 * Round 12b (R12-7, data preservation): COPY the legacy store (never
 * move, never delete; LOCK excluded) to
 * <Local Storage>/leveldb.preserved-<timestamp> before whenReady. A
 * store the reader cannot decode is one the default session's own
 * leveldb recovery may recreate at whenReady, wiping its bytes; the
 * copy keeps them for a later fix, while Chromium's behaviour is
 * unchanged. Bounded: once per distinct failure — skipped when an
 * existing leveldb.preserved-* directory already holds the same
 * MANIFEST file name(s) and size(s) (CURRENT's when the store has no
 * MANIFEST). MANIFEST files are copied LAST, so a copy torn by a
 * failure never satisfies that check. The path is logged once. Never
 * throws: any failure is logged and the caller continues.
 * @param {string} leveldbDir
 * @param {{ logError: (kind: string, error: unknown) => void, now?: () => Date }} options
 * @returns {string | null} the preserved copy, or null (skipped or failed)
 */
function preserveLegacyStore(leveldbDir, { logError, now = () => new Date() }) {
  try {
    const parent = path.dirname(leveldbDir);
    const prefix = `${path.basename(leveldbDir)}.preserved-`;
    const files = fsSync.readdirSync(leveldbDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'LOCK').map((entry) => entry.name);
    const manifests = files.filter((name) => name.startsWith('MANIFEST-'));
    const identity = (manifests.length ? manifests : ['CURRENT'])
      .map((name) => ({ name, size: fsSync.statSync(path.join(leveldbDir, name)).size }));
    for (const name of fsSync.readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const earlier = path.join(parent, name);
      const same = identity.every((file) => {
        try { return fsSync.statSync(path.join(earlier, file.name)).size === file.size; } catch { return false; }
      });
      if (same) return null;
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let target = path.join(parent, `${prefix}${stamp}`);
    for (let counter = 2; fsSync.existsSync(target); counter += 1) target = path.join(parent, `${prefix}${stamp}-${counter}`);
    fsSync.mkdirSync(target);
    const ordered = [...files.filter((name) => !name.startsWith('MANIFEST-')), ...manifests];
    for (const name of ordered) fsSync.copyFileSync(path.join(leveldbDir, name), path.join(target, name), fsSync.constants.COPYFILE_EXCL);
    logError('renderer preference migration', new Error(`Unreadable legacy store preserved at ${target}`));
    return target;
  } catch (error) {
    logError('renderer preference migration', error);
    return null;
  }
}

/**
 * Round 12b (R12-4): the synchronous pre-ready read of the legacy
 * store. main.cjs calls it after the single-instance lock and the
 * legacy-store snapshot, before app.whenReady() and before anything
 * touches the default session. It never throws: it returns the
 * dictionary, or the caught error for the leg to fail with.
 * R12-7: on a decode failure it first preserves a copy of the store
 * (preserveLegacyStore, which never throws), still before whenReady.
 * @param {string} leveldbDir
 * @param {{ logError: (kind: string, error: unknown) => void, now?: () => Date }} options
 * @returns {{ values: Record<string, string> } | { error: unknown }}
 */
function readLegacyStoreBeforeReady(leveldbDir, { logError, now }) {
  try {
    return { values: readLegacyLocalStorage(leveldbDir) };
  } catch (error) {
    if (legacyStoreDecodeFailure(error)) preserveLegacyStore(leveldbDir, { logError, now });
    return { error };
  }
}

module.exports = { APP_URL, WORKER_CSP, assetPath, assetResponseHeaders, installAssetHandler, legacyStorage, legacyStoreDecodeFailure, preserveLegacyStore, readLegacyStoreBeforeReady, rendererStartUrl, servedPath, withAssetHeaders };