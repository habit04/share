import type { Point } from '../../core/geometry';
import type { Gpu2DView } from './geometry2d';

export interface NativeFloatStrokeBound {
  readonly errorCss: number;
  readonly problem: string | null;
  readonly failure: 'precision' | 'topology' | null;
}
export interface NativeFloatStrokeOptions {
  readonly minRatio?: number;
  /** Per-axis physical camera translation; the renderer uses at most 128. */
  readonly panPhysical?: number;
}
export interface FloatStrokeDirection {
  readonly normal: Point;
  readonly degenerate: boolean;
  /** Euclidean unit-normal interval radius. */
  readonly uncertainty: number;
}

const MAX_POINTS = 1_000_000;
const FLOAT_UNIT = 2 ** -24;
const gamma = (operations: number): number => operations * FLOAT_UNIT / (1 - operations * FLOAT_UNIT);
const FLOAT_MAX = (2 - 2 ** -23) * 2 ** 127;
const bits = new DataView(new ArrayBuffer(4));
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const validPoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const refused = (problem: string, failure: 'precision' | 'topology' = 'precision'): NativeFloatStrokeBound => ({ errorCss: Infinity, problem, failure });

/** Half an IEEE binary32 spacing over [-magnitude,magnitude], including subnormals.
 * Taking the ceiling float's exponent also covers a binade boundary. No log2
 * estimate, sampled pose, or trig-library accuracy assumption is involved.
 */
export function float32RoundoffBound(magnitude: number): number {
  if (!Number.isFinite(magnitude) || magnitude < 0 || magnitude > FLOAT_MAX) return Infinity;
  bits.setFloat32(0, magnitude);
  if (bits.getFloat32(0) < magnitude) bits.setUint32(0, bits.getUint32(0) + 1);
  const exponent = (bits.getUint32(0) >>> 23) & 255;
  return exponent === 0 ? 2 ** -150 : 2 ** (exponent - 151);
}

interface Boundary { kind: 'flat' | 'miter' | 'bevel'; side: number; vector: Point; uncertainty: number }

/** The quotient interval is shared with the isolated join-refinement assessment.
 * Normal intervals include input casts; this avoids the former blanket 200x
 * amplification, while proving side and the complete 10h miter branch.
 */
function boundary(incoming: FloatStrokeDirection, outgoing: FloatStrokeDirection, half: number, nativeFloat = false): Boundary | string {
  for (const direction of [incoming, outgoing]) {
    const length = Math.hypot(direction.normal.x, direction.normal.y);
    if (direction.degenerate) return 'degenerate join is unproved';
    if (!Number.isFinite(length) || !Number.isFinite(direction.uncertainty) || direction.uncertainty < 0 || direction.uncertainty >= 0.25 || Math.abs(length - 1) > direction.uncertainty + 128 * Number.EPSILON) return 'unit normal interval is unproved';
  }
  const a = incoming.normal, b = outgoing.normal;
  const cross = a.x * b.y - a.y * b.x, denominator = 1 + a.x * b.x + a.y * b.y;
  const eta = incoming.uncertainty + outgoing.uncertainty;
  // Native normal dot/cross, half-angle, miter length/vector and width scaling
  // have a bounded straight branch of at most sixteen scalar float basic
  // operations. gamma(16) includes their round-to-nearest evaluation reserve;
  // input normal intervals are handled separately. No sin/cos is evaluated.
  const evaluation = nativeFloat ? gamma(16) : 0;
  const arithmetic = (128 * Number.EPSILON + evaluation) * (1 + Math.abs(cross) + Math.abs(denominator));
  const delta = eta + incoming.uncertainty * outgoing.uncertainty + arithmetic;
  const lower = denominator - delta;
  if (!(lower > 1e-10)) return 'near-reversal join is unproved';
  const sum = { x: a.x + b.x, y: a.y + b.y };
  const vector = { x: sum.x * half / denominator, y: sum.y * half / denominator };
  const length = Math.hypot(vector.x, vector.y);
  const uncertainty = half * (eta / lower + Math.hypot(sum.x, sum.y) * delta / (denominator * lower)) + (64 * Number.EPSILON + evaluation) * (1 + half + length);
  if (!Number.isFinite(uncertainty)) return 'nonfinite join uncertainty';
  // Even when no extra join triangle is emitted, the boundary is +/-h*n,
  // never an offset of zero. A smooth continuation therefore remains bounded.
  if (denominator > 1 && Math.abs(cross) <= 1e-12 + delta) return { kind: 'flat', side: 0, vector, uncertainty };
  if (Math.abs(cross) <= 1e-12 + delta) return 'join side is within arithmetic uncertainty';
  if (Math.abs(length - half * 10) <= uncertainty) return 'miter limit is within arithmetic uncertainty';
  return { kind: length <= half * 10 ? 'miter' : 'bevel', side: cross > 0 ? -1 : 1, vector, uncertainty };
}

export function compareFloatStrokeJoin(candidateIn: FloatStrokeDirection, candidateOut: FloatStrokeDirection, referenceIn: FloatStrokeDirection, referenceOut: FloatStrokeDirection, half: number): NativeFloatStrokeBound {
  if (!Number.isFinite(half) || half < 0) return refused('invalid join halfwidth', 'topology');
  const a = boundary(candidateIn, candidateOut, half), b = boundary(referenceIn, referenceOut, half, true);
  if (typeof a === 'string') return refused(a);
  if (typeof b === 'string') return refused(b);
  if ((a.kind === 'bevel') !== (b.kind === 'bevel')) return refused('miter or bevel branch changes', 'topology');
  if (a.side && b.side && a.side !== b.side) return refused('join outer side changes', 'topology');
  let error = Math.max(distance(candidateIn.normal, referenceIn.normal) + candidateIn.uncertainty + referenceIn.uncertainty, distance(candidateOut.normal, referenceOut.normal) + candidateOut.uncertainty + referenceOut.uncertainty) * half;
  if (a.kind !== 'bevel') error = Math.max(error, distance(a.vector, b.vector) + a.uncertainty + b.uncertainty);
  // Pinned Skia MiterJoiner skips the join when Dot2AngleType is nearly-line
  // (1-dot <= 1/4096). Its straight outer edge can then connect the two strip
  // boundaries rather than pass through the ideal miter. Their separation
  // bounds that entire linear edge, including a possible branch transition.
  // https://github.com/google/skia/blob/e8efd15f214a4d59b427f55f7769b6dbbb09bbcc/src/core/SkStrokerPriv.cpp
  const referenceDot = referenceIn.normal.x * referenceOut.normal.x + referenceIn.normal.y * referenceOut.normal.y;
  const referenceEta = referenceIn.uncertainty + referenceOut.uncertainty;
  const referenceDotDelta = referenceEta + referenceIn.uncertainty * referenceOut.uncertainty + 4 * FLOAT_UNIT;
  if (referenceDot + referenceDotDelta >= 1 - 2 ** -12) error += half * (distance(referenceIn.normal, referenceOut.normal) + referenceEta);
  error += 64 * Number.EPSILON * (1 + half + error);
  return Number.isFinite(error) ? { errorCss: error, problem: null, failure: null } : refused('nonfinite join comparison');
}

interface CertifiedPoint { local: Point; native: Point; localArithmetic: number; nativeInput: number; error: number }
interface CertifiedSegment { local: FloatStrokeDirection; native: FloatStrokeDirection }

/** Full-source construction certificate, in CSS pixels; caller applies its SAME
 * .0625 physical source reserve once. This is not an additional pixel allowance.
 *
 * This helper targets the pinned experimental Electron44.7/Chromium152/Skia
 * straight-stroker path; it is not a universal browser/runtime guarantee.
 * Blink casts moveTo/lineTo absolute painter arguments to binary32 BEFORE the
 * invertible context transform. DPR is post-path scaling. The source is pinned:
 * https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/canvas_path.cc
 * Nonzero twist cannot be certified from JS sin/cos alone: native RotateRadians
 * calls a different libm, whose agreement has no established bound. Refuse it
 * until actual matrix coefficients can be supplied through a separate proof.
 * Curves and their implicit native connectors are outside this helper.
 */
export function nativeFloatStrokeBound(local: readonly Point[], native: readonly Point[], closed: boolean, widthCss: number, view: Pick<Gpu2DView, 'width' | 'height' | 'dpr' | 'twist'>, maxRatio: number, options: NativeFloatStrokeOptions = {}): NativeFloatStrokeBound {
  const minRatio = options.minRatio ?? 0.8, panPhysical = options.panPhysical ?? 128;
  if (local.length !== native.length) return refused('point topology changes', 'topology');
  if (local.length > MAX_POINTS) return refused('native Float32 source work budget exceeded', 'topology');
  if (![view.width, view.height, view.dpr, view.twist, widthCss, minRatio, maxRatio, panPhysical].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.dpr <= 0 || widthCss < 0 || minRatio < 0.8 || minRatio > 1 || maxRatio < 1 || maxRatio > 4 || panPhysical < 0 || panPhysical > 128) return refused('invalid native Float32 stroke envelope', 'topology');
  // Canvas scale/setTransform casts the incoming DPR coefficient immediately.
  // DPR itself can be a double product of device scale and page zoom. Saturated
  // overflow and a singular zero coefficient have no admitted renderer mapping.
  // https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/canvas_2d_recorder_context.cc#L1275-L1459
  const nativeDpr = Math.fround(view.dpr);
  if (!Number.isFinite(nativeDpr) || !(nativeDpr > 0)) return refused('native float DPR coefficient is unproved', 'topology');
  const dprCoefficientError = Math.abs(nativeDpr - view.dpr) / view.dpr;
  if (view.twist !== 0) return refused('native context rotation is unproved', 'topology');
  if (!local.length) return { errorCss: 0, problem: null, failure: null };
  const pan = panPhysical / Math.max(1, view.dpr), half = widthCss / 2;
  const halfX = view.width / 2, halfY = view.height / 2;
  const point = (index: number): CertifiedPoint | null => {
    const a = local[index]!, b = native[index]!;
    if (!validPoint(a) || !validPoint(b)) return null;
    const x = Math.max(Math.abs(halfX + (b.x - halfX) * minRatio), Math.abs(halfX + (b.x - halfX) * maxRatio)) + pan;
    const y = Math.max(Math.abs(halfY + (b.y - halfY) * minRatio), Math.abs(halfY + (b.y - halfY) * maxRatio)) + pan;
    const inputRoundX = float32RoundoffBound(x), inputRoundY = float32RoundoffBound(y);
    const nativeInput = Math.hypot(inputRoundX, inputRoundY);
    // Stroke boundary points can be stored in float too. Include the absolute
    // pivot+offset rounding, and subsequent DPR mapping, without clipping away
    // a remote source point. The largest admitted miter is 10 halfwidths.
    const boundaryMagnitudeX = x + inputRoundX + half * 10, boundaryMagnitudeY = y + inputRoundY + half * 10;
    const outputRoundX = float32RoundoffBound(boundaryMagnitudeX), outputRoundY = float32RoundoffBound(boundaryMagnitudeY);
    const nativeBoundaryX = boundaryMagnitudeX + outputRoundX, nativeBoundaryY = boundaryMagnitudeY + outputRoundY;
    // Triangle inequality: |nativeDpr*q - requestedDpr*p| contains BOTH the
    // q/p displacement and |nativeDpr-requestedDpr|*|q|. The latter depends on
    // full absolute pivot/offset magnitudes, even for an offscreen or zero path.
    // Map/output roundoff is evaluated using the ACTUAL float coefficient.
    // Divide by requested DPR only to return CSS units; caller multiplies once.
    const coefficientDisplacement = dprCoefficientError * Math.hypot(nativeBoundaryX, nativeBoundaryY);
    const nativeOutput = Math.hypot(outputRoundX, outputRoundY) + coefficientDisplacement + Math.hypot(float32RoundoffBound(nativeBoundaryX * nativeDpr), float32RoundoffBound(nativeBoundaryY * nativeDpr)) / view.dpr;
    const magnitude = Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) * maxRatio + Math.max(view.width, view.height) + pan;
    const localArithmetic = 64 * Number.EPSILON * magnitude;
    return { local: a, native: b, localArithmetic, nativeInput, error: distance(a, b) * maxRatio + nativeInput + nativeOutput + localArithmetic };
  };
  const segment = (a: CertifiedPoint, b: CertifiedPoint): CertifiedSegment | string => {
    const direction = (p: Point, q: Point, endpointError: number): FloatStrokeDirection => {
      const dx = q.x - p.x, dy = q.y - p.y, length = Math.hypot(dx, dy);
      if (!length) return { normal: { x: 0, y: 0 }, degenerate: true, uncertainty: 0 };
      const lower = length * minRatio - endpointError;
      return { normal: { x: -dy / length, y: dx / length }, degenerate: false, uncertainty: lower > 0 ? 2 * endpointError / lower + 64 * Number.EPSILON : Infinity };
    };
    const d = direction(a.local, b.local, a.localArithmetic + b.localArithmetic);
    const nativeDirection = direction(a.native, b.native, a.nativeInput + b.nativeInput + a.localArithmetic + b.localArithmetic);
    // Input-vector subtraction/scaling, rounded normalized components and
    // float dot products are elementary IEEE operations, not a libm trig
    // envelope. Eight unit roundoffs conservatively cover their component
    // reserves; the join quotient itself supplies its amplified interval.
    const n = { ...nativeDirection, uncertainty: nativeDirection.uncertainty + (nativeDirection.degenerate ? 0 : gamma(8)) };
    if (d.degenerate !== n.degenerate) return 'segment degeneracy changes';
    if (!d.degenerate) {
      if (Math.fround(a.native.x) === Math.fround(b.native.x) && Math.fround(a.native.y) === Math.fround(b.native.y)) return 'native float segment topology is unproved';
      // SkStroke's butt cap may prune a teeny line. A conservative physical
      // threshold of 1/4096 (larger than its 1/(4096*4*resScale) tolerance)
      // keeps unproved short-connector topology outside this certificate.
      if (Math.max(Math.abs(b.native.x - a.native.x), Math.abs(b.native.y - a.native.y)) * minRatio * view.dpr <= 2 ** -12 + (a.nativeInput + b.nativeInput) * view.dpr) return 'native Float32 segment direction is unproved';
      // Native input intervals must remain nondegenerate over EVERY ratio/pan.
      if (!Number.isFinite(d.uncertainty) || !Number.isFinite(n.uncertainty) || Math.max(d.uncertainty, n.uncertainty) >= 0.25) return 'native Float32 segment direction is unproved';
    }
    return { local: d, native: n };
  };
  const firstPoint = point(0);
  if (!firstPoint) return refused('nonfinite native point', 'topology');
  let previousPoint = firstPoint, firstSegment: CertifiedSegment | null = null, previousSegment: CertifiedSegment | null = null;
  let error = firstPoint.error, zeroAfterReal = false, hasZero = false;
  const count = closed ? local.length : local.length - 1;
  for (let index = 0; index < count; index++) {
    const next = index + 1 === local.length ? firstPoint : point(index + 1);
    if (!next) return refused('nonfinite native point', 'topology');
    error = Math.max(error, next.error);
    const current = segment(previousPoint, next);
    if (typeof current === 'string') return refused(current, current === 'native Float32 segment direction is unproved' ? 'precision' : 'topology');
    if (current.local.degenerate) {
      hasZero = true;
      if (closed && previousSegment) return refused('internal degenerate join is unproved', 'topology');
      if (previousSegment) zeroAfterReal = true;
    } else {
      if (zeroAfterReal || closed && hasZero) return refused('internal degenerate join is unproved', 'topology');
      const normalError = half * (distance(current.local.normal, current.native.normal) + current.local.uncertainty + current.native.uncertainty);
      error = Math.max(error, Math.max(previousPoint.error, next.error) + normalError);
      if (previousSegment) {
        const join = compareFloatStrokeJoin(previousSegment.local, current.local, previousSegment.native, current.native, half);
        if (join.problem) return join;
        error = Math.max(error, previousPoint.error + join.errorCss);
      }
      firstSegment ??= current;
      previousSegment = current;
    }
    previousPoint = next;
  }
  if (closed && firstSegment && previousSegment) {
    if (hasZero) return refused('internal degenerate join is unproved', 'topology');
    const join = compareFloatStrokeJoin(previousSegment.local, firstSegment.local, previousSegment.native, firstSegment.native, half);
    if (join.problem) return join;
    error = Math.max(error, firstPoint.error + join.errorCss);
  }
  return Number.isFinite(error) ? { errorCss: error, problem: null, failure: null } : refused('nonfinite native Float32 construction bound');
}
