import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, win32 } from 'node:path';
const require = createRequire(import.meta.url);
const { assetPath } = require('../electron/renderer-origin.cjs') as { assetPath(root: string, url: string): string };
const { appUrlTest } = require('../electron/ipc-guard.cjs') as { appUrlTest(index: string): (url: string) => boolean };
describe('bundled renderer origin', () => {
  const root = resolve('dist');
  it('maps bundled assets and excludes other hosts, credentials and encoded path escapes', () => {
    expect(assetPath(root, 'jcad://app/index.html')).toBe(resolve(root, 'index.html'));
    expect(assetPath(root, 'jcad://app/assets/main.js')).toBe(resolve(root, 'assets/main.js'));
    for (const url of ['file:///secret', 'jcad://other/index.html', 'jcad://user@app/index.html', 'jcad://app:123/index.html', 'jcad://app/%2e%2e%2fsecret', 'jcad://app/%5c..%5csecret', 'jcad://app/C:%5csecret', 'jcad://app/%00']) expect(() => assetPath(root, url)).toThrow();
  });
  it('accepts IPC only from the application page rather than another bundled resource', () => {
    const trusted = appUrlTest(resolve(root, 'index.html'));
    expect(trusted('jcad://app/index.html?demo=1#tools')).toBe(true);
    expect(trusted('jcad://app/assets/page.html')).toBe(false);
    expect(trusted('jcad://other/index.html')).toBe(false);
    expect(trusted('jcad://user@app/index.html')).toBe(false);
  });
});

// ---- worker CSP header (docs/SECURITY-REVIEW.md E-19) ------------------------------------------

type Handler = (request: { method: string; url: string }) => Promise<Response>;
const origin = require('../electron/renderer-origin.cjs') as {
  APP_URL: string;
  WORKER_CSP: string;
  assetResponseHeaders(pathname: string): Record<string, string>;
  withAssetHeaders(response: Response, pathname: string): Response;
  rendererStartUrl(env: Record<string, string | undefined>, allowInspection: boolean): string;
  servedPath(relative: string): string;
  installAssetHandler(deps: { protocol: { handle(scheme: string, fn: Handler): void }; net: { fetch(url: string): Promise<Response> }; root: string }): void;
};

describe('worker scripts get their own restrictive CSP from the jcad:// handler', () => {
  it('attaches the header to worker bundles only', () => {
    const csp = { 'Content-Security-Policy': origin.WORKER_CSP };
    for (const p of ['/assets/worker/manifold.worker-Dvpi2U2B.js', '/assets/worker/dwg-browser-worker-x_1.js', '/assets/worker/chunk-abc.mjs', '/ASSETS/Worker/MANIFOLD.WORKER-X.JS']) expect(origin.assetResponseHeaders(p), p).toEqual(csp);
    for (const p of ['/index.html', '/', '/assets/index-ClEP6yK3.js', '/assets/manifold-core-BTuj9-q8.js', '/assets/manifold-BE4c7gO-.wasm', '/assets/worker/manifold-x.wasm', '/assets/worker/', '/assets/worker/sub/x.js', '/assets/workerx.js', '/worker/x.js', '/assets/worker/x.js.map', '/favicon.svg']) expect(origin.assetResponseHeaders(p), p).toEqual({});
  });

  it('permits only bundled scripts, the bundled wasm and WebAssembly compilation', () => {
    const directives = new Map(origin.WORKER_CSP.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name!, values] as const; }));
    expect([...directives.keys()].sort()).toEqual(['base-uri', 'connect-src', 'default-src', 'script-src']);
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    // No hosts, schemes, wildcards or eval anywhere.
    expect(origin.WORKER_CSP).not.toMatch(/https?:|\*|data:|blob:|'unsafe-eval'|'unsafe-inline'/);
  });

  it('keeps status, body and content type when adding the header, and passes other responses through', async () => {
    const plain = new Response('x', { headers: { 'content-type': 'text/javascript' } });
    expect(origin.withAssetHeaders(plain, '/assets/index-a.js')).toBe(plain);
    const worker = origin.withAssetHeaders(new Response('postMessage(1)', { status: 200, headers: { 'content-type': 'text/javascript' } }), '/assets/worker/manifold.worker-a.js');
    expect(worker.status).toBe(200);
    expect(worker.headers.get('content-type')).toBe('text/javascript');
    expect(worker.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    expect(await worker.text()).toBe('postMessage(1)');
  });

  const bundle = mkdtempSync(join(tmpdir(), 'jcad-origin-csp-'));
  let handler: Handler | null = null;
  afterAll(() => {
    expect(dirname(resolve(bundle))).toBe(resolve(tmpdir()));
    expect(basename(bundle)).toMatch(/^jcad-origin-csp-/);
    rmSync(bundle, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('rejects a junction into a Unicode-distinct native sibling before reading its bytes', async () => {
    // Real NTFS paths/junction; only the Electron protocol/net transport is doubled.
    const inside = join(bundle, '\u0130'), outside = join(bundle, 'I\u0307');
    mkdirSync(inside); mkdirSync(outside);
    writeFileSync(join(outside, 'worker.js'), 'outside-bundle');
    symlinkSync(outside, join(inside, 'escaped'), 'junction');
    let localHandler: Handler | undefined, reads = 0;
    origin.installAssetHandler({ root: inside, protocol: { handle: (_scheme, fn) => { localHandler = fn; } },
      net: { fetch: async () => { reads++; return new Response('outside-bundle'); } } });
    expect((await localHandler!({ method: 'GET', url: 'jcad://app/escaped/worker.js' })).status).toBe(403);
    expect(reads).toBe(0);
  });

  it.runIf(process.platform === 'win32')('keeps native case and contained junction aliases under the worker response policy', async () => {
    const storedRoot = join(bundle, '\u03a3'), aliasRoot = join(bundle, '\u03c3');
    mkdirSync(join(storedRoot, 'assets', 'worker'), { recursive: true });
    writeFileSync(join(storedRoot, 'assets', 'worker', 'kernel.js'), 'inside-worker');
    symlinkSync(join(storedRoot, 'assets', 'worker'), join(storedRoot, 'alias'), 'junction');
    let localHandler: Handler | undefined;
    origin.installAssetHandler({ root: aliasRoot, protocol: { handle: (_scheme, fn) => { localHandler = fn; } },
      net: { fetch: async url => new Response(readFileSync(new URL(url))) } });
    for (const url of ['jcad://app/ASSETS/WORKER/KERNEL.JS', 'jcad://app/alias/kernel.js']) {
      const response = await localHandler!({ method: 'GET', url });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
      expect(await response.text()).toBe('inside-worker');
    }
  });

  it('serves a worker script through the real protocol handler with the header, and the page without it', async () => {
    mkdirSync(join(bundle, 'assets', 'worker'), { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<!doctype html>');
    writeFileSync(join(bundle, 'assets', 'index-a.js'), 'main');
    writeFileSync(join(bundle, 'assets', 'worker', 'manifold.worker-a.js'), 'worker');
    origin.installAssetHandler({
      protocol: { handle: (_scheme, fn) => { handler = fn; } },
      net: { fetch: (url) => Promise.resolve(new Response(readFileSync(new URL(url)), { headers: { 'content-type': url.endsWith('.html') ? 'text/html' : 'text/javascript' } })) },
      root: bundle,
    });
    const get = (url: string) => handler!({ method: 'GET', url });
    const w = await get('jcad://app/assets/worker/manifold.worker-a.js');
    expect(w.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    expect(await w.text()).toBe('worker');
    // Percent-encoding does not dodge the header: the decision uses the decoded path that is served.
    expect((await get('jcad://app/assets/worker/manifold%2Eworker-a.js')).headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    for (const url of ['jcad://app/index.html', 'jcad://app/assets/index-a.js']) {
      const r = await get(url);
      expect(r.status, url).toBe(200);
      expect(r.headers.get('content-security-policy'), url).toBeNull();
    }
  });

  it('decides from the served file: a letter-case alias of the worker still gets the header', async () => {
    const served = origin.servedPath(join('assets', 'worker', 'manifold.worker-a.js'));
    expect(served).toBe('/assets/worker/manifold.worker-a.js');
    expect(origin.assetResponseHeaders(served)).toEqual({ 'Content-Security-Policy': origin.WORKER_CSP });
    const r = await handler!({ method: 'GET', url: 'jcad://app/ASSETS/Worker/MANIFOLD.WORKER-A.JS' });
    // Case-insensitive file systems (Windows, default macOS) serve the worker; it must carry the CSP.
    // A case-sensitive one serves nothing.
    if (r.status === 200) expect(r.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    else expect(r.status).toBe(404);
  });

  it.skipIf(process.platform !== 'win32')('decides from the served file: a Windows 8.3 short name of the worker still gets the header', async (ctx) => {
    const long = join(bundle, 'assets', 'worker', 'manifold.worker-a.js');
    // %~sI prints the 8.3 short path; with 8.3 names disabled on the volume it prints the long one.
    const shortName = (p: string): string => win32.basename(spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim());
    const short = shortName(long);
    if (!short.includes('~')) { ctx.skip(); return; }
    expect(short).toMatch(/^MANIFO~\d\.JS$/i);
    const r = await handler!({ method: 'GET', url: `jcad://app/assets/worker/${short}` });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('worker');
    expect(r.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    // The short name of the worker folder too.
    const dirShort = shortName(join(bundle, 'assets', 'worker'));
    const r2 = await handler!({ method: 'GET', url: `jcad://app/assets/${dirShort}/${short}` });
    expect(r2.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
  });

  it('matches the Vite worker output pattern', () => {
    const vite = readFileSync('vite.config.ts', 'utf8');
    expect(vite).toContain("entryFileNames: 'assets/worker/[name]-[hash].js'");
    expect(vite).toContain("chunkFileNames: 'assets/worker/[name]-[hash].js'");
    // The renderer page policy itself is unchanged: no WebAssembly compilation on the main thread.
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain(`content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none';"`);
    expect(html).not.toContain('wasm-unsafe-eval');
  });
});

// ---- legacy storage migration deadline (P-MIG) --------------------------------------------------
// legacyStorage awaits a hidden window's loadFile + executeJavaScript before the main window is
// created. Test C (2026-10-18) showed the migration completing in ~50 ms on direct launches; the
// deadline is latent hardening against a stalled hidden window, not a reproduced product hang.

type LegacyValues = Record<string, string>;
type LegacyResult = { values: LegacyValues | null; ok: boolean };
interface LegacyWindowDouble {
  webContents: {
    setWindowOpenHandler(fn: () => { action: string }): void;
    on(event: string, fn: (...args: unknown[]) => void): void;
    executeJavaScript(script: string): Promise<unknown>;
  };
  loadFile(file: string): Promise<void>;
  destroy(): void;
}
const legacyOrigin = require('../electron/renderer-origin.cjs') as {
  MIGRATION_DEADLINE_MS: number;
  legacyStorage(deps: {
    BrowserWindow: new (options: unknown) => LegacyWindowDouble;
    protocol: { handle(scheme: string, fn: unknown): void; unhandle(scheme: string): void };
    indexFile: string;
    deadlineMs?: number;
    logError?: (kind: string, error: unknown) => void;
  }): Promise<LegacyResult>;
};

function fakeMigrationWindow(behavior: { load?: () => Promise<void>; execute?: () => Promise<unknown> }) {
  const state = { destroyed: false, loadedFiles: [] as string[], scripts: [] as string[], options: undefined as unknown };
  class FakeBrowserWindow implements LegacyWindowDouble {
    webContents = {
      setWindowOpenHandler(_fn: () => { action: string }) { /* recorded by the product's own handler contract */ },
      on(_event: string, _fn: (...args: unknown[]) => void) { /* navigation guards are inert here */ },
      executeJavaScript: (script: string) => { state.scripts.push(script); return behavior.execute ? behavior.execute() : Promise.resolve({}); },
    };
    constructor(options: unknown) { state.options = options; }
    loadFile(file: string) { state.loadedFiles.push(file); return behavior.load ? behavior.load() : Promise.resolve(); }
    destroy() { state.destroyed = true; }
  }
  return { FakeBrowserWindow, state };
}

function fakeFileProtocol() {
  const handled: string[] = [], unhandled: string[] = [];
  return {
    protocol: { handle: (scheme: string, _fn: unknown) => { handled.push(scheme); }, unhandle: (scheme: string) => { unhandled.push(scheme); } },
    handled, unhandled,
  };
}

describe('legacy storage migration is bounded by a deadline (P-MIG)', () => {
  const indexFile = join(tmpdir(), 'jcad-pmig-index.html');

  it('ships a 15 s production deadline', () => {
    expect(legacyOrigin.MIGRATION_DEADLINE_MS).toBe(15_000);
  });

  it('success: returns the extracted values marked ok, destroys the window, unhandles the protocol', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ execute: () => Promise.resolve({ 'jcad.theme': 'dark', 'jcad.unit': 'mm' }) });
    const { protocol, handled, unhandled } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, logError: (kind, error) => { logs.push([kind, error]); } });
    expect(result).toEqual({ values: { 'jcad.theme': 'dark', 'jcad.unit': 'mm' }, ok: true });
    expect(state.loadedFiles).toEqual([indexFile]);
    expect(state.scripts).toHaveLength(1);
    expect(state.scripts[0]).toContain('localStorage');
    expect(state.destroyed).toBe(true);
    expect(handled).toEqual(['file']);
    expect(unhandled).toEqual(['file']);
    expect(logs).toEqual([]);
  });

  it('success with no legacy entries: the empty dictionary is a completed migration, not a failure', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ execute: () => Promise.resolve({}) });
    const { protocol } = fakeFileProtocol();
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile });
    expect(result).toEqual({ values: {}, ok: true });
    expect(state.destroyed).toBe(true);
  });

  it('oversize extraction (script returns null) keeps the existing null result and is not a failure', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ execute: () => Promise.resolve(null) });
    const { protocol } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, logError: (kind, error) => { logs.push([kind, error]); } });
    expect(result).toEqual({ values: null, ok: true });
    expect(state.destroyed).toBe(true);
    expect(logs).toEqual([]);
  });

  it('timeout: a never-resolving extraction settles at the deadline with empty values, marked failed, logged once', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ execute: () => new Promise<unknown>(() => { /* never settles: the stalled hidden window */ }) });
    const { protocol, unhandled } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const started = Date.now();
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, deadlineMs: 50, logError: (kind, error) => { logs.push([kind, error]); } });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ values: {}, ok: false });
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(4_000);
    expect(state.destroyed).toBe(true);
    expect(unhandled).toEqual(['file']);
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe('renderer preference migration');
    expect(logs[0]![1]).toBeInstanceOf(Error);
    expect((logs[0]![1] as Error).message).toContain('timed out');
  });

  it('timeout: a never-resolving loadFile is bounded by the same deadline', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ load: () => new Promise<void>(() => { /* never settles */ }) });
    const { protocol } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, deadlineMs: 50, logError: (kind, error) => { logs.push([kind, error]); } });
    expect(result).toEqual({ values: {}, ok: false });
    expect(state.destroyed).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it('throw: a rejecting loadFile resolves with empty values marked failed, window destroyed, logged once', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ load: () => Promise.reject(new Error('load boom')) });
    const { protocol, unhandled } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, logError: (kind, error) => { logs.push([kind, error]); } });
    expect(result).toEqual({ values: {}, ok: false });
    expect(state.destroyed).toBe(true);
    expect(unhandled).toEqual(['file']);
    expect(logs).toHaveLength(1);
    expect((logs[0]![1] as Error).message).toBe('load boom');
  });

  it('throw: a rejecting executeJavaScript resolves with empty values marked failed, no unhandled rejection', async () => {
    const { FakeBrowserWindow, state } = fakeMigrationWindow({ execute: () => Promise.reject(new Error('exec boom')) });
    const { protocol } = fakeFileProtocol();
    const logs: Array<[string, unknown]> = [];
    const result = await legacyOrigin.legacyStorage({ BrowserWindow: FakeBrowserWindow, protocol, indexFile, logError: (kind, error) => { logs.push([kind, error]); } });
    expect(result).toEqual({ values: {}, ok: false });
    expect(state.destroyed).toBe(true);
    expect(logs).toHaveLength(1);
    expect((logs[0]![1] as Error).message).toBe('exec boom');
  });
});

describe('3D kernel test hooks reach the renderer only on request in an inspectable build', () => {
  it('adds ?jcad3dTestHooks=1 only for JCAD_3D_TEST_HOOKS=1 with inspection allowed', () => {
    expect(origin.rendererStartUrl({ JCAD_3D_TEST_HOOKS: '1' }, true)).toBe('jcad://app/index.html?jcad3dTestHooks=1');
    expect(origin.rendererStartUrl({ JCAD_3D_TEST_HOOKS: '1' }, false)).toBe(origin.APP_URL);
    expect(origin.rendererStartUrl({}, true)).toBe(origin.APP_URL);
    expect(origin.rendererStartUrl({ JCAD_3D_TEST_HOOKS: 'true' }, true)).toBe(origin.APP_URL);
  });
});
