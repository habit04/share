/**
 * The renderer side of the confined underlay byte channel (P28 finish,
 * design section 2.4): candidates come from the IMAGE loader's own helper
 * (section 2.3 — identical discipline, no second ordering implementation);
 * the FIRST non-null candidate wins; a candidate whose bridge call throws
 * (a policy refusal) is simply not the bytes, and the search ends in null
 * — which the display service settles as frame + label. The drawing folder
 * is read at LOAD time through the path getter, never captured at
 * composition. No listing, no existence probe: the returned bytes are the
 * only existence signal.
 */
import type { UnderlayDefinition } from '../core/underlay';
import { imageCandidates } from '../render/images';
import type { UnderlayByteSource } from './underlay-render';

export function bridgeUnderlayBytes(deps: {
  readUnderlay: (file: string) => Promise<Uint8Array | null>;
  /** The ACTIVE drawing's path at load time (editor.doc.filePath). */
  drawingPath: () => string | null | undefined;
}): UnderlayByteSource {
  return async (def: UnderlayDefinition): Promise<Uint8Array | null> => {
    for (const file of imageCandidates(def.sourcePath, deps.drawingPath())) {
      try {
        const bytes = await deps.readUnderlay(file);
        if (bytes) return bytes;
      } catch {
        return null; // a policy refusal ends the search: not the bytes
      }
    }
    return null;
  };
}

/** The no-channel posture: every definition resolves null (frame + label). */
export const nullUnderlayBytes: UnderlayByteSource = async () => null;
