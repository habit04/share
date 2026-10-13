import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
type Source = { manifest: string; code: string; path: string };
type Options = { checkPath?: (file: string) => Promise<unknown> };
const { readPluginManifest, readPluginSource, MAX_PLUGIN_MANIFEST_BYTES, MAX_PLUGIN_CODE_BYTES } = require('../electron/plugin-files.cjs') as {
  readPluginManifest(root: string, folder: unknown, options?: Options): Promise<string>;
  readPluginSource(root: string, folder: unknown, options?: Options): Promise<Source | null>;
  MAX_PLUGIN_MANIFEST_BYTES: number; MAX_PLUGIN_CODE_BYTES: number;
};
const { createPathPolicy, guardIpc } = require('../electron/ipc-guard.cjs') as { createPathPolicy(options: unknown): any; guardIpc(raw: unknown, options: unknown): any };
const nativeFs = require('node:fs/promises') as typeof fs;
const privateRoot = path.resolve('.codex-local/plugin-files-tests'), roots: string[] = [];
async function privateDirectory(): Promise<string> { await fs.mkdir(privateRoot, { recursive: true }); const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root); return root; }
async function fixture(options: { manifest?: string; code?: string; folder?: string; prefix?: string } = {}) {
  const base = await privateDirectory(), root = path.join(base, options.prefix ?? 'plugins'), folder = options.folder ?? 'test', directory = path.join(root, folder);
  await fs.mkdir(directory, { recursive: true });
  const manifest = options.manifest ?? JSON.stringify({ name: 'test', main: 'main.js', apiVersion: 1 }), code = options.code ?? 'inside-root original code';
  await fs.writeFile(path.join(directory, 'plugin.json'), manifest); await fs.writeFile(path.join(directory, 'main.js'), code);
  return { base, root, folder, directory, manifest, code, file: path.join(directory, 'main.js') };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { expect(path.dirname(path.resolve(root))).toBe(privateRoot); expect(path.basename(root)).toMatch(/^case-/); await fs.rm(root, { recursive: true, force: true }); }
});

function stores(base: string) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(), frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' }, webContents = { mainFrame: frame }, win = { webContents, isDestroyed: () => false }, event = { sender: webContents, senderFrame: frame };
  const reject = vi.fn(), policy = createPathPolicy({ isKnownPath: () => false, knownPaths: () => [], log: { reject } });
  const ipc = guardIpc({ handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) }, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject } });
  const url = new URL('../electron/main/ipc-stores.cjs', import.meta.url), sourceRequire = createRequire(url), module = { exports: {} as { registerStoreIpc(ctx: unknown): void } };
  new Function('require', 'module', readFileSync(url, 'utf8'))((name: string) => name === 'electron' ? { dialog: {} } : name === './app-data.cjs' ? { stateDir: () => base, autosaveDir: () => path.join(base, 'autosave'), enqueueWrite: (_file: string, work: () => unknown) => work() } : sourceRequire(name), module);
  module.exports.registerStoreIpc({ ipcMain: ipc, pathPolicy: policy, senderWindow: () => win });
  return { handlers, frame, event, policy, reject, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}

describe('stable confined plugin files', () => {
  it('preserves manifest/code text, legacy defaults and logical paths', async () => {
    const f = await fixture({ manifest: JSON.stringify({ name: 'test' }), code: 'const accented = "José";' });
    expect(await readPluginManifest(f.root, f.folder)).toBe(f.manifest);
    expect(await readPluginSource(f.root, f.folder)).toEqual({ manifest: f.manifest, code: f.code, path: f.file });
    await fs.writeFile(path.join(f.directory, 'plugin.json'), 'broken JSON');
    expect(await readPluginSource(f.root, f.folder)).toMatchObject({ manifest: 'broken JSON', code: f.code });
  });
  it('returns null only for initially missing manifests and reports missing code', async () => {
    const base = await privateDirectory(), root = path.join(base, 'plugins');
    expect(await readPluginSource(root, 'missing')).toBeNull();
    const f = await fixture(); await fs.unlink(f.file);
    await expect(readPluginSource(f.root, f.folder)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([null, 1, '.', '..', '../other', '..\\other', 'test:stream', 'test\0', 'test/'.repeat(20), 'x'.repeat(65)])('refuses unsafe plugin folder %j', async (folder) => { await expect(readPluginSource(await privateDirectory(), folder)).rejects.toThrow(/folder name/); });
  it.each(['../main.js', '..\\main.js', 'main.js:secret', '/main.js', 'C:\\main.js', 'main.ts'])('refuses unsafe entry filename %j', async (main) => {
    const f = await fixture({ manifest: JSON.stringify({ name: 'test', main }) }); await expect(readPluginSource(f.root, f.folder)).rejects.toThrow(/\.js file/);
  });
  it('accepts empty regular source files and rejects directories and byte overruns', async () => {
    const f = await fixture({ code: '' }); expect(await readPluginSource(f.root, f.folder)).toMatchObject({ code: '' });
    await fs.unlink(f.file); await fs.mkdir(f.file); await expect(readPluginSource(f.root, f.folder)).rejects.toThrow(/regular file/);
    const large = await fixture({ code: 'x'.repeat(MAX_PLUGIN_CODE_BYTES + 1) }); await expect(readPluginSource(large.root, large.folder)).rejects.toThrow(/larger/);
    const header = await fixture({ manifest: ' '.repeat(MAX_PLUGIN_MANIFEST_BYTES + 1) }); await expect(readPluginManifest(header.root, header.folder)).rejects.toThrow(/larger/);
  });
  it('preserves stable aliases inside the plugins root while refusing outside aliases', async () => {
    const f = await fixture(), insideAlias = path.join(f.root, 'alias'), outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'plugin.json'), f.manifest); await fs.writeFile(path.join(outside, 'main.js'), 'outside sentinel');
    await fs.symlink(f.directory, insideAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readPluginSource(f.root, 'alias')).toEqual({ manifest: f.manifest, code: f.code, path: path.join(insideAlias, 'main.js') });
    await fs.symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readPluginSource(f.root, 'escape')).rejects.toThrow(/outside.*root/);
  });
  it('keeps distinct NTFS Unicode root spellings separate', async () => {
    const base = await privateDirectory(), names = ['Jos\u00e9', 'Jose\u0301'];
    for (const name of names) { const directory = path.join(base, name, 'test'); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'plugin.json'), '{}'); await fs.writeFile(path.join(directory, 'main.js'), name); }
    for (const name of names) expect(await readPluginSource(path.join(base, name), 'test')).toMatchObject({ code: name });
  });
  it.skipIf(process.platform !== 'win32')('rejects the native dotted-I Unicode sibling junction escape', async () => {
    const f = await fixture({ prefix: '\u0130' }), sibling = path.join(f.base, 'I\u0307'), target = path.join(sibling, 'test');
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'plugin.json'), f.manifest); await fs.writeFile(path.join(target, 'main.js'), 'outside Unicode sibling sentinel');
    await fs.symlink(target, path.join(f.root, 'escape'), 'junction');
    const canonicalRoot = await fs.realpath(f.root), canonicalSibling = await fs.realpath(sibling), canonicalFile = await fs.realpath(path.join(f.root, 'escape', 'main.js'));
    expect(canonicalRoot).not.toBe(canonicalSibling);
    // The legacy Windows API admits this sibling even though NTFS does not.
    expect(path.relative(canonicalRoot, canonicalFile)).toBe(path.join('test', 'main.js'));
    await expect(readPluginSource(f.root, 'escape')).rejects.toMatchObject({ code: 'ERR_PLUGIN_PATH' });
    expect(await readPluginSource(f.root, f.folder)).toMatchObject({ code: f.code });
  });
  it.skipIf(process.platform !== 'win32').each(['open', 'read'])('rejects a Unicode-fold alias root retarget during %s', async (stage) => {
    const f = await fixture({ prefix: '\u0130' }), sibling = path.join(f.base, 'I\u0307'), target = path.join(sibling, f.folder), picked = path.join(f.base, 'Picked');
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'plugin.json'), f.manifest); await fs.writeFile(path.join(target, 'main.js'), f.code);
    await fs.symlink(f.root, picked, 'junction');
    const open = nativeFs.open.bind(nativeFs); let reads = 0, closed = false, retargeted = false;
    const retarget = async () => { await fs.unlink(picked); await fs.symlink(sibling, picked, 'junction'); retargeted = true; };
    vi.spyOn(nativeFs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === 'main.js') {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...readArgs: any[]) => {
          reads++; const result = await (read as any)(...readArgs);
          if (stage === 'read' && !retargeted) await retarget();
          return result;
        }) as typeof handle.read;
        handle.close = async () => { closed = true; await close(); };
        if (stage === 'open') await retarget();
      }
      return handle;
    });
    await expect(readPluginSource(picked, f.folder)).rejects.toMatchObject({ code: 'ERR_PLUGIN_CHANGED' });
    expect(retargeted).toBe(true); expect(closed).toBe(true);
    expect(reads).toBe(stage === 'open' ? 0 : 2);
  });
  it('rejects folder retargets after a policy check without reading outside source bytes', async () => {
    const f = await fixture(), outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'main.js'), 'outside sentinel');
    const result = readPluginSource(f.root, f.folder, { checkPath: async (file) => {
      if (path.basename(file) === 'main.js') { await fs.rename(f.directory, path.join(f.root, 'retired')); await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
    } });
    await expect(result).rejects.toThrow(/outside.*root/);
  });
  it('refuses an open-time replacement before any code bytes are read and closes its handle', async () => {
    const f = await fixture(), outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'main.js'), f.code);
    const open = nativeFs.open.bind(nativeFs); let codeReads = 0, closed = false;
    vi.spyOn(nativeFs, 'open').mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === 'main.js') {
        await fs.rename(f.directory, path.join(f.root, 'retired')); await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
        const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...readArgs: any[]) => { codeReads++; return (read as any)(...readArgs); }) as typeof handle.read;
        handle.close = async () => { closed = true; await close(); }; return handle;
      }
      return open(...args);
    });
    await expect(readPluginSource(f.root, f.folder)).rejects.toThrow(/changed/); expect(codeReads).toBe(0); expect(closed).toBe(true);
  });
  it.each(['grow', 'shrink', 'same-size', 'replace'])('rejects %s during a code read', async (change) => {
    const f = await fixture(), open = nativeFs.open.bind(nativeFs); let changed = false;
    vi.spyOn(nativeFs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === 'main.js') {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: any[]) => {
          const result = await (read as any)(...readArgs);
          if (!changed) {
            changed = true;
            if (change === 'grow') await fs.appendFile(f.file, 'extra');
            else if (change === 'shrink') await fs.truncate(f.file, 1);
            else if (change === 'same-size') await fs.writeFile(f.file, 'y'.repeat(f.code.length));
            else { await fs.rename(f.file, path.join(f.directory, 'old.js')); await fs.writeFile(f.file, f.code); }
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(readPluginSource(f.root, f.folder)).rejects.toThrow(/changed/);
  });
});

describe('actual plugin IPC callback with native filesystem', () => {
  it.skipIf(process.platform !== 'win32')('rejects a Unicode sibling junction outside the global plugin root', async () => {
    const base = await privateDirectory(), appBase = path.join(base, '\u0130'), root = path.join(appBase, 'plugins'), target = path.join(base, 'I\u0307', 'plugins', 'test');
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'plugin.json'), '{}'); await fs.writeFile(path.join(target, 'main.js'), 'outside Unicode sibling sentinel');
    await fs.symlink(target, path.join(root, 'test'), 'junction');
    const app = stores(appBase);
    const opened = vi.spyOn(nativeFs, 'open');
    // Either the shared policy or the held-descriptor reader may refuse first.
    await expect(app.invoke('plugins-read', 'test')).rejects.toThrow();
    expect(await app.invoke('plugins-list')).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });
  it('retains listing/error behavior and source paths through the checked sender boundary', async () => {
    const f = await fixture(), app = stores(f.base); expect(await app.invoke('plugins-read', f.folder)).toEqual({ manifest: f.manifest, code: f.code, path: f.file });
    expect(await app.invoke('plugins-list')).toEqual([{ folder: f.folder, manifest: f.manifest }]);
    await fs.mkdir(path.join(f.root, 'missing')); expect(await app.invoke('plugins-list')).toContainEqual({ folder: 'missing', manifest: null, error: 'no plugin.json' });
    expect(await app.invoke('plugins-read', 'missing')).toBeNull();
    expect(() => app.handlers.get('plugins-read')!({ ...app.event, senderFrame: { ...app.frame, parent: app.frame } }, f.folder)).toThrow(/Unauthorized IPC caller/);
  });
  it('rejects the reproduced policy-check/junction-open race', async () => {
    const f = await fixture(), app = stores(f.base), outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'main.js'), 'outside sentinel');
    const check = app.policy.insideRoot.bind(app.policy);
    app.policy.insideRoot = async (root: string, file: string, what: string) => {
      const result = await check(root, file, what);
      if (what === 'plugins-read' && path.basename(file) === 'main.js') { await fs.rename(f.directory, path.join(f.root, 'retired')); await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
      return result;
    };
    await expect(app.invoke('plugins-read', f.folder)).rejects.toThrow(/outside.*root/);
  });
});
