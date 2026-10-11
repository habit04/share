/**
 * IPC for plot output: the raster sheet printed to PDF in a hidden window (plot-pdf), the vector
 * PDF the renderer built (save-pdf) and the system print dialog (print-drawing).
 */
const { BrowserWindow, dialog } = require('electron');
const { writeUserFile } = require('./app-data.cjs');
const { validatePaperDimensions } = require('../resource-limits.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @param {MainContext} ctx */
function registerPlotIpc(ctx) {
  const { ipcMain, senderWindow } = ctx;
  /** Plot: the renderer sends a PNG data URL of the sheet; we print it to PDF via a hidden window. */
  ipcMain.handle('plot-pdf', async (ev, dataUrl, suggestName, landscape, sheet) => {
    const win = senderWindow(ev);
    if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Invalid image');
    validatePaperDimensions(sheet); // before the dialog: at most 200 inches a side (E-18)
    const res = await dialog.showSaveDialog(win, {
      title: 'Plot to PDF',
      defaultPath: String(suggestName || 'Drawing1.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      // Keep the navigation URL tiny and inject the (possibly multi-megabyte) image afterwards.
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0}</style></head><body><img id="p"></body></html>';
      await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await hidden.webContents.executeJavaScript(`new Promise((ok, fail) => { const i = document.getElementById('p'); i.onload = () => ok(true); i.onerror = () => fail(new Error('image')); i.src = ${JSON.stringify(dataUrl)}; })`);
      // printToPDF takes a named size or {width, height} in INCHES (print() uses microns).
      const pdf = await hidden.webContents.printToPDF({
        printBackground: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        landscape: Boolean(landscape),
        pageSize: pdfPageSize(sheet, landscape),
      });
      await writeUserFile(res.filePath, pdf);
      return res.filePath;
    } finally {
      hidden.destroy();
    }
  });

  // Track E: vector PLOT output. The renderer builds the PDF (src/io/pdf-vector.ts); this only asks where to save it.
  ipcMain.handle('save-pdf', async (ev, bytes, suggestName) => {
    const win = senderWindow(ev);
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 512 * 1024 * 1024) throw new Error('Invalid PDF payload');
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Invalid PDF payload');
    const res = await dialog.showSaveDialog(win, {
      title: 'Plot to PDF',
      defaultPath: String(suggestName || 'Drawing1.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await writeUserFile(res.filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return res.filePath;
  });

  const NAMED_PAGES = new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger']);
  /**
   * Sheet dimensions in portrait inches (Electron applies `landscape` itself). Sizes from the
   * renderer must be finite, positive and at most 200 inches (security review E-18).
   */
  function sheetPortrait(sheet, landscape) {
    validatePaperDimensions(sheet);
    const w = sheet && Number.isFinite(sheet.width) && sheet.width > 0 ? sheet.width : landscape ? 11 : 8.5;
    const h = sheet && Number.isFinite(sheet.height) && sheet.height > 0 ? sheet.height : landscape ? 8.5 : 11;
    return w > h ? { width: h, height: w } : { width: w, height: h };
  }
  /** printToPDF page size: a named paper when possible, else inches. */
  function pdfPageSize(sheet, landscape) {
    if (sheet && NAMED_PAGES.has(sheet.electron)) return sheet.electron;
    return sheetPortrait(sheet, landscape);
  }
  /** print() page size: a named paper when possible, else microns. */
  function printPageSize(sheet, landscape) {
    if (sheet && NAMED_PAGES.has(sheet.electron) && sheet.electron !== 'Ledger') return sheet.electron;
    const p = sheetPortrait(sheet, landscape);
    return { width: Math.round(p.width * 25400), height: Math.round(p.height * 25400) };
  }

  /** Render the plot image in a hidden window and hand it to the OS print dialog. */
  ipcMain.handle('print-drawing', async (ev, dataUrl, title, landscape, sheet) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Invalid image');
    validatePaperDimensions(sheet); // at most 200 inches a side (E-18)
    const hidden = new BrowserWindow({ show: false, parent: win || undefined, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${String(title || 'Drawing').replace(/[<>&]/g, '')}</title><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0;size:${landscape ? 'landscape' : 'portrait'}}</style></head><body><img id="p"></body></html>`;
      await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await hidden.webContents.executeJavaScript(`new Promise((ok, fail) => { const i = document.getElementById('p'); i.onload = () => ok(true); i.onerror = () => fail(new Error('image')); i.src = ${JSON.stringify(dataUrl)}; })`);
      return await new Promise((resolve, reject) => {
        hidden.webContents.print({ silent: false, printBackground: true, landscape: Boolean(landscape), margins: { marginType: 'none' }, pageSize: printPageSize(sheet, landscape) }, (success, failureReason) => {
          if (success) resolve(true);
          else if (!failureReason || /cancel/i.test(failureReason)) resolve(false);
          else reject(new Error(failureReason));
        });
      });
    } finally {
      hidden.destroy();
    }
  });
}

module.exports = { registerPlotIpc };
