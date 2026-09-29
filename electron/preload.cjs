const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  openDrawing: (file) => ipcRenderer.invoke('open-drawing', file),
  openProject: (file) => ipcRenderer.invoke('open-project', file),
  saveText: (suggestName, text, filterName, ext) => ipcRenderer.invoke('save-text', suggestName, text, filterName, ext),
  backupFile: (file) => ipcRenderer.invoke('backup-file', file),
  plotPdf: (dataUrl, suggestName, landscape, sheet) => ipcRenderer.invoke('plot-pdf', dataUrl, suggestName, landscape, sheet),
  printDrawing: (dataUrl, title, landscape, sheet) => ipcRenderer.invoke('print-drawing', dataUrl, title, landscape, sheet),
  saveDxf: (path, text, suggestName) => ipcRenderer.invoke('save-dxf', path, text, suggestName),
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
  // Native menu mirrors of renderer state
  setRecentFiles: (files) => ipcRenderer.send('set-recent-files', files),
  quit: () => ipcRenderer.send('app-quit'),
  onMenuCommand: (cb) => {
    ipcRenderer.on('menu-command', (_ev, cmd) => cb(String(cmd)));
  },
  onQueryDirty: (cb) => {
    ipcRenderer.on('query-dirty', () => {
      let dirty = false;
      try {
        dirty = Boolean(cb());
      } catch {
        dirty = false;
      }
      ipcRenderer.send('dirty-state', dirty);
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
