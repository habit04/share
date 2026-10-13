/** Host-owned save ordering. Authorization and the atomic writer remain caller-owned. */
'use strict';
const { randomBytes } = require('node:crypto');
const { absoluteWindowsPath, fileVersionKey } = require('./windows-path-identity.cjs');
const byteLengthDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength');
if (!byteLengthDescriptor || typeof byteLengthDescriptor.get !== 'function') throw new Error('Native typed-array byte lengths are required.');
const typedByteLength = byteLengthDescriptor.get;

const SAVE_KINDS = Object.freeze(['drawing', 'project', 'export-copy']);
const LIMITS = Object.freeze({ pending: 32, ledger: 512, payload: 128 * 1024 * 1024, queuedBytes: 256 * 1024 * 1024, ttlMs: 120000 });
const fail = (code, message) => Object.assign(new Error(message), { code });
/** @typedef {import('./windows-path-identity.cjs').WindowsWriteTarget} WriteTarget */
/** @typedef {{allowed:true, root?:string}|{allowed:false}} Authorization */
/** @typedef {{captureWriteTarget:(path:string,root?:string)=>Promise<WriteTarget>, revalidate:(pin:WriteTarget,options?:{preserveLeaf?:boolean,preserveVersion?:boolean})=>Promise<WriteTarget>}} PathIdentity */
/** @typedef {{logicalPath:string,destinationPath:string,canonicalPath:string,root?:string,signal:AbortSignal,guard:()=>Promise<void>,guardParents:()=>Promise<void>,markCommitted:()=>Promise<void>}} WriterContext */
/** @typedef {(payload:string|Uint8Array,context:WriterContext)=>Promise<unknown>} SaveWriter */
/** @typedef {{signal:AbortSignal, target:WriteTarget, commit:(payload:string|Uint8Array,writer:SaveWriter)=>Promise<unknown>}} SaveScope */
/** @typedef {{order:bigint, after:string|null, origins:Set<string|null>,parentPath:string,targetPath:string}} LedgerEntry */
/** @typedef {{ticket:string,owner:object,kind:string,order:bigint,deadline:number,state:'issued'|'binding'|'bound'|'running',abort:AbortController,pin?:WriteTarget,root?:string,task?:Promise<unknown>}} Admission */

/**
 * Tickets must be issued before serialization/conversion begins. The owner is a
 * main-owned object (for example a WebContents), never a renderer revision or ID.
 * authorize runs before path inspection and before payload copying. The identity
 * helper must be the native Windows helper; queue keys are parent namespaces,
 * whereas expected destinations are exact canonical leaf identities.
 *
 * A writer must await guard immediately before its final replacement. It may call
 * markCommitted immediately after replacement, before verification that can fail.
 * guardParents is for cleanup/verification and never relaxes junction/root pins.
 * No portable Node API can eliminate the last check-to-rename race with an
 * adversarial local process. File versions use native stat evidence, not hashes.
 * @param {{identity:PathIdentity, authorize:(owner:object,kind:string,path:string)=>Authorization|Promise<Authorization>, maxPending?:number,maxLedger?:number,maxPayloadBytes?:number,maxQueuedBytes?:number,ttlMs?:number,now?:()=>number}} options
 */
function createSaveAdmissions(options) {
  if (!options || !options.identity || typeof options.authorize !== 'function') throw fail('ERR_SAVE_CONFIGURATION', 'Native identity and explicit main-owned authorization are required.');
  const { identity, authorize, now = () => performance.now() } = options;
  function limit(value, fallback, ceiling) {
    const n = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw fail('ERR_SAVE_CONFIGURATION', 'Save limits must be bounded positive integers.');
    return n;
  }
  const maxPending = limit(options.maxPending, LIMITS.pending, LIMITS.pending), maxLedger = limit(options.maxLedger, LIMITS.ledger, LIMITS.ledger);
  const maxPayloadBytes = limit(options.maxPayloadBytes, LIMITS.payload, LIMITS.payload), maxQueuedBytes = limit(options.maxQueuedBytes, LIMITS.queuedBytes, LIMITS.queuedBytes);
  const ttlMs = limit(options.ttlMs, LIMITS.ttlMs, 600000);
  /** @type {Map<string,Admission>} */ const pending = new Map();
  /** @type {Map<string,LedgerEntry>} */ const ledger = new Map();
  /** @type {Map<string,Promise<void>>} */ const tails = new Map();
  const retired = new WeakSet();
  let order = 0n, queuedBytes = 0, disposed = false;

  function checkOwner(owner, kind) {
    if (!owner || typeof owner !== 'object' || !SAVE_KINDS.includes(kind)) throw fail('ERR_SAVE_TICKET', 'A main-owned save owner and supported kind are required.');
    if (disposed || retired.has(owner)) throw fail('ERR_SAVE_DISPOSED', 'This save owner is no longer active.');
  }
  function prune() {
    let oldest = order + 1n;
    for (const entry of pending.values()) if (entry.order < oldest) oldest = entry.order;
    for (const [key, entry] of ledger) {
      const needed = [...pending.values()].some(({ pin }) => pin && pin.canonicalParent === entry.parentPath && (!pin.exists || pin.canonicalPath === entry.targetPath) && fileVersionKey(pin.fileVersion) !== entry.after && entry.origins.has(fileVersionKey(pin.fileVersion)));
      if (entry.order < oldest && !needed) ledger.delete(key);
    }
  }
  function finish(entry) { pending.delete(entry.ticket); prune(); }
  function reap() {
    const time = now();
    for (const entry of pending.values()) if ((entry.state === 'issued' || entry.state === 'bound') && entry.deadline <= time) { entry.abort.abort(); pending.delete(entry.ticket); }
    prune();
  }
  function get(ticket, owner, kind) {
    reap(); checkOwner(owner, kind);
    const entry = typeof ticket === 'string' && pending.get(ticket);
    if (!entry || entry.owner !== owner || entry.kind !== kind) throw fail('ERR_SAVE_TICKET', 'The save ticket is invalid, expired, consumed, or belongs to another owner.');
    return entry;
  }
  function abortCheck(entry) { if (entry.abort.signal.aborted) throw fail('ERR_SAVE_CANCELLED', 'The save was cancelled.'); }
  async function permission(entry, logicalPath, binding = false) {
    const result = await authorize(entry.owner, entry.kind, logicalPath);
    if (!result || result.allowed !== true) throw fail('ERR_SAVE_AUTHORIZATION', 'This save destination is not authorized.');
    const root = result.root === undefined ? undefined : absoluteWindowsPath(result.root, false);
    if (!binding && root !== entry.root) throw fail('ERR_SAVE_AUTHORIZATION', 'The save authorization scope changed.');
    return root;
  }
  function issue(owner, kind) {
    reap(); checkOwner(owner, kind);
    if (pending.size >= maxPending) throw fail('ERR_SAVE_CAPACITY', 'Too many saves are pending.');
    const ticket = randomBytes(24).toString('hex');
    pending.set(ticket, { ticket, owner, kind, order: ++order, deadline: now() + ttlMs, state: 'issued', abort: new AbortController() });
    return ticket;
  }
  function bind(ticket, owner, kind, value) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'issued') throw fail('ERR_SAVE_TICKET', 'A save ticket can be bound only once.');
    const logicalPath = absoluteWindowsPath(value);
    entry.state = 'binding';
    const task = (async () => {
      try {
        const root = await permission(entry, logicalPath, true); abortCheck(entry);
        const pin = await identity.captureWriteTarget(logicalPath, root); abortCheck(entry);
        if (!pin.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
        entry.pin = pin; entry.root = root; entry.deadline = now() + ttlMs; entry.state = 'bound';
        return pin;
      } catch (error) { finish(entry); throw error; }
    })();
    entry.task = task; return task;
  }
  function enqueue(key, job) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(job, job), tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  function samePath(entry, value) {
    const logicalPath = absoluteWindowsPath(value);
    if (!entry.pin || logicalPath !== entry.pin.logicalPath) throw fail('ERR_SAVE_TICKET', 'A save ticket cannot be transferred to another logical path.');
    return entry.pin;
  }
  function targetChanged() { return fail('ERR_WINDOWS_PATH_CHANGED', 'The chosen file changed while the save was being prepared.'); }
  /** Earlier writes by this host may legitimately replace the version a newer save captured. */
  function checkVersion(initial, current, previous) {
    if (initial.exists && initial.canonicalPath !== current.canonicalPath) throw targetChanged();
    const before = fileVersionKey(initial.fileVersion), actual = fileVersionKey(current.fileVersion);
    if (before !== actual && (!previous || previous.after !== actual || !previous.origins.has(before))) throw targetChanged();
  }
  /** Only origins still needed by live preparations are retained; no unbounded version chain. */
  function originsFor(current, previous) {
    const actual = fileVersionKey(current.fileVersion), origins = new Set([actual]);
    for (const item of pending.values()) {
      const pin = item.pin;
      if (!pin || pin.canonicalParent !== current.canonicalParent || pin.exists && pin.canonicalPath !== current.canonicalPath) continue;
      const version = fileVersionKey(pin.fileVersion);
      if (version === actual || previous?.origins.has(version)) origins.add(version);
    }
    return origins;
  }
  function annotate(error, committed) {
    const out = fail(error?.code || 'ERR_SAVE_OPERATION', error?.message || 'The save failed.');
    return Object.assign(out, { cause: error, committed });
  }
  function run(ticket, owner, kind, value, operation) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'bound' || typeof operation !== 'function') throw fail('ERR_SAVE_TICKET', 'A bound ticket and save operation are required.');
    const initial = samePath(entry, value);
    entry.state = 'running';
    let attempted = false, committed = false, stale = false, writeResult;
    /** @type {Promise<unknown>|undefined} */ let commitTask;
    const commit = (payload, writer) => {
      if (entry.state !== 'running' || pending.get(entry.ticket) !== entry) return Promise.reject(fail('ERR_SAVE_TICKET', 'The save callback is no longer active.'));
      if (attempted) return Promise.reject(fail('ERR_SAVE_TICKET', 'A save operation can commit only once.'));
      attempted = true;
      commitTask = (async () => {
        abortCheck(entry);
        await permission(entry, initial.logicalPath); abortCheck(entry);
        if (typeof writer !== 'function' || !(typeof payload === 'string' || payload instanceof Uint8Array)) throw fail('ERR_SAVE_PAYLOAD', 'A text or byte payload and atomic writer are required.');
        const bytes = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : typedByteLength.call(payload);
        if (bytes > maxPayloadBytes || bytes > maxQueuedBytes - queuedBytes) throw fail('ERR_SAVE_PAYLOAD_LIMIT', 'The pending save payload budget is exhausted.');
        queuedBytes += bytes;
        try {
          // Copy only after authorization and reserve before allocation/queueing.
          const snapshot = typeof payload === 'string' ? payload : new Uint8Array(payload);
          return await enqueue(initial.queueKey, async () => {
            abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
            const current = await identity.revalidate(initial);
            if (!current.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
            const previous = ledger.get(current.targetKey);
            if (previous && previous.order > entry.order) { stale = true; throw fail('ERR_SAVE_STALE', 'A newer host save has already reached this file.'); }
            checkVersion(initial, current, previous);
            prune();
            if (!ledger.has(current.targetKey) && ledger.size >= maxLedger) throw fail('ERR_SAVE_LEDGER_LIMIT', 'Save ordering history is full while older work remains pending.');
            const record = { order: entry.order, after: fileVersionKey(current.fileVersion), origins: originsFor(current, previous), parentPath: current.canonicalParent, targetPath: current.canonicalPath };
            ledger.set(current.targetKey, record);
            const guardParents = async () => { await identity.revalidate(current, { preserveLeaf: true }); };
            const guard = async () => {
              abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
              await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true });
            };
            /** @type {Promise<void>|undefined} */ let markTask;
            const markCommitted = () => {
              if (markTask) return markTask;
              committed = true;
              markTask = (async () => {
                const after = await identity.revalidate(current, { preserveLeaf: true });
                record.after = fileVersionKey(after.fileVersion); record.origins.add(record.after);
              })();
              void markTask.catch(() => {}); return markTask;
            };
            await guard();
            try {
              const result = await writer(snapshot, Object.freeze({ logicalPath: initial.logicalPath, destinationPath: current.destinationPath, canonicalPath: current.canonicalPath,
                ...(entry.root === undefined ? {} : { root: entry.root }), signal: entry.abort.signal, guard, guardParents, markCommitted }));
              await markCommitted();
              const verified = await identity.revalidate(current, { preserveLeaf: true });
              if (fileVersionKey(verified.fileVersion) !== record.after) throw targetChanged();
              writeResult = result; return result;
            } finally {
              if (markTask) await markTask;
              // An unmarked error is an uncertain attempted write. Retain its
              // order, but never adopt an external edit as an own transition.
            }
          });
        } finally { queuedBytes -= bytes; }
      })();
      // The producer can throw/return without awaiting its callback; run still joins
      // the writer and its cleanup, and an early rejection is never unhandled.
      void commitTask.catch(() => {}); return commitTask;
    };
    const task = (async () => {
      let result, error, hasError = false;
      try {
        abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
        const current = await identity.revalidate(initial);
        if (!current.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
        try { result = await operation(Object.freeze({ signal: entry.abort.signal, target: initial, commit })); }
        catch (failure) { error = failure; hasError = true; }
        if (commitTask) { try { await commitTask; } catch (failure) { if (!hasError) error = failure; hasError = true; } }
        if (stale) return Object.freeze({ status: 'stale', committed: false });
        if (hasError) throw annotate(error, committed);
        if (!committed) { abortCheck(entry); throw fail('ERR_SAVE_NO_COMMIT', 'The save operation finished without committing a file.'); }
        return Object.freeze({ status: 'saved', committed: true, cancelledAfterCommit: entry.abort.signal.aborted, value: result, writeResult });
      } catch (failure) { throw annotate(failure, committed); }
      finally { finish(entry); }
    })();
    entry.task = task; return task;
  }
  function cancel(ticket, owner, kind) {
    const entry = get(ticket, owner, kind); entry.abort.abort();
    if (entry.state === 'issued' || entry.state === 'bound') finish(entry);
    return true;
  }
  function retireOwner(owner) {
    if (!owner || typeof owner !== 'object') throw fail('ERR_SAVE_TICKET', 'A main-owned save owner is required.');
    retired.add(owner);
    for (const entry of pending.values()) if (entry.owner === owner) { entry.abort.abort(); if (entry.state === 'issued' || entry.state === 'bound') pending.delete(entry.ticket); }
    prune();
  }
  async function dispose() {
    disposed = true;
    const tasks = [];
    for (const entry of pending.values()) { entry.abort.abort(); if (entry.state === 'issued' || entry.state === 'bound') pending.delete(entry.ticket); else if (entry.task) tasks.push(entry.task); }
    prune(); await Promise.allSettled(tasks); prune();
  }
  const stats = () => Object.freeze({ pending: pending.size, ledger: ledger.size, queuedBytes, queues: tails.size });
  return Object.freeze({ issue, bind, run, cancel, retireOwner, dispose, stats });
}
module.exports = { SAVE_KINDS, SAVE_ADMISSION_LIMITS: LIMITS, createSaveAdmissions };
