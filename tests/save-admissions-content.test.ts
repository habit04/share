import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url), native = require('node:fs/promises') as typeof fs;
const { createWindowsPathIdentity } = require('../electron/windows-path-identity.cjs');
const { createSaveAdmissions } = require('../electron/save-admissions.cjs');
const { createAtomicWriter } = require('../electron/atomic-write.cjs');
const privateRoot = path.resolve('.codex-local/save-content-tests'), roots: string[] = [], hosts: any[] = [];
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type WriterContext = { destinationPath: string; root?: string; guard(): Promise<void>; guardParents(): Promise<void>; markCommitted(): Promise<void> };
type SaveScope = { commit(bytes: string | Uint8Array, writer: (bytes: string | Uint8Array, ctx: WriterContext) => Promise<unknown>): Promise<unknown> };
async function setup(count = 2, options: Record<string, unknown> = {}) {
  await fs.mkdir(privateRoot, { recursive: true }); const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const files = Array.from({ length: count }, (_, index) => path.join(root, `Source${index}.dxf`));
  await Promise.all(files.map((file) => fs.writeFile(file, 'ORIGINAL')));
  const stats = new Map(await Promise.all(files.map(async (file) => [file, await fs.stat(file, { bigint: true })] as const)));
  const masked = (stat: any, file: unknown) => {
    const original = typeof file === 'string' ? stats.get(path.resolve(file)) : undefined;
    if (!original) return stat;
    return new Proxy(stat, { get(target, key) { if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].includes(String(key))) return Reflect.get(original, key); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  };
  // Real native file reads/writes with deterministic identical five-field tuples.
  const fileSystem = { ...native,
    stat: async (file: any, opts: any) => masked(await native.stat(file, opts), file),
    lstat: async (file: any, opts: any) => masked(await native.lstat(file, opts), file),
    open: async (...args: any[]) => { const handle = await (native.open as any)(...args); return new Proxy(handle, { get(target, key) { if (key === 'stat') return async (opts: any) => masked(await target.stat(opts), args[0]); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); },
  };
  const identity = createWindowsPathIdentity({ fs: fileSystem }), owner = {};
  const host = createSaveAdmissions({ identity, authorize: () => ({ allowed: true, root }), ...options }); hosts.push(host);
  const ordinary = async (index = 0) => { const ticket = host.issue(owner, 'drawing'); await host.bind(ticket, owner, 'drawing', files[index]); return ticket as string; };
  return { root, files, owner, identity, fileSystem, host, ordinary };
}
async function atomic(bytes: string | Uint8Array, ctx: WriterContext) {
  const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: () => ctx.guard() } });
  await writer.atomicWriteFile(ctx.destinationPath, bytes, { backup: false, root: ctx.root }); await ctx.markCommitted();
}
async function batch(f: Awaited<ReturnType<typeof setup>>, selected = [0]) {
  const parent = f.host.issueProjectBatch(f.owner), manifest = await f.host.bindProjectBatch(parent, f.owner, f.files);
  const tickets = manifest.map((entry: any) => entry.childTicket) as string[];
  for (const ticket of tickets) await f.host.readProjectBatch(parent, f.owner, ticket, async (ctx: any) => fs.readFile(ctx.pin.logicalPath));
  await f.host.sealProjectBatch(parent, f.owner, selected.map((index) => tickets[index]));
  await f.host.beginProjectBatchCommit(parent, f.owner); return { parent, tickets };
}
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const root of roots.splice(0)) { if (path.dirname(root) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe save content cleanup'); await fs.rm(root, { recursive: true, force: true }); }
});

describe.runIf(process.platform === 'win32')('Actual-byte save admission with deterministic stat collisions', () => {
  it('refuses outside bytes before ordinary serialization despite equal native-stat evidence', async () => {
    const f = await setup(1), ticket = await f.ordinary(), producer = vi.fn();
    await fs.writeFile(f.files[0]!, 'EXTERNAL');
    await expect(f.host.run(ticket, f.owner, 'drawing', f.files[0], producer)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(producer).not.toHaveBeenCalled(); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('EXTERNAL');
    expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0, queues: 0 });
  });
  it('refuses same-stat outside bytes after the producer starts, before replacing the original', async () => {
    const f = await setup(1), ticket = await f.ordinary(), writer = vi.fn(atomic);
    await expect(f.host.run(ticket, f.owner, 'drawing', f.files[0], async (scope: SaveScope) => {
      await fs.writeFile(f.files[0]!, 'EXTERNAL'); return scope.commit('OUTDATED', writer);
    })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(writer).not.toHaveBeenCalled(); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('EXTERNAL');
  });
  it('does not replace a backup when its original changes after copying', async () => {
    const f = await setup(1), ticket = await f.ordinary(), backup = `${f.files[0]!}.bak`; await fs.writeFile(backup, 'OLD-BACKUP');
    await expect(f.host.prepare(ticket, f.owner, 'drawing', f.files[0], async (ctx: WriterContext) => {
      const temp = `${backup}.tmp`; await fs.copyFile(f.files[0]!, temp); await fs.writeFile(f.files[0]!, 'EXTERNAL');
      try { await ctx.guard(); await fs.rename(temp, backup); } finally { await fs.rm(temp, { force: true }); }
    })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(await fs.readFile(backup, 'utf8')).toBe('OLD-BACKUP'); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('EXTERNAL'); f.host.cancel(ticket, f.owner, 'drawing');
  });
  it('pins exact source bytes at manifest binding and refuses an unread same-stat source change', async () => {
    const f = await setup(), parent = f.host.issueProjectBatch(f.owner), manifest = await f.host.bindProjectBatch(parent, f.owner, f.files), reader = vi.fn();
    await fs.writeFile(f.files[0]!, 'EXTERNAL');
    await expect(f.host.readProjectBatch(parent, f.owner, manifest[0].childTicket, reader)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(reader).not.toHaveBeenCalled();
  });
  it('refuses a changed unselected source at final preflight', async () => {
    const f = await setup(), parent = f.host.issueProjectBatch(f.owner), manifest = await f.host.bindProjectBatch(parent, f.owner, f.files);
    for (const entry of manifest) await f.host.readProjectBatch(parent, f.owner, entry.childTicket, async () => undefined);
    await f.host.sealProjectBatch(parent, f.owner, [manifest[0].childTicket]); await fs.writeFile(f.files[1]!, 'EXTERNAL');
    await expect(f.host.beginProjectBatchCommit(parent, f.owner)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('ORIGINAL');
  });
  it('refuses changed unselected source bytes after final preflight before any output producer', async () => {
    const f = await setup(), b = await batch(f), producer = vi.fn(); await fs.writeFile(f.files[1]!, 'EXTERNAL');
    await expect(f.host.run(b.tickets[0], f.owner, 'drawing', f.files[0], producer)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(producer).not.toHaveBeenCalled(); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('ORIGINAL');
  });
  it('refuses a late unselected-source change in a writer final guard', async () => {
    const f = await setup(), b = await batch(f);
    await expect(f.host.run(b.tickets[0], f.owner, 'drawing', f.files[0], async (scope: SaveScope) => scope.commit('OUTDATED', async (bytes, ctx) => {
      await fs.writeFile(f.files[1]!, 'EXTERNAL'); await ctx.guard(); await atomic(bytes, ctx);
    }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false }); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('ORIGINAL');
  });
  it('does not adopt an external post-rename edit as a proven own-parent transition', async () => {
    const f = await setup(2), b = await batch(f, [0, 1]);
    const rename = async (...args: any[]) => { await (native.rename as any)(...args); if (args[1] === f.files[0]) await native.writeFile(f.files[0]!, 'EXTERNAL'); };
    const writer = createAtomicWriter({ ...native, rename }, { hooks: { beforeAttempt: async () => {} } });
    await expect(f.host.run(b.tickets[0], f.owner, 'drawing', f.files[0], async (scope: SaveScope) => scope.commit('WRITTEN1', async (bytes, ctx) => {
      await ctx.guard(); await writer.atomicWriteFile(ctx.destinationPath, bytes, { root: ctx.root, backup: false }); await ctx.markCommitted();
    }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: true });
    expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('EXTERNAL'); const later = vi.fn();
    await expect(f.host.run(b.tickets[1], f.owner, 'drawing', f.files[1], later)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false }); expect(later).not.toHaveBeenCalled(); expect(await fs.readFile(f.files[1]!, 'utf8')).toBe('ORIGINAL');
  });
  it('admits actual own-parent bytes so a later dependent output can complete', async () => {
    const f = await setup(2), b = await batch(f, [0, 1]);
    for (let index = 0; index < 2; index++) expect(await f.host.run(b.tickets[index], f.owner, 'drawing', f.files[index], async (scope: SaveScope) => scope.commit(`WRITTEN${index + 1}`, atomic))).toMatchObject({ status: 'saved', committed: true });
    expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('WRITTEN1'); expect(await fs.readFile(f.files[1]!, 'utf8')).toBe('WRITTEN2');
  });
  it('matches UTF8 text and byte payload hashes, including Unicode and empty output', async () => {
    const f = await setup(1, { identity: createWindowsPathIdentity() });
    for (const bytes of ['Unicode \u03a3 \u{1f600}', new Uint8Array([0, 255, 1]), '']) {
      const ticket = await f.ordinary(); expect(await f.host.run(ticket, f.owner, 'drawing', f.files[0], async (scope: SaveScope) => scope.commit(bytes, atomic))).toMatchObject({ status: 'saved' });
      expect(hash(await fs.readFile(f.files[0]!))).toBe(hash(bytes));
    }
  });
  it('reserves the entire aggregate source-byte budget before opening any hash descriptor', async () => {
    const f = await setup(2), open = vi.fn(f.fileSystem.open), identity = createWindowsPathIdentity({ fs: { ...f.fileSystem, open } });
    const host = createSaveAdmissions({ identity, authorize: () => ({ allowed: true, root: f.root }), maxBatchInputBytes: 15 }); hosts.push(host);
    const parent = host.issueProjectBatch(f.owner); await expect(host.bindProjectBatch(parent, f.owner, f.files)).rejects.toMatchObject({ code: 'ERR_SAVE_BATCH_LIMIT' });
    expect(open).not.toHaveBeenCalled(); expect(host.stats()).toMatchObject({ batchParents: 0, batchInputBytes: 0, batchPinChars: 0 });
  });
  it('never opens unauthorized targets and explicitly rejects a stat-only identity provider', async () => {
    const f = await setup(1), open = vi.fn(f.fileSystem.open), identity = createWindowsPathIdentity({ fs: { ...f.fileSystem, open } });
    const denied = createSaveAdmissions({ identity, authorize: () => ({ allowed: false }) }); hosts.push(denied);
    const ticket = denied.issue(f.owner, 'drawing'); await expect(denied.bind(ticket, f.owner, 'drawing', f.files[0])).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' }); expect(open).not.toHaveBeenCalled();
    const { captureContentTarget: _omitted, ...statOnly } = identity;
    const unsafe = createSaveAdmissions({ identity: statOnly, authorize: () => ({ allowed: true }) }); hosts.push(unsafe);
    await expect(unsafe.bind(unsafe.issue(f.owner, 'drawing'), f.owner, 'drawing', f.files[0])).rejects.toMatchObject({ code: 'ERR_SAVE_CONFIGURATION' }); expect(open).not.toHaveBeenCalled();
  });
});
