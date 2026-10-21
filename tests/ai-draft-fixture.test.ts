import { describe, expect, it } from 'vitest';
import { FixtureDraftProvider } from '../src/ai/fixture-draft';
import type { AiDraftRequest } from '../src/ai/types';

function request(prompt: string, eligible: string[] = []): AiDraftRequest {
  const contextJson = JSON.stringify({
    targets: eligible.map((id) => ({ id, eligible: true })),
  });
  return {
    requestId: 'ai-test-1',
    prompt,
    contextJson,
    binding: {
      ask: {
        sessionId: 1, docId: 'd', contentGeneration: 0, docRevision: 0, docLoadCount: 0,
        space: { layout: null, viewport: null }, selectionIds: eligible,
      },
      unitsKey: 'u', defaultsKey: 'd', eligibilityKey: 'e', configKey: 'fixture',
    },
  };
}

const provider = new FixtureDraftProvider();
const signal = new AbortController().signal;

describe('FixtureDraftProvider', () => {
  it('builds the documented rectangle-with-circles demonstration', async () => {
    const out = await provider.draft(
      request('Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.'),
      signal,
    );
    expect(out.kind).toBe('plan');
    if (out.kind !== 'plan') return;
    expect(out.plan.operations).toHaveLength(5);
    const [rect, ...circles] = out.plan.operations;
    expect(rect?.op).toBe('createRectangle');
    if (rect?.op === 'createRectangle') {
      expect([rect.width, rect.height]).toEqual([100, 60]);
    }
    const centers = circles.map((c) => (c.op === 'createCircle' ? [c.center.x, c.center.y, c.radius] : null));
    expect(centers).toEqual([[10, 10, 3], [90, 10, 3], [90, 50, 3], [10, 50, 3]]);
  });

  it('moves, copies, rotates and deletes the eligible selection', async () => {
    const move = await provider.draft(request('Move the selected objects 10 units right', ['e1', 'e2']), signal);
    expect(move.kind === 'plan' && move.plan.operations[0]).toEqual(
      expect.objectContaining({ op: 'move', targetIds: ['e1', 'e2'], dx: 10, dy: 0 }),
    );
    const copy = await provider.draft(request('Copy by (5, -2)', ['e1']), signal);
    expect(copy.kind === 'plan' && copy.plan.operations[0]).toEqual(
      expect.objectContaining({ op: 'copy', dx: 5, dy: -2 }),
    );
    const rotate = await provider.draft(request('Rotate 90 degrees about (0, 0)', ['e1']), signal);
    expect(rotate.kind === 'plan' && rotate.plan.operations[0]).toEqual(
      expect.objectContaining({ op: 'rotate', angleDeg: 90, pivot: { x: 0, y: 0 } }),
    );
    const del = await provider.draft(request('Delete the selected objects', ['e1']), signal);
    expect(del.kind === 'plan' && del.plan.operations[0]).toEqual(
      expect.objectContaining({ op: 'delete', targetIds: ['e1'] }),
    );
  });

  it('asks for clarification instead of inventing missing parameters', async () => {
    const rotate = await provider.draft(request('Rotate the selected objects', ['e1']), signal);
    expect(rotate.kind).toBe('clarification');
    const edit = await provider.draft(request('Move the selected objects right', []), signal);
    expect(edit.kind).toBe('clarification');
    const other = await provider.draft(request('Make it look nicer', ['e1']), signal);
    expect(other.kind).toBe('clarification');
  });

  it.each([
    'Do not delete the selected objects',
    'Move 10 units right and 20 units up',
    'Move 10 millimeters right',
    'Create a -100 x 60 rectangle',
    'Create a 100 x 60 rectangle with three circles of radius 3',
    'Create a 100 x 60 rectangle with four circles of radius 3',
    'Circle of radius 3 at the top corner',
    'Move .5 right',
    'Move 1e3 right',
    'Delete the selection create a rectangle',
  ])('clarifies unsupported or incomplete demo wording: %s', async (prompt) => {
    expect((await provider.draft(request(prompt, ['e1']), signal)).kind).toBe('clarification');
  });

  it('honors signed movements and explicit rectangle origins', async () => {
    const move = await provider.draft(request('Move -5 units right', ['e1']), signal);
    expect(move.kind === 'plan' && move.plan.operations[0]).toMatchObject({ op: 'move', dx: -5, dy: 0 });
    const rectangle = await provider.draft(request('Create a 100 x 60 rectangle at (20, 30)'), signal);
    expect(rectangle.kind === 'plan' && rectangle.plan.operations[0]).toMatchObject({ op: 'createRectangle', origin: { x: 20, y: 30 } });
  });
});
