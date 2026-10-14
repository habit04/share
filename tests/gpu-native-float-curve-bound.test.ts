import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point } from '../src/core/geometry';
import { nativeFloatCurveBound } from '../src/render/gpu-prototype/native-float-curve-bound';

const view = { width: 1216, height: 552, dpr: 1, twist: 0 };
const units = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0.6, y: 0.8 }, { x: -0.8, y: 0.6 }];
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Independent pinned parameter pipeline, with actual Float32 L/T/R/B,
 * float width/2, and double-midpoint-then-float reconstruction. This is NOT
 * native arc angle/conic/stroker/raster emulation.
 */
function nativeOval(center: Point, radius: number) {
  const f = Math.fround, cx = f(center.x), cy = f(center.y), r = f(radius);
  const left = f(cx - r), right = f(cx + r), top = f(cy - r), bottom = f(cy + r);
  return { center: { x: f((left + right) / 2), y: f((top + bottom) / 2) }, rx: f(f(right - left) / 2), ry: f(f(bottom - top) / 2), edges: [left, top, right, bottom] };
}

afterEach(() => vi.restoreAllMocks());

describe('parameter-only native Float32 CIRCLE/ARC construction bound', () => {
  it('refuses the original and shifted direct ARC source alias without invoking native painting', () => {
    const original = { x: 608 - 40_000_000, y: 276 }, alias = { x: original.x - 0.75, y: 276 }, radius = 40_000_000;
    const tuple = (center: Point) => [Math.fround(center.x), Math.fround(center.y), Math.fround(radius), Math.fround(0), Math.fround(-2e-6), true];
    expect(tuple(original)).toEqual(tuple(alias));
    expect(original.x + radius - (alias.x + radius)).toBe(0.75);
    expect(0.75).toBeGreaterThan(2 * 0.25); // Same native tuple cannot preserve both ideal endpoints.
    for (const center of [original, alias]) for (const options of [{}, { minRatio: 1, panPhysical: 0 }]) {
      const bound = nativeFloatCurveBound(center, radius, 16, view, options.minRatio ? 1 : 1.25, options);
      expect(bound.scope).toBe('center-radius-oval');
      expect(bound.failure).toBe('precision');
      expect(bound.problem).toBe('native float curve parameters exceed precision budget');
      expect(bound.errorCss).toBeGreaterThan(0.0625);
    }
    // The separate native audit had a stable shifted-case mismatch, but baseline
    // repeat drift made the pair inconclusive. This test proves the source alias
    // and conservative parameter refusal, not a paired native acceptance result.
  });

  it('guards radius aliases and offscreen parameters even when a visible endpoint is near the pivot', () => {
    const center = { x: 608 - 40_000_000, y: 276 }, a = 40_000_000, b = a + 0.75;
    expect(Math.fround(a)).toBe(Math.fround(b));
    expect(center.x + b - (center.x + a)).toBe(0.75);
    for (const radius of [a, b]) expect(nativeFloatCurveBound(center, radius, 2.5, view, 1.25).problem).toMatch(/precision budget/);
    expect(nativeFloatCurveBound({ x: 1e12, y: -1e12 }, 10, 1, view, 1.25).problem).toMatch(/oval topology|precision budget/);
  });

  it.each([1, 1.2, 1.25, 2, 3])('retains ordinary positive-width parameters and covers interval/pan/DPR reconstruction at DPR%s', (dpr) => {
    const camera = { ...view, dpr };
    for (const radius of [4, 10.3, 50, 100]) for (const width of [1, 2.5, 16]) for (const uncertainty of [0, 0.0625 / dpr]) {
      const center = { x: 608.125, y: 276.25 };
      const bound = nativeFloatCurveBound(center, radius, width, camera, 1.25, { nativeParameterUncertaintyCss: uncertainty });
      expect(bound).toMatchObject({ scope: 'center-radius-oval', problem: null, failure: null });
      expect(bound.errorCss * dpr).toBeLessThanOrEqual(0.0625);
      for (const ratio of [0.8, 1, 1.25]) for (const panX of [-128 / Math.max(1, dpr), 128 / Math.max(1, dpr)]) for (const panY of [-128 / Math.max(1, dpr), 128 / Math.max(1, dpr)]) for (const perturbation of [-uncertainty, uncertainty]) {
        // Compare Float32 construction against its actual unrounded native
        // parameters. The pre-existing world reserve owns perturbation itself.
        const nativeCenter = { x: 608 + (center.x - 608) * ratio + panX + perturbation, y: 276 + (center.y - 276) * ratio + panY - perturbation };
        const nativeRadius = radius * ratio + perturbation;
        const oval = nativeOval(nativeCenter, nativeRadius);
        for (const unit of units) for (const sign of [-1, 1]) {
          const n = { x: unit.x / oval.rx, y: unit.y / oval.ry }, length = Math.hypot(n.x, n.y);
          const normal = { x: n.x / length, y: n.y / length };
          const half = Math.fround(width) / 2;
          const ideal = { x: (nativeCenter.x + nativeRadius * unit.x + sign * width / 2 * unit.x) * dpr, y: (nativeCenter.y + nativeRadius * unit.y + sign * width / 2 * unit.y) * dpr };
          const nativeDpr = Math.fround(dpr);
          const actual = {
            x: Math.fround(Math.fround(oval.center.x + oval.rx * unit.x + sign * half * normal.x) * nativeDpr),
            y: Math.fround(Math.fround(oval.center.y + oval.ry * unit.y + sign * half * normal.y) * nativeDpr),
          };
          expect(distance(ideal, actual)).toBeLessThanOrEqual(bound.errorCss * dpr);
        }
      }
    }
  });

  it('accounts for the cast oval becoming elliptical and for changed stroke normals', () => {
    const center = { x: 4096.123, y: 511.234 }, radius = 0.03137;
    const oval = nativeOval(center, radius);
    expect(oval.rx).not.toBe(oval.ry);
    const narrow = nativeFloatCurveBound(center, radius, 1, { ...view, width: 8192 }, 1.25);
    const wide = nativeFloatCurveBound(center, radius, 16, { ...view, width: 8192 }, 1.25);
    expect(wide.errorCss).toBeGreaterThan(narrow.errorCss);
    expect(wide.problem).toMatch(/precision budget/);
  });

  it('inflates compiled native parameter domains without charging the world reserve twice', () => {
    const center = { x: 608.125, y: 276.25 }, radius = 50;
    const direct = nativeFloatCurveBound(center, radius, 2.5, view, 1.25);
    const compiled = nativeFloatCurveBound(center, radius, 2.5, view, 1.25, { nativeParameterUncertaintyCss: 0.0625 });
    expect(direct.problem).toBeNull(); expect(compiled.problem).toBeNull();
    expect(compiled.errorCss).toBeGreaterThanOrEqual(direct.errorCss);
    expect(compiled.errorCss).toBeLessThan(0.01);
    expect(compiled.errorCss).toBeLessThan(0.0625);
  });

  it('deducts actual parameter construction from each existing tessellation allowance', () => {
    for (const dpr of [1, 1.2, 2, 3]) {
      const bound = nativeFloatCurveBound({ x: 608.123, y: 276.234 }, 75.123, 16, { ...view, dpr }, 1.25);
      expect(bound.problem).toBeNull();
      const construction = bound.errorCss * dpr;
      expect(construction).toBeGreaterThan(0);
      const direct = 0.1875 - construction, compiled = 0.125 - construction, legacy = 0.25 - construction;
      expect(direct).toBeGreaterThan(0); expect(compiled).toBeGreaterThan(0); expect(legacy).toBeGreaterThan(0);
      expect(direct + construction + 0.0625).toBeLessThanOrEqual(0.25);
      expect(compiled + construction + 0.0625 + 0.0625).toBeLessThanOrEqual(0.25);
      expect(legacy + construction).toBeLessThanOrEqual(0.25);
    }
  });

  it('uses full original parameters without mutation or any trigonometric evaluation', () => {
    const center = Object.freeze({ x: 608.125, y: 276.25 }), before = JSON.stringify(center);
    const sin = vi.spyOn(Math, 'sin'), cos = vi.spyOn(Math, 'cos'), tan = vi.spyOn(Math, 'tan');
    expect(nativeFloatCurveBound(center, 50, 2.5, view, 1.25).problem).toBeNull();
    expect(JSON.stringify(center)).toBe(before);
    expect(sin).not.toHaveBeenCalled(); expect(cos).not.toHaveBeenCalled(); expect(tan).not.toHaveBeenCalled();
    expect(nativeFloatCurveBound(center, 1e12, 2.5, view, 1.25).problem).toMatch(/precision budget/);
  });

  it('refuses unproved zero/underflow/overflow radius, oval and coefficient domains explicitly', () => {
    for (const radius of [0, 2 ** -151, Number.MIN_VALUE]) expect(nativeFloatCurveBound({ x: 608, y: 276 }, radius, 1, view, 1.25)).toMatchObject({ failure: 'topology', problem: 'native float curve radius is unproved' });
    expect(nativeFloatCurveBound({ x: 608, y: 276 }, 1e38, 1, view, 4).problem).toMatch(/oval topology|construction is unproved/);
    expect(nativeFloatCurveBound({ x: 1e12, y: 1e12 }, 1e-5, 1, view, 1.25).problem).toBe('native float curve oval topology is unproved');
    for (const dpr of [Number.MIN_VALUE, 2 ** 128]) expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, { ...view, dpr }, 1.25).problem).toBe('native float DPR coefficient is unproved');
  });

  it('explicitly refuses unsupported rotation and malformed parameter domains', () => {
    expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, { ...view, twist: 0.4 }, 1.25)).toMatchObject({ scope: 'center-radius-oval', failure: 'topology', problem: 'native context rotation is unproved' });
    for (const width of [0, -1, Infinity]) expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, width, view, 1.25).problem).toMatch(/invalid/);
    for (const radius of [-1, NaN, Infinity]) expect(nativeFloatCurveBound({ x: 608, y: 276 }, radius, 1, view, 1.25).problem).toMatch(/invalid/);
    for (const maxRatio of [0.9, 4.1, Infinity]) expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, view, maxRatio).problem).toMatch(/invalid/);
    expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, view, 1.25, { minRatio: 0.7 }).problem).toMatch(/invalid/);
    expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, view, 1.25, { panPhysical: 129 }).problem).toMatch(/invalid/);
    expect(nativeFloatCurveBound({ x: 608, y: 276 }, 50, 1, view, 1.25, { nativeParameterUncertaintyCss: -1 }).problem).toMatch(/invalid/);
  });
});
