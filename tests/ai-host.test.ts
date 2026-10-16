import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { buildSelectionSnapshot, serializeSnapshot } from '../src/ai/snapshot';
import type { AiBinding, AiSnapshotSource } from '../src/ai/types';

const require = createRequire(import.meta.url);
const { AI_LIMITS, aiRequest, aiAnswer, createAiHost, createAiKeyStore } = require('../electron/ai-host.cjs') as {
  AI_LIMITS: Record<string, number>;
  aiRequest: (value: unknown) => { requestId: number; question: string; snapshotBytes: number; snapshot: Record<string, unknown> };
  aiAnswer: (value: unknown) => { text: string; references: string[] };
  createAiHost: (options?: {
    transport?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
    timeoutMs?: number;
    maxConcurrent?: number;
    maxPending?: number;
  }) => {
    ask: (value: unknown, signal?: AbortSignal) => Promise<{ text: string; references: string[]; usage: unknown }>;
    cancel: (requestId: number) => boolean;
    usage: () => Record<string, number>;
    dispose: () => Promise<void>;
  };
  createAiKeyStore: (options: {
    safeStorage: unknown; filePath: string; fsImpl?: unknown; platform?: string;
  }) => {
    hasKey: () => boolean;
    saveKey: (key: string) => void;
    readKey: () => string | null;
    clearKey: () => void;
  };
};

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

  it('stores only ciphertext and round-trips host-side', () => {
    const { safeStorage, fsImpl, files } = fakeStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    expect(store.hasKey()).toBe(false);
    store.saveKey('sk-test-secret');
    expect(store.hasKey()).toBe(true);
    expect(files.get('/tmp/jcad-ai-key.bin')!.toString('utf8')).not.toContain('sk-test-secret');
    expect(store.readKey()).toBe('sk-test-secret');
    store.clearKey();
    expect(store.hasKey()).toBe(false);
    expect(store.readKey()).toBeNull();
  });

  it('refuses to persist when OS encryption is unavailable', () => {
    const { safeStorage, fsImpl, files } = fakeStorage(false);
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    expect(() => store.saveKey('sk-test-secret')).toThrow(/refusing to store/);
    expect(files.size).toBe(0);
  });

  it('rejects malformed keys', () => {
    const { safeStorage, fsImpl } = fakeStorage();
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl });
    expect(() => store.saveKey('')).toThrow(/Invalid API key/);
    expect(() => store.saveKey('x'.repeat(AI_LIMITS.maxKeyChars! + 1))).toThrow(/Invalid API key/);
  });

  it.each(['basic_text', 'unknown'])('refuses Linux %s even when encryption claims to be available', (backend) => {
    const { safeStorage, fsImpl, files } = fakeStorage();
    safeStorage.getSelectedStorageBackend = () => backend;
    const store = createAiKeyStore({ safeStorage, filePath: '/tmp/jcad-ai-key.bin', fsImpl, platform: 'linux' });
    expect(() => store.saveKey('sk-test-secret')).toThrow(/OS-backed encryption/);
    expect(files.size).toBe(0);
    files.set('/tmp/jcad-ai-key.bin', Buffer.from('existing'));
    expect(() => store.readKey()).toThrow(/OS-backed encryption/);
  });
});

describe('ai-host activation boundary', () => {
  it('is not registered in main.cjs and not exposed in preload.cjs', () => {
    const main = readFileSync(join(root, 'electron/main.cjs'), 'utf8');
    const preload = readFileSync(join(root, 'electron/preload.cjs'), 'utf8');
    expect(main).not.toContain('ai-host');
    expect(main).not.toContain('ai-ask');
    expect(preload).not.toContain('aiAsk');
    expect(preload).not.toContain('ai-ask');
  });

  it('the live provider is not constructed anywhere in src outside src/ai', () => {
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
    expect(hits).toEqual([]);
  });
});
