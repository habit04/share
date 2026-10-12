import type { Point } from './geometry';
import * as g from './geometry';

/** Native TEXT/ATTDEF/ATTRIB modes (DXF 72 and 73/74). */
export interface TextJustification {
  readonly horizontal: 0 | 1 | 2 | 3 | 4 | 5;
  readonly vertical: 0 | 1 | 2 | 3;
}

export interface TextPlacement {
  /** Editing anchor: insertion point for left/FIT/ALIGNED, alignment point otherwise. */
  readonly position: Point;
  /** Original DXF10 when the editing anchor is DXF11. */
  readonly firstAlignmentPoint?: Point;
  readonly height: number;
  readonly rotation?: number;
  readonly align: 'left' | 'center' | 'right';
  readonly widthFactor?: number;
  readonly oblique?: number;
  readonly justification?: TextJustification;
  /** Native second alignment point (DXF 11), including a valid (0,0). */
  readonly alignmentPoint?: Point;
}

export function textJustification(horizontal: number, vertical: number): TextJustification {
  return { horizontal: horizontal as TextJustification['horizontal'], vertical: vertical as TextJustification['vertical'] };
}

/** Resolve native anchors for a renderer's own font measurement, without changing source data. */
export function placedText<T extends TextPlacement & { readonly text: string }>(t: T, measure: (text: string, height: number) => number): T & { rotation: number } {
  if (!t.justification) return { ...t, rotation: t.rotation ?? 0 };
  const { horizontal: h, vertical: v } = t.justification;
  const { justification: _justification, alignmentPoint: _alignmentPoint, ...plain } = t;
  let height = t.height;
  let widthFactor = t.widthFactor ?? 1;
  let rotation = t.rotation ?? 0;
  let position = h === 3 || h === 5 ? t.position : t.alignmentPoint ?? t.position;
  const align = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
  if ((h === 3 || h === 5) && t.alignmentPoint) {
    const dx = t.alignmentPoint.x - t.position.x;
    const dy = t.alignmentPoint.y - t.position.y;
    const span = Math.hypot(dx, dy);
    const width = measure(t.text, height) * widthFactor;
    rotation = Math.atan2(dy, dx);
    if (width > 0) {
      if (h === 3) height *= span / width;
      else widthFactor *= span / width;
    }
  }
  // Height-based vertical placement deliberately keeps the existing approximate font metrics.
  const drop = h === 4 || v === 2 ? height / 2 : v === 3 ? height : 0;
  if (drop) position = { x: position.x + Math.sin(rotation) * drop, y: position.y - Math.cos(rotation) * drop };
  return { ...plain, position, height, widthFactor, rotation, align } as T & { rotation: number };
}

export function textPlacementProblem(t: TextPlacement): string | null {
  if (t.widthFactor !== undefined && !(t.widthFactor > 0)) return 'TEXT width factor must be positive';
  const j = t.justification;
  if (!j) return null;
  if (!Number.isInteger(j.horizontal) || j.horizontal < 0 || j.horizontal > 5 || !Number.isInteger(j.vertical) || j.vertical < 0 || j.vertical > 3 || (j.horizontal > 2 && j.vertical !== 0)) return 'invalid TEXT justification modes';
  if (j.horizontal === 3 || j.horizontal === 5) {
    if (!t.alignmentPoint) return 'aligned/fit TEXT is missing its second alignment point';
    const span = Math.hypot(t.alignmentPoint.x - t.position.x, t.alignmentPoint.y - t.position.y);
    if (!(span > 0) || !Number.isFinite(span)) return 'aligned/fit TEXT needs a finite, nonzero alignment span';
  }
  return null;
}

/** Move both native anchors; used by transforms and insertion-point grips. */
export function transformedTextAnchors<T extends TextPlacement>(t: T, tf: (p: Point) => Point): T {
  return { ...t, position: tf(t.position), ...(t.alignmentPoint ? { alignmentPoint: tf(t.alignmentPoint) } : {}), ...(t.firstAlignmentPoint ? { firstAlignmentPoint: tf(t.firstAlignmentPoint) } : {}) };
}

/** Text remains readable under MIRRTEXT=0, while native justification follows the reflected anchor. */
export function reflectedTextJustification(j: TextJustification | undefined): TextJustification | undefined {
  if (!j || j.horizontal > 2) return j;
  return { ...j, horizontal: j.horizontal === 0 ? 2 : j.horizontal === 2 ? 0 : 1 };
}

export function textAnchor(t: TextPlacement): Point {
  return t.justification && (t.justification.horizontal !== 0 || t.justification.vertical !== 0) && t.justification.horizontal !== 3 && t.justification.horizontal !== 5 ? t.alignmentPoint ?? t.position : t.position;
}

/** Transform text axes as well as its anchors through a positive, nonuniform block scale. */
export function scaledText<T extends TextPlacement>(t: T, tf: (p: Point) => Point, rotation: number, sx: number, sy: number, mirror = false): T {
  const a = t.rotation ?? 0;
  const u = { x: sx * Math.cos(a), y: sy * Math.sin(a) };
  const v = { x: -sx * Math.sin(a), y: sy * Math.cos(a) };
  const xScale = Math.hypot(u.x, u.y);
  const yScale = Math.abs(sx * sy) / xScale;
  const slant = Math.tan(t.oblique ?? 0) * xScale / yScale + g.dot(u, v) / (xScale * yScale);
  const widthFactor = (t.widthFactor ?? 1) * xScale / yScale;
  return {
    ...transformedTextAnchors(t, tf),
    height: t.height * yScale,
    rotation: g.normAngle(Math.atan2(u.y, u.x) + rotation),
    ...(Math.abs(widthFactor - 1) > 1e-12 || t.widthFactor !== undefined ? { widthFactor } : {}),
    ...(Math.abs(slant) > 1e-12 || t.oblique !== undefined ? { oblique: Math.atan(slant) } : {}),
    ...(mirror ? { align: t.align === 'left' ? 'right' : t.align === 'right' ? 'left' : t.align, ...(t.justification ? { justification: reflectedTextJustification(t.justification) } : {}) } : {}),
  };
}
