/**
 * P25 acceptance / security tests.
 *
 * These are the regression evidence for the priority-25 slice (CONTRACTS §8):
 * the SAME probe that succeeds against the legacy trusted path (API v1
 * evaluatePlugin, in-page) must be DENIED in the isolated realm, and the
 * useful v1 behaviours (drawing transactions as one undo step, commands,
 * events, per-plugin settings, file-picker grants) must survive mediation.
 *
 * The realm under test is a real Node worker thread running the shipped
 * bootstrap source — not a mock of it. Denied operations are real denials:
 * the host editor's state is asserted unchanged after each attempt.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { evaluatePlugin } from '../src/app/plugins';
import { createApi } from '../src/app/api';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { nodeWorkerTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // the Editor module graph import exceeds the 10 s default hook timeout on a loaded 2-CPU box (baseline fact, see report)
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

const sessions: IsolatedPluginSession[] = [];
function session(ed: EditorType, owner: string, capabilities: string[], opts: Record<string, unknown> = {}): IsolatedPluginSession {
  const s = new IsolatedPluginSession(ed, { owner, capabilities, transport: nodeWorkerTransport(), ...opts });
  sessions.push(s);
  return s;
}
afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose();
  vi.unstubAllGlobals();
});

/** Probe run against BOTH paths: read host secrets, touch storage/bridge, mutate with no capability grant. */
const OLD_PROBE = `
  const out = {};
  out.secret = globalThis.__p25HostSecret;
  out.windowEditor = window.editor;
  out.bridgeSave = window.jcad.saveDxf;
  out.trustedStore = localStorage.getItem('jcad.plugins.trusted');
  out.addedIds = jcad.document.add({ type: 'text', position: { x: 9, y: 9 }, text: 'old-path' });
  try { jcad.settings.set('gridVisible', false); out.settingsWrite = 'allowed'; } catch { out.settingsWrite = 'denied'; }
  return out;
`;

const REALM_PROBE = `
  const out = {};
  out.secretType = typeof globalThis.__p25HostSecret;
  out.windowType = typeof window;
  out.documentType = typeof document;
  out.localStorageType = typeof localStorage;
  out.processType = typeof process;
  out.globalJcadType = typeof globalThis.jcad;
  out.rawPost = (() => { try { globalThis.postMessage({ kind: 'rpc', method: 'document.add' }); return 'sent'; } catch { return 'threw'; } })();
  out.fetchOutcome = await fetch('https://example.invalid/steal').then(() => 'allowed', () => 'denied');
  out.addNoCap = await jcad.document.add({ type: 'text', position: { x: 1, y: 1 }, text: 'nope' }).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
  out.readNoCap = await jcad.document.entities().then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
  out.settingsWrite = await jcad.settings.set('gridVisible', false).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
  return out;
`;

describe('P25 regression contrast: legacy trusted path vs isolated realm', () => {
  it('the old trusted path really does leak host globals and mutate without capabilities (the bug)', async () => {
    const ed = makeEditor();
    const g = globalThis as Record<string, unknown>;
    g.__p25HostSecret = 'HOST-SECRET';
    const store = new Map<string, string>([['jcad.plugins.trusted', '{"folder:x":{"answer":"yes"}}']]);
    vi.stubGlobal('window', { editor: 'THE-EDITOR', jcad: { saveDxf: 'BRIDGE-SAVE' } });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    try {
      const { api } = createApi(ed, 'probe-old');
      const out = (await evaluatePlugin(OLD_PROBE, api, 'probe-old', null)) as Record<string, unknown>;
      // Every one of these is a REAL breach of the boundary P25 must enforce.
      expect(out.secret).toBe('HOST-SECRET');
      expect(out.windowEditor).toBe('THE-EDITOR');
      expect(out.bridgeSave).toBe('BRIDGE-SAVE');
      expect(String(out.trustedStore)).toContain('"answer":"yes"');
      expect(out.addedIds).toHaveLength(1);
      expect(out.settingsWrite).toBe('allowed');
      expect(ed.doc.entities.some((e) => e.type === 'text' && e.text === 'old-path')).toBe(true);
    } finally {
      delete g.__p25HostSecret;
    }
  });

  it('the isolated realm denies the same probe: no window/editor/bridge/storage/process, no undeclared RPC', async () => {
    const ed = makeEditor();
    (globalThis as Record<string, unknown>).__p25HostSecret = 'HOST-SECRET';
    const s = session(ed, 'probe-new', []); // NO capabilities declared at all
    const report = (await s.load(REALM_PROBE)) as Record<string, unknown>;
    expect(report.secretType).toBe('undefined');
    expect(report.windowType).toBe('undefined');
    expect(report.documentType).toBe('undefined');
    expect(report.localStorageType).toBe('undefined');
    expect(report.processType).toBe('undefined');
    expect(report.globalJcadType).toBe('undefined');
    expect(report.rawPost).toBe('threw');
    expect(report.fetchOutcome).toBe('denied');
    expect(report.addNoCap).toBe('denied:denied');
    expect(report.readNoCap).toBe('denied:denied');
    expect(report.settingsWrite).toBe('denied:denied');
    // Atomic refusal: nothing reached the drawing, and every denial was recorded.
    expect(ed.doc.entities.some((e) => e.type === 'text' && e.text === 'nope')).toBe(false);
    expect(ed.doc.dirty).toBe(false);
    const deniedMethods = s.denials.filter((d) => d.code === 'denied').map((d) => d.method);
    expect(deniedMethods).toEqual(expect.arrayContaining(['document.add', 'document.entities', 'settings.set']));
    delete (globalThis as Record<string, unknown>).__p25HostSecret;
  });
});

describe('P25 isolated realm: useful work still works, mediated', () => {
  it('transactions commit as ONE undo step; commands, events and own settings cross the RPC', async () => {
    const ed = makeEditor();
    const caps = ['document.read', 'document.write', 'document.transact', 'commands.register', 'ui.log', 'events.subscribe', 'settings.own'];
    const s = session(ed, 'worker-bee', caps);
    const code = `
      jcad.commands.register({ name: 'P25ADD', description: 'adds one text via RPC', run: async (jcad) => {
        const ids = await jcad.document.add({ type: 'text', position: { x: 2, y: 3 }, text: 'via realm' });
        await jcad.ui.log('added ' + ids[0]);
      } });
      jcad.events.on('documentChanged', async () => { await jcad.ui.log('saw change'); });
      const before = (await jcad.document.entities()).length;
      await jcad.document.transact(async () => {
        await jcad.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
        await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: 2 });
      });
      const after = (await jcad.document.entities()).length;
      await jcad.settings.set('plugin:note', 'hello');
      const note = await jcad.settings.get('plugin:note');
      return { before, after, note };
    `;
    const report = (await s.load(code)) as { before: number; after: number; note: string };
    expect(report.after).toBe(report.before + 2);
    expect(report.note).toBe('hello');
    expect(ed.doc.dirty).toBe(true);
    // One undo step removes BOTH transacted entities (v1 transact semantics preserved).
    expect(ed.doc.undo()).toBe(true);
    expect(ed.doc.entities).toHaveLength(report.before);
    // The realm-registered command runs in the editor and its RPC add lands.
    ed.runCommand('P25ADD');
    await vi.waitFor(() => expect(ed.history.some((l) => l.startsWith('added '))).toBe(true));
    expect(ed.doc.entities.some((e) => e.type === 'text' && e.text === 'via realm')).toBe(true);
    // The documentChanged event was forwarded into the realm at least once.
    await vi.waitFor(() => expect(ed.history).toContain('saw change'));
  });

  it('a failing operation inside a transaction batch rolls the whole batch back (atomic refusal)', async () => {
    const ed = makeEditor();
    const s = session(ed, 'atomic', ['document.read', 'document.write', 'document.transact']);
    const code = `
      let outcome;
      try {
        await jcad.document.transact(async () => {
          await jcad.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
          await jcad.document.add({ type: 'circle', center: { x: 0, y: 0 }, radius: -5 });
        });
        outcome = 'committed';
      } catch (e) { outcome = 'rolled-back:' + (e.code ?? 'error'); }
      return { outcome, count: (await jcad.document.entities()).length };
    `;
    const report = (await s.load(code)) as { outcome: string; count: number };
    expect(report.outcome).toMatch(/^rolled-back:/);
    expect(report.count).toBe(0);
    expect(ed.doc.entities).toHaveLength(0);
    expect(ed.doc.dirty).toBe(false);
    expect(ed.doc.undo()).toBe(false);
  });

  it('file-picker grants are single-use and session-bound; forged and stale grants are denied', async () => {
    const ed = makeEditor();
    const picker = async () => ({ name: 'note.txt', text: 'grant me' });
    const s1 = session(ed, 'grantor', ['files.read'], { pickTextFile: picker });
    const code1 = `
      const g = await jcad.files.requestRead('.txt');
      const first = await jcad.files.readGrant(g.grant);
      const second = await jcad.files.readGrant(g.grant).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
      const forged = await jcad.files.readGrant('grant-forged-1').then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error'));
      return { grant: g.grant, name: first.name, text: first.text, second, forged };
    `;
    const r1 = (await s1.load(code1)) as { grant: string; name: string; text: string; second: string; forged: string };
    expect(r1.name).toBe('note.txt');
    expect(r1.text).toBe('grant me');
    expect(r1.second).toBe('denied:grant-used');
    expect(r1.forged).toBe('denied:unknown-grant');
    // After the issuing session is disposed, its outstanding grant is stale everywhere.
    const s1b = session(ed, 'grantor-2', ['files.read'], { pickTextFile: picker });
    const gOnly = (await s1b.load(`const g = await jcad.files.requestRead('.txt'); return { grant: g.grant };`)) as { grant: string };
    s1b.dispose();
    const s2 = session(ed, 'successor', ['files.read'], { pickTextFile: picker });
    const r2 = (await s2.load(`return { stale: await jcad.files.readGrant(${JSON.stringify(gOnly.grant)}).then(() => 'allowed', (e) => 'denied:' + (e.code ?? 'error')) };`)) as { stale: string };
    expect(r2.stale).toBe('denied:unknown-grant');
  });

  it('a plugin that never finishes loading times out and the realm is terminated, editor untouched', async () => {
    const ed = makeEditor();
    const s = session(ed, 'hangs', ['ui.log'], { loadTimeoutMs: 300 });
    await expect(s.load('return new Promise(() => {});')).rejects.toThrow(/did not finish loading/);
    expect(s.disposed).toBe(true);
    expect(ed.doc.entities).toHaveLength(0);
  });

  it('load errors inside the realm surface as load failures and register nothing', async () => {
    const ed = makeEditor();
    const s = session(ed, 'broken', ['commands.register']);
    await expect(s.load("jcad.commands.register({ name: 'HALF', run() {} }); throw new Error('realm oops');")).rejects.toThrow(/realm oops/);
    expect(ed.commands.has('HALF')).toBe(false);
  });
});
