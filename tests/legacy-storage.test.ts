import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { legacyStorage, LEGACY_MIGRATION_PARTITION, withBoundedContentionWait } = require('../electron/renderer-origin.cjs') as {
  legacyStorage(options: { BrowserWindow: unknown; session: unknown; userDataDir: string; indexFile: string }): Promise<Record<string, string>>;
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
/** Round 6 performs its pre-window file I/O (snapshot + partition copy)
 * synchronously in the module, so the window phases and their fake deadlines
 * start from a settled filesystem state with no flush needed here. */
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
  // Round 6: the migration runs in a private partition. The fake session
  // hands legacyStorage the partition protocol (the same fake the assertions
  // watch), a real temp storage path, and a recording clearStorageData.
  const root = tempRoot();
  const userDataDir = join(root, 'user-data'), partitionDir = join(root, 'partition');
  const clearStorageData = vi.fn(async () => {});
  const partitionSession = { protocol, getStoragePath: () => partitionDir, clearStorageData };
  const fromPartition = vi.fn((_name: string) => partitionSession);
  const session = { fromPartition };
  const originalDir = join(userDataDir, 'Local Storage', 'leveldb');
  const partitionLeveldb = join(partitionDir, 'Local Storage', 'leveldb');
  return { contents, window, BrowserWindow, protocol, handler: () => handler, session, fromPartition,
    clearStorageData, userDataDir, partitionDir, originalDir, partitionLeveldb,
    read: () => legacyStorage({ BrowserWindow, session, userDataDir, indexFile }) };
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

describe('round 6: partition copy (F1a) and original-integrity guard (F2)', () => {
  it('copies the leveldb minus LOCK into the partition before the window loads; the original is untouched', async () => {
    const h = harness();
    const files = { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'manifest-bytes', '000003.log': 'log-bytes-Δ', LOG: 'info log', LOCK: '' };
    seedLeveldb(h.originalDir, files);
    const before = Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(h.originalDir, name))]));
    let partitionAtLoad: Record<string, Buffer> | null = null;
    h.window.loadFile.mockImplementation(async () => {
      partitionAtLoad = Object.fromEntries(readdirSync(h.partitionLeveldb).map((name) => [name, readFileSync(join(h.partitionLeveldb, name))]));
    });
    h.contents.executeJavaScript.mockResolvedValue(Object.assign(Object.create(null), { k: 'v' }));
    await expect(h.read()).resolves.toEqual({ k: 'v' });
    // The copy (minus LOCK) was already in the partition when the window loaded.
    const atLoad = partitionAtLoad!;
    expect(Object.keys(atLoad).sort()).toEqual(['000003.log', 'CURRENT', 'LOG', 'MANIFEST-000001']);
    for (const name of Object.keys(atLoad)) expect(atLoad[name]!.equals(before[name]!)).toBe(true);
    // The original is byte-identical, LOCK included, with no file added or lost.
    expect(readdirSync(h.originalDir).sort()).toEqual(Object.keys(files).sort());
    for (const name of Object.keys(files)) expect(readFileSync(join(h.originalDir, name)).equals(before[name]!)).toBe(true);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('clears the partition even when the read itself fails', async () => {
    const h = harness(); seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n' });
    h.contents.executeJavaScript.mockRejectedValue(new Error('Controlled read failure'));
    await expect(h.read()).rejects.toThrow(/Controlled read failure/);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('reads an absent legacy store as empty and still clears the partition', async () => {
    const h = harness();
    await expect(h.read()).resolves.toEqual({});
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses (F2) when the original leveldb shrinks during the read', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', '000003.log': 'x'.repeat(4_096), 'MANIFEST-000001': 'm' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      unlinkSync(join(h.originalDir, '000003.log'));
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).rejects.toThrow(/shrank|lost|refusing/i);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });

  it('refuses (F2) when CURRENT changes identity during the read', async () => {
    const h = harness();
    seedLeveldb(h.originalDir, { CURRENT: 'MANIFEST-000001\n', 'MANIFEST-000001': 'm' });
    h.contents.executeJavaScript.mockImplementation(async () => {
      writeFileSync(join(h.originalDir, 'CURRENT'), 'MANIFEST-000002\n');
      return Object.assign(Object.create(null), { k: 'v' });
    });
    await expect(h.read()).rejects.toThrow(/CURRENT/);
    expect(h.clearStorageData).toHaveBeenCalledOnce();
  });
});

describe('bounded contention wait (round 6, F1a)', () => {
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

  it('does not retry other errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const operation = vi.fn(async () => { throw denied; });
    await expect(withBoundedContentionWait(operation)).rejects.toBe(denied);
    expect(operation).toHaveBeenCalledOnce();
  });
});
