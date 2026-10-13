/**
 * 3DPLANE (experimental, milestone 3): set the construction plane, a UCS-like frame that 3D
 * commands take their points, sizes and orientation from.
 *
 * Options: World (the WCS), XY / XZ / YZ (world-parallel planes through the current origin; XZ is
 * AutoCAD's Front orientation, X right and Y up the world Z, YZ the Right one), Face (the plane of
 * a picked solid face, origin at the pick, X axis by AutoCAD's arbitrary axis rule) and Origin
 * (same axes, new origin). The plane is session state, not part of the drawing. While 3D mode is
 * off, 3D commands use the WCS XY plane whatever is set here (the 2D view shows only z = 0).
 */
import { type Frame3, WORLD_XY_FRAME, frameFromPlane } from '../model3d/math';
import { matchKeyword } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { type PlaneAxes, axesFrame, constructionPlaneOf, frameAt, planeLabel } from './context';
import { type InputState, type Script3DTool, type Step3, ask3, point3, script3d } from './script3d';

const KEYWORDS = ['World', 'XY', 'XZ', 'YZ', 'Face', 'Origin'];

function apply(ctx: ToolContext, frame: Frame3, name: string): void {
  if (!ctx.setConstructionPlane) {
    ctx.log('3DPLANE: there is no construction plane to set here.');
    return;
  }
  ctx.setConstructionPlane(frame, name);
  ctx.log(`Construction plane: ${planeLabel(name, frame)}.`);
}

function* planeScript(ctx: ToolContext, arg?: string): Step3<void> {
  const st: InputState = { last: null };
  const current = constructionPlaneOf(ctx);
  const currentName = ctx.constructionPlaneName ?? 'World';
  let kw: string | null = arg ? matchKeyword(arg, KEYWORDS) : null;
  if (arg && !kw) ctx.log(`3DPLANE: unknown option "${arg}".`);
  while (!kw) {
    const a = yield* ask3(ctx, st, `Specify construction plane [${KEYWORDS.join('/')}] <World>:`, { keywords: KEYWORDS, points: false });
    if (a.kind === 'enter') kw = 'WORLD';
    else if (a.kind === 'keyword') kw = a.keyword;
  }
  switch (kw) {
    case 'WORLD':
      apply(ctx, WORLD_XY_FRAME, 'World');
      return;
    case 'XY': case 'XZ': case 'YZ':
      apply(ctx, axesFrame(kw as PlaneAxes, current.origin), kw);
      return;
    case 'FACE':
      for (;;) {
        const p = yield* point3(ctx, st, 'Select a face of a solid:');
        if (!p) return;
        const hit = ctx.face3?.(p.p2) ?? null;
        if (!hit) {
          ctx.log('No solid face there; pick a face of a solid.');
          continue;
        }
        apply(ctx, frameFromPlane({ origin: hit.point, normal: hit.normal }), 'Face');
        return;
      }
    case 'ORIGIN': {
      const p = yield* point3(ctx, st, 'Specify new origin point <0,0,0>:');
      const origin = p ? p.point : current.origin;
      apply(ctx, frameAt(current, origin), currentName === 'World' ? 'XY' : currentName);
      return;
    }
  }
}

/** 3DPLANE [World/XY/XZ/YZ/Face/Origin]; `arg` answers the first prompt (3DPLANE XZ). */
export const planeTool = (arg?: string): Script3DTool => script3d('3DPLANE', (ctx) => planeScript(ctx, arg));
