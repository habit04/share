/**
 * P-MIG r2: a failed startup migration must survive a NORMAL close.
 *
 * r1 bounded the legacy-storage extraction with a deadline and made the startup outcome
 * explicit ({ values, ok }), and main.cjs's 'renderer-storage-migrated' handler refuses to
 * write the migration marker while the failure flag is set. Two holes remained:
 *
 *  1. window.cjs's persistBeforeClose wrote renderer-preferences.json on every normal close.
 *     After a failed migration that file makes the NEXT launch take the checkpoint branch
 *     (main.cjs) and never rerun legacyStorage; the marker is written later and the legacy
 *     values are silently abandoned - unless the session happened to end abnormally.
 *  2. A throw landing in the migration block's outer catch in main.cjs (the hidden window's
 *     construction throwing outside legacyStorage's own try, propagated as its rejection)
 *     never set the failure flag, so the marker could still be written.
 *
 * r3 narrows hole 2's fix (lead ruling): the flag means "the legacy-migration LEG failed" -
 * the extraction resolved { ok: false } or the leg itself threw. A checkpoint-READ failure
 * (corrupt/symlinked renderer-preferences.json) must NOT set it: with the flag standing,
 * the close-time checkpoint is skipped, so a permanently corrupt checkpoint would never
 * be overwritten on a normal close as it always has been - it could never self-heal, and
 * every launch would log the read error with no recovery copy ever written.
 *
 * P-MIG-T removes the mirrored-glue fidelity gap the r3 review disclosed: the gate's
 * decisions used to be reproduced as test-local glue because electron/main.cjs is a
 * side-effecting entry point and cannot be imported. The decision now lives in
 * electron/main/startup-migration.cjs, an Electron-free module main.cjs actually calls,
 * and these tests drive THAT module, wired to the real units exactly as main.cjs wires it.
 *
 * What these tests drive, exactly: the REAL startup gate (electron/main/startup-migration.cjs),
 * the REAL legacyStorage (renderer-origin.cjs), the REAL preference store behind the REAL
 * app-data wiring (electron/main/app-data.cjs over a temp userData), and the REAL window
 * module (electron/main/window.cjs) including its real close event flow and
 * persistBeforeClose - loaded under a doubled Electron, following the source-loading idiom
 * of tests/shipping-startup-settings-evidence.test.ts. The shared context object is the
 * same wiring main.cjs uses: the failure flag lives on it, written by the startup gate and
 * read by both the migrated handler and the close path.
 *
 * What is still mirrored, and why: only the 'renderer-storage-migrated' handler's one-line
 * early return in main.cjs (refuse the checkpoint while the flag stands) - that handler
 * remains inline in the entry point. It is reproduced in migratedCheckpoint below, and a
 * static pin asserts main.cjs's handler text carries the same contract. The gate itself
 * needs no mirror and no fidelity pins: the tests execute the production module, and the
 * remaining pins assert main.cjs delegates to it (no inline shadow copy of the decision).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ipcHandlerSource, readSource } from './helpers/main-process';

const requireHere = createRequire(import.meta.url);
const { legacyStorage } = requireHere('../electron/renderer-origin.cjs') as {
  legacyStorage(deps: {
    BrowserWindow: new (options: unknown) => unknown;
    protocol: { handle(scheme: string, fn: unknown): void; unhandle(scheme: string): void };
    indexFile: string;
    deadlineMs?: number;
    logError?: (kind: string, error: unknown) => void;
  }): Promise<{ values: Record<string, string> | null; ok: boolean }>;
};

type StartupStorage = { values: Record<string, string>; source: 'checkpoint' | 'legacy' } | null;
const { runStartupMigration } = requireHere('../electron/main/startup-migration.cjs') as {
  runStartupMigration(deps: {
    ctx: { legacyMigrationFailed: boolean };
    readCheckpoint(): Promise<Record<string, string> | null>;
    markerExists(): boolean;
    legacyStoreExists(): boolean;
    runLegacy(): Promise<{ values: Record<string, string> | null; ok: boolean }>;
    logError(kind: string, error: unknown): void;
  }): Promise<StartupStorage>;
};

// ---- a small CommonJS loader: real main-process modules under a doubled Electron ------------

type LoadedModule = { exports: Record<string, any> };

function loadModule(absFile: string, localRequire: (spec: string, fromFile: string) => unknown, cache: Map<string, LoadedModule>): LoadedModule {
  const cached = cache.get(absFile);
  if (cached) return cached;
  const mod: LoadedModule = { exports: {} };
  cache.set(absFile, mod);
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', readFileSync(absFile, 'utf8'));
  fn((spec: string) => localRequire(spec, absFile), mod, mod.exports, absFile, dirname(absFile));
  return mod;
}

// ---- doubles ---------------------------------------------------------------------------------

class FakeWebContents extends EventEmitter {
  sends: unknown[][] = [];
  flushes = 0;
  session = { flushStorageData: () => { this.flushes++; } };
  constructor(private storage: Record<string, string>) { super(); }
  send(...args: unknown[]) { this.sends.push(args); }
  isDestroyed() { return false; }
  isCrashed() { return false; }
  getURL() { return 'jcad://app/index.html'; }
  isLoadingMainFrame() { return false; }
  setWindowOpenHandler(_fn: unknown) { /* inert */ }
  executeJavaScriptInIsolatedWorld(_world: number, _args: unknown) { return Promise.resolve(JSON.stringify(this.storage)); }
}

class FakeIpcMain extends EventEmitter {
  handle(_channel: string, _fn: unknown) { /* registrations are not driven in these tests */ }
}

function fakeMigrationWindow(behavior: { load?: () => Promise<void>; execute?: () => Promise<unknown> }) {
  const state = { destroyed: false, loadCalls: 0 };
  class FakeBrowserWindow {
    webContents = {
      setWindowOpenHandler(_fn: () => { action: string }) { /* inert */ },
      on(_event: string, _fn: (...args: unknown[]) => void) { /* inert */ },
      executeJavaScript: () => (behavior.execute ? behavior.execute() : Promise.resolve({})),
    };
    loadFile(_file: string) { state.loadCalls++; return behavior.load ? behavior.load() : Promise.resolve(); }
    destroy() { state.destroyed = true; }
  }
  return { FakeBrowserWindow, state };
}

const fakeFileProtocol = () => ({ handle: (_scheme: string, _fn: unknown) => {}, unhandle: (_scheme: string) => {} });

// ---- one "process" over a userData folder -----------------------------------------------------

interface Runtime {
  ctx: {
    ipcMain: FakeIpcMain;
    mainWindow: unknown;
    openFilesReady: boolean;
    legacyMigrationFailed: boolean;
    [key: string]: unknown;
  };
  readRendererPreferences(): Promise<Record<string, string> | null>;
  checkpointRendererPreferences(contents: unknown, migration?: boolean): Promise<Record<string, string>>;
  flushRendererPreferences(contents: unknown): boolean;
  /** Block-level migration errors the gate logged (production passes logMainError here). */
  blockLogs: Array<{ kind: string; error: unknown }>;
  createWindow(): Promise<void>;
  windows: Array<{
    webContents: FakeWebContents;
    closeCalls: number;
    emit(event: string, ...args: unknown[]): boolean;
  }>;
}

function makeRuntime(userData: string, sessionStorage: Record<string, string>): Runtime {
  const windows: Runtime['windows'] = [];
  class FakeMainWindow extends EventEmitter {
    webContents = new FakeWebContents(sessionStorage);
    closeCalls = 0;
    constructor(_options: unknown) { super(); windows.push(this as unknown as Runtime['windows'][number]); }
    isDestroyed() { return false; }
    isMaximized() { return false; }
    maximize() { /* inert */ }
    getNormalBounds() { return { x: 0, y: 0, width: 1500, height: 940 }; }
    close() { this.closeCalls++; }
    loadURL(_url: string) { return Promise.resolve(); }
    static fromWebContents(_contents: unknown) { return null; }
  }
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath: (_name: string) => userData,
      on: (_event: string, _fn: unknown) => { /* app lifecycle listeners are inert here */ },
      quit: () => {},
      exit: (_code?: number) => {},
    },
    autoUpdater: { on: (_event: string, _fn: unknown) => {} },
    BrowserWindow: FakeMainWindow,
    dialog: { showMessageBoxSync: () => 1 },
    screen: { getDisplayMatching: (_bounds: unknown) => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const stubs = new Map<string, unknown>([
    [resolve('electron/updater.cjs'), { onConfirmRestart: (_fn: unknown) => {}, onBeforeRestart: (_fn: unknown) => {} }],
    [resolve('electron/main/menu.cjs'), { buildMenu: () => {} }],
    [resolve('electron/web-security.cjs'), { secureContents: () => {} }],
  ]);
  const cache = new Map<string, LoadedModule>();
  const localRequire = (spec: string, fromFile: string): unknown => {
    if (spec === 'electron') return fakeElectron;
    if (spec.startsWith('.')) {
      const abs = resolve(dirname(fromFile), spec);
      if (stubs.has(abs)) return stubs.get(abs);
      return loadModule(abs, localRequire, cache).exports;
    }
    return createRequire(fromFile)(spec);
  };
  const load = (rel: string) => loadModule(resolve(rel), localRequire, cache).exports;
  const appData = load('electron/main/app-data.cjs');
  const windowModule = load('electron/main/window.cjs');
  const ipcMain = new FakeIpcMain();
  const ctx: Runtime['ctx'] = {
    ipcMain,
    mainWindow: null,
    openFilesReady: false,
    legacyMigrationFailed: false,
    rejections: null, registry: null, pathPolicy: null,
    senderWindow: () => { throw new Error('not driven'); },
    handedOverProjects: new Set<string>(),
  };
  const { createWindow } = windowModule.createWindows(ctx, undefined, false) as { createWindow(): Promise<void> };
  return {
    ctx,
    readRendererPreferences: appData.readRendererPreferences,
    checkpointRendererPreferences: appData.checkpointRendererPreferences,
    flushRendererPreferences: appData.flushRendererPreferences,
    blockLogs: [],
    createWindow,
    windows,
  };
}

// ---- the startup gate: the REAL module, wired as main.cjs wires it -----------------------------
// runStartupMigration (electron/main/startup-migration.cjs) is the production decision; this
// helper only supplies its dependencies from the real units above - the real preference
// store read, on-disk existence checks against the scenario's userData, and the real
// legacyStorage with its window arguments bound, as main.cjs binds them. Block-level errors
// are recorded (production passes logMainError) so tests can pin the logging contract.

const indexFile = join(tmpdir(), 'jcad-mig-retry-index.html');

async function startupGate(runtime: Runtime, userData: string, migration: { BrowserWindow: new (options: unknown) => unknown; deadlineMs?: number }): Promise<StartupStorage> {
  return runStartupMigration({
    ctx: runtime.ctx,
    readCheckpoint: runtime.readRendererPreferences,
    markerExists: () => existsSync(join(userData, 'renderer-origin-migrated')),
    legacyStoreExists: () => existsSync(join(userData, 'Local Storage', 'leveldb')),
    runLegacy: () => legacyStorage({ BrowserWindow: migration.BrowserWindow, protocol: fakeFileProtocol(), indexFile, deadlineMs: migration.deadlineMs, logError: () => {} }),
    logError: (kind, error) => { runtime.blockLogs.push({ kind, error }); },
  });
}

// The one decision still mirrored: the 'renderer-storage-migrated' handler in main.cjs
// refuses the checkpoint while the flag stands. The handler stays inline in the entry
// point, so its early return is reproduced here and pinned statically below.
async function migratedCheckpoint(runtime: Runtime, contents: unknown): Promise<boolean> {
  if (runtime.ctx.legacyMigrationFailed) return false;
  await runtime.checkpointRendererPreferences(contents, true);
  runtime.flushRendererPreferences(contents);
  return true;
}

/** Drive the real window close flow: emit 'close', answer the Save All request, wait for the close. */
async function normalClose(runtime: Runtime) {
  const win = runtime.windows[0]!;
  win.emit('close', { preventDefault: () => {} });
  const send = win.webContents.sends.find((args) => args[0] === 'close-request');
  expect(send, 'the close flow asked the renderer to save').toBeDefined();
  runtime.ctx.ipcMain.emit('close-response', { sender: win.webContents }, send![1], true);
  // The checkpoint decision crosses real async file writes; wait on wall-clock time, not ticks.
  for (let i = 0; i < 500 && win.closeCalls === 0; i++) await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  expect(win.closeCalls, 'the window closed after the checkpoint decision').toBeGreaterThan(0);
}

const tmpRoots: string[] = [];
function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-mig-retry-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) {
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    expect(basename(dir)).toMatch(/^jcad-mig-retry-/);
    rmSync(dir, { recursive: true, force: true });
  }
});

const hangingMigration = () => fakeMigrationWindow({ execute: () => new Promise<unknown>(() => { /* never settles */ }) });
const succeedingMigration = (values: Record<string, string>) => fakeMigrationWindow({ execute: () => Promise.resolve(values) });

// ---- the sequence ------------------------------------------------------------------------------

describe('a failed startup migration survives a normal close (P-MIG r2)', () => {
  it('failed migration -> normal close -> next launch reruns legacyStorage and can complete it', async () => {
    const userData = freshUserData();
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    const checkpointFile = join(userData, 'renderer-preferences.json');
    const markerFile = join(userData, 'renderer-origin-migrated');

    // Launch 1: the extraction stalls and is bounded by the deadline; the gate records the failure.
    const first = makeRuntime(userData, { 'jcad.session': 'set during the failed session' });
    const hanging = hangingMigration();
    const gate1 = await startupGate(first, userData, { BrowserWindow: hanging.FakeBrowserWindow, deadlineMs: 50 });
    expect(gate1).toEqual({ values: {}, source: 'legacy' });
    expect(first.ctx.legacyMigrationFailed).toBe(true);
    // A settled { ok: false } outcome is not a block throw: the gate itself logs nothing
    // (the extraction's own logging happens inside legacyStorage, not driven here).
    expect(first.blockLogs).toEqual([]);
    expect(hanging.state.destroyed).toBe(true);

    // The preload's completion invoke is refused while the flag stands: no checkpoint, no marker.
    await first.createWindow();
    expect(await migratedCheckpoint(first, first.windows[0]!.webContents)).toBe(false);
    expect(existsSync(checkpointFile)).toBe(false);
    expect(existsSync(markerFile)).toBe(false);

    // A normal close must not write the checkpoint either - that is the r2 gap.
    await normalClose(first);
    expect(existsSync(checkpointFile)).toBe(false);
    expect(existsSync(markerFile)).toBe(false);

    // Launch 2 (fresh process state, same userData): no checkpoint diverts the gate, so the
    // extraction reruns - and this time it completes and may be marked.
    const second = makeRuntime(userData, { 'legacy.pref': 'kept' });
    const succeeding = succeedingMigration({ 'legacy.pref': 'kept' });
    const gate2 = await startupGate(second, userData, { BrowserWindow: succeeding.FakeBrowserWindow, deadlineMs: 50 });
    expect(gate2).toEqual({ values: { 'legacy.pref': 'kept' }, source: 'legacy' });
    expect(succeeding.state.loadCalls).toBe(1);
    expect(second.ctx.legacyMigrationFailed).toBe(false);
    expect(second.blockLogs).toEqual([]);

    await second.createWindow();
    expect(await migratedCheckpoint(second, second.windows[0]!.webContents)).toBe(true);
    expect(existsSync(checkpointFile)).toBe(true);
    expect(existsSync(markerFile)).toBe(true);
    expect(await second.readRendererPreferences()).toEqual({ 'legacy.pref': 'kept' });
  });

  it('control: after a successful migration a normal close still writes the checkpoint', async () => {
    const userData = freshUserData();
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    const runtime = makeRuntime(userData, { 'jcad.session': 'set during the session' });
    const gate = await startupGate(runtime, userData, { BrowserWindow: succeedingMigration({}).FakeBrowserWindow, deadlineMs: 50 });
    expect(gate).toEqual({ values: {}, source: 'legacy' });
    expect(runtime.ctx.legacyMigrationFailed).toBe(false);
    expect(runtime.blockLogs).toEqual([]);
    await runtime.createWindow();
    await normalClose(runtime);
    // The close checkpoint (migration=false) writes preferences but never the marker.
    expect(existsSync(join(userData, 'renderer-preferences.json'))).toBe(true);
    expect(existsSync(join(userData, 'renderer-origin-migrated'))).toBe(false);
    expect(await runtime.readRendererPreferences()).toEqual({ 'jcad.session': 'set during the session' });
  });
});

describe('migration-leg throws preserve the retry; a checkpoint-read failure does not (P-MIG r2 gap 2, narrowed in r3)', () => {
  it('a BrowserWindow construction throw escapes legacyStorage instead of resolving as a failure', async () => {
    const boom = new Error('window construction boom');
    class ThrowingWindow { constructor() { throw boom; } }
    await expect(legacyStorage({ BrowserWindow: ThrowingWindow as never, protocol: fakeFileProtocol(), indexFile })).rejects.toBe(boom);
    // In production that rejection is a failure of the migration LEG: the real gate marks
    // it, sets the failure flag, and logs the throw once at block level. With the flag
    // standing, the completion checkpoint is refused, so no marker can be written for a
    // migration that never ran.
    const userData = freshUserData();
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    const runtime = makeRuntime(userData, {});
    const gate = await startupGate(runtime, userData, { BrowserWindow: ThrowingWindow as never });
    expect(gate).toBeNull();
    expect(runtime.ctx.legacyMigrationFailed).toBe(true);
    expect(runtime.blockLogs).toEqual([{ kind: 'renderer preference migration', error: boom }]);
    expect(await migratedCheckpoint(runtime, { session: { flushStorageData: () => {} } })).toBe(false);
    expect(existsSync(join(userData, 'renderer-origin-migrated'))).toBe(false);
    expect(existsSync(join(userData, 'renderer-preferences.json'))).toBe(false);
  });

  it('a corrupt checkpoint read throws without setting the flag, and a normal close rewrites the checkpoint (r3)', async () => {
    const userData = freshUserData();
    const checkpointFile = join(userData, 'renderer-preferences.json');
    writeFileSync(checkpointFile, '{ not json');
    const runtime = makeRuntime(userData, { 'jcad.session': 'set during the session' });
    // Premise: the real store read rejects on the corrupt file. In production that throw
    // lands in the startup gate's catch - which since r3 does NOT set the failure flag
    // for a read failure (the flag means the migration LEG failed), so the corrupt file
    // is not protected from the session's normal close.
    await expect(runtime.readRendererPreferences()).rejects.toThrow();
    const gate = await startupGate(runtime, userData, { BrowserWindow: succeedingMigration({}).FakeBrowserWindow, deadlineMs: 50 });
    expect(gate).toBeNull();
    expect(runtime.ctx.legacyMigrationFailed).toBe(false);
    // The read failure is still logged exactly once at block level - only the flag is withheld.
    expect(runtime.blockLogs.length).toBe(1);
    expect(runtime.blockLogs[0]!.kind).toBe('renderer preference migration');
    await runtime.createWindow();
    await normalClose(runtime);
    // The close checkpoint ran (flag clear): the corrupt bytes are replaced by the session's
    // snapshot - exactly the self-heal base/r1 always performed on a normal close. The close
    // checkpoint (migration=false) still never writes the marker.
    expect(readFileSync(checkpointFile, 'utf8')).not.toBe('{ not json');
    expect(await runtime.readRendererPreferences()).toEqual({ 'jcad.session': 'set during the session' });
    expect(existsSync(join(userData, 'renderer-origin-migrated'))).toBe(false);
    // And the migrated completion is not refused on the read failure's account either.
    expect(await migratedCheckpoint(runtime, runtime.windows[0]!.webContents)).toBe(true);
    expect(existsSync(join(userData, 'renderer-origin-migrated'))).toBe(true);
  });
});

describe('the startup gate branches that never run the extraction (P-MIG-T: the real module)', () => {
  it('a committed checkpoint is the startup storage and the extraction never runs', async () => {
    const userData = freshUserData();
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    const runtime = makeRuntime(userData, { 'jcad.session': 'earlier' });
    // A previous session committed its snapshot through the real store.
    await runtime.createWindow();
    await runtime.checkpointRendererPreferences(runtime.windows[0]!.webContents, false);
    const succeeding = succeedingMigration({});
    const gate = await startupGate(runtime, userData, { BrowserWindow: succeeding.FakeBrowserWindow, deadlineMs: 50 });
    expect(gate).toEqual({ values: { 'jcad.session': 'earlier' }, source: 'checkpoint' });
    expect(succeeding.state.loadCalls).toBe(0);
    expect(runtime.ctx.legacyMigrationFailed).toBe(false);
    expect(runtime.blockLogs).toEqual([]);
  });

  it('an existing migration marker means no startup storage and the extraction never runs', async () => {
    const userData = freshUserData();
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    writeFileSync(join(userData, 'renderer-origin-migrated'), '1');
    const runtime = makeRuntime(userData, {});
    const succeeding = succeedingMigration({});
    const gate = await startupGate(runtime, userData, { BrowserWindow: succeeding.FakeBrowserWindow, deadlineMs: 50 });
    expect(gate).toBeNull();
    expect(succeeding.state.loadCalls).toBe(0);
    expect(runtime.ctx.legacyMigrationFailed).toBe(false);
    expect(runtime.blockLogs).toEqual([]);
  });
});

// ---- static pins: main.cjs delegates to the module; the handler and close path keep theirs -----

describe('startup migration wiring (source pins)', () => {
  const main = readSource('electron/main.cjs');
  const gate = readSource('electron/main/startup-migration.cjs');

  it('main.cjs delegates the gate to the module and keeps no inline shadow of the decision', () => {
    const start = main.indexOf('if (!DEV_URL) {');
    expect(start).toBeGreaterThan(-1);
    const block = main.slice(start, main.indexOf('loadPersistedPaths();', start));
    expect(block).toContain('runStartupMigration(');
    expect(block).toContain('rendererStorage = await runStartupMigration(');
    // The decision itself - branch conditions, leg marking, flag writes - lives only in
    // the module now; none of its text may survive inline in the entry point's gate
    // region. (Binding the extraction's arguments in the deps wiring is not the decision.)
    expect(block).not.toContain('if (checkpoint !== null)');
    expect(block).not.toContain('migrationLegThrew');
    expect(block).not.toContain('!outcome.ok');
    expect(block).not.toContain('legacyMigrationFailed =');
    expect(main).toContain("require('./main/startup-migration.cjs')");
  });

  it('the module assigns the failure flag from the extraction outcome on the shared context', () => {
    expect(gate).toContain('ctx.legacyMigrationFailed = !outcome.ok');
  });

  it('the module keeps the gate branch order: checkpoint, marker, extraction', () => {
    const read = gate.indexOf('await readCheckpoint()');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(gate.indexOf('markerExists()'));
    expect(gate.indexOf('markerExists()')).toBeLessThan(gate.indexOf('runLegacy()'));
  });

  it('the module catch sets the failure flag only when the migration leg threw (r3 narrowing)', () => {
    expect(gate).toContain('let migrationLegThrew = false');
    const legMark = gate.indexOf('migrationLegThrew = true');
    expect(legMark).toBeGreaterThan(gate.indexOf('runLegacy()'));
    const catchAt = gate.indexOf('} catch (error) {');
    expect(catchAt).toBeGreaterThan(-1);
    expect(legMark).toBeLessThan(catchAt);
    // Every failure-flag assignment inside the catch is the guarded one, so a throw from
    // the checkpoint read (which never passes the leg mark) cannot set the flag.
    const catchLines = gate.slice(catchAt).split('\n').filter((line) => line.includes('ctx.legacyMigrationFailed = true'));
    expect(catchLines.length).toBeGreaterThan(0);
    for (const line of catchLines) expect(line).toContain('if (migrationLegThrew)');
    // And every throw is logged once, at the catch, with the production kind string.
    expect(gate.slice(catchAt)).toContain("logError('renderer preference migration', error)");
  });

  it('the migrated handler refuses the marker while the flag is set, before any checkpoint', () => {
    const handler = ipcHandlerSource('renderer-storage-migrated');
    expect(handler).toContain('legacyMigrationFailed');
    expect(handler.indexOf('legacyMigrationFailed')).toBeLessThan(handler.indexOf('checkpointRendererPreferences'));
  });

  it('window.cjs consults the flag on the close path before the close checkpoint', () => {
    const win = readSource('electron/main/window.cjs');
    const at = win.indexOf('async function persistBeforeClose');
    expect(at).toBeGreaterThan(-1);
    const region = win.slice(at, win.indexOf('flushRendererPreferences', at));
    expect(region).toContain('ctx.legacyMigrationFailed');
    expect(region.indexOf('ctx.legacyMigrationFailed')).toBeLessThan(region.indexOf('checkpointRendererPreferences'));
  });
});
