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
 * does NOT set it; since round 2 (lead ruling) it sets ctx.checkpointUnreadable
 * instead, and while THAT stands the same two guards protect the checkpoint file
 * itself. Since round 3 the gate renames the unreadable file aside (bytes
 * preserved, never deleted): only a successful rename clears the flag, so the
 * normal writers resume on a fresh checkpoint while the evidence survives; a
 * failed rename keeps the guard for the whole launch. Round 4 narrows the
 * rename to tagged DECODE failures only (bad JSON, invalid shape, over-limit,
 * symlink — an fs error such as an AV lock's EBUSY keeps the guard with NO
 * rename), logs a rename failure with its code, and after a successful rename
 * falls through to the marker check and the legacy leg in the same launch.
 *
 * What these tests drive, exactly: the REAL startup gate
 * (electron/main/startup-migration.cjs) executing inside the REAL main ready
 * callback sliced out of electron/main.cjs, the REAL preload preference prefix,
 * and the REAL preference store over a temp profile. In the full-startup runs
 * the 'renderer-storage-migrated' invoke is modeled by consulting the same ctx
 * flags the gate wrote (the handler lives below the sliced callback) — but the
 * guards themselves are ALSO driven for real below: the actual handler sliced
 * out of electron/main.cjs and the actual persistBeforeClose sliced out of
 * electron/main/window.cjs, each executed with the failure flags set, plus
 * static pins on the production text (round 3 addition).
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
const handlerStart = mainSource.indexOf("ipcMain.handle('renderer-storage-migrated', async (event) => {");
const handlerEnd = handlerStart < 0 ? -1 : mainSource.indexOf('\n});', handlerStart);
if (handlerStart < 0 || handlerEnd < 0) throw new Error('The actual migrated handler could not be located');
const handlerSource = mainSource.slice(handlerStart, handlerEnd + 4);
const persistStart = windowSource.indexOf('  async function persistBeforeClose(win, canAcceptLoss = true) {');
const persistEnd = persistStart < 0 ? -1 : windowSource.indexOf('\n  let closeSeq', persistStart);
if (persistStart < 0 || persistEnd < 0) throw new Error('The actual persistBeforeClose could not be located');
const persistSource = windowSource.slice(persistStart, persistEnd);
const preloadSource = fsSync.readFileSync(path.join(repo, 'electron/preload.cjs'), 'utf8');
const preloadEnd = preloadSource.indexOf('contextBridge.exposeInMainWorld');
if (preloadEnd < 0) throw new Error('The actual preload preference prefix could not be located');
// Round 12b (R12-1): the production pre-ready snapshot statement(s), sliced
// out of main.cjs (after the single-instance lock, before
// registerSecondInstance and whenReady) and executed over a test profile.
const preReadyStart = mainSource.indexOf('const legacyStorePresent =');
const preReadyEnd = preReadyStart < 0 ? -1 : mainSource.indexOf('\nregisterSecondInstance();', preReadyStart);
if (preReadyStart < 0 || preReadyEnd < 0) throw new Error('The actual pre-ready legacy snapshot could not be located');
const preReadySource = mainSource.slice(preReadyStart, preReadyEnd);

/** Execute the real pre-ready legacy snapshot over `directory` (the userData folder). */
function preReady(directory: string, devUrl: string | null = null) {
  return runInNewContext(`${preReadySource}\n;({ legacyStorePresent })`,
    { DEV_URL: devUrl, fsSync, path, stateDir: () => directory },
    { filename: 'actual-main-pre-ready.cjs' }) as { legacyStorePresent: boolean };
}

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
async function startup(options: { directory: string; legacy: () => Promise<unknown>; current?: Preferences; renameFails?: boolean; storePresent?: boolean }) {
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
  // Round 12: main.cjs snapshots the legacy store's existence BEFORE
  // whenReady (right after the single-instance lock) and the ready
  // callback reads the free binding `legacyStorePresent` (round 9's
  // snapshot rule, kept). This suite's profiles seed the legacy store
  // before startup, so the snapshot is true unless a case overrides
  // it (the fresh-profile case below). The stub legacy above ignores
  // its arguments; the real in-process read is covered in
  // tests/legacy-storage.test.ts, and a static pin below orders the
  // snapshot before whenReady/session use in the production text.
  const legacyStorePresent = options.storePresent ?? true;
  const ipc = { sendSync: vi.fn((_channel: string) => context.rendererStorage),
    invoke: vi.fn((channel: string) => {
      if (channel !== 'renderer-storage-migrated') throw new Error('Unexpected preference IPC');
      // Model the production handler's one-line guard (electron/main.cjs): while
      // either failure flag stands, the migrated checkpoint — the only write of
      // the migration marker — is refused. Static pins below tie this to the text.
      const flags = context.ctx as { legacyMigrationFailed: boolean; checkpointUnreadable: boolean };
      if (flags.legacyMigrationFailed || flags.checkpointUnreadable) return Promise.resolve(false);
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
    readRendererPreferences: store.read, legacyStorage, legacyStorePresent, logMainError, runStartupMigration,
    renameUnreadableCheckpoint: async () => {
      // The entry point binds app-data's rename over the same real profile; the
      // harness binds the same operation over the test profile (or a failure).
      if (options.renameFails) throw Object.assign(new Error('Controlled rename failure'), { code: 'EPERM' });
      const from = path.join(options.directory, CHECKPOINT_NAME);
      const aside = `${from}.unreadable-test`;
      await files.rename(from, aside); return aside;
    },
    installPermissionHandlers: vi.fn(), installAssetHandler: vi.fn(), loadPersistedPaths, handOverFiles,
    drawingArgs: vi.fn(() => []), process: { argv: ['private-test-jcad'], cwd: () => repo }, createWindow,
    probePhase: null, testBuild: true, runShippingProbe: vi.fn(), updater: { scheduleStartupCheck: vi.fn() },
    ctx: { mainWindow: null, legacyMigrationFailed: false, checkpointUnreadable: false },
  };
  runInNewContext(startupSource, context, { filename: 'actual-main-ready-callback.cjs' });
  if (!ready) throw new Error('Actual ready callback did not execute');
  await ready;
  return { quit, showErrorBox, logMainError, legacyStorage, loadPersistedPaths, handOverFiles, createWindow, ipc, supplied, context, storage };
}

function migrationFailed(result: { context: Record<string, unknown> }) {
  return (result.context.ctx as { legacyMigrationFailed: boolean }).legacyMigrationFailed;
}

function checkpointUnreadable(result: { context: Record<string, unknown> }) {
  return (result.context.ctx as { checkpointUnreadable: boolean }).checkpointUnreadable;
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

  it('preserves a corrupt checkpoint aside, runs the legacy leg and checkpoints its values', async () => {
    const corrupt = '{"incomplete":"checkpoint"', p = await profile(corrupt);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce();
    // A checkpoint-READ failure is not a migration-leg failure (P-MIG): the leg
    // flag stays clear. Round 3: the gate renames the unreadable file aside —
    // the corrupt bytes survive byte-identical under the new name and the
    // renamed path is logged once, after the read failure itself.
    expect(migrationFailed(result)).toBe(false); expect(checkpointUnreadable(result)).toBe(false);
    expect(result.logMainError).toHaveBeenCalledTimes(2);
    const loggedMessages = result.logMainError.mock.calls.map((call) => String((call[1] as Error).message));
    expect(loggedMessages[1]).toContain('Unreadable checkpoint preserved at');
    expect(await files.readFile(path.join(p.directory, `${CHECKPOINT_NAME}.unreadable-test`), 'utf8')).toBe(corrupt);
    // Round 4 (F2): the renamed state is 'no checkpoint', so the SAME launch
    // falls through to the legacy leg — its values are served, merged and
    // checkpointed, instead of a marker being written over un-migrated data.
    expect(result.legacyStorage).toHaveBeenCalledOnce();
    expect(result.supplied).toEqual([{ source: 'legacy', values: { stale: 'legacy' } }]);
    expect(result.storage.get('stale')).toBe('legacy');
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(JSON.parse(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8'))).toEqual({ stale: 'legacy' });
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps the retry when the leg fails after a successful rename-aside', async () => {
    const corrupt = '{"incomplete":"checkpoint"', p = await profile(corrupt);
    const failure = new Error('load timed out');
    const result = await startup({ directory: p.directory, legacy: async () => { throw failure; } });
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    // The rename succeeded (bytes preserved aside, guard cleared), then the
    // fall-through leg FAILED (round 4, F2): legacyMigrationFailed stands, so
    // the acknowledgement is refused — no fresh checkpoint, no marker — and
    // the next launch retries the leg against the now-absent checkpoint.
    expect(result.legacyStorage).toHaveBeenCalledOnce();
    expect(migrationFailed(result)).toBe(true); expect(checkpointUnreadable(result)).toBe(false);
    expect(result.logMainError).toHaveBeenCalledTimes(3);
    expect(await files.readFile(path.join(p.directory, `${CHECKPOINT_NAME}.unreadable-test`), 'utf8')).toBe(corrupt);
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    await expect(files.stat(path.join(p.directory, CHECKPOINT_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(files.stat(path.join(p.directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps the guard and renames nothing when the checkpoint read fails with a filesystem error', async () => {
    const p = await profile();
    // A directory where the checkpoint file belongs: the real store's read
    // fails with EISDIR — an fs-coded error, the EBUSY/EPERM class (round 4,
    // F1). The bytes behind it may be perfectly valid, so nothing is retired.
    const checkpointPath = path.join(p.directory, CHECKPOINT_NAME);
    await files.mkdir(checkpointPath);
    await files.writeFile(path.join(checkpointPath, 'sentinel'), 'do not move');
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled();
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    // The read failure is logged once; no rename is attempted, the guard
    // stands for the whole launch, and the acknowledgement is refused.
    expect(result.logMainError).toHaveBeenCalledOnce();
    expect((result.logMainError.mock.calls[0]?.[1] as { code?: string }).code).toBe('EISDIR');
    expect(migrationFailed(result)).toBe(false); expect(checkpointUnreadable(result)).toBe(true);
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(await files.readFile(path.join(checkpointPath, 'sentinel'), 'utf8')).toBe('do not move');
    expect((await files.readdir(p.directory)).filter((name) => name.includes('.unreadable-'))).toEqual([]);
    await expect(files.stat(path.join(p.directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('keeps the overwrite guard when the unreadable checkpoint cannot be renamed aside', async () => {
    const corrupt = '{"incomplete":"checkpoint"', p = await profile(corrupt);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }), renameFails: true });
    expect(result.legacyStorage).not.toHaveBeenCalled();
    // Round 4 (F1): the rename failure itself is logged too, with its fs code —
    // the read failure is the first call, the rename failure the second.
    expect(result.logMainError).toHaveBeenCalledTimes(2);
    expect((result.logMainError.mock.calls[1]?.[1] as { code?: string }).code).toBe('EPERM');
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.supplied).toEqual([null]);
    // A failed rename keeps round 2's protection exactly: flag set, bytes in
    // place, acknowledgement refused, no fresh checkpoint, no marker.
    expect(migrationFailed(result)).toBe(false); expect(checkpointUnreadable(result)).toBe(true);
    expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe(corrupt);
    await expect(files.stat(path.join(p.directory, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('preserves an over-limit checkpoint aside and checkpoints the merged live + legacy values', async () => {
    const bytes = JSON.stringify({ oversize: 'a'.repeat(8 * 1024 * 1024) }), p = await profile(bytes);
    const result = await startup({ directory: p.directory, legacy: async () => ({ stale: 'legacy' }), current: { preference: 'newest' } });
    expect(result.showErrorBox).not.toHaveBeenCalled(); expect(result.quit).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce();
    // The over-limit bytes are never used and never destroyed: they survive in
    // the renamed file. The state is then 'no checkpoint' (round 4, F2): the
    // legacy leg runs in the same launch and its values merge UNDER the live
    // origin's — the fresh checkpoint at the original path holds both, and is
    // never written over the preserved bytes.
    expect(result.legacyStorage).toHaveBeenCalledOnce();
    expect(result.supplied).toEqual([{ source: 'legacy', values: { stale: 'legacy' } }]);
    expect(result.storage.get('preference')).toBe('newest');
    expect(result.storage.get('stale')).toBe('legacy');
    expect(migrationFailed(result)).toBe(false); expect(checkpointUnreadable(result)).toBe(false);
    expect(await files.readFile(path.join(p.directory, `${CHECKPOINT_NAME}.unreadable-test`), 'utf8')).toBe(bytes);
    expect(JSON.parse(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8'))).toEqual({ preference: 'newest', stale: 'legacy' });
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('re-runs the legacy leg on the next startup after a failed leg and merges its values', async () => {
    const p = await profile();
    const failure = new Error('storage execution timed out');
    const first = await startup({ directory: p.directory, legacy: async () => { throw failure; } });
    expect(first.legacyStorage).toHaveBeenCalledOnce(); expect(migrationFailed(first)).toBe(true);
    await expectNoMigration(p.directory);
    // Second launch over the SAME profile: nothing was marked complete, so the
    // gate runs the extraction again; this time it succeeds and its values are
    // served, inserted into the empty origin, and committed with the marker.
    const second = await startup({ directory: p.directory, legacy: async () => ({ preference: 'legacy value Δ', theme: 'dark' }) });
    expect(second.legacyStorage).toHaveBeenCalledOnce();
    expect(migrationFailed(second)).toBe(false); expect(checkpointUnreadable(second)).toBe(false);
    expect(second.supplied).toEqual([{ source: 'legacy', values: { preference: 'legacy value Δ', theme: 'dark' } }]);
    expect(second.storage.get('preference')).toBe('legacy value Δ'); expect(second.storage.get('theme')).toBe('dark');
    expect(JSON.parse(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8'))).toEqual({ preference: 'legacy value Δ', theme: 'dark' });
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
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

  // Round 9 (the PR23 CI regression): on a fresh profile the legacy
  // folder exists by gate time — the default session created it at
  // whenReady — but no store existed when the copy began. The gate must
  // decide from the copy-time snapshot: NO leg runs, nothing is logged
  // as failed, and the empty outcome is acknowledged exactly like the
  // successful empty read above (checkpoint '{}', marker '1').
  it('skips the leg when no store existed at copy time, even though the folder exists by gate time (round 9)', async () => {
    const p = await profile();
    const result = await startup({ directory: p.directory, storePresent: false, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled();
    expect(result.logMainError).not.toHaveBeenCalled();
    expect(result.quit).not.toHaveBeenCalled(); expect(result.showErrorBox).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(result.supplied).toEqual([{ source: 'legacy', values: {} }]);
    expect(migrationFailed(result)).toBe(false);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  // Round 12b (R12-1, R9-1 restored): the snapshot means "a leveldb
  // database exists", i.e. CURRENT is present. This suite's profile()
  // seeds Local Storage/leveldb with a stray file and NO CURRENT — the
  // LOG-only shape the r12 gate saw refused on launch 1. Driven through
  // the real pre-ready text AND the real ready callback: no leg runs and
  // the empty outcome is acknowledged (checkpoint '{}', marker '1').
  it('a legacy directory without CURRENT is no store: no leg, the marker acknowledged (round 12b, R12-1)', async () => {
    const p = await profile();
    const snapshot = preReady(p.directory);
    expect(snapshot.legacyStorePresent).toBe(false);
    const result = await startup({ directory: p.directory, storePresent: snapshot.legacyStorePresent, legacy: async () => ({ stale: 'legacy' }) });
    expect(result.legacyStorage).not.toHaveBeenCalled();
    expect(result.logMainError).not.toHaveBeenCalled();
    expect(result.quit).not.toHaveBeenCalled(); expect(result.showErrorBox).not.toHaveBeenCalled();
    expect(result.createWindow).toHaveBeenCalledOnce(); expect(result.ipc.invoke).toHaveBeenCalledExactlyOnceWith('renderer-storage-migrated');
    expect(result.supplied).toEqual([{ source: 'legacy', values: {} }]);
    expect(migrationFailed(result)).toBe(false);
    expect(await files.readFile(path.join(p.directory, CHECKPOINT_NAME), 'utf8')).toBe('{}');
    expect(await files.readFile(path.join(p.directory, MIGRATION_NAME), 'utf8')).toBe('1');
    expect(await files.readFile(p.legacy)).toEqual(p.original);
  });

  it('the pre-ready snapshot is true only once CURRENT exists, and never in development (round 12b, R12-1)', async () => {
    const p = await profile();
    await files.writeFile(path.join(p.directory, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001\n');
    expect(preReady(p.directory).legacyStorePresent).toBe(true);
    expect(preReady(p.directory, 'http://localhost:5173/').legacyStorePresent).toBe(false);
    const fresh = await profile();
    await files.rm(path.join(fresh.directory, 'Local Storage'), { recursive: true, force: true });
    expect(preReady(fresh.directory).legacyStorePresent).toBe(false);
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

describe('P-MIG retry guards (the real handler and close path, driven)', () => {
  type Flags = { legacyMigrationFailed: boolean; checkpointUnreadable: boolean };

  /** Register the ACTUAL 'renderer-storage-migrated' handler sliced out of
   * electron/main.cjs and return it with its spies (round 3: driven, not modeled). */
  function realMigratedHandler(flags: Flags) {
    let handler: ((event: { sender: unknown }) => Promise<boolean>) | undefined;
    const checkpoint = vi.fn(async () => ({ preference: 'live' }));
    const flush = vi.fn(); const logMainError = vi.fn();
    const context: Record<string, unknown> = {
      ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
      ctx: { mainWindow: null, ...flags },
      checkpointRendererPreferences: checkpoint, flushRendererPreferences: flush,
      logMainError, rendererStorage: null,
    };
    runInNewContext(handlerSource, context, { filename: 'actual-migrated-handler.cjs' });
    if (!handler) throw new Error('The actual migrated handler was not registered');
    return { handler, checkpoint, flush, logMainError, context };
  }

  /** Load the ACTUAL persistBeforeClose sliced out of electron/main/window.cjs. */
  function realPersistBeforeClose(flags: Flags) {
    const checkpoint = vi.fn(async () => ({}));
    const flush = vi.fn(); const logMainError = vi.fn();
    const context: Record<string, unknown> = {
      ctx: { mainWindow: null, ...flags },
      checkpointRendererPreferences: checkpoint, flushRendererPreferences: flush,
      logMainError, dialog: { showMessageBoxSync: vi.fn(() => 1) },
      forceClose: new WeakSet(), devUrl: null,
    };
    const persist = runInNewContext(`${persistSource}\n;persistBeforeClose;`, context,
      { filename: 'actual-persist-before-close.cjs' }) as (win: unknown) => Promise<boolean>;
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, isCrashed: () => false } };
    return { persist, win, checkpoint, flush, logMainError };
  }

  it.each([
    ['checkpointUnreadable', { legacyMigrationFailed: false, checkpointUnreadable: true }],
    ['legacyMigrationFailed', { legacyMigrationFailed: true, checkpointUnreadable: false }],
  ])('the real migrated handler refuses its checkpoint while %s stands', async (_name, flags) => {
    const { handler, checkpoint, flush } = realMigratedHandler(flags);
    await expect(handler({ sender: 'sender-1' })).resolves.toBe(false);
    expect(checkpoint).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  });

  it('the real migrated handler commits the checkpoint when no failure flag stands', async () => {
    const { handler, checkpoint, flush, context } = realMigratedHandler({ legacyMigrationFailed: false, checkpointUnreadable: false });
    await expect(handler({ sender: 'sender-1' })).resolves.toBe(true);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith('sender-1', true);
    expect(flush).toHaveBeenCalledExactlyOnceWith('sender-1');
    expect(context.rendererStorage).toEqual({ values: { preference: 'live' }, source: 'checkpoint' });
  });

  it.each([
    ['checkpointUnreadable', { legacyMigrationFailed: false, checkpointUnreadable: true }],
    ['legacyMigrationFailed', { legacyMigrationFailed: true, checkpointUnreadable: false }],
  ])('the real persistBeforeClose skips its checkpoint while %s stands', async (_name, flags) => {
    const { persist, win, checkpoint, flush, logMainError } = realPersistBeforeClose(flags);
    await expect(persist(win)).resolves.toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
    // The flush still runs: only the checkpoint write is guarded.
    expect(flush).toHaveBeenCalledExactlyOnceWith(win.webContents);
    expect(logMainError).not.toHaveBeenCalled();
  });

  it('the real persistBeforeClose checkpoints when no failure flag stands', async () => {
    const { persist, win, checkpoint, flush } = realPersistBeforeClose({ legacyMigrationFailed: false, checkpointUnreadable: false });
    await expect(persist(win)).resolves.toBe(true);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(win.webContents);
    expect(flush).toHaveBeenCalledExactlyOnceWith(win.webContents);
  });

  /** Load the ACTUAL renameUnreadableCheckpoint out of electron/main/app-data.cjs
   * (round 4): electron is stubbed to the test profile and the clock is fixed, so
   * the timestamped aside name is deterministic. */
  function realRenameUnreadableCheckpoint(directory: string) {
    const source = fsSync.readFileSync(path.join(repo, 'electron/main/app-data.cjs'), 'utf8');
    const mainRequire = createRequire(path.join(repo, 'electron/main/app-data.cjs'));
    const moduleShim = { exports: {} as Record<string, unknown> };
    const fixedDate = class extends Date { override toISOString() { return '2026-01-01T00:00:00.000Z'; } };
    const context: Record<string, unknown> = {
      require: (name: string) => (name === 'electron' ? { app: { getPath: () => directory } } : mainRequire(name)),
      module: moduleShim, exports: moduleShim.exports,
      __dirname: path.join(repo, 'electron', 'main'), console, Date: fixedDate,
    };
    runInNewContext(source, context, { filename: 'actual-app-data.cjs' });
    return moduleShim.exports.renameUnreadableCheckpoint as () => Promise<string>;
  }

  it('the real rename-aside never replaces an earlier preserved checkpoint (counter suffix)', async () => {
    const p = await profile('CORRUPT-BYTES');
    const asideBase = path.join(p.directory, `${CHECKPOINT_NAME}.unreadable-2026-01-01T00-00-00-000Z`);
    await files.writeFile(asideBase, 'EARLIER-BYTES');
    const aside = await realRenameUnreadableCheckpoint(p.directory)();
    // fs.rename replaces on Windows: the taken name gets a counter suffix, the
    // earlier preserved checkpoint is untouched, and the new bytes land aside.
    expect(aside).toBe(`${asideBase}-2`);
    expect(await files.readFile(asideBase, 'utf8')).toBe('EARLIER-BYTES');
    expect(await files.readFile(aside, 'utf8')).toBe('CORRUPT-BYTES');
    await expect(files.stat(path.join(p.directory, CHECKPOINT_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('P-MIG retry guards (static pins on the production text)', () => {
  it('the startup callback delegates to the gate and never shows the modal error dialog', () => {
    expect(startupSource).toContain('runStartupMigration({');
    expect(startupSource).toContain('renameCheckpointAside: renameUnreadableCheckpoint');
    expect(startupSource).not.toContain('showErrorBox');
  });

  it('the migrated handler refuses its checkpoint while either failure flag stands', () => {
    const handler = mainSource.indexOf("ipcMain.handle('renderer-storage-migrated'");
    expect(handler).toBeGreaterThan(0);
    expect(mainSource.slice(handler, handler + 700)).toContain('if (ctx.legacyMigrationFailed || ctx.checkpointUnreadable) return false;');
  });

  it('the close-time checkpoint is skipped while either failure flag stands', () => {
    expect(windowSource).toContain('if (!ctx.legacyMigrationFailed && !ctx.checkpointUnreadable) await checkpointRendererPreferences(win.webContents);');
  });

  // Round 12: the copy/partition/hidden-window path is deleted. Pin the
  // production order that replaces it in main.cjs's text: the store
  // snapshot sits after the single-instance lock and before whenReady,
  // the default session is first touched inside the ready callback,
  // and no trace of the old begin/copy/partition machinery remains.
  it('pins the legacy store snapshot before whenReady and the copy machinery gone (round 12)', () => {
    const lock = mainSource.indexOf('requestSingleInstanceLock()');
    const snapshot = mainSource.indexOf('const legacyStorePresent =');
    const ready = mainSource.indexOf('app.whenReady().then(async () => {', lock);
    const defaultSession = mainSource.indexOf('session.defaultSession', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(lock);
    expect(snapshot).toBeLessThan(ready);
    expect(defaultSession).toBeGreaterThan(ready);
    expect(mainSource).toContain('legacyStoreExists: () => legacyStorePresent');
    expect(mainSource).not.toContain('beginLegacyMigration');
    expect(mainSource).not.toContain('legacyCopy');
    expect(mainSource).not.toContain('fromPartition(');
  });
});
