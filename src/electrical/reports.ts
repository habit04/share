/**
 * Schematic / panel reports: Bill of Material, component list, wire from/to,
 * wire labels, terminal list, terminal strip, PLC I/O, missing catalog
 * data, panel footprints and the electrical audit. Rows can be exported as
 * CSV, placed on the drawing as a table, and merged across the drawings of
 * a project.
 */
import type { Point } from '../core/geometry';
import type { Drawing } from '../core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../core/entities';
import { newId, textWidth } from '../core/entities';
import { isWire, isHorizontal, nearestReference } from './ladder';
import { tagPrefix, WIRE_DOT } from './symbols';
import { isComponent, isChild, isChildBlock, isExtraPole, isParentComponent, isTerminal } from './families';
import { descriptionOf, instLoc } from './attributes';
import { collectNets, netOfWireNumber, isWireNumber, symbolSpan, type WireNet } from './wires';
import { auditIssues } from './audit';
import { panelRows, terminalStripTable } from './panel';
import { WIRE_TYPES } from '../tools/plc';

export interface Report {
  title: string;
  columns: string[];
  rows: string[][];
}

/** Relay/contactor contacts belong to their coil's device and are not separate BOM items. */
export const isRelayContact = (block: string): boolean => isChildBlock(block);

const loc = (e: InsertEntity) => `${e.position.x.toFixed(3)}, ${e.position.y.toFixed(3)}`;

/** Component report: one row per inserted symbol with a tag (children listed with their parent tag). */
export function componentReport(doc: Drawing): Report {
  const rows: string[][] = [];
  for (const e of doc.entities) {
    if (!isComponent(e)) continue;
    const block = doc.lookupBlock(e.block);
    rows.push([
      e.attributes.TAG1 ?? e.attributes.TERM01 ?? '',
      descriptionOf(e.attributes),
      e.attributes.MFG ?? '',
      e.attributes.CAT ?? '',
      instLoc(e.attributes),
      e.block,
      block?.description ?? '',
      nearestReference(doc, e.position) ?? '',
      isChild(e) ? 'child' : isExtraPole(e) ? `pole ${e.attributes.POLE}` : '',
      loc(e),
    ]);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Component Report', columns: ['Tag', 'Description', 'Manufacturer', 'Catalog', 'Inst/Loc', 'Block', 'Symbol', 'Rung', 'Child', 'Location'], rows };
}

/** Bill of material: parent devices grouped by manufacturer + catalog (or block when no catalog). */
export function billOfMaterial(doc: Drawing): Report {
  const groups = new Map<string, { mfg: string; cat: string; desc: string; tags: string[] }>();
  for (const e of doc.entities) {
    if (!isComponent(e) || isChild(e) || isExtraPole(e)) continue;
    const mfg = e.attributes.MFG ?? '';
    const cat = e.attributes.CAT ?? '';
    const key = mfg || cat ? `${mfg}|${cat}` : `block:${e.block}`;
    let g = groups.get(key);
    if (!g) {
      g = { mfg, cat: cat || (doc.lookupBlock(e.block)?.description ?? e.block), desc: descriptionOf(e.attributes), tags: [] };
      groups.set(key, g);
    }
    g.tags.push(e.attributes.TAG1 ?? e.attributes.TERM01 ?? '');
  }
  const rows = [...groups.values()]
    .sort((a, b) => a.cat.localeCompare(b.cat))
    .map((g, i) => [String(i + 1), String(g.tags.length), g.mfg, g.cat, g.desc, g.tags.filter(Boolean).join(', ')]);
  return { title: 'Bill of Material', columns: ['Item', 'Qty', 'Manufacturer', 'Catalog / Symbol', 'Description', 'Tags'], rows };
}

/** Devices whose stubs touch a net, in x order. */
function devicesOnNet(doc: Drawing, net: WireNet, comps: InsertEntity[]): string[] {
  const found: Array<{ x: number; tag: string }> = [];
  for (const c of comps) {
    const b = symbolSpan(c, doc.lookupBlock);
    if (Math.abs(c.position.y - net.y) > 0.2) continue;
    for (const w of net.wires) {
      const wl = Math.min(w.a.x, w.b.x);
      const wr = Math.max(w.a.x, w.b.x);
      if (Math.abs(b.min.x - wr) < 0.02 || Math.abs(b.max.x - wl) < 0.02) {
        found.push({ x: c.position.x, tag: c.attributes.TAG1 ?? c.attributes.TERM01 ?? c.block });
        break;
      }
    }
  }
  const rails = doc.entities.filter((e): e is LineEntity => isWire(e) && !isHorizontal(e));
  for (const r of rails) {
    const y0 = Math.min(r.a.y, r.b.y);
    const y1 = Math.max(r.a.y, r.b.y);
    if (net.y < y0 - 1e-6 || net.y > y1 + 1e-6) continue;
    if (Math.abs(r.a.x - net.x0) < 0.02) found.push({ x: net.x0, tag: 'L1' });
    else if (Math.abs(r.a.x - net.x1) < 0.02) found.push({ x: net.x1, tag: 'L2' });
  }
  return found.sort((a, b) => a.x - b.x).map((f) => f.tag);
}

function numberedNets(doc: Drawing): Array<{ label: TextEntity; net: WireNet }> {
  const nets = collectNets(doc.entities);
  const out: Array<{ label: TextEntity; net: WireNet }> = [];
  for (const t of doc.entities) {
    if (!isWireNumber(t)) continue;
    const net = netOfWireNumber(nets, t);
    if (net) out.push({ label: t, net });
  }
  return out;
}

/** Wire from/to: each numbered net with the components whose stubs touch it. */
export function wireFromToReport(doc: Drawing): Report {
  const comps = doc.entities.filter((e): e is InsertEntity => isComponent(e));
  const rows: string[][] = [];
  for (const { label, net } of numberedNets(doc)) {
    const list = devicesOnNet(doc, net, comps);
    rows.push([label.text, list[0] ?? '', list[1] ?? '', list.slice(2).join(', '), nearestReference(doc, label.position) ?? '', label.layer === 'WIREFIXED' ? 'fixed' : '']);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Wire From/To Report', columns: ['Wire No.', 'From', 'To', 'Also', 'Rung', 'Fixed'], rows };
}

/** Wire label report: one printable label per wire end with wire type, colour / gauge and length. */
export function wireLabelReport(doc: Drawing): Report {
  const comps = doc.entities.filter((e): e is InsertEntity => isComponent(e));
  const rows: string[][] = [];
  for (const { label, net } of numberedNets(doc)) {
    const layer = net.wires[0]!.layer;
    const type = WIRE_TYPES.find((t) => t.layer === layer);
    const length = net.wires.reduce((s, w) => s + Math.abs(w.a.x - w.b.x), 0);
    const list = devicesOnNet(doc, net, comps);
    rows.push([label.text, layer, type?.description ?? '', String(Math.max(2, list.length)), list.join(' - '), length.toFixed(2)]);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Wire Label Report', columns: ['Wire No.', 'Wire Type', 'Colour / Gauge', 'Labels', 'Connections', 'Length'], rows };
}

/** Terminal report. */
export function terminalReport(doc: Drawing): Report {
  const rows: string[][] = [];
  for (const e of doc.entities) {
    if (!isTerminal(e)) continue;
    rows.push([e.attributes.TAGSTRIP ?? '', e.attributes.TERM01 ?? '', descriptionOf(e.attributes), nearestReference(doc, e.position) ?? '', loc(e)]);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }) || a[1]!.localeCompare(b[1]!, undefined, { numeric: true }));
  return { title: 'Terminal Report', columns: ['Strip', 'Terminal', 'Description', 'Rung', 'Location'], rows };
}

/** Terminal strip report: wire numbers and devices on both sides of each terminal. */
export function terminalStripReport(doc: Drawing): Report {
  const rows = terminalStripTable(doc.entities, doc.lookupBlock).map((r) => [r.strip, r.number, r.leftWire, r.leftDevice, r.rightWire, r.rightDevice, r.ref]);
  return { title: 'Terminal Strip Report', columns: ['Strip', 'Terminal', 'Left Wire', 'Left Device', 'Right Wire', 'Right Device', 'Rung'], rows };
}

/** PLC I/O address report: module addresses (parametric modules) and PLC point symbols with the connected device. */
export function plcIoReport(doc: Drawing): Report {
  const rows: string[][] = [];
  const nets = collectNets(doc.entities);
  const labels = doc.entities.filter(isWireNumber).map((t) => ({ t, net: netOfWireNumber(nets, t) }));
  const comps = doc.entities.filter((e): e is InsertEntity => isComponent(e) && !/PLC/.test(e.block));
  const netAt = (p: Point) => nets.find((n) => Math.abs(n.y - p.y) < 0.05 && p.x >= n.x0 - 0.02 && p.x <= n.x1 + 0.02) ?? null;
  const wireNo = (net: WireNet | null) => labels.find((l) => l.net === net)?.t.text ?? '';
  const deviceOn = (net: WireNet | null) => (net ? devicesOnNet(doc, net, comps).filter((d) => d !== 'L1' && d !== 'L2') : []);
  const descOf = (tag: string) => doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.attributes.TAG1 === tag && !!e.attributes.DESC1)?.attributes.DESC1 ?? '';
  // Parametric modules: a closed SYMS box with a TAGS text above it (module tag) and address texts inside.
  const boxes = doc.entities.filter((e) => e.type === 'polyline' && e.layer === 'SYMS' && e.closed && e.points.length === 4);
  for (const box of boxes) {
    if (box.type !== 'polyline') continue;
    const xs = box.points.map((p) => p.x);
    const ys = box.points.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const inside = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const moduleTag = doc.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === 'TAGS' && e.position.y > y1 && e.position.y < y1 + 0.3 && e.position.x >= x0 && e.position.x <= x1)?.text ?? '';
    const addrs = doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'TAGS' && inside(e.position));
    if (!moduleTag || addrs.length === 0) continue;
    for (const a of addrs) {
      const y = a.position.y + 0.04;
      const kindText = doc.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === 'DESC' && inside(e.position) && Math.abs(e.position.y - a.position.y) < 0.02)?.text ?? '';
      const isInput = /^IN/.test(kindText) || (!/^OUT/.test(kindText) && a.align === 'left');
      const stubX = isInput ? x0 - 0.01 : x1 + 0.01;
      const net = netAt({ x: stubX, y });
      const devices = deviceOn(net);
      rows.push([moduleTag, a.text, isInput ? 'Input' : 'Output', wireNo(net), devices.join(', '), devices.length ? descOf(devices[0]!) : '', nearestReference(doc, a.position) ?? '']);
    }
  }
  for (const e of doc.entities) {
    if (e.type !== 'insert' || !/PLC/.test(e.block) || !e.attributes.TAG1) continue;
    const b = symbolSpan(e, doc.lookupBlock);
    const isInput = /I$|_I$|AI$/.test(e.block);
    const net = netAt({ x: isInput ? b.min.x - 0.01 : b.max.x + 0.01, y: e.position.y });
    const devices = deviceOn(net);
    rows.push(['', e.attributes.TAG1, isInput ? 'Input' : 'Output', wireNo(net), devices.join(', '), e.attributes.DESC1 || (devices.length ? descOf(devices[0]!) : ''), nearestReference(doc, e.position) ?? '']);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }) || a[1]!.localeCompare(b[1]!, undefined, { numeric: true }));
  return { title: 'PLC I/O Address Report', columns: ['Module', 'Address', 'I/O', 'Wire No.', 'Device', 'Description', 'Rung'], rows };
}

/** Parent devices that lack manufacturer or catalog data. */
export function missingCatalogReport(doc: Drawing): Report {
  const rows: string[][] = [];
  for (const e of doc.entities) {
    if (!isParentComponent(e) || /^(HGND|IEC_PE)/.test(e.block)) continue;
    const missing = [!e.attributes.MFG && 'MFG', !e.attributes.CAT && 'CAT'].filter(Boolean) as string[];
    if (missing.length === 0) continue;
    rows.push([e.attributes.TAG1 ?? '', descriptionOf(e.attributes), tagPrefix(e.block), e.block, missing.join(', '), nearestReference(doc, e.position) ?? '']);
  }
  rows.sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true }));
  return { title: 'Missing Catalog Data', columns: ['Tag', 'Description', 'Family', 'Block', 'Missing', 'Rung'], rows };
}

/** Panel footprints with item numbers. */
export function panelReport(doc: Drawing): Report {
  const rows = panelRows(doc.entities).map((r) => [r.item, r.tag, r.desc, r.mfg, r.cat, r.loc, r.block]);
  return { title: 'Panel Component Report', columns: ['Item', 'Tag', 'Description', 'Manufacturer', 'Catalog', 'Inst/Loc', 'Footprint'], rows };
}

/** Electrical audit as a report (see audit.ts for the structured issues). */
export function electricalAudit(doc: Drawing): Report {
  const rows = auditIssues(doc).map((i) => [i.check, i.item, i.detail, i.severity]);
  if (rows.length === 0) rows.push(['OK', '', 'No problems found', '']);
  return { title: 'Electrical Audit', columns: ['Check', 'Item', 'Detail', 'Severity'], rows };
}

export function reportToCsv(r: Report): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [r.columns.map(cell).join(','), ...r.rows.map((row) => row.map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Merge the same report from several drawings, prefixing each row with the drawing name. */
export function mergeReports(parts: Array<{ drawing: string; report: Report }>): Report {
  const first = parts[0]?.report;
  if (!first) return { title: 'Project Report', columns: ['Drawing'], rows: [] };
  const rows = parts.flatMap((p) => p.report.rows.filter((r) => r[0] !== 'OK').map((r) => [p.drawing, ...r]));
  return { title: `${first.title} (project)`, columns: ['Drawing', ...first.columns], rows };
}

export interface TableOptions {
  textHeight?: number;
  rowHeight?: number;
  layer?: string;
  /** Maximum rows per column block; longer reports continue in a second block to the right. */
  maxRows?: number;
}

/** Put a report on the drawing as a table of lines and text (origin = top-left). */
export function reportToEntities(r: Report, origin: Point, opts: TableOptions = {}): Entity[] {
  const h = opts.textHeight ?? 0.1;
  const rh = opts.rowHeight ?? h * 2.2;
  const layer = opts.layer ?? 'REPORT';
  const maxRows = Math.max(1, opts.maxRows ?? 40);
  const pad = h * 0.6;
  const widths = r.columns.map((c, i) => Math.max(textWidth(c, h), ...r.rows.map((row) => textWidth(row[i] ?? '', h))) + pad * 2);
  const total = widths.reduce((s, w) => s + w, 0);
  const out: Entity[] = [];
  const line = (a: Point, b: Point): LineEntity => ({ id: newId(), type: 'line', layer, color: 'ByLayer', a, b });
  const text = (p: Point, t: string, height = h): TextEntity => ({ id: newId(), type: 'text', layer, color: 'ByLayer', position: p, text: t, height, rotation: 0, align: 'left' });
  out.push(text({ x: origin.x, y: origin.y + h * 0.6 }, r.title, h * 1.3));
  const blocks = Math.max(1, Math.ceil(r.rows.length / maxRows));
  for (let b = 0; b < blocks; b += 1) {
    const rows = r.rows.slice(b * maxRows, (b + 1) * maxRows);
    const left = origin.x + b * (total + rh);
    const top = origin.y;
    const nRows = rows.length + 1;
    const bottom = top - nRows * rh;
    out.push(line({ x: left, y: top }, { x: left + total, y: top }));
    for (let i = 1; i <= nRows; i += 1) out.push(line({ x: left, y: top - i * rh }, { x: left + total, y: top - i * rh }));
    let x = left;
    out.push(line({ x, y: top }, { x, y: bottom }));
    widths.forEach((w) => {
      x += w;
      out.push(line({ x, y: top }, { x, y: bottom }));
    });
    const cellText = (row: string[], ri: number) => {
      let cx = left;
      row.forEach((c, ci) => {
        if (c) out.push(text({ x: cx + pad, y: top - (ri + 1) * rh + (rh - h) / 2 }, c));
        cx += widths[ci]!;
      });
    };
    cellText(r.columns, 0);
    rows.forEach((row, i) => cellText(row, i + 1));
  }
  return out;
}

export const REPORTS: Array<{ key: string; name: string; build: (doc: Drawing) => Report; group: 'schematic' | 'panel' }> = [
  { key: 'bom', name: 'Bill of Material', build: billOfMaterial, group: 'schematic' },
  { key: 'components', name: 'Component Report', build: componentReport, group: 'schematic' },
  { key: 'wires', name: 'Wire From/To', build: wireFromToReport, group: 'schematic' },
  { key: 'labels', name: 'Wire Labels', build: wireLabelReport, group: 'schematic' },
  { key: 'plc', name: 'PLC I/O Address', build: plcIoReport, group: 'schematic' },
  { key: 'missing', name: 'Missing Catalog Data', build: missingCatalogReport, group: 'schematic' },
  { key: 'terminals', name: 'Terminal Report', build: terminalReport, group: 'panel' },
  { key: 'strip', name: 'Terminal Strip', build: terminalStripReport, group: 'panel' },
  { key: 'panel', name: 'Panel Components', build: panelReport, group: 'panel' },
  { key: 'audit', name: 'Electrical Audit', build: electricalAudit, group: 'schematic' },
];

export { tagPrefix, WIRE_DOT };
