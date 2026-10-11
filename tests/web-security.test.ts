/**
 * Security review E-12: the main process denies every web permission except clipboard writes of
 * the application page, and no web contents may open windows, navigate or attach a <webview>
 * (electron/web-security.cjs). Unit tests with stand-ins for Electron's objects, plus static
 * checks of the main-process sources (tests/helpers/main-process.ts) that the guards are installed.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mainProcessSource, readSource } from './helpers/main-process';

const require = createRequire(import.meta.url);
const ws = require('../electron/web-security.cjs') as {
  ALLOWED_PERMISSIONS: Set<string>;
  permissionAllowed(contents: unknown, permission: string, app: unknown): boolean;
  installPermissionHandlers(session: unknown, app: () => unknown): void;
  secureContents(contents: unknown): void;
  installWebContentsGuards(app: unknown): void;
};

/** A web contents stand-in: events plus the window-open handler. */
class FakeContents extends EventEmitter {
  openHandler: ((d: unknown) => { action: string }) | null = null;
  setWindowOpenHandler(fn: (d: unknown) => { action: string }) {
    this.openHandler = fn;
  }
  /** Emit a cancellable event; true when a listener prevented it. */
  attempt(name: string): boolean {
    let prevented = false;
    this.emit(name, { preventDefault: () => (prevented = true) });
    return prevented;
  }
}

describe('web permissions (electron/web-security.cjs)', () => {
  const appPage = new FakeContents();
  const other = new FakeContents();
  const PERMISSIONS = ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'fullscreen', 'openExternal', 'clipboard-read', 'display-capture', 'hid', 'serial', 'usb', 'idle-detection', 'window-management', 'storage-access', 'fileSystem', 'unknown'];

  it('only clipboard writes, only for the application page', () => {
    expect([...ws.ALLOWED_PERMISSIONS]).toEqual(['clipboard-sanitized-write']);
    expect(ws.permissionAllowed(appPage, 'clipboard-sanitized-write', appPage)).toBe(true);
    expect(ws.permissionAllowed(other, 'clipboard-sanitized-write', appPage)).toBe(false);
    expect(ws.permissionAllowed(null, 'clipboard-sanitized-write', null)).toBe(false);
    for (const p of PERMISSIONS) expect(ws.permissionAllowed(appPage, p, appPage), p).toBe(false);
  });

  it('the session handlers answer requests and checks with that rule', () => {
    let request: ((c: unknown, p: string, cb: (ok: boolean) => void) => void) | null = null;
    let check: ((c: unknown, p: string) => boolean) | null = null;
    ws.installPermissionHandlers(
      { setPermissionRequestHandler: (fn: typeof request) => (request = fn), setPermissionCheckHandler: (fn: typeof check) => (check = fn) },
      () => appPage,
    );
    const answers: Array<[string, boolean]> = [];
    for (const p of [...PERMISSIONS, 'clipboard-sanitized-write']) request!(appPage, p, (ok) => answers.push([p, ok]));
    expect(answers.filter(([, ok]) => ok)).toEqual([['clipboard-sanitized-write', true]]);
    expect(check!(appPage, 'clipboard-sanitized-write')).toBe(true);
    expect(check!(other, 'clipboard-sanitized-write')).toBe(false);
    expect(check!(appPage, 'media')).toBe(false);
    // Before the window exists nothing is allowed.
    ws.installPermissionHandlers({ setPermissionRequestHandler: (fn: typeof request) => (request = fn), setPermissionCheckHandler: (fn: typeof check) => (check = fn) }, () => null);
    request!(appPage, 'clipboard-sanitized-write', (ok) => expect(ok).toBe(false));
  });
});

describe('web contents guards (electron/web-security.cjs)', () => {
  it('secureContents denies new windows, navigation and <webview>', () => {
    const c = new FakeContents();
    ws.secureContents(c);
    expect(c.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(c.attempt('will-navigate')).toBe(true);
    expect(c.attempt('will-attach-webview')).toBe(true);
  });

  it('every web contents created later gets the guards (hidden plot / print windows included)', () => {
    const app = new EventEmitter();
    ws.installWebContentsGuards(app);
    const hidden = new FakeContents();
    app.emit('web-contents-created', {}, hidden);
    expect(hidden.openHandler!({})).toEqual({ action: 'deny' });
    expect(hidden.attempt('will-navigate')).toBe(true);
  });

  it('the main process installs both before any window, and the main window uses secureContents', () => {
    const main = readSource('electron/main.cjs');
    const guards = main.indexOf('installWebContentsGuards(app);');
    const handlers = main.indexOf('installPermissionHandlers(session.defaultSession,');
    const firstWindow = main.indexOf('createWindow();');
    expect(guards).toBeGreaterThan(0);
    expect(handlers).toBeGreaterThan(guards);
    expect(firstWindow).toBeGreaterThan(handlers);
    expect(readSource('electron/main/window.cjs')).toMatch(/secureContents\(win\.webContents\);/);
    // No other permission handler anywhere in the main process.
    const all = mainProcessSource();
    expect(all.match(/setPermissionRequestHandler|setPermissionCheckHandler/g) ?? []).toEqual([]);
    expect(all).not.toMatch(/webviewTag:\s*true|nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false/);
  });
});
