/** Native SHX authority is one selected file; font names from drawings cannot open files. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { shxFixture } from './helpers/shx-fixture';

const require = createRequire(import.meta.url);
const sourceUrl = new URL('../electron/main/ipc-shx.cjs', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8'), sourceRequire = createRequire(sourceUrl);
const nativeFs = require('node:fs/promises') as typeof fs;
const { guardIpc } = require('../electron/ipc-guard.cjs') as { guardIpc(raw: unknown, options: unknown): unknown };
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type Resource = { bytes: Uint8Array; resolvedPath: string; sha256: string; resourceId: string };
type Pick = { canceled: boolean; filePaths: string[] };
const roots: string[] = [];
const privateRoot = path.resolve('.codex-local/shx-ipc-tests');

async function directory(): Promise<string> {
  await fs.mkdir(privateRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(privateRoot, 'case-')); roots.push(root); return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(privateRoot);
    expect(path.basename(root)).toMatch(/^case-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function setup(platform: NodeJS.Platform = 'win32') {
  const handlers = new Map<string, Handler>();
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const webContents = { mainFrame: frame }, win = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  const showOpenDialog = vi.fn<(_win: unknown, _options: unknown) => Promise<Pick>>(async () => ({ canceled: true, filePaths: [] }));
  const reject = vi.fn();
  const ipcMain = guardIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject } });
  const senderWindow = vi.fn(() => win), grants = vi.fn();
  const reader = vi.fn(sourceRequire('../shx-resources.cjs').readShxResource as (request: unknown, options: { directories: string[] }) => Promise<Resource>);
  const module = { exports: {} as { registerShxIpc(ctx: unknown): void } };
  new Function('require', 'module', 'process', source)((name: string) => {
    if (name === 'electron') return { dialog: { showOpenDialog } };
    if (name === '../shx-resources.cjs') return { readShxResource: reader };
    return sourceRequire(name);
  }, module, { platform });
  module.exports.registerShxIpc({ ipcMain, senderWindow, registry: { grant: grants, grantRead: grants, addDirectory: grants }, pathPolicy: { known: grants }, rejections: { reject } });
  const invoke = (...args: unknown[]) => handlers.get('open-shx-font')!(event, ...args);
  const pick = (file: string) => showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
  return { handlers, event, frame, win, invoke, pick, showOpenDialog, senderWindow, reader, grants, reject };
}

describe('Windows explicit SHX chooser IPC', () => {
  it('reads exactly the native selection through its one-use directory and basename', async () => {
    const f = setup(), root = await directory(), file = path.join(root, 'Jos\u00e9.SHX'), bytes = shxFixture();
    await fs.writeFile(file, bytes); f.pick(file);
    const result = await f.invoke() as Resource;
    expect(result.bytes).toEqual(Uint8Array.from(bytes));
    expect(result.resolvedPath).toBe(await fs.realpath(file));
    expect(result.resourceId).toBe(JSON.stringify([result.resolvedPath, result.sha256]));
    expect(f.reader).toHaveBeenCalledExactlyOnceWith({ font: path.basename(file) }, { directories: [root] });
    expect(f.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.win, { title: 'Load SHX Font or Shapes', properties: ['openFile'], filters: [{ name: 'SHX Font or Shapes', extensions: ['shx'] }] });
    expect(f.grants).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(Buffer.from(bytes));
  });

  it('returns null on cancellation and allows the next native selection', async () => {
    const f = setup();
    expect(await f.invoke()).toBeNull(); expect(await f.invoke()).toBeNull();
    expect(f.showOpenDialog).toHaveBeenCalledTimes(2); expect(f.reader).not.toHaveBeenCalled(); expect(f.grants).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'font.shx', { path: 'C:\\private\\font.shx' }, { directories: ['C:\\private'] }, []])('rejects a renderer argument %j before native dialog or read', async (argument) => {
    const f = setup(); await expect(f.invoke(argument)).rejects.toThrow(/no renderer arguments/);
    expect(f.showOpenDialog).not.toHaveBeenCalled(); expect(f.reader).not.toHaveBeenCalled(); expect(f.grants).not.toHaveBeenCalled();
    expect(await f.invoke()).toBeNull();
  });

  it('rejects foreign windows, subframes and foreign pages before native selection', async () => {
    const f = setup(), handler = f.handlers.get('open-shx-font')!;
    const events = [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { ...f.frame, parent: f.frame, routingId: 2 } },
      { ...f.event, senderFrame: { ...f.frame, url: 'https://foreign.example/' } },
      { ...f.event, senderFrame: null },
    ];
    for (const event of events) expect(() => handler(event)).toThrow(/Unauthorized IPC caller/);
    expect(f.reject).toHaveBeenCalledTimes(4); expect(f.showOpenDialog).not.toHaveBeenCalled(); expect(f.reader).not.toHaveBeenCalled();
  });

  it('has no non-Windows handler', () => { expect(setup('linux').handlers.has('open-shx-font')).toBe(false); expect(setup('darwin').handlers.has('open-shx-font')).toBe(false); });

  it.each(['relative.shx', '../font.shx', '\\\\server\\fonts\\font.shx', '//server/fonts/font.shx', 'C:\\font.shx:payload', 'C:\\font.ttf', 'C:\\font.shx\u0000', 'C:\\font.shx\n', 'C:\\font.shx\u007f', `C:\\${'x'.repeat(4097)}.shx`])('rejects invalid native selection %j without any read', async (file) => {
    const f = setup(); f.pick(file); await expect(f.invoke()).rejects.toThrow(/local absolute SHX/);
    expect(f.reader).not.toHaveBeenCalled(); expect(f.grants).not.toHaveBeenCalled();
  });

  it('rejects missing or multiple native selections and does not queue excess requests', async () => {
    const f = setup();
    f.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] }).mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\one.shx', 'C:\\two.shx'] });
    await expect(f.invoke()).rejects.toThrow(/exactly one/); await expect(f.invoke()).rejects.toThrow(/exactly one/);
    expect(f.reader).not.toHaveBeenCalled();
  });

  it('allows only one pending dialog and reuses capacity after cancellation', async () => {
    const f = setup(); let finish!: (value: Pick) => void;
    f.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = f.invoke();
    await expect(f.invoke()).rejects.toThrow(/already pending/); expect(f.showOpenDialog).toHaveBeenCalledTimes(1);
    finish({ canceled: true, filePaths: [] }); expect(await first).toBeNull();
    expect(await f.invoke()).toBeNull(); expect(f.showOpenDialog).toHaveBeenCalledTimes(2);
  });

  it('recovers capacity after dialog and resource failures', async () => {
    const f = setup(), root = await directory(), file = path.join(root, 'font.shx');
    f.showOpenDialog.mockRejectedValueOnce(new Error('Native dialog failed'));
    await expect(f.invoke()).rejects.toThrow(/Native dialog failed/);
    f.pick(file); await expect(f.invoke()).rejects.toThrow(/not found/);
    await fs.writeFile(file, 'wrong font'); await expect(f.invoke()).rejects.toThrow(/recognized SHX/);
    await fs.writeFile(file, shxFixture()); await expect(f.invoke()).resolves.toMatchObject({ resolvedPath: await fs.realpath(file) });
    expect(f.showOpenDialog).toHaveBeenCalledTimes(4); expect(f.grants).not.toHaveBeenCalled();
  });

  it('refuses a native selection that is a directory or junction escaping its chosen parent', async () => {
    const f = setup(), root = await directory(), outside = await directory(), file = path.join(root, 'font.shx');
    await fs.mkdir(file); f.pick(file); await expect(f.invoke()).rejects.toThrow(/regular file/);
    await fs.rmdir(file); await fs.symlink(outside, file, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.invoke()).rejects.toThrow(/escapes/); expect(f.grants).not.toHaveBeenCalled();
  });

  it('refuses replacement between native selection inspection and opening, then recovers', async () => {
    const f = setup(), root = await directory(), file = path.join(root, 'font.shx'), bytes = shxFixture();
    await fs.writeFile(file, bytes); f.pick(file); const original = nativeFs.open.bind(nativeFs);
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(file, path.join(root, 'prior.shx')); await fs.writeFile(file, bytes); return original(...args);
    });
    await expect(f.invoke()).rejects.toThrow(/changed/);
    await expect(f.invoke()).resolves.toMatchObject({ resolvedPath: await fs.realpath(file) }); expect(f.grants).not.toHaveBeenCalled();
  });

  it('holds its slot through read-race descriptor cleanup and frees it only after close', async () => {
    const f = setup(), root = await directory(), file = path.join(root, 'font.shx'), bytes = shxFixture();
    await fs.writeFile(file, bytes); f.pick(file); const original = nativeFs.open.bind(nativeFs);
    let closing!: () => void, release!: () => void;
    const closingStarted = new Promise<void>((resolve) => { closing = resolve; });
    const closed = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(nativeFs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await original(...args), read = handle.read.bind(handle), close = handle.close.bind(handle); let mutated = false;
      handle.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); if (!mutated) { mutated = true; await fs.appendFile(file, new Uint8Array([0])); } return result; }) as typeof handle.read;
      handle.close = async () => { closing(); await closed; await close(); }; return handle;
    });
    const first = f.invoke(), settled = expect(first).rejects.toThrow(/changed/);
    await closingStarted; await expect(f.invoke()).rejects.toThrow(/already pending/); expect(f.showOpenDialog).toHaveBeenCalledTimes(1);
    release(); await settled;
    await fs.writeFile(file, bytes); await expect(f.invoke()).resolves.toMatchObject({ resolvedPath: await fs.realpath(file) }); expect(f.showOpenDialog).toHaveBeenCalledTimes(2);
  });

  it('preload exposes a Windows no-argument chooser and main wires the guarded module', async () => {
    const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
    const invoke = vi.fn(async () => null); let bridge!: { openShxFont?: (...args: unknown[]) => Promise<unknown> };
    const load = new Function('require', 'process', 'globalThis', preload);
    const electron = { contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } }, ipcRenderer: { invoke }, webFrame: {} };
    load(() => electron, { platform: 'win32' }, { location: { protocol: 'https:' } });
    await bridge.openShxFont!('C:\\renderer\\never.shx'); expect(invoke).toHaveBeenCalledExactlyOnceWith('open-shx-font');
    load(() => electron, { platform: 'linux' }, { location: { protocol: 'https:' } }); expect(bridge.openShxFont).toBeUndefined();
    expect(main).toContain("const { registerShxIpc } = require('./main/ipc-shx.cjs');"); expect(main).toContain('registerShxIpc(ctx);');
  });
});
