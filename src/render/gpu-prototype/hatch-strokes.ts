import { hatchGeometry, hatchPatternLines, type HatchEntity } from '../../core/entities';
import type { Point } from '../../core/geometry';
import type { WorldPatternLine } from '../../core/hatch';

export interface HatchStrokeView {
  readonly center: Point;
  readonly scale: number;
  readonly twist: number;
  readonly dpr: number;
}

export interface HatchStrokeOptions {
  readonly minRatio?: number;
  readonly maxRatio?: number;
  /** Resolved document/layer opacity; appearance resolution belongs to the scene compiler. */
  readonly alpha?: number;
  readonly selected?: boolean;
  readonly hovered?: boolean;
  readonly maxBoundaryPoints?: number;
  readonly maxSegments?: number;
  readonly maxWork?: number;
}

/** Independent subpaths of one Canvas hatch stroke, in anchor-local world doubles. */
export interface HatchStrokePath {
  readonly kind: 'path';
  readonly points: readonly [Point, Point];
  readonly closed: false;
}

export type LoweredHatchStrokes =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true;
    readonly paths: readonly HatchStrokePath[];
    readonly minRatio: number;
    readonly maxRatio: number;
  };

const COMMON_PATTERNS = new Set(['LINE', 'NET', 'ANSI31', 'ANSI37']);
const CANONICAL_MAX_SEGMENTS = 40_000;
// Full-world pattern arithmetic has not been validated for astronomical origins. Keep such
// drawings on Canvas, even when camera rebasing would make the final vertices small. This
// limit is an admission limit, not a claim that the canonical generator has a proven error bound.
export const MAX_HATCH_PATTERN_WORLD_COORDINATE = 2 ** 24;
const MAX_FAMILIES = 16;
const MAX_FAMILY_DASHES = 64;
const DOT_PIXELS = 0.5;
const ROUNDING_RESERVE = 64 * Number.EPSILON;

function finitePoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Nonfinite hatch coordinate');
}

function patternPoint(point: Point): void {
  finitePoint(point);
  if (Math.max(Math.abs(point.x), Math.abs(point.y)) > MAX_HATCH_PATTERN_WORLD_COORDINATE) throw new Error('Unvalidated large-world hatch phase');
}

function budget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid hatch ${name} budget`);
  return value;
}

/** Bound canonical line/dash loops before hatchGeometry can allocate or enter them. */
function preflightFamilies(points: readonly Point[], lines: readonly WorldPatternLine[], maxSegments: number, maxWork: number): void {
  if (lines.length > MAX_FAMILIES) throw new Error('Hatch exceeds pattern-family budget');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const corners: Point[] = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  let work = points.length, possibleSegments = 0;
  if (work > maxWork) throw new Error('Hatch exceeds preparation-work budget');
  const intervals = Math.floor(points.length / 2);
  for (const family of lines) {
    if (family.dashes.length > MAX_FAMILY_DASHES) throw new Error('Hatch exceeds pattern-dash budget');
    if (!Number.isFinite(family.angle) || !family.dashes.every(Number.isFinite)) throw new Error('Nonfinite hatch pattern definition');
    patternPoint(family.base); patternPoint(family.offset);
    if (family.dashes.includes(0)) throw new Error('Hatch pattern dots require Canvas');
    const ux = Math.cos(family.angle), uy = Math.sin(family.angle);
    const spacing = -family.offset.x * uy + family.offset.y * ux;
    if (!Number.isFinite(spacing)) throw new Error('Nonfinite hatch pattern spacing');
    // Match the canonical generator's skipped, degenerate line family.
    if (Math.abs(spacing) < 1e-9) continue;
    let lo = Infinity, hi = -Infinity;
    for (const corner of corners) {
      const value = (-(corner.x - family.base.x) * uy + (corner.y - family.base.y) * ux) / spacing;
      if (!Number.isFinite(value)) throw new Error('Unsafe hatch pattern line index');
      lo = Math.min(lo, value); hi = Math.max(hi, value);
    }
    const first = Math.ceil(lo - 1e-9), last = Math.floor(hi + 1e-9);
    if (![first, last, last + 1].every(Number.isSafeInteger)) throw new Error('Unsafe hatch pattern line index');
    if (last - first > CANONICAL_MAX_SEGMENTS) throw new Error('Dense hatch fill requires Canvas');
    const count = Math.max(0, last - first + 1);
    const period = family.dashes.reduce((sum, dash) => sum + Math.abs(dash), 0);
    if (!Number.isFinite(period)) throw new Error('Nonfinite hatch dash period');
    let cycles = 1;
    if (family.dashes.length && period >= 1e-12 && count) {
      // Along-line bounds are affine in line index; its two extrema cover every origin.
      let lower = Infinity, upper = -Infinity;
      for (const index of [first, last]) {
        const origin = { x: family.base.x + family.offset.x * index, y: family.base.y + family.offset.y * index };
        patternPoint(origin);
        for (const corner of corners) {
          const along = (corner.x - origin.x) * ux + (corner.y - origin.y) * uy;
          if (!Number.isFinite(along) || !Number.isSafeInteger(Math.floor(along / period))) throw new Error('Unsafe hatch dash index');
          lower = Math.min(lower, along); upper = Math.max(upper, along);
        }
      }
      // Includes the leading partly clipped period and a rounding reserve. Refuse before
      // the canonical 100000-iteration guard could silently truncate a dash sequence.
      cycles = Math.ceil((upper - lower) / period) + 2;
      if (!Number.isSafeInteger(cycles) || cycles >= 100_000) throw new Error('Hatch exceeds dash-work budget');
    } else if (count) {
      for (const index of [first, last]) patternPoint({ x: family.base.x + family.offset.x * index, y: family.base.y + family.offset.y * index });
    }
    const dashed = family.dashes.length > 0 && period >= 1e-12;
    const ink = dashed ? family.dashes.filter((dash) => dash > 0).length : 1;
    possibleSegments += count * intervals * cycles * ink;
    work += count * (points.length + intervals * cycles * Math.max(1, family.dashes.length));
    if (!Number.isSafeInteger(work) || work > maxWork) throw new Error('Hatch exceeds preparation-work budget');
    if (!Number.isSafeInteger(possibleSegments) || possibleSegments > maxSegments) throw new Error('Hatch exceeds segment budget');
  }
}

/**
 * Lower an original top-level hatch without changing its pattern phase or loop topology.
 * Canonical hatchGeometry runs on the complete original world drawing; only its finished
 * endpoints are rebased. Each path remains a separate subpath of ONE stroke operation.
 * Refusal returns no partial paths, so the caller must use complete-view Canvas fallback.
 */
export function lowerHatchStrokes(hatch: HatchEntity, view: HatchStrokeView, options: HatchStrokeOptions = {}): LoweredHatchStrokes {
  try {
    finitePoint(view.center);
    if (![view.scale, view.twist, view.dpr].every(Number.isFinite) || view.scale <= 0 || view.dpr <= 0) throw new Error('Invalid hatch view');
    let minRatio = options.minRatio ?? 0.8;
    const maxRatio = options.maxRatio ?? 1.25;
    if (![minRatio, maxRatio].every(Number.isFinite) || minRatio <= 0 || minRatio > 1 || maxRatio < 1) throw new Error('Invalid hatch zoom interval');
    const maxBoundaryPoints = budget(options.maxBoundaryPoints ?? 4096, 'boundary-point');
    const maxSegments = budget(options.maxSegments ?? CANONICAL_MAX_SEGMENTS, 'segment');
    const maxWork = budget(options.maxWork ?? 1_000_000, 'preparation-work');
    if (maxSegments > CANONICAL_MAX_SEGMENTS) throw new Error('Hatch segment budget exceeds canonical limit');
    if (hatch.solid) throw new Error('Solid hatch fill requires Canvas');
    if (!COMMON_PATTERNS.has(hatch.pattern.trim().toUpperCase())) throw new Error(`Unsupported hatch pattern: ${hatch.pattern}`);
    if (hatch.annotative || options.selected || options.hovered) throw new Error('Hatch annotation or highlight requires Canvas');
    if ((options.alpha ?? 1) !== 1 || (typeof hatch.transparency === 'number' && hatch.transparency !== 255)) throw new Error('Transparent hatch requires Canvas');
    if (!Number.isFinite(hatch.angle) || !Number.isFinite(hatch.scale) || hatch.scale <= 0) throw new Error('Invalid hatch pattern transform');
    if (hatch.origin) patternPoint(hatch.origin);
    if ((hatch.patternLines?.length ?? 0) > MAX_FAMILIES) throw new Error('Hatch exceeds pattern-family budget');
    const points: Point[] = [];
    for (const loop of hatch.loops) {
      if (loop.points.length < 3) throw new Error('Unsupported hatch boundary loop');
      if (points.length + loop.points.length > maxBoundaryPoints) throw new Error('Hatch exceeds boundary-point budget');
      if ((loop.bulges?.length ?? 0) > maxBoundaryPoints) throw new Error('Hatch exceeds boundary-point budget');
      if (loop.bulges?.some((bulge) => !Number.isFinite(bulge) || Math.abs(bulge) > 1e-12)) throw new Error('Curved hatch boundary requires Canvas');
      for (const point of loop.points) { patternPoint(point); points.push(point); }
    }
    if (!points.length) throw new Error('Empty hatch boundary');
    const lines = hatchPatternLines(hatch);
    preflightFamilies(points, lines, maxSegments, maxWork);
    const geometry = hatchGeometry(hatch);
    if (geometry.dense) throw new Error('Dense hatch fill requires Canvas');
    if (geometry.segments.length > maxSegments) throw new Error('Hatch exceeds segment budget');
    const paths: HatchStrokePath[] = [];
    for (const [a, b] of geometry.segments) {
      patternPoint(a); patternPoint(b);
      const localA = { x: a.x - view.center.x, y: a.y - view.center.y };
      const localB = { x: b.x - view.center.x, y: b.y - view.center.y };
      finitePoint(localA); finitePoint(localB);
      // drawEntity removes tf.rotation before drawHatch and rotates the context instead.
      // Thus the dot test uses UNROTATED world axes times CSS scale, regardless of twist
      // or DPR. Euclidean length and rotated GPU axes change this Canvas decision.
      const span = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * view.scale;
      if (!Number.isFinite(span) || span <= DOT_PIXELS * (1 + ROUNDING_RESERVE)) throw new Error('Hatch dots or short strokes require Canvas');
      const safeMinimum = DOT_PIXELS / span * (1 + ROUNDING_RESERVE);
      if (safeMinimum > 1) throw new Error('Hatch is too close to the dot threshold');
      minRatio = Math.max(minRatio, safeMinimum);
      paths.push({ kind: 'path', points: [localA, localB], closed: false });
    }
    return { ok: true, paths, minRatio, maxRatio };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Hatch preparation failed' };
  }
}
