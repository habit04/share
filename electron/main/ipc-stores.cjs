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
const { isPluginFolderName, MAIN_RE, computePluginTrustKey, readPluginManifest, readPluginManifestBytes, readPluginPackageBytes, readPluginSourceBytes, sha256Hex } = require('../plugin-files.cjs');
const { buildPluginRealmSnapshot } = require('../renderer-origin.cjs');

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
  /**
   * { manifest, code, codeBytes, path } of one plugin folder, or null when
   * it does not exist. The entry travels BOTH ways from ONE stable read
   * (R2): `codeBytes` are the exact file bytes — the renderer's trust and
   * snapshot-verification hashes digest them — and `code` is those same
   * bytes decoded (lossy UTF-8), the text v1 has always executed.
   */
  ipcMain.handle('plugins-read', async (_ev, folder) => {
    const source = await readPluginSourceBytes(pluginsDir(), folder, { checkPath: (file) => pathPolicy.insideRoot(pluginsDir(), file, 'plugins-read') });
    return source === null ? null : { manifest: source.manifest, code: source.codeBytes.toString('utf8'), codeBytes: source.codeBytes, path: source.path };
  });

  // ------------------------------------------------------------------ plugin admission (PR #38 structural fix, lead ruling 2026-10-22)
  // ONE admission read per folder-plugin load. Main reads plugin.json's
  // exact bytes + the entry's exact bytes (the graph too, for the
  // worker form, via the F1 snapshot) ONCE and computes the package's
  // TRUST KEY (plugin-files.cjs computePluginTrustKey): SHA-256 over
  // the exact plugin.json bytes and the form material — the snapshot
  // manifest (worker) or the entry-bytes hash (page). The result
  // carries the policy bytes themselves, so the renderer's parsed
  // policy (isolation mode, API version, capabilities), its trust
  // comparison and (on the page path) the executed code ALL come from
  // this one read — never from an earlier plugins-read, which is a
  // different read that may name a different package version. The
  // worker form's snapshot is verified to have hashed the SAME
  // plugin.json bytes this admission did; a package that changed
  // mid-admission fails ERR_PLUGIN_CHANGED instead of admitting a
  // mixture. Returns null when the folder has no plugin.json (not a
  // folder package; the legacy read path reports it).
  ipcMain.handle('plugins-admit-package', async (_ev, folder) => {
    if (!isPluginFolderName(folder)) throw new Error('Invalid plugin folder name');
    const root = pluginsDir();
    const pkg = await readPluginPackageBytes(root, folder, { checkPath: (file) => pathPolicy.insideRoot(root, file, 'plugins-admit-package') });
    if (pkg === null) return null;
    const manifestText = pkg.manifestBytes.toString('utf8');
    let record;
    try {
      record = JSON.parse(manifestText);
    } catch {
      throw new Error('plugin.json is not valid JSON');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('plugin.json must be an object');
    const main = record.main === undefined ? 'main.js' : String(record.main);
    // Mirror the serve handler: the entry must exist under exactly the
    // manifest's spelling (its read in readPluginPackageBytes already
    // enforced MAIN_RE + the byte/size discipline).
    const packageDir = path.join(root, folder);
    const stored = await fs.readdir(packageDir);
    if (!stored.includes(main)) throw new Error(`plugin entry "${main}" does not exist in the plugin folder`);
    const entrySha256 = sha256Hex(pkg.codeBytes);
    // The form is decided from these same bytes: only the exact string
    // "worker" takes the worker form (the renderer's full parse of the
    // same bytes vets everything else and refuses malformed manifests
    // before trust, identically on both paths).
    const form = record.isolation === 'worker' ? 'worker' : 'page';
    let manifestSha256;
    let material = entrySha256;
    if (form === 'worker') {
      await pathPolicy.insideRoot(root, path.join(packageDir, main), 'plugins-admit-package');
      const realRoot = await fs.realpath(packageDir);
      const snapshot = await buildPluginRealmSnapshot(realRoot, main, {});
      if (snapshot.pluginJsonSha256 !== sha256Hex(pkg.manifestBytes)) {
        throw Object.assign(new Error('Plugin source changed while it was being admitted; reload the plugin to retry.'), { code: 'ERR_PLUGIN_CHANGED' });
      }
      manifestSha256 = snapshot.manifestSha256;
      material = manifestSha256;
    }
    const trustKey = computePluginTrustKey(pkg.manifestBytes, material);
    return {
      trustKey,
      form,
      manifest: manifestText,
      code: pkg.codeBytes.toString('utf8'),
      codeBytes: pkg.codeBytes,
      path: pkg.path,
      entrySha256,
      ...(manifestSha256 !== undefined ? { manifestHash: manifestSha256 } : {}),
    };
  });

  // ------------------------------------------------------------------ plugin-realm serving (AMENDMENT-P25-CSP-HOSTING Part A2; Fable F1; W-1)
  // The renderer asks main to serve the package of a plugin it has ALREADY
  // trusted through the existing trust flow (plugins.ts), and passes the
  // SHA-256 of the entry it approved plus — once one is remembered — the
  // MANIFEST hash of the whole package it approved (W-1: approval binds
  // the whole snapshot, not just the entry). Main resolves the package
  // from its OWN record — the folder name under the plugins dir, never a
  // renderer-supplied path — vets it (plugin.json parses; its "main"
  // names an entry file present in the package under that exact spelling),
  // then takes the F1 SNAPSHOT: the entry plus its static module graph is
  // read once, each file realpath-confined under its exact spelling, the
  // entry AND the whole-graph manifest are verified against the approved
  // hashes (a changed entry or a changed dependency fails the
  // registration with ERR_PLUGIN_CHANGED) and a SHA-256 is recorded
  // per file. The snapshot's own manifest hash travels back in the
  // result so the renderer can remember it in the trust record. The
  // registry holds the snapshot's in-memory bytes; the
  // jcad:// handler serves ONLY those bytes under
  // jcad://app/plugin-realm/<sessionId>/ with the worker CSP until the
  // renderer unserves the session or the app quits — disk is never
  // re-read after registration, so the realm executes the approved bytes
  // (approved bytes = executed bytes, for the whole graph). Main never
  // evaluates, transforms or wraps the served bytes.
  // Structural fix (2026-10-22): when the renderer supplies the
  // ADMITTED trust key (from plugins-admit-package), this handler
  // recomputes the key from its own reads and refuses the serve with
  // ERR_PLUGIN_CHANGED when it differs — the key shown at the prompt,
  // the key remembered and the key served are one key from one read.
  ipcMain.handle('plugins-serve-isolated', async (ev, folder, approvedEntryHash, approvedManifestHash, admittedTrustKey) => {
    const pluginRealm = ctx.pluginRealm;
    if (!pluginRealm) throw new Error('Plugin realm serving is unavailable in this build');
    if (!isPluginFolderName(folder)) throw new Error('Invalid plugin folder name');
    if (typeof approvedEntryHash !== 'string' || !/^[0-9a-f]{64}$/.test(approvedEntryHash)) {
      throw new Error('plugins-serve-isolated needs the SHA-256 of the plugin entry the user approved');
    }
    if (approvedManifestHash !== undefined && (typeof approvedManifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(approvedManifestHash))) {
      throw new Error('plugins-serve-isolated needs the SHA-256 manifest of the plugin package the user approved, when one is remembered');
    }
    if (admittedTrustKey !== undefined && (typeof admittedTrustKey !== 'string' || !/^[0-9a-f]{64}$/.test(admittedTrustKey))) {
      throw new Error('plugins-serve-isolated needs the SHA-256 trust key of the admitted plugin package, when one is supplied');
    }
    // PR #38 [P2] (Codex review, 2026-10-22): capture the registry
    // generation BEFORE the async work below (manifest read + snapshot
    // build). If the renderer goes away meanwhile — render-process-gone
    // or destroyed, F4's teardown — clear() bumps the generation and
    // the registration at the end is discarded instead of committing a
    // session nobody owns into the cleared registry.
    const generation = pluginRealm.generation();
    const root = pluginsDir();
    const packageDir = path.join(root, folder);
    // The manifest is read as BYTES here: the trust key below digests
    // the exact bytes, and the JSON parse runs on their decode — the
    // same pairing the admission read used (structural fix).
    const manifestBytes = await readPluginManifestBytes(root, folder, { checkPath: (file) => pathPolicy.insideRoot(root, file, 'plugins-serve-isolated') });
    const manifestText = manifestBytes.toString('utf8');
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
    // URL carries that spelling, and the snapshot keys files by it.
    const stored = await fs.readdir(packageDir);
    if (!stored.includes(main)) throw new Error(`plugin entry "${main}" does not exist in the plugin folder`);
    await pathPolicy.insideRoot(root, path.join(packageDir, main), 'plugins-serve-isolated');
    const realRoot = await fs.realpath(packageDir);
    let snapshot;
    try {
      snapshot = await buildPluginRealmSnapshot(realRoot, main, { approvedEntryHash, approvedManifestHash });
    } catch (err) {
      // Electron IPC drops an error's `code` on the way to the renderer;
      // the token rides in the MESSAGE so the renderer can recognise the
      // trust failure and re-ask (W-1), exactly as the code names it here.
      if (err && err.code === 'ERR_PLUGIN_CHANGED') throw new Error(`ERR_PLUGIN_CHANGED: ${err.message}`);
      throw err;
    }
    // PR #38 structural fix, ruling (3): the key this serve computes
    // from ITS reads must be the key the load was admitted and approved
    // under. The snapshot is first proven to have hashed the same
    // plugin.json bytes this handler read (a package that changed
    // between the two reads is a changed package), then — when the
    // renderer supplied the admitted key — the keys are compared and
    // any difference refuses the serve as ERR_PLUGIN_CHANGED, before
    // anything is registered. The computed key travels back in the
    // result so the renderer can reject the session itself as well.
    const currentTrustKey = computePluginTrustKey(manifestBytes, snapshot.manifestSha256);
    if (snapshot.pluginJsonSha256 !== undefined && snapshot.pluginJsonSha256 !== sha256Hex(manifestBytes)) {
      throw new Error('ERR_PLUGIN_CHANGED: Plugin source changed while it was being served; reload the plugin to retry.');
    }
    if (admittedTrustKey !== undefined && admittedTrustKey !== currentTrustKey) {
      throw new Error('ERR_PLUGIN_CHANGED: Plugin package changed since it was admitted; reload the plugin to approve the current package.');
    }
    const sessionId = randomBytes(16).toString('hex');
    // W-3: the registration is bound to the requesting webContents;
    // only that sender may unserve it (see the unserve handler).
    // PR #38 [P2]: it commits only under the generation captured
    // before the build — a discarded registration never serves, and
    // the load fails closed here rather than starting a plugin whose
    // window is gone.
    if (!pluginRealm.register(sessionId, snapshot, ev.sender, generation)) {
      throw new Error('plugin realm registration discarded: the window went away while the package was being prepared');
    }
    return { sessionId, baseUrl: `jcad://app/plugin-realm/${sessionId}/`, entryUrl: `jcad://app/plugin-realm/${sessionId}/${main}`, manifestHash: snapshot.manifestSha256, trustKey: currentTrustKey };
  });
  /**
   * Drop one plugin-realm registration (the renderer reports its session
   * disposed). W-3 sender/owner check: the unserve is honoured only from
   * the webContents that registered the session — a foreign sender's
   * unserve is a no-op and the result says so (false).
   */
  ipcMain.handle('plugins-unserve-isolated', (ev, sessionId) => {
    if (typeof sessionId !== 'string') return false;
    return ctx.pluginRealm?.unregister(sessionId, ev.sender) ?? false;
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
