/** Serve only bundled renderer assets from a secure origin, with a one-time preference migration. */
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath, pathToFileURL } = require('node:url');
const APP_URL = 'jcad://app/index.html';

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
      return net.fetch(pathToFileURL(realFile).href);
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

module.exports = { APP_URL, assetPath, installAssetHandler, legacyStorage };
