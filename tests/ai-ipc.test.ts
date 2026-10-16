import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { registerAiIpc } = require('../electron/main/ipc-ai.cjs') as {
  registerAiIpc: (ctx: unknown, overrides?: Record<string, unknown>) => { service: unknown };
};

const KEY = 'sk-ipc-test-secret-1234567890';

function envelope(requestId: string): Record<string, unknown> {
  return {
    requestId,
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
  return new Response(JSON.stringify({ status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
}

interface Harness {
  handlers: Map<string, (ev: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>;
  appHandlers: Map<string, Array<(...args: unknown[]) => void>>;
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  dir: string;
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
    return body.includes('single word') ? probeResponse() : completedResponse('One line.');
  };
  const ctx = {
    ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
    mainWindow: null,
  };
  const app = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      appHandlers.set(event, [...(appHandlers.get(event) ?? []), fn]);
    },
  };
  registerAiIpc(ctx, { dir, safeStorage, fetchImpl: recordingFetch, app });
  return {
    handlers, appHandlers, fetchCalls, dir,
    invoke: async (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`channel not registered: ${channel}`);
      return fn({}, ...args);
    },
  };
}

let harness: Harness;
afterEach(() => { if (harness) rmSync(harness.dir, { recursive: true, force: true }); });

describe('ai IPC registration (guarded context)', () => {
  beforeEach(() => { harness = makeHarness(); });

  it('registers exactly the nine ai channels through the context ipcMain', () => {
    expect([...harness.handlers.keys()].sort()).toEqual([
      'ai-ask', 'ai-cancel', 'ai-forget-key', 'ai-get-state', 'ai-set-enabled',
      'ai-set-key', 'ai-set-model', 'ai-test-connection', 'ai-usage',
    ]);
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
      const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
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
