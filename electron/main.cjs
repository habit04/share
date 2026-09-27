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
  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('open-dxf', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Drawing',
    filters: [{ name: 'DXF Drawing', extensions: ['dxf'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const file = res.filePaths[0];
  const text = await fs.readFile(file, 'utf8');
  return { path: file, text };
});

ipcMain.handle('save-dxf', async (ev, existingPath, text, suggestName) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  let target = existingPath;
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
