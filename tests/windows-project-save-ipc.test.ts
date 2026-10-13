import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';

const sourceUrl = new URL('../electron/main/ipc-drawings.cjs', import.meta.url);
const require = createRequire(sourceUrl), source = readFileSync(sourceUrl, 'utf8');
type Handler = (ev: unknown, ...args: unknown[]) => unknown;
type Binding = { index: number; path: string; childTicket: string; identityPath: string; exists: true } | { index: number; path: string; missing: true };
type Opened = { path: string; identityPath: string; kind: 'dxf'; text: string };
const atomic = require('../atomic-write.cjs') as {
  atomicWriteFile(file: string, text: string, opts?: unknown): Promise<unknown>;
  createCanonicalWriteQueue(): (file: string, fn: (key: string) => Promise<unknown>) => Promise<unknown>;
};
const { createPathRegistry } = require('../path-registry.cjs') as { createPathRegistry(): {
  grant(file: string): boolean; isKnown(file: string): boolean; isWritable(file: string): boolean; paths(): Iterable<string>;
  writeRoot(file: string): string | null; registerProject(file: string, contents: unknown): unknown;
} };
const { createPathPolicy, guardIpc } = require('../ipc-guard.cjs') as {
  createPathPolicy(deps: unknown): unknown; guardIpc(raw: unknown, options: unknown): unknown;
};
const nativeFixture = readFileSync(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'jcad-native-project-save-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

function setup() {
  const registry = createPathRegistry(), handlers = new Map<string, Handler>(), log = { reject: vi.fn() };
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents });
  const ev = { sender: contents, senderFrame: frame };
  const raw = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const ipcMain = guardIpc(raw, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log });
  const pathPolicy = createPathPolicy({ isKnownPath: (file: string) => registry.isKnown(file), isWritablePath: (file: string) => registry.isWritable(file), knownPaths: () => registry.paths(), log });
  const dialog = { showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn() };
  const enqueueWrite = atomic.createCanonicalWriteQueue(), module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  new Function('require', 'module', source)((name: string) => {
    if (name === 'electron') return { dialog };
    if (name === './app-data.cjs') return { enqueueWrite, writeUserFile: (file: string, text: string, opts: unknown) => enqueueWrite(file, key => atomic.atomicWriteFile(file, text, { ...(opts as object), expectedDestination: key })) };
    if (name === './dwg.cjs') return { decodeDxf: (bytes: Uint8Array) => Promise.resolve(decodeDxfBytes(bytes)), readDwgWithProgress: () => { throw new Error('No native DWG decoder in this DXF test.'); } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status: () => ({ available: false }), export: () => { throw new Error('No native writer fixture.'); } }) };
    return require(name);
  }, module);
  module.exports.registerDrawingIpc({ ipcMain, rejections: log, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  const reserve = async (file: string) => {
    const ticket = await invoke('issue-save-admission', 'drawing') as string;
    await invoke('bind-save-admission', ticket, 'drawing', file); return ticket;
  };
  const files = async (count: number) => {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `Sheet-${i}.dxf`); await fs.writeFile(file, nativeFixture); registry.grant(file); paths.push(file);
    }
    return paths;
  };
  const bind = async (paths: string[]) => {
    const batch = await invoke('issue-project-save-batch') as string;
    const manifest = await invoke('bind-project-save-batch', batch, paths) as Binding[];
    return { batch, manifest };
  };
  return { registry, invoke, reserve, files, bind, contents, win, handlers };
}
function child(binding: Binding) { if ('missing' in binding) throw new Error('Expected a native existing source.'); return binding; }
function edited(text: string, x: number) {
  const drawing = new Drawing(readDxf(text));
  drawing.addEntities([{ id: 'batch-edit', type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 8 } }]);
  drawing.undo(); drawing.redo(); return writeDxf(drawing.snapshot);
}

describe.runIf(process.platform === 'win32')('bounded project saves through production IPC and native NTFS files', () => {
  it('reads, edits, backs up and freshly reopens 33 files under one inherited project order', async () => {
    const f = setup(), paths = await f.files(33), { batch, manifest } = await f.bind(paths);
    expect(manifest).toHaveLength(33);
    const outputs: string[] = [];
    for (const [i, entry] of manifest.entries()) {
      const b = child(entry), input = await f.invoke('open-project-save-batch-drawing', batch, b.childTicket) as Opened;
      expect(input.path).toBe(paths[i]); expect(input.identityPath).toBe(b.identityPath);
      outputs.push(edited(input.text, i));
    }
    const children = manifest.map(entry => child(entry).childTicket);
    await f.invoke('seal-project-save-batch', batch, children);
    for (const entry of manifest) expect(await f.invoke('backup-file', entry.path, { admission: child(entry).childTicket })).toEqual({ ok: true, path: `${entry.path}.bak` });
    await f.invoke('begin-project-save-batch-commit', batch);
    for (const [i, entry] of manifest.entries()) {
      const b = child(entry);
      expect(await f.invoke('save-dxf', entry.path, outputs[i], 'Sheet', { backup: false, admission: b.childTicket })).toBe(entry.path);
      expect(await f.invoke('save-admission-result', b.childTicket)).toEqual({ path: entry.path, identityPath: b.identityPath });
      expect(await fs.readFile(`${entry.path}.bak`, 'utf8')).toBe(nativeFixture);
      const reopened = readDxf(await fs.readFile(entry.path, 'utf8'));
      expect(reopened.entities.filter(e => e.type === 'point').map(e => e.position.x)).toEqual([i]);
    }
    await f.invoke('cancel-project-save-batch', batch);
    expect((await fs.readdir(dir)).filter(name => name.includes('.tmp-'))).toEqual([]);
  }, 30000);

  it.each([65, 512])('binds %i native files and changes only the two selected coherent inputs', async count => {
    const f = setup(), paths = await f.files(count), { batch, manifest } = await f.bind(paths);
    expect(manifest).toHaveLength(count);
    const selected = [child(manifest[0]!), child(manifest[count - 1]!)], outputs: string[] = [];
    for (const [i, b] of selected.entries()) {
      const input = await f.invoke('open-project-save-batch-drawing', batch, b.childTicket) as Opened;
      outputs.push(edited(input.text, 100 + i));
    }
    await f.invoke('seal-project-save-batch', batch, selected.map(b => b.childTicket));
    await f.invoke('begin-project-save-batch-commit', batch);
    for (const [i, b] of selected.entries()) {
      await f.invoke('save-dxf', b.path, outputs[i], 'Sheet', { admission: b.childTicket });
      await f.invoke('save-admission-result', b.childTicket);
    }
    await f.invoke('cancel-project-save-batch', batch);
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe(nativeFixture);
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.bak')).sort()).toEqual([`Sheet-${count - 1}.dxf.bak`, 'Sheet-0.dxf.bak'].sort());
  }, 30000);

  it('keeps a missing source with an existing parent as an explicit nonwritable skip', async () => {
    const f = setup(), [existing] = await f.files(1), missing = path.join(dir, 'Missing.dxf'); f.registry.grant(missing);
    const { batch, manifest } = await f.bind([existing!, missing]);
    expect(manifest[1]).toEqual({ index: 1, path: missing, missing: true });
    await expect(f.invoke('open-project-save-batch-drawing', batch, 'forged')).rejects.toThrow(/ERR_SAVE/);
    await f.invoke('cancel-project-save-batch', batch);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses write-before-commit and refuses a changed original input before calculation', async () => {
    const f = setup(), [file] = await f.files(1), { batch, manifest } = await f.bind([file!]), b = child(manifest[0]!);
    await expect(f.invoke('save-dxf', file, edited(nativeFixture, 1), 'Sheet', { admission: b.childTicket })).rejects.toThrow(/ERR_SAVE/);
    expect(await fs.readFile(file!, 'utf8')).toBe(nativeFixture);
    await fs.writeFile(file!, 'EXTERNAL EDIT');
    await expect(f.invoke('open-project-save-batch-drawing', batch, b.childTicket)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED|ERR_SAVE/);
    expect(await fs.readFile(file!, 'utf8')).toBe('EXTERNAL EDIT');
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('keeps a later ordinary save and its backup when the old project reaches final preflight', async () => {
    const f = setup(), [file] = await f.files(1), { batch, manifest } = await f.bind([file!]), b = child(manifest[0]!);
    await f.invoke('open-project-save-batch-drawing', batch, b.childTicket);
    await f.invoke('seal-project-save-batch', batch, [b.childTicket]);
    const newer = await f.reserve(file!), output = edited(nativeFixture, 99);
    await f.invoke('save-dxf', file, output, 'newer', { admission: newer });
    await expect(f.invoke('begin-project-save-batch-commit', batch)).rejects.toThrow(/ERR_SAVE_STALE|ERR_WINDOWS_PATH_CHANGED/);
    expect(await fs.readFile(file!, 'utf8')).toBe(output);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('refuses a selected output when an unchanged calculation source changed after sealing', async () => {
    const f = setup(), paths = await f.files(2), { batch, manifest } = await f.bind(paths);
    for (const entry of manifest) await f.invoke('open-project-save-batch-drawing', batch, child(entry).childTicket);
    await f.invoke('seal-project-save-batch', batch, [child(manifest[0]!).childTicket]);
    await fs.writeFile(paths[1]!, 'CHANGED REFERENCE SOURCE');
    await expect(f.invoke('begin-project-save-batch-commit', batch)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED|ERR_SAVE_STALE/);
    expect(await fs.readFile(paths[0]!, 'utf8')).toBe(nativeFixture);
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe('CHANGED REFERENCE SOURCE');
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.bak'))).toEqual([]);
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('accepts its own earlier output but refuses a later output after an unchanged source changes', async () => {
    const f = setup(), paths = await f.files(3), { batch, manifest } = await f.bind(paths);
    for (const entry of manifest) await f.invoke('open-project-save-batch-drawing', batch, child(entry).childTicket);
    const selected = [child(manifest[0]!), child(manifest[1]!)];
    await f.invoke('seal-project-save-batch', batch, selected.map(b => b.childTicket));
    await f.invoke('begin-project-save-batch-commit', batch);
    const first = edited(nativeFixture, 100);
    await f.invoke('save-dxf', paths[0], first, 'first', { admission: selected[0]!.childTicket });
    expect(await fs.readFile(paths[0]!, 'utf8')).toBe(first);
    await fs.writeFile(paths[2]!, 'LATE EXTERNAL REFERENCE EDIT');
    await expect(f.invoke('save-dxf', paths[1], edited(nativeFixture, 200), 'second', { admission: selected[1]!.childTicket })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED|ERR_SAVE_STALE/);
    expect(await fs.readFile(paths[0]!, 'utf8')).toBe(first);
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe(nativeFixture);
    expect(await fs.readFile(paths[2]!, 'utf8')).toBe('LATE EXTERNAL REFERENCE EDIT');
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('guards an automatic backup replacement against a reference-source edit during the copy', async () => {
    const f = setup(), paths = await f.files(2), { batch, manifest } = await f.bind(paths);
    for (const entry of manifest) await f.invoke('open-project-save-batch-drawing', batch, child(entry).childTicket);
    const selected = child(manifest[0]!);
    await f.invoke('seal-project-save-batch', batch, [selected.childTicket]);
    await f.invoke('begin-project-save-batch-commit', batch);
    await fs.writeFile(`${paths[0]}.bak`, 'PREVIOUS BACKUP MUST SURVIVE');
    const copy = fs.copyFile;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dest, mode) => {
      await copy(src, dest, mode);
      if (String(src) === paths[0]) await fs.writeFile(paths[1]!, 'REFERENCE EDIT DURING BACKUP COPY');
    });
    await expect(f.invoke('save-dxf', paths[0], edited(nativeFixture, 200), 'target', { admission: selected.childTicket })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED|ERR_SAVE_STALE/);
    expect(await fs.readFile(paths[0]!, 'utf8')).toBe(nativeFixture);
    expect(await fs.readFile(`${paths[0]}.bak`, 'utf8')).toBe('PREVIOUS BACKUP MUST SURVIVE');
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe('REFERENCE EDIT DURING BACKUP COPY');
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('aborting a sealed unwritten project does not suppress an older ordinary prepared save', async () => {
    const f = setup(), [file] = await f.files(1), older = await f.reserve(file!), { batch, manifest } = await f.bind([file!]), b = child(manifest[0]!);
    await f.invoke('open-project-save-batch-drawing', batch, b.childTicket);
    await f.invoke('seal-project-save-batch', batch, [b.childTicket]);
    await f.invoke('cancel-project-save-batch', batch);
    const output = edited(nativeFixture, 1);
    await f.invoke('save-dxf', file, output, 'older', { admission: older });
    expect(await fs.readFile(file!, 'utf8')).toBe(output);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it('rejects native aliases in a project manifest and exposes no second writable calculation', async () => {
    const f = setup(), file = path.join(dir, '\u1f80.dxf'), alias = path.join(dir, '\u1f88.dxf');
    await fs.writeFile(file, nativeFixture); f.registry.grant(file); f.registry.grant(alias);
    const batch = await f.invoke('issue-project-save-batch');
    await expect(f.invoke('bind-project-save-batch', batch, [file, alias])).rejects.toThrow(/duplicate|alias/i);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture);
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('rejects an unauthorized/non-DXF manifest before opening any source descriptor', async () => {
    const f = setup(), [known] = await f.files(1), unknown = path.join(dir, 'Unknown.dxf');
    await fs.writeFile(unknown, nativeFixture);
    const opened = vi.spyOn(fs, 'open'), batch = await f.invoke('issue-project-save-batch');
    await expect(f.invoke('bind-project-save-batch', batch, [known, unknown])).rejects.toThrow(/ERR_SAVE_AUTHORIZATION/);
    expect(opened).not.toHaveBeenCalled();
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
    const second = await f.invoke('issue-project-save-batch');
    await expect(f.invoke('bind-project-save-batch', second, [path.join(dir, 'drawing.dwg')])).rejects.toThrow(/ERR_SAVE_BATCH_PATHS/);
    expect(opened).not.toHaveBeenCalled();
    await f.invoke('cancel-project-save-batch', second);
  });

  it('retiring the renderer invalidates parent and children before they can write', async () => {
    const f = setup(), [file] = await f.files(1), { batch, manifest } = await f.bind([file!]), b = child(manifest[0]!);
    await f.invoke('open-project-save-batch-drawing', batch, b.childTicket);
    await f.invoke('seal-project-save-batch', batch, [b.childTicket]);
    f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    await expect(f.invoke('begin-project-save-batch-commit', batch)).rejects.toThrow(/ERR_SAVE/);
    await expect(f.invoke('save-dxf', file, edited(nativeFixture, 2), 'Sheet', { admission: b.childTicket })).rejects.toThrow(/ERR_SAVE/);
    expect(await fs.readFile(file!, 'utf8')).toBe(nativeFixture);
    expect(await fs.readdir(dir)).toEqual(['Sheet-0.dxf']);
  });
});
