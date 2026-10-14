/** Upright screen-space labels for the fixed-size WCS orientation triad. */
import { type Vec3, dot3, v3 } from '../model3d/math';
import { type Camera3D, cameraBasis } from './camera';
import type { Segment2 } from './markers';
import type { Rgba } from './scene-data';

/** Corner triad size and inset, in CSS pixels. */
export const TRIAD_PX = 76;
export const TRIAD_PAD_PX = 10;

export const AXIS_TRIAD: readonly { readonly name: 'X' | 'Y' | 'Z'; readonly direction: Vec3; readonly color: Rgba }[] = [
  { name: 'X', direction: v3(1, 0, 0), color: [0.95, 0.3, 0.3, 1] },
  { name: 'Y', direction: v3(0, 1, 0), color: [0.35, 0.9, 0.35, 1] },
  { name: 'Z', direction: v3(0, 0, 1), color: [0.4, 0.55, 1, 1] },
];

/** Letters use the existing line pipeline: no font loading or extra canvas is needed. */
const GLYPHS: Readonly<Record<'X' | 'Y' | 'Z', readonly Segment2[]>> = {
  X: [[-4, -6, 4, 6], [-4, 6, 4, -6]],
  Y: [[-4, -6, 0, 0], [4, -6, 0, 0], [0, 0, 0, 6]],
  Z: [[-4, -6, 4, -6], [4, -6, -4, 6], [-4, 6, 4, 6]],
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

export interface AxisTriadLabel {
  readonly name: 'X' | 'Y' | 'Z';
  readonly color: Rgba;
  /** Upright stroke segments, CSS pixels relative to the triad square's top-left. */
  readonly segments: readonly Segment2[];
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + gap
    && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + gap;
}

/** Whether a projected axis enters the label's padded rectangle. */
function crossesBox(x0: number, y0: number, x1: number, y1: number, box: Box, gap: number): boolean {
  let lo = 0, hi = 1;
  for (const [start, end, center, half] of [[x0, x1, box.x, box.halfWidth], [y0, y1, box.y, box.halfHeight]]) {
    const delta = end! - start!, min = center! - half! - gap, max = center! + half! + gap;
    if (Math.abs(delta) < 1e-12) {
      if (start! < min || start! > max) return false;
    } else {
      const a = (min - start!) / delta, b = (max - start!) / delta;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
      if (lo > hi) return false;
    }
  }
  return true;
}

/**
 * Labels follow camera orientation only, like the orthographic [-1.3, 1.3] axis projection.
 * A bounded candidate search keeps letters separate even when projected axis tips coincide.
 * End-on axes remain labelled near the origin instead of disappearing with their short line.
 */
export function axisTriadLabels(camera: Camera3D, size = TRIAD_PX): readonly AxisTriadLabel[] {
  const scale = Math.min(1, size / TRIAD_PX), margin = scale, gap = 2 * scale;
  const halfWidth = 4 * scale, halfHeight = 6 * scale, center = size / 2;
  const basis = cameraBasis(camera);
  const tips = AXIS_TRIAD.map(axis => ({
    x: center + dot3(axis.direction, basis.right) * size / 2.6,
    y: center - dot3(axis.direction, basis.up) * size / 2.6,
  }));
  const occupied: Box[] = [];
  const clamp = (x: number, y: number): Box => ({
    x: Math.max(margin + halfWidth, Math.min(size - margin - halfWidth, x)),
    y: Math.max(margin + halfHeight, Math.min(size - margin - halfHeight, y)),
    halfWidth, halfHeight,
  });
  return AXIS_TRIAD.map((axis, index) => {
    const tip = tips[index]!;
    const dx = tip.x - center, dy = tip.y - center, length = Math.hypot(dx, dy);
    // Stable upper-right offset also makes an exactly end-on axis visible.
    const ux = length > 0.5 * scale ? dx / length : Math.SQRT1_2;
    const uy = length > 0.5 * scale ? dy / length : -Math.SQRT1_2;
    const distance = 3 * scale + halfWidth * Math.abs(ux) + halfHeight * Math.abs(uy);
    const ideal = clamp(tip.x + ux * distance, tip.y + uy * distance);
    const candidates: Box[] = [ideal];
    for (const oy of [-2, -1, 0, 1, 2]) {
      for (const ox of [-2, -1, 0, 1, 2]) candidates.push(clamp(ideal.x + ox * (2 * halfWidth + gap), ideal.y + oy * (2 * halfHeight + gap)));
    }
    // Fixed 9x9 fallback grid: bounded independently of camera angles and viewport resolution.
    for (let row = 0; row <= 8; row++) {
      for (let col = 0; col <= 8; col++) {
        candidates.push(clamp(margin + halfWidth + (size - 2 * (margin + halfWidth)) * col / 8,
          margin + halfHeight + (size - 2 * (margin + halfHeight)) * row / 8));
      }
    }
    let best = ideal, bestCost = Infinity;
    for (const candidate of candidates) {
      if (occupied.some(box => overlaps(candidate, box, gap))) continue;
      const intersections = tips.filter(point => crossesBox(center, center, point.x, point.y, candidate, scale)).length;
      const cost = (candidate.x - ideal.x) ** 2 + (candidate.y - ideal.y) ** 2 + intersections * size ** 2;
      if (cost < bestCost) { best = candidate; bestCost = cost; }
    }
    occupied.push(best);
    return {
      name: axis.name, color: axis.color,
      segments: GLYPHS[axis.name].map(([x1, y1, x2, y2]) => [
        best.x + x1 * scale, best.y + y1 * scale, best.x + x2 * scale, best.y + y2 * scale,
      ] as const),
    };
  });
}
