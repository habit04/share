/**
 * Priority 20.2 correction R1/R2 — exact-cap acceptance tests for the
 * broker's operation/reservation ledger and drain joins.
 *
 * Tiny inputs throughout; large files exist only as REPORTED stat
 * sizes. Every ceiling is hit EXACTLY (1 per context, 4 per owner, 8
 * globally, 64 MiB reserved raw bytes including the helper's +1 EOF
 * sentinel), every refusal is proven to happen BEFORE any filesystem
 * call (call-count snapshots), and credits are shown to be released
 * on success, error, cancel and downstream refusal — and to SURVIVE
 * owner retirement until the retired operation's cleanup completes.
 * Fake fs only; no Electron, no native acceptance implied.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createXrefReadBroker, MAX_RAW_BYTES } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker: (deps: Record<string, unknown>) => Broker;
  MAX_RAW_BYTES: number;
};

interface Identity { id: string; owningLocation: string; version: string }
interface Stats { contexts: number; tickets: number; disposed: boolean; activeOps: number; retiredActiveOps: number; reservedRawBytes: number }
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string; identity: Identity }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<{ text: string; byteLength: number; version: string; rawBytes: number }>;
  cancel(owner: string, token: string): Promise<boolean>;
  closeContext(owner: string, token: string): Promise<boolean>;
  retireOwner(owner: string): number;
  closeAll(): Promise<void>;
  stats(): Stats;
}

const MIB = 1024 * 1024;
const HOST = 'C:\\caps\\host.dxf';
const leaf = (n: number) => `C:\\caps\\leaf${n}.dxf`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class CapsFs {
  files = new Map<string, { content: Buffer; size: bigint; ino: bigint }>();
  counts = { open: 0, stat: 0, realpath: 0, read: 0, close: 0 };
  openHandles = 0;
  private readGates = new Map<string, ReturnType<typeof deferred>>();
  private realpathGates = new Map<string, ReturnType<typeof deferred>>();

  add(path: string, content: string, ino: bigint, reportedSize?: bigint) {
    const bytes = Buffer.from(content, 'utf8');
    this.files.set(path, { content: bytes, size: reportedSize ?? BigInt(bytes.length), ino });
  }
  holdRead(path: string) { if (!this.readGates.has(path)) this.readGates.set(path, deferred()); }
  releaseRead(path: string) { this.readGates.get(path)?.resolve(); this.readGates.delete(path); }
  holdRealpath(path: string) { if (!this.realpathGates.has(path)) this.realpathGates.set(path, deferred()); }
  releaseRealpath(path: string) { this.realpathGates.get(path)?.resolve(); this.realpathGates.delete(path); }
  releaseAll() { for (const p of [...this.readGates.keys()]) this.releaseRead(p); for (const p of [...this.realpathGates.keys()]) this.releaseRealpath(p); }

  private entry(p: string) {
    const f = this.files.get(p);
    if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return f;
  }
  private statOf(f: { size: bigint; ino: bigint }, opts?: { bigint?: boolean }) {
    const big = !!opts?.bigint;
    return {
      dev: big ? 7n : 7, ino: big ? f.ino : Number(f.ino),
      size: big ? f.size : Number(f.size),
      mtimeNs: big ? 1000n : 1000, ctimeNs: big ? 2000n : 2000,
      isFile: () => true,
    };
  }
  async realpath(p: string): Promise<string> {
    this.counts.realpath += 1;
    const gate = this.realpathGates.get(p);
    if (gate) await gate.promise;
    this.entry(p);
    return p;
  }
  async stat(p: string, opts?: { bigint?: boolean }) {
    this.counts.stat += 1;
    return this.statOf(this.entry(p), opts);
  }
  async open(p: string) {
    this.counts.open += 1;
    const f = this.entry(p);
    this.openHandles += 1;
    let pos = 0;
    return {
      stat: async (opts?: { bigint?: boolean }) => this.statOf(f, opts),
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        this.counts.read += 1;
        const gate = this.readGates.get(p);
        if (gate) await gate.promise;
        const at = position === null ? pos : position;
        const n = Math.max(0, Math.min(length, f.content.length - at));
        f.content.copy(buffer, offset, at, at + n);
        pos = at + n;
        return { bytesRead: n, buffer };
      },
      close: async () => { this.counts.close += 1; this.openHandles -= 1; },
    };
  }
  totalCalls(): number { return this.counts.open + this.counts.stat + this.counts.realpath + this.counts.read; }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const track = <T>(p: Promise<T>): Promise<Outcome<T>> => p.then(
  (value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }),
);
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond(), `condition never met: ${what}`).toBe(true);
}
const BUSY = { code: 'ERR_XREF_RESOURCE_BUSY' };

function setup(grantedPaths: string[]) {
  const fs = new CapsFs();
  const granted = new Set(grantedPaths);
  let n = 0;
  const broker = createXrefReadBroker({
    fs,
    isKnownPath: (p: string) => granted.has(p),
    decodeDxf: async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' }),
    newId: () => `cap-${++n}`,
  });
  const begin = (owner: string) => broker.beginContext(owner, { docId: 'doc', contentGeneration: 1, hostAnchor: HOST }).token;
  return { fs, granted, broker, begin };
}

describe('R1 — active-operation ceilings are exact, with zero queue', () => {
  it('per-context ceiling 1: a held read refuses a second read AND an identify on the same context before any I/O', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1), leaf(2)]);
    fs.add(leaf(1), 'AAAAA', 1n);
    fs.add(leaf(2), 'BBBBB', 2n);
    const token = begin('wc:1');
    const t1 = await broker.identify('wc:1', token, leaf(1));
    await broker.identify('wc:1', token, leaf(2));
    fs.holdRead(leaf(1));
    const held = track(broker.read('wc:1', token, t1.ticket, 1024));
    await until(() => fs.counts.read === 1, 'first read parked');
    expect(broker.stats()).toMatchObject({ activeOps: 1, reservedRawBytes: 6 });
    const before = fs.totalCalls();
    // Both refusals settle while the first read is STILL parked: zero queue.
    await expect(broker.read('wc:1', token, t1.ticket, 1024)).rejects.toMatchObject(BUSY);
    await expect(broker.identify('wc:1', token, leaf(2))).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before); // refusal happened before any filesystem call
    expect(broker.stats()).toMatchObject({ activeOps: 1, reservedRawBytes: 6 }); // refusals charged nothing
    fs.releaseRead(leaf(1));
    await expect(held).resolves.toMatchObject({ ok: true, value: { text: 'AAAAA' } });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });

  it('identify operations are counted: a held identify occupies the context slot', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1), leaf(2)]);
    fs.add(leaf(1), 'AAAAA', 1n);
    fs.add(leaf(2), 'BBBBB', 2n);
    const token = begin('wc:1');
    const t2 = await broker.identify('wc:1', token, leaf(2));
    fs.holdRealpath(leaf(1));
    const heldIdentify = track(broker.identify('wc:1', token, leaf(1)));
    await until(() => fs.counts.realpath >= 1, 'identify parked in realpath');
    expect(broker.stats().activeOps).toBe(1);
    const before = fs.totalCalls();
    await expect(broker.read('wc:1', token, t2.ticket, 1024)).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before);
    fs.releaseRealpath(leaf(1));
    await expect(heldIdentify).resolves.toMatchObject({ ok: true });
    expect(broker.stats().activeOps).toBe(0);
  });

  it('per-owner ceiling 4: four held reads across four contexts admit, the fifth refuses before I/O; another owner is unaffected', async () => {
    const paths = [leaf(1), leaf(2), leaf(3), leaf(4), leaf(5), leaf(6)];
    const { fs, broker, begin } = setup([HOST, ...paths]);
    paths.forEach((p, i) => fs.add(p, 'AAAAA', BigInt(i + 1)));
    const tokens = paths.map(() => begin('wc:1'));
    const tickets: string[] = [];
    for (let i = 0; i < paths.length; i++) tickets.push((await broker.identify('wc:1', tokens[i]!, paths[i]!)).ticket);
    const otherToken = begin('wc:2');
    const otherTicket = (await broker.identify('wc:2', otherToken, leaf(6))).ticket;
    for (let i = 0; i < 4; i++) fs.holdRead(paths[i]!);
    const held = tickets.slice(0, 4).map((t, i) => track(broker.read('wc:1', tokens[i]!, t, 1024)));
    await until(() => fs.counts.read === 4, 'four reads parked');
    expect(broker.stats().activeOps).toBe(4);
    const before = fs.totalCalls();
    await expect(broker.read('wc:1', tokens[4]!, tickets[4]!, 1024)).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before);
    // A different owner still has its own four slots (global is 8).
    const other = track(broker.read('wc:2', otherToken, otherTicket, 1024));
    await expect(other).resolves.toMatchObject({ ok: true, value: { text: 'AAAAA' } });
    for (let i = 0; i < 4; i++) fs.releaseRead(paths[i]!);
    for (const h of held) await expect(h).resolves.toMatchObject({ ok: true });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });

  it('identify operations count toward the owner ceiling too', async () => {
    const paths = [leaf(1), leaf(2), leaf(3), leaf(4), leaf(5)];
    const { fs, broker, begin } = setup([HOST, ...paths]);
    paths.forEach((p, i) => fs.add(p, 'AAAAA', BigInt(i + 1)));
    const tokens = paths.map(() => begin('wc:1'));
    for (let i = 0; i < 4; i++) fs.holdRealpath(paths[i]!);
    const held = tokens.slice(0, 4).map((t, i) => track(broker.identify('wc:1', t, paths[i]!)));
    await until(() => fs.counts.realpath === 4, 'four identifies parked');
    expect(broker.stats().activeOps).toBe(4);
    const before = fs.totalCalls();
    await expect(broker.identify('wc:1', tokens[4]!, leaf(5))).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before);
    for (let i = 0; i < 4; i++) fs.releaseRealpath(paths[i]!);
    for (const h of held) await expect(h).resolves.toMatchObject({ ok: true });
    expect(broker.stats().activeOps).toBe(0);
  });

  it('global ceiling 8: eight held reads across two owners admit, a ninth (third owner) refuses before I/O', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => leaf(i + 1));
    const { fs, broker, begin } = setup([HOST, ...paths]);
    paths.forEach((p, i) => fs.add(p, 'AAAAA', BigInt(i + 1)));
    const owners = ['wc:1', 'wc:1', 'wc:1', 'wc:1', 'wc:2', 'wc:2', 'wc:2', 'wc:2', 'wc:3'];
    const tokens = owners.map((o) => begin(o));
    const tickets: string[] = [];
    for (let i = 0; i < paths.length; i++) tickets.push((await broker.identify(owners[i]!, tokens[i]!, paths[i]!)).ticket);
    for (let i = 0; i < 8; i++) fs.holdRead(paths[i]!);
    const held = tickets.slice(0, 8).map((t, i) => track(broker.read(owners[i]!, tokens[i]!, t, 1024)));
    await until(() => fs.counts.read === 8, 'eight reads parked');
    expect(broker.stats().activeOps).toBe(8);
    const before = fs.totalCalls();
    await expect(broker.read('wc:3', tokens[8]!, tickets[8]!, 1024)).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before);
    for (let i = 0; i < 8; i++) fs.releaseRead(paths[i]!);
    for (const h of held) await expect(h).resolves.toMatchObject({ ok: true });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
    expect(fs.openHandles).toBe(0);
  });
});

describe('R1 — reservation accounting (identified size + EOF sentinel, 64 MiB global)', () => {
  it('a held read reserves exactly size+1; success releases it', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1)]);
    fs.add(leaf(1), 'AAAAA', 1n); // 5 raw bytes
    const token = begin('wc:1');
    const t = await broker.identify('wc:1', token, leaf(1));
    fs.holdRead(leaf(1));
    const held = track(broker.read('wc:1', token, t.ticket, 1024));
    await until(() => fs.counts.read === 1, 'read parked');
    expect(broker.stats().reservedRawBytes).toBe(6); // 5 + 1 EOF sentinel
    fs.releaseRead(leaf(1));
    await expect(held).resolves.toMatchObject({ ok: true });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });

  it('the boundary pair: size 64 MiB - 1 and size 64 MiB both refuse with the permanent per-file LIMIT before any I/O (an ineligible size is never BUSY)', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1), leaf(2)]);
    fs.add(leaf(1), 'A', 1n, BigInt(64 * MIB - 1)); // (size + 1 sentinel) == the 64 MiB ceiling exactly
    fs.add(leaf(2), 'B', 2n, BigInt(64 * MIB)); // (size + 1 sentinel) == one byte over the ceiling
    const t1 = begin('wc:1');
    const big = await broker.identify('wc:1', t1, leaf(1));
    const t2 = begin('wc:1');
    const over = await broker.identify('wc:1', t2, leaf(2));
    // Both identified sizes exceed the 16 MiB per-file ceiling, so
    // the permanent identified-size limit answers before admission
    // (correction R2 policy ruling: LIMIT precedes temporary BUSY).
    await expect(broker.read('wc:1', t1, big.ticket, MAX_RAW_BYTES)).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
    // The larger size (whose size + 1 sentinel crosses the 64 MiB
    // reservation ceiling) gets the same permanent LIMIT, still
    // before the file is even opened.
    const opensBefore = fs.counts.open;
    const before = fs.totalCalls();
    await expect(broker.read('wc:1', t2, over.ticket, MAX_RAW_BYTES)).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
    expect(fs.counts.open).toBe(opensBefore);
    expect(fs.totalCalls()).toBe(before);
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });

  it('aggregate reservations: parked reads fill the ledger to exactly 64 MiB; one more byte of charge refuses before I/O', async () => {
    const paths = [leaf(1), leaf(2), leaf(3), leaf(4), leaf(5)];
    const { fs, broker, begin } = setup([HOST, ...paths]);
    // Reported sizes stay within the 16 MiB per-file allowance so the
    // helper admits them and the reads can park: charges are
    // 3 x (16 MiB + 1) and 1 x (16 MiB - 4 + 1), totalling exactly 64 MiB.
    fs.add(leaf(1), 'A', 1n, BigInt(16 * MIB));
    fs.add(leaf(2), 'A', 2n, BigInt(16 * MIB));
    fs.add(leaf(3), 'A', 3n, BigInt(16 * MIB));
    fs.add(leaf(4), 'A', 4n, BigInt(16 * MIB - 4));
    fs.add(leaf(5), 'A', 5n);
    const owners = ['wc:1', 'wc:1', 'wc:2', 'wc:2', 'wc:3'];
    const tokens = owners.map((o) => begin(o));
    const tickets: string[] = [];
    for (let i = 0; i < paths.length; i++) tickets.push((await broker.identify(owners[i]!, tokens[i]!, paths[i]!)).ticket);
    const held: Array<Promise<Outcome<unknown>>> = [];
    for (let i = 0; i < 3; i++) {
      fs.holdRead(paths[i]!);
      held.push(track(broker.read(owners[i]!, tokens[i]!, tickets[i]!, MAX_RAW_BYTES)));
    }
    await until(() => fs.counts.read === 3, 'three 16 MiB reads parked');
    expect(broker.stats().reservedRawBytes).toBe(3 * (16 * MIB + 1));
    fs.holdRead(leaf(4));
    held.push(track(broker.read('wc:2', tokens[3]!, tickets[3]!, MAX_RAW_BYTES)));
    await until(() => fs.counts.read === 4, 'fourth read parked at the exact ceiling');
    expect(broker.stats().reservedRawBytes).toBe(64 * MIB); // exactly full, still admitted
    const before = fs.totalCalls();
    await expect(broker.read('wc:3', tokens[4]!, tickets[4]!, 1024)).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before); // reservation refusal precedes I/O
    const drains = tokens.slice(0, 4).map((t, i) => broker.cancel(owners[i]!, t));
    for (let i = 0; i < 4; i++) fs.releaseRead(paths[i]!);
    for (const h of held) await expect(h).resolves.toMatchObject({ ok: false });
    for (const d of drains) await expect(d).resolves.toBe(true);
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
    expect(fs.openHandles).toBe(0);
  });

  it('authority failure consumes no slot and no reservation', async () => {
    const { fs, granted, broker, begin } = setup([HOST, leaf(1)]);
    fs.add(leaf(1), 'AAAAA', 1n);
    const token = begin('wc:1');
    // Outside the host's folder tree: ungranted by name AND outside the
    // P1 host-folder rule (a sibling would now be authorized, then MISSING).
    await expect(broker.identify('wc:1', token, 'C:\\outside\\ungranted.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
    const t = await broker.identify('wc:1', token, leaf(1));
    await expect(broker.read('wc:1', token, 'forged-ticket', 1024)).rejects.toMatchObject({ code: 'ERR_XREF_TICKET' });
    await expect(broker.read('wc:1', token, t.ticket, 0)).rejects.toMatchObject({ code: 'ERR_XREF_ARGUMENT' });
    granted.delete(leaf(1)); // permission revoked after identification
    granted.delete(HOST); // under the P1 host-folder rule the leaf stays readable while its host is granted; revoke both
    await expect(broker.read('wc:1', token, t.ticket, 1024)).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });
});

describe('R1/R2 — credits are released on every outcome and survive retirement until cleanup', () => {
  it('release on error: a changed file and a failed identify free their slots immediately', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1), leaf(2)]);
    fs.add(leaf(1), 'AAAAA', 1n);
    fs.add(leaf(2), 'BBBBB', 2n);
    const token = begin('wc:1');
    const t = await broker.identify('wc:1', token, leaf(1));
    fs.files.get(leaf(1))!.ino = 99n; // replacement after identification
    await expect(broker.read('wc:1', token, t.ticket, 1024)).rejects.toMatchObject({ code: 'ERR_XREF_CHANGED' });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
    // Outside the host's folder tree, so the P1 host-folder rule does
    // not authorize it either (a sibling ghost would now be MISSING).
    await expect(broker.identify('wc:1', token, 'C:\\outside\\ghost.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    // A granted-but-absent identify (fs error path) also frees the slot:
    const s2 = setup([HOST, 'C:\\caps\\absent.dxf']);
    const tok2 = s2.begin('wc:1');
    await expect(s2.broker.identify('wc:1', tok2, 'C:\\caps\\absent.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_MISSING' });
    expect(s2.broker.stats().activeOps).toBe(0);
    await expect(s2.broker.identify('wc:1', tok2, 'C:\\caps\\absent.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_MISSING' });
  });

  it('release on downstream refusal: a decode failure after a full read frees the reservation', async () => {
    const fs = new CapsFs();
    fs.add(leaf(1), 'AAAAA', 1n);
    let n = 0;
    const broker = createXrefReadBroker({
      fs, isKnownPath: () => true,
      decodeDxf: async () => { throw new Error('not a dxf'); },
      newId: () => `dec-${++n}`,
    });
    const token = broker.beginContext('wc:1', { docId: 'd', contentGeneration: 1, hostAnchor: HOST }).token;
    const t = await broker.identify('wc:1', token, leaf(1));
    await expect(broker.read('wc:1', token, t.ticket, 1024)).rejects.toMatchObject({ code: 'ERR_XREF_DECODE' });
    expect(broker.stats()).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
  });

  it('retirement churn: a retired owner\u2019s in-flight read keeps its credits until its cleanup completes, then frees them', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => leaf(i + 1));
    const { fs, broker, begin } = setup([HOST, ...paths]);
    paths.forEach((p, i) => fs.add(p, 'AAAAA', BigInt(i + 1)));
    // Owners: O = wc:old (1 ctx), P = wc:p (4 ctx), Q = wc:q (3 ctx), R = wc:r (1 ctx).
    const owners = ['wc:old', 'wc:p', 'wc:p', 'wc:p', 'wc:p', 'wc:q', 'wc:q', 'wc:q', 'wc:r'];
    const tokens = owners.map((o) => begin(o));
    const tickets: string[] = [];
    for (let i = 0; i < paths.length; i++) tickets.push((await broker.identify(owners[i]!, tokens[i]!, paths[i]!)).ticket);

    fs.holdRead(paths[0]!);
    const retiredRead = track(broker.read('wc:old', tokens[0]!, tickets[0]!, 1024));
    await until(() => fs.counts.read === 1, 'soon-retired read parked');
    expect(broker.retireOwner('wc:old')).toBe(1);
    // Capability is gone, but the credit is NOT: it lives in the retired ledger.
    expect(broker.stats()).toMatchObject({ contexts: 8, activeOps: 1, retiredActiveOps: 1, reservedRawBytes: 6 });
    await expect(broker.identify('wc:old', tokens[0]!, paths[0]!)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });

    for (let i = 1; i < 8; i++) fs.holdRead(paths[i]!);
    const held = tickets.slice(1, 8).map((t, i) => track(broker.read(owners[i + 1]!, tokens[i + 1]!, t, 1024)));
    await until(() => fs.counts.read === 8, 'seven more reads parked');
    expect(broker.stats()).toMatchObject({ activeOps: 8, retiredActiveOps: 1, reservedRawBytes: 48 });
    // The retired operation still counts globally: a ninth refuses.
    const before = fs.totalCalls();
    await expect(broker.read('wc:r', tokens[8]!, tickets[8]!, 1024)).rejects.toMatchObject(BUSY);
    expect(fs.totalCalls()).toBe(before);

    // Let the retired read's cleanup actually complete: its credits free.
    fs.releaseRead(paths[0]!);
    await expect(retiredRead).resolves.toMatchObject({ ok: false, error: { code: 'ERR_XREF_CANCELLED' } });
    expect(broker.stats()).toMatchObject({ activeOps: 7, retiredActiveOps: 0, reservedRawBytes: 42 });

    for (let i = 1; i < 8; i++) fs.releaseRead(paths[i]!);
    for (const h of held) await expect(h).resolves.toMatchObject({ ok: true });
    expect(broker.stats()).toMatchObject({ activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0 });
    expect(fs.openHandles).toBe(0);
    // Freed global room is real: the previously refused read now succeeds.
    await expect(broker.read('wc:r', tokens[8]!, tickets[8]!, 1024)).resolves.toMatchObject({ text: 'AAAAA' });
  });

  it('drain joins: cancel on an idle context resolves true; unknown tokens resolve false; closeAll resolves only after the held op drains', async () => {
    const { fs, broker, begin } = setup([HOST, leaf(1)]);
    fs.add(leaf(1), 'AAAAA', 1n);
    const token = begin('wc:1');
    const t = await broker.identify('wc:1', token, leaf(1));
    await expect(broker.cancel('wc:1', token)).resolves.toBe(true); // nothing in flight
    await expect(broker.cancel('wc:1', 'nope')).resolves.toBe(false);
    await expect(broker.closeContext('wc:1', 'nope')).resolves.toBe(false);
    fs.holdRead(leaf(1));
    const held = track(broker.read('wc:1', token, t.ticket, 1024));
    await until(() => fs.counts.read === 1, 'read parked');
    let allResolved = false;
    const all = broker.closeAll().then(() => { allResolved = true; });
    await new Promise((r) => setImmediate(r));
    expect(allResolved).toBe(false); // shutdown revocation is instant; the join is not faked
    expect(broker.stats()).toMatchObject({ contexts: 0, disposed: true, activeOps: 1, retiredActiveOps: 1, reservedRawBytes: 6 });
    fs.releaseRead(leaf(1));
    await expect(held).resolves.toMatchObject({ ok: false, error: { code: 'ERR_XREF_CANCELLED' } });
    await all;
    expect(allResolved).toBe(true);
    expect(broker.stats()).toMatchObject({ activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0 });
    expect(fs.openHandles).toBe(0);
  });
});
