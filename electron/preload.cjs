const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  openDrawing: (file) => ipcRenderer.invoke('open-drawing', file),
  openProject: (file) => ipcRenderer.invoke('open-project', file),
  saveText: (suggestName, text, filterName, ext) => ipcRenderer.invoke('save-text', suggestName, text, filterName, ext),
  plotPdf: (dataUrl, suggestName, landscape, sheet) => ipcRenderer.invoke('plot-pdf', dataUrl, suggestName, landscape, sheet),
  saveDxf: (path, text, suggestName) => ipcRenderer.invoke('save-dxf', path, text, suggestName),
  // Autosave / Drawing Recovery (files live in the app data folder)
  autosaveWrite: (name, text, meta) => ipcRenderer.invoke('autosave-write', name, text, meta),
  autosaveList: () => ipcRenderer.invoke('autosave-list'),
  autosaveRead: (name) => ipcRenderer.invoke('autosave-read', name),
  autosaveRemove: (name) => ipcRenderer.invoke('autosave-remove', name),
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
  platform: process.platform,
});
