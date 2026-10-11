import { describe, expect, it } from 'vitest';
import { clampedUniformKnots, nurbsPoints, splineSamplePlan, splineWorkProblem, type NurbsCurve } from '../src/core/spline';

const curve = (degree: number, controlCount = degree + 1): NurbsCurve => ({
  degree,
  knots: clampedUniformKnots(controlCount, degree),
  controlPoints: Array.from({ length: controlCount }, (_, i) => ({ x: i, y: i % 2 })),
});

describe('shared integer spline sampling plan', () => {
  it('uses an integer rate and uniform parameters for fractional requests', () => {
    const c = curve(2);
    const plan = splineSamplePlan(c, 64.1)!;
    expect(plan).toEqual({ spanCount: 1, stepsPerSpan: 65, sampleCount: 66 });
    const points = nurbsPoints(c, 64.1);
    expect(points).toHaveLength(plan.sampleCount);
    expect(points[1]!.x).toBeCloseTo(2 / 65, 12);
    expect(points.at(-1)).toEqual(c.controlPoints.at(-1));
  });

  it('floors fractional per-span caps and counts only nonempty knot spans', () => {
    const c = { ...curve(2, 5), knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1] };
    for (const cap of [11, 11.999999999, 12]) {
      const plan = splineSamplePlan(c, 64.1, cap)!;
      expect(plan).toEqual({ spanCount: 2, stepsPerSpan: cap < 12 ? 5 : 6, sampleCount: cap < 12 ? 11 : 13 });
      expect(nurbsPoints(c, 64.1, cap)).toHaveLength(plan.sampleCount);
    }
  });

  it('keeps degree-one curves minimal and retains the existing minimum sampling', () => {
    const line = curve(1, 4);
    expect(splineSamplePlan(line, 100.5, 0.1)).toEqual({ spanCount: 3, stepsPerSpan: 1, sampleCount: 4 });
    expect(nurbsPoints(line, 100.5, 0.1)).toEqual(line.controlPoints);
    const c = curve(2, 4);
    for (const cap of [-1, 0, 1.99]) {
      expect(splineSamplePlan(c, -0.5, cap)).toEqual({ spanCount: 2, stepsPerSpan: 2, sampleCount: 5 });
      expect(nurbsPoints(c, -0.5, cap)).toHaveLength(5);
    }
  });

  it('rejects the actual rounded-up work at a fractional degree-work boundary', () => {
    const c = curve(170);
    expect(splineWorkProblem(c, 0, {}, 67)).toBeUndefined();
    expect(nurbsPoints(c, 67)).toHaveLength(68);
    for (const rate of [67.00000000001, 67.1, 67.999999999]) {
      expect(splineSamplePlan(c, rate)).toEqual({ spanCount: 1, stepsPerSpan: 68, sampleCount: 69 });
      expect(splineWorkProblem(c, 0, {}, rate)).toContain('69 samples');
      expect(nurbsPoints(c, rate)).toEqual(c.controlPoints);
    }
    expect(splineWorkProblem(c, 0, {}, 100.1, 67.9)).toBeUndefined();
    expect(nurbsPoints(c, 100.1, 67.9)).toHaveLength(68);
  });

  it('permits exactly the work budget and rejects the next integer sample', () => {
    const c = curve(9);
    expect(splineSamplePlan(c, 19999, 20000)?.sampleCount).toBe(20000);
    expect(splineWorkProblem(c, 0, {}, 19999, 20000)).toBeUndefined();
    expect(nurbsPoints(c, 19999, 20000)).toHaveLength(20000);
    expect(splineWorkProblem(c, 0, {}, 19999.01, 20000)).toContain('20001 samples');
    expect(nurbsPoints(c, 19999.01, 20000)).toEqual(c.controlPoints);
  });

  it('falls back before looping for nonfinite or unsafe sampling limits', () => {
    const c = curve(2);
    for (const [rate, cap] of [[NaN, 4000], [Infinity, 4000], [16, NaN], [16, Infinity], [1e308, 1e308]]) {
      expect(splineSamplePlan(c, rate, cap)).toBeUndefined();
      expect(splineWorkProblem(c, 0, {}, rate, cap)).toContain('sampling limits');
      expect(nurbsPoints(c, rate, cap)).toEqual(c.controlPoints);
    }
  });
});
