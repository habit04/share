import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type Entity, type Layer } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { AiDraftController } from '../src/ai/draft-controller';
import type { AiDraftSource } from '../src/ai/draft-context';
import { buildRefineEnvelope, diffProposalChanges, proposalLabels } from '../src/ai/draft-refine';
import { compileAiPlan } from '../src/ai/draft-compiler';
import { captureDraftContext } from '../src/ai/draft-context';
import { AiError, type AiDraftProvider, type AiDraftRefineRequest } from '../src/ai/types';
import type { AiDraftResponse, AiPlan } from '../src/ai/draft-plan';
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
  refine?: (request: AiDraftRefineRequest, call: number) => Promise<AiDraftResponse> | AiDraftResponse;
}): AiDraftProvider & { refineCalls: AiDraftRefineRequest[] } {
  const refineCalls: AiDraftRefineRequest[] = [];
  return {
    id: 'fake',
    refineCalls,
    draft: async () => script.draft,
    refine: async (request) => {
      refineCalls.push(request);
      if (!script.refine) throw new AiError('host-unavailable', 'no refine scripted');
      return script.refine(request, refineCalls.length);
    },
  };
}

async function stagedController(refineScript?: (r: AiDraftRefineRequest, n: number) => Promise<AiDraftResponse> | AiDraftResponse) {
  const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
  const controller = new AiDraftController(harness(doc, ['e1']), doc);
  const p = provider({ draft: movePlan(10), refine: refineScript });
  await controller.generate('Move the line 10 right', p, 'fixture');
  expect(controller.status.state).toBe('staged');
  return { doc, controller, provider: p };
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
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const source = harness(doc, []);
    const capture = captureDraftContext(source, 'a line', 'fixture');
    let n = 0;
    const huge: AiPlan = {
      message: null,
      operations: Array.from({ length: 64 }, (_, i) => ({
        op: 'createLine' as const, a: { x: i, y: 0 }, b: { x: i + 1, y: 1 }, layer: 'x'.repeat(500),
      })),
    };
    const compiled = compileAiPlan(huge, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    // Layers of 500 chars are not permitted layers, so compile fails; build a
    // proposal-shaped object directly to exercise the envelope cap instead.
    expect(compiled.ok).toBe(false);
    const proposal = {
      plan: huge, created: [], copies: [], modified: [], deleted: [],
      candidateEntities: [], changes: huge.operations.map((_, i) => ({ kind: 'create' as const, op: 'createLine' as const, label: `Line ${i + 1}`, summary: 'x'.repeat(2000), targetIds: [], createdIds: [], layer: '0' })),
      bounds: null, counts: { created: 64, copied: 0, modified: 0, deleted: 0 },
    };
    expect(() => buildRefineEnvelope(capture, proposal as never, 'make it bigger')).toThrowError(/context limit/);
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
});
