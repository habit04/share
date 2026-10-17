/**
 * Read-only broker for DXF external references (priority 20.2).
 *
 * This module owns NO authority of its own. It reads only paths the
 * injected `isKnownPath` policy (the main process's path registry:
 * files the user chose, saved to, or that an opened project lists) already
 * makes readable by name, and it checks that policy BEFORE any filesystem
 * contact — before stat, realpath, open, or any UNC/network access. An
 * ungranted path is DENIED, never "missing", and no DXF content, lexical
 * containment, renderer callback or claimed flag can make a path readable
 * here. The broker never grants, registers, writes, or converts anything.
 *
 * Protocol (driven by electron/main/ipc-xrefs.cjs, consumed through the
 * renderer's thin src/app/xref-reader.ts adapter):
 *
 *   beginContext(owner, { docId, contentGeneration, hostAnchor }) -> token
 *   identify(token, path)   -> { ticket, identity { id, owningLocation, version } }
 *   read(token, ticket, maxBytes) -> { text, byteLength, version, rawBytes, rawSha256, encoding }
 *   cancel(token)           -> abort the context's in-flight operations
 *   closeContext(token)     -> cancel + retire the context and its tickets
 *   retireOwner(owner)      -> close every context of one window/owner
 *
 * Contexts and tickets are opaque, main-owned, and bound to the owner
 * (guarded WebContents) that created them; renderer-supplied labels
 * (docId, contentGeneration, host anchor) are captured for binding and
 * diagnostics and grant nothing. Identification tickets keep the native
 * spelling and version in main only: the identity id derives from the
 * native BIGINT device/file identity, never from casefolded strings, and
 * a read is bound to the exact identified version — a replacement,
 * mutation or namespace redirect between identify and read refuses
 * (ERR_XREF_CHANGED) rather than relabelling fresh bytes as the old
 * version. Hard links may share a native id under different owning
 * anchors; both anchors are reported faithfully and the loading core's
 * inconsistent-location refusal decides, here nothing is rewritten.
 *
 * Reads are coherent, following the held-descriptor pattern of
 * electron/main/ipc-drawings.cjs: the existing `readLimitedFile` helper
 * reads through one handle with before/after identity hooks, the path
 * is revalidated after the read, and decoding feeds the ACTUAL ORIGINAL
 * BYTES to the existing `decodeDxf`, so code pages are preserved. The
 * returned `byteLength` is the UTF-8 length of the decoded text (what
 * the loading core charges); raw length, raw SHA-256 and the native
 * version are recorded separately as evidence. Raw and delivered bytes
 * are both bounded by the caller's allowance (which can only lower the
 * 16 MiB ceiling): a code page expansion that would push the decoded
 * text over the allowance refuses atomically — nothing is truncated
 * and no partial result crosses IPC. Transient copies (raw buffer,
 * decoded string, IPC clone) exist by design; the byte ceilings are
 * accounting bounds, not a process-memory cap.
 *
 * Cancellation is main-owned: an AbortSignal cannot cross IPC, so the
 * adapter maps its signal to explicit cancel/close calls and this
 * broker owns the real AbortControllers. Cancel is idempotent and
 * joins cleanup; a completion that arrives after cancel/close is
 * discarded, never accepted.
 */
'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { readLimitedFile } = require('./resource-limits.cjs');
const { absoluteWindowsPath } = require('./windows-path-identity.cjs');

/** Per-file raw ceiling from the brief; the caller's allowance can only lower it. */
const MAX_RAW_BYTES = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_CONTEXTS = 128;
const MAX_CONTEXTS_PER_OWNER = 32;
const MAX_TICKETS_PER_CONTEXT = 256;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

const ERR = {
  argument: (m) => fail('ERR_XREF_ARGUMENT', m),
  path: (m) => fail('ERR_XREF_PATH', m),
  denied: (m) => fail('ERR_XREF_DENIED', m),
  missing: (m) => fail('ERR_XREF_MISSING', m),
  changed: (m) => fail('ERR_XREF_CHANGED', m),
  limit: (m) => fail('ERR_XREF_LIMIT', m),
  context: (m) => fail('ERR_XREF_CONTEXT', m),
  ticket: (m) => fail('ERR_XREF_TICKET', m),
  identity: (m) => fail('ERR_XREF_IDENTITY', m),
  type: (m) => fail('ERR_XREF_TYPE', m),
  decode: (m) => fail('ERR_XREF_DECODE', m),
  cancelled: () => fail('ERR_XREF_CANCELLED', 'the xref operation was cancelled'),
  disposed: () => fail('ERR_XREF_CONTEXT', 'the xref broker is disposed'),
};

/** Map an fs failure onto the broker's taxonomy (after authority has passed). */
function mapFsError(error, path) {
  const code = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return ERR.missing(`no readable file at ${path}`);
  if (code === 'EACCES' || code === 'EPERM') return ERR.denied(`the operating system refused access to ${path}`);
  if (typeof code === 'string' && code.startsWith('ERR_XREF')) return /** @type {Error} */ (error);
  return Object.assign(new Error(`ERR_XREF_READ: could not access ${path}: ${error instanceof Error ? error.message : String(error)}`), { code: 'ERR_XREF_READ', cause: error });
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a renderer-named reference path BEFORE copying it anywhere or
 * touching metadata: field type/length first, then Windows lexical form
 * (absolute drive or UNC; device prefixes, streams/ADS, wildcards and
 * reserved names refused by the shared validator), then the DXF type.
 * Returns the resolved spelling the rest of the broker works with.
 * @param {unknown} raw
 * @returns {string}
 */
function validateReferencePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH || CONTROL_CHARS.test(raw)) {
    throw ERR.path('a bounded absolute DXF path string is required');
  }
  if (!/\.dxf$/i.test(raw)) throw ERR.path('only .dxf references are read by this broker');
  try {
    return absoluteWindowsPath(raw);
  } catch {
    throw ERR.path('relative, drive-relative, device, stream, wildcard or malformed paths are refused before any I/O');
  }
}

/**
 * Validate the captured host anchor label of a context. The anchor is a
 * binding label only — it is never read by the broker — but it must be a
 * well-formed absolute Windows path so contexts cannot be opened with
 * ambiguous anchors.
 * @param {unknown} raw
 * @returns {string}
 */
function validateAnchor(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH || CONTROL_CHARS.test(raw)) {
    throw ERR.argument('a bounded absolute host anchor path is required');
  }
  try {
    return absoluteWindowsPath(raw);
  } catch {
    throw ERR.argument('the host anchor must be an absolute Windows file path');
  }
}

/** Native version evidence from a bigint stat; fails closed without it. */
function versionOf(stat) {
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    if (typeof stat?.[key] !== 'bigint') throw ERR.identity('native bigint file identity is unavailable for this file');
  }
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}
const versionKey = (v) => JSON.stringify([v.dev, v.ino, v.size, v.mtimeNs, v.ctimeNs]);

/**
 * @param {{
 *   fs: { open: Function, stat: Function, realpath: Function },
 *   isKnownPath: (path: string) => boolean,
 *   decodeDxf: (bytes: Buffer) => Promise<{ text: string, encoding?: string }>,
 *   newId?: () => string,
 *   maxRawBytes?: number,
 * }} deps  fs/permission/decoding dependencies, injected for tests
 */
function createXrefReadBroker(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createXrefReadBroker requires injected dependencies');
  const { fs, isKnownPath, decodeDxf } = deps;
  if (!fs || typeof fs.open !== 'function' || typeof fs.stat !== 'function' || typeof fs.realpath !== 'function') throw new TypeError('xref broker requires an fs with open/stat/realpath');
  if (typeof isKnownPath !== 'function') throw new TypeError('xref broker requires an isKnownPath policy');
  if (typeof decodeDxf !== 'function') throw new TypeError('xref broker requires a decodeDxf');
  const newId = typeof deps.newId === 'function' ? deps.newId : () => randomUUID();
  const maxRawBytes = Number.isSafeInteger(deps.maxRawBytes) && /** @type {number} */ (deps.maxRawBytes) > 0 ? /** @type {number} */ (deps.maxRawBytes) : MAX_RAW_BYTES;

  /** @type {Map<string, any>} token -> context */
  const contexts = new Map();
  let disposed = false;

  const throwIfAborted = (signal) => { if (signal?.aborted) throw ERR.cancelled(); };

  /** One context lookup for every operation: unknown, closed and foreign-owned tokens are indistinguishable. */
  function lookup(ownerKey, token) {
    if (disposed) throw ERR.disposed();
    if (typeof ownerKey !== 'string' || !ownerKey || typeof token !== 'string' || !token) throw ERR.context('an unknown xref context');
    const ctx = contexts.get(token);
    if (!ctx || ctx.ownerKey !== ownerKey || ctx.closed) throw ERR.context('an unknown xref context');
    return ctx;
  }

  /** Run fn under a main-owned AbortController registered on the context (cancel/close abort it). */
  async function runOp(ctx, fn) {
    const controller = new AbortController();
    ctx.controllers.add(controller);
    try {
      return await fn(controller.signal);
    } finally {
      ctx.controllers.delete(controller);
    }
  }

  function abortContext(ctx) {
    for (const controller of [...ctx.controllers]) controller.abort();
  }

  /**
   * Open a context bound to one owner plus captured document labels.
   * @param {string} ownerKey  main-derived owner identity (never renderer-chosen)
   * @param {{ docId: unknown, contentGeneration: unknown, hostAnchor: unknown }} info
   */
  function beginContext(ownerKey, info) {
    if (disposed) throw ERR.disposed();
    if (typeof ownerKey !== 'string' || !ownerKey || ownerKey.length > 256) throw ERR.argument('a bounded owner key is required');
    if (!info || typeof info !== 'object') throw ERR.argument('context info is required');
    const docId = info.docId;
    if (typeof docId !== 'string' || !docId || docId.length > 256 || CONTROL_CHARS.test(docId)) throw ERR.argument('a bounded docId label is required');
    const gen = info.contentGeneration;
    const generation = typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0 ? gen
      : typeof gen === 'string' && gen.length > 0 && gen.length <= 64 && !CONTROL_CHARS.test(gen) ? gen : undefined;
    if (generation === undefined) throw ERR.argument('a bounded contentGeneration label is required');
    const hostAnchor = validateAnchor(info.hostAnchor);
    if (contexts.size >= MAX_CONTEXTS) throw ERR.limit(`too many live xref contexts (${MAX_CONTEXTS})`);
    let owned = 0;
    for (const ctx of contexts.values()) if (ctx.ownerKey === ownerKey) owned += 1;
    if (owned >= MAX_CONTEXTS_PER_OWNER) throw ERR.limit(`too many live xref contexts for one owner (${MAX_CONTEXTS_PER_OWNER})`);
    const token = String(newId());
    if (!token || contexts.has(token)) throw ERR.context('context id collision');
    contexts.set(token, {
      token, ownerKey, docId, contentGeneration: generation, hostAnchor,
      /** @type {Map<string, any>} */ tickets: new Map(),
      /** @type {Set<AbortController>} */ controllers: new Set(),
      closed: false,
    });
    return Object.freeze({ token, docId, contentGeneration: generation, hostAnchor });
  }

  /**
   * Identify one reference path inside a context. Authority is checked
   * BEFORE any filesystem contact; native evidence comes from one held
   * descriptor plus path revalidation (the coherent pattern).
   */
  async function identify(ownerKey, token, rawPath) {
    const ctx = lookup(ownerKey, token);
    const path = validateReferencePath(rawPath);
    return runOp(ctx, async (signal) => {
      throwIfAborted(signal);
      if (!isKnownPath(path)) throw ERR.denied(`the path is not readable by name under the existing file policy: ${path}`);
      throwIfAborted(signal);
      let canonicalPath;
      try {
        canonicalPath = await fs.realpath(path);
      } catch (error) {
        throw mapFsError(error, path);
      }
      throwIfAborted(signal);
      let version;
      let handle;
      try {
        handle = await fs.open(path, READ_FLAGS);
        throwIfAborted(signal);
        const held = await handle.stat({ bigint: true });
        if (!held.isFile()) throw ERR.type(`not a regular file: ${path}`);
        version = versionOf(held);
        const key = versionKey(version);
        const onPath = await fs.stat(path, { bigint: true });
        if (!onPath.isFile() || versionKey(versionOf(onPath)) !== key) throw ERR.changed(`the file changed while it was identified: ${path}`);
        if (await fs.realpath(path) !== canonicalPath) throw ERR.changed(`the path was redirected while it was identified: ${path}`);
        throwIfAborted(signal);
      } catch (error) {
        if (error && typeof error === 'object' && typeof (/** @type {{code?: unknown}} */ (error).code) === 'string' && (/** @type {{code: string}} */ (error).code).startsWith('ERR_XREF')) throw error;
        throw mapFsError(error, path);
      } finally {
        if (handle) await handle.close();
      }
      throwIfAborted(signal);
      // Idempotent per (context, path, version): a re-identify of the
      // same snapshot returns the existing ticket instead of spending
      // another slot.
      for (const ticket of ctx.tickets.values()) {
        if (ticket.path === path && ticket.versionKey === versionKey(version)) {
          return Object.freeze({ ticket: ticket.id, identity: ticket.publicIdentity });
        }
      }
      if (ctx.tickets.size >= MAX_TICKETS_PER_CONTEXT) throw ERR.limit(`too many identified files in one context (${MAX_TICKETS_PER_CONTEXT})`);
      const ticketId = String(newId());
      if (!ticketId || ctx.tickets.has(ticketId)) throw ERR.ticket('ticket id collision');
      const publicIdentity = Object.freeze({
        id: `win:${version.dev}:${version.ino}`,
        owningLocation: canonicalPath,
        version: versionKey(version),
      });
      ctx.tickets.set(ticketId, {
        id: ticketId, path, canonicalPath, version, versionKey: versionKey(version), publicIdentity,
      });
      return Object.freeze({ ticket: ticketId, identity: publicIdentity });
    });
  }

  /**
   * Read the exact identified snapshot a ticket names. Permission is
   * rechecked, the read is coherent and version-bound, and both the raw
   * and the decoded (delivered) bytes are bounded by the allowance
   * before anything is returned.
   */
  async function read(ownerKey, token, ticketId, maxBytes) {
    const ctx = lookup(ownerKey, token);
    if (typeof ticketId !== 'string' || !ticketId || ticketId.length > 256) throw ERR.ticket('an unknown xref ticket');
    const ticket = ctx.tickets.get(ticketId);
    if (!ticket) throw ERR.ticket('an unknown xref ticket');
    if (!Number.isSafeInteger(maxBytes) || /** @type {number} */ (maxBytes) < 1) throw ERR.argument('a positive byte allowance is required');
    const allowance = Math.min(/** @type {number} */ (maxBytes), maxRawBytes);
    return runOp(ctx, async (signal) => {
      throwIfAborted(signal);
      if (!isKnownPath(ticket.path)) throw ERR.denied(`the path is no longer readable by name under the existing file policy: ${ticket.path}`);
      const key = ticket.versionKey;
      /** @type {Buffer} */
      let bytes;
      try {
        bytes = /** @type {Buffer} */ (await readLimitedFile(fs, ticket.path, allowance, undefined, {
          async beforeRead(handle) {
            const held = await handle.stat({ bigint: true });
            if (!held.isFile()) throw ERR.type(`not a regular file: ${ticket.path}`);
            if (versionKey(versionOf(held)) !== key) throw ERR.changed(`the file was replaced or changed after identification: ${ticket.path}`);
          },
          async afterRead(handle, content) {
            const held = await handle.stat({ bigint: true });
            if (versionKey(versionOf(held)) !== key || BigInt(content.byteLength) !== BigInt(ticket.version.size)) {
              throw ERR.changed(`the file changed while it was read: ${ticket.path}`);
            }
          },
        }));
      } catch (error) {
        if (error && typeof error === 'object' && typeof (/** @type {{code?: unknown}} */ (error).code) === 'string' && (/** @type {{code: string}} */ (error).code).startsWith('ERR_XREF')) throw error;
        if (error instanceof Error && /larger than/.test(error.message)) throw ERR.limit(`the file exceeds the byte allowance of ${allowance}: ${ticket.path}`);
        if (error instanceof Error && /changed while it was read/.test(error.message)) throw ERR.changed(`the file changed while it was read: ${ticket.path}`);
        throw mapFsError(error, ticket.path);
      }
      throwIfAborted(signal);
      // Post-read path revalidation: the namespace must still name the
      // same native version at the same canonical location.
      try {
        const onPath = await fs.stat(ticket.path, { bigint: true });
        if (!onPath.isFile() || versionKey(versionOf(onPath)) !== key) throw ERR.changed(`the file changed while it was read: ${ticket.path}`);
        if (await fs.realpath(ticket.path) !== ticket.canonicalPath) throw ERR.changed(`the path was redirected while it was read: ${ticket.path}`);
      } catch (error) {
        if (error && typeof error === 'object' && typeof (/** @type {{code?: unknown}} */ (error).code) === 'string' && (/** @type {{code: string}} */ (error).code).startsWith('ERR_XREF')) throw error;
        throw mapFsError(error, ticket.path);
      }
      throwIfAborted(signal);
      let decoded;
      try {
        decoded = await decodeDxf(bytes);
      } catch (error) {
        throw ERR.decode(`the file could not be decoded as DXF: ${ticket.path}`);
      }
      if (!decoded || typeof decoded.text !== 'string') throw ERR.decode(`the decoder returned no text for: ${ticket.path}`);
      const delivered = Buffer.byteLength(decoded.text, 'utf8');
      if (delivered > allowance) {
        // Code page expansion past the allowance refuses atomically:
        // nothing truncated, nothing partial returned.
        throw ERR.limit(`the decoded text (${delivered} bytes as UTF-8) exceeds the byte allowance of ${allowance}: ${ticket.path}`);
      }
      // A completion arriving after cancel/close is never accepted.
      throwIfAborted(signal);
      return Object.freeze({
        text: decoded.text,
        byteLength: delivered,
        version: ticket.versionKey,
        rawBytes: bytes.byteLength,
        rawSha256: createHash('sha256').update(bytes).digest('hex'),
        ...(typeof decoded.encoding === 'string' ? { encoding: decoded.encoding } : {}),
      });
    });
  }

  /** Abort the context's in-flight operations. Idempotent; the context stays open. */
  function cancel(ownerKey, token) {
    let ctx;
    try {
      ctx = lookup(ownerKey, token);
    } catch {
      return false;
    }
    abortContext(ctx);
    return true;
  }

  /** Cancel and retire one context and all its tickets. Idempotent. */
  function closeContext(ownerKey, token) {
    let ctx;
    try {
      ctx = lookup(ownerKey, token);
    } catch {
      return false;
    }
    ctx.closed = true;
    abortContext(ctx);
    ctx.tickets.clear();
    contexts.delete(ctx.token);
    return true;
  }

  /** Retire every context of one owner (window navigation/destruction/quit). */
  function retireOwner(ownerKey) {
    let retired = 0;
    for (const ctx of [...contexts.values()]) {
      if (ctx.ownerKey === ownerKey) {
        ctx.closed = true;
        abortContext(ctx);
        ctx.tickets.clear();
        contexts.delete(ctx.token);
        retired += 1;
      }
    }
    return retired;
  }

  /** Dispose the whole broker (main-process shutdown). */
  function closeAll() {
    disposed = true;
    for (const ctx of [...contexts.values()]) {
      ctx.closed = true;
      abortContext(ctx);
      ctx.tickets.clear();
    }
    contexts.clear();
  }

  return Object.freeze({
    beginContext, identify, read, cancel, closeContext, retireOwner, closeAll,
    /** Live counts, for tests and diagnostics. */
    stats: () => {
      let tickets = 0;
      for (const ctx of contexts.values()) tickets += ctx.tickets.size;
      return { contexts: contexts.size, tickets, disposed };
    },
  });
}

module.exports = {
  createXrefReadBroker,
  MAX_RAW_BYTES, MAX_CONTEXTS, MAX_CONTEXTS_PER_OWNER, MAX_TICKETS_PER_CONTEXT,
  validateReferencePath, validateAnchor,
};
