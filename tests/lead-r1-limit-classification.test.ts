/**
 * Lead-policy controls: permanent identified-size limits precede reservation/I/O.
 * Prepared only. Copy unchanged into admitted source-exact/tests for lead execution.
 * Fake fs/metadata only; no native Windows or physical memory-limit claim.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

interface Stats { activeOps: number; retiredActiveOps: number; reservedRawBytes: number; contexts: number; tickets: number; disposed: boolean }
interface ReadResult { text: string; byteLength: number; rawBytes: number; version: string }
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<ReadResult>;
  closeAll(): Promise<void>;
  stats(): Stats;
}
const require = createRequire(import.meta.url);
const { createXrefReadBroker, MAX_RAW_BYTES } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker(deps: Record<string, unknown>): Broker;
  MAX_RAW_BYTES: number;
};
const MIB = 1024 * 1024, OWNER = 'wc:lead-size-policy';
const HOST = 'C:\\lead-size-policy\\host.dxf', SMALL = 'C:\\lead-size-policy\\small.dxf', LARGE = 'C:\\lead-size-policy\\large.dxf';
const LIMIT = 'ERR_XREF_LIMIT', BUSY = 'ERR_XREF_RESOURCE_BUSY';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
);
const errorCode = (outcome: Outcome<unknown>) => outcome.ok ? null : (outcome.error as { code?: string })?.code;
type FileRecord = { bytes: Buffer; size: bigint; ino: bigint };

class MetadataFs {
  readonly files = new Map<string, FileRecord>();
  counts = { open: 0, stat: 0, realpath: 0, fstat: 0, read: 0, close: 0 };
  openHandles = 0;
  onOpen: (() => void) | undefined;
  stopBeforeOpen = false;
  numericStatOverride: number | undefined;
  private held: { path: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  add(path: string, text: string, size = BigInt(Buffer.byteLength(text))) {
    this.files.set(path, { bytes: Buffer.from(text), size, ino: BigInt(this.files.size + 10) });
  }
  private file(path: string) {
    const file = this.files.get(path);
    if (!file) throw Object.assign(new Error('Authored missing path'), { code: 'ENOENT' });
    return file;
  }
  private metadata(file: FileRecord, big = false) {
    return { dev: big ? 7n : 7, ino: big ? file.ino : Number(file.ino),
      size: big ? file.size : this.numericStatOverride ?? Number(file.size),
      mtimeNs: big ? 1000n : 1000, ctimeNs: big ? 2000n : 2000, isFile: () => true };
  }
  async realpath(path: string) { this.counts.realpath++; this.file(path); return path; }
  async stat(path: string, options?: { bigint?: boolean }) { this.counts.stat++; return this.metadata(this.file(path), options?.bigint); }
  async open(path: string) {
    this.counts.open++; this.onOpen?.();
    if (this.stopBeforeOpen) throw Object.assign(new Error('Authored eligibility control stops before descriptor/buffer creation'), { code: 'LEAD_STOP_BEFORE_OPEN' });
    const held = this.held;
    if (held?.path === path) { held.entered.resolve(); await held.release.promise; }
    const file = this.file(path); this.openHandles++;
    let position = 0, closed = false;
    return {
      stat: async (options?: { bigint?: boolean }) => { this.counts.fstat++; return this.metadata(file, options?.bigint); },
      read: async (buffer: Buffer, offset: number, length: number, requestedPosition: number | null) => {
        this.counts.read++;
        const at = requestedPosition === null ? position : requestedPosition;
        const bytesRead = Math.max(0, Math.min(length, file.bytes.length - at));
        file.bytes.copy(buffer, offset, at, at + bytesRead); position = at + bytesRead;
        return { bytesRead, buffer };
      },
      close: async () => { if (closed) throw Error('Authored handle closed twice'); closed = true; this.counts.close++; this.openHandles--; },
    };
  }
  holdOpen(path: string) { this.held = { path, entered: deferred(), release: deferred() }; return this.held.entered.promise; }
  release() { this.held?.release.resolve(); this.held = undefined; }
  reset() { this.counts = { open: 0, stat: 0, realpath: 0, fstat: 0, read: 0, close: 0 }; }
  calls() { return Object.values(this.counts).reduce((sum, count) => sum + count, 0); }
}

function fixture(largeSize = 2n) {
  const fs = new MetadataFs(); fs.add(SMALL, 'A'); fs.add(LARGE, 'DX', largeSize);
  const granted = new Set([SMALL, LARGE]); let serial = 0, decodes = 0;
  const broker = createXrefReadBroker({ fs, isKnownPath: (path: string) => granted.has(path),
    decodeDxf: async (bytes: Buffer) => { decodes++; return { text: bytes.toString('utf8'), encoding: 'utf-8' }; },
    newId: () => `lead-size-${++serial}` }); // No ceiling overrides.
  const token = broker.beginContext(OWNER, { docId: 'lead-size-doc', contentGeneration: 1, hostAnchor: HOST }).token;
  const openCharges: Array<{ activeOps: number; reservedRawBytes: number }> = [];
  fs.onOpen = () => { const s = broker.stats(); openCharges.push({ activeOps: s.activeOps, reservedRawBytes: s.reservedRawBytes }); };
  const pending: Promise<unknown>[] = [];
  const track = <T>(p: Promise<T>) => { const observed = observe(p); pending.push(observed); return observed; };
  const identify = (path = LARGE) => broker.identify(OWNER, token, path);
  const mark = () => { fs.reset(); openCharges.length = 0; };
  const idle = () => expect(broker.stats()).toMatchObject({ activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0 });
  async function cleanup() { fs.release(); await broker.closeAll(); await Promise.allSettled(pending); expect(fs.openHandles).toBe(0); idle(); }
  return { fs, broker, token, granted, openCharges, track, identify, mark, idle, cleanup, decodeCount: () => decodes };
}

async function permanentRefusal(size: bigint, allowance: number) {
  const f = fixture(size);
  try {
    const leaf = await f.identify(); f.mark();
    const pending = observe(f.broker.read(OWNER, f.token, leaf.ticket, allowance));
    // A size check inside runOp is too late even if no I/O follows it:
    // record the synchronous admission state before any await/finally.
    const immediate = f.broker.stats();
    const outcome = await pending;
    expect({ code: errorCode(outcome), filesystemCalls: f.fs.calls(), decodes: f.decodeCount(), charges: f.openCharges,
      immediateActiveOps: immediate.activeOps, immediateReservedRawBytes: immediate.reservedRawBytes })
      .toEqual({ code: LIMIT, filesystemCalls: 0, decodes: 0, charges: [], immediateActiveOps: 0, immediateReservedRawBytes: 0 });
    f.idle();
    expect(f.broker.stats()).toMatchObject({ contexts: 1, tickets: 1 });
  } finally { await f.cleanup(); }
}

describe('lead: permanent identified-size limits versus temporary resource contention', () => {
  it('control: a two-byte file exactly at a lower caller allowance reads and refunds normally', async () => {
    const f = fixture();
    try {
      expect(MAX_RAW_BYTES).toBe(16 * MIB);
      const leaf = await f.identify(); f.mark();
      await expect(f.broker.read(OWNER, f.token, leaf.ticket, 2)).resolves.toMatchObject({ text: 'DX', byteLength: 2, rawBytes: 2 });
      expect(f.openCharges).toEqual([{ activeOps: 1, reservedRawBytes: 3 }]);
      expect(f.decodeCount()).toBe(1); f.idle();
    } finally { await f.cleanup(); }
  });

  it('control: exactly16MiB is eligible with its +1 sentinel; stop at open before allocating any large buffer', async () => {
    const f = fixture(BigInt(16 * MIB));
    try {
      const leaf = await f.identify(); f.mark(); f.fs.stopBeforeOpen = true;
      const outcome = await observe(f.broker.read(OWNER, f.token, leaf.ticket, MAX_RAW_BYTES));
      expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_XREF_READ', cause: { code: 'LEAD_STOP_BEFORE_OPEN' } } });
      expect(f.fs.counts).toEqual({ open: 1, stat: 0, realpath: 0, fstat: 0, read: 0, close: 0 });
      expect(f.openCharges).toEqual([{ activeOps: 1, reservedRawBytes: 16 * MIB + 1 }]);
      expect(f.decodeCount()).toBe(0); f.idle();
    } finally { await f.cleanup(); }
  });

  it('two identified bytes against caller allowance1 are permanent LIMIT before I/O/reservation', async () => { await permanentRefusal(2n, 1); });
  it('16MiB+1 is permanent LIMIT even when caller allowance is larger than16MiB', async () => { await permanentRefusal(BigInt(16 * MIB + 1), 64 * MIB); });
  it('idle64MiB is permanent LIMIT, never temporary BUSY', async () => { await permanentRefusal(BigInt(64 * MIB), MAX_RAW_BYTES); });
  it('idle64MiB+1 is permanent LIMIT, never temporary BUSY', async () => { await permanentRefusal(BigInt(64 * MIB + 1), MAX_RAW_BYTES); });

  it('revoked authority remains DENIED ahead of the identified-size limit, without I/O/charges', async () => {
    const f = fixture(BigInt(64 * MIB + 1));
    try {
      const leaf = await f.identify(); f.granted.delete(LARGE); f.mark();
      const outcome = await observe(f.broker.read(OWNER, f.token, leaf.ticket, MAX_RAW_BYTES));
      expect({ code: errorCode(outcome), filesystemCalls: f.fs.calls(), charges: f.openCharges }).toEqual({ code: 'ERR_XREF_DENIED', filesystemCalls: 0, charges: [] });
      expect(f.decodeCount()).toBe(0); f.idle();
    } finally { await f.cleanup(); }
  });

  it('a forged ticket fails authority before size policy or I/O', async () => {
    const f = fixture(BigInt(64 * MIB + 1));
    try {
      await f.identify(); f.mark();
      const outcome = await observe(f.broker.read(OWNER, f.token, 'forged-ticket', MAX_RAW_BYTES));
      expect({ code: errorCode(outcome), filesystemCalls: f.fs.calls(), charges: f.openCharges }).toEqual({ code: 'ERR_XREF_TICKET', filesystemCalls: 0, charges: [] });
      f.idle();
    } finally { await f.cleanup(); }
  });

  it('one eligible held read causes BUSY for another eligible read but LIMIT for a permanently oversized ticket', async () => {
    const f = fixture(BigInt(16 * MIB + 1));
    try {
      const small = await f.identify(SMALL), large = await f.identify(); f.mark();
      const entered = f.fs.holdOpen(SMALL), first = f.track(f.broker.read(OWNER, f.token, small.ticket, 1));
      await Promise.race([entered, first.then(() => { throw Error('Authored held read settled before reaching its open gate'); })]);
      const calls = f.fs.calls();
      const busy = await observe(f.broker.read(OWNER, f.token, small.ticket, 1));
      const limit = await observe(f.broker.read(OWNER, f.token, large.ticket, MAX_RAW_BYTES));
      expect({ eligible: errorCode(busy), oversized: errorCode(limit), filesystemCalls: f.fs.calls() - calls }).toEqual({ eligible: BUSY, oversized: LIMIT, filesystemCalls: 0 });
      expect(f.broker.stats()).toMatchObject({ activeOps: 1, reservedRawBytes: 2 });
      f.fs.release(); await expect(first).resolves.toMatchObject({ ok: true, value: { text: 'A' } }); f.idle();
    } finally { await f.cleanup(); }
  });

  it('allocation remains bound to the identified one-byte size when successive numeric/bigint stat observations differ', async () => {
    const f = fixture(1n);
    let restoreAllocationSpy: (() => void) | undefined;
    try {
      const leaf = await f.identify(SMALL); f.mark();
      // Defined fake observation sequence: the helper's initial numeric
      // fstat reports4096; its later bigint identity observation reports
      // the original1-byte version. This probes binding of allocation to
      // the admitted size, not a reproduced native timestamp/race event.
      f.fs.numericStatOverride = 4096;
      const allocations: number[] = [], originalAlloc = Buffer.alloc;
      const allocationSpy = vi.spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => {
        allocations.push(size); return originalAlloc(size, fill, encoding);
      });
      restoreAllocationSpy = () => { allocationSpy.mockRestore(); };
      const outcome = await observe(f.broker.read(OWNER, f.token, leaf.ticket, MAX_RAW_BYTES));
      restoreAllocationSpy(); restoreAllocationSpy = undefined;
      expect(f.openCharges).toEqual([{ activeOps: 1, reservedRawBytes: 2 }]);
      expect(Math.max(0, ...allocations)).toBeLessThanOrEqual(2);
      expect(outcome.ok).toBe(false);
      expect(['ERR_XREF_LIMIT', 'ERR_XREF_CHANGED']).toContain(errorCode(outcome));
      expect(f.decodeCount()).toBe(0); f.idle();
    } finally { restoreAllocationSpy?.(); await f.cleanup(); }
  });
});
