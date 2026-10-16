'use strict';

/**
 * Host-side AI request service — INACTIVE in this milestone
 * (docs/AI-ASSISTANT.md). This module is deliberately NOT required by
 * electron/main.cjs and its channel is NOT exposed by electron/preload.cjs:
 * no live provider, endpoint, credentials or data handling has been agreed.
 * It is delivered now so the eventual live adapter is separately reviewable.
 *
 * Shape follows electron/font-metrics-host.cjs: a pure validator that copies
 * only whitelisted, bounded fields; bounded concurrency; timeout; disposal;
 * usage counters that never contain content or keys.
 *
 * When a provider is agreed, the lead supplies a guarded, sender-scoped
 * request/cancel bridge: ask enqueues a request and renderer aborts cancel
 * its request id. Never register a request-only handler that loses aborts.
 * Its transport reads keys from createAiKeyStore() and never returns key
 * material to the renderer. No bridge is registered in this milestone.
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
  if (!Number.isSafeInteger(value.requestId) || value.requestId < 0) {
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
  return { text: value.text, references };
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
    // An injected same-process bridge passes its AbortSignal directly. A
    // future IPC bridge must instead translate abort into cancel(requestId)
    // within a host instance scoped to that guarded sender; signals are not
    // serializable IPC values. No IPC channel is registered in this milestone.
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
    usage: () => ({ ...usage }),
    async dispose() {
      disposed = true;
      for (const job of [...jobs.values()]) cancel(job);
    },
  };
}

/**
 * API-key store backed by Electron safeStorage (OS-backed encryption:
 * DPAPI / Keychain / libsecret). Stores only ciphertext at `filePath`.
 * The key is host-internal: readKey() exists for the transport factory and
 * must never be exposed over IPC. If OS encryption is unavailable the
 * store refuses to persist anything.
 * @param {{ safeStorage: { isEncryptionAvailable: () => boolean,
 *                          getSelectedStorageBackend?: () => string,
 *                          encryptString: (plain: string) => Buffer,
 *                          decryptString: (cipher: Buffer) => string },
 *           filePath: string, fsImpl?: typeof fs, platform?: string }} options
 */
function createAiKeyStore({ safeStorage, filePath, fsImpl = fs, platform = process.platform }) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new AiHostError('host-unavailable', 'safeStorage is required for the AI key store.');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new AiHostError('host-unavailable', 'The AI key store needs an absolute file path.');
  }
  function requireOsEncryption() {
    const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : null;
    if (!safeStorage.isEncryptionAvailable() || (platform === 'linux'
      && (typeof backend !== 'string' || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)))) {
      throw new AiHostError('host-unavailable', 'OS-backed encryption is unavailable; refusing to store or read the API key.');
    }
  }
  return {
    hasKey() {
      return fsImpl.existsSync(filePath);
    },
    saveKey(key) {
      if (typeof key !== 'string' || key.length === 0 || key.length > AI_LIMITS.maxKeyChars
        || /[\u0000-\u001f]/.test(key)) {
        throw new AiHostError('invalid-request', 'Invalid API key.');
      }
      requireOsEncryption();
      const ciphertext = safeStorage.encryptString(key);
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(filePath, ciphertext, { mode: 0o600 });
    },
    readKey() {
      if (!fsImpl.existsSync(filePath)) return null;
      requireOsEncryption();
      const ciphertext = fsImpl.readFileSync(filePath);
      return safeStorage.decryptString(ciphertext);
    },
    clearKey() {
      if (fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath);
    },
  };
}

module.exports = { AI_LIMITS, AiHostError, aiRequest, aiAnswer, createAiHost, createAiKeyStore };
