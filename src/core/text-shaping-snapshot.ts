/**
 * Priority 12.5 shaping contract — key encoding, snapshot, and host-boundary
 * result validation (contract v4 §3.4, §4, §10.1; clarifications 1, 4, 5).
 *
 * Interface slice only: no engine, no transport, no consumers. See
 * text-shaping.ts for the contract overview and the honesty limits of
 * interface/fake tests.
 */
import {
  refuse,
  ok,
  isCodePointBoundary,
  isSha256Hex,
  shapeKeysEqual,
  validateShapeKey,
  SHAPING_LIMITS,
  type ShapeCheck,
  type ShapeDirection,
  type ShapeKey,
  type ShapePrepState,
  type ShapedRun,
} from './text-shaping';
import { shapedRunWireBytes } from './text-shaping-transport';

/**
 * Render an unvalidated producer value inside a refusal message WITHOUT
 * invoking any producer conversion (round-3 correction R1). Template
 * interpolation of a Symbol throws, and of an object can execute
 * producer `toString`/`valueOf` code or throw on a null-prototype
 * object — so a value that has not yet been validated is never
 * interpolated directly. Only primitives whose conversion is total and
 * producer-independent are rendered (numbers, bigints and booleans
 * render exactly as template interpolation rendered them; strings
 * render as themselves); anything else is named by its type and never
 * converted. Refusal text is therefore built from validated primitives
 * or constants only — diagnostics are not a conversion channel.
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
 * Canonical ShapeKey serialization (clarification 1).
 *
 * Key equality is field-wise on the §3.1 tuple; this encoder produces the
 * storage string. The opaque `fontEpoch` token is encoded by IDENTITY: each
 * distinct token object (or distinct primitive) receives a serial from this
 * encoder, and the same token always receives the same serial. The token is
 * NEVER serialized through JSON — `JSON.stringify({})` is "{}" for every
 * empty object, so two different epochs would collapse into one key and a
 * lookup could serve a stale generation's results as current. With identity
 * encoding, distinct tokens — including two distinct empty objects — are
 * distinct keys, and a superseded epoch simply misses.
 *
 * One encoder serves one preparation lineage (a capture's builder and the
 * snapshot it seals share it), so serials are consistent exactly where key
 * comparisons happen.
 */
export class ShapeKeyEncoder {
  readonly #objectSerials = new WeakMap<object, number>();
  readonly #primitiveSerials = new Map<unknown, number>();
  #nextSerial = 1;

  /** The identity encoding of one opaque token. */
  encodeToken(token: unknown): string {
    if (token !== null && (typeof token === 'object' || typeof token === 'function')) {
      let serial = this.#objectSerials.get(token);
      if (serial === undefined) {
        serial = this.#nextSerial++;
        this.#objectSerials.set(token, serial);
      }
      return `token#${serial}`;
    }
    let serial = this.#primitiveSerials.get(token);
    if (serial === undefined) {
      serial = this.#nextSerial++;
      this.#primitiveSerials.set(token, serial);
    }
    return `token#${serial}`;
  }

  encode(key: ShapeKey): string {
    const coords = Object.entries(key.variationCoords).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([
      'shapekey/1',
      key.programSha256,
      key.faceIndex,
      key.engine,
      key.engineArtifactSha256,
      key.shapingDataVersion,
      key.pipelineDataVersion,
      key.script,
      key.language,
      key.direction,
      key.bidiLevel,
      key.paragraphBaseDirection,
      key.features,
      coords,
      key.normalization,
      key.clusterLevel,
      key.bufferFlags,
      key.defaultIgnorables,
      key.paragraphSha256,
      key.itemStart,
      key.itemEnd,
      key.contextKind,
      key.contextSha256,
      key.contextItemStart,
      key.contextItemEnd,
      key.paragraphLevelsSha256,
      key.lineLevelsSha256,
      this.encodeToken(key.fontEpoch),
    ]);
  }
}

/** Principal Default_Ignorable_Code_Point ranges (UCD), pinned for slice 1
    as part of the pipeline data. Used ONLY to check an uncovered range's
    kind label (§4): uncovered itself is determined by cluster set
    difference, never inferred from this table. */
const DEFAULT_IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180d],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0100, 0xe01ef],
];

export function isDefaultIgnorableCodePoint(codePoint: number): boolean {
  return DEFAULT_IGNORABLE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/** Controls consumed by UAX #9 processing (§2.3.4): embeddings, overrides,
    isolates and their terminators. ZWJ/ZWNJ are NOT in this set — they are
    shaping inputs whose ranges are normally cluster-covered (§3.3, §4). */
export function isConsumedBidiControl(codePoint: number): boolean {
  return (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

/**
 * The kind an uncovered range MUST carry, read off its content (§4). Order
 * matters: consumed bidi controls are also default ignorables in the UCD,
 * but a range the bidi step consumed is 'bidi-control' — the more specific
 * fact. A range consisting solely of default ignorables the engine emitted
 * no glyph entry for is 'default-ignorable'; anything else is 'unmapped'.
 */
export function expectedUncoveredKind(text: string): 'bidi-control' | 'default-ignorable' | 'unmapped' {
  let allControls = text.length > 0;
  let allIgnorable = text.length > 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (!isConsumedBidiControl(cp)) allControls = false;
    if (!isDefaultIgnorableCodePoint(cp)) allIgnorable = false;
  }
  if (allControls) return 'bidi-control';
  if (allIgnorable) return 'default-ignorable';
  return 'unmapped';
}

export interface ShapedRunContext {
  /** The key the run was requested under; the binding must echo it (§10.1.6). */
  readonly key: ShapeKey;
  /** paragraphText[itemStart..itemEnd] for the key's range. */
  readonly itemText: string;
  /** The host's TRUSTED expected digest of itemText, computed host-side
      from the host's own paragraph text — never from the result.
      Required (lead correction 1): without a trusted digest the binding
      has nothing independent to echo, so validation refuses its absence
      and its malformed forms rather than treating the digest as
      optional decoration. */
  readonly itemTextSha256: string;
  /** Glyph count of the bound face, from the HOST's own face record for the
      bound program hash — never from the result itself (§10.1.4). */
  readonly glyphCount: number;
  /** unitsPerEm of the bound face. */
  readonly unitsPerEm: number;
}

function bindingEchoesKey(run: ShapedRun, key: ShapeKey, ctx: ShapedRunContext): ShapeCheck {
  const b = run.binding;
  const keyCheck = validateShapeKey(b);
  if (!keyCheck.ok) return refuse(`binding-mismatch: binding is not a valid key (${keyCheck.problem})`);
  const stringFields = [
    'programSha256',
    'engine',
    'engineArtifactSha256',
    'shapingDataVersion',
    'pipelineDataVersion',
    'script',
    'language',
    'direction',
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
  for (const field of stringFields) {
    if (b[field] !== key[field]) return refuse(`binding-mismatch: ${field} does not echo the request key`);
  }
  const numberFields = ['faceIndex', 'bidiLevel', 'itemStart', 'itemEnd', 'contextItemStart', 'contextItemEnd'] as const;
  for (const field of numberFields) {
    if (b[field] !== key[field]) return refuse(`binding-mismatch: ${field} does not echo the request key`);
  }
  // Indexed comparisons, never a producer-carried method (round-3
  // correction R2): a shadowed `some` on the binding's arrays must not
  // become the validator's own failure mode — validation reads exactly
  // the stored indices, here as everywhere in this module.
  if (b.features.length !== key.features.length) {
    return refuse('binding-mismatch: features do not echo the request key');
  }
  for (let i = 0; i < b.features.length; i++) {
    if (b.features[i] !== key.features[i]) {
      return refuse('binding-mismatch: features do not echo the request key');
    }
  }
  if (b.bufferFlags.length !== key.bufferFlags.length) {
    return refuse('binding-mismatch: bufferFlags do not echo the request key');
  }
  for (let i = 0; i < b.bufferFlags.length; i++) {
    if (b.bufferFlags[i] !== key.bufferFlags[i]) {
      return refuse('binding-mismatch: bufferFlags do not echo the request key');
    }
  }
  const bCoords = Object.entries(b.variationCoords);
  const kCoords = Object.entries(key.variationCoords);
  if (bCoords.length !== kCoords.length || bCoords.some(([name, value]) => key.variationCoords[name] !== value)) {
    return refuse('binding-mismatch: variationCoords do not echo the request key');
  }
  // The epoch is compared by identity (Object.is), never by serialization
  // (clarification 1): a deserialized look-alike is a different epoch.
  if (!Object.is(b.fontEpoch, key.fontEpoch)) return refuse('binding-mismatch: fontEpoch is not the request epoch token');
  if (b.engineFaceIndex !== 0) {
    return refuse('binding-mismatch: engineFaceIndex must be 0 (extracted standalone program, clarification 2)');
  }
  // The trusted expected digest is required and pre-validated by
  // validateShapedRun (lead correction 1); the binding must echo it
  // exactly — an equal-length item shaped from different text and bound
  // with that text's digest refuses here.
  if (b.itemTextSha256 !== ctx.itemTextSha256) {
    return refuse('binding-mismatch: itemTextSha256 does not match the trusted expected item digest');
  }
  return ok();
}

/**
 * Visual-order cluster monotonicity (lead review addendum C). The stored
 * glyph sequence is in VISUAL order (§3.2): cluster starts are
 * non-decreasing for an LTR item and non-increasing for an RTL item;
 * repeated equal clusters (one-to-many) are allowed; a swapped pair of
 * distinct clusters is not monotone in either direction.
 *
 * This helper PINS the rule and its tests. validateShapedRun does not
 * yet enforce it: the delivered fake corpus includes RTL runs recorded
 * in logical order (their starts increase), so enforcing it at the host
 * boundary today would refuse recorded fakes wholesale rather than any
 * real producer output. Enforcement belongs to the engine/preparation
 * slice, which will produce true visual order; until then this check is
 * available to that slice and its absence here is a stated limit, not a
 * silent gap.
 */
export function checkVisualClusterOrder(run: ShapedRun, direction: ShapeDirection): ShapeCheck {
  if (!run || typeof run !== 'object' || !Array.isArray(run.glyphs)) {
    return refuse('cluster-order: glyphs is not an array');
  }
  for (let i = 1; i < run.glyphs.length; i++) {
    const previous = run.glyphs[i - 1]!;
    const current = run.glyphs[i]!;
    if (direction === 'ltr' && current.clusterStart < previous.clusterStart) {
      return refuse(
        `cluster-order: glyph ${i} cluster [${diagnosticValue(current.clusterStart)}, ${diagnosticValue(current.clusterEnd)}) moves backwards ` +
          'in an LTR visual sequence (swapped distinct clusters)',
      );
    }
    if (direction === 'rtl' && current.clusterStart > previous.clusterStart) {
      return refuse(
        `cluster-order: glyph ${i} cluster [${diagnosticValue(current.clusterStart)}, ${diagnosticValue(current.clusterEnd)}) moves backwards ` +
          'in an RTL visual sequence (swapped distinct clusters)',
      );
    }
  }
  return ok();
}

/**
 * Host-boundary validation of one shaped result (§10.1), performed on
 * receipt and BEFORE the result is frozen into a snapshot or handed to any
 * consumer. A result that fails is discarded whole — the item becomes
 * `missing` with the failing check named — and is never partially repaired,
 * clamped, absolutized, or re-derived.
 */
export function validateShapedRun(run: ShapedRun, ctx: ShapedRunContext): ShapeCheck {
  // 0. Structural guards (lead review addendum A): malformed structures —
  // null or missing run parts, a missing context key, host face data that
  // is not a positive integer — refuse with a named problem. Validation
  // never throws on producer data.
  if (!run || typeof run !== 'object') return refuse('invalid-run: run is not an object');
  if (!ctx || typeof ctx !== 'object') return refuse('invalid-context: context is not an object');
  if (!Array.isArray(run.glyphs)) return refuse('invalid-run: glyphs is not an array');
  if (!Array.isArray(run.uncovered)) return refuse('invalid-run: uncovered is not an array');
  if (!run.ink || typeof run.ink !== 'object') return refuse('invalid-run: ink bounds are missing');
  if (!run.binding || typeof run.binding !== 'object') return refuse('invalid-run: binding is missing');
  if (typeof ctx.itemText !== 'string') return refuse('invalid-context: itemText is not a string');
  const contextKeyCheck = validateShapeKey(ctx.key);
  if (!contextKeyCheck.ok) {
    return refuse(`invalid-context: the request key is not valid (${contextKeyCheck.problem})`);
  }
  if (!Number.isSafeInteger(ctx.glyphCount) || ctx.glyphCount <= 0) {
    return refuse('invalid-context: glyphCount from the host face record is not a positive integer');
  }
  if (!Number.isSafeInteger(ctx.unitsPerEm) || ctx.unitsPerEm <= 0) {
    return refuse('invalid-context: unitsPerEm from the host face record is not a positive integer');
  }
  const { key, itemText } = ctx;
  const itemLength = itemText.length;
  const perGlyphBound = SHAPING_LIMITS.perGlyphBoundUpemMultiple * ctx.unitsPerEm;

  // 0b. Item binding (lead correction 1). The item text must BE the
  // key's item: its length must equal the key's item span in BOTH frames
  // (the earlier code let a shorter item validate whenever the expected
  // digest echoed the SHORT text — a one-unit result could claim a
  // two-unit key), and the host's trusted expected digest is required:
  // absent or malformed refuses, and §6 below binds the run's echoed
  // digest to it.
  if (itemLength !== key.itemEnd - key.itemStart || itemLength !== key.contextItemEnd - key.contextItemStart) {
    return refuse(
      `item-binding: item text length ${itemLength} does not equal the key's item span ` +
        `${key.itemEnd - key.itemStart} (paragraph frame) / ${key.contextItemEnd - key.contextItemStart} (context frame)`,
    );
  }
  if (ctx.itemTextSha256 === undefined) {
    return refuse('item-binding: a trusted expected item digest is required (§10.1.6)');
  }
  if (!isSha256Hex(ctx.itemTextSha256)) {
    return refuse('item-binding: the trusted expected item digest is not a SHA-256 digest');
  }

  // 1. Counts first, before any deeper inspection.
  if (run.glyphs.length > SHAPING_LIMITS.glyphExpansionFactor * itemLength) {
    return refuse(`glyph-expansion: ${run.glyphs.length} glyphs exceed 4x the item length ${itemLength} (§9.3)`);
  }
  if (run.uncovered.length > itemLength) {
    return refuse(`uncovered-count: ${run.uncovered.length} uncovered ranges exceed the item length ${itemLength}`);
  }
  if (
    shapedRunWireBytes({ glyphCount: run.glyphs.length, uncoveredCount: run.uncovered.length }) >
    SHAPING_LIMITS.maxItemResultBytes
  ) {
    return refuse('result-bytes: serialized run exceeds the per-item result cap (§9.3)');
  }

  // 2. Per-glyph fields: finite, and each bounded by 64 x unitsPerEm
  // (clarification 4: this is a PER-GLYPH bound, applied per glyph only).
  // Iteration is INDEXED throughout this validator (round-2 correction
  // 2): validation must read exactly the values storage stores and
  // consumers read by index — a custom Symbol.iterator must not be
  // able to present a different sequence to validation than the one
  // that is stored.
  let sumX = 0;
  let sumY = 0;
  for (let glyphIndex = 0; glyphIndex < run.glyphs.length; glyphIndex++) {
    const glyph = run.glyphs[glyphIndex]!;
    if (!glyph || typeof glyph !== 'object') return refuse('glyph-field: glyph entry is not an object');
    if (!Number.isInteger(glyph.glyph) || glyph.glyph < 0 || glyph.glyph >= ctx.glyphCount) {
      return refuse(`glyph-range: GID ${diagnosticValue(glyph.glyph)} outside [0, ${ctx.glyphCount}) from the host face record (§10.1.4)`);
    }
    for (const [field, value] of [
      ['xAdvance', glyph.xAdvance],
      ['yAdvance', glyph.yAdvance],
      ['xOffset', glyph.xOffset],
      ['yOffset', glyph.yOffset],
    ] as const) {
      if (!Number.isFinite(value)) return refuse(`glyph-field: ${field} is not finite`);
      // The declared per-glyph wire fields are i32 (§9.4.2): a fractional
      // font-unit value has no lossless representation there, so it is
      // refused — never silently rounded (lead correction 4).
      if (!Number.isInteger(value)) {
        return refuse(`glyph-field: ${field} ${diagnosticValue(value)} is not an integer font-unit value and cannot cross the i32 wire field losslessly`);
      }
      if (Math.abs(value) > perGlyphBound) {
        return refuse(`glyph-field: ${field} ${diagnosticValue(value)} exceeds the per-glyph bound 64 x unitsPerEm (§10.1.2)`);
      }
    }
    sumX += glyph.xAdvance;
    sumY += glyph.yAdvance;
  }

  // 3. Accumulated sums (clarification 4): validated as sums, separately
  // from the per-glyph bound. The accumulated bound scales with the glyph
  // count, so an ordinary long run of in-bound glyphs passes; a run whose
  // total would overflow or disagree with its glyphs is refused.
  // The declared totals cross the wire in i64 fields (§9.4.2), so they
  // must be EXACT integers equal to the glyph sums (round-2 correction
  // 1): a fractional total inside any tolerance has no lossless i64
  // representation and is refused — never rounded, clamped, or absorbed
  // by a widened tolerance.
  if (!Number.isSafeInteger(run.advanceX) || !Number.isSafeInteger(run.advanceY)) {
    return refuse('advance-sum: advanceX/advanceY are not safe-integer totals; the declared i64 wire fields carry exact integers (§10.1.3)');
  }
  if (run.advanceX !== sumX || run.advanceY !== sumY) {
    return refuse('advance-sum: advanceX/advanceY do not equal the glyph advance sums (§10.1.3)');
  }
  const accumulatedBound = run.glyphs.length * perGlyphBound;
  if (Math.abs(run.advanceX) > accumulatedBound || Math.abs(run.advanceY) > accumulatedBound) {
    return refuse('advance-sum: accumulated advance exceeds the finite bounded sum for this glyph count');
  }

  // 4. Ink bounds: finite, SIGNED, ordered — and representable in the
  // declared wire schema (lead correction 4). The header's ink fields are
  // i32 (§9.4.2), so an accepted run's ink must be integer values inside
  // the i32 range: validation, the TS types, and the exact wire sizing
  // then agree, and no accepted value is ever wrapped or rounded in
  // transit. Negative values are data (§3.2); they are never absolutized
  // or clamped to make a check pass. The ink a producer reports is
  // pen-accumulated RUN-FRAME bounds — placement is real — so a long
  // run's ink legitimately grows with its pen travel; ink that exceeds
  // i32 is refused here by name rather than admitted on the fiction
  // that run ink stays small by construction (round-2 correction 4).
  const { ink } = run;
  if (![ink.xMin, ink.yMin, ink.xMax, ink.yMax].every(Number.isFinite)) {
    return refuse('ink-bounds: ink bounds are not finite');
  }
  for (const [field, value] of [
    ['xMin', ink.xMin],
    ['yMin', ink.yMin],
    ['xMax', ink.xMax],
    ['yMax', ink.yMax],
  ] as const) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      return refuse(
        `ink-bounds: ${field} ${diagnosticValue(value)} is not an integer in the declared i32 wire range, so it cannot cross the wire losslessly (§9.4.2)`,
      );
    }
  }
  if (ink.xMin > ink.xMax || ink.yMin > ink.yMax) return refuse('ink-bounds: ink bounds are not ordered');

  // 5. Clusters + uncovered partition the item range exactly (§4, §10.1.5).
  const rangeCheck = (
    start: number,
    end: number,
    what: string,
  ): ShapeCheck => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > itemLength) {
      return refuse(
        `cluster-partition: ${what} range [${diagnosticValue(start)}, ${diagnosticValue(end)}) is outside the item or empty`,
      );
    }
    if (!isCodePointBoundary(itemText, start) || !isCodePointBoundary(itemText, end)) {
      return refuse(
        `cluster-partition: ${what} range [${diagnosticValue(start)}, ${diagnosticValue(end)}) splits a surrogate pair`,
      );
    }
    return ok();
  };
  const uniqueClusters = new Map<string, readonly [number, number]>();
  for (let glyphIndex = 0; glyphIndex < run.glyphs.length; glyphIndex++) {
    const glyph = run.glyphs[glyphIndex]!;
    const check = rangeCheck(glyph.clusterStart, glyph.clusterEnd, 'glyph cluster');
    if (!check.ok) return check;
    uniqueClusters.set(`${glyph.clusterStart}:${glyph.clusterEnd}`, [glyph.clusterStart, glyph.clusterEnd]);
  }
  // Pairwise cluster ranges are disjoint or identical (identical is the
  // shared range of a one-to-many cluster; partial overlap is rejected).
  const clusterRanges = [...uniqueClusters.values()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < clusterRanges.length; i++) {
    if (clusterRanges[i]![0] < clusterRanges[i - 1]![1]) {
      return refuse('cluster-partition: cluster ranges partially overlap (§10.1.5)');
    }
  }
  let previousUncoveredStart = -1;
  for (let rangeIndex = 0; rangeIndex < run.uncovered.length; rangeIndex++) {
    const range = run.uncovered[rangeIndex]!;
    if (!range || typeof range !== 'object') return refuse('cluster-partition: uncovered entry is not an object');
    const check = rangeCheck(range.start, range.end, 'uncovered');
    if (!check.ok) return check;
    if (range.start <= previousUncoveredStart) {
      return refuse('cluster-partition: uncovered ranges are not sorted and disjoint (§3.2)');
    }
    previousUncoveredStart = range.start;
    // Uncovered is determined by set difference ONLY (§4): a range whose
    // text is actually cluster-covered (e.g. a hidden default-ignorable
    // entry) must not also be claimed uncovered, and no uncovered range
    // may overlap a cluster.
    for (const [clusterStart, clusterEnd] of clusterRanges) {
      if (range.start < clusterEnd && clusterStart < range.end) {
        return refuse('cluster-partition: uncovered range overlaps a glyph cluster (§4 set difference)');
      }
    }
    const expected = expectedUncoveredKind(itemText.slice(range.start, range.end));
    if (range.kind !== expected) {
      return refuse(`uncovered-kind: range labelled '${diagnosticValue(range.kind)}' but its content reads as '${expected}' (§4)`);
    }
  }
  // Exact tiling: unique clusters + uncovered, sorted, must cover
  // [0, itemLength] with no gaps and no double-claims. The uncovered
  // ranges are gathered by INDEX, never through a producer-carried
  // `map` (round-3 correction R2): a shadowed method on producer data
  // must not become the validator's own failure mode.
  const uncoveredRanges: (readonly [number, number])[] = [];
  for (let rangeIndex = 0; rangeIndex < run.uncovered.length; rangeIndex++) {
    const range = run.uncovered[rangeIndex]!;
    uncoveredRanges.push([range.start, range.end] as const);
  }
  const tiling = [...clusterRanges, ...uncoveredRanges].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of tiling) {
    if (start !== cursor) {
      return refuse(`cluster-partition: ranges do not tile the item (expected coverage at ${cursor}, found ${start})`);
    }
    cursor = end;
  }
  if (cursor !== itemLength) {
    return refuse(`cluster-partition: ranges end at ${cursor}, the item ends at ${itemLength}`);
  }

  // 6. The binding echoes the request key field-for-field (§10.1.6).
  return bindingEchoesKey(run, key, ctx);
}

/**
 * Deep-freeze a shaped run's plain data before it enters a snapshot (§3.4).
 * The one deliberate exception: `fontEpoch` values are opaque host-owned
 * tokens (clarification 1) — the slot holding the reference is frozen, the
 * token itself is never traversed or frozen.
 */
function freezeRunData(value: unknown, seen: Set<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const property of Reflect.ownKeys(value)) {
    if (property === 'fontEpoch') continue;
    freezeRunData((value as Record<PropertyKey, unknown>)[property], seen);
  }
}

function freezeKeyData(key: ShapeKey): void {
  Object.freeze(key.features);
  Object.freeze(key.bufferFlags);
  Object.freeze(key.variationCoords);
  Object.freeze(key);
}

/**
 * Plain-data enforcement for snapshot admission (lead review addendum B).
 * Returns the path of the first non-plain property, or null when the
 * graph is plain data. "Plain" means: plain objects (or arrays) whose
 * every own property is a DATA descriptor. A getter-backed property can
 * return different values after validation — deep-freezing the facade
 * does not convert an accessor into data — so getter-backed or
 * class-instance data is refused at admission rather than frozen in bad
 * faith. The `fontEpoch` SLOT must be plain data like any other, but the
 * token it holds is opaque host property (clarification 1) and is never
 * traversed.
 *
 * Arrays are canonical or refused (round-2 correction 2): a function is
 * never a plain leaf (an own `Symbol.iterator` function is code, not
 * data); an array must carry the ordinary Array.prototype (no subclass
 * instances, no swapped prototypes — freezing a subclass instance is
 * itself a hazard), a data-descriptor `length`, and a DENSE run of own
 * data descriptors for every index — a sparse hole, or a slot that
 * exists only as an inherited getter, is not stored data. Together with
 * the indexed reads in validateShapedRun, admission therefore binds to
 * exactly the values a consumer later reads by index: an iterator can
 * no longer present one glyph sequence to validation while different
 * indexed data is stored.
 *
 * An array's own keys are canonical or refused (round-3 correction
 * R2): dense plain indices alone do not make an array canonical, because
 * an array can additionally carry own NON-index properties whose values
 * are themselves plain data — an own `map` or `some` shadowed with a
 * non-callable value, an own `Symbol.iterator` set to null. The
 * descriptor walk admits those (a shadow IS plain data), and the
 * breakage lands later, on the consumers that call or iterate those
 * members — including on the frozen arrays this builder stores. The
 * only own keys a canonical array may carry are `length` and its dense
 * canonical indices; any other own string or symbol key refuses here,
 * before validation or storage, so the refusal stays atomic.
 */

/** A canonical array index key: the string form of a uint32 below
    2^32 − 1, in its only spelling ('0', '1', '2', …). Alternate
    spellings ('01', ' 1', '1e3', '-0') never name an element slot. */
function isCanonicalArrayIndex(property: string): boolean {
  const index = Number(property);
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === property;
}
function nonPlainDataPath(value: unknown, path: string, seen: Set<object>): string | null {
  if (typeof value === 'function') return path;
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return path;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return `${path}.length`;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor)) return `${path}.${index}`;
    }
    // Canonical own keys only (round-3 correction R2): beside `length`
    // and the dense indices verified above, NO other own key may ride
    // on an admitted array — a shadowed method or iterator is refused
    // here even when its value is plain data (or not a function at
    // all), because later consumers call and iterate those members.
    for (const property of Reflect.ownKeys(value)) {
      if (property === 'length') continue;
      if (typeof property === 'string' && isCanonicalArrayIndex(property)) continue;
      return `${path}.${String(property)}`;
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return path;
  }
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !('value' in descriptor)) return `${path}.${String(property)}`;
    if (property === 'fontEpoch') continue;
    const nested = nonPlainDataPath(descriptor.value, `${path}.${String(property)}`, seen);
    if (nested !== null) return nested;
  }
  return null;
}

const SEAL_TOKEN = Symbol('ShapeSnapshot.seal');

/**
 * A sealed, immutable snapshot (§3.4). Storage is a #-private map: no
 * reference to it ever leaves the class, there is no mutator method, and
 * instances are constructed only by ShapeSnapshotBuilder (enforced by the
 * module-private seal token). Stored runs are deep-frozen before insertion.
 *
 * v2's formulation is explicitly withdrawn: a snapshot is NOT "a Map frozen
 * at capture time" — Object.freeze(map) does not prevent set/delete/clear.
 */
export class ShapeSnapshot {
  readonly #entries: ReadonlyMap<string, { readonly key: ShapeKey; readonly run: ShapedRun }>;
  readonly #encoder: ShapeKeyEncoder;
  readonly captureGeneration: number;
  readonly fontEpoch: unknown;
  readonly aggregateBytes: number;

  constructor(
    token: typeof SEAL_TOKEN,
    entries: ReadonlyMap<string, { readonly key: ShapeKey; readonly run: ShapedRun }>,
    encoder: ShapeKeyEncoder,
    captureGeneration: number,
    fontEpoch: unknown,
    aggregateBytes: number,
  ) {
    if (token !== SEAL_TOKEN) {
      throw new Error('ShapeSnapshot instances are constructed only by ShapeSnapshotBuilder');
    }
    this.#entries = entries;
    this.#encoder = encoder;
    this.captureGeneration = captureGeneration;
    this.fontEpoch = fontEpoch;
    this.aggregateBytes = aggregateBytes;
    Object.freeze(this);
  }

  get(key: ShapeKey): ShapedRun | undefined {
    // A superseded epoch or generation is never served (§3.4): the epoch is
    // part of the encoded key, so a stale token simply misses; the explicit
    // identity check keeps that true even for a hand-built key.
    if (!key || typeof key !== 'object') return undefined;
    if (!Object.is(key.fontEpoch, this.fontEpoch)) return undefined;
    const entry = this.#entries.get(this.#encoder.encode(key));
    if (!entry) return undefined;
    // Lead correction 2: the encoded string is only a lookup hint. The
    // encoder is reachable (the builder exposes it, and a caller may have
    // supplied it), so its output can be replaced after sealing; freezing
    // this facade never froze the encoder. Serving therefore requires
    // the STORED key to equal the query key in every field — a poisoned
    // encoding can cause a miss, never a wrong-font serve.
    return shapeKeysEqual(entry.key, key) ? entry.run : undefined;
  }

  has(key: ShapeKey): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** A frozen copy of the stored keys; never live storage. */
  keys(): readonly ShapeKey[] {
    return Object.freeze([...this.#entries.values()].map((entry) => entry.key));
  }

  /** Synchronous, total lookup (§1): ready carries the sealed run; anything
      not in this snapshot is missing — never a Promise, never null. */
  shaped(key: ShapeKey): ShapePrepState {
    const run = this.get(key);
    return run ? { state: 'ready', run } : { state: 'missing' };
  }
}

/**
 * The host-side snapshot builder (§3.4, §10.1.7): validates every entry
 * (§10.1) before insertion, accounts its bytes incrementally against the
 * aggregate cap, deep-freezes what it stores, and seals exactly once.
 * A cancelled batch leaves no partial snapshot — the builder is simply
 * discarded; a run is fully present in the sealed snapshot or `missing`.
 */
export class ShapeSnapshotBuilder {
  readonly #encoder: ShapeKeyEncoder;
  readonly #captureGeneration: number;
  readonly #fontEpoch: unknown;
  readonly #entries = new Map<string, { readonly key: ShapeKey; readonly run: ShapedRun }>();
  #aggregateBytes = 0;
  #sealed = false;

  constructor(init: {
    readonly captureGeneration: number;
    readonly fontEpoch: unknown;
    readonly encoder?: ShapeKeyEncoder;
  }) {
    this.#captureGeneration = init.captureGeneration;
    this.#fontEpoch = init.fontEpoch;
    this.#encoder = init.encoder ?? new ShapeKeyEncoder();
  }

  get encoder(): ShapeKeyEncoder {
    return this.#encoder;
  }

  add(key: ShapeKey, run: ShapedRun, ctx: Omit<ShapedRunContext, 'key'>): ShapeCheck {
    if (this.#sealed) return refuse('snapshot-sealed: the builder has already sealed its snapshot');
    // Shape guards before ANY dereference (round-2 correction 3): a
    // null or non-object key/run refuses here — the plain-data walk
    // below treats null as "no non-plain property", so without this
    // guard a null key reached the epoch dereference and threw. These
    // are targeted guards, not a blanket exception handler.
    if (!key || typeof key !== 'object') return refuse('invalid-key: key is not an object');
    if (!run || typeof run !== 'object') return refuse('invalid-run: run is not an object');
    // Plain data first (addendum B): nothing getter-backed or
    // class-backed is validated, frozen, or stored, because its values
    // could change between validation and any later read.
    const nonPlain =
      nonPlainDataPath(key, 'key', new Set()) ?? nonPlainDataPath(run, 'run', new Set());
    if (nonPlain !== null) {
      return refuse(
        `non-plain-data: ${nonPlain} is not a plain data property; getter-backed or class-instance ` +
          'data can change after validation and is never frozen into a snapshot',
      );
    }
    if (!Object.is(key.fontEpoch, this.#fontEpoch)) {
      return refuse('epoch-mismatch: the key belongs to a different font epoch than this snapshot');
    }
    const keyCheck = validateShapeKey(key);
    if (!keyCheck.ok) return keyCheck;
    const runCheck = validateShapedRun(run, { ...ctx, key });
    if (!runCheck.ok) return runCheck;
    const encoded = this.#encoder.encode(key);
    if (this.#entries.has(encoded)) return refuse('duplicate-key: a snapshot holds one run per key');
    const bytes = shapedRunWireBytes({ glyphCount: run.glyphs.length, uncoveredCount: run.uncovered.length });
    if (this.#aggregateBytes + bytes > SHAPING_LIMITS.maxSnapshotBytes) {
      return refuse('snapshot-aggregate-cap: aggregate snapshot bytes would exceed the per-capture cap (§9.3)');
    }
    freezeKeyData(key);
    freezeRunData(run, new Set());
    this.#entries.set(encoded, { key, run });
    this.#aggregateBytes += bytes;
    return ok();
  }

  seal(): ShapeSnapshot {
    this.#sealed = true;
    return new ShapeSnapshot(
      SEAL_TOKEN,
      new Map(this.#entries),
      this.#encoder,
      this.#captureGeneration,
      this.#fontEpoch,
      this.#aggregateBytes,
    );
  }
}
