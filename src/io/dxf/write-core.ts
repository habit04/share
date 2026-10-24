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
  /** P18: MLEADERSTYLE handles by upper-case style name, pre-allocated like textStyleHandles. */
  readonly mleaderStyleHandles = new Map<string, string>();
  /** P18 slice 2 (PROPOSAL-P18-S2 item (4)): BLOCK_RECORD handles by upper-case block name,
   *  copied from writeDxf's allocation scope when a native block-content mleader exists —
   *  a written mleader names its content block by THIS file's record handle. */
  readonly blockRecordHandles = new Map<string, string>();
  /** P18 slice 2 (PROPOSAL-P18-S2 item (4)): ATTDEF handles as written in this file's BLOCKS
   *  section, keyed "NAME TAG" and "NAME #index" (upper-case name) — populated by the BLOCKS
   *  loop as each ATTDEF is written; a block mleader's attribute entry (group 330) must name
   *  the handle of this file, which only the writer knows. */
  readonly blockAttdefHandles = new Map<string, string>();
  /** P18 S3-D (Amendment 2 (iv)): extension-dictionary chain handles per
   *  multi-context native mleader — extension, manager and scales dictionary
   *  handles plus one context-object handle per context INCLUDING the
   *  primary's, in dictionary order. Allocated by W-ALLOC-18; consumed by
   *  writeEntityCommon's gated subgroup and writer.ts's W-OBJECTS
   *  context-objects block. */
  readonly mleaderContextChains = new WeakMap<Entity, MLeaderContextChainHandles>();
  /** P18 FIX group 1: entities whose context chain is WITHHELD on this write
   *  (a source scale name resolves to no SCALE and cannot be recreated) —
   *  graphWithoutModelledContextChains drops their retained chains too, so
   *  a withheld chain is absent from the output rather than resurrected. */
  readonly mleaderChainsWithheld = new WeakSet<Entity>();
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
  private readonly entityRecordsEmitted = new WeakSet<Entity>();
  /**
   * Handle for the next record emitted for `entity`. The FIRST record uses
   * the entity's reserved handle (allocating and reserving one if needed),
   * so a reference written earlier or later — P17: a hatch's boundary-path
   * 330 — names the handle the entity is actually emitted with. Every
   * FURTHER record for the same object allocates a fresh handle: a
   * multi-record entity (an mleader's several LEADER records, each with
   * its own cad-graph part anchor) must never repeat a handle.
   */
  entityRecordHandle(entity: Entity): string {
    if (!this.entityRecordsEmitted.has(entity)) {
      this.entityRecordsEmitted.add(entity);
      return this.reserveEntityHandle(entity);
    }
    return this.nextHandle();
  }
  readonly cadAnchors = new Map<string, CadAnchor>();
  anchor(handle: string, anchor: CadAnchor): void { this.cadAnchors.set(handle, anchor); }
  pair(code: number, value: string | number): void {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  /** Handles nextHandle must never hand out (P18 FIX group 1): a context
   *  object's group 340 names a RETAINED scale by its source handle, a
   *  cross-space reference the merge's generated-record rewrite would
   *  mistake for a writer handle if the writer allocated the same value. */
  avoidHandles: ReadonlySet<string> = new Set();
  nextHandle(): string {
    do {
      this.handle += 1;
    } while (this.avoidHandles.has(this.handle.toString(16).toUpperCase()));
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

/**
 * P18 S3-D (Amendment 2 (iv)): the extension-dictionary chain handles of one
 * native multileader carrying annotative contexts — see Writer's
 * mleaderContextChains field. `objects` holds one handle per context object,
 * the primary's first (dictionary order).
 */
export interface MLeaderContextChainHandles {
  extension: string;
  manager: string;
  scales: string;
  objects: string[];
  /** P18 FIX group 2: the chain is CARRIED — its handles are the retained
   *  source handles and preserveDxfCadGraph regenerates the retained
   *  records in place; writer.ts's OBJECTS block emits only the objects
   *  beyond the retained count (the model's growth). */
  carried?: boolean;
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
  // The first record emitted for an entity takes its reserved handle, so a
  // record that references it — P17: a hatch's boundary-path 330 — names
  // the same handle; further records for the same object (an mleader's
  // several LEADER records) allocate fresh handles, as they did before P17.
  const handle = w.entityRecordHandle(e);
  w.pair(5, handle);
  w.anchor(handle, { kind: 'entity', id: e.id });
  // An extension dictionary rides between the handle and the owner, exactly
  // where AutoCAD puts it (the genuine AC1015 table control): 102 block, the
  // hard-owner 360, 102 close. Only the native table's roundtrip chain uses
  // this today (P22 F-2 successor).
  // P18 S3-D (Amendment 2 (v)): the ONE gated insertion — a native mleader
  // carrying annotative contexts names its extension dictionary here, in
  // the fixture-verified position (after group 5, before group 330).
  // Entities without a chain entry emit byte-identical output.
  // Composition (lead ruling at the P18 rebase onto the P22 PR-fix head):
  // the explicit parameter is consulted first, the mleader context-chain
  // map second. The two mechanisms serve disjoint entity kinds (ACAD_TABLE
  // vs MULTILEADER), so both naming one entity is a programming error.
  const contextChain = w.mleaderContextChains.get(e);
  if (extensionDictionary && contextChain) {
    throw new Error(`Entity ${e.id} has both an explicit extension dictionary and an mleader context chain; only one mechanism may name an entity's extension dictionary.`);
  }
  const extensionDictHandle = extensionDictionary ?? contextChain?.extension;
  if (extensionDictHandle) {
    w.pair(102, '{ACAD_XDICTIONARY');
    w.pair(360, extensionDictHandle);
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
  /** P17: every entity the writer will emit, by id — a hatch's boundary refs resolve through it. */
  entityById?: ReadonlyMap<string, Entity>;
  /** P17 (Codex PR #44 P1-d): every entity the writer will emit, by canonical SOURCE handle
   *  (its cadIdentity, bare or as the "<session>:<handle>" suffix) — a hatch loop's retained
   *  raw boundary handles resolve through it, so a retained link naming an object that IS in
   *  the drawing is written back instead of silently dropped. */
  entityBySourceHandle?: ReadonlyMap<string, Entity>;
  /** P17 round 2 (Codex P1): retained cad-graph anchors the writer still emits but that
   *  are not entities (REGION / BODY / 3DSOLID raw records), by canonical SOURCE handle —
   *  a hatch loop's retained handle naming one resolves to the anchor's emitted handle
   *  (its canonical source handle, the handle preserveDxfCadGraph emits the record
   *  under) and the owner string it is written under, so the link is remapped and
   *  written instead of dropped. An anchor whose owner cannot be proven in writer
   *  terms carries no owner and classifies as foreign-owned (O5). */
  anchorBySourceHandle?: ReadonlyMap<string, { handle: string; owner?: string }>;
  /** P17 round 5: canonical source handles of retained cad-graph records of type
   *  HATCH that this writer does not emit as entities (raw retained records).
   *  A hatch loop's retained handle naming one is a hatch boundary: the link
   *  is never emitted and the hatch demotes (see writeHatch in write-entities.ts). */
  hatchAnchorHandles?: ReadonlySet<string>;
  /** P17 round 7: the canonical source handles whose entityBySourceHandle
   *  entry was supplied (or overwritten) by the retained cad graph's
   *  entity-anchor join — as opposed to an identity the entity carries in
   *  the model itself (cadIdentity). The graph is the same evidence the
   *  reader adjudicated the file's links against, so a retained handle
   *  resolving ONLY through this join names a link the import already had
   *  its chance to make live: writeHatch emits it (retention) but it
   *  cannot by itself carry 71 = 1 — and since round 8 it VETOES 71 = 1
   *  for the whole hatch in mixed company, so a non-live link is never
   *  written as part of a live association (see writeHatch in
   *  write-entities.ts). */
  graphEntityHandles?: ReadonlySet<string>;
  /** P17 round 2: the canonical source handle of EVERY retained graph node. A hatch
   *  loop's retained handle that names one of these but resolves to no emitted entity
   *  or anchor names an object the drawing retains yet this writer does not emit as a
   *  boundary — the save refuses atomically rather than silently dropping the link. */
  graphSourceHandles?: ReadonlySet<string>;
  /** P17 R1: the owner handle string each entity is written under (its space / block record), by id — a hatch link is associative only within one owner (O5). */
  entityOwner?: ReadonlyMap<string, string>;
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
