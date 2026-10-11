import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, symlinkSync, statSync, chmodSync, mkdirSync, lstatSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeFileError, fileErrorCode, type FileAction } from '../src/app/file-errors';

const require = createRequire(import.meta.url);
type WriteResult = { path: string; backup: string | null; method: 'rename' | 'copy' };
type Writer = {
  atomicWriteFile(file: string, data: string | Uint8Array, opts?: { backup?: boolean; encoding?: string }): Promise<WriteResult>;
  copyFileAtomic(src: string, dest: string): Promise<string>;
};
const atomic = require('../electron/atomic-write.cjs') as Writer & {
  createAtomicWriter(fs?: unknown, options?: { platform?: string; renameDelays?: number[]; hooks?: { beforeRename?: (tmp: string, dest: string) => unknown } }): Writer;
  createWriteQueue(): <T>(key: string, job: () => Promise<T>) => Promise<T>;
  backupFile(file: unknown, copy?: (a: string, b: string) => Promise<string>): Promise<{ ok: true; path: string } | { ok: false; code: string | null; error: string }>;
  isTempName(name: string): boolean;
};
const cjsErrors = require('../electron/file-errors.cjs') as { describeFileError: typeof describeFileError; KIND_BY_CODE: Record<string, string> };
type Entry = { name: string; title: string; originalPath: string | null; savedAt: number };
type Store = {
  migrated: Array<[string, string]>;
  write(name: string, text: string, meta: unknown): Promise<void>;
  list(): Promise<Entry[]>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
};
const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps?: { fs?: unknown; uuid?: () => string }): Store };

const fsError = (code: string, message = 'failed') => Object.assign(new Error(`${code}: ${message}`), { code });

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jcad-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const leftovers = (d = dir) => readdirSync(d).filter((f) => f.endsWith('.tmp'));

/** fs/promises with selected functions replaced (fault injection). */
function faultyFs(over: Record<string, unknown>) {
  return { ...fsp, ...over };
}

describe('atomic writes (electron/atomic-write.cjs)', () => {
  it('writes a new file without a backup and leaves no temporary file', async () => {
    const f = join(dir, 'panel.dxf');
    const r = await atomic.atomicWriteFile(f, 'v1', { backup: true });
    expect(readFileSync(f, 'utf8')).toBe('v1');
    expect(r.backup).toBeNull();
    expect(r.method).toBe('rename');
    expect(existsSync(`${f}.bak`)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a successful save keeps the previous version as <name>.bak (one generation)', async () => {
    const f = join(dir, 'panel.dxf');
    await atomic.atomicWriteFile(f, 'v1', { backup: true });
    const r = await atomic.atomicWriteFile(f, 'v2', { backup: true });
    expect(r.backup).toBe(`${f}.bak`);
    expect(readFileSync(f, 'utf8')).toBe('v2');
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('v1');
    await atomic.atomicWriteFile(f, 'v3', { backup: true });
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('v2');
    expect(readdirSync(dir).sort()).toEqual(['panel.dxf', 'panel.dxf.bak']);
  });

  it('a crash after the temporary file is written but before the rename leaves the original intact', async () => {
    const f = join(dir, 'panel.dxf');
    writeFileSync(f, 'ORIGINAL');
    let tmpSeen = '';
    const w = atomic.createAtomicWriter(fsp, {
      hooks: {
        beforeRename: (tmp) => {
          tmpSeen = tmp;
          // The new content is complete and synced in the temporary file, next to the destination ...
          expect(readFileSync(tmp, 'utf8')).toBe('NEW CONTENT');
          expect(tmp.startsWith(dir)).toBe(true);
          throw new Error('simulated crash');
        },
      },
    });
    await expect(w.atomicWriteFile(f, 'NEW CONTENT', { backup: true })).rejects.toThrow(/simulated crash/);
    // ... and the destination was never touched.
    expect(readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(tmpSeen)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a process killed mid-write (temporary file left behind) never damages the destination', async () => {
    const f = join(dir, 'panel.dxf');
    writeFileSync(f, 'ORIGINAL');
    // A kill between write and rename: the cleanup in the error path never runs either.
    const w = atomic.createAtomicWriter(
      faultyFs({
        rm: async () => {
          throw new Error('process gone');
        },
      }),
      { hooks: { beforeRename: () => Promise.reject(new Error('killed')) } },
    );
    await expect(w.atomicWriteFile(f, 'HALF', {})).rejects.toThrow(/killed/);
    expect(readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(leftovers()).toHaveLength(1);
    expect(atomic.isTempName(leftovers()[0]!)).toBe(true);
  });

  it('a full disk while writing keeps the original and reports ENOSPC with the destination path', async () => {
    const f = join(dir, 'panel.dxf');
    writeFileSync(f, 'ORIGINAL');
    const w = atomic.createAtomicWriter(
      faultyFs({
        open: async (p: string, flags: string) => {
          const fh = await fsp.open(p, flags);
          if (flags !== 'wx') return fh;
          return {
            writeFile: async () => {
              throw fsError('ENOSPC', 'no space left on device, write');
            },
            sync: () => fh.sync(),
            close: () => fh.close(),
          };
        },
      }),
    );
    const err = (await w.atomicWriteFile(f, 'NEW', { backup: true }).catch((e) => e)) as NodeJS.ErrnoException;
    expect(err.code).toBe('ENOSPC');
    expect(err.message).toBe(`ENOSPC: no space left on device, write '${f}'`);
    expect(readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(`${f}.bak`)).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(describeFileError(err).kind).toBe('disk-full');
  });

  it('retries a rename refused by a scanner (EPERM) and then succeeds atomically', async () => {
    const f = join(dir, 'panel.dxf');
    writeFileSync(f, 'v1');
    let refusals = 2;
    const w = atomic.createAtomicWriter(
      faultyFs({
        rename: async (a: string, b: string) => {
          if (b === f && refusals > 0) {
            refusals -= 1;
            throw fsError('EPERM', 'operation not permitted, rename');
          }
          return fsp.rename(a, b);
        },
      }),
      { renameDelays: [1, 1, 1] },
    );
    const r = await w.atomicWriteFile(f, 'v2', { backup: true });
    expect(r.method).toBe('rename');
    expect(readFileSync(f, 'utf8')).toBe('v2');
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('v1');
  });

  for (const code of ['EPERM', 'EXDEV']) {
    it(`falls back to copy + remove when rename keeps failing with ${code}, after making the .bak`, async () => {
      const f = join(dir, 'panel.dxf');
      writeFileSync(f, 'v1');
      const w = atomic.createAtomicWriter(
        faultyFs({
          rename: async (a: string, b: string) => {
            if (b === f) throw fsError(code, 'rename');
            return fsp.rename(a, b);
          },
        }),
        { renameDelays: [1, 1] },
      );
      const r = await w.atomicWriteFile(f, 'v2', { backup: true });
      expect(r.method).toBe('copy');
      expect(readFileSync(f, 'utf8')).toBe('v2');
      expect(readFileSync(`${f}.bak`, 'utf8')).toBe('v1');
      expect(leftovers()).toEqual([]);
    });
  }

  it('does not replace the destination when the .bak copy cannot be made', async () => {
    const f = join(dir, 'panel.dxf');
    writeFileSync(f, 'v1');
    const w = atomic.createAtomicWriter(
      faultyFs({
        copyFile: async () => {
          throw fsError('ENOSPC', 'no space left on device, copyfile');
        },
      }),
    );
    await expect(w.atomicWriteFile(f, 'v2', { backup: true })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(readFileSync(f, 'utf8')).toBe('v1');
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps permission bits and writes through symbolic links', async () => {
    const real = join(dir, 'real.dxf');
    writeFileSync(real, 'v1');
    chmodSync(real, 0o640);
    const link = join(dir, 'link.dxf');
    symlinkSync(real, link);
    await atomic.atomicWriteFile(link, 'v2', { backup: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('v2');
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(readFileSync(`${real}.bak`, 'utf8')).toBe('v1');
  });

  it('refuses to replace a read-only file (rename alone would ignore the flag on POSIX)', async () => {
    const f = join(dir, 'locked.dxf');
    writeFileSync(f, 'v1');
    const w = atomic.createAtomicWriter(
      faultyFs({
        access: async (p: string) => {
          if (p === f) throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: 'EACCES' });
        },
      }),
    );
    const err = (await w.atomicWriteFile(f, 'v2', { backup: true }).catch((e) => e)) as NodeJS.ErrnoException;
    expect(err.code).toBe('EACCES');
    expect(readFileSync(f, 'utf8')).toBe('v1');
    expect(existsSync(`${f}.bak`)).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(describeFileError(err).kind).toBe('permission');
  });

  it('writes bytes as well as text', async () => {
    const f = join(dir, 'plot.pdf');
    await atomic.atomicWriteFile(f, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(readFileSync(f, 'latin1')).toBe('%PDF');
  });

  it('a missing folder is reported as ENOENT for the destination', async () => {
    const f = join(dir, 'gone', 'panel.dxf');
    const err = (await atomic.atomicWriteFile(f, 'x').catch((e) => e)) as NodeJS.ErrnoException;
    expect(err.code).toBe('ENOENT');
    expect(err.message).toContain(`'${f}'`);
    expect(describeFileError(err).message).toBe(`"panel.dxf" could not be saved: "${join(dir, 'gone')}" is not available. It may have been moved or deleted, or the network or removable drive is disconnected.`);
  });

  it('serialises writes to the same file in call order', async () => {
    const enqueue = atomic.createWriteQueue();
    const f = join(dir, 'recent.json');
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        enqueue(f, async () => {
          await new Promise((r) => setTimeout(r, 6 - i));
          order.push(i);
          await atomic.atomicWriteFile(f, String(i));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(readFileSync(f, 'utf8')).toBe('5');
  });
});

describe('backup-file (project-wide .bak copies)', () => {
  it('copies through a temporary file and reports the .bak path', async () => {
    const f = join(dir, 'sheet1.dxf');
    writeFileSync(f, 'ORIGINAL');
    writeFileSync(`${f}.bak`, 'OLD BACKUP');
    expect(await atomic.backupFile(f)).toEqual({ ok: true, path: `${f}.bak` });
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('ORIGINAL');
    expect(leftovers()).toEqual([]);
  });
  it('returns { ok: false, error } with a clear message instead of throwing or pretending', async () => {
    const missing = join(dir, 'missing.dxf');
    const r = await atomic.backupFile(missing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('ENOENT');
    expect(r.error).toMatch(/^The backup copy of "missing\.dxf" could not be made: /);
    expect(existsSync(`${missing}.bak`)).toBe(false);
  });
  it('a failed copy keeps the previous .bak complete', async () => {
    const f = join(dir, 'sheet1.dxf');
    writeFileSync(f, 'ORIGINAL');
    writeFileSync(`${f}.bak`, 'OLD BACKUP');
    const w = atomic.createAtomicWriter(
      faultyFs({
        copyFile: async (_a: string, b: string) => {
          writeFileSync(b, 'PARTI'); // half a copy, then the disk fills up
          throw fsError('ENOSPC', 'no space left on device, copyfile');
        },
      }),
    );
    const r = await atomic.backupFile(f, w.copyFileAtomic);
    expect(r).toMatchObject({ ok: false, code: 'ENOSPC' });
    expect(!r.ok && r.error).toMatch(/not enough free space/);
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe('OLD BACKUP');
    expect(leftovers()).toEqual([]);
  });
  it('refuses anything but absolute DXF / project paths', async () => {
    for (const bad of ['sheet.dxf', join(dir, 'notes.txt'), 42, null]) {
      expect(await atomic.backupFile(bad)).toMatchObject({ ok: false, code: 'EINVAL' });
    }
    writeFileSync(join(dir, 'p.jcadproj.json'), '{}');
    expect(await atomic.backupFile(join(dir, 'p.jcadproj.json'))).toMatchObject({ ok: true });
  });
});

describe('file error messages', () => {
  const ipc = (code: string, msg: string, p: string) => new Error(`Error invoking remote method 'save-dxf': Error: ${code}: ${msg}, write '${p}'`);
  it('reads the code and the path from IPC error text', () => {
    const e = ipc('ENOSPC', 'no space left on device', 'C:\\work\\panel.dxf');
    expect(fileErrorCode(e)).toBe('ENOSPC');
    const info = describeFileError(e);
    expect(info).toMatchObject({ code: 'ENOSPC', kind: 'disk-full', path: 'C:\\work\\panel.dxf' });
    expect(info.message).toBe('"panel.dxf" could not be saved: there is not enough free space on the disk. Free some space or choose another drive.');
    expect(info.detail).toBe("ENOSPC: no space left on device, write 'C:\\work\\panel.dxf'");
  });
  it('maps each family of errors to a clear message', () => {
    const p = '/home/u/jobs/panel.dxf';
    const cases: Array<[string, string, RegExp]> = [
      ['ENOSPC', 'disk-full', /not enough free space/],
      ['EDQUOT', 'disk-full', /not enough free space/],
      ['EACCES', 'permission', /do not have permission to write to "\/home\/u\/jobs"/],
      ['EPERM', 'permission', /permission .* or the file is read-only or open in another program/],
      ['EROFS', 'read-only', /read-only drive/],
      ['EBUSY', 'locked', /locked by another program/],
      ['ENOENT', 'unavailable', /"\/home\/u\/jobs" is not available/],
      ['ENOTDIR', 'unavailable', /is not available/],
      ['ENETUNREACH', 'unavailable', /network or removable drive is disconnected/],
      ['EHOSTDOWN', 'unavailable', /not available/],
      ['ETIMEDOUT', 'unavailable', /not available/],
      ['ESTALE', 'unavailable', /not available/],
      ['ENAMETOOLONG', 'too-long', /path is too long/],
      ['EISDIR', 'is-folder', /folder with that name/],
      ['EIO', 'io', /input\/output error/],
    ];
    for (const [code, kind, re] of cases) {
      const info = describeFileError(Object.assign(new Error(`${code}: x, open '${p}'`), { code }));
      expect(info.kind, code).toBe(kind);
      expect(info.message, code).toMatch(/^"panel\.dxf" could not be saved: /);
      expect(info.message, code).toMatch(re);
    }
    const other = describeFileError(new Error('Invalid DXF payload'));
    expect(other).toMatchObject({ code: null, kind: 'unknown', message: 'The drawing could not be saved: Invalid DXF payload' });
  });
  it('words the lead by action', () => {
    const e = Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
    expect(describeFileError(e, { action: 'list', path: '/data/autosave' }).message).toBe('The recovery folder could not be read: you do not have permission to read "/data/autosave". Check the folder\'s permissions.');
    expect(describeFileError(fsError('ENOSPC'), { action: 'autosave', path: 'panel.dxf' }).message).toMatch(/^The autosave copy of "panel\.dxf" could not be written: there is not enough/);
    expect(describeFileError(fsError('EBUSY'), { action: 'backup', path: '/a/b.dxf' }).message).toMatch(/^The backup copy of "b\.dxf" could not be made: the file is locked/);
  });
  it('the main-process twin produces identical messages', () => {
    const actions: FileAction[] = ['save', 'autosave', 'backup', 'read', 'list'];
    const codes = [...Object.keys(cjsErrors.KIND_BY_CODE), 'EWHATEVER', ''];
    for (const code of codes)
      for (const action of actions)
        for (const path of [null, '/a/b/c.dxf', 'C:\\x\\y.dxf', 'plain.dxf']) {
          const err = code ? Object.assign(new Error(`${code}: boom, open '/q/r.dxf'`), { code }) : new Error('plain failure');
          expect(cjsErrors.describeFileError(err, { action, path }), `${code} ${action} ${path}`).toEqual(describeFileError(err, { action, path }));
          const text = `Error invoking remote method 'x': Error: ${code || 'nothing'}: boom, write '/q/r.dxf'`;
          expect(cjsErrors.describeFileError(text, { action })).toEqual(describeFileError(text, { action }));
        }
  });
});

describe('autosave store with permanent ids (electron/autosave-store.cjs)', () => {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;
  beforeEach(() => {
    n = 0;
  });

  it('writes <id>.sv.dxf plus one index, lists newest first, reads and removes', async () => {
    const s = createAutosaveStore(join(dir, 'autosave'), { uuid });
    const a = '11111111-1111-4111-8111-111111111111.sv.dxf';
    const b = '22222222-2222-4222-8222-222222222222.sv.dxf';
    await s.write(a, 'AAA', { title: 'a.dxf', originalPath: '/x/a.dxf', savedAt: 10 });
    await s.write(b, 'BBB', { title: 'Drawing1.dxf', originalPath: null, savedAt: 20 });
    expect(readdirSync(join(dir, 'autosave')).sort()).toEqual([a, b, 'index.json'].sort());
    const index = JSON.parse(readFileSync(join(dir, 'autosave', 'index.json'), 'utf8'));
    expect(index.entries[a]).toEqual({ title: 'a.dxf', originalPath: '/x/a.dxf', savedAt: 10 });
    expect((await s.list()).map((e) => e.name)).toEqual([b, a]);
    expect(await s.read(a)).toBe('AAA');
    expect(await s.read('33333333-3333-4333-8333-333333333333.sv.dxf')).toBeNull();
    await s.remove(a);
    expect((await s.list()).map((e) => e.name)).toEqual([b]);
    // A new launch (new store over the same folder) sees the same entries with their titles.
    const again = createAutosaveStore(join(dir, 'autosave'), { uuid });
    expect(await again.list()).toEqual([{ name: b, title: 'Drawing1.dxf', originalPath: null, savedAt: 20 }]);
    await expect(s.write('../evil.sv.dxf', 'x', {})).rejects.toThrow(/Invalid autosave name/);
  });

  it('migrates old title_session files (with and without metadata) to permanent ids on first use', async () => {
    const d = join(dir, 'autosave');
    mkdirSync(d);
    writeFileSync(join(d, 'Panel_A_1.sv.dxf'), 'PANEL');
    writeFileSync(join(d, 'Panel_A_1.sv.dxf.json'), JSON.stringify({ originalPath: '/jobs/Panel A.dxf', title: 'Panel A.dxf', savedAt: 1000 }));
    writeFileSync(join(d, 'Drawing1_2.sv.dxf'), 'UNTITLED');
    writeFileSync(join(d, 'panel.dxf.~0123456789ab.tmp'), 'crash leftover');
    const s = createAutosaveStore(d, { uuid });
    const list = await s.list();
    expect(list).toHaveLength(2);
    const panel = list.find((e) => e.title === 'Panel A.dxf')!;
    expect(panel).toMatchObject({ originalPath: '/jobs/Panel A.dxf', savedAt: 1000 });
    expect(panel.name).toMatch(/^00000000-0000-4000-8000-\d{12}\.sv\.dxf$/);
    expect(await s.read(panel.name)).toBe('PANEL');
    const untitled = list.find((e) => e.title === 'Drawing1.dxf')!;
    expect(await s.read(untitled.name)).toBe('UNTITLED');
    expect(untitled.savedAt).toBeGreaterThan(0);
    expect(readdirSync(d).sort()).toEqual([panel.name, untitled.name, 'index.json'].sort());
    expect(s.migrated.map(([from]) => from).sort()).toEqual(['Drawing1_2.sv.dxf', 'Panel_A_1.sv.dxf']);
    // The next launch's session 1 can no longer clobber the old Drawing1 backup.
    await s.write(`${uuid()}.sv.dxf`, 'NEW SESSION', { title: 'Drawing1.dxf', savedAt: 5000 });
    expect(await s.read(untitled.name)).toBe('UNTITLED');
    expect((await createAutosaveStore(d, { uuid }).list()).length).toBe(3);
  });

  it('an unreadable folder is an error, not an empty list (and a retry works once it is fixed)', async () => {
    const d = join(dir, 'autosave');
    mkdirSync(d);
    writeFileSync(join(d, '11111111-1111-4111-8111-111111111111.sv.dxf'), 'X');
    let denied = true;
    const fs = faultyFs({
      readdir: async (p: string) => {
        if (denied) throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: 'EACCES', path: p });
        return fsp.readdir(p);
      },
    });
    const s = createAutosaveStore(d, { fs, uuid });
    const err = await s.list().catch((e) => e);
    expect(err).toMatchObject({ code: 'EACCES' });
    expect(describeFileError(err, { action: 'list', path: d }).message).toMatch(/^The recovery folder could not be read: you do not have permission/);
    expect(existsSync(join(d, '11111111-1111-4111-8111-111111111111.sv.dxf'))).toBe(true);
    denied = false;
    expect((await s.list()).length).toBe(1);
  });

  it('a missing folder simply means no backups', async () => {
    expect(await createAutosaveStore(join(dir, 'none'), { uuid }).list()).toEqual([]);
  });

  it('read errors other than "missing" are reported', async () => {
    const d = join(dir, 'autosave');
    const fs = faultyFs({
      readFile: async (p: string, enc: string) => {
        if (String(p).endsWith('.sv.dxf')) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
        return fsp.readFile(p, enc as BufferEncoding);
      },
    });
    const s = createAutosaveStore(d, { fs, uuid });
    await expect(s.read('11111111-1111-4111-8111-111111111111.sv.dxf')).rejects.toMatchObject({ code: 'EIO' });
  });
});
