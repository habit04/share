const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Populate before the application reads settings. A complete checkpoint is authoritative only
// on an empty lost origin; existing Chromium values win. Legacy values never replace a checkpoint.
try {
  if (globalThis.location.protocol === 'jcad:' && !localStorage.getItem('jcad-origin-migrated')) {
    const saved = ipcRenderer.sendSync('renderer-storage-migration');
    if (saved && typeof saved.values === 'object' && (saved.source === 'legacy' || (saved.source === 'checkpoint' && localStorage.length === 0))) {
      const inserted = [];
      try {
        for (const [key, value] of Object.entries(saved.values)) {
          if (key !== 'jcad-origin-migrated' && typeof value === 'string' && localStorage.getItem(key) === null) {
            localStorage.setItem(key, value);
            inserted.push(key);
          }
        }
      } catch (error) {
        // Do not let a partial recovery replace the complete disk checkpoint on the next start.
        for (const key of inserted) localStorage.removeItem(key);
        throw error;
      }
    }
  }
  if (globalThis.location.protocol === 'jcad:') {
    // Electron's DOM flush has no durability acknowledgement. Mark migration complete only
    // after main has fsynced and atomically committed the checkpoint and its migration marker.
    void ipcRenderer.invoke('renderer-storage-migrated').then((ok) => {
      if (ok === true) localStorage.setItem('jcad-origin-migrated', '1');
    }).catch(() => {});
  }
} catch { /* Keep the application usable and retry migration on the next start. */ }

contextBridge.exposeInMainWorld('jcad', {
  openDxf: () => ipcRenderer.invoke('open-dxf'),
  openDrawing: (file) => ipcRenderer.invoke('open-drawing', file),
  // Project access is authorized in the main process; opts.textOnly reads JSON without granting its entries.
  openProject: (file, opts) => ipcRenderer.invoke('open-project', file, opts && typeof opts === 'object' ? { userChosen: opts.userChosen === true, textOnly: opts.textOnly === true } : undefined),
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
  // Drawing Save As: pick the format and destination before writing in save-queue order.
  chooseDrawingPath: (suggestName, format) => ipcRenderer.invoke('choose-drawing-path', String(suggestName || ''), format),
  // Windows portable DWG saving and separate DWG copies.
  ...(process.platform === 'win32' ? {
    fontMetrics: (request) => ipcRenderer.invoke('font-metrics', request),
    pdfFont: (request) => ipcRenderer.invoke('pdf-font', request),
    openShxFont: () => ipcRenderer.invoke('open-shx-font'),
    dwgExportStatus: () => ipcRenderer.invoke('dwg-export-status'),
    saveDwg: (path, text) => ipcRenderer.invoke('save-dwg', path, text),
    chooseDwgPath: (suggestName) => ipcRenderer.invoke('choose-dwg-path', String(suggestName || '')),
    exportDwg: (path, text) => ipcRenderer.invoke('export-dwg', path, text),
  } : {}),
  // Progress of a large DWG read (the main process parses it in a worker thread) and its Cancel button
  onOpenProgress: (cb) => {
    ipcRenderer.on('open-progress', (_ev, p) => cb(p));
  },
  cancelOpen: (id) => ipcRenderer.invoke('cancel-open', Number(id)),
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
  // Drawings handed over by the OS (command line of this or a second launch, macOS open-file)
  takeOpenFiles: () => ipcRenderer.invoke('take-open-files'),
  onOpenFiles: (cb) => {
    ipcRenderer.on('open-files', (_ev, files) => cb(Array.isArray(files) ? files.filter((f) => typeof f === 'string') : []));
  },
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
