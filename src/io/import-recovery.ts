/**
 * Partial opening for imports (see io/import-report.ts): when drawing acceptance rejects an
 * imported drawing only because individual block references expand past the geometry budget,
 * the offending references are excluded — and listed in the import report — so the rest of
 * the drawing can open. Failures no single reference explains stay fatal and are rethrown:
 * block definitions alone over the budget, overflow from plain (non-insert) geometry, work
 * that cannot even be computed for non-insert geometry, and 3D budget errors.
 *
 * The cost model mirrors core/geometry-budget.ts exactly (same per-definition cost recursion,
 * depth cap and caps), so a reference is excluded precisely when acceptance would reject it.
 */
import type { DrawingState } from '../core/document';
import type { Entity, InsertEntity } from '../core/entities';
import { entityGeometryWork, MAX_BLOCK_EXPANSION_WORK } from '../core/entities';
import { MAX_DRAWING_EXPANSION_WORK, validateGeometryBudget } from '../core/geometry-budget';
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { insertArrayCount } from '../core/insert-array';
import { CadGraphError, canonicalCadHandle, reconcileCadGraph, type CadNode } from '../core/cad-graph';
import { RAW_ENTITIES_META_KEY, rawEntitiesOf, type ImportReportItem } from './import-report';

/** Bounded: a drawing needing more exclusions than this is rejected as a whole. */
const MAX_RECOVERY_REMOVALS = 64;

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Expanded work of one block definition at a nesting depth (mirrors geometry-budget's cost). */
function blockCost(state: DrawingState): (name: string, depth: number) => number {
  const memo = new Map<string, Map<number, number>>();
  const cost = (name: string, depth: number): number => {
    const block = state.blocks[name];
    if (!block || depth > 8) return 0;
    const hit = memo.get(name)?.get(depth);
    if (hit !== undefined) return hit;
    let work = block.xref && !block.entities.length ? 2 : block.attributes.reduce((sum, attribute) => sum + 1 + attribute.default.length, 0);
    for (const entity of block.entities) {
      work += entityGeometryWork(entity) + (entity.type === 'insert' ? insertArrayCount(entity) * cost(entity.block, depth + 1) : 0);
      if (work > MAX_BLOCK_EXPANSION_WORK) break;
    }
    let depths = memo.get(name);
    if (!depths) { depths = new Map(); memo.set(name, depths); }
    depths.set(depth, work);
    return work;
  };
  return cost;
}

interface Candidate {
  readonly layoutIndex: number | null;
  readonly entityIndex: number;
  readonly entity: InsertEntity;
  readonly where: string;
  /** Expanded work of the reference; Infinity when it cannot even be computed. */
  readonly work: number;
  readonly problem?: string;
}

interface Analysis {
  /** The failure is not explained by any space-level reference (definitions, plain geometry, 3D). */
  readonly fatal: boolean;
  /** References whose expansion alone exceeds the per-reference limit. */
  readonly oversized: readonly Candidate[];
  /** The largest reference by expanded work (the one to drop when the whole drawing is over). */
  readonly largest: Candidate | null;
  /** Whole-drawing expanded work over every space, as acceptance computes it. */
  readonly total: number;
}

function analyze(state: DrawingState): Analysis {
  // Definitions first, exactly as acceptance: if they alone break the budget (or their work
  // cannot be computed), no space-level removal can help.
  let definitions = 0;
  try {
    for (const block of Object.values(state.blocks)) {
      for (const entity of block.entities) definitions += entityGeometryWork(entity);
      for (const attribute of block.attributes) definitions += 1 + attribute.default.length;
    }
  } catch {
    return { fatal: true, oversized: [], largest: null, total: 0 };
  }
  if (definitions > MAX_DRAWING_EXPANSION_WORK) return { fatal: true, oversized: [], largest: null, total: 0 };

  const cost = blockCost(state);
  const expanded = (entity: Entity): number => entityGeometryWork(entity) + (entity.type === 'insert' ? insertArrayCount(entity) * cost(entity.block, 0) : 0);
  const oversized: Candidate[] = [];
  let largest: Candidate | null = null;
  let total = 0;
  let fatal = false;

  const scan = (entities: readonly Entity[], layoutIndex: number | null, where: string, removable: boolean): void => {
    entities.forEach((entity, entityIndex) => {
      let work: number;
      try {
        work = expanded(entity);
      } catch (err) {
        // Work that cannot be computed for plain geometry fails acceptance on its own and is
        // not explained by any reference; for a reference, the reference itself is the problem.
        if (entity.type !== 'insert') { fatal = true; return; }
        work = Infinity;
        if (removable) {
          const candidate: Candidate = { layoutIndex, entityIndex, entity, where, work, problem: err instanceof Error ? err.message : String(err) };
          oversized.push(candidate);
          if (!largest || candidate.work > largest.work) largest = candidate;
        }
        return;
      }
      total += work;
      if (entity.type !== 'insert' || !removable) return;
      const candidate: Candidate = { layoutIndex, entityIndex, entity, where, work };
      if (work > MAX_BLOCK_EXPANSION_WORK) oversized.push(candidate);
      if (!largest || work > largest.work) largest = candidate;
    });
  };

  scan(state.entities, null, 'model space', true);
  (state.layouts ?? []).forEach((layout, layoutIndex) => {
    scan(layout.entities, layoutIndex, `layout "${layout.name}"`, true);
    // Viewport clip boundaries count toward the whole-drawing total in acceptance, but they
    // are not references a partial opening may drop.
    for (const viewport of layout.viewports) if (viewport.clipBoundary) scan([viewport.clipBoundary], layoutIndex, `layout "${layout.name}"`, false);
  });

  return { fatal, oversized, largest, total };
}

function withoutCandidate(state: DrawingState, pick: Candidate): DrawingState {
  const reduced = pick.layoutIndex === null ? { ...state, entities: state.entities.filter((_, i) => i !== pick.entityIndex) } : {
    ...state,
    layouts: (state.layouts ?? []).map((layout, i) => (i === pick.layoutIndex ? { ...layout, entities: layout.entities.filter((_, j) => j !== pick.entityIndex) } : layout)),
  };
  if (!state.cadGraph) return reduced;
  // Use the same atomic erase contract as an editor edit: owned ATTRIB/SEQEND and
  // extension records go with the INSERT, detachable edges are repaired, and a
  // hard incoming dependency refuses recovery instead of silently losing data.
  let result = reconcileCadGraph(state, reduced);
  const surviving = new Set(result.cadGraph!.nodes.map(node => node.id));
  const removedHandles = new Set(state.cadGraph.nodes.flatMap(node => !surviving.has(node.id) && node.sourceHandle ? [canonicalCadHandle(node.sourceHandle)] : []));
  const raw = rawEntitiesOf(result);
  const retained = raw.filter(record => !record.handle || !/^[0-9A-Fa-f]{1,16}$/.test(record.handle) || !removedHandles.has(canonicalCadHandle(record.handle)));
  // The DXF writer falls back to these raw records when no graph node remains.
  // Remove the erased owned copies here too, or Save As would resurrect them.
  if (retained.length !== raw.length) result = { ...result, meta: { ...result.meta, [RAW_ENTITIES_META_KEY]: retained } };
  return result;
}

function sourceHandle(state: DrawingState, entity: Entity): string | undefined {
  if (!state.cadGraph) return entity.cadIdentity;
  return state.cadGraph.nodes.find(node => node.anchor?.kind === 'entity' && !node.anchor.part && node.anchor.id === entity.id)?.sourceHandle;
}

/** A cyclic graph cannot be made reliable by guessing which reference to erase. */
function reachableCycle(state: DrawingState): string | undefined {
  const done = new Set<string>(), visiting = new Set<string>();
  const roots = [state.entities, ...(state.layouts ?? []).map(layout => layout.entities)];
  for (const entities of roots) for (const entity of entities) {
    if (entity.type !== 'insert' || done.has(entity.block)) continue;
    const stack = [{ name: entity.block, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const block = state.blocks[frame.name];
      if (!block || frame.index === block.entities.length) {
        visiting.delete(frame.name); done.add(frame.name); stack.pop(); continue;
      }
      visiting.add(frame.name);
      const child = block.entities[frame.index++]!;
      if (child.type !== 'insert') continue;
      if (visiting.has(child.block)) return child.block;
      if (!done.has(child.block)) stack.push({ name: child.block, index: 0 });
    }
  }
  return undefined;
}

interface Exclusion {
  readonly candidate: Candidate;
  readonly handle?: string;
  readonly perReference: boolean;
}

function exclusionItem(exclusion: Exclusion): ImportReportItem {
  const { candidate: pick, handle, perReference } = exclusion;
  return {
    type: 'INSERT', action: 'dropped',
    reason: pick.problem
      ? `block "${pick.entity.block}" could not be expanded within the safe geometry budget (${pick.problem}); this reference was excluded so the rest of the drawing could open`
      : perReference
        ? `block "${pick.entity.block}" expands to at least ${fmt(pick.work)} work units through its nested blocks, over the ${fmt(MAX_BLOCK_EXPANSION_WORK)} limit for a single reference; this reference was excluded so the rest of the drawing could open`
        : `block "${pick.entity.block}" expands to ${fmt(pick.work)} work units through its nested blocks, the largest reference in a drawing over the ${fmt(MAX_DRAWING_EXPANSION_WORK)} whole-drawing limit; this reference was excluded so the rest of the drawing could open`,
    ...(handle ? { handle } : {}), layer: pick.entity.layer, where: pick.where,
  };
}

/**
 * Validate `state` against the geometry budget; while acceptance rejects it only because of
 * oversized block references, exclude the single worst reference, report it through `add`,
 * and retry. Returns the (possibly reduced) state once it validates. Rethrows the original
 * GeometryBudgetError when no reference explains the failure.
 */
export function recoverOversizedReferences(state: DrawingState, add: (item: ImportReportItem) => void, note: (text: string) => void): DrawingState {
  let current = state;
  let firstError: GeometryBudgetError | undefined;
  const exclusions: Exclusion[] = [];
  const removedNodes = new Map<string, { node: CadNode; exclusion: Exclusion }>();
  const changedNodes = new Map<string, CadNode>();
  for (let iteration = 0; iteration <= MAX_RECOVERY_REMOVALS; iteration += 1) {
    try {
      validateGeometryBudget(current);
      // Publish only after every exclusion and dependency check succeeds. A fatal
      // later error must not leave a caller's report claiming a partial success.
      for (const exclusion of exclusions) add(exclusionItem(exclusion));
      for (const { node, exclusion } of removedNodes.values()) {
        const { candidate: pick, handle } = exclusion;
        add({ type: node.type, action: 'dropped', ...(node.sourceHandle ? { handle: node.sourceHandle } : {}),
          layer: node.groups.find(([code]) => code === 8)?.[1] ?? pick.entity.layer, where: pick.where,
          reason: `owned source record excluded with block reference "${pick.entity.block}"${handle ? ` (handle ${handle})` : ''}; it is also removed from retained metadata so Save As cannot restore the excluded content` });
      }
      for (const [id, node] of changedNodes) if (!removedNodes.has(id)) add({ type: node.type, action: 'simplified',
        ...(node.sourceHandle ? { handle: node.sourceHandle } : {}),
        reason: 'references to excluded block references or their owned records were detached using the CAD graph erase rules; unrelated source properties are retained' });
      if (exclusions.length) note(`${exclusions.length} block reference(s) were excluded during import because their expansion exceeded the safe geometry budget; the rest of the drawing was opened without them. Owned source records were removed with each excluded reference; related detachable references were repaired, and unrelated retained metadata was kept.`);
      return current;
    } catch (err) {
      if (!(err instanceof GeometryBudgetError)) throw err;
      firstError ??= err;
      if (iteration === MAX_RECOVERY_REMOVALS) throw new GeometryBudgetError(`${err.message} Partial opening would require more than ${MAX_RECOVERY_REMOVALS} block-reference exclusions; the drawing was not opened.`);
      if (!iteration) {
        const cycle = reachableCycle(current);
        if (cycle) throw new GeometryBudgetError(`${err.message} Cyclic block reference "${cycle}" cannot be excluded safely; the drawing was not opened.`);
      }
      const analysis = analyze(current);
      if (analysis.fatal) break;
      const overTotal = analysis.total > MAX_DRAWING_EXPANSION_WORK;
      const pick = analysis.oversized.length
        ? analysis.oversized.reduce((a, b) => (b.work > a.work ? b : a))
        : overTotal
          ? analysis.largest
          : null;
      if (!pick) break;
      const exclusion: Exclusion = { candidate: pick, handle: sourceHandle(current, pick.entity), perReference: analysis.oversized.includes(pick) };
      let next: DrawingState;
      try { next = withoutCandidate(current, pick); }
      catch (error) {
        if (!(error instanceof CadGraphError)) throw error;
        throw new GeometryBudgetError(`${err.message} Block reference "${pick.entity.block}"${exclusion.handle ? ` (handle ${exclusion.handle})` : ''} cannot be excluded safely: ${error.message}`);
      }
      if (current.cadGraph && next.cadGraph) {
        const remaining = new Map(next.cadGraph.nodes.map(node => [node.id, node]));
        for (const node of current.cadGraph.nodes) {
          const updated = remaining.get(node.id);
          if (!updated) {
            if (node.anchor?.kind !== 'entity' || node.anchor.id !== pick.entity.id || node.anchor.part) removedNodes.set(node.id, { node, exclusion });
            changedNodes.delete(node.id);
          } else if (updated.groups !== node.groups) changedNodes.set(node.id, node);
        }
      }
      current = next;
      exclusions.push(exclusion);
    }
  }
  throw firstError;
}
