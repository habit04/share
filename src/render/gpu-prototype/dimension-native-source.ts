import type { DrawingState } from '../../core/document';
import type { DimensionEntity } from '../../core/dimension';
import { dimensionGeometry } from '../../core/dimension';
import type { BlockLookup, Entity, PolylineEntity } from '../../core/entities';
import type { TextGeometryContext } from '../../core/text-metrics';
import { dimensionParts, textWidth } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { isImmutableData, sealImmutableData } from '../../core/immutable-data';
import { textStyleOf, textStylesOf } from '../../io/encoding';
import { hasStrokeFont, textRenderer } from '../hershey';
import type { Gpu2DView } from './geometry2d';
import { assertPrimitiveStrokePrecision, assertStrokePathPrecision } from './stroke-parity';
import { sourceTopologyAdmissionError } from './stroke-precision-error';
import { DIMENSION_LOCAL_POINT_PREPARATION_BOUND, DIMENSION_PART_BOUND, DIMENSION_PREPARATION_MAX_WORK, preflightDimensionPreparation } from './dimension-budget';

import { certifyTriangleAreaEnvelope, up, type DimensionTriangleAreaCertificate } from './dimension-triangle-area';
const SOURCE_RESERVE = 0.0625;
const certificates = new WeakSet<object>();
export type { DimensionTriangleAreaCertificate } from './dimension-triangle-area';
function topology(reason: string): never {
  throw sourceTopologyAdmissionError('Unsupported Canvas stroke construction: dimension ' + reason);
}
function point(point: Point): Point {
  if (![point.x, point.y].every(Number.isFinite)) topology('nonfinite original source point');
  return point;
}
function projected(local: Point, view: Gpu2DView): Point {
  // The native gate below requires zero twist. Match its exact projection arithmetic.
  const c = Math.cos(view.twist), s = Math.sin(view.twist);
  return point({ x: view.width / 2 + (local.x * c - local.y * s) * view.scale, y: view.height / 2 - (local.x * s + local.y * c) * view.scale });
}

/** Source-only fill proof. Shader packing/topology and actual native raster gates remain required. */
export function certifyDimensionTriangleSource(
  local: readonly [Point, Point, Point],
  originalWorld: readonly [Point, Point, Point],
  widthCss: number,
  view: Gpu2DView,
  minRatio: number,
  maxRatio: number,
): DimensionTriangleAreaCertificate {
  if (!Number.isFinite(minRatio) || minRatio < 0.8 || minRatio > 1) topology('invalid triangle minimum ratio');
  // Native casts, actual DPR mapping, edge directions and closed joins share ONE source reserve.
  // This deliberately conservative stroke test does not emit a stroked outline for the fill.
  assertStrokePathPrecision(local, originalWorld, true, widthCss, view, maxRatio);
  return certifyTriangleAreaEnvelope(
    [projected(local[0], view), projected(local[1], view), projected(local[2], view)], up(SOURCE_RESERVE / view.dpr), minRatio,
  );
}

export interface DimensionNativeSourceOptions {
  readonly lookup?: BlockLookup;
  readonly view: Gpu2DView;
  readonly widthCss: number;
  readonly minRatio: number;
  readonly maxRatio: number;
  /** Remaining complete-scene points after the existing local helper charge. */
  readonly maxPoints: number;
  readonly maxParts: number;
  readonly maxWork?: number;
}
export interface NativeDimensionSourceCertificate {
  readonly textGeometryDependency?: TextGeometryContext;
  readonly metricKeyDependency?: object;
  readonly source: DimensionEntity;
  /** Same local sources paired by index with independently generated original WORLD sources. */
  readonly localParts: readonly Entity[];
  readonly originalWorldParts: readonly Entity[];
  /** Original authoring and part points, rebased only after actual WORLD layout construction. */
  readonly sourcePoints: readonly Point[];
  readonly triangleCertificates: readonly (DimensionTriangleAreaCertificate | null)[];
  readonly pointCharge: number;
  readonly layoutPasses: 3;
  readonly view: Gpu2DView;
  readonly minRatio: number;
  readonly maxRatio: number;
  readonly widthCss: number;
  /** Text glyph paths and curve tessellation still need the existing compiler's native gates. */
  readonly stage: 'layout-and-primitive-source';
}

function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function discrete(source: Entity): Record<string, unknown> {
  const ignored = source.type === 'line' ? ['a', 'b'] : source.type === 'polyline' ? ['points'] : source.type === 'circle' ? ['center', 'radius'] : source.type === 'arc' ? ['center', 'radius', 'startAngle', 'endAngle'] : source.type === 'text' ? ['position', 'alignmentPoint', 'firstAlignmentPoint'] : [];
  return Object.fromEntries(Object.entries(source).filter(([key]) => !ignored.includes(key)));
}
function geometryPointCount(source: Entity): number {
  switch (source.type) {
    case 'line': return 2;
    case 'polyline': return source.points.length;
    case 'text': return 1 + Number(!!source.alignmentPoint) + Number(!!source.firstAlignmentPoint);
    case 'circle':
    case 'arc': return 5;
    default: return topology(`unsupported part ${source.type}`);
  }
}
function geometryPoints(source: Entity): Point[] {
  switch (source.type) {
    case 'line': return [point(source.a), point(source.b)];
    case 'polyline': return source.points.map(point);
    case 'text': return [source.position, source.alignmentPoint, source.firstAlignmentPoint].filter((p): p is Point => !!p).map(point);
    case 'circle':
    case 'arc': {
      if (!Number.isFinite(source.radius) || source.radius < 0) topology('invalid original curve radius');
      return [source.center, { x: source.center.x - source.radius, y: source.center.y }, { x: source.center.x + source.radius, y: source.center.y }, { x: source.center.x, y: source.center.y - source.radius }, { x: source.center.x, y: source.center.y + source.radius }].map(point);
    }
    default: return topology(`unsupported part ${source.type}`);
  }
}
const triangle = (source: PolylineEntity): readonly [Point, Point, Point] => {
  if (!source.closed || !source.filled || source.points.length !== 3 || source.bulges?.some(value => value !== 0)) topology('unsupported original filled arrow');
  return [source.points[0]!, source.points[1]!, source.points[2]!];
};

/** Independent actual Canvas source pairing; never lift local geometry back into WORLD. */
export function certifyDimensionNativeSource(
  source: DimensionEntity,
  localParts: readonly Entity[],
  state: DrawingState,
  options: DimensionNativeSourceOptions,
): NativeDimensionSourceCertificate {
  const textGeometry = options.lookup?.textGeometry, metricKey = textGeometry?.cacheKey;
  if (!state.entities.includes(source)) topology('block descendants require Canvas');
  if (!isImmutableData(source)) topology('mutable dimension requires Canvas');
  if (![options.maxParts, options.maxPoints].every(v => Number.isSafeInteger(v) && v >= 0)) topology('invalid original source budget');
  const view = options.view;
  if (![view.width, view.height, view.scale, view.dpr, view.center.x, view.center.y,
        view.twist, options.widthCss, options.minRatio, options.maxRatio].every(Number.isFinite) ||
      view.width <= 0 || view.height <= 0 || view.scale <= 0 || view.dpr <= 0 ||
      options.widthCss <= 0 || options.minRatio < 0.8 || options.minRatio > 1 ||
      options.maxRatio < 1 || options.maxRatio > 4) {
    topology('invalid native source envelope');
  }
  if (view.twist !== 0) topology('native context rotation is unproved');
  if (!(Math.fround(view.dpr) > 0) || !Number.isFinite(Math.fround(view.dpr))) topology('native float DPR coefficient is unproved');
  if (localParts.length > options.maxParts || localParts.length > DIMENSION_PART_BOUND) topology('part count or painter order changes');
  // Standalone native certification is also bounded before it allocates canonical
  // WORLD parts. maxPoints describes remaining source work after <=64 local points.
  preflightDimensionPreparation(
    source, options.maxWork ?? DIMENSION_PREPARATION_MAX_WORK,
    options.maxPoints + DIMENSION_LOCAL_POINT_PREPARATION_BOUND,
    Math.min(options.maxParts, DIMENSION_PART_BOUND),
  );
  const styles = textStylesOf(state);
  const appearance = textGeometry?.resolve({ style: source.style.textStyle }) ?? textRenderer(source.style.textStyle, styles);
  if (appearance.kind !== 'stroke') topology('Canvas font requires Canvas');
  if (appearance.shxResourceId !== undefined) topology('loaded SHX requires Canvas');
  const actualWorld = dimensionParts(source, textGeometry);
  if (actualWorld.length !== localParts.length || actualWorld.length > options.maxParts) topology('part count or painter order changes');
  const anchors = [source.p1, source.p2, source.linePoint, source.center, source.textPosition].filter((p): p is Point => !!p).map(point);
  let originalPointCount = 0;
  for (const part of actualWorld) originalPointCount += geometryPointCount(part);
  // Original layout + fresh cache reference + immutable WORLD copy + nonpainted local source.
  const pointCharge = originalPointCount * 4 + anchors.length;
  if (!Number.isSafeInteger(pointCharge) || pointCharge > options.maxPoints) topology('original source exceeds point budget');
  const freshWorld = dimensionGeometry(source, textWidth) as Entity[];
  if (!sameData(actualWorld, freshWorld)) topology('stale Canvas dimension part cache requires Canvas');
  const triangles: (DimensionTriangleAreaCertificate | null)[] = actualWorld.map(() => null);
  actualWorld.forEach((native, index) => {
    const local = localParts[index]!;
    if (native.type !== local.type || !sameData(discrete(native), discrete(local))) {
      topology('layout, string, font, role or painter order changes');
    }
    if (local.type === 'text' && native.type === 'text') {
      const localFont = textGeometry?.resolve(local) ?? textRenderer(textStyleOf(local), styles, local.text);
      const worldFont = textGeometry?.resolve(native) ?? textRenderer(textStyleOf(native), styles, native.text);
      if (!hasStrokeFont || local.bold || localFont.kind !== 'stroke' || worldFont.kind !== 'stroke') {
        topology('Canvas font requires Canvas');
      }
      if (localFont.shxResourceId !== undefined || worldFont.shxResourceId !== undefined) topology('loaded SHX requires Canvas');
      return; // Complete-scene textPaths must consume this exact original WORLD text.
    }
    if (local.type === 'polyline' && native.type === 'polyline' && local.filled) {
      triangles[index] = certifyDimensionTriangleSource(
        triangle(local), triangle(native), options.widthCss, options.view, options.minRatio, options.maxRatio,
      );
      return;
    }
    if ((local.type === 'line' && native.type === 'line') ||
        (local.type === 'polyline' && native.type === 'polyline') ||
        (local.type === 'arc' && native.type === 'arc') ||
        (local.type === 'circle' && native.type === 'circle')) {
      assertPrimitiveStrokePrecision(local, native, options.widthCss, options.view, options.maxRatio);
      return;
    }
    topology('unsupported original primitive');
  });
  const originalPoints = [...anchors, ...actualWorld.flatMap(geometryPoints)];
  const sourcePoints = originalPoints.map(p => point({ x: p.x - options.view.center.x, y: p.y - options.view.center.y }));
  const originalWorldParts = sealImmutableData(structuredClone(actualWorld));
  if (textGeometry?.cacheKey !== metricKey) topology('text geometry context changed during certification');
  const certificate: NativeDimensionSourceCertificate = Object.freeze({
    ...(textGeometry ? { textGeometryDependency: textGeometry, metricKeyDependency: metricKey } : {}),
    source,
    localParts: sealImmutableData(localParts),
    originalWorldParts,
    sourcePoints: sealImmutableData(sourcePoints),
    triangleCertificates: sealImmutableData(triangles),
    pointCharge,
    layoutPasses: 3,
    view: Object.freeze({ ...options.view, center: Object.freeze({ ...options.view.center }) }),
    minRatio: options.minRatio,
    maxRatio: options.maxRatio,
    widthCss: options.widthCss,
    stage: 'layout-and-primitive-source',
  });
  certificates.add(certificate);
  return certificate;
}

/** A compiler must explicitly require this runtime provenance before lowering any dimension. */
export function isNativeDimensionSourceCertificate(value: unknown): value is NativeDimensionSourceCertificate {
  return !!value && typeof value === 'object' && certificates.has(value);
}
