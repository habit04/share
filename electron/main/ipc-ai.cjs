'use strict';

/**
 * AI Assistant IPC registration (milestone 2, docs/AI-ASSISTANT-M2.md).
 *
 * Registers the guarded `ai-*` channels on the shared MainContext. The
 * guard (electron/ipc-guard.cjs) has already rejected any caller that is
 * not the application window's main frame before these handlers run.
 *
 * Configuration and credentials are authoritative here, in the main
 * process: the config store and key store live under a fixed
 * `<userData>/ai/` directory; the key is held by the service and never
 * returned over IPC (state carries `keyPresent` only). Every handler
 * resolves a bounded result value — `{ ok: true, … }` or
 * `{ ok: false, error: { kind, message, retryAfterSeconds? } }` —
 * because Electron does not preserve custom error properties; the
 * renderer reconstructs typed errors from `kind` (src/ai/host-bridge.ts).
 *
 * Cancellation: renderer aborts arrive on `ai-cancel` with the request
 * id. All queued/running work is also cancelled when the app renderer is
 * destroyed or its process goes away, on configuration/credential
 * changes (inside the service), and on quit (dispose, like the other
 * hosts).
 */

const fs = require('node:fs');
const path = require('node:path');
const { AiHostError, createAiConfigStore, createAiKeyStore, createAiService } = require('../ai-host.cjs');
const { createOpenAiTransport } = require('../ai-openai-transport.cjs');
const { atomicWriteFile } = require('../atomic-write.cjs');
const { stateDir } = require('./app-data.cjs');

/** Fixed AI state directory under the app data folder. */
function aiDir() {
  return path.join(stateDir(), 'ai');
}

/**
 * Build the production AI service over real Electron/OS dependencies.
 * `overrides` exists for tests (fake safeStorage/fetch/base dir/writer);
 * production passes nothing and Electron values are read lazily so this
 * module can be required outside an app context.
 * @param {{ safeStorage?: object, fetchImpl?: Function, dir?: string,
 *           writeFileAtomic?: Function }} [overrides]
 */
function createAiRuntime(overrides = {}) {
  const dir = overrides.dir ?? aiDir();
  fs.mkdirSync(dir, { recursive: true });
  const writeFileAtomic = overrides.writeFileAtomic
    ?? ((target, data) => atomicWriteFile(target, data));
  const seams = {
    writeFileAtomic,
    readFile: (target) => fs.readFileSync(target),
    removeFile: (target) => { fs.unlinkSync(target); },
    fileExists: (target) => fs.existsSync(target),
  };
  const safeStorage = overrides.safeStorage ?? require('electron').safeStorage;
  const keyStore = createAiKeyStore({
    safeStorage,
    filePath: path.join(dir, 'openai-key.bin'),
    ...seams,
  });
  const configStore = createAiConfigStore({
    filePath: path.join(dir, 'config.json'),
    ...seams,
  });
  const fetchImpl = overrides.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const service = createAiService({
    configStore,
    keyStore,
    transportFactory: ({ model, apiKey }) => createOpenAiTransport({ apiKey, model, fetchImpl }),
  });
  return { service, keyStore, configStore, dir };
}

/** Map any failure to the bounded IPC error payload. */
function errorPayload(cause) {
  if (cause instanceof AiHostError) {
    return {
      kind: cause.kind,
      message: cause.message,
      ...(typeof cause.retryAfterSeconds === 'number' ? { retryAfterSeconds: cause.retryAfterSeconds } : {}),
    };
  }
  // Unexpected failures get a fixed message: internal detail, provider
  // bodies and stack text never cross IPC.
  return { kind: 'provider-failure', message: 'The AI host failed.' };
}

/** Wrap a handler body so expected failures resolve as result values. */
function respond(fn) {
  return async (...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (cause) {
      return { ok: false, error: errorPayload(cause) };
    }
  };
}

/**
 * Register the AI channels on the guarded context. Returns the runtime
 * for the caller's lifecycle management (and for tests).
 * @param {import('./context.cjs').MainContext} ctx
 * @param {{ safeStorage?: object, fetchImpl?: Function, dir?: string,
 *           writeFileAtomic?: Function, app?: object }} [overrides]
 */
function registerAiIpc(ctx, overrides = {}) {
  const { ipcMain } = ctx;
  const { service } = createAiRuntime(overrides);
  const state = async () => ({ state: await service.getState() });

  ipcMain.handle('ai-get-state', respond(state));
  ipcMain.handle('ai-set-model', respond(async (_ev, model) => {
    await service.setModel(model);
    return state();
  }));
  ipcMain.handle('ai-set-key', respond(async (_ev, key, persistence) => {
    await service.setKey(key, persistence);
    return state();
  }));
  ipcMain.handle('ai-forget-key', respond(async () => {
    await service.forgetKey();
    return state();
  }));
  ipcMain.handle('ai-set-enabled', respond(async (_ev, enabled) => {
    await service.setEnabled(enabled);
    return state();
  }));
  ipcMain.handle('ai-test-connection', respond(async () => ({ probe: await service.testConnection() })));
  ipcMain.handle('ai-ask', respond(async (_ev, request) => ({ answer: await service.ask(request) })));
  ipcMain.handle('ai-cancel', respond(async (_ev, requestId) => ({ cancelled: service.cancel(requestId) })));
  ipcMain.handle('ai-usage', respond(async () => ({ usage: service.usage() })));

  // Renderer lifecycle: when the app window's contents are destroyed or
  // the renderer process goes away (close, reload crash), no AI work may
  // outlive it. Cancelling is sender-checked against the live window.
  const app = overrides.app ?? require('electron').app;
  if (app && typeof app.on === 'function') {
    app.on('web-contents-created', (_event, contents) => {
      const cancelIfAppRenderer = () => {
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()
          && ctx.mainWindow.webContents === contents) service.cancelAll();
      };
      contents.once('destroyed', cancelIfAppRenderer);
      contents.on('render-process-gone', cancelIfAppRenderer);
    });
    app.on('will-quit', () => { void service.dispose(); });
  }

  return { service };
}

module.exports = { registerAiIpc, createAiRuntime };
