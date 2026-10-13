/** Main-owned opened-byte evidence belongs to a live tab, never to drawing data/history. */
import type { FileBridge } from './editor';
import type { DocumentSession } from './sessions';

export interface OpenedSourceHint {
  readonly proof: string | null;
  readonly path: string | null;
  readonly mode: 'in-place' | 'save-as';
}
type ProofBridge = FileBridge & { releaseOpenedSourceProof?(proof: string): Promise<void> };
interface OwnedProof {
  readonly bridge: ProofBridge;
  readonly proof: string;
  readonly generation: number;
  readonly path: string;
  borrowed: number;
  owned: boolean;
  release: Promise<void> | null;
}
const proofs = new WeakMap<DocumentSession, OwnedProof>();

export function hasOpenedSourceProofs(bridge: FileBridge): boolean {
  return bridge.platform === 'win32' && typeof (bridge as ProofBridge).releaseOpenedSourceProof === 'function';
}
export function validOpenedSourceProof(proof: unknown): proof is string {
  return typeof proof === 'string' && proof.length > 0 && proof.length <= 256 && !/[\u0000-\u001f\u007f]/.test(proof);
}
/** Cleanup is best effort: retired/consumed main owners already revoke their capabilities. */
export async function releaseOpenedSourceProof(bridge: FileBridge, proof: string | undefined): Promise<void> {
  if (!proof || !hasOpenedSourceProofs(bridge)) return;
  try { await (bridge as ProofBridge).releaseOpenedSourceProof!(proof); } catch { /* Retired owner or expired proof. */ }
}
function releaseUnowned(record: OwnedProof): Promise<void> {
  if (record.owned || record.borrowed) return Promise.resolve();
  return record.release ??= releaseOpenedSourceProof(record.bridge, record.proof);
}

/** Real loads and tab closure revoke ownership; a pending save retains its borrowed token. */
export function forgetOpenedSourceProof(session: DocumentSession): void {
  const record = proofs.get(session);
  if (!record) return;
  proofs.delete(session);
  record.owned = false;
  void releaseUnowned(record);
}

/** Install only into the content generation which accepted this Open/verified Save. */
export function adoptOpenedSourceProof(session: DocumentSession, generation: number, bridge: FileBridge, proof: string | undefined, path: string): boolean {
  if (!hasOpenedSourceProofs(bridge) || !proof) return false;
  if (!validOpenedSourceProof(proof)) throw new Error('The Windows host returned an invalid opened-source proof.');
  if (session.contentGeneration !== generation) { void releaseOpenedSourceProof(bridge, proof); return false; }
  const previous = proofs.get(session);
  if (previous?.bridge === bridge && previous.proof === proof && previous.generation === generation && previous.path === path) return true;
  forgetOpenedSourceProof(session);
  proofs.set(session, { bridge, proof, generation, path, borrowed: 0, owned: true, release: null });
  return true;
}

export interface CapturedOpenedSource {
  readonly hint: OpenedSourceHint;
  /** Join only after the admission's read/write/cleanup has finished. */
  release(): Promise<void>;
}
/** Capture before pickers/serialization. Never look up fresh disk evidence from the renderer. */
export function captureOpenedSourceProof(session: DocumentSession, bridge: FileBridge, fallbackPath: string | null, mode: OpenedSourceHint['mode']): CapturedOpenedSource | null {
  if (!hasOpenedSourceProofs(bridge)) return null;
  let record = proofs.get(session);
  if (record && (record.generation !== session.contentGeneration || record.bridge !== bridge)) {
    forgetOpenedSourceProof(session); record = undefined;
  }
  if (record) record.borrowed += 1;
  let released = false;
  return Object.freeze({
    hint: Object.freeze({ proof: record?.proof ?? null, path: record?.path ?? fallbackPath, mode }),
    async release() {
      if (released) return;
      released = true;
      if (record) { record.borrowed -= 1; await releaseUnowned(record); }
    },
  });
}
