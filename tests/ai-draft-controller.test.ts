import { describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type Entity, type Layer } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { AiDraftController } from '../src/ai/draft-controller';
import type { AiDraftSource } from '../src/ai/draft-context';
import type { AiDraftResponse } from '../src/ai/draft-plan';
import { AiError, type AiBinding, type AiDraftProvider } from '../src/ai/types';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -3 };
const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
});

interface Harness {
  doc: Drawing;
  source: AiDraftSource;
  selection: string[];
  busy: boolean;
}

function harness(entities: Entity[]): Harness {
  const doc = new Drawing({ entities, layers: [layer0], currentLayer: '0' });
  const h: Harness = { doc, selection: entities.map((e) => e.id), busy: false, source: undefined as never };
  h.source = {
    binding: (): AiBinding => ({
      sessionId: 1, docId: 'doc', contentGeneration: 0,
      docRevision: doc.revision, docLoadCount: doc.loadCount,
      space: { layout: null, viewport: null }, selectionIds: [...h.selection],
    }),
    units: () => DEFAULT_UNITS,
    selectedEntities: () => doc.snapshot.entities.filter((e) => h.selection.includes(e.id)),
    entityById: (id) => doc.snapshot.entities.find((e) => e.id === id),
    boundsFor: (e) => entityBounds(e, undefined as never),
    missingIdKind: () => 'missing-object',
    modelState: () => doc.snapshot,
    frozenDefaults: () => ({ layer: doc.currentLayer, color: 'ByLayer' }),
    interactionBusy: () => h.busy,
  };
  return h;
}

const planProvider = (response: AiDraftResponse): AiDraftProvider => ({
  id: 'fake',
  draft: async () => response,
});
const movePlan: AiDraftResponse = {
  kind: 'plan',
  plan: { message: null, operations: [{ op: 'move', targetIds: ['e1'], dx: 10, dy: 0 }] },
};

describe('AiDraftController', () => {
  it('stages without mutating the drawing, applies as exactly one undo step, and consumes the proposal', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    const before = h.doc.snapshot;
    const status = await controller.generate('move it right', planProvider(movePlan), 'openai|gpt-5|1');
    expect(status.state).toBe('staged');
    // Nothing changed: same state object, no dirty, no undo step.
    expect(h.doc.snapshot).toBe(before);
    expect(h.doc.dirty).toBe(false);
    expect(h.doc.canUndo()).toBe(false);

    const applied = controller.apply();
    expect(applied.state).toBe('idle');
    const moved = h.doc.snapshot.entities[0];
    expect(moved?.type === 'line' && moved.a).toEqual({ x: 10, y: 0 });
    expect(h.doc.dirty).toBe(true);
    expect(h.doc.canUndo()).toBe(true);

    // One Undo restores; one Redo reapplies.
    expect(h.doc.undo()).toBe(true);
    expect(h.doc.snapshot.entities[0]?.type === 'line' && (h.doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 0, y: 0 });
    expect(h.doc.redo()).toBe(true);
    expect(h.doc.snapshot.entities[0]?.type === 'line' && (h.doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 10, y: 0 });

    // Consumed: a second apply is a no-op.
    const revision = h.doc.revision;
    controller.apply();
    expect(h.doc.revision).toBe(revision);
  });

  it('commits the same ids the preview staged', async () => {
    const h = harness([]);
    h.selection = [];
    const controller = new AiDraftController(h.source, h.doc);
    const create: AiDraftResponse = {
      kind: 'plan',
      plan: { message: null, operations: [{ op: 'createCircle', center: { x: 1, y: 2 }, radius: 3, layer: null }] },
    };
    const status = await controller.generate('a circle', planProvider(create), 'fixture|demo|0');
    expect(status.state).toBe('staged');
    if (status.state !== 'staged') return;
    const stagedIds = status.proposal.created.map((e) => e.id);
    controller.apply();
    expect(h.doc.snapshot.entities.map((e) => e.id)).toEqual(stagedIds);
  });

  it('discards a stale proposal at apply instead of rebasing', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    await controller.generate('move', planProvider(movePlan), 'openai|gpt-5|1');
    // Edit-then-undo also invalidates through the monotonic revision.
    h.doc.addEntities([line('e2')]);
    h.doc.undo();
    const status = controller.apply();
    expect(status.state).toBe('invalidated');
    const e1 = h.doc.snapshot.entities[0];
    expect(e1?.type === 'line' && e1.a).toEqual({ x: 0, y: 0 });
  });

  it('invalidates when the selection changes after generation', async () => {
    const h = harness([line('e1'), line('e2')]);
    const controller = new AiDraftController(h.source, h.doc);
    await controller.generate('move', planProvider(movePlan), 'openai|gpt-5|1');
    h.selection = ['e2'];
    expect(controller.apply().state).toBe('invalidated');
  });

  it('surfaces clarifications as messages, and invalid plans as errors, staging nothing', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    const clar = await controller.generate('draw something', planProvider({ kind: 'clarification', message: 'What size?' }), 'x');
    expect(clar.state).toBe('message');
    const bad: AiDraftResponse = {
      kind: 'plan',
      plan: { message: null, operations: [{ op: 'delete', targetIds: ['nope'] }] },
    };
    const err = await controller.generate('delete', planProvider(bad), 'x');
    expect(err.state).toBe('error');
    if (err.state === 'error') expect(err.error.kind).toBe('invalid-plan');
    expect(h.doc.canUndo()).toBe(false);
  });

  it('refuses to generate or apply while the editor is busy, keeping the proposal', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    h.busy = true;
    const refused = await controller.generate('move', planProvider(movePlan), 'x');
    expect(refused.state).toBe('error');
    if (refused.state === 'error') expect(refused.error.kind).toBe('busy');
    h.busy = false;
    await controller.generate('move', planProvider(movePlan), 'x');
    h.busy = true;
    expect(controller.apply().state).toBe('staged'); // untouched, not consumed
    h.busy = false;
    expect(controller.apply().state).toBe('idle');
  });

  it('drops late results after cancellation', async () => {
    const h = harness([line('e1')]);
    let release: ((r: AiDraftResponse) => void) | undefined;
    const slow: AiDraftProvider = {
      id: 'slow',
      draft: () => new Promise<AiDraftResponse>((resolve) => { release = resolve; }),
    };
    const controller = new AiDraftController(h.source, h.doc);
    const pending = controller.generate('move', slow, 'x');
    controller.cancel();
    release?.(movePlan);
    const status = await pending;
    expect(status.state).toBe('idle');
    expect(controller.status.state).toBe('idle');
  });

  it('discards the staged proposal on discard() without touching the drawing', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    await controller.generate('move', planProvider(movePlan), 'x');
    controller.discard();
    expect(controller.status.state).toBe('idle');
    expect(h.doc.canUndo()).toBe(false);
  });

  it('keeps an AiError from the provider as-is', async () => {
    const h = harness([line('e1')]);
    const failing: AiDraftProvider = {
      id: 'failing',
      draft: async () => { throw new AiError('rate-limited', 'slow down'); },
    };
    const controller = new AiDraftController(h.source, h.doc);
    const status = await controller.generate('move', failing, 'x');
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.error.kind).toBe('rate-limited');
  });

  it('settles cancellation without waiting for a provider that ignores abort', async () => {
    const h = harness([line('e1')]);
    let signal: AbortSignal | undefined;
    const provider: AiDraftProvider = { id: 'ignores-abort', draft: (_request, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    } };
    const clear = vi.fn();
    const controller = new AiDraftController(h.source, h.doc, { setTimeoutFn: () => 9, clearTimeoutFn: clear });
    const pending = controller.generate('move', provider, 'x');
    controller.cancel();
    expect(await pending).toEqual({ state: 'idle' });
    expect(signal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalledWith(9);
    expect(h.doc.canUndo()).toBe(false);
  });

  it('settles its timeout and never stages a late response, even if abort is ignored', async () => {
    const h = harness([line('e1')]);
    let timeout: (() => void) | undefined;
    let release: ((response: AiDraftResponse) => void) | undefined;
    const controller = new AiDraftController(h.source, h.doc, { setTimeoutFn: (fn) => { timeout = fn; return 9; }, clearTimeoutFn: () => {} });
    const pending = controller.generate('move', { id: 'slow', draft: () => new Promise((resolve) => { release = resolve; }) }, 'x');
    timeout?.();
    const result = await pending;
    expect(result.state === 'error' && result.error.kind).toBe('timeout');
    release?.(movePlan);
    await Promise.resolve();
    expect(controller.status).toBe(result);
    expect(h.doc.canUndo()).toBe(false);
  });

  it('gives a superseded call its own terminal result and keeps the newer preview', async () => {
    const h = harness([line('e1')]);
    let release: ((response: AiDraftResponse) => void) | undefined;
    const controller = new AiDraftController(h.source, h.doc);
    const old = controller.generate('old', { id: 'slow', draft: () => new Promise((resolve) => { release = resolve; }) }, 'x');
    const next = await controller.generate('new', planProvider(movePlan), 'x');
    expect(next.state).toBe('staged');
    expect(await old).toEqual({ state: 'idle' });
    release?.(movePlan);
    await Promise.resolve();
    expect(controller.status).toBe(next);
  });

  it('does not dispatch after synchronous subscriber cancellation or disposal', async () => {
    for (const action of ['cancel', 'dispose'] as const) {
      const h = harness([line('e1')]);
      const draft = vi.fn(async () => movePlan);
      const clear = vi.fn();
      const controller = new AiDraftController(h.source, h.doc, { setTimeoutFn: () => 9, clearTimeoutFn: clear });
      controller.subscribe((status) => { if (status.state === 'generating') controller[action](); });
      expect(await controller.generate('move', { id: 'fake', draft }, 'x')).toEqual({ state: 'idle' });
      expect(draft).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledWith(9);
    }
  });

  it('handles synchronous timers and source errors without rejecting or stranding state', async () => {
    const h = harness([line('e1')]);
    const draft = vi.fn(async () => movePlan);
    const clear = vi.fn();
    const immediate = new AiDraftController(h.source, h.doc, { setTimeoutFn: (fn) => { fn(); return 9; }, clearTimeoutFn: clear });
    const result = await immediate.generate('move', { id: 'fake', draft }, 'x');
    expect(result.state === 'error' && result.error.kind).toBe('timeout');
    expect(draft).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(9);

    h.source.interactionBusy = () => { throw new Error('source unavailable'); };
    const controller = new AiDraftController(h.source, h.doc);
    const failed = await controller.generate('move', planProvider(movePlan), 'x');
    expect(failed.state === 'error' && failed.error.kind).toBe('invalid-context');
  });

  it('rejects malformed typed provider values and synchronous provider throws', async () => {
    const h = harness([line('e1')]);
    const controller = new AiDraftController(h.source, h.doc);
    for (const value of [null, undefined, {}, { kind: 'unexpected', message: 'x' }, { kind: 'clarification', message: '' },
      { kind: 'plan', plan: { message: null, operations: [{ op: 'delete', targetIds: ['e1'], arbitrary: 'patch' }] } }]) {
      const result = await controller.generate('move', planProvider(value as AiDraftResponse), 'x');
      expect(result.state === 'error' && result.error.kind).toBe('invalid-plan');
    }
    const result = await controller.generate('move', { id: 'throws', draft: () => { throw new Error('secret'); } }, 'x');
    expect(result.state === 'error' && result.error.kind).toBe('provider-failure');
    expect(h.doc.canUndo()).toBe(false);
  });

  it('rechecks fresh configuration generations at admission, response and Apply', async () => {
    const h = harness([line('e1')]);
    let config = 'openai|model|1';
    const controller = new AiDraftController(h.source, h.doc, { configKeyNow: () => config });
    const draft = vi.fn(async () => movePlan);
    const notAdmitted = await controller.generate('move', { id: 'fake', draft }, 'old');
    expect(notAdmitted.state === 'error' && notAdmitted.error.kind).toBe('stale');
    expect(draft).not.toHaveBeenCalled();
    let release: ((response: AiDraftResponse) => void) | undefined;
    const pending = controller.generate('move', { id: 'slow', draft: () => new Promise((resolve) => { release = resolve; }) }, config);
    config = 'openai|model|2';
    release?.(movePlan);
    expect((await pending).state).toBe('invalidated');
    expect((await controller.generate('move', planProvider(movePlan), config)).state).toBe('staged');
    config = 'openai|model|3';
    expect(controller.apply().state).toBe('invalidated');
    expect(h.doc.canUndo()).toBe(false);
  });

  it('invalidates after a command started and cancelled without changing content', async () => {
    const h = harness([line('e1')]);
    let interactions = 0;
    h.source.interactionGeneration = () => interactions;
    const controller = new AiDraftController(h.source, h.doc);
    await controller.generate('move', planProvider(movePlan), 'x');
    interactions += 1;
    expect(h.busy).toBe(false);
    expect(controller.apply().state).toBe('invalidated');
    expect(h.doc.canUndo()).toBe(false);
  });

  it('checks quiet state replacements even if a source binding erroneously retains its revision', async () => {
    const h = harness([line('e1')]);
    const binding = h.source.binding();
    h.source.binding = () => binding;
    const controller = new AiDraftController(h.source, h.doc);
    await controller.generate('move', planProvider(movePlan), 'x');
    h.doc.patchQuiet((state) => ({ ...state, meta: { retained: 'quiet' } }), false);
    expect(controller.apply().state).toBe('invalidated');
    expect(h.doc.snapshot.meta).toEqual({ retained: 'quiet' });
    expect(h.doc.canUndo()).toBe(false);
  });

  it('contains source failures at response and Apply, and never retains an applicable old preview', async () => {
    const h = harness([line('e1')]);
    let release: ((response: AiDraftResponse) => void) | undefined;
    const controller = new AiDraftController(h.source, h.doc);
    const pending = controller.generate('move', { id: 'slow', draft: () => new Promise((resolve) => { release = resolve; }) }, 'x');
    const defaults = h.source.frozenDefaults;
    h.source.frozenDefaults = () => { throw new Error('source failed'); };
    release?.(movePlan);
    expect((await pending).state).toBe('error');
    h.source.frozenDefaults = defaults;
    await controller.generate('move', planProvider(movePlan), 'x');
    h.source.binding = () => { throw new Error('source failed'); };
    expect(() => controller.apply()).not.toThrow();
    expect(controller.status.state).toBe('error');
    expect(h.doc.canUndo()).toBe(false);
  });
});
