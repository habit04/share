/**
 * Independent tiny stale-ticket taxonomy controls. Prepared, not executed here.
 * Uses the provided broker test's held-descriptor/FakeFs pattern; no native I/O.
 * Copy unchanged into admitted source/tests; the lead owns R2/R1 comparison.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

interface ReadResult { text: string; byteLength: number; rawBytes: number; version: string }
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string; identity: { version: string } }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<ReadResult>;
  closeAll(): Promise<void>;
  stats(): { activeOps: number; retiredActiveOps: number; reservedRawBytes: number };
}
const require = createRequire(import.meta.url);
const { createXrefReadBroker } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker(deps: Record<string, unknown>): Broker;
};
const OWNER = 'wc:lead-growth', HOST = 'C:\\lead-growth\\host.dxf', LEAF = 'C:\\lead-growth\\leaf.dxf';
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
);

class TinyFs {
  readonly file = { content: Buffer.from('A'), dev: 7n, ino: 42n, mtimeNs: 1000n, ctimeNs: 2000n };
  counts = { open: 0, stat: 0, fstat: 0, realpath: 0, read: 0, close: 0 };
  openHandles = 0;
  private check(path: string) { if (path !== LEAF) throw Error('Unexpected authored fake path'); }
  private statOf(big = false) {
    const f = this.file;
    return { dev: big ? f.dev : Number(f.dev), ino: big ? f.ino : Number(f.ino),
      size: big ? BigInt(f.content.length) : f.content.length,
      mtimeNs: big ? f.mtimeNs : Number(f.mtimeNs), ctimeNs: big ? f.ctimeNs : Number(f.ctimeNs), isFile: () => true };
  }
  async realpath(path: string) { this.counts.realpath++; this.check(path); return path; }
  async stat(path: string, options?: { bigint?: boolean }) { this.counts.stat++; this.check(path); return this.statOf(options?.bigint); }
  async open(path: string) {
    this.counts.open++; this.check(path); this.openHandles++;
    let position = 0, closed = false;
    return {
      stat: async (options?: { bigint?: boolean }) => { this.counts.fstat++; return this.statOf(options?.bigint); },
      read: async (buffer: Buffer, offset: number, length: number, requestedPosition: number | null) => {
        this.counts.read++;
        const at = requestedPosition === null ? position : requestedPosition;
        const bytesRead = Math.max(0, Math.min(length, this.file.content.length - at));
        this.file.content.copy(buffer, offset, at, at + bytesRead); position = at + bytesRead;
        return { bytesRead, buffer };
      },
      close: async () => { if (closed) throw Error('Authored handle closed twice'); closed = true; this.counts.close++; this.openHandles--; },
    };
  }
  mutate(text: string) { this.file.content = Buffer.from(text); this.file.mtimeNs += 1n; this.file.ctimeNs += 1n; }
  reset() { this.counts = { open: 0, stat: 0, fstat: 0, realpath: 0, read: 0, close: 0 }; }
  calls() { return Object.values(this.counts).reduce((sum, count) => sum + count, 0); }
}

function fixture(initial = 'A') {
  const fs = new TinyFs(); if (initial !== 'A') fs.mutate(initial);
  let serial = 0, decodes = 0;
  const broker = createXrefReadBroker({ fs, isKnownPath: (path: string) => path === LEAF,
    decodeDxf: async (bytes: Buffer) => { decodes++; return { text: bytes.toString('utf8'), encoding: 'utf-8' }; },
    newId: () => `lead-growth-${++serial}` }); // Original ceilings; no test overrides.
  const token = broker.beginContext(OWNER, { docId: 'lead-growth-doc', contentGeneration: 1, hostAnchor: HOST }).token;
  const pending: Promise<unknown>[] = [];
  const read = (ticket: string, allowance: number) => { const outcome = observe(broker.read(OWNER, token, ticket, allowance)); pending.push(outcome); return outcome; };
  const identify = () => broker.identify(OWNER, token, LEAF);
  const idle = () => { expect(fs.openHandles).toBe(0); expect(broker.stats()).toMatchObject({ activeOps: 0, retiredActiveOps: 0, reservedRawBytes: 0 }); };
  async function cleanup() { await broker.closeAll(); await Promise.allSettled(pending); idle(); }
  return { fs, broker, identify, read, idle, cleanup, decodes: () => decodes };
}

describe('lead R2: stale-ticket growth remains a version change, distinct from permanent size limits', () => {
  it('control: an unchanged one-byte ticket reads the original bytes and version', async () => {
    const f = fixture();
    try {
      const ticket = await f.identify(); f.fs.reset();
      await expect(f.read(ticket.ticket, 1024)).resolves.toMatchObject({ ok: true, value: { text: 'A', byteLength: 1, rawBytes: 1, version: ticket.identity.version } });
      expect(f.decodes()).toBe(1); expect(f.fs.counts.open).toBe(1); f.idle();
    } finally { await f.cleanup(); }
  });

  it('stale one-byte ticket grown to two bytes below caller allowance refuses CHANGED', async () => {
    const f = fixture();
    try {
      const ticket = await f.identify();
      f.fs.mutate('AB'); // Same inode, genuinely changed size/mtime/ctime; both sizes fit1024.
      f.fs.reset();
      await expect(f.read(ticket.ticket, 1024)).resolves.toMatchObject({ ok: false, error: { code: 'ERR_XREF_CHANGED' } });
      expect(f.decodes()).toBe(0); expect(f.fs.counts.read).toBe(0); f.idle();
    } finally { await f.cleanup(); }
  });

  it('control: a same-size in-place version change still refuses CHANGED', async () => {
    const f = fixture();
    try {
      const ticket = await f.identify(); f.fs.mutate('B'); f.fs.reset();
      await expect(f.read(ticket.ticket, 1024)).resolves.toMatchObject({ ok: false, error: { code: 'ERR_XREF_CHANGED' } });
      expect(f.decodes()).toBe(0); expect(f.fs.counts.read).toBe(0); f.idle();
    } finally { await f.cleanup(); }
  });

  it('control: an identified two-byte file above caller allowance1 is LIMIT before I/O/reservation', async () => {
    const f = fixture('AB');
    try {
      const ticket = await f.identify(); f.fs.reset();
      const outcome = f.read(ticket.ticket, 1), immediate = f.broker.stats();
      await expect(outcome).resolves.toMatchObject({ ok: false, error: { code: 'ERR_XREF_LIMIT' } });
      expect(immediate).toMatchObject({ activeOps: 0, reservedRawBytes: 0 });
      expect(f.fs.calls()).toBe(0); expect(f.decodes()).toBe(0); f.idle();
    } finally { await f.cleanup(); }
  });
});
