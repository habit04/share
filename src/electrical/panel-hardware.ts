/**
 * Panel layout hardware: DIN rails, wire duct, enclosures, mounting-plate
 * grids and the terminal strip footprint, plus the hardware rows the panel
 * reports list (rail / duct lengths, enclosure sizes).
 *
 * Every piece is an insert of a generated block (drawing units: inches) whose
 * invisible attributes carry the data: P_HW (kind), P_TYPE (rail type, duct
 * size, enclosure size), P_LENGTH (inches, rails and duct), P_CAT / P_MFG
 * (part number), P_DESC1. Blocks are named WD_PNL_* so they are drawing
 * furniture, never schematic components; the terminal strip is a footprint
 * (WD_FP_TSTRIP_*) so it gets an item number and shows in the panel list.
 *
 * All geometry is original.
 */
import type { Point } from '../core/geometry';
import type { Entity, BlockDef, InsertEntity, AttributeDef } from '../core/entities';
import { newId } from '../core/entities';

/** Millimetres per drawing unit (inch). */
export const MM_PER_IN = 25.4;
const mm = (v: number): number => v / MM_PER_IN;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

const base = { layer: '0', color: 'ByLayer' as const };
const L = (x1: number, y1: number, x2: number, y2: number, extra: Partial<Entity> = {}): Entity => ({ ...base, id: newId(), type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, ...extra }) as Entity;
const A = (cx: number, cy: number, r: number, s: number, e: number, extra: Partial<Entity> = {}): Entity => ({ ...base, id: newId(), type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: (s * Math.PI) / 180, endAngle: (e * Math.PI) / 180, ...extra }) as Entity;
const R = (x0: number, y0: number, x1: number, y1: number, extra: Partial<Entity> = {}): Entity =>
  ({ ...base, id: newId(), type: 'polyline', closed: true, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], ...extra }) as Entity;
const T = (x: number, y: number, text: string, h: number, rotation = 0, align: 'left' | 'center' | 'right' = 'center'): Entity => ({ ...base, id: newId(), type: 'text', position: { x, y }, text, height: h, rotation, align });
const inv = (tag: string, def: string, y: number): AttributeDef => ({ tag, prompt: tag, default: def, position: { x: 0, y }, height: 0.06, align: 'left', invisible: true });

/** Kinds of panel hardware (value of the P_HW attribute). */
export type HardwareKind = 'DINRAIL' | 'DUCT' | 'ENCLOSURE' | 'PLATE';
export const HARDWARE_LABEL: Record<HardwareKind, string> = { DINRAIL: 'DIN rail', DUCT: 'Wire duct', ENCLOSURE: 'Enclosure', PLATE: 'Mounting plate' };
/** Block-name prefix of every hardware block. */
export const HARDWARE_BLOCK_PREFIX = 'WD_PNL_';
export const isHardwareBlock = (name: string): boolean => name.startsWith(HARDWARE_BLOCK_PREFIX);
export const isHardware = (e: Entity): e is InsertEntity => e.type === 'insert' && isHardwareBlock(e.block) && !!e.attributes.P_HW;

/** Length formatted in inches and millimetres: 12.000 in (304.8 mm). */
export const formatLength = (inches: number): string => `${inches.toFixed(3)} in (${(inches * MM_PER_IN).toFixed(1)} mm)`;
/** A block-name safe key for a length (thousandths of an inch). */
const lengthKey = (inches: number): string => String(Math.round(inches * 1000));

// ------------------------------------------------------------ DIN rail

export type RailType = 'TS35' | 'TS32' | 'TS15';

export interface RailSpec {
  type: RailType;
  /** Overall width across the rail, mm (35 / 32 / 15). */
  widthMm: number;
  /** Overall width, inches. */
  width: number;
  /** Profile depth, mm. */
  depthMm: number;
  /** Width of the raised centre (web) seen from the front, mm. */
  webMm: number;
  /** Mounting slots (slotted rail): length along the rail, width, pitch; mm, nominal. */
  slot: { lengthMm: number; widthMm: number; pitchMm: number };
  description: string;
}

/** Standard rails (EN 60715): TS35 top-hat, TS32 G-section, TS15 miniature. Slot sizes are nominal. */
export const RAIL_TYPES: RailSpec[] = [
  { type: 'TS35', widthMm: 35, width: mm(35), depthMm: 7.5, webMm: 27, slot: { lengthMm: 25, widthMm: 5.2, pitchMm: 36 }, description: 'DIN rail TS35 x 7.5 top hat, slotted' },
  { type: 'TS32', widthMm: 32, width: mm(32), depthMm: 15, webMm: 22, slot: { lengthMm: 15, widthMm: 5.2, pitchMm: 25 }, description: 'DIN rail TS32 G-section, slotted' },
  { type: 'TS15', widthMm: 15, width: mm(15), depthMm: 5.5, webMm: 10.5, slot: { lengthMm: 10, widthMm: 4.2, pitchMm: 15 }, description: 'DIN rail TS15 miniature, slotted' },
];

export function railSpec(type: string): RailSpec {
  return RAIL_TYPES.find((r) => r.type === type.toUpperCase()) ?? RAIL_TYPES[0]!;
}

/** Rail block name for a type and length (one definition per distinct length). */
export const railBlockName = (type: RailType, length: number): string => `${HARDWARE_BLOCK_PREFIX}DIN_${type}_L${lengthKey(length)}`;

/** A slot (obround) centred on (cx, 0) along x. */
function slot(cx: number, len: number, w: number): Entity[] {
  const r = w / 2;
  const h = len / 2 - r;
  return [L(cx - h, r, cx + h, r), L(cx - h, -r, cx + h, -r), A(cx + h, 0, r, -90, 90), A(cx - h, 0, r, 90, 270)];
}

/**
 * DIN rail block: base point at the start of the rail centre line, the rail runs along +x
 * for `length` inches; outline, the web edges and the mounting slots (none closer than the
 * slot pitch / 2 to an end).
 */
export function railBlock(type: RailType, length: number, cat = ''): BlockDef {
  const s = railSpec(type);
  const w = s.width;
  const web = mm(s.webMm) / 2;
  const ents: Entity[] = [R(0, -w / 2, length, w / 2), L(0, web, length, web), L(0, -web, length, -web)];
  const pitch = mm(s.slot.pitchMm);
  const sl = mm(s.slot.lengthMm);
  const n = Math.floor((length - pitch / 2 - sl / 2) / pitch) + 1;
  if (length >= sl + 0.1 && n > 0) {
    // Centre the slot pattern on the rail.
    const span = (n - 1) * pitch;
    const first = (length - span) / 2;
    for (let i = 0; i < n; i += 1) ents.push(...slot(first + i * pitch, sl, mm(s.slot.widthMm)));
  }
  const attributes: AttributeDef[] = [
    inv('P_HW', 'DINRAIL', 0),
    inv('P_TYPE', s.type, -0.08),
    inv('P_LENGTH', r3(length).toFixed(3), -0.16),
    inv('P_CAT', cat, -0.24),
    inv('P_MFG', '', -0.32),
    inv('P_DESC1', `${s.description}, ${formatLength(length)}`, -0.4),
  ];
  return { name: railBlockName(s.type, length), description: `${s.description}, ${formatLength(length)}`, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

/** Insert of a rail from `start`, `length` long at `angle` (radians). */
export function makeRail(type: RailType, start: Point, length: number, angle = 0, cat = ''): { block: BlockDef; insert: InsertEntity } {
  const block = railBlock(type, length);
  const attrs: Record<string, string> = {};
  for (const a of block.attributes) attrs[a.tag] = a.default;
  attrs.P_CAT = cat;
  return { block, insert: { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: block.name, position: start, rotation: angle, scale: 1, attributes: attrs } };
}

// ------------------------------------------------------------ wire duct

export interface DuctSize {
  /** Width seen on the panel (inches). */
  width: number;
  /** Height (depth off the plate), inches. */
  height: number;
  /** Size label, e.g. 2x3. */
  label: string;
}

/** Stock duct sizes (W x H inches). */
export const DUCT_SIZES: DuctSize[] = [
  { width: 1, height: 1, label: '1x1' },
  { width: 1.5, height: 2, label: '1.5x2' },
  { width: 2, height: 2, label: '2x2' },
  { width: 2, height: 3, label: '2x3' },
  { width: 3, height: 3, label: '3x3' },
  { width: 4, height: 4, label: '4x4' },
];

/** Parse a duct size ("2x3", "1.5 X 2", "2"), matching the stock list; null when unknown. */
export function parseDuctSize(text: string): DuctSize | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[xX*]\s*(\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (!m) return null;
  const w = parseFloat(m[1]!);
  const h = m[2] ? parseFloat(m[2]) : null;
  return DUCT_SIZES.find((d) => d.width === w && (h === null || d.height === h)) ?? null;
}

/** Cover lip inset of the duct outline (the cover edge seen from the front). */
export const DUCT_COVER_INSET = 0.12;

export const ductBlockName = (size: DuctSize, length: number): string => `${HARDWARE_BLOCK_PREFIX}DUCT_${size.label.replace('.', 'P').toUpperCase()}_L${lengthKey(length)}`;

/** Wire duct block: base point at the start of the duct centre line, runs along +x; outline plus the two cover lines. */
export function ductBlock(size: DuctSize, length: number, cat = ''): BlockDef {
  const w = size.width / 2;
  const c = w - DUCT_COVER_INSET;
  const ents: Entity[] = [R(0, -w, length, w), L(0, c, length, c), L(0, -c, length, -c)];
  const desc = `Wire duct ${size.width} x ${size.height} in, ${formatLength(length)}`;
  const attributes: AttributeDef[] = [
    inv('P_HW', 'DUCT', 0),
    inv('P_TYPE', size.label, -0.08),
    inv('P_LENGTH', r3(length).toFixed(3), -0.16),
    inv('P_CAT', cat, -0.24),
    inv('P_MFG', '', -0.32),
    inv('P_DESC1', desc, -0.4),
  ];
  return { name: ductBlockName(size, length), description: desc, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

export function makeDuct(size: DuctSize, start: Point, length: number, angle = 0, cat = ''): { block: BlockDef; insert: InsertEntity } {
  const block = ductBlock(size, length);
  const attrs: Record<string, string> = {};
  for (const a of block.attributes) attrs[a.tag] = a.default;
  attrs.P_CAT = cat;
  return { block, insert: { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: block.name, position: start, rotation: angle, scale: 1, attributes: attrs } };
}

// ------------------------------------------------------------ enclosure

export interface EnclosureSize {
  height: number;
  width: number;
  depth: number;
  label: string;
}

const enc = (h: number, w: number, d: number): EnclosureSize => ({ height: h, width: w, depth: d, label: `${h}x${w}x${d}` });
/** Common wall-mount and floor-standing enclosure sizes, H x W x D inches. */
export const ENCLOSURE_SIZES: EnclosureSize[] = [enc(16, 12, 6), enc(20, 16, 6), enc(24, 20, 8), enc(30, 24, 8), enc(36, 30, 10), enc(42, 36, 12), enc(48, 36, 12), enc(60, 36, 16), enc(72, 36, 16)];

/** Parse "24x20x8" (H x W x D); any positive size is accepted (Custom). */
export function parseEnclosureSize(text: string): EnclosureSize | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*(?:[xX*]\s*(\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (!m) return null;
  const h = parseFloat(m[1]!);
  const w = parseFloat(m[2]!);
  const d = m[3] ? parseFloat(m[3]) : 0;
  if (!(h > 0 && w > 0) || h > 200 || w > 200) return null;
  return { height: h, width: w, depth: d, label: `${h}x${w}${d ? `x${d}` : ''}` };
}

/** Mounting plate (back panel) of an enclosure: 3 in smaller than the enclosure each way, centred. */
export function plateOf(size: Pick<EnclosureSize, 'width' | 'height'>): { width: number; height: number; offset: Point } {
  const width = Math.max(size.width - 3, size.width * 0.6);
  const height = Math.max(size.height - 3, size.height * 0.6);
  return { width, height, offset: { x: (size.width - width) / 2, y: (size.height - height) / 2 } };
}

export type DoorHinge = 'LEFT' | 'RIGHT' | 'NONE';

export const enclosureBlockName = (size: EnclosureSize, hinge: DoorHinge): string => `${HARDWARE_BLOCK_PREFIX}ENC_${size.label.replace(/\./g, 'P').toUpperCase()}_${hinge.charAt(0)}`;

/**
 * Enclosure outline (front view), base point at the lower-left corner: outer box, door
 * opening flange, mounting plate (hidden linetype), hinges and handle; with a hinge side the
 * door swing is drawn below the enclosure (quarter arc of the door width and the open door).
 */
export function enclosureBlock(size: EnclosureSize, hinge: DoorHinge, cat = ''): BlockDef {
  const { width: W, height: H } = size;
  const f = Math.min(0.75, W * 0.05);
  const ents: Entity[] = [R(0, 0, W, H), R(f, f, W - f, H - f)];
  const plate = plateOf(size);
  ents.push(R(plate.offset.x, plate.offset.y, plate.offset.x + plate.width, plate.offset.y + plate.height, { linetype: 'HIDDEN', color: 8 } as Partial<Entity>));
  if (hinge !== 'NONE') {
    const hx = hinge === 'LEFT' ? 0 : W;
    const out = hinge === 'LEFT' ? -1 : 1;
    const n = H > 30 ? 3 : 2;
    for (let i = 0; i < n; i += 1) {
      const y = n === 2 ? (i === 0 ? H * 0.2 : H * 0.8) : H * (0.15 + 0.35 * i);
      ents.push(R(hx + out * 0.25, y - 0.6, hx, y + 0.6));
    }
    // handle / latch on the free edge
    const lx = hinge === 'LEFT' ? W - f - 0.9 : f + 0.9;
    ents.push(R(lx - 0.3, H / 2 - 1.2, lx + 0.3, H / 2 + 1.2));
    // door swing below the enclosure (clearance in front of it)
    const swing = { linetype: 'HIDDEN' } as Partial<Entity>;
    if (hinge === 'LEFT') ents.push(A(0, 0, W, 270, 360, swing), L(0, 0, 0, -W, swing));
    else ents.push(A(W, 0, W, 180, 270, swing), L(W, 0, W, -W, swing));
  }
  const desc = `Enclosure ${size.height} x ${size.width}${size.depth ? ` x ${size.depth}` : ''} in (H x W${size.depth ? ' x D' : ''})`;
  const attributes: AttributeDef[] = [
    { tag: 'P_TAG1', prompt: 'Enclosure tag', default: '', position: { x: 0, y: H + 0.15 }, height: 0.25, align: 'left' },
    inv('P_HW', 'ENCLOSURE', H - 0.3),
    inv('P_TYPE', size.label, H - 0.4),
    inv('P_HINGE', hinge, H - 0.5),
    inv('P_PLATE', `${r3(plate.width)}x${r3(plate.height)}`, H - 0.6),
    inv('P_CAT', cat, H - 0.7),
    inv('P_MFG', '', H - 0.8),
    inv('P_DESC1', desc, H - 0.9),
  ];
  return { name: enclosureBlockName(size, hinge), description: desc, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

export function makeEnclosure(size: EnclosureSize, hinge: DoorHinge, corner: Point, tag = '', cat = ''): { block: BlockDef; insert: InsertEntity } {
  const block = enclosureBlock(size, hinge);
  const attrs: Record<string, string> = {};
  for (const a of block.attributes) attrs[a.tag] = a.default;
  attrs.P_CAT = cat;
  attrs.P_TAG1 = tag;
  return { block, insert: { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: block.name, position: corner, rotation: 0, scale: 1, attributes: attrs } };
}

// ------------------------------------------------------------ mounting plate grid

export const plateGridBlockName = (w: number, h: number, spacing: number): string => `${HARDWARE_BLOCK_PREFIX}PLATE_${lengthKey(w)}X${lengthKey(h)}_S${lengthKey(spacing)}`;

/**
 * Mounting plate with a layout grid: plate outline and grid lines every `spacing` inches
 * (colour 8, the plate edge in the drawing colour); base point at the lower-left corner.
 */
export function plateGridBlock(width: number, height: number, spacing: number): BlockDef {
  const ents: Entity[] = [R(0, 0, width, height)];
  const grid = { color: 8 } as Partial<Entity>;
  const s = Math.max(0.125, spacing);
  for (let x = s; x < width - 1e-6; x += s) ents.push(L(x, 0, x, height, grid));
  for (let y = s; y < height - 1e-6; y += s) ents.push(L(0, y, width, y, grid));
  const desc = `Mounting plate ${r3(width)} x ${r3(height)} in, grid ${r3(s)} in`;
  const attributes: AttributeDef[] = [inv('P_HW', 'PLATE', height - 0.1), inv('P_TYPE', `${r3(width)}x${r3(height)}`, height - 0.2), inv('P_GRID', r3(s).toFixed(3), height - 0.3), inv('P_CAT', '', height - 0.4), inv('P_DESC1', desc, height - 0.5)];
  return { name: plateGridBlockName(width, height, s), description: desc, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

export function makePlateGrid(corner: Point, width: number, height: number, spacing: number): { block: BlockDef; insert: InsertEntity } {
  const block = plateGridBlock(width, height, spacing);
  const attrs: Record<string, string> = {};
  for (const a of block.attributes) attrs[a.tag] = a.default;
  return { block, insert: { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: block.name, position: corner, rotation: 0, scale: 1, attributes: attrs } };
}

// ------------------------------------------------------------ hardware rows (panel BOM hook)

export interface PanelHardwareRow {
  /** P_HW value. */
  kind: HardwareKind;
  /** Human label: DIN rail, Wire duct, Enclosure, Mounting plate. */
  label: string;
  /** Rail type (TS35), duct size (2x3), enclosure size (24x20x8), plate size. */
  type: string;
  mfg: string;
  cat: string;
  /** Number of pieces. */
  qty: number;
  /** Total length in drawing units (inches) for rails and duct; 0 for per-piece items. */
  length: number;
  /** Total length in millimetres (0 for per-piece items). */
  lengthMm: number;
  description: string;
}

const KIND_ORDER: HardwareKind[] = ['ENCLOSURE', 'PLATE', 'DINRAIL', 'DUCT'];

/**
 * Panel hardware bill of material: one row per kind / type / part number with the piece
 * count and, for DIN rail and wire duct, the total cut length (the P_LENGTH attributes of
 * the pieces). Report hook: `reports.ts` can turn these rows into a report (see
 * `panelHardwareReport`) or append them to the panel BOM.
 */
export function panelHardwareRows(doc: { entities: readonly Entity[] }): PanelHardwareRow[] {
  const map = new Map<string, PanelHardwareRow>();
  for (const e of doc.entities) {
    if (!isHardware(e)) continue;
    const kind = e.attributes.P_HW as HardwareKind;
    if (!KIND_ORDER.includes(kind)) continue;
    const type = e.attributes.P_TYPE ?? '';
    const cat = e.attributes.P_CAT ?? '';
    const mfg = e.attributes.P_MFG ?? '';
    const key = `${kind}|${type}|${mfg}|${cat}`;
    const len = kind === 'DINRAIL' || kind === 'DUCT' ? parseFloat(e.attributes.P_LENGTH ?? '0') || 0 : 0;
    const row = map.get(key) ?? { kind, label: HARDWARE_LABEL[kind], type, mfg, cat, qty: 0, length: 0, lengthMm: 0, description: '' };
    row.qty += 1;
    row.length = r3(row.length + len);
    row.lengthMm = Math.round(row.length * MM_PER_IN * 10) / 10;
    row.description =
      kind === 'DINRAIL' ? railSpec(type).description : kind === 'DUCT' ? `Wire duct ${type.replace('x', ' x ')} in` : (e.attributes.P_DESC1 ?? HARDWARE_LABEL[kind]).replace(/, [\d.]+ in \([\d.]+ mm\)$/, '');
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.type.localeCompare(b.type, undefined, { numeric: true }) || a.cat.localeCompare(b.cat));
}

/** The hardware rows as a report table (same shape as reports.ts `Report`). */
export function panelHardwareReport(doc: { entities: readonly Entity[] }): { title: string; columns: string[]; rows: string[][] } {
  const rows = panelHardwareRows(doc).map((r) => [r.label, r.type, r.description, r.mfg, r.cat, String(r.qty), r.length ? r.length.toFixed(3) : '', r.lengthMm ? r.lengthMm.toFixed(1) : '']);
  return { title: 'Panel Hardware', columns: ['Item', 'Type / Size', 'Description', 'Manufacturer', 'Catalog', 'Qty', 'Length (in)', 'Length (mm)'], rows };
}

// ------------------------------------------------------------ terminal strip footprint

export interface TerminalStripFootprintOptions {
  /** Width of one terminal along the rail (default 5.2 mm, a 2.5 mm² feed-through terminal). */
  termWidth?: number;
  /** Terminal height across the rail (default 42.5 mm). */
  termHeight?: number;
  /** End stop (clamp) width at each end (default 9.5 mm). */
  endStop?: number;
  /** Bridged terminal pairs (terminal numbers); a jumper bar is drawn for each pair. */
  jumpers?: Array<[string, string]>;
}

const safeName = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9_-]/g, '_') || 'TB';
export const terminalStripBlockName = (strip: string): string => `WD_FP_TSTRIP_${safeName(strip)}`;

/** Terminal numbers of one strip in table order, each once (a terminal shown on several sheets is one terminal). */
export function stripTerminals(rows: ReadonlyArray<{ strip: string; number: string }>, strip: string): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.strip === strip && r.number && !out.includes(r.number)) out.push(r.number);
  return out;
}

/**
 * Terminal strip footprint: the terminals of a strip side by side along the rail (base point
 * at the strip centre on the rail centre line), each with its number, an end stop at both
 * ends, an end plate after the last terminal and optional jumper bars. Attributes follow the
 * other footprints (P_TAG1 = strip, P_ITEM, P_DESC1-2, P_MFG, P_CAT, P_FAMILY = TB).
 */
export function terminalStripFootprint(strip: string, numbers: readonly string[], opts: TerminalStripFootprintOptions = {}): BlockDef {
  const tw = opts.termWidth ?? mm(5.2);
  const th = opts.termHeight ?? mm(42.5);
  const es = opts.endStop ?? mm(9.5);
  const plate = mm(1.5);
  const n = numbers.length;
  const total = 2 * es + n * tw + plate;
  const x0 = -total / 2;
  const ents: Entity[] = [];
  // end stops (lower and narrower than the terminals)
  const esh = th * 0.7;
  ents.push(R(x0, -esh / 2, x0 + es, esh / 2), L(x0, 0, x0 + es, 0));
  ents.push(R(x0 + total - es, -esh / 2, x0 + total, esh / 2), L(x0 + total - es, 0, x0 + total, 0));
  const cx: number[] = [];
  numbers.forEach((num, i) => {
    const a = x0 + es + i * tw;
    ents.push(R(a, -th / 2, a + tw, th / 2));
    // wire entry marks at both ends and the number in the middle
    ents.push(L(a + tw * 0.2, th / 2 - 0.12, a + tw * 0.8, th / 2 - 0.12), L(a + tw * 0.2, -th / 2 + 0.12, a + tw * 0.8, -th / 2 + 0.12));
    const h = Math.min(0.08, tw * 0.55);
    // the number reads along the terminal, between the rail slots and the web edge
    ents.push(T(a + tw / 2 + h / 2 - 0.005, 0.3, num, h, Math.PI / 2, 'center'));
    cx.push(a + tw / 2);
  });
  // end plate after the last terminal
  const ep = x0 + es + n * tw;
  ents.push(R(ep, -th / 2, ep + plate, th / 2));
  // jumper bars: a line between the bridged terminals with a pin dot at each, stacked when they overlap
  const levels: Array<Array<[number, number]>> = [];
  for (const [p, q] of opts.jumpers ?? []) {
    const i = numbers.indexOf(p);
    const j = numbers.indexOf(q);
    if (i < 0 || j < 0 || i === j) continue;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    let lvl = levels.findIndex((spans) => spans.every(([s, e]) => hi < s || lo > e));
    if (lvl < 0) {
      levels.push([]);
      lvl = levels.length - 1;
    }
    levels[lvl]!.push([lo, hi]);
    const y = -0.28 - lvl * 0.1;
    ents.push(L(cx[lo]!, y, cx[hi]!, y));
    for (let k = lo; k <= hi; k += 1) ents.push({ ...base, id: newId(), type: 'circle', center: { x: cx[k]!, y }, radius: 0.025, filled: true } as Entity);
  }
  const hInv = (tag: string, y: number): AttributeDef => ({ tag, prompt: tag, default: '', position: { x: 0, y }, height: 0.07, align: 'center', invisible: true });
  const bx = total / 2 + 0.22;
  const by = th / 2 + 0.22;
  ents.push({ ...base, id: newId(), type: 'circle', center: { x: bx, y: by }, radius: 0.18 } as Entity, L(total / 2, th / 2, bx - 0.13, by - 0.13));
  const attributes: AttributeDef[] = [
    { tag: 'P_TAG1', prompt: 'Strip', default: strip, position: { x: 0, y: th / 2 + 0.1 }, height: 0.12, align: 'center' },
    { tag: 'P_ITEM', prompt: 'Item', default: '', position: { x: bx, y: by - 0.045 }, height: 0.09, align: 'center' },
    { tag: 'P_DESC1', prompt: 'Description', default: `TERMINAL STRIP ${strip}`, position: { x: 0, y: -th / 2 - 0.2 }, height: 0.08, align: 'center' },
    { tag: 'P_DESC2', prompt: 'Description 2', default: `${n} TERMINAL${n === 1 ? '' : 'S'}`, position: { x: 0, y: -th / 2 - 0.33 }, height: 0.08, align: 'center' },
    hInv('P_MFG', 0.1),
    hInv('P_CAT', 0),
    hInv('P_INST', -0.1),
    hInv('P_LOC', -0.2),
    { ...hInv('P_FAMILY', -0.3), default: 'TB' },
    { ...hInv('P_TERMS', -0.4), default: numbers.join(',') },
  ];
  return { name: terminalStripBlockName(strip), description: `Panel footprint: terminal strip ${strip} (${n} terminals)`, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

/** Length of a terminal strip footprint along the rail (end stops, terminals, end plate). */
export function terminalStripLength(count: number, opts: TerminalStripFootprintOptions = {}): number {
  return 2 * (opts.endStop ?? mm(9.5)) + count * (opts.termWidth ?? mm(5.2)) + mm(1.5);
}

export function makeTerminalStripFootprint(block: BlockDef, at: Point, item: string): InsertEntity {
  const attrs: Record<string, string> = {};
  for (const a of block.attributes) attrs[a.tag] = a.default;
  attrs.P_ITEM = item;
  return { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: block.name, position: at, rotation: 0, scale: 1, attributes: attrs };
}

// ------------------------------------------------------------ footprint alignment

export interface RailAxis {
  start: Point;
  /** Unit direction along the rail. */
  dir: Point;
  length: number;
}

/** Axis of a rail (or duct) insert: start point, direction and length. */
export function railAxis(rail: InsertEntity): RailAxis {
  const length = parseFloat(rail.attributes.P_LENGTH ?? '0') || 0;
  return { start: rail.position, dir: { x: Math.cos(rail.rotation), y: Math.sin(rail.rotation) }, length };
}

/**
 * The DIN rail under a point: the point lies on the rail band (its length and width, plus
 * `tol`), so a pick anywhere on the rail finds it, not only on its drawn lines. The nearest
 * rail centre line wins when rails overlap.
 */
export function railAt(entities: readonly Entity[], p: Point, tol = 0): InsertEntity | null {
  let best: InsertEntity | null = null;
  let bestD = Infinity;
  for (const e of entities) {
    if (!isHardware(e) || e.attributes.P_HW !== 'DINRAIL') continue;
    const ax = railAxis(e);
    const dx = p.x - ax.start.x;
    const dy = p.y - ax.start.y;
    const along = dx * ax.dir.x + dy * ax.dir.y;
    const across = Math.abs(-dx * ax.dir.y + dy * ax.dir.x);
    const half = (railSpec(e.attributes.P_TYPE ?? 'TS35').width * e.scale) / 2;
    if (along < -tol || along > ax.length * e.scale + tol || across > half + tol) continue;
    if (across < bestD) {
      bestD = across;
      best = e;
    }
  }
  return best;
}

export interface AlignItem {
  id: string;
  /** Current position (base point = centre of the footprint). */
  position: Point;
  /** Size along the rail. */
  size: number;
}

/** Margin kept free at each rail end when aligning footprints (end stops). */
export const RAIL_END_MARGIN = 0.25;

/**
 * New centre points for footprints mounted on a rail: kept in their current order along the
 * rail, centred on the rail centre line, starting RAIL_END_MARGIN from the rail start with
 * `gap` between neighbours, or spread evenly over the rail when `gap` is 'even'. `overflow`
 * is how far the row runs past the usable rail length (0 when it fits).
 */
export function alignOnRail(items: readonly AlignItem[], axis: RailAxis, gap: number | 'even'): { positions: Map<string, Point>; overflow: number; gap: number } {
  const along = (p: Point) => (p.x - axis.start.x) * axis.dir.x + (p.y - axis.start.y) * axis.dir.y;
  const sorted = [...items].sort((a, b) => along(a.position) - along(b.position));
  const usable = axis.length - 2 * RAIL_END_MARGIN;
  const sum = sorted.reduce((s, i) => s + i.size, 0);
  let g = gap === 'even' ? (sorted.length > 1 ? (usable - sum) / (sorted.length - 1) : 0) : gap;
  if (gap === 'even' && g < 0) g = 0;
  const run = sum + g * Math.max(0, sorted.length - 1);
  let t = gap === 'even' && sorted.length === 1 ? axis.length / 2 - sum / 2 : RAIL_END_MARGIN;
  const positions = new Map<string, Point>();
  for (const it of sorted) {
    const c = t + it.size / 2;
    positions.set(it.id, { x: axis.start.x + axis.dir.x * c, y: axis.start.y + axis.dir.y * c });
    t += it.size + g;
  }
  return { positions, overflow: Math.max(0, r3(run - usable)), gap: r3(g) };
}
