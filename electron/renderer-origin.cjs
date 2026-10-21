/** Serve only bundled renderer assets from a secure origin, with a one-time preference migration. */
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath, pathToFileURL } = require('node:url');
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

/**
 * The legacy-storage extraction deadline (P-MIG). The migration runs before the main window
 * exists, so a hidden window whose load or script stalls would otherwise block startup forever:
 * the extraction gets one bounded window of time, then startup proceeds without the values.
 */
const MIGRATION_DEADLINE_MS = 15_000;

/**
 * Race `work` against the migration deadline. The race subscribes to `work`, so a late
 * settlement (including a rejection after the window is destroyed) is never unhandled.
 * @param {Promise<Record<string, string> | null>} work
 * @param {number} deadlineMs
 * @returns {Promise<Record<string, string> | null>}
 */
function migrationDeadline(work, deadlineMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Legacy storage migration timed out after ${deadlineMs} ms`)), deadlineMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read the old file-origin storage without executing the old application or any plugins.
 *
 * On success this resolves `{ values, ok: true }`, where `values` is exactly what the extraction
 * script returned (a null-prototype dictionary, or null when the script declined an oversize
 * store). On timeout or error it resolves `{ values: {}, ok: false }` and logs once through the
 * injected `logError` (the app's logMainError, injected so this module stays Electron-free):
 * the caller must then proceed with no legacy values and must NOT mark the migration complete,
 * so the next launch retries. Test C (2026-10-18) measured the migration completing in ~50 ms
 * on direct launches; the deadline is latent hardening, not a response to a reproduced hang.
 * @param {{ BrowserWindow: typeof import('electron').BrowserWindow, protocol: import('electron').Protocol, indexFile: string, deadlineMs?: number, logError?: ((kind: string, error: unknown) => void) | null }} deps
 * @returns {Promise<{ values: Record<string, string> | null, ok: boolean }>}
 */
async function legacyStorage({ BrowserWindow, protocol, indexFile, deadlineMs = MIGRATION_DEADLINE_MS, logError = null }) {
  // With file privileges fused off, Chromium denies access to the legacy file-origin store.
  // Relax origin checks only for this hidden, sandboxed migration window. Its exact file URL
  // serves constant HTML with default-src 'none'; no application, plugin or remote code runs.
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, devTools: false, webSecurity: false, allowRunningInsecureContent: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  let handling = false;
  try {
    protocol.handle('file', (request) => {
      try {
        if (path.resolve(fileURLToPath(request.url)).toLowerCase() !== path.resolve(indexFile).toLowerCase()) return new Response('', { status: 403 });
        return new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">', { headers: { 'content-type': 'text/html' } });
      } catch { return new Response('', { status: 403 }); }
    });
    handling = true;
    const extract = (async () => {
      await window.loadFile(indexFile);
      return await window.webContents.executeJavaScript(`(() => {
        const result = Object.create(null); const encoder = new TextEncoder(); let size = 2;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i), value = key === null ? null : localStorage.getItem(key);
          if (key === null || value === null) continue;
          // Include UTF-8 encoding and JSON escaping/overhead, rather than counting characters.
          size += encoder.encode(JSON.stringify([key, value])).byteLength;
          if (size > 8 * 1024 * 1024) return null;
          result[key] = value;
        }
        return result;
      })()`);
    })();
    const values = await migrationDeadline(extract, deadlineMs);
    return { values, ok: true };
  } catch (error) {
    if (logError) logError('renderer preference migration', error);
    return { values: {}, ok: false };
  } finally {
    window.destroy();
    if (handling) protocol.unhandle('file');
  }
}

module.exports = { APP_URL, MIGRATION_DEADLINE_MS, WORKER_CSP, assetPath, assetResponseHeaders, installAssetHandler, legacyStorage, rendererStartUrl, servedPath, withAssetHeaders };
