/** Canonical Windows paths must not be compared through JavaScript Unicode case conversion. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { shxFixture, fontRecords } from './helpers/shx-fixture';

const require = createRequire(import.meta.url), nativeFs = require('node:fs/promises') as typeof fs;
const { readShxResource } = require('../electron/shx-resources.cjs') as { readShxResource(request: unknown, options: { directories: string[] }): Promise<{ bytes: Uint8Array; resolvedPath: string }> };
const privateRoot = path.resolve('.codex-local/shx-canonical-containment-tests'), roots: string[] = [];
const pairs = [['\u0130', 'I\u0307'], ['\u212a', 'K'], ['\u{10400}', '\u{10428}']] as const;
function checkInside(root: string, file: string): void {
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!path.resolve(file).startsWith(prefix)) throw new Error('Unsafe private SHX test path');
}
async function setup(first: string, second: string) {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root);
  const inside = path.join(root, first), outside = path.join(root, second), picked = path.join(root, 'Picked');
  for (const file of [inside, outside, picked]) checkInside(root, file);
  await fs.mkdir(inside); await fs.mkdir(outside);
  const original = shxFixture(), different = shxFixture('unifont', [{ ...fontRecords[0]!, program: [20, 2, 2, 0, 0, 0] }, ...fontRecords.slice(1)]);
  await fs.writeFile(path.join(inside, 'font.shx'), original); await fs.writeFile(path.join(outside, 'font.shx'), different);
  const actualInside = await fs.realpath(inside), actualOutside = await fs.realpath(outside);
  expect(actualInside).not.toBe(actualOutside); expect(await fs.readdir(root)).toHaveLength(2);
  await fs.symlink(inside, picked, 'junction');
  const retarget = async () => {
    // Both the junction and its current resolved target stay under this test's root.
    checkInside(root, picked); checkInside(root, await fs.realpath(picked));
    await fs.unlink(picked); await fs.symlink(outside, picked, 'junction');
  };
  return { root, inside, outside, picked, original, different, retarget };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    checkInside(privateRoot, root);
    expect(path.dirname(root)).toBe(privateRoot); expect(path.basename(root)).toMatch(/^case-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')('SHX canonical Windows containment and retargets', () => {
  it.each(pairs)('rejects an opened-handle junction retarget from %j to %j before reading', async (first, second) => {
    const f = await setup(first, second), open = nativeFs.open.bind(nativeFs); let closed = false, readCount = 0;
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args), close = handle.close.bind(handle), read = handle.read.bind(handle);
      handle.close = async () => { closed = true; await close(); };
      handle.read = (async (...readArgs: any[]) => { readCount++; return await (read as any)(...readArgs); }) as typeof handle.read;
      await f.retarget(); return handle;
    });
    await expect(readShxResource({ font: 'font.shx' }, { directories: [f.picked] })).rejects.toThrow(/changed/);
    expect(closed).toBe(true); expect(readCount).toBe(0);
    expect(await fs.readFile(path.join(f.outside, 'font.shx'))).toEqual(Buffer.from(f.different));
  });

  it.each(pairs)('rejects a same-handle post-read junction retarget from %j to %j and closes the descriptor', async (first, second) => {
    const f = await setup(first, second), open = nativeFs.open.bind(nativeFs); let closed = false;
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args), close = handle.close.bind(handle), read = handle.read.bind(handle); let retargeted = false;
      handle.close = async () => { closed = true; await close(); };
      handle.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); if (!retargeted) { retargeted = true; await f.retarget(); } return result; }) as typeof handle.read;
      return handle;
    });
    await expect(readShxResource({ font: 'font.shx' }, { directories: [f.picked] })).rejects.toThrow(/changed/);
    expect(closed).toBe(true); expect(await fs.readFile(path.join(f.inside, 'font.shx'))).toEqual(Buffer.from(f.original));
    expect(await fs.readFile(path.join(f.outside, 'font.shx'))).toEqual(Buffer.from(f.different));
  });

  it('preserves a stable selected junction and native ASCII filename/root case aliases', async () => {
    const f = await setup('\u0130', 'I\u0307');
    const result = await readShxResource({ font: 'FONT.SHX' }, { directories: [f.picked.replace(/Picked$/, 'picked')] });
    expect(result.bytes).toEqual(Uint8Array.from(f.original)); expect(result.resolvedPath).toBe(await fs.realpath(path.join(f.inside, 'font.shx')));
    expect(result.resolvedPath.startsWith(`${await fs.realpath(f.inside)}${path.sep}`)).toBe(true);
  });

  it('rejects a static file-link escape into a distinct Unicode sibling', async (context) => {
    const f = await setup('\u0130', 'I\u0307'), link = path.join(f.inside, 'escape.shx');
    try { await fs.symlink(path.join(f.outside, 'font.shx'), link, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Windows file symbolic links require developer mode or privilege; junction retarget cases remain active.'); return; }
      throw error;
    }
    await expect(readShxResource({ font: 'escape.shx' }, { directories: [f.inside] })).rejects.toThrow(/escapes/);
    expect(await fs.readFile(path.join(f.outside, 'font.shx'))).toEqual(Buffer.from(f.different));
  });
});
