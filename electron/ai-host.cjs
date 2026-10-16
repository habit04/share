'use strict';

/**
 * Host-side AI request service (docs/AI-ASSISTANT.md milestone 1,
 * docs/AI-ASSISTANT-M2.md milestone 2). Milestone 2 wires this module
 * through electron/main/ipc-ai.cjs, which registers guarded, sender-scoped
 * IPC channels: ask enqueues a request and renderer aborts cancel its
 * request id. Never register a request-only handler that loses aborts.
 * electron/main.cjs itself requires only ipc-ai.cjs, never this module.
 *
 * Shape follows electron/font-metrics-host.cjs: a pure validator that copies
 * only whitelisted, bounded fields; bounded concurrency; timeout; disposal;
 * usage counters that never contain content or keys.
 *
 * createAiService() owns the live configuration (createAiConfigStore) and
 * the credentials (createAiKeyStore): provider/model/credentials stay
 * host-side, no request leaves the machine before the user explicitly
 * enables Live AI, and key material is never returned to the renderer.
 */

const fs = require('node:fs');
const path = require('node:path');

// Mirrors src/ai/limits.ts — tests pin both sides.
const AI_LIMITS = Object.freeze({
  maxObjects: 200,
  maxSnapshotBytes: 64 * 1024,
  maxQuestionChars: 2000,
  maxAnswerChars: 8000,
  maxReferences: 200,
  maxEnvelopeBytes: 128 * 1024,
  maxKeyChars: 512,
  maxTextChars: 500,
  maxAttributes: 32,
  maxTableCells: 64,
  maxSamplePoints: 16,
  maxOmittedListed: 100,
});

class AiHostError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AiHostError';
    this.kind = kind;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value, max, what) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AiHostError('invalid-request', `Invalid ${what}.`);
  }
  return value;
}

function snapshotString(value, max, what, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new AiHostError('invalid-request', `Invalid snapshot ${what}.`);
  }
  return value;
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot number.');
  }
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiHostError('invalid-request', 'Invalid snapshot count.');
  }
  return value;
}

function point(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid snapshot point.');
  return { x: finite(value.x), y: finite(value.y) };
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new AiHostError('invalid-request', 'Invalid snapshot flag.');
  return value;
}

function list(value, max, copy) {
  if (!Array.isArray(value) || value.length > max) {
    throw new AiHostError('invalid-request', 'Invalid snapshot list.');
  }
  return value.map(copy);
}

const GEOMETRY = Object.freeze({
  line: { a: point, b: point, length: finite },
  circle: { center: point, radius: finite, diameter: finite, circumference: finite, area: finite },
  arc: { center: point, radius: finite, startAngleDeg: finite, endAngleDeg: finite },
  polyline: { vertexCount: count, closed: boolean, vertices: points, length: finite },
  text: { position: point, height: finite, rotationDeg: finite },
  mtext: { position: point, height: finite, width: finite, rotationDeg: finite },
  insert: { block: text, position: point, rotationDeg: finite, scale: finite, scaleY: finite,
    mirror: boolean, columns: count, rows: count, columnSpacing: finite, rowSpacing: finite },
  ellipse: { center: point, majorAxis: point, ratio: finite, startParam: finite, endParam: finite },
  point: { position: point },
  xline: { base: point, direction: point },
  ray: { base: point, direction: point },
  spline: { degree: count, controlPointCount: count, closed: boolean, controlPoints: points },
  hatch: { pattern: text, solid: boolean, loopCount: count, angleDeg: finite, scale: finite },
  leader: { vertexCount: count, vertices: points, arrow: boolean },
  image: { position: point, sizeX: finite, sizeY: finite },
  dimension: { kind: text, p1: point, p2: point, linePoint: point },
  table: { position: point, rows: count, columns: count },
});

function text(value) { return snapshotString(value, AI_LIMITS.maxTextChars, 'text'); }
function points(value) { return list(value, AI_LIMITS.maxSamplePoints, point); }

function snapshotObject(value) {
  if (!isPlainObject(value) || typeof value.type !== 'string'
    || !Object.hasOwn(GEOMETRY, value.type) || !isPlainObject(value.geometry)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot object.');
  }
  const geometry = {};
  for (const [key, copy] of Object.entries(GEOMETRY[value.type])) {
    if (Object.hasOwn(value.geometry, key)) geometry[key] = copy(value.geometry[key]);
  }
  const result = {
    id: snapshotString(value.id, AI_LIMITS.maxSnapshotBytes, 'id', false),
    type: value.type,
    layer: text(value.layer),
    geometry,
  };
  if (value.bounds !== undefined) {
    if (!isPlainObject(value.bounds)) throw new AiHostError('invalid-request', 'Invalid snapshot bounds.');
    result.bounds = { min: point(value.bounds.min), max: point(value.bounds.max) };
  }
  if (value.text !== undefined && ['text', 'mtext', 'leader', 'dimension'].includes(value.type)) result.text = text(value.text);
  if (value.attributes !== undefined && value.type === 'insert') {
    result.attributes = list(value.attributes, AI_LIMITS.maxAttributes, (attribute) => {
      if (!isPlainObject(attribute)) throw new AiHostError('invalid-request', 'Invalid snapshot attribute.');
      return {
        tag: text(attribute.tag), value: text(attribute.value),
        ...(attribute.hidden !== undefined ? { hidden: boolean(attribute.hidden) } : {}),
      };
    });
  }
  if (value.tableText !== undefined && value.type === 'table') result.tableText = list(value.tableText, AI_LIMITS.maxTableCells, text);
  if (value.notes !== undefined) result.notes = list(value.notes, 100, text);
  return result;
}

function copySnapshot(value) {
  if (!isPlainObject(value) || value.kind !== 'jcad.ai.selection-snapshot' || value.version !== 1
    || !isPlainObject(value.units) || !isPlainObject(value.space) || !isPlainObject(value.selection)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot.');
  }
  const units = value.units;
  const space = value.space.kind === 'model' ? { kind: 'model' }
    : value.space.kind === 'layout' ? {
      kind: 'layout', layout: snapshotString(value.space.layout, AI_LIMITS.maxSnapshotBytes, 'layout'),
      ...(value.space.viewport !== undefined ? { viewport: snapshotString(value.space.viewport, AI_LIMITS.maxSnapshotBytes, 'viewport') } : {}),
    } : null;
  if (!space) throw new AiHostError('invalid-request', 'Invalid snapshot space.');
  const objects = list(value.objects, AI_LIMITS.maxObjects, snapshotObject);
  if (new Set(objects.map((object) => object.id)).size !== objects.length) {
    throw new AiHostError('invalid-request', 'Duplicate snapshot object id.');
  }
  const selection = value.selection;
  const total = count(selection.total), included = count(selection.included), omittedCount = count(selection.omittedCount);
  if (included !== objects.length || total - included !== omittedCount) {
    throw new AiHostError('invalid-request', 'Invalid snapshot selection counts.');
  }
  const omitted = list(selection.omitted, AI_LIMITS.maxOmittedListed, (item) => {
    if (!isPlainObject(item) || !['unsupported-object', 'missing-object', 'unsupported-type', 'object-limit', 'byte-limit'].includes(item.reason)) {
      throw new AiHostError('invalid-request', 'Invalid snapshot omission.');
    }
    return { id: snapshotString(item.id, AI_LIMITS.maxSnapshotBytes, 'omitted id'), reason: item.reason };
  });
  if (omitted.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0) > AI_LIMITS.maxSnapshotBytes / 4) {
    throw new AiHostError('invalid-request', 'Snapshot omission metadata exceeds the size limit.');
  }
  if (omitted.length > omittedCount || boolean(selection.omittedListTruncated) !== (omitted.length < omittedCount)) {
    throw new AiHostError('invalid-request', 'Invalid snapshot omissions.');
  }
  return {
    kind: 'jcad.ai.selection-snapshot', version: 1,
    units: { insunits: count(units.insunits), insunitsName: snapshotString(units.insunitsName, 64, 'units'),
      lunits: count(units.lunits), luprec: count(units.luprec), auprec: count(units.auprec) },
    space,
    selection: { total, included, omittedCount, omitted, omittedListTruncated: selection.omittedListTruncated },
    objects,
  };
}

/**
 * Validate an ask envelope from the renderer and return a fresh object with
 * only whitelisted fields, including per-type geometry. The snapshot is
 * rebuilt and re-measured; unrecognised fields never reach the transport.
 * serializedBytes is accounting metadata, never trusted: recompute it over
 * the canonical wire JSON including that field, as the renderer does.
 */
function aiRequest(value) {
  if (!isPlainObject(value)) throw new AiHostError('invalid-request', 'Invalid AI request.');
  let envelopeBytes;
  try {
    envelopeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new AiHostError('invalid-request', 'AI request is not serializable.');
  }
  if (envelopeBytes > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('invalid-request', 'AI request exceeds the size limit.');
  }
  // Integer ids (milestone 1) and string ids (milestone 2: the renderer
  // mints `<page-instance salt>-<counter>`, docs/AI-ASSISTANT-M2.md) are
  // both accepted; the job maps key them as-is, so 5 and '5' are distinct.
  const requestId = value.requestId;
  if (!((Number.isSafeInteger(requestId) && requestId >= 0)
    || (typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/.test(requestId)))) {
    throw new AiHostError('invalid-request', 'Invalid request id.');
  }
  const question = boundedString(value.question, AI_LIMITS.maxQuestionChars, 'question');

  const snapshot = copySnapshot(value.snapshot);
  let snapshotBytes = 0;
  do {
    snapshot.serializedBytes = snapshotBytes;
    snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  } while (snapshot.serializedBytes !== snapshotBytes);
  if (snapshotBytes > AI_LIMITS.maxSnapshotBytes) {
    throw new AiHostError('invalid-request', 'Snapshot exceeds the size limit.');
  }

  const binding = value.binding;
  if (!isPlainObject(binding)
    || !Number.isSafeInteger(binding.sessionId)
    || typeof binding.docId !== 'string' || binding.docId.length > AI_LIMITS.maxEnvelopeBytes
    || !Number.isSafeInteger(binding.contentGeneration)
    || !Number.isSafeInteger(binding.docRevision)
    || !Array.isArray(binding.selectionIds)
    || binding.selectionIds.length > AI_LIMITS.maxEnvelopeBytes
    || binding.selectionIds.some((id) => typeof id !== 'string' || id.length > AI_LIMITS.maxEnvelopeBytes)) {
    throw new AiHostError('invalid-request', 'Invalid request binding.');
  }

  return {
    requestId: value.requestId,
    question,
    snapshot,
    snapshotBytes,
    binding: {
      sessionId: binding.sessionId,
      docId: binding.docId,
      contentGeneration: binding.contentGeneration,
      docRevision: binding.docRevision,
      selectionCount: binding.selectionIds.length,
    },
  };
}

/** Validate a transport answer before it is allowed back to the renderer. */
function aiAnswer(value) {
  if (!isPlainObject(value) || typeof value.text !== 'string' || value.text.length === 0) {
    throw new AiHostError('invalid-answer', 'The provider returned an invalid answer.');
  }
  if (value.text.length > AI_LIMITS.maxAnswerChars) {
    throw new AiHostError('output-too-large', 'The provider answer exceeds the output limit.');
  }
  const references = Array.isArray(value.references)
    ? value.references.slice(0, AI_LIMITS.maxReferences).filter((id) => typeof id === 'string'
      && id.length <= AI_LIMITS.maxSnapshotBytes && Buffer.byteLength(id, 'utf8') <= AI_LIMITS.maxSnapshotBytes)
    : [];
  if (Buffer.byteLength(JSON.stringify({ text: value.text, references }), 'utf8') > AI_LIMITS.maxEnvelopeBytes) {
    throw new AiHostError('output-too-large', 'The provider answer exceeds the output size limit.');
  }
  const result = { text: value.text, references };
  // Provider-reported token usage rides along only as bounded counts;
  // anything malformed is dropped field by field, never trusted.
  if (isPlainObject(value.providerUsage)) {
    const providerUsage = {};
    for (const field of ['inputTokens', 'outputTokens']) {
      const tokens = value.providerUsage[field];
      if (Number.isSafeInteger(tokens) && tokens >= 0) providerUsage[field] = tokens;
    }
    if (Object.keys(providerUsage).length > 0) result.providerUsage = providerUsage;
  }
  return result;
}

/**
 * Create the host service. `transport` is the only provider-specific piece:
 * an async function (validatedRequest, signal) => answer, supplied when a
 * provider is agreed. The transport must abort network/body reads when its
 * signal aborts, and cap provider tokens/body bytes before reading an answer:
 * the usage counters below are not a spend limit. Without one, every ask refuses with
 * 'provider-not-configured' and nothing leaves the machine.
 * @param {{ transport?: (request: object, signal: AbortSignal) => Promise<object>,
 *           timeoutMs?: number, maxConcurrent?: number, maxPending?: number }} [options]
 */
function createAiHost({ transport, timeoutMs = 30000, maxConcurrent = 2, maxPending = 8 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new AiHostError('invalid-request', 'Invalid AI host limits.');
  }
  let active = 0;
  let disposed = false;
  const queue = [];
  const jobs = new Map();
  const usage = {
    requests: 0, failures: 0, timeouts: 0, cancelled: 0,
    inputBytes: 0, outputChars: 0, lastDurationMs: 0,
  };

  function finish(job, error, answer) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    jobs.delete(job.request.requestId);
    const queuedAt = queue.indexOf(job);
    if (queuedAt !== -1) queue.splice(queuedAt, 1);
    if (error) {
      if (error.kind === 'timeout') usage.timeouts += 1;
      else if (error.kind === 'cancelled') usage.cancelled += 1;
      else usage.failures += 1;
      job.reject(error);
    } else {
      usage.outputChars += answer.text.length;
      usage.lastDurationMs = Date.now() - job.started;
      job.resolve({ ...answer, usage: { inputBytes: job.request.snapshotBytes, outputChars: answer.text.length, durationMs: usage.lastDurationMs } });
    }
  }

  function cancel(job, kind = 'cancelled') {
    if (job.settled) return;
    // Settle before aborting: a transport that resolves on abort cannot win.
    finish(job, new AiHostError(kind, kind === 'timeout'
      ? `The provider did not answer within ${timeoutMs} ms.` : 'The AI request was cancelled.'));
    job.controller.abort();
  }

  function pump() {
    while (!disposed && active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      run(job).finally(() => { active -= 1; pump(); });
    }
  }

  async function run(job) {
    try {
      if (job.settled) return;
      // ask() admits jobs only after confirming that transport is configured.
      const invoke = /** @type {NonNullable<typeof transport>} */ (transport);
      const raw = await invoke(job.request, job.controller.signal);
      if (!job.settled) finish(job, null, aiAnswer(raw));
    } catch (cause) {
      finish(job, cause instanceof AiHostError
        ? cause
        : new AiHostError('provider-failure', cause instanceof Error ? cause.message : 'The provider failed.'));
    }
    // The concurrency slot is released only when the underlying transport
    // settles, including after cancellation. Ignoring abort cannot multiply
    // live transports; queued requests still expire on their own timers.
  }

  return {
    // An injected same-process bridge passes its AbortSignal directly. The
    // IPC bridge (electron/main/ipc-ai.cjs) instead translates a renderer
    // abort into cancel(requestId) within the host instance scoped to that
    // guarded sender; signals are not serializable IPC values.
    async ask(value, signal) {
      if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
      if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) throw new AiHostError('invalid-request', 'Invalid cancellation signal.');
      if (signal?.aborted) throw new AiHostError('cancelled', 'The AI request was cancelled.');
      const request = aiRequest(value);
      usage.requests += 1;
      usage.inputBytes += request.snapshotBytes;
      if (typeof transport !== 'function') {
        throw new AiHostError('provider-not-configured', 'No live AI provider has been selected; the AI host is inactive.');
      }
      if (jobs.has(request.requestId)) throw new AiHostError('invalid-request', 'Duplicate AI request id.');
      if (active >= maxConcurrent && queue.length >= maxPending) {
        throw new AiHostError('provider-failure', 'Too many pending AI requests.');
      }
      return new Promise((resolve, reject) => {
        const job = { request, resolve, reject, signal, controller: new AbortController(),
          settled: false, started: Date.now(),
          timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
          onAbort: /** @type {(() => void) | null} */ (null) };
        job.onAbort = () => cancel(job);
        jobs.set(request.requestId, job);
        signal?.addEventListener('abort', job.onAbort, { once: true });
        if (signal?.aborted) { cancel(job); return; }
        job.timer = setTimeout(() => cancel(job, 'timeout'), timeoutMs);
        queue.push(job);
        pump();
      });
    },
    cancel(requestId) {
      const job = jobs.get(requestId);
      if (!job) return false;
      cancel(job);
      return true;
    },
    /** Cancel every outstanding job (queued and running); returns how many. */
    cancelAll() {
      const outstanding = [...jobs.values()];
      for (const job of outstanding) cancel(job);
      return outstanding.length;
    },
    usage: () => ({ ...usage }),
    async dispose() {
      disposed = true;
      for (const job of [...jobs.values()]) cancel(job);
    },
  };
}

const LINUX_KEYRING_BACKENDS = Object.freeze(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/** The one API-key shape rule, shared by the key store and the service. */
function validateApiKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > AI_LIMITS.maxKeyChars
    || /[\u0000-\u001f]/.test(key)) {
    throw new AiHostError('invalid-request', 'Invalid API key.');
  }
  return key;
}

/**
 * API-key store backed by Electron safeStorage (OS-backed encryption:
 * DPAPI / Keychain / libsecret). Stores only ciphertext at `filePath`
 * (a fixed application-data path; registration supplies it). Since
 * milestone 2 the store is wired by electron/main/ipc-ai.cjs, which also
 * injects the fs seams — production writes/deletes go through the app's
 * atomic writer (electron/atomic-write.cjs), so a failed save never
 * destroys the previously stored key. The `fsImpl`-derived defaults keep
 * the milestone-1 behaviour for callers that inject nothing new.
 * The key is host-internal: readKey() exists for the service's transport
 * factory and must never be exposed over IPC. If OS encryption is
 * unavailable the store refuses to persist anything — plaintext fallback
 * is refused, always.
 * @param {{ safeStorage: { isEncryptionAvailable: () => boolean,
 *                          getSelectedStorageBackend?: () => string,
 *                          encryptString: (plain: string) => Buffer,
 *                          decryptString: (cipher: Buffer) => string },
 *           filePath: string, fsImpl?: typeof fs, platform?: string,
 *           writeFileAtomic?: (filePath: string, data: Buffer) => Promise<void>,
 *           readFile?: (filePath: string) => Buffer,
 *           removeFile?: (filePath: string) => Promise<void> | void,
 *           fileExists?: (filePath: string) => boolean }} options
 */
function createAiKeyStore({ safeStorage, filePath, fsImpl = fs, platform = process.platform,
  writeFileAtomic, readFile, removeFile, fileExists }) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new AiHostError('host-unavailable', 'safeStorage is required for the AI key store.');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new AiHostError('host-unavailable', 'The AI key store needs an absolute file path.');
  }
  const writeAtomic = writeFileAtomic ?? (async (target, data) => {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, data, { mode: 0o600 });
  });
  const read = readFile ?? ((target) => fsImpl.readFileSync(target));
  const remove = removeFile ?? ((target) => { fsImpl.unlinkSync(target); });
  const exists = fileExists ?? ((target) => fsImpl.existsSync(target));
  function osEncryptionAvailable() {
    try {
      const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : null;
      return !!safeStorage.isEncryptionAvailable() && (platform !== 'linux'
        || (typeof backend === 'string' && LINUX_KEYRING_BACKENDS.includes(backend)));
    } catch {
      return false;
    }
  }
  function requireOsEncryption() {
    if (!osEncryptionAvailable()) {
      throw new AiHostError('host-unavailable', 'OS-backed encryption is unavailable; refusing to store or read the API key.');
    }
  }
  return {
    /** Whether OS-backed encryption can be used at all; never throws. */
    encryptionAvailable() {
      return osEncryptionAvailable();
    },
    hasKey() {
      return exists(filePath);
    },
    async saveKey(key) {
      validateApiKey(key);
      requireOsEncryption();
      let ciphertext;
      try {
        ciphertext = safeStorage.encryptString(key);
        await writeAtomic(filePath, ciphertext);
      } catch {
        throw new AiHostError('credential-unavailable', 'The API key could not be stored securely.');
      }
    },
    readKey() {
      if (!exists(filePath)) return null;
      requireOsEncryption();
      const ciphertext = read(filePath);
      try {
        return safeStorage.decryptString(ciphertext);
      } catch {
        throw new AiHostError('credential-corrupt', 'The stored API key could not be decrypted. It may be corrupt or from another machine/user. Forget the key and save it again.');
      }
    },
    async clearKey() {
      if (!exists(filePath)) return;
      try {
        await remove(filePath);
      } catch {
        throw new AiHostError('credential-delete-failed', 'The stored API key could not be deleted.');
      }
    },
  };
}

const AI_PROVIDERS = Object.freeze(['openai', 'anthropic']);
const AI_DEFAULT_MODEL = 'gpt-5';
const AI_PROVIDER_DEFAULT_MODELS = Object.freeze({ openai: 'gpt-5', anthropic: 'claude-sonnet-5-5' });
const AI_KEY_PERSISTENCE_MODES = Object.freeze(['session', 'encrypted']);
/** Config JSON is tiny by construction; anything larger on disk is invalid. */
const AI_MAX_CONFIG_BYTES = 4 * 1024;

/** @typedef {'openai' | 'anthropic'} AiProviderId */
/** @typedef {{ model: string, enabled: boolean, keyPersistence: string }} AiProviderEntry */
/** @typedef {{ version: 2, provider: AiProviderId,
 *             providers: { openai: AiProviderEntry, anthropic: AiProviderEntry } }} AiConfig */

/** A model id is a bounded provider token, never a path or URL fragment. */
function validateAiModel(model) {
  return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model);
}

/** @returns {AiConfig} */
function defaultAiConfig() {
  /** @type {AiConfig} */
  const config = {
    version: 2,
    provider: 'openai',
    providers: {
      openai: { model: AI_PROVIDER_DEFAULT_MODELS.openai, enabled: false, keyPersistence: 'session' },
      anthropic: { model: AI_PROVIDER_DEFAULT_MODELS.anthropic, enabled: false, keyPersistence: 'session' },
    },
  };
  return config;
}

/** Deep copy: config values are plain JSON data by construction. */
function cloneAiConfig(config) {
  return /** @type {AiConfig} */ (JSON.parse(JSON.stringify(config)));
}

/**
 * Validate one provider entry field by field: an invalid model falls back
 * to that provider's default, `enabled` counts only when strictly `true`,
 * and an unknown persistence mode falls back to 'session'. A missing or
 * non-object entry yields the provider defaults.
 * @param {AiProviderId} provider
 * @param {any} value
 * @returns {AiProviderEntry}
 */
function parseProviderEntry(provider, value) {
  const source = isPlainObject(value) ? value : {};
  return {
    model: validateAiModel(source.model)
      ? /** @type {string} */ (source.model)
      : AI_PROVIDER_DEFAULT_MODELS[provider],
    enabled: source.enabled === true,
    keyPersistence: AI_KEY_PERSISTENCE_MODES.includes(/** @type {string} */ (source.keyPersistence))
      ? /** @type {string} */ (source.keyPersistence)
      : 'session',
  };
}

/**
 * Validate a parsed config value; returns a clean v2 copy or null. A v1
 * config (the short-lived single-provider shape: top-level
 * model/enabled/keyPersistence) migrates silently — its values become the
 * OpenAI entry and Anthropic starts from defaults.
 * @param {any} value
 * @returns {AiConfig | null}
 */
function parseAiConfig(value) {
  if (!isPlainObject(value)) return null;
  if (value.version === 2) {
    if (!isPlainObject(value.providers)) return null;
    return {
      version: 2,
      provider: AI_PROVIDERS.includes(/** @type {AiProviderId} */ (value.provider))
        ? /** @type {AiProviderId} */ (value.provider)
        : 'openai',
      providers: {
        openai: parseProviderEntry('openai', value.providers.openai),
        anthropic: parseProviderEntry('anthropic', value.providers.anthropic),
      },
    };
  }
  if (value.version === 1) {
    return {
      version: 2,
      provider: 'openai',
      providers: {
        openai: parseProviderEntry('openai', value),
        anthropic: parseProviderEntry('anthropic', null),
      },
    };
  }
  return null;
}

/**
 * Host-authoritative AI connection settings (selected provider plus a
 * per-provider model/enabled/key-persistence entry — never a key),
 * persisted as bounded v2 JSON at a fixed application-data path through
 * injected fs seams. A missing file is the defaults; an unreadable or
 * invalid file falls back to the defaults with a `problem` code
 * ('config-unreadable' / 'config-invalid') so the UI can say so instead
 * of silently misbehaving. A v1 file migrates on load (parseAiConfig).
 * @param {{ filePath: string,
 *           writeFileAtomic: (filePath: string, data: Buffer) => Promise<void>,
 *           readFile: (filePath: string) => Buffer,
 *           fileExists: (filePath: string) => boolean }} options
 */
function createAiConfigStore({ filePath, writeFileAtomic, readFile, fileExists }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || typeof writeFileAtomic !== 'function' || typeof readFile !== 'function'
    || typeof fileExists !== 'function') {
    throw new AiHostError('host-unavailable', 'The AI config store needs an absolute file path and fs seams.');
  }
  /** @type {AiConfig | null} */
  let cache = null;
  return {
    /** Load (or reload) from disk; caches and reports any problem. */
    async load() {
      let problem = null;
      /** @type {AiConfig} */
      let config = defaultAiConfig();
      if (fileExists(filePath)) {
        let raw = null;
        try {
          raw = readFile(filePath);
        } catch {
          problem = 'config-unreadable';
        }
        if (raw !== null) {
          const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (buffer.length >= AI_MAX_CONFIG_BYTES) {
            problem = 'config-invalid';
          } else {
            let parsed;
            try {
              parsed = JSON.parse(buffer.toString('utf8'));
            } catch {
              problem = 'config-unreadable';
            }
            if (problem === null) {
              const valid = parseAiConfig(parsed);
              if (valid) config = valid;
              else problem = 'config-invalid';
            }
          }
        }
      }
      cache = config;
      return { config: cloneAiConfig(config), problem };
    },
    /** The cached config as a deep copy (defaults until load() has run). */
    get() {
      return cloneAiConfig(cache ?? defaultAiConfig());
    },
    /**
     * Merge a validated patch (unknown keys ignored) and persist it.
     * `provider` applies first; model/enabled/keyPersistence then apply
     * to the entry of the provider selected after the patch. The cache
     * changes only after the write succeeds.
     */
    async update(patch) {
      if (!isPlainObject(patch)) throw new AiHostError('invalid-request', 'Invalid AI settings.');
      const next = cloneAiConfig(cache ?? defaultAiConfig());
      if (Object.hasOwn(patch, 'provider')) {
        if (!AI_PROVIDERS.includes(/** @type {AiProviderId} */ (patch.provider))) {
          throw new AiHostError('invalid-request', 'Invalid AI provider.');
        }
        next.provider = /** @type {AiProviderId} */ (patch.provider);
      }
      const entry = next.providers[next.provider];
      if (Object.hasOwn(patch, 'model')) {
        if (!validateAiModel(patch.model)) throw new AiHostError('invalid-request', 'Invalid AI model.');
        entry.model = /** @type {string} */ (patch.model);
      }
      if (Object.hasOwn(patch, 'enabled')) {
        if (typeof patch.enabled !== 'boolean') throw new AiHostError('invalid-request', 'Invalid AI enabled flag.');
        entry.enabled = patch.enabled;
      }
      if (Object.hasOwn(patch, 'keyPersistence')) {
        if (!AI_KEY_PERSISTENCE_MODES.includes(/** @type {string} */ (patch.keyPersistence))) {
          throw new AiHostError('invalid-request', 'Invalid AI key persistence mode.');
        }
        entry.keyPersistence = /** @type {string} */ (patch.keyPersistence);
      }
      try {
        await writeFileAtomic(filePath, Buffer.from(JSON.stringify(next), 'utf8'));
      } catch {
        throw new AiHostError('credential-unavailable', 'The AI settings could not be saved.');
      }
      cache = next;
      return cloneAiConfig(next);
    },
  };
}

const AI_PROBE_TIMEOUT_MS = 15000;

/**
 * A provider transport: answers a validated request, and may carry a
 * `probe` for the connection test.
 * @typedef {((request: object, signal: AbortSignal) => Promise<object>)
 *   & { probe?: (signal: AbortSignal) => Promise<object> }} AiTransportFn
 */

/** Whether a value quacks like a key store (service construction check). */
function isKeyStoreShape(value) {
  return !!value && typeof value.readKey === 'function' && typeof value.saveKey === 'function'
    && typeof value.clearKey === 'function' && typeof value.hasKey === 'function';
}

/**
 * The live AI service: the single owner of connection state. It combines
 * the config store (authoritative selected provider + per-provider
 * entries), one key store per provider (encrypted persistence) plus a
 * per-provider in-memory session key, and a request host it constructs
 * internally with a dispatching transport — the real provider transport
 * is built lazily by `transportFactory` for the selected provider's
 * current model/key and rebuilt whenever that provider's model or key
 * changes. Keys, model/enabled settings and transports are strictly per
 * provider: a provider's key is only ever sent to that provider, and
 * there is no automatic fallback. Nothing here logs or returns key
 * material; cached keys live only in closures of this factory.
 * @param {{ host?: { timeoutMs?: number, maxConcurrent?: number, maxPending?: number },
 *           configStore: ReturnType<typeof createAiConfigStore>,
 *           keyStores: { openai: ReturnType<typeof createAiKeyStore>,
 *                        anthropic: ReturnType<typeof createAiKeyStore> },
 *           transportFactory: (options: { provider: string, model: string, apiKey: string }) =>
 *             AiTransportFn }} options
 */
function createAiService({ host: hostOptions, configStore, keyStores, transportFactory }) {
  if (!configStore || typeof configStore.load !== 'function' || typeof configStore.get !== 'function'
    || typeof configStore.update !== 'function'
    || !keyStores || !isKeyStoreShape(keyStores.openai) || !isKeyStoreShape(keyStores.anthropic)
    || typeof transportFactory !== 'function') {
    throw new AiHostError('host-unavailable', 'The AI service needs a config store, per-provider key stores and a transport factory.');
  }
  /** @type {Record<AiProviderId, string | null>} Session-only keys: memory only, never persisted. */
  const sessionKeys = { openai: null, anthropic: null };
  /** @type {Record<AiProviderId, { transport: AiTransportFn, model: string, key: string } | null>} */
  const transportCaches = { openai: null, anthropic: null };
  /** @type {AbortController | null} */
  let probeController = null;
  /** @type {string | null} */
  let configProblem = null;
  /** @type {Promise<void> | null} */
  let loadPromise = null;

  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(() => configStore.load())
        .then(({ problem }) => { configProblem = problem; });
    }
    return loadPromise;
  }

  /** @returns {AiProviderId} */
  function selectedProvider() {
    return configStore.get().provider;
  }

  /** @param {AiProviderId} provider */
  function entryFor(provider) {
    return configStore.get().providers[provider];
  }

  /** The effective key for a provider, or null. Corrupt stored keys throw. */
  function resolveKey(provider) {
    const session = sessionKeys[provider];
    if (session !== null) return session;
    const store = keyStores[provider];
    if (store.hasKey()) return store.readKey();
    return null;
  }

  function requireKey(provider) {
    const key = resolveKey(provider);
    if (key === null) {
      throw new AiHostError('provider-not-configured', 'No API key is saved for Live AI. Save a key in the AI panel connection settings.');
    }
    return key;
  }

  /** Build (or reuse) a provider's transport for this model + key. */
  function transportFor(provider, model, key) {
    const cached = transportCaches[provider];
    if (cached && cached.model === model && cached.key === key) {
      return cached.transport;
    }
    const transport = transportFactory({ provider, model, apiKey: key });
    if (typeof transport !== 'function') {
      throw new AiHostError('provider-not-configured', 'The selected provider is not available.');
    }
    transportCaches[provider] = { transport, model, key };
    return transport;
  }

  const innerHost = createAiHost({
    ...(isPlainObject(hostOptions) ? hostOptions : {}),
    transport: async (request, signal) => {
      const provider = selectedProvider();
      const key = requireKey(provider);
      return transportFor(provider, entryFor(provider).model, key)(request, signal);
    },
  });

  function cancelAll() {
    if (probeController) probeController.abort();
    return innerHost.cancelAll();
  }

  /**
   * Set (or replace) the selected provider's API key. All outstanding
   * work is cancelled first. On any persistence failure the previously
   * effective key remains in effect.
   * @param {string} key
   * @param {string} persistence  'session' | 'encrypted'
   */
  async function setKey(key, persistence) {
    cancelAll();
    validateApiKey(key);
    if (!AI_KEY_PERSISTENCE_MODES.includes(persistence)) {
      throw new AiHostError('invalid-request', 'Invalid AI key persistence mode.');
    }
    await ensureLoaded();
    const provider = selectedProvider();
    const store = keyStores[provider];
    if (persistence === 'encrypted') {
      // Atomic save: a failure leaves the previously stored key readable
      // and the session key untouched.
      await store.saveKey(key);
      sessionKeys[provider] = null;
      transportCaches[provider] = null;
      await configStore.update({ keyPersistence: 'encrypted' });
    } else {
      const hadStored = store.hasKey();
      let previousStoredKey = null;
      if (hadStored) {
        try { previousStoredKey = store.readKey(); } catch { previousStoredKey = null; }
        await store.clearKey();
      }
      try {
        await configStore.update({ keyPersistence: 'session' });
      } catch (error) {
        // Best effort: put the previous stored key back so the failure
        // leaves the previous key in effect.
        if (previousStoredKey !== null) {
          try { await store.saveKey(previousStoredKey); } catch { /* the original error wins */ }
        }
        throw error;
      }
      sessionKeys[provider] = key;
      transportCaches[provider] = null;
    }
  }

  return {
    /** Connection state for the selected provider; never contains key material. */
    async getState() {
      await ensureLoaded();
      const provider = selectedProvider();
      const entry = entryFor(provider);
      const store = keyStores[provider];
      const session = sessionKeys[provider];
      const stored = store.hasKey();
      return {
        provider,
        providers: [...AI_PROVIDERS],
        model: entry.model,
        enabled: entry.enabled,
        keyPersistence: entry.keyPersistence,
        keyPresent: session !== null || stored,
        keySource: session !== null ? 'session' : stored ? 'stored' : null,
        encryptionAvailable: store.encryptionAvailable(),
        configProblem,
      };
    },

    /**
     * Switch the selected provider. Switching cancels all outstanding
     * work first — there is no automatic fallback, and no answer from
     * the previous provider may outlive the switch. Selecting the
     * already-selected provider is a no-op (no cancel, no write).
     * @param {string} provider
     */
    async setProvider(provider) {
      if (!AI_PROVIDERS.includes(/** @type {AiProviderId} */ (provider))) {
        throw new AiHostError('invalid-request', 'Invalid AI provider.');
      }
      await ensureLoaded();
      if (provider === selectedProvider()) return;
      cancelAll();
      await configStore.update({ provider: /** @type {AiProviderId} */ (provider) });
    },

    /** Set (or replace) the API key; see the inner setKey for semantics. */
    setKey,

    /** Replace the key, keeping the selected provider's persistence mode. */
    async replaceKey(key) {
      await ensureLoaded();
      return setKey(key, entryFor(selectedProvider()).keyPersistence);
    },

    /** Forget the selected provider's key: session copy and stored ciphertext. */
    async forgetKey() {
      cancelAll();
      const provider = selectedProvider();
      sessionKeys[provider] = null;
      transportCaches[provider] = null;
      const store = keyStores[provider];
      if (store.hasKey()) await store.clearKey();
    },

    async setModel(model) {
      if (!validateAiModel(model)) throw new AiHostError('invalid-request', 'Invalid AI model.');
      cancelAll();
      await ensureLoaded();
      await configStore.update({ model });
    },

    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new AiHostError('invalid-request', 'Invalid AI enabled flag.');
      await ensureLoaded();
      if (!enabled) {
        cancelAll();
        await configStore.update({ enabled: false });
        return;
      }
      const provider = selectedProvider();
      if (sessionKeys[provider] === null && !keyStores[provider].hasKey()) {
        throw new AiHostError('provider-not-configured', 'Save an API key before enabling Live AI.');
      }
      await configStore.update({ enabled: true });
    },

    /**
     * Ask a question through the request host, to the selected provider
     * only. Refuses before any transport is built while that provider
     * is disabled or has no key saved.
     */
    async ask(value, signal) {
      await ensureLoaded();
      const provider = selectedProvider();
      if (!entryFor(provider).enabled) {
        throw new AiHostError('live-disabled', 'Live AI is not enabled. Enable it in the AI panel connection settings.');
      }
      requireKey(provider);
      return innerHost.ask(value, signal);
    },

    cancel(requestId) {
      return innerHost.cancel(requestId);
    },

    /** Cancel every outstanding ask and any in-flight connection test. */
    cancelAll,

    usage() {
      return innerHost.usage();
    },

    /**
     * A small canned probe through the selected provider's transport
     * (no drawing content, no host queue). Bounded by a 15 s deadline
     * and aborted by cancelAll()/dispose() like any other work.
     */
    async testConnection() {
      await ensureLoaded();
      const provider = selectedProvider();
      const key = requireKey(provider);
      const model = entryFor(provider).model;
      const transport = transportFor(provider, model, key);
      const probe = transport.probe;
      if (typeof probe !== 'function') {
        throw new AiHostError('provider-not-configured', 'The selected provider cannot run a connection test.');
      }
      const controller = new AbortController();
      probeController = controller;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, AI_PROBE_TIMEOUT_MS);
      const abortRejection = new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new AiHostError(timedOut ? 'timeout' : 'cancelled', timedOut
            ? `The connection test did not answer within ${AI_PROBE_TIMEOUT_MS} ms.`
            : 'The connection test was cancelled.'));
        }, { once: true });
      });
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() => probe(controller.signal)),
          abortRejection,
        ]);
        const result = { model };
        const usage = isPlainObject(raw) ? raw : {};
        const counts = isPlainObject(usage.usage) ? usage.usage : usage;
        for (const field of ['inputTokens', 'outputTokens']) {
          const tokens = counts[field];
          if (Number.isSafeInteger(tokens) && tokens >= 0) result[field] = tokens;
        }
        return result;
      } catch (cause) {
        if (cause instanceof AiHostError) throw cause;
        throw new AiHostError('provider-failure', cause instanceof Error ? cause.message : 'The connection test failed.');
      } finally {
        clearTimeout(timer);
        if (probeController === controller) probeController = null;
      }
    },

    async dispose() {
      cancelAll();
      await innerHost.dispose();
    },
  };
}

module.exports = {
  AI_LIMITS, AiHostError, aiRequest, aiAnswer, createAiHost, createAiKeyStore,
  AI_PROVIDERS, AI_DEFAULT_MODEL, AI_PROVIDER_DEFAULT_MODELS, validateAiModel,
  createAiConfigStore, createAiService,
};
