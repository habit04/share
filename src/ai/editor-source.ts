import { entityBounds, type Entity } from '../core/entities';
import type { Bounds } from '../core/geometry';
import type { UnitSettings } from '../core/units';
import type { Editor } from '../app/editor/editor';
import type { AiBinding, AiOmitReason, AiSnapshotSource } from './types';

/**
 * Adapts the real Editor to the read-only snapshot source interface.
 * Every call below is a safe read (see docs/AI-ASSISTANT.md): no command
 * dispatch, no tool/selection/document mutation, no dirty/filePath writes.
 * Reading `sessions.current` syncs the parked session record only — the same
 * bookkeeping the save flow relies on; it never touches the drawing itself.
 */
export function createEditorAiSource(editor: Editor): AiSnapshotSource {
  const binding = (): AiBinding => {
    const session = editor.sessions.current;
    const space = editor.doc.space;
    return {
      sessionId: editor.sessions.activeId,
      docId: session.docId,
      contentGeneration: session.contentGeneration,
      docRevision: editor.doc.revision,
      docLoadCount: editor.doc.loadCount,
      space: {
        layout: space?.layout ?? null,
        viewport: space?.viewport ?? null,
      },
      selectionIds: [...editor.selection],
    };
  };

  return {
    binding,
    units: (): UnitSettings => editor.doc.header.units,
    selectedEntities: (): readonly Entity[] => editor.entitiesSelected(),
    entityById: (id: string): Entity | undefined => editor.doc.entity(id),
    boundsFor: (entity: Entity): Bounds | null => {
      try {
        return entityBounds(entity, editor.doc.lookupBlock);
      } catch {
        // Bounds are an enrichment; a failure must never break a read-only ask.
        return null;
      }
    },
    missingIdKind: (id: string): AiOmitReason => {
      const model3d = editor.doc.snapshot.model3d;
      if (model3d) {
        for (const solid of model3d.solids) if (solid.id === id) return 'unsupported-object';
        for (const dim of model3d.dimensions ?? []) if (dim.id === id) return 'unsupported-object';
      }
      return 'missing-object';
    },
  };
}
