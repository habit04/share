/**
 * IPC for the read-only DXF xref broker (priority 20.2): begin-context,
 * identify, read, cancel, close-context.
 *
 * This module is the ONLY bridge between the renderer and
 * electron/xref-read.cjs. It adds no authority: the broker reads just
 * the paths the path registry already makes readable by name, checked
 * in main before any filesystem contact, and this layer never calls
 * registry.grant / grantDerived / registerProject. Contexts are bound
 * to the sending WebContents (its id is the broker's owner key), and a
 * sender's navigation or destruction retires its contexts and tickets,
 * so a tab can never spend another tab's capabilities and a reloaded
 * page starts with none. Renderer-supplied labels (docId,
 * contentGeneration, host anchor) are captured by the broker for
 * binding; they grant nothing.
 *
 * Handlers are registered through the guarded ipcMain from the main
 * context only (never Electron's own), like every module under
 * electron/main/. Errors cross IPC as the broker's coded messages
 * ("ERR_XREF_*: ..."); the renderer adapter maps them back to codes.
 * Disposal closes every context and refuses later calls.
 */
'use strict';

/** @typedef {import('./context.cjs').MainContext} MainContext */

/**
 * @param {MainContext} ctx
 * @param {{ fs?: object, decodeDxf?: (bytes: Buffer) => Promise<{ text: string, encoding?: string }>, broker?: object }} [deps]  injected in tests
 * @returns {{ dispose: () => void }}
 */
function registerXrefIpc(ctx, deps = {}) {
  const { ipcMain, registry, rejections } = ctx;
  const broker = deps.broker ?? require('../xref-read.cjs').createXrefReadBroker({
    fs: deps.fs ?? require('node:fs/promises'),
    isKnownPath: (p) => registry.isKnown(p),
    decodeDxf: deps.decodeDxf ?? require('./dwg.cjs').decodeDxf,
  });

  /** Senders already hooked for lifecycle retirement (by object identity). */
  const hooked = new WeakSet();

  /**
   * The broker owner key for one IPC event, hooking the sender's
   * lifecycle on first sight: navigation or destruction retires every
   * context the sender owns.
   * @param {any} ev
   */
  function ownerOf(ev) {
    const sender = ev?.sender;
    if (!sender || typeof sender.id !== 'number') throw new Error('ERR_XREF_CONTEXT: an identified sender is required');
    const ownerKey = `wc:${sender.id}`;
    if (!hooked.has(sender)) {
      hooked.add(sender);
      const retire = () => { broker.retireOwner(ownerKey); };
      sender.on?.('destroyed', retire);
      sender.on?.('did-navigate', retire);
    }
    return ownerKey;
  }

  /** Log a broker refusal in the shared rejection log, then rethrow for IPC transport. */
  function refuse(what, error) {
    const code = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined;
    if (typeof code === 'string' && code.startsWith('ERR_XREF')) {
      rejections.reject(what, `${code}: ${String(/** @type {Error} */ (error).message).slice(0, 300)}`);
    }
    throw error;
  }

  ipcMain.handle('xref-begin-context', async (ev, info) => {
    const owner = ownerOf(ev);
    try {
      return broker.beginContext(owner, info);
    } catch (error) {
      return refuse('xref-begin-context', error);
    }
  });

  ipcMain.handle('xref-identify', async (ev, token, path) => {
    const owner = ownerOf(ev);
    try {
      return await broker.identify(owner, token, path);
    } catch (error) {
      return refuse('xref-identify', error);
    }
  });

  ipcMain.handle('xref-read', async (ev, token, ticket, maxBytes) => {
    const owner = ownerOf(ev);
    try {
      return await broker.read(owner, token, ticket, maxBytes);
    } catch (error) {
      return refuse('xref-read', error);
    }
  });

  ipcMain.handle('xref-cancel', async (ev, token) => {
    const owner = ownerOf(ev);
    return broker.cancel(owner, token);
  });

  ipcMain.handle('xref-close-context', async (ev, token) => {
    const owner = ownerOf(ev);
    return broker.closeContext(owner, token);
  });

  // A host tab closed: retire every context the SENDER owns for that
  // document. The owner key comes from the event, never from renderer
  // data, so a sender can only retire its own WebContents' contexts.
  ipcMain.handle('xref-retire-doc-contexts', async (ev, docId) => {
    const owner = ownerOf(ev);
    try {
      return Object.freeze({ retired: broker.retireDoc(owner, docId) });
    } catch (error) {
      return refuse('xref-retire-doc-contexts', error);
    }
  });

  let disposed = false;
  return {
    /** Close every context and refuse later work (app shutdown). Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      broker.closeAll();
    },
  };
}

module.exports = { registerXrefIpc };
