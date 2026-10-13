/**
 * Saving a drawing with experimental 3D content (milestone 5 policy).
 *
 * - DXF (Save, Save As, autosave / recovery copies) holds the solids: each is a polyface mesh with
 *   `JCAD_3D` data (io/dxf/mesh3d-write.ts, docs/3D-FILE-FORMAT.md), so nothing is asked.
 *   `model3dDxfSaveNotes` gives the non-blocking log lines for what a DXF cannot fully keep (a
 *   construction history too large for the file is stored as a plain mesh).
 * - A file JCad could not reopen is never written: when the solids push the DXF past the reader's
 *   default limits (`DXF_READ_LIMITS`), Save / Save As are refused (`model3dDxfLimitRefusal`) and
 *   the drawing stays modified, and autosave writes its recovery copy without the solids, recording
 *   how many it omitted (`recoveryDxf`).
 * - DWG (Save to a .dwg, EXPORTDWG) cannot hold solids: the portable writer would drop records it
 *   does not know. Those saves are refused (`model3dDwgRefusal`), never written without the solids.
 */
import type { DrawingState } from '../core/document';
import { defaultReadLimitExcess, writeDxf } from '../io/dxf';
import { DXF_READ_LIMITS, payloadDegradation } from './file-format';
import { meshTriangleCount } from './mesh';
import { EMPTY_MODEL3D, withModel3D } from './model';

/** Why a DWG save or export of a drawing with solids is refused (`Editor.lastFileError` and the log). */
export const MODEL3D_DWG_REFUSAL = 'DWG files cannot hold 3D objects in this version; save as DXF, or enable Experimental 3D (Options > Files) to view or erase them';

/** MODEL3D_DWG_REFUSAL when the drawing holds solids or 3D dimensions, else null (DWG writing may go ahead). */
export function model3dDwgRefusal(state: DrawingState): string | null {
  return (state.model3d?.solids.length ?? 0) > 0 || (state.model3d?.dimensions?.length ?? 0) > 0 ? MODEL3D_DWG_REFUSAL : null;
}

/** Total triangles of the drawing's solids. */
function triangleCount(state: DrawingState): number {
  let n = 0;
  for (const s of state.model3d?.solids ?? []) n += meshTriangleCount(s.mesh);
  return n;
}

/**
 * Why the DXF `text` written for `state` must not be saved, or null: the drawing has solids and
 * the file exceeds a limit of DXF_READ_LIMITS, so JCad could not open it again. The message names
 * the triangle count, the limit exceeded and what to do. 2D-only drawings are never refused here.
 */
export function model3dDxfLimitRefusal(state: DrawingState, text: string): string | null {
  if ((state.model3d?.solids.length ?? 0) === 0) return null;
  const excess = defaultReadLimitExcess(text);
  if (!excess) return null;
  const limits = `${DXF_READ_LIMITS.maxPairs.toLocaleString('en-US')} group pairs, ${DXF_READ_LIMITS.maxRecords.toLocaleString('en-US')} records, ${DXF_READ_LIMITS.maxSourceLength.toLocaleString('en-US')} characters`;
  return `the drawing's 3D objects have ${triangleCount(state).toLocaleString('en-US')} triangles, which makes a DXF file JCad could not open again (${excess}; limits: ${limits}). Reduce the 3D model (fewer objects or less mesh detail) and save again`;
}

/**
 * Log lines for a DXF save of `state` (empty for a 2D drawing): solids whose construction history
 * does not fit the per-solid payload limit are saved as plain meshes (geometry kept, no longer
 * editable parametrically after reopening). Not blocking: the geometry is in the file either way.
 */
export function model3dDxfSaveNotes(state: DrawingState): string[] {
  const solids = state.model3d?.solids ?? [];
  let history = 0, names = 0;
  for (const s of solids) {
    const d = payloadDegradation(s);
    if (d !== 'none') history += 1;
    if (d === 'history-and-name') names += 1;
  }
  if (!history) return [];
  const what = history === 1 ? '1 3D object has a construction history' : `${history} 3D objects have construction histories`;
  return [`${what} too large for the DXF file: saved as plain meshes (the geometry is kept; after reopening ${history === 1 ? 'it is' : 'they are'} not editable parametrically${names ? `, and ${names} lose their name` : ''}).`];
}

/**
 * The recovery (autosave) copy of `prepared` (the state after library-block cleanup): the full
 * DXF, or, when the solids would make a file JCad cannot reopen (`model3dDxfLimitRefusal`), the
 * DXF without them and the number of solids omitted, which the autosave metadata records
 * (`omitted3d`) so the recovery dialog says what is missing. A copy without them is still better
 * than none; the open drawing keeps its solids.
 */
export function recoveryDxf(prepared: DrawingState): { readonly text: string; readonly omitted3d: number } {
  const text = writeDxf(prepared);
  if (!model3dDxfLimitRefusal(prepared, text)) return { text, omitted3d: 0 };
  // 3D dimensions are small: they stay in the copy, only the solids are left out.
  return { text: writeDxf(withModel3D(prepared, { ...(prepared.model3d ?? EMPTY_MODEL3D), solids: [] })), omitted3d: prepared.model3d?.solids.length ?? 0 };
}
