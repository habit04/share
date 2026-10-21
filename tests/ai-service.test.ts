import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { draftTestContextJson } from './ai-draft-fixture';

const require = createRequire(import.meta.url);

interface ProviderEntryShape { model: string; enabled: boolean; keyPersistence: string }
interface ConfigShape {
  version: number; provider: string;
  providers: { openai: ProviderEntryShape; anthropic: ProviderEntryShape };
}
interface KeyStoreShape {
  hasKey: () => boolean;
  encryptionAvailable: () => boolean;
  saveKey: (key: string) => Promise<void>;
  readKey: () => string | null;
  clearKey: () => Promise<void>;
}
interface ConfigStoreShape {
  load: () => Promise<{ config: ConfigShape; problem: string | null }>;
  get: () => ConfigShape;
  update: (patch: Record<string, unknown>) => Promise<ConfigShape>;
}
interface ServiceShape {
  getState: () => Promise<{
    provider: string; providers: string[]; model: string; enabled: boolean; keyPersistence: string;
    configGeneration: string;
    keyPresent: boolean; keySource: string | null; encryptionAvailable: boolean; configProblem: string | null;
  }>;
  setProvider: (provider: string) => Promise<void>;
  setKey: (key: string, persistence: string) => Promise<void>;
  replaceKey: (key: string) => Promise<void>;
  forgetKey: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  ask: (value: unknown, signal?: AbortSignal) => Promise<{
    text: string; references: string[]; providerUsage?: { inputTokens?: number; outputTokens?: number }; usage: unknown;
  }>;
  draft: (value: unknown, signal?: AbortSignal) => Promise<{
    value: unknown; configGeneration: string; usage: { inputBytes: number; outputChars: number; durationMs: number };
    providerUsage?: { inputTokens?: number; outputTokens?: number };
  }>;
  refine: (value: unknown, signal?: AbortSignal) => Promise<{
    value: unknown; configGeneration: string; usage: { inputBytes: number; outputChars: number; durationMs: number };
    providerUsage?: { inputTokens?: number; outputTokens?: number };
  }>;
  cancel: (requestId: number | string) => boolean;
  cancelAll: () => number;
  usage: () => Record<string, number>;
  testConnection: () => Promise<{ model: string; inputTokens?: number; outputTokens?: number }>;
  dispose: () => Promise<void>;
}

const { createAiKeyStore, createAiConfigStore, createAiService } = require('../electron/ai-host.cjs') as {
  createAiKeyStore: (options: Record<string, unknown>) => KeyStoreShape;
  createAiConfigStore: (options: Record<string, unknown>) => ConfigStoreShape;
  createAiService: (options: Record<string, unknown>) => ServiceShape;
};

const KEY_PATH = '/data/openai-key.bin';
const ANTHROPIC_KEY_PATH = '/data/anthropic-key.bin';
const CONFIG_PATH = '/data/ai-config.json';

type TransportImpl = (request: unknown, signal: AbortSignal) => Promise<unknown>;
type ProbeImpl = (signal: AbortSignal) => Promise<unknown>;
type DraftImpl = (provider: string, request: unknown, signal: AbortSignal) => Promise<unknown>;
type RefineImpl = (provider: string, request: unknown, signal: AbortSignal) => Promise<unknown>;

const draftPlanValue = {
  outcome: 'proposal', message: null,
  operations: [{
    op: 'createLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
    center: null, radius: null, origin: null, width: null, height: null,
    rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
    pivot: null, angleDeg: null,
  }],
};

function draftEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'ai-salt-draft-1',
    destination: { provider: 'openai', model: 'gpt-5' },
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
      configKey: 'openai|gpt-5|0',
    },
    ...over,
  };
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 3,
    destination: { provider: 'openai', model: 'gpt-5' },
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
    ...over,
  };
}

async function liveDraftEnvelope(service: ServiceShape, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const state = await service.getState();
  return draftEnvelope({ destination: { provider: state.provider, model: state.model, configGeneration: state.configGeneration }, ...over });
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

function refineEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'ai-salt-refine-1',
    destination: { provider: 'openai', model: 'gpt-5' },
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
      configKey: 'openai|gpt-5|0',
    },
    ...over,
  };
}

async function liveRefineEnvelope(service: ServiceShape, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const state = await service.getState();
  return refineEnvelope({ destination: { provider: state.provider, model: state.model, configGeneration: state.configGeneration }, ...over });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A transport that never answers until its signal aborts (then resolves late). */
function hangUntilAbort(onStart?: () => void): TransportImpl {
  return (_request, signal) => new Promise((resolve) => {
    onStart?.();
    signal.addEventListener('abort', () => resolve({ text: 'late', references: [] }));
  });
}

function makeWorld() {
  const files = new Map<string, Buffer>();
  const fail = { writes: false, deletes: false, configWrites: false };
  const writeBlocks = new Map<string, Promise<void>>();
  const seams = {
    writeFileAtomic: async (p: string, data: Buffer) => {
      if (fail.writes || (p === CONFIG_PATH && fail.configWrites)) throw new Error('disk full');
      if (writeBlocks.has(p)) await writeBlocks.get(p);
      files.set(p, Buffer.from(data));
    },
    readFile: (p: string) => {
      const data = files.get(p);
      if (!data) throw new Error('ENOENT');
      return Buffer.from(data);
    },
    removeFile: async (p: string) => {
      if (fail.deletes) throw new Error('locked');
      files.delete(p);
    },
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
    openai: createAiKeyStore({ safeStorage, filePath: KEY_PATH, ...seams }),
    anthropic: createAiKeyStore({ safeStorage, filePath: ANTHROPIC_KEY_PATH, ...seams }),
  };
  const configStore = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
  const factoryCalls: { provider: string; model: string; apiKey: string }[] = [];
  let transportImpl: TransportImpl = async () => ({
    text: 'Two objects.', references: ['e-line'], providerUsage: { inputTokens: 11, outputTokens: 7 },
  });
  let probeImpl: ProbeImpl | null = async () => ({ inputTokens: 3, outputTokens: 2 });
  let draftImpl: DraftImpl | null = async () => ({
    value: draftPlanValue, contentBytes: 321, usage: { inputTokens: 30, outputTokens: 12 },
  });
  let refineImpl: RefineImpl | null = async () => ({
    value: draftPlanValue, contentBytes: 321, usage: { inputTokens: 30, outputTokens: 12 },
  });
  const draftCalls: { provider: string; request: unknown }[] = [];
  const refineCalls: { provider: string; request: unknown }[] = [];
  const transportFactory = vi.fn((options: { provider: string; model: string; apiKey: string }) => {
    factoryCalls.push({ ...options });
    const transport = (request: unknown, signal: AbortSignal) => transportImpl(request, signal);
    if (probeImpl) {
      (transport as { probe?: ProbeImpl }).probe = (signal) => probeImpl!(signal);
    }
    if (draftImpl) {
      const impl = draftImpl;
      (transport as { draft?: (request: unknown, signal: AbortSignal) => Promise<unknown> }).draft = (request, signal) => {
        draftCalls.push({ provider: options.provider, request });
        return impl(options.provider, request, signal);
      };
    }
    if (refineImpl) {
      const impl = refineImpl;
      (transport as { refineDraft?: (request: unknown, signal: AbortSignal) => Promise<unknown> }).refineDraft = (request, signal) => {
        refineCalls.push({ provider: options.provider, request });
        return impl(options.provider, request, signal);
      };
    }
    return transport;
  });
  const newService = () => createAiService({ configStore, keyStores, transportFactory });
  return {
    files, fail, writeBlocks, keyStores, configStore, factoryCalls, transportFactory, newService, draftCalls, refineCalls,
    service: newService(),
    setTransport: (impl: TransportImpl) => { transportImpl = impl; },
    setProbe: (impl: ProbeImpl | null) => { probeImpl = impl; },
    setDraft: (impl: DraftImpl | null) => { draftImpl = impl; },
    setRefine: (impl: RefineImpl | null) => { refineImpl = impl; },
    seedConfig: (config: Record<string, unknown>) => {
      files.set(CONFIG_PATH, Buffer.from(JSON.stringify(config), 'utf8'));
    },
  };
}

describe('ai-service connection state', () => {
  it('reports defaults, encryption availability and no key', async () => {
    const world = makeWorld();
    const state = await world.service.getState();
    expect(state).toEqual({
      provider: 'openai', providers: ['openai', 'anthropic'], model: 'gpt-5', enabled: false, keyPersistence: 'session',
      keyPresent: false, keyStored: false, credentialProblem: null, keySource: null, encryptionAvailable: true, configProblem: null,
      configGeneration: state.configGeneration,
    });
    await world.service.dispose();
  });

  it('surfaces a corrupt config file as a problem code over safe defaults', async () => {
    const world = makeWorld();
    world.files.set(CONFIG_PATH, Buffer.from('{broken'));
    const state = await world.service.getState();
    expect(state.configProblem).toBe('config-unreadable');
    expect(state.model).toBe('gpt-5');
    expect(state.enabled).toBe(false);
    await world.service.dispose();
  });

  it('refuses to enable Live AI before any key is saved', async () => {
    const world = makeWorld();
    await expect(world.service.setEnabled(true)).rejects.toMatchObject({ kind: 'provider-not-configured' });
    await expect(world.service.setEnabled(true)).rejects.toThrow(/Save a key in the AI panel connection settings/);
    expect((await world.service.getState()).enabled).toBe(false);
    await world.service.dispose();
  });
});

describe('ai-service ask path', () => {
  it('refuses asks while Live AI is disabled and never builds a transport', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-session', 'session');
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'live-disabled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('refuses asks without a key even when the config says enabled', async () => {
    const world = makeWorld();
    world.seedConfig({ version: 1, provider: 'openai', model: 'gpt-5', enabled: true, keyPersistence: 'session' });
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'provider-not-configured' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('sends the validated request through a factory transport bound to provider/model/key', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const answer = await world.service.ask(envelope());
    expect(answer.text).toBe('Two objects.');
    expect(answer.providerUsage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(answer.usage).toMatchObject({ outputChars: 'Two objects.'.length });
    expect(world.factoryCalls).toEqual([{ provider: 'openai', model: 'gpt-5', apiKey: 'sk-live' }]);
    // A second ask reuses the cached transport for the same model + key.
    await world.service.ask(envelope({ requestId: 4 }));
    expect(world.factoryCalls).toHaveLength(1);
    await world.service.dispose();
  });

  it('rejects a duplicate request id while the first is outstanding', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    world.setTransport(hangUntilAbort());
    const first = world.service.ask(envelope({ requestId: 'a1b2c3d4e5f60708-3' }));
    const settled = expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(world.service.ask(envelope({ requestId: 'a1b2c3d4e5f60708-3' })))
      .rejects.toMatchObject({ kind: 'invalid-request' });
    world.service.cancelAll();
    await settled;
    await world.service.dispose();
  });

  it('accepts salt-counter ids from two controller generations without collision', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    // Same counter, different page-instance salts (docs/AI-ASSISTANT-M2.md):
    // a recreated controller must never collide with the previous one.
    const genA = await world.service.ask(envelope({ requestId: 'aaaa0000aaaa0000-1' }));
    const genB = await world.service.ask(envelope({ requestId: 'bbbb1111bbbb1111-1' }));
    expect(genA.text).toBe('Two objects.');
    expect(genB.text).toBe('Two objects.');
    await world.service.dispose();
  });

  it('cancels a queued request through the service cancel channel', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const calls = vi.fn(hangUntilAbort());
    world.setTransport(calls);
    const first = world.service.ask(envelope({ requestId: 1 }));
    const second = world.service.ask(envelope({ requestId: 2 }));
    const third = world.service.ask(envelope({ requestId: 3 }));
    const thirdSettled = expect(third).rejects.toMatchObject({ kind: 'cancelled' });
    // Let the asks reach the host: two running, the third queued.
    await vi.waitFor(() => { expect(calls).toHaveBeenCalledTimes(2); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(world.service.cancel(3)).toBe(true);
    await thirdSettled;
    expect(calls).toHaveBeenCalledTimes(2);
    world.service.cancelAll();
    await expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(second).rejects.toMatchObject({ kind: 'cancelled' });
    await world.service.dispose();
  });
});

describe('ai-service configuration changes cancel work', () => {
  it('setModel cancels an in-flight ask and rebuilds the transport for the new model', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const started = deferred();
    world.setTransport(hangUntilAbort(() => started.resolve()));
    const pending = world.service.ask(envelope());
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await started.promise;
    await world.service.setModel('gpt-5-mini');
    await settled;
    expect(world.configStore.get().providers.openai.model).toBe('gpt-5-mini');
    world.setTransport(async () => ({ text: 'mini answer', references: [] }));
    const answer = await world.service.ask(envelope({ requestId: 4, destination: { provider: 'openai', model: 'gpt-5-mini' } }));
    expect(answer.text).toBe('mini answer');
    expect(world.factoryCalls.at(-1)).toMatchObject({ model: 'gpt-5-mini', apiKey: 'sk-live' });
    await world.service.dispose();
  });

  it('disabling cancels an in-flight ask and later asks refuse as live-disabled', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const started = deferred();
    world.setTransport(hangUntilAbort(() => started.resolve()));
    const pending = world.service.ask(envelope());
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await started.promise;
    await world.service.setEnabled(false);
    await settled;
    await expect(world.service.ask(envelope({ requestId: 4 }))).rejects.toMatchObject({ kind: 'live-disabled' });
    await world.service.dispose();
  });

  it('rejects an invalid model without touching the config', async () => {
    const world = makeWorld();
    await expect(world.service.setModel('not a model')).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(world.configStore.get().providers.openai.model).toBe('gpt-5');
    await world.service.dispose();
  });
});

describe('ai-service key lifecycle', () => {
  it('a session key is memory-only: nothing is written to the key path', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-session', 'session');
    expect(world.files.has(KEY_PATH)).toBe(false);
    const state = await world.service.getState();
    expect(state.keyPresent).toBe(true);
    expect(state.keySource).toBe('session');
    expect(state.keyPersistence).toBe('session');
    await world.service.dispose();
  });

  it('switching to a session key removes a previously stored key', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-stored', 'encrypted');
    expect(world.files.has(KEY_PATH)).toBe(true);
    await world.service.setKey('sk-session', 'session');
    expect(world.files.has(KEY_PATH)).toBe(false);
    expect((await world.service.getState()).keySource).toBe('session');
    await world.service.dispose();
  });

  it('an encrypted key persists as ciphertext only and survives a restart', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-restart', 'encrypted');
    await world.service.setEnabled(true);
    const stored = world.files.get(KEY_PATH)!;
    expect(stored.toString('utf8')).not.toContain('sk-restart');
    // Restart: brand-new stores and service over the same files.
    const restartSafeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
      decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
    };
    const restartSeams = {
      writeFileAtomic: async (p: string, data: Buffer) => { world.files.set(p, Buffer.from(data)); },
      readFile: (p: string) => world.files.get(p)!,
      removeFile: async (p: string) => { world.files.delete(p); },
      fileExists: (p: string) => world.files.has(p),
    };
    const keyStores2 = {
      openai: createAiKeyStore({ safeStorage: restartSafeStorage, filePath: KEY_PATH, ...restartSeams }),
      anthropic: createAiKeyStore({ safeStorage: restartSafeStorage, filePath: ANTHROPIC_KEY_PATH, ...restartSeams }),
    };
    const configStore2 = createAiConfigStore({ filePath: CONFIG_PATH, ...restartSeams });
    const factory2 = vi.fn(() => async () => ({ text: 'after restart', references: [] }));
    const service2 = createAiService({ configStore: configStore2, keyStores: keyStores2, transportFactory: factory2 });
    const state = await service2.getState();
    expect(state.keyPresent).toBe(true);
    expect(state.keySource).toBe('stored');
    expect(state.keyPersistence).toBe('encrypted');
    expect(state.enabled).toBe(true);
    const answer = await service2.ask(envelope());
    expect(answer.text).toBe('after restart');
    expect(factory2).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-restart' });
    await service2.dispose();
    await world.service.dispose();
  });

  it('a failed encrypted save keeps the previous key in effect', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-old', 'encrypted');
    await world.service.setEnabled(true);
    world.fail.writes = true;
    await expect(world.service.setKey('sk-new', 'encrypted')).rejects.toMatchObject({ kind: 'credential-unavailable' });
    world.fail.writes = false;
    expect(world.keyStores.openai.readKey()).toBe('sk-old');
    const answer = await world.service.ask(envelope());
    expect(answer.text).toBe('Two objects.');
    expect(world.factoryCalls.at(-1)).toMatchObject({ apiKey: 'sk-old' });
    await world.service.dispose();
  });

  it('replaceKey keeps the current persistence mode', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-one', 'encrypted');
    await world.service.replaceKey('sk-two');
    expect(world.keyStores.openai.readKey()).toBe('sk-two');
    expect((await world.service.getState()).keyPersistence).toBe('encrypted');
    await world.service.dispose();
  });

  it('forgetKey cancels in-flight work and clears session and stored keys', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-stored', 'encrypted');
    await world.service.setEnabled(true);
    const started = deferred();
    world.setTransport(hangUntilAbort(() => started.resolve()));
    const pending = world.service.ask(envelope());
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await started.promise;
    await world.service.forgetKey();
    await settled;
    expect(world.files.has(KEY_PATH)).toBe(false);
    const state = await world.service.getState();
    expect(state.keyPresent).toBe(false);
    expect(state.keySource).toBeNull();
    await world.service.dispose();
  });

  it('a corrupt stored key surfaces credential-corrupt on ask, before any transport', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-stored', 'encrypted');
    await world.service.setEnabled(true);
    world.files.set(KEY_PATH, Buffer.from('tampered-bytes'));
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'credential-corrupt' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });
});

describe('ai-service connection test', () => {
  it('uses only the probe and returns bounded token counts', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    world.setTransport(async () => { throw new Error('ask transport must not run for a probe'); });
    const probe = await world.service.testConnection();
    expect(probe).toEqual({ model: 'gpt-5', inputTokens: 3, outputTokens: 2 });
    await world.service.dispose();
  });

  it('refuses without a key and when the transport has no probe', async () => {
    const world = makeWorld();
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'provider-not-configured' });
    await world.service.setKey('sk-live', 'session');
    world.setProbe(null);
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'provider-not-configured' });
    await world.service.dispose();
  });

  it('cancelAll aborts an in-flight connection test', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    const probeStarted = deferred();
    world.setProbe((signal) => new Promise((_resolve, reject) => {
      probeStarted.resolve();
      signal.addEventListener('abort', () => reject(new Error('probe socket closed')));
    }));
    const pending = world.service.testConnection();
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await probeStarted.promise;
    world.service.cancelAll();
    await settled;
    await world.service.dispose();
  });

  it('maps a probe failure to a bounded provider error', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    world.setProbe(async () => { throw new Error('socket hang up'); });
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'provider-failure' });
    await world.service.dispose();
  });
});

describe('ai-service providers', () => {
  it('keeps keys isolated per provider and sends only the selected provider key', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai-key', 'session');
    await world.service.setProvider('anthropic');
    let state = await world.service.getState();
    expect(state.provider).toBe('anthropic');
    expect(state.keyPresent).toBe(false);
    expect(state.keySource).toBeNull();
    await world.service.setKey('sk-anthropic-key', 'session');
    await world.service.setEnabled(true);
    const answer = await world.service.ask(envelope({ destination: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
    expect(answer.text).toBe('Two objects.');
    // The anthropic ask used the anthropic key and the anthropic default model only.
    expect(world.factoryCalls).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-anthropic-key' },
    ]);
    await world.service.setProvider('openai');
    state = await world.service.getState();
    expect(state.provider).toBe('openai');
    expect(state.keyPresent).toBe(true);
    expect(state.keySource).toBe('session');
    await world.service.setEnabled(true);
    await world.service.ask(envelope({ requestId: 9 }));
    expect(world.factoryCalls.at(-1)).toEqual({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-openai-key' });
    // No factory call ever paired a provider with the other provider's key.
    for (const call of world.factoryCalls) {
      if (call.provider === 'openai') expect(call.apiKey).toBe('sk-openai-key');
      else expect(call.apiKey).toBe('sk-anthropic-key');
    }
    await world.service.dispose();
  });

  it('switching providers cancels an in-flight ask', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const started = deferred();
    world.setTransport(hangUntilAbort(() => started.resolve()));
    const pending = world.service.ask(envelope());
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await started.promise;
    await world.service.setProvider('anthropic');
    await settled;
    expect(world.configStore.get().provider).toBe('anthropic');
    await world.service.dispose();
  });

  it('keeps model and enabled settings per provider', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai', 'session');
    await world.service.setModel('gpt-5-mini');
    await world.service.setEnabled(true);
    await world.service.setProvider('anthropic');
    let state = await world.service.getState();
    expect(state.model).toBe('claude-sonnet-5-5');
    expect(state.enabled).toBe(false);
    await world.service.setKey('sk-anthropic', 'session');
    await world.service.setModel('claude-opus-4-5');
    await world.service.setProvider('openai');
    state = await world.service.getState();
    expect(state.model).toBe('gpt-5-mini');
    expect(state.enabled).toBe(true);
    await world.service.setProvider('anthropic');
    state = await world.service.getState();
    expect(state.model).toBe('claude-opus-4-5');
    expect(state.enabled).toBe(false);
    await world.service.dispose();
  });

  it('forgetKey on one provider leaves the other provider key intact', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai', 'encrypted');
    await world.service.setProvider('anthropic');
    await world.service.setKey('sk-anthropic', 'encrypted');
    expect(world.files.has(ANTHROPIC_KEY_PATH)).toBe(true);
    await world.service.forgetKey();
    expect(world.files.has(ANTHROPIC_KEY_PATH)).toBe(false);
    expect((await world.service.getState()).keyPresent).toBe(false);
    expect(world.files.has(KEY_PATH)).toBe(true);
    await world.service.setProvider('openai');
    const state = await world.service.getState();
    expect(state.keyPresent).toBe(true);
    expect(state.keySource).toBe('stored');
    expect(world.keyStores.openai.readKey()).toBe('sk-openai');
    await world.service.dispose();
  });

  it('rejects an invalid provider id without changing the selection', async () => {
    const world = makeWorld();
    await expect(world.service.setProvider('bogus')).rejects.toMatchObject({ kind: 'invalid-request' });
    expect((await world.service.getState()).provider).toBe('openai');
    await world.service.dispose();
  });

  it('setProvider to the current provider does not cancel in-flight work', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const started = deferred();
    const release = deferred<{ text: string; references: string[] }>();
    world.setTransport(async () => { started.resolve(); return release.promise; });
    const pending = world.service.ask(envelope());
    await started.promise;
    await world.service.setProvider('openai');
    release.resolve({ text: 'still answered', references: [] });
    const answer = await pending;
    expect(answer.text).toBe('still answered');
    await world.service.dispose();
  });
});

describe('ai-service admission and persistence races', () => {
  it('reports corrupt ciphertext as unusable while keeping it available for Forget', async () => {
    const world = makeWorld();
    world.files.set(KEY_PATH, Buffer.from('corrupt encrypted value'));
    world.seedConfig({ version: 1, provider: 'openai', model: 'gpt-5', enabled: false, keyPersistence: 'encrypted' });
    const state = await world.service.getState();
    expect(state).toMatchObject({ keyPresent: false, keyStored: true, keySource: null, credentialProblem: 'credential-corrupt' });
    expect(world.files.has(KEY_PATH)).toBe(true);
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.forgetKey();
    expect(await world.service.getState()).toMatchObject({ keyPresent: false, keyStored: false, credentialProblem: null });
    await world.service.dispose();
  });

  it('serializes config patches so a later write merges the completed earlier write', async () => {
    const world = makeWorld();
    await world.configStore.load();
    const gate = deferred();
    world.writeBlocks.set(CONFIG_PATH, gate.promise);
    const model = world.configStore.update({ model: 'gpt-5-mini' });
    const enabled = world.configStore.update({ enabled: true });
    gate.resolve();
    await Promise.all([model, enabled]);
    expect(world.configStore.get().providers.openai).toMatchObject({ model: 'gpt-5-mini', enabled: true });
    const disk = JSON.parse(world.files.get(CONFIG_PATH)!.toString('utf8')) as ConfigShape;
    expect(disk.providers.openai).toMatchObject({ model: 'gpt-5-mini', enabled: true });
    await world.service.dispose();
  });

  it.each([
    { provider: 'unknown', model: 'gpt-5', enabled: true, keyPersistence: 'encrypted' },
    { provider: 'openai', model: 'invalid model', enabled: true, keyPersistence: 'encrypted' },
    { provider: 'openai', model: 'gpt-5', enabled: 'true', keyPersistence: 'encrypted' },
  ])('fails closed over malformed provider configuration: %j', async (bad) => {
    const world = makeWorld();
    world.seedConfig({ version: 2, provider: bad.provider, providers: {
      openai: { model: bad.model, enabled: bad.enabled, keyPersistence: bad.keyPersistence },
      anthropic: { model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'session' },
    } });
    expect(await world.service.getState()).toMatchObject({ provider: 'openai', model: 'gpt-5', enabled: false, configProblem: 'config-invalid' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('rejects missing or stale destinations without constructing a transport', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-destination-test', 'session');
    await world.service.setEnabled(true);
    for (const destination of [undefined, { provider: 'anthropic', model: 'gpt-5' }, { provider: 'openai', model: 'old-model' }]) {
      await expect(world.service.ask(envelope({ destination }))).rejects.toMatchObject({ kind: 'cancelled' });
    }
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('serializes provider/key changes and blocks asks until their writes finish', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai-before', 'session');
    await world.service.setEnabled(true);
    const gate = deferred();
    world.writeBlocks.set(CONFIG_PATH, gate.promise);
    const switched = world.service.setProvider('anthropic');
    const saved = world.service.setKey('sk-anthropic-after', 'session');
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'cancelled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([switched, saved]);
    world.writeBlocks.clear();
    await world.service.setEnabled(true);
    await world.service.ask(envelope({ destination: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
    expect(world.factoryCalls.at(-1)).toMatchObject({ provider: 'anthropic', apiKey: 'sk-anthropic-after' });
    await world.service.setProvider('openai');
    await world.service.ask(envelope());
    expect(world.factoryCalls.at(-1)).toMatchObject({ provider: 'openai', apiKey: 'sk-openai-before' });
    await world.service.dispose();
  });

  it('does not admit asks while disabling is waiting for persistence', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-disable-test', 'session');
    await world.service.setEnabled(true);
    const gate = deferred();
    world.writeBlocks.set(CONFIG_PATH, gate.promise);
    const disabling = world.service.setEnabled(false);
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'cancelled' });
    gate.resolve();
    await disabling;
    await expect(world.service.ask(envelope())).rejects.toMatchObject({ kind: 'live-disabled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('restores the exact previous ciphertext when switching to session persistence fails', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-original-ciphertext', 'encrypted');
    const original = Buffer.from(world.files.get(KEY_PATH)!);
    world.fail.configWrites = true;
    await expect(world.service.setKey('sk-replacement-secret', 'session')).rejects.toMatchObject({ kind: 'credential-unavailable' });
    expect(world.files.get(KEY_PATH)).toEqual(original);
    expect(world.keyStores.openai.readKey()).toBe('sk-original-ciphertext');
    world.fail.configWrites = false;
    await world.service.dispose();
  });

  it('replaces an encrypted key atomically without an unnecessary settings write', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-original-encrypted', 'encrypted');
    world.fail.configWrites = true;
    await world.service.setKey('sk-replacement-encrypted', 'encrypted');
    expect(world.keyStores.openai.readKey()).toBe('sk-replacement-encrypted');
    await world.service.dispose();
  });

  it('never activates orphan ciphertext after a failed persistence update and rollback, including restart', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-session-authorized', 'session');
    await world.service.setEnabled(true);
    world.fail.configWrites = true;
    world.fail.deletes = true;
    await expect(world.service.setKey('sk-orphan-ciphertext', 'encrypted')).rejects.toMatchObject({ kind: 'credential-rollback-failed' });
    expect(await world.service.getState()).toMatchObject({ keyPresent: false, keyStored: true, credentialProblem: 'credential-unavailable' });
    const restarted = world.newService();
    expect(await restarted.getState()).toMatchObject({ keyPresent: false, keyStored: true, keyPersistence: 'session' });
    await expect(restarted.ask(envelope())).rejects.toMatchObject({ kind: 'credential-unavailable' });
    expect(world.factoryCalls).toEqual([]);
    await restarted.dispose();
    await world.service.dispose();
  });

  it('loads the persisted provider before forgetting its stored key', async () => {
    const world = makeWorld();
    await world.keyStores.openai.saveKey('sk-openai-retained');
    await world.keyStores.anthropic.saveKey('sk-anthropic-forgotten');
    world.seedConfig({ version: 2, provider: 'anthropic', providers: {
      openai: { model: 'gpt-5', enabled: false, keyPersistence: 'encrypted' },
      anthropic: { model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'encrypted' },
    } });
    await world.service.forgetKey();
    expect(world.keyStores.openai.readKey()).toBe('sk-openai-retained');
    expect(world.keyStores.anthropic.hasKey()).toBe(false);
    await world.service.dispose();
  });

  it('revokes a request still awaiting initial configuration load', async () => {
    const world = makeWorld();
    const gate = deferred();
    const originalLoad = world.configStore.load;
    world.configStore.load = async () => { await gate.promise; return originalLoad(); };
    const pending = world.service.ask(envelope());
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    world.service.cancelAll();
    gate.resolve();
    await settled;
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('bounds probes even when a cancelled transport ignores abort and preserves the output-limit flag', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-probe-test', 'session');
    const started = deferred(), gate = deferred<unknown>();
    world.setProbe(async () => { started.resolve(); return gate.promise; });
    const first = world.service.testConnection();
    const settled = expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await started.promise;
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'provider-failure' });
    world.service.cancelAll();
    await settled;
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'provider-failure' });
    gate.resolve({});
    await Promise.resolve();
    await Promise.resolve();
    world.setProbe(async () => ({ inputTokens: 3, outputLimited: true, text: 'never expose this' }));
    expect(await world.service.testConnection()).toEqual({ model: 'gpt-5', inputTokens: 3, outputLimited: true });
    await world.service.dispose();
  });

  it('rejects mutation and probe entry points after disposal', async () => {
    const world = makeWorld();
    await world.service.dispose();
    await expect(world.service.setKey('sk-after-close', 'session')).rejects.toMatchObject({ kind: 'disposed' });
    await expect(world.service.testConnection()).rejects.toMatchObject({ kind: 'disposed' });
    expect(world.factoryCalls).toEqual([]);
  });
});

describe('ai-service draft path (milestone 3)', () => {
  it('pins drafts to a host epoch even when model settings return to the same values', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const request = await liveDraftEnvelope(world.service);
    const before = await world.service.getState();
    await world.service.setModel('gpt-5-mini');
    await world.service.setModel('gpt-5');
    const after = await world.service.getState();
    expect(after.model).toBe(before.model);
    expect(after.configGeneration).not.toBe(before.configGeneration);
    await expect(world.service.draft(request)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    const restarted = world.newService();
    expect((await restarted.getState()).configGeneration).not.toBe(after.configGeneration);
    await restarted.dispose();
    await world.service.dispose();
  });

  it('routes a draft to the selected provider only, with its own key and model', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const request = await liveDraftEnvelope(world.service);
    const result = await world.service.draft(request);
    expect(result.configGeneration).toBe((request.destination as { configGeneration: string }).configGeneration);
    expect(result.value).toEqual(draftPlanValue);
    expect(result.providerUsage).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(result.usage).toMatchObject({ outputChars: 321 });
    expect(world.factoryCalls).toEqual([{ provider: 'openai', model: 'gpt-5', apiKey: 'sk-live' }]);
    expect(world.draftCalls.map((call) => call.provider)).toEqual(['openai']);
    // The transport receives the validated request: prompt + exact context.
    const sent = world.draftCalls[0]!.request as { prompt: string; contextJson: string };
    expect(sent.prompt).toBe('draw a line');
    expect(sent.contextJson).toBe(draftTestContextJson(['e-line']));
    await world.service.dispose();
  });

  it('routes to Anthropic with the Anthropic key after a provider switch, never to OpenAI', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai', 'session');
    await world.service.setProvider('anthropic');
    await world.service.setKey('sk-anthropic', 'session');
    await world.service.setEnabled(true);
    const result = await world.service.draft(await liveDraftEnvelope(world.service));
    expect(result.value).toEqual(draftPlanValue);
    expect(world.factoryCalls).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-anthropic' }]);
    expect(world.draftCalls.map((call) => call.provider)).toEqual(['anthropic']);
    await world.service.dispose();
  });

  it('rejects destination mismatches without constructing a transport', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    for (const destination of [undefined, { provider: 'anthropic', model: 'gpt-5' }, { provider: 'openai', model: 'old-model' }]) {
      await expect(world.service.draft(draftEnvelope({ destination }))).rejects.toMatchObject({ kind: 'cancelled' });
    }
    expect(world.transportFactory).not.toHaveBeenCalled();
    expect(world.draftCalls).toEqual([]);
    await world.service.dispose();
  });

  it('refuses drafts while Live AI is disabled and without a key', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-session', 'session');
    await expect(world.service.draft(draftEnvelope())).rejects.toMatchObject({ kind: 'live-disabled' });
    const world2 = makeWorld();
    world2.seedConfig({ version: 1, provider: 'openai', model: 'gpt-5', enabled: true, keyPersistence: 'session' });
    await expect(world2.service.draft(draftEnvelope())).rejects.toMatchObject({ kind: 'provider-not-configured' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    expect(world2.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
    await world2.service.dispose();
  });

  it('refuses when the selected provider transport cannot draft', async () => {
    const world = makeWorld();
    world.setDraft(null);
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    await expect(world.service.draft(await liveDraftEnvelope(world.service))).rejects.toMatchObject({ kind: 'provider-not-configured' });
    await world.service.dispose();
  });

  it('surfaces an invalid plan from the provider as invalid-plan', async () => {
    const world = makeWorld();
    world.setDraft(async () => ({
      value: { outcome: 'proposal', message: null, operations: [{ op: 'explode' }] },
      contentBytes: 60,
    }));
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    await expect(world.service.draft(await liveDraftEnvelope(world.service))).rejects.toMatchObject({ kind: 'invalid-plan' });
    await world.service.dispose();
  });

  it('a settings mutation during a draft suppresses delivery of the plan', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const gate = deferred();
    world.setDraft(async (_provider, _request, signal) => {
      await gate.promise;
      if (signal.aborted) return { value: draftPlanValue, contentBytes: 10 };
      return { value: draftPlanValue, contentBytes: 10 };
    });
    const pending = world.service.draft(await liveDraftEnvelope(world.service));
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    // The mutation cancels outstanding work and bumps the configuration
    // generation, so the late plan can never be delivered as current.
    await world.service.setModel('gpt-5-mini');
    gate.resolve();
    await settled;
    await world.service.dispose();
  });

  it('blocks drafts while a settings mutation is pending, then admits them after', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const gate = deferred();
    world.writeBlocks.set(CONFIG_PATH, gate.promise);
    const switched = world.service.setProvider('anthropic');
    await expect(world.service.draft(draftEnvelope())).rejects.toMatchObject({ kind: 'cancelled' });
    expect(world.draftCalls).toEqual([]);
    gate.resolve();
    await switched;
    world.writeBlocks.clear();
    // After the mutation settles, the new provider serves drafts.
    await world.service.setKey('sk-anthropic', 'session');
    await world.service.setEnabled(true);
    const result = await world.service.draft(await liveDraftEnvelope(world.service));
    expect(result.value).toEqual(draftPlanValue);
    expect(world.draftCalls.map((call) => call.provider)).toEqual(['anthropic']);
    await world.service.dispose();
  });
});

describe('ai-service refine path (milestone 4)', () => {
  it('routes a refinement to the selected provider only, pinned to the live configuration generation', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const request = await liveRefineEnvelope(world.service);
    const result = await world.service.refine(request);
    expect(result.configGeneration).toBe((request.destination as { configGeneration: string }).configGeneration);
    expect(result.value).toEqual(draftPlanValue);
    expect(result.providerUsage).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(world.factoryCalls).toEqual([{ provider: 'openai', model: 'gpt-5', apiKey: 'sk-live' }]);
    expect(world.refineCalls.map((call) => call.provider)).toEqual(['openai']);
    expect(world.draftCalls).toEqual([]);
    // The transport receives the validated request: follow-up + exact envelope.
    const sent = world.refineCalls[0]!.request as { followUp: string; envelopeJson: string };
    expect(sent.followUp).toBe('make it longer');
    expect(sent.envelopeJson).toBe(refineEnvelopeJson());
    await world.service.dispose();
  });

  it('refines with the selected Anthropic credential without reusing the OpenAI key', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-openai-only', 'session');
    await world.service.setProvider('anthropic');
    await world.service.setKey('sk-anthropic-only', 'session');
    await world.service.setEnabled(true);
    await world.service.refine(await liveRefineEnvelope(world.service));
    expect(world.factoryCalls).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-anthropic-only' },
    ]);
    expect(world.refineCalls.map((call) => call.provider)).toEqual(['anthropic']);
    await world.service.dispose();
  });

  it('rejects an old refinement epoch after an away-and-back model change and key replacement', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-first', 'session');
    await world.service.setEnabled(true);
    const old = await liveRefineEnvelope(world.service);
    await world.service.setModel('gpt-5-mini');
    await world.service.setModel('gpt-5');
    await world.service.replaceKey('sk-replaced');
    await expect(world.service.refine(old)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.refine(await liveRefineEnvelope(world.service));
    expect(world.factoryCalls).toEqual([{ provider: 'openai', model: 'gpt-5', apiKey: 'sk-replaced' }]);
    await world.service.dispose();
  });

  it('rejects destination and generation mismatches without constructing a transport', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const live = await liveRefineEnvelope(world.service);
    const staleGeneration = {
      ...(live.destination as Record<string, unknown>),
      configGeneration: '00000000-0000-4000-8000-000000000000:99',
    };
    for (const destination of [undefined, { provider: 'anthropic', model: 'gpt-5' }, staleGeneration]) {
      await expect(world.service.refine(refineEnvelope({ destination }))).rejects.toMatchObject({ kind: 'cancelled' });
    }
    expect(world.transportFactory).not.toHaveBeenCalled();
    expect(world.refineCalls).toEqual([]);
    await world.service.dispose();
  });

  it('refuses refinements while Live AI is disabled', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-session', 'session');
    await expect(world.service.refine(refineEnvelope())).rejects.toMatchObject({ kind: 'live-disabled' });
    expect(world.transportFactory).not.toHaveBeenCalled();
    await world.service.dispose();
  });

  it('refuses when the selected provider transport cannot refine', async () => {
    const world = makeWorld();
    world.setRefine(null);
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    await expect(world.service.refine(await liveRefineEnvelope(world.service))).rejects.toMatchObject({ kind: 'provider-not-configured' });
    await world.service.dispose();
  });

  it('surfaces an invalid replacement plan from the provider as invalid-plan', async () => {
    const world = makeWorld();
    world.setRefine(async () => ({
      value: { outcome: 'proposal', message: null, operations: [{ op: 'explode' }] },
      contentBytes: 60,
    }));
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    await expect(world.service.refine(await liveRefineEnvelope(world.service))).rejects.toMatchObject({ kind: 'invalid-plan' });
    await world.service.dispose();
  });

  it('a settings mutation during a refinement suppresses delivery of the replacement plan', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-live', 'session');
    await world.service.setEnabled(true);
    const gate = deferred();
    world.setRefine(async (_provider, _request, signal) => {
      await gate.promise;
      if (signal.aborted) return { value: draftPlanValue, contentBytes: 10 };
      return { value: draftPlanValue, contentBytes: 10 };
    });
    const pending = world.service.refine(await liveRefineEnvelope(world.service));
    const settled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await world.service.setModel('gpt-5-mini');
    gate.resolve();
    await settled;
    await world.service.dispose();
  });
});
