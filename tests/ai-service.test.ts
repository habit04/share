import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface ConfigShape { version: number; provider: string; model: string; enabled: boolean; keyPersistence: string }
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
    provider: string; model: string; enabled: boolean; keyPersistence: string;
    keyPresent: boolean; keySource: string | null; encryptionAvailable: boolean; configProblem: string | null;
  }>;
  setKey: (key: string, persistence: string) => Promise<void>;
  replaceKey: (key: string) => Promise<void>;
  forgetKey: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  ask: (value: unknown, signal?: AbortSignal) => Promise<{
    text: string; references: string[]; providerUsage?: { inputTokens?: number; outputTokens?: number }; usage: unknown;
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

const KEY_PATH = '/data/ai-key.bin';
const CONFIG_PATH = '/data/ai-config.json';

type TransportImpl = (request: unknown, signal: AbortSignal) => Promise<unknown>;
type ProbeImpl = (signal: AbortSignal) => Promise<unknown>;

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 3,
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
  const fail = { writes: false, deletes: false };
  const seams = {
    writeFileAtomic: async (p: string, data: Buffer) => {
      if (fail.writes) throw new Error('disk full');
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
  const keyStore = createAiKeyStore({ safeStorage, filePath: KEY_PATH, ...seams });
  const configStore = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
  const factoryCalls: { provider: string; model: string; apiKey: string }[] = [];
  let transportImpl: TransportImpl = async () => ({
    text: 'Two objects.', references: ['e-line'], providerUsage: { inputTokens: 11, outputTokens: 7 },
  });
  let probeImpl: ProbeImpl | null = async () => ({ inputTokens: 3, outputTokens: 2 });
  const transportFactory = vi.fn((options: { provider: string; model: string; apiKey: string }) => {
    factoryCalls.push({ ...options });
    const transport = (request: unknown, signal: AbortSignal) => transportImpl(request, signal);
    if (probeImpl) {
      (transport as { probe?: ProbeImpl }).probe = (signal) => probeImpl!(signal);
    }
    return transport;
  });
  const newService = () => createAiService({ configStore, keyStore, transportFactory });
  return {
    files, fail, keyStore, configStore, factoryCalls, transportFactory, newService,
    service: newService(),
    setTransport: (impl: TransportImpl) => { transportImpl = impl; },
    setProbe: (impl: ProbeImpl | null) => { probeImpl = impl; },
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
      provider: 'openai', model: 'gpt-5', enabled: false, keyPersistence: 'session',
      keyPresent: false, keySource: null, encryptionAvailable: true, configProblem: null,
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
    await expect(world.service.setEnabled(true)).rejects.toThrow(/Save an API key before enabling/);
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
    expect(world.configStore.get().model).toBe('gpt-5-mini');
    world.setTransport(async () => ({ text: 'mini answer', references: [] }));
    const answer = await world.service.ask(envelope({ requestId: 4 }));
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
    expect(world.configStore.get().model).toBe('gpt-5');
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
    const keyStore2 = createAiKeyStore({
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
        decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
      },
      filePath: KEY_PATH,
      writeFileAtomic: async (p: string, data: Buffer) => { world.files.set(p, Buffer.from(data)); },
      readFile: (p: string) => world.files.get(p)!,
      removeFile: async (p: string) => { world.files.delete(p); },
      fileExists: (p: string) => world.files.has(p),
    });
    const configStore2 = createAiConfigStore({
      filePath: CONFIG_PATH,
      writeFileAtomic: async (p: string, data: Buffer) => { world.files.set(p, Buffer.from(data)); },
      readFile: (p: string) => world.files.get(p)!,
      fileExists: (p: string) => world.files.has(p),
    });
    const factory2 = vi.fn(() => async () => ({ text: 'after restart', references: [] }));
    const service2 = createAiService({ configStore: configStore2, keyStore: keyStore2, transportFactory: factory2 });
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
    expect(world.keyStore.readKey()).toBe('sk-old');
    const answer = await world.service.ask(envelope());
    expect(answer.text).toBe('Two objects.');
    expect(world.factoryCalls.at(-1)).toMatchObject({ apiKey: 'sk-old' });
    await world.service.dispose();
  });

  it('replaceKey keeps the current persistence mode', async () => {
    const world = makeWorld();
    await world.service.setKey('sk-one', 'encrypted');
    await world.service.replaceKey('sk-two');
    expect(world.keyStore.readKey()).toBe('sk-two');
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
