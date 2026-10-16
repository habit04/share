import { describe, it, expect, vi } from 'vitest';
import { LiveProvider, type AiHostBridge } from '../src/ai/live-provider';
import { AiError, type AiAnswer, type AiAskRequest } from '../src/ai/types';

const request: AiAskRequest = {
  requestId: 'ai-test-1',
  question: 'how many objects?',
  snapshot: {
    kind: 'jcad.ai.selection-snapshot', version: 1,
    units: { insunits: 1, insunitsName: 'Inches', lunits: 2, luprec: 4, auprec: 0 },
    space: { kind: 'model' },
    selection: { total: 0, included: 0, omittedCount: 0, omitted: [], omittedListTruncated: false },
    objects: [],
    serializedBytes: 120,
  },
  binding: {
    sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 1, docLoadCount: 1,
    space: { layout: null, viewport: null }, selectionIds: [],
  },
};

describe('LiveProvider (inactive adapter)', () => {
  it('refuses every request when no provider has been configured', async () => {
    const provider = new LiveProvider();
    expect(provider.configured).toBe(false);
    await expect(provider.ask(request, new AbortController().signal)).rejects.toMatchObject({
      name: 'AiError', kind: 'provider-not-configured',
    });
  });

  it('refuses when the config is incomplete, without touching the bridge', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(async () => ({ text: 'x', references: [] })) };
    const provider = new LiveProvider(bridge, { providerId: '', model: '' });
    expect(provider.configured).toBe(false);
    await expect(provider.ask(request, new AbortController().signal)).rejects.toBeInstanceOf(AiError);
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it('delegates to the host bridge only when fully configured', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(async () => ({ text: 'answer', references: [] })) };
    const provider = new LiveProvider(bridge, { providerId: 'agreed-provider', model: 'agreed-model' });
    expect(provider.configured).toBe(true);
    const answer = await provider.ask(request, new AbortController().signal);
    expect(answer.text).toBe('answer');
    expect(bridge.ask).toHaveBeenCalledTimes(1);
  });

  it('honours an already-aborted signal before delegating', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(async () => ({ text: 'x', references: [] })) };
    const provider = new LiveProvider(bridge, { providerId: 'p', model: 'm' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.ask(request, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the bridge and refuses a bridge that resolves on abort', async () => {
    const bridge: AiHostBridge = { ask: vi.fn((_request: AiAskRequest, signal: AbortSignal) => new Promise<AiAnswer>((resolve) => {
      signal.addEventListener('abort', () => resolve({ text: 'late', references: [] }));
    })) };
    const provider = new LiveProvider(bridge, { providerId: 'p', model: 'm' });
    const abort = new AbortController();
    const pending = provider.ask(request, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
    expect(bridge.ask).toHaveBeenCalledWith(request, abort.signal);
  });

  it('settles cancellation even if the bridge ignores the signal', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(() => new Promise<AiAnswer>(() => {})) };
    const provider = new LiveProvider(bridge, { providerId: 'p', model: 'm' });
    const abort = new AbortController();
    const pending = provider.ask(request, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
  });
});
