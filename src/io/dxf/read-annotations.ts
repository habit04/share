/**
 * Entity codecs, reader side, for annotation and reference objects: DIMENSION (with its style),
 * LEADER (with DSTYLE overrides), MULTILEADER (CONTEXT_DATA), IMAGE, ACAD_TABLE cell data and the
 * tables JCad writes (an INSERT with the cell data as JCAD_TABLE XDATA).
 */
import type { Obj, Pair } from './groups';
import type { AttributeDef, DimStyle, Entity, LeaderEntity, ImageEntity, TableEntity, TableCell } from '../../core/entities';
import { str, xdata, num, pt, has, flt, int, afterSubclass, pointList, DxfReadError, isIntegerText } from './groups';
import { dimStyleFromRecordPairs, dimStyleOverrideName, dimVarValue, arrowFromBlockName, arrowBlockName, DIM_ARROWS, DIM_VARIABLES, ordinateDimensionProblem } from '../../core/dimension';
import { DIMSTYLE_APP, MTEXT_COLUMNS_APP, TABLE_APP, isRealText, isRealCode, isIntCode } from './codes';
import { applyDimStyleXdata } from './dimstyles';
import { commonProps } from './read-core';
import * as g from '../../core/geometry';
import type { ReadContext } from './read-core';
import { mtextFromDxf, hasFormatting } from '../../core/mtext';
import { isEscapedPlainContent } from './write-annotations';
import { cellOwners } from '../../core/table';
import type { MTextAttachment, MTextColumns } from '../../core/mtext';
import { STANDARD_MLEADER_STYLE, type MLeaderBlockAttribute, type MLeaderBlockContent, type MLeaderContext, type MLeaderNative, type MLeaderStyleRetained } from '../../core/multileader';

export function readDimStyleFromEntity(o: Obj, styles: Map<string, DimStyle>, fallback: DimStyle, textStyleHandles?: ReadonlyMap<string, string>): DimStyle {
  const name = str(o, 3);
  const style = (name && styles.get(name.toUpperCase())) || fallback;
  const overrides = dstylePairs(o);
  let result = overrides.length ? dimStyleFromRecordPairs(style.name, overrides, style) : style;
  const overrideStyle = overrides.find(([code]) => code === 340)?.[1];
  const resolvedStyle = overrideStyle ? textStyleHandles?.get(overrideStyle.toUpperCase()) : undefined;
  if (resolvedStyle) result = { ...result, textStyle: resolvedStyle };
  const arrowData = xdata(o, DIMSTYLE_APP);
  return arrowData ? applyDimStyleXdata(result, arrowData) : result;
}

export function readDimension(o: Obj, base: ReturnType<typeof commonProps>, style: DimStyle, textStyleHandles?: ReadonlyMap<string, string>): Entity | null {
  const flags = Math.trunc(num(o, 70));
  const type = flags & 15;
  const userText = flags & 128 ? pt(o, 11) : undefined;
  const textRaw = str(o, 1);
  const text = textRaw && textRaw !== '<>' ? textRaw : undefined;
  // Groups 53 (text rotation) and 52 (oblique), degrees; 0 means "not set".
  const rot = num(o, 53);
  const obl = num(o, 52);
  const angles = { ...(Math.abs(rot) > 1e-9 ? { textRotation: g.rad(rot) } : {}), ...(Math.abs(obl) > 1e-9 && (type === 0 || type === 1) ? { oblique: g.rad(obl) } : {}) };
  // Values alone cannot distinguish an inherited value from an explicit equal override.
  // Keep only supported variables; unresolved handles and unmodeled codes stay out of the model.
  const styleOverrides: Record<string, number | string> = {};
  for (const [code, value] of dstylePairs(o)) {
    const name = dimStyleOverrideName(code);
    if (!name) continue;
    if (code === 340) {
      const resolved = textStyleHandles?.get(value.toUpperCase());
      if (resolved) styleOverrides[name] = resolved;
      continue;
    }
    const variable = DIM_VARIABLES.find((v) => v.name === name);
    if (variable?.kind !== 'string' && !Number.isFinite(Number(value))) continue;
    if (variable?.kind === 'enum' && !variable.values?.some(([n]) => n === Math.round(Number(value)))) continue;
    // Native integer XDATA must not receive a malformed fractional value on export.
    // Normalize it as the effective style parser does, while retaining the distinct 0/1
    // combinations of DIMTIH/DIMTOH that share one normalized display mode.
    styleOverrides[name] = variable?.kind === 'string' ? value
      : variable?.kind === 'number' && code !== 371 && code !== 372 ? Number(value)
      : code === 78 ? Math.trunc(Number(value))
      : variable ? dimVarValue(style, name)
      : Number(value) !== 0 ? 1 : 0;
  }
  const arrowData = xdata(o, DIMSTYLE_APP)?.filter((p) => p.code === 1000).map((p) => p.value) ?? [];
  for (let i = 0; i + 1 < arrowData.length; i += 2) {
    const name = arrowData[i]!.toUpperCase();
    const value = arrowData[i + 1]!;
    if (name === 'TOLERANCE' && ['none', 'symmetrical', 'deviation', 'limits', 'basic'].includes(value)) styleOverrides[name] = value;
    else if (name === 'ALTPLACEMENT' && ['after', 'below'].includes(value)) styleOverrides[name] = value;
    else if (name === 'DIMBLK1' || name === 'DIMBLK2') {
      const block = value.toUpperCase();
      if (block === '.' || block === '' || DIM_ARROWS.some((a) => a.block === (block.startsWith('_') ? block : `_${block}`))) styleOverrides[name] = arrowBlockName(arrowFromBlockName(value));
    }
  }
  const common = { ...base, type: 'dimension' as const, text, textPosition: userText, ...angles, style, styleOverrides };
  const subclasses = o.groups.filter((x) => x.code === 100).map((x) => x.value);
  switch (type) {
    case 6: {
      const refuse = (reason: string): never => { throw new DxfReadError(`Ordinate dimension cannot be imported without changing its data: ${reason}`, o.groups[0]?.line ?? 1); };
      if (!Number.isSafeInteger(Number(str(o, 70))) || flags < 0 || flags > 230 || flags & ~230) refuse('unsupported dimension flags');
      if (o.groups.some((p) => isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value))) || isIntCode(p.code) && !isIntegerText(p.value.trim()))) refuse('invalid native numeric group');
      if (!subclasses.includes('AcDbOrdinateDimension')) refuse('missing native ordinate subclass');
      for (const code of [10, 13, 14]) if (!has(o, code)) refuse(`missing definition point ${code}`);
      if (flags & 128 && !has(o, 11)) refuse('missing manually positioned text point');
      const coordinates = new Set([10, 20, 30, 11, 21, 31, 13, 23, 33, 14, 24, 34, 51, 53, 210, 220, 230]);
      if (o.groups.some((p) => coordinates.has(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value))))) refuse('invalid numeric coordinate or angle');
      if ([30, 31, 33, 34].some((code) => num(o, code) !== 0) || num(o, 210) !== 0 || num(o, 220) !== 0 || num(o, 230, 1) !== 1) refuse('only XY dimensions with the positive Z normal are supported');
      if (num(o, 71, 5) !== 5 || num(o, 72, 1) !== 1 || num(o, 41, 1) !== 1 || num(o, 52) !== 0) refuse('unsupported native text attachment, spacing or oblique mode');
      const frame = g.normAngle(-g.rad(num(o, 51)));
      const result = { ...common, kind: 'ordinate' as const, p1: pt(o, 10), p2: pt(o, 13), linePoint: pt(o, 14), rotation: 0,
        ordinateAxis: flags & 64 ? 'x' as const : 'y' as const, ordinateRotation: frame,
        ...(Math.abs(rot) > 1e-9 ? { textRotation: g.normAngle(frame + g.rad(rot)) } : {}) };
      const problem = ordinateDimensionProblem(result);
      if (problem) refuse(problem);
      return result;
    }
    case 0: {
      const p1 = pt(o, 13);
      const p2 = pt(o, 14);
      const rotation = g.rad(num(o, 50));
      return { ...common, kind: 'linear', p1, p2, linePoint: pt(o, 10), rotation };
    }
    case 1:
      return { ...common, kind: 'aligned', p1: pt(o, 13), p2: pt(o, 14), linePoint: pt(o, 10), rotation: 0 };
    case 3: {
      const a = pt(o, 10);
      const b = pt(o, 15);
      const center = g.mid(a, b);
      const leader = num(o, 40);
      const dir = g.normalize(g.sub(a, center));
      return { ...common, kind: 'diameter', p1: center, p2: a, linePoint: userText ?? g.add(a, g.scale(dir, leader)), rotation: 0 };
    }
    case 4: {
      const center = pt(o, 10);
      const q = pt(o, 15);
      const leader = num(o, 40);
      const dir = g.normalize(g.sub(q, center));
      return { ...common, kind: 'radius', p1: center, p2: q, linePoint: userText ?? g.add(q, g.scale(dir, leader)), rotation: 0 };
    }
    case 5:
      return { ...common, kind: 'angular', p1: pt(o, 13), p2: pt(o, 14), center: pt(o, 15), linePoint: pt(o, 10), rotation: 0 };
    case 2: {
      // Two-line angular: legs 13->14 and 15->10, arc point 16.
      if (!subclasses.includes('AcDb2LineAngularDimension') && !has(o, 16)) return null;
      const a1 = pt(o, 13);
      const a2 = pt(o, 14);
      const b1 = pt(o, 15);
      const b2 = pt(o, 10);
      const r = g.sub(a2, a1);
      const s = g.sub(b2, b1);
      const denom = g.cross(r, s);
      if (Math.abs(denom) < 1e-12) return null;
      const t = g.cross(g.sub(b1, a1), s) / denom;
      const center = g.add(a1, g.scale(r, t));
      const far = (p: g.Point, q: g.Point) => (g.dist(p, center) >= g.dist(q, center) ? p : q);
      return { ...common, kind: 'angular', p1: far(a1, a2), p2: far(b1, b2), center, linePoint: pt(o, 16), rotation: 0 };
    }
    default:
      return null;
  }
}

/** A dimension-variable override (ACAD DSTYLE xdata: 1070 code, 1040/1070 value). */
function dstyleOverride(o: Obj, dimvarCode: number): number | undefined {
  const value = dstylePairs(o).find(([code]) => code === dimvarCode)?.[1];
  return value === undefined ? undefined : flt(String(value));
}

export function dstylePairs(o: Obj): Array<readonly [number, string]> {
  const xd = xdata(o, 'ACAD');
  if (!xd) return [];
  const start = xd.findIndex((p) => p.code === 1000 && p.value === 'DSTYLE');
  if (start < 0 || xd[start + 1]?.code !== 1002 || xd[start + 1]?.value !== '{') return [];
  const out: Array<readonly [number, string]> = [];
  for (let k = start + 2; k + 1 < xd.length && xd[k]!.code !== 1002; k += 2) {
    const key = xd[k]!, value = xd[k + 1]!;
    if (key.code === 1070 && [1000, 1005, 1040, 1070, 1071].includes(value.code)) out.push([int(key.value), value.value]);
  }
  return out;
}

export function hasUnconsumedAcadXdata(o: Obj): boolean {
  const xd = xdata(o, 'ACAD');
  if (!xd) return false;
  const start = xd.findIndex((p) => p.code === 1000 && p.value === 'DSTYLE');
  const end = xd.findIndex((p, i) => i > start + 1 && p.code === 1002 && p.value === '}');
  return start < 0 || end < 0 || !dstylePairs(o).length || xd.slice(0, start).length > 0 || xd.slice(end + 1).length > 0;
}

export function readLeader(o: Obj, base: ReturnType<typeof commonProps>, ctx: ReadContext): LeaderEntity | null {
  const gs = afterSubclass(o, 'AcDbLeader');
  const vertices = pointList(gs, 10);
  if (vertices.length < 2) return null;
  const hook = int(gs.find((x) => x.code === 75)?.value) === 1;
  let verts = vertices;
  let dogleg: g.Point | undefined;
  if (hook && verts.length >= 3) {
    dogleg = g.sub(verts[verts.length - 1]!, verts[verts.length - 2]!);
    verts = verts.slice(0, -1);
  }
  const ds = ctx.dimStyle;
  const size = dstyleOverride(o, 41) ?? ds.arrowSize * (ds.scale || 1);
  return {
    ...base,
    type: 'leader',
    vertices: verts,
    arrow: int(gs.find((x) => x.code === 71)?.value, 1) !== 0,
    arrowSize: size,
    ...(dogleg ? { dogleg } : {}),
    ...(int(gs.find((x) => x.code === 72)?.value) === 1 ? { spline: true } : {}),
    textHeight: flt(gs.find((x) => x.code === 40)?.value, ds.textHeight * (ds.scale || 1)) || ds.textHeight,
    kind: 'leader',
  };
}

/**
 * THE block-content trigger predicate for a MULTILEADER record — the ONE
 * implementation shared by readMLeader (which withholds or models native
 * data) and by its caller in read-entities.ts (which reports the outcome),
 * so the two can never disagree (acceptance finding F-1: the reader used
 * `int(296) !== 0` while the caller matched the exact string '1', and the
 * gap between them — 296 = '2' or '01', or a trailing 172 = '01', with an
 * unresolvable block — fell back to the legacy LEADER path in silence).
 *
 * The predicate mirrors readMLeader's own scan exactly: group 296 counts
 * only inside the CONTEXT_DATA section and signals when it parses to a
 * NONZERO integer (296 is a boolean AutoCAD writes as 0/1; any nonzero
 * spelling still means the source claims block content); the trailing
 * content type is the LAST group 172 outside every {...} section and
 * signals when it parses to 1. Section tracking replicates readMLeader's
 * depth machine (300 CONTEXT_DATA{ / 301 close, 302 LEADER{ / 303 close,
 * 304 LEADER_LINE{ / 305 close). Invariant: the set of records this
 * predicate signals is EXACTLY the set readMLeader treats as block
 * content — each is either modelled (caller notes it) or reported
 * `simplified` by the caller (R-MLEADER-18); there is no third state.
 */
export function mleaderBlockContentSignalled(o: Obj): boolean {
  // Section stack, replicating readMLeader's depth machine group-for-group:
  // a group is dispatched by the stack top left by the preceding groups,
  // exactly as in readMLeader (its opener checks run first and continue).
  let depth: string[] = [];
  let hasBlock = false;
  let contentType: number | undefined;
  for (const p of o.groups) {
    if (p.code === 300 && p.value.startsWith('CONTEXT_DATA')) { depth.push('CONTEXT'); continue; }
    if (p.code === 301) { depth = depth.filter((d) => d !== 'CONTEXT'); continue; }
    if (p.code === 302 && p.value.startsWith('LEADER{')) { depth.push('LEADER'); continue; }
    if (p.code === 303) { depth.pop(); continue; }
    if (p.code === 304 && p.value.startsWith('LEADER_LINE{')) { depth.push('LINE'); continue; }
    if (p.code === 305) { depth.pop(); continue; }
    const top = depth[depth.length - 1];
    if (top === 'CONTEXT') { if (p.code === 296) hasBlock = int(p.value) !== 0; }
    else if (top === undefined && p.code === 172) contentType = int(p.value);
  }
  return hasBlock || contentType === 1;
}

/**
 * THE ONE chain resolution (slice 3 + S3-D, RULING-P18-S3-D (1)(iv)): how a
 * MULTILEADER record's additional annotative contexts are stored, counted and
 * — for readMLeader — materialised. readMLeader's join and the read-entities
 * caller's reporting consume THIS resolution and no other; a second chain
 * walk is the F-1 drift class. A record's contexts live in one of two
 * layouts: inline CONTEXT_DATA sections (the slice-3 dialect — still read,
 * never written after S3-D), or, as AutoCAD writes them, CONTEXT objects in
 * OBJECTS behind the entity's extension dictionary (entity 102/360 subgroup
 * -> extension dictionary -> 'AcDbContextDataManager' entry (360) -> manager
 * dictionary -> 'ACDB_ANNOTATIONSCALES' entry (350) -> scales dictionary ->
 * its entries (350, in entry order) -> ACDB_MLEADEROBJECTCONTEXTDATA_CLASS
 * objects). An object is a context of THIS entity only through that chain:
 * no global scale matching, and SCALE objects are never consulted — the
 * object's stored group 40 is authoritative (RULING-P18-S3-D (1)(ii)(alpha)).
 */
export interface MLeaderContextChain {
  /** Inline CONTEXT_DATA sections in the record (the primary included). */
  inlineSections: number;
  /** Additional annotative contexts across BOTH layouts: inline sections
   *  beyond the first, plus resolved context objects minus the default. */
  additional: number;
  /** The extension-dictionary chain is present and carries the manager entry. */
  engaged: boolean;
  /** A link of an engaged chain names no dictionary / no object, or a record
   *  that is not a context-data object: whole-entity withholding leg. */
  dangling: boolean;
  /** A resolved object does not parse as a context (its annot-scale header or
   *  its group 40 is missing or unusable): whole-entity withholding leg, its
   *  failure folded into the (2)(a) conditions like the inline ones. */
  unparseable: boolean;
  /** Inline additional sections AND an engaged chain: both-dialects
   *  withholding leg — two competing additional-context sources, never merged. */
  conflict: boolean;
  /** Synthetic CONTEXT_DATA sections for the resolved non-default objects, in
   *  dictionary order, for readMLeader's capture loop (300 opener + the
   *  object's stored group 40 + its body groups + 301 close). Empty unless
   *  the chain resolves cleanly. */
  objectSections: Pair[][];
}

/** One dictionary entry's target handle (the pair after its group-3 key). */
const dictEntryTarget = (dict: Obj, keyUpper: string): string | undefined => {
  for (let k = 0; k + 1 < dict.groups.length; k += 1) {
    const p = dict.groups[k]!;
    if (p.code === 3 && p.value.trim().toUpperCase() === keyUpper) {
      const q = dict.groups[k + 1]!;
      if (q.code === 350 || q.code === 360) return q.value.trim().toUpperCase();
    }
  }
  return undefined;
};

interface ResolvedContextObject {
  /** Group 290 = 1 at the AcDbObjectContextData level (the default object). */
  isDefault: boolean;
  /** The object's stored group 40, verbatim text. */
  scaleText: string;
  /** The CONTEXT_DATA body groups (everything after the header's group 40). */
  body: Pair[];
}

/**
 * Parse one context-data object's header (RULING-P18-S3-D (1)(ii), fixture
 * facts F2/F4): the default flag is the group 290 between the
 * AcDbObjectContextData and AcDbAnnotScaleObjectContextData subclass markers;
 * the body's first group is the one after the header's group 40. The object's
 * group 340 (its SCALE reference) is header material, never body: it is not
 * consulted (the stored 40 is authoritative) and never reaches the capture.
 */
const parseContextObject = (o: Obj): ResolvedContextObject | null => {
  const gs = o.groups;
  const objAt = gs.findIndex((p) => p.code === 100 && p.value.trim() === 'AcDbObjectContextData');
  if (objAt < 0) return null;
  const annotAt = gs.findIndex((p, i) => i > objAt && p.code === 100 && p.value.trim() === 'AcDbAnnotScaleObjectContextData');
  if (annotAt < 0) return null;
  let isDefault = false;
  for (let i = objAt + 1; i < annotAt; i += 1) {
    if (gs[i]!.code === 290) {
      isDefault = int(gs[i]!.value) === 1;
      break;
    }
  }
  // The header is rigid (F2): the annot-scale marker is followed by the
  // SCALE reference (340, optional) and then the group 40 — positionally.
  // A first-40-anywhere search would mistake the body's own dogleg-length
  // 40 for the header's when the header's is missing, completing a corrupt
  // object by fallback: exactly the fabrication class S3-B closed inline.
  let at40 = annotAt + 1;
  if (gs[at40]?.code === 340) at40 += 1;
  if (gs[at40]?.code !== 40) return null;
  const scaleText = gs[at40]!.value;
  if (!Number.isFinite(flt(scaleText))) return null;
  return { isDefault, scaleText, body: gs.slice(at40 + 1) };
};

export function resolveMLeaderContextChain(o: Obj, ctx: ReadContext): MLeaderContextChain {
  let inlineSections = 0;
  for (const p of o.groups) if (p.code === 300 && p.value.startsWith('CONTEXT_DATA')) inlineSections += 1;
  const inlineAdditional = Math.max(0, inlineSections - 1);
  const none: MLeaderContextChain = {
    inlineSections,
    additional: inlineAdditional,
    engaged: false,
    dangling: false,
    unparseable: false,
    conflict: false,
    objectSections: [],
  };
  // Scope edge (RULING-P18-S3-D (1)(ii)(zeta)): an objects-only primary (an
  // engaged chain on a record with NO inline section) is outside the S3-D
  // admission — the pre-existing no-inline-section posture stands, untouched.
  if (inlineSections === 0) return none;
  const data = ctx.mleaderContextData;
  if (!data) return none;
  // The entity's own extension-dictionary subgroup (102 '{ACAD_XDICTIONARY'
  // followed by its 360 soft pointer) — the chain's first link.
  let extHandle: string | undefined;
  for (let k = 0; k + 1 < o.groups.length; k += 1) {
    if (o.groups[k]!.code === 102 && o.groups[k]!.value.includes('ACAD_XDICTIONARY') && o.groups[k + 1]!.code === 360) {
      extHandle = o.groups[k + 1]!.value.trim().toUpperCase();
      break;
    }
  }
  if (!extHandle) return none;
  const ext = data.dictionaries.get(extHandle);
  // A present subgroup whose 360 names no dictionary dangles (W3 leg).
  if (!ext) return { ...none, engaged: true, dangling: true };
  // Engagement is ONLY via the manager entry (RULING-P18-S3-D (1)(ii)(beta)):
  // an extension dictionary without one carries no object contexts at all —
  // no note, no simplified, no withholding, whatever else it holds.
  const managerHandle = dictEntryTarget(ext, 'ACDBCONTEXTDATAMANAGER');
  if (!managerHandle) return none;
  const engaged: MLeaderContextChain = { ...none, engaged: true, conflict: inlineAdditional >= 1 };
  const manager = data.dictionaries.get(managerHandle);
  if (!manager) return { ...engaged, dangling: true };
  const scalesHandle = dictEntryTarget(manager, 'ACDB_ANNOTATIONSCALES');
  if (!scalesHandle) return { ...engaged, dangling: true };
  const scales = data.dictionaries.get(scalesHandle);
  if (!scales) return { ...engaged, dangling: true };
  // The scales dictionary's entries, in entry order (= the contexts' file order).
  const handles: string[] = [];
  for (let k = 0; k + 1 < scales.groups.length; k += 1) {
    if (scales.groups[k]!.code === 3 && scales.groups[k + 1]!.code === 350) handles.push(scales.groups[k + 1]!.value.trim().toUpperCase());
  }
  const resolved: ResolvedContextObject[] = [];
  for (const h of handles) {
    const obj = data.contextObjects.get(h);
    if (!obj) return { ...engaged, dangling: true };
    const parsed = parseContextObject(obj);
    if (!parsed) return { ...engaged, unparseable: true };
    resolved.push(parsed);
  }
  // The FIRST 290 = 1 object is THE default and is excluded from contexts
  // (its body is never cross-checked against the inline section — the inline
  // section is authoritative for the primary); any FURTHER 290 = 1 object is
  // modelled as an additional context (the no-dedup pin stands). If no object
  // is flagged, none is excluded. An empty scales dictionary adds nothing
  // and is not a leg.
  let defaultSeen = false;
  const additionals: ResolvedContextObject[] = [];
  for (const r of resolved) {
    if (r.isDefault && !defaultSeen) {
      defaultSeen = true;
      continue;
    }
    additionals.push(r);
  }
  const objectSections = additionals.map((r) => [
    { code: 300, value: 'CONTEXT_DATA{' },
    { code: 40, value: r.scaleText },
    ...r.body,
    { code: 301, value: 'CONTEXT_DATA}' },
  ]);
  return { ...engaged, additional: inlineAdditional + additionals.length, objectSections };
}

/**
 * How many ADDITIONAL annotative contexts a MULTILEADER record carries,
 * across both storage layouts (slice 3 + S3-D): the RULING-P18-S3 (2)(b)
 * counting pin AS AMENDED by RULING-P18-S3-D (1)(iii) — one implementation,
 * the chain resolution above, shared by readMLeader and the caller. The
 * read-entities.ts caller reports multi-context records from this count —
 * modelled ones by an informational note, withheld ones by a `simplified`
 * entry (R-MLEADER-18 reporting) — and also fires on a dangling or
 * both-dialects chain (a withheld record always reports).
 */
export function mleaderContextSectionCount(o: Obj, ctx: ReadContext): number {
  return resolveMLeaderContextChain(o, ctx).additional;
}

/** Per-CONTEXT_DATA-section capture for readMLeader (slice 3). Fields mirror the
 *  modelled context groups one-for-one; the trailing-section groups stay
 *  record-level in readMLeader (the file carries them once, for the entity). */
interface MLeaderCtxAcc {
  paths: g.Point[][];
  text: string;
  textPos?: g.Point;
  textHeight?: number;
  textWidth?: number;
  textRotation: number;
  textDir?: g.Point;
  attachment?: number;
  arrowSize?: number;
  firstDogleg?: g.Point;
  scaleFactor?: number;
  landingGap?: number;
  textStyleHandle?: string;
  blockHandleCtx?: string;
  blockPos?: g.Point;
  ctxBasePos?: g.Point;
  blockScaleCtx?: g.Point;
  blockRotationCtx?: number;
}

/**
 * MULTILEADER: leader lines, landing and MTEXT content from the CONTEXT_DATA section.
 * Block content is not drawn (noted by the caller); missing parts degrade to what is present.
 */
export function readMLeader(o: Obj, base: ReturnType<typeof commonProps>, ctx: ReadContext): LeaderEntity | null {
  const gs = o.groups;
  // S3-D: the ONE chain resolution — the resolved non-default context objects
  // ride the capture loop below as synthetic CONTEXT_DATA sections appended
  // after the record's own groups, parsed by the SAME accumulator/finalize
  // machinery as inline sections, so every (2)(a) withholding condition and
  // fallback chain applies to object contexts unchanged (RULING-P18-S3-D
  // (1)(ii)(delta)). The record's own trailing groups are all consumed before
  // the synthetic sections begin, so nothing record-level is disturbed.
  const chain = resolveMLeaderContextChain(o, ctx);
  const seq: Pair[] = chain.objectSections.length ? [...gs, ...chain.objectSections.flat()] : gs;
  // Slice 3 (PROPOSAL-P18-S3): capture is PER CONTEXT_DATA section. The first
  // section's accumulator is the primary (its finalize below is the exact
  // slice-1/2 path, so single-context records produce the slice-1/2 model
  // field-for-field); each further opener starts a new accumulator. Before
  // slice 3 these accumulators were flat per record, which merged every
  // section into one representation — the last context's scalars won and the
  // MTEXT text concatenated (the proposal's current-head retention gap).
  const newAcc = (): MLeaderCtxAcc => ({ paths: [], text: '', textRotation: 0 });
  const accs: MLeaderCtxAcc[] = [newAcc()];
  let cur = accs[0]!;
  let contextSections = 0;
  // AMENDMENT-P18-S3-B (acceptance finding F-T): per-section termination —
  // sectionTerminated[i] turns true when the i-th CONTEXT_DATA section's own
  // 301 close arrives. Sections close in opener order (the depth machine's
  // 301 clears every CONTEXT entry at once), so a 301 discharges the most
  // recent still-open section; a section superseded by a later opener, or
  // still open when the record's groups end, stays unterminated.
  const sectionTerminated: boolean[] = [];
  let depth: string[] = [];
  let lastLeaderPoint: g.Point | undefined;
  let doglegVec: g.Point | undefined;
  let doglegLen: number | undefined;
  let line: g.Point[] | null = null;
  const sectionLines: g.Point[][] = [];
  let commonArrow: number | undefined;
  let commonDogleg: number | undefined;
  let lineType = 1;
  // P18 native capture: trailing style + content type (record-level).
  let styleHandle: string | undefined;
  let contentTypeRaw: number | undefined;
  // P18 slice 2 block-content capture (PROPOSAL-P18-S2): the trailing attribute
  // entries (330 ATTDEF handle / 177 definition index / 44 width / 302 text)
  // and trailing block fallbacks (344/10/43) are record-level. Trailing groups
  // are only collected after CONTEXT_DATA closes — before it, a 330 is the
  // entity's owner, not an attribute.
  let contextClosed = false;
  let blockHandleTrail: string | undefined;
  let blockScaleTrail: g.Point | undefined;
  let blockRotationTrail: number | undefined;
  const pendingAttrs: Array<{ handle?: string; index?: number; width?: number; text?: string }> = [];
  const endSection = () => {
    // A LEADER{} section: each of its lines runs arrow -> ... -> last leader point, then the landing.
    for (const l of sectionLines) cur.paths.push(lastLeaderPoint ? [...l, lastLeaderPoint] : l);
    if (!cur.firstDogleg && lastLeaderPoint && doglegVec && doglegLen) cur.firstDogleg = g.scale(g.normalize(doglegVec), doglegLen);
    sectionLines.length = 0;
    lastLeaderPoint = undefined;
    doglegVec = undefined;
    doglegLen = undefined;
  };
  for (let k = 0; k < seq.length; k += 1) {
    const p = seq[k]!;
    const top = depth[depth.length - 1];
    if (p.code === 300 && p.value.startsWith('CONTEXT_DATA')) {
      contextSections += 1;
      sectionTerminated.push(false);
      if (contextSections > 1) {
        cur = newAcc();
        accs.push(cur);
      }
      depth.push('CONTEXT');
      continue;
    }
    if (p.code === 301) {
      depth = depth.filter((d) => d !== 'CONTEXT');
      const openIdx = sectionTerminated.lastIndexOf(false);
      if (openIdx >= 0) sectionTerminated[openIdx] = true;
      contextClosed = true;
      continue;
    }
    if (p.code === 302 && p.value.startsWith('LEADER{')) {
      depth.push('LEADER');
      continue;
    }
    if (p.code === 303) {
      endSection();
      depth.pop();
      continue;
    }
    if (p.code === 304 && p.value.startsWith('LEADER_LINE{')) {
      depth.push('LINE');
      line = [];
      continue;
    }
    if (p.code === 305) {
      if (line && line.length) sectionLines.push(line);
      line = null;
      depth.pop();
      continue;
    }
    const nextY = () => flt(seq[k + 1]?.code === p.code + 10 ? seq[k + 1]!.value : undefined);
    if (top === 'LINE') {
      if (p.code === 10) line?.push({ x: flt(p.value), y: nextY() });
      continue;
    }
    if (top === 'LEADER') {
      if (p.code === 10) lastLeaderPoint = { x: flt(p.value), y: nextY() };
      else if (p.code === 11) doglegVec = { x: flt(p.value), y: nextY() };
      else if (p.code === 40) doglegLen = flt(p.value);
      continue;
    }
    if (top === 'CONTEXT') {
      switch (p.code) {
        case 40:
          cur.scaleFactor = flt(p.value);
          break;
        case 41:
          cur.textHeight = flt(p.value);
          break;
        case 140:
          cur.arrowSize = flt(p.value);
          break;
        case 145:
          cur.landingGap = flt(p.value);
          break;
        case 340:
          cur.textStyleHandle = p.value.trim().toUpperCase();
          break;
        case 341:
          cur.blockHandleCtx = p.value.trim().toUpperCase();
          break;
        case 15:
          cur.blockPos = { x: flt(p.value), y: nextY() };
          break;
        case 16:
          cur.blockScaleCtx = { x: flt(p.value), y: nextY() };
          break;
        case 46:
          cur.blockRotationCtx = flt(p.value);
          break;
        case 10:
          cur.ctxBasePos = { x: flt(p.value), y: nextY() };
          break;
        case 304:
          cur.text += p.value;
          break;
        case 12:
          cur.textPos = { x: flt(p.value), y: nextY() };
          break;
        case 13:
          cur.textDir = { x: flt(p.value), y: nextY() };
          break;
        case 42:
          cur.textRotation = flt(p.value);
          break;
        case 43:
          cur.textWidth = flt(p.value);
          break;
        case 171:
          cur.attachment = int(p.value);
          break;
        default:
          break;
      }
      continue;
    }
    // Common MLeader data after the context section.
    if (p.code === 170) lineType = int(p.value, 1);
    else if (p.code === 42) commonArrow = flt(p.value);
    else if (p.code === 41) commonDogleg = flt(p.value);
    else if (p.code === 172) contentTypeRaw = int(p.value);
    else if (p.code === 340 && styleHandle === undefined) styleHandle = p.value.trim().toUpperCase();
    // Slice 2 trailing block data — only after CONTEXT_DATA has closed (before
    // it, depth is also empty at the entity header, where 330 is the owner).
    if (contextClosed) {
      if (p.code === 344) blockHandleTrail = p.value.trim().toUpperCase();
      else if (p.code === 10) blockScaleTrail = { x: flt(p.value), y: nextY() };
      else if (p.code === 43) blockRotationTrail = flt(p.value);
      else if (p.code === 330) pendingAttrs.push({ handle: p.value.trim().toUpperCase() });
      else if (p.code === 177 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.index = int(p.value);
      else if (p.code === 44 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.width = flt(p.value);
      else if (p.code === 302 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.text = p.value;
    }
  }
  const primary = accs[0]!;
  const paths = primary.paths;
  const main = paths.shift();
  if (!main || main.length < 2) return null;
  const ds = ctx.dimStyle;
  const size = primary.arrowSize ?? commonArrow ?? ds.arrowSize * (ds.scale || 1);
  const dogleg = primary.firstDogleg ?? undefined;
  void commonDogleg;
  const plain = primary.text ? mtextFromDxf(primary.text) : '';
  const rot = primary.textDir && (primary.textDir.x !== 0 || primary.textDir.y !== 0) ? Math.atan2(primary.textDir.y, primary.textDir.x) : primary.textRotation;
  const entityTextHeight = primary.textHeight && primary.textHeight > 0 ? primary.textHeight : ds.textHeight;
  // P18: MTEXT-content multileaders are modeled natively. Block content
  // (context 296 = 1, or trailing content type 1) is modeled in slice 2 ONLY
  // when it resolves whole: the block record handle names a block, that block
  // has a definition in this file, every attribute index resolves to a
  // definition tag, and no MTEXT content rides along (hybrid). Anything else
  // — unresolvable reference, absent definition, dangling attribute, hybrid —
  // gets NO native data: the caller reports the simplification and the entity
  // keeps the legacy path, retained and reported, never silently flattened.
  // The trigger decision comes from the SAME predicate the caller reports
  // by (mleaderBlockContentSignalled) — one implementation, no drift (F-1).
  const isBlockContent = mleaderBlockContentSignalled(o);
  const textStyleName = primary.textStyleHandle ? ctx.textStyleHandles?.get(primary.textStyleHandle) : undefined;
  // V-1 (AMENDMENT-P18-S2-A): the source style's retained values for the groups no
  // entity field supplies, keyed by the same style handle the name came from; an
  // absent map (read paths that build their own context) keeps the slice-1 fallback.
  const styleRetained = styleHandle ? ctx.mleaderStyleValues?.get(styleHandle) : undefined;
  let block: MLeaderBlockContent | undefined;
  if (isBlockContent && !plain) {
    const handle = primary.blockHandleCtx ?? blockHandleTrail;
    const name = handle ? ctx.blockRecordNames?.get(handle) : undefined;
    const def = name !== undefined ? ctx.blocks?.[name] : undefined;
    if (name !== undefined && def) {
      let ok = true;
      const attributes: MLeaderBlockAttribute[] = [];
      for (const pa of pendingAttrs) {
        // S3-D (exposed by the lead's Fixture F): resolve the entry by its
        // ATTDEF HANDLE — the entry's own 330 names the definition attribute
        // outright, and a definition attribute's cadIdentity IS that handle —
        // validated against the entry's 177 index under EITHER numbering:
        // AutoCAD writes the 1-based ordinal (F: 1 and 2 for PART/REV), the
        // slice-2 specimens the 0-based position. An index consistent with
        // neither leaves the entry dangling (the slice-2 resolves-whole
        // posture, unchanged); with no resolvable handle the index alone is
        // the key, as before. The stored model index is the definition
        // position either way. A group-44 width of 0 is AutoCAD's "no width"
        // (the model admits only positive widths), not a zero width.
        const byHandle = pa.handle ? def.attributes.find((a) => (a as { cadIdentity?: string }).cadIdentity?.toUpperCase() === pa.handle) : undefined;
        let defAttr: AttributeDef | undefined;
        let index: number | undefined;
        if (byHandle) {
          // The handle is authoritative; the index must corroborate it under
          // one of the two numberings, or the entry contradicts itself and
          // dangles — it never silently lands on the index's other attribute.
          const p = def.attributes.indexOf(byHandle);
          if (pa.index === undefined || pa.index === p || pa.index === p + 1) {
            defAttr = byHandle;
            index = p;
          }
        } else {
          defAttr = pa.index !== undefined && pa.index >= 0 ? def.attributes[pa.index] : undefined;
          index = pa.index;
        }
        if (!defAttr || index === undefined) {
          ok = false;
          break;
        }
        attributes.push({ index, tag: defAttr.tag, value: pa.text ?? '', ...(pa.width !== undefined && pa.width > 0 ? { width: pa.width } : {}) });
      }
      if (ok) {
        block = {
          name,
          position: primary.blockPos ?? primary.ctxBasePos ?? main[main.length - 1]!,
          scale: primary.blockScaleCtx ?? blockScaleTrail ?? { x: 1, y: 1 },
          rotation: primary.blockRotationCtx ?? blockRotationTrail ?? 0,
          attributes,
        };
      }
    }
  }
  // For block content, the style's block scale/rotation groups (47/49/140/141)
  // are LIVE style data that mleaderStyleData also derives from the instance
  // payload: when the retained style values equal the instance's own, the
  // derived path reproduces them exactly and retention would only duplicate
  // them onto the entity (breaking the authored fixed point). They are kept
  // only when they diverge from the instance — the case where dropping them
  // would lose the style object's own values.
  let effectiveRetained = styleRetained;
  if (block && effectiveRetained) {
    const r: { -readonly [K in keyof MLeaderStyleRetained]: MLeaderStyleRetained[K] } = { ...effectiveRetained };
    if (r.blockScale && r.blockScale.x === block.scale.x && r.blockScale.y === block.scale.y && r.blockScale.z === 1) delete r.blockScale;
    if (r.blockRotation !== undefined && r.blockRotation === block.rotation) delete r.blockRotation;
    effectiveRetained = Object.keys(r).length ? r : undefined;
  }
  const nativeCommon = {
    styleName: (styleHandle ? ctx.mleaderStyles?.get(styleHandle) : undefined) ?? 'Standard',
    scaleFactor: primary.scaleFactor && primary.scaleFactor > 0 ? primary.scaleFactor : STANDARD_MLEADER_STYLE.scaleFactor,
    landingGap: primary.landingGap && primary.landingGap >= 0 ? primary.landingGap : STANDARD_MLEADER_STYLE.landingGap,
    leaderLineType: (lineType === 0 || lineType === 2 ? lineType : 1) as 0 | 1 | 2,
    ...(textStyleName ? { textStyleName } : {}),
    ...(effectiveRetained ? { styleRetained: effectiveRetained } : {}),
  };
  // Slice 3: additional contexts finalize (PROPOSAL-P18-S3 reader rules).
  // Modelling is whole-entity or not at all — the slice-2 resolves-whole
  // discipline: an additional context with no usable group 40 (its scale is
  // its identity; the primary's fallback chain does not apply), a non-finite
  // leader point, an additional section left UNTERMINATED (AMENDMENT-P18-S3-B:
  // its 301 close never arrives before the record ends, so the fragment would
  // otherwise be completed by the fallbacks below and re-emitted as fact —
  // acceptance finding F-T), MTEXT text in any context of a block-signalled
  // record (hybrid), or a context block handle resolving to a different (or no)
  // block name than the primary's withholds native data entirely; the caller
  // reports the multi-context simplification. Fallbacks inside a context
  // mirror the primary's chains with the primary's RESOLVED values in place
  // of the style/standard step. The PRIMARY section's termination is not
  // judged here — its posture is the pre-existing slices-1/2 one.
  let contexts: MLeaderContext[] | undefined;
  let contextsWithheld = false;
  if (accs.length > 1) {
    const built: MLeaderContext[] = [];
    let ok = true;
    if (sectionTerminated.slice(1).some((t) => !t)) ok = false;
    for (const acc of accs.slice(1)) {
      const accPlain = acc.text ? mtextFromDxf(acc.text) : '';
      if (!(acc.scaleFactor !== undefined && Number.isFinite(acc.scaleFactor) && acc.scaleFactor > 0)) ok = false;
      if (acc.paths.some((path) => path.some((pt) => !Number.isFinite(pt.x) || !Number.isFinite(pt.y)))) ok = false;
      if (isBlockContent && accPlain) ok = false;
      if (isBlockContent && acc.blockHandleCtx) {
        const accName = ctx.blockRecordNames?.get(acc.blockHandleCtx);
        if (!block || accName !== block.name) ok = false;
      }
      const accRot = acc.textDir && (acc.textDir.x !== 0 || acc.textDir.y !== 0) ? Math.atan2(acc.textDir.y, acc.textDir.x) : acc.textRotation;
      const accStyleName = acc.textStyleHandle ? ctx.textStyleHandles?.get(acc.textStyleHandle) : undefined;
      const lastPath = acc.paths[acc.paths.length - 1];
      const lastPt = lastPath ? lastPath[lastPath.length - 1] : undefined;
      built.push({
        scaleFactor: acc.scaleFactor ?? NaN,
        landingGap: acc.landingGap && acc.landingGap >= 0 ? acc.landingGap : nativeCommon.landingGap,
        textHeight: acc.textHeight && acc.textHeight > 0 ? acc.textHeight : entityTextHeight,
        arrowSize: acc.arrowSize ?? size,
        paths: acc.paths,
        ...(acc.firstDogleg && g.len(acc.firstDogleg) > 1e-12 ? { dogleg: acc.firstDogleg } : {}),
        ...(accPlain ? { text: accPlain, ...(hasFormatting(acc.text) ? { raw: acc.text } : {}) } : {}),
        ...(accStyleName ? { textStyleName: accStyleName } : {}),
        ...(accPlain && acc.textPos ? { textPosition: acc.textPos } : {}),
        ...(Math.abs(accRot) > 1e-12 ? { textRotation: accRot } : {}),
        ...(acc.textWidth && acc.textWidth > 0 ? { textWidth: acc.textWidth } : {}),
        ...(acc.attachment && acc.attachment >= 1 && acc.attachment <= 9 ? { textAttachment: acc.attachment } : {}),
        ...(block ? {
          block: {
            position: acc.blockPos ?? acc.ctxBasePos ?? lastPt ?? block.position,
            scale: acc.blockScaleCtx ?? block.scale,
            rotation: acc.blockRotationCtx ?? block.rotation,
          },
        } : {}),
      });
    }
    if (ok) contexts = built;
    else contextsWithheld = true;
  }
  // S3-D: the object path's own legs withhold whole-entity even when the
  // inline capture is clean — a dangling join, an unparseable referenced
  // object, or the both-dialects conflict (RULING-P18-S3-D (1)(v) + (3)(iii)).
  // The result is the same withheld shape as every other leg: no native data,
  // the primary-only legacy entity, the caller reporting note + `simplified`.
  if (chain.dangling || chain.unparseable || chain.conflict) contextsWithheld = true;
  const mleader: MLeaderNative | undefined = contextsWithheld
    ? undefined
    : block
      ? { contentType: 'block', ...nativeCommon, block, ...(contexts ? { contexts } : {}) }
      : isBlockContent
        ? undefined
        : { contentType: plain || contentTypeRaw === 2 ? 'mtext' : 'none', ...nativeCommon, ...(contexts ? { contexts } : {}) };
  return {
    ...base,
    type: 'leader',
    vertices: main,
    arrow: lineType !== 0,
    arrowSize: size,
    ...(dogleg && g.len(dogleg) > 1e-12 ? { dogleg } : {}),
    ...(lineType === 2 ? { spline: true } : {}),
    ...(paths.length ? { extraPaths: paths } : {}),
    ...(plain ? { text: plain, ...(hasFormatting(primary.text) ? { raw: primary.text } : {}) } : {}),
    ...(primary.textPos && plain ? { textPosition: primary.textPos } : {}),
    textHeight: entityTextHeight,
    ...(primary.attachment && primary.attachment >= 1 && primary.attachment <= 9 ? { textAttachment: primary.attachment as MTextAttachment } : {}),
    ...(primary.textWidth && primary.textWidth > 0 ? { textWidth: primary.textWidth } : {}),
    ...(Math.abs(rot) > 1e-12 ? { textRotation: rot } : {}),
    kind: 'mleader',
    ...(mleader ? { mleader } : {}),
  };
}

export function readImage(o: Obj, base: ReturnType<typeof commonProps>): ImageEntity {
  const gs = afterSubclass(o, 'AcDbRasterImage');
  const find = (code: number) => gs.find((x) => x.code === code)?.value;
  const clipType = int(find(71), 1);
  const clip = pointList(gs, 14);
  return {
    ...base,
    type: 'image',
    path: '',
    position: pt(o, 10),
    u: pt(o, 11, { x: 1, y: 0 }),
    v: pt(o, 12, { x: 0, y: 1 }),
    size: { x: flt(find(13), 1), y: flt(find(23), 1) },
    ...(clip.length >= 2 ? { clip: clipType === 1 ? clip.slice(0, 2) : clip } : {}),
    ...(int(find(280)) === 1 ? { clipOn: true } : {}),
    flags: int(find(70), 7),
    brightness: int(find(281), 50),
    contrast: int(find(282), 50),
    fade: int(find(283), 0),
  };
}

/**
 * MTEXT columns: JCad's own JCAD_MTEXT_COLUMNS XDATA, else AutoCAD's (the R2018 "Embedded
 * Object" groups 71-74 / 44-46, or the native groups 75-79 / 48-50). Ported from PR #2
 * (codex/electrical-review-fixes 2f89b0e).
 */
export function readMTextColumns(o: Obj): MTextColumns | undefined {
  const own = xdata(o, MTEXT_COLUMNS_APP);
  if (own) {
    try {
      const c = JSON.parse(own.filter((p) => p.code === 1000).map((p) => p.value).join('')) as MTextColumns;
      if ((c.type === 1 || c.type === 2) && Number.isInteger(c.count) && c.count > 0 && c.count <= 256 && Number.isFinite(c.width) && c.width > 0 && Number.isFinite(c.gutter) && c.gutter >= 0 && Array.isArray(c.heights) && c.heights.length <= 256 && c.heights.every((h) => Number.isFinite(h) && h >= 0)) return c;
    } catch {
      /* the native groups below */
    }
  }
  const embedded = o.groups.findIndex((p) => p.code === 101 && p.value === 'Embedded Object');
  const nativeStart = o.groups.findIndex((p) => p.code === 75);
  const groups = embedded < 0 ? o.groups.slice(Math.max(0, nativeStart)) : o.groups.slice(embedded + 1);
  const code = (native: number, modern: number) => groups.find((p) => p.code === (embedded < 0 ? native : modern))?.value;
  // Embedded object (R2018): 71 type, 72 count, 44 width, 45 gutter, 73 auto height, 74 reversed
  // flow, 46 heights; the native groups: 75 type, 76 count, 48 / 49, 79 auto height, 78 reversed.
  const type = int(code(75, 71));
  let count = int(code(76, 72));
  const width = flt(code(48, 44));
  const gutter = Math.max(0, flt(code(49, 45)));
  const heights = embedded >= 0 ? groups.filter((p) => p.code === 46).map((p) => flt(p.value)) : groups.filter((p) => p.code === 50).slice(1).map((p) => flt(p.value));
  // Dynamic columns with auto height (AutoCAD's default for new columns) are saved with a count of
  // 0: the number follows from the total width (42) the columns and gutters take.
  if (count === 0 && embedded >= 0 && width > 0) {
    const total = flt(code(42, 42));
    count = heights.length > 0 ? heights.length : total > 0 ? Math.round((total + gutter) / (width + gutter)) : 0;
  }
  if ((type !== 1 && type !== 2) || count < 1 || count > 256 || !(width > 0)) return undefined;
  return { type, count, width, gutter, autoHeight: int(code(79, 73)) !== 0, reversed: int(code(78, 74)) !== 0, heights: heights.slice(0, count) };
}

export interface TableStyleData {
  marginX: number;
  marginY: number;
  titleSuppressed: boolean;
  headerSuppressed: boolean;
  rows: Array<{ height: number; attachment: number }>;
}

export function readTableStyle(o: Obj): TableStyleData {
  const groups = afterSubclass(o, 'AcDbTableStyle');
  const rows: TableStyleData['rows'] = [];
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i]!.code !== 7) continue;
    let end = i + 1;
    while (end < groups.length && groups[end]!.code !== 7) end += 1;
    const cell = groups.slice(i, end);
    rows.push({ height: flt(cell.find((p) => p.code === 140)?.value, 0.18), attachment: int(cell.find((p) => p.code === 170)?.value, 5) });
  }
  // The flags before the first cell style: newer files start the subclass with a version 280
  // ahead of the description, AutoCAD 2000 files do not, so the title flag is the last 280 there.
  const firstStyle = groups.findIndex((p) => p.code === 7);
  const head = firstStyle < 0 ? groups : groups.slice(0, firstStyle);
  return {
    marginX: flt(head.find((p) => p.code === 40)?.value, 0.06),
    marginY: flt(head.find((p) => p.code === 41)?.value, 0.06),
    titleSuppressed: int(head.filter((p) => p.code === 280).at(-1)?.value) !== 0,
    headerSuppressed: int(head.find((p) => p.code === 281)?.value) !== 0,
    rows,
  };
}

/** ACAD_TABLE with legacy cell data (91/92 size, 141/142 sizes, 171.. per cell) -> native table. */
export function readTable(o: Obj, base: ReturnType<typeof commonProps>, style?: TableStyleData, notes?: string[]): TableEntity | null {
  const gs = afterSubclass(o, 'AcDbTable');
  const firstCell = gs.findIndex((x) => x.code === 171);
  const head = firstCell >= 0 ? gs.slice(0, firstCell) : gs;
  const rows = int(head.find((x) => x.code === 91)?.value);
  const cols = int(head.find((x) => x.code === 92)?.value);
  const rowHeights = head.filter((x) => x.code === 141).map((x) => flt(x.value));
  const columnWidths = head.filter((x) => x.code === 142).map((x) => flt(x.value));
  if (rows < 1 || cols < 1 || rowHeights.length !== rows || columnWidths.length !== cols || firstCell < 0) return null;
  const chunks: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (let k = firstCell; k < gs.length; k += 1) {
    const p = gs[k]!;
    if (p.code === 171) {
      cur = [];
      chunks.push(cur);
    }
    // Table-wide overrides follow the cell list.
    if (p.code === 280 || p.code === 281) cur = null;
    cur?.push(p);
  }
  if (chunks.length < rows * cols) return null;
  let anyText = false;
  const heights: number[] = [];
  const cells: TableCell[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: TableCell[] = [];
    for (let c = 0; c < cols; c += 1) {
      const cg = chunks[r * cols + c]!;
      let text = cg.filter((x) => x.code === 2 || x.code === 3).map((x) => x.value).join('') + (cg.find((x) => x.code === 1)?.value ?? '');
      if (!text) text = cg.find((x) => x.code === 302 && x.value)?.value ?? '';
      // The style's cell styles (file order data, title, header): title for row 0 unless
      // suppressed, header for the next row unless suppressed, data for the others.
      const headerRow = style?.titleSuppressed ? 0 : 1;
      const rowStyle = style?.rows[r === 0 && !style.titleSuppressed ? 1 : r === headerRow && !style?.headerSuppressed ? 2 : 0];
      const h = flt(cg.find((x) => x.code === 140)?.value, rowStyle?.height ?? 0);
      const align = int(cg.find((x) => x.code === 170)?.value, rowStyle?.attachment ?? 0);
      const spanC = int(cg.find((x) => x.code === 175)?.value, 1);
      const spanR = int(cg.find((x) => x.code === 176)?.value, 1);
      // A span claim whose effective extent reaches outside the grid violates
      // the model's invariant (P22 fix F3): report it through the import
      // report and leave the cell unmerged, instead of modelling the claim
      // verbatim and re-emitting it in silence. Sub-1 group values are the
      // no-claim form (merge-covered cells carry 0/0) and clamp to 1 as before.
      const effSpan = { rows: Math.max(1, spanR), cols: Math.max(1, spanC) };
      const spanClaim = effSpan.rows > 1 || effSpan.cols > 1;
      const spanFits = r + effSpan.rows <= rows && c + effSpan.cols <= cols;
      if (spanClaim && !spanFits) notes?.push(`Table cell at row ${r + 1}, column ${c + 1} claims a span of ${effSpan.rows} rows x ${effSpan.cols} columns outside the ${rows} x ${cols} table; the claim was ignored and the cell left unmerged.`);
      const plain = text ? mtextFromDxf(text) : '';
      if (plain) anyText = true;
      if (h > 0) heights.push(h);
      row.push({
        text: plain,
        // Content that is exactly the plain-text encoding of its decoded text
        // (P22 fix F1) is plain text, not formatting: no raw is kept for it, so
        // an escape-encoded cell re-exports through the plain path unchanged.
        ...(plain && hasFormatting(text) && !isEscapedPlainContent(text) ? { raw: text } : {}),
        ...(h > 0 ? { height: h } : {}),
        ...(align >= 1 && align <= 9 ? { attachment: align as MTextAttachment } : {}),
        ...(spanClaim && spanFits ? { span: effSpan } : {}),
      });
    }
    cells.push(row);
  }
  if (!anyText) return null;
  const dir = pt(o, 11, { x: 1, y: 0 });
  heights.sort((a, b) => a - b);
  return {
    ...base,
    type: 'table',
    position: pt(o, 10),
    rotation: Math.atan2(dir.y, dir.x),
    rowHeights,
    columnWidths,
    cells,
    textHeight: style?.rows[0]?.height ?? heights[Math.floor(heights.length / 2)] ?? 0.18,
    ...(style ? { margin: Math.max(style.marginX, style.marginY) } : {}),
  };
}

/**
 * Restore merged-away cell contents from the JCAD_TABLE preservation carrier a native
 * ACAD_TABLE may carry (P22): the native record writes covered cells virtual and empty,
 * so any text/formatting the model holds for them rides in the xdata and is merged back
 * here. Native groups stay authoritative for every visible cell and all geometry.
 */
export function restoreCoveredCells(table: TableEntity, preserved: TableEntity): TableEntity {
  if (preserved.rowHeights.length !== table.rowHeights.length || preserved.columnWidths.length !== table.columnWidths.length) return table;
  const owners = cellOwners(table);
  let changed = false;
  const cells = table.cells.map((row, r) => row.map((cell, c) => {
    const covered = owners[r]?.[c]?.[0] !== r || owners[r]?.[c]?.[1] !== c;
    const kept = preserved.cells[r]?.[c];
    if (!covered || !kept || cell.text !== '' || (kept.text === '' && kept.raw === undefined)) return cell;
    changed = true;
    return { ...cell, text: kept.text, ...(kept.raw !== undefined ? { raw: kept.raw } : {}) };
  }));
  return changed ? { ...table, cells } : table;
}

/** A table JCad wrote as an INSERT of an anonymous block with its data in JCAD_TABLE xdata. */
export function readJcadTable(o: Obj, base: ReturnType<typeof commonProps>, notes?: string[]): TableEntity | null {
  const xd = xdata(o, TABLE_APP);
  if (!xd) return null;
  try {
    const meta = JSON.parse(xd.filter((x) => x.code === 1000).map((x) => x.value).join('')) as Partial<TableEntity>;
    if (!meta.position || !Array.isArray(meta.rowHeights) || !Array.isArray(meta.columnWidths) || !Array.isArray(meta.cells)) return null;
    // The same span discipline as the native reader (P22 fix F3): a carried
    // span claim reaching outside the grid is reported and dropped, never
    // modelled verbatim. The screen judges span claims on well-formed cells
    // only: a malformed row or cell (a non-array row, a null or non-object
    // cell) passes through untouched so format validation sees the payload
    // and reports it (P22 COMP-F1 — dereferencing cell.span here threw, the
    // catch returned null, and the INSERT fell through to the generic insert
    // path, silently bypassing table validation).
    const rows = meta.rowHeights.length;
    const cols = meta.columnWidths.length;
    let cells = meta.cells;
    const spanOutside = (cell: TableCell, r: number, c: number): boolean =>
      !!cell && typeof cell === 'object' && !!cell.span && (r + cell.span.rows > rows || c + cell.span.cols > cols);
    if (cells.some((row, r) => Array.isArray(row) && row.some((cell: TableCell, c: number) => spanOutside(cell, r, c)))) {
      cells = cells.map((row, r) => (Array.isArray(row)
        ? row.map((cell: TableCell, c: number) => {
          if (!spanOutside(cell, r, c)) return cell;
          const span = cell.span!;
          notes?.push(`Table cell at row ${r + 1}, column ${c + 1} claims a span of ${span.rows} rows x ${span.cols} columns outside the ${rows} x ${cols} table; the claim was ignored and the cell left unmerged.`);
          const { span: _dropped, ...rest } = cell;
          return rest;
        })
        : row));
    }
    return {
      ...base,
      type: 'table',
      position: meta.position,
      rotation: meta.rotation ?? 0,
      rowHeights: meta.rowHeights,
      columnWidths: meta.columnWidths,
      cells,
      textHeight: meta.textHeight ?? 0.18,
      ...(meta.margin !== undefined ? { margin: meta.margin } : {}),
    };
  } catch {
    return null;
  }
}
