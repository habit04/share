/**
 * Priority 30.1 — pure state transitions for dynamic-block parameter edits.
 *
 * Mirrors the shape of electrical/attributes.ts `withInsertAttributes`: a pure
 * DrawingState -> result function that returns the SAME state object on
 * refusal or no-change, so a caller can commit the result with exactly one
 * Drawing.transact (one accepted edit = one undo step) and a refusal leaves
 * zero trace (no undo entry, no dirty flag, no revision bump). Validation
 * never clamps, snaps or repairs: an invalid value is refused with a stable
 * problem code taken from the instance/definition validation vocabularies.
 *
 * Scope: top-level entities of the supplied state (the list a transact
 * projects for the active space), exactly like withInsertAttributes. Values
 * on inserts nested inside block definitions are expansion-time data and are
 * not edited through here.
 */
import type { DrawingState } from '../document';
import type { BlockDef, InsertEntity } from '../entities';
import { validateDefinition, type DefinitionIssueCode } from './definitions';
import {
  validateInstanceValues,
  type DynamicInstanceState,
  type InstanceIssueCode,
} from './instance';

/** Stable refusal/no-change codes for setDynamicParameter. The validation
 *  codes are reused verbatim from instance.ts / definitions.ts so the edit
 *  path, the reader and the evaluator can never disagree about vocabulary. */
export type SetDynamicParameterProblem =
  | 'insert-not-found' // no entity with that id in the state
  | 'entity-not-insert' // the id names a non-insert entity
  | 'block-not-found' // the insert's block is not defined in the state
  | 'no-dynamic-definition' // the block is an ordinary static block
  | 'definition-retained' // the block's definition payload is opaque/retained; edits refused while present
  | 'instance-retained' // this insert's instance payload is opaque/retained; edits refused while present
  | 'no-change' // the parameter already holds exactly this value
  | InstanceIssueCode
  | DefinitionIssueCode;

export interface SetDynamicParameterResult {
  /** The new state on success; the INPUT state object (identity) on any
   *  refusal or no-change. */
  readonly state: DrawingState;
  /** Present on refusal/no-change; undefined on success. */
  readonly problem?: SetDynamicParameterProblem;
  /** Human-readable detail for logs / UI. Not parsed by code. */
  readonly message?: string;
}

const refuse = (
  state: DrawingState,
  problem: SetDynamicParameterProblem,
  message: string,
): SetDynamicParameterResult => ({ state, problem, message });

/**
 * The instance state a fresh insert of a dynamic block starts with, or
 * undefined when the block has no modeled dynamic definition (or only a
 * retained opaque one, which must not be seeded into modeled state).
 * Values are sparse by design: every parameter is absent, i.e. at the
 * definition's default — so a definition that later gains a parameter, or
 * changes a default, applies to existing seeded inserts exactly as the
 * instance model specifies.
 */
export function seedDynamicInstanceState(block: BlockDef): DynamicInstanceState | undefined {
  if (!block.dynamic || block.dynamicRetained !== undefined) return undefined;
  return { block: block.name, values: {} };
}

/**
 * Set one linear-distance parameter value on one insert.
 *
 * On success the returned state has a NEW entities array containing a NEW
 * insert object (same id) whose `dynamic.values` carries the value sparsely;
 * the block definition object and every other entity are shared by identity,
 * and the input state is not mutated. Setting a parameter back to its
 * definition default stores the value explicitly (it is a real edit the user
 * made, and undo must restore the previous state, sparse or not).
 */
export function setDynamicParameter(
  state: DrawingState,
  insertId: string,
  parameterId: string,
  value: number,
): SetDynamicParameterResult {
  const entity = state.entities.find((e) => e.id === insertId);
  if (!entity) return refuse(state, 'insert-not-found', `No entity with id '${insertId}'.`);
  if (entity.type !== 'insert') {
    return refuse(state, 'entity-not-insert', `Entity '${insertId}' is a ${entity.type}, not a block reference.`);
  }
  const ins: InsertEntity = entity;
  const block = state.blocks[ins.block];
  if (!block) return refuse(state, 'block-not-found', `Block '${ins.block}' is not defined.`);
  if (block.dynamicRetained !== undefined) {
    return refuse(
      state,
      'definition-retained',
      `Block '${ins.block}' has a dynamic definition this build cannot model; it is retained as opaque data and its parameter edits are refused.`,
    );
  }
  const definition = block.dynamic;
  if (!definition) {
    return refuse(state, 'no-dynamic-definition', `Block '${ins.block}' has no dynamic definition.`);
  }
  if (ins.dynamicRetained !== undefined) {
    return refuse(
      state,
      'instance-retained',
      `This reference carries dynamic data this build cannot model; it is retained as opaque data and its parameter edits are refused.`,
    );
  }
  const definitionIssues = validateDefinition(
    definition,
    new Set<string>([...block.entities.map((e) => e.id), ...block.attributes.map((a) => a.tag)]),
  );
  if (definitionIssues.length > 0) {
    const first = definitionIssues[0]!;
    return refuse(state, first.code, `Definition of block '${ins.block}' is invalid: ${first.message}`);
  }
  const param = definition.parameters.find((p) => p.id === parameterId);
  if (!param) {
    return refuse(state, 'unknown-parameter', `Block '${ins.block}' has no parameter '${parameterId}'.`);
  }
  if (param.kind !== 'linear-distance') {
    // 30.2: angle/flip parameters also reach this refusal — this editor sets
    // distance values only; the descriptor names the unmodeled source kind
    // for opaque parameters and the modeled kind otherwise.
    const descriptor = param.kind === 'opaque-parameter' ? `unmodeled '${param.sourceKind}'` : `'${param.kind}'`;
    return refuse(
      state,
      'wrong-value-kind',
      `Parameter '${parameterId}' is an ${descriptor} parameter and cannot take a distance value.`,
    );
  }

  // A stored state recorded against a different block must not be silently
  // repaired by an edit: refuse it as recorded.
  if (ins.dynamic && ins.dynamic.block !== ins.block) {
    return refuse(
      state,
      'block-mismatch',
      `Instance state belongs to block '${ins.dynamic.block}', not '${ins.block}'.`,
    );
  }

  const current = ins.dynamic?.values[parameterId];
  if (current?.kind === 'distance' && current.value === value) {
    return refuse(state, 'no-change', `Parameter '${parameterId}' already has the value ${value}.`);
  }

  const candidate: DynamicInstanceState = {
    block: ins.block,
    values: { ...(ins.dynamic?.values ?? {}), [parameterId]: { kind: 'distance', value } },
  };
  // Validate the whole resulting instance: pre-existing invalid stored values
  // block the edit too, exactly as they block evaluation.
  const validation = validateInstanceValues(definition, candidate, ins.block);
  if (!validation.ok) {
    const first = validation.issues[0]!;
    return refuse(state, first.code, first.message);
  }

  const nextInsert: InsertEntity = { ...ins, dynamic: candidate };
  return {
    state: { ...state, entities: state.entities.map((e) => (e.id === insertId ? nextInsert : e)) },
  };
}
