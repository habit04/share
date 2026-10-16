/**
 * The context electron/main.cjs creates once and hands to the modules under electron/main/. It
 * carries the only way they register IPC handlers - the guarded ipcMain of electron/ipc-guard.cjs
 * (a module never requires Electron's own ipcMain) - and the only way they grant and check paths
 * (the path registry of electron/path-registry.cjs and the path policy of ipc-guard.cjs), plus the
 * main window they share.
 *
 * @typedef {object} MainContext
 * @property {ReturnType<typeof import('../ipc-guard.cjs').guardIpc>} ipcMain  every IPC handler and listener is registered here
 * @property {import('../ipc-guard.cjs').RejectionLogger} rejections  refused requests (<userData>/ipc-rejections.log)
 * @property {ReturnType<typeof import('../path-registry.cjs').createPathRegistry>} registry  the paths the renderer may name
 * @property {ReturnType<typeof import('../ipc-guard.cjs').createPathPolicy>} pathPolicy  path rules shared by every file IPC
 * @property {(ev: Electron.IpcMainInvokeEvent) => Electron.BrowserWindow} senderWindow  the window that sent an IPC message
 * @property {Electron.BrowserWindow | null} mainWindow  the application window (window.cjs creates it)
 * @property {Set<string>} handedOverProjects  one-use project grants made only by OS hand-over or the native Recent menu
 * @property {boolean} openFilesReady  the page asked for the files handed over (take-open-files); false while a new page loads
 * @property {ReturnType<typeof import('./save-order.cjs').registerSaveOrder>|null} [saveOrder] Windows drawing/export owner and ordering service, registered before plot handlers
 * @property {{ host: ReturnType<typeof import('../restricted-pdf/host.cjs').createRestrictedPdfHost>, registry: ReturnType<typeof import('../restricted-pdf/registry.cjs').createRestrictedPdfRegistry> } | null} restrictedPdf  Restricted PDF transform + registration (12.4); null off Windows
 */
module.exports = {};
