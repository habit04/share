/**
 * Command-line AutoComplete ranking (pure logic, unit tested).
 *
 * Mirrors AutoCAD's behaviour: as the user types, commands whose name or alias
 * starts with the text come first, then mid-string matches; recently used
 * commands float to the top of their tier.
 */
export interface CommandInfo {
  name: string;
  aliases: readonly string[];
  description: string;
}

export interface Suggestion {
  /** Canonical command name (what gets submitted). */
  name: string;
  aliases: readonly string[];
  description: string;
  /** The alias that matched when the name itself did not (AutoCAD shows "L (LINE)"). */
  matchedAlias: string | null;
  /** 0 = exact, 1 = prefix, 2 = mid-string. */
  tier: 0 | 1 | 2;
  recent: boolean;
}

function matchTier(candidate: string, q: string): 0 | 1 | 2 | null {
  if (candidate === q) return 0;
  if (candidate.startsWith(q)) return 1;
  if (candidate.includes(q)) return 2;
  return null;
}

/** Text that should never trigger the list: coordinates, numbers, options typed inside a command. */
export function looksLikeCommandText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[-+.@0-9<,]/.test(t)) return false;
  return /^[A-Za-z_?][A-Za-z0-9_-]*$/.test(t.split(/\s+/)[0] ?? '');
}

/**
 * Rank commands for `query`. `recent` is the list of recently run command names,
 * newest first; matches in it come first within each tier.
 */
export function rankSuggestions(query: string, commands: Iterable<CommandInfo>, recent: readonly string[] = [], max = 8): Suggestion[] {
  const q = query.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (!q) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const recentRank = new Map<string, number>();
  recent.forEach((r, i) => {
    const u = r.toUpperCase();
    if (!recentRank.has(u)) recentRank.set(u, i);
  });
  for (const c of commands) {
    const name = c.name.toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name);
    let best: { tier: 0 | 1 | 2; alias: string | null } | null = null;
    const nameTier = matchTier(name, q);
    if (nameTier !== null) best = { tier: nameTier, alias: null };
    for (const a of c.aliases) {
      const t = matchTier(a.toUpperCase(), q);
      if (t !== null && (best === null || t < best.tier)) best = { tier: t, alias: a.toUpperCase() };
    }
    if (!best) continue;
    out.push({ name, aliases: c.aliases, description: c.description, matchedAlias: best.alias, tier: best.tier, recent: recentRank.has(name) });
  }
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ra = recentRank.get(a.name) ?? Infinity;
    const rb = recentRank.get(b.name) ?? Infinity;
    if (ra !== rb) return ra - rb;
    const la = (a.matchedAlias ?? a.name).length;
    const lb = (b.matchedAlias ?? b.name).length;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });
  return out.slice(0, max);
}

/** Cycle an index through `count` items; -1 means "nothing highlighted". */
export function cycleIndex(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** Keep a bounded, de-duplicated list of typed input (newest first). */
export function pushRecentInput(list: readonly string[], text: string, max = 20): string[] {
  const t = text.trim();
  if (!t) return [...list];
  return [t, ...list.filter((x) => x !== t)].slice(0, max);
}
