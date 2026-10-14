import type { DrawingState } from '../../core/document';
import type { DimensionEntity, DimStyle } from '../../core/dimension';
import { resolveDimStyle } from '../../core/dimension';
import type { ArcEntity, BlockLookup, CircleEntity, LineEntity, PolylineEntity, TextEntity } from '../../core/entities';
import type { TextGeometryContext } from '../../core/text-metrics';
import { dimensionParts } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { textPlacementProblem } from '../../core/text-placement';
import { TEXT_STYLES_META_KEY, textStyleOf, textStylesOf } from '../../io/encoding';
import { resolveColor } from '../draw';
import { hasStrokeFont, textRenderer } from '../hershey';
import { isImmutableData } from '../../core/immutable-data';
import { DIMENSION_PART_BOUND, DIMENSION_PREPARATION_MAX_WORK, preflightDimensionPreparation } from './dimension-budget';
import type { Gpu2DView } from './geometry2d';
import { certifyDimensionNativeSource, type NativeDimensionSourceCertificate } from './dimension-native-source';
import { sourceTopologyAdmissionError } from './stroke-precision-error';

interface DimensionPaint {
  /** Actual Canvas paint settings; generated role lineweights do not replace the parent width. */
  readonly colorCss: string;
  readonly alpha: number;
  readonly widthCss: number;
}

export type DimensionStrokePart =
  | (DimensionPaint & { readonly kind: 'stroke'; readonly source: LineEntity | PolylineEntity | ArcEntity | CircleEntity })
  | (DimensionPaint & { readonly kind: 'text'; readonly source: TextEntity })
  | (DimensionPaint & {
    readonly kind: 'fillTriangle';
    readonly source: PolylineEntity;
    /** Anchor-local world doubles. This paint is a fill with no stroked outline. */
    readonly points: readonly [Point, Point, Point];
  });

export interface DimensionStrokeOptions {
  readonly lookup?: BlockLookup;
  /** Subtracted before dimensionParts computes intersections, arrowheads and text placement. */
  readonly anchor: Point;
  /** Parent Canvas width, including a top-level INSERT's width or selection/hover override. */
  readonly widthCss: number;
  readonly alpha?: number;
  /** Current parent Canvas stroke before entering the dimension painter. */
  readonly ownColorCss?: string;
  readonly strokeOverride?: string;
  readonly dashed?: boolean;
  readonly maxParts?: number;
  readonly maxPoints?: number;
  readonly maxTextCharacters?: number;
  /** Opt-in original WORLD proof; compiled dimensions must explicitly require its certificate. */
  readonly nativeView?: Gpu2DView;
  readonly minRatio?: number;
  readonly maxRatio?: number;
  /** Native preparation allowance; pure-helper defaults and behavior remain unchanged. */
  readonly maxWork?: number;
}

export type LoweredDimensionStrokes =
  | { readonly ok: false; readonly reason: string; readonly cause?: unknown }
  | {
    readonly ok: true;
    /** One operation per existing Canvas part, in exactly the source painter's order. */
    readonly parts: readonly DimensionStrokePart[];
    readonly dimensionStyleDependency: DimStyle;
    /** Use the raw document identity, rather than textStylesOf's fresh absent-style default. */
    readonly textStylesDependency: unknown;
    readonly textGeometryDependency?: TextGeometryContext;
    readonly metricKeyDependency?: object;
    readonly pointCount: number;
    readonly textCharacterCount: number;
    readonly nativeSourceCertificate?: NativeDimensionSourceCertificate;
    readonly preparationWork?: number;
  };

function finitePoint(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw sourceTopologyAdmissionError('Nonfinite dimension coordinate');
  return point;
}

function displayColor(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw sourceTopologyAdmissionError('Unsupported dimension display color');
  return color;
}

/**
 * Lower a dimension without duplicating its corrected layout math. This is a preflight stage:
 * text glyph compilation, curve error bounds, triangle clipping and GL submission belong to
 * the complete-scene compiler/renderer. A refusal never exposes a partially supported dimension.
 * For an already anchor-local block descendant, pass a zero anchor to avoid subtracting twice.
 */
export function lowerDimensionStrokes(dimension: DimensionEntity, state: DrawingState, options: DimensionStrokeOptions): LoweredDimensionStrokes {
  try {
    const sourceLookup = options.lookup, textGeometry = sourceLookup?.textGeometry, metricKey = textGeometry?.cacheKey;
    const lookup = sourceLookup && Object.assign((name: string) => sourceLookup(name), { textGeometry });
    const maxParts = options.maxParts ?? 256;
    const maxPoints = options.maxPoints ?? 4096;
    const maxTextCharacters = options.maxTextCharacters ?? 16_384;
    if (![maxParts, maxPoints, maxTextCharacters].every((value) => Number.isSafeInteger(value) && value >= 0)) throw sourceTopologyAdmissionError('Invalid dimension geometry budget');
    finitePoint(options.anchor);
    if (!Number.isFinite(options.widthCss) || options.widthCss <= 0) throw sourceTopologyAdmissionError('Invalid dimension lineweight');
    const baseAlpha = options.alpha ?? 1;
    if (!Number.isFinite(baseAlpha) || baseAlpha < 0 || baseAlpha > 1) throw sourceTopologyAdmissionError('Invalid dimension overlay alpha');
    let preparationWork: number | undefined;
    if (options.nativeView) {
      if (!state.entities.includes(dimension)) throw sourceTopologyAdmissionError('Unsupported Canvas stroke construction: dimension block descendants require Canvas');
      if (!isImmutableData(dimension)) throw sourceTopologyAdmissionError('Unsupported Canvas stroke construction: dimension mutable source requires Canvas');
      if (options.anchor.x !== options.nativeView.center.x || options.anchor.y !== options.nativeView.center.y) {
        throw sourceTopologyAdmissionError('Native dimension anchor must be the current camera center');
      }
      const preparation = preflightDimensionPreparation(
        dimension, options.maxWork ?? DIMENSION_PREPARATION_MAX_WORK, maxPoints, maxParts,
      );
      if (preparation.inputCharacters > maxTextCharacters || preparation.outputCharacters > maxTextCharacters) {
        throw sourceTopologyAdmissionError('Dimension text exceeds character budget');
      }
      preparationWork = preparation.work;
    }
    if (dimension.annotative) throw sourceTopologyAdmissionError('Unsupported annotative dimension');
    if (options.dashed) throw sourceTopologyAdmissionError('Dashed dimension selection requires Canvas rendering');
    const layer = state.layers.find((entry) => entry.name === dimension.layer);
    const linetype = effectiveLinetype(dimension.linetype, layer?.linetype);
    if (findLinetype(linetype, state.header?.linetypes)?.pattern.length) throw sourceTopologyAdmissionError(`Unsupported dashed dimension linetype: ${linetype}`);
    if (resolveAlpha(dimension, state.layers) !== 1) throw sourceTopologyAdmissionError('Unsupported dimension transparency');
    if (!['linear', 'aligned', 'radius', 'diameter', 'angular'].includes(dimension.kind)) throw sourceTopologyAdmissionError('Unsupported dimension kind');
    if (dimension.kind === 'angular' && !dimension.center) throw sourceTopologyAdmissionError('Angular dimension is missing its center');
    for (const value of [dimension.rotation, dimension.textRotation ?? 0, dimension.oblique ?? 0, ...Object.values(dimension.style).filter((item): item is number => typeof item === 'number')]) {
      if (!Number.isFinite(value)) throw sourceTopologyAdmissionError('Nonfinite dimension style or rotation');
    }
    // Bound large text overrides and prefixes before the core layout allocates formatted parts.
    const inputCharacters = (dimension.text?.length ?? 0) + (dimension.style.post?.length ?? 0) + (dimension.style.altPost?.length ?? 0);
    if (inputCharacters > maxTextCharacters) throw sourceTopologyAdmissionError('Dimension text exceeds character budget');
    const styles = textStylesOf(state);
    const appearance = textGeometry?.resolve({ style: dimension.style.textStyle }) ?? textRenderer(dimension.style.textStyle, styles);
    if (appearance.kind !== 'stroke') throw sourceTopologyAdmissionError('Unsupported dimension Canvas font');
    if (appearance.shxResourceId !== undefined) throw sourceTopologyAdmissionError('Loaded SHX dimension text requires Canvas rendering');
    let worldTextRotation: number | undefined;
    if (options.nativeView && dimension.kind === 'aligned' && dimension.textRotation === undefined && resolveDimStyle(dimension.style).textAlign === 'aligned') {
      // Translation cannot rotate Canvas's text frame. Recomputing aligned feet after
      // subtraction can change atan2's last bit, especially after native DXF reopen.
      // The certificate reuses these cached WORLD parts, then independently checks
      // their fresh layout; WORLD, local and fresh remain the same three layout passes.
      const worldParts = dimensionParts(dimension, textGeometry);
      if (worldParts.length > maxParts || worldParts.length > DIMENSION_PART_BOUND) throw sourceTopologyAdmissionError('Dimension exceeds part budget');
      worldTextRotation = worldParts.find((part): part is TextEntity => part.type === 'text')?.rotation;
    }
    const local = (point: Point): Point => finitePoint({ x: point.x - options.anchor.x, y: point.y - options.anchor.y });
    const rebased: DimensionEntity = {
      ...dimension, p1: local(dimension.p1), p2: local(dimension.p2), linePoint: local(dimension.linePoint),
      ...(dimension.center ? { center: local(dimension.center) } : {}),
      ...(dimension.textPosition ? { textPosition: local(dimension.textPosition) } : {}),
      ...(worldTextRotation !== undefined ? { textRotation: worldTextRotation } : {}),
    };
    const sources = dimensionParts(rebased, textGeometry);
    if (sources.length > maxParts || (options.nativeView && sources.length > DIMENSION_PART_BOUND)) throw sourceTopologyAdmissionError('Dimension exceeds part budget');
    const ownColor = displayColor(options.strokeOverride ?? options.ownColorCss ?? resolveColor(dimension, state.layers));
    const parts: DimensionStrokePart[] = [];
    let pointCount = 0, textCharacterCount = 0;
    const countPoints = (amount: number): void => {
      pointCount += amount;
      if (pointCount > maxPoints) throw sourceTopologyAdmissionError('Dimension exceeds point budget');
    };
    for (const source of sources) {
      const sourceAlpha = resolveAlpha(source, state.layers);
      if (sourceAlpha !== 1) throw sourceTopologyAdmissionError('Unsupported dimension part transparency');
      const colorCss = displayColor(options.strokeOverride !== undefined || source.color === dimension.color ? ownColor : resolveColor(source, state.layers));
      const paint = { colorCss, alpha: baseAlpha * sourceAlpha, widthCss: options.widthCss };
      switch (source.type) {
        case 'line':
          finitePoint(source.a); finitePoint(source.b); countPoints(2);
          parts.push({ ...paint, kind: 'stroke', source });
          break;
        case 'polyline': {
          const problem = polylineWidthProblem(source);
          if (problem) throw sourceTopologyAdmissionError(problem);
          if (source.widthFrame || (source.width ?? 0) !== 0 || source.widths?.some((width) => width.start !== 0 || width.end !== 0)) throw sourceTopologyAdmissionError('Unsupported dimension polyline world width');
          source.points.forEach(finitePoint); countPoints(source.points.length);
          if (source.filled) {
            if (!source.closed || source.points.length !== 3 || source.bulges?.some((value) => value !== 0)) throw sourceTopologyAdmissionError('Unsupported dimension polygon fill');
            parts.push({ ...paint, kind: 'fillTriangle', source, points: [source.points[0]!, source.points[1]!, source.points[2]!] });
          } else parts.push({ ...paint, kind: 'stroke', source });
          break;
        }
        case 'arc':
        case 'circle':
          finitePoint(source.center); countPoints(1);
          if (!Number.isFinite(source.radius) || source.radius < 0 || (source.type === 'arc' && ![source.startAngle, source.endAngle].every(Number.isFinite))) throw sourceTopologyAdmissionError('Invalid dimension curve geometry');
          if (source.type === 'circle' && source.filled) throw sourceTopologyAdmissionError('Unsupported filled dimension circle');
          parts.push({ ...paint, kind: 'stroke', source });
          break;
        case 'text': {
          finitePoint(source.position); countPoints(1);
          const problem = textPlacementProblem(source);
          if (problem) throw sourceTopologyAdmissionError(problem);
          if (![source.height, source.rotation, source.widthFactor ?? 1, source.oblique ?? 0].every(Number.isFinite) || source.height <= 0) throw sourceTopologyAdmissionError('Invalid dimension TEXT geometry');
          const font = textGeometry?.resolve(source) ?? textRenderer(textStyleOf(source), styles);
          if (source.bold || !hasStrokeFont || font.kind !== 'stroke') throw sourceTopologyAdmissionError('Unsupported dimension Canvas font or bold text');
          if (font.shxResourceId !== undefined) throw sourceTopologyAdmissionError('Loaded SHX dimension text requires Canvas rendering');
          textCharacterCount += source.text.length;
          if (textCharacterCount > maxTextCharacters) throw sourceTopologyAdmissionError('Dimension text exceeds character budget');
          parts.push({ ...paint, kind: 'text', source });
          break;
        }
        default: throw sourceTopologyAdmissionError(`Unsupported dimension part: ${source.type}`);
      }
    }
    let nativeSourceCertificate: NativeDimensionSourceCertificate | undefined;
    if (options.nativeView) {
      if (options.anchor.x !== options.nativeView.center.x || options.anchor.y !== options.nativeView.center.y) throw sourceTopologyAdmissionError('Native dimension anchor must be the current camera center');
      nativeSourceCertificate = certifyDimensionNativeSource(dimension, sources, state, { lookup, view: options.nativeView, widthCss: options.widthCss, minRatio: options.minRatio ?? 0.8, maxRatio: options.maxRatio ?? 1.25, maxPoints: maxPoints - pointCount, maxParts, maxWork: preparationWork });
      pointCount += nativeSourceCertificate.pointCharge;
    }
    if (textGeometry?.cacheKey !== metricKey) throw sourceTopologyAdmissionError('Text geometry context changed during dimension preparation');
    return { ok: true, parts, ...(nativeSourceCertificate ? { nativeSourceCertificate, preparationWork } : {}), dimensionStyleDependency: dimension.style, textStylesDependency: state.meta?.[TEXT_STYLES_META_KEY], ...(textGeometry ? { textGeometryDependency: textGeometry, metricKeyDependency: metricKey } : {}), pointCount, textCharacterCount };
  } catch (error) {
    const failure = { ok: false as const, reason: error instanceof Error ? error.message : 'Dimension lowering failed' };
    Object.defineProperty(failure, 'cause', { value: error });
    return failure;
  }
}
