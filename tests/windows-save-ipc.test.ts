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
const atomic = require('../atomic-write.cjs') as {
  atomicWriteFile(file: string, text: string, opts?: unknown): Promise<unknown>;
  createCanonicalWriteQueue(): (file: string, fn: (key: string) => Promise<unknown>) => Promise<unknown>;
};
const { createPathRegistry } = require('../path-registry.cjs') as { createPathRegistry(): {
  grant(file: string): boolean; isKnown(file: string): boolean; isWritable(file: string): boolean; paths(): Iterable<string>;
  writeRoot(file: string): string | null; registerProject(file: string, contents: unknown): unknown;
} };
const { createPathPolicy, guardIpc } = require('../ipc-guard.cjs') as {
  createPathPolicy(deps: unknown): unknown;
  guardIpc(raw: unknown, options: unknown): unknown;
};
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'jcad-native-save-ipc-')); });
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
  const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(dir, 'drawing.dxf') })), showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [path.join(dir, 'drawing.dxf')] })), showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const enqueueWrite = atomic.createCanonicalWriteQueue();
  const module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  new Function('require', 'module', source)((name: string) => {
    if (name === 'electron') return { dialog };
    if (name === './app-data.cjs') return { enqueueWrite, writeUserFile: (file: string, text: string, opts: unknown) => enqueueWrite(file, key => atomic.atomicWriteFile(file, text, { ...(opts as object), expectedDestination: key })) };
    if (name === './dwg.cjs') return { decodeDxf: (bytes: Uint8Array) => Promise.resolve(decodeDxfBytes(bytes)), readDwgWithProgress: () => { throw new Error('Native DWG reader is not part of this DXF gate.'); } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status: () => ({ available: false }), export: () => { throw new Error('No native writer fixture.'); } }) };
    return require(name);
  }, module);
  module.exports.registerDrawingIpc({ ipcMain, rejections: log, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  const reserve = async (file: string, kind = 'drawing') => {
    const ticket = await invoke('issue-save-admission', kind) as string;
    const pin = await invoke('bind-save-admission', ticket, kind, file) as { identityPath: string; exists: boolean };
    return { ticket, pin };
  };
  return { registry, invoke, reserve, contents, win, dialog, handlers, ev };
}
const nativeFixture = readFileSync(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
function editedFixture(x: number) {
  const drawing = new Drawing(readDxf(nativeFixture));
  drawing.addEntities([{ id: 'edit', type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 8 } }]);
  drawing.undo(); drawing.redo(); return writeDxf(drawing.snapshot);
}

describe.runIf(process.platform === 'win32')('guarded Windows save IPC with actual native files', () => {
  it.each([['\u0130.dxf', 'I\u0307.dxf'], ['Jos\u00e9.dxf', 'Jose\u0301.dxf']])('keeps %s and %s edits, backups and reopened drawings separate', async (first, second) => {
    const f = setup(), a = path.join(dir, first), b = path.join(dir, second);
    await fs.writeFile(a, nativeFixture); await fs.writeFile(b, nativeFixture);
    f.registry.grant(a); f.registry.grant(b);
    const ra = await f.reserve(a), rb = await f.reserve(b);
    expect(ra.pin.identityPath).not.toBe(rb.pin.identityPath);
    await f.invoke('save-dxf', a, editedFixture(1), first, { admission: ra.ticket });
    await f.invoke('save-dxf', b, editedFixture(2), second, { admission: rb.ticket });
    const positions = await Promise.all([a, b].map(async file => readDxf(await fs.readFile(file, 'utf8')).entities.filter(e => e.type === 'point').map(e => e.position.x)));
    expect(positions).toEqual([[1], [2]]);
    expect(await fs.readFile(`${a}.bak`, 'utf8')).toBe(nativeFixture); expect(await fs.readFile(`${b}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it('rejects a slow older missing-leaf alias after the newer native alias save', async () => {
    const f = setup(), old = path.join(dir, '\u1f80.dxf'), newer = path.join(dir, '\u1f88.dxf');
    f.registry.grant(old); f.registry.grant(newer);
    const older = await f.reserve(old), latest = await f.reserve(newer);
    expect(older.pin.exists).toBe(false); expect(latest.pin.exists).toBe(false);
    const saved = editedFixture(9);
    await f.invoke('save-dxf', newer, saved, 'newer', { admission: latest.ticket });
    await expect(f.invoke('save-dxf', old, editedFixture(1), 'old', { admission: older.ticket })).rejects.toThrow(/ERR_SAVE_STALE/);
    expect(await fs.readFile(old, 'utf8')).toBe(saved); expect(await fs.readdir(dir)).toEqual(['\u1f88.dxf']);
    const retry = await f.reserve(old);
    expect(retry.pin).toEqual({ identityPath: await fs.realpath(newer), exists: true });
    expect(await f.invoke('save-dxf', old, editedFixture(10), 'retry', { admission: retry.ticket })).toBe(old);
    expect(await fs.readFile(`${newer}.bak`, 'utf8')).toBe(saved);
  });

  it('returns the bound logical spelling while preserving the native leaf through a directory junction', async () => {
    const f = setup(), physical = path.join(dir, 'Physical'), picked = path.join(dir, 'Picked');
    await fs.mkdir(physical); await fs.symlink(physical, picked, 'junction');
    const actual = path.join(physical, 'Case.dxf'), chosen = path.join(picked, 'case.dxf');
    await fs.writeFile(actual, nativeFixture); f.registry.grant(chosen);
    const reservation = await f.reserve(chosen);
    expect(reservation.pin.identityPath).toBe(actual);
    expect(await f.invoke('save-dxf', chosen, editedFixture(4), 'drawing', { admission: reservation.ticket })).toBe(chosen);
    expect((await fs.readdir(physical)).sort()).toEqual(['Case.dxf', 'Case.dxf.bak']);
    expect(await f.invoke('resolve-path-identity', chosen)).toBe(actual);
  });

  it('refuses unchosen Unicode sibling authority before native path resolution', async () => {
    const f = setup(), chosen = path.join(dir, '\u0130.dxf'), outside = path.join(dir, 'I\u0307.dxf');
    await fs.writeFile(chosen, nativeFixture); await fs.writeFile(outside, 'OUTSIDE');
    f.registry.grant(chosen); expect(f.registry.isKnown(outside)).toBe(false);
    const read = vi.spyOn(fs, 'realpath');
    expect(await f.invoke('resolve-path-identity', outside)).toBe(null); expect(read).not.toHaveBeenCalled();
    const ticket = await f.invoke('issue-save-admission', 'drawing');
    await expect(f.invoke('bind-save-admission', ticket, 'drawing', outside)).rejects.toThrow(/ERR_SAVE_AUTHORIZATION/);
    expect(read).not.toHaveBeenCalled(); expect(await fs.readFile(outside, 'utf8')).toBe('OUTSIDE');
  });

  it('rejects forged, transferred, canceled and replayed tickets without replacing files', async () => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'), other = path.join(dir, 'other.dxf');
    await fs.writeFile(file, nativeFixture); await fs.writeFile(other, 'OTHER'); f.registry.grant(file); f.registry.grant(other);
    const reserved = await f.reserve(file);
    await expect(f.invoke('save-dxf', other, 'BAD', 'other', { admission: reserved.ticket })).rejects.toThrow(/another logical path/);
    await expect(f.invoke('save-dxf', file, 'BAD', 'drawing', { admission: 'forged' })).rejects.toThrow(/ERR_SAVE_TICKET/);
    await f.invoke('cancel-save-admission', reserved.ticket, 'drawing');
    await expect(f.invoke('save-dxf', file, 'BAD', 'drawing', { admission: reserved.ticket })).rejects.toThrow(/ERR_SAVE_TICKET/);
    const fresh = await f.reserve(file); await f.invoke('save-dxf', file, editedFixture(1), 'drawing', { admission: fresh.ticket });
    await expect(f.invoke('save-dxf', file, 'BAD', 'drawing', { admission: fresh.ticket })).rejects.toThrow(/ERR_SAVE_TICKET/);
    expect(await fs.readFile(other, 'utf8')).toBe('OTHER'); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it.each(['navigation', 'renderer-loss', 'closed'])('retires an old document ticket on %s', async event => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const old = await f.reserve(file);
    if (event === 'navigation') f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    else if (event === 'renderer-loss') f.contents.emit('render-process-gone'); else f.win.emit('closed');
    await expect(f.invoke('save-dxf', file, 'OLD', 'drawing', { admission: old.ticket })).rejects.toThrow(/ERR_SAVE_TICKET/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['drawing.dxf']);
  });

  it('ignores subframe and in-place navigation while rejecting an unauthorized IPC caller', async () => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const reservation = await f.reserve(file);
    f.contents.emit('did-start-navigation', {}, 'https://untrusted.invalid', false, false);
    f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html#view', true, true);
    expect(() => f.handlers.get('issue-save-admission')!({ ...f.ev, senderFrame: { ...f.ev.senderFrame, parent: {} } }, 'drawing')).toThrow(/Unauthorized IPC caller/);
    await f.invoke('save-dxf', file, editedFixture(5), 'drawing', { admission: reservation.ticket });
    expect(new Drawing(readDxf(await fs.readFile(file, 'utf8'))).dirty).toBe(false);
  });

  it('keeps by-name project confinement on admitted saves and blocks outside junctions', async () => {
    const f = setup(), project = path.join(dir, 'Project'), outside = path.join(dir, 'Outside');
    await fs.mkdir(project); await fs.mkdir(outside); await fs.symlink(outside, path.join(project, 'linked'), 'junction');
    const source = path.join(outside, 'drawing.dxf'); await fs.writeFile(source, nativeFixture);
    const file = path.join(project, 'linked', 'drawing.dxf'); f.registry.registerProject(path.join(project, 'p.jcadproj.json'), { drawings: [{ file: 'linked/drawing.dxf' }] });
    expect(f.registry.writeRoot(file)).toBe(project);
    await expect(f.reserve(file)).rejects.toThrow(/ELOOP/);
    expect(f.registry.writeRoot(file)).toBe(project); expect(await fs.readFile(source, 'utf8')).toBe(nativeFixture);
    expect(await fs.readdir(outside)).toEqual(['drawing.dxf']);
  });

  it('refuses a compatibility Save As whose native picker outlives its renderer document', async () => {
    const f = setup(), file = path.join(dir, 'late.dxf');
    let answer!: (value: { canceled: boolean; filePath: string }) => void;
    f.dialog.showSaveDialog.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const saving = f.invoke('save-dxf', null, nativeFixture, 'late');
    expect(f.contents.listenerCount('did-start-navigation')).toBe(1);
    f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    answer({ canceled: false, filePath: file });
    await expect(saving).rejects.toThrow(/ERR_SAVE_CANCELLED/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects read bytes paired with a directory junction identity changed during descriptor close', async () => {
    const f = setup(), first = path.join(dir, '\u0130'), second = path.join(dir, 'I\u0307'), picked = path.join(dir, 'Chosen');
    await fs.mkdir(first); await fs.mkdir(second); await fs.symlink(first, picked, 'junction');
    await fs.writeFile(path.join(first, 'drawing.dxf'), nativeFixture); await fs.writeFile(path.join(second, 'drawing.dxf'), editedFixture(7));
    const file = path.join(picked, 'drawing.dxf'); f.registry.grant(file);
    const originalOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === file) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); await fs.unlink(picked); await fs.symlink(second, picked, 'junction'); };
      }
      return handle;
    });
    await expect(f.invoke('open-drawing', file)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(await fs.readFile(path.join(first, 'drawing.dxf'), 'utf8')).toBe(nativeFixture);
  });

  it('returns the committed identity receipt even if a missing target junction changes after saving', async () => {
    const f = setup(), first = path.join(dir, 'First'), second = path.join(dir, 'Second'), picked = path.join(dir, 'Chosen');
    await fs.mkdir(first); await fs.mkdir(second); await fs.symlink(first, picked, 'junction');
    const file = path.join(picked, 'drawing.dxf'); f.registry.grant(file); const reserved = await f.reserve(file);
    expect(reserved.pin.exists).toBe(false);
    await f.invoke('save-dxf', file, nativeFixture, 'drawing', { admission: reserved.ticket });
    await fs.writeFile(path.join(second, 'drawing.dxf'), 'OTHER'); await fs.unlink(picked); await fs.symlink(second, picked, 'junction');
    expect(await f.invoke('save-admission-result', reserved.ticket)).toEqual({ path: file, identityPath: path.join(first, 'drawing.dxf') });
    expect(await f.invoke('save-admission-result', reserved.ticket)).toBe(null);
    expect(await fs.readFile(path.join(first, 'drawing.dxf'), 'utf8')).toBe(nativeFixture);
    expect(await fs.readFile(file, 'utf8')).toBe('OTHER');
  });

  it('does not overwrite the newest backup with an older bound bulk preparation', async () => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const old = await f.reserve(file), newer = await f.reserve(file), latest = editedFixture(9);
    await f.invoke('save-dxf', file, latest, 'drawing', { admission: newer.ticket });
    expect(await f.invoke('backup-file', file, { admission: old.ticket })).toMatchObject({ ok: false, code: 'ERR_SAVE_STALE' });
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture); expect(await fs.readFile(file, 'utf8')).toBe(latest);
    await f.invoke('cancel-save-admission', old.ticket, 'drawing');
  });

  it('copies a backup without consuming the ticket and supports chosen continuation after backup failure', async () => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const first = await f.reserve(file);
    expect(await f.invoke('backup-file', file, { admission: first.ticket })).toMatchObject({ ok: true });
    await f.invoke('save-dxf', file, editedFixture(1), 'drawing', { admission: first.ticket, backup: false });
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
    await fs.unlink(`${file}.bak`); await fs.mkdir(`${file}.bak`);
    const second = await f.reserve(file);
    expect(await f.invoke('backup-file', file, { admission: second.ticket })).toMatchObject({ ok: false });
    await f.invoke('save-dxf', file, editedFixture(2), 'drawing', { admission: second.ticket, backup: false });
    expect((await fs.stat(`${file}.bak`)).isDirectory()).toBe(true);
    expect(readDxf(await fs.readFile(file, 'utf8')).entities.some(e => e.type === 'point' && e.position.x === 2)).toBe(true);
  });

  it('backs up project JSON through its own admission kind', async () => {
    const f = setup(), file = path.join(dir, 'p.jcadproj.json'); await fs.writeFile(file, '{"name":"original"}'); f.registry.grant(file);
    expect(await f.invoke('backup-file', file)).toMatchObject({ ok: true });
    const reserved = await f.reserve(file, 'project');
    expect(await f.invoke('save-project', file, '{"name":"changed"}', reserved.ticket)).toBe(file);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('{"name":"original"}');
  });

  it.each(['save', 'backup'])('rechecks admission before each sharing-violation retry of %s', async action => {
    const f = setup(), file = path.join(dir, 'drawing.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const reserved = await f.reserve(file), rename = fs.rename, destination = action === 'save' ? file : `${file}.bak`;
    let attempts = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dest) => {
      if (String(dest) === destination && ++attempts === 1) {
        await fs.writeFile(file, 'EXTERNAL EDIT MUST SURVIVE');
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      }
      return rename(src, dest);
    });
    if (action === 'save') await expect(f.invoke('save-dxf', file, editedFixture(1), 'drawing', { admission: reserved.ticket })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    else expect(await f.invoke('backup-file', file, { admission: reserved.ticket })).toMatchObject({ ok: false, code: 'ERR_WINDOWS_PATH_CHANGED' });
    expect(attempts).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('EXTERNAL EDIT MUST SURVIVE');
    if (action === 'save') expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
    else { expect(await fs.readdir(dir)).toEqual(['drawing.dxf']); await f.invoke('cancel-save-admission', reserved.ticket, 'drawing'); }
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
