const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const updater = require('./updater.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// ------------------------------------------------------------------ persisted main-process state
/** Paths the user chose through our own dialogs (persisted so Recent Documents keep working). */
const knownPaths = new Set();
/**
 * The same paths in Unicode NFC: macOS file systems hand out decomposed (NFD) names while
 * project files and typed names are usually NFC, so "José.dxf" must match either way.
 */
const knownNormalized = new Set();
const nfc = (p) => (typeof p === 'string' ? p.normalize('NFC') : p);
function isKnownPath(p) {
  return typeof p === 'string' && (knownPaths.has(p) || knownNormalized.has(nfc(p)));
}
let recentFiles = [];
const stateDir = () => app.getPath('userData');
const recentFile = () => path.join(stateDir(), 'recent.json');
const windowStateFile = () => path.join(stateDir(), 'window-state.json');
const autosaveDir = () => path.join(stateDir(), 'autosave');

function loadPersistedPaths() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(recentFile(), 'utf8'));
    if (Array.isArray(parsed)) for (const p of parsed) if (typeof p === 'string') {
      knownPaths.add(p);
      knownNormalized.add(nfc(p));
    }
  } catch {
    /* first run */
  }
}
function rememberPath(p) {
  knownPaths.add(p);
  knownNormalized.add(nfc(p));
  fs.mkdir(stateDir(), { recursive: true })
    .then(() => fs.writeFile(recentFile(), JSON.stringify([...knownPaths].slice(-200)), 'utf8'))
    .catch(() => {});
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
    fs.mkdir(stateDir(), { recursive: true })
      .then(() => fs.writeFile(windowStateFile(), JSON.stringify(state), 'utf8'))
      .catch(() => {});
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
  const recentSub = recentFiles.length
    ? [...recentFiles.map((f, i) => ({ label: `${i + 1}. ${path.basename(f)}`, toolTip: f, click: send(`RECENT ${i + 1}`) })), { type: 'separator' }, { label: 'Clear Recent', click: send('CLEARRECENT') }]
    : [{ label: '(empty)', enabled: false }];
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
        { role: 'toggleDevTools' },
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

let mainWindow = null;
/** Set when electron-updater is about to quit and relaunch: the close veto must not run then. */
let quittingForUpdate = false;
require('electron').autoUpdater.on('before-quit-for-update', () => {
  quittingForUpdate = true;
});

/**
 * May the window close now? Resolves false when the user cancels or chooses Save (the
 * SAVE command runs and the user closes again afterwards). Also used before an update restart.
 */
function confirmClose(win) {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return resolve(true);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const onState = (_ev, dirty) => {
      if (!dirty) return finish(true);
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Save changes to the drawing before closing?',
        detail: 'Autosave copies of modified drawings are kept for the Drawing Recovery Manager.',
      });
      if (r === 1) return finish(true);
      if (r === 0) win.webContents.send('menu-command', 'SAVE');
      finish(false);
    };
    ipcMain.once('dirty-state', onState);
    win.webContents.send('query-dirty');
    // If the renderer never answers (e.g. crashed), close anyway.
    setTimeout(() => {
      if (settled) return;
      ipcMain.removeListener('dirty-state', onState);
      finish(true);
    }, 3000);
  });
}
updater.onConfirmRestart((win) => confirmClose(win));

async function createWindow() {
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
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  installWindowStatePersistence(win);
  buildMenu(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Ask the renderer whether there is unsaved work before closing.
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose || quittingForUpdate || win.webContents.isDestroyed()) return;
    e.preventDefault();
    void confirmClose(win).then((ok) => {
      if (!ok) return;
      allowClose = true;
      win.close();
    });
  });
  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

let dwgReader = null;
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
async function readDwg(bytes) {
  const mod = await loadReader();
  try {
    return await mod.readDwgPayload(bytes, 'dwg');
  } catch (err) {
    // A WebAssembly abort leaves the module unusable: drop it so the next open starts fresh.
    dwgReader = null;
    mod.resetLibreDwg?.();
    throw err;
  }
}

/** Open a DXF or DWG. Returns { path, kind: 'dxf', text } or { path, kind: 'dwg', payload, version } or null. */
async function openDrawingFile(win, file) {
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
  } else if (!isKnownPath(file)) {
    // Only paths that came from our own dialogs / recent list may be opened by name.
    throw new Error('Unknown file path');
  }
  if (file.toLowerCase().endsWith('.dwg')) {
    rememberPath(file.replace(/\.dwg$/i, '.dxf'));
    const bytes = await fs.readFile(file);
    const { payload, version } = await readDwg(bytes);
    rememberPath(file);
    return { path: file, kind: 'dwg', payload, version };
  }
  // Read bytes, not a UTF-8 string: pre-2007 DXF files are in the $DWGCODEPAGE code page.
  const { text, encoding } = await decodeDxf(await fs.readFile(file));
  rememberPath(file);
  return { path: file, kind: 'dxf', text, encoding };
}

ipcMain.handle('open-drawing', async (ev, file) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
  return openDrawingFile(win, file);
});

/** Read a project file and register its drawings as openable paths. */
ipcMain.handle('open-project', async (ev, file) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      filters: [{ name: 'JCad Electrical Project', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    file = res.filePaths[0];
  } else if (!isKnownPath(file)) throw new Error('Unknown file path');
  const text = await fs.readFile(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a valid project file');
  }
  rememberPath(file);
  const dir = path.dirname(file);
  if (parsed && Array.isArray(parsed.drawings)) {
    for (const d of parsed.drawings) {
      if (d && typeof d.file === 'string') rememberPath(path.isAbsolute(d.file) ? d.file : path.join(dir, d.file));
    }
  }
  return { path: file, text };
});

/** Save arbitrary text (CSV report, project file) through a save dialog. */
ipcMain.handle('save-text', async (ev, suggestName, text, filterName, ext) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (typeof text !== 'string') throw new Error('Invalid payload');
  const res = await dialog.showSaveDialog(win, {
    title: 'Save',
    defaultPath: String(suggestName || 'export.txt'),
    filters: [{ name: String(filterName || 'Text'), extensions: [String(ext || 'txt')] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, text, 'utf8');
  rememberPath(res.filePath);
  return res.filePath;
});

/**
 * Copy a drawing or project file to `<file>.bak` before a project-wide command rewrites it.
 * Only files the renderer legitimately knows (DXF drawings and project files) are copied.
 */
ipcMain.handle('backup-file', async (ev, file) => {
  if (typeof file !== 'string' || !/\.(dxf|jcadproj\.json)$/i.test(file)) return null;
  try {
    const target = `${file}.bak`;
    await fs.copyFile(file, target);
    return target;
  } catch (err) {
    logMainError('backup-file', err);
    return null;
  }
});

/** Plot: the renderer sends a PNG data URL of the sheet; we print it to PDF via a hidden window. */
ipcMain.handle('plot-pdf', async (ev, dataUrl, suggestName, landscape, sheet) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
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
    await fs.writeFile(res.filePath, pdf);
    return res.filePath;
  } finally {
    hidden.destroy();
  }
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

ipcMain.handle('open-dxf', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await openDrawingFile(win);
  return r && r.kind === 'dxf' ? { path: r.path, text: r.text } : null;
});

ipcMain.handle('save-dxf', async (ev, existingPath, text, suggestName) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  let target = isKnownPath(existingPath) ? existingPath : null;
  if (!target) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Drawing As',
      defaultPath: suggestName || 'Drawing1.dxf',
      filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  if (typeof text !== 'string') throw new Error('Invalid DXF payload');
  await fs.writeFile(target, text, 'utf8');
  rememberPath(target);
  return target;
});

// ------------------------------------------------------------------ autosave (app data folder)
/** Autosave names are generated by the renderer but restricted to a safe charset and our folder. */
function safeAutosaveName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,60}\.sv\.dxf$/.test(name)) throw new Error('Invalid autosave name');
  return name;
}
ipcMain.handle('autosave-write', async (_ev, name, text, meta) => {
  const n = safeAutosaveName(name);
  if (typeof text !== 'string') throw new Error('Invalid payload');
  await fs.mkdir(autosaveDir(), { recursive: true });
  const m = meta && typeof meta === 'object' ? meta : {};
  const clean = { originalPath: typeof m.originalPath === 'string' ? m.originalPath : null, title: String(m.title || n), savedAt: Number(m.savedAt) || Date.now() };
  await fs.writeFile(path.join(autosaveDir(), n), text, 'utf8');
  await fs.writeFile(path.join(autosaveDir(), n + '.json'), JSON.stringify(clean), 'utf8');
});
ipcMain.handle('autosave-list', async () => {
  try {
    const files = await fs.readdir(autosaveDir());
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.sv.dxf')) continue;
      let meta = { originalPath: null, title: f, savedAt: 0 };
      try {
        meta = { ...meta, ...JSON.parse(await fs.readFile(path.join(autosaveDir(), f + '.json'), 'utf8')) };
      } catch {
        /* no sidecar */
      }
      if (!meta.savedAt) meta.savedAt = (await fs.stat(path.join(autosaveDir(), f))).mtimeMs;
      out.push({ name: f, ...meta });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
});
ipcMain.handle('autosave-read', async (_ev, name) => {
  try {
    return await fs.readFile(path.join(autosaveDir(), safeAutosaveName(name)), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle('autosave-remove', async (_ev, name) => {
  const n = safeAutosaveName(name);
  await fs.rm(path.join(autosaveDir(), n), { force: true });
  await fs.rm(path.join(autosaveDir(), n + '.json'), { force: true });
});

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
  const tmp = file + '.tmp';
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(json, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.copyFile(file, file + '.bak');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err; // first write: nothing to back up
  }
  await fs.rename(tmp, file);
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
  const tmp = file + '.tmp';
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
});
ipcMain.handle('packs-remove', async (_ev, name) => {
  await fs.rm(path.join(packsDir(), safePackName(name)), { force: true });
});
/** Native picker for a pack file; returns { name, text } (the renderer verifies and stores it) or null. */
ipcMain.handle('pick-pack-file', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
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
/** Links the renderer may open: this project's GitHub pages and the Cash App donation page. */
ipcMain.handle('open-external', async (_ev, url) => {
  const u = String(url || '');
  const allowed = /^https:\/\/github\.com\/habit04\/share(\/|$)/.test(u) || /^https:\/\/cash\.app\/\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(u);
  if (!allowed || u.length > 16000) return false;
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
  if (win) win.close();
});

// Headless probe used by packaging smoke tests:  jcad --probe-dwg <file.dwg>
const probeIndex = process.argv.indexOf('--probe-dwg');
if (probeIndex >= 0) {
  app.whenReady().then(async () => {
    try {
      const file = process.argv[probeIndex + 1];
      const { payload, version } = await readDwg(await fs.readFile(file));
      process.stdout.write(`PROBE_OK ${version} entities=${payload.entities.length} blocks=${payload.blocks.length}\n`);
      app.exit(0);
    } catch (err) {
      process.stdout.write(`PROBE_FAIL ${err && err.message}\n`);
      app.exit(1);
    }
  });
  return;
}

// One running instance per user: the user library, recent list and window state are whole-file
// writes, so a second instance would silently overwrite the first one's changes. The probe above
// runs headless and must not take (or be blocked by) the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => {
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
process.on('uncaughtException', (err) => logMainError('uncaughtException', err));
process.on('unhandledRejection', (err) => logMainError('unhandledRejection', err));
app.on('render-process-gone', (_ev, _wc, details) => logMainError('render-process-gone', new Error(`${details.reason} (exit code ${details.exitCode})`)));
app.on('child-process-gone', (_ev, details) => logMainError('child-process-gone', new Error(`${details.type} ${details.reason}`)));

app.whenReady().then(() => {
  loadPersistedPaths();
  createWindow();
  updater.scheduleStartupCheck(() => mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  mainWindow = null;
  if (process.platform !== 'darwin') app.quit();
});
