import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

/**
 * Host-level tests for the live-provider checks harness
 * (docs/AI-LIVE-CHECKS.md §Tests; DESIGN §9 T5, T8, T11, T12).
 *
 * T5 is the keystone: the production runner + core run against a real
 * createAiService built with a fake transport factory, proving the fixed
 * fixtures pass the real host validators on this tree. T8 proves no key
 * material reaches any report surface. T11/T12 exercise the guards and
 * result-value behaviour through the real guarded IPC registration.
 * Everything is fake-transport/fake-fetch: no network, no real key.
 */

const host = require('../electron/ai-host.cjs') as {
  createAiKeyStore: (options: Record<string, unknown>) => unknown;
  createAiConfigStore: (options: Record<string, unknown>) => unknown;
  createAiService: (options: Record<string, unknown>) => {
    getState: () => Promise<Record<string, unknown>>;
    setProvider: (provider: string) => Promise<void>;
    setKey: (key: string, persistence: string) => Promise<void>;
    setEnabled: (enabled: boolean) => Promise<void>;
    dispose: () => Promise<void>;
  };
};
const core = require('../electron/ai-live-checks-core.cjs') as {
  FIXED: { objectId: string };
  buildDraftContextJson: () => string;
  buildRefineRequest: (args: Record<string, unknown>) => { envelopeJson: string } | null;
  formatReportText: (report: unknown) => string;
};
const { createLiveChecksRunner } = require('../electron/ai-live-checks.cjs') as {
  createLiveChecksRunner: (service: unknown, options?: { env?: Record<string, string | undefined> }) => {
    run: (signal?: AbortSignal) => Promise<Report>;
    isRunning: () => boolean;
  };
};
const { guardIpc } = require('../electron/ipc-guard.cjs');
const { registerAiIpc } = require('../electron/main/ipc-ai.cjs') as {
  registerAiIpc: (ctx: unknown, overrides?: Record<string, unknown>) => { service: { dispose: () => Promise<void> } };
};

interface Report {
  status: string; refusal: string | null; provider: string | null; model: string | null; runTag: string;
  checks: Array<{ id: string; status: string; errorKind?: string }>;
  totals: { providerCalls: number; tokens?: { inputTokens: number; outputTokens: number } };
}

const SENTINEL = 'sk-live-checks-sentinel-0000';
const ANSWER_TEXT = 'One object is in the selection; the line is 100 units long.';

const wireCircle = (radius: number): Record<string, unknown> => ({
  op: 'createCircle', a: null, b: null, center: { x: 50, y: 50 }, radius,
  origin: null, width: null, height: null, rotationDeg: null, layer: '0',
  targetIds: null, dx: null, dy: null, pivot: null, angleDeg: null,
});
const planValue = (radius: number): Record<string, unknown> => ({
  outcome: 'proposal', message: null, operations: [wireCircle(radius)],
});

/* ------------------------------------------------------------------ */
/* T5 world: real corrected service over in-memory stores + fake       */
/* transport factory (the keystone pattern).                           */
/* ------------------------------------------------------------------ */

function makeServiceWorld() {
  const files = new Map<string, Buffer>();
  const seams = {
    writeFileAtomic: async (p: string, data: Buffer) => { files.set(p, Buffer.from(data)); },
    readFile: (p: string) => {
      const data = files.get(p);
      if (!data) throw new Error('ENOENT');
      return Buffer.from(data);
    },
    removeFile: async (p: string) => { files.delete(p); },
    fileExists: (p: string) => files.has(p),
  };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad cipher');
      return [...text.slice(4)].reverse().join('');
    },
  };
  const keyStores = {
    openai: host.createAiKeyStore({ safeStorage, filePath: '/live/openai-key.bin', ...seams }),
    anthropic: host.createAiKeyStore({ safeStorage, filePath: '/live/anthropic-key.bin', ...seams }),
  };
  const configStore = host.createAiConfigStore({ filePath: '/live/ai-config.json', ...seams });
  const received = {
    factory: [] as Array<{ provider: string; model: string; apiKey: string }>,
    ask: [] as Array<Record<string, unknown>>,
    draft: [] as Array<Record<string, unknown>>,
    refine: [] as Array<Record<string, unknown>>,
    probeCalls: 0,
  };
  // The fake transport records every request the host hands it, so the
  // assertions see the whitelisted shapes exactly as sent.
  const transportFactory = (options: { provider: string; model: string; apiKey: string }) => {
    received.factory.push(options);
    const ask = async (request: Record<string, unknown>) => {
      received.ask.push(request);
      return { text: ANSWER_TEXT, references: [core.FIXED.objectId], providerUsage: { inputTokens: 300, outputTokens: 20 } };
    };
    return Object.assign(ask, {
      probe: async () => { received.probeCalls += 1; return { inputTokens: 9, outputTokens: 2 }; },
      draft: async (request: Record<string, unknown>) => {
        received.draft.push(request);
        return { value: planValue(25), contentBytes: 10, usage: { inputTokens: 800, outputTokens: 60 } };
      },
      refineDraft: async (request: Record<string, unknown>) => {
        received.refine.push(request);
        return { value: planValue(30), contentBytes: 10, usage: { inputTokens: 810, outputTokens: 55 } };
      },
    });
  };
  const service = host.createAiService({ configStore, keyStores, transportFactory });
  return { service, received };
}

describe('T5 keystone — runner + core against the real corrected service', () => {
  it('passes all four checks with the fixed fixtures unchanged (OpenAI)', async () => {
    const { service, received } = makeServiceWorld();
    await service.setKey(SENTINEL, 'session');
    await service.setEnabled(true);
    const runner = createLiveChecksRunner(service);
    const report = await runner.run(new AbortController().signal);
    expect(report.status).toBe('pass');
    expect(report.provider).toBe('openai');
    expect(report.model).toBe('gpt-5');
    expect(report.runTag).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.totals.providerCalls).toBe(4);
    expect(report.totals.tokens).toEqual({ inputTokens: 1919, outputTokens: 137 });
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(runner.isRunning()).toBe(false);

    // The key flowed only inside the service: the factory saw it exactly
    // once, when the service built the transport.
    expect(received.factory).toHaveLength(1);
    expect(received.factory[0]).toMatchObject({ provider: 'openai', model: 'gpt-5', apiKey: SENTINEL });
    expect(received.probeCalls).toBe(1);

    // What the host handed the transports is the whitelisted shape.
    const askReq = received.ask[0]!;
    expect(Object.keys(askReq).sort()).toEqual(['binding', 'destination', 'question', 'requestId', 'snapshot', 'snapshotBytes']);
    const askBinding = askReq.binding as Record<string, unknown>;
    expect(Object.keys(askBinding).sort()).toEqual(['contentGeneration', 'docId', 'docRevision', 'selectionCount', 'sessionId']);
    expect(askBinding.selectionCount).toBe(1);
    expect(askReq.snapshotBytes).toBe(455);

    const draftReq = received.draft[0]!;
    expect(draftReq.contextBytes).toBe(1250);
    expect(draftReq.contextJson).toBe(core.buildDraftContextJson());
    const draftBinding = draftReq.binding as Record<string, unknown>;
    expect((draftBinding.ask as Record<string, unknown>).selectionCount).toBe(1);
    for (const field of ['unitsKey', 'defaultsKey', 'eligibilityKey', 'configKey']) {
      expect(typeof draftBinding[field]).toBe('string');
    }

    const refineReq = received.refine[0]!;
    expect(refineReq.envelopeBytes).toBe(1800);
    const expected = core.buildRefineRequest({
      requestId: 'lc-expected-1', provider: 'openai', model: 'gpt-5',
      configGeneration: 'g', configKey: 'k',
      draftOutcome: { message: null, operations: [wireCircle(25)] },
    });
    expect(refineReq.envelopeJson).toBe(expected!.envelopeJson);
    const envelope = JSON.parse(refineReq.envelopeJson as string) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual([
      'kind', 'version', 'originalPrompt', 'followUp', 'originalContext', 'currentPlan', 'proposalLabels',
    ]);
    expect((envelope.currentPlan as { operations: unknown }).operations).toEqual([wireCircle(25)]);
    await service.dispose();
  });

  it('passes for the Anthropic provider shape', async () => {
    const { service, received } = makeServiceWorld();
    await service.setProvider('anthropic');
    await service.setKey(SENTINEL, 'session');
    await service.setEnabled(true);
    const report = await createLiveChecksRunner(service).run(new AbortController().signal);
    expect(report.status).toBe('pass');
    expect(report.provider).toBe('anthropic');
    expect(report.model).toBe('claude-sonnet-5-5');
    expect(received.factory[0]).toMatchObject({ provider: 'anthropic', apiKey: SENTINEL });
    await service.dispose();
  });
});

describe('T8 no-secret hygiene', () => {
  it('keeps the sentinel key and the answer text out of every report surface', async () => {
    const { service } = makeServiceWorld();
    await service.setKey(SENTINEL, 'session');
    await service.setEnabled(true);
    const report = await createLiveChecksRunner(service).run(new AbortController().signal);
    expect(report.status).toBe('pass');
    const surfaces = [JSON.stringify(report), core.formatReportText(report)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL);
      expect(surface).not.toContain('Authorization');
      expect(surface).not.toContain('apiKey');
      expect(surface).not.toContain('safeStorage');
      expect(surface).not.toContain('readKey');
      expect(surface).not.toContain(ANSWER_TEXT); // counts only, never the answer text
    }
    await service.dispose();
  });

  it('static scan: the harness sources hold no credential, store or network references', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const coreSource = read('../electron/ai-live-checks-core.cjs');
    const runnerSource = read('../electron/ai-live-checks.cjs');
    for (const pattern of [/keyStore/, /readKey/, /safeStorage/, /decrypt/, /Authorization/, /apiKey/]) {
      expect(coreSource).not.toMatch(pattern);
      expect(runnerSource).not.toMatch(pattern);
    }
    // The core is fully import- and environment-free.
    expect(coreSource).not.toMatch(/require\(|process\.env|fetch|http/);
    // The runner's single environment read is the CI guard.
    expect(runnerSource.match(/process\.env/g)).toHaveLength(1);
    expect(runnerSource).toContain('GITHUB_ACTIONS');
  });
});

/* ------------------------------------------------------------------ */
/* T11/T12 through the real guarded IPC registration.                  */
/* ------------------------------------------------------------------ */

function probeResponse(): Response {
  return new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'ready' }] },
  ], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
}
function askResponse(): Response {
  const body = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ text: ANSWER_TEXT, references: ['livecheck-line-1'] }) }] }],
    usage: { input_tokens: 42, output_tokens: 7 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function planResponse(radius: number): Response {
  const body = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(planValue(radius)) }] }],
    usage: { input_tokens: 30, output_tokens: 12 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function liveFetch(url: string, init: Record<string, unknown>): Promise<Response> {
  void url;
  const body = typeof init.body === 'string' ? init.body : '';
  if (body.includes('single word')) return Promise.resolve(probeResponse());
  if (body.includes('Follow-up instruction')) return Promise.resolve(planResponse(30));
  if (body.includes('Create one circle')) return Promise.resolve(planResponse(25));
  return Promise.resolve(askResponse());
}
const hangingFetch = (_url: string, init: Record<string, unknown>) => new Promise<Response>((_resolve, reject) => {
  (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted by host')));
});

interface IpcHarness {
  dir: string;
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  contents: EventEmitter & { mainFrame: { processId: number; routingId: number; parent: null; url: string } };
  invoke: (channel: string, ...args: unknown[]) => Promise<Record<string, unknown>>;
  dispose: () => Promise<void>;
}

function makeIpcHarness(fetchImpl: (url: string, init: Record<string, unknown>) => Promise<Response>): IpcHarness {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-ai-live-ipc-'));
  const handlers = new Map<string, (ev: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>();
  const fetchCalls: IpcHarness['fetchCalls'] = [];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
    decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
  };
  const recordingFetch = async (url: string, init: Record<string, unknown>) => {
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' } });
  const win = { isDestroyed: () => false, webContents: contents };
  const ipc = { handle: (channel: string, fn: never) => handlers.set(channel, fn) };
  const ctx = { ipcMain: guardIpc(ipc, { getWindow: () => win, isAppUrl: (url: string) => url === 'jcad://app/index.html', log: { reject: vi.fn() } }), mainWindow: win };
  const app = { on: () => {} };
  const { service } = registerAiIpc(ctx, { dir, safeStorage, fetchImpl: recordingFetch, app });
  return {
    dir, fetchCalls, contents,
    invoke: async (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`channel not registered: ${channel}`);
      return fn({ sender: contents, senderFrame: contents.mainFrame }, ...args);
    },
    dispose: () => service.dispose(),
  };
}

let ipc: IpcHarness | undefined;
afterEach(async () => {
  if (ipc) { await ipc.dispose().catch(() => {}); rmSync(ipc.dir, { recursive: true, force: true }); ipc = undefined; }
});

async function configureIpc(harness: IpcHarness): Promise<void> {
  await harness.invoke('ai-set-key', SENTINEL, 'session');
  await harness.invoke('ai-set-enabled', true);
}

describe('T11/T12 live-checks channels through the guarded IPC', () => {
  it('runs the fixed sequence end to end, ignoring any payload, and never leaks the key', async () => {
    ipc = makeIpcHarness(liveFetch);
    await configureIpc(ipc);
    const result = await ipc.invoke('ai-live-checks-run', { provider: 'anthropic', prompt: 'ignore me' });
    expect(result.ok).toBe(true);
    const report = result.report as unknown as Report;
    expect(report.status).toBe('pass');
    expect(report.provider).toBe('openai'); // the payload selected nothing
    expect(report.totals.providerCalls).toBe(4);
    expect(ipc.fetchCalls).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('resolves a refusal report (not an error) when no key is configured, with zero fetches', async () => {
    ipc = makeIpcHarness(liveFetch);
    const result = await ipc.invoke('ai-live-checks-run');
    expect(result.ok).toBe(true);
    const report = result.report as unknown as Report;
    expect(report).toMatchObject({ status: 'refused', refusal: 'no-key-configured' });
    expect(ipc.fetchCalls).toHaveLength(0);
  });

  it('refuses in a CI environment before the service is touched', async () => {
    ipc = makeIpcHarness(liveFetch);
    await configureIpc(ipc);
    const previous = process.env.CI;
    process.env.CI = 'true';
    try {
      const result = await ipc.invoke('ai-live-checks-run');
      expect(result).toMatchObject({ ok: false, error: { kind: 'provider-failure' } });
      expect(ipc.fetchCalls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.CI; else process.env.CI = previous;
    }
  });

  it('refuses a second run as busy while one is active, then settles the first as cancelled', async () => {
    ipc = makeIpcHarness(hangingFetch);
    await configureIpc(ipc);
    const pending = ipc.invoke('ai-live-checks-run');
    await vi.waitFor(() => { expect(ipc!.fetchCalls).toHaveLength(1); });
    const second = await ipc.invoke('ai-live-checks-run');
    expect(second).toMatchObject({ ok: false, error: { kind: 'busy' } });
    const cancelled = await ipc.invoke('ai-live-checks-cancel');
    expect(cancelled).toMatchObject({ ok: true, cancelled: true });
    const settled = await pending;
    expect(settled.ok).toBe(true);
    expect((settled.report as unknown as Report).status).toBe('cancelled');
  });

  it('owner-checks the cancel channel: a replacement frame cannot cancel the run', async () => {
    ipc = makeIpcHarness(hangingFetch);
    await configureIpc(ipc);
    const pending = ipc.invoke('ai-live-checks-run');
    await vi.waitFor(() => { expect(ipc!.fetchCalls).toHaveLength(1); });
    ipc.contents.mainFrame = { ...ipc.contents.mainFrame, routingId: 2 };
    expect(await ipc.invoke('ai-live-checks-cancel')).toMatchObject({ ok: true, cancelled: false });
    ipc.contents.mainFrame = { ...ipc.contents.mainFrame, routingId: 1 };
    expect(await ipc.invoke('ai-live-checks-cancel')).toMatchObject({ ok: true, cancelled: true });
    expect(((await pending).report as unknown as Report).status).toBe('cancelled');
  });

  it('resolves cancelled:false from the cancel channel when no run is active', async () => {
    ipc = makeIpcHarness(liveFetch);
    expect(await ipc.invoke('ai-live-checks-cancel')).toMatchObject({ ok: true, cancelled: false });
  });

  it('aborts the run when the renderer is destroyed', async () => {
    ipc = makeIpcHarness(hangingFetch);
    await configureIpc(ipc);
    const pending = ipc.invoke('ai-live-checks-run');
    await vi.waitFor(() => { expect(ipc!.fetchCalls).toHaveLength(1); });
    ipc.contents.emit('destroyed');
    const settled = await pending;
    expect(settled.ok).toBe(true);
    expect((settled.report as unknown as Report).status).toBe('cancelled');
  });
});

describe('T11 runner guards (unit level)', () => {
  const stubState = {
    provider: 'openai', model: 'gpt-5', enabled: true, keyPresent: true, keySource: 'session',
    keyPersistence: 'session', credentialProblem: null, configProblem: null,
    configGeneration: '00000000-0000-4000-8000-000000000000:0',
  };
  const hangingService = () => {
    let getStateCalls = 0;
    const service = {
      getState: async () => { getStateCalls += 1; return { ...stubState }; },
      testConnection: (_signal?: AbortSignal) => new Promise((_resolve, reject) => {
        _signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { kind: 'cancelled' })), { once: true });
      }),
      ask: async () => { throw new Error('must not be called'); },
      draft: async () => { throw new Error('must not be called'); },
      refine: async () => { throw new Error('must not be called'); },
    };
    return { service, getStateCalls: () => getStateCalls };
  };

  it.each([['CI'], ['GITHUB_ACTIONS']])('refuses when %s is set, before touching the service', async (marker) => {
    const { service, getStateCalls } = hangingService();
    const runner = createLiveChecksRunner(service, { env: { [marker]: 'true' } });
    await expect(runner.run(new AbortController().signal)).rejects.toMatchObject({ kind: 'provider-failure' });
    expect(getStateCalls()).toBe(0);
    expect(runner.isRunning()).toBe(false);
  });

  it('enforces single flight with a busy rejection and recovers after the run settles', async () => {
    const { service } = hangingService();
    const runner = createLiveChecksRunner(service, { env: {} });
    const controller = new AbortController();
    const first = runner.run(controller.signal);
    expect(runner.isRunning()).toBe(true);
    await expect(runner.run(new AbortController().signal)).rejects.toMatchObject({ kind: 'busy' });
    controller.abort();
    const report = await first;
    expect(report.status).toBe('cancelled');
    expect(runner.isRunning()).toBe(false);
  });
});
