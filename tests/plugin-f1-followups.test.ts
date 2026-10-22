/**
 * Fable F1 re-check follow-ups (R1/R2/R3), fixed under the lead's ruling
 * (2026-10-22) in ONE follow-up commit on the snapshot-serving head:
 *  R1 — the snapshot's static-graph recogniser covers spaceless and
 *       comment-interposed import/export forms (minified packages);
 *       anything still unrecognised keeps failing closed (serve-time 404).
 *  R2 — hashing canonicalises on RAW BYTES end to end: main's plugins-read
 *       sends the entry's exact bytes (Uint8Array) alongside the decoded
 *       text, the renderer's trust + snapshot-verification hashes are
 *       taken over those bytes, and the snapshot serves the raw bytes
 *       unchanged. A Latin-1 byte in a comment can no longer loop
 *       ERR_PLUGIN_CHANGED on an unchanged file.
 *  R3 — (a) the snapshot cap is charged from each file's pre-read stat
 *       size BEFORE the file is buffered (an over-cap file is refused
 *       without being opened); (b) after the walk, every snapshotted
 *       file is re-statted and re-hashed — a mid-walk change aborts the
 *       registration with ERR_PLUGIN_CHANGED (no mixed-version snapshot).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Editor as EditorType } from '../src/app/editor';
import * as pluginsModule from '../src/app/plugins';
import { PluginHost, TRUST_KEY, type PluginsBridge, type StorageLike } from '../src/app/plugins';
import { LoopbackTransport } from './plugin-isolation-harness';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as Record<string, unknown>;
const origin = require('../electron/renderer-origin.cjs') as {
  WORKER_CSP: string;
  createPluginRealmRegistry(): {
    register(id: string, snap: unknown): void;
    unregister(id: string): void;
    clear(): void;
    lookup(id: string): unknown;
  };
  buildPluginRealmSnapshot(root: string, entry: string, options?: { approvedEntryHash?: string; maxBytes?: number }): Promise<{
    files: Map<string, { bytes: Buffer; sha256: string }>;
    entrySha256: string;
    totalBytes: number;
  }>;
  installAssetHandler(deps: { protocol: { handle(s: string, fn: (r: { method: string; url: string }) => Promise<Response>): void }; net: { fetch(u: string): Promise<Response> }; root: string; pluginRealm?: unknown }): void;
};
const pluginFiles = require('../electron/plugin-files.cjs') as {
  readPluginSource(root: string, folder: string): Promise<{ manifest: string; code: string; path: string } | null>;
  readPluginSourceBytes?: (root: string, folder: string) => Promise<{ manifest: string; codeBytes: Buffer; path: string } | null>;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const codeHashBytes = (pluginsModule as Record<string, unknown>).codeHashBytes as
  | ((bytes: Uint8Array) => Promise<string>)
  | undefined;

const tree = mkdtempSync(join(tmpdir(), 'jcad-f1-followups-'));
afterAll(() => {
  expect(dirname(resolve(tree))).toBe(resolve(tmpdir()));
  expect(basename(tree)).toMatch(/^jcad-f1-followups-/);
  rmSync(tree, { recursive: true, force: true });
});

function pkgDir(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(tree, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return realpathSync(dir);
}

// ------------------------------------------------------------------ R1

describe('R1: the graph recogniser covers spaceless and comment-interposed forms', () => {
  const MINIFIED_MAIN = [
    "import{x}from'./a.js';export*from'./b.mjs';",
    "import/*c*/{y}from'./c.js';",
    'import//ln\n{z}from\'./d.js\';',
    "import{w}from'./e.js';export{w2}from'./e2.js';",
    'export const all=[x,y,z,w];',
    '',
  ].join('\n');
  const dir = pkgDir('minified', {
    'plugin.json': JSON.stringify({ name: 'minified', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }),
    'main.js': MINIFIED_MAIN,
    'a.js': "import{f}from'./f.js';export const x='x'+f;",
    'b.mjs': "export const bee='bee';",
    'c.js': "export const y='y';",
    'd.js': "export const z='z';",
    'e.js': "export const w='w';",
    'e2.js': "export const w2='w2';",
    'f.js': "export const f='f';",
  });

  it('snapshots the FULL graph of a minified multi-file package', async () => {
    const snap = await origin.buildPluginRealmSnapshot(dir, 'main.js');
    expect([...snap.files.keys()].sort()).toEqual(['a.js', 'b.mjs', 'c.js', 'd.js', 'e.js', 'e2.js', 'f.js', 'main.js']);
  });

  it('the minified sample is valid ESM and loads end-to-end (Node module loader)', async () => {
    const ns = (await import(pathToFileURL(join(dir, 'main.js')).href)) as { all: string[]; bee: string; w2: string };
    expect(ns.all).toEqual(['xf', 'y', 'z', 'w']);
    expect(ns.bee).toBe('bee');
    expect(ns.w2).toBe('w2');
  });

  it('serves the minified graph from the snapshot (entry + spaceless-only dependency)', async () => {
    const registry = origin.createPluginRealmRegistry();
    let handler: ((r: { method: string; url: string }) => Promise<Response>) | null = null;
    origin.installAssetHandler({
      protocol: { handle: (_s, fn) => { handler = fn; } },
      net: { fetch: () => Promise.reject(new Error('no bundle fetch in this test')) },
      root: dir,
      pluginRealm: registry,
    });
    const snap = await origin.buildPluginRealmSnapshot(dir, 'main.js');
    registry.register('r1session', snap);
    const entry = await handler!({ method: 'GET', url: 'jcad://app/plugin-realm/r1session/main.js' });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(MINIFIED_MAIN);
    const dep = await handler!({ method: 'GET', url: 'jcad://app/plugin-realm/r1session/f.js' });
    expect(dep.status).toBe(200);
    expect(await dep.text()).toBe("export const f='f';");
    registry.clear();
  });
});

// ------------------------------------------------------------------ R2

// An entry whose comment carries a Latin-1 byte (0xE9): invalid UTF-8,
// perfectly valid content for the lossy decode v1 has always executed.
const LATIN1_ENTRY = Buffer.concat([
  Buffer.from('// caf', 'utf8'),
  Buffer.from([0xe9]),
  Buffer.from(" latin\nimport './dep.js';\nexport const v = 1;\n", 'utf8'),
]);
const LATIN1_DEP = 'export const dep = 2;\n';

describe('R2: hashing canonicalises on raw bytes', () => {
  const dir = pkgDir('latin1', {
    'plugin.json': JSON.stringify({ name: 'latin1', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] }),
    'main.js': LATIN1_ENTRY,
    'dep.js': LATIN1_DEP,
  });

  it('codeHashBytes hashes the exact bytes (and agrees with codeHash on UTF-8-clean text)', async () => {
    expect(typeof codeHashBytes).toBe('function');
    expect(await codeHashBytes!(new Uint8Array(LATIN1_ENTRY))).toBe(sha256(LATIN1_ENTRY));
    expect(await codeHashBytes!(new TextEncoder().encode('abc'))).toBe(await pluginsModule.codeHash('abc'));
  });

  it('main’s plugins-read byte path returns the exact file bytes; the text path is unchanged (lossy decode, as v1 has always read)', async () => {
    expect(typeof pluginFiles.readPluginSourceBytes).toBe('function');
    const root = join(tree, 'latin1-root');
    mkdirSync(join(root, 'latin1'), { recursive: true });
    writeFileSync(join(root, 'latin1', 'plugin.json'), JSON.stringify({ name: 'latin1', main: 'main.js' }));
    writeFileSync(join(root, 'latin1', 'main.js'), LATIN1_ENTRY);
    const byBytes = await pluginFiles.readPluginSourceBytes!(root, 'latin1');
    expect(Buffer.from(byBytes!.codeBytes).equals(LATIN1_ENTRY)).toBe(true);
    const byText = await pluginFiles.readPluginSource(root, 'latin1');
    expect(byText!.code).toBe(LATIN1_ENTRY.toString('utf8'));
    expect(byText!.code).toContain('�');
  });

  it('an unchanged Latin-1 entry registers against the raw-byte hash — twice, never an ERR_PLUGIN_CHANGED loop', async () => {
    const hashRaw = sha256(LATIN1_ENTRY);
    const first = await origin.buildPluginRealmSnapshot(dir, 'main.js', { approvedEntryHash: hashRaw });
    expect(first.entrySha256).toBe(hashRaw);
    const second = await origin.buildPluginRealmSnapshot(dir, 'main.js', { approvedEntryHash: hashRaw });
    expect(second.entrySha256).toBe(hashRaw);
    // The OLD canonical form (hash of the lossy decode) must NOT verify:
    // the two sides now hash one form — the raw bytes.
    const lossyHash = sha256(Buffer.from(LATIN1_ENTRY.toString('utf8'), 'utf8'));
    expect(lossyHash).not.toBe(hashRaw);
    await expect(origin.buildPluginRealmSnapshot(dir, 'main.js', { approvedEntryHash: lossyHash })).rejects.toMatchObject({ code: 'ERR_PLUGIN_CHANGED' });
  });

  it('the snapshot serves the raw bytes unchanged', async () => {
    const registry = origin.createPluginRealmRegistry();
    let handler: ((r: { method: string; url: string }) => Promise<Response>) | null = null;
    origin.installAssetHandler({
      protocol: { handle: (_s, fn) => { handler = fn; } },
      net: { fetch: () => Promise.reject(new Error('no bundle fetch in this test')) },
      root: dir,
      pluginRealm: registry,
    });
    registry.register('r2session', await origin.buildPluginRealmSnapshot(dir, 'main.js', { approvedEntryHash: sha256(LATIN1_ENTRY) }));
    const res = await handler!({ method: 'GET', url: 'jcad://app/plugin-realm/r2session/main.js' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(LATIN1_ENTRY)).toBe(true);
    registry.clear();
  });
});

// ------------------------------------------------------------------ R3

describe('R3: cap charged from the pre-read stat; second-pass re-verification', () => {
  it('(a) an over-cap file is refused from its stat size BEFORE it is opened/read', async () => {
    const dir = pkgDir('overcap', {
      'main.js': "import './big.js';\nexport const v = 1;\n",
      'big.js': `export const big = '${'x'.repeat(2048)}';\n`,
    });
    const opened: string[] = [];
    const origOpen = fsp.open as (...args: unknown[]) => Promise<unknown>;
    fsp.open = async (...args: unknown[]) => {
      opened.push(String(args[0]));
      return origOpen(...args);
    };
    try {
      const err = await origin.buildPluginRealmSnapshot(dir, 'main.js', { maxBytes: 1024 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/snapshot exceeds/i);
      expect(opened.filter((p) => p.endsWith('big.js'))).toEqual([]);
    } finally {
      fsp.open = origOpen;
    }
  });

  it('(b) a file swapped MID-WALK aborts the registration with ERR_PLUGIN_CHANGED (no mixed-version snapshot)', async () => {
    const aPath = join(tree, 'midwalk', 'a.js');
    const dir = pkgDir('midwalk', {
      'main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const v = a + b;\n",
      'a.js': "export const a = 'AAAA';\n",
      'b.js': "export const b = 'b';\n",
    });
    let swapped = false;
    const origOpen = fsp.open as (...args: unknown[]) => Promise<unknown>;
    fsp.open = async (...args: unknown[]) => {
      // When the walk reaches b.js, a.js (already snapshotted) changes on
      // disk — same length, different bytes. Only the second pass can
      // catch this; without it a mixed-version snapshot would register.
      if (!swapped && String(args[0]).endsWith('b.js')) {
        swapped = true;
        writeFileSync(aPath, "export const a = 'ZZZZ';\n");
      }
      return origOpen(...args);
    };
    try {
      const err = await origin.buildPluginRealmSnapshot(dir, 'main.js').then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );
      expect(swapped).toBe(true);
      expect(err).toBeInstanceOf(Error);
      expect(err!.code).toBe('ERR_PLUGIN_CHANGED');
    } finally {
      fsp.open = origOpen;
    }
  });

  it('(b) an unchanged package still registers (the second pass is not a false positive)', async () => {
    const dir = pkgDir('stable', {
      'main.js': "import { a } from './a.js';\nexport const v = a;\n",
      'a.js': "export const a = 'AAAA';\n",
    });
    const snap = await origin.buildPluginRealmSnapshot(dir, 'main.js');
    expect([...snap.files.keys()].sort()).toEqual(['a.js', 'main.js']);
  });
});

// ------------------------------------------------------- R2 host end-to-end

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('R2 host path: the trust flow and the serve bridge both hash the raw bytes', () => {
  const hosts: PluginHost[] = [];
  afterEach(() => {
    while (hosts.length) {
      const h = hosts.pop()!;
      for (const p of h.list()) h.unload(p.name);
    }
  });

  it('a Latin-1 folder plugin approves once, loads, and reloads without an ERR_PLUGIN_CHANGED loop', async () => {
    const ed = new Editor(canvas());
    const manifestText = JSON.stringify({ name: 'latin1', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: [] });
    const lossyText = LATIN1_ENTRY.toString('utf8');
    const serveHashes: string[] = [];
    let confirms = 0;
    const storage: StorageLike & { data: Map<string, string> } = {
      data: new Map(),
      getItem: (k) => storage.data.get(k) ?? null,
      setItem: (k, v) => void storage.data.set(k, v),
    };
    const bridge: PluginsBridge = {
      pluginsDir: async () => '/plugins',
      pluginsList: async () => [{ folder: 'latin1', manifest: manifestText }],
      pluginsRead: async () => ({ manifest: manifestText, code: lossyText, codeBytes: new Uint8Array(LATIN1_ENTRY), path: '/plugins/latin1/main.js' }),
      pluginsServeIsolatedPackage: async (_folder: string, approvedEntryHash?: string) => {
        serveHashes.push(approvedEntryHash ?? '');
        return { sessionId: 'r2host', baseUrl: 'jcad://app/plugin-realm/r2host/', entryUrl: 'jcad://app/plugin-realm/r2host/main.js' };
      },
      pluginsUnserveIsolatedPackage: async () => true,
    };
    const loadOnce = async () => {
      const loop = new LoopbackTransport();
      const host = new PluginHost(ed, {
        bridge,
        storage,
        confirm: async () => { confirms += 1; return true; },
        realmTransport: () => loop,
      });
      hosts.push(host);
      const loading = host.loadAll();
      await vi.waitFor(() => expect(loop.inbox.length).toBeGreaterThan(0));
      const hs = loop.handshake() as unknown as Record<string, unknown>;
      loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
      return loading;
    };
    const hashRaw = sha256(LATIN1_ENTRY);
    const first = await loadOnce();
    expect(first.map((p) => `${p.name}:${p.status}`)).toEqual(['latin1:loaded']);
    expect(confirms).toBe(1);
    expect(serveHashes).toEqual([hashRaw]);
    // The remembered trust answer is keyed on the RAW-BYTE hash.
    const trust = JSON.parse(storage.data.get(TRUST_KEY)!) as Record<string, { hash: string }>;
    expect(Object.values(trust)[0]!.hash).toBe(hashRaw);
    // Second load of the UNCHANGED file: remembered, no re-ask, same hash
    // to main — which verifies it against the raw bytes on disk (above).
    const second = await loadOnce();
    expect(second.map((p) => `${p.name}:${p.status}`)).toEqual(['latin1:loaded']);
    expect(confirms).toBe(1);
    expect(serveHashes).toEqual([hashRaw, hashRaw]);
  }, 60_000);
});
