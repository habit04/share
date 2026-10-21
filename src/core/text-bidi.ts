/**
 * UAX #9 (Unicode 15.1.0, pinned) level resolution for the shaping
 * pipeline — contract v4 §2.3. Produces the per-code-point resolved
 * embedding levels of ONE paragraph (P1 paragraph splitting is the
 * caller's; the text handed here is one context string).
 *
 * Scope (design ENGINE-STEP2B-DESIGN): P2/P3 first-strong paragraph
 * level, X1–X8 explicit embeddings/overrides/isolates, X9 removal
 * classification (removed characters keep their positions and their
 * explicit levels in the output array; consumers account for them
 * via §4 uncovered, they simply take no part in W/N/I), X10 isolating
 * run sequences, W1–W7 weak resolution, N0 bracket pairs via BD16,
 * N1/N2 neutrals, I1/I2 implicit levels, and L1 as a separate
 * per-line adjustment (paragraph levels are computed WITHOUT L1;
 * line items apply it to their range, §2.6/§3.1). L2 visual order
 * is the engine's business and is not computed here; mirroring is
 * likewise engine-side (§5.4/§6 render from glyphs).
 *
 * Correctness is gated offline against the official
 * BidiCharacterTest.txt at the pinned version (dev-side full run;
 * a curated subset lives in tests/text-bidi.test.ts).
 */
import { bidiBracket, bidiBracketMatchKey, bidiClass, type BidiClass } from './unicode-tables';

const MAX_DEPTH = 125;
const MAX_BRACKET_PAIRS = 63;

export interface BidiLevels {
  /** One resolved level per input code point (X9-removed characters
      included, carrying their explicit levels). */
  readonly levels: Uint8Array;
  readonly paragraphLevel: 0 | 1;
  /** True for characters X9 removes from W/N/I processing
      (embeddings, overrides, PDF, and BN). */
  readonly removedByX9: Uint8Array;
}

type Override = 'neutral' | 'L' | 'R';

interface StackEntry {
  readonly level: number;
  readonly override: Override;
  readonly isolate: boolean;
}

const isIsolateInitiator = (type: BidiClass): boolean =>
  type === 'LRI' || type === 'RLI' || type === 'FSI';

/** Least greater even/odd level (X2/X3/X4/X5 helpers). */
const leastGreaterOdd = (level: number): number => (level % 2 === 1 ? level + 2 : level + 1);
const leastGreaterEven = (level: number): number => (level % 2 === 0 ? level + 2 : level + 1);

/** P2/P3: the paragraph embedding level from the first strong type. */
function firstStrongLevel(types: readonly BidiClass[]): 0 | 1 {
  let isolateDepth = 0;
  for (const type of types) {
    if (isIsolateInitiator(type)) isolateDepth += 1;
    else if (type === 'PDI') { if (isolateDepth > 0) isolateDepth -= 1; }
    else if (isolateDepth === 0) {
      if (type === 'L') return 0;
      if (type === 'R' || type === 'AL') return 1;
    }
  }
  return 0;
}

interface ExplicitResult {
  readonly levels: Uint8Array;
  readonly types: BidiClass[]; // working types after X6 overrides
  readonly removedByX9: Uint8Array;
  /** For each isolate initiator index, its matching PDI index (-1). */
  readonly matchingPdi: Int32Array;
  /** For each PDI index, its matching initiator index (-1). */
  readonly matchingInitiator: Int32Array;
}

/** X1–X9: explicit levels, override application, removal flags. */
function explicitLevels(
  types: readonly BidiClass[],
  paragraphLevel: 0 | 1,
): ExplicitResult {
  const count = types.length;
  const levels = new Uint8Array(count);
  const working = [...types];
  const removed = new Uint8Array(count);
  const matchingPdi = new Int32Array(count).fill(-1);
  const matchingInitiator = new Int32Array(count).fill(-1);
  const stack: StackEntry[] = [{ level: paragraphLevel, override: 'neutral', isolate: false }];
  /** Initiator indices of isolate entries currently on the stack. */
  const isolateStack: number[] = [];
  let overflowIsolate = 0;
  let overflowEmbedding = 0;
  let validIsolates = 0;

  const currentLevel = (): number => stack[stack.length - 1]!.level;
  const currentOverride = (): Override => stack[stack.length - 1]!.override;


  for (let i = 0; i < count; i += 1) {
    const type = types[i]!;
    switch (type) {
      case 'RLE': case 'LRE': case 'RLO': case 'LRO': {
        // X2/X3/X4/X5
        const odd = type === 'RLE' || type === 'RLO';
        const newLevel = odd ? leastGreaterOdd(currentLevel()) : leastGreaterEven(currentLevel());
        levels[i] = currentLevel();
        removed[i] = 1;
        if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          const override: Override = type === 'RLO' ? 'R' : type === 'LRO' ? 'L' : 'neutral';
          stack.push({ level: newLevel, override, isolate: false });
        } else if (overflowIsolate === 0) {
          overflowEmbedding += 1;
        }
        break;
      }
      case 'RLI': case 'LRI': case 'FSI': {
        // X5a/X5b/X5c: the initiator takes the current level (X6
        // below applies override to its TYPE for later rules).
        levels[i] = currentLevel();
        const override = currentOverride();
        if (override !== 'neutral') working[i] = override;
        // Determine the isolate's inner level: FSI resolves by the
        // first strong inside it (P2-style scan to its matching PDI).
        let innerType: 'L' | 'R' = type === 'LRI' ? 'L' : 'R';
        // X5c: FSI follows its first strong type; with NO strong
        // type inside (e.g. only AN digits), it behaves as LRI —
        // conformance pins this (an AN inside an FSI in an LRO
        // scope lands on an even inner level).
        if (type === 'FSI') innerType = firstStrongInside(types, i) === 'R' ? 'R' : 'L';
        const newLevel = innerType === 'R' ? leastGreaterOdd(currentLevel()) : leastGreaterEven(currentLevel());
        if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
          stack.push({ level: newLevel, override: 'neutral', isolate: true });
          isolateStack.push(i);
          validIsolates += 1;
        } else {
          overflowIsolate += 1;
        }
        break;
      }
      case 'PDI': {
        // X6a: a PDI matched to a valid isolate takes the level of
        // the scope OUTSIDE the isolate (the stack entry below the
        // isolate entry it is about to pop); an unmatched PDI takes
        // the current level.
        levels[i] = currentLevel();
        if (overflowIsolate === 0 && validIsolates > 0) {
          for (let s = stack.length - 1; s >= 1; s -= 1) {
            if (stack[s]!.isolate) { levels[i] = stack[s - 1]!.level; break; }
          }
        }
        if (overflowIsolate > 0) {
          overflowIsolate -= 1;
        } else if (validIsolates > 0) {
          overflowEmbedding = 0;
          // Pop up to and including the last isolate entry.
          while (stack.length > 1) {
            const entry = stack.pop()!;
            if (entry.isolate) break;
          }
          const initiator = isolateStack.pop();
          if (initiator !== undefined) {
            matchingPdi[initiator] = i;
            matchingInitiator[i] = initiator;
            validIsolates -= 1;
          }
        }
        break;
      }
      case 'PDF': {
        // X7
        levels[i] = currentLevel();
        removed[i] = 1;
        if (overflowIsolate > 0) {
          // PDF inside an overflow isolate does nothing (X7 via X6a scope).
        } else if (overflowEmbedding > 0) {
          overflowEmbedding -= 1;
        } else if (validIsolates === 0 && stack.length >= 2) {
          stack.pop();
        }
        break;
      }
      case 'B': {
        // X8
        levels[i] = paragraphLevel;
        stack.length = 1;
        overflowIsolate = 0;
        overflowEmbedding = 0;
        validIsolates = 0;
        isolateStack.length = 0;
        break;
      }
      case 'BN': {
        levels[i] = currentLevel();
        removed[i] = 1;
        break;
      }
      default: {
        // X6
        levels[i] = currentLevel();
        const override = currentOverride();
        if (override !== 'neutral') working[i] = override;
        break;
      }
    }
  }
  return { levels, types: working, removedByX9: removed, matchingPdi, matchingInitiator };
}

/** First strong (L/R/AL) inside the isolate starting at `start`,
    for FSI resolution (X5c): scans to the matching PDI at the same
    nesting, ignoring nested isolates' contents for strong purposes
    per P2's isolate skipping. */
function firstStrongInside(types: readonly BidiClass[], start: number): 'L' | 'R' | null {
  let depth = 0;
  for (let i = start + 1; i < types.length; i += 1) {
    const type = types[i]!;
    if (isIsolateInitiator(type)) depth += 1;
    else if (type === 'PDI') {
      if (depth === 0) return null;
      depth -= 1;
    } else if (depth === 0) {
      if (type === 'L') return 'L';
      if (type === 'R' || type === 'AL') return 'R';
    }
  }
  return null;
}

/** BD7/X10: isolating run sequences over the X9-filtered sequence.
    Each sequence is a list of original indices in logical order. */
function isolatingRunSequences(
  count: number,
  levels: Uint8Array,
  removed: Uint8Array,
  types: readonly BidiClass[],
  matchingPdi: Int32Array,
): number[][] {
  // `types` here are the ORIGINAL bidi classes: X6 overrides may
  // have rewritten an initiator's working type (e.g. LRI inside an
  // RLO scope reads R), and BD13 chaining keys on the character
  // being an initiator, not on its overridden type.
  // Level runs over the filtered sequence.
  const filtered: number[] = [];
  for (let i = 0; i < count; i += 1) if (removed[i] === 0) filtered.push(i);
  const runs: number[][] = [];
  for (const index of filtered) {
    const last = runs[runs.length - 1];
    if (last && levels[last[last.length - 1]!] === levels[index]) last.push(index);
    else runs.push([index]);
  }
  const sequences: number[][] = [];
  const consumed = new Set<number>();
  for (let r = 0; r < runs.length; r += 1) {
    if (consumed.has(r)) continue;
    const sequence = [...runs[r]!];
    consumed.add(r);
    // Extend (BD13): while the sequence's last char is an isolate
    // initiator with a matching PDI, append THE LEVEL RUN THAT
    // CONTAINS the matching PDI — not necessarily the next run:
    // the isolate's content runs sit between them in run order.
    for (;;) {
      const lastIndex = sequence[sequence.length - 1]!;
      if (!isIsolateInitiator(types[lastIndex]!)) break;
      const pdi = matchingPdi[lastIndex]!;
      if (pdi < 0) break;
      const target = runs.findIndex((run, idx) => !consumed.has(idx) && run[0] === pdi);
      if (target < 0) break;
      consumed.add(target);
      sequence.push(...runs[target]!);
    }
    sequences.push(sequence);
  }
  return sequences;
}

/** sos/eos strong types for a sequence (X10). */
function sequenceEdges(
  sequence: readonly number[],
  levels: Uint8Array,
  paragraphLevel: 0 | 1,
  allLevels: Uint8Array,
  filteredPosition: Map<number, number>,
  filtered: readonly number[],
): { sos: 'L' | 'R'; eos: 'L' | 'R' } {
  const first = sequence[0]!;
  const last = sequence[sequence.length - 1]!;
  const levelBefore = (index: number): number => {
    const pos = filteredPosition.get(index)!;
    return pos > 0 ? allLevels[filtered[pos - 1]!]! : paragraphLevel;
  };
  const levelAfter = (index: number): number => {
    const pos = filteredPosition.get(index)!;
    return pos < filtered.length - 1 ? allLevels[filtered[pos + 1]!]! : paragraphLevel;
  };
  const sosLevel = Math.max(levels[first]!, levelBefore(first));
  const eosLevel = Math.max(levels[last]!, levelAfter(last));
  return {
    sos: sosLevel % 2 === 1 ? 'R' : 'L',
    eos: eosLevel % 2 === 1 ? 'R' : 'L',
  };
}

const isStrong = (type: BidiClass): type is 'L' | 'R' | 'AL' =>
  type === 'L' || type === 'R' || type === 'AL';

/** W1–W7 over one isolating run sequence (types are mutated in place
    on the sequence's working copy). */
function resolveWeak(
  seqTypes: BidiClass[],
  sos: 'L' | 'R',
): void {
  // W1: NSM takes the preceding type (sos at the start).
  for (let i = 0; i < seqTypes.length; i += 1) {
    if (seqTypes[i] === 'NSM') seqTypes[i] = i === 0 ? sos : seqTypes[i - 1]!;
  }
  // W2: EN after AL becomes AN (search backward to first strong).
  for (let i = 0; i < seqTypes.length; i += 1) {
    if (seqTypes[i] === 'EN') {
      for (let j = i - 1; j >= -1; j -= 1) {
        const back = j === -1 ? sos : seqTypes[j]!;
        if (isStrong(back)) {
          if (back === 'AL') seqTypes[i] = 'AN';
          break;
        }
      }
    }
  }
  // W3: ALETFs... (all AL become R — W3: change all ALs to R.)
  for (let i = 0; i < seqTypes.length; i += 1) if (seqTypes[i] === 'AL') seqTypes[i] = 'R';
  // W4: single separators between numbers.
  for (let i = 1; i < seqTypes.length - 1; i += 1) {
    const type = seqTypes[i]!;
    if (type === 'ES' && seqTypes[i - 1] === 'EN' && seqTypes[i + 1] === 'EN') seqTypes[i] = 'EN';
    else if (type === 'CS') {
      if (seqTypes[i - 1] === 'EN' && seqTypes[i + 1] === 'EN') seqTypes[i] = 'EN';
      else if (seqTypes[i - 1] === 'AN' && seqTypes[i + 1] === 'AN') seqTypes[i] = 'AN';
    }
  }
  // W5: a run of ET adjacent to EN becomes EN.
  for (let i = 0; i < seqTypes.length; i += 1) {
    if (seqTypes[i] !== 'ET') continue;
    let j = i;
    while (j < seqTypes.length && seqTypes[j] === 'ET') j += 1;
    const before = i === 0 ? sos : seqTypes[i - 1]!;
    const after = j < seqTypes.length ? seqTypes[j]! : null;
    if (before === 'EN' || after === 'EN') {
      for (let k = i; k < j; k += 1) seqTypes[k] = 'EN';
    }
    i = j - 1;
  }
  // W6: remaining separators/terminators become ON.
  for (let i = 0; i < seqTypes.length; i += 1) {
    if (seqTypes[i] === 'ES' || seqTypes[i] === 'ET' || seqTypes[i] === 'CS') seqTypes[i] = 'ON';
  }
  // W7: EN after L becomes L.
  for (let i = 0; i < seqTypes.length; i += 1) {
    if (seqTypes[i] === 'EN') {
      for (let j = i - 1; j >= -1; j -= 1) {
        const back = j === -1 ? sos : seqTypes[j]!;
        if (back === 'L' || back === 'R') {
          if (back === 'L') seqTypes[i] = 'L';
          break;
        }
      }
    }
  }
}

/** Characters N1/N2 resolve. Isolate initiators and PDIs reach
    this function already mapped to 'ON' (context); the caller's
    `fixed` mask keeps their own entries from being rewritten. */
const isNeutralOrIsolate = (type: BidiClass): boolean =>
  type === 'B' || type === 'S' || type === 'WS' || type === 'ON';

/** BD16: bracket pairs within one sequence (positions in the
    sequence). Returns pairs [openPos, closePos] in text order.
    Matching compares canonical-equivalence keys on both sides
    (BD16's "or its canonical equivalent"), and an opening bracket
    found with a full stack STOPS BD16 processing for the rest of
    the sequence — pairs already found stand, nothing more forms. */
function bracketPairs(
  sequence: readonly number[],
  seqTypes: readonly BidiClass[],
  codePoints: readonly number[],
): [number, number][] {
  const pairs: [number, number][] = [];
  const stack: { position: number; pairKey: number }[] = [];
  for (let pos = 0; pos < sequence.length; pos += 1) {
    if (seqTypes[pos] !== 'ON') continue;
    const cp = codePoints[sequence[pos]!]!;
    const bracket = bidiBracket(cp);
    if (!bracket) continue;
    if (bracket.open) {
      if (stack.length >= MAX_BRACKET_PAIRS) break;
      stack.push({ position: pos, pairKey: bidiBracketMatchKey(bracket.pair) });
    } else {
      const closeKey = bidiBracketMatchKey(cp);
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s]!.pairKey === closeKey) {
          pairs.push([stack[s]!.position, pos]);
          stack.length = s;
          break;
        }
      }
    }
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/** N0: resolve bracket pairs; then N1/N2 over the sequence.
    `originalTypes` are the sequence's types BEFORE W1 rewrote NSMs
    (N0's closing rule retypes an NSM that follows a resolved
    bracket, and only the original type still identifies it). */
function resolveNeutral(
  seqTypes: BidiClass[],
  sequence: readonly number[],
  codePoints: readonly number[],
  sos: 'L' | 'R',
  eos: 'L' | 'R',
  embeddingDirection: 'L' | 'R',
  originalTypes: readonly BidiClass[],
  fixed: readonly boolean[],
): void {
  // N0
  const pairs = bracketPairs(sequence, seqTypes, codePoints);
  // N0 scope (tr9-46): within N0, EN and AN are treated as R.
  const n0StrongDir = (type: BidiClass): 'L' | 'R' | null =>
    type === 'L' ? 'L' : type === 'R' || type === 'EN' || type === 'AN' ? 'R' : null;
  for (const [openPos, closePos] of pairs) {
    // N0 (verbatim structure, UAX #9 tr9-46): inspect the enclosed
    // strong types.
    let action: 'embedding' | 'opposite' | null = null;
    let oppositeInside = false;
    for (let pos = openPos + 1; pos < closePos; pos += 1) {
      const strongDir = n0StrongDir(seqTypes[pos]!);
      if (strongDir !== null) {
        if (strongDir === embeddingDirection) { action = 'embedding'; break; }
        oppositeInside = true;
      }
    }
    if (action === null && oppositeInside) {
      // There is a strong inside and it is opposite: the pair takes
      // the opposite direction only when the established context
      // (first strong searching backwards from the opening bracket,
      // sos at the boundary) is also opposite; otherwise the pair
      // takes the embedding direction.
      let preceded: 'L' | 'R' | null = null;
      for (let pos = openPos - 1; pos >= -1; pos -= 1) {
        const strongDir = pos === -1 ? sos : n0StrongDir(seqTypes[pos]!);
        if (strongDir !== null) { preceded = strongDir; break; }
      }
      action = preceded !== null && preceded !== embeddingDirection ? 'opposite' : 'embedding';
    }
    // No strong inside at all: the pair is NOT set by N0 — its
    // brackets resolve individually under N1/N2.
    if (action !== null) {
      const resolved = action === 'embedding' ? embeddingDirection : (embeddingDirection === 'L' ? 'R' : 'L');
      seqTypes[openPos] = resolved;
      seqTypes[closePos] = resolved;
      // An NSM following a resolved bracket takes its type (N0) —
      // identified by its ORIGINAL type, W1 having already run.
      for (const pos of [openPos, closePos]) {
        if (pos + 1 < seqTypes.length && originalTypes[pos + 1] === 'NSM') seqTypes[pos + 1] = resolved;
      }
    }
  }
  // N1/N2: neutral runs take the surrounding strong direction when
  // both agree (numbers count as R), else the embedding direction.
  const strongDirOf = (type: BidiClass): 'L' | 'R' | null => {
    if (type === 'L') return 'L';
    if (type === 'R' || type === 'EN' || type === 'AN') return 'R';
    return null;
  };
  let i = 0;
  while (i < seqTypes.length) {
    if (!isNeutralOrIsolate(seqTypes[i]!)) { i += 1; continue; }
    let j = i;
    while (j < seqTypes.length && isNeutralOrIsolate(seqTypes[j]!)) j += 1;
    let before = i === 0 ? sos : (strongDirOf(seqTypes[i - 1]!) ?? (sos));
    let after = j >= seqTypes.length ? eos : (strongDirOf(seqTypes[j]!) ?? eos);
    // A neutral run that IS the whole sequence and consists only
    // of isolate initiators/PDIs (an initiator and its matching
    // PDI with nothing else in the sequence) is not steered by
    // sos/eos: conformance shows the pair keeps its explicit
    // levels, which is exactly resolution to the embedding
    // direction. Runs with in-sequence strong flanks (or any
    // non-isolate member) resolve normally.
    if (i === 0 && j === seqTypes.length
      && seqTypes.every((_, k) => isIsolateInitiator(originalTypes[k]!) || originalTypes[k] === 'PDI')) {
      before = embeddingDirection;
      after = embeddingDirection;
    }
    const resolved = before === after ? before : embeddingDirection;
    for (let k = i; k < j; k += 1) if (!fixed[k]) seqTypes[k] = resolved;
    i = j;
  }
}

/**
 * Resolve the embedding levels of one paragraph.
 * `codePoints` are the paragraph's code points in logical order.
 * When `paragraphLevel` is omitted, P2/P3 decides from the first
 * strong character outside any isolate.
 */
export function bidiLevels(
  codePoints: readonly number[],
  paragraphLevel?: 0 | 1,
): BidiLevels {
  const count = codePoints.length;
  if (count === 0) {
    return { levels: new Uint8Array(0), paragraphLevel: paragraphLevel ?? 0, removedByX9: new Uint8Array(0) };
  }
  const types: BidiClass[] = codePoints.map((cp) => bidiClass(cp));
  const paraLevel = paragraphLevel ?? firstStrongLevel(types);
  const explicit = explicitLevels(types, paraLevel);
  const levels = explicit.levels;
  const removed = explicit.removedByX9;

  const filtered: number[] = [];
  const filteredPosition = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    if (removed[i] === 0) {
      filteredPosition.set(i, filtered.length);
      filtered.push(i);
    }
  }
  const sequences = isolatingRunSequences(count, levels, removed, types, explicit.matchingPdi);
  // X10's sos/eos are computed from the levels assigned by X1–X8 —
  // a snapshot, because the loop below raises levels in place and
  // later sequences must not see raised neighbour levels.
  const explicitSnapshot = new Uint8Array(levels);
  for (const sequence of sequences) {
    const { sos, eos } = sequenceEdges(sequence, explicitSnapshot, paraLevel, explicitSnapshot, filteredPosition, filtered);
    const originalTypes = sequence.map((index) => types[index]!);
    const workingTypes = sequence.map((index) => explicit.types[index]!);
    // Isolate initiators and PDIs are treated as ON neutrals
    // within their sequence (X9 note): they resolve under W/N and
    // raise under I1/I2 like any neutral — the bulk of the
    // conformance isolate cases require exactly that.
    const fixed = originalTypes.map(() => false);
    const seqTypes = workingTypes.map((type, pos) => (isIsolateInitiator(originalTypes[pos]!) || originalTypes[pos] === 'PDI' ? 'ON' : type)) as BidiClass[];
    resolveWeak(seqTypes, sos);
    const firstLevel = levels[sequence[0]!]!;
    const embeddingDirection: 'L' | 'R' = firstLevel % 2 === 1 ? 'R' : 'L';
    resolveNeutral(seqTypes, sequence, codePoints, sos, eos, embeddingDirection, originalTypes, fixed);
    // I1/I2: raise levels by resolved type.
    for (let pos = 0; pos < sequence.length; pos += 1) {
      if (fixed[pos]) continue;
      const index = sequence[pos]!;
      const type = seqTypes[pos]!;
      const level = levels[index]!;
      if (level % 2 === 0) {
        // Even (LTR) embedding: R, EN, AN go up.
        if (type === 'R') levels[index] = level + 1;
        else if (type === 'AN' || type === 'EN') levels[index] = level + 2;
      } else {
        // Odd (RTL) embedding: L, EN, AN go up one.
        if (type === 'L' || type === 'EN' || type === 'AN') levels[index] = level + 1;
      }
    }
  }
  return { levels, paragraphLevel: paraLevel, removedByX9: removed };
}

/**
 * L1 for one line range: returns the L1-adjusted levels of
 * code points [start, end) (a copy of that range's levels with
 * trailing whitespace/segment separators — and any character whose
 * original type is B or S — reset to the paragraph level).
 */
export function l1AdjustedLevels(
  codePoints: readonly number[],
  levels: Uint8Array,
  paragraphLevel: 0 | 1,
  start: number,
  end: number,
): Uint8Array {
  const result = new Uint8Array(levels.subarray(start, end));
  const typeAt = (i: number): BidiClass => bidiClass(codePoints[i]!);
  // (1)+(2) Segment separators (S) and paragraph separators (B)
  // reset to the paragraph level, wherever they fall on the line.
  for (let i = start; i < end; i += 1) {
    const type = typeAt(i);
    if (type === 'B' || type === 'S') result[i - start] = paragraphLevel;
  }
  // (3) A sequence of whitespace (and/or already-reset separator)
  // characters resets when it precedes a B/S character on the
  // line, or runs to the end of the line.
  let i = start;
  while (i < end) {
    const type = typeAt(i);
    if (type !== 'WS' && type !== 'S') { i += 1; continue; }
    let j = i;
    while (j < end && (typeAt(j) === 'WS' || typeAt(j) === 'S')) j += 1;
    const followedBySeparator = j < end && (typeAt(j) === 'B' || typeAt(j) === 'S');
    if (j === end || followedBySeparator) {
      for (let k = i; k < j; k += 1) result[k - start] = paragraphLevel;
    }
    i = j;
  }
  return result;
}
