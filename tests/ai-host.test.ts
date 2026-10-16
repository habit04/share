import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { AI_LIMITS, aiRequest, createAiHost, createAiKeyStore } = require('../electron/ai-host.cjs') as {
  AI_LIMITS: Record<string, number>;
  aiRequest: (value: unknown) => { requestId: number; question: string; snapshotBytes: number };
  createAiHost: (options?: {
    transport?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
    timeoutMs?: number;
  }) => {
    ask: (value: unknown) => Promise<{ text: string; references: string[]; usage: unknown }>;
    usage: () => Record<string, number>;
    dispose: () => Promise<void>;
  };
  createAiKeyStore: (options: {
    safeStorage: unknown; filePath: string; fsImpl?: unknown;
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
    expect(() => aiRequest(fat)).toThrow(/size limit/);
  });

  it('limits mirror src/ai/limits.ts', async () => {
    const limits = await import('../src/ai/limits');
    expect(AI_LIMITS.maxObjects).toBe(limits.AI_MAX_OBJECTS);
    expect(AI_LIMITS.maxSnapshotBytes).toBe(limits.AI_MAX_SNAPSHOT_BYTES);
    expect(AI_LIMITS.maxQuestionChars).toBe(limits.AI_MAX_QUESTION_CHARS);
    expect(AI_LIMITS.maxAnswerChars).toBe(limits.AI_MAX_ANSWER_CHARS);
    expect(AI_LIMITS.maxReferences).toBe(limits.AI_MAX_REFERENCES);
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
});

describe('ai-host key store', () => {
  function fakeStorage(available = true) {
    const files = new Map<string, Buffer>();
    const safeStorage = {
      isEncryptionAvailable: () => available,
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
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync('grep -rn "LiveProvider" src --include="*.ts" | grep -v "src/ai/" || true', { cwd: root, encoding: 'utf8' });
    expect(hits.trim()).toBe('');
  });
});
