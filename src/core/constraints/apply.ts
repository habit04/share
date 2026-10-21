/**
 * Priority 30.4 — pure document adapter for the constraint engine
 * (design-constraints.md §6). The document-level counterpart of
 * core/parametric/apply.ts: pure DrawingState -> result functions that
 * return the SAME state object on any refusal, so a caller can install a
 * success with exactly ONE Drawing.transact (one accepted edit = one undo
 * step) and a refusal leaves zero trace (no undo entry, no dirty flag, no
 * revision bump — unchanged by construction, not by rollback).
 *
 * Contract (§6, normative):
 * 1. The solve runs HERE, outside any transaction, against the supplied
 *    state's entities. Nothing in this module mutates or commits.
 * 2. Validation or solver failure => the input state object, with the
 *    solver's status / failure code / problems. No partial install, ever:
 *    the engine's all-or-nothing result is the only thing installed.
 * 3. Success => a new state whose `entities` are the solver's result array
 *    (unmoved entities keep object identity) and whose `constraints` is
 *    the set that was solved — for constraint edits, the EDITED set, so
 *    moved entities and the new set are installed together by the caller's
 *    single transact.
 * 4. A transaction refusal is NOT a solver outcome: if the caller's
 *    transact throws (prepareDrawingState / reconcileCadGraph rejecting
 *    the prepared state — design case 15), that exception is the surface
 *    error, distinguishable from every §5.7 solver code, and the document
 *    stays unchanged because Drawing assigns only after preparation.
 * 5. Solving never touches cadGraph, layers, blocks, layouts or selection:
 *    the returned state spreads the input and replaces only `entities`
 *    (and `constraints` for edits).
 * 6. A drawing whose JCAD_CONSTRAINTS payload was retained unmodeled
 *    (state.constraintsRetained) refuses every operation here: the modeled
 *    set is unknown, and editing or solving against a guessed set would
 *    orphan the retained data.
 */
import type { DrawingState } from '../document';
import type { Constraint, ConstraintSet } from './model';
import { solveConstraints, type SolveFailureCode, type SolveOptions, type SolveResult, type SolveStatus } from './solve';
import type { ConstraintProblem } from './validate';

/** Failure codes surfaced by this adapter: every §5.7 solver code (plus the
 *  solver's own 'validation-failed' / 'unsupported-constraint'), and the
 *  adapter-level codes for states the solver is never invoked on. */
export type ConstraintApplyCode =
  | SolveFailureCode
  | 'no-constraints' // the state carries no constraint set (and no retained payload)
  | 'constraints-retained' // the set exists only as an unmodeled retained payload
  | 'constraint-not-found' // removeConstraint / withConstraintValue named an unknown id
  | 'no-change'; // withConstraintValue given the value the constraint already has

export interface ConstraintApplyResult {
  /** The new state on success; the INPUT state object (identity) on any refusal. */
  readonly state: DrawingState;
  readonly ok: boolean;
  /** Solver status when the solver ran (also on refusal). */
  readonly status?: SolveStatus;
  /** Present on refusal: a §5.7 solver code or an adapter-level code above. */
  readonly code?: ConstraintApplyCode;
  /** Validation problems when the refusal is a validation failure (§4). */
  readonly problems?: readonly ConstraintProblem[];
  /** The full solver result when the solver ran. */
  readonly solve?: SolveResult;
  /** Human-readable detail for logs / UI. Not parsed by code. */
  readonly message?: string;
}

const refuse = (state: DrawingState, code: ConstraintApplyCode, message: string): ConstraintApplyResult => ({
  state,
  ok: false,
  code,
  message,
});

const retainedRefusal = (state: DrawingState): ConstraintApplyResult =>
  refuse(
    state,
    'constraints-retained',
    'This drawing carries constraint data this build cannot model; it is retained as opaque data and constraint edits and solves are refused.',
  );

/** Map a solver result onto the adapter result for `stateFor`: installs
 *  `nextSet` alongside the solved entities on success, refuses with the
 *  input state otherwise. `unchangedSet` distinguishes a plain re-solve
 *  (install the state's own set object — i.e. leave the field untouched)
 *  from a constraint edit (install the edited set, or drop the field when
 *  the edited set is empty). */
function install(
  state: DrawingState,
  result: SolveResult,
  nextSet: ConstraintSet | undefined,
  unchangedSet: boolean,
): ConstraintApplyResult {
  if (!result.ok) {
    return {
      state,
      ok: false,
      status: result.status,
      code: result.failure?.code,
      ...(result.problems ? { problems: result.problems } : {}),
      solve: result,
      message: result.failure?.message,
    };
  }
  const solved: DrawingState = { ...state, entities: result.entities! };
  if (unchangedSet) return { state: solved, ok: true, status: result.status, solve: result };
  if (nextSet && nextSet.constraints.length > 0) {
    return { state: { ...solved, constraints: nextSet }, ok: true, status: result.status, solve: result };
  }
  // An edit that empties the set removes the field entirely: a
  // constraints-free drawing carries no constraint field (and, on save,
  // emits no JCAD_CONSTRAINTS payload — the fixed point is preserved).
  const { constraints: _dropped, ...rest } = solved;
  return { state: rest, ok: true, status: result.status, solve: result };
}

/**
 * Solve the state's constraint set against its entities. On success the
 * returned state carries the solved entities and the UNCHANGED set (same
 * object); on failure the input state object with the solver's
 * status/code. The caller installs a success via exactly one transact.
 */
export function solveAndApply(state: DrawingState, options: SolveOptions = {}): ConstraintApplyResult {
  if (state.constraintsRetained !== undefined) return retainedRefusal(state);
  const set = state.constraints;
  if (!set) return refuse(state, 'no-constraints', 'This drawing has no constraint set to solve.');
  return install(state, solveConstraints(state.entities, set, options), set, true);
}

/**
 * Replace the drawing's constraint set (design §6 constraint edit): the
 * candidate set is validated and solved FIRST, against the current
 * entities; only a successful solve installs {solved entities, new set}
 * together. A set that fails validation, conflicts, or does not solve is
 * refused whole — the previous set and geometry stay.
 */
export function withConstraintSet(state: DrawingState, set: ConstraintSet, options: SolveOptions = {}): ConstraintApplyResult {
  if (state.constraintsRetained !== undefined) return retainedRefusal(state);
  return install(state, solveConstraints(state.entities, set, options), set, false);
}

/** Append one constraint and solve (design §6 add edit). A duplicate id or
 *  signature is a validation refusal from the solve path. */
export function addConstraint(state: DrawingState, constraint: Constraint, options: SolveOptions = {}): ConstraintApplyResult {
  const set: ConstraintSet = { constraints: [...(state.constraints?.constraints ?? []), constraint] };
  return withConstraintSet(state, set, options);
}

/** Remove one constraint by id and solve (design §6 delete edit). Removing
 *  the last constraint removes the `constraints` field on success. */
export function removeConstraint(state: DrawingState, constraintId: string, options: SolveOptions = {}): ConstraintApplyResult {
  if (state.constraintsRetained !== undefined) return retainedRefusal(state);
  const current = state.constraints?.constraints ?? [];
  if (!current.some((c) => c.id === constraintId)) {
    return refuse(state, 'constraint-not-found', `No constraint with id '${constraintId}'.`);
  }
  return withConstraintSet(state, { constraints: current.filter((c) => c.id !== constraintId) }, options);
}

/** Change one constraint's driving value and solve (design §6 edit). The
 *  value contract (dimensional kinds only, finite, sign rules) is §4
 *  validation's, reached through the solve path — never repaired here. */
export function withConstraintValue(state: DrawingState, constraintId: string, value: number, options: SolveOptions = {}): ConstraintApplyResult {
  if (state.constraintsRetained !== undefined) return retainedRefusal(state);
  const current = state.constraints?.constraints ?? [];
  const target = current.find((c) => c.id === constraintId);
  if (!target) return refuse(state, 'constraint-not-found', `No constraint with id '${constraintId}'.`);
  if (target.value === value) {
    return refuse(state, 'no-change', `Constraint '${constraintId}' already has the value ${value}.`);
  }
  const set: ConstraintSet = { constraints: current.map((c) => (c.id === constraintId ? { ...c, value } : c)) };
  return withConstraintSet(state, set, options);
}
