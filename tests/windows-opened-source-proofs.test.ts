import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOpenedSourceProofs, OPENED_SOURCE_LIMITS, OPENED_SOURCE_RESERVED_CHARS } = require('../electron/opened-source-proofs.cjs');
const { createWindowsPathIdentity, coherentFileDigest } = require('../electron/windows-path-identity.cjs');
const { createSaveAdmissions, verifiedCommitTarget } = require('../electron/save-admissions.cjs');
const { createAtomicWriter } = require('../electron/atomic-write.cjs');
const roots: string[] = [], registries: any[] = [], hosts: any[] = [], privateRoot = path.resolve('.codex-local/opened-source-tests');
const evidence = { canonicalPath: 'C:\\Drawings\\Original.dxf', fileVersion: { dev: '1', ino: '2', size: '8', mtimeNs: '10', ctimeNs: '11', sha256: 'a'.repeat(64) } };
function registry(options: Record<string, unknown> = {}) { const proofs = createOpenedSourceProofs(options); registries.push(proofs); return proofs; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function complete(proofs: any, owner: object, logicalPath = evidence.canonicalPath, data = evidence) { return proofs.completeRead(proofs.reserve(owner, logicalPath), owner, data) as string; }
async function fixture(options: Record<string, unknown> = {}) {
  await fs.mkdir(privateRoot, { recursive: true }); const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const file = path.join(root, 'Original.dxf'), copy = path.join(root, 'Copy.dxf'); await fs.writeFile(file, 'ORIGINAL');
  const owner = {}, proofs = registry(options), identity = createWindowsPathIdentity();
  const host = createSaveAdmissions({ identity, authorize: () => ({ allowed: true, root }) }); hosts.push(host);
  const read = async (who = owner) => { const reservation = proofs.reserve(who, file), read = await coherentFileDigest(file); return proofs.completeRead(reservation, who, { canonicalPath: read.canonicalPath, fileVersion: { ...read.version, sha256: read.sha256 } }) as string; };
  return { root, file, copy, owner, proofs, identity, host, read };
}
type WriterContext = { destinationPath: string; root?: string; guard(): Promise<void>; markCommitted(): Promise<void> };
type SaveScope = { commit(bytes: string | Uint8Array, writer: (bytes: string | Uint8Array, ctx: WriterContext) => Promise<unknown>): Promise<unknown> };
async function atomic(bytes: string | Uint8Array, ctx: WriterContext) { const writer = createAtomicWriter(undefined, { hooks: { beforeAttempt: ctx.guard } }); await writer.atomicWriteFile(ctx.destinationPath, bytes, { root: ctx.root, backup: false }); await ctx.markCommitted(); }
async function bindSource(f: Awaited<ReturnType<typeof fixture>>, token: string, target = f.file, mode = 'in-place', who = f.owner) {
  const lease = f.proofs.borrow(who, token), reservation = f.proofs.reserve(who, target, lease, mode), ticket = f.host.issue(who, 'drawing');
  let replacement: string | undefined, relation: 'source' | 'copy' | undefined;
  const finish = vi.fn(() => { f.proofs.releaseBorrow(lease); f.proofs.cancelReservation(reservation, who); });
  const validate = vi.fn((pin: any) => { relation = f.proofs.validateDestination(lease, who, pin, mode); });
  const verified = vi.fn((proof: any) => { replacement = f.proofs.completeCommit(reservation, who, proof, relation); });
  await f.host.bind(ticket, who, 'drawing', target, { validateSource: validate, onVerifiedCommit: verified, onFinish: finish });
  return { ticket, lease, reservation, finish, validate, verified, replacement: () => replacement, relation: () => relation };
}
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map((host) => host.dispose())); for (const proofs of registries.splice(0)) proofs.dispose();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe opened-source cleanup'); await fs.rm(root, { recursive: true, force: true }); }
});

describe('Bounded opaque main-owned opened-source proofs', () => {
  it('reserves capacity before evidence copies and exposes only opaque owner-bound handles', () => {
    const proofs = registry({ maxProofs: 2, maxPerOwner: 2, maxPending: 1 }), owner = {}, other = {}, reservation = proofs.reserve(owner, evidence.canonicalPath);
    expect(Object.isFrozen(reservation)).toBe(true); expect(Object.keys(reservation)).toEqual([]); expect(proofs.stats()).toMatchObject({ records: 1, pending: 1, chars: OPENED_SOURCE_RESERVED_CHARS });
    expect(() => proofs.reserve(owner, evidence.canonicalPath)).toThrow(/capacity/);
    expect(() => proofs.completeRead(reservation, other, evidence)).toThrow(); expect(() => proofs.completeRead({}, owner, evidence)).toThrow();
    const token = proofs.completeRead(reservation, owner, evidence); expect(token).toMatch(/^[0-9a-f]{48}$/); expect(proofs.stats().pending).toBe(0);
    expect(() => proofs.borrow(other, token)).toThrow(); expect(() => proofs.borrow(owner, 'guessed')).toThrow(); expect(() => proofs.completeRead(reservation, owner, evidence)).toThrow();
    expect(proofs.release(token, owner)).toBe(true); expect(proofs.release(token, owner)).toBe(false); expect(proofs.stats()).toMatchObject({ records: 0, chars: 0 });
  });
  it('retains released borrowed evidence until joined cleanup, without live-token refresh', () => {
    const proofs = registry({ maxProofs: 1, maxPerOwner: 1 }), owner = {}, token = complete(proofs, owner), lease = proofs.borrow(owner, token);
    expect(proofs.release(token, owner)).toBe(true); expect(() => proofs.borrow(owner, token)).toThrow(); expect(proofs.stats()).toMatchObject({ records: 1, liveProofs: 0, borrowed: 1 });
    const pin = { logicalPath: evidence.canonicalPath, canonicalPath: evidence.canonicalPath, hashContent: true, exists: true, fileVersion: evidence.fileVersion };
    expect(proofs.validateDestination(lease, owner, pin)).toBe('source'); expect(() => proofs.reserve(owner, evidence.canonicalPath)).toThrow(/capacity/);
    expect(proofs.releaseBorrow(lease)).toBe(true); expect(proofs.releaseBorrow(lease)).toBe(false); expect(() => proofs.validateDestination(lease, owner, pin)).toThrow(); expect(proofs.stats().records).toBe(0);
  });
  it('copies only bounded immutable completed evidence and rejects missing/malformed digests', () => {
    const proofs = registry(), owner = {}, source = { ...evidence, fileVersion: { ...evidence.fileVersion } }, reservation = proofs.reserve(owner, evidence.canonicalPath);
    for (const fileVersion of [{ ...source.fileVersion, sha256: undefined }, { ...source.fileVersion, size: '-1' }, { ...source.fileVersion, size: String(128 * 1024 * 1024 + 1) }, { ...source.fileVersion, ino: '2'.repeat(25) }, { ...source.fileVersion, mtimeNs: 'NaN' }]) expect(() => proofs.completeRead(reservation, owner, { ...source, fileVersion })).toThrow();
    const token = proofs.completeRead(reservation, owner, source); source.fileVersion.sha256 = 'b'.repeat(64); source.canonicalPath = 'C:\\External.dxf';
    const lease = proofs.borrow(owner, token); expect(lease.source.canonicalPath).toBe(evidence.canonicalPath); expect(lease.source.fileVersion.sha256).toBe(evidence.fileVersion.sha256); expect(Object.isFrozen(lease.source)).toBe(true); expect(Object.isFrozen(lease.source.fileVersion)).toBe(true); proofs.releaseBorrow(lease);
  });
  it('refuses owner retirement immediately while retaining borrowed reservations through cleanup', () => {
    const proofs = registry(), owner = {}, token = complete(proofs, owner), lease = proofs.borrow(owner, token), reservation = proofs.reserve(owner, evidence.canonicalPath, lease);
    proofs.retireOwner(owner); expect(() => proofs.borrow(owner, token)).toThrow(); expect(() => proofs.completeRead(reservation, owner, evidence)).toThrow();
    expect(proofs.stats()).toMatchObject({ records: 2, borrowed: 1, liveProofs: 0, pending: 1 }); proofs.releaseBorrow(lease); expect(proofs.stats().records).toBe(2);
    proofs.cancelReservation(reservation, owner); expect(proofs.stats()).toMatchObject({ records: 0, pending: 0, chars: 0, borrowed: 0 });
  });
  it('enforces record/owner/character caps without evicting a live source', () => {
    expect(OPENED_SOURCE_LIMITS).toEqual({ proofs: 256, perOwner: 128, pending: 32, chars: 4 * 1024 * 1024 });
    for (const option of [{ maxProofs: 257 }, { maxPerOwner: 129 }, { maxPending: 33 }, { maxChars: 4 * 1024 * 1024 + 1 }, { maxPending: 0 }]) expect(() => registry(option)).toThrow();
    const proofs = registry({ maxProofs: 2, maxPerOwner: 1, maxChars: OPENED_SOURCE_RESERVED_CHARS * 2 }), a = {}, b = {}, c = {};
    const token = complete(proofs, a); expect(() => proofs.reserve(a, evidence.canonicalPath)).toThrow(/capacity/); const other = complete(proofs, b);
    expect(() => proofs.reserve(c, evidence.canonicalPath)).toThrow(/capacity/); const lease = proofs.borrow(a, token); expect(lease.source.fileVersion.sha256).toBe(evidence.fileVersion.sha256); proofs.releaseBorrow(lease);
    proofs.release(other, b); expect(proofs.reserve(c, evidence.canonicalPath)).toBeDefined();
    const small = registry({ maxChars: OPENED_SOURCE_RESERVED_CHARS - 1 }); expect(() => small.reserve(a, evidence.canonicalPath)).toThrow(/capacity/); expect(small.stats().records).toBe(0);
  });
  it('never accepts caller-authored or cloned commit evidence', () => {
    const proofs = registry(), owner = {}, reservation = proofs.reserve(owner, evidence.canonicalPath);
    expect(verifiedCommitTarget({ target: evidence }, owner)).toBeNull(); expect(() => proofs.completeCommit(reservation, owner, { target: evidence })).toThrow();
    proofs.cancelReservation(reservation, owner); expect(proofs.stats().records).toBe(0);
  });
  it('does not recycle retired pending-read capacity until its caller joins cleanup', () => {
    const proofs = registry({ maxPending: 1 }), owner = {}, reservation = proofs.reserve(owner, evidence.canonicalPath);
    proofs.retireOwner(owner); expect(() => proofs.completeRead(reservation, owner, evidence)).toThrow(); expect(proofs.stats()).toMatchObject({ records: 1, pending: 1 });
    expect(() => proofs.reserve({}, evidence.canonicalPath)).toThrow(/capacity/); proofs.cancelReservation(reservation, owner); expect(proofs.reserve({}, evidence.canonicalPath)).toBeDefined();
  });
});

describe.runIf(process.platform === 'win32')('Native opened-byte source validation and verified own-save lineage', () => {
  it('refuses an external change occurring after completed Open and before normal Save binds', async () => {
    const f = await fixture(), token = await f.read(); await fs.writeFile(f.file, 'EXTERNAL');
    await expect(bindSource(f, token)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); expect(await fs.readFile(f.file, 'utf8')).toBe('EXTERNAL');
    await expect(fs.stat(`${f.file}.bak`)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.proofs.stats()).toMatchObject({ liveProofs: 1, pending: 0, borrowed: 0 });
  });
  it('compares SHA256 independently of equal file-version scalar fields', async () => {
    const f = await fixture(), token = await f.read(), lease = f.proofs.borrow(f.owner, token), pin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.file));
    expect(() => f.proofs.validateDestination(lease, f.owner, { ...pin, fileVersion: { ...pin.fileVersion, sha256: '0'.repeat(64) } })).toThrow(/original opened file changed/); f.proofs.releaseBorrow(lease);
  });
  it('guards case aliases and missing originals, allowing only an explicit distinct Save As copy', async () => {
    const f = await fixture(), token = await f.read(), lease = f.proofs.borrow(f.owner, token), alias = path.join(f.root, 'original.dxf');
    const aliasPin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(alias)); expect(f.proofs.validateDestination(lease, f.owner, aliasPin, 'save-as')).toBe('source');
    const copyPin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.copy)); expect(() => f.proofs.validateDestination(lease, f.owner, copyPin, 'in-place')).toThrow(); expect(f.proofs.validateDestination(lease, f.owner, copyPin, 'save-as')).toBe('copy');
    await fs.rm(f.file); const missing = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(alias)); expect(() => f.proofs.validateDestination(lease, f.owner, missing, 'save-as')).toThrow(); f.proofs.releaseBorrow(lease);
  });
  it('refuses a logical-source junction retarget in both normal and Save As modes', async () => {
    const f = await fixture(), inside = path.join(f.root, 'A'), outside = path.join(f.root, 'B'), selected = path.join(f.root, 'Picked'); await fs.mkdir(inside); await fs.mkdir(outside); await fs.writeFile(path.join(inside, 'Source.dxf'), 'ORIGINAL'); await fs.writeFile(path.join(outside, 'Source.dxf'), 'EXTERNAL'); await fs.symlink(inside, selected, 'junction');
    const logical = path.join(selected, 'Source.dxf'), reservation = f.proofs.reserve(f.owner, logical), read = await coherentFileDigest(logical), token = f.proofs.completeRead(reservation, f.owner, { canonicalPath: read.canonicalPath, fileVersion: { ...read.version, sha256: read.sha256 } });
    await fs.unlink(selected); await fs.symlink(outside, selected, 'junction'); const pin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(logical)), lease = f.proofs.borrow(f.owner, token);
    for (const mode of ['in-place', 'save-as']) expect(() => f.proofs.validateDestination(lease, f.owner, pin, mode)).toThrow(/original opened file changed/); f.proofs.releaseBorrow(lease); expect(await fs.readFile(path.join(outside, 'Source.dxf'), 'utf8')).toBe('EXTERNAL');
  });
  it('keeps duplicate Open lineages independent instead of refreshing by path or owner', async () => {
    const f = await fixture(), old = await f.read(); await fs.writeFile(f.file, 'EXTERNAL'); const unusedDuplicate = await f.read(); f.proofs.release(unusedDuplicate, f.owner);
    await expect(bindSource(f, old)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); const acceptedReload = await f.read(), bound = await bindSource(f, acceptedReload);
    const result = await f.host.run(bound.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-SAVE', atomic)); expect(result.status).toBe('saved');
    await expect(bindSource(f, old)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); expect(f.proofs.stats().pending).toBe(0);
  });
  it('uses immutable already verified commit evidence without a new filesystem read', async () => {
    const f = await fixture(), token = await f.read(), bound = await bindSource(f, token);
    const result = await f.host.run(bound.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-SAVE', atomic));
    const pin = verifiedCommitTarget(result.commitEvidence, f.owner); expect(pin.fileVersion.sha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(pin)).toBe(true); expect(verifiedCommitTarget(result.commitEvidence, {})).toBeNull(); expect(verifiedCommitTarget(structuredClone(result.commitEvidence), f.owner)).toBeNull();
    const lease = f.proofs.borrow(f.owner, bound.replacement()); expect(lease.source.fileVersion).toEqual(pin.fileVersion); expect(bound.verified).toHaveBeenCalledOnce(); expect(bound.finish).toHaveBeenCalledOnce(); f.proofs.releaseBorrow(lease);
  });
  it('reuses a bounded latest own-source transition after prior tokens are released, without retention chains', async () => {
    const f = await fixture({ maxProofs: 2, maxPerOwner: 2 }), initial = await f.read(); let token = initial;
    for (let index = 0; index < 12; index++) {
      const bound = await bindSource(f, token), result = await f.host.run(bound.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit(`OWN${index}`, atomic));
      expect(result.status).toBe('saved'); f.proofs.release(token, f.owner); token = bound.replacement()!;
      expect(f.proofs.stats()).toEqual({ records: 1, liveProofs: 1, pending: 0, chars: OPENED_SOURCE_RESERVED_CHARS, borrowed: 0 });
    }
    expect(await fs.readFile(f.file, 'utf8')).toBe('OWN11');
  });
  it('allows an older live source lease only through this Open lineage’s verified writes', async () => {
    const f = await fixture(), old = await f.read(), first = await bindSource(f, old);
    await f.host.run(first.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-SAVE', atomic));
    const next = await bindSource(f, old); await f.host.run(next.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-NEXT', atomic));
    const unrelatedOpen = await f.read(), unrelated = await bindSource(f, unrelatedOpen); await f.host.run(unrelated.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OTHERDOC', atomic));
    await expect(bindSource(f, old)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' });
  });
  it('joins an active own rename-to-verification gap before validating the same lineage', async () => {
    const f = await fixture(), token = await f.read(), first = await bindSource(f, token), renamed = deferred(), gap = deferred();
    const saving = f.host.run(first.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-SAVE', async (bytes, ctx) => { await ctx.guard(); await fs.writeFile(ctx.destinationPath, bytes); renamed.resolve(); await gap.promise; await ctx.markCommitted(); }));
    await renamed.promise; let completed = false; const joining = bindSource(f, token).then((value) => { completed = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(completed).toBe(false); gap.resolve(); expect((await saving).status).toBe('saved'); const second = await joining;
    expect(second.validate).toHaveBeenCalledTimes(2); expect((await f.host.run(second.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-NEXT', atomic))).status).toBe('saved');
  });
  it('does not accept another Open lineage after joining its active writer queue', async () => {
    const f = await fixture(), original = await f.read(), otherOpen = await f.read(), first = await bindSource(f, otherOpen), entered = deferred(), gate = deferred();
    const saving = f.host.run(first.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OTHERDOC', async (bytes, ctx) => { await ctx.guard(); await fs.writeFile(ctx.destinationPath, bytes); entered.resolve(); await gate.promise; await ctx.markCommitted(); }));
    await entered.promise; const binding = bindSource(f, original), rejected = expect(binding).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); await new Promise((resolve) => setTimeout(resolve, 20)); gate.resolve(); expect((await saving).status).toBe('saved'); await rejected;
    expect(await fs.readFile(f.file, 'utf8')).toBe('OTHERDOC'); expect(f.proofs.stats().pending).toBe(0);
  });
  it('keeps separate-copy commits in a new lineage while the old source lease guards the original', async () => {
    const f = await fixture(), token = await f.read(), originalLease = f.proofs.borrow(f.owner, token), bound = await bindSource(f, token, f.copy, 'save-as');
    expect(bound.relation()).toBe('copy'); await f.host.run(bound.ticket, f.owner, 'drawing', f.copy, async (scope: SaveScope) => scope.commit('COPYDATA', atomic));
    const originalPin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.file)); expect(f.proofs.validateDestination(originalLease, f.owner, originalPin)).toBe('source');
    const copiedLease = f.proofs.borrow(f.owner, bound.replacement()), copiedPin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.copy)); expect(f.proofs.validateDestination(copiedLease, f.owner, copiedPin)).toBe('source');
    f.proofs.releaseBorrow(originalLease); f.proofs.releaseBorrow(copiedLease); expect(await fs.readFile(f.file, 'utf8')).toBe('ORIGINAL');
  });
  it('does not treat another owner’s verified save as this document’s own transition', async () => {
    const f = await fixture(), token = await f.read(), other = {}, otherToken = await f.read(other), bound = await bindSource(f, otherToken, f.file, 'in-place', other);
    await f.host.run(bound.ticket, other, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OTHEROWN', atomic)); await expect(bindSource(f, token)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' });
  });
  it('keeps borrowed source evidence authoritative if the renderer releases its token during validation', async () => {
    const f = await fixture(), token = await f.read(), lease = f.proofs.borrow(f.owner, token), reservation = f.proofs.reserve(f.owner, f.file, lease), ticket = f.host.issue(f.owner, 'drawing'), gate = deferred(), entered = deferred();
    const binding = f.host.bind(ticket, f.owner, 'drawing', f.file, { validateSource: async (pin: any) => { entered.resolve(); await gate.promise; f.proofs.validateDestination(lease, f.owner, pin); }, onFinish: () => { f.proofs.releaseBorrow(lease); f.proofs.cancelReservation(reservation, f.owner); } });
    await entered.promise; f.proofs.release(token, f.owner); expect(f.proofs.stats().records).toBe(2); gate.resolve(); await binding; f.host.cancel(ticket, f.owner, 'drawing'); expect(f.proofs.stats()).toMatchObject({ records: 0, pending: 0, borrowed: 0 });
  });
  it('protects active and borrowed original paths from legacy proof omission while allowing a distinct copy', async () => {
    const f = await fixture(); await fs.link(f.file, f.copy); const token = await f.read(), lease = f.proofs.borrow(f.owner, token);
    for (const file of [f.file, f.copy, path.join(f.root, 'original.dxf')]) {
      const pin = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(file)); expect(() => f.proofs.assertUnprotectedDestination(f.owner, pin)).toThrow(/original source proof/);
    }
    const separate = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(path.join(f.root, 'Separate.dxf'))); expect(() => f.proofs.assertUnprotectedDestination(f.owner, separate)).not.toThrow();
    f.proofs.release(token, f.owner); const original = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.file)); expect(() => f.proofs.assertUnprotectedDestination(f.owner, original)).toThrow();
    f.proofs.releaseBorrow(lease); expect(() => f.proofs.assertUnprotectedDestination(f.owner, original)).not.toThrow();
  });
  it('refuses a previously bound source when that lineage moves to another native target before preparation or writing', async () => {
    const f = await fixture(); await fs.link(f.file, f.copy); const token = await f.read(), old = await bindSource(f, token), savedAs = await bindSource(f, token, f.copy, 'save-as');
    await f.host.run(savedAs.ticket, f.owner, 'drawing', f.copy, async (scope: SaveScope) => scope.commit('OWN-COPY', atomic));
    const operation = vi.fn(); await expect(f.host.prepare(old.ticket, f.owner, 'drawing', f.file, operation)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); expect(operation).not.toHaveBeenCalled();
    await expect(f.host.run(old.ticket, f.owner, 'drawing', f.file, operation)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' }); expect(operation).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, 'utf8')).toBe('ORIGINAL'); expect(await fs.readFile(f.copy, 'utf8')).toBe('OWN-COPY');
  });
  it('does not move a lineage backward when old branded commit evidence completes late', async () => {
    const f = await fixture(), token = await f.read(), first = await bindSource(f, token);
    const oldResult = await f.host.run(first.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-FIRST', atomic));
    const second = await bindSource(f, token); await f.host.run(second.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-NEXT', atomic));
    const lease = f.proofs.borrow(f.owner, token), reservation = f.proofs.reserve(f.owner, f.file, lease);
    expect(() => f.proofs.completeCommit(reservation, f.owner, oldResult.commitEvidence, 'source')).toThrow(/older verified completion/);
    const fresh = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.file)); expect(f.proofs.validateDestination(lease, f.owner, fresh)).toBe('source'); f.proofs.cancelReservation(reservation, f.owner); f.proofs.releaseBorrow(lease);
  });
  it('captures the source relation before an actual hardlink replacement changes inode identity', async () => {
    const f = await fixture(); await fs.link(f.file, f.copy); const token = await f.read();
    const bound = await bindSource(f, token, f.copy, 'save-as'); expect(bound.relation()).toBe('source');
    await f.host.run(bound.ticket, f.owner, 'drawing', f.copy, async (scope: SaveScope) => scope.commit('OWN-LINK', atomic));
    expect(bound.replacement()).toMatch(/^[0-9a-f]{48}$/); expect(await fs.readFile(f.file, 'utf8')).toBe('ORIGINAL'); expect(await fs.readFile(f.copy, 'utf8')).toBe('OWN-LINK');
    const lease = f.proofs.borrow(f.owner, bound.replacement()), fresh = await f.identity.captureContentTarget(await f.identity.captureWriteTarget(f.copy)); expect(f.proofs.validateDestination(lease, f.owner, fresh)).toBe('source'); f.proofs.releaseBorrow(lease);
  });
});

describe.runIf(process.platform === 'win32')('Admission-owned opened-source lifecycle cleanup', () => {
  it('calls finish exactly once after bind failure, bound cancel, expiration, owner retirement and disposal', async () => {
    const f = await fixture(); let clock = 0;
    for (const outcome of ['failure', 'cancel', 'expire', 'retire', 'dispose']) {
      const host = createSaveAdmissions({ identity: f.identity, authorize: () => ({ allowed: true }), ttlMs: 5, now: () => clock }); hosts.push(host); const owner = {}, finish = vi.fn(), ticket = host.issue(owner, 'drawing');
      if (outcome === 'failure') await expect(host.bind(ticket, owner, 'drawing', f.file, { validateSource: () => { throw new Error('refuse'); }, onFinish: finish })).rejects.toThrow('refuse');
      else {
        await host.bind(ticket, owner, 'drawing', f.file, { onFinish: finish });
        if (outcome === 'cancel') host.cancel(ticket, owner, 'drawing');
        if (outcome === 'expire') { clock += 10; host.issue({}, 'drawing'); }
        if (outcome === 'retire') host.retireOwner(owner);
        if (outcome === 'dispose') await host.dispose();
      }
      expect(finish).toHaveBeenCalledOnce(); await host.dispose(); expect(finish).toHaveBeenCalledOnce();
    }
  });
  it('joins a pending source validation before cancellation releases its proof and reservation', async () => {
    const f = await fixture(), token = await f.read(), lease = f.proofs.borrow(f.owner, token), reservation = f.proofs.reserve(f.owner, f.file, lease), ticket = f.host.issue(f.owner, 'drawing'), gate = deferred(), entered = deferred();
    const finish = vi.fn(() => { f.proofs.releaseBorrow(lease); f.proofs.cancelReservation(reservation, f.owner); });
    const pending = f.host.bind(ticket, f.owner, 'drawing', f.file, { validateSource: async () => { entered.resolve(); await gate.promise; }, onFinish: finish }), rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' });
    await entered.promise; f.host.cancel(ticket, f.owner, 'drawing'); f.proofs.release(token, f.owner); expect(finish).not.toHaveBeenCalled(); expect(f.proofs.stats().records).toBe(2); gate.resolve(); await rejected;
    expect(finish).toHaveBeenCalledOnce(); expect(f.proofs.stats()).toMatchObject({ records: 0, pending: 0, borrowed: 0 });
  });
  it('snapshots trusted hook functions and delivers immutable verified evidence before producer completion', async () => {
    const f = await fixture(), finished = vi.fn(), seen = vi.fn(), changed = vi.fn(), ticket = f.host.issue(f.owner, 'drawing'), callbacks = { onVerifiedCommit: seen, onFinish: finished };
    await f.host.bind(ticket, f.owner, 'drawing', f.file, callbacks); callbacks.onVerifiedCommit = changed; callbacks.onFinish = changed;
    const result = await f.host.run(ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => { await scope.commit('OWN-SAVE', atomic); expect(seen).toHaveBeenCalledOnce(); expect(finished).not.toHaveBeenCalled(); return 42; });
    expect(result.value).toBe(42); expect(result.commitEvidence).toBe(seen.mock.calls[0]![0]); expect(Object.isFrozen(result.commitEvidence)).toBe(true); expect(changed).not.toHaveBeenCalled(); expect(finished).toHaveBeenCalledOnce();
  });
  it('does not publish verified evidence for wrong bytes or failed post-write verification', async () => {
    const f = await fixture(), seen = vi.fn(), finish = vi.fn();
    for (const failure of ['wrong-bytes', 'writer-verification']) {
      const ticket = f.host.issue(f.owner, 'drawing'); await f.host.bind(ticket, f.owner, 'drawing', f.file, { onVerifiedCommit: seen, onFinish: finish });
      await expect(f.host.run(ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('EXPECTED', async (bytes, ctx) => {
        await ctx.guard(); await fs.writeFile(ctx.destinationPath, failure === 'wrong-bytes' ? 'EXTERNAL' : bytes); await ctx.markCommitted(); if (failure === 'writer-verification') throw new Error('Codec verification failed');
      }))).rejects.toMatchObject({ committed: true });
    }
    expect(seen).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(2);
  });
  it('keeps the target native-content guard last after awaited source validation', async () => {
    const f = await fixture(), ticket = f.host.issue(f.owner, 'drawing'); let validateCalls = 0;
    await f.host.bind(ticket, f.owner, 'drawing', f.file, { validateSource: async () => { if (++validateCalls === 2) await fs.writeFile(f.file, 'EXTERNAL'); } });
    const producer = vi.fn(); await expect(f.host.run(ticket, f.owner, 'drawing', f.file, producer)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED', committed: false }); expect(producer).not.toHaveBeenCalled(); expect(await fs.readFile(f.file, 'utf8')).toBe('EXTERNAL');
  });
  it('retains a verified physical lineage but releases an unused proof when the producer later fails', async () => {
    const f = await fixture(), token = await f.read(), bound = await bindSource(f, token);
    await expect(f.host.run(bound.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => { await scope.commit('OWN-SAVE', atomic); throw new Error('Receipt transport failed'); })).rejects.toMatchObject({ committed: true });
    expect(bound.verified).toHaveBeenCalledOnce(); f.proofs.release(bound.replacement(), f.owner); expect(f.proofs.stats()).toMatchObject({ records: 1, liveProofs: 1, pending: 0, borrowed: 0 });
    const retry = await bindSource(f, token); expect((await f.host.run(retry.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-NEXT', atomic))).status).toBe('saved');
    await fs.writeFile(f.file, 'EXTERNAL'); await expect(bindSource(f, token)).rejects.toMatchObject({ code: 'ERR_OPENED_SOURCE_CHANGED' });
  });
  it('retirement rejects pending proof completion and waits for actual writer cleanup', async () => {
    const f = await fixture(), token = await f.read(), bound = await bindSource(f, token), entered = deferred(), gate = deferred();
    const saving = f.host.run(bound.ticket, f.owner, 'drawing', f.file, async (scope: SaveScope) => scope.commit('OWN-SAVE', async (bytes, ctx) => { await ctx.guard(); await fs.writeFile(ctx.destinationPath, bytes); await ctx.markCommitted(); entered.resolve(); await gate.promise; })), rejected = expect(saving).rejects.toMatchObject({ committed: true });
    await entered.promise; f.host.retireOwner(f.owner); f.proofs.retireOwner(f.owner); expect(bound.finish).not.toHaveBeenCalled(); gate.resolve(); await rejected;
    expect(bound.finish).toHaveBeenCalledOnce(); expect(bound.replacement()).toBeUndefined(); expect(f.proofs.stats()).toMatchObject({ records: 0, pending: 0, borrowed: 0 });
  });
});
