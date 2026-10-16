/**
 * Priority 30.1 — per-instance dynamic-block parameter values + validation.
 *
 * Instance state is deliberately tiny: just the parameter values that differ per
 * insert. It does not copy the definition, the geometry, or the insert's transform.
 * Validation reports; it never clamps, snaps or repairs.
 */
import type { DynamicBlockDefinition, LinearDistanceParameter } from './definitions';
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

/** Values are tagged so 30.2 kinds (angle, visibility state, flip) don't reshape 30.1 data. */
export type DynamicParameterValue =
  | { readonly kind: 'distance'; readonly value: number }
  | { readonly kind: 'opaque'; readonly payload: string };

export type InstanceIssueCode =
  | 'unknown-parameter' // value supplied for a parameter id not in the definition
  | 'wrong-value-kind' // e.g. opaque value on a modeled parameter, distance on an opaque one
  | 'non-finite-value' // NaN / Infinity / non-number from a file
  | 'value-out-of-range' // range or increment bounds violated (also negative for unbounded)
  | 'value-not-in-list' // list constraint violated
  | 'value-off-increment' // not min + k * increment (within EVALUATION_TOLERANCE)
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

const defaultValueOf = (param: LinearDistanceParameter | { readonly kind: 'opaque-parameter'; readonly payload: string }): DynamicParameterValue =>
  param.kind === 'linear-distance' ? { kind: 'distance', value: param.defaultValue } : { kind: 'opaque', payload: param.payload };

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
    if (param.kind === 'opaque-parameter') {
      if (supplied.kind !== 'opaque') {
        issues.push({ code: 'wrong-value-kind', message: `Parameter '${param.id}' is opaque and cannot take a '${supplied.kind}' value.`, parameterId: param.id });
      } else {
        effective[param.id] = supplied;
      }
      continue;
    }
    // Modeled (linear-distance) parameter.
    if (supplied.kind !== 'distance') {
      issues.push({ code: 'wrong-value-kind', message: `Parameter '${param.id}' cannot take an opaque value.`, parameterId: param.id });
      continue;
    }
    if (typeof supplied.value !== 'number' || !Number.isFinite(supplied.value)) {
      issues.push({ code: 'non-finite-value', message: `Parameter '${param.id}' value is not a finite number.`, parameterId: param.id });
      continue;
    }
    const issue = constraintIssue(param, supplied.value);
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
