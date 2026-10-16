/** Guarded Windows save tickets belong to one live main-frame document. */
'use strict';
const { createWindowsPathIdentity, absoluteWindowsPath, asciiCaseFold } = require('../windows-path-identity.cjs');
const { createSaveAdmissions } = require('../save-admissions.cjs');
const { createOpenedSourceProofs } = require('../opened-source-proofs.cjs');

// Electron does not transport arbitrary Error.code properties. Keep the code in its message
// so existing file-error guidance still identifies confinement, cancellation and stale saves.
function transportError(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  if (error?.committed === true) {
    const detail = `${code ? `${code}: ` : ''}${typeof error.message === 'string' ? error.message : 'The completed save could not be verified.'}`;
    return Object.assign(new Error(`ERR_SAVE_COMMITTED: A file replacement occurred, but the completed save could not be verified. Check the destination before saving again. ${detail}`), { code: 'ERR_SAVE_COMMITTED', committed: true, cause: error });
  }
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
  const identity = createWindowsPathIdentity(), admissions = createSaveAdmissions({ identity, authorize });
  const sourceProofs = createOpenedSourceProofs();
  /** @type {WeakMap<Electron.WebContents,object>} */ const owners = new WeakMap();
  const watched = new WeakSet();
  const captures = new WeakSet();
  const pickedBindings = new WeakSet();
  const readCaptures = new WeakSet();
  /** @type {Map<string,{owner:object,proof?:string}>} */ const sourceBinds = new Map();
  /** @type {WeakMap<object,Map<string,{path:string,identityPath:string,openedSourceProof?:string}>>} */ const receipts = new WeakMap();
  function owner(ev) {
    const win = senderWindow(ev), contents = win.webContents;
    if (contents.isDestroyed()) throw new Error('The saving document is closed.');
    if (!watched.has(contents)) {
      watched.add(contents);
      const retire = () => {
        const previous = owners.get(contents);
        if (previous) { admissions.retireOwner(previous); sourceProofs.retireOwner(previous); receipts.delete(previous); ctx.restrictedPdf?.registry.retireOwner(previous); }
        for (const [ticket, source] of sourceBinds) if (source.owner === previous) sourceBinds.delete(ticket);
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
  ipcMain.handle('bind-save-admission', async (ev, ticket, kind, file, source) => {
    try {
      const current = owner(ev);
      if (sourceBinds.has(ticket)) throw Object.assign(new Error('This source admission is already bound.'), { code: 'ERR_SAVE_TICKET' });
      if (source === undefined) {
        const pin = await admissions.bind(ticket, current, kind, file, {
          validateSource: target => sourceProofs.assertUnprotectedDestination(current, target),
        });
        return { identityPath: pin.canonicalPath, exists: pin.exists };
      }
      if (kind !== 'drawing' || !source || typeof source !== 'object' || !['in-place', 'save-as'].includes(source.mode)
        || source.proof !== null && typeof source.proof !== 'string' || source.path !== null && typeof source.path !== 'string') throw Object.assign(new Error('A valid opened drawing source context is required.'), { code: 'ERR_OPENED_SOURCE_CONTEXT' });
      const sourcePath = source.path === null ? null : absoluteWindowsPath(source.path);
      const lease = source.proof === null ? undefined : sourceProofs.borrow(current, source.proof);
      let reservation;
      try { reservation = sourceProofs.reserve(current, file, lease, source.mode); }
      catch (error) { if (lease) sourceProofs.releaseBorrow(lease); throw error; }
      /** @type {{owner:object,proof?:string}} */ const context = { owner: current };
      sourceBinds.set(ticket, context);
      /** @type {'source'|'copy'} */ let relation = 'copy';
      const cleanup = () => {
        sourceProofs.cancelReservation(reservation, current);
        if (lease) sourceProofs.releaseBorrow(lease);
        if (!context.proof) sourceBinds.delete(ticket);
      };
      try {
        const pin = await admissions.bind(ticket, current, kind, file, {
          async validateSource(target) {
            if (lease) { relation = sourceProofs.validateDestination(lease, current, target, source.mode); return; }
            if (sourcePath === null) {
              if (source.mode !== 'save-as') throw Object.assign(new Error('An unsaved drawing requires a chosen destination.'), { code: 'ERR_OPENED_SOURCE_CONTEXT' });
              sourceProofs.assertUnprotectedDestination(current, target);
              return;
            }
            const refuse = () => Object.assign(new Error('The original opened version is unavailable. Preserve this drawing with Save As to a new separate file, or reopen the original.'), { code: 'ERR_OPENED_SOURCE_PROOF' });
            if (source.mode === 'in-place' || asciiCaseFold(target.logicalPath) === asciiCaseFold(sourcePath)) throw refuse();
            const permission = await authorize(current, kind, sourcePath);
            if (permission.allowed) {
              const original = await identity.captureWriteTarget(sourcePath, permission.root);
              if (original.canonicalPath === target.canonicalPath || original.fileVersion && target.fileVersion && original.fileVersion.dev === target.fileVersion.dev && original.fileVersion.ino === target.fileVersion.ino) throw refuse();
            } else if (target.exists) throw refuse();
            sourceProofs.assertUnprotectedDestination(current, target);
          },
          onVerifiedCommit(evidence) { context.proof = sourceProofs.completeCommit(reservation, current, evidence, relation); },
          onFinish: cleanup,
        });
        return { identityPath: pin.canonicalPath, exists: pin.exists };
      } catch (error) { cleanup(); sourceBinds.delete(ticket); throw error; }
    }
    catch (error) { throw transportError(error); }
  });
  ipcMain.handle('release-opened-source-proof', (ev, proof) => sourceProofs.release(proof, owner(ev)));

  /** Capture the original main document before a picker/read can await. */
  function captureRead(ev) { const captured = Object.freeze({ owner: owner(ev) }); readCaptures.add(captured); return captured; }
  function readOwner(ev, captured) {
    if (!captured || !readCaptures.has(captured) || owner(ev) !== captured.owner) throw Object.assign(new Error('The original opening document is no longer active.'), { code: 'ERR_OPENED_SOURCE_RETIRED' });
    return captured.owner;
  }
  function reserveRead(ev, captured, file) {
    try { return sourceProofs.reserve(readOwner(ev, captured), file); } catch (error) { throw transportError(error); }
  }
  function completeRead(ev, captured, reservation, evidence) {
    try { return sourceProofs.completeRead(reservation, readOwner(ev, captured), evidence); } catch (error) { throw transportError(error); }
  }
  function cancelRead(captured, reservation) { if (captured && readCaptures.has(captured) && reservation) sourceProofs.cancelReservation(reservation, captured.owner); }
  function releaseRead(ev, proof) { return sourceProofs.release(proof, owner(ev)); }
  ipcMain.handle('cancel-save-admission', async (ev, ticket, kind) => {
    try {
      if (kind === 'text-export' || kind === 'pdf-export') await admissions.cancelJoined(ticket, owner(ev), kind);
      else admissions.cancel(ticket, owner(ev), kind);
    } catch (error) { throw transportError(error); }
    finally {
      // A cancelled PDF export retires its restricted-PDF registration with
      // it (12.4 corrections): the record must never outlive the admission.
      if (kind === 'pdf-export') { try { ctx.restrictedPdf?.registry.cancel(ticket, owner(ev)); } catch { /* already retired */ } }
    }
  });
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
    if (!captured || !captures.has(captured)) return;
    // Any discarded capture retires its restricted-PDF registration, even
    // for renderer-owned (non-implicit) tickets whose admission retires
    // through cancel-save-admission instead (12.4 corrections). Cancelling
    // an already-consumed registration is a no-op.
    try { ctx.restrictedPdf?.registry.cancel(captured.ticket, captured.owner); } catch { /* Already consumed/retired. */ }
    if (!captured.implicit) return;
    try { admissions.cancel(captured.ticket, captured.owner, captured.kind); } catch { /* Already consumed/retired. */ }
  }
  function currentCapture(ev, kind, ticket) {
    const captured = ticket && typeof ticket === 'object' && captures.has(ticket) ? ticket : capture(ev, kind, ticket);
    if (captured.kind !== kind || owner(ev) !== captured.owner) throw Object.assign(new Error('ERR_SAVE_CANCELLED: the original saving document is no longer active.'), { code: 'ERR_SAVE_CANCELLED' });
    return captured;
  }
  function assertCurrent(ev, captured) { currentCapture(ev, captured.kind, captured); }
  /** Native selection is caller-owned. No renderer path can acquire a grant here. */
  function capturePicked(ev, kind, ticket = undefined) {
    if (kind !== 'text-export' && kind !== 'pdf-export') throw transportError(Object.assign(new Error('A supported generic export kind is required.'), { code: 'ERR_SAVE_TICKET' }));
    const captured = capture(ev, kind, ticket);
    try { admissions.assertIssued(captured.ticket, captured.owner, kind); return captured; }
    catch (error) { discard(captured); throw transportError(error); }
  }
  function pickedCapture(ev, kind, captured) {
    if (!captured || typeof captured !== 'object' || !captures.has(captured)) throw Object.assign(new Error('A main-owned export capture is required.'), { code: 'ERR_SAVE_TICKET' });
    return currentCapture(ev, kind, captured);
  }
  /** Recheck an issued private capture after a native dialog and before granting its result.
   * Also supports existing project captures, without changing their save kind.
   */
  function assertPicked(ev, kind, capture) {
    try {
      const captured = pickedCapture(ev, kind, capture);
      admissions.assertIssued(captured.ticket, captured.owner, kind);
    } catch (error) { throw transportError(error); }
  }
  /** Picked paths must already have the native dialog's main-owned grant. */
  async function bindPicked(ev, kind, file, capture) {
    let captured;
    try {
      captured = pickedCapture(ev, kind, capture);
      if (kind !== 'text-export' && kind !== 'pdf-export') throw Object.assign(new Error('A supported generic export kind is required.'), { code: 'ERR_SAVE_TICKET' });
      admissions.assertIssued(captured.ticket, captured.owner, kind);
      const pin = await admissions.bind(captured.ticket, captured.owner, kind, absoluteWindowsPath(file), {
        validateSource: target => sourceProofs.assertUnprotectedDestination(captured.owner, target),
      });
      pickedBindings.add(captured);
      return Object.freeze({ identityPath: pin.canonicalPath, exists: pin.exists });
    } catch (error) { discard(captured); throw transportError(error); }
  }
  /** Assert supplied modern tickets without inspecting files or running a producer. */
  function assertBound(ev, kind, file, capture) {
    try {
      const captured = pickedCapture(ev, kind, capture);
      return admissions.assertBound(captured.ticket, captured.owner, kind, file);
    } catch (error) { throw transportError(error); }
  }
  async function admitPicked(ev, kind, file, capture, operation) {
    try { await bindPicked(ev, kind, file, capture); return await run(ev, kind, file, capture, operation); }
    finally { discard(capture); }
  }
  /** Supplied tickets must already be bound; compatibility calls receive an order before conversion. */
  async function run(ev, kind, file, ticket, operation) {
    let captured;
    try {
      captured = currentCapture(ev, kind, ticket);
      if (captured.implicit && !pickedBindings.has(captured)) await admissions.bind(captured.ticket, captured.owner, kind, file, {
        validateSource: target => sourceProofs.assertUnprotectedDestination(captured.owner, target),
      });
      const result = await admissions.run(captured.ticket, captured.owner, kind, file, operation);
      if (result.status === 'stale') throw Object.assign(new Error('ERR_SAVE_STALE: a newer save already reached this file. The older snapshot was not written.'), { code: 'ERR_SAVE_STALE' });
      const written = receiptOf(result.writeResult);
      if (written) {
        let saved = receipts.get(captured.owner);
        if (!saved) { saved = new Map(); receipts.set(captured.owner, saved); }
        if (saved.size >= 64) {
          const oldest = saved.keys().next().value;
          if (oldest !== undefined) { const prior = saved.get(oldest); if (prior?.openedSourceProof) sourceProofs.release(prior.openedSourceProof, captured.owner); saved.delete(oldest); }
        }
        const source = sourceBinds.get(captured.ticket);
        saved.set(captured.ticket, Object.freeze({ path: written.path, identityPath: written.identityPath, ...(source?.proof ? { openedSourceProof: source.proof } : {}) }));
        sourceBinds.delete(captured.ticket);
        return written.path;
      }
      return result.value;
    } catch (error) {
      const source = captured && sourceBinds.get(captured.ticket);
      if (source?.proof) { try { sourceProofs.release(source.proof, source.owner); } catch { /* Owner retirement already removed it. */ } }
      if (captured) sourceBinds.delete(captured.ticket);
      throw transportError(error);
    } finally { discard(captured); }
  }
  async function prepare(ev, kind, file, ticket, operation) {
    const captured = currentCapture(ev, kind, ticket);
    try {
      if (captured.implicit && !pickedBindings.has(captured)) await admissions.bind(captured.ticket, captured.owner, kind, file, {
        validateSource: target => sourceProofs.assertUnprotectedDestination(captured.owner, target),
      });
      const result = await admissions.prepare(captured.ticket, captured.owner, kind, file, operation);
      if (result.status === 'stale') throw Object.assign(new Error('ERR_SAVE_STALE: a newer save already reached this file; its backup is kept.'), { code: 'ERR_SAVE_STALE' });
      return result.value;
    } catch (error) { throw transportError(error); }
    finally { discard(captured); }
  }
  return Object.freeze({ capture, discard, assertCurrent, capturePicked, assertPicked, bindPicked, admitPicked, assertBound, captureRead, reserveRead, completeRead, cancelRead, releaseRead, run, prepare, readBatch,
    stats: () => Object.freeze({ ...admissions.stats(), openedSources: sourceProofs.stats() }) });
}
module.exports = { registerSaveOrder };
