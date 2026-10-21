import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { draftTestContextJson } from './ai-draft-fixture';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { guardIpc } = require('../electron/ipc-guard.cjs');
const { registerAiIpc } = require('../electron/main/ipc-ai.cjs') as {
  registerAiIpc: (ctx: unknown, overrides?: Record<string, unknown>) => { service: unknown };
};

const KEY = 'sk-ipc-test-secret-1234567890';

function envelope(requestId: string, provider = 'openai', model = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'): Record<string, unknown> {
  return {
    requestId,
    destination: { provider, model },
    question: 'how many objects?',
    snapshot: {
      kind: 'jcad.ai.selection-snapshot', version: 1,
      units: { insunits: 1, insunitsName: 'Inches', lunits: 2, luprec: 4, auprec: 0 },
      space: { kind: 'model' },
      selection: { total: 1, included: 1, omittedCount: 0, omitted: [], omittedListTruncated: false },
      objects: [{ id: 'e-line', type: 'line', layer: 'WIRES', geometry: {} }],
    },
    binding: {
      sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 7, docLoadCount: 1,
      space: { layout: null, viewport: null }, selectionIds: ['e-line'],
    },
  };
}

function completedResponse(text: string): Response {
  const body = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ text, references: ['e-line'] }) }] }],
    usage: { input_tokens: 42, output_tokens: 7 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function probeResponse(): Response {
  return new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'ready' }] },
  ], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
}

function anthropicResponse(text: string): Response {
  const body = {
    type: 'message', stop_reason: 'end_turn', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify({ text, references: ['e-line'] }) }],
    usage: { input_tokens: 11, output_tokens: 4 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function anthropicProbeResponse(): Response {
  const body = {
    type: 'message', stop_reason: 'end_turn', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: 'ready' }],
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function draftPlanValue(): Record<string, unknown> {
  return {
    outcome: 'proposal', message: null,
    operations: [{
      op: 'createLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
      center: null, radius: null, origin: null, width: null, height: null,
      rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
      pivot: null, angleDeg: null,
    }],
  };
}

function draftEnvelope(requestId: string, provider = 'openai', model = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'): Record<string, unknown> {
  return {
    requestId,
    destination: { provider, model },
    prompt: 'draw a line',
    contextJson: draftTestContextJson(['e-line']),
    binding: {
      ask: {
        sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 7, docLoadCount: 1,
        space: { layout: null, viewport: null }, selectionIds: ['e-line'],
      },
      unitsKey: '1|2|4',
      defaultsKey: '{"layer":"0","color":"ByLayer"}',
      eligibilityKey: 'e-line=1',
      configKey: `${provider}|${model}|0`,
    },
  };
}

async function liveDraftEnvelope(requestId: string, provider = 'openai', model = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'): Promise<Record<string, unknown>> {
  const result = await harness.invoke('ai-get-state');
  const state = result.state as { configGeneration: string };
  const value = draftEnvelope(requestId, provider, model);
  (value.destination as Record<string, unknown>).configGeneration = state.configGeneration;
  return value;
}

const refineMoveOp = {
  op: 'move', a: null, b: null, center: null, radius: null, origin: null,
  width: null, height: null, rotationDeg: null, layer: null,
  targetIds: ['e-line'], dx: 10, dy: 0, pivot: null, angleDeg: null,
};

function refineEnvelopeJson(): string {
  return JSON.stringify({
    kind: 'jcad.ai.draft-refine-context',
    version: 1,
    originalPrompt: 'draw a line',
    followUp: 'make it longer',
    originalContext: JSON.parse(draftTestContextJson(['e-line'])),
    currentPlan: { message: null, operations: [refineMoveOp] },
    proposalLabels: [{ label: 'Move 1', summary: 'Move 1 object(s) by (10.0000, 0.0000)' }],
  });
}

function refineEnvelope(requestId: string, provider = 'openai', model = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'): Record<string, unknown> {
  return {
    requestId,
    destination: { provider, model },
    followUp: 'make it longer',
    envelopeJson: refineEnvelopeJson(),
    binding: {
      ask: {
        sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 7, docLoadCount: 1,
        space: { layout: null, viewport: null }, selectionIds: ['e-line'],
      },
      unitsKey: '1|2|4',
      defaultsKey: '{"layer":"0","color":"ByLayer"}',
      eligibilityKey: 'e-line=1',
      configKey: `${provider}|${model}|0`,
    },
  };
}

async function liveRefineEnvelope(requestId: string, provider = 'openai', model = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'): Promise<Record<string, unknown>> {
  const result = await harness.invoke('ai-get-state');
  const state = result.state as { configGeneration: string };
  const value = refineEnvelope(requestId, provider, model);
  (value.destination as Record<string, unknown>).configGeneration = state.configGeneration;
  return value;
}

function openAiDraftResponse(): Response {
  const body = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draftPlanValue()) }] }],
    usage: { input_tokens: 30, output_tokens: 12 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function anthropicDraftResponse(): Response {
  const body = {
    type: 'message', stop_reason: 'end_turn', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify(draftPlanValue()) }],
    usage: { input_tokens: 13, output_tokens: 8 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

interface Harness {
  handlers: Map<string, (ev: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>;
  appHandlers: Map<string, Array<(...args: unknown[]) => void>>;
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  dir: string;
  contents: EventEmitter & { mainFrame: { processId: number; routingId: number; parent: null; url: string } };
  invokeAs: (event: unknown, channel: string, ...args: unknown[]) => Promise<Record<string, unknown>>;
  invoke: (channel: string, ...args: unknown[]) => Promise<Record<string, unknown>>;
}

function makeHarness(fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<Response>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-ai-ipc-'));
  const handlers = new Map();
  const appHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const fetchCalls: Harness['fetchCalls'] = [];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
    decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
  };
  const recordingFetch = async (url: string, init: Record<string, unknown>) => {
    fetchCalls.push({ url, init });
    if (fetchImpl) return fetchImpl(url, init);
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.includes('anthropic')) return body.includes('single word') ? anthropicProbeResponse() : anthropicResponse('Claude answer.');
    return body.includes('single word') ? probeResponse() : completedResponse('One line.');
  };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' } });
  const win = { isDestroyed: () => false, webContents: contents };
  const ipc = { handle: (channel: string, fn: never) => handlers.set(channel, fn) };
  const ctx = { ipcMain: guardIpc(ipc, { getWindow: () => win, isAppUrl: (url: string) => url === 'jcad://app/index.html', log: { reject: vi.fn() } }), mainWindow: win };
  const app = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      appHandlers.set(event, [...(appHandlers.get(event) ?? []), fn]);
    },
  };
  registerAiIpc(ctx, { dir, safeStorage, fetchImpl: recordingFetch, app });
  return {
    handlers, appHandlers, fetchCalls, dir, contents,
    invokeAs: async (event, channel, ...args) => handlers.get(channel)!(event, ...args),
    invoke: async (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`channel not registered: ${channel}`);
      return fn({ sender: contents, senderFrame: contents.mainFrame }, ...args);
    },
  };
}

let harness: Harness;
afterEach(() => { if (harness) rmSync(harness.dir, { recursive: true, force: true }); });

describe('ai IPC registration (guarded context)', () => {
  beforeEach(() => { harness = makeHarness(); });

  it('registers exactly the fourteen ai channels through the context ipcMain', () => {
    expect([...harness.handlers.keys()].sort()).toEqual([
      'ai-ask', 'ai-cancel', 'ai-draft', 'ai-draft-refine', 'ai-forget-key', 'ai-get-state',
      'ai-live-checks-cancel', 'ai-live-checks-run', 'ai-set-enabled',
      'ai-set-key', 'ai-set-model', 'ai-set-provider', 'ai-test-connection', 'ai-usage',
    ]);
  });

  it('routes to Anthropic with its own key after an explicit provider switch', async () => {
    const ANTHROPIC_KEY = 'sk-ant-test-secret-abcdefghij';
    // Configure OpenAI first, then switch: keys and models stay separate.
    await harness.invoke('ai-set-key', KEY, 'session');
    const switched = await harness.invoke('ai-set-provider', 'anthropic');
    expect(switched).toMatchObject({ ok: true, state: { provider: 'anthropic', model: 'claude-sonnet-5-5', keyPresent: false } });
    const askedEarly = await harness.invoke('ai-ask', envelope('ai-test-anth-early'));
    expect(askedEarly).toMatchObject({ ok: false, error: { kind: 'live-disabled' } });
    await harness.invoke('ai-set-key', ANTHROPIC_KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const asked = await harness.invoke('ai-ask', envelope('ai-test-anth-1', 'anthropic'));
    expect(asked).toMatchObject({ ok: true, answer: { text: 'Claude answer.', providerUsage: { inputTokens: 11, outputTokens: 4 } } });
    expect(harness.fetchCalls).toHaveLength(1);
    const call = harness.fetchCalls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe(ANTHROPIC_KEY);
    // The OpenAI key never reaches Anthropic, and vice versa.
    expect(JSON.stringify(call.init)).not.toContain(KEY);
    const back = await harness.invoke('ai-set-provider', 'openai');
    expect(back).toMatchObject({ ok: true, state: { provider: 'openai', model: 'gpt-5', keyPresent: true } });
  });

  it('stores per-provider key files separately when persistence is encrypted', async () => {
    await harness.invoke('ai-set-provider', 'anthropic');
    await harness.invoke('ai-set-key', 'sk-ant-file-secret-123456', 'encrypted');
    expect(readdirSync(harness.dir).sort()).toEqual(['anthropic-key.bin', 'config.json']);
    expect(readFileSync(join(harness.dir, 'anthropic-key.bin'), 'utf8')).not.toContain('sk-ant-file-secret');
  });

  it('defaults to disabled with no key and refuses asks before enablement — no fetch happens', async () => {
    const state = await harness.invoke('ai-get-state');
    expect(state).toMatchObject({ ok: true, state: { provider: 'openai', model: 'gpt-5', enabled: false, keyPresent: false } });
    const asked = await harness.invoke('ai-ask', envelope('ai-test-1'));
    expect(asked).toMatchObject({ ok: false, error: { kind: 'live-disabled' } });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it('runs the full deliberate flow: session key, enable, ask, probe — and never leaks the key', async () => {
    const responses: unknown[] = [];
    responses.push(await harness.invoke('ai-set-key', KEY, 'session'));
    // Session-only: nothing but the non-secret config may exist on disk,
    // and the key file must not exist at all.
    expect(readdirSync(harness.dir).sort()).toEqual(['config.json']);
    responses.push(await harness.invoke('ai-set-enabled', true));
    const asked = await harness.invoke('ai-ask', envelope('ai-test-2'));
    responses.push(asked);
    expect(asked).toMatchObject({ ok: true, answer: { text: 'One line.', providerUsage: { inputTokens: 42, outputTokens: 7 } } });
    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0]!.url).toBe('https://api.openai.com/v1/responses');

    const probe = await harness.invoke('ai-test-connection');
    responses.push(probe);
    expect(probe).toMatchObject({ ok: true, probe: { model: 'gpt-5', inputTokens: 3, outputTokens: 1 } });
    expect(harness.fetchCalls).toHaveLength(2);

    const usage = await harness.invoke('ai-usage');
    responses.push(usage);
    expect(usage).toMatchObject({ ok: true, usage: { requests: 1 } });

    // The key appears in no IPC response and in no file on disk.
    expect(JSON.stringify(responses)).not.toContain(KEY);
    expect(readFileSync(join(harness.dir, 'config.json'), 'utf8')).not.toContain(KEY);
  });

  it('persists an encrypted key across a fresh registration (restart) when opted in', async () => {
    await harness.invoke('ai-set-key', KEY, 'encrypted');
    expect(readdirSync(harness.dir).sort()).toEqual(['config.json', 'openai-key.bin']);
    expect(readFileSync(join(harness.dir, 'openai-key.bin'), 'utf8')).not.toContain(KEY);
    const dir = harness.dir;
    const second = makeHarness();
    rmSync(second.dir, { recursive: true, force: true });
    // Re-register over the same directory: the stored key must be found.
    const handlers2 = new Map();
    const ctx2 = { ipcMain: { handle: (c: string, fn: never) => handlers2.set(c, fn) }, mainWindow: null };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
      decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
    };
    registerAiIpc(ctx2, { dir, safeStorage, fetchImpl: async () => completedResponse('Back.'), app: { on: () => {} } });
    const getState = handlers2.get('ai-get-state')!;
    const state = await getState({});
    expect(state).toMatchObject({ ok: true, state: { keyPresent: true, keySource: 'stored' } });
    void dir;
  });

  it('translates ai-cancel into host cancellation of a running ask', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted by host')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-ask', envelope('ai-test-cancel'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    const cancelled = await harness.invoke('ai-cancel', 'ai-test-cancel');
    expect(cancelled).toMatchObject({ ok: true, cancelled: true });
    const settled = await pending;
    expect(settled).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('routes ai-draft to OpenAI and returns the validated raw plan value', async () => {
    harness = makeHarness(async () => openAiDraftResponse());
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const drafted = await harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-1'));
    expect(drafted).toMatchObject({
      ok: true,
      draft: { value: draftPlanValue(), providerUsage: { inputTokens: 30, outputTokens: 12 } },
    });
    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(String(harness.fetchCalls[0]!.init.body)).toContain('jcad_draft_plan');
    // The key appears in no IPC response.
    expect(JSON.stringify(drafted)).not.toContain(KEY);
  });

  it('routes ai-draft to Anthropic with its own key after a provider switch', async () => {
    const ANTHROPIC_KEY = '<redacted>';
    harness = makeHarness(async () => anthropicDraftResponse());
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-provider', 'anthropic');
    await harness.invoke('ai-set-key', ANTHROPIC_KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const drafted = await harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-anth-1', 'anthropic'));
    expect(drafted).toMatchObject({
      ok: true,
      draft: { value: draftPlanValue(), providerUsage: { inputTokens: 13, outputTokens: 8 } },
    });
    expect(harness.fetchCalls).toHaveLength(1);
    const call = harness.fetchCalls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(JSON.stringify(call.init)).not.toContain(KEY);
  });

  it('refuses ai-draft before enablement — no fetch happens', async () => {
    const drafted = await harness.invoke('ai-draft', draftEnvelope('ai-draft-early'));
    expect(drafted).toMatchObject({ ok: false, error: { kind: 'live-disabled' } });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it('translates ai-cancel into host cancellation of a running draft', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted by host')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-cancel'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    const cancelled = await harness.invoke('ai-cancel', 'ai-draft-cancel');
    expect(cancelled).toMatchObject({ ok: true, cancelled: true });
    const settled = await pending;
    expect(settled).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('rejects a duplicate draft request id while the first is outstanding', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted by host')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-dupe'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    const duplicate = await harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-dupe'));
    expect(duplicate).toMatchObject({ ok: false, error: { kind: 'invalid-request' } });
    await harness.invoke('ai-cancel', 'ai-draft-dupe');
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('owns cancellation before a draft has finished service admission', async () => {
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-draft', await liveDraftEnvelope('ai-draft-early-cancel'));
    expect(await harness.invoke('ai-cancel', 'ai-draft-early-cancel')).toMatchObject({ ok: true, cancelled: true });
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it('routes ai-draft-refine to OpenAI and returns the validated replacement plan value', async () => {
    harness = makeHarness(async () => openAiDraftResponse());
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const refined = await harness.invoke('ai-draft-refine', await liveRefineEnvelope('ai-refine-1'));
    expect(refined).toMatchObject({
      ok: true,
      draft: { value: draftPlanValue(), providerUsage: { inputTokens: 30, outputTokens: 12 } },
    });
    expect(harness.fetchCalls).toHaveLength(1);
    const call = harness.fetchCalls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    const body = String(call.init.body);
    expect(body).toContain('Follow-up instruction: make it longer');
    expect(body).toContain('jcad.ai.draft-refine-context');
    expect(body).toContain('COMPLETE REPLACEMENT PLAN');
    // The key appears in no IPC response.
    expect(JSON.stringify(refined)).not.toContain(KEY);
  });

  it('refuses ai-draft-refine before enablement — no fetch happens', async () => {
    const refined = await harness.invoke('ai-draft-refine', refineEnvelope('ai-refine-early'));
    expect(refined).toMatchObject({ ok: false, error: { kind: 'live-disabled' } });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it('translates ai-cancel into host cancellation of a running refinement', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted by host')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-draft-refine', await liveRefineEnvelope('ai-refine-cancel'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    const cancelled = await harness.invoke('ai-cancel', 'ai-refine-cancel');
    expect(cancelled).toMatchObject({ ok: true, cancelled: true });
    const settled = await pending;
    expect(settled).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('rejects a duplicate refinement request id while the first is outstanding', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted by host')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-draft-refine', await liveRefineEnvelope('ai-refine-dupe'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    const duplicate = await harness.invoke('ai-draft-refine', await liveRefineEnvelope('ai-refine-dupe'));
    expect(duplicate).toMatchObject({ ok: false, error: { kind: 'invalid-request' } });
    await harness.invoke('ai-cancel', 'ai-refine-dupe');
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('owns cancellation before an ask has finished service admission', async () => {
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-ask', envelope('ai-early-cancel'));
    expect(await harness.invoke('ai-cancel', 'ai-early-cancel')).toMatchObject({ ok: true, cancelled: true });
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it('rejects other windows, subframes and navigated pages through the real IPC guard', async () => {
    const frame = harness.contents.mainFrame;
    const callers = [
      { sender: {}, senderFrame: frame },
      { sender: harness.contents, senderFrame: { ...frame, routingId: 4, parent: frame } },
      { sender: harness.contents, senderFrame: { ...frame, url: 'https://example.invalid/' } },
    ];
    for (const event of callers) {
      await expect(harness.invokeAs(event, 'ai-set-key', KEY, 'session')).rejects.toThrow('Unauthorized IPC caller');
      await expect(harness.invokeAs(event, 'ai-cancel', 'ai-foreign-cancel')).rejects.toThrow('Unauthorized IPC caller');
    }
    expect(harness.fetchCalls).toHaveLength(0);
    expect(await harness.invoke('ai-get-state')).toMatchObject({ state: { keyPresent: false } });
  });

  it('does not let a replacement main frame cancel the previous frame request by id', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-ask', envelope('ai-frame-owned'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    harness.contents.mainFrame = { ...harness.contents.mainFrame, routingId: 2 };
    expect(await harness.invoke('ai-cancel', 'ai-frame-owned')).toMatchObject({ ok: true, cancelled: false });
    harness.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('cancels drawing requests and probes on main-frame reload without cancelling on subframe navigation', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const request = harness.invoke('ai-ask', envelope('ai-navigation-owned'));
    const probe = harness.invoke('ai-test-connection');
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(2); });
    harness.contents.emit('did-start-navigation', {}, 'https://example.invalid/', false, false);
    expect((harness.fetchCalls[0]!.init.signal as AbortSignal).aborted).toBe(false);
    harness.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true);
    expect(await request).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(await probe).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('cancels in-flight work when the app renderer is destroyed', async () => {
    // Dedicated registration whose context window owns fake contents.
    const dir = mkdtempSync(join(tmpdir(), 'jcad-ai-ipc-destroy-'));
    try {
      const handlers = new Map<string, (ev: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>();
      const contentsListeners = new Map<string, () => void>();
      const contents = {
        once: (event: string, fn: () => void) => contentsListeners.set(event, fn),
        on: (event: string, fn: () => void) => contentsListeners.set(event, fn),
      };
      const ctx = {
        ipcMain: { handle: (c: string, fn: never) => handlers.set(c, fn) },
        mainWindow: { isDestroyed: () => false, webContents: contents },
      };
      const created: Array<(ev: unknown, wc: unknown) => void> = [];
      const app = { on: (event: string, fn: never) => { if (event === 'web-contents-created') created.push(fn); } };
      const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
        decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
      };
      const hangingFetch = (_url: string, init: Record<string, unknown>) => new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
      });
      registerAiIpc(ctx, { dir, safeStorage, fetchImpl: hangingFetch, app });
      for (const fn of created) fn(null, contents);
      const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: contents }, ...args);
      await invoke('ai-set-key', KEY, 'session');
      await invoke('ai-set-enabled', true);
      const pending = invoke('ai-ask', envelope('ai-test-destroy'));
      await vi.waitFor(() => { expect(contentsListeners.has('destroyed')).toBe(true); });
      await new Promise((r) => setTimeout(r, 20));
      contentsListeners.get('destroyed')!();
      const settled = await pending;
      expect(settled).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgetting the key cancels in-flight work', async () => {
    harness = makeHarness((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await harness.invoke('ai-set-key', KEY, 'session');
    await harness.invoke('ai-set-enabled', true);
    const pending = harness.invoke('ai-ask', envelope('ai-test-forget'));
    await vi.waitFor(() => { expect(harness.fetchCalls).toHaveLength(1); });
    await harness.invoke('ai-forget-key');
    const settled = await pending;
    expect(settled).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    const state = await harness.invoke('ai-get-state');
    expect(state).toMatchObject({ ok: true, state: { keyPresent: false } });
  });

  it('maps unexpected host failures to a fixed redacted payload', async () => {
    const bad = await harness.invoke('ai-set-model', 'not a model!!');
    expect(bad).toMatchObject({ ok: false, error: { kind: 'invalid-request' } });
    expect(JSON.stringify(bad)).not.toContain('stack');
  });
});
