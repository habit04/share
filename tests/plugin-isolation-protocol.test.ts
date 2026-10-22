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
  const loadP = s.loadModule('file:///p25-loopback-entry.mjs'); // the loopback realm never fetches it; the test answers load-done itself
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

  it('refuses a replayed mutating envelope: the first application stands exactly once and the session stays usable', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['document.write']);
    const firstText = { type: 'text', position: { x: 0, y: 0 }, text: 'apply once' };
    const replay = () => rpc('replay-1', 'document.add', [firstText]);
    replay();
    await tick();
    expect(responses().filter((r) => r.id === 'replay-1')).toHaveLength(1);
    expect(responses().find((r) => r.id === 'replay-1')).toMatchObject({ ok: true });
    expect(ed.doc.entities).toHaveLength(1);

    // Byte-identical replay of the authenticated envelope: refused with no
    // second response, no handler execution and no second application.
    replay();
    await tick();
    expect(responses().filter((r) => r.id === 'replay-1')).toHaveLength(1);
    expect(ed.doc.entities).toHaveLength(1);
    expect(ed.doc.entities[0]).toMatchObject({ type: 'text', text: 'apply once' });
    expect(s.denials.some((d) => d.code === 'replay' && d.method === 'document.add')).toBe(true);

    // The refusal does not poison the session: the next legitimate envelope,
    // carrying a fresh id, executes normally.
    rpc('replay-2', 'document.add', [{ type: 'text', position: { x: 1, y: 1 }, text: 'legitimate next' }]);
    await tick();
    expect(responses().find((r) => r.id === 'replay-2')).toMatchObject({ ok: true });
    expect(ed.doc.entities).toHaveLength(2);
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
    const loadP = s.loadModule('file:///p25-loopback-entry.mjs');
    const hs = transport.handshake();
    transport.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: 'forged', ok: true, report: null });
    await expect(loadP).rejects.toThrow(/did not finish loading/);
    expect(s.denials.some((d) => d.code === 'forged')).toBe(true);
    s.dispose();
  }, 60_000);
});

describe('host dispatcher: X2-W eviction watermark', () => {
  // LEAD RULING — P25-X2-W: the X2 consumed set is a 4,096-id FIFO window and
  // eviction must not re-open replay. Each kind's eviction watermark (the
  // highest counter ever evicted for that kind) keeps an evicted id refused,
  // while out-of-order in-flight ids above the watermark still execute. The
  // ids below are shaped exactly as the shipped clients mint them — realm rpc
  // ids `r<counter>` from the bootstrap's monotonic counter, host call ids
  // `c<counter>` echoed back in call-res envelopes (docs/PLUGIN-ISOLATION.md,
  // envelope id grammar).
  const waitFor = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 4000 && !cond(); i++) await tick();
    expect(cond(), what).toBe(true);
  };
  const replayDenials = (s: IsolatedPluginSession) => s.denials.filter((d) => d.code === 'replay');

  it('keeps the first envelope refused after 4,097 envelopes evict it (the lead\'s named X2-W test)', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['document.write', 'ui.log']);
    const firstText = { type: 'text', position: { x: 0, y: 0 }, text: 'watermark-first' };
    rpc('r1', 'document.add', [firstText]);
    await waitFor(() => responses().filter((r) => r.id === 'r1').length === 1, 'first envelope answered');
    expect(responses().find((r) => r.id === 'r1')).toMatchObject({ ok: true });
    expect(ed.doc.entities).toHaveLength(1);

    // 4,096 further envelopes (r2..r4097): the 4,097th receipt evicts r1 from
    // the consumed set. Only the watermark can still refuse its replay.
    for (let n = 2; n <= 4097; n++) rpc(`r${n}`, 'ui.log', ['flood']);
    await waitFor(() => responses().length >= 4097, 'flood answered');
    rpc('r1', 'document.add', [firstText]);
    await tick();
    await tick();
    expect(responses().filter((r) => r.id === 'r1')).toHaveLength(1);
    expect(ed.doc.entities).toHaveLength(1);
    expect(replayDenials(s).some((d) => d.method === 'document.add')).toBe(true);

    // The second-oldest id is still inside the window: refused via the set.
    rpc('r2', 'ui.log', ['flood']);
    await tick();
    await tick();
    expect(responses().filter((r) => r.id === 'r2')).toHaveLength(1);

    // One more envelope evicts r2 too; its replay is now refused via the
    // watermark instead of the set (same observable refusal).
    rpc('r4098', 'ui.log', ['flood']);
    await waitFor(() => responses().filter((r) => r.id === 'r4098').length === 1, 'r4098 answered');
    rpc('r2', 'ui.log', ['flood']);
    await tick();
    await tick();
    expect(responses().filter((r) => r.id === 'r2')).toHaveLength(1);

    // The refusals do not poison the session: a fresh envelope still executes.
    rpc('r4099', 'document.add', [{ type: 'text', position: { x: 1, y: 1 }, text: 'after' }]);
    await waitFor(() => responses().filter((r) => r.id === 'r4099').length === 1, 'r4099 answered');
    expect(ed.doc.entities).toHaveLength(2);
    s.dispose();
  }, 120_000);

  it('executes an out-of-order in-flight id above the watermark and refuses a never-consumed id below it', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['ui.log']);
    // Receipts r2..r3999, r4001..r4098 (r4000 withheld, in flight), then r4000
    // itself: the 4,097th receipt evicts r2, setting the rpc watermark to 2.
    for (let n = 2; n <= 4098; n++) {
      if (n !== 4000) rpc(`r${n}`, 'ui.log', ['x']);
    }
    rpc('r4000', 'ui.log', ['x']);
    await waitFor(() => responses().filter((r) => r.id === 'r4000').length === 1, 'withheld envelope answered');
    expect(responses().find((r) => r.id === 'r4000')).toMatchObject({ ok: true });

    // r1 was never consumed, but its counter is at/below the watermark. The
    // genuine realm channel delivers in mint order, so a first-use envelope
    // can never arrive like this; the safe posture is refusal with no effect.
    const before = replayDenials(s).length;
    rpc('r1', 'ui.log', ['x']);
    await tick();
    await tick();
    expect(responses().filter((r) => r.id === 'r1')).toHaveLength(0);
    expect(replayDenials(s).length).toBe(before + 1);
    s.dispose();
  }, 120_000);

  it('keeps the per-kind watermarks independent', async () => {
    const ed = makeEditor();
    const { s, transport, hs, rpc } = await loadedSession(ed, ['ui.log']);
    const callRes = (id: string, ok = true, value: unknown = null) =>
      transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id, ok, value });
    for (let n = 1; n <= 4097; n++) rpc(`r${n}`, 'ui.log', ['x']); // evicts r1; rpc watermark 1

    // A host call minted now carries id c1 — counter 1, level with the rpc
    // watermark but a different kind namespace: its response must be accepted.
    const p = s.invokeRealm('cb-one', []);
    const callMsg = transport.inbox.find((m) => (m as { kind?: string }).kind === 'call') as { id: string };
    expect(callMsg.id).toBe('c1');
    callRes('c1', true, 'answer-1');
    await expect(p).resolves.toBe('answer-1');
    // Replaying that response is refused (consumed set).
    const before = replayDenials(s).length;
    callRes('c1', true, 'answer-1');
    await tick();
    expect(replayDenials(s).length).toBe(before + 1);
    s.dispose();

    // Inverse direction, fresh session: call-res traffic alone (which evicts
    // c1 and sets the call-res watermark to 1) must not refuse rpc ids, and
    // the evicted c1 itself is refused via its own kind's watermark.
    const ed2 = makeEditor();
    const second = await loadedSession(ed2, ['ui.log']);
    const callRes2 = (id: string) =>
      second.transport.emit({ kind: 'call-res', v: 2, session: second.hs.session, nonce: second.hs.realmNonce, id, ok: true, value: null });
    for (let n = 1; n <= 4097; n++) callRes2(`c${n}`);
    second.rpc('r1', 'ui.log', ['x']);
    await waitFor(() => second.responses().filter((r) => r.id === 'r1').length === 1, 'rpc r1 answered');
    expect(second.responses().find((r) => r.id === 'r1')).toMatchObject({ ok: true });
    const before2 = replayDenials(second.s).length;
    callRes2('c1');
    await tick();
    expect(replayDenials(second.s).length).toBe(before2 + 1);
    second.s.dispose();
  }, 120_000);

  it('accepts a genuinely late first response for a still-pending call below the watermark, but refuses a non-pending one', async () => {
    const ed = makeEditor();
    const { s, transport, hs, rpc } = await loadedSession(ed, ['ui.log']);
    const callRes = (id: string, ok = true, value: unknown = null) =>
      transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id, ok, value });
    // The host mints call c1; its response is withheld (a slow realm callback).
    const p = s.invokeRealm('slow-callback', []);
    // An unrelated call-res c2 is consumed first, then 4,096 rpc envelopes
    // evict it from the window: the call-res watermark becomes 2 while c1 is
    // still pending.
    callRes('c2');
    for (let n = 1; n <= 4096; n++) rpc(`r${n}`, 'ui.log', ['x']);
    // The first response for pending c1 arrives with counter 1 <= watermark 2.
    // It has never been consumed — an accepted response settles and un-pends
    // the call — so it is accepted, not refused as a replay.
    callRes('c1', true, 'late-answer');
    await expect(p).resolves.toBe('late-answer');
    // A second copy is a replay (no longer pending; also in the consumed set).
    const before = replayDenials(s).length;
    callRes('c1', true, 'late-answer');
    await tick();
    expect(replayDenials(s).length).toBe(before + 1);
    // c2's copy: evicted from the set, not pending, counter at the watermark —
    // refused via the watermark.
    callRes('c2');
    await tick();
    expect(replayDenials(s).length).toBe(before + 2);
    s.dispose();
  }, 120_000);

  it('forged envelopes neither consume ids nor advance the watermark', async () => {
    const ed = makeEditor();
    const { s, rpc, responses } = await loadedSession(ed, ['document.write', 'ui.log']);
    rpc('r1', 'document.add', [{ type: 'text', position: { x: 0, y: 0 }, text: 'genuine later' }], 'attacker-guess');
    rpc('r5000', 'ui.log', ['x'], 'attacker-guess');
    await tick();
    expect(ed.doc.entities).toHaveLength(0);
    expect(s.denials.filter((d) => d.code === 'forged')).toHaveLength(2);
    // The genuine r1 still executes: the forged copy burned nothing.
    rpc('r1', 'document.add', [{ type: 'text', position: { x: 0, y: 0 }, text: 'genuine later' }]);
    await waitFor(() => responses().filter((r) => r.id === 'r1').length === 1, 'genuine r1 answered');
    expect(ed.doc.entities).toHaveLength(1);
    // A genuine r2 executes too: the forged r5000 raised no watermark over it.
    rpc('r2', 'ui.log', ['x']);
    await waitFor(() => responses().filter((r) => r.id === 'r2').length === 1, 'genuine r2 answered');
    expect(replayDenials(s)).toHaveLength(0);
    s.dispose();
  }, 60_000);
});

describe('host dispatcher: X2-W ruling conditions — the pending set is bounded (2026-10-22)', () => {
  // LEAD RULING — X2-W (2026-10-22): the call-res pending exemption is
  // ACCEPTED with two conditions. (1) The pending set is bounded: a hard cap
  // (MAX_IN_FLIGHT_CALLS in host.ts — a new callback-bearing call past the
  // cap is refused with the named 'too-large' rejection) and a timeout on
  // every entry (the session's callTimeoutMs): on timeout the entry leaves
  // pendingCalls and its id JOINS THE CONSUMED SET, so a late response is
  // refused as a replay and the exemption cannot be held open forever.
  // (2) The four legs below pin the accepted behaviour.
  const replayDenials = (s: IsolatedPluginSession) => s.denials.filter((d) => d.code === 'replay');

  it('(a) an accepted call-res id replayed afterwards is refused', async () => {
    const ed = makeEditor();
    const { s, transport, hs } = await loadedSession(ed, ['ui.log']);
    const callRes = (id: string, ok = true, value: unknown = null) =>
      transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id, ok, value });
    const p = s.invokeRealm('cb-a', []);
    const callMsg = transport.inbox.find((m) => (m as { kind?: string }).kind === 'call') as { id: string };
    expect(callMsg.id).toBe('c1');
    callRes('c1', true, 'answer-a');
    await expect(p).resolves.toBe('answer-a');
    const before = replayDenials(s).length;
    callRes('c1', true, 'answer-a');
    await tick();
    expect(replayDenials(s).length).toBe(before + 1);
    s.dispose();
  }, 60_000);

  it('(b) a pending id below the watermark is accepted exactly once; a second delivery is refused', async () => {
    const ed = makeEditor();
    const { s, transport, hs, rpc } = await loadedSession(ed, ['ui.log']);
    const callRes = (id: string, ok = true, value: unknown = null) =>
      transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id, ok, value });
    const p = s.invokeRealm('slow-cb', []); // c1 stays pending below
    callRes('c2'); // consumed (not pending: dropped at dispatch)
    for (let n = 1; n <= 4096; n++) rpc(`r${n}`, 'ui.log', ['x']); // evicts c2: call-res watermark 2
    callRes('c1', true, 'only-answer'); // counter 1 <= watermark 2, still pending: accepted once
    await expect(p).resolves.toBe('only-answer');
    const before = replayDenials(s).length;
    callRes('c1', true, 'only-answer'); // second delivery of the same id: refused
    await tick();
    expect(replayDenials(s).length).toBe(before + 1);
    s.dispose();
  }, 120_000);

  it('(c) a timed-out call leaves the pending set, its id joins the consumed set, and a late response is refused as a replay', async () => {
    const ed = makeEditor();
    const transport = new LoopbackTransport();
    const s = new IsolatedPluginSession(ed, { owner: 'proto-x2w', capabilities: ['ui.log'], transport, callTimeoutMs: 60 });
    const loadP = s.loadModule('file:///p25-loopback-entry.mjs');
    const hs = transport.handshake();
    transport.emit({ kind: 'load-done', v: 2, session: hs.session, nonce: hs.realmNonce, ok: true, report: null });
    await loadP;
    const p = s.invokeRealm('never-answers', []);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    // The timeout fired: c1 is no longer pending, and its id has joined the
    // consumed set — the late response is refused as a replay, not absorbed.
    const before = replayDenials(s).length;
    transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id: 'c1', ok: true, value: 'too-late' });
    await tick();
    expect(replayDenials(s).length).toBe(before + 1);
    s.dispose();
  }, 60_000);

  it('(d) the pending cap refuses a new callback-bearing call cleanly and leaves existing entries unaffected', async () => {
    const ed = makeEditor();
    const { s, transport, hs } = await loadedSession(ed, ['ui.log']);
    const ps: Promise<unknown>[] = [];
    // MAX_IN_FLIGHT_CALLS (host.ts) = 64 pending host->realm calls.
    for (let n = 1; n <= 64; n++) {
      const pr = s.invokeRealm(`cb-${n}`, []);
      pr.catch(() => undefined); // disposal settles the unanswered ones; this leg asserts the cap + c1 only
      ps.push(pr);
    }
    await expect(s.invokeRealm('cb-overflow', [])).rejects.toMatchObject({ code: 'too-large' });
    await expect(s.invokeRealm('cb-overflow', [])).rejects.toThrow(/too many in-flight host->realm calls/);
    // Existing pending entries are unaffected: the first call still settles.
    transport.emit({ kind: 'call-res', v: 2, session: hs.session, nonce: hs.realmNonce, id: 'c1', ok: true, value: 'first-answer' });
    await expect(ps[0]).resolves.toBe('first-answer');
    s.dispose();
  }, 60_000);
});
