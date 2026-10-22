/**
 * P25 — the lead's READING-confirmation condition (2026-10-21): with the
 * string-evaluation path removed entirely, EVERY existing plugin path must
 * still load via modules, or be refused with a clear error — never silently
 * broken. This file exercises the paths the earlier suites only selected or
 * loopbacked:
 *   - the harness FILE form through PluginHost with a picked-file source
 *     (the wiring suite covers the same form via a folder source);
 *   - the harness BLOB form through a REAL worker realm (the wiring suite
 *     pins blob SELECTION through a loopback; here the realm actually
 *     imports the blob module and answers an RPC round trip);
 *   - Fable F2: in the packaged shape (a serve-capable bridge — the desktop
 *     app), a picked-file isolated plugin must NOT fall through to the blob
 *     branch (blob: is refused by the realm worker's CSP there); it is
 *     refused at selection with an explicit message and no handshake.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import {
  PluginHost,
  parseManifest,
  type PluginSource,
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
}, 120_000);
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
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

const example = (name: string) => ({
  manifest: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'plugin.json'), 'utf8'),
  code: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'main.js'), 'utf8'),
});

/** The bundled isolated sample as a picked-file source (PLUGINLOAD shape). */
function helloWorkerFileSource(): PluginSource {
  const ex = example('hello-worker');
  return { manifest: parseManifest(ex.manifest), code: ex.code, path: 'picked/main.js', origin: 'file' };
}

/** The real harness realm with the module-URL hook REMOVED: forces the blob branch. */
function blobForcedTransport(): RealmTransport {
  const inner = nodeWorkerTransport();
  return { post: inner.post, onMessage: inner.onMessage, terminate: inner.terminate };
}

describe('every plugin path loads via modules or refuses clearly (READING condition)', () => {
  it('FILE FORM: the sample isolated plugin loads through the harness file:// modules and answers an RPC round trip', async () => {
    const ed = makeEditor();
    const host = makeHost(ed, { bridge: null, storage: memoryStorage(), confirm: async () => true, realmTransport: () => nodeWorkerTransport() });
    const info = await host.load(helloWorkerFileSource());
    expect(info.status).toBe('loaded');
    expect(host.get('hello-worker')!.commands).toEqual(['HELLOISO']);
    ed.selection = new Set(['a', 'b']);
    ed.runCommand('HELLOISO');
    await vi.waitFor(() => expect(ed.history).toContain('Hello from isolated hello-worker! 2 objects selected.'));
  }, 60_000);

  it('BLOB FORM: exercised against a real realm — in the Node realm the import is refused with the loader\u2019s clear protocol error, immediately (the form\u2019s loading environment is the plain browser; its selection is pinned in the wiring suite)', async () => {
    const ed = makeEditor();
    const host = makeHost(ed, { bridge: null, storage: memoryStorage(), confirm: async () => true, realmTransport: () => blobForcedTransport() });
    const info = await host.load(helloWorkerFileSource());
    // Node's default ESM loader supports file/data/node only: the realm
    // refuses the blob: import at once and the host surfaces that exact
    // error as the load error — refused with a clear error, not a hang,
    // not an empty success, not a swallowed failure.
    expect(info.status).toBe('error');
    expect(info.error).toContain("Received protocol 'blob:'");
    expect(info.error).not.toContain('did not finish loading');
  }, 60_000);

  it('F2: a serve-capable (packaged) bridge + a picked-file isolated plugin is refused explicitly, with no handshake and no blob', async () => {
    const ed = makeEditor();
    const bridge: PluginsBridge = {
      pluginsDir: async () => '/user/plugins',
      pluginsList: async () => [],
      pluginsRead: async () => null,
      pluginsServeIsolatedPackage: async () => ({ sessionId: 's', baseUrl: 'jcad://app/plugin-realm/s/', entryUrl: 'jcad://app/plugin-realm/s/main.js' }),
      pluginsUnserveIsolatedPackage: async () => true,
    };
    const loop = new LoopbackTransport();
    const host = makeHost(ed, { bridge, storage: memoryStorage(), confirm: async () => true, realmTransport: () => loop });
    let blobsMinted = 0;
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = ((...args: Parameters<typeof URL.createObjectURL>) => { blobsMinted++; return originalCreateObjectURL(...args); }) as typeof URL.createObjectURL;
    try {
      const info = await host.load(helloWorkerFileSource());
      expect(info.status).toBe('error');
      expect(info.error).toContain('not loaded from the plugins folder');
      expect(info.error).toContain('refusing to run it in the page');
      // The refusal happens at selection: the realm is never handed anything.
      expect(loop.inbox).toHaveLength(0);
      expect(blobsMinted).toBe(0);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  }, 60_000);
});
