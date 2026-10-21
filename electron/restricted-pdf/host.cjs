/**
 * Job host for the restricted PDF transform (milestone 12.4; lifecycle and
 * memory accounting corrected in the post-review round).
 *
 * Owns the child-process lifecycle the spike design requires:
 *   - one-shot children (Electron utilityProcess; plain fork off-Electron),
 *     spawned per job, never reused;
 *   - ONE active transform by default. A job's memory is reserved in stages
 *     against a single aggregate budget before the work exists: the queued
 *     stage holds the input bytes; activation converts that into the full
 *     envelope — the IPC transfer copy, the MEMFS input capacity, the
 *     engine workspace (its declared linear-memory maximum), the MEMFS
 *     output capacity (one allocator doubling over the output size cap)
 *     and the readback copy. A job whose envelope does not fit WAITS; it
 *     is never started on a hope. Every reservation is refunded when its
 *     job settles — on success, refusal, cancellation and disposal alike —
 *     and the tests prove the refunds. (A multi-engine budget would need
 *     its own admission decision; maxActive > 1 is possible only because
 *     the same aggregate budget still gates every activation.)
 *   - a per-job deadline enforced HERE in the parent (a timer inside the
 *     child cannot interrupt a synchronous engine call): on expiry the
 *     child is killed and its slot is released only after the child's exit
 *     is observed (EXIT JOIN) — a replacement job never shares the machine
 *     with a zombie;
 *   - the child's ACTUAL exit outcome decides success: a job resolves only
 *     when a validated output arrived AND the child then exited on its own
 *     with code 0. Output followed by a non-zero exit is a failure, and a
 *     child is never killed preemptively after reporting success — the
 *     host simply waits for its natural exit. If a terminated child does
 *     not exit within the termination grace, the job fails AND the host
 *     quarantines itself: it refuses further transforms rather than hang
 *     forever or reuse a slot whose process state is unconfirmed;
 *   - disposal tracks ACTIVE jobs too: it latches a closure failure into
 *     every active job, kills their children and completes only after
 *     each exit is joined (or quarantined by the grace path). Late output
 *     from a disposed job is ignored, so it can never resolve;
 *   - entering quarantine settles the whole queue immediately (round-2
 *     correction): every queued transform rejects with the unavailable
 *     error and refunds its input staging in the same moment, without
 *     waiting for a caller abort or disposal. Only the unconfirmed active
 *     child's reservation stays held, until its late exit refunds it
 *     exactly once; the quarantined host never silently reopens.
 *
 * Total accounting, stated plainly: the 768 MiB figure is ONLY the WASM
 * engine's declared linear-memory maximum inside the child — never a
 * process cap. The host's aggregate budget gates ACTIVE stage envelopes
 * (one maximum-size envelope is 1,923 MiB: transfer + MEMFS input + the
 * 768 MiB workspace + MEMFS output + readback), and queued input staging
 * is bounded SEPARATELY by the queue byte cap (128 MiB by default), so
 * the host's accounted reservations can reach envelope + queue cap
 * before any unaccounted runtime/transport copies.
 *
 * Before the first job, the shipped engine artifacts are verified against
 * build-receipt.json (hashes, and the WASM binary's declared maximum linear
 * memory parsed statically) — a swapped or uncapped artifact disables the
 * mode instead of silently running.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const CHILD_PATH = path.join(__dirname, 'qpdf-child.cjs');
const ASSETS = path.join(__dirname, 'assets');
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_DECLARED_MEMORY = 805306368; // 768 MiB, the pinned production cap
const outputLimit = (inputBytes) => 2 * inputBytes + 1024 * 1024;

/**
 * The full stage envelope one active job reserves, in bytes: IPC transfer
 * copy (input), MEMFS input capacity (input plus one allocator doubling of
 * headroom), the engine workspace at its declared maximum, MEMFS output
 * capacity (the output size cap plus one allocator doubling) and the
 * readback copy (the output size cap). The default aggregate budget is
 * exactly one maximum-size job's envelope, so the default host never holds
 * reservations for more work than one largest job.
 */
function stageEnvelope(inputBytes) {
  const limit = outputLimit(inputBytes);
  return inputBytes + 2 * inputBytes + MAX_DECLARED_MEMORY + 2 * limit + limit;
}
const DEFAULT_MAX_AGGREGATE_BYTES = stageEnvelope(MAX_INPUT_BYTES);

/** Static WASM memory-section parse (no instantiation): declared maximum bytes or null. */
function declaredMaximumMemory(bytes) {
  let pos = 8;
  const u8 = () => bytes[pos++];
  const uleb = () => { let result = 0, shift = 0; for (;;) { const b = u8(); result |= (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return result; shift += 7; } };
  const skipName = () => { pos += uleb(); };
  let maximum = null;
  while (pos < bytes.length) {
    const id = u8(), size = uleb(), end = pos + size;
    if (id === 2) {
      const count = uleb();
      for (let i = 0; i < count; i++) {
        skipName(); skipName(); const kind = u8();
        if (kind === 0x02) { const flags = uleb(); uleb(); maximum = (flags & 0x01) ? uleb() * 65536 : null; }
        else if (kind === 0x00) uleb();
        else if (kind === 0x01) { const f = uleb(); uleb(); if (f & 0x01) uleb(); }
        else if (kind === 0x03) uleb();
      }
    } else if (id === 5) {
      const count = uleb();
      for (let i = 0; i < count; i++) { const flags = uleb(); uleb(); if (flags & 0x01) maximum = uleb() * 65536; }
    }
    pos = end;
  }
  return maximum;
}

/** Verify artifact hashes + declared memory cap against the build receipt. Throws on any mismatch. */
function verifyAssets(assetsDir = ASSETS) {
  const receipt = JSON.parse(fs.readFileSync(path.join(assetsDir, 'build-receipt.json'), 'utf8'));
  const wasm = fs.readFileSync(path.join(assetsDir, 'qpdf.wasm'));
  const js = fs.readFileSync(path.join(assetsDir, 'qpdf.js'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (hash(wasm) !== receipt.qpdfWasmSha256) throw new Error('The restricted PDF engine artifact does not match its build receipt (qpdf.wasm).');
  if (hash(js) !== receipt.qpdfJsSha256) throw new Error('The restricted PDF engine artifact does not match its build receipt (qpdf.js).');
  const declared = declaredMaximumMemory(wasm);
  if (declared !== MAX_DECLARED_MEMORY || receipt.maximumMemoryBytes !== MAX_DECLARED_MEMORY) {
    throw new Error('The restricted PDF engine artifact does not declare the pinned 768 MiB memory cap.');
  }
  return receipt;
}

/**
 * Default child spawner: Electron utilityProcess inside the desktop host,
 * plain fork elsewhere. Inside Electron a failed utilityProcess fork FAILS
 * CLOSED (throws): silently downgrading to a plain fork there would run
 * the engine outside the desktop host's process governance. The plain-fork
 * fallback exists only for genuine non-Electron hosts (tests, tooling).
 */
function defaultSpawn() {
  if (typeof process.versions.electron === 'string') {
    const { utilityProcess } = require('electron');
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
      throw new Error('The restricted PDF engine is unavailable in this desktop host.');
    }
    const child = utilityProcess.fork(CHILD_PATH, [], { serviceName: 'JCad restricted PDF', stdio: 'ignore' });
    return {
      send: (message) => child.postMessage(message),
      kill: () => { try { child.kill(); } catch { /* already gone */ } },
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.on('exit', fn),
      onError: (fn) => { if (typeof child.on === 'function') child.on('error', fn); },
    };
  }
  const { fork } = require('node:child_process');
  const child = fork(CHILD_PATH, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return {
    send: (message) => child.send(message),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn(code)),
    onError: (fn) => child.on('error', fn),
  };
}

/**
 * @typedef {object} RestrictedPdfChild
 * @property {(message: any) => void} send
 * @property {() => void} kill
 * @property {(fn: (m: any) => void) => void} onMessage
 * @property {(fn: (code: any) => void) => void} onExit
 * @property {((fn: (e: any) => void) => void)} [onError]
 */

/**
 * @param {{ spawn?: () => RestrictedPdfChild,
 *   timeoutMs?: number, terminationGraceMs?: number,
 *   maxActive?: number, maxQueued?: number, maxQueuedBytes?: number,
 *   maxAggregateBytes?: number, assetsDir?: string }} [options]
 */
function createRestrictedPdfHost(options = {}) {
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const terminationGraceMs = options.terminationGraceMs ?? 5_000;
  const maxActive = options.maxActive ?? 1;
  const maxQueued = options.maxQueued ?? 4;
  const maxQueuedBytes = options.maxQueuedBytes ?? MAX_INPUT_BYTES;
  const maxAggregateBytes = options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
  for (const [name, value] of Object.entries({ timeoutMs, terminationGraceMs, maxActive, maxQueued, maxQueuedBytes, maxAggregateBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid restricted PDF host option: ${name}`);
  }

  /** @typedef {object} Job
   * @property {Uint8Array} input @property {(v: Uint8Array) => void} resolve @property {(e: Error) => void} reject
   * @property {AbortSignal} [signal] @property {() => void} [onAbort]
   * @property {'queued' | 'active'} state @property {number} reserved @property {number} heldReservation
   * @property {RestrictedPdfChild | null} child @property {Uint8Array | null} output
   * @property {Error | null} failure @property {boolean} exited @property {boolean} terminating
   * @property {boolean} settled @property {Promise<void>} settledPromise @property {() => void} notifySettled
   * @property {NodeJS.Timeout | null} timer @property {NodeJS.Timeout | null} graceTimer
   */
  /** @type {Job[]} */
  const queue = [];
  /** @type {Set<Job>} */
  const activeJobs = new Set();
  let queuedBytes = 0;
  /** Sum of the stage envelopes of ACTIVE jobs: what the aggregate budget gates. */
  let activeReserved = 0;
  /** Reservations held past settlement for children whose exit was never
   * confirmed (quarantine): still honestly accounted until a late exit. */
  let heldReserved = 0;
  let disposed = false;
  let quarantined = false;
  let verified = false;
  /** @type {Promise<void> | null} */
  let disposePromise = null;

  function fail(message) { return new Error(`Restricted PDF: ${message}`); }
  const closedError = () => fail('the restricted PDF service is closed');
  const unavailableError = () => fail('the restricted PDF service is unavailable: a transform process did not exit after termination, so its slot is quarantined');

  /** Settle a job exactly once: detach listeners, refund its reservation, release waiters. */
  function settle(job, error, output) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (job.graceTimer) { clearTimeout(job.graceTimer); job.graceTimer = null; }
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (job.state === 'queued') {
      const at = queue.indexOf(job);
      if (at >= 0) queue.splice(at, 1);
      queuedBytes -= job.input.byteLength;
    }
    if (job.state === 'active') activeReserved -= job.reserved;
    activeJobs.delete(job);
    job.reserved = 0;
    if (error) job.reject(error); else job.resolve(/** @type {Uint8Array} */ (output));
    job.notifySettled();
    pump();
  }

  /**
   * Terminate an active job's child and arm the grace timer. The job
   * settles when the exit is observed; if the grace expires first, the
   * job fails with an unconfirmed-termination error and the host
   * quarantines (its reservation stays held — the process state is
   * unknown, so the memory is honestly still accounted).
   */
  function terminate(job) {
    if (!job.child || job.exited || job.terminating) return;
    job.terminating = true;
    try { job.child.kill(); } catch { /* a failed kill is decided by the grace path, not by hope */ }
    job.graceTimer = setTimeout(() => {
      job.graceTimer = null;
      if (job.settled || job.exited) return;
      quarantined = true;
      // The reservation is NOT refunded: the process state is unconfirmed,
      // so its memory stays accounted (heldReserved) until a late exit
      // proves the process is gone. The host is quarantined either way.
      job.heldReservation = job.reserved;
      heldReserved += job.reserved;
      settle(job, fail('the transform process did not exit after termination; the host is unavailable'));
      // Entering quarantine settles the QUEUE in the same moment. A queued
      // job has no timer of its own and pump() refuses while quarantined,
      // so leaving it queued would hang its caller until some unrelated
      // abort/dispose — with its staging reservation held the whole time.
      // Reject every queued transform now and refund its staging; only the
      // unconfirmed active reservation above stays held.
      for (const waiting of [...queue]) settle(waiting, unavailableError());
    }, terminationGraceMs);
    job.graceTimer.unref?.();
  }

  /** Latch the first failure cause into a job; active jobs are terminated and exit-joined. */
  function failJob(job, error) {
    if (job.settled) return;
    if (job.state === 'queued') { settle(job, error); return; }
    if (!job.failure) job.failure = error;
    if (!job.child) { settle(job, job.failure); return; }
    terminate(job);
  }

  function onChildExit(job, code) {
    job.exited = true;
    if (job.graceTimer) { clearTimeout(job.graceTimer); job.graceTimer = null; }
    if (job.heldReservation) { heldReserved -= job.heldReservation; job.heldReservation = 0; }
    if (job.settled) return;
    if (job.failure) { settle(job, job.failure); return; }
    if (code === 0 && job.output) { settle(job, null, job.output); return; }
    if (job.output) { settle(job, fail(`the transform process exited with code ${String(code)} after replying; the output was discarded`)); return; }
    settle(job, fail('the transform process exited before replying'));
  }

  function onChildMessage(job, message) {
    if (job.settled || job.failure || job.exited) return; // late output is never used
    if (message && typeof message.error === 'string' && message.error) { failJob(job, fail(message.error.slice(0, 512))); return; }
    if (message && message.output instanceof Uint8Array) {
      const out = message.output;
      if (out.byteLength < 8 || out.byteLength > outputLimit(job.input.byteLength)
        || Buffer.from(out.subarray(0, 8)).toString('latin1') !== '%PDF-1.7') {
        failJob(job, fail('the transform produced an invalid document'));
        return;
      }
      // Hold the validated output: success is decided by the exit outcome.
      job.output = out;
      return;
    }
    failJob(job, fail('the transform produced an invalid response'));
  }

  function startJob(job) {
    let child;
    try { child = spawn(); } catch { failJob(job, fail('the transform process could not start')); return; }
    job.child = child;
    child.onMessage((message) => onChildMessage(job, message));
    child.onExit((code) => onChildExit(job, code));
    if (typeof child.onError === 'function') {
      child.onError(() => failJob(job, fail('the transform process channel failed')));
    }
    job.timer = setTimeout(() => failJob(job, fail('the transform timed out')), timeoutMs);
    try { child.send({ input: job.input }); } catch { failJob(job, fail('the transform process could not receive the document')); }
  }

  function pump() {
    if (disposed || quarantined) return;
    while (activeJobs.size < maxActive && queue.length) {
      const job = /** @type {Job} */ (queue[0]);
      const envelope = stageEnvelope(job.input.byteLength);
      // The aggregate budget gates ACTIVE envelopes. Queued staging is
      // bounded separately by the queue byte cap, so a waiting job can
      // never deadlock the head of the queue.
      if (activeReserved + envelope > maxAggregateBytes) return; // waits for refunds
      queue.shift();
      queuedBytes -= job.input.byteLength;
      activeReserved += envelope;
      job.reserved = envelope;
      job.state = 'active';
      activeJobs.add(job);
      if (job.signal?.aborted) { failJob(job, fail('the export was cancelled')); continue; }
      startJob(job);
    }
  }

  /**
   * Transform one frozen plaintext PDF into its restricted form.
   * @param {Uint8Array} input @param {AbortSignal} [signal]
   * @returns {Promise<Uint8Array>} ciphertext bytes (a fresh buffer owned by the caller)
   */
  function transform(input, signal) {
    if (disposed) return Promise.reject(closedError());
    if (quarantined) return Promise.reject(unavailableError());
    if (!(input instanceof Uint8Array) || input.byteLength < 8 || input.byteLength > MAX_INPUT_BYTES
      || Buffer.from(input.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      return Promise.reject(fail('invalid PDF payload'));
    }
    if (signal?.aborted) return Promise.reject(fail('the export was cancelled'));
    if (stageEnvelope(input.byteLength) > maxAggregateBytes) {
      return Promise.reject(fail('the document exceeds the restricted PDF memory budget'));
    }
    if (!verified) {
      try { verifyAssets(options.assetsDir ?? ASSETS); verified = true; }
      catch (error) { return Promise.reject(error instanceof Error ? error : fail('engine verification failed')); }
    }
    return new Promise((resolve, reject) => {
      /** @type {Job} */
      const job = {
        input, resolve, reject, signal,
        state: 'queued', reserved: 0, heldReservation: 0,
        child: null, output: null, failure: null,
        exited: false, terminating: false, settled: false,
        timer: null, graceTimer: null,
        settledPromise: /** @type {Promise<void>} */ (/** @type {unknown} */ (undefined)),
        notifySettled: () => {},
      };
      job.settledPromise = new Promise((done) => { job.notifySettled = done; });
      // Admission: the queued stage reserves the input bytes. The queue's
      // own count/byte caps are unchanged from the original design and
      // apply whenever the job cannot start immediately — because a slot
      // is busy OR because the aggregate budget makes it wait.
      const envelope = stageEnvelope(input.byteLength);
      const startsNow = queue.length === 0 && activeJobs.size < maxActive
        && activeReserved + envelope <= maxAggregateBytes;
      if (!startsNow && (queue.length >= maxQueued || queuedBytes + input.byteLength > maxQueuedBytes)) {
        reject(fail('too many restricted PDF jobs are waiting'));
        return;
      }
      job.reserved = input.byteLength;
      queuedBytes += input.byteLength;
      queue.push(job);
      if (signal) {
        job.onAbort = () => failJob(job, fail('the export was cancelled'));
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      pump();
    });
  }

  /**
   * Dispose the host: reject queued jobs immediately; latch closure into
   * every ACTIVE job, kill its child and complete only after each exit is
   * joined (or the termination grace quarantines the host). Idempotent.
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      const error = closedError();
      for (const job of [...queue]) settle(job, error);
      const actives = [...activeJobs];
      for (const job of actives) failJob(job, error);
      await Promise.all(actives.map((job) => job.settledPromise));
    })();
    return disposePromise;
  }

  return {
    transform,
    dispose,
    stats: () => ({ active: activeJobs.size, queued: queue.length, queuedBytes, reservedBytes: activeReserved + queuedBytes + heldReserved, quarantined }),
  };
}

module.exports = { createRestrictedPdfHost, verifyAssets, declaredMaximumMemory, stageEnvelope, MAX_INPUT_BYTES, MAX_DECLARED_MEMORY };
