/**
 * Coil / contact cross-referencing, the signature AutoCAD Electrical feature:
 * every coil shows a compact table of its contacts' rung references
 * ("NO 101, 102 / NC 103"), and every contact shows the rung of its parent
 * coil. Parent/child links are by tag; children copy INST/LOC/DESC from the
 * parent when inserted (see childAttributes).
 */
import type { Drawing, DrawingState } from '../core/document';
import type { Entity, InsertEntity, TextEntity, LineEntity } from '../core/entities';
import { newId, textWidth } from '../core/entities';
import { nearestReference } from './ladder';
import { isCoil, isChild, isCoilBlock, isChildBlock, isParentComponent } from './families';
import { readWdSettings, type WdSettings } from './wdm';
import { descriptionOf, withInsertAttributes } from './attributes';

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

/**
 * Format one rung reference with the drawing's cross-reference format:
 * %N rung, %S sheet, %D drawing number, %I / %L installation / location of the referenced component.
 */
export function formatXref(ref: string | null, s: Pick<WdSettings, 'xrefFormat' | 'sheet'> & { drawing?: string; inst?: string; loc?: string }): string {
  const r = ref ?? '?';
  return s.xrefFormat
    .replace(/%N/g, r)
    .replace(/%S/g, s.sheet)
    .replace(/%D/g, s.drawing ?? '')
    .replace(/%I/g, s.inst ?? '')
    .replace(/%L/g, s.loc ?? '');
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
  const no = x.contacts.filter((c) => c.kind === 'NO').map((c) => formatXref(c.ref, s));
  const nc = x.contacts.filter((c) => c.kind === 'NC').map((c) => formatXref(c.ref, s));
  return contactTableFromRefs(x.coil, no, nc);
}

/** One coil (or other parent) with its already formatted contact references, for xrefGraphics. */
export interface XrefGraphicItem {
  coil: InsertEntity | null;
  no: string[];
  nc: string[];
  /** Child contacts with the text shown under them (the parent's reference, or "no coil"). */
  contacts: Array<{ insert: InsertEntity; text: string }>;
}

/** Contact table entities from pre-formatted NO / NC reference lists (see contactTable). */
export function contactTableFromRefs(coil: InsertEntity, no: string[], nc: string[]): Entity[] {
  const cx = coil.position.x;
  const top = coil.position.y - 0.18;
  const rows: Array<[string, string]> = [];
  if (no.length) rows.push(['NO', no.join(', ')]);
  if (nc.length) rows.push(['NC', nc.join(', ')]);
  const out: Entity[] = [];
  if (rows.length === 0) return out;
  const text = (px: number, py: number, t: string, align: 'left' | 'center' | 'right'): TextEntity => ({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: px, y: py }, text: t, height: H, rotation: 0, align });
  const line = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), type: 'line', layer: XREF_LAYER, color: 'ByLayer', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
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

/** XREF-layer entities for a set of items (compact text lines beside coils or a table, plus the parent reference under each contact). */
export function xrefGraphics(items: readonly XrefGraphicItem[], style: WdSettings['xrefStyle']): Entity[] {
  const out: Entity[] = [];
  for (const x of items) {
    if (x.coil && style === 'table') out.push(...contactTableFromRefs(x.coil, x.no, x.nc));
    else if (x.coil && (x.no.length || x.nc.length)) {
      // One reference per line to the right of the coil (ACADE places the contact list beside the coil).
      const lines = [...x.no, ...x.nc.map((t) => `${t} NC`)];
      lines.forEach((t, i) =>
        out.push({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: x.coil!.position.x + 0.45, y: x.coil!.position.y - 0.03 - i * 0.12 }, text: t, height: H, rotation: 0, align: 'left' }),
      );
    }
    for (const c of x.contacts) {
      out.push({ id: newId(), type: 'text', layer: XREF_LAYER, color: 'ByLayer', position: { x: c.insert.position.x, y: c.insert.position.y - 0.28 }, text: c.text, height: H, rotation: 0, align: 'center' });
    }
  }
  return out;
}

/** Attribute tags that hold cross-reference text on inserts (ACADE: XREF on children, XREFNO / XREFNC on parents). */
export const XREF_ATTRIBUTES = ['XREF', 'XREFNO', 'XREFNC'] as const;

/**
 * Replace the XREF layer of a drawing state with `graphics`; with `attributes`
 * (insert id -> values) also write XREF (children) / XREFNO + XREFNC (parents)
 * into the inserts, adding invisible attribute definitions to their blocks so
 * the values survive a DXF round trip.
 */
export function withXrefGraphics(s: DrawingState, graphics: Entity[], attributes?: ReadonlyMap<string, Record<string, string>>): DrawingState {
  const entities = [...s.entities.filter((e) => e.layer !== XREF_LAYER), ...graphics];
  const next: DrawingState = { ...s, layers: s.layers.some((l) => l.name === XREF_LAYER) ? s.layers : [...s.layers, { name: XREF_LAYER, color: 8, visible: true, locked: false, lineWeight: 0.25 }], entities };
  return attributes ? withInsertAttributes(next, attributes) : next;
}

/**
 * Write cross-reference graphics (layer XREF): a contact table under each
 * coil and the coil's rung next to each contact. Existing XREF entities are
 * replaced. Returns the number of tags processed.
 */
export function updateCrossReferences(doc: Drawing, settings: Pick<WdSettings, 'xrefFormat' | 'sheet' | 'xrefStyle'> = readWdSettings(doc)): number {
  const xref = buildXref(doc);
  const items: XrefGraphicItem[] = xref.map((x) => ({
    coil: x.coil,
    no: x.contacts.filter((c) => c.kind === 'NO').map((c) => formatXref(c.ref, settings)),
    nc: x.contacts.filter((c) => c.kind === 'NC').map((c) => formatXref(c.ref, settings)),
    contacts: x.contacts.map((c) => ({ insert: c.insert, text: x.coil ? formatXref(x.coilRef, settings) : 'no coil' })),
  }));
  const graphics = xrefGraphics(items, settings.xrefStyle);
  doc.transact((s) => withXrefGraphics(s, graphics));
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

/** Library callbacks for choosing a child contact block (xref.ts does not import the library itself). */
export interface ChildBlockOptions {
  /** Whether a block exists in the library or the drawing (findLibrarySymbol / lookupBlock). */
  exists?: (name: string) => boolean;
  /** User CONTACT symbols that fit this parent (same family) and contact kind, best first. */
  candidates?: (parentBlock: string, kind: 'NO' | 'NC') => string[];
}

/** Built-in child contact block that matches a parent's standard (JIC or IEC). */
export function builtinChildBlockFor(parentBlock: string, kind: 'NO' | 'NC'): string {
  if (parentBlock.startsWith('IEC_KM')) return `IEC_KM_${kind}`;
  if (parentBlock.startsWith('IEC_KT_OFF')) return `IEC_KT_OFF_${kind}`;
  if (parentBlock.startsWith('IEC_KT')) return `IEC_KT_ON_${kind}`;
  if (parentBlock.startsWith('IEC_')) return `IEC_K_${kind}`;
  if (parentBlock.startsWith('HKM')) return `HKM1_${kind}`;
  if (parentBlock.startsWith('HTD2')) return `HTD2_${kind}`;
  if (parentBlock.startsWith('HTD')) return `HTD1_${kind}`;
  return `HCR1_${kind}`;
}

/**
 * Child contact blocks for a parent, best first: the parent's own twin
 * (`<parent without _NO/_NC>_<kind>`, the naming the Symbol Builder steers
 * to) when it exists, then the user library's contacts of the same family,
 * then the built-in contact of the parent's standard.
 */
export function childBlockChoices(parentBlock: string, kind: 'NO' | 'NC', opts: ChildBlockOptions = {}): string[] {
  const out: string[] = [];
  const push = (n: string) => {
    if (!out.includes(n)) out.push(n);
  };
  const sibling = `${parentBlock.replace(/_N[OC]$/, '')}_${kind}`;
  if (opts.exists?.(sibling)) push(sibling);
  for (const n of opts.candidates?.(parentBlock, kind) ?? []) push(n);
  push(builtinChildBlockFor(parentBlock, kind));
  return out;
}

/** The child contact block to insert for a parent (see childBlockChoices). */
export function childBlockFor(parentBlock: string, kind: 'NO' | 'NC', opts: ChildBlockOptions = {}): string {
  return childBlockChoices(parentBlock, kind, opts)[0]!;
}
