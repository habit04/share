import type { Point } from '../../core/geometry';
import type { Gpu2DView } from './geometry2d';
import { float32RoundoffBound } from './native-float-stroke-bound';

export interface NativeFloatCurveOptions {
  readonly minRatio?: number;
  readonly panPhysical?: number;
  /** Existing world-construction reserve, only to inflate native argument bounds.
   * It is NOT added to the returned error: callers account for that reserve once.
   */
  readonly nativeParameterUncertaintyCss?: number;
}
export interface NativeFloatCurveBound {
  /** This repairs parameter construction, not native angle/conic/raster accuracy. */
  readonly scope: 'center-radius-oval';
  readonly errorCss: number;
  readonly problem: string | null;
  readonly failure: 'precision' | 'topology' | null;
}

const PARAMETER_RESERVE_PHYSICAL = 0.0625;
const refused = (problem: string, failure: 'precision' | 'topology', errorCss = Infinity): NativeFloatCurveBound => ({ scope: 'center-radius-oval', errorCss, problem, failure });

interface OvalAxisBound { centerError: number; radiusError: number }

/** Model the pinned oval's FLOAT L/R, FLOAT width/2 and FLOAT midpoint.
 * sk_float_midpoint adds its float inputs in double, then rounds just once.
 * These are basic IEEE operations; there is no sampled trigonometric envelope.
 */
function ovalAxisBound(centerMagnitude: number, centerRound: number, radiusMaximum: number, radiusRound: number): OvalAxisBound {
  const edgeRound = float32RoundoffBound(centerMagnitude + centerRound + radiusMaximum + radiusRound);
  const edgeError = centerRound + radiusRound + edgeRound;
  const reconstructedCenterRound = float32RoundoffBound(centerMagnitude + edgeError);
  // Rectangle width() subtracts two floats in float; dividing by two is exact
  // for normal values, with an explicit subnormal rounding allowance as well.
  const spanRound = float32RoundoffBound(2 * (radiusMaximum + edgeError));
  const halfRound = float32RoundoffBound(radiusMaximum + edgeError + spanRound / 2);
  return { centerError: edgeError + reconstructedCenterRound, radiusError: edgeError + spanRound / 2 + halfRound };
}

/** Parameter-only bound for existing CIRCLE/ARC painters on the pinned
 * experimental Electron44.7/Chromium152/Skia path. No runtime profile or native
 * libm/angle/conic/stroker dispatch is proved by this helper. The existing
 * canvasArcAdmission gate and its limitations stay separate and unchanged.
 *
 * CanvasPath::arc first casts absolute CSS center and radius to binary32.
 * AddEllipse builds FLOAT L/T/R/B; SkPathBuilder derives FLOAT semiaxes and
 * midpoint. The optional ArcPaintOp starts from the same cast parameter tuple;
 * conservatively covering both forms cannot hide a source alias by clipping.
 *
 * https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/canvas_path.cc#L401-L448
 * https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/platform/geometry/path_builder.cc#L364-L394
 * https://github.com/google/skia/blob/e8efd15f214a4d59b427f55f7769b6dbbb09bbcc/src/core/SkPathBuilder.cpp#L377-L388
 * https://github.com/google/skia/blob/e8efd15f214a4d59b427f55f7769b6dbbb09bbcc/include/private/SkFloatingPoint.h#L129-L133
 *
 * Returns CSS units so the caller multiplies by requested DPR once. The actual
 * physical error must be DEDUCTED from the existing tessellation allowance:
 * direct .1875-error + error + .0625 shader <= .25; compiled .125-error + error
 * + .0625 existing world construction + .0625 shader <= .25. This is neither
 * a new allowance nor additional renderer coverage.
 */
export function nativeFloatCurveBound(centerCss: Point, radiusCss: number, widthCss: number, view: Pick<Gpu2DView, 'width' | 'height' | 'dpr' | 'twist'>, maxRatio: number, options: NativeFloatCurveOptions = {}): NativeFloatCurveBound {
  const minRatio = options.minRatio ?? 0.8, panPhysical = options.panPhysical ?? 128;
  const parameterUncertainty = options.nativeParameterUncertaintyCss ?? 0;
  if (![centerCss.x, centerCss.y, radiusCss, widthCss, view.width, view.height, view.dpr, view.twist, minRatio, maxRatio, panPhysical, parameterUncertainty].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.dpr <= 0 || radiusCss < 0 || widthCss <= 0 || minRatio < 0.8 || minRatio > 1 || maxRatio < 1 || maxRatio > 4 || panPhysical < 0 || panPhysical > 128 || parameterUncertainty < 0) return refused('invalid native float curve parameter envelope', 'topology');
  const nativeDpr = Math.fround(view.dpr);
  if (!Number.isFinite(nativeDpr) || !(nativeDpr > 0)) return refused('native float DPR coefficient is unproved', 'topology');
  if (view.twist !== 0) return refused('native context rotation is unproved', 'topology');
  const radiusMinimum = radiusCss * minRatio - parameterUncertainty;
  const radiusMaximum = radiusCss * maxRatio + parameterUncertainty;
  if (!(radiusMinimum > 0) || !(Math.fround(radiusMinimum) > 0)) return refused('native float curve radius is unproved', 'topology');
  const halfX = view.width / 2, halfY = view.height / 2;
  const pan = panPhysical / Math.max(1, view.dpr);
  const magnitude = (coordinate: number, pivot: number): number => Math.max(Math.abs(pivot + (coordinate - pivot) * minRatio), Math.abs(pivot + (coordinate - pivot) * maxRatio)) + pan + parameterUncertainty;
  const cx = magnitude(centerCss.x, halfX), cy = magnitude(centerCss.y, halfY);
  const qr = float32RoundoffBound(radiusMaximum);
  const x = ovalAxisBound(cx, float32RoundoffBound(cx), radiusMaximum, qr);
  const y = ovalAxisBound(cy, float32RoundoffBound(cy), radiusMaximum, qr);
  const radiusError = Math.max(x.radiusError, y.radiusError);
  const lower = radiusMinimum - radiusError;
  if (!(lower > 0) || !Number.isFinite(lower)) return refused('native float curve oval topology is unproved', 'precision');
  // The cast oval may become slightly elliptical. Its tangent differs from the
  // original circle by at most max semiaxis error; normalization supplies this
  // bounded normal interval. Angular construction itself is NOT certified here.
  const normalError = Math.min(2, 2 * radiusError / lower);
  const halfWidth = widthCss / 2, widthRound = float32RoundoffBound(widthCss) / 2;
  const parameterError = Math.hypot(x.centerError + x.radiusError, y.centerError + y.radiusError);
  const extrusionError = halfWidth * normalError + widthRound;
  // Full original center/radius and stroke boundary determine all magnitudes;
  // remote centers/radii are never replaced by a visible or clipped endpoint.
  const boundaryX = cx + x.centerError + radiusMaximum + x.radiusError + halfWidth + widthRound;
  const boundaryY = cy + y.centerError + radiusMaximum + y.radiusError + halfWidth + widthRound;
  const outputX = float32RoundoffBound(boundaryX), outputY = float32RoundoffBound(boundaryY);
  const nativeX = boundaryX + outputX, nativeY = boundaryY + outputY;
  const coefficientDisplacement = Math.abs(nativeDpr - view.dpr) / view.dpr * Math.hypot(nativeX, nativeY);
  const outputError = Math.hypot(outputX, outputY) + coefficientDisplacement + Math.hypot(float32RoundoffBound(nativeX * nativeDpr), float32RoundoffBound(nativeY * nativeDpr)) / view.dpr;
  const arithmetic = 64 * Number.EPSILON * (1 + cx + cy + radiusMaximum + halfWidth);
  const errorCss = parameterError + extrusionError + outputError + arithmetic;
  if (!Number.isFinite(errorCss)) return refused('native float curve parameter construction is unproved', 'precision');
  if (errorCss * view.dpr > PARAMETER_RESERVE_PHYSICAL) return refused('native float curve parameters exceed precision budget', 'precision', errorCss);
  return { scope: 'center-radius-oval', errorCss, problem: null, failure: null };
}
