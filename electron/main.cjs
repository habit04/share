const { app, BrowserWindow, Menu, dialog, ipcMain: rawIpcMain, screen, session, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const updater = require('./updater.cjs');
const { atomicWriteFile, backupFile, createWriteQueue } = require('./atomic-write.cjs');
const { createAutosaveStore, safeAutosaveName } = require('./autosave-store.cjs');
const { guardIpc, appUrlTest, createRejectionLog, createPathPolicy, dxfImageNames, externalUrl } = require('./ipc-guard.cjs');
const { createPathRegistry, pathKey } = require('./path-registry.cjs');
const { createDwgHost, progressThreshold } = require('./dwg-host.cjs');
const { MAX_DRAWING_BYTES, MAX_PROJECT_BYTES, validateTextSize, validatePaperDimensions, readLimitedFile } = require('./resource-limits.cjs');
const { APP_URL, installAssetHandler, legacyStorage } = require('./renderer-origin.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'jcad', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
/** @type {Record<string, string> | null} */
let rendererStorage = null;
let startingMainWindow = true;

// Every IPC listener checks its caller: only the application page in the main window's top
// frame may use the bridge (electron/ipc-guard.cjs). Refusals go to <userData>/ipc-rejections.log.
const rejections = createRejectionLog(() => app.getPath('userData'));
const ipcMain = guardIpc(rawIpcMain, {
  getWindow: () => mainWindow,
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
/** What each write channel accepts (besides being writable): save-dxf, save-project, backup-file. */
const DXF_FILE = /\.dxf$/i;
const PROJECT_FILE = /\.json$/i;
const BACKUP_FILE = /\.(dxf|jcadproj\.json)$/i;
/** The window that sent an IPC message (the guard has already checked it is the main window). */
function senderWindow(/** @type {Electron.IpcMainInvokeEvent} */ ev) {
  const win = BrowserWindow.fromWebContents(ev.sender) || mainWindow;
  if (!win) throw new Error('No application window');
  return win;
}

// ------------------------------------------------------------------ persisted main-process state
let recentFiles = [];
const stateDir = () => app.getPath('userData');
const recentFile = () => path.join(stateDir(), 'recent.json');
const windowStateFile = () => path.join(stateDir(), 'window-state.json');
const autosaveDir = () => path.join(stateDir(), 'autosave');
/** Writes of the same app-data file (recent list, window state) run one at a time, in call order. */
const enqueueWrite = createWriteQueue();
/** Crash-safe write of a small app-data file; failures are logged, never shown (the app keeps working). */
function writeStateFile(file, text, what) {
  return enqueueWrite(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, text);
  }).catch((err) => logMainError(what, err));
}
/**
 * Crash-safe write of a user file (drawing, project, export). Writes of one file run one at a time,
 * in the order the requests arrived, keyed by pathKey so "C:\Jobs\A.dxf" and "c:/jobs/a.DXF" share
 * a queue. The renderer orders the saves of one file by revision (src/app/savequeue.ts), but a
 * Save As (and a save whose path needed the dialog) only learns its file here: without this queue
 * a slower Save of the same file that started earlier could land after it and replace the newer
 * content while the drawing is shown as saved.
 */
function writeUserFile(file, data, opts) {
  return enqueueWrite(pathKey(file) ?? file, () => atomicWriteFile(file, data, opts));
}

function loadPersistedPaths() {
  try {
    registry.restore(fsSync.readFileSync(recentFile(), 'utf8'));
  } catch {
    /* first run */
  }
}

function readWindowState() {
  try {
    return JSON.parse(fsSync.readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function installWindowStatePersistence(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    void writeStateFile(windowStateFile(), JSON.stringify(state), 'window-state.json');
  };
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', debounced);
  win.on('unmaximize', debounced);
  win.on('close', save);
}
function initialBounds() {
  const st = readWindowState();
  const def = { width: 1500, height: 940 };
  if (!st || !st.bounds) return { ...def, maximized: false };
  const b = st.bounds;
  // Keep the window on a connected display.
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const visible = b.x + b.width > wa.x + 40 && b.x < wa.x + wa.width - 40 && b.y + b.height > wa.y + 40 && b.y < wa.y + wa.height - 40;
  return visible ? { x: b.x, y: b.y, width: Math.max(1000, b.width), height: Math.max(640, b.height), maximized: Boolean(st.maximized) } : { ...def, maximized: Boolean(st.maximized) };
}

// ------------------------------------------------------------------ menu
function buildMenu(win) {
  const send = (cmd) => () => win.webContents.send('menu-command', cmd);
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const recentSub = recentFiles.length
    ? [...recentFiles.map((f, i) => ({ label: `${i + 1}. ${path.basename(f)}`, toolTip: f, click: () => {
      const key = pathKey(f);
      if (key && PROJECT_FILE.test(f) && registry.isWritable(f)) handedOverProjects.add(key);
      win.webContents.send('menu-command', `RECENT ${i + 1}`);
    } })), { type: 'separator' }, { label: 'Clear Recent', click: send('CLEARRECENT') }]
    : [{ label: '(empty)', enabled: false }];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('NEW') },
        { label: 'New from Sheet Template…', click: send('NEWSHEET') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('OPEN') },
        { label: 'Open Recent', submenu: recentSub },
        { label: 'Open Project…', click: send('OPENPROJECT') },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: send('CLOSE') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('SAVE') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('SAVEAS') },
        { label: 'Plot to PDF…', accelerator: 'CmdOrCtrl+P', click: send('PLOT') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+Shift+P', click: send('PRINT') },
        { type: 'separator' },
        { label: 'Options…', click: send('OPTIONS') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('UNDO') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: send('REDO') },
        { type: 'separator' },
        { label: 'Cut', click: send('CUTCLIP') },
        { label: 'Copy', click: send('COPYCLIP') },
        { label: 'Paste', click: send('PASTECLIP') },
        { type: 'separator' },
        { label: 'Erase', click: send('ERASE') },
        { label: 'Move', click: send('MOVE') },
        { label: 'Copy Objects', click: send('COPY') },
        { label: 'Rotate', click: send('ROTATE') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('SELECTALL') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom Extents', click: send('ZOOM E') },
        { label: 'Zoom Window', click: send('ZOOM W') },
        { label: 'Zoom In', click: send('ZOOM I') },
        { label: 'Zoom Out', click: send('ZOOM O') },
        { type: 'separator' },
        { label: 'Grid (F7)', click: send('GRID') },
        { label: 'Ortho (F8)', click: send('ORTHO') },
        { label: 'Object Snap (F3)', click: send('OSNAP') },
        { label: 'Drafting Settings…', click: send('DSETTINGS') },
        { type: 'separator' },
        { label: 'Project Manager', click: send('TOGGLEPM') },
        { label: 'Properties (Ctrl+1)', click: send('PROPERTIES') },
        { label: 'Tool Palettes (Ctrl+3)', click: send('TOOLPALETTES') },
        { label: 'Layer Properties', click: send('LAYER') },
        { label: 'Command Window (Ctrl+9)', click: send('COMMANDLINE') },
        { label: 'Clean Screen (Ctrl+0)', click: send('CLEANSCREEN') },
        { type: 'separator' },
        ...(app.isPackaged ? [] : [/** @type {import('electron').MenuItemConstructorOptions} */ ({ role: 'toggleDevTools' })]),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Schematic',
      submenu: [
        { label: 'Insert Wire', click: send('AEWIRE') },
        { label: 'Insert Ladder…', click: send('AELADDER') },
        { label: 'Insert Component…', click: send('AECOMPONENT') },
        { label: 'Wire Numbers', click: send('AEWIRENO') },
        { label: 'Reports…', click: send('AEREPORT bom') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Next Drawing', accelerator: 'Ctrl+Tab', click: send('NEXTTAB') },
        { label: 'Previous Drawing', accelerator: 'Ctrl+Shift+Tab', click: send('PREVTAB') },
        { label: 'Close All Drawings', click: send('CLOSEALL') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Help (F1)', click: send('HELP') },
        { label: 'Keyboard Shortcuts', click: send('HELP shortcuts') },
        { label: 'Text Window (F2)', click: send('TEXTSCR') },
        { type: 'separator' },
        { label: 'Donate (Cash App)…', click: send('DONATE') },
        { label: 'Report a Problem…', click: send('REPORTBUG') },
        { label: 'Send Feedback…', click: send('FEEDBACK') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void updater.checkForUpdates(win, { interactive: true }) },
        { label: 'Release Notes (GitHub)', click: () => void require('electron').shell.openExternal(updater.RELEASES_PAGE) },
        { label: `About JCad Electrical ${app.getVersion()}`, click: send('ABOUT') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Set when electron-updater is about to quit and relaunch: the close veto must not run then. */
let quittingForUpdate = false;
require('electron').autoUpdater.on('before-quit-for-update', () => {
  quittingForUpdate = true;
});
/** app.quit() was requested (menu Quit, Cmd+Q, File > Exit): the close question says so, and macOS quits after the close. */
let quitRequested = false;
app.on('before-quit', () => {
  quitRequested = true;
});
/** Windows whose unsaved work was dealt with (saved or discarded): their next close goes through. */
const closeApproved = new WeakSet();

let closeSeq = 0;
/**
 * Ask the renderer to run its Save All workflow (src/app/closeflow.ts) and wait for the answer:
 * true = everything chosen was saved (or discarded), close now; false = cancelled or a save
 * failed. There is no timeout while the renderer is alive (the user may take a while in the
 * dialog); a renderer that crashed has nothing left to save, and one that does not acknowledge
 * the request within a few seconds (hung) gets a native Close Without Saving / Cancel question.
 * After Cancel there, a page that was only busy still shows the Save All dialog it was sent once it
 * responds again; that late answer is not ignored: when it allows the close, the window closes.
 */
function requestClose(win, context) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return resolve(true);
    const wc = win.webContents;
    const id = (closeSeq += 1);
    let acked = false;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      ipcMain.removeListener('close-ack', onAck);
      ipcMain.removeListener('close-response', onResponse);
      wc.removeListener('render-process-gone', onGone);
      wc.removeListener('destroyed', onGone);
      clearTimeout(timer);
    };
    const finish = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const onAck = (ev, rid) => {
      if (ev.sender === wc && rid === id) acked = true;
    };
    /** The native question was answered Cancel while the page was busy: its own answer may still come. */
    let late = false;
    const onResponse = (ev, rid, ok) => {
      if (ev.sender !== wc || rid !== id) return;
      if (!late) return finish(ok === true);
      cleanup();
      if (ok === true && !win.isDestroyed()) {
        closeApproved.add(win);
        win.close();
      }
    };
    const onGone = () => (late ? cleanup() : finish(true));
    ipcMain.on('close-ack', onAck);
    ipcMain.on('close-response', onResponse);
    wc.once('render-process-gone', onGone);
    wc.once('destroyed', onGone);
    wc.send('close-request', id, context);
    timer = setTimeout(() => {
      if (settled || acked) return;
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Close Without Saving', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'JCad Electrical is not responding.',
        detail: 'Unsaved changes cannot be saved now. Autosave copies of modified drawings stay available in the Drawing Recovery Manager.',
      });
      if (r === 0) return finish(true);
      // Cancel: the close is off for now, but keep listening for this request's answer (see above).
      settled = true;
      late = true;
      clearTimeout(timer);
      ipcMain.removeListener('close-ack', onAck);
      resolve(false);
    }, 5000);
  });
}
// Restart to install an update: the same Save All workflow first; the restart's own window close then goes through.
// electron-updater's quitAndInstall closes the window right away, but when the installer cannot be
// started it does nothing (and throws nothing). The approval therefore lapses: a later close (after
// more edits) asks about unsaved work again instead of going straight through.
const RESTART_APPROVAL_MS = 10_000;
updater.onConfirmRestart(async (w) => {
  const win = w && !w.isDestroyed() ? w : mainWindow;
  const ok = await requestClose(win, 'restart');
  if (ok && win) {
    closeApproved.add(win);
    setTimeout(() => {
      if (!win.isDestroyed()) closeApproved.delete(win);
    }, RESTART_APPROVAL_MS);
  }
  return ok;
});

/** Apply navigation restrictions to main and print contents. */
function secureContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
}
async function createWindow() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(contents === mainWindow?.webContents && permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    contents === mainWindow?.webContents && permission === 'clipboard-sanitized-write');
  const b = initialBounds();
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#2b2b2b',
    title: 'JCad Electrical',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  openFilesReady = false; // a new page asks for the files waiting for it
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  installWindowStatePersistence(win);
  buildMenu(win);
  secureContents(win.webContents);
  // Unsaved work: the renderer's Save All workflow decides; the close (and a quit) waits for it.
  let pendingClose = null;
  win.on('close', (e) => {
    if (win.webContents.isDestroyed()) return;
    if (closeApproved.has(win) || quittingForUpdate) {
      flushRendererPreferences(win.webContents);
      return;
    }
    e.preventDefault();
    if (pendingClose) return; // the dialog is already up
    pendingClose = requestClose(win, quitRequested ? 'quit' : 'close').then((ok) => {
      pendingClose = null;
      if (!ok) {
        quitRequested = false;
        return;
      }
      const quit = quitRequested;
      closeApproved.add(win);
      win.close();
      if (quit && process.platform === 'darwin') app.quit();
    });
  });
  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadURL(APP_URL);
  }
}

/** @type {Promise<any> | null} */
let dwgReader = null;
/** LibreDWG in a worker thread (electron/dwg-host.cjs, scripts/dwg-worker.mjs), cancellable. */
const dwgHost = createDwgHost({ scriptsDir: path.join(__dirname, '..', 'scripts') });
/** The reader and the LibreDWG wasm are unpacked from the asar so Node's ESM loader can import them. */
function dwgReaderPath() {
  return path.join(__dirname, '..', 'scripts', 'dwg-reader.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
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
/** Parse DWG bytes off the main thread (the worker restarts after a WebAssembly abort). */
async function readDwg(bytes, id) {
  return dwgHost.read(bytes, id);
}

/**
 * Open a DXF or DWG. Returns { path, kind: 'dxf', text } or { path, kind: 'dwg', payload, version } or null.
 * A file chosen in the dialog becomes readable and writable by name; opening a known file by name
 * (Recent Documents, a project's drawing) reads it and leaves its access as it was.
 */
async function openDrawingFile(win, file) {
  const chosen = !file;
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open Drawing',
      filters: [
        { name: 'Drawings (DXF, DWG)', extensions: ['dxf', 'dwg'] },
        { name: 'DXF Drawing', extensions: ['dxf'] },
        { name: 'DWG Drawing', extensions: ['dwg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    file = res.filePaths[0];
  } else if (!pathPolicy.known(file, 'open-drawing')) {
    // Only paths that came from our own dialogs / recent list may be opened by name.
    throw new Error('Unknown file path');
  }
  if (chosen) registry.grant(file);
  if (file.toLowerCase().endsWith('.dwg')) {
    // The DXF copy next to a DWG gets the DWG's access (DWG itself is never written).
    const twin = file.replace(/\.dwg$/i, '.dxf');
    if (registry.isWritable(file)) registry.grant(twin);
    else registry.grantRead(twin);
    const bytes = await readLimitedFile(fs, file, MAX_DRAWING_BYTES);
    const { payload, version } = await readDwgWithProgress(win, file, bytes);
    pathPolicy.rememberImages(file, (payload.imageDefs || []).map((d) => d && d.fileName));
    return { path: file, kind: 'dwg', payload, version };
  }
  // Read bytes, not a UTF-8 string: pre-2007 DXF files are in the $DWGCODEPAGE code page.
  const { text, encoding } = await decodeDxf(await readLimitedFile(fs, file, MAX_DRAWING_BYTES));
  pathPolicy.rememberImages(file, dxfImageNames(text));
  return { path: file, kind: 'dxf', text, encoding };
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
ipcMain.handle('cancel-open', (_ev, id) => (typeof id === 'number' ? dwgHost.cancel(id) : false));

ipcMain.handle('open-drawing', async (ev, file) => {
  const win = senderWindow(ev);
  if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
  return openDrawingFile(win, file);
});

/**
 * Read a project file (or, by name, a project's catalog file) and register the project's drawings
 * and catalog file (electron/path-registry.cjs registerProject). A project the user chose - in
 * this dialog, handed over by the OS, or from the native Recent menu - makes the drawings it lists writable
 * wherever they are; one opened only by name (a plugin, OPENPROJECT with a path) only those inside
 * its folder. A renderer's `opts.userChosen` claim grants no permission. `opts.textOnly` reads a JSON file for its text, and
 * nothing it lists is registered.
 */
ipcMain.handle('open-project', async (ev, file, opts) => {
  const win = senderWindow(ev);
  if (file !== undefined && file !== null && typeof file !== 'string') throw new Error('Invalid path');
  const o = opts && typeof opts === 'object' ? opts : {};
  file = file || undefined;
  const chosen = !file;
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      filters: [{ name: 'JCad Electrical Project', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    file = res.filePaths[0];
  } else {
    if (!pathPolicy.known(file, 'open-project')) throw new Error('Unknown file path');
    if (!PROJECT_FILE.test(file)) {
      rejections.reject('open-project', `wrong file type: ${file.slice(0, 300)}`);
      throw new Error('Unknown file path');
    }
  }
  const text = await readLimitedFile(fs, file, MAX_PROJECT_BYTES, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error('Not a valid project file');
  }
  if (chosen) registry.grant(file);
  // Only a project file the user may write registers what it lists: a file that is readable only
  // (a project's catalog file, read through this channel) grants nothing.
  const writable = registry.isWritable(file);
  const handedOver = takeHandedOverProject(file);
  const userChosen = chosen || handedOver;
  if (writable && o.textOnly !== true) registry.registerProject(file, parsed, { userChosen });
  return { path: file, text };
});

/** Save arbitrary text (CSV report, project file) through a save dialog. */
ipcMain.handle('save-text', async (ev, suggestName, text, filterName, ext) => {
  const win = senderWindow(ev);
  if (typeof text !== 'string') throw new Error('Invalid payload');
  const res = await dialog.showSaveDialog(win, {
    title: 'Save',
    defaultPath: String(suggestName || 'export.txt'),
    filters: [{ name: String(filterName || 'Text'), extensions: [String(ext || 'txt')] }],
  });
  if (res.canceled || !res.filePath) return null;
  // Crash-safe for every export; only a project file keeps its previous version as <name>.bak
  // (a .bak next to a CSV or text export would only clutter the user's folder).
  const isProject = /\.jcadproj\.json$/i.test(res.filePath) || String(filterName) === 'JCad Electrical Project';
  if (isProject) validateTextSize(text, MAX_PROJECT_BYTES, 'project');
  await writeUserFile(res.filePath, text, { backup: isProject });
  registry.grant(res.filePath);
  return res.filePath;
});

/**
 * The file a Save dialog's answer names once the channel's extension is appended to a name typed
 * without one (.dxf for drawings, .jcadproj.json for projects). The Windows and macOS dialogs
 * complete the name themselves and ask there before a file is replaced; the Linux (GTK) dialog asks
 * only about the name as typed, so when the completed name already exists, the question is asked
 * here. Resolves the completed path, or null when the user keeps that file.
 */
async function completeSavePath(win, chosen, type, ext) {
  const file = type.test(chosen) ? chosen : `${chosen}${ext}`;
  if (file === chosen) return file;
  const exists = await fs.access(file).then(() => true, () => false);
  if (!exists) return file;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `${path.basename(file)} already exists. Replace it?`,
    detail: `The name you typed was completed to ${file}. Replace keeps the previous version as ${path.basename(file)}.bak.`,
  });
  return r.response === 0 ? file : null;
}

/**
 * Project Save As: ask where to save; the path becomes writable by save-project but nothing is written
 * yet. A name typed without .json gets .jcadproj.json (and is asked about when that file exists).
 */
ipcMain.handle('choose-project-path', async (ev, suggestName) => {
  const win = senderWindow(ev);
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Project As',
    defaultPath: String(suggestName || 'Project.jcadproj.json'),
    filters: [{ name: 'JCad Electrical Project', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const file = await completeSavePath(win, res.filePath, PROJECT_FILE, '.jcadproj.json');
  if (!file) return null;
  registry.grant(file);
  return file;
});

/**
 * Drawing Save As: ask where to save; the path becomes writable by save-dxf (a .dxf file: a name
 * typed without the extension gets it, and is asked about when that file already exists -
 * completeSavePath) but nothing is written yet. The renderer then writes it
 * through its per-file save queue (src/app/savequeue.ts), so a Save As onto a file with an older
 * save still on its way is ordered after that save instead of racing it.
 */
ipcMain.handle('choose-drawing-path', async (ev, suggestName) => {
  const win = senderWindow(ev);
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Drawing As',
    defaultPath: String(suggestName || 'Drawing1.dxf'),
    filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const file = await completeSavePath(win, res.filePath, DXF_FILE, '.dxf');
  if (!file) return null;
  registry.grant(file);
  return file;
});

/**
 * Write the project file to a path that came from our own dialogs (Open Project / Save Project As /
 * recent list): a .json file the user may write (a catalog file named by a project may not be).
 */
ipcMain.handle('save-project', async (_ev, file, text) => {
  validateTextSize(text, MAX_PROJECT_BYTES, 'project');
  if (!pathPolicy.writable(file, 'save-project', PROJECT_FILE)) throw new Error('Unknown project path');
  // Temporary file + fsync + rename, previous version kept as <name>.bak (electron/atomic-write.cjs).
  await writeUserFile(file, text, { backup: true });
  return file;
});

/**
 * Copy a drawing or project file to `<file>.bak` before a project-wide command rewrites it.
 * Only DXF drawings and *.jcadproj.json project files the renderer may write by name (our
 * dialogs, the recent list, the drawings an opened project lists - the same rule as
 * save-dxf; the shared path policy logs refusals in ipc-rejections.log) are copied, through a
 * temporary file + fsync + rename (electron/atomic-write.cjs backupFile). Resolves
 * { ok: true, path } or { ok: false, code, error } with a message for the user; it never throws
 * and never reports success without a complete copy.
 */
ipcMain.handle('backup-file', (_ev, file) => backupFile(file, undefined, (p) => pathPolicy.writable(p, 'backup-file', BACKUP_FILE) !== null));

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
  secureContents(hidden.webContents);
  try {
    // Keep the navigation URL tiny and inject the (possibly multi-megabyte) image afterwards.
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0}</style></head><body><img id="p"></body></html>';
    await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await hidden.webContents.executeJavaScript(`new Promise((ok, fail) => { const i = document.getElementById('p'); i.onload = () => ok(true); i.onerror = () => fail(new Error('image')); i.src = ${JSON.stringify(dataUrl)}; })`);
    // printToPDF takes a named size or {width, height} in INCHES (print() uses microns).
    const pdf = await hidden.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
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
  validatePaperDimensions(sheet);
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
  secureContents(hidden.webContents);
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

ipcMain.handle('open-dxf', async (ev) => {
  const win = senderWindow(ev);
  const r = await openDrawingFile(win);
  return r && r.kind === 'dxf' ? { path: r.path, text: r.text } : null;
});

/**
 * Save a drawing as DXF. By name (`existingPath`) only over a .dxf file the renderer may write
 * (electron/path-registry.cjs); another file type is refused (and logged). A drawing that may only
 * be read (a drawing outside the folder of a project opened only by name) or an unknown path goes through the
 * Save As dialog instead - opened on that drawing when it is readable, so the user confirms it. A name
 * typed there without .dxf gets it, like choose-drawing-path (completeSavePath).
 */
ipcMain.handle('save-dxf', async (ev, existingPath, text, suggestName, opts) => {
  const win = senderWindow(ev);
  validateTextSize(text, MAX_DRAWING_BYTES, 'DXF');
  let target = existingPath == null ? null : pathPolicy.writable(existingPath, 'save-dxf', DXF_FILE);
  let defaultPath = String(suggestName || 'Drawing1.dxf');
  if (!target && typeof existingPath === 'string' && !pathPolicy.shapeProblem(existingPath)) {
    if (!DXF_FILE.test(existingPath)) throw new Error('Invalid path');
    if (registry.isKnown(existingPath)) defaultPath = existingPath;
  }
  if (!target) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Drawing As',
      defaultPath,
      filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = await completeSavePath(win, res.filePath, DXF_FILE, '.dxf');
    if (!target) return null;
  }
  // Temporary file + fsync + rename, previous version kept as <name>.dxf.bak (electron/atomic-write.cjs)
  // unless the renderer says no (a project-wide command made the .bak itself or was told to write without one).
  // A failure is thrown as "CODE: reason, write '<target>'"; the renderer maps it to a message.
  await writeUserFile(target, text, { backup: !(opts && opts.backup === false) });
  registry.grant(target);
  return target;
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
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
/** Only a missing file means "no library yet"; any other failure (EBUSY, EPERM, EIO) is reported so the renderer refuses to overwrite. */
ipcMain.handle('user-library-read', async () => {
  try {
    return String(await readLimitedFile(fs, userLibraryFile(), MAX_LIBRARY_BYTES, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
});
ipcMain.handle('user-library-write', async (_ev, json) => {
  validateTextSize(json, MAX_LIBRARY_BYTES, 'library');
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
  return String(await readLimitedFile(fs, file, max, 'utf8'));
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
      const manifest = await pathPolicy.insideRoot(pluginsDir(), path.join(pluginsDir(), d.name, 'plugin.json'), 'plugins-list');
      out.push({ folder: d.name, manifest: await readLimited(manifest, MAX_PLUGIN_MANIFEST) });
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
// ------------------------------------------------------------------ raster images of IMAGE entities (read-image)
// The renderer resolves IMAGEDEF paths against the drawing's folder and asks for absolute
// paths of image files only; the bytes come back as a data URL (null when missing or too big).
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
ipcMain.handle('read-image', async (_ev, file) => {
  if (pathPolicy.shapeProblem(file)) throw new Error('Invalid path');
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error('Not an image file');
  // Resolve through the canonical policy once: Windows short names and macOS system aliases
  // may differ from the spelling registered by the native drawing dialog.
  let stat;
  try {
    file = await pathPolicy.imagePath(file);
    stat = await fs.stat(file);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    if (err && err.code === 'ERR_IMAGE_PATH') {
      rejections.reject('read-image', `${err.message}: ${String(file).slice(0, 300)}`);
      throw new Error('Invalid path');
    }
    throw err;
  }
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
  const bytes = await readLimitedFile(fs, file, MAX_IMAGE_BYTES);
  return `data:${type};base64,${bytes.toString('base64')}`;
});
// ------------------------------------------------------------------ end of read-image

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
    return String(await readLimitedFile(fs, file, MAX_PACK_BYTES, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
});
ipcMain.handle('packs-write', async (_ev, name, text) => {
  const file = path.join(packsDir(), safePackName(name));
  validateTextSize(text, MAX_PACK_BYTES, 'pack');
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
  return { name: path.basename(file), text: String(await readLimitedFile(fs, file, MAX_PACK_BYTES, 'utf8')) };
});

/** The renderer keeps the Recent Documents list; we mirror it into the native File > Open Recent menu. */
ipcMain.on('set-recent-files', (ev, files) => {
  if (!Array.isArray(files)) return;
  recentFiles = files.filter((f) => typeof f === 'string').slice(0, 9);
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (win) buildMenu(win);
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
  const win = BrowserWindow.fromWebContents(ev.sender) || mainWindow;
  return updater.checkForUpdates(win, { interactive: true });
});
updater.onStatus((status) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update-status', status);
});

ipcMain.on('app-quit', (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win) return;
  quitRequested = true;
  win.close();
});

// ------------------------------------------------------------------ files handed over by the OS
// "Open with JCad Electrical", a double click on a .dxf / .dwg / .jcadproj.json file (the installers
// register these types: package.json build.fileAssociations), a file dropped on the program icon or
// a second launch with a file: the paths arrive on the command line (or as macOS open-file events).
// They become openable (and writable) by path (the user named them) and the renderer opens each
// drawing in its own tab (pristine tab reused, an open tab shown) and a project as the current
// project - asked for once it has loaded (take-open-files), pushed afterwards (open-files).
const pendingOpenFiles = [];
let openFilesReady = false;
/** The files the OS may hand over: drawings and project files. */
const HANDOVER_FILE = /\.(dxf|dwg)$|\.jcadproj\.json$/i;
/**
 * Project files chosen through OS hand-over or the native Recent menu and not opened yet (pathKey):
 * the user chose them, so open-project
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
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (openFilesReady && win) win.webContents.send('open-files', files);
  else pendingOpenFiles.push(...files);
}
ipcMain.handle('take-open-files', () => {
  openFilesReady = true;
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
      const { payload, version } = await readDwg(await readLimitedFile(fs, file, MAX_DRAWING_BYTES));
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
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Main-process failures go to a log the user can send with a problem report.
const errorLog = () => path.join(stateDir(), 'error.log');
function logMainError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : String(err)}\n`;
  try {
    fsSync.mkdirSync(stateDir(), { recursive: true });
    fsSync.appendFileSync(errorLog(), line);
  } catch {
    /* nothing else we can do */
  }
}
/** Flush queued DOM storage while its renderer still exists; Electron exposes no durability acknowledgement. @param {Electron.WebContents} contents */
function flushRendererPreferences(contents) {
  try {
    contents.session.flushStorageData();
    return true;
  } catch (err) {
    logMainError('renderer preference persistence', err);
    return false;
  }
}
process.on('uncaughtException', (err) => logMainError('uncaughtException', err));
process.on('unhandledRejection', (err) => logMainError('unhandledRejection', err));
app.on('render-process-gone', (_ev, _wc, details) => logMainError('render-process-gone', new Error(`${details.reason} (exit code ${details.exitCode})`)));
app.on('child-process-gone', (_ev, details) => logMainError('child-process-gone', new Error(`${details.type} ${details.reason}`)));

app.whenReady().then(async () => {
  installAssetHandler({ protocol, net, root: path.join(__dirname, '..', 'dist') });
  if (!DEV_URL && !fsSync.existsSync(path.join(stateDir(), 'renderer-origin-migrated'))) {
    try { rendererStorage = fsSync.existsSync(path.join(stateDir(), 'Local Storage', 'leveldb')) ? await legacyStorage({ BrowserWindow, protocol, indexFile: path.join(__dirname, '..', 'dist', 'index.html') }) : {}; }
    catch (error) { logMainError('renderer preference migration', error); }
  }
  loadPersistedPaths();
  handOverFiles(drawingArgs(process.argv, process.cwd()));
  await createWindow();
  startingMainWindow = false;
  updater.scheduleStartupCheck(() => mainWindow);
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
  mainWindow = null;
  if (process.platform !== 'darwin') app.quit();
});
