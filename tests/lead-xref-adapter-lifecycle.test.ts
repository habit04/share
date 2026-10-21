/** Independent P20.2 findings3/4 controls. Fake bridge only; no filesystem or Electron. */
import { describe, expect, it } from 'vitest';
import { createXrefReader, type XrefBrokerBridge, type XrefReaderSession } from '../src/app/xref-reader';
import type { XrefAdapterContext, XrefFileIdentity, XrefReadContext } from '../src/io/xref-loading';

const HOST = 'C:\\lifecycle\\host.dxf';
const LEAF = 'C:\\lifecycle\\leaf.dxf';
const SESSION: XrefReaderSession = { docId: 'doc-A', contentGeneration: 1, hostPath: HOST };
const NEXT_SESSION: XrefReaderSession = { ...SESSION, docId: 'doc-B', contentGeneration: 2 };
const TEXT = '0\nEOF\n';
const context = (signal?: AbortSignal): XrefAdapterContext => ({
  resolvedPath: LEAF, originalPath: 'leaf.dxf', blockName: 'L', depth: 1, ...(signal ? { signal } : {}),
});
const readContext = (signal?: AbortSignal): XrefReadContext => ({ ...context(signal), maxBytes: 4096 });

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const gate = () => ({ entered: deferred(), release: deferred() });
type Gate = ReturnType<typeof gate>;
type BeginInfo = Parameters<XrefBrokerBridge['beginXrefContext']>[0];
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

class ContextBoundBridge implements XrefBrokerBridge {
  readonly begins: Array<{ token: string; info: BeginInfo }> = [];
  readonly reads: Array<{ token: string; ticket: string; maxBytes: number }> = [];
  readonly cancellations: string[] = [];
  readonly closed: string[] = [];
  readonly live = new Set<string>();
  readonly tickets = new Map<string, { token: string; identity: XrefFileIdentity }>();
  readonly beginGates = new Map<number, Gate>();
  readonly readGates = new Map<number, Gate>();
  private readonly activeReads = new Map<string, Set<Gate>>();

  holdBegin(ordinal: number): Gate { const held = gate(); this.beginGates.set(ordinal, held); return held; }
  holdRead(ordinal: number): Gate { const held = gate(); this.readGates.set(ordinal, held); return held; }

  async beginXrefContext(info: BeginInfo) {
    const ordinal = this.begins.length + 1;
    const token = `context-${ordinal}-${info.docId}-${info.contentGeneration}`;
    this.begins.push({ token, info: { ...info } });
    const held = this.beginGates.get(ordinal);
    if (held) { held.entered.resolve(); await held.release.promise; }
    this.live.add(token);
    return { token };
  }

  async identifyXref(token: string, path: string) {
    if (!this.live.has(token)) throw new Error('ERR_XREF_CONTEXT: retired context');
    const identity: XrefFileIdentity = { id: 'win:7:42', owningLocation: path, version: `version:${token}` };
    // No universal fake ticket: a different context must never consume this one.
    const ticket = `ticket:${token}:${this.tickets.size + 1}`;
    this.tickets.set(ticket, { token, identity });
    return { ticket, identity };
  }

  async readXref(token: string, ticket: string, maxBytes: number) {
    this.reads.push({ token, ticket, maxBytes });
    if (!this.live.has(token)) throw new Error('ERR_XREF_CONTEXT: retired context');
    const owned = this.tickets.get(ticket);
    if (!owned || owned.token !== token) throw new Error('ERR_XREF_TICKET: ticket belongs to another context');
    const held = this.readGates.get(this.reads.length);
    if (held) {
      const active = this.activeReads.get(token) ?? new Set<Gate>();
      active.add(held); this.activeReads.set(token, active);
      held.entered.resolve();
      try { await held.release.promise; }
      finally { active.delete(held); if (!active.size) this.activeReads.delete(token); }
    }
    return { text: TEXT, byteLength: TEXT.length, version: owned.identity.version! };
  }

  async cancelXref(token: string) {
    this.cancellations.push(token);
    for (const held of this.activeReads.get(token) ?? []) {
      held.release.reject(new Error('ERR_XREF_CANCELLED: active broker read cancelled'));
    }
    return this.live.has(token);
  }

  async closeXrefContext(token: string) {
    this.closed.push(token);
    const existed = this.live.delete(token);
    for (const held of this.activeReads.get(token) ?? []) {
      held.release.reject(new Error('ERR_XREF_CANCELLED: broker context closed'));
    }
    return existed;
  }

  releaseEveryGate() {
    for (const held of [...this.beginGates.values(), ...this.readGates.values()]) held.release.resolve();
  }
}

function fixture() {
  const bridge = new ContextBoundBridge();
  const handle = createXrefReader(bridge, SESSION);
  const pending: Promise<unknown>[] = [];
  // Attach both outcomes immediately, including to operations deliberately rejected below.
  const track = <T>(promise: Promise<T>): Promise<Outcome<T>> => {
    const observed = promise.then<Outcome<T>, Outcome<T>>(
      value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }),
    );
    pending.push(observed);
    return observed;
  };
  async function cleanup() {
    bridge.releaseEveryGate();
    await Promise.allSettled(pending);
    await handle.dispose();
    // Fake-resource cleanup follows all assertions; it cannot satisfy a product disposal assertion.
    await Promise.all([...bridge.live].map(token => bridge.closeXrefContext(token)));
  }
  return { bridge, handle, track, cleanup };
}
type Fixture = ReturnType<typeof fixture>;

async function retireFailedBeginWhileReplacementStarts(f: Fixture) {
  const oldBegin = f.bridge.holdBegin(1), newBegin = f.bridge.holdBegin(2);
  const oldOperation = f.track(f.handle.reader.identify!(LEAF, context()));
  await oldBegin.entered.promise;
  f.handle.setSession(NEXT_SESSION);
  const newOperation = f.track(f.handle.reader.identify!(LEAF, context()));
  await newBegin.entered.promise;
  // A fails only after B's promise occupies the shared slot.
  oldBegin.release.reject(new Error('ERR_XREF_CONTEXT: authored old begin failure'));
  expect((await oldOperation).status).toBe('rejected');
  newBegin.release.resolve();
  const current = await newOperation;
  expect(current.status).toBe('fulfilled');
  const token = f.bridge.begins[1]!.token;
  expect(f.bridge.live.has(token)).toBe(true);
  return token;
}

describe('lead: xref adapter context-promise ownership', () => {
  it('control: ordinary identify/read retain their unique context ticket and dispose closes it', async () => {
    const f = fixture();
    try {
      const identity = await f.handle.reader.identify!(LEAF, context());
      const token = f.bridge.begins[0]!.token;
      const result = await f.handle.reader.readText(LEAF, readContext());
      expect(result).toEqual({ text: TEXT, byteLength: TEXT.length, version: identity!.version });
      expect(f.bridge.begins).toHaveLength(1);
      expect(f.bridge.reads[0]).toMatchObject({ token, maxBytes: 4096 });
      expect(f.bridge.tickets.get(f.bridge.reads[0]!.ticket)!.token).toBe(token);
      await f.handle.dispose();
      expect(f.bridge.closed).toEqual([token]);
      expect([...f.bridge.live]).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('a retired failed begin cannot clear B and pair B tickets with a newly begun C', async () => {
    const f = fixture();
    try {
      const tokenB = await retireFailedBeginWhileReplacementStarts(f);
      const result = await f.track(f.handle.reader.readText(LEAF, readContext()));
      expect(result).toMatchObject({ status: 'fulfilled', value: { text: TEXT, version: `version:${tokenB}` } });
      expect(f.bridge.begins).toHaveLength(2);
      expect(f.bridge.reads).toHaveLength(1);
      expect(f.bridge.reads[0]!.token).toBe(tokenB);
      expect(f.bridge.tickets.get(f.bridge.reads[0]!.ticket)!.token).toBe(tokenB);
    } finally { await f.cleanup(); }
  });

  it('a retired failed begin cannot lose B from dispose after B has succeeded', async () => {
    const f = fixture();
    try {
      const tokenB = await retireFailedBeginWhileReplacementStarts(f);
      await f.handle.dispose();
      expect(f.bridge.closed).toEqual([tokenB]);
      expect([...f.bridge.live]).toEqual([]);
    } finally { await f.cleanup(); }
  });
});

describe('lead: xref adapter abort-listener ownership', () => {
  it('control: aborting an active read still cancels that context and refuses the result', async () => {
    const f = fixture();
    try {
      await f.handle.reader.identify!(LEAF, context());
      const held = f.bridge.holdRead(1), controller = new AbortController();
      const active = f.track(f.handle.reader.readText(LEAF, readContext(controller.signal)));
      await held.entered.promise;
      controller.abort();
      expect(await active).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
      expect(f.bridge.cancellations).toEqual([f.bridge.begins[0]!.token]);
    } finally { await f.cleanup(); }
  });

  for (const completed of ['identify', 'read'] as const) {
    it(`aborting completed ${completed} A cannot cancel later deferred read B in the same context`, async () => {
      const f = fixture();
      try {
        const oldSignal = new AbortController(), newSignal = new AbortController();
        await f.handle.reader.identify!(LEAF, context(completed === 'identify' ? oldSignal.signal : undefined));
        if (completed === 'read') await f.handle.reader.readText(LEAF, readContext(oldSignal.signal));
        const held = f.bridge.holdRead(f.bridge.reads.length + 1);
        const current = f.track(f.handle.reader.readText(LEAF, readContext(newSignal.signal)));
        await held.entered.promise;
        oldSignal.abort();
        // Settle the fake physical read; cancellation, if incorrectly forwarded, has already rejected it.
        held.release.resolve();
        const result = await current;
        expect(result).toMatchObject({ status: 'fulfilled', value: { text: TEXT } });
        expect(f.bridge.cancellations).toEqual([]);
        expect(newSignal.signal.aborted).toBe(false);
        expect(f.bridge.begins).toHaveLength(1);
      } finally { await f.cleanup(); }
    });
  }
});
