import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
type Preferences = Record<string, string>;
const { createPreferenceStore, CHECKPOINT_NAME, MIGRATION_NAME } = require('../electron/renderer-preferences.cjs') as {
  CHECKPOINT_NAME: string; MIGRATION_NAME: string;
  createPreferenceStore(options: { stateDir(): string; snapshot(contents: unknown): Promise<Preferences> }): {
    read(): Promise<Preferences | null>; checkpoint(contents: unknown, migration?: boolean): Promise<Preferences>;
  };
};
const repo = path.resolve(import.meta.dirname, '..');
const privateRoot = path.join(repo, '.codex-local', 'preference-startup-tests');
const directories: string[] = [];
const mainSource = fsSync.readFileSync(path.join(repo, 'electron/main.cjs'), 'utf8');
const startupStart = mainSource.indexOf('app.whenReady().then(async () => {', mainSource.indexOf('installWebContentsGuards(app);'));
const startupEnd = mainSource.indexOf("ipcMain.on('renderer-storage-migration'", startupStart);
if (startupStart < 0 || startupEnd < 0) throw new Error('The actual main startup callback could not be located');
const startupSource = mainSource.slice(startupStart, startupEnd);
const preloadSource = fsSync.readFileSync(path.join(repo, 'electron/preload.cjs'), 'utf8');
const preloadEnd = preloadSource.indexOf('contextBridge.exposeInMainWorld');
if (preloadEnd < 0) throw new Error('The actual preload preference prefix could not be located');

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== privateRoot) throw new Error('Unsafe private startup-profile cleanup');
    await files.rm(directory, { recursive: true, force: true });
  }
});

async function profile(checkpoint?: string) {
  await files.mkdir(privateRoot, { recursive: true });
  const directory = await files.mkdtemp(path.join(privateRoot, 'case-')); directories.push(directory);
  const legacy = path.join(directory, 'Local Storage', 'leveldb', 'owned-legacy-evidence');
  await files.mkdir(path.dirname(legacy), { recursive: true });
  await files.writeFile(legacy, 'private authored legacy evidence: Δ 雷\n');
  if (checkpoint !== undefined) await files.writeFile(path.join(directory, CHECKPOINT_NAME), checkpoint);
  return { directory, legacy, original: await files.readFile(legacy) };
}

/** Execute the real main ready callback and preload prefix; no Electron process is involved. */
async function startup(options: { directory: string; legacy: () => Promise<unknown>; current?: Preferences; dialogError?: Error }) {
  const storage = new Map(Object.entries(options.current ?? {}));
  const localStorage = {
    get length() { return storage.size; },
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const store = createPreferenceStore({ stateDir: () => options.directory,
    snapshot: async () => Object.fromEntries(storage) });
  const acknowledgement: Promise<unknown>[] = [];
  let ready: Promise<unknown> | undefined;
  const quit = vi.fn(), showErrorBox = vi.fn(() => { if (options.dialogError) throw options.dialogError; }), logMainError = vi.fn();
  const legacyStorage = vi.fn(options.legacy), loadPersistedPaths = vi.fn(), handOverFiles = vi.fn();
  const ipc = { sendSync: vi.fn((_channel: string) => context.rendererStorage),
    invoke: vi.fn((channel: string) => {
      if (channel !== 'renderer-storage-migrated') throw new Error('Unexpected preference IPC');
      const task = store.checkpoint({}, true).then(() => true);
      acknowledgement.push(task); return task;
    }) };
  const supplied: unknown[] = [];
  const createWindow = vi.fn(async () => {
    supplied.push(context.rendererStorage);
    // Model only the trusted bridge transport; both application scripts and the durable store
    // are real. If failed startup creates a window, its empty acknowledgement becomes visible.
    runInNewContext(preloadSource.slice(0, preloadEnd), {
      require: (name: string) => { if (name !== 'electron') throw new Error('Unexpected preload require'); return { ipcRenderer: ipc }; },
      location: { protocol: 'jcad:' }, localStorage,
    }, { filename: 'actual-preload-preferences.cjs' });
    await Promise.all(acknowledgement);
  });
  const context: Record<string, unknown> = {
    app: { whenReady: () => ({ then: (callback: () => Promise<unknown>) => { ready = callback(); return ready; } }), quit, on: vi.fn() },
    dialog: { showErrorBox }, session: { defaultSession: {} }, protocol: {}, net: {},
    BrowserWindow: class {}, __dirname: path.join(repo, 'electron'), path, fsSync,
    DEV_URL: null, stateDir: () => options.directory, rendererStorage: null, startingMainWindow: true,
    readRendererPreferences: store.read, legacyStorage, logMainError,
    installPermissionHandlers: vi.fn(), installAssetHandler: vi.fn(), loadPersistedPaths, handOverFiles,
    drawingArgs: vi.fn(() => []), process: { argv: ['private-test-jcad'], cwd: () => repo }, createWindow,
    probePhase: null, testBuild: true, runShippingProbe: vi.fn(), updater: { scheduleStartupCheck: vi.fn() }, ctx: { mainWindow: null },
  };
  runInNewContext(startupSource, context, { filename: 'actual-main-ready-callback.cjs' });
  if (!ready) throw new Error('Actual ready callback did not execute');
  let startupError: unknown;
  try { await ready; } catch (error) { if (!options.dialogError) throw error; startupError = error; }
  return { quit, showErrorBox, logMainError, legacyStorage, loadPersistedPaths, handOverFiles, createWindow, ipc, supplied, context, storage, startupError };
}

async function expectNoMigration(directory: string) {
  await expect(files.stat(path.join(directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(files.stat(path.join(directory, CHECKPOINT_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('main startup keeps an unsuccessful preference migration unacknowledged', () => {
  it.each(['load timed out', 'storage execution timed out', 'renderer crashed', 'oversize legacy data'])('does not create or acknowledge an empty origin after %s', async message => {
    const p = await profile(), failure = new Error(message);
    const result = await startup({ directory: p.directory, legacy: async () => { throw failure; } });
    expect(result.legacyStorage).toHaveBeenCalledOnce();
    expect(result.logMainError).toHaveBeenCalledWith('renderer preference migration', failure);
    expect(result.showErrorBox).toHaveBeenCalledOnce(); expect(result.quit).toHaveBeenCalledOnce();
    expect(result.loadPersistedPaths).not.toHaveBeenCalled(); expect(result.handOverFiles).not.toHaveBeenCalled();
    expect(result.createWindow).not.toHaveBeenCalled(); expect(result.ipc.invoke).not.toHaveBeenCalled();
    await expectNoMigration(p.directory); expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps a corrupt checkpoint and legacy evidence byte-identical instead of falling back or marking migration complete', async () => {
    const corrupt = '{"incomplete":"checkpoint"', p = await profile(corrupt);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.logMainError).toHaveBeenCalledOnce();
    expect(result.showErrorBox).toHaveBeenCalledOnce(); expect(result.quit).toHaveBeenCalledOnce();
    expect(result.createWindow).not.toHaveBeenCalled(); expect(result.ipc.invoke).not.toHaveBeenCalled();
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe(corrupt);
    await expect(files.stat(path.join(p.directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('quits without writing preferences even when the error dialog itself throws', async () => {
    const p = await profile(), failure = new Error('Controlled legacy failure'), dialogError = new Error('Controlled dialog failure');
    const result = await startup({ directory: p.directory, legacy: async () => { throw failure; }, dialogError });
    expect(result.startupError).toBe(dialogError); expect(result.quit).toHaveBeenCalledOnce();
    expect(result.logMainError).toHaveBeenCalledWith('renderer preference migration', failure);
    expect(result.createWindow).not.toHaveBeenCalled(); expect(result.ipc.invoke).not.toHaveBeenCalled();
    await expectNoMigration(p.directory); expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('does not treat a null legacy result as a successful empty migration', async () => {
    const p = await profile();
    const result = await startup({ directory: p.directory, legacy: async () => null });
    expect(result.quit).toHaveBeenCalledOnce(); expect(result.createWindow).not.toHaveBeenCalled();
    expect(result.ipc.invoke).not.toHaveBeenCalled(); await expectNoMigration(p.directory);
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('preserves an over-limit real checkpoint rather than replacing it with empty preferences', async () => {
    const bytes = JSON.stringify({ oversize: 'a'.repeat(8 * 1024 * 1024) }), p = await profile(bytes);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.quit).toHaveBeenCalledOnce();
    expect(result.createWindow).not.toHaveBeenCalled(); expect(result.ipc.invoke).not.toHaveBeenCalled();
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe(bytes);
    await expect(files.stat(path.join(p.directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('allows a genuinely successful empty legacy read to complete and persist an empty checkpoint', async () => {
    const p = await profile();
    const result = await startup({ directory: p.directory, legacy: async () => Object.create(null) });
    expect(result.quit).not.toHaveBeenCalled(); expect(result.showErrorBox).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(result.supplied).toEqual([{ source: 'legacy', values: {} }]);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('uses an authoritative checkpoint without reading old legacy data', async () => {
    const values = JSON.parse('{"__proto__":"own value","preference":"new Δ 雷"}') as Preferences;
    const p = await profile(JSON.stringify(values));
    const result = await startup({ directory: p.directory, legacy: async () => { throw new Error('Legacy must not run'); } });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([{ source: 'checkpoint', values }]);
    expect(JSON.parse(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8'))).toEqual(values);
    expect(result.storage.get('__proto__')).toBe('own value'); expect(result.storage.get('preference')).toBe('new Δ 雷');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('treats an empty checkpoint as authoritative and never resurrects legacy keys', async () => {
    const p = await profile('{}');
    const result = await startup({ directory: p.directory, legacy: async () => ({ deleted: 'stale' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.createWindow).toHaveBeenCalledOnce();
    expect(result.storage.has('deleted')).toBe(false);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
  });

  it('keeps existing nonempty current-origin preferences and does not restore a deleted checkpoint key', async () => {
    const p = await profile(JSON.stringify({ preference: 'old', deleted: 'stale' }));
    const result = await startup({ directory: p.directory, legacy: async () => ({ preference: 'older' }), current: { preference: 'newest' } });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.storage.get('preference')).toBe('newest'); expect(result.storage.has('deleted')).toBe(false);
    expect(JSON.parse(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8'))).toEqual({ preference: 'newest' });
  });
});
