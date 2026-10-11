import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { MemFs } from './helpers/memfs';
import { Rng } from './helpers/fuzz';

const require = createRequire(import.meta.url);
type Writer = {
  atomicWriteFile(file: string, data: string, opts?: { backup?: boolean }): Promise<{ path: string; backup: string | null }>;
  copyFileAtomic(src: string, dest: string): Promise<string>;
};
type Atomic = { createAtomicWriter(fs: unknown, options: { platform: string; hooks?: { beforeRename(tmp: string): void } }): Writer };
// Exercise the shipped module with POSIX path semantics on every test host.
const module = { exports: {} as Atomic };
new Function('require', 'module', 'process', readFileSync(new URL('../electron/atomic-write.cjs', import.meta.url), 'utf8'))(
  (name: string) => name === 'node:path' ? nodePath.posix : name === './file-errors.cjs' ? require('../electron/file-errors.cjs') : require(name),
  module,
  { platform: 'darwin' },
);
const atomic = module.exports;
const p = nodePath.posix;

function darwinFs() {
  const mem = new MemFs(new Rng(1));
  const links = new Map([
    ['/var', { target: 'private/var', uid: 0, ino: 11 }],
    ['/tmp', { target: 'private/tmp', uid: 0, ino: 12 }],
    ['/etc', { target: 'private/etc', uid: 0, ino: 13 }],
  ]);
  const roots = new Map(['/', '/private', '/private/var', '/private/tmp', '/private/etc'].map((dir, i) => [dir, { uid: 0, mode: dir === '/private/tmp' ? 0o41777 : 0o40755, ino: i + 1 }]));
  for (const dir of roots.keys()) mem.dirs.add(dir);
  const resolve = (file: string): string => {
    file = p.normalize(file);
    for (let round = 0; round < 10; round++) {
      const entry = [...links].find(([link]) => file === link || file.startsWith(`${link}/`));
      if (!entry) return file;
      const [link, { target }] = entry;
      file = p.resolve(p.dirname(link), target, p.relative(link, file));
    }
    throw new Error('link loop');
  };
  const entryPath = (file: string) => p.join(resolve(p.dirname(file)), p.basename(file));
  const fs = {
    constants: mem.constants,
    async lstat(file: string) {
      const entry = entryPath(file);
      const link = links.get(entry);
      if (link) return { ...link, dev: 1, mode: 0o120777, isSymbolicLink: () => true, isDirectory: () => false };
      const stat = await mem.stat(entry);
      return { ...stat, uid: 1000, dev: 1, ino: 100, ...roots.get(entry) };
    },
    async readlink(file: string) {
      const link = links.get(entryPath(file));
      if (!link) throw new Error('not a link');
      return link.target;
    },
    realpath: (file: string) => mem.realpath(resolve(file)),
    access: (file: string, mode: number) => mem.access(resolve(file), mode),
    open: (file: string, flags: string) => mem.open(resolve(file), flags),
    copyFile: (src: string, dest: string, flags: number) => mem.copyFile(resolve(src), resolve(dest), flags),
    rename: (src: string, dest: string) => mem.rename(resolve(src), resolve(dest)),
    chmod: (file: string, mode: number) => mem.chmod(resolve(file), mode),
    rm: (file: string, options: { force?: boolean }) => mem.rm(resolve(file), options),
  };
  return { fs, mem, links, roots };
}

describe('protected macOS system aliases in atomic writes', () => {
  for (const alias of ['var', 'tmp', 'etc']) {
    it(`writes and backs up through /${alias}, preserving complete previous content`, async () => {
      const { fs, mem } = darwinFs();
      const file = `/${alias}/drawing.dxf`;
      mem.put(`/private/${alias}/drawing.dxf`, 'ORIGINAL');
      mem.put('/private/source.dxf', 'SOURCE');
      const writer = atomic.createAtomicWriter(fs, { platform: 'darwin' });
      expect(await writer.atomicWriteFile(file, 'NEW', { backup: true })).toMatchObject({ path: file, backup: `${file}.bak` });
      expect(mem.get(`/private/${alias}/drawing.dxf`)).toBe('NEW');
      expect(mem.get(`/private/${alias}/drawing.dxf.bak`)).toBe('ORIGINAL');
      await writer.copyFileAtomic('/private/source.dxf', `/${alias}/copy.dxf.bak`);
      expect(mem.get(`/private/${alias}/copy.dxf.bak`)).toBe('SOURCE');
      expect(mem.list(`/private/${alias}`).some((name) => name.endsWith('.tmp'))).toBe(false);
    });
  }

  it('does not permit these aliases on another platform', async () => {
    const { fs, mem } = darwinFs();
    await expect(atomic.createAtomicWriter(fs, { platform: 'linux' }).atomicWriteFile('/var/drawing.dxf', 'NEW')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(mem.files.size).toBe(0);
  });

  for (const changed of ['owner', 'target', 'private permissions', 'target owner']) {
    it(`rejects a system alias with changed ${changed}`, async () => {
      const { fs, mem, links, roots } = darwinFs();
      mem.put('/private/var/drawing.dxf', 'ORIGINAL');
      mem.dirs.add('/outside');
      if (changed === 'owner') links.get('/var')!.uid = 1000;
      if (changed === 'target') links.get('/var')!.target = '/outside';
      if (changed === 'private permissions') roots.get('/private')!.mode = 0o40777;
      if (changed === 'target owner') roots.get('/private/var')!.uid = 1000;
      await expect(atomic.createAtomicWriter(fs, { platform: 'darwin' }).atomicWriteFile('/var/drawing.dxf', 'NEW')).rejects.toMatchObject({ code: 'ELOOP' });
      expect(mem.get('/private/var/drawing.dxf')).toBe('ORIGINAL');
      expect(mem.get('/outside/drawing.dxf')).toBeUndefined();
    });
  }

  it('still rejects arbitrary links below an allowed alias, even when owned by root', async () => {
    const { fs, mem, links } = darwinFs();
    links.set('/private/var/user-link', { target: '/outside', uid: 0, ino: 20 });
    mem.dirs.add('/outside');
    await expect(atomic.createAtomicWriter(fs, { platform: 'darwin' }).atomicWriteFile('/var/user-link/drawing.dxf', 'NEW')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(mem.files.size).toBe(0);
  });

  for (const changed of ['alias inode', 'alias target', 'canonical target inode']) {
    it(`rejects ${changed} replacement between temp write and rename`, async () => {
      const { fs, mem, links, roots } = darwinFs();
      mem.put('/private/var/drawing.dxf', 'ORIGINAL');
      mem.dirs.add('/outside');
      const writer = atomic.createAtomicWriter(fs, { platform: 'darwin', hooks: { beforeRename: () => {
        if (changed === 'alias inode') links.get('/var')!.ino++;
        if (changed === 'alias target') links.get('/var')!.target = '/outside';
        if (changed === 'canonical target inode') roots.get('/private/var')!.ino++;
      } } });
      await expect(writer.atomicWriteFile('/var/drawing.dxf', 'NEW')).rejects.toMatchObject({ code: 'ELOOP' });
      expect(mem.get('/private/var/drawing.dxf')).toBe('ORIGINAL');
      expect(mem.get('/outside/drawing.dxf')).toBeUndefined();
    });
  }
});
