/**
 * PR #38 trust-policy fix (Codex RE-REVIEW of PR #38 at 4fd29d1: the
 * three structural repros are closed, but a P1 pair remains; the lead's
 * ruling, 2026-10-22). ONE PRINCIPLE: every source's trust identity
 * includes its POLICY.
 *
 *  (1) CANONICAL POLICY. One canonical policy value = (isolation mode,
 *      API version, capabilities SORTED), serialised deterministically
 *      as "<isolation>/<apiVersion>/<capabilities>": the capabilities
 *      component is the sorted comma-joined declared set, "" for a
 *      policy-bearing manifest that declares none, and the literal
 *      "legacy" for the implicit manifest of a plain single-JS source —
 *      whose implicit-default policy is therefore exactly
 *      "page/1/legacy". The TRUST KEY = SHA-256 over
 *      "jcad-plugin-trust/2\n" + canonical policy + "\n" + code identity,
 *      for ALL source kinds: the code identity is main's admitted trust
 *      key for an admitted folder package, else the entry hash
 *      (sourceHash). A picked WORKER approval can then never be reused
 *      by the same entry presented as page/API1, and policy-bearing and
 *      legacy sources can never share an approval.
 *  (2) NO entry-hash-only trust path remains: trusted() decides on the
 *      policy key alone. Records written without one (the pre-fix
 *      hash-only form, and the structural-fix form carrying main's
 *      trustKey but no policyKey) ASK ONCE and are REWRITTEN in the new
 *      form; the next load is silent.
 *  (3) REFUSED-LOAD CONSENT. A consent stored by a load attempt that
 *      the host then REFUSES (no realm transport, a realm load failure,
 *      a page plugin whose code throws — and, since 4fd29d1, a serve
 *      that reports the package changed) is dropped: it is never
 *      reused by a later load.
 *  (4) ADMISSION-NULL FAILS CLOSED. When the bridge HAS
 *      pluginsAdmitPackage and it returns null, the load FAILS with an
 *      error naming the admission failure — it never falls back to the
 *      earlier plugins-read package. (A bridge WITHOUT the method —
 *      the plain browser, an older main — keeps the pre-admission flow;
 *      that boundary is pinned here too.)
 *
 * Codex's repro shapes, as relayed by the lead: a picked worker
 * approval reused by the same entry as page/API1; a policy-bearing
 * source and a legacy source sharing an approval; a cached consent
 * from a refused load being reused; an admit-null load falling back to
 * the earlier read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import {
  PluginHost,
  TRUST_KEY,
  canonicalPluginPolicy,
  codeHash,
  sourceFromFiles,
  type PluginSource,
  type PluginTrustDetails,
  type PluginsBridge,
  type StorageLike,
} from '../src/app/plugins';
import { LoopbackTransport } from './plugin-isolation-harness';

const require = createRequire(import.meta.url);

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const trustRecords = (storage: StorageLike & { data: Map<string, string> }) =>
  JSON.parse(storage.data.get(TRUST_KEY) ?? '{}') as Record<string, Record<string, unknown>>;

const hosts: PluginHost[] = [];
afterEach(() => {
  while (hosts.length) {
    const h = hosts.pop()!;
    for (const p of h.list()) h.unload(p.name);
  }
});
function makeHost(opts: ConstructorParameters<typeof PluginHost>[1]): PluginHost {
  const h = new PluginHost(makeEditor(), opts);
  hosts.push(h);
  return h;
}

/** Load through a Loopback realm, completing the handshake the realm posts. */
async function loadViaLoopback(host: PluginHost, loop: LoopbackTransport, src: PluginSource) {
  let settled = false;
  const loading = host.load(src).then((r) => {
    settled = true;
    return r;
  });
  await vi.waitFor(() => { if (!settled) expect(loop.inbox.length).toBeGreaterThan(0); }, { timeout: 15_000 }).catch(() => undefined);
  if (!settled && loop.inbox.length > 0) {
    const hs = loop.handshake();
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
  }
  return loading;
}

const sha256hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The trust-key formula, recomputed independently of the implementation. */
const expectedPolicyKey = (canonical: string, codeIdentity: string) => sha256hex(`jcad-plugin-trust/2\n${canonical}\n${codeIdentity}`);

const WORKER_JSON = (caps: string[]) => JSON.stringify({ name: 'pickw', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: caps });
// A classic body, valid in both forms: the Loopback realm never executes
// it; the page path executes it for real and it registers its command.
const ENTRY = "jcad.commands.register({ name: 'PICKW', run() {} });\n";

// ---------------------------------------------------------------- [T1]

describe('[T1] a picked worker approval is never reused by the same entry as page/API1', () => {
  it('re-asks, flagged as a downgrade, and only then runs in the page', async () => {
    const storage = memoryStorage();
    const seen: Array<PluginTrustDetails | undefined> = [];
    let asks = 0;
    const confirm = async (_n: string, _p: string, details?: PluginTrustDetails) => {
      asks += 1;
      seen.push(details);
      return true;
    };
    // Phase 1: plugin.json + main.js picked together — approved and
    // loaded as an isolated WORKER plugin.
    const loop = new LoopbackTransport();
    const host1 = makeHost({ bridge: null, storage, confirm, realmTransport: () => loop });
    const asWorker = sourceFromFiles([
      { name: 'plugin.json', text: WORKER_JSON([]) },
      { name: 'main.js', text: ENTRY },
    ]);
    expect(asWorker.path).toBe('main.js');
    const first = await loadViaLoopback(host1, loop, asWorker);
    expect(first.status).toBe('loaded');
    expect(asks).toBe(1);
    expect(seen[0]).toEqual({ isolation: 'worker', capabilities: [] });
    // Phase 2: the SAME entry picked alone — a legacy single-JS source
    // (page/API1/legacy). At 4fd29d1 the entry-hash record silently
    // covers this load; the worker approval must never become a page
    // approval: it re-asks, shown as a downgrade, and only the fresh
    // consent runs it in the page.
    const host2 = makeHost({ bridge: null, storage, confirm, realmTransport: () => new LoopbackTransport() });
    const asLegacy = sourceFromFiles([{ name: 'main.js', text: ENTRY }]);
    expect(asLegacy.path).toBe('main.js');
    const second = await host2.load(asLegacy);
    expect(asks).toBe(2);
    expect(seen[1]).toEqual({ isolation: 'page', downgradeFrom: 'worker' });
    expect(second.status).toBe('loaded');
    expect(host2.get('main')?.commands).toContain('PICKW'); // it really ran in the page
  }, 120_000);
});

// ---------------------------------------------------------------- [T2]

describe('[T2] policy-bearing and legacy sources never share an approval', () => {
  it('the same entry, picked once with a policy-bearing plugin.json and once bare, asks for each', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const mk = () => makeHost({ bridge: null, storage, confirm, realmTransport: () => new LoopbackTransport() });
    // Policy-bearing PAGE source: a real plugin.json (declares name,
    // main, apiVersion) with the entry.
    const bearing = sourceFromFiles([
      { name: 'plugin.json', text: JSON.stringify({ name: 'bearp', main: 'main.js', apiVersion: 1 }) },
      { name: 'main.js', text: ENTRY },
    ]);
    expect((await mk().load(bearing)).status).toBe('loaded');
    expect(asks).toBe(1);
    const recBearing = trustRecords(storage)['file:main.js']!;
    expect(recBearing.policyKey).toBe(expectedPolicyKey('page/1/', await codeHash(ENTRY)));
    // The legacy source over the identical entry: a different trust
    // identity — its own question, its own record.
    const legacy = sourceFromFiles([{ name: 'main.js', text: ENTRY }]);
    expect((await mk().load(legacy)).status).toBe('loaded');
    expect(asks).toBe(2);
    const recLegacy = trustRecords(storage)['file:main.js']!;
    expect(recLegacy.policyKey).toBe(expectedPolicyKey('page/1/legacy', await codeHash(ENTRY)));
    expect(recLegacy.policyKey).not.toBe(recBearing.policyKey);
    // And back again: the policy-bearing source's approval was
    // displaced by the legacy record, so it asks for itself too —
    // neither identity ever rides the other's consent.
    expect((await mk().load(bearing)).status).toBe('loaded');
    expect(asks).toBe(3);
  }, 120_000);
});

// ---------------------------------------------------------------- [T3]

describe('[T3] the canonical policy: capabilities sorted — a change re-asks, a reorder does not', () => {
  it('picked worker: a capability added re-asks; the same set reordered in the file does not', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const phase = async (caps: string[]) => {
      const loop = new LoopbackTransport();
      const host = makeHost({ bridge: null, storage, confirm, realmTransport: () => loop });
      const src = sourceFromFiles([
        { name: 'plugin.json', text: WORKER_JSON(caps) },
        { name: 'main.js', text: ENTRY },
      ]);
      expect((await loadViaLoopback(host, loop, src)).status).toBe('loaded');
    };
    await phase(['document.read']);
    expect(asks).toBe(1);
    // A capability ADDED: a different policy — at 4fd29d1 the entry-hash
    // record silently covers this; it must ask.
    await phase(['document.read', 'ui.log']);
    expect(asks).toBe(2);
    // The same set REORDERED in the file: the canonical policy sorts,
    // so this is the same policy — no new question.
    await phase(['ui.log', 'document.read']);
    expect(asks).toBe(2);
    // Canonical serialisation pins (sorted; worker form).
    expect(canonicalPluginPolicy({ name: 'x', main: 'main.js', apiVersion: 2, isolation: 'worker', capabilities: ['ui.log', 'document.read'] })).toBe('worker/2/document.read,ui.log');
  }, 120_000);
});

// ---------------------------------------------------------------- [T4]

describe('[T4] records written without the policy key ask once and are rewritten', () => {
  it('a pre-fix hash-only record: one prompt, the record rewritten in the new form, the next load silent', async () => {
    const storage = memoryStorage();
    // The pre-0134eca record form: an answer + the entry hash, nothing else.
    storage.data.set(TRUST_KEY, JSON.stringify({ 'file:main.js': { answer: 'yes', hash: await codeHash(ENTRY), at: 0 } }));
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const mk = () => makeHost({ bridge: null, storage, confirm, realmTransport: () => new LoopbackTransport() });
    const legacy = sourceFromFiles([{ name: 'main.js', text: ENTRY }]);
    // At 4fd29d1 the hash alone still carries this load — no prompt.
    expect((await mk().load(legacy)).status).toBe('loaded');
    expect(asks).toBe(1);
    const rec = trustRecords(storage)['file:main.js']!;
    expect(rec.policyKey).toBe(expectedPolicyKey('page/1/legacy', await codeHash(ENTRY)));
    // The rewritten record now carries the load silently.
    expect((await mk().load(legacy)).status).toBe('loaded');
    expect(asks).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------- [T5]

describe('[T5] consent from a refused load is not stored or reused', () => {
  it('no realm transport: the refusal drops the consent and the next load asks again', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const src = sourceFromFiles([
      { name: 'plugin.json', text: WORKER_JSON([]) },
      { name: 'main.js', text: ENTRY },
    ]);
    const refused = makeHost({ bridge: null, storage, confirm, realmTransport: () => null });
    const first = await refused.load(src);
    expect(first.status).toBe('error');
    expect(first.error).toMatch(/no isolated realm transport/);
    expect(asks).toBe(1);
    expect(trustRecords(storage)['file:main.js']).toBeUndefined(); // the consent is gone
    // With a transport available the load asks AGAIN (nothing cached to reuse).
    const loop = new LoopbackTransport();
    const host2 = makeHost({ bridge: null, storage, confirm, realmTransport: () => loop });
    expect((await loadViaLoopback(host2, loop, src)).status).toBe('loaded');
    expect(asks).toBe(2);
  }, 120_000);

  it('a realm load failure: the refusal drops the consent', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const src = sourceFromFiles([
      { name: 'plugin.json', text: WORKER_JSON([]) },
      { name: 'main.js', text: ENTRY },
    ]);
    const loop = new LoopbackTransport();
    const host = makeHost({ bridge: null, storage, confirm, realmTransport: () => loop, loadTimeoutMs: 10_000 });
    let settled = false;
    const loading = host.load(src).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => { if (!settled) expect(loop.inbox.length).toBeGreaterThan(0); }, { timeout: 15_000 }).catch(() => undefined);
    const hs = loop.handshake();
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: false, error: 'realm refused the module (capability denial downstream)' });
    const info = await loading;
    expect(info.status).toBe('error');
    expect(asks).toBe(1);
    expect(trustRecords(storage)['file:main.js']).toBeUndefined();
  }, 120_000);

  it('a page plugin whose code throws: the failed load drops the consent and the next load asks again', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const src: PluginSource = {
      manifest: { name: 'thrower', main: 'main.js', apiVersion: 1 },
      code: "throw new Error('boom at load');",
      path: 'thrower.js',
      origin: 'file',
    };
    const mk = () => makeHost({ bridge: null, storage, confirm, realmTransport: () => new LoopbackTransport() });
    expect((await mk().load(src)).status).toBe('error');
    expect(asks).toBe(1);
    expect(trustRecords(storage)['file:thrower.js']).toBeUndefined();
    expect((await mk().load(src)).status).toBe('error');
    expect(asks).toBe(2); // asked again — the refused load's consent was not reused
  }, 120_000);
});

// ------------------------------------------------------------- main side
// The REAL ipc-stores.cjs handlers over a fake Electron shell (the
// plugin-structural-trust.test.ts pattern): [T6] and [T7] need main's
// genuine admission, not a double of it.

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
  invoke(channel: string, ...args: unknown[]): Promise<never>;
  bridge(overrides?: Partial<PluginsBridge>): PluginsBridge;
  writePackage(folder: string, manifest: unknown, entry: string): string;
}
const worlds: string[] = [];
afterAll(() => {
  for (const base of worlds.splice(0)) {
    expect(dirname(resolve(base))).toBe(resolve(tmpdir()));
    expect(basename(base)).toMatch(/^jcad-trustpolicy-/);
    rmSync(base, { recursive: true, force: true });
  }
});
function makeWorld(): World {
  const base = mkdtempSync(join(tmpdir(), 'jcad-trustpolicy-'));
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
    writePackage: (folder, manifest, entry) => {
      const dir = join(pluginsRoot, folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      writeFileSync(join(dir, 'main.js'), entry);
      return dir;
    },
  };
}

// ---------------------------------------------------------------- [T6]

describe('[T6] a structural-fix-era record on an admitted folder asks once and is rewritten', () => {
  it('the record carrying main\'s trustKey but no policy key: one prompt, rewritten, then silent', async () => {
    const w = makeWorld();
    w.writePackage('oldrec', { name: 'oldrec', main: 'main.js', apiVersion: 1 }, "jcad.commands.register({ name: 'OLDREC', run() {} });\n");
    const admission = (await w.invoke('plugins-admit-package', 'oldrec')) as unknown as Admission;
    const storage = memoryStorage();
    const src = await new PluginHost(makeEditor(), { bridge: w.bridge(), storage, confirm: async () => true }).readFolder('oldrec');
    // The 4fd29d1 record form: answer + entry hash + main's trust key + form.
    storage.data.set(TRUST_KEY, JSON.stringify({
      [`folder:${src.path}`]: { answer: 'yes', hash: admission.entrySha256, trustKey: admission.trustKey, form: 'page', at: 0 },
    }));
    let asks = 0;
    const confirm = async () => {
      asks += 1;
      return true;
    };
    const mk = () => makeHost({ bridge: w.bridge(), storage, confirm, realmTransport: () => new LoopbackTransport() });
    const host1 = mk();
    // At 4fd29d1 the trustKey match alone carries this load — no prompt.
    expect((await host1.load(await host1.readFolder('oldrec'))).status).toBe('loaded');
    expect(asks).toBe(1);
    const rec = trustRecords(storage)[`folder:${src.path}`]!;
    expect(rec.policyKey).toBe(expectedPolicyKey('page/1/', admission.trustKey));
    expect(rec.trustKey).toBe(admission.trustKey); // main's key stays bound for the serve
    const host2 = mk();
    expect((await host2.load(await host2.readFolder('oldrec'))).status).toBe('loaded');
    expect(asks).toBe(1); // the rewritten record carries the next load silently
  }, 120_000);
});

// ---------------------------------------------------------------- [T7]

describe('[T7] admission-null fails closed; an absent admission method keeps the old flow', () => {
  it('bridge present + pluginsAdmitPackage null: an admission error, no fallback to the earlier read, no prompt, no execution', async () => {
    const w = makeWorld();
    w.writePackage('nullpkg', { name: 'nullpkg', main: 'main.js', apiVersion: 1 }, "jcad.commands.register({ name: 'NULLPKG', run() {} });\n");
    const storage = memoryStorage();
    let asks = 0;
    let readsDuringLoad = 0;
    const bridge = w.bridge({
      pluginsAdmitPackage: (async () => null) as PluginsBridge['pluginsAdmitPackage'],
      pluginsRead: (async (folder: string) => {
        readsDuringLoad += 1;
        return w.invoke('plugins-read', folder);
      }) as PluginsBridge['pluginsRead'],
    });
    const ed = makeEditor();
    const host = new PluginHost(ed, { bridge, storage, confirm: async () => { asks += 1; return true; }, realmTransport: () => new LoopbackTransport() });
    hosts.push(host);
    // The caller's own discovery read builds the source (as readFolder does).
    const src = await host.readFolder('nullpkg');
    readsDuringLoad = 0;
    // At 4fd29d1 this load falls back to the read package and RUNS it.
    const info = await host.load(src);
    expect(info.status).toBe('error');
    expect(info.error).toMatch(/admission/i);
    expect(asks).toBe(0); // trust is never reached
    expect(readsDuringLoad).toBe(0); // and the earlier read is never re-consulted
    expect(ed.commands.has('NULLPKG')).toBe(false); // nothing executed
  }, 120_000);

  it('bridge WITHOUT pluginsAdmitPackage: the folder load keeps the pre-admission flow (the boundary)', async () => {
    const w = makeWorld();
    w.writePackage('oldmain', { name: 'oldmain', main: 'main.js', apiVersion: 1 }, "jcad.commands.register({ name: 'OLDMAIN', run() {} });\n");
    const storage = memoryStorage();
    const bridge = w.bridge();
    delete (bridge as Partial<PluginsBridge>).pluginsAdmitPackage;
    let asks = 0;
    const host = makeHost({
      bridge,
      storage,
      confirm: async () => { asks += 1; return true; },
      realmTransport: () => new LoopbackTransport(),
    });
    const info = await host.load(await host.readFolder('oldmain'));
    expect(info.status).toBe('loaded');
    expect(asks).toBe(1);
    expect(host.get('oldmain')?.commands).toContain('OLDMAIN');
    // The record it wrote is in the new form (the policy key governs here too).
    const rec = Object.values(trustRecords(storage))[0]!;
    expect(rec.policyKey).toBe(expectedPolicyKey('page/1/', await codeHash("jcad.commands.register({ name: 'OLDMAIN', run() {} });\n")));
  }, 120_000);
});
