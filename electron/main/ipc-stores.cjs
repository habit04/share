/**
 * IPC for the stores in the app-data folder: autosave copies (electron/autosave-store.cjs), the
 * user symbol library, plugins (listed and read here, never run) and signed catalog packs.
 */
const { dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { atomicWriteFile } = require('../atomic-write.cjs');
const { createAutosaveStore, safeAutosaveName } = require('../autosave-store.cjs');
const { stateDir, autosaveDir, enqueueWrite } = require('./app-data.cjs');
const { readLimitedFile, validateTextSize } = require('../resource-limits.cjs');
const { isPluginFolderName, MAIN_RE, readPluginManifest, readPluginSource } = require('../plugin-files.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @param {MainContext} ctx */
function registerStoreIpc(ctx) {
  const { ipcMain, pathPolicy, senderWindow } = ctx;
  // ------------------------------------------------------------------ autosave (app data folder)
  // <document id>.sv.dxf files plus index.json, written crash-safely (electron/autosave-store.cjs).
  let autosaveStore = null;
  const autosave = () => {
    if (!autosaveStore || autosaveStore.dir !== autosaveDir()) autosaveStore = createAutosaveStore(autosaveDir());
    return autosaveStore;
  };
  ipcMain.handle('autosave-write', (_ev, name, text, meta) => autosave().write(safeAutosaveName(name), text, meta));
  /** Rejects when the folder exists but cannot be read: the Recovery Manager shows that instead of "no backups". */
  ipcMain.handle('autosave-list', () => autosave().list());
  ipcMain.handle('autosave-read', (_ev, name) => autosave().read(safeAutosaveName(name)));
  ipcMain.handle('autosave-remove', (_ev, name) => autosave().remove(safeAutosaveName(name)));

  // ------------------------------------------------------------------ user symbol library (app data folder)
  const userLibraryFile = () => path.join(stateDir(), 'user-library.json');
  const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
  /** Only a missing file means "no library yet"; any other failure (EBUSY, EPERM, EIO) is reported so the renderer refuses to overwrite. */
  ipcMain.handle('user-library-read', async () => {
    try {
      return /** @type {string} */ (await readLimitedFile(fs, userLibraryFile(), MAX_LIBRARY_BYTES, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  });
  ipcMain.handle('user-library-write', async (_ev, json) => {
    validateTextSize(json, MAX_LIBRARY_BYTES, 'library');
    await fs.mkdir(stateDir(), { recursive: true });
    const file = userLibraryFile();
    // Write to a temporary file and fsync it so a crash or power loss mid-write cannot leave an
    // empty or truncated library, keep the previous file as one .bak, then rename atomically.
    await enqueueWrite(file, () => atomicWriteFile(file, json, { backup: true }));
  });

  // ------------------------------------------------------------------ plugins (app data folder / plugins)
  // One folder per plugin: plugins/<name>/plugin.json + the main .js it names (docs/PLUGIN-API.md).
  // The main process only lists and reads the files; the renderer asks the user and runs the code.
  const pluginsDir = () => path.join(stateDir(), 'plugins');
  /** The folder is created on first use so users can find it (PLUGINS prints it). */
  ipcMain.handle('plugins-dir', async () => {
    await fs.mkdir(pluginsDir(), { recursive: true });
    return pluginsDir();
  });
  /** [{ folder, manifest (plugin.json text or null), error? }] for every sub-folder. */
  ipcMain.handle('plugins-list', async () => {
    let dirents;
    try {
      dirents = await fs.readdir(pluginsDir(), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const d of dirents) {
      if (!d.isDirectory() || !isPluginFolderName(d.name)) continue;
      try {
        const manifest = await readPluginManifest(pluginsDir(), d.name, { checkPath: (file) => pathPolicy.insideRoot(pluginsDir(), file, 'plugins-list') });
        out.push({ folder: d.name, manifest });
      } catch (err) {
        out.push({ folder: d.name, manifest: null, error: err && err.code === 'ENOENT' ? 'no plugin.json' : String((err && err.message) || err) });
      }
    }
    return out.sort((a, b) => a.folder.localeCompare(b.folder));
  });
  /** { manifest, code, path } of one plugin folder, or null when it does not exist. */
  ipcMain.handle('plugins-read', (_ev, folder) => readPluginSource(pluginsDir(), folder, { checkPath: (file) => pathPolicy.insideRoot(pluginsDir(), file, 'plugins-read') }));

  // ------------------------------------------------------------------ plugin-realm serving (AMENDMENT-P25-CSP-HOSTING Part A2)
  // The renderer asks main to serve the package of a plugin it has ALREADY
  // trusted through the existing trust flow (plugins.ts). Main resolves the
  // package from its OWN record — the folder name under the plugins dir,
  // never a renderer-supplied path — vets it (plugin.json parses; its "main"
  // names an entry file present in the package under that exact spelling),
  // mints an unguessable session id and registers the package's realpath in
  // the plugin-realm registry (electron/renderer-origin.cjs). The jcad://
  // handler then serves the package's .js/.mjs files under
  // jcad://app/plugin-realm/<sessionId>/ with the worker CSP until the
  // renderer unserves the session or the app quits. Main never evaluates,
  // transforms or wraps the served bytes.
  ipcMain.handle('plugins-serve-isolated', async (_ev, folder) => {
    const pluginRealm = ctx.pluginRealm;
    if (!pluginRealm) throw new Error('Plugin realm serving is unavailable in this build');
    if (!isPluginFolderName(folder)) throw new Error('Invalid plugin folder name');
    const root = pluginsDir();
    const packageDir = path.join(root, folder);
    const manifestText = await readPluginManifest(root, folder, { checkPath: (file) => pathPolicy.insideRoot(root, file, 'plugins-serve-isolated') });
    let record;
    try {
      record = JSON.parse(manifestText);
    } catch {
      throw new Error('plugin.json is not valid JSON');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('plugin.json must be an object');
    const main = record.main === undefined ? 'main.js' : String(record.main);
    if (!MAIN_RE.test(main)) throw new Error('plugin.json "main" must be a .js file in the plugin folder');
    // The entry must exist under exactly the manifest's spelling: the served
    // URL carries that spelling, and the handler serves only exact spellings.
    const stored = await fs.readdir(packageDir);
    if (!stored.includes(main)) throw new Error(`plugin entry "${main}" does not exist in the plugin folder`);
    await pathPolicy.insideRoot(root, path.join(packageDir, main), 'plugins-serve-isolated');
    const realRoot = await fs.realpath(packageDir);
    const sessionId = randomBytes(16).toString('hex');
    pluginRealm.register(sessionId, realRoot);
    return { sessionId, baseUrl: `jcad://app/plugin-realm/${sessionId}/`, entryUrl: `jcad://app/plugin-realm/${sessionId}/${main}` };
  });
  /** Drop one plugin-realm registration (the renderer reports its session disposed). */
  ipcMain.handle('plugins-unserve-isolated', (_ev, sessionId) => {
    if (typeof sessionId === 'string') ctx.pluginRealm?.unregister(sessionId);
    return true;
  });

  // ------------------------------------------------------------------ catalog packs (app data folder / packs)
  // Signed manufacturer catalogs (*.jcadpack.json, see docs/CATALOG-PACKS.md). The renderer verifies the
  // signature; the main process only stores the files verbatim, one per pack, with atomic writes.
  const packsDir = () => path.join(stateDir(), 'packs');
  const PACK_NAME_RE = /^[A-Za-z0-9._-]+\.jcadpack\.json$/;
  const MAX_PACK_BYTES = 20 * 1024 * 1024;
  function safePackName(name) {
    if (typeof name !== 'string' || name.length > 200 || name.includes('..') || !PACK_NAME_RE.test(name)) throw new Error('Invalid pack file name');
    return name;
  }
  ipcMain.handle('packs-dir', () => packsDir());
  ipcMain.handle('packs-list', async () => {
    try {
      return (await fs.readdir(packsDir())).filter((f) => PACK_NAME_RE.test(f)).sort();
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
  });
  ipcMain.handle('packs-read', async (_ev, name) => {
    const file = path.join(packsDir(), safePackName(name));
    try {
      await pathPolicy.insideRoot(packsDir(), file, 'packs-read');
      return /** @type {string} */ (await readLimitedFile(fs, file, MAX_PACK_BYTES, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  });
  ipcMain.handle('packs-write', async (_ev, name, text) => {
    const file = path.join(packsDir(), safePackName(name));
    validateTextSize(text, MAX_PACK_BYTES, 'pack');
    await fs.mkdir(packsDir(), { recursive: true });
    // Same discipline as the user library: write + fsync a temporary file, then rename over the target.
    await enqueueWrite(file, () => atomicWriteFile(file, text));
  });
  ipcMain.handle('packs-remove', async (_ev, name) => {
    await fs.rm(path.join(packsDir(), safePackName(name)), { force: true });
  });
  /** Native picker for a pack file; returns { name, text } (the renderer verifies and stores it) or null. */
  ipcMain.handle('pick-pack-file', async (ev) => {
    const win = senderWindow(ev);
    const res = await dialog.showOpenDialog(win, {
      title: 'Install Catalog Pack',
      filters: [
        { name: 'JCad Catalog Pack', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const file = res.filePaths[0];
    return { name: path.basename(file), text: /** @type {string} */ (await readLimitedFile(fs, file, MAX_PACK_BYTES, 'utf8')) };
  });
}

module.exports = { registerStoreIpc };
