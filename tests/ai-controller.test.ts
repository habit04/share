import { describe, it, expect, vi } from 'vitest';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { AiAskController } from '../src/ai/ask-controller';
import { FixtureProvider, fixtureRespond } from '../src/ai/fixture-provider';
import { AiError, type AiAnswer, type AiAskRequest, type AiBinding, type AiProvider, type AiSnapshotSource } from '../src/ai/types';
import { AI_MAX_ANSWER_CHARS, AI_MAX_REFERENCES } from '../src/ai/limits';

const line: Entity = {
  type: 'line', id: 'e-line', layer: 'WIRES', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: 3, y: 4 },
};
const text: Entity = {
  type: 'text', id: 'e-text', layer: 'TAGS', color: 'ByLayer',
  position: { x: 1, y: 2 }, text: 'PB101', height: 2.5, rotation: 0, align: 'left',
};

/** Mutable fake source: tests move revision/selection/space to simulate edits. */
function makeSource() {
  const state = {
    revision: 7,
    generation: 1,
    loadCount: 1,
    docId: 'doc-1',
    sessionId: 1,
    space: { layout: null as string | null, viewport: null as string | null },
    selectionIds: ['e-line', 'e-text'],
    entities: [line, text] as Entity[],
  };
  const source: AiSnapshotSource = {
    binding: (): AiBinding => ({
      sessionId: state.sessionId,
      docId: state.docId,
      contentGeneration: state.generation,
      docRevision: state.revision,
      docLoadCount: state.loadCount,
      space: { ...state.space },
      selectionIds: [...state.selectionIds],
    }),
    units: () => ({ ...DEFAULT_UNITS, insunits: 1 }),
    selectedEntities: () => state.entities.filter((e) => state.selectionIds.includes(e.id)),
    entityById: (id) => state.entities.find((e) => e.id === id),
    boundsFor: () => null,
    missingIdKind: () => 'missing-object',
  };
  return { source, state };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okAnswer: AiAnswer = { text: 'Two objects.', references: ['e-line'] };

describe('AiAskController', () => {
  it('answers through the fixture provider with zero external calls', async () => {
    const { source } = makeSource();
    const controller = new AiAskController(source, new FixtureProvider());
    const status = await controller.ask('how many objects?');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') {
      expect(status.answer.text).toContain('2 of 2 selected objects');
    }
    controller.dispose();
  });

  it('fixture provider is deterministic', () => {
    const { source } = makeSource();
    const controller = new AiAskController(source, new FixtureProvider());
    const snapshot = controller.previewSnapshot();
    const request: AiAskRequest = {
      requestId: 'ai-test-1', question: 'find PB101', snapshot,
      binding: source.binding(),
    };
    const a = fixtureRespond(request);
    const b = fixtureRespond(request);
    expect(a).toEqual(b);
    expect(a.references).toEqual(['e-text']);
  });

  it('fixture text searches do not interpret the search term as an object id', async () => {
    const { source, state } = makeSource();
    state.entities = [{ ...line, id: 'PB101' }, text];
    state.selectionIds = ['PB101', 'e-text'];
    const controller = new AiAskController(source, new FixtureProvider());
    const status = await controller.ask('find PB101');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') expect(status.answer.references).toEqual(['e-text']);
    controller.dispose();
  });

  it('fixture descriptions match complete ids instead of id prefixes', async () => {
    const { source, state } = makeSource();
    state.entities = [line, { ...text, id: 'e-line-extra' }];
    state.selectionIds = ['e-line', 'e-line-extra'];
    const controller = new AiAskController(source, new FixtureProvider());
    const status = await controller.ask('describe e-line-extra');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') expect(status.answer.references).toEqual(['e-line-extra']);
    controller.dispose();
  });

  it.each([null, undefined, [], 'not an object', 3, {}, { text: '   ', references: [] }])(
    'settles malformed provider output as an error and clears the timer: %j', async (value) => {
      const { source } = makeSource();
      const clearTimeoutFn = vi.fn();
      const controller = new AiAskController(source, {
        id: 'malformed', ask: async () => value as AiAnswer,
      }, { setTimeoutFn: () => 17, clearTimeoutFn });
      const status = await controller.ask('count');
      expect(status.state).toBe('error');
      if (status.state === 'error') expect(status.error.kind).toBe('invalid-answer');
      expect(controller.status).toBe(status);
      expect(clearTimeoutFn).toHaveBeenCalledExactlyOnceWith(17);
      controller.dispose();
    },
  );

  it('whitelists answer fields, bounds references and counts every discarded reference', async () => {
    const { source } = makeSource();
    const rawReferences = ['e-line', 'e-nope', 'e-line', 5, ...Array(AI_MAX_REFERENCES + 5).fill('e-text')];
    const controller = new AiAskController(source, {
      id: 'fields',
      ask: async () => ({
        text: 'safe', references: rawReferences,
        toolCalls: [{ command: 'ERASE' }], privateData: 'discard this',
        usage: { inputBytes: Infinity, outputChars: -1, durationMs: 0.5, secret: 'discard this too' },
      }) as unknown as AiAnswer,
    });
    const status = await controller.ask('count');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') {
      expect(status.answer).toEqual({ text: 'safe', references: ['e-line', 'e-text'], usage: { durationMs: 0.5 } });
      expect(status.droppedReferences).toBe(rawReferences.length - 2);
    }
    controller.dispose();
  });

  it('reports a source failure before dispatch without calling the provider', async () => {
    const { source } = makeSource();
    source.units = () => { throw new AiError('invalid-context', 'Context exceeds the permitted size.'); };
    const provider: AiProvider = { id: 'spy', ask: vi.fn(async () => okAnswer) };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('error');
    if (status.state === 'error') {
      expect(status.error.kind).toBe('invalid-context');
      expect(status.error.message).toBe('Context exceeds the permitted size.');
    }
    expect(provider.ask).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('settles a binding failure after dispatch and allows a later request to succeed', async () => {
    const { source } = makeSource();
    const originalBinding = source.binding;
    const gate = deferred<AiAnswer>();
    let calls = 0;
    const clearTimeoutFn = vi.fn();
    const controller = new AiAskController(source, {
      id: 'delayed', ask: () => calls++ === 0 ? gate.promise : Promise.resolve(okAnswer),
    }, { setTimeoutFn: () => 18, clearTimeoutFn });
    const asking = controller.ask('count');
    source.binding = () => { throw new Error('Document unavailable.'); };
    expect(controller.isCurrentBinding(originalBinding())).toBe(false);
    gate.resolve(okAnswer);
    const status = await asking;
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('invalid-context');
    expect(clearTimeoutFn).toHaveBeenCalledExactlyOnceWith(18);
    source.binding = originalBinding;
    expect((await controller.ask('count')).state).toBe('answered');
    controller.dispose();
  });

  it('resolves a superseded call with its own terminal status before the replacement finishes', async () => {
    const { source } = makeSource();
    const gates = [deferred<AiAnswer>(), deferred<AiAnswer>()];
    let calls = 0;
    const controller = new AiAskController(source, { id: 'overlap', ask: () => gates[calls++]!.promise });
    const first = controller.ask('first');
    const second = controller.ask('second');
    const firstStatus = await first;
    expect(firstStatus.state).toBe('cancelled');
    const firstId = 'requestId' in firstStatus ? firstStatus.requestId : '';
    expect(firstId).toMatch(/^ai-[0-9a-f]+-\d+$/);
    expect(controller.status.state).toBe('asking');
    const secondId = controller.status.state === 'asking' ? controller.status.requestId : '';
    expect(secondId).toMatch(/^ai-[0-9a-f]+-\d+$/);
    expect(secondId).not.toBe(firstId);
    gates[0]!.reject(new Error('Late rejection.'));
    gates[1]!.resolve(okAnswer);
    const final = await second;
    expect(final.state).toBe('answered');
    expect('requestId' in final && final.requestId).toBe(secondId);
    controller.dispose();
  });

  it('mints request ids that stay unique across controller recreation (milestone 2)', async () => {
    const { source } = makeSource();
    const seen: string[] = [];
    const provider: AiProvider = {
      id: 'recorder',
      ask: (request) => { seen.push(request.requestId); return Promise.resolve(okAnswer); },
    };
    const first = new AiAskController(source, provider);
    await first.ask('one');
    first.dispose();
    // A recreated controller (panel rebuilt, host jobs may still exist)
    // must never reuse an id the previous controller issued.
    const second = new AiAskController(source, provider);
    await second.ask('two');
    second.dispose();
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const id of seen) expect(id).toMatch(/^ai-[0-9a-f]+-\d+$/);
  });

  it('supports synchronous subscriber cancellation without starting or stranding a provider', async () => {
    const { source } = makeSource();
    const provider: AiProvider = { id: 'never', ask: vi.fn(() => new Promise<AiAnswer>(() => {})) };
    const clearTimeoutFn = vi.fn();
    const controller = new AiAskController(source, provider, { setTimeoutFn: () => 19, clearTimeoutFn });
    controller.subscribe((status) => { if (status.state === 'asking') controller.cancel(); });
    const cancelled = await controller.ask('count');
    expect(cancelled.state).toBe('cancelled');
    expect('requestId' in cancelled && cancelled.requestId).toMatch(/^ai-[0-9a-f]+-\d+$/);
    expect(provider.ask).not.toHaveBeenCalled();
    expect(clearTimeoutFn).toHaveBeenCalledExactlyOnceWith(19);
    controller.dispose();
  });

  it('isolates a failing status subscriber from request settlement and other subscribers', async () => {
    const { source } = makeSource();
    const controller = new AiAskController(source, new FixtureProvider());
    const statuses: string[] = [];
    controller.subscribe(() => { throw new Error('A panel failed to render.'); });
    controller.subscribe((status) => statuses.push(status.state));
    expect((await controller.ask('count')).state).toBe('answered');
    expect(statuses).toEqual(['asking', 'answered']);
    controller.dispose();
  });

  it('rejects empty and over-long questions without calling the provider', async () => {
    const { source } = makeSource();
    const provider: AiProvider = { id: 'spy', ask: vi.fn(async () => okAnswer) };
    const controller = new AiAskController(source, provider);
    expect((await controller.ask('   ')).state).toBe('error');
    expect((await controller.ask('x'.repeat(2001))).state).toBe('error');
    expect(provider.ask).not.toHaveBeenCalled();
  });

  it('passes provider failure through as an error status', async () => {
    const { source } = makeSource();
    const provider: AiProvider = { id: 'bad', ask: async () => { throw new Error('boom'); } };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('provider-failure');
  });

  it('cancels an in-flight request and suppresses its late answer', async () => {
    const { source } = makeSource();
    const gate = deferred<AiAnswer>();
    const provider: AiProvider = { id: 'slow', ask: () => gate.promise };
    const controller = new AiAskController(source, provider);
    const statuses: string[] = [];
    controller.subscribe((s) => statuses.push(s.state));
    const asking = controller.ask('count');
    controller.cancel();
    gate.resolve(okAnswer);
    const final = await asking;
    expect(final.state).toBe('cancelled');
    expect(statuses).not.toContain('answered');
  });

  it('times out a provider that never answers', async () => {
    const { source } = makeSource();
    const timers: Array<() => void> = [];
    const provider: AiProvider = { id: 'never', ask: () => new Promise<AiAnswer>(() => {}) };
    const controller = new AiAskController(source, provider, {
      timeoutMs: 50,
      setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
      clearTimeoutFn: () => {},
    });
    const asking = controller.ask('count');
    expect(timers).toHaveLength(1);
    timers[0]!();
    const status = await asking;
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('timeout');
  });

  it('a newer request supersedes an older one; the older answer never lands', async () => {
    const { source } = makeSource();
    const gates = [deferred<AiAnswer>(), deferred<AiAnswer>()];
    let call = 0;
    const provider: AiProvider = { id: 'multi', ask: () => gates[call++]!.promise };
    const controller = new AiAskController(source, provider);
    const first = controller.ask('first');
    const second = controller.ask('second');
    gates[1]!.resolve({ text: 'newer', references: [] });
    expect((await second).state).toBe('answered');
    gates[0]!.resolve({ text: 'older', references: [] });
    await first;
    expect(controller.status.state).toBe('answered');
    if (controller.status.state === 'answered') expect(controller.status.answer.text).toBe('newer');
  });

  it('suppresses the answer after an edit (revision bump)', async () => {
    const { source, state } = makeSource();
    const gate = deferred<AiAnswer>();
    const provider: AiProvider = { id: 'slow', ask: () => gate.promise };
    const controller = new AiAskController(source, provider);
    const asking = controller.ask('count');
    state.revision += 1; // an edit lands while asking
    gate.resolve(okAnswer);
    expect((await asking).state).toBe('stale');
  });

  it('suppresses the answer after edit-then-undo (same content, higher revision)', async () => {
    const { source, state } = makeSource();
    const gate = deferred<AiAnswer>();
    const provider: AiProvider = { id: 'slow', ask: () => gate.promise };
    const controller = new AiAskController(source, provider);
    const snapshotBefore = controller.previewSnapshot();
    const asking = controller.ask('count');
    state.revision += 2; // edit (+1) then undo (+1): content identical, revision moved
    gate.resolve(okAnswer);
    expect((await asking).state).toBe('stale');
    expect(controller.previewSnapshot().objects).toEqual(snapshotBefore.objects);
  });

  it('suppresses the answer after selection, space, tab and document changes', async () => {
    const mutations: Array<(s: ReturnType<typeof makeSource>['state']) => void> = [
      (s) => { s.selectionIds = ['e-line']; },
      (s) => { s.space = { layout: 'Sheet 1', viewport: null }; },
      (s) => { s.sessionId = 2; s.docId = 'doc-2'; },
      (s) => { s.generation += 1; s.loadCount += 1; },
    ];
    for (const mutate of mutations) {
      const { source, state } = makeSource();
      const gate = deferred<AiAnswer>();
      const provider: AiProvider = { id: 'slow', ask: () => gate.promise };
      const controller = new AiAskController(source, provider);
      const asking = controller.ask('count');
      mutate(state);
      gate.resolve(okAnswer);
      expect((await asking).state).toBe('stale');
      controller.dispose();
    }
  });

  it('drops answer references that are not in the snapshot and reports the drop', async () => {
    const { source } = makeSource();
    const provider: AiProvider = {
      id: 'refs',
      ask: async () => ({ text: 'See e-line and a made-up id.', references: ['e-line', 'e-nope', 'e-text'] }),
    };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') {
      expect(status.answer.references).toEqual(['e-line', 'e-text']);
      expect(status.droppedReferences).toBe(1);
    }
  });

  it('rejects oversized provider output instead of showing a partial answer', async () => {
    const { source } = makeSource();
    const provider: AiProvider = {
      id: 'fat',
      ask: async () => ({ text: 'z'.repeat(AI_MAX_ANSWER_CHARS + 1), references: [] }),
    };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('output-too-large');
  });

  it('treats hostile answer text as plain text data (returned verbatim, never executed)', async () => {
    const { source } = makeSource();
    const hostile = '<script>alert(1)</script> LINE 0,0 ERASE ALL';
    const provider: AiProvider = { id: 'hostile', ask: async () => ({ text: hostile, references: [] }) };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('answered');
    if (status.state === 'answered') expect(status.answer.text).toBe(hostile);
  });

  it('preserves provider AiError kinds', async () => {
    const { source } = makeSource();
    const provider: AiProvider = {
      id: 'unconfigured',
      ask: async () => { throw new AiError('provider-not-configured', 'No provider has been selected.'); },
    };
    const controller = new AiAskController(source, provider);
    const status = await controller.ask('count');
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('provider-not-configured');
  });

  it('dispose cancels in-flight work and refuses later asks', async () => {
    const { source } = makeSource();
    const gate = deferred<AiAnswer>();
    let sawAbort = false;
    const provider: AiProvider = {
      id: 'slow',
      ask: (_req, signal) => {
        signal.addEventListener('abort', () => { sawAbort = true; });
        return gate.promise;
      },
    };
    const controller = new AiAskController(source, provider);
    const asking = controller.ask('count');
    controller.dispose();
    expect(sawAbort).toBe(true);
    gate.resolve(okAnswer);
    await asking;
    expect(controller.status.state).not.toBe('answered');
    const after = await controller.ask('count');
    expect(after.state).toBe('error');
    if (after.state === 'error') expect(after.error.kind).toBe('disposed');
  });
});
