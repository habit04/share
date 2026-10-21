/**
 * IPC for drawings and projects: open (in the dialog or by name), Save and Save As with the paths
 * they may write, project files, text exports, backups before project-wide commands, and the
 * raster images IMAGE entities show. Every path goes through the path registry and policy.
 */
const { dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { backupFile, copyFileAtomic, createAtomicWriter } = require('../atomic-write.cjs');
const { dxfImageNames } = require('../ipc-guard.cjs');
const { writeUserFile, enqueueWrite } = require('./app-data.cjs');
const { createPortableDwgExporter } = require('../portable-dwg.cjs');
const { decodeDxf, readDwgWithProgress } = require('./dwg.cjs');
const { MAX_DRAWING_BYTES, MAX_PROJECT_BYTES, readLimitedFile, validateTextSize } = require('../resource-limits.cjs');
const { registerSaveOrder } = require('./save-order.cjs');
const { coherentFileDigest } = require('../windows-path-identity.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/**
 * @param {MainContext} ctx
 * @param {{ takeHandedOverProject: (file: string) => boolean }} handover  project files the OS handed over (handover.cjs)
 */
function registerDrawingIpc(ctx, { takeHandedOverProject }) {
  const { ipcMain, rejections, registry, pathPolicy, senderWindow } = ctx;
  /** What each write channel accepts (besides being writable): save-dxf, save-dwg, save-project, backup-file. */
  const DXF_FILE = /\.dxf$/i;
  const PROJECT_FILE = /\.json$/i;
  const BACKUP_FILE = /\.(dxf|jcadproj\.json)$/i;
  const DWG_FILE = /\.dwg$/i;
  const dwgExporter = createPortableDwgExporter();
  // Export Copy requires its dedicated picker even when normal Save may write an opened DWG.
  const dwgDestinations = new Set();
  const dwgKey = (file) => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : resolved.normalize('NFC').toLowerCase();
  };
  const saveOrder = process.platform === 'win32' ? registerSaveOrder(ctx, (_owner, kind, file) => {
    const type = kind === 'project' ? PROJECT_FILE : kind === 'export-copy' ? DWG_FILE : kind === 'text-export' || kind === 'pdf-export' ? /./ : /\.(dxf|dwg)$/i;
    const allowed = pathPolicy.writable(file, 'save-admission', type) !== null && (kind !== 'export-copy' || dwgDestinations.has(dwgKey(file)));
    const root = registry.writeRoot(file);
    return allowed ? { allowed: true, ...(root ? { root } : {}) } : { allowed: false };
  }) : null;
  // Plot and drawing writes must share the same owner, target ledger and source proofs.
  ctx.saveOrder = saveOrder;

  async function identityPath(file) {
    if (process.platform !== 'win32') return undefined;
    try { return await fs.realpath(file); } catch { return undefined; }
  }
  /** Couple returned bytes and identity to the same held descriptor, then recheck after close. */
  /** @param {import('../windows-path-identity.cjs').WindowsWriteTarget} [expectedPin] */
  async function readDrawingBytes(file, expectedPin) {
    if (process.platform !== 'win32') return { bytes: await readLimitedFile(fs, file, MAX_DRAWING_BYTES), identityPath: undefined };
    const changed = () => Object.assign(new Error('ERR_WINDOWS_PATH_CHANGED: the drawing changed while it was opened. Open it again.'), { code: 'ERR_WINDOWS_PATH_CHANGED' });
    const version = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
    // Windows ctime also changes for metadata updates. A standalone Open may
    // accept that transition only after a fresh, coherent hash matches the
    // bytes already read. An admitted project batch keeps its exact version.
    const readVersion = expectedPin ? version : (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(':');
    const nativeVersion = (stat) => Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
    /** @type {{version:string,size:bigint,identityPath:string|undefined,fileVersion:import('../windows-path-identity.cjs').FileVersion,sha256?:string}|undefined} */ let captured;
    const observe = async () => {
      const stat = await fs.stat(file, { bigint: true }), canonical = await identityPath(file);
      if (canonical && (readVersion(await fs.stat(canonical, { bigint: true })) !== readVersion(stat) || await identityPath(file) !== canonical)) throw changed();
      return { version: readVersion(stat), size: stat.size, identityPath: canonical, fileVersion: nativeVersion(stat) };
    };
    const check = async () => {
      if (!captured) throw changed();
      const current = await observe();
      if (current.version !== captured.version || current.identityPath !== captured.identityPath) throw changed();
      if (captured.sha256) {
        try {
          const digest = await coherentFileDigest(file, { fs, maxBytes: MAX_DRAWING_BYTES, expectedCanonicalPath: captured.identityPath, expectedVersion: current.fileVersion });
          if (digest.sha256 !== captured.sha256 || readVersion(digest.version) !== captured.version) throw changed();
          captured.fileVersion = digest.version;
        } catch (error) {
          // Standalone opens have no admission wrapper; preserve the code in IPC error text.
          if (error?.code === 'ERR_WINDOWS_PATH_CHANGED') throw changed();
          throw error;
        }
      }
    };
    const bytes = await readLimitedFile(fs, file, MAX_DRAWING_BYTES, undefined, {
      async beforeRead(handle) {
        const held = await handle.stat({ bigint: true }), current = await observe();
        if (readVersion(held) !== current.version) throw changed();
        if (expectedPin) {
          const original = expectedPin.fileVersion;
          if (!original || current.identityPath !== expectedPin.canonicalPath || current.version !== [original.dev, original.ino, original.size, original.mtimeNs, original.ctimeNs].join(':')) throw changed();
        }
        captured = current;
      },
      async afterRead(handle, content) {
        if (!captured || readVersion(await handle.stat({ bigint: true })) !== captured.version || BigInt(content.byteLength) !== captured.size) throw changed();
        captured.sha256 = createHash('sha256').update(content).digest('hex');
        if (expectedPin && captured.sha256 !== expectedPin.fileVersion?.sha256) throw changed();
        await check();
      },
    });
    await check();
    if (!captured?.identityPath || !captured.sha256) throw changed();
    const verified = captured, canonicalPath = captured.identityPath, sha256 = captured.sha256;
    return { bytes, identityPath: canonicalPath, check,
      // Decoding may take time. Publish the last hash-verified version rather
      // than a pre-decode ctime that would make the next valid Save fail.
      get sourceEvidence() { return Object.freeze({ canonicalPath, fileVersion: Object.freeze({ ...verified.fileVersion, sha256 }) }); },
    };
  }
  if (saveOrder) ipcMain.handle('resolve-path-identity', async (_ev, file) => {
    if (!pathPolicy.known(file, 'resolve-path-identity')) return null;
    return (await identityPath(file)) ?? null;
  });
  if (saveOrder) ipcMain.handle('open-project-save-batch-drawing', async (ev, batch, child) => saveOrder.readBatch(ev, batch, child, async (scope) => {
    const file = scope.pin.logicalPath;
    if (!DXF_FILE.test(file) || !pathPolicy.known(file, 'open-project-save-batch-drawing')) throw new Error('Unknown project DXF path');
    // The manifest's original native version supplies the calculation input. It is never rebound.
    await scope.guard();
    const read = await readDrawingBytes(file, scope.pin);
    const { text, encoding } = await decodeDxf(/** @type {Buffer} */ (read.bytes));
    if (read.check) await read.check();
    await scope.guard();
    pathPolicy.rememberImages(file, dxfImageNames(text));
    return { path: file, identityPath: read.identityPath, kind: 'dxf', text, encoding };
  }));

  async function writeAdmittedText(ev, kind, file, text, backup, ticket) {
    if (!saveOrder) { await writeUserFile(file, text, { backup, root: registry.writeRoot(file) ?? undefined }); return file; }
    return saveOrder.run(ev, kind, file, ticket, (scope) => scope.commit(text, (snapshot, target) => enqueueWrite(target.destinationPath, async (key) => {
      const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: target.guard } });
      await writer.atomicWriteFile(target.destinationPath, snapshot, { backup, root: target.root, expectedDestination: key, beforeBackupRename: target.guard });
      await target.markCommitted();
      // Keep the bound logical spelling: renderer identity and relative references use it.
      return { path: target.logicalPath, identityPath: target.canonicalPath };
    })));
  }

  /**
   * Open a DXF or DWG. Returns { path, kind: 'dxf', text } or { path, kind: 'dwg', payload, version } or null.
   * A file chosen in the dialog becomes readable and writable by name; opening a known file by name
   * (Recent Documents, a project's drawing) reads it and leaves its access as it was.
   */
  async function openDrawingFile(win, file, ev) {
    const opening = saveOrder?.captureRead(ev);
    const chosen = !file;
    if (!file) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Open Drawing',
        filters: [
          { name: 'Drawings (DXF, DWG)', extensions: ['dxf', 'dwg'] },
          { name: 'DXF Drawing', extensions: ['dxf'] },
          { name: 'DWG Drawing', extensions: ['dwg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      file = res.filePaths[0];
    } else if (!pathPolicy.known(file, 'open-drawing')) {
      // Only paths that came from our own dialogs / recent list may be opened by name.
      throw new Error('Unknown file path');
    }
    if (chosen) registry.grant(file);
    const reservation = opening && saveOrder?.reserveRead(ev, opening, file);
    try {
    if (file.toLowerCase().endsWith('.dwg')) {
      // The DXF working copy gets the DWG's access; Export Copy still needs its own Save dialog.
      const twin = file.replace(/\.dwg$/i, '.dxf');
      registry.grantDerived(twin, file);
      // At most 128 MiB, read through one nonblocking handle (E-7).
      const read = await readDrawingBytes(file), bytes = /** @type {Buffer} */ (read.bytes);
      const { payload, version } = await readDwgWithProgress(win, file, bytes);
      if (read.check) await read.check();
      pathPolicy.rememberImages(file, (payload.imageDefs || []).map((d) => d && d.fileName));
      const openedSourceProof = reservation ? saveOrder?.completeRead(ev, opening, reservation, read.sourceEvidence) : undefined;
      return { path: file, identityPath: read.identityPath, openedSourceProof, kind: 'dwg', payload, version };
    }
    // Read bytes, not a UTF-8 string: pre-2007 DXF files are in the $DWGCODEPAGE code page.
    const read = await readDrawingBytes(file);
    const { text, encoding } = await decodeDxf(/** @type {Buffer} */ (read.bytes));
    if (read.check) await read.check();
    pathPolicy.rememberImages(file, dxfImageNames(text));
    const openedSourceProof = reservation ? saveOrder?.completeRead(ev, opening, reservation, read.sourceEvidence) : undefined;
    return { path: file, identityPath: read.identityPath, openedSourceProof, kind: 'dxf', text, encoding };
    } finally { if (opening && reservation) saveOrder?.cancelRead(opening, reservation); }
  }

  ipcMain.handle('open-drawing', async (ev, file) => {
    const win = senderWindow(ev);
    if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
    return openDrawingFile(win, file, ev);
  });

  /**
   * Read a project file (or, by name, a project's catalog file) and register the project's drawings
   * and catalog file (electron/path-registry.cjs registerProject). A project the user chose - in
   * this dialog, handed over by the OS, or from the native Recent menu - makes the drawings it lists writable
   * wherever they are; one opened only by name (a plugin, OPENPROJECT with a path) only those inside
   * its folder. A renderer's `opts.userChosen` claim grants no permission. `opts.textOnly` reads a JSON file for its text, and
   * nothing it lists is registered.
   */
  ipcMain.handle('open-project', async (ev, file, opts) => {
    const win = senderWindow(ev);
    if (file !== undefined && file !== null && typeof file !== 'string') throw new Error('Invalid path');
    const o = opts && typeof opts === 'object' ? opts : {};
    file = file || undefined;
    const chosen = !file;
    if (!file) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Open Project',
        filters: [{ name: 'JCad Electrical Project', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      file = res.filePaths[0];
    } else {
      if (!pathPolicy.known(file, 'open-project')) throw new Error('Unknown file path');
      if (!PROJECT_FILE.test(file)) {
        rejections.reject('open-project', `wrong file type: ${file.slice(0, 300)}`);
        throw new Error('Unknown file path');
      }
    }
    const text = /** @type {string} */ (await readLimitedFile(fs, file, MAX_PROJECT_BYTES, 'utf8'));
    let parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      throw new Error('Not a valid project file');
    }
    if (chosen) registry.grant(file);
    // Only a project file the user may write registers what it lists: a file that is readable only
    // (a project's catalog file, read through this channel) grants nothing.
    const writable = registry.isWritable(file);
    const handedOver = takeHandedOverProject(file);
    const userChosen = chosen || handedOver;
    if (writable && o.textOnly !== true) registry.registerProject(file, parsed, { userChosen });
    return { path: file, text };
  });

  /** Save arbitrary text (CSV report, project file) through a save dialog. */
  ipcMain.handle('save-text', async (ev, suggestName, text, filterName, ext, opts) => {
    const win = senderWindow(ev);
    if (typeof text !== 'string') throw new Error('Invalid payload');
    if (opts !== undefined && (!opts || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some(key => key !== 'admission') || opts.admission !== undefined && (typeof opts.admission !== 'string' || !opts.admission))) throw new Error('Invalid text export admission options');
    if (opts?.admission !== undefined && !saveOrder) throw new Error('A Windows text export admission is required.');
    const projectIntent = /\.jcadproj\.json$/i.test(String(suggestName)) || String(filterName) === 'JCad Electrical Project';
    const kind = projectIntent ? 'project' : 'text-export';
    const captured = kind === 'text-export' ? saveOrder?.capturePicked(ev, kind, opts?.admission) : saveOrder?.capture(ev, kind, opts?.admission);
    try {
    if (captured) saveOrder?.assertPicked(ev, kind, captured);
    const res = await dialog.showSaveDialog(win, {
      title: 'Save',
      defaultPath: String(suggestName || 'export.txt'),
      filters: [{ name: String(filterName || 'Text'), extensions: [String(ext || 'txt')] }],
    });
    if (res.canceled || !res.filePath) return null;
    if (captured) saveOrder?.assertPicked(ev, kind, captured);
    // Crash-safe for every export; only a project file keeps its previous version as <name>.bak
    // (a .bak next to a CSV or text export would only clutter the user's folder).
    const isProject = /\.jcadproj\.json$/i.test(res.filePath) || String(filterName) === 'JCad Electrical Project';
    if (isProject) validateTextSize(text, MAX_PROJECT_BYTES, 'project');
    if (saveOrder && captured) {
      registry.grant(res.filePath);
      if (!isProject) validateTextSize(text, MAX_DRAWING_BYTES, 'text export');
      if (kind === 'text-export') await saveOrder.bindPicked(ev, kind, res.filePath, captured);
      return await writeAdmittedText(ev, kind, res.filePath, text, isProject, captured);
    }
    await writeUserFile(res.filePath, text, { backup: isProject });
    registry.grant(res.filePath);
    return res.filePath;
    } finally { saveOrder?.discard(captured); }
  });

  /**
   * The file a Save dialog's answer names once the channel's extension is appended to a name typed
   * without one (.dxf or .dwg for drawings, .jcadproj.json for projects). The Windows and macOS dialogs
   * complete the name themselves and ask there before a file is replaced; the Linux (GTK) dialog asks
   * only about the name as typed, so when the completed name already exists, the question is asked
   * here. Resolves the completed path, or null when the user keeps that file.
   */
  async function completeSavePath(win, chosen, type, ext) {
    const file = type.test(chosen) ? chosen : `${chosen}${ext}`;
    if (file === chosen) return file;
    const exists = await fs.access(file).then(() => true, () => false);
    if (!exists) return file;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `${path.basename(file)} already exists. Replace it?`,
      detail: `The name you typed was completed to ${file}. Replace keeps the previous version as ${path.basename(file)}.bak.`,
    });
    return r.response === 0 ? file : null;
  }

  /**
   * Project Save As: ask where to save; the path becomes writable by save-project but nothing is written
   * yet. A name typed without .json gets .jcadproj.json (and is asked about when that file exists).
   */
  ipcMain.handle('choose-project-path', async (ev, suggestName) => {
    const win = senderWindow(ev);
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Project As',
      defaultPath: String(suggestName || 'Project.jcadproj.json'),
      filters: [{ name: 'JCad Electrical Project', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const file = await completeSavePath(win, res.filePath, PROJECT_FILE, '.jcadproj.json');
    if (!file) return null;
    registry.grant(file);
    return file;
  });

  /**
   * Drawing Save As: Windows offers DXF and DWG; other platforms and explicit DXF exports offer
   * DXF. The suggested format comes first, but a supported extension selects the final format. A
   * name without an extension gets the initial format (with confirmation if that completed path exists). Nothing
   * is written yet: the chosen path becomes writable, then the renderer writes it
   * through its per-file save queue (src/app/savequeue.ts), so a Save As onto a file with an older
   * save still on its way is ordered after that save instead of racing it.
   */
  ipcMain.handle('choose-drawing-path', async (ev, suggestName, format) => {
    const win = senderWindow(ev);
    if (suggestName !== undefined && (typeof suggestName !== 'string' || suggestName.length > 4096 || suggestName.includes('\0'))) throw new Error('Invalid drawing filename');
    if (format !== undefined && format !== 'dxf') throw new Error('Invalid drawing format');
    const allowDwg = process.platform === 'win32' && format !== 'dxf';
    const suggested = String(suggestName || 'Drawing1.dxf');
    const defaultPath = format === 'dxf' ? suggested.replace(DWG_FILE, '.dxf') : suggested;
    const preferredDwg = allowDwg && DWG_FILE.test(defaultPath);
    const dxfFilter = { name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] };
    const dwgFilter = { name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] };
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Drawing As',
      defaultPath,
      filters: allowDwg ? (preferredDwg ? [dwgFilter, dxfFilter] : [dxfFilter, dwgFilter]) : [dxfFilter],
    });
    if (res.canceled || !res.filePath) return null;
    if (pathPolicy.shapeProblem(res.filePath)) return null;
    const ext = path.extname(res.filePath).toLowerCase();
    if (ext && ext !== '.dxf' && !(allowDwg && ext === '.dwg')) throw new Error('Choose a supported drawing extension: ' + (allowDwg ? '.dxf or .dwg.' : '.dxf.'));
    const file = await completeSavePath(win, res.filePath, allowDwg ? /\.(dxf|dwg)$/i : DXF_FILE, preferredDwg ? '.dwg' : '.dxf');
    if (!file || pathPolicy.shapeProblem(file)) return null;
    registry.grant(file);
    return file;
  });

  ipcMain.handle('dwg-export-status', async (_ev) => dwgExporter.status());

  ipcMain.handle('choose-dwg-path', async (ev, suggestName) => {
    const win = senderWindow(ev);
    const status = await dwgExporter.status();
    if (!status.available) throw new Error(status.reason);
    if (suggestName !== undefined && (typeof suggestName !== 'string' || suggestName.length > 4096 || suggestName.includes('\0'))) throw new Error('Invalid DWG filename');
    const res = await dialog.showSaveDialog(win, {
      title: 'Export DWG Copy',
      defaultPath: String(suggestName || 'Drawing1.dwg'),
      filters: [{ name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const file = await completeSavePath(win, res.filePath, DWG_FILE, '.dwg');
    if (!file || pathPolicy.shapeProblem(file)) return null;
    registry.grant(file);
    dwgDestinations.add(dwgKey(file));
    if (dwgDestinations.size > 128) dwgDestinations.delete(dwgDestinations.values().next().value);
    return file;
  });

  /**
   * Both DWG channels use the verified portable writer, canonical queue and atomic backup. A
   * normal Save keeps a by-name project's write confinement; Export Copy is native-picked.
   * @param {Electron.BrowserWindow} win
   * @param {string} target
   * @param {string} text
   * @param {string | undefined} [root]
   */
  async function writePortableDwg(win, target, text, ev, ticket, kind, root) {
    if (saveOrder) {
      const result = await saveOrder.run(ev, kind, target, ticket, (scope) => dwgExporter.export(target, text, (_destination, bytes, check) => scope.commit(bytes, (snapshot, admitted) => enqueueWrite(admitted.destinationPath, async (key) => {
        const guard = async () => { await check(); await admitted.guard(); };
        const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: guard } });
        await writer.atomicWriteFile(admitted.destinationPath, snapshot, { backup: true, expectedDestination: key, root: admitted.root, beforeBackupRename: guard });
        await admitted.markCommitted();
        return { path: admitted.logicalPath, identityPath: admitted.canonicalPath };
      })), scope.signal));
      pathPolicy.rememberImages(target, dxfImageNames(text));
      return result;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    win.once('closed', cancel);
    win.webContents.once('destroyed', cancel);
    win.webContents.once('render-process-gone', cancel);
    try {
      const result = await dwgExporter.export(target, text, (destination, bytes, check) => enqueueWrite(destination, async (key) => {
        // Queue with DXF/project writes, then check the original identity again inside the reservation.
        await check();
        const writer = createAtomicWriter(undefined, { hooks: { beforeRename: check } });
        await writer.atomicWriteFile(destination, bytes, { backup: true, expectedDestination: key, root });
      }), controller.signal);
      pathPolicy.rememberImages(target, dxfImageNames(text));
      return result;
    } finally {
      win.removeListener('closed', cancel);
      win.webContents.removeListener('destroyed', cancel);
      win.webContents.removeListener('render-process-gone', cancel);
    }
  }

  ipcMain.handle('export-dwg', async (ev, file, text, admission) => {
    const win = senderWindow(ev);
    validateTextSize(text, MAX_DRAWING_BYTES, 'DXF');
    const target = pathPolicy.writable(file, 'export-dwg', DWG_FILE);
    if (!target || !dwgDestinations.has(dwgKey(target))) throw new Error('Choose the DWG export destination using its Save dialog first.');
    return writePortableDwg(win, target, text, ev, admission, 'export-copy', undefined);
  });

  /** Save an authorized .dwg in place; read-only or unknown drawings must use Save As first. */
  ipcMain.handle('save-dwg', async (ev, file, text, admission) => {
    const win = senderWindow(ev);
    if (process.platform !== 'win32') throw new Error('DWG saving is available on Windows only.');
    validateTextSize(text, MAX_DRAWING_BYTES, 'DXF');
    const target = pathPolicy.writable(file, 'save-dwg', DWG_FILE);
    if (!target) throw new Error('Choose a writable DWG destination using Save As first.');
    return writePortableDwg(win, target, text, ev, admission, 'drawing', registry.writeRoot(target) ?? undefined);
  });

  /**
   * Write the project file to a path that came from our own dialogs (Open Project / Save Project As /
   * recent list): a .json file the user may write (a catalog file named by a project may not be).
   */
  ipcMain.handle('save-project', async (ev, file, text, admission) => {
    validateTextSize(text, MAX_PROJECT_BYTES, 'project');
    if (!pathPolicy.writable(file, 'save-project', PROJECT_FILE)) throw new Error('Unknown project path');
    // Temporary file + fsync + rename, previous version kept as <name>.bak (electron/atomic-write.cjs).
    return writeAdmittedText(ev, 'project', file, text, true, admission);
  });

  /**
   * Copy a drawing or project file to `<file>.bak` before a project-wide command rewrites it.
   * Only DXF drawings and *.jcadproj.json project files the renderer may write by name (our
   * dialogs, the recent list, the drawings an opened project lists - the same rule as
   * save-dxf; the shared path policy logs refusals in ipc-rejections.log) are copied, through a
   * temporary file + fsync + rename (electron/atomic-write.cjs backupFile). Resolves
   * { ok: true, path } or { ok: false, code, error } with a message for the user; it never throws
   * and never reports success without a complete copy.
   */
  ipcMain.handle('backup-file', async (ev, file, opts) => {
    if (saveOrder && pathPolicy.writable(file, 'backup-file', BACKUP_FILE)) {
      try {
        return await saveOrder.prepare(ev, /\.json$/i.test(file) ? 'project' : 'drawing', file, opts?.admission, (target) => {
          const writer = createAtomicWriter();
          return backupFile(target.destinationPath, (src, dest) => writer.copyFileAtomic(src, dest, { root: target.root, beforeRename: target.guard }), () => true);
        });
      } catch (error) { return { ok: false, code: error?.code || 'ERR_SAVE_OPERATION', error: error?.message || 'The backup could not be made.' }; }
    }
    return backupFile(
      file,
      // A drawing a project opened by name made writable is copied only from inside the project's folder (E-5).
      (src, dest) => copyFileAtomic(src, dest, { root: registry.writeRoot(src) ?? undefined }),
      (p) => pathPolicy.writable(p, 'backup-file', BACKUP_FILE) !== null,
    );
  });

  ipcMain.handle('open-dxf', async (ev) => {
    const win = senderWindow(ev);
    const r = await openDrawingFile(win, undefined, ev);
    if (r && r.kind !== 'dxf' && r.openedSourceProof) saveOrder?.releaseRead(ev, r.openedSourceProof);
    return r && r.kind === 'dxf' ? { path: r.path, identityPath: r.identityPath, openedSourceProof: r.openedSourceProof, text: r.text } : null;
  });

  /**
   * Save a drawing as DXF. By name (`existingPath`) only over a .dxf file the renderer may write
   * (electron/path-registry.cjs); another file type is refused (and logged). A drawing that may only
   * be read (a drawing outside the folder of a project opened only by name) or an unknown path goes through the
   * Save As dialog instead - opened on that drawing when it is readable, so the user confirms it. A name
   * typed there without .dxf gets it, like choose-drawing-path (completeSavePath).
   */
  ipcMain.handle('save-dxf', async (ev, existingPath, text, suggestName, opts) => {
    const win = senderWindow(ev);
    validateTextSize(text, MAX_DRAWING_BYTES, 'DXF');
    // A compatibility caller still belongs to the document that opened its picker.
    const captured = saveOrder?.capture(ev, 'drawing', opts?.admission);
    try {
    let target = existingPath == null ? null : pathPolicy.writable(existingPath, 'save-dxf', DXF_FILE);
    // Saved by name: a drawing a project opened by name made writable stays inside the project's folder.
    const root = (target && registry.writeRoot(target)) ?? undefined;
    let defaultPath = String(suggestName || 'Drawing1.dxf');
    if (!target && typeof existingPath === 'string' && !pathPolicy.shapeProblem(existingPath)) {
      if (!DXF_FILE.test(existingPath)) throw new Error('Invalid path');
      if (registry.isKnown(existingPath)) defaultPath = existingPath;
    }
    if (!target) {
      const res = await dialog.showSaveDialog(win, {
        title: 'Save Drawing As',
        defaultPath,
        filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = await completeSavePath(win, res.filePath, DXF_FILE, '.dxf');
      if (!target) return null;
      registry.grant(target);
    }
    // Temporary file + fsync + rename, previous version kept as <name>.dxf.bak (electron/atomic-write.cjs)
    // unless the renderer says no (a project-wide command made the .bak itself or was told to write without one).
    // A symbolic link that leads out of the file's folder (or, for a drawing a project opened by
    // name made writable, out of the project's folder) is refused with ELOOP (E-5).
    // A failure is thrown as "CODE: reason, write '<target>'"; the renderer maps it to a message.
    const saved = await writeAdmittedText(ev, 'drawing', target, text, !(opts && opts.backup === false), captured ?? opts?.admission);
    // (A confined drawing is writable already; granting it would lift the confinement.)
    if (!root) registry.grant(target);
    return saved;
    } finally { saveOrder?.discard(captured); }
  });

  // ------------------------------------------------------------------ raster images of IMAGE entities (read-image)
  // The renderer resolves IMAGEDEF paths against the drawing's folder and asks for absolute
  // paths of image files only; the bytes come back as a data URL (null when missing or too big).
  const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  ipcMain.handle('read-image', async (_ev, file) => {
    if (pathPolicy.shapeProblem(file)) throw new Error('Invalid path');
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) throw new Error('Not an image file');
    // Resolve through the canonical policy once: Windows short names and macOS system aliases
    // may differ from the spelling registered by the native drawing dialog.
    let stat;
    try {
      file = await pathPolicy.imagePath(file);
      stat = await fs.stat(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      if (err && err.code === 'ERR_IMAGE_PATH') {
        rejections.reject('read-image', `${err.message}: ${String(file).slice(0, 300)}`);
        throw new Error('Invalid path');
      }
      throw err;
    }
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = /** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_IMAGE_BYTES));
    return `data:${type};base64,${bytes.toString('base64')}`;
  });
  // ------------------------------------------------------------------ end of read-image
}

module.exports = { registerDrawingIpc };
