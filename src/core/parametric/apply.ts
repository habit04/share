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
 * Scope: the supplied state's ACTIVE SPACE. The edit resolves the insert
 * in the state's stored (model-space) entity list first; when it is not
 * there and the state's active space is a layout's paper space, the edit
 * runs against that layout's paper entities and the result folds back
 * into the layout — the same projection Drawing.transact performs — so a
 * caller holding a raw Drawing.snapshot edits paper-space inserts too
 * (review R08 residual). A state a caller already projected (transact's
 * callback argument, the pointer's active-space view) has the insert in
 * its own list, so it resolves there and is never projected twice.
 * Values on inserts nested inside block definitions are expansion-time
 * data and are not edited through here.
 */
import type { DrawingState } from '../document';
import { attributePlacementsForDef, expansionBlock } from '../entities';
import type { BlockDef, Entity, InsertEntity } from '../entities';
import { applyPaperEntities, layoutsOf, paperEntities, paperSpaceLayout, withLayout } from '../layouts';
import { validateDefinition, type DefinitionIssueCode, type DynamicParameter, type LookupParameter } from './definitions';
import { evaluateDynamicBlock, type EvaluationRefusalCode } from './evaluate';
import {
  validateInstanceValues,
  type DynamicInstanceState,
  type DynamicParameterValue,
  type InstanceIssueCode,
} from './instance';

/** Stable refusal/no-change codes for setDynamicParameter. The validation
 *  codes are reused verbatim from instance.ts / definitions.ts so the edit
 *  path, the reader and the evaluator can never disagree about vocabulary.
 *  EvaluationRefusalCode joined the union with the R06 dry run (below):
 *  an edit whose candidate values make evaluation refuse is refused with
 *  the evaluator's own code ('work-limit-exceeded',
 *  'degenerate-transform', 'unsupported-action', ...). */
export type SetDynamicParameterProblem =
  | 'insert-not-found' // no entity with that id in the state
  | 'entity-not-insert' // the id names a non-insert entity
  | 'block-not-found' // the insert's block is not defined in the state
  | 'no-dynamic-definition' // the block is an ordinary static block
  | 'definition-retained' // the block's definition payload is opaque/retained; edits refused while present
  | 'instance-retained' // this insert's instance payload is opaque/retained; edits refused while present
  | 'no-change' // the parameter already holds exactly this value
  | InstanceIssueCode
  | DefinitionIssueCode
  | EvaluationRefusalCode;

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
 * Find an entity by id in the state's ACTIVE SPACE: the stored
 * (model-space) entity list first — so a state a caller already
 * projected (Drawing.transact's callback argument, the pointer's
 * active-space view) resolves in its own list and is never projected a
 * second time — then, when the active space is a layout's paper space,
 * that layout's paper entities (the list Drawing.entities exposes).
 * Entities living only in a NON-active layout are not found: the active
 * space is the editing scope, exactly as in the editor.
 */
export function entityInActiveSpace(state: DrawingState, entityId: string): Entity | undefined {
  const direct = state.entities.find((e) => e.id === entityId);
  if (direct) return direct;
  const lay = paperSpaceLayout(state);
  return lay ? paperEntities(lay).find((e) => e.id === entityId) : undefined;
}

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

/** The raw edit value `setDynamicParameter` accepts, mapped to the tagged
 *  instance value by the TARGET parameter's kind: a number for a
 *  linear-distance or angle parameter, a boolean for flip, a state name
 *  (string) for visibility, and a row name (string) or null for lookup.
 *  A raw value of any other shape for the parameter's kind is refused
 *  'wrong-value-kind' — values are never coerced. */
export type DynamicParameterEditValue = number | boolean | string | null;

function taggedEditValue(param: DynamicParameter, value: DynamicParameterEditValue): DynamicParameterValue | undefined {
  switch (param.kind) {
    case 'linear-distance':
      return typeof value === 'number' ? { kind: 'distance', value } : undefined;
    case 'angle':
      return typeof value === 'number' ? { kind: 'angle', value } : undefined;
    case 'flip':
      return typeof value === 'boolean' ? { kind: 'flip', value } : undefined;
    case 'visibility':
      return typeof value === 'string' ? { kind: 'visibility', value } : undefined;
    case 'lookup':
      // Branch explicitly: the `|| value === null` narrowing does not hold
      // under tsconfig.scripts.json (strictNullChecks off) — review R01.
      if (typeof value === 'string') return { kind: 'lookup', value };
      return value === null ? { kind: 'lookup', value: null } : undefined;
    case 'opaque-parameter':
      return undefined;
  }
}

/** Exact structural equality of two sparse value records — the edit path's
 *  no-change test. (Evaluation's tolerance-based `parameterValuesEqual` is
 *  for derived queries like row matching; an edit that changes a stored
 *  value by any amount is a real edit.) */
function storedValuesEqual(
  a: Readonly<Record<string, DynamicParameterValue>>,
  b: Readonly<Record<string, DynamicParameterValue>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((id) => {
    const va = a[id]!;
    const vb = b[id];
    if (!vb || va.kind !== vb.kind) return false;
    return va.kind === 'opaque'
      ? va.payload === (vb as { payload: string }).payload
      : va.value === (vb as { value: unknown }).value;
  });
}

/**
 * Set one parameter value on one insert: a distance or angle (number), a
 * flip state (boolean), a visibility state (name), or a lookup row choice
 * (row name, or null for no row) — generalized in 30.4 from the 30.1
 * distance-only editor. (The DYNSET command still offers distance
 * parameters only; the generalization is at this apply layer.)
 *
 * Lookup contract (design-visibility-lookup-array.md §2.7): choosing a row
 * changes only the lookup parameter's own stored value. Directly editing a
 * parameter COVERED by the active row — an input of the row, or one of its
 * assignment targets — clears the row choice (stores lookup = null, the
 * native "Custom" outcome) in the SAME returned state, so the caller's
 * single transact keeps the whole edit to one undo step. The active row is
 * the stored choice, or the lookup parameter's defaultRow when no choice
 * is stored (the edit then materializes the cleared state). Editing an
 * uncovered parameter leaves the choice untouched.
 *
 * Space resolution (review R08 residual): the insert is resolved against
 * the state's ACTIVE SPACE (see the header). An insert stored in the
 * state's own entity list is edited there — the pre-existing behaviour,
 * byte for byte. An insert that lives only in the active layout's paper
 * entities is edited against that projected list and the result is folded
 * back into the layout (withLayout + applyPaperEntities, the fold
 * Drawing.transact performs): the returned state is a raw state whose
 * LAYOUT carries the edit and whose stored entity list is the input's,
 * untouched. A refusal in that branch returns the caller's own state
 * object (identity), never the internal projection.
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
  value: DynamicParameterEditValue,
): SetDynamicParameterResult {
  if (state.entities.some((e) => e.id === insertId)) {
    return setDynamicParameterInList(state, insertId, parameterId, value);
  }
  const lay = paperSpaceLayout(state);
  if (lay) {
    const projected = paperEntities(lay);
    if (projected.some((e) => e.id === insertId)) {
      const view: DrawingState = { ...state, entities: projected };
      const result = setDynamicParameterInList(view, insertId, parameterId, value);
      if (result.state === view) {
        // Refusal / no-change: identity with the state the CALLER handed
        // over, not with the internal projection.
        return { state, problem: result.problem, message: result.message };
      }
      const base: DrawingState = { ...result.state, entities: state.entities };
      const target = layoutsOf(base).find((l) => l.name === lay.name) ?? lay;
      return { state: withLayout(base, applyPaperEntities(target, result.state.entities)) };
    }
  }
  return refuse(state, 'insert-not-found', `No entity with id '${insertId}'.`);
}

/** The edit against ONE entity list (the state's own, or a paper-space
 *  projection of it): every check and refusal of the public contract. */
function setDynamicParameterInList(
  state: DrawingState,
  insertId: string,
  parameterId: string,
  value: DynamicParameterEditValue,
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
  const tagged = taggedEditValue(param, value);
  if (tagged === undefined) {
    // The raw value's shape does not match the parameter's kind (including
    // any edit at all on an opaque parameter, whose descriptor names the
    // unmodeled source kind).
    const descriptor = param.kind === 'opaque-parameter' ? `unmodeled '${param.sourceKind}'` : `'${param.kind}'`;
    return refuse(
      state,
      'wrong-value-kind',
      `Parameter '${parameterId}' is an ${descriptor} parameter and cannot take a ${value === null ? 'null' : typeof value} value.`,
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

  const stored = ins.dynamic?.values ?? {};
  const values: Record<string, DynamicParameterValue> = { ...stored, [parameterId]: tagged };

  // §2.7 rule 2: a direct edit of a parameter covered by the ACTIVE lookup
  // row clears the row choice in the same edit. Editing the lookup
  // parameter itself is a row choice (rule 1), never a clearing.
  const lookup = definition.parameters.find((p): p is LookupParameter => p.kind === 'lookup');
  if (lookup && parameterId !== lookup.id) {
    const storedChoice = stored[lookup.id];
    const activeRowName = storedChoice !== undefined
      ? (storedChoice.kind === 'lookup' ? storedChoice.value : undefined)
      : lookup.defaultRow;
    const activeRow = activeRowName ? lookup.rows.find((r) => r.name === activeRowName) : undefined;
    if (activeRow && (lookup.inputs.includes(parameterId) || parameterId in activeRow.assignments)) {
      values[lookup.id] = { kind: 'lookup', value: null };
    }
  }

  if (storedValuesEqual(values, stored)) {
    return refuse(state, 'no-change', `Parameter '${parameterId}' already has the value ${String(value)}.`);
  }

  const candidate: DynamicInstanceState = { block: ins.block, values };
  // Validate the whole resulting instance: pre-existing invalid stored values
  // block the edit too, exactly as they block evaluation.
  const validation = validateInstanceValues(definition, candidate, ins.block);
  if (!validation.ok) {
    const first = validation.issues[0]!;
    return refuse(state, first.code, first.message);
  }

  // Dry-run the evaluation with the PROPOSED values before committing
  // them (review R06). Per-value validation cannot see that a value trips
  // the evaluator's work/output limits (a huge array count), computes a
  // degenerate transform (a scale factor of zero), or that the
  // definition's evaluation is unsupported — yet committing such an edit
  // left the document displaying silent authored-geometry fallback with
  // the bad values stored. A refused dry run refuses the edit with the
  // evaluator's own code and the input state untouched, so geometry,
  // parameters, revision, dirty state and undo history all stay as they
  // were. The dry run re-validates the definition and instance itself,
  // so its refusal vocabulary is exactly the display path's.
  const evaluation = evaluateDynamicBlock(definition, block.entities, block.attributes, candidate);
  if (!evaluation.ok) {
    return refuse(
      state,
      evaluation.refusal.code,
      `Evaluating block '${ins.block}' with the proposed value fails (${evaluation.refusal.code}): ${evaluation.refusal.message}`,
    );
  }

  // The dry run validates the candidate VALUES, but the insert's
  // stored placements are points the evaluator never receives, and a
  // placement whose true image under the candidate state's transform
  // lies outside the finite range would otherwise commit here and
  // only fail at the next expansion — a renderer error after the edit
  // was accepted is not an atomic refusal (round 7, R6-01). So when
  // the insert carries placements, compose them once against the
  // candidate state's evaluated definition — exactly the composition
  // the display path performs — and refuse with the evaluator's
  // 'degenerate-transform' code, the input state untouched, when that
  // composition raises its explicit non-finite refusal. Any other
  // error is not this refusal and propagates unchanged.
  if (ins.attributePlacements) {
    const candidateInsert: InsertEntity = { ...ins, dynamic: candidate };
    const effective = expansionBlock(block, candidateInsert);
    if (effective !== block) {
      try {
        attributePlacementsForDef(candidateInsert, block, effective);
      } catch (error) {
        if (error instanceof Error && /non-finite|finite range/i.test(error.message)) {
          return refuse(
            state,
            'degenerate-transform',
            `Evaluating block '${ins.block}' with the proposed value places an attribute outside the finite range (degenerate-transform): ${error.message}`,
          );
        }
        throw error;
      }
    }
  }

  const nextInsert: InsertEntity = { ...ins, dynamic: candidate };
  return {
    state: { ...state, entities: state.entities.map((e) => (e.id === insertId ? nextInsert : e)) },
  };
}
