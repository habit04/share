/**
 * Entity codecs, writer side, for annotation and reference objects: MTEXT, DIMENSION (with the
 * name of its *D picture block), LEADER (+ its MTEXT), IMAGE (+ its IMAGEDEF reactor) and tables
 * (a native ACAD_TABLE referencing its generated *T picture block and TABLESTYLE; P22).
 */
import { Writer, writeEntityCommon } from './write-core';
import type { MTextEntity, DimensionEntity, LeaderEntity, ImageEntity, TableEntity } from '../../core/entities';
import { formattedSource, mtextFromDxf, mtextToDxf } from '../../core/mtext';
import { textStyleOf } from '../encoding';
import { MTEXT_COLUMNS_APP, MTEXT_BACKGROUND_APP, DIM_TYPE, DIMSTYLE_APP, TABLE_APP } from './codes';
import { backgroundMetadataChunks } from './mtext-background-data';
import * as g from '../../core/geometry';
import { dimensionTextPoint, dimensionMeasurement, dimensionStyleOverrides, dimStyleOverrideCode, DIM_VARIABLES, ordinateDimensionProblem } from '../../core/dimension';
import { textWidth, leaderParts, leaderPath } from '../../core/entities';
import { cellOwners, rowHeightFor, TABLE_DEFAULTS } from '../../core/table';
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
export function writeDimStyleOverrides(w: Writer, e: DimensionEntity): void {
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

/**
 * Encode a table cell's PLAIN text as DXF MTEXT content (P22 fix F1). The model's
 * `text` is plain text (paragraphs separated by '\n'); written unescaped, any
 * backslash sequence, brace or %% code it happens to contain is consumed by MTEXT
 * parsing on re-read and the text comes back altered or lost ('A\PB' -> 'A\nB',
 * 'C:\new\path' -> 'C:ew'). The encoding escapes exactly what the parser
 * (core/mtext parseMText) consumes, so plain text round-trips byte-exact:
 * '\' -> '\\', '{' -> '\{', '}' -> '\}', '\n' -> '\P'. A '%%' pair whose next
 * character the parser would consume as a code (%%u / %%o / %%k toggles,
 * %%<digits> character codes) has its second '%' written as the +0025 unicode
 * escape; a '%%' pair followed by any other character is a three-character
 * literal to the parser, so all three characters go out raw — escaping the
 * third would feed the parser a different literal. Genuine formatting never
 * passes through here: a cell whose `raw` still matches its text is written
 * from the raw verbatim (formattedSource), never double-escaped.
 */
export function mtextPlainToDxf(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' || ch === '{' || ch === '}') {
      out += `\\${ch}`;
      continue;
    }
    if (ch === '\n') {
      out += '\\P';
      continue;
    }
    if (ch === '%' && text[i + 1] === '%' && i + 2 < text.length) {
      const c = text[i + 2]!;
      if (/[uUoOkK\d]/.test(c)) {
        out += '%\\U+0025';
        i += 1;
        continue;
      }
      if (c === '\n') {
        out += '\\U+0025%\\P';
        i += 2;
        continue;
      }
      if (c === '\r') {
        out += '\\U+0025%\\U+000D';
        i += 2;
        continue;
      }
      out += `%%${c}`;
      i += 2;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * True when `content` is exactly the plain-text encoding (mtextPlainToDxf) of
 * its own decoded text — i.e. the content carries no formatting beyond what
 * plain text expresses, so the reader keeps it as plain text with no `raw`.
 * The reader's raw rule and the carrier's canonical form both use this test,
 * which is what makes escape-encoded plain text a fixed point of the round
 * trip instead of an ever-growing layer of formatting.
 */
export function isEscapedPlainContent(content: string): boolean {
  return mtextPlainToDxf(mtextFromDxf(content)) === content;
}

/**
 * Guard a generated string against the DXF string layer's own escape decoding
 * (io/encoding decodeUnicodeEscapes, applied to every group value on read):
 * a backslash that begins a \U+XXXX or \M+nXXXX pattern is itself written as
 * the \U+005C escape, which that layer decodes back to exactly the backslash
 * the MTEXT layer must see. Without the guard, the DXF layer consumes the
 * pattern first ('X\\U+0041Y' would arrive at the MTEXT parser as 'X\AY').
 * Applied only to strings this writer generates (plain-encoded cell content
 * and the JCAD_TABLE carrier); retained `raw` content keeps its as-is bytes.
 */
export function guardDxfEscapes(content: string): string {
  return content.replace(/\\(U\+[0-9A-Fa-f]{4}|M\+[1-5][0-9A-Fa-f]{4})/g, (_m, rest: string) => `\\U+005C${rest}`);
}

/** The one DXF-layer escape sequence guardDxfEscapes ever emits. */
const DXF_GUARD_ESCAPE = '\\U+005C';

/**
 * The end offset for the next chunk of a >250-char guarded table string
 * written in 250-char group chunks (P22 fix F-1b): at most 250, pulled back
 * so a split never separates the halves of a surrogate pair and never cuts
 * a DXF-layer guard escape. The reader decodes \U+XXXX escapes PER GROUP
 * VALUE (io/dxf/reader), so a guard cut by a chunk boundary is never
 * decoded at that layer; the MTEXT / JSON parser below it then consumes
 * the sequence itself and the authored text comes back altered ('%%u' ->
 * '%\U+0025u'). A split only ever moves EARLIER, and only across a
 * sequence that would otherwise straddle, so content with no straddling
 * guard or surrogate pair chunks byte-identically to a plain 250 split.
 * Serves the two guarded table writers below (ACAD_TABLE cell content and
 * the JCAD_TABLE carrier); the MTEXT entity writer does not emit guarded
 * content and keeps its own chunking.
 */
function dxfChunkEnd(rest: string): number {
  let end = 250;
  // A promoted UTF-8 DXF must not separate the halves of a supplementary character.
  if (/[\uD800-\uDBFF]/.test(rest[end - 1]!) && /[\uDC00-\uDFFF]/.test(rest[end]!)) end = 249;
  // Only the last guard starting before the cut can straddle it: guard
  // occurrences cannot overlap, so every earlier one ends before it starts.
  const guardAt = rest.lastIndexOf(DXF_GUARD_ESCAPE, end - 1);
  if (guardAt !== -1 && guardAt + DXF_GUARD_ESCAPE.length > end) end = guardAt;
  return end;
}

/**
 * Table metadata for the JCAD_TABLE xdata, serialised in the reader's
 * normalised form (P22 fix F2b): the carrier must encode the model as the
 * native round trip reconstructs it, or the second save rewrites the payload
 * with reader-normalised cells and stability arrives only at the third write.
 * Concretely, per grid position (fixed key order): a VISIBLE cell carries its
 * effective height / attachment (the reader materialises both from groups
 * 140/170) and its raw only when the reader would keep it (formatted source
 * present, not the plain encoding of its own text); a merge-COVERED cell
 * carries its text/raw as authored plus the height / attachment the reader
 * rebuilds for it from the TABLESTYLE role defaults (title row 0, header
 * row 1, data elsewhere) — restoreCoveredCells overlays the text/raw onto
 * exactly that native cell. The effective margin is always present (the
 * reader materialises it from the style), and the rotation is the written
 * direction vector's angle (tableDxfRotation).
 */
function tableMeta(t: TableEntity): string {
  const key = tableStyleKey(t);
  const owners = cellOwners(t);
  const rows = t.rowHeights.length;
  const cols = t.columnWidths.length;
  const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    const cell = t.cells[r]?.[c] ?? { text: '' };
    const covered = owners[r]![c]![0] !== r || owners[r]![c]![1] !== c;
    if (covered) {
      const role = r === 0 ? { height: key.titleHeight, attachment: 5 } : r === 1 ? { height: key.dataHeight, attachment: 5 } : { height: key.dataHeight, attachment: 2 };
      return { text: cell.text, ...(cell.raw !== undefined ? { raw: cell.raw } : {}), height: role.height, attachment: role.attachment };
    }
    return {
      text: cell.text,
      ...(cell.text !== '' && cell.raw !== undefined && formattedSource(cell) !== null && !isEscapedPlainContent(cell.raw) ? { raw: cell.raw } : {}),
      height: cell.height ?? t.textHeight,
      attachment: cell.attachment ?? 5,
      ...(cell.span && (cell.span.rows > 1 || cell.span.cols > 1) ? { span: cell.span } : {}),
    };
  }));
  // The carrier describes the table AS WRITTEN (P22 F-1): its row heights are the
  // DXF form's (multi-line fit floor applied), matching the 141s the native record
  // carries — a carrier serialized with the raw heights would change bytes on the
  // second save of any table that has both a carrier and a multi-line cell.
  const json = JSON.stringify({ position: t.position, rotation: tableDxfRotation(t.rotation), rowHeights: tableDxfForm(t).rowHeights, columnWidths: t.columnWidths, cells, textHeight: t.textHeight, margin: t.margin ?? TABLE_DEFAULTS.margin });
  // Keep the xdata strings 7-bit so the 255-byte group limit holds in any code page.
  // The DXF-escape guard keeps a cell text containing a literal \U+XXXX sequence
  // from corrupting the JSON at the string layer on re-read (P22 fix F1).
  return guardDxfEscapes(json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

/**
 * The synthesized TABLESTYLE values for a table (P22 slice 1): the style's margins and its
 * data / title text heights. The writer groups tables by this signature and emits one
 * TABLESTYLE object per distinct signature; every cell also writes its effective height
 * and attachment natively, so no cell depends on style inheritance to round-trip.
 *
 * The title height is the first cell's EFFECTIVE height — its override, else the
 * table's data text height (P22 fix F2a). The reader materializes exactly that
 * effective height back onto the first cell (its group 140), so synthesis and
 * reader normalization agree and the second save is stable. The former fallback
 * to TABLE_DEFAULTS.titleHeight described an unmaterialized model only: a
 * title-less table's first save claimed 0.25 and its second 0.18.
 */
export function tableStyleKey(t: TableEntity): { margin: number; dataHeight: number; titleHeight: number } {
  return {
    margin: t.margin ?? TABLE_DEFAULTS.margin,
    dataHeight: t.textHeight,
    titleHeight: t.cells[0]?.[0]?.height ?? t.textHeight,
  };
}

/** A DXF real as the reader parses it back: the writer's 10-decimal format, as a double. */
function dxfReal(n: number): number {
  const v = Number(n.toFixed(10));
  return v === 0 ? 0 : v;
}

/**
 * The rotation a table is written with (P22 fix F2c): the angle of the direction
 * vector AS THE READER RECONSTRUCTS IT — atan2 of the 10-decimal vector groups,
 * iterated to its fixed point (two applications; a 2M-angle sweep shows the
 * second application is the last that can move the value, and that ~2.3% of
 * angles are unstable without quantizing at all). Writing geometry (the *T
 * picture, the 11/21 vector) from the unquantized angle made the second save
 * shift line endpoints by ~1e-10 for those angles; from the converged angle
 * the first write is already the fixed point. The geometry change is at most
 * ~1e-10 — below the format's own precision.
 */
export function tableDxfRotation(rotation: number): number {
  const once = Math.atan2(dxfReal(Math.sin(rotation)), dxfReal(Math.cos(rotation)));
  return Math.atan2(dxfReal(Math.sin(once)), dxfReal(Math.cos(once)));
}

/**
 * The line count of a cell's written content (P22 F-1): paragraph breaks in the
 * string the writer emits for the cell — the formatted source while it still
 * matches the text, else the plain text converted for DXF, which turns each
 * '\n' into '\P'. Escaped characters are skipped in pairs, so a literal "\P"
 * in the text (written '\\P') does not count as a break.
 */
function cellLineCount(cell: TableEntity['cells'][number][number]): number {
  const content = formattedSource(cell) ?? mtextPlainToDxf(cell.text);
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\\') {
      if (content[i + 1] === 'P') lines += 1;
      i += 1;
    }
  }
  return lines;
}

/**
 * The least height row r may be written with (P22 F-1, the lead's native
 * re-run item A15): the fit height — lines x text height x 4/3 + top and
 * bottom margins (rowHeightFor, the model's own measure) — of the row's
 * tallest MULTI-LINE owner cell, or 0 when the row has none. AutoCAD
 * recomputes row heights to fit content when it saves: at the re-run it grew
 * a 0.36 row to 0.6 for a two-line cell at text height 0.18 with 0.06
 * margins — exactly rowHeightFor(2, 0.18, 0.06) — so a written row that is
 * too small for its multi-line cells does not survive an AutoCAD save
 * unchanged. Single-line rows are NOT floored: AutoCAD's own genuine
 * controls carry authored single-line row heights below the fit height of
 * a height-override cell (0.4304… under a 0.3 override, fit 0.52), and
 * those heights are preserved verbatim.
 */
function rowHeightFloor(t: TableEntity, r: number, owners: ReturnType<typeof cellOwners>): number {
  let floor = 0;
  const margin = t.margin ?? TABLE_DEFAULTS.margin;
  for (let c = 0; c < t.columnWidths.length; c += 1) {
    if (owners[r]![c]![0] !== r || owners[r]![c]![1] !== c) continue;
    const cell = t.cells[r]?.[c];
    if (!cell) continue;
    const lines = cellLineCount(cell);
    if (lines >= 2) floor = Math.max(floor, rowHeightFor(lines, cellHeight(t, cell), margin));
  }
  return floor;
}

/**
 * A table in the exact form the DXF round trip reconstructs (P22 fix F2c):
 * position and row/column sizes at the writer's 10-decimal precision, rotation
 * at tableDxfRotation. Generating the *T picture from this form — instead of
 * the authored values, whose >10-decimal sizes (a 0.45333… row height) the
 * file cannot carry — makes the first write byte-identical to every re-save.
 * Row heights additionally carry the multi-line fit floor (P22 F-1): a stored
 * height below its row's floor is raised to the floor, at the same
 * 10-decimal precision, so the raise is itself a fixed point.
 */
export function tableDxfForm(t: TableEntity): TableEntity {
  const owners = cellOwners(t);
  return {
    ...t,
    position: { x: dxfReal(t.position.x), y: dxfReal(t.position.y) },
    rotation: tableDxfRotation(t.rotation),
    rowHeights: t.rowHeights.map((h, r) => Math.max(dxfReal(h), dxfReal(rowHeightFloor(t, r, owners)))),
    columnWidths: t.columnWidths.map(dxfReal),
  };
}

/**
 * The form the *T picture block is generated from (P22 COMP-N N-2): the table's
 * DXF form re-anchored to the block's local frame — position (0, 0), rotation 0.
 * AutoCAD stores a table's picture block in local coordinates (specimens: the
 * lead's Recipe B controls, whose *T geometry extents are [0, W] x [-H, 0] with
 * base point (0, 0)); the ACAD_TABLE block reference (insertion point + 11/21
 * direction) then lands the picture exactly on the cell grid. Generating the
 * picture from the world form instead stored world coordinates in the block,
 * so the reference displayed the grid one insertion-offset away from the cells
 * and AutoCAD's TABLEDIT could not pick a cell (gate-a: drawn y [18.47, 20]
 * vs cell grid y [8.47, 10]). Row/column sizes still pass through tableDxfForm,
 * so a re-read table regenerates the identical picture.
 */
export function tablePictureForm(t: TableEntity): TableEntity {
  return tableDxfForm({ ...t, position: { x: 0, y: 0 }, rotation: 0 });
}

/**
 * A cell's effective text height / attachment, exactly as tableGeometry renders them:
 * the cell's override, else the table text height / middle-centre (5). Writing anything
 * else (e.g. a row-role default) would change the model on re-read and move the *T
 * picture; the role defaults (data 2, title/header 5) live only in the TABLESTYLE.
 */
function cellHeight(t: TableEntity, cell: TableEntity['cells'][number][number]): number {
  return cell.height ?? t.textHeight;
}

function cellAttachment(cell: TableEntity['cells'][number][number]): number {
  return cell.attachment ?? 5;
}

/**
 * Per-cell group 91 flags of the AC1032 cell-value form, as the genuine AutoCAD
 * R2018 control writes them (fixtures/interchange/r2018-table-autocad.dxf):
 * every content-bearing cell carries 0x40000; the cell with a 140 text-height
 * override adds 0x20; the cell with a 170 alignment override adds 0x1; a
 * merge-covered cell (no content, no overrides) carries 0.
 */
const CELL_FLAG_VALUE = 0x40000;
const CELL_FLAG_HEIGHT = 0x20;
const CELL_FLAG_ALIGNMENT = 0x1;

/**
 * A table is written as a native ACAD_TABLE (P22 slice 1, text cells), referencing its
 * generated *T picture block (2 / 343) and the synthesized TABLESTYLE (342). The cell
 * form is version-conditional (P22 COMP-N / N-3): at AC1015..AC1027
 * AutoCAD's own R2000 per-cell form (P22 F-2: 171.. head with 177 override
 * flags, text in 3-chunks + a group 1 every cell carries, 140/170 only where
 * the cell departs from its row role, after the text, 175/176 spans with
 * covered cells at 1); at AC1032 the cell-value form AutoCAD's own R2018
 * output uses (301 CELL_VALUE .. 304 ACVALUE_END per cell, overrides only where the
 * cell departs from its row role's style defaults, flagged in group 91) — AutoCAD
 * reads ONLY the cell-value form at AC1032 and silently discards legacy cell text
 * there. Cells covered by a merge are written virtual (173 = 1) with no content, as
 * AutoCAD does; if a covered cell nevertheless carries text in the model, the full
 * cell data rides as JCAD_TABLE xdata (the preservation carrier) so it is never
 * silently stripped, and the reader restores it. The carrier is also written when
 * no visible cell has text: the native reader (like AutoCAD's) treats a textless
 * ACAD_TABLE as picture-only, so an all-empty JCad table needs the carrier to reopen
 * as an editable table instead of a dumb picture insert.
 */
export function writeAcadTable(w: Writer, t: TableEntity, owner: string, picture: { name: string; recordHandle: string; styleHandle: string }): void {
  writeEntityCommon(w, t, owner, 'ACAD_TABLE', 'AcDbBlockReference');
  w.pair(2, picture.name);
  w.pair(10, t.position.x);
  w.pair(20, t.position.y);
  w.pair(30, 0);
  w.pair(100, 'AcDbTable');
  w.pair(280, 0);
  w.pair(342, picture.styleHandle);
  w.pair(343, picture.recordHandle);
  const rotation = tableDxfRotation(t.rotation);
  w.pair(11, Math.cos(rotation));
  w.pair(21, Math.sin(rotation));
  w.pair(31, 0);
  w.pair(90, 22);
  const rows = t.rowHeights.length;
  const cols = t.columnWidths.length;
  w.pair(91, rows);
  w.pair(92, cols);
  w.pair(93, 0);
  w.pair(94, 0);
  w.pair(95, 0);
  w.pair(96, 0);
  // The written grid is the table's DXF form (P22 F-1): row heights raised to
  // the multi-line fit floor, so the 141s agree with the *T picture the same
  // form generates (writer.ts) and with what AutoCAD's own save computes.
  for (const h of tableDxfForm(t).rowHeights) w.pair(141, h);
  for (const width of t.columnWidths) w.pair(142, width);
  const owners = cellOwners(t);
  const cellValueForm = w.acadVersion >= 'AC1032';
  // The row roles of the synthesized TABLESTYLE (writer.ts cellStyle): title row 0 at
  // the title height, header row 1, data rows below; attachments 5 / 5 / 2. In the
  // cell-value form a cell states 140 / 170 only where it departs from its role.
  const styleKey = tableStyleKey(t);
  const roleHeight = (r: number) => (r === 0 ? styleKey.titleHeight : styleKey.dataHeight);
  const roleAttachment = (r: number) => (r <= 1 ? 5 : 2);
  let needsCarrier = false;
  let anyVisibleText = false;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cell = t.cells[r]?.[c] ?? { text: '' };
      const covered = owners[r]![c]![0] !== r || owners[r]![c]![1] !== c;
      if (covered && (cell.text !== '' || cell.raw !== undefined)) needsCarrier = true;
      if (!covered && cell.text !== '') anyVisibleText = true;
      const span = cell.span ?? { rows: 1, cols: 1 };
      if (cellValueForm) {
        w.pair(171, 1);
        w.pair(172, 0);
        w.pair(173, covered ? 1 : 0);
        w.pair(174, 0);
        w.pair(175, covered ? 1 : span.cols);
        w.pair(176, covered ? 1 : span.rows);
        const content = covered ? '' : formattedSource(cell) ?? guardDxfEscapes(mtextPlainToDxf(cell.text));
        const heightOverride = !covered && cellHeight(t, cell) !== roleHeight(r);
        const alignmentOverride = !covered && cellAttachment(cell) !== roleAttachment(r);
        let flags = 0;
        if (content !== '') flags |= CELL_FLAG_VALUE;
        if (heightOverride) flags |= CELL_FLAG_HEIGHT;
        if (alignmentOverride) flags |= CELL_FLAG_ALIGNMENT;
        w.pair(91, flags);
        w.pair(178, 0);
        w.pair(145, 0);
        if (heightOverride) w.pair(140, cellHeight(t, cell));
        if (alignmentOverride) w.pair(170, cellAttachment(cell));
        w.pair(92, 0);
        w.pair(301, 'CELL_VALUE');
        if (content !== '') {
          w.pair(93, 6);
          w.pair(90, 4);
          // Text over 250 chars is chunked the way AutoCAD writes it (RULING
          // O-1, the lead's native re-run): 250-char CONTINUATION groups
          // FIRST (2 for the plain string, 303 for the formatted), then the
          // final group (1 / 302) with the remainder. Both sides chunk the
          // same content at the same points (dxfChunkEnd, the writer's
          // existing 250 walk). AutoCAD accepts the unchunked form too — the
          // re-run proved the 300-char cell intact — but matching the native
          // writer is the ruled posture for other readers.
          let rest = content;
          while (rest.length > 250) {
            const end = dxfChunkEnd(rest);
            w.pair(2, rest.slice(0, end));
            rest = rest.slice(end);
          }
          w.pair(1, rest);
          w.pair(94, 0);
          w.pair(300, '');
          rest = content;
          while (rest.length > 250) {
            const end = dxfChunkEnd(rest);
            w.pair(303, rest.slice(0, end));
            rest = rest.slice(end);
          }
          w.pair(302, rest);
        } else {
          w.pair(93, 7);
          w.pair(90, 0);
          w.pair(94, 0);
          w.pair(300, '');
          w.pair(302, '');
        }
        w.pair(304, 'ACVALUE_END');
        continue;
      }
      // AutoCAD's own R2000 form (P22 F-2), matched group-for-group against the
      // genuine AC1015 control (fixtures/interchange/r2000-table-autocad.dxf):
      // no per-cell 91/92, no group 7; group 177 carries the override flags
      // (0x20 height, 0x1 alignment — the same bits the cell-value form's 91
      // uses); merge-covered cells carry spans of 1 and an EMPTY group 1, as
      // every cell carries its text group; 140/170 appear only where the cell
      // departs from its row role's style defaults, after the text. The
      // pre-F-2 JCad form (91/92/7, unconditional 140/170, no text group on
      // covered cells) loaded in AutoCAD with every cell's text empty until a
      // regen and the overrides never appearing at all.
      w.pair(171, 1);
      w.pair(172, 0);
      w.pair(173, covered ? 1 : 0);
      w.pair(174, 0);
      w.pair(175, covered ? 1 : span.cols);
      w.pair(176, covered ? 1 : span.rows);
      const legacyHeightOverride = !covered && cellHeight(t, cell) !== roleHeight(r);
      const legacyAlignmentOverride = !covered && cellAttachment(cell) !== roleAttachment(r);
      let legacyFlags = 0;
      if (legacyHeightOverride) legacyFlags |= CELL_FLAG_HEIGHT;
      if (legacyAlignmentOverride) legacyFlags |= CELL_FLAG_ALIGNMENT;
      w.pair(177, legacyFlags);
      w.pair(178, 0);
      w.pair(145, 0);
      const content = covered ? '' : formattedSource(cell) ?? guardDxfEscapes(mtextPlainToDxf(cell.text));
      let rest = content;
      while (rest.length > 250) {
        const end = dxfChunkEnd(rest);
        w.pair(3, rest.slice(0, end));
        rest = rest.slice(end);
      }
      w.pair(1, rest);
      if (legacyHeightOverride) w.pair(140, cellHeight(t, cell));
      if (legacyAlignmentOverride) w.pair(170, cellAttachment(cell));
    }
  }
  if (needsCarrier || !anyVisibleText) {
    w.pair(1001, TABLE_APP);
    const meta = tableMeta(t);
    let rest = meta;
    while (rest.length > 250) {
      const end = dxfChunkEnd(rest);
      w.pair(1000, rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest) w.pair(1000, rest);
  }
}
