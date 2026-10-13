import type { DrawingState } from '../../core/document';
import type { ArcEntity, BlockDef, CircleEntity, Entity, InsertEntity, LineEntity, PolylineEntity, TextEntity } from '../../core/entities';
import { attributeText, entityGeometryWork, expandInsert, insertTransform, similarityTransform } from '../../core/entities';
import type { Point } from '../../core/geometry';
import { resolveAlpha } from '../../core/appearance';
import { effectiveLinetype, findLinetype } from '../../core/linetypes';
import { polylineWidthProblem } from '../../core/polyline-widths';
import { placedText, textPlacementProblem, transformedTextAnchors } from '../../core/text-placement';
import { TEXT_STYLES_META_KEY, textStyleOf, textStylesOf } from '../../io/encoding';
import { colorDisplay, lineweightDisplay, resolveColor, resolveLineWidth } from '../draw';
import { expandControlCodes, glyphFor, hasStrokeFont, strokeText, strokeTextWidth, textRenderer } from '../hershey';
import type { Gpu2DOverlay, Gpu2DView } from './geometry2d';
import { canvasArcAdmission } from './arc-admission';

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
  | { readonly ok: false; readonly reason: string; readonly cause?: unknown }
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
// Text has no curve approximation: keep its Canvas-world arithmetic difference inside
// this small part of the quarter-physical-pixel geometry budget. Float32 remains separate.
const CANVAS_WORLD_PIXEL_ERROR = 0.0625;

/** Conservative binary64 reserve for construction at an original Canvas world origin. */
export function canvasWorldCoordinatePrecisionProblem(worldMagnitude: number, view: Pick<Gpu2DView, 'scale' | 'dpr'>, maxRatio: number, operationCount = 8): string | null {
  const bound = Math.abs(worldMagnitude) * Number.EPSILON * operationCount * view.scale * maxRatio * view.dpr;
  return !Number.isFinite(bound) || bound > CANVAS_WORLD_PIXEL_ERROR ? 'Canvas world-coordinate quantization exceeds construction precision budget' : null;
}

function pointMagnitude(point: Point): number {
  finitePoint(point);
  return Math.max(Math.abs(point.x), Math.abs(point.y));
}

function sourceCoordinateMagnitude(entity: Entity): number {
  switch (entity.type) {
    case 'line': return Math.max(pointMagnitude(entity.a), pointMagnitude(entity.b));
    case 'polyline': return entity.points.reduce((largest, point) => Math.max(largest, pointMagnitude(point)), 0);
    case 'circle':
    case 'arc': return pointMagnitude(entity.center) + Math.abs(entity.radius);
    case 'insert': return pointMagnitude(entity.position);
    case 'text': return Math.max(pointMagnitude(entity.position), entity.alignmentPoint ? pointMagnitude(entity.alignmentPoint) : 0, entity.firstAlignmentPoint ? pointMagnitude(entity.firstAlignmentPoint) : 0);
    default: return 0; // Unsupported leaves already require complete-view Canvas fallback.
  }
}

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
    case 'arc': {
      const admission = canvasArcAdmission(entity);
      return admission.ok ? null : `${admission.reason} (${entity.id})`;
    }
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
    // Follow native world transforms only for references and text, while the ordinary
    // expansion produces the rebased geometry. This avoids a second full expansion and
    // keeps the exact Canvas TEXT/ATTRIB anchor arithmetic available for parity checks.
    let canvasTexts: TextEntity[] = [];
    const canvasText = (entity: TextEntity): void => {
      if (canvasTexts.length >= maxEntities) throw new Error('Stroke-scene text preflight exceeds entity budget');
      canvasTexts.push(entity);
    };
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
      const transform = insertTransform(insert, block);
      for (const child of block.entities) {
        spend(entityGeometryWork(child));
        // Canvas constructs every expanded primitive at the world INSERT origin. This
        // reserve also covers pure LINE blocks; standalone world LINEs still use their
        // existing double-subtraction proof without any added origin restriction.
        const constructionMagnitude = pointMagnitude(insert.position) + 2 * insert.scale * (pointMagnitude(block.basePoint) + sourceCoordinateMagnitude(child));
        const precisionProblem = canvasWorldCoordinatePrecisionProblem(constructionMagnitude, view, maxRatio, 16 * (chain.length + 1));
        if (precisionProblem) throw new Error(`${precisionProblem} in INSERT (${insert.id})`);
        if (child.type === 'insert' || child.type === 'text') {
          const moved = similarityTransform(child, transform, insert.rotation, insert.scale);
          if (moved.type === 'insert') preflightInsert(moved, [...chain, insert.block]);
          else if (moved.type === 'text') canvasText(moved);
        }
      }
      for (const attribute of block.attributes) {
        spend(1 + attribute.default.length);
        if (attribute.invisible || insert.hiddenAttributes?.includes(attribute.tag)) continue;
        const value = insert.attributes[attribute.tag] ?? attribute.default;
        if (value) canvasText(attributeText(insert, block, attribute, value));
      }
    };
    colorDisplay.paper = false;
    lineweightDisplay.enabled = view.lineweights ?? previousWeights.enabled;
    lineweightDisplay.pxPerMm = undefined;
    const styles = textStylesOf(state);
    const operations: StrokePaintOperation[] = [];
    const rebase = (point: Point): Point => finitePoint({ x: point.x - view.center.x, y: point.y - view.center.y });
    const alreadyLocal = (point: Point): Point => finitePoint({ ...point });

    const textPaths = (source: TextEntity, local: (point: Point) => Point, canvasSource: TextEntity): LocalStrokePath[] => {
      const rebased = transformedTextAnchors(source, local);
      const problem = textPlacementProblem(rebased);
      if (problem) throw new Error(`${problem} (${source.id})`);
      if (![rebased.height, rebased.rotation, rebased.widthFactor ?? 1, rebased.oblique ?? 0].every(Number.isFinite) || rebased.height <= 0) throw new Error(`Invalid TEXT geometry (${source.id})`);
      if (!hasStrokeFont || textRenderer(textStyleOf(source), styles).kind !== 'stroke') throw new Error(`Unsupported Canvas font (${source.id})`);
      const placed = placedText(rebased, strokeTextWidth);
      const canvasPlaced = placedText(canvasSource, strokeTextWidth);
      finitePoint(placed.position);
      finitePoint(canvasPlaced.position);
      const px = placed.height * view.scale, wf = placed.widthFactor && placed.widthFactor > 0 ? placed.widthFactor : 1;
      const slant = placed.oblique ? Math.tan(placed.oblique) : 0;
      if (![px, wf, slant, placed.rotation].every(Number.isFinite) || px <= 0) throw new Error(`Invalid placed TEXT geometry (${source.id})`);
      // Canvas strips decoration toggles after placement, so native FIT width uses raw text.
      const text = placed.text.includes('%%') ? placed.text.replace(/%%[uUoOkK]/g, '') : placed.text;
      const c = Math.cos(placed.rotation), s = Math.sin(placed.rotation);
      const at = (x: number, y: number): Point => finitePoint({ x: placed.position.x + x * c - y * s, y: placed.position.y + x * s + y * c });
      const canvasPx = canvasPlaced.height * view.scale;
      if (!Number.isFinite(canvasPx) || (canvasPx < QTEXT_PIXELS) !== (px < QTEXT_PIXELS)) throw new Error(`Canvas world TEXT placement changes QTEXT decision (${source.id})`);
      const parity = (maxX: number, maxY: number, placeholder: boolean): void => {
        const basis = (entity: TextEntity): readonly [number, number, number, number] => {
          const cos = Math.cos(entity.rotation), sin = Math.sin(entity.rotation);
          const width = entity.widthFactor && entity.widthFactor > 0 ? entity.widthFactor : 1;
          const shear = placeholder ? 0 : entity.oblique ? Math.tan(entity.oblique) : 0;
          return [entity.height * width * cos, entity.height * (shear * cos - sin), entity.height * width * sin, entity.height * (shear * sin + cos)];
        };
        const a = basis(placed), b = basis(canvasPlaced);
        const dx = Math.abs((canvasPlaced.position.x - view.center.x) - placed.position.x) + maxX * Math.abs(a[0] - b[0]) + maxY * Math.abs(a[1] - b[1]);
        const dy = Math.abs((canvasPlaced.position.y - view.center.y) - placed.position.y) + maxX * Math.abs(a[2] - b[2]) + maxY * Math.abs(a[3] - b[3]);
        const tc = Math.abs(Math.cos(view.twist)), ts = Math.abs(Math.sin(view.twist));
        // QTEXT adds offsets in screen space. Readable Hershey glyphs add them in world
        // space, so a huge world origin can round away offsets that rebasing preserves.
        const magnitude = Math.max(Math.abs(canvasPlaced.position.x), Math.abs(canvasPlaced.position.y)) + maxX * Math.max(Math.abs(b[0]), Math.abs(b[2])) + maxY * Math.max(Math.abs(b[1]), Math.abs(b[3]));
        const rounding = placeholder ? 0 : magnitude * Number.EPSILON * 8;
        const physical = (Math.max(tc * dx + ts * dy, ts * dx + tc * dy) + rounding) * view.scale * maxRatio * view.dpr;
        if (!Number.isFinite(physical) || physical > CANVAS_WORLD_PIXEL_ERROR) throw new Error(`Canvas world-coordinate quantization exceeds TEXT precision budget (${source.id})`);
      };
      if (px < QTEXT_PIXELS) {
        // Keep every reused frame strictly on this side of Canvas's '< 2.5' decision.
        maxRatio = Math.min(maxRatio, QTEXT_PIXELS / Math.max(px, canvasPx) * (1 - 8 * Number.EPSILON));
        if (maxRatio < 1) throw new Error(`TEXT is too close to QTEXT threshold (${source.id})`);
        const width = text.length * placed.height * 0.8 * wf;
        const offset = placed.align === 'center' ? -width / 2 : placed.align === 'right' ? -width : 0;
        parity(text.length * 0.8, 0, true);
        countPoints(2);
        return [{ kind: 'path', points: [at(offset, 0), at(offset + width, 0)], closed: false }];
      }
      // New-scale multiplication can round differently from a cached ratio division.
      // A small reserve rebuilds before that ambiguity; the current readable frame stays valid.
      minRatio = Math.max(minRatio, Math.min(1, QTEXT_PIXELS / Math.min(px, canvasPx) * (1 + 8 * Number.EPSILON)));
      // Refuse before glyph arrays are allocated: maxPoints must bound preparation as well
      // as the returned scene. Count the same expanded/fallback glyphs the Canvas font uses.
      let maxX = 0, maxY = 0;
      const unitWidth = strokeTextWidth(text, 1);
      let pen = placed.align === 'center' ? -unitWidth / 2 : placed.align === 'right' ? -unitWidth : 0;
      for (const character of expandControlCodes(text)) {
        const glyph = glyphFor(character) ?? glyphFor('?');
        if (glyph) {
          for (const stroke of glyph.strokes) {
            countPoints(stroke.length);
            for (const [x, y] of stroke) { maxX = Math.max(maxX, Math.abs(pen + x)); maxY = Math.max(maxY, Math.abs(y)); }
          }
          pen += glyph.advance;
        }
      }
      parity(maxX, maxY, false);
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
      canvasTexts = [];
      let textIndex = 0;
      if (owner.type === 'insert') {
        preflightInsert(owner, []);
        // Base-point subtraction and every nested transform now happen in anchor-local doubles.
        const expanded = expandInsert({ ...owner, position: rebase(owner.position) }, lookup, Math.max(0, maxEntities - preparedEntities));
        if (expanded.truncated || expanded.cyclic) throw new Error(`Incomplete block expansion (${owner.id})`);
        leaves = expanded.entities;
        local = alreadyLocal;
      }
      for (const leaf of leaves) {
        const canvasLeaf = leaf.type === 'text' && owner.type === 'insert' ? canvasTexts[textIndex++] : leaf;
        if (leaf.type === 'text' && (!canvasLeaf || canvasLeaf.type !== 'text' || canvasLeaf.id !== leaf.id)) throw new Error(`Canvas text preflight does not match block expansion (${owner.id})`);
        if (hidden.has(leaf.layer)) continue;
        if (++preparedEntities > maxEntities) throw new Error('Stroke-scene expansion exceeds entity budget');
        const problem = primitiveProblem(leaf, state);
        if (problem) throw new Error(problem);
        let paths: LocalStrokePath[];
        if (leaf.type === 'text') paths = textPaths(leaf, local, canvasLeaf as TextEntity);
        else if (leaf.type === 'line' || leaf.type === 'polyline' || leaf.type === 'circle' || leaf.type === 'arc') {
          countPoints(leaf.type === 'polyline' ? leaf.points.length : 2);
          paths = [{ kind: 'entity', entity: localEntity(leaf, local) }];
        } else throw new Error(`Unsupported entity: ${leaf.type} (${leaf.id})`);
        operations.push({ ownerId: owner.id, sourceId: leaf.id, paintId: `${owner.id}:${operations.length}`, paths, color: rgb(resolveColor(leaf, state.layers)), widthCss, alpha: selected || hovered ? 0.95 : 1 });
      }
    }
    return { ok: true, operations, minRatio, maxRatio, blockDependencies: dependencies, textStylesDependency: state.meta?.[TEXT_STYLES_META_KEY], preparedEntities };
  } catch (error) {
    const failure = { ok: false as const, reason: error instanceof Error ? error.message : 'Stroke-scene preparation failed' };
    // Internal admission provenance must survive wrapping without changing public JSON
    // or exact refusal shapes. Unexpected allocation/graph/glyph errors must stay retryable.
    Object.defineProperty(failure, 'cause', { value: error });
    return failure;
  } finally {
    colorDisplay.paper = previousPaper;
    Object.assign(lineweightDisplay, previousWeights);
  }
}
