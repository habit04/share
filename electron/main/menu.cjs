/**
 * The native application menu. Its items send commands to the renderer ('menu-command'), which
 * runs them like typed commands; File > Open Recent mirrors the renderer's Recent Documents list.
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const updater = require('../updater.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** The Recent Documents list the renderer sent last (set-recent-files). */
let recentFiles = [];

function buildMenu(win) {
  const send = (cmd) => () => win.webContents.send('menu-command', cmd);
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const recentSub = recentFiles.length
    ? [...recentFiles.map((f, i) => ({ label: `${i + 1}. ${path.basename(f)}`, toolTip: f, click: send(`RECENT ${i + 1}`) })), { type: 'separator' }, { label: 'Clear Recent', click: send('CLEARRECENT') }]
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
        // Developer tools only in development runs (security review E-15): an installed copy has no
        // menu item and no Ctrl+Shift+I.
        ...(app.isPackaged ? [] : [/** @type {Electron.MenuItemConstructorOptions} */ ({ role: 'toggleDevTools' })]),
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

/**
 * set-recent-files: the renderer's Recent Documents list, for File > Open Recent.
 * @param {MainContext} ctx
 */
function registerMenuIpc(ctx) {
  const { ipcMain } = ctx;
  /** The renderer keeps the Recent Documents list; we mirror it into the native File > Open Recent menu. */
  ipcMain.on('set-recent-files', (ev, files) => {
    if (!Array.isArray(files)) return;
    recentFiles = files.filter((f) => typeof f === 'string').slice(0, 9);
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (win) buildMenu(win);
  });
}

module.exports = { buildMenu, registerMenuIpc };
