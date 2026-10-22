/**
 * P25 CSP hosting amendment (AMENDMENT-P25-CSP-HOSTING, admitted 2026-10-21) —
 * Part A: main-process serving of a vetted plugin package to the isolated
 * realm under jcad://app/plugin-realm/<sessionId>/, with the worker CSP.
 *
 * Conditions under test (the lead's admission (a)/(b)):
 *  (a) WORKER_CSP is BYTE-UNCHANGED — pinned by strict string equality and
 *      by its SHA-256 (dd5e70ef…, 93 UTF-8 bytes, taken at the base head
 *      7c41aa97 before this amendment touched the file);
 *  (b) the served root is realpath-confined to the registered package:
 *      ../, encoded traversal, backslash forms, symlink escape, case
 *      variants and unknown sessions are ALL refused; only .js/.mjs files
 *      inside the package are served, plus the one virtual file main
 *      serves from memory (jcad.js, the session's jcad proxy shim).
 * Registration lifetime is the session's: unregister / clear() (plugin
 * unload, app quit) end serving immediately.
 *
 * Handler-test style follows tests/renderer-origin.test.ts: the real
 * installAssetHandler with only the Electron protocol/net transport doubled.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);

type Handler = (request: { method: string; url: string }) => Promise<Response>;
interface PluginRealmRegistry {
  register(sessionId: string, realRoot: string): void;
  unregister(sessionId: string): void;
  clear(): void;
  lookup(sessionId: string): string | undefined;
}
const origin = require('../electron/renderer-origin.cjs') as {
  WORKER_CSP: string;
  PLUGIN_REALM_JCAD_SHIM: string;
  assetResponseHeaders(pathname: string): Record<string, string>;
  createPluginRealmRegistry(): PluginRealmRegistry;
  installAssetHandler(deps: {
    protocol: { handle(scheme: string, fn: Handler): void };
    net: { fetch(url: string): Promise<Response> };
    root: string;
    pluginRealm?: PluginRealmRegistry;
  }): void;
};

const SHIM_BODY = 'export default globalThis[Symbol.for("jcad.isolated.jcad")];';
const ENTRY_BODY = "import jcad from './jcad.js';\nexport default { loaded: true };\n";
const EXTRA_BODY = 'export const extra = 42;\n';
const SECRET_BODY = 'TOP-SECRET-OUTSIDE-THE-PACKAGE';

// A plugins tree: pkg/ is the served package, other/ is outside it.
const tree = mkdtempSync(join(tmpdir(), 'jcad-realm-serving-'));
const bundleRoot = join(tree, 'dist');
const pkgDir = join(tree, 'plugins', 'pkg');
const otherDir = join(tree, 'plugins', 'other');
mkdirSync(join(bundleRoot, 'assets', 'worker'), { recursive: true });
mkdirSync(join(pkgDir, 'sub'), { recursive: true });
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(bundleRoot, 'index.html'), '<!doctype html>');
writeFileSync(join(bundleRoot, 'assets', 'worker', 'realm-worker-a.js'), 'worker-bytes');
writeFileSync(join(pkgDir, 'plugin.json'), JSON.stringify({ name: 'pkg', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }));
writeFileSync(join(pkgDir, 'main.js'), ENTRY_BODY);
writeFileSync(join(pkgDir, 'sub', 'extra.mjs'), EXTRA_BODY);
writeFileSync(join(pkgDir, 'notes.txt'), 'package notes, not a script');
writeFileSync(join(pkgDir, 'jcad.js'), 'DISK-JCAD-JS-MUST-NOT-BE-SERVED');
writeFileSync(join(otherDir, 'secret.js'), SECRET_BODY);
symlinkSync(join(otherDir, 'secret.js'), join(pkgDir, 'escape.js'));

const SESSION = '0123456789abcdef0123456789abcdef';
const registry = origin.createPluginRealmRegistry();
let handler: Handler | null = null;
origin.installAssetHandler({
  protocol: { handle: (_scheme, fn) => { handler = fn; } },
  net: { fetch: (url) => Promise.resolve(new Response(readFileSync(new URL(url)), { headers: { 'content-type': 'text/javascript' } })) },
  root: bundleRoot,
  pluginRealm: registry,
});
const get = (url: string) => handler!({ method: 'GET', url });
const realm = (rel: string, session: string = SESSION) => `jcad://app/plugin-realm/${session}/${rel}`;

afterAll(() => {
  expect(dirname(resolve(tree))).toBe(resolve(tmpdir()));
  expect(basename(tree)).toMatch(/^jcad-realm-serving-/);
  rmSync(tree, { recursive: true, force: true });
});

describe('AMENDMENT-P25-CSP-HOSTING (a): WORKER_CSP is byte-unchanged', () => {
  it('pins the string, its length and its SHA-256 to the pre-amendment bytes', () => {
    expect(origin.WORKER_CSP).toBe("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'");
    expect(Buffer.byteLength(origin.WORKER_CSP, 'utf8')).toBe(93);
    expect(createHash('sha256').update(origin.WORKER_CSP, 'utf8').digest('hex')).toBe('dd5e70ef73652cf394296d207d30d005499f1040b3551aca87b5d66d04185287');
  });

  it('extends the header decision to plugin-realm scripts, and nothing else new', () => {
    const csp = { 'Content-Security-Policy': origin.WORKER_CSP };
    expect(origin.assetResponseHeaders(`/plugin-realm/${SESSION}/main.js`)).toEqual(csp);
    expect(origin.assetResponseHeaders(`/plugin-realm/${SESSION}/sub/extra.mjs`)).toEqual(csp);
    expect(origin.assetResponseHeaders(`/plugin-realm/${SESSION}/jcad.js`)).toEqual(csp);
    for (const p of [`/plugin-realm/${SESSION}/notes.txt`, '/plugin-realm/', `/plugin-realm/${SESSION}`, `/plugin-realm/${SESSION}/../main.js`, `/plugin-realm/${SESSION}/sub/../main.js`]) {
      expect(origin.assetResponseHeaders(p), p).toEqual({});
    }
  });

  it('exports the exact one-line jcad.js shim body main serves from memory', () => {
    expect(origin.PLUGIN_REALM_JCAD_SHIM).toBe(SHIM_BODY);
  });
});

describe('plugin-realm registry', () => {
  it('registers, looks up, unregisters and clears', () => {
    const r = origin.createPluginRealmRegistry();
    expect(r.lookup(SESSION)).toBeUndefined();
    r.register(SESSION, pkgDir);
    expect(r.lookup(SESSION)).toBe(pkgDir);
    r.unregister('never-registered');
    expect(r.lookup(SESSION)).toBe(pkgDir);
    r.unregister(SESSION);
    expect(r.lookup(SESSION)).toBeUndefined();
    r.register(SESSION, pkgDir);
    r.clear();
    expect(r.lookup(SESSION)).toBeUndefined();
  });
});

describe('the jcad:// handler serves a registered plugin package under the worker CSP', () => {
  it('serves the entry and nested .mjs files with WORKER_CSP', async () => {
    registry.register(SESSION, await import('node:fs').then((m) => m.realpathSync(pkgDir)));
    const entry = await get(realm('main.js'));
    expect(entry.status).toBe(200);
    expect(entry.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    expect(await entry.text()).toBe(ENTRY_BODY);
    const extra = await get(realm('sub/extra.mjs'));
    expect(extra.status).toBe(200);
    expect(extra.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    expect(await extra.text()).toBe(EXTRA_BODY);
  });

  it('serves the virtual jcad.js shim from main, never the package file of that name', async () => {
    const shim = await get(realm('jcad.js'));
    expect(shim.status).toBe(200);
    expect(shim.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
    expect(await shim.text()).toBe(SHIM_BODY);
  });

  it('refuses every traversal form: the outside file is never served (condition (b))', async () => {
    for (const rel of [
      '../other/secret.js', // literal dot segments (URL-normalised away from this root)
      '..%2fother%2fsecret.js', // encoded slash
      '%2e%2e%2fother%2fsecret.js', // encoded dots + slash
      '..%5cother%5csecret.js', // backslash form
      'sub/..%2f..%2fother%2fsecret.js', // nested encoded traversal
      '%2e%2e/other/secret.js', // mixed
    ]) {
      const r = await get(realm(rel));
      expect(r.status, rel).not.toBe(200);
      expect(await r.text(), rel).not.toContain(SECRET_BODY);
    }
  });

  it('refuses a symlink escape out of the package', async () => {
    const r = await get(realm('escape.js'));
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain(SECRET_BODY);
  });

  it('refuses case variants of a served file name', async () => {
    for (const rel of ['MAIN.JS', 'Main.js', 'main.JS']) {
      const r = await get(realm(rel));
      expect(r.status, rel).not.toBe(200);
      expect(await r.text(), rel).not.toContain('loaded');
    }
  });

  it('serves nothing for unknown sessions, non-script files, or missing files', async () => {
    expect((await get(realm('main.js', 'ffffffffffffffffffffffffffffffff'))).status).toBe(404);
    expect((await get(realm('jcad.js', 'ffffffffffffffffffffffffffffffff'))).status).toBe(404);
    expect((await get(realm('notes.txt'))).status).not.toBe(200);
    expect((await get(realm('missing.js'))).status).toBe(404);
    expect((await get(realm(''))).status).not.toBe(200);
  });

  it('refuses non-GET/HEAD methods with 405, like the bundle discipline', async () => {
    expect((await handler!({ method: 'POST', url: realm('main.js') })).status).toBe(405);
    expect((await handler!({ method: 'HEAD', url: realm('main.js') })).status).toBe(200);
  });

  it('teardown: unregister and clear() end serving immediately (condition (c), main side)', async () => {
    registry.unregister(SESSION);
    expect((await get(realm('main.js'))).status).toBe(404);
    registry.register(SESSION, await import('node:fs').then((m) => m.realpathSync(pkgDir)));
    expect((await get(realm('main.js'))).status).toBe(200);
    registry.clear();
    expect((await get(realm('main.js'))).status).toBe(404);
  });

  it('leaves bundle serving untouched alongside the plugin-realm root', async () => {
    const page = await get('jcad://app/index.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBeNull();
    const worker = await get('jcad://app/assets/worker/realm-worker-a.js');
    expect(worker.status).toBe(200);
    expect(worker.headers.get('content-security-policy')).toBe(origin.WORKER_CSP);
  });
});

describe('main-process wiring for teardown (condition (c)) is in the shipped main', () => {
  const main = readFileSync('electron/main.cjs', 'utf8');
  it('creates one registry, hands it to the asset handler and the IPC context', () => {
    expect(main).toContain('createPluginRealmRegistry()');
    expect(main).toContain('pluginRealm');
    expect(main).toMatch(/installAssetHandler\(\{[^}]*pluginRealm/);
  });
  it('clears registrations on app quit and when the last window closes', () => {
    expect(main).toMatch(/app\.on\('will-quit', \(\) => pluginRealm\.clear\(\)\)/);
    expect(main).toMatch(/window-all-closed[\s\S]{0,200}pluginRealm\.clear\(\)/);
  });
  it('exposes the serve/unserve bridge through the preload', () => {
    const preload = readFileSync('electron/preload.cjs', 'utf8');
    expect(preload).toContain("pluginsServeIsolatedPackage: (folder) => ipcRenderer.invoke('plugins-serve-isolated', folder)");
    expect(preload).toContain("pluginsUnserveIsolatedPackage: (sessionId) => ipcRenderer.invoke('plugins-unserve-isolated', sessionId)");
  });
});
