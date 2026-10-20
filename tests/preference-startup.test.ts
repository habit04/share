/**
 * P-MIG on this line (PR23 ASAR fix): a failed startup preference migration must
 * survive — unacknowledged — without stopping startup.
 *
 * Before this change, any failure in the startup migration block (a corrupt
 * checkpoint, a legacy extraction that timed out) showed a modal error dialog and
 * quit before the main window opened; under an unattended launch (CI) nobody
 * dismisses the dialog and the process wedges. The startup decision now lives in
 * electron/main/startup-migration.cjs (ported from the P-MIG line, gate semantics
 * unchanged): every failure is logged exactly once and startup continues with no
 * stored values. Only a failed migration LEG sets ctx.legacyMigrationFailed; while
 * it stands, neither the 'renderer-storage-migrated' checkpoint (the only write of
 * the migration marker) nor a close-time checkpoint may mark the migration
 * complete, so the next launch retries the extraction. A checkpoint-READ failure
 * does NOT set it: the recovery copy self-heals from the renderer's live storage
 * on the next committed checkpoint, as it always could once a window opened.
 *
 * What these tests drive, exactly: the REAL startup gate
 * (electron/main/startup-migration.cjs) executing inside the REAL main ready
 * callback sliced out of electron/main.cjs, the REAL preload preference prefix,
 * and the REAL preference store over a temp profile. What is modeled, and why:
 * only the 'renderer-storage-migrated' handler's one-line early return — that
 * handler lives below the sliced callback; the harness's invoke models it by
 * consulting the same ctx flag the gate wrote, and static pins below assert the
 * production handler and the window close path carry the same guards.
 */
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
const { runStartupMigration } = require('../electron/main/startup-migration.cjs') as {
  runStartupMigration: unknown;
};
const repo = path.resolve(import.meta.dirname, '..');
const privateRoot = path.join(repo, '.codex-local', 'preference-startup-tests');
const directories: string[] = [];
const mainSource = fsSync.readFileSync(path.join(repo, 'electron/main.cjs'), 'utf8');
const startupStart = mainSource.indexOf('app.whenReady().then(async () => {', mainSource.indexOf('installWebContentsGuards(app);'));
const startupEnd = mainSource.indexOf("ipcMain.on('renderer-storage-migration'", startupStart);
if (startupStart < 0 || startupEnd < 0) throw new Error('The actual main startup callback could not be located');
const startupSource = mainSource.slice(startupStart, startupEnd);
const windowSource = fsSync.readFileSync(path.join(repo, 'electron/main/window.cjs'), 'utf8');
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
async function startup(options: { directory: string; legacy: () => Promise<unknown>; current?: Preferences }) {
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
  const quit = vi.fn(), showErrorBox = vi.fn(), logMainError = vi.fn();
  const legacyStorage = vi.fn(options.legacy), loadPersistedPaths = vi.fn(), handOverFiles = vi.fn();
  const ipc = { sendSync: vi.fn((_channel: string) => context.rendererStorage),
    invoke: vi.fn((channel: string) => {
      if (channel !== 'renderer-storage-migrated') throw new Error('Unexpected preference IPC');
      // Model the production handler's one-line P-MIG guard (electron/main.cjs):
      // while the failure flag stands, the migrated checkpoint — the only write of
      // the migration marker — is refused. Static pins below tie this to the text.
      if ((context.ctx as { legacyMigrationFailed: boolean }).legacyMigrationFailed) return Promise.resolve(false);
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
    readRendererPreferences: store.read, legacyStorage, logMainError, runStartupMigration,
    installPermissionHandlers: vi.fn(), installAssetHandler: vi.fn(), loadPersistedPaths, handOverFiles,
    drawingArgs: vi.fn(() => []), process: { argv: ['private-test-jcad'], cwd: () => repo }, createWindow,
    probePhase: null, testBuild: true, runShippingProbe: vi.fn(), updater: { scheduleStartupCheck: vi.fn() },
    ctx: { mainWindow: null, legacyMigrationFailed: false },
  };
  runInNewContext(startupSource, context, { filename: 'actual-main-ready-callback.cjs' });
  if (!ready) throw new Error('Actual ready callback did not execute');
  await ready;
  return { quit, showErrorBox, logMainError, legacyStorage, loadPersistedPaths, handOverFiles, createWindow, ipc, supplied, context, storage };
}

function migrationFailed(result: { context: Record<string, unknown> }) {
  return (result.context.ctx as { legacyMigrationFailed: boolean }).legacyMigrationFailed;
}

async function expectNoMigration(directory: string) {
  await expect(files.stat(path.join(directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(files.stat(path.join(directory, CHECKPOINT_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('main startup keeps an unsuccessful preference migration unacknowledged', () => {
  it.each(['load timed out', 'storage execution timed out', 'renderer crashed', 'oversize legacy data'])('keeps the migration unacknowledged and starts with no stored values after %s', async message => {
    const p = await profile(), failure = new Error(message);
    const result = await startup({ directory: p.directory, legacy: async () => { throw failure; } });
    expect(result.legacyStorage).toHaveBeenCalledOnce();
    expect(result.logMainError).toHaveBeenCalledOnce();
    expect(result.logMainError).toHaveBeenCalledWith('renderer preference migration', failure);
    // No modal, no quit: startup continues and the main window opens (PR23 ASAR fix).
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    // The failed leg keeps the retry: the migrated checkpoint is refused, so no
    // checkpoint or marker is written over settings that were never read.
    expect(migrationFailed(result)).toBe(true);
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    await expectNoMigration(p.directory); expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps a corrupt checkpoint from falling back to legacy values while startup proceeds', async () => {
    const corrupt = '{"incomplete":"checkpoint"', p = await profile(corrupt);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.logMainError).toHaveBeenCalledOnce();
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    expect(result.storage.has('stale')).toBe(false);
    // A checkpoint-READ failure is not a migration-leg failure (P-MIG): the retry
    // flag stays clear, so the acknowledgement commits the renderer's live storage
    // and the corrupt recovery copy self-heals instead of wedging every launch.
    expect(migrationFailed(result)).toBe(false);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('does not treat a null legacy result as a successful empty migration', async () => {
    const p = await profile();
    const result = await startup({ directory: p.directory, legacy: async () => null });
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    expect(migrationFailed(result)).toBe(true);
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    await expectNoMigration(p.directory);
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps an over-limit checkpoint from falling back to legacy values while startup proceeds', async () => {
    const bytes = JSON.stringify({ oversize: 'a'.repeat(8 * 1024 * 1024) }), p = await profile(bytes);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled(); expect(result.logMainError).toHaveBeenCalledOnce();
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    expect(result.storage.has('stale')).toBe(false);
    // Same self-heal as the corrupt case: the unreadable file itself is never used,
    // and the committed checkpoint is the renderer's live (here empty) storage.
    expect(migrationFailed(result)).toBe(false);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('allows a genuinely successful empty legacy read to complete and persist an empty checkpoint', async () => {
    const p = await profile();
    const result = await startup({ directory: p.directory, legacy: async () => Object.create(null) });
    expect(result.quit).not.toHaveBeenCalled(); expect(result.showErrorBox).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(result.supplied).toEqual([{ source: 'legacy', values: {} }]);
    expect(migrationFailed(result)).toBe(false);
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

describe('P-MIG retry guards (static pins on the production text)', () => {
  it('the startup callback delegates to the gate and never shows the modal error dialog', () => {
    expect(startupSource).toContain('runStartupMigration({');
    expect(startupSource).not.toContain('showErrorBox');
  });

  it('the migrated handler refuses its checkpoint while the failure flag stands', () => {
    const handler = mainSource.indexOf("ipcMain.handle('renderer-storage-migrated'");
    expect(handler).toBeGreaterThan(0);
    expect(mainSource.slice(handler, handler + 600)).toContain('if (ctx.legacyMigrationFailed) return false;');
  });

  it('the close-time checkpoint is skipped while the failure flag stands', () => {
    expect(windowSource).toContain('if (!ctx.legacyMigrationFailed) await checkpointRendererPreferences(win.webContents);');
  });
});
