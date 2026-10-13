/**
 * Screen-space markers drawn over the 3D view (experimental, milestone 4): the 2D object-snap
 * marker shapes (src/render/viewport.ts `drawSnapMarker`: square = endpoint, triangle = midpoint,
 * circle = center, hourglass = nearest) at a snapped 3D point, and grip squares like the 2D grips
 * (filled, dark outline). Pure: the shapes are line segments in device pixels (x right, y down),
 * so they are tested in Node; Viewport3D draws them with its line program in a pixel projection.
 */
import type { Rgba } from './scene-data';

/** A segment in device pixels: x1, y1, x2, y2. */
export type Segment2 = readonly [number, number, number, number];

/** Marker shapes understood by `markerSegments`. */
export type MarkerKind = 'endpoint' | 'midpoint' | 'center' | 'nearest';

/** Snap marker colour (the 2D default `snapMarkerColor` #3ff23f). */
export const SNAP_MARKER_RGBA: Rgba = [0x3f / 255, 0xf2 / 255, 0x3f / 255, 1];
/** Grip fill (the 2D default `gripColor` #1a3dff) and outline (#0b0b0b). */
export const GRIP_FILL_RGBA: Rgba = [0x1a / 255, 0x3d / 255, 1, 1];
export const GRIP_EDGE_RGBA: Rgba = [0x0b / 255, 0x0b / 255, 0x0b / 255, 1];

function polygon(pts: readonly (readonly [number, number])[]): Segment2[] {
  return pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return [p[0], p[1], q[0], q[1]] as const;
  });
}

/** The outline of a snap marker of radius `r` px centred at (x, y). */
export function markerSegments(kind: MarkerKind, x: number, y: number, r: number): Segment2[] {
  switch (kind) {
    case 'endpoint':
      return polygon([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]]);
    case 'midpoint':
      return polygon([[x, y - r], [x + r, y + r], [x - r, y + r]]);
    case 'center': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 20; i++) pts.push([x + r * Math.cos((i * Math.PI) / 10), y + r * Math.sin((i * Math.PI) / 10)]);
      return polygon(pts);
    }
    case 'nearest':
      return polygon([[x - r, y - r], [x + r, y + r], [x - r, y + r], [x + r, y - r]]);
  }
}

/**
 * A filled grip square of half-size `h` px at (x, y): horizontal fill lines one device pixel apart
 * (`fill`) and the outline (`edge`).
 */
export function gripSegments(x: number, y: number, h: number): { fill: Segment2[]; edge: Segment2[] } {
  const cx = Math.round(x), cy = Math.round(y);
  const fill: Segment2[] = [];
  for (let k = -h; k <= h; k++) fill.push([cx - h, cy + k + 0.5, cx + h, cy + k + 0.5]);
  return { fill, edge: polygon([[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]) };
}
