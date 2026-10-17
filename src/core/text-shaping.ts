/**
 * Priority 12.5 shaping contract — interface slice (contract v4, §12).
 *
 * This module is TYPES AND PURE HELPERS ONLY. It defines the shared shaping
 * contract from `recon/RECON-12.5-CONTRACT-v4.md` so the paragraph pipeline,
 * the host/worker mode, and the PDF branch can be built against it in later,
 * separately reviewed slices. Nothing here shapes text: there is no engine,
 * no dependency, no transport, no worker, and no consumer in this slice, and
 * no existing rendering/capture/layout/PDF path imports this module.
 *
 * Interface and fake-producer tests against this contract are NOT font, PDF,
 * Windows, or native acceptance; they pin the contract's shape and refusal
 * behaviour only.
 *
 * The six clarifications carried into this first code/test slice (lead
 * reconciliation, 2026-10-16) are marked "clarification N" where they land:
 *  1. Opaque epoch/capture identity never collapses through JSON
 *     (see text-shaping-snapshot.ts, ShapeKeyEncoder).
 *  2. The selected TTC source face index and the engine's index 0 of the
 *     extracted standalone SFNT are distinct, both host-bound (SelectedFaceRef).
 *  3. Concrete flat-wire fields/widths, conservative copy/charge formula,
 *     reserve-before-copy, exit-join before release
 *     (see text-shaping-transport.ts).
 *  4. Per-glyph 64×unitsPerEm bounds are separate from the finite bounded
 *     accumulated advance sums; the preparation-state union is complete and
 *     direct-path items are protected (ShapePrepState, validateShapeRequest).
 *  5. Occurrence-sensitive extraction binding, post-GSUB known-outline
 *     validation obligations, actual ignorable cluster associations, signed
 *     metrics (see text-shaping-extraction.ts and validateShapedRun).
 *  6. Whole-string input plus an item range is not unlimited engine context:
 *     a safe unit or an explicit unsafe-boundary refusal
 *     (see text-shaping-extraction.ts, checkItemBoundarySafety).
 */
import type { TextAppearance } from './text-metrics';
import { supportsNativeTextRun } from './text-metrics';

export type ShapeDirection = 'ltr' | 'rtl';

/** A checkable refusal. Every refusal in this contract is data with a stable
    machine-readable `problem` prefix, never a thrown exception and never a
    silently clamped or repaired value. */
export type ShapeCheck = { readonly ok: true } | { readonly ok: false; readonly problem: string };
export type ShapeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

export const ok = (): ShapeCheck => ({ ok: true });
export const refuse = (problem: string): { readonly ok: false; readonly problem: string } => ({ ok: false, problem });

/**
 * Quote a producer-supplied value into a refusal diagnostic WITHOUT
 * coercing it (round-3 correction R1): String()/interpolation on an
 * arbitrary value invokes its conversion methods — a plain object with a
 * non-callable toString, a null-prototype object, or a throwing toString
 * would raise (or execute producer code) while the validator is trying to
 * refuse it. Only an already-validated string primitive is quoted (its
 * interpolation is the identity and runs no producer code); every other
 * value is described by constant text.
 */
export const quotedIfString = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'` : '(non-string value)';

/** §9.3 batch budgets and §9.4 transport caps, restated as data. These values
    are existing caps; this slice does not raise any of them. The object is
    frozen at runtime (lead review addendum B): `as const` alone is a
    type-level promise, not immutability — a mutated cap would silently
    rewrite every bound in this contract. */
export const SHAPING_LIMITS = Object.freeze({
  /** Items per capture batch. */
  maxItemsPerBatch: 256,
  /** Total UTF-16 units per batch. */
  maxBatchUtf16Units: 65536,
  /** Per-item glyph expansion: glyphs ≤ factor × item UTF-16 length. */
  glyphExpansionFactor: 4,
  /** Per-item shaped result, serialized (wire) bytes. */
  maxItemResultBytes: 256 * 1024,
  /** Aggregate snapshot bytes per capture. */
  maxSnapshotBytes: 8 * 1024 * 1024,
  /** Host timeout per request; the worker is terminated after its first result. */
  hostTimeoutMs: 10000,
  /** Worker concurrency (§9.4): at most 2 workers hold slots at once. */
  maxWorkers: 2,
  /** Pending (queued + active) jobs (§9.3/§9.4). Queue depth alone is not a
      byte bound; the byte bound is maxAggregateTransportBytes. */
  maxQueuedJobs: 32,
  /** §9.4.3 aggregate transport ledger cap across active AND queued jobs. */
  maxAggregateTransportBytes: 32 * 1024 * 1024,
  /** §10.1.2 per-glyph bound: |advance| and |offset| ≤ 64 × unitsPerEm.
      This bounds ONE glyph's fields. Accumulated run sums are bounded
      separately (clarification 4): a long run of in-bound glyphs is not one
      glyph and is never rejected by the per-glyph bound. */
  perGlyphBoundUpemMultiple: 64,
  /** Code-assignment budget for the shaped branch (§5.2): mirrors the
      existing MAX_CIDS = 65534 budget in src/io/pdf-fonts.ts; occurrence
      identity consumes codes faster, and exceeding the budget refuses the
      face's shaped runs — occurrences are never silently merged. */
  maxAssignedCodes: 65534,
} as const);

/** The pinned engine identity string (§3.1). Recorded in keys so results are
    never shared across engine versions or build variants; the capped
    artifact's own digest is a separate key field. No engine is adopted by
    this interface slice. */
export const SHAPING_ENGINE_IDENTITY = 'harfbuzz 14.6.0 via harfbuzzjs 1.6.3 (self-build cap-256MiB)';

/**
 * The host-owned selected-face record (§3.1, clarification 2).
 *
 * `TextAppearance` is a renderer-side STYLE union (family/bold/italic, or an
 * SHX renderer): it carries no faceIndex and no program identity, and a
 * caller's appearance is NEVER authority for identity. Identity comes only
 * from this record, produced by the host's corrected selection (§0.1) and
 * bound by the host at preparation time.
 *
 * Clarification 2 — two different face indices, both bound here:
 *  - `faceIndex` is the ORIGINAL selected face index inside the source the
 *    host selected from (for a TrueType Collection, the TTC face index the
 *    corrected selection resolved). This is the identity §5/§10 bind to.
 *  - `engineFaceIndex` is the index the shaping engine addresses inside the
 *    program bytes it is actually handed. The host hands the engine an
 *    EXTRACTED STANDALONE SFNT for the selected face, so the engine index
 *    is always 0 — including when `faceIndex` is 1 or more. Confusing the
 *    two would shape (and bind results to) the wrong face.
 */
export interface SelectedFaceRef {
  /** SHA-256 (lowercase hex) of the exact font program bytes handed to the
      engine: the extracted standalone SFNT for the selected face. */
  readonly programSha256: string;
  /** Selected collection face in the original source (§0.1); 0 for a
      standalone (non-collection) source. */
  readonly faceIndex: number;
  /** Index within the extracted standalone program: always 0. */
  readonly engineFaceIndex: 0;
  /** Provenance of the binding; identity asserted any other way is refused. */
  readonly source: 'host-selection';
}

export interface ShapeRequest {
  /** Full decoded logical paragraph (§2.1). The saved drawing text is never
      modified; this is a working string only. */
  readonly paragraphText: string;
  readonly itemStart: number; // UTF-16 offset of the item in paragraphText
  readonly itemEnd: number; // exclusive
  /** STYLE input only (family/bold/italic) — not identity. */
  readonly appearance: TextAppearance;
  /** Identity, host-bound (see SelectedFaceRef). */
  readonly face: SelectedFaceRef;
  /** The item's resolved direction (§2.3.3), from its uniform level. */
  readonly direction: ShapeDirection;
  /** The item's uniform paragraph-resolved level. */
  readonly bidiLevel: number;
  /** The shaping context (§2.5, §2.6). */
  readonly contextKind: 'paragraph' | 'line';
  /** Context range within paragraphText (for a line item: the line's range;
      for a paragraph item: the whole paragraph). */
  readonly contextStart: number;
  readonly contextEnd: number;
}

export interface ShapeKey {
  readonly programSha256: string; // exact program bytes shaped (from SelectedFaceRef)
  readonly faceIndex: number; // selected collection face (§0.1)
  readonly engine: string; // SHAPING_ENGINE_IDENTITY in slice 1
  readonly engineArtifactSha256: string; // digest of the exact capped wasm artifact
  readonly shapingDataVersion: string; // the engine's Unicode data version
  readonly pipelineDataVersion: string; // JCad's pinned script/bidi/grapheme table versions
  readonly script: string; // ISO 15924, resolved per §2.4
  readonly language: string; // 'und' in slice 1 (§8)
  readonly direction: ShapeDirection;
  readonly bidiLevel: number;
  readonly paragraphBaseDirection: ShapeDirection;
  readonly features: readonly string[]; // canonical, sorted 'tag=on|off' list as applied (§7.3)
  readonly variationCoords: Readonly<Record<string, number>>; // {} in slice 1 (§3.3)
  readonly normalization: 'none';
  readonly clusterLevel: 'monotone-graphemes';
  readonly bufferFlags: readonly string[]; // canonical names of the flags actually used (§3.3)
  readonly defaultIgnorables: 'engine-default-hide'; // the recorded policy (§3.3, §4)
  readonly paragraphSha256: string; // hash of the exact paragraph string
  readonly itemStart: number; // the item's range in that paragraph
  readonly itemEnd: number;
  readonly contextKind: 'paragraph' | 'line'; // the shaping context is key identity (§2.5)
  readonly contextSha256: string; // hash of the exact context string shaped
  readonly contextItemStart: number; // the item's range WITHIN the context string
  readonly contextItemEnd: number;
  readonly paragraphLevelsSha256: string; // hash of the paragraph's level array (§2.3)
  readonly lineLevelsSha256: string | null; // L1-adjusted line levels; null for paragraph items
  /**
   * The metrics registry epoch token (§1, §3.4). OPAQUE on purpose: it is
   * compared and encoded by identity (see ShapeKeyEncoder), never by its
   * JSON serialization — JSON would collapse distinct tokens (two different
   * empty objects both serialize to "{}") and serve stale results across
   * epochs (clarification 1).
   */
  readonly fontEpoch: unknown;
}

export interface ShapedGlyph {
  readonly glyph: number; // post-substitution GID in the bound face
  readonly clusterStart: number; // UTF-16 [start, end) RELATIVE TO THE ITEM (§3.2)
  readonly clusterEnd: number;
  readonly xAdvance: number;
  readonly yAdvance: number; // font units, post-GPOS
  readonly xOffset: number;
  readonly yOffset: number; // font units, post-GPOS
}

export interface UncoveredRange {
  readonly start: number;
  readonly end: number; // item-relative, as above
  readonly kind: 'bidi-control' | 'default-ignorable' | 'unmapped';
}

export interface ShapedRun {
  readonly glyphs: readonly ShapedGlyph[]; // VISUAL order for its item
  /** Σ xAdvance, font units. */
  readonly advanceX: number;
  /** Σ yAdvance, font units — independent data, validated as its own sum
      (§3.2, §10.1.3); it is not derivable from advanceX. */
  readonly advanceY: number;
  /** Signed ink bounds of the run, font units: may extend left of the origin
      and below the baseline. Total advance is not a bounds substitute. */
  readonly ink: {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
  };
  /** §4; sorted, disjoint from clusters. */
  readonly uncovered: readonly UncoveredRange[];
  /** Echoes every ShapeKey field, plus the fields below. */
  readonly binding: ShapeBinding;
}

export interface ShapeBinding extends ShapeKey {
  readonly itemTextSha256: string; // hash of paragraphText[itemStart..itemEnd]
  /** Clarification 2 binding delta: the engine index of the extracted
      standalone program the run was shaped from — always 0, echoed so a
      result produced from the wrong extraction cannot validate against a
      request for a different source face. */
  readonly engineFaceIndex: 0;
}

/**
 * The complete preparation-state union (§1, clarification 4).
 *
 * `ready | pending | missing | refused` are the shaped-path states. The union
 * is completed by `direct`: an item admitted by the existing native gate is
 * PROTECTED (§7.1) — it renders on the existing path, byte-for-byte as
 * today. A consumer asking about such an item must receive `direct`, never
 * `missing` (which would wrongly suppress its native rendering as an
 * unprepared shaped run) and never a shaped run.
 *
 * The lookup is synchronous and total: never a Promise, never
 * null-as-silence. `pending`/`missing` runs are not plotted with native text
 * in that capture (reported fallback); `refused` surfaces its recorded
 * problem in the plot report. No consumer may block, retry inside a plot,
 * or substitute a differently-shaped result.
 */
export type ShapePrepState =
  | { readonly state: 'ready'; readonly run: ShapedRun }
  | { readonly state: 'pending' }
  | { readonly state: 'missing' }
  | { readonly state: 'refused'; readonly problem: string }
  | { readonly state: 'direct'; readonly reason: 'admitted-native' };

/** The synchronous lookup surface a consumer uses (§1). Implementations are
    the future preparation layer and (for ready/missing) a sealed snapshot;
    this slice defines the surface and its states only. */
export interface ShapePreparer {
  shaped(key: ShapeKey): ShapePrepState;
}

/**
 * Digest format check that never coerces (round-2 correction 3):
 * RegExp.prototype.test stringifies its argument, and stringifying a
 * Symbol THROWS — a malformed producer digest must refuse, not crash
 * the validator. The typeof guard is at this shared root so every
 * digest call site (keys, face refs, item digests, proofs) is covered.
 */
export const isSha256Hex = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** True when `offset` does not split a surrogate pair inside `text`. */
export function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return offset >= 0 && offset <= text.length;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/**
 * §7.1 admission by construction. An item the existing gate admits is on the
 * direct path and is PROTECTED: it never reaches the shaper, in any
 * paragraph context. The gate is the same `supportsNativeTextRun`, unmodified.
 */
export function classifyItemRoute(itemText: string): 'direct' | 'shaped' {
  return supportsNativeTextRun(itemText) ? 'direct' : 'shaped';
}

/**
 * The identity a request carries, taken ONLY from its host-bound face record
 * (clarification 2). Appearance — family, bold, italic, or any other
 * caller-supplied style — contributes nothing: two requests with different
 * appearances and the same face record have the same identity, and no
 * appearance can mint an identity the host did not select.
 */
export function requestIdentity(request: ShapeRequest): {
  readonly programSha256: string;
  readonly faceIndex: number;
  readonly engineFaceIndex: 0;
} {
  return {
    programSha256: request.face.programSha256,
    faceIndex: request.face.faceIndex,
    engineFaceIndex: request.face.engineFaceIndex,
  };
}

export function validateSelectedFaceRef(face: SelectedFaceRef): ShapeCheck {
  if (!face || typeof face !== 'object') return refuse('invalid-face-ref: not an object');
  if (face.source !== 'host-selection') {
    return refuse('invalid-face-ref: identity must come from host selection, not a caller assertion');
  }
  if (!isSha256Hex(face.programSha256)) return refuse('invalid-face-ref: programSha256 is not a SHA-256 digest');
  if (!Number.isInteger(face.faceIndex) || face.faceIndex < 0) {
    return refuse('invalid-face-ref: faceIndex must be a non-negative integer');
  }
  if (face.engineFaceIndex !== 0) {
    return refuse('invalid-face-ref: engineFaceIndex must be 0 (the engine is handed an extracted standalone program)');
  }
  return ok();
}

/**
 * Admission-time validation of a shape request (§7.1, §2.5, §3.3). A request
 * that fails here is refused for that item only; nothing is shaped, clamped,
 * or partially admitted.
 */
export function validateShapeRequest(request: ShapeRequest): ShapeCheck {
  // Structural guards first (lead review addendum A): validation refuses
  // malformed structures with a named problem; it never throws on them.
  if (!request || typeof request !== 'object') return refuse('invalid-request: request is not an object');
  const faceCheck = validateSelectedFaceRef(request.face);
  if (!faceCheck.ok) return faceCheck;
  const text = request.paragraphText;
  if (typeof text !== 'string') return refuse('invalid-request: paragraphText is not a string');
  if (request.contextKind !== 'paragraph' && request.contextKind !== 'line') {
    return refuse(`invalid-request: unknown contextKind ${quotedIfString(request.contextKind)}`);
  }
  const { itemStart, itemEnd, contextStart, contextEnd } = request;
  for (const [name, value] of [
    ['itemStart', itemStart],
    ['itemEnd', itemEnd],
    ['contextStart', contextStart],
    ['contextEnd', contextEnd],
  ] as const) {
    if (!Number.isInteger(value)) return refuse(`invalid-request: ${name} must be an integer`);
  }
  if (itemStart < 0 || itemEnd < itemStart || itemEnd > text.length) {
    return refuse('invalid-request: item range outside the paragraph');
  }
  if (contextStart < 0 || contextEnd < contextStart || contextEnd > text.length) {
    return refuse('invalid-request: context range outside the paragraph');
  }
  if (itemStart < contextStart || itemEnd > contextEnd) {
    return refuse('invalid-request: item range outside its shaping context');
  }
  if (request.contextKind === 'paragraph' && (contextStart !== 0 || contextEnd !== text.length)) {
    return refuse('invalid-request: a paragraph context is the whole paragraph');
  }
  for (const offset of [itemStart, itemEnd, contextStart, contextEnd]) {
    if (!isCodePointBoundary(text, offset)) {
      return refuse(`invalid-request: range boundary at ${offset} splits a surrogate pair`);
    }
  }
  if (!Number.isInteger(request.bidiLevel) || request.bidiLevel < 0) {
    return refuse('invalid-request: bidiLevel must be a non-negative integer');
  }
  // §2.3.3: the item's resolved direction is its uniform level's parity.
  const parityDirection: ShapeDirection = request.bidiLevel % 2 === 0 ? 'ltr' : 'rtl';
  if (request.direction !== parityDirection) {
    return refuse('invalid-request: direction does not match the item level parity (§2.3.3)');
  }
  // §7.1/clarification 4: an admitted item is protected. The shaping boundary
  // itself refuses it, so no caller mistake can route protected text into
  // the engine.
  const itemText = text.slice(itemStart, itemEnd);
  if (classifyItemRoute(itemText) === 'direct') {
    return refuse('protected-direct-item: item is admitted by the native gate and never reaches the shaper (§7.1)');
  }
  return ok();
}

/** Pipeline-supplied fields a ShapeKey needs beyond the request (§3.1).
    These come from itemization, bidi resolution and the host's artifact
    records in later slices; the interface assembles and validates them. */
export interface ShapeKeyDerivation {
  readonly engineArtifactSha256: string;
  readonly shapingDataVersion: string;
  readonly pipelineDataVersion: string;
  readonly script: string;
  readonly paragraphBaseDirection: ShapeDirection;
  /** Canonical, sorted 'tag=on|off' list as applied (§7.3). */
  readonly features: readonly string[];
  /** Canonical flag names as applied to this context (§3.3): a subset of
      {'bot','eot'} reflecting the item's position IN ITS CONTEXT. */
  readonly bufferFlags: readonly string[];
  readonly paragraphSha256: string;
  readonly contextSha256: string;
  readonly paragraphLevelsSha256: string;
  /** Required for line items; must be null for paragraph items. */
  readonly lineLevelsSha256: string | null;
  /** Must be empty in slice 1 (§3.3): non-default coordinates are refused. */
  readonly variationCoords?: Readonly<Record<string, number>>;
  readonly fontEpoch: unknown;
}

/**
 * Assemble the complete key for a request (§3.1). Key equality is field-wise
 * on the resulting tuple; the canonical storage serialization lives in
 * ShapeKeyEncoder (text-shaping-snapshot.ts), which never serializes the
 * opaque epoch token through JSON (clarification 1).
 */
export function deriveShapeKey(request: ShapeRequest, derivation: ShapeKeyDerivation): ShapeResult<ShapeKey> {
  const requestCheck = validateShapeRequest(request);
  if (!requestCheck.ok) return requestCheck;
  if (!derivation || typeof derivation !== 'object') return refuse('invalid-key: derivation is not an object');
  if (!Array.isArray(derivation.features)) return refuse('invalid-key: features is not an array');
  if (!Array.isArray(derivation.bufferFlags)) return refuse('invalid-key: bufferFlags is not an array');
  if (
    derivation.variationCoords !== undefined &&
    (typeof derivation.variationCoords !== 'object' ||
      derivation.variationCoords === null ||
      Array.isArray(derivation.variationCoords))
  ) {
    return refuse('invalid-key: variationCoords is not a coordinate record');
  }
  if (!isSha256Hex(derivation.engineArtifactSha256)) {
    return refuse('invalid-key: engineArtifactSha256 is not a SHA-256 digest');
  }
  for (const [name, value] of [
    ['paragraphSha256', derivation.paragraphSha256],
    ['contextSha256', derivation.contextSha256],
    ['paragraphLevelsSha256', derivation.paragraphLevelsSha256],
  ] as const) {
    if (!isSha256Hex(value)) return refuse(`invalid-key: ${name} is not a SHA-256 digest`);
  }
  if (request.contextKind === 'line' && derivation.lineLevelsSha256 === null) {
    return refuse('invalid-key: a line item requires lineLevelsSha256 (its L1-adjusted levels, §2.3.2)');
  }
  if (request.contextKind === 'paragraph' && derivation.lineLevelsSha256 !== null) {
    return refuse('invalid-key: a paragraph item carries no lineLevelsSha256');
  }
  if (derivation.lineLevelsSha256 !== null && !isSha256Hex(derivation.lineLevelsSha256)) {
    return refuse('invalid-key: lineLevelsSha256 is not a SHA-256 digest');
  }
  const coords = derivation.variationCoords ?? {};
  if (Object.keys(coords).length > 0) {
    return refuse('variation-coordinates-not-admitted: slice 1 admits the default instance only (§3.3)');
  }
  const key: ShapeKey = {
    programSha256: request.face.programSha256,
    faceIndex: request.face.faceIndex,
    engine: SHAPING_ENGINE_IDENTITY,
    engineArtifactSha256: derivation.engineArtifactSha256,
    shapingDataVersion: derivation.shapingDataVersion,
    pipelineDataVersion: derivation.pipelineDataVersion,
    script: derivation.script,
    language: 'und',
    direction: request.direction,
    bidiLevel: request.bidiLevel,
    paragraphBaseDirection: derivation.paragraphBaseDirection,
    features: [...derivation.features],
    variationCoords: {},
    normalization: 'none',
    clusterLevel: 'monotone-graphemes',
    bufferFlags: [...derivation.bufferFlags],
    defaultIgnorables: 'engine-default-hide',
    paragraphSha256: derivation.paragraphSha256,
    itemStart: request.itemStart,
    itemEnd: request.itemEnd,
    contextKind: request.contextKind,
    contextSha256: derivation.contextSha256,
    contextItemStart: request.itemStart - request.contextStart,
    contextItemEnd: request.itemEnd - request.contextStart,
    paragraphLevelsSha256: derivation.paragraphLevelsSha256,
    lineLevelsSha256: derivation.lineLevelsSha256,
    fontEpoch: derivation.fontEpoch,
  };
  const keyCheck = validateShapeKey(key);
  if (!keyCheck.ok) return keyCheck;
  return { ok: true, value: key };
}

const FEATURE_PATTERN = /^[a-z0-9]{4}=(on|off)$/;

const SCRIPT_PATTERN = /^[A-Za-z]{4}$/; // ISO 15924 script code

/** Structural validation of a key, including data that arrives from a
    producer rather than from deriveShapeKey. Every check refuses with a
    named problem; malformed structures (null, missing arrays, malformed
    digests, unknown identities) refuse rather than throw (addendum A).
    The identity rules are the derivation's own: a key validateShapeKey
    accepts is one deriveShapeKey could have produced. */
export function validateShapeKey(key: ShapeKey): ShapeCheck {
  if (!key || typeof key !== 'object') return refuse('invalid-key: key is not an object');
  if (!isSha256Hex(key.programSha256)) return refuse('invalid-key: programSha256 is not a SHA-256 digest');
  if (!isSha256Hex(key.engineArtifactSha256)) {
    return refuse('invalid-key: engineArtifactSha256 is not a SHA-256 digest');
  }
  if (!isSha256Hex(key.paragraphSha256)) return refuse('invalid-key: paragraphSha256 is not a SHA-256 digest');
  if (!isSha256Hex(key.contextSha256)) return refuse('invalid-key: contextSha256 is not a SHA-256 digest');
  if (!isSha256Hex(key.paragraphLevelsSha256)) {
    return refuse('invalid-key: paragraphLevelsSha256 is not a SHA-256 digest');
  }
  if (key.lineLevelsSha256 !== null && !isSha256Hex(key.lineLevelsSha256)) {
    return refuse('invalid-key: lineLevelsSha256 is not a SHA-256 digest');
  }
  if (key.engine !== SHAPING_ENGINE_IDENTITY) {
    return refuse('invalid-key: engine is not the pinned engine identity (§3.1)');
  }
  if (typeof key.script !== 'string' || !SCRIPT_PATTERN.test(key.script)) {
    return refuse('invalid-key: script is not an ISO 15924 code');
  }
  if (typeof key.shapingDataVersion !== 'string' || key.shapingDataVersion.length === 0) {
    return refuse('invalid-key: shapingDataVersion is not a version identity');
  }
  if (typeof key.pipelineDataVersion !== 'string' || key.pipelineDataVersion.length === 0) {
    return refuse('invalid-key: pipelineDataVersion is not a version identity');
  }
  if (key.paragraphBaseDirection !== 'ltr' && key.paragraphBaseDirection !== 'rtl') {
    return refuse('invalid-key: paragraphBaseDirection is not a direction');
  }
  if (key.contextKind !== 'paragraph' && key.contextKind !== 'line') {
    return refuse(`invalid-key: unknown contextKind ${quotedIfString(key.contextKind)}`);
  }
  if (!Number.isInteger(key.faceIndex) || key.faceIndex < 0) {
    return refuse('invalid-key: faceIndex must be a non-negative integer');
  }
  if (!Number.isInteger(key.bidiLevel) || key.bidiLevel < 0) {
    return refuse('invalid-key: bidiLevel must be a non-negative integer');
  }
  const parityDirection: ShapeDirection = key.bidiLevel % 2 === 0 ? 'ltr' : 'rtl';
  if (key.direction !== parityDirection) {
    return refuse('invalid-key: direction does not match the level parity (§2.3.3)');
  }
  if (key.language !== 'und') return refuse("invalid-key: slice 1 language is the explicit 'und' (§8)");
  if (key.normalization !== 'none') return refuse("invalid-key: slice 1 normalization is 'none' (§2.2)");
  if (key.clusterLevel !== 'monotone-graphemes') return refuse('invalid-key: cluster level is monotone-graphemes (§3.3)');
  if (key.defaultIgnorables !== 'engine-default-hide') {
    return refuse("invalid-key: defaultIgnorables is the recorded 'engine-default-hide' policy (§3.3)");
  }
  if (!key.variationCoords || typeof key.variationCoords !== 'object' || Array.isArray(key.variationCoords)) {
    return refuse('invalid-key: variationCoords is not a coordinate record');
  }
  if (Object.keys(key.variationCoords).length > 0) {
    return refuse('variation-coordinates-not-admitted: slice 1 admits the default instance only (§3.3)');
  }
  if (!Array.isArray(key.features)) return refuse('invalid-key: features is not an array');
  if (!Array.isArray(key.bufferFlags)) return refuse('invalid-key: bufferFlags is not an array');
  const features = key.features;
  for (let i = 0; i < features.length; i++) {
    // A non-string feature (e.g. a Symbol from a malformed producer)
    // refuses by type BEFORE the pattern test or any message formats it
    // — RegExp.test and template interpolation both throw on Symbols
    // (round-2 correction 3). The message itself must not coerce the
    // value either: quotedIfString formats only a validated string
    // primitive, never String(value) (round-3 correction R1).
    if (typeof features[i] !== 'string' || !FEATURE_PATTERN.test(features[i]!)) {
      return refuse(`invalid-key: feature ${quotedIfString(features[i])} is not 'tag=on|off'`);
    }
    if (i > 0 && features[i - 1]! >= features[i]!) return refuse('invalid-key: features must be canonical (sorted, unique)');
  }
  for (const flag of key.bufferFlags) {
    if (flag !== 'bot' && flag !== 'eot') return refuse(`invalid-key: unknown buffer flag ${quotedIfString(flag)}`);
  }
  if (new Set(key.bufferFlags).size !== key.bufferFlags.length) {
    return refuse('invalid-key: buffer flags must be unique');
  }
  // §3.3: BOT is applied iff the item starts its shaping context. (EOT is a
  // producer-recorded fact about the context's far edge; the key alone does
  // not carry the context length, so only its membership is checked here.)
  if (key.bufferFlags.includes('bot') !== (key.contextItemStart === 0)) {
    return refuse('invalid-key: bot flag does not match the item position in its context (§3.3)');
  }
  if (key.contextKind === 'paragraph' && key.lineLevelsSha256 !== null) {
    return refuse('invalid-key: a paragraph item carries no lineLevelsSha256');
  }
  if (key.contextKind === 'line' && key.lineLevelsSha256 === null) {
    return refuse('invalid-key: a line item requires lineLevelsSha256');
  }
  if (
    !Number.isInteger(key.itemStart) ||
    !Number.isInteger(key.itemEnd) ||
    key.itemStart < 0 ||
    key.itemEnd < key.itemStart ||
    !Number.isInteger(key.contextItemStart) ||
    !Number.isInteger(key.contextItemEnd) ||
    key.contextItemStart < 0 ||
    key.contextItemEnd < key.contextItemStart
  ) {
    return refuse('invalid-key: malformed item/context ranges');
  }
  // The item has ONE range seen from two frames (§3.1): the paragraph frame
  // and the context frame must describe the same length.
  if (key.itemEnd - key.itemStart !== key.contextItemEnd - key.contextItemStart) {
    return refuse('invalid-key: item range length differs between paragraph and context frames');
  }
  return ok();
}

/**
 * Complete field-wise key equality (lead correction 2), shared by every
 * boundary that must decide whether two key-shaped values are THE SAME
 * identity: snapshot serving (text-shaping-snapshot.ts) and safe-unit
 * proof binding (text-shaping-extraction.ts). The opaque epoch is
 * compared by identity (Object.is), never by serialization
 * (clarification 1). Callers validate both keys' shapes first
 * (validateShapeKey); this comparator assumes readable fields.
 */
export function shapeKeysEqual(a: ShapeKey, b: ShapeKey): boolean {
  const scalarFields = [
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
    'itemStart',
    'itemEnd',
    'contextKind',
    'contextSha256',
    'contextItemStart',
    'contextItemEnd',
    'paragraphLevelsSha256',
    'lineLevelsSha256',
  ] as const;
  for (const field of scalarFields) {
    if (a[field] !== b[field]) return false;
  }
  if (a.features.length !== b.features.length || a.features.some((value, i) => value !== b.features[i])) return false;
  if (a.bufferFlags.length !== b.bufferFlags.length || a.bufferFlags.some((value, i) => value !== b.bufferFlags[i])) {
    return false;
  }
  const aCoords = Object.entries(a.variationCoords);
  if (aCoords.length !== Object.keys(b.variationCoords).length) return false;
  if (aCoords.some(([name, value]) => b.variationCoords[name] !== value)) return false;
  return Object.is(a.fontEpoch, b.fontEpoch);
}
