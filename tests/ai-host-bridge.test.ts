import { describe, it, expect, vi } from 'vitest';
import { WindowAiConnection, aiErrorFromPayload, type AiPreloadBridge } from '../src/ai/host-bridge';
import { AiError, type AiAskRequest, type AiDraftRefineRequest, type AiDraftRequest } from '../src/ai/types';

const state = {
  provider: 'openai', model: 'gpt-5', enabled: true, keyPersistence: 'session' as const,
  keyPresent: true, keySource: 'session' as const, encryptionAvailable: true, configProblem: null,
};

const request = { requestId: 'ai-salt-1', question: 'q', snapshot: {}, binding: {} } as unknown as AiAskRequest;

const planValue = {
  outcome: 'proposal', message: null,
  operations: [{
    op: 'createLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
    center: null, radius: null, origin: null, width: null, height: null,
    rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
    pivot: null, angleDeg: null,
  }],
};

const draftRequest = {
  requestId: 'ai-salt-draft-1', prompt: 'draw a line', contextJson: '{}', binding: {},
} as unknown as AiDraftRequest;

const refineRequest = {
  requestId: 'ai-salt-refine-1', followUp: 'make it longer', envelopeJson: '{}', binding: {},
} as unknown as AiDraftRefineRequest;

function fakeRaw(over: Partial<AiPreloadBridge> = {}): AiPreloadBridge {
  return {
    getState: async () => ({ ok: true, state }),
    setProvider: async () => ({ ok: true, state }),
    setModel: async () => ({ ok: true, state }),
    setKey: async () => ({ ok: true, state }),
    forgetKey: async () => ({ ok: true, state }),
    setEnabled: async () => ({ ok: true, state }),
    testConnection: async () => ({ ok: true, probe: { model: 'gpt-5' } }),
    ask: async () => ({ ok: true, answer: { text: 'a', references: [] } }),
    draft: async () => ({
      ok: true,
      draft: {
        configGeneration: 'host-1',
        value: planValue,
        usage: { inputBytes: 44, outputChars: 321, durationMs: 12 },
        providerUsage: { inputTokens: 30, outputTokens: 12 },
      },
    }),
    draftRefine: async () => ({
      ok: true,
      draft: {
        configGeneration: 'host-1',
        value: planValue,
        usage: { inputBytes: 900, outputChars: 321, durationMs: 9 },
        providerUsage: { inputTokens: 31, outputTokens: 11 },
      },
    }),
    cancel: async () => ({ ok: true, cancelled: true }),
    usage: async () => ({ ok: true, usage: {} }),
    runLiveChecks: async () => ({
      ok: true,
      report: {
        kind: 'jcad.ai.live-checks-report', version: 1, runTag: 'bridge-test',
        provider: 'openai', model: 'gpt-5', status: 'pass', refusal: null,
        checks: [], totals: { providerCalls: 4, durationMs: 10 },
      },
    }),
    cancelLiveChecks: async () => ({ ok: true, cancelled: true }),
    ...over,
  };
}

describe('aiErrorFromPayload', () => {
  it('reconstructs known kinds and bounds the message', () => {
    const err = aiErrorFromPayload({ kind: 'auth-failed', message: 'x'.repeat(900) });
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe('auth-failed');
    expect(err.message.length).toBe(500);
    expect(aiErrorFromPayload({ kind: 'credential-rollback-failed', message: 'The key update could not be rolled back.' }).kind).toBe('credential-rollback-failed');
    expect(aiErrorFromPayload({ kind: 'invalid-request', message: 'Connection settings changed; ask again.' }).kind).toBe('invalid-request');
  });

  it('fails closed to provider-failure for unknown kinds and junk payloads', () => {
    expect(aiErrorFromPayload({ kind: 'rm -rf', message: 'boom' }).kind).toBe('provider-failure');
    expect(aiErrorFromPayload(undefined).kind).toBe('provider-failure');
    expect(aiErrorFromPayload({}).message.length).toBeGreaterThan(0);
  });

  it('appends the retry hint for rate limits', () => {
    const err = aiErrorFromPayload({ kind: 'rate-limited', message: 'Slow down.', retryAfterSeconds: 12.2 });
    expect(err.message).toContain('about 13 seconds');
  });
});

describe('WindowAiConnection', () => {
  it('unwraps state and probe results', async () => {
    const conn = new WindowAiConnection(fakeRaw());
    expect(await conn.state()).toEqual(state);
    expect(await conn.testConnection()).toEqual({ model: 'gpt-5' });
  });

  it('forwards provider switches to the host', async () => {
    const setProvider = vi.fn(async () => ({ ok: true as const, state: { ...state, provider: 'anthropic' } }));
    const conn = new WindowAiConnection(fakeRaw({ setProvider }));
    const next = await conn.setProvider('anthropic');
    expect(setProvider).toHaveBeenCalledWith('anthropic');
    expect(next.provider).toBe('anthropic');
  });

  it('throws reconstructed AiErrors for failure payloads', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      setEnabled: async () => ({ ok: false, error: { kind: 'provider-not-configured', message: 'Save an API key first.' } }),
    }));
    await expect(conn.setEnabled(true)).rejects.toMatchObject({ kind: 'provider-not-configured' });
  });

  it('translates abort into the cancel channel with the request id', async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, cancelled: true }));
    let release: () => void = () => {};
    const conn = new WindowAiConnection(fakeRaw({
      cancel,
      ask: async () => new Promise(() => { release = () => {}; }),
    }));
    const abort = new AbortController();
    const pending = conn.bridge.ask(request, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    expect(cancel).toHaveBeenCalledWith('ai-salt-1');
    release();
    await cancelled;
  });

  it('refuses before invoking when the signal is already aborted', async () => {
    const ask = vi.fn(async () => ({ ok: true as const, answer: { text: 'a', references: [] } }));
    const conn = new WindowAiConnection(fakeRaw({ ask }));
    const abort = new AbortController();
    abort.abort();
    await expect(conn.bridge.ask(request, abort.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('folds provider token usage into the answer usage the controller whitelists', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      ask: async () => ({
        ok: true,
        answer: {
          text: 'a', references: [],
          usage: { inputBytes: 10, outputChars: 1, durationMs: 2 },
          providerUsage: { inputTokens: 42, outputTokens: 7 },
        },
      }),
    }));
    const answer = await conn.bridge.ask(request, new AbortController().signal);
    expect(answer.usage).toMatchObject({ inputBytes: 10, inputTokens: 42, outputTokens: 7 });
  });

  it('merges token usage without mutating the host response', async () => {
    const frozen = Object.freeze({ text: 'a', references: [], usage: Object.freeze({ inputBytes: 10 }), providerUsage: Object.freeze({ inputTokens: 42 }) });
    const conn = new WindowAiConnection(fakeRaw({ ask: async () => ({ ok: true, answer: frozen }) }));
    const answer = await conn.bridge.ask(request, new AbortController().signal);
    expect(answer.usage).toMatchObject({ inputBytes: 10, inputTokens: 42 });
    expect(frozen.usage).toEqual({ inputBytes: 10 });
  });
});

describe('WindowAiConnection draft bridge (milestone 3)', () => {
  it('reports an older preload without draft support as host-unavailable', async () => {
    const raw = fakeRaw();
    delete (raw as Partial<AiPreloadBridge>).draft;
    const ask = vi.spyOn(raw, 'ask');
    const conn = new WindowAiConnection(raw);
    await expect(conn.bridge.draft!(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'host-unavailable' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('returns the host-validated raw plan value with whitelisted usage', async () => {
    const conn = new WindowAiConnection(fakeRaw());
    const result = await conn.bridge.draft!(draftRequest, new AbortController().signal);
    expect(result.response).toEqual(planValue);
    expect(result.usage).toEqual({ inputBytes: 44, outputChars: 321, durationMs: 12, inputTokens: 30, outputTokens: 12 });
  });

  it('does not plan-validate: a contract-shaped but invalid plan value passes through untouched', async () => {
    const oddValue = { outcome: 'proposal', message: null, operations: [{ op: 'explode' }] };
    const conn = new WindowAiConnection(fakeRaw({
      draft: async () => ({ ok: true, draft: { value: oddValue, configGeneration: 'host-1' } }),
    }));
    const result = await conn.bridge.draft!(draftRequest, new AbortController().signal);
    expect(result.response).toEqual(oddValue);
    expect(result.usage).toBeUndefined();
  });

  it('rejects a malformed host draft envelope as invalid-plan', async () => {
    for (const draft of [null, 'text', [], { usage: {} }, { value: 'not-an-object' }, { value: [] }]) {
      const conn = new WindowAiConnection(fakeRaw({ draft: async () => ({ ok: true, draft }) }));
      await expect(conn.bridge.draft!(draftRequest, new AbortController().signal))
        .rejects.toMatchObject({ kind: 'invalid-plan' });
    }
  });

  it('drops malformed usage counters field by field', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      draft: async () => ({
        ok: true,
        draft: {
          configGeneration: 'host-1',
          value: planValue,
          usage: { inputBytes: -1, outputChars: 3.5, durationMs: 9 },
          providerUsage: { inputTokens: 7, outputTokens: 'many' },
        },
      }),
    }));
    const result = await conn.bridge.draft!(draftRequest, new AbortController().signal);
    expect(result.usage).toEqual({ durationMs: 9, inputTokens: 7 });
  });

  it('reconstructs host draft errors, including invalid-plan and busy', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      draft: async () => ({ ok: false, error: { kind: 'invalid-plan', message: 'The proposal contained an invalid operation.' } }),
    }));
    await expect(conn.bridge.draft!(draftRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-plan', message: 'The proposal contained an invalid operation.' });
    expect(aiErrorFromPayload({ kind: 'busy', message: 'The editor is busy.' }).kind).toBe('busy');
    expect(aiErrorFromPayload({ kind: 'invalid-plan', message: 'Nope.' }).kind).toBe('invalid-plan');
  });

  it('translates abort into the cancel channel with the draft request id', async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, cancelled: true }));
    const conn = new WindowAiConnection(fakeRaw({
      cancel,
      draft: async () => new Promise(() => {}),
    }));
    const abort = new AbortController();
    const pending = conn.bridge.draft!(draftRequest, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    expect(cancel).toHaveBeenCalledWith('ai-salt-draft-1');
    await cancelled;
  });

  it('settles promptly when the IPC draft call never answers', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      draft: async () => new Promise(() => {}),
    }));
    const abort = new AbortController();
    const pending = conn.bridge.draft!(draftRequest, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    await cancelled;
  });

  it('refuses before invoking when the signal is already aborted', async () => {
    const draft = vi.fn(async () => ({ ok: true as const, draft: { value: planValue } }));
    const conn = new WindowAiConnection(fakeRaw({ draft }));
    const abort = new AbortController();
    abort.abort();
    await expect(conn.bridge.draft!(draftRequest, abort.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(draft).not.toHaveBeenCalled();
  });
});

describe('WindowAiConnection draftRefine bridge (milestone 4)', () => {
  it('reports an older preload without refinement support without falling back', async () => {
    const raw = fakeRaw();
    delete (raw as Partial<AiPreloadBridge>).draftRefine;
    const ask = vi.spyOn(raw, 'ask');
    const draft = vi.spyOn(raw, 'draft');
    const conn = new WindowAiConnection(raw);
    await expect(conn.bridge.draftRefine!(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'host-unavailable' });
    expect(ask).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
  });

  it('returns the host-validated replacement plan value with whitelisted usage', async () => {
    const conn = new WindowAiConnection(fakeRaw());
    const result = await conn.bridge.draftRefine!(refineRequest, new AbortController().signal);
    expect(result.response).toEqual(planValue);
    expect(result.configGeneration).toBe('host-1');
    expect(result.usage).toEqual({ inputBytes: 900, outputChars: 321, durationMs: 9, inputTokens: 31, outputTokens: 11 });
  });

  it('forwards the exact refinement request to the raw bridge', async () => {
    const draftRefine = vi.fn(async () => ({ ok: true as const, draft: { value: planValue, configGeneration: 'host-1' } }));
    const conn = new WindowAiConnection(fakeRaw({ draftRefine }));
    await conn.bridge.draftRefine!(refineRequest, new AbortController().signal);
    expect(draftRefine).toHaveBeenCalledWith(refineRequest);
  });

  it('rejects a malformed host refine envelope as invalid-plan', async () => {
    for (const draft of [null, { usage: {} }, { value: 'not-an-object' }, { value: planValue }]) {
      const conn = new WindowAiConnection(fakeRaw({ draftRefine: async () => ({ ok: true, draft }) }));
      await expect(conn.bridge.draftRefine!(refineRequest, new AbortController().signal))
        .rejects.toMatchObject({ kind: 'invalid-plan' });
    }
  });

  it('reconstructs host refine errors as typed AiErrors', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      draftRefine: async () => ({ ok: false, error: { kind: 'invalid-plan', message: 'The replacement plan was invalid.' } }),
    }));
    await expect(conn.bridge.draftRefine!(refineRequest, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-plan', message: 'The replacement plan was invalid.' });
  });

  it('translates abort into the cancel channel with the refine request id', async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, cancelled: true }));
    const conn = new WindowAiConnection(fakeRaw({
      cancel,
      draftRefine: async () => new Promise(() => {}),
    }));
    const abort = new AbortController();
    const pending = conn.bridge.draftRefine!(refineRequest, abort.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    abort.abort();
    expect(cancel).toHaveBeenCalledWith('ai-salt-refine-1');
    await cancelled;
  });

  it('refuses before invoking when the signal is already aborted', async () => {
    const draftRefine = vi.fn(async () => ({ ok: true as const, draft: { value: planValue, configGeneration: 'host-1' } }));
    const conn = new WindowAiConnection(fakeRaw({ draftRefine }));
    const abort = new AbortController();
    abort.abort();
    await expect(conn.bridge.draftRefine!(refineRequest, abort.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(draftRefine).not.toHaveBeenCalled();
  });
});

describe('WindowAiConnection live-checks bridge (docs/AI-LIVE-CHECKS.md)', () => {
  it('unwraps the report and the cancel result', async () => {
    const conn = new WindowAiConnection(fakeRaw());
    const report = await conn.runLiveChecks();
    expect(report).toMatchObject({ kind: 'jcad.ai.live-checks-report', status: 'pass' });
    expect(report.totals.providerCalls).toBe(4);
    expect(await conn.cancelLiveChecks()).toBe(true);
  });

  it('reports an older preload without live-checks support as host-unavailable', async () => {
    const raw = fakeRaw();
    delete (raw as Partial<AiPreloadBridge>).runLiveChecks;
    delete (raw as Partial<AiPreloadBridge>).cancelLiveChecks;
    const conn = new WindowAiConnection(raw);
    await expect(conn.runLiveChecks()).rejects.toMatchObject({ kind: 'host-unavailable' });
    expect(await conn.cancelLiveChecks()).toBe(false);
  });

  it('rejects a malformed report payload instead of rendering it', async () => {
    const conn = new WindowAiConnection(fakeRaw({
      runLiveChecks: async () => ({ ok: true, report: { status: 42 } }) as never,
    }));
    await expect(conn.runLiveChecks()).rejects.toMatchObject({ kind: 'host-unavailable' });
  });
});
