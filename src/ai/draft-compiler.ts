import {
  rotateEntity,
  translateEntity,
  type CircleEntity,
  type Entity,
  type LineEntity,
  type PolylineEntity,
} from '../core/entities';
import { unionBounds, type Bounds, type Point } from '../core/geometry';
import { formatLength } from '../core/units';
import type { AiPlan, AiPlanOperation } from './draft-plan';
import type { AiDraftCapture } from './draft-context';
import { draftLayerProblem, draftTargetEligibility, cadAnchoredEntityIds } from './draft-eligibility';

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

/** Preview sets derived from the compiled artifact (never from the document). */
export function previewSets(proposal: CompiledProposal): {
  added: Entity[];
  modifiedAfter: Entity[];
  originals: Entity[];
  deleted: Entity[];
} {
  return {
    added: [...proposal.created, ...proposal.copies.map((c) => c.entity)],
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
  const state = capture.state;
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  const eligible = new Set(capture.eligibleIds);
  const anchored = cadAnchoredEntityIds(state);
  const units = capture.units;
  const len = (v: number): string => formatLength(v, units);
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

  for (const op of plan.operations) {
    switch (op.op) {
      case 'createLine': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = draftLayerProblem(state, layer);
        if (problem) return fail(`Cannot create the line: ${problem}.`);
        const entity: LineEntity = { id: mintId(), type: 'line', layer, a: op.a, b: op.b, ...appearance };
        created.push(entity);
        const length = Math.hypot(op.b.x - op.a.x, op.b.y - op.a.y);
        changes.push({ kind: 'create', op: op.op, summary: `Create line ${pt(op.a)} → ${pt(op.b)} on layer ${layer} (length ${len(length)})`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'createCircle': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = draftLayerProblem(state, layer);
        if (problem) return fail(`Cannot create the circle: ${problem}.`);
        const entity: CircleEntity = { id: mintId(), type: 'circle', layer, center: op.center, radius: op.radius, ...appearance };
        created.push(entity);
        changes.push({ kind: 'create', op: op.op, summary: `Create circle at ${pt(op.center)}, radius ${len(op.radius)}, on layer ${layer}`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'createRectangle': {
        const layer = op.layer ?? capture.defaults.layer;
        const problem = draftLayerProblem(state, layer);
        if (problem) return fail(`Cannot create the rectangle: ${problem}.`);
        const theta = ((op.rotationDeg ?? 0) * Math.PI) / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const corner = (dx: number, dy: number): Point => ({
          x: op.origin.x + dx * cos - dy * sin,
          y: op.origin.y + dx * sin + dy * cos,
        });
        const points = [corner(0, 0), corner(op.width, 0), corner(op.width, op.height), corner(0, op.height)];
        const entity: PolylineEntity = { id: mintId(), type: 'polyline', layer, points, closed: true, ...appearance };
        created.push(entity);
        changes.push({ kind: 'create', op: op.op, summary: `Create rectangle ${len(op.width)} × ${len(op.height)} at ${pt(op.origin)}${op.rotationDeg ? `, rotated ${op.rotationDeg}°` : ''} on layer ${layer} (closed polyline, 4 vertices)`, targetIds: [], createdIds: [entity.id], layer });
        break;
      }
      case 'move':
      case 'copy': {
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          const after = translateEntity(found, { x: op.dx, y: op.dy });
          if (op.op === 'move') {
            modified.push({ id, before: found, after });
          } else {
            const entity: Entity = { ...after, id: mintId() };
            copies.push({ sourceId: id, entity });
          }
        }
        if (op.op === 'move') {
          changes.push({ kind: 'modify', op: op.op, summary: `Move ${op.targetIds.length} object(s) by (${len(op.dx)}, ${len(op.dy)}): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: '' });
        } else {
          changes.push({ kind: 'copy', op: op.op, summary: `Copy ${op.targetIds.length} object(s) by (${len(op.dx)}, ${len(op.dy)}): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: copies.slice(-op.targetIds.length).map((c) => c.entity.id), layer: '' });
        }
        break;
      }
      case 'rotate': {
        const radians = (op.angleDeg * Math.PI) / 180;
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          modified.push({ id, before: found, after: rotateEntity(found, op.pivot, radians) });
        }
        changes.push({ kind: 'modify', op: op.op, summary: `Rotate ${op.targetIds.length} object(s) by ${op.angleDeg}° about ${pt(op.pivot)}: ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: '' });
        break;
      }
      case 'delete': {
        for (const id of op.targetIds) {
          const found = targetEntity(id);
          if ('error' in found) return fail(found.error);
          deleted.push({ id, before: found });
        }
        changes.push({ kind: 'delete', op: op.op, summary: `Delete ${op.targetIds.length} object(s): ${op.targetIds.join(', ')}`, targetIds: op.targetIds, createdIds: [], layer: '' });
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
    bounds = unionBounds(bounds, boundsFor(entity));
  };
  for (const entity of created) extend(entity);
  for (const copy of copies) extend(copy.entity);
  for (const m of modified) { extend(m.before); extend(m.after); }
  for (const d of deleted) extend(d.before);

  return {
    ok: true,
    proposal: {
      plan,
      created,
      copies,
      modified,
      deleted,
      candidateEntities,
      changes,
      bounds,
      counts: { created: created.length, copied: copies.length, modified: modified.length, deleted: deleted.length },
    },
  };
}
