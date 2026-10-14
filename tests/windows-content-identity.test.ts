import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const native = require('node:fs/promises') as typeof fs;
const { createWindowsPathIdentity, coherentFileDigest, fileVersionKey, HASH_CHUNK_BYTES } = require('../electron/windows-path-identity.cjs');
const privateRoot = path.resolve('.codex-local/windows-content-tests'), roots: string[] = [];
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function setup(bytes: string | Uint8Array = 'ORIGINAL') {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const file = path.join(root, 'Drawing.dxf'); await fs.writeFile(file, bytes); return { root, file };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
/** Actual descriptors/bytes, with deterministic stat-tuple collision evidence. */
async function collidingStats(file: string) {
  const original = await fs.stat(file, { bigint: true });
  const masked = (stat: any) => new Proxy(stat, { get(target, key) {
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].includes(String(key))) return Reflect.get(original, key);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const selected = (value: unknown) => typeof value === 'string' && path.resolve(value) === file;
  return { ...native,
    stat: async (value: any, options: any) => { const stat = await native.stat(value, options); return selected(value) ? masked(stat) : stat; },
    lstat: async (value: any, options: any) => { const stat = await native.lstat(value, options); return selected(value) ? masked(stat) : stat; },
    open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args);
      return new Proxy(handle, { get(target, key) { if (key === 'stat') return async (options: any) => masked(await target.stat(options)); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe content test cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')('Fresh bounded Windows descriptor content evidence', () => {
  it.each([0, 1, HASH_CHUNK_BYTES * 2 + 37])('hashes %i real bytes without returning file contents', async (size) => {
    const bytes = Buffer.alloc(size, 0x61), f = await setup(bytes), reads: number[] = [];
    const wrapped = { ...native, open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args);
      return new Proxy(handle, { get(target, key) { if (key === 'read') return async (...values: any[]) => { reads.push(values[2]); return (target.read as any)(...values); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    } };
    const evidence = await coherentFileDigest(f.file, { fs: wrapped });
    expect(evidence.sha256).toBe(digest(bytes)); expect(evidence.bytes).toBe(size);
    expect(evidence.canonicalPath).toBe(await fs.realpath(f.file)); expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.version)).toBe(true); expect(Object.values(evidence).some(Buffer.isBuffer)).toBe(false);
    expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024); expect(reads.at(-1)).toBe(1);
  });
  it('leaves metadata-only alias lookup unread and brands content pins separately', async () => {
    const f = await setup(), open = vi.fn(native.open), identity = createWindowsPathIdentity({ fs: { ...native, open } });
    const metadata = await identity.captureWriteTarget(f.file, f.root); expect(open).not.toHaveBeenCalled();
    const pin = await identity.captureContentTarget(metadata);
    expect(pin.hashContent).toBe(true); expect(pin.fileVersion.sha256).toBe(digest('ORIGINAL')); expect(metadata.fileVersion.sha256).toBeUndefined();
    expect(Object.isFrozen(pin.fileVersion)).toBe(true); expect(fileVersionKey(pin.fileVersion)).not.toBe(fileVersionKey(metadata.fileVersion));
    await expect(identity.captureContentTarget({ ...metadata })).rejects.toMatchObject({ code: 'ERR_WINDOWS_IDENTITY' });
  });
  it('detects actual same-size outside bytes despite deterministic identical stat fields, without caching', async () => {
    const f = await setup(), wrapped = await collidingStats(f.file), open = vi.fn(wrapped.open), identity = createWindowsPathIdentity({ fs: { ...wrapped, open } });
    const pin = await identity.captureContentTarget(await identity.captureWriteTarget(f.file, f.root));
    await identity.revalidate(pin, { preserveVersion: true }); const before = open.mock.calls.length;
    await fs.writeFile(f.file, 'EXTERNAL');
    await expect(identity.revalidate(pin, { preserveVersion: true })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect(open.mock.calls.length).toBe(before + 1);
    const current = await identity.revalidate(pin); expect(current.fileVersion.sha256).toBe(digest('EXTERNAL'));
    expect(current.fileVersion.mtimeNs).toBe(pin.fileVersion.mtimeNs);
    await expect(identity.revalidate(pin, { preserveVersion: true, metadataOnly: true })).rejects.toMatchObject({ code: 'ERR_WINDOWS_IDENTITY' });
  });
  it('checks expected native version before reading, and expected digest after reading', async () => {
    const f = await setup(), identity = createWindowsPathIdentity(), pin = await identity.captureWriteTarget(f.file);
    await expect(coherentFileDigest(f.file, { expectedVersion: { ...pin.fileVersion, size: '999' } })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    await expect(coherentFileDigest(f.file, { expectedVersion: { ...pin.fileVersion, sha256: digest('EXTERNAL') } })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect((await coherentFileDigest(f.file, { expectedCanonicalPath: undefined })).sha256).toBe(digest('ORIGINAL'));
  });
  it('refuses oversized evidence before the first descriptor read', async () => {
    const f = await setup('0123456789'), read = vi.fn(), close = vi.fn();
    const wrapped = { ...native, open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args); return new Proxy(handle, { get(target, key) {
        if (key === 'read') return read; if (key === 'close') return async () => { close(); await target.close(); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    await expect(coherentFileDigest(f.file, { fs: wrapped, maxBytes: 9 })).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' });
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    for (const maxBytes of [0, 1.5, 128 * 1024 * 1024 + 1]) await expect(coherentFileDigest(f.file, { maxBytes })).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' });
  });
  it.each(['shrink', 'grow'])('rejects %s during a held descriptor read and closes it', async (change) => {
    const f = await setup(), closed = vi.fn(); let changed = false;
    const wrapped = { ...native, open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args); return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...values: any[]) => {
          if (!changed) { changed = true; await fs.writeFile(f.file, change === 'shrink' ? 'A' : 'ORIGINAL+'); }
          return (target.read as any)(...values);
        };
        if (key === 'close') return async () => { closed(); await target.close(); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    await expect(coherentFileDigest(f.file, { fs: wrapped })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(closed).toHaveBeenCalledOnce();
  });
  it('rejects actual same-size file replacement immediately after descriptor close', async () => {
    const f = await setup(), closed = vi.fn();
    const wrapped = { ...native, open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args); return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => { await target.close(); closed(); const temp = `${f.file}.tmp`; await fs.writeFile(temp, 'REPLACED'); await fs.rename(temp, f.file); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    await expect(coherentFileDigest(f.file, { fs: wrapped })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(closed).toHaveBeenCalledOnce();
  });
  it('joins an in-flight native read before cancellation closes its descriptor', async () => {
    const f = await setup(), entered = deferred(), release = deferred(), closed = vi.fn(), abort = new AbortController();
    const wrapped = { ...native, open: async (...args: any[]) => {
      const handle = await (native.open as any)(...args); return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...values: any[]) => { entered.resolve(); await release.promise; return (target.read as any)(...values); };
        if (key === 'close') return async () => { closed(); await target.close(); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const pending = coherentFileDigest(f.file, { fs: wrapped, signal: abort.signal }), outcome = expect(pending).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' });
    await entered.promise; abort.abort(); await Promise.resolve(); expect(closed).not.toHaveBeenCalled(); release.resolve(); await outcome; expect(closed).toHaveBeenCalledOnce();
    const open = vi.fn(native.open); await expect(coherentFileDigest(f.file, { fs: { ...native, open }, signal: abort.signal })).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' }); expect(open).not.toHaveBeenCalled();
  });
  it('refuses wrong canonical spelling before open and follows regular symlinks only in the low-level reader', async () => {
    const f = await setup(), open = vi.fn(native.open);
    await expect(coherentFileDigest(f.file, { fs: { ...native, open }, expectedCanonicalPath: path.join(f.root, 'Other.dxf') })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' }); expect(open).not.toHaveBeenCalled();
    // A junction is portable to unprivileged Windows tests and changes only the parent namespace.
    const folder = path.join(f.root, 'Picked'); await fs.symlink(f.root, folder, 'junction');
    expect((await coherentFileDigest(path.join(folder, path.basename(f.file)))).sha256).toBe(digest('ORIGINAL'));
  });
  it('hashes a formerly missing target after creation and permits metadata-only safe cleanup', async () => {
    const f = await setup(), missing = path.join(f.root, 'Missing.dxf'), identity = createWindowsPathIdentity();
    const pin = await identity.captureContentTarget(await identity.captureWriteTarget(missing)); expect(pin.fileVersion).toBeNull(); expect(pin.hashContent).toBe(true);
    await fs.writeFile(missing, 'CREATED'); expect((await identity.revalidate(pin)).fileVersion.sha256).toBe(digest('CREATED'));
    await expect(identity.revalidate(pin, { preserveVersion: true })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    const handle = await fs.open(missing, 'r+'); await handle.truncate(128 * 1024 * 1024 + 1); await handle.close();
    expect((await identity.revalidate(pin, { preserveLeaf: true, metadataOnly: true })).exists).toBe(true);
    await expect(identity.revalidate(pin)).rejects.toMatchObject({ code: 'ERR_WINDOWS_CONTENT_LIMIT' });
  });
});
