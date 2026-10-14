import { hatchGeometry, hatchPatternLines, type HatchEntity, type HatchGeometry } from '../../core/entities';
import type { Point } from '../../core/geometry';
import type { WorldPatternLine } from '../../core/hatch';
import { isImmutableData } from '../../core/immutable-data';
import { hasHatchGradient } from '../../core/hatch-gradient';
import type { Gpu2DView } from './geometry2d';
import { assertStrokePathPrecision } from './stroke-parity';
import { nativeFloatStrokeBound } from './native-float-stroke-bound';
import { sourcePrecisionCertificateError, sourceTopologyAdmissionError } from './stroke-precision-error';

/** A complete view is required by the pinned native Float32 source certificate. */
export type HatchStrokeView = Gpu2DView;

export interface HatchStrokeOptions {
  readonly minRatio?: number;
  readonly maxRatio?: number;
  /** Resolved document/layer opacity; appearance resolution belongs to the scene compiler. */
  readonly alpha?: number;
  /** Scene callers must supply the resolved parent Canvas width. Standalone default: 1 CSS pixel. */
  readonly widthCss?: number;
  readonly selected?: boolean;
  readonly hovered?: boolean;
  readonly maxBoundaryPoints?: number;
  /** Combined non-painted boundary and retained local plus copied WORLD endpoint budget. */
  readonly maxPoints?: number;
  readonly maxSegments?: number;
  readonly maxWork?: number;
  /** Maximum admitted camera translation in CSS pixels. */
  readonly panPadding?: number;
}

/** Independent subpaths of one Canvas hatch stroke, in anchor-local world doubles. */
export interface HatchStrokePath {
  readonly kind: 'path';
  readonly points: readonly [Point, Point];
  /** Copied exact canonical WORLD endpoints, before rebasing; never reconstructed by adding the camera. */
  readonly worldPoints: readonly [Point, Point];
  readonly closed: false;
}

export type LoweredHatchStrokes =
  | { readonly ok: false; readonly reason: string; readonly cause?: unknown }
  | {
    readonly ok: true;
    readonly paths: readonly HatchStrokePath[];
    /** Original loop points, rebased only after canonical world generation; never painted. */
    readonly sourcePoints: readonly Point[];
    /** Conservative generator-work estimate for sharing a complete-scene budget. */
    readonly preparationWork: number;
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
/** Physical pixels reserved for Canvas endpoint construction/dot classification. */
export const HATCH_CANVAS_PIXEL_RESERVE = 0.0625;

type CanonicalCertificate = { readonly ok: true; readonly geometry: HatchGeometry } | { readonly ok: false };
const canonicalCertificates = new WeakMap<HatchEntity, CanonicalCertificate>();

function equalPoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((point, index) => Object.is(point.x, b[index]!.x) && Object.is(point.y, b[index]!.y));
}

/** Do not consume a pre-seal stale core cache, or quietly diverge from actual Canvas. */
function certifiedCanonicalGeometry(hatch: HatchEntity): HatchGeometry {
  // This geometry-only helper retains its standalone caller contract. The GPU compiler
  // requires runtime-certified immutable input before reaching here.
  if (!isImmutableData(hatch)) return hatchGeometry(hatch);
  let certificate = canonicalCertificates.get(hatch);
  if (!certificate) {
    const actual = hatchGeometry(hatch);
    // Same complete original WORLD data and canonical algorithm, but a fresh private
    // identity cannot inherit a cache entry warmed before the original was sealed.
    const fresh = hatchGeometry({ ...hatch });
    const equal = actual.dense === fresh.dense
      && actual.polys.length === fresh.polys.length && actual.polys.every((poly, index) => equalPoints(poly, fresh.polys[index]!))
      && actual.segments.length === fresh.segments.length && actual.segments.every((segment, index) => equalPoints(segment, fresh.segments[index]!));
    certificate = equal ? { ok: true, geometry: actual } : { ok: false };
    canonicalCertificates.set(hatch, certificate);
  }
  if (!certificate.ok) throw sourceTopologyAdmissionError('Cached Canvas hatch geometry differs from immutable source; Canvas rendering required');
  return certificate.geometry;
}

function finitePoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw sourceTopologyAdmissionError('Nonfinite hatch coordinate');
}

function patternPoint(point: Point): void {
  finitePoint(point);
  if (Math.max(Math.abs(point.x), Math.abs(point.y)) > MAX_HATCH_PATTERN_WORLD_COORDINATE) throw sourceTopologyAdmissionError('Unvalidated large-world hatch phase');
}

function budget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw sourceTopologyAdmissionError(`Invalid hatch ${name} budget`);
  return value;
}

/** Bound canonical line/dash loops before hatchGeometry can allocate or enter them. */
function preflightFamilies(points: readonly Point[], lines: readonly WorldPatternLine[], maxSegments: number, maxWork: number): number {
  if (lines.length > MAX_FAMILIES) throw sourceTopologyAdmissionError('Hatch exceeds pattern-family budget');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const corners: Point[] = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  let work = points.length, possibleSegments = 0;
  if (work > maxWork) throw sourceTopologyAdmissionError('Hatch exceeds preparation-work budget');
  const intervals = Math.floor(points.length / 2);
  // The canonical generator sorts up to one intersection per boundary edge on each line.
  // Charge that work too; otherwise a complicated concave boundary gets a cheap rectangle
  // estimate despite requiring many comparisons. These are budget units, not milliseconds.
  const intersectionWork = points.length * (2 + Math.ceil(Math.log2(Math.max(2, points.length))));
  for (const family of lines) {
    if (family.dashes.length > MAX_FAMILY_DASHES) throw sourceTopologyAdmissionError('Hatch exceeds pattern-dash budget');
    if (!Number.isFinite(family.angle) || !family.dashes.every(Number.isFinite)) throw sourceTopologyAdmissionError('Nonfinite hatch pattern definition');
    patternPoint(family.base); patternPoint(family.offset);
    if (family.dashes.includes(0)) throw sourceTopologyAdmissionError('Hatch pattern dots require Canvas');
    const ux = Math.cos(family.angle), uy = Math.sin(family.angle);
    const spacing = -family.offset.x * uy + family.offset.y * ux;
    if (!Number.isFinite(spacing)) throw sourceTopologyAdmissionError('Nonfinite hatch pattern spacing');
    // Match the canonical generator's skipped, degenerate line family.
    if (Math.abs(spacing) < 1e-9) continue;
    let lo = Infinity, hi = -Infinity;
    for (const corner of corners) {
      const value = (-(corner.x - family.base.x) * uy + (corner.y - family.base.y) * ux) / spacing;
      if (!Number.isFinite(value)) throw sourceTopologyAdmissionError('Unsafe hatch pattern line index');
      lo = Math.min(lo, value); hi = Math.max(hi, value);
    }
    const first = Math.ceil(lo - 1e-9), last = Math.floor(hi + 1e-9);
    if (![first, last, last + 1].every(Number.isSafeInteger)) throw sourceTopologyAdmissionError('Unsafe hatch pattern line index');
    if (last - first > CANONICAL_MAX_SEGMENTS) throw sourceTopologyAdmissionError('Dense hatch fill requires Canvas');
    const count = Math.max(0, last - first + 1);
    const period = family.dashes.reduce((sum, dash) => sum + Math.abs(dash), 0);
    if (!Number.isFinite(period)) throw sourceTopologyAdmissionError('Nonfinite hatch dash period');
    let cycles = 1;
    if (family.dashes.length && period >= 1e-12 && count) {
      // Along-line bounds are affine in line index; its two extrema cover every origin.
      let lower = Infinity, upper = -Infinity;
      for (const index of [first, last]) {
        const origin = { x: family.base.x + family.offset.x * index, y: family.base.y + family.offset.y * index };
        patternPoint(origin);
        for (const corner of corners) {
          const along = (corner.x - origin.x) * ux + (corner.y - origin.y) * uy;
          if (!Number.isFinite(along) || !Number.isSafeInteger(Math.floor(along / period))) throw sourceTopologyAdmissionError('Unsafe hatch dash index');
          lower = Math.min(lower, along); upper = Math.max(upper, along);
        }
      }
      // Includes the leading partly clipped period and a rounding reserve. Refuse before
      // the canonical 100000-iteration guard could silently truncate a dash sequence.
      cycles = Math.ceil((upper - lower) / period) + 2;
      if (!Number.isSafeInteger(cycles) || cycles >= 100_000) throw sourceTopologyAdmissionError('Hatch exceeds dash-work budget');
    } else if (count) {
      for (const index of [first, last]) patternPoint({ x: family.base.x + family.offset.x * index, y: family.base.y + family.offset.y * index });
    }
    const dashed = family.dashes.length > 0 && period >= 1e-12;
    const ink = dashed ? family.dashes.filter((dash) => dash > 0).length : 1;
    possibleSegments += count * intervals * cycles * ink;
    work += count * (intersectionWork + intervals * cycles * Math.max(1, family.dashes.length));
    if (!Number.isSafeInteger(work) || work > maxWork) throw sourceTopologyAdmissionError('Hatch exceeds preparation-work budget');
    if (!Number.isSafeInteger(possibleSegments) || possibleSegments > maxSegments) throw sourceTopologyAdmissionError('Hatch exceeds segment budget');
  }
  return work;
}

/**
 * Lower an original top-level hatch without changing its pattern phase or loop topology.
 * Canonical hatchGeometry runs on the complete original world drawing; only its finished
 * endpoints are rebased. Each path remains a separate subpath of ONE stroke operation.
 * Refusal returns no partial paths, so the caller must use complete-view Canvas fallback.
 * GPU callers must reject uncertified mutable hatches before this geometry helper: the
 * legacy core cache is identity-based. Certified sources are checked against a fresh
 * canonical reference once, including ordered loops/segments/dense metadata. The extra
 * first-use canonical generation belongs to reported geometry-preparation time.
 */
export function lowerHatchStrokes(hatch: HatchEntity, view: HatchStrokeView, options: HatchStrokeOptions = {}): LoweredHatchStrokes {
  try {
    if (hasHatchGradient(hatch)) throw sourceTopologyAdmissionError('Active gradient hatch requires Canvas');
    finitePoint(view.center);
    if (![view.scale, view.twist, view.dpr, view.width, view.height].every(Number.isFinite) || view.scale <= 0 || view.dpr <= 0 || view.width <= 0 || view.height <= 0) throw sourceTopologyAdmissionError('Invalid hatch view');
    const widthCss = options.widthCss ?? 1;
    if (!Number.isFinite(widthCss) || widthCss <= 0) throw sourceTopologyAdmissionError('Invalid hatch lineweight');
    let minRatio = options.minRatio ?? 0.8;
    const maxRatio = options.maxRatio ?? 1.25;
    if (![minRatio, maxRatio].every(Number.isFinite) || minRatio < 0.8 || minRatio > 1 || maxRatio < 1 || maxRatio > 4) throw sourceTopologyAdmissionError('Invalid hatch zoom interval');
    const maxBoundaryPoints = budget(options.maxBoundaryPoints ?? 4096, 'boundary-point');
    let maxSegments = budget(options.maxSegments ?? CANONICAL_MAX_SEGMENTS, 'segment');
    const maxPoints = budget(options.maxPoints ?? 4 * CANONICAL_MAX_SEGMENTS + 4096, 'point');
    const maxWork = budget(options.maxWork ?? 1_000_000, 'preparation-work');
    const panPadding = options.panPadding ?? 128 / Math.max(1, view.dpr);
    const width = view.width, height = view.height;
    if (!Number.isFinite(panPadding) || panPadding < 0 || panPadding > 128 / Math.max(1, view.dpr)) throw sourceTopologyAdmissionError('Invalid hatch projection interval');
    if (maxSegments > CANONICAL_MAX_SEGMENTS) throw sourceTopologyAdmissionError('Hatch segment budget exceeds canonical limit');
    if (hatch.solid) throw sourceTopologyAdmissionError('Solid hatch fill requires Canvas');
    if (!COMMON_PATTERNS.has(hatch.pattern.trim().toUpperCase())) throw sourceTopologyAdmissionError(`Unsupported hatch pattern: ${hatch.pattern}`);
    if (hatch.annotative || options.selected || options.hovered) throw sourceTopologyAdmissionError('Hatch annotation or highlight requires Canvas');
    if ((options.alpha ?? 1) !== 1 || (typeof hatch.transparency === 'number' && hatch.transparency !== 255)) throw sourceTopologyAdmissionError('Transparent hatch requires Canvas');
    if (!Number.isFinite(hatch.angle) || !Number.isFinite(hatch.scale) || hatch.scale <= 0) throw sourceTopologyAdmissionError('Invalid hatch pattern transform');
    if (hatch.origin) patternPoint(hatch.origin);
    if ((hatch.patternLines?.length ?? 0) > MAX_FAMILIES) throw sourceTopologyAdmissionError('Hatch exceeds pattern-family budget');
    const points: Point[] = [];
    for (const loop of hatch.loops) {
      if (loop.points.length < 3) throw sourceTopologyAdmissionError('Unsupported hatch boundary loop');
      if (points.length + loop.points.length > maxBoundaryPoints) throw sourceTopologyAdmissionError('Hatch exceeds boundary-point budget');
      if ((loop.bulges?.length ?? 0) > maxBoundaryPoints) throw sourceTopologyAdmissionError('Hatch exceeds boundary-point budget');
      if (loop.bulges?.some((bulge) => !Number.isFinite(bulge) || Math.abs(bulge) > 1e-12)) throw sourceTopologyAdmissionError('Curved hatch boundary requires Canvas');
      for (const point of loop.points) { patternPoint(point); points.push(point); }
    }
    if (!points.length) throw sourceTopologyAdmissionError('Empty hatch boundary');
    if (points.length > maxPoints) throw sourceTopologyAdmissionError('Hatch exceeds point budget');
    // Budget before canonical generation; the bound deliberately counts invisible segments
    // too. Clipping the boundary to save work would change phase and island topology.
    // Each retained segment has two local endpoints and two copied WORLD endpoints.
    // The canonical temporary arrays stay independently bounded by the same segment/work cap.
    maxSegments = Math.min(maxSegments, Math.floor((maxPoints - points.length) / 4));
    const lines = hatchPatternLines(hatch);
    // A first immutable certificate can run both the actual Canvas generator and its fresh
    // reference. Account for both before entering either; an external warm cache is not
    // assumed when budgeting the cold path.
    const canonicalPasses = isImmutableData(hatch) && !canonicalCertificates.has(hatch) ? 2 : 1;
    const preparationWork = preflightFamilies(points, lines, maxSegments, Math.floor(maxWork / canonicalPasses)) * canonicalPasses;
    const geometry = certifiedCanonicalGeometry(hatch);
    if (geometry.dense) throw sourceTopologyAdmissionError('Dense hatch fill requires Canvas');
    if (geometry.segments.length > maxSegments) throw sourceTopologyAdmissionError('Hatch exceeds segment budget');
    const paths: HatchStrokePath[] = [];
    const canvasReserve = HATCH_CANVAS_PIXEL_RESERVE / view.dpr;
    let projectionErrorCss = 0, nativeConstructionErrorCss = 0;
    const c = Math.cos(view.twist), s = Math.sin(view.twist);
    const project = (point: Point): Point => ({ x: width / 2 + (point.x * c - point.y * s) * view.scale, y: height / 2 - (point.x * s + point.y * c) * view.scale });
    // Canvas constructs translated/twisted endpoints, then drawEntity removes the twist
    // for drawHatch's axis test. Bound the double operations over the complete retained
    // zoom/pan interval, including source subtraction and view midpoint translation.
    const certifyProjection = (point: Point): void => {
      const worldMagnitude = Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(view.center.x), Math.abs(view.center.y), 1);
      const localMagnitude = Math.max(Math.abs(point.x - view.center.x), Math.abs(point.y - view.center.y));
      const magnitude = (worldMagnitude + localMagnitude) * view.scale * maxRatio + width + height + panPadding * (2 + 2 * maxRatio / minRatio) + 1;
      const error = 256 * Number.EPSILON * magnitude;
      if (!Number.isFinite(error) || error > canvasReserve) throw sourcePrecisionCertificateError('Canvas hatch projection exceeds precision bound');
      projectionErrorCss = Math.max(projectionErrorCss, error);
    };
    for (const point of points) certifyProjection(point);
    for (const [a, b] of geometry.segments) {
      patternPoint(a); patternPoint(b);
      certifyProjection(a); certifyProjection(b);
      const localA = { x: a.x - view.center.x, y: a.y - view.center.y };
      const localB = { x: b.x - view.center.x, y: b.y - view.center.y };
      finitePoint(localA); finitePoint(localB);
      // drawEntity removes tf.rotation before drawHatch and rotates the context instead.
      // Thus the dot test uses UNROTATED world axes times CSS scale, regardless of twist
      // or DPR. Euclidean length and rotated GPU axes change this Canvas decision.
      const span = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * view.scale;
      const threshold = DOT_PIXELS + canvasReserve;
      if (!Number.isFinite(span) || span <= threshold * (1 + ROUNDING_RESERVE)) throw sourceTopologyAdmissionError('Hatch dots or short strokes require Canvas');
      const safeMinimum = threshold / span * (1 + ROUNDING_RESERVE);
      if (safeMinimum > 1) throw sourceTopologyAdmissionError('Hatch is too close to the dot threshold');
      minRatio = Math.max(minRatio, safeMinimum);
      // Pass the original canonical endpoints directly. local + camera is not an exact
      // inverse of double subtraction and must never manufacture the native reference.
      // The current proof covers world-construction displacement, absolute native Float32
      // input/output casts, DPR mapping and width-dependent normals. Read the same native
      // bound below so its maximum and the scalar projection estimate are ADDED inside
      // ONE existing .0625 physical source reserve, never admitted independently.
      // Its standard .8..maxRatio / 128-physical-pixel envelope conservatively covers a
      // narrowed hatch interval or smaller padding. Nonzero native context twist stays refused.
      assertStrokePathPrecision([localA, localB], [a, b], false, widthCss, view, maxRatio);
      const native = nativeFloatStrokeBound([project(localA), project(localB)], [project({ x: a.x - view.center.x, y: a.y - view.center.y }), project({ x: b.x - view.center.x, y: b.y - view.center.y })], false, widthCss, view, maxRatio);
      if (native.problem) {
        const reason = `Unsupported Canvas stroke construction: ${native.problem}`;
        throw native.failure === 'topology' ? sourceTopologyAdmissionError(reason) : sourcePrecisionCertificateError(reason);
      }
      if (!Number.isFinite(native.errorCss) || native.errorCss < 0) throw sourcePrecisionCertificateError('Canvas hatch native source bound is unproved');
      nativeConstructionErrorCss = Math.max(nativeConstructionErrorCss, native.errorCss);
      paths.push({ kind: 'path', points: [localA, localB], worldPoints: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], closed: false });
    }
    if (projectionErrorCss + nativeConstructionErrorCss > canvasReserve) throw sourcePrecisionCertificateError('Canvas hatch projection and native float construction exceed shared precision bound');
    const sourcePoints = points.map((point) => {
      const local = { x: point.x - view.center.x, y: point.y - view.center.y };
      finitePoint(local);
      return local;
    });
    return { ok: true, paths, sourcePoints, preparationWork, minRatio, maxRatio };
  } catch (error) {
    const failure = { ok: false as const, reason: error instanceof Error ? error.message : 'Hatch preparation failed' };
    // Keep the original exception identity/prototype/cause chain for admission policy.
    // A wrapper must not turn a transient allocation/programming exception into an
    // apparently deliberate plain Error. Non-enumerable provenance leaves public JSON
    // and existing refusal shapes unchanged; callers must carry it into Error.cause.
    Object.defineProperty(failure, 'cause', { value: error });
    return failure;
  }
}
