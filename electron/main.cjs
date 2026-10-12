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
const { app, BrowserWindow, session, ipcMain: rawIpcMain, protocol, net } = require('electron');
const { rejectsProductionDebugging } = require('./inspection-policy.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const testBuild = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).jcadTestBuild === true;
const debugArgs = [...process.argv, ...['remote-debugging-port', 'remote-debugging-pipe'].filter((name) => app.commandLine.hasSwitch(name)).map((name) => `--${name}`)];
if (rejectsProductionDebugging(app.isPackaged, testBuild, debugArgs)) {
  process.stdout.write('SHIPPING_DEBUG_DISABLED\n');
  app.exit(2);
  // @ts-expect-error TS1108: CommonJS modules may return at the top level.
  return;
}
const updater = require('./updater.cjs');
const { guardIpc, appUrlTest, createRejectionLog, createPathPolicy } = require('./ipc-guard.cjs');
const { createPathRegistry } = require('./path-registry.cjs');
const { stateDir, recentFile, writeStateFile, logMainError, flushRendererPreferences, installCrashLogging } = require('./main/app-data.cjs');
const { createWindows } = require('./main/window.cjs');
const { registerMenuIpc } = require('./main/menu.cjs');
const { dwgHost, readDwg, registerDwgIpc } = require('./main/dwg.cjs');
const { registerDrawingIpc } = require('./main/ipc-drawings.cjs');
const { registerPlotIpc } = require('./main/ipc-plot.cjs');
const { registerStoreIpc } = require('./main/ipc-stores.cjs');
const { registerUpdatesIpc } = require('./main/updates.cjs');
const { createHandover } = require('./main/handover.cjs');
const { runShippingProbe, shippingProbePhase } = require('./main/shipping-probe.cjs');
let probePhase = null;
try { probePhase = shippingProbePhase(process.argv); }
catch (error) {
  process.stdout.write(`SHIPPING_PROBE_FAIL ${error && error.message}\n`);
  app.exit(2);
  // @ts-expect-error TS1108: CommonJS modules may return at the top level.
  return;
}
if (probePhase) setTimeout(() => { process.stdout.write('SHIPPING_PROBE_FAIL startup timed out\n'); app.exit(1); }, 60_000);
const { installPermissionHandlers, installWebContentsGuards } = require('./web-security.cjs');

const { MAX_DRAWING_BYTES, readLimitedFile } = require('./resource-limits.cjs');
const { installAssetHandler, legacyStorage } = require('./renderer-origin.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'jcad', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const DEV_URL = require('./inspection-policy.cjs').developmentServerUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL);
/** @type {Record<string, string> | null} */
let rendererStorage = null;
let startingMainWindow = true;

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
const ctx = { ipcMain, rejections, registry, pathPolicy, senderWindow, mainWindow: null, openFilesReady: false, handedOverProjects: new Set() };

function loadPersistedPaths() {
  try {
    registry.restore(fsSync.readFileSync(recentFile(), 'utf8'));
  } catch {
    /* first run */
  }
}

// ------------------------------------------------------------------ the modules (electron/main/)
const { createWindow } = createWindows(ctx, DEV_URL, !app.isPackaged || testBuild);
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
      const bytes = /** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_DRAWING_BYTES));
      const first = await readDwg(bytes);
      if (!first.version || first.version === 'invalid' || first.payload.entities.length === 0) throw new Error('The DWG probe did not decode a nonempty drawing.');
      const cancelId = dwgHost.newId();
      const cancelled = readDwg(bytes, cancelId).then(() => false, (error) => error?.cancelled === true);
      if (!dwgHost.cancel(cancelId) || !await cancelled) throw new Error('The isolated DWG cancellation probe failed.');
      const damaged = await readDwg(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).then(() => false, () => true);
      if (!damaged) throw new Error('The isolated DWG damaged-file probe failed.');
      const { payload, version } = await readDwg(bytes);
      if (!dwgHost.usesProcess || version !== first.version || payload.entities.length !== first.payload.entities.length || payload.blocks.length !== first.payload.blocks.length) throw new Error('The isolated DWG recovery probe failed.');
      dwgHost.dispose();
      process.stdout.write(`PROBE_OK ${version} entities=${payload.entities.length} blocks=${payload.blocks.length} isolated=1 recovery=1\n`);
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

// Protect every contents, including temporary migration and plot windows.
installWebContentsGuards(app);

app.whenReady().then(async () => {
  installPermissionHandlers(session.defaultSession, () => (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow.webContents : null));
  installAssetHandler({ protocol, net, root: path.join(__dirname, '..', 'dist') });
  if (!DEV_URL && !fsSync.existsSync(path.join(stateDir(), 'renderer-origin-migrated'))) {
    try { rendererStorage = fsSync.existsSync(path.join(stateDir(), 'Local Storage', 'leveldb')) ? await legacyStorage({ BrowserWindow, protocol, indexFile: path.join(__dirname, '..', 'dist', 'index.html') }) : {}; }
    catch (error) { logMainError('renderer preference migration', error); }
  }
  loadPersistedPaths();
  handOverFiles(drawingArgs(process.argv, process.cwd()));
  await createWindow();
  startingMainWindow = false;
  if (probePhase) {
    await runShippingProbe(ctx, probePhase, testBuild);
    return;
  }
  updater.scheduleStartupCheck(() => ctx.mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('renderer-storage-migration', (event) => { event.returnValue = rendererStorage; });
ipcMain.on('renderer-storage-migrated', (event) => {
  if (rendererStorage === null || !flushRendererPreferences(event.sender)) return;
  rendererStorage = null;
  void writeStateFile(path.join(stateDir(), 'renderer-origin-migrated'), '1', 'renderer origin migration');
});

app.on('will-quit', () => dwgHost.dispose());

app.on('window-all-closed', () => {
  if (startingMainWindow) return; // The temporary preference-migration window has just closed.
  ctx.mainWindow = null;
  if (process.platform !== 'darwin') app.quit();
});
