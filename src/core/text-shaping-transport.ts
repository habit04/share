/**
 * Priority 12.5 shaping contract — bounded wire form, copy/charge accounting,
 * producer preflight, and the transport ledger (contract v4 §9.4;
 * clarification 3). Interface slice only: these are the schema, the
 * arithmetic, and the ledger discipline a future host mode must implement —
 * no transport, worker, or IPC exists in this slice.
 *
 * The three enforceable layers (§9.4): producer-side preflight BEFORE any
 * result is materialized or posted; a fixed flat-wire schema whose size is a
 * linear function of the preflighted counts; and one aggregate ledger over
 * active AND queued jobs, charged BEFORE font bytes are copied and released
 * only at worker exit-join.
 */
import { refuse, ok, SHAPING_LIMITS, type ShapeCheck } from './text-shaping';

/**
 * The bounded wire form (§9.4.2). Results cross as flat typed arrays under
 * this fixed schema — one array per numeric field, lengths declared once in
 * the header — so serialized size is exactly a linear function of the
 * preflighted counts. There is no variable-shape object graph whose clone
 * cost the counts fail to predict.
 *
 * Header (64 bytes, fields in order): magic u32, schema version u16,
 * reserved u16, glyphCount u32, uncoveredCount u32, advanceX i64,
 * advanceY i64, ink xMin/yMin/xMax/yMax i32 x4, binding digest 16 bytes,
 * header padding to 64.
 * Per glyph (28 bytes): glyph u32, clusterStart u32, clusterEnd u32,
 * xAdvance i32, yAdvance i32, xOffset i32, yOffset i32.
 * Per uncovered range (12 bytes): start u32, end u32, kind u8, padding 3.
 *
 * Losslessness (lead correction 4): the field widths and the host-side
 * validation (§10.1, text-shaping-snapshot.ts) are two halves of one
 * agreement. Accumulated advance sums are i64 because a long run's sum
 * legitimately exceeds i32 while remaining far inside i64; ink fields
 * and per-glyph fields are i32, and validation therefore requires every
 * value they carry to be an INTEGER inside its field's range — a
 * fraction or an out-of-range value is refused at the boundary, never
 * rounded, wrapped, or clamped in transit. Run ink is pen-accumulated
 * RUN-FRAME data, so a long run's ink can legitimately exceed i32 even
 * though every per-glyph field fits; such a run is refused at the
 * boundary by name (round-2 correction 4), not carried by silently
 * shrinking the ink model. Exact sizing is unchanged: the schema's
 * byte counts already made room for exactly these widths.
 */
export const SHAPED_RUN_WIRE = Object.freeze({
  schemaVersion: 1,
  headerBytes: 64,
  bytesPerGlyph: 28,
  bytesPerUncovered: 12,
  headerFields: Object.freeze([
    'magic:u32',
    'schemaVersion:u16',
    'reserved:u16',
    'glyphCount:u32',
    'uncoveredCount:u32',
    'advanceX:i64',
    'advanceY:i64',
    'ink.xMin:i32',
    'ink.yMin:i32',
    'ink.xMax:i32',
    'ink.yMax:i32',
    'bindingDigest:bytes16',
  ]),
  glyphFields: Object.freeze(['glyph:u32', 'clusterStart:u32', 'clusterEnd:u32', 'xAdvance:i32', 'yAdvance:i32', 'xOffset:i32', 'yOffset:i32']),
  uncoveredFields: Object.freeze(['start:u32', 'end:u32', 'kind:u8']),
} as const);

export interface ShapedRunCounts {
  readonly glyphCount: number;
  readonly uncoveredCount: number;
}

/** Exact serialized size of a run under the wire schema. */
export function shapedRunWireBytes(counts: ShapedRunCounts): number {
  return (
    SHAPED_RUN_WIRE.headerBytes +
    counts.glyphCount * SHAPED_RUN_WIRE.bytesPerGlyph +
    counts.uncoveredCount * SHAPED_RUN_WIRE.bytesPerUncovered
  );
}

/**
 * The conservative copy/charge formula (clarification 3). A job is charged,
 * BEFORE any copying:
 *   2 x programBytes  — the host->worker copy of the font program, plus the
 *                       face/blob copy the worker retains while it works;
 *   + resultBytes     — the result allowance: at admission, the §9.3
 *                       per-item cap (the result does not exist yet, so the
 *                       cap is the conservative charge); once the producer
 *                       has preflighted counts, the exact wire size.
 * Nothing is charged after the fact and nothing is copied before its charge
 * is reserved in the ledger.
 *
 * Simultaneous copies (lead correction 6): the single result allowance is
 * sufficient ONLY under the transfer/ownership rule the ledger enforces.
 * The wire result is a flat typed-array payload that crosses as a DETACHED
 * transfer: at the post, the worker's buffer is neutered and the host owns
 * the one live copy — a worker payload and a host clone never coexist, so
 * there is never a second result copy to charge. Ownership then moves
 * through recorded phases (worker-held → transferred → validated into a
 * snapshot, whose retention is charged to the snapshot aggregate of
 * §10.1.7, or discarded), and the ledger refuses to release a successful
 * job's charge until its result reaches one of those terminal phases
 * (see ShapeTransportLedger). A producer that cannot detach — one that
 * must clone — would hold two simultaneous result copies and MUST charge
 * 2 x resultBytes instead; at the 32 MiB boundary that difference is
 * exactly what admission refuses (the peak control in the tests: two
 * jobs at P = 8,257,536 / R = 262,144 already charge the full cap, and
 * one further result copy does not fit). The formula here is offered
 * only under the detach rule.
 */
export function jobChargeBytes(programBytes: number, resultBytes: number): number {
  return 2 * programBytes + resultBytes;
}

/** The admission-time charge for a job whose result does not exist yet. */
export function admissionChargeBytes(programBytes: number): number {
  return jobChargeBytes(programBytes, SHAPING_LIMITS.maxItemResultBytes);
}

/**
 * Producer-side preflight (§9.4.1). The producing worker computes the
 * result's counts directly from the engine's glyph-info arrays — counts are
 * known BEFORE any result object is built — and derives the serialized size
 * from the counts under the wire schema. If any §9.3/§10.1 bound would be
 * exceeded, the worker sends a small refusal record (item identity + the
 * failed bound) instead of the payload: an over-cap result is never
 * materialized, never cloned, and never posted.
 */
export function preflightShapedResult(input: {
  readonly itemUtf16Length: number;
  readonly counts: ShapedRunCounts;
}): ShapeCheck & { readonly wireBytes?: number } {
  if (!input || typeof input !== 'object' || !input.counts || typeof input.counts !== 'object') {
    return refuse('preflight-counts: preflight input is not an object with counts');
  }
  const { itemUtf16Length, counts } = input;
  // A NaN, infinite, negative, or fractional item length would make every
  // comparison below meaningless (lead review addendum D): refuse it.
  if (!Number.isSafeInteger(itemUtf16Length) || itemUtf16Length < 0) {
    return refuse('preflight-counts: item UTF-16 length is not a non-negative safe integer');
  }
  if (!Number.isSafeInteger(counts.glyphCount) || counts.glyphCount < 0) {
    return refuse('preflight-counts: glyph count is not a non-negative safe integer');
  }
  if (!Number.isSafeInteger(counts.uncoveredCount) || counts.uncoveredCount < 0) {
    return refuse('preflight-counts: uncovered count is not a non-negative safe integer');
  }
  if (counts.glyphCount > SHAPING_LIMITS.glyphExpansionFactor * itemUtf16Length) {
    return refuse(
      `glyph-expansion: ${counts.glyphCount} glyphs exceed 4x the item length ${itemUtf16Length} (§9.3)`,
    );
  }
  if (counts.uncoveredCount > itemUtf16Length) {
    return refuse(`uncovered-count: ${counts.uncoveredCount} uncovered ranges exceed the item length ${itemUtf16Length}`);
  }
  const wireBytes = shapedRunWireBytes(counts);
  if (wireBytes > SHAPING_LIMITS.maxItemResultBytes) {
    return refuse(`result-bytes: preflighted result is ${wireBytes} bytes, over the per-item cap (§9.3)`);
  }
  return { ok: true, wireBytes };
}

/** Every way a shaping job can end. The lifecycle discipline below applies to
    ALL of them identically (clarification 3): success, cancellation,
    producer refusal, error, timeout, and trap. */
export type ShapeJobTerminal = 'success' | 'cancelled' | 'refused' | 'error' | 'timeout' | 'trap';

export interface ShapeJobState {
  readonly jobId: string;
  readonly chargeBytes: number;
  readonly phase: 'queued' | 'active';
  readonly terminal: ShapeJobTerminal | null;
  /** The result crossed to the host as a detached transfer (recorded at
      the success terminal): the host owns the one live result copy. */
  readonly resultTransferred: boolean;
  readonly resultValidated: boolean;
  /** The host explicitly discarded the transferred result (e.g. it failed
      §10 validation and the item is missing): the copy is gone. */
  readonly resultDiscarded: boolean;
  readonly workerExited: boolean;
}

interface JobRecord {
  chargeBytes: number;
  phase: 'queued' | 'active';
  terminal: ShapeJobTerminal | null;
  resultTransferred: boolean;
  resultValidated: boolean;
  resultDiscarded: boolean;
  workerExited: boolean;
}

/**
 * The aggregate transport ledger (§9.4.3, §9.4.4, clarification 3).
 *
 * One ledger over ALL in-flight work, active and queued:
 *  - A job is admitted only if the ledger admits its estimated charge —
 *    checked BEFORE any font bytes are copied. Queue depth alone is not a
 *    byte bound and is not treated as one.
 *  - At most 2 jobs hold worker slots; a slot is held from activation until
 *    the worker's exit is observed — a terminated-but-not-yet-exited worker
 *    still occupies its slot.
 *  - A terminal outcome (success, cancellation, refusal, error, timeout,
 *    trap) NEVER releases the charge and NEVER frees the slot. Charges are
 *    released, and slots freed, only when the worker's exit has been joined
 *    (`noteWorkerExited`). Recording a validated result does not release
 *    anything either: the worker's retained copies are released at exit.
 *  - No result is accepted from a worker after a trap has been observed on
 *    it; the job is finished at its terminal state.
 *  - A successful job's result moves through recorded ownership phases
 *    (transferred at the success terminal, then validated into a snapshot
 *    or explicitly discarded), and its charge is not released at exit-join
 *    until one of those terminal phases is recorded (correction 6,
 *    addendum E).
 */
export class ShapeTransportLedger {
  readonly #jobs = new Map<string, JobRecord>();
  #totalChargedBytes = 0;

  get totalChargedBytes(): number {
    return this.#totalChargedBytes;
  }

  /** Jobs holding a worker slot: active and not yet exit-joined. */
  get activeWorkerCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) {
      if (job.phase === 'active' && !job.workerExited) count++;
    }
    return count;
  }

  get queuedCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) {
      if (job.phase === 'queued') count++;
    }
    return count;
  }

  get jobCount(): number {
    return this.#jobs.size;
  }

  jobState(jobId: string): ShapeJobState | undefined {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    return Object.freeze({
      jobId,
      chargeBytes: job.chargeBytes,
      phase: job.phase,
      terminal: job.terminal,
      resultTransferred: job.resultTransferred,
      resultValidated: job.resultValidated,
      resultDiscarded: job.resultDiscarded,
      workerExited: job.workerExited,
    });
  }

  /**
   * Reserve a job's full charge BEFORE any font bytes are copied
   * (clarification 3). Refuses — copying nothing — when the aggregate cap,
   * the pending-job cap, or a duplicate id forbids admission; the refusal
   * names the ledger state.
   */
  reserve(jobId: string, chargeBytes: number): ShapeCheck {
    if (this.#jobs.has(jobId)) return refuse(`duplicate-job: '${jobId}' is already in the ledger`);
    if (!Number.isInteger(chargeBytes) || chargeBytes < 0) {
      return refuse('invalid-charge: charge must be a non-negative integer number of bytes');
    }
    if (this.#jobs.size >= SHAPING_LIMITS.maxQueuedJobs) {
      return refuse(
        `queue-cap: ${this.#jobs.size} pending jobs already at the cap of ${SHAPING_LIMITS.maxQueuedJobs} (§9.3)`,
      );
    }
    if (this.#totalChargedBytes + chargeBytes > SHAPING_LIMITS.maxAggregateTransportBytes) {
      return refuse(
        `transport-aggregate-cap: charge ${chargeBytes} would take the ledger to ` +
          `${this.#totalChargedBytes + chargeBytes} bytes, over the 32 MiB active+queued cap (§9.4.3)`,
      );
    }
    this.#jobs.set(jobId, {
      chargeBytes,
      phase: 'queued',
      terminal: null,
      resultTransferred: false,
      resultValidated: false,
      resultDiscarded: false,
      workerExited: false,
    });
    this.#totalChargedBytes += chargeBytes;
    return ok();
  }

  /** Move a queued job onto a worker slot. Refused while both slots are
      held — including by workers that terminated but have not exited. */
  activate(jobId: string): ShapeCheck {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.phase !== 'queued') return refuse(`job-phase: '${jobId}' is not queued`);
    if (this.activeWorkerCount >= SHAPING_LIMITS.maxWorkers) {
      return refuse(
        `worker-concurrency: ${this.activeWorkerCount} workers already hold slots (cap ${SHAPING_LIMITS.maxWorkers}); ` +
          'a slot frees only at worker exit-join (§9.4.4)',
      );
    }
    job.phase = 'active';
    return ok();
  }

  /**
   * Record the job's terminal outcome. This NEVER releases the charge and
   * NEVER frees the slot (clarification 3) — for success exactly as for
   * cancellation, refusal, error, timeout, and trap.
   *
   * A success terminal records the result's TRANSFER (lead correction
   * 6): the result has crossed to the host as a detached payload, so the
   * host owns the one live result copy the single allowance covers. A
   * job that terminated any other way produced no transferable result.
   */
  noteTerminal(jobId: string, terminal: ShapeJobTerminal): ShapeCheck {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.terminal !== null) {
      return refuse(`job-terminal: '${jobId}' already terminated as '${job.terminal}'`);
    }
    if (job.phase !== 'active') return refuse(`job-phase: '${jobId}' has no worker to terminate`);
    job.terminal = terminal;
    if (terminal === 'success') job.resultTransferred = true;
    return ok();
  }

  /** Record that the job's result passed host-boundary validation (§10)
      and was retained into a snapshot — from here the result's retention
      is charged to the snapshot aggregate (§10.1.7), while this job's
      transport charge (the worker's program copies) is still held until
      exit-join (clarification 3): coverage overlaps, it never gaps. */
  noteResultValidated(jobId: string): ShapeCheck {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.terminal !== 'success') {
      return refuse(`job-terminal: only a successful job has a result to validate ('${jobId}' is '${job.terminal ?? 'running'}')`);
    }
    if (job.resultDiscarded) {
      return refuse(`result-phase: '${jobId}' result was already discarded; a discarded result cannot be validated`);
    }
    job.resultValidated = true;
    return ok();
  }

  /**
   * Record that the host DISCARDed a successful job's transferred result
   * without retaining it (e.g. §10 validation failed and the item is
   * missing): the host's copy is dropped. Exactly one of validated /
   * discarded may be recorded — together they are the terminal phases of
   * the result's ownership, and exit-join requires one of them
   * (addendum E).
   */
  noteResultDiscarded(jobId: string): ShapeCheck {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.terminal !== 'success') {
      return refuse(`job-terminal: only a successful job has a result to discard ('${jobId}' is '${job.terminal ?? 'running'}')`);
    }
    if (job.resultValidated) {
      return refuse(`result-phase: '${jobId}' result was already validated into a snapshot; retention has passed to the snapshot aggregate`);
    }
    if (job.resultDiscarded) {
      return refuse(`result-phase: '${jobId}' result was already discarded exactly once`);
    }
    job.resultDiscarded = true;
    return ok();
  }

  /**
   * Join the worker's exit (§9.4.4). ONLY here are the job's charge released
   * and its slot freed — exactly once. A queued job that never activated has
   * no worker; it is released by `releaseQueued` instead.
   *
   * Phase gate (lead review addendum E): a SUCCESSFUL job's charge is
   * not released until its transferred result has been validated into a
   * snapshot or explicitly discarded — the release can never strand a
   * host-owned result copy outside every ledger. This ledger is
   * bookkeeping: the call records the host's exit observation, and no
   * bookkeeping call by itself proves a physical worker exited; the
   * future host mode must call it from the worker's actual exit event.
   */
  noteWorkerExited(jobId: string): ShapeCheck & { readonly releasedBytes?: number } {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.phase !== 'active') return refuse(`job-phase: '${jobId}' never held a worker slot`);
    if (job.terminal === null) {
      return refuse(`job-terminal: '${jobId}' has not reached a terminal outcome; exit-join follows termination`);
    }
    if (job.terminal === 'success' && !job.resultValidated && !job.resultDiscarded) {
      return refuse(
        `result-phase: '${jobId}' succeeded but its result is neither validated into a snapshot nor discarded; ` +
          'the host must validate or discard the transferred result before its charge is released (§9.4.3)',
      );
    }
    if (job.workerExited) return refuse(`job-exited: '${jobId}' was already exit-joined; charges release exactly once`);
    job.workerExited = true;
    this.#totalChargedBytes -= job.chargeBytes;
    const releasedBytes = job.chargeBytes;
    this.#jobs.delete(jobId);
    return { ok: true, releasedBytes };
  }

  /** Release a job that was reserved but never dispatched (e.g. the batch
      was cancelled while it waited). No worker exists, so no exit-join
      applies; the charge is released exactly once. */
  releaseQueued(jobId: string): ShapeCheck & { readonly releasedBytes?: number } {
    const job = this.#jobs.get(jobId);
    if (!job) return refuse(`unknown-job: '${jobId}' is not in the ledger`);
    if (job.phase !== 'queued') {
      return refuse(`job-phase: '${jobId}' is active; an active job releases only at worker exit-join (§9.4.4)`);
    }
    this.#totalChargedBytes -= job.chargeBytes;
    const releasedBytes = job.chargeBytes;
    this.#jobs.delete(jobId);
    return { ok: true, releasedBytes };
  }
}
