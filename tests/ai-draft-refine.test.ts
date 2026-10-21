import { describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type Entity, type Layer } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { AiDraftController, type AiDraftControllerOptions } from '../src/ai/draft-controller';
import type { AiDraftSource } from '../src/ai/draft-context';
import { buildRefineEnvelope, diffProposalChanges, proposalLabels } from '../src/ai/draft-refine';
import { compileAiPlan } from '../src/ai/draft-compiler';
import { applyCompiledProposal } from '../src/ai/draft-apply';
import { defaultLayout } from '../src/core/layouts';
import { captureDraftContext } from '../src/ai/draft-context';
import { AiError, type AiDraftProvider, type AiDraftRefineRequest } from '../src/ai/types';
import { planToWire, type AiDraftResponse, type AiPlan } from '../src/ai/draft-plan';
import { FixtureDraftProvider } from '../src/ai/fixture-draft';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -3 };
const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
});

function harness(doc: Drawing, selection: string[], busy: { value: boolean } = { value: false }): AiDraftSource {
  return {
    binding: () => ({
      sessionId: 1, docId: 'doc', contentGeneration: 0,
      docRevision: doc.revision, docLoadCount: doc.loadCount,
      space: { layout: null, viewport: null }, selectionIds: selection,
    }),
    units: () => DEFAULT_UNITS,
    selectedEntities: () => doc.snapshot.entities.filter((e) => selection.includes(e.id)),
    entityById: (id) => doc.snapshot.entities.find((e) => e.id === id),
    boundsFor: (e) => entityBounds(e, undefined as never),
    missingIdKind: () => 'missing-object',
    modelState: () => doc.snapshot,
    frozenDefaults: () => ({ layer: doc.currentLayer, color: 'ByLayer' }),
    interactionBusy: () => busy.value,
  };
}

const planOf = (operations: AiPlan['operations']): AiDraftResponse => ({ kind: 'plan', plan: { message: null, operations } });
const movePlan = (dx: number): AiDraftResponse => planOf([{ op: 'move', targetIds: ['e1'], dx, dy: 0 }]);

function provider(script: {
  draft: AiDraftResponse;
  refine?: (request: AiDraftRefineRequest, call: number, signal: AbortSignal) => Promise<AiDraftResponse> | AiDraftResponse;
}): AiDraftProvider & { refineCalls: AiDraftRefineRequest[] } {
  const refineCalls: AiDraftRefineRequest[] = [];
  return {
    id: 'fake',
    refineCalls,
    draft: async () => script.draft,
    refine: async (request, signal) => {
      refineCalls.push(request);
      if (!script.refine) throw new AiError('host-unavailable', 'no refine scripted');
      return script.refine(request, refineCalls.length, signal);
    },
  };
}

async function stagedController(refineScript?: (r: AiDraftRefineRequest, n: number, signal: AbortSignal) => Promise<AiDraftResponse> | AiDraftResponse, options: AiDraftControllerOptions = {}) {
  const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
  const source = harness(doc, ['e1']);
  const controller = new AiDraftController(source, doc, options);
  const p = provider({ draft: movePlan(10), refine: refineScript });
  await controller.generate('Move the line 10 right', p, 'fixture');
  expect(controller.status.state).toBe('staged');
  return { doc, source, controller, provider: p };
}

describe('refine envelope', () => {
  it('carries exactly the original context, original prompt, canonical plan, labels and follow-up', async () => {
    const { controller } = await stagedController();
    const staged = controller.status;
    if (staged.state !== 'staged') throw new Error('expected staged');
    const { envelopeJson, followUp } = buildRefineEnvelope(staged.capture, staged.proposal, '  Change that movement to 15 units right in total. ');
    expect(followUp).toBe('Change that movement to 15 units right in total.');
    const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual(['kind', 'version', 'originalPrompt', 'followUp', 'originalContext', 'currentPlan', 'proposalLabels']);
    expect(envelope.kind).toBe('jcad.ai.draft-refine-context');
    expect(envelope.version).toBe(1);
    expect(envelope.originalPrompt).toBe('Move the line 10 right');
    expect(envelope.originalContext).toEqual(JSON.parse(staged.capture.contextJson));
    const plan = envelope.currentPlan as { operations: Record<string, unknown>[] };
    expect(plan.operations[0]).toMatchObject({ op: 'move', targetIds: ['e1'], dx: 10, dy: 0, a: null, layer: null });
    expect(envelope.proposalLabels).toEqual([{ label: 'Move 1', summary: expect.stringContaining('Move 1 object(s) by (10, 0)') }]);
    expect(proposalLabels(staged.proposal)[0]?.label).toBe('Move 1');
  });

  it('refuses an oversized envelope whole, without truncation', () => {
    const layerName = 'L'.repeat(500);
    const entities = Array.from({ length: 200 }, (_, i) => ({ ...line(`entity-${i}`), layer: layerName }));
    const doc = new Drawing({ entities, layers: [{ ...layer0, name: layerName }], currentLayer: layerName });
    const source = harness(doc, entities.map((entity) => entity.id));
    const capture = captureDraftContext(source, 'a line', 'fixture');
    let n = 0;
    const huge: AiPlan = {
      message: null,
      operations: Array.from({ length: 48 }, (_, i) => ({
        op: 'createLine' as const, a: { x: i, y: 0 }, b: { x: i + 1, y: 1 }, layer: null,
      })),
    };
    const compiled = compileAiPlan(huge, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const before = doc.snapshot;
    expect(() => buildRefineEnvelope(capture, compiled.proposal, 'make it bigger')).toThrowError(/context limit/);
    expect(doc.snapshot).toBe(before);
    expect(doc.dirty).toBe(false);
  });

  it('rejects forged and cross-capture envelopes before accepting their context or labels', async () => {
    const { controller } = await stagedController();
    const staged = controller.status;
    if (staged.state !== 'staged') throw new Error('expected staged');
    expect(() => buildRefineEnvelope(staged.capture, { ...staged.proposal }, 'change')).toThrow('does not belong');
    expect(() => buildRefineEnvelope({ ...staged.capture, contextJson: '{bad' }, staged.proposal, 'change')).toThrow('does not belong');
  });

  it('checks the unchanged plan cap after full wire expansion, before any refinement is sent', () => {
    const name = 'L'.repeat(400);
    const doc = new Drawing({ entities: [], layers: [{ ...layer0, name }], currentLayer: name });
    const capture = captureDraftContext(harness(doc, []), 'lines', 'fixture');
    const plan: AiPlan = { message: null, operations: Array.from({ length: 64 }, (_, i) => ({ op: 'createLine', a: { x: i, y: 0 }, b: { x: i + 1, y: 1 }, layer: name })) };
    let n = 0;
    const compiled = compileAiPlan(plan, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(() => buildRefineEnvelope(capture, compiled.proposal, 'change')).toThrow('plan size limit');
  });

  it('owns immutable wire coordinates without freezing or retaining provider-owned point objects', () => {
    const a = { x: 1, y: 2 };
    const wire = planToWire({ message: null, operations: [{ op: 'createLine', a, b: { x: 3, y: 4 }, layer: null }] });
    a.x = 99;
    expect(wire.operations[0]?.a).toEqual({ x: 1, y: 2 });
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(wire.operations)).toBe(true);
    expect(Object.isFrozen(wire.operations[0]?.a)).toBe(true);
  });
});

describe('draft refinement session', () => {
  it('move 10 refined to 15 total replaces the plan — Apply moves 15 once, one Undo restores', async () => {
    const { doc, controller, provider: p } = await stagedController(async (request) => {
      const envelope = JSON.parse(request.envelopeJson) as { currentPlan: { operations: { dx: number }[] } };
      expect(envelope.currentPlan.operations[0]?.dx).toBe(10);
      return movePlan(15);
    });
    controller.followUpEdited('Change that movement to 15 units right in total.');
    expect(controller.status.state === 'staged' && controller.status.followUp?.phase).toBe('entered');
    // Apply is blocked while the follow-up is unresolved.
    controller.apply();
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a.x).toBe(0);
    await controller.refine('Change that movement to 15 units right in total.', p, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.version).toBe(2);
    expect(staged.followUp).toBeNull();
    expect(p.refineCalls).toHaveLength(1);
    expect(p.refineCalls[0]?.binding).toBe(staged.capture.binding);
    controller.apply();
    const moved = doc.snapshot.entities[0];
    expect(moved?.type === 'line' && moved.a).toEqual({ x: 15, y: 0 });
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 0, y: 0 });
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 15, y: 0 });
  });

  it('a clarification preserves the previous preview, blocks Apply, and Discard Follow-up restores it after fresh checks', async () => {
    const { doc, controller, provider: p } = await stagedController(async () => ({ kind: 'clarification', message: 'Which movement do you mean?' }));
    await controller.refine('Make it bigger', p, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.version).toBe(1);
    expect(staged.followUp?.phase).toBe('clarification');
    controller.apply();
    expect(doc.canUndo()).toBe(false); // still blocked
    controller.discardFollowUp();
    const restored = controller.status;
    expect(restored.state).toBe('staged');
    if (restored.state !== 'staged') return;
    expect(restored.followUp).toBeNull();
    controller.apply();
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 10, y: 0 });
  });

  it('Discard Follow-up after the drawing changed invalidates the session instead of restoring a stale preview', async () => {
    const { doc, controller, provider: p } = await stagedController(async () => ({ kind: 'clarification', message: 'Which?' }));
    await controller.refine('Ambiguous', p, 'fixture');
    doc.addEntities([line('e2')]); // a quiet edit: revision advances
    controller.discardFollowUp();
    expect(controller.status.state).toBe('invalidated');
    expect(doc.snapshot.entities).toHaveLength(2);
  });

  it('a failed refinement preserves the previous preview and can be retried', async () => {
    let calls = 0;
    const { controller, provider: p } = await stagedController(async () => {
      calls += 1;
      if (calls === 1) throw new AiError('provider-failure', 'boom');
      return movePlan(20);
    });
    await controller.refine('Change it', p, 'fixture');
    expect(controller.status.state === 'staged' && controller.status.followUp?.phase).toBe('failed');
    expect(controller.status.state === 'staged' && controller.status.version).toBe(1);
    await controller.refine('Change it', p, 'fixture');
    expect(controller.status.state === 'staged' && controller.status.version).toBe(2);
  });

  it('cancelling a refinement keeps the previous preview; a late result cannot stage', async () => {
    let release: (value: AiDraftResponse) => void = () => {};
    const gate = new Promise<AiDraftResponse>((resolve) => { release = resolve; });
    const { controller, provider: p } = await stagedController(() => gate);
    const refining = controller.refine('Change that movement to 15 units right in total.', p, 'fixture');
    expect(controller.status.state === 'staged' && controller.status.followUp?.phase).toBe('refining');
    controller.cancelRefine();
    await refining;
    expect(controller.status.state === 'staged' && controller.status.followUp?.phase).toBe('entered');
    expect(controller.status.state === 'staged' && controller.status.version).toBe(1);
    release(movePlan(99)); // the provider answers anyway — too late
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.status.state === 'staged' && controller.status.version).toBe(1);
  });

  it('a document edit during refinement invalidates the whole session on settlement', async () => {
    let release: (value: AiDraftResponse) => void = () => {};
    const gate = new Promise<AiDraftResponse>((resolve) => { release = resolve; });
    const { doc, controller, provider: p } = await stagedController(() => gate);
    const refining = controller.refine('Change it', p, 'fixture');
    doc.addEntities([line('e2')]);
    release(movePlan(15));
    await refining;
    expect(controller.status.state).toBe('invalidated');
  });

  it('a refined plan that targets a preview-generated id is rejected whole (forged target)', async () => {
    const { controller, provider: p } = await stagedController(async () => {
      // 'id-1' style ids exist only inside previews, never in the drawing.
      return planOf([{ op: 'move', targetIds: ['preview-id-1'], dx: 5, dy: 0 }]);
    });
    await controller.refine('Move the new thing', p, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.followUp?.phase).toBe('failed');
    expect(staged.followUp?.message).toContain('not an eligible selected object');
    expect(staged.version).toBe(1);
  });

  it('editing the follow-up text while refining supersedes the pending refinement', async () => {
    let release: (value: AiDraftResponse) => void = () => {};
    const gate = new Promise<AiDraftResponse>((resolve) => { release = resolve; });
    const { controller, provider: p } = await stagedController(() => gate);
    const refining = controller.refine('First version', p, 'fixture');
    controller.followUpEdited('Edited follow-up');
    await refining;
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.followUp?.phase).toBe('entered');
    expect(staged.followUp?.text).toBe('Edited follow-up');
    release(movePlan(99));
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.status.state === 'staged' && controller.status.version).toBe(1);
  });

  it('keeps provider instance binding when invoking refinement', async () => {
    class InstanceProvider implements AiDraftProvider {
      readonly id = 'instance';
      readonly replacement = movePlan(15);
      async draft(): Promise<AiDraftResponse> { return movePlan(10); }
      async refine(): Promise<AiDraftResponse> { return this.replacement; }
    }
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const controller = new AiDraftController(harness(doc, ['e1']), doc);
    const p = new InstanceProvider();
    await controller.generate('Move right', p, 'fixture');
    const refined = await controller.refine('15 total', p, 'fixture');
    expect(refined.state === 'staged' && refined.version).toBe(2);
  });

  it('settles and aborts cancellation without waiting for a provider that ignores abort', async () => {
    let signal: AbortSignal | undefined;
    const clear = vi.fn();
    const { controller, provider: p } = await stagedController((_request, _n, s) => {
      signal = s;
      return new Promise(() => {});
    }, { setTimeoutFn: () => 9, clearTimeoutFn: clear });
    const pending = controller.refine('15 total', p, 'fixture');
    controller.cancelRefine();
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalledWith(9);
    expect(result.state === 'staged' && result.followUp?.phase).toBe('entered');
    expect(result.state === 'staged' && result.version).toBe(1);
  });

  it('installs pending ownership before subscribers can synchronously cancel, edit, discard or dispose', async () => {
    for (const action of ['cancel', 'edit', 'discardFollowUp', 'discard', 'dispose'] as const) {
      const { controller, provider: p } = await stagedController(async () => movePlan(15));
      let triggered = false;
      controller.subscribe((status) => {
        if (triggered || status.state !== 'staged' || status.followUp?.phase !== 'refining') return;
        triggered = true;
        if (action === 'cancel') controller.cancelRefine();
        else if (action === 'edit') controller.followUpEdited('new text');
        else controller[action]();
      });
      await controller.refine('15 total', p, 'fixture');
      expect(triggered).toBe(true);
      expect(p.refineCalls).toHaveLength(0);
      if (action === 'edit') expect(controller.status.state === 'staged' && controller.status.followUp?.text).toBe('new text');
      if (action === 'discardFollowUp') expect(controller.status.state === 'staged' && controller.status.followUp).toBeNull();
      if (action === 'discard') expect(controller.status.state).toBe('idle');
    }
  });

  it('does not dispatch an older request superseded by a synchronous subscriber', async () => {
    const { controller, provider: p } = await stagedController(async () => movePlan(20));
    let newer: Promise<unknown> | undefined;
    let triggered = false;
    controller.subscribe((status) => {
      if (triggered || status.state !== 'staged' || status.followUp?.phase !== 'refining') return;
      triggered = true;
      newer = controller.refine('20 total', p, 'fixture');
    });
    const previous = await controller.refine('15 total', p, 'fixture');
    await newer;
    expect(previous.state).toBe('idle');
    expect(p.refineCalls.map((request) => request.followUp)).toEqual(['20 total']);
    expect(controller.status.state === 'staged' && controller.status.version).toBe(2);
  });

  it('times out ignored-abort providers and drops their eventual results', async () => {
    let timeout: (() => void) | undefined;
    let release: ((response: AiDraftResponse) => void) | undefined;
    let signal: AbortSignal | undefined;
    const { controller, provider: p } = await stagedController((_request, _n, s) => {
      signal = s;
      return new Promise((resolve) => { release = resolve; });
    }, { setTimeoutFn: (fn) => { timeout = fn; return 9; }, clearTimeoutFn: () => {} });
    const pending = controller.refine('15 total', p, 'fixture');
    timeout?.();
    const result = await pending;
    expect(result.state === 'staged' && result.followUp?.phase).toBe('failed');
    expect(result.state === 'staged' && result.version).toBe(1);
    expect(signal?.aborted).toBe(true);
    release?.(movePlan(99));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.status).toBe(result);
  });

  it('invalidates stale sessions on rejection, timeout and cancellation as well as success', async () => {
    for (const outcome of ['rejection', 'timeout', 'cancellation'] as const) {
      let reject: ((cause: unknown) => void) | undefined;
      let timeout: (() => void) | undefined;
      const { doc, controller, provider: p } = await stagedController(() => new Promise((_resolve, fail) => { reject = fail; }),
        { setTimeoutFn: (fn) => { timeout = fn; return 9; }, clearTimeoutFn: () => {} });
      const pending = controller.refine('15 total', p, 'fixture');
      doc.patchQuiet((state) => ({ ...state, meta: { changed: true } }), false);
      if (outcome === 'rejection') reject?.(new AiError('network', 'failed'));
      else if (outcome === 'timeout') timeout?.();
      else controller.cancelRefine();
      expect((await pending).state).toBe('invalidated');
      expect(controller.status.state).toBe('invalidated');
      expect(doc.canUndo()).toBe(false);
    }
  });

  it('treats authoritative provider stale errors as session invalidation', async () => {
    const { controller, provider: p } = await stagedController(async () => { throw new AiError('stale', 'Host destination generation changed'); });
    expect((await controller.refine('15 total', p, 'fixture')).state).toBe('invalidated');
  });

  it('contains source failures at refinement admission without rejecting', async () => {
    for (const method of ['interactionBusy', 'binding', 'modelState', 'frozenDefaults'] as const) {
      const { source, controller, provider: p } = await stagedController(async () => movePlan(15));
      source[method] = (() => { throw new Error('source failed'); }) as never;
      const result = await controller.refine('15 total', p, 'fixture');
      expect(result.state).toBe('invalidated');
      expect(p.refineCalls).toHaveLength(0);
    }
  });

  it('accepts refinement results during view-only busy, but keeps Apply/admission guarded and actual edits stale', async () => {
    for (const editing of [false, true]) {
      let release: ((response: AiDraftResponse) => void) | undefined;
      const { source, controller, doc, provider: p } = await stagedController(() => new Promise((resolve) => { release = resolve; }));
      let busy = false;
      source.interactionBusy = () => busy;
      source.editingInteractionBusy = () => busy && editing;
      const pending = controller.refine('15 total', p, 'fixture');
      busy = true;
      release?.(movePlan(15));
      const result = await pending;
      if (editing) {
        expect(result.state).toBe('invalidated');
        expect(doc.canUndo()).toBe(false);
      } else {
        expect(result.state === 'staged' && result.version).toBe(2);
        expect(controller.apply()).toBe(result);
        expect(doc.canUndo()).toBe(false);
        await controller.refine('20 total', p, 'fixture');
        expect(p.refineCalls).toHaveLength(1);
        busy = false;
        expect(controller.apply().state).toBe('idle');
        expect(doc.snapshot.entities[0]?.type === 'line' && doc.snapshot.entities[0].a.x).toBe(15);
      }
    }
  });

  it('allows cancellation and fresh follow-up discard during navigation while Apply stays paused', async () => {
    const { source, controller, doc, provider: p } = await stagedController(() => new Promise(() => {}));
    let navigating = false;
    source.interactionBusy = () => navigating;
    source.editingInteractionBusy = () => false;
    const pending = controller.refine('15 total', p, 'fixture');
    navigating = true;
    controller.cancelRefine();
    const cancelled = await pending;
    expect(cancelled.state === 'staged' && cancelled.followUp?.phase).toBe('entered');
    const restored = controller.discardFollowUp();
    expect(restored.state === 'staged' && restored.followUp).toBeNull();
    expect(controller.apply()).toBe(restored);
    expect(doc.canUndo()).toBe(false);
    navigating = false;
    expect(controller.apply().state).toBe('idle');
  });

  it('keeps cleared follow-up text unresolved until explicit discard and freezes published state', async () => {
    const { controller, doc } = await stagedController();
    controller.followUpEdited('change it');
    controller.followUpEdited('');
    const status = controller.status;
    expect(status.state === 'staged' && status.followUp?.text).toBe('');
    expect(status.state === 'staged' && status.followUp?.phase).toBe('entered');
    expect(Object.isFrozen(status)).toBe(true);
    expect(status.state === 'staged' && Object.isFrozen(status.followUp)).toBe(true);
    expect(() => { (status as { followUp: null }).followUp = null; }).toThrow();
    controller.apply();
    expect(doc.canUndo()).toBe(false);
    controller.discardFollowUp();
    expect(controller.status.state === 'staged' && controller.status.followUp).toBeNull();
  });

  it('bounds stored oversized text and never silently sends a shortened valid instruction', async () => {
    const { controller, provider: p } = await stagedController(async () => movePlan(15));
    controller.followUpEdited('x'.repeat(100000));
    const staged = controller.status;
    expect(staged.state === 'staged' && staged.followUp?.text.length).toBe(2001);
    expect(staged.state === 'staged' && staged.followUp?.phase).toBe('failed');
    await controller.refine(staged.state === 'staged' ? staged.followUp?.text ?? '' : '', p, 'fixture');
    expect(p.refineCalls).toHaveLength(0);
    expect(controller.status.state === 'staged' && controller.status.followUp?.phase).toBe('failed');
  });

  it('revokes replaced and discarded artifacts even if external code retained the old status', async () => {
    const { doc, controller, provider: p } = await stagedController(async () => movePlan(15));
    const old = controller.status;
    if (old.state !== 'staged') throw new Error('expected staged');
    await controller.refine('15 total', p, 'fixture');
    expect(() => applyCompiledProposal(doc, old.capture, old.proposal)).toThrow('new preview');
    const latest = controller.status;
    if (latest.state !== 'staged') throw new Error('expected staged');
    controller.discard();
    expect(() => applyCompiledProposal(doc, latest.capture, latest.proposal)).toThrow('new preview');
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });

  it('suspends direct Apply during unresolved follow-ups and restores it only after explicit fresh discard', async () => {
    const { doc, controller, provider: p } = await stagedController(() => new Promise(() => {}));
    const old = controller.status;
    if (old.state !== 'staged') throw new Error('expected staged');
    controller.followUpEdited('15 total');
    expect(() => applyCompiledProposal(doc, old.capture, old.proposal)).toThrow('new preview');
    expect(() => buildRefineEnvelope(old.capture, old.proposal, '15 total')).not.toThrow();
    const pending = controller.refine('15 total', p, 'fixture');
    expect(() => applyCompiledProposal(doc, old.capture, old.proposal)).toThrow('new preview');
    controller.cancelRefine();
    await pending;
    expect(() => applyCompiledProposal(doc, old.capture, old.proposal)).toThrow('new preview');
    controller.discardFollowUp();
    expect(controller.apply().state).toBe('idle');
    expect(doc.snapshot.entities[0]?.type === 'line' && doc.snapshot.entities[0].a.x).toBe(10);
    expect(doc.undo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
  });

  it('does not overwrite a newer generation when an older admission callback reenters then throws', async () => {
    const { source, controller, provider: p } = await stagedController();
    let newer: Promise<unknown> | undefined;
    let triggered = false;
    source.interactionBusy = () => {
      if (!triggered) {
        triggered = true;
        newer = controller.generate('newer', provider({ draft: movePlan(20) }), 'fixture');
        throw new Error('older source read failed');
      }
      return false;
    };
    expect((await controller.generate('older', p, 'fixture')).state).toBe('idle');
    await newer;
    const current = controller.status;
    expect(current.state).toBe('staged');
    expect(current.state === 'staged' && current.capture.prompt).toBe('newer');
  });

  it('does not Apply a preview discarded by a reentrant source callback', async () => {
    for (const throws of [false, true]) {
      const { source, controller, doc } = await stagedController();
      const binding = source.binding;
      source.binding = () => {
        controller.discard();
        if (throws) throw new Error('discarded source read');
        return binding();
      };
      expect(controller.apply().state).toBe('idle');
      expect(doc.dirty).toBe(false);
      expect(doc.canUndo()).toBe(false);
      expect(doc.snapshot.entities[0]?.type === 'line' && doc.snapshot.entities[0].a.x).toBe(0);
    }
  });

  it('does not overwrite a newer refinement started by an old abort listener', async () => {
    let newer: Promise<unknown> | undefined;
    let p: AiDraftProvider;
    let controller: AiDraftController;
    const session = await stagedController((_request, call, signal) => {
      if (call > 1) return movePlan(20);
      signal.addEventListener('abort', () => { newer = controller.refine('newer', p, 'fixture'); }, { once: true });
      return new Promise(() => {});
    });
    p = session.provider;
    controller = session.controller;
    const previous = controller.refine('older', p, 'fixture');
    controller.invalidate();
    expect((await previous).state).toBe('idle');
    await newer;
    const current = controller.status;
    expect(current.state === 'staged' && current.version).toBe(2);
    expect(session.provider.refineCalls.map((request) => request.followUp)).toEqual(['older', 'newer']);
  });

  it('refines mixed creations, moves and copies from originals while preserving unrelated state', async () => {
    const original = { ...line('e2'), color: 3, linetype: 'DASHED' };
    const retained = { ...line('retained'), cadIdentity: 'cad-node' };
    const wire = { ...line('wire'), layer: 'WIRES' };
    const layout = { ...defaultLayout('Sheet'), entities: [line('paper-line')] };
    const doc = new Drawing({ entities: [line('e1'), original, retained, wire], layers: [layer0, { ...layer0, name: 'WIRES' }], currentLayer: '0',
      layouts: [layout], blocks: { symbol: { name: 'symbol', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line('block-line')] } },
      meta: { custom: { value: 7 } }, cadGraph: { schema: 1, sourceFormat: 'DXF', nodes: [{ id: 'cad-node', type: 'LINE', section: 'ENTITIES', groups: [], anchor: { kind: 'entity', id: 'retained' } }] } });
    const initial = planOf([{ op: 'move', targetIds: ['e1'], dx: 10, dy: 0 }, { op: 'copy', targetIds: ['e2'], dx: 0, dy: 5 }, { op: 'createCircle', center: { x: 2, y: 3 }, radius: 1, layer: null }]);
    const replacement = planOf([{ op: 'move', targetIds: ['e1'], dx: 15, dy: 0 }, { op: 'copy', targetIds: ['e2'], dx: 0, dy: 8 }, { op: 'createRectangle', origin: { x: 2, y: 3 }, width: 4, height: 5, rotationDeg: null, layer: null }]);
    const p = provider({ draft: initial, refine: async () => replacement });
    const controller = new AiDraftController(harness(doc, ['e1', 'e2']), doc);
    const before = doc.snapshot;
    await controller.generate('Mixed plan', p, 'fixture');
    await controller.refine('Replace it', p, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.capture.state).toBe(before);
    expect(doc.snapshot).toBe(before);
    const copy = staged.proposal.copies[0]?.entity;
    expect(copy?.type === 'line' && copy.a).toEqual({ x: 0, y: 8 });
    expect(copy?.color).toBe(3);
    expect(copy?.linetype).toBe('DASHED');
    controller.apply();
    expect(doc.snapshot.entities[0]?.type === 'line' && doc.snapshot.entities[0].a).toEqual({ x: 15, y: 0 });
    expect(doc.snapshot.entities).toBe(staged.proposal.candidateEntities);
    for (const key of ['cadGraph', 'meta', 'layouts', 'blocks', 'layers', 'header'] as const) expect(doc.snapshot[key]).toBe(before[key]);
    expect(doc.snapshot.entities.slice(1, 4)).toEqual([original, retained, wire]);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot.entities).toBe(staged.proposal.candidateEntities);
  });
});

describe('offline fixture refinement (the brief demonstrations)', () => {
  const fixture = new FixtureDraftProvider();

  async function fixtureSession(prompt: string, selection: string[] = [], entities: Entity[] = []) {
    const doc = new Drawing({ entities, layers: [layer0], currentLayer: '0' });
    const controller = new AiDraftController(harness(doc, selection), doc);
    await controller.generate(prompt, fixture, 'fixture');
    expect(controller.status.state).toBe('staged');
    return { doc, controller };
  }

  it('rectangle width 100 → 120 keeps the four circles 10 units from the corners', async () => {
    const { doc, controller } = await fixtureSession(
      'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.');
    await controller.refine('Change the rectangle width to 120 and keep the circles 10 units from the corners.', fixture, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.version).toBe(2);
    controller.apply();
    const circles = doc.snapshot.entities.filter((e) => e.type === 'circle');
    expect(circles.map((c) => c.type === 'circle' && [c.center.x, c.center.y])).toEqual([[10, 10], [110, 10], [110, 50], [10, 50]]);
    const rect = doc.snapshot.entities.find((e) => e.type === 'polyline');
    expect(rect?.type === 'polyline' && rect.points.map((p) => [p.x, p.y])).toEqual([[0, 0], [120, 0], [120, 60], [0, 60]]);
  });

  it('removing one proposed circle retains the other operations', async () => {
    const { doc, controller } = await fixtureSession(
      'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.');
    await controller.refine('Remove Circle 2', fixture, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.proposal.counts.created).toBe(4); // rectangle + 3 circles
    controller.apply();
    expect(doc.snapshot.entities).toHaveLength(4);
    const centers = doc.snapshot.entities.filter((e) => e.type === 'circle')
      .map((c) => c.type === 'circle' && `${c.center.x},${c.center.y}`);
    expect(centers).toEqual(['10,10', '90,50', '10,50']); // (90,10) is gone
  });

  it('radius refinement and movement-total refinement through the fixture', async () => {
    const { controller } = await fixtureSession(
      'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.');
    await controller.refine('Change the radius to 5', fixture, 'fixture');
    const staged = controller.status;
    expect(staged.state === 'staged' && staged.proposal.created
      .filter((e) => e.type === 'circle').every((e) => e.type === 'circle' && e.radius === 5)).toBe(true);

    const move = await fixtureSession('Move the selected objects 10 units right', ['e1'], [line('e1')]);
    await move.controller.refine('Change that movement to 15 units right in total.', fixture, 'fixture');
    move.controller.apply();
    expect(move.doc.snapshot.entities[0]?.type === 'line'
      && (move.doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 15, y: 0 });
  });

  it('an unrecognized follow-up is a clarification, not an invented edit', async () => {
    const { controller } = await fixtureSession(
      'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.');
    await controller.refine('Make it look nicer', fixture, 'fixture');
    const staged = controller.status;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') return;
    expect(staged.followUp?.phase).toBe('clarification');
    expect(staged.version).toBe(1);
  });
});

describe('proposal diff', () => {
  it('reports updated, added and removed operations between preview versions', () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const source = harness(doc, []);
    const capture = captureDraftContext(source, 'shapes', 'fixture');
    let n = 0;
    const mint = (): string => `id-${++n}`;
    const bounds = (e: Entity) => entityBounds(e, undefined as never);
    const v1 = compileAiPlan({ message: null, operations: [
      { op: 'createRectangle', origin: { x: 0, y: 0 }, width: 100, height: 60, rotationDeg: null, layer: null },
      { op: 'createCircle', center: { x: 10, y: 10 }, radius: 3, layer: null },
      { op: 'createCircle', center: { x: 90, y: 10 }, radius: 3, layer: null },
    ] }, capture, mint, bounds);
    const v2 = compileAiPlan({ message: null, operations: [
      { op: 'createRectangle', origin: { x: 0, y: 0 }, width: 120, height: 60, rotationDeg: null, layer: null },
      { op: 'createCircle', center: { x: 10, y: 10 }, radius: 3, layer: null },
    ] }, capture, mint, bounds);
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    const diff = diffProposalChanges(v1.proposal, v2.proposal);
    expect(diff.updated.map((u) => u.label)).toEqual(['Rectangle 1']);
    expect(diff.updated[0]?.before).toContain('100 × 60');
    expect(diff.updated[0]?.after).toContain('120 × 60');
    expect(diff.added).toEqual([]);
    expect(diff.removed.map((r) => r.label)).toEqual(['Circle 2']);
  });

  it('reports exact operations whose order changes, including the prior and current reference positions', () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const capture = captureDraftContext(harness(doc, []), 'shapes', 'fixture');
    const a: AiPlan['operations'][number] = { op: 'createLine', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, layer: null };
    const b: AiPlan['operations'][number] = { op: 'createCircle', center: { x: 2, y: 0 }, radius: 1, layer: null };
    let n = 0;
    const compile = (operations: AiPlan['operations']) => compileAiPlan({ message: null, operations }, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    const before = compile([a, b]);
    const after = compile([b, a]);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    const diff = diffProposalChanges(before.proposal, after.proposal);
    expect(diff.updated).toHaveLength(2);
    expect(diff.updated[0]).toMatchObject({ label: 'Circle 1', before: expect.stringContaining('operation 2'), after: expect.stringContaining('operation 1') });
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.updated[0])).toBe(true);
  });

  it('makes reference renumbering explicit when the first of two creations is removed', () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const capture = captureDraftContext(harness(doc, []), 'circles', 'fixture');
    const a: AiPlan['operations'][number] = { op: 'createCircle', center: { x: 0, y: 0 }, radius: 1, layer: null };
    const b: AiPlan['operations'][number] = { op: 'createCircle', center: { x: 10, y: 0 }, radius: 1, layer: null };
    let n = 0;
    const compile = (operations: AiPlan['operations']) => compileAiPlan({ message: null, operations }, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    const before = compile([a, b]);
    const after = compile([b]);
    if (!before.ok || !after.ok) throw new Error('expected compiled');
    const diff = diffProposalChanges(before.proposal, after.proposal);
    expect(diff.removed.map((entry) => entry.label)).toEqual(['Circle 1']);
    expect(diff.updated[0]).toMatchObject({ label: 'Circle 1', before: expect.stringContaining('[Circle 2]'), after: expect.stringContaining('[Circle 1]') });
  });
});
