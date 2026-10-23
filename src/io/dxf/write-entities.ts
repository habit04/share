/**
 * Entity codecs, writer side: one DXF entity (or a short sequence such as INSERT + ATTRIB +
 * SEQEND) per JCad entity. Geometry types are written here; MTEXT, DIMENSION, LEADER, IMAGE and
 * tables come from write-annotations.ts.
 */
import { Writer, writeEntityCommon, writeTextLike, writeTextStyle, emptyExtras, writeAnnotativeXdata, writePaperSpaceFlag } from './write-core';
import type { PolylineEntity, HatchEntity, SplineEntity, Entity, BlockDef } from '../../core/entities';
import { splineCurve, hatchPatternLines, tableParts, attributeText, attributePlacementsForDef, expansionBlock } from '../../core/entities';
import { findPattern } from '../../core/hatch';
import * as g from '../../core/geometry';
import type { WriteExtras } from './write-core';
import { textStyleOf } from '../encoding';
import { writeLeader, writeMLeader, writeImage, writeAcadTable, writeMText, writeDimension, tableDxfForm } from './write-annotations';

import type { AttributeDefExt } from '../../electrical/symbol-builder-core';
import { attdefFlags } from '../../electrical/symbol-builder-core';
import { insertArrayProblem } from '../../core/insert-array';
import { DYNAMIC_APP } from './codes';
import { chunkDynamicPayload, encodeDynamicInstance } from './dynamic-data';
import { hatchGradientDataProblem, hatchGradientExportProblem } from '../../core/hatch-gradient';

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
  if (!e.widths && e.width) w.pair(43, e.width);
  e.points.forEach((p, i) => {
    w.pair(10, p.x);
    w.pair(20, p.y);
    // Persistent vertex identifier (group 91, Q11 F4): emitted only when the
    // source vertex carried one — never synthesized. AutoCAD places it
    // immediately after the vertex point and writes the value right-justified
    // in a 9-char field; the pre-padded string passes Writer.pair verbatim.
    const vid = e.vertexIds?.[i];
    if (vid !== undefined) w.pair(91, String(vid).padStart(9));
    if (e.widths) {
      w.pair(40, e.widths[i]?.start ?? 0);
      w.pair(41, e.widths[i]?.end ?? 0);
    }
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

function writeHatch(w: Writer, e: HatchEntity, owner: string, extras?: WriteExtras): void {
  if (e.gradient) {
    const problem = hatchGradientDataProblem(e.gradient);
    if (problem) throw new Error(`Cannot preserve hatch gradient in DXF: ${problem}`);
    const exportProblem = hatchGradientExportProblem(e);
    if (exportProblem) throw new Error(exportProblem);
  }
  writeEntityCommon(w, e, owner, 'HATCH', 'AcDbHatch');
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(210, 0);
  w.pair(220, 0);
  w.pair(230, 1);
  w.pair(2, e.solid ? 'SOLID' : e.pattern || 'ANSI31');
  w.pair(70, e.solid ? 1 : 0);
  // P17 associative hatches: the per-loop boundary objects that resolve to
  // entities this writer emits are named (97 count + one 330 each, the
  // boundary's reserved handle). The flag is written only when at least one
  // SAME-OWNER link is emitted — a bare associative flag makes AutoCAD's
  // AUDIT repair the hatch, and a cross-owner link (O5: the boundary lives
  // in another space / block definition) is not a live association in
  // AutoCAD, so such a hatch is saved non-associative (71 = 0) with its
  // handle list retained (on reopen the handles stay raw boundary handles,
  // never live links; no data is lost). Unresolvable refs are omitted (the
  // document detaches erased boundaries; imported raw handles live on
  // HatchLoop.boundaryHandles). The boundary-side back-pointer
  // ({ACAD_REACTORS -> this hatch}) is completed on the final text by
  // ensureAssociativeHatchReactors (io/cad-graph-dxf.ts), once every
  // record's handle is final.
  const loopRefs = e.loops.map((l) => (l.boundaryRefs ?? [])
    .map((id) => extras?.entityById?.get(id))
    .filter((b): b is Entity => !!b));
  const sameOwner = (b: Entity): boolean => {
    const o = extras?.entityOwner?.get(b.id);
    return o === undefined || o === owner;
  };
  w.pair(71, loopRefs.some((refs) => refs.some(sameOwner)) ? 1 : 0);
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
    const refs = loopRefs[i]!;
    w.pair(97, refs.length);
    for (const b of refs) w.pair(330, w.reserveEntityHandle(b));
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
  if (e.gradient) {
    const gradient = e.gradient;
    w.pair(450, gradient.kind ?? 1);
    w.pair(451, gradient.reserved ?? 0);
    w.pair(460, gradient.angle);
    w.pair(461, gradient.shift);
    w.pair(452, gradient.colorMode ?? (gradient.singleColor ? 1 : 0));
    w.pair(462, gradient.tint);
    w.pair(453, gradient.colorCount ?? gradient.colors.length);
    for (const color of gradient.colors) {
      w.pair(463, color.position);
      if (color.color !== undefined) w.pair(63, color.color);
      if (color.trueColor !== undefined) w.pair(421, color.trueColor);
    }
    w.pair(470, gradient.name);
  }
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
      writeTextLike(w, e.position, e.height, e.field && !e.field.native && e.field.value === e.text ? e.field.code : e.text, e.rotation, e.align, e);
      writeTextStyle(w, { ...e, style: textStyleOf(e) });
      w.pair(100, 'AcDbText');
      if (e.justification?.vertical) w.pair(73, e.justification.vertical);
      break;
    }
    case 'spline':
      writeSpline(w, e, owner);
      break;
    case 'hatch':
      writeHatch(w, e, owner, extras);
      break;
    case 'leader':
      // P18: only a mleader carrying modeled native data writes natively;
      // plain leaders and unmodeled mleaders keep the LEADER + MTEXT path.
      if (e.kind === 'mleader' && e.mleader) writeMLeader(w, e, owner);
      else writeLeader(w, e, owner, extras ?? emptyExtras());
      break;
    case 'image':
      writeImage(w, e, owner, extras ?? emptyExtras());
      break;
    case 'table': {
      const picture = extras?.tableBlocks.get(e);
      if (picture) writeAcadTable(w, e, owner, picture);
      else for (const part of tableParts(tableDxfForm(e))) writeEntity(w, part, owner, blocks, dimBlocks, extras);
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
      const array = (e.columns ?? 1) > 1 || (e.rows ?? 1) > 1;
      writeEntityCommon(w, e, owner, 'INSERT', array ? 'AcDbMInsertBlock' : 'AcDbBlockReference');
      const insertHandle = w.lastHandle().toString(16).toUpperCase();
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
      const arrayProblem = insertArrayProblem(e);
      if (arrayProblem) throw new Error(arrayProblem);
      if (array || e.columns !== undefined || e.rows !== undefined || e.columnSpacing !== undefined || e.rowSpacing !== undefined) {
        w.pair(70, e.columns ?? 1);
        w.pair(71, e.rows ?? 1);
        w.pair(44, e.columnSpacing ?? 0);
        w.pair(45, e.rowSpacing ?? 0);
      }
      if (e.annotative) writeAnnotativeXdata(w);
      // Priority 30 instance carrier: at the annotative-XDATA position, strictly BEFORE
      // the ATTRIB loop — anything emitted after ATTRIB/SEQEND would attach to those
      // records instead of the INSERT. A modeled state is re-encoded canonically;
      // a retained payload is re-emitted verbatim (chunked only).
      if (e.dynamic || e.dynamicRetained) {
        w.pair(1001, DYNAMIC_APP);
        const payload = e.dynamic ? encodeDynamicInstance(e.dynamic) : e.dynamicRetained!;
        for (const chunk of chunkDynamicPayload(payload)) w.pair(1000, chunk);
      }
      if (hasAttribs && block) {
        // Review R07: an ATTRIB's position is the attribute's CURRENT
        // evaluated placement (what the editor displays), not the authored
        // ATTDEF position — otherwise the file itself records the attribute
        // as unmoved, and the reader's placement capture would undo the
        // evaluation on reopen. Static inserts get `block` itself back from
        // expansionBlock, so their output is unchanged. An attribute the
        // current visibility state hides has no evaluated counterpart; it
        // is still written (its value lives only in this record) at the
        // authored placement, as before.
        const expanded = expansionBlock(block, e);
        const textIns = attributePlacementsForDef(e, block, expanded);
        for (const a of attribDefs) {
          const value = e.attributes[a.tag] ?? a.default;
          // Attribute position in world space
          const aEff = expanded === block ? a : expanded.attributes.find((x) => x.tag === a.tag);
          const label = aEff ? attributeText(textIns, expanded, aEff, value, false) : attributeText(e, block, a, value, false);
          // The INSERT owns its followers; their paper-space flag belongs to its enclosing block.
          writeEntityCommon(w, label, insertHandle, 'ATTRIB', 'AcDbText', owner);
          w.anchor(w.lastHandle().toString(16).toUpperCase(), { kind: 'entity', id: e.id, part: `attribute:${a.tag}` });
          writeTextLike(w, label.position, label.height, value, label.rotation, label.align, label);
          writeTextStyle(w, label);
          w.pair(100, 'AcDbAttribute');
          w.pair(2, a.tag);
          w.pair(70, attdefFlags(a) | (e.hiddenAttributes?.includes(a.tag) ? 1 : 0));
          if (label.justification?.vertical) w.pair(74, label.justification.vertical);
        }
        w.pair(0, 'SEQEND');
        w.pair(5, w.nextHandle());
        w.anchor(w.lastHandle().toString(16).toUpperCase(), { kind: 'entity', id: e.id, part: 'sequence-end' });
        w.pair(330, insertHandle);
        w.pair(100, 'AcDbEntity');
        writePaperSpaceFlag(w, owner);
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
