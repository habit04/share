import { describe, it, expect } from 'vitest';
import type { HatchEntity } from '../src/core/entities';
import { Drawing } from '../src/core/document';
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

  it('still derives the effective scale when the lines disagree with group 41 (ISO ANSI31)', () => {
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
