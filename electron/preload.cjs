const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  saveDxf: (path, text, suggestName) => ipcRenderer.invoke('save-dxf', path, text, suggestName),
  onMenuCommand: (cb) => {
    ipcRenderer.on('menu-command', (_ev, cmd) => cb(String(cmd)));
  },
  platform: process.platform,
});
