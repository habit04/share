import type { DrawingState } from '../../core/document';
import type { BlockDef, Entity, InsertEntity, PolylineEntity } from '../../core/entities';
import { GeometryBudgetError } from '../../core/geometry-budget-error';
import { validateGeometryBudget } from '../../core/geometry-budget';
import { polylineWidthProblem } from '../../core/polyline-widths';

/**
 * A nonuniformly transformed wide polyline cannot be a standalone LWPOLYLINE. Encode its
 * affine frame as two ordinary nested INSERTs (rotation/scale decomposition), retaining the
 * native centerline, bulges and widths in an anonymous block. No proprietary XDATA is needed.
 */
export function materializePolylineWidthFrames(state: DrawingState): DrawingState {
  const hasFrame = (entities: readonly Entity[]) => entities.some((entity) => entity.type === 'polyline' && entity.widthFrame);
  if (!hasFrame(state.entities) && !(state.layouts ?? []).some((layout) => hasFrame(layout.entities)) && !Object.values(state.blocks).some((block) => hasFrame(block.entities))) return state;
  // A frame adds two nested references inside an existing block. Refuse a save that would
  // move currently visible geometry past the shared depth-eight expansion limit.
  const visited = new Map<string, Set<number>>();
  const checkDepth = (blockName: string, depth: number): void => {
    const block = state.blocks[blockName];
    if (!block || depth > 8 || visited.get(blockName)?.has(depth)) return;
    const depths = visited.get(blockName) ?? new Set<number>();
    depths.add(depth); visited.set(blockName, depths);
    if (depth > 6 && hasFrame(block.entities)) throw new GeometryBudgetError('The transformed polyline cannot be saved within the safe block nesting limit. Explode its containing reference before saving.');
    for (const entity of block.entities) if (entity.type === 'insert') checkDepth(entity.block, depth + 1);
  };
  for (const entities of [state.entities, ...(state.layouts ?? []).map((layout) => layout.entities)]) for (const entity of entities) if (entity.type === 'insert') checkDepth(entity.block, 0);
  const blocks: Record<string, BlockDef> = { ...state.blocks };
  let count = 0;
  const name = () => { let next: string; do { next = `*JCAD_WIDTH_${++count}`; } while (blocks[next]); return next; };
  const convert = (entity: Entity): Entity => {
    if (entity.type !== 'polyline' || !entity.widthFrame) return entity;
    const invalid = polylineWidthProblem(entity);
    if (invalid) throw new GeometryBudgetError(invalid);
    const frame = entity.widthFrame;
    // Scale the matrix before its squared terms: large finite axes must not overflow here.
    const magnitude = Math.max(Math.abs(frame.x.x), Math.abs(frame.x.y), Math.abs(frame.y.x), Math.abs(frame.y.y));
    const a = frame.x.x / magnitude, b = frame.x.y / magnitude, c = frame.y.x / magnitude, d = frame.y.y / magnitude;
    const angle = Math.atan2(2 * (a * c + b * d), a * a + b * b - c * c - d * d) / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const u = { x: a * cos + c * sin, y: b * cos + d * sin };
    const v = { x: -a * sin + c * cos, y: -b * sin + d * cos };
    const sx = Math.hypot(u.x, u.y) * magnitude, sy = Math.hypot(v.x, v.y) * magnitude;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) throw new GeometryBudgetError('The transformed polyline has an invalid or degenerate width frame.');
    const mirrored = a * d - b * c < 0;
    const rotation = Math.atan2(u.y, u.x) + (mirrored ? Math.PI : 0);
    const sourceName = name(), wrapperName = name();
    const source: PolylineEntity = { ...entity, points: frame.points, bulges: frame.bulges, width: frame.width, widths: frame.widths, widthFrame: undefined };
    blocks[sourceName] = { name: sourceName, basePoint: { x: 0, y: 0 }, attributes: [], entities: [source] };
    const inner: InsertEntity = { id: `${entity.id}:width`, type: 'insert', layer: '0', color: 0, transparency: 'ByBlock', block: sourceName, position: { x: 0, y: 0 }, rotation: -angle, scale: 1, attributes: {} };
    blocks[wrapperName] = { name: wrapperName, basePoint: { x: 0, y: 0 }, attributes: [], entities: [inner] };
    return { ...entity, type: 'insert', block: wrapperName, position: frame.origin, rotation, scale: sx, scaleY: sy, mirror: mirrored, attributes: {} };
  };
  // Convert only original definitions, since the generated definitions contain native widths.
  for (const block of Object.values(state.blocks)) blocks[block.name] = { ...block, entities: block.entities.map(convert) };
  const entities = state.entities.map(convert);
  const layouts = state.layouts?.map((layout) => ({ ...layout, entities: layout.entities.map(convert) }));
  const materialized = { ...state, blocks, entities, ...(layouts ? { layouts } : {}) };
  validateGeometryBudget(materialized);
  return materialized;
}
