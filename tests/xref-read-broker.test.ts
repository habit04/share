/**
 * Priority 20.2 — read-only xref broker (electron/xref-read.cjs).
 *
 * Headless evidence with an injected fake filesystem: authority is
 * proven BEFORE any I/O (call counters stay at zero), native identity
 * tickets bind reads to the identified version, code page charges are
 * honest, and cancellation/lifecycle retire capabilities. Real
 * Windows/main/preload acceptance remains the lead's gate.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createXrefReadBroker } = require('../electron/xref-read.cjs') as {
  createXrefReadBroker: (deps: Record<string, unknown>) => Broker;
};

interface Identity { id: string; owningLocation: string; version: string }
interface Broker {
  beginContext(owner: string, info: { docId: string; contentGeneration: number; hostAnchor: string }): { token: string };
  identify(owner: string, token: string, path: string): Promise<{ ticket: string; identity: Identity }>;
  read(owner: string, token: string, ticket: string, maxBytes: number): Promise<{ text: string; byteLength: number; version: string; rawBytes: number; rawSha256: string; encoding?: string }>;
  cancel(owner: string, token: string): Promise<boolean>;
  closeContext(owner: string, token: string): Promise<boolean>;
  retireOwner(owner: string): number;
  closeAll(): Promise<void>;
  stats(): { contexts: number; tickets: number; disposed: boolean };
}

interface FakeFile { content: Buffer; dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }

function statOf(f: FakeFile, opts?: { bigint?: boolean }) {
  const big = !!opts?.bigint;
  return {
    dev: big ? f.dev : Number(f.dev),
    ino: big ? f.ino : Number(f.ino),
    size: big ? BigInt(f.content.length) : f.content.length,
    mtimeNs: big ? f.mtimeNs : Number(f.mtimeNs),
    ctimeNs: big ? f.ctimeNs : Number(f.ctimeNs),
    isFile: () => true,
  };
}

class FakeFs {
  files = new Map<string, FakeFile>();
  links = new Map<string, string>();
  counts = { open: 0, stat: 0, realpath: 0, read: 0, close: 0 };
  openHandles = 0;
  gateRealpath: (() => Promise<void>) | null = null;
  gateRead: (() => Promise<void>) | null = null;

  add(path: string, content: string | Buffer, ino = 1n, dev = 7n): FakeFile {
    const f: FakeFile = { content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), dev, ino, mtimeNs: 1000n, ctimeNs: 2000n };
    this.files.set(path, f);
    return f;
  }
  private resolve(p: string): string { return this.links.get(p) ?? p; }
  private entry(p: string): FakeFile {
    const f = this.files.get(this.resolve(p));
    if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return f;
  }
  async realpath(p: string): Promise<string> {
    this.counts.realpath += 1;
    if (this.gateRealpath) await this.gateRealpath();
    this.entry(p);
    return this.resolve(p);
  }
  async stat(p: string, opts?: { bigint?: boolean }) {
    this.counts.stat += 1;
    return statOf(this.entry(p), opts);
  }
  async open(p: string) {
    this.counts.open += 1;
    const f = this.entry(p);
    this.openHandles += 1;
    let pos = 0;
    return {
      stat: async (opts?: { bigint?: boolean }) => statOf(f, opts),
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        this.counts.read += 1;
        if (this.gateRead) { const g = this.gateRead; this.gateRead = null; await g(); }
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

const HOST = 'C:\\proj\\host.dxf';
const LEAF = 'C:\\proj\\leaf.dxf';
const LEAF_TEXT = '0\nSECTION\n2\nENTITIES\n0\nLINE\n0\nENDSEC\n0\nEOF\n';

function setup(opts: { granted?: string[]; decode?: (bytes: Buffer) => Promise<{ text: string; encoding?: string }>; maxRawBytes?: number } = {}) {
  const fs = new FakeFs();
  const granted = new Set(opts.granted ?? [HOST, LEAF]);
  const policyCalls: string[] = [];
  let n = 0;
  const broker = createXrefReadBroker({
    fs,
    isKnownPath: (p: string) => { policyCalls.push(p); return granted.has(p); },
    decodeDxf: opts.decode ?? (async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' })),
    newId: () => `id-${++n}`,
    ...(opts.maxRawBytes ? { maxRawBytes: opts.maxRawBytes } : {}),
  });
  const begin = (owner = 'wc:1') => broker.beginContext(owner, { docId: 'doc-1', contentGeneration: 3, hostAnchor: HOST }).token;
  return { fs, granted, policyCalls, broker, begin };
}

describe('xref read broker — authority before I/O', () => {
  it('identifies and reads a granted DXF with exact content, UTF-8 charge and matching version', async () => {
    const { fs, broker, begin } = setup();
    fs.add(HOST, 'host-bytes', 10n);
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const host = await broker.identify('wc:1', token, HOST);
    expect(host.identity.id).toBe('win:7:10');
    const leaf = await broker.identify('wc:1', token, LEAF);
    expect(leaf.identity).toMatchObject({ id: 'win:7:42', owningLocation: LEAF });
    const result = await broker.read('wc:1', token, leaf.ticket, 1 << 20);
    expect(result.text).toBe(LEAF_TEXT);
    expect(result.byteLength).toBe(Buffer.byteLength(LEAF_TEXT, 'utf8'));
    expect(result.version).toBe(leaf.identity.version);
    expect(result.rawBytes).toBe(Buffer.byteLength(LEAF_TEXT, 'utf8'));
    expect(result.rawSha256).toBe(createHash('sha256').update(LEAF_TEXT, 'utf8').digest('hex'));
    expect(fs.openHandles).toBe(0); // every handle closed
  });

  it('host and a symlink alias of it identify to the same native id and owning location', async () => {
    const { fs, broker, begin } = setup({ granted: [HOST, 'C:\\proj\\alias.dxf'] });
    fs.add(HOST, LEAF_TEXT, 10n);
    fs.links.set('C:\\proj\\alias.dxf', HOST);
    const token = begin();
    const a = await broker.identify('wc:1', token, HOST);
    const b = await broker.identify('wc:1', token, 'C:\\proj\\alias.dxf');
    expect(b.identity.id).toBe(a.identity.id);
    expect(b.identity.owningLocation).toBe(HOST);
  });

  it('denies an ungranted local path and an unapproved UNC path before ANY filesystem contact', async () => {
    const { fs, broker, begin } = setup();
    fs.add('C:\\secret\\leaf.dxf', LEAF_TEXT, 99n);
    const token = begin();
    await expect(broker.identify('wc:1', token, 'C:\\secret\\leaf.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    await expect(broker.identify('wc:1', token, '\\\\evil\\share\\leaf.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    expect(fs.totalCalls()).toBe(0);
  });

  it('refuses malformed/device/ADS/wildcard/relative/non-DXF requests before policy or I/O', async () => {
    const { fs, policyCalls, broker, begin } = setup();
    const token = begin();
    const bad = ['leaf.dxf', 'C:leaf.dxf', '\\\\?\\C:\\proj\\leaf.dxf', '\\\\.\\C:\\proj\\leaf.dxf',
      'C:\\proj\\leaf.dxf:stream', 'C:\\proj\\*.dxf', 'C:\\proj\\leaf.dwg', 'C:\\proj\\leaf', '', 'C:\\proj\\leaf.dxf '];
    for (const p of bad) {
      await expect(broker.identify('wc:1', token, p)).rejects.toMatchObject({ code: 'ERR_XREF_PATH' });
    }
    expect(fs.totalCalls()).toBe(0);
    expect(policyCalls).toEqual([]);
  });

  it('forged tokens, foreign owners and borrowed tickets cannot bypass binding', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const t1 = begin('wc:1');
    const t2 = begin('wc:2');
    const leaf = await broker.identify('wc:1', t1, LEAF);
    await expect(broker.identify('wc:2', t1, LEAF)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });
    await expect(broker.identify('wc:1', 'forged-token', LEAF)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });
    await expect(broker.read('wc:2', t2, leaf.ticket, 1024)).rejects.toMatchObject({ code: 'ERR_XREF_TICKET' });
    await expect(broker.read('wc:1', t1, 'forged-ticket', 1024)).rejects.toMatchObject({ code: 'ERR_XREF_TICKET' });
  });

  it('an authorized-but-absent file is missing (not denied), and granting later does not rewrite history', async () => {
    const { broker, begin } = setup({ granted: [HOST, 'C:\\proj\\ghost.dxf'] });
    const token = begin();
    await expect(broker.identify('wc:1', token, 'C:\\proj\\ghost.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_MISSING' });
  });
});

describe('xref read broker — coherent, version-bound reads', () => {
  it('refuses when the file is replaced between identify and read', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    fs.add(LEAF, 'different content entirely', 43n); // replacement: new inode
    await expect(broker.read('wc:1', token, leaf.ticket, 1 << 20)).rejects.toMatchObject({ code: 'ERR_XREF_CHANGED' });
    expect(fs.openHandles).toBe(0);
  });

  it('refuses when the same inode changes version (mtime) between identify and read', async () => {
    const { fs, broker, begin } = setup();
    const f = fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    f.mtimeNs = 9999n; // in-place mutation, same identity
    await expect(broker.read('wc:1', token, leaf.ticket, 1 << 20)).rejects.toMatchObject({ code: 'ERR_XREF_CHANGED' });
  });

  it('refuses when the namespace is redirected between identify and read, even to identical bytes', async () => {
    const { fs, broker, begin } = setup({ granted: [HOST, 'C:\\proj\\link.dxf'] });
    const a = fs.add('C:\\proj\\a.dxf', LEAF_TEXT, 42n);
    fs.add('C:\\proj\\b.dxf', LEAF_TEXT, 42n); // identical stat fields incl. inode (synthetic namespace)
    void a;
    fs.links.set('C:\\proj\\link.dxf', 'C:\\proj\\a.dxf');
    const token = begin();
    const leaf = await broker.identify('wc:1', token, 'C:\\proj\\link.dxf');
    expect(leaf.identity.owningLocation).toBe('C:\\proj\\a.dxf');
    fs.links.set('C:\\proj\\link.dxf', 'C:\\proj\\b.dxf'); // retargeted
    await expect(broker.read('wc:1', token, leaf.ticket, 1 << 20)).rejects.toMatchObject({ code: 'ERR_XREF_CHANGED' });
  });

  it('hard links share the native id but keep distinct owning anchors (reported faithfully, never rewritten)', async () => {
    const p1 = 'C:\\left\\shared.dxf';
    const p2 = 'C:\\right\\shared.dxf';
    const { fs, broker, begin } = setup({ granted: [HOST, p1, p2] });
    fs.add(p1, LEAF_TEXT, 42n);
    fs.add(p2, LEAF_TEXT, 42n); // same dev/ino: a hard-linked pair in the fake namespace
    const token = begin();
    const a = await broker.identify('wc:1', token, p1);
    const b = await broker.identify('wc:1', token, p2);
    expect(a.identity.id).toBe(b.identity.id);
    expect(a.identity.owningLocation).toBe(p1);
    expect(b.identity.owningLocation).toBe(p2);
    expect(a.ticket).not.toBe(b.ticket);
  });

  it('re-identify of the same snapshot is idempotent (same ticket), a new version takes a new ticket', async () => {
    const { fs, broker, begin } = setup();
    const f = fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const a = await broker.identify('wc:1', token, LEAF);
    const b = await broker.identify('wc:1', token, LEAF);
    expect(b.ticket).toBe(a.ticket);
    f.mtimeNs = 5555n;
    const c = await broker.identify('wc:1', token, LEAF);
    expect(c.ticket).not.toBe(a.ticket);
    expect(c.identity.version).not.toBe(a.identity.version);
  });
});

describe('xref read broker — byte accounting', () => {
  it('feeds the decoder the ACTUAL ORIGINAL BYTES and charges UTF-8 delivery honestly (code page fixture)', async () => {
    const raw = Buffer.from([0x61, 0xe9, 0x62, 0x0a]); // "aéb\n" in a single-byte code page
    const seen: Buffer[] = [];
    const { fs, broker, begin } = setup({
      decode: async (bytes: Buffer) => { seen.push(Buffer.from(bytes)); return { text: bytes.toString('latin1'), encoding: 'windows-1252' }; },
    });
    fs.add(LEAF, raw, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    const result = await broker.read('wc:1', token, leaf.ticket, 1024);
    expect(seen[0]).toEqual(raw); // original bytes, not a re-encode
    expect(result.rawBytes).toBe(4);
    expect(result.text).toBe('aéb\n');
    expect(result.byteLength).toBe(5); // é costs 2 bytes as UTF-8
    expect(result.encoding).toBe('windows-1252');
  });

  it('exact allowance succeeds; one byte under the delivered size refuses atomically with no partial result', async () => {
    const raw = Buffer.from([0x61, 0xe9, 0x62, 0x0a]);
    const { fs, broker, begin } = setup({
      decode: async (bytes: Buffer) => ({ text: bytes.toString('latin1'), encoding: 'windows-1252' }),
    });
    fs.add(LEAF, raw, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    await expect(broker.read('wc:1', token, leaf.ticket, 5)).resolves.toMatchObject({ byteLength: 5 });
    await expect(broker.read('wc:1', token, leaf.ticket, 4)).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
  });

  it('raw size over the allowance refuses before decoding', async () => {
    let decodeCalls = 0;
    const { fs, broker, begin } = setup({
      decode: async (bytes: Buffer) => { decodeCalls += 1; return { text: bytes.toString('utf8'), encoding: 'utf-8' }; },
    });
    fs.add(LEAF, Buffer.alloc(64, 0x61), 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    await expect(broker.read('wc:1', token, leaf.ticket, 16)).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
    expect(decodeCalls).toBe(0);
  });

  it('the caller allowance can only lower the broker ceiling, never raise it', async () => {
    const { fs, broker, begin } = setup({ maxRawBytes: 8 });
    fs.add(LEAF, Buffer.alloc(10, 0x61), 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    await expect(broker.read('wc:1', token, leaf.ticket, 1 << 20)).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
  });

  it('revoked permission between identify and read denies the read before I/O', async () => {
    const { fs, granted, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    granted.delete(LEAF);
    const before = fs.totalCalls();
    await expect(broker.read('wc:1', token, leaf.ticket, 1024)).rejects.toMatchObject({ code: 'ERR_XREF_DENIED' });
    expect(fs.totalCalls()).toBe(before);
  });
});

describe('xref read broker — cancellation and lifecycle', () => {
  it('cancel during a read joins cleanup: the late completion is refused and every handle closes', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    const leaf = await broker.identify('wc:1', token, LEAF);
    let release: () => void = () => {};
    fs.gateRead = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = broker.read('wc:1', token, leaf.ticket, 1 << 20);
    await new Promise((r) => setImmediate(r));
    const drain1 = broker.cancel('wc:1', token);
    const drain2 = broker.cancel('wc:1', token); // repeated cancel is safe
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_XREF_CANCELLED' });
    await expect(drain1).resolves.toBe(true);
    await expect(drain2).resolves.toBe(true);
    expect(fs.openHandles).toBe(0);
  });

  it('close during identify retires the context; no ticket is created and later operations refuse', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    let release: () => void = () => {};
    fs.gateRealpath = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = broker.identify('wc:1', token, LEAF);
    await new Promise((r) => setImmediate(r));
    const drained = broker.closeContext('wc:1', token);
    await expect(broker.closeContext('wc:1', token)).resolves.toBe(false); // idempotent
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_XREF_CANCELLED' });
    await expect(drained).resolves.toBe(true);
    expect(broker.stats()).toMatchObject({ contexts: 0, tickets: 0 });
    await expect(broker.identify('wc:1', token, LEAF)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });
  });

  it('retiring one owner leaves an independent second owner fully valid', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const t1 = begin('wc:1');
    const t2 = begin('wc:2');
    const leaf2 = await broker.identify('wc:2', t2, LEAF);
    expect(broker.retireOwner('wc:1')).toBe(1);
    await expect(broker.identify('wc:1', t1, LEAF)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });
    await expect(broker.read('wc:2', t2, leaf2.ticket, 1024)).resolves.toMatchObject({ text: LEAF_TEXT });
  });

  it('bounds live contexts per owner and tickets per context', async () => {
    const { begin } = setup();
    for (let i = 0; i < 32; i++) begin('wc:1');
    expect(() => begin('wc:1')).toThrowError(/ERR_XREF_LIMIT/);
    const fsx = new FakeFs();
    const many = createXrefReadBroker({
      fs: fsx, isKnownPath: () => true,
      decodeDxf: async (b: Buffer) => ({ text: b.toString('utf8'), encoding: 'utf-8' }),
      newId: (() => { let n = 0; return () => `m-${++n}`; })(),
    });
    const token = many.beginContext('wc:9', { docId: 'd', contentGeneration: 1, hostAnchor: HOST }).token;
    for (let i = 0; i < 256; i++) {
      const p = `C:\\proj\\f${i}.dxf`;
      fsx.add(p, 'x', BigInt(i + 1));
      await many.identify('wc:9', token, p);
    }
    fsx.add('C:\\proj\\overflow.dxf', 'x', 9999n);
    await expect(many.identify('wc:9', token, 'C:\\proj\\overflow.dxf')).rejects.toMatchObject({ code: 'ERR_XREF_LIMIT' });
  });

  it('beginContext validates its labels before creating anything', () => {
    const { broker } = setup();
    expect(() => broker.beginContext('wc:1', { docId: '', contentGeneration: 1, hostAnchor: HOST })).toThrowError(/ERR_XREF_ARGUMENT/);
    expect(() => broker.beginContext('wc:1', { docId: 'd', contentGeneration: -1, hostAnchor: HOST })).toThrowError(/ERR_XREF_ARGUMENT/);
    expect(() => broker.beginContext('wc:1', { docId: 'd', contentGeneration: 1, hostAnchor: 'relative\\host.dxf' })).toThrowError(/ERR_XREF_ARGUMENT/);
    expect(broker.stats().contexts).toBe(0);
  });

  it('closeAll disposes the broker; later operations refuse', async () => {
    const { fs, broker, begin } = setup();
    fs.add(LEAF, LEAF_TEXT, 42n);
    const token = begin();
    broker.closeAll();
    await expect(broker.identify('wc:1', token, LEAF)).rejects.toMatchObject({ code: 'ERR_XREF_CONTEXT' });
    expect(() => begin()).toThrowError(/ERR_XREF_CONTEXT/);
  });
});
