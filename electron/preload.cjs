const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  openDrawing: (file) => ipcRenderer.invoke('open-drawing', file),
  saveDxf: (path, text, suggestName) => ipcRenderer.invoke('save-dxf', path, text, suggestName),
  onMenuCommand: (cb) => {
    ipcRenderer.on('menu-command', (_ev, cmd) => cb(String(cmd)));
  },
  onQueryDirty: (cb) => {
    ipcRenderer.on('query-dirty', (ev) => {
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
