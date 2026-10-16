import {
  rotateEntity,
  translateEntity,
  type CircleEntity,
  type Entity,
  type LineEntity,
  type PolylineEntity,
} from '../core/entities';
import { unionBounds, type Bounds, type Point } from '../core/geometry';
import { prepareDrawingTransition, type DrawingState } from '../core/document';
import { sealImmutableData } from '../core/immutable-data';
import { validateAiDraftResponse } from './draft-plan';
import { planOperationLabels, type AiPlan, type AiPlanOperation } from './draft-plan';
import type { AiDraftCapture } from './draft-context';
import { draftLayerProblem, draftTargetEligibility, cadAnchoredEntityIds } from './draft-eligibility';
import { AI_DRAFT_MAX_COORDINATE } from './limits';

/**
 * The deterministic proposal compiler (docs/AI-ASSISTANT-M3.md). A pure
 * function of the validated plan and the captured drawing state: it
 * transforms the ORIGINAL entities with JCad's own pure helpers (so every
 * unrelated property is preserved by construction), mints creation ids
 * locally through the injected factory, and produces the single compiled
 * artifact that preview renders and Apply commits — same geometry, same ids.
 */

export interface AiChangeEntry {
  readonly kind: 'create' | 'modify' | 'copy' | 'delete';
  readonly op: AiPlanOperation['op'];
  /** Proposal-reference label ("Rectangle 1", "Circle 2") — display only, never an object id. */
  readonly label: string;
  readonly summary: string;
  readonly targetIds: readonly string[];
  readonly createdIds: readonly string[];
  readonly layer: string;
}

export interface CompiledProposal {
  readonly plan: AiPlan;
  readonly created: readonly Entity[];
  readonly copies: readonly { readonly sourceId: string; readonly entity: Entity }[];
  readonly modified: readonly { readonly id: string; readonly before: Entity; readonly after: Entity }[];
  readonly deleted: readonly { readonly id: string; readonly before: Entity }[];
  /** The full model-space entity array after the plan — Apply commits exactly this. */
  readonly candidateEntities: readonly Entity[];
  readonly changes: readonly AiChangeEntry[];
  readonly bounds: Bounds | null;
  readonly counts: { readonly created: number; readonly copied: number; readonly modified: number; readonly deleted: number };
}

// Only this compiler can authorize a proposal. The public readonly view is not
// authority to forge a replacement entity array or apply it to another capture.
const preparedProposals = new WeakMap<CompiledProposal, { capture: AiDraftCapture; state: DrawingState; applicable: boolean }>();
export function compiledProposalState(capture: AiDraftCapture, proposal: CompiledProposal): DrawingState | null {
  const prepared = preparedProposals.get(proposal);
  return prepared?.capture === capture && prepared.applicable ? prepared.state : null;
}

/** A retained preview can still be refined while its Apply authority is suspended. */
export function isCompiledProposal(capture: AiDraftCapture, proposal: CompiledProposal): boolean {
  return preparedProposals.get(proposal)?.capture === capture;
}

/** Only the controller's fresh-checked follow-up discard restores applicability. */
export function setCompiledProposalApplicable(capture: AiDraftCapture, proposal: CompiledProposal, applicable: boolean): void {
  const prepared = preparedProposals.get(proposal);
  if (prepared?.capture === capture) prepared.applicable = applicable;
}

/** A discarded, superseded or consumed preview must never regain Apply authority. */
export function revokeCompiledProposal(proposal: CompiledProposal): void {
  preparedProposals.delete(proposal);
}

/** Preview sets derived from the compiled artifact (never from the document). */
export function previewSets(proposal: CompiledProposal): {
  added: Entity[];
  modifiedAfter: Entity[];
  originals: Entity[];
  deleted: Entity[];
} {
  return {
    added: [...proposal.copies.map((c) => c.entity), ...proposal.created],
    modifiedAfter: proposal.modified.map((m) => m.after),
    originals: [...proposal.modified.map((m) => m.before), ...proposal.deleted.map((d) => d.before)],
    deleted: proposal.deleted.map((d) => d.before),
  };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function compileAiPlan(
  plan: AiPlan,
  capture: AiDraftCapture,
  mintId: () => string,
  boundsFor: (entity: Entity) => Bounds | null,
): { ok: true; proposal: CompiledProposal } | { ok: false; error: string } {
  try {
    const parsed = validateAiDraftResponse({ kind: 'plan', plan });
    if (!parsed.ok) return parsed;
    if (parsed.response.kind !== 'plan') return fail('The proposal carried no plan.');
    return compileValidatedPlan(parsed.response.plan, capture, mintId, boundsFor);
  } catch {
    return fail('The proposal could not be compiled safely against this drawing.');
  }
}

function compileValidatedPlan(
  plan: AiPlan,
  capture: AiDraftCapture,
  mintId: () => string,
  boundsFor: (entity: Entity) => Bounds | null,
): { ok: true; proposal: CompiledProposal } | { ok: false; error: string } {
  const state = capture.state;
  if (state.space !== undefined) return fail('Draft / Edit works in the Model tab only.');
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  if (byId.size !== state.entities.length) return fail('The drawing has ambiguous object identities.');
  const occupied = new Set(byId.keys());
  for (const block of Object.values(state.blocks)) for (const e of block.entities) occupied.add(e.id);
  for (const layout of state.layouts ?? []) {
    for (const e of layout.entities) occupied.add(e.id);
    for (const viewport of layout.viewports) {
      occupied.add(viewport.id);
      if (viewport.clipBoundary) occupied.add(viewport.clipBoundary.id);
    }
  }
  for (const e of state.model3d?.solids ?? []) occupied.add(e.id);
  for (const e of state.model3d?.dimensions ?? []) occupied.add(e.id);
  for (const node of state.cadGraph?.nodes ?? []) {
    occupied.add(node.id);
    if (node.anchor && 'id' in node.anchor) occupied.add(node.anchor.id);
  }
  const nextId = (): string => {
    const id = mintId();
    if (typeof id !== 'string' || !id || id.length > 512 || occupied.has(id)) throw new Error('Invalid or duplicate generated object identity.');
    occupied.add(id);
    return id;
  };
  const eligible = new Set(capture.eligibleIds);
  const permittedLayers = new Set(capture.permittedLayers);
  const anchored = cadAnchoredEntityIds(state);
  // Shortest round-trip decimal text: a small nonzero edit must never be
  // described as zero by the drawing's display precision settings.
  const len = (v: number): string => String(v);
  const pt = (p: Point): string => `(${len(p.x)}, ${len(p.y)})`;

  const created: Entity[] = [];
  const copies: { sourceId: string; entity: Entity }[] = [];
  const modified: { id: string; before: Entity; after: Entity }[] = [];
  const deleted: { id: string; before: Entity }[] = [];
  const changes: AiChangeEntry[] = [];
  const appearance = {
    color: capture.defaults.color,
    ...(capture.defaults.linetype !== undefined ? { linetype: capture.defaults.linetype } : {}),
    ...(capture.defaults.lineWeight !== undefined ? { lineWeight: capture.defaults.lineWeight } : {}),
  };
  const creationLayerProblem = (layer: string): string | null => !permittedLayers.has(layer)
    ? `layer "${layer}" was not disclosed as a permitted creation destination`
    : draftLayerProblem(state, layer);
  const targetLayers = (ids: readonly string[]): string => [...new Set(ids.map((id) => byId.get(id)!.layer))].join(', ');

  const targetEntity = (id: string): Entity | { error: string } => {
    if (!eligible.has(id)) {
      return { error: `The proposal targeted object ${id}, which was not an eligible selected object.` };
    }
    const entity = byId.get(id);
    if (!entity) return { error: `The proposal targeted object ${id}, which no longer exists.` };
    const verdict = draftTargetEligibility(entity, state, anchored);
    if (!verdict.eligible) return { error: `Object ${id} is not editable: ${verdict.reason}.` };
    return entity;
  };

  const opLabels = planOperationLabels(plan);
  let opIndex = -1;
  for (const op of plan.operations) {
    opIndex += 1;
    const label = opLabels[opIndex]!;
    switch (op.op) {
      case 'createLine': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = creationLayerProblem(layer);
        if (problem) return fail(`Cannot create the line: ${problem}.`);
        const entity: LineEntity = { id: nextId(), type: 'line', layer, a: op.a, b: op.b, ...appearance };
        created.push(entity);
        const length = Math.hypot(op.b.x - op.a.x, op.b.y - op.a.y);
        changes.push({ kind: 'create', op: op.op, label, summary: `Create line ${pt(op.a)} → ${pt(op.b)} on layer ${layer} (length ${len(length)})`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'createCircle': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = creationLayerProblem(layer);
        if (problem) return fail(`Cannot create the circle: ${problem}.`);
        const entity: CircleEntity = { id: nextId(), type: 'circle', layer, center: op.center, radius: op.radius, ...appearance };
        created.push(entity);
        changes.push({ kind: 'create', op: op.op, label, summary: `Create circle at ${pt(op.center)}, radius ${len(op.radius)}, on layer ${layer}`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'createRectangle': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = creationLayerProblem(layer);
        if (problem) return fail(`Cannot create the rectangle: ${problem}.`);
        const theta = ((op.rotationDeg ?? 0) * Math.PI) / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const corner = (dx: number, dy: number): Point => ({
          x: op.origin.x + dx * cos - dy * sin,
          y: op.origin.y + dx * sin + dy * cos,
        });
        const points = [corner(0, 0), corner(op.width, 0), corner(op.width, op.height), corner(0, op.height)];
        const entity: PolylineEntity = { id: nextId(), type: 'polyline', layer, points, closed: true, ...appearance };
        created.push(entity);
        changes.push({ kind: 'create', op: op.op, label, summary: `Create rectangle ${len(op.width)} × ${len(op.height)} at ${pt(op.origin)}${op.rotationDeg ? `, rotated ${op.rotationDeg}°` : ''} on layer ${layer} (closed polyline, 4 vertices)`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'move':
      case 'copy': {
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          const after = translateEntity(found, { x: op.dx, y: op.dy });
          if (sameGeometry(found, after)) return fail(`The ${op.op} operation would not displace object ${id}.`);
          if (op.op === 'move') {
            modified.push({ id, before: found, after });
          } else {
            const entity: Entity = { ...after, id: nextId() };
            copies.push({ sourceId: id, entity });
          }
        }
        if (op.op === 'move') {
          changes.push({ kind: 'modify', op: op.op, label, summary: `Move ${op.targetIds.length} object(s) by (${len(op.dx)}, ${len(op.dy)}): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: targetLayers(op.targetIds) });
        } else {
          changes.push({ kind: 'copy', op: op.op, label, summary: `Copy ${op.targetIds.length} object(s) by (${len(op.dx)}, ${len(op.dy)}): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: copies.slice(-op.targetIds.length).map((c) => c.entity.id), layer: targetLayers(op.targetIds) });
        }
        break;
      }
      case 'rotate': {
        const radians = (op.angleDeg * Math.PI) / 180;
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          const after = rotateEntity(found, op.pivot, radians);
          if (sameGeometry(found, after)) return fail(`The rotation would not change object ${id}.`);
          modified.push({ id, before: found, after });
        }
        changes.push({ kind: 'modify', op: op.op, label, summary: `Rotate ${op.targetIds.length} object(s) by ${op.angleDeg}° about ${pt(op.pivot)}: ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: targetLayers(op.targetIds) });
        break;
      }
      case 'delete': {
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          deleted.push({ id, before: found });
        }
        changes.push({ kind: 'delete', op: op.op, label, summary: `Delete ${op.targetIds.length} object(s): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: targetLayers(op.targetIds) });
        break;
      }
    }
  }

  if (created.length === 0 && copies.length === 0 && modified.length === 0 && deleted.length === 0) {
    return fail('The proposal would not change the drawing.');
  }

  const deletedIds = new Set(deleted.map((d) => d.id));
  const modifiedById = new Map(modified.map((m) => [m.id, m.after]));
  const candidateEntities: Entity[] = [];
  for (const entity of state.entities) {
    if (deletedIds.has(entity.id)) continue;
    candidateEntities.push(modifiedById.get(entity.id) ?? entity);
  }
  for (const copy of copies) candidateEntities.push(copy.entity);
  for (const entity of created) candidateEntities.push(entity);

  let bounds: Bounds | null = null;
  const extend = (entity: Entity): void => {
    const box = boundsFor(entity);
    if (!box || ![box.min.x, box.min.y, box.max.x, box.max.y].every((v) => Number.isFinite(v) && Math.abs(v) <= AI_DRAFT_MAX_COORDINATE)
      || box.min.x > box.max.x || box.min.y > box.max.y) throw new Error('Compiled geometry exceeds the drawing bounds limit.');
    bounds = unionBounds(bounds, box);
  };
  for (const entity of created) extend(entity);
  for (const copy of copies) extend(copy.entity);
  for (const m of modified) { extend(m.before); extend(m.after); }
  for (const d of deleted) extend(d.before);

  // Complete graph/dependency and geometry preflight happens before staging.
  // Eligible edits must preserve every unrelated document field and entity.
  const candidate = { ...state, entities: candidateEntities };
  const prepared = prepareDrawingTransition(state, candidate);
  if (prepared !== candidate) return fail('The proposal requires unsupported CAD metadata changes.');
  const proposal: CompiledProposal = sealImmutableData({
      plan,
      created,
      copies,
      modified,
      deleted,
      candidateEntities,
      changes,
      bounds,
      counts: { created: created.length, copied: copies.length, modified: modified.length, deleted: deleted.length },
  });
  preparedProposals.set(proposal, { capture, state: prepared, applicable: true });
  return { ok: true, proposal };
}

function sameGeometry(a: Entity, b: Entity): boolean {
  if (a.type === 'line' && b.type === 'line') return a.a.x === b.a.x && a.a.y === b.a.y && a.b.x === b.b.x && a.b.y === b.b.y;
  if (a.type === 'circle' && b.type === 'circle') return a.center.x === b.center.x && a.center.y === b.center.y && a.radius === b.radius;
  if (a.type === 'polyline' && b.type === 'polyline') return a.points.length === b.points.length && a.points.every((p, i) => p.x === b.points[i]!.x && p.y === b.points[i]!.y);
  return false;
}
