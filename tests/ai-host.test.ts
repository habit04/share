import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { buildSelectionSnapshot, serializeSnapshot } from '../src/ai/snapshot';
import type { AiBinding, AiSnapshotSource } from '../src/ai/types';

const require = createRequire(import.meta.url);
const {
  AI_LIMITS, aiRequest, aiAnswer, createAiHost, createAiKeyStore,
  AI_PROVIDERS, AI_DEFAULT_MODEL, AI_PROVIDER_DEFAULT_MODELS, validateAiModel, createAiConfigStore, createAiService,
} = require('../electron/ai-host.cjs') as {
  AI_LIMITS: Record<string, number>;
  aiRequest: (value: unknown) => { requestId: number | string; question: string; snapshotBytes: number; snapshot: Record<string, unknown> };
  aiAnswer: (value: unknown) => { text: string; references: string[]; providerUsage?: { inputTokens?: number; outputTokens?: number } };
  createAiHost: (options?: {
    transport?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
    timeoutMs?: number;
    maxConcurrent?: number;
    maxPending?: number;
  }) => {
    ask: (value: unknown, signal?: AbortSignal) => Promise<{ text: string; references: string[]; usage: unknown; providerUsage?: { inputTokens?: number; outputTokens?: number } }>;
    cancel: (requestId: number | string) => boolean;
    cancelAll: () => number;
    usage: () => Record<string, number>;
    dispose: () => Promise<void>;
  };
  createAiKeyStore: (options: {
    safeStorage: unknown; filePath: string; fsImpl?: unknown; platform?: string;
    writeFileAtomic?: unknown; readFile?: unknown; removeFile?: unknown; fileExists?: unknown;
  }) => {
    hasKey: () => boolean;
    encryptionAvailable: () => boolean;
    saveKey: (key: string) => Promise<void>;
    readKey: () => string | null;
    clearKey: () => Promise<void>;
  };
  AI_PROVIDERS: string[];
  AI_DEFAULT_MODEL: string;
  AI_PROVIDER_DEFAULT_MODELS: Record<string, string>;
  validateAiModel: (model: unknown) => boolean;
  createAiConfigStore: (options: {
    filePath: string; writeFileAtomic: unknown; readFile: unknown; fileExists: unknown;
  }) => {
    load: () => Promise<{ config: AiConfigShape; problem: string | null }>;
    get: () => AiConfigShape;
    update: (patch: Record<string, unknown>) => Promise<AiConfigShape>;
  };
  createAiService: (options: {
    configStore: unknown; keyStores: unknown; transportFactory: unknown;
  }) => {
    getState: () => Promise<{ enabled: boolean; keyPresent: boolean }>;
    ask: (value: unknown) => Promise<unknown>;
    dispose: () => Promise<void>;
  };
};

interface AiProviderEntryShape { model: string; enabled: boolean; keyPersistence: string }
interface AiConfigShape {
  version: number; provider: string;
  providers: { openai: AiProviderEntryShape; anthropic: AiProviderEntryShape };
}

const root = join(__dirname, '..');

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

describe('ai-host request validator', () => {
  it('accepts a bounded envelope and copies only whitelisted fields', () => {
    const req = aiRequest(envelope({ extra: 'drop me', evil: { nested: true } }));
    expect(req.requestId).toBe(3);
    expect(req.question).toBe('how many objects?');
    expect(req.snapshotBytes).toBeGreaterThan(0);
    expect(JSON.stringify(req)).not.toContain('drop me');
  });

  it('rejects malformed envelopes', () => {
    expect(() => aiRequest(null)).toThrow(/Invalid AI request/);
    expect(() => aiRequest(envelope({ requestId: -1 }))).toThrow(/request id/);
    expect(() => aiRequest(envelope({ question: '' }))).toThrow(/question/);
    expect(() => aiRequest(envelope({ question: 'x'.repeat(AI_LIMITS.maxQuestionChars! + 1) }))).toThrow(/question/);
    expect(() => aiRequest(envelope({ snapshot: { kind: 'nope' } }))).toThrow(/snapshot/);
  });

  it('accepts milestone-2 string request ids (salt-counter scheme)', () => {
    const req = aiRequest(envelope({ requestId: 'a1b2c3d4e5f60708-12' }));
    expect(req.requestId).toBe('a1b2c3d4e5f60708-12');
    expect(aiRequest(envelope({ requestId: 'A2345678' })).requestId).toBe('A2345678');
    expect(aiRequest(envelope({ requestId: 'z'.repeat(96) })).requestId).toBe('z'.repeat(96));
  });

  it.each(['short', '-abcdefgh', 'abcd efgh', 'under_score-1', 'z'.repeat(97), 1.5, Number.NaN, null, undefined])(
    'rejects an invalid request id: %o', (requestId) => {
      expect(() => aiRequest(envelope({ requestId }))).toThrow(/request id/);
    },
  );

  it('carries bounded provider token usage through the answer, field by field', () => {
    expect(aiAnswer({ text: 'ok', references: [], providerUsage: { inputTokens: 3, outputTokens: 4 } }).providerUsage)
      .toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(aiAnswer({ text: 'ok', references: [], providerUsage: { inputTokens: 3, outputTokens: -1 } }).providerUsage)
      .toEqual({ inputTokens: 3 });
    expect(aiAnswer({ text: 'ok', references: [], providerUsage: { inputTokens: 1.5, outputTokens: '4' } }).providerUsage)
      .toBeUndefined();
    expect(aiAnswer({ text: 'ok', references: [], providerUsage: 'lots' }).providerUsage).toBeUndefined();
    expect(aiAnswer({ text: 'ok', references: [] }).providerUsage).toBeUndefined();
  });

  it('rejects a snapshot over the byte limit even if its header claims otherwise', () => {
    const fat = envelope();
    (fat.snapshot as { objects: unknown[] }).objects = Array.from({ length: 200 }, (_, i) => ({
      id: `e-${i}`, type: 'text', layer: 'TAGS', geometry: {}, text: 'y'.repeat(500),
    }));
    (fat.snapshot as { selection: unknown }).selection = {
      total: 200, included: 200, omittedCount: 0, omitted: [], omittedListTruncated: false,
    };
    expect(() => aiRequest(fat)).toThrow(/size limit/);
  });

  it('rebuilds every snapshot level and strips raw data and geometry from other types', () => {
    const value = envelope();
    const snapshot = value.snapshot as Record<string, unknown>;
    snapshot.filePath = 'C:/private/customer.dwg';
    snapshot.meta = { secret: 'do not send' };
    snapshot.serializedBytes = 1;
    const obj = (snapshot.objects as Record<string, unknown>[])[0]!;
    obj.raw = { cadGraph: 'private graph' };
    obj.geometry = { a: { x: 1, y: 2, filePath: 'private' }, length: 2, block: 'not a line field', code: 'private' };
    obj.attributes = [{ tag: 'PRIVATE', value: 'not line data' }];
    const request = aiRequest(value);
    expect(JSON.stringify(request)).not.toMatch(/private|cadGraph|not a line|not line data|filePath/);
    expect((request.snapshot.objects as Record<string, unknown>[])[0]!.geometry).toEqual({ a: { x: 1, y: 2 }, length: 2 });
    expect(request.snapshotBytes).toBe(Buffer.byteLength(JSON.stringify(request.snapshot), 'utf8'));
    expect(request.snapshot.serializedBytes).toBe(request.snapshotBytes);
  });

  it('accepts the real renderer snapshot contract without losing names, identity or geometry', () => {
    const insertId = `insert-${'i'.repeat(400)}`;
    const omittedId = `missing-${'m'.repeat(4000)}`;
    const entities: Entity[] = [
      {
        type: 'insert', id: insertId, layer: 'L'.repeat(500), color: 'ByLayer',
        block: 'ARRAY', position: { x: 1, y: 2 }, rotation: 0.4, scale: 2, scaleY: 3,
        mirror: true, columns: 3, rows: 2, columnSpacing: 4, rowSpacing: 5,
        attributes: { TAG: 'value' },
      },
      {
        type: 'ellipse', id: 'partial-ellipse', layer: 'ELLIPSES', color: 'ByLayer',
        center: { x: 3, y: 4 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5,
        startParam: Math.PI / 4, endParam: Math.PI,
      },
    ];
    const binding: AiBinding = {
      sessionId: 1, docId: 'd'.repeat(300), contentGeneration: 1, docRevision: 7, docLoadCount: 1,
      space: { layout: 'layout-'.repeat(60), viewport: 'viewport-'.repeat(50) },
      selectionIds: [insertId, 'partial-ellipse', omittedId, ...Array.from({ length: 1300 }, (_, i) => `missing-${i}`)],
    };
    const source: AiSnapshotSource = {
      binding: () => binding,
      units: () => DEFAULT_UNITS,
      selectedEntities: () => entities,
      entityById: (id) => entities.find((entity) => entity.id === id),
      boundsFor: () => null,
      missingIdKind: () => 'missing-object',
    };
    const snapshot = buildSelectionSnapshot(source);
    const dirtySnapshot = {
      ...snapshot, filePath: 'private-path', serializedBytes: 1,
      objects: snapshot.objects.map((object) => ({
        ...object, raw: 'private-raw', geometry: { ...object.geometry, filePath: 'private-geometry' },
      })),
    };
    const request = aiRequest({ requestId: 1, question: 'Describe these objects', snapshot: dirtySnapshot, binding });
    expect(request.snapshot).toEqual(snapshot);
    expect(request.snapshotBytes).toBe(Buffer.byteLength(serializeSnapshot(snapshot), 'utf8'));
    expect(request.snapshotBytes).toBe(snapshot.serializedBytes);
    expect(JSON.stringify(request)).not.toContain('private-');
    expect(aiAnswer({ text: 'Array insert', references: [insertId] }).references).toEqual([insertId]);
  });

  it.each([
    { type: 'text', geometry: {}, text: 'x'.repeat(501) },
    { type: 'insert', geometry: {}, attributes: Array.from({ length: 33 }, () => ({ tag: 'A', value: 'b' })) },
    { type: 'table', geometry: {}, tableText: Array.from({ length: 65 }, () => 'cell') },
    { type: 'polyline', geometry: { vertices: Array.from({ length: 17 }, () => ({ x: 0, y: 0 })) } },
    { type: 'line', geometry: { a: { x: Infinity, y: 0 } } },
    { type: '__proto__', geometry: {} },
  ])('rejects hostile or individually oversized object fields: %o', (fields) => {
    const value = envelope();
    (value.snapshot as { objects: unknown[] }).objects = [{ id: 'e-1', layer: '0', ...fields }];
    expect(() => aiRequest(value)).toThrow(/snapshot/);
  });

  it('limits mirror src/ai/limits.ts', async () => {
    const limits = await import('../src/ai/limits');
    expect(AI_LIMITS.maxObjects).toBe(limits.AI_MAX_OBJECTS);
    expect(AI_LIMITS.maxSnapshotBytes).toBe(limits.AI_MAX_SNAPSHOT_BYTES);
    expect(AI_LIMITS.maxQuestionChars).toBe(limits.AI_MAX_QUESTION_CHARS);
    expect(AI_LIMITS.maxAnswerChars).toBe(limits.AI_MAX_ANSWER_CHARS);
    expect(AI_LIMITS.maxReferences).toBe(limits.AI_MAX_REFERENCES);
    expect(AI_LIMITS.maxTextChars).toBe(limits.AI_MAX_TEXT_CHARS);
    expect(AI_LIMITS.maxAttributes).toBe(limits.AI_MAX_ATTRIBUTES);
    expect(AI_LIMITS.maxTableCells).toBe(limits.AI_MAX_TABLE_CELLS);
    expect(AI_LIMITS.maxSamplePoints).toBe(limits.AI_MAX_SAMPLE_POINTS);
    expect(AI_LIMITS.maxOmittedListed).toBe(limits.AI_MAX_OMITTED_LISTED);
  });
});

describe('ai-host service', () => {
  it('is inactive without a transport: refuses and sends nothing', async () => {
    const host = createAiHost();
    await expect(host.ask(envelope())).rejects.toMatchObject({ kind: 'provider-not-configured' });
    expect(host.usage().requests).toBe(1);
    await host.dispose();
  });

  it('runs an injected transport, validates its answer, and reports usage without content', async () => {
    const transport = vi.fn(async () => ({ text: 'Two objects.', references: ['e-line', 42, 'e-other'] }));
    const host = createAiHost({ transport });
    const answer = await host.ask(envelope());
    expect(answer.text).toBe('Two objects.');
    expect(answer.references).toEqual(['e-line', 'e-other']);
    const usage = host.usage();
    expect(usage.requests).toBe(1);
    expect(usage.outputChars).toBe('Two objects.'.length);
    expect(JSON.stringify(usage)).not.toContain('how many');
    await host.dispose();
  });

  it('runs and cancels string-id requests; integer and string ids never collide', async () => {
    const gate = new Promise(() => {});
    const host = createAiHost({ transport: () => gate, timeoutMs: 60000 });
    const byString = host.ask(envelope({ requestId: 'a1b2c3d4e5f60708-1' }));
    const byInt = host.ask(envelope({ requestId: 5 }));
    const stringLikeInt = host.ask(envelope({ requestId: 'a1b2c3d4e5f60708-5' }));
    const cancelled = expect(byString).rejects.toMatchObject({ kind: 'cancelled' });
    expect(host.cancel('a1b2c3d4e5f60708-1')).toBe(true);
    await cancelled;
    expect(host.cancelAll()).toBe(2);
    await expect(byInt).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(stringLikeInt).rejects.toMatchObject({ kind: 'cancelled' });
    expect(host.cancelAll()).toBe(0);
    await host.dispose();
  });

  it('reports provider token usage alongside host usage, without content', async () => {
    const host = createAiHost({
      transport: async () => ({ text: 'Two objects.', references: [], providerUsage: { inputTokens: 120, outputTokens: 9 } }),
    });
    const answer = await host.ask(envelope());
    expect(answer.providerUsage).toEqual({ inputTokens: 120, outputTokens: 9 });
    expect(answer.usage).toMatchObject({ outputChars: 'Two objects.'.length });
    await host.dispose();
  });

  it('rejects oversized transport output', async () => {
    const host = createAiHost({ transport: async () => ({ text: 'z'.repeat(AI_LIMITS.maxAnswerChars! + 1), references: [] }) });
    await expect(host.ask(envelope())).rejects.toMatchObject({ kind: 'output-too-large' });
    await host.dispose();
  });

  it('times out a transport that never answers', async () => {
    const host = createAiHost({
      timeoutMs: 20,
      transport: (_req, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ text: 'late', references: [] }));
      }),
    });
    await expect(host.ask(envelope())).rejects.toMatchObject({ kind: 'timeout' });
    expect(host.usage().timeouts).toBe(1);
    await host.dispose();
  });

  it('dispose rejects queued and running requests', async () => {
    const gate = new Promise(() => {});
    const host = createAiHost({ transport: () => gate, timeoutMs: 60000 });
    const first = host.ask(envelope());
    const second = host.ask(envelope({ requestId: 4 }));
    const third = host.ask(envelope({ requestId: 5 }));
    await host.dispose();
    await expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(second).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(third).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('removes a cancelled queued request without ever calling the transport for it', async () => {
    let release!: (value: { text: string; references: string[] }) => void;
    const transport = vi.fn(() => new Promise<{ text: string; references: string[] }>((resolve) => { release = resolve; }));
    const host = createAiHost({ transport, maxConcurrent: 1 });
    const first = host.ask(envelope());
    const abort = new AbortController();
    const second = host.ask(envelope({ requestId: 4 }), abort.signal);
    const cancelled = expect(second).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
    release({ text: 'first', references: [] });
    await first;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(host.usage().cancelled).toBe(1);
    await host.dispose();
  });

  it('explicit cancellation aborts running work and cannot become a late success', async () => {
    const transport = vi.fn((_request: unknown, signal: AbortSignal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ text: 'late answer', references: [] }));
    }));
    const host = createAiHost({ transport });
    const pending = host.ask(envelope());
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(host.cancel(3)).toBe(true);
    expect(host.cancel(3)).toBe(false);
    await cancelled;
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    expect(host.usage().outputChars).toBe(0);
    await host.dispose();
  });

  it('does not enqueue an already-cancelled request', async () => {
    const transport = vi.fn(async () => ({ text: 'unexpected', references: [] }));
    const host = createAiHost({ transport });
    const abort = new AbortController();
    abort.abort();
    await expect(host.ask(envelope(), abort.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(transport).not.toHaveBeenCalled();
    await host.dispose();
  });

  it('expires queued work and keeps concurrency bounded when a transport ignores abort', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => new Promise(() => {}));
    const host = createAiHost({ transport, timeoutMs: 20, maxConcurrent: 1 });
    try {
      const first = expect(host.ask(envelope())).rejects.toMatchObject({ kind: 'timeout' });
      const queued = expect(host.ask(envelope({ requestId: 4 }))).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(20);
      await Promise.all([first, queued]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(host.usage().timeouts).toBe(2);
    } finally {
      await host.dispose();
      vi.useRealTimers();
    }
  });
});

describe('ai-host key store', () => {
  function fakeStorage(available = true) {
    const files = new Map<string, Buffer>();
    const safeStorage = {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
      decryptString: (cipher: Buffer) => [...cipher.toString('utf8').slice(4)].reverse().join(''),
    };
    const fsImpl = {
      existsSync: (p: string) => files.has(p),
      mkdirSync: () => {},
      writeFileSync: (p: string, data: Buffer) => { files.set(p, Buffer.from(data)); },
      readFileSync: (p: string) => files.get(p)!,
      unlinkSync: (p: string) => { files.delete(p); },
    };
    return { safeStorage, fsImpl, files };
  }

  it('stores only ciphertext and round-trips host-side', async () => {
    const { safeStorage, fsImpl, files } = fakeStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    expect(store.hasKey()).toBe(false);
    await store.saveKey('sk-test-secret');
    expect(store.hasKey()).toBe(true);
    expect(files.get('/tmp/jcad-ai-key.bin')!.toString('utf8')).not.toContain('sk-test-secret');
    expect(store.readKey()).toBe('sk-test-secret');
    await store.clearKey();
    expect(store.hasKey()).toBe(false);
    expect(store.readKey()).toBeNull();
  });

  it('refuses to persist when OS encryption is unavailable', async () => {
    const { safeStorage, fsImpl, files } = fakeStorage(false);
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    await expect(store.saveKey('sk-test-secret')).rejects.toThrow(/refusing to store/);
    expect(files.size).toBe(0);
  });

  it('rejects malformed keys', async () => {
    const { safeStorage, fsImpl } = fakeStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    await expect(store.saveKey('')).rejects.toThrow(/Invalid API key/);
    await expect(store.saveKey('x'.repeat(AI_LIMITS.maxKeyChars! + 1))).rejects.toThrow(/Invalid API key/);
  });

  it.each(['basic_text', 'unknown'])('refuses Linux %s even when encryption claims to be available', async (backend) => {
    const { safeStorage, fsImpl, files } = fakeStorage();
    safeStorage.getSelectedStorageBackend = () => backend;
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl, platform: 'linux' });
    await expect(store.saveKey('sk-test-secret')).rejects.toThrow(/OS-backed encryption/);
    expect(files.size).toBe(0);
    files.set('/tmp/jcad-ai-key.bin', Buffer.from('existing'));
    expect(() => store.readKey()).toThrow(/OS-backed encryption/);
  });

  function seamStorage() {
    const files = new Map<string, Buffer>();
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
    const seams = {
      failWrites: false,
      failDeletes: false,
      writeFileAtomic: async (p: string, data: Buffer) => {
        if (seams.failWrites) throw new Error('disk full');
        files.set(p, Buffer.from(data));
      },
      readFile: (p: string) => files.get(p)!,
      removeFile: async (p: string) => {
        if (seams.failDeletes) throw new Error('locked');
        files.delete(p);
      },
      fileExists: (p: string) => files.has(p),
    };
    return { safeStorage, seams, files };
  }

  it('round-trips through the injected fs seams without fsImpl', async () => {
    const { safeStorage, seams, files } = seamStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/data/ai-key.bin', ...seams });
    expect(store.encryptionAvailable()).toBe(true);
    await store.saveKey('sk-seams');
    expect(files.get('/data/ai-key.bin')!.toString('utf8')).not.toContain('sk-seams');
    expect(store.readKey()).toBe('sk-seams');
    await store.clearKey();
    expect(store.readKey()).toBeNull();
  });

  it('a failed atomic write keeps the previously stored key readable', async () => {
    const { safeStorage, seams } = seamStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/data/ai-key.bin', ...seams });
    await store.saveKey('sk-old');
    seams.failWrites = true;
    await expect(store.saveKey('sk-new')).rejects.toMatchObject({ kind: 'credential-unavailable' });
    expect(store.readKey()).toBe('sk-old');
  });

  it('reports a corrupt stored key distinctly from a missing one', async () => {
    const { safeStorage, seams, files } = seamStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/data/ai-key.bin', ...seams });
    expect(store.readKey()).toBeNull();
    files.set('/data/ai-key.bin', Buffer.from('not-ciphertext'));
    let caught: unknown = null;
    try { store.readKey(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ kind: 'credential-corrupt' });
    expect((caught as Error).message).toMatch(/could not be decrypted/);
  });

  it('clearKey resolves with no stored key and reports deletion failures', async () => {
    const { safeStorage, seams } = seamStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/data/ai-key.bin', ...seams });
    await expect(store.clearKey()).resolves.toBeUndefined();
    await store.saveKey('sk-test-secret');
    seams.failDeletes = true;
    await expect(store.clearKey()).rejects.toMatchObject({ kind: 'credential-delete-failed' });
    expect(store.hasKey()).toBe(true);
  });

  it('encryptionAvailable never throws, even with a broken safeStorage', () => {
    const { fsImpl } = fakeStorage();
    const broken = {
      isEncryptionAvailable: () => { throw new Error('nope'); },
      encryptString: (plain: string) => Buffer.from(plain),
      decryptString: (cipher: Buffer) => cipher.toString('utf8'),
    };
    const store = createAiKeyStore({ safeStorage: broken, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    expect(store.encryptionAvailable()).toBe(false);
  });
});

describe('ai-host config store', () => {
  const CONFIG_PATH = '/data/ai-config.json';

  function configSeams() {
    const files = new Map<string, Buffer>();
    const seams = {
      failWrites: false,
      writeFileAtomic: async (p: string, data: Buffer) => {
        if (seams.failWrites) throw new Error('disk full');
        files.set(p, Buffer.from(data));
      },
      readFile: (p: string) => {
        const data = files.get(p);
        if (!data) throw new Error('ENOENT');
        return Buffer.from(data);
      },
      fileExists: (p: string) => files.has(p),
    };
    return { seams, files };
  }

  it('exposes the provider/model constants and model validation', () => {
    expect(AI_PROVIDERS).toEqual(['openai', 'anthropic']);
    expect(AI_DEFAULT_MODEL).toBe('gpt-5');
    expect(AI_PROVIDER_DEFAULT_MODELS).toEqual({ openai: 'gpt-5', anthropic: 'claude-sonnet-5-5' });
    expect(validateAiModel('gpt-5')).toBe(true);
    expect(validateAiModel('gpt-5.1-mini_x')).toBe(true);
    expect(validateAiModel('claude-sonnet-5-5')).toBe(true);
    expect(validateAiModel('')).toBe(false);
    expect(validateAiModel('-leading')).toBe(false);
    expect(validateAiModel('has space')).toBe(false);
    expect(validateAiModel('a'.repeat(129))).toBe(false);
    expect(validateAiModel(42)).toBe(false);
  });

  it('defaults when no file exists', async () => {
    const { seams } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    expect(store.get()).toEqual({
      version: 2, provider: 'openai',
      providers: {
        openai: { model: 'gpt-5', enabled: false, keyPersistence: 'session' },
        anthropic: { model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'session' },
      },
    });
    const { config, problem } = await store.load();
    expect(problem).toBeNull();
    expect(config).toEqual(store.get());
  });

  it('persists validated updates, ignores unknown keys, and reloads', async () => {
    const { seams, files } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    await store.update({ model: 'gpt-5-mini', enabled: true, keyPersistence: 'encrypted', evil: 'ignored' });
    expect(store.get()).toEqual({
      version: 2, provider: 'openai',
      providers: {
        openai: { model: 'gpt-5-mini', enabled: true, keyPersistence: 'encrypted' },
        anthropic: { model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'session' },
      },
    });
    const onDisk = JSON.parse(files.get(CONFIG_PATH)!.toString('utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('evil');
    const reloaded = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    const { config, problem } = await reloaded.load();
    expect(problem).toBeNull();
    expect(config.providers.openai.model).toBe('gpt-5-mini');
  });

  it('applies entry patches to the provider selected by the same patch', async () => {
    const { seams } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    await store.update({ provider: 'anthropic', model: 'claude-opus-4-5', enabled: true });
    expect(store.get().provider).toBe('anthropic');
    expect(store.get().providers.anthropic).toEqual({ model: 'claude-opus-4-5', enabled: true, keyPersistence: 'session' });
    expect(store.get().providers.openai.model).toBe('gpt-5');
    // A later entry patch keeps applying to the now-selected provider.
    await store.update({ model: 'claude-sonnet-5-5' });
    expect(store.get().providers.anthropic.model).toBe('claude-sonnet-5-5');
    expect(store.get().providers.openai.model).toBe('gpt-5');
  });

  it('rejects invalid patch values before writing anything', async () => {
    const { seams, files } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    await expect(store.update({ model: 'bad model!' })).rejects.toMatchObject({ kind: 'invalid-request' });
    await expect(store.update({ provider: 'bogus' })).rejects.toMatchObject({ kind: 'invalid-request' });
    await expect(store.update({ enabled: 'yes' })).rejects.toMatchObject({ kind: 'invalid-request' });
    await expect(store.update({ keyPersistence: 'forever' })).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(files.size).toBe(0);
  });

  it('migrates a v1 config on load: values become the openai entry, problem null', async () => {
    const { seams, files } = configSeams();
    files.set(CONFIG_PATH, Buffer.from(JSON.stringify({
      version: 1, provider: 'openai', model: 'gpt-4o', enabled: true, keyPersistence: 'encrypted',
    })));
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    const { config, problem } = await store.load();
    expect(problem).toBeNull();
    expect(config).toEqual({
      version: 2, provider: 'openai',
      providers: {
        openai: { model: 'gpt-4o', enabled: true, keyPersistence: 'encrypted' },
        anthropic: { model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'session' },
      },
    });
    expect(store.get()).toEqual(config);
  });

  it('reports config-invalid when the v2 providers map is not a plain object', async () => {
    const { seams, files } = configSeams();
    files.set(CONFIG_PATH, Buffer.from(JSON.stringify({ version: 2, provider: 'openai', providers: 'nope' })));
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    await expect(store.load()).resolves.toMatchObject({ problem: 'config-invalid' });
    expect(store.get().providers.anthropic.model).toBe('claude-sonnet-5-5');
  });

  it('falls back to defaults with a problem code for corrupt or invalid files', async () => {
    const { seams, files } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    files.set(CONFIG_PATH, Buffer.from('{not json'));
    await expect(store.load()).resolves.toMatchObject({ problem: 'config-unreadable' });
    expect(store.get().providers.openai.model).toBe('gpt-5');
    files.set(CONFIG_PATH, Buffer.from(JSON.stringify({ version: 3, provider: 'openai', providers: {} })));
    await expect(store.load()).resolves.toMatchObject({ problem: 'config-invalid' });
    files.set(CONFIG_PATH, Buffer.from('x'.repeat(5000)));
    await expect(store.load()).resolves.toMatchObject({ problem: 'config-invalid' });
  });

  it('a failed write reports credential-unavailable and leaves the cache unchanged', async () => {
    const { seams } = configSeams();
    const store = createAiConfigStore({ filePath: CONFIG_PATH, ...seams });
    await store.update({ model: 'gpt-5-mini' });
    seams.failWrites = true;
    await expect(store.update({ model: 'gpt-5' })).rejects.toMatchObject({ kind: 'credential-unavailable' });
    expect(store.get().providers.openai.model).toBe('gpt-5-mini');
  });
});

describe('ai wiring boundary (milestone 2)', () => {
  it('is registered only through the guarded context module, never directly in main.cjs', () => {
    const main = readFileSync(join(root, 'electron/main.cjs'), 'utf8');
    const ipcAi = readFileSync(join(root, 'electron/main/ipc-ai.cjs'), 'utf8');
    expect(main).toContain("require('./main/ipc-ai.cjs')");
    expect(main).toContain('registerAiIpc(ctx)');
    // No AI channel is registered in main.cjs itself, and the AI module
    // never touches Electron's raw ipcMain (the guard would be bypassed).
    expect(main).not.toContain("handle('ai-");
    expect(ipcAi).not.toContain('rawIpcMain');
    for (const channel of ['ai-get-state', 'ai-set-provider', 'ai-set-model', 'ai-set-key', 'ai-forget-key',
      'ai-set-enabled', 'ai-test-connection', 'ai-ask', 'ai-cancel', 'ai-usage']) {
      expect(ipcAi).toContain(`'${channel}'`);
    }
    // The preload exposes exactly the ai group over those channels.
    const preload = readFileSync(join(root, 'electron/preload.cjs'), 'utf8');
    expect(preload).toContain('ai-ask');
    expect(preload).toContain('ai-cancel');
  });

  it('the live provider is constructed only in the AI panel and src/ai', () => {
    const allowed = new Set([join(root, 'src', 'ui', 'ai-panel.ts')]);
    const hits: string[] = [];
    function inspect(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (file !== join(root, 'src', 'ai')) inspect(file);
        } else if (/\.tsx?$/.test(entry.name) && /\bLiveProvider\b/.test(readFileSync(file, 'utf8'))) hits.push(file);
      }
    }
    inspect(join(root, 'src'));
    expect(hits.every((file) => allowed.has(file))).toBe(true);
  });

  it('makes no provider request before explicit enablement', async () => {
    // A fresh service over empty stores: state defaults to disabled with
    // no key, and ask refuses before any transport is built.
    const factory = vi.fn(() => { throw new Error('transport must not be built'); });
    const dir = mkdtempSync(join(tmpdir(), 'jcad-ai-boundary-'));
    try {
      const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (cipher: Buffer) => cipher.toString('utf8').slice(4),
      };
      const files = new Map<string, Buffer>();
      const fsImpl = {
        existsSync: (p: string) => files.has(p),
        mkdirSync: () => {},
        writeFileSync: (p: string, data: Buffer) => { files.set(p, Buffer.from(data)); },
        readFileSync: (p: string) => files.get(p)!,
        unlinkSync: (p: string) => { files.delete(p); },
      };
      const keyStores = {
        openai: createAiKeyStore({ safeStorage, filePath: join(dir, 'openai-key.bin'), fsImpl }),
        anthropic: createAiKeyStore({ safeStorage, filePath: join(dir, 'anthropic-key.bin'), fsImpl }),
      };
      const configStore = createAiConfigStore({ filePath: join(dir, 'config.json'), writeFileAtomic: async () => {}, readFile: () => { throw new Error('missing'); }, fileExists: () => false });
      const service = createAiService({ configStore, keyStores, transportFactory: factory });
      const state = await service.getState();
      expect(state.enabled).toBe(false);
      expect(state.keyPresent).toBe(false);
      await expect(service.ask(envelope())).rejects.toMatchObject({ kind: 'live-disabled' });
      expect(factory).not.toHaveBeenCalled();
      await service.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
