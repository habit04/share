import type { DrawingState } from '../core/document';
import type { Entity } from '../core/entities';
import type { UnitSettings } from '../core/units';
import type { Editor } from '../app/editor/editor';
import { createEditorAiSource } from './editor-source';
import type { AiDraftSource, FrozenCreationDefaults } from './draft-context';
import { AiError } from './types';

/**
 * Adapts the real Editor to the Draft source surface. All reads, like the
 * Ask source: binding/units come from the reviewed editor source, model
 * state is the drawing's immutable snapshot, creation defaults are resolved
 * through `Drawing.withEntityDefaults()` on a probe entity (so the frozen
 * values are exactly what a creation command would produce right now), and
 * the busy query is the editor's own interaction state.
 */
export function createEditorAiDraftSource(editor: Editor): AiDraftSource {
  const ask = createEditorAiSource(editor);
  return {
    ...ask,
    units: (): UnitSettings => editor.doc.header.units,
    modelState: (): DrawingState => {
      if (editor.hooks?.aiDraftingAvailable?.() === false) {
        throw new AiError('invalid-context', 'Draft / Edit requires the 2D Model view. Leave 3D mode and generate again.');
      }
      return editor.doc.snapshot;
    },
    frozenDefaults: (): FrozenCreationDefaults => {
      const doc = editor.doc;
      const probe: Entity = {
        id: '__ai_draft_probe__',
        type: 'line',
        layer: doc.currentLayer,
        color: 'ByLayer',
        a: { x: 0, y: 0 },
        b: { x: 0, y: 0 },
      };
      const resolved = doc.withEntityDefaults([probe])[0] ?? probe;
      return {
        layer: doc.currentLayer,
        color: resolved.color,
        ...(resolved.linetype !== undefined ? { linetype: resolved.linetype } : {}),
        ...(resolved.lineWeight !== undefined ? { lineWeight: resolved.lineWeight } : {}),
      };
    },
    interactionBusy: (): boolean => editor.interactionBusy,
    editingInteractionBusy: (): boolean => editor.editingInteractionBusy,
    interactionGeneration: (): number => editor.interactionGeneration,
  };
}
