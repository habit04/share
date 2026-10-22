/**
 * PR #38 structural fix (Codex RE-REVIEW of PR #38 at 0134eca: the three
 * original repros are closed, but two P1 bypasses + one P2 remain; the
 * lead's ruling, 2026-10-22). Root cause, in the lead's words: trust is
 * keyed on the ENTRY hash only, and the applied policy comes from a
 * DIFFERENT READ than the hashed one, checked in only one of the two
 * load paths. These tests pin the structural fix, not per-path patches:
 *
 *  (1) ONE ADMISSION READ. Main reads plugin.json bytes + entry (+ the
 *      graph, for the worker form) once and computes a single TRUST KEY
 *      = SHA-256 over "jcad-plugin-trust/1\n" + the plugin.json byte
 *      length in decimal + "\n" + the EXACT plugin.json bytes + "\n" +
 *      the form material (the snapshot manifest hash for the worker
 *      form, the entry-bytes SHA-256 for the page form). It returns the
 *      parsed policy FROM THOSE SAME BYTES together with the key; the
 *      renderer applies only that returned policy and never uses an
 *      earlier plugins-read manifest for policy.
 *  (2) trusted() compares the remembered approval against the FULL
 *      trust key, BEFORE the page/worker path is chosen. Any change in
 *      isolation mode, API version, capabilities or code re-asks. A
 *      worker->page downgrade is always a fresh consent, shown
 *      explicitly in the prompt (details { isolation: 'page',
 *      downgradeFrom: 'worker' }).
 *  (3) First approval: the key shown is the key remembered is the key
 *      applied — the serve is rejected when the snapshot's key differs
 *      from the admitted key.
 *  (4) P2 (host.ts): the 32-grant quota counts only LIVE unredeemed,
 *      unexpired grants; redeemed grants move to a separate bounded
 *      (256) single-use tombstone LRU, so replay refusal survives
 *      without eating the live quota.
 *
 * Codex's two P1 repros, reconstructed from the lead's description (no
 * review text is in the repo) and pinned here:
 *  (i) HIGH-READ/RESTORE-LOW, both directions: the renderer's earlier
 *      plugins-read reports a HIGHER policy than the package on disk
 *      holds at admission (or the reverse) — the prompt and the applied
 *      policy must be the DISK (admitted) policy in both directions,
 *      never the stale read's.
 *  (ii) WORKER->PAGE DOWNGRADE with a dual-valid source: a folder
 *      approved as an isolated worker plugin whose plugin.json is then
 *      replaced by a manifest that is fully valid as a page plugin
 *      (apiVersion 1, no isolation, no capabilities) with the entry
 *      byte-identical — at 0134eca the entry-keyed approval silently
 *      runs it in the page; here it must re-ask, flagged as a downgrade.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import { PluginHost, TRUST_KEY, type PluginTrustDetails, type PluginsBridge, type StorageLike } from '../src/app/plugins';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { LoopbackTransport, moduleUrlForBody, nodeWorkerTransport } from './plugin-isolation-harness';

const require = createRequire(import.meta.url);

interface Snapshot { manifestSha256: string; pluginJsonSha256?: string }
interface Registry {
  register(sessionId: string, snapshot: unknown, owner?: unknown, expectedGeneration?: number): boolean;
  unregister(sessionId: string, owner?: unknown): boolean;
  clear(): void;
  lookup(sessionId: string): unknown;
  generation(): number;
}
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const origin = require('../electron/renderer-origin.cjs') as {
  createPluginRealmRegistry(): Registry;
  buildPluginRealmSnapshot(root: string, entry: string, options?: Record<string, unknown>): Promise<Snapshot>;
};
const { createPathPolicy, guardIpc } = require('../electron/ipc-guard.cjs') as {
  createPathPolicy(options: unknown): unknown;
  guardIpc(raw: unknown, options: unknown): { handle(channel: string, handler: Handler): void };
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** The trust-key formula, recomputed independently of the implementation. */
const expectedTrustKey = (pluginJsonBytes: Buffer, materialHex: string) =>
  createHash('sha256')
    .update(Buffer.from(`jcad-plugin-trust/1\n${pluginJsonBytes.length}\n`, 'utf8'))
    .update(pluginJsonBytes)
    .update('\n', 'utf8')
    .update(materialHex, 'utf8')
    .digest('hex');

const worlds: string[] = [];
afterAll(() => {
  for (const base of worlds.splice(0)) {
    expect(dirname(resolve(base))).toBe(resolve(tmpdir()));
    expect(basename(base)).toMatch(/^jcad-structural-/);
    rmSync(base, { recursive: true, force: true });
  }
});

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

// ------------------------------------------------------------- main side
// The REAL ipc-stores.cjs handlers over a fake Electron shell (the
// plugin-files.test.ts pattern), with a real realm registry in ctx.
// One world per test: its own state dir, its own plugins root, so a
// loadAll in one test can never see another test's packages.

interface Admission {
  trustKey: string;
  form: 'worker' | 'page';
  manifest: string;
  code: string;
  codeBytes?: Uint8Array;
  path: string;
  entrySha256?: string;
  manifestHash?: string;
}
interface World {
  base: string;
  pluginsRoot: string;
  pluginRealm: Registry;
  invoke(channel: string, ...args: unknown[]): Promise<never>;
  bridge(overrides?: Partial<PluginsBridge>): PluginsBridge;
  writePackage(folder: string, manifest: unknown, entry: string, extra?: Record<string, string>): string;
}
function makeWorld(): World {
  const base = mkdtempSync(join(tmpdir(), 'jcad-structural-'));
  worlds.push(base);
  const pluginsRoot = join(base, 'plugins');
  mkdirSync(pluginsRoot, { recursive: true });
  const handlers = new Map<string, Handler>();
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const webContents = { mainFrame: frame };
  const win = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  const reject = vi.fn();
  const policy = createPathPolicy({ isKnownPath: () => false, knownPaths: () => [], log: { reject } });
  const ipc = guardIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject } },
  );
  const url = new URL('../electron/main/ipc-stores.cjs', import.meta.url);
  const sourceRequire = createRequire(url);
  const module = { exports: {} as { registerStoreIpc(ctx: unknown): void } };
  new Function('require', 'module', readFileSync(url, 'utf8'))(
    (name: string) =>
      name === 'electron'
        ? { dialog: {} }
        : name === './app-data.cjs'
          ? { stateDir: () => base, autosaveDir: () => join(base, 'autosave'), enqueueWrite: (_file: string, work: () => unknown) => work() }
          : sourceRequire(name),
    module,
  );
  const pluginRealm = origin.createPluginRealmRegistry();
  module.exports.registerStoreIpc({ ipcMain: ipc, pathPolicy: policy, senderWindow: () => win, pluginRealm });
  const invoke = (channel: string, ...args: unknown[]): Promise<never> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no IPC handler registered for "${channel}"`);
    return h(event, ...args) as Promise<never>;
  };
  return {
    base,
    pluginsRoot,
    pluginRealm,
    invoke,
    bridge: (overrides: Partial<PluginsBridge> = {}) =>
      ({
        pluginsDir: async () => pluginsRoot,
        pluginsList: () => invoke('plugins-list'),
        pluginsRead: (folder: string) => invoke('plugins-read', folder),
        pluginsAdmitPackage: (folder: string) => invoke('plugins-admit-package', folder) as Promise<Admission | null>,
        pluginsServeIsolatedPackage: (folder: string, entryHash?: string, manifestHash?: string, trustKey?: string) =>
          invoke('plugins-serve-isolated', folder, entryHash, manifestHash, trustKey),
        pluginsUnserveIsolatedPackage: (sessionId: string) => invoke('plugins-unserve-isolated', sessionId),
        ...overrides,
      }) as unknown as PluginsBridge,
    writePackage: (folder, manifest, entry, extra = {}) => {
      const dir = join(pluginsRoot, folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      writeFileSync(join(dir, 'main.js'), entry);
      for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
      return dir;
    },
  };
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const storage: StorageLike & { data: Map<string, string> } = {
    data: new Map(),
    getItem: (k) => storage.data.get(k) ?? null,
    setItem: (k, v) => void storage.data.set(k, v),
  };
  return storage;
}
const trustRecord = (storage: StorageLike & { data: Map<string, string> }) => {
  const raw = storage.data.get(TRUST_KEY);
  if (!raw) return null;
  const entries = Object.values(JSON.parse(raw) as Record<string, Record<string, unknown>>);
  return entries.length ? entries[0]! : null;
};

const hosts: PluginHost[] = [];
afterEach(() => {
  while (hosts.length) {
    const h = hosts.pop()!;
    for (const p of h.list()) h.unload(p.name);
  }
});
/** One loadAll through a fresh host + Loopback transport, settling the realm handshake when one is posted. */
async function loadOnce(bridge: PluginsBridge, storage: StorageLike, confirm: (name: string, path: string, details?: PluginTrustDetails) => Promise<boolean>) {
  const ed = new Editor(canvas());
  const loop = new LoopbackTransport();
  const host = new PluginHost(ed, { bridge, storage, confirm, realmTransport: () => loop });
  hosts.push(host);
  let settled = false;
  const loading = host.loadAll().then((r) => {
    settled = true;
    return r;
  });
  await vi.waitFor(() => { if (!settled) expect(loop.inbox.length).toBeGreaterThan(0); }, { timeout: 15_000 }).catch(() => undefined);
  if (!settled && loop.inbox.length > 0) {
    const hs = loop.handshake() as unknown as Record<string, unknown>;
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
  }
  return loading;
}

const workerManifest = (name: string, capabilities: string[], extra: Record<string, unknown> = {}) => ({
  name, main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities, ...extra,
});
const MODULE_ENTRY = "import jcad from './jcad.js';\nexport default { ok: true };\n";

// ------------------------------------------------------------------ [S1]

describe('[S1] the admission read: one read, one key, the policy from the same bytes', () => {
  it('worker form: the key covers the exact plugin.json bytes + the snapshot manifest; the returned bytes are the disk bytes', async () => {
    const w = makeWorld();
    const dir = w.writePackage('adm-w', workerManifest('admw', []), "import jcad from './jcad.js';\nimport { v } from './lib.js';\nexport default { v };\n", {
      'lib.js': 'export const v = 1;\n',
    });
    const a = (await w.invoke('plugins-admit-package', 'adm-w')) as unknown as Admission;
    expect(a.form).toBe('worker');
    const pluginJsonBytes = readFileSync(join(dir, 'plugin.json'));
    expect(a.manifest).toBe(pluginJsonBytes.toString('utf8'));
    expect(Buffer.from(a.codeBytes!).toString('utf8')).toBe(readFileSync(join(dir, 'main.js'), 'utf8'));
    const snap = await origin.buildPluginRealmSnapshot(realpathSync(dir), 'main.js');
    expect(a.manifestHash).toBe(snap.manifestSha256);
    expect(a.trustKey).toBe(expectedTrustKey(pluginJsonBytes, snap.manifestSha256));
    // Unchanged package, admitted again: the identical key.
    const again = (await w.invoke('plugins-admit-package', 'adm-w')) as unknown as Admission;
    expect(again.trustKey).toBe(a.trustKey);
    // A dependency-only change moves the key (the manifest is the material).
    writeFileSync(join(dir, 'lib.js'), 'export const v = 2;\n');
    const changed = (await w.invoke('plugins-admit-package', 'adm-w')) as unknown as Admission;
    expect(changed.trustKey).not.toBe(a.trustKey);
    writeFileSync(join(dir, 'lib.js'), 'export const v = 1;\n');
    const restored = (await w.invoke('plugins-admit-package', 'adm-w')) as unknown as Admission;
    expect(restored.trustKey).toBe(a.trustKey);
  });

  it('page form: the key covers the exact plugin.json bytes + the entry bytes hash', async () => {
    const w = makeWorld();
    const dir = w.writePackage('adm-p', { name: 'admp', main: 'main.js', apiVersion: 1 }, "jcad.commands.register({ name: 'ADMP', run() {} });\n");
    const a = (await w.invoke('plugins-admit-package', 'adm-p')) as unknown as Admission;
    expect(a.form).toBe('page');
    const pluginJsonBytes = readFileSync(join(dir, 'plugin.json'));
    const entryBytes = readFileSync(join(dir, 'main.js'));
    expect(a.entrySha256).toBe(sha256(entryBytes));
    expect(a.trustKey).toBe(expectedTrustKey(pluginJsonBytes, sha256(entryBytes)));
    expect(a.manifestHash).toBeUndefined();
  });

  it('a folder without plugin.json admits as null (not a folder package)', async () => {
    const w = makeWorld();
    mkdirSync(join(w.pluginsRoot, 'adm-none'), { recursive: true });
    writeFileSync(join(w.pluginsRoot, 'adm-none', 'main.js'), 'void 0;\n');
    await expect(w.invoke('plugins-admit-package', 'adm-none')).resolves.toBeNull();
  });
});

// ------------------------------------------------------------------ [S2]

describe('[S2] worker->page downgrade with a dual-valid source: fresh consent, shown as a downgrade', () => {
  // The entry is byte-identical across both phases and valid in both
  // forms: a classic body (the Loopback realm never executes the served
  // module; the page path executes the classic body for real).
  const ENTRY = "jcad.commands.register({ name: 'DGPROBE', run() {} });\n";

  it('re-asks with the downgrade flagged, and only then runs in the page', async () => {
    const w = makeWorld();
    const dir = w.writePackage('dg', workerManifest('dg', []), ENTRY);
    const storage = memoryStorage();
    const seen: Array<{ name: string; details: PluginTrustDetails | undefined }> = [];
    const confirm = async (name: string, _path: string, details?: PluginTrustDetails) => {
      seen.push({ name, details });
      return true;
    };
    // Phase 1: approved and loaded as an isolated worker plugin.
    const first = await loadOnce(w.bridge(), storage, confirm);
    expect(first.map((p) => `${p.name}:${p.status}`)).toEqual(['dg:loaded']);
    expect(seen).toEqual([{ name: 'dg', details: { isolation: 'worker', capabilities: [] } }]);
    // Phase 2: plugin.json becomes a fully valid PAGE manifest; the
    // entry does not change by one byte. The entry-keyed approval must
    // NOT silently become page execution.
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'dg', main: 'main.js', apiVersion: 1 }));
    const second = await loadOnce(w.bridge(), storage, confirm);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ name: 'dg', details: { isolation: 'page', downgradeFrom: 'worker' } });
    expect(second.map((p) => `${p.name}:${p.status}`)).toEqual(['dg:loaded']);
    // It really ran in the page now (the classic body registered its command).
    expect(hosts.at(-1)!.get('dg')?.commands).toContain('DGPROBE');
  }, 120_000);

  it('a declined downgrade never runs in the page', async () => {
    const w = makeWorld();
    const dir = w.writePackage('dg2', workerManifest('dg2', []), ENTRY.replace('DGPROBE', 'DG2PROBE'));
    const storage = memoryStorage();
    let asks = 0;
    const first = await loadOnce(w.bridge(), storage, async () => {
      asks += 1;
      return true;
    });
    expect(first.map((p) => `${p.name}:${p.status}`)).toEqual(['dg2:loaded']);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'dg2', main: 'main.js', apiVersion: 1 }));
    const second = await loadOnce(w.bridge(), storage, async () => {
      asks += 1;
      return false; // the downgrade prompt is DECLINED
    });
    expect(asks).toBe(2); // the downgrade was actually asked about
    expect(second.map((p) => `${p.name}:${p.status}`)).toEqual(['dg2:declined']);
    expect(hosts.at(-1)!.get('dg2')?.commands ?? []).not.toContain('DG2PROBE');
  }, 120_000);
});

// ------------------------------------------------------------------ [S3]

describe('[S3] high-read/restore-low, both directions: the admitted (disk) policy governs, never the earlier read', () => {
  const readSwapping = (w: World, manifestText: string): Partial<PluginsBridge> => ({
    pluginsRead: (async (folder: string) => {
      const r = (await w.invoke('plugins-read', folder)) as unknown as { manifest: string } | null;
      return r ? { ...r, manifest: manifestText } : r;
    }) as PluginsBridge['pluginsRead'],
  });

  it('read HIGH, disk LOW: the prompt shows the disk capabilities ([]), not the read\'s ([document.write])', async () => {
    const w = makeWorld();
    w.writePackage('hlow', workerManifest('hlow', []), MODULE_ENTRY);
    const storage = memoryStorage();
    const seen: Array<PluginTrustDetails | undefined> = [];
    const bridge = w.bridge(readSwapping(w, JSON.stringify(workerManifest('hlow', ['document.write']))));
    const out = await loadOnce(bridge, storage, async (_n, _p, details) => {
      seen.push(details);
      return true;
    });
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['hlow:loaded']);
    expect(seen).toEqual([{ isolation: 'worker', capabilities: [] }]);
  }, 120_000);

  it('read LOW, disk HIGH: the prompt shows the disk capabilities ([document.write]), not the read\'s ([])', async () => {
    const w = makeWorld();
    w.writePackage('hhigh', workerManifest('hhigh', ['document.write']), MODULE_ENTRY);
    const storage = memoryStorage();
    const seen: Array<PluginTrustDetails | undefined> = [];
    const bridge = w.bridge(readSwapping(w, JSON.stringify(workerManifest('hhigh', []))));
    const out = await loadOnce(bridge, storage, async (_n, _p, details) => {
      seen.push(details);
      return true;
    });
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['hhigh:loaded']);
    expect(seen).toEqual([{ isolation: 'worker', capabilities: ['document.write'] }]);
  }, 120_000);
});

// ------------------------------------------------------------------ [S4]

describe('[S4] the served snapshot must carry the admitted key (ruling 3)', () => {
  it('the serve handler rejects a wrong admitted key with ERR_PLUGIN_CHANGED and accepts the admitted one', async () => {
    const w = makeWorld();
    const dir = w.writePackage('keypkg', workerManifest('keypkg', []), MODULE_ENTRY);
    const a = (await w.invoke('plugins-admit-package', 'keypkg')) as unknown as Admission;
    const entryHash = sha256(readFileSync(join(dir, 'main.js')));
    await expect(w.invoke('plugins-serve-isolated', 'keypkg', entryHash, undefined, 'f'.repeat(64))).rejects.toThrow(/ERR_PLUGIN_CHANGED/);
    const served = (await w.invoke('plugins-serve-isolated', 'keypkg', entryHash, undefined, a.trustKey)) as unknown as { sessionId: string; trustKey?: string };
    expect(served.trustKey).toBe(a.trustKey);
    expect(w.pluginRealm.lookup(served.sessionId)).toBeDefined();
    await w.invoke('plugins-unserve-isolated', served.sessionId);
  });

  it('a package changed between the admission read and the serve fails the load closed', async () => {
    const w = makeWorld();
    const dir = w.writePackage('keypkg', workerManifest('keypkg', []), "import jcad from './jcad.js';\nimport { v } from './lib.js';\nexport default { v };\n", {
      'lib.js': 'export const v = 1;\n',
    });
    const storage = memoryStorage();
    let asks = 0;
    const bridge = w.bridge({
      pluginsAdmitPackage: (async (folder: string) => {
        const a = (await w.invoke('plugins-admit-package', folder)) as unknown as Admission | null;
        // The package changes AFTER the admission read, BEFORE the serve.
        writeFileSync(join(dir, 'lib.js'), 'export const v = 2;\n');
        return a;
      }) as PluginsBridge['pluginsAdmitPackage'],
    });
    const out = await loadOnce(bridge, storage, async () => {
      asks += 1;
      return true;
    });
    expect(asks).toBe(1); // consent was given for the ADMITTED package
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['keypkg:error']);
    expect(out[0]!.error).toMatch(/changed/i);
    expect(trustRecord(storage)).toBeNull(); // the approval was forgotten, not applied to the changed package
  }, 120_000);
});

// ------------------------------------------------------------------ [S5]

describe('[S5] ordinary-change control: unchanged loads silently; any single-field change re-asks', () => {
  it('the control sequence', async () => {
    const w = makeWorld();
    const dir = w.writePackage('ctl', workerManifest('ctl', []), MODULE_ENTRY);
    const storage = memoryStorage();
    const seen: Array<PluginTrustDetails | undefined> = [];
    const confirm = async (_n: string, _p: string, details?: PluginTrustDetails) => {
      seen.push(details);
      return true;
    };
    const load = () => loadOnce(w.bridge(), storage, confirm);
    // First approval.
    expect((await load()).map((p) => p.status)).toEqual(['loaded']);
    expect(seen).toHaveLength(1);
    // Unchanged: remembered, no re-ask.
    expect((await load()).map((p) => p.status)).toEqual(['loaded']);
    expect(seen).toHaveLength(1);
    // A plugin.json-only change (a description): re-asks, then loads.
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(workerManifest('ctl', [], { description: 'v2 notes' })));
    expect((await load()).map((p) => p.status)).toEqual(['loaded']);
    expect(seen).toHaveLength(2);
    // An entry byte change: re-asks.
    writeFileSync(join(dir, 'main.js'), `${MODULE_ENTRY}// v2\n`);
    expect((await load()).map((p) => p.status)).toEqual(['loaded']);
    expect(seen).toHaveLength(3);
    // A capability added: re-asks, with the new set in the prompt.
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(workerManifest('ctl', ['ui.log'], { description: 'v2 notes' })));
    expect((await load()).map((p) => p.status)).toEqual(['loaded']);
    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toEqual({ isolation: 'worker', capabilities: ['ui.log'] });
  }, 120_000);
});

// ------------------------------------------------------------------ [S6]

describe('[S6] the grant quota counts only LIVE grants; redeemed grants move to a bounded tombstone LRU', () => {
  const sessions: IsolatedPluginSession[] = [];
  afterEach(() => {
    while (sessions.length) sessions.pop()!.dispose();
  });
  function grantSession(ed: EditorType): IsolatedPluginSession {
    const s = new IsolatedPluginSession(ed, {
      owner: 'grantor',
      capabilities: ['files.read'],
      transport: nodeWorkerTransport(),
      loadTimeoutMs: 90_000,
      pickTextFile: async () => ({ name: 'note.txt', text: 'grant me' }),
    });
    sessions.push(s);
    return s;
  }

  it('40 sequential redeemed reads succeed (at 0134eca the 33rd mint fails on quota)', async () => {
    const ed = new Editor(canvas());
    const s = grantSession(ed);
    const r = (await s.loadModule(moduleUrlForBody(`
      let ok = 0; let failed = 0; let lastId = '';
      for (let i = 0; i < 40; i++) {
        try {
          const g = await jcad.files.requestRead('.txt');
          const f = await jcad.files.readGrant(g.grant);
          if (f.text !== 'grant me') throw new Error('bad grant text');
          lastId = g.grant;
          ok++;
        } catch { failed++; }
      }
      const replay = await jcad.files.readGrant(lastId).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
      return { ok, failed, replay };
    `))) as { ok: number; failed: number; replay: string };
    expect(r).toEqual({ ok: 40, failed: 0, replay: 'denied:grant-used' });
  }, 120_000);

  it('replay refusal survives redemption, bounded: the 257th-oldest tombstone is evicted, recent ones still refuse as used', async () => {
    const ed = new Editor(canvas());
    const s = grantSession(ed);
    const r = (await s.loadModule(moduleUrlForBody(`
      const ids = [];
      for (let i = 0; i < 260; i++) {
        const g = await jcad.files.requestRead('.txt');
        await jcad.files.readGrant(g.grant);
        ids.push(g.grant);
      }
      const first = await jcad.files.readGrant(ids[0]).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
      const last = await jcad.files.readGrant(ids[259]).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
      return { count: ids.length, first, last };
    `))) as { count: number; first: string; last: string };
    expect(r.count).toBe(260);
    expect(r.first).toBe('denied:unknown-grant'); // evicted from the 256-entry tombstone LRU: still refused, as unknown
    expect(r.last).toBe('denied:grant-used'); // a recent tombstone still names the replay as a replay
  }, 120_000);

  it('32 live unredeemed grants still exhaust the quota; redeeming one frees it immediately', async () => {
    const ed = new Editor(canvas());
    const s = grantSession(ed);
    const r = (await s.loadModule(moduleUrlForBody(`
      const ids = [];
      for (let i = 0; i < 32; i++) {
        const g = await jcad.files.requestRead('.txt');
        ids.push(g.grant);
      }
      let mintError = '';
      try { await jcad.files.requestRead('.txt'); } catch (e) { mintError = e.message ?? 'error'; }
      const f = await jcad.files.readGrant(ids[0]);
      let after = '';
      try { const g = await jcad.files.requestRead('.txt'); after = 'minted:' + (typeof g.grant === 'string'); }
      catch (e) { after = 'refused:' + (e.message ?? 'error'); }
      return { minted: ids.length, mintError, redeemed: f.text, after };
    `))) as { minted: number; mintError: string; redeemed: string; after: string };
    expect(r.minted).toBe(32);
    expect(r.mintError).toMatch(/too many outstanding file grants/);
    expect(r.redeemed).toBe('grant me');
    expect(r.after).toBe('minted:true');
  }, 120_000);
});

// ------------------------------------------------------------ source pins

describe('structural-fix wiring pins', () => {
  it('the preload exposes the admission bridge and passes the admitted key to the serve', () => {
    const preload = readFileSync('electron/preload.cjs', 'utf8');
    expect(preload).toContain("pluginsAdmitPackage: (folder) => ipcRenderer.invoke('plugins-admit-package', folder)");
    expect(preload).toContain(
      "pluginsServeIsolatedPackage: (folder, approvedEntryHash, approvedManifestHash, admittedTrustKey) => ipcRenderer.invoke('plugins-serve-isolated', folder, approvedEntryHash, approvedManifestHash, admittedTrustKey)",
    );
  });

  it('the store IPC registers the admission handler beside the serve handler', () => {
    const ipc = readFileSync('electron/main/ipc-stores.cjs', 'utf8');
    expect(ipc).toContain("ipcMain.handle('plugins-admit-package', async (_ev, folder) => {");
    expect(ipc).toContain("ipcMain.handle('plugins-serve-isolated', async (ev, folder, approvedEntryHash, approvedManifestHash, admittedTrustKey) => {");
  });
});
