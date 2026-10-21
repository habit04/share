import { expandControlCodes, strokeTextWidth, textRenderer, unicodeStrokeFallback, UNICODE_FALLBACK_FONT, UNICODE_STROKE_FALLBACK_NOTICE, type TextRenderer } from './hershey';
import { itemizeParagraph } from '../core/text-pipeline';
import { findTextStyle, isTrueTypeStyle, fontWeight } from './hershey';
import type { TextStyle } from '../io/encoding';
import type { FontMetricsRequest, NativeFontMetrics, ShapeFaceCandidate, ShapedItemState, TextAppearance, TextGeometryContext, TextMetricResult, TextMetricStyle, TextShapingHooks } from '../core/text-metrics';
import { supportsNativeTextRun } from '../core/text-metrics';

type Styles = Readonly<Record<string, TextStyle>>;
type CanvasFace = Extract<TextRenderer, { kind: 'canvas' }>;
export type FontMetricsReader = (request: FontMetricsRequest) => Promise<NativeFontMetrics | null>;
const MAX_FACES = 32;
const PROBE_SIZE = 256;
const plainText = (text: string): string => expandControlCodes(text.replace(/%%[uUoOkK]/g, ''));
const faceKey = (face: CanvasFace): string => JSON.stringify([face.family, face.bold, face.italic]);
const familyName = (family: string): string => family.split(',')[0]!.trim().replace(/^"|"$/g, '');
const fontSpec = (face: CanvasFace, size: number): string => `${face.italic ? 'italic ' : ''}${face.bold ? 'bold ' : ''}${Number(size.toFixed(6))}px ${face.family}`;
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false;
  return true;
}

function glyphIndex(font: NativeFontMetrics, code: number): number {
  if (code <= 0xffff && font.cmap[code]) return font.cmap[code]!;
  let lo = 0, hi = font.groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, group = font.groups[mid]!;
    if (code < group[0]) hi = mid - 1;
    else if (code > group[1]) lo = mid + 1;
    else return group[2] + code - group[0];
  }
  return 0;
}

function nativeGlyphs(font: NativeFontMetrics, text: string): number[] | null {
  // Keep contextual scripts, combining marks and bidi controls on the actual Canvas shaper.
  if (!supportsNativeTextRun(text)) return null;
  const glyphs = Array.from(text, (character) => glyphIndex(font, character.codePointAt(0)!));
  return glyphs.every((index) => index > 0 && font.glyphBoundsKnown?.[index] !== false) ? glyphs : null;
}

/** Validate structured bridge results once, before they can affect geometry or caches. */
export function nativeFontMetricsProblem(font: NativeFontMetrics): string | null {
  if (!font || typeof font.family !== 'string' || !font.family || font.family.length > 256 || /[\u0000-\u001f]/.test(font.family)) return 'invalid font family';
  if (!Number.isInteger(font.unitsPerEm) || font.unitsPerEm < 16 || font.unitsPerEm > 16384 || !Number.isInteger(font.capitalHeight) || !(font.capitalHeight > 0) || font.capitalHeight > 32767) return 'invalid font height';
  if (typeof font.subfamily !== 'string' || font.subfamily.length > 256 || !Number.isInteger(font.fsType) || font.fsType < 0 || font.fsType > 65535) return 'invalid font metadata';
  if (font.winDescent !== undefined && (!Number.isInteger(font.winDescent) || font.winDescent < 0 || font.winDescent > 65535)) return 'invalid font descent';
  if (!denseArray(font.fontBounds) || font.fontBounds.length !== 4 || font.fontBounds.some((value) => !Number.isInteger(value) || value < -32768 || value > 32767) || font.fontBounds[0] > font.fontBounds[2] || font.fontBounds[1] > font.fontBounds[3]) return 'invalid font bounds';
  const count = font.advances?.length;
  if (!denseArray(font.advances) || !count || count > 65536 || !denseArray(font.glyphBounds) || font.glyphBounds.length !== count) return 'invalid font glyph count';
  if (font.advances.some((advance) => !Number.isInteger(advance) || advance < 0 || advance > 65535)) return 'invalid font advance';
  if (font.glyphBounds.some((box) => !denseArray(box) || box.length !== 4 || box.some((value) => !Number.isInteger(value) || value < -98303 || value > 98303) || box[0] > box[2] || box[1] > box[3])) return 'invalid font glyph bounds';
  if (font.glyphBoundsKnown !== undefined && (!denseArray(font.glyphBoundsKnown) || font.glyphBoundsKnown.length !== count || font.glyphBoundsKnown.some((known) => typeof known !== 'boolean'))) return 'invalid glyph origin flags';
  if (!denseArray(font.cmap) || font.cmap.length !== 65536 || font.cmap.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) return 'invalid font character map';
  const glyphA = font.cmap[0x41]!;
  if (!glyphA || font.glyphBoundsKnown?.[glyphA] === false || font.glyphBounds[glyphA]![3] !== font.capitalHeight) return 'invalid native capital A height';
  if (!denseArray(font.groups) || font.groups.length > 65536) return 'invalid Unicode font map';
  let end = -1;
  for (const group of font.groups) {
    if (!denseArray(group) || group.length !== 3 || group.some((value) => !Number.isInteger(value) || value < 0) || group[0] <= end || group[1] < group[0] || group[1] > 0x10ffff || group[2] + group[1] - group[0] >= count) return 'invalid Unicode font range';
    end = group[1];
  }
  if (typeof font.bold !== 'boolean' || typeof font.italic !== 'boolean') return 'invalid font face flags';
  return null;
}

/** Runtime font data is outside documents, backups and native export. */
export class FontMetricsRegistry {
  private fonts = new Map<string, NativeFontMetrics>();
  private pending = new Map<string, Promise<void>>();
  private tried = new Set<string>();
  private listeners = new Set<() => void>();
  private reader: FontMetricsReader | undefined;
  private shapingFactory: import('../core/text-metrics').ShapingHooksFactory | undefined;
  private probe: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  private ratios = new Map<string, number>();
  private epoch: object = {};
  private readerEpoch: object = {};
  get cacheKey(): object { return this.epoch; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { this.epoch = {}; for (const listener of this.listeners) listener(); }
  /**
   * Attach the shaping-session factory (app bootstrap, Windows
   * bridge only). Contexts created afterwards can prepare and
   * serve shaped measurement; without a factory, contexts behave
   * exactly as before and shaped items report as unprepared.
   */
  setShapingFactory(factory: FontMetricsRegistry['shapingFactory']): void {
    this.shapingFactory = factory;
  }
  /** Build shaping hooks for one context through the factory. */
  shapingHooksFor(init: Parameters<import('../core/text-metrics').ShapingHooksFactory>[0]): TextShapingHooks | null {
    return this.shapingFactory ? this.shapingFactory(init) : null;
  }
  /** The loaded font for an appearance, if the host supplied one. */
  loadedFont(appearance: TextAppearance): NativeFontMetrics | undefined {
    return appearance.kind === 'canvas' ? this.fonts.get(faceKey(appearance)) : undefined;
  }
  /** Shaping candidates from this registry's loaded fonts: the
      appearance's own face (the metrics path's selected face). */
  shapeCandidates(appearance: TextAppearance): readonly ShapeFaceCandidate[] {
    const font = this.loadedFont(appearance);
    if (!font) return [];
    return [{
      descriptor: { family: font.family, subfamily: font.subfamily, bold: font.bold, italic: font.italic },
      faceIndex: 0,
      cmap: font.cmap,
      metrics: {
        advances: font.advances,
        glyphBounds: font.glyphBounds,
        ...(font.glyphBoundsKnown ? { glyphBoundsKnown: font.glyphBoundsKnown } : {}),
        unitsPerEm: font.unitsPerEm,
      },
      capitalHeight: font.capitalHeight,
    }];
  }
  setReader(reader: FontMetricsReader | undefined): void {
    if (this.reader === reader) return;
    this.reader = reader; this.readerEpoch = {}; this.tried.clear(); this.fonts.clear(); this.changed();
  }
  register(face: CanvasFace, font: NativeFontMetrics): void {
    const problem = nativeFontMetricsProblem(font);
    if (problem) throw new Error(problem);
    if (font.family.toLowerCase() !== familyName(face.family).toLowerCase() || font.bold !== face.bold || font.italic !== face.italic) throw new Error('The installed font does not match the rendered face.');
    const key = faceKey(face);
    if (!this.fonts.has(key) && this.fonts.size >= MAX_FACES) throw new Error('Font metric cache limit reached.');
    // Caller-owned bridge results must not mutate geometry behind a cache key.
    const retained: NativeFontMetrics = Object.freeze({ family: font.family, subfamily: font.subfamily,
      unitsPerEm: font.unitsPerEm, capitalHeight: font.capitalHeight, fsType: font.fsType,
      bold: font.bold, italic: font.italic, winDescent: font.winDescent,
      fontBounds: Object.freeze([...font.fontBounds]) as NativeFontMetrics['fontBounds'],
      advances: Object.freeze([...font.advances]), cmap: Object.freeze([...font.cmap]),
      glyphBounds: Object.freeze(font.glyphBounds.map((box) => Object.freeze([...box]) as NativeFontMetrics['fontBounds'])),
      ...(font.glyphBoundsKnown ? { glyphBoundsKnown: Object.freeze([...font.glyphBoundsKnown]) } : {}),
      groups: Object.freeze(font.groups.map((group) => Object.freeze([...group]) as NativeFontMetrics['groups'][number])),
    });
    this.fonts.set(key, retained); this.changed();
  }
  request(face: CanvasFace, font: string): void {
    const key = faceKey(face);
    if (!this.reader || this.fonts.has(key) || this.pending.has(key) || this.tried.has(key) || this.tried.size >= MAX_FACES) return;
    this.tried.add(key);
    const readerEpoch = this.readerEpoch;
    const promise = this.reader({ font: font.replace(/^.*[\\/]/, ''), family: familyName(face.family), bold: face.bold, italic: face.italic }).then((metrics) => {
      if (metrics && readerEpoch === this.readerEpoch) this.register(face, metrics);
    }).catch(() => { /* Missing/unsupported faces retain the Canvas fallback and source data. */ }).finally(() => {
      this.pending.delete(key);
      if (readerEpoch !== this.readerEpoch) this.changed();
    });
    this.pending.set(key, promise);
  }
  async ready(): Promise<void> { await Promise.all(this.pending.values()); }
  invalidateFallbacks(): void { this.ratios.clear(); this.changed(); }
  private canvas(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    if (this.probe !== undefined) return this.probe;
    try {
      this.probe = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d')
        : typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch { this.probe = null; }
    return this.probe;
  }
  private heightRatio(face: CanvasFace): number {
    const font = this.fonts.get(faceKey(face));
    if (font) return font.capitalHeight / font.unitsPerEm;
    const key = faceKey(face), cached = this.ratios.get(key);
    if (cached) return cached;
    const ctx = this.canvas();
    if (!ctx) return 0.716;
    ctx.font = fontSpec(face, PROBE_SIZE); ctx.fontKerning = 'none';
    const ascent = ctx.measureText('A').actualBoundingBoxAscent;
    const ratio = Number.isFinite(ascent) && ascent > 0 ? ascent / PROBE_SIZE : 0.716;
    this.ratios.set(key, ratio);
    return ratio;
  }
  fontSize(height: number, face: CanvasFace): number { return height / this.heightRatio(face); }
  baselineDescent(height: number, appearance: TextAppearance): number {
    if (appearance.kind === 'stroke') return 0;
    const font = this.fonts.get(faceKey(appearance));
    if (font?.winDescent !== undefined) return font.winDescent * height / font.capitalHeight;
    const ctx = this.canvas();
    if (!ctx) return 0;
    ctx.font = fontSpec(appearance, PROBE_SIZE); ctx.fontKerning = 'none';
    const descent = ctx.measureText('Ag').fontBoundingBoxDescent;
    return Number.isFinite(descent) ? descent * height / (PROBE_SIZE * this.heightRatio(appearance)) : 0;
  }
  advances(text: string, height: number, appearance: TextAppearance): readonly number[] | null {
    if (appearance.kind !== 'canvas') return null;
    const font = this.fonts.get(faceKey(appearance));
    if (!font) return null;
    const glyphs = nativeGlyphs(font, plainText(text));
    return glyphs?.map((index) => font.advances[index]! * height / font.capitalHeight) ?? null;
  }
  measure(text: string, height: number, appearance: TextAppearance): TextMetricResult {
    text = plainText(text);
    appearance = unicodeStrokeFallback(text, appearance);
    if (appearance.kind === 'stroke') {
      const advance = strokeTextWidth(text, height);
      return { advance, left: 0, right: advance, ascent: height, descent: 0 };
    }
    const font = this.fonts.get(faceKey(appearance));
    const glyphs = font ? nativeGlyphs(font, text) : null;
    if (font && glyphs) {
      const scale = height / font.capitalHeight;
      let advance = 0, left = Infinity, right = -Infinity, ascent = -Infinity, descent = -Infinity;
      for (const index of glyphs) {
        const box = font.glyphBounds[index]!;
        if (box[0] !== box[2] || box[1] !== box[3]) {
          left = Math.min(left, advance + box[0]); right = Math.max(right, advance + box[2]);
          ascent = Math.max(ascent, box[3]); descent = Math.max(descent, -box[1]);
        }
        advance += font.advances[index]!;
      }
      return { advance: advance * scale, left: left === Infinity ? 0 : left * scale, right: right === -Infinity ? 0 : right * scale, ascent: ascent === -Infinity ? 0 : ascent * scale, descent: descent === -Infinity ? 0 : descent * scale };
    }
    const ctx = this.canvas();
    if (ctx) {
      ctx.font = fontSpec(appearance, PROBE_SIZE); ctx.fontKerning = 'none';
      const metric = ctx.measureText(text), scale = height / (PROBE_SIZE * this.heightRatio(appearance));
      if (Number.isFinite(metric.width)) return { advance: metric.width * scale, left: -metric.actualBoundingBoxLeft * scale, right: metric.actualBoundingBoxRight * scale, ascent: metric.actualBoundingBoxAscent * scale, descent: metric.actualBoundingBoxDescent * scale };
    }
    const advance = strokeTextWidth(text, height);
    return { advance, left: 0, right: advance, ascent: height, descent: 0 };
  }
}

export const fontMetrics = new FontMetricsRegistry();
const contexts = new WeakMap<Styles, TextGeometryContext>();
export const EMPTY_TEXT_STYLES: Styles = Object.freeze({});
export function createTextGeometryContext(styles: Styles, registry: FontMetricsRegistry = fontMetrics): TextGeometryContext {
  let epoch = registry.cacheKey, cacheKey: object = {};
  const issues = new Set<string>();
  let hooks: TextShapingHooks | null | undefined;
  const context: TextGeometryContext = {
    get cacheKey() { if (epoch !== registry.cacheKey) { epoch = registry.cacheKey; cacheKey = {}; } return cacheKey; },
    resolve(input: TextMetricStyle): TextAppearance {
      const base = textRenderer(input.style, styles, input.text);
      const face = { ...base, ...(input.widthFactor !== undefined ? { widthFactor: input.widthFactor } : {}), ...(input.oblique !== undefined ? { oblique: input.oblique } : {}),
        ...(base.kind === 'canvas' && input.bold ? { bold: true } : {}), ...(base.kind === 'canvas' && input.italic ? { italic: true } : {}) };
      if (face.kind === 'canvas') {
        if (face.strokeFallback) issues.add(UNICODE_STROKE_FALLBACK_NOTICE);
        registry.request(face, face.strokeFallback ? UNICODE_FALLBACK_FONT : findTextStyle(input.style, styles)?.font ?? '');
      }
      return face;
    },
    measure: (text, height, appearance) => {
      const active = shapingHooks();
      if (active && appearance.kind === 'canvas') {
        const shaped = measureShaped(active, text, height, appearance, issues, (slice, h, face) => registry.measure(slice, h, face));
        if (shaped) return shaped;
      }
      return registry.measure(text, height, appearance);
    },
    fontSize: (height, appearance) => appearance.kind === 'canvas' ? registry.fontSize(height, appearance) : height,
    advances: (text, height, appearance) => {
      const active = shapingHooks();
      if (active && appearance.kind === 'canvas') {
        const itemized = itemizeParagraph(plainText(text));
        const shapedItems = itemized.items.filter((item) => item.route === 'shaped');
        if (shapedItems.length > 0) {
          let allReady = true;
          for (const item of shapedItems) {
            if (item.route !== 'shaped') continue;
            const state = active.shaped(plainText(text), appearance, item.derivation.itemStart, item.derivation.itemEnd);
            if (state.state !== 'ready') { allReady = false; noteShapingFallback(issues, state); }
          }
          // Ready shaped runs carry their own placement: per-char
          // cmap advances would contradict them, so the run goes
          // back as a whole (the draw layer's whole-run branch).
          if (allReady) return null;
        }
      }
      return registry.advances(text, height, appearance);
    },
    baselineDescent: (height, appearance) => registry.baselineDescent(height, appearance),
    prepareShaping: async (text, appearance) => {
      const active = shapingHooks();
      if (active) await active.prepare(plainText(text), appearance);
    },
    shaped: (text, appearance, itemStart, itemEnd) => {
      const active = shapingHooks();
      if (!active) return { state: 'missing' };
      return active.shaped(plainText(text), appearance, itemStart, itemEnd);
    },
    shapedGlyphs: (text, appearance, itemStart, itemEnd) => {
      const active = shapingHooks();
      if (!active) return { state: 'missing' };
      return active.shapedGlyphs(plainText(text), appearance, itemStart, itemEnd);
    },
    fontIssues: issues,
  };
  function shapingHooks(): TextShapingHooks | null {
    if (hooks !== undefined) return hooks;
    hooks = registry.shapingHooksFor({
      contextId: () => context.cacheKey,
      candidatesFor: (appearance) => registry.shapeCandidates(appearance),
    });
    return hooks;
  }
  return context;
}

/** Record why a shaped item is not serving, once per distinct
    problem (the set dedupes): fallback is reported, never silent. */
function noteShapingFallback(issues: Set<string>, state: ShapedItemState): void {
  if (state.state === 'pending') issues.add('shaping-pending: text measured without engine shaping (preparation in progress)');
  else if (state.state === 'missing') issues.add('shaping-missing: text measured without engine shaping (not prepared)');
  else if (state.state === 'refused') issues.add(`shaping-refused: ${state.problem}`);
}

/**
 * Itemwise-exact shaped measurement: direct items are measured by
 * the existing native path on their slice; ready shaped items
 * contribute their runs' advances and signed ink, each scaled by
 * its own face's capital height, accumulated on a logical-order
 * pen. Any shaped item that is not ready returns null — the
 * caller falls back to today's whole-string measurement with the
 * reason recorded. Mixed numbers are never returned.
 */
function measureShaped(
  hooks: TextShapingHooks,
  text: string,
  height: number,
  appearance: TextAppearance,
  issues: Set<string>,
  measureSlice: (slice: string, height: number, appearance: TextAppearance) => TextMetricResult,
): TextMetricResult | null {
  const plain = plainText(text);
  const itemized = itemizeParagraph(plain);
  if (!itemized.items.some((item) => item.route === 'shaped' || item.route === 'refused')) return null;
  let advance = 0, left = Infinity, right = -Infinity, ascent = -Infinity, descent = -Infinity;
  for (const item of itemized.items) {
    if (item.route === 'refused') {
      issues.add(`shaping-refused: ${item.problem}`);
      return null;
    }
    if (item.route === 'direct') {
      const slice = measureSlice(plain.slice(item.itemStart, item.itemEnd), height, appearance);
      left = Math.min(left, advance + slice.left);
      right = Math.max(right, advance + slice.right);
      ascent = Math.max(ascent, slice.ascent);
      descent = Math.max(descent, slice.descent);
      advance += slice.advance;
      continue;
    }
    const state = hooks.shaped(plain, appearance, item.derivation.itemStart, item.derivation.itemEnd);
    if (state.state !== 'ready') {
      noteShapingFallback(issues, state);
      return null;
    }
    for (const subitem of state.subitems) {
      const scale = height / subitem.capitalHeight;
      const ink = subitem.run.ink;
      if (ink.xMin !== ink.xMax || ink.yMin !== ink.yMax) {
        left = Math.min(left, advance + ink.xMin * scale);
        right = Math.max(right, advance + ink.xMax * scale);
        ascent = Math.max(ascent, ink.yMax * scale);
        descent = Math.max(descent, -ink.yMin * scale);
      }
      advance += subitem.run.advanceX * scale;
    }
  }
  return {
    advance,
    left: left === Infinity ? 0 : left,
    right: right === -Infinity ? 0 : right,
    ascent: ascent === -Infinity ? 0 : ascent,
    descent: descent === -Infinity ? 0 : descent,
  };
}

export function textGeometryForStyles(styles: Styles): TextGeometryContext {
  let context = contexts.get(styles);
  if (!context) { context = createTextGeometryContext(styles); contexts.set(styles, context); }
  return context;
}
export function requestTextFonts(styles: Styles): Promise<void> {
  const context = textGeometryForStyles(styles);
  for (const style of Object.values(styles)) if (isTrueTypeStyle(style)) context.resolve({ style: style.name, ...fontWeight(style) });
  return fontMetrics.ready();
}
