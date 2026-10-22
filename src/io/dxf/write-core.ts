/**
 * DXF writing basics: number formatting, the group-code writer with its handle counter, and the
 * groups entities start with (AcDbEntity common data, text placement, annotative XDATA).
 */
import type { DimStyle, ColorSpec, Entity, ImageEntity, TableEntity } from '../../core/entities';
import { ANNO_APP } from './codes';
import * as g from '../../core/geometry';
import { STANDARD_DIMSTYLE } from '../../core/dimension';
import type { TextPlacement } from '../../core/text-placement';
import { transparencyToDxf, validColorName } from '../../core/appearance';
import type { CadAnchor } from '../../core/cad-graph';

// ---------------------------------------------------------------- writing

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(10);
  // For |n| >= 1e21, toFixed returns the shortest exponential form
  // ("2e+160"): the trailing-zero trim must not run there, because it
  // eats the exponent's own trailing zero and silently writes 2e+16
  // (round 5, R4-01 — a finite flip-and-scale placement was written
  // corrupted and read back at the wrong magnitude). The exponential
  // form is already shortest-round-trip, so it is emitted unchanged;
  // output for every |n| < 1e21 is byte-identical to before.
  const trimmed = s.includes('e') ? s : s.replace(/\.?0+$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

export class Writer {
  private out: string[] = [];
  private handle = 0x100;
  readonly textStyleHandles = new Map<string, string>();
  readonly dimensionStyles = new Map<string, DimStyle>();
  readonly reservedEntityHandles = new WeakMap<Entity, string>();
  reserveEntityHandle(entity: Entity): string {
    const known = this.reservedEntityHandles.get(entity);
    if (known) return known;
    const handle = this.nextHandle();
    this.reservedEntityHandles.set(entity, handle);
    return handle;
  }
  /** The DXF version the current write targets, chosen by writeDxf from the drawing
   * (max of the appearance-driven version and the retained source version). Entity
   * writers whose file format changed between releases branch on it — today only
   * the ACAD_TABLE cell form (legacy at AC1015..AC1027, cell-value at AC1032). */
  acadVersion = 'AC1015';
  readonly cadAnchors = new Map<string, CadAnchor>();
  anchor(handle: string, anchor: CadAnchor): void { this.cadAnchors.set(handle, anchor); }
  pair(code: number, value: string | number): void {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  nextHandle(): string {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }
  lastHandle(): number {
    return this.handle;
  }
  toString(): string {
    return this.out.join('\r\n') + '\r\n';
  }
}

function colorCode(c: ColorSpec): number {
  return c === 'ByLayer' ? 256 : c;
}

/** Block-record handles of paper-space layouts while writeDxf runs: their entities get group 67 = 1 (Track E). */
let paperOwners: ReadonlySet<string> = new Set();

export function writeAnnotativeXdata(w: Writer): void {
  w.pair(1001, ANNO_APP);
  w.pair(1000, 'AnnotativeData');
  w.pair(1002, '{');
  w.pair(1070, 1);
  w.pair(1070, 1);
  w.pair(1002, '}');
}

export function writePaperSpaceFlag(w: Writer, spaceOwner: string): void {
  if (paperOwners.has(spaceOwner)) w.pair(67, 1);
}

export function writeEntityCommon(w: Writer, e: Entity, owner: string, kind: string, subclass: string, spaceOwner = owner, extensionDictionary?: string): void {
  w.pair(0, kind);
  const handle = w.reservedEntityHandles.get(e) ?? w.nextHandle();
  w.pair(5, handle);
  w.anchor(handle, { kind: 'entity', id: e.id });
  // An extension dictionary rides between the handle and the owner, exactly
  // where AutoCAD puts it (the genuine AC1015 table control): 102 block, the
  // hard-owner 360, 102 close. Only the native table's roundtrip chain uses
  // this today (P22 F-2 successor).
  if (extensionDictionary) {
    w.pair(102, '{ACAD_XDICTIONARY');
    w.pair(360, extensionDictionary);
    w.pair(102, '}');
  }
  w.pair(330, owner);
  w.pair(100, 'AcDbEntity');
  writePaperSpaceFlag(w, spaceOwner);
  w.pair(8, e.layer);
  if (e.linetype && e.linetype.toUpperCase() !== 'BYLAYER') w.pair(6, e.linetype);
  if (e.color !== 'ByLayer') w.pair(62, colorCode(e.color));
  if (e.ltscale !== undefined && e.ltscale !== 1) w.pair(48, e.ltscale);
  if (e.lineWeight !== undefined) w.pair(370, e.lineWeight < 0 ? Math.round(e.lineWeight) : Math.round(e.lineWeight * 100));
  if (e.trueColor !== undefined) w.pair(420, e.trueColor & 0xffffff);
  if (e.colorName !== undefined) {
    if (!validColorName(e.colorName)) throw new Error('Invalid named/color-book identity.');
    w.pair(430, e.colorName);
  }
  if (e.transparency !== undefined) w.pair(440, transparencyToDxf(e.transparency));
  w.pair(100, subclass);
}

export function writeTextLike(w: Writer, position: g.Point, height: number, text: string, rotation: number, align: 'left' | 'center' | 'right', placement?: TextPlacement): void {
  w.pair(10, placement?.firstAlignmentPoint?.x ?? position.x);
  w.pair(20, placement?.firstAlignmentPoint?.y ?? position.y);
  w.pair(30, 0);
  w.pair(40, height);
  w.pair(1, text);
  if (rotation !== 0) w.pair(50, g.deg(rotation));
  const h = placement?.justification?.horizontal ?? (align === 'center' ? 1 : align === 'right' ? 2 : 0);
  if (h !== 0) w.pair(72, h);
  if (h !== 0 || placement?.justification?.vertical || placement?.alignmentPoint) {
    w.pair(11, placement?.alignmentPoint?.x ?? position.x);
    w.pair(21, placement?.alignmentPoint?.y ?? position.y);
    w.pair(31, 0);
  }
}

export function writeTextStyle(w: Writer, placement: TextPlacement & { readonly style?: string }): void {
  if (placement.style) w.pair(7, placement.style);
  // Canonical entity defaults also cover generated labels/attributes on their first export.
  // The native reader materializes omitted 1/0, so later exports must not add new fields.
  w.pair(41, placement.widthFactor ?? 1);
  w.pair(51, g.deg(placement.oblique ?? 0));
}

/**
 * A generated AC1015 roundtrip chain for one native table (P22 F-2 successor):
 * the handles of its extension dictionary, roundtrip XRECORD, ACDBDATATABLE
 * and per-cell CELL_VALUE XRECORDs, plus the per-cell load-time values the
 * chain carries (row-major). Present only when the table is written at
 * AC1015 and the retained graph carries no chain for it.
 */
export interface TableRoundtripPlan {
  dict: string;
  record: string;
  data: string;
  cellHandles: string[];
  cells: Array<{ content: string; alignmentOverride: boolean }>;
}

/** Handles and names the writer allocates before the entity pass (images, tables). */
export interface WriteExtras {
  /** IMAGEDEF handle per image path. */
  imageDefs: Map<string, string>;
  /** IMAGEDEF_REACTOR handle per image entity, and the image's own handle once written. */
  imageReactors: Map<ImageEntity, { reactor: string; image?: string; def: string }>;
  /** Native-table write data per table: its *T picture block (name + BLOCK_RECORD handle) and TABLESTYLE handle. */
  tableBlocks: Map<TableEntity, { name: string; recordHandle: string; styleHandle: string; roundtrip?: TableRoundtripPlan }>;
  /** DIMASZ × DIMSCALE of the header style (leaders store their arrow size as an override when it differs). */
  arrowSize: number;
}

export function emptyExtras(): WriteExtras {
  return { imageDefs: new Map(), imageReactors: new Map(), tableBlocks: new Map(), arrowSize: STANDARD_DIMSTYLE.arrowSize };
}

/** writeDxf names the paper-space owners before it writes any entity. */
export function setPaperOwners(owners: ReadonlySet<string>): void {
  paperOwners = owners;
}
