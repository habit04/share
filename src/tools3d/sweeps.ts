/**
 * EXTRUDE and REVOLVE (experimental, milestone 3): closed 2D objects become solids.
 *
 * The objects are chosen with the normal "Select objects:" machinery (the pick-first set counts),
 * turned into a planar profile by `profileFromEntities` (src/model3d/sketch.ts: closed polylines,
 * circles, ellipses, closed splines, lines / arcs chained into closed loops; holes allowed) and
 * swept by src/model3d/sweep.ts. Profile errors are shown exactly as sketch.ts words them.
 *
 * Profile plane: the construction plane when it is the drawing plane z = 0 (WCS XY, either way
 * up); otherwise WCS XY, because 2D objects always lie on z = 0 (the command says so).
 *
 * Source objects are kept by default (AutoCAD's DELOBJ = 0, said at the start of the command);
 * the Delete option removes them in the same undo step as the new solid. The solid goes on the
 * current layer with the current colour.
 */
import type { Point } from '../core/geometry';
import { type Frame3, type Vec3, WORLD_XY_FRAME, sub3 } from '../model3d/math';
import { addSolids, newSolid } from '../model3d/model';
import { profileFromEntities } from '../model3d/sketch';
import { extrudeMesh, revolveMesh, type RevolveAxis } from '../model3d/sweep';
import type { Profile3D, Solid3D } from '../model3d/types';
import { select } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, heightBetween, isDrawingPlane, planeToWorld, point3Of, solidsOf } from './context';
import { PREVIEW_ID, modelSpaceOnly, promptText } from './primitives';
import { type Ans3, type InputState, type Script3DTool, type Step3, ask3, clearingSelection, point3, script3d } from './script3d';

/** Sticky values shown as <default> (per session). */
export const sweepDefaults = {
  height: null as number | null,
  angle: 360,
};

/** Forget the sticky values (tests). */
export function resetSweepDefaults(): void {
  sweepDefaults.height = null;
  sweepDefaults.angle = 360;
}

/** The plane profiles are built on, and a note when it is not the construction plane. */
export function profileFrame(ctx: ToolContext): { frame: Frame3; note: string | null } {
  const plane = constructionPlaneOf(ctx);
  if (isDrawingPlane(plane)) return { frame: plane, note: null };
  return { frame: WORLD_XY_FRAME, note: '2D objects lie on the WCS XY plane (z = 0); the profile is built on that plane, not on the construction plane.' };
}

/** A selected profile and the 2D objects it came from. */
interface Source {
  readonly profile: Profile3D;
  readonly ids: readonly string[];
}

/** Select 2D objects and build the profile; null (with the reason logged) when that fails. */
function* sourceProfile(ctx: ToolContext, name: string, verb: string): Step3<Source | null> {
  const ids = yield* select(ctx, `Select objects to ${verb}:`);
  if (ids.length === 0) return null;
  const set = new Set(ids);
  const entities = ctx.doc.entities.filter((e) => set.has(e.id));
  const solidIds = new Set(solidsOf(ctx).solids.map((s) => s.id));
  const skipped = ids.filter((id) => solidIds.has(id)).length;
  if (skipped) ctx.log(`${skipped} 3D solid${skipped === 1 ? ' was' : 's were'} ignored: ${name} uses closed 2D objects.`);
  if (entities.length === 0) {
    ctx.log(`${name}: no 2D objects selected.`);
    return null;
  }
  const { frame, note } = profileFrame(ctx);
  if (note) ctx.log(note);
  const r = profileFromEntities(entities, frame);
  if ('error' in r) {
    ctx.log(r.error);
    return null;
  }
  return { profile: r.profile, ids: entities.map((e) => e.id) };
}

/** A new solid on the current layer with the current colour. */
function sweptSolid(ctx: ToolContext, mesh: Solid3D['mesh'], feature: Solid3D['feature'], id?: string): Solid3D {
  return newSolid({ id, mesh, feature, layer: ctx.doc.currentLayer, color: ctx.doc.currentColor });
}

/** Ghost of a sweep (empty when the parameters are not valid). */
function sweepGhost(ctx: ToolContext, make: () => { mesh: Solid3D['mesh']; feature: Solid3D['feature'] } | null): readonly Solid3D[] {
  try {
    const r = make();
    return r ? [sweptSolid(ctx, r.mesh, r.feature, PREVIEW_ID)] : [];
  } catch {
    return [];
  }
}

/** World centre of the outer loop (the base for picked heights). */
function profileCenter(profile: Profile3D): Vec3 {
  const loop = profile.loops[0] ?? [];
  let x = 0, y = 0;
  for (const p of loop) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, loop.length);
  return planeToWorld(profile.frame, { x: x / n, y: y / n });
}

function deleteNote(ctx: ToolContext, del: boolean): void {
  ctx.log(del ? 'Source objects will be deleted.' : 'Source objects will be kept.');
}

// ------------------------------------------------------------------ EXTRUDE

function* extrudeScript(ctx: ToolContext): Step3<void> {
  const NAME = 'EXTRUDE';
  if (!modelSpaceOnly(ctx, NAME)) return;
  ctx.log('Closed 2D objects become solids. Source objects are kept (choose Delete to remove them).');
  const src = yield* sourceProfile(ctx, NAME, 'extrude');
  if (!src) return;
  const { profile } = src;
  const normal = profile.frame.zAxis;
  const center = profileCenter(profile);
  const st: InputState = { last: null };
  let del = false;
  let h: number;
  const make = (d: number) => ({ mesh: extrudeMesh(profile, d), feature: { kind: 'extrude' as const, profile, distance: d } });
  for (;;) {
    const dfl = sweepDefaults.height;
    const kw: string[] = [del ? 'Keep' : 'Delete'];
    const preview3d = (c: Point | null) => sweepGhost(ctx, () => {
      const d = c ? heightBetween(center, point3Of(ctx, c), normal) : dfl;
      return d !== null && d !== 0 && Number.isFinite(d) ? make(d) : null;
    });
    const a: Ans3 = yield* ask3(ctx, st, promptText(ctx, 'Specify height of extrusion', kw, dfl), { numbers: true, keywords: kw, preview3d });
    if (a.kind === 'keyword') {
      del = a.keyword === 'DELETE';
      deleteNote(ctx, del);
      continue;
    }
    let v: number;
    if (a.kind === 'enter') {
      if (dfl === null) {
        ctx.log('Requires a value.');
        continue;
      }
      v = dfl;
    } else if (a.kind === 'number') v = a.value;
    else {
      const first = a.point;
      const b = yield* point3(ctx, st, 'Specify second point:', (c) => sweepGhost(ctx, () => {
        const d = c ? heightBetween(first, point3Of(ctx, c), normal) : null;
        return d ? make(d) : null;
      }));
      if (!b) continue;
      v = heightBetween(first, b.point, normal);
    }
    if (!Number.isFinite(v) || v === 0) {
      ctx.log('The height of extrusion must be a non-zero finite number.');
      continue;
    }
    h = v;
    break;
  }
  const solid = sweptSolid(ctx, extrudeMesh(profile, h), { kind: 'extrude', profile, distance: h });
  ctx.doc.updateModel3D((m) => addSolids(m, [solid]), del ? src.ids : undefined);
  sweepDefaults.height = h;
}

/** EXTRUDE: select closed 2D objects, height (typed, or two points) [Delete/Keep]. */
export const extrudeTool = (): Script3DTool => script3d('EXTRUDE', (ctx) => clearingSelection(ctx, extrudeScript(ctx)));

// ------------------------------------------------------------------ REVOLVE

function* revolveScript(ctx: ToolContext): Step3<void> {
  const NAME = 'REVOLVE';
  if (!modelSpaceOnly(ctx, NAME)) return;
  ctx.log('Closed 2D objects become solids. Source objects are kept (choose Delete to remove them).');
  const src = yield* sourceProfile(ctx, NAME, 'revolve');
  if (!src) return;
  const { profile } = src;
  const st: InputState = { last: null };
  let del = false;
  let reversed = false;
  const make = (axis: RevolveAxis, deg: number) => {
    const angle = (deg * Math.PI) / 180 * (reversed ? -1 : 1);
    return { mesh: revolveMesh(profile, axis, angle), feature: { kind: 'revolve' as const, profile, axis, angle } };
  };
  for (;;) {
    // Axis: two points, or an axis of the construction plane through its origin.
    let axis: RevolveAxis | null = null;
    while (!axis) {
      const a = yield* ask3(ctx, st, 'Specify axis start point or define axis by [X/Y/Z]:', { keywords: ['X', 'Y', 'Z'] });
      if (a.kind === 'enter') return;
      if (a.kind === 'keyword') {
        const plane = constructionPlaneOf(ctx);
        axis = { origin: plane.origin, dir: a.keyword === 'X' ? plane.xAxis : a.keyword === 'Y' ? plane.yAxis : plane.zAxis };
        break;
      }
      if (a.kind !== 'point') continue;
      const start = a.point;
      const b = yield* point3(ctx, st, 'Specify axis endpoint:', (c) => sweepGhost(ctx, () => (c ? make({ origin: start, dir: sub3(point3Of(ctx, c), start) }, sweepDefaults.angle) : null)));
      if (!b) continue;
      const dir = sub3(b.point, start);
      if (!(Math.hypot(dir.x, dir.y, dir.z) > 1e-12)) {
        ctx.log('The axis endpoint must differ from the start point.');
        continue;
      }
      axis = { origin: start, dir };
    }
    const ax = axis;
    let deg: number | null = null;
    while (deg === null) {
      const kw: string[] = ['Reverse', del ? 'Keep' : 'Delete'];
      const dfl = sweepDefaults.angle;
      const ghostNow = sweepGhost(ctx, () => make(ax, dfl));
      const a: Ans3 = yield* ask3(ctx, st, `Specify angle of revolution or [${kw.join('/')}] <${Number(dfl.toFixed(4))}>:`, { numbers: true, keywords: kw, points: false, preview3d: () => ghostNow });
      if (a.kind === 'keyword') {
        if (a.keyword === 'REVERSE') {
          reversed = !reversed;
          ctx.log(`Direction ${reversed ? 'reversed (clockwise about the axis)' : 'restored (counter-clockwise about the axis)'}.`);
        } else {
          del = a.keyword === 'DELETE';
          deleteNote(ctx, del);
        }
        continue;
      }
      const v = a.kind === 'number' ? a.value : a.kind === 'enter' ? dfl : NaN;
      if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 360) {
        ctx.log('The angle of revolution must be a non-zero number of degrees between -360 and 360.');
        continue;
      }
      deg = v;
    }
    let built: ReturnType<typeof make>;
    try {
      built = make(ax, deg);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      ctx.log(`${NAME}: ${err.message}`);
      continue;
    }
    const solid = sweptSolid(ctx, built.mesh, built.feature);
    ctx.doc.updateModel3D((m) => addSolids(m, [solid]), del ? src.ids : undefined);
    sweepDefaults.angle = deg;
    return;
  }
}

/** REVOLVE: select closed 2D objects, axis (two points or X / Y / Z), angle <360> [Reverse/Delete]. */
export const revolveTool = (): Script3DTool => script3d('REVOLVE', (ctx) => clearingSelection(ctx, revolveScript(ctx)));

