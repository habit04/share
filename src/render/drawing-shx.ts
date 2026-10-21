import type { TextStyle } from '../io/encoding';
import type { TextAppearance, TextGeometryContext, TextMetricResult } from '../core/text-metrics';
import { findTextStyle, UNICODE_STROKE_FALLBACK_NOTICE } from './hershey';
import { createTextGeometryContext } from './font-metrics';
import { ShxFontRegistry, type ShxResource } from './shx-fonts';

type Styles = Readonly<Record<string, TextStyle>>;
/** Explicit font bindings fold ASCII case only; other Unicode spellings must match exactly. */
const fontKey = (name: string): string => name.replace(/^.*[\\/]/, '').replace(/\.shx$/i, '').replace(/[A-Z]/g, (character) => character.toLowerCase());

/** Explicitly selected resources belong to one document session, outside its saved state. */
export class DrawingShxResources {
  private readonly registry = new ShxFontRegistry();
  private readonly bindings = new Map<string, string>();
  private readonly contexts = new WeakMap<Styles, TextGeometryContext>();
  private bindingEpoch: object = {};
  private requestOrder = 0;
  private readonly appliedOrders = new Map<string, number>();
  constructor(private readonly changed: () => void = () => {}) {}

  async load(resource: ShxResource): Promise<{ filename: string; isFont: boolean; problem: string | null; applied: boolean }> {
    const filename = resource.resolvedPath.replace(/^.*[\\/]/, '');
    if (!/\.shx$/i.test(filename)) throw new Error('Choose an SHX font or shape file.');
    const order = ++this.requestOrder, key = fontKey(filename);
    const id = await this.registry.register(resource), font = this.registry.font(id)!;
    const applied = order > (this.appliedOrders.get(key) ?? 0);
    if (applied) { this.appliedOrders.set(key, order); this.bindings.set(key, id); this.bindingEpoch = {}; this.changed(); }
    return { filename, isFont: font.isFont, problem: font.renderProblem, applied };
  }
  geometry(styles: Styles): TextGeometryContext {
    let context = this.contexts.get(styles);
    if (!context) { context = this.wrap(styles, this.registry, () => this.bindings, () => this.bindingEpoch); this.contexts.set(styles, context); }
    return context;
  }
  /** Capture immutable decoded programs and filename bindings before any plot awaits. */
  capture(styles: Styles, vector = false): TextGeometryContext {
    const bindings = new Map(this.bindings), epoch = {};
    return this.wrap(styles, this.registry.capture(), () => bindings, () => epoch, vector);
  }
  private wrap(styles: Styles, registry: ShxFontRegistry, bindings: () => ReadonlyMap<string, string>, bindingEpoch: () => object, vector = false): TextGeometryContext {
    const fallback = createTextGeometryContext(styles);
    let oldFallback: object | undefined, oldShx: object | undefined, oldBindings: object | undefined, key = {};
    const issues = new Set<string>();
    const run = (text: string, height: number, face: TextAppearance) => {
      if (face.kind !== 'stroke' || !face.shxResourceId) return null;
      const font = registry.font(face.shxResourceId);
      if (vector && font?.fontType !== 0) {
        const problem = 'SHX vector outlines require an unrestricted Unicode font header in this milestone.';
        issues.add(`${font?.name || 'SHX font'}: ${problem}`); return { ok: false as const, problem };
      }
      const result = registry.run(face.shxResourceId, text.replace(/%%[uUoOkK]/g, ''), height);
      if (!result.ok) issues.add(`${font?.name || 'SHX font'}: ${result.problem}`);
      return result;
    };
    const metric = (text: string, height: number, face: TextAppearance): TextMetricResult => {
      const result = run(text, height, face);
      return result?.ok ? { advance: result.advance, left: result.left, right: result.right, ascent: result.ascent, descent: result.descent } : fallback.measure(text, height, face);
    };
    return {
      get cacheKey() {
        if (oldFallback !== fallback.cacheKey || oldShx !== registry.cacheKey || oldBindings !== bindingEpoch()) {
          oldFallback = fallback.cacheKey; oldShx = registry.cacheKey; oldBindings = bindingEpoch(); key = {};
        }
        return key;
      },
      resolve(input) {
        // Bind an explicitly loaded SHX before considering the Hershey coverage substitute.
        const face = fallback.resolve({ ...input, text: undefined });
        if (face.kind !== 'stroke') return face;
        const style = findTextStyle(input.style, styles);
        // Preserve unsupported native modes without pretending to implement their layout.
        if (style?.bigFont || (style?.flags ?? 0) & 4 || (style?.generation ?? 0) & 6) return fallback.resolve(input);
        const id = bindings().get(fontKey(style?.font || 'txt'));
        const font = id ? registry.font(id) : undefined;
        const native = font?.isFont && !font.renderProblem ? { ...face, shxResourceId: id } : face;
        if (input.text === undefined || native.shxResourceId && run(input.text, 1, native)?.ok) return native;
        const substitute = fallback.resolve(input);
        if (substitute.kind === 'canvas' && substitute.strokeFallback) issues.add(UNICODE_STROKE_FALLBACK_NOTICE);
        return substitute.kind === 'canvas' ? substitute : native;
      },
      measure: metric,
      shxRun: run,
      get fontIssues() { return new Set([...issues, ...(fallback.fontIssues ?? [])]); },
      fontSize: (height, face) => fallback.fontSize!(height, face),
      advances: (text, height, face) => fallback.advances!(text, height, face),
      baselineDescent(height, face) {
        const font = face.kind === 'stroke' && face.shxResourceId ? registry.font(face.shxResourceId) : undefined;
        return font ? height * font.below / font.above : fallback.baselineDescent!(height, face);
      },
    };
  }
}
