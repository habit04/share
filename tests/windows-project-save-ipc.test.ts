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
type NativeTestOwner = {
  directory: string;
  signal: AbortSignal;
  abort(): void;
  tasks: Set<Promise<unknown>>;
  fixtures: Set<{ close(): Promise<void> }>;
};
const privateTempRoot = path.resolve(tmpdir());
let dir: string, owner: NativeTestOwner;
function track<T>(scope: NativeTestOwner, promise: Promise<T>) {
  scope.tasks.add(promise);
  void promise.then(() => scope.tasks.delete(promise), () => scope.tasks.delete(promise));
  return promise;
}
beforeEach(async ({ signal, onTestFinished }) => {
  dir = await fs.mkdtemp(path.join(privateTempRoot, 'jcad-native-project-save-'));
  const controller = new AbortController();
  const scope: NativeTestOwner = {
    directory: dir, signal: controller.signal, tasks: new Set(), fixtures: new Set(),
    abort() {
      controller.abort();
      for (const fixture of scope.fixtures) void fixture.close().catch(() => {});
    },
  };
  owner = scope;
  const abort = () => scope.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  onTestFinished(() => signal.removeEventListener('abort', abort));
});
afterEach(async () => {
  const scope = owner;
  // Stop producers first; batch cancellation keeps native work owned until joined.
  scope.abort();
  const shutdown = Promise.all([...scope.fixtures].map(fixture => fixture.close()));
  void shutdown.catch(() => {});
  try {
    await Promise.allSettled([...scope.tasks]);
    await shutdown;
  } finally { vi.restoreAllMocks(); }
  if (path.dirname(scope.directory) !== privateTempRoot || !path.basename(scope.directory).startsWith('jcad-native-project-save-')) throw new Error('Unsafe native project test cleanup');
  await fs.rm(scope.directory, { recursive: true, force: true });
});

function setup() {
  const scope = owner, directory = scope.directory;
  const registry = createPathRegistry(), handlers = new Map<string, Handler>(), log = { reject: vi.fn() };
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents });
  const ev = { sender: contents, senderFrame: frame };
  const raw = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const ipcMain = guardIpc(raw, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log });
  const pathPolicy = createPathPolicy({ isKnownPath: (file: string) => registry.isKnown(file), isWritablePath: (file: string) => registry.isWritable(file), knownPaths: () => registry.paths(), log });
  const dialog = { showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn() };
  const decode = vi.fn((bytes: Uint8Array) => Promise.resolve(decodeDxfBytes(bytes)));
  const enqueueWrite = atomic.createCanonicalWriteQueue(), module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  new Function('require', 'module', source)((name: string) => {
    if (name === 'electron') return { dialog };
    if (name === './app-data.cjs') return { enqueueWrite, writeUserFile: (file: string, text: string, opts: unknown) => enqueueWrite(file, key => atomic.atomicWriteFile(file, text, { ...(opts as object), expectedDestination: key })) };
    if (name === './dwg.cjs') return { decodeDxf: decode, readDwgWithProgress: () => { throw new Error('No native DWG decoder in this DXF test.'); } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status: () => ({ available: false }), export: () => { throw new Error('No native writer fixture.'); } }) };
    return require(name);
  }, module);
  module.exports.registerDrawingIpc({ ipcMain, rejections: log, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const pending = new Set<Promise<unknown>>(), batches = new Set<string>();
  let shutdown: Promise<void> | undefined;
  const rawInvoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(ev, ...args);
  const invoke = (channel: string, ...args: unknown[]) => {
    const task = (async () => {
      scope.signal.throwIfAborted();
      const result = rawInvoke(channel, ...args);
      // Issuance is synchronous in production. Retain its ticket before the await
      // so timeout cancellation cannot miss an issued-but-not-yet-returned batch.
      if (channel === 'issue-project-save-batch' && typeof result === 'string') batches.add(result);
      const value = await result;
      if (channel === 'cancel-project-save-batch') batches.delete(args[0] as string);
      scope.signal.throwIfAborted();
      return value;
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return track(scope, task);
  };
  const close = () => {
    if (shutdown) return shutdown;
    // Start the joined channel while its original main-frame owner is live.
    const joined = [...batches].map(ticket => {
      try { return Promise.resolve(rawInvoke('cancel-project-save-batch', ticket)); }
      catch (error) { return Promise.reject(error); }
    });
    win.emit('closed');
    shutdown = (async () => {
      const results = await Promise.allSettled(joined);
      await Promise.allSettled([...pending]);
      for (const result of results) if (result.status === 'rejected' && (result.reason as { code?: string })?.code !== 'ERR_SAVE_TICKET') throw result.reason;
    })();
    void shutdown.catch(() => {});
    return shutdown;
  };
  scope.fixtures.add({ close });
  const reserve = async (file: string) => {
    const ticket = await invoke('issue-save-admission', 'drawing') as string;
    await invoke('bind-save-admission', ticket, 'drawing', file); return ticket;
  };
  const files = (count: number) => track(scope, (async () => {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      scope.signal.throwIfAborted();
      const file = path.join(directory, `Sheet-${i}.dxf`); await fs.writeFile(file, nativeFixture);
      scope.signal.throwIfAborted(); registry.grant(file); paths.push(file);
    }
    return paths;
  })());
  const bind = async (paths: string[]) => {
    const batch = await invoke('issue-project-save-batch') as string;
    const manifest = await invoke('bind-project-save-batch', batch, paths) as Binding[];
    return { batch, manifest };
  };
  return { registry, invoke, reserve, files, bind, contents, win, handlers, decode };
}
function child(binding: Binding) { if ('missing' in binding) throw new Error('Expected a native existing source.'); return binding; }
function edited(text: string, x: number) {
  const drawing = new Drawing(readDxf(text));
  drawing.addEntities([{ id: 'batch-edit', type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 8 } }]);
  drawing.undo(); drawing.redo(); return writeDxf(drawing.snapshot);
}

// Real file bytes/descriptors, with only the original native version fields held constant.
// Deterministic clock collisions exercise byte evidence without depending on NTFS timing.
async function holdNativeVersion(file: string, beforeRead?: () => Promise<void>) {
  const [large, ordinary] = await Promise.all([fs.stat(file, { bigint: true }), fs.stat(file)]);
  const stat = fs.stat, lstat = fs.lstat, open = fs.open;
  vi.spyOn(fs, 'stat').mockImplementation((async (name, options) => String(name) === file
    ? options?.bigint ? large : ordinary : stat(name, options)) as typeof fs.stat);
  vi.spyOn(fs, 'lstat').mockImplementation((async (name, options) => String(name) === file
    ? options?.bigint ? large : ordinary : lstat(name, options)) as typeof fs.lstat);
  let readIntervened = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const drawingRead = new Error().stack?.includes('readLimitedFile'), handle = await open(...args);
    if (String(args[0]) === file && (args[1] === 0 || args[1] === 'r')) {
      handle.stat = (async options => options?.bigint ? large : ordinary) as typeof handle.stat;
      if (drawingRead && beforeRead) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs) => {
          if (!readIntervened) { readIntervened = true; await beforeRead(); }
          return Reflect.apply(read, handle, readArgs);
        }) as typeof handle.read;
      }
    }
    return handle;
  });
  return () => readIntervened;
}
const clockDxf = (text: string) => [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1032', 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES', 0, 'TEXT', 8, '0', 10, 1, 20, 2, 40, 2.5, 1, text, 0, 'ENDSEC', 0, 'EOF', ''].join('\r\n');

describe.runIf(process.platform === 'win32')('bounded project saves through production IPC and native NTFS files', () => {
  it('keeps an admitted project calculation input pinned when only ctime changes during its native read', async () => {
    const f = setup(), [file] = await f.files(1), modified = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(file!, modified, modified);
    const before = await fs.stat(file!, { bigint: true }), { batch, manifest } = await f.bind([file!]), binding = child(manifest[0]!);
    const nativeOpen = fs.open; let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const drawingRead = new Error().stack?.includes('readLimitedFile'), handle = await nativeOpen(...args);
      if (!drawingRead || String(args[0]) !== file) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...values: any[]) => {
          const result = await (target.read as any)(...values);
          if (!changed && result.bytesRead > 0) { changed = true; await fs.utimes(file!, new Date('2021-01-01T00:00:00Z'), modified); }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    await expect(f.invoke('open-project-save-batch-drawing', batch, binding.childTicket)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(changed).toBe(true); expect(f.decode).not.toHaveBeenCalled();
    const after = await fs.stat(file!, { bigint: true });
    expect(after.ctimeNs).not.toBe(before.ctimeNs); expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await fs.readFile(file!, 'utf8')).toBe(nativeFixture);
    await expect(f.invoke('cancel-project-save-batch', batch)).rejects.toThrow(/ERR_SAVE_TICKET/);
  });

  it('refuses a changed same-size calculation input before decoding even when every native version field collides', async () => {
    const f = setup(), file = path.join(dir, 'Clock.dxf'), original = clockDxf('CLOCK_ORIGINAL'), external = clockDxf('CLOCK_EXTERNAL');
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(external)); await fs.writeFile(file, original); f.registry.grant(file);
    const { batch, manifest } = await f.bind([file]), b = child(manifest[0]!);
    const intervened = await holdNativeVersion(file, () => fs.writeFile(file, external));
    await expect(f.invoke('open-project-save-batch-drawing', batch, b.childTicket)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(intervened()).toBe(true); expect(f.decode).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe(external);
    expect(readDxf(external).entities[0]).toMatchObject({ type: 'text', text: 'CLOCK_EXTERNAL' });
    await f.invoke('cancel-project-save-batch', batch).catch(() => {});
  });

  it('refuses a same-size standalone source edit during decoding when native timestamps are restored', async () => {
    const f = setup(), file = path.join(dir, 'Decode.dxf'), original = clockDxf('CLOCK_ORIGINAL'), external = clockDxf('CLOCK_EXTERNAL');
    await fs.writeFile(file, original); f.registry.grant(file); await holdNativeVersion(file);
    f.decode.mockImplementationOnce(async bytes => { await fs.writeFile(file, external); return decodeDxfBytes(bytes); });
    await expect(f.invoke('open-drawing', file)).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(f.decode).toHaveBeenCalledOnce(); expect(await fs.readFile(file, 'utf8')).toBe(external);
  });

  it('reads, edits, backs up and freshly reopens 33 files under one inherited project order', ({ onTestFailed }) => {
    const scope = owner, started = performance.now();
    const stages: Array<{ stage: string; index?: number; elapsedMs: number }> = [];
    const mark = (stage: string, index?: number) => {
      scope.signal.throwIfAborted();
      stages.push({ stage, ...(index === undefined ? {} : { index }), elapsedMs: Math.round(performance.now() - started) });
    };
    onTestFailed(() => { console.error('Native 33-file project stages', JSON.stringify({ stages, aborted: scope.signal.aborted })); });
    return track(scope, (async () => {
      const f = setup(); mark('files-start');
      const paths = await f.files(33); mark('files-complete'); mark('bind-start');
      const { batch, manifest } = await f.bind(paths); mark('bind-complete');
      expect(manifest).toHaveLength(33);
      const outputs: string[] = [];
      for (const [i, entry] of manifest.entries()) {
        const b = child(entry); mark('open-start', i);
        const input = await f.invoke('open-project-save-batch-drawing', batch, b.childTicket) as Opened; mark('open-complete', i);
        expect(input.path).toBe(paths[i]); expect(input.identityPath).toBe(b.identityPath);
        mark('edit-start', i); outputs.push(edited(input.text, i)); mark('edit-complete', i);
      }
      const children = manifest.map(entry => child(entry).childTicket);
      mark('seal-start'); await f.invoke('seal-project-save-batch', batch, children); mark('seal-complete');
      for (const [i, entry] of manifest.entries()) {
        mark('backup-start', i);
        expect(await f.invoke('backup-file', entry.path, { admission: child(entry).childTicket })).toEqual({ ok: true, path: `${entry.path}.bak` });
        mark('backup-complete', i);
      }
      mark('begin-commit-start'); await f.invoke('begin-project-save-batch-commit', batch); mark('begin-commit-complete');
      for (const [i, entry] of manifest.entries()) {
        const b = child(entry); mark('save-start', i);
        expect(await f.invoke('save-dxf', entry.path, outputs[i], 'Sheet', { backup: false, admission: b.childTicket })).toBe(entry.path); mark('save-complete', i);
        mark('receipt-start', i);
        expect(await f.invoke('save-admission-result', b.childTicket)).toEqual({ path: entry.path, identityPath: b.identityPath }); mark('receipt-complete', i);
        mark('backup-read-start', i); expect(await fs.readFile(`${entry.path}.bak`, 'utf8')).toBe(nativeFixture); mark('backup-read-complete', i);
        mark('reopen-start', i); const reopened = readDxf(await fs.readFile(entry.path, 'utf8'));
        expect(reopened.entities.filter(e => e.type === 'point').map(e => e.position.x)).toEqual([i]); mark('reopen-complete', i);
      }
      mark('cancel-start'); await f.invoke('cancel-project-save-batch', batch); mark('cancel-complete');
      mark('readdir-start'); expect((await fs.readdir(scope.directory)).filter(name => name.includes('.tmp-'))).toEqual([]); mark('readdir-complete');
    })());
  // 60s: owner-accepted product latency — see SAVE33-TIMING-EVIDENCE.md (D1, 2026-10-18).
  }, 60000);

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

  it('reports an actual unverified replacement and refuses later derived outputs after an external post-rename edit', async () => {
    const f = setup(), paths = await f.files(2), { batch, manifest } = await f.bind(paths);
    for (const entry of manifest) await f.invoke('open-project-save-batch-drawing', batch, child(entry).childTicket);
    const first = child(manifest[0]!), second = child(manifest[1]!);
    await f.invoke('seal-project-save-batch', batch, [first.childTicket, second.childTicket]);
    await f.invoke('begin-project-save-batch-commit', batch);
    const outside = edited(nativeFixture, 999), rename = fs.rename; let replaced = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dest) => {
      await rename(src, dest);
      if (String(dest) === paths[0] && !replaced) { replaced = true; await fs.writeFile(paths[0]!, outside); }
    });
    await expect(f.invoke('save-dxf', paths[0], edited(nativeFixture, 100), 'first', { admission: first.childTicket })).rejects.toThrow(/ERR_SAVE_COMMITTED.*replacement occurred/);
    expect(replaced).toBe(true); expect(await fs.readFile(paths[0]!, 'utf8')).toBe(outside);
    expect(await fs.readFile(`${paths[0]}.bak`, 'utf8')).toBe(nativeFixture);
    expect(await f.invoke('save-admission-result', first.childTicket)).toBe(null);
    await expect(f.invoke('save-dxf', paths[1], edited(nativeFixture, 200), 'second', { admission: second.childTicket, backup: false })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED|ERR_SAVE_STALE/);
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe(nativeFixture);
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
