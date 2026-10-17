/**
 * Synthetic contract tests for the 12.5 transport discipline (contract v4
 * §9.4, clarification 3): fixed wire schema, conservative charge formula,
 * producer preflight, reserve-before-copy, and exit-join before any charge
 * release or slot reuse — for success and for EVERY other terminal outcome.
 * The producer here is a fake; these tests are not transport or native
 * acceptance.
 */
import { describe, expect, it } from 'vitest';
import { SHAPING_LIMITS } from '../src/core/text-shaping';
import {
  ShapeTransportLedger,
  admissionChargeBytes,
  jobChargeBytes,
  preflightShapedResult,
  shapedRunWireBytes,
  type ShapeJobTerminal,
} from '../src/core/text-shaping-transport';

describe('wire schema and charge formula (§9.4.2, clarification 3)', () => {
  it('wire size is an exact linear function of the preflighted counts', () => {
    expect(shapedRunWireBytes({ glyphCount: 0, uncoveredCount: 0 })).toBe(64);
    expect(shapedRunWireBytes({ glyphCount: 1, uncoveredCount: 0 })).toBe(64 + 28);
    expect(shapedRunWireBytes({ glyphCount: 10, uncoveredCount: 2 })).toBe(64 + 280 + 24);
  });

  it('the charge is 2x program bytes (in-copy + worker-held copy) plus the result', () => {
    expect(jobChargeBytes(1000, 500)).toBe(2500);
    // At admission the result does not exist, so the capped allowance is
    // charged — conservatively, before anything is copied.
    expect(admissionChargeBytes(1000)).toBe(2000 + SHAPING_LIMITS.maxItemResultBytes);
  });

  it('preflight refuses over-cap results before materialization', () => {
    const fine = preflightShapedResult({ itemUtf16Length: 10, counts: { glyphCount: 40, uncoveredCount: 0 } });
    expect(fine.ok).toBe(true);
    expect(fine.wireBytes).toBe(64 + 40 * 28);
    const expansion = preflightShapedResult({ itemUtf16Length: 10, counts: { glyphCount: 41, uncoveredCount: 0 } });
    expect(expansion).toMatchObject({ ok: false, problem: expect.stringContaining('glyph-expansion') });
    // Within expansion (10,000 <= 4 x 10,000) but over the byte cap.
    const bytes = preflightShapedResult({ itemUtf16Length: 10000, counts: { glyphCount: 10000, uncoveredCount: 0 } });
    expect(bytes).toMatchObject({ ok: false, problem: expect.stringContaining('result-bytes') });
  });
});

/**
 * A fake producer that drives the ledger in the contract's order and
 * records every step, so tests can assert the ordering itself: reserve
 * BEFORE copy, terminal BEFORE exit-join, release ONLY at exit-join.
 */
class FakeProducer {
  readonly events: string[] = [];
  constructor(private readonly ledger: ShapeTransportLedger) {}

  run(jobId: string, programBytes: number, outcome: ShapeJobTerminal): void {
    const reserved = this.ledger.reserve(jobId, admissionChargeBytes(programBytes));
    this.events.push(reserved.ok ? `reserve:${jobId}` : `reserve-refused:${jobId}`);
    if (!reserved.ok) return; // refused before any copy: nothing else happens
    this.events.push(`copy:${jobId}`); // font bytes copied only after reservation
    const activated = this.ledger.activate(jobId);
    this.events.push(activated.ok ? `activate:${jobId}` : `activate-refused:${jobId}`);
    if (!activated.ok) return;
    if (outcome === 'success') {
      // Producer preflight passes; result crosses and validates.
      this.events.push(`preflight:${jobId}`, `result:${jobId}`);
      this.ledger.noteTerminal(jobId, 'success');
      this.ledger.noteResultValidated(jobId);
    } else {
      this.ledger.noteTerminal(jobId, outcome);
    }
    this.events.push(`terminal:${outcome}:${jobId}`);
    const exited = this.ledger.noteWorkerExited(jobId);
    this.events.push(exited.ok ? `exit-join:${jobId}` : `exit-refused:${jobId}`);
  }
}

describe('fake-producer ordering (§9.4)', () => {
  it('a successful job runs reserve -> copy -> activate -> result -> terminal -> exit-join', () => {
    const ledger = new ShapeTransportLedger();
    const producer = new FakeProducer(ledger);
    producer.run('job', 1000, 'success');
    expect(producer.events).toEqual([
      'reserve:job',
      'copy:job',
      'activate:job',
      'preflight:job',
      'result:job',
      'terminal:success:job',
      'exit-join:job',
    ]);
    expect(ledger.totalChargedBytes).toBe(0);
    expect(ledger.jobCount).toBe(0);
  });
});

describe('ledger lifecycle: exit-join before release (clarification 3)', () => {
  const terminals: ShapeJobTerminal[] = ['success', 'cancelled', 'refused', 'error', 'timeout', 'trap'];

  it.each(terminals)('terminal %s holds the charge and the slot until worker exit', (outcome) => {
    const ledger = new ShapeTransportLedger();
    const charge = admissionChargeBytes(100_000);
    expect(ledger.reserve('job', charge).ok).toBe(true);
    expect(ledger.activate('job').ok).toBe(true);
    expect(ledger.noteTerminal('job', outcome).ok).toBe(true);
    if (outcome === 'success') expect(ledger.noteResultValidated('job').ok).toBe(true);
    // AFTER the terminal outcome (and even after validation): nothing is
    // released and the slot is still held.
    expect(ledger.totalChargedBytes).toBe(charge);
    expect(ledger.activeWorkerCount).toBe(1);
    // A second exit-join attempt after the real one cannot double-release.
    const exited = ledger.noteWorkerExited('job');
    expect(exited).toMatchObject({ ok: true, releasedBytes: charge });
    expect(ledger.totalChargedBytes).toBe(0);
    expect(ledger.activeWorkerCount).toBe(0);
    expect(ledger.noteWorkerExited('job')).toMatchObject({ ok: false });
  });

  it('a worker slot is not reused before the previous worker exits', () => {
    const ledger = new ShapeTransportLedger();
    expect(ledger.reserve('a', 10).ok).toBe(true);
    expect(ledger.reserve('b', 10).ok).toBe(true);
    expect(ledger.reserve('c', 10).ok).toBe(true);
    expect(ledger.activate('a').ok).toBe(true);
    expect(ledger.activate('b').ok).toBe(true);
    expect(ledger.activate('c')).toMatchObject({ ok: false, problem: expect.stringContaining('worker-concurrency') });
    // Terminating 'a' does NOT free its slot; only its exit does.
    expect(ledger.noteTerminal('a', 'timeout').ok).toBe(true);
    expect(ledger.activate('c')).toMatchObject({ ok: false });
    expect(ledger.noteWorkerExited('a').ok).toBe(true);
    expect(ledger.activate('c').ok).toBe(true);
  });

  it('no result is validated for a trapped worker', () => {
    const ledger = new ShapeTransportLedger();
    ledger.reserve('job', 100);
    ledger.activate('job');
    ledger.noteTerminal('job', 'trap');
    expect(ledger.noteResultValidated('job')).toMatchObject({ ok: false });
  });
});

describe('ledger admission: reserve before copy (§9.4.3)', () => {
  it('the aggregate cap refuses a job before any font bytes are copied', () => {
    // Charge per job: 2*8,000,000 + 262,144 = 16,262,144. Two resident jobs
    // hold 32,524,288 of the 32 MiB cap; a third job's charge does not fit.
    const resident = new ShapeTransportLedger();
    for (const id of ['held-1', 'held-2']) {
      expect(resident.reserve(id, admissionChargeBytes(8_000_000)).ok).toBe(true);
      expect(resident.activate(id).ok).toBe(true);
    }
    expect(resident.totalChargedBytes).toBe(2 * admissionChargeBytes(8_000_000));
    const refused = new FakeProducer(resident);
    refused.run('third', 8_000_000, 'success');
    // The ONLY event is the refused reservation: no copy ever happened.
    expect(refused.events).toEqual(['reserve-refused:third']);
    expect(resident.jobState('third')).toBeUndefined();
  });

  it('the pending-job cap is 32 regardless of bytes', () => {
    const ledger = new ShapeTransportLedger();
    for (let i = 0; i < SHAPING_LIMITS.maxQueuedJobs; i++) {
      expect(ledger.reserve(`job-${i}`, 1).ok).toBe(true);
    }
    expect(ledger.reserve('one-too-many', 1)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('queue-cap'),
    });
  });

  it('a queued job that never dispatched releases without an exit-join', () => {
    const ledger = new ShapeTransportLedger();
    expect(ledger.reserve('waiting', 500).ok).toBe(true);
    expect(ledger.releaseQueued('waiting')).toMatchObject({ ok: true, releasedBytes: 500 });
    expect(ledger.totalChargedBytes).toBe(0);
    // An ACTIVE job may not take the queued release path.
    expect(ledger.reserve('active', 500).ok).toBe(true);
    expect(ledger.activate('active').ok).toBe(true);
    expect(ledger.releaseQueued('active')).toMatchObject({ ok: false });
  });
});
