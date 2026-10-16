/**
 * IPC for plot output: the raster sheet printed to PDF in a hidden window (plot-pdf), the vector
 * PDF the renderer built (save-pdf) and the system print dialog (print-drawing).
 */
const { BrowserWindow, dialog } = require('electron');
const { writeUserFile, enqueueWrite } = require('./app-data.cjs');
const { createAtomicWriter } = require('../atomic-write.cjs');
const { secureContents } = require('./window.cjs');
const { validatePaperDimensions } = require('../resource-limits.cjs');

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @param {MainContext} ctx */
function registerPlotIpc(ctx) {
  const { ipcMain, senderWindow, registry, pathPolicy, saveOrder, restrictedPdf } = ctx;
  const cancelled = () => Object.assign(new Error('ERR_SAVE_CANCELLED: the original exporting document is no longer active.'), { code: 'ERR_SAVE_CANCELLED' });
  function exportOptions(opts) {
    if (opts === undefined) return {};
    if (!opts || typeof opts !== 'object' || Array.isArray(opts) || opts.path !== undefined && typeof opts.path !== 'string' || opts.admission !== undefined && typeof opts.admission !== 'string') throw new Error('Invalid PDF admission options');
    if (opts.path !== undefined && (!opts.path || !opts.admission || !saveOrder)) throw new Error('A bound Windows PDF admission is required.');
    // Restricted mode (12.4): the save call carries only the digest claim; the
    // authoritative registration was made earlier through register-restricted-pdf
    // and is consumed against the received bytes inside the producer.
    if (opts.restricted !== undefined) {
      const claim = opts.restricted;
      if (!claim || typeof claim !== 'object' || Array.isArray(claim) || typeof claim.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claim.sha256)
        || !Number.isInteger(claim.byteLength) || claim.byteLength < 8 || claim.byteLength > 128 * 1024 * 1024) throw new Error('Invalid restricted PDF claim');
      if (!opts.path || !opts.admission || !restrictedPdf) throw new Error('A registered restricted PDF export is required.');
    }
    return opts;
  }
  /**
   * Register one restricted export (12.4): the ticket must already be bound to
   * the claimed destination for this sender, and every claimed preview/print
   * face is checked against the font host's own admission records inside the
   * registry. Registration is single-use and expires; see registry.cjs for
   * exactly what this binding does and does not prove.
   */
  ipcMain.handle('register-restricted-pdf', async (ev, ticket, claim) => {
    if (!restrictedPdf || !saveOrder) throw new Error('Restricted PDF export is not available.');
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || typeof claim.path !== 'string') throw new Error('Invalid restricted PDF registration');
    const captured = saveOrder.capture(ev, 'pdf-export', ticket);
    const file = pathPolicy?.writable(claim.path, 'register-restricted-pdf', /./);
    if (!file || !saveOrder.assertBound(ev, 'pdf-export', file, captured)) throw new Error('The restricted PDF destination is not bound to this export.');
    restrictedPdf.registry.register({ ticket: captured.ticket, owner: captured.owner, claim });
    return true;
  });
  async function pickPdf(ev, win, suggestName, captured) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Plot to PDF', defaultPath: String(suggestName || 'Drawing1.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    if (captured) saveOrder?.assertPicked(ev, 'pdf-export', captured);
    registry?.grant(res.filePath);
    return res.filePath;
  }
  // The early renderer ticket stays unbound until it receives this native choice.
  ipcMain.handle('choose-pdf-path', async (ev, suggestName, admission) => {
    const win = senderWindow(ev), captured = saveOrder?.capturePicked(ev, 'pdf-export', admission);
    try { return await pickPdf(ev, win, suggestName, captured); }
    finally { saveOrder?.discard(captured); }
  });
  async function selectedPdf(ev, win, suggestName, options, captured) {
    if (options.path !== undefined) {
      const file = pathPolicy?.writable(options.path, 'save-pdf', /./);
      if (!file || !saveOrder || !captured) throw new Error('The PDF destination is not authorized.');
      saveOrder.assertBound(ev, 'pdf-export', file, captured);
      return file;
    }
    const file = await pickPdf(ev, win, suggestName, captured);
    if (file && saveOrder && captured) await saveOrder.bindPicked(ev, 'pdf-export', file, captured);
    return file;
  }
  /** Keep conversion inside the owner/order operation; every replacement is guarded. */
  async function producePdf(ev, file, captured, producer) {
    if (!saveOrder) { await writeUserFile(file, await producer()); return file; }
    return saveOrder.run(ev, 'pdf-export', file, captured, async (scope) => {
      const pdf = await producer(scope.signal);
      if (scope.signal.aborted) throw cancelled();
      return scope.commit(pdf, (snapshot, target) => enqueueWrite(target.destinationPath, async (key) => {
        if (!(snapshot instanceof Uint8Array) || snapshot.byteLength < 8 || Buffer.from(snapshot.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Invalid PDF payload');
        const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: target.guard } });
        await writer.atomicWriteFile(target.destinationPath, snapshot, { backup: false, root: target.root, expectedDestination: key });
        await target.markCommitted();
        return { path: target.logicalPath, identityPath: target.canonicalPath };
      }));
    });
  }
  /** Plot: the renderer sends a PNG data URL of the sheet; we print it to PDF via a hidden window. */
  ipcMain.handle('plot-pdf', async (ev, dataUrl, suggestName, landscape, sheet, opts) => {
    const win = senderWindow(ev);
    if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Invalid image');
    validatePaperDimensions(sheet); // before the dialog: at most 200 inches a side (E-18)
    const options = exportOptions(opts);
    if (options.restricted !== undefined) throw new Error('Restricted PDF mode is available only for vector PDF output.');
    const captured = options.path !== undefined ? saveOrder?.capture(ev, 'pdf-export', options.admission) : saveOrder?.capturePicked(ev, 'pdf-export', options.admission);
    try {
      const file = await selectedPdf(ev, win, suggestName, options, captured);
      if (!file) return null;
      return await producePdf(ev, file, captured, async (signal) => {
      if (signal?.aborted) throw cancelled();
      const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      const destroy = () => { if (!hidden.isDestroyed?.()) hidden.destroy(); };
      const aborted = () => destroy();
      signal?.addEventListener('abort', aborted, { once: true });
      try {
      secureContents(hidden.webContents);
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
      if (signal?.aborted) throw cancelled();
      return pdf;
      } finally { signal?.removeEventListener('abort', aborted); destroy(); }
      });
    } finally {
      saveOrder?.discard(captured);
    }
  });

  // Track E: vector PLOT output. The renderer builds the PDF (src/io/pdf-vector.ts); this only asks where to save it.
  ipcMain.handle('save-pdf', async (ev, bytes, suggestName, opts) => {
    const win = senderWindow(ev);
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 512 * 1024 * 1024) throw new Error('Invalid PDF payload');
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('Invalid PDF payload');
    const options = exportOptions(opts);
    const captured = options.path !== undefined ? saveOrder?.capture(ev, 'pdf-export', options.admission) : saveOrder?.capturePicked(ev, 'pdf-export', options.admission);
    try {
      const file = await selectedPdf(ev, win, suggestName, options, captured);
      if (!file) return null;
      // A dangling registration with an ordinary save is a mode mix-up: refuse
      // rather than guess which output the user asked for (12.4 binding).
      if (!options.restricted && restrictedPdf && captured && restrictedPdf.registry.has(captured.ticket, captured.owner)) {
        throw new Error('This export was registered as restricted but saved without its restricted claim.');
      }
      return await producePdf(ev, file, captured, async (signal) => {
        const plain = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (!options.restricted) return plain;
        if (!restrictedPdf || !captured) throw new Error('Restricted PDF export is not available.');
        // Consume the single-use registration against the exact received
        // bytes BEFORE transforming; the ciphertext, not the plaintext, is
        // what the save-order scope snapshots and commits.
        restrictedPdf.registry.consume({ ticket: captured.ticket, owner: captured.owner, claim: options.restricted, bytes: plain });
        const encrypted = await restrictedPdf.host.transform(plain, signal ?? undefined);
        if (signal?.aborted) throw cancelled();
        return Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
      });
    } finally { saveOrder?.discard(captured); }
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
    secureContents(hidden.webContents);
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
