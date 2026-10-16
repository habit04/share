import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { entityBounds, type Entity, type Layer } from '../src/core/entities';
import { DEFAULT_UNITS, type UnitSettings } from '../src/core/units';
import { captureDraftContext, type AiDraftSource } from '../src/ai/draft-context';
import { compileAiPlan } from '../src/ai/draft-compiler';
import type { AiPlan } from '../src/ai/draft-plan';
import type { AiBinding } from '../src/ai/types';

const layer = (name: string, over: Partial<Layer> = {}): Layer => ({
  name, color: 7, visible: true, locked: false, lineWeight: -3, ...over,
});
const line = (id: string, over: Partial<Extract<Entity, { type: 'line' }>> = {}): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, ...over,
});

function fakeSource(state: DrawingState, selection: string[], units: UnitSettings = DEFAULT_UNITS): AiDraftSource {
  const binding: AiBinding = {
    sessionId: 1, docId: 'doc', contentGeneration: 0, docRevision: 0, docLoadCount: 0,
    space: { layout: null, viewport: null }, selectionIds: selection,
  };
  return {
    binding: () => binding,
    units: () => units,
    selectedEntities: () => state.entities.filter((e) => selection.includes(e.id)),
    entityById: (id) => state.entities.find((e) => e.id === id),
    boundsFor: (e) => entityBounds(e, undefined as never),
    missingIdKind: () => 'missing-object',
    modelState: () => state,
    frozenDefaults: () => ({ layer: state.currentLayer, color: 'ByLayer' }),
    interactionBusy: () => false,
  };
}

function captureWith(entities: Entity[], selection: string[], layers: Layer[] = [layer('0')]): ReturnType<typeof captureDraftContext> {
  const doc = new Drawing({ entities, layers, currentLayer: '0' });
  return captureDraftContext(fakeSource(doc.snapshot, selection), 'do it', 'openai|gpt-5|1');
}

let mintCounter = 0;
const mint = (): string => `new-${++mintCounter}`;
const boundsFor = (e: Entity) => entityBounds(e, undefined as never);

describe('compileAiPlan', () => {
  it('builds exact line, circle and rectangle geometry', () => {
    const capture = captureWith([], []);
    const plan: AiPlan = {
      message: null,
      operations: [
        { op: 'createLine', a: { x: 0, y: 0 }, b: { x: 3, y: 4 }, layer: null },
        { op: 'createCircle', center: { x: 10, y: 10 }, radius: 3, layer: null },
        { op: 'createRectangle', origin: { x: 0, y: 0 }, width: 100, height: 60, rotationDeg: null, layer: null },
      ],
    };
    const out = compileAiPlan(plan, capture, mint, boundsFor);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [l, c, r] = out.proposal.created;
    expect(l?.type === 'line' && [l.a, l.b]).toEqual([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(c?.type === 'circle' && c.radius).toBe(3);
    expect(r?.type).toBe('polyline');
    if (r?.type === 'polyline') {
      expect(r.closed).toBe(true);
      expect(r.points).toEqual([
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 },
      ]);
    }
    expect(out.proposal.counts).toEqual({ created: 3, copied: 0, modified: 0, deleted: 0 });
    expect(out.proposal.candidateEntities).toHaveLength(3);
  });

  it('rotates rectangle vertices locally', () => {
    const capture = captureWith([], []);
    const plan: AiPlan = { message: null, operations: [{ op: 'createRectangle', origin: { x: 0, y: 0 }, width: 10, height: 0 + 5, rotationDeg: 90, layer: null }] };
    const out = compileAiPlan(plan, capture, mint, boundsFor);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.proposal.created[0];
    if (r?.type !== 'polyline') throw new Error('expected polyline');
    const pts = r.points.map((p) => ({ x: Math.round(p.x * 1e9) / 1e9, y: Math.round(p.y * 1e9) / 1e9 }));
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: -5, y: 10 }, { x: -5, y: 0 }]);
  });

  it('moves, copies, rotates and deletes eligible selected originals, preserving properties', () => {
    const original = line('e1', { color: 3, linetype: 'DASHED' });
    const capture = captureWith([original], ['e1']);
    const move: AiPlan = { message: null, operations: [{ op: 'move', targetIds: ['e1'], dx: 10, dy: 0 }] };
    const moved = compileAiPlan(move, capture, mint, boundsFor);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const after = moved.proposal.modified[0]?.after;
    expect(after?.type === 'line' && [after.a, after.b]).toEqual([{ x: 10, y: 0 }, { x: 20, y: 0 }]);
    expect(after?.color).toBe(3);
    expect(after?.linetype).toBe('DASHED');
    expect(after?.id).toBe('e1');

    const copy: AiPlan = { message: null, operations: [{ op: 'copy', targetIds: ['e1'], dx: 0, dy: 5 }] };
    const copied = compileAiPlan(copy, capture, mint, boundsFor);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.proposal.candidateEntities).toHaveLength(2);
    expect(copied.proposal.copies[0]?.entity.id).not.toBe('e1');
    expect(copied.proposal.candidateEntities[0]).toBe(original); // original untouched, same reference

    const rotate: AiPlan = { message: null, operations: [{ op: 'rotate', targetIds: ['e1'], pivot: { x: 0, y: 0 }, angleDeg: 90 }] };
    const rotated = compileAiPlan(rotate, capture, mint, boundsFor);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const rafter = rotated.proposal.modified[0]?.after;
    expect(rafter?.type === 'line' && [Math.round(rafter.a.x), Math.round(rafter.a.y), Math.round(rafter.b.x), Math.round(rafter.b.y)]).toEqual([0, 0, 0, 10]);

    const del: AiPlan = { message: null, operations: [{ op: 'delete', targetIds: ['e1'] }] };
    const deleted = compileAiPlan(del, capture, mint, boundsFor);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.proposal.candidateEntities).toHaveLength(0);
  });

  it('rejects targets outside the eligible selection, electrical and CAD-backed objects', () => {
    const wire = line('w1', { layer: 'WIRES' });
    const cad = line('c1', { cadIdentity: 'imp-1' });
    const plain = line('p1');
    // A bare Drawing refuses cadIdentity entities without their graph, so the
    // state is assembled literally with a minimal retained graph.
    const state: DrawingState = {
      entities: [wire, cad, plain],
      layers: [layer('0'), layer('WIRES')],
      blocks: {},
      currentLayer: '0',
      cadGraph: {
        schema: 1,
        sourceFormat: 'DXF',
        nodes: [{ id: 'n1', type: 'LINE', section: 'ENTITIES', groups: [], anchor: { kind: 'entity', id: 'c1' } }],
      },
    };
    const capture = captureDraftContext(fakeSource(state, ['w1', 'c1', 'p1']), 'do it', 'openai|gpt-5|1');
    expect(capture.eligibleIds).toEqual(['p1']);
    for (const id of ['w1', 'c1', 'ghost']) {
      const plan: AiPlan = { message: null, operations: [{ op: 'delete', targetIds: [id] }] };
      expect(compileAiPlan(plan, capture, mint, boundsFor).ok).toBe(false);
    }
  });

  it('rejects creations on missing, locked or hidden layers and never substitutes', () => {
    const capture = captureWith([], [], [layer('0'), layer('LOCKED', { locked: true }), layer('OFF', { visible: false })]);
    for (const bad of ['NOPE', 'LOCKED', 'OFF']) {
      const plan: AiPlan = { message: null, operations: [{ op: 'createCircle', center: { x: 0, y: 0 }, radius: 1, layer: bad }] };
      expect(compileAiPlan(plan, capture, mint, boundsFor).ok).toBe(false);
    }
  });

  it('rejects curved and wide polylines and filled circles at capture', () => {
    const curved: Entity = { id: 'cv', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false, bulges: [0.5, 0] };
    const wide: Entity = { id: 'wd', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false, width: 2 };
    const dot: Entity = { id: 'dt', type: 'circle', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 1, filled: true };
    const capture = captureWith([curved, wide, dot], ['cv', 'wd', 'dt']);
    expect(capture.eligibleIds).toEqual([]);
    expect(capture.targets.map((t) => t.eligible)).toEqual([false, false, false]);
  });
});
