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
import { writeLeader, writeMLeader, writeImage, writeAcadTable, writeUnderlay, writeMText, writeDimension, tableDxfForm } from './write-annotations';

import type { AttributeDefExt } from '../../electrical/symbol-builder-core';
import { attdefFlags } from '../../electrical/symbol-builder-core';
import { insertArrayProblem } from '../../core/insert-array';
import { DYNAMIC_APP } from './codes';
import { canonicalCadHandle } from '../../core/cad-graph';
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

const f64View = new DataView(new ArrayBuffer(8));
/** The double one ulp from `x` in the sign of `dir` (positive x only — the bit
 *  pattern of a positive double orders like an integer). */
function stepUlp(x: number, dir: 1 | -1): number {
  f64View.setFloat64(0, x);
  f64View.setBigUint64(0, f64View.getBigUint64(0) + BigInt(dir));
  return f64View.getFloat64(0);
}

/**
 * The group-41 text for a folded (table-regenerated) hatch in a metric
 * drawing: the model scale expressed in the file's system, scale / 25.4,
 * written at FULL double precision as a raw string (Writer.pair formats
 * numbers through the file-wide 10-decimal fmt, and this one value must not
 * pass through it). At 10 decimals the text for an authored scale of 1 is
 * 0.0393700787, and fitPatternToLines' metric branch multiplies the declared
 * value back by 25.4 on re-read: 0.0393700787 x 25.4 = 0.99999999898, so the
 * scale drifted off the authored value — the declared-value exactness the
 * imperial path guarantees (74757b90) broke in the metric case (P3).
 * Full precision alone is not quite enough: the double nearest the exact
 * quotient does not always multiply back to the authored scale
 * (fl(1 / 25.4) x 25.4 = 0.9999999999999999, one ulp low). The emitted double
 * is therefore the one nearest the quotient — the quotient itself whenever it
 * qualifies, else an adjacent double within a few ulps — whose product with
 * 25.4 IS the authored scale bit-for-bit; if no neighbour qualifies, the
 * plain full-precision quotient is emitted. Degenerate scales (non-finite or
 * <= 0) return the number, keeping the shared fmt behaviour byte-for-byte.
 */
function metricFoldedScale41(scale: number): string | number {
  const q = scale / 25.4;
  if (!Number.isFinite(q) || q <= 0) return q;
  if (q * 25.4 === scale) return String(q);
  let up = q;
  let down = q;
  for (let i = 0; i < 4; i++) {
    up = stepUlp(up, 1);
    if (up * 25.4 === scale) return String(up);
    down = stepUlp(down, -1);
    if (down * 25.4 === scale) return String(down);
  }
  return String(q);
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
  // P17 associative hatches: the per-loop boundary objects that resolve
  // to objects this writer emits are named (97 count + one 330 each). A
  // loop's links come from BOTH of its association fields: boundaryRefs
  // (document entity ids) and boundaryHandles (retained raw source
  // handles). A retained handle resolves, in order, to an emitted ENTITY
  // (through its source identity — P1-d, Codex PR #44: the handle list
  // used to be silently dropped here, so a block-resident hatch linked
  // to a model-space boundary lost the link on the first save and its
  // 97/71 were gone for good) or to a retained graph ANCHOR the merge
  // still emits (REGION / BODY / other raw records — round 2: the
  // entity-only index skipped them, so an imported hatch linked to a
  // retained REGION saved with 97 = 0 while the REGION itself was
  // written). An entity link is emitted with the entity's reserved
  // handle in THIS file, never the raw source text; an anchor link with
  // the handle the merge emits the anchor's record under — its
  // canonical source handle, withheld from this writer's allocator so
  // the raw value cannot be mistaken for a writer handle by the
  // merge's generated-record rewrite; or, when that source handle
  // collides with a fixed structural handle of the generated stream
  // (round 3), the fresh handle writeDxf remapped the anchor to,
  // which the merge emits the record under by the same remap. A retained
  // handle that names a graph object this writer does NOT emit as a
  // boundary refuses the save (the throw below): the link names
  // something the drawing retains, and dropping it silently is the
  // failure both P1 rounds exist to remove. A handle naming no object
  // in the drawing at all stays unemitted: it names an object that is
  // not in the file, and writing it could alias a handle this writer
  // reuses. Unresolvable refs are omitted (the document detaches erased
  // boundaries).
  //
  // The 71 flag classifies the COMPLETE emitted boundary set (round 2,
  // settling R1's open question): a cross-owner link (O5: the boundary
  // lives in another space / block definition) is not a live
  // association in AutoCAD, so if ANY emitted boundary is foreign-owned
  // the WHOLE hatch is saved non-associative (71 = 0) with its handle
  // list retained (on reopen the handles stay raw boundary handles,
  // never live links; no data is lost) — previously ANY same-owner link
  // enabled 71 = 1 while the foreign boundaries were still emitted with
  // no back-reactor, an associative hatch whose foreign boundary
  // AutoCAD's AUDIT would repair. Only a hatch whose emitted boundaries
  // are ALL same-owner is written 71 = 1. The boundary-side back-pointer
  // ({ACAD_REACTORS -> this hatch}) is completed on the final text by
  // ensureAssociativeHatchReactors (io/cad-graph-dxf.ts), once every
  // record's handle is final — it keys off this same 71 flag and the
  // 97/330 list written here, so a demoted hatch gains no reactors and
  // handle- and anchor-derived links compose with it unchanged.
  interface HatchLink {
    /** The 330 value to emit, produced at emission time (entity handles are reserved in loop order, exactly as before). */
    emit: (ww: Writer) => string;
    sameOwner: boolean;
  }
  // Round 5 (lead ruling — DEMOTE): a HATCH must never be an ACTIVE
  // boundary of a hatch, itself or another hatch. If any loop links to
  // a HATCH entity — by boundaryRefs, by a retained handle resolving to
  // an emitted hatch entity, or by a retained handle naming a retained
  // raw HATCH record — the link is NOT emitted at all and the whole
  // hatch demotes exactly like the O5 case above: 71 = 0 (so no
  // reactors), the remaining non-hatch links still emitted, inert
  // under 71 = 0 (round 4 keeps them raw on reopen), geometry
  // untouched. The demotion is a pure function of the model, so every
  // save of such a hatch reproduces it.
  let hatchBoundary = false;
  // Round 7 (invariant guard): whether at least one emitted link is
  // LIVE by the model's own lights — derived from boundaryRefs (a live
  // model link), from a retained handle naming a graph anchor (round 2:
  // anchors are never modelled as entities, so the writer is their only
  // adjudicator), or from a retained handle resolving through an
  // identity the entity carries in the model itself (cadIdentity — the
  // P1-d authored posture). A retained handle resolving ONLY through
  // the retained graph's entity join does NOT set this: the graph is
  // the same evidence the reader resolved the file against, so such a
  // link is one the import already had its chance to make live. It is
  // still EMITTED (retention is not loss, and its owner still counts in
  // the classification below), but it cannot by itself carry 71 = 1 —
  // before the guard, exactly that upgrade wrote CANP5's divergent
  // file (model inert, file 71 = 1 + reactor).
  let carriedLive = false;
  // Round 8 (lead ruling): the classification is PER LINK, whole-hatch
  // like O5. Round 7's flag alone left the mixed case divergent: a
  // hatch with one live link plus one graph-only link (below) still
  // wrote 71 = 1, and the reactor pass — which keys off the written
  // flag — put a back-reactor on the NON-LIVE boundary too, so the
  // file activated a link the model holds inert and reopening the save
  // promoted it to a live ref. So a graph-only link (an emitted link
  // whose retained handle resolved ONLY through the cad graph's
  // entity-anchor join — graphEntityHandles) now VETOES 71 = 1 for the
  // whole hatch, whatever else it carries: the hatch writes 71 = 0
  // with no reactors, its links still emitted inert, and round 4 keeps
  // the reopened hatch wholly inert, so file and model agree again.
  let graphOnlyLink = false;
  const loopLinks = e.loops.map((l) => {
    const seen = new Set<string>();
    const links: HatchLink[] = [];
    const pushEntity = (b: Entity): void => {
      if (b.type === 'hatch') {
        hatchBoundary = true;
        return;
      }
      if (seen.has(`e:${b.id}`)) return;
      seen.add(`e:${b.id}`);
      const o = extras?.entityOwner?.get(b.id);
      links.push({ emit: (ww) => ww.reserveEntityHandle(b), sameOwner: o === undefined || o === owner });
    };
    for (const id of l.boundaryRefs ?? []) {
      const b = extras?.entityById?.get(id);
      if (!b) continue;
      const before = links.length;
      pushEntity(b);
      if (links.length > before) carriedLive = true;
    }
    for (const raw of l.boundaryHandles ?? []) {
      let canon: string;
      try {
        canon = canonicalCadHandle(raw);
      } catch {
        continue; // Not a handle spelling: names nothing, stays unemitted.
      }
      const b = extras?.entityBySourceHandle?.get(canon);
      if (b) {
        const before = links.length;
        pushEntity(b);
        if (links.length > before) {
          // Per link (round 8): resolved through an identity the model
          // itself carries (cadIdentity) the link is live-class; resolved
          // ONLY through the retained graph's entity-anchor join
          // (graphEntityHandles supplied or overwrote this entry) it is
          // graph-only and vetoes 71 = 1 for the whole hatch below.
          if (extras?.graphEntityHandles?.has(canon) ?? false) graphOnlyLink = true;
          else carriedLive = true;
        }
        continue;
      }
      if (extras?.hatchAnchorHandles?.has(canon)) {
        // Round 5: the retained handle names a retained raw HATCH
        // record — a hatch boundary, demote (never emitted, and never
        // the graph-refusal below: the link is governed, not dropped).
        hatchBoundary = true;
        continue;
      }
      const anchor = extras?.anchorBySourceHandle?.get(canon);
      if (anchor) {
        if (!seen.has(`a:${anchor.handle}`)) {
          seen.add(`a:${anchor.handle}`);
          links.push({ emit: () => anchor.handle, sameOwner: anchor.owner !== undefined && anchor.owner === owner });
          carriedLive = true;
        }
        continue;
      }
      if (extras?.graphSourceHandles?.has(canon)) {
        throw new Error(
          `Cannot save associative hatch: boundary handle ${canon} names a retained object that this writer does not emit as a boundary; refusing rather than dropping the link.`,
        );
      }
      // Names no object in the drawing: stays unemitted (absence is not a link).
    }
    return links;
  });
  const allLinks = loopLinks.flat();
  // Round 4: an explicitly disassociated hatch (associative === false —
  // HATCHEDIT Disassociate, or a 71 = 0 original pinned inert by the
  // reader) NEVER re-derives 71 = 1 from its retained links: 71 requires
  // the flag AND links AND all-same-owner. associative === undefined
  // (model-built hatches) keeps the links-decide behaviour.
  // Round 5: a hatch-boundary link (hatchBoundary above) demotes the
  // whole hatch regardless of flag, links and owners.
  // Round 7: 71 = 1 additionally requires a carried-live link
  // (carriedLive above): a hatch whose ONLY emitted links are retained
  // handles resolving through the cad graph's entity join — links the
  // import left non-live — is written 71 = 0 with its links emitted
  // inert (the demote posture, never a refusal: no data is lost, and
  // round 4 keeps the reopened hatch inert, so file and model agree).
  // Round 8: 71 = 1 additionally requires NO graph-only link
  // (graphOnlyLink above): in mixed company the graph-only link vetoes
  // the flag for the whole hatch, live links included, exactly like
  // the O5 complete-set classification — a non-live link is never
  // written as part of a live association.
  w.pair(71, e.associative !== false && !hatchBoundary && carriedLive && !graphOnlyLink && allLinks.length > 0 && allLinks.every((l) => l.sameOwner) ? 1 : 0);
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
    const links = loopLinks[i]!;
    w.pair(97, links.length);
    for (const link of links) w.pair(330, link.emit(w));
  });
  w.pair(75, e.style ?? 0);
  const custom = !e.solid && !findPattern(e.pattern);
  w.pair(76, e.solid ? 1 : e.patternType ?? (custom ? 2 : 1));
  if (!e.solid) {
    const lines = hatchPatternLines(e);
    w.pair(52, g.deg(e.angle));
    // Group 41 is expressed in the drawing's measurement system. A hatch whose lines are
    // regenerated from the imperial pattern table (folded by fitPatternToLines, so no raw
    // patternLines) carries its scale in table space: in a metric drawing
    // ($MEASUREMENT = 1), whose definitions are the ISO ones at 25.4x, the authored scale
    // is the model scale / 25.4 — writing the model scale verbatim (25.4 for a metric
    // hatch authored at 1) makes AutoCAD's HATCHEDIT regenerate it 25.4x too coarse.
    // A hatch keeping its raw file lines was never table-normalized: its scale is already
    // the declared file-space value and is written verbatim.
    const fromTable = !e.patternLines?.length && lines.length > 0;
    // The metric folded case goes through metricFoldedScale41 (full double
    // precision — see its comment); every other case keeps the shared fmt.
    w.pair(41, extras?.measurement === 1 && fromTable ? metricFoldedScale41(e.scale) : e.scale);
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
    case 'underlay':
      writeUnderlay(w, e, owner, extras ?? emptyExtras());
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
      // The handle writeEntityCommon actually wrote — NOT w.lastHandle(): an
      // associative hatch written earlier may have reserved this INSERT's
      // handle, and the ATTRIB / SEQEND owners below must name that one (F-B).
      const insertHandle = writeEntityCommon(w, e, owner, 'INSERT', array ? 'AcDbMInsertBlock' : 'AcDbBlockReference');
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
          const attribHandle = writeEntityCommon(w, label, insertHandle, 'ATTRIB', 'AcDbText', owner);
          w.anchor(attribHandle, { kind: 'entity', id: e.id, part: `attribute:${a.tag}` });
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
