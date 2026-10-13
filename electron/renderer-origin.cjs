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
 * Extra response headers for the bundled file at decoded URL path `pathname`: WORKER_CSP for
 * worker scripts, nothing for anything else (the page, its scripts and styles, the wasm).
 * Case-insensitive because the bundle may sit on a case-insensitive file system.
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

function installAssetHandler({ protocol, net, root }) {
  protocol.handle('jcad', async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const file = assetPath(root, request.url);
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      const relative = path.relative(realRoot, realFile);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      return withAssetHeaders(await net.fetch(pathToFileURL(realFile).href), decodeURIComponent(new URL(request.url).pathname));
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

/** Read the old file-origin storage without executing the old application or any plugins. */
async function legacyStorage({ BrowserWindow, protocol, indexFile }) {
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
  } finally {
    window.destroy();
    if (handling) protocol.unhandle('file');
  }
}

module.exports = { APP_URL, WORKER_CSP, assetPath, assetResponseHeaders, installAssetHandler, legacyStorage, rendererStartUrl, withAssetHeaders };
