/**
 * Files handed over by the OS.
 * "Open with JCad Electrical", a double click on a .dxf / .dwg / .jcadproj.json file (the installers
 * register these types: package.json build.fileAssociations), a file dropped on the program icon or
 * a second launch with a file: the paths arrive on the command line (or as macOS open-file events).
 * They become openable (and writable) by path (the user named them) and the renderer opens each
 * drawing in its own tab (pristine tab reused, an open tab shown) and a project as the current
 * project - asked for once it has loaded (take-open-files), pushed afterwards (open-files).
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const { pathKey } = require('../path-registry.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** The files the OS may hand over: drawings and project files. */
const HANDOVER_FILE = /\.(dxf|dwg)$|\.jcadproj\.json$/i;
/** Existing drawing and project files among command-line arguments (relative ones against `cwd`). */
function drawingArgs(argv, cwd) {
  const out = [];
  for (const a of Array.isArray(argv) ? argv.slice(1) : []) {
    if (typeof a !== 'string' || a.startsWith('-') || a.includes('\0') || !HANDOVER_FILE.test(a)) continue;
    const p = path.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), a);
    try {
      if (fsSync.statSync(p).isFile()) out.push(p);
    } catch {
      /* not a file: ignored */
    }
  }
  return out;
}

/**
 * The hand-over state and its channels (take-open-files, the macOS open-file event).
 * @param {MainContext} ctx
 */
function createHandover(ctx) {
  const { ipcMain, registry } = ctx;
  const pendingOpenFiles = [];
  /**
   * Project files handed over and not opened yet (pathKey): the user chose them, so open-project
   * registers what they list like a project chosen in the dialog, without relying on the renderer.
   */
  const handedOverProjects = new Set();
  function takeHandedOverProject(file) {
    const k = pathKey(file);
    return k !== null && handedOverProjects.delete(k);
  }
  function handOverFiles(files) {
    if (!files.length) return;
    // The user handed these over (Open with, a double click): readable and writable like a dialog's choice.
    for (const f of files) {
      registry.grant(f);
      const k = pathKey(f);
      if (k !== null && /\.json$/i.test(f)) handedOverProjects.add(k);
    }
    const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null;
    if (ctx.openFilesReady && win) win.webContents.send('open-files', files);
    else pendingOpenFiles.push(...files);
  }
  ipcMain.handle('take-open-files', () => {
    ctx.openFilesReady = true;
    return pendingOpenFiles.splice(0);
  });
  app.on('open-file', (ev, file) => {
    ev.preventDefault();
    if (typeof file === 'string' && HANDOVER_FILE.test(file)) handOverFiles([file]);
  });

  /** A second launch (Open with, a double click while the application runs) hands its files to this instance. */
  function registerSecondInstance() {
    app.on('second-instance', (_ev, argv, workingDirectory) => {
      // A drawing handed to a second launch ("Open with", a double click) opens in this window.
      handOverFiles(drawingArgs(argv, workingDirectory));
      const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
  return { takeHandedOverProject, handOverFiles, drawingArgs, registerSecondInstance };
}

module.exports = { createHandover };
