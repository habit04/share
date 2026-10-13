import type { DrawingState } from '../../core/document';
import type { DimensionEntity, DimStyle } from '../../core/dimension';
import type { ArcEntity, CircleEntity, LineEntity, PolylineEntity, TextEntity } from '../../core/entities';
import { dimensionParts } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { textPlacementProblem } from '../../core/text-placement';
import { TEXT_STYLES_META_KEY, textStyleOf, textStylesOf } from '../../io/encoding';
import { resolveColor } from '../draw';
import { hasStrokeFont, textRenderer } from '../hershey';

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
}

export type LoweredDimensionStrokes =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true;
    /** One operation per existing Canvas part, in exactly the source painter's order. */
    readonly parts: readonly DimensionStrokePart[];
    readonly dimensionStyleDependency: DimStyle;
    /** Use the raw document identity, rather than textStylesOf's fresh absent-style default. */
    readonly textStylesDependency: unknown;
    readonly pointCount: number;
    readonly textCharacterCount: number;
  };

function finitePoint(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Nonfinite dimension coordinate');
  return point;
}

function displayColor(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Unsupported dimension display color');
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
    const maxParts = options.maxParts ?? 256;
    const maxPoints = options.maxPoints ?? 4096;
    const maxTextCharacters = options.maxTextCharacters ?? 16_384;
    if (![maxParts, maxPoints, maxTextCharacters].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid dimension geometry budget');
    finitePoint(options.anchor);
    if (!Number.isFinite(options.widthCss) || options.widthCss <= 0) throw new Error('Invalid dimension lineweight');
    const baseAlpha = options.alpha ?? 1;
    if (!Number.isFinite(baseAlpha) || baseAlpha < 0 || baseAlpha > 1) throw new Error('Invalid dimension overlay alpha');
    if (dimension.annotative) throw new Error('Unsupported annotative dimension');
    if (options.dashed) throw new Error('Dashed dimension selection requires Canvas rendering');
    const layer = state.layers.find((entry) => entry.name === dimension.layer);
    const linetype = effectiveLinetype(dimension.linetype, layer?.linetype);
    if (findLinetype(linetype, state.header?.linetypes)?.pattern.length) throw new Error(`Unsupported dashed dimension linetype: ${linetype}`);
    if (resolveAlpha(dimension, state.layers) !== 1) throw new Error('Unsupported dimension transparency');
    if (!['linear', 'aligned', 'radius', 'diameter', 'angular'].includes(dimension.kind)) throw new Error('Unsupported dimension kind');
    if (dimension.kind === 'angular' && !dimension.center) throw new Error('Angular dimension is missing its center');
    for (const value of [dimension.rotation, dimension.textRotation ?? 0, dimension.oblique ?? 0, ...Object.values(dimension.style).filter((item): item is number => typeof item === 'number')]) {
      if (!Number.isFinite(value)) throw new Error('Nonfinite dimension style or rotation');
    }
    // Bound large text overrides and prefixes before the core layout allocates formatted parts.
    const inputCharacters = (dimension.text?.length ?? 0) + (dimension.style.post?.length ?? 0) + (dimension.style.altPost?.length ?? 0);
    if (inputCharacters > maxTextCharacters) throw new Error('Dimension text exceeds character budget');
    const local = (point: Point): Point => finitePoint({ x: point.x - options.anchor.x, y: point.y - options.anchor.y });
    const rebased: DimensionEntity = {
      ...dimension, p1: local(dimension.p1), p2: local(dimension.p2), linePoint: local(dimension.linePoint),
      ...(dimension.center ? { center: local(dimension.center) } : {}),
      ...(dimension.textPosition ? { textPosition: local(dimension.textPosition) } : {}),
    };
    const sources = dimensionParts(rebased);
    if (sources.length > maxParts) throw new Error('Dimension exceeds part budget');
    const ownColor = displayColor(options.strokeOverride ?? options.ownColorCss ?? resolveColor(dimension, state.layers));
    const styles = textStylesOf(state);
    const parts: DimensionStrokePart[] = [];
    let pointCount = 0, textCharacterCount = 0;
    const countPoints = (amount: number): void => {
      pointCount += amount;
      if (pointCount > maxPoints) throw new Error('Dimension exceeds point budget');
    };
    for (const source of sources) {
      const sourceAlpha = resolveAlpha(source, state.layers);
      if (sourceAlpha !== 1) throw new Error('Unsupported dimension part transparency');
      const colorCss = displayColor(options.strokeOverride !== undefined || source.color === dimension.color ? ownColor : resolveColor(source, state.layers));
      const paint = { colorCss, alpha: baseAlpha * sourceAlpha, widthCss: options.widthCss };
      switch (source.type) {
        case 'line':
          finitePoint(source.a); finitePoint(source.b); countPoints(2);
          parts.push({ ...paint, kind: 'stroke', source });
          break;
        case 'polyline': {
          const problem = polylineWidthProblem(source);
          if (problem) throw new Error(problem);
          if (source.widthFrame || (source.width ?? 0) !== 0 || source.widths?.some((width) => width.start !== 0 || width.end !== 0)) throw new Error('Unsupported dimension polyline world width');
          source.points.forEach(finitePoint); countPoints(source.points.length);
          if (source.filled) {
            if (!source.closed || source.points.length !== 3 || source.bulges?.some((value) => value !== 0)) throw new Error('Unsupported dimension polygon fill');
            parts.push({ ...paint, kind: 'fillTriangle', source, points: [source.points[0]!, source.points[1]!, source.points[2]!] });
          } else parts.push({ ...paint, kind: 'stroke', source });
          break;
        }
        case 'arc':
        case 'circle':
          finitePoint(source.center); countPoints(1);
          if (!Number.isFinite(source.radius) || source.radius < 0 || (source.type === 'arc' && ![source.startAngle, source.endAngle].every(Number.isFinite))) throw new Error('Invalid dimension curve geometry');
          if (source.type === 'circle' && source.filled) throw new Error('Unsupported filled dimension circle');
          parts.push({ ...paint, kind: 'stroke', source });
          break;
        case 'text': {
          finitePoint(source.position); countPoints(1);
          const problem = textPlacementProblem(source);
          if (problem) throw new Error(problem);
          if (![source.height, source.rotation, source.widthFactor ?? 1, source.oblique ?? 0].every(Number.isFinite) || source.height <= 0) throw new Error('Invalid dimension TEXT geometry');
          if (source.bold || !hasStrokeFont || textRenderer(textStyleOf(source), styles).kind !== 'stroke') throw new Error('Unsupported dimension Canvas font or bold text');
          textCharacterCount += source.text.length;
          if (textCharacterCount > maxTextCharacters) throw new Error('Dimension text exceeds character budget');
          parts.push({ ...paint, kind: 'text', source });
          break;
        }
        default: throw new Error(`Unsupported dimension part: ${source.type}`);
      }
    }
    return { ok: true, parts, dimensionStyleDependency: dimension.style, textStylesDependency: state.meta?.[TEXT_STYLES_META_KEY], pointCount, textCharacterCount };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Dimension lowering failed' };
  }
}
