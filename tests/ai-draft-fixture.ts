import { Drawing } from '../src/core/document';
import { DEFAULT_UNITS } from '../src/core/units';
import type { Entity } from '../src/core/entities';
import { captureDraftContext, type AiDraftSource, type FrozenCreationDefaults } from '../src/ai/draft-context';

/** Real renderer capture, with synthetic in-memory geometry only. */
export function draftTestContextJson(
  ids: readonly string[], prompt = 'draw a line',
  defaults: FrozenCreationDefaults = { layer: '0', color: 'ByLayer' },
): string {
  const drawing = new Drawing();
  const entities: Entity[] = ids.map((id) => ({
    id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
  }));
  const source: AiDraftSource = {
    binding: () => ({ sessionId: 1, docId: 'doc-1', contentGeneration: 1, docRevision: 7, docLoadCount: 1,
      space: { layout: null, viewport: null }, selectionIds: [...ids] }),
    units: () => DEFAULT_UNITS,
    selectedEntities: () => entities,
    entityById: (id) => entities.find((entity) => entity.id === id),
    boundsFor: () => null,
    missingIdKind: () => 'missing-object',
    modelState: () => drawing.snapshot,
    frozenDefaults: () => defaults,
    interactionBusy: () => false,
  };
  return captureDraftContext(source, prompt, 'synthetic-config').contextJson;
}
