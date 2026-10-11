/**
 * Entity codecs, reader side, for annotation and reference objects: DIMENSION (with its style),
 * LEADER (with DSTYLE overrides), MULTILEADER (CONTEXT_DATA), IMAGE, ACAD_TABLE cell data and the
 * tables JCad writes (an INSERT with the cell data as JCAD_TABLE XDATA).
 */
import type { Entity, DimStyle, LeaderEntity, ImageEntity, TableEntity, TableCell } from '../../core/entities';
import { mtextFromDxf, hasFormatting, type MTextAttachment } from '../../core/mtext';
import { dimStyleFromRecordPairs } from '../../core/dimension';
import * as g from '../../core/geometry';
import { DIMSTYLE_APP, TABLE_APP } from './codes';
import { applyDimStyleXdata } from './dimstyles';
import { num, has, str, pt, int, flt, afterSubclass, pointList, xdata, type Pair, type Obj } from './groups';
import type { commonProps, ReadContext } from './read-core';

/**
 * A DIMENSION's style: its named style (group 3) with the dimension's own overrides applied -
 * ACAD XDATA "DSTYLE" { 1070 code, value ... } as AutoCAD writes them (340 DIMTXSTY names a STYLE
 * by handle) and JCAD_DIMSTYLE XDATA for arrowheads. Ported from PR #2
 * (codex/electrical-review-fixes 2f89b0e).
 */
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

/** The [code, value] pairs of ACAD XDATA "DSTYLE" { 1070 code, 1000 / 1005 / 1040 / 1070 / 1071 value ... }. */
export function dstylePairs(o: Obj): Array<readonly [number, string]> {
  const xd = xdata(o, 'ACAD');
  if (!xd) return [];
  const start = xd.findIndex((p) => p.code === 1000 && p.value === 'DSTYLE');
  if (start < 0 || xd[start + 1]?.code !== 1002 || xd[start + 1]?.value !== '{') return [];
  const out: Array<readonly [number, string]> = [];
  for (let k = start + 2; k + 1 < xd.length && xd[k]!.code !== 1002; k += 2) {
    const key = xd[k]!;
    const value = xd[k + 1]!;
    if (key.code === 1070 && [1000, 1005, 1040, 1070, 1071].includes(value.code)) out.push([int(key.value), value.value]);
  }
  return out;
}

export function readDimension(o: Obj, base: ReturnType<typeof commonProps>, style: DimStyle): Entity | null {
  const flags = Math.trunc(num(o, 70));
  const type = flags & 15;
  const userText = flags & 128 ? pt(o, 11) : undefined;
  const textRaw = str(o, 1);
  const text = textRaw && textRaw !== '<>' ? textRaw : undefined;
  // Groups 53 (text rotation) and 52 (oblique), degrees; 0 means "not set".
  const rot = num(o, 53);
  const obl = num(o, 52);
  const angles = { ...(Math.abs(rot) > 1e-9 ? { textRotation: g.rad(rot) } : {}), ...(Math.abs(obl) > 1e-9 && (type === 0 || type === 1) ? { oblique: g.rad(obl) } : {}) };
  const common = { ...base, type: 'dimension' as const, text, textPosition: userText, ...angles, style };
  const subclasses = o.groups.filter((x) => x.code === 100).map((x) => x.value);
  switch (type) {
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
  const pair = dstylePairs(o).find(([code]) => code === dimvarCode);
  if (pair) return flt(pair[1]);
  // Files that leave out the DSTYLE { } framing: any 1070 code followed by its value.
  const xd = xdata(o, 'ACAD');
  if (!xd) return undefined;
  for (let k = 0; k + 1 < xd.length; k += 1) if (xd[k]!.code === 1070 && int(xd[k]!.value) === dimvarCode) return flt(xd[k + 1]!.value);
  return undefined;
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
        case 41:
          textHeight = flt(p.value);
          break;
        case 140:
          arrowSize = flt(p.value);
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
  }
  void hasBlock;
  const main = paths.shift();
  if (!main || main.length < 2) return null;
  const ds = ctx.dimStyle;
  const size = arrowSize ?? commonArrow ?? ds.arrowSize * (ds.scale || 1);
  const dogleg = firstDogleg ?? undefined;
  void commonDogleg;
  const plain = text ? mtextFromDxf(text) : '';
  const rot = textDir && (textDir.x !== 0 || textDir.y !== 0) ? Math.atan2(textDir.y, textDir.x) : textRotation;
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

/** ACAD_TABLE with legacy cell data (91/92 size, 141/142 sizes, 171.. per cell) -> native table. */
/**
 * What JCad takes from a TABLESTYLE object: the cell margins, whether the title and header rows
 * are suppressed, and per cell style (data, header, title, in file order) the text height and
 * alignment. Ported from PR #2 (codex/electrical-review-fixes 2f89b0e).
 */
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
  return {
    marginX: flt(groups.find((p) => p.code === 40)?.value, 0.06),
    marginY: flt(groups.find((p) => p.code === 41)?.value, 0.06),
    titleSuppressed: int(groups.filter((p) => p.code === 280)[1]?.value) !== 0,
    headerSuppressed: int(groups.find((p) => p.code === 281)?.value) !== 0,
    rows,
  };
}

/**
 * ACAD_TABLE with legacy cell data (91/92 size, 141/142 sizes, 171.. per cell) -> native table.
 * Cells without their own text height / alignment take the table style's (`style`, the
 * TABLESTYLE group 342 names): the title row, the header row and the data rows each their own.
 */
export function readTable(o: Obj, base: ReturnType<typeof commonProps>, style?: TableStyleData): TableEntity | null {
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
      // The style's cell styles: title (row 0 unless suppressed), header (the next row unless suppressed), data.
      const headerRow = style?.titleSuppressed ? 0 : 1;
      const rowStyle = style?.rows[r === 0 && !style.titleSuppressed ? 2 : r === headerRow && !style?.headerSuppressed ? 1 : 0];
      const h = flt(cg.find((x) => x.code === 140)?.value, rowStyle?.height ?? 0);
      const align = int(cg.find((x) => x.code === 170)?.value, rowStyle?.attachment ?? 0);
      const spanC = int(cg.find((x) => x.code === 175)?.value, 1);
      const spanR = int(cg.find((x) => x.code === 176)?.value, 1);
      const plain = text ? mtextFromDxf(text) : '';
      if (plain) anyText = true;
      if (h > 0) heights.push(h);
      row.push({
        text: plain,
        ...(plain && hasFormatting(text) ? { raw: text } : {}),
        ...(h > 0 ? { height: h } : {}),
        ...(align >= 1 && align <= 9 ? { attachment: align as MTextAttachment } : {}),
        ...(spanC > 1 || spanR > 1 ? { span: { rows: Math.max(1, spanR), cols: Math.max(1, spanC) } } : {}),
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

/** A table JCad wrote as an INSERT of an anonymous block with its data in JCAD_TABLE xdata. */
export function readJcadTable(o: Obj, base: ReturnType<typeof commonProps>): TableEntity | null {
  const xd = xdata(o, TABLE_APP);
  if (!xd) return null;
  try {
    const meta = JSON.parse(xd.filter((x) => x.code === 1000).map((x) => x.value).join('')) as Partial<TableEntity>;
    if (!meta.position || !Array.isArray(meta.rowHeights) || !Array.isArray(meta.columnWidths) || !Array.isArray(meta.cells)) return null;
    return {
      ...base,
      type: 'table',
      position: meta.position,
      rotation: meta.rotation ?? 0,
      rowHeights: meta.rowHeights,
      columnWidths: meta.columnWidths,
      cells: meta.cells,
      textHeight: meta.textHeight ?? 0.18,
      ...(meta.margin !== undefined ? { margin: meta.margin } : {}),
    };
  } catch {
    return null;
  }
}
