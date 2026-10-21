/**
 * The §2 pipeline: paragraph -> items. Bidi levels (UAX #9 via
 * text-bidi), script itemization with Common/Inherited resolution
 * (§2.4), route classification through the UNMODIFIED §7.1 gate
 * (`supportsNativeTextRun`), grapheme integrity and the
 * admitted/shaped hard wall (§2.5). Pure and synchronous: face
 * resolution, coverage splitting against a face, hashing, and all
 * engine contact live in the session (src/app/shape-preparation.ts)
 * and the preparation layer — this module derives everything that
 * does not depend on a face.
 *
 * All offsets are UTF-16 code units. Levels are per CODE POINT;
 * `utf16Offsets` maps between the two.
 */
import { supportsNativeTextRun } from './text-metrics';
import { bidiLevels } from './text-bidi';
import { decodeText, graphemeBoundaries, graphemeEndAtOrAfter } from './text-grapheme';
import { script as scriptOf, scriptExtensions } from './unicode-tables';
import { PIPELINE_DATA_VERSION } from './unicode-tables';

/** §7.3: exactly these features are switched off; everything else
    takes the engine default (including `calt`). One constant for
    every script and direction — the same array instance is frozen
    into every key the session builds. */
export const SHAPING_FEATURES: readonly string[] = Object.freeze([
  'clig=off', 'dlig=off', 'hlig=off', 'kern=off', 'liga=off',
]);

export { PIPELINE_DATA_VERSION };

/** Everything a ShapeKey needs that the pipeline (not the face,
    not the host) decides. The session adds the face binding,
    epoch, capabilities, and the level digests it hashes from
    `levels` (and, for line items, the L1-adjusted line levels). */
export interface ShapedItemDerivation {
  readonly text: string;
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly itemStart: number;
  readonly itemEnd: number;
  /** Resolved script of the item (ISO 15924 code from the pinned
      tables, after §2.4 resolution). */
  readonly script: string;
  readonly direction: 'ltr' | 'rtl';
  /** The item's uniform resolved level (§2.3.3). */
  readonly bidiLevel: number;
  readonly features: readonly string[];
  readonly bufferFlags: readonly ('bot' | 'eot')[];
  readonly defaultIgnorables: 'engine-default-hide';
  readonly pipelineDataVersion: string;
}

export type ItemizedItem =
  | { readonly route: 'direct'; readonly itemStart: number; readonly itemEnd: number }
  | { readonly route: 'shaped'; readonly derivation: ShapedItemDerivation }
  | { readonly route: 'refused'; readonly itemStart: number; readonly itemEnd: number; readonly problem: string };

export interface ItemizedParagraph {
  readonly items: readonly ItemizedItem[];
  /** Per-code-point resolved levels (pre-L1), for the key's
      paragraphLevelsSha256 (hashed by the session). */
  readonly levels: Uint8Array;
  readonly paragraphLevel: 0 | 1;
  readonly codePoints: readonly number[];
  readonly utf16Offsets: readonly number[];
  readonly graphemeBoundaries: readonly number[];
}

const COMMON = 'Zyyy';
const INHERITED = 'Zinh';

/** §2.4 script resolution over one level run (code-point indices
    [runStart, runEnd) into `scripts`), returning one anchor script
    per code point. Inherited was already resolved by the caller
    (paragraph-global); this resolves Common by Script_Extensions
    in the contract's decision order. */
function resolveRunScripts(
  codePoints: readonly number[],
  scripts: readonly string[],
  runStart: number,
  runEnd: number,
): string[] {
  const anchors: string[] = new Array<string>(runEnd - runStart);
  const nextSpecificAfter: (string | null)[] = new Array<string | null>(runEnd - runStart).fill(null);
  let next: string | null = null;
  for (let i = runEnd - 1; i >= runStart; i -= 1) {
    nextSpecificAfter[i - runStart] = next;
    const s = scripts[i]!;
    if (s !== COMMON) next = s;
  }
  let current: string | null = null;
  for (let i = runStart; i < runEnd; i += 1) {
    const s = scripts[i]!;
    if (s !== COMMON) {
      anchors[i - runStart] = s;
      current = s;
      continue;
    }
    const scx = scriptExtensions(codePoints[i]!);
    const following = nextSpecificAfter[i - runStart] ?? null;
    let anchor: string;
    if (current !== null && (scx === null || scx.includes(current))) anchor = current;
    else if (following !== null && scx !== null && scx.includes(following)) anchor = following;
    else if (current !== null) anchor = current;
    else if (following !== null) anchor = following;
    else anchor = COMMON;
    anchors[i - runStart] = anchor;
  }
  return anchors;
}

/**
 * Itemize one paragraph (the whole `text` is the context).
 * When `paragraphLevel` is omitted, P2/P3 decides.
 */
export function itemizeParagraph(
  text: string,
  options?: { readonly paragraphLevel?: 0 | 1 },
): ItemizedParagraph {
  const { codePoints, utf16Offsets } = decodeText(text);
  const boundaries = graphemeBoundaries(text);
  const { levels, paragraphLevel } = bidiLevels(codePoints, options?.paragraphLevel);
  if (codePoints.length === 0) {
    return { items: [], levels, paragraphLevel, codePoints, utf16Offsets, graphemeBoundaries: boundaries };
  }

  // Base scripts, then §2.4.1 Inherited resolution: the script of
  // the preceding character in logical order (paragraph-global —
  // the design's pinned reading of §2.4.1), at a paragraph start
  // of the following character.
  const baseScripts = codePoints.map((cp) => scriptOf(cp));
  const scripts = [...baseScripts];
  let lastScript: string | null = null;
  for (let i = 0; i < scripts.length; i += 1) {
    if (scripts[i] === INHERITED) {
      if (lastScript !== null) scripts[i] = lastScript;
    } else {
      lastScript = scripts[i]!;
    }
  }
  let nextScript: string | null = null;
  for (let i = scripts.length - 1; i >= 0; i -= 1) {
    if (scripts[i] === INHERITED) {
      if (nextScript !== null) scripts[i] = nextScript;
    } else {
      nextScript = scripts[i]!;
    }
  }

  // Level runs, refined by script anchors into items.
  interface RawItem { startCp: number; endCp: number; script: string; level: number }
  const rawItems: RawItem[] = [];
  let runStart = 0;
  while (runStart < codePoints.length) {
    let runEnd = runStart + 1;
    while (runEnd < codePoints.length && levels[runEnd] === levels[runStart]) runEnd += 1;
    const anchors = resolveRunScripts(codePoints, scripts, runStart, runEnd);
    let itemStart = runStart;
    for (let i = runStart + 1; i <= runEnd; i += 1) {
      if (i === runEnd || anchors[i - runStart] !== anchors[itemStart - runStart]) {
        rawItems.push({
          startCp: itemStart,
          endCp: i,
          script: anchors[itemStart - runStart]!,
          level: levels[runStart]!,
        });
        itemStart = i;
      }
    }
    runStart = runEnd;
  }

  // Route classification + derivations.
  const items: ItemizedItem[] = rawItems.map((raw) => {
    const itemStart = utf16Offsets[raw.startCp]!;
    const itemEnd = utf16Offsets[raw.endCp]!;
    const itemText = text.slice(itemStart, itemEnd);
    if (supportsNativeTextRun(itemText)) {
      return { route: 'direct', itemStart, itemEnd } as const;
    }
    const bufferFlags: ('bot' | 'eot')[] = [];
    if (itemStart === 0) bufferFlags.push('bot');
    if (itemEnd === text.length) bufferFlags.push('eot');
    return {
      route: 'shaped',
      derivation: {
        text,
        contextStart: 0,
        contextEnd: text.length,
        itemStart,
        itemEnd,
        script: raw.script,
        direction: raw.level % 2 === 1 ? 'rtl' : 'ltr',
        bidiLevel: raw.level,
        features: SHAPING_FEATURES,
        bufferFlags,
        defaultIgnorables: 'engine-default-hide',
        pipelineDataVersion: PIPELINE_DATA_VERSION,
      },
    } as const;
  });

  // §2.5 hard wall: a grapheme spanning a direct|shaped boundary
  // would have to move across it (mark migration / grapheme
  // integrity) — the shaped side is refused for this capture, with
  // the boundary named. (Script-item edges are grapheme-safe by
  // construction except where Common/Inherited resolution placed
  // a character across its grapheme's edge; the check is cheap and
  // total, so it runs regardless.)
  const boundarySet = new Set(boundaries);
  const walled = items.map((item, index) => {
    if (item.route !== 'shaped') return item;
    const neighbours = [items[index - 1], items[index + 1]];
    for (const neighbour of neighbours) {
      if (!neighbour || neighbour.route === 'shaped') continue;
      const edge = neighbour.itemEnd === item.derivation.itemStart
        ? neighbour.itemEnd
        : neighbour.itemStart === item.derivation.itemEnd
          ? neighbour.itemStart
          : null;
      if (edge !== null && !boundarySet.has(edge)) {
        return {
          route: 'refused',
          itemStart: item.derivation.itemStart,
          itemEnd: item.derivation.itemEnd,
          problem: `protected-boundary: grapheme spans the admitted/shaped boundary at ${edge}`,
        } as const;
      }
    }
    return item;
  });

  return { items: walled, levels, paragraphLevel, codePoints, utf16Offsets, graphemeBoundaries: boundaries };
}

/**
 * §2.5 coverage splitting INSIDE one shaped item: split points
 * where `covered` changes, moved back to grapheme starts per
 * §2.5.1 (a split inside a grapheme assigns the whole grapheme to
 * the earlier subitem). Splits never leave the item. Returns
 * subranges (UTF-16, within the item) each with uniform coverage.
 */
export function splitByCoverage(
  text: string,
  itemStart: number,
  itemEnd: number,
  boundaries: readonly number[],
  covered: (codePoint: number) => boolean,
): readonly { start: number; end: number; covered: boolean }[] {
  const { codePoints, utf16Offsets } = decodeText(text.slice(itemStart, itemEnd));
  if (codePoints.length === 0) return [];
  const runs: { start: number; end: number; covered: boolean }[] = [];
  let runStartCp = 0;
  let runCovered = covered(codePoints[0]!);
  const push = (endCp: number): void => {
    runs.push({
      start: itemStart + utf16Offsets[runStartCp]!,
      end: itemStart + utf16Offsets[endCp]!,
      covered: runCovered,
    });
  };
  for (let i = 1; i <= codePoints.length; i += 1) {
    if (i === codePoints.length || covered(codePoints[i]!) !== runCovered) {
      push(i);
      runStartCp = i;
      if (i < codePoints.length) runCovered = covered(codePoints[i]!);
    }
  }
  // Grapheme integrity (§2.5.1 + mark migration §2.5.2): a run
  // edge inside a grapheme moves FORWARD to the grapheme's end,
  // assigning the whole grapheme to the earlier run — the mark is
  // shaped with its base, in the base's subitem. A run entirely
  // inside one grapheme is absorbed by the earlier run.
  const boundarySet = new Set(boundaries);
  const merged: { start: number; end: number; covered: boolean }[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && !boundarySet.has(run.start)) {
      const graphemeEnd = graphemeEndAtOrAfter(boundaries, run.start);
      if (graphemeEnd >= run.end) {
        previous.end = run.end;
        continue;
      }
      previous.end = graphemeEnd;
      merged.push({ start: graphemeEnd, end: run.end, covered: run.covered });
      continue;
    }
    merged.push({ ...run });
  }
  return merged.filter((run) => run.end > run.start);
}
