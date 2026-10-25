/**
 * Canonical raster post-process for underlay rasters (P28 finish, design
 * section 5.3 + addendum A.2: Q4 CLOSED as Option B). ONE pure function of
 * the RAW raster: screen and plot consume the same derived pixels, and fade
 * is NOT applied here (fade stays a draw-time alpha at both consumers).
 *
 * The contrast equation is the DECLARED CANDIDATE
 *   x' = clamp01(bg + (x - bg) * s),  s = contrast / 100
 * with mono reduction (Rec. 601: L = 0.299R + 0.587G + 0.114B) applied
 * BEFORE contrast scaling, about the declared target background `bg`,
 * alpha untouched. It is calibrated against the native reference matrix
 * only when that matrix is supplied; until then every report calls it
 * "declared candidate equation, uncalibrated". NO AutoCAD parity claim is
 * made anywhere in this lane.
 */

export interface UnderlayAdjustStyle {
  /** Placement contrast 0..100; undefined = the identity posture (s = 1). */
  readonly contrast?: number;
  /** Monochrome flag (UNDERLAY_FLAG_MONOCHROME via the caller). */
  readonly mono: boolean;
  /** Declared target background, per channel, 0..1 (screen surface or paper). */
  readonly background: readonly [number, number, number];
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Returns a NEW buffer with the adjustment applied; the input (the raw
 * raster's pixels) is never mutated — the raw raster stays canonical and
 * every style/background variant derives from it.
 */
export function adjustUnderlayPixels(
  rgba: Uint8ClampedArray,
  _width: number,
  _height: number,
  style: UnderlayAdjustStyle,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const s = style.contrast === undefined ? 1 : style.contrast / 100;
  if (s === 1 && !style.mono) return out;
  const [bgR, bgG, bgB] = style.background;
  for (let i = 0; i + 3 < out.length; i += 4) {
    let r = out[i]! / 255;
    let g = out[i + 1]! / 255;
    let b = out[i + 2]! / 255;
    if (style.mono) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l; g = l; b = l;
    }
    out[i] = clamp255((bgR + (r - bgR) * s) * 255);
    out[i + 1] = clamp255((bgG + (g - bgG) * s) * 255);
    out[i + 2] = clamp255((bgB + (b - bgB) * s) * 255);
    // alpha (i + 3) untouched by construction
  }
  return out;
}

/** The cache-key fragment for a style: identity is the absence of contrast + mono. */
export function underlayStyleKey(style: { contrast?: number; mono: boolean }): string {
  return `${style.contrast ?? 'id'}:${style.mono ? 'mono' : 'colour'}`;
}

/** The cache-key fragment for a declared target background (per channel, 1/255 quantised). */
export function underlayBackgroundKey(background: readonly [number, number, number]): string {
  return background.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(',');
}
