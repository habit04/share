/**
 * The geometry-kernel seam: solid Boolean operations behind an asynchronous interface, so the
 * implementation (Manifold WebAssembly in a worker today, possibly another kernel later) can run
 * off the UI thread and fail without taking the editor with it.
 *
 * Conventions shared by every implementation:
 * - Meshes are `Mesh3D` (mesh.ts): world drawing units, AutoCAD WCS (right-handed, Z toward the
 *   viewer), triangles counter-clockwise seen from outside, closed by index topology.
 * - Operands are validated on the calling side before they reach a kernel (`prepareOperands`):
 *   both must be well-formed (`validateMesh`), closed (`meshIsClosed`) and within the per-solid
 *   triangle budget. Bad input is refused with a message naming the operand, never repaired.
 * - Results are checked on the calling side as well (`finishResult`): exact duplicate vertices are
 *   welded, the mesh is re-validated, must be closed and non-empty, must fit MAX_SOLID_TRIANGLES,
 *   and is flipped with `invertWinding` if its volume comes back negative.
 * - `subtract` is a - b. Errors are `KernelError`s whose message is fit to show the user.
 */
import { MAX_SOLID_TRIANGLES } from '../budget';
import { type Mesh3D, invertWinding, meshIsClosed, meshTriangleCount, meshVolume, validateMesh, weldVertices } from '../mesh';

/** A solid Boolean operation; `subtract` removes the second operand from the first. */
export type BooleanOp = 'union' | 'subtract' | 'intersect';

/** Whether a kernel can run here, and if not, why (shown to the user as is). */
export interface KernelStatus {
  readonly available: boolean;
  readonly reason?: string;
  readonly version?: string;
}

export interface BooleanOptions {
  /** Give up after this many milliseconds (default per implementation; the worker kernel uses 20 s). */
  readonly timeoutMs?: number;
}

/** An asynchronous solid-modelling kernel. */
export interface GeometryKernel {
  /** Human-readable name, e.g. "Manifold 3.5.4 (worker)". */
  readonly name: string;
  /** Start the kernel if needed and report whether it is usable. Never rejects. */
  ready(): Promise<KernelStatus>;
  /** Boolean of two closed solids; rejects with a KernelError. */
  boolean(op: BooleanOp, a: Mesh3D, b: Mesh3D, opts?: BooleanOptions): Promise<Mesh3D>;
  /** Release workers and native memory; later calls reject. */
  dispose(): void;
}

/** Machine-readable cause of a KernelError. */
export type KernelErrorCode = 'invalid-input' | 'empty-result' | 'timeout' | 'worker-crash' | 'budget' | 'unavailable' | 'disposed' | 'kernel-failure';

/** A failed kernel call; `message` is written for the user. */
export class KernelError extends Error {
  readonly code: KernelErrorCode;
  /** The operand at fault for `invalid-input` ('a' = first, 'b' = second). */
  readonly operand?: 'a' | 'b';

  constructor(code: KernelErrorCode, message: string, operand?: 'a' | 'b') {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    if (operand) this.operand = operand;
  }
}

const OP_NAMES: Readonly<Record<BooleanOp, string>> = { union: 'union', subtract: 'subtraction', intersect: 'intersection' };

/** User-facing name of an operation ("union", "subtraction", "intersection"). */
export function opName(op: BooleanOp): string {
  return OP_NAMES[op];
}

/** User-facing name of an operand. */
export function operandName(which: 'a' | 'b'): string {
  return which === 'a' ? 'The first solid' : 'The second solid';
}

/** KernelError for an operand the kernel itself refused (e.g. Manifold reports "not manifold"). */
export function invalidOperand(op: BooleanOp, which: 'a' | 'b', detail: string): KernelError {
  return new KernelError('invalid-input', `${operandName(which)} cannot be used in the ${opName(op)}: ${detail}.`, which);
}

/** KernelError for a call that ran longer than allowed. */
export function timeoutError(op: BooleanOp, ms: number): KernelError {
  return new KernelError('timeout', `The ${opName(op)} took longer than ${Math.round(ms / 100) / 10} s and was stopped; try simpler solids (fewer segments).`);
}

/** KernelError for a kernel process or worker that stopped unexpectedly. */
export function crashError(detail?: string): KernelError {
  return new KernelError('worker-crash', `The geometry kernel stopped unexpectedly${detail ? ` (${detail})` : ''}; the operation was not applied.`);
}

/** KernelError for an environment without a usable kernel. */
export function unavailableError(reason: string): KernelError {
  return new KernelError('unavailable', `Solid Boolean operations are unavailable in this environment: ${reason}`);
}

function checkOperand(op: BooleanOp, which: 'a' | 'b', mesh: Mesh3D): void {
  const problem = validateMesh(mesh);
  if (problem) throw invalidOperand(op, which, `its mesh is malformed (${problem})`);
  const tris = meshTriangleCount(mesh);
  if (tris > MAX_SOLID_TRIANGLES) throw new KernelError('budget', `${operandName(which)} has ${tris.toLocaleString('en-US')} triangles; the safe limit is ${MAX_SOLID_TRIANGLES.toLocaleString('en-US')} per solid.`);
  if (!meshIsClosed(mesh)) throw invalidOperand(op, which, 'it is not a closed solid (its mesh has open or non-manifold edges)');
  if (!(meshVolume(mesh) > 0)) throw invalidOperand(op, which, 'it has no volume or is turned inside out');
}

/** Validate both operands (throws KernelError 'invalid-input' or 'budget' naming the operand). */
export function prepareOperands(op: BooleanOp, a: Mesh3D, b: Mesh3D): void {
  if (typeof op !== 'string' || !Object.hasOwn(OP_NAMES, op)) throw new KernelError('invalid-input', `Unknown Boolean operation "${String(op)}".`);
  checkOperand(op, 'a', a);
  checkOperand(op, 'b', b);
}

/**
 * Check and normalise a kernel result: weld exact duplicate vertices, re-validate, require a
 * closed, non-empty mesh within the triangle budget, and make the volume positive. When welding
 * would join vertices that the kernel kept apart on purpose (two parts touching along an edge or at
 * a point, where one shared vertex would make the edge non-manifold), the unwelded mesh is kept.
 */
export function finishResult(op: BooleanOp, raw: Mesh3D): Mesh3D {
  const problem = validateMesh(raw);
  if (problem) throw new KernelError('kernel-failure', `The geometry kernel returned an invalid mesh for the ${opName(op)} (${problem}).`);
  if (raw.indices.length === 0) {
    throw new KernelError('empty-result', op === 'intersect'
      ? 'The solids do not overlap, so their intersection is empty.'
      : op === 'subtract' ? 'Nothing is left after the subtraction.' : 'The union is empty.');
  }
  const tris = meshTriangleCount(raw);
  if (tris > MAX_SOLID_TRIANGLES) throw new KernelError('budget', `The ${opName(op)} would have ${tris.toLocaleString('en-US')} triangles; the safe limit is ${MAX_SOLID_TRIANGLES.toLocaleString('en-US')} per solid.`);
  const welded = weldVertices(raw, 0);
  let mesh: Mesh3D;
  if (meshIsClosed(welded)) mesh = welded;
  else if (meshIsClosed(raw)) mesh = raw;
  else throw new KernelError('kernel-failure', `The geometry kernel returned an open mesh for the ${opName(op)}; the result was discarded.`);
  const volume = meshVolume(mesh);
  if (volume < 0) mesh = invertWinding(mesh);
  else if (!(volume > 0)) throw new KernelError('empty-result', `The ${opName(op)} has no volume.`);
  return mesh;
}

/** A kernel that is never available (for environments without WebAssembly or workers). */
export class UnavailableKernel implements GeometryKernel {
  readonly name = 'unavailable';
  constructor(private readonly reason: string) {}

  ready(): Promise<KernelStatus> {
    return Promise.resolve({ available: false, reason: this.reason });
  }

  boolean(_op: BooleanOp, _a: Mesh3D, _b: Mesh3D): Promise<Mesh3D> {
    return Promise.reject(unavailableError(this.reason));
  }

  dispose(): void {}
}

/** Mesh3D as transferable typed arrays (the wire and WASM format). */
export interface PackedMesh {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

/** Copy a mesh into typed arrays (new buffers, safe to transfer). */
export function packMesh(mesh: Mesh3D): PackedMesh {
  return { positions: Float64Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices) };
}

/** Plain-array Mesh3D from typed arrays (fit for sealed drawing state). */
export function unpackMesh(packed: PackedMesh): Mesh3D {
  return { positions: Array.from(packed.positions), indices: Array.from(packed.indices) };
}
