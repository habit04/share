const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('jcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  openDrawing: (file) => ipcRenderer.invoke('open-drawing', file),
  openProject: (file) => ipcRenderer.invoke('open-project', file),
  saveText: (suggestName, text, filterName, ext) => ipcRenderer.invoke('save-text', suggestName, text, filterName, ext),
  // Project Save As: pick the destination first (the renderer rebases relative paths), then write it.
  chooseProjectPath: (suggestName) => ipcRenderer.invoke('choose-project-path', String(suggestName || '')),
  saveProject: (file, text) => ipcRenderer.invoke('save-project', file, text),
  backupFile: (file) => ipcRenderer.invoke('backup-file', file),
  plotPdf: (dataUrl, suggestName, landscape, sheet) => ipcRenderer.invoke('plot-pdf', dataUrl, suggestName, landscape, sheet),
  printDrawing: (dataUrl, title, landscape, sheet) => ipcRenderer.invoke('print-drawing', dataUrl, title, landscape, sheet),
  // Vector PLOT: the renderer's PDF bytes, saved through a Save dialog in the main process.
  savePdf: (bytes, suggestName) => ipcRenderer.invoke('save-pdf', bytes, suggestName),
  // opts.backup === false: no <name>.bak copy (a project-wide command made its own, or the user declined one)
  saveDxf: (path, text, suggestName, opts) => ipcRenderer.invoke('save-dxf', path, text, suggestName, opts && opts.backup === false ? { backup: false } : undefined),
  // Autosave / Drawing Recovery (files live in the app data folder)
  autosaveWrite: (name, text, meta) => ipcRenderer.invoke('autosave-write', name, text, meta),
  autosaveList: () => ipcRenderer.invoke('autosave-list'),
  autosaveRead: (name) => ipcRenderer.invoke('autosave-read', name),
  autosaveRemove: (name) => ipcRenderer.invoke('autosave-remove', name),
  // User symbol library (Symbol Builder): one JSON document in the app data folder
  userLibraryRead: () => ipcRenderer.invoke('user-library-read'),
  userLibraryWrite: (json) => ipcRenderer.invoke('user-library-write', json),
  // Raster images of IMAGE entities: an absolute image file path -> data URL (null when unreadable)
  readImage: (file) => ipcRenderer.invoke('read-image', file),
  // Catalog packs (signed manufacturer catalogs): one *.jcadpack.json per pack in the app data folder
  packsDir: () => ipcRenderer.invoke('packs-dir'),
  packsList: () => ipcRenderer.invoke('packs-list'),
  packsRead: (name) => ipcRenderer.invoke('packs-read', name),
  packsWrite: (name, text) => ipcRenderer.invoke('packs-write', name, text),
  packsRemove: (name) => ipcRenderer.invoke('packs-remove', name),
  pickPackFile: () => ipcRenderer.invoke('pick-pack-file'),
  // Plugins: one folder per plugin in the app data folder (docs/PLUGIN-API.md)
  pluginsDir: () => ipcRenderer.invoke('plugins-dir'),
  pluginsList: () => ipcRenderer.invoke('plugins-list'),
  pluginsRead: (folder) => ipcRenderer.invoke('plugins-read', folder),
  /** Runs plugin code in the page after the user confirmed it; the page CSP has no 'unsafe-eval' for new Function. */
  pluginsEval: (source) => webFrame.executeJavaScript(String(source)),
  // Native menu mirrors of renderer state
  setRecentFiles: (files) => ipcRenderer.send('set-recent-files', files),
  quit: () => ipcRenderer.send('app-quit'),
  onMenuCommand: (cb) => {
    ipcRenderer.on('menu-command', (_ev, cmd) => cb(String(cmd)));
  },
  /**
   * Close / quit / restart: the main process sends 'close-request' and waits for the Save All
   * workflow. The request is acknowledged at once (so a hung page can be told apart from a user
   * who is still answering the dialog); the answer is true only when the window may close.
   */
  onCloseRequest: (cb) => {
    ipcRenderer.on('close-request', async (_ev, id, context) => {
      ipcRenderer.send('close-ack', id);
      let ok = false;
      try {
        ok = (await cb(context === 'quit' || context === 'restart' ? context : 'close')) === true;
      } catch {
        ok = false;
      }
      ipcRenderer.send('close-response', id, ok);
    });
  },
  // Updates (GitHub Releases)
  appInfo: () => ipcRenderer.invoke('app-info'),
  /** Open a link in the system browser; only this project's GitHub pages are allowed. */
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),
  checkForUpdates: () => ipcRenderer.invoke('check-updates'),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('update-status', (_ev, status) => cb(status));
  },
  platform: process.platform,
});
