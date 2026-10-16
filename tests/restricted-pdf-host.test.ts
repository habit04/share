import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Child = {
  sent: unknown[];
  killed: boolean;
  send(message: unknown): void;
  kill(): void;
  onMessage(fn: (m: unknown) => void): void;
  onExit(fn: (code: number) => void): void;
  onError(fn: (e: unknown) => void): void;
  reply(message: unknown): void;
  exit(code?: number): void;
  channelError(): void;
};
type Host = {
  transform(input: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  dispose(): Promise<void>;
  stats(): { active: number; queued: number; queuedBytes: number; reservedBytes: number; quarantined: boolean };
};
const { createRestrictedPdfHost, stageEnvelope } = require('../electron/restricted-pdf/host.cjs') as {
  createRestrictedPdfHost(options?: { spawn?: () => Child; timeoutMs?: number; terminationGraceMs?: number; maxActive?: number; maxQueued?: number; maxQueuedBytes?: number; maxAggregateBytes?: number }): Host;
  stageEnvelope(inputBytes: number): number;
};

function fakeChild(): Child {
  let messageFn: (m: unknown) => void = () => {};
  let exitFn: (code: number) => void = () => {};
  let errorFn: (e: unknown) => void = () => {};
  return {
    sent: [],
    killed: false,
    send(message) { this.sent.push(message); },
    kill() { this.killed = true; },
    onMessage(fn) { messageFn = fn; },
    onExit(fn) { exitFn = fn; },
    onError(fn) { errorFn = fn; },
    reply(message) { messageFn(message); },
    exit(code = 0) { exitFn(code); },
    channelError() { errorFn(new Error('channel gone')); },
  };
}
function spawner() {
  const children: Child[] = [];
  return { children, spawn: () => { const child = fakeChild(); children.push(child); return child; } };
}
const plain = (body = 'plain body') => new TextEncoder().encode(`%PDF-1.4\n${body}`);
const encrypted = (body = 'encrypted body') => new TextEncoder().encode(`%PDF-1.7\n${body}`);
async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }
function stateOf(promise: Promise<unknown>) {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  void promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  return () => state;
}

describe('restricted PDF job host lifecycle (12.4)', () => {
  it('runs a job in a fresh child and resolves only after the child exits (exit join)', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const input = plain();
    const job = host.transform(input);
    const state = stateOf(job);
    expect(s.children).toHaveLength(1);
    expect((s.children[0]!.sent[0] as { input: Uint8Array }).input).toBe(input);
    const out = encrypted();
    s.children[0]!.reply({ output: out });
    await flush();
    expect(state()).toBe('pending'); // output alone is not enough: the slot waits for exit
    s.children[0]!.exit(0);
    await expect(job).resolves.toBe(out);
    await flush();
    expect(host.stats()).toEqual({ active: 0, queued: 0, queuedBytes: 0, reservedBytes: 0, quarantined: false });
    await host.dispose();
  });

  it('times out in the parent, kills the child, and frees the slot only on exit', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 40, maxActive: 1 });
    const first = host.transform(plain('one'));
    const firstState = stateOf(first);
    const second = host.transform(plain('two'));
    expect(s.children).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(s.children[0]!.killed).toBe(true);
    expect(firstState()).toBe('pending'); // killed but not yet joined
    expect(s.children).toHaveLength(1); // no slot reuse before exit
    s.children[0]!.exit(1);
    await expect(first).rejects.toThrow(/timed out/);
    await flush();
    expect(s.children).toHaveLength(2); // the queued job starts only now
    s.children[1]!.reply({ output: encrypted() });
    s.children[1]!.exit(0);
    await expect(second).resolves.toBeInstanceOf(Uint8Array);
    await host.dispose();
  });

  it('a late output after timeout + exit is ignored and never resolves the job', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 30 });
    const job = host.transform(plain());
    await new Promise((resolve) => setTimeout(resolve, 50));
    s.children[0]!.exit(1);
    await expect(job).rejects.toThrow(/timed out/);
    s.children[0]!.reply({ output: encrypted() }); // far too late: must not throw or commit
    await flush();
    await host.dispose();
  });

  it('fails closed on engine error messages, bare exits and malformed output', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const a = host.transform(plain('a'));
    s.children[0]!.reply({ error: 'The restricted PDF engine refused the document (exit 2).' });
    s.children[0]!.exit(1);
    await expect(a).rejects.toThrow(/refused the document/);
    const b = host.transform(plain('b'));
    s.children[1]!.exit(1); // exit without any reply
    await expect(b).rejects.toThrow(/exited before replying|timed out/);
    const c = host.transform(plain('c'));
    s.children[2]!.reply({ output: new TextEncoder().encode('%PDF-1.4\nnot restricted') });
    s.children[2]!.exit(0);
    await expect(c).rejects.toThrow(/invalid document/);
    await host.dispose();
  });

  it('bounds the queue by count and by queued bytes', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1, maxQueued: 1, maxQueuedBytes: 64 });
    const first = host.transform(plain('first job is running'));
    const second = host.transform(plain('q')); // queued: 21 bytes
    await expect(host.transform(plain('third'))).rejects.toThrow(/too many restricted PDF jobs/); // queue full
    s.children[0]!.reply({ output: encrypted() }); s.children[0]!.exit(0);
    await first; await flush();
    await expect(host.transform(new Uint8Array(100))).rejects.toThrow(/invalid PDF payload/);
    s.children[1]!.reply({ output: encrypted() }); s.children[1]!.exit(0);
    await second;
    await host.dispose();
  });

  it('an aborted queued job leaves the queue and refunds its bytes', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1 });
    const first = host.transform(plain('running'));
    const controller = new AbortController();
    const queued = host.transform(plain('queued'), controller.signal);
    expect(host.stats().queued).toBe(1);
    controller.abort();
    await expect(queued).rejects.toThrow(/cancelled/);
    // The queued job's staged reservation is refunded; the running job's
    // full envelope is still held.
    expect(host.stats()).toEqual({ active: 1, queued: 0, queuedBytes: 0, reservedBytes: stageEnvelope(plain('running').byteLength), quarantined: false });
    s.children[0]!.reply({ output: encrypted() }); s.children[0]!.exit(0);
    await first;
    await host.dispose();
  });

  it('an aborted running job is killed and joined before the slot is reused', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1 });
    const controller = new AbortController();
    const first = host.transform(plain('running'), controller.signal);
    const second = host.transform(plain('next'));
    controller.abort();
    expect(s.children[0]!.killed).toBe(true);
    expect(s.children).toHaveLength(1); // still joined, not yet reusable
    s.children[0]!.exit(1);
    await expect(first).rejects.toThrow(/cancelled/);
    await flush();
    expect(s.children).toHaveLength(2);
    s.children[1]!.reply({ output: encrypted() }); s.children[1]!.exit(0);
    await second;
    await host.dispose();
  });

  it('rejects invalid payloads before spawning anything', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn });
    await expect(host.transform(new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid PDF payload/);
    await expect(host.transform(new TextEncoder().encode('not a pdf at all'))).rejects.toThrow(/invalid PDF payload/);
    expect(s.children).toHaveLength(0);
    await host.dispose();
  });

  // CORRECTED CONTRACT (the delivered version of this test asserted that a
  // running job still completes after dispose — the exact defect Codex's
  // review reproduced): disposal latches closure into the ACTIVE job too,
  // kills its child, ignores its late output, and completes only after the
  // exit is joined.
  it('dispose kills the active job, joins its exit, and only then completes', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1 });
    const first = host.transform(plain('running'));
    const queued = host.transform(plain('queued'));
    let disposed = false;
    const closing = host.dispose().then(() => { disposed = true; });
    await expect(queued).rejects.toThrow(/closed/);
    await flush();
    expect(s.children[0]!.killed).toBe(true);
    expect(disposed).toBe(false); // disposal waits for the exit join
    expect(host.stats().active).toBe(1); // the slot stays visible until joined
    s.children[0]!.reply({ output: encrypted() }); // late output is never used
    s.children[0]!.exit(0); // even a clean exit cannot resolve a disposed job
    await closing;
    expect(disposed).toBe(true);
    await expect(first).rejects.toThrow(/closed/);
    expect(host.stats()).toEqual({ active: 0, queued: 0, queuedBytes: 0, reservedBytes: 0, quarantined: false });
  });

  it('defaults to a single active transform', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const one = host.transform(plain('one'));
    const two = host.transform(plain('two'));
    expect(s.children).toHaveLength(1); // no second engine by default
    s.children[0]!.reply({ output: encrypted() }); s.children[0]!.exit(0);
    await one; await flush();
    expect(s.children).toHaveLength(2);
    s.children[1]!.reply({ output: encrypted() }); s.children[1]!.exit(0);
    await two;
    await host.dispose();
  });

  it('a valid output followed by a non-zero exit (17) fails instead of resolving', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const job = host.transform(plain());
    s.children[0]!.reply({ output: encrypted() });
    s.children[0]!.exit(17);
    await expect(job).rejects.toThrow(/exited with code 17/);
    expect(host.stats().reservedBytes).toBe(0);
    await host.dispose();
  });

  it('a channel error rejects the job after the exit join', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const job = host.transform(plain());
    const state = stateOf(job);
    s.children[0]!.channelError();
    await flush();
    expect(s.children[0]!.killed).toBe(true);
    expect(state()).toBe('pending'); // still joined, not settled
    s.children[0]!.exit(1);
    await expect(job).rejects.toThrow(/channel failed/);
    await host.dispose();
  });

  it('a send failure rejects the job after the exit join', async () => {
    const children: Child[] = [];
    const host = createRestrictedPdfHost({
      timeoutMs: 5_000,
      spawn: () => { const child = fakeChild(); child.send = () => { throw new Error('no channel'); }; children.push(child); return child; },
    });
    const job = host.transform(plain());
    await flush();
    expect(children[0]!.killed).toBe(true);
    children[0]!.exit(1);
    await expect(job).rejects.toThrow(/could not receive/);
    await host.dispose();
  });

  it('a child that never exits after termination quarantines the host instead of hanging', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 30, terminationGraceMs: 40 });
    const job = host.transform(plain());
    await expect(job).rejects.toThrow(/did not exit after termination/);
    expect(host.stats().quarantined).toBe(true);
    await expect(host.transform(plain())).rejects.toThrow(/unavailable/);
    await host.dispose(); // disposal still completes: the grace path settled the job
  });

  it('refuses a document whose envelope exceeds the aggregate budget up front', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, maxAggregateBytes: 1024 });
    await expect(host.transform(plain())).rejects.toThrow(/memory budget/);
    expect(s.children).toHaveLength(0);
    await host.dispose();
  });

  it('with two slots allowed, a second job still waits for the aggregate budget', async () => {
    const s = spawner();
    const input = plain('budgeted');
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 2, maxAggregateBytes: stageEnvelope(input.byteLength) });
    const one = host.transform(input);
    const two = host.transform(input);
    await flush();
    expect(s.children).toHaveLength(1); // budget admits exactly one envelope
    s.children[0]!.reply({ output: encrypted() }); s.children[0]!.exit(0);
    await one; await flush();
    expect(s.children).toHaveLength(2); // refunded budget admits the second
    s.children[1]!.reply({ output: encrypted() }); s.children[1]!.exit(0);
    await two;
    await host.dispose();
  });
});

describe('restricted PDF stage reservations (12.4 corrections)', () => {
  it('holds the full envelope while active and refunds it on success', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const input = plain('reserve me');
    const job = host.transform(input);
    expect(host.stats().reservedBytes).toBe(stageEnvelope(input.byteLength));
    s.children[0]!.reply({ output: encrypted() }); s.children[0]!.exit(0);
    await job;
    expect(host.stats().reservedBytes).toBe(0);
    await host.dispose();
  });

  it('refunds the envelope on engine refusal', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000 });
    const job = host.transform(plain('refuse me'));
    s.children[0]!.reply({ error: 'The restricted PDF engine refused the document (exit 2).' });
    s.children[0]!.exit(2);
    await expect(job).rejects.toThrow(/refused the document/);
    expect(host.stats().reservedBytes).toBe(0);
    await host.dispose();
  });

  it('refunds staged + active reservations on cancellation', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1 });
    const activeInput = plain('active job');
    const queuedInput = plain('queued job');
    const controller = new AbortController();
    const active = host.transform(activeInput, controller.signal);
    const queued = host.transform(queuedInput, controller.signal);
    expect(host.stats().reservedBytes).toBe(stageEnvelope(activeInput.byteLength) + queuedInput.byteLength);
    controller.abort(); // aborts both: queued settles at once, active is killed + joined
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(host.stats().reservedBytes).toBe(stageEnvelope(activeInput.byteLength));
    s.children[0]!.exit(1);
    await expect(active).rejects.toThrow(/cancelled/);
    expect(host.stats().reservedBytes).toBe(0);
    await host.dispose();
  });

  it('refunds everything on disposal once exits are joined', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, maxActive: 1 });
    const job = host.transform(plain('doomed'));
    host.transform(plain('also doomed')).catch(() => {});
    expect(host.stats().reservedBytes).toBeGreaterThan(0);
    const closing = host.dispose();
    s.children[0]!.exit(1);
    await closing;
    await expect(job).rejects.toThrow(/closed/);
    expect(host.stats().reservedBytes).toBe(0);
    expect(host.stats().quarantined).toBe(false);
  });
});

describe('restricted PDF quarantine settles the queue (12.4 round 2)', () => {
  // Round-1 defect (Codex run-BwFLVo): entering quarantine settled only the
  // unconfirmed ACTIVE job. Queued jobs have no timer of their own and pump
  // refuses while quarantined, so they stayed pending — and their staging
  // reservations stayed held — until an external abort/dispose happened by.
  it('rejects every queued job and refunds its staging the moment quarantine is entered', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, terminationGraceMs: 40, maxActive: 1 });
    const controller = new AbortController();
    const activeInput = plain('stuck active');
    const active = host.transform(activeInput, controller.signal);
    const queuedB = host.transform(plain('queued b'));
    const queuedC = host.transform(plain('queued c'));
    expect(host.stats().queued).toBe(2);
    controller.abort(); // the active child is killed but never exits
    await expect(active).rejects.toThrow(/did not exit after termination/);
    // No caller aborts or disposes B or C: quarantine entry settles them.
    await expect(queuedB).rejects.toThrow(/unavailable/);
    await expect(queuedC).rejects.toThrow(/unavailable/);
    // Queued staging is refunded; the unconfirmed active child's envelope
    // stays held — grace expiry is not proof its resources are gone.
    expect(host.stats()).toEqual({ active: 0, queued: 0, queuedBytes: 0, reservedBytes: stageEnvelope(activeInput.byteLength), quarantined: true });
    // The unavailable service does not silently reopen.
    await expect(host.transform(plain('later'))).rejects.toThrow(/unavailable/);
    s.children[0]!.exit(1); // the late exit refunds the held envelope, once
    await flush();
    expect(host.stats().reservedBytes).toBe(0);
    s.children[0]!.exit(1); // a duplicate exit report must not refund twice
    await flush();
    expect(host.stats().reservedBytes).toBe(0);
    expect(host.stats().quarantined).toBe(true);
    await host.dispose();
  });

  it('late output from the unconfirmed child never resolves the failed job', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 30, terminationGraceMs: 40 });
    const input = plain('doomed');
    const job = host.transform(input);
    const state = stateOf(job);
    await expect(job).rejects.toThrow(/did not exit after termination/);
    s.children[0]!.reply({ output: encrypted() }); // far too late: ignored
    await flush();
    expect(state()).toBe('rejected');
    expect(host.stats().reservedBytes).toBe(stageEnvelope(input.byteLength)); // still held
    s.children[0]!.exit(0); // even a late clean exit only refunds; the failure stands
    await flush();
    expect(host.stats().reservedBytes).toBe(0);
    await expect(host.transform(plain('later'))).rejects.toThrow(/unavailable/);
    await host.dispose();
  });

  it('disposal racing quarantine entry settles queued work and completes without the stuck child', async () => {
    const s = spawner();
    const host = createRestrictedPdfHost({ spawn: s.spawn, timeoutMs: 5_000, terminationGraceMs: 40, maxActive: 1 });
    const controller = new AbortController();
    const activeInput = plain('stuck');
    const active = host.transform(activeInput, controller.signal);
    const queued = host.transform(plain('waiting'));
    controller.abort();
    const closing = host.dispose(); // disposal begins while the grace timer is pending
    await expect(queued).rejects.toThrow(/closed|unavailable/);
    await expect(active).rejects.toThrow(/did not exit after termination/);
    await closing; // completes once the grace path settles the active job
    // The unconfirmed child's envelope is STILL held after disposal:
    // disposal is bounded cleanup, not proof the process is gone.
    expect(host.stats().reservedBytes).toBe(stageEnvelope(activeInput.byteLength));
    s.children[0]!.exit(1); // late exit refunds it, exactly once
    await flush();
    expect(host.stats().reservedBytes).toBe(0);
    expect(host.stats().quarantined).toBe(true);
  });
});

describe('restricted PDF transform through the real one-shot child (12.4)', () => {
  it('encrypts a hand-authored plaintext PDF into a PDF 1.7 restricted document', async () => {
    // Minimal hand-authored document: catalog, one page, one text stream.
    const content = 'BT /F1 12 Tf 72 720 Td (PN-12345) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const host = createRestrictedPdfHost({ timeoutMs: 60_000 });
    const out = await host.transform(new TextEncoder().encode(pdf));
    const text = new TextDecoder('latin1').decode(out);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/AESV3');
    expect(text).toContain('/R 6');
    expect(out.byteLength).toBeGreaterThan(pdf.length);
    await host.dispose();
  }, 90_000);
});
