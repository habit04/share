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
 * When a provider is agreed, the lead registers exactly one guarded channel:
 *   ipcMain.handle('ai-ask', (_ev, request) => aiHost.ask(request))
 * with a transport that reads its key from createAiKeyStore() and never
 * returns key material to the renderer.
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
});

class AiHostError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AiHostError';
    this.kind = kind;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value, max, what) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AiHostError('invalid-request', `Invalid ${what}.`);
  }
  return value;
}

/**
 * Validate an ask envelope from the renderer and return a fresh object with
 * only whitelisted fields. The snapshot is JSON data; it is re-measured and
 * deep-copied through JSON so no getters, prototypes or shared references
 * cross the boundary. Drawing text inside the snapshot stays inert data.
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
  if (!Number.isInteger(value.requestId) || value.requestId < 0) {
    throw new AiHostError('invalid-request', 'Invalid request id.');
  }
  const question = boundedString(value.question, AI_LIMITS.maxQuestionChars, 'question');

  const snapshot = value.snapshot;
  if (!isPlainObject(snapshot) || snapshot.kind !== 'jcad.ai.selection-snapshot' || snapshot.version !== 1) {
    throw new AiHostError('invalid-request', 'Invalid snapshot.');
  }
  if (!Array.isArray(snapshot.objects) || snapshot.objects.length > AI_LIMITS.maxObjects) {
    throw new AiHostError('invalid-request', 'Invalid snapshot objects.');
  }
  for (const obj of snapshot.objects) {
    if (!isPlainObject(obj)
      || typeof obj.id !== 'string' || obj.id.length > 256
      || typeof obj.type !== 'string' || obj.type.length > 64
      || typeof obj.layer !== 'string' || obj.layer.length > 256) {
      throw new AiHostError('invalid-request', 'Invalid snapshot object.');
    }
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (snapshotBytes > AI_LIMITS.maxSnapshotBytes) {
    throw new AiHostError('invalid-request', 'Snapshot exceeds the size limit.');
  }
  const snapshotCopy = JSON.parse(JSON.stringify(snapshot));

  const binding = value.binding;
  if (!isPlainObject(binding)
    || !Number.isInteger(binding.sessionId)
    || typeof binding.docId !== 'string' || binding.docId.length > 128
    || !Number.isInteger(binding.contentGeneration)
    || !Number.isInteger(binding.docRevision)
    || !Array.isArray(binding.selectionIds)
    || binding.selectionIds.length > AI_LIMITS.maxObjects + 1000
    || binding.selectionIds.some((id) => typeof id !== 'string' || id.length > 256)) {
    throw new AiHostError('invalid-request', 'Invalid request binding.');
  }

  return {
    requestId: value.requestId,
    question,
    snapshot: snapshotCopy,
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
    ? value.references.filter((id) => typeof id === 'string' && id.length <= 256).slice(0, AI_LIMITS.maxReferences)
    : [];
  return { text: value.text, references };
}

/**
 * Create the host service. `transport` is the only provider-specific piece:
 * an async function (validatedRequest, signal) => answer, supplied when a
 * provider is agreed. Without one, every ask refuses with
 * 'provider-not-configured' and nothing leaves the machine.
 */
function createAiHost({ transport, timeoutMs = 30000, maxConcurrent = 2, maxPending = 8 } = {}) {
  let active = 0;
  let disposed = false;
  const queue = [];
  const running = new Set();
  const usage = {
    requests: 0, failures: 0, timeouts: 0, cancelled: 0,
    inputBytes: 0, outputChars: 0, lastDurationMs: 0,
  };

  function pump() {
    while (!disposed && active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      run(job).finally(() => { active -= 1; pump(); });
    }
  }

  async function run(job) {
    const started = Date.now();
    const controller = new AbortController();
    job.controller = controller;
    job.abortKind = null;
    running.add(job);
    const timer = setTimeout(() => { job.abortKind = 'timeout'; controller.abort(); }, timeoutMs);
    // Race the transport against the abort so a transport that resolves
    // late (or on abort) can never turn a timeout/disposal into a success.
    const aborted = new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(job.abortKind === 'timeout'
          ? new AiHostError('timeout', `The provider did not answer within ${timeoutMs} ms.`)
          : new AiHostError('cancelled', 'The AI request was cancelled.'));
      }, { once: true });
    });
    try {
      const raw = await Promise.race([transport(job.request, controller.signal), aborted]);
      const answer = aiAnswer(raw);
      usage.outputChars += answer.text.length;
      usage.lastDurationMs = Date.now() - started;
      job.resolve({ ...answer, usage: { inputBytes: job.request.snapshotBytes, outputChars: answer.text.length, durationMs: usage.lastDurationMs } });
    } catch (cause) {
      if (cause instanceof AiHostError && cause.kind === 'timeout') usage.timeouts += 1;
      else if (cause instanceof AiHostError && cause.kind === 'cancelled') usage.cancelled += 1;
      else usage.failures += 1;
      job.reject(cause instanceof AiHostError
        ? cause
        : new AiHostError('provider-failure', cause instanceof Error ? cause.message : 'The provider failed.'));
    } finally {
      clearTimeout(timer);
      running.delete(job);
    }
  }

  return {
    async ask(value) {
      if (disposed) throw new AiHostError('disposed', 'The AI host has been disposed.');
      const request = aiRequest(value);
      usage.requests += 1;
      usage.inputBytes += request.snapshotBytes;
      if (typeof transport !== 'function') {
        throw new AiHostError('provider-not-configured', 'No live AI provider has been selected; the AI host is inactive.');
      }
      if (queue.length >= maxPending) {
        throw new AiHostError('provider-failure', 'Too many pending AI requests.');
      }
      return new Promise((resolve, reject) => {
        queue.push({ request, resolve, reject });
        pump();
      });
    },
    usage: () => ({ ...usage }),
    async dispose() {
      disposed = true;
      while (queue.length > 0) {
        const job = queue.shift();
        usage.cancelled += 1;
        job.reject(new AiHostError('cancelled', 'The AI host was disposed.'));
      }
      for (const job of [...running]) {
        job.abortKind = 'disposed';
        job.controller.abort();
      }
    },
  };
}

/**
 * API-key store backed by Electron safeStorage (OS-backed encryption:
 * DPAPI / Keychain / libsecret). Stores only ciphertext at `filePath`.
 * The key is host-internal: readKey() exists for the transport factory and
 * must never be exposed over IPC. If OS encryption is unavailable the
 * store refuses to persist anything.
 */
function createAiKeyStore({ safeStorage, filePath, fsImpl = fs } = {}) {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new AiHostError('host-unavailable', 'safeStorage is required for the AI key store.');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new AiHostError('host-unavailable', 'The AI key store needs an absolute file path.');
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
      if (!safeStorage.isEncryptionAvailable()) {
        throw new AiHostError('host-unavailable', 'OS-backed encryption is unavailable; refusing to store the API key.');
      }
      const ciphertext = safeStorage.encryptString(key);
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(filePath, ciphertext, { mode: 0o600 });
    },
    readKey() {
      if (!fsImpl.existsSync(filePath)) return null;
      const ciphertext = fsImpl.readFileSync(filePath);
      return safeStorage.decryptString(ciphertext);
    },
    clearKey() {
      if (fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath);
    },
  };
}

module.exports = { AI_LIMITS, AiHostError, aiRequest, aiAnswer, createAiHost, createAiKeyStore };
