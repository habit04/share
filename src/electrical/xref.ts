/**
 * Coil / contact cross-referencing, the signature AutoCAD Electrical feature:
 * every coil shows a compact table of its contacts' rung references
 * ("NO 101, 102 / NC 103"), and every contact shows the rung of its parent
 * coil. Parent/child links are by tag; children copy INST/LOC/DESC from the
 * parent when inserted (see childAttributes).
 */
import type { Drawing } from '../core/document';
import type { Entity, InsertEntity, TextEntity, LineEntity } from '../core/entities';
import { newId, textWidth } from '../core/entities';
import { nearestReference } from './ladder';
import { isCoil, isChild, isCoilBlock, isChildBlock, isParentComponent } from './families';
import { readWdSettings, type WdSettings } from './wdm';
import { descriptionOf } from './attributes';

export { isCoil };
export const isContact = isChild;

export interface XrefContact {
  insert: InsertEntity;
  ref: string | null;
  kind: 'NO' | 'NC';
}

export interface XrefEntry {
  tag: string;
  coil: InsertEntity | null;
  coilRef: string | null;
  contacts: XrefContact[];
}

export const XREF_LAYER = 'XREF';

/** Group coils and contacts by tag. */
export function buildXref(doc: Drawing): XrefEntry[] {
  const map = new Map<string, XrefEntry>();
  const entry = (tag: string) => {
    let e = map.get(tag);
    if (!e) {
      e = { tag, coil: null, coilRef: null, contacts: [] };
      map.set(tag, e);
    }
    return e;
  };
  for (const e of doc.entities) {
    if (e.type !== 'insert') continue;
    const tag = e.attributes.TAG1;
    if (!tag) continue;
    if (isCoilBlock(e.block)) {
      const x = entry(tag);
      x.coil = e;
      x.coilRef = nearestReference(doc, e.position);
    } else if (isChildBlock(e.block)) {
      entry(tag).contacts.push({ insert: e, ref: nearestReference(doc, e.position), kind: /NC$/.test(e.block) ? 'NC' : 'NO' });
    }
  }
  for (const x of map.values()) x.contacts.sort((a, b) => (a.ref ?? '').localeCompare(b.ref ?? '', undefined, { numeric: true }));
  return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Format one rung reference with the drawing's cross-reference format (%N rung, %S sheet). */
export function formatXref(ref: string | null, s: Pick<WdSettings, 'xrefFormat' | 'sheet'>): string {
  const r = ref ?? '?';
  return s.xrefFormat.replace(/%N/g, r).replace(/%S/g, s.sheet);
}

/** Compact contact reference line: "NO 101, 102 / NC 103". */
export function contactSummary(x: XrefEntry, s: Pick<WdSettings, 'xrefFormat' | 'sheet'>): string {
  const no = x.contacts.filter((c) => c.kind === 'NO').map((c) => formatXref(c.ref, s));
  const nc = x.contacts.filter((c) => c.kind === 'NC').map((c) => formatXref(c.ref, s));
  const parts: string[] = [];
  if (no.length) parts.push(`NO ${no.join(', ')}`);
  if (nc.length) parts.push(`NC ${nc.join(', ')}`);
  return parts.join(' / ');
}

const H = 0.08; // xref text height
const ROW = 0.16;

/** Entities of the small contact table drawn under a coil (lines + text on layer XREF). */
export function contactTable(x: XrefEntry, s: Pick<WdSettings, 'xrefFormat' | 'sheet'>): Entity[] {
  if (!x.coil) return [];
  const cx = x.coil.position.x;
  const top = x.coil.position.y - 0.18;
  const rows: Array<[string, string]> = [];
  const no = x.contacts.filter((c) => c.kind === 'NO').map((c) => formatXref(c.ref, s));
  const nc = x.contacts.filter((c) => c.kind === 'NC').map((c) => formatXref(c.ref, s));
  if (no.length) rows.push(['NO', no.join(', ')]);
  if (nc.length) rows.push(['NC', nc.join(', ')]);
  const out: Entity[] = [];
  const text = (px: number, py: number, t: string, align: 'left' | 'center' | 'right'): TextEntity => ({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: px, y: py }, text: t, height: H, rotation: 0, align });
  const line = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), type: 'line', layer: XREF_LAYER, color: 'ByLayer', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
  if (rows.length === 0) return out;
  const col1 = 0.3;
  const col2 = Math.max(0.5, ...rows.map((r) => textWidth(r[1], H) + 0.1));
  const w = col1 + col2;
  // Sits to the right of the coil symbol, between the coil and the L2 rail.
  const left = cx + 0.42;
  const bottom = top - rows.length * ROW;
  out.push(line(left, top, left + w, top), line(left, bottom, left + w, bottom), line(left, top, left, bottom), line(left + w, top, left + w, bottom), line(left + col1, top, left + col1, bottom));
  rows.forEach((r, i) => {
    const y = top - (i + 1) * ROW + 0.04;
    if (i > 0) out.push(line(left, top - i * ROW, left + w, top - i * ROW));
    out.push(text(left + col1 / 2, y, r[0], 'center'), text(left + col1 + 0.05, y, r[1], 'left'));
  });
  return out;
}

/**
 * Write cross-reference graphics (layer XREF): a contact table under each
 * coil and the coil's rung next to each contact. Existing XREF entities are
 * replaced. Returns the number of tags processed.
 */
export function updateCrossReferences(doc: Drawing, settings: Pick<WdSettings, 'xrefFormat' | 'sheet' | 'xrefStyle'> = readWdSettings(doc)): number {
  const xref = buildXref(doc);
  const out: Entity[] = [];
  for (const x of xref) {
    if (x.coil && settings.xrefStyle === 'table') out.push(...contactTable(x, settings));
    else if (x.coil && x.contacts.length) {
      // One reference per line to the right of the coil (ACADE places the contact list beside the coil).
      const no = x.contacts.filter((c) => c.kind === 'NO').map((c) => formatXref(c.ref, settings));
      const nc = x.contacts.filter((c) => c.kind === 'NC').map((c) => `${formatXref(c.ref, settings)} NC`);
      const lines = [...no, ...nc];
      lines.forEach((t, i) =>
        out.push({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: x.coil!.position.x + 0.45, y: x.coil!.position.y - 0.03 - i * 0.12 }, text: t, height: H, rotation: 0, align: 'left' }),
      );
    }
    for (const c of x.contacts) {
      const ref = x.coil ? formatXref(x.coilRef, settings) : 'no coil';
      out.push({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: c.insert.position.x, y: c.insert.position.y - 0.28 }, text: ref, height: H, rotation: 0, align: 'center' });
    }
  }
  doc.transact((s) => ({
    ...s,
    layers: s.layers.some((l) => l.name === XREF_LAYER) ? s.layers : [...s.layers, { name: XREF_LAYER, color: 8, visible: true, locked: false, lineWeight: 0.25 }],
    entities: [...s.entities.filter((e) => e.layer !== XREF_LAYER), ...out],
  }));
  return xref.length;
}

/** Parents a child contact can be linked to (coils and other parent devices), with their tags. */
export interface ParentInfo {
  id: string;
  tag: string;
  block: string;
  description: string;
  ref: string | null;
  contacts: number;
}

export function parentCandidates(doc: Drawing, family?: string): ParentInfo[] {
  const xref = new Map(buildXref(doc).map((x) => [x.tag, x]));
  const out: ParentInfo[] = [];
  for (const e of doc.entities) {
    if (!isParentComponent(e) || !e.attributes.TAG1) continue;
    if (family && !e.attributes.TAG1.startsWith(family)) continue;
    out.push({ id: e.id, tag: e.attributes.TAG1, block: e.block, description: descriptionOf(e.attributes), ref: nearestReference(doc, e.position), contacts: xref.get(e.attributes.TAG1)?.contacts.length ?? 0 });
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Attributes a child contact inherits from its parent (tag, location and description lines). */
export function childAttributes(parent: InsertEntity): Record<string, string> {
  const out: Record<string, string> = { TAG1: parent.attributes.TAG1 ?? '' };
  for (const k of ['INST', 'LOC', 'DESC1', 'DESC2', 'DESC3']) if (parent.attributes[k]) out[k] = parent.attributes[k]!;
  return out;
}

/** Child contact block that matches a parent's standard (JIC or IEC). */
export function childBlockFor(parentBlock: string, kind: 'NO' | 'NC'): string {
  if (parentBlock.startsWith('IEC_KM')) return `IEC_KM_${kind}`;
  if (parentBlock.startsWith('IEC_KT_OFF')) return `IEC_KT_OFF_${kind}`;
  if (parentBlock.startsWith('IEC_KT')) return `IEC_KT_ON_${kind}`;
  if (parentBlock.startsWith('IEC_')) return `IEC_K_${kind}`;
  if (parentBlock.startsWith('HKM')) return `HKM1_${kind}`;
  if (parentBlock.startsWith('HTD2')) return `HTD2_${kind}`;
  if (parentBlock.startsWith('HTD')) return `HTD1_${kind}`;
  return `HCR1_${kind}`;
}
