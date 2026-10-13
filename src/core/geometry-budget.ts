import type { DrawingState } from './document';
import { entityGeometryWork, MAX_BLOCK_EXPANSION_WORK } from './entities';
import { isImmutableData, sealImmutableData } from './immutable-data';
import { GeometryBudgetError } from './geometry-budget-error';
import { insertArrayCount } from './insert-array';

/** Limit aggregate work before imported or edited block references allocate expanded geometry. */
export const MAX_DRAWING_EXPANSION_WORK = 1_000_000;
const checked = new WeakSet<DrawingState>();

/** Settings and viewport pans do not change the geometry held by an immutable snapshot. */
function sameGeometry(state: DrawingState, previous: DrawingState): boolean {
  if (state.entities !== previous.entities || state.blocks !== previous.blocks) return false;
  if (state.layouts === previous.layouts) return true;
  const a = state.layouts ?? [], b = previous.layouts ?? [];
  return a.length === b.length && a.every((layout, index) => layout.entities === b[index]!.entities && layout.viewports.length === b[index]!.viewports.length && layout.viewports.every((v, i) => v.clipBoundary === b[index]!.viewports[i]!.clipBoundary));
}

export function validateGeometryBudget(state: DrawingState, previous?: DrawingState): void {
  if (isImmutableData(state) && checked.has(state)) return;
  if (previous && isImmutableData(previous) && checked.has(previous) && sameGeometry(state, previous)) {
    if (isImmutableData(state)) checked.add(state);
    return;
  }
  const memo = new Map<string, Map<number, number>>();
  let definitions = 0;
  for (const block of Object.values(state.blocks)) {
    for (const entity of block.entities) definitions += entityGeometryWork(entity);
    for (const attribute of block.attributes) definitions += 1 + attribute.default.length;
    if (definitions > MAX_DRAWING_EXPANSION_WORK) throw new GeometryBudgetError('Drawing block definitions exceed the safe geometry budget.');
  }
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
  let total = 0;
  for (const entities of [state.entities, ...(state.layouts ?? []).flatMap((layout) => [layout.entities, layout.viewports.flatMap((v) => v.clipBoundary ? [v.clipBoundary] : [])])]) {
    for (const entity of entities) {
      const expanded = entityGeometryWork(entity) + (entity.type === 'insert' ? insertArrayCount(entity) * cost(entity.block, 0) : 0);
      if (entity.type === 'insert' && expanded > MAX_BLOCK_EXPANSION_WORK) throw new GeometryBudgetError('Block expansion exceeds the safe geometry budget.');
      total += expanded;
      if (total > MAX_DRAWING_EXPANSION_WORK) throw new GeometryBudgetError('Drawing expansion exceeds the safe geometry budget.');
    }
  }
  // Mutable caller-owned data must be checked again, including changes made in place.
  if (isImmutableData(state)) checked.add(state);
}

/** Validate before taking immutable ownership, then safely memoize the accepted snapshot. */
export function prepareDrawingState(state: DrawingState, previous?: DrawingState): DrawingState {
  validateGeometryBudget(state, previous);
  sealImmutableData(state);
  checked.add(state);
  return state;
}
