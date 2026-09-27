/**
 * Coil / contact cross-referencing, the signature AutoCAD Electrical feature:
 * every coil shows the rung references of its contacts, and every contact
 * shows the rung of its parent coil.
 */
import type { Drawing } from '../core/document';
import type { Entity, InsertEntity, TextEntity } from '../core/entities';
import { newId } from '../core/entities';
import { nearestReference } from '../tools/electrical';

const COIL_RE = /^(HCR|HTD|HSOL|IEC_K_COIL|IEC_KM_COIL|IEC_KT)/;
const CONTACT_RE = /^(HCR1_N[OC]|IEC_K_N[OC])/;

export const isCoil = (e: Entity): boolean => e.type === 'insert' && COIL_RE.test(e.block) && !/_N[OC]$/.test(e.block);
export const isContact = (e: Entity): boolean => e.type === 'insert' && CONTACT_RE.test(e.block);

export interface XrefEntry {
  tag: string;
  coil: InsertEntity | null;
  coilRef: string | null;
  contacts: Array<{ insert: InsertEntity; ref: string | null; kind: 'NO' | 'NC' }>;
}

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
    if (isCoil(e)) {
      const x = entry(tag);
      x.coil = e;
      x.coilRef = nearestReference(doc, e.position);
    } else if (isContact(e)) {
      entry(tag).contacts.push({ insert: e, ref: nearestReference(doc, e.position), kind: /NC$/.test(e.block) ? 'NC' : 'NO' });
    }
  }
  return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Write cross-reference text (layer XREF) under each coil listing its
 * contacts' rung references, and next to each contact listing its coil's rung.
 * Existing XREF text is replaced.
 */
export function updateCrossReferences(doc: Drawing): number {
  const xref = buildXref(doc);
  const texts: TextEntity[] = [];
  const mk = (pos: { x: number; y: number }, text: string, align: 'left' | 'center' | 'right' = 'center'): TextEntity => ({
    id: newId(),
    type: 'text',
    layer: 'XREF',
    color: 'ByLayer',
    position: pos,
    text,
    height: 0.09,
    rotation: 0,
    align,
  });
  for (const x of xref) {
    if (x.coil) {
      const refs = x.contacts.map((c) => `${c.ref ?? '?'}${c.kind === 'NC' ? '̅' : ''}`);
      const noRefs = x.contacts.filter((c) => c.kind === 'NO').map((c) => c.ref ?? '?');
      const ncRefs = x.contacts.filter((c) => c.kind === 'NC').map((c) => c.ref ?? '?');
      void refs;
      const lines: string[] = [];
      if (noRefs.length) lines.push(`NO: ${noRefs.join(', ')}`);
      if (ncRefs.length) lines.push(`NC: ${ncRefs.join(', ')}`);
      if (lines.length === 0) lines.push('(no contacts)');
      lines.forEach((line, i) => texts.push(mk({ x: x.coil!.position.x, y: x.coil!.position.y - 0.6 - i * 0.14 }, line)));
    }
    for (const c of x.contacts) {
      const ref = x.coilRef ?? (x.coil ? '?' : 'no coil');
      texts.push(mk({ x: c.insert.position.x, y: c.insert.position.y - 0.28 }, ref));
    }
  }
  if (!doc.layer('XREF')) doc.addLayer({ name: 'XREF', color: 8, visible: true, locked: false, lineWeight: 0.25 });
  doc.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => !(e.type === 'text' && e.layer === 'XREF')), ...texts] }));
  return xref.length;
}
