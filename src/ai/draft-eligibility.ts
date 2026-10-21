import type { DrawingState } from '../core/document';
import type { Entity, Layer } from '../core/entities';
import { isWire } from '../electrical/ladder';
import { isViewportFrame } from '../core/layouts';
import { isImmutableData } from '../core/immutable-data';
import { AI_DRAFT_MAX_COORDINATE, AI_DRAFT_MAX_DIMENSION, AI_DRAFT_MAX_VERTICES } from './limits';

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
const anchoredCache = new WeakMap<object, ReadonlySet<string>>();
export function cadAnchoredEntityIds(state: DrawingState): ReadonlySet<string> {
  const graph = state.cadGraph;
  const cached = graph && isImmutableData(graph) ? anchoredCache.get(graph) : undefined;
  if (cached) return cached;
  const ids = new Set<string>();
  if (graph) {
    for (const node of graph.nodes) {
      if (node.anchor?.kind === 'entity') ids.add(node.anchor.id);
    }
  }
  if (graph && isImmutableData(graph)) anchoredCache.set(graph, ids);
  return ids;
}

/** A layer a draft may create on or edit on: exists, visible, unlocked. */
const layerCache = new WeakMap<object, ReadonlyMap<string, Layer>>();
export function draftLayerProblem(state: DrawingState, layerName: string): string | null {
  let layers = isImmutableData(state.layers) ? layerCache.get(state.layers) : undefined;
  if (!layers) {
    const map = new Map<string, Layer>();
    for (const layer of state.layers) if (!map.has(layer.name)) map.set(layer.name, layer);
    layers = map;
    if (isImmutableData(state.layers)) layerCache.set(state.layers, layers);
  }
  const layer = layers.get(layerName);
  if (!layer) return `layer "${layerName}" does not exist`;
  if (layer.locked) return `layer "${layerName}" is locked`;
  if (!layer.visible || layer.frozen) return `layer "${layerName}" is hidden`;
  if (layerName.startsWith('WIRES')) return `layer "${layerName}" is electrical wire content`;
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
  if (isViewportFrame(entity)) return no('layout viewport frame');
  const pointOk = (p: { x: number; y: number }): boolean => Number.isFinite(p.x) && Number.isFinite(p.y)
    && Math.abs(p.x) <= AI_DRAFT_MAX_COORDINATE && Math.abs(p.y) <= AI_DRAFT_MAX_COORDINATE;
  switch (entity.type) {
    case 'line':
      if (!pointOk(entity.a) || !pointOk(entity.b) || (entity.a.x === entity.b.x && entity.a.y === entity.b.y)) return no('invalid line geometry');
      break;
    case 'circle': {
      if (entity.filled === true) return no('filled circle (electrical junction dot)');
      if (!pointOk(entity.center) || !Number.isFinite(entity.radius) || entity.radius <= 0 || entity.radius > AI_DRAFT_MAX_DIMENSION) return no('invalid or oversized circle geometry');
      break;
    }
    case 'polyline': {
      if (entity.points.length > AI_DRAFT_MAX_VERTICES || (entity.bulges?.length ?? 0) > AI_DRAFT_MAX_VERTICES) return no('polyline exceeds the vertex limit');
      if (entity.filled === true) return no('filled polyline');
      if (entity.width !== undefined && entity.width !== 0) return no('variable/constant-width polyline');
      if (entity.widths !== undefined) return no('variable-width polyline');
      if (entity.widthFrame !== undefined) return no('width-framed polyline');
      if (entity.bulges?.some((b) => b !== 0)) return no('curved polyline (arc segments)');
      if (entity.points.length < (entity.closed ? 3 : 2) || !entity.points.every(pointOk)) return no('invalid polyline geometry');
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
