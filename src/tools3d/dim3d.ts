/**
 * 3DDIM (experimental PROTOTYPE, milestone 4 of docs/3D-PLAN.md; kept as an interim command):
 * an aligned linear dimension between two 3D points, written as an ORDINARY 2D aligned dimension
 * entity. True 3D dimensions in their own measurement plane are DIM3D (src/tools3d/
 * dimension3d-tool.ts, docs/3D-DIMENSIONS.md).
 *
 * How it works: the two points (picked on solids with 3D object snaps, or typed "x,y,z") are
 * projected onto the construction plane along its normal; the dimension measures the projected
 * distance. 2D entities live on the drawing plane z = 0 and have no elevation, so the
 * construction plane must be parallel to it (World, or XY at any origin); the dimension is drawn
 * at z = 0 directly below / above the projected points. When a point is off the construction
 * plane by more than the tolerance the command says that the dimension measures the projected
 * distance and logs the true 3D distance; a plane not parallel to WCS XY is refused with a message.
 * Whenever a point is off the drawing plane (z = 0, where the 2D dimension is drawn) the dimension
 * gets the text override "<> (projected)" (it shows e.g. "5.0000 (projected)"), so the drawing
 * itself says that it shows a projection, and the log gives the true 3D distance.
 *
 * Prompts: first extension line origin, second extension line origin, dimension line location
 * (Enter places it at a fifth of the length to the left of the first-to-second direction).
 */
import type { Point } from '../core/geometry';
import { type DimensionEntity, newId } from '../core/entities';
import { dimensionMeasurement, dimensionText } from '../core/dimension';
import { formatLength } from '../core/units';
import { type Vec3, dist3, dot3, len3, scale3, sub3 } from '../model3d/math';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, point3Of } from './context';
import { modelSpaceOnly } from './primitives';
import { type InputState, type Script3DTool, type Step3, ask3, point3, script3d } from './script3d';

/** Off-plane distance (relative to the size of the coordinates) below which a point is on the plane. */
export const DIM3D_PLANE_TOLERANCE = 1e-6;

/** Text override of a 3DDIM dimension whose points are off the drawing plane: the measurement, then "(projected)". */
export const PROJECTED_DIM_TEXT = '<> (projected)';

/** The aligned dimension entity 3DDIM writes (current layer and dimension style; `text` = an override). */
export function alignedDimension(ctx: ToolContext, p1: Point, p2: Point, linePoint: Point, text?: string): DimensionEntity {
  return { id: newId(), layer: ctx.doc.currentLayer, color: 'ByLayer', type: 'dimension', kind: 'aligned', p1, p2, linePoint, rotation: 0, ...(text !== undefined ? { text } : {}), style: ctx.doc.header.dimStyle };
}

function* dimScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DDIM';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const plane = constructionPlaneOf(ctx);
  const n = plane.zAxis;
  if (Math.abs(Math.abs(n.z) - 1) > 1e-9) {
    ctx.log(`${NAME}: 2D dimensions lie on the drawing plane (WCS XY); set 3DPLANE World or XY first, or use DIM3D for a true 3D dimension in this plane.`);
    return;
  }
  ctx.log(`${NAME} (prototype): writes an aligned 2D dimension of the points projected onto the drawing plane, labelled "(projected)" when a point is off it; DIM3D makes true 3D dimensions.`);
  const st: InputState = { last: null };
  const a = yield* point3(ctx, st, 'Specify first extension line origin:');
  if (!a) return;
  const b = yield* point3(ctx, st, 'Specify second extension line origin:');
  if (!b) return;
  const offPlane = (p: Vec3) => dot3(sub3(p, plane.origin), n);
  const project = (p: Vec3): Vec3 => sub3(p, scale3(n, offPlane(p)));
  const qa = project(a.point), qb = project(b.point);
  const p1 = { x: qa.x, y: qa.y }, p2 = { x: qb.x, y: qb.y };
  const projected = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const units = ctx.doc.header.units;
  const tol = (p: Vec3) => DIM3D_PLANE_TOLERANCE * Math.max(1, len3(p), len3(plane.origin));
  if (!(projected > 1e-12)) {
    ctx.log(`${NAME}: the points coincide on the construction plane; nothing to dimension (3D distance ${formatLength(dist3(a.point, b.point), units)}).`);
    return;
  }
  const trueDistance = formatLength(dist3(a.point, b.point), units);
  // The 2D dimension lies on z = 0: any point off it means the drawing shows a projection.
  const offDrawing = Math.abs(a.point.z) > tol(a.point) || Math.abs(b.point.z) > tol(b.point);
  if (Math.abs(offPlane(a.point)) > tol(a.point) || Math.abs(offPlane(b.point)) > tol(b.point)) {
    ctx.log(`${NAME}: a point is off the construction plane; the dimension measures the projected distance ${formatLength(projected, units)}. True 3D distance: ${trueDistance}.`);
  } else if (offDrawing) {
    ctx.log(`${NAME}: the points are off the drawing plane (z = 0); the 2D dimension shows their projection onto it. True 3D distance: ${trueDistance}.`);
  }
  const text = offDrawing ? PROJECTED_DIM_TEXT : undefined;
  if (Math.abs(plane.origin.z) > tol(plane.origin)) ctx.log(`${NAME}: 2D entities have no elevation; the dimension is drawn on z = 0 below the construction plane.`);
  const ux = (p2.x - p1.x) / projected, uy = (p2.y - p1.y) / projected;
  const fallback: Point = { x: (p1.x + p2.x) / 2 - uy * projected * 0.2, y: (p1.y + p2.y) / 2 + ux * projected * 0.2 };
  const world2 = (c: Point): Point => {
    const q = point3Of(ctx, c);
    return { x: q.x, y: q.y };
  };
  for (;;) {
    const r = yield* ask3(ctx, st, 'Specify dimension line location <offset to the left>:', { preview: (c) => [alignedDimension(ctx, p1, p2, world2(c), text)] });
    let loc: Point;
    if (r.kind === 'enter') loc = fallback;
    else if (r.kind === 'point') loc = { x: r.point.x, y: r.point.y };
    else continue;
    const dim = alignedDimension(ctx, p1, p2, loc, text);
    ctx.doc.addEntities([dim]);
    ctx.log(`Dimension text = ${dimensionText(dim)} (measured ${formatLength(dimensionMeasurement(dim), units)}${offDrawing ? `, projected; true 3D distance ${trueDistance}` : ''})`);
    return;
  }
}

/** 3DDIM (prototype, interim): aligned 2D dimension between two 3D points projected onto the drawing plane. */
export const dim3dTool = (): Script3DTool => script3d('3DDIM', dimScript);
