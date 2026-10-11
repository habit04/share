/**
 * Reading drawing files: DXF bytes decoded by their code page, DWG files parsed by LibreDWG in a
 * worker thread (electron/dwg-host.cjs: input, memory and time limits), with the renderer's
 * progress dialog and Cancel for large files.
 */
const path = require('node:path');
const { createDwgHost, progressThreshold } = require('../dwg-host.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** electron/: the reader scripts are in ../scripts. */
const ELECTRON_DIR = path.join(__dirname, '..');

/** @type {Promise<any> | null} */
let dwgReader = null;
/** LibreDWG in a worker thread (electron/dwg-host.cjs, scripts/dwg-worker.mjs), cancellable. */
const dwgHost = createDwgHost({ scriptsDir: path.join(ELECTRON_DIR, '..', 'scripts') });
/** The reader and the LibreDWG wasm are unpacked from the asar so Node's ESM loader can import them. */
function dwgReaderPath() {
  return path.join(ELECTRON_DIR, '..', 'scripts', 'dwg-reader.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}
/**
 * Import the reader module. pathToFileURL percent-encodes spaces and non-ASCII
 * characters, so an install folder such as "C:\Users\José\AppData\...\JCad Electrical" works.
 */
function loadReader() {
  if (!dwgReader) dwgReader = import(require('node:url').pathToFileURL(dwgReaderPath()).href);
  return dwgReader;
}
/** Decode DXF bytes by $DWGCODEPAGE / $ACADVER / BOM (scripts/dwg-reader.mjs, twin of src/io/encoding.ts). */
async function decodeDxf(bytes) {
  try {
    const mod = await loadReader();
    return mod.decodeDxfBytes(bytes);
  } catch {
    dwgReader = null;
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', reason: 'fallback' };
  }
}
/** Parse DWG bytes off the main thread, within the host's limits (the worker restarts after a WebAssembly abort). */
async function readDwg(bytes, id) {
  return dwgHost.read(bytes, id);
}

/**
 * Parse a DWG in the worker. Files over the progress threshold are announced to the renderer
 * ('open-progress': start / end / cancelled), which shows a dialog whose Cancel button calls
 * 'cancel-open'.
 */
async function readDwgWithProgress(win, file, bytes) {
  const id = dwgHost.newId();
  const announce = bytes.length >= progressThreshold() && win && !win.isDestroyed();
  const send = (/** @type {object} */ msg) => {
    if (announce && !win.webContents.isDestroyed()) win.webContents.send('open-progress', { id, name: path.basename(file), size: bytes.length, ...msg });
  };
  send({ state: 'start', cancellable: dwgHost.usesWorker });
  try {
    const r = await readDwg(bytes, id);
    send({ state: 'end' });
    return r;
  } catch (err) {
    send({ state: err && err.cancelled ? 'cancelled' : 'end' });
    throw err;
  }
}

/**
 * cancel-open: the Cancel button of the progress dialog.
 * @param {MainContext} ctx
 */
function registerDwgIpc(ctx) {
  const { ipcMain } = ctx;
  ipcMain.handle('cancel-open', (_ev, id) => (typeof id === 'number' ? dwgHost.cancel(id) : false));
}

module.exports = { dwgHost, decodeDxf, readDwg, readDwgWithProgress, registerDwgIpc };
