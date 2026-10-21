/**
 * Priority 30 review §3 — the geometry-edit constraint policy, enforced at
 * the document commit choke point (Drawing.commitTransition, through which
 * EVERY transact / transactDrawing funnels). This module is the policy
 * itself: pure, total over (previous, candidate) state pairs, and free of
 * editor imports — Drawing calls it before the candidate is prepared, so a
 * refusal leaves the document bit-unchanged (no history entry, no dirty
 * flag, no revision bump), exactly like the cad-graph / geometry-budget
 * refusals that already throw out of the same path.
 *
 * The policy (only when the candidate carries a modeled constraint set
 * with at least one ACTIVE — non-suppressed — constraint):
 *
 *  (a) Referenced-entity deletion is refused atomically. If an entity an
 *      active constraint references is absent from the candidate, the
 *      whole transition is refused with ConstraintPolicyError naming the
 *      constraint(s). The supported way to remove such an entity is to
 *      delete or suppress the constraint first (CONDELETE), or to drop
 *      the set and the entity in the same transition.
 *  (b) A geometry edit touching a referenced entity re-solves in the
 *      SAME transition. If any entity an active (or reference) constraint
 *      references changed object identity, the candidate geometry is
 *      solved against the candidate set: solver failure refuses the whole
 *      edit (ConstraintPolicyError carrying the solver's §5.7 code); on
 *      success the solved entities are what gets committed — the edit
 *      and its re-solve are one undo step, never two, never an edit
 *      committed unsolved.
 *
 *      The edit is authoritative within that re-solve: entities the
 *      transition changed are held at their candidate positions by
 *      temporary pin constraints (added for the solve only, never
 *      stored), so constraints move only what the edit did not touch —
 *      a dragged coincident endpoint pulls its partner along instead of
 *      meeting it halfway, and an edit that cannot be honoured (a
 *      driving dimension the edited position violates) refuses rather
 *      than silently dragging the edited entity back.
 *
 *      A `fixed` constraint needs one pre-check of its own: the solver
 *      captures a fixed anchor's position at solve entry (design §5.4),
 *      so a bare re-solve would silently re-base a fix onto the edited
 *      position. The policy therefore refuses any transition that moves
 *      an active fixed constraint's anchor away from its position in the
 *      previous state — unfix it first (CONDELETE), then edit.
 *
 * Coverage boundary — stated, not implied:
 *  - Enforced on transact / transactDrawing (and therefore on every
 *    convenience mutation built on them: addEntities, removeEntities,
 *    replaceEntities, updateModel3D, and every edit tool).
 *  - NOT enforced on load(), undo() / redo() or restoreHistory(): those
 *    restore states that were valid when committed. A state built
 *    outside a transaction (constructor, load) is the caller's
 *    responsibility, as with every other document invariant.
 *  - Set changes are NOT policed here: installing a constraint set is
 *    the pure adapter's contract (src/core/constraints/apply.ts solves
 *    before install). The policy guards entity edits against the set the
 *    candidate carries; when the candidate was produced by the adapter,
 *    the re-solve in (b) is a consistency check that returns the
 *    candidate untouched (solved geometry re-solves to itself).
 *  - Constraints reference MODEL-space entities (DrawingState.entities)
 *    only. Paper-space entity lists live inside layouts and are outside
 *    the constraint system entirely; the constraint commands refuse to
 *    run outside the Model tab.
 *  - A drawing whose constraint payload is retained unmodeled
 *    (constraintsRetained) is exempt: its modeled set is unknown, the
 *    adapter already refuses all constraint operations on it, and entity
 *    edits cannot be checked against a set that does not exist here.
 *  - Suppressed constraints do not trigger the policy (they are excluded
 *    from solving and DOF accounting, design §2.2); deleting an entity
 *    referenced only by suppressed constraints is allowed and leaves the
 *    stored ref dangling — a reported state (missing-reference), per §4's
 *    orphan rule, not silent corruption.
 */
import type { DrawingState } from '../document';
import type { Entity } from '../entities';
import { anchorKey, resolveAnchorPoint, type AnchorRef, type Constraint, type ConstraintSet } from './model';
import { solveConstraints, type SolveFailureCode } from './solve';

/** Refusal codes surfaced by the policy: the guards' own codes, or the
 *  solver's §5.7 code when the re-solve is what failed. */
export type ConstraintPolicyCode = 'referenced-entity-missing' | 'fixed-anchor-moved' | SolveFailureCode;

/**
 * A deliberate edit refusal, thrown out of Drawing's commit path. The
 * editor reports it at human input boundaries the same way it reports
 * GeometryBudgetError / CadGraphError ("Edit canceled: …"); API callers
 * see the throw. `constraintIds` names the constraints responsible.
 */
export class ConstraintPolicyError extends Error {
  readonly code: ConstraintPolicyCode;
  readonly constraintIds: readonly string[];

  constructor(code: ConstraintPolicyCode, constraintIds: readonly string[], message: string) {
    super(message);
    this.name = 'ConstraintPolicyError';
    this.code = code;
    this.constraintIds = constraintIds;
  }
}

const quoted = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ');

/**
 * Apply the policy to a candidate transition. Returns the state to commit
 * (the candidate itself, or the candidate with re-solved entities) and
 * throws ConstraintPolicyError on refusal.
 */
export function enforceConstraintPolicy(previous: DrawingState, candidate: DrawingState): DrawingState {
  if (candidate === previous) return candidate;
  const set = candidate.constraints;
  if (!set || set.constraints.length === 0) return candidate;
  if (candidate.constraintsRetained !== undefined) return candidate;

  // Active constraints drive the deletion guard; the re-solve trigger
  // also counts reference constraints (they cannot fail a solve, but an
  // edit under one still goes through the same one-step path).
  const live = set.constraints.filter((c) => !c.suppressed);
  if (live.length === 0) return candidate;
  const referencedBy = new Map<string, Constraint[]>();
  for (const c of live) {
    for (const ref of c.refs) {
      const list = referencedBy.get(ref.entityId);
      if (list) list.push(c);
      else referencedBy.set(ref.entityId, [c]);
    }
  }
  if (referencedBy.size === 0) return candidate;

  const prevById = new Map(previous.entities.map((e) => [e.id, e] as const));
  const candById = new Map(candidate.entities.map((e) => [e.id, e] as const));

  // (a) A referenced entity must still exist.
  for (const [entityId, constraints] of referencedBy) {
    if (candById.has(entityId)) continue;
    const ids = [...new Set(constraints.map((c) => c.id))];
    throw new ConstraintPolicyError(
      'referenced-entity-missing',
      ids,
      prevById.has(entityId)
        ? `Deleting entity '${entityId}' is refused: it is referenced by active constraint ${quoted(ids)}. Delete or suppress the constraint first.`
        : `Constraint ${quoted(ids)} references entity '${entityId}', which is not in the drawing.`,
    );
  }

  // (b0) A fixed anchor must not move (see the header: the solver would
  // re-base the fix onto the edited position, so the guard lives here).
  for (const c of live) {
    if (c.kind !== 'fixed') continue;
    const ref = c.refs[0]!;
    const prevEntity = prevById.get(ref.entityId);
    const candEntity = candById.get(ref.entityId);
    if (!prevEntity || !candEntity) continue; // missing refs are (a)'s case / validation's
    let before: { x: number; y: number };
    let after: { x: number; y: number };
    try {
      before = resolveAnchorPoint(prevEntity, ref);
      after = resolveAnchorPoint(candEntity, ref);
    } catch {
      continue; // a non-point anchor on a fixed constraint is validation's refusal, not this guard's
    }
    if (Math.hypot(after.x - before.x, after.y - before.y) > 1e-9) {
      throw new ConstraintPolicyError(
        'fixed-anchor-moved',
        [c.id],
        `Edit refused: constraint '${c.id}' fixes the ${ref.anchor} of entity '${ref.entityId}', and the edit moves it. Delete the fixed constraint first.`,
      );
    }
  }

  // (b) A referenced entity changed: re-solve the candidate in-step,
  // with the edited entities pinned at their candidate positions.
  const changed: Entity[] = [];
  for (const entityId of referencedBy.keys()) {
    const cand = candById.get(entityId)!;
    if (prevById.get(entityId) !== cand) changed.push(cand);
  }
  if (changed.length === 0) return candidate;

  const augmented = withTemporaryPins(candidate.entities, set, changed);
  const result = solveConstraints(candidate.entities, augmented);
  if (!result.ok) {
    const code: ConstraintPolicyCode =
      result.failure?.code ?? (result.problems && result.problems.length > 0 ? 'validation-failed' : 'numeric-failure');
    const ids = (result.failure?.constraintIds ?? []).filter((id) => !id.startsWith(PIN_ID_PREFIX));
    const detail = result.failure?.message ?? result.problems?.[0]?.message ?? 'the constraint set does not solve';
    throw new ConstraintPolicyError(
      code,
      ids,
      `Edit refused: the change cannot be satisfied by the drawing's constraints (${code}${ids.length > 0 ? `, constraint ${quoted(ids)}` : ''}): ${detail}`,
    );
  }
  const solved = result.entities!;
  if (solved.length === candidate.entities.length && solved.every((e, i) => e === candidate.entities[i])) {
    return candidate; // already solved (e.g. an adapter-produced state)
  }
  return { ...candidate, entities: solved };
}

// ---------------------------------------------------------------------------
// Temporary pins: hold the entities an edit changed at their candidate
// positions for the duration of the policy re-solve. Pins are ordinary
// constraints in an augmented set that exists only for this call — they
// are never stored, never persisted and never reported.
// ---------------------------------------------------------------------------

const PIN_ID_PREFIX = '~policy-pin~';

const signatureOf = (entityById: ReadonlyMap<string, Entity>, c: Constraint): string =>
  [
    c.kind,
    c.refs.map((r) => anchorKey(entityById.get(r.entityId)!, r)).sort().join(','),
    c.value === undefined ? '' : String(c.value),
    c.distanceMode ?? '',
  ].join('|');

/** The point anchors that pin an entity's full DOF at its current shape
 *  (a circle's radius is pinned by a temporary driving radius instead —
 *  `fixed` is a point constraint and cannot hold it). */
function pinRefs(e: Entity): { refs: AnchorRef[]; radius?: number } {
  const at = (anchor: AnchorRef['anchor'], index?: number): AnchorRef => ({ entityId: e.id, anchor, ...(index !== undefined ? { index } : {}) });
  switch (e.type) {
    case 'line':
      return { refs: [at('start'), at('end')] };
    case 'point':
      return { refs: [at('position')] };
    case 'circle':
      return { refs: [at('center')], radius: e.radius };
    case 'arc':
      return { refs: [at('start'), at('end'), at('center')] };
    case 'polyline':
      return { refs: e.points.map((_, i) => at('vertex', i)) };
    default:
      return { refs: [] };
  }
}

function withTemporaryPins(entities: readonly Entity[], set: ConstraintSet, changed: readonly Entity[]): ConstraintSet {
  const entityById = new Map(entities.map((e) => [e.id, e] as const));
  const taken = new Set(set.constraints.map((c) => signatureOf(entityById, c)));
  const usedIds = new Set(set.constraints.map((c) => c.id));
  const pins: Constraint[] = [];
  let n = 0;
  const freshId = (): string => {
    let id = `${PIN_ID_PREFIX}${n}`;
    while (usedIds.has(id)) {
      n += 1;
      id = `${PIN_ID_PREFIX}${n}`;
    }
    usedIds.add(id);
    n += 1;
    return id;
  };
  const addPin = (pin: Constraint): void => {
    const sig = signatureOf(entityById, pin);
    if (taken.has(sig)) return; // an identical real constraint already holds this anchor
    taken.add(sig);
    pins.push(pin);
  };
  for (const e of changed) {
    const { refs, radius } = pinRefs(e);
    for (const ref of refs) addPin({ id: freshId(), kind: 'fixed', role: 'driving', refs: [ref] });
    if (radius !== undefined && radius > 0) {
      addPin({ id: freshId(), kind: 'radius', role: 'driving', value: radius, refs: [{ entityId: e.id, anchor: 'whole' }] });
    }
  }
  return pins.length === 0 ? set : { constraints: [...set.constraints, ...pins] };
}
