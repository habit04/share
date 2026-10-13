import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const native = require('node:fs/promises') as typeof fs;
const { createWindowsPathIdentity, coherentFileDigest, MAX_CONTENT_BYTES, MAX_PDF_CONTENT_BYTES, HASH_CHUNK_BYTES } = require('../electron/windows-path-identity.cjs');
const { createSaveAdmissions, SAVE_ADMISSION_LIMITS } = require('../electron/save-admissions.cjs');
const { registerSaveOrder } = require('../electron/main/save-order.cjs');
const { createAtomicWriter } = require('../electron/atomic-write.cjs');
const { createPathRegistry } = require('../electron/path-registry.cjs');
const { guardIpc } = require('../electron/ipc-guard.cjs');
type Kind = 'drawing' | 'project' | 'export-copy' | 'text-export' | 'pdf-export';
type WriterContext = { logicalPath: string; destinationPath: string; canonicalPath: string; root?: string; signal: AbortSignal; guard(): Promise<void>; markCommitted(): Promise<void> };
type Scope = { signal: AbortSignal; commit(data: string | Uint8Array, writer: (data: string | Uint8Array, context: WriterContext) => Promise<unknown>): Promise<unknown> };
type Handler = (ev: unknown, ...args: unknown[]) => unknown;
const privateRoot = path.resolve('.codex-local/windows-export-admission-tests');
const hosts: any[] = [], windows: EventEmitter[] = [], releases: Array<() => void> = [], tasks: Promise<unknown>[] = [];
let dir: string;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(() => resolve()); return { promise, resolve }; }
function track<T>(promise: Promise<T>) { tasks.push(promise); void promise.catch(() => {}); return promise; }
beforeEach(async () => { await fs.mkdir(privateRoot, { recursive: true }); dir = await fs.mkdtemp(path.join(privateRoot, 'case-')); });
afterEach(async () => {
  vi.restoreAllMocks(); for (const release of releases.splice(0)) release();
  for (const win of windows.splice(0)) win.emit('closed');
  await Promise.allSettled(tasks.splice(0)); await Promise.all(hosts.splice(0).map(host => host.dispose()));
  if (path.dirname(dir) !== privateRoot || !path.basename(dir).startsWith('case-')) throw new Error('Unsafe private export test cleanup');
  await fs.rm(dir, { recursive: true, force: true });
});
function manager(options: Record<string, unknown> = {}) {
  const owner = {}, identity = createWindowsPathIdentity();
  const host = createSaveAdmissions({ identity, authorize: () => ({ allowed: true, root: dir }), ...options }); hosts.push(host);
  const bind = async (file: string, kind: Kind) => { const ticket = host.issue(owner, kind) as string; await host.bind(ticket, owner, kind, file); return ticket; };
  return { owner, identity, host, bind };
}
async function atomic(data: string | Uint8Array, context: WriterContext) {
  const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: () => context.guard() } });
  await writer.atomicWriteFile(context.destinationPath, data, { backup: false, root: context.root });
  await context.markCommitted(); return { path: context.logicalPath, identityPath: context.canonicalPath };
}
function facade() {
  const registry = createPathRegistry(), handlers = new Map<string, Handler>(), frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents }); windows.push(win);
  const ev = { sender: contents, senderFrame: frame };
  const ipcMain = guardIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject: vi.fn() } });
  const authorize = vi.fn((_owner: object, _kind: string, file: string) => registry.isWritable(file) ? { allowed: true, root: dir } : { allowed: false });
  const order = registerSaveOrder({ ipcMain, senderWindow: () => win }, authorize);
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  const proof = async (file: string) => {
    registry.grant(file); const capture = order.captureRead(ev), reservation = order.reserveRead(ev, capture, file);
    const evidence = await coherentFileDigest(file);
    return order.completeRead(ev, capture, reservation, { canonicalPath: evidence.canonicalPath, fileVersion: { ...evidence.version, sha256: evidence.sha256 } });
  };
  return { registry, contents, win, ev, order, invoke, authorize, proof };
}

describe.runIf(process.platform === 'win32')('Windows generic export owner/order and immutable file evidence', () => {
  it('keeps ordinary limits while adding separately bounded PDF and shared arenas', () => {
    expect(SAVE_ADMISSION_LIMITS).toMatchObject({ payload: 128 * 1024 * 1024, queuedBytes: 256 * 1024 * 1024, pdfPayload: 512 * 1024 * 1024, pdfQueuedBytes: 512 * 1024 * 1024, sharedQueuedBytes: 768 * 1024 * 1024 });
    for (const [field, value] of [['maxPdfPayloadBytes', MAX_PDF_CONTENT_BYTES + 1], ['maxPdfQueuedBytes', MAX_PDF_CONTENT_BYTES + 1], ['maxSharedQueuedBytes', 768 * 1024 * 1024 + 1], ['maxPdfPayloadBytes', 0], ['maxSharedQueuedBytes', 1.5]]) expect(() => manager({ [field!]: value })).toThrow(/bounded positive integers/);
  });
  it('validates issued and bound state, owner, kind and exact chosen path without filesystem access', async () => {
    const f = manager(), file = path.join(dir, 'export.csv'), other = path.join(dir, 'other.csv');
    const ticket = f.host.issue(f.owner, 'text-export'); expect(f.host.assertIssued(ticket, f.owner, 'text-export')).toBe(true);
    expect(() => f.host.assertIssued(ticket, {}, 'text-export')).toThrow(); expect(() => f.host.assertIssued(ticket, f.owner, 'pdf-export')).toThrow();
    expect(() => f.host.assertBound(ticket, f.owner, 'text-export', file)).toThrow();
    await f.host.bind(ticket, f.owner, 'text-export', file); expect(f.host.assertBound(ticket, f.owner, 'text-export', file).logicalPath).toBe(file);
    expect(() => f.host.assertIssued(ticket, f.owner, 'text-export')).toThrow(); expect(() => f.host.assertBound(ticket, f.owner, 'text-export', other)).toThrow();
    f.host.cancel(ticket, f.owner, 'text-export'); expect(() => f.host.assertIssued(ticket, f.owner, 'text-export')).toThrow();
  });
  it.each([['pdf-export', 'text-export'], ['text-export', 'pdf-export'], ['pdf-export', 'drawing'], ['project', 'text-export']] as const)('does not let older %s producers overwrite newer %s on a shared native target', async (oldKind, newKind) => {
    const f = manager(), file = path.join(dir, 'shared-output.bin'), gate = deferred(), started = deferred();
    const old = await f.bind(file, oldKind), newer = await f.bind(file, newKind);
    const first = track(f.host.run(old, f.owner, oldKind, file, async (scope: Scope) => { started.resolve(); await gate.promise; return scope.commit('OLDER', atomic); }));
    await started.promise;
    expect(await f.host.run(newer, f.owner, newKind, file, (scope: Scope) => scope.commit('NEWER', atomic))).toMatchObject({ status: 'saved' });
    gate.resolve(); expect(await first).toMatchObject({ status: 'stale', committed: false });
    expect(await fs.readFile(file, 'utf8')).toBe('NEWER'); expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0, queues: 0 });
  });
  it('preserves native Greek case aliases while keeping distinct dotted-I names independent', async () => {
    const f = manager(), stored = path.join(dir, 'Σ.pdf'), alias = path.join(dir, 'σ.pdf'); await fs.writeFile(stored, 'ORIGINAL');
    const old = await f.bind(alias, 'pdf-export'), newer = await f.bind(stored, 'text-export');
    await f.host.run(newer, f.owner, 'text-export', stored, (scope: Scope) => scope.commit('NEWER', atomic));
    expect(await f.host.run(old, f.owner, 'pdf-export', alias, (scope: Scope) => scope.commit('OLDER', atomic))).toMatchObject({ status: 'stale' });
    expect(await fs.readFile(stored, 'utf8')).toBe('NEWER'); expect(await fs.readdir(dir)).toEqual(['Σ.pdf']);
    const first = path.join(dir, 'İ.pdf'), second = path.join(dir, 'I\u0307.pdf'); await fs.writeFile(first, 'ONE'); await fs.writeFile(second, 'TWO');
    const a = await f.bind(first, 'pdf-export'), b = await f.bind(second, 'pdf-export');
    await f.host.run(a, f.owner, 'pdf-export', first, (scope: Scope) => scope.commit('FIRST', atomic));
    await f.host.run(b, f.owner, 'pdf-export', second, (scope: Scope) => scope.commit('SECOND', atomic));
    expect(await fs.readFile(first, 'utf8')).toBe('FIRST'); expect(await fs.readFile(second, 'utf8')).toBe('SECOND');
  });
  it('refuses changed target bytes before invoking the expensive export producer', async () => {
    const f = manager(), file = path.join(dir, 'target.pdf'); await fs.writeFile(file, 'ORIGINAL'); const ticket = await f.bind(file, 'pdf-export');
    await fs.writeFile(file, 'EXTERNAL'); const producer = vi.fn((scope: Scope) => scope.commit('OVERWRITE', atomic));
    await expect(f.host.run(ticket, f.owner, 'pdf-export', file, producer)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(producer).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe('EXTERNAL');
  });
  it('retains an actively canceled conversion reservation until its callback joins and never writes', async () => {
    const f = manager({ maxPending: 1 }), file = path.join(dir, 'target.pdf'), ticket = await f.bind(file, 'pdf-export'), gate = deferred(), started = deferred(), writer = vi.fn(atomic);
    const running = track(f.host.run(ticket, f.owner, 'pdf-export', file, async (scope: Scope) => { started.resolve(); await gate.promise; return scope.commit('PDF', writer); }));
    await started.promise; f.host.cancel(ticket, f.owner, 'pdf-export');
    expect(f.host.stats().pending).toBe(1); expect(() => f.host.issue(f.owner, 'text-export')).toThrow(); gate.resolve();
    await expect(running).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED', committed: false });
    expect(writer).not.toHaveBeenCalled(); expect(await fs.readdir(dir)).toEqual([]); expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0 });
    expect(f.host.issue(f.owner, 'text-export')).toMatch(/^[a-f0-9]{48}$/);
  });
  it('cleans both arenas after conversion and post-commit failures, without adopting uncertain data', async () => {
    const f = manager(), a = path.join(dir, 'a.pdf'), b = path.join(dir, 'b.csv');
    const first = await f.bind(a, 'pdf-export'); await expect(f.host.run(first, f.owner, 'pdf-export', a, async () => { throw new Error('conversion failed'); })).rejects.toThrow('conversion failed');
    const second = await f.bind(b, 'text-export');
    await expect(f.host.run(second, f.owner, 'text-export', b, (scope: Scope) => scope.commit('SAVED', async (data, ctx) => { await atomic(data, ctx); throw new Error('after commit'); }))).rejects.toMatchObject({ committed: true });
    expect(await fs.readFile(b, 'utf8')).toBe('SAVED'); expect(f.host.stats()).toMatchObject({ pending: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0, queuedBytes: 0 });
  });
  it('keeps ordinary payload caps unchanged and independently enforces PDF payload caps', async () => {
    const f = manager({ maxPayloadBytes: 3, maxPdfPayloadBytes: 6 }), file = path.join(dir, 'output.bin'), writer = vi.fn(atomic);
    for (const kind of ['drawing', 'project', 'export-copy', 'text-export'] as const) {
      const ticket = await f.bind(file, kind); await expect(f.host.run(ticket, f.owner, kind, file, (scope: Scope) => scope.commit('FOUR', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    }
    const accepted = await f.bind(file, 'pdf-export'); await f.host.run(accepted, f.owner, 'pdf-export', file, (scope: Scope) => scope.commit('SIXPDF', writer));
    const rejected = await f.bind(file, 'pdf-export'); await expect(f.host.run(rejected, f.owner, 'pdf-export', file, (scope: Scope) => scope.commit('SEVEN!!', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    expect(writer).toHaveBeenCalledOnce(); expect(await fs.readFile(file, 'utf8')).toBe('SIXPDF');
  });
  it.each(['ordinary', 'pdf', 'shared'] as const)('reserves the %s arena before private copies or queued writes', async budget => {
    const f = manager({ maxPayloadBytes: 8, maxQueuedBytes: 8, maxPdfPayloadBytes: 9, maxPdfQueuedBytes: 9, maxSharedQueuedBytes: budget === 'shared' ? 12 : 17 });
    const firstKind: Kind = budget === 'ordinary' ? 'text-export' : 'pdf-export';
    const secondKind: Kind = budget === 'pdf' ? 'pdf-export' : 'text-export';
    const one = path.join(dir, 'one', 'output.bin'), two = path.join(dir, 'two', 'output.bin'); await fs.mkdir(path.dirname(one)); await fs.mkdir(path.dirname(two));
    const firstTicket = await f.bind(one, firstKind), secondTicket = await f.bind(two, secondKind), gate = deferred(), started = deferred(), rejectedWriter = vi.fn(atomic);
    const size = firstKind === 'pdf-export' ? 9 : 8;
    const running = track(f.host.run(firstTicket, f.owner, firstKind, one, (scope: Scope) => scope.commit(new Uint8Array(size), async (data, ctx) => { started.resolve(); await gate.promise; return atomic(data, ctx); })));
    await started.promise;
    expect(f.host.stats()).toMatchObject({ queuedBytes: size, ordinaryQueuedBytes: firstKind === 'text-export' ? size : 0, pdfQueuedBytes: firstKind === 'pdf-export' ? size : 0 });
    const bytes = budget === 'shared' ? 4 : 1;
    await expect(f.host.run(secondTicket, f.owner, secondKind, two, (scope: Scope) => scope.commit(new Uint8Array(bytes), rejectedWriter))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    expect(rejectedWriter).not.toHaveBeenCalled(); gate.resolve(); await running;
    expect(f.host.stats()).toMatchObject({ queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0 });
  });
  it('copies PDF typed arrays intrinsically, without invoking hostile iterators or retaining mutable bytes', async () => {
    const f = manager({ maxPdfPayloadBytes: 4, maxPdfQueuedBytes: 4 }), file = path.join(dir, 'output.pdf'), ticket = await f.bind(file, 'pdf-export');
    const payload = new Uint8Array([65]), iterator = vi.fn(function* () { yield* new Uint8Array(512); }); Object.defineProperty(payload, Symbol.iterator, { value: iterator });
    await f.host.run(ticket, f.owner, 'pdf-export', file, (scope: Scope) => scope.commit(payload, async (data, ctx) => { payload[0] = 66; expect(data).toEqual(new Uint8Array([65])); return atomic(data, ctx); }));
    expect(iterator).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe('A');
  });
  it('allows the ordinary and PDF arenas to fill concurrently up to the shared ceiling', async () => {
    const f = manager({ maxPayloadBytes: 8, maxQueuedBytes: 8, maxPdfPayloadBytes: 9, maxPdfQueuedBytes: 9, maxSharedQueuedBytes: 17 });
    const pdf = path.join(dir, 'pdf', 'output.pdf'), text = path.join(dir, 'text', 'output.csv'); await fs.mkdir(path.dirname(pdf)); await fs.mkdir(path.dirname(text));
    const pdfTicket = await f.bind(pdf, 'pdf-export'), textTicket = await f.bind(text, 'text-export'), release = deferred(), pdfStarted = deferred(), textStarted = deferred();
    const first = track(f.host.run(pdfTicket, f.owner, 'pdf-export', pdf, (scope: Scope) => scope.commit(new Uint8Array(9), async (data, ctx) => { pdfStarted.resolve(); await release.promise; return atomic(data, ctx); })));
    const second = track(f.host.run(textTicket, f.owner, 'text-export', text, (scope: Scope) => scope.commit(new Uint8Array(8), async (data, ctx) => { textStarted.resolve(); await release.promise; return atomic(data, ctx); })));
    await Promise.all([pdfStarted.promise, textStarted.promise]); expect(f.host.stats()).toMatchObject({ queuedBytes: 17, ordinaryQueuedBytes: 8, pdfQueuedBytes: 9 });
    release.resolve(); await Promise.all([first, second]); expect(f.host.stats()).toMatchObject({ queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0 });
  });
  it('requires explicit PDF eligibility for an extended file beyond 128 MiB, keeps 256 KiB hash scratch, and preserves ordinary refusal', async () => {
    const file = path.join(dir, 'large-existing.pdf'); let created = false, heldDescriptors = 0;
    let owned: ReturnType<typeof manager> | undefined;
    try {
    const handle = await fs.open(file, 'wx'); created = true;
    try { await handle.write('%PDF-1.4\n'); await handle.truncate(MAX_CONTENT_BYTES + 1); } finally { await handle.close(); }
    const reads: number[] = [];
    const wrapped = { ...native, open: async (...args: any[]) => {
      const fd = await (native.open as any)(...args); heldDescriptors++; let closed = false;
      return new Proxy(fd, { get(target, key) {
        if (key === 'read') return async (...values: any[]) => { reads.push(values[2]); return (target.read as any)(...values); };
        if (key === 'close') return async () => { await target.close(); if (!closed) { heldDescriptors--; closed = true; } };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    await expect(coherentFileDigest(file, { fs: wrapped, maxBytes: MAX_PDF_CONTENT_BYTES })).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' }); expect(reads).toEqual([]);
    const identity = createWindowsPathIdentity({ fs: wrapped }), f = manager({ identity }); owned = f;
    for (const kind of ['drawing', 'project', 'text-export'] as const) {
      const ticket = f.host.issue(f.owner, kind); await expect(f.host.bind(ticket, f.owner, kind, file)).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' });
    }
    expect(reads).toEqual([]); const ticket = await f.bind(file, 'pdf-export');
    const pinned = f.host.assertBound(ticket, f.owner, 'pdf-export', file); expect(pinned.contentLimit).toBe(MAX_PDF_CONTENT_BYTES);
    const checked = await identity.revalidate(pinned, { preserveVersion: true }); expect(checked.contentLimit).toBe(MAX_PDF_CONTENT_BYTES);
    expect(Math.max(...reads)).toBe(HASH_CHUNK_BYTES); expect((await fs.stat(file)).size).toBe(MAX_CONTENT_BYTES + 1);
    await f.host.cancelJoined(ticket, f.owner, 'pdf-export');
    expect(heldDescriptors).toBe(0); const completedReads = reads.length, enlarge = await fs.open(file, 'r+');
    try { await enlarge.truncate(MAX_PDF_CONTENT_BYTES + 1); } finally { await enlarge.close(); }
    expect((await fs.stat(file)).size).toBe(MAX_PDF_CONTENT_BYTES + 1);
    const oversized = f.host.issue(f.owner, 'pdf-export'); await expect(f.host.bind(oversized, f.owner, 'pdf-export', file)).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' });
    expect(reads).toHaveLength(completedReads); expect(heldDescriptors).toBe(0);
    expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0 });
    } finally {
      // Join all owned readers before altering the fixture. Deallocate its large
      // extent within this test's existing body deadline; the shared 10s cleanup
      // hook should only remove an empty file and its private directory.
      await owned?.host.dispose(); expect(heldDescriptors).toBe(0);
      if (owned) expect(owned.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0, queues: 0, metadataActive: 0, metadataQueued: 0 });
      if (created) {
        const reset = await fs.open(file, 'r+'); try { await reset.truncate(0); } finally { await reset.close(); }
        expect((await fs.stat(file)).size).toBe(0);
      }
    }
  }, 60000);
});

describe.runIf(process.platform === 'win32')('Shared main export facade with main-owned native grants', () => {
  it('keeps the chooser capture unbound and neither grants paths nor accepts a renderer-cloned capture', async () => {
    const f = facade(), file = path.join(dir, 'picked-with-any-extension.bin'), capture = f.order.capturePicked(f.ev, 'pdf-export');
    expect(f.registry.isKnown(file)).toBe(false); expect(() => f.order.assertBound(f.ev, 'pdf-export', file, capture)).toThrow(/ERR_SAVE_TICKET/);
    await expect(f.order.bindPicked(f.ev, 'pdf-export', file, { ...capture })).rejects.toThrow(/main-owned export capture/);
    await expect(f.order.bindPicked(f.ev, 'pdf-export', file, capture)).rejects.toThrow(/ERR_SAVE_AUTHORIZATION/);
    expect(f.registry.isKnown(file)).toBe(false); expect(await fs.readdir(dir)).toEqual([]);
    const next = f.order.capturePicked(f.ev, 'pdf-export'); f.registry.grant(file);
    expect(await f.order.bindPicked(f.ev, 'pdf-export', file, next)).toMatchObject({ identityPath: file, exists: false });
    expect(f.order.assertBound(f.ev, 'pdf-export', file, next).logicalPath).toBe(file);
    expect(await f.order.run(f.ev, 'pdf-export', file, next, (scope: Scope) => scope.commit('PDF', atomic))).toBe(file);
    expect(await fs.readFile(file, 'utf8')).toBe('PDF');
  });
  it('rejects forged, wrong-kind, canceled and already-bound early tickets before invoking the native picker', async () => {
    const f = facade(), picker = vi.fn(), file = path.join(dir, 'output.pdf'); f.registry.grant(file);
    const valid = await f.invoke('issue-save-admission', 'pdf-export') as string;
    const drawing = await f.invoke('issue-save-admission', 'drawing') as string;
    for (const ticket of ['forged', drawing]) expect(() => { f.order.capturePicked(f.ev, 'pdf-export', ticket); picker(); }).toThrow();
    await f.invoke('bind-save-admission', valid, 'pdf-export', file); expect(() => { f.order.capturePicked(f.ev, 'pdf-export', valid); picker(); }).toThrow();
    await f.invoke('cancel-save-admission', valid, 'pdf-export'); expect(() => { f.order.capturePicked(f.ev, 'pdf-export', valid); picker(); }).toThrow();
    expect(picker).not.toHaveBeenCalled(); expect(f.authorize).toHaveBeenCalledOnce();
    await f.invoke('cancel-save-admission', drawing, 'drawing');
  });
  it.each(['pdf-export', 'text-export', 'project'] as const)('rejects canceled %s native choice before a host grant, while retaining its original kind', async kind => {
    const f = facade(), file = path.join(dir, 'picked-output.bin'), capture = kind === 'project' ? f.order.capture(f.ev, kind) : f.order.capturePicked(f.ev, kind);
    f.order.assertPicked(f.ev, kind, capture); await f.invoke('cancel-save-admission', capture.ticket, kind);
    const grant = vi.fn(() => f.registry.grant(file));
    expect(() => { f.order.assertPicked(f.ev, kind, capture); grant(); }).toThrow(/ERR_SAVE_TICKET/);
    expect(grant).not.toHaveBeenCalled(); expect(f.registry.isKnown(file)).toBe(false); expect(f.order.stats().pending).toBe(0);
  });
  it.each(['text-export', 'pdf-export'] as const)('refuses %s onto an opened drawing or native hardlink regardless selected filter/name', async kind => {
    const f = facade(), file = path.join(dir, 'Original.dxf'), alias = path.join(dir, 'export-filter.csv'); await fs.writeFile(file, 'OPENED-DRAWING'); await fs.link(file, alias);
    const proof = await f.proof(file); f.registry.grant(alias); await fs.writeFile(file, 'OUTSIDE-EDIT');
    for (const target of [file, alias]) {
      const captured = f.order.capturePicked(f.ev, kind); await expect(f.order.bindPicked(f.ev, kind, target, captured)).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    }
    expect(await fs.readFile(file, 'utf8')).toBe('OUTSIDE-EDIT'); expect((await fs.readdir(dir)).sort()).toEqual(['Original.dxf', 'export-filter.csv'].sort());
    expect(f.order.stats().pending).toBe(0); await f.invoke('release-opened-source-proof', proof);
  });
  it('refuses a destination opened after export bind at the final write guard', async () => {
    const f = facade(), file = path.join(dir, 'Later-opened.dxf'); await fs.writeFile(file, 'DRAWING'); f.registry.grant(file);
    const capture = f.order.capturePicked(f.ev, 'pdf-export'); await f.order.bindPicked(f.ev, 'pdf-export', file, capture);
    const started = deferred(), proceed = deferred(), writer = vi.fn(atomic);
    const saving = track(f.order.run(f.ev, 'pdf-export', file, capture, async (scope: Scope) => { started.resolve(); await proceed.promise; return scope.commit('PDF', writer); }));
    await started.promise; const proof = await f.proof(file); proceed.resolve();
    await expect(saving).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/); expect(writer).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe('DRAWING');
    await f.invoke('release-opened-source-proof', proof); expect(f.order.stats().pending).toBe(0);
  });
  it('reuses a valid early text ticket after native picking and produces a one-use receipt without a source proof', async () => {
    const f = facade(), file = path.join(dir, 'report.csv'), ticket = await f.invoke('issue-save-admission', 'text-export') as string;
    const capture = f.order.capturePicked(f.ev, 'text-export', ticket); f.registry.grant(file);
    expect(await f.order.admitPicked(f.ev, 'text-export', file, capture, (scope: Scope) => scope.commit('device,count\nK1,2\n', atomic))).toBe(file);
    const receipt = await f.invoke('save-admission-result', ticket); expect(receipt).toEqual({ path: file, identityPath: file });
    expect(await f.invoke('save-admission-result', ticket)).toBeNull(); expect(f.order.stats().openedSources).toMatchObject({ records: 0, liveProofs: 0, pending: 0 });
  });
  it('asserts modern bound path/kind before a producer and does not inspect a wrong target', async () => {
    const f = facade(), file = path.join(dir, 'chosen.pdf'), other = path.join(dir, 'other.pdf'); f.registry.grant(file);
    const ticket = await f.invoke('issue-save-admission', 'pdf-export') as string; await f.invoke('bind-save-admission', ticket, 'pdf-export', file);
    const capture = f.order.capture(f.ev, 'pdf-export', ticket), producer = vi.fn(); f.authorize.mockClear();
    expect(() => { f.order.assertBound(f.ev, 'pdf-export', other, capture); producer(); }).toThrow();
    expect(() => { f.order.assertBound(f.ev, 'text-export', file, capture); producer(); }).toThrow();
    expect(producer).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
    f.order.assertBound(f.ev, 'pdf-export', file, capture); await f.invoke('cancel-save-admission', ticket, 'pdf-export');
  });
  it.each(['navigation', 'closed'] as const)('refuses a native pick completion from the retired document on %s', async event => {
    const f = facade(), file = path.join(dir, 'old-page.pdf'), capture = f.order.capturePicked(f.ev, 'pdf-export');
    if (event === 'navigation') f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true); else f.win.emit('closed');
    f.registry.grant(file); await expect(f.order.bindPicked(f.ev, 'pdf-export', file, capture)).rejects.toThrow(/ERR_SAVE_CANCELLED/);
    expect(await fs.readdir(dir)).toEqual([]); expect(f.order.stats().pending).toBe(0);
  });
  it('refuses old-document conversion completion while retaining cleanup capacity until joined', async () => {
    const f = facade(), file = path.join(dir, 'old.pdf'), capture = f.order.capturePicked(f.ev, 'pdf-export'); f.registry.grant(file); await f.order.bindPicked(f.ev, 'pdf-export', file, capture);
    const started = deferred(), proceed = deferred();
    const saving = track(f.order.run(f.ev, 'pdf-export', file, capture, async (scope: Scope) => { started.resolve(); await proceed.promise; return scope.commit('PDF', atomic); }));
    await started.promise; f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true); expect(f.order.stats().pending).toBe(1);
    proceed.resolve(); await expect(saving).rejects.toThrow(/ERR_SAVE_CANCELLED/);
    expect(await fs.readdir(dir)).toEqual([]); expect(f.order.stats()).toMatchObject({ pending: 0, queuedBytes: 0 });
  });
  it('joins export IPC cancellation through the conversion callback cleanup', async () => {
    const f = facade(), file = path.join(dir, 'canceled.pdf'), capture = f.order.capturePicked(f.ev, 'pdf-export'); f.registry.grant(file); await f.order.bindPicked(f.ev, 'pdf-export', file, capture);
    const started = deferred(), proceed = deferred(); let cleaned = false, canceled = false;
    const saving = track(f.order.run(f.ev, 'pdf-export', file, capture, async (scope: Scope) => {
      try { started.resolve(); await proceed.promise; return await scope.commit('PDF', atomic); }
      finally { cleaned = true; }
    }));
    await started.promise; const cancellation = track(f.invoke('cancel-save-admission', capture.ticket, 'pdf-export').then(() => { canceled = true; }));
    await Promise.resolve(); expect(canceled).toBe(false); expect(cleaned).toBe(false); expect(f.order.stats().pending).toBe(1);
    proceed.resolve(); await expect(saving).rejects.toThrow(/ERR_SAVE_CANCELLED/); await cancellation;
    expect(cleaned).toBe(true); expect(f.order.stats().pending).toBe(0); expect(await fs.readdir(dir)).toEqual([]);
    await expect(f.invoke('cancel-save-admission', capture.ticket, 'pdf-export')).rejects.toThrow(/ERR_SAVE_TICKET/);
  });
  it('joins native descriptor close while a canceled export bind is still reading', async () => {
    const file = path.join(dir, 'reading.pdf'); await fs.writeFile(file, 'PDF'); const closing = deferred(), proceed = deferred(); let closed = false;
    const wrapped = { ...native, open: async (...args: any[]) => {
      const fd = await (native.open as any)(...args); return new Proxy(fd, { get(target, key) {
        if (key === 'close') return async () => { closing.resolve(); await proceed.promise; await target.close(); closed = true; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const f = manager({ identity: createWindowsPathIdentity({ fs: wrapped }) }), ticket = f.host.issue(f.owner, 'pdf-export');
    const binding = track(f.host.bind(ticket, f.owner, 'pdf-export', file)); await closing.promise;
    let joined = false; const cancellation = track(f.host.cancelJoined(ticket, f.owner, 'pdf-export').then(() => { joined = true; }));
    await Promise.resolve(); expect(joined).toBe(false); expect(closed).toBe(false); expect(f.host.stats().pending).toBe(1);
    proceed.resolve(); await expect(binding).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await cancellation;
    expect(closed).toBe(true); expect(f.host.stats().pending).toBe(0); expect(await fs.readFile(file, 'utf8')).toBe('PDF');
  });
  it.each(['preparation', 'detached-writer'] as const)('joins %s cleanup without changing ordinary synchronous cancellation', async operation => {
    const f = manager(), file = path.join(dir, 'canceled.csv'), ticket = await f.bind(file, 'text-export'), started = deferred(), proceed = deferred(); let cleaned = false, joined = false;
    const job = operation === 'preparation'
      ? f.host.prepare(ticket, f.owner, 'text-export', file, async (ctx: WriterContext) => { try { started.resolve(); await proceed.promise; await ctx.guard(); } finally { cleaned = true; } })
      : f.host.run(ticket, f.owner, 'text-export', file, async (scope: Scope) => { void scope.commit('TEXT', async (_data, ctx) => { try { started.resolve(); await proceed.promise; await ctx.guard(); } finally { cleaned = true; } }); });
    const running = track(job); await started.promise;
    const cancellation = track(f.host.cancelJoined(ticket, f.owner, 'text-export').then(() => { joined = true; }));
    await Promise.resolve(); expect(joined).toBe(false); expect(f.host.stats().pending).toBe(1); proceed.resolve();
    await expect(running).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await cancellation; expect(cleaned).toBe(true);
    expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0 });
    const ordinary = f.host.issue(f.owner, 'drawing'); expect(f.host.cancel(ordinary, f.owner, 'drawing')).toBe(true);
    const unsupported = f.host.issue(f.owner, 'drawing'); await expect(f.host.cancelJoined(unsupported, f.owner, 'drawing')).rejects.toMatchObject({ code: 'ERR_SAVE_TICKET' }); f.host.cancel(unsupported, f.owner, 'drawing');
  });
});
