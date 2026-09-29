/**
 * Pure helpers shared by the wire / ladder tools, cross-referencing and the
 * reports: wire predicates, breaking a wire around a symbol, rung
 * references. (Tool classes live in src/tools; this module has no UI.)
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, InsertEntity, TextEntity } from '../core/entities';
import { newId } from '../core/entities';
import { WIRE_DOT } from './symbols';
import type { Drawing } from '../core/document';
import { drawingUnitScale, type UnitSource } from './wdm';

/** Wires are lines on the WIRES layer (or any WIRES_* wire-type layer). */
export function isWire(e: Entity): e is LineEntity {
  return e.type === 'line' && e.layer.startsWith('WIRES');
}

export function isHorizontal(l: LineEntity): boolean {
  return Math.abs(l.a.y - l.b.y) < 1e-6;
}

export function isVertical(l: LineEntity): boolean {
  return Math.abs(l.a.x - l.b.x) < 1e-6;
}

/** True when p lies on the interior of an existing wire segment (a tee). */
export function wireTeeAt(doc: Drawing, p: Point, tol = 1e-6): LineEntity | null {
  for (const e of doc.entities) {
    if (!isWire(e)) continue;
    if (g.dist(p, e.a) < tol || g.dist(p, e.b) < tol) continue;
    if (g.distToSegment(p, e.a, e.b) < tol) return e;
  }
  return null;
}

/**
 * Find the horizontal wire nearest to the point (within tolerance) so a
 * component can be inserted in-line and the wire broken around it.
 */
export function findWireAt(doc: Drawing, p: Point, tol: number): LineEntity | null {
  let best: LineEntity | null = null;
  let bestD = tol;
  for (const e of doc.entities) {
    if (!isWire(e) || !isHorizontal(e)) continue;
    const d = g.distToSegment(p, e.a, e.b);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Nearest wire of any orientation. */
export function findAnyWireAt(doc: Drawing, p: Point, tol: number): LineEntity | null {
  let best: LineEntity | null = null;
  let bestD = tol;
  for (const e of doc.entities) {
    if (!isWire(e)) continue;
    const d = g.distToSegment(p, e.a, e.b);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Break a horizontal wire around [x0, x1]. Returns the replacement pieces (0-2 lines). */
export function breakWire(wire: LineEntity, x0: number, x1: number): LineEntity[] {
  const left = Math.min(wire.a.x, wire.b.x);
  const right = Math.max(wire.a.x, wire.b.x);
  const y = wire.a.y;
  const out: LineEntity[] = [];
  if (x0 - left > 1e-6) out.push({ ...wire, id: newId(), a: { x: left, y }, b: { x: x0, y } });
  if (right - x1 > 1e-6) out.push({ ...wire, id: newId(), a: { x: x1, y }, b: { x: right, y } });
  return out;
}

/** Break a vertical wire around [y0, y1]. */
export function breakVerticalWire(wire: LineEntity, y0: number, y1: number): LineEntity[] {
  const bottom = Math.min(wire.a.y, wire.b.y);
  const top = Math.max(wire.a.y, wire.b.y);
  const x = wire.a.x;
  const out: LineEntity[] = [];
  if (top - y1 > 1e-6) out.push({ ...wire, id: newId(), a: { x, y: top }, b: { x, y: y1 } });
  if (y0 - bottom > 1e-6) out.push({ ...wire, id: newId(), a: { x, y: y0 }, b: { x, y: bottom } });
  return out;
}

/** How far (in inches of library geometry) a point may sit from a rung reference's line. */
export const REFERENCE_TOLERANCE = 0.6;

/**
 * Nearest ladder rung reference number for a y position (based on MISC-layer numeric texts).
 * The tolerance follows the drawing units (0.6" = 15.24 mm in metric drawings).
 */
export function nearestReference(doc: UnitSource, p: Point): string | null {
  const tol = REFERENCE_TOLERANCE * drawingUnitScale(doc);
  let best: string | null = null;
  let bestD = Infinity;
  for (const e of doc.entities) {
    if (e.type !== 'text' || e.layer !== 'MISC' || !/^\d+$/.test(e.text)) continue;
    const d = Math.abs(e.position.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = e.text;
    }
  }
  return bestD < tol ? best : null;
}

/** Ladder rung reference texts (MISC layer numbers), top to bottom. */
export function rungReferences(doc: { entities: readonly Entity[] }): TextEntity[] {
  return doc.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'MISC' && /^\d+$/.test(e.text)).sort((a, b) => b.position.y - a.position.y);
}

/** Rails of a ladder: the two long vertical wires nearest to the left and right of a point. */
export function findRails(doc: Drawing, p: Point): { left: LineEntity | null; right: LineEntity | null } {
  let left: LineEntity | null = null;
  let right: LineEntity | null = null;
  for (const e of doc.entities) {
    if (!isWire(e) || !isVertical(e)) continue;
    const y0 = Math.min(e.a.y, e.b.y);
    const y1 = Math.max(e.a.y, e.b.y);
    if (p.y < y0 - 1e-6 || p.y > y1 + 1e-6) continue;
    if (e.a.x <= p.x + 1e-6 && (!left || e.a.x > left.a.x)) left = e;
    if (e.a.x >= p.x - 1e-6 && (!right || e.a.x < right.a.x)) right = e;
  }
  return { left, right };
}

/** Wire junction dot insert (`unitScale` 25.4 in metric drawings, see drawingUnitScale). */
export function wireDot(p: Point, unitScale = 1): InsertEntity {
  return { id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'insert', block: WIRE_DOT.name, position: p, rotation: 0, scale: unitScale, attributes: {} };
}

export function hasDotAt(doc: { entities: readonly Entity[] }, p: Point): boolean {
  return doc.entities.some((e) => e.type === 'insert' && e.block === WIRE_DOT.name && g.dist(e.position, p) < 1e-6);
}

/** Text height used for wire numbers (inches; multiply by the drawing's unit scale). */
export const WIRENO_HEIGHT = 0.125;

/**
 * Library distances of the ladder / wire-number layout, in inches. Metric
 * drawings multiply them by 25.4 (`ladderMetrics(drawingUnitScale(doc))`).
 */
export const LADDER_METRICS_IN = {
  /** Wire number text height. */
  wireNumberHeight: WIRENO_HEIGHT,
  /** Gap between a wire and the wire number above / below it. */
  wireNumberGap: 0.05,
  /** Wire number start from the left end of its wire. */
  wireNumberInset: 0.15,
  /** Rung reference text height. */
  referenceHeight: 0.125,
  /** Rung reference distance left of the left rail. */
  referenceOffset: 0.25,
  /** Rung reference baseline drop below the rung. */
  referenceDrop: 0.06,
  /** Distance between the phase rails of a 3-phase ladder. */
  phaseSpacing: 0.5,
} as const;

export type LadderMetrics = { readonly [K in keyof typeof LADDER_METRICS_IN]: number };

/** The ladder / wire-number distances in drawing units. */
export function ladderMetrics(unitScale = 1): LadderMetrics {
  const out = {} as Record<keyof typeof LADDER_METRICS_IN, number>;
  for (const k of Object.keys(LADDER_METRICS_IN) as Array<keyof typeof LADDER_METRICS_IN>) out[k] = LADDER_METRICS_IN[k] * unitScale;
  return out;
}

export function wireNumberText(pos: Point, label: string, layer = 'WIRENO', align: 'left' | 'center' | 'right' = 'left', height = WIRENO_HEIGHT): TextEntity {
  return { id: newId(), type: 'text', layer, color: 'ByLayer', position: pos, text: label, height, rotation: 0, align };
}
