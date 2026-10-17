/**
 * Priority 12.5 shaping contract — extraction identity, subsetter handoff,
 * post-GSUB outline-validation obligations, and item-boundary safety
 * (contract v4 §5.2–§5.3, §10.2–§10.3, §2.5–§2.6; clarification 5 and 6).
 *
 * Interface slice only: these are pure helpers and obligation types for the
 * future PDF branch. Nothing here writes a PDF, and interface/fake tests are
 * not font/PDF/native acceptance.
 */
import {
  refuse,
  isCodePointBoundary,
  isSha256Hex,
  shapeKeysEqual,
  validateShapeKey,
  SHAPING_LIMITS,
  type ShapeCheck,
  type ShapeKey,
  type ShapeResult,
  type ShapedRun,
} from './text-shaping';

/**
 * Render a value inside a refusal message without ever invoking producer
 * conversion (round-3 correction R1, mirroring the snapshot module's
 * helper of the same name): only validated primitives are rendered — a
 * string as itself, a number / bigint / boolean via String(), null as
 * 'null'. Anything else (Symbol, object, function, undefined) renders
 * as a constant typeof placeholder, so an invalid value can refuse with
 * a stable message instead of throwing or executing producer code while
 * being reported.
 */
function diagnosticValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return `<${typeof value}>`;
  }
}

/**
 * One assigned character code (§5.2). Code identity is an EXTRACTION
 * identity only — rendering identity is untouched: repeated occurrences of
 * one GID render through codes that all resolve to that same GID.
 */
export interface ExtractionCodeAssignment {
  /** The assigned character code (Type2: the CID; Type0: the code the
      custom Encoding CMap maps to CID = GID). Unique per document, never
      reused for a different (glyph, cluster, occurrence). */
  readonly code: number;
  /** The post-GSUB GID every code in the cluster resolves to for rendering. */
  readonly glyph: number;
  readonly clusterStart: number; // item-relative
  readonly clusterEnd: number;
  /** The glyph's ordinal among the glyphs of its cluster, in content-stream
      order. Occurrence 0 is the cluster's anchor. */
  readonly occurrence: number;
  readonly role: 'anchor' | 'non-anchor';
  /**
   * The ToUnicode value (§5.3): the anchor occurrence's code maps to the
   * cluster's full logical source substring; EVERY other code of the
   * cluster maps to the empty string, written as an explicit bfchar entry
   * (`<code> <>`), never by omission. Extraction is therefore
   * nonduplicating — including when the same GID repeats inside one
   * cluster ([G2, G2] for `A` extracts as `A`, never `AA`).
   */
  readonly toUnicode: string;
}

export interface ExtractionGlyphInput {
  readonly glyph: number;
  readonly clusterStart: number;
  readonly clusterEnd: number;
}

/**
 * Assign character codes per (glyph, cluster, occurrence) under the run's
 * binding (§5.2). The assignment is made per document: the caller threads
 * `firstCode` across runs and pages, so a code's meaning is unique per
 * document and the same (glyph, cluster) pair in two runs never inherits
 * the other run's extraction. Occurrence identity consumes the existing
 * code budget faster; exceeding it refuses — occurrences are never
 * silently merged to fit.
 *
 * Code range (lead correction 3, matching the existing writer): codes
 * run from 1 to SHAPING_LIMITS.maxAssignedCodes (65534) INCLUSIVE. Code 0
 * is reserved and is never assigned. Both counters must be positive
 * safe integers, and an explicit maxCodes may only narrow the budget —
 * a NaN, infinite, fractional, zero, or raised override refuses rather
 * than widening the writer's range. `nextCode` may come back as
 * maxCodes + 1: that value is the EXHAUSTED sentinel, a legal state for
 * a zero-glyph call (a no-op) but the first code of no assignment.
 * Glyph and cluster inputs are validated BEFORE any substring is taken:
 * GIDs are non-negative safe integers and cluster ranges are integers,
 * inside the item, and on code-point boundaries — a range that splits a
 * supplementary scalar refuses, so an extraction can never come back as
 * a lone surrogate.
 */
export function assignExtractionCodes(input: {
  /** The run's glyphs in content-stream order. */
  readonly glyphs: readonly ExtractionGlyphInput[];
  /** The item's logical text (clusters index into it). */
  readonly itemText: string;
  /** The first unassigned code in the document. */
  readonly firstCode: number;
  /** Code budget; defaults to the §5.2 budget mirroring MAX_CIDS. */
  readonly maxCodes?: number;
}): ShapeResult<{ readonly assignments: readonly ExtractionCodeAssignment[]; readonly nextCode: number }> {
  if (!input || typeof input !== 'object') return refuse('invalid-code-range: input is not an object');
  if (!Array.isArray(input.glyphs)) return refuse('invalid-code-range: glyphs is not an array');
  if (typeof input.itemText !== 'string') return refuse('invalid-code-range: itemText is not a string');
  const maxCodes = input.maxCodes ?? SHAPING_LIMITS.maxAssignedCodes;
  if (!Number.isSafeInteger(maxCodes) || maxCodes < 1 || maxCodes > SHAPING_LIMITS.maxAssignedCodes) {
    return refuse(
      `invalid-code-range: maxCodes ${diagnosticValue(input.maxCodes)} is not a positive safe integer within the ` +
        `${SHAPING_LIMITS.maxAssignedCodes}-code writer budget; the budget cannot be raised or left undefined-valued`,
    );
  }
  if (!Number.isSafeInteger(input.firstCode) || input.firstCode < 1) {
    return refuse('invalid-code-range: firstCode must be a positive safe integer; code 0 is reserved and never assigned');
  }
  if (input.glyphs.length === 0) {
    // Zero-glyph call: a no-op that still validates the counters, so the
    // exhausted sentinel (maxCodes + 1) is a legal resting state.
    if (input.firstCode > maxCodes + 1) {
      return refuse(`invalid-code-range: firstCode ${input.firstCode} is past the exhausted sentinel ${maxCodes + 1}`);
    }
    return { ok: true, value: { assignments: [], nextCode: input.firstCode } };
  }
  if (input.firstCode > maxCodes) {
    return refuse(
      `code-budget: firstCode ${input.firstCode} is past the final legal assigned code ${maxCodes} (§5.2)`,
    );
  }
  for (const glyph of input.glyphs) {
    if (!glyph || typeof glyph !== 'object') return refuse('invalid-glyph: glyph entry is not an object');
    if (!Number.isSafeInteger(glyph.glyph) || glyph.glyph < 0) {
      return refuse(`invalid-glyph: GID ${diagnosticValue(glyph.glyph)} is not a non-negative safe integer`);
    }
    const { clusterStart, clusterEnd } = glyph;
    if (
      !Number.isSafeInteger(clusterStart) ||
      !Number.isSafeInteger(clusterEnd) ||
      clusterStart < 0 ||
      clusterEnd <= clusterStart ||
      clusterEnd > input.itemText.length
    ) {
      return refuse(
        `invalid-cluster: cluster range [${diagnosticValue(clusterStart)}, ${diagnosticValue(clusterEnd)}) is outside the item or empty`,
      );
    }
    if (!isCodePointBoundary(input.itemText, clusterStart) || !isCodePointBoundary(input.itemText, clusterEnd)) {
      return refuse(
        `invalid-cluster: cluster range [${clusterStart}, ${clusterEnd}) splits a supplementary scalar; ` +
          'a lone-surrogate extraction is never produced',
      );
    }
  }
  if (input.firstCode + input.glyphs.length - 1 > maxCodes) {
    return refuse(
      `code-budget: assigning ${input.glyphs.length} occurrence codes from ${input.firstCode} exceeds the ` +
        `${maxCodes}-code budget (§5.2); occurrences are never merged to fit`,
    );
  }
  const occurrenceByCluster = new Map<string, number>();
  const assignments: ExtractionCodeAssignment[] = [];
  let code = input.firstCode;
  for (const glyph of input.glyphs) {
    const clusterKey = `${glyph.clusterStart}:${glyph.clusterEnd}`;
    const occurrence = occurrenceByCluster.get(clusterKey) ?? 0;
    occurrenceByCluster.set(clusterKey, occurrence + 1);
    const role = occurrence === 0 ? 'anchor' : 'non-anchor';
    assignments.push({
      code: code++,
      glyph: glyph.glyph,
      clusterStart: glyph.clusterStart,
      clusterEnd: glyph.clusterEnd,
      occurrence,
      role,
      toUnicode: role === 'anchor' ? input.itemText.slice(glyph.clusterStart, glyph.clusterEnd) : '',
    });
  }
  return { ok: true, value: { assignments, nextCode: code } };
}

/**
 * The shaped branch's fallback extraction (§5.3), as a pure function of the
 * assignments: concatenate ToUnicode values in content order. Nonduplicating
 * by construction; across clusters of a reordered (RTL/Indic) run the values
 * arrive in visual order — the recorded ordering limitation of this layer,
 * asserted as expected behaviour in tests, not hidden. The exact layer is
 * ActualText (§5.4), for extractors observed to honour it.
 */
export function fallbackExtraction(assignments: readonly ExtractionCodeAssignment[]): string {
  return assignments.map((assignment) => assignment.toUnicode).join('');
}

/**
 * The subsetter handoff (§10.3, §0.2): the distinct post-GSUB GIDs of the
 * run, plus GID 0, passed UNCHANGED. Validation may refuse a set; nothing
 * here rewrites, renumbers, or filters it — and nothing re-derives glyph
 * identity from cmap, so a shaped GID with no cmap entry (e.g. a Devanagari
 * conjunct) passes through exactly as the engine produced it.
 */
export function subsetterGlyphSet(run: ShapedRun): readonly number[] {
  const set = new Set<number>([0]);
  for (const glyph of run.glyphs) set.add(glyph.glyph);
  return Object.freeze([...set].sort((a, b) => a - b));
}

/**
 * The post-GSUB outline-validation obligation (§10.2), as an interface.
 *
 * The app's used-codepoint parser validates cmap-derived glyphs only; a
 * post-GSUB GID may have no cmap entry, so that parser never sees it. Before
 * a shaped run's GIDs are used for embedding or subsetting, each distinct
 * GID is outline-validated AGAINST THE BOUND PROGRAM (identified by its
 * hash — never via cmap):
 *  - glyf programs: bounded simple-glyph work (loca span, header, endPts,
 *    instruction length, coordinate deltas charged against the existing
 *    caps; composite closure with bounded depth/count); empty glyphs are
 *    valid.
 *  - CFF programs: known-outline validation via the corrected 12.2 bounded
 *    Type2 evaluator — the charstring must EXECUTE to a known bounds
 *    outcome under the operand-stack, subroutine, and point-work caps. An
 *    in-range CharStrings INDEX entry is explicitly NOT validation.
 * Alongside it, the existing face-level gates (actual-byte OS/2 fsType
 * permission checks, bitmap/origin checks, all work caps) apply to shaped
 * faces unchanged: shaping admits no face and no glyph the existing paths
 * would refuse.
 *
 * This slice defines the obligation and its consumer; the bounded
 * evaluators themselves are the later slices' work.
 */
export interface ShapedGlyphOutlineValidator {
  validateGlyph(programSha256: string, glyph: number): ShapeCheck;
}

/**
 * Validate every distinct GID of a run against the bound program. Failure
 * of any GID refuses the WHOLE item (§10.2): a shaped run is never emitted
 * with a .notdef silently substituted for a glyph the engine chose, because
 * that would print a different word than the one shaped and measured.
 */
export function validateRunOutlines(run: ShapedRun, validator: ShapedGlyphOutlineValidator): ShapeCheck {
  const seen = new Set<number>();
  for (const glyph of run.glyphs) {
    if (seen.has(glyph.glyph)) continue;
    seen.add(glyph.glyph);
    const check = validator.validateGlyph(run.binding.programSha256, glyph.glyph);
    if (!check.ok) {
      return refuse(`outline-validation: GID ${glyph.glyph} of the bound program refused the whole item (${check.problem})`);
    }
  }
  return { ok: true };
}

/**
 * Item-boundary safety (clarification 6; §2.5, §2.6).
 *
 * Feeding the engine a whole string plus an item range does NOT give the
 * item unlimited context guarantees: the item's result is only trustworthy
 * when the item is a SAFE UNIT. Windows control evidence on file: a safe
 * four-mark item matches its whole-word shaping; an eight-mark cross-item
 * split differs. The admission rule is therefore positive, not negative:
 *
 *  - the item IS the whole shaping context → safe (it is the reference);
 *  - the item was produced by the §2.5 split rules inside the shaped region
 *    (grapheme-integrity splits), a whole-context reference shaping shows
 *    no cluster straddling either item boundary, AND an identity-bound
 *    agreement proof (below) attests that the whole-context production
 *    and the item-alone production AGREE for this item → safe;
 *  - anything else → REFUSED with the boundary named. In particular, the
 *    ABSENCE of a straddling cluster is by itself insufficient: a split
 *    the pipeline did not make (a foreign style/coverage boundary, an
 *    admitted/shaped boundary) is refused even when no cluster straddles,
 *    because cluster alignment says nothing about the cross-boundary
 *    joining and substitution context the split would discard.
 *
 * Lead correction 5: a provenance flag plus non-straddling reference
 * clusters does NOT prove joining/substitution agreement — recorded
 * Windows evidence shows a cross-item split differing with no straddling
 * cluster at all. This slice therefore fails closed: no subitem is a
 * safe unit until an actual agreement comparison, bound to the context
 * and item identities, exists. The proof is a preparation-layer product
 * of a later slice; the synthetic fixtures in this slice's tests stand
 * in for its SHAPE only and are not engine measurements.
 *
 * Producer/admission contract tests pin this before any consumer can
 * enable shaped items.
 */

/**
 * An identity-bound safe-unit agreement proof (lead correction 5).
 * Produced by an actual comparison in the preparation layer: the
 * whole-context shaping, restricted to the item, and the item-alone
 * shaping yielded the same glyph sequence and metrics for the item, and
 * `agreementSha256` digests that agreed item result. The proof binds to
 * ONE context text (by its digest) and ONE item range; a proof minted
 * for another context or range proves nothing here.
 *
 * Round-2 correction 5 (full binding): naming the context and range is
 * not enough. The proof also binds the COMPLETE requested shape
 * identity it was minted under and carries the trusted
 * preparation-ownership marker, and admission requires a TRUSTED
 * expectation on the input (expected identity + expected agreed-result
 * digest, supplied by the preparation owner) that the proof must equal
 * field for field — including the digest itself. Any mismatch, any
 * missing expectation, or any other ownership marker fails closed.
 */
export interface SafeUnitAgreementProof {
  /** SHA-256 of the exact context string the comparison was made on. */
  readonly contextSha256: string;
  readonly itemStart: number;
  readonly itemEnd: number;
  /**
   * The full requested shape identity (§3.1) the whole-vs-item
   * comparison was made under (round-2 correction 5): program digest
   * and face index, engine and engine-artifact digest, both data
   * versions, script / language / direction / levels, canonical
   * features and buffer flags, and the font epoch (compared by
   * identity, Object.is). A proof minted under another font, engine
   * build, setting set, or epoch is a different proof.
   */
  readonly key: ShapeKey;
  /**
   * Trusted preparation ownership: only a proof minted by the
   * preparation layer's own whole-vs-item comparison carries this
   * marker (mirroring SelectedFaceRef.source provenance discipline).
   * Any other value — or its absence — is not a proof this boundary
   * admits; a producer-asserted, snapshot-asserted, or test-asserted
   * agreement proves nothing.
   */
  readonly source: 'preparation-comparison';
  /**
   * SHA-256 of the canonical agreed item result both productions
   * yielded. A well-formed digest alone proves nothing: admission
   * requires it to EQUAL the trusted expected digest on the input.
   */
  readonly agreementSha256: string;
}

export interface ItemBoundaryInput {
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly itemStart: number;
  readonly itemEnd: number;
  /** Cluster ranges of a whole-context reference shaping of the context, in
      the same (paragraph) frame as the ranges above; null when no
      reference exists. */
  readonly referenceClusters: readonly (readonly [number, number])[] | null;
  /** True only when the pipeline's own §2.5 rules produced this item inside
      the shaped region. A boundary imposed from outside the shaped region
      (style, coverage by another face, the admitted/shaped wall) is false. */
  readonly producedByShapedRegionRules: boolean;
  /** SHA-256 of the exact context string; required to bind an agreement
      proof to this context. */
  readonly contextSha256?: string;
  /** The identity-bound agreement proof for this item, when an actual
      whole-vs-item comparison produced one; null/absent otherwise. */
  readonly safeUnitProof?: SafeUnitAgreementProof | null;
  /**
   * The TRUSTED requested shape identity for this item, supplied by
   * the preparation owner from its own request state — never by the
   * proof's bearer (round-2 correction 5). Required to admit a subitem
   * on the proof path; an absent expectation fails closed.
   */
  readonly expectedKey?: ShapeKey;
  /**
   * The TRUSTED expected digest of the agreed item result, from the
   * owner's own comparison record. The proof's agreementSha256 must
   * EQUAL this value.
   */
  readonly expectedAgreementSha256?: string;
}

export type BoundarySafety =
  | { readonly safe: true; readonly basis: 'whole-context' | 'shaped-region-item' }
  | { readonly safe: false; readonly problem: string };

export function checkItemBoundarySafety(input: ItemBoundaryInput): BoundarySafety {
  if (!input || typeof input !== 'object') {
    return { safe: false, problem: 'malformed-range: boundary input is not an object' };
  }
  const { contextStart, contextEnd, itemStart, itemEnd } = input;
  // Ranges are validated BEFORE any equality can count (lead correction
  // 5): an inverted, empty, fractional, or out-of-context range is
  // malformed, and two equally malformed ranges are not a whole context.
  if (
    ![contextStart, contextEnd, itemStart, itemEnd].every(Number.isSafeInteger) ||
    contextStart < 0 ||
    contextEnd <= contextStart ||
    itemStart < contextStart ||
    itemEnd > contextEnd ||
    itemEnd <= itemStart
  ) {
    return {
      safe: false,
      problem:
        `malformed-range: context [${diagnosticValue(contextStart)}, ${diagnosticValue(contextEnd)}) and item ` +
        `[${diagnosticValue(itemStart)}, ${diagnosticValue(itemEnd)}) are not well-formed integer ranges with the item inside the context`,
    };
  }
  if (itemStart === contextStart && itemEnd === contextEnd) {
    return { safe: true, basis: 'whole-context' };
  }
  if (input.referenceClusters === null) {
    return {
      safe: false,
      problem: 'unsafe-boundary: no whole-context reference shaping exists for this item; an item range alone proves nothing (clarification 6)',
    };
  }
  if (!Array.isArray(input.referenceClusters)) {
    return { safe: false, problem: 'malformed-range: reference clusters are not an array' };
  }
  for (const cluster of input.referenceClusters) {
    if (
      !Array.isArray(cluster) ||
      cluster.length !== 2 ||
      !Number.isSafeInteger(cluster[0]) ||
      !Number.isSafeInteger(cluster[1]) ||
      cluster[0]! < contextStart ||
      cluster[1]! > contextEnd ||
      cluster[1]! <= cluster[0]!
    ) {
      return { safe: false, problem: 'malformed-range: a reference cluster is not a well-formed range inside the context' };
    }
    const [start, end] = cluster;
    for (const boundary of [itemStart, itemEnd]) {
      if (start < boundary && boundary < end) {
        return {
          safe: false,
          problem: `unsafe-boundary: a reference cluster [${start}, ${end}) straddles the item boundary at ${boundary} (§2.5 straddle rule)`,
        };
      }
    }
  }
  if (!input.producedByShapedRegionRules) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: no cluster straddles the boundary, but the split was not produced by the §2.5 rules ' +
        'inside the shaped region — absence of a straddling cluster is not a safe unit (clarification 6)',
    };
  }
  // Fail closed on proof (lead correction 5): pipeline provenance and
  // cluster geometry are necessary but not sufficient. Only an
  // identity-bound agreement proof — an actual whole-vs-item comparison
  // bound to THIS context digest and THIS item range — admits a subitem.
  const proof = input.safeUnitProof;
  if (!proof) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: no identity-bound agreement proof exists for this item; a provenance flag plus ' +
        'non-straddling reference clusters does not prove joining/substitution agreement, so this slice fails closed',
    };
  }
  if (typeof input.contextSha256 !== 'string' || !isSha256Hex(input.contextSha256)) {
    return {
      safe: false,
      problem: 'unsafe-boundary: the context digest needed to bind the agreement proof is absent or malformed',
    };
  }
  if (
    typeof proof !== 'object' ||
    proof.contextSha256 !== input.contextSha256 ||
    proof.itemStart !== itemStart ||
    proof.itemEnd !== itemEnd
  ) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: the agreement proof is not bound to this context digest and item range; ' +
        'a proof minted for another context or range proves nothing here',
    };
  }
  // Full binding (round-2 correction 5): naming this context and range
  // is not enough. The proof must also carry the trusted
  // preparation-ownership marker, bind the COMPLETE requested shape
  // identity, and carry the agreed-result digest the owner actually
  // expects. The expectation arrives from the preparation owner, never
  // from the proof's bearer; every check below fails closed.
  if (proof.source !== 'preparation-comparison') {
    return {
      safe: false,
      problem: "unsafe-boundary: the agreement proof does not carry the trusted 'preparation-comparison' ownership marker",
    };
  }
  const expectedKey = input.expectedKey;
  if (!expectedKey || typeof expectedKey !== 'object') {
    return {
      safe: false,
      problem: 'unsafe-boundary: no trusted expected shape identity is present to bind the agreement proof against',
    };
  }
  if (typeof input.expectedAgreementSha256 !== 'string' || !isSha256Hex(input.expectedAgreementSha256)) {
    return {
      safe: false,
      problem: 'unsafe-boundary: no trusted expected agreed-result digest is present to bind the agreement proof against',
    };
  }
  if (!proof.key || typeof proof.key !== 'object' || !validateShapeKey(proof.key).ok) {
    return {
      safe: false,
      problem: 'unsafe-boundary: the agreement proof does not carry a valid requested shape identity',
    };
  }
  if (!validateShapeKey(expectedKey).ok) {
    return { safe: false, problem: 'unsafe-boundary: the trusted expected shape identity is not a valid key' };
  }
  if (!shapeKeysEqual(proof.key, expectedKey)) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: the agreement proof was minted under a different shape identity ' +
        '(font, engine, settings, or epoch) than the trusted expected identity',
    };
  }
  // Identity-plane linkage (round-3 correction R3): the two planes
  // above are each internally consistent — the proof header names this
  // input's context digest and item range, and the proof's key equals
  // the trusted expected key — but nothing yet required the two planes
  // to identify the SAME context and item. With the trusted key left
  // unchanged, a bearer could relabel header and input together (a
  // different context digest, a different item range) or shift the
  // input's context origin, and both planes would still pass on a key
  // that identifies something else. Admission therefore additionally
  // requires ONE coherent identity across header, input and key: the
  // key's context digest and item range equal the input's (the header
  // was tied to the input above, so header and key now agree too), and
  // the key's context-relative item range is exactly the input item
  // re-based on the input's context origin — the same relation key
  // derivation establishes (contextItemStart = itemStart − contextStart).
  const key = proof.key;
  if (
    key.contextSha256 !== input.contextSha256 ||
    key.itemStart !== itemStart ||
    key.itemEnd !== itemEnd ||
    key.contextItemStart !== key.itemStart - contextStart ||
    key.contextItemEnd !== key.itemEnd - contextStart
  ) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: the agreement proof identity does not cohere with this boundary — the shape key ' +
        'identifies a different context, item, or context frame than the input and proof header name',
    };
  }
  if (typeof proof.agreementSha256 !== 'string' || proof.agreementSha256 !== input.expectedAgreementSha256) {
    return {
      safe: false,
      problem: 'unsafe-boundary: the agreement proof digest does not equal the trusted expected agreed-result digest',
    };
  }
  return { safe: true, basis: 'shaped-region-item' };
}
