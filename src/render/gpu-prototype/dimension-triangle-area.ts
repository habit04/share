import type { Point } from '../../core/geometry';
import { sourcePrecisionCertificateError } from './stroke-precision-error';
function precision(reason: string): never {
  throw sourcePrecisionCertificateError('Unsupported Canvas stroke construction: dimension ' + reason);
}
const bits = new DataView(new ArrayBuffer(8));

/** Outward IEEE binary64 neighbors, including signed zero and subnormals. */
export function up(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
const down = (value: number): number => -up(-value);
type Interval = readonly [number, number];
function interval(lo: number, hi: number): Interval {
  if (![lo, hi].every(Number.isFinite) || lo > hi) precision('triangle arithmetic interval is unproved');
  return [lo, hi];
}
const subtract = (a: number, b: number): Interval => interval(down(a - b), up(a - b));
function product(a: Interval, b: Interval): Interval {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return interval(down(Math.min(...values)), up(Math.max(...values)));
}
const maxAbs = (a: Interval): number => Math.max(Math.abs(a[0]), Math.abs(a[1]));

export interface DimensionTriangleAreaCertificate {
  readonly winding: 1 | -1;
  readonly determinantLowerCssSquared: number;
  readonly minimumRatio: number;
  readonly minimumAreaMarginCssSquared: number;
}
/** Pure outward area envelope; no native source is manufactured. */
export function certifyTriangleAreaEnvelope(
  points: readonly [Point, Point, Point],
  errorCss: number,
  minRatio: number,
): DimensionTriangleAreaCertificate {
  if (![errorCss, minRatio, ...points.flatMap(point => [point.x, point.y])].every(Number.isFinite) || errorCss < 0 || minRatio < 0.8 || minRatio > 1) {
    return precision('invalid triangle area envelope');
  }
  const [a, b, c] = points;
  const ux = subtract(b!.x, a!.x), uy = subtract(b!.y, a!.y);
  const vx = subtract(c!.x, a!.x), vy = subtract(c!.y, a!.y);
  const positive = product(ux, vy), negative = product(uy, vx);
  const determinant = interval(down(positive[0] - negative[1]), up(positive[1] - negative[0]));
  let winding: 1 | -1;
  if (determinant[0] > 0) winding = 1;
  else if (determinant[1] < 0) winding = -1;
  else return precision('filled triangle winding is unproved');
  const determinantLower = winding === 1 ? determinant[0] : -determinant[1];
  // L1 bounds conservatively exceed Euclidean edge lengths without a libm error assumption.
  const lengths = up(up(maxAbs(ux) + maxAbs(uy)) + up(maxAbs(vx) + maxAbs(vy)));
  const error = up(errorCss);
  const lhs = down(down(minRatio * minRatio) * determinantLower);
  const rhs = up(up(up(2 * error) * up(minRatio * lengths)) + up(up(4 * error) * error));
  if (![lhs, rhs].every(Number.isFinite) || !(lhs > rhs)) precision('filled triangle area margin is unproved');
  const margin = down(lhs - rhs);
  if (!(margin > 0)) precision('filled triangle area margin underflows');
  return {
    winding,
    determinantLowerCssSquared: determinantLower,
    minimumRatio: minRatio,
    minimumAreaMarginCssSquared: margin,
  };
}
