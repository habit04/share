import type { DrawingState } from '../../core/document';
import type { ArcEntity, BlockDef, CircleEntity, Entity, InsertEntity, LineEntity, PolylineEntity, TextEntity } from '../../core/entities';
import { entityGeometryWork, expandInsert } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { placedText, textPlacementProblem, transformedTextAnchors } from '../../core/text-placement';
import { TEXT_STYLES_META_KEY, textStyleOf, textStylesOf } from '../../io/encoding';
import { colorDisplay, lineweightDisplay, resolveColor, resolveLineWidth } from '../draw';
import { expandControlCodes, glyphFor, hasStrokeFont, strokeText, strokeTextWidth, textRenderer } from '../hershey';
import type { Gpu2DOverlay, Gpu2DView } from './geometry2d';

export type LocalStrokeEntity = LineEntity | PolylineEntity | CircleEntity | ArcEntity;
/** All coordinates are world doubles relative to the copied camera anchor. */
export type LocalStrokePath =
  | { readonly kind: 'entity'; readonly entity: LocalStrokeEntity }
  | { readonly kind: 'path'; readonly points: readonly Point[]; readonly closed: boolean };

/** Exactly one Canvas stroke: glyph subpaths must share a stencil/compositing batch. */
export interface StrokePaintOperation {
  readonly ownerId: string;
  readonly paintId: string;
  readonly sourceId: string;
  readonly paths: readonly LocalStrokePath[];
  readonly color: readonly [number, number, number];
  readonly alpha: number;
  readonly widthCss: number;
}

export interface StrokeSceneOptions {
  readonly minRatio?: number;
  readonly maxRatio?: number;
  readonly maxEntities?: number;
  readonly maxPoints?: number;
  readonly maxWork?: number;
  readonly maxBlockDepth?: number;
}

export type LoweredStrokeScene =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true;
    readonly operations: readonly StrokePaintOperation[];
    readonly minRatio: number;
    readonly maxRatio: number;
    /** Original definitions, including nested references; identity changes invalidate reuse. */
    readonly blockDependencies: ReadonlyMap<string, BlockDef>;
    /** Raw document identity: textStylesOf's absent-style default creates a fresh object. */
    readonly textStylesDependency: unknown;
    readonly preparedEntities: number;
  };

const DEFAULT_MAX_ENTITIES = 100_000;
const DEFAULT_MAX_POINTS = 1_000_000;
const DEFAULT_MAX_WORK = 1_000_000;
const MAX_BLOCK_DEPTH = 8; // Keep inside explodeInsert's existing recursion limit.
const QTEXT_PIXELS = 2.5;

function finitePoint(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Nonfinite stroke-scene coordinate');
  return point;
}

function rgb(css: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(css);
  if (!match) throw new Error('Unsupported stroke-scene display color');
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

function primitiveProblem(entity: Entity, state: DrawingState): string | null {
  if (entity.annotative) return `Unsupported annotative style (${entity.id})`;
  const layer = state.layers.find((item) => item.name === entity.layer);
  const name = effectiveLinetype(entity.linetype, layer?.linetype);
  if (findLinetype(name, state.header?.linetypes)?.pattern.length) return `Unsupported dashed linetype: ${name} (${entity.id})`;
  if (resolveAlpha(entity, state.layers) !== 1) return `Unsupported transparency (${entity.id})`;
  switch (entity.type) {
    case 'line': return null;
    case 'text': return entity.bold ? `Unsupported bold stroke text (${entity.id})` : null;
    case 'circle': return entity.filled ? `Unsupported filled circle (${entity.id})` : null;
    case 'arc': return null;
    case 'polyline': {
      const problem = polylineWidthProblem(entity);
      if (problem) return `${problem} (${entity.id})`;
      return entity.filled || entity.widthFrame || (entity.width ?? 0) !== 0 || entity.widths?.some((width) => width.start !== 0 || width.end !== 0)
        ? `Unsupported polyline width or fill (${entity.id})` : null;
    }
    default: return `Unsupported entity: ${entity.type} (${entity.id})`;
  }
}

function localEntity(entity: LocalStrokeEntity, local: (point: Point) => Point): LocalStrokeEntity {
  switch (entity.type) {
    case 'line': return { ...entity, a: local(entity.a), b: local(entity.b) };
    case 'polyline': {
      if (entity.bulges?.some((value) => !Number.isFinite(value))) throw new Error(`Nonfinite polyline bulge (${entity.id})`);
      return { ...entity, points: entity.points.map(local) };
    }
    case 'circle':
    case 'arc': {
      if (!Number.isFinite(entity.radius) || entity.radius < 0 || (entity.type === 'arc' && ![entity.startAngle, entity.endAngle].every(Number.isFinite))) throw new Error(`Invalid curve geometry (${entity.id})`);
      return { ...entity, center: local(entity.center) };
    }
  }
}

/**
 * Compile the whole layer-visible scene before any GL submission. Refusal exposes no partial
 * operations. Expansion and text placement operate after camera rebasing, never at huge world
 * glyph origins. The source drawing, definitions, text-style registry and anchors stay untouched.
 * Geometry packing/clipping and curve-error checks remain the renderer's responsibility.
 */
export function lowerStrokeScene(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, options: StrokeSceneOptions = {}): LoweredStrokeScene {
  const previousPaper = colorDisplay.paper, previousWeights = { ...lineweightDisplay };
  try {
    if (![view.width, view.height, view.scale, view.dpr, view.center.x, view.center.y, view.twist].every(Number.isFinite) || view.width <= 0 || view.height <= 0 || view.scale <= 0 || view.dpr <= 0) throw new Error('Invalid stroke-scene view');
    let minRatio = options.minRatio ?? 0.8, maxRatio = options.maxRatio ?? 1.25;
    if (!Number.isFinite(minRatio) || !Number.isFinite(maxRatio) || minRatio <= 0 || minRatio > 1 || maxRatio < 1) throw new Error('Invalid stroke-scene zoom interval');
    const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES;
    const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
    const maxWork = options.maxWork ?? DEFAULT_MAX_WORK;
    const maxDepth = options.maxBlockDepth ?? MAX_BLOCK_DEPTH;
    if (![maxEntities, maxPoints, maxWork, maxDepth].every((value) => Number.isSafeInteger(value) && value >= 0) || maxDepth > MAX_BLOCK_DEPTH) throw new Error('Invalid stroke-scene geometry budget');
    const hidden = new Set(state.layers.filter((layer) => !layer.visible).map((layer) => layer.name));
    const dependencies = new Map<string, BlockDef>();
    const lookup = (name: string): BlockDef | undefined => state.blocks[name];
    let work = 0, visits = 0, preparedEntities = 0, points = 0;
    const spend = (amount: number): void => {
      work += amount;
      if (!Number.isSafeInteger(work) || work > maxWork) throw new Error('Stroke-scene expansion exceeds work budget');
    };
    const countPoints = (amount: number): void => {
      points += amount;
      if (points > maxPoints) throw new Error('Stroke-scene geometry exceeds point budget');
    };
    // Preflight all reference paths: core expansion can silently skip missing/deep references.
    // Do not prune an insert on a hidden layer: explicit-layer descendants can remain visible.
    const preflightInsert = (insert: InsertEntity, chain: readonly string[]): void => {
      if (++visits > maxEntities) throw new Error('Stroke-scene expansion exceeds reference budget');
      if (chain.length > maxDepth) throw new Error('Stroke-scene block nesting exceeds depth budget');
      if (chain.includes(insert.block)) throw new Error(`Cyclic block reference: ${insert.block}`);
      if (!Number.isFinite(insert.scale) || insert.scale <= 0 || (insert.scaleY !== undefined && insert.scaleY !== insert.scale) || insert.mirror || !Number.isFinite(insert.rotation)) throw new Error(`Unsupported block transform (${insert.id})`);
      if ((insert.rows ?? 1) !== 1 || (insert.columns ?? 1) !== 1) throw new Error(`Unsupported block array (${insert.id})`);
      if (insert.annotative) throw new Error(`Unsupported annotative block (${insert.id})`);
      finitePoint(insert.position);
      const block = lookup(insert.block);
      if (!block) throw new Error(`Missing block definition: ${insert.block}`);
      if (block.xref) throw new Error(`Unsupported external reference: ${insert.block}`);
      finitePoint(block.basePoint);
      dependencies.set(insert.block, block);
      for (const child of block.entities) {
        spend(entityGeometryWork(child));
        if (child.type === 'insert') preflightInsert(child, [...chain, insert.block]);
      }
      for (const attribute of block.attributes) spend(1 + attribute.default.length);
    };
    colorDisplay.paper = false;
    lineweightDisplay.enabled = view.lineweights ?? previousWeights.enabled;
    lineweightDisplay.pxPerMm = undefined;
    const styles = textStylesOf(state);
    const operations: StrokePaintOperation[] = [];
    const rebase = (point: Point): Point => finitePoint({ x: point.x - view.center.x, y: point.y - view.center.y });
    const alreadyLocal = (point: Point): Point => finitePoint({ ...point });

    const textPaths = (source: TextEntity, local: (point: Point) => Point): LocalStrokePath[] => {
      const rebased = transformedTextAnchors(source, local);
      const problem = textPlacementProblem(rebased);
      if (problem) throw new Error(`${problem} (${source.id})`);
      if (![rebased.height, rebased.rotation, rebased.widthFactor ?? 1, rebased.oblique ?? 0].every(Number.isFinite) || rebased.height <= 0) throw new Error(`Invalid TEXT geometry (${source.id})`);
      if (!hasStrokeFont || textRenderer(textStyleOf(source), styles).kind !== 'stroke') throw new Error(`Unsupported Canvas font (${source.id})`);
      const placed = placedText(rebased, strokeTextWidth);
      finitePoint(placed.position);
      const px = placed.height * view.scale, wf = placed.widthFactor && placed.widthFactor > 0 ? placed.widthFactor : 1;
      const slant = placed.oblique ? Math.tan(placed.oblique) : 0;
      if (![px, wf, slant, placed.rotation].every(Number.isFinite) || px <= 0) throw new Error(`Invalid placed TEXT geometry (${source.id})`);
      // Canvas strips decoration toggles after placement, so native FIT width uses raw text.
      const text = placed.text.includes('%%') ? placed.text.replace(/%%[uUoOkK]/g, '') : placed.text;
      const c = Math.cos(placed.rotation), s = Math.sin(placed.rotation);
      const at = (x: number, y: number): Point => finitePoint({ x: placed.position.x + x * c - y * s, y: placed.position.y + x * s + y * c });
      if (px < QTEXT_PIXELS) {
        // Keep every reused frame strictly on this side of Canvas's '< 2.5' decision.
        maxRatio = Math.min(maxRatio, QTEXT_PIXELS / px * (1 - 8 * Number.EPSILON));
        if (maxRatio < 1) throw new Error(`TEXT is too close to QTEXT threshold (${source.id})`);
        const width = text.length * placed.height * 0.8 * wf;
        const offset = placed.align === 'center' ? -width / 2 : placed.align === 'right' ? -width : 0;
        countPoints(2);
        return [{ kind: 'path', points: [at(offset, 0), at(offset + width, 0)], closed: false }];
      }
      // New-scale multiplication can round differently from a cached ratio division.
      // A small reserve rebuilds before that ambiguity; the current readable frame stays valid.
      minRatio = Math.max(minRatio, Math.min(1, QTEXT_PIXELS / px * (1 + 8 * Number.EPSILON)));
      // Refuse before glyph arrays are allocated: maxPoints must bound preparation as well
      // as the returned scene. Count the same expanded/fallback glyphs the Canvas font uses.
      for (const character of expandControlCodes(text)) {
        const glyph = glyphFor(character) ?? glyphFor('?');
        if (glyph) for (const stroke of glyph.strokes) countPoints(stroke.length);
      }
      const strokes = strokeText(text, { x: 0, y: 0 }, placed.height, 0, placed.align);
      return strokes.map((stroke) => {
        return { kind: 'path', points: stroke.map((point) => at(point.x * wf + point.y * slant, point.y)), closed: false };
      });
    };

    for (const owner of state.entities) {
      if (hidden.has(owner.layer)) continue;
      spend(entityGeometryWork(owner));
      const selected = overlay.selection.has(owner.id), hovered = overlay.hover === owner.id && !selected;
      if (selected && !overlay.solidSelection) throw new Error(`Dashed selection requires Canvas rendering (${owner.id})`);
      const widthCss = selected ? 2.5 : hovered ? 2 : resolveLineWidth(owner, state.layers, { scale: view.scale, toScreen: rebase });
      if (!Number.isFinite(widthCss) || widthCss <= 0) throw new Error(`Invalid lineweight (${owner.id})`);
      let leaves: readonly Entity[] = [owner];
      let local = rebase;
      if (owner.type === 'insert') {
        preflightInsert(owner, []);
        // Base-point subtraction and every nested transform now happen in anchor-local doubles.
        const expanded = expandInsert({ ...owner, position: rebase(owner.position) }, lookup, Math.max(0, maxEntities - preparedEntities));
        if (expanded.truncated || expanded.cyclic) throw new Error(`Incomplete block expansion (${owner.id})`);
        leaves = expanded.entities;
        local = alreadyLocal;
      }
      for (const leaf of leaves) {
        if (hidden.has(leaf.layer)) continue;
        if (++preparedEntities > maxEntities) throw new Error('Stroke-scene expansion exceeds entity budget');
        const problem = primitiveProblem(leaf, state);
        if (problem) throw new Error(problem);
        let paths: LocalStrokePath[];
        if (leaf.type === 'text') paths = textPaths(leaf, local);
        else if (leaf.type === 'line' || leaf.type === 'polyline' || leaf.type === 'circle' || leaf.type === 'arc') {
          countPoints(leaf.type === 'polyline' ? leaf.points.length : 2);
          paths = [{ kind: 'entity', entity: localEntity(leaf, local) }];
        } else throw new Error(`Unsupported entity: ${leaf.type} (${leaf.id})`);
        operations.push({ ownerId: owner.id, sourceId: leaf.id, paintId: `${owner.id}:${operations.length}`, paths, color: rgb(resolveColor(leaf, state.layers)), widthCss, alpha: selected || hovered ? 0.95 : 1 });
      }
    }
    return { ok: true, operations, minRatio, maxRatio, blockDependencies: dependencies, textStylesDependency: state.meta?.[TEXT_STYLES_META_KEY], preparedEntities };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Stroke-scene preparation failed' };
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
}
