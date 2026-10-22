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
 *   ipc-shx.cjs       explicit Windows SHX font / shape selection, read-only
 *   startup-migration.cjs  the startup legacy-storage migration gate (P-MIG)
 *   updates.cjs       app info, external links, update checks and status
 *   handover.cjs      files handed over by the OS and by a second launch
 */
const { app, BrowserWindow, session, ipcMain: rawIpcMain, protocol, net } = require('electron');
const { createGPUCollector } = require('./gpu-diagnostics.cjs');
const gpuCollector = createGPUCollector(app, { versions: {
  jcad: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome,
  windows: process.platform === 'win32' ? require('node:os').release() : 'Unknown',
} });
app.on('will-quit', () => gpuCollector.dispose());
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
const { stateDir, recentFile, writeStateFile, logMainError, flushRendererPreferences, readRendererPreferences, renameUnreadableCheckpoint, checkpointRendererPreferences, latestRendererPreferences, installCrashLogging } = require('./main/app-data.cjs');
const { createWindows } = require('./main/window.cjs');
const { runStartupMigration } = require('./main/startup-migration.cjs');
const { registerMenuIpc } = require('./main/menu.cjs');
const { dwgHost, readDwg, registerDwgIpc } = require('./main/dwg.cjs');
const { registerDrawingIpc } = require('./main/ipc-drawings.cjs');
const { registerPlotIpc } = require('./main/ipc-plot.cjs');
const { registerStoreIpc } = require('./main/ipc-stores.cjs');
const { registerXrefIpc } = require('./main/ipc-xrefs.cjs');
const { registerShxIpc } = require('./main/ipc-shx.cjs');
const { registerUpdatesIpc } = require('./main/updates.cjs');
const { createHandover } = require('./main/handover.cjs');
const { createFontMetricsHost } = require('./font-metrics-host.cjs');
const { createRestrictedPdfHost } = require('./restricted-pdf/host.cjs');
const { createRestrictedPdfRegistry } = require('./restricted-pdf/registry.cjs');
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
const { createPluginRealmRegistry, installAssetHandler, legacyStorage, readLegacyStoreBeforeReady } = require('./renderer-origin.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'jcad', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const DEV_URL = require('./inspection-policy.cjs').developmentServerUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL);
/** @type {{ values: Record<string, string>, source: 'checkpoint' | 'legacy' } | null} */
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

const fontMetricsHost = process.platform === 'win32' ? createFontMetricsHost() : null;
/**
 * Restricted PDF services (milestone 12.4): the qpdf transform host and the
 * job registration registry, both Windows-only like the font host they bind
 * to (the registry's mode proof reads the font host's admission records).
 */
const restrictedPdf = fontMetricsHost ? { host: createRestrictedPdfHost(), registry: createRestrictedPdfRegistry({ fontHost: fontMetricsHost }) } : null;
/**
 * Plugin-realm served roots (AMENDMENT-P25-CSP-HOSTING Part A): main-vetted
 * plugin packages registered per isolated session and served by the jcad://
 * handler under the worker CSP. Registrations are session-lived: dropped
 * when the renderer unserves a session, and cleared wholesale when the last
 * window closes and on app quit (below).
 */
const pluginRealm = createPluginRealmRegistry();
/**
 * What the modules under electron/main/ share (electron/main/context.cjs): the guarded ipcMain
 * and the path registry and policy above - the only way they register handlers and grant or
 * check paths - and the main window.
 * @type {import('./main/context.cjs').MainContext}
 */
const ctx = { ipcMain, rejections, registry, pathPolicy, senderWindow, mainWindow: null, openFilesReady: false, handedOverProjects: new Set(), restrictedPdf, pluginRealm,
  // Set when the startup legacy-storage migration did not complete (P-MIG): the migration must
  // not be marked complete for this launch - neither by the migrated checkpoint below nor by a
  // close-time checkpoint (electron/main/window.cjs) - so the next launch retries the extraction.
  legacyMigrationFailed: false,
  // Set when the startup preference checkpoint could not be read (corrupt or over-limit;
  // PR23 ASAR round 2): the checkpoint file and the migration marker are protected from
  // overwrite for this launch (see electron/main/startup-migration.cjs).
  checkpointUnreadable: false };
ipcMain.handle('gpu-diagnostics', () => gpuCollector.get());

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
registerShxIpc(ctx);
const xrefIpc = registerXrefIpc(ctx);
app.on('will-quit', () => xrefIpc.dispose());
registerMenuIpc(ctx);
registerUpdatesIpc(ctx);
const { registerAiIpc } = require('./main/ipc-ai.cjs');
registerAiIpc(ctx);
if (fontMetricsHost) ipcMain.handle('font-metrics', (_event, request) => fontMetricsHost.read(request).catch(() => null));
if (fontMetricsHost) ipcMain.handle('pdf-font', async (_event, request) => {
  try { return { font: await fontMetricsHost.readPdf(request) }; }
  catch (error) { return { font: null, problem: String(error?.message || 'Installed font embedding unavailable.') }; }
});
if (fontMetricsHost) ipcMain.handle('shape-font', async (_event, request) => {
  try { return { shaped: await fontMetricsHost.readShape(request) }; }
  catch (error) { return { shaped: null, problem: String(error?.message || 'Text shaping unavailable.') }; }
});
app.on('will-quit', () => { void fontMetricsHost?.dispose(); void restrictedPdf?.host.dispose(); restrictedPdf?.registry.retireAll(); });

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

// Round 12: snapshot the legacy store's existence NOW — after the
// single-instance lock, before whenReady. The store, if any, is read
// in-process by the migration gate below (electron/legacy-leveldb.cjs);
// there is no copy, partition or hidden window anymore. The snapshot
// discipline is round 9's, kept: the default session creates
// Local Storage/leveldb at whenReady, so a live check inside the
// gate would see a store even on a fresh profile and run the leg
// against nothing. No store at snapshot time => no leg: the gate's
// empty outcome, the marker acknowledged normally.
// Round 12b (R12-1, R9-1 restored): "a store" means a leveldb DATABASE,
// i.e. the directory holds CURRENT. A directory without CURRENT (a
// stray LOG, an empty folder) is no store: no leg, and the marker is
// acknowledged normally instead of a refused launch 1.
const legacyStorePresent = !DEV_URL && fsSync.existsSync(path.join(stateDir(), 'Local Storage', 'leveldb', 'CURRENT'));
// Round 12b (R12-4): READ the legacy store here too, synchronously,
// before whenReady and before anything touches the default session
// — so the read never overlaps the default session's own open of the
// store at whenReady. The result (the dictionary, or the caught error)
// is handed to the gate's legacy leg below, which only consumes it.
// The read runs only when the leg can run: a store is present and the
// migration marker is absent (the gate never reaches the leg once the
// marker exists, and only this process writes it, after the gate).
// Round 12b (R12-7): when that read fails to DECODE the store, a copy
// of it (LOCK excluded) is preserved at Local Storage/leveldb.preserved-
// <timestamp> here, still before whenReady — the default session's own
// recovery may recreate a corrupt store at whenReady and wipe its bytes.
// The path is logged once; the leg then fails as before.
const legacyRead = legacyStorePresent && !fsSync.existsSync(path.join(stateDir(), 'renderer-origin-migrated'))
  ? readLegacyStoreBeforeReady(path.join(stateDir(), 'Local Storage', 'leveldb'), { logError: logMainError })
  : null;

registerSecondInstance();

// Main-process failures go to a log the user can send with a problem report.
installCrashLogging();

// Protect every contents, including temporary migration and plot windows.
installWebContentsGuards(app);

app.whenReady().then(async () => {
  // The legacy-store snapshot and read were taken before whenReady
  // (rounds 12/12b — see the legacyStorePresent and legacyRead
  // bindings above); the gate consumes them below.
  installPermissionHandlers(session.defaultSession, () => (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow.webContents : null));
  installAssetHandler({ protocol, net, root: path.join(__dirname, '..', 'dist'), pluginRealm });
  if (!DEV_URL) {
    // The startup legacy-storage migration gate (P-MIG) lives in
    // electron/main/startup-migration.cjs: it decides the startup storage and writes
    // ctx.legacyMigrationFailed (only a failed migration LEG sets it - see that module),
    // binding the real units here. A failed migration no longer stops startup behind a
    // modal dialog (PR23 ASAR diagnosis): startup continues with no stored values, the
    // migration is not marked complete, and the next launch retries the extraction.
    rendererStorage = await runStartupMigration({
      ctx,
      readCheckpoint: readRendererPreferences,
      renameCheckpointAside: renameUnreadableCheckpoint,
      markerExists: () => fsSync.existsSync(path.join(stateDir(), 'renderer-origin-migrated')),
      // Round 12: decide from the pre-ready snapshot, never the live
      // folder (round 9's rule, kept). The default session creates
      // Local Storage/leveldb at whenReady, so the live check is true
      // even on a fresh profile.
      legacyStoreExists: () => legacyStorePresent,
      runLegacy: async () => {
        // Round 12b (R12-4): the leveldb was read BEFORE whenReady
        // (legacyRead above); legacyStorage only consumes that result
        // and resolves a dictionary, or throws the caught read error,
        // which the gate takes as the failed leg (retry next launch).
        // The null mapping is the gate contract from the window era,
        // kept: the leg never resolves null today, but an incomplete
        // read must never read as a successful empty migration.
        const values = await legacyStorage({ read: legacyRead });
        return values === null ? { values: null, ok: false } : { values, ok: true };
      },
      logError: logMainError,
    });
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

ipcMain.on('renderer-storage-migration', (event) => {
  // macOS can reopen a window in this process after close; use the latest committed snapshot,
  // including an authoritative empty dictionary, rather than the earlier startup migration.
  const values = latestRendererPreferences();
  event.returnValue = values === null ? rendererStorage : { values, source: 'checkpoint' };
});
ipcMain.handle('renderer-storage-migrated', async (event) => {
  try {
    // A failed startup migration (P-MIG) must not be marked complete: this checkpoint is the
    // only write of the migration marker file, and it would also make the next launch take the
    // checkpoint branch and never retry the legacy extraction. An unreadable checkpoint
    // (round 2) must not be overwritten either: its bytes are preserved for the next launch.
    // Skip it; the next launch retries.
    if (ctx.legacyMigrationFailed || ctx.checkpointUnreadable) return false;
    const values = await checkpointRendererPreferences(event.sender, true);
    rendererStorage = { values, source: 'checkpoint' };
    flushRendererPreferences(event.sender);
    return true;
  } catch (error) {
    logMainError('renderer preference migration', error);
    throw error;
  }
});

app.on('will-quit', () => dwgHost.dispose());

// Plugin-realm registrations end with the app and with the main window
// (AMENDMENT-P25-CSP-HOSTING condition (c)); a session's own dispose also
// unserves it from the renderer side.
app.on('will-quit', () => pluginRealm.clear());

app.on('window-all-closed', () => {
  if (startingMainWindow) return; // The temporary preference-migration window has just closed.
  pluginRealm.clear();
  ctx.mainWindow = null;
  if (process.platform !== 'darwin') app.quit();
});
