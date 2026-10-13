/**
 * 3DPLANE (experimental, milestone 3): set the construction plane, a UCS-like frame that 3D
 * commands take their points, sizes and orientation from.
 *
 * Options: World (the WCS), Top / Front / Right (the world-parallel planes XY / XZ / YZ through
 * the current origin, AutoCAD's UCS orientations: Front has X right and Y up the world Z, normal
 * -Y; Right has X along world Y, normal +X), Solid face (the plane of a picked solid face, origin
 * at the pick, X axis by AutoCAD's arbitrary axis rule) and Origin (same axes, new origin).
 * The shown options have distinct first letters because a click on an option in the command line
 * sends its first letter (src/ui/commandline.ts, as for 2D prompts); XY, XZ, YZ and Face are
 * still accepted when typed. The plane is session state, not part of the drawing. While 3D mode is
 * off, 3D commands use the WCS XY plane whatever is set here (the 2D view shows only z = 0).
 */
import { type Frame3, WORLD_XY_FRAME, frameFromPlane } from '../model3d/math';
import { matchKeyword } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { type PlaneAxes, axesFrame, constructionPlaneOf, frameAt, planeLabel } from './context';
import { type InputState, type Script3DTool, type Step3, ask3, point3, script3d } from './script3d';

/** The options the prompt shows (distinct first letters, see the module comment). */
const SHOWN = ['World', 'Top', 'Front', 'Right', 'Solid face', 'Origin'];
/** Everything accepted: the shown options, then the typed-only aliases. */
const KEYWORDS = [...SHOWN, 'XY', 'XZ', 'YZ', 'Face'];
/** Keyword (as matched) to the option it stands for. */
const OPTION: Readonly<Record<string, string>> = { TOP: 'XY', FRONT: 'XZ', RIGHT: 'YZ', 'SOLID FACE': 'FACE' };

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
  const option = (k: string | null) => (k ? OPTION[k] ?? k : null);
  let kw: string | null = arg ? option(matchKeyword(arg, KEYWORDS)) : null;
  if (arg && !kw) ctx.log(`3DPLANE: unknown option "${arg}".`);
  while (!kw) {
    const a = yield* ask3(ctx, st, `Specify construction plane [${SHOWN.join('/')}] <World>:`, { keywords: KEYWORDS, points: false });
    if (a.kind === 'enter') kw = 'WORLD';
    else if (a.kind === 'keyword') kw = option(a.keyword);
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
      // Typed points are in the current plane's coordinates, so its origin is 0,0,0 there; the
      // default (Enter) keeps it, and the prompt also names it in world coordinates.
      const o = current.origin;
      const w = (v: number) => String(Number(v.toFixed(4)) + 0);
      const p = yield* point3(ctx, st, `Specify new origin point <0,0,0 (world ${w(o.x)},${w(o.y)},${w(o.z)})>:`);
      const origin = p ? p.point : current.origin;
      apply(ctx, frameAt(current, origin), currentName === 'World' ? 'XY' : currentName);
      return;
    }
  }
}

/** 3DPLANE [World/Top/Front/Right/Solid face/Origin] (XY / XZ / YZ / Face typed); `arg` answers the first prompt (3DPLANE XZ). */
export const planeTool = (arg?: string): Script3DTool => script3d('3DPLANE', (ctx) => planeScript(ctx, arg));
