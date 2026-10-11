/**
 * The Electron main process. It creates the IPC guard (electron/ipc-guard.cjs) and the path registry
 * (electron/path-registry.cjs) - the only way IPC handlers are registered and paths are granted -
 * and wires the modules under electron/main/ (module map: docs/DEVELOPMENT.md), which receive them
 * in a shared context (electron/main/context.cjs):
 *
 *   app-data.cjs      state files in the app-data folder, crash-safe user-file writes, error.log
 *   menu.cjs          the native menu and File > Open Recent
 *   window.cjs        the main window: bounds, the close / quit / update-restart workflow
 *   dwg.cjs           DXF decoding, DWG reading in a worker (progress, cancel)
 *   ipc-drawings.cjs  open / save drawings and projects, Save As paths, backups, images
 */
const { app, BrowserWindow, dialog, ipcMain: rawIpcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const updater = require('./updater.cjs');
const { atomicWriteFile } = require('./atomic-write.cjs');
const { createAutosaveStore, safeAutosaveName } = require('./autosave-store.cjs');
const { guardIpc, appUrlTest, createRejectionLog, createPathPolicy, externalUrl } = require('./ipc-guard.cjs');
const { createPathRegistry, pathKey } = require('./path-registry.cjs');
const { stateDir, recentFile, autosaveDir, enqueueWrite, writeStateFile, writeUserFile, installCrashLogging } = require('./main/app-data.cjs');
const { createWindows } = require('./main/window.cjs');
const { registerMenuIpc } = require('./main/menu.cjs');
const { dwgHost, readDwg, registerDwgIpc } = require('./main/dwg.cjs');
const { registerDrawingIpc } = require('./main/ipc-drawings.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Every IPC listener checks its caller: only the application page in the main window's top
// frame may use the bridge (electron/ipc-guard.cjs). Refusals go to <userData>/ipc-rejections.log.
const rejections = createRejectionLog(() => app.getPath('userData'));
const ipcMain = guardIpc(rawIpcMain, {
  getWindow: () => ctx.mainWindow,
  isAppUrl: appUrlTest(path.join(__dirname, '..', 'dist', 'index.html'), DEV_URL),
  log: rejections,
});
/**
 * The paths the renderer may name: readable (open by name) and writable (save over / back up by
 * name), persisted in recent.json (electron/path-registry.cjs). File content (a project's
 * drawing list) makes only .dxf / .dwg drawings writable - outside the project's folder only for a
 * project the user chose (dialog, OS hand-over, Recent Documents) - and the catalog file never.
 */
const registry = createPathRegistry({ onChange: () => void writeStateFile(recentFile(), registry.serialize(), 'recent.json') });
/** Path rules shared by every file IPC (readable / writable paths, image locations, folders we own). */
const pathPolicy = createPathPolicy({
  isKnownPath: (p) => registry.isKnown(p),
  isWritablePath: (p) => registry.isWritable(p),
  knownPaths: () => registry.paths(),
  log: rejections,
});
/** The window that sent an IPC message (the guard has already checked it is the main window). */
function senderWindow(/** @type {Electron.IpcMainInvokeEvent} */ ev) {
  const win = BrowserWindow.fromWebContents(ev.sender) || ctx.mainWindow;
  if (!win) throw new Error('No application window');
  return win;
}

/**
 * What the modules under electron/main/ share (electron/main/context.cjs): the guarded ipcMain
 * and the path registry and policy above - the only way they register handlers and grant or
 * check paths - and the main window.
 * @type {import('./main/context.cjs').MainContext}
 */
const ctx = { ipcMain, rejections, registry, pathPolicy, senderWindow, mainWindow: null, openFilesReady: false };

function loadPersistedPaths() {
  try {
    registry.restore(fsSync.readFileSync(recentFile(), 'utf8'));
  } catch {
    /* first run */
  }
}

// ------------------------------------------------------------------ the modules (electron/main/)
const { createWindow } = createWindows(ctx, DEV_URL);
registerDwgIpc(ctx);
registerDrawingIpc(ctx, { takeHandedOverProject });
registerMenuIpc(ctx);

/** Plot: the renderer sends a PNG data URL of the sheet; we print it to PDF via a hidden window. */
ipcMain.handle('plot-pdf', async (ev, dataUrl, suggestName, landscape, sheet) => {
  const win = senderWindow(ev);
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Invalid image');
  const res = await dialog.showSaveDialog(win, {
    title: 'Plot to PDF',
    defaultPath: String(suggestName || 'Drawing1.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    // Keep the navigation URL tiny and inject the (possibly multi-megabyte) image afterwards.
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0}</style></head><body><img id="p"></body></html>';
    await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await hidden.webContents.executeJavaScript(`new Promise((ok, fail) => { const i = document.getElementById('p'); i.onload = () => ok(true); i.onerror = () => fail(new Error('image')); i.src = ${JSON.stringify(dataUrl)}; })`);
    // printToPDF takes a named size or {width, height} in INCHES (print() uses microns).
    const pdf = await hidden.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      landscape: Boolean(landscape),
      pageSize: pdfPageSize(sheet, landscape),
    });
    await writeUserFile(res.filePath, pdf);
    return res.filePath;
  } finally {
    hidden.destroy();
  }
});

// Track E: vector PLOT output. The renderer builds the PDF (src/io/pdf-vector.ts); this only asks where to save it.
ipcMain.handle('save-pdf', async (ev, bytes, suggestName) => {
  const win = senderWindow(ev);
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 512 * 1024 * 1024) throw new Error('Invalid PDF payload');
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Invalid PDF payload');
  const res = await dialog.showSaveDialog(win, {
    title: 'Plot to PDF',
    defaultPath: String(suggestName || 'Drawing1.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await writeUserFile(res.filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return res.filePath;
});

const NAMED_PAGES = new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger']);
/** Sheet dimensions in portrait inches (Electron applies `landscape` itself). */
function sheetPortrait(sheet, landscape) {
  const w = sheet && Number.isFinite(sheet.width) && sheet.width > 0 ? sheet.width : landscape ? 11 : 8.5;
  const h = sheet && Number.isFinite(sheet.height) && sheet.height > 0 ? sheet.height : landscape ? 8.5 : 11;
  return w > h ? { width: h, height: w } : { width: w, height: h };
}
/** printToPDF page size: a named paper when possible, else inches. */
function pdfPageSize(sheet, landscape) {
  if (sheet && NAMED_PAGES.has(sheet.electron)) return sheet.electron;
  return sheetPortrait(sheet, landscape);
}
/** print() page size: a named paper when possible, else microns. */
function printPageSize(sheet, landscape) {
  if (sheet && NAMED_PAGES.has(sheet.electron) && sheet.electron !== 'Ledger') return sheet.electron;
  const p = sheetPortrait(sheet, landscape);
  return { width: Math.round(p.width * 25400), height: Math.round(p.height * 25400) };
}

/** Render the plot image in a hidden window and hand it to the OS print dialog. */
ipcMain.handle('print-drawing', async (ev, dataUrl, title, landscape, sheet) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Invalid image');
  const hidden = new BrowserWindow({ show: false, parent: win || undefined, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${String(title || 'Drawing').replace(/[<>&]/g, '')}</title><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0;size:${landscape ? 'landscape' : 'portrait'}}</style></head><body><img id="p"></body></html>`;
    await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await hidden.webContents.executeJavaScript(`new Promise((ok, fail) => { const i = document.getElementById('p'); i.onload = () => ok(true); i.onerror = () => fail(new Error('image')); i.src = ${JSON.stringify(dataUrl)}; })`);
    return await new Promise((resolve, reject) => {
      hidden.webContents.print({ silent: false, printBackground: true, landscape: Boolean(landscape), margins: { marginType: 'none' }, pageSize: printPageSize(sheet, landscape) }, (success, failureReason) => {
        if (success) resolve(true);
        else if (!failureReason || /cancel/i.test(failureReason)) resolve(false);
        else reject(new Error(failureReason));
      });
    });
  } finally {
    hidden.destroy();
  }
});

// ------------------------------------------------------------------ autosave (app data folder)
// <document id>.sv.dxf files plus index.json, written crash-safely (electron/autosave-store.cjs).
let autosaveStore = null;
const autosave = () => {
  if (!autosaveStore || autosaveStore.dir !== autosaveDir()) autosaveStore = createAutosaveStore(autosaveDir());
  return autosaveStore;
};
ipcMain.handle('autosave-write', (_ev, name, text, meta) => autosave().write(safeAutosaveName(name), text, meta));
/** Rejects when the folder exists but cannot be read: the Recovery Manager shows that instead of "no backups". */
ipcMain.handle('autosave-list', () => autosave().list());
ipcMain.handle('autosave-read', (_ev, name) => autosave().read(safeAutosaveName(name)));
ipcMain.handle('autosave-remove', (_ev, name) => autosave().remove(safeAutosaveName(name)));

// ------------------------------------------------------------------ user symbol library (app data folder)
const userLibraryFile = () => path.join(stateDir(), 'user-library.json');
/** Only a missing file means "no library yet"; any other failure (EBUSY, EPERM, EIO) is reported so the renderer refuses to overwrite. */
ipcMain.handle('user-library-read', async () => {
  try {
    return await fs.readFile(userLibraryFile(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
});
ipcMain.handle('user-library-write', async (_ev, json) => {
  if (typeof json !== 'string' || json.length > 64 * 1024 * 1024) throw new Error('Invalid payload');
  await fs.mkdir(stateDir(), { recursive: true });
  const file = userLibraryFile();
  // Write to a temporary file and fsync it so a crash or power loss mid-write cannot leave an
  // empty or truncated library, keep the previous file as one .bak, then rename atomically.
  await enqueueWrite(file, () => atomicWriteFile(file, json, { backup: true }));
});

// ------------------------------------------------------------------ plugins (app data folder / plugins)
// One folder per plugin: plugins/<name>/plugin.json + the main .js it names (docs/PLUGIN-API.md).
// The main process only lists and reads the files; the renderer asks the user and runs the code.
const pluginsDir = () => path.join(stateDir(), 'plugins');
const PLUGIN_FOLDER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PLUGIN_MAIN_RE = /^[A-Za-z0-9._-]+\.js$/;
const MAX_PLUGIN_MANIFEST = 64 * 1024;
const MAX_PLUGIN_CODE = 2 * 1024 * 1024;
function safePluginFolder(name) {
  if (typeof name !== 'string' || name === '.' || name === '..' || !PLUGIN_FOLDER_RE.test(name)) throw new Error('Invalid plugin folder name');
  return name;
}
async function readLimited(file, max) {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  if (st.size > max) throw new Error(`${path.basename(file)} is larger than ${Math.round(max / 1024)} KB`);
  return fs.readFile(file, 'utf8');
}
/** The folder is created on first use so users can find it (PLUGINS prints it). */
ipcMain.handle('plugins-dir', async () => {
  await fs.mkdir(pluginsDir(), { recursive: true });
  return pluginsDir();
});
/** [{ folder, manifest (plugin.json text or null), error? }] for every sub-folder. */
ipcMain.handle('plugins-list', async () => {
  let dirents;
  try {
    dirents = await fs.readdir(pluginsDir(), { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory() || !PLUGIN_FOLDER_RE.test(d.name) || d.name === '.' || d.name === '..') continue;
    try {
      out.push({ folder: d.name, manifest: await readLimited(path.join(pluginsDir(), d.name, 'plugin.json'), MAX_PLUGIN_MANIFEST) });
    } catch (err) {
      out.push({ folder: d.name, manifest: null, error: err && err.code === 'ENOENT' ? 'no plugin.json' : String((err && err.message) || err) });
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
});
/** { manifest, code, path } of one plugin folder, or null when it does not exist. */
ipcMain.handle('plugins-read', async (_ev, folder) => {
  const dir = path.join(pluginsDir(), safePluginFolder(folder));
  let manifest;
  try {
    // A plugin folder (or its files) may not be a link to somewhere outside the plugins folder.
    await pathPolicy.insideRoot(pluginsDir(), path.join(dir, 'plugin.json'), 'plugins-read');
    manifest = await readLimited(path.join(dir, 'plugin.json'), MAX_PLUGIN_MANIFEST);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let main = 'main.js';
  try {
    const m = JSON.parse(manifest);
    if (m && m.main !== undefined) main = String(m.main);
  } catch {
    /* the renderer reports the bad JSON */
  }
  if (!PLUGIN_MAIN_RE.test(main)) throw new Error('plugin.json "main" must be a .js file in the plugin folder');
  const file = path.join(dir, main);
  await pathPolicy.insideRoot(pluginsDir(), file, 'plugins-read');
  return { manifest, code: await readLimited(file, MAX_PLUGIN_CODE), path: file };
});
// ------------------------------------------------------------------ catalog packs (app data folder / packs)
// Signed manufacturer catalogs (*.jcadpack.json, see docs/CATALOG-PACKS.md). The renderer verifies the
// signature; the main process only stores the files verbatim, one per pack, with atomic writes.
const packsDir = () => path.join(stateDir(), 'packs');
const PACK_NAME_RE = /^[A-Za-z0-9._-]+\.jcadpack\.json$/;
const MAX_PACK_BYTES = 20 * 1024 * 1024;
function safePackName(name) {
  if (typeof name !== 'string' || name.length > 200 || name.includes('..') || !PACK_NAME_RE.test(name)) throw new Error('Invalid pack file name');
  return name;
}
ipcMain.handle('packs-dir', () => packsDir());
ipcMain.handle('packs-list', async () => {
  try {
    return (await fs.readdir(packsDir())).filter((f) => PACK_NAME_RE.test(f)).sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
});
ipcMain.handle('packs-read', async (_ev, name) => {
  const file = path.join(packsDir(), safePackName(name));
  try {
    await pathPolicy.insideRoot(packsDir(), file, 'packs-read');
    const st = await fs.stat(file);
    if (st.size > MAX_PACK_BYTES) throw new Error(`Pack file is larger than ${MAX_PACK_BYTES / (1024 * 1024)} MB`);
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
});
ipcMain.handle('packs-write', async (_ev, name, text) => {
  const file = path.join(packsDir(), safePackName(name));
  if (typeof text !== 'string' || text.length > MAX_PACK_BYTES) throw new Error('Invalid pack payload');
  await fs.mkdir(packsDir(), { recursive: true });
  // Same discipline as the user library: write + fsync a temporary file, then rename over the target.
  await enqueueWrite(file, () => atomicWriteFile(file, text));
});
ipcMain.handle('packs-remove', async (_ev, name) => {
  await fs.rm(path.join(packsDir(), safePackName(name)), { force: true });
});
/** Native picker for a pack file; returns { name, text } (the renderer verifies and stores it) or null. */
ipcMain.handle('pick-pack-file', async (ev) => {
  const win = senderWindow(ev);
  const res = await dialog.showOpenDialog(win, {
    title: 'Install Catalog Pack',
    filters: [
      { name: 'JCad Catalog Pack', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const file = res.filePaths[0];
  const st = await fs.stat(file);
  if (st.size > MAX_PACK_BYTES) throw new Error(`Pack file is larger than ${MAX_PACK_BYTES / (1024 * 1024)} MB`);
  return { name: path.basename(file), text: await fs.readFile(file, 'utf8') };
});

// ------------------------------------------------------------------ updates
ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  selfUpdate: updater.canSelfUpdate(),
  releases: updater.RELEASES_PAGE,
}));
/**
 * Links the renderer may open: this project's GitHub pages and the Cash App donation page, compared
 * after the URL is parsed (electron/ipc-guard.cjs externalUrl); the normalised URL is opened.
 */
ipcMain.handle('open-external', async (_ev, url) => {
  const u = externalUrl(url);
  if (!u) {
    rejections.reject('open-external', `not an allowed link: ${String(url).slice(0, 300)}`);
    return false;
  }
  await require('electron').shell.openExternal(u);
  return true;
});
ipcMain.handle('check-updates', (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender) || ctx.mainWindow;
  return updater.checkForUpdates(win, { interactive: true });
});
updater.onStatus((status) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update-status', status);
});

// ------------------------------------------------------------------ files handed over by the OS
// "Open with JCad Electrical", a double click on a .dxf / .dwg / .jcadproj.json file (the installers
// register these types: package.json build.fileAssociations), a file dropped on the program icon or
// a second launch with a file: the paths arrive on the command line (or as macOS open-file events).
// They become openable (and writable) by path (the user named them) and the renderer opens each
// drawing in its own tab (pristine tab reused, an open tab shown) and a project as the current
// project - asked for once it has loaded (take-open-files), pushed afterwards (open-files).
const pendingOpenFiles = [];
/** The files the OS may hand over: drawings and project files. */
const HANDOVER_FILE = /\.(dxf|dwg)$|\.jcadproj\.json$/i;
/**
 * Project files handed over and not opened yet (pathKey): the user chose them, so open-project
 * registers what they list like a project chosen in the dialog, without relying on the renderer.
 */
const handedOverProjects = new Set();
function takeHandedOverProject(file) {
  const k = pathKey(file);
  return k !== null && handedOverProjects.delete(k);
}
/** Existing drawing and project files among command-line arguments (relative ones against `cwd`). */
function drawingArgs(argv, cwd) {
  const out = [];
  for (const a of Array.isArray(argv) ? argv.slice(1) : []) {
    if (typeof a !== 'string' || a.startsWith('-') || a.includes('\0') || !HANDOVER_FILE.test(a)) continue;
    const p = path.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), a);
    try {
      if (fsSync.statSync(p).isFile()) out.push(p);
    } catch {
      /* not a file: ignored */
    }
  }
  return out;
}
function handOverFiles(files) {
  if (!files.length) return;
  // The user handed these over (Open with, a double click): readable and writable like a dialog's choice.
  for (const f of files) {
    registry.grant(f);
    const k = pathKey(f);
    if (k !== null && /\.json$/i.test(f)) handedOverProjects.add(k);
  }
  const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null;
  if (ctx.openFilesReady && win) win.webContents.send('open-files', files);
  else pendingOpenFiles.push(...files);
}
ipcMain.handle('take-open-files', () => {
  ctx.openFilesReady = true;
  return pendingOpenFiles.splice(0);
});
app.on('open-file', (ev, file) => {
  ev.preventDefault();
  if (typeof file === 'string' && HANDOVER_FILE.test(file)) handOverFiles([file]);
});

// Headless probe used by packaging smoke tests:  jcad --probe-dwg <file.dwg>
const probeIndex = process.argv.indexOf('--probe-dwg');
if (probeIndex >= 0) {
  void app.whenReady().then(async () => {
    try {
      const file = process.argv[probeIndex + 1];
      const { payload, version } = await readDwg(await fs.readFile(file));
      dwgHost.dispose();
      process.stdout.write(`PROBE_OK ${version} entities=${payload.entities.length} blocks=${payload.blocks.length}\n`);
      app.exit(0);
    } catch (err) {
      process.stdout.write(`PROBE_FAIL ${err && err.message}\n`);
      app.exit(1);
    }
  });
  // @ts-expect-error TS1108: CommonJS modules may return at the top level (Node wraps them in a function).
  return;
}

// One running instance per user: the user library, recent list and window state are whole-file
// writes, so a second instance would silently overwrite the first one's changes. The probe above
// runs headless and must not take (or be blocked by) the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  // @ts-expect-error TS1108: CommonJS modules may return at the top level (Node wraps them in a function).
  return;
}
app.on('second-instance', (_ev, argv, workingDirectory) => {
  // A drawing handed to a second launch ("Open with", a double click) opens in this window.
  handOverFiles(drawingArgs(argv, workingDirectory));
  const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Main-process failures go to a log the user can send with a problem report.
installCrashLogging();

app.whenReady().then(() => {
  loadPersistedPaths();
  handOverFiles(drawingArgs(process.argv, process.cwd()));
  createWindow();
  updater.scheduleStartupCheck(() => ctx.mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => dwgHost.dispose());

app.on('window-all-closed', () => {
  ctx.mainWindow = null;
  if (process.platform !== 'darwin') app.quit();
});
