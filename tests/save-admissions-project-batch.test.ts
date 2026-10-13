import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWindowsPathIdentity } = require('../electron/windows-path-identity.cjs');
const { createSaveAdmissions, SAVE_ADMISSION_LIMITS } = require('../electron/save-admissions.cjs');
const { createAtomicWriter } = require('../electron/atomic-write.cjs');
const privateRoot = path.resolve('.codex-local/project-admission-tests'), roots: string[] = [], hosts: any[] = [];
type ReadScope = { pin: { logicalPath: string; canonicalPath: string; fileVersion: { size: string } }; inputBytes: number; signal: AbortSignal; guard(): Promise<void> };
type WriterContext = { destinationPath: string; canonicalPath: string; signal: AbortSignal; root?: string; guard(): Promise<void>; guardParents(): Promise<void>; markCommitted(): Promise<void> };
type SaveScope = { commit(data: string | Uint8Array, writer: (data: string | Uint8Array, ctx: WriterContext) => Promise<unknown>): Promise<unknown> };
type ManifestEntry = { index: number; path: string; childTicket?: string; identityPath?: string; exists?: true; missing?: true };
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function setup(count = 2, options: Record<string, unknown> = {}) {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const files = Array.from({ length: count }, (_, index) => path.join(root, `Source${index}.dxf`));
  await Promise.all(files.map((file, index) => fs.writeFile(file, `SOURCE${index}`)));
  const owner = {}, host = createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true, root }), ...options }); hosts.push(host);
  const issue = () => host.issueProjectBatch(owner) as string;
  const bind = (parent: string, paths = files) => host.bindProjectBatch(parent, owner, paths) as Promise<ManifestEntry[]>;
  const read = (parent: string, child: string, operation: (ctx: ReadScope) => Promise<unknown> = async (ctx) => fs.readFile(ctx.pin.logicalPath, 'utf8')) => host.readProjectBatch(parent, owner, child, operation);
  const ordinary = async (file = files[0], who = owner) => { const ticket = host.issue(who, 'drawing'); await host.bind(ticket, who, 'drawing', file); return ticket as string; };
  return { root, files, owner, host, issue, bind, read, ordinary };
}
const children = (manifest: ManifestEntry[]) => manifest.flatMap((entry) => entry.childTicket ? [entry.childTicket] : []);
async function nativeWrite(data: string | Uint8Array, ctx: WriterContext) {
  const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: () => ctx.guard() } });
  const result = await writer.atomicWriteFile(ctx.destinationPath, data, { root: ctx.root, backup: false });
  await ctx.markCommitted(); return result;
}
async function ready(f: Awaited<ReturnType<typeof setup>>, subset?: number[]) {
  const parent = f.issue(), manifest = await f.bind(parent), tickets = children(manifest);
  for (const child of tickets) await f.read(parent, child);
  const selected = subset ? subset.map((index) => tickets[index]) : tickets;
  await f.host.sealProjectBatch(parent, f.owner, selected);
  return { parent, manifest, tickets, selected };
}
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe private project admission cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('Bounded host project admission configuration', () => {
  it('exports fixed global bounds and rejects expansion or malformed limits', () => {
    expect(SAVE_ADMISSION_LIMITS).toMatchObject({ pending: 32, ledger: 640, batchParents: 2, batchChildren: 512, batchInputBytes: 128 * 1024 * 1024, batchPinChars: 16 * 1024 * 1024, batchHardLifeMs: 600000 });
    for (const [field, bad] of [['maxBatchParents', 3], ['maxBatchChildren', 513], ['maxBatchInputBytes', 128 * 1024 * 1024 + 1], ['maxBatchPinChars', 16 * 1024 * 1024 + 1], ['batchHardLifeMs', 600001], ['maxBatchParents', 0], ['maxBatchChildren', 1.5]]) expect(() => createSaveAdmissions({ identity: createWindowsPathIdentity(), authorize: () => ({ allowed: true }), [field!]: bad })).toThrow();
  });
  it('uses opaque main-owner parents, one per owner and at most two globally', async () => {
    const f = await setup(), parent = f.issue(), other = {}, third = {};
    expect(parent).toMatch(/^[0-9a-f]{48}$/); expect(() => f.issue()).toThrowError(/one project batch/);
    f.host.issueProjectBatch(other); expect(() => f.host.issueProjectBatch(third)).toThrow();
    expect(() => f.host.bindProjectBatch(parent, other, f.files)).toThrow();
    expect(() => f.host.bindProjectBatch('forged', f.owner, f.files)).toThrow();
    expect(() => f.host.issueProjectBatch('renderer-id')).toThrow();
    await f.host.cancelProjectBatch(parent, f.owner); expect(f.issue()).toMatch(/^[0-9a-f]{48}$/);
  });
  it('validates dense manifests and bounded declarations before filesystem inspection', async () => {
    const capture = vi.fn(), host = createSaveAdmissions({ identity: { captureWriteTarget: capture, revalidate: vi.fn() }, authorize: () => ({ allowed: true }) }); hosts.push(host);
    const owner = {}, parent = host.issueProjectBatch(owner);
    for (const paths of [new Array(1), new Array(513).fill('C:\\source.dxf'), ['relative.dxf'], [null]]) expect(() => host.bindProjectBatch(parent, owner, paths)).toThrow();
    expect(capture).not.toHaveBeenCalled(); expect(host.stats().batchChildren).toBe(0);
  });
  it('authorizes every logical source before native inspection and aborts the whole manifest', async () => {
    const capture = vi.fn(), host = createSaveAdmissions({ identity: { captureWriteTarget: capture, revalidate: vi.fn() }, authorize: () => ({ allowed: false }) }); hosts.push(host);
    const owner = {}, parent = host.issueProjectBatch(owner);
    await expect(host.bindProjectBatch(parent, owner, ['C:\\blocked.dxf'])).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' });
    expect(capture).not.toHaveBeenCalled(); expect(host.stats()).toMatchObject({ batchParents: 0, batchChildren: 0, batchInputBytes: 0, batchPinChars: 0 });
  });
});

describe.runIf(process.platform === 'win32')('Native project manifest and coherent source basis', () => {
  it('binds 65 idle children without consuming ordinary admission slots and reads each source once', async () => {
    const f = await setup(65), parent = f.issue(), manifest = await f.bind(parent), tickets = children(manifest);
    expect(tickets).toHaveLength(65); expect(Object.isFrozen(manifest)).toBe(true); expect(Object.isFrozen(manifest[0]!)).toBe(true);
    expect(f.host.stats()).toMatchObject({ pending: 0, batchChildren: 65, activeBatchOperations: 0 });
    expect(await f.read(parent, tickets[0]!, async (ctx) => { expect(Object.isFrozen(ctx.pin)).toBe(true); expect(ctx.inputBytes).toBe(7); return fs.readFile(ctx.pin.logicalPath, 'utf8'); })).toBe('SOURCE0');
    expect(() => f.read(parent, tickets[0]!)).toThrowError(/only once/);
    expect(() => f.host.sealProjectBatch(parent, f.owner, [tickets[1]!])).toThrowError(/read and bound/);
    await f.host.sealProjectBatch(parent, f.owner, [tickets[0]!]);
    expect(f.host.stats()).toMatchObject({ reservedTargets: 1, ledger: 0 });
    expect(() => f.read(parent, tickets[2]!)).toThrow();
  });
  it('caps idle declarations globally across two parents before creating excess pins', async () => {
    const f = await setup(2, { maxBatchChildren: 2 }), first = f.issue(); await f.bind(first);
    const other = {}, second = f.host.issueProjectBatch(other);
    expect(() => f.host.bindProjectBatch(second, other, [f.files[0]!])).toThrowError(/budget/);
    await f.host.cancelProjectBatch(first, f.owner); expect((await f.host.bindProjectBatch(second, other, [f.files[0]!])).length).toBe(1);
  });
  it('skips a missing source with an existing parent and never creates a writable child', async () => {
    const f = await setup(1), missing = path.join(f.root, 'Missing.dxf'), parent = f.issue(), manifest = await f.bind(parent, [missing, f.files[0]!]);
    expect(manifest[0]!).toEqual({ index: 0, path: missing, missing: true }); expect(children(manifest)).toHaveLength(1);
    await f.read(parent, children(manifest)[0]!); await f.host.sealProjectBatch(parent, f.owner, []); await f.host.beginProjectBatchCommit(parent, f.owner);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.host.stats().reservedTargets).toBe(0);
  });
  it('aborts a missing parent without returning a partial manifest or leaving child tickets', async () => {
    const f = await setup(1), parent = f.issue();
    await expect(f.bind(parent, [f.files[0]!, path.join(f.root, 'NoParent', 'x.dxf')])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.host.stats()).toMatchObject({ batchParents: 0, batchChildren: 0, pending: 0, batchInputBytes: 0 });
  });
  it('refuses duplicate existing native Unicode aliases and preserves distinct confusable files', async () => {
    const f = await setup(0), alias = path.join(f.root, '\u1f80.dxf'), folded = path.join(f.root, '\u1f88.dxf'); await fs.writeFile(alias, 'GREEK');
    await expect(f.bind(f.issue(), [alias, folded])).rejects.toMatchObject({ code: 'ERR_SAVE_BATCH_DUPLICATE' });
    const dotted = path.join(f.root, '\u0130.dxf'), combining = path.join(f.root, 'I\u0307.dxf'); await fs.writeFile(dotted, 'ONE'); await fs.writeFile(combining, 'TWO');
    const parent = f.issue(), manifest = await f.bind(parent, [dotted, combining]); expect(children(manifest)).toHaveLength(2); expect(manifest[0]!.identityPath).not.toBe(manifest[1]!.identityPath);
  });
  it('checks captured aggregate native sizes before reads or manifest publication', async () => {
    const f = await setup(2, { maxBatchInputBytes: 13 }), parent = f.issue();
    await expect(f.bind(parent)).rejects.toMatchObject({ code: 'ERR_SAVE_BATCH_LIMIT' });
    expect(f.host.stats()).toMatchObject({ batchInputBytes: 0, batchParents: 0 });
  });
  it('shares aggregate input and native-pin character budgets across parents', async () => {
    const f = await setup(2, { maxBatchInputBytes: 10 }), parent = f.issue(); await f.bind(parent, [f.files[0]!]);
    const other = {}, second = f.host.issueProjectBatch(other); await expect(f.host.bindProjectBatch(second, other, [f.files[1]!])).rejects.toMatchObject({ code: 'ERR_SAVE_BATCH_LIMIT' });
    const limited = await setup(1, { maxBatchPinChars: 100 }); await expect(limited.bind(limited.issue())).rejects.toMatchObject({ code: 'ERR_SAVE_BATCH_LIMIT' });
    expect(limited.host.stats().batchPinChars).toBe(0);
  });
  it.each(['edit', 'replace', 'case'])('refuses original source %s between manifest and held-reader allocation', async (change) => {
    const f = await setup(1), parent = f.issue(), manifest = await f.bind(parent), reader = vi.fn();
    if (change === 'edit') await fs.writeFile(f.files[0]!, 'EXTERNAL-EDIT');
    else if (change === 'replace') { await fs.rename(f.files[0]!, `${f.files[0]!}.old`); await fs.writeFile(f.files[0]!, 'REPLACEMENT'); }
    else await fs.rename(f.files[0]!, path.join(f.root, 'source0.dxf'));
    await expect(f.read(parent, children(manifest)[0]!, reader)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(reader).not.toHaveBeenCalled(); await Promise.resolve().then(() => f.host.cancelProjectBatch(parent, f.owner)).catch(() => {});
  });
  it('rechecks source and authorization after awaited decoding before returning bytes', async () => {
    const f = await setup(1), parent = f.issue(), manifest = await f.bind(parent);
    await expect(f.read(parent, children(manifest)[0]!, async (ctx) => { const bytes = await fs.readFile(ctx.pin.logicalPath); await fs.writeFile(f.files[0]!, 'AFTER-FD-READ'); return bytes; })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
  });
  it('rejects an earlier legitimate host write as a changed calculation basis', async () => {
    const f = await setup(1), older = await f.ordinary(), parent = f.issue(), manifest = await f.bind(parent);
    await f.host.run(older, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('HOST-OLDER', nativeWrite));
    const reader = vi.fn(); await expect(f.read(parent, children(manifest)[0]!, reader)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(reader).not.toHaveBeenCalled();
  });
  it('rechecks an early pin before publishing a late-bound manifest', async () => {
    const f = await setup(2), base = createWindowsPathIdentity(); let captureCount = 0;
    const host = createSaveAdmissions({ identity: { ...base, captureWriteTarget: async (file: string, root: string) => { const pin = await base.captureWriteTarget(file, root); if (++captureCount === 2) await fs.writeFile(f.files[0]!, 'EDITED-DURING-BIND'); return pin; } }, authorize: () => ({ allowed: true, root: f.root }) }); hosts.push(host);
    await expect(host.bindProjectBatch(host.issueProjectBatch(f.owner), f.owner, f.files)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(host.stats().batchParents).toBe(0);
  });
  it('rejects a native logical-parent junction retarget before reading another confusable directory', async () => {
    const f = await setup(0), inside = path.join(f.root, '\u0130'), outside = path.join(f.root, 'I\u0307'), picked = path.join(f.root, 'Picked');
    await fs.mkdir(inside); await fs.mkdir(outside); await fs.writeFile(path.join(inside, 'Case.dxf'), 'INSIDE'); await fs.writeFile(path.join(outside, 'Case.dxf'), 'OUTSIDE'); await fs.symlink(inside, picked, 'junction');
    const parent = f.issue(), manifest = await f.bind(parent, [path.join(picked, 'case.dxf')]); expect(manifest[0]!.identityPath).toBe(path.join(inside, 'Case.dxf'));
    await fs.unlink(picked); await fs.symlink(outside, picked, 'junction'); const reader = vi.fn();
    await expect(f.read(parent, children(manifest)[0]!, reader)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(reader).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, 'Case.dxf'), 'utf8')).toBe('OUTSIDE');
  });
  it('refuses source authorization scope changes without handing a private pin to the reader', async () => {
    let allowed = true; const f = await setup(1, { authorize: () => ({ allowed }) }), parent = f.issue(), manifest = await f.bind(parent), reader = vi.fn(); allowed = false;
    await expect(f.read(parent, children(manifest)[0]!, reader)).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' }); expect(reader).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'win32')('Native batch capacity, phase and ordering', () => {
  it('supports an empty native manifest while retaining a pre-producer parent for open drawings', async () => {
    const f = await setup(0), parent = f.issue(); expect(await f.bind(parent)).toEqual([]);
    await f.host.sealProjectBatch(parent, f.owner, []); await f.host.beginProjectBatchCommit(parent, f.owner); await f.host.cancelProjectBatch(parent, f.owner);
    expect(f.host.stats()).toMatchObject({ batchParents: 0, batchChildren: 0, reservedTargets: 0 });
  });
  it('checks unchanged read sources as calculation inputs while reserving only changed targets', async () => {
    const f = await setup(2), batch = await ready(f, [0]); expect(f.host.stats().reservedTargets).toBe(1);
    await fs.writeFile(f.files[1]!, 'CHANGED-UNCHANGED-SOURCE');
    await expect(f.host.beginProjectBatchCommit(batch.parent, f.owner)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('SOURCE0');
  });
  it('retains a declined write child as immutable read basis without treating its cancellation as a source change', async () => {
    const f = await setup(2), batch = await ready(f); f.host.cancel(batch.tickets[1]!, f.owner, 'drawing');
    await f.host.beginProjectBatchCommit(batch.parent, f.owner, [batch.tickets[0]!]); expect(f.host.stats().reservedTargets).toBe(1);
    expect((await f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('ONE-TARGET', nativeWrite))).status).toBe('saved');
  });
  it('checks an individually cancelled read child when sealing selected outputs', async () => {
    const f = await setup(2), parent = f.issue(), manifest = await f.bind(parent), tickets = children(manifest);
    for (const child of tickets) await f.read(parent, child); f.host.cancel(tickets[1]!, f.owner, 'drawing'); await fs.writeFile(f.files[1]!, 'EDITED-CANCELLED-SOURCE');
    await expect(f.host.sealProjectBatch(parent, f.owner, [tickets[0]!])).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(f.host.stats().reservedTargets).toBe(0);
  });
  it('does not pin unrelated ordinary write history after its native manifest is fixed', async () => {
    const f = await setup(8, { maxLedger: 2 }), parent = f.issue(), manifest = await f.bind(parent, [f.files[0]!]); await f.read(parent, children(manifest)[0]!); await f.host.sealProjectBatch(parent, f.owner, children(manifest));
    for (const file of f.files.slice(1)) {
      const ticket = await f.ordinary(file); expect((await f.host.run(ticket, f.owner, 'drawing', file, async (scope: SaveScope) => scope.commit('UNRELATED', nativeWrite))).status).toBe('saved');
      expect(f.host.stats()).toMatchObject({ ledger: 0, reservedTargets: 1, orderingSlots: 1 });
    }
    const newer = await f.ordinary(f.files[0]!); await f.host.run(newer, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('RELATED-NEWER', nativeWrite));
    expect(f.host.stats().ledger).toBe(1); await expect(f.host.beginProjectBatchCommit(parent, f.owner)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
  });
  it('refuses premature backup/write without consuming a child, then performs native backup and save', async () => {
    const f = await setup(1), parent = f.issue(), manifest = await f.bind(parent), child = children(manifest)[0]!, writer = vi.fn(nativeWrite);
    expect(() => f.host.run(child, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('PREMATURE', writer))).toThrowError(/preflight/);
    expect(() => f.host.prepare(child, f.owner, 'drawing', f.files[0]!, async () => {})).toThrowError(/sealed/);
    await f.read(parent, child); await f.host.sealProjectBatch(parent, f.owner, [child]);
    await f.host.prepare(child, f.owner, 'drawing', f.files[0]!, async (ctx: WriterContext) => { await ctx.guard(); await fs.copyFile(ctx.destinationPath, `${ctx.destinationPath}.bak`); await ctx.guard(); });
    expect(await fs.readFile(`${f.files[0]!}.bak`, 'utf8')).toBe('SOURCE0'); expect(f.host.stats().ledger).toBe(0);
    await f.host.beginProjectBatchCommit(parent, f.owner);
    expect((await f.host.run(child, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('SAVED', writer))).status).toBe('saved'); expect(writer).toHaveBeenCalledOnce();
    await f.host.cancelProjectBatch(parent, f.owner); expect(f.host.stats()).toMatchObject({ batchParents: 0, reservedTargets: 0, batchInputBytes: 0 });
  });
  it('seals all selected ledger capacity atomically without publishing attempted order', async () => {
    const f = await setup(2, { maxLedger: 1 }), parent = f.issue(), manifest = await f.bind(parent), tickets = children(manifest);
    for (const ticket of tickets) await f.read(parent, ticket);
    await expect(f.host.sealProjectBatch(parent, f.owner, tickets)).rejects.toMatchObject({ code: 'ERR_SAVE_LEDGER_LIMIT' }); expect(f.host.stats()).toMatchObject({ reservedTargets: 0, ledger: 0 });
    await f.host.sealProjectBatch(parent, f.owner, [tickets[0]!]); expect(f.host.stats()).toMatchObject({ reservedTargets: 1, ledger: 0, orderingSlots: 1 });
  });
  it('reserves capacity against unrelated ordinary writes and releases declined children at final preflight', async () => {
    const f = await setup(3, { maxLedger: 2 }), batch = await ready(f, [0, 1]), extra = await f.ordinary(f.files[2]!);
    const writer = vi.fn(nativeWrite); await expect(f.host.run(extra, f.owner, 'drawing', f.files[2]!, async (scope: SaveScope) => scope.commit('ORDINARY', writer))).rejects.toMatchObject({ code: 'ERR_SAVE_LEDGER_LIMIT' }); expect(writer).not.toHaveBeenCalled();
    await f.host.beginProjectBatchCommit(batch.parent, f.owner, [batch.tickets[0]!]); expect(f.host.stats().reservedTargets).toBe(1);
    expect(() => f.host.run(batch.tickets[1]!, f.owner, 'drawing', f.files[1]!, async () => {})).toThrow();
    const retry = await f.ordinary(f.files[2]!); expect((await f.host.run(retry, f.owner, 'drawing', f.files[2]!, async (scope: SaveScope) => scope.commit('ORDINARY', nativeWrite))).status).toBe('saved');
  });
  it('an aborted unwritten newer seal does not suppress an older valid save', async () => {
    const f = await setup(1), old = await f.ordinary(), batch = await ready(f);
    expect(f.host.stats().ledger).toBe(0); await f.host.cancelProjectBatch(batch.parent, f.owner);
    expect((await f.host.run(old, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('OLD-STILL-VALID', nativeWrite))).status).toBe('saved');
  });
  it('retains newer ordering records while an earlier parent has not bound any paths', async () => {
    const f = await setup(1), parent = f.issue(), newer = await f.ordinary();
    await f.host.run(newer, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('NEWER', nativeWrite)); expect(f.host.stats().ledger).toBe(1);
    await expect(f.bind(parent)).rejects.toMatchObject({ code: 'ERR_SAVE_STALE' }); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('NEWER');
  });
  it('refuses final preflight after a newer ordinary save without altering selected sources', async () => {
    const f = await setup(2), batch = await ready(f), newer = await f.ordinary(f.files[1]!);
    await f.host.run(newer, f.owner, 'drawing', f.files[1]!, async (scope: SaveScope) => scope.commit('NEWER', nativeWrite));
    await expect(f.host.beginProjectBatchCommit(batch.parent, f.owner)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('SOURCE0');
  });
  it('inherits the parent order so a slow batch producer cannot overwrite a later ordinary save', async () => {
    const f = await setup(1), batch = await ready(f); await f.host.beginProjectBatchCommit(batch.parent, f.owner);
    const gate = deferred(), entered = deferred(); const slow = f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => { entered.resolve(); await gate.promise; return scope.commit('OLD-BATCH', nativeWrite); }); await entered.promise;
    const newer = await f.ordinary(); await f.host.run(newer, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('NEWER', nativeWrite)); gate.resolve();
    expect(await slow).toEqual({ status: 'stale', committed: false }); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('NEWER');
  });
  it('allows this parent’s proven earlier output while refusing a late unchanged-source edit before the next writer', async () => {
    const f = await setup(3), batch = await ready(f, [0, 1]); await f.host.beginProjectBatchCommit(batch.parent, f.owner);
    expect((await f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('OUTPUT0', nativeWrite))).status).toBe('saved');
    await fs.writeFile(f.files[2]!, 'LATE-EXTERNAL'); const writer = vi.fn(nativeWrite);
    await expect(f.host.run(batch.tickets[1]!, f.owner, 'drawing', f.files[1]!, async (scope: SaveScope) => scope.commit('OUTPUT1', writer))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false });
    expect(writer).not.toHaveBeenCalled(); expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('OUTPUT0'); expect(await fs.readFile(f.files[1]!, 'utf8')).toBe('SOURCE1');
  });
  it('accepts earlier committed same-parent source transitions for subsequent output guards', async () => {
    const f = await setup(2), batch = await ready(f); await f.host.beginProjectBatchCommit(batch.parent, f.owner);
    for (const index of [0, 1]) expect((await f.host.run(batch.tickets[index], f.owner, 'drawing', f.files[index], async (scope: SaveScope) => scope.commit(`OUTPUT${index}`, nativeWrite))).status).toBe('saved');
    expect(await fs.readFile(f.files[1]!, 'utf8')).toBe('OUTPUT1');
  });
  it('serializes parent callbacks outside different native directory queues until their commit proof is recorded', async () => {
    const f = await setup(0); for (const name of ['A', 'B']) { const folder = path.join(f.root, name); await fs.mkdir(folder); const file = path.join(folder, 'Source.dxf'); await fs.writeFile(file, 'SOURCE'); f.files.push(file); }
    const batch = await ready(f); await f.host.beginProjectBatchCommit(batch.parent, f.owner); const gap = deferred(), renamed = deferred(), second = vi.fn(nativeWrite);
    const first = f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('FIRST', async (data, ctx) => { await ctx.guard(); await fs.writeFile(ctx.destinationPath, data); renamed.resolve(); await gap.promise; await ctx.markCommitted(); return 'FIRST'; })); await renamed.promise;
    const later = f.host.run(batch.tickets[1]!, f.owner, 'drawing', f.files[1]!, async (scope: SaveScope) => scope.commit('SECOND', second)); await Promise.resolve(); await Promise.resolve();
    expect(second).not.toHaveBeenCalled(); expect(f.host.stats().activeBatchOperations).toBe(2); gap.resolve(); expect((await first).status).toBe('saved'); expect((await later).status).toBe('saved'); expect(second).toHaveBeenCalledOnce();
  });
  it('never treats an unmarked failed parent output as a proven source transition', async () => {
    const f = await setup(2), batch = await ready(f); await f.host.beginProjectBatchCommit(batch.parent, f.owner);
    await expect(f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('UNCERTAIN', async (data, ctx) => { await ctx.guard(); await fs.writeFile(ctx.destinationPath, data); throw new Error('Before commit proof'); }))).rejects.toMatchObject({ committed: false });
    const writer = vi.fn(nativeWrite); await expect(f.host.run(batch.tickets[1]!, f.owner, 'drawing', f.files[1]!, async (scope: SaveScope) => scope.commit('SECOND', writer))).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false }); expect(writer).not.toHaveBeenCalled();
  });
  it('refuses late basis changes before backup replacement and preserves the existing backup', async () => {
    const f = await setup(2), batch = await ready(f, [0]); await fs.writeFile(`${f.files[0]!}.bak`, 'OLD-BACKUP');
    const copy = vi.fn(); await fs.writeFile(f.files[1]!, 'LATE-SOURCE');
    await expect(f.host.prepare(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, copy)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(copy).not.toHaveBeenCalled(); expect(await fs.readFile(`${f.files[0]!}.bak`, 'utf8')).toBe('OLD-BACKUP');
  });
  it('supports all 512 bounded idle children and rejects a 513th declaration', async () => {
    const f = await setup(512), parent = f.issue(), manifest = await f.bind(parent); expect(children(manifest)).toHaveLength(512); expect(f.host.stats().batchChildren).toBe(512);
    const other = {}, otherParent = f.host.issueProjectBatch(other); expect(() => f.host.bindProjectBatch(otherParent, other, [f.files[0]!])).toThrowError(/budget/);
    await f.read(parent, children(manifest)[0]!); await f.host.sealProjectBatch(parent, f.owner, [children(manifest)[0]!]); expect(f.host.stats()).toMatchObject({ reservedTargets: 1, ledger: 0 });
  });
});

describe.runIf(process.platform === 'win32')('Batch cleanup, cancellation and shared operation bounds', () => {
  it('joins every started metadata check in a failing eight-source chunk before releasing preparation', async () => {
    const f = await setup(9), base = createWindowsPathIdentity(), gate = deferred(), entered = deferred(); let checking = false, calls = 0, settled = false;
    const host = createSaveAdmissions({ identity: { ...base, revalidate: async (pin: ReadScope['pin'], options: unknown) => {
      if (checking) { if (++calls === 8) entered.resolve(); if (pin.logicalPath === f.files[0]) throw Object.assign(new Error('Synthetic metadata failure'), { code: 'ERR_TEST_METADATA' }); await gate.promise; }
      return base.revalidate(pin, options);
    } }, authorize: () => ({ allowed: true, root: f.root }) }); hosts.push(host);
    const parent = host.issueProjectBatch(f.owner), manifest = await host.bindProjectBatch(parent, f.owner, f.files), tickets = children(manifest);
    for (const ticket of tickets) await host.readProjectBatch(parent, f.owner, ticket, async () => 'READ'); checking = true;
    const seal = host.sealProjectBatch(parent, f.owner, tickets), rejected = expect(seal).rejects.toMatchObject({ code: 'ERR_TEST_METADATA' }); void seal.then(() => { settled = true; }, () => { settled = true; }); await entered.promise;
    try { expect(settled).toBe(false); expect(host.stats().metadataActive).toBeGreaterThan(0); expect(host.stats().metadataActive).toBeLessThanOrEqual(8); expect(host.stats().activeBatchOperations).toBe(1); expect(calls).toBe(8); }
    finally { gate.resolve(); await rejected; }
    expect(host.stats()).toMatchObject({ metadataActive: 0, metadataQueued: 0, activeBatchOperations: 0, reservedTargets: 0 }); expect(calls).toBe(8);
  });
  it('shares eight metadata slots across two parents and retains waiting work through cancellation', async () => {
    const f = await setup(16), base = createWindowsPathIdentity(), gate = deferred(), entered = deferred(); let checking = false, active = 0, maximum = 0, starts = 0;
    const host = createSaveAdmissions({ identity: { ...base, revalidate: async (pin: ReadScope['pin'], options: unknown) => {
      if (!checking) return base.revalidate(pin, options);
      active++; maximum = Math.max(maximum, active); if (++starts === 8) entered.resolve();
      try { await gate.promise; return await base.revalidate(pin, options); } finally { active--; }
    } }, authorize: () => ({ allowed: true, root: f.root }) }); hosts.push(host);
    const secondOwner = {}, first = host.issueProjectBatch(f.owner), second = host.issueProjectBatch(secondOwner);
    const a = await host.bindProjectBatch(first, f.owner, f.files.slice(0, 8)), b = await host.bindProjectBatch(second, secondOwner, f.files.slice(8)); checking = true;
    const reads = [...children(a).map((child) => host.readProjectBatch(first, f.owner, child, async () => 'FIRST')), ...children(b).map((child) => host.readProjectBatch(second, secondOwner, child, async () => 'SECOND'))];
    const results = Promise.allSettled(reads); await entered.promise; expect(host.stats()).toMatchObject({ metadataActive: 8, metadataQueued: 8, activeBatchOperations: 16 });
    const cancelling = host.cancelProjectBatch(first, f.owner); gate.resolve(); const outcomes = await results; await cancelling;
    expect(outcomes.slice(0, 8).every((entry) => entry.status === 'rejected')).toBe(true); expect(outcomes.slice(8).every((entry) => entry.status === 'fulfilled')).toBe(true); expect(maximum).toBe(8);
    expect(host.stats()).toMatchObject({ metadataActive: 0, metadataQueued: 0, activeBatchOperations: 0, batchParents: 1 });
  });
  it('keeps cancelled reads occupying shared slots and pins until callback cleanup settles', async () => {
    const f = await setup(2, { maxPending: 1 }), parent = f.issue(), manifest = await f.bind(parent), tickets = children(manifest), gate = deferred(), entered = deferred();
    const read = f.read(parent, tickets[0]!, async () => { entered.resolve(); await gate.promise; return 'DELAYED'; }); const rejected = expect(read).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await entered.promise;
    expect(() => f.read(parent, tickets[1]!)).toThrowError(/active/); expect(() => f.host.issue({}, 'drawing')).toThrowError(/pending/);
    const cancelling = f.host.cancelProjectBatch(parent, f.owner); expect(f.host.stats()).toMatchObject({ batchParents: 1, batchChildren: 2, activeBatchOperations: 1 }); gate.resolve(); await rejected; await cancelling;
    expect(f.host.stats()).toMatchObject({ batchParents: 0, batchChildren: 0, activeBatchOperations: 0, batchInputBytes: 0 }); expect(f.host.issue({}, 'drawing')).toMatch(/^[0-9a-f]{48}$/);
  });
  it('shares active-operation capacity with issued ordinary saves before native binding', async () => {
    const f = await setup(1, { maxPending: 1 }), ordinaryOwner = {}, ordinary = f.host.issue(ordinaryOwner, 'drawing'), parent = f.issue();
    expect(() => f.bind(parent)).toThrowError(/active/); f.host.cancel(ordinary, ordinaryOwner, 'drawing'); expect(children(await f.bind(parent))).toHaveLength(1);
  });
  it('does not expire an actively claimed read at idle TTL and refreshes after it completes', async () => {
    let clock = 0; const f = await setup(1, { now: () => clock, ttlMs: 5, batchHardLifeMs: 100 }), parent = f.issue(), manifest = await f.bind(parent), gate = deferred(), entered = deferred();
    const read = f.read(parent, children(manifest)[0]!, async () => { entered.resolve(); await gate.promise; return 'VALUE'; }); await entered.promise; clock = 20;
    const ordinaryOwner = {}, ordinary = f.host.issue(ordinaryOwner, 'drawing'); f.host.cancel(ordinary, ordinaryOwner, 'drawing'); expect(f.host.stats().batchParents).toBe(1);
    gate.resolve(); expect(await read).toBe('VALUE'); await f.host.sealProjectBatch(parent, f.owner, children(manifest));
  });
  it('aborts hard-expired claimed work but retains its cleanup and rejects new owner batches meanwhile', async () => {
    let clock = 0; const f = await setup(1, { now: () => clock, ttlMs: 5, batchHardLifeMs: 10 }), parent = f.issue(), manifest = await f.bind(parent), gate = deferred(), entered = deferred();
    const read = f.read(parent, children(manifest)[0]!, async () => { entered.resolve(); await gate.promise; return 'LATE'; }); const rejected = expect(read).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await entered.promise; clock = 11;
    expect(() => f.issue()).toThrow(); expect(f.host.stats().batchParents).toBe(1); gate.resolve(); await rejected; await Promise.resolve().then(() => f.host.cancelProjectBatch(parent, f.owner)).catch(() => {}); expect(f.issue()).toMatch(/^[0-9a-f]{48}$/);
  });
  it('joins post-commit cancellation and retains the actual saved result', async () => {
    const f = await setup(1), batch = await ready(f); await f.host.beginProjectBatchCommit(batch.parent, f.owner);
    const gate = deferred(), renamed = deferred(); const saving = f.host.run(batch.tickets[0]!, f.owner, 'drawing', f.files[0]!, async (scope: SaveScope) => scope.commit('DURABLE', async (data, ctx) => { const result = await nativeWrite(data, ctx); renamed.resolve(); await gate.promise; return result; })); await renamed.promise;
    const cancelling = f.host.cancelProjectBatch(batch.parent, f.owner); expect(f.host.stats().activeBatchOperations).toBe(1); gate.resolve(); expect(await saving).toMatchObject({ status: 'saved', committed: true, cancelledAfterCommit: true }); await cancelling; expect(await fs.readFile(f.files[0]!, 'utf8')).toBe('DURABLE');
  });
  it('retirement and disposal abort source callbacks without freeing capacity prematurely', async () => {
    const f = await setup(1), parent = f.issue(), manifest = await f.bind(parent), gate = deferred(), entered = deferred();
    const read = f.read(parent, children(manifest)[0]!, async () => { entered.resolve(); await gate.promise; return 'LATE'; }); const rejected = expect(read).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); await entered.promise;
    f.host.retireOwner(f.owner); const disposing = f.host.dispose(); expect(f.host.stats()).toMatchObject({ batchParents: 1, activeBatchOperations: 1 }); gate.resolve(); await rejected; await disposing; expect(f.host.stats()).toMatchObject({ batchParents: 0, activeBatchOperations: 0 });
  });
  it('rejects active-read reuse, forged children and transferring them between parent owners', async () => {
    const f = await setup(1), parent = f.issue(), manifest = await f.bind(parent), child = children(manifest)[0]!, gate = deferred(), entered = deferred();
    expect(() => f.host.readProjectBatch(parent, {}, child, async () => {})).toThrow(); expect(() => f.read(parent, 'forged')).toThrow();
    const reading = f.read(parent, child, async () => { entered.resolve(); await gate.promise; }); await entered.promise; expect(() => f.read(parent, child)).toThrow(); expect(() => f.host.sealProjectBatch(parent, f.owner, [child])).toThrow(); gate.resolve(); await reading;
  });
  it('retains binding reservations through cancellation until asynchronous authorization settles', async () => {
    const gate = deferred<{ allowed: false }>(), f = await setup(1, { authorize: () => gate.promise }), parent = f.issue(); const binding = f.bind(parent), rejected = expect(binding).rejects.toMatchObject({ code: 'ERR_SAVE_AUTHORIZATION' });
    const cancelling = f.host.cancelProjectBatch(parent, f.owner); expect(f.host.stats()).toMatchObject({ batchParents: 1, batchChildren: 1, activeBatchOperations: 1 }); expect(() => f.issue()).toThrow();
    gate.resolve({ allowed: false }); await rejected; await cancelling; expect(f.host.stats()).toMatchObject({ batchParents: 0, activeBatchOperations: 0, batchPinChars: 0 });
  });
});
