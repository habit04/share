/**
 * Which errors of the 3D core are meant for the user, and how a 3D command should report them
 * (docs/3D-TESTING.md "Error handling audit" lists every throw site).
 *
 * The documented, user-facing errors are:
 * - `Model3DInputError` (input-error.ts) from the builders (primitives.ts, sweep.ts): invalid
 *   sizes, frames, profiles, axes, angles, or a result without usable volume at its size and
 *   position; and its subclass `FeatureEvalError` (feature-eval.ts): a history that cannot be
 *   re-evaluated (mesh features, too deep or too large, malformed Booleans);
 * - `GeometryBudgetError` (core/geometry-budget-error.ts): a sweep or a drawing state over the
 *   triangle limits (budget.ts); `Editor` already reports it for every command;
 * - `KernelError` (kernel/kernel.ts): every failed Boolean, with a machine-readable `code`.
 * Their messages are complete sentences written for the command line. Anything else, including a
 * plain RangeError or TypeError from the engine (a stack overflow, a failed allocation) or a plain
 * Error from an internal invariant, is a programming error: the command must still not crash, but
 * the message says so and the error should reach diagnostics.
 *
 * `Editor.geometryAction` reports only GeometryBudgetError and rethrows the rest, so a 3D command
 * that evaluates features or runs Booleans must catch with `describeModel3DError` itself.
 */
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { FeatureEvalError } from './feature-eval';
import { Model3DInputError } from './input-error';
import { KernelError, type KernelErrorCode } from './kernel/kernel';

export { Model3DInputError } from './input-error';

/** How a 3D error should be presented. */
export interface Model3DErrorReport {
  /** `internal` = not a documented error (a bug): log it and send it to diagnostics too. */
  readonly kind: 'input' | 'budget' | 'history' | 'kernel' | 'internal';
  /** The text for the command line (a sentence; prefix it with the command name). */
  readonly message: string;
  /** The kernel's error code, for `kernel` errors. */
  readonly code?: KernelErrorCode;
}

/**
 * Classify an error thrown (or a rejection) by the 3D core. Documented errors keep their message;
 * anything else becomes `internal` with a message that says the operation was not applied.
 */
export function describeModel3DError(err: unknown): Model3DErrorReport {
  if (err instanceof KernelError) return { kind: 'kernel', message: err.message, code: err.code };
  if (err instanceof FeatureEvalError) return { kind: 'history', message: err.message };
  if (err instanceof GeometryBudgetError) return { kind: 'budget', message: err.message };
  if (err instanceof Model3DInputError) return { kind: 'input', message: err.message };
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { kind: 'internal', message: `Internal error in the 3D modeller (${detail.slice(0, 200)}); the operation was not applied.` };
}

/** True for the documented, user-facing 3D errors (see the module comment). */
export function isModel3DUserError(err: unknown): boolean {
  return describeModel3DError(err).kind !== 'internal';
}
