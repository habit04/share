import { describe, it, expect, vi } from 'vitest';
import { LiveProvider, type AiHostBridge } from '../src/ai/live-provider';
import { AiError, type AiAskRequest } from '../src/ai/types';

const request: AiAskRequest = {
  requestId: 1,
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
});
