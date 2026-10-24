/**
 * What the draw path needs to render one underlay placement (P28): the
 * resolved definition (possibly an extent-filled view of the sibling
 * record), the page size in file units, and — when a raster engine has
 * produced one — the page bitmap. A source returns undefined when the
 * placement has no definition in the drawing: the draw path then renders
 * the bare frame+cross with NO path-derived label (RULING-P28 C2).
 *
 * The source is supplied by the app layer (src/app/underlay-render.ts)
 * over the engine interface (src/io/underlay-engine.ts); the render layer
 * never imports an engine itself.
 *
 * v0.6.4 (review F-E): no composition root installs that service yet — the
 * desktop bridge has no byte channel for it — so the draw path falls back
 * to underlayDefinitionContent below: the definition the drawing itself
 * holds (DrawingState.underlays), joined by handle, with no page bitmap.
 * That renders the frame, the cross and the definition's file-name label,
 * so a placed PDF is at least identified on screen and on paper.
 */
import { validateUnderlayPair, type UnderlayDefinition } from '../core/underlay';
import { underlayPlacementOf, type UnderlayEntity } from '../core/entities';

export interface UnderlayDisplayContent {
  readonly definition: UnderlayDefinition;
  /** Page size in the referenced file's own units (PDF points). */
  readonly page?: { readonly width: number; readonly height: number };
  /** Rasterized page bitmap, drawn into the placement's frame. */
  readonly image?: { readonly bitmap: CanvasImageSource; readonly width: number; readonly height: number };
}

export type UnderlayContentSource = (e: UnderlayEntity) => UnderlayDisplayContent | undefined;

/**
 * Definition-only content for a placement, from the drawing's own
 * definitions sibling: the definition whose handle the placement names,
 * and nothing else — no page size, no bitmap. Undefined when the drawing
 * holds no definition for it (dangling: frame + cross, no label, RULING-P28
 * C2) or when the pair fails validateUnderlayPair (never the wrong file's
 * label, F-B of the P28 model).
 */
export function underlayDefinitionContent(e: UnderlayEntity, definitions: Readonly<Record<string, UnderlayDefinition>> | undefined): UnderlayDisplayContent | undefined {
  if (!definitions) return undefined;
  const wanted = e.definitionHandle.trim().toUpperCase();
  if (!wanted) return undefined;
  for (const def of Object.values(definitions)) {
    if ((def.handle ?? '').trim().toUpperCase() !== wanted) continue;
    return validateUnderlayPair(underlayPlacementOf(e), def).length === 0 ? { definition: def } : undefined;
  }
  return undefined;
}
