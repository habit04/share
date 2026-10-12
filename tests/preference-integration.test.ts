import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, resolve } from 'node:path';
import { readSource } from './helpers/main-process';

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

function runPreload(values: Record<string, string>, saved: unknown, failKey?: string) {
  const storage = new Map(Object.entries(values));
  let acknowledge: (value: boolean) => void = () => {};
  let calls = 0;
  const context = {
    require: () => ({
      contextBridge: { exposeInMainWorld: () => {} }, webFrame: {},
      ipcRenderer: {
        sendSync: () => saved,
        invoke: () => { calls++; return new Promise<boolean>((resolveAck) => { acknowledge = resolveAck; }); },
      },
    }),
    process: { platform: 'darwin' }, globalThis: { location: { protocol: 'jcad:' } },
    localStorage: {
      get length() { return storage.size; },
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { if (key === failKey) throw new Error('storage unavailable'); storage.set(key, value); },
      removeItem: (key: string) => storage.delete(key),
    },
  };
  runInNewContext(readSource('electron/preload.cjs'), context);
  return { storage, acknowledge, calls };
}

describe('preload preference recovery', () => {
  it('restores a full checkpoint on an empty origin and marks it only after durable acknowledgement', async () => {
    const result = runPreload({}, { source: 'checkpoint', values: { changed: 'latest' } });
    expect(result.storage.get('changed')).toBe('latest');
    expect(result.storage.has('jcad-origin-migrated')).toBe(false);
    expect(result.calls).toBe(1);
    result.acknowledge(true);
    await tick();
    expect(result.storage.get('jcad-origin-migrated')).toBe('1');
  });

  it('preserves a nonempty origin and its deleted keys instead of merging a stale checkpoint', () => {
    const result = runPreload({ changed: 'Chromium latest' }, { source: 'checkpoint', values: { changed: 'old', deleted: 'old' } });
    expect(Object.fromEntries(result.storage)).toEqual({ changed: 'Chromium latest' });
    const marked = runPreload({ 'jcad-origin-migrated': '1' }, { source: 'checkpoint', values: { deleted: 'old' } });
    expect(marked.storage.has('deleted')).toBe(false);
  });

  it('uses legacy values only to fill absent keys and treats an empty checkpoint as authoritative', () => {
    const migrated = runPreload({ changed: 'new' }, { source: 'legacy', values: { changed: 'legacy', other: 'legacy' } });
    expect(Object.fromEntries(migrated.storage)).toEqual({ changed: 'new', other: 'legacy' });
    const empty = runPreload({}, { source: 'checkpoint', values: {} });
    expect(empty.storage.size).toBe(0);
    expect(empty.calls).toBe(1);
  });

  it('rolls back partial recovery when storage fails, leaving the full checkpoint eligible for retry', () => {
    const result = runPreload({}, { source: 'checkpoint', values: { first: 'saved', second: 'saved' } }, 'second');
    expect(result.storage.size).toBe(0);
    expect(result.calls).toBe(0);
  });
});

function windowHarness(checkpoint: () => Promise<unknown>, answer: boolean | null = true, nativeAnswer = 1) {
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, quit: vi.fn() });
  const ipcMain = new EventEmitter();
  const windows: MockWindow[] = [];
  let response = answer;
  let confirmRestart: (win: MockWindow) => Promise<boolean> = async () => false;
  let beforeRestart: (win: MockWindow) => Promise<boolean> = async () => false;
  class MockWindow extends EventEmitter {
    destroyed = false;
    closeRequests = 0;
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed, isCrashed: () => false,
      send: (channel: string, id: number) => {
        if (channel !== 'close-request') return;
        this.closeRequests++;
        queueMicrotask(() => {
          if (response === null) return;
          ipcMain.emit('close-ack', { sender: this.webContents }, id);
          ipcMain.emit('close-response', { sender: this.webContents }, id, response);
        });
      },
    });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    getNormalBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
    isMaximized() { return false; }
    show() {}
    maximize() {}
    async loadURL() {}
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroyed = true;
    }
  }
  const imports: Record<string, unknown> = {
    electron: { app, BrowserWindow: MockWindow, autoUpdater: new EventEmitter(), dialog: { showMessageBoxSync: () => nativeAnswer }, screen: {} },
    '../updater.cjs': { onConfirmRestart: (cb: typeof confirmRestart) => { confirmRestart = cb; }, onBeforeRestart: (cb: typeof beforeRestart) => { beforeRestart = cb; } },
    './app-data.cjs': { windowStateFile: () => 'missing-window-state.json', writeStateFile: () => Promise.resolve(), checkpointRendererPreferences: checkpoint, flushRendererPreferences: () => true, logMainError: () => {} },
    './menu.cjs': { buildMenu: () => {} }, '../web-security.cjs': { secureContents: () => {} },
    'node:fs': { readFileSync: () => { throw new Error('no prior state'); } },
  };
  const file = 'electron/main/window.cjs';
  const localRequire = createRequire(resolve(file));
  const module = { exports: {} as { createWindows(ctx: unknown, devUrl?: string): { createWindow(): Promise<void> } } };
  new Function('require', 'module', '__dirname', readSource(file))((name: string) => Object.hasOwn(imports, name) ? imports[name] : localRequire(name), module, dirname(resolve(file)));
  const factory = module.exports.createWindows({ ipcMain, mainWindow: null });
  return { create: factory.createWindow, windows, ipcMain, setAnswer: (answer: boolean) => { response = answer; }, restart: (win: MockWindow) => confirmRestart(win), beforeRestart: (win: MockWindow) => beforeRestart(win) };
}

describe('close preference ordering', () => {
  it('keeps the renderer alive after Save All until the durable checkpoint completes', async () => {
    let committed: () => void = () => {};
    const checkpoint = vi.fn(() => new Promise<void>((done) => { committed = done; }));
    const harness = windowHarness(checkpoint);
    await harness.create();
    const win = harness.windows[0]!;
    win.close();
    await tick();
    expect(win.closeRequests).toBe(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);
    committed();
    await tick();
    expect(win.destroyed).toBe(true);
  });

  it('keeps a failed checkpoint close cancelable and asks again on a later close', async () => {
    const checkpoint = vi.fn().mockRejectedValueOnce(new Error('ENOSPC')).mockResolvedValue(undefined);
    const harness = windowHarness(checkpoint);
    await harness.create();
    const win = harness.windows[0]!;
    win.close(); await tick();
    expect(win.destroyed).toBe(false);
    win.close(); await tick();
    expect(win.closeRequests).toBe(2);
    expect(win.destroyed).toBe(true);
  });

  it('awaits the checkpoint before approving a native update restart', async () => {
    let committed: () => void = () => {};
    const harness = windowHarness(() => new Promise<void>((done) => { committed = done; }));
    await harness.create();
    let approved = false;
    const restart = harness.restart(harness.windows[0]!).then((ok) => { approved = ok; });
    await tick();
    expect(approved).toBe(false);
    committed(); await restart;
    expect(approved).toBe(true);
  });

  it('checkpoints a late Save All approval after the native hung-renderer question was canceled', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn(async () => {});
    const harness = windowHarness(checkpoint, null);
    await harness.create();
    const win = harness.windows[0]!;
    win.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(win.destroyed).toBe(false);
    harness.ipcMain.emit('close-response', { sender: win.webContents }, 1, true);
    await tick();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(true);
  });

  it('expires forced restart approval so a later healthy close checkpoints settings', async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn(async () => {});
    const harness = windowHarness(checkpoint, null, 0);
    await harness.create();
    const win = harness.windows[0]!;
    const restart = harness.restart(win);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await restart).toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    harness.setAnswer(true);
    win.close(); await tick();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(true);
  });

  it('cancels a final post-verification checkpoint failure even if a native response would allow settings loss', async () => {
    const checkpoint = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOSPC'));
    const harness = windowHarness(checkpoint, true, 0);
    await harness.create();
    const win = harness.windows[0]!;
    expect(await harness.restart(win)).toBe(true);
    expect(await harness.beforeRestart(win)).toBe(false);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(win.destroyed).toBe(false);
  });
});
