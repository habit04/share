/**
 * The user-facing refusal of the 3D builders (primitives.ts, sweep.ts) and of feature
 * re-evaluation (feature-eval.ts `FeatureEvalError` extends it): invalid sizes, frames, profiles,
 * axes, angles, histories, or a result without usable volume. Its message is a complete sentence
 * for the command line.
 *
 * It extends RangeError so code (and tests) written against the builders' earlier `RangeError`
 * contract keep working, but only this class counts as user input in `describeModel3DError`
 * (errors.ts): a plain RangeError or TypeError from the engine (a stack overflow, a failed
 * allocation, a bug) is an internal error. Kept in its own module, with no imports, so the
 * builders can throw it without an import cycle through errors.ts.
 */
export class Model3DInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'Model3DInputError';
  }
}
