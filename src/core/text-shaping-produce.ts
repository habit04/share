/**
 * Run assembly: turn one worker production (plain data from the
 * host's shape mode) into a validated ShapedRun under a ShapeKey.
 * Ink is pen-accumulated here from the bound face's glyph bounds
 * (§10.1 ink rules: signed, may extend left of the origin; a glyph
 * whose bounds are not known refuses the production rather than
 * guessing); uncovered ranges are the set difference between the
 * item's code points and the clusters the engine produced, kinded
 * by §4's predicates. The assembled run is passed through
 * `validateShapedRun` — assembly never serves an unvalidated run.
 */
import type { ShapeKey, ShapedRun } from './text-shaping';
import { expectedUncoveredKind, validateShapedRun } from './text-shaping-snapshot';
import { sha256Hex } from './sha256';

import type { AssemblyFaceMetrics, ShapeProductionData } from './text-metrics';
export type { AssemblyFaceMetrics, ShapeProductionData } from './text-metrics';


export class AssemblyRefusal extends Error {}

/**
 * Assemble + validate the run for `key`. Throws AssemblyRefusal
 * (or the validator's problem) — the session records a refusal,
 * never a partial run.
 */
export function assembleShapedRun(
  key: ShapeKey,
  itemText: string,
  production: ShapeProductionData,
  face: AssemblyFaceMetrics,
): ShapedRun {
  // Ink: pen-accumulate each glyph's bounds at its offset.
  let penX = 0;
  let penY = 0;
  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;
  let hasInk = false;
  const glyphs = production.glyphs.map((glyph) => {
    const box = face.glyphBounds[glyph.glyph];
    if (!box) {
      throw new AssemblyRefusal(`unknown-glyph-bounds: glyph ${glyph.glyph} is outside the bound face`);
    }
    if (face.glyphBoundsKnown && face.glyphBoundsKnown[glyph.glyph] === false) {
      throw new AssemblyRefusal(`unknown-glyph-bounds: glyph ${glyph.glyph} has no trustworthy outline bounds`);
    }
    const [bx0, by0, bx1, by1] = box;
    if (bx0 !== bx1 || by0 !== by1) {
      const gx0 = penX + glyph.xOffset + bx0;
      const gy0 = penY + glyph.yOffset + by0;
      const gx1 = penX + glyph.xOffset + bx1;
      const gy1 = penY + glyph.yOffset + by1;
      if (!hasInk) {
        xMin = gx0; yMin = gy0; xMax = gx1; yMax = gy1;
        hasInk = true;
      } else {
        xMin = Math.min(xMin, gx0); yMin = Math.min(yMin, gy0);
        xMax = Math.max(xMax, gx1); yMax = Math.max(yMax, gy1);
      }
    }
    penX += glyph.xAdvance;
    penY += glyph.yAdvance;
    return {
      glyph: glyph.glyph,
      clusterStart: glyph.clusterStart,
      clusterEnd: glyph.clusterEnd,
      xAdvance: glyph.xAdvance,
      yAdvance: glyph.yAdvance,
      xOffset: glyph.xOffset,
      yOffset: glyph.yOffset,
    };
  });

  // Uncovered: item code-point ranges no cluster covers.
  const coveredUntil = new Set<number>();
  for (const glyph of glyphs) {
    for (let i = glyph.clusterStart; i < glyph.clusterEnd; i += 1) coveredUntil.add(i);
  }
  const uncovered: { start: number; end: number; kind: 'bidi-control' | 'default-ignorable' | 'unmapped' }[] = [];
  let open: number | null = null;
  for (let i = 0; i <= itemText.length; i += 1) {
    const isCovered = i < itemText.length && coveredUntil.has(i);
    if (!isCovered && open === null) open = i;
    if ((isCovered || i === itemText.length) && open !== null) {
      if (open < i) {
        uncovered.push({ start: open, end: i, kind: expectedUncoveredKind(itemText.slice(open, i)) });
      }
      open = null;
    }
  }

  const itemTextSha256 = sha256Hex(itemText);
  const run: ShapedRun = {
    glyphs,
    advanceX: glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0),
    advanceY: glyphs.reduce((sum, glyph) => sum + glyph.yAdvance, 0),
    ink: { xMin, yMin, xMax, yMax },
    uncovered,
    binding: { ...key, itemTextSha256, engineFaceIndex: 0 },
  };
  validateShapedRun(run, {
    key,
    itemText,
    itemTextSha256,
    glyphCount: production.faceGlyphCount,
    unitsPerEm: production.unitsPerEm,
  });
  return run;
}
