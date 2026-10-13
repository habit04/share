/**
 * Messages between the main thread (manifold-kernel.ts) and the kernel worker
 * (manifold.worker.ts). Structured clone; typed-array buffers are transferred, never copied.
 * Meshes travel as `PackedMesh` (Float64Array positions in world drawing units, Uint32Array
 * triangle indices, counter-clockwise seen from outside).
 */
import type { BooleanOp, PackedMesh } from './kernel';

/** A Boolean request from the main thread; `id` matches the reply. */
export interface WorkerRequest {
  readonly id: number;
  readonly op: BooleanOp;
  readonly a: PackedMesh;
  readonly b: PackedMesh;
}

/**
 * Every message the worker posts: one `ready` or `init-error` after start-up, then one reply per
 * request (`operand` names the input the kernel refused).
 */
export type WorkerMessage =
  | { readonly type: 'ready'; readonly version: string }
  | { readonly type: 'init-error'; readonly message: string }
  | { readonly id: number; readonly ok: true; readonly positions: Float64Array; readonly indices: Uint32Array }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly operand?: 'a' | 'b' };
