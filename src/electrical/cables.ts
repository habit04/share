/**
 * Cables and terminal jumpers (AutoCAD Electrical style).
 *
 * Cables: a wire that runs in a multi-conductor cable carries a cable marker
 * insert (block WD_CABLE) on the wire with attributes CABLENO (cable tag),
 * CONDUCTOR (conductor number or colour), CABLETYPE, WIRENO and FROM / TO
 * (tag:terminal of the devices at the wire ends), plus a LENGTH placeholder.
 * The Cable Schedule report (reports.ts) lists them per cable.
 *
 * Jumpers: an attribute-level link between two terminals of the same strip.
 * Both terminals carry the jumper id in their JUMPER attribute
 * (comma-separated when a terminal has several), so reports and the
 * Location View can pair them without any extra graphics on the schematic.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { BlockDef, BlockLookup, Entity, InsertEntity, LineEntity } from '../core/entities';
import { insertTransform, newId } from '../core/entities';
import type { DrawingState } from '../core/document';
import { isWire, isHorizontal, nearestReference } from './ladder';
import { isComponent, isTerminal } from './families';
import { pinDir, withBlockAttributes } from './attributes';
import { collectNets, symbolSpan, wireNumberMap, type WireNet } from './wires';

// ------------------------------------------------------------------ cables

export const CABLE_BLOCK_NAME = 'WD_CABLE';
export const CABLE_LAYER = 'CABLES';

/** Cable marker: a short slash across the wire with the cable tag and conductor. */
export const CABLE_BLOCK: BlockDef = {
  name: CABLE_BLOCK_NAME,
  description: 'Cable marker (conductor of a multi-conductor cable)',
  basePoint: { x: 0, y: 0 },
  entities: [
    { id: 'cab1', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.06, y: -0.1 }, b: { x: 0.06, y: 0.1 } },
    { id: 'cab2', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0 }, radius: 0.025 },
  ],
  attributes: [
    { tag: 'CABLENO', prompt: 'Cable tag', default: '', position: { x: 0.08, y: 0.1 }, height: 0.07, align: 'left' },
    { tag: 'CONDUCTOR', prompt: 'Conductor', default: '', position: { x: 0.08, y: -0.16 }, height: 0.06, align: 'left' },
    { tag: 'CABLETYPE', prompt: 'Cable type', default: '', position: { x: 0, y: 0.3 }, height: 0.06, align: 'center', invisible: true },
    { tag: 'WIRENO', prompt: 'Wire number', default: '', position: { x: 0, y: 0.4 }, height: 0.06, align: 'center', invisible: true },
    { tag: 'FROM', prompt: 'From', default: '', position: { x: 0, y: 0.5 }, height: 0.06, align: 'center', invisible: true },
    { tag: 'TO', prompt: 'To', default: '', position: { x: 0, y: 0.6 }, height: 0.06, align: 'center', invisible: true },
    { tag: 'LENGTH', prompt: 'Length', default: '', position: { x: 0, y: 0.7 }, height: 0.06, align: 'center', invisible: true },
  ],
};

export const isCableMarker = (e: Entity): e is InsertEntity => e.type === 'insert' && e.block === CABLE_BLOCK_NAME;

/** Conductor identification schemes. */
export const CONDUCTOR_SCHEMES: Array<{ key: string; name: string; codes: string[] }> = [
  { key: 'numbers', name: 'Numbered conductors (1, 2, 3 ...)', codes: [] },
  { key: 'iec', name: 'IEC 60757 colours (BN, BK, GY, BU, GNYE ...)', codes: ['BN', 'BK', 'GY', 'BU', 'GNYE', 'OG', 'VT', 'WH', 'RD', 'YE', 'PK', 'TQ'] },
  { key: 'nfpa', name: 'NFPA 79 colours (BLK, RED, BLU, WHT, GRN ...)', codes: ['BLK', 'RED', 'BLU', 'WHT', 'ORG', 'YEL', 'BRN', 'VIO', 'GRY', 'PNK', 'GRN'] },
];

/** Conductor code n (0-based) of a scheme; numbers (or past the end of a colour list) count from `first`. */
export function conductorCode(scheme: string, n: number, first = 1): string {
  const codes = CONDUCTOR_SCHEMES.find((s) => s.key === scheme)?.codes ?? [];
  return codes[n] ?? String(first + n);
}

/** Device / terminal at a world point: "TAG:PIN" (terminals "STRIP:TERM"), the tag alone when the pin is unknown. */
export function connectionAt(entities: readonly Entity[], lookup: BlockLookup, p: Point, tol = 0.03): string | null {
  for (const e of entities) {
    if (!isComponent(e)) continue;
    const block = lookup(e.block);
    if (!block) continue;
    const tf = insertTransform(e, block);
    const name = isTerminal(e) && !e.attributes.TAG1 ? e.attributes.TAGSTRIP || 'TB' : (e.attributes.TAG1 ?? e.block);
    for (const a of block.attributes) {
      if (pinDir(a.tag) === null) continue;
      if (g.dist(tf(a.position), p) > tol) continue;
      const pin = isTerminal(e) ? (e.attributes.TERM01 ?? '') : (e.attributes[a.tag] ?? a.default);
      return pin ? `${name}:${pin}` : name;
    }
    // Symbols without pin attributes: the wire ends at the symbol span edge.
    const b = symbolSpan(e, lookup);
    if (Math.abs(e.position.y - p.y) < 0.05 && (Math.abs(b.min.x - p.x) < tol || Math.abs(b.max.x - p.x) < tol)) return isTerminal(e) ? `${name}:${e.attributes.TERM01 ?? ''}` : name;
  }
  return null;
}

/** The horizontal net containing a wire, if any. */
function netOf(entities: readonly Entity[], wire: LineEntity): WireNet | null {
  return collectNets(entities).find((n) => n.wires.some((w) => w.id === wire.id)) ?? null;
}

/**
 * FROM / TO of one wire segment (a cable conductor runs from device to
 * device): the device pin at each end of the segment (left / top end first),
 * a ladder rail at an end shows as L1 / L2, and an end in the middle of a
 * wire (tee) or open end stays empty.
 */
export function wireEnds(entities: readonly Entity[], lookup: BlockLookup, wire: LineEntity): { from: string; to: string } {
  const [p, q] = isHorizontal(wire) ? (wire.a.x <= wire.b.x ? [wire.a, wire.b] : [wire.b, wire.a]) : wire.a.y >= wire.b.y ? [wire.a, wire.b] : [wire.b, wire.a];
  const rails = entities.filter((e): e is LineEntity => isWire(e) && !isHorizontal(e) && e.id !== wire.id);
  const at = (pt: Point, side: 'L1' | 'L2'): string => {
    const c = connectionAt(entities, lookup, pt);
    if (c) return c;
    if (!isHorizontal(wire)) return '';
    const rail = rails.find((r) => Math.abs(r.a.x - pt.x) < 0.02 && pt.y >= Math.min(r.a.y, r.b.y) - 1e-6 && pt.y <= Math.max(r.a.y, r.b.y) + 1e-6);
    return rail ? side : '';
  };
  return { from: at(p!, 'L1'), to: at(q!, 'L2') };
}

/** Wire number label of a wire (via its net), or ''. */
export function wireNumberOf(entities: readonly Entity[], wire: LineEntity): string {
  const net = isHorizontal(wire) ? netOf(entities, wire) : null;
  if (!net) return '';
  return wireNumberMap(entities).find((m) => m.net && m.net.y === net.y && m.net.x0 === net.x0)?.text.text ?? '';
}

export interface CableAssignment {
  cable: string;
  type: string;
  scheme: string;
  /** Conductor number of the first wire (numbered scheme). */
  first: number;
}

/**
 * AECABLE: put the given wires into a cable. Each wire gets a marker at its
 * midpoint with the next conductor code (in pick order); markers already on
 * those wires are replaced. Returns the ids to remove and the markers to add.
 */
export function assignCable(entities: readonly Entity[], lookup: BlockLookup, wires: readonly LineEntity[], a: CableAssignment): { remove: string[]; add: InsertEntity[] } {
  const remove: string[] = [];
  const add: InsertEntity[] = [];
  const existing = entities.filter(isCableMarker);
  const inCable = existing.filter((m) => m.attributes.CABLENO === a.cable && !wires.some((w) => g.distToSegment(m.position, w.a, w.b) < 1e-3));
  const taken = new Set(inCable.map((m) => m.attributes.CONDUCTOR ?? ''));
  let n = 0;
  wires.forEach((w) => {
    for (const m of existing) if (g.distToSegment(m.position, w.a, w.b) < 1e-3) remove.push(m.id);
    let code = conductorCode(a.scheme, n, a.first);
    while (taken.has(code)) code = conductorCode(a.scheme, (n += 1), a.first);
    taken.add(code);
    n += 1;
    const ends = wireEnds(entities, lookup, w);
    add.push({
      id: newId(),
      type: 'insert',
      layer: CABLE_LAYER,
      color: 'ByLayer',
      block: CABLE_BLOCK_NAME,
      position: { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 },
      rotation: 0,
      scale: 1,
      attributes: { CABLENO: a.cable, CONDUCTOR: code, CABLETYPE: a.type, WIRENO: wireNumberOf(entities, w), FROM: ends.from, TO: ends.to, LENGTH: '' },
    });
  });
  return { remove, add };
}

/** Next free cable tag ("W1", "W2" ...) in a set of entities. */
export function nextCableTag(entities: readonly Entity[], prefix = 'W'): string {
  const used = new Set(entities.filter(isCableMarker).map((m) => m.attributes.CABLENO ?? ''));
  for (let i = 1; ; i += 1) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** The wire a cable marker sits on. */
export function markerWire(entities: readonly Entity[], m: InsertEntity): LineEntity | null {
  return entities.find((e): e is LineEntity => isWire(e) && g.distToSegment(m.position, e.a, e.b) < 1e-3) ?? null;
}

export interface CableScheduleRow {
  cable: string;
  type: string;
  conductors: number;
  conductor: string;
  wire: string;
  from: string;
  to: string;
  length: string;
  ref: string;
  markerId: string;
}

/** Cable schedule rows: one per conductor, FROM / TO / wire number re-read from the schematic when the marker is still on its wire. */
export function cableSchedule(entities: readonly Entity[], lookup: BlockLookup): CableScheduleRow[] {
  const markers = entities.filter(isCableMarker);
  const count = new Map<string, number>();
  for (const m of markers) count.set(m.attributes.CABLENO ?? '', (count.get(m.attributes.CABLENO ?? '') ?? 0) + 1);
  const rows = markers.map((m) => {
    const w = markerWire(entities, m);
    const ends = w ? wireEnds(entities, lookup, w) : { from: '', to: '' };
    const wn = w ? wireNumberOf(entities, w) : '';
    return {
      cable: m.attributes.CABLENO ?? '',
      type: m.attributes.CABLETYPE ?? '',
      conductors: count.get(m.attributes.CABLENO ?? '') ?? 0,
      conductor: m.attributes.CONDUCTOR ?? '',
      wire: wn || m.attributes.WIRENO || '',
      from: ends.from || m.attributes.FROM || '',
      to: ends.to || m.attributes.TO || '',
      length: m.attributes.LENGTH ?? '',
      ref: nearestReference({ entities }, m.position) ?? '',
      markerId: m.id,
    };
  });
  return rows.sort((a, b) => a.cable.localeCompare(b.cable, undefined, { numeric: true }) || a.conductor.localeCompare(b.conductor, undefined, { numeric: true }));
}

// ----------------------------------------------------------------- jumpers

export const JUMPER_ATTRIBUTE = 'JUMPER';

/** Jumper ids recorded on a terminal. */
export function jumperIds(e: InsertEntity): string[] {
  return (e.attributes[JUMPER_ATTRIBUTE] ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Next free jumper id (J1, J2 ...). */
export function nextJumperId(entities: readonly Entity[]): string {
  const used = new Set<string>();
  for (const e of entities) if (e.type === 'insert') for (const id of jumperIds(e)) used.add(id);
  for (let i = 1; ; i += 1) if (!used.has(`J${i}`)) return `J${i}`;
}

const stripOf = (e: InsertEntity) => e.attributes.TAGSTRIP || 'TB1';

/**
 * AEJUMPER: link two terminals of the same strip. Returns the two updated
 * terminals (the jumper id appended to their JUMPER attribute), or an error.
 */
export function addJumper(entities: readonly Entity[], a: InsertEntity, b: InsertEntity): { replace: InsertEntity[]; id: string } | { error: string } {
  if (!isTerminal(a) || !isTerminal(b)) return { error: 'Both objects must be terminals.' };
  if (a.id === b.id) return { error: 'Pick two different terminals.' };
  if (stripOf(a) !== stripOf(b)) return { error: `Terminals are on different strips (${stripOf(a)} / ${stripOf(b)}).` };
  const shared = jumperIds(a).filter((id) => jumperIds(b).includes(id));
  if (shared.length) return { error: `Terminals are already jumpered (${shared.join(', ')}).` };
  const id = nextJumperId(entities);
  const put = (e: InsertEntity) => ({ ...e, attributes: { ...e.attributes, [JUMPER_ATTRIBUTE]: [...jumperIds(e), id].join(',') } });
  return { replace: [put(a), put(b)], id };
}

/** Remove jumpers from a terminal (all, or one id) and from its partner terminals. Returns the changed terminals. */
export function removeJumpers(entities: readonly Entity[], t: InsertEntity, only?: string): InsertEntity[] {
  const ids = new Set(jumperIds(t).filter((id) => !only || id === only));
  if (ids.size === 0) return [];
  const out: InsertEntity[] = [];
  for (const e of entities) {
    if (e.type !== 'insert' || !isTerminal(e)) continue;
    const list = jumperIds(e);
    if (!list.some((id) => ids.has(id))) continue;
    const keep = list.filter((id) => !ids.has(id));
    const attrs: Record<string, string> = { ...e.attributes, [JUMPER_ATTRIBUTE]: keep.join(',') };
    out.push({ ...e, attributes: attrs });
  }
  return out;
}

/** Partner terminals of each jumper on a terminal: [{ id, partners: ["5", "6"] }]. */
export function jumperPartners(entities: readonly Entity[], t: InsertEntity): Array<{ id: string; partners: string[] }> {
  return jumperIds(t).map((id) => ({
    id,
    partners: entities
      .filter((e): e is InsertEntity => e.type === 'insert' && e.id !== t.id && isTerminal(e) && stripOf(e) === stripOf(t) && jumperIds(e).includes(id))
      .map((e) => e.attributes.TERM01 ?? '?'),
  }));
}

/** Short jumper text for reports: "J1>5, J2>7". */
export function jumperText(t: InsertEntity, entities: readonly Entity[]): string {
  return jumperPartners(entities, t)
    .map((j) => `${j.id}>${j.partners.join('/') || '?'}`)
    .join(', ');
}

/** Drawing state with the given terminals replaced and JUMPER defined on their blocks (so the value reaches the DXF). Pure. */
export function withTerminalUpdates(state: DrawingState, terminals: readonly InsertEntity[]): DrawingState {
  if (terminals.length === 0) return state;
  const map = new Map(terminals.map((t) => [t.id, t]));
  let next: DrawingState = { ...state, entities: state.entities.map((e) => map.get(e.id) ?? e) };
  for (const b of new Set(terminals.map((t) => t.block))) next = withBlockAttributes(next, b, [JUMPER_ATTRIBUTE]);
  return next;
}
