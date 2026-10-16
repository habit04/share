import type { TextRenderer } from '../render/hershey';
import { placedText, type TextPlacement } from './text-placement';

/** Display-only font context; it never enters saved drawing data or undo history. */
export interface TextMetricStyle {
  /** Resolve glyph coverage for this run, including display-only Unicode substitutions. */
  readonly text?: string;
  readonly style?: string;
  readonly widthFactor?: number;
  readonly oblique?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
}
export type TextAppearance = TextRenderer;
export const textFontKey = (face: Extract<TextAppearance, { kind: 'canvas' }>): string => JSON.stringify([face.family, face.bold, face.italic]);

/** Conservative direct-glyph subset; other scripts retain whole-run Canvas shaping. */
export function supportsNativeTextRun(text: string): boolean {
  if (/\p{Mark}|[\u200c-\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) return false;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x058f || code >= 0x1d00 && code <= 0x2dff || code >= 0x2e80 && code <= 0xa4cf
      || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
      || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffee
      || code >= 0x1d400 && code <= 0x1d7ff || code >= 0x20000 && code <= 0x3134f) continue;
    return false;
  }
  return true;
}
export interface TextMetricResult {
  readonly advance: number;
  /** Signed ink limits relative to the baseline start, before width/shear transforms. */
  readonly left: number;
  readonly right: number;
  readonly ascent: number;
  readonly descent: number;
}
export interface TextGeometryContext {
  /** Changes on STYLE or font availability changes, even when entities are identical. */
  readonly cacheKey: object;
  resolve(input: TextMetricStyle): TextAppearance;
  measure(text: string, height: number, appearance: TextAppearance): TextMetricResult;
  /** CSS em size matching the same native drawing-height normalization. */
  fontSize?(height: number, appearance: TextAppearance): number;
  /** Unshaped native glyph advances; null keeps complex/fallback runs on Canvas shaping. */
  advances?(text: string, height: number, appearance: TextAppearance): readonly number[] | null;
  baselineDescent?(height: number, appearance: TextAppearance): number;
  /** Runtime SHX geometry, outside drawing/export data; null retains the existing substitute. */
  shxRun?(text: string, height: number, appearance: TextAppearance): import('../render/shx-fonts').ShxTextRun | null;
  /** Problems encountered by display-only resource geometry, used by captured plots. */
  readonly fontIssues?: ReadonlySet<string>;
}

/** Native TrueType fitting uses the right ink overhang; centering also includes left bearings. */
export function metricTextPlacement<T extends TextPlacement & TextMetricStyle & { readonly text: string }>(source: T, context: TextGeometryContext) {
  const appearance = context.resolve(source);
  const strokeRun = appearance.kind === 'stroke' && appearance.shxResourceId ? context.shxRun?.(source.text, source.height, appearance) : null;
  const nativeStroke = strokeRun?.ok === true;
  const terminalSpace = strokeRun?.ok === true && strokeRun.terminalSpace;
  const text = placedText({ ...source, widthFactor: source.widthFactor ?? appearance.widthFactor, oblique: source.oblique ?? appearance.oblique }, (value, height) => {
    const metric = context.measure(value, height, appearance);
    return nativeStroke ? terminalSpace ? metric.advance : metric.right || metric.advance : Math.max(metric.advance, metric.right);
  });
  const metrics = context.measure(text.text, text.height, appearance);
  const justification = source.justification;
  const raise = justification?.horizontal === 4 ? text.height / 2 - (metrics.ascent - metrics.descent) / 2
    : justification?.vertical === 1 ? context.baselineDescent?.(text.height, appearance) ?? 0 : 0;
  const placed = raise ? { ...text, position: { x: text.position.x - Math.sin(text.rotation) * raise, y: text.position.y + Math.cos(text.rotation) * raise } } : text;
  const right = nativeStroke ? terminalSpace ? metrics.advance : metrics.right || metrics.advance : Math.max(metrics.advance, metrics.right);
  const left = nativeStroke ? terminalSpace ? 0 : metrics.left : Math.min(0, metrics.left);
  const offset = text.align === 'center' ? -(left + right) / 2 : text.align === 'right' ? -right : 0;
  return { text: placed, appearance, metrics, offset };
}

/** Only metrics cross the app bridge; installed font bytes are never redistributed. */
export interface NativeFontMetrics {
  readonly family: string;
  readonly subfamily: string;
  readonly unitsPerEm: number;
  readonly capitalHeight: number;
  readonly fontBounds: readonly [number, number, number, number];
  readonly advances: readonly number[];
  readonly glyphBounds: readonly (readonly [number, number, number, number])[];
  /** False keeps unverified composite origins on actual Canvas shaping/measurement. */
  readonly glyphBoundsKnown?: readonly boolean[];
  readonly cmap: readonly number[];
  readonly groups: readonly (readonly [number, number, number])[];
  readonly fsType: number;
  /** OS/2 usWinDescent, used by native TEXT bottom justification. */
  readonly winDescent?: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Variable font admitted only at a verified default instance. */
  readonly variable?: boolean;
  /** Index of the selected face within a TrueType collection file; 0 for standalone fonts. */
  readonly faceIndex?: number;
  readonly filename?: string;
  readonly resolvedFilename?: string;
}
export interface FontMetricsRequest {
  readonly font: string;
  readonly family?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Captured-PDF reads only: codepoints of the plotted strings for this face,
   * so the reader point-validates just those glyphs. Screen reads omit it. */
  readonly usedCodepoints?: readonly number[];
  /** This captured PDF opted into editing restrictions; never a persisted drawing setting. */
  readonly restricted?: boolean;
}
