/** DWG saves and export copies require native path authority and preserve atomic backups. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const sourceUrl = new URL('../electron/main/ipc-drawings.cjs', import.meta.url);
const sourceRequire = createRequire(sourceUrl);
const source = readFileSync(sourceUrl, 'utf8');
type Handler = (ev: unknown, ...args: unknown[]) => Promise<unknown>;
type Registry = {
  grant(file: string): boolean;
  grantRead(file: string): boolean;
  isKnown(file: string): boolean;
  isWritable(file: string): boolean;
  writeRoot(file: string): string | null;
  registerProject(file: string, project: unknown, opts?: { userChosen?: boolean }): unknown;
  paths(): Iterable<string>;
};
const { createPathRegistry } = require('../electron/path-registry.cjs') as { createPathRegistry(): Registry };
const { createPathPolicy, dxfImageNames } = require('../electron/ipc-guard.cjs') as {
  createPathPolicy(opts: unknown): { rememberImages: (file: string, names: string[]) => void };
  dxfImageNames(text: string): string[];
};
type AtomicWriter = { atomicWriteFile(file: string, bytes: Buffer, options: { backup: boolean; expectedDestination: string; root?: string }): Promise<void> };
const atomic = require('../electron/atomic-write.cjs') as { createAtomicWriter(fileSystem?: typeof fs, options?: { hooks: { beforeRename(): Promise<void> } }): AtomicWriter; createCanonicalWriteQueue(): (file: string, callback: (key: string) => Promise<void>) => Promise<void> };
const roots: string[] = [];
const DXF = '0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
const OUTPUT = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(130)]);

afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^jcad-portable-dwg-ipc-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setup(platform: NodeJS.Platform = 'win32') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'jcad-portable-dwg-ipc-'));
  roots.push(root);
  const target = path.join(root, 'drawing.dwg');
  const registry = createPathRegistry();
  const reject = vi.fn();
  const pathPolicy = createPathPolicy({ isKnownPath: (p: string) => registry.isKnown(p), isWritablePath: (p: string) => registry.isWritable(p), knownPaths: () => registry.paths(), log: { reject } });
  const rememberImages = vi.spyOn(pathPolicy, 'rememberImages');
  const webContents = new EventEmitter();
  const win = Object.assign(new EventEmitter(), { webContents });
  const status = vi.fn(async () => ({ available: true, reason: undefined as string | undefined }));
  const exportCall = vi.fn(async (file: string, _text: string, commit: (file: string, bytes: Buffer, check: () => Promise<void>) => Promise<void>, signal: AbortSignal) => {
    const check = async () => { if (signal.aborted) throw new Error('Canceled'); };
    await check();
    await commit(file, OUTPUT, check);
    return file;
  });
  const showSaveDialog = vi.fn(async (_win: unknown, _opts: unknown) => ({ canceled: false, filePath: target }));
  const showOpenDialog = vi.fn(async (_win: unknown, _opts: unknown) => ({ canceled: false, filePaths: [target] }));
  const showMessageBox = vi.fn(async (_win: unknown, _opts: unknown) => ({ response: 0 }));
  const writeUserFile = vi.fn();
  const readDwgWithProgress = vi.fn(async () => ({ payload: { imageDefs: [] }, version: 'AC1032' }));
  const handlers = new Map<string, Handler>();
  const writerFactory = vi.fn((fileSystem?: typeof fs, options?: { hooks: { beforeRename(): Promise<void> } }) => atomic.createAtomicWriter(fileSystem, options));
  const enqueueWrite = atomic.createCanonicalWriteQueue();
  const module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  new Function('require', 'module', 'process', source)((name: string) => {
    if (name === 'electron') return { dialog: { showSaveDialog, showOpenDialog, showMessageBox } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status, export: exportCall }) };
    if (name === '../atomic-write.cjs') return { ...atomic, createAtomicWriter: writerFactory };
    if (name === './app-data.cjs') return { writeUserFile, enqueueWrite };
    if (name === './dwg.cjs') return { decodeDxf: vi.fn(), readDwgWithProgress };
    return sourceRequire(name);
  }, module, { platform });
  module.exports.registerDrawingIpc({ ipcMain: { handle: (name: string, fn: Handler) => handlers.set(name, fn) }, rejections: { reject }, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { root, target, registry, invoke, status, exportCall, showSaveDialog, showOpenDialog, showMessageBox, rememberImages, win, writerFactory, writeUserFile };
}

describe('portable DWG IPC', () => {
  it('uses a dedicated native picker and publishes portable availability', async () => {
    const f = await setup();
    expect(await f.invoke('dwg-export-status')).toEqual({ available: true, reason: undefined });
    expect(await f.invoke('choose-dwg-path', 'Panel.dwg')).toBe(f.target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ title: 'Export DWG Copy', defaultPath: 'Panel.dwg', filters: [{ name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }] }));
    expect(f.registry.isWritable(f.target)).toBe(true);
  });

  it('normal native drawing authority never grants export-copy permission', async () => {
    const f = await setup();
    f.registry.grant(f.target);
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  it('commits through a canonical reservation with backups and a pre-rename guard, then records image references', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original DWG bytes');
    await f.invoke('choose-dwg-path', 'drawing.dwg');
    expect(await f.invoke('export-dwg', f.target, DXF)).toBe(f.target);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original DWG bytes');
    expect(f.writerFactory).toHaveBeenCalledWith(undefined, expect.objectContaining({ hooks: { beforeRename: expect.any(Function) } }));
    expect(f.rememberImages).toHaveBeenCalledWith(f.target, dxfImageNames(DXF));
    expect(f.win.listenerCount('closed')).toBe(0);
    expect(f.win.webContents.listenerCount('destroyed')).toBe(0);
    expect(f.win.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it.each(['export-dwg', 'save-dwg'])('%s cancels when the caller closes, keeping the original and clearing listeners', async (channel) => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    await f.invoke('choose-dwg-path');
    f.exportCall.mockImplementation(async (_file, _text, _commit, signal) => {
      f.win.emit('closed');
      expect(signal.aborted).toBe(true);
      throw new Error('Canceled');
    });
    await expect(f.invoke(channel, f.target, DXF)).rejects.toThrow(/Canceled/);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    expect(f.rememberImages).not.toHaveBeenCalled();
    expect(f.win.listenerCount('closed')).toBe(0);
  });

  it.each(['destroyed', 'render-process-gone'].flatMap((event) => ['export-dwg', 'save-dwg'].map((channel) => [event, channel])))('%s cancels the originating renderer\'s %s', async (event, channel) => {
    const f = await setup();
    await f.invoke('choose-dwg-path');
    f.exportCall.mockImplementation(async (_file, _text, _commit, signal) => {
      f.win.webContents.emit(event);
      expect(signal.aborted).toBe(true);
      throw new Error('Canceled');
    });
    await expect(f.invoke(channel, f.target, DXF)).rejects.toThrow(/Canceled/);
  });

  it('rejects invalid payloads and destinations without launching a writer', async () => {
    const f = await setup();
    await f.invoke('choose-dwg-path');
    for (const text of [null, { text: DXF }]) await expect(f.invoke('export-dwg', f.target, text)).rejects.toThrow(/Invalid DXF payload/);
    for (const target of ['relative.dwg', `${f.target}\0`, path.join(f.root, 'other.dxf')]) await expect(f.invoke('export-dwg', target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  it('refuses unavailable writers and canceled or malformed native picker results', async () => {
    const f = await setup();
    f.status.mockResolvedValue({ available: false, reason: 'Broken writer' });
    await expect(f.invoke('choose-dwg-path')).rejects.toThrow('Broken writer');
    expect(f.showSaveDialog).not.toHaveBeenCalled();
    f.status.mockResolvedValue({ available: true, reason: undefined });
    f.showSaveDialog.mockResolvedValue({ canceled: true, filePath: f.target });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'relative.dwg' });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    await expect(f.invoke('choose-dwg-path', 'bad\0name')).rejects.toThrow(/Invalid DWG filename/);
  });

  it('confirms replacement after completing an extension instead of overwriting an unconfirmed DWG', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target.slice(0, -4) });
    f.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    f.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await f.invoke('choose-dwg-path')).toBe(f.target);
    expect(f.registry.isWritable(f.target)).toBe(true);
  });

  it.each(['dxf', 'dwg'])('offers both Windows Save As formats with the suggested %s first, writing nothing in the dialog', async (format) => {
    const f = await setup();
    const target = path.join(f.root, `Panel.${format}`);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', `Panel.${format}`)).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({
      title: 'Save Drawing As', defaultPath: `Panel.${format}`,
      filters: format === 'dwg'
        ? [{ name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }, { name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }]
        : [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }, { name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }],
    }));
    expect(f.registry.isWritable(target)).toBe(true);
    expect(f.exportCall).not.toHaveBeenCalled();
    expect(f.writeUserFile).not.toHaveBeenCalled();
  });

  it.each([['Panel.dxf', 'drawing.DWG'], ['Panel.dwg', 'drawing.DXF']])('honors the typed extension when %s suggests another format', async (suggestName, chosenName) => {
    const f = await setup();
    const target = path.join(f.root, chosenName);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', suggestName)).toBe(target);
    expect(f.registry.isWritable(target)).toBe(true);
  });

  it('keeps explicit DXF exports DXF-only on Windows and validates the format option', async () => {
    const f = await setup();
    const target = path.join(f.root, 'drawing.dxf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target.slice(0, -4) });
    expect(await f.invoke('choose-drawing-path', 'Panel.dwg', 'dxf')).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ defaultPath: 'Panel.dxf', filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }] }));
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target });
    await expect(f.invoke('choose-drawing-path', 'Panel.dwg', 'dxf')).rejects.toThrow(/supported drawing extension/);
    expect(f.registry.isKnown(f.target)).toBe(false);
    f.showSaveDialog.mockClear();
    for (const format of [null, 'dwg', {}, true]) await expect(f.invoke('choose-drawing-path', 'Panel.dxf', format)).rejects.toThrow(/Invalid drawing format/);
    expect(f.showSaveDialog).not.toHaveBeenCalled();
  });

  it('confirms extensionless Save As replacement using the suggested format', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target.slice(0, -4) });
    f.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await f.invoke('choose-drawing-path', 'drawing.dwg')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    f.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await f.invoke('choose-drawing-path', 'drawing.dwg')).toBe(f.target);
    expect(await f.invoke('save-dwg', f.target, DXF)).toBe(f.target);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original');
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
  });

  it('refuses malformed and unsupported Save As destinations and cancellation without granting paths', async () => {
    const f = await setup();
    for (const target of ['relative.dwg', `${f.target}\0`]) {
      f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
      expect(await f.invoke('choose-drawing-path')).toBe(null);
    }
    const unsupported = path.join(f.root, 'drawing.pdf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: unsupported });
    await expect(f.invoke('choose-drawing-path')).rejects.toThrow(/supported drawing extension/);
    expect(f.registry.isKnown(unsupported)).toBe(false);
    f.showSaveDialog.mockResolvedValue({ canceled: true, filePath: f.target });
    expect(await f.invoke('choose-drawing-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    await expect(f.invoke('choose-drawing-path', 'bad\0name')).rejects.toThrow(/Invalid drawing filename/);
  });

  it.each(['darwin', 'linux'] as const)('keeps %s Save As DXF-only and refuses native DWG Save', async (platform) => {
    const f = await setup(platform);
    const target = path.join(f.root, 'drawing.dxf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', 'Panel.dxf')).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }] }));
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target });
    await expect(f.invoke('choose-drawing-path', 'Panel.dwg')).rejects.toThrow(/supported drawing extension/);
    f.registry.grant(f.target);
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Windows only/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  it('saves a DWG opened through the native dialog using the verified writer and an atomic backup', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    expect(await f.invoke('open-drawing')).toEqual({ path: f.target, kind: 'dwg', payload: { imageDefs: [] }, version: 'AC1032' });
    expect(await f.invoke('save-dwg', f.target, DXF)).toBe(f.target);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original');
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown, read-only, wrong-format and invalid DWG Save requests without launching a writer', async () => {
    const f = await setup();
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Save As first/);
    f.registry.grantRead(f.target);
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Save As first/);
    f.registry.grant(f.target);
    for (const target of [null, 'relative.dwg', `${f.target}\0`, path.join(f.root, 'drawing.dxf')]) await expect(f.invoke('save-dwg', target, DXF)).rejects.toThrow(/Save As first/);
    for (const text of [null, { text: DXF }]) await expect(f.invoke('save-dwg', f.target, text)).rejects.toThrow(/Invalid DXF payload/);
    await expect(f.invoke('save-dxf', f.target, DXF)).rejects.toThrow(/Invalid path/);
    expect(f.exportCall).not.toHaveBeenCalled();
    expect(f.writeUserFile).not.toHaveBeenCalled();
  });

  it('retains a by-name project\'s confinement when a linked DWG folder points outside it', async () => {
    const f = await setup();
    const project = path.join(f.root, 'project');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(project);
    await fs.mkdir(outside);
    const link = path.join(project, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(link, 'drawing.dwg');
    const original = path.join(outside, 'drawing.dwg');
    await fs.writeFile(original, 'original');
    f.registry.registerProject(path.join(project, 'Project.jcadproj.json'), { drawings: [{ file: target }] });
    expect(f.registry.isWritable(target)).toBe(true);
    expect(f.registry.writeRoot(target)).toBe(project);
    await expect(f.invoke('save-dwg', target, DXF)).rejects.toThrow(/ELOOP/);
    expect(await fs.readFile(original, 'utf8')).toBe('original');
    await expect(fs.access(`${original}.bak`)).rejects.toThrow();
    expect(f.rememberImages).not.toHaveBeenCalled();
  });
});
