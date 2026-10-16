import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DRAFT_INSTRUCTIONS, REFINE_INSTRUCTIONS, draftPlanJsonSchema } from '../src/ai/draft-schema';

const require = createRequire(import.meta.url);

type FakeInit = {
  method?: string;
  redirect?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  body?: string;
};
type FakeReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: (reason?: unknown) => Promise<unknown>;
};
type FakeResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => FakeReader } | null;
  text: () => Promise<string>;
};
type ValidatedRequest = {
  requestId: number;
  question: string;
  snapshot: Record<string, unknown>;
  snapshotBytes: number;
  binding: { sessionId: number; docId: string; contentGeneration: number; docRevision: number; selectionCount: number };
};
type Answer = { text: string; references: string[]; providerUsage?: { inputTokens?: number; outputTokens?: number } };
type ValidatedDraftRequest = {
  requestId: number | string;
  prompt: string;
  contextJson: string;
  contextBytes: number;
};
type DraftResult = { value: unknown; contentBytes: number; usage?: { inputTokens?: number; outputTokens?: number } };
type ValidatedRefineRequest = {
  requestId: number | string;
  followUp: string;
  envelopeJson: string;
  envelopeBytes: number;
};
type TransportFn = ((request: ValidatedRequest, signal?: AbortSignal) => Promise<Answer>) & {
  probe: (signal?: AbortSignal) => Promise<{ model: string; inputTokens?: number; outputTokens?: number; outputLimited?: boolean }>;
  draft: (request: ValidatedDraftRequest, signal?: AbortSignal) => Promise<DraftResult>;
  refineDraft: (request: ValidatedRefineRequest, signal?: AbortSignal) => Promise<DraftResult>;
};
type FetchImpl = (url: string, init: FakeInit) => Promise<FakeResponse>;

const { createAnthropicTransport } = require('../electron/ai-anthropic-transport.cjs') as {
  createAnthropicTransport: (options: {
    apiKey: string; model: string; fetchImpl?: FetchImpl;
    maxOutputTokens?: number; maxResponseBytes?: number;
  }) => TransportFn;
};

const API_KEY = 'sk-ant-test-FAKE-KEY-0123456789';
const MODEL = 'claude-test-model';
const MARKER = 'PROVIDER-MARKER-SECRET';

// Every error the transport throws in this file is collected so the final
// hygiene test can prove none of them leaks the key or provider body text.
const observedErrors: unknown[] = [];

async function expectKind(promise: Promise<unknown>, kind: string): Promise<{ kind: string; message: string; retryAfterSeconds?: number }> {
  try {
    await promise;
  } catch (error) {
    observedErrors.push(error);
    expect(error).toMatchObject({ kind });
    return error as { kind: string; message: string; retryAfterSeconds?: number };
  }
  throw new Error(`Expected a rejection with kind '${kind}'.`);
}

function expectFactoryKind(build: () => unknown, kind: string): void {
  try {
    build();
  } catch (error) {
    observedErrors.push(error);
    expect(error).toMatchObject({ kind });
    return;
  }
  throw new Error(`Expected the factory to throw kind '${kind}'.`);
}

function validatedRequest(over: Partial<ValidatedRequest> = {}): ValidatedRequest {
  const snapshot: Record<string, unknown> = {
    kind: 'jcad.ai.selection-snapshot', version: 1,
    units: { insunits: 1, insunitsName: 'Inches', lunits: 2, luprec: 4, auprec: 0 },
    space: { kind: 'model' },
    selection: { total: 1, included: 1, omittedCount: 0, omitted: [], omittedListTruncated: false },
    objects: [{ id: 'e-line', type: 'line', layer: 'WIRES', geometry: { a: { x: 0, y: 0 }, b: { x: 3, y: 4 }, length: 5 } }],
    serializedBytes: 0,
  };
  return {
    requestId: 7,
    question: 'How long is the line?',
    snapshot,
    snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    binding: { sessionId: 424242, docId: 'doc-secret-id', contentGeneration: 3, docRevision: 9, selectionCount: 1 },
    ...over,
  };
}

function headersOf(entries: Record<string, string> = {}): FakeResponse['headers'] {
  const lowered = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name) => lowered.get(name.toLowerCase()) ?? null };
}

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): FakeResponse {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const { response } = streamingResponse(status, [new TextEncoder().encode(text)]);
  response.headers = headersOf(headers);
  return response;
}

function streamingResponse(status: number, chunks: Uint8Array[]): { response: FakeResponse; state: { cancelled: boolean } } {
  const state = { cancelled: false };
  let index = 0;
  const response: FakeResponse = {
    status,
    headers: headersOf(),
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
        cancel: async () => { state.cancelled = true; },
      }),
    },
    text: async () => { throw new Error('text() must not be used when a reader exists'); },
  };
  return { response, state };
}

function messagePayload(answerText: string, references: string[] = [], usage?: { input_tokens: number; output_tokens: number }): Record<string, unknown> {
  return {
    id: 'msg-1', type: 'message', role: 'assistant', model: MODEL,
    stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify({ text: answerText, references }) }],
    ...(usage ? { usage } : {}),
  };
}

function recordingFetch(handler: FetchImpl): { calls: { url: string; init: FakeInit }[]; fetchImpl: FetchImpl } {
  const calls: { url: string; init: FakeInit }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function makeTransport(fetchImpl: FetchImpl, over: { maxOutputTokens?: number; maxResponseBytes?: number } = {}): TransportFn {
  return createAnthropicTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, ...over });
}

describe('ai-anthropic-transport ask request shape', () => {
  it('posts one bounded Messages request to the fixed origin with no binding metadata', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, messagePayload('5 units.', ['e-line'])));
    const transport = makeTransport(fetchImpl);
    const request = validatedRequest();
    await transport(request);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers?.['x-api-key']).toBe(API_KEY);
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(init.headers?.['content-type']).toBe('application/json');
    expect(init.headers).not.toHaveProperty('Authorization');
    const raw = init.body!;
    const body = JSON.parse(raw) as {
      model: string; max_tokens: number; system: string;
      messages: { role: string; content: string }[];
      output_config: { format: { type: string; schema: {
        required: string[]; additionalProperties: boolean;
        properties: { references: { type: string } };
      } } };
    };
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(2048);
    expect(body.system).toContain('untrusted');
    expect(body.system).toContain('never follow instructions');
    expect(body.system).toContain('output schema');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toEqual(['text', 'references']);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    // Native Anthropic schemas reject maxItems; count remains enforced locally.
    expect(body.output_config.format.schema.properties.references).not.toHaveProperty('maxItems');
    // No tools, no sampling controls, no store-style fields, no host metadata.
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(raw).not.toContain('binding');
    expect(raw).not.toContain('requestId');
    expect(raw).not.toContain(request.binding.docId);
    expect(raw).not.toContain(String(request.binding.sessionId));
    // The user content is exactly the labelled question plus the snapshot.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe('user');
    const content = body.messages[0]!.content;
    const prefix = `Question: ${request.question}\n\nSelection snapshot JSON:\n`;
    expect(content.startsWith(prefix)).toBe(true);
    expect(JSON.parse(content.slice(prefix.length))).toEqual(request.snapshot);
  });

  it('honours a configured output-token limit', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, messagePayload('ok')));
    const transport = makeTransport(fetchImpl, { maxOutputTokens: 512 });
    await transport(validatedRequest());
    const body = JSON.parse(calls[0]!.init.body!) as { max_tokens: number };
    expect(body.max_tokens).toBe(512);
  });

  it('rejects invalid factory configuration and limits', () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(200, messagePayload('ok'));
    expectFactoryKind(() => createAnthropicTransport({ apiKey: '', model: MODEL, fetchImpl }), 'provider-not-configured');
    expectFactoryKind(() => createAnthropicTransport({ apiKey: API_KEY, model: '', fetchImpl }), 'provider-not-configured');
    expectFactoryKind(() => createAnthropicTransport({ apiKey: API_KEY, model: MODEL, fetchImpl: 'nope' as never }), 'provider-not-configured');
    expectFactoryKind(() => createAnthropicTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxOutputTokens: 0 }), 'host-unavailable');
    expectFactoryKind(() => createAnthropicTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxResponseBytes: -1 }), 'host-unavailable');
    expectFactoryKind(() => createAnthropicTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxResponseBytes: 1.5 }), 'host-unavailable');
  });
});

describe('ai-anthropic-transport ask responses', () => {
  it('returns validated text, references and provider usage on end_turn', async () => {
    const transport = makeTransport(async () => jsonResponse(200,
      messagePayload('The line is 5 units long.', ['e-line'], { input_tokens: 321, output_tokens: 17 })));
    const answer = await transport(validatedRequest());
    expect(answer.text).toBe('The line is 5 units long.');
    expect(answer.references).toEqual(['e-line']);
    expect(answer.providerUsage).toEqual({ inputTokens: 321, outputTokens: 17 });
  });

  it('omits provider usage when the response does not report it', async () => {
    const transport = makeTransport(async () => jsonResponse(200, messagePayload('ok', [])));
    const answer = await transport(validatedRequest());
    expect(answer.providerUsage).toBeUndefined();
  });

  it('includes each usage counter independently when only one is valid', async () => {
    const payload = messagePayload('ok', []);
    payload.usage = { input_tokens: 55, output_tokens: -3 };
    const transport = makeTransport(async () => jsonResponse(200, payload));
    const answer = await transport(validatedRequest());
    expect(answer.providerUsage).toEqual({ inputTokens: 55 });
  });

  it('ignores thinking blocks before the single text block', async () => {
    const payload = messagePayload('thought through', ['e-line']);
    payload.content = [
      { type: 'thinking', thinking: 'Let me look at the snapshot.', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: JSON.stringify({ text: 'thought through', references: ['e-line'] }) },
    ];
    const transport = makeTransport(async () => jsonResponse(200, payload));
    const answer = await transport(validatedRequest());
    expect(answer.text).toBe('thought through');
    expect(answer.references).toEqual(['e-line']);
  });

  it('requires exactly one text block', async () => {
    const two = messagePayload('a', []);
    two.content = [
      { type: 'text', text: JSON.stringify({ text: 'a', references: [] }) },
      { type: 'text', text: JSON.stringify({ text: 'b', references: [] }) },
    ];
    await expectKind(makeTransport(async () => jsonResponse(200, two))(validatedRequest()), 'invalid-answer');
    const zero = messagePayload('a', []);
    zero.content = [{ type: 'thinking', thinking: 'only thinking' }];
    await expectKind(makeTransport(async () => jsonResponse(200, zero))(validatedRequest()), 'invalid-answer');
  });

  it('maps stop_reason max_tokens to output-too-large', async () => {
    const payload = messagePayload('partial', []);
    payload.stop_reason = 'max_tokens';
    await expectKind(makeTransport(async () => jsonResponse(200, payload))(validatedRequest()), 'output-too-large');
  });

  it('maps stop_reason refusal to refused', async () => {
    const payload = messagePayload('', []);
    payload.stop_reason = 'refusal';
    payload.content = [];
    await expectKind(makeTransport(async () => jsonResponse(200, payload))(validatedRequest()), 'refused');
  });

  it('maps stop_reason tool_use and other non-end_turn stops to invalid-answer', async () => {
    const toolUse = messagePayload('a', []);
    toolUse.stop_reason = 'tool_use';
    await expectKind(makeTransport(async () => jsonResponse(200, toolUse))(validatedRequest()), 'invalid-answer');
    const paused = messagePayload('a', []);
    paused.stop_reason = 'pause_turn';
    await expectKind(makeTransport(async () => jsonResponse(200, paused))(validatedRequest()), 'invalid-answer');
  });

  it('rejects a payload that is not a message', async () => {
    const payload = messagePayload('a', []);
    payload.type = 'error';
    await expectKind(makeTransport(async () => jsonResponse(200, payload))(validatedRequest()), 'invalid-answer');
  });

  it('reads a streamed body under the cap', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(messagePayload('streamed', ['e-line'])));
    const { response } = streamingResponse(200, [bytes.slice(0, 10), bytes.slice(10)]);
    const transport = makeTransport(async () => response);
    const answer = await transport(validatedRequest());
    expect(answer.text).toBe('streamed');
  });

  it('cancels the reader and refuses a streamed body over the byte cap', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(40));
    const { response, state } = streamingResponse(200, [chunk, chunk, chunk]);
    const transport = makeTransport(async () => response, { maxResponseBytes: 64 });
    await expectKind(transport(validatedRequest()), 'output-too-large');
    expect(state.cancelled).toBe(true);
  });

  it('rejects a missing stream without invoking an unbounded text() fallback', async () => {
    let textCalled = false;
    const response = jsonResponse(200, 'x'.repeat(200));
    response.body = null;
    response.text = async () => { textCalled = true; return 'x'.repeat(200); };
    const transport = makeTransport(async () => response, { maxResponseBytes: 64 });
    await expectKind(transport(validatedRequest()), 'invalid-answer');
    expect(textCalled).toBe(false);
  });

  it('maps a truncated JSON body to invalid-answer', async () => {
    const transport = makeTransport(async () => jsonResponse(200, '{"type":"message","stop_reason":"end_turn","content":[{"type":"te'));
    const error = await expectKind(transport(validatedRequest()), 'invalid-answer');
    expect(error.message).toContain('truncated or malformed');
  });

  it('rejects malformed answer payloads', async () => {
    const notJson = messagePayload('a', []);
    notJson.content = [{ type: 'text', text: 'not json' }];
    await expectKind(makeTransport(async () => jsonResponse(200, notJson))(validatedRequest()), 'invalid-answer');
    await expectKind(makeTransport(async () => jsonResponse(200, messagePayload('', [])))(validatedRequest()), 'invalid-answer');
    const badRefs = messagePayload('a', []);
    badRefs.content = [{ type: 'text', text: JSON.stringify({ text: 'a', references: [42] }) }];
    await expectKind(makeTransport(async () => jsonResponse(200, badRefs))(validatedRequest()), 'invalid-answer');
    const longRef = messagePayload('a', ['x'.repeat(64 * 1024 + 1)]);
    await expectKind(makeTransport(async () => jsonResponse(200, longRef))(validatedRequest()), 'invalid-answer');
    const manyRefs = messagePayload('a', Array.from({ length: 201 }, (_v, i) => `e-${i}`));
    await expectKind(makeTransport(async () => jsonResponse(200, manyRefs))(validatedRequest()), 'invalid-answer');
  });
});

describe('ai-anthropic-transport HTTP error mapping', () => {
  function errorBody(type: string): Record<string, unknown> {
    return { type: 'error', error: { type, message: `${MARKER}: provider detail for key ${API_KEY} that must never surface` } };
  }

  it('maps 401 to auth-failed without leaking the provider body', async () => {
    const transport = makeTransport(async () => jsonResponse(401, errorBody('authentication_error')));
    const error = await expectKind(transport(validatedRequest()), 'auth-failed');
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(API_KEY);
  });

  it('maps 403 with a model error type to model-access', async () => {
    const transport = makeTransport(async () => jsonResponse(403, errorBody('model_permission_error')));
    const error = await expectKind(transport(validatedRequest()), 'model-access');
    expect(error.message).not.toContain(MARKER);
  });

  it('maps 403 without a model mention to auth-failed', async () => {
    const transport = makeTransport(async () => jsonResponse(403, errorBody('permission_error')));
    await expectKind(transport(validatedRequest()), 'auth-failed');
  });

  it('maps 404 to model-access', async () => {
    const transport = makeTransport(async () => jsonResponse(404, errorBody('not_found_error')));
    await expectKind(transport(validatedRequest()), 'model-access');
  });

  it('maps 429 to rate-limited with a clamped Retry-After', async () => {
    const transport = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_error'), { 'Retry-After': '45' }));
    const error = await expectKind(transport(validatedRequest()), 'rate-limited');
    expect(error.retryAfterSeconds).toBe(45);
    const clamped = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_error'), { 'Retry-After': '99999' }));
    const clampedError = await expectKind(clamped(validatedRequest()), 'rate-limited');
    expect(clampedError.retryAfterSeconds).toBe(600);
    const noHeader = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_error')));
    const noHeaderError = await expectKind(noHeader(validatedRequest()), 'rate-limited');
    expect(noHeaderError.retryAfterSeconds).toBeUndefined();
  });

  it('maps 400 to invalid-request, 529 and 500 to provider-failure', async () => {
    const bad = makeTransport(async () => jsonResponse(400, errorBody('invalid_request_error')));
    await expectKind(bad(validatedRequest()), 'invalid-request');
    const overloaded = makeTransport(async () => jsonResponse(529, errorBody('overloaded_error')));
    const overloadedResult = await expectKind(overloaded(validatedRequest()), 'provider-failure');
    expect(overloadedResult.message).not.toContain(MARKER);
    const broken = makeTransport(async () => jsonResponse(500, errorBody('api_error')));
    await expectKind(broken(validatedRequest()), 'provider-failure');
  });

  it('refuses redirects instead of forwarding credentials elsewhere', async () => {
    const { response, state } = streamingResponse(302, []);
    response.headers = headersOf({ Location: 'https://example.invalid/steal' });
    const transport = makeTransport(async () => response);
    const error = await expectKind(transport(validatedRequest()), 'provider-failure');
    expect(error.message).toContain('redirect');
    expect(state.cancelled).toBe(true);
  });
});

describe('ai-anthropic-transport network and cancellation', () => {
  it('maps a fetch throw to network', async () => {
    const transport = makeTransport(async () => { throw new Error(`socket hangup near ${API_KEY}`); });
    const error = await expectKind(transport(validatedRequest()), 'network');
    expect(error.message).not.toContain('socket hangup');
    expect(error.message).not.toContain(API_KEY);
  });

  it('never calls fetch when the signal is already aborted', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, messagePayload('ok')));
    const transport = makeTransport(fetchImpl);
    const controller = new AbortController();
    controller.abort();
    await expectKind(transport(validatedRequest(), controller.signal), 'cancelled');
    expect(calls).toHaveLength(0);
  });

  it('maps an abort during body read to cancelled', async () => {
    const fetchImpl: FetchImpl = async (_url, init) => ({
      status: 200,
      headers: headersOf(),
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            if (init.signal?.aborted) { reject(new Error('AbortError')); return; }
            init.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
          }),
          cancel: async () => {},
        }),
      },
      text: async () => '',
    });
    const transport = makeTransport(fetchImpl);
    const controller = new AbortController();
    const pending = transport(validatedRequest(), controller.signal);
    const assertion = expectKind(pending, 'cancelled');
    controller.abort();
    await assertion;
  });
});

describe('ai-anthropic-transport probe', () => {
  it('sends a tiny canned request with no drawing content, system prompt or schema', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, {
      type: 'message', model: 'claude-echo-model', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ready' }],
      usage: { input_tokens: 9, output_tokens: 1 },
    }));
    const transport = makeTransport(fetchImpl);
    const result = await transport.probe();
    // The provider-reported model wins over the configured one.
    expect(result).toEqual({ model: 'claude-echo-model', inputTokens: 9, outputTokens: 1 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers?.['x-api-key']).toBe(API_KEY);
    const raw = init.body!;
    const body = JSON.parse(raw) as Record<string, unknown> & { messages: { role: string; content: string }[] };
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(16);
    expect(body).not.toHaveProperty('system');
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('tools');
    expect(body.messages[0]!.content).toBe('Reply with the single word: ready');
    expect(raw).not.toContain('How long is the line?');
    expect(raw).not.toContain('e-line');
    expect(raw).toContain('ready');
  });

  it('maps a probe 401 to auth-failed', async () => {
    const transport = makeTransport(async () => jsonResponse(401,
      { type: 'error', error: { type: 'authentication_error', message: MARKER } }));
    await expectKind(transport.probe(), 'auth-failed');
  });

  it('verifies a model-accepted probe at its existing token cap without exposing partial text', async () => {
    const transport = makeTransport(async () => jsonResponse(200, {
      type: 'message', model: MODEL, stop_reason: 'max_tokens', content: [],
      usage: { input_tokens: 9, output_tokens: 16 },
    }));
    const result = await transport.probe();
    expect(result).toEqual({ model: MODEL, inputTokens: 9, outputTokens: 16, outputLimited: true });
    expect(result).not.toHaveProperty('text');
  });

  it('still rejects refused, malformed and unrecognized stopped probes', async () => {
    for (const payload of [
      { type: 'message', stop_reason: 'pause_turn', content: [] },
      { type: 'error', stop_reason: 'max_tokens', content: [] },
    ]) await expectKind(makeTransport(async () => jsonResponse(200, payload)).probe(), 'provider-failure');
    await expectKind(makeTransport(async () => jsonResponse(200, {
      type: 'message', stop_reason: 'end_turn', content: [],
    })).probe(), 'invalid-answer');
    await expectKind(makeTransport(async () => jsonResponse(200, {
      type: 'message', stop_reason: 'refusal', content: [{ type: 'text', text: MARKER }],
    })).probe(), 'refused');
  });
});

describe('ai-anthropic-transport bounded lifecycle regressions', () => {
  it('accepts intact references beyond 256 characters and enforces final answer size locally', async () => {
    const id = 'object-'.repeat(80);
    const answer = await makeTransport(async () => jsonResponse(200, messagePayload('ok', [id])))(validatedRequest());
    expect(answer.references).toEqual([id]);
    await expectKind(makeTransport(async () => jsonResponse(200, messagePayload('x'.repeat(8001))))(validatedRequest()), 'output-too-large');
  });

  it('bounds the actual HTTP request before fetching', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, messagePayload('unexpected')));
    const request = validatedRequest({ snapshot: { text: 'x'.repeat(300000) } });
    await expectKind(makeTransport(fetchImpl)(request), 'invalid-request');
    expect(calls).toHaveLength(0);
  });

  it('cancels an outstanding read even when the reader ignores the fetch signal', async () => {
    let startRead!: () => void;
    const reading = new Promise<void>((resolve) => { startRead = resolve; });
    let cancelled = false;
    const response: FakeResponse = {
      status: 200, headers: headersOf(),
      body: { getReader: () => ({
        read: () => { startRead(); return new Promise(() => {}); },
        cancel: async () => { cancelled = true; },
      }) },
      text: async () => '',
    };
    const abort = new AbortController();
    const pending = makeTransport(async () => response)(validatedRequest(), abort.signal);
    const assertion = expectKind(pending, 'cancelled');
    await reading;
    abort.abort();
    await assertion;
    expect(cancelled).toBe(true);
  });

  it('does not wait for a hung reader cancellation after exceeding the cap', async () => {
    let cancelled = false;
    const response: FakeResponse = {
      status: 200, headers: headersOf(),
      body: { getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(65) }),
        cancel: () => { cancelled = true; return new Promise(() => {}); },
      }) },
      text: async () => '',
    };
    await expectKind(makeTransport(async () => response, { maxResponseBytes: 64 })(validatedRequest()), 'output-too-large');
    expect(cancelled).toBe(true);
  });
});

const draftPlanValue = {
  outcome: 'proposal', message: null,
  operations: [{
    op: 'createCircle', a: null, b: null, center: { x: 5, y: 5 }, radius: 3,
    origin: null, width: null, height: null,
    rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
    pivot: null, angleDeg: null,
  }],
};

function draftRequest(over: Partial<ValidatedDraftRequest> = {}): ValidatedDraftRequest {
  return {
    requestId: 'ai-salt-draft-1',
    prompt: 'draw a circle',
    contextJson: '{"kind":"jcad.ai.draft-context","version":1}',
    contextBytes: 44,
    ...over,
  };
}

function draftMessage(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-draft', type: 'message', role: 'assistant', model: MODEL,
    stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 13, output_tokens: 8 },
    ...over,
  };
}

describe('ai-anthropic-transport draft', () => {
  it('posts one draft request with the plan schema, no maxItems anywhere, and the 4096-token budget', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, draftMessage(JSON.stringify(draftPlanValue))));
    const transport = makeTransport(fetchImpl);
    const request = draftRequest();
    await transport.draft(request);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers?.['x-api-key']).toBe(API_KEY);
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');
    const raw = init.body!;
    const body = JSON.parse(raw) as {
      model: string; max_tokens: number; system: string;
      messages: { role: string; content: string }[];
      output_config: {
        format: {
          type: string;
          schema: {
            required: string[];
            properties: {
              outcome: { enum: string[] };
              operations: { items: { required: string[]; properties: { op: { enum: string[] } } } };
            };
          };
        };
      };
    };
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toContain('drafting engine');
    expect(body.system).toContain('eligible:true');
    expect(body.system).toBe(DRAFT_INSTRUCTIONS);
    expect(body.output_config.format.schema).toEqual(draftPlanJsonSchema('anthropic'));
    const unions = (value: unknown): number => {
      if (Array.isArray(value)) return value.reduce((sum, child) => sum + unions(child), 0);
      if (typeof value !== 'object' || value === null) return 0;
      const record = value as Record<string, unknown>;
      return (Array.isArray(record.anyOf) || Array.isArray(record.type) ? 1 : 0)
        + Object.values(record).reduce<number>((sum, child) => sum + unions(child), 0);
    };
    // Native Anthropic schemas allow at most sixteen union-typed parameters.
    expect(unions(body.output_config.format.schema)).toBeLessThanOrEqual(16);
    expect(body.output_config.format.type).toBe('json_schema');
    // Anthropic rejects maxItems in structured-output schemas: it must
    // appear nowhere in the schema (the plan bounds are enforced locally).
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain('maxItems');
    expect(body.output_config.format.schema.required).toEqual(['outcome', 'message', 'operations']);
    expect(body.output_config.format.schema.properties.outcome.enum).toEqual(['proposal', 'clarification', 'unsupported']);
    const operation = body.output_config.format.schema.properties.operations.items;
    expect(operation.properties.op.enum).toEqual(['createLine', 'createCircle', 'createRectangle', 'move', 'copy', 'rotate', 'delete']);
    expect(operation.required).toEqual(['op', 'a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg']);
    // The user content is exactly the prompt plus the exact context JSON.
    expect(body.messages[0]!.content).toBe(`Request: ${request.prompt}\n\nContext (exact JSON):\n${request.contextJson}`);
    // Host bookkeeping never reaches the provider.
    expect(raw).not.toContain('binding');
    expect(raw).not.toContain('contextBytes');
    expect(raw).not.toContain(String(request.requestId));
  });

  it('returns the parsed value unvalidated, with raw content bytes and usage', async () => {
    const text = JSON.stringify(draftPlanValue);
    const { fetchImpl } = recordingFetch(async () => jsonResponse(200, draftMessage(text)));
    const transport = makeTransport(fetchImpl);
    const result = await transport.draft(draftRequest());
    expect(result.value).toEqual(draftPlanValue);
    expect(result.contentBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.contentBytes).toBeGreaterThan(0);
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 8 });
  });

  it('ignores thinking blocks before the single text block', async () => {
    const text = JSON.stringify(draftPlanValue);
    const payload = draftMessage(text, {
      content: [
        { type: 'thinking', thinking: 'reasoning first' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text },
      ],
    });
    const { fetchImpl } = recordingFetch(async () => jsonResponse(200, payload));
    const transport = makeTransport(fetchImpl);
    const result = await transport.draft(draftRequest());
    expect(result.value).toEqual(draftPlanValue);
  });

  it('maps stop reasons: max_tokens to output-too-large, refusal to refused, others to invalid-answer', async () => {
    const text = JSON.stringify(draftPlanValue);
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'max_tokens' }))).fetchImpl).draft(draftRequest()), 'output-too-large');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'refusal' }))).fetchImpl).draft(draftRequest()), 'refused');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'tool_use' }))).fetchImpl).draft(draftRequest()), 'invalid-answer');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { type: 'not-a-message' }))).fetchImpl).draft(draftRequest()), 'invalid-answer');
  });

  it('refuses malformed JSON and multiple text blocks as invalid-answer', async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse(200, draftMessage('{"outcome":')));
    await expectKind(makeTransport(fetchImpl).draft(draftRequest()), 'invalid-answer');
    const twoTexts = draftMessage('{}', {
      content: [{ type: 'text', text: '{"outcome":' }, { type: 'text', text: '"proposal"}' }],
    });
    const { fetchImpl: fetch2 } = recordingFetch(async () => jsonResponse(200, twoTexts));
    await expectKind(makeTransport(fetch2).draft(draftRequest()), 'invalid-answer');
  });
});

function refineRequest(over: Partial<ValidatedRefineRequest> = {}): ValidatedRefineRequest {
  const envelopeJson = '{"kind":"jcad.ai.draft-refine-context","version":1}';
  return {
    requestId: 'ai-salt-refine-1',
    followUp: 'Make that circle bigger.',
    envelopeJson,
    envelopeBytes: Buffer.byteLength(envelopeJson, 'utf8'),
    ...over,
  };
}

describe('ai-anthropic-transport refine (milestone 4)', () => {
  it('posts one refinement request with the refine instructions, no maxItems anywhere, and the 4096-token budget', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, draftMessage(JSON.stringify(draftPlanValue))));
    const transport = makeTransport(fetchImpl);
    const request = refineRequest();
    await transport.refineDraft(request);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers?.['x-api-key']).toBe(API_KEY);
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');
    const raw = init.body!;
    const body = JSON.parse(raw) as {
      model: string; max_tokens: number; system: string;
      messages: { role: string; content: string }[];
      output_config: { format: { type: string; schema: unknown } };
    };
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBe(REFINE_INSTRUCTIONS);
    expect(body.system).toContain('COMPLETE REPLACEMENT PLAN');
    expect(body.system).not.toBe(DRAFT_INSTRUCTIONS);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).toEqual(draftPlanJsonSchema('anthropic'));
    // Anthropic rejects maxItems in structured-output schemas: it must
    // appear nowhere in the serialized request body.
    expect(raw).not.toContain('maxItems');
    // The user content is exactly the follow-up plus the exact envelope JSON.
    expect(body.messages[0]!.content).toBe(
      `Follow-up instruction: ${request.followUp}\n\nRefinement context (exact JSON):\n${request.envelopeJson}`,
    );
    // Host bookkeeping never reaches the provider.
    expect(raw).not.toContain('binding');
    expect(raw).not.toContain('envelopeBytes');
    expect(raw).not.toContain(String(request.requestId));
  });

  it('returns the parsed replacement value unvalidated and tolerates thinking blocks', async () => {
    const text = JSON.stringify(draftPlanValue);
    const payload = draftMessage(text, {
      content: [
        { type: 'thinking', thinking: 'reasoning first' },
        { type: 'text', text },
      ],
    });
    const { fetchImpl } = recordingFetch(async () => jsonResponse(200, payload));
    const transport = makeTransport(fetchImpl);
    const result = await transport.refineDraft(refineRequest());
    expect(result.value).toEqual(draftPlanValue);
    expect(result.contentBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 8 });
  });

  it('maps stop reasons and malformed output like drafts', async () => {
    const text = JSON.stringify(draftPlanValue);
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'max_tokens' }))).fetchImpl).refineDraft(refineRequest()), 'output-too-large');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'refusal' }))).fetchImpl).refineDraft(refineRequest()), 'refused');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage(text, { stop_reason: 'tool_use' }))).fetchImpl).refineDraft(refineRequest()), 'invalid-answer');
    await expectKind(makeTransport(recordingFetch(async () => jsonResponse(200, draftMessage('{"outcome":'))).fetchImpl).refineDraft(refineRequest()), 'invalid-answer');
  });
});

describe('ai-anthropic-transport key hygiene', () => {
  it('no observed error contains the API key or provider body text', () => {
    expect(observedErrors.length).toBeGreaterThan(10);
    for (const error of observedErrors) {
      const shaped = error as { message?: string };
      expect(shaped.message ?? '').not.toContain(API_KEY);
      expect(shaped.message ?? '').not.toContain(MARKER);
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(MARKER);
    }
  });
});
