/** Byte admission stays strict even when the stat cache identity collides. */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { verifyPortableWriter } = require('../electron/portable-dwg.cjs') as {
  verifyPortableWriter(locations: { directory: string; manifest: string }, fileSystem?: typeof fs): Promise<{ check(): Promise<void> }>;
};
const root = path.resolve('.codex-local/writer-byte-admission-tests'), directories: string[] = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(path.dirname(path.resolve(directory))).toBe(root); expect(path.basename(directory)).toMatch(/^case-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  await fs.mkdir(root, { recursive: true }); const directory = await fs.mkdtemp(path.join(root, 'case-')); directories.push(directory);
  const files = new Map([['JcadDwgWriter.exe', Buffer.from('trusted executable fixture')], ['Managed.dll', Buffer.from('trusted managed dependency')]]);
  for (const [name, bytes] of files) await fs.writeFile(path.join(directory, name), bytes);
  const manifest = path.join(directory, 'integrity.json');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, files: [...files].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) })) }));
  const pinned = new Map(await Promise.all([...files.keys()].map(async (name) => [path.join(directory, name), await fs.lstat(path.join(directory, name))] as const)));
  let opens = 0;
  // Real file bytes and real descriptors, with deliberately identical cached
  // stat values. This deterministically models timestamp precision collisions
  // and restored metadata, rather than relying on a particular NTFS schedule.
  const fileSystem = { ...fs,
    lstat: async (file: string) => pinned.get(String(file)) ?? fs.lstat(file),
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), metadata = pinned.get(String(args[0]));
      if (metadata) { opens++; handle.stat = (async () => metadata) as typeof handle.stat; }
      return handle;
    },
  } as typeof fs;
  return { directory, manifest, files, fileSystem, opens: () => opens };
}

describe('portable writer checks actual bytes on each admission', () => {
  it.each(['JcadDwgWriter.exe', 'Managed.dll'])('rejects changed %s with an exactly unchanged stat identity', async (name) => {
    const f = await fixture(), verified = await verifyPortableWriter(f, f.fileSystem), original = f.files.get(name)!;
    const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1;
    await fs.writeFile(path.join(f.directory, name), changed);
    expect(changed.length).toBe(original.length);
    await expect(verified.check()).rejects.toThrow(/changed after its integrity check/);
    // A failed check must not admit a new digest into the trusted cache.
    await fs.writeFile(path.join(f.directory, name), original);
    await expect(verified.check()).resolves.toBeUndefined();
  });
  it('rehashes every listed executable dependency even when no metadata changes', async () => {
    const f = await fixture(), verified = await verifyPortableWriter(f, f.fileSystem), initial = f.opens();
    await verified.check(); await verified.check();
    expect(f.opens() - initial).toBe(f.files.size * 2);
  });
});
