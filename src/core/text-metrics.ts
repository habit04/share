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
  /**
   * Engine shaping (12.5 switch-over): async preparation for a
   * text under an appearance. Optional: contexts without an
   * attached session never shape, and consumers treat every
   * shaped item as unprepared (reported fallback, never silent).
   */
  prepareShaping?(text: string, appearance: TextAppearance): Promise<void>;
  /**
   * Synchronous, total per-item shaping state for the item at
   * [itemStart, itemEnd) of a text: ready (with per-subitem runs),
   * pending, missing, refused (with its recorded problem), or
   * direct for gate-admitted items.
   */
  shaped?(text: string, appearance: TextAppearance, itemStart: number, itemEnd: number): ShapedItemState;
  /**
   * The full glyph placements of a ready shaped item, per
   * subitem, with each subitem's program identity — the PDF
   * writer's seam (step 3). Same totality as shaped().
   */
  shapedGlyphs?(text: string, appearance: TextAppearance, itemStart: number, itemEnd: number): ShapedGlyphState;
}

/** One post-shaping glyph placement (font units, item-relative
    cluster range in UTF-16 units). */
export interface ShapedGlyphPlacement {
  readonly glyph: number;
  readonly clusterStart: number;
  readonly clusterEnd: number;
  readonly xAdvance: number;
  readonly yAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

/** A ready item's full glyph data, per coverage subitem. */
export type ShapedGlyphState =
  | { readonly state: 'ready'; readonly subitems: readonly { readonly start: number; readonly end: number; readonly programSha256: string; readonly glyphs: readonly ShapedGlyphPlacement[] }[] }
  | { readonly state: 'pending' }
  | { readonly state: 'missing' }
  | { readonly state: 'refused'; readonly problem: string }
  | { readonly state: 'direct'; readonly reason: 'admitted-native' };

/** One host shape production request: a font descriptor the host
    validates (never a renderer-supplied path or buffer) plus the
    shape block for one item of one context. */
export interface ShapeBridgeRequest {
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly shape: {
    readonly text: string;
    readonly itemStart: number;
    readonly itemEnd: number;
    readonly script: string;
    readonly direction: 'ltr' | 'rtl';
    readonly features: readonly string[];
  };
}

/** The bound face's metrics run assembly needs (the same facts
    the geometry registries already validate: cmap advances as the
    glyph-count source, glyph bounds + known flags, units per em). */
export interface AssemblyFaceMetrics {
  readonly advances: readonly number[];
  readonly glyphBounds: readonly (readonly [number, number, number, number])[];
  readonly glyphBoundsKnown?: readonly boolean[];
  readonly unitsPerEm: number;
}

export type ShapeBridgeResult =
  | { readonly shaped: ShapeProductionData }
  | { readonly shaped: null; readonly problem: string };

/** The plain production data the host's shape mode returns: glyphs
    with item-relative cluster ranges, face facts, and the
    worker-computed identity of the exact program shaped. */
export interface ShapeProductionData {
  readonly glyphs: readonly {
    readonly glyph: number;
    readonly clusterStart: number;
    readonly clusterEnd: number;
    readonly xAdvance: number;
    readonly yAdvance: number;
    readonly xOffset: number;
    readonly yOffset: number;
  }[];
  readonly unitsPerEm: number;
  readonly faceGlyphCount: number;
  readonly programSha256: string;
  readonly programBytes: number;
}

/** Injected host contact (window.jcad.shapeFont in the app).
    Returning null means the bridge is unavailable (non-Windows,
    host down) — a reported `missing` outcome, not a crash. */
export type ShapeBridge = (request: ShapeBridgeRequest) => Promise<ShapeBridgeResult | null>;

/** One face a shaping session may shape with, in fallback order. */
export interface ShapeFaceCandidate {
  readonly descriptor: Readonly<Record<string, unknown>>;
  /** Selected face in its source (the key's faceIndex). */
  readonly faceIndex: number;
  /** cmap: code point -> glyph id (0 / absent = uncovered). */
  readonly cmap: readonly number[];
  readonly metrics: AssemblyFaceMetrics;
  /** The face's capital height in font units: measurement scales
      this candidate's runs by it. */
  readonly capitalHeight: number;
  /** Program byte length when the source knows it (the PDF read
      does; screen metrics do not) — sharpens the ledger charge. */
  readonly programBytes?: number;
}

/** Builds the hooks for one geometry context: the caller's epoch
    token source plus its face-candidate source. App bootstrap
    supplies the factory; contexts without one never shape. */
export type ShapingHooksFactory = (init: {
  readonly contextId: () => unknown;
  readonly candidatesFor: (appearance: TextAppearance) => readonly ShapeFaceCandidate[];
}) => TextShapingHooks | null;

/** The hooks a geometry context uses to reach a shaping session. */
export interface TextShapingHooks {
  prepare(text: string, appearance: TextAppearance): Promise<void>;
  shaped(text: string, appearance: TextAppearance, itemStart: number, itemEnd: number): ShapedItemState;
  shapedGlyphs(text: string, appearance: TextAppearance, itemStart: number, itemEnd: number): ShapedGlyphState;
}

/**
 * The geometry-level shaping state for one item: the session's
 * per-key states aggregated over the item's coverage subitems.
 * `ready` carries each subitem's validated run and the capital
 * height (font units) of the face that produced it, so measurement
 * scales each subitem by its own face.
 */
/** The placement facts geometry consumes from a shaped run: the
    total advance and the signed ink bounds, in font units. The
    full run (glyphs, binding) stays with the shaping session and
    the PDF writer; the geometry context needs only this. */
export interface ShapedRunPlacement {
  readonly advanceX: number;
  readonly ink: { readonly xMin: number; readonly yMin: number; readonly xMax: number; readonly yMax: number };
}

export type ShapedItemState =
  | { readonly state: 'ready'; readonly subitems: readonly { readonly start: number; readonly end: number; readonly run: ShapedRunPlacement; readonly capitalHeight: number }[] }
  | { readonly state: 'pending' }
  | { readonly state: 'missing' }
  | { readonly state: 'refused'; readonly problem: string }
  | { readonly state: 'direct'; readonly reason: 'admitted-native' };

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
