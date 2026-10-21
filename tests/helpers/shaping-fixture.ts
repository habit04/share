/**
 * Synthetic fixtures for the 12.5 shaping contract tests. All font programs
 * are identified by the SHA-256 of a label string — no real font bytes, no
 * shipped font programs. Interface/fake tests pin the contract only; they
 * are not font/PDF/native acceptance (contract v4 §11, §12).
 */
import { createHash } from 'node:crypto';
import type { TextAppearance } from '../../src/core/text-metrics';
import {
  deriveShapeKey,
  type SelectedFaceRef,
  type ShapeKey,
  type ShapeKeyDerivation,
  type ShapeRequest,
  type ShapedGlyph,
  type ShapedRun,
} from '../../src/core/text-shaping';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const appearance = (overrides: Partial<{ family: string; bold: boolean; italic: boolean }> = {}): TextAppearance => ({
  kind: 'canvas',
  family: overrides.family ?? 'Synthetic Face',
  bold: overrides.bold ?? false,
  italic: overrides.italic ?? false,
  widthFactor: 1,
  oblique: 0,
});

/** A host-selection face record for a synthetic standalone program. */
export function makeFaceRef(overrides: Partial<SelectedFaceRef> = {}): SelectedFaceRef {
  return {
    programSha256: sha256('synthetic-standalone-sfnt'),
    faceIndex: 0,
    engineFaceIndex: 0,
    source: 'host-selection',
    ...overrides,
  };
}

export interface FixtureSpec {
  readonly paragraphText: string;
  readonly itemStart: number;
  readonly itemEnd: number;
  readonly contextKind?: 'paragraph' | 'line';
  readonly contextStart?: number;
  readonly contextEnd?: number;
  readonly direction?: 'ltr' | 'rtl';
  readonly bidiLevel?: number;
  readonly face?: SelectedFaceRef;
  readonly script?: string;
  readonly bufferFlags?: readonly string[];
  readonly lineLevels?: readonly number[] | null;
  readonly levels?: readonly number[];
  readonly fontEpoch?: unknown;
  readonly engineArtifactSha256?: string;
}

export function makeRequest(spec: FixtureSpec): ShapeRequest {
  const contextStart = spec.contextStart ?? 0;
  const contextEnd = spec.contextEnd ?? spec.paragraphText.length;
  return {
    paragraphText: spec.paragraphText,
    itemStart: spec.itemStart,
    itemEnd: spec.itemEnd,
    appearance: appearance(),
    face: spec.face ?? makeFaceRef(),
    direction: spec.direction ?? 'rtl',
    bidiLevel: spec.bidiLevel ?? 1,
    contextKind: spec.contextKind ?? 'paragraph',
    contextStart,
    contextEnd,
  };
}

export function makeDerivation(spec: FixtureSpec): ShapeKeyDerivation {
  const contextStart = spec.contextStart ?? 0;
  const contextEnd = spec.contextEnd ?? spec.paragraphText.length;
  const contextText = spec.paragraphText.slice(contextStart, contextEnd);
  const levels = spec.levels ?? [...spec.paragraphText].map(() => spec.bidiLevel ?? 1);
  const lineLevels = spec.lineLevels ?? null;
  return {
    engineArtifactSha256: spec.engineArtifactSha256 ?? sha256('synthetic-capped-wasm-artifact'),
    shapingDataVersion: 'unicode-16.0',
    pipelineDataVersion: 'jcad-tables-1',
    script: spec.script ?? 'Arab',
    paragraphBaseDirection: spec.direction ?? 'rtl',
    features: ['kern=off', 'liga=off'],
    bufferFlags: spec.bufferFlags ?? ['bot', 'eot'],
    paragraphSha256: sha256(spec.paragraphText),
    contextSha256: sha256(contextText),
    paragraphLevelsSha256: sha256(JSON.stringify(levels)),
    lineLevelsSha256: lineLevels === null ? null : sha256(JSON.stringify(lineLevels)),
    fontEpoch: spec.fontEpoch ?? {},
  };
}

export function makeKey(spec: FixtureSpec): ShapeKey {
  const result = deriveShapeKey(makeRequest(spec), makeDerivation(spec));
  if (!result.ok) throw new Error(`fixture key refused: ${result.problem}`);
  return result.value;
}

export interface RunSpec {
  readonly glyphs: readonly ShapedGlyph[];
  readonly uncovered?: ShapedRun['uncovered'];
  readonly ink?: ShapedRun['ink'];
  readonly advanceX?: number;
  readonly advanceY?: number;
}

/**
 * The fixture's synthetic ink model (lead correction 4, restored by
 * round-2 correction 4). A synthetic glyph inks its advance box: in its
 * own frame the box spans [xOffset, xOffset + xAdvance] horizontally
 * and the shared synthetic vertical extent [-200, 700], shifted by the
 * glyph's yOffset. A run's ink is a RUN-FRAME quantity: each glyph's
 * box is placed at the pen position accumulated from every preceding
 * glyph's advances (penX += xAdvance, penY += yAdvance), both signed
 * endpoints of every placed box enter the union. Two +500 advances
 * therefore span 0..1000, two -500 advances span -1000..0, and a glyph
 * with yOffset 1000 places its vertical extent at 800..1700.
 *
 * WITHDRAWN (round 2): the intermediate model that unioned the
 * per-glyph LOCAL boxes with no pen placement, and the claim built on
 * it — that the explicit long run (3,000 glyphs at advance 1,000,000)
 * "passes unchanged". Under the restored model that same explicit
 * input produces pen-accumulated ink.xMax = 3,000,000,000, which the
 * declared i32 ink fields cannot represent, and validateShapedRun
 * refuses it by name ('ink-bounds:') — the lossless invariant the
 * round-2 lead file's 'observation' control pins. Total advance is
 * still not a bounds substitute (the advance fields' i64 job is sums);
 * but pen placement is real in this authored rectangular model, and
 * ink beyond i32 is refused at the boundary, never wrapped or reduced
 * to fit. A real producer's ink is likewise pen-accumulated run-frame
 * data and is validated against the same integer/i32 rules on arrival.
 */
export function syntheticInk(glyphs: readonly ShapedGlyph[]): ShapedRun['ink'] {
  if (glyphs.length === 0) return { xMin: 0, yMin: -200, xMax: 1, yMax: 700 };
  let penX = 0;
  let penY = 0;
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const g of glyphs) {
    const x0 = penX + g.xOffset;
    const x1 = x0 + g.xAdvance;
    const y0 = penY + g.yOffset - 200;
    const y1 = penY + g.yOffset + 700;
    xMin = Math.min(xMin, x0, x1);
    xMax = Math.max(xMax, x0, x1);
    yMin = Math.min(yMin, y0, y1);
    yMax = Math.max(yMax, y0, y1);
    penX += g.xAdvance;
    penY += g.yAdvance;
  }
  return { xMin, yMin, xMax, yMax };
}

/** A run bound to `key`, with sums computed from the glyphs unless overridden. */
export function makeRun(key: ShapeKey, itemText: string, spec: RunSpec): ShapedRun {
  const advanceX = spec.advanceX ?? spec.glyphs.reduce((sum, g) => sum + g.xAdvance, 0);
  const advanceY = spec.advanceY ?? spec.glyphs.reduce((sum, g) => sum + g.yAdvance, 0);
  return {
    glyphs: spec.glyphs,
    advanceX,
    advanceY,
    ink: spec.ink ?? syntheticInk(spec.glyphs),
    uncovered: spec.uncovered ?? [],
    binding: { ...key, itemTextSha256: sha256(itemText), engineFaceIndex: 0 },
  };
}

export const glyph = (
  gid: number,
  clusterStart: number,
  clusterEnd: number,
  advances: Partial<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = {},
): ShapedGlyph => ({
  glyph: gid,
  clusterStart,
  clusterEnd,
  xAdvance: advances.xAdvance ?? 500,
  yAdvance: advances.yAdvance ?? 0,
  xOffset: advances.xOffset ?? 0,
  yOffset: advances.yOffset ?? 0,
});
