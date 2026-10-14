/**
 * 3D measurement commands (experimental, milestone 4 of docs/3D-PLAN.md): 3DDIST (also what DIST
 * runs while 3D mode is on), 3DMASSPROP and 3DAREA. Results go to the command line with the
 * drawing's length formatting (`formatLength`, LUNITS / LUPREC); angles use AUPREC.
 *
 * - 3DDIST: two 3D points. Distance, angle in the construction plane's XY plane, angle from that
 *   plane (signed: negative below it), Delta X / Y / Z in construction-plane coordinates, and the
 *   planar distance (the distance projected onto the plane).
 * - 3DMASSPROP (MASSPROP-lite): the selected solids' volume, surface area, bounding box and
 *   centroid (construction-plane coordinates; the WCS with the default plane). For several solids
 *   the values are summed (overlapping volume counts once per solid; the command says so).
 * - 3DAREA: pick a face of a solid; the planar face (connected coplanar triangles around the hit,
 *   `faceRegion`) gives the area and perimeter.
 */
import { type Frame3, type Vec3, add3, cross3, dot3, len3, scale3, sub3 } from '../model3d/math';
import { type Mesh3D, meshTriangles, meshVertexCount, meshVertex } from '../model3d/mesh';
import { solidById } from '../model3d/model';
import { formatAngle, formatArea, formatLength } from '../core/units';
import type { ToolContext } from '../tools/types';
import { constructionPlaneOf, solidsOf, worldToPlane } from './context';
import { modelSpaceOnly } from './primitives';
import { type InputState, type Script3DTool, type Step3, clearingSelection, point3, script3d } from './script3d';
import { faceRegion } from './snap3d';
import { selectSolids } from './transform';

const fl = (ctx: ToolContext, v: number) => formatLength(v, ctx.doc.header.units);
/** Volumes in decimal notation with the length precision (cubic units have no LUNITS form). */
const fv = (ctx: ToolContext, v: number) => formatLength(v, { lunits: 2, luprec: ctx.doc.header.units.luprec });
const auprec = (ctx: ToolContext) => Math.max(2, ctx.doc.header.units.auprec);

/** The measurements between two points, in the coordinates of `frame`. */
export interface Distance3 {
  readonly distance: number;
  readonly delta: Vec3;
  /** Distance projected onto the frame's XY plane. */
  readonly planar: number;
  /** Angle of the projected direction in the XY plane (radians, counter-clockwise from +X). */
  readonly angleInPlane: number;
  /** Elevation angle from the XY plane (radians, -pi/2 .. pi/2, negative below it). */
  readonly angleFromPlane: number;
}

/** Distance, deltas and angles from `a` to `b` measured in `frame` (pure). */
export function measureDistance(frame: Frame3, a: Vec3, b: Vec3): Distance3 {
  // Project the displacement once: separately projecting absolute points can lose
  // a small, representable component when the frame origin or another axis is large.
  const worldDelta = sub3(b, a);
  const delta = { x: dot3(worldDelta, frame.xAxis), y: dot3(worldDelta, frame.yAxis), z: dot3(worldDelta, frame.zAxis) };
  const planar = Math.hypot(delta.x, delta.y);
  return {
    distance: len3(worldDelta),
    delta,
    planar,
    angleInPlane: Math.atan2(delta.y, delta.x),
    angleFromPlane: Math.atan2(delta.z, planar),
  };
}

/** The DIST report lines (the 2D DIST layout, with the 3D values and the planar distance added). */
export function distanceReport(ctx: ToolContext, m: Distance3): string[] {
  const elev = (m.angleFromPlane * 180) / Math.PI;
  const p = auprec(ctx);
  // Format first: a numeric half-unit comparison can miss an exact boundary
  // value that toFixed rounds to signed zero. Other boundaries round away.
  const fixed = elev.toFixed(p);
  const elevText = /^-0(\.0*)?$/.test(fixed) ? fixed.slice(1) : fixed;
  const zero = fl(ctx, 0);
  const shownDelta = [m.delta.x, m.delta.y, m.delta.z].map(value => {
    const text = fl(ctx, value);
    return text === '-' + zero ? zero : text;
  });
  // A near-normal direction has no reportable XY angle when BOTH printed XY
  // components are zero. Keep the actual deltas: scientific units can expose tiny
  // genuine components, indistinguishable from rotation residue without provenance.
  const normal = Math.abs(elev).toFixed(p) === (90).toFixed(p);
  const inPlane = normal && shownDelta[0] === zero && shownDelta[1] === zero ? 0 : m.angleInPlane;
  const planeName = ctx.constructionPlaneName ?? 'World';
  return [
    `Distance = ${fl(ctx, m.distance)}, Angle in XY Plane = ${formatAngle(inPlane, p)}, Angle from XY Plane = ${elevText}`,
    `Delta X = ${shownDelta[0]}, Delta Y = ${shownDelta[1]}, Delta Z = ${shownDelta[2]}`,
    `Planar distance (XY plane of the ${planeName} construction plane) = ${fl(ctx, m.planar)}`,
  ];
}

function* distScript(ctx: ToolContext): Step3<void> {
  const st: InputState = { last: null };
  const a = yield* point3(ctx, st, 'Specify first point:');
  if (!a) return;
  const b = yield* point3(ctx, st, 'Specify second point:');
  if (!b) return;
  for (const line of distanceReport(ctx, measureDistance(constructionPlaneOf(ctx), a.point, b.point))) ctx.log(line);
}

/** 3DDIST (and DIST in 3D mode, under that name): first point, second point. */
export const dist3dTool = (name = '3DDIST'): Script3DTool => script3d(name, distScript);

// ------------------------------------------------------------------ mass properties

/** Volume, surface area and centroid of a closed outward mesh (pure). */
export interface MassProperties {
  /** Signed volume; numerically unresolved cancellation is reported as zero. */
  readonly volume: number;
  readonly area: number;
  /** Volume centroid (world). For a zero-volume mesh, the vertex average. */
  readonly centroid: Vec3;
}

/**
 * Mass properties by the divergence theorem: signed tetrahedra (o, a, b, c) for volume and
 * centroid, with o the first vertex (avoids cancellation far from the origin).
 * A cancelling sum within its floating-point arithmetic bound uses the vertex
 * average instead. This depends on actual determinant products, not a creator's
 * size/aspect-ratio admission rule, so well-resolved thin imported solids survive.
 */
export function meshMassProperties(mesh: Mesh3D): MassProperties {
  const n = meshVertexCount(mesh);
  if (n === 0) return { volume: 0, area: 0, centroid: { x: 0, y: 0, z: 0 } };
  const o = meshVertex(mesh, 0);
  let six = 0, area = 0, absoluteProducts = 0, absoluteVolumes = 0, triangles = 0;
  let cx = 0, cy = 0, cz = 0;
  for (const { a, b, c } of meshTriangles(mesh)) {
    const ea = sub3(a, o), eb = sub3(b, o), ec = sub3(c, o);
    const v6 = dot3(ea, cross3(eb, ec));
    six += v6;
    absoluteProducts += Math.abs(ea.x * eb.y * ec.z) + Math.abs(ea.x * eb.z * ec.y)
      + Math.abs(ea.y * eb.z * ec.x) + Math.abs(ea.y * eb.x * ec.z)
      + Math.abs(ea.z * eb.x * ec.y) + Math.abs(ea.z * eb.y * ec.x);
    absoluteVolumes += Math.abs(v6); triangles++;
    // Tetra centroid relative to o is (ea + eb + ec) / 4.
    cx += v6 * (ea.x + eb.x + ec.x);
    cy += v6 * (ea.y + eb.y + ec.y);
    cz += v6 * (ea.z + eb.z + ec.z);
    area += len3(cross3(sub3(b, a), sub3(c, a))) / 2;
  }
  const volume = six / 6;
  const roundoff = Number.EPSILON / 2;
  const gamma = (operations: number) => operations * roundoff / (1 - operations * roundoff);
  // Eight operations cover local subtraction/product/determinant arithmetic;
  // the triangle-count term covers summing the signed determinants. Inflate the
  // positive magnitude accumulators by their own summation error as well.
  const error = (gamma(8) * absoluteProducts + gamma(triangles) * absoluteVolumes) / (1 - gamma(6 * triangles));
  if (six === 0 || Number.isFinite(six) && Number.isFinite(error) && Math.abs(six) <= error) {
    let sum = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) sum = add3(sum, meshVertex(mesh, i));
    return { volume: 0, area, centroid: scale3(sum, 1 / n) };
  }
  return { volume, area, centroid: add3(o, { x: cx / (4 * six), y: cy / (4 * six), z: cz / (4 * six) }) };
}

/** Bounding box of a mesh in the coordinates of `frame`. */
export function boundsInFrame(mesh: Mesh3D, frame: Frame3): { min: Vec3; max: Vec3 } | null {
  const n = meshVertexCount(mesh);
  if (n === 0) return null;
  let min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < n; i++) {
    const p = worldToPlane(frame, meshVertex(mesh, i));
    min = { x: Math.min(min.x, p.x), y: Math.min(min.y, p.y), z: Math.min(min.z, p.z) };
    max = { x: Math.max(max.x, p.x), y: Math.max(max.y, p.y), z: Math.max(max.z, p.z) };
  }
  return { min, max };
}

function* massPropScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DMASSPROP';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const solids = yield* selectSolids(ctx, NAME);
  if (solids.length === 0) return;
  const frame = constructionPlaneOf(ctx);
  let volume = 0, area = 0, negative = 0;
  let c = { x: 0, y: 0, z: 0 }, mean = { x: 0, y: 0, z: 0 };
  let box: { min: Vec3; max: Vec3 } | null = null;
  for (const s of solids) {
    const mp = meshMassProperties(s.mesh);
    // A volume is a size: a foreign polyface wound inside out (the import keeps its winding) or not
    // closed can have a negative signed volume, and summing signed values cancels it against the
    // others. Each solid's own centroid is right either way, so only the weights use the magnitude.
    const v = Math.abs(mp.volume);
    if (mp.volume < 0) negative++;
    volume += v;
    area += mp.area;
    const pc = worldToPlane(frame, mp.centroid);
    c = add3(c, scale3(pc, v));
    mean = add3(mean, pc);
    const b = boundsInFrame(s.mesh, frame);
    if (b) {
      box = box
        ? { min: { x: Math.min(box.min.x, b.min.x), y: Math.min(box.min.y, b.min.y), z: Math.min(box.min.z, b.min.z) }, max: { x: Math.max(box.max.x, b.max.x), y: Math.max(box.max.y, b.max.y), z: Math.max(box.max.z, b.max.z) } }
        : b;
    }
  }
  // Volume-weighted; with no volume at all (flat or degenerate meshes) the mean of the solids' own centroids.
  const centroid = volume > 0 ? scale3(c, 1 / volume) : scale3(mean, 1 / solids.length);
  const f = (v: number) => fl(ctx, v);
  ctx.log('----------------   SOLIDS   ----------------');
  ctx.log(`Solids:        ${solids.length}`);
  ctx.log(`Volume:        ${fv(ctx, volume)}`);
  ctx.log(`Surface area:  ${formatArea(area, ctx.doc.header.units)}`);
  if (box) {
    ctx.log(`Bounding box:  X: ${f(box.min.x)} -- ${f(box.max.x)}`);
    ctx.log(`               Y: ${f(box.min.y)} -- ${f(box.max.y)}`);
    ctx.log(`               Z: ${f(box.min.z)} -- ${f(box.max.z)}`);
  }
  ctx.log(`Centroid:      X: ${f(centroid.x)}  Y: ${f(centroid.y)}  Z: ${f(centroid.z)}`);
  const planeName = ctx.constructionPlaneName ?? 'World';
  if (planeName !== 'World') ctx.log(`(coordinates of the ${planeName} construction plane)`);
  if (negative) ctx.log(`${negative} solid${negative === 1 ? ' has' : 's have'} a negative signed volume (wound inside out, or not closed); the magnitude is counted.`);
  if (solids.length > 1) ctx.log('Values are summed over the solids; overlapping volume counts once per solid.');
}

/** 3DMASSPROP: select solids; volume, surface area, bounding box and centroid. */
export const massProp3dTool = (): Script3DTool => script3d('3DMASSPROP', (ctx) => clearingSelection(ctx, massPropScript(ctx)));

// ------------------------------------------------------------------ face area

function* areaScript(ctx: ToolContext): Step3<void> {
  const NAME = '3DAREA';
  if (!modelSpaceOnly(ctx, NAME)) return;
  const st: InputState = { last: null };
  for (;;) {
    const p = yield* point3(ctx, st, 'Select a face of a solid:');
    if (!p) return;
    const hit = ctx.face3?.(p.p2) ?? null;
    const solid = hit ? solidById(solidsOf(ctx), hit.id) : undefined;
    if (!hit || !solid) {
      ctx.log('No solid face there; pick a face of a solid.');
      continue;
    }
    const region = faceRegion(solid.mesh, hit.triangle);
    const nrm = region.normal;
    const r = (v: number) => (Math.abs(v) < 5e-5 ? '0.0000' : v.toFixed(4));
    ctx.log(`Area = ${formatArea(region.area, ctx.doc.header.units)}, Perimeter = ${fl(ctx, region.perimeter)}`);
    ctx.log(`Face: ${region.triangles.length} triangle${region.triangles.length === 1 ? '' : 's'}, ${region.loops.length} outline loop${region.loops.length === 1 ? '' : 's'}, normal ${r(nrm.x)},${r(nrm.y)},${r(nrm.z)} (WCS).`);
    return;
  }
}

/** 3DAREA: pick a face of a solid; area and perimeter of the planar face. */
export const area3dTool = (): Script3DTool => script3d('3DAREA', areaScript);
