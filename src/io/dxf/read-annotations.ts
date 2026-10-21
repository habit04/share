/**
 * Entity codecs, reader side, for annotation and reference objects: DIMENSION (with its style),
 * LEADER (with DSTYLE overrides), MULTILEADER (CONTEXT_DATA), IMAGE, ACAD_TABLE cell data and the
 * tables JCad writes (an INSERT with the cell data as JCAD_TABLE XDATA).
 */
import type { Obj, Pair } from './groups';
import type { DimStyle, Entity, LeaderEntity, ImageEntity, TableEntity, TableCell } from '../../core/entities';
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
import { STANDARD_MLEADER_STYLE, type MLeaderBlockAttribute, type MLeaderBlockContent, type MLeaderNative, type MLeaderStyleRetained } from '../../core/multileader';

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
 * MULTILEADER: leader lines, landing and MTEXT content from the CONTEXT_DATA section.
 * Block content is not drawn (noted by the caller); missing parts degrade to what is present.
 */
export function readMLeader(o: Obj, base: ReturnType<typeof commonProps>, ctx: ReadContext): LeaderEntity | null {
  const gs = o.groups;
  const paths: g.Point[][] = [];
  let text = '';
  let textPos: g.Point | undefined;
  let textHeight: number | undefined;
  let textWidth: number | undefined;
  let textRotation = 0;
  let textDir: g.Point | undefined;
  let attachment: number | undefined;
  let arrowSize: number | undefined;
  let hasBlock = false;
  let depth: string[] = [];
  let lastLeaderPoint: g.Point | undefined;
  let doglegVec: g.Point | undefined;
  let doglegLen: number | undefined;
  let line: g.Point[] | null = null;
  const sectionLines: g.Point[][] = [];
  let firstDogleg: g.Point | undefined;
  let commonArrow: number | undefined;
  let commonDogleg: number | undefined;
  let lineType = 1;
  // P18 native capture: context scale / landing gap / text style, trailing style + content type.
  let scaleFactor: number | undefined;
  let landingGap: number | undefined;
  let textStyleHandle: string | undefined;
  let styleHandle: string | undefined;
  let contentTypeRaw: number | undefined;
  // P18 slice 2 block-content capture (PROPOSAL-P18-S2): context 341/15/16/46 with
  // fallbacks (context 10 base point; trailing 344/10/43), and the trailing
  // attribute entries (330 ATTDEF handle / 177 definition index / 44 width /
  // 302 text). Trailing groups are only collected after CONTEXT_DATA closes —
  // before it, a 330 is the entity's owner, not an attribute.
  let blockHandleCtx: string | undefined;
  let blockPos: g.Point | undefined;
  let ctxBasePos: g.Point | undefined;
  let blockScaleCtx: g.Point | undefined;
  let blockRotationCtx: number | undefined;
  let contextClosed = false;
  let blockHandleTrail: string | undefined;
  let blockScaleTrail: g.Point | undefined;
  let blockRotationTrail: number | undefined;
  const pendingAttrs: Array<{ index?: number; width?: number; text?: string }> = [];
  const endSection = () => {
    // A LEADER{} section: each of its lines runs arrow -> ... -> last leader point, then the landing.
    for (const l of sectionLines) paths.push(lastLeaderPoint ? [...l, lastLeaderPoint] : l);
    if (!firstDogleg && lastLeaderPoint && doglegVec && doglegLen) firstDogleg = g.scale(g.normalize(doglegVec), doglegLen);
    sectionLines.length = 0;
    lastLeaderPoint = undefined;
    doglegVec = undefined;
    doglegLen = undefined;
  };
  for (let k = 0; k < gs.length; k += 1) {
    const p = gs[k]!;
    const top = depth[depth.length - 1];
    if (p.code === 300 && p.value.startsWith('CONTEXT_DATA')) {
      depth.push('CONTEXT');
      continue;
    }
    if (p.code === 301) {
      depth = depth.filter((d) => d !== 'CONTEXT');
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
    const nextY = () => flt(gs[k + 1]?.code === p.code + 10 ? gs[k + 1]!.value : undefined);
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
          scaleFactor = flt(p.value);
          break;
        case 41:
          textHeight = flt(p.value);
          break;
        case 140:
          arrowSize = flt(p.value);
          break;
        case 145:
          landingGap = flt(p.value);
          break;
        case 340:
          textStyleHandle = p.value.trim().toUpperCase();
          break;
        case 341:
          blockHandleCtx = p.value.trim().toUpperCase();
          break;
        case 15:
          blockPos = { x: flt(p.value), y: nextY() };
          break;
        case 16:
          blockScaleCtx = { x: flt(p.value), y: nextY() };
          break;
        case 46:
          blockRotationCtx = flt(p.value);
          break;
        case 10:
          ctxBasePos = { x: flt(p.value), y: nextY() };
          break;
        case 304:
          text += p.value;
          break;
        case 12:
          textPos = { x: flt(p.value), y: nextY() };
          break;
        case 13:
          textDir = { x: flt(p.value), y: nextY() };
          break;
        case 42:
          textRotation = flt(p.value);
          break;
        case 43:
          textWidth = flt(p.value);
          break;
        case 171:
          attachment = int(p.value);
          break;
        case 296:
          hasBlock = int(p.value) !== 0;
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
      else if (p.code === 330) pendingAttrs.push({});
      else if (p.code === 177 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.index = int(p.value);
      else if (p.code === 44 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.width = flt(p.value);
      else if (p.code === 302 && pendingAttrs.length) pendingAttrs[pendingAttrs.length - 1]!.text = p.value;
    }
  }
  const main = paths.shift();
  if (!main || main.length < 2) return null;
  const ds = ctx.dimStyle;
  const size = arrowSize ?? commonArrow ?? ds.arrowSize * (ds.scale || 1);
  const dogleg = firstDogleg ?? undefined;
  void commonDogleg;
  const plain = text ? mtextFromDxf(text) : '';
  const rot = textDir && (textDir.x !== 0 || textDir.y !== 0) ? Math.atan2(textDir.y, textDir.x) : textRotation;
  // P18: MTEXT-content multileaders are modeled natively. Block content
  // (context 296 = 1, or trailing content type 1) is modeled in slice 2 ONLY
  // when it resolves whole: the block record handle names a block, that block
  // has a definition in this file, every attribute index resolves to a
  // definition tag, and no MTEXT content rides along (hybrid). Anything else
  // — unresolvable reference, absent definition, dangling attribute, hybrid —
  // gets NO native data: the caller reports the simplification and the entity
  // keeps the legacy path, retained and reported, never silently flattened.
  const isBlockContent = hasBlock || contentTypeRaw === 1;
  const textStyleName = textStyleHandle ? ctx.textStyleHandles?.get(textStyleHandle) : undefined;
  // V-1 (AMENDMENT-P18-S2-A): the source style's retained values for the groups no
  // entity field supplies, keyed by the same style handle the name came from; an
  // absent map (read paths that build their own context) keeps the slice-1 fallback.
  const styleRetained = styleHandle ? ctx.mleaderStyleValues?.get(styleHandle) : undefined;
  let block: MLeaderBlockContent | undefined;
  if (isBlockContent && !plain) {
    const handle = blockHandleCtx ?? blockHandleTrail;
    const name = handle ? ctx.blockRecordNames?.get(handle) : undefined;
    const def = name !== undefined ? ctx.blocks?.[name] : undefined;
    if (name !== undefined && def) {
      let ok = true;
      const attributes: MLeaderBlockAttribute[] = [];
      for (const pa of pendingAttrs) {
        const defAttr = pa.index !== undefined && pa.index >= 0 ? def.attributes[pa.index] : undefined;
        if (!defAttr) {
          ok = false;
          break;
        }
        attributes.push({ index: pa.index!, tag: defAttr.tag, value: pa.text ?? '', ...(pa.width !== undefined ? { width: pa.width } : {}) });
      }
      if (ok) {
        block = {
          name,
          position: blockPos ?? ctxBasePos ?? main[main.length - 1]!,
          scale: blockScaleCtx ?? blockScaleTrail ?? { x: 1, y: 1 },
          rotation: blockRotationCtx ?? blockRotationTrail ?? 0,
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
    scaleFactor: scaleFactor && scaleFactor > 0 ? scaleFactor : STANDARD_MLEADER_STYLE.scaleFactor,
    landingGap: landingGap && landingGap >= 0 ? landingGap : STANDARD_MLEADER_STYLE.landingGap,
    leaderLineType: (lineType === 0 || lineType === 2 ? lineType : 1) as 0 | 1 | 2,
    ...(textStyleName ? { textStyleName } : {}),
    ...(effectiveRetained ? { styleRetained: effectiveRetained } : {}),
  };
  const mleader: MLeaderNative | undefined = block
    ? { contentType: 'block', ...nativeCommon, block }
    : isBlockContent
      ? undefined
      : { contentType: plain || contentTypeRaw === 2 ? 'mtext' : 'none', ...nativeCommon };
  return {
    ...base,
    type: 'leader',
    vertices: main,
    arrow: lineType !== 0,
    arrowSize: size,
    ...(dogleg && g.len(dogleg) > 1e-12 ? { dogleg } : {}),
    ...(lineType === 2 ? { spline: true } : {}),
    ...(paths.length ? { extraPaths: paths } : {}),
    ...(plain ? { text: plain, ...(hasFormatting(text) ? { raw: text } : {}) } : {}),
    ...(textPos && plain ? { textPosition: textPos } : {}),
    textHeight: textHeight && textHeight > 0 ? textHeight : ds.textHeight,
    ...(attachment && attachment >= 1 && attachment <= 9 ? { textAttachment: attachment as MTextAttachment } : {}),
    ...(textWidth && textWidth > 0 ? { textWidth } : {}),
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
