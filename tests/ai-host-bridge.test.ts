import { describe, it, expect, vi } from 'vitest';
import { WindowAiConnection, aiErrorFromPayload, type AiPreloadBridge } from '../src/ai/host-bridge';
import { AiError, type AiAskRequest } from '../src/ai/types';

const state = {
  provider: 'openai', model: 'gpt-5', enabled: true, keyPersistence: 'session' as const,
  keyPresent: true, keySource: 'session' as const, encryptionAvailable: true, configProblem: null,
};

const request = { requestId: 'ai-salt-1', question: 'q', snapshot: {}, binding: {} } as unknown as AiAskRequest;

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
    cancel: async () => ({ ok: true, cancelled: true }),
    usage: async () => ({ ok: true, usage: {} }),
    ...over,
  };
}

describe('aiErrorFromPayload', () => {
  it('reconstructs known kinds and bounds the message', () => {
    const err = aiErrorFromPayload({ kind: 'auth-failed', message: 'x'.repeat(900) });
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe('auth-failed');
    expect(err.message.length).toBe(500);
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
    abort.abort();
    expect(cancel).toHaveBeenCalledWith('ai-salt-1');
    release();
    void pending.catch(() => {});
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
});
