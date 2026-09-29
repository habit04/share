/**
 * Panel layout: footprints (rectangles sized per family, with a tag, an
 * item balloon and a nameplate description) inserted from the schematic
 * component list, plus balloons, nameplates and the terminal strip table.
 * Footprints are blocks WD_FP_<family> with attributes P_TAG1, P_ITEM,
 * P_DESC1-2 (visible) and P_MFG, P_CAT, P_INST, P_LOC (invisible).
 */
import type { Point } from '../core/geometry';
import type { Entity, BlockDef, InsertEntity, LineEntity, AttributeDef, BlockLookup } from '../core/entities';
import { newId, entityBounds } from '../core/entities';
import { isParentComponent, isTerminal, isFootprint, isComponent } from './families';
import { tagPrefix } from './symbols';
import { descriptionOf } from './attributes';
import { isWire, isHorizontal, nearestReference } from './ladder';
import { collectNets, netOfWireNumber, isWireNumber, symbolSpan } from './wires';
import { terminalStripFootprint, terminalStripLength, stripTerminals, type TerminalStripFootprintOptions } from './panel-hardware';

// Panel hardware (DIN rail, duct, enclosure, plate grid) and its BOM hook live in panel-hardware.ts.
export { panelHardwareRows, panelHardwareReport, type PanelHardwareRow } from './panel-hardware';

export interface FootprintSpec {
  family: string;
  width: number;
  height: number;
  description: string;
}

/** Generic footprint sizes (inches) per family; anything else gets a 1 x 1 square. */
export const FOOTPRINTS: FootprintSpec[] = [
  { family: 'PB', width: 0.9, height: 0.9, description: '22 mm operator' },
  { family: 'SS', width: 0.9, height: 0.9, description: '22 mm selector' },
  { family: 'LT', width: 0.9, height: 0.9, description: '22 mm pilot light' },
  { family: 'SW', width: 0.8, height: 1.2, description: 'Toggle switch' },
  { family: 'CR', width: 1.2, height: 1.6, description: 'Relay + socket' },
  { family: 'TD', width: 1.2, height: 2.0, description: 'Timer relay + socket' },
  { family: 'M', width: 1.8, height: 2.8, description: 'Contactor' },
  { family: 'OL', width: 1.8, height: 2.2, description: 'Overload relay' },
  { family: 'FU', width: 0.6, height: 1.6, description: 'Fuse holder' },
  { family: 'CB', width: 0.7, height: 2.4, description: 'Circuit breaker' },
  { family: 'DS', width: 2.4, height: 3.2, description: 'Disconnect switch' },
  { family: 'T', width: 3.0, height: 3.0, description: 'Control transformer' },
  { family: 'PS', width: 1.6, height: 3.6, description: 'Power supply' },
  { family: 'TB', width: 0.25, height: 0.6, description: 'Terminal block' },
  { family: 'PLC', width: 3.6, height: 5.0, description: 'PLC module' },
  { family: 'SOL', width: 1.0, height: 1.5, description: 'Solenoid' },
  { family: 'SV', width: 1.2, height: 1.8, description: 'Solenoid valve' },
  { family: 'HN', width: 1.2, height: 1.2, description: 'Horn' },
  { family: 'BZ', width: 0.9, height: 0.9, description: 'Buzzer' },
  { family: 'MTR', width: 3.0, height: 3.0, description: 'Motor (field)' },
  { family: 'HTR', width: 2.0, height: 1.0, description: 'Heater' },
  { family: 'RCPT', width: 1.1, height: 1.9, description: 'Receptacle' },
  { family: 'VM', width: 2.8, height: 2.8, description: 'Panel meter 72 mm' },
  { family: 'AM', width: 2.8, height: 2.8, description: 'Panel meter 72 mm' },
];

const IEC_TO_JIC: Record<string, string> = { S: 'PB', K: 'CR', KM: 'M', KT: 'TD', Q: 'CB', F: 'FU', P: 'LT', X: 'TB', Y: 'SV', G: 'BT', E: 'HTR' };

export function footprintSpec(family: string): FootprintSpec {
  const f = IEC_TO_JIC[family] ?? family;
  return FOOTPRINTS.find((s) => s.family === f) ?? { family: f, width: 1, height: 1, description: 'Generic device' };
}

const L = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });

/** Footprint block for a family: rectangle with mounting holes, balloon circle, tag and description attributes. */
export function footprintBlock(family: string): BlockDef {
  const s = footprintSpec(family);
  const w = s.width;
  const h = s.height;
  const ents: Entity[] = [{ id: newId(), layer: '0', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }] }];
  if (w >= 0.6 && h >= 0.6) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) ents.push({ id: newId(), layer: '0', color: 'ByLayer', type: 'circle', center: { x: sx * (w / 2 - 0.1), y: sy * (h / 2 - 0.1) }, radius: 0.04 });
  }
  const bx = w / 2 + 0.22;
  const by = h / 2 + 0.22;
  ents.push({ id: newId(), layer: '0', color: 'ByLayer', type: 'circle', center: { x: bx, y: by }, radius: 0.18 }, L(w / 2, h / 2, bx - 0.13, by - 0.13));
  const inv = (tag: string, y: number): AttributeDef => ({ tag, prompt: tag, default: '', position: { x: 0, y }, height: 0.07, align: 'center', invisible: true });
  const attributes: AttributeDef[] = [
    { tag: 'P_TAG1', prompt: 'Tag', default: '', position: { x: 0, y: h / 2 + 0.1 }, height: 0.12, align: 'center' },
    { tag: 'P_ITEM', prompt: 'Item', default: '', position: { x: bx, y: by - 0.045 }, height: 0.09, align: 'center' },
    { tag: 'P_DESC1', prompt: 'Description', default: '', position: { x: 0, y: -h / 2 - 0.2 }, height: 0.08, align: 'center' },
    { tag: 'P_DESC2', prompt: 'Description 2', default: '', position: { x: 0, y: -h / 2 - 0.33 }, height: 0.08, align: 'center' },
    inv('P_MFG', 0.1),
    inv('P_CAT', 0),
    inv('P_INST', -0.1),
    inv('P_LOC', -0.2),
    inv('P_FAMILY', -0.3),
  ];
  return { name: `WD_FP_${s.family}`, description: `Panel footprint: ${s.description}`, basePoint: { x: 0, y: 0 }, entities: ents, attributes };
}

export const BALLOON_BLOCK: BlockDef = {
  name: 'WD_BALLOON',
  description: 'Item number balloon',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'bal1', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0 }, radius: 0.2 }],
  attributes: [{ tag: 'ITEM', prompt: 'Item number', default: '', position: { x: 0, y: -0.05 }, height: 0.1, align: 'center' }],
};

export const NAMEPLATE_BLOCK: BlockDef = {
  name: 'WD_NAMEPLATE',
  description: 'Nameplate (legend plate)',
  basePoint: { x: 0, y: 0 },
  entities: [
    { id: 'np1', layer: '0', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: -0.9, y: -0.25 }, { x: 0.9, y: -0.25 }, { x: 0.9, y: 0.25 }, { x: -0.9, y: 0.25 }] },
    { id: 'np2', layer: '0', color: 'ByLayer', type: 'circle', center: { x: -0.8, y: 0 }, radius: 0.03 },
    { id: 'np3', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0.8, y: 0 }, radius: 0.03 },
  ],
  attributes: [
    { tag: 'NP_DESC1', prompt: 'Line 1', default: '', position: { x: 0, y: 0.03 }, height: 0.1, align: 'center' },
    { tag: 'NP_DESC2', prompt: 'Line 2', default: '', position: { x: 0, y: -0.14 }, height: 0.08, align: 'center' },
    { tag: 'NP_TAG1', prompt: 'Tag', default: '', position: { x: 0, y: 0.3 }, height: 0.07, align: 'center', invisible: true },
  ],
};

export interface SchematicListRow {
  tag: string;
  family: string;
  block: string;
  desc: string;
  mfg: string;
  cat: string;
  inst: string;
  loc: string;
  drawing: string;
  ref: string;
  placed: boolean;
}

/** Schematic components (parents + terminals) across the given drawings with their panel placement status. */
export function schematicList(sources: Array<{ name: string; entities: readonly Entity[] }>, panel: readonly Entity[]): SchematicListRow[] {
  const placed = new Set(panel.filter(isFootprint).map((e) => e.attributes.P_TAG1 ?? ''));
  const rows: SchematicListRow[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    const doc = { entities: src.entities } as { entities: readonly Entity[] };
    for (const e of src.entities) {
      if (!(isParentComponent(e) || isTerminal(e))) continue;
      const tag = e.attributes.TAG1 ?? `${e.attributes.TAGSTRIP ?? 'TB'}:${e.attributes.TERM01 ?? ''}`;
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      rows.push({
        tag,
        family: tagPrefix(e.block),
        block: e.block,
        desc: descriptionOf(e.attributes),
        mfg: e.attributes.MFG ?? '',
        cat: e.attributes.CAT ?? '',
        inst: e.attributes.INST ?? '',
        loc: e.attributes.LOC ?? '',
        drawing: src.name,
        ref: nearestReference(doc, e.position) ?? '',
        placed: placed.has(tag),
      });
    }
  }
  return rows.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Next unused item (balloon) number in a panel drawing. */
export function nextItemNumber(entities: readonly Entity[]): number {
  let max = 0;
  for (const e of entities) {
    if (e.type !== 'insert') continue;
    const v = parseInt(e.attributes.P_ITEM ?? e.attributes.ITEM ?? '', 10);
    if (Number.isFinite(v)) max = Math.max(max, v);
  }
  return max + 1;
}

/** Existing item number for a tag in the panel (footprint or balloon), so re-inserting keeps it. */
export function itemNumberFor(entities: readonly Entity[], tag: string): string | null {
  for (const e of entities) if (isFootprint(e) && e.attributes.P_TAG1 === tag && e.attributes.P_ITEM) return e.attributes.P_ITEM;
  return null;
}

export function makeFootprint(row: Pick<SchematicListRow, 'tag' | 'family' | 'desc' | 'mfg' | 'cat' | 'inst' | 'loc'>, pos: Point, item: string): InsertEntity {
  const spec = footprintSpec(row.family);
  const [d1, d2] = splitDescription(row.desc);
  return {
    id: newId(),
    layer: 'PANEL',
    color: 'ByLayer',
    type: 'insert',
    block: `WD_FP_${spec.family}`,
    position: pos,
    rotation: 0,
    scale: 1,
    attributes: { P_TAG1: row.tag, P_ITEM: item, P_DESC1: d1, P_DESC2: d2, P_MFG: row.mfg, P_CAT: row.cat, P_INST: row.inst, P_LOC: row.loc, P_FAMILY: row.family },
  };
}

/** Split a long description into two nameplate lines at a word boundary. */
export function splitDescription(desc: string, max = 18): [string, string] {
  const d = desc.trim();
  if (d.length <= max) return [d, ''];
  const cut = d.lastIndexOf(' ', max);
  if (cut <= 0) return [d.slice(0, max), d.slice(max).trim()];
  return [d.slice(0, cut), d.slice(cut + 1)];
}

/** A balloon with a leader from the footprint edge. */
export function makeBalloon(target: InsertEntity, at: Point, item: string, lookup: BlockLookup): Entity[] {
  const b = entityBounds(target, lookup);
  const edge = b ? { x: Math.max(b.min.x, Math.min(b.max.x, at.x)), y: Math.max(b.min.y, Math.min(b.max.y, at.y)) } : target.position;
  const ins: InsertEntity = { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: BALLOON_BLOCK.name, position: at, rotation: 0, scale: 1, attributes: { ITEM: item } };
  const leader: LineEntity = { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'line', a: edge, b: at };
  return [leader, ins];
}

export function makeNameplate(at: Point, tag: string, desc: string): InsertEntity {
  const [d1, d2] = splitDescription(desc, 20);
  return { id: newId(), layer: 'PANEL', color: 'ByLayer', type: 'insert', block: NAMEPLATE_BLOCK.name, position: at, rotation: 0, scale: 1, attributes: { NP_DESC1: d1, NP_DESC2: d2, NP_TAG1: tag } };
}

/** Panel footprint report rows. */
export function panelRows(entities: readonly Entity[]): Array<{ item: string; tag: string; desc: string; mfg: string; cat: string; loc: string; block: string }> {
  return entities
    .filter(isFootprint)
    .map((e) => ({ item: e.attributes.P_ITEM ?? '', tag: e.attributes.P_TAG1 ?? '', desc: [e.attributes.P_DESC1, e.attributes.P_DESC2].filter(Boolean).join(' '), mfg: e.attributes.P_MFG ?? '', cat: e.attributes.P_CAT ?? '', loc: `${e.attributes.P_INST ? `+${e.attributes.P_INST}` : ''}${e.attributes.P_LOC ? `-${e.attributes.P_LOC}` : ''}`, block: e.block }))
    .sort((a, b) => parseInt(a.item || '0', 10) - parseInt(b.item || '0', 10) || a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

// ------------------------------------------------------------ terminal strip

export interface TerminalRow {
  id: string;
  strip: string;
  number: string;
  leftWire: string;
  leftDevice: string;
  rightWire: string;
  rightDevice: string;
  ref: string;
}

/** Terminal strip table: each schematic terminal with the wire numbers and devices on its left and right. */
export function terminalStripTable(entities: readonly Entity[], lookup: BlockLookup): TerminalRow[] {
  const nets = collectNets(entities);
  const labels = entities.filter(isWireNumber).map((t) => ({ t, net: netOfWireNumber(nets, t) }));
  const labelOf = (net: ReturnType<typeof collectNets>[number] | null) => labels.find((l) => l.net === net)?.t.text ?? '';
  const comps = entities.filter((e): e is InsertEntity => isComponent(e) && !isTerminal(e));
  const rows: TerminalRow[] = [];
  for (const term of entities) {
    if (!isTerminal(term)) continue;
    const b = symbolSpan(term, lookup);
    const y = term.position.y;
    const side = (dir: -1 | 1): { wire: string; device: string } => {
      const edge = dir < 0 ? b.min.x : b.max.x;
      const w = entities.find((e): e is LineEntity => isWire(e) && isHorizontal(e) && Math.abs(e.a.y - y) < 0.05 && Math.abs((dir < 0 ? Math.max(e.a.x, e.b.x) : Math.min(e.a.x, e.b.x)) - edge) < 0.02);
      if (!w) return { wire: '', device: '' };
      const net = nets.find((n) => n.wires.includes(w)) ?? null;
      const far = dir < 0 ? Math.min(w.a.x, w.b.x) : Math.max(w.a.x, w.b.x);
      let device = '';
      for (const c of comps) {
        const cb = symbolSpan(c, lookup);
        if (Math.abs(c.position.y - y) > 0.2) continue;
        if (Math.abs((dir < 0 ? cb.max.x : cb.min.x) - far) < 0.02) {
          device = c.attributes.TAG1 ?? c.block;
          break;
        }
      }
      if (!device) {
        const rail = entities.find((e) => isWire(e) && !isHorizontal(e) && Math.abs(e.a.x - far) < 0.02);
        if (rail) device = dir < 0 ? 'L1' : 'L2';
      }
      return { wire: labelOf(net), device };
    };
    const l = side(-1);
    const r = side(1);
    rows.push({ id: term.id, strip: term.attributes.TAGSTRIP || 'TB1', number: term.attributes.TERM01 ?? '', leftWire: l.wire, leftDevice: l.device, rightWire: r.wire, rightDevice: r.device, ref: nearestReference({ entities }, term.position) ?? '' });
  }
  return rows.sort((a, b) => a.strip.localeCompare(b.strip, undefined, { numeric: true }) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** Replacement inserts after the strip editor changed terminal numbers / strip tags. */
export function applyTerminalEdits(entities: readonly Entity[], rows: TerminalRow[]): InsertEntity[] {
  const out: InsertEntity[] = [];
  for (const r of rows) {
    const e = entities.find((x): x is InsertEntity => x.id === r.id && x.type === 'insert');
    if (!e) continue;
    if (e.attributes.TERM01 === r.number && (e.attributes.TAGSTRIP ?? '') === r.strip) continue;
    out.push({ ...e, attributes: { ...e.attributes, TERM01: r.number, TAGSTRIP: r.strip } });
  }
  return out;
}

// ------------------------------------------------------------ terminal strip footprint

/** Strips of a terminal table, in table order. */
export function terminalStrips(rows: readonly TerminalRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (!out.includes(r.strip)) out.push(r.strip);
  return out;
}

/**
 * Panel footprint of a terminal strip built from the terminal strip table (the terminals of
 * `strip` in table order, each number once). `jumpers` (terminal-number pairs) draws the
 * jumper bars when jumper data exists.
 */
export function terminalStripFootprintFor(rows: readonly TerminalRow[], strip: string, jumpers?: Array<[string, string]>, opts: Omit<TerminalStripFootprintOptions, 'jumpers'> = {}): BlockDef {
  return terminalStripFootprint(strip, stripTerminals(rows, strip), { ...opts, ...(jumpers ? { jumpers } : {}) });
}

/** Size of a footprint's body (the mounting rectangle, without balloon and texts): width along x, height along y, unrotated. */
export function footprintSize(ins: InsertEntity): { width: number; height: number } {
  if (ins.block.startsWith('WD_FP_TSTRIP_')) {
    const n = (ins.attributes.P_TERMS ?? '').split(',').filter(Boolean).length;
    return { width: terminalStripLength(n) * ins.scale, height: (42.5 / 25.4) * ins.scale };
  }
  const s = footprintSpec(ins.attributes.P_FAMILY || ins.block.replace(/^WD_FP_/, ''));
  return { width: s.width * ins.scale, height: s.height * ins.scale };
}
