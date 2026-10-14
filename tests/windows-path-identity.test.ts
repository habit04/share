import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWindowsPathIdentity, absoluteWindowsPath, canonicalInside, asciiCaseFold } = require('../electron/windows-path-identity.cjs');
const nativeFs = require('node:fs/promises') as typeof fs;
const privateRoot = path.resolve('.codex-local/windows-path-identity-tests'), roots: string[] = [];
async function setup() {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root); return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== privateRoot || !path.basename(root).startsWith('case-')) throw new Error('Unsafe private Windows path test cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('Windows path syntax and canonical comparisons', () => {
  it.each(['file.dxf', 'C:file.dxf', '\\file.dxf', 'C:\\', '\\\\?\\C:\\x.dxf', '\\\\.\\C:\\x.dxf', 'C:\\x.dxf:stream', 'C:\\NUL.dxf', 'C:\\x?.dxf', 'C:\\x.dxf ', `C:\\x\0.dxf`, 'C:\\x.dxf.'])('refuses ambiguous or non-absolute destination %j', (value) => {
    expect(() => absoluteWindowsPath(value)).toThrow();
  });
  it('preserves Unicode spelling and allows bounded drive and UNC paths', () => {
    expect(absoluteWindowsPath('C:/data/\u0130.dxf')).toBe('C:\\data\\\u0130.dxf');
    expect(absoluteWindowsPath('\\\\server\\share\\I\u0307.dxf')).toBe('\\\\server\\share\\I\u0307.dxf');
    expect(() => absoluteWindowsPath(`C:\\${'x'.repeat(4096)}.dxf`)).toThrow();
    expect(asciiCaseFold('\u0130\u212a\u212bAbC')).toBe('\u0130\u212a\u212babc');
  });
  it('uses exact separator-bounded canonical containment without Unicode or prefix aliases', () => {
    expect(canonicalInside('C:\\Picked', 'C:\\Picked\\a.dxf')).toBe(true);
    expect(canonicalInside('C:\\Picked', 'C:\\Picked2\\a.dxf')).toBe(false);
    for (const [first, second] of [['\u0130', 'I\u0307'], ['\u212a', 'K'], ['\u212b', '\u00c5'], ['\u{10400}', '\u{10428}']]) expect(canonicalInside(`C:\\${first}`, `C:\\${second}\\a.dxf`)).toBe(false);
  });
});

const pairs = [
  ['A', 'a'], ['\u00c9', '\u00e9'], ['\u03a3', '\u03c3'], ['\u1f80', '\u1f88'], ['\u0130', 'I\u0307'], ['\u0131', 'I'], ['\u212a', 'K'], ['\u212b', '\u00c5'],
  ['\u03c3', '\u03c2'], ['\u017f', 's'], ['\u00df', 'SS'], ['\u00df', '\u1e9e'], ['\u00c9', 'E\u0301'], ['\u{10400}', '\u{10428}'], ['\u{104b0}', '\u{104d8}'], ['\u10d0', '\u1c90'], ['\u13a0', '\uab70'], ['\u1d6a', 'I'], ['\ufb00', 'FF'],
] as const;
describe.runIf(process.platform === 'win32')('Native Windows write target identities', () => {
  it.each(pairs)('agrees with this volume exclusive-create identity for %j / %j', async (first, second) => {
    const root = await setup(), a = path.join(root, `${first}.dxf`), b = path.join(root, `${second}.dxf`);
    await fs.writeFile(a, 'first', { flag: 'wx' });
    let alias = false;
    try { await fs.writeFile(b, 'second', { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; alias = true; }
    const identity = createWindowsPathIdentity(), pinA = await identity.captureWriteTarget(a, root), pinB = await identity.captureWriteTarget(b, root);
    expect(pinA.canonicalPath === pinB.canonicalPath).toBe(alias);
    expect(pinA.targetKey === pinB.targetKey).toBe(alias);
    expect(pinA.queueKey).toBe(pinB.queueKey);
    expect(await fs.readFile(pinB.destinationPath, 'utf8')).toBe(alias ? 'first' : 'second');
    expect(Object.isFrozen(pinA)).toBe(true); expect(Object.isFrozen(pinA.fileVersion)).toBe(true);
  });
  it('retains the chosen logical parent while preserving native existing filename spelling', async () => {
    const root = await setup(), physical = path.join(root, 'Physical'), picked = path.join(root, 'Picked');
    await fs.mkdir(physical); await fs.symlink(physical, picked, 'junction');
    await fs.writeFile(path.join(physical, 'Case.dxf'), 'existing');
    const identity = createWindowsPathIdentity(), logical = path.join(picked, 'case.dxf'), pin = await identity.captureWriteTarget(logical, picked);
    expect(pin.logicalPath).toBe(logical); expect(pin.destinationPath).toBe(path.join(picked, 'Case.dxf'));
    expect(pin.canonicalPath).toBe(path.join(await fs.realpath(physical), 'Case.dxf'));
    expect((await identity.revalidate(pin, { preserveLeaf: true, preserveVersion: true })).fileVersion).toEqual(pin.fileVersion);
    await expect(identity.revalidate({ ...pin })).rejects.toMatchObject({ code: 'ERR_WINDOWS_IDENTITY' });
  });
  it('captures missing parents without making them and revalidates their ordinary materialization', async () => {
    const root = await setup(), file = path.join(root, 'New', 'Nested', 'file.dxf'), identity = createWindowsPathIdentity();
    const pin = await identity.captureWriteTarget(file, root);
    expect(pin.parentExists).toBe(false); expect(pin.missingParents).toEqual(['New', 'Nested']); expect(pin.fileVersion).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await identity.revalidate(pin); expect(current.parentExists).toBe(true); expect(current.canonicalParent).toBe(pin.canonicalParent);
  });
  it('refuses a directory destination and a lexical root escape before reading bytes', async () => {
    const root = await setup(), allowed = path.join(root, 'Allowed'), outside = path.join(root, 'Outside');
    await fs.mkdir(allowed); await fs.mkdir(outside);
    const identity = createWindowsPathIdentity();
    await expect(identity.captureWriteTarget(allowed, root)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(identity.captureWriteTarget(path.join(allowed, '..', 'Outside', 'out.dxf'), allowed)).rejects.toMatchObject({ code: 'ELOOP' });
  });
  it('refuses a file content change and externally changed stored case', async () => {
    const root = await setup(), file = path.join(root, 'Case.dxf'), identity = createWindowsPathIdentity();
    await fs.writeFile(file, 'before'); const pin = await identity.captureWriteTarget(file);
    await fs.writeFile(file, 'external longer edit');
    await expect(identity.revalidate(pin, { preserveVersion: true })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    const newer = await identity.captureWriteTarget(file); await fs.rename(file, path.join(root, 'case.dxf'));
    await expect(identity.revalidate(newer, { preserveLeaf: true })).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
  });
  it('refuses directory replacement even when its logical spelling is unchanged', async () => {
    const root = await setup(), parent = path.join(root, 'Parent'), identity = createWindowsPathIdentity();
    await fs.mkdir(parent); const pin = await identity.captureWriteTarget(path.join(parent, 'x.dxf'), root);
    await fs.rename(parent, path.join(root, 'Original')); await fs.mkdir(parent);
    await expect(identity.revalidate(pin)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
  });
  it('refuses chosen-root junction retargets to Unicode lowercasing-confusable siblings', async () => {
    const root = await setup(), inside = path.join(root, '\u0130'), outside = path.join(root, 'I\u0307'), picked = path.join(root, 'Picked');
    await fs.mkdir(inside); await fs.mkdir(outside); await fs.symlink(inside, picked, 'junction');
    const identity = createWindowsPathIdentity(), pin = await identity.captureWriteTarget(path.join(picked, 'x.dxf'), picked);
    await fs.unlink(picked); await fs.symlink(outside, picked, 'junction');
    await expect(identity.revalidate(pin)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('refuses a mutation between target metadata reads with actual private filesystem evidence', async () => {
    const root = await setup(), file = path.join(root, 'x.dxf'); await fs.writeFile(file, 'before'); let changed = false;
    const hooked = { ...nativeFs, stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await nativeFs.stat(...args);
      if (String(args[0]) === file && !changed) { changed = true; await nativeFs.writeFile(file, 'changed during capture'); }
      return result;
    } };
    await expect(createWindowsPathIdentity({ fs: hooked }).captureWriteTarget(file)).rejects.toMatchObject({ code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect(changed).toBe(true);
  });
});
