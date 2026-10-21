import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type Entity } from '../src/core/entities';
import { captureDraftContext, type AiDraftSource } from '../src/ai/draft-context';
import { compileAiPlan } from '../src/ai/draft-compiler';
import { buildRefineEnvelope } from '../src/ai/draft-refine';
import { FixtureDraftProvider } from '../src/ai/fixture-draft';
import type { AiPlan, AiDraftResponse } from '../src/ai/draft-plan';

const rectangle: AiPlan['operations'][number] = {
  op: 'createRectangle', origin: { x: 0, y: 0 }, width: 100, height: 60, rotationDeg: null, layer: null,
};
function shapes(): AiPlan['operations'] {
  return [rectangle, ...[[10, 10], [90, 10], [90, 50], [10, 50]].map(([x, y]) => ({
    op: 'createCircle' as const, center: { x: x!, y: y! }, radius: 3, layer: null,
  }))];
}
function session(operations = shapes()) {
  const line: Entity = { id: 'real-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  const doc = new Drawing({ entities: [line] });
  const source: AiDraftSource = {
    binding: () => ({ sessionId: 1, docId: 'synthetic', contentGeneration: 0, docRevision: doc.revision,
      docLoadCount: doc.loadCount, space: { layout: null, viewport: null }, selectionIds: [line.id] }),
    units: () => doc.header.units,
    selectedEntities: () => [line], entityById: id => doc.entity(id),
    boundsFor: e => entityBounds(e, undefined as never), missingIdKind: () => 'missing-object',
    modelState: () => doc.snapshot, frozenDefaults: () => ({ layer: '0', color: 'ByLayer' }), interactionBusy: () => false,
  };
  const capture = captureDraftContext(source, 'Synthetic preview', 'fixture');
  let id = 0;
  const compiled = compileAiPlan({ message: null, operations }, capture, () => `preview-${++id}`, source.boundsFor);
  if (!compiled.ok) throw new Error(compiled.error);
  return { doc, async refine(followUp: string): Promise<AiDraftResponse> {
    const envelope = buildRefineEnvelope(capture, compiled.proposal, followUp);
    const before = doc.snapshot, revision = doc.revision;
    const response = await new FixtureDraftProvider().refine({ requestId: 'synthetic-refine',
      followUp: envelope.followUp, envelopeJson: envelope.envelopeJson, binding: capture.binding }, new AbortController().signal);
    expect(doc.snapshot).toBe(before); expect(doc.revision).toBe(revision);
    return response;
  } };
}

describe('offline refinements interpret the complete instruction', () => {
  it.each([
    'Change the rectangle width to 120 and delete the selected line',
    'Change the radius to 5 and move the circles 10 right',
    'Remove Circle 2 and create a new line',
    'Change the rectangle width to 120 and keep the circles 5 units from the corners',
    'Change the rectangle width to -120',
    'Change the radius to -5',
    'Change the radius to .5',
    'Change the radius to 1e3',
    'Change the radius to 5 inches',
    'Change Circle 99 radius to 5',
  ])('clarifies rather than accepting part of %s', async instruction => {
    expect((await session().refine(instruction)).kind).toBe('clarification');
  });

  it('respects a named circle instead of silently changing all circles', async () => {
    const result = await session().refine('Change Circle 2 radius to 5');
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    expect(result.plan.operations.filter(op => op.op === 'createCircle').map(op => op.radius)).toEqual([3, 5, 3, 3]);
    expect(result.plan.operations[0]).toEqual(rectangle);
  });

  it('keeps explicit corner inset and other operations during a recognized resize', async () => {
    const result = await session().refine('Change the rectangle width to 120 and keep the circles 10 units from the corners.');
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    expect(result.plan.operations.filter(op => op.op === 'createCircle').map(op => op.center)).toEqual([
      { x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 50 }, { x: 10, y: 50 },
    ]);
  });

  it('clarifies an explicit corner relationship it cannot prove for a rotated rectangle', async () => {
    const result = await session(shapes().map(op => op.op === 'createRectangle' ? { ...op, rotationDeg: 45 } : op))
      .refine('Change the rectangle width to 120 and keep the circles 10 units from the corners');
    expect(result.kind).toBe('clarification');
  });

  it('refuses multiple movement directions instead of swallowing the second one', async () => {
    const move = session([{ op: 'move', targetIds: ['real-line'], dx: 10, dy: 0 }]);
    expect((await move.refine('Change that movement to 15 units right and 20 up')).kind).toBe('clarification');
    const valid = await move.refine('Change that movement to 15 units right in total.');
    expect(valid.kind === 'plan' && valid.plan.operations).toEqual([{ op: 'move', targetIds: ['real-line'], dx: 15, dy: 0 }]);
  });
});
