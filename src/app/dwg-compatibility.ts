/** Renderer-side preservation limits shared by working DWG saves and DWG export copies. */
import type { DrawingState } from '../core/document';

/**
 * Native DWG clip-object/reference preservation is not verified. Disabled boundaries still
 * carry editable data, so they require the same protection as boundaries used for display.
 */
export function dwgCompatibilityProblem(state: Partial<Pick<DrawingState, 'layouts' | 'entities' | 'blocks'>>): string | null {
  if (state.layouts?.some((layout) => layout.viewports.some((viewport) => viewport.clipBoundary !== undefined))) {
    return 'DWG saving and export are unavailable for drawings with retained viewport clipping boundaries, including disabled boundaries. Use Save As and choose DXF to keep them.';
  }
  // Native gradient fields have not been verified through the portable writer/reader.
  // Inactive descriptors still carry imported data, including inside unused blocks/layouts.
  const lists = [state.entities ?? [], ...Object.values(state.blocks ?? {}).map((b) => b.entities),
    ...(state.layouts ?? []).map((l) => l.entities)];
  if (lists.some((entities) => entities.some((e) => e.type === 'hatch' && e.gradient !== undefined))) {
    return 'DWG saving and export are unavailable for drawings with retained hatch gradient settings, including inactive gradients. Use Save As and choose DXF to keep them.';
  }
  return null;
}
