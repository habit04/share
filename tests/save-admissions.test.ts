import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWindowsPathIdentity } = require('../electron/windows-path-identity.cjs');
const { createSaveAdmissions, SAVE_ADMISSION_LIMITS } = require('../electron/save-admissions.cjs');
const { createAtomicWriter } = require('../electron/atomic-write.cjs');
type WriterContext = { destinationPath: string; logicalPath: string; canonicalPath: string; root?: string; signal: AbortSignal; guard(): Promise<void>; guardParents(): Promise<void>; markCommitted(): Promise<void> };
type PreparationContext = Omit<WriterContext, 'markCommitted'>;
type Scope = { signal: AbortSignal; commit(data: string | Uint8Array, writer: (data: string | Uint8Array, ctx: WriterContext) => Promise<unknown>): Promise<unknown> };
const privateRoot = path.resolve('.codex-local/save-admission-tests'), roots: string[] = [], hosts: any[] = [];
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function setup(options: Record<string, unknown> = {}) {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const owner = {}, host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true, root }), ...options }); hosts.push(host);
  const ticket = async (file = path.join(root, 'file.dxf'), kind = 'drawing') => { const value = host.issue(owner, kind); await host.bind(value, owner, kind, file); return value as string; };
  const run = (value: string, file: string, operation: (scope: Scope) => Promise<unknown>, kind = 'drawing') => host.run(value, owner, kind, file, operation);
  return { root, owner, host, ticket, run, file: path.join(root, 'file.dxf') };
}
async function write(data: string | Uint8Array, ctx: WriterContext) {
  const writer = createAtomicWriter(undefined, { hooks: { beforeRename: () => ctx.guard() } });
  const result = await writer.atomicWriteFile(ctx.destinationPath, data, { backup: true, root: ctx.root });
  await ctx.markCommitted(); return result;
}
async function copyBackup(ctx: PreparationContext, beforeRename?: () => Promise<void>) {
  const temporary = `${ctx.destinationPath}.backup-preparation.tmp`, backup = `${ctx.destinationPath}.bak`; let created = false;
  try {
    await ctx.guard(); await fs.copyFile(ctx.destinationPath, temporary, fs.constants.COPYFILE_EXCL); created = true;
    if (beforeRename) await beforeRename();
    await ctx.guard(); await fs.rename(temporary, backup); created = false; await ctx.guardParents(); return backup;
  } finally { if (created) { await ctx.guardParents(); await fs.rm(temporary); } }
}
async function writeWithoutBackup(data: string | Uint8Array, ctx: WriterContext) {
  const writer = createAtomicWriter(undefined, { hooks: { beforeRename: () => ctx.guard() } });
  const result = await writer.atomicWriteFile(ctx.destinationPath, data, { backup: false, root: ctx.root }); await ctx.markCommitted(); return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe private save test cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('Save admission configuration and ownership', () => {
  it('requires explicit authorization and bounded configuration', () => {
    expect(() => createSaveAdmissions({ identity: createWindowsPathIdentity() })).toThrow();
    for (const [field, bad] of [['maxPending', 33], ['maxLedger', 513], ['maxPayloadBytes', SAVE_ADMISSION_LIMITS.payload + 1], ['maxQueuedBytes', SAVE_ADMISSION_LIMITS.queuedBytes + 1], ['ttlMs', 600001], ['maxPending', 0], ['maxPending', 1.5]]) expect(() => createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true }), [field]: bad })).toThrow();
  });
  it('rejects renderer-shaped owners, unsupported kinds, forged tickets and cross-owner/kind transfer', () => {
    const host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true }) }); hosts.push(host); const owner = {}, foreign = {};
    expect(() => host.issue('renderer-id', 'drawing')).toThrow(); expect(() => host.issue(owner, 'dwg')).toThrow();
    const ticket = host.issue(owner, 'drawing'); expect(ticket).toMatch(/^[0-9a-f]{48}$/);
    for (const [value, who, kind] of [['forged', owner, 'drawing'], [ticket, foreign, 'drawing'], [ticket, owner, 'project']]) expect(() => host.bind(value, who, kind, 'C:\\x.dxf')).toThrow();
    host.cancel(ticket, owner, 'drawing'); expect(() => host.bind(ticket, owner, 'drawing', 'C:\\x.dxf')).toThrow();
  });
  it('caps issued reservations at 32 and frees unclaimed cancellation', () => {
    const host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true }) }); hosts.push(host); const owner = {};
    const tickets = Array.from({ length: 32 }, () => host.issue(owner, 'drawing'));
    expect(() => host.issue(owner, 'drawing')).toThrowError(/Too many/); host.cancel(tickets[0], owner, 'drawing');
    expect(host.issue(owner, 'drawing')).toMatch(/^[0-9a-f]{48}$/); expect(host.stats().pending).toBe(32);
  });
  it('checks authorization before any target inspection', async () => {
    const capture = vi.fn(), host = createSaveAdmissions({ identity: { captureWriteTarget: capture, revalidate: vi.fn() }, authorize: () => ({ allowed: false }) }); hosts.push(host);
    const owner = {}, ticket = host.issue(owner, 'drawing');
    await expect(host.bind(ticket, owner, 'drawing', 'C:\\blocked.dxf')).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' });
    expect(capture).not.toHaveBeenCalled(); expect(host.stats().pending).toBe(0);
  });
  it('expires issued tickets but retains an actively binding authorization until cleanup', async () => {
    let clock = 0; const gate = deferred<{ allowed: false }>(), host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => gate.promise, now: () => clock, ttlMs: 5, maxPending: 1 }); hosts.push(host);
    const owner = {}, expired = host.issue(owner, 'drawing'); clock = 6;
    expect(() => host.bind(expired, owner, 'drawing', 'C:\\x.dxf')).toThrow();
    const active = host.issue(owner, 'drawing'), binding = host.bind(active, owner, 'drawing', 'C:\\x.dxf');
    const rejected = expect(binding).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' }); clock = 100;
    host.cancel(active, owner, 'drawing'); expect(() => host.issue(owner, 'drawing')).toThrowError(/Too many/);
    gate.resolve({ allowed: false }); await rejected; expect(host.stats().pending).toBe(0);
  });
});

describe.runIf(process.platform === 'win32')('Native Windows admitted saves', () => {
  it('binds only once and refuses another logical path or concurrent ticket reuse', async () => {
    const f = await setup(), ticket = await f.ticket(), gate = deferred(), entered = deferred();
    expect(() => f.host.bind(ticket, f.owner, 'drawing', f.file)).toThrow();
    expect(() => f.run(ticket, path.join(f.root, 'other.dxf'), async (scope) => scope.commit('other', write))).toThrow();
    const task = f.run(ticket, f.file, async (scope) => { entered.resolve(); await gate.promise; return await scope.commit('one', write); }); await entered.promise;
    expect(() => f.run(ticket, f.file, async (scope) => scope.commit('two', write))).toThrow(); gate.resolve();
    expect((await task).status).toBe('saved'); expect(() => f.run(ticket, f.file, async (scope) => scope.commit('again', write))).toThrow();
    expect(await fs.readFile(f.file, 'utf8')).toBe('one');
  });
  it('refuses missing parents at bind before a slow producer can enter another queue namespace', async () => {
    const f = await setup(), file = path.join(f.root, 'Missing', 'x.dxf'), old = f.host.issue(f.owner, 'drawing');
    await expect(f.host.bind(old, f.owner, 'drawing', file)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.host.stats().pending).toBe(0);
    await fs.mkdir(path.dirname(file)); const newer = await f.ticket(file);
    expect((await f.run(newer, file, async (scope) => scope.commit('after directory creation', write))).status).toBe('saved');
    expect(() => f.run(old, file, async (scope) => scope.commit('older', write))).toThrow();
  });
  it('rejects an older initially missing native Unicode alias after a newer durable write without another backup', async () => {
    const f = await setup(), olderFile = path.join(f.root, '\u1f80.dxf'), newerFile = path.join(f.root, '\u1f88.dxf'), slow = deferred(), entered = deferred();
    const older = await f.ticket(olderFile), oldTask = f.run(older, olderFile, async (scope) => { entered.resolve(); await slow.promise; return await scope.commit('OLDER', write); }); await entered.promise;
    const newer = await f.ticket(newerFile); expect((await f.run(newer, newerFile, async (scope) => scope.commit('NEWEST', write))).status).toBe('saved');
    expect(f.host.stats().ledger).toBe(1); slow.resolve(); expect(await oldTask).toEqual({ status: 'stale', committed: false });
    expect(await fs.readFile(olderFile, 'utf8')).toBe('NEWEST'); expect(await fs.readdir(f.root)).toEqual(['\u1f88.dxf']); expect(f.host.stats().ledger).toBe(0);
  });
  it('retains a newer ledger even while an older ticket is still unbound', async () => {
    const f = await setup(), older = f.host.issue(f.owner, 'drawing'), newer = await f.ticket();
    await f.run(newer, f.file, async (scope) => scope.commit('newer', write)); expect(f.host.stats().ledger).toBe(1);
    await f.host.bind(older, f.owner, 'drawing', f.file);
    expect(await f.run(older, f.file, async (scope) => scope.commit('old snapshot', write))).toEqual({ status: 'stale', committed: false });
    expect(await fs.readFile(f.file, 'utf8')).toBe('newer'); await expect(fs.stat(`${f.file}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('saves distinct lowercasing-confusable files independently', async () => {
    const f = await setup(), first = path.join(f.root, '\u0130.dxf'), second = path.join(f.root, 'I\u0307.dxf'), slow = deferred(), entered = deferred();
    const older = await f.ticket(first), task = f.run(older, first, async (scope) => { entered.resolve(); await slow.promise; return await scope.commit('FIRST', write); }); await entered.promise;
    await f.run(await f.ticket(second), second, async (scope) => scope.commit('SECOND', write)); slow.resolve(); expect((await task).status).toBe('saved');
    expect(await fs.readFile(first, 'utf8')).toBe('FIRST'); expect(await fs.readFile(second, 'utf8')).toBe('SECOND'); expect(await fs.readdir(f.root)).toHaveLength(2);
  });
  it('preserves existing stored leaf case and refuses older aliases after a newer replacement', async () => {
    const f = await setup(), stored = path.join(f.root, 'Case.dxf'), alias = path.join(f.root, 'case.dxf'), slow = deferred(), entered = deferred();
    await fs.writeFile(stored, 'ORIGINAL'); const old = await f.ticket(stored), oldTask = f.run(old, stored, async (scope) => { entered.resolve(); await slow.promise; return await scope.commit('OLDER', write); }); await entered.promise;
    await f.run(await f.ticket(alias), alias, async (scope) => scope.commit('NEWER', write)); slow.resolve(); expect((await oldTask).status).toBe('stale');
    expect(await fs.readdir(f.root)).toEqual(['Case.dxf', 'Case.dxf.bak']); expect(await fs.readFile(stored, 'utf8')).toBe('NEWER'); expect(await fs.readFile(`${stored}.bak`, 'utf8')).toBe('ORIGINAL');
  });
  it('permits ordered own-host replacements while retaining a newer preparation original version', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'ZERO');
    const first = await f.ticket(), second = await f.ticket(), third = await f.ticket();
    for (const [ticket, text] of [[first, 'ONE'], [second, 'TWO'], [third, 'THREE']] as const) expect((await f.run(ticket, f.file, async (scope) => scope.commit(text, write))).status).toBe('saved');
    expect(await fs.readFile(f.file, 'utf8')).toBe('THREE'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('TWO'); expect(f.host.stats().ledger).toBe(0);
  });
  it.each(['content', 'case', 'replacement'])('rejects external target %s changes without invoking the writer', async (change) => {
    const f = await setup(), file = path.join(f.root, 'Case.dxf'); await fs.writeFile(file, 'original'); const ticket = await f.ticket(file), writer = vi.fn(write);
    if (change === 'content') await fs.writeFile(file, 'external larger content');
    else if (change === 'case') await fs.rename(file, path.join(f.root, 'case.dxf'));
    else { await fs.rename(file, path.join(f.root, 'old.dxf')); await fs.writeFile(file, 'different file'); }
    await expect(f.run(ticket, file, async (scope) => scope.commit('snapshot', writer))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(writer).not.toHaveBeenCalled();
  });
  it('refuses a granted-root retarget before calling a producer or writing outside bytes', async () => {
    const f = await setup(), inside = path.join(f.root, '\u0130'), outside = path.join(f.root, 'I\u0307'), picked = path.join(f.root, 'Picked');
    await fs.mkdir(inside); await fs.mkdir(outside); await fs.symlink(inside, picked, 'junction');
    const host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true, root: picked }) }); hosts.push(host);
    const ticket = host.issue(f.owner, 'drawing'), file = path.join(picked, 'x.dxf'); await host.bind(ticket, f.owner, 'drawing', file);
    await fs.unlink(picked); await fs.symlink(outside, picked, 'junction'); const producer = vi.fn(async (scope: Scope) => scope.commit('outside', write));
    await expect(host.run(ticket, f.owner, 'drawing', file, producer)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(producer).not.toHaveBeenCalled(); expect(await fs.readdir(outside)).toEqual([]);
  });
  it('checks authorization before copying a mutable queued payload', async () => {
    let allowed = true; const f = await setup({ authorize: () => ({ allowed }) }), ticket = await f.ticket(), copy = vi.spyOn(Uint8Array, 'from'), writer = vi.fn(write);
    await expect(f.run(ticket, f.file, async (scope) => { allowed = false; return await scope.commit(new Uint8Array([1, 2, 3]), writer); })).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION', committed: false });
    expect(copy).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled(); expect(f.host.stats().queuedBytes).toBe(0);
  });
  it('refuses a changed authorization root even when the new root would contain the file', async () => {
    const f = await setup(), root = f.root; let changed = false;
    const host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true, root: changed ? path.dirname(root) : root }) }); hosts.push(host);
    const ticket = host.issue(f.owner, 'project'); await host.bind(ticket, f.owner, 'project', f.file); changed = true; const producer = vi.fn();
    await expect(host.run(ticket, f.owner, 'project', f.file, producer)).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' }); expect(producer).not.toHaveBeenCalled();
  });
  it('serializes same-parent writers and captures byte payloads before waiting', async () => {
    const f = await setup(), a = path.join(f.root, 'a.dxf'), b = path.join(f.root, 'b.dxf'), gate = deferred(), entered = deferred(), bytes = new Uint8Array([1, 2, 3]); let active = 0, maximum = 0;
    const first = f.run(await f.ticket(a), a, async (scope) => scope.commit('one', async (data, ctx) => { maximum = Math.max(maximum, ++active); entered.resolve(); await gate.promise; try { return await write(data, ctx); } finally { active--; } })); await entered.promise;
    const second = f.run(await f.ticket(b), b, async (scope) => scope.commit(bytes, async (data, ctx) => { maximum = Math.max(maximum, ++active); try { return await write(data, ctx); } finally { active--; } }));
    await vi.waitFor(() => expect(f.host.stats().queuedBytes).toBe(6)); bytes.fill(9); gate.resolve(); await Promise.all([first, second]);
    expect(maximum).toBe(1); expect([...await fs.readFile(b)]).toEqual([1, 2, 3]); expect(f.host.stats().queuedBytes).toBe(0);
  });
  it('allows unrelated native parents to write concurrently', async () => {
    const f = await setup(), other = path.join(f.root, 'Other'); await fs.mkdir(other); const gate = deferred(), entered = deferred();
    const first = f.run(await f.ticket(), f.file, async (scope) => scope.commit('one', async (data, ctx) => { entered.resolve(); await gate.promise; return await write(data, ctx); })); await entered.promise;
    const b = path.join(other, 'b.dxf'); expect((await f.run(await f.ticket(b), b, async (scope) => scope.commit('two', write))).status).toBe('saved'); gate.resolve(); await first;
  });
  it('bounds per-payload and combined queued bytes and recovers after the occupied queue drains', async () => {
    const f = await setup({ maxPayloadBytes: 4, maxQueuedBytes: 5 }), gate = deferred(), entered = deferred();
    const first = f.run(await f.ticket(), f.file, async (scope) => scope.commit('ONE', async (data, ctx) => { entered.resolve(); await gate.promise; return await write(data, ctx); })); await entered.promise;
    const other = path.join(f.root, 'other.dxf'), writer = vi.fn(write);
    await expect(f.run(await f.ticket(other), other, async (scope) => scope.commit('TOO', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    await expect(f.run(await f.ticket(other), other, async (scope) => scope.commit('12345', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    expect(writer).not.toHaveBeenCalled(); expect(f.host.stats().queuedBytes).toBe(3); gate.resolve(); await first;
    expect((await f.run(await f.ticket(other), other, async (scope) => scope.commit('OK', write))).status).toBe('saved'); expect(f.host.stats().queuedBytes).toBe(0);
  });
  it('measures and copies intrinsic typed-array bytes without invoking a custom iterator or forged byteLength', async () => {
    const f = await setup({ maxPayloadBytes: 4, maxQueuedBytes: 4 }), bytes = new Uint8Array([7]);
    const iterator = vi.fn(function* () { for (let i = 0; i < 512; i++) yield 9; });
    Object.defineProperty(bytes, Symbol.iterator, { value: iterator }); Object.defineProperty(bytes, 'byteLength', { value: 512 });
    expect((await f.run(await f.ticket(), f.file, async (scope) => scope.commit(bytes, write))).status).toBe('saved');
    expect(iterator).not.toHaveBeenCalled(); expect([...await fs.readFile(f.file)]).toEqual([7]);
    const tooBig = new Uint8Array(5); Object.defineProperty(tooBig, 'byteLength', { value: 1 });
    await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit(tooBig, write))).rejects.toMatchObject({ code: 'ERR_SAVE_PAYLOAD_LIMIT' });
    const forged = Object.create(Uint8Array.prototype);
    await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit(forged, write))).rejects.toMatchObject({ committed: false });
    expect(await fs.readFile(f.file)).toEqual(Buffer.from([7])); expect(f.host.stats().queuedBytes).toBe(0);
  });
  it('keeps a cancelled running slot and its cleanup until the producer settles, beyond issued TTL', async () => {
    let clock = 0; const f = await setup({ maxPending: 1, ttlMs: 5, now: () => clock }), gate = deferred(), entered = deferred(), ticket = await f.ticket();
    const task = f.run(ticket, f.file, async (scope) => { entered.resolve(); await gate.promise; return await scope.commit('cancelled', write); }); const rejected = expect(task).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED', committed: false }); await entered.promise;
    clock = 100; f.host.cancel(ticket, f.owner, 'drawing'); expect(() => f.host.issue(f.owner, 'drawing')).toThrowError(/Too many/); gate.resolve(); await rejected;
    expect(f.host.stats().pending).toBe(0); await expect(fs.stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('expires abandoned bound tickets and prevents late retained producer callbacks', async () => {
    let clock = 0; const f = await setup({ ttlMs: 5, now: () => clock }), expired = await f.ticket(); clock = 6;
    expect(() => f.run(expired, f.file, async (scope) => scope.commit('expired', write))).toThrow();
    let retained!: Scope;
    await expect(f.run(await f.ticket(), f.file, async (scope) => { retained = scope; })).rejects.toMatchObject({ code: 'ERR_SAVE_NO_COMMIT' });
    await expect(retained.commit('late', write)).rejects.toMatchObject({ code: 'ERR_SAVE_TICKET' }); await expect(fs.stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('joins a commit callback the producer did not await and refuses a second commit', async () => {
    const f = await setup(); expect((await f.run(await f.ticket(), f.file, async (scope) => { void scope.commit('joined', write); return 42; })).value).toBe(42);
    await expect(f.run(await f.ticket(), f.file, async (scope) => { await scope.commit('first', write); return await scope.commit('second', write); })).rejects.toMatchObject({ code: 'ERR_SAVE_TICKET', committed: true });
    expect(await fs.readFile(f.file, 'utf8')).toBe('first'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('joined');
  });
  it('reports a completed write accurately when cancellation arrives after its replacement', async () => {
    const f = await setup(), gate = deferred(), committed = deferred(), ticket = await f.ticket();
    const task = f.run(ticket, f.file, async (scope) => scope.commit('durable', async (data, ctx) => { const result = await write(data, ctx); committed.resolve(); await gate.promise; return result; })); await committed.promise;
    f.host.cancel(ticket, f.owner, 'drawing'); expect(f.host.stats().pending).toBe(1); gate.resolve(); expect(await task).toMatchObject({ status: 'saved', committed: true, cancelledAfterCommit: true });
    expect(await fs.readFile(f.file, 'utf8')).toBe('durable'); expect(f.host.stats().pending).toBe(0);
  });
  it('propagates post-commit verification errors with commit evidence and allows a fresh retry', async () => {
    const f = await setup(); await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit('written but verification failed', async (data, ctx) => { await write(data, ctx); throw Object.assign(new Error('Reopen verification failed'), { code: 'ERR_VERIFY' }); }))).rejects.toMatchObject({ code: 'ERR_VERIFY', committed: true });
    expect(await fs.readFile(f.file, 'utf8')).toBe('written but verification failed');
    expect((await f.run(await f.ticket(), f.file, async (scope) => scope.commit('retry verified', write))).status).toBe('saved'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('written but verification failed');
  });
  it.each([undefined, null, 0, false])('does not report a successful save when post-commit verification rejects with %j', async (failure) => {
    const f = await setup();
    await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit('written', async (data, ctx) => { await write(data, ctx); throw failure; }))).rejects.toMatchObject({ code: 'ERR_SAVE_OPERATION', committed: true });
    expect(await fs.readFile(f.file, 'utf8')).toBe('written');
  });
  it('does not adopt an external edit as an own transition after an unmarked writer error', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); const first = await f.ticket(), second = await f.ticket(), gate = deferred(), entered = deferred();
    const task = f.run(first, f.file, async (scope) => scope.commit('first', async () => { entered.resolve(); await gate.promise; throw new Error('Writer failed before replacement'); }));
    const rejected = expect(task).rejects.toThrow('Writer failed'); await entered.promise; await fs.writeFile(f.file, 'external edit must survive'); gate.resolve(); await rejected;
    await expect(f.run(second, f.file, async (scope) => scope.commit('newer stale snapshot', write))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(await fs.readFile(f.file, 'utf8')).toBe('external edit must survive'); await expect(fs.stat(`${f.file}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a target change before final replacement and retains a changed file after successful replacement as an error', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original');
    await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit('prepared', async (_data, ctx) => {
      await fs.writeFile(f.file, 'external before final replace'); await ctx.guard(); throw new Error('Must not reach replacement');
    }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(await fs.readFile(f.file, 'utf8')).toBe('external before final replace');
    await expect(f.run(await f.ticket(), f.file, async (scope) => scope.commit('committed', async (data, ctx) => {
      await write(data, ctx); await fs.writeFile(f.file, 'external after replacement'); return 'verified';
    }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: true });
    expect(await fs.readFile(f.file, 'utf8')).toBe('external after replacement');
  });
  it('producer errors do not suppress an older valid save or poison a future reservation', async () => {
    const f = await setup(), older = await f.ticket(), newer = await f.ticket();
    await expect(f.run(newer, f.file, async () => { throw new Error('Producer failed'); })).rejects.toThrow('Producer failed');
    expect((await f.run(older, f.file, async (scope) => scope.commit('older valid', write))).status).toBe('saved');
    expect((await f.run(await f.ticket(), f.file, async (scope) => scope.commit('fresh', write))).status).toBe('saved');
  });
  it('never evicts a protected newer ledger to admit unrelated writes while an older ticket can still arrive', async () => {
    const f = await setup({ maxLedger: 2 }), old = f.host.issue(f.owner, 'drawing');
    for (const name of ['a.dxf', 'b.dxf']) { const file = path.join(f.root, name); await f.run(await f.ticket(file), file, async (scope) => scope.commit(name, write)); }
    const c = path.join(f.root, 'c.dxf'), writer = vi.fn(write); await expect(f.run(await f.ticket(c), c, async (scope) => scope.commit('C', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_LEDGER_LIMIT' });
    expect(writer).not.toHaveBeenCalled(); expect(f.host.stats().ledger).toBe(2); f.host.cancel(old, f.owner, 'drawing'); expect(f.host.stats().ledger).toBe(0);
    expect((await f.run(await f.ticket(c), c, async (scope) => scope.commit('RECOVERED', write))).status).toBe('saved');
  });
  it('owner retirement and disposal abort outstanding work but await callback cleanup before releasing capacity', async () => {
    const f = await setup({ maxPending: 1 }), gate = deferred(), entered = deferred(), ticket = await f.ticket();
    const task = f.run(ticket, f.file, async (scope) => { entered.resolve(); await gate.promise; return await scope.commit('retired', write); }); const rejected = expect(task).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await entered.promise;
    f.host.retireOwner(f.owner); expect(() => f.host.issue(f.owner, 'drawing')).toThrow(); expect(() => f.host.issue({}, 'drawing')).toThrowError(/Too many/);
    let disposed = false; const disposing = f.host.dispose().then(() => { disposed = true; }); await Promise.resolve(); expect(disposed).toBe(false); gate.resolve(); await rejected; await disposing;
    expect(disposed).toBe(true); expect(f.host.stats()).toMatchObject({ pending: 0, queuedBytes: 0 }); expect(() => f.host.issue({}, 'drawing')).toThrow();
  });
});

describe.runIf(process.platform === 'win32')('Non-consuming guarded backup preparation', () => {
  it('copies the native stored-case file and reuses its ticket for a save without replacing the prepared backup', async () => {
    const f = await setup(), stored = path.join(f.root, 'Case.dxf'), alias = path.join(f.root, 'case.dxf'); await fs.writeFile(stored, 'before bulk edit');
    const ticket = await f.ticket(alias), copy = vi.fn(copyBackup);
    expect(await f.host.prepare(ticket, f.owner, 'drawing', alias, copy)).toEqual({ status: 'prepared', value: `${stored}.bak` });
    expect(copy.mock.calls[0]![0].destinationPath).toBe(stored); expect(f.host.stats()).toMatchObject({ pending: 1, ledger: 0 });
    expect(await fs.readFile(`${stored}.bak`, 'utf8')).toBe('before bulk edit'); expect(await fs.readFile(stored, 'utf8')).toBe('before bulk edit');
    expect((await f.run(ticket, alias, async (scope) => scope.commit('after bulk edit', writeWithoutBackup))).status).toBe('saved');
    expect(await fs.readFile(stored, 'utf8')).toBe('after bulk edit'); expect(await fs.readFile(`${stored}.bak`, 'utf8')).toBe('before bulk edit');
    expect(await fs.readdir(f.root)).toEqual(['Case.dxf', 'Case.dxf.bak']);
  });
  it.each([false, true])('refuses a stale native alias backup without changing .bak (previous file=%j)', async (exists) => {
    const f = await setup(), oldFile = path.join(f.root, '\u1f80.dxf'), newerFile = path.join(f.root, '\u1f88.dxf');
    if (exists) await fs.writeFile(oldFile, 'original'); const old = await f.ticket(oldFile), newer = await f.ticket(newerFile);
    await f.run(newer, newerFile, async (scope) => scope.commit('newest', write)); const entries = await fs.readdir(f.root), copy = vi.fn(copyBackup);
    const backup = exists ? await fs.readFile(`${oldFile}.bak`, 'utf8') : undefined;
    expect(await f.host.prepare(old, f.owner, 'drawing', oldFile, copy)).toEqual({ status: 'stale', committed: false });
    expect(copy).not.toHaveBeenCalled(); expect(await fs.readdir(f.root)).toEqual(entries); if (exists) expect(await fs.readFile(`${oldFile}.bak`, 'utf8')).toBe(backup);
    expect((await f.run(old, oldFile, async (scope) => scope.commit('older', writeWithoutBackup))).status).toBe('stale'); expect(await fs.readFile(oldFile, 'utf8')).toBe('newest');
  });
  it('serializes an in-progress backup and another ticket save in the same parent queue', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); const old = await f.ticket(), newer = await f.ticket(), gate = deferred(), entered = deferred(); let writerEntered = false;
    const preparing = f.host.prepare(old, f.owner, 'drawing', f.file, (ctx: PreparationContext) => copyBackup(ctx, async () => { entered.resolve(); await gate.promise; })); await entered.promise;
    const saving = f.run(newer, f.file, async (scope) => scope.commit('newer', async (data, ctx) => { writerEntered = true; return await writeWithoutBackup(data, ctx); }));
    await vi.waitFor(() => expect(f.host.stats().queuedBytes).toBe(5)); expect(writerEntered).toBe(false); gate.resolve(); expect((await preparing).status).toBe('prepared'); expect((await saving).status).toBe('saved');
    expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('original'); expect((await f.run(old, f.file, async (scope) => scope.commit('old', writeWithoutBackup))).status).toBe('stale');
  });
  it('copies a proven earlier own replacement without advancing its original-file ledger or consuming the newer ticket', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'zero'); const earlier = await f.ticket(), newer = await f.ticket();
    await f.run(earlier, f.file, async (scope) => scope.commit('one', write)); expect(f.host.stats().ledger).toBe(1);
    expect((await f.host.prepare(newer, f.owner, 'drawing', f.file, copyBackup)).status).toBe('prepared');
    expect(f.host.stats()).toMatchObject({ pending: 1, ledger: 1 }); expect(await fs.readFile(f.file, 'utf8')).toBe('one'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('one');
    expect((await f.run(newer, f.file, async (scope) => scope.commit('two', writeWithoutBackup))).status).toBe('saved'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('one'); expect(f.host.stats().ledger).toBe(0);
  });
  it('rejects concurrent prepare/run and late retained guards while preserving successful bound-ticket reuse', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); const ticket = await f.ticket(), gate = deferred(), entered = deferred(); let retained!: PreparationContext;
    const preparing = f.host.prepare(ticket, f.owner, 'drawing', f.file, async (ctx: PreparationContext) => { retained = ctx; entered.resolve(); await gate.promise; return await copyBackup(ctx); }); await entered.promise;
    expect(() => f.host.prepare(ticket, f.owner, 'drawing', f.file, copyBackup)).toThrow(); expect(() => f.run(ticket, f.file, async (scope) => scope.commit('concurrent', write))).toThrow();
    gate.resolve(); await preparing; await expect(retained.guard()).rejects.toMatchObject({ code: 'ERR_SAVE_TICKET' }); await expect(retained.guardParents()).rejects.toMatchObject({ code: 'ERR_SAVE_TICKET' });
    expect((await f.host.prepare(ticket, f.owner, 'drawing', f.file, copyBackup)).status).toBe('prepared');
    expect((await f.run(ticket, f.file, async (scope) => scope.commit('after', writeWithoutBackup))).status).toBe('saved');
    expect(() => f.host.prepare(ticket, f.owner, 'drawing', f.file, copyBackup)).toThrow();
  });
  it('retains the cancelled preparing slot through copy cleanup and refuses its final backup rename', async () => {
    let clock = 0; const f = await setup({ maxPending: 1, ttlMs: 5, now: () => clock }); await fs.writeFile(f.file, 'original'); await fs.writeFile(`${f.file}.bak`, 'prior backup');
    const ticket = await f.ticket(), gate = deferred(), entered = deferred();
    const preparing = f.host.prepare(ticket, f.owner, 'drawing', f.file, (ctx: PreparationContext) => copyBackup(ctx, async () => { entered.resolve(); await gate.promise; })); const rejected = expect(preparing).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED', committed: false }); await entered.promise;
    clock = 100; f.host.cancel(ticket, f.owner, 'drawing'); expect(() => f.host.issue(f.owner, 'drawing')).toThrowError(/Too many/); expect(f.host.stats().pending).toBe(1);
    gate.resolve(); await rejected; expect(f.host.stats().pending).toBe(0); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('prior backup'); expect(await fs.readdir(f.root)).toEqual(['file.dxf', 'file.dxf.bak']);
  });
  it('allows explicit Continue Without Backup after a copy failure and never marks the original saved', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); await fs.writeFile(`${f.file}.bak`, 'prior backup'); const ticket = await f.ticket();
    await expect(f.host.prepare(ticket, f.owner, 'drawing', f.file, async () => { throw Object.assign(new Error('Backup disk full'), { code: 'ENOSPC' }); })).rejects.toMatchObject({ code: 'ENOSPC', committed: false });
    expect(f.host.stats()).toMatchObject({ pending: 1, ledger: 0 }); expect(await fs.readFile(f.file, 'utf8')).toBe('original');
    expect((await f.run(ticket, f.file, async (scope) => scope.commit('continued explicitly', writeWithoutBackup))).status).toBe('saved'); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('prior backup');
  });
  it('does not adopt an outside edit observed during failed copy preparation or replace its backup', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); await fs.writeFile(`${f.file}.bak`, 'prior backup'); const ticket = await f.ticket();
    await expect(f.host.prepare(ticket, f.owner, 'drawing', f.file, (ctx: PreparationContext) => copyBackup(ctx, async () => { await fs.writeFile(f.file, 'external original edit'); }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(f.host.stats()).toMatchObject({ pending: 1, ledger: 0 }); expect(await fs.readFile(`${f.file}.bak`, 'utf8')).toBe('prior backup');
    await expect(f.run(ticket, f.file, async (scope) => scope.commit('stale edited drawing', writeWithoutBackup))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(await fs.readFile(f.file, 'utf8')).toBe('external original edit');
  });
  it('refuses a root junction retarget during copy and does not rename or clean up through the new root', async () => {
    const f = await setup(), inside = path.join(f.root, '\u0130'), outside = path.join(f.root, 'I\u0307'), picked = path.join(f.root, 'Picked');
    await fs.mkdir(inside); await fs.mkdir(outside); await fs.writeFile(path.join(inside, 'x.dxf'), 'inside original'); await fs.writeFile(path.join(outside, 'x.dxf'), 'outside original'); await fs.writeFile(path.join(outside, 'x.dxf.bak'), 'outside backup'); await fs.symlink(inside, picked, 'junction');
    const host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true, root: picked }) }); hosts.push(host);
    const ticket = host.issue(f.owner, 'drawing'), file = path.join(picked, 'x.dxf'); await host.bind(ticket, f.owner, 'drawing', file);
    await expect(host.prepare(ticket, f.owner, 'drawing', file, (ctx: PreparationContext) => copyBackup(ctx, async () => { await fs.unlink(picked); await fs.symlink(outside, picked, 'junction'); }))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(await fs.readFile(path.join(outside, 'x.dxf'), 'utf8')).toBe('outside original'); expect(await fs.readFile(path.join(outside, 'x.dxf.bak'), 'utf8')).toBe('outside backup'); expect(await fs.readdir(outside)).toEqual(['x.dxf', 'x.dxf.bak']);
    expect(await fs.readdir(inside)).toContain('x.dxf.backup-preparation.tmp');
  });
  it('checks current authorization before backup replacement and keeps a safely reusable ticket for a retry', async () => {
    let allowed = true; const f = await setup({ authorize: () => ({ allowed }) }); await fs.writeFile(f.file, 'original'); const ticket = await f.ticket();
    await expect(f.host.prepare(ticket, f.owner, 'drawing', f.file, (ctx: PreparationContext) => copyBackup(ctx, async () => { allowed = false; }))).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' });
    expect(await fs.readdir(f.root)).toEqual(['file.dxf']); allowed = true;
    expect((await f.host.prepare(ticket, f.owner, 'drawing', f.file, copyBackup)).status).toBe('prepared'); expect((await f.run(ticket, f.file, async (scope) => scope.commit('retry', writeWithoutBackup))).status).toBe('saved');
  });
  it('disposal joins preparing callback cleanup without releasing its reservation early', async () => {
    const f = await setup(); await fs.writeFile(f.file, 'original'); const ticket = await f.ticket(), gate = deferred(), entered = deferred();
    const preparing = f.host.prepare(ticket, f.owner, 'drawing', f.file, async (ctx: PreparationContext) => { entered.resolve(); await gate.promise; await ctx.guardParents(); await ctx.guard(); }); const rejected = expect(preparing).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await entered.promise;
    let settled = false; const disposing = f.host.dispose().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false); expect(f.host.stats().pending).toBe(1);
    gate.resolve(); await rejected; await disposing; expect(settled).toBe(true); expect(f.host.stats().pending).toBe(0); expect(await fs.readdir(f.root)).toEqual(['file.dxf']);
  });
});
