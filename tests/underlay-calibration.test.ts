// P28 hygiene slice — section 5.4 calibration harness tests.
//
// The finish slice shipped the section 5.4 contrast post-process as the
// DECLARED CANDIDATE EQUATION, UNCALIBRATED: the Hub360 native
// calibration matrix was never supplied to the lane, and the
// deviation-reporting test awaited the matrix from the lead. This suite
// pins the harness that consumes such a matrix when it lands:
//
//   - the matrix input shape (per cell: scene id, cell id, candidate
//     value, native measured value);
//   - deviations computed against the shipped candidate equation —
//     candidate values are producible from the SHIPPED implementation
//     (adjustUnderlayPixels), never from a re-typed copy of the formula;
//   - the FAIL-CLOSED state: no matrix (or an empty one) reports
//     'matrix not supplied' — never a fabricated pass, never locally
//     invented values;
//   - every emitted report carries 'declared candidate equation,
//     uncalibrated'. NO AutoCAD parity is claimed anywhere.

import { describe, it, expect } from 'vitest';
import {
  candidateValueFor,
  computeCalibrationReport,
  formatCalibrationReport,
  type CalibrationMatrix,
} from '../src/app/underlay-calibration';

const MATRIX: CalibrationMatrix = {
  cells: [
    { sceneId: 'native-01', cellId: 'a', candidate: [0.5, 0.25, 0.75], native: [0.45, 0.3, 0.75] },
    { sceneId: 'native-01', cellId: 'b', candidate: [0.1, 0.1, 0.1], native: [0.1, 0.1, 0.1] },
    { sceneId: 'native-02', cellId: 'c', candidate: [0, 0, 0], native: [0.02, 0, 0] },
  ],
};

describe('section 5.4 calibration harness — fail-closed without a matrix', () => {
  it('undefined / null / empty matrix all report the matrix-not-supplied state', () => {
    for (const missing of [undefined, null, { cells: [] }] as const) {
      const report = computeCalibrationReport(missing);
      expect(report.state).toBe('matrix-not-supplied');
      expect(report.cellCount).toBe(0);
    }
  });

  it('the fail-closed report says so, carries the uncalibrated banner, and reports no deviations', () => {
    const text = formatCalibrationReport(computeCalibrationReport(undefined));
    expect(text).toContain('matrix not supplied');
    expect(text).toContain('declared candidate equation, uncalibrated');
    expect(text).toContain("x' = clamp01(bg + (x - bg) * s)");
    expect(text).not.toContain('deviation (');
    expect(text.toLowerCase()).not.toContain('calibrated against');
  });

  it('a malformed cell is refused at the boundary instead of fabricating deviations', () => {
    const bad = { cells: [{ sceneId: 's', cellId: 'x', candidate: [Number.NaN, 0, 0], native: [0, 0, 0] }] } as unknown as CalibrationMatrix;
    expect(() => computeCalibrationReport(bad)).toThrowError(/finite/);
  });
});

describe('section 5.4 calibration harness — deviation reporting', () => {
  it('computes per-cell deviations and aggregates against the supplied candidate values', () => {
    const report = computeCalibrationReport(MATRIX);
    expect(report.state).toBe('deviations-reported');
    if (report.state !== 'deviations-reported') return;
    expect(report.cellCount).toBe(3);
    const a = report.cells.find((c) => c.cellId === 'a')!;
    expect(a.deviation[0]).toBeCloseTo(0.05, 10);
    expect(a.deviation[1]).toBeCloseTo(-0.05, 10);
    expect(a.deviation[2]).toBeCloseTo(0, 10);
    expect(a.maxAbs).toBeCloseTo(0.05, 10);
    expect(report.maxAbsDeviation).toBeCloseTo(0.05, 10);
    expect(report.worstCell).toEqual({ sceneId: 'native-01', cellId: 'a' });
    expect(report.meanAbsDeviation).toBeCloseTo(0.12 / 9, 10);
    const scenes = new Map(report.scenes.map((s) => [s.sceneId, s]));
    expect(scenes.get('native-01')?.cells).toBe(2);
    expect(scenes.get('native-01')?.maxAbsDeviation).toBeCloseTo(0.05, 10);
    expect(scenes.get('native-02')?.cells).toBe(1);
    expect(scenes.get('native-02')?.maxAbsDeviation).toBeCloseTo(0.02, 10);
  });

  it('the formatted report names every cell, the aggregates, and stays uncalibrated', () => {
    const text = formatCalibrationReport(computeCalibrationReport(MATRIX));
    expect(text).toContain('declared candidate equation, uncalibrated');
    expect(text).toContain('cell native-01/a:');
    expect(text).toContain('cell native-02/c:');
    expect(text).toContain('max |dev| 0.050000 at native-01/a');
    expect(text.toLowerCase()).not.toContain('calibrated against');
    expect(text).not.toContain('matrix not supplied');
  });
});

describe('section 5.4 calibration harness — candidate values from the shipped equation', () => {
  it('identity posture returns the input pixel', () => {
    const got = candidateValueFor([0.2, 0.4, 0.6], { mono: false, background: [1, 1, 1] });
    expect(got[0]).toBeCloseTo(51 / 255, 12);
    expect(got[1]).toBeCloseTo(102 / 255, 12);
    expect(got[2]).toBeCloseTo(153 / 255, 12);
  });

  it('contrast scales about the declared background, with 8-bit quantisation as shipped', () => {
    // bg = 1, s = 0.5, x = 128/255 -> (1 + (128/255 - 1) * 0.5) * 255 = 191.5 -> 192.
    const got = candidateValueFor([128 / 255, 128 / 255, 128 / 255], { contrast: 50, mono: false, background: [1, 1, 1] });
    expect(got[0]).toBeCloseTo(192 / 255, 12);
    expect(got[1]).toBeCloseTo(192 / 255, 12);
    expect(got[2]).toBeCloseTo(192 / 255, 12);
  });

  it('out-of-range results clamp to [0, 1]', () => {
    // bg = 1, s = 2, x = 0 -> 1 + (0 - 1) * 2 = -1 -> clamp01 = 0.
    const got = candidateValueFor([0, 0, 0], { contrast: 200, mono: false, background: [1, 1, 1] });
    expect(got).toEqual([0, 0, 0]);
  });

  it('mono reduces via Rec. 601 before contrast, as shipped', () => {
    // L = 0.299 * 1 = 0.299 -> byte round(0.299 * 255) = 76 on every channel.
    const got = candidateValueFor([1, 0, 0], { contrast: 100, mono: true, background: [0, 0, 0] });
    expect(got[0]).toBeCloseTo(76 / 255, 12);
    expect(got[1]).toBeCloseTo(76 / 255, 12);
    expect(got[2]).toBeCloseTo(76 / 255, 12);
  });
});
