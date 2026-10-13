/** Host-owned save ordering. Authorization and the atomic writer remain caller-owned. */
'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { absoluteWindowsPath, fileVersionKey, MAX_CONTENT_BYTES, MAX_PDF_CONTENT_BYTES } = require('./windows-path-identity.cjs');
const byteLengthDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength');
if (!byteLengthDescriptor || typeof byteLengthDescriptor.get !== 'function') throw new Error('Native typed-array byte lengths are required.');
const typedByteLength = byteLengthDescriptor.get;

const SAVE_KINDS = Object.freeze(['drawing', 'project', 'export-copy', 'text-export', 'pdf-export']);
const LIMITS = Object.freeze({ pending: 32, ledger: 640, payload: 128 * 1024 * 1024, queuedBytes: 256 * 1024 * 1024, ttlMs: 120000,
  pdfPayload: 512 * 1024 * 1024, pdfQueuedBytes: 512 * 1024 * 1024, sharedQueuedBytes: 768 * 1024 * 1024,
  batchParents: 2, batchChildren: 512, batchInputBytes: 128 * 1024 * 1024, batchPinChars: 16 * 1024 * 1024, batchHardLifeMs: 600000 });
const fail = (code, message) => Object.assign(new Error(message), { code });
const verifiedCommits = new WeakMap();
/** Trusted main code only: IPC-cloned or caller-authored objects have no authority.
 * @param {unknown} evidence @param {object} owner @returns {WriteTarget|null}
 */
function verifiedCommitTarget(evidence, owner) {
  const recorded = evidence && typeof evidence === 'object' ? verifiedCommits.get(evidence) : undefined;
  return recorded?.owner === owner ? recorded.pin : null;
}
/** @param {unknown} evidence @param {object} owner @returns {bigint|null} */
function verifiedCommitOrder(evidence, owner) {
  const recorded = evidence && typeof evidence === 'object' ? verifiedCommits.get(evidence) : undefined;
  return recorded?.owner === owner ? recorded.order : null;
}
/** @typedef {import('./windows-path-identity.cjs').WindowsWriteTarget} WriteTarget */
/** @typedef {{allowed:true, root?:string}|{allowed:false}} Authorization */
/** @typedef {{captureWriteTarget:(path:string,root?:string)=>Promise<WriteTarget>, captureContentTarget?:(pin:WriteTarget,options?:{signal?:AbortSignal,maxBytes?:number})=>Promise<WriteTarget>, revalidate:(pin:WriteTarget,options?:{preserveLeaf?:boolean,preserveVersion?:boolean,signal?:AbortSignal,metadataOnly?:boolean})=>Promise<WriteTarget>}} PathIdentity */
/** @typedef {{logicalPath:string,destinationPath:string,canonicalPath:string,root?:string,signal:AbortSignal,guard:()=>Promise<void>,guardParents:()=>Promise<void>,markCommitted:()=>Promise<void>}} WriterContext */
/** @typedef {(payload:string|Uint8Array,context:WriterContext)=>Promise<unknown>} SaveWriter */
/** @typedef {{logicalPath:string,destinationPath:string,canonicalPath:string,root?:string,signal:AbortSignal,guard:()=>Promise<void>,guardParents:()=>Promise<void>}} PreparationContext */
/** @typedef {{signal:AbortSignal, target:WriteTarget, commit:(payload:string|Uint8Array,writer:SaveWriter)=>Promise<unknown>}} SaveScope */
/** @typedef {{order:bigint, after:string|null, origins:Set<string|null>,parentPath:string,targetPath:string}} LedgerEntry */
/** @typedef {{pin:WriteTarget,signal:AbortSignal,inputBytes:number,guard:()=>Promise<void>}} ProjectBatchReadScope */
/** @typedef {{validateSource?:(pin:WriteTarget)=>void|Promise<void>,onVerifiedCommit?:(evidence:object)=>void,onFinish?:()=>void}} BindLifecycle */
/** @typedef {{ticket:string,owner:object,kind:string,order:bigint,deadline:number,state:'issued'|'binding'|'bound'|'reading'|'preparing'|'running',abort:AbortController,pin?:WriteTarget,root?:string,task?:Promise<unknown>,batch?:ProjectBatch,readDone?:boolean,lifecycle?:BindLifecycle,finished?:boolean}} Admission */
/** @typedef {{ticket:string,owner:object,order:bigint,deadline:number,hardDeadline:number,state:'issued'|'binding'|'bound'|'sealing'|'sealed'|'beginning'|'committing'|'closing',abort:AbortController,children:Map<string,Admission>,selected:Set<string>,reserved:Set<string>,transitions:Map<string,string|null>,declarations:number,pinChars:number,inputBytes:number,task?:Promise<unknown>,closing?:Promise<void>}} ProjectBatch */

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
 * adversarial local process. Existing versions include fresh held-FD SHA256 evidence.
 * @param {{identity:PathIdentity, authorize:(owner:object,kind:string,path:string)=>Authorization|Promise<Authorization>, maxPending?:number,maxLedger?:number,maxPayloadBytes?:number,maxQueuedBytes?:number,maxPdfPayloadBytes?:number,maxPdfQueuedBytes?:number,maxSharedQueuedBytes?:number,ttlMs?:number,maxBatchParents?:number,maxBatchChildren?:number,maxBatchInputBytes?:number,maxBatchPinChars?:number,batchHardLifeMs?:number,now?:()=>number}} options
 */
function createSaveAdmissions(options) {
  if (!options || !options.identity || typeof options.authorize !== 'function') throw fail('ERR_SAVE_CONFIGURATION', 'Native identity and explicit main-owned authorization are required.');
  const { identity, authorize, now = () => performance.now() } = options;
  async function contentPin(pin, signal, kind = 'drawing') {
    if (typeof identity.captureContentTarget !== 'function') throw fail('ERR_SAVE_CONFIGURATION', 'Fresh native file-content evidence is required.');
    const maxBytes = kind === 'pdf-export' ? MAX_PDF_CONTENT_BYTES : MAX_CONTENT_BYTES;
    const captured = await identity.captureContentTarget(pin, { signal, maxBytes });
    if (captured.hashContent !== true || captured.contentLimit !== maxBytes || captured.exists && !/^[a-f0-9]{64}$/.test(captured.fileVersion?.sha256 ?? '')) throw fail('ERR_SAVE_CONFIGURATION', 'Fresh native file-content evidence with its sealed budget is required.');
    return captured;
  }
  function limit(value, fallback, ceiling) {
    const n = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw fail('ERR_SAVE_CONFIGURATION', 'Save limits must be bounded positive integers.');
    return n;
  }
  const maxPending = limit(options.maxPending, LIMITS.pending, LIMITS.pending), maxLedger = limit(options.maxLedger, LIMITS.ledger, LIMITS.ledger);
  const maxPayloadBytes = limit(options.maxPayloadBytes, LIMITS.payload, LIMITS.payload), maxQueuedBytes = limit(options.maxQueuedBytes, LIMITS.queuedBytes, LIMITS.queuedBytes);
  const maxPdfPayloadBytes = limit(options.maxPdfPayloadBytes, LIMITS.pdfPayload, LIMITS.pdfPayload), maxPdfQueuedBytes = limit(options.maxPdfQueuedBytes, LIMITS.pdfQueuedBytes, LIMITS.pdfQueuedBytes);
  const maxSharedQueuedBytes = limit(options.maxSharedQueuedBytes, LIMITS.sharedQueuedBytes, LIMITS.sharedQueuedBytes);
  const ttlMs = limit(options.ttlMs, LIMITS.ttlMs, 600000);
  const maxBatchParents = limit(options.maxBatchParents, LIMITS.batchParents, LIMITS.batchParents), maxBatchChildren = limit(options.maxBatchChildren, LIMITS.batchChildren, LIMITS.batchChildren);
  const maxBatchInputBytes = limit(options.maxBatchInputBytes, LIMITS.batchInputBytes, LIMITS.batchInputBytes), maxBatchPinChars = limit(options.maxBatchPinChars, LIMITS.batchPinChars, LIMITS.batchPinChars);
  const batchHardLifeMs = limit(options.batchHardLifeMs, LIMITS.batchHardLifeMs, LIMITS.batchHardLifeMs);
  /** @type {Map<string,Admission>} */ const pending = new Map();
  /** @type {Map<string,LedgerEntry>} */ const ledger = new Map();
  /** @type {Map<string,Promise<void>>} */ const tails = new Map();
  /** @type {Map<string,ProjectBatch>} */ const batches = new Map();
  /** @type {Map<string,Set<ProjectBatch>>} */ const reservedTargets = new Map();
  const retired = new WeakSet();
  let order = 0n, queuedBytes = 0, ordinaryQueuedBytes = 0, pdfQueuedBytes = 0, disposed = false, batchActive = 0, batchChildren = 0, batchInputs = 0, batchPinChars = 0, metadataActive = 0;
  /** @type {Array<()=>void>} */ const metadataWaiters = [];
  async function withBatchMetadata(operation) {
    if (metadataActive >= 8) await new Promise((resolve) => metadataWaiters.push(() => resolve(undefined)));
    else metadataActive++;
    try { return await operation(); }
    finally { const next = metadataWaiters.shift(); if (next) next(); else metadataActive--; }
  }
  /** Join each bounded chunk in full before failure/cancellation is propagated. */
  async function checkBatchSources(sources, operation) {
    for (let index = 0; index < sources.length; index += 8) {
      const results = await Promise.allSettled(sources.slice(index, index + 8).map(operation));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    }
  }

  const ordinaryPending = () => [...pending.values()].filter((entry) => !entry.batch).length;
  function claimBatchOperation() {
    if (ordinaryPending() + batchActive >= maxPending) throw fail('ERR_SAVE_CAPACITY', 'Too many saves or project operations are active.');
    batchActive++;
    let released = false;
    return () => { if (!released) { released = true; batchActive--; } };
  }
  const orderingSlots = () => new Set([...ledger.keys(), ...reservedTargets.keys()]).size;

  function checkOwner(owner, kind) {
    if (!owner || typeof owner !== 'object' || !SAVE_KINDS.includes(kind)) throw fail('ERR_SAVE_TICKET', 'A main-owned save owner and supported kind are required.');
    if (disposed || retired.has(owner)) throw fail('ERR_SAVE_DISPOSED', 'This save owner is no longer active.');
  }
  function prune() {
    const sources = [...pending.values(), ...[...batches.values()].flatMap((batch) => [...batch.children.values()])];
    for (const [key, entry] of ledger) {
      // Unknown destinations need global ordering protection. Once the manifest
      // is fixed, only relevant native targets and retained own-version origins
      // need history; unrelated ordinary writes must keep their headroom.
      const unknown = [...pending.values()].some((item) => !item.batch && !item.pin && item.order <= entry.order)
        || [...batches.values()].some((batch) => (batch.state === 'issued' || batch.state === 'binding') && batch.order <= entry.order);
      const needed = sources.some(({ pin, order: sourceOrder }) => pin && pin.canonicalParent === entry.parentPath && (!pin.exists || pin.canonicalPath === entry.targetPath)
        && (sourceOrder <= entry.order || fileVersionKey(pin.fileVersion) !== entry.after && entry.origins.has(fileVersionKey(pin.fileVersion))));
      if (!unknown && !needed) ledger.delete(key);
    }
  }
  function finish(entry) {
    pending.delete(entry.ticket);
    if (!entry.finished) {
      entry.finished = true;
      // Cleanup callbacks cannot resurrect tickets or prevent capacity cleanup.
      try { entry.lifecycle?.onFinish?.(); } catch { /* Caller-owned cleanup must be idempotent. */ }
    }
    prune();
  }
  function reap() {
    const time = now();
    for (const entry of pending.values()) if (!entry.batch && (entry.state === 'issued' || entry.state === 'bound') && entry.deadline <= time) { entry.abort.abort(); finish(entry); }
    for (const batch of batches.values()) {
      const idle = [...batch.children.values()].every((child) => child.state === 'bound');
      if (batch.state !== 'closing' && (time >= batch.hardDeadline || (idle && (batch.state === 'issued' || batch.state === 'bound' || batch.state === 'sealed') && time >= batch.deadline))) void closeProjectBatch(batch);
    }
    prune();
  }
  function get(ticket, owner, kind) {
    reap(); checkOwner(owner, kind);
    const entry = typeof ticket === 'string' && pending.get(ticket);
    if (!entry || entry.owner !== owner || entry.kind !== kind) throw fail('ERR_SAVE_TICKET', 'The save ticket is invalid, expired, consumed, or belongs to another owner.');
    return entry;
  }
  function abortCheck(entry) {
    if (entry.batch && now() >= entry.batch.hardDeadline) void closeProjectBatch(entry.batch);
    if (entry.abort.signal.aborted || entry.batch?.abort.signal.aborted) throw fail('ERR_SAVE_CANCELLED', 'The save was cancelled.');
  }
  async function permission(entry, logicalPath, binding = false) {
    const result = await authorize(entry.owner, entry.kind, logicalPath);
    if (!result || result.allowed !== true) throw fail('ERR_SAVE_AUTHORIZATION', 'This save destination is not authorized.');
    const root = result.root === undefined ? undefined : absoluteWindowsPath(result.root, false);
    if (!binding && root !== entry.root) throw fail('ERR_SAVE_AUTHORIZATION', 'The save authorization scope changed.');
    return root;
  }
  function issue(owner, kind) {
    reap(); checkOwner(owner, kind);
    if (ordinaryPending() + batchActive >= maxPending) throw fail('ERR_SAVE_CAPACITY', 'Too many saves are pending.');
    const ticket = randomBytes(24).toString('hex');
    pending.set(ticket, { ticket, owner, kind, order: ++order, deadline: now() + ttlMs, state: 'issued', abort: new AbortController() });
    return ticket;
  }
  /** @param {BindLifecycle} [lifecycle] */
  function bind(ticket, owner, kind, value, lifecycle) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'issued') throw fail('ERR_SAVE_TICKET', 'A save ticket can be bound only once.');
    const logicalPath = absoluteWindowsPath(value);
    if (lifecycle !== undefined && (!lifecycle || typeof lifecycle !== 'object' || ['validateSource', 'onVerifiedCommit', 'onFinish'].some((key) => lifecycle[key] !== undefined && typeof lifecycle[key] !== 'function'))) throw fail('ERR_SAVE_CONFIGURATION', 'Bind lifecycle callbacks must be trusted main functions.');
    const callbacks = lifecycle === undefined ? undefined : Object.freeze({ validateSource: lifecycle.validateSource, onVerifiedCommit: lifecycle.onVerifiedCommit, onFinish: lifecycle.onFinish });
    entry.lifecycle = callbacks;
    entry.state = 'binding';
    const task = (async () => {
      try {
        const root = await permission(entry, logicalPath, true); abortCheck(entry);
        let pin = await identity.captureWriteTarget(logicalPath, root); abortCheck(entry);
        if (!pin.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
        pin = await contentPin(pin, entry.abort.signal, kind); abortCheck(entry);
        if (callbacks?.validateSource) {
          const validateSource = callbacks.validateSource;
          try { await validateSource(pin); }
          catch (error) {
            // Join a known host writer's final verification/lineage hook, then
            // compare the same borrowed source against fresh native evidence.
            if (error?.code !== 'ERR_OPENED_SOURCE_CHANGED' || !tails.has(pin.queueKey)) throw error;
            pin = await enqueue(pin.queueKey, async () => {
              abortCheck(entry); if (await permission(entry, logicalPath, true) !== root) throw fail('ERR_SAVE_AUTHORIZATION', 'The save authorization scope changed.'); abortCheck(entry);
              const current = await identity.revalidate(pin, { signal: entry.abort.signal });
              await validateSource(current); abortCheck(entry); return current;
            });
          }
          abortCheck(entry);
        }
        entry.pin = pin; entry.root = root; entry.deadline = now() + ttlMs; entry.state = 'bound';
        return pin;
      } catch (error) { finish(entry); throw error; }
    })();
    entry.task = task; return task;
  }
  /** @template T @param {string} key @param {()=>Promise<T>} job @returns {Promise<T>} */
  function enqueue(key, job) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(job, job), tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  /** Parent order is always acquired outside a native namespace; callbacks do not nest parents. */
  function enqueueProjectWrite(entry, key, job) {
    return entry.batch ? enqueue(`project-batch:${entry.batch.ticket}`, () => enqueue(key, job)) : enqueue(key, job);
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
  function getProjectBatch(ticket, owner) {
    reap(); checkOwner(owner, 'drawing');
    const batch = typeof ticket === 'string' && batches.get(ticket);
    if (!batch || batch.owner !== owner) throw fail('ERR_SAVE_TICKET', 'The project batch is invalid, expired, consumed, or belongs to another owner.');
    return batch;
  }
  function batchCheck(batch) {
    if (now() >= batch.hardDeadline) void closeProjectBatch(batch);
    if (batch.abort.signal.aborted || batch.state === 'closing') throw fail('ERR_SAVE_CANCELLED', 'The project batch was cancelled.');
  }
  function releaseBatchTargets(batch, keep = new Set()) {
    for (const key of batch.reserved) {
      if (keep.has(key)) continue;
      const owners = reservedTargets.get(key); owners?.delete(batch);
      if (owners?.size === 0) reservedTargets.delete(key);
      batch.reserved.delete(key);
    }
  }
  function dropProjectBatch(batch) {
    if (batches.get(batch.ticket) !== batch) return;
    releaseBatchTargets(batch);
    for (const child of batch.children.values()) pending.delete(child.ticket);
    batchChildren -= batch.declarations; batchInputs -= batch.inputBytes; batchPinChars -= batch.pinChars;
    batches.delete(batch.ticket); prune();
  }
  /** Abort is immediate; occupied operations, pins and capacity survive until cleanup settles. */
  function closeProjectBatch(batch) {
    if (batch.closing) return batch.closing;
    batch.state = 'closing'; batch.abort.abort();
    for (const child of batch.children.values()) child.abort.abort();
    batch.closing = Promise.resolve().then(async () => {
      const tasks = [...batch.children.values()].map((child) => child.task).filter((task) => task !== undefined);
      if (batch.task) tasks.push(batch.task);
      await Promise.allSettled(tasks); dropProjectBatch(batch);
    });
    return batch.closing;
  }
  function issueProjectBatch(owner) {
    reap(); checkOwner(owner, 'drawing');
    if (batches.size >= maxBatchParents || [...batches.values()].some((batch) => batch.owner === owner)) throw fail('ERR_SAVE_BATCH_CAPACITY', 'Only one project batch per owner and two host batches may be pending.');
    const ticket = randomBytes(24).toString('hex'), time = now();
    batches.set(ticket, { ticket, owner, order: ++order, deadline: time + ttlMs, hardDeadline: time + batchHardLifeMs,
      state: 'issued', abort: new AbortController(), children: new Map(), selected: new Set(), reserved: new Set(), transitions: new Map(), declarations: 0, pinChars: 0, inputBytes: 0 });
    return ticket;
  }
  /** Bind every native pin before exposing a manifest or allowing any source read. */
  function bindProjectBatch(ticket, owner, values) {
    const batch = getProjectBatch(ticket, owner); batchCheck(batch);
    if (batch.state !== 'issued' || !Array.isArray(values) || values.length > maxBatchChildren) throw fail('ERR_SAVE_BATCH_MANIFEST', 'A project batch requires a bounded, dense path manifest.');
    // Array.prototype.map does not visit holes; validate all indices explicitly.
    const paths = []; let chars = 0;
    for (let index = 0; index < values.length; index++) {
      if (!Object.hasOwn(values, index)) throw fail('ERR_SAVE_BATCH_MANIFEST', 'A project batch requires a dense path manifest.');
      const logicalPath = absoluteWindowsPath(values[index]); paths.push(logicalPath); chars += logicalPath.length;
    }
    if (values.length > maxBatchChildren - batchChildren || chars > maxBatchPinChars - batchPinChars) throw fail('ERR_SAVE_BATCH_LIMIT', 'The project path or child budget is exhausted.');
    const release = claimBatchOperation();
    batch.declarations = values.length; batchChildren += values.length; batch.pinChars = chars; batchPinChars += chars; batch.state = 'binding';
    const task = (async () => {
      try {
        const targets = new Set(), manifest = [];
        for (let index = 0; index < paths.length; index++) {
          batchCheck(batch);
          const entry = { ticket: randomBytes(24).toString('hex'), owner, kind: 'drawing', order: batch.order, deadline: batch.deadline,
            state: /** @type {'bound'} */ ('bound'), abort: new AbortController(), batch };
          const root = await permission(entry, paths[index], true); batchCheck(batch);
          const pin = await identity.captureWriteTarget(paths[index], root); batchCheck(batch);
          if (!pin.parentExists) throw fail('ENOENT', 'A project source parent does not exist.');
          const retainedChars = JSON.stringify(pin.exists ? { ...pin, hashContent: true, contentLimit: MAX_CONTENT_BYTES, fileVersion: { ...pin.fileVersion, sha256: '0'.repeat(64) } } : pin).length;
          if (retainedChars > maxBatchPinChars - batchPinChars) throw fail('ERR_SAVE_BATCH_LIMIT', 'The project native-pin character budget is exhausted.');
          batch.pinChars += retainedChars; batchPinChars += retainedChars;
          if (!pin.exists) { manifest.push(Object.freeze({ index, path: paths[index], missing: true })); continue; }
          if (targets.has(pin.targetKey)) throw fail('ERR_SAVE_BATCH_DUPLICATE', 'Multiple project drawings resolve to the same native file.');
          targets.add(pin.targetKey);
          if (!pin.fileVersion || !/^\d+$/.test(pin.fileVersion.size)) throw fail('ERR_SAVE_BATCH_LIMIT', 'A native bounded project source size is required.');
          const size = BigInt(pin.fileVersion.size);
          if (size > BigInt(maxBatchInputBytes - batchInputs)) throw fail('ERR_SAVE_BATCH_LIMIT', 'The aggregate project source budget is exhausted.');
          const inputBytes = Number(size); batch.inputBytes += inputBytes; batchInputs += inputBytes;
          const child = Object.assign(entry, { pin, root });
          batch.children.set(child.ticket, child); pending.set(child.ticket, child);
          manifest.push(Object.freeze({ index, path: paths[index], childTicket: child.ticket, identityPath: pin.canonicalPath, exists: true }));
        }
        // Reserve the complete source-byte and retained-pin budgets before any
        // descriptor hash is opened; a later oversized source aborts before reads.
        await checkBatchSources([...batch.children.values()], (child) => withBatchMetadata(async () => {
          batchCheck(batch);
          child.pin = await contentPin(child.pin, batch.abort.signal); batchCheck(batch);
        }));
        // Recheck the entire source basis: a late bind must not conceal an edit
        // to an earlier file or grant while this manifest was being assembled.
        await checkBatchSources([...batch.children.values()], (child) => strictBatchGuard(child));
        batchCheck(batch); batch.state = 'bound'; batch.deadline = now() + ttlMs;
        return Object.freeze(manifest);
      } catch (error) { batch.abort.abort(); dropProjectBatch(batch); throw annotate(error, false); }
      finally { release(); }
    })();
    batch.task = task; return task;
  }
  async function strictBatchGuard(entry, basis = false, allowCommitted = false) {
    const pin = entry.pin;
    if (!pin || !entry.batch) throw fail('ERR_SAVE_TICKET', 'A native project source pin is required.');
    return withBatchMetadata(async () => {
      batchCheck(entry.batch); if (!basis) abortCheck(entry);
      await permission(entry, pin.logicalPath); batchCheck(entry.batch); if (!basis) abortCheck(entry);
      const current = await identity.revalidate(pin, { preserveLeaf: true, preserveVersion: !allowCommitted, signal: basis ? entry.batch.abort.signal : entry.abort.signal });
      const actual = fileVersionKey(current.fileVersion);
      if (allowCommitted && actual !== fileVersionKey(pin.fileVersion)
        && (!entry.batch.transitions.has(pin.targetKey) || entry.batch.transitions.get(pin.targetKey) !== actual)) throw targetChanged();
      const previous = ledger.get(current.targetKey);
      if (previous && previous.order > entry.order) throw fail('ERR_SAVE_STALE', 'A newer host save has already reached this project source.');
      batchCheck(entry.batch);
    });
  }
  /** O(n) per guard, O(n²) for all outputs; no atomic multi-file guarantee. */
  async function guardProjectBasis(batch) {
    await checkBatchSources([...batch.children.values()].filter((child) => child.readDone), (child) => strictBatchGuard(child, true, true));
  }
  /**
   * The trusted host reader must compare its held FD version to scope.pin before
   * allocating bytes. Read/decode is once-only, and the same original basis is
   * checked before/after; legitimate earlier host saves still invalidate it.
   * @param {string} ticket @param {object} owner @param {string} childTicket
   * @param {(scope:ProjectBatchReadScope)=>Promise<unknown>} operation
   */
  function readProjectBatch(ticket, owner, childTicket, operation) {
    const batch = getProjectBatch(ticket, owner); batchCheck(batch);
    const entry = batch.children.get(childTicket);
    if (batch.state !== 'bound' || !entry || entry.state !== 'bound' || entry.readDone || typeof operation !== 'function') throw fail('ERR_SAVE_TICKET', 'A bound project child can be read only once.');
    const pin = entry.pin;
    if (!pin?.fileVersion) throw fail('ERR_SAVE_TICKET', 'A captured native project source is required.');
    const inputBytes = Number(pin.fileVersion.size);
    const release = claimBatchOperation(); entry.state = 'reading';
    const task = (async () => {
      let active = true;
      const guard = async () => {
        if (!active || entry.state !== 'reading' || pending.get(entry.ticket) !== entry) throw fail('ERR_SAVE_TICKET', 'The project source read is no longer active.');
        await strictBatchGuard(entry);
      };
      try {
        await guard();
        const result = await operation(Object.freeze({ pin, signal: entry.abort.signal, inputBytes, guard }));
        await guard(); entry.readDone = true; batch.deadline = now() + ttlMs; return result;
      } catch (error) { void closeProjectBatch(batch); throw annotate(error, false); }
      finally { active = false; entry.state = 'bound'; release(); }
    })();
    entry.task = task; return task;
  }
  function selectedBatchChildren(batch, values, subset = false) {
    if (!Array.isArray(values) || values.length > maxBatchChildren) throw fail('ERR_SAVE_BATCH_MANIFEST', 'A bounded project child selection is required.');
    const selected = new Set();
    for (let index = 0; index < values.length; index++) {
      const ticket = values[index], child = batch.children.get(ticket);
      if (!Object.hasOwn(values, index) || typeof ticket !== 'string' || selected.has(ticket) || !child || child.state !== 'bound' || !child.readDone || pending.get(ticket) !== child || subset && !batch.selected.has(ticket)) throw fail('ERR_SAVE_TICKET', 'The selected project children must be unique, read and bound to this parent.');
      selected.add(ticket);
    }
    return selected;
  }
  function reserveBatchTargets(batch, selected) {
    prune(); const keys = batchTargetKeys(batch, selected);
    const union = new Set([...ledger.keys(), ...reservedTargets.keys(), ...keys]);
    if (union.size > maxLedger) throw fail('ERR_SAVE_LEDGER_LIMIT', 'Project save ordering capacity is unavailable before mutation.');
    for (const key of keys) {
      let owners = reservedTargets.get(key); if (!owners) { owners = new Set(); reservedTargets.set(key, owners); }
      owners.add(batch); batch.reserved.add(key);
    }
  }
  function batchTargetKeys(batch, selected) {
    return new Set([...selected].map((ticket) => {
      const pin = batch.children.get(ticket)?.pin;
      if (!pin) throw fail('ERR_SAVE_TICKET', 'The project child pin is no longer active.');
      return pin.targetKey;
    }));
  }
  function discardBatchChildren(batch, selected) {
    for (const [ticket, entry] of batch.children) if (!selected.has(ticket)) {
      pending.delete(ticket);
      // Successfully read sources remain the immutable calculation basis even
      // when unchanged or declined for writing. Only their write capability ends.
      if (!entry.readDone) { entry.abort.abort(); batch.children.delete(ticket); }
    }
  }
  /** Reserve capacity only; aborted calculation must not publish attempted save orders. */
  function sealProjectBatch(ticket, owner, values) {
    const batch = getProjectBatch(ticket, owner); batchCheck(batch);
    if (batch.state !== 'bound') throw fail('ERR_SAVE_TICKET', 'The project batch can be sealed only once after source reads.');
    const selected = selectedBatchChildren(batch, values), release = claimBatchOperation(); batch.state = 'sealing';
    const task = (async () => {
      try {
        await checkBatchSources([...batch.children.values()].filter((child) => child.readDone), (child) => strictBatchGuard(child, true));
        batchCheck(batch); reserveBatchTargets(batch, selected); discardBatchChildren(batch, selected);
        batch.selected = selected; batch.state = 'sealed'; batch.deadline = now() + ttlMs;
      } catch (error) { if (!batch.abort.signal.aborted) batch.state = 'bound'; throw annotate(error, false); }
      finally { release(); }
    })();
    batch.task = task; return task;
  }
  /** Final preflight permits a subset after declined backups; it does not rebind sources. */
  function beginProjectBatchCommit(ticket, owner, values) {
    const batch = getProjectBatch(ticket, owner); batchCheck(batch);
    if (batch.state !== 'sealed') throw fail('ERR_SAVE_TICKET', 'A sealed project batch is required before committing.');
    const selected = selectedBatchChildren(batch, values === undefined ? [...batch.selected] : values, true);
    const release = claimBatchOperation(); batch.state = 'beginning';
    const task = (async () => {
      try {
        await checkBatchSources([...batch.children.values()].filter((child) => child.readDone), (child) => strictBatchGuard(child, true));
        batchCheck(batch);
        const keys = batchTargetKeys(batch, selected);
        releaseBatchTargets(batch, keys); discardBatchChildren(batch, selected);
        batch.selected = selected; batch.state = 'committing';
      } catch (error) { void closeProjectBatch(batch); throw annotate(error, false); }
      finally { release(); }
    })();
    batch.task = task; return task;
  }
  function cancelProjectBatch(ticket, owner) { return closeProjectBatch(getProjectBatch(ticket, owner)); }
  /**
   * Copy preparation (such as a bulk command's backup) uses the same namespace
   * queue as its subsequent save, without consuming the ticket or claiming that
   * the original file was saved. A failed copy keeps a noncancelled ticket bound
   * so the caller can explicitly continue without a backup. No observed outside
   * edit becomes an own version transition. The callback must await guard before
   * replacing its backup, and join all its cleanup before returning/rejecting.
   * @param {string} ticket @param {object} owner @param {string} kind @param {string} value
   * @param {(context:PreparationContext)=>Promise<unknown>} operation
   * @returns {Promise<Readonly<{status:'prepared',value:unknown}|{status:'stale',committed:false}>>}
   */
  function prepare(ticket, owner, kind, value, operation) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'bound' || typeof operation !== 'function') throw fail('ERR_SAVE_TICKET', 'A bound ticket and copy preparation are required.');
    if (entry.batch && (!entry.batch.selected.has(ticket) || entry.batch.state !== 'sealed' && entry.batch.state !== 'committing')) throw fail('ERR_SAVE_TICKET', 'Project backups require a selected child of a sealed batch.');
    const initial = samePath(entry, value);
    const release = entry.batch ? claimBatchOperation() : () => {};
    entry.state = 'preparing';
    const task = (async () => {
      try {
        abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
        return await enqueueProjectWrite(entry, initial.queueKey, async () => {
          abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
          const current = await identity.revalidate(initial, { signal: entry.abort.signal });
          if (!current.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
          await entry.lifecycle?.validateSource?.(current); abortCheck(entry);
          if (entry.lifecycle?.validateSource) await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
          const checkOrder = (target) => {
            const previous = ledger.get(target.targetKey);
            if (previous && previous.order > entry.order) throw fail('ERR_SAVE_STALE', 'A newer host save has already reached this file.');
            return previous;
          };
          checkVersion(initial, current, checkOrder(current));
          let active = true;
          const activeCheck = () => { if (!active || entry.state !== 'preparing' || pending.get(entry.ticket) !== entry) throw fail('ERR_SAVE_TICKET', 'The backup preparation is no longer active.'); };
          const guardParents = async () => { activeCheck(); await identity.revalidate(current, { preserveLeaf: true, metadataOnly: true }); };
          const guard = async () => {
            activeCheck(); abortCheck(entry);
            if (entry.batch) await guardProjectBasis(entry.batch);
            abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
            const target = await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
            await entry.lifecycle?.validateSource?.(target); abortCheck(entry);
            // Native root/version/content checks stay last after async source work.
            if (entry.lifecycle?.validateSource) await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
            checkOrder(target);
          };
          try {
            await guard();
            const result = await operation(Object.freeze({ logicalPath: initial.logicalPath, destinationPath: current.destinationPath, canonicalPath: current.canonicalPath,
              ...(entry.root === undefined ? {} : { root: entry.root }), signal: entry.abort.signal, guard, guardParents }));
            await guard(); return Object.freeze({ status: /** @type {'prepared'} */ ('prepared'), value: result });
          } finally { active = false; }
        });
      } catch (error) {
        if (error?.code === 'ERR_SAVE_STALE' && !entry.abort.signal.aborted) return Object.freeze({ status: 'stale', committed: false });
        throw annotate(error, false);
      } finally {
        if (entry.abort.signal.aborted) finish(entry);
        else { entry.state = 'bound'; entry.deadline = now() + ttlMs; if (entry.batch) entry.batch.deadline = entry.deadline; prune(); }
        release();
      }
    })();
    entry.task = task; return task;
  }
  function run(ticket, owner, kind, value, operation) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'bound' || typeof operation !== 'function') throw fail('ERR_SAVE_TICKET', 'A bound ticket and save operation are required.');
    if (entry.batch && (!entry.batch.selected.has(ticket) || entry.batch.state !== 'committing')) throw fail('ERR_SAVE_TICKET', 'Project child saves require a completed batch preflight.');
    const initial = samePath(entry, value);
    const release = entry.batch ? claimBatchOperation() : () => {};
    entry.state = 'running';
    let attempted = false, committed = false, stale = false, writeResult, commitEvidence;
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
        const pdf = entry.kind === 'pdf-export';
        if (bytes > (pdf ? maxPdfPayloadBytes : maxPayloadBytes) || bytes > (pdf ? maxPdfQueuedBytes - pdfQueuedBytes : maxQueuedBytes - ordinaryQueuedBytes) || bytes > maxSharedQueuedBytes - queuedBytes) throw fail('ERR_SAVE_PAYLOAD_LIMIT', 'The pending save payload budget is exhausted.');
        queuedBytes += bytes;
        if (pdf) pdfQueuedBytes += bytes; else ordinaryQueuedBytes += bytes;
        try {
          // Copy only after authorization and reserve before allocation/queueing.
          const snapshot = typeof payload === 'string' ? payload : new Uint8Array(payload);
          const expectedDigest = createHash('sha256').update(snapshot).digest('hex');
          return await enqueueProjectWrite(entry, initial.queueKey, async () => {
            abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
            const current = await identity.revalidate(initial, { signal: entry.abort.signal });
            if (!current.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
            await entry.lifecycle?.validateSource?.(current); abortCheck(entry);
            if (entry.lifecycle?.validateSource) await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
            const previous = ledger.get(current.targetKey);
            if (previous && previous.order > entry.order) { stale = true; throw fail('ERR_SAVE_STALE', 'A newer host save has already reached this file.'); }
            checkVersion(initial, current, previous);
            prune();
            if (!ledger.has(current.targetKey) && !reservedTargets.has(current.targetKey) && orderingSlots() >= maxLedger) throw fail('ERR_SAVE_LEDGER_LIMIT', 'Save ordering history is full while older work remains pending.');
            const record = { order: entry.order, after: fileVersionKey(current.fileVersion), origins: originsFor(current, previous), parentPath: current.canonicalParent, targetPath: current.canonicalPath };
            ledger.set(current.targetKey, record);
            const guardParents = async () => { await identity.revalidate(current, { preserveLeaf: true, metadataOnly: true }); };
            const guard = async () => {
              abortCheck(entry);
              if (entry.batch) await guardProjectBasis(entry.batch);
              abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
              const target = await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
              await entry.lifecycle?.validateSource?.(target); abortCheck(entry);
              if (entry.lifecycle?.validateSource) await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
            };
            /** @type {Promise<void>|undefined} */ let markTask;
            const markCommitted = () => {
              if (markTask) return markTask;
              committed = true;
              markTask = (async () => {
                const after = await identity.revalidate(current, { preserveLeaf: true });
                if (after.fileVersion?.sha256 !== expectedDigest) throw targetChanged();
                record.after = fileVersionKey(after.fileVersion); record.origins.add(record.after);
                if (entry.batch) entry.batch.transitions.set(current.targetKey, record.after);
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
              commitEvidence = Object.freeze({ target: verified });
              verifiedCommits.set(commitEvidence, { owner: entry.owner, pin: verified, order: entry.order });
              entry.lifecycle?.onVerifiedCommit?.(commitEvidence);
              writeResult = result; return result;
            } finally {
              if (markTask) await markTask;
              // An unmarked error is an uncertain attempted write. Retain its
              // order, but never adopt an external edit as an own transition.
            }
          });
        } finally { queuedBytes -= bytes; if (pdf) pdfQueuedBytes -= bytes; else ordinaryQueuedBytes -= bytes; }
      })();
      // The producer can throw/return without awaiting its callback; run still joins
      // the writer and its cleanup, and an early rejection is never unhandled.
      void commitTask.catch(() => {}); return commitTask;
    };
    const task = (async () => {
      let result, error, hasError = false;
      try {
        abortCheck(entry); await permission(entry, initial.logicalPath); abortCheck(entry);
        const preflight = async () => {
          abortCheck(entry);
          if (entry.batch) await guardProjectBasis(entry.batch);
          await permission(entry, initial.logicalPath); abortCheck(entry);
          const current = await identity.revalidate(initial, { signal: entry.abort.signal });
          if (!current.parentExists) throw fail('ENOENT', 'The save parent does not exist.');
          await entry.lifecycle?.validateSource?.(current); abortCheck(entry);
          if (entry.lifecycle?.validateSource) await identity.revalidate(current, { preserveLeaf: true, preserveVersion: true, signal: entry.abort.signal });
          const previous = ledger.get(current.targetKey);
          if (previous && previous.order > entry.order) { stale = true; return; }
          checkVersion(initial, current, previous);
        };
        try { await preflight(); }
        catch (failure) {
          // A preceding writer can be between replacement and its own proof.
          // Only retry that changed-version check after joining its queue. Stable
          // producers still snapshot/reserve their payload before queue waits.
          if (failure?.code !== 'ERR_WINDOWS_PATH_CHANGED' || !tails.has(initial.queueKey) && !(entry.batch && tails.has(`project-batch:${entry.batch.ticket}`))) throw failure;
          await enqueueProjectWrite(entry, initial.queueKey, preflight);
        }
        if (stale) return Object.freeze({ status: 'stale', committed: false });
        try { result = await operation(Object.freeze({ signal: entry.abort.signal, target: initial, commit })); }
        catch (failure) { error = failure; hasError = true; }
        if (commitTask) { try { await commitTask; } catch (failure) { if (!hasError) error = failure; hasError = true; } }
        if (stale) return Object.freeze({ status: 'stale', committed: false });
        if (hasError) throw annotate(error, committed);
        if (!committed) { abortCheck(entry); throw fail('ERR_SAVE_NO_COMMIT', 'The save operation finished without committing a file.'); }
        return Object.freeze({ status: 'saved', committed: true, cancelledAfterCommit: entry.abort.signal.aborted, value: result, writeResult, commitEvidence });
      } catch (failure) { throw annotate(failure, committed); }
      finally { finish(entry); release(); }
    })();
    entry.task = task; return task;
  }
  function cancel(ticket, owner, kind) {
    const entry = get(ticket, owner, kind); entry.abort.abort();
    if (entry.state === 'issued' || entry.state === 'bound') finish(entry);
    return true;
  }
  /** Export IPC cancellation joins the held descriptor/producer/writer cleanup.
   * Ordinary callers retain their existing synchronous cancel contract.
   */
  async function cancelJoined(ticket, owner, kind) {
    if (kind !== 'text-export' && kind !== 'pdf-export') throw fail('ERR_SAVE_TICKET', 'Joined cancellation requires a generic export kind.');
    const entry = get(ticket, owner, kind), task = entry.task;
    entry.abort.abort();
    if (entry.state === 'issued' || entry.state === 'bound') finish(entry);
    if (task) await task.then(() => undefined, () => undefined);
  }
  /** No filesystem work: validate the owner before a picker or expensive export producer. */
  function assertIssued(ticket, owner, kind) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'issued') throw fail('ERR_SAVE_TICKET', 'An unbound, issued save ticket is required.');
    return true;
  }
  function assertBound(ticket, owner, kind, value) {
    const entry = get(ticket, owner, kind);
    if (entry.state !== 'bound') throw fail('ERR_SAVE_TICKET', 'An active bound save ticket is required.');
    return samePath(entry, value);
  }
  function retireOwner(owner) {
    if (!owner || typeof owner !== 'object') throw fail('ERR_SAVE_TICKET', 'A main-owned save owner is required.');
    retired.add(owner);
    for (const batch of batches.values()) if (batch.owner === owner) void closeProjectBatch(batch);
    for (const entry of pending.values()) if (entry.owner === owner) { entry.abort.abort(); if (entry.state === 'issued' || entry.state === 'bound') finish(entry); }
    prune();
  }
  async function dispose() {
    disposed = true;
    const tasks = [];
    for (const batch of batches.values()) tasks.push(closeProjectBatch(batch));
    for (const entry of pending.values()) { entry.abort.abort(); if (entry.state === 'issued' || entry.state === 'bound') finish(entry); else if (entry.task) tasks.push(entry.task); }
    prune(); await Promise.allSettled(tasks); prune();
  }
  const stats = () => Object.freeze({ pending: ordinaryPending(), ledger: ledger.size, queuedBytes, ordinaryQueuedBytes, pdfQueuedBytes, queues: tails.size,
    batchParents: batches.size, batchChildren, batchInputBytes: batchInputs, batchPinChars, activeBatchOperations: batchActive, metadataActive, metadataQueued: metadataWaiters.length, reservedTargets: reservedTargets.size, orderingSlots: orderingSlots() });
  return Object.freeze({ issue, bind, prepare, run, cancel, cancelJoined, assertIssued, assertBound, retireOwner, dispose, stats,
    issueProjectBatch, bindProjectBatch, readProjectBatch, sealProjectBatch, beginProjectBatchCommit, cancelProjectBatch });
}
module.exports = { SAVE_KINDS, SAVE_ADMISSION_LIMITS: LIMITS, createSaveAdmissions, verifiedCommitTarget, verifiedCommitOrder };
