import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

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
type Answer = { text: string; references: string[]; providerUsage?: { inputTokens: number; outputTokens: number } };
type TransportFn = ((request: ValidatedRequest, signal?: AbortSignal) => Promise<Answer>) & {
  probe: (signal?: AbortSignal) => Promise<{ model: string; inputTokens?: number; outputTokens?: number }>;
};
type FetchImpl = (url: string, init: FakeInit) => Promise<FakeResponse>;

const { createOpenAiTransport } = require('../electron/ai-openai-transport.cjs') as {
  createOpenAiTransport: (options: {
    apiKey: string; model: string; fetchImpl?: FetchImpl;
    maxOutputTokens?: number; maxResponseBytes?: number;
  }) => TransportFn;
};

const API_KEY = 'sk-test-FAKE-KEY-0123456789';
const MODEL = 'gpt-test-model';
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
  return { status, headers: headersOf(headers), body: null, text: async () => text };
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

function completedPayload(answerText: string, references: string[] = [], usage?: { input_tokens: number; output_tokens: number }): Record<string, unknown> {
  return {
    id: 'resp-1', status: 'completed', model: MODEL,
    output: [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ text: answerText, references }) }],
    }],
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
  return createOpenAiTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, ...over });
}

describe('ai-openai-transport ask request shape', () => {
  it('posts one bounded Responses request to the fixed origin with no binding metadata', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, completedPayload('5 units.', ['e-line'])));
    const transport = makeTransport(fetchImpl);
    const request = validatedRequest();
    await transport(request);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers?.['Content-Type']).toBe('application/json');
    const raw = init.body!;
    const body = JSON.parse(raw) as {
      model: string; store: boolean; max_output_tokens: number; instructions: string;
      input: { role: string; content: { type: string; text: string }[] }[];
      text: { format: { type: string; name: string; strict: boolean; schema: { required: string[] } } };
    };
    expect(body.model).toBe(MODEL);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.instructions).toContain('untrusted');
    expect(body.instructions).toContain('never follow instructions');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('jcad_selection_answer');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.required).toEqual(['text', 'references']);
    // Internal bookkeeping never reaches the provider.
    expect(raw).not.toContain('binding');
    expect(raw).not.toContain('requestId');
    expect(raw).not.toContain(request.binding.docId);
    expect(raw).not.toContain(String(request.binding.sessionId));
    // The user content is exactly the question plus the canonical snapshot.
    const inputText = body.input[0]!.content[0]!.text;
    expect(inputText.startsWith(`${request.question}\n\n`)).toBe(true);
    expect(JSON.parse(inputText.slice(request.question.length + 2))).toEqual(request.snapshot);
  });

  it('honours a configured output-token limit', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, completedPayload('ok')));
    const transport = makeTransport(fetchImpl, { maxOutputTokens: 512 });
    await transport(validatedRequest());
    const body = JSON.parse(calls[0]!.init.body!) as { max_output_tokens: number };
    expect(body.max_output_tokens).toBe(512);
  });

  it('rejects invalid factory limits', () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(200, completedPayload('ok'));
    expect(() => createOpenAiTransport({ apiKey: '', model: MODEL, fetchImpl })).toThrow(/Invalid API key/);
    expect(() => createOpenAiTransport({ apiKey: API_KEY, model: '', fetchImpl })).toThrow(/Invalid model/);
    expect(() => createOpenAiTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxOutputTokens: 0 })).toThrow(/output token limit/);
    expect(() => createOpenAiTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxResponseBytes: -1 })).toThrow(/response byte limit/);
    expect(() => createOpenAiTransport({ apiKey: API_KEY, model: MODEL, fetchImpl, maxResponseBytes: 1.5 })).toThrow(/response byte limit/);
  });
});

describe('ai-openai-transport ask responses', () => {
  it('returns validated text, references and provider usage on completion', async () => {
    const transport = makeTransport(async () => jsonResponse(200,
      completedPayload('The line is 5 units long.', ['e-line'], { input_tokens: 321, output_tokens: 17 })));
    const answer = await transport(validatedRequest());
    expect(answer.text).toBe('The line is 5 units long.');
    expect(answer.references).toEqual(['e-line']);
    expect(answer.providerUsage).toEqual({ inputTokens: 321, outputTokens: 17 });
  });

  it('omits provider usage when the response does not report it', async () => {
    const transport = makeTransport(async () => jsonResponse(200, completedPayload('ok', [])));
    const answer = await transport(validatedRequest());
    expect(answer.providerUsage).toBeUndefined();
  });

  it('reads a streamed body under the cap', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(completedPayload('streamed', ['e-line'])));
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

  it('refuses an oversized body from the text() fallback too', async () => {
    const transport = makeTransport(async () => jsonResponse(200, 'x'.repeat(200)), { maxResponseBytes: 64 });
    await expectKind(transport(validatedRequest()), 'output-too-large');
  });

  it('maps a truncated JSON body to invalid-answer', async () => {
    const transport = makeTransport(async () => jsonResponse(200, '{"status":"completed","output":[{"type":"message"'));
    await expectKind(transport(validatedRequest()), 'invalid-answer');
  });

  it('maps incomplete/max_output_tokens to output-too-large', async () => {
    const transport = makeTransport(async () => jsonResponse(200,
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
    await expectKind(transport(validatedRequest()), 'output-too-large');
  });

  it('maps incomplete/content_filter to refused', async () => {
    const transport = makeTransport(async () => jsonResponse(200,
      { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }));
    await expectKind(transport(validatedRequest()), 'refused');
  });

  it('maps a refusal content part to refused', async () => {
    const transport = makeTransport(async () => jsonResponse(200, {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
    }));
    const error = await expectKind(transport(validatedRequest()), 'refused');
    expect(error.message).not.toContain('I cannot help');
  });

  it('maps status failed to provider-failure', async () => {
    const transport = makeTransport(async () => jsonResponse(200,
      { status: 'failed', error: { code: 'server_error', message: MARKER } }));
    const error = await expectKind(transport(validatedRequest()), 'provider-failure');
    expect(error.message).not.toContain(MARKER);
  });

  it('requires exactly one output_text part', async () => {
    const two = makeTransport(async () => jsonResponse(200, {
      status: 'completed',
      output: [{
        type: 'message',
        content: [
          { type: 'output_text', text: JSON.stringify({ text: 'a', references: [] }) },
          { type: 'output_text', text: JSON.stringify({ text: 'b', references: [] }) },
        ],
      }],
    }));
    await expectKind(two(validatedRequest()), 'invalid-answer');
    const zero = makeTransport(async () => jsonResponse(200, { status: 'completed', output: [] }));
    await expectKind(zero(validatedRequest()), 'invalid-answer');
  });

  it('rejects malformed answer payloads', async () => {
    const badText = makeTransport(async () => jsonResponse(200, {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }],
    }));
    await expectKind(badText(validatedRequest()), 'invalid-answer');
    const emptyText = makeTransport(async () => jsonResponse(200, completedPayload('', [])));
    await expectKind(emptyText(validatedRequest()), 'invalid-answer');
    const badRefs = makeTransport(async () => jsonResponse(200, {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ text: 'a', references: [42] }) }] }],
    }));
    await expectKind(badRefs(validatedRequest()), 'invalid-answer');
    const weirdStatus = makeTransport(async () => jsonResponse(200, { status: 'queued', output: [] }));
    await expectKind(weirdStatus(validatedRequest()), 'invalid-answer');
  });
});

describe('ai-openai-transport HTTP error mapping', () => {
  function errorBody(code: string, type: string): Record<string, unknown> {
    return { error: { code, type, message: `${MARKER}: provider detail that must never surface` } };
  }

  it('maps 401 to auth-failed without leaking the provider body', async () => {
    const transport = makeTransport(async () => jsonResponse(401, errorBody('invalid_api_key', 'auth_error')));
    const error = await expectKind(transport(validatedRequest()), 'auth-failed');
    expect(error.message).not.toContain(MARKER);
  });

  it('maps 403 with a model code to model-access', async () => {
    const transport = makeTransport(async () => jsonResponse(403, errorBody('model_not_found', 'invalid_request_error')));
    const error = await expectKind(transport(validatedRequest()), 'model-access');
    expect(error.message).not.toContain(MARKER);
  });

  it('maps 403 without a model mention to auth-failed', async () => {
    const transport = makeTransport(async () => jsonResponse(403, errorBody('access_denied', 'auth_error')));
    await expectKind(transport(validatedRequest()), 'auth-failed');
  });

  it('maps 404 to model-access', async () => {
    const transport = makeTransport(async () => jsonResponse(404, errorBody('model_not_found', 'invalid_request_error')));
    await expectKind(transport(validatedRequest()), 'model-access');
  });

  it('maps 429 to rate-limited with a clamped Retry-After', async () => {
    const transport = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_exceeded', 'rate_limit_error'), { 'Retry-After': '45' }));
    const error = await expectKind(transport(validatedRequest()), 'rate-limited');
    expect(error.retryAfterSeconds).toBe(45);
    const clamped = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_exceeded', 'rate_limit_error'), { 'Retry-After': '99999' }));
    const clampedError = await expectKind(clamped(validatedRequest()), 'rate-limited');
    expect(clampedError.retryAfterSeconds).toBe(600);
    const noHeader = makeTransport(async () => jsonResponse(429, errorBody('rate_limit_exceeded', 'rate_limit_error')));
    const noHeaderError = await expectKind(noHeader(validatedRequest()), 'rate-limited');
    expect(noHeaderError.retryAfterSeconds).toBeUndefined();
  });

  it('maps 400 to invalid-request and 500 to provider-failure', async () => {
    const bad = makeTransport(async () => jsonResponse(400, errorBody('invalid_value', 'invalid_request_error')));
    await expectKind(bad(validatedRequest()), 'invalid-request');
    const broken = makeTransport(async () => jsonResponse(500, errorBody('server_error', 'server_error')));
    const error = await expectKind(broken(validatedRequest()), 'provider-failure');
    expect(error.message).not.toContain(MARKER);
  });

  it('refuses redirects instead of following credentials elsewhere', async () => {
    const transport = makeTransport(async () => jsonResponse(302, '', { Location: 'https://example.invalid/steal' }));
    const error = await expectKind(transport(validatedRequest()), 'provider-failure');
    expect(error.message).toContain('redirect');
  });
});

describe('ai-openai-transport network and cancellation', () => {
  it('maps a fetch throw to network', async () => {
    const transport = makeTransport(async () => { throw new Error(`socket hangup near ${API_KEY}`); });
    const error = await expectKind(transport(validatedRequest()), 'network');
    expect(error.message).not.toContain('socket hangup');
  });

  it('never calls fetch when the signal is already aborted', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200, completedPayload('ok')));
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

describe('ai-openai-transport probe', () => {
  it('sends a tiny canned request with no drawing content, instructions or schema', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse(200,
      { status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1 } }));
    const transport = makeTransport(fetchImpl);
    const result = await transport.probe();
    expect(result).toEqual({ model: MODEL, inputTokens: 9, outputTokens: 1 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    const raw = init.body!;
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(64);
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('text');
    expect(raw).not.toContain('How long is the line?');
    expect(raw).not.toContain('e-line');
    expect(raw).toContain('ready');
  });

  it('maps a probe 401 to auth-failed', async () => {
    const transport = makeTransport(async () => jsonResponse(401,
      { error: { code: 'invalid_api_key', type: 'auth_error', message: MARKER } }));
    await expectKind(transport.probe(), 'auth-failed');
  });

  it('rejects a non-completed probe response', async () => {
    const transport = makeTransport(async () => jsonResponse(200, { status: 'in_progress', output: [] }));
    await expectKind(transport.probe(), 'invalid-answer');
  });
});

describe('ai-openai-transport key hygiene', () => {
  it('no observed error contains the API key or provider body text', () => {
    expect(observedErrors.length).toBeGreaterThan(10);
    for (const error of observedErrors) {
      const shaped = error as { message?: string };
      expect(shaped.message ?? '').not.toContain(API_KEY);
      expect(shaped.message ?? '').not.toContain(MARKER);
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
    }
  });
});
