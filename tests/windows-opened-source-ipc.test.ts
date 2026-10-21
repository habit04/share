import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

function setup(afterDecode?: () => Promise<void>) {
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
    if (name === './dwg.cjs') return { decodeDxf: async (bytes: Uint8Array) => { const decoded = decodeDxfBytes(bytes); await afterDecode?.(); return decoded; }, readDwgWithProgress: () => { throw new Error('This gate uses native DXF files; it does not validate the DWG reader.'); } };
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
const attrib = promisify(execFile);
async function archiveAttribute(file: string, enabled: boolean) {
  await attrib(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe'), [enabled ? '+A' : '-A', file], { windowsHide: true, timeout: 5000 });
}
const clockDrawing = (text: string) => [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1032', 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES', 0, 'TEXT', 8, '0', 10, 1, 20, 2, 40, 2.5, 1, text, 0, 'ENDSEC', 0, 'EOF', ''].join('\r\n');

/** Real native reads with a deterministic change after the first returned bytes. */
function afterFirstSourceRead(file: string, change: () => Promise<void>) {
  const nativeOpen = fs.open;
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (path.resolve(String(args[0])) !== file) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (...values: any[]) => {
        const result = await (target.read as any)(...values);
        if (!changed && result.bytesRead > 0) { changed = true; await change(); }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
}

describe.runIf(process.platform === 'win32')('completed Open evidence through production save IPC and native files', () => {
  it.each(['archive', 'readonly'])('saves new bytes in place after an actual NTFS %s attribute change after Open', async attribute => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), next = editedFixture(113);
    await fs.writeFile(file, nativeFixture);
    if (attribute === 'archive') await archiveAttribute(file, true); else await fs.chmod(file, 0o444);
    try {
      const opened = await f.open(file), before = await fs.stat(file, { bigint: true });
      if (attribute === 'archive') await archiveAttribute(file, false); else await fs.chmod(file, 0o666);
      const after = await fs.stat(file, { bigint: true });
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      for (const field of ['dev', 'ino', 'size', 'mtimeNs'] as const) expect(after[field]).toBe(before[field]);
      const receipt = await f.save(file, next, hint(opened));
      expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
      expect(await fs.readFile(file, 'utf8')).toBe(next); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
      expect((await f.open(file)).text).toBe(next);
    } finally { await fs.chmod(file, 0o666); }
  });

  it.each(['same-size bytes', 'delete-recreate', 'rename-replacement', 'ctime and bytes', 'mtime', 'size'])('still refuses %s after Open without touching the outside file or backup', async change => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    const original = clockDrawing('CLOCK_ORIGINAL'), external = clockDrawing('CLOCK_EXTERNAL');
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(external));
    await fs.writeFile(file, original); await fs.utimes(file, modified, modified); await archiveAttribute(file, true);
    if (change === 'delete-recreate') await fs.link(file, path.join(dir, 'Held-original.dxf'));
    const opened = await f.open(file), before = await fs.stat(file, { bigint: true });
    await fs.writeFile(`${file}.bak`, 'KEEP OLDER BACKUP');
    if (change === 'delete-recreate') { await fs.unlink(file); await fs.writeFile(file, original); }
    else if (change === 'rename-replacement') {
      const replacement = path.join(dir, 'Replacement.dxf'); await fs.writeFile(replacement, original); await fs.rename(replacement, file);
    } else if (change === 'same-size bytes' || change === 'ctime and bytes') await fs.writeFile(file, external);
    else if (change === 'size') await fs.appendFile(file, '\r\n');
    await fs.utimes(file, modified, change === 'mtime' ? new Date('2020-01-01T00:00:01Z') : modified);
    if (change === 'ctime and bytes') await archiveAttribute(file, false);
    const after = await fs.stat(file, { bigint: true }), outside = await fs.readFile(file);
    if (change === 'delete-recreate' || change === 'rename-replacement') expect(after.ino).not.toBe(before.ino);
    if (change === 'same-size bytes' || change === 'ctime and bytes') { expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs); }
    await expect(f.save(file, editedFixture(114), hint(opened))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    expect(await fs.readFile(file)).toEqual(outside); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('KEEP OLDER BACKUP');
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps Save As to the source strict after metadata-only changes, while a separate copy remains permitted', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), copy = path.join(dir, 'Copy.dxf'), next = editedFixture(115);
    await fs.writeFile(file, nativeFixture); await archiveAttribute(file, true); const opened = await f.open(file);
    await archiveAttribute(file, false);
    await expect(f.save(file, next, hint(opened, 'save-as'))).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    f.registry.grant(copy); const receipt = await f.save(copy, next, hint(opened, 'save-as'));
    expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readFile(copy, 'utf8')).toBe(next);
    await expect(fs.stat(`${file}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a fresh-hash read error after a ctime-only change without consuming the usable original proof', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), next = editedFixture(116);
    await fs.writeFile(file, nativeFixture); await fs.writeFile(`${file}.bak`, 'KEEP'); await archiveAttribute(file, true);
    const opened = await f.open(file); await archiveAttribute(file, false);
    const nativeOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === file) throw Object.assign(new Error('deliberate read refusal'), { code: 'EACCES' });
      return nativeOpen(...args);
    });
    await expect(f.save(file, next, hint(opened))).rejects.toThrow(/EACCES/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('KEEP');
    vi.restoreAllMocks();
    const receipt = await f.save(file, next, hint(opened));
    expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/); expect(await fs.readFile(file, 'utf8')).toBe(next);
  });

  it('still refuses bytes changed during the fresh Save re-read after a metadata-only transition', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    const original = clockDrawing('CLOCK_ORIGINAL'), external = clockDrawing('CLOCK_EXTERNAL');
    await fs.writeFile(file, original); await fs.utimes(file, modified, modified); await archiveAttribute(file, true);
    const opened = await f.open(file); await archiveAttribute(file, false);
    afterFirstSourceRead(file, async () => { await fs.writeFile(file, external); await fs.utimes(file, modified, modified); });
    await expect(f.save(file, editedFixture(117), hint(opened))).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    vi.restoreAllMocks();
    expect(await fs.readFile(file, 'utf8')).toBe(external); await expect(fs.stat(`${file}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('opens unchanged bytes after native metadata-only ctime movement during the first read, and binds a usable save proof', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    await fs.writeFile(file, nativeFixture); await fs.utimes(file, modified, modified);
    const before = await fs.stat(file, { bigint: true });
    afterFirstSourceRead(file, async () => { await fs.utimes(file, new Date('2021-01-01T00:00:00Z'), modified); });
    const opened = await f.open(file), after = await fs.stat(file, { bigint: true });
    expect(after.ctimeNs).not.toBe(before.ctimeNs); expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino); expect(opened.text).toBe(nativeFixture);
    vi.restoreAllMocks();
    const receipt = await f.save(file, editedFixture(111), hint(opened));
    expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it('uses the last content-verified native version after metadata changes during decoding', async () => {
    const file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    await fs.writeFile(file, nativeFixture); await fs.utimes(file, modified, modified);
    const before = await fs.stat(file, { bigint: true });
    const f = setup(async () => { await fs.utimes(file, new Date('2021-01-01T00:00:00Z'), modified); });
    const opened = await f.open(file), after = await fs.stat(file, { bigint: true });
    expect(after.ctimeNs).not.toBe(before.ctimeNs); expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(opened.text).toBe(nativeFixture);
    const receipt = await f.save(file, editedFixture(112), hint(opened));
    expect(receipt.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(nativeFixture);
  });

  it.each(['different-bytes', 'different-mtime'])('still refuses %s during an Open without minting a save baseline', async change => {
    const f = setup(), file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    await fs.writeFile(file, nativeFixture); await fs.utimes(file, modified, modified);
    afterFirstSourceRead(file, async () => {
      if (change === 'different-bytes') await fs.writeFile(file, `${nativeFixture[0] === '0' ? '1' : '0'}${nativeFixture.slice(1)}`);
      await fs.utimes(file, modified, change === 'different-mtime' ? new Date('2020-01-01T00:00:01Z') : modified);
    });
    await expect(f.open(file)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });

  it('refuses a same-byte replacement during decoding even when its size and mtime match', async () => {
    const file = path.join(dir, 'Original.dxf'), modified = new Date('2020-01-01T00:00:00Z');
    await fs.writeFile(file, nativeFixture); await fs.utimes(file, modified, modified);
    const before = await fs.stat(file, { bigint: true });
    const f = setup(async () => {
      const temp = path.join(dir, 'Replacement.dxf'); await fs.writeFile(temp, nativeFixture);
      await fs.utimes(temp, modified, modified); await fs.rename(temp, file);
    });
    await expect(f.open(file)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    const after = await fs.stat(file, { bigint: true });
    expect(after.ino).not.toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeFixture); expect(await fs.readdir(dir)).toEqual(['Original.dxf']);
  });

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
