import type { DrawingState } from './document';
import { entityGeometryWork, MAX_BLOCK_EXPANSION_WORK } from './entities';
import { isImmutableData, sealImmutableData } from './immutable-data';
import { GeometryBudgetError } from './geometry-budget-error';
import { insertArrayCount } from './insert-array';
import { validateModel3DBudget } from '../model3d/budget';

/** Limit aggregate work before imported or edited block references allocate expanded geometry. */
export const MAX_DRAWING_EXPANSION_WORK = 1_000_000;
const checked = new WeakSet<DrawingState>();

/** Settings and viewport pans do not change the 2D geometry held by an immutable snapshot. */
function same2DGeometry(state: DrawingState, previous: DrawingState): boolean {
  if (state.entities !== previous.entities || state.blocks !== previous.blocks) return false;
  if (state.layouts === previous.layouts) return true;
  const a = state.layouts ?? [], b = previous.layouts ?? [];
  return a.length === b.length && a.every((layout, index) => layout.entities === b[index]!.entities && layout.viewports.length === b[index]!.viewports.length && layout.viewports.every((v, i) => v.clipBoundary === b[index]!.viewports[i]!.clipBoundary));
}

/** Unchanged geometry, 2D and 3D: the previous accepted snapshot's verdict carries over. */
function sameGeometry(state: DrawingState, previous: DrawingState): boolean {
  return state.model3d === previous.model3d && same2DGeometry(state, previous);
}

export function validateGeometryBudget(state: DrawingState, previous?: DrawingState): void {
  if (isImmutableData(state) && checked.has(state)) return;
  const accepted = !!previous && isImmutableData(previous) && checked.has(previous);
  if (accepted && sameGeometry(state, previous)) {
    if (isImmutableData(state)) checked.add(state);
    return;
  }
  // The accepted previous snapshot's verdict still covers whichever half (2D or 3D) is unchanged.
  if (!accepted || state.model3d !== previous.model3d) validateModel3DBudget(state);
  if (accepted && same2DGeometry(state, previous)) {
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

/**
 * Root keys exempt from the whole-DrawingState seal (AMENDMENT TO RULING-P31, Matter 1):
 * exactly the one own property 'signatureRecord' at depth 0 of the state. The preserved
 * signature record carries a Uint8Array payload (src/project/drawing-signature.ts), which
 * the plain-data seal can never certify; the exemption is keyed by root + name only, so a
 * typed array or custom prototype anywhere else in the state still throws.
 *
 * CAVEAT (stated scope reduction, ruling invariant (d)): the exempt subtree is NOT
 * seal-certified — it is not traversed, frozen or sealed, and the record itself is NOT
 * immutable: a holder of the record or payload reference can mutate its bytes/fields and
 * the seal will not prevent it. For a state sealed through this path, isImmutableData
 * certifies "sealed EXCEPT the signatureRecord subtree". The record's integrity posture
 * is the documented (f2) one — unauthenticated, API discipline: invalidation stickiness
 * is a property of the C2 API transitions in core/document.ts (noteSignatureEdit applied
 * at the two state-replacement points), NOT of seal enforcement.
 */
const DRAWING_STATE_SEAL_EXEMPT_ROOT_KEYS: ReadonlySet<PropertyKey> = new Set<PropertyKey>(['signatureRecord']);

/** Seal a whole DrawingState, exempting only the root 'signatureRecord' subtree (above). */
export function sealDrawingState<T extends DrawingState>(state: T): T {
  return sealImmutableData(state, DRAWING_STATE_SEAL_EXEMPT_ROOT_KEYS);
}

/** Validate before taking immutable ownership, then safely memoize the accepted snapshot. */
export function prepareDrawingState(state: DrawingState, previous?: DrawingState): DrawingState {
  validateGeometryBudget(state, previous);
  sealDrawingState(state);
  checked.add(state);
  return state;
}
