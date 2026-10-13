/**
 * Primitive solid commands (experimental, milestone 3): BOX, WEDGE, CYLINDER, CONE, SPHERE, TORUS.
 *
 * Prompts follow AutoCAD (options in brackets, the last value as <default>). Points are 3D points
 * through the tool context (`point3`: a solid face or the construction plane; typed "x,y" /
 * "x,y,z" in construction-plane coordinates). Sizes are typed or picked: radii in the plane
 * through the base point, heights along the plane normal (from the 3D view: where the cursor ray
 * passes the normal line; typed "x,y,z": its offset; in the plan view: the in-plane distance).
 * A negative height builds the solid below the plane. The solid is placed in a frame with the
 * construction plane's axes at the picked base point (primitives.ts placement conventions), on the
 * current layer with the current colour, as one undoable step. While a command runs, the solid
 * being built is shown as a ghost in the 3D view. Invalid sizes are reported and asked again.
 */
import { type Frame3, type Vec3, dist3, frameFromPlane, len3, sub3 } from '../model3d/math';
import { addSolids, newSolid } from '../model3d/model';
import { primitiveMesh } from '../model3d/primitives';
import type { PrimitiveFeature, Solid3D } from '../model3d/types';
import { dflt } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, flipFrame, frameAt, heightBetween, closestOnAxis, planarDistance, planeToWorld, point3Of, turnFrame, worldToPlane } from './context';
import { type InputState, type Script3DTool, type Step3, ask3, point3, script3d } from './script3d';
import type { Point } from '../core/geometry';

/** Sticky values shown as <default>, like AutoCAD's last-used sizes (per session). */
export const modellingDefaults = {
  height: null as number | null,
  radius: null as number | null,
  topRadius: 0,
  tubeRadius: null as number | null,
};

/** Forget the sticky sizes (tests). */
export function resetModellingDefaults(): void {
  modellingDefaults.height = null;
  modellingDefaults.radius = null;
  modellingDefaults.topRadius = 0;
  modellingDefaults.tubeRadius = null;
}

/** Id of ghost solids (never in the model). */
export const PREVIEW_ID = 'preview3d';

/** Prompt text: "Specify height or [2Point] <5.0000>:". */
export function promptText(ctx: ToolContext, text: string, keywords: readonly string[] = [], dfl: number | null = null): string {
  return `${text}${keywords.length ? ` or [${keywords.join('/')}]` : ''}${dfl !== null ? ` ${dflt(dfl, ctx)}` : ''}:`;
}

/** A solid for `feature` on the current layer with the current colour (throws RangeError). */
export function primitiveSolid(ctx: ToolContext, feature: PrimitiveFeature, id?: string): Solid3D {
  return newSolid({ id, mesh: primitiveMesh(feature), feature, layer: ctx.doc.currentLayer, color: ctx.doc.currentColor });
}

/** Ghost list for a feature builder (empty when the sizes are not valid yet). */
export function ghost(ctx: ToolContext, make: () => PrimitiveFeature | null): readonly Solid3D[] {
  try {
    const f = make();
    return f ? [primitiveSolid(ctx, f, PREVIEW_ID)] : [];
  } catch {
    return [];
  }
}

/** Add the solid; false (and the reason logged) when the sizes are refused. */
export function commitPrimitive(ctx: ToolContext, name: string, feature: PrimitiveFeature): Solid3D | null {
  let solid: Solid3D;
  try {
    solid = primitiveSolid(ctx, feature);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    ctx.log(`${name}: ${err.message}`);
    return null;
  }
  ctx.doc.updateModel3D((m) => addSolids(m, [solid]));
  return solid;
}

/** 3D commands edit model space only (refused with a message in a layout). */
export function modelSpaceOnly(ctx: ToolContext, name: string): boolean {
  if (!ctx.doc.space) return true;
  ctx.log(`${name}: 3D modelling works in model space only; switch to the Model tab.`);
  return false;
}

/** A small thickness so a flat ghost (base outline) is still a valid solid. */
function thin(size: number): number {
  return Math.max(Math.abs(size) * 2e-3, 1e-6);
}

/** Height picked at tool point `p2` (whose 3D point is `q`) along `normal` from `base`. */
function pickedHeight(ctx: ToolContext, p2: Point, q: Vec3, base: Vec3, normal: Vec3): number {
  const ray = ctx.ray3?.(p2) ?? null;
  if (ray) {
    const s = closestOnAxis(base, normal, ray);
    if (s !== null && Number.isFinite(s)) return s;
  }
  return heightBetween(base, q, normal);
}

/** Height under the cursor (for ghosts). */
function cursorHeight(ctx: ToolContext, cursor: Point, base: Vec3, normal: Vec3): number {
  return pickedHeight(ctx, cursor, point3Of(ctx, cursor), base, normal);
}

type Sized = { value: number } | { keyword: string } | null;

interface SizeOptions {
  readonly keywords?: readonly string[];
  /** Turns a picked point into the size (absent: points are refused). */
  readonly measure?: (q: Vec3, p2: Point) => number;
  readonly allowZero?: boolean;
  /** Ghost for a candidate size. */
  readonly preview?: (v: number) => PrimitiveFeature | null;
}

/**
 * Ask for a positive size (radius, length, tube radius): a number, a picked point (`measure`), an
 * option keyword, or Enter for `dfl` (without a default Enter asks again; Esc ends the command).
 * Non-positive or non-finite values are reported and asked again.
 */
function* size(ctx: ToolContext, st: InputState, text: string, dfl: number | null, opts: SizeOptions): Step3<Sized> {
  const keywords = opts.keywords ?? [];
  const prompt = promptText(ctx, text, keywords, dfl);
  for (;;) {
    const preview3d = opts.preview
      ? (c: Point | null) => ghost(ctx, () => {
        const v = c && opts.measure ? opts.measure(point3Of(ctx, c), c) : dfl;
        return v !== null && v > 0 ? opts.preview!(v) : null;
      })
      : undefined;
    const a = yield* ask3(ctx, st, prompt, { numbers: true, keywords, points: !!opts.measure, preview3d });
    let v: number;
    if (a.kind === 'keyword') return { keyword: a.keyword };
    if (a.kind === 'enter') {
      if (dfl === null) {
        ctx.log('Requires a value.');
        continue;
      }
      v = dfl;
    } else if (a.kind === 'number') v = a.value;
    else v = opts.measure!(a.point, a.p2);
    if (!Number.isFinite(v) || v < 0 || (v === 0 && !opts.allowZero)) {
      ctx.log(`Value must be ${opts.allowZero ? 'zero or positive' : 'positive'} and finite (got ${Number.isFinite(v) ? Number(v.toFixed(6)) : String(v)}).`);
      continue;
    }
    return { value: v };
  }
}

interface HeightOptions {
  /** Extra keywords after 2Point ("Axis endpoint", "Top radius"). */
  readonly keywords?: readonly string[];
  /** Picked heights are multiplied by this (2 for a box built around its centre). */
  readonly pickScale?: number;
  readonly preview: (h: number) => PrimitiveFeature | null;
}

/**
 * "Specify height or [2Point...] <d>:": a non-zero number (negative = below the plane), a picked
 * point (see the module comment), 2Point (the distance between two points), another keyword, or
 * Enter for the last height.
 */
function* height(ctx: ToolContext, st: InputState, base: Vec3, normal: Vec3, opts: HeightOptions): Step3<Sized> {
  const keywords = ['2Point', ...(opts.keywords ?? [])];
  const dfl = modellingDefaults.height;
  const k = opts.pickScale ?? 1;
  for (;;) {
    const preview3d = (c: Point | null) => ghost(ctx, () => {
      const h = c ? cursorHeight(ctx, c, base, normal) * k : dfl;
      return h !== null && h !== 0 && Number.isFinite(h) ? opts.preview(h) : null;
    });
    const a = yield* ask3(ctx, st, promptText(ctx, 'Specify height', keywords, dfl), { numbers: true, keywords, preview3d });
    let h: number;
    if (a.kind === 'keyword') {
      if (a.keyword !== '2POINT') return { keyword: a.keyword };
      const p = yield* point3(ctx, st, 'Specify first point:');
      if (!p) continue;
      const q = yield* point3(ctx, st, 'Specify second point:');
      if (!q) continue;
      h = dist3(p.point, q.point);
    } else if (a.kind === 'enter') {
      if (dfl === null) {
        ctx.log('Requires a value.');
        continue;
      }
      h = dfl;
    } else if (a.kind === 'number') h = a.value;
    else h = pickedHeight(ctx, a.p2, a.point, base, normal) * k;
    if (!Number.isFinite(h) || h === 0) {
      ctx.log('Height must be a non-zero finite number.');
      continue;
    }
    return { value: h };
  }
}

/** A frame along an axis from `base` to `end` (axis endpoint option), or null when they coincide. */
function axisFrame(base: Vec3, end: Vec3): { frame: Frame3; height: number } | null {
  const d = sub3(end, base);
  const h = len3(d);
  if (!(h > 1e-12) || !Number.isFinite(h)) return null;
  return { frame: frameFromPlane({ origin: base, normal: d }), height: h };
}

/** Frame for a primitive standing on the plane at `frame`, `h` high (below it when negative). */
function standing(frame: Frame3, h: number): Frame3 {
  return h < 0 ? flipFrame(frame) : frame;
}

// ------------------------------------------------------------------ BOX / WEDGE

/**
 * Box or wedge from plane-local sizes: `dx`, `dy` from the first corner (or full sizes around the
 * centre), height `h` (signed). The wedge's tall face stays at the first corner.
 */
export function boxFeature(kind: 'box' | 'wedge', at: Frame3, dx: number, dy: number, h: number, centered: boolean): PrimitiveFeature {
  const w = Math.abs(dx), d = Math.abs(dy), hh = Math.abs(h);
  let frame: Frame3;
  if (centered) {
    frame = frameAt(at, planeToWorld(at, { x: 0, y: 0 }, -hh / 2));
    if (kind === 'wedge' && dx < 0) frame = turnFrame(frame);
  } else {
    frame = frameAt(at, planeToWorld(at, { x: dx / 2, y: dy / 2 }));
    if (kind === 'wedge' && dx < 0) frame = turnFrame(frame);
    if (h < 0) frame = flipFrame(frame);
  }
  return { kind, frame, width: w, depth: d, height: hh };
}

function* boxScript(ctx: ToolContext, kind: 'box' | 'wedge'): Step3<void> {
  const NAME = kind.toUpperCase();
  if (!modelSpaceOnly(ctx, NAME)) return;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  const of = kind === 'wedge' ? ' of wedge' : '';
  let centered = false;
  let first: Vec3 | null = null;
  while (!first) {
    const a = yield* ask3(ctx, st, `Specify first corner${of} or [Center]:`, { keywords: ['Center'] });
    if (a.kind === 'enter') return;
    if (a.kind === 'point') first = a.point;
    else if (a.kind === 'keyword') {
      const c = yield* point3(ctx, st, `Specify center${of}:`);
      if (!c) return;
      centered = true;
      first = c.point;
    }
  }
  const at = frameAt(plane, first);
  const n = plane.zAxis;
  const sizes = (q: Vec3) => {
    const l = worldToPlane(at, q);
    return centered ? { dx: 2 * l.x, dy: 2 * l.y, dz: 2 * l.z } : { dx: l.x, dy: l.y, dz: l.z };
  };
  let dx = 0, dy = 0;
  let h: number | null = null;
  for (;;) {
    const preview3d = (c: Point | null) => ghost(ctx, () => {
      if (!c) return null;
      const s = sizes(point3Of(ctx, c));
      if (Math.abs(s.dx) < 1e-12 || Math.abs(s.dy) < 1e-12) return null;
      return boxFeature(kind, at, s.dx, s.dy, thin(Math.max(Math.abs(s.dx), Math.abs(s.dy))), centered);
    });
    const a = yield* ask3(ctx, st, 'Specify other corner or [Cube/Length]:', { keywords: ['Cube', 'Length'], preview3d });
    if (a.kind === 'enter') return;
    if (a.kind === 'point') {
      const s = sizes(a.point);
      if (Math.abs(s.dx) < 1e-12 || Math.abs(s.dy) < 1e-12) {
        ctx.log(`The ${kind} needs a non-zero length and width; pick a corner off the lines through the first point.`);
        continue;
      }
      dx = s.dx;
      dy = s.dy;
      // A corner typed with a z coordinate gives the height; picked corners are projected onto the base plane.
      if (a.typed3 && Math.abs(s.dz) > 1e-9 * Math.max(1, Math.abs(s.dx), Math.abs(s.dy))) h = s.dz;
      break;
    }
    if (a.kind !== 'keyword') continue;
    const measure = (q: Vec3) => planarDistance(at, first, q) * (centered ? 2 : 1);
    if (a.keyword === 'CUBE') {
      const L = yield* size(ctx, st, 'Specify length', null, { measure, preview: (v) => boxFeature(kind, at, v, v, v, centered) });
      if (!L || !('value' in L)) return;
      dx = dy = L.value;
      h = L.value;
      break;
    }
    const L = yield* size(ctx, st, 'Specify length', null, { measure, preview: (v) => boxFeature(kind, at, v, thin(v) * 10, thin(v), centered) });
    if (!L || !('value' in L)) return;
    const W = yield* size(ctx, st, 'Specify width', null, { measure, preview: (v) => boxFeature(kind, at, L.value, v, thin(Math.max(v, L.value)), centered) });
    if (!W || !('value' in W)) return;
    dx = L.value;
    dy = W.value;
    break;
  }
  if (h === null) {
    const baseCenter = centered ? first : planeToWorld(at, { x: dx / 2, y: dy / 2 });
    const r = yield* height(ctx, st, baseCenter, n, { pickScale: centered ? 2 : 1, preview: (v) => boxFeature(kind, at, dx, dy, v, centered) });
    if (!r || !('value' in r)) return;
    h = r.value;
  }
  if (commitPrimitive(ctx, NAME, boxFeature(kind, at, dx, dy, h, centered))) modellingDefaults.height = Math.abs(h);
}

/** BOX: first corner [Center], other corner [Cube/Length], height [2Point]. */
export const boxTool = (): Script3DTool => script3d('BOX', (ctx) => boxScript(ctx, 'box'));
/** WEDGE: as BOX; the sloped face falls from the first corner's side. */
export const wedgeTool = (): Script3DTool => script3d('WEDGE', (ctx) => boxScript(ctx, 'wedge'));

// ------------------------------------------------------------------ CYLINDER / CONE

function* roundScript(ctx: ToolContext, kind: 'cylinder' | 'cone'): Step3<void> {
  const NAME = kind.toUpperCase();
  if (!modelSpaceOnly(ctx, NAME)) return;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  const c = yield* point3(ctx, st, 'Specify center point of base:');
  if (!c) return;
  const center = c.point;
  const at = frameAt(plane, center);
  let top = kind === 'cone' ? modellingDefaults.topRadius : 0;
  const make = (frame: Frame3, r: number, h: number): PrimitiveFeature => (kind === 'cylinder'
    ? { kind, frame: standing(frame, h), radius: r, height: Math.abs(h) }
    : { kind, frame: standing(frame, h), baseRadius: r, topRadius: top, height: Math.abs(h) });
  const measure = (q: Vec3) => planarDistance(at, center, q);
  let r: number | null = null;
  while (r === null) {
    const dh = modellingDefaults.height;
    const a = yield* size(ctx, st, 'Specify base radius', modellingDefaults.radius, {
      keywords: ['Diameter'], measure, preview: (v) => make(at, v, dh ?? thin(v)),
    });
    if (!a) return;
    if ('value' in a) {
      r = a.value;
      break;
    }
    const d = yield* size(ctx, st, 'Specify diameter', modellingDefaults.radius !== null ? 2 * modellingDefaults.radius : null, {
      measure: (q) => 2 * measure(q), preview: (v) => make(at, v / 2, dh ?? thin(v)),
    });
    if (d && 'value' in d) r = d.value / 2;
  }
  const radius = r;
  const extra = kind === 'cone' ? ['Axis endpoint', 'Top radius'] : ['Axis endpoint'];
  for (;;) {
    const hr = yield* height(ctx, st, center, plane.zAxis, { keywords: extra, preview: (v) => make(at, radius, v) });
    if (!hr) return;
    if ('value' in hr) {
      if (commitPrimitive(ctx, NAME, make(at, radius, hr.value))) {
        modellingDefaults.height = Math.abs(hr.value);
        modellingDefaults.radius = radius;
      }
      return;
    }
    if (hr.keyword === 'TOP RADIUS') {
      const t = yield* size(ctx, st, 'Specify top radius', top, { allowZero: true, measure, preview: (v) => ({ kind: 'cone', frame: at, baseRadius: radius, topRadius: v, height: modellingDefaults.height ?? radius }) });
      if (t && 'value' in t) {
        top = t.value;
        modellingDefaults.topRadius = top;
      }
      continue;
    }
    // Axis endpoint: the axis direction and the height from one point.
    const preview3d = (cur: Point | null) => ghost(ctx, () => {
      const f = cur ? axisFrame(center, point3Of(ctx, cur)) : null;
      return f ? make(f.frame, radius, f.height) : null;
    });
    const e = yield* point3(ctx, st, 'Specify axis endpoint:', preview3d);
    if (!e) continue;
    const f = axisFrame(center, e.point);
    if (!f) {
      ctx.log('The axis endpoint must differ from the center point.');
      continue;
    }
    if (commitPrimitive(ctx, NAME, make(f.frame, radius, f.height))) {
      modellingDefaults.height = f.height;
      modellingDefaults.radius = radius;
    }
    return;
  }
}

/** CYLINDER: center point of base, base radius [Diameter], height [2Point/Axis endpoint]. */
export const cylinderTool = (): Script3DTool => script3d('CYLINDER', (ctx) => roundScript(ctx, 'cylinder'));
/** CONE: as CYLINDER plus [Top radius] (default 0: a pointed cone; > 0: a frustum). */
export const coneTool = (): Script3DTool => script3d('CONE', (ctx) => roundScript(ctx, 'cone'));

// ------------------------------------------------------------------ SPHERE

function* sphereScript(ctx: ToolContext): Step3<void> {
  if (!modelSpaceOnly(ctx, 'SPHERE')) return;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  const c = yield* point3(ctx, st, 'Specify center point:');
  if (!c) return;
  const at = frameAt(plane, c.point);
  const make = (r: number): PrimitiveFeature => ({ kind: 'sphere', frame: at, radius: r });
  const measure = (q: Vec3) => dist3(c.point, q);
  for (;;) {
    const a = yield* size(ctx, st, 'Specify radius', modellingDefaults.radius, { keywords: ['Diameter'], measure, preview: make });
    if (!a) return;
    let r: number;
    if ('value' in a) r = a.value;
    else {
      const d = yield* size(ctx, st, 'Specify diameter', modellingDefaults.radius !== null ? 2 * modellingDefaults.radius : null, { measure: (q) => 2 * measure(q), preview: (v) => make(v / 2) });
      if (!d || !('value' in d)) continue;
      r = d.value / 2;
    }
    if (commitPrimitive(ctx, 'SPHERE', make(r))) modellingDefaults.radius = r;
    return;
  }
}

/** SPHERE: center point, radius [Diameter]. */
export const sphereTool = (): Script3DTool => script3d('SPHERE', sphereScript);

// ------------------------------------------------------------------ TORUS

function* torusScript(ctx: ToolContext): Step3<void> {
  if (!modelSpaceOnly(ctx, 'TORUS')) return;
  const plane = constructionPlaneOf(ctx);
  const st: InputState = { last: null };
  const c = yield* point3(ctx, st, 'Specify center point:');
  if (!c) return;
  const center = c.point;
  const at = frameAt(plane, center);
  const measure = (q: Vec3) => planarDistance(at, center, q);
  const make = (R: number, r: number): PrimitiveFeature => ({ kind: 'torus', frame: at, majorRadius: R, minorRadius: r });
  const guessTube = (R: number) => Math.min(modellingDefaults.tubeRadius ?? R / 4, R / 2);
  let R: number | null = null;
  while (R === null) {
    const a = yield* size(ctx, st, 'Specify radius', modellingDefaults.radius, { keywords: ['Diameter'], measure, preview: (v) => make(v, guessTube(v)) });
    if (!a) return;
    if ('value' in a) R = a.value;
    else {
      const d = yield* size(ctx, st, 'Specify diameter', modellingDefaults.radius !== null ? 2 * modellingDefaults.radius : null, { measure: (q) => 2 * measure(q), preview: (v) => make(v / 2, guessTube(v / 2)) });
      if (d && 'value' in d) R = d.value / 2;
    }
  }
  const major = R;
  const tubeMeasure = (q: Vec3) => Math.abs(measure(q) - major);
  for (;;) {
    const a = yield* size(ctx, st, 'Specify tube radius', modellingDefaults.tubeRadius, { keywords: ['2Point', 'Diameter'], measure: tubeMeasure, preview: (v) => make(major, v) });
    if (!a) return;
    let r: number;
    if ('value' in a) r = a.value;
    else if (a.keyword === 'DIAMETER') {
      const d = yield* size(ctx, st, 'Specify tube diameter', modellingDefaults.tubeRadius !== null ? 2 * modellingDefaults.tubeRadius : null, { measure: (q) => 2 * tubeMeasure(q), preview: (v) => make(major, v / 2) });
      if (!d || !('value' in d)) continue;
      r = d.value / 2;
    } else {
      const p = yield* point3(ctx, st, 'Specify first point:');
      if (!p) continue;
      const q = yield* point3(ctx, st, 'Specify second point:');
      if (!q) continue;
      r = dist3(p.point, q.point);
    }
    if (!(r > 0 && r < major)) {
      ctx.log(`The tube radius must be positive and smaller than the torus radius (${Number(major.toFixed(6))}); self-intersecting tori are not supported.`);
      continue;
    }
    if (commitPrimitive(ctx, 'TORUS', make(major, r))) {
      modellingDefaults.radius = major;
      modellingDefaults.tubeRadius = r;
    }
    return;
  }
}

/** TORUS: center point, radius [Diameter], tube radius [2Point/Diameter]. */
export const torusTool = (): Script3DTool => script3d('TORUS', torusScript);
