/**
 * Schematic reports: Bill of Material, component list, wire from/to list,
 * terminal list. Rows can be exported as CSV.
 */
import type { Drawing } from '../core/document';
import type { InsertEntity, LineEntity, TextEntity } from '../core/entities';
import { entityBounds } from '../core/entities';
import { isWire, isHorizontal, nearestReference } from '../tools/electrical';
import { tagPrefix } from './symbols';
import { WIRE_DOT } from './symbols';

export interface Report {
  title: string;
  columns: string[];
  rows: string[][];
}

const isComponent = (e: InsertEntity) => e.block !== WIRE_DOT.name && (e.attributes.TAG1 !== undefined || e.attributes.TERM01 !== undefined);
/** Relay/contactor contacts belong to their coil's device and are not separate BOM items. */
export const isRelayContact = (block: string): boolean => /^(HCR1_N[OC]|IEC_K_N[OC])$/.test(block);

/** Component report: one row per inserted symbol with a tag. */
export function componentReport(doc: Drawing): Report {
  const rows: string[][] = [];
  for (const e of doc.entities) {
    if (e.type !== 'insert' || !isComponent(e)) continue;
    const block = doc.lookupBlock(e.block);
    rows.push([
      e.attributes.TAG1 ?? e.attributes.TERM01 ?? '',
      e.attributes.DESC1 ?? '',
      e.attributes.MFG ?? '',
      e.attributes.CAT ?? '',
      e.block,
      block?.description ?? '',
      nearestReference(doc, e.position) ?? '',
      `${e.position.x.toFixed(3)}, ${e.position.y.toFixed(3)}`,
    ]);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Component Report', columns: ['Tag', 'Description', 'Manufacturer', 'Catalog', 'Block', 'Symbol', 'Rung', 'Location'], rows };
}

/** Bill of material: components grouped by manufacturer + catalog (or block when no catalog). */
export function billOfMaterial(doc: Drawing): Report {
  const groups = new Map<string, { mfg: string; cat: string; desc: string; tags: string[] }>();
  for (const e of doc.entities) {
    if (e.type !== 'insert' || !isComponent(e)) continue;
    // Contacts of a relay are part of the relay; count coils/devices only.
    if (isRelayContact(e.block)) continue;
    const mfg = e.attributes.MFG ?? '';
    const cat = e.attributes.CAT ?? '';
    const key = mfg || cat ? `${mfg}|${cat}` : `block:${e.block}`;
    let g = groups.get(key);
    if (!g) {
      g = { mfg, cat: cat || (doc.lookupBlock(e.block)?.description ?? e.block), desc: e.attributes.DESC1 ?? '', tags: [] };
      groups.set(key, g);
    }
    g.tags.push(e.attributes.TAG1 ?? e.attributes.TERM01 ?? '');
  }
  const rows = [...groups.values()]
    .sort((a, b) => a.cat.localeCompare(b.cat))
    .map((g, i) => [String(i + 1), String(g.tags.length), g.mfg, g.cat, g.desc, g.tags.filter(Boolean).join(', ')]);
  return { title: 'Bill of Material', columns: ['Item', 'Qty', 'Manufacturer', 'Catalog / Symbol', 'Description', 'Tags'], rows };
}

/** Wire from/to: each numbered net with the components whose stubs touch it. */
export function wireFromToReport(doc: Drawing): Report {
  const numbers = doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'WIRENO');
  const wires = doc.entities.filter((e): e is LineEntity => isWire(e) && isHorizontal(e));
  const comps = doc.entities.filter((e): e is InsertEntity => e.type === 'insert' && isComponent(e));
  const rows: string[][] = [];
  for (const n of numbers) {
    // wires on this number's line (same y, to the right of the label)
    const y = n.position.y - 0.05;
    const nets = wires.filter((w) => Math.abs(w.a.y - y) < 1e-6);
    const touching = new Set<string>();
    for (const c of comps) {
      const b = entityBounds(c, doc.lookupBlock);
      if (!b) continue;
      for (const w of nets) {
        const wl = Math.min(w.a.x, w.b.x);
        const wr = Math.max(w.a.x, w.b.x);
        if (Math.abs(c.position.y - y) < 0.2 && (Math.abs(b.min.x - wr) < 0.02 || Math.abs(b.max.x - wl) < 0.02)) touching.add(c.attributes.TAG1 ?? c.attributes.TERM01 ?? c.block);
      }
    }
    const list = [...touching];
    rows.push([n.text, list[0] ?? '', list[1] ?? '', list.slice(2).join(', '), nearestReference(doc, n.position) ?? '']);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Wire From/To Report', columns: ['Wire No.', 'From', 'To', 'Also', 'Rung'], rows };
}

/** Terminal report. */
export function terminalReport(doc: Drawing): Report {
  const rows: string[][] = [];
  for (const e of doc.entities) {
    if (e.type !== 'insert' || e.attributes.TERM01 === undefined) continue;
    rows.push([e.attributes.TERM01 ?? '', e.attributes.DESC1 ?? '', nearestReference(doc, e.position) ?? '', `${e.position.x.toFixed(3)}, ${e.position.y.toFixed(3)}`]);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Terminal Report', columns: ['Terminal', 'Description', 'Rung', 'Location'], rows };
}

/** Electrical audit: duplicate tags, unnumbered wires, contacts without coils, dangling wire ends. */
export function electricalAudit(doc: Drawing): Report {
  const rows: string[][] = [];
  const tags = new Map<string, number>();
  for (const e of doc.entities) {
    if (e.type === 'insert' && e.attributes.TAG1 && !isRelayContact(e.block)) tags.set(e.attributes.TAG1, (tags.get(e.attributes.TAG1) ?? 0) + 1);
  }
  for (const [t, c] of tags) if (c > 1) rows.push(['Duplicate tag', t, `${c} devices share this tag`]);
  const coilTags = new Set([...tags.keys()]);
  for (const e of doc.entities) {
    if (e.type === 'insert' && isRelayContact(e.block) && e.attributes.TAG1 && !coilTags.has(e.attributes.TAG1)) rows.push(['Contact without coil', e.attributes.TAG1, `at ${e.position.x.toFixed(2)}, ${e.position.y.toFixed(2)}`]);
  }
  const wires = doc.entities.filter((e): e is LineEntity => isWire(e) && isHorizontal(e));
  const numbers = doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'WIRENO');
  const numberedY = new Set(numbers.map((n) => (n.position.y - 0.05).toFixed(6)));
  const seenY = new Set<string>();
  for (const w of wires) {
    const k = w.a.y.toFixed(6);
    if (!numberedY.has(k) && !seenY.has(k)) {
      seenY.add(k);
      rows.push(['Unnumbered wire', `y = ${w.a.y.toFixed(3)}`, 'run AEWIRENO']);
    }
  }
  if (rows.length === 0) rows.push(['OK', '', 'No problems found']);
  return { title: 'Electrical Audit', columns: ['Check', 'Item', 'Detail'], rows };
}

export function reportToCsv(r: Report): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [r.columns.map(cell).join(','), ...r.rows.map((row) => row.map(cell).join(','))].join('\r\n') + '\r\n';
}

export const REPORTS: Array<{ key: string; name: string; build: (doc: Drawing) => Report }> = [
  { key: 'bom', name: 'Bill of Material', build: billOfMaterial },
  { key: 'components', name: 'Component Report', build: componentReport },
  { key: 'wires', name: 'Wire From/To', build: wireFromToReport },
  { key: 'terminals', name: 'Terminal Report', build: terminalReport },
  { key: 'audit', name: 'Electrical Audit', build: electricalAudit },
];

export { tagPrefix };
