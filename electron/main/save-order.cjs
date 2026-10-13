/** Guarded Windows save tickets belong to one live main-frame document. */
'use strict';
const { createWindowsPathIdentity } = require('../windows-path-identity.cjs');
const { createSaveAdmissions } = require('../save-admissions.cjs');

// Electron does not transport arbitrary Error.code properties. Keep the code in its message
// so existing file-error guidance still identifies confinement, cancellation and stale saves.
function transportError(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  if (!code || typeof error.message !== 'string' || error.message.startsWith(`${code}:`)) return error;
  return Object.assign(new Error(`${code}: ${error.message}`), { code, committed: error.committed, cause: error });
}
/** @param {unknown} value */
function receiptOf(value) {
  if (!value || typeof value !== 'object' || !('path' in value) || !('identityPath' in value) || typeof value.path !== 'string' || typeof value.identityPath !== 'string') return null;
  return Object.freeze({ path: value.path, identityPath: value.identityPath });
}

/**
 * @param {import('./context.cjs').MainContext} ctx
 * @param {(owner:object,kind:string,path:string)=>import('../save-admissions.cjs').Authorization|Promise<import('../save-admissions.cjs').Authorization>} authorize
 */
function registerSaveOrder(ctx, authorize) {
  const { ipcMain, senderWindow } = ctx;
  const admissions = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize });
  /** @type {WeakMap<Electron.WebContents,object>} */ const owners = new WeakMap();
  const watched = new WeakSet();
  const captures = new WeakSet();
  /** @type {WeakMap<object,Map<string,{path:string,identityPath:string}>>} */ const receipts = new WeakMap();
  function owner(ev) {
    const win = senderWindow(ev), contents = win.webContents;
    if (contents.isDestroyed()) throw new Error('The saving document is closed.');
    if (!watched.has(contents)) {
      watched.add(contents);
      const retire = () => {
        const previous = owners.get(contents);
        if (previous) { admissions.retireOwner(previous); receipts.delete(previous); }
        owners.delete(contents);
      };
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retire(); });
      contents.on('render-process-gone', retire);
      contents.once('destroyed', retire);
      win.once('closed', retire);
    }
    let current = owners.get(contents);
    if (!current) { current = Object.freeze({ contents }); owners.set(contents, current); }
    return current;
  }
  ipcMain.handle('issue-save-admission', (ev, kind) => admissions.issue(owner(ev), kind));
  ipcMain.handle('bind-save-admission', async (ev, ticket, kind, file) => {
    try {
      const pin = await admissions.bind(ticket, owner(ev), kind, file);
      return { identityPath: pin.canonicalPath, exists: pin.exists };
    }
    catch (error) { throw transportError(error); }
  });
  ipcMain.handle('cancel-save-admission', (ev, ticket, kind) => { admissions.cancel(ticket, owner(ev), kind); });
  ipcMain.handle('save-admission-result', (ev, ticket) => {
    const saved = receipts.get(owner(ev));
    if (typeof ticket !== 'string' || !saved?.has(ticket)) return null;
    const receipt = saved.get(ticket); saved.delete(ticket); return receipt;
  });
  ipcMain.handle('issue-project-save-batch', (ev) => admissions.issueProjectBatch(owner(ev)));
  ipcMain.handle('bind-project-save-batch', async (ev, batch, paths) => {
    try {
      // Batch children may read/write only DXFs. Reject the whole list before native inspection.
      if (!Array.isArray(paths) || paths.length > 512 || paths.some(file => typeof file !== 'string' || !/\.dxf$/i.test(file))) throw Object.assign(new Error('A bounded list of project DXF paths is required.'), { code: 'ERR_SAVE_BATCH_PATHS' });
      return await admissions.bindProjectBatch(batch, owner(ev), paths);
    } catch (error) { throw transportError(error); }
  });
  ipcMain.handle('seal-project-save-batch', async (ev, batch, children) => {
    try { await admissions.sealProjectBatch(batch, owner(ev), children); }
    catch (error) { throw transportError(error); }
  });
  ipcMain.handle('begin-project-save-batch-commit', async (ev, batch, children) => {
    try { await admissions.beginProjectBatchCommit(batch, owner(ev), children); }
    catch (error) { throw transportError(error); }
  });
  ipcMain.handle('cancel-project-save-batch', async (ev, batch) => {
    try { await admissions.cancelProjectBatch(batch, owner(ev)); }
    catch (error) { throw transportError(error); }
  });
  /** @param {(scope:import('../save-admissions.cjs').ProjectBatchReadScope)=>Promise<unknown>} operation */
  async function readBatch(ev, batch, child, operation) {
    try { return await admissions.readProjectBatch(batch, owner(ev), child, operation); }
    catch (error) { throw transportError(error); }
  }
  function capture(ev, kind, ticket) {
    const current = owner(ev), implicit = ticket === undefined;
    const captured = Object.freeze({ owner: current, kind, ticket: implicit ? admissions.issue(current, kind) : ticket, implicit });
    captures.add(captured); return captured;
  }
  function discard(captured) {
    if (!captured || !captures.has(captured) || !captured.implicit) return;
    try { admissions.cancel(captured.ticket, captured.owner, captured.kind); } catch { /* Already consumed/retired. */ }
  }
  function currentCapture(ev, kind, ticket) {
    const captured = ticket && typeof ticket === 'object' && captures.has(ticket) ? ticket : capture(ev, kind, ticket);
    if (captured.kind !== kind || owner(ev) !== captured.owner) throw Object.assign(new Error('ERR_SAVE_CANCELLED: the original saving document is no longer active.'), { code: 'ERR_SAVE_CANCELLED' });
    return captured;
  }
  function assertCurrent(ev, captured) { currentCapture(ev, captured.kind, captured); }
  /** Supplied tickets must already be bound; compatibility calls receive an order before conversion. */
  async function run(ev, kind, file, ticket, operation) {
    let captured;
    try {
      captured = currentCapture(ev, kind, ticket);
      if (captured.implicit) await admissions.bind(captured.ticket, captured.owner, kind, file);
      const result = await admissions.run(captured.ticket, captured.owner, kind, file, operation);
      if (result.status === 'stale') throw Object.assign(new Error('ERR_SAVE_STALE: a newer save already reached this file. The older snapshot was not written.'), { code: 'ERR_SAVE_STALE' });
      const written = receiptOf(result.writeResult);
      if (written) {
        let saved = receipts.get(captured.owner);
        if (!saved) { saved = new Map(); receipts.set(captured.owner, saved); }
        if (saved.size >= 64) { const oldest = saved.keys().next().value; if (oldest !== undefined) saved.delete(oldest); }
        saved.set(captured.ticket, Object.freeze({ path: written.path, identityPath: written.identityPath }));
        return written.path;
      }
      return result.value;
    } catch (error) {
      throw transportError(error);
    } finally { discard(captured); }
  }
  async function prepare(ev, kind, file, ticket, operation) {
    const captured = currentCapture(ev, kind, ticket);
    try {
      if (captured.implicit) await admissions.bind(captured.ticket, captured.owner, kind, file);
      const result = await admissions.prepare(captured.ticket, captured.owner, kind, file, operation);
      if (result.status === 'stale') throw Object.assign(new Error('ERR_SAVE_STALE: a newer save already reached this file; its backup is kept.'), { code: 'ERR_SAVE_STALE' });
      return result.value;
    } catch (error) { throw transportError(error); }
    finally { discard(captured); }
  }
  return Object.freeze({ capture, discard, assertCurrent, run, prepare, readBatch, stats: admissions.stats });
}
module.exports = { registerSaveOrder };
