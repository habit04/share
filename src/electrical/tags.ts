/**
 * Component tag formatting and assignment (AutoCAD Electrical style):
 * the drawing's tag format (%F family, %N number, %S sheet ...) with either
 * rung-reference numbering (PB101, PB101A ...) or a sequential counter
 * (PB1, PB2 ...), plus RETAG which renumbers a whole drawing in ladder order
 * and carries child contacts along with their parent.
 */
import type { Drawing } from '../core/document';
import type { InsertEntity } from '../core/entities';
import type { WdSettings } from './wdm';
import { nearestReference } from './ladder';
import { isChild, isExtraPole, isParentComponent } from './families';
import { tagPrefix } from './symbols';

export interface TagVars {
  family: string;
  number: string;
  sheet?: string;
  drawing?: string;
  inst?: string;
  loc?: string;
}

/** Expand a tag format. Unknown codes are left as-is. */
export function formatTag(fmt: string, v: TagVars): string {
  return fmt.replace(/%([FNSDIL])/g, (_m, c: string) => {
    switch (c) {
      case 'F':
        return v.family;
      case 'N':
        return v.number;
      case 'S':
        return v.sheet ?? '';
      case 'D':
        return v.drawing ?? '';
      case 'I':
        return v.inst ?? '';
      case 'L':
        return v.loc ?? '';
      default:
        return '';
    }
  });
}

/** Letter suffix for duplicates on the same rung: 1 -> A, 26 -> Z, 27 -> AA. */
export function letterSuffix(n: number): string {
  let s = '';
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

/** Tags in use by parent devices (children share their parent's tag and are not counted). */
export function usedTags(doc: Drawing): Set<string> {
  const used = new Set<string>();
  for (const e of doc.entities) if (isParentComponent(e) && e.attributes.TAG1) used.add(e.attributes.TAG1);
  return used;
}

/** Tags used by parent devices of one family, sorted (for the "Used" list in the component dialog). */
export function usedTagsOfFamily(doc: Drawing, family: string): string[] {
  const out: string[] = [];
  for (const e of doc.entities) {
    if (!isParentComponent(e) || !e.attributes.TAG1) continue;
    if (tagPrefix(e.block) === family) out.push(e.attributes.TAG1);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Next free tag for a family. Reference mode uses the rung reference with
 * A/B/C suffixes for duplicates; sequential mode counts from tagStart.
 */
export function nextTag(used: Set<string>, family: string, ref: string | null, s: WdSettings): string {
  const vars = (number: string): TagVars => ({ family, number, sheet: s.sheet, drawing: s.drawingNumber, inst: s.iecInstallation, loc: s.iecLocation });
  if (s.tagMode === 'reference' && ref) {
    const base = formatTag(s.tagFormat, vars(ref));
    if (!used.has(base)) return base;
    for (let i = 1; ; i += 1) {
      const t = `${base}${letterSuffix(i)}`;
      if (!used.has(t)) return t;
    }
  }
  for (let n = Math.max(1, Math.round(s.tagStart)); ; n += 1) {
    const t = formatTag(s.tagFormat, vars(String(n)));
    if (!used.has(t)) return t;
  }
}

/** Convenience: next tag for a block placed at a point of the drawing. */
export function nextTagFor(doc: Drawing, block: string, at: { x: number; y: number }, s: WdSettings): string {
  return nextTag(usedTags(doc), tagPrefix(block), nearestReference(doc, at), s);
}

export interface RetagResult {
  count: number;
  renamed: Map<string, string>;
}

/**
 * RETAG: renumber every parent device in ladder order (top to bottom, left
 * to right) with the drawing's tag format, then rename child contacts and
 * extra poles that carried the old tag. One undo step.
 */
export function retagDrawing(doc: Drawing, s: WdSettings, only?: Set<string>): RetagResult {
  const parents = doc.entities.filter((e): e is InsertEntity => isParentComponent(e) && (!only || only.has(e.id)));
  parents.sort((a, b) => b.position.y - a.position.y || a.position.x - b.position.x);
  const keep = new Set<string>();
  if (only) for (const e of doc.entities) if (isParentComponent(e) && !only.has(e.id) && e.attributes.TAG1) keep.add(e.attributes.TAG1);
  const used = new Set(keep);
  const renamed = new Map<string, string>();
  const newTags = new Map<string, string>();
  for (const p of parents) {
    const family = tagPrefix(p.block);
    const t = nextTag(used, family, nearestReference(doc, p.position), s);
    used.add(t);
    newTags.set(p.id, t);
    if (p.attributes.TAG1 && p.attributes.TAG1 !== t) renamed.set(p.attributes.TAG1, t);
  }
  const parentIds = new Set(parents.map((p) => p.id));
  let count = 0;
  doc.transact((st) => ({
    ...st,
    entities: st.entities.map((e) => {
      if (e.type !== 'insert') return e;
      if (parentIds.has(e.id)) {
        const t = newTags.get(e.id)!;
        if (e.attributes.TAG1 === t) return e;
        count += 1;
        return { ...e, attributes: { ...e.attributes, TAG1: t } };
      }
      if ((isChild(e) || isExtraPole(e)) && e.attributes.TAG1 && renamed.has(e.attributes.TAG1)) {
        count += 1;
        return { ...e, attributes: { ...e.attributes, TAG1: renamed.get(e.attributes.TAG1)! } };
      }
      return e;
    }),
  }));
  return { count, renamed };
}
