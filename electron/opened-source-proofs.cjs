/** Bounded main-owned evidence for the bytes accepted by an opened document. No file access or grants. */
'use strict';
const { randomBytes } = require('node:crypto');
const { absoluteWindowsPath, asciiCaseFold, fileVersionKey, MAX_PATH_LENGTH, MAX_CONTENT_BYTES } = require('./windows-path-identity.cjs');
const { verifiedCommitTarget, verifiedCommitOrder } = require('./save-admissions.cjs');
const LIMITS = Object.freeze({ proofs: 256, perOwner: 128, pending: 32, chars: 4 * 1024 * 1024 });
// Account both the record and one latest lineage snapshot before any copies.
const RESERVED_CHARS = 2 * (2 * MAX_PATH_LENGTH + 256 + 48);
const fail = (code, message) => Object.assign(new Error(message), { code });
const changed = () => fail('ERR_OPENED_SOURCE_CHANGED', 'The original opened file changed. Reload it or save a separate copy.');
const validToken = (token) => typeof token === 'string' && token.length === 48 && /^[a-f0-9]+$/.test(token);
/** @typedef {import('./windows-path-identity.cjs').FileVersion & {readonly sha256:string}} SourceVersion */
/** @typedef {{readonly logicalPath:string,readonly canonicalPath:string,readonly fileVersion:SourceVersion}} SourceEvidence */
/** @typedef {{latest:SourceEvidence,order:bigint}} Lineage */
/** @typedef {{owner:object,logicalPath:string,state:'reserved'|'complete',live:boolean,refs:number,cancelled?:boolean,token?:string,evidence?:SourceEvidence,lineage?:Lineage,source?:ProofRecord,mode:'in-place'|'save-as'}} ProofRecord */
/** @typedef {{readonly source:SourceEvidence}} SourceLease */
/** @param {unknown} version @returns {SourceVersion} */
function copyVersion(version) {
  if (!version || typeof version !== 'object') throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'Completed native byte evidence is required.');
  const value = /** @type {SourceVersion} */ (version), fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  for (const key of fields) {
    const item = value[key];
    if (typeof item !== 'string' || item.length > 24 || !/^-?\d+$/.test(item)) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'Bounded native file-version evidence is required.');
  }
  if (BigInt(value.dev) < 0n || BigInt(value.ino) < 0n || BigInt(value.size) < 0n || BigInt(value.size) > BigInt(MAX_CONTENT_BYTES) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'A bounded native file digest is required.');
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, sha256: value.sha256 });
}

/** Registry methods accepting evidence are for trusted main readers/writers only.
 * Renderer-facing operations accept only opaque tokens, never hashes or versions.
 * @param {{maxProofs?:number,maxPerOwner?:number,maxPending?:number,maxChars?:number}} [options]
 */
function createOpenedSourceProofs(options = {}) {
  const limit = (value, fallback) => {
    const n = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > fallback) throw fail('ERR_OPENED_SOURCE_CONFIGURATION', 'Source-proof bounds cannot be expanded.');
    return n;
  };
  const maxProofs = limit(options.maxProofs, LIMITS.proofs), maxPerOwner = limit(options.maxPerOwner, LIMITS.perOwner);
  const maxPending = limit(options.maxPending, LIMITS.pending), maxChars = limit(options.maxChars, LIMITS.chars);
  /** @type {Set<ProofRecord>} */ const records = new Set();
  /** @type {Map<string,ProofRecord>} */ const tokens = new Map();
  /** @type {WeakMap<object,ProofRecord>} */ const reservations = new WeakMap();
  /** @type {WeakMap<object,ProofRecord>} */ const leases = new WeakMap();
  const retired = new WeakSet();
  let disposed = false, pending = 0, chars = 0, borrowed = 0;
  function ownerCheck(owner) {
    if (!owner || typeof owner !== 'object') throw fail('ERR_OPENED_SOURCE_OWNER', 'A live main-owned document owner is required.');
    if (disposed || retired.has(owner)) throw fail('ERR_OPENED_SOURCE_RETIRED', 'The opened document owner is no longer active.');
  }
  function collect(record) {
    if (record.live || record.refs || record.state === 'reserved' && !record.cancelled || !records.has(record)) return;
    records.delete(record); chars -= RESERVED_CHARS;
    if (record.state === 'reserved') pending--;
    if (record.source) { record.source.refs--; collect(record.source); }
  }
  /** Capture synchronously before an await; token release cannot change this lease's source. */
  function borrow(owner, token) {
    ownerCheck(owner);
    const record = validToken(token) ? tokens.get(token) : undefined;
    if (!record || record.owner !== owner || !record.evidence || !record.live) throw fail('ERR_OPENED_SOURCE_PROOF', 'The opened-source proof is absent, released, or belongs to another document owner.');
    const lease = Object.freeze({ source: record.evidence }); record.refs++; borrowed++; leases.set(lease, record); return lease;
  }
  function leaseRecord(lease, owner) {
    ownerCheck(owner);
    const record = lease && typeof lease === 'object' ? leases.get(lease) : undefined;
    if (!record || record.owner !== owner || !record.evidence || !record.lineage || !records.has(record)) throw fail('ERR_OPENED_SOURCE_PROOF', 'A live main-owned source lease is required.');
    return record;
  }
  /** No disk lookup: the caller supplies an authorized fresh native content pin.
   * @param {SourceLease} lease @param {object} owner
   * @param {import('./windows-path-identity.cjs').WindowsWriteTarget} pin
   * @param {'in-place'|'save-as'} [mode] @returns {'source'|'copy'}
   */
  function validateDestination(lease, owner, pin, mode = 'in-place') {
    const record = leaseRecord(lease, owner);
    if (!record.evidence || !record.lineage) throw fail('ERR_OPENED_SOURCE_PROOF', 'A live main-owned source lineage is required.');
    if (mode !== 'in-place' && mode !== 'save-as') throw fail('ERR_OPENED_SOURCE_MODE', 'An explicit normal-save or Save As mode is required.');
    if (!pin || pin.hashContent !== true) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'A fresh native destination content pin is required.');
    const original = record.evidence, expected = record.lineage.latest;
    const sameLogical = asciiCaseFold(pin.logicalPath) === asciiCaseFold(original.logicalPath);
    const sameCanonical = pin.canonicalPath === original.canonicalPath || pin.canonicalPath === expected.canonicalPath;
    const sameNative = pin.fileVersion !== null && pin.fileVersion.dev === expected.fileVersion.dev && pin.fileVersion.ino === expected.fileVersion.ino;
    if (mode === 'save-as' && !sameLogical && !sameCanonical && !sameNative) return 'copy';
    // captureContentTarget supplied a fresh coherent read/hash, not just metadata.
    // Only normal Save may compare across a ctime-only transition. Canonical path,
    // dev/ino, size, mtime and SHA remain exact; Save As keeps the full version.
    // This comparison never changes the pin used by admission/write-time guards
    // or advances the lineage before a verified physical commit.
    const comparisonVersion = mode === 'in-place' && pin.fileVersion
      ? { ...pin.fileVersion, ctimeNs: expected.fileVersion.ctimeNs } : pin.fileVersion;
    if (!pin.exists || !pin.fileVersion || (!sameCanonical && !sameNative) || (mode === 'in-place' || sameLogical) && pin.canonicalPath !== expected.canonicalPath || fileVersionKey(comparisonVersion) !== fileVersionKey(expected.fileVersion)) throw changed();
    return 'source';
  }
  /** Legacy omission never adopts an active source baseline by its path.
   * @param {object} owner @param {import('./windows-path-identity.cjs').WindowsWriteTarget} pin
   */
  function assertUnprotectedDestination(owner, pin) {
    ownerCheck(owner);
    if (!pin || pin.hashContent !== true) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'Fresh native destination evidence is required.');
    for (const record of records) {
      if (record.owner !== owner || !record.evidence || !record.lineage || (!record.live && record.refs === 0)) continue;
      for (const source of [record.evidence, record.lineage.latest]) {
        if (asciiCaseFold(pin.logicalPath) === asciiCaseFold(source.logicalPath) || pin.canonicalPath === source.canonicalPath
          || pin.fileVersion && pin.fileVersion.dev === source.fileVersion.dev && pin.fileVersion.ino === source.fileVersion.ino) throw fail('ERR_OPENED_SOURCE_PROOF', 'An opened drawing requires its original source proof. Use normal Save or Save As from that drawing.');
      }
    }
  }
  /** Reserve BEFORE a held-FD read or backup/write. Never evict a live baseline.
   * @param {object} owner @param {string} logicalPath @param {SourceLease} [sourceLease]
   * @param {'in-place'|'save-as'} [mode]
   */
  function reserve(owner, logicalPath, sourceLease, mode = 'in-place') {
    ownerCheck(owner);
    const logical = absoluteWindowsPath(logicalPath);
    if (mode !== 'in-place' && mode !== 'save-as') throw fail('ERR_OPENED_SOURCE_MODE', 'An explicit source mode is required.');
    const source = sourceLease === undefined ? undefined : leaseRecord(sourceLease, owner);
    if (records.size >= maxProofs || [...records].filter((record) => record.owner === owner).length >= maxPerOwner || pending >= maxPending || RESERVED_CHARS > maxChars - chars) throw fail('ERR_OPENED_SOURCE_CAPACITY', 'Opened-source evidence capacity is full. Close unused drawings before opening or saving another file.');
    /** @type {ProofRecord} */ const record = { owner, logicalPath: logical, state: 'reserved', live: true, refs: 0, mode, ...(source ? { source } : {}) };
    const reservation = Object.freeze({}); records.add(record); reservations.set(reservation, record); pending++; chars += RESERVED_CHARS;
    if (source) source.refs++;
    return reservation;
  }
  function reservationRecord(reservation, owner) {
    ownerCheck(owner);
    const record = reservation && typeof reservation === 'object' ? reservations.get(reservation) : undefined;
    if (!record || record.owner !== owner || record.state !== 'reserved' || !record.live) throw fail('ERR_OPENED_SOURCE_PROOF', 'A live main-owned evidence reservation is required.');
    return record;
  }
  /** Validation/copy completes before any visible mutation; input is trusted FD evidence. */
  function complete(reservation, owner, canonicalPath, fileVersion, sourceCommit = false, commitOrder = 0n) {
    const record = reservationRecord(reservation, owner), canonical = absoluteWindowsPath(canonicalPath), version = copyVersion(fileVersion);
    const evidence = Object.freeze({ logicalPath: record.logicalPath, canonicalPath: canonical, fileVersion: version });
    const token = randomBytes(24).toString('hex');
    const lineage = sourceCommit && record.source ? record.source.lineage : { latest: evidence, order: 0n };
    if (!lineage) throw fail('ERR_OPENED_SOURCE_PROOF', 'The original source lineage is no longer available.');
    if (commitOrder < lineage.order) throw fail('ERR_OPENED_SOURCE_STALE', 'An older verified completion cannot replace the newer opened-source proof.');
    record.evidence = evidence; record.lineage = lineage; record.state = 'complete'; record.token = token; pending--;
    lineage.latest = evidence; lineage.order = commitOrder; tokens.set(token, record); reservations.delete(reservation);
    if (record.source) { const source = record.source; delete record.source; source.refs--; collect(source); }
    return token;
  }
  /** @param {object} reservation @param {object} owner @param {{canonicalPath:string,fileVersion:SourceVersion}} evidence */
  function completeRead(reservation, owner, evidence) {
    const record = reservationRecord(reservation, owner);
    if (record.source) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'A commit reservation cannot be completed by a read.');
    if (!evidence || typeof evidence !== 'object') throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'Completed native read evidence is required.');
    return complete(reservation, owner, evidence.canonicalPath, evidence.fileVersion);
  }
  /** A branded verified after-pin is reused verbatim; no fresh realpath/hash may mint authority.
   * Lineage follows verified physical bytes, matching the admission ledger. A
   * later producer/receipt error must release the unused token and leave the UI
   * dirty; it does not turn known own bytes into an outside version transition.
   */
  /** @param {object} reservation @param {object} owner @param {unknown} evidence @param {'source'|'copy'} [relation] */
  function completeCommit(reservation, owner, evidence, relation) {
    const record = reservationRecord(reservation, owner), pin = verifiedCommitTarget(evidence, owner), commitOrder = verifiedCommitOrder(evidence, owner);
    if (!pin || commitOrder === null || !pin.exists || !pin.fileVersion || pin.logicalPath !== record.logicalPath) throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'Only this owner\'s verified committed target can complete a save proof.');
    let sourceCommit = false;
    if (record.source) {
      const source = record.source.evidence;
      if (!source || !record.source.lineage) throw fail('ERR_OPENED_SOURCE_PROOF', 'The original source lineage is no longer available.');
      // Root retains the relation returned by pre-write validateDestination.
      // Replacement changes inode identity, so the after-pin cannot infer it.
      if (relation !== 'source' && relation !== 'copy') throw fail('ERR_OPENED_SOURCE_EVIDENCE', 'The trusted pre-write source relation is required.');
      sourceCommit = relation === 'source';
      if (!sourceCommit && (record.mode === 'in-place' || asciiCaseFold(pin.logicalPath) === asciiCaseFold(source.logicalPath) || pin.canonicalPath === record.source.lineage.latest.canonicalPath)) throw changed();
    }
    return complete(reservation, owner, pin.canonicalPath, pin.fileVersion, sourceCommit, commitOrder);
  }
  function release(token, owner) {
    ownerCheck(owner);
    const record = validToken(token) ? tokens.get(token) : undefined;
    if (!record) return false;
    if (record.owner !== owner) throw fail('ERR_OPENED_SOURCE_PROOF', 'Source evidence belongs to another owner.');
    tokens.delete(token); record.live = false; collect(record); return true;
  }
  function releaseBorrow(lease) {
    const record = lease && typeof lease === 'object' ? leases.get(lease) : undefined;
    if (!record) return false;
    leases.delete(lease); borrowed--; record.refs--; collect(record); return true;
  }
  function cancelReservation(reservation, owner) {
    const record = reservation && typeof reservation === 'object' ? reservations.get(reservation) : undefined;
    if (!record) return false;
    if (record.owner !== owner) throw fail('ERR_OPENED_SOURCE_PROOF', 'Source evidence belongs to another owner.');
    reservations.delete(reservation); record.live = false; record.cancelled = true; collect(record); return true;
  }
  function retireOwner(owner) {
    if (!owner || typeof owner !== 'object') throw fail('ERR_OPENED_SOURCE_OWNER', 'A main-owned owner is required.');
    retired.add(owner);
    for (const record of [...records]) if (record.owner === owner) {
      if (record.token) tokens.delete(record.token);
      record.live = false; collect(record);
    }
  }
  function dispose() { disposed = true; for (const owner of new Set([...records].map((record) => record.owner))) retireOwner(owner); }
  const stats = () => Object.freeze({ records: records.size, liveProofs: tokens.size, pending, chars, borrowed });
  return Object.freeze({ reserve, completeRead, completeCommit, borrow, validateDestination, assertUnprotectedDestination, release, releaseBorrow, cancelReservation, retireOwner, dispose, stats });
}
module.exports = { OPENED_SOURCE_LIMITS: LIMITS, OPENED_SOURCE_RESERVED_CHARS: RESERVED_CHARS, createOpenedSourceProofs };
