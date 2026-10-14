import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shxFixture } from './helpers/shx-fixture';

const require = createRequire(import.meta.url);
const { readShxResource, MAX_SHX_BYTES } = require('../electron/shx-resources.cjs') as {
  readShxResource(request: unknown, options: { directories: readonly string[] }): Promise<{ bytes: Uint8Array; resolvedPath: string; sha256: string; resourceId: string }>;
  MAX_SHX_BYTES: number;
};
const nativeFs = require('node:fs/promises') as typeof fs;
const roots: string[] = [];
async function directory(): Promise<string> { const root = await fs.mkdtemp(path.join(tmpdir(), 'jcad-shx-')); roots.push(root); return root; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { const relative = path.relative(tmpdir(), root); if (!relative.startsWith('jcad-shx-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe SHX test cleanup path'); await fs.rm(root, { recursive: true, force: true }); }
});

describe('confined SHX resource reads', () => {
  it('reads a same-FD byte snapshot with exact path/content identity', async () => {
    const root = await directory(), bytes = shxFixture(), file = path.join(root, 'custom.shx'); await fs.writeFile(file, bytes);
    const result = await readShxResource({ font: 'custom' }, { directories: [root] });
    expect(result.bytes).toEqual(Uint8Array.from(bytes)); expect(result.resolvedPath).toBe(await fs.realpath(file));
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(result.resourceId).toBe(JSON.stringify([result.resolvedPath, result.sha256]));
  });
  it('searches trusted roots in order and does not alias same-named resources', async () => {
    const first = await directory(), second = await directory(); await fs.writeFile(path.join(second, 'font.shx'), shxFixture());
    const result = await readShxResource({ font: 'font.shx' }, { directories: [first, second] }); expect(result.resolvedPath).toBe(await fs.realpath(path.join(second, 'font.shx')));
    await fs.writeFile(path.join(first, 'font.shx'), shxFixture()); const other = await readShxResource({ font: 'font.shx' }, { directories: [first, second] }); expect(other.resourceId).not.toBe(result.resourceId);
  });
  it.each(['../font.shx', '..\\font.shx', 'C:\\font.shx', '/font.shx', '\\\\host\\font.shx', 'font.shx:secret', 'file.ttf', 'NUL.shx', 'NUL .shx', 'com1.shx', 'font\0.shx', ' font.shx', 'font.shx ', 'font.'])('refuses unsafe filename %j', async (font) => {
    await expect(readShxResource({ font }, { directories: [await directory()] })).rejects.toThrow(/filename|SHX|safe/);
  });
  it.each([null, {}, { font: 1 }, [], 'font.shx'])('refuses malformed requests %j', async (request) => { await expect(readShxResource(request, { directories: [await directory()] })).rejects.toThrow(/request/); });
  it('refuses missing, unauthorized, nonfile, oversized and non-SHX resources', async () => {
    const root = await directory();
    await expect(readShxResource({ font: 'font.shx' }, { directories: [] })).rejects.toThrow(/authorized/);
    await expect(readShxResource({ font: 'font.shx' }, { directories: ['relative'] })).rejects.toThrow(/directory/);
    await expect(readShxResource({ font: 'font.shx' }, { directories: [root] })).rejects.toThrow(/not found/);
    await fs.mkdir(path.join(root, 'font.shx')); await expect(readShxResource({ font: 'font.shx' }, { directories: [root] })).rejects.toThrow(/regular file/);
    await fs.writeFile(path.join(root, 'large.shx'), new Uint8Array(MAX_SHX_BYTES + 1)); await expect(readShxResource({ font: 'large.shx' }, { directories: [root] })).rejects.toThrow(/bounded/);
    await fs.writeFile(path.join(root, 'wrong.shx'), 'not a font'); await expect(readShxResource({ font: 'wrong.shx' }, { directories: [root] })).rejects.toThrow(/recognized/);
  });
  it('refuses resource junctions escaping an authorized root', async () => {
    const root = await directory(), outside = await directory(); await fs.writeFile(path.join(outside, 'font.shx'), shxFixture());
    await fs.symlink(outside, path.join(root, 'fonts'), process.platform === 'win32' ? 'junction' : 'dir');
    // A trusted root may itself resolve through an explicitly selected junction.
    const selected = await readShxResource({ font: 'font.shx' }, { directories: [path.join(root, 'fonts')] }); expect(selected.resolvedPath).toBe(await fs.realpath(path.join(outside, 'font.shx')));
    await fs.symlink(outside, path.join(root, 'font.shx'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readShxResource({ font: 'font.shx' }, { directories: [root] })).rejects.toThrow(/escapes/);
  });
  it('refuses a path replacement between inspection and open', async () => {
    const root = await directory(), file = path.join(root, 'font.shx'), bytes = shxFixture(); await fs.writeFile(file, bytes);
    const original = nativeFs.open.bind(nativeFs);
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => { await fs.rename(file, path.join(root, 'old.shx')); await fs.writeFile(file, bytes); return original(...args); });
    await expect(readShxResource({ font: 'font.shx' }, { directories: [root] })).rejects.toThrow(/changed/);
  });
  it('refuses changes during a read and closes the held descriptor', async () => {
    const root = await directory(), file = path.join(root, 'font.shx'); await fs.writeFile(file, shxFixture());
    const original = nativeFs.open.bind(nativeFs); let closed = false;
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await original(...args), read = handle.read.bind(handle), close = handle.close.bind(handle); let changed = false;
      handle.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); if (!changed) { changed = true; await fs.appendFile(file, new Uint8Array([0])); } return result; }) as typeof handle.read;
      handle.close = async () => { closed = true; await close(); }; return handle;
    });
    await expect(readShxResource({ font: 'font.shx' }, { directories: [root] })).rejects.toThrow(/changed/); expect(closed).toBe(true);
  });
  it('ignores request-supplied directories and snapshots the trusted root list', async () => {
    const root = await directory(), outside = await directory(), directories = [root];
    await fs.writeFile(path.join(outside, 'font.shx'), shxFixture());
    const pending = readShxResource({ font: 'font.shx', directories: [outside] }, { directories }); directories[0] = outside;
    await expect(pending).rejects.toThrow(/not found/);
  });
});
