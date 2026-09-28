/**
 * The complete built-in symbol library: the core JIC and IEC sets plus the
 * extended control, power / PLC / fluid-power and IEC modules. Consumers use
 * this module instead of the individual libraries so every menu, palette,
 * document and report sees the same list.
 */
import type { BlockDef, Entity } from '../core/entities';
import type { DrawingState } from '../core/document';
import { referencedBlocks } from '../tools/blocks';
import { SYMBOL_CATEGORIES, ALL_SYMBOLS, WIRE_DOT } from './symbols';
import type { SymbolCategory } from './symbols';
import { IEC_CATEGORIES, IEC_SYMBOLS } from './iec';
import { JIC_CONTROL_CATEGORIES, JIC_CONTROL_SYMBOLS } from './symbols-jic-control';
import { POWER_FLUID_CATEGORIES, POWER_FLUID_SYMBOLS } from './symbols-power-fluid';
import { IEC_EXTENDED_CATEGORIES, IEC_EXTENDED_SYMBOLS } from './iec-extended';
import { userLibrary, USER_CATEGORY_PREFIX } from './userlib';
// The extended libraries' tag-prefix rules are part of the static table in symbols.ts;
// user symbols (Symbol Builder) register theirs when they are added to the user library.

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

/** Find any built-in or user symbol by block name (block names are upper case; lower-case input is accepted). */
export function findLibrarySymbol(name: string): BlockDef | undefined {
  const builtin = byName.get(name) ?? byName.get(name.toUpperCase());
  if (builtin) return builtin;
  const user = userLibrary.get(name)?.block;
  return user && hasContent(user) ? user : undefined;
}

/** Whether a block name belongs to the built-in library. */
export function isBuiltinSymbol(name: string): boolean {
  return byName.has(name);
}
// An imported user symbol may not shadow a built-in (it would show in two categories and could never be saved).
userLibrary.setReservedNames(isBuiltinSymbol);

/** Whether a block name is a built-in or user library symbol (as opposed to a block private to a drawing). */
export function isLibrarySymbol(name: string): boolean {
  return byName.has(name) || userLibrary.has(name);
}

/** A symbol that can be drawn and inserted (a user entry with neither geometry nor attributes is left out). */
const hasContent = (s: BlockDef): boolean => Array.isArray(s.entities) && Array.isArray(s.attributes) && s.entities.length + s.attributes.length > 0;

/**
 * Categories of one standard, used by the icon menu and tool palettes. The "User: <category>"
 * groups come first (the user's own symbols are what they reach for most), then the built-ins.
 */
export function libraryCategories(standard: 'JIC' | 'IEC'): SymbolCategory[] {
  const builtin = standard === 'IEC' ? IEC_LIBRARY : JIC_LIBRARY;
  const user = userLibrary
    .categoriesOf(standard)
    .map((c) => ({ ...c, symbols: c.symbols.filter(hasContent) }))
    .filter((c) => c.symbols.length > 0);
  return user.length ? [...user, ...builtin] : builtin;
}

/** Category names of one standard without the "IEC: " / "User: " prefixes (Symbol Builder category list). */
export function libraryCategoryNames(standard: 'JIC' | 'IEC'): string[] {
  const out: string[] = [];
  for (const c of libraryCategories(standard)) {
    const n = c.name.replace(/^IEC: /, '').replace(USER_CATEGORY_PREFIX, '');
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Symbols whose name or description contains the query (all categories of the standard). */
export function searchLibrary(standard: 'JIC' | 'IEC', query: string): BlockDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: BlockDef[] = [];
  const seen = new Set<string>();
  for (const c of libraryCategories(standard)) {
    for (const s of c.symbols) {
      if (!s || seen.has(s.name)) continue;
      if (s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) {
        seen.add(s.name);
        out.push(s);
      }
    }
  }
  return out;
}

/** Library size summary for the About tab and reports (user symbols counted with their standard). */
export function librarySummary(): { jic: number; iec: number; total: number; categories: number; user: number } {
  const jicCats = libraryCategories('JIC');
  const iecCats = libraryCategories('IEC');
  const jic = jicCats.reduce((n, c) => n + c.symbols.length, 0);
  const iec = iecCats.reduce((n, c) => n + c.symbols.length, 0);
  return { jic, iec, total: jic + iec, categories: jicCats.length + iecCats.length, user: userLibrary.size };
}

const LIBRARY_NAMES = new Set(LIBRARY_BLOCKS.map((b) => b.name));

/**
 * The state without library blocks (built-in or user) that nothing references. Used when
 * a drawing is written (SAVE, autosave) so a file only carries the symbols it uses;
 * `ensureBlocks` puts the built-in library back when the drawing is opened and user
 * symbols are re-added from the user library when they are inserted.
 *
 * A library block is referenced when an insert in model space, in a referenced block or
 * in any drawing-private block (those are always kept) names it, so a user symbol nested
 * inside another block survives.
 *
 * Not pure: which blocks count as user symbols depends on `userLibrary` having loaded.
 * A drawing saved before `userLibrary.load()` resolves keeps its unused user blocks
 * (they look private); one saved after drops them. Both files open correctly.
 */
export function withoutUnusedLibraryBlocks(state: DrawingState): DrawingState {
  const isLibrary = (name: string) => LIBRARY_NAMES.has(name) || userLibrary.has(name);
  const used = referencedBlocks(state);
  // Private blocks are kept whatever references them, so whatever they reference is used too.
  const visit = (list: readonly Entity[]) => {
    for (const e of list) {
      if (e.type !== 'insert' || used.has(e.block)) continue;
      used.add(e.block);
      const b = state.blocks[e.block];
      if (b) visit(b.entities);
    }
  };
  for (const [name, def] of Object.entries(state.blocks)) if (!isLibrary(name)) visit(def.entities);
  const blocks: Record<string, BlockDef> = {};
  let dropped = 0;
  for (const [name, def] of Object.entries(state.blocks)) {
    if (isLibrary(name) && !used.has(name)) dropped += 1;
    else blocks[name] = def;
  }
  return dropped === 0 ? state : { ...state, blocks };
}
