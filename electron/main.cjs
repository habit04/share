const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

function buildMenu(win) {
  const send = (cmd) => () => win.webContents.send('menu-command', cmd);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('NEW') },
        { label: 'Open DXF…', accelerator: 'CmdOrCtrl+O', click: send('OPEN') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('SAVE') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('SAVEAS') },
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
        { label: 'Erase', click: send('ERASE') },
        { label: 'Move', click: send('MOVE') },
        { label: 'Copy', click: send('COPY') },
        { label: 'Rotate', click: send('ROTATE') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('SELECTALL') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom Extents', click: send('ZOOM E') },
        { label: 'Zoom In', click: send('ZOOM I') },
        { label: 'Zoom Out', click: send('ZOOM O') },
        { type: 'separator' },
        { label: 'Grid (F7)', click: send('GRID') },
        { label: 'Ortho (F8)', click: send('ORTHO') },
        { label: 'Object Snap (F3)', click: send('OSNAP') },
        { type: 'separator' },
        { label: 'Project Manager', click: send('TOGGLEPM') },
        { label: 'Layer Properties', click: send('LAYER') },
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
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: 'Command List', click: send('HELP') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#2b2b2b',
    title: 'VoltCAD 2D Electrical',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  buildMenu(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Ask the renderer whether there is unsaved work before closing.
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose || win.webContents.isDestroyed()) return;
    e.preventDefault();
    const onState = (_ev, dirty) => {
      if (!dirty) {
        allowClose = true;
        win.close();
        return;
      }
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Save changes to the drawing before closing?',
      });
      if (r === 2) return;
      if (r === 1) {
        allowClose = true;
        win.close();
        return;
      }
      win.webContents.send('menu-command', 'SAVE');
    };
    ipcMain.once('dirty-state', onState);
    win.webContents.send('query-dirty');
    // If the renderer never answers (e.g. crashed), close anyway.
    setTimeout(() => {
      if (!allowClose && ipcMain.listenerCount('dirty-state') > 0) {
        ipcMain.removeListener('dirty-state', onState);
        allowClose = true;
        win.close();
      }
    }, 3000);
  });
  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

let dwgReader = null;
async function readDwg(bytes) {
  if (!dwgReader) dwgReader = import(path.join(__dirname, '..', 'scripts', 'dwg-reader.mjs'));
  const mod = await dwgReader;
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
  } else if (!knownPaths.has(file)) {
    // Only paths that came from our own dialogs / recent list may be opened by name.
    throw new Error('Unknown file path');
  }
  if (file.toLowerCase().endsWith('.dwg')) {
    knownPaths.add(file.replace(/\.dwg$/i, '.dxf'));
    const bytes = await fs.readFile(file);
    const { payload, version } = await readDwg(bytes);
    return { path: file, kind: 'dwg', payload, version };
  }
  const text = await fs.readFile(file, 'utf8');
  knownPaths.add(file);
  return { path: file, kind: 'dxf', text };
}

ipcMain.handle('open-drawing', async (ev, file) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
  return openDrawingFile(win, file);
});

ipcMain.handle('open-dxf', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await openDrawingFile(win);
  return r && r.kind === 'dxf' ? { path: r.path, text: r.text } : null;
});

/** Paths the user chose through our own dialogs. The renderer may only write to these. */
const knownPaths = new Set();

ipcMain.handle('save-dxf', async (ev, existingPath, text, suggestName) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  let target = typeof existingPath === 'string' && knownPaths.has(existingPath) ? existingPath : null;
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
  knownPaths.add(target);
  return target;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
