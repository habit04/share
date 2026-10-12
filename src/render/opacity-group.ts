import type { Point } from '../core/geometry';
import { GeometryBudgetError } from '../core/geometry-budget-error';

const TILE_SIZE = 2048;
export const MAX_OPACITY_GROUP_PIXELS = TILE_SIZE * TILE_SIZE;
const MAX_TILES = 64;

/** Opaque internal paints retain their separate masks; the parent composites each pixel once. */
export function paintOpacityGroup(ctx: CanvasRenderingContext2D, paths: readonly (readonly Point[])[], toScreen: (point: Point) => Point, paint: (group: CanvasRenderingContext2D) => void): void {
  if (ctx.globalAlpha === 0) return;
  const matrix = ctx.getTransform(), parent = ctx.canvas;
  if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, parent.width, parent.height].every(Number.isFinite)) throw new GeometryBudgetError('Opacity group requires a finite drawing transform and canvas.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) for (const point of path) {
    const p = toScreen(point), x = matrix.a * p.x + matrix.c * p.y + matrix.e, y = matrix.b * p.x + matrix.d * p.y + matrix.f;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GeometryBudgetError('Opacity group exceeds finite device coordinates.');
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (minX === Infinity) return;
  const padding = Math.min(Math.max(parent.width, parent.height), Math.max(2, ctx.lineWidth * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) / 2 + 2));
  const left = Math.max(0, Math.floor(minX - padding)), top = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(parent.width, Math.ceil(maxX + padding)), bottom = Math.min(parent.height, Math.ceil(maxY + padding));
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const tiles = Math.ceil(width / TILE_SIZE) * Math.ceil(height / TILE_SIZE);
  if (tiles > MAX_TILES) throw new GeometryBudgetError('Translucent polyline exceeds the bounded visible compositing area.');
  const vertices = paths.reduce((sum, path) => sum + path.length, 0);
  if (vertices * tiles > 2_000_000) throw new GeometryBudgetError('Translucent polyline exceeds the compositing work budget.');
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : parent.ownerDocument.createElement('canvas');
  const group = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!group) throw new GeometryBudgetError('A 2D canvas is required for translucent polyline compositing.');
  for (let y = top; y < bottom; y += TILE_SIZE) for (let x = left; x < right; x += TILE_SIZE) {
    canvas.width = Math.min(TILE_SIZE, right - x); canvas.height = Math.min(TILE_SIZE, bottom - y);
    if (canvas.width * canvas.height > MAX_OPACITY_GROUP_PIXELS) throw new GeometryBudgetError('Opacity group exceeds its pixel budget.');
    group.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
    group.strokeStyle = ctx.strokeStyle; group.fillStyle = ctx.fillStyle;
    group.lineWidth = ctx.lineWidth; group.lineCap = ctx.lineCap; group.lineJoin = ctx.lineJoin; group.miterLimit = ctx.miterLimit;
    group.setLineDash(ctx.getLineDash()); group.lineDashOffset = ctx.lineDashOffset;
    group.globalAlpha = 1;
    paint(group);
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(canvas, x, y);
    } finally {
      ctx.restore();
    }
  }
}
