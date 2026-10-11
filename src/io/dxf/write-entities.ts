/**
 * Entity codecs, writer side: one DXF entity (or a short sequence such as INSERT + ATTRIB +
 * SEQEND) per JCad entity. Geometry types are written here; MTEXT, DIMENSION, LEADER, IMAGE and
 * tables come from write-annotations.ts.
 */
import { insertTransform, splineCurve, hatchPatternLines, tableParts, type Entity, type BlockDef, type PolylineEntity, type SplineEntity, type HatchEntity } from '../../core/entities';
import { findPattern } from '../../core/hatch';
import * as g from '../../core/geometry';
import { attdefFlags, type AttributeDefExt } from '../../electrical/symbol-builder-core';
import { textStyleOf } from '../encoding';
import { Writer, writeAnnotativeXdata, writeEntityCommon, writeTextLike, emptyExtras, type WriteExtras } from './write-core';
import { writeMText, writeDimension, writeLeader, writeImage, writeTableInsert } from './write-annotations';

function writePolyline(w: Writer, e: PolylineEntity, owner: string): void {
  if (e.filled && e.closed && (e.points.length === 3 || e.points.length === 4)) {
    // Filled triangles/quads (dimension arrowheads) are SOLIDs so every reader fills them.
    writeEntityCommon(w, e, owner, 'SOLID', 'AcDbTrace');
    const p = e.points;
    // SOLID vertex order is 1-2-4-3 (bow tie convention)
    const order = p.length === 3 ? [p[0]!, p[1]!, p[2]!, p[2]!] : [p[0]!, p[1]!, p[3]!, p[2]!];
    order.forEach((pt, i) => {
      w.pair(10 + i, pt.x);
      w.pair(20 + i, pt.y);
      w.pair(30 + i, 0);
    });
    return;
  }
  if (e.filled && e.closed && e.points.length > 4) {
    // A filled boundary with more than four vertices (DWG solid hatches) is a SOLID hatch, so the
    // fill survives Save; LWPOLYLINE has no fill flag.
    const { points, ...rest } = e;
    void points;
    const hatch: HatchEntity = { ...(rest as Omit<PolylineEntity, 'points'>), type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, loops: [{ points: e.points, ...(e.bulges ? { bulges: e.bulges } : {}) }] } as unknown as HatchEntity;
    writeHatch(w, hatch, owner);
    return;
  }
  writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
  w.pair(90, e.points.length);
  w.pair(70, e.closed ? 1 : 0);
  if (e.width) w.pair(43, e.width);
  e.points.forEach((p, i) => {
    w.pair(10, p.x);
    w.pair(20, p.y);
    const b = e.bulges?.[i] ?? 0;
    if (Math.abs(b) > 1e-12) w.pair(42, b);
  });
}

function writeSpline(w: Writer, e: SplineEntity, owner: string): void {
  writeEntityCommon(w, e, owner, 'SPLINE', 'AcDbSpline');
  const curve = splineCurve(e);
  const cps = curve?.controlPoints ?? [];
  const knots = curve?.knots ?? [];
  const weights = curve?.weights;
  const rational = !!weights && weights.some((v) => Math.abs(v - 1) > 1e-12);
  w.pair(210, 0);
  w.pair(220, 0);
  w.pair(230, 1);
  w.pair(70, (e.closed ? 1 : 0) | (e.periodic ? 2 : 0) | (rational ? 4 : 0) | 8);
  w.pair(71, curve?.degree ?? e.degree);
  w.pair(72, knots.length);
  w.pair(73, cps.length);
  w.pair(74, e.fitPoints?.length ?? 0);
  w.pair(42, 0.0000001);
  w.pair(43, 0.0000001);
  w.pair(44, 0.0000000001);
  if (e.startTangent) {
    w.pair(12, e.startTangent.x);
    w.pair(22, e.startTangent.y);
    w.pair(32, 0);
  }
  if (e.endTangent) {
    w.pair(13, e.endTangent.x);
    w.pair(23, e.endTangent.y);
    w.pair(33, 0);
  }
  for (const k of knots) w.pair(40, k);
  if (rational) for (const v of weights!) w.pair(41, v);
  for (const p of cps) {
    w.pair(10, p.x);
    w.pair(20, p.y);
    w.pair(30, 0);
  }
  for (const p of e.fitPoints ?? []) {
    w.pair(11, p.x);
    w.pair(21, p.y);
    w.pair(31, 0);
  }
}

function writeHatch(w: Writer, e: HatchEntity, owner: string): void {
  writeEntityCommon(w, e, owner, 'HATCH', 'AcDbHatch');
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(210, 0);
  w.pair(220, 0);
  w.pair(230, 1);
  w.pair(2, e.solid ? 'SOLID' : e.pattern || 'ANSI31');
  w.pair(70, e.solid ? 1 : 0);
  w.pair(71, e.associative ? 1 : 0);
  w.pair(91, e.loops.length);
  e.loops.forEach((l, i) => {
    const hasBulge = !!l.bulges && l.bulges.some((b) => Math.abs(b) > 1e-12);
    w.pair(92, i === 0 ? 3 : 2);
    w.pair(72, hasBulge ? 1 : 0);
    w.pair(73, 1);
    w.pair(93, l.points.length);
    l.points.forEach((p, k) => {
      w.pair(10, p.x);
      w.pair(20, p.y);
      if (hasBulge) w.pair(42, l.bulges![k] ?? 0);
    });
    w.pair(97, 0);
  });
  w.pair(75, e.style ?? 0);
  const custom = !e.solid && !findPattern(e.pattern);
  w.pair(76, e.solid ? 1 : e.patternType ?? (custom ? 2 : 1));
  if (!e.solid) {
    const lines = hatchPatternLines(e);
    w.pair(52, g.deg(e.angle));
    w.pair(41, e.scale);
    w.pair(77, e.double ? 1 : 0);
    w.pair(78, lines.length);
    for (const l of lines) {
      w.pair(53, g.deg(l.angle));
      w.pair(43, l.base.x);
      w.pair(44, l.base.y);
      w.pair(45, l.offset.x);
      w.pair(46, l.offset.y);
      w.pair(79, l.dashes.length);
      for (const d of l.dashes) w.pair(49, d);
    }
  }
  w.pair(98, 0);
}

export function writeEntity(w: Writer, e: Entity, owner: string, blocks: Readonly<Record<string, BlockDef>>, dimBlocks?: Map<string, string>, extras?: WriteExtras): void {
  switch (e.type) {
    case 'line':
      writeEntityCommon(w, e, owner, 'LINE', 'AcDbLine');
      w.pair(10, e.a.x);
      w.pair(20, e.a.y);
      w.pair(30, 0);
      w.pair(11, e.b.x);
      w.pair(21, e.b.y);
      w.pair(31, 0);
      break;
    case 'circle':
      if (e.filled) {
        // Solid dot: a DONUT with zero inner radius = closed LWPOLYLINE of two bulge-1 vertices with constant width.
        writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
        w.pair(90, 2);
        w.pair(70, 1);
        w.pair(43, e.radius);
        w.pair(10, e.center.x - e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        w.pair(10, e.center.x + e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        break;
      }
      writeEntityCommon(w, e, owner, 'CIRCLE', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      break;
    case 'arc':
      writeEntityCommon(w, e, owner, 'ARC', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      w.pair(100, 'AcDbArc');
      w.pair(50, g.deg(g.normAngle(e.startAngle)));
      w.pair(51, g.deg(g.normAngle(e.endAngle)));
      break;
    case 'polyline':
      writePolyline(w, e, owner);
      break;
    case 'text': {
      writeEntityCommon(w, e, owner, 'TEXT', 'AcDbText');
      writeTextLike(w, e.position, e.height, e.field && e.field.value === e.text ? e.field.code : e.text, e.rotation, e.align);
      if (textStyleOf(e)) w.pair(7, textStyleOf(e)!);
      if (e.widthFactor !== undefined && Math.abs(e.widthFactor - 1) > 1e-12) w.pair(41, e.widthFactor);
      if (e.oblique) w.pair(51, g.deg(e.oblique));
      w.pair(100, 'AcDbText');
      break;
    }
    case 'spline':
      writeSpline(w, e, owner);
      break;
    case 'hatch':
      writeHatch(w, e, owner);
      break;
    case 'leader':
      writeLeader(w, e, owner, extras ?? emptyExtras());
      break;
    case 'image':
      writeImage(w, e, owner, extras ?? emptyExtras());
      break;
    case 'table': {
      const name = extras?.tableBlocks.get(e);
      if (name) writeTableInsert(w, e, owner, name);
      else for (const part of tableParts(e)) writeEntity(w, part, owner, blocks, dimBlocks, extras);
      break;
    }
    case 'mtext':
      writeMText(w, e, owner);
      break;
    case 'ellipse':
      writeEntityCommon(w, e, owner, 'ELLIPSE', 'AcDbEllipse');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(11, e.majorAxis.x);
      w.pair(21, e.majorAxis.y);
      w.pair(31, 0);
      w.pair(210, 0);
      w.pair(220, 0);
      w.pair(230, 1);
      w.pair(40, e.ratio);
      w.pair(41, e.startParam);
      w.pair(42, e.endParam);
      break;
    case 'point':
      writeEntityCommon(w, e, owner, 'POINT', 'AcDbPoint');
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      break;
    case 'xline':
    case 'ray': {
      writeEntityCommon(w, e, owner, e.type === 'xline' ? 'XLINE' : 'RAY', e.type === 'xline' ? 'AcDbXline' : 'AcDbRay');
      const d = g.normalize(e.direction);
      w.pair(10, e.base.x);
      w.pair(20, e.base.y);
      w.pair(30, 0);
      w.pair(11, d.x);
      w.pair(21, d.y);
      w.pair(31, 0);
      break;
    }
    case 'dimension':
      writeDimension(w, e, owner, dimBlocks?.get(e.id) ?? '*D0');
      break;
    case 'insert': {
      const block = blocks[e.block];
      // Constant attributes (ATTDEF flag 2) have no ATTRIB on the insert: the definition's value shows.
      const attribDefs = block ? (block.attributes as readonly AttributeDefExt[]).filter((a) => !a.constant) : [];
      const hasAttribs = attribDefs.length > 0;
      writeEntityCommon(w, e, owner, 'INSERT', 'AcDbBlockReference');
      if (hasAttribs) w.pair(66, 1);
      w.pair(2, e.block);
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      const sy = e.scaleY ?? e.scale;
      if (e.scale !== 1 || sy !== 1 || e.mirror) {
        w.pair(41, e.mirror ? -e.scale : e.scale);
        w.pair(42, sy);
        w.pair(43, e.scale);
      }
      if (e.rotation !== 0) w.pair(50, g.deg(e.rotation));
      if (e.annotative) writeAnnotativeXdata(w);
      if (hasAttribs && block) {
        const toWorld = insertTransform(e, block);
        for (const a of attribDefs) {
          const value = e.attributes[a.tag] ?? a.default;
          // Attribute position in world space
          const world = toWorld(a.position);
          w.pair(0, 'ATTRIB');
          w.pair(5, w.nextHandle());
          w.pair(330, owner);
          w.pair(100, 'AcDbEntity');
          w.pair(8, e.layer);
          w.pair(100, 'AcDbText');
          writeTextLike(w, world, a.height * Math.sqrt(e.scale * sy), value, e.rotation + (a.rotation ?? 0), e.mirror ? (a.align === 'left' ? 'right' : a.align === 'right' ? 'left' : a.align) : a.align);
          w.pair(100, 'AcDbAttribute');
          w.pair(2, a.tag);
          w.pair(70, attdefFlags(a) | (e.hiddenAttributes?.includes(a.tag) ? 1 : 0));
        }
        w.pair(0, 'SEQEND');
        w.pair(5, w.nextHandle());
        w.pair(330, owner);
        w.pair(100, 'AcDbEntity');
        w.pair(8, e.layer);
      }
      break;
    }
  }
}

/** Write an entity, then its annotative xdata (inserts write theirs before the ATTRIBs). */
export function writeEntityAnno(w: Writer, e: Entity, owner: string, blocks: Readonly<Record<string, BlockDef>>, dimBlocks?: Map<string, string>, extras?: WriteExtras): void {
  writeEntity(w, e, owner, blocks, dimBlocks, extras);
  if (e.annotative && e.type !== 'insert') writeAnnotativeXdata(w);
}
