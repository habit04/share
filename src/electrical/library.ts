/**
 * The complete built-in symbol library: the core JIC and IEC sets plus the
 * extended control, power / PLC / fluid-power and IEC modules. Consumers use
 * this module instead of the individual libraries so every menu, palette,
 * document and report sees the same list.
 */
import type { BlockDef } from '../core/entities';
import { SYMBOL_CATEGORIES, ALL_SYMBOLS, WIRE_DOT, registerTagPrefixes } from './symbols';
import type { SymbolCategory } from './symbols';
import { IEC_CATEGORIES, IEC_SYMBOLS } from './iec';
import { JIC_CONTROL_CATEGORIES, JIC_CONTROL_SYMBOLS, JIC_CONTROL_TAG_PREFIXES } from './symbols-jic-control';
import { POWER_FLUID_CATEGORIES, POWER_FLUID_SYMBOLS, POWER_FLUID_TAG_PREFIXES } from './symbols-power-fluid';
import { IEC_EXTENDED_CATEGORIES, IEC_EXTENDED_SYMBOLS, IEC_EXTENDED_TAG_PREFIXES } from './iec-extended';

// Family rules of the extended libraries take precedence over the core table
// (registration order: the first matching rule wins, so the most specific sets go first).
registerTagPrefixes([...POWER_FLUID_TAG_PREFIXES, ...JIC_CONTROL_TAG_PREFIXES, ...IEC_EXTENDED_TAG_PREFIXES]);

/** JIC (NFPA 79 ladder) categories: core set first, then the extended sets. */
export const JIC_LIBRARY: SymbolCategory[] = [...SYMBOL_CATEGORIES, ...JIC_CONTROL_CATEGORIES, ...POWER_FLUID_CATEGORIES];
/** IEC 60617 categories: core set first, then the extended set. */
export const IEC_LIBRARY: SymbolCategory[] = [...IEC_CATEGORIES, ...IEC_EXTENDED_CATEGORIES];

/** Every schematic symbol block (JIC + IEC), excluding the junction dot. */
export const LIBRARY_SYMBOLS: BlockDef[] = [
  ...ALL_SYMBOLS.filter((s) => s.name !== WIRE_DOT.name),
  ...JIC_CONTROL_SYMBOLS,
  ...POWER_FLUID_SYMBOLS,
  ...IEC_SYMBOLS,
  ...IEC_EXTENDED_SYMBOLS,
];

/** Blocks a drawing needs so any library symbol can be inserted (includes the junction dot). */
export const LIBRARY_BLOCKS: BlockDef[] = [...LIBRARY_SYMBOLS, WIRE_DOT];

const byName = new Map<string, BlockDef>();
for (const s of LIBRARY_BLOCKS) if (!byName.has(s.name)) byName.set(s.name, s);

/** Find any built-in symbol by block name (case-insensitive). */
export function findLibrarySymbol(name: string): BlockDef | undefined {
  return byName.get(name) ?? byName.get(name.toUpperCase());
}

/** Categories of one standard, used by the icon menu and tool palettes. */
export function libraryCategories(standard: 'JIC' | 'IEC'): SymbolCategory[] {
  return standard === 'IEC' ? IEC_LIBRARY : JIC_LIBRARY;
}

/** Symbols whose name or description contains the query (all categories of the standard). */
export function searchLibrary(standard: 'JIC' | 'IEC', query: string): BlockDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: BlockDef[] = [];
  const seen = new Set<string>();
  for (const c of libraryCategories(standard)) {
    for (const s of c.symbols) {
      if (seen.has(s.name)) continue;
      if (s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) {
        seen.add(s.name);
        out.push(s);
      }
    }
  }
  return out;
}

/** Library size summary for the About tab and reports. */
export function librarySummary(): { jic: number; iec: number; total: number; categories: number } {
  const jic = JIC_LIBRARY.reduce((n, c) => n + c.symbols.length, 0);
  const iec = IEC_LIBRARY.reduce((n, c) => n + c.symbols.length, 0);
  return { jic, iec, total: jic + iec, categories: JIC_LIBRARY.length + IEC_LIBRARY.length };
}
