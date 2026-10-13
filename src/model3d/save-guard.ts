/**
 * Saving a drawing with experimental 3D content: DXF / DWG output does not carry solids yet
 * (milestone 5 adds a 3D-aware format), so an explicit save asks first instead of dropping them
 * silently. Autosave / recovery copies are written without asking and also omit the solids.
 */
import type { DrawingState } from '../core/document';

/**
 * The confirmation message for a save that would lose 3D solids, or null when the drawing has
 * none. The question is phrased so that Yes saves (without the solids) and No cancels the save.
 */
export function model3dSaveWarning(state: DrawingState): string | null {
  const n = state.model3d?.solids.length ?? 0;
  if (n === 0) return null;
  const objects = n === 1 ? '1 experimental 3D object' : `${n} experimental 3D objects`;
  return `This drawing contains ${objects}. 3D objects are not written to DXF or DWG files in this version and will be lost in the saved file. Save without them?`;
}

/** Dialog title used with `model3dSaveWarning`. */
export const MODEL3D_SAVE_TITLE = 'Save without 3D objects?';
