/**
 * W-1 (lead ruling, 2026-10-22, from the c0bf820 packaged gate): approval
 * binds the WHOLE snapshot, not just the entry. The trust record stores a
 * MANIFEST HASH over the sorted (path, sha256) list of every snapshotted
 * file; a changed DEPENDENCY with an unchanged entry fails the next
 * registration as ERR_PLUGIN_CHANGED and the next load re-asks — approved
 * bytes = executed bytes for the whole graph. (This overrules the earlier
 * note that dependency-only changes serve under the entry approval.)
 *
 * Main side: electron/renderer-origin.cjs computes the manifest in
 * buildPluginRealmSnapshot and verifies an approved manifest alongside
 * the approved entry hash. Renderer side: src/app/plugins.ts passes the
 * remembered manifest to the serve bridge and persists the manifest main
 * reports back. The bridge below is a test double for main's IPC handler
 * that delegates verification to the REAL snapshot builder over a real
 * on-disk package, so a dependency change genuinely fails verification.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, basename, join, resolve } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import { PluginHost, TRUST_KEY, type PluginsBridge, type StorageLike } from '../src/app/plugins';
import { LoopbackTransport } from './plugin-isolation-harness';

const require = createRequire(import.meta.url);
const origin = require('../electron/renderer-origin.cjs') as {
  buildPluginRealmSnapshot(root: string, entry: string, options?: { approvedEntryHash?: string; approvedManifestHash?: string }): Promise<{
    files: Map<string, { bytes: Buffer; sha256: string }>;
    entrySha256: string;
    manifestSha256: string;
    totalBytes: number;
  }>;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const tree = mkdtempSync(join(tmpdir(), 'jcad-w1-manifest-'));
afterAll(() => {
  expect(dirname(resolve(tree))).toBe(resolve(tmpdir()));
  expect(basename(tree)).toMatch(/^jcad-w1-manifest-/);
  rmSync(tree, { recursive: true, force: true });
});

const ENTRY = "import jcad from './jcad.js';\nimport { v } from './dep.js';\nexport default { v };\n";
const DEP_V1 = 'export const v = "dep-one";\n';
const DEP_V2 = 'export const v = "dep-two";\n';
const MANIFEST_TEXT = JSON.stringify({ name: 'mani', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] });

const pkgDir = join(tree, 'plugins', 'mani-pkg');
mkdirSync(pkgDir, { recursive: true });
writeFileSync(join(pkgDir, 'plugin.json'), MANIFEST_TEXT);
writeFileSync(join(pkgDir, 'main.js'), ENTRY);
writeFileSync(join(pkgDir, 'dep.js'), DEP_V1);
const pkgRoot = realpathSync(pkgDir);
const entryHash = sha256(readFileSync(join(pkgDir, 'main.js')));

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('W-1: a changed dependency with an unchanged entry fails ERR_PLUGIN_CHANGED and re-asks', () => {
  const hosts: PluginHost[] = [];
  afterEach(() => {
    while (hosts.length) {
      const h = hosts.pop()!;
      for (const p of h.list()) h.unload(p.name);
    }
  });

  it('the whole load sequence: approve → bind manifest → dep change fails + forgets → re-ask → rebind', async () => {
    const serveCalls: Array<{ entry: string; manifest: string | undefined }> = [];
    const bridge: PluginsBridge = {
      pluginsDir: async () => join(tree, 'plugins'),
      pluginsList: async () => [{ folder: 'mani-pkg', manifest: MANIFEST_TEXT }],
      pluginsRead: async () => {
        const bytes = readFileSync(join(pkgDir, 'main.js'));
        return { manifest: MANIFEST_TEXT, code: bytes.toString('utf8'), codeBytes: new Uint8Array(bytes), path: join(pkgDir, 'main.js') };
      },
      // The main-side double: verify against the REAL snapshot builder,
      // exactly like electron/main/ipc-stores.cjs (a changed package is
      // rethrown with the ERR_PLUGIN_CHANGED token in the message, the
      // only part of the error that survives real IPC).
      pluginsServeIsolatedPackage: async (_folder: string, approvedEntryHash?: string, approvedManifestHash?: string) => {
        serveCalls.push({ entry: approvedEntryHash ?? '', manifest: approvedManifestHash });
        try {
          const snap = await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js', { approvedEntryHash, approvedManifestHash });
          return { sessionId: 'w1sess', baseUrl: 'jcad://app/plugin-realm/w1sess/', entryUrl: 'jcad://app/plugin-realm/w1sess/main.js', manifestHash: snap.manifestSha256 };
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
      const all = JSON.parse(raw) as Record<string, { answer: string; hash: string; manifestHash?: string }>;
      const entries = Object.values(all);
      return entries.length ? entries[0]! : null;
    };
    const loadOnce = async () => {
      const ed = new Editor(canvas());
      const loop = new LoopbackTransport();
      const host = new PluginHost(ed, {
        bridge,
        storage,
        confirm: async () => { confirms += 1; return true; },
        realmTransport: () => loop,
      });
      hosts.push(host);
      let settled = false;
      const loading = host.loadAll().then((r) => { settled = true; return r; });
      // A successful load parks at the realm handshake; a refused load
      // settles on its own. Complete whichever happens.
      await vi.waitFor(() => { if (!settled) expect(loop.inbox.length).toBeGreaterThan(0); }, { timeout: 15_000 }).catch(() => undefined);
      if (!settled && loop.inbox.length > 0) {
        const hs = loop.handshake() as unknown as Record<string, unknown>;
        loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
      }
      return loading;
    };

    const manifestV1 = (await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js')).manifestSha256;

    // 1. First load: the user approves; nothing is bound yet, so the
    // serve is unbound and the reported manifest is remembered.
    const first = await loadOnce();
    expect(first.map((p) => `${p.name}:${p.status}`)).toEqual(['mani:loaded']);
    expect(confirms).toBe(1);
    expect(serveCalls).toEqual([{ entry: entryHash, manifest: undefined }]);
    expect(trustRecord()?.hash).toBe(entryHash);
    expect(trustRecord()?.manifestHash).toBe(manifestV1);

    // 2. Unchanged reload: remembered, no re-ask, and the serve is now
    // verified against the remembered manifest.
    const second = await loadOnce();
    expect(second.map((p) => `${p.name}:${p.status}`)).toEqual(['mani:loaded']);
    expect(confirms).toBe(1);
    expect(serveCalls.at(-1)).toEqual({ entry: entryHash, manifest: manifestV1 });

    // 3. Change ONLY the dependency (entry bytes untouched): the load
    // must FAIL as a changed package, and the remembered approval must
    // be forgotten so the next load re-asks.
    writeFileSync(join(pkgDir, 'dep.js'), DEP_V2);
    const third = await loadOnce();
    expect(third.map((p) => `${p.name}:${p.status}`)).toEqual(['mani:error']);
    expect(third[0]!.error).toMatch(/changed/i);
    expect(serveCalls.at(-1)).toEqual({ entry: entryHash, manifest: manifestV1 });
    expect(trustRecord()).toBeNull();

    // 4. The next load RE-ASKS; on approval it serves unbound and binds
    // the NEW manifest.
    const manifestV2 = (await origin.buildPluginRealmSnapshot(pkgRoot, 'main.js')).manifestSha256;
    expect(manifestV2).not.toBe(manifestV1);
    const fourth = await loadOnce();
    expect(fourth.map((p) => `${p.name}:${p.status}`)).toEqual(['mani:loaded']);
    expect(confirms).toBe(2);
    expect(serveCalls.at(-1)).toEqual({ entry: entryHash, manifest: undefined });
    expect(trustRecord()?.manifestHash).toBe(manifestV2);

    // 5. Steady state again: no re-ask, verified against the new manifest.
    const fifth = await loadOnce();
    expect(fifth.map((p) => `${p.name}:${p.status}`)).toEqual(['mani:loaded']);
    expect(confirms).toBe(2);
    expect(serveCalls.at(-1)).toEqual({ entry: entryHash, manifest: manifestV2 });
  }, 120_000);
});
