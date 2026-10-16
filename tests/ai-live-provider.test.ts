import { describe, it, expect, vi } from 'vitest';
import { LiveDraftProvider, LiveProvider, type AiDraftWireResult, type AiHostBridge } from '../src/ai/live-provider';
import { AiError, type AiAnswer, type AiAskRequest, type AiDraftBinding, type AiDraftRefineRequest, type AiDraftRequest } from '../src/ai/types';

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
    expect(bridge.ask).toHaveBeenCalledWith({ ...request, destination: { provider: 'agreed-provider', model: 'agreed-model' } }, expect.any(AbortSignal));
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
    expect(bridge.ask).toHaveBeenCalledWith({ ...request, destination: { provider: 'p', model: 'm' } }, abort.signal);
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

  it('pins its own destination and refuses oversized payloads even when the byte count is forged', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(async () => ({ text: 'x', references: [] })) };
    const provider = new LiveProvider(bridge, { providerId: 'openai', model: 'gpt-5' });
    await provider.ask({ ...request, destination: { provider: 'anthropic', model: 'other-model' } }, new AbortController().signal);
    expect(bridge.ask).toHaveBeenCalledWith(expect.objectContaining({ destination: { provider: 'openai', model: 'gpt-5' } }), expect.any(AbortSignal));
    vi.mocked(bridge.ask).mockClear();
    const oversized = { ...request, snapshot: { ...request.snapshot, objects: [{ id: 'x', type: 'text', layer: '0', geometry: {}, text: 'x'.repeat(70_000) }], serializedBytes: 1 } };
    await expect(provider.ask(oversized, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid-context' });
    expect(bridge.ask).not.toHaveBeenCalled();
  });
});

const draftBinding: AiDraftBinding = {
  ask: {
    sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 7, docLoadCount: 1,
    space: { layout: null, viewport: null }, selectionIds: ['e-line'],
  },
  unitsKey: '1|2|4',
  defaultsKey: '{"layer":"0","color":"ByLayer"}',
  eligibilityKey: 'e-line=1',
  configKey: 'openai|gpt-5|0',
};

const draftRequest: AiDraftRequest = {
  requestId: 'ai-draft-1',
  prompt: 'draw a line',
  contextJson: '{"kind":"jcad.ai.draft-context","version":1}',
  contextBytes: 44,
  binding: draftBinding,
} as unknown as AiDraftRequest;

const planValue = {
  outcome: 'proposal', message: null,
  operations: [{
    op: 'createLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
    center: null, radius: null, origin: null, width: null, height: null,
    rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
    pivot: null, angleDeg: null,
  }],
};

function draftBridge(
  result: AiDraftWireResult | ((request: AiDraftRequest, signal: AbortSignal) => Promise<AiDraftWireResult>),
): AiHostBridge {
  return {
    ask: vi.fn(async () => ({ text: 'x', references: [] })),
    draft: vi.fn(async (request: AiDraftRequest, signal: AbortSignal) => ({
      configGeneration: 'host-1',
      ...(typeof result === 'function' ? await result(request, signal) : result),
    })),
  };
}

describe('LiveDraftProvider (milestone 3)', () => {
  it('requires a verified host generation and rejects a response from another generation', async () => {
    const bridge = draftBridge({ response: planValue, configGeneration: 'host-2' });
    const missing = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5' });
    expect(missing.configured).toBe(false);
    await expect(missing.draft(draftRequest, new AbortController().signal)).rejects.toMatchObject({ kind: 'host-unavailable' });
    expect(bridge.draft).not.toHaveBeenCalled();
    const stale = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(stale.draft(draftRequest, new AbortController().signal)).rejects.toMatchObject({ kind: 'stale' });
  });
  it('refuses with host-unavailable when there is no bridge at all', async () => {
    const provider = new LiveDraftProvider(undefined, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    // Mirrors LiveProvider: without a bridge the provider is not
    // configured, but the refusal names the missing host, not the config.
    expect(provider.configured).toBe(false);
    await expect(provider.draft(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ name: 'AiError', kind: 'host-unavailable' });
  });

  it('refuses with host-unavailable when the bridge has no draft method', async () => {
    const bridge: AiHostBridge = { ask: vi.fn(async () => ({ text: 'x', references: [] })) };
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.draft(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ name: 'AiError', kind: 'host-unavailable' });
  });

  it('refuses when the config is incomplete, without touching bridge.draft', async () => {
    const bridge = draftBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: '', model: '' });
    expect(provider.configured).toBe(false);
    await expect(provider.draft(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'provider-not-configured' });
    expect(bridge.draft).not.toHaveBeenCalled();
  });

  it('pins its own destination, sends only prompt/context/binding, and returns the validated plan', async () => {
    const bridge = draftBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const result = await provider.draft(
      { ...draftRequest, destination: { provider: 'anthropic', model: 'other-model' } } as AiDraftRequest,
      new AbortController().signal,
    );
    expect(result).toEqual({
      kind: 'plan',
      plan: { message: null, operations: [{ op: 'createLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, layer: null }] },
    });
    expect(bridge.draft).toHaveBeenCalledTimes(1);
    expect(bridge.draft).toHaveBeenCalledWith({
      requestId: 'ai-draft-1',
      prompt: 'draw a line',
      contextJson: '{"kind":"jcad.ai.draft-context","version":1}',
      binding: draftBinding,
      destination: { provider: 'openai', model: 'gpt-5', configGeneration: 'host-1' },
    }, expect.any(AbortSignal));
  });

  it('passes a clarification response through untouched in shape', async () => {
    const bridge = draftBridge({ response: { outcome: 'clarification', message: 'What radius?', operations: null } });
    const provider = new LiveDraftProvider(bridge, { providerId: 'anthropic', model: 'claude-sonnet-5-5', configGeneration: 'host-1' });
    await expect(provider.draft(draftRequest, new AbortController().signal))
      .resolves.toEqual({ kind: 'clarification', message: 'What radius?' });
  });

  it.each([
    ['an unknown operation', { outcome: 'proposal', message: null, operations: [{ op: 'explode' }] }],
    ['an unknown outcome', { outcome: 'yes', message: null, operations: null }],
    ['a non-object value', 'proposal'],
    ['a missing value', undefined],
  ])('maps %s from the bridge to invalid-plan', async (_label, response) => {
    const bridge = draftBridge({ response });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.draft(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ name: 'AiError', kind: 'invalid-plan' });
  });

  it('refuses an over-long prompt and an oversized context before delegating', async () => {
    const bridge = draftBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.draft({ ...draftRequest, prompt: 'p'.repeat(2001) }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-question' });
    await expect(provider.draft({ ...draftRequest, contextJson: 'x'.repeat(96 * 1024 + 1) }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-context' });
    expect(bridge.draft).not.toHaveBeenCalled();
  });

  it('honours an already-aborted signal before delegating', async () => {
    const bridge = draftBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.draft(draftRequest, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(bridge.draft).not.toHaveBeenCalled();
  });

  it('forwards cancellation and refuses a bridge that resolves on abort', async () => {
    const hanging = draftBridge((_req: AiDraftRequest, signal: AbortSignal) => new Promise<AiDraftWireResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ response: planValue }));
    }));
    const provider = new LiveDraftProvider(hanging, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const abort = new AbortController();
    const pending = provider.draft(draftRequest, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
    expect(hanging.draft).toHaveBeenCalledWith(expect.objectContaining({
      destination: { provider: 'openai', model: 'gpt-5', configGeneration: 'host-1' },
    }), abort.signal);
  });
});

const refineRequest: AiDraftRefineRequest = {
  requestId: 'ai-refine-1',
  followUp: 'Change that movement to 15 units right in total.',
  envelopeJson: '{"kind":"jcad.ai.draft-refine-context","version":1}',
  binding: draftBinding,
};

function refineBridge(
  result: AiDraftWireResult | ((request: AiDraftRefineRequest, signal: AbortSignal) => Promise<AiDraftWireResult>),
): AiHostBridge {
  return {
    ask: vi.fn(async () => ({ text: 'x', references: [] })),
    draft: vi.fn(async () => ({ response: planValue, configGeneration: 'host-1' })),
    draftRefine: vi.fn(async (request: AiDraftRefineRequest, signal: AbortSignal) => ({
      configGeneration: 'host-1',
      ...(typeof result === 'function' ? await result(request, signal) : result),
    })),
  };
}

describe('LiveDraftProvider refine (milestone 4)', () => {
  it('pins its own destination, sends only the wire fields, and returns the validated replacement plan', async () => {
    const replacement = {
      outcome: 'proposal', message: null,
      operations: [{
        op: 'move', a: null, b: null, center: null, radius: null, origin: null, width: null,
        height: null, rotationDeg: null, layer: null, targetIds: ['e-line'], dx: 15, dy: 0,
        pivot: null, angleDeg: null,
      }],
    };
    const bridge = refineBridge({ response: replacement });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const result = await provider.refine(
      { ...refineRequest, destination: { provider: 'anthropic', model: 'other-model' } },
      new AbortController().signal,
    );
    expect(result).toEqual({
      kind: 'plan',
      plan: { message: null, operations: [{ op: 'move', targetIds: ['e-line'], dx: 15, dy: 0 }] },
    });
    expect(bridge.draftRefine).toHaveBeenCalledTimes(1);
    expect(bridge.draftRefine).toHaveBeenCalledWith({
      requestId: 'ai-refine-1',
      followUp: 'Change that movement to 15 units right in total.',
      envelopeJson: '{"kind":"jcad.ai.draft-refine-context","version":1}',
      binding: draftBinding,
      destination: { provider: 'openai', model: 'gpt-5', configGeneration: 'host-1' },
    }, expect.any(AbortSignal));
    expect(bridge.draft).not.toHaveBeenCalled();
  });

  it('refuses with host-unavailable when the bridge has no draftRefine method', async () => {
    const bridge: AiHostBridge = {
      ask: vi.fn(async () => ({ text: 'x', references: [] })),
      draft: vi.fn(async () => ({ response: planValue, configGeneration: 'host-1' })),
    };
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.refine(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ name: 'AiError', kind: 'host-unavailable' });
  });

  it('refuses with host-unavailable when the config carries no verified generation', async () => {
    const bridge = refineBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5' });
    // `configured` keeps its draft meaning; refinement refuses at call time.
    await expect(provider.refine(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'host-unavailable' });
    expect(bridge.draftRefine).not.toHaveBeenCalled();
  });

  it('rejects a response from another configuration generation as stale', async () => {
    const bridge = refineBridge({ response: planValue, configGeneration: 'host-2' });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.refine(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'stale' });
  });

  it('maps an invalid replacement plan from the bridge to invalid-plan', async () => {
    const bridge = refineBridge({ response: { outcome: 'proposal', message: null, operations: [{ op: 'explode' }] } });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.refine(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ name: 'AiError', kind: 'invalid-plan' });
  });

  it('passes a clarification response through untouched in shape', async () => {
    const bridge = refineBridge({ response: { outcome: 'clarification', message: 'How much bigger?', operations: null } });
    const provider = new LiveDraftProvider(bridge, { providerId: 'anthropic', model: 'claude-sonnet-5-5', configGeneration: 'host-1' });
    await expect(provider.refine(refineRequest, new AbortController().signal))
      .resolves.toEqual({ kind: 'clarification', message: 'How much bigger?' });
  });

  it('refuses an over-long follow-up and an oversized envelope before delegating', async () => {
    const bridge = refineBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    await expect(provider.refine({ ...refineRequest, followUp: 'f'.repeat(2001) }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-question' });
    await expect(provider.refine({ ...refineRequest, envelopeJson: 'x'.repeat(96 * 1024 + 1) }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-context' });
    expect(bridge.draftRefine).not.toHaveBeenCalled();
  });

  it('honours an already-aborted signal before delegating', async () => {
    const bridge = refineBridge({ response: planValue });
    const provider = new LiveDraftProvider(bridge, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.refine(refineRequest, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(bridge.draftRefine).not.toHaveBeenCalled();
  });

  it('forwards cancellation and refuses a bridge that resolves on abort', async () => {
    const hanging = refineBridge((_req: AiDraftRefineRequest, signal: AbortSignal) => new Promise<AiDraftWireResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ response: planValue }));
    }));
    const provider = new LiveDraftProvider(hanging, { providerId: 'openai', model: 'gpt-5', configGeneration: 'host-1' });
    const abort = new AbortController();
    const pending = provider.refine(refineRequest, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
  });
});
