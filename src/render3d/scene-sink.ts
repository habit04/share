/**
 * SceneSink: the small seam through which 2D drawing content reaches a 3D (or future GPU 2D)
 * renderer, plus the adapter that feeds the current drawing's model-space entities into it.
 *
 * Every 2D entity is emitted on the world plane z = 0 (a 2D point (x, y) is the 3D point (x, y, 0),
 * see src/model3d/math.ts) in its resolved display colour. Only entities on visible layers are
 * emitted (off / frozen layers are skipped, also for block content).
 *
 * What is approximated (the 3D underlay is a reference picture, not a plot):
 * - curves (arcs, circles, ellipses, splines, bulges) are the same polylines the 2D snapping and
 *   intersection code uses (`entitySegments`);
 * - every line is 1 pixel wide and continuous: linetypes, lineweights and polyline widths are not
 *   shown, nor are transparency, wipeouts or MTEXT background masks;
 * - text (TEXT, MTEXT runs, attributes, dimension text) is drawn with the built-in stroke font
 *   (`strokeText` glyphs, width factor and oblique applied) whatever its text style; once
 *   `maxTextSegments` stroke segments have been emitted, further text is drawn as its box;
 * - hatches are their boundary loops (`polygon`); pattern lines and solid fills are not drawn;
 * - POINT objects are a small cross; IMAGE objects are their frame;
 * - xlines and rays are the long segments `entitySegments` gives them.
 */
import type { BlockLookup, Entity, Layer, TextEntity } from '../core/entities';
import { dimensionParts, entitySegments, explodeCompound, explodeInsert, hatchGeometry, imageBoundary, mtextParts, textCorners, textWidth } from '../core/entities';
import type { Point } from '../core/geometry';
import { placedText } from '../core/text-placement';
import type { DrawingState } from '../core/document';
import { resolveColor } from '../render/draw';
import { strokeText } from '../render/hershey';
import { type Vec3, v3 } from '../model3d/math';

/** How a primitive is drawn. `color` is a CSS hex colour (#rrggbb); `entityId` the 2D source object. */
export interface SinkStyle {
  readonly color: string;
  readonly layer: string;
  readonly entityId: string;
}

/** Receives display geometry in world coordinates. */
export interface SceneSink {
  /** A straight segment. */
  line(a: Vec3, b: Vec3, style: SinkStyle): void;
  /** A closed planar outline (implicitly closed; the first point is not repeated). */
  polygon(points: readonly Vec3[], style: SinkStyle): void;
}

export interface UnderlayOptions {
  /** Stroke-font segment budget for text before falling back to text boxes (default 200,000). */
  readonly maxTextSegments?: number;
  /** Nesting limit for compound objects (default 8). */
  readonly maxDepth?: number;
}

const lift = (p: Point): Vec3 => v3(p.x, p.y, 0);

/** Layers that are off or frozen (their objects are not drawn). */
export function hiddenLayerNames(layers: readonly Layer[]): Set<string> {
  return new Set(layers.filter((l) => !l.visible || l.frozen).map((l) => l.name));
}

/**
 * Emit the model-space entities of `state` into `sink`. Returns the number of entities whose
 * geometry was emitted (top-level objects, not their parts).
 */
export function emitDrawingUnderlay(state: DrawingState, sink: SceneSink, opts: UnderlayOptions = {}): number {
  const lookup: BlockLookup = (name) => state.blocks[name];
  const hidden = hiddenLayerNames(state.layers);
  const budget = { text: opts.maxTextSegments ?? 200_000 };
  const maxDepth = opts.maxDepth ?? 8;
  let n = 0;
  for (const e of state.entities) {
    if (hidden.has(e.layer)) continue;
    emitEntity(e, sink, state.layers, lookup, hidden, budget, maxDepth);
    n++;
  }
  return n;
}

/** Emit one entity (and, for compound objects, its visible parts). */
export function emitEntity(e: Entity, sink: SceneSink, layers: readonly Layer[], lookup: BlockLookup, hidden: ReadonlySet<string> = new Set(), budget = { text: 200_000 }, depth = 8): void {
  const style: SinkStyle = { color: resolveColor(e, layers), layer: e.layer, entityId: e.id };
  const parts = (list: readonly Entity[]): void => {
    if (depth <= 0) return;
    for (const sub of list) {
      if (hidden.has(sub.layer)) continue;
      // Parts keep the top-level id so a later highlight can find their source object.
      emitEntity({ ...sub, id: e.id } as Entity, sink, layers, lookup, hidden, budget, depth - 1);
    }
  };
  switch (e.type) {
    case 'text':
      emitText(e, sink, style, budget);
      return;
    case 'mtext':
      for (const part of mtextParts(e)) emitText({ ...part, id: e.id }, sink, { ...style, color: resolveColor(part, layers) }, budget);
      for (const [a, b] of entitySegments(e, lookup)) sink.line(lift(a), lift(b), style);
      return;
    case 'insert':
      parts(explodeInsert(e, lookup));
      return;
    case 'dimension':
      parts(dimensionParts(e));
      return;
    case 'leader':
    case 'table':
      parts(explodeCompound(e) ?? []);
      return;
    case 'hatch':
      // Boundary loops only (explodeCompound would give pattern lines).
      for (const poly of hatchGeometry(e).polys) sink.polygon(poly.map(lift), style);
      return;
    case 'image':
      sink.polygon(imageBoundary(e).map(lift), style);
      return;
    case 'point': {
      const s = 0.05;
      const p = e.position;
      sink.line(v3(p.x - s, p.y, 0), v3(p.x + s, p.y, 0), style);
      sink.line(v3(p.x, p.y - s, 0), v3(p.x, p.y + s, 0), style);
      return;
    }
    default:
      for (const [a, b] of entitySegments(e, lookup)) sink.line(lift(a), lift(b), style);
  }
}

/** Text as stroke-font segments while the budget lasts, else its placed box. */
function emitText(t: TextEntity, sink: SceneSink, style: SinkStyle, budget: { text: number }): void {
  if (!t.text.trim() || !(t.height > 0)) return;
  if (budget.text <= 0) {
    sink.polygon(textCorners(t).map(lift), style);
    return;
  }
  const placed = placedText(t, textWidth);
  const wf = placed.widthFactor ?? 1, shear = Math.tan(placed.oblique ?? 0);
  const c = Math.cos(placed.rotation), s = Math.sin(placed.rotation);
  // Strokes at the origin, unrotated, left-aligned; then width factor, oblique, rotation, position.
  const strokes = strokeText(placed.text, { x: 0, y: 0 }, placed.height, 0, placed.align);
  const map = (q: { x: number; y: number }): Vec3 => {
    const lx = q.x * wf + q.y * shear, ly = q.y;
    return v3(placed.position.x + lx * c - ly * s, placed.position.y + lx * s + ly * c, 0);
  };
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.length; i++) sink.line(map(stroke[i]!), map(stroke[i + 1]!), style);
    budget.text -= Math.max(0, stroke.length - 1);
  }
}
