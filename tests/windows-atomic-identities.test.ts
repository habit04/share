import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fsp from 'node:fs/promises';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

const require = createRequire(import.meta.url);
type Writer = {
  atomicWriteFile(file: string, text: string, options?: { root?: string; backup?: boolean }): Promise<{ path: string; backup: string | null }>;
  copyFileAtomic(src: string, dest: string, options?: { root?: string }): Promise<string>;
  canonicalWriteKey(file: string): Promise<string>;
};
const { createAtomicWriter } = require('../electron/atomic-write.cjs') as {
  createAtomicWriter(fs?: unknown, options?: { hooks?: { beforeRename(tmp: string, dest: string): Promise<void> }; realpathFallback?: (path: string) => Promise<string> }): Writer;
};
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'jcad-native-write-identity-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe.runIf(process.platform === 'win32')('native Windows atomic destination identities', () => {
  it.each([['\u0130', 'I\u0307'], ['\u0131', 'I'], ['\u03c2', '\u03c3'], ['\u017f', 's']])('refuses distinct %s / %s directories as the same project root', async (chosen, outside) => {
    const root = join(dir, chosen), other = join(dir, outside);
    await mkdir(root); await mkdir(other);
    const file = join(other, 'drawing.dxf');
    await writeFile(file, 'OUTSIDE'); await writeFile(`${file}.bak`, 'OLD BACKUP');
    const writer = createAtomicWriter();
    await expect(writer.atomicWriteFile(file, 'FORBIDDEN', { root, backup: true })).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(writer.copyFileAtomic(file, `${file}.copy`, { root })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(file, 'utf8')).toBe('OUTSIDE');
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('OLD BACKUP');
    expect((await readdir(other)).sort()).toEqual(['drawing.dxf', 'drawing.dxf.bak']);
  });

  it('keeps distinct JavaScript-lowercase sibling files and backups independent', async () => {
    const first = join(dir, '\u0130.dxf'), second = join(dir, 'I\u0307.dxf');
    await writeFile(first, 'FIRST'); await writeFile(second, 'SECOND');
    const writer = createAtomicWriter();
    expect(await writer.canonicalWriteKey(first)).not.toBe(await writer.canonicalWriteKey(second));
    await writer.atomicWriteFile(first, 'FIRST EDIT', { backup: true });
    await writer.atomicWriteFile(second, 'SECOND EDIT', { backup: true });
    expect(await readFile(first, 'utf8')).toBe('FIRST EDIT');
    expect(await readFile(second, 'utf8')).toBe('SECOND EDIT');
    expect(await readFile(`${first}.bak`, 'utf8')).toBe('FIRST');
    expect(await readFile(`${second}.bak`, 'utf8')).toBe('SECOND');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([['Panel.dxf', 'panel.dxf'], ['\u1f80.dxf', '\u1f88.dxf']])('preserves stored leaf %s through native case alias %s', async (stored, alias) => {
    const file = join(dir, stored), alternate = join(dir, alias);
    await writeFile(file, 'ORIGINAL');
    expect(await realpath(file)).toBe(await realpath(alternate));
    const writer = createAtomicWriter();
    const key = await writer.canonicalWriteKey(file);
    expect(await writer.canonicalWriteKey(alternate)).toBe(key);
    const result = await writer.atomicWriteFile(alternate, 'NEW', { backup: true });
    expect(result.path).toBe(await realpath(file));
    expect(await writer.canonicalWriteKey(alternate)).toBe(key);
    expect((await readdir(dir)).sort()).toEqual([stored, `${stored}.bak`].sort());
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('ORIGINAL');
  });

  it('accepts a native case alias for the chosen root without changing the stored destination', async () => {
    const root = join(dir, '\u1f80'), alias = join(dir, '\u1f88');
    await mkdir(root);
    const file = join(root, 'Panel.dxf'); await writeFile(file, 'ORIGINAL');
    await createAtomicWriter().atomicWriteFile(join(alias, 'panel.dxf'), 'NEW', { root: alias, backup: true });
    expect(await readFile(file, 'utf8')).toBe('NEW');
    expect((await readdir(root)).sort()).toEqual(['Panel.dxf', 'Panel.dxf.bak']);
  });

  it('imports, edits, undoes and reopens a private native drawing through a Unicode case alias', async () => {
    const original = await readFile(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
    const file = join(dir, '\u1f80.dxf'), alias = join(dir, '\u1f88.dxf');
    await writeFile(file, original);
    const drawing = new Drawing(readDxf(await readFile(alias, 'utf8')));
    const count = drawing.entities.length;
    drawing.addEntities([{ id: 'case-edit', type: 'point', layer: '0', color: 'ByLayer', position: { x: 7, y: 9 } }]);
    expect(drawing.dirty).toBe(true); expect(drawing.undo()).toBe(true);
    expect(drawing.entities).toHaveLength(count); expect(drawing.redo()).toBe(true);
    const saved = writeDxf(drawing.snapshot);
    await createAtomicWriter().atomicWriteFile(alias, saved, { backup: true });
    const reopened = new Drawing(readDxf(await readFile(file, 'utf8')));
    expect(reopened.entities).toHaveLength(count + 1);
    expect(reopened.entities.some((entity) => entity.type === 'point' && entity.position.x === 7 && entity.position.y === 9)).toBe(true);
    expect(reopened.dirty).toBe(false);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original);
    expect((await readdir(dir)).sort()).toEqual(['\u1f80.dxf', '\u1f80.dxf.bak']);
  });

  it('retains rooted fallback saves when the provider cannot return native stored spelling', async () => {
    const root = join(dir, 'Chosen'), stored = join(root, 'Panel.dxf');
    await mkdir(root); await writeFile(stored, 'ORIGINAL');
    const writer = createAtomicWriter({ ...fsp, realpath: async () => { throw Object.assign(new Error('provider cannot resolve final handle path'), { code: 'EISDIR' }); } }, {
      // Node's link-by-link fallback can return this unchanged request spelling on Windows.
      realpathFallback: async (path) => path,
    });
    await writer.atomicWriteFile(join(root.toLowerCase(), 'panel.dxf'), 'NEW', { root, backup: true });
    expect(await readFile(stored, 'utf8')).toBe('NEW');
    expect((await readdir(root)).sort()).toEqual(['Panel.dxf', 'Panel.dxf.bak']);
    expect(await readFile(`${stored}.bak`, 'utf8')).toBe('ORIGINAL');
  });

  it('fallback directory identities also refuse distinct Unicode siblings', async () => {
    const root = join(dir, '\u0130'), other = join(dir, 'I\u0307');
    await mkdir(root); await mkdir(other);
    const outside = join(other, 'Panel.dxf'); await writeFile(outside, 'OUTSIDE');
    const writer = createAtomicWriter({ ...fsp, realpath: async () => { throw Object.assign(new Error('no native path'), { code: 'EISDIR' }); } }, { realpathFallback: async (path) => path });
    await expect(writer.atomicWriteFile(outside, 'REJECTED', { root, backup: true })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(outside, 'utf8')).toBe('OUTSIDE');
    expect(await readdir(other)).toEqual(['Panel.dxf']);
  });

  it('rejects a junction retarget into a distinct Unicode sibling before replacing or backing up a file', async () => {
    const root = join(dir, '\u0130'), outside = join(dir, 'I\u0307'), linked = join(dir, 'chosen');
    await mkdir(root); await mkdir(outside); await symlink(root, linked, 'junction');
    await writeFile(join(root, 'drawing.dxf'), 'INSIDE');
    await writeFile(join(outside, 'drawing.dxf'), 'OUTSIDE');
    let changed = false;
    const writer = createAtomicWriter(undefined, { hooks: { async beforeRename() {
      if (changed) return;
      changed = true; await unlink(linked); await symlink(outside, linked, 'junction');
    } } });
    await expect(writer.atomicWriteFile(join(linked, 'drawing.dxf'), 'REJECTED', { root, backup: true })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(join(root, 'drawing.dxf'), 'utf8')).toBe('INSIDE');
    expect(await readFile(join(outside, 'drawing.dxf'), 'utf8')).toBe('OUTSIDE');
    expect(await readdir(outside)).toEqual(['drawing.dxf']);
  });
});
