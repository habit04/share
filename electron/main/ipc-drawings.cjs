/**
 * IPC for drawings and projects: open (in the dialog or by name), Save and Save As with the paths
 * they may write, project files, text exports, backups before project-wide commands, and the
 * raster images IMAGE entities show. Every path goes through the path registry and policy.
 */
const { dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { backupFile, copyFileAtomic } = require('../atomic-write.cjs');
const { dxfImageNames } = require('../ipc-guard.cjs');
const { writeUserFile } = require('./app-data.cjs');
const { decodeDxf, readDwgWithProgress } = require('./dwg.cjs');
const { MAX_DRAWING_BYTES, MAX_PROJECT_BYTES, readLimitedFile, validateTextSize } = require('../resource-limits.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/**
 * @param {MainContext} ctx
 * @param {{ takeHandedOverProject: (file: string) => boolean }} handover  project files the OS handed over (handover.cjs)
 */
function registerDrawingIpc(ctx, { takeHandedOverProject }) {
  const { ipcMain, rejections, registry, pathPolicy, senderWindow } = ctx;
  /** What each write channel accepts (besides being writable): save-dxf, save-project, backup-file. */
  const DXF_FILE = /\.dxf$/i;
  const PROJECT_FILE = /\.json$/i;
  const BACKUP_FILE = /\.(dxf|jcadproj\.json)$/i;

  /**
   * Open a DXF or DWG. Returns { path, kind: 'dxf', text } or { path, kind: 'dwg', payload, version } or null.
   * A file chosen in the dialog becomes readable and writable by name; opening a known file by name
   * (Recent Documents, a project's drawing) reads it and leaves its access as it was.
   */
  async function openDrawingFile(win, file) {
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
    if (file.toLowerCase().endsWith('.dwg')) {
      // The DXF copy next to a DWG gets the DWG's access (DWG itself is never written).
      const twin = file.replace(/\.dwg$/i, '.dxf');
      if (registry.isWritable(file)) registry.grant(twin);
      else registry.grantRead(twin);
      // At most 512 MB, read through one handle (electron/resource-limits.cjs, E-7).
      const bytes = /** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_DRAWING_BYTES));
      const { payload, version } = await readDwgWithProgress(win, file, bytes);
      pathPolicy.rememberImages(file, (payload.imageDefs || []).map((d) => d && d.fileName));
      return { path: file, kind: 'dwg', payload, version };
    }
    // Read bytes, not a UTF-8 string: pre-2007 DXF files are in the $DWGCODEPAGE code page.
    const { text, encoding } = await decodeDxf(/** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_DRAWING_BYTES)));
    pathPolicy.rememberImages(file, dxfImageNames(text));
    return { path: file, kind: 'dxf', text, encoding };
  }

  ipcMain.handle('open-drawing', async (ev, file) => {
    const win = senderWindow(ev);
    if (file !== undefined && typeof file !== 'string') throw new Error('Invalid path');
    return openDrawingFile(win, file);
  });

  /**
   * Read a project file (or, by name, a project's catalog file) and register the project's drawings
   * and catalog file (electron/path-registry.cjs registerProject). A project the user chose - in
   * this dialog, handed over by the OS, or from Recent Documents (`opts.userChosen`, accepted only
   * for a project file the user chose or saved to before) - makes the drawings it lists writable
   * wherever they are; one opened only by name (a plugin, OPENPROJECT with a path) only those inside
   * its folder. `opts.textOnly`: the dialog reads a JSON file for its text (a catalog file), and
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
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Not a valid project file');
    }
    if (chosen) registry.grant(file);
    // Only a project file the user may write registers what it lists: a file that is readable only
    // (a project's catalog file, read through this channel) grants nothing.
    const writable = registry.isWritable(file);
    const userChosen = chosen || takeHandedOverProject(file) || (o.userChosen === true && writable);
    if (writable && o.textOnly !== true) registry.registerProject(file, parsed, { userChosen });
    return { path: file, text };
  });

  /** Save arbitrary text (CSV report, project file) through a save dialog. */
  ipcMain.handle('save-text', async (ev, suggestName, text, filterName, ext) => {
    const win = senderWindow(ev);
    if (typeof text !== 'string') throw new Error('Invalid payload');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save',
      defaultPath: String(suggestName || 'export.txt'),
      filters: [{ name: String(filterName || 'Text'), extensions: [String(ext || 'txt')] }],
    });
    if (res.canceled || !res.filePath) return null;
    // Crash-safe for every export; only a project file keeps its previous version as <name>.bak
    // (a .bak next to a CSV or text export would only clutter the user's folder).
    const isProject = /\.jcadproj\.json$/i.test(res.filePath) || String(filterName) === 'JCad Electrical Project';
    if (isProject) validateTextSize(text, MAX_PROJECT_BYTES, 'project');
    await writeUserFile(res.filePath, text, { backup: isProject });
    registry.grant(res.filePath);
    return res.filePath;
  });

  /**
   * The file a Save dialog's answer names once the channel's extension is appended to a name typed
   * without one (.dxf for drawings, .jcadproj.json for projects). The Windows and macOS dialogs
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
   * Drawing Save As: ask where to save; the path becomes writable by save-dxf (a .dxf file: a name
   * typed without the extension gets it, and is asked about when that file already exists -
   * completeSavePath) but nothing is written yet. The renderer then writes it
   * through its per-file save queue (src/app/savequeue.ts), so a Save As onto a file with an older
   * save still on its way is ordered after that save instead of racing it.
   */
  ipcMain.handle('choose-drawing-path', async (ev, suggestName) => {
    const win = senderWindow(ev);
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Drawing As',
      defaultPath: String(suggestName || 'Drawing1.dxf'),
      filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const file = await completeSavePath(win, res.filePath, DXF_FILE, '.dxf');
    if (!file) return null;
    registry.grant(file);
    return file;
  });

  /**
   * Write the project file to a path that came from our own dialogs (Open Project / Save Project As /
   * recent list): a .json file the user may write (a catalog file named by a project may not be).
   */
  ipcMain.handle('save-project', async (_ev, file, text) => {
    validateTextSize(text, MAX_PROJECT_BYTES, 'project');
    if (!pathPolicy.writable(file, 'save-project', PROJECT_FILE)) throw new Error('Unknown project path');
    // Temporary file + fsync + rename, previous version kept as <name>.bak (electron/atomic-write.cjs).
    await writeUserFile(file, text, { backup: true });
    return file;
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
  ipcMain.handle('backup-file', (_ev, file) =>
    backupFile(
      file,
      // A drawing a project opened by name made writable is copied only from inside the project's folder (E-5).
      (src, dest) => copyFileAtomic(src, dest, { root: registry.writeRoot(src) ?? undefined }),
      (p) => pathPolicy.writable(p, 'backup-file', BACKUP_FILE) !== null,
    ),
  );

  ipcMain.handle('open-dxf', async (ev) => {
    const win = senderWindow(ev);
    const r = await openDrawingFile(win);
    return r && r.kind === 'dxf' ? { path: r.path, text: r.text } : null;
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
    }
    // Temporary file + fsync + rename, previous version kept as <name>.dxf.bak (electron/atomic-write.cjs)
    // unless the renderer says no (a project-wide command made the .bak itself or was told to write without one).
    // A symbolic link that leads out of the file's folder (or, for a drawing a project opened by
    // name made writable, out of the project's folder) is refused with ELOOP (E-5).
    // A failure is thrown as "CODE: reason, write '<target>'"; the renderer maps it to a message.
    await writeUserFile(target, text, { backup: !(opts && opts.backup === false), root });
    // (A confined drawing is writable already; granting it would lift the confinement.)
    if (!root) registry.grant(target);
    return target;
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
    // Only images next to a file the user chose, or named by a drawing the user opened.
    const refused = pathPolicy.imageProblem(file);
    if (refused) {
      rejections.reject('read-image', `${refused}: ${String(file).slice(0, 300)}`);
      throw new Error('Invalid path');
    }
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    }
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = /** @type {Buffer} */ (await readLimitedFile(fs, file, MAX_IMAGE_BYTES));
    return `data:${type};base64,${bytes.toString('base64')}`;
  });
  // ------------------------------------------------------------------ end of read-image
}

module.exports = { registerDrawingIpc };
