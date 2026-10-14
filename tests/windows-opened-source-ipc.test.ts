import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';

const sourceUrl = new URL('../electron/main/ipc-drawings.cjs', import.meta.url);
const require = createRequire(sourceUrl), source = readFileSync(sourceUrl, 'utf8');
const atomic = require('../atomic-write.cjs');
const { createPathRegistry } = require('../path-registry.cjs');
const { createPathPolicy, guardIpc } = require('../ipc-guard.cjs');
type Handler = (ev: unknown, ...args: unknown[]) => unknown;
type Hint = { proof: string | null; path: string | null; mode: 'in-place' | 'save-as' };
type Opened = { path: string; identityPath: string; openedSourceProof: string; text: string };
type Receipt = { path: string; identityPath: string; openedSourceProof?: string };
const privateRoot = path.resolve('.codex-local/opened-source-ipc-tests');
let dir: string;
const windows: EventEmitter[] = [];
beforeEach(async () => { await fs.mkdir(privateRoot, { recursive: true }); dir = await fs.mkdtemp(path.join(privateRoot, 'case-')); });
afterEach(async () => {
  vi.restoreAllMocks(); for (const win of windows.splice(0)) win.emit('closed');
  if (path.dirname(dir) !== privateRoot || !path.basename(dir).startsWith('case-')) throw new Error('Unsafe private test cleanup');
  await fs.rm(dir, { recursive: true, force: true });
});

function setup() {
  const registry = createPathRegistry(), handlers = new Map<string, Handler>(), log = { reject: vi.fn() };
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents }); windows.push(win);
  const ev = { sender: contents, senderFrame: frame };
  const ipcMain = guardIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log });
  const pathPolicy = createPathPolicy({ isKnownPath: (file: string) => registry.isKnown(file), isWritablePath: (file: string) => registry.isWritable(file), knownPaths: () => registry.paths(), log });
  const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(dir, 'Copy.dxf') })), showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [path.join(dir, 'Original.dxf')] })), showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const enqueueWrite = atomic.createCanonicalWriteQueue();
  const module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  new Function('require', 'module', source)((name: string) => {
    if (name === 'electron') return { dialog };
    if (name === './app-data.cjs') return { enqueueWrite, writeUserFile: (file: string, text: string, opts: unknown) => enqueueWrite(file, (key: string) => atomic.atomicWriteFile(file, text, { ...(opts as object), expectedDestination: key })) };
    if (name === './dwg.cjs') return { decodeDxf: (bytes: Uint8Array) => Promise.resolve(decodeDxfBytes(bytes)), readDwgWithProgress: () => { throw new Error('This gate uses native DXF files; it does not validate the DWG reader.'); } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status: () => ({ available: false }), export: () => { throw new Error('This gate does not certify native DWG conversion.'); } }) };
    return require(name);
  }, module);
  module.exports.registerDrawingIpc({ ipcMain, rejections: log, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  const open = async (file: string) => { registry.grant(file); return await invoke('open-drawing', file) as Opened; };
  const bind = async (file: string, hint?: Hint) => {
    const ticket = await invoke('issue-save-admission', 'drawing') as string;
    try { await invoke('bind-save-admission', ticket, 'drawing', file, ...(hint ? [hint] : [])); }
    catch (error) { await invoke('cancel-save-admission', ticket, 'drawing').catch(() => {}); throw error; }
    return ticket;
  };
  const save = async (file: string, text: string, hint: Hint) => {
    const ticket = await bind(file, hint);
    try { expect(await invoke('save-dxf', file, text, 'drawing', { admission: ticket })).toBe(file); return await invoke('save-admission-result', ticket) as Receipt; }
    finally { await invoke('cancel-save-admission', ticket, 'drawing').catch(() => {}); }
  };
  return { registry, invoke, contents, dialog, open, bind, save };
}

const nativeFixture = readFileSync(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
function editedFixture(x: number) {
  const drawing = new Drawing(readDxf(nativeFixture));
  drawing.addEntities([{ id: 'edit', type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 8 } }]);
  drawing.undo(); drawing.redo(); return writeDxf(drawing.snapshot);
}
const hint = (opened: Opened, mode: Hint['mode'] = 'in-place'): Hint => ({ proof: opened.openedSourceProof, path: opened.path, mode });

describe.runIf(process.platform === 'win32')('completed Open evidence through production save IPC and native files', () => {
  it('returns an opaque proof for the completed native read and refuses external edits before either later save bind', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), outside = editedFixture(999);
    await fs.writeFile(file, nativeFixture); await fs.writeFile(`${file}.bak`, 'OLDER BACKUP');
    const opened = await f.open(file);
    expect(opened).toMatchObject({ path: file, identityPath: await fs.realpath(file) });
    expect(opened.text === nativeFixture).toBe(true);
    expect(opened.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    await fs.writeFile(file, outside);
    await expect(f.save(file, editedFixture(111), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    await expect(f.save(file, editedFixture(222), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(file, 'utf8')).toBe(outside); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('OLDER BACKUP');
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('permits a separate Save As after an outside edit and advances only the copy proof on repeated saves', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), copy = path.join(dir, 'Copy.dxf'), outside = editedFixture(999), first = editedFixture(111), second = editedFixture(222);
    await fs.writeFile(file, nativeFixture); const opened = await f.open(file); await fs.writeFile(file, outside); f.registry.grant(copy);
    const receipt = await f.save(copy, first, hint(opened, 'save-as'));
    expect(receipt).toMatchObject({ path: copy, identityPath: copy }); expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(receipt.openedSourceProof).not.toBe(opened.openedSourceProof);
    await f.invoke('release-opened-source-proof', opened.openedSourceProof);
    const next = await f.save(copy, second, { proof: receipt.openedSourceProof!, path: copy, mode: 'in-place' });
    expect(next.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(file, 'utf8')).toBe(outside); expect(await fs.readFile(copy, 'utf8')).toBe(second); expect(await fs.readFile(`${copy}.bak`, 'utf8')).toBe(first);
    const reopened = await f.open(copy); expect(readDxf(reopened.text).entities.some(e => e.type === 'point' && e.position.x === 222)).toBe(true);
    await f.invoke('release-opened-source-proof', receipt.openedSourceProof); await f.invoke('release-opened-source-proof', next.openedSourceProof); await f.invoke('release-opened-source-proof', reopened.openedSourceProof);
  });

  it('accepts verified own saves without silently adopting an outside version on a later save', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), first = editedFixture(1), second = editedFixture(2), outside = editedFixture(3);
    await fs.writeFile(file, nativeFixture); const opened = await f.open(file);
    const a = await f.save(file, first, hint(opened)); await f.invoke('release-opened-source-proof', opened.openedSourceProof);
    const b = await f.save(file, second, { proof: a.openedSourceProof!, path: file, mode: 'in-place' }); await f.invoke('release-opened-source-proof', a.openedSourceProof);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(first); await fs.writeFile(file, outside);
    await expect(f.save(file, editedFixture(4), { proof: b.openedSourceProof!, path: file, mode: 'in-place' })).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(file, 'utf8')).toBe(outside); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(first);
  });

  it('does not refresh the old source baseline merely because another Open returned newer bytes', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), outside = editedFixture(999);
    await fs.writeFile(file, nativeFixture); const old = await f.open(file); await fs.writeFile(file, outside); const duplicate = await f.open(file);
    expect(duplicate.text === outside).toBe(true); expect(duplicate.openedSourceProof).not.toBe(old.openedSourceProof);
    await f.invoke('release-opened-source-proof', duplicate.openedSourceProof);
    await expect(f.save(file, editedFixture(111), hint(old))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(file, 'utf8')).toBe(outside); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });

  it('refuses omitted or null proof on protected originals, including implicit saves and backups', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeFixture); const opened = await f.open(file);
    await expect(f.bind(file)).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    await expect(f.bind(file, { proof: null, path: file, mode: 'in-place' })).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    await expect(f.bind(file, { proof: null, path: null, mode: 'save-as' })).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    const unrelated = path.join(dir, 'Unrelated.dxf'); f.registry.grant(unrelated);
    await expect(f.bind(file, { proof: null, path: unrelated, mode: 'save-as' })).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    await expect(f.invoke('save-dxf', file, editedFixture(1), 'compatibility')).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(await f.invoke('backup-file', file)).toMatchObject({ ok: false, code: 'ERR_OPENED_SOURCE_PROOF' });
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
    await f.invoke('release-opened-source-proof', opened.openedSourceProof);
  });

  it('keeps protected evidence borrowed after renderer release until the admitted own save finishes', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), own = editedFixture(1); await fs.writeFile(file, nativeFixture); const opened = await f.open(file);
    const ticket = await f.bind(file, hint(opened)); await f.invoke('release-opened-source-proof', opened.openedSourceProof);
    await expect(f.bind(file)).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    await f.invoke('save-dxf', file, own, 'drawing', { admission: ticket });
    const receipt = await f.invoke('save-admission-result', ticket) as Receipt; expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(file, 'utf8')).toBe(own); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
    await f.invoke('release-opened-source-proof', receipt.openedSourceProof);
  });

  it.each(['navigation', 'renderer-loss', 'closed'])('invalidates read proofs when their owner retires on %s', async event => {
    const f = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeFixture); const opened = await f.open(file);
    if (event === 'navigation') f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    else if (event === 'renderer-loss') f.contents.emit('render-process-gone'); else f.contents.emit('destroyed');
    await expect(f.bind(file, hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });

  it('rejects a proof from another live window before backup or file mutation', async () => {
    const first = setup(), second = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeFixture); const opened = await first.open(file); second.registry.grant(file);
    await expect(second.save(file, editedFixture(1), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });

  it('refuses source aliases in Save As but permits a genuinely separate file after deleting the original', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), alias = path.join(dir, 'Alias.dxf'), copy = path.join(dir, 'Copy.dxf');
    await fs.writeFile(file, nativeFixture); await fs.link(file, alias); const opened = await f.open(file); await fs.writeFile(file, editedFixture(999)); f.registry.grant(alias);
    await expect(f.save(alias, editedFixture(1), hint(opened, 'save-as'))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    await expect(f.bind(alias)).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    await fs.unlink(file); await expect(f.save(file, editedFixture(1), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    f.registry.grant(copy); const receipt = await f.save(copy, editedFixture(2), hint(opened, 'save-as')); expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(alias, 'utf8')).toBe(editedFixture(999)); expect(await fs.readFile(copy, 'utf8')).toBe(editedFixture(2));
  });

  it('refuses normal Save through a retargeted directory junction without choosing the new target as a copy', async () => {
    const f = setup(), a = path.join(dir, 'A'), b = path.join(dir, 'B'), chosen = path.join(dir, 'Chosen');
    await fs.mkdir(a); await fs.mkdir(b); await fs.symlink(a, chosen, 'junction');
    const file = path.join(chosen, 'Original.dxf'); await fs.writeFile(path.join(a, 'Original.dxf'), nativeFixture); await fs.writeFile(path.join(b, 'Original.dxf'), editedFixture(999));
    const opened = await f.open(file); await fs.unlink(chosen); await fs.symlink(b, chosen, 'junction');
    await expect(f.save(file, editedFixture(1), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(path.join(a, 'Original.dxf'), 'utf8')).toBe(nativeFixture); expect(await fs.readFile(path.join(b, 'Original.dxf'), 'utf8')).toBe(editedFixture(999));
    expect(await fs.readdir(a)).toEqual(['Original.dxf']); expect(await fs.readdir(b)).toEqual(['Original.dxf']);
  });

  it('refuses before backup when source capacity is full and resumes after explicit release', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeFixture); await fs.writeFile(`${file}.bak`, 'KEEP');
    const opened: Opened[] = []; for (let n = 0; n < 128; n++) opened.push(await f.open(file));
    await expect(f.save(file, editedFixture(1), hint(opened[0]!))).rejects.toThrow(/ERR_OPENED_SOURCE_CAPACITY/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('KEEP');
    await f.invoke('release-opened-source-proof', opened.pop()!.openedSourceProof);
    const receipt = await f.save(file, editedFixture(1), hint(opened[0]!)); expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it('retains compatibility calls to unopened destinations without minting an opened-source proof', async () => {
    const f = setup(), file = path.join(dir, 'Unopened.dxf'); await fs.writeFile(file, nativeFixture); f.registry.grant(file);
    const ticket = await f.bind(file); await f.invoke('save-dxf', file, editedFixture(1), 'drawing', { admission: ticket });
    expect(await f.invoke('save-admission-result', ticket)).toEqual({ path: file, identityPath: file });
    await f.invoke('save-dxf', file, editedFixture(2), 'compatibility'); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(editedFixture(1));
  });

  it('creates a new untitled drawing lineage at a chosen destination and protects it on the next save', async () => {
    const f = setup(), file = path.join(dir, 'New.dxf'); f.registry.grant(file);
    const receipt = await f.save(file, editedFixture(1), { proof: null, path: null, mode: 'save-as' });
    expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    await fs.writeFile(file, editedFixture(999));
    await expect(f.save(file, editedFixture(2), { proof: receipt.openedSourceProof!, path: file, mode: 'in-place' })).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(file, 'utf8')).toBe(editedFixture(999)); expect(await fs.readdir(dir)).toEqual(['New.dxf']);
  });

  it('refuses an Open picker result after its original document reloads before allocating a native read', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeFixture);
    let answer!: (value: { canceled: boolean; filePaths: string[] }) => void;
    f.dialog.showOpenDialog.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const opening = f.invoke('open-drawing'); const read = vi.spyOn(fs, 'open');
    f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    answer({ canceled: false, filePaths: [file] });
    await expect(opening).rejects.toThrow(/ERR_OPENED_SOURCE_RETIRED/); expect(read).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });
});
