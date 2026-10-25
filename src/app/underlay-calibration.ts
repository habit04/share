/**
 * Section 5.4 calibration harness (P28 hygiene slice): the
 * deviation-reporting consumer for the native calibration matrix — the
 * matrix the finish slice never received (Hub360; it is the lead's to
 * supply). The shipped post-process in underlay-adjust.ts implements
 * the DECLARED CANDIDATE EQUATION
 *   x' = clamp01(bg + (x - bg) * s),  s = contrast / 100
 * and this harness changes NOTHING about it: it only measures how far
 * the equation's values sit from native measurements, cell by cell.
 *
 * FAIL-CLOSED: with no matrix supplied (or an empty one) the report is
 * the explicit 'matrix not supplied' state — no deviations are
 * computed, no values are invented locally, and no calibration verdict
 * is issued. Every report, in every state, carries the banner
 * 'declared candidate equation, uncalibrated'. NO AutoCAD parity is
 * claimed anywhere in this lane; whether a reported deviation field is
 * acceptable is the lead's call when a real matrix lands.
 */
import { adjustUnderlayPixels, type UnderlayAdjustStyle } from './underlay-adjust';

/** An RGB triple with channels in [0, 1]. */
export type Rgb01 = readonly [number, number, number];

/** The section 5.4 candidate equation, verbatim as shipped. */
export const CALIBRATION_EQUATION = "x' = clamp01(bg + (x - bg) * s)";
/** The honesty banner every calibration report carries until a real matrix lands. */
export const CALIBRATION_BANNER = 'declared candidate equation, uncalibrated';

/**
 * One cell of the native calibration matrix: an identified scene cell,
 * the candidate equation's value for it, and the native measured value
 * for the same cell. Both values are supplied BY the matrix — this
 * harness invents neither (candidate values for a matrix are produced
 * with candidateValueFor below, i.e. by the shipped implementation).
 */
export interface CalibrationMatrixCell {
  readonly sceneId: string;
  readonly cellId: string;
  readonly candidate: Rgb01;
  readonly native: Rgb01;
}

/** The matrix input shape: a flat cell list; scenes group by sceneId. */
export interface CalibrationMatrix {
  readonly cells: readonly CalibrationMatrixCell[];
}

/** A cell with its deviation: candidate - native, per channel. */
export interface CalibrationCellDeviation {
  readonly sceneId: string;
  readonly cellId: string;
  readonly candidate: Rgb01;
  readonly native: Rgb01;
  readonly deviation: Rgb01;
  readonly maxAbs: number;
}

export interface CalibrationSceneSummary {
  readonly sceneId: string;
  readonly cells: number;
  readonly maxAbsDeviation: number;
  readonly meanAbsDeviation: number;
}

export type CalibrationReport =
  | {
      readonly state: 'matrix-not-supplied';
      readonly cellCount: 0;
    }
  | {
      readonly state: 'deviations-reported';
      readonly cellCount: number;
      readonly cells: readonly CalibrationCellDeviation[];
      readonly scenes: readonly CalibrationSceneSummary[];
      readonly maxAbsDeviation: number;
      readonly meanAbsDeviation: number;
      readonly worstCell: { readonly sceneId: string; readonly cellId: string };
    };

/**
 * The candidate equation's value for one input pixel, computed by the
 * SHIPPED implementation (adjustUnderlayPixels on a 1x1 raster) — the
 * only sanctioned way to produce candidate values for a matrix, so the
 * harness measures the code that actually ships, never a re-typed
 * formula. Quantisation is the shipped one: 8-bit in, 8-bit out.
 */
export function candidateValueFor(input: Rgb01, style: UnderlayAdjustStyle): Rgb01 {
  const byte = (c: number): number => Math.round(Math.max(0, Math.min(1, c)) * 255);
  const rgba = new Uint8ClampedArray([byte(input[0]), byte(input[1]), byte(input[2]), 255]);
  const out = adjustUnderlayPixels(rgba, 1, 1, style);
  return [out[0]! / 255, out[1]! / 255, out[2]! / 255];
}

const checkCell = (cell: CalibrationMatrixCell): void => {
  for (const triple of [cell.candidate, cell.native]) {
    for (const v of triple) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(
          `calibration matrix cell ${cell.sceneId}/${cell.cellId}: channel values must be finite numbers`,
        );
      }
    }
  }
};

/**
 * Compute the deviation report for a supplied matrix. Absent or empty
 * matrices FAIL CLOSED into the 'matrix-not-supplied' state. A supplied
 * matrix yields deviations only — this function issues no pass/fail
 * verdict on the equation, in any state.
 */
export function computeCalibrationReport(matrix: CalibrationMatrix | undefined | null): CalibrationReport {
  if (!matrix || matrix.cells.length === 0) {
    return { state: 'matrix-not-supplied', cellCount: 0 };
  }
  const cells: CalibrationCellDeviation[] = [];
  const sceneOrder: string[] = [];
  const sceneCells = new Map<string, CalibrationCellDeviation[]>();
  let absSum = 0;
  let maxAbsDeviation = 0;
  let worstCell = { sceneId: '', cellId: '' };
  for (const cell of matrix.cells) {
    checkCell(cell);
    const deviation: Rgb01 = [
      cell.candidate[0] - cell.native[0],
      cell.candidate[1] - cell.native[1],
      cell.candidate[2] - cell.native[2],
    ];
    const maxAbs = Math.max(Math.abs(deviation[0]), Math.abs(deviation[1]), Math.abs(deviation[2]));
    const measured: CalibrationCellDeviation = {
      sceneId: cell.sceneId, cellId: cell.cellId,
      candidate: cell.candidate, native: cell.native, deviation, maxAbs,
    };
    cells.push(measured);
    absSum += Math.abs(deviation[0]) + Math.abs(deviation[1]) + Math.abs(deviation[2]);
    if (maxAbs >= maxAbsDeviation) {
      maxAbsDeviation = maxAbs;
      worstCell = { sceneId: cell.sceneId, cellId: cell.cellId };
    }
    let bucket = sceneCells.get(cell.sceneId);
    if (!bucket) {
      bucket = [];
      sceneCells.set(cell.sceneId, bucket);
      sceneOrder.push(cell.sceneId);
    }
    bucket.push(measured);
  }
  const scenes: CalibrationSceneSummary[] = sceneOrder.map((sceneId) => {
    const members = sceneCells.get(sceneId)!;
    let sceneAbs = 0;
    let sceneMax = 0;
    for (const m of members) {
      sceneAbs += Math.abs(m.deviation[0]) + Math.abs(m.deviation[1]) + Math.abs(m.deviation[2]);
      sceneMax = Math.max(sceneMax, m.maxAbs);
    }
    return {
      sceneId,
      cells: members.length,
      maxAbsDeviation: sceneMax,
      meanAbsDeviation: sceneAbs / (members.length * 3),
    };
  });
  return {
    state: 'deviations-reported',
    cellCount: cells.length,
    cells,
    scenes,
    maxAbsDeviation,
    meanAbsDeviation: absSum / (cells.length * 3),
    worstCell,
  };
}

const f6 = (v: number): string => v.toFixed(6);
const fSigned = (v: number): string => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(6)}`;
const fTriple = (t: Rgb01): string => `(${f6(t[0])}, ${f6(t[1])}, ${f6(t[2])})`;
const fSignedTriple = (t: Rgb01): string => `(${fSigned(t[0])}, ${fSigned(t[1])}, ${fSigned(t[2])})`;

/**
 * Render a report as deterministic plain text. The header — equation
 * plus the uncalibrated banner plus the no-parity line — is emitted in
 * EVERY state, including the fail-closed one.
 */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    'P28 section 5.4 contrast calibration - deviation report',
    `Equation: ${CALIBRATION_EQUATION} - ${CALIBRATION_BANNER}`,
    'No AutoCAD parity is claimed.',
  ];
  if (report.state === 'matrix-not-supplied') {
    lines.push('Status: matrix not supplied - calibration NOT performed (fail-closed). No deviations are reported and no calibration verdict is issued.');
    return lines.join('\n');
  }
  lines.push(
    `Status: matrix supplied - ${report.cellCount} cells across ${report.scenes.length} scenes. `
    + 'Deviations of the candidate values from the native measurements follow; '
    + `the equation remains a ${CALIBRATION_BANNER}.`,
  );
  for (const scene of report.scenes) {
    lines.push(`scene ${scene.sceneId}: cells ${scene.cells}, max |dev| ${f6(scene.maxAbsDeviation)}, mean |dev| ${f6(scene.meanAbsDeviation)}`);
  }
  for (const cell of report.cells) {
    lines.push(
      `cell ${cell.sceneId}/${cell.cellId}: candidate ${fTriple(cell.candidate)} native ${fTriple(cell.native)} `
      + `deviation ${fSignedTriple(cell.deviation)} maxAbs ${f6(cell.maxAbs)}`,
    );
  }
  lines.push(
    `overall: max |dev| ${f6(report.maxAbsDeviation)} at ${report.worstCell.sceneId}/${report.worstCell.cellId}, `
    + `mean |dev| ${f6(report.meanAbsDeviation)}`,
  );
  return lines.join('\n');
}
