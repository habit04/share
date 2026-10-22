/**
 * P25 CSP hosting amendment (AMENDMENT-P25-CSP-HOSTING) — Part B realm tests.
 *
 * The realm now loads its entry as an ES module: the host hands the realm a
 * module URL in the handshake and the bootstrap `import()`s it — the
 * bootstrap contains NO string evaluation of a plugin body at all (the
 * CSP-CALL-SITE Function-constructor compilation of the CSP-ruling delivery
 * is removed), so the packaged transport can never select a string path
 * (condition C-J1, test-pinned here and in the wiring suite). The session's
 * jcad proxy reaches module code through the one-line `jcad.js` shim
 * (Part B2): parked on the realm global under
 * `Symbol.for('jcad.isolated.jcad')` for exactly the duration of the
 * import, deleted as soon as the import settles; the load report is the
 * module namespace's default export.
 *
 * The Node harness exercises this module path over file:// modules
 * (Part B4) — the same realm path the packaged runtime uses over
 * jcad://app/plugin-realm/<session>/ URLs, not a second one. C-J2: the
 * nonce exchange and session binding are unchanged by the module form —
 * the handshake shape test below pins that the ONLY change is the payload
 * field (`moduleUrl` instead of `code`).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { REALM_BOOTSTRAP_SOURCE } from '../src/app/plugin-isolation/realm-bootstrap';
import { LoopbackTransport, moduleUrlForBody, moduleUrlForModuleText, nodeWorkerTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // same Editor module-graph budget as the sibling suites
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

const sessions: IsolatedPluginSession[] = [];
function session(ed: EditorType, owner: string, capabilities: string[], opts: Partial<{ onDisposed: () => void; transport: unknown }> = {}): IsolatedPluginSession {
  const s = new IsolatedPluginSession(ed, {
    owner,
    capabilities,
    transport: (opts.transport as never) ?? nodeWorkerTransport(),
    loadTimeoutMs: 90_000,
    ...(opts.onDisposed ? { onDisposed: opts.onDisposed } : {}),
  });
  sessions.push(s);
  return s;
}
afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose();
  vi.unstubAllGlobals();
});

const MODULE_PING = `
import jcad from './jcad.js';
const slotAtImport = typeof globalThis[Symbol.for('jcad.isolated.jcad')];
await jcad.commands.register({ name: 'MODPING', run: async (jcad) => {
  const n = (await jcad.document.selection()).length;
  const slotDuringCommand = typeof globalThis[Symbol.for('jcad.isolated.jcad')];
  await jcad.ui.log('mod ping ' + n + ' slot=' + slotDuringCommand);
} });
export default { loaded: true, slotAtImport };
`;

describe('Part B: the realm loads its entry as a module', () => {
  it('a module-authored entry loads: default export is the report, the shim delivers jcad, the slot dies with the import', async () => {
    const ed = makeEditor();
    const s = session(ed, 'mod-ping', ['commands.register', 'document.read', 'ui.log']);
    const report = (await s.loadModule(moduleUrlForModuleText(MODULE_PING))) as { loaded: boolean; slotAtImport: string };
    expect(report.loaded).toBe(true);
    // The B2 handover: during the import the proxy is on the realm global…
    expect(report.slotAtImport).toBe('object');
    expect(ed.commands.has('MODPING')).toBe(true);
    ed.runCommand('MODPING');
    // …and after the import settled it is deleted: command callbacks see no slot.
    await vi.waitFor(() => expect(ed.history.some((l) => l.includes('mod ping 0 slot=undefined'))).toBe(true));
  }, 60_000);

  it('a throwing module fails the load closed and the session is disposed', async () => {
    const ed = makeEditor();
    const s = session(ed, 'mod-boom', []);
    await expect(s.loadModule(moduleUrlForModuleText(`throw new Error('module boom');\n`))).rejects.toThrow(/module boom/);
    expect(s.disposed).toBe(true);
  }, 60_000);

  it('a module whose relative import cannot resolve fails closed', async () => {
    const ed = makeEditor();
    const s = session(ed, 'mod-missing', []);
    await expect(s.loadModule(moduleUrlForModuleText(`import './nope-missing.js';\nexport default {};\n`))).rejects.toThrow(/nope-missing/);
    expect(s.disposed).toBe(true);
  }, 60_000);

  it('body-authored plugins keep working through the harness module wrapper (Part B4)', async () => {
    const ed = makeEditor();
    const s = session(ed, 'mod-body', []);
    const report = (await s.loadModule(moduleUrlForBody(`return { via: 'body', two: 1 + 1 };`))) as { via: string; two: number };
    expect(report).toEqual({ via: 'body', two: 2 });
  }, 60_000);

  it('a handshake without a module URL is refused by the realm itself', async () => {
    const transport = nodeWorkerTransport();
    try {
      const done = new Promise<Record<string, unknown>>((resolve) => {
        transport.onMessage((m) => {
          const msg = m as Record<string, unknown>;
          if (msg && msg.kind === 'load-done') resolve(msg);
        });
      });
      transport.post({ kind: 'handshake', v: 2, session: 'raw-module-1', realmNonce: 'r', hostNonce: 'h', name: 'raw', version: '0' });
      const loadDone = await done;
      expect(loadDone.ok).toBe(false);
      expect(String(loadDone.error)).toMatch(/module/i);
    } finally {
      transport.terminate();
    }
  }, 60_000);
});

describe('C-J1: no string path exists for any transport to select', () => {
  it('the shipped bootstrap source contains no plugin-body string evaluation', () => {
    expect(REALM_BOOTSTRAP_SOURCE).not.toContain('FunctionCtor');
    expect(REALM_BOOTSTRAP_SOURCE).not.toContain('CSP-CALL-SITE');
    expect(REALM_BOOTSTRAP_SOURCE).not.toMatch(/new Function\s*\(/);
    expect(REALM_BOOTSTRAP_SOURCE).not.toContain('msg.code');
    // The module loader is present (as the serialised source's argument
    // expression), and no test-transform helper leaked into the realm code.
    expect(REALM_BOOTSTRAP_SOURCE).toContain('import(');
    expect(REALM_BOOTSTRAP_SOURCE).not.toContain('__vite');
  });

  it('the handshake carries moduleUrl and no code; session + nonce binding are unchanged (C-J2 shape)', async () => {
    const ed = makeEditor();
    const loop = new LoopbackTransport();
    const s = session(ed, 'shape', [], { transport: loop });
    const loading = s.loadModule('file:///p25-entry.mjs');
    const hs = loop.handshake() as unknown as Record<string, unknown>;
    expect(hs.kind).toBe('handshake');
    expect(hs.v).toBe(2);
    expect(hs.moduleUrl).toBe('file:///p25-entry.mjs');
    expect('code' in hs).toBe(false);
    expect(String(hs.session)).toMatch(/^p25-\d+-[0-9a-f]{8}$/);
    expect(String(hs.realmNonce)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(hs.hostNonce)).toMatch(/^[0-9a-f]{32}$/);
    expect(hs.realmNonce).not.toBe(hs.hostNonce);
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
    await expect(loading).resolves.toBeNull();
  }, 60_000);
});

describe('teardown: onDisposed fires exactly once on every dispose path (condition (c), renderer side)', () => {
  it('fires on explicit dispose, and only once', async () => {
    const ed = makeEditor();
    const loop = new LoopbackTransport();
    const onDisposed = vi.fn();
    const s = session(ed, 'td-1', [], { transport: loop, onDisposed });
    const loading = s.loadModule('file:///p25-entry.mjs');
    const hs = loop.handshake();
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
    await loading;
    expect(onDisposed).not.toHaveBeenCalled();
    s.dispose();
    expect(onDisposed).toHaveBeenCalledTimes(1);
    s.dispose();
    expect(onDisposed).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('fires when the load fails (the session disposes itself)', async () => {
    const ed = makeEditor();
    const loop = new LoopbackTransport();
    const onDisposed = vi.fn();
    const s = session(ed, 'td-2', [], { transport: loop, onDisposed });
    const loading = s.loadModule('file:///p25-entry.mjs');
    const hs = loop.handshake();
    loop.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: false, error: 'realm refused' });
    await expect(loading).rejects.toThrow(/realm refused/);
    expect(onDisposed).toHaveBeenCalledTimes(1);
  }, 60_000);
});
