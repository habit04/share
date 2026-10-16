import type { DrawingState } from '../core/document';
import type { Entity } from '../core/entities';
import { isWire } from '../electrical/ladder';
import { AI_DRAFT_MAX_VERTICES } from './limits';

/**
 * Draft/Edit target eligibility (docs/AI-ASSISTANT-M3.md). Composed from the
 * drawing's own rules, always evaluated on the ORIGINAL local entity — the
 * AI snapshot samples geometry and omits bulges/widths/cadIdentity, so it can
 * authorize a target set but can never prove an object editable.
 */

export type DraftEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

const OK: DraftEligibility = { eligible: true };
function no(reason: string): DraftEligibility {
  return { eligible: false, reason };
}

/** Entity ids targeted by a CAD graph anchor (retained CAD-backed data). */
export function cadAnchoredEntityIds(state: DrawingState): ReadonlySet<string> {
  const ids = new Set<string>();
  const graph = state.cadGraph;
  if (graph) {
    for (const node of graph.nodes) {
      if (node.anchor?.kind === 'entity') ids.add(node.anchor.id);
    }
  }
  return ids;
}

/** A layer a draft may create on or edit on: exists, visible, unlocked. */
export function draftLayerProblem(state: DrawingState, layerName: string): string | null {
  const layer = state.layers.find((l) => l.name === layerName);
  if (!layer) return `layer "${layerName}" does not exist`;
  if (layer.locked) return `layer "${layerName}" is locked`;
  if (!layer.visible || layer.frozen) return `layer "${layerName}" is hidden`;
  return null;
}

export function draftTargetEligibility(
  entity: Entity,
  state: DrawingState,
  anchored: ReadonlySet<string>,
): DraftEligibility {
  // Retained CAD-backed objects stay read-only; identity is never stripped.
  if (entity.cadIdentity !== undefined) return no('retained CAD object (read-only in Draft mode)');
  if (anchored.has(entity.id)) return no('anchored in the CAD graph (read-only in Draft mode)');
  switch (entity.type) {
    case 'line':
      break;
    case 'circle': {
      if (entity.filled === true) return no('filled circle (electrical junction dot)');
      break;
    }
    case 'polyline': {
      if (entity.filled === true) return no('filled polyline');
      if (entity.width !== undefined && entity.width !== 0) return no('variable/constant-width polyline');
      if (entity.widths !== undefined) return no('variable-width polyline');
      if (entity.widthFrame !== undefined) return no('width-framed polyline');
      if (entity.bulges?.some((b) => Math.abs(b) > 1e-12)) return no('curved polyline (arc segments)');
      if (entity.points.length > AI_DRAFT_MAX_VERTICES) return no('polyline exceeds the vertex limit');
      break;
    }
    default:
      return no(`unsupported object type "${entity.type}"`);
  }
  // Electrical exclusion: JCad's canonical wire rule, applied to every type —
  // a generic object on a WIRES-type layer is electrical content here.
  if (isWire(entity) || entity.layer.startsWith('WIRES')) return no('electrical wire content');
  const layerProblem = draftLayerProblem(state, entity.layer);
  if (layerProblem) return no(layerProblem);
  return OK;
}
