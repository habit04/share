/** Renderer-side preservation limits shared by working DWG saves and DWG export copies. */
import type { DrawingState } from '../core/document';

/**
 * Native DWG clip-object/reference preservation is not verified. Disabled boundaries still
 * carry editable data, so they require the same protection as boundaries used for display.
 */
export function dwgCompatibilityProblem(state: Pick<DrawingState, 'layouts'>): string | null {
  if (!state.layouts?.some((layout) => layout.viewports.some((viewport) => viewport.clipBoundary !== undefined))) return null;
  return 'DWG saving and export are unavailable for drawings with retained viewport clipping boundaries, including disabled boundaries. Use Save As and choose DXF to keep them.';
}
