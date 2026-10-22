/**
 * P25 — the lead's CSP ruling (2026-10-21) as realm-level tests.
 *
 * The ruling: NO 'unsafe-eval' anywhere in the packaged renderer and no
 * widening of the page CSP; the isolated realm lives in a dedicated worker
 * served with the path-scoped worker CSP (electron/renderer-origin.cjs
 * WORKER_CSP, `script-src 'self' 'wasm-unsafe-eval'`). Under that policy the
 * platform refuses every string compilation in the worker. These tests pin
 * the realm's own half of that posture, in the Node worker_threads realm
 * (which has no CSP): `eval` and the `Function` constructor, as reachable
 * through the realm's globals, must be refused by the bootstrap itself —
 * so the refusal is a property of the realm, not only of one serving
 * context — while an ordinary worker plugin still loads and answers RPC
 * round trips. Since AMENDMENT-P25-CSP-HOSTING the realm loads its entry
 * as a module (no plugin-body call site exists); the packaged-Electron
 * proof is scripts/e2e-plugin-csp.mjs and remains the lead's Windows
 * gate item.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { moduleUrlForBody, nodeWorkerTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // same Editor module-graph budget as the acceptance suite
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

const sessions: IsolatedPluginSession[] = [];
function session(ed: EditorType, owner: string, capabilities: string[]): IsolatedPluginSession {
  const s = new IsolatedPluginSession(ed, { owner, capabilities, transport: nodeWorkerTransport(), loadTimeoutMs: 90_000 });
  sessions.push(s);
  return s;
}
afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose();
  vi.unstubAllGlobals();
});

/** Every string-evaluation form the ruling names, attempted from plugin code. */
const EVAL_PROBE = `
  const attempt = (fn) => { try { return 'ran:' + String(fn()); } catch (e) { return 'refused:' + (e && e.message ? e.message : String(e)); } };
  const out = {};
  out.directEval = attempt(() => eval('40 + 2'));
  out.indirectEval = attempt(() => (0, eval)('40 + 2'));
  out.globalEval = attempt(() => globalThis.eval('40 + 2'));
  out.functionCtor = attempt(() => new Function('return 42')());
  out.functionCall = attempt(() => Function('return 42')());
  out.globalFunction = attempt(() => globalThis.Function('return 42')());
  return out;
`;

/** Nested-worker forms the Fable F3 finding names, attempted from plugin code. */
const WORKER_PROBE = `
  const attempt = (fn) => { try { return 'ran:' + String(fn()); } catch (e) { return 'refused:' + (e && e.message ? e.message : String(e)); } };
  const out = {};
  out.workerCtor = attempt(() => new Worker('https://example.invalid/nested.js'));
  out.workerCall = attempt(() => Worker('https://example.invalid/nested.js'));
  out.sharedWorkerCtor = attempt(() => new SharedWorker('https://example.invalid/nested.js'));
  out.globalWorkerCtor = attempt(() => new globalThis.Worker('https://example.invalid/nested.js'));
  out.selectionCount = (await jcad.document.selection()).length;
  return out;
`;

describe('P25 Fable F3: nested workers are refused in the isolated realm', () => {
  it('Worker and SharedWorker are locked to throwing stubs at handshake; the realm still loads and RPCs', async () => {
    const ed = makeEditor();
    const s = session(ed, 'csp-worker-probe', ['document.read']);
    const report = (await s.loadModule(moduleUrlForBody(WORKER_PROBE))) as Record<string, unknown>;
    for (const form of ['workerCtor', 'workerCall', 'sharedWorkerCtor', 'globalWorkerCtor']) {
      expect(String(report[form]), form).toMatch(/^refused:/);
      expect(String(report[form]), form).toContain('not available in the isolated plugin realm');
    }
    expect(report.selectionCount).toBe(0); // a document.read RPC round trip after stubbing
  }, 60_000);
});

/** Storage surfaces the Fable INFO item names, probed from plugin code. */
const STORAGE_PROBE = `
  const out = {};
  out.indexedDBType = typeof indexedDB;
  out.indexedDBLocked = Object.prototype.hasOwnProperty.call(globalThis, 'indexedDB');
  out.cachesType = typeof caches;
  out.cachesLocked = Object.prototype.hasOwnProperty.call(globalThis, 'caches');
  out.selectionCount = (await jcad.document.selection()).length;
  return out;
`;

describe('P25 Fable INFO: realm storage surfaces are stubbed away', () => {
  it('indexedDB and caches are locked to undefined at handshake; the realm still loads and RPCs', async () => {
    const ed = makeEditor();
    const s = session(ed, 'csp-storage-probe', ['document.read']);
    const report = (await s.loadModule(moduleUrlForBody(STORAGE_PROBE))) as Record<string, unknown>;
    // Unusable in the realm (in a browser worker these are real objects
    // on the app origin; the lock shadows them with undefined)…
    expect(report.indexedDBType).toBe('undefined');
    expect(report.cachesType).toBe('undefined');
    // …and locked by the bootstrap, not merely absent in this realm:
    // hardenGlobals defines both as own properties of the realm global.
    expect(report.indexedDBLocked).toBe(true);
    expect(report.cachesLocked).toBe(true);
    expect(report.selectionCount).toBe(0); // a document.read RPC round trip after stubbing
  }, 60_000);
});

describe('P25 CSP ruling: string evaluation in the isolated realm', () => {
  it('eval and new Function are refused in the plugin context (realm globals)', async () => {
    const ed = makeEditor();
    const s = session(ed, 'csp-probe', []);
    const report = (await s.loadModule(moduleUrlForBody(EVAL_PROBE))) as Record<string, string>;
    for (const form of ['directEval', 'indirectEval', 'globalEval', 'functionCtor', 'functionCall', 'globalFunction']) {
      expect(report[form], form).toMatch(/^refused:/);
      expect(report[form], form).not.toContain('ran:');
    }
    // The refuser is the realm's own stub, not an incidental engine error.
    expect(report.directEval).toContain('not available in the isolated plugin realm');
    expect(report.functionCtor).toContain('not available in the isolated plugin realm');
  }, 60_000);

  it('a worker-isolated plugin still loads and answers an RPC round trip', async () => {
    const ed = makeEditor();
    const s = session(ed, 'csp-worker-bee', ['commands.register', 'document.read', 'ui.log']);
    const code = `
      jcad.commands.register({ name: 'CSPPING', description: 'answers a ping through the RPC channel', run: async (jcad) => {
        const n = (await jcad.document.selection()).length;
        await jcad.ui.log('csp ping ' + n);
      } });
      const selectedAtLoad = (await jcad.document.selection()).length;
      return { registered: true, selectedAtLoad };
    `;
    const report = (await s.loadModule(moduleUrlForBody(code))) as { registered: boolean; selectedAtLoad: number };
    expect(report.registered).toBe(true);
    expect(report.selectedAtLoad).toBe(0); // a document.read RPC round trip at load time
    ed.runCommand('CSPPING');
    await vi.waitFor(() => expect(ed.history.some((l) => l.startsWith('csp ping'))).toBe(true));
  }, 60_000);
});
