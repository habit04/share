/**
 * The entity pass, reader side: a list of entity records (model space, a block definition or a
 * layout) into entities. VERTEX, ATTRIB and SEQEND are folded into their POLYLINE or INSERT, the
 * entity's plane (extrusion) is applied, invalid geometry and lost XDATA are reported, unknown
 * records are reported or kept raw when that is safe, LEADERs take the MTEXT they point to, and
 * model-space polyface meshes go to the 3D solid reader (mesh3d-read.ts).
 */
import type { Obj } from './groups';
import type { RawDxfEntity } from '../import-report';
import { isPointerCode, isRealCode, isRealText, isIntCode, PRECISION_CODES, isQuietXdataApp, ANNO_APP } from './codes';
import { str, num, isIntegerText, shortText, invalidPrecision, precisionRequirement, has, HatchReadError, xdata } from './groups';
import type { BlockDef, Entity, HatchEntity, InsertEntity, TextEntity, AttributeAppearance } from '../../core/entities';
import type { HatchLoop } from '../../core/hatch';
import type { ReadContext } from './read-core';
import * as g from '../../core/geometry';
import { reportObj, commonProps, commonAppearanceObject, reportDynamicDefinition } from './read-core';
import { DYNAMIC_INSTANCE_REPORT, DYNAMIC_INSTANCE_RETAINED_REPORT } from './dynamic-data';
import { transparencyFromDxf, validColorName } from '../../core/appearance';
import { geometryProblem } from '../import-report';
import { dstylePairs, hasUnconsumedAcadXdata } from './read-annotations';
import { formattedSource } from '../../core/mtext';
import { DIM_VARIABLES } from '../../core/dimension';
import { readEntityObj } from './read-entities';
import { SplineWorkLimitError } from '../../core/spline';
import { withTextStyle } from '../encoding';
import { readTextPlacement } from './read-text';
import { importedPlacementsToAuthoredFrame, localAttributePlacement } from '../../core/entities';
import type { TextPlacement } from '../../core/text-placement';
import { hatchGradientRenderProblem, hatchGradientExportProblem } from '../../core/hatch-gradient';
import { POLYFACE_UNSUPPORTED_REASON, payloadText, native3dObject } from './mesh3d-read';
import { canonicalCadHandle } from '../../core/cad-graph';

/** Entity types the reader converts (anything else is reported, or kept raw when safe). */
const READ_KINDS = new Set(['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TRACE', 'TEXT', 'MTEXT', 'ELLIPSE', 'POINT', 'XLINE', 'RAY', 'DIMENSION', 'SPLINE', 'HATCH', 'LEADER', 'MULTILEADER', 'MLEADER', 'IMAGE', 'ACAD_TABLE', 'INSERT']);

/** Records folded into the preceding entity (or block / layout structure). */
const FOLLOWER_KINDS = new Set(['ATTRIB', 'VERTEX', 'SEQEND', 'ENDBLK', 'BLOCK', 'VIEWPORT']);

/** Reports a placement problem found while folding ATTRIB records. */
export type AttribFoldReport = (o: Obj, message: string) => void;

/**
 * Fold one INSERT's ATTRIB follower records into the insert: attribute
 * values, per-instance hidden flags, and placement/appearance overrides
 * (converted to insert-local coordinates and — for a dynamic insert —
 * rebased from the saved evaluated state into the authored frame, review
 * R07). This is the complete fold: it runs inline when the owning block
 * definition is already known, and it is what the deferred replay
 * (below) re-runs when it is not.
 */
export function foldAttribRecords(
  ins: InsertEntity,
  def: BlockDef,
  attribObjs: readonly Obj[],
  report: AttribFoldReport,
): InsertEntity {
  const attrs: Record<string, string> = {};
  const hidden: string[] = [];
  const placements: Record<string, TextPlacement & AttributeAppearance & { style?: string }> = {};
  for (const o of attribObjs) {
    const tag = str(o, 2);
    attrs[tag] = str(o, 1);
    const { id: _id, layer, ...appearance } = commonProps(o);
    const source = { ...appearance, ...(has(o, 8) ? { layer } : {}), ...readTextPlacement(o, 74) };
    const bad = geometryProblem({ ...commonProps(o), ...source, type: 'text', text: attrs[tag]!, id: 'attribute' });
    if (bad) report(o, `attribute placement is invalid (${bad}); its value is kept at the definition's placement`);
    else {
      const local = localAttributePlacement(ins, def.basePoint, source);
      const inverseProblem = geometryProblem({ ...commonProps(o), ...local, rotation: local.rotation ?? 0, type: 'text', text: attrs[tag]!, id: 'attribute' });
      if (inverseProblem) report(o, `attribute placement cannot be represented in the insert's local coordinates (${inverseProblem}); its value is kept at the definition's placement`);
      else placements[tag] = local;
    }
    if ((Math.trunc(num(o, 70)) & 1) === 1) hidden.push(tag);
  }
  // An ATTRIB flagged invisible whose ATTDEF is visible hides that attribute on this insert only.
  const hiddenHere = hidden.filter((t) => def.attributes.some((a) => a.tag === t && !a.invisible));
  // Review R07: for a dynamic insert the ATTRIB anchors record the
  // attribute's position at the SAVED parameter state; rebase them into
  // the stored authored frame so they cannot undo or freeze the
  // evaluated motion after a later parameter edit.
  const authoredPlacements = importedPlacementsToAuthoredFrame(ins, def, placements);
  return {
    ...ins,
    attributes: attrs,
    ...(hiddenHere.length ? { hiddenAttributes: hiddenHere } : {}),
    ...(Object.keys(authoredPlacements).length ? { attributePlacements: authoredPlacements } : {}),
  };
}

/**
 * Review round 2 (C04): ATTRIB folds deferred because the insert's
 * owning block definition did not exist yet when the insert was read —
 * a forward reference inside the BLOCKS section (the referenced block's
 * record appears later in the file, including JCad's own output
 * whenever a parent block precedes its nested child). The attribute
 * VALUES are folded immediately (they need no definition); the
 * placement/appearance fold needs the definition (base point for the
 * local conversion, ATTDEF list for the hidden rule, the evaluated state
 * for the R07 rebase), so the raw follower records are retained here,
 * keyed by the exact entity object the pass produced, and replayed by
 * the reader once every definition is known (completeDeferredAttribFold,
 * beside the R09 dynamic-instance pass). Retained-but-unmodelable
 * dynamic payloads are unaffected: the replay folds attributes against
 * the modeled definition exactly as an in-order read would, and an
 * insert whose block never becomes known keeps today's behaviour
 * (values only). Entries are consumed on replay and never reach
 * document state; a read path that never replays simply loses them
 * with the entity objects (WeakMap), degrading to the pre-C04 result.
 */
const deferredAttribFolds = new WeakMap<InsertEntity, readonly Obj[]>();

/** Whether `e` carries a deferred ATTRIB fold (peek; does not consume). */
export function hasDeferredAttribFold(e: Entity): boolean {
  return e.type === 'insert' && deferredAttribFolds.has(e);
}

/** Take (and consume) the ATTRIB records deferred for `e`, if any. */
export function takeDeferredAttribFold(e: Entity): readonly Obj[] | undefined {
  if (e.type !== 'insert') return undefined;
  const objs = deferredAttribFolds.get(e);
  if (objs) deferredAttribFolds.delete(e);
  return objs;
}

/**
 * Replay a deferred ATTRIB fold for `ins` (the entity AFTER any other
 * deferred resolution, e.g. the R09 dynamic-instance decode, whose
 * result the R07 rebase reads) against the complete definition map.
 * Returns `ins` unchanged when the block is still unknown.
 */
export function completeDeferredAttribFold(
  ins: InsertEntity,
  source: Entity,
  blocks: Readonly<Record<string, BlockDef>>,
  report: AttribFoldReport,
): InsertEntity {
  const attribObjs = takeDeferredAttribFold(source);
  if (!attribObjs) return ins;
  const def = blocks[ins.block];
  if (!def) return ins;
  return foldAttribRecords(ins, def, attribObjs, report);
}

/**
 * Unknown entity types kept as raw records in model space: self-contained types that need no
 * CLASSES entry, no other object and no handle reference, so writing them back cannot make the
 * file unreadable. (Solids / regions only with their ACIS data inline, as in AC1015..AC1024.)
 */
const RAW_KEEP_KINDS = new Set(['3DFACE', '3DSOLID', 'REGION', 'BODY']);

const UNSUPPORTED_REASONS: Record<string, string> = {
  ATTDEF: 'attribute definitions outside a block definition are not supported',
  WIPEOUT: 'wipeouts (masking areas) are not supported',
  MLINE: 'multilines are not supported',
  OLE2FRAME: 'embedded OLE objects are not supported',
  OLEFRAME: 'embedded OLE objects are not supported',
  TOLERANCE: 'geometric tolerance frames are not supported',
  SHAPE: 'shapes (SHX shape references) are not supported',
  ACAD_PROXY_ENTITY: 'proxy objects of other applications are not supported',
  ARC_DIMENSION: 'arc-length dimensions are not supported',
  ARCALIGNEDTEXT: 'arc-aligned text is not supported',
  RTEXT: 'remote text is not supported',
  HELIX: 'helixes are not supported',
  MESH: 'meshes are not supported',
  SURFACE: 'surfaces are not supported',
  PDFUNDERLAY: 'PDF underlays are not supported',
  DWFUNDERLAY: 'DWF underlays are not supported',
  DGNUNDERLAY: 'DGN underlays are not supported',
};

/** A raw record of an unknown entity, or null when it cannot be kept safely. */
function rawRecord(o: Obj): RawDxfEntity | null {
  if (!RAW_KEEP_KINDS.has(o.kind)) return null;
  // Newer files keep solid / region data in the ACDSDATA section (the object only points to it).
  if (o.kind !== '3DFACE' && !o.groups.some((x) => x.code === 1 || x.code === 3)) return null;
  const groups: Array<readonly [number, string]> = [];
  let brace = 0;
  for (const p of o.groups) {
    if (p.code === 102) {
      brace += p.value.trim().startsWith('{') ? 1 : p.value.trim() === '}' ? -1 : 0;
      continue;
    }
    if (brace > 0) continue; // reactors / extension dictionary
    if (p.code >= 1000) break; // extended data: its application is not registered on save
    if (isPointerCode(p.code)) continue;
    groups.push([p.code, p.value]);
  }
  const handle = str(o, 5);
  return { type: o.kind, layer: str(o, 8, '0'), ...(handle ? { handle } : {}), groups };
}

/**
 * DXF objects drawn in their own plane: extrusion (0,0,-1) is a mirror about the Y axis, as
 * MIRROR leaves arcs, circles and polylines. Those are flipped into world coordinates; other
 * entity types (or other extrusions) are reported as simplified (drawn flat).
 */
function applyExtrusion(o: Obj, e: Entity, ctx: ReadContext): Entity {
  const nx = num(o, 210, 0);
  const ny = num(o, 220, 0);
  const nz = num(o, 230, 1);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return e;
  const mirrored = Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz < 0;
  const flip = (q: g.Point): g.Point => ({ x: -q.x, y: q.y });
  if (mirrored) {
    switch (e.type) {
      case 'circle':
        return { ...e, center: flip(e.center) };
      case 'arc':
        return { ...e, center: flip(e.center), startAngle: Math.PI - e.endAngle, endAngle: Math.PI - e.startAngle };
      case 'polyline':
        // LWPOLYLINE / 2D POLYLINE vertices and SOLID / TRACE corners are in the object's plane.
        return { ...e, points: e.points.map(flip), ...(e.bulges ? { bulges: e.bulges.map((b) => -b || 0) } : {}) };
      case 'insert': {
        // The insertion point, rotation and scales are in the object's plane: mirroring the plane
        // flips the position, reverses the rotation and mirrors the block about its Y axis.
        const { mirror: _m, ...rest } = e;
        return { ...rest, position: flip(e.position), rotation: -e.rotation, ...(e.mirror ? {} : { mirror: true }), ...(e.columnSpacing !== undefined ? { columnSpacing: -e.columnSpacing } : {}) };
      }
      default:
        break;
    }
  }
  // Entities whose points DXF stores in world coordinates ignore the extrusion for 2D purposes.
  if (o.kind === 'LINE' || o.kind === 'POINT' || o.kind === 'XLINE' || o.kind === 'RAY' || o.kind === 'SPLINE' || o.kind === 'ELLIPSE' || o.kind === 'MTEXT' || o.kind === 'LEADER' || o.kind === 'MULTILEADER' || o.kind === 'DIMENSION') return e;
  reportObj(ctx, o, 'simplified', `drawn in a plane other than the XY plane (extrusion ${nx},${ny},${nz}): shown projected flat, possibly mirrored`);
  return e;
}

/**
 * P17: resolve the boundary source handles the hatch reader captured on
 * each loop (HatchLoop.boundaryRefs holds raw handles at this stage) to
 * document entity ids, via the cadIdentity map of THIS entity list (a
 * hatch and its boundaries live in the same space / block definition).
 * Resolved loops keep entity ids; unresolved handles move to
 * boundaryHandles — retained and reported (on save they are written
 * back as links only when they name an object in the drawing; see
 * writeHatch in io/dxf/write-entities.ts). A
 * bare associative flag with no resolvable link is cleared and reported
 * (the writer cannot emit a flag without links; AutoCAD's AUDIT would
 * repair it). Round 4: a hatch whose input flag is NOT 71 = 1 is inert —
 * its handles are never promoted (see the branch below). Round 5: a
 * hatch naming itself or another HATCH as a boundary demotes to the
 * same inert posture regardless of its flag. Round 6: the hatch check
 * is drawing-wide — a handle naming a HATCH in ANY space or block
 * definition, or a retained raw HATCH record, demotes too; the lookup
 * (ctx.hatchHandles) keys handles canonically, so 00050 matches 50.
 * Runs per list, in the LEADER-340 post-pass pattern.
 */
function resolveHatchAssociations(list: Entity[], hatchObjs: ReadonlyMap<HatchEntity, Obj>, ctx: ReadContext): void {
  if (hatchObjs.size === 0) return;
  const byHandle = new Map<string, string>();
  for (const e of list) if (e.cadIdentity) byHandle.set(e.cadIdentity.trim().toUpperCase(), e.id);
  const byId = new Map(list.map((e) => [e.id, e]));
  /** The inert posture: every captured handle stays a raw boundaryHandle, no live refs. */
  const inertLoopsOf = (h: HatchEntity): { loops: HatchLoop[]; touched: boolean } => {
    let touched = false;
    const loops = h.loops.map((loop) => {
      const handles = loop.boundaryRefs;
      if (!handles || handles.length === 0) return loop;
      touched = true;
      const raw: string[] = [...(loop.boundaryHandles ?? [])];
      for (const hh of handles) if (!raw.includes(hh)) raw.push(hh);
      const { boundaryRefs: _refs, boundaryHandles: _raw, ...rest } = loop;
      return { ...rest, boundaryHandles: raw };
    });
    return { loops, touched };
  };
  for (const [hatch, o] of hatchObjs) {
    const at = list.indexOf(hatch);
    if (at < 0) continue;
    if (!hatch.associative) {
      // Round 4 (lead ruling): 71 = 0 means INERT. The captured 97/330
      // handles are NOT promoted to live boundaryRefs: the whole list
      // stays raw boundaryHandles and the hatch is pinned
      // associative = false, so maintenance never refreshes it and the
      // writer (whose 71 derivation requires associative !== false)
      // keeps writing 71 = 0 on every later save. No report: the file
      // said non-associative and the model now says exactly that.
      const { loops: inertLoops, touched: touchedInert } = inertLoopsOf(hatch);
      if (touchedInert) list[at] = { ...hatch, loops: inertLoops, associative: false };
      continue;
    }
    // Round 5 (lead ruling — DEMOTE): a HATCH must never be an active
    // boundary of a hatch. If any captured handle in any loop resolves
    // to a hatch entity of this list — the hatch itself or another
    // hatch — the WHOLE hatch imports inert (the round-4 posture:
    // whole list raw, associative pinned false), whatever its 71
    // says; the writer's matching demote keeps every later save inert
    // and never emits the hatch handle.
    // Round 6: the same-list resolution is only half the picture — a
    // hatch in ANOTHER space or block definition, or a retained raw
    // HATCH record no list models, never appears in this list's
    // byHandle map, so the captured handle is ALSO matched against
    // the drawing-wide hatch lookup (ctx.hatchHandles: every HATCH
    // record in the file, pre-scanned by the reader). The lookup keys
    // are canonical, so a zero-padded spelling (00050) names the
    // hatch whose handle is 50 exactly like the canonical spelling.
    // Only hatch-typed targets demote: an ordinary cross-space
    // boundary keeps the round-2 semantics (raw here, O5 at save).
    const namesHatch = hatch.loops.some((loop) => (loop.boundaryRefs ?? []).some((hh) => {
      const id = byHandle.get(hh.trim().toUpperCase());
      if (id !== undefined && byId.get(id)?.type === 'hatch') return true;
      if (!ctx.hatchHandles) return false;
      try { return ctx.hatchHandles.has(canonicalCadHandle(hh.trim())); } catch { return false; }
    }));
    if (namesHatch) {
      const { loops: inertLoops } = inertLoopsOf(hatch);
      list[at] = { ...hatch, loops: inertLoops, associative: false };
      reportObj(ctx, o, 'simplified', 'associative hatch names a hatch as a boundary object; a hatch cannot be an associative boundary, so the hatch is kept non-associative and its boundary handles are retained as raw handles');
      continue;
    }
    let kept = 0;
    let total = 0;
    const unresolved: string[] = [];
    let touched = false;
    const loops: HatchLoop[] = hatch.loops.map((loop) => {
      const handles = loop.boundaryRefs;
      if (!handles || handles.length === 0) return loop;
      total += handles.length;
      const ids: string[] = [];
      const raw: string[] = [...(loop.boundaryHandles ?? [])];
      for (const h of handles) {
        const id = byHandle.get(h.trim().toUpperCase());
        if (id !== undefined && id !== hatch.id) ids.push(id);
        else {
          raw.push(h);
          unresolved.push(h);
        }
      }
      kept += ids.length;
      touched = true;
      const { boundaryRefs: _refs, boundaryHandles: _raw, ...rest } = loop;
      return {
        ...rest,
        ...(ids.length ? { boundaryRefs: ids } : {}),
        ...(raw.length ? { boundaryHandles: raw } : {}),
      };
    });
    if (!touched) {
      if (hatch.associative) {
        const { associative: _a, ...rest } = hatch;
        list[at] = { ...rest, loops: hatch.loops };
        reportObj(ctx, o, 'simplified', 'associative hatch boundary links are not kept; its boundary geometry is kept and saved non-associative');
      }
      continue;
    }
    const { associative: _a, ...rest } = hatch;
    list[at] = { ...rest, loops, ...(kept > 0 ? { associative: true } : {}) };
    if (unresolved.length > 0) {
      reportObj(ctx, o, 'simplified', `associative hatch: ${kept} of ${total} boundary links kept; unresolved boundary object handle(s) ${unresolved.join(', ')} are retained as raw handles on the loop and are written back only if they name an object in the drawing`);
    }
  }
}

/** Parse a list of entity objects, folding ATTRIB/SEQEND into inserts and VERTEX into polylines. */
export function readEntities(objs: Obj[], ctx: ReadContext, keepRaw = false): Entity[] {
  const out: Entity[] = [];
  /** A converted entity: validated (invalid geometry is rejected), extrusion applied, XDATA loss reported. */
  const accept = (o: Obj, e: Entity | null): Entity | null => {
    if (!e) return null;
    const invalid = o.groups.find((p) => (isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value)))) || (isIntCode(p.code) && !isIntegerText(p.value.trim())));
    let extrusion = false;
    let xdataApps = false;
    for (const p of o.groups) {
      if (p.code === 210 || p.code === 220 || p.code === 230) extrusion = true;
      else if (p.code === 1001) xdataApps = true;
    }
    const placed = extrusion ? applyExtrusion(o, e, ctx) : e;
    const bad = geometryProblem(placed);
    if (bad) {
      reportObj(ctx, o, 'dropped', `invalid geometry: ${bad}${invalid ? ` (group ${invalid.code}, value line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}")` : ''}`);
      return null;
    }
    if (invalid) {
      reportObj(ctx, o, 'dropped', `invalid numeric group ${invalid.code} at line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}" must be a complete ${isIntCode(invalid.code) ? 'integer' : 'number'}`);
      return null;
    }
    const badPrecision = o.kind === 'DIMENSION' ? dstylePairs(o).find(([code, value]) => PRECISION_CODES[code] && invalidPrecision(PRECISION_CODES[code]!, value)) : undefined;
    if (badPrecision) {
      const name = PRECISION_CODES[badPrecision[0]]!;
      reportObj(ctx, o, 'dropped', `invalid DSTYLE ${name} precision "${shortText(badPrecision[1])}": expected ${precisionRequirement(name)}`);
      return null;
    }
    // P17: associative hatch boundary links are resolved after the pass
    // (resolveHatchAssociations below) and reported there, not here.
    if (o.kind === 'ACAD_TABLE') reportObj(ctx, o, 'simplified', 'table cells, sizes and supported style defaults are kept; formulas, style font names, advanced borders and fills are not modeled; DXF export writes a native ACAD_TABLE');
    if (e.type === 'hatch' && e.gradient) {
      const gradientProblem = hatchGradientRenderProblem(e.gradient);
      const exportProblem = hatchGradientExportProblem(e);
      if (exportProblem) reportObj(ctx, o, 'kept', `gradient hatch data and pattern are retained; native export is unavailable: ${exportProblem}${gradientProblem ? ` Display fallback: ${gradientProblem}` : ''}`);
      else if (gradientProblem) reportObj(ctx, o, 'kept', `gradient hatch definition is retained for DXF saving; solid/pattern fallback is drawn: ${gradientProblem}`);
    }
    if (e.type === 'mtext' && e.columns) reportObj(ctx, o, 'simplified', `column definitions are kept in JCAD_MTEXT_COLUMNS on AutoCAD 2000 export; other CAD programs show one column${e.columns.type === 2 || !formattedSource(e)?.includes('\\N') ? '; automatic column flow is approximated in JCad' : ''}`);
    if (e.type === 'insert' && (e.dynamic || e.dynamicRetained)) {
      // Priority 30 carriers: instance values here; the owning block's definition
      // entry is emitted once per block (shared dedup with read-sections).
      reportObj(ctx, o, 'simplified', e.dynamic ? DYNAMIC_INSTANCE_REPORT : DYNAMIC_INSTANCE_RETAINED_REPORT);
      const blockDef = ctx.blocks?.[e.block];
      if (blockDef?.dynamic) reportDynamicDefinition(ctx, e.block, false);
      else if (blockDef?.dynamicRetained) reportDynamicDefinition(ctx, e.block, true);
    }
    if (has(o, 39) && num(o, 39) !== 0) reportObj(ctx, o, 'simplified', 'nonzero thickness is not kept in the 2D drawing');
    const appearance = commonAppearanceObject(o);
    if (has(appearance, 440) && transparencyFromDxf(Number(str(appearance, 440))) === undefined) reportObj(ctx, o, 'simplified', 'invalid transparency method/alpha is not kept; ByLayer transparency is used');
    if (has(appearance, 430) && !validColorName(str(appearance, 430))) reportObj(ctx, o, 'simplified', 'invalid named/color-book identity is not kept; RGB/ACI color is kept');
    // IMAGE's IMAGEDEF reactor is reconstructed on export; other object links are unmodeled.
    const unmodeledLinks = o.kind === 'IMAGE' ? o.groups.some((p) => p.code === 102 && p.value !== '{ACAD_REACTORS' && p.value !== '}') : has(o, 102) || has(o, 360);
    if (unmodeledLinks) reportObj(ctx, o, has(o, 5) ? 'kept' : 'simplified', has(o, 5) ? 'reactor and extension-dictionary links are retained as typed object references; application-driven behavior is not simulated' : 'reactor/extension-dictionary links have no source identity and cannot be retained');
    if (e.type === 'mtext' && e.background) {
      if (e.background.flags & ~19) reportObj(ctx, o, 'simplified', 'unmodeled MTEXT background flag bits are retained but their effects are not drawn');
      if (e.background.transparency) reportObj(ctx, o, 'simplified', 'MTEXT background transparency is retained but not applied; native AutoCAD does not implement group 441');
    }
    if (ctx.report && xdataApps) {
      const consumedDstyle = o.kind === 'DIMENSION' || o.kind === 'LEADER';
      const unsupportedOverrides = o.kind === 'DIMENSION' ? dstylePairs(o).filter(([code]) => ![71, 72, 73, 74, 78, 340].includes(code) && !DIM_VARIABLES.some((v) => v.code === code)) : o.kind === 'LEADER' ? dstylePairs(o).filter(([code]) => code !== 41) : [];
      if (unsupportedOverrides.length) reportObj(ctx, o, 'simplified', `DSTYLE override groups ${unsupportedOverrides.map(([code]) => code).join(', ')} are not modeled or written back`);
      const apps = [...new Set(o.groups.filter((x) => x.code === 1001 && !isQuietXdataApp(x.value.trim(), o.kind) && !(x.value.trim() === 'ACAD' && consumedDstyle && !hasUnconsumedAcadXdata(o))).map((x) => x.value.trim()))];
      if (apps.length) reportObj(ctx, o, has(o, 5) ? 'kept' : 'simplified', `extended data (XDATA) of ${apps.join(', ')} ${has(o, 5) ? 'is retained with typed handle references' : 'has no source identity and cannot be retained'}`);
    }
    return placed;
  };
  // LEADER -> MTEXT associations (340), resolved after the pass.
  const annotations = new Map<string, number>();
  const leaders: Array<{ index: number; handle: string }> = [];
  // P17: hatch objects whose boundary links are resolved after the pass.
  const hatchObjs = new Map<HatchEntity, Obj>();
  let i = 0;
  while (i < objs.length) {
    const o = objs[i]!;
    if (o.kind === 'POLYLINE') {
      const pts: g.Point[] = [];
      const bulges: number[] = [];
      const widths: Array<{ start: number; end: number }> = [];
      const defaultStart = num(o, 40, 0), defaultEnd = num(o, 41, 0);
      let variableWidth = has(o, 40) || has(o, 41);
      const native = native3dObject(o);
      const flags = num(native, 70);
      const closed = (flags & 1) === 1;
      let j = i + 1;
      const vertexStart = j;
      while (j < objs.length && objs[j]!.kind === 'VERTEX') {
        pts.push({ x: num(objs[j]!, 10), y: num(objs[j]!, 20) });
        bulges.push(num(objs[j]!, 42, 0));
        widths.push({ start: num(objs[j]!, 40, defaultStart), end: num(objs[j]!, 41, defaultEnd) });
        variableWidth ||= has(objs[j]!, 40) || has(objs[j]!, 41);
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      i = j;
      if (has(native, 70) && !isIntegerText(str(native, 70).trim()) || !Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff) {
        reportObj(ctx, o, 'dropped', 'invalid POLYLINE structural flags: group 70 must be an integer from 0 to 65535');
        continue;
      }
      if (!(flags & 64) && payloadText(o)) {
        reportObj(ctx, o, 'dropped', 'JCAD_3D POLYLINE data has no native polyface flag; its original carrier is retained and unsafe save is refused');
        continue;
      }
      if (flags & 64) {
        // Polyface meshes: their vertex list holds face records, not an outline. In model space
        // they become experimental 3D solids (JCad's own always, others when 3D is enabled).
        const vertices = objs.slice(vertexStart, j).filter((child) => child.kind === 'VERTEX');
        if (keepRaw && ctx.solids) ctx.solids.polyface(o, vertices, ctx, objs[j - 1]?.kind === 'SEQEND' ? objs[j - 1] : undefined);
        else reportObj(ctx, o, 'dropped', ctx.solids?.accepts(o) ? '3D polyface meshes are read in model space only' : POLYFACE_UNSUPPORTED_REASON);
        continue;
      }
      if (flags & 16) {
        reportObj(ctx, o, 'dropped', 'polygon meshes are not supported');
        continue;
      }
      if (flags & 8) reportObj(ctx, o, 'simplified', '3D polyline: flattened to its XY projection');
      const width = num(o, 40, 0);
      const vertexGroups = objs.slice(vertexStart, j).filter((child) => child.kind === 'VERTEX').flatMap((child) => child.groups);
      const poly = accept({ ...o, groups: [...o.groups, ...vertexGroups] }, {
        ...commonProps(o),
        type: 'polyline',
        points: pts,
        closed,
        bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined,
        ...(variableWidth ? { widths } : { width: width !== 0 ? width : undefined }),
      });
      if (poly) out.push(poly);
      continue;
    }
    // HATCH readers use declared counts and tessellate curves before accept() sees the
    // result. Reject bad numeric tokens before those loops or geometry calculations.
    if (o.kind === 'HATCH') {
      const invalid = o.groups.find((p) => (isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value)))) || (isIntCode(p.code) && !isIntegerText(p.value.trim())));
      if (invalid) {
        reportObj(ctx, o, 'dropped', `invalid numeric group ${invalid.code}, value line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}" must be a complete finite ${isIntCode(invalid.code) ? 'safe integer' : 'number'}`);
        i += 1;
        continue;
      }
    }
    // Model-space DIMENSIONs in their own plane: experimental true 3D dimensions (dim3d-read.ts).
    if (o.kind === 'DIMENSION' && keepRaw && ctx.solids?.dimension(o, ctx)) {
      i += 1;
      continue;
    }
    let read: Entity | null;
    try {
      read = readEntityObj(o, ctx);
    } catch (err) {
      if (!(err instanceof HatchReadError) && !(err instanceof SplineWorkLimitError)) throw err;
      reportObj(ctx, o, 'dropped', err instanceof SplineWorkLimitError ? err.message : `invalid hatch data: ${err.message}`);
      i += 1;
      continue;
    }
    if (!read) {
      if (FOLLOWER_KINDS.has(o.kind)) {
        // An ATTRIB / VERTEX / SEQEND without its owner: nothing to fold it into.
        if (o.kind !== 'SEQEND') reportObj(ctx, o, 'dropped', `stray ${o.kind} record without the object it belongs to`);
      } else if (READ_KINDS.has(o.kind)) {
        reportObj(ctx, o, 'dropped', o.kind === 'DIMENSION' ? 'this dimension type (or its definition points) is not supported' : 'its data is incomplete or of a variant that is not supported');
      } else {
        const raw = keepRaw && ctx.raw ? rawRecord(o) : null;
        if (raw) {
          ctx.raw!.push(raw);
          reportObj(ctx, o, 'kept', 'not shown or editable; kept as it was and written back on save (its extended data and links to other objects are not)');
        } else {
          const why = UNSUPPORTED_REASONS[o.kind] ?? `${o.kind} objects are not supported`;
          const solidData = RAW_KEEP_KINDS.has(o.kind) && keepRaw ? ' (its data is stored outside the object in this file version, so it cannot be kept)' : RAW_KEEP_KINDS.has(o.kind) ? ' (kept only in model space)' : '';
          reportObj(ctx, o, 'dropped', why + solidData);
        }
      }
      i += 1;
      continue;
    }
    // TEXT / MTEXT keep their text style name (group 7) for the TrueType renderer and the writer.
    const styled = read && (read.type === 'text' || read.type === 'mtext') ? withTextStyle(read, str(o, 7)) : read;
    const e = accept(o, styled && xdata(o, ANNO_APP) ? ({ ...styled, annotative: true } as Entity) : styled);
    if (!e) {
      // Rejected (invalid geometry): skip its ATTRIB / SEQEND followers too.
      let j = i + 1;
      while (j < objs.length && (objs[j]!.kind === 'ATTRIB' || objs[j]!.kind === 'SEQEND')) j += 1;
      i = j;
      continue;
    }
    if (e && e.type === 'hatch') hatchObjs.set(e, o);
    if (e && e.type === 'insert') {
      const attribObjs: Obj[] = [];
      let j = i + 1;
      while (j < objs.length && objs[j]!.kind === 'ATTRIB') {
        attribObjs.push(objs[j]!);
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      const def = ctx.blocks?.[e.block];
      if (def) {
        out.push(foldAttribRecords(e, def, attribObjs, (o, message) => reportObj(ctx, o, 'simplified', message)));
      } else if (attribObjs.length) {
        // Forward reference (C04): the owning block's definition is not
        // known yet. Values fold now (definition-free); the raw records
        // are retained for the deferred placement/appearance replay.
        const attrs: Record<string, string> = {};
        for (const o of attribObjs) attrs[str(o, 2)] = str(o, 1);
        const withValues: InsertEntity = { ...e, attributes: attrs };
        deferredAttribFolds.set(withValues, attribObjs);
        out.push(withValues);
      } else {
        out.push({ ...e, attributes: {} });
      }
      i = j;
      continue;
    }
    if (e && (o.kind === 'MTEXT' || o.kind === 'TEXT') && has(o, 5)) annotations.set(str(o, 5).toUpperCase(), out.length);
    if (e && e.type === 'leader' && o.kind === 'LEADER' && has(o, 340)) leaders.push({ index: out.length, handle: str(o, 340).toUpperCase() });
    if (e) out.push(e);
    i += 1;
  }
  resolveHatchAssociations(out, hatchObjs, ctx);
  if (!leaders.length) return out;
  const drop = new Set<number>();
  for (const l of leaders) {
    const at = annotations.get(l.handle);
    const ann = at === undefined ? undefined : out[at];
    const ld = out[l.index];
    if (!ann || !ld || ld.type !== 'leader' || drop.has(at!)) continue;
    if (ann.type === 'mtext') {
      const appearance = ann as typeof ann & AttributeAppearance;
      out[l.index] = {
        ...ld,
        text: ann.text,
        ...(ann.raw ? { raw: ann.raw } : {}),
        textPosition: ann.position,
        textHeight: ann.height,
        textAttachment: ann.attachment,
        textLayer: ann.layer,
        textAppearance: { color: appearance.color, ...(appearance.trueColor !== undefined ? { trueColor: appearance.trueColor } : {}), ...(appearance.colorName !== undefined ? { colorName: appearance.colorName } : {}), ...(appearance.transparency !== undefined ? { transparency: appearance.transparency } : {}) },
        textLineSpacing: ann.lineSpacing,
        ...(ann.background ? { textBackground: ann.background } : {}),
        ...(ann.columns ? { textColumns: ann.columns } : {}),
        ...(ann.width > 0 ? { textWidth: ann.width } : {}),
        ...(Math.abs(ann.rotation) > 1e-12 ? { textRotation: ann.rotation } : {}),
      };
      drop.add(at!);
    } else if (ann.type === 'text') {
      const t = ann as TextEntity;
      out[l.index] = { ...ld, text: t.text, textPosition: t.position, textHeight: t.height, textAttachment: t.align === 'center' ? 8 : t.align === 'right' ? 9 : 7, ...(Math.abs(t.rotation) > 1e-12 ? { textRotation: t.rotation } : {}) };
      drop.add(at!);
    }
  }
  return drop.size ? out.filter((_, k) => !drop.has(k)) : out;
}
