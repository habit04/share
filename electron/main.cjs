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
 *   updates.cjs       app info, external links, update checks and status
 *   handover.cjs      files handed over by the OS and by a second launch
 */
const { app, BrowserWindow, ipcMain: rawIpcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const updater = require('./updater.cjs');
const { guardIpc, appUrlTest, createRejectionLog, createPathPolicy } = require('./ipc-guard.cjs');
const { createPathRegistry } = require('./path-registry.cjs');
const { recentFile, writeStateFile, installCrashLogging } = require('./main/app-data.cjs');
const { createWindows } = require('./main/window.cjs');
const { registerMenuIpc } = require('./main/menu.cjs');
const { dwgHost, readDwg, registerDwgIpc } = require('./main/dwg.cjs');
const { registerDrawingIpc } = require('./main/ipc-drawings.cjs');
const { registerPlotIpc } = require('./main/ipc-plot.cjs');
const { registerStoreIpc } = require('./main/ipc-stores.cjs');
const { registerUpdatesIpc } = require('./main/updates.cjs');
const { createHandover } = require('./main/handover.cjs');
const { MAX_DRAWING_BYTES, readLimitedFile } = require('./resource-limits.cjs');

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
const { takeHandedOverProject, handOverFiles, drawingArgs, registerSecondInstance } = createHandover(ctx);
registerDrawingIpc(ctx, { takeHandedOverProject });
registerPlotIpc(ctx);
registerStoreIpc(ctx);
registerMenuIpc(ctx);
registerUpdatesIpc(ctx);

// Headless probe used by packaging smoke tests:  jcad --probe-dwg <file.dwg>
const probeIndex = process.argv.indexOf('--probe-dwg');
if (probeIndex >= 0) {
  void app.whenReady().then(async () => {
    try {
      const file = process.argv[probeIndex + 1];
      const { payload, version } = await readDwg(/** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_DRAWING_BYTES)));
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
registerSecondInstance();

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
