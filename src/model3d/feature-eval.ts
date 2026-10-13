/**
 * Re-evaluation of a solid's construction history (`Feature3D`) into a world-space mesh.
 *
 * - Primitives go through `primitiveMesh` (primitives.ts), extrusions and revolutions through
 *   sweep.ts, Booleans recursively through a `GeometryKernel` (operands evaluated first, in order,
 *   so results are deterministic).
 * - `mesh` features have no recipe: they throw a FeatureEvalError saying they cannot be
 *   re-evaluated, and callers keep the stored mesh of such a solid.
 * - The feature tree is checked before any work (a `mesh` feature anywhere is refused up front): at most `maxDepth` levels (default 32) and
 *   `maxNodes` features in total (default 1024), Boolean features with exactly two operands, known
 *   kinds only. A stored history that breaks these limits is refused, never truncated.
 * Every result follows the mesh conventions (closed, counter-clockwise from outside, positive
 * volume, world drawing units). Errors from the builders (RangeError, GeometryBudgetError) and the
 * kernel (KernelError) propagate unchanged.
 */
import type { GeometryKernel } from './kernel/kernel';
import type { Mesh3D } from './mesh';
import { primitiveMesh } from './primitives';
import { extrudeMesh, revolveMesh } from './sweep';
import type { Feature3D } from './types';

/** Default limits on a feature tree. */
export const DEFAULT_FEATURE_MAX_DEPTH = 32;
export const DEFAULT_FEATURE_MAX_NODES = 1024;

export interface FeatureEvalOptions {
  /** Deepest allowed nesting (a lone primitive has depth 1). */
  readonly maxDepth?: number;
  /** Most features allowed in the whole tree. */
  readonly maxNodes?: number;
}

/** A feature history that cannot be evaluated; the message is fit for the user. */
export class FeatureEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureEvalError';
  }
}

const KINDS = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'wedge', 'extrude', 'revolve', 'boolean', 'mesh']);

function meshError(source: string): FeatureEvalError {
  return new FeatureEvalError(`This solid is an ${source} mesh without construction history; it cannot be re-evaluated (keep its stored mesh).`);
}

/** Walk the tree iteratively (no recursion on untrusted depth) and enforce the limits. */
function checkTree(root: Feature3D, maxDepth: number, maxNodes: number): void {
  const stack: { f: Feature3D; depth: number }[] = [{ f: root, depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const { f, depth } = stack.pop()!;
    if (++nodes > maxNodes) throw new FeatureEvalError(`The solid's history has more than ${maxNodes} features; it is too complex to re-evaluate.`);
    if (depth > maxDepth) throw new FeatureEvalError(`The solid's history is nested more than ${maxDepth} levels deep; it is too complex to re-evaluate.`);
    if (!f || typeof f !== 'object' || !KINDS.has((f as { kind?: unknown }).kind as string)) throw new FeatureEvalError('The solid\'s history contains an unknown feature.');
    if (f.kind === 'mesh') throw meshError(f.source);
    if (f.kind === 'boolean') {
      if (!Array.isArray(f.operands) || f.operands.length !== 2) throw new FeatureEvalError(`A Boolean feature must have exactly two operands (found ${Array.isArray(f.operands) ? f.operands.length : 0}).`);
      if (f.op !== 'union' && f.op !== 'subtract' && f.op !== 'intersect') throw new FeatureEvalError(`Unknown Boolean operation "${String(f.op)}".`);
      for (let i = f.operands.length - 1; i >= 0; i--) stack.push({ f: f.operands[i]!, depth: depth + 1 });
    }
  }
}

async function evaluate(f: Feature3D, kernel: GeometryKernel): Promise<Mesh3D> {
  switch (f.kind) {
    case 'box': case 'cylinder': case 'sphere': case 'cone': case 'torus': case 'wedge':
      return primitiveMesh(f);
    case 'extrude':
      return extrudeMesh(f.profile, f.distance);
    case 'revolve':
      return revolveMesh(f.profile, f.axis, f.angle);
    case 'boolean': {
      const a = await evaluate(f.operands[0]!, kernel);
      const b = await evaluate(f.operands[1]!, kernel);
      return kernel.boolean(f.op, a, b);
    }
    case 'mesh':
      throw meshError(f.source);
  }
}

/**
 * Evaluate `feature` to a world-space mesh (see the module comment). Throws FeatureEvalError for
 * a tree over the limits, a malformed Boolean or a `mesh` feature anywhere in it, and propagates
 * builder and kernel errors.
 */
export async function evaluateFeature(feature: Feature3D, kernel: GeometryKernel, opts: FeatureEvalOptions = {}): Promise<Mesh3D> {
  const maxDepth = opts.maxDepth ?? DEFAULT_FEATURE_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_FEATURE_MAX_NODES;
  checkTree(feature, maxDepth, maxNodes);
  return evaluate(feature, kernel);
}
