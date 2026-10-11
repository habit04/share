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
 *   ipc-plot.cjs      plot to PDF, vector PDF, print
 *   ipc-stores.cjs    autosave, user library, plugins, catalog packs
 */
const { app, BrowserWindow, ipcMain: rawIpcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const updater = require('./updater.cjs');
const { guardIpc, appUrlTest, createRejectionLog, createPathPolicy, externalUrl } = require('./ipc-guard.cjs');
const { createPathRegistry, pathKey } = require('./path-registry.cjs');
const { recentFile, writeStateFile, installCrashLogging } = require('./main/app-data.cjs');
const { createWindows } = require('./main/window.cjs');
const { registerMenuIpc } = require('./main/menu.cjs');
const { dwgHost, readDwg, registerDwgIpc } = require('./main/dwg.cjs');
const { registerDrawingIpc } = require('./main/ipc-drawings.cjs');
const { registerPlotIpc } = require('./main/ipc-plot.cjs');
const { registerStoreIpc } = require('./main/ipc-stores.cjs');

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
registerPlotIpc(ctx);
registerStoreIpc(ctx);
registerMenuIpc(ctx);

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
