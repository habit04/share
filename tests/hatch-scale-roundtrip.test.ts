import { describe, it, expect } from 'vitest';
import type { HatchEntity } from '../src/core/entities';
import { Drawing, type DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

// Regression (Hub task 74757b90): a hatch's pattern scale drifted across a
// read -> write -> read round trip (1 came back as 0.9999999995). The read
// path derives the model scale from the stored pattern definition lines
// (fitPatternToLines: len(file offset) / len(table offset)), while the writer
// emits those line offsets at the file-wide write precision of 10 DECIMAL
// places — for small offset components (~0.09) that is ~5e-10 relative noise,
// which the derivation fed straight back into the scale, even though the
// file's own group 41 carried the exact declared scale all along.
// The declared group-41 scale is authoritative: when the geometry-derived
// scale agrees with it within the fit tolerance, the model keeps the declared
// value exactly, so the scale round-trips bit-for-bit.

// ANSI31's table line: angle 45, origin (0,0), offset (0, 0.125). A file
// stores the world line: offset rotated by (line angle + hatch angle).
const worldOffset = (scale: number, hatchAngleDeg: number) => {
  const a = ((45 + hatchAngleDeg) * Math.PI) / 180;
  const x = 0;
  const y = 0.125 * scale;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};

const dxfFor = (scale: number, hatchAngleDeg = 0) => {
  const o = worldOffset(scale, hatchAngleDeg);
  return [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'HATCH', '8', '0', '100', 'AcDbEntity', '100', 'AcDbHatch', '10', '0', '20', '0', '30', '0', '2', 'ANSI31', '70', '0', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50', '97', '0',
    '75', '0', '76', '1', '52', String(hatchAngleDeg), '41', String(scale), '77', '0',
    '78', '1', '53', '45', '43', '0', '44', '0', '45', String(o.x), '46', String(o.y), '79', '0',
    '98', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
};

const roundTrip = (h: HatchEntity): HatchEntity =>
  readDxf(writeDxf({ ...new Drawing().snapshot, entities: [h] })).entities[0] as HatchEntity;

describe('HATCH pattern scale round trip (74757b90)', () => {
  it.each([1, 2.5, 0.3048])('scale %s survives read + write + read exactly', (scale) => {
    const first = readDxf(dxfFor(scale)).entities[0] as HatchEntity;
    expect(first.patternLines).toBeUndefined(); // fitted to the named pattern, not kept raw
    expect(first.scale).toBe(scale);
    const second = roundTrip(first);
    expect(second.scale).toBe(scale);
    const third = roundTrip(second);
    expect(third.scale).toBe(scale);
  });

  it('a rotated hatch (angle 30) also keeps its declared scale exactly', () => {
    const first = readDxf(dxfFor(2.5, 30)).entities[0] as HatchEntity;
    expect(first.scale).toBe(2.5);
    expect(roundTrip(first).scale).toBe(2.5);
  });

  it('still derives the effective scale when the lines disagree with group 41 (ISO ANSI31, no $MEASUREMENT)', () => {
    // Declared scale 1, but the definition lines carry the ISO spacing
    // (3.175 units): the derived 25.4 must win — it is nowhere near the
    // declared value, so the declared-value preference must not engage.
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'HATCH', '8', '0', '100', 'AcDbHatch', '2', 'ANSI31', '70', '0', '71', '0', '91', '1',
      '92', '2', '72', '0', '73', '1', '93', '4', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50', '97', '0',
      '75', '0', '76', '1', '52', '0', '41', '1', '77', '0', '78', '1', '53', '45', '43', '0', '44', '0', '45', '-2.2450640303', '46', '2.2450640303', '79', '0',
      '98', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const h = readDxf(dxf).entities[0] as HatchEntity;
    expect(h.scale).toBeCloseTo(25.4, 6);
    expect(h.patternLines).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Metric drawings ($MEASUREMENT = 1): the pattern definitions in the file are
// the ISO (millimetre) ones — ANSI31's stored line spacing at scale 1 is
// 3.175 drawing units, 25.4x the imperial table JCad fits against. The model
// scale stays the geometric multiplier on the imperial table, but group 41 is
// expressed in the DRAWING's measurement system: a metric ANSI31 authored at
// 41 = 1 must be written back as 41 = 1 (at 5370ef1 it comes back 25.4, and
// AutoCAD's HATCHEDIT then regenerates the hatch 25.4x too coarse).

/** A DXF with a $MEASUREMENT header and one ANSI31 hatch whose stored lines
 *  are the ISO lines for the declared scale (spacing 3.175 x scale). */
const dxfMetricFor = (scale: number, measurement = 1, fixed10 = false) => {
  const o = worldOffset(scale * 25.4, 0);
  const fmt = (n: number) => (fixed10 ? n.toFixed(10) : String(n));
  return [
    '0', 'SECTION', '2', 'HEADER', '9', '$MEASUREMENT', '70', String(measurement), '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'HATCH', '8', '0', '100', 'AcDbEntity', '100', 'AcDbHatch', '10', '0', '20', '0', '30', '0', '2', 'ANSI31', '70', '0', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50', '97', '0',
    '75', '0', '76', '1', '52', '0', '41', String(scale), '77', '0',
    '78', '1', '53', '45', '43', '0', '44', '0', '45', fmt(o.x), '46', fmt(o.y), '79', '0',
    '98', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
};

/** The group-41 value of the first HATCH in a written DXF. */
const writtenHatch41 = (state: DrawingState): number => {
  const lines = writeDxf(state).split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === '0' && lines[i + 1] === 'HATCH') {
      for (let j = i + 2; j + 1 < lines.length && lines[j] !== '0'; j += 2) {
        if (lines[j] === '41') return Number(lines[j + 1]);
      }
    }
  }
  throw new Error('no HATCH group 41 in written DXF');
};

/** The group-41 TEXT of the first HATCH in a written DXF (precision matters). */
const writtenHatch41Text = (state: DrawingState): string => {
  const lines = writeDxf(state).split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === '0' && lines[i + 1] === 'HATCH') {
      for (let j = i + 2; j + 1 < lines.length && lines[j] !== '0'; j += 2) {
        if (lines[j] === '41') return lines[j + 1]!;
      }
    }
  }
  throw new Error('no HATCH group 41 in written DXF');
};

/** A DXF with a $MEASUREMENT = 1 header and one ANSI31 hatch whose stored
 *  lines are the IMPERIAL table lines for the declared scale (spacing
 *  0.125 x scale): a hatch authored in table space inside a metric drawing.
 *  On read it folds at exactly the declared scale (branch 1 of the fit); the
 *  save re-expresses its group 41 in the file's system (scale / 25.4). */
const dxfMetricImperialFor = (scale: number) => {
  const o = worldOffset(scale, 0);
  return [
    '0', 'SECTION', '2', 'HEADER', '9', '$MEASUREMENT', '70', '1', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'HATCH', '8', '0', '100', 'AcDbEntity', '100', 'AcDbHatch', '10', '0', '20', '0', '30', '0', '2', 'ANSI31', '70', '0', '71', '0', '91', '1',
    '92', '2', '72', '0', '73', '1', '93', '4', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50', '97', '0',
    '75', '0', '76', '1', '52', '0', '41', String(scale), '77', '0',
    '78', '1', '53', '45', '43', '0', '44', '0', '45', String(o.x), '46', String(o.y), '79', '0',
    '98', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
};

describe('HATCH pattern scale in metric drawings ($MEASUREMENT = 1)', () => {
  it('keeps $MEASUREMENT in the drawing header, and only when the source has it', () => {
    expect(readDxf(dxfMetricFor(1)).header?.measurement).toBe(1);
    expect(readDxf(dxfFor(1)).header?.measurement).toBeUndefined();
    expect(writeDxf(readDxf(dxfMetricFor(1)))).toContain('$MEASUREMENT');
  });

  it('a metric ANSI31 at 41 = 1 is written back as 41 = 1 across two round trips', () => {
    const first = readDxf(dxfMetricFor(1));
    const h1 = first.entities[0] as HatchEntity;
    // The model scale is geometric (imperial-table space): the ISO lines sit
    // at 25.4x the table, snapped to exactly the declared value x 25.4.
    expect(h1.scale).toBe(25.4);
    expect(h1.patternLines).toBeUndefined();
    expect(writtenHatch41(first)).toBe(1);
    const second = readDxf(writeDxf(first));
    expect((second.entities[0] as HatchEntity).scale).toBe(25.4);
    expect(writtenHatch41(second)).toBe(1);
  });

  it('a metric ANSI31 at 41 = 2 (genuine metric scale) is written back as 41 = 2', () => {
    const first = readDxf(dxfMetricFor(2));
    expect((first.entities[0] as HatchEntity).scale).toBe(50.8);
    expect(writtenHatch41(first)).toBe(2);
    const second = readDxf(writeDxf(first));
    expect(writtenHatch41(second)).toBe(2);
  });

  it('metric ISO lines stored at 10-decimal precision still snap to the declared scale', () => {
    const first = readDxf(dxfMetricFor(1, 1, true));
    expect((first.entities[0] as HatchEntity).scale).toBe(25.4);
    expect(writtenHatch41(first)).toBe(1);
  });

  it.each([1, 2])('an imperial-authored hatch at scale %s in a metric drawing round-trips exactly (P3)', (scale) => {
    const first = readDxf(dxfMetricImperialFor(scale));
    const h1 = first.entities[0] as HatchEntity;
    expect(first.header?.measurement).toBe(1);
    // Authored in table space: folds at exactly the declared scale.
    expect(h1.scale).toBe(scale);
    expect(h1.patternLines).toBeUndefined();
    // The save re-expresses 41 in the file's system (scale / 25.4). Written
    // through the file-wide 10-decimal format that text is 0.0393700787 for
    // scale 1, and branch 2 of the fit multiplies it back by 25.4:
    // 0.0393700787 x 25.4 = 0.99999999898 — the re-read scale drifted off the
    // authored value, breaking the declared-value exactness the imperial
    // path guarantees. The metric 41 must be written at full precision.
    const second = readDxf(writeDxf(first));
    const h2 = second.entities[0] as HatchEntity;
    expect(h2.scale).toBe(scale);
    expect(h2.patternLines).toBeUndefined();
    // Fixed point: the second save writes the identical 41 text and the
    // scale is still exact after another full cycle.
    expect(writtenHatch41Text(second)).toBe(writtenHatch41Text(first));
    expect((readDxf(writeDxf(second)).entities[0] as HatchEntity).scale).toBe(scale);
  });

  it('$MEASUREMENT = 0 keeps the imperial rule: ISO-spaced lines at 41 = 1 still derive 25.4', () => {
    const state = readDxf(dxfMetricFor(1, 0));
    const h = state.entities[0] as HatchEntity;
    expect(h.scale).toBeCloseTo(25.4, 6);
    expect(h.patternLines).toBeUndefined();
    expect(writtenHatch41(state)).toBeCloseTo(25.4, 6);
  });
});
