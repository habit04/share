import { describe, it, expect, vi } from 'vitest';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { AiAskController } from '../src/ai/ask-controller';
import { FixtureProvider, fixtureRespond } from '../src/ai/fixture-provider';
import { AiError, type AiAnswer, type AiAskRequest, type AiBinding, type AiProvider, type AiSnapshotSource } from '../src/ai/types';
import { AI_MAX_ANSWER_CHARS } from '../src/ai/limits';

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
      requestId: 1, question: 'find PB101', snapshot,
      binding: source.binding(),
    };
    const a = fixtureRespond(request);
    const b = fixtureRespond(request);
    expect(a).toEqual(b);
    expect(a.references).toEqual(['e-text']);
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
    timers[0]();
    const status = await asking;
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('timeout');
  });

  it('a newer request supersedes an older one; the older answer never lands', async () => {
    const { source } = makeSource();
    const gates = [deferred<AiAnswer>(), deferred<AiAnswer>()];
    let call = 0;
    const provider: AiProvider = { id: 'multi', ask: () => gates[call++].promise };
    const controller = new AiAskController(source, provider);
    const first = controller.ask('first');
    const second = controller.ask('second');
    gates[1].resolve({ text: 'newer', references: [] });
    expect((await second).state).toBe('answered');
    gates[0].resolve({ text: 'older', references: [] });
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
