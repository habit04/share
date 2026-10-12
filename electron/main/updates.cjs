/**
 * IPC for the application and its updates: version and platform (app-info), the external links
 * the renderer may open, update checks (electron/updater.cjs) and the update status pushed to
 * every window.
 */
const { app, BrowserWindow } = require('electron');
const updater = require('../updater.cjs');
const { externalUrl } = require('../ipc-guard.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @param {MainContext} ctx */
function registerUpdatesIpc(ctx) {
  const { ipcMain, rejections } = ctx;
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
    const u = externalUrl(url, { supportEmail: true });
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
}

module.exports = { registerUpdatesIpc };
