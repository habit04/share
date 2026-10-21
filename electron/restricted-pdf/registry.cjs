/**
 * Restricted-PDF job registrations (milestone 12.4, spike §7 binding).
 *
 * A restricted export is a two-step, single-use binding owned by main:
 *
 *   1. register(ticket, owner, claim): the renderer names the destination it
 *      already bound through the save-admission flow (the IPC handler checks
 *      the ticket is bound to that destination for this sender), the exact
 *      SHA-256 + length of the frozen plaintext buffer it is about to send,
 *      and the font requests of the preview/print faces it says the plot
 *      used. Every claimed face is checked against the font host's own
 *      admission records — main must have admitted that face as
 *      preview/print itself, recently, or registration refuses. The claim
 *      must be non-empty: a restricted job with no preview/print face is a
 *      contradiction and the renderer exports ordinarily instead.
 *   2. consume(ticket, owner, claim, bytes): at save time the received bytes
 *      are hashed and compared with the registered digest + length, and the
 *      save call's own restricted claim must match the registration. The
 *      record is deleted either way (single use), so a registration can
 *      never be replayed against another buffer, ticket, or capture.
 *
 * What this does and does not prove — stated plainly because the design
 * depends on it: the binding prevents ACCIDENTAL cross-mode and
 * cross-capture reuse (a stale buffer, a mode-off retry, a mixed-up ticket
 * cannot silently become a restricted file, and an ordinary save carrying a
 * dangling registration is refused). It cannot prove a renderer discarded
 * font bytes it legitimately received during the plot — a compromised
 * renderer could retain them. That residual trust is inherent to the
 * current architecture (font programs cross to the renderer for the writer)
 * and is documented in docs/PDF-FONT-EMBEDDING.md; nothing here claims
 * stronger main-side enforcement than this.
 *
 * Retirement (corrections round): a registration must not outlive the
 * export that created it. cancel() retires one record (owner-bound, like
 * every other operation here), retireOwner() retires everything an owner
 * holds, retireAll() empties the registry. They are wired to admission
 * cancellation/discard, to renderer/owner retirement, and to host
 * disposal — a cancelled export can therefore never leave a record behind
 * that a later write could consume, and repeated register-then-cancel
 * cycles cannot exhaust the registry the way TTL-only expiry allowed.
 */
'use strict';
const { createHash } = require('node:crypto');
const { fontRequest, fontRecordKey } = require('../font-metrics-host.cjs');

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_FACES = 8;

/**
 * @param {{ fontHost: { admittedPreviewPrint(value: unknown): boolean }, ttlMs?: number, maxRecords?: number }} options
 */
function createRestrictedPdfRegistry({ fontHost, ttlMs = 10 * 60 * 1000, maxRecords = 64 }) {
  if (!fontHost || typeof fontHost.admittedPreviewPrint !== 'function') throw new Error('A font metrics host is required.');
  /** @type {Map<string, { owner: object, sha256: string, byteLength: number, faceKeys: Set<string>, expires: number }>} */
  const records = new Map();
  const fail = (message) => new Error(`Restricted PDF: ${message}`);
  const prune = (nowMs) => {
    for (const [ticket, record] of records) if (record.expires <= nowMs) records.delete(ticket);
  };

  /**
   * @param {{ ticket: unknown, owner: unknown, claim: unknown }} input
   * @returns {true}
   */
  function register({ ticket, owner, claim }) {
    if (typeof ticket !== 'string' || !ticket || !owner || typeof owner !== 'object') throw fail('an owned save ticket is required');
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw fail('an invalid registration claim');
    const { sha256, byteLength, faces } = /** @type {any} */ (claim);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw fail('an invalid document digest');
    if (!Number.isInteger(byteLength) || byteLength < 8 || byteLength > MAX_INPUT_BYTES) throw fail('an invalid document length');
    if (!Array.isArray(faces) || faces.length < 1 || faces.length > MAX_FACES) throw fail('a restricted job must name between one and eight preview/print faces');
    const faceKeys = new Set();
    for (const face of faces) {
      let request;
      try { request = fontRequest(face); } catch { throw fail('an invalid preview/print face claim'); }
      // Mode proof from main's own records: the face must be one this host
      // admitted as preview/print under a restricted read. Anything else is
      // a claim main cannot back, and registration refuses.
      if (!fontHost.admittedPreviewPrint(request)) throw fail('a claimed preview/print face was not admitted by the font host');
      faceKeys.add(fontRecordKey(request));
    }
    if (faceKeys.size !== faces.length) throw fail('duplicate preview/print face claims');
    const nowMs = Date.now();
    prune(nowMs);
    if (records.has(ticket)) throw fail('this save ticket already has a restricted registration');
    if (records.size >= maxRecords) throw fail('too many restricted registrations are outstanding');
    records.set(ticket, { owner, sha256, byteLength, faceKeys, expires: nowMs + ttlMs });
    return true;
  }

  /** Whether a live registration exists for this ticket+owner (mode-mismatch checks). */
  function has(ticket, owner) {
    const record = typeof ticket === 'string' ? records.get(ticket) : undefined;
    return !!record && record.owner === owner && record.expires > Date.now();
  }

  /**
   * Single-use check at save time. Deletes the record on ANY outcome.
   * @param {{ ticket: unknown, owner: unknown, claim: unknown, bytes: Uint8Array }} input
   * @returns {true}
   */
  function consume({ ticket, owner, claim, bytes }) {
    const record = typeof ticket === 'string' ? records.get(ticket) : undefined;
    if (typeof ticket === 'string') records.delete(ticket);
    if (!record || record.owner !== owner || record.expires <= Date.now()) throw fail('no live restricted registration matches this export');
    if (!claim || typeof claim !== 'object' || /** @type {any} */ (claim).sha256 !== record.sha256 || /** @type {any} */ (claim).byteLength !== record.byteLength) {
      throw fail('the save claim does not match the restricted registration');
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== record.byteLength) throw fail('the document length does not match the restricted registration');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== record.sha256) throw fail('the document digest does not match the restricted registration');
    return true;
  }

  /**
   * Retire one live registration without consuming it. Owner-bound: a
   * wrong owner (or an unknown/expired ticket) removes nothing. Returns
   * whether a record was removed. A retired registration can never
   * authorize a later write: consume() finds no live record.
   */
  function cancel(ticket, owner) {
    const record = typeof ticket === 'string' ? records.get(ticket) : undefined;
    if (!record || record.owner !== owner || record.expires <= Date.now()) return false;
    records.delete(/** @type {string} */ (ticket));
    return true;
  }

  /** Retire every live registration belonging to one owner; returns how many were removed. */
  function retireOwner(owner) {
    let removed = 0;
    for (const [ticket, record] of records) {
      if (record.owner === owner) { records.delete(ticket); removed += 1; }
    }
    return removed;
  }

  /** Retire all live registrations (host disposal / shutdown); returns how many were removed. */
  function retireAll() {
    const removed = records.size;
    records.clear();
    return removed;
  }

  return { register, has, consume, cancel, retireOwner, retireAll, size: () => records.size };
}

module.exports = { createRestrictedPdfRegistry };
