/**
 * P17 — associative hatch boundary associations (PROPOSAL-P17).
 *
 * Pure adapter in the src/core/constraints/apply.ts precedent: no
 * transaction, no I/O, no editor state. `src/core/document.ts` calls the
 * helpers below inside the SAME transact as the boundary edit, so a
 * boundary change and the fill refresh are one undo step; the DXF codec
 * resolves/emits the modelled refs (HatchLoop.boundaryRefs).
 *
 * Slice-1 supported boundaries: a loop with exactly ONE source object
 * that is a closed polyline or a circle. Multi-object loops (stitched
 * edges) and other boundary types are RETAINED and reported, never
 * silently flattened or detached. Refresh is atomic per hatch: any
 * problem leaves the hatch untouched and is reported in the result.
 */
import type { Entity, HatchEntity } from './entities';
import type { HatchLoop } from './hatch';
import * as g from './geometry';

/** Hard caps: association work per refresh stays bounded (geometry-budget discipline). */
export const MAX_HATCH_ASSOC_REFS_PER_LOOP = 64;
export const MAX_HATCH_ASSOC_BOUNDARY_POINTS = 100_000;

export type HatchAssocProblemKind = 'cycle' | 'missing-boundary' | 'unsupported-boundary' | 'work-limit';

export interface HatchAssocProblem {
  readonly kind: HatchAssocProblemKind;
  readonly hatchId: string;
  readonly loopIndex: number;
  readonly message: string;
}

export interface HatchRefreshResult {
  readonly hatch: HatchEntity;
  readonly problems: readonly HatchAssocProblem[];
}

/** The loop a single boundary entity contributes, or null when it cannot bound a hatch. */
export function loopFromBoundaryEntity(e: Entity): HatchLoop | null {
  switch (e.type) {
    case 'polyline': {
      const n = e.points.length;
      const closed = e.closed || (n > 2 && g.eq(e.points[0]!, e.points[n - 1]!));
      if (!closed || n < 2) return null;
      const pts = e.closed ? [...e.points] : e.points.slice(0, -1);
      if (pts.length < 2) return null;
      const bulges = e.bulges ? e.bulges.slice(0, pts.length) : undefined;
      return { points: pts, ...(bulges && bulges.some((b) => Math.abs(b) > 1e-12) ? { bulges } : {}) };
    }
    case 'circle':
      return { points: [g.add(e.center, { x: e.radius, y: 0 }), g.sub(e.center, { x: e.radius, y: 0 })], bulges: [1, 1] };
    default:
      return null;
  }
}

const problem = (kind: HatchAssocProblemKind, hatch: HatchEntity, loopIndex: number, message: string): HatchAssocProblem =>
  ({ kind, hatchId: hatch.id, loopIndex, message });

/**
 * Recompute every associated loop of `hatch` from the current boundary
 * entities in `byId`. Returns the original object when nothing changes
 * or when any loop has a problem (atomic per hatch); problems are
 * reported either way.
 */
export function refreshAssociativeHatch(hatch: HatchEntity, byId: ReadonlyMap<string, Entity>): HatchRefreshResult {
  // Round 4 hard guard: an explicitly disassociated hatch is never
  // refreshed, even if a loop still carries refs (inert retained data).
  if (hatch.associative === false) return { hatch, problems: [] };
  const problems: HatchAssocProblem[] = [];
  const loops: HatchLoop[] = [];
  let changed = false;
  let work = 0;
  hatch.loops.forEach((loop, loopIndex) => {
    const refs = loop.boundaryRefs;
    if (!refs || refs.length === 0) {
      loops.push(loop);
      return;
    }
    if (refs.length > MAX_HATCH_ASSOC_REFS_PER_LOOP) {
      problems.push(problem('work-limit', hatch, loopIndex,
        `associative hatch loop has ${refs.length} boundary references, over the ${MAX_HATCH_ASSOC_REFS_PER_LOOP} limit; the loop is not refreshed`));
      loops.push(loop);
      return;
    }
    const unique = [...new Set(refs)];
    if (unique.includes(hatch.id)) {
      problems.push(problem('cycle', hatch, loopIndex,
        'associative hatch loop references the hatch itself; the association is cyclic and is not refreshed'));
      loops.push(loop);
      return;
    }
    if (unique.length !== 1) {
      problems.push(problem('unsupported-boundary', hatch, loopIndex,
        `unsupported associative hatch boundary: loop has ${unique.length} source objects; stitched multi-object loops are retained but not refreshed in this slice`));
      loops.push(loop);
      return;
    }
    const boundary = byId.get(unique[0]!);
    if (!boundary) {
      problems.push(problem('missing-boundary', hatch, loopIndex,
        `associative hatch boundary ${unique[0]} is missing; the loop keeps its last geometry (detach happens on the erase path)`));
      loops.push(loop);
      return;
    }
    if (boundary.type === 'hatch') {
      problems.push(problem('cycle', hatch, loopIndex,
        'associative hatch boundary is another hatch; cyclic associations are not refreshed'));
      loops.push(loop);
      return;
    }
    const derived = loopFromBoundaryEntity(boundary);
    if (!derived) {
      problems.push(problem('unsupported-boundary', hatch, loopIndex,
        `unsupported associative hatch boundary: ${boundary.type} does not provide a closed boundary loop in this slice`));
      loops.push(loop);
      return;
    }
    work += derived.points.length;
    if (work > MAX_HATCH_ASSOC_BOUNDARY_POINTS) {
      problems.push(problem('work-limit', hatch, loopIndex,
        `associative hatch refresh would process over ${MAX_HATCH_ASSOC_BOUNDARY_POINTS} boundary points; the hatch is not refreshed`));
      loops.push(loop);
      return;
    }
    const next: HatchLoop = {
      ...derived,
      boundaryRefs: loop.boundaryRefs,
      ...(loop.boundaryHandles ? { boundaryHandles: loop.boundaryHandles } : {}),
    };
    if (next.points.length !== loop.points.length || next.points.some((p, i) => !g.eq(p, loop.points[i]!))
      || (next.bulges ?? []).join(',') !== (loop.bulges ?? []).join(',')) changed = true;
    loops.push(next);
  });
  if (problems.length > 0 || !changed) return { hatch, problems };
  return { hatch: { ...hatch, loops }, problems };
}

/** The first association problem for a hatch, as a short message (undefined = refreshable). */
export function hatchAssocProblem(hatch: HatchEntity, byId: ReadonlyMap<string, Entity>): string | undefined {
  return refreshAssociativeHatch(hatch, byId).problems[0]?.message;
}

/** True when any loop of any non-disassociated hatch in the list carries live boundary refs. */
export function hasHatchAssociations(entities: readonly Entity[]): boolean {
  return entities.some((e) => e.type === 'hatch' && e.associative !== false && e.loops.some((l) => l.boundaryRefs && l.boundaryRefs.length > 0));
}

/**
 * After boundary replacements have been applied to `entities` (the
 * post-edit list), return the hatches whose fills must change in the
 * same step. Hatches with problems are left untouched (atomic).
 */
export function hatchUpdatesForBoundaryEdits(entities: readonly Entity[], changedIds: ReadonlySet<string>): HatchEntity[] {
  if (changedIds.size === 0 || !hasHatchAssociations(entities)) return [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const updates: HatchEntity[] = [];
  for (const e of entities) {
    if (e.type !== 'hatch' || e.associative === false) continue;
    if (!e.loops.some((l) => l.boundaryRefs?.some((r) => changedIds.has(r)))) continue;
    const { hatch, problems } = refreshAssociativeHatch(e, byId);
    if (problems.length === 0 && hatch !== e) updates.push(hatch);
  }
  return updates;
}

const omitRefs = (loop: HatchLoop): HatchLoop => {
  const { boundaryRefs: _refs, ...rest } = loop;
  return rest;
};

const withAssociative = (hatch: HatchEntity, loops: readonly HatchLoop[]): HatchEntity => {
  const { associative: _a, ...rest } = hatch;
  // Round 4 hard guard: never resurrect a disassociated hatch — a hatch
  // pinned associative === false stays false even when loops retain refs.
  const any = hatch.associative !== false && loops.some((l) => l.boundaryRefs && l.boundaryRefs.length > 0);
  return { ...rest, loops, ...(any ? { associative: true } : hatch.associative === false ? { associative: false } : {}) };
};

/**
 * Erase path: loops that referenced an erased entity keep their last
 * geometry and lose the reference (the erase and the detach are one
 * undo step). Untouched entities keep their object identity.
 */
export function detachErasedBoundaries(entities: readonly Entity[], erasedIds: ReadonlySet<string>): Entity[] {
  if (erasedIds.size === 0 || !hasHatchAssociations(entities)) return [...entities];
  return entities.map((e) => {
    if (e.type !== 'hatch' || e.associative === false) return e;
    let touched = false;
    const loops = e.loops.map((loop) => {
      if (!loop.boundaryRefs?.some((r) => erasedIds.has(r))) return loop;
      touched = true;
      const kept = loop.boundaryRefs.filter((r) => !erasedIds.has(r));
      return kept.length > 0 ? { ...loop, boundaryRefs: kept } : omitRefs(loop);
    });
    return touched ? withAssociative(e, loops) : e;
  });
}

/** Copy path: rewrite refs through a clone batch's entityIds map; unmapped refs are kept. */
export function remapHatchBoundaryRefs(entities: readonly Entity[], idMap: ReadonlyMap<string, string>): Entity[] {
  if (idMap.size === 0) return [...entities];
  return entities.map((e) => {
    if (e.type !== 'hatch' || e.associative === false) return e;
    let touched = false;
    const loops = e.loops.map((loop) => {
      if (!loop.boundaryRefs?.some((r) => idMap.has(r))) return loop;
      touched = true;
      return { ...loop, boundaryRefs: loop.boundaryRefs.map((r) => idMap.get(r) ?? r) };
    });
    return touched ? { ...e, loops } : e;
  });
}
