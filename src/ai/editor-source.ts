import { entityBounds, type Entity } from '../core/entities';
import type { Bounds } from '../core/geometry';
import type { UnitSettings } from '../core/units';
import { paperSpaceLayout } from '../core/layouts';
import type { Model3D } from '../model3d/types';
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
  // Accepted model objects are immutable and shared across snapshots/history.
  // Build the unsupported-id index once per model, without retaining closed drawings.
  const unsupportedIdsByModel = new WeakMap<Model3D, ReadonlySet<string>>();
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
    units: (): UnitSettings => {
      const model = editor.doc.header.units;
      const paper = paperSpaceLayout(editor.doc.snapshot);
      // Paper coordinates use the sheet's units. MSPACE edits model geometry,
      // and paperSpaceLayout deliberately returns undefined inside a viewport.
      return paper ? { ...model, insunits: paper.paper.units === 'mm' ? 4 : 1 } : model;
    },
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
        let ids = unsupportedIdsByModel.get(model3d);
        if (!ids) {
          const index = new Set<string>();
          for (const solid of model3d.solids) index.add(solid.id);
          for (const dim of model3d.dimensions ?? []) index.add(dim.id);
          ids = index;
          unsupportedIdsByModel.set(model3d, ids);
        }
        if (ids.has(id)) return 'unsupported-object';
      }
      return 'missing-object';
    },
  };
}
