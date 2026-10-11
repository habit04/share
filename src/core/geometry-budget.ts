import type { DrawingState } from './document';
import { entityGeometryWork, MAX_BLOCK_EXPANSION_WORK } from './entities';

/** Limit aggregate work before imported block references allocate expanded geometry. */
export const MAX_DRAWING_EXPANSION_WORK = 1_000_000;
const checked = new WeakSet<DrawingState>();

export function validateGeometryBudget(state: DrawingState): void {
  if (checked.has(state)) return;
  const memo = new Map<string, Map<number, number>>();
  let definitions = 0;
  for (const block of Object.values(state.blocks)) {
    for (const entity of block.entities) definitions += entityGeometryWork(entity);
    for (const attribute of block.attributes) definitions += 1 + attribute.default.length;
    if (definitions > MAX_DRAWING_EXPANSION_WORK) throw new Error('Drawing block definitions exceed the safe geometry budget.');
  }
  const cost = (name: string, depth: number): number => {
    const block = state.blocks[name];
    if (!block || depth > 8) return 0;
    const hit = memo.get(name)?.get(depth);
    if (hit !== undefined) return hit;
    let work = block.xref && !block.entities.length ? 2 : block.attributes.reduce((sum, attribute) => sum + 1 + attribute.default.length, 0);
    for (const entity of block.entities) {
      work += entityGeometryWork(entity) + (entity.type === 'insert' ? cost(entity.block, depth + 1) : 0);
      if (work > MAX_BLOCK_EXPANSION_WORK) break;
    }
    let depths = memo.get(name);
    if (!depths) { depths = new Map(); memo.set(name, depths); }
    depths.set(depth, work);
    return work;
  };
  let total = 0;
  for (const entities of [state.entities, ...(state.layouts ?? []).map((layout) => layout.entities)]) {
    for (const entity of entities) {
      const expanded = entityGeometryWork(entity) + (entity.type === 'insert' ? cost(entity.block, 0) : 0);
      if (entity.type === 'insert' && expanded > MAX_BLOCK_EXPANSION_WORK) throw new Error('Block expansion exceeds the safe geometry budget.');
      total += expanded;
      if (total > MAX_DRAWING_EXPANSION_WORK) throw new Error('Drawing expansion exceeds the safe geometry budget.');
    }
  }
  checked.add(state);
}
