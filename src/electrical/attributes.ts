/**
 * AutoCAD Electrical-style component data model.
 *
 * Every schematic symbol carries the standard ACADE attribute set so an
 * exported DXF holds the same data an ACADE drawing would: TAG1, DESC1-3,
 * INST, LOC, MFG, CAT, ASSYCODE, RATING1-2, WDTYPE and the invisible
 * X?TERMnn wire-connection attributes (X1 = wire from the left, X2 = top,
 * X4 = right, X8 = bottom; the value is the pin number).
 */
import type { AttributeDef, BlockDef, Entity, InsertEntity } from '../core/entities';
import { similarityTransform, entityBounds } from '../core/entities';
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';

/** Half width of an inline symbol: stubs end at x = +-HALF. */
export const SYMBOL_HALF = 0.375;

/** Attribute tags treated as component data (order used by dialogs and reports). */
export const DATA_ATTRIBUTES = ['INST', 'LOC', 'DESC2', 'DESC3', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'RATING2', 'WDTYPE'] as const;
export type DataAttribute = (typeof DATA_ATTRIBUTES)[number];

export interface ConnectionPoint {
  /** ACADE direction code: 1 left, 2 top, 4 right, 8 bottom. */
  dir: 1 | 2 | 4 | 8;
  point: Point;
  /** Pin index (1-based) used to build the attribute tag X?TERMnn. */
  index: number;
  tag: string;
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

/** ACADE direction code of a connection: 1 left, 2 top, 4 right, 8 bottom. */
export type ConnectionDir = 1 | 2 | 4 | 8;

/** Unit vector a connection faces (block space): the side of the symbol box the wire comes from. */
export function connectionVector(dir: ConnectionDir): Point {
  return dir === 1 ? { x: -1, y: 0 } : dir === 4 ? { x: 1, y: 0 } : dir === 2 ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

/** Direction code of a unit-ish vector (world space): the side it points to. */
export function connectionDirOf(v: Point): ConnectionDir {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x < 0 ? 1 : 4;
  return v.y > 0 ? 2 : 8;
}

/** Direction code of a pin attribute tag (X1TERM01 -> 1), or null. */
export function pinDir(tag: string): ConnectionDir | null {
  const m = /^X([1248])TERM\d+$/.exec(tag);
  return m ? (parseInt(m[1]!, 10) as ConnectionDir) : null;
}

/**
 * Wire-connection points of a symbol, derived from its geometry: line
 * endpoints on the symbol edge (x = +-HALF for a horizontal symbol, y = +-HALF
 * on the symbol axis for a vertical one) or, for symbols with a single
 * vertical connection (ground), the base point.
 */
export function connectionPoints(block: BlockDef): ConnectionPoint[] {
  const pts: Array<{ dir: ConnectionDir; point: Point }> = [];
  const seen = new Set<string>();
  const push = (dir: ConnectionDir, p: Point) => {
    const key = `${dir}:${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pts.push({ dir, point: p });
  };
  for (const e of block.entities) {
    if (e.type !== 'line') continue;
    for (const p of [e.a, e.b]) {
      if (near(p.x, -SYMBOL_HALF)) push(1, p);
      else if (near(p.x, SYMBOL_HALF)) push(4, p);
      // Vertical symbols (VPB11 style): stubs on the axis reach the top / bottom of the box.
      else if (near(p.x, 0) && near(p.y, SYMBOL_HALF)) push(2, p);
      else if (near(p.x, 0) && near(p.y, -SYMBOL_HALF)) push(8, p);
    }
  }
  if (pts.length === 0) {
    // Vertical-only symbols (ground): the base point is the connection.
    const top = block.entities.find((e) => e.type === 'line' && near(e.a.x, 0) && near(e.b.x, 0));
    if (top) push(2, { x: 0, y: Math.max((top as Extract<Entity, { type: 'line' }>).a.y, (top as Extract<Entity, { type: 'line' }>).b.y) });
  }
  // Order: top-to-bottom, left before right, so pin 1 is the upper-left connection.
  pts.sort((a, b) => b.point.y - a.point.y || a.dir - b.dir);
  return pts.map((p, i) => ({ ...p, index: i + 1, tag: `X${p.dir}TERM${String(i + 1).padStart(2, '0')}` }));
}

/** Family (tag prefix) from a block name, mirrors symbols.tagPrefix but usable before the library loads. */
export type FamilyLookup = (blockName: string) => string;

/** Default pin numbers per family, like the ACADE symbol library defaults. */
export function defaultPins(family: string, block: string): string[] {
  if (/_NC$/.test(block)) return ['11', '12'];
  if (/_NO$/.test(block)) return ['13', '14'];
  switch (family) {
    case 'CR':
    case 'TD':
    case 'M':
    case 'K':
    case 'KM':
    case 'KT':
    case 'SOL':
    case 'SV':
    case 'Y':
      return ['A1', 'A2'];
    case 'LT':
    case 'P':
      return ['X1', 'X2'];
    case 'T':
      return ['H1', 'H2', 'X1', 'X2'];
    case 'PB':
    case 'S':
      return ['3', '4'];
    default:
      return ['1', '2'];
  }
}

/** Build the invisible ACADE attribute set for a symbol (data + wire connection attributes). */
export function acadeAttributes(block: BlockDef, family: string, wdtype?: string): AttributeDef[] {
  const existing = new Set(block.attributes.map((a) => a.tag));
  const out: AttributeDef[] = [];
  const inv = (tag: string, x: number, y: number, def = ''): AttributeDef => ({ tag, prompt: tag, default: def, position: { x, y }, height: 0.07, align: 'center', invisible: true });
  const tagAttr = block.attributes.find((a) => a.tag === 'TAG1');
  const descAttr = block.attributes.find((a) => a.tag === 'DESC1');
  if (tagAttr || descAttr || existing.has('TERM01')) {
    // Visible description lines 2 and 3 stack under DESC1 (empty by default, so nothing shows).
    if (descAttr) {
      if (!existing.has('DESC2')) out.push({ ...descAttr, tag: 'DESC2', prompt: 'Description line 2', default: '', position: { x: descAttr.position.x, y: descAttr.position.y - 0.13 } });
      if (!existing.has('DESC3')) out.push({ ...descAttr, tag: 'DESC3', prompt: 'Description line 3', default: '', position: { x: descAttr.position.x, y: descAttr.position.y - 0.26 } });
    }
    const top = tagAttr ? tagAttr.position.y + 0.15 : 0.45;
    for (const t of DATA_ATTRIBUTES) {
      if (existing.has(t) || t === 'DESC2' || t === 'DESC3') continue;
      const i = DATA_ATTRIBUTES.indexOf(t);
      out.push(inv(t, -0.3 + (i % 4) * 0.2, top + Math.floor(i / 4) * 0.1, t === 'WDTYPE' ? wdType(block.name, family, wdtype) : ''));
    }
    if (existing.has('TERM01') && !existing.has('TAGSTRIP')) out.push(inv('TAGSTRIP', 0, -0.15, ''));
  }
  const pins = defaultPins(family, block.name);
  connectionPoints(block).forEach((c, i) => {
    if (existing.has(c.tag)) return;
    out.push({ tag: c.tag, prompt: `Pin ${c.index}`, default: pins[i] ?? String(c.index), position: c.point, height: 0.06, align: 'center', invisible: true });
  });
  return out;
}

/** Symbol type code stored in WDTYPE. */
export function wdType(block: string, family: string, override?: string): string {
  if (override) return override;
  if (/_N[OC]$/.test(block) && /^(HCR|HTD|HKM|IEC_K|IEC_KM|IEC_KT)/.test(block)) return 'CONTACT';
  if (/^(HCR1|HTD|HKM1|IEC_K_COIL|IEC_KM_COIL|IEC_KT)/.test(block) && !/_N[OC]$/.test(block)) return 'COIL';
  if (/^(HT0|IEC_X_TERM)/.test(block)) return 'TERM';
  if (/PLC/.test(block)) return 'PLC';
  return family;
}

/** Return a copy of the block with the ACADE attribute set appended. */
export function withAcadeAttributes(block: BlockDef, family: string, wdtype?: string): BlockDef {
  const extra = acadeAttributes(block, family, wdtype);
  if (extra.length === 0) return block;
  return { ...block, attributes: [...block.attributes, ...extra] };
}

/** Whether a symbol connects only at its top / bottom (a vertical symbol: VPB11 style, or a rotated horizontal one). */
export function isVerticalBlock(block: BlockDef): boolean {
  const dirs = block.attributes.map((a) => pinDir(a.tag)).filter((d): d is ConnectionDir => d !== null);
  return dirs.length > 0 && dirs.every((d) => d === 2 || d === 8);
}

/** Name of the vertical twin of a horizontal symbol: HPB11_NO -> VPB11_NO, IEC_S_PB_NO -> IEC_S_PB_NO_V. */
export function verticalVariantName(name: string): string {
  return /^H[A-Z0-9]/.test(name) && !name.startsWith('H_') ? `V${name.slice(1)}` : `${name}_V`;
}

/**
 * Build the vertical variant of a horizontal symbol the way AutoCAD Electrical
 * ships V-prefixed twins of its H symbols: the geometry is rotated -90 degrees
 * about the base point (the left connection ends up on top), the wire connection
 * attributes are re-coded (X1 -> X2, X4 -> X8, X2 -> X4, X8 -> X1) and renumbered
 * top to bottom keeping their pin defaults, and the visible attributes stay
 * horizontal: TAG1 and the description lines sit to the right of the symbol.
 */
export function verticalVariant(block: BlockDef, name = verticalVariantName(block.name)): BlockDef {
  const angle = -Math.PI / 2;
  const tf = (p: Point) => g.add(block.basePoint, g.rotate(g.sub(p, block.basePoint), angle));
  const entities = block.entities.map((e) => similarityTransform(e, tf, angle, 1));
  let bounds: g.Bounds | null = null;
  for (const e of entities) bounds = g.unionBounds(bounds, entityBounds(e, () => undefined));
  const right = (bounds?.max.x ?? 0.2) + 0.08;
  const remap: Record<ConnectionDir, ConnectionDir> = { 1: 2, 4: 8, 2: 4, 8: 1 };
  const pins = block.attributes
    .map((a) => ({ a, dir: pinDir(a.tag) }))
    .filter((x): x is { a: AttributeDef; dir: ConnectionDir } => x.dir !== null)
    .map(({ a, dir }) => ({ a, dir: remap[dir], point: tf(a.position) }))
    .sort((p, q) => q.point.y - p.point.y || p.dir - q.dir);
  const attributes: AttributeDef[] = [];
  for (const a of block.attributes) {
    if (pinDir(a.tag) !== null) continue;
    const { rotation: _r, ...rest } = a;
    void _r;
    if (a.invisible) {
      attributes.push({ ...rest, position: tf(a.position) });
      continue;
    }
    // Readable text beside the vertical symbol (ACADE puts TAG1 to the upper right, DESC1-3 under it).
    const row = a.tag === 'TAG1' ? 0.02 : a.tag === 'DESC1' ? -0.14 : a.tag === 'DESC2' ? -0.27 : a.tag === 'DESC3' ? -0.4 : a.tag === 'TERM01' ? -0.06 : null;
    attributes.push(row === null ? { ...rest, position: tf(a.position) } : { ...rest, position: { x: block.basePoint.x + right, y: block.basePoint.y + row }, align: 'left' });
  }
  pins.forEach((p, i) => attributes.push({ ...p.a, tag: `X${p.dir}TERM${String(i + 1).padStart(2, '0')}`, prompt: `Pin ${i + 1}`, position: p.point }));
  return { ...block, name, entities, attributes, description: block.description ? `${block.description} (vertical)` : undefined };
}

/** Pin attribute tags of an insert's block, in pin order. */
export function pinAttributes(block: BlockDef): AttributeDef[] {
  return block.attributes.filter((a) => /^X[1248]TERM\d+$/.test(a.tag)).sort((a, b) => a.tag.slice(6).localeCompare(b.tag.slice(6)));
}

/** Component data read from an insert with defaults from its block. */
export function componentData(ins: InsertEntity, block: BlockDef | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (block) for (const a of block.attributes) out[a.tag] = ins.attributes[a.tag] ?? a.default;
  for (const [k, v] of Object.entries(ins.attributes)) out[k] = v;
  return out;
}

/** Description lines joined for reports. */
export function descriptionOf(attrs: Readonly<Record<string, string>>): string {
  return [attrs.DESC1, attrs.DESC2, attrs.DESC3].filter((s) => s && s.trim()).join(' ');
}

/** Full ACADE-style location prefix, e.g. "+MCC1-PNL1". */
export function instLoc(attrs: Readonly<Record<string, string>>): string {
  const inst = attrs.INST?.trim();
  const loc = attrs.LOC?.trim();
  return `${inst ? `+${inst}` : ''}${loc ? `-${loc}` : ''}`;
}
