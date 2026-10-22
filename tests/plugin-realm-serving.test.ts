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
 * Fable F1 (lead's ruling, 2026-10-21): serving is a SNAPSHOT. At
 * registration main reads the entry plus its static module graph ONCE,
 * verifies the entry against the approved trust hash (a mismatch fails
 * the registration with ERR_PLUGIN_CHANGED), records a SHA-256 per file,
 * and serves only those in-memory bytes for the session's life — disk is
 * never re-read after registration, and a path outside the snapshot is
 * refused (404). Approved bytes are the executed bytes.
 *
 * Handler-test style follows tests/renderer-origin.test.ts: the real
 * installAssetHandler with only the Electron protocol/net transport doubled.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);

type Handler = (request: { method: string; url: string }) => Promise<Response>;
interface PluginRealmSnapshotFile {
  bytes: Buffer;
  sha256: string;
}
interface PluginRealmSnapshot {
  files: Map<string, PluginRealmSnapshotFile>;
  entrySha256: string;
  manifestSha256: string;
  pluginJsonSha256?: string;
  totalBytes: number;
}
interface PluginRealmRegistry {
  register(sessionId: string, snapshot: PluginRealmSnapshot, owner?: unknown): void;
  unregister(sessionId: string, owner?: unknown): boolean;
  clear(): void;
  lookup(sessionId: string): PluginRealmSnapshot | undefined;
}
const origin = require('../electron/renderer-origin.cjs') as {
  WORKER_CSP: string;
  PLUGIN_REALM_JCAD_SHIM: string;
  PLUGIN_REALM_SNAPSHOT_MAX_BYTES: number;
  assetResponseHeaders(pathname: string): Record<string, string>;
  createPluginRealmRegistry(): PluginRealmRegistry;
  buildPluginRealmSnapshot(realRoot: string, entryRelPath: string, options?: { approvedEntryHash?: string; approvedManifestHash?: string; maxBytes?: number }): Promise<PluginRealmSnapshot>;
  installAssetHandler(deps: {
    protocol: { handle(scheme: string, fn: Handler): void };
    net: { fetch(url: string): Promise<Response> };
    root: string;
    pluginRealm?: PluginRealmRegistry;
  }): void;
};

const SHIM_BODY = 'export default globalThis[Symbol.for("jcad.isolated.jcad")];';
// The entry's static module graph: the shim import (virtual, never
// snapshotted) plus sub/extra.mjs, which snapshot serving may serve
// precisely because the entry imports it.
const ENTRY_BODY = "import jcad from './jcad.js';\nimport './sub/extra.mjs';\nexport default { loaded: true };\n";
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
// W-2 (lead ruling, 2026-10-22): creating a file symlink needs
// privilege on Windows (Developer Mode or an elevated shell) — an
// EPERM here must SKIP the one test that uses the link (with the
// reason recorded), never kill the whole file at import time.
let symlinkFailure: unknown = null;
try {
  symlinkSync(join(otherDir, 'secret.js'), join(pkgDir, 'escape.js'));
} catch (err) {
  symlinkFailure = err;
}

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

/** Snapshot the shared fixture package and register it under SESSION. */
async function servePkg(): Promise<PluginRealmSnapshot> {
  const snapshot = await origin.buildPluginRealmSnapshot(realpathSync(pkgDir), 'main.js');
  registry.register(SESSION, snapshot);
  return snapshot;
}

describe('plugin-realm registry', () => {
  it('registers, looks up, unregisters and clears', () => {
    const r = origin.createPluginRealmRegistry();
    const snap: PluginRealmSnapshot = { files: new Map(), entrySha256: 'x', manifestSha256: 'y', totalBytes: 0 };
    expect(r.lookup(SESSION)).toBeUndefined();
    r.register(SESSION, snap);
    expect(r.lookup(SESSION)).toBe(snap);
    r.unregister('never-registered');
    expect(r.lookup(SESSION)).toBe(snap);
    r.unregister(SESSION);
    expect(r.lookup(SESSION)).toBeUndefined();
    r.register(SESSION, snap);
    r.clear();
    expect(r.lookup(SESSION)).toBeUndefined();
  });
});

describe('the jcad:// handler serves a registered plugin package under the worker CSP', () => {
  it('serves the entry and nested .mjs files with WORKER_CSP', async () => {
    await servePkg();
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

  // Skipped only where symlink creation itself was refused (EPERM —
  // Windows without Developer Mode or an elevated shell): the guard
  // above records the failure instead of dying at import (W-2).
  it.skipIf(symlinkFailure !== null)('refuses a symlink escape out of the package', async () => {
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
    await servePkg();
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
  it('clears registrations when the renderer process goes away or its webContents is destroyed (Fable F4)', () => {
    const win = readFileSync('electron/main/window.cjs', 'utf8');
    expect(win).toMatch(/const endPluginRealmSessions = \(\) => ctx\.pluginRealm\.clear\(\)/);
    expect(win).toMatch(/webContents\.on\('render-process-gone', endPluginRealmSessions\)/);
    expect(win).toMatch(/webContents\.once\('destroyed', endPluginRealmSessions\)/);
  });
  it('exposes the serve/unserve bridge through the preload', () => {
    const preload = readFileSync('electron/preload.cjs', 'utf8');
    expect(preload).toContain("pluginsServeIsolatedPackage: (folder, approvedEntryHash, approvedManifestHash) => ipcRenderer.invoke('plugins-serve-isolated', folder, approvedEntryHash, approvedManifestHash)");
    expect(preload).toContain("pluginsUnserveIsolatedPackage: (sessionId) => ipcRenderer.invoke('plugins-unserve-isolated', sessionId)");
  });
  it('wires the W-1 manifest through the serve handler: verified in main, reported back, ERR_PLUGIN_CHANGED named in the IPC message', () => {
    const ipc = readFileSync('electron/main/ipc-stores.cjs', 'utf8');
    expect(ipc).toContain('approvedManifestHash');
    expect(ipc).toMatch(/buildPluginRealmSnapshot\(realRoot, main, \{ approvedEntryHash, approvedManifestHash \}\)/);
    expect(ipc).toContain('manifestHash: snapshot.manifestSha256');
    expect(ipc).toContain("err.code === 'ERR_PLUGIN_CHANGED'");
    expect(ipc).toContain('`ERR_PLUGIN_CHANGED: ${err.message}`');
  });
});

describe('Fable F1: snapshot serving — approved bytes are the executed bytes', () => {
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const F1_SESSION = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
  const f1Tree = mkdtempSync(join(tmpdir(), 'jcad-realm-snapshot-'));
  const f1Pkg = join(f1Tree, 'pkg');
  const ENTRY_V1 = "import jcad from './jcad.js';\nimport { v } from './lib.js';\nexport default { v };\n";
  const LIB_V1 = 'export const v = "approved-lib";\n';
  const ENTRY_V2 = "import jcad from './jcad.js';\nimport { v } from './lib.js';\nexport default { v, swapped: true };\n";
  const LIB_V2 = 'export const v = "SWAPPED-PACKAGE-CONTENT";\n';
  mkdirSync(f1Pkg, { recursive: true });
  writeFileSync(join(f1Pkg, 'plugin.json'), JSON.stringify({ name: 'snap', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }));
  writeFileSync(join(f1Pkg, 'main.js'), ENTRY_V1);
  writeFileSync(join(f1Pkg, 'lib.js'), LIB_V1);
  writeFileSync(join(f1Pkg, 'jcad.js'), 'DISK-JCAD-JS-MUST-NOT-BE-SERVED');
  writeFileSync(join(f1Pkg, 'orphan.js'), 'export const orphan = true;\n');
  const f1Root = realpathSync(f1Pkg);
  const f1Realm = (rel: string) => realm(rel, F1_SESSION);

  afterAll(() => {
    expect(dirname(resolve(f1Tree))).toBe(resolve(tmpdir()));
    expect(basename(f1Tree)).toMatch(/^jcad-realm-snapshot-/);
    rmSync(f1Tree, { recursive: true, force: true });
  });

  it('the snapshot is the entry plus its static module graph, hashed per file; the disk jcad.js is not package content', async () => {
    expect(origin.PLUGIN_REALM_SNAPSHOT_MAX_BYTES).toBe(32 * 1024 * 1024);
    const snap = await origin.buildPluginRealmSnapshot(f1Root, 'main.js');
    expect([...snap.files.keys()].sort()).toEqual(['lib.js', 'main.js']);
    expect(snap.entrySha256).toBe(sha256(ENTRY_V1));
    expect(snap.files.get('main.js')!.sha256).toBe(sha256(ENTRY_V1));
    expect(snap.files.get('lib.js')!.sha256).toBe(sha256(LIB_V1));
    expect(snap.files.get('lib.js')!.bytes.toString('utf8')).toBe(LIB_V1);
    expect(snap.totalBytes).toBe(Buffer.byteLength(ENTRY_V1) + Buffer.byteLength(LIB_V1));
  });

  it('(i) replacing the package on disk mid-session changes nothing served: the approved bytes are served', async () => {
    const snap = await origin.buildPluginRealmSnapshot(f1Root, 'main.js', { approvedEntryHash: sha256(ENTRY_V1) });
    registry.register(F1_SESSION, snap);
    writeFileSync(join(f1Pkg, 'main.js'), ENTRY_V2);
    writeFileSync(join(f1Pkg, 'lib.js'), LIB_V2);
    const entry = await get(f1Realm('main.js'));
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(ENTRY_V1);
    const lib = await get(f1Realm('lib.js'));
    expect(lib.status).toBe(200);
    expect(await lib.text()).toBe(LIB_V1);
  });

  it('(ii) a NEW registration after the replacement fails the trust check with ERR_PLUGIN_CHANGED', async () => {
    const err = await origin.buildPluginRealmSnapshot(f1Root, 'main.js', { approvedEntryHash: sha256(ENTRY_V1) }).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.code).toBe('ERR_PLUGIN_CHANGED');
    // The replaced package can still register — against ITS hash (the
    // user re-approves the new source through the normal trust flow).
    const snap2 = await origin.buildPluginRealmSnapshot(f1Root, 'main.js', { approvedEntryHash: sha256(ENTRY_V2) });
    expect(snap2.entrySha256).toBe(sha256(ENTRY_V2));
    registry.unregister(F1_SESSION);
  });

  it('(iii) a path that exists on disk but is not in the snapshot is refused (404)', async () => {
    const snap = await origin.buildPluginRealmSnapshot(f1Root, 'main.js');
    registry.register(F1_SESSION, snap);
    expect((await get(f1Realm('orphan.js'))).status).toBe(404);
    expect((await get(f1Realm('plugin.json'))).status).toBe(404);
    registry.unregister(F1_SESSION);
  });

  it('(iv) a snapshot over the cap is refused with a clear error', async () => {
    const err = await origin.buildPluginRealmSnapshot(f1Root, 'main.js', { maxBytes: 16 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/snapshot exceeds/i);
  });
});

describe('W-1 (lead ruling, 2026-10-22): approval binds the WHOLE snapshot — the manifest hash', () => {
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const w1Tree = mkdtempSync(join(tmpdir(), 'jcad-realm-manifest-'));
  const w1Pkg = join(w1Tree, 'pkg');
  const W1_ENTRY = "import jcad from './jcad.js';\nimport { v } from './dep.js';\nexport default { v };\n";
  const DEP_V1 = 'export const v = "dep-one";\n';
  const DEP_V2 = 'export const v = "dep-two";\n';
  mkdirSync(w1Pkg, { recursive: true });
  writeFileSync(join(w1Pkg, 'plugin.json'), JSON.stringify({ name: 'mani', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }));
  writeFileSync(join(w1Pkg, 'main.js'), W1_ENTRY);
  writeFileSync(join(w1Pkg, 'dep.js'), DEP_V1);
  const w1Root = realpathSync(w1Pkg);

  afterAll(() => {
    expect(dirname(resolve(w1Tree))).toBe(resolve(tmpdir()));
    expect(basename(w1Tree)).toMatch(/^jcad-realm-manifest-/);
    rmSync(w1Tree, { recursive: true, force: true });
  });

  /** The manifest hash, recomputed independently from a snapshot's file records (PR #38 [P1]: the plugin.json line joins the list when the snapshot carries one). */
  const manifestOf = (snap: PluginRealmSnapshot): string => {
    const paths = [...snap.files.keys()];
    if (snap.pluginJsonSha256) paths.push('plugin.json');
    const lines = paths.sort().map((rel) => `${rel === 'plugin.json' && snap.pluginJsonSha256 ? snap.pluginJsonSha256 : snap.files.get(rel)!.sha256}\0${rel}\n`);
    return createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
  };

  it('the snapshot carries a manifest hash over the sorted (path, sha256) list of EVERY snapshotted file', async () => {
    const snap = await origin.buildPluginRealmSnapshot(w1Root, 'main.js');
    expect(typeof snap.manifestSha256).toBe('string');
    expect(snap.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.manifestSha256).toBe(manifestOf(snap));
    // The entry is part of the manifest (the manifest includes it), and
    // the entry check keeps working alongside it.
    expect(snap.entrySha256).toBe(sha256(W1_ENTRY));
  });

  it('a changed DEPENDENCY with an unchanged entry fails against the approved manifest with ERR_PLUGIN_CHANGED', async () => {
    const approved = await origin.buildPluginRealmSnapshot(w1Root, 'main.js', { approvedEntryHash: sha256(W1_ENTRY) });
    const manifestV1 = approved.manifestSha256;
    // The unchanged package verifies against its own manifest.
    const again = await origin.buildPluginRealmSnapshot(w1Root, 'main.js', { approvedEntryHash: sha256(W1_ENTRY), approvedManifestHash: manifestV1 });
    expect(again.manifestSha256).toBe(manifestV1);
    // Change ONLY the dependency; the entry (and its approved hash) is
    // untouched — the entry check alone would pass, the manifest must not.
    writeFileSync(join(w1Pkg, 'dep.js'), DEP_V2);
    const err = await origin.buildPluginRealmSnapshot(w1Root, 'main.js', { approvedEntryHash: sha256(W1_ENTRY), approvedManifestHash: manifestV1 }).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.code).toBe('ERR_PLUGIN_CHANGED');
    // An unbound registration (a fresh approval) snapshots the new graph
    // and reports its NEW manifest — different from the approved one.
    const fresh = await origin.buildPluginRealmSnapshot(w1Root, 'main.js', { approvedEntryHash: sha256(W1_ENTRY) });
    expect(fresh.manifestSha256).not.toBe(manifestV1);
    expect(fresh.manifestSha256).toBe(manifestOf(fresh));
    writeFileSync(join(w1Pkg, 'dep.js'), DEP_V1);
  });
});

describe('W-2 (lead ruling, 2026-10-22): the escape discipline through a directory JUNCTION — runs everywhere', () => {
  // A junction is the UNPRIVILEGED directory-link form on Windows (no
  // Developer Mode, no elevation), so this variant of the escape test
  // runs on every platform. POSIX has no junctions: there a directory
  // symlink is created instead — the same mechanism, resolved by the
  // same realpath + containment code (statSnapshotFile) and the same
  // snapshot-membership lookup at serve time, so the variant exercises
  // the identical discipline.
  const jTree = mkdtempSync(join(tmpdir(), 'jcad-realm-junction-'));
  const jOutside = join(jTree, 'outside');
  mkdirSync(jOutside, { recursive: true });
  writeFileSync(join(jOutside, 'secret.js'), SECRET_BODY);
  const mkPkg = (name: string, entryBody: string): string => {
    const dir = join(jTree, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }));
    writeFileSync(join(dir, 'main.js'), entryBody);
    return dir;
  };
  // pkgLink's entry imports THROUGH the junction; pkgClean merely has one.
  const linkPkg = mkPkg('pkglink', "import jcad from './jcad.js';\nimport './link/secret.js';\nexport default { loaded: true };\n");
  const cleanPkg = mkPkg('pkgclean', "import jcad from './jcad.js';\nexport default { loaded: true };\n");
  let junctionFailure: unknown = null;
  try {
    symlinkSync(jOutside, join(linkPkg, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(jOutside, join(cleanPkg, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    junctionFailure = err;
  }
  const JSESSION = 'abcdefabcdefabcdefabcdefabcdefab';

  afterAll(() => {
    expect(dirname(resolve(jTree))).toBe(resolve(tmpdir()));
    expect(basename(jTree)).toMatch(/^jcad-realm-junction-/);
    rmSync(jTree, { recursive: true, force: true });
  });

  it.skipIf(junctionFailure !== null)('registration refuses a module graph that reaches through the junction out of the package', async () => {
    const err = await origin.buildPluginRealmSnapshot(realpathSync(linkPkg), 'main.js').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/resolves outside its package/);
  });

  it.skipIf(junctionFailure !== null)('serving refuses a path through the junction (it is not in the snapshot)', async () => {
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(cleanPkg), 'main.js');
    registry.register(JSESSION, snap);
    const r = await get(realm('link/secret.js', JSESSION));
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain(SECRET_BODY);
    registry.unregister(JSESSION);
  });
});

describe('W-3 (lead ruling, 2026-10-22): unserve is owner-checked; served responses carry nosniff', () => {
  const W3_SESSION = '33333333333333333333333333333333';
  // Opaque identity tokens standing in for the webContents objects the
  // IPC handlers pass: identity is all the check compares.
  const ownerA = { name: 'webContents-A' };
  const ownerB = { name: 'webContents-B' };

  it('only the registering owner may unserve: a foreign unserve is refused (no-op) and the session keeps serving', async () => {
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(pkgDir), 'main.js');
    registry.register(W3_SESSION, snap, ownerA);
    expect(registry.unregister(W3_SESSION, ownerB)).toBe(false);
    const still = await get(realm('main.js', W3_SESSION));
    expect(still.status).toBe(200);
    expect(await still.text()).toBe(ENTRY_BODY);
    expect(registry.unregister(W3_SESSION, ownerA)).toBe(true);
    expect((await get(realm('main.js', W3_SESSION))).status).toBe(404);
  });

  it('an unowned registration unserves as before (internal callers and clear() are unaffected)', async () => {
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(pkgDir), 'main.js');
    registry.register(W3_SESSION, snap);
    expect(registry.unregister(W3_SESSION)).toBe(true);
    expect(registry.lookup(W3_SESSION)).toBeUndefined();
    expect(registry.unregister(W3_SESSION)).toBe(false);
  });

  it('every plugin-realm response carries X-Content-Type-Options: nosniff (file, shim and refusal alike)', async () => {
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(pkgDir), 'main.js');
    registry.register(W3_SESSION, snap);
    for (const rel of ['main.js', 'sub/extra.mjs', 'jcad.js']) {
      const r = await get(realm(rel, W3_SESSION));
      expect(r.status, rel).toBe(200);
      expect(r.headers.get('x-content-type-options'), rel).toBe('nosniff');
      expect(r.headers.get('content-security-policy'), rel).toBe(origin.WORKER_CSP);
    }
    const missing = await get(realm('missing.js', W3_SESSION));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    registry.unregister(W3_SESSION);
  });

  it('the IPC handlers pass the sender through: serve registers it, unserve is checked against it', () => {
    const ipc = readFileSync('electron/main/ipc-stores.cjs', 'utf8');
    expect(ipc).toMatch(/pluginRealm\.register\(sessionId, snapshot, ev\.sender, generation\)/);
    expect(ipc).toMatch(/unregister\(sessionId, ev\.sender\)/);
    expect(ipc).toContain("ipcMain.handle('plugins-serve-isolated', async (ev, folder, approvedEntryHash, approvedManifestHash) => {");
  });
});
