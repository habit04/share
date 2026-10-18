import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Core unit tests for the live-provider checks harness
 * (docs/AI-LIVE-CHECKS.md §Tests; DESIGN §9 T1–T4, T6, T7, T9, T10).
 * Every facade is a scripted fake: no network, no key, no provider call.
 */

interface LiveCheckEntry {
  id: string; title: string; status: string; detail?: string; errorKind?: string;
  durationMs?: number; usage?: { inputTokens?: number; outputTokens?: number };
}
interface LiveChecksReport {
  kind: string; version: number; runTag: string;
  provider: string | null; model: string | null;
  status: string; refusal: string | null;
  checks: LiveCheckEntry[];
  totals: { attempts: number; durationMs: number; tokens?: { inputTokens: number; outputTokens: number } };
}
interface Facade {
  getState: () => Promise<Record<string, unknown>>;
  testConnection: (signal?: AbortSignal) => Promise<unknown>;
  ask: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  draft: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  refine: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
}
interface CoreShape {
  CHECKS: Array<{ id: string; title: string; requires: string | null }>;
  FIXED: { question: string; prompt: string; followUp: string; objectId: string };
  buildSyntheticSnapshot: () => { serializedBytes: number };
  buildDraftContextJson: () => string;
  buildRefineRequest: (args: Record<string, unknown>) => Record<string, unknown> | null;
  runLiveChecks: (facade: Facade, options: { runTag: string; signal?: AbortSignal }) => Promise<LiveChecksReport>;
  formatReportText: (report: LiveChecksReport) => string;
}

const core = require('../electron/ai-live-checks-core.cjs') as CoreShape;

const GEN = '00000000-0000-4000-8000-000000000000:2';
const ANSWER = 'One object; the line is 100 units long.';

const wireCircle = (radius: number): Record<string, unknown> => ({
  op: 'createCircle', a: null, b: null, center: { x: 50, y: 50 }, radius,
  origin: null, width: null, height: null, rotationDeg: null, layer: '0',
  targetIds: null, dx: null, dy: null, pivot: null, angleDeg: null,
});
const planValue = (radius: number): Record<string, unknown> => ({
  outcome: 'proposal', message: null, operations: [wireCircle(radius)],
});

const openAiState = {
  provider: 'openai', model: 'gpt-5', enabled: true, keyPresent: true, keySource: 'session',
  keyPersistence: 'session', credentialProblem: null, configProblem: null, configGeneration: GEN,
};
const anthropicState = {
  ...openAiState, provider: 'anthropic', model: 'claude-sonnet-5-5',
};

interface Recorder {
  facade: Facade;
  calls: string[];
  captured: { ask?: Record<string, unknown>; draft?: Record<string, unknown>; refine?: Record<string, unknown> };
  getStateCalls: () => number;
}

function fakeFacade(over: {
  state?: Record<string, unknown>;
  probe?: unknown; ask?: unknown; draft?: unknown; refine?: unknown;
  methods?: Partial<Facade>;
} = {}): Recorder {
  const calls: string[] = [];
  const captured: Recorder['captured'] = {};
  let getStateCalls = 0;
  const facade: Facade = {
    getState: async () => { getStateCalls += 1; return { ...openAiState, ...(over.state ?? {}) }; },
    testConnection: async () => { calls.push('probe'); return over.probe ?? { model: 'gpt-5', inputTokens: 9, outputTokens: 2 }; },
    ask: async (request) => {
      calls.push('ask'); captured.ask = request as Record<string, unknown>;
      if (over.ask !== undefined) return over.ask;
      return { text: ANSWER, references: [core.FIXED.objectId], providerUsage: { inputTokens: 300, outputTokens: 20 } };
    },
    draft: async (request) => {
      calls.push('draft'); captured.draft = request as Record<string, unknown>;
      if (over.draft !== undefined) return over.draft;
      return { value: planValue(25), configGeneration: GEN, providerUsage: { inputTokens: 800, outputTokens: 60 } };
    },
    refine: async (request) => {
      calls.push('refine'); captured.refine = request as Record<string, unknown>;
      if (over.refine !== undefined) return over.refine;
      return { value: planValue(30), configGeneration: GEN, providerUsage: { inputTokens: 810, outputTokens: 55 } };
    },
    ...(over.methods ?? {}),
  };
  return { facade, calls, captured, getStateCalls: () => getStateCalls };
}

const hostError = (kind: string, message = 'boom'): Error & { kind: string } =>
  Object.assign(new Error(message), { kind });

describe('live-checks fixed fixtures', () => {
  it('pins the synthetic snapshot and context to the host-measured byte counts', () => {
    expect(core.buildSyntheticSnapshot().serializedBytes).toBe(455);
    expect(new TextEncoder().encode(core.buildDraftContextJson()).length).toBe(1250);
    expect(core.FIXED.question).toHaveLength(90);
    // The context JSON is canonical: parse + restringify is a fixed point.
    const json = core.buildDraftContextJson();
    expect(JSON.stringify(JSON.parse(json))).toBe(json);
  });
});

describe('runLiveChecks — T1 happy path', () => {
  it('passes all four checks in order for the OpenAI shape and sums provider tokens', async () => {
    const { facade, calls } = fakeFacade();
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-1' });
    expect(report.status).toBe('pass');
    expect(report.provider).toBe('openai');
    expect(report.model).toBe('gpt-5');
    expect(calls).toEqual(['probe', 'ask', 'draft', 'refine']);
    expect(report.totals.attempts).toBe(4);
    expect(report.totals.tokens).toEqual({ inputTokens: 1919, outputTokens: 137 });
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['probe', 'pass'], ['ask', 'pass'], ['draft', 'pass'], ['refine', 'pass'],
    ]);
    expect(report.checks[1]!.detail).toBe(`Answer of ${ANSWER.length} characters with 1 reference(s).`);
    const text = core.formatReportText(report);
    expect(text).toContain('JCad live provider checks — OpenAI · gpt-5');
    expect(text).toContain('Result: PASS — 4 service attempt(s)');
    expect(text).toContain('1919 input / 137 output tokens reported');
    expect(text).not.toContain(ANSWER);
  });

  it('passes for the Anthropic shape and labels the report accordingly', async () => {
    const { facade } = fakeFacade({ state: anthropicState });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-2' });
    expect(report.status).toBe('pass');
    expect(report.provider).toBe('anthropic');
    expect(core.formatReportText(report)).toContain('JCad live provider checks — Anthropic Claude · claude-sonnet-5-5');
  });
});

describe('runLiveChecks — T2 refusals make zero provider calls', () => {
  it.each([
    ['no key', { keyPresent: false }, 'no-key-configured'],
    ['provider disabled', { enabled: false }, 'provider-disabled'],
    ['credential problem', { credentialProblem: 'credential-corrupt' }, 'credential-problem'],
    ['config problem', { configProblem: 'config unreadable' }, 'config-problem'],
    ['missing generation', { configGeneration: '' }, 'no-destination'],
    ['missing provider', { provider: null }, 'no-destination'],
    ['missing model', { model: null }, 'no-destination'],
  ])('refuses when %s', async (_label, stateOver, refusal) => {
    const { facade, calls, getStateCalls } = fakeFacade({ state: stateOver as Record<string, unknown> });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-3' });
    expect(report.status).toBe('refused');
    expect(report.refusal).toBe(refusal);
    expect(report.totals.attempts).toBe(0);
    expect(calls).toEqual([]);
    expect(getStateCalls()).toBe(1);
    expect(core.formatReportText(report)).toContain(`Result: REFUSED (${refusal})`);
  });

  it('refuses host-unavailable for an incomplete facade and surfaces a getState failure kind', async () => {
    const incomplete = fakeFacade();
    delete (incomplete.facade as Partial<Facade>).refine;
    const refused = await core.runLiveChecks(incomplete.facade, { runTag: 'core-test-4' });
    expect(refused).toMatchObject({ status: 'refused', refusal: 'host-unavailable' });
    expect(incomplete.calls).toEqual([]);

    const failing = fakeFacade({ methods: { getState: async () => { throw hostError('disposed', 'gone'); } } });
    const report = await core.runLiveChecks(failing.facade, { runTag: 'core-test-5' });
    expect(report).toMatchObject({ status: 'refused', refusal: 'disposed' });
  });
});

describe('runLiveChecks — T3 abort on first failure', () => {
  it('stops after a probe failure with exactly one service attempt', async () => {
    const { facade, calls } = fakeFacade({ methods: {
      testConnection: async () => { calls.push('probe'); throw hostError('auth-failed', 'The API key was rejected.'); },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-6' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe']);
    expect(report.totals.attempts).toBe(1);
    expect(report.checks.map((c) => c.status)).toEqual(['fail', 'skipped', 'skipped', 'skipped']);
    expect(report.checks[0]).toMatchObject({ errorKind: 'auth-failed' });
  });

  it('skips draft and refine after an ask failure', async () => {
    const { facade, calls } = fakeFacade({ methods: {
      ask: async () => { calls.push('ask'); throw hostError('network', 'offline'); },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-7' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe', 'ask']);
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'fail', 'skipped', 'skipped']);
  });

  it('marks refine skipped (not blocked) after a draft hard failure', async () => {
    const { facade, calls } = fakeFacade({ methods: {
      draft: async () => { calls.push('draft'); throw hostError('invalid-plan', 'bad plan'); },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-8' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe', 'ask', 'draft']);
    expect(report.checks[3]).toMatchObject({ id: 'refine', status: 'skipped' });
  });
});

describe('runLiveChecks — totals count service attempts, not provider calls (C2)', () => {
  it('counts a pre-transport refusal as an attempt and never claims a provider call', async () => {
    const { facade, calls } = fakeFacade({ methods: {
      ask: async () => { calls.push('ask'); throw hostError('busy', 'Another AI operation is already running.'); },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-c2' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe', 'ask']);
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'fail', 'skipped', 'skipped']);
    // The probe attempt proceeded; the ask attempt was refused before any
    // provider transport ran. Both are service attempts, and neither the
    // report field nor the rendered text may call the total provider calls.
    expect(report.totals.attempts).toBe(2);
    expect(JSON.stringify(report)).not.toContain('providerCalls');
    const text = core.formatReportText(report);
    expect(text).toContain('2 service attempt(s)');
    expect(text).not.toContain('provider call');
  });
});

describe('runLiveChecks — T4 outcome handling', () => {
  it('fails the draft check on clarification and blocks refine', async () => {
    const { facade, calls } = fakeFacade({
      draft: { value: { outcome: 'clarification', message: 'Which radius do you mean?', operations: [] }, configGeneration: GEN },
    });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-9' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe', 'ask', 'draft']);
    expect(report.checks[2]).toMatchObject({ status: 'fail', errorKind: 'clarification' });
    expect(report.checks[2]!.detail).toContain('Which radius do you mean?');
    expect(report.checks[3]).toMatchObject({ id: 'refine', status: 'blocked' });
    expect(report.totals.attempts).toBe(3);
  });

  it('fails the run when refine returns unsupported', async () => {
    const { facade } = fakeFacade({
      refine: { value: { outcome: 'unsupported', message: 'Not supported.', operations: [] }, configGeneration: GEN },
    });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-10' });
    expect(report.status).toBe('fail');
    expect(report.checks[3]).toMatchObject({ status: 'fail', errorKind: 'unsupported' });
  });

  it('fails an ask result that is not an answer as invalid-answer', async () => {
    const { facade } = fakeFacade({ ask: { references: [] } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-11' });
    expect(report.checks[1]).toMatchObject({ status: 'fail', errorKind: 'invalid-answer' });
    expect(report.status).toBe('fail');
  });

  it('blocks refine and fails overall when a proposal carries no operations', async () => {
    const { facade, calls } = fakeFacade({
      draft: { value: { outcome: 'proposal', message: null, operations: [] }, configGeneration: GEN },
    });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-12' });
    expect(report.checks[2]).toMatchObject({ status: 'pass' });
    expect(report.checks[3]).toMatchObject({ status: 'blocked' });
    expect(report.status).toBe('fail'); // a blocked check never reports overall pass
    expect(calls).toEqual(['probe', 'ask', 'draft']);
  });
});

describe('runLiveChecks — T6 configuration change mid-run', () => {
  it('fails the draft check as stale when the result reports a different generation', async () => {
    const { facade, calls } = fakeFacade({
      draft: { value: planValue(25), configGeneration: '00000000-0000-4000-8000-000000000000:9' },
    });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-13' });
    expect(report.checks[2]).toMatchObject({ status: 'fail', errorKind: 'stale' });
    expect(report.checks[3]).toMatchObject({ status: 'skipped' });
    expect(calls).toEqual(['probe', 'ask', 'draft']);
    expect(report.status).toBe('fail');
  });

  it('reports the run cancelled when a call rejects as cancelled', async () => {
    const { facade, calls } = fakeFacade({ methods: {
      ask: async () => { calls.push('ask'); throw hostError('cancelled', 'The AI configuration or renderer changed.'); },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-14' });
    expect(report.status).toBe('cancelled');
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'cancelled', 'skipped', 'skipped']);
    expect(calls).toEqual(['probe', 'ask']);
  });
});

describe('runLiveChecks — T7 external cancellation', () => {
  it('cancels the in-flight check and skips the rest when the signal aborts', async () => {
    const controller = new AbortController();
    const { facade, calls } = fakeFacade({ methods: {
      ask: (_request: unknown, signal?: AbortSignal) => {
        calls.push('ask');
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(hostError('cancelled', 'cancelled')), { once: true });
        });
      },
    } });
    const pending = core.runLiveChecks(facade, { runTag: 'core-test-15', signal: controller.signal });
    await vi.waitFor(() => { expect(calls).toEqual(['probe', 'ask']); });
    controller.abort();
    const report = await pending;
    expect(report.status).toBe('cancelled');
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'cancelled', 'skipped', 'skipped']);
    expect(calls).toEqual(['probe', 'ask']);
  });

  it('never invokes the next check when the signal aborts between checks', async () => {
    const controller = new AbortController();
    const { facade, calls } = fakeFacade({ methods: {
      testConnection: async () => { calls.push('probe'); controller.abort(); return { model: 'gpt-5' }; },
    } });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-16', signal: controller.signal });
    expect(report.status).toBe('cancelled');
    expect(calls).toEqual(['probe']);
    expect(report.checks[1]).toMatchObject({ id: 'ask', status: 'cancelled' });
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'cancelled', 'skipped', 'skipped']);
  });
});

describe('runLiveChecks — T9 refine envelope correctness', () => {
  it('builds the canonical seven-key envelope from the actual draft plan', async () => {
    const { facade, captured } = fakeFacade();
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-17' });
    expect(report.status).toBe('pass');
    const request = captured.refine!;
    expect(request.followUp).toBe(core.FIXED.followUp);
    const envelopeJson = request.envelopeJson as string;
    expect(new TextEncoder().encode(envelopeJson).length).toBe(1800);
    const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual([
      'kind', 'version', 'originalPrompt', 'followUp', 'originalContext', 'currentPlan', 'proposalLabels',
    ]);
    expect(JSON.stringify(envelope)).toBe(envelopeJson); // canonical
    expect(envelope.followUp).toBe(core.FIXED.followUp);
    expect(envelope.originalPrompt).toBe(core.FIXED.prompt);
    const currentPlan = envelope.currentPlan as { message: unknown; operations: unknown };
    expect(currentPlan.operations).toEqual([wireCircle(25)]);
    expect(envelope.proposalLabels).toEqual([
      { label: 'Circle 1', summary: 'Create circle at (50, 50) radius 25 on layer 0' },
    ]);
  });

  it('blocks refine locally when the carried plan exceeds the plan byte cap', async () => {
    const oversized = { ...wireCircle(25), layer: 'x'.repeat(40_000) };
    const { facade, calls } = fakeFacade({
      draft: { value: { outcome: 'proposal', message: null, operations: [oversized] }, configGeneration: GEN },
    });
    const report = await core.runLiveChecks(facade, { runTag: 'core-test-18' });
    expect(report.checks[3]).toMatchObject({ status: 'blocked' });
    expect(report.status).toBe('fail');
    expect(calls).toEqual(['probe', 'ask', 'draft']);
  });

  it('refuses an over-cap envelope at the builder level', () => {
    const request = core.buildRefineRequest({
      requestId: 'lc-builder-1', provider: 'openai', model: 'gpt-5', configGeneration: GEN, configKey: 'k',
      draftOutcome: { message: 'm'.repeat(100_000), operations: [wireCircle(25)] },
    });
    expect(request).toBeNull();
  });
});

describe('runLiveChecks — T10 request pinning and id validity', () => {
  it('pins destination and generation from the state read and uses the fixed texts verbatim', async () => {
    const { facade, captured } = fakeFacade({ state: anthropicState });
    await core.runLiveChecks(facade, { runTag: 'core-test-19' });
    const ask = captured.ask!;
    expect(ask.destination).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(ask.question).toBe(core.FIXED.question);
    expect(ask.requestId).toBe('lc-core-test-19-1');
    const draft = captured.draft!;
    expect(draft.destination).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', configGeneration: GEN });
    expect(draft.prompt).toBe(core.FIXED.prompt);
    expect(draft.requestId).toBe('lc-core-test-19-2');
    const refine = captured.refine!;
    expect(refine.destination).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', configGeneration: GEN });
    expect(refine.requestId).toBe('lc-core-test-19-3');
    for (const id of [ask.requestId, draft.requestId, refine.requestId]) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{7,95}$/);
    }
  });

  it('throws on a runTag that could mint host-invalid ids, before any facade contact', async () => {
    const { facade, getStateCalls } = fakeFacade();
    await expect(core.runLiveChecks(facade, { runTag: 'a' })).rejects.toThrow(TypeError);
    await expect(core.runLiveChecks(facade, { runTag: 'abc' })).rejects.toThrow(/runTag of 8–81 characters/);
    expect(getStateCalls()).toBe(0);
  });
});
