/**
 * Entity codecs, writer side, for annotation and reference objects: MTEXT, DIMENSION (with the
 * name of its *D picture block), LEADER (+ its MTEXT), IMAGE (+ its IMAGEDEF reactor) and JCad
 * tables (an INSERT of an anonymous block with the cell data as XDATA).
 */
import { Writer, writeEntityCommon } from './write-core';
import type { MTextEntity, DimensionEntity, LeaderEntity, ImageEntity, TableEntity } from '../../core/entities';
import { formattedSource, mtextToDxf } from '../../core/mtext';
import { textStyleOf } from '../encoding';
import { MTEXT_COLUMNS_APP, MTEXT_BACKGROUND_APP, DIM_TYPE, DIMSTYLE_APP, TABLE_APP } from './codes';
import { backgroundMetadataChunks } from './mtext-background-data';
import * as g from '../../core/geometry';
import { dimensionTextPoint, dimensionMeasurement, dimensionStyleOverrides, dimStyleOverrideCode, DIM_VARIABLES, ordinateDimensionProblem } from '../../core/dimension';
import { textWidth, leaderParts, leaderPath } from '../../core/entities';
import type { WriteExtras } from './write-core';

export function writeMText(w: Writer, e: MTextEntity, owner: string): void {
  writeEntityCommon(w, e, owner, 'MTEXT', 'AcDbMText');
  w.pair(10, e.position.x);
  w.pair(20, e.position.y);
  w.pair(30, 0);
  w.pair(40, e.height);
  w.pair(41, e.width);
  w.pair(71, e.attachment);
  w.pair(72, 1);
  // A live field writes its expression; otherwise the formatted source while it still matches the text.
  const text = e.field && e.field.value === e.text ? e.field.native ? mtextToDxf(e.text) : e.field.code : formattedSource(e) ?? mtextToDxf(e.text);
  // Long strings go in 250-char chunks of code 3 followed by a final code 1.
  let rest = text;
  while (rest.length > 250) {
    // A promoted UTF-8 DXF must not separate the halves of a supplementary character.
    const end = /[\uD800-\uDBFF]/.test(rest[249]!) && /[\uDC00-\uDFFF]/.test(rest[250]!) ? 249 : 250;
    w.pair(3, rest.slice(0, end));
    rest = rest.slice(end);
  }
  w.pair(1, rest);
  w.pair(7, textStyleOf(e) ?? 'Standard');
  w.pair(11, Math.cos(e.rotation));
  w.pair(21, Math.sin(e.rotation));
  w.pair(31, 0);
  w.pair(73, 1);
  w.pair(44, e.lineSpacing || 1);
  if (e.background) {
    const bg = e.background;
    w.pair(90, bg.flags);
    // AutoCAD accepts inert fill parameters for frame16, but rejects them when fill flags are0.
    if (bg.flags !== 0) {
      w.pair(45, bg.scale);
      w.pair(63, bg.color === 'ByLayer' ? 256 : bg.color);
      if (bg.trueColor !== undefined) w.pair(421, bg.trueColor);
      if (bg.colorName !== undefined) w.pair(431, bg.colorName);
      if (bg.transparency !== undefined) w.pair(441, bg.transparency);
    }
  }
  if (e.background?.flags === 0) {
    w.pair(1001, MTEXT_BACKGROUND_APP);
    for (const chunk of backgroundMetadataChunks(e.background, e.height)) w.pair(1000, chunk);
  }
  // AC1015 has no MTEXT columns: JCad keeps the definition as XDATA (other programs show one column).
  if (e.columns) {
    w.pair(1001, MTEXT_COLUMNS_APP);
    const metadata = JSON.stringify(e.columns);
    for (let offset = 0; offset < metadata.length; offset += 250) w.pair(1000, metadata.slice(offset, offset + 250));
  }
}

function radialPoints(e: DimensionEntity): { q: g.Point; far: g.Point } {
  const r = g.dist(e.p1, e.p2);
  const toLoc = g.sub(e.linePoint, e.p1);
  const dir = g.len(toLoc) > 1e-9 ? g.normalize(toLoc) : g.normalize(g.sub(e.p2, e.p1));
  return { q: g.add(e.p1, g.scale(dir, r)), far: g.sub(e.p1, g.scale(dir, r)) };
}

export function writeDimension(w: Writer, e: DimensionEntity, owner: string, blockName: string): void {
  const problem = ordinateDimensionProblem(e);
  if (problem) throw new Error(problem);
  // (No group 280: it is not part of an AC1015 DIMENSION, and AutoCAD's AUDIT reports it.)
  writeEntityCommon(w, e, owner, 'DIMENSION', 'AcDbDimension');
  w.pair(2, blockName);
  let defpoint: g.Point;
  switch (e.kind) {
    case 'linear':
    case 'aligned': {
      const u = e.kind === 'linear' ? { x: Math.cos(e.rotation), y: Math.sin(e.rotation) } : g.len(g.sub(e.p2, e.p1)) > 1e-12 ? g.normalize(g.sub(e.p2, e.p1)) : { x: 1, y: 0 };
      defpoint = g.add(e.linePoint, g.scale(u, g.dot(g.sub(e.p2, e.linePoint), u)));
      break;
    }
    case 'radius':
    case 'ordinate':
      defpoint = e.p1;
      break;
    case 'diameter':
      defpoint = radialPoints(e).q;
      break;
    case 'angular':
      defpoint = e.linePoint;
      break;
  }
  w.pair(10, defpoint.x);
  w.pair(20, defpoint.y);
  w.pair(30, 0);
  const tp = e.textPosition ?? dimensionTextPoint(e, textWidth);
  w.pair(11, tp.x);
  w.pair(21, tp.y);
  w.pair(31, 0);
  w.pair(70, DIM_TYPE[e.kind] | 32 | (e.kind === 'ordinate' && e.ordinateAxis === 'x' ? 64 : 0) | (e.textPosition ? 128 : 0));
  w.pair(71, 5);
  w.pair(42, dimensionMeasurement(e));
  if (e.text !== undefined && e.text !== '') w.pair(1, e.text);
  // 52 is listed under AcDbAlignedDimension in the DXF reference, but files carry it with these groups.
  if (e.oblique !== undefined && (e.kind === 'linear' || e.kind === 'aligned')) w.pair(52, dimAngleDeg(e.oblique));
  if (e.textRotation !== undefined) w.pair(53, dimAngleDeg(e.textRotation - (e.kind === 'ordinate' ? e.ordinateRotation ?? 0 : 0)));
  if (e.kind === 'ordinate') w.pair(51, dimAngleDeg(-(e.ordinateRotation ?? 0)));
  w.pair(3, e.style.name);
  switch (e.kind) {
    case 'ordinate':
      w.pair(100, 'AcDbOrdinateDimension');
      w.pair(13, e.p2.x); w.pair(23, e.p2.y); w.pair(33, 0);
      w.pair(14, e.linePoint.x); w.pair(24, e.linePoint.y); w.pair(34, 0);
      break;
    case 'linear':
    case 'aligned':
      w.pair(100, 'AcDbAlignedDimension');
      w.pair(13, e.p1.x);
      w.pair(23, e.p1.y);
      w.pair(33, 0);
      w.pair(14, e.p2.x);
      w.pair(24, e.p2.y);
      w.pair(34, 0);
      if (e.kind === 'linear') {
        w.pair(50, g.deg(e.rotation));
        w.pair(100, 'AcDbRotatedDimension');
      }
      break;
    case 'radius':
    case 'diameter': {
      w.pair(100, e.kind === 'radius' ? 'AcDbRadialDimension' : 'AcDbDiametricDimension');
      const { q, far } = radialPoints(e);
      const p15 = e.kind === 'radius' ? q : far;
      w.pair(15, p15.x);
      w.pair(25, p15.y);
      w.pair(35, 0);
      w.pair(40, Math.max(0, g.dist(e.linePoint, q)));
      break;
    }
    case 'angular':
      w.pair(100, 'AcDb3PointAngularDimension');
      w.pair(13, e.p1.x);
      w.pair(23, e.p1.y);
      w.pair(33, 0);
      w.pair(14, e.p2.x);
      w.pair(24, e.p2.y);
      w.pair(34, 0);
      w.pair(15, e.center?.x ?? 0);
      w.pair(25, e.center?.y ?? 0);
      w.pair(35, 0);
      break;
  }
  writeDimStyleOverrides(w, e);
}

/**
 * Per-dimension overrides of its named style, as AutoCAD writes them: ACAD XDATA
 * "DSTYLE" { 1070 code, value ... } for the DIM* variables that differ from the DIMSTYLE record
 * (1040 reals, 1070 integers, 1000 strings; 340 DIMTXSTY as a 1005 handle), and JCAD_DIMSTYLE
 * XDATA for what DIMSTYLE records keep there (arrowheads, basic tolerance, alternate placement).
 * Ported from PR #2 (codex/electrical-review-fixes 2f89b0e).
 */
function writeDimStyleOverrides(w: Writer, e: DimensionEntity): void {
  const inherited = w.dimensionStyles.get(e.style.name.toUpperCase());
  if (!inherited) return;
  const overrides = dimensionStyleOverrides(e.style, inherited, e.styleOverrides);
  const native = Object.entries(overrides).filter(([name]) => dimStyleOverrideCode(name) !== undefined && name !== 'DIMTXSTY');
  const textStyle = String(overrides.DIMTXSTY ?? e.style.textStyle ?? 'Standard');
  const textStyleOverridden = overrides.DIMTXSTY !== undefined;
  if (native.length || textStyleOverridden) {
    w.pair(1001, 'ACAD');
    w.pair(1000, 'DSTYLE');
    w.pair(1002, '{');
    for (const [name, value] of native) {
      const def = DIM_VARIABLES.find((v) => v.name === name);
      w.pair(1070, dimStyleOverrideCode(name)!);
      w.pair(def?.kind === 'string' ? 1000 : def?.kind === 'number' && def.code !== 371 && def.code !== 372 ? 1040 : 1070, value);
    }
    if (textStyleOverridden) {
      w.pair(1070, 340);
      w.pair(1005, w.textStyleHandles.get(textStyle.toUpperCase()) ?? w.textStyleHandles.get('STANDARD') ?? '0');
    }
    w.pair(1002, '}');
  }
  const fields = Object.entries(overrides).filter(([name]) => ['DIMBLK1', 'DIMBLK2', 'TOLERANCE', 'ALTPLACEMENT'].includes(name));
  if (fields.length) {
    w.pair(1001, DIMSTYLE_APP);
    for (const [key, value] of fields) {
      w.pair(1000, key);
      w.pair(1000, value === '' && (key === 'DIMBLK1' || key === 'DIMBLK2') ? '.' : String(value));
    }
  }
}

/**
 * DIMENSION groups 53 (text rotation) and 52 (oblique angle) in degrees. Both are absolute
 * angles, but readers take 0 to mean "not set" (default text orientation / perpendicular
 * extension lines), so an explicit 0 is written as 360, which draws the same.
 */
function dimAngleDeg(rad: number): number {
  const d = ((g.deg(rad) % 360) + 360) % 360;
  return Math.abs(d) < 1e-9 || Math.abs(d - 360) < 1e-9 ? 360 : d;
}

export function writeLeader(w: Writer, e: LeaderEntity, owner: string, extras: WriteExtras): void {
  // The annotation first, so the LEADER can point at its handle (340).
  let textHandle: string | null = null;
  if (e.text && e.textPosition) {
    const m = leaderParts(e).find((p): p is MTextEntity => p.type === 'mtext');
    if (m) {
      writeMText(w, { ...m, id: e.id }, owner);
      textHandle = w.lastHandle().toString(16).toUpperCase();
      w.anchor(textHandle, { kind: 'entity', id: e.id, part: 'annotation' });
    }
  }
  const paths: g.Point[][] = [leaderPath(e), ...(e.extraPaths ?? []).map((p) => [...p])];
  paths.forEach((path, i) => {
    if (path.length < 2) return;
    writeEntityCommon(w, e, owner, 'LEADER', 'AcDbLeader');
    if (i) w.anchor(w.lastHandle().toString(16).toUpperCase(), { kind: 'entity', id: e.id, part: `leader-path:${i}` });
    w.pair(3, 'Standard');
    w.pair(71, e.arrow ? 1 : 0);
    w.pair(72, e.spline ? 1 : 0);
    const withText = i === 0 && textHandle !== null;
    w.pair(73, withText ? 0 : 3);
    w.pair(74, 1);
    w.pair(75, i === 0 && e.dogleg ? 1 : 0);
    if (withText) {
      w.pair(40, e.textHeight);
      w.pair(41, e.textWidth ?? 0);
    }
    w.pair(76, path.length);
    for (const p of path) {
      w.pair(10, p.x);
      w.pair(20, p.y);
      w.pair(30, 0);
    }
    if (withText) w.pair(340, textHandle!);
    w.pair(211, 1);
    w.pair(221, 0);
    w.pair(231, 0);
    if (Math.abs(e.arrowSize - extras.arrowSize) > 1e-9) {
      w.pair(1001, 'ACAD');
      w.pair(1000, 'DSTYLE');
      w.pair(1002, '{');
      w.pair(1070, 41);
      w.pair(1040, e.arrowSize);
      w.pair(1002, '}');
    }
  });
}

export function writeImage(w: Writer, e: ImageEntity, owner: string, extras: WriteExtras): void {
  writeEntityCommon(w, e, owner, 'IMAGE', 'AcDbRasterImage');
  const ref = extras.imageReactors.get(e);
  if (ref) ref.image = w.lastHandle().toString(16).toUpperCase();
  w.pair(90, 0);
  w.pair(10, e.position.x);
  w.pair(20, e.position.y);
  w.pair(30, 0);
  w.pair(11, e.u.x);
  w.pair(21, e.u.y);
  w.pair(31, 0);
  w.pair(12, e.v.x);
  w.pair(22, e.v.y);
  w.pair(32, 0);
  w.pair(13, e.size.x);
  w.pair(23, e.size.y);
  if (ref) w.pair(340, ref.def);
  w.pair(70, e.flags ?? 7);
  w.pair(280, e.clipOn ? 1 : 0);
  w.pair(281, e.brightness ?? 50);
  w.pair(282, e.contrast ?? 50);
  w.pair(283, e.fade ?? 0);
  if (ref) w.pair(360, ref.reactor);
  const clip = e.clip && e.clip.length >= 2 ? e.clip : [{ x: -0.5, y: -0.5 }, { x: e.size.x - 0.5, y: e.size.y - 0.5 }];
  w.pair(71, clip.length === 2 ? 1 : 2);
  w.pair(91, clip.length);
  for (const p of clip) {
    w.pair(14, p.x);
    w.pair(24, p.y);
  }
}

/** Table metadata for the JCAD_TABLE xdata. */
function tableMeta(t: TableEntity): string {
  const json = JSON.stringify({ position: t.position, rotation: t.rotation, rowHeights: t.rowHeights, columnWidths: t.columnWidths, cells: t.cells, textHeight: t.textHeight, ...(t.margin !== undefined ? { margin: t.margin } : {}) });
  // Keep the xdata strings 7-bit so the 255-byte group limit holds in any code page.
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A table is written as an INSERT of an anonymous block holding its lines and text, with the cell data as xdata. */
export function writeTableInsert(w: Writer, t: TableEntity, owner: string, block: string): void {
  writeEntityCommon(w, t, owner, 'INSERT', 'AcDbBlockReference');
  w.pair(2, block);
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(1001, TABLE_APP);
  const meta = tableMeta(t);
  for (let i = 0; i < meta.length; i += 250) w.pair(1000, meta.slice(i, i + 250));
}
