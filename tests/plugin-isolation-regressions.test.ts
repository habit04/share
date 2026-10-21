/**
 * P25 slice-2 regressions — FAILING-FIRST tests for the two findings the
 * independent slice-1 acceptance FAILED (reviews/P25-SLICE1-ACCEPTANCE.md):
 *
 *   F-1 (CRITICAL, sandbox escape): hardenGlobals() did not lock the
 *       CommonJS identifiers module/exports/__filename/__dirname. Under the
 *       Node worker_threads realm they are own properties of globalThis, so
 *       plugin code with ZERO capabilities could call
 *       module.require('node:fs') and read host files verbatim.
 *   F-2 (MODERATE, atomicity): inside document.transact, only
 *       add/replace/remove + electrical.setAttributes were staged; every
 *       other mutating call (settings.set, document.undo, ...) executed as
 *       an immediate RPC and survived a batch rollback, contradicting
 *       PLUGIN-ISOLATION.md §3 / T9. The fix refuses non-stageable mutating
 *       calls while a transact callback is active (fail-closed).
 *
 * Plus the slice-1 task judge's watch item: the host nonce fell back to
 * Math.random when WebCrypto was absent. The nonces authenticate every
 * realm message, so minting them must fail closed instead.
 *
 * The realm under test is the real Node worker realm (same harness and
 * Editor setup as tests/plugin-isolation-acceptance.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { nodeWorkerTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // Editor graph import exceeds the 10 s default on this loaded box (same justification as the acceptance suite)

const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());
const entityCount = (ed: EditorType) => [...ed.doc.entities.values()].length;

const SENTINEL = 'P25-SENTINEL-HOST-FILE';
let sentinelDir = '';
let sentinelPath = '';
beforeAll(() => {
  sentinelDir = mkdtempSync(join(tmpdir(), 'jcad-p25-'));
  sentinelPath = join(sentinelDir, 'sentinel.txt');
  writeFileSync(sentinelPath, SENTINEL, 'utf8');
});
afterAll(() => {
  if (sentinelDir) rmSync(sentinelDir, { recursive: true, force: true });
});

describe('F-1: CommonJS identifiers are locked in the realm', () => {
  it('plugin code cannot reach module/exports/__filename/__dirname or read host files', async () => {
    const ed = makeEditor();
    const session = new IsolatedPluginSession(ed, {
      owner: 'f1-probe',
      capabilities: [],
      transport: nodeWorkerTransport(),
      loadTimeoutMs: 60_000,
    });
    try {
      const report = (await session.load(`
        const out = { cjs: {} };
        for (const k of ['module', 'exports', '__filename', '__dirname', 'process', 'require', 'Buffer']) {
          out.cjs[k] = eval('typeof ' + k);
        }
        let fsRead = 'not-attempted';
        try {
          const fs = module.require('node:fs');
          fsRead = 'READ:' + String(fs.readFileSync(${JSON.stringify(sentinelPath)}, 'utf8'));
        } catch (e) {
          fsRead = 'threw:' + (e && e.constructor ? e.constructor.name : typeof e);
        }
        out.fsRead = fsRead;
        let cp = 'not-attempted';
        try {
          cp = 'LOADED:' + typeof module.constructor._load('node:child_process').execSync;
        } catch (e) {
          cp = 'threw:' + (e && e.constructor ? e.constructor.name : typeof e);
        }
        out.cp = cp;
        return out;
      `)) as { cjs: Record<string, string>; fsRead: string; cp: string };
      // The four CJS identifiers join the already-locked globals.
      expect(report.cjs.module).toBe('undefined');
      expect(report.cjs.exports).toBe('undefined');
      expect(report.cjs.__filename).toBe('undefined');
      expect(report.cjs.__dirname).toBe('undefined');
      expect(report.cjs.process).toBe('undefined');
      expect(report.cjs.require).toBe('undefined');
      expect(report.cjs.Buffer).toBe('undefined');
      // And the acceptance owner's exact escapes no longer work.
      expect(report.fsRead.startsWith('threw:')).toBe(true);
      expect(report.fsRead).not.toContain(SENTINEL);
      expect(report.cp.startsWith('threw:')).toBe(true);
    } finally {
      session.dispose();
    }
  }, 60_000);
});

describe('F-2: transact refuses non-stageable mutating calls', () => {
  it('a settings.set inside a rolled-back transact does not persist', async () => {
    const ed = makeEditor();
    const session = new IsolatedPluginSession(ed, {
      owner: 'f2-settings',
      capabilities: ['document.write', 'document.transact', 'settings.own', 'settings.read'],
      transport: nodeWorkerTransport(),
      loadTimeoutMs: 60_000,
    });
    try {
      const report = (await session.load(`
        let err = null;
        try {
          await jcad.document.transact(async () => {
            await jcad.settings.set('plugin:inside', 'persisted');
            await jcad.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
            await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: -5 });
          });
        } catch (e) { err = String((e && e.message) || e); }
        return { err, after: await jcad.settings.get('plugin:inside') };
      `)) as { err: string | null; after?: unknown };
      // The refusal (fail-closed) is what ends the transaction...
      expect(report.err).toMatch(/cannot run inside document\.transact/);
      // ...and nothing persisted: the setting was never written.
      expect(report.after ?? null).toBeNull();
      // The staged document change was discarded with the transaction.
      expect(entityCount(ed)).toBe(0);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it('a document.undo inside a rolled-back transact does not consume the undo stack', async () => {
    const ed = makeEditor();
    const session = new IsolatedPluginSession(ed, {
      owner: 'f2-undo',
      capabilities: ['document.read', 'document.write', 'document.transact'],
      transport: nodeWorkerTransport(),
      loadTimeoutMs: 60_000,
    });
    try {
      const report = (await session.load(`
        await jcad.document.add({ type: 'line', a: { x: 2, y: 2 }, b: { x: 3, y: 3 } });
        const before = (await jcad.document.entities()).length;
        let err = null;
        try {
          await jcad.document.transact(async () => {
            await jcad.document.undo();
            await jcad.document.add({ type: 'line', a: { x: 4, y: 4 }, b: { x: 5, y: 5 } });
            await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: -5 });
          });
        } catch (e) { err = String((e && e.message) || e); }
        const after = (await jcad.document.entities()).length;
        // Reads still work inside a transact (committed state) and a clean
        // transact still commits atomically as one batch.
        let insideCount = -1;
        await jcad.document.transact(async () => {
          insideCount = (await jcad.document.entities()).length;
          await jcad.document.add({ type: 'line', a: { x: 6, y: 6 }, b: { x: 7, y: 7 } });
        });
        const final = (await jcad.document.entities()).length;
        return { before, err, after, insideCount, final };
      `)) as { before: number; err: string | null; after: number; insideCount: number; final: number };
      expect(report.err).toMatch(/cannot run inside document\.transact/);
      // The pre-existing entity survived: the undo never executed.
      expect(report.after).toBe(report.before);
      // Read-only calls inside a transact are unaffected...
      expect(report.insideCount).toBe(report.before);
      // ...and a well-formed transact still commits.
      expect(report.final).toBe(report.before + 1);
      // The host undo stack is intact: one undo removes exactly the last add.
      ed.doc.undo();
      expect(entityCount(ed)).toBe(report.before);
    } finally {
      session.dispose();
    }
  }, 60_000);
});

describe('nonce fallback (slice-1 task judge watch item)', () => {
  it('session construction fails closed when WebCrypto is unavailable', () => {
    const ed = makeEditor();
    vi.stubGlobal('crypto', undefined);
    try {
      expect(
        () =>
          new IsolatedPluginSession(ed, {
            owner: 'nonce-probe',
            capabilities: [],
            transport: nodeWorkerTransport(),
          }),
      ).toThrow(/WebCrypto/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
