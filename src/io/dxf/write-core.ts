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
  const s = n.toFixed(10).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

export class Writer {
  private out: string[] = [];
  private handle = 0x100;
  readonly textStyleHandles = new Map<string, string>();
  readonly dimensionStyles = new Map<string, DimStyle>();
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

export function writeEntityCommon(w: Writer, e: Entity, owner: string, kind: string, subclass: string, spaceOwner = owner): void {
  w.pair(0, kind);
  w.pair(5, w.nextHandle());
  w.anchor(w.lastHandle().toString(16).toUpperCase(), { kind: 'entity', id: e.id });
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
  if (placement.widthFactor !== undefined && placement.widthFactor !== 1) w.pair(41, placement.widthFactor);
  if (placement.oblique) w.pair(51, g.deg(placement.oblique));
}

/** Handles and names the writer allocates before the entity pass (images, tables). */
export interface WriteExtras {
  /** IMAGEDEF handle per image path. */
  imageDefs: Map<string, string>;
  /** IMAGEDEF_REACTOR handle per image entity, and the image's own handle once written. */
  imageReactors: Map<ImageEntity, { reactor: string; image?: string; def: string }>;
  /** Anonymous block that draws each table. */
  tableBlocks: Map<TableEntity, string>;
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
