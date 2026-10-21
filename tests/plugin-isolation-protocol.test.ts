/**
 * P25 host-protocol unit tests: manifest/capability parsing (fail-closed) and
 * the host dispatcher's authentication, capability, size and staleness rules.
 * The loopback transport lets the test act as the realm endpoint; every rule
 * asserted here is enforced by the real host code in plugin-isolation/host.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { IsolatedPluginSession } from '../src/app/plugin-isolation/host';
import { parseIsolatedManifest, IsolatedManifestError } from '../src/app/plugin-isolation/manifest';
import { PLUGIN_CAPABILITIES } from '../src/app/plugin-isolation/capabilities';
import { LoopbackTransport } from './plugin-isolation-harness';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
}, 120_000); // see acceptance test note on Editor import time
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('isolated manifest + capabilities', () => {
  it('parses a v1 manifest as legacy page mode with no capabilities', () => {
    const m = parseIsolatedManifest(JSON.stringify({ name: 'old', main: 'main.js' }));
    expect(m).toMatchObject({ name: 'old', isolation: 'page', apiVersion: 1 });
    expect(m.capabilities.size).toBe(0);
  }, 60_000);

  it('parses an isolated manifest with declared capabilities', () => {
    const m = parseIsolatedManifest(JSON.stringify({ name: 'new', apiVersion: 2, isolation: 'worker', capabilities: ['document.read', 'ui.log'] }));
    expect(m.isolation).toBe('worker');
    expect(m.apiVersion).toBe(2);
    expect([...m.capabilities].sort()).toEqual(['document.read', 'ui.log']);
  }, 60_000);

  it('fails closed on unknown capabilities, wrong apiVersion and malformed declarations', () => {
    expect(() => parseIsolatedManifest(JSON.stringify({ name: 'x', apiVersion: 2, isolation: 'worker', capabilities: ['document.read', 'host.exec'] }))).toThrow(IsolatedManifestError);
    expect(() => parseIsolatedManifest(JSON.stringify({ name: 'x', apiVersion: 1, isolation: 'worker', capabilities: [] }))).toThrow(/"apiVersion": 2/);
    expect(() => parseIsolatedManifest(JSON.stringify({ name: 'x', apiVersion: 2, isolation: 'worker', capabilities: 'document.read' }))).toThrow(/array/);
    expect(() => parseIsolatedManifest(JSON.stringify({ name: 'x', apiVersion: 2, capabilities: ['document.read'] }))).toThrow(/isolation/);
    expect(() => parseIsolatedManifest(JSON.stringify({ name: 'x', isolation: 'sandbox' }))).toThrow(/isolation/);
    expect(() => parseIsolatedManifest('not json')).toThrow(IsolatedManifestError);
  }, 60_000);

  it('the capability vocabulary is exactly the documented set', () => {
    expect([...PLUGIN_CAPABILITIES].sort()).toEqual(
      ['commands.list', 'commands.register', 'commands.run', 'document.read', 'document.transact', 'document.write', 'electrical.read', 'electrical.write', 'events.subscribe', 'files.read', 'files.save', 'settings.own', 'settings.read', 'settings.write', 'ui.interact', 'ui.log'].sort(),
    );
  }, 60_000);
});

/** Start a session on a loopback transport and complete its load handshake as the realm endpoint. */
async function loadedSession(ed: EditorType, capabilities: string[]) {
  const transport = new LoopbackTransport();
  const s = new IsolatedPluginSession(ed, { owner: 'proto', capabilities, transport });
  const loadP = s.load('/* test realm */');
  const hs = transport.handshake();
  transport.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: { ready: true } });
  await loadP;
  const rpc = (id: string, method: string, args: unknown[], nonce: string = hs.realmNonce) =>
    transport.emit({ kind: 'rpc', v: 2, session: hs.session, nonce, id, method, args });
  const responses = () => transport.inbox.filter((m) => (m as { kind?: string }).kind === 'rpc-res') as Array<{ id: string; ok: boolean; error?: { code: string } }>;
  return { s, transport, hs, rpc, responses };
}

describe('host dispatcher: authentication, capabilities, staleness', () => {
  it('drops forged messages (wrong nonce) without answering and records the denial', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['document.write']);
    rpc('forged-1', 'document.add', [{ type: 'text', position: { x: 0, y: 0 }, text: 'forged' }], 'attacker-guess');
    await tick();
    expect(responses().filter((r) => r.id === 'forged-1')).toHaveLength(0);
    expect(ed.doc.entities).toHaveLength(0);
    expect(s.denials.some((d) => d.code === 'forged')).toBe(true);
    s.dispose();
  }, 60_000);

  it('denies undeclared capabilities and unknown methods with explicit error codes', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['document.read']);
    rpc('a', 'document.add', [{ type: 'text', position: { x: 0, y: 0 }, text: 'x' }]);
    rpc('b', 'window.eval', ['alert(1)']);
    rpc('c', 'document.entities', []);
    await tick();
    const byId = new Map(responses().map((r) => [r.id, r]));
    expect(byId.get('a')).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(byId.get('b')).toMatchObject({ ok: false, error: { code: 'unknown-method' } });
    expect(byId.get('c')).toMatchObject({ ok: true });
    expect(ed.doc.entities).toHaveLength(0);
    expect(s.denials.filter((d) => d.code === 'denied')).toHaveLength(1);
    s.dispose();
  }, 60_000);

  it('rejects oversized payloads before dispatch', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['ui.log']);
    rpc('big', 'ui.log', ['x'.repeat(1_100_000)]);
    await tick();
    expect(responses().find((r) => r.id === 'big')).toMatchObject({ ok: false, error: { code: 'too-large' } });
    s.dispose();
  }, 60_000);

  it('after dispose, the old session nonce is stale: messages are refused and state is untouched', async () => {
    const ed = makeEditor();
    const { s, transport, hs } = await loadedSession(ed, ['document.write']);
    s.dispose();
    expect(transport.terminated).toBe(true);
    transport.emit({ kind: 'rpc', v: 2, session: hs.session, nonce: hs.realmNonce, id: 'late', method: 'document.add', args: [{ type: 'text', position: { x: 0, y: 0 }, text: 'late' }] });
    await tick();
    expect(ed.doc.entities).toHaveLength(0);
    expect(s.denials.some((d) => d.code === 'stale-session')).toBe(true);
  }, 60_000);

  it('a load-done with a forged nonce never completes the load', async () => {
    const ed = makeEditor();
    const transport = new LoopbackTransport();
    const s = new IsolatedPluginSession(ed, { owner: 'proto2', capabilities: [], transport, loadTimeoutMs: 200 });
    const loadP = s.load('x');
    const hs = transport.handshake();
    transport.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: 'forged', ok: true, report: null });
    await expect(loadP).rejects.toThrow(/did not finish loading/);
    expect(s.denials.some((d) => d.code === 'forged')).toBe(true);
    s.dispose();
  }, 60_000);
});
