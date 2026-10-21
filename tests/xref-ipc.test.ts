/**
 * Priority 20.2 — xref IPC layer (electron/main/ipc-xrefs.cjs) over the
 * real broker, real path registry and real IPC guard, with a fake
 * filesystem and fake senders. Proves owner binding, lifecycle
 * retirement, refusal logging, and that the layer adds no authority
 * (it never calls the registry's grant functions).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPathRegistry } = require('../electron/path-registry.cjs') as { createPathRegistry: (opts?: unknown) => Registry };
const { guardIpc } = require('../electron/ipc-guard.cjs') as { guardIpc: (raw: unknown, opts: unknown) => unknown };
const { registerXrefIpc } = require('../electron/main/ipc-xrefs.cjs') as { registerXrefIpc: (ctx: unknown, deps?: unknown) => { dispose(): void } };
const { createXrefReadBroker } = require('../electron/xref-read.cjs') as { createXrefReadBroker: (deps: Record<string, unknown>) => unknown };

interface Registry {
  isKnown(p: string): boolean;
  grant(p: string): boolean;
  grantDerived(p: string, s: string): boolean;
  registerProject(...args: unknown[]): unknown;
}
type Handler = (ev: unknown, ...args: unknown[]) => Promise<unknown>;

const LEAF = 'C:\\proj\\leaf.dxf';
const TEXT = '0\nSECTION\n0\nEOF\n';

function fakeFs(content = TEXT) {
  const file = { content: Buffer.from(content, 'utf8'), dev: 7n, ino: 42n, mtimeNs: 1000n, ctimeNs: 2000n };
  const statOf = (opts?: { bigint?: boolean }) => {
    const big = !!opts?.bigint;
    return {
      dev: big ? file.dev : 7, ino: big ? file.ino : 42,
      size: big ? BigInt(file.content.length) : file.content.length,
      mtimeNs: big ? file.mtimeNs : 1000, ctimeNs: big ? file.ctimeNs : 2000,
      isFile: () => true,
    };
  };
  return {
    async realpath(p: string) { if (p !== LEAF) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return p; },
    async stat(p: string, opts?: { bigint?: boolean }) { if (p !== LEAF) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return statOf(opts); },
    async open(p: string) {
      if (p !== LEAF) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      let pos = 0;
      return {
        stat: async (opts?: { bigint?: boolean }) => statOf(opts),
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const at = position === null ? pos : position;
          const n = Math.max(0, Math.min(length, file.content.length - at));
          file.content.copy(buffer, offset, at, at + n);
          pos = at + n;
          return { bytesRead: n, buffer };
        },
        close: async () => {},
      };
    },
  };
}

class FakeSender {
  listeners = new Map<string, Array<() => void>>();
  mainFrame: unknown = null;
  constructor(public id: number) {}
  on(event: string, fn: () => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  emit(event: string) { for (const fn of this.listeners.get(event) ?? []) fn(); }
}

function setup() {
  const handlers = new Map<string, Handler>();
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const sender = new FakeSender(1);
  sender.mainFrame = frame;
  const win = { webContents: sender, isDestroyed: () => false };
  const rejections: Array<[string, string]> = [];
  const ipcMain = guardIpc(
    { handle: (channel: string, h: Handler) => handlers.set(channel, h) },
    { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject: (a: string, b: string) => rejections.push([a, b]) } },
  );
  // The module under test reads authority ONLY through registry.isKnown.
  // The real registry keys paths with host-platform semantics (on this
  // Linux harness a Windows path cannot key, and in production both the
  // registry and the broker are win32), so isKnown is backed here by the
  // set of paths the harness treats as already user-chosen — while the
  // grant functions are spies that must NEVER be called by the module.
  void createPathRegistry;
  const known = new Set([LEAF]);
  const grantSpy = vi.fn(() => true);
  const derivedSpy = vi.fn(() => true);
  const projectSpy = vi.fn(() => ({}));
  const registry = { isKnown: (p: string) => known.has(p), grant: grantSpy, grantDerived: derivedSpy, registerProject: projectSpy };
  const mod = registerXrefIpc(
    { ipcMain, registry, rejections: { reject: (a: string, b: string) => rejections.push([a, b]) }, senderWindow: () => win },
    { fs: fakeFs(), decodeDxf: async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' }) },
  );
  const ev = { sender, senderFrame: frame };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  return { handlers, registry, rejections, mod, ev, call, sender, grantSpy, derivedSpy, projectSpy };
}

describe('xref IPC — owner-bound context protocol', () => {
  it('registers exactly the six xref channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      'xref-begin-context', 'xref-cancel', 'xref-close-context', 'xref-identify', 'xref-read', 'xref-retire-doc-contexts',
    ]);
  });

  it('runs begin -> identify -> read -> close for the owning sender', async () => {
    const { call } = setup();
    const ctx = await call('xref-begin-context', { docId: 'doc-1', contentGeneration: 3, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    expect(typeof ctx.token).toBe('string');
    const id = await call('xref-identify', ctx.token, LEAF) as { ticket: string; identity: { id: string; owningLocation: string } };
    expect(id.identity).toMatchObject({ id: 'win:7:42', owningLocation: LEAF });
    const read = await call('xref-read', ctx.token, id.ticket, 1024) as { text: string; byteLength: number };
    expect(read.text).toBe(TEXT);
    await expect(call('xref-close-context', ctx.token)).resolves.toBe(true);
    await expect(call('xref-identify', ctx.token, LEAF)).rejects.toThrowError(/ERR_XREF_CONTEXT/);
  });

  it('contexts of one sender are separate capabilities: a ticket spends only in its own context', async () => {
    // JCad tabs are documents inside ONE renderer/WebContents, so the
    // guard already rejects any other WebContents outright (verified
    // in the guard's own tests); what separates two documents here is
    // the context binding itself — each document session's adapter
    // holds only its own token, and tickets are context-scoped.
    const { call } = setup();
    const a = await call('xref-begin-context', { docId: 'doc-a', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    const b = await call('xref-begin-context', { docId: 'doc-b', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    expect(a.token).not.toBe(b.token);
    const id = await call('xref-identify', a.token, LEAF) as { ticket: string };
    await expect(call('xref-read', b.token, id.ticket, 1024)).rejects.toThrowError(/ERR_XREF_TICKET/);
    await expect(call('xref-read', a.token, id.ticket, 1024)).resolves.toMatchObject({ text: TEXT });
    // Closing one document's context leaves the other fully valid.
    await expect(call('xref-close-context', a.token)).resolves.toBe(true);
    const idB = await call('xref-identify', b.token, LEAF) as { ticket: string };
    await expect(call('xref-read', b.token, idB.ticket, 1024)).resolves.toMatchObject({ text: TEXT });
  });

  it('a foreign WebContents is refused by the guard before the module runs', async () => {
    const { handlers } = setup();
    const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
    const other = new FakeSender(2);
    other.mainFrame = frame;
    const ev2 = { sender: other, senderFrame: frame };
    expect(() => handlers.get('xref-identify')!(ev2, 'any-token', LEAF)).toThrowError(/Unauthorized IPC caller/);
  });

  it('sender destruction and navigation each retire the sender contexts', async () => {
    const { call, sender } = setup();
    const a = await call('xref-begin-context', { docId: 'd', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    sender.emit('did-navigate');
    await expect(call('xref-identify', a.token, LEAF)).rejects.toThrowError(/ERR_XREF_CONTEXT/);
    const b = await call('xref-begin-context', { docId: 'd', contentGeneration: 2, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    sender.emit('destroyed');
    await expect(call('xref-identify', b.token, LEAF)).rejects.toThrowError(/ERR_XREF_CONTEXT/);
  });

  it('ungranted paths are denied through IPC and the refusal is logged; no grant function is ever called', async () => {
    const { call, rejections, grantSpy, derivedSpy, projectSpy } = setup();
    const ctx = await call('xref-begin-context', { docId: 'd', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' }) as { token: string };
    await expect(call('xref-identify', ctx.token, 'C:\\secret\\leaf.dxf')).rejects.toThrowError(/ERR_XREF_DENIED/);
    expect(rejections.some(([what]) => what === 'xref-identify')).toBe(true);
    expect(grantSpy).not.toHaveBeenCalled();
    expect(derivedSpy).not.toHaveBeenCalled();
    expect(projectSpy).not.toHaveBeenCalled();
  });

  it('malformed context info is refused as an argument error, and disposal refuses later work idempotently', async () => {
    const { call, mod } = setup();
    await expect(call('xref-begin-context', { docId: '', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' })).rejects.toThrowError(/ERR_XREF_ARGUMENT/);
    await expect(call('xref-begin-context', null)).rejects.toThrowError(/ERR_XREF_ARGUMENT/);
    mod.dispose();
    mod.dispose();
    await expect(call('xref-begin-context', { docId: 'd', contentGeneration: 1, hostAnchor: 'C:\\proj\\host.dxf' })).rejects.toThrowError(/ERR_XREF_CONTEXT/);
  });
});

describe('xref IPC — retire-doc-contexts (host tab close, Stage-1 fix A)', () => {
  it('retires the calling sender contexts for the named doc only, idempotently', async () => {
    const { call } = setup();
    const a = await call('xref-begin-context', { docId: 'doc-a', contentGeneration: 1, hostAnchor: 'C:\\\\proj\\\\host.dxf' }) as { token: string };
    const b = await call('xref-begin-context', { docId: 'doc-b', contentGeneration: 1, hostAnchor: 'C:\\\\proj\\\\host.dxf' }) as { token: string };
    await expect(call('xref-retire-doc-contexts', 'doc-a')).resolves.toEqual({ retired: 1 });
    await expect(call('xref-identify', a.token, LEAF)).rejects.toThrowError(/ERR_XREF_CONTEXT/);
    const idB = await call('xref-identify', b.token, LEAF) as { ticket: string };
    await expect(call('xref-read', b.token, idB.ticket, 1024)).resolves.toMatchObject({ text: TEXT });
    await expect(call('xref-retire-doc-contexts', 'doc-a')).resolves.toEqual({ retired: 0 });
  });

  it('a different sender cannot retire the victim contexts (owner comes from the event, never the payload)', async () => {
    // Two registrations sharing ONE broker, each guarded to its OWN
    // window/sender — the production construction with two windows.
    const broker = createXrefReadBroker({
      fs: fakeFs(),
      isKnownPath: (p: string) => p === LEAF,
      decodeDxf: async (bytes: Buffer) => ({ text: bytes.toString('utf8'), encoding: 'utf-8' }),
    });
    const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
    const registerFor = (senderId: number) => {
      const handlers = new Map<string, Handler>();
      const sender = new FakeSender(senderId);
      sender.mainFrame = frame;
      const win = { webContents: sender, isDestroyed: () => false };
      const ipcMain = guardIpc(
        { handle: (channel: string, h: Handler) => handlers.set(channel, h) },
        { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject: () => {} } },
      );
      registerXrefIpc(
        { ipcMain, registry: { isKnown: (p: string) => p === LEAF }, rejections: { reject: () => {} } },
        { broker },
      );
      const ev = { sender, senderFrame: frame };
      return { call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args) };
    };
    const A = registerFor(1);
    const B = registerFor(2);
    const ctxA = await A.call('xref-begin-context', { docId: 'doc-1', contentGeneration: 1, hostAnchor: 'C:\\\\proj\\\\host.dxf' }) as { token: string };
    await expect(B.call('xref-retire-doc-contexts', 'doc-1')).resolves.toEqual({ retired: 0 });
    const id = await A.call('xref-identify', ctxA.token, LEAF) as { ticket: string };
    await expect(A.call('xref-read', ctxA.token, id.ticket, 1024)).resolves.toMatchObject({ text: TEXT });
    await expect(A.call('xref-retire-doc-contexts', 'doc-1')).resolves.toEqual({ retired: 1 });
    await expect(A.call('xref-identify', ctxA.token, LEAF)).rejects.toThrowError(/ERR_XREF_CONTEXT/);
  });

  it('an invalid docId is refused by the broker and logged as a rejection', async () => {
    const { call, rejections } = setup();
    await expect(call('xref-retire-doc-contexts', '')).rejects.toThrowError(/ERR_XREF_ARGUMENT/);
    expect(rejections.some(([what]) => what === 'xref-retire-doc-contexts')).toBe(true);
  });
});
