/**
 * Parts catalog: a built-in JSON database of generic parts per family
 * (manufacturers and catalog numbers are invented) plus an optional user
 * catalog loaded from a JSON file named in the project settings. The
 * Catalog Browser searches it to fill MFG / CAT / DESC on a component.
 */
import builtin from './catalog.json';

export interface CatalogItem {
  family: string;
  mfg: string;
  cat: string;
  desc: string;
  rating?: string;
  /** NO / NC for contact-style parts, so the browser can prefer the matching variant. */
  type?: string;
  assycode?: string;
  /** Where the item came from. */
  source?: 'builtin' | 'user';
}

function normalise(raw: unknown, source: 'builtin' | 'user'): CatalogItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
    const family = str('family').toUpperCase();
    const cat = str('cat');
    if (!cat) continue;
    out.push({ family, mfg: str('mfg').toUpperCase(), cat: cat.toUpperCase(), desc: str('desc').toUpperCase(), rating: str('rating') || undefined, type: str('type') || undefined, assycode: str('assycode') || undefined, source });
  }
  return out;
}

export const BUILTIN_CATALOG: CatalogItem[] = normalise(builtin, 'builtin');

let userCatalog: CatalogItem[] = [];

/** Parse a user catalog file (JSON array of items, or {"items": [...]}). Throws on malformed input. */
export function parseCatalog(text: string): CatalogItem[] {
  const raw = JSON.parse(text) as unknown;
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!arr) throw new Error('Catalog file must be a JSON array of parts');
  return normalise(arr, 'user');
}

/** Install (or clear) the user catalog. User items are searched before the built-in ones. */
export function setUserCatalog(items: CatalogItem[]): void {
  userCatalog = items;
}

export function userCatalogSize(): number {
  return userCatalog.length;
}

export function allCatalogItems(): CatalogItem[] {
  return [...userCatalog, ...BUILTIN_CATALOG];
}

export function catalogFamilies(items: CatalogItem[] = allCatalogItems()): string[] {
  return [...new Set(items.map((i) => i.family))].sort();
}

export interface CatalogQuery {
  family?: string;
  /** Free text matched against catalog number, manufacturer and description (all words must match). */
  text?: string;
  /** Prefer NO / NC parts (moved to the top, not filtered). */
  type?: string;
}

/** Search the catalog. Families are matched exactly; text is a case-insensitive all-words match. */
export function searchCatalog(q: CatalogQuery, items: CatalogItem[] = allCatalogItems()): CatalogItem[] {
  const fam = q.family?.trim().toUpperCase();
  const words = (q.text ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  const out = items.filter((i) => {
    if (fam && i.family !== fam) return false;
    if (words.length === 0) return true;
    const hay = `${i.cat} ${i.mfg} ${i.desc} ${i.rating ?? ''}`.toUpperCase();
    return words.every((w) => hay.includes(w));
  });
  if (q.type) {
    const t = q.type.toUpperCase();
    out.sort((a, b) => Number(b.type === t) - Number(a.type === t));
  }
  return out;
}

/** Exact lookup by manufacturer + catalog number. */
export function findCatalogItem(mfg: string, cat: string, items: CatalogItem[] = allCatalogItems()): CatalogItem | undefined {
  const m = mfg.trim().toUpperCase();
  const c = cat.trim().toUpperCase();
  return items.find((i) => i.cat === c && (!m || i.mfg === m));
}

/** Families that can share a catalog family (e.g. IEC 'S' push buttons use the PB catalog). */
export function catalogFamilyFor(family: string): string {
  const map: Record<string, string> = { S: 'PB', K: 'CR', KM: 'M', KT: 'TD', Q: 'CB', F: 'FU', P: 'LT', X: 'TB', Y: 'SV', G: 'BT', V: 'D', E: 'HTR' };
  return map[family] ?? family;
}
