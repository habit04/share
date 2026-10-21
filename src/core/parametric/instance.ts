/**
 * Priority 30.1 — per-instance dynamic-block parameter values + validation.
 * (30.2a adds the 'visibility' value kind: a state name, design §1.3.
 *  30.2b adds the 'lookup' value kind: a row name, or null for an explicitly
 *  inactive lookup — design-visibility-lookup-array.md §2.4.)
 *
 * Instance state is deliberately tiny: just the parameter values that differ per
 * insert. It does not copy the definition, the geometry, or the insert's transform.
 * Validation reports; it never clamps, snaps or repairs.
 */
import type { AngleParameter, DynamicBlockDefinition, DynamicParameter, LinearDistanceParameter } from './definitions';
import { EVALUATION_TOLERANCE } from './evaluate';

/**
 * Parameter values owned by ONE insert of a dynamic block. Stored on the
 * InsertEntity itself (design §4). Absent on ordinary inserts.
 */
export interface DynamicInstanceState {
  /** Must match the block name of the owning insert; checked on load/edit (when the
   *  caller supplies the owning block name) so a retargeted or renamed insert cannot
   *  silently inherit another block's values. */
  readonly block: string;
  /** Sparse: parameter id -> value. A parameter with no entry is at its default.
   *  Sparseness is what makes "definition gains a parameter later" safe: old
   *  instances simply have no entry and evaluate at the new default. */
  readonly values: Readonly<Record<string, DynamicParameterValue>>;
}

/** Values are tagged so new kinds (30.2: angle, flip; 30.2a: visibility;
 *  30.2b: lookup) don't reshape existing data. */
export type DynamicParameterValue =
  | { readonly kind: 'distance'; readonly value: number }
  /** Angle in radians (the codebase's angle convention). */
  | { readonly kind: 'angle'; readonly value: number }
  /** Flip state: true = mirrored relative to the authored orientation. */
  | { readonly kind: 'flip'; readonly value: boolean }
  /** Visibility state name (an identity in the owning parameter, design §1.2). */
  | { readonly kind: 'visibility'; readonly value: string }
  /** Lookup row choice: a row name, or null = explicitly no row (overrides
   *  the parameter's defaultRow). Absent from the sparse map = defaultRow. */
  | { readonly kind: 'lookup'; readonly value: string | null }
  | { readonly kind: 'opaque'; readonly payload: string };

export type InstanceIssueCode =
  | 'unknown-parameter' // value supplied for a parameter id not in the definition
  | 'wrong-value-kind' // e.g. opaque value on a modeled parameter, distance on an opaque one
  | 'non-finite-value' // NaN / Infinity / non-number from a file
  | 'value-out-of-range' // range or increment bounds violated (also negative for unbounded)
  | 'value-not-in-list' // list constraint violated
  | 'value-off-increment' // not min + k * increment (within EVALUATION_TOLERANCE)
  | 'unknown-visibility-state' // visibility value names a state the parameter does not have
  | 'unknown-lookup-row' // lookup value names a row the parameter's table does not have
  | 'block-mismatch'; // state.block !== owning insert's block

export interface InstanceIssue {
  readonly code: InstanceIssueCode;
  /** Parameter the issue belongs to, when applicable. */
  readonly parameterId?: string;
  /** Human-readable, for the import report / properties UI. Not parsed by code. */
  readonly message: string;
}

export type InstanceValidation =
  | {
      readonly ok: true;
      /** Every parameter id in the definition, defaults filled in. A fresh object
       *  per call; the input state is not modified or completed in place. */
      readonly effective: Readonly<Record<string, DynamicParameterValue>>;
      /** Declared (always undefined) so union access typechecks under
       *  tsconfig.scripts.json, which compiles with strictNullChecks off and
       *  therefore does not narrow this union by the `ok` discriminant
       *  (review finding R01). */
      readonly issues?: undefined;
    }
  | { readonly ok: false; readonly issues: readonly InstanceIssue[] };

function constraintIssue(param: LinearDistanceParameter, value: number): InstanceIssue | undefined {
  const issue = (code: InstanceIssueCode, message: string): InstanceIssue => ({ code, message, parameterId: param.id });
  const c = param.constraint;
  switch (c.kind) {
    case 'unbounded':
      return value < 0 ? issue('value-out-of-range', `Parameter '${param.id}' value ${value} is negative.`) : undefined;
    case 'range':
      // Range bounds are exact (the shared tolerance applies to increment/list
      // membership, frame inclusion and zero-delta detection — design §2.1/§3.5).
      if (c.min !== undefined && value < c.min) {
        return issue('value-out-of-range', `Parameter '${param.id}' value ${value} is below its minimum ${c.min}.`);
      }
      if (c.max !== undefined && value > c.max) {
        return issue('value-out-of-range', `Parameter '${param.id}' value ${value} exceeds its maximum ${c.max}.`);
      }
      return undefined;
    case 'increment': {
      if (value < c.min - EVALUATION_TOLERANCE || value > c.max + EVALUATION_TOLERANCE) {
        return issue('value-out-of-range', `Parameter '${param.id}' value ${value} is outside [${c.min}, ${c.max}].`);
      }
      const k = Math.round((value - c.min) / c.increment);
      const snapped = c.min + k * c.increment;
      if (Math.abs(value - snapped) > EVALUATION_TOLERANCE) {
        return issue('value-off-increment', `Parameter '${param.id}' value ${value} is not ${c.min} + k * ${c.increment}.`);
      }
      return undefined;
    }
    case 'list':
      return c.values.some((v) => Math.abs(v - value) <= EVALUATION_TOLERANCE)
        ? undefined
        : issue('value-not-in-list', `Parameter '${param.id}' value ${value} is not in its value list.`);
  }
}

function angleConstraintIssue(param: AngleParameter, value: number): InstanceIssue | undefined {
  const c = param.constraint;
  if (c.kind === 'unbounded') return undefined;
  // Range bounds are exact, as for distances; angles are never wrapped to fit.
  if (c.min !== undefined && value < c.min) {
    return { code: 'value-out-of-range', message: `Parameter '${param.id}' angle ${value} is below its minimum ${c.min}.`, parameterId: param.id };
  }
  if (c.max !== undefined && value > c.max) {
    return { code: 'value-out-of-range', message: `Parameter '${param.id}' angle ${value} exceeds its maximum ${c.max}.`, parameterId: param.id };
  }
  return undefined;
}

const defaultValueOf = (param: DynamicParameter): DynamicParameterValue => {
  switch (param.kind) {
    case 'linear-distance':
      return { kind: 'distance', value: param.defaultValue };
    case 'angle':
      return { kind: 'angle', value: param.defaultValue };
    case 'flip':
      return { kind: 'flip', value: param.defaultValue };
    case 'visibility':
      return { kind: 'visibility', value: param.defaultState };
    case 'lookup':
      return { kind: 'lookup', value: param.defaultRow };
    case 'opaque-parameter':
      return { kind: 'opaque', payload: param.payload };
  }
};

/**
 * Check ONE supplied value against ONE parameter: kind match, finiteness, and
 * the parameter's own constraint (distance range/increment/list, angle range,
 * visibility state existence, lookup row existence). This is the per-value
 * check `validateInstanceValues` applies to every supplied instance value,
 * factored out so `validateDefinition` can validate lookup row key/assignment
 * values with exactly the same rules (design §2.5) — because every value a row
 * can inject is checked here at definition time, the evaluator's lookup
 * override can never produce an invalid effective value.
 */
export function parameterValueIssue(param: DynamicParameter, supplied: DynamicParameterValue): InstanceIssue | undefined {
  const wrongKind = (message: string): InstanceIssue => ({ code: 'wrong-value-kind', message, parameterId: param.id });
  switch (param.kind) {
    case 'opaque-parameter':
      return supplied.kind !== 'opaque'
        ? wrongKind(`Parameter '${param.id}' is opaque and cannot take a '${supplied.kind}' value.`)
        : undefined;
    case 'angle': {
      if (supplied.kind !== 'angle') {
        return wrongKind(`Parameter '${param.id}' cannot take a '${supplied.kind}' value.`);
      }
      if (typeof supplied.value !== 'number' || !Number.isFinite(supplied.value)) {
        return { code: 'non-finite-value', message: `Parameter '${param.id}' value is not a finite number.`, parameterId: param.id };
      }
      return angleConstraintIssue(param, supplied.value);
    }
    case 'flip':
      return supplied.kind !== 'flip' || typeof supplied.value !== 'boolean'
        ? wrongKind(`Parameter '${param.id}' cannot take a non-boolean flip value.`)
        : undefined;
    case 'visibility': {
      if (supplied.kind !== 'visibility' || typeof supplied.value !== 'string') {
        return wrongKind(`Parameter '${param.id}' cannot take a '${supplied.kind}' value; a state name is required.`);
      }
      // An unknown state name is refused, never replaced by the default state
      // as a "repair" (design §1.3): the block displays its authored geometry
      // and the stored value is retained.
      return param.states.some((s) => s.name === supplied.value)
        ? undefined
        : {
            code: 'unknown-visibility-state',
            message: `Parameter '${param.id}' has no visibility state named '${supplied.value}'.`,
            parameterId: param.id,
          };
    }
    case 'lookup': {
      if (supplied.kind !== 'lookup') {
        return wrongKind(`Parameter '${param.id}' cannot take a '${supplied.kind}' value; a row name or null is required.`);
      }
      const choice: unknown = supplied.value;
      if (choice !== null && typeof choice !== 'string') {
        return wrongKind(`Parameter '${param.id}' lookup value must be a row name or null.`);
      }
      // A stored choice naming a missing row (e.g. the definition was revised
      // and the row removed) is an invalid instance value — refused, retained,
      // displayed at authored geometry — never silently treated as "no row"
      // (design §2.5).
      return choice === null || param.rows.some((r) => r.name === choice)
        ? undefined
        : {
            code: 'unknown-lookup-row',
            message: `Parameter '${param.id}' has no lookup row named '${choice}'.`,
            parameterId: param.id,
          };
    }
    case 'linear-distance': {
      if (supplied.kind !== 'distance') {
        return wrongKind(`Parameter '${param.id}' cannot take an opaque value.`);
      }
      if (typeof supplied.value !== 'number' || !Number.isFinite(supplied.value)) {
        return { code: 'non-finite-value', message: `Parameter '${param.id}' value is not a finite number.`, parameterId: param.id };
      }
      return constraintIssue(param, supplied.value);
    }
  }
}

/**
 * The equality the lookup machinery uses (design §2.7): numeric values
 * (distance, angle) compare within EVALUATION_TOLERANCE; flip, visibility and
 * lookup values compare exactly; opaque payloads compare verbatim. Values of
 * different kinds are never equal. Used by `matchingLookupRow` (the derived
 * current-row query) and by definition validation's duplicate-key check —
 * two rows whose keys are indistinguishable to the matcher are duplicates.
 */
export function parameterValuesEqual(a: DynamicParameterValue, b: DynamicParameterValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'distance':
    case 'angle':
      return Math.abs(a.value - (b as { value: number }).value) <= EVALUATION_TOLERANCE;
    case 'flip':
    case 'visibility':
    case 'lookup':
      return a.value === (b as { value: unknown }).value;
    case 'opaque':
      return a.payload === (b as { payload: string }).payload;
  }
}


/**
 * Validate per-instance values against a definition and compute the effective
 * values (every parameter, defaults filled into a fresh object).
 *
 * Semantics (design §2.1):
 * - `state === undefined` is valid: every parameter is at its default.
 * - Unknown-parameter values are an issue, not dropped data.
 * - Increment/list membership uses the single shared EVALUATION_TOLERANCE;
 *   values are checked, never snapped or clamped.
 * - `blockName`, when supplied by the caller that knows the owning insert,
 *   enables the 'block-mismatch' check against `state.block`.
 */
export function validateInstanceValues(
  definition: DynamicBlockDefinition,
  state: DynamicInstanceState | undefined,
  blockName?: string,
): InstanceValidation {
  const issues: InstanceIssue[] = [];
  if (state !== undefined && blockName !== undefined && state.block !== blockName) {
    issues.push({
      code: 'block-mismatch',
      message: `Instance state belongs to block '${state.block}', not '${blockName}'.`,
    });
  }

  const effective: Record<string, DynamicParameterValue> = {};
  const known = new Set<string>();
  for (const param of definition.parameters) {
    known.add(param.id);
    const supplied = state?.values[param.id];
    if (supplied === undefined) {
      effective[param.id] = defaultValueOf(param);
      continue;
    }
    const issue = parameterValueIssue(param, supplied);
    if (issue) {
      issues.push(issue);
      continue;
    }
    effective[param.id] = supplied;
  }

  if (state !== undefined) {
    for (const id of Object.keys(state.values).sort()) {
      if (!known.has(id)) {
        issues.push({ code: 'unknown-parameter', message: `Value supplied for unknown parameter '${id}'.`, parameterId: id });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, effective };
}
