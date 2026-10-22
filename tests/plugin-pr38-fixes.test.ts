/**
 * PR #38 fixes (Codex review of PR #38, CHANGES REQUIRED; the lead
 * confirmed the findings are real, 2026-10-22). Three fixes, each with
 * a failing-first test in this file:
 *
 *  [P1] Approval must bind the POLICY, not just the code: plugin.json
 *       (its exact bytes) joins the W-1 snapshot manifest under the
 *       package-relative path "plugin.json" and is thereby bound by the
 *       trust record — any plugin.json change (capabilities, the
 *       isolation flag, anything) fails the next registration as
 *       ERR_PLUGIN_CHANGED and the next load re-asks, exactly like a
 *       graph change. plugin.json is hashed and second-pass-verified
 *       like a graph file, but it is NOT retained in the served files
 *       map: the realm never serves it (its 404 is pinned in
 *       tests/plugin-realm-serving.test.ts). A package without
 *       plugin.json builds exactly as before.
 *  [P2a] Load-generation recheck (src/app/plugins.ts): after the
 *       pluginsServeIsolatedPackage await, an unload that landed
 *       meanwhile revokes the served session (unserve) and the plugin
 *       is never constructed or started.
 *  [P2b] Registration generation token (electron side): the realm
 *       registry carries a generation bumped by clear(); the serve
 *       handler captures it before the async snapshot build and the
 *       registration commits only if the generation is unchanged —
 *       a registration whose build spans a clear() (render-process-gone
 *       / destroyed) is discarded and never serves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import { PluginHost, TRUST_KEY, type PluginsBridge, type StorageLike } from '../src/app/plugins';
import { LoopbackTransport } from './plugin-isolation-harness';

const require = createRequire(import.meta.url);

interface SnapshotFile { bytes: Buffer; sha256: string }
interface Snapshot {
  files: Map<string, SnapshotFile>;
  entrySha256: string;
  manifestSha256: string;
  pluginJsonSha256?: string;
  totalBytes: number;
}
interface Registry {
  register(sessionId: string, snapshot: Snapshot, owner?: unknown, expectedGeneration?: number): boolean;
  unregister(sessionId: string, owner?: unknown): boolean;
  clear(): void;
  lookup(sessionId: string): Snapshot | undefined;
  generation(): number;
}
type Handler = (request: { method: string; url: string }) => Promise<Response>;
const origin = require('../electron/renderer-origin.cjs') as {
  createPluginRealmRegistry(): Registry;
  buildPluginRealmSnapshot(root: string, entry: string, options?: { approvedEntryHash?: string; approvedManifestHash?: string; maxBytes?: number }): Promise<Snapshot>;
  installAssetHandler(deps: {
    protocol: { handle(scheme: string, fn: Handler): void };
    net: { fetch(url: string): Promise<Response> };
    root: string;
    pluginRealm?: Registry;
  }): void;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const tree = mkdtempSync(join(tmpdir(), 'jcad-pr38-'));
afterAll(() => {
  expect(dirname(resolve(tree))).toBe(resolve(tmpdir()));
  expect(basename(tree)).toMatch(/^jcad-pr38-/);
  rmSync(tree, { recursive: true, force: true });
});

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

// ---------------------------------------------------------------- [P1]

const P1_ENTRY = "import jcad from './jcad.js';\nexport default { ok: true };\n";
const manifestText = (capabilities: string[]) => JSON.stringify({ name: 'pol', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities });

describe('[P1] plugin.json is bound by the approval', () => {
  const pkgDir = join(tree, 'plugins', 'pol-pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'main.js'), P1_ENTRY);
  const pkgRoot = realpathSync(pkgDir);
  const entryHash = sha256(readFileSync(join(pkgDir, 'main.js')));
  const hosts: PluginHost[] = [];
  afterEach(() => {
    while (hosts.length) {
      const h = hosts.pop()!;
      for (const p of h.list()) h.unload(p.name);
    }
  });

  it('builder: plugin.json joins the manifest (never the served files); a policy-only change fails verification', async () => {
    writeFileSync(join(pkgDir, 'plugin.json'), manifestText([]));
    const v1 = await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js');
    // Bound by the manifest, never served: the files map is the served
    // package and plugin.json is not in it.
    expect(v1.files.has('plugin.json')).toBe(false);
    expect(v1.pluginJsonSha256).toBe(sha256(readFileSync(join(pkgDir, 'plugin.json'))));
    // The manifest is exactly the W-1 lines plus the plugin.json line.
    const lines = [...v1.files.entries()].map(([p, f]) => [p, f.sha256] as const);
    lines.push(['plugin.json', v1.pluginJsonSha256!]);
    const expected = createHash('sha256').update(lines.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, h]) => `${h}\0${p}\n`).join(''), 'utf8').digest('hex');
    expect(v1.manifestSha256).toBe(expected);
    // Unchanged package verifies against the bound manifest.
    const again = await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js', { approvedEntryHash: entryHash, approvedManifestHash: v1.manifestSha256 });
    expect(again.manifestSha256).toBe(v1.manifestSha256);
    // Change ONLY plugin.json (a capability added; entry untouched):
    // verification against the approved manifest must now fail.
    writeFileSync(join(pkgDir, 'plugin.json'), manifestText(['document.write']));
    await expect(
      origin.buildPluginRealmSnapshot(pkgRoot, 'main.js', { approvedEntryHash: entryHash, approvedManifestHash: v1.manifestSha256 }),
    ).rejects.toMatchObject({ code: 'ERR_PLUGIN_CHANGED' });
  });

  it('builder: a package without plugin.json builds exactly as before', async () => {
    const bareDir = join(tree, 'bare');
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, 'main.js'), P1_ENTRY);
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(bareDir), 'main.js');
    expect(snap.pluginJsonSha256).toBeUndefined();
    const only = createHash('sha256').update(`${snap.entrySha256}\0main.js\n`, 'utf8').digest('hex');
    expect(snap.manifestSha256).toBe(only);
  });

  it('host: approved with capabilities [], plugin.json gains document.write, entry unchanged -> refused, forgotten, re-asked', async () => {
    writeFileSync(join(pkgDir, 'plugin.json'), manifestText([]));
    const serveCalls: Array<{ manifest: string | undefined }> = [];
    const bridge: PluginsBridge = {
      pluginsDir: async () => join(tree, 'plugins'),
      pluginsList: async () => [{ folder: 'pol-pkg', manifest: readFileSync(join(pkgDir, 'plugin.json'), 'utf8') }],
      pluginsRead: async () => {
        const bytes = readFileSync(join(pkgDir, 'main.js'));
        return { manifest: readFileSync(join(pkgDir, 'plugin.json'), 'utf8'), code: bytes.toString('utf8'), codeBytes: new Uint8Array(bytes), path: join(pkgDir, 'main.js') };
      },
      // The main-side double, exactly like the W-1 test: verification
      // delegates to the REAL snapshot builder over the real package.
      pluginsServeIsolatedPackage: async (_folder: string, approvedEntryHash?: string, approvedManifestHash?: string) => {
        serveCalls.push({ manifest: approvedManifestHash });
        try {
          const snap = await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js', { approvedEntryHash, approvedManifestHash });
          return { sessionId: 'p1sess', baseUrl: 'jcad://app/plugin-realm/p1sess/', entryUrl: 'jcad://app/plugin-realm/p1sess/main.js', manifestHash: snap.manifestSha256 };
        } catch (e) {
          const err = e as Error & { code?: string };
          if (err.code === 'ERR_PLUGIN_CHANGED') throw Object.assign(new Error(`ERR_PLUGIN_CHANGED: ${err.message}`), { code: err.code });
          throw err;
        }
      },
      pluginsUnserveIsolatedPackage: async () => true,
    };
    const storage: StorageLike & { data: Map<string, string> } = {
      data: new Map(),
      getItem: (k) => storage.data.get(k) ?? null,
      setItem: (k, v) => void storage.data.set(k, v),
    };
    let confirms = 0;
    const trustRecord = () => {
      const raw = storage.data.get(TRUST_KEY);
      if (!raw) return null;
      const entries = Object.values(JSON.parse(raw) as Record<string, { answer: string; hash: string; manifestHash?: string }>);
      return entries.length ? entries[0]! : null;
    };
    const loadOnce = async () => {
      const ed = new Editor(canvas());
      const loop = new LoopbackTransport();
      const host = new PluginHost(ed, { bridge, storage, confirm: async () => { confirms += 1; return true; }, realmTransport: () => loop });
      hosts.push(host);
      let settled = false;
      const loading = host.loadAll().then((r) => { settled = true; return r; });
      await vi.waitFor(() => { if (!settled) expect(loop.inbox.length).toBeGreaterThan(0); }, { timeout: 15_000 }).catch(() => undefined);
      if (!settled && loop.inbox.length > 0) {
        const hs = loop.handshake() as unknown as Record<string, unknown>;
        loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
      }
      return loading;
    };

    // 1. Approve with capabilities []: loads; the manifest (now binding
    // plugin.json) is remembered under the approval.
    const first = await loadOnce();
    expect(first.map((p) => `${p.name}:${p.status}`)).toEqual(['pol:loaded']);
    expect(confirms).toBe(1);
    const bound = trustRecord();
    expect(bound?.manifestHash).toBe((await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js')).manifestSha256);

    // 2. Change ONLY plugin.json — it now grants document.write; the
    // entry is byte-identical. The load must be REFUSED as a changed
    // package (never silently granted the new capability), and the
    // remembered approval forgotten.
    writeFileSync(join(pkgDir, 'plugin.json'), manifestText(['document.write']));
    const second = await loadOnce();
    expect(second.map((p) => `${p.name}:${p.status}`)).toEqual(['pol:error']);
    expect(second[0]!.error).toMatch(/changed/i);
    expect(serveCalls.at(-1)).toEqual({ manifest: bound!.manifestHash });
    expect(trustRecord()).toBeNull();

    // 3. The next load RE-ASKS; on approval the new policy is bound.
    const third = await loadOnce();
    expect(third.map((p) => `${p.name}:${p.status}`)).toEqual(['pol:loaded']);
    expect(confirms).toBe(2);
    expect(trustRecord()?.manifestHash).toBe((await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js')).manifestSha256);
  }, 120_000);
});

// --------------------------------------------------------------- [P2a]

describe('[P2a] an unload during the serve await revokes the session and never constructs the plugin', () => {
  it('unload lands during pluginsServeIsolatedPackage: session unserved, no handshake, load superseded', async () => {
    const pkgDir = join(tree, 'plugins', 'gen-pkg');
    mkdirSync(pkgDir, { recursive: true });
    const GEN_MANIFEST = JSON.stringify({ name: 'gen', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] });
    const GEN_ENTRY = "import jcad from './jcad.js';\nexport default { ok: true };\n";
    writeFileSync(join(pkgDir, 'plugin.json'), GEN_MANIFEST);
    writeFileSync(join(pkgDir, 'main.js'), GEN_ENTRY);
    const serveResolvers: Array<(v: { sessionId: string; baseUrl: string; entryUrl: string; manifestHash: string }) => void> = [];
    const unserveCalls: string[] = [];
    const bridge: PluginsBridge = {
      pluginsDir: async () => join(tree, 'plugins'),
      pluginsList: async () => [{ folder: 'gen-pkg', manifest: GEN_MANIFEST }],
      pluginsRead: async () => {
        const bytes = readFileSync(join(pkgDir, 'main.js'));
        return { manifest: GEN_MANIFEST, code: bytes.toString('utf8'), codeBytes: new Uint8Array(bytes), path: join(pkgDir, 'main.js') };
      },
      pluginsServeIsolatedPackage: () => new Promise((res) => { serveResolvers.push(res); }),
      pluginsUnserveIsolatedPackage: async (sessionId: string) => { unserveCalls.push(sessionId); return true; },
    };
    const storage: StorageLike & { data: Map<string, string> } = {
      data: new Map(),
      getItem: (k) => storage.data.get(k) ?? null,
      setItem: (k, v) => void storage.data.set(k, v),
    };
    const ed = new Editor(canvas());
    const loop = new LoopbackTransport();
    const host = new PluginHost(ed, { bridge, storage, confirm: async () => true, realmTransport: () => loop });
    try {
      const loading = host.loadAll();
      // The load reaches the serve await and parks there.
      await vi.waitFor(() => expect(serveResolvers.length).toBe(1), { timeout: 15_000 });
      // The unload lands while main is still preparing the session.
      expect(host.unload('gen')).toBe(true);
      serveResolvers[0]!({ sessionId: 'p2sess', baseUrl: 'jcad://app/plugin-realm/p2sess/', entryUrl: 'jcad://app/plugin-realm/p2sess/main.js', manifestHash: 'f'.repeat(64) });
      // Let the continuation run, then observe BEFORE settling anything:
      // at the pre-fix head the session is constructed and its load
      // handshake is posted here; the unserve has not happened.
      await new Promise((r) => setTimeout(r, 50));
      const inboxSeen = loop.inbox.length;
      const unservedSeen = [...unserveCalls];
      if (loop.inbox.length > 0) {
        const hs = loop.handshake() as unknown as Record<string, unknown>;
        loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
      }
      const result = await loading;
      expect(inboxSeen).toBe(0);
      expect(unservedSeen).toEqual(['p2sess']);
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe('error');
      expect(result[0]!.error).toMatch(/superseded|unloaded/i);
    } finally {
      for (const p of host.list()) host.unload(p.name);
    }
  }, 120_000);
});

// --------------------------------------------------------------- [P2b]

describe('[P2b] a registration whose snapshot build spans a clear() is discarded and never serves', () => {
  const bundleRoot = join(tree, 'dist');
  mkdirSync(bundleRoot, { recursive: true });
  writeFileSync(join(bundleRoot, 'index.html'), '<!doctype html>');
  const registry = origin.createPluginRealmRegistry();
  let handler: Handler | null = null;
  origin.installAssetHandler({
    protocol: { handle: (_scheme, fn) => { handler = fn; } },
    net: { fetch: (url) => Promise.resolve(new Response(readFileSync(new URL(url)), { headers: { 'content-type': 'text/javascript' } })) },
    root: bundleRoot,
    pluginRealm: registry,
  });
  const get = (url: string) => handler!({ method: 'GET', url });
  const snap: Snapshot = {
    files: new Map([['main.js', { bytes: Buffer.from('export default 1;\n'), sha256: 'x' }]]),
    entrySha256: 'x',
    manifestSha256: 'y',
    totalBytes: 18,
  };
  const SESS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('discards when clear() lands between the generation capture and register; commits otherwise', async () => {
    // The handler's sequence (electron/main/ipc-stores.cjs): capture the
    // generation, AWAIT the snapshot build, then register under it.
    const genBeforeBuild = registry.generation();
    registry.clear(); // render-process-gone / destroyed during the build
    expect(registry.register(SESS, snap, {}, genBeforeBuild)).toBe(false);
    expect(registry.lookup(SESS)).toBeUndefined();
    expect((await get(`jcad://app/plugin-realm/${SESS}/main.js`)).status).toBe(404);
    // No intervening clear(): the same sequence commits and serves.
    const gen2 = registry.generation();
    expect(registry.register(SESS, snap, {}, gen2)).toBe(true);
    const served = await get(`jcad://app/plugin-realm/${SESS}/main.js`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('export default 1;\n');
    // Legacy callers (no generation) still commit, as before.
    const SESS2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(registry.register(SESS2, snap, {})).toBe(true);
    expect(registry.lookup(SESS2)).toBe(snap);
  });

  it('the serve handler wires the generation through (source pin)', () => {
    const ipc = readFileSync('electron/main/ipc-stores.cjs', 'utf8');
    // Scoped to the serve handler: the admission handler (PR #38
    // structural fix) also builds a snapshot, earlier in the file —
    // the pin's claim is about the serve handler's own sequence.
    const serveStart = ipc.indexOf("ipcMain.handle('plugins-serve-isolated'");
    expect(serveStart).toBeGreaterThan(-1);
    const capture = ipc.indexOf('const generation = pluginRealm.generation();', serveStart);
    const build = ipc.indexOf('buildPluginRealmSnapshot(realRoot, main,', serveStart);
    expect(capture).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(capture);
    expect(ipc).toContain('pluginRealm.register(sessionId, snapshot, ev.sender, generation)');
  });
});
