import type { Point } from './geometry';
import * as g from './geometry';
import { loopPolygon } from './hatch';
import type { HatchEntity } from './entities';
import { GeometryBudgetError } from './geometry-budget-error';

/** One native gradient colour (DXF 463, 63 and 421). RGB takes precedence over ACI. */
export interface HatchGradientColor {
  readonly position: number;
  readonly color?: number;
  readonly trueColor?: number;
}

/** Native HATCH gradient properties, independent of the pattern's angle and colour. */
export interface HatchGradient {
  readonly name: string;
  /** DXF 460 is already in radians. */
  readonly angle: number;
  /** Blend of the unshifted and shifted gradient definitions (DXF 461). */
  readonly shift: number;
  /** DXF 452 and 462 describe the colour dialog; the two stored colours are authoritative. */
  readonly singleColor: boolean;
  readonly tint: number;
  readonly colors: readonly HatchGradientColor[];
  /** DXF 450; absent means 1. Zero retains an inactive native descriptor. */
  readonly kind?: number;
  /** Native reserved value, retained even when its meaning is unsupported (DXF 451). */
  readonly reserved?: number;
  /** Native colour mode when it is not represented by singleColor (DXF 452). */
  readonly colorMode?: number;
  /** Explicit native count, when retained (DXF 453). */
  readonly colorCount?: number;
}

/** Affine mapping of normalized gradient coordinates to entity coordinates. */
export interface HatchGradientFrame {
  readonly origin: Point;
  readonly x: Point;
  readonly y: Point;
}

export interface LinearHatchGradientPlan {
  readonly frame: HatchGradientFrame;
  readonly colors: readonly [HatchGradientColor, HatchGradientColor];
  readonly shift: number;
}

export const MAX_HATCH_GRADIENT_COLORS = 16;

/** Inactive native gradient data never changes an ordinary hatch's filling or picking. */
export function hasHatchGradient(hatch: Pick<HatchEntity, 'gradient'>): boolean {
  return !!hatch.gradient && hatch.gradient.kind !== 0;
}

/** Explicitly refuse retained combinations that the native HATCH format cannot reopen. */
export function hatchGradientExportProblem(hatch: Pick<HatchEntity, 'gradient' | 'gradientFrame' | 'solid'>): string | null {
  if (!hatch.gradient) return null;
  if (!hatch.solid) return 'Cannot preserve a patterned hatch with retained gradient settings in native DXF. Keep a solid hatch or undo the pattern conversion.';
  if (hatch.gradientFrame) return 'Cannot preserve a transformed hatch gradient frame in native DXF. Undo the flattening transform or keep the gradient in its block definition.';
  return null;
}

/** Reject malformed authored data before a writer or renderer can silently coerce it. */
export function hatchGradientDataProblem(gradient: HatchGradient): string | null {
  if (typeof gradient.name !== 'string' || !gradient.name.trim().length || gradient.name.length > 256 || /[\u0000-\u001f\u007f]/.test(gradient.name)) return 'gradient name must be a nonempty single-line string of at most 256 characters';
  if (!Number.isFinite(gradient.angle)) return 'gradient angle must be finite';
  for (const key of ['shift', 'tint'] as const) if (!Number.isFinite(gradient[key]) || gradient[key] < 0 || gradient[key] > 1) return `gradient ${key} must be between 0 and 1`;
  if (typeof gradient.singleColor !== 'boolean') return 'gradient singleColor must be boolean';
  for (const key of ['kind', 'reserved', 'colorMode', 'colorCount'] as const) {
    const value = gradient[key];
    if (value !== undefined && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) return `gradient ${key} must be a signed 32-bit integer`;
  }
  if (gradient.colorMode !== undefined && gradient.singleColor !== (gradient.colorMode === 1)) return 'gradient colour mode does not match its singleColor setting';
  if (!Array.isArray(gradient.colors) || gradient.colors.length > MAX_HATCH_GRADIENT_COLORS) return `gradient must have at most ${MAX_HATCH_GRADIENT_COLORS} colours`;
  if (gradient.colorCount !== undefined && gradient.colorCount !== gradient.colors.length) return 'gradient colour count does not match its stored colours';
  for (const color of gradient.colors) {
    if (!color || !Number.isFinite(color.position) || color.position < 0 || color.position > 1) return 'gradient colour positions must be between 0 and 1';
    if (color.color !== undefined && (!Number.isInteger(color.color) || color.color < 0 || color.color > 256)) return 'gradient ACI colours must be integers between 0 and 256';
    if (color.trueColor !== undefined && (!Number.isInteger(color.trueColor) || color.trueColor < 0 || color.trueColor > 0xffffff)) return 'gradient RGB colours must be integers between 0 and 16777215';
    if (color.color === undefined && color.trueColor === undefined) return 'gradient colours must specify ACI or RGB';
  }
  return null;
}

/** Well-formed unsupported definitions are retained and displayed with an explicit fill fallback. */
export function hatchGradientRenderProblem(gradient: HatchGradient): string | null {
  const invalid = hatchGradientDataProblem(gradient);
  if (invalid) return invalid;
  if (gradient.kind === 0) return null;
  if (gradient.kind !== undefined && gradient.kind !== 1) return `gradient kind ${gradient.kind} is unsupported`;
  if (gradient.reserved !== undefined && gradient.reserved !== 0) return `gradient reserved value ${gradient.reserved} is unsupported`;
  if (gradient.colorMode !== undefined && gradient.colorMode !== 0 && gradient.colorMode !== 1) return `gradient colour mode ${gradient.colorMode} is unsupported`;
  if (gradient.name.trim().toUpperCase() !== 'LINEAR') return `gradient ${gradient.name} is retained but its rendering is unsupported`;
  // Native centered/shifted definitions are nonlinear; keep their values until their
  // field has been verified rather than treating them as ordinary colour stops.
  if (gradient.shift !== 0) return 'shifted gradient rendering is unsupported; its native definition is retained';
  if (gradient.colors.length !== 2) return 'gradient rendering requires two stored colours';
  if (gradient.colors[0]!.position !== 0 || gradient.colors[1]!.position !== 1) return 'gradient rendering requires native colour positions 0 and 1';
  if (gradient.colors.some((color) => color.trueColor === undefined && !(color.color! >= 0 && color.color! <= 255))) return 'gradient rendering requires explicit ACI or RGB colours';
  return null;
}

/**
 * Gradient-aligned projection of the hatch's world-axis bounding box. AutoCAD uses
 * the bounding-box corners even when they lie outside a triangle/concave boundary.
 * Keeping this frame through a block
 * transform preserves the colour at corresponding points instead of stretching the
 * boundary while recomputing an unrelated world-axis gradient.
 */
export function hatchGradientFrame(hatch: HatchEntity, polygons?: readonly (readonly Point[])[]): HatchGradientFrame | null {
  if (!hasHatchGradient(hatch) || !Number.isFinite(hatch.gradient!.angle)) return null;
  if (hatch.gradientFrame) return validFrame(hatch.gradientFrame) ? hatch.gradientFrame : null;
  const loops = polygons ?? hatch.loops.map(loopPolygon);
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const loop of loops) for (const point of loop) {
    if (!finitePoint(point)) return null;
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    bottom = Math.min(bottom, point.y); top = Math.max(top, point.y);
  }
  const anchor = { x: left, y: bottom };
  if (!finitePoint(anchor)) return null;
  const u = { x: Math.cos(hatch.gradient!.angle), y: Math.sin(hatch.gradient!.angle) };
  const v = { x: -u.y, y: u.x };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of [anchor, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }]) {
    const relative = g.sub(point, anchor), x = g.dot(relative, u), y = g.dot(relative, v);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const frame = { origin: g.add(anchor, g.add(g.scale(u, minX), g.scale(v, minY))), x: g.scale(u, maxX - minX), y: g.scale(v, maxY - minY) };
  return validFrame(frame) ? frame : null;
}

/** A bounded, finite LINEAR plan shared by Canvas and PDF output. */
export function linearHatchGradientPlan(hatch: HatchEntity, polygons?: readonly (readonly Point[])[]): LinearHatchGradientPlan | null {
  const gradient = hatch.gradient;
  if (!gradient || !hasHatchGradient(hatch) || hatchGradientRenderProblem(gradient)) return null;
  const frame = hatchGradientFrame(hatch, polygons);
  return frame ? { frame, colors: [gradient.colors[0]!, gradient.colors[1]!], shift: gradient.shift } : null;
}

/**
 * Axial endpoints for Canvas/PDF. A nonuniform affine frame can be oblique:
 * using frame.x directly would vary the colour along a line of constant x.
 * The projection onto the normal of frame.y gives the same coordinate as its inverse.
 */
export function linearHatchGradientAxis(frame: HatchGradientFrame): { start: Point; end: Point } | null {
  if (!validFrame(frame)) return null;
  const angle = Math.atan2(frame.y.y, frame.y.x);
  const normal = { x: -Math.sin(angle), y: Math.cos(angle) };
  const length = g.dot(frame.x, normal);
  const end = g.add(frame.origin, g.scale(normal, length));
  return Number.isFinite(length) && length !== 0 && finitePoint(end) && (end.x !== frame.origin.x || end.y !== frame.origin.y) ? { start: frame.origin, end } : null;
}

const finitePoint = (point: Point): boolean => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
function validFrame(frame: HatchGradientFrame): boolean {
  if (![frame.origin, frame.x, frame.y].every(finitePoint)) return false;
  const x = g.add(frame.origin, frame.x), y = g.add(frame.origin, frame.y);
  return [x, y, g.add(x, frame.y)].every(finitePoint) && hatchGradientCoordinates(frame, frame.origin) !== null;
}

export function hatchGradientFrameProblem(frame: HatchGradientFrame): string | null {
  return validFrame(frame) ? null : 'gradient hatch frame must contain finite, nondegenerate coordinates';
}

/** Invert after normalization so small/large drawing scales do not overflow the determinant. */
export function hatchGradientCoordinates(frame: HatchGradientFrame, point: Point): Point | null {
  if (![frame.origin, frame.x, frame.y, point].every(finitePoint)) return null;
  const magnitude = Math.max(Math.abs(frame.x.x), Math.abs(frame.x.y), Math.abs(frame.y.x), Math.abs(frame.y.y));
  if (!magnitude) return null;
  const normalize = (value: Point): Point => ({ x: value.x / magnitude, y: value.y / magnitude });
  const x = normalize(frame.x), y = normalize(frame.y), delta = normalize(g.sub(point, frame.origin));
  const determinant = g.cross(x, y);
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const local = { x: g.cross(delta, y) / determinant, y: g.cross(x, delta) / determinant };
  return finitePoint(local) ? local : null;
}

export function transformHatchGradientFrame(frame: HatchGradientFrame, tf: (point: Point) => Point): HatchGradientFrame {
  const origin = tf(frame.origin);
  const transformed = { origin, x: g.sub(tf(g.add(frame.origin, frame.x)), origin), y: g.sub(tf(g.add(frame.origin, frame.y)), origin) };
  if (!validFrame(transformed)) throw new GeometryBudgetError('Gradient hatch transform exceeds finite or nondegenerate coordinate limits.');
  return transformed;
}

/** Native gradient ACI 0/7 mean black/white, independent of entity inheritance and paper foreground. */
export function hatchGradientColorRgb(color: HatchGradientColor, resolveAci: (index: number) => number): number | null {
  if (color.trueColor !== undefined) return Number.isInteger(color.trueColor) && color.trueColor >= 0 && color.trueColor <= 0xffffff ? color.trueColor : null;
  if (color.color === 0) return 0;
  if (color.color === 7) return 0xffffff;
  if (color.color === undefined || !Number.isInteger(color.color) || color.color < 1 || color.color > 255) return null;
  const rgb = resolveAci(color.color);
  return Number.isInteger(rgb) && rgb >= 0 && rgb <= 0xffffff ? rgb : null;
}

/** Interpolate stored sRGB bytes consistently for Canvas and vector/raster plotting. */
export function interpolateGradientRgb(first: number, second: number, amount: number): number {
  const t = Math.max(0, Math.min(1, amount));
  let color = 0;
  for (const shift of [16, 8, 0]) color |= Math.round(((first >>> shift) & 255) * (1 - t) + ((second >>> shift) & 255) * t) << shift;
  return color;
}
