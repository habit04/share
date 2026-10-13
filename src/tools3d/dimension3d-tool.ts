/**
 * DIM3D (experimental, docs/3D-DIMENSIONS.md): a true 3D dimension in its own measurement plane
 * (src/model3d/dimension3d.ts), stored in `DrawingState.model3d.dimensions`. The 3DDIM prototype
 * (src/tools3d/dim3d.ts, a 2D dimension of projected points) stays as it was.
 *
 * Prompts (the shown options always have distinct first letters, except "ANgular" next to
 * "Aligned" in Linear mode, where a click on an option sends its first letter: type AN there):
 * - Aligned (default): `Specify first extension line origin or [Linear/Angular/Plane/Text]:`,
 *   `Specify second extension line origin:`, `Specify dimension line location or [Text] <offset>:`.
 * - Linear: the same points, then `Specify dimension line location or [X/Y/Text] <offset>:`; it
 *   measures along the plane's X or Y axis, chosen like AutoCAD's DIMLINEAR from where the location
 *   lies (above / below the points: X, beside them: Y) unless X or Y was typed.
 * - Angular: `Specify angle vertex or [...]:`, `Specify first angle endpoint:`, `Specify second angle
 *   endpoint:`, `Specify dimension arc location or [Text] <radius>:` (the side of the location picks
 *   which of the two angles between the legs is measured).
 * - Plane: `Specify measurement plane [Current/Face/3Points] <Current>:`. Current (the default) is
 *   the construction plane's orientation through the first point; Face is the plane of a picked
 *   solid face (origin at the pick, X axis by the arbitrary axis rule); 3Points takes an origin, a
 *   point on the positive X axis and a point on the positive-Y side of the plane.
 * - Text: `Enter dimension text <measurement>:` (free text, `<>` = the measurement, Enter = none).
 *
 * Points are 3D points (`point3`: 3D object snaps in the 3D view, typed x,y / x,y,z / @... in
 * construction-plane coordinates). A point off the measurement plane is projected along its
 * normal: the dimension is then `projected`, its text ends in "(projected)" and the command logs
 * the true 3D distance. While the location is asked the dimension follows the cursor (rubber band
 * in the 3D view). The dimension is added in ONE undo step; current layer, ByLayer colour and the
 * current dimension style.
 */
import type { Point } from '../core/geometry';
import { formatAngle, formatLength } from '../core/units';
import { type Frame3, type Vec3, cross3, frameFromPlane, len3, normalize3, sub3 } from '../model3d/math';
import { addDimensions3D } from '../model3d/model';
import {
  dimension3dKindLabel, dimension3dMeasurement, dimension3dText, dimension3dTrueDistance, coincidenceTolerance, makeDimension3D, planeDescription, planeLocal, planeWorld,
} from '../model3d/dimension3d';
import type { Dimension3D, Dimension3DKind } from '../model3d/types';
import type { Answer } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, frameAt, point3Of } from './context';
import { modelSpaceOnly } from './primitives';
import { type InputState, type Script3DTool, type Step3, ask3, point3, script3d } from './script3d';

const NAME = 'DIM3D';

/** The measurement plane chosen with the Plane option (null = the construction plane through the first point). */
interface PlaneChoice {
  readonly frame: Frame3;
  readonly name: string;
}

/**
 * A frame from three points: origin `o`, X axis toward `px`, XY plane through `py` (on its positive
 * Y side). Null when the points are (nearly) collinear or coincide.
 */
export function frameFrom3Points(o: Vec3, px: Vec3, py: Vec3): Frame3 | null {
  const dx = sub3(px, o), dy = sub3(py, o);
  const lx = len3(dx), ly = len3(dy);
  if (!(lx > 1e-12) || !(ly > 1e-12)) return null;
  const x = normalize3(dx);
  const zRaw = cross3(x, dy);
  if (!(len3(zRaw) > 1e-9 * ly)) return null;
  const z = normalize3(zRaw);
  const y = cross3(z, x);
  return { origin: o, xAxis: x, yAxis: y, zAxis: z };
}

/** The axis a linear dimension measures for a location (AutoCAD DIMLINEAR rule), in plane coordinates. */
export function autoLinearAxis(a: Point, b: Point, loc: Point): 'x' | 'y' {
  const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  const ox = outside(loc.x, Math.min(a.x, b.x), Math.max(a.x, b.x));
  const oy = outside(loc.y, Math.min(a.y, b.y), Math.max(a.y, b.y));
  if (ox === 0 && oy === 0) return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'x' : 'y';
  return oy >= ox ? 'x' : 'y';
}

/** Free-text answer (Text option): the typed text, or null on Enter. */
function* askText(prompt: string): Step3<string | null> {
  for (;;) {
    const a: Answer = yield { prompt, distance: false, free: true };
    if (a.type === 'enter') return null;
    if (a.type === 'text') return a.text;
  }
}

function* textOption(ctx: ToolContext, current: string | undefined): Step3<string | undefined> {
  const t = yield* askText(`Enter dimension text <${current === undefined ? 'measurement' : current}>:`);
  const next = t === null || t === '' || t === '<>' ? undefined : t;
  ctx.log(next === undefined ? 'Dimension text: the measurement.' : `Dimension text: ${next}`);
  return next;
}

/** The Plane option: Current, Face or 3Points. Returns the choice (null = Current) or undefined when abandoned. */
function* planeOption(ctx: ToolContext, st: InputState): Step3<PlaneChoice | null | undefined> {
  for (;;) {
    const a = yield* ask3(ctx, st, 'Specify measurement plane [Current/Face/3Points] <Current>:', { keywords: ['Current', 'Face', '3Points'], points: false });
    if (a.kind === 'enter' || (a.kind === 'keyword' && a.keyword === 'CURRENT')) {
      ctx.log(`Measurement plane: the ${ctx.constructionPlaneName ?? 'World'} construction plane through the first point.`);
      return null;
    }
    if (a.kind !== 'keyword') continue;
    if (a.keyword === 'FACE') {
      for (;;) {
        const p = yield* point3(ctx, st, 'Select a face of a solid:');
        if (!p) return undefined;
        const hit = ctx.face3?.(p.p2) ?? null;
        if (!hit) {
          ctx.log('No solid face there; pick a face of a solid.');
          continue;
        }
        const frame = frameFromPlane({ origin: hit.point, normal: hit.normal });
        ctx.log(`Measurement plane: the picked face (${planeDescription(frame)}).`);
        return { frame, name: 'Face' };
      }
    }
    // 3Points
    const o = yield* point3(ctx, st, 'Specify origin point of the plane:');
    if (!o) return undefined;
    const px = yield* point3(ctx, st, 'Specify point on positive X axis:');
    if (!px) return undefined;
    const py = yield* point3(ctx, st, 'Specify point on positive-Y side of the XY plane:');
    if (!py) return undefined;
    const frame = frameFrom3Points(o.point, px.point, py.point);
    if (!frame) {
      ctx.log('The three points do not define a plane (they coincide or lie on one line).');
      continue;
    }
    ctx.log(`Measurement plane: 3 points (${planeDescription(frame)}).`);
    return { frame, name: '3 points' };
  }
}

/**
 * The prompt of the first point for each kind (Aligned is the default) and its keywords. The
 * shown kinds take their first letter (A = Angular while Aligned is current, A = Aligned
 * otherwise); the kind not shown can still be typed (AL / AN / L).
 */
function firstPrompt(kind: Dimension3DKind): { prompt: string; keywords: string[] } {
  switch (kind) {
    case 'aligned':
      return { prompt: 'Specify first extension line origin or [Linear/Angular/Plane/Text]:', keywords: ['Linear', 'Angular', 'Plane', 'Text', 'ALigned'] };
    case 'linear':
      return { prompt: 'Specify first extension line origin or [Aligned/ANgular/Plane/Text]:', keywords: ['Aligned', 'ANgular', 'Plane', 'Text', 'Linear'] };
    case 'angular':
      return { prompt: 'Specify angle vertex or [Aligned/Linear/Plane/Text]:', keywords: ['Aligned', 'Linear', 'Plane', 'Text', 'ANgular'] };
  }
}

function* dim3dScript(ctx: ToolContext): Step3<void> {
  if (!modelSpaceOnly(ctx, NAME)) return;
  if (ctx.wantsPreview3d?.() === false) ctx.log(`${NAME}: 3D dimensions are drawn in the 3D view (3DMODE); the 2D view does not show them.`);
  const st: InputState = { last: null };
  let kind: Dimension3DKind = 'aligned';
  let choice: PlaneChoice | null = null;
  let text: string | undefined;
  // First point (or the vertex), with the options.
  let first: Vec3 | null = null;
  while (!first) {
    const f = firstPrompt(kind);
    const a = yield* ask3(ctx, st, f.prompt, { keywords: f.keywords });
    if (a.kind === 'enter') return;
    if (a.kind === 'point') first = a.point;
    else if (a.kind === 'keyword') {
      if (a.keyword === 'ALIGNED') kind = 'aligned';
      else if (a.keyword === 'LINEAR') kind = 'linear';
      else if (a.keyword === 'ANGULAR') kind = 'angular';
      else if (a.keyword === 'TEXT') text = yield* textOption(ctx, text);
      else if (a.keyword === 'PLANE') {
        const c = yield* planeOption(ctx, st);
        if (c !== undefined) choice = c;
      }
    }
  }
  const plane = choice ? choice.frame : frameAt(constructionPlaneOf(ctx), first);
  const planeName = choice ? choice.name : ctx.constructionPlaneName ?? 'World';
  const local = (q: Vec3): Point => {
    const l = planeLocal(plane, q);
    return { x: l.x, y: l.y };
  };
  const tiny = (q: readonly Vec3[]) => coincidenceTolerance(plane, q);
  // Remaining definition points.
  let p1: Vec3, p2: Vec3, vertex: Vec3 | undefined;
  if (kind === 'angular') {
    vertex = first;
    const v = local(first);
    const leg = function* (prompt: string): Step3<Vec3 | null> {
      for (;;) {
        const p = yield* point3(ctx, st, prompt);
        if (!p) return null;
        const q = local(p.point);
        if (Math.hypot(q.x - v.x, q.y - v.y) > tiny([first!, p.point])) return p.point;
        ctx.log('That point coincides with the vertex in the measurement plane; pick another point.');
      }
    };
    const a = yield* leg('Specify first angle endpoint:');
    if (!a) return;
    let b: Vec3 | null = null;
    while (!b) {
      b = yield* leg('Specify second angle endpoint:');
      if (!b) return;
      const ua = local(a), ub = local(b);
      const ax = ua.x - v.x, ay = ua.y - v.y, bx = ub.x - v.x, by = ub.y - v.y;
      if (Math.abs(ax * by - ay * bx) < 1e-12 * Math.hypot(ax, ay) * Math.hypot(bx, by) && ax * bx + ay * by > 0) {
        ctx.log('Both legs have the same direction; pick a second endpoint on another line.');
        b = null;
      }
    }
    p1 = a;
    p2 = b;
  } else {
    p1 = first;
    let second: Vec3 | null = null;
    while (!second) {
      const p = yield* point3(ctx, st, 'Specify second extension line origin:');
      if (!p) return;
      const a = local(p1), b = local(p.point);
      if (kind === 'aligned' && !(Math.hypot(b.x - a.x, b.y - a.y) > tiny([p1, p.point]))) {
        ctx.log('The points coincide in the measurement plane; pick another second point.');
        continue;
      }
      second = p.point;
    }
    p2 = second;
  }
  // Location of the dimension line (or arc), with the rubber band.
  let forced: 'x' | 'y' | null = null;
  const a2 = local(p1), b2 = local(p2);
  const base = { layer: ctx.doc.currentLayer, color: 'ByLayer' as const, kind, plane, p1, p2, ...(vertex ? { vertex } : {}), style: ctx.doc.header.dimStyle };
  const build = (location: Vec3): Dimension3D => {
    const axis = kind === 'linear' ? forced ?? autoLinearAxis(a2, b2, local(location)) : undefined;
    return makeDimension3D({ ...base, ...(axis ? { axis } : {}), location, textOverride: text });
  };
  const defaultLocation = (): Vec3 => {
    if (kind === 'angular') {
      const v = vertex!;
      const r = Math.min(len3(sub3(p1, v)), len3(sub3(p2, v))) * 0.6;
      // Halfway round the counter-clockwise angle from leg 1 to leg 2 (the angle smaller than a turn).
      const l = planeLocal(plane, v), u1 = local(p1), u2 = local(p2);
      const t1 = Math.atan2(u1.y - l.y, u1.x - l.x), t2 = Math.atan2(u2.y - l.y, u2.x - l.x);
      let sweep = t2 - t1;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const mid = t1 + sweep / 2;
      const rr = r > 0 ? r : 1;
      return planeWorld(plane, { x: l.x + rr * Math.cos(mid), y: l.y + rr * Math.sin(mid) });
    }
    const len = Math.hypot(b2.x - a2.x, b2.y - a2.y);
    const d = len > 0 ? len * 0.2 : 1;
    const ux = len > 0 ? (b2.x - a2.x) / len : 1, uy = len > 0 ? (b2.y - a2.y) / len : 0;
    // A fifth of the length to the left of p1 -> p2 (above the points for a linear X dimension).
    const off = kind === 'linear' ? (forced === 'y' ? { x: -d, y: 0 } : { x: 0, y: d }) : { x: -uy * d, y: ux * d };
    return planeWorld(plane, { x: (a2.x + b2.x) / 2 + off.x, y: (a2.y + b2.y) / 2 + off.y });
  };
  const previewDimensions = (c: Point | null): Dimension3D[] => (c ? [build(point3Of(ctx, c))] : []);
  let dim: Dimension3D | null = null;
  while (!dim) {
    const prompt = kind === 'angular' ? 'Specify dimension arc location or [Text] <default radius>:' : kind === 'linear' ? 'Specify dimension line location or [X/Y/Text] <default offset>:' : 'Specify dimension line location or [Text] <default offset>:';
    const keywords = kind === 'linear' ? ['X', 'Y', 'Text'] : ['Text'];
    const a = yield* ask3(ctx, st, prompt, { keywords, previewDimensions });
    try {
      if (a.kind === 'point') dim = build(a.point);
      else if (a.kind === 'enter') dim = build(defaultLocation());
      else if (a.kind === 'keyword') {
        if (a.keyword === 'TEXT') text = yield* textOption(ctx, text);
        else forced = a.keyword === 'X' ? 'x' : 'y';
      }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      ctx.log(`${NAME}: ${err.message}`);
    }
  }
  const made = dim;
  ctx.doc.updateModel3D((m) => addDimensions3D(m, [made]));
  const units = ctx.doc.header.units;
  const value = dimension3dMeasurement(made);
  const measured = made.kind === 'angular' ? `${formatAngle(value, Math.max(2, units.auprec))} degrees` : formatLength(value, units);
  ctx.log(`${NAME}: ${dimension3dKindLabel(made)} dimension in the ${planeName} plane (${planeDescription(plane)}). Dimension text = ${dimension3dText(made)} (measured ${measured})`);
  if (made.projected) {
    const off = made.kind === 'angular' ? 'a point is off the measurement plane: the dimension measures the angle of the projected legs.' : `a point is off the measurement plane: the dimension measures the projected ${made.kind === 'linear' ? 'separation' : 'distance'} ${measured}. True 3D distance: ${formatLength(dimension3dTrueDistance(made), units)}.`;
    ctx.log(`${NAME}: ${off}`);
  }
}

/** DIM3D [Aligned/Linear/Angular/Plane/Text]: a true 3D dimension in its measurement plane. */
export const dimension3dTool = (): Script3DTool => script3d(NAME, dim3dScript);
