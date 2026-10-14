/**
 * 3D editing commands (experimental, milestone 4 of docs/3D-PLAN.md): 3DMOVE, 3DROTATE, 3DSCALE.
 *
 * Every command selects objects first (pick-first selections are used, like MOVE), keeps the
 * solids among them (2D objects are reported and ignored: these commands work in 3D) and asks
 * for points as 3D points (`point3`: in the 3D view the solid face, the 3D object snap or the
 * construction plane under the cursor; typed "x,y" / "x,y,z" / "@dx,dy,dz" in construction-plane
 * coordinates). While the last point is asked the transformed solids follow the cursor as ghosts.
 * The result is ONE undoable step (`commitSolidEdit`, src/tools3d/solid-edit.ts) that transforms
 * meshes and feature histories together. Errors leave the drawing unchanged.
 *
 * - 3DMOVE: base point or [Displacement]; second point (or Enter: the base point read as a
 *   displacement from the plane origin, as AutoCAD does).
 * - 3DROTATE: base point; rotation axis [X/Y/Z/2Points] of the construction plane through the base
 *   point (Z by default); angle in degrees (right-hand rule about the axis), a picked point (its
 *   angle about the axis), or [Reference] (reference angle, typed or by two points; new angle,
 *   typed, by a point or [Points]).
 * - 3DSCALE: base point; uniform factor (> 0), a picked point (its distance from the base point)
 *   or [Reference] (reference length typed or by two points; new length typed, by a point from
 *   the base, or [Points]).
 */
import {
  type Frame3, type Mat4, type Vec3, cross3, dist3, dot3, frameFromPlane, len3, normalize3, sub3,
} from '../model3d/math';
import type { Dimension3D, Solid3D } from '../model3d/types';
import { select } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, planeToWorld, point3Of, worldToPlane } from './context';
import { modelSpaceOnly } from './primitives';
import { type InputState, type Script3DTool, type Step3, ask3, clearingSelection, point3, script3d } from './script3d';
import { commitSolidEdit, dimensionsInSelection, ghostSolids, rotationAbout, scalingAbout, solidsInSelection, translationMatrix } from './solid-edit';
import type { Point } from '../core/geometry';
import { GeometryBudgetError } from '../core/geometry-budget-error';

/** Sticky values shown as <default> (per session, like AutoCAD's last answers). */
export const transformDefaults = {
  displacement: { x: 0, y: 0, z: 0 } as Vec3,
  angle: 0,
  scale: 1,
  refLength: 1,
  newLength: 1,
};

/** Forget the sticky values (tests). */
export function resetTransformDefaults(): void {
  transformDefaults.displacement = { x: 0, y: 0, z: 0 };
  transformDefaults.angle = 0;
  transformDefaults.scale = 1;
  transformDefaults.refLength = 1;
  transformDefaults.newLength = 1;
}

const num = (v: number): string => {
  const s = v.toFixed(4);
  return Number(s) === 0 ? '0.0000' : s;
};

/**
 * "Select objects:" then the solids among the answer. Logs how many 2D objects were ignored and
 * returns [] (after a message) when no solid was selected.
 */
export function* selectSolids(ctx: ToolContext, NAME: string): Step3<Solid3D[]> {
  const ids = yield* select(ctx, 'Select objects:');
  if (ids.length === 0) return [];
  const solids = solidsInSelection(ctx, ids);
  const others = new Set(ids).size - solids.length;
  if (others > 0) ctx.log(others === 1 ? '1 object is not a 3D solid and was ignored.' : `${others} objects are not 3D solids and were ignored.`);
  if (solids.length === 0) ctx.log(`${NAME}: no 3D solids selected.`);
  return solids;
}

/** The 3D objects a transform command works on: solids and true 3D dimensions. */
export interface Objects3D {
  readonly solids: readonly Solid3D[];
  readonly dimensions: readonly Dimension3D[];
}

/**
 * "Select objects:" then the solids and 3D dimensions among the answer (3DMOVE, 3DROTATE,
 * 3DSCALE). Logs how many 2D objects were ignored (as `selectSolids`) and returns null (after
 * "no 3D solids selected") when the answer holds neither.
 */
export function* selectObjects3D(ctx: ToolContext, NAME: string): Step3<Objects3D | null> {
  const ids = yield* select(ctx, 'Select objects:');
  if (ids.length === 0) return null;
  const solids = solidsInSelection(ctx, ids);
  const dimensions = dimensionsInSelection(ctx, ids);
  const others = new Set(ids).size - solids.length - dimensions.length;
  if (others > 0) ctx.log(others === 1 ? '1 object is not a 3D solid and was ignored.' : `${others} objects are not 3D solids and were ignored.`);
  if (solids.length === 0 && dimensions.length === 0) {
    ctx.log(`${NAME}: no 3D solids selected.`);
    return null;
  }
  return { solids, dimensions };
}

/** "1 solid", "2 solids and 1 dimension", "1 dimension". */
function objectCount(o: Objects3D): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  const parts = [o.solids.length || !o.dimensions.length ? n(o.solids.length, 'solid') : null, o.dimensions.length ? n(o.dimensions.length, 'dimension') : null];
  return parts.filter(Boolean).join(' and ');
}

/**
 * Apply the transform (one undo step) to the solids and 3D dimensions, or log why not; returns
 * true when the drawing changed.
 */
export function applyTransform(ctx: ToolContext, NAME: string, objects: readonly Solid3D[] | Objects3D, m: Mat4, verb: string): boolean {
  const o: Objects3D = 'solids' in objects ? objects : { solids: objects, dimensions: [] };
  try {
    commitSolidEdit(ctx, { solids: o.solids, ...(o.dimensions.length ? { dimensions: o.dimensions } : {}), matrix: m });
  } catch (err) {
    if (!(err instanceof RangeError) && !(err instanceof GeometryBudgetError)) throw err;
    ctx.log(`${NAME}: ${err.message} The drawing is unchanged.`);
    return false;
  }
  ctx.log(`${NAME}: ${objectCount(o)} ${verb}.`);
  return true;
}

/** A world vector given in construction-plane coordinates. */
function planeVector(frame: Frame3, d: Vec3): Vec3 {
  return sub3(planeToWorld(frame, { x: d.x, y: d.y }, d.z), frame.origin);
}

// ------------------------------------------------------------------ 3DMOVE

function* moveScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DMOVE';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const objects = yield* selectObjects3D(ctx, NAME);
  if (!objects) return;
  const solids = objects.solids;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  let base: Vec3 | null = null;
  for (;;) {
    const a = yield* ask3(ctx, st, 'Specify base point or [Displacement] <Displacement>:', { keywords: ['Displacement'] });
    if (a.kind === 'point') {
      base = a.point;
      break;
    }
    if (a.kind === 'keyword' || a.kind === 'enter') break;
  }
  let d: Vec3;
  if (!base) {
    const dl = transformDefaults.displacement;
    for (;;) {
      const a = yield* ask3(ctx, st, `Specify displacement <${num(dl.x)},${num(dl.y)},${num(dl.z)}>:`);
      if (a.kind === 'enter') {
        d = planeVector(plane, dl);
        break;
      }
      if (a.kind === 'point') {
        d = sub3(a.point, plane.origin);
        break;
      }
    }
  } else {
    const from = base;
    const preview3d = (c: Point | null) => (c ? ghostSolids(solids, translationMatrix(sub3(point3Of(ctx, c), from))) : []);
    for (;;) {
      st.last = from;
      const a = yield* ask3(ctx, st, 'Specify second point or <use first point as displacement>:', { preview3d });
      if (a.kind === 'enter') {
        d = sub3(from, plane.origin);
        break;
      }
      if (a.kind === 'point') {
        d = sub3(a.point, from);
        break;
      }
    }
  }
  if (!(len3(d) > 0)) {
    ctx.log(`${NAME}: zero displacement; nothing moved.`);
    return;
  }
  if (applyTransform(ctx, NAME, objects, translationMatrix(d), 'moved')) {
    const local = worldToPlane({ ...plane, origin: { x: 0, y: 0, z: 0 } }, d);
    transformDefaults.displacement = local;
    ctx.log(`Displacement: ${num(local.x)}, ${num(local.y)}, ${num(local.z)}`);
  }
}

/** 3DMOVE: select, base point or [Displacement], second point. */
export const move3dTool = (): Script3DTool => script3d('3DMOVE', (ctx) => clearingSelection(ctx, moveScript(ctx)));

// ------------------------------------------------------------------ 3DROTATE

/** A rotation axis: a point on it, its unit direction and the zero-angle direction (perpendicular). */
export interface RotationAxis {
  readonly origin: Vec3;
  readonly dir: Vec3;
  readonly ref: Vec3;
}

/** The axis X / Y / Z of `frame` through `origin`, with its zero-angle direction. */
export function planeAxis(frame: Frame3, which: 'X' | 'Y' | 'Z', origin: Vec3): RotationAxis {
  switch (which) {
    case 'X': return { origin, dir: frame.xAxis, ref: frame.yAxis };
    case 'Y': return { origin, dir: frame.yAxis, ref: frame.zAxis };
    case 'Z': return { origin, dir: frame.zAxis, ref: frame.xAxis };
  }
}

/** The axis through two points (null when they coincide). */
export function axisThrough(a: Vec3, b: Vec3): RotationAxis | null {
  const dir = normalize3(sub3(b, a));
  if (len3(dir) === 0) return null;
  return { origin: a, dir, ref: frameFromPlane({ origin: a, normal: dir }).xAxis };
}

/**
 * Angle (radians) of point `q` about the axis, measured from the axis's zero direction with the
 * right-hand rule; null when `q` lies on the axis.
 */
export function angleAboutAxis(axis: RotationAxis, q: Vec3): number | null {
  const v = sub3(q, axis.origin);
  const e2 = cross3(axis.dir, axis.ref);
  const x = dot3(v, axis.ref), y = dot3(v, e2);
  if (Math.hypot(x, y) <= 1e-12 * Math.max(1, len3(v))) return null;
  return Math.atan2(y, x);
}

const DEG = Math.PI / 180;

/** Ask for an angle in degrees, or a point whose angle about the axis gives it (radians out). */
function* angleInput(ctx: ToolContext, st: InputState, prompt: string, axis: RotationAxis, keywords: readonly string[], preview3d?: (c: Point | null) => readonly Solid3D[]): Step3<{ value: number } | { keyword: string } | null> {
  for (;;) {
    const a = yield* ask3(ctx, st, prompt, { numbers: true, keywords, preview3d });
    if (a.kind === 'enter') return null;
    if (a.kind === 'keyword') return { keyword: a.keyword };
    if (a.kind === 'number') return { value: a.value * DEG };
    const ang = angleAboutAxis(axis, a.point);
    if (ang === null) {
      ctx.log('The point lies on the rotation axis; pick another point or type an angle.');
      continue;
    }
    return { value: ang };
  }
}

/**
 * "Specify the reference angle <0>:": degrees, Enter for 0, or a point followed by a second point
 * (the angle of the direction between them about the axis). Null when abandoned.
 */
function* referenceAngle(ctx: ToolContext, st: InputState, ax: RotationAxis): Step3<number | null> {
  for (;;) {
    const a = yield* ask3(ctx, st, 'Specify the reference angle <0>:', { numbers: true });
    if (a.kind === 'enter') return 0;
    if (a.kind === 'number') return a.value * DEG;
    if (a.kind !== 'point') continue;
    const q = yield* point3(ctx, st, 'Specify second point:');
    if (!q) return null;
    const ang = angleAboutAxis({ ...ax, origin: a.point }, q.point);
    if (ang !== null) return ang;
    ctx.log('The two points lie along the rotation axis; the angle is undefined.');
  }
}

function* rotateScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DROTATE';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const objects = yield* selectObjects3D(ctx, NAME);
  if (!objects) return;
  const solids = objects.solids;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  const b = yield* point3(ctx, st, 'Specify base point:');
  if (!b) return;
  let axis: RotationAxis | null = null;
  while (!axis) {
    const a = yield* ask3(ctx, st, 'Specify rotation axis [X/Y/Z/2Points] <Z>:', { keywords: ['X', 'Y', 'Z', '2Points'], points: false });
    if (a.kind === 'enter') axis = planeAxis(plane, 'Z', b.point);
    else if (a.kind === 'keyword') {
      const which = a.keyword === 'X' ? 'X' : a.keyword === 'Y' ? 'Y' : a.keyword === 'Z' ? 'Z' : null;
      if (which) axis = planeAxis(plane, which, b.point);
      else {
        const p = yield* point3(ctx, st, 'Specify first point on axis:');
        if (!p) continue;
        const q = yield* point3(ctx, st, 'Specify second point on axis:');
        if (!q) continue;
        axis = axisThrough(p.point, q.point);
        if (!axis) ctx.log('The axis points coincide; specify two different points.');
      }
    }
  }
  const ax = axis;
  const matrix = (ang: number) => rotationAbout(ax.origin, ax.dir, ang);
  const cursorGhost = (c: Point | null) => {
    if (!c) return [];
    const ang = angleAboutAxis(ax, point3Of(ctx, c));
    return ang === null ? [] : ghostSolids(solids, matrix(ang));
  };
  let angle: number | null = null;
  while (angle === null) {
    const r = yield* angleInput(ctx, st, `Specify rotation angle or [Reference] <${num(transformDefaults.angle)}>:`, ax, ['Reference'], cursorGhost);
    if (r === null) {
      angle = transformDefaults.angle * DEG;
      break;
    }
    if ('value' in r) {
      angle = r.value;
      break;
    }
    // Reference: the reference angle (typed, or the direction between two points), then the new angle.
    const ref = yield* referenceAngle(ctx, st, ax);
    if (ref === null) continue;
    const refAngle = ref;
    const newGhost = (c: Point | null) => {
      if (!c) return [];
      const ang = angleAboutAxis(ax, point3Of(ctx, c));
      return ang === null ? [] : ghostSolids(solids, matrix(ang - refAngle));
    };
    const nr = yield* angleInput(ctx, st, 'Specify the new angle or [Points] <0>:', ax, ['Points'], newGhost);
    let next: number | null = null;
    if (nr === null) next = 0;
    else if ('value' in nr) next = nr.value;
    else {
      const p = yield* point3(ctx, st, 'Specify first point:');
      if (!p) continue;
      const q = yield* point3(ctx, st, 'Specify second point:');
      if (!q) continue;
      next = angleAboutAxis({ ...ax, origin: p.point }, q.point);
      if (next === null) {
        ctx.log('The two points lie along the rotation axis; the angle is undefined.');
        continue;
      }
    }
    angle = next - refAngle;
  }
  if (!Number.isFinite(angle)) {
    ctx.log(`${NAME}: the angle must be a finite number.`);
    return;
  }
  const turn = Math.abs(angle % (2 * Math.PI));
  if (turn < 1e-12 || Math.abs(turn - 2 * Math.PI) < 1e-12) {
    ctx.log(`${NAME}: zero rotation; nothing changed.`);
    return;
  }
  if (applyTransform(ctx, NAME, objects, matrix(angle), 'rotated')) {
    transformDefaults.angle = angle / DEG;
    ctx.log(`Rotation angle: ${num(angle / DEG)} degrees.`);
  }
}

/** 3DROTATE: select, base point, axis [X/Y/Z/2Points], angle or [Reference]. */
export const rotate3dTool = (): Script3DTool => script3d('3DROTATE', (ctx) => clearingSelection(ctx, rotateScript(ctx)));

// ------------------------------------------------------------------ 3DSCALE

/** Ask for a positive length: a number, a point (its distance from `from`), keywords, Enter = dfl. */
function* lengthInput(ctx: ToolContext, st: InputState, prompt: string, from: Vec3, dfl: number, keywords: readonly string[], preview3d?: (c: Point | null) => readonly Solid3D[]): Step3<{ value: number } | { keyword: string } | null> {
  for (;;) {
    const a = yield* ask3(ctx, st, prompt, { numbers: true, keywords, preview3d });
    if (a.kind === 'keyword') return { keyword: a.keyword };
    let v: number;
    if (a.kind === 'enter') v = dfl;
    else if (a.kind === 'number') v = a.value;
    else v = dist3(from, a.point);
    if (!(v > 0) || !Number.isFinite(v)) {
      ctx.log(`Value must be positive and finite (got ${Number.isFinite(v) ? Number(v.toFixed(6)) : String(v)}).`);
      continue;
    }
    return { value: v };
  }
}

function* scaleScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DSCALE';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const objects = yield* selectObjects3D(ctx, NAME);
  if (!objects) return;
  const solids = objects.solids;
  const st: InputState = { last: null };
  const b = yield* point3(ctx, st, 'Specify base point:');
  if (!b) return;
  const base = b.point;
  const ghostFor = (k: () => number | null) => {
    const v = k();
    return v !== null && v > 1e-12 && Number.isFinite(v) ? ghostSolids(solids, scalingAbout(base, v)) : [];
  };
  let factor: number | null = null;
  while (factor === null) {
    const r = yield* lengthInput(ctx, st, `Specify scale factor or [Reference] <${num(transformDefaults.scale)}>:`, base, transformDefaults.scale, ['Reference'],
      (c) => ghostFor(() => (c ? dist3(base, point3Of(ctx, c)) : null)));
    if (!r) return;
    if ('value' in r) {
      factor = r.value;
      break;
    }
    const ref = yield* twoPointLength(ctx, st, `Specify reference length <${num(transformDefaults.refLength)}>:`, transformDefaults.refLength);
    if (ref === null) continue;
    for (;;) {
      const nr = yield* lengthInput(ctx, st, `Specify new length or [Points] <${num(transformDefaults.newLength)}>:`, base, transformDefaults.newLength, ['Points'],
        (c) => ghostFor(() => (c ? dist3(base, point3Of(ctx, c)) / ref : null)));
      if (!nr) break;
      let next: number;
      if ('value' in nr) next = nr.value;
      else {
        const p = yield* point3(ctx, st, 'Specify first point:');
        if (!p) continue;
        const q = yield* point3(ctx, st, 'Specify second point:');
        if (!q) continue;
        next = dist3(p.point, q.point);
        if (!(next > 0)) {
          ctx.log('The two points coincide; the length must be positive.');
          continue;
        }
      }
      transformDefaults.refLength = ref;
      transformDefaults.newLength = next;
      factor = next / ref;
      break;
    }
  }
  if (Math.abs(factor - 1) < 1e-12) {
    ctx.log(`${NAME}: scale factor 1; nothing changed.`);
    return;
  }
  if (applyTransform(ctx, NAME, objects, scalingAbout(base, factor), 'scaled')) {
    transformDefaults.scale = factor;
    ctx.log(`Scale factor: ${num(factor)}.`);
  }
}

/**
 * A reference length: a positive number, Enter for `dfl`, or a picked / typed point followed by
 * a second point (their distance). Null when the answer was abandoned.
 */
function* twoPointLength(ctx: ToolContext, st: InputState, prompt: string, dfl: number): Step3<number | null> {
  for (;;) {
    const a = yield* ask3(ctx, st, prompt, { numbers: true });
    if (a.kind === 'enter') return dfl;
    if (a.kind === 'keyword') continue;
    if (a.kind === 'number') {
      if (a.value > 0 && Number.isFinite(a.value)) return a.value;
      ctx.log('Value must be positive and finite.');
      continue;
    }
    const first = a.point;
    const q = yield* point3(ctx, st, 'Specify second point:');
    if (!q) return null;
    const d = dist3(first, q.point);
    if (d > 0) return d;
    ctx.log('The two points coincide; the length must be positive.');
  }
}

/** 3DSCALE: select, base point, factor or [Reference]. */
export const scale3dTool = (): Script3DTool => script3d('3DSCALE', (ctx) => clearingSelection(ctx, scaleScript(ctx)));
