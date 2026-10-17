/**
 * Preparation-layer safe-unit admission (12.5 engine switch-over, step 1;
 * contract v4 §2.5, clarification 6).
 *
 * The accepted interface defines the SHAPE of safe-unit admission
 * (`SafeUnitAgreementProof` + `checkItemBoundarySafety` in
 * text-shaping-extraction.ts) but nothing minted a proof and nothing
 * performed the comparison the proof attests. This module is that
 * preparation-layer product — the only minter:
 *
 *  - Both productions are validated first (`validateShapedRun` against
 *    the host's trusted contexts); an invalid run is refused with its
 *    validation problem, before any comparison.
 *  - The item production is compared against the whole-context
 *    reference production, restricted to the item: glyph sequence
 *    (GID, paragraph-frame cluster range, x/y advances, x/y offsets)
 *    and the item's uncovered ranges must agree EXACTLY. Admission
 *    follows the comparison — never a mark count, never a context
 *    window: the recorded Windows evidence is that a four-mark item
 *    matched its whole-word shaping while an eight-mark cross-item
 *    split differed, and joining context can extend across arbitrarily
 *    long transparent-mark sequences.
 *  - On exact agreement the module mints the proof (full key binding,
 *    the trusted `preparation-comparison` ownership marker, and a
 *    digest of the canonical agreed item result) and returns the
 *    composed `checkItemBoundarySafety` verdict with the trusted
 *    expectations taken from this comparison — so structural rules
 *    (straddle, §2.5 provenance, identity-plane coherence) still speak
 *    with their own named refusals.
 *  - Any disagreement, missing reference, identity mismatch, or
 *    straddle is a named `unsafe-boundary:` refusal; nothing partial
 *    is emitted and no proof is minted.
 *
 * Whole-context consumption needs no proof (the item IS the reference).
 * The digest function is injected: this module stays platform-free,
 * and the host supplies its SHA-256 (the digest must be SHA-256 hex
 * or minting refuses).
 */
import {
  isSha256Hex,
  type ShapeKey,
  type ShapedGlyph,
  type ShapedRun,
} from './text-shaping';
import { validateShapedRun, type ShapedRunContext } from './text-shaping-snapshot';
import {
  checkItemBoundarySafety,
  type ItemBoundaryInput,
  type SafeUnitAgreementProof,
} from './text-shaping-extraction';

export interface ItemProduction {
  readonly run: ShapedRun;
  readonly validation: ShapedRunContext;
}

export interface ItemAdmissionRequest {
  /** The shaping context's range in the paragraph frame. */
  readonly contextStart: number;
  readonly contextEnd: number;
  /** The whole-context reference production; null when none exists. */
  readonly reference: ItemProduction | null;
  /** The item production seeking admission. */
  readonly item: ItemProduction;
  /** True only when the pipeline's own §2.5 rules produced this item
      inside the shaped region (see checkItemBoundarySafety). */
  readonly producedByShapedRegionRules: boolean;
  /** The host's SHA-256 (hex) over UTF-8 text. */
  readonly digestSha256Hex: (text: string) => string;
}

export type ItemAdmission =
  | {
      readonly safe: true;
      readonly basis: 'whole-context' | 'shaped-region-item';
      /** The minted proof for a shaped-region item; null for
          whole-context admission, which needs none. */
      readonly proof: SafeUnitAgreementProof | null;
    }
  | { readonly safe: false; readonly problem: string };

/** Primitive-only diagnostic rendering (the accepted modules' rule):
    a value renders only when it already is a finite number; anything
    else is a constant placeholder and is never coerced. */
const num = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '<non-number>';

/** Key fields that must be identical between the whole-context
    reference and an item production of the same context. The item
    fields (itemStart/itemEnd/contextItemStart/contextItemEnd) are
    permitted differences — they are checked separately against the
    requested ranges — and the buffer flags are compared modulo the
    positional bot/eot pair (see identityDifference). */
const IDENTITY_FIELDS = [
  'programSha256',
  'faceIndex',
  'engine',
  'engineArtifactSha256',
  'shapingDataVersion',
  'pipelineDataVersion',
  'script',
  'language',
  'direction',
  'bidiLevel',
  'paragraphBaseDirection',
  'normalization',
  'clusterLevel',
  'defaultIgnorables',
  'paragraphSha256',
  'contextKind',
  'contextSha256',
  'paragraphLevelsSha256',
  'lineLevelsSha256',
] as const;

function identityDifference(a: ShapeKey, b: ShapeKey): string | null {
  for (const field of IDENTITY_FIELDS) {
    if (a[field] !== b[field]) return field;
  }
  if (
    a.features.length !== b.features.length ||
    a.features.some((value, index) => value !== b.features[index])
  ) {
    return 'features';
  }
  // Buffer flags are compared modulo the positional pair: 'bot' and
  // 'eot' reflect the item's position IN ITS CONTEXT (§3.3, pinned by
  // validateShapeKey against contextItemStart/contextItemEnd), so a
  // whole-context reference and a proper subitem carry them
  // differently BY CONSTRUCTION — the reference has both, a start
  // subitem only 'bot', an end subitem only 'eot'. Any other flag is
  // a shaping setting and must agree exactly. (In this slice bot/eot
  // are the only legal flags, so the stripped comparison is between
  // empty lists; it stays correct when non-positional flags arrive.)
  const nonPositional = (key: ShapeKey): readonly string[] =>
    key.bufferFlags.filter((flag) => flag !== 'bot' && flag !== 'eot');
  const aFlags = nonPositional(a);
  const bFlags = nonPositional(b);
  if (
    aFlags.length !== bFlags.length ||
    aFlags.some((value, index) => value !== bFlags[index])
  ) {
    return 'bufferFlags';
  }
  const coords = (key: ShapeKey): string =>
    JSON.stringify(
      Object.entries(key.variationCoords).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  if (coords(a) !== coords(b)) return 'variationCoords';
  if (!Object.is(a.fontEpoch, b.fontEpoch)) return 'fontEpoch';
  return null;
}

interface FramedGlyph {
  readonly glyph: ShapedGlyph;
  readonly start: number; // paragraph frame
  readonly end: number;
}

const frameGlyphs = (run: ShapedRun): FramedGlyph[] => {
  const origin = run.binding.itemStart;
  return run.glyphs.map((glyph) => ({
    glyph,
    start: origin + glyph.clusterStart,
    end: origin + glyph.clusterEnd,
  }));
};

/**
 * The whole-vs-item comparison itself, exported for direct testing and
 * for preparation tooling. Both runs must already be validated; this
 * function compares data, it does not validate it.
 */
export function compareItemAgreement(
  referenceRun: ShapedRun,
  itemRun: ShapedRun,
): { readonly agree: true } | { readonly agree: false; readonly problem: string } {
  const referenceKey = referenceRun.binding;
  const itemKey = itemRun.binding;
  const identity = identityDifference(referenceKey, itemKey);
  if (identity !== null) {
    return {
      agree: false,
      problem:
        `unsafe-boundary: the item production's shaping identity differs from the whole-context ` +
        `reference (${identity}) — whole-vs-item agreement cannot be established`,
    };
  }
  if (
    referenceKey.contextItemStart !== 0 ||
    referenceKey.contextItemEnd !== referenceKey.itemEnd - referenceKey.itemStart
  ) {
    return {
      agree: false,
      problem:
        'unsafe-boundary: the reference production is not the whole-context shaping of its ' +
        'context — an item-range reference proves nothing about the whole (clarification 6)',
    };
  }
  if (itemKey.contextItemStart !== itemKey.itemStart - referenceKey.itemStart) {
    return {
      agree: false,
      problem:
        'unsafe-boundary: the item production’s context-relative range does not place it in ' +
        'the reference context — the two productions do not share one context frame',
    };
  }
  const itemStart = itemKey.itemStart;
  const itemEnd = itemKey.itemEnd;
  const referenceGlyphs = frameGlyphs(referenceRun);
  for (const framed of referenceGlyphs) {
    for (const boundary of [itemStart, itemEnd]) {
      if (framed.start < boundary && boundary < framed.end) {
        return {
          agree: false,
          problem:
            `unsafe-boundary: a reference cluster [${num(framed.start)}, ${num(framed.end)}) ` +
            `straddles the item boundary at ${num(boundary)} (§2.5 straddle rule)`,
        };
      }
    }
  }
  const restricted = referenceGlyphs.filter(
    (framed) => framed.start >= itemStart && framed.end <= itemEnd,
  );
  const itemGlyphs = frameGlyphs(itemRun);
  if (restricted.length !== itemGlyphs.length) {
    return {
      agree: false,
      problem:
        `unsafe-boundary: the item production has ${num(itemGlyphs.length)} glyphs for the item ` +
        `where the whole-context reference has ${num(restricted.length)} — the productions disagree`,
    };
  }
  const GLYPH_FIELDS = ['glyph', 'xAdvance', 'yAdvance', 'xOffset', 'yOffset'] as const;
  for (let index = 0; index < restricted.length; index += 1) {
    const reference = restricted[index]!;
    const item = itemGlyphs[index]!;
    if (reference.start !== item.start || reference.end !== item.end) {
      return {
        agree: false,
        problem:
          `unsafe-boundary: the item production disagrees with the whole-context reference at ` +
          `cluster ${num(item.start)} (cluster range: reference [${num(reference.start)}, ` +
          `${num(reference.end)}), item [${num(item.start)}, ${num(item.end)}))`,
      };
    }
    for (const field of GLYPH_FIELDS) {
      if (reference.glyph[field] !== item.glyph[field]) {
        return {
          agree: false,
          problem:
            `unsafe-boundary: the item production disagrees with the whole-context reference at ` +
            `cluster ${num(item.start)} (${field}: reference ${num(reference.glyph[field])}, ` +
            `item ${num(item.glyph[field])})`,
        };
      }
    }
  }
  const restrictUncovered = (run: ShapedRun) =>
    run.uncovered
      .map((range) => ({
        start: run.binding.itemStart + range.start,
        end: run.binding.itemStart + range.end,
        kind: range.kind,
      }))
      .filter((range) => range.start >= itemStart && range.end <= itemEnd);
  const referenceUncovered = restrictUncovered(referenceRun);
  const itemUncovered = restrictUncovered(itemRun);
  if (
    referenceUncovered.length !== itemUncovered.length ||
    referenceUncovered.some(
      (range, index) =>
        range.start !== itemUncovered[index]!.start ||
        range.end !== itemUncovered[index]!.end ||
        range.kind !== itemUncovered[index]!.kind,
    )
  ) {
    return {
      agree: false,
      problem:
        'unsafe-boundary: the item production’s uncovered ranges disagree with the ' +
        'whole-context reference for the item — the productions disagree',
    };
  }
  return { agree: true };
}

/**
 * The canonical agreed item result the agreement digest binds: the
 * item's production data in the paragraph frame, under the item's
 * context identity. Both productions yielded exactly this (that is
 * what agreement means), so it can be encoded from the item run.
 */
export function agreedItemResultEncoding(key: ShapeKey, run: ShapedRun): string {
  return JSON.stringify({
    v: 1,
    contextSha256: key.contextSha256,
    itemStart: key.itemStart,
    itemEnd: key.itemEnd,
    glyphs: frameGlyphs(run).map((framed) => [
      framed.glyph.glyph,
      framed.start,
      framed.end,
      framed.glyph.xAdvance,
      framed.glyph.yAdvance,
      framed.glyph.xOffset,
      framed.glyph.yOffset,
    ]),
    uncovered: run.uncovered.map((range) => [
      key.itemStart + range.start,
      key.itemStart + range.end,
      range.kind,
    ]),
  });
}

/**
 * Admit an item production as a safe unit, or refuse it by name.
 * This is the step-1 gate rule; consumers added by later switch-over
 * steps must obtain a safe verdict here (or the whole-context basis)
 * before using part of a shaped context.
 */
export function admitItemProduction(request: ItemAdmissionRequest): ItemAdmission {
  const itemKey = request.item.validation.key;
  const itemCheck = validateShapedRun(request.item.run, request.item.validation);
  if (!itemCheck.ok) return { safe: false, problem: itemCheck.problem };

  const boundaryBase = {
    contextStart: request.contextStart,
    contextEnd: request.contextEnd,
    itemStart: itemKey.itemStart,
    itemEnd: itemKey.itemEnd,
    producedByShapedRegionRules: request.producedByShapedRegionRules,
  } satisfies Partial<ItemBoundaryInput>;

  if (itemKey.itemStart === request.contextStart && itemKey.itemEnd === request.contextEnd) {
    const verdict = checkItemBoundarySafety({
      ...boundaryBase,
      referenceClusters: null,
    });
    return verdict.safe
      ? { safe: true, basis: 'whole-context', proof: null }
      : { safe: false, problem: verdict.problem };
  }

  if (request.reference === null) {
    const verdict = checkItemBoundarySafety({
      ...boundaryBase,
      referenceClusters: null,
    });
    // The item is a proper subitem here (whole-context returned
    // above), so the predicate's no-reference refusal is the verdict.
    return verdict.safe
      ? { safe: false, problem: 'unsafe-boundary: no whole-context reference shaping exists for this item' }
      : { safe: false, problem: verdict.problem };
  }

  const referenceCheck = validateShapedRun(request.reference.run, request.reference.validation);
  if (!referenceCheck.ok) return { safe: false, problem: referenceCheck.problem };

  const comparison = compareItemAgreement(request.reference.run, request.item.run);
  if (!comparison.agree) return { safe: false, problem: comparison.problem };

  const agreementSha256 = request.digestSha256Hex(agreedItemResultEncoding(itemKey, request.item.run));
  if (!isSha256Hex(agreementSha256)) {
    return {
      safe: false,
      problem:
        'unsafe-boundary: the preparation digest did not produce a SHA-256 digest of the ' +
        'agreed item result — no proof can be minted',
    };
  }
  const proof: SafeUnitAgreementProof = {
    contextSha256: itemKey.contextSha256,
    itemStart: itemKey.itemStart,
    itemEnd: itemKey.itemEnd,
    key: itemKey,
    source: 'preparation-comparison',
    agreementSha256,
  };
  const verdict = checkItemBoundarySafety({
    ...boundaryBase,
    referenceClusters: frameGlyphs(request.reference.run).map(
      (framed) => [framed.start, framed.end] as const,
    ),
    contextSha256: itemKey.contextSha256,
    safeUnitProof: proof,
    expectedKey: itemKey,
    expectedAgreementSha256: agreementSha256,
  });
  return verdict.safe
    ? { safe: true, basis: 'shaped-region-item', proof }
    : { safe: false, problem: verdict.problem };
}
