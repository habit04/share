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
const { createLiveChecksRunner } = require('../ai-live-checks.cjs');
const { createOpenAiTransport } = require('../ai-openai-transport.cjs');
const { createAnthropicTransport } = require('../ai-anthropic-transport.cjs');
const { atomicWriteFile } = require('../atomic-write.cjs');
const { stateDir } = require('./app-data.cjs');

/** Fixed AI state directory under the app data folder. */
function aiDir() {
  return path.join(stateDir(), 'ai');
}

/**
 * @typedef {object} AiRuntimeOverrides
 * @property {object} [safeStorage]  Electron safeStorage (tests inject a fake)
 * @property {(url: string, init: object) => Promise<object>} [fetchImpl]
 * @property {string} [dir]  AI state directory (defaults to <userData>/ai)
 * @property {(filePath: string, data: Buffer) => Promise<void>} [writeFileAtomic]
 * @property {object} [app]  Electron app (lifecycle hooks; registerAiIpc only)
 */

/**
 * Build the production AI service over real Electron/OS dependencies.
 * `overrides` exists for tests (fake safeStorage/fetch/base dir/writer);
 * production passes nothing and Electron values are read lazily so this
 * module can be required outside an app context.
 * @param {AiRuntimeOverrides} [overrides]
 */
function createAiRuntime(overrides = {}) {
  const dir = overrides.dir ?? aiDir();
  const writeFileAtomic = overrides.writeFileAtomic
    ?? (async (target, data) => {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicWriteFile(target, data);
    });
  const readBounded = (target) => {
    const max = path.basename(target) === 'config.json' ? 4096 : 8192;
    const fd = fs.openSync(target, 'r');
    try {
      if (fs.fstatSync(fd).size > max) throw new Error('AI state exceeds its size limit.');
      const buffer = Buffer.alloc(max + 1);
      let length = 0, bytes;
      while ((bytes = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
      if (length > max) throw new Error('AI state exceeds its size limit.');
      return buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
  };
  const seams = {
    writeFileAtomic,
    readFile: readBounded,
    removeFile: (target) => { fs.unlinkSync(target); },
    fileExists: (target) => fs.existsSync(target),
  };
  const safeStorage = /** @type {any} */ (overrides.safeStorage ?? require('electron').safeStorage);
  // One key store per provider, at its own fixed path: a provider's key
  // is stored, loaded and sent only for that provider.
  const keyStores = {
    openai: createAiKeyStore({ safeStorage, filePath: path.join(dir, 'openai-key.bin'), ...seams }),
    anthropic: createAiKeyStore({ safeStorage, filePath: path.join(dir, 'anthropic-key.bin'), ...seams }),
  };
  const configStore = createAiConfigStore({
    filePath: path.join(dir, 'config.json'),
    ...seams,
  });
  const fetchImpl = overrides.fetchImpl ?? ((url, init) => /** @type {any} */ (globalThis.fetch)(url, init));
  const service = createAiService({
    configStore,
    keyStores,
    transportFactory: ({ provider, model, apiKey }) => (provider === 'anthropic'
      ? createAnthropicTransport({ apiKey, model, fetchImpl: /** @type {any} */ (fetchImpl) })
      : createOpenAiTransport({ apiKey, model, fetchImpl: /** @type {any} */ (fetchImpl) })),
  });
  return { service, keyStores, configStore, dir };
}

/** Map any failure to the bounded IPC error payload. */
function errorPayload(cause) {
  if (cause instanceof AiHostError) {
    // The transport attaches a bounded retryAfterSeconds to its errors.
    const retry = /** @type {AiHostError & { retryAfterSeconds?: unknown }} */ (cause).retryAfterSeconds;
    return {
      kind: cause.kind,
      message: String(cause.message).slice(0, 1024),
      ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 && retry <= 3600 ? { retryAfterSeconds: retry } : {}),
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
 * @param {AiRuntimeOverrides} [overrides]
 */
function registerAiIpc(ctx, overrides = {}) {
  const { ipcMain } = ctx;
  const { service } = createAiRuntime(overrides);
  const liveChecks = createLiveChecksRunner(service);
  const state = async () => ({ state: await service.getState() });
  const requests = new Map();
  const probes = new Set();
  const liveCheckRuns = new Set();
  const observed = new WeakSet();
  const owner = (ev) => ({ sender: ev?.sender, processId: ev?.senderFrame?.processId, routingId: ev?.senderFrame?.routingId });
  const sameOwner = (a, b) => a.sender === b.sender && a.processId === b.processId && a.routingId === b.routingId;
  function observe(contents) {
    if (!contents || observed.has(contents)) return;
    observed.add(contents);
    const revoke = () => {
      for (const record of [...requests.values(), ...probes, ...liveCheckRuns]) if (record.owner.sender === contents) record.abort.abort();
    };
    contents.once('destroyed', revoke);
    contents.on('render-process-gone', revoke);
    contents.on('did-start-navigation', (_event, _url, sameDocument, mainFrame) => {
      if (mainFrame && !sameDocument) revoke();
    });
  }

  ipcMain.handle('ai-get-state', respond(state));
  ipcMain.handle('ai-set-provider', respond(async (_ev, provider) => {
    await service.setProvider(provider);
    return state();
  }));
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
  ipcMain.handle('ai-test-connection', respond(async (ev) => {
    if (probes.size >= 16) throw new AiHostError('provider-failure', 'Too many pending AI connection tests.');
    const record = { owner: owner(ev), abort: new AbortController() };
    observe(record.owner.sender);
    probes.add(record);
    try { return { probe: await service.testConnection(record.abort.signal) }; } finally { probes.delete(record); }
  }));
  ipcMain.handle('ai-ask', respond(async (ev, request) => {
    const requestId = request?.requestId;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || requests.has(requestId)) {
      throw new AiHostError('invalid-request', 'Invalid or duplicate AI request id.');
    }
    if (requests.size >= 16) throw new AiHostError('provider-failure', 'Too many pending AI requests.');
    const record = { owner: owner(ev), abort: new AbortController() };
    observe(record.owner.sender);
    requests.set(requestId, record); // Own cancellation before service initialization can await.
    try { return { answer: await service.ask(request, record.abort.signal) }; } finally { requests.delete(requestId); }
  }));
  ipcMain.handle('ai-draft', respond(async (ev, request) => {
    const requestId = request?.requestId;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || requests.has(requestId)) {
      throw new AiHostError('invalid-request', 'Invalid or duplicate AI request id.');
    }
    if (requests.size >= 16) throw new AiHostError('provider-failure', 'Too many pending AI requests.');
    const record = { owner: owner(ev), abort: new AbortController() };
    observe(record.owner.sender);
    // Drafts share the ask request map: ids are unique across both, and
    // ai-cancel / lifecycle revocation cover drafts with no extra path.
    requests.set(requestId, record); // Own cancellation before service initialization can await.
    try { return { draft: await service.draft(request, record.abort.signal) }; } finally { requests.delete(requestId); }
  }));
  ipcMain.handle('ai-draft-refine', respond(async (ev, request) => {
    const requestId = request?.requestId;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || requests.has(requestId)) {
      throw new AiHostError('invalid-request', 'Invalid or duplicate AI request id.');
    }
    if (requests.size >= 16) throw new AiHostError('provider-failure', 'Too many pending AI requests.');
    const record = { owner: owner(ev), abort: new AbortController() };
    observe(record.owner.sender);
    // Refinements share the ask/draft request map: ids are unique across
    // all three kinds, and ai-cancel / lifecycle revocation cover
    // refinements with no extra path.
    requests.set(requestId, record); // Own cancellation before service initialization can await.
    try { return { draft: await service.refine(request, record.abort.signal) }; } finally { requests.delete(requestId); }
  }));
  ipcMain.handle('ai-live-checks-run', respond(async (ev) => {
    // No payload: a run is the fixed, unparameterisable check sequence
    // against the destination the host state already reports
    // (docs/AI-LIVE-CHECKS.md). The run record joins the same
    // owner-lifecycle revocation as requests and probes, and is
    // installed before the run can await anything.
    const record = { owner: owner(ev), abort: new AbortController() };
    observe(record.owner.sender);
    liveCheckRuns.add(record); // Own cancellation before the run starts.
    try { return { report: await liveChecks.run(record.abort.signal) }; } finally { liveCheckRuns.delete(record); }
  }));
  ipcMain.handle('ai-live-checks-cancel', respond(async (ev) => {
    // Consults the live-checks run registry — not the ask/draft
    // request map — owner-checked exactly like ai-cancel.
    const mine = owner(ev);
    for (const record of liveCheckRuns) {
      if (!sameOwner(record.owner, mine)) continue;
      record.abort.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }));
  ipcMain.handle('ai-cancel', respond(async (ev, requestId) => {
    const record = requests.get(requestId);
    if (!record || !sameOwner(record.owner, owner(ev))) return { cancelled: false };
    record.abort.abort();
    return { cancelled: true };
  }));
  ipcMain.handle('ai-usage', respond(async () => ({ usage: service.usage() })));

  // Renderer lifecycle: when the app window's contents are destroyed or
  // the renderer process goes away (close, reload crash), no AI work may
  // outlive it. Cancelling is sender-checked against the live window.
  const app = overrides.app ?? require('electron').app;
  if (app && typeof app.on === 'function') {
    app.on('web-contents-created', (_event, contents) => observe(contents));
    app.on('will-quit', () => { void service.dispose().catch(() => {}); });
  }
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) observe(ctx.mainWindow.webContents);

  return { service };
}

module.exports = { registerAiIpc, createAiRuntime };
