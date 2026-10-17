/**
 * UAX #29 extended grapheme clusters (Unicode 15.1.0, pinned) —
 * contract v4 §2.5 rule 1. Full GB1–GB999 over the pinned
 * Grapheme_Cluster_Break + Indic_Conjunct_Break +
 * Extended_Pictographic tables; the cheap "marks/surrogates/ZWJ"
 * approximation has verified counterexamples (Hangul Jamo GB6–8,
 * Indic GB9c, Lo SpacingMarks GB9a, Prepend GB9b, RI parity) and is
 * not used. Gated offline against the official
 * GraphemeBreakTest.txt at the pinned version (dev-side full run;
 * a curated subset lives in tests/text-grapheme.test.ts).
 * `Intl.Segmenter` is a dev-test oracle only — its data version is
 * the runtime's, never the pipeline's.
 */
import {
  extendedPictographic,
  graphemeBreak,
  indicConjunctBreak,
  type GraphemeBreak,
} from './unicode-tables';

/** Decode a string into code points with their UTF-16 offsets.
    offsets has one extra entry: offsets[codePoints.length] ===
    text.length. */
export function decodeText(text: string): {
  readonly codePoints: number[];
  readonly utf16Offsets: number[];
} {
  const codePoints: number[] = [];
  const utf16Offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    codePoints.push(char.codePointAt(0)!);
    utf16Offsets.push(offset);
    offset += char.length;
  }
  utf16Offsets.push(text.length);
  return { codePoints, utf16Offsets };
}

const isControl = (gcb: GraphemeBreak): boolean => gcb === 'CN' || gcb === 'CR' || gcb === 'LF';

/** True when there is NO grapheme break between code points
    `before` and `before + 1` (GB rules, in precedence order). */
function glued(
  codePoints: readonly number[],
  gcb: readonly GraphemeBreak[],
  before: number,
): boolean {
  const prev = gcb[before]!;
  const cur = gcb[before + 1]!;
  // GB3: CR x LF
  if (prev === 'CR' && cur === 'LF') return true;
  // GB4 / GB5: break after and before Control/CR/LF.
  if (isControl(prev) || isControl(cur)) return false;
  // GB6: L x (L | V | LV | LVT)
  if (prev === 'L' && (cur === 'L' || cur === 'V' || cur === 'LV' || cur === 'LVT')) return true;
  // GB7: (LV | V) x (V | T)
  if ((prev === 'LV' || prev === 'V') && (cur === 'V' || cur === 'T')) return true;
  // GB8: (LVT | T) x T
  if ((prev === 'LVT' || prev === 'T') && cur === 'T') return true;
  // GB9: x (Extend | ZWJ)
  if (cur === 'EX' || cur === 'ZWJ') return true;
  // GB9a: x SpacingMark
  if (cur === 'SM') return true;
  // GB9b: Prepend x
  if (prev === 'PP') return true;
  // GB9c: Consonant (Extend | Linker)* x Consonant (InCB), where the
  // run before the boundary contains at least one Linker — trailing
  // Extend-class characters (ZWJ carries InCB Extend) may follow
  // the Linker, as the official test's KA VIRAMA ZWJ TA case pins.
  if (indicConjunctBreak(codePoints[before + 1]!) === 'Consonant') {
    let sawLinker = false;
    for (let i = before; i >= 0; i -= 1) {
      const incb = indicConjunctBreak(codePoints[i]!);
      if (incb === 'Linker') { sawLinker = true; continue; }
      if (incb === 'Extend') continue;
      if (incb === 'Consonant') { if (sawLinker) return true; break; }
      break;
    }
  }
  // GB11: Extended_Pictographic Extend* ZWJ x Extended_Pictographic.
  if (prev === 'ZWJ' && extendedPictographic(codePoints[before + 1]!)) {
    for (let i = before - 1; i >= 0; i -= 1) {
      if (gcb[i] === 'EX') continue;
      if (extendedPictographic(codePoints[i]!)) return true;
      break;
    }
  }
  // GB12/GB13: (RI RI)* RI x RI — glued while the RI run behind
  // the boundary has odd length.
  if (prev === 'RI' && cur === 'RI') {
    let run = 0;
    for (let i = before; i >= 0 && gcb[i] === 'RI'; i -= 1) run += 1;
    if (run % 2 === 1) return true;
  }
  // GB999: break.
  return false;
}

/** Grapheme boundaries as CODE-POINT indices (0 and length included,
    sorted). */
export function graphemeBoundaryIndices(codePoints: readonly number[]): number[] {
  const gcb = codePoints.map((cp) => graphemeBreak(cp));
  const boundaries = [0];
  for (let i = 0; i + 1 < codePoints.length; i += 1) {
    if (!glued(codePoints, gcb, i)) boundaries.push(i + 1);
  }
  if (codePoints.length > 0) boundaries.push(codePoints.length);
  return boundaries;
}

/** Grapheme boundaries as UTF-16 offsets into `text` (0 and
    text.length included, sorted). */
export function graphemeBoundaries(text: string): number[] {
  const { codePoints, utf16Offsets } = decodeText(text);
  return graphemeBoundaryIndices(codePoints).map((index) => utf16Offsets[index]!);
}

/** The §2.5.1 primitive: the start (UTF-16) of the grapheme that
    contains or precedes `offset` — a split proposed at `offset`
    moves back to this value. */
export function graphemeStartAtOrBefore(
  boundaries: readonly number[],
  offset: number,
): number {
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary > offset) break;
    start = boundary;
  }
  return start;
}

/** Whether `offset` (UTF-16) is a grapheme boundary. */
export function isGraphemeBoundary(boundaries: readonly number[], offset: number): boolean {
  return boundaries.includes(offset);
}

/** The end (UTF-16) of the grapheme containing `offset`: the
    first boundary strictly after it (or the last boundary when
    `offset` is at/past the end). A split proposed inside a
    grapheme moves here so the whole grapheme is assigned to the
    EARLIER item (§2.5.1/§2.5.2 — the mark is shaped with its
    base, in the base's item). */
export function graphemeEndAtOrAfter(boundaries: readonly number[], offset: number): number {
  for (const boundary of boundaries) {
    if (boundary > offset) return boundary;
  }
  return boundaries[boundaries.length - 1] ?? offset;
}
