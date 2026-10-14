import { describe, expect, it } from 'vitest';
import type { Point } from '../src/core/geometry';
import { compareFloatStrokeJoin, float32RoundoffBound, nativeFloatStrokeBound, type FloatStrokeDirection, type NativeFloatStrokeBound } from '../src/render/gpu-prototype/native-float-stroke-bound';

const view = { width: 1216, height: 552, dpr: 1, twist: 0 };
const accepted = (bound: NativeFloatStrokeBound, dpr = 1): boolean => bound.problem === null && bound.errorCss * dpr <= 0.0625;
const normal = (a: Point, b: Point): Point => { const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy); return { x: -dy / length, y: dx / length }; };
const dir = (angle: number, uncertainty = 0): FloatStrokeDirection => ({ normal: { x: Math.cos(angle), y: Math.sin(angle) }, degenerate: false, uncertainty });
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Independent ideal miter oracle used only after a stable branch is established. */
function offset(a: Point, b: Point, half: number): Point {
  const dot = 1 + a.x * b.x + a.y * b.y;
  return { x: half * (a.x + b.x) / dot, y: half * (a.y + b.y) / dot };
}

/** Pinned straight Skia arithmetic shape, with explicit IEEE float intermediates.
 * This independently exercises normalization, half-angle and miter evaluation;
 * it is a numerical oracle, not a claim of native raster/backend emulation.
 */
function floatMiter(points: readonly Point[], half: number): Point {
  const f = Math.fround, p = points.map((q) => ({ x: f(q.x), y: f(q.y) }));
  const unit = (a: Point, b: Point): Point => {
    const dx = f(b.x - a.x), dy = f(b.y - a.y), length = Math.sqrt(dx * dx + dy * dy);
    return { x: f(-dy / length), y: f(dx / length) };
  };
  const before = unit(p[0]!, p[1]!), after = unit(p[1]!, p[2]!);
  const dot = f(f(before.x * after.x) + f(before.y * after.y));
  const sinHalf = f(Math.sqrt(f(f(1 + dot) / 2)));
  const mid = dot < 0 ? { x: f(after.y - before.y), y: f(before.x - after.x) } : { x: f(before.x + after.x), y: f(before.y + after.y) };
  const desiredLength = f(f(half) / sinHalf), length = Math.sqrt(mid.x * mid.x + mid.y * mid.y);
  return { x: f(p[1]!.x + f(mid.x * (desiredLength / length))), y: f(p[1]!.y + f(mid.y * (desiredLength / length))) };
}

describe('native Float32 source construction certificate', () => {
  it('reproduces the audited width16 scale10 collapse before any pixel simulation', () => {
    const points = [{ x: 607.99999, y: 276 }, { x: 608, y: 276 }, { x: 608, y: 176 }];
    expect(points[0]).not.toEqual(points[1]);
    expect(Math.fround(points[0]!.x)).toBe(608);
    expect(Math.fround(points[1]!.x)).toBe(608);
    const bound = nativeFloatStrokeBound(points, points, false, 16, view, 1.25);
    expect(bound).toEqual({ errorCss: Infinity, problem: 'native float segment topology is unproved', failure: 'topology' });
    // The actual Intel audit observed native==independent LINE, stable repeat,
    // and 64 extra GPU green pixels below the butt cap. This test establishes
    // the input-cast refusal; it does not claim to emulate Skia rasterization.
  });

  it.each([0, 2 ** -149, 2 ** -126, 1, 255.999999, 256, 607.99999, 608, 8192, 1e12])('bounds every sampled IEEE cast up to magnitude %s', (magnitude) => {
    const bound = float32RoundoffBound(magnitude);
    for (let index = 0; index <= 400; index++) {
      const value = magnitude * (index / 200 - 1);
      expect(Math.abs(Math.fround(value) - value)).toBeLessThanOrEqual(bound);
    }
    expect(bound).toBeGreaterThan(0);
  });

  it('covers half-ULP ties, subnormals, ceiling binades and rejects float overflow', () => {
    expect(float32RoundoffBound(0)).toBe(2 ** -150);
    expect(float32RoundoffBound(1)).toBe(2 ** -24);
    expect(Math.abs(Math.fround(1 + 2 ** -24) - (1 + 2 ** -24))).toBe(float32RoundoffBound(1 + 2 ** -24));
    expect(float32RoundoffBound(2 - 2 ** -25)).toBe(2 ** -23);
    for (const value of [-1, NaN, Infinity, 2 ** 128]) expect(float32RoundoffBound(value)).toBe(Infinity);
  });

  it.each([1, 2, 3])('bounds readable glyph/block-like corners across scale, pan and widths at DPR%s', (dpr) => {
    for (const width of [1, 2.5, 16]) {
      const source = [{ x: 602.125, y: 283.375 }, { x: 608.125, y: 283.375 }, { x: 608.125, y: 269.125 }, { x: 614.25, y: 276.25 }];
      const bound = nativeFloatStrokeBound(source, source, false, width, { ...view, dpr }, 1.25);
      expect(accepted(bound, dpr)).toBe(true);
      // Uniform ratio and translation do not change ideal normals. Quantize
      // actual absolute painter CSS, independently of the certificate formula.
      for (const ratio of [0.8, 0.91, 1, 1.25]) for (const panX of [-128 / dpr, 0, 128 / dpr]) for (const panY of [-128 / dpr, 0, 128 / dpr]) {
        const ideal = source.map((p) => ({ x: 608 + (p.x - 608) * ratio + panX, y: 276 + (p.y - 276) * ratio + panY }));
        const actual = ideal.map((p) => ({ x: Math.fround(p.x), y: Math.fround(p.y) }));
        for (let index = 0; index < ideal.length; index++) expect(dist(ideal[index]!, actual[index]!)).toBeLessThanOrEqual(bound.errorCss);
        for (let index = 1; index < ideal.length; index++) {
          const a = normal(ideal[index - 1]!, ideal[index]!), b = normal(actual[index - 1]!, actual[index]!);
          expect(dist(a, b) * width / 2 + dist(ideal[index]!, actual[index]!)).toBeLessThanOrEqual(bound.errorCss);
          if (index > 1) {
            const previousIdeal = normal(ideal[index - 2]!, ideal[index - 1]!), previousActual = normal(actual[index - 2]!, actual[index - 1]!);
            expect(dist(offset(previousIdeal, a, width / 2), offset(previousActual, b, width / 2)) + dist(ideal[index - 1]!, actual[index - 1]!)).toBeLessThanOrEqual(bound.errorCss);
          }
        }
      }
    }
  });

  it('admits ordinary absoluteCSS glyph directions without a blanket 200x miter factor', () => {
    const camera = { ...view, width: 8192, height: 1024, dpr: 3 };
    const points = [{ x: 4096.125, y: 512.125 }, { x: 4102.125, y: 512.125 }, { x: 4102.125, y: 526.375 }];
    const bound = nativeFloatStrokeBound(points, points, false, 2.5, camera, 4);
    expect(accepted(bound, camera.dpr)).toBe(true);
    expect(bound.errorCss).toBeLessThan(0.01);
  });

  it('includes explicit Float32 normal, miter and absolute output evaluation at wide/DPR controls', () => {
    for (const dpr of [1, 2, 3]) for (const width of [1, 2.5, 16]) for (const theta of [0.2, 0.9, 1.7, 2.5, 2 * Math.acos(1 / 9)]) {
      const source = [{ x: 558.125, y: 276.125 }, { x: 608.125, y: 276.125 }, { x: 608.125 + Math.cos(theta) * 50, y: 276.125 + Math.sin(theta) * 50 }];
      const bound = nativeFloatStrokeBound(source, source, false, width, { ...view, dpr }, 1.25);
      expect(bound.problem).toBeNull();
      for (const ratio of [0.8, 1, 1.25]) for (const pan of [-128 / dpr, 0, 128 / dpr]) {
        const points = source.map((p) => ({ x: 608 + (p.x - 608) * ratio + pan, y: 276 + (p.y - 276) * ratio - pan }));
        const first = normal(points[0]!, points[1]!), last = normal(points[1]!, points[2]!);
        const m = offset(first, last, width / 2), expected = { x: points[1]!.x + m.x, y: points[1]!.y + m.y };
        expect(dist(expected, floatMiter(points, width / 2))).toBeLessThanOrEqual(bound.errorCss);
      }
    }
  });

  it.each([1.2, Math.fround(1.1) * Math.fround(1.25), Math.fround(1.1) * Math.fround(1.2)])('covers actual Float32 DPR coefficient %s over full pivot/cap interval extrema', (dpr) => {
    const nativeDpr = Math.fround(dpr);
    expect(nativeDpr).not.toBe(dpr);
    // Device-scale and page-zoom are independently Float32-compatible, while
    // their public double product need not be a Float32 matrix coefficient.
    const source = [{ x: 100_000.125, y: 276.125 }, { x: 101_000.125, y: 276.125 }];
    const camera = { ...view, dpr };
    for (const width of [1, 2.5, 16]) {
      const bound = nativeFloatStrokeBound(source, source, false, width, camera, 4);
      expect(bound.problem).toBeNull();
      for (const ratio of [0.8, 1, 1.25, 4]) for (const panX of [-128 / dpr, 128 / dpr]) for (const panY of [-128 / dpr, 128 / dpr]) {
        for (const p of source) for (const sign of [-1, 1]) {
          const css = { x: 608 + (p.x - 608) * ratio + panX, y: 276 + (p.y - 276) * ratio + panY };
          const ideal = { x: css.x * dpr, y: (css.y + sign * width / 2) * dpr };
          // Pinned Canvas: input point cast; CSS boundary storage; native DPR
          // coefficient cast; device output storage. No renderer implementation
          // or certificate formula is used in this independent coordinate oracle.
          const actual = { x: Math.fround(Math.fround(css.x) * nativeDpr), y: Math.fround(Math.fround(Math.fround(css.y) + sign * width / 2) * nativeDpr) };
          expect(dist(ideal, actual)).toBeLessThanOrEqual(bound.errorCss * dpr);
          const coefficientOnly = Math.abs(nativeDpr - dpr) * Math.hypot(css.x, css.y + sign * width / 2);
          expect(coefficientOnly).toBeLessThanOrEqual(bound.errorCss * dpr);
        }
      }
    }
  });

  it('admits ordinary fractional DPR glyphs and conservatively budgets the cast at remote zero points', () => {
    const dpr = 1.2, camera = { ...view, width: 8192, dpr };
    const glyph = [{ x: 4096.125, y: 512.125 }, { x: 4102.125, y: 512.125 }, { x: 4102.125, y: 526.375 }];
    expect(accepted(nativeFloatStrokeBound(glyph, glyph, false, 2.5, camera, 4), dpr)).toBe(true);
    // One original point still owns a full source certificate even with zero
    // emitted geometry; large-coordinate coefficient error cannot disappear.
    const remote = [{ x: 1_000_000, y: 0 }];
    const bound = nativeFloatStrokeBound(remote, remote, false, 16, { ...view, dpr }, 4);
    expect(bound.problem).toBeNull();
    expect(bound.errorCss).toBeGreaterThan(Math.abs(Math.fround(dpr) - dpr) * (608 + (remote[0]!.x - 608) * 4 + 128 / dpr + 80) / dpr);
    expect(accepted(bound, dpr)).toBe(false);
  });

  it.each([Number.MIN_VALUE, 2 ** -151, 2 ** -150, 2 ** 128, Number.MAX_VALUE])('refuses zero or nonfinite native Float32 DPR coefficient from finite input %s', (dpr) => {
    expect(Number.isFinite(dpr)).toBe(true);
    expect(nativeFloatStrokeBound([], [], false, 1, { ...view, dpr }, 1.25)).toMatchObject({ failure: 'topology', problem: 'native float DPR coefficient is unproved' });
  });

  it('accounts for native nearly-line omission within the same returned reserve', () => {
    const points = [{ x: 558, y: 276 }, { x: 608, y: 276 }, { x: 608 + 50 * Math.cos(0.02), y: 276 + 50 * Math.sin(0.02) }];
    expect(accepted(nativeFloatStrokeBound(points, points, false, 2.5, view, 1.25))).toBe(true);
    expect(accepted(nativeFloatStrokeBound(points, points, false, 16, view, 1.25))).toBe(false);
    const exact = [{ x: 558, y: 276 }, { x: 608, y: 276 }, { x: 658, y: 276 }];
    expect(accepted(nativeFloatStrokeBound(exact, exact, false, 16, view, 1.25))).toBe(true);
  });

  it('combines source displacement and float offsets inside the same .0625 reserve', () => {
    const local = [{ x: 603.125, y: 276.125 }, { x: 613.125, y: 276.125 }];
    const native = local.map((p) => ({ x: p.x + 0.04, y: p.y }));
    const bound = nativeFloatStrokeBound(local, native, false, 2.5, view, 1.25);
    expect(bound.errorCss).toBeGreaterThan(0.05);
    expect(accepted(bound)).toBe(true);
    expect(accepted(bound, 2)).toBe(false);
    // Fourfold admission can fail while a newly computed ordinary certificate
    // truly passes. Caller factories distinguish this from topology refusals.
    const shifted = local.map((p) => ({ x: p.x + 0.02, y: p.y }));
    expect(accepted(nativeFloatStrokeBound(local, shifted, false, 2.5, view, 4))).toBe(false);
    expect(accepted(nativeFloatStrokeBound(local, shifted, false, 2.5, view, 1.25))).toBe(true);
  });

  it('supports two-point caps and uses every offscreen original point', () => {
    const line = [{ x: 602.125, y: 276.125 }, { x: 614.125, y: 276.125 }];
    expect(accepted(nativeFloatStrokeBound(line, line, false, 16, view, 4))).toBe(true);
    const remote = [...line, { x: 1e12, y: 1e12 }];
    expect(accepted(nativeFloatStrokeBound(remote, remote, false, 16, view, 1.25))).toBe(false);
    expect(accepted(nativeFloatStrokeBound([remote[2]!], [remote[2]!], false, 1, view, 1.25))).toBe(false);
  });

  it('keeps matching leading/trailing zeros, refuses internal zeros and topology changes', () => {
    const a = { x: 608, y: 276 }, b = { x: 608, y: 266 }, c = { x: 618, y: 266 };
    for (const points of [[a, a, b], [a, b, b], [a, a, a]]) expect(accepted(nativeFloatStrokeBound(points, points, false, 4, view, 1.25))).toBe(true);
    for (const [points, closed] of [[[a, b, b, c], false], [[a, a, b], true]] as const) expect(nativeFloatStrokeBound(points, points, closed, 4, view, 1.25).problem).toMatch(/internal degenerate/);
    expect(nativeFloatStrokeBound([a, b], [a, a], false, 4, view, 1.25).problem).toMatch(/degeneracy changes/);
    const rectangle = [a, b, c, { x: 618, y: 276 }];
    expect(accepted(nativeFloatStrokeBound(rectangle, rectangle, true, 4, view, 1.25))).toBe(true);
  });

  it('refuses uncertain tiny directions at a pan pose even when the anchor float is nonzero', () => {
    const points = [{ x: 0, y: 0 }, { x: 1e-8, y: 0 }, { x: 1e-8, y: 10 }];
    expect(Math.fround(points[1]!.x)).not.toBe(Math.fround(points[0]!.x));
    expect(nativeFloatStrokeBound(points, points, false, 16, view, 1.25)).toMatchObject({ failure: 'precision', problem: 'native Float32 segment direction is unproved' });
  });

  it.each([0.001, 0.43, -0.63, Math.PI / 2])('distinctly refuses unproved native context rotation %s', (twist) => {
    const points = [{ x: 608, y: 276 }, { x: 618, y: 266 }];
    expect(nativeFloatStrokeBound(points, points, false, 2.5, { ...view, twist }, 1.25)).toMatchObject({ failure: 'topology', problem: 'native context rotation is unproved' });
  });

  it('proves stable miter and bevel on both sides of 10h while refusing uncertain boundaries', () => {
    for (const sign of [-1, 1]) for (const ratio of [8, 12]) {
      const a = dir(0, 1e-7), b = dir(sign * 2 * Math.acos(1 / ratio), 1e-7);
      expect(compareFloatStrokeJoin(a, b, a, b, 8).problem).toBeNull();
    }
    const at = dir(2 * Math.acos(0.1), 1e-5);
    expect(compareFloatStrokeJoin(dir(0, 1e-5), at, dir(0, 1e-5), at, 8).problem).toMatch(/miter limit/);
    const miter = dir(2 * Math.acos(1 / 9)), bevel = dir(2 * Math.acos(1 / 11));
    expect(compareFloatStrokeJoin(dir(0), miter, dir(0), bevel, 8).problem).toMatch(/branch changes/);
    expect(compareFloatStrokeJoin(dir(0), dir(Math.PI), dir(0), dir(Math.PI), 8).problem).toMatch(/near-reversal/);
  });

  it('compares smooth strip boundaries instead of an omitted zero offset', () => {
    const exact = dir(0), turned = dir(0.00001);
    const result = compareFloatStrokeJoin(exact, exact, exact, turned, 8);
    expect(result.problem).toBeNull();
    expect(result.errorCss).toBeGreaterThan(0);
    expect(result.errorCss).toBeLessThan(0.001);
  });

  it('rejects cold oversized, malformed and nonfinite source before traversing/allocating it', () => {
    const oversized = new Proxy([] as Point[], { get(_target, property) { if (property === 'length') return 1_000_001; throw new Error('should not traverse oversized source'); } });
    expect(nativeFloatStrokeBound(oversized, oversized, false, 1, view, 1.25).problem).toMatch(/work budget/);
    expect(nativeFloatStrokeBound([{ x: NaN, y: 0 }], [{ x: 0, y: 0 }], false, 1, view, 1.25).problem).toMatch(/nonfinite/);
    for (const ratio of [NaN, 0.99, 4.1]) expect(nativeFloatStrokeBound([], [], false, 1, view, ratio).problem).toMatch(/invalid/);
    expect(nativeFloatStrokeBound([{ x: 0, y: 0 }], [], false, 1, view, 1.25).problem).toMatch(/topology/);
  });
});
