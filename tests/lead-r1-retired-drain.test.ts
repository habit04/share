/** Existing async-drain contract only: one deferred fake read/close, no native filesystem. */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createXrefReader, type XrefBrokerBridge, type XrefReaderSession } from '../src/app/xref-reader';

const require = createRequire(import.meta.url);
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<{ text: string }>;
  closeContext(owner: string, token: string): Promise<boolean>;
  retireOwner(owner: string): number;
  closeAll(): Promise<void>;
  stats(): { contexts: number; tickets: number; disposed: boolean; activeOps: number; retiredActiveOps: number; reservedRawBytes: number };
}
const { createXrefReadBroker, MAX_RAW_BYTES } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker(deps: Record<string, unknown>): Broker;
  MAX_RAW_BYTES: number;
};
const OWNER = 'wc:retired-drain';
const HOST = 'C:\\retired-drain\\host.dxf';
const LEAF = 'C:\\retired-drain\\leaf.dxf';
const SESSION: XrefReaderSession = { docId: 'drain-A', contentGeneration: 1, hostPath: HOST };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(done => setImmediate(done));
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
function tracker() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    track<T>(promise: Promise<T>): Promise<Outcome<T>> {
      const observed = promise.then<Outcome<T>, Outcome<T>>(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      pending.push(observed); return observed;
    },
  };
}

class OneHeldReadFs {
  handles = 0;
  closed = 0;
  hold = false;
  readonly readEntered = deferred();
  readonly readRelease = deferred();
  readonly closeEntered = deferred();
  readonly closeRelease = deferred();
  private statOf(big = false) {
    return { dev: big ? 7n : 7, ino: big ? 42n : 42, size: big ? 1n : 1,
      mtimeNs: big ? 1000n : 1000, ctimeNs: big ? 2000n : 2000, isFile: () => true };
  }
  async realpath(path: string) { if (path !== LEAF) throw Error('Unexpected fake path'); return LEAF; }
  async stat(path: string, options?: { bigint?: boolean }) { if (path !== LEAF) throw Error('Unexpected fake path'); return this.statOf(options?.bigint); }
  async open(path: string) {
    if (path !== LEAF) throw Error('Unexpected fake path');
    this.handles++; let position = 0, entered = false, closed = false;
    return {
      stat: async (options?: { bigint?: boolean }) => this.statOf(options?.bigint),
      read: async (buffer: Buffer, offset: number, length: number, requestedPosition: number | null) => {
        if (this.hold && !entered) { entered = true; this.readEntered.resolve(); await this.readRelease.promise; }
        const at = requestedPosition === null ? position : requestedPosition;
        const bytesRead = Math.max(0, Math.min(length, 1 - at));
        if (bytesRead) buffer[offset] = 65;
        position = at + bytesRead; return { bytesRead, buffer };
      },
      close: async () => {
        if (closed) throw Error('Fake handle closed twice');
        if (entered && this.hold) { this.closeEntered.resolve(); await this.closeRelease.promise; }
        closed = true; this.handles--; this.closed++;
      },
    };
  }
  releaseAll() { this.hold = false; this.readRelease.resolve(); this.closeRelease.resolve(); }
}

async function brokerFixture() {
  const fs = new OneHeldReadFs(), jobs = tracker(); let serial = 0;
  const broker = createXrefReadBroker({ fs, isKnownPath: (path: string) => path === LEAF,
    decodeDxf: async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' }), newId: () => `drain-${++serial}` });
  const token = broker.beginContext(OWNER, { docId: SESSION.docId, contentGeneration: 1, hostAnchor: HOST }).token;
  const leaf = await broker.identify(OWNER, token, LEAF);
  fs.hold = true;
  const reading = jobs.track(broker.read(OWNER, token, leaf.ticket, MAX_RAW_BYTES));
  await Promise.race([fs.readEntered.promise, reading.then(result => { throw Error(`Read settled before held-I/O witness: ${result.status}`); })]);
  async function cleanup() {
    fs.releaseAll(); await Promise.allSettled(jobs.pending); await broker.closeAll();
    expect(fs.handles).toBe(0); expect(broker.stats().activeOps).toBe(0); expect(broker.stats().reservedRawBytes).toBe(0);
  }
  return { fs, broker, token, reading, jobs, cleanup };
}

describe('lead R1: whole-broker drain includes already-retired I/O', () => {
  for (const retiredBy of ['live-control', 'retireOwner', 'closeContext', 'previous-closeAll'] as const) {
    it(`${retiredBy}: closeAll waits for read AND descriptor-close completion`, async () => {
      const f = await brokerFixture();
      try {
        expect(MAX_RAW_BYTES).toBe(16 * 1024 * 1024); // No new concurrency/budget premise.
        if (retiredBy === 'retireOwner') expect(f.broker.retireOwner(OWNER)).toBe(1);
        if (retiredBy === 'closeContext') f.jobs.track(f.broker.closeContext(OWNER, f.token));
        if (retiredBy === 'previous-closeAll') f.jobs.track(f.broker.closeAll());
        let acknowledged: { handles: number; active: number; reserved: number } | undefined;
        const draining = f.jobs.track(f.broker.closeAll().then(() => {
          acknowledged = { handles: f.fs.handles, active: f.broker.stats().activeOps, reserved: f.broker.stats().reservedRawBytes };
        }));
        await turn();
        expect(f.fs.handles).toBe(1);
        expect(f.broker.stats()).toMatchObject({ contexts: 0, activeOps: 1, retiredActiveOps: 1 });
        expect(f.broker.stats().reservedRawBytes).toBeGreaterThan(0);
        expect(acknowledged).toBeUndefined();
        f.fs.readRelease.resolve();
        await f.fs.closeEntered.promise;
        await turn();
        expect(f.fs.handles).toBe(1);
        expect(acknowledged).toBeUndefined();
        f.fs.closeRelease.resolve();
        expect(await f.reading).toMatchObject({ status: 'rejected', reason: { code: 'ERR_XREF_CANCELLED' } });
        expect(await draining).toMatchObject({ status: 'fulfilled' });
        expect(acknowledged).toEqual({ handles: 0, active: 0, reserved: 0 });
      } finally { await f.cleanup(); }
    });
  }
});

class HeldCloseBridge implements XrefBrokerBridge {
  readonly closeEntered = deferred();
  readonly closeRelease = deferred();
  readonly closeFinished = deferred();
  begins = 0;
  closes: string[] = [];
  finished: string[] = [];
  async beginXrefContext(_info: Parameters<XrefBrokerBridge['beginXrefContext']>[0]) { return { token: `context-${++this.begins}` }; }
  async identifyXref(token: string, path: string) { return { ticket: `${token}:ticket`, identity: { id: token, owningLocation: path } }; }
  async readXref(_token: string, _ticket: string, _maxBytes: number) { return { text: 'A', byteLength: 1, version: 'v1' }; }
  async cancelXref(_token: string) { return true; }
  async closeXrefContext(token: string) {
    this.closes.push(token); this.closeEntered.resolve();
    await this.closeRelease.promise;
    this.finished.push(token); this.closeFinished.resolve(); return true;
  }
}

describe('lead R1: adapter disposal joins owned current and retired context closes', () => {
  for (const path of ['current-control', 'setSession-retired', 'reentrant-dispose'] as const) {
    it(`${path}: dispose cannot acknowledge while its context close is pending`, async () => {
      const bridge = new HeldCloseBridge(), handle = createXrefReader(bridge, SESSION), jobs = tracker();
      try {
        await handle.reader.identify!(LEAF, { resolvedPath: LEAF, originalPath: 'leaf.dxf', blockName: 'L', depth: 1 });
        if (path === 'setSession-retired') {
          handle.setSession({ ...SESSION, docId: 'drain-B', contentGeneration: 2 });
          await bridge.closeEntered.promise;
        }
        if (path === 'reentrant-dispose') {
          jobs.track(handle.dispose());
          await bridge.closeEntered.promise;
        }
        let acknowledged = false;
        const disposing = jobs.track(handle.dispose().then(() => { acknowledged = true; }));
        await bridge.closeEntered.promise;
        await turn();
        expect(bridge.finished).toEqual([]);
        expect(acknowledged).toBe(false);
        bridge.closeRelease.resolve();
        expect(await disposing).toMatchObject({ status: 'fulfilled' });
        await bridge.closeFinished.promise;
        expect(bridge.finished).toEqual(['context-1']);
        expect(bridge.closes).toEqual(['context-1']);
        expect(bridge.begins).toBe(1);
      } finally {
        bridge.closeRelease.resolve(); await Promise.allSettled(jobs.pending); await handle.dispose();
        if (bridge.closes.length) await bridge.closeFinished.promise;
      }
    });
  }
});
