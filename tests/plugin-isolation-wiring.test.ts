/**
 * P25 slice 2 — PluginHost wiring tests (PROPOSAL-P25 admitted, LEDGER L-011).
 *
 * Everything here goes through the PUBLIC surface: `parseManifest` and
 * `PluginHost.load` / `loadAll` / `unload` / `reload`. The isolated realm is
 * the real Node worker transport from the slice-1 harness (or the loopback
 * transport when the test must play the realm endpoint itself). Conditions
 * under test, from L-011: C1 (only plugins.ts wiring; api.ts untouched —
 * asserted indirectly: every path below is v1's own host), C2 (fail-closed:
 * no transport / invalid manifest => load ERROR, the code never runs in the
 * page), C3 (the trust decision for a worker plugin carries its declared
 * capabilities + isolated status; legacy prompts see no such details),
 * C4 (this file), C6 (packaged-Electron enablement is out of scope here;
 * nothing in this file touches Electron).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import {
  PluginHost,
  TRUST_KEY,
  parseManifest,
  type PluginManifest,
  type PluginSource,
  type PluginTrustDetails,
  type PluginsBridge,
  type StorageLike,
} from '../src/app/plugins';
import type { RealmTransport } from '../src/app/plugin-isolation/host';
import { LoopbackTransport, nodeWorkerTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // the Editor module graph import exceeds the 10 s default hook timeout on a loaded 2-CPU box (slice-1 control fact)
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());
const tick = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** plugins/<folder>/{plugin.json, main.js} held in memory, like the main-process handlers. */
function fakeBridge(folders: Record<string, { manifest: string | null; code?: string }>): PluginsBridge & { folders: typeof folders } {
  return {
    folders,
    pluginsDir: async () => '/user/plugins',
    pluginsList: async () => Object.entries(folders).map(([folder, f]) => (f.manifest === null ? { folder, manifest: null, error: 'no plugin.json' } : { folder, manifest: f.manifest })),
    pluginsRead: async (folder) => {
      const f = folders[folder];
      if (!f || f.manifest === null) return null;
      return { manifest: f.manifest, code: f.code ?? '', path: `/user/plugins/${folder}/main.js` };
    },
  };
}

const manifest = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '1.0.0', main: 'main.js', ...extra });
const workerManifest = (name: string, capabilities: string[]) => manifest(name, { apiVersion: 2, isolation: 'worker', capabilities });
const example = (name: string) => ({
  manifest: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'plugin.json'), 'utf8'),
  code: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'main.js'), 'utf8'),
});

/** A real worker realm transport that records whether the host terminated it. */
function trackedNodeTransport(): RealmTransport & { terminated: boolean } {
  const inner = nodeWorkerTransport();
  const t: RealmTransport & { terminated: boolean } = {
    terminated: false,
    post: (m) => inner.post(m),
    onMessage: (cb) => inner.onMessage(cb),
    terminate: () => {
      t.terminated = true;
      inner.terminate();
    },
  };
  return t;
}

const hosts: PluginHost[] = [];
function makeHost(ed: EditorType, opts: ConstructorParameters<typeof PluginHost>[1]): PluginHost {
  const h = new PluginHost(ed, opts);
  hosts.push(h);
  return h;
}
afterEach(() => {
  while (hosts.length) {
    const h = hosts.pop()!;
    for (const p of h.list()) h.unload(p.name);
  }
  vi.unstubAllGlobals();
});

/** Registers ISOADD: one transact adding a text + a line (one undo step), then logs. */
const ISO_PLUGIN = `
  await jcad.commands.register({
    name: 'ISOADD',
    description: 'adds a marker text and a line in one transaction',
    run: async (jcad) => {
      await jcad.document.transact(async () => {
        await jcad.document.add({ type: 'text', position: { x: 5, y: 6 }, text: 'iso marker' });
        await jcad.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
      });
      await jcad.ui.log('iso added');
    },
  });
`;
const ISO_CAPS = ['document.write', 'document.transact', 'commands.register', 'ui.log'];

describe('parseManifest: isolated-manifest fields (L-011 admitted semantics)', () => {
  it('leaves a legacy manifest byte-identical: no isolation/capabilities keys appear', () => {
    expect(parseManifest(manifest('ok'))).toEqual({ name: 'ok', main: 'main.js', apiVersion: 1, version: '1.0.0' });
  });

  it('parses a worker manifest and preserves the declared fields', () => {
    const m = parseManifest(workerManifest('iso', ['document.read', 'ui.log']));
    expect(m.isolation).toBe('worker');
    expect(m.capabilities).toEqual(['document.read', 'ui.log']);
    expect(m.apiVersion).toBe(2);
  });

  it('accepts an explicit "page" isolation with no capabilities', () => {
    const m = parseManifest(manifest('plain', { isolation: 'page' }));
    expect(m.isolation).toBe('page');
    expect(m.capabilities).toBeUndefined();
  });

  it('rejects an unknown capability (fail-closed)', () => {
    expect(() => parseManifest(workerManifest('iso', ['document.read', 'teleport']))).toThrow(/unknown plugin capability "teleport"/);
  });

  it('rejects capabilities on the page path (a declaration v1 would silently ignore)', () => {
    expect(() => parseManifest(manifest('sneaky', { capabilities: ['document.read'] }))).toThrow(/"capabilities" requires "isolation": "worker"/);
    expect(() => parseManifest(manifest('sneaky', { isolation: 'page', capabilities: [] }))).toThrow(/"capabilities" requires "isolation": "worker"/);
  });

  it('rejects a worker manifest without apiVersion 2', () => {
    expect(() => parseManifest(manifest('iso', { isolation: 'worker', capabilities: [] }))).toThrow(/must declare "apiVersion": 2/);
    expect(() => parseManifest(manifest('iso', { apiVersion: 3, isolation: 'worker', capabilities: [] }))).toThrow(/must declare "apiVersion": 2/);
  });

  it('rejects a worker manifest without a capabilities array', () => {
    expect(() => parseManifest(manifest('iso', { apiVersion: 2, isolation: 'worker' }))).toThrow(/must declare "capabilities"/);
    expect(() => parseManifest(manifest('iso', { apiVersion: 2, isolation: 'worker', capabilities: 'document.read' }))).toThrow(/must be an array/);
  });

  it('rejects an unknown isolation value', () => {
    expect(() => parseManifest(manifest('iso', { isolation: 'sandbox' }))).toThrow(/"isolation" must be "page" or "worker"/);
  });
});

describe('PluginHost: isolated (worker) wiring', () => {
  it('loads a worker plugin into the realm; its command does mediated work as ONE undo step', async () => {
    const ed = makeEditor();
    const transports: Array<RealmTransport & { terminated: boolean }> = [];
    const host = makeHost(ed, {
      bridge: fakeBridge({ iso: { manifest: workerManifest('iso', ISO_CAPS), code: ISO_PLUGIN } }),
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => {
        const t = trackedNodeTransport();
        transports.push(t);
        return t;
      },
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['iso:loaded']);
    expect(host.get('iso')!.commands).toEqual(['ISOADD']);
    expect(ed.commands.has('ISOADD')).toBe(true);
    ed.runCommand('ISOADD');
    await vi.waitFor(() => expect(ed.history).toContain('iso added'));
    expect(ed.doc.entities.filter((e) => e.type === 'text' && e.text === 'iso marker')).toHaveLength(1);
    expect(ed.doc.entities).toHaveLength(2);
    // The realm transact crossed as one batch: a single undo removes both entities.
    expect(ed.doc.undo()).toBe(true);
    expect(ed.doc.entities).toHaveLength(0);
    expect(transports).toHaveLength(1);
    expect(transports[0]!.terminated).toBe(false); // still loaded; unload terminates it (next test)
  }, 60_000);

  it('unload terminates the realm and revokes its commands; reload starts a fresh realm', async () => {
    const ed = makeEditor();
    const transports: Array<RealmTransport & { terminated: boolean }> = [];
    const host = makeHost(ed, {
      bridge: fakeBridge({ iso: { manifest: workerManifest('iso', ISO_CAPS), code: ISO_PLUGIN } }),
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => {
        const t = trackedNodeTransport();
        transports.push(t);
        return t;
      },
    });
    await host.loadAll();
    expect(ed.commands.has('ISOADD')).toBe(true);
    const reloaded = await host.reload('iso');
    expect(reloaded.map((p) => p.status)).toEqual(['loaded']);
    expect(transports).toHaveLength(2);
    expect(transports[0]!.terminated).toBe(true); // the replaced realm was terminated, not leaked
    expect(ed.commands.has('ISOADD')).toBe(true);
    expect(host.unload('iso')).toBe(true);
    expect(transports[1]!.terminated).toBe(true);
    expect(ed.commands.has('ISOADD')).toBe(false);
    expect(host.get('iso')).toBeUndefined();
  }, 60_000);

  it('fails closed when no realm transport is available: load ERROR, page evaluator never invoked', async () => {
    const ed = makeEditor();
    const evaluate = vi.fn(async () => undefined);
    // No realmTransport option: in this Node environment the default factory finds
    // no platform Worker, so no realm can be created (the packaged-Electron case
    // is the lead's gate, C6 — this asserts the fail-closed half only).
    const host = makeHost(ed, {
      bridge: fakeBridge({ iso: { manifest: workerManifest('iso', ISO_CAPS), code: ISO_PLUGIN } }),
      storage: memoryStorage(),
      confirm: async () => true,
      evaluate,
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['iso:error']);
    expect(out[0]!.error).toMatch(/isolated/i);
    expect(evaluate).not.toHaveBeenCalled();
    expect(ed.commands.has('ISOADD')).toBe(false);
    expect(ed.doc.entities).toHaveLength(0);
  }, 60_000);

  it('refuses invalid isolated manifests at load (programmatic sources bypassing parseManifest)', async () => {
    const ed = makeEditor();
    const confirm = vi.fn(async () => true);
    const evaluate = vi.fn(async () => undefined);
    const realmTransport = vi.fn(() => trackedNodeTransport());
    const host = makeHost(ed, { bridge: null, storage: memoryStorage(), confirm, evaluate, realmTransport });
    const src = (m: PluginManifest): PluginSource => ({ manifest: m, code: ISO_PLUGIN, path: 'picked/main.js', origin: 'file' });
    const badCap = await host.load(src({ name: 'badcap', apiVersion: 2, isolation: 'worker', capabilities: ['teleport'] }));
    expect(badCap.status).toBe('error');
    expect(badCap.error).toMatch(/unknown plugin capability "teleport"/);
    const wrongVersion = await host.load(src({ name: 'wrongver', apiVersion: 1, isolation: 'worker', capabilities: [] }));
    expect(wrongVersion.status).toBe('error');
    expect(wrongVersion.error).toMatch(/must declare "apiVersion": 2/);
    const pageCaps = await host.load(src({ name: 'pagecaps', apiVersion: 1, isolation: 'page', capabilities: ['document.read'] }));
    expect(pageCaps.status).toBe('error');
    expect(pageCaps.error).toMatch(/"capabilities" requires "isolation": "worker"/);
    // Refusal is atomic and happens before trust, transport creation or any execution.
    expect(confirm).not.toHaveBeenCalled();
    expect(realmTransport).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(ed.doc.entities).toHaveLength(0);
  }, 60_000);

  it('drops forged messages at the host boundary and answers authenticated-but-undeclared calls with a denial', async () => {
    const ed = makeEditor();
    const loop = new LoopbackTransport();
    const host = makeHost(ed, {
      bridge: null,
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => loop,
    });
    const src: PluginSource = {
      manifest: { name: 'loopy', apiVersion: 2, isolation: 'worker', capabilities: [] },
      code: '/* the test plays the realm endpoint */',
      path: 'picked/main.js',
      origin: 'file',
    };
    const loading = host.load(src);
    await vi.waitFor(() => expect(loop.inbox.length).toBeGreaterThan(0));
    const hs = loop.handshake();
    // Forged load-done (wrong nonce): dropped, load does not complete.
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: 'forged-nonce', ok: true, report: null });
    await tick();
    expect(ed.history.some((l) => l.includes('isolated RPC forged'))).toBe(true);
    // Forged RPC (wrong nonce): dropped, never answered, drawing untouched.
    const inboxBefore = loop.inbox.length;
    loop.emit({ kind: 'rpc', v: 2, session: hs.session, nonce: 'forged-nonce', id: 'x1', method: 'document.add', args: [{ type: 'text', position: { x: 1, y: 1 }, text: ' forged ' }] });
    await tick();
    expect(loop.inbox.length).toBe(inboxBefore);
    expect(ed.doc.entities).toHaveLength(0);
    // The genuine load-done completes the load.
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
    const info = await loading;
    expect(info.status).toBe('loaded');
    // Authenticated but undeclared (capabilities []): answered with a denial, still no effect.
    loop.emit({ kind: 'rpc', v: 2, session: hs.session, nonce: hs.realmNonce, id: 'x2', method: 'document.add', args: [{ type: 'text', position: { x: 1, y: 1 }, text: 'nope' }] });
    await vi.waitFor(() => expect(loop.inbox.some((m) => (m as { kind?: string }).kind === 'rpc-res')).toBe(true));
    const res = loop.inbox.find((m) => (m as { kind?: string }).kind === 'rpc-res') as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('denied');
    expect(ed.doc.entities).toHaveLength(0);
    expect(ed.doc.dirty).toBe(false);
  }, 60_000);

  it('treats messages on a disposed session transport as stale: dropped, logged, never answered', async () => {
    const ed = makeEditor();
    const loop = new LoopbackTransport();
    const host = makeHost(ed, {
      bridge: null,
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => loop,
    });
    const src: PluginSource = {
      manifest: { name: 'stale', apiVersion: 2, isolation: 'worker', capabilities: ['document.read'] },
      code: '/* loopback realm */',
      path: 'picked/main.js',
      origin: 'file',
    };
    const loading = host.load(src);
    await vi.waitFor(() => expect(loop.inbox.length).toBeGreaterThan(0));
    const hs = loop.handshake();
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
    expect((await loading).status).toBe('loaded');
    expect(host.unload('stale')).toBe(true);
    expect(loop.terminated).toBe(true);
    // A late message from the dead realm (even correctly nonced for its dead session) is stale.
    const inboxBefore = loop.inbox.length;
    loop.emit({ kind: 'rpc', v: 2, session: hs.session, nonce: hs.realmNonce, id: 'late1', method: 'document.entities', args: [null] });
    await tick();
    expect(loop.inbox.length).toBe(inboxBefore);
    expect(ed.history.some((l) => l.includes('isolated RPC stale-session'))).toBe(true);
  }, 60_000);

  it('a worker plugin that never finishes loading errors and its realm is terminated', async () => {
    const ed = makeEditor();
    const transports: Array<RealmTransport & { terminated: boolean }> = [];
    const host = makeHost(ed, {
      bridge: fakeBridge({ hang: { manifest: workerManifest('hang', []), code: 'return new Promise(() => {});' } }),
      storage: memoryStorage(),
      confirm: async () => true,
      loadTimeoutMs: 300,
      realmTransport: () => {
        const t = trackedNodeTransport();
        transports.push(t);
        return t;
      },
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['hang:error']);
    expect(out[0]!.error).toMatch(/did not finish loading/);
    expect(transports[0]!.terminated).toBe(true);
    expect(ed.doc.entities).toHaveLength(0);
  }, 60_000);
});

describe('PluginHost: trust prompt details (C3) and the E-10 flow', () => {
  it('passes the declared capabilities + isolated status to the trust decision for worker plugins only', async () => {
    const ed = makeEditor();
    const seen: Array<{ name: string; details: PluginTrustDetails | undefined }> = [];
    const confirm = async (name: string, _path: string, details?: PluginTrustDetails) => {
      seen.push({ name, details });
      return true;
    };
    const host = makeHost(ed, {
      bridge: fakeBridge({
        iso: { manifest: workerManifest('iso', ISO_CAPS), code: ISO_PLUGIN },
        plain: { manifest: manifest('plain'), code: "jcad.commands.register({ name: 'PLAIN', run() {} });" },
      }),
      storage: memoryStorage(),
      confirm,
      realmTransport: () => trackedNodeTransport(),
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`).sort()).toEqual(['iso:loaded', 'plain:loaded']);
    const isoAsk = seen.find((s) => s.name === 'iso');
    expect(isoAsk?.details).toEqual({ isolation: 'worker', capabilities: ISO_CAPS });
    const plainAsk = seen.find((s) => s.name === 'plain');
    expect(plainAsk?.details).toBeUndefined(); // legacy prompt input is exactly as v1
  }, 60_000);

  it('remembers worker-plugin trust by code hash (E-10): asked once, asked again when the code changes', async () => {
    const storage = memoryStorage();
    let asks = 0;
    const confirm = async () => (asks++, true);
    const bridge = fakeBridge({ iso: { manifest: workerManifest('iso', ISO_CAPS), code: ISO_PLUGIN } });
    const mk = () => makeHost(makeEditor(), { bridge, storage, confirm, realmTransport: () => trackedNodeTransport() });
    await mk().loadAll();
    expect(asks).toBe(1);
    expect(JSON.parse(storage.data.get(TRUST_KEY)!)['folder:/user/plugins/iso/main.js'].answer).toBe('yes');
    await mk().loadAll();
    expect(asks).toBe(1); // remembered, no second question
    bridge.folders.iso = { ...bridge.folders.iso!, code: `${ISO_PLUGIN}\n// v2` };
    await mk().loadAll();
    expect(asks).toBe(2); // changed code: asked again
  }, 60_000);

  it('a legacy plugin still takes the page path when a realm transport factory exists (no silent sandboxing)', async () => {
    const ed = makeEditor();
    const realmTransport = vi.fn(() => trackedNodeTransport());
    const host = makeHost(ed, {
      bridge: fakeBridge({ plain: { manifest: manifest('plain'), code: "jcad.commands.register({ name: 'PLAIN', run(j) { j.ui.log('plain ran'); } });" } }),
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport,
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['plain:loaded']);
    expect(realmTransport).not.toHaveBeenCalled();
    ed.runCommand('PLAIN');
    await vi.waitFor(() => expect(ed.history).toContain('plain ran'));
  }, 60_000);
});

describe('acceptance F-1/F-2, through the public PluginHost path', () => {
  // The failing-first regressions live at session level in
  // tests/plugin-isolation-regressions.test.ts (committed before the fix);
  // these cases prove the same dispositions hold when the realm is reached
  // through PluginHost.load, the path production plugins actually take.
  it('F-1: a loaded worker plugin finds no CommonJS identifiers and cannot read host files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-p25-wire-'));
    const sentinelPath = join(dir, 'sentinel.txt');
    writeFileSync(sentinelPath, 'P25-SENTINEL-HOST-FILE', 'utf8');
    try {
      const ed = makeEditor();
      const code = `
        const types = {};
        for (const k of ['module', 'exports', '__filename', '__dirname']) types[k] = eval('typeof ' + k);
        let fs = 'not-attempted';
        try { fs = 'READ:' + String(module.require('node:fs').readFileSync(${JSON.stringify(sentinelPath)}, 'utf8')); }
        catch { fs = 'threw'; }
        await jcad.ui.log('f1-cjs:' + JSON.stringify(types) + ' fs:' + fs);
      `;
      const host = makeHost(ed, {
        bridge: fakeBridge({ f1: { manifest: workerManifest('f1', ['ui.log']), code } }),
        storage: memoryStorage(),
        confirm: async () => true,
        realmTransport: () => trackedNodeTransport(),
      });
      const out = await host.loadAll();
      expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['f1:loaded']);
      const line = ed.history.find((l) => l.includes('f1-cjs:'));
      expect(line).toContain('"module":"undefined"');
      expect(line).toContain('"exports":"undefined"');
      expect(line).toContain('"__filename":"undefined"');
      expect(line).toContain('"__dirname":"undefined"');
      expect(line).toContain('fs:threw');
      expect(ed.history.join('\n')).not.toContain('P25-SENTINEL-HOST-FILE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('F-2: non-stageable calls inside transact are refused through the host path too', async () => {
    const ed = makeEditor();
    const code = `
      let errA = 'none';
      try {
        await jcad.document.transact(async () => {
          await jcad.settings.set('plugin:inside', 'persisted');
          await jcad.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
          await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: -5 });
        });
      } catch (e) { errA = String((e && e.message) || e); }
      const after = await jcad.settings.get('plugin:inside');
      await jcad.ui.log('f2-settings err=' + errA + ' after=' + String(after));
      await jcad.document.add({ type: 'line', a: { x: 2, y: 2 }, b: { x: 3, y: 3 } });
      let errB = 'none';
      try {
        await jcad.document.transact(async () => {
          await jcad.document.undo();
          await jcad.document.add({ type: 'line', a: { x: 4, y: 4 }, b: { x: 5, y: 5 } });
          await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: -5 });
        });
      } catch (e) { errB = String((e && e.message) || e); }
      await jcad.ui.log('f2-undo err=' + errB);
    `;
    const host = makeHost(ed, {
      bridge: fakeBridge({
        f2: {
          manifest: workerManifest('f2', ['document.read', 'document.write', 'document.transact', 'settings.own', 'settings.read', 'ui.log']),
          code,
        },
      }),
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => trackedNodeTransport(),
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['f2:loaded']);
    const settingsLine = ed.history.find((l) => l.includes('f2-settings'));
    expect(settingsLine).toContain('cannot run inside document.transact');
    expect(settingsLine).toContain('after=null');
    const undoLine = ed.history.find((l) => l.includes('f2-undo'));
    expect(undoLine).toContain('cannot run inside document.transact');
    // Only the one legitimate line exists: neither transact changed anything.
    expect(ed.doc.entities).toHaveLength(1);
  }, 60_000);
});

describe('example isolated plugin', () => {
  it('hello-worker loads through the public path and its command reports the selection from the realm', async () => {
    const ed = makeEditor();
    const host = makeHost(ed, {
      bridge: fakeBridge({ 'hello-worker': example('hello-worker') }),
      storage: memoryStorage(),
      confirm: async () => true,
      realmTransport: () => trackedNodeTransport(),
    });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`)).toEqual(['hello-worker:loaded']);
    expect(host.get('hello-worker')!.commands).toEqual(['HELLOISO']);
    ed.selection = new Set(['a', 'b']);
    ed.runCommand('HELLOISO');
    await vi.waitFor(() => expect(ed.history).toContain('Hello from isolated hello-worker! 2 objects selected.'));
  }, 60_000);
});
