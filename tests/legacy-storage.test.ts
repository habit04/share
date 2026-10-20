import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { legacyStorage, startLegacyStorageCopy, beginLegacyMigration, LEGACY_MIGRATION_PARTITION, withBoundedContentionWait } = require('../electron/renderer-origin.cjs') as {
  legacyStorage(options: { BrowserWindow: unknown; session: unknown; indexFile: string; copy: unknown; logError?: (kind: string, error: unknown) => void }): Promise<Record<string, string>>;
  startLegacyStorageCopy(options: { userDataDir: string }): { partitionDir: string; leveldbDir: string; sourceExisted: boolean; promise: Promise<{ ldbFiles: string[]; manifestMax: number | null }> };
  beginLegacyMigration(options: { userDataDir: string; markerPath: string }): { partitionDir: string; leveldbDir: string; sourceExisted: boolean; promise: Promise<{ ldbFiles: string[]; manifestMax: number | null }> } | null;
  LEGACY_MIGRATION_PARTITION: string;
  withBoundedContentionWait(operation: () => Promise<unknown>, deadlineMs?: number): Promise<unknown>;
};
const indexFile = join(resolve(import.meta.dirname, '..'), '.codex-local', 'legacy-storage-fixture', 'app.asar', 'dist', 'index.html');
const expectedUrl = pathToFileURL(indexFile).href;
const lifecycleEvents = ['did-finish-load', 'did-stop-loading', 'did-fail-load', 'did-fail-provisional-load', 'render-process-gone', 'destroyed'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

class Contents extends EventEmitter {
  url = expectedUrl;
  loading = false;
  destroyed = false;
  crashed = false;
  getURL() { return this.url; }
  isLoadingMainFrame() { return this.loading; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  isCrashed() { return this.crashed; }
  setWindowOpenHandler = vi.fn();
  executeJavaScript = vi.fn<(_code: string) => Promise<unknown>>(async () => Object.create(null));
}

const roots: string[] = [];
function tempRoot() { const root = mkdtempSync(join(tmpdir(), 'jcad-legacy-storage-')); roots.push(root); return root; }
/** Round 7 performs its pre-window file I/O (the partition copy) when the
 * copy is STARTED — synchronously on its first attempt — so the window
 * phases and their fake deadlines start from a settled filesystem state
 * with no flush needed here. */
/** Seed a leveldb-shaped directory with the given name -> content files. */
function seedLeveldb(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function harness() {
  const contents = new Contents();
  const window = {
    webContents: contents,
    isDestroyed: () => contents.destroyed,
    loadFile: vi.fn<(_file: string) => Promise<void>>(async () => {}),
    destroy: vi.fn(() => { contents.destroyed = true; contents.emit('destroyed'); }),
  };
  const BrowserWindow = vi.fn(function (_options: unknown) { return window; });
  let handler: ((request: { url: string }) => Response) | undefined;
  const protocol = {
    handle: vi.fn((_scheme: string, value: typeof handler) => { handler = value; }),
    unhandle: vi.fn(),
  };
  // Round 6/7: the migration runs in a private partition whose storage path
  // is DERIVED from the user-data layout (Partitions/legacy-migration) — the
  // copy is placed before any session exists (R6-6). The fake session
  // deliberately has NO getStoragePath: if the product asked a session for
  // the path, this harness would fail. It hands legacyStorage the partition
  // protocol (the same fake the assertions watch) and a recording
  // clearStorageData once fromPartition is finally called.
  const root = tempRoot();
  const userDataDir = join(root, 'user-data');
  const partitionDir = join(userDataDir, 'Partitions', 'legacy-migration');
  const clearStorageData = vi.fn(async () => {});
  const partitionSession = { protocol, clearStorageData };
  const fromPartition = vi.fn((_name: string) => partitionSession);
  const session = { fromPartition };
  const originalDir = join(userDataDir, 'Local Storage', 'leveldb');
  const partitionLeveldb = join(partitionDir, 'Local Storage', 'leveldb');
  const start = () => startLegacyStorageCopy({ userDataDir });
  const logError = vi.fn((_kind: string, _error: unknown) => {});
  return { contents, window, BrowserWindow, protocol, handler: () => handler, session, fromPartition,
    clearStorageData, userDataDir, partitionDir, originalDir, partitionLeveldb, start, logError,
    read: () => legacyStorage({ BrowserWindow, session, indexFile, copy: start(), logError }) };
}

function observe<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  const done = promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return { state, done };
}

async function microtasks() { await vi.advanceTimersByTimeAsync(0); }

function expectClean(h: ReturnType<typeof harness>, installed = true, destroys = 1) {
  expect(h.window.destroy).toHaveBeenCalledTimes(destroys);
  expect(h.clearStorageData).toHaveBeenCalledOnce();
  if (installed) expect(h.protocol.unhandle).toHaveBeenCalledExactlyOnceWith('file');
  else expect(h.protocol.unhandle).not.toHaveBeenCalled();
  for (const event of lifecycleEvents) expect(h.contents.listenerCount(event), event).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('owned bounded legacy-origin storage read', () => {
  it('bounds an unresolved load at 15 seconds and cleans up without executing storage code', async () => {
    vi.useFakeTimers();
    const h = harness(); h.window.loadFile.mockImplementation(() => new Promise(() => {}));
    const pending = observe(h.read());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(pending.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.state.settled).toBe(true);
    expect(String(pending.state.error)).toMatch(/load|ready|timed out|timeout/i);
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
    await pending.done; expectClean(h);
  });

  it('shares the same 15-second deadline between loading and stopped-main-frame readiness', async () => {
    vi.useFakeTimers();
    const h = harness(), loaded = deferred<void>(); h.contents.loading = true;
    h.window.loadFile.mockReturnValue(loaded.promise);
    const pending = observe(h.read());
    await vi.advanceTimersByTimeAsync(10_000); loaded.resolve(); await microtasks();
    await vi.advanceTimersByTimeAsync(4_999); expect(pending.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.state.settled).toBe(true);
    expect(String(pending.state.error)).toMatch(/load|ready|timed out|timeout/i);
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
    await pending.done; expectClean(h);
  });

  it('does not execute at finish-load while the main frame is still loading', async () => {
    vi.useFakeTimers();
    const h = harness(); h.contents.loading = true;
    const pending = observe(h.read()); await microtasks();
    h.contents.emit('did-finish-load'); await microtasks();
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
    expect(pending.state.settled).toBe(false);
    h.contents.loading = false; h.contents.emit('did-stop-loading');
    await pending.done;
    expect(pending.state.error).toBeUndefined(); expect(pending.state.value).toEqual({});
    expect(h.contents.executeJavaScript).toHaveBeenCalledTimes(1); expectClean(h);
  });

  it('rechecks readiness after listeners are attached rather than missing the state transition', async () => {
    vi.useFakeTimers();
    const h = harness(); h.contents.loading = true;
    const on = h.contents.on.bind(h.contents);
    vi.spyOn(h.contents, 'on').mockImplementation((event, listener) => {
      on(event, listener);
      if (event === 'did-stop-loading') h.contents.loading = false;
      return h.contents;
    });
    const pending = observe(h.read()); await microtasks();
    expect(pending.state.settled).toBe(true);
    await pending.done; expect(pending.state.error).toBeUndefined(); expectClean(h);
  });

  it('gives execution its own five seconds after a slow successful load', async () => {
    vi.useFakeTimers();
    const h = harness(), loaded = deferred<void>(); h.contents.loading = true;
    h.window.loadFile.mockReturnValue(loaded.promise);
    h.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    const pending = observe(h.read());
    await vi.advanceTimersByTimeAsync(14_000);
    h.contents.loading = false; loaded.resolve(); await microtasks();
    expect(h.contents.executeJavaScript).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999); expect(pending.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.state.settled).toBe(true);
    expect(String(pending.state.error)).toMatch(/execut|read|capture|timed out|timeout/i);
    await pending.done; expectClean(h);
  });

  it.each(['did-fail-load', 'did-fail-provisional-load'])('rejects main-frame %s even while loadFile remains pending', async event => {
    vi.useFakeTimers();
    const h = harness(); h.window.loadFile.mockImplementation(() => new Promise(() => {}));
    const pending = observe(h.read()); await microtasks();
    h.contents.emit(event, {}, -2, 'Controlled main-frame load failure', expectedUrl, true);
    await microtasks(); expect(pending.state.settled).toBe(true);
    expect(pending.state.error).toBeInstanceOf(Error);
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
    await pending.done; expectClean(h);
  });

  it.each(['render-process-gone', 'destroyed'])('rejects %s during execution and removes all owned observers', async event => {
    vi.useFakeTimers();
    const h = harness(); h.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    const pending = observe(h.read()); await microtasks();
    if (event === 'render-process-gone') h.contents.crashed = true;
    else h.contents.destroyed = true;
    h.contents.emit(event, {}, { reason: 'crashed' }); await microtasks();
    expect(pending.state.settled).toBe(true); expect(pending.state.error).toBeInstanceOf(Error);
    await pending.done; expectClean(h, true, event === 'destroyed' ? 0 : 1);
  });

  it('ignores a subframe load failure and still reads after the main frame stops', async () => {
    vi.useFakeTimers();
    const h = harness(); h.contents.loading = true;
    const pending = observe(h.read()); await microtasks();
    h.contents.emit('did-fail-load', {}, -2, 'Subframe only', 'file:///other.html', false);
    await microtasks(); expect(pending.state.settled).toBe(false);
    h.contents.loading = false; h.contents.emit('did-stop-loading');
    await pending.done; expect(pending.state.error).toBeUndefined(); expectClean(h);
  });

  it.each(['https://example.invalid/index.html', pathToFileURL(`${indexFile}.other`).href])('refuses a loaded page at the wrong URL: %s', async url => {
    vi.useFakeTimers();
    const h = harness(); h.contents.url = url;
    const pending = observe(h.read()); await microtasks();
    expect(pending.state.settled).toBe(true); expect(pending.state.error).toBeInstanceOf(Error);
    expect(h.contents.executeJavaScript).not.toHaveBeenCalled();
    await pending.done; expectClean(h);
  });

  it('keeps the read error when window destruction throws, while still removing the file handler', async () => {
    vi.useFakeTimers();
    const h = harness(), first = new Error('Controlled storage read failed');
    h.contents.executeJavaScript.mockRejectedValue(first);
    h.window.destroy.mockImplementation(() => { throw new Error('Secondary destroy error'); });
    await expect(h.read()).rejects.toBe(first); expectClean(h);
  });

  it('does not unhandle a file handler it failed to install', async () => {
    vi.useFakeTimers();
    const h = harness(), first = new Error('File handler already owned elsewhere');
    h.protocol.handle.mockImplementation(() => { throw first; });
    await expect(h.read()).rejects.toBe(first); expectClean(h, false);
  });

  it('refuses an otherwise successful read when cleanup fails, retaining the first cleanup error', async () => {
    vi.useFakeTimers();
    const h = harness(), first = new Error('First window cleanup failure');
    h.window.destroy.mockImplementation(() => { throw first; });
    h.protocol.unhandle.mockImplementation(() => { throw new Error('Secondary protocol cleanup failure'); });
    await expect(h.read()).rejects.toBe(first); expectClean(h);
  });

  it('retains the sealed sandboxed window, exact file handler and read-only script', async () => {
    vi.useFakeTimers();
    const h = harness(), loaded = deferred<void>(); h.window.loadFile.mockReturnValue(loaded.promise);
    const result = h.read();
    // Round 7 (R6-6): the window and the partition session are created only
    // after the started copy settles — flush that await before asserting.
    await microtasks();
    expect(h.BrowserWindow).toHaveBeenCalledExactlyOnceWith({ show: false, webPreferences: {
      partition: LEGACY_MIGRATION_PARTITION,
      sandbox: true, nodeIntegration: false, contextIsolation: true, devTools: false, webSecurity: false, allowRunningInsecureContent: false,
    } });
    expect(h.fromPartition).toHaveBeenCalledExactlyOnceWith(LEGACY_MIGRATION_PARTITION);
    const handler = h.handler()!;
    const response = handler({ url: expectedUrl });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("default-src 'none'"); expect(html).not.toMatch(/<script|preload|plugin|https?:/i);
    expect(handler({ url: pathToFileURL(`${indexFile}.other`).href }).status).toBe(403);
    const windowOpen = h.contents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown;
    expect(windowOpen()).toEqual({ action: 'deny' });
    for (const name of ['will-navigate', 'will-frame-navigate']) {
      const preventDefault = vi.fn(); h.contents.emit(name, { preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
    }
    loaded.resolve(); await result;
    const script = h.contents.executeJavaScript.mock.calls[0]![0];
    expect(script).toContain('localStorage'); expect(script).not.toMatch(/setItem|removeItem|\.clear\(|fetch\(|require\(/);
    expectClean(h);
  });

  it('preserves Unicode, empty and prototype-named keys from the actual storage script', async () => {
    vi.useFakeTimers();
    const h = harness(), entries = [['__proto__', 'own value'], ['constructor', 'stored'], ['雷', 'Δ 雷 😀'], ['empty', '']];
    h.contents.executeJavaScript.mockImplementation(async code => runInNewContext(code, {
      TextEncoder, localStorage: { length: entries.length, key: (i: number) => entries[i]?.[0] ?? null,
        getItem: (key: string) => entries.find(entry => entry[0] === key)?.[1] ?? null },
    }));
    const values = await h.read();
    expect(Object.getPrototypeOf(values)).toBeNull(); expect(Object.entries(values)).toEqual(entries); expectClean(h);
  });

  it('keeps the eight-MiB bound in the actual script and refuses oversize rather than returning empty success', async () => {
    vi.useFakeTimers();
    const h = harness(), huge = 'a'.repeat(8 * 1024 * 1024);
    h.contents.executeJavaScript.mockImplementation(async code => runInNewContext(code, {
      TextEncoder, localStorage: { length: 1, key: () => 'oversize', getItem: () => huge },
    }));
    await expect(h.read()).rejects.toThrow(/8 MiB|limit|large|legacy|preference|storage/i); expectClean(h);
  });

  it.each([null, undefined, [], { notAString: 7 }, Object.create({ inherited: 'value' })] as unknown[])('refuses malformed storage results instead of admitting them: %j', async value => {
    vi.useFakeTimers();
    const h = harness(); h.contents.executeJavaScript.mockResolvedValue(value);
    await expect(h.read()).rejects.toThrow(); expectClean(h);
  });

  it('rejects an accessor without evaluating renderer-supplied code', async () => {
    vi.useFakeTimers();
    const h = harness(), getter = vi.fn(() => 'must not run');
    h.contents.executeJavaScript.mockResolvedValue(Object.defineProperty({}, 'key', { enumerable: true, get: getter }));
    await expect(h.read()).rejects.toThrow(); expect(getter).not.toHaveBeenCalled(); expectClean(h);
  });
});

describe('partition copy (F1a, round 6) and copy-side recreate guard (R6-1, round 7)', () => {
  it('copies the leveldb minus LOCK, LOG and LOG.old into the partition before the window loads; the original is untouched', async () => {
    const h = harness();
    const files = { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'manifest-bytes', '000003.log': 'log-bytes-Δ', LOG: 'info log', 'LOG.old': 'old log', LOCK: '' };
    seedLeveldb(h.originalDir, files);
    const before = Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(h.originalDir, name))]));
    let partitionAtLoad: Record<string, Buffer> | null = null;
    h.window.loadFile.mockImplementation(async () => {
      partitionAtLoad = Object.fromEntries(readdirSync(h.partitionLeveldb).map((name) => [name, readFileSync(join(h.partitionLeveldb, name))]));
    });
    h.contents.executeJavaScript.mockResolvedValue(Object.assign(Object.create(null), { k: 'v' }));
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    // The copy (minus LOCK, LOG and LOG.old — R8-C: the logs are leveldb's
    // own journals and the original's LOG.old can carry its own historical
    // 'Creating DB') was already in the partition when the window loaded.
    const atLoad = partitionAtLoad!;
    expect(Object.keys(atLoad).sort()).toEqual(['000003.log', 'CURRENT', 'MANIFEST-000001']);
    for (const name of Object.keys(atLoad)) expect(atLoad[name]!.equals(before[name]!)).toBe(true);
    // The original is byte-identical, LOCK and logs included, with no file added or lost.
    expect(readdirSync(h.originalDir).sort()).toEqual(Object.keys(files).sort());
    for (const name of Object.keys(files)) expect(readFileSync(join(h.originalDir, name)).equals(before[name]!)).toBe(true);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('clears the partition even when the read itself fails', async () => {
    const h = harness(); seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm' });
    h.contents.executeJavaScript.mockRejectedValue(new Error('Controlled read failure'));
    await expect(h.read()).rejects.toThrow(/Controlled read failure/);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  // An absent store read directly still serves {} — production never
  // reaches this function that way (round 9: the gate runs no leg when
  // the copy captured sourceExisted=false), so this is the direct-call
  // contract only. The round-9 guard below covers the incoherent case
  // that CAN reach here: the source existed, its copy has no CURRENT.
  it('reads an absent legacy store as empty and still clears the partition', async () => {
    const h = harness();
    await expect(h.read()).resolves.toEqual({});
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('fails the leg when the source had a database but its copy has no CURRENT — a torn copy (round 9 guard)', async () => {
    const h = harness();
    // Modelled directly, as the state actually arises: the capture said
    // a database existed (sourceExisted: true) but the copy that landed
    // has no CURRENT. (Since round 10 / R9-1 a CURRENT-less SOURCE no
    // longer produces this state — it captures false, no leg runs.)
    // Round 10: the refusal also removes the partition directory (the
    // guard throws inside the obs-1 catch's scope) — a partial copy is
    // not left behind for the next launch to trip over.
    mkdirSync(h.partitionLeveldb, { recursive: true });
    writeFileSync(join(h.partitionLeveldb, '000005.ldb'), 'partial-copy');
    const copy = { leveldbDir: h.partitionLeveldb, partitionDir: h.partitionDir, sourceExisted: true,
      promise: Promise.resolve({ ldbFiles: [], manifestMax: null }) };
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy })).rejects.toThrow(/no CURRENT/);
    expect(h.fromPartition).not.toHaveBeenCalled();
    expect(h.clearStorageData).not.toHaveBeenCalled();
    expect(existsSync(h.partitionDir)).toBe(false);
  });

  // R6-1 (round 7) replaces round 6's F2: the guard watches the COPY now —
  // the original is opened by nothing in this process. A healthy leveldb
  // open rewrites CURRENT/MANIFEST, rotates LOG and deletes the recovered
  // log, so the fixture below is the realistic post-open set and must PASS.
  it('passes a healthy leveldb recovery of the copy (CURRENT/MANIFEST rewritten, old log deleted, LOG recovering)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, {
      CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'manifest', '000003.log': 'recovered-bytes',
      '000005.ldb': 'table-bytes', LOG: 'previous session log', LOCK: '',
    });
    h.contents.executeJavaScript.mockImplementation(async () => {
      // Chromium's open of the copy, as the read sees it afterwards.
      writeFileSync(join(h.partitionLeveldb, 'LOG.old'), 'previous session log');
      writeFileSync(join(h.partitionLeveldb, 'LOG'), '2026/10/20-00:00:00.000 Recovering log #3\n');
      writeFileSync(join(h.partitionLeveldb, 'CURRENT'), 'MANIFEST-000002\n');
      writeFileSync(join(h.partitionLeveldb, 'MANIFEST-000002'), 'manifest-2');
      unlinkSync(join(h.partitionLeveldb, 'MANIFEST-000001'));
      unlinkSync(join(h.partitionLeveldb, '000003.log'));
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses (R6-1) when the copy LOG records a recreation (Creating DB)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), '2026/10/20-00:00:00.000 Creating DB /Local Storage/leveldb since it was missing\n');
      return Object.assign(Object.create(null), {});
    });
    await expect(h.read()).rejects.toThrow(/Creating DB|recreated/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  // R8-C: a later open can rotate a recreated DB's fresh LOG to LOG.old —
  // the round-6 gate found a rebuild's 'Creating DB' ONLY there. Both
  // logs are checked.
  it('refuses (R6-1, R8-C) when only the copy LOG.old records a recreation (Creating DB)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Recovering log #3\n');
      writeFileSync(join(h.partitionLeveldb, 'LOG.old'), '2026/10/20-00:00:00.000 Creating DB /Local Storage/leveldb since it was missing\n');
      return Object.assign(Object.create(null), {});
    });
    await expect(h.read()).rejects.toThrow(/Creating DB|recreated/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  // N1: a data-preserving RewriteDB records its creation against the
  // __tmp_for_rebuild subdirectory — the values survive, so that line
  // alone must NOT refuse. A live-DB creation line alongside it still does.
  it('passes when the only Creating DB line names __tmp_for_rebuild (Fable N1)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), '2026/10/20-00:00:00.000 Creating DB /Local Storage/leveldb/__tmp_for_rebuild since it was missing\nRecovering log #3\n');
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses when a live-DB Creating DB line stands alongside a __tmp_for_rebuild line (Fable N1)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Creating DB /Local Storage/leveldb/__tmp_for_rebuild since it was missing\nCreating DB /Local Storage/leveldb since it was missing\n');
      return Object.assign(Object.create(null), {});
    });
    await expect(h.read()).rejects.toThrow(/Creating DB|recreated/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses (R6-1, narrowed by R7-1) when every copied table file is gone and none exists after the read', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Recovering log #3\n');
      unlinkSync(join(h.partitionLeveldb, '000005.ldb'));
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).rejects.toThrow(/lost every table file|refusing/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  // R7-1: the healthy counterpart — an L0 compaction right after open
  // legitimately deletes BOTH copied tables and replaces them with one
  // higher-numbered table. That profile must NOT refuse (a refusal would
  // repeat on every launch, permanently).
  it('passes when a healthy L0 compaction replaces the copied tables with a higher-numbered one (R7-1)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, {
      CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 't5', '000006.ldb': 't6', LOG: 'previous session log',
    });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Recovering log #5\n');
      unlinkSync(join(h.partitionLeveldb, '000005.ldb'));
      unlinkSync(join(h.partitionLeveldb, '000006.ldb'));
      writeFileSync(join(h.partitionLeveldb, '000009.ldb'), 'compacted');
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  // R7-1: orphan cleanup deleting ONE copied table (another remains) is
  // likewise healthy and must pass.
  it('passes when obsolete-file cleanup removes one copied table and another remains (R7-1)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 't5', '000006.ldb': 't6' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Recovering log #5\n');
      unlinkSync(join(h.partitionLeveldb, '000005.ldb'));
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses (R6-1) when the copy MANIFEST number went down', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000005\n', 'MANIFEST-000005': 'm', '000005.ldb': 'table' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.partitionLeveldb, 'LOG'), 'Recovering log #3\n');
      unlinkSync(join(h.partitionLeveldb, 'MANIFEST-000005'));
      writeFileSync(join(h.partitionLeveldb, 'MANIFEST-000001'), 'fresh-manifest');
      writeFileSync(join(h.partitionLeveldb, 'CURRENT'), 'MANIFEST-000001\n');
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).rejects.toThrow(/MANIFEST number went down/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });
});

describe('round 7: copy start (R6-2) and marker partition removal (R6-4)', () => {
  it('settles the copy at start time, before any session or window exists; the read then uses it', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table', LOCK: '' });
    const copy = h.start();
    const state = await copy.promise;
    // The copy landed (minus LOCK) and its R6-1 state was captured — all
    // before legacyStorage, any session, or any BrowserWindow (R6-6).
    expect(readdirSync(h.partitionLeveldb).sort()).toEqual(['000005.ldb', 'CURRENT', 'MANIFEST-000001']);
    expect(state).toEqual({ ldbFiles: ['000005.ldb'], manifestMax: 1 });
    expect(h.fromPartition).not.toHaveBeenCalled();
    expect(h.BrowserWindow).not.toHaveBeenCalled();
    h.contents.executeJavaScript.mockResolvedValue(Object.assign(Object.create(null), { k: 'v' }));
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy })).resolves.toEqual({ k: 'v' });
    expect(h.fromPartition).toHaveBeenCalledExactlyOnceWith(LEGACY_MIGRATION_PARTITION);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('creates no session and no window until an unfinished copy settles (R6-6)', async () => {
    vi.useFakeTimers();
    const h = harness();
    const gate = deferred<{ ldbFiles: string[]; manifestMax: number | null }>();
    const copy = { leveldbDir: h.partitionLeveldb, promise: gate.promise };
    const pending = observe(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy }));
    await microtasks();
    expect(h.fromPartition).not.toHaveBeenCalled();
    expect(h.BrowserWindow).not.toHaveBeenCalled();
    expect(h.window.loadFile).not.toHaveBeenCalled();
    gate.resolve({ ldbFiles: [], manifestMax: null });
    await pending.done;
    expect(pending.state.value).toEqual({});
    expectClean(h);
  });

  it('refuses the read when the started copy failed — no session, window or cleanup exists yet', async () => {
    vi.useFakeTimers();
    const h = harness(), failure = new Error('Controlled copy failure');
    const copy = { leveldbDir: h.partitionLeveldb, promise: Promise.reject(failure) };
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy })).rejects.toBe(failure);
    expect(h.fromPartition).not.toHaveBeenCalled();
    expect(h.BrowserWindow).not.toHaveBeenCalled();
    expect(h.clearStorageData).not.toHaveBeenCalled();
  });

  it('scrubs the partition directory when the copy fails before any session exists (gate obs 1)', async () => {
    const h = harness(), failure = new Error('Controlled copy failure');
    mkdirSync(h.partitionLeveldb, { recursive: true });
    writeFileSync(join(h.partitionLeveldb, '000005.ldb'), 'partial-copy');
    const copy = { leveldbDir: h.partitionLeveldb, partitionDir: h.partitionDir, sourceExisted: true, promise: Promise.reject(failure) };
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy })).rejects.toBe(failure);
    expect(h.fromPartition).not.toHaveBeenCalled();
    expect(existsSync(h.partitionDir)).toBe(false);
  });

  it('refuses when the copy was never started', async () => {
    const h = harness();
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy: null })).rejects.toThrow(/not started/);
    expect(h.BrowserWindow).not.toHaveBeenCalled();
  });

  // R6-6's pin, on the real filesystem with no fake session anywhere near
  // the copy: the copy is begun (session-free) and fully lands in the
  // derived partition directory; an instrumented session then proves
  // legacyStorage creates the partition session only after the copy settled.
  it('pins the copy-before-session ordering on the real filesystem (R6-6)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table', LOCK: '' });
    const copy = beginLegacyMigration({ userDataDir: h.userDataDir, markerPath: join(h.userDataDir, 'renderer-origin-migrated') })!;
    let settled = false;
    void copy.promise.then(() => { settled = true; });
    const order: string[] = [];
    const instrumentedSession = { fromPartition: vi.fn((_name: string) => {
      order.push(settled ? 'session-after-settle' : 'session-BEFORE-settle');
      return { protocol: h.protocol, clearStorageData: h.clearStorageData };
    }) };
    h.contents.executeJavaScript.mockResolvedValue(Object.assign(Object.create(null), { k: 'v' }));
    await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: instrumentedSession, indexFile, copy })).resolves.toEqual({ k: 'v' });
    expect(order).toEqual(['session-after-settle']);
    // The copy itself really landed (minus LOCK) in the derived directory —
    // the fake clearStorageData records the scrub call without deleting.
    expect(readdirSync(h.partitionLeveldb).sort()).toEqual(['000005.ldb', 'CURRENT', 'MANIFEST-000001']);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('removes a stale migration partition once when the marker exists, without touching any session', async () => {
    const h = harness();
    const stale = join(h.userDataDir, 'Partitions', 'legacy-migration', 'Local Storage', 'leveldb');
    seedLeveldb(stale, { '000005.ldb': 'stale-copy' });
    const markerPath = join(h.userDataDir, 'renderer-origin-migrated');
    writeFileSync(markerPath, '');
    const result = beginLegacyMigration({ userDataDir: h.userDataDir, markerPath });
    expect(result).toBeNull();
    expect(existsSync(join(h.userDataDir, 'Partitions', 'legacy-migration'))).toBe(false);
  });

  it('starts the copy when the marker is absent', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    const markerPath = join(h.userDataDir, 'renderer-origin-migrated');
    const result = beginLegacyMigration({ userDataDir: h.userDataDir, markerPath });
    expect(result).not.toBeNull();
    await expect(result!.promise).resolves.toEqual({ ldbFiles: ['000005.ldb'], manifestMax: 1 });
    expect(readdirSync(h.partitionLeveldb).sort()).toEqual(['000005.ldb', 'CURRENT', 'MANIFEST-000001']);
  });
});

describe('round 8: bounded, non-refusing partition clear (R7-2)', () => {
  it('still serves the read when the partition scrub rejects, and logs it to error.log (N2)', async () => {
    const h = harness();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failure = new Error('Controlled scrub failure');
      h.clearStorageData.mockRejectedValue(failure);
      await expect(h.read()).resolves.toEqual({});
      expect(h.clearStorageData).toHaveBeenCalledOnce();
      expect(h.logError).toHaveBeenCalledExactlyOnceWith('legacy migration partition cleanup', failure);
      expect(logged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it('falls back to console.error when no logger is injected (N2)', async () => {
    const h = harness();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.clearStorageData.mockRejectedValue(new Error('Controlled scrub failure'));
      await expect(legacyStorage({ BrowserWindow: h.BrowserWindow, session: h.session, indexFile, copy: h.start() })).resolves.toEqual({});
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[0])).toContain('partition cleanup');
    } finally { logged.mockRestore(); }
  });

  it('bounds a hanging scrub at five seconds and still serves the read', async () => {
    vi.useFakeTimers();
    const h = harness();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.clearStorageData.mockImplementation(() => new Promise(() => {}));
      const pending = observe(h.read());
      await vi.advanceTimersByTimeAsync(5_000);
      await pending.done;
      expect(pending.state.value).toEqual({});
      expect(h.clearStorageData).toHaveBeenCalledOnce();
      expect(h.logError).toHaveBeenCalledOnce();
      expect(h.logError.mock.calls[0]?.[0]).toBe('legacy migration partition cleanup');
      expect(logged).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { logged.mockRestore(); }
  });

  it('keeps refusing a good read when window destruction fails (only the scrub is non-refusing)', async () => {
    vi.useFakeTimers();
    const h = harness(), first = new Error('Window cleanup failure');
    h.window.destroy.mockImplementation(() => { throw first; });
    await expect(h.read()).rejects.toBe(first);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });
});

describe('round 8: stable, coherent copy (R8-A)', () => {
  it('recopies when the original changes during the copy, within the same bound', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    const realCpSync = fs.cpSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((...args: Parameters<typeof fs.cpSync>) => {
      calls += 1;
      if (calls === 1) writeFileSync(join(h.originalDir, '000005.ldb'), 'table-grown-longer');
      return (realCpSync as (...a: Parameters<typeof fs.cpSync>) => void)(...args);
    }) as typeof fs.cpSync);
    try {
      const state = await h.start().promise;
      // The first attempt copied three files; the changed listing forced a recopy.
      expect(calls).toBeGreaterThan(3);
      expect(readFileSync(join(h.partitionLeveldb, '000005.ldb'), 'utf8')).toBe('table-grown-longer');
      expect(state.ldbFiles).toEqual(['000005.ldb']);
      expect(state.manifestMax).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('does not recopy when only a skipped name (LOG) changes during the copy (N3)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table', LOG: 'x' });
    const realCpSync = fs.cpSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((...args: Parameters<typeof fs.cpSync>) => {
      calls += 1;
      if (calls === 1) writeFileSync(join(h.originalDir, 'LOG'), 'x'.repeat(64));
      return (realCpSync as (...a: Parameters<typeof fs.cpSync>) => void)(...args);
    }) as typeof fs.cpSync);
    try {
      const state = await h.start().promise;
      // One attempt copies exactly three files (LOG is skipped): the
      // log's growth is not instability.
      expect(calls).toBe(3);
      expect(state.ldbFiles).toEqual(['000005.ldb']);
    } finally { spy.mockRestore(); }
  });

  it('fails the leg when the original never stabilises inside the copy bound', async () => {
    vi.useFakeTimers();
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    const realCpSync = fs.cpSync;
    let n = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(((...args: Parameters<typeof fs.cpSync>) => {
      n += 1;
      writeFileSync(join(h.originalDir, '000005.ldb'), 'x'.repeat(n + 5));
      return (realCpSync as (...a: Parameters<typeof fs.cpSync>) => void)(...args);
    }) as typeof fs.cpSync);
    try {
      const pending = observe(h.start().promise);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending.done;
      expect(pending.state.error).toBeInstanceOf(Error);
      expect(String((pending.state.error as Error).message)).toMatch(/kept changing/);
    } finally { spy.mockRestore(); }
  });

  it('fails the leg when the copied CURRENT names a MANIFEST missing from the copy', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000777\n', '000005.ldb': 'table' });
    await expect(h.start().promise).rejects.toThrow(/MANIFEST/);
  });
});

describe('round 9: the leg decision comes from the copy-time snapshot', () => {
  it('captures sourceExisted at copy entry — a folder appearing later does not change it', async () => {
    const h = harness();
    // No store exists when the copy begins (the fresh-profile shape).
    const handle = h.start();
    expect(handle.sourceExisted).toBe(false);
    // The default session creates the folder at whenReady — after the
    // copy began. The captured fact stands; the live folder is never
    // consulted (the gate binds legacyStoreExists to this value).
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm' });
    await handle.promise;
    expect(handle.sourceExisted).toBe(false);
  });

  it('captures sourceExisted=true when a store exists at copy entry', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm', '000005.ldb': 'table' });
    const handle = h.start();
    expect(handle.sourceExisted).toBe(true);
    await expect(handle.promise).resolves.toEqual({ ldbFiles: ['000005.ldb'], manifestMax: 1 });
  });

  // R9-1 (round 10): a directory without a CURRENT is not a database —
  // an aborted leveldb creation or an emptied folder. It captures
  // false, so the gate runs no leg and the marker is acknowledged
  // (the gate side of that outcome is the round-9 preference-startup
  // case); counting it as a store would refuse every launch forever.
  it('captures sourceExisted=false when the source directory exists without a CURRENT (R9-1)', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { '000005.ldb': 'orphaned-table', LOG: 'noise' });
    const handle = h.start();
    expect(handle.sourceExisted).toBe(false);
    await handle.promise;
    expect(handle.sourceExisted).toBe(false);
  });
});

describe('bounded contention wait (round 6, F1a; codes extended round 7, R6-6)', () => {
  it('retries EBUSY and EPERM until the operation succeeds', async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('perm'), { code: 'EPERM' }))
      .mockResolvedValue('done');
    const pending = withBoundedContentionWait(operation);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after the bounded wait and propagates the contention error', async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error('still busy'), { code: 'EBUSY' });
    const operation = vi.fn(async () => { throw busy; });
    const pending = withBoundedContentionWait(operation, 500);
    const assertion = expect(pending).rejects.toBe(busy);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(operation.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats EPIPE and ENOTEMPTY as contention too (the gate-observed live-directory codes)', async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('pipe'), { code: 'EPIPE' }))
      .mockRejectedValueOnce(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }))
      .mockResolvedValue('done');
    const pending = withBoundedContentionWait(operation);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const operation = vi.fn(async () => { throw denied; });
    await expect(withBoundedContentionWait(operation)).rejects.toBe(denied);
    expect(operation).toHaveBeenCalledOnce();
  });
});
