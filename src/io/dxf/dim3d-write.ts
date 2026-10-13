/**
 * True 3D dimensions, writer side (docs/3D-DIMENSIONS.md, docs/3D-FILE-FORMAT.md): each
 * `Dimension3D` becomes a real DXF `DIMENSION` in its measurement plane, using the DXF object
 * coordinate system (OCS) of its extrusion direction:
 *
 * - 210 / 220 / 230: the plane normal (the plane frame's Z axis).
 * - Definition points the DXF reference gives in WCS stay world coordinates: 10 (the
 *   dimension-line definition point, or the point on the arc of an angular dimension), 13 / 14
 *   (extension line origins, or the leg points), 15 (the angle vertex). Text midpoint 11 is in OCS
 *   (Arbitrary Axis Algorithm, `frameFromPlane`), its Z the plane's elevation.
 * - 70: dimension type (aligned 1, linear / rotated 0, three-point angular 5, as the 2D writer)
 *   + 32 (the block belongs to this dimension only); 50 (linear): the measurement direction's angle
 *   in the OCS, in degrees; 42: the measurement (radians for angular, as in 2D); 1: the text
 *   override, with " (projected)" when the dimension measures a projection; 3: the style name, with
 *   per-dimension style overrides as ACAD DSTYLE / JCAD_DIMSTYLE XDATA exactly as for 2D dimensions.
 * - 2: an anonymous `*D` block holding the picture (as the 2D writer does, so programs that do not
 *   regenerate dimensions still show it): LINEs in world coordinates, arcs, circles, filled
 *   arrowheads (SOLID), dots (LWPOLYLINE donuts) and TEXT in the OCS of the plane.
 * - `JCAD_3D` XDATA: `{"v":1,"id":...,"kind":"dimension3d","plane":{...},"projected":true}` for what
 *   DXF cannot express: the id, the plane frame's origin and in-plane axes, and the projected flag.
 *
 * Coordinates that round-trip (10, 13, 14, 15, 210) are written with the shortest exact decimal
 * text (`exactReal`), so definition points and the normal read back bit-exactly.
 */
import { textStyleOf } from '../encoding';
import type { DimPart } from '../../core/dimension';
import type { Entity } from '../../core/entities';
import * as g from '../../core/geometry';
import type { Point } from '../../core/geometry';
import { type Frame3, type Vec3, dot3, frameFromPlane, v3 } from '../../model3d/math';
import {
  dimension3dMeasurement, dimension3dParts, dimension3dTextPoint, dimension3dTo2d, effectiveTextOverride, planeLocal, planeWorld,
} from '../../model3d/dimension3d';
import { encodeDimensionPayload, payloadChunks } from '../../model3d/file-format';
import type { Dimension3D } from '../../model3d/types';
import { DIM_TYPE, MODEL3D_APP } from './codes';
import { exactReal } from './mesh3d-write';
import { writeDimStyleOverrides } from './write-annotations';
import { type Writer, writeEntityCommon } from './write-core';

/** The OCS of a dimension: the Arbitrary Axis Algorithm frame of its plane normal at the world origin. */
export function dimensionOcs(dim: Pick<Dimension3D, 'plane'>): Frame3 {
  return frameFromPlane({ origin: v3(0, 0, 0), normal: dim.plane.zAxis });
}

/** Angle (radians) of the plane's X axis measured in the OCS: plane angles + this = OCS angles. */
function ocsRotation(dim: Dimension3D, ocs: Frame3): number {
  return Math.atan2(dot3(dim.plane.xAxis, ocs.yAxis), dot3(dim.plane.xAxis, ocs.xAxis));
}

function point(w: Writer, code: number, q: Vec3): void {
  w.pair(code, exactReal(q.x));
  w.pair(code + 10, exactReal(q.y));
  w.pair(code + 20, exactReal(q.z));
}

function extrusion(w: Writer, ocs: Frame3): void {
  w.pair(210, exactReal(ocs.zAxis.x));
  w.pair(220, exactReal(ocs.zAxis.y));
  w.pair(230, exactReal(ocs.zAxis.z));
}

/** The dimension-line definition point (group 10) in plane coordinates, as the 2D writer places it. */
function definitionPoint(dim: Dimension3D): Point {
  const d = dimension3dTo2d(dim);
  if (d.kind === 'angular') return d.linePoint;
  const u = d.kind === 'linear' ? { x: Math.cos(d.rotation), y: Math.sin(d.rotation) } : g.len(g.sub(d.p2, d.p1)) > 1e-12 ? g.normalize(g.sub(d.p2, d.p1)) : { x: 1, y: 0 };
  return g.add(d.linePoint, g.scale(u, g.dot(g.sub(d.p2, d.linePoint), u)));
}

/** Write one 3D dimension as a DIMENSION entity owned by `owner`, drawn by the block `blockName`. */
export function writeDimension3D(w: Writer, dim: Dimension3D, owner: string, blockName: string): void {
  const d2 = dimension3dTo2d(dim);
  const ocs = dimensionOcs(dim);
  writeEntityCommon(w, d2, owner, 'DIMENSION', 'AcDbDimension');
  w.pair(2, blockName);
  point(w, 10, planeWorld(dim.plane, definitionPoint(dim)));
  const text = planeLocal(ocs, dimension3dTextPoint(dim));
  w.pair(11, text.x);
  w.pair(21, text.y);
  w.pair(31, text.z);
  w.pair(70, DIM_TYPE[dim.kind] | 32);
  w.pair(71, 5);
  w.pair(42, dimension3dMeasurement(dim));
  const shown = effectiveTextOverride(dim);
  if (shown !== undefined && shown !== '') w.pair(1, shown);
  extrusion(w, ocs);
  w.pair(3, dim.style.name);
  if (dim.kind === 'angular') {
    // Three-point angular: only its own subclass marker (no AcDbAlignedDimension).
    w.pair(100, 'AcDb3PointAngularDimension');
    point(w, 13, dim.p1);
    point(w, 14, dim.p2);
    point(w, 15, dim.vertex ?? dim.p1);
  } else {
    w.pair(100, 'AcDbAlignedDimension');
    point(w, 13, dim.p1);
    point(w, 14, dim.p2);
    if (dim.kind === 'linear') {
      const dir = dim.axis === 'y' ? dim.plane.yAxis : dim.plane.xAxis;
      w.pair(50, exactReal(g.deg(Math.atan2(dot3(dir, ocs.yAxis), dot3(dir, ocs.xAxis)))));
      w.pair(100, 'AcDbRotatedDimension');
    }
  }
  writeDimStyleOverrides(w, d2);
  w.pair(1001, MODEL3D_APP);
  for (const chunk of payloadChunks(encodeDimensionPayload(dim))) w.pair(1000, chunk);
}

/**
 * The picture of a 3D dimension inside its `*D` block (owner = the block record): the 2D dimension
 * geometry of its plane mapped to world coordinates (LINE) or into the OCS of the plane (the
 * other entities, with the extrusion). Parts on ByLayer are written ByBlock, as for 2D dimensions.
 */
export function writeDimension3DPicture(w: Writer, dim: Dimension3D, owner: string): void {
  const ocs = dimensionOcs(dim);
  const rot = ocsRotation(dim, ocs);
  const toOcs = (p: Point): Vec3 => planeLocal(ocs, planeWorld(dim.plane, p));
  const world = (p: Point): Vec3 => planeWorld(dim.plane, p);
  const common = (part: DimPart, kind: string, subclass: string) => writeEntityCommon(w, { ...part, color: part.color === 'ByLayer' ? 0 : part.color } as Entity, owner, kind, subclass);
  const xyz = (code: number, q: Vec3) => {
    w.pair(code, q.x);
    w.pair(code + 10, q.y);
    w.pair(code + 20, q.z);
  };
  const line = (part: DimPart, a: Point, b: Point) => {
    common(part, 'LINE', 'AcDbLine');
    xyz(10, world(a));
    xyz(11, world(b));
  };
  for (const part of dimension3dParts(dim)) {
    switch (part.type) {
      case 'line':
        line(part, part.a, part.b);
        break;
      case 'polyline': {
        const p = part.points;
        if (part.filled && part.closed && (p.length === 3 || p.length === 4)) {
          common(part, 'SOLID', 'AcDbTrace');
          const order = p.length === 3 ? [p[0]!, p[1]!, p[2]!, p[2]!] : [p[0]!, p[1]!, p[3]!, p[2]!];
          order.forEach((q, i) => xyz(10 + i, toOcs(q)));
          extrusion(w, ocs);
        } else {
          const n = part.closed ? p.length : p.length - 1;
          for (let i = 0; i < n; i++) line(part, p[i]!, p[(i + 1) % p.length]!);
        }
        break;
      }
      case 'circle': {
        const c = toOcs(part.center);
        if (part.filled) {
          // A dot: a donut of zero inner radius (closed LWPOLYLINE of two bulge-1 vertices, width = radius).
          common(part, 'LWPOLYLINE', 'AcDbPolyline');
          w.pair(90, 2);
          w.pair(70, 1);
          w.pair(43, part.radius);
          w.pair(38, c.z);
          w.pair(10, c.x - part.radius / 2);
          w.pair(20, c.y);
          w.pair(42, 1);
          w.pair(10, c.x + part.radius / 2);
          w.pair(20, c.y);
          w.pair(42, 1);
          extrusion(w, ocs);
          break;
        }
        common(part, 'CIRCLE', 'AcDbCircle');
        xyz(10, c);
        w.pair(40, part.radius);
        extrusion(w, ocs);
        break;
      }
      case 'arc':
        common(part, 'ARC', 'AcDbCircle');
        xyz(10, toOcs(part.center));
        w.pair(40, part.radius);
        extrusion(w, ocs);
        w.pair(100, 'AcDbArc');
        w.pair(50, g.deg(g.normAngle(part.startAngle + rot)));
        w.pair(51, g.deg(g.normAngle(part.endAngle + rot)));
        break;
      case 'text': {
        common(part, 'TEXT', 'AcDbText');
        const pos = toOcs(part.position);
        xyz(10, pos);
        w.pair(40, part.height);
        w.pair(1, part.text);
        const angle = g.normAngle(part.rotation + rot);
        if (angle !== 0) w.pair(50, g.deg(angle));
        const style = textStyleOf(part);
        if (style) w.pair(7, style);
        const h = part.align === 'center' ? 1 : part.align === 'right' ? 2 : 0;
        if (h !== 0) {
          w.pair(72, h);
          xyz(11, pos);
        }
        extrusion(w, ocs);
        w.pair(100, 'AcDbText');
        break;
      }
    }
  }
}
