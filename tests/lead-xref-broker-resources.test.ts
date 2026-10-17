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
  stats(): { contexts: number; tickets: number; disposed: boolean };
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
  private readonly release = deferred();
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
          this.heldBuffers.set(id, buffer);
          for (const waiter of this.waiters) if (this.heldBuffers.size >= waiter.count) waiter.ready.resolve();
          try { await this.release.promise; }
          finally { this.heldBuffers.delete(id); }
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
  releaseAll() { this.holding = false; this.release.resolve(); }
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

  it('witness only: 65 held reads of one ticket outlive owner retirement while a fresh context starts', async () => {
    const f = fixture();
    try {
      const token = f.begin(), leaf = await f.broker.identify(OWNER, token, LEAF);
      f.fs.hold();
      const oldReads = Array.from({ length: 65 }, () => f.track(f.broker.read(OWNER, token, leaf.ticket, MAX_RAW_BYTES)));
      await f.waitHeld(65, oldReads);
      const beforeRetirement = { handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size,
        bufferBytes: f.fs.heldBytes(), ...f.broker.stats() };
      expect(beforeRetirement).toMatchObject({ handles: 65, buffers: 65, contexts: 1, tickets: 1 });
      expect([...f.fs.heldBuffers.values()].every(buffer => buffer.byteLength <= 2)).toBe(true);

      expect(f.broker.retireOwner(OWNER)).toBe(1);
      const afterRetirement = { handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size, ...f.broker.stats() };
      expect(afterRetirement).toMatchObject({ handles: 65, buffers: 65, contexts: 0, tickets: 0 });
      const nextToken = f.begin(2), nextLeaf = await f.broker.identify(OWNER, nextToken, LEAF);
      const currentRead = f.track(f.broker.read(OWNER, nextToken, nextLeaf.ticket, MAX_RAW_BYTES));
      await f.waitHeld(66, [currentRead]);
      const replacement = { handles: f.fs.openHandles, buffers: f.fs.heldBuffers.size,
        bufferBytes: f.fs.heldBytes(), ...f.broker.stats() };
      expect(replacement).toMatchObject({ handles: 66, buffers: 66, contexts: 1, tickets: 1 });
      console.info('LEAD_XREF_RESOURCE_WITNESS', JSON.stringify({
        purpose: 'measurement, not a proposed concurrency threshold', maxRawBytes: MAX_RAW_BYTES,
        beforeRetirement, afterRetirement, replacement,
      }));
      f.fs.releaseAll();
      for (const result of await Promise.all(oldReads)) {
        expect(result).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_CANCELLED' } });
      }
      expect(await currentRead).toMatchObject({ status: 'fulfilled', value: { text: 'A', rawBytes: 1 } });
      expect(f.fs.openHandles).toBe(0);
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
