/** P20.2 resource witness and documented cleanup-boundary controls. Fake fs only. */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type ReadResult = { text: string; byteLength: number; rawBytes: number; version: string };
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<ReadResult>;
  cancel(owner: string, token: string): boolean | Promise<boolean>;
  closeContext(owner: string, token: string): boolean | Promise<boolean>;
  retireOwner(owner: string): number;
  closeAll(): void;
  stats(): { contexts: number; tickets: number; disposed: boolean; activeOps: number; retiredActiveOps: number; reservedRawBytes: number };
}
const { createXrefReadBroker, MAX_RAW_BYTES } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker(deps: Record<string, unknown>): Broker;
  MAX_RAW_BYTES: number;
};

const OWNER = 'wc:resource-proof';
const HOST = 'C:\\resource-proof\\host.dxf';
const LEAF = 'C:\\resource-proof\\leaf.dxf';
const ONE_BYTE = Buffer.from('A', 'ascii');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

class HeldReadFs {
  openHandles = 0;
  peakOpenHandles = 0;
  closedHandles = 0;
  readonly heldBuffers = new Map<number, Buffer>();
  private serial = 0;
  private holding = false;
  // One park gate per held handle, so a test can release exactly one held
  // read (selective release) instead of only releasing all of them at once.
  private readonly parkGates = new Map<number, ReturnType<typeof deferred>>();
  private readonly waiters: Array<{ count: number; ready: ReturnType<typeof deferred> }> = [];

  private statOf(big = false) {
    return {
      dev: big ? 7n : 7, ino: big ? 42n : 42,
      size: big ? 1n : 1, mtimeNs: big ? 1000n : 1000,
      ctimeNs: big ? 2000n : 2000, isFile: () => true,
    };
  }
  async realpath(path: string) { if (path !== LEAF) throw new Error('Unexpected fake path'); return LEAF; }
  async stat(path: string, options?: { bigint?: boolean }) {
    if (path !== LEAF) throw new Error('Unexpected fake path');
    return this.statOf(options?.bigint);
  }
  async open(path: string) {
    if (path !== LEAF) throw new Error('Unexpected fake path');
    const id = ++this.serial;
    this.openHandles++;
    this.peakOpenHandles = Math.max(this.peakOpenHandles, this.openHandles);
    let position = 0, entered = false, closed = false;
    return {
      stat: async (options?: { bigint?: boolean }) => this.statOf(options?.bigint),
      read: async (buffer: Buffer, offset: number, length: number, requestedPosition: number | null) => {
        if (this.holding && !entered) {
          entered = true;
          const gate = deferred();
          this.parkGates.set(id, gate);
          this.heldBuffers.set(id, buffer);
          for (const waiter of this.waiters) if (this.heldBuffers.size >= waiter.count) waiter.ready.resolve();
          try { await gate.promise; }
          finally { this.heldBuffers.delete(id); this.parkGates.delete(id); }
        }
        const at = requestedPosition === null ? position : requestedPosition;
        const bytesRead = Math.max(0, Math.min(length, ONE_BYTE.length - at));
        ONE_BYTE.copy(buffer, offset, at, at + bytesRead);
        position = at + bytesRead;
        return { bytesRead, buffer };
      },
      close: async () => {
        if (closed) throw new Error('Fake handle closed twice');
        closed = true; this.openHandles--; this.closedHandles++;
      },
    };
  }
  hold() { this.holding = true; }
  untilHeld(count: number) {
    if (this.heldBuffers.size >= count) return Promise.resolve();
    const ready = deferred(); this.waiters.push({ count, ready }); return ready.promise;
  }
  releaseAll() { this.holding = false; for (const gate of [...this.parkGates.values()]) gate.resolve(); }
  /** Handle ids of the reads currently parked, in park order. */
  heldIds() { return [...this.heldBuffers.keys()]; }
  /** Release exactly one parked read by handle id; false if it is not parked. */
  releaseHeld(id: number) {
    const gate = this.parkGates.get(id);
    if (!gate) return false;
    this.parkGates.delete(id);
    gate.resolve();
    return true;
  }
  heldBytes() { return [...this.heldBuffers.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0); }
}

function fixture() {
  const fs = new HeldReadFs();
  let serial = 0;
  const broker = createXrefReadBroker({
    fs, isKnownPath: (path: string) => path === LEAF,
    decodeDxf: async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' }),
    newId: () => `resource-proof-${++serial}`,
    // Deliberately no maxRawBytes override: the existing16MiB ceiling remains intact.
  });
  const pending: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>): Promise<Outcome<T>> => {
    const observed = promise.then<Outcome<T>, Outcome<T>>(
      value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }),
    );
    pending.push(observed); return observed;
  };
  const begin = (generation = 1) => broker.beginContext(OWNER, {
    docId: 'resource-doc', contentGeneration: generation, hostAnchor: HOST,
  }).token;
  // A refusal before a held-read target is reached fails promptly, rather than hanging at a gate.
  const waitHeld = (count: number, operations: Array<Promise<Outcome<ReadResult>>>) => Promise.race([
    fs.untilHeld(count), ...operations.map(operation => operation.then(result => {
      throw new Error(`Read settled before the authored held-read witness: ${result.status}`);
    })),
  ]);
  async function cleanup() {
    broker.closeAll(); fs.releaseAll();
    await Promise.allSettled(pending);
    expect(fs.openHandles).toBe(0);
    expect(fs.heldBuffers.size).toBe(0);
  }
  return { fs, broker, begin, track, waitHeld, cleanup };
}

describe('lead: xref broker resource accounting witness', () => {
  it('control: a normal one-byte read preserves the ceiling and closes its descriptor', async () => {
    const f = fixture();
    try {
      expect(MAX_RAW_BYTES).toBe(16 * 1024 * 1024);
      const token = f.begin(), leaf = await f.broker.identify(OWNER, token, LEAF);
      expect(f.fs.openHandles).toBe(0);
      const result = await f.broker.read(OWNER, token, leaf.ticket, MAX_RAW_BYTES);
      expect(result).toMatchObject({ text: 'A', byteLength: 1, rawBytes: 1 });
      expect(f.fs.openHandles).toBe(0);
      expect(f.broker.stats()).toMatchObject({ contexts: 1, tickets: 1 });
    } finally { await f.cleanup(); }
  });

  it('witness: caps-reachable held reads outlive owner retirement while a fresh context starts', async () => {
    const f = fixture();
    const A = 'wc:witness-a', B = 'wc:witness-b', C = 'wc:witness-c';
    const beginAs = (owner: string, docId: string) => f.broker.beginContext(owner, {
      docId, contentGeneration: 1, hostAnchor: HOST,
    }).token;
    // First element of a witness array whose length an assertion has
    // already pinned (or whose construction guarantees it); throws rather
    // than letting an undefined slip into an expectation.
    const firstOf = <T>(items: T[]): T => {
      const [head] = items;
      if (head === undefined) throw new Error('witness array unexpectedly empty');
      return head;
    };
    // Settlement observers: a held read must be seen NOT to settle early,
    // and a refused read must be seen settled without any release.
    const watch = (outcome: Promise<Outcome<ReadResult>>) => {
      const state: { settled: boolean; outcome?: Outcome<ReadResult> } = { settled: false };
      void outcome.then(result => { state.settled = true; state.outcome = result; });
      return state;
    };
    // Event-loop turns only: a parked read cannot settle during the window
    // (nothing releases its gate), so any settlement observed is early.
    const drainWindow = async () => {
      for (let turn = 0; turn < 8; turn++) await new Promise<void>(done => setImmediate(done));
    };
    try {
      // Every context and ticket is identified BEFORE the fill: identify is
      // itself an admitted operation, so it could not succeed at the global
      // ceiling this witness fills to.
      const openCtx = async (owner: string, docId: string) => {
        const token = beginAs(owner, docId);
        const ticket = (await f.broker.identify(owner, token, LEAF)).ticket;
        return { token, ticket };
      };
      const [a1, a2, a3, a4] = [await openCtx(A, 'witness-doc-a1'), await openCtx(A, 'witness-doc-a2'),
        await openCtx(A, 'witness-doc-a3'), await openCtx(A, 'witness-doc-a4')];
      const bCtx = [await openCtx(B, 'witness-doc-b1'), await openCtx(B, 'witness-doc-b2'),
        await openCtx(B, 'witness-doc-b3'), await openCtx(B, 'witness-doc-b4')];
      const cCtx = await openCtx(C, 'witness-doc-c1');
      expect(f.broker.stats()).toMatchObject({ contexts: 9, tickets: 9, activeOps: 0, reservedRawBytes: 0 });
      f.fs.hold();

      // (a) 65 reads on one ticket/context in one synchronous block: the
      // per-context ceiling admits exactly one, which reaches the fake fs
      // and is held; the other 64 refuse ERR_XREF_RESOURCE_BUSY at
      // admission, before any filesystem contact.
      const burst = Array.from({ length: 65 }, () => f.track(f.broker.read(A, a1.token, a1.ticket, MAX_RAW_BYTES)));
      const burstStates = burst.map(watch);
      const firstRead = firstOf(burst);
      const firstState = firstOf(burstStates);
      const refusedStates = burstStates.slice(1);
      await f.waitHeld(1, [firstRead]);
      await drainWindow();
      expect(f.fs.heldBuffers.size).toBe(1);
      expect(f.fs.openHandles).toBe(1);
      expect(f.fs.peakOpenHandles).toBe(1);
      expect(refusedStates.filter(state => state.settled)).toHaveLength(64);
      for (const state of refusedStates) {
        expect(state.outcome).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_RESOURCE_BUSY' } });
        if (state.outcome?.status === 'rejected') {
          expect((state.outcome.reason as Error).message).toMatch(/one active xref operation per context/);
        }
      }
      expect(firstState.settled).toBe(false);
      expect([...f.fs.heldBuffers.values()].every(buffer => buffer.byteLength <= 2)).toBe(true);

      // (b) Fill to the real ceilings: owner A holds 4 reads across its 4
      // contexts (the burst survivor is the first), owner B holds 4, and
      // the broker-wide count reaches the global ceiling of 8.
      const aRest = [a2, a3, a4].map(ctx => f.track(f.broker.read(A, ctx.token, ctx.ticket, MAX_RAW_BYTES)));
      await f.waitHeld(4, aRest);
      const aStates = [firstState, ...aRest.map(watch)];
      const idsBeforeB = new Set(f.fs.heldIds());
      const bReads = bCtx.map(ctx => f.track(f.broker.read(B, ctx.token, ctx.ticket, MAX_RAW_BYTES)));
      const bStates = bReads.map(watch);
      await f.waitHeld(8, bReads);
      const bParkedIds = f.fs.heldIds().filter(id => !idsBeforeB.has(id));
      expect(bParkedIds).toHaveLength(4);
      const atCeilings = { handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size,
        bufferBytes: f.fs.heldBytes(), ...f.broker.stats() };
      expect(atCeilings).toMatchObject({ handles: 8, buffers: 8, contexts: 9, tickets: 9,
        activeOps: 8, retiredActiveOps: 0, reservedRawBytes: 16 });
      // A further read on an already-busy context refuses BUSY as well.
      const extra = await f.track(f.broker.read(A, a2.token, a2.ticket, MAX_RAW_BYTES));
      expect(extra).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_RESOURCE_BUSY' } });

      // (c) Retire owner A while its 4 reads are still held: A's contexts
      // and tickets leave the live ledger at once, its credits stay
      // charged in the retired ledger, and the reads do not settle early.
      expect(f.broker.retireOwner(A)).toBe(4);
      await drainWindow();
      for (const state of aStates) expect(state.settled).toBe(false);
      const afterRetirement = { handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size, ...f.broker.stats() };
      expect(afterRetirement).toMatchObject({ handles: 8, buffers: 8, contexts: 5, tickets: 5,
        activeOps: 8, retiredActiveOps: 4, reservedRawBytes: 16 });
      console.info('LEAD_XREF_RESOURCE_WITNESS', JSON.stringify({
        purpose: 'measurement, not a proposed concurrency threshold', maxRawBytes: MAX_RAW_BYTES,
        atCeilings, afterRetirement,
      }));

      // (d) A fresh owner's read refuses BUSY while the global ceiling is
      // full — C's own context and owner slots are free, so the refusal is
      // the broker-wide ceiling — until one held read is released and
      // settles, freeing exactly one credit.
      const cRefused = await f.track(f.broker.read(C, cCtx.token, cCtx.ticket, MAX_RAW_BYTES));
      expect(cRefused).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_RESOURCE_BUSY' } });
      if (cRefused.status === 'rejected') {
        expect((cRefused.reason as Error).message).toMatch(/broker already has 8 active xref operations/);
      }
      expect(f.fs.releaseHeld(firstOf(bParkedIds))).toBe(true);
      await drainWindow();
      const settledB = bStates.filter(state => state.settled);
      expect(settledB).toHaveLength(1);
      expect(firstOf(settledB).outcome).toMatchObject({ status: 'fulfilled', value: { text: 'A', rawBytes: 1 } });
      for (const state of aStates) expect(state.settled).toBe(false);
      expect(f.fs.heldBuffers.size).toBe(7);
      expect(f.fs.openHandles).toBe(7);
      expect(f.broker.stats()).toMatchObject({ activeOps: 7, retiredActiveOps: 4, reservedRawBytes: 14 });
      const cRead = f.track(f.broker.read(C, cCtx.token, cCtx.ticket, MAX_RAW_BYTES));
      const cState = watch(cRead);
      await f.waitHeld(8, [cRead]);
      expect(cState.settled).toBe(false);
      expect(f.broker.stats()).toMatchObject({ activeOps: 8, retiredActiveOps: 4, reservedRawBytes: 16 });

      // (e) Release everything: the retired owner's reads settle with the
      // cancellation they outlived, the live owners' reads fulfil with
      // the authored bytes, and once the surviving contexts are closed
      // every ledger counter is back at zero.
      f.fs.releaseAll();
      for (const outcome of [firstRead, ...aRest]) {
        expect(await outcome).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_CANCELLED' } });
      }
      for (const outcome of bReads) {
        expect(await outcome).toMatchObject({ status: 'fulfilled', value: { text: 'A', rawBytes: 1 } });
      }
      expect(await cRead).toMatchObject({ status: 'fulfilled', value: { text: 'A', rawBytes: 1 } });
      for (const ctx of bCtx) expect(await f.broker.closeContext(B, ctx.token)).toBe(true);
      expect(await f.broker.closeContext(C, cCtx.token)).toBe(true);
      expect(f.broker.stats()).toEqual({ contexts: 0, tickets: 0, disposed: false,
        activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0 });
      expect(f.fs.openHandles).toBe(0);
      expect(f.fs.heldBuffers.size).toBe(0);
    } finally { await f.cleanup(); }
  });
});

describe('lead: xref broker documented cleanup acknowledgement', () => {
  for (const method of ['cancel', 'closeContext'] as const) {
    it(`${method} cannot acknowledge joined cleanup while its held read descriptor is still live`, async () => {
      const f = fixture();
      try {
        const token = f.begin(), leaf = await f.broker.identify(OWNER, token, LEAF);
        f.fs.hold();
        const reading = f.track(f.broker.read(OWNER, token, leaf.ticket, MAX_RAW_BYTES));
        await f.waitHeld(1, [reading]);
        let acknowledged: { accepted: boolean; handles: number; buffers: number } | undefined;
        const acknowledgement = f.track(Promise.resolve(f.broker[method](OWNER, token)).then(accepted => {
          acknowledged = { accepted, handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size };
          return accepted;
        }));
        // One event-loop turn observes an already-completed acknowledgement without adding a deadline.
        await new Promise<void>(done => setImmediate(done));
        expect(f.fs.openHandles).toBe(1);
        expect(acknowledged).toBeUndefined();
        f.fs.releaseAll();
        expect(await reading).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_CANCELLED' } });
        expect(await acknowledgement).toEqual({ status: 'fulfilled', value: true });
        expect(acknowledged).toEqual({ accepted: true, handles: 0, buffers: 0 });
        expect(f.fs.openHandles).toBe(0);
      } finally { await f.cleanup(); }
    });
  }
});
