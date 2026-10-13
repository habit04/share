/**
 * Saving a drawing with experimental 3D content: DXF / DWG output does not carry solids yet
 * (milestone 5 adds a 3D-aware format). Unsupported geometry is never discarded silently, so every
 * explicit save or export asks first, and refuses when no interface can ask. A save the user
 * accepted leaves the drawing marked modified (the file does not hold everything). Autosave /
 * recovery copies are written without asking, omit the solids and record how many they omitted.
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

/** Why a save without the UI is refused (used as `Editor.lastFileError` and in the log). */
export const MODEL3D_NO_UI_REASON = 'the drawing contains 3D objects; dropping them requires confirmation in the desktop interface';

/** Log line after a save the user accepted without its 3D objects. */
export const MODEL3D_SAVED_WITHOUT = 'Saved without 3D objects; the drawing remains marked modified because the file does not hold them.';

/**
 * Snapshots whose 3D loss the user accepted. States are immutable, so one answer covers every
 * write of that exact state (Save As / Retry re-entries, a DWG export of the same revision); any
 * edit produces a new state and asks again.
 */
const accepted = new WeakSet<DrawingState>();

/**
 * Outcome of `confirmModel3DLoss`: 'none' (no solids, nothing to ask), 'accepted' (Yes now or
 * earlier for this state), 'declined' (No), 'no-ui' (nobody to ask: refuse), 'changed' (the
 * drawing changed or closed while the question was open: the caller abandons the stale save).
 */
export type Model3DLossDecision = 'none' | 'accepted' | 'declined' | 'no-ui' | 'changed';

/**
 * Ask once per state whether writing `state` without its 3D solids is acceptable. `confirm` is the
 * interface's Yes / No dialog, or null when there is no interface (headless saves are refused,
 * never silently lossy). `current` reports whether the save still refers to the open drawing after
 * the dialog; a stale answer is not recorded.
 */
export async function confirmModel3DLoss(
  state: DrawingState,
  confirm: ((title: string, message: string) => Promise<boolean>) | null,
  current: () => boolean,
): Promise<Model3DLossDecision> {
  const warning = model3dSaveWarning(state);
  if (!warning) return 'none';
  if (accepted.has(state)) return 'accepted';
  if (!confirm) return 'no-ui';
  const ok = await confirm(MODEL3D_SAVE_TITLE, warning);
  if (!current()) return 'changed';
  if (!ok) return 'declined';
  accepted.add(state);
  return 'accepted';
}
