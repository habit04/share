/**
 * The main window and its close / quit workflow: its bounds are kept in window-state.json, and
 * a close, a quit (menu Quit, Cmd+Q, File > Exit, app-quit) or an update restart waits for the
 * renderer's Save All workflow (src/app/closeflow.ts); a renderer that does not answer gets a
 * native Close Without Saving / Cancel question.
 */
const { app, BrowserWindow, dialog, screen } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const updater = require('../updater.cjs');
const { windowStateFile, writeStateFile, flushRendererPreferences } = require('./app-data.cjs');
const { APP_URL } = require('../renderer-origin.cjs');
const { buildMenu } = require('./menu.cjs');
const { secureContents } = require('../web-security.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** electron/: the preload script is here, the built page in ../dist. */
const ELECTRON_DIR = path.join(__dirname, '..');

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

/**
 * The close / quit workflow and the window factory.
 * @param {MainContext} ctx
 * @param {string | undefined} devUrl  the Vite dev server (VITE_DEV_SERVER_URL); the built page when unset
 */
function createWindows(ctx, devUrl, allowInspection = !app.isPackaged) {
  const { ipcMain } = ctx;
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
    const win = w && !w.isDestroyed() ? w : ctx.mainWindow;
    const ok = await requestClose(win, 'restart');
    if (ok && win) {
      closeApproved.add(win);
      setTimeout(() => {
        if (!win.isDestroyed()) closeApproved.delete(win);
      }, RESTART_APPROVAL_MS);
    }
    return ok;
  });

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
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: allowInspection,
      },
    });
    ctx.mainWindow = win;
    ctx.openFilesReady = false; // a new page asks for the files waiting for it
    if (b.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    installWindowStatePersistence(win);
    buildMenu(win, ctx);
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
    if (devUrl) {
      await win.loadURL(devUrl);
    } else {
      await win.loadURL(APP_URL);
    }
  }

  ipcMain.on('app-quit', (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (!win) return;
    quitRequested = true;
    win.close();
  });
  return { createWindow };
}

module.exports = { createWindows, secureContents };
