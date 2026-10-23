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
 */
import type { UnderlayDefinition } from '../core/underlay';
import type { UnderlayEntity } from '../core/entities';

export interface UnderlayDisplayContent {
  readonly definition: UnderlayDefinition;
  /** Page size in the referenced file's own units (PDF points). */
  readonly page?: { readonly width: number; readonly height: number };
  /** Rasterized page bitmap, drawn into the placement's frame. */
  readonly image?: { readonly bitmap: CanvasImageSource; readonly width: number; readonly height: number };
}

export type UnderlayContentSource = (e: UnderlayEntity) => UnderlayDisplayContent | undefined;
