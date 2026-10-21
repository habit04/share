import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { ArcEntity, PolylineEntity } from '../src/core/entities';
import {
  dimensionGeometry,
  dimensionMeasurement,
  dimensionText,
  STANDARD_DIMSTYLE,
  type DimensionEntity,
} from '../src/core/dimension';
import { polar } from '../src/core/geometry';
import { readDxf, writeDxf } from '../src/io/dxf';

const center = { x: 0, y: 0 };
const measure = (text: string, height: number) => text.length * height * 0.6;
const angular = (extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: 'angular',
  layer: '0',
  color: 'ByLayer',
  type: 'dimension',
  kind: 'angular',
  center,
  p1: { x: 5, y: 0 },
  p2: { x: 0, y: 5 },
  linePoint: polar(center, Math.PI / 4, 10),
  rotation: 0,
  style: STANDARD_DIMSTYLE,
  ...extra,
});
const arcs = (d: DimensionEntity, width = measure) => dimensionGeometry(d, width).filter((p): p is ArcEntity => p.type === 'arc');
const arrowheads = (d: DimensionEntity) => dimensionGeometry(d, measure).filter((p): p is PolylineEntity => p.type === 'polyline');

describe('angular dimension endpoint compatibility', () => {
  it.each([
    ['first', true, false, { x: 0, y: 10 }],
    ['second', false, true, { x: 10, y: 0 }],
  ] as const)('suppresses the %s dimension arc and arrow while keeping text and extension lines', (_label, suppressDimLine1, suppressDimLine2, tip) => {
    const d = angular({ style: { ...STANDARD_DIMSTYLE, suppressDimLine1, suppressDimLine2 } });
    const parts = dimensionGeometry(d, measure);
    expect(arrowheads(d)).toHaveLength(1);
    expect(arrowheads(d)[0]!.points[0]!.x).toBeCloseTo(tip.x);
    expect(arrowheads(d)[0]!.points[0]!.y).toBeCloseTo(tip.y);
    expect(parts.filter((p) => p.type === 'line')).toHaveLength(2);
    expect(parts.find((p) => p.type === 'text')).toBeDefined();
    expect(arcs(d)).toHaveLength(1);
    if (suppressDimLine1) expect(arcs(d)[0]!.startAngle).toBeGreaterThan(Math.PI / 4);
    else expect(arcs(d)[0]!.endAngle).toBeLessThan(Math.PI / 4);
  });

  it('suppresses both dimension arc halves and both arrows independently of extension lines and text', () => {
    const d = angular({ style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true, suppressDimLine2: true } });
    const parts = dimensionGeometry(d, measure);
    expect(arcs(d)).toHaveLength(0);
    expect(arrowheads(d)).toHaveLength(0);
    expect(parts.filter((p) => p.type === 'line')).toHaveLength(2);
    expect(parts.filter((p) => p.type === 'text')).toHaveLength(1);
    expect(dimensionText(d)).toBe('90%%d');
  });

  it('keeps distinct arrowheads on the original first and second legs when the selected arc reverses their order', () => {
    const d = angular({
      linePoint: polar(center, Math.PI, 10),
      style: { ...STANDARD_DIMSTYLE, arrow: 'dot', arrow2: 'closed-filled' },
    });
    const parts = dimensionGeometry(d, measure);
    const dot = parts.find((p) => p.type === 'circle');
    expect(dot?.type).toBe('circle');
    if (dot?.type === 'circle') {
      expect(dot.center.x).toBeCloseTo(10);
      expect(dot.center.y).toBeCloseTo(0);
    }
    expect(arrowheads(d)[0]!.points[0]!.x).toBeCloseTo(0);
    expect(arrowheads(d)[0]!.points[0]!.y).toBeCloseTo(10);
    expect(dimensionMeasurement(d)).toBeCloseTo(3 * Math.PI / 2);
  });

  it('keeps first-leg suppression on the original first leg when the selected arc reverses its order', () => {
    const d = angular({
      linePoint: polar(center, Math.PI, 10),
      style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true },
    });
    expect(arrowheads(d)).toHaveLength(1);
    expect(arrowheads(d)[0]!.points[0]!.x).toBeCloseTo(0);
    expect(arrowheads(d)[0]!.points[0]!.y).toBeCloseTo(10);
    expect(arcs(d)).toHaveLength(1);
    expect(arcs(d)[0]!.startAngle).toBeCloseTo(Math.PI / 2);
    expect(arcs(d)[0]!.endAngle).toBeLessThan(5 * Math.PI / 4);
  });

  it('applies suppression between the defining leg and user-moved text on the arc', () => {
    const textPosition = polar(center, Math.PI / 9, 10);
    const d = angular({ textPosition, style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true } });
    expect(arcs(d)).toHaveLength(1);
    expect(arcs(d)[0]!.startAngle).toBeGreaterThan(Math.PI / 9);
    expect(arcs(d)[0]!.startAngle).toBeLessThan(Math.PI / 4);
    expect(dimensionGeometry(d, measure).find((p) => p.type === 'text')?.text).toBe('90%%d');
  });

  it.each([0.1, Math.PI / 2 - 0.1])('clips a moved text gap to both blank-arrow backoffs at angle %s', (angle) => {
    const d = angular({
      textPosition: polar(center, angle, 10),
      style: { ...STANDARD_DIMSTYLE, arrow: 'closed-blank', arrowSize: 2 },
    });
    const parts = arcs(d, () => 0.1);
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      expect(p.startAngle).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(p.endAngle).toBeLessThanOrEqual(Math.PI / 2 - 0.2 + 1e-9);
      expect(p.endAngle).toBeGreaterThan(p.startAngle);
    }
  });

  it('retains first-leg suppression for a sweep crossing zero degrees', () => {
    const d = angular({
      p1: polar(center, -Math.PI / 18, 5),
      p2: polar(center, Math.PI / 18, 5),
      linePoint: { x: 10, y: 0 },
      style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true },
    });
    expect(arrowheads(d)).toHaveLength(1);
    expect(arrowheads(d)[0]!.points[0]!.x).toBeCloseTo(10 * Math.cos(Math.PI / 18));
    expect(arrowheads(d)[0]!.points[0]!.y).toBeCloseTo(10 * Math.sin(Math.PI / 18));
    expect(arcs(d)).toHaveLength(1);
    expect(arcs(d)[0]!.startAngle).toBeGreaterThan(0);
    expect(arcs(d)[0]!.endAngle).toBeCloseTo(Math.PI / 18);
  });
});

describe('angular dimension DXF import, edit and reopen', () => {
  it('retains style suppression, defining legs and measurement through undo/redo and native DIMENSION export', () => {
    // This native DXF fixture is a genuine AutoCAD 2027 R2018 save (it replaced a hand-authored
    // synthetic of the same name in the fixture swap); it is not generated by JCad's writer.
    const fixture = readFileSync(join(__dirname, 'fixtures', 'interchange', 'r2018-dimensions.dxf'), 'utf8');
    const doc = new Drawing(readDxf(fixture));
    const original = doc.entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.kind === 'angular')!;
    expect(original).toBeDefined();
    const edited = { ...original, style: { ...original.style, suppressDimLine1: true, suppressDimLine2: false } };
    doc.replaceEntities([edited]);
    expect(doc.dirty).toBe(true);
    expect(arrowheads(doc.entity(original.id) as DimensionEntity)).toHaveLength(1);
    doc.undo();
    expect((doc.entity(original.id) as DimensionEntity).style).toEqual(original.style);
    doc.redo();
    expect((doc.entity(original.id) as DimensionEntity).style).toEqual(edited.style);
    const exported = writeDxf(doc.snapshot);
    expect(exported).toContain('AcDb3PointAngularDimension');
    const reopened = readDxf(exported).entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.kind === 'angular')!;
    expect(reopened.style.suppressDimLine1).toBe(true);
    expect(reopened.style.suppressDimLine2).toBe(false);
    expect(reopened.p1.x).toBeCloseTo(original.p1.x, 8);
    expect(reopened.p1.y).toBeCloseTo(original.p1.y, 8);
    expect(reopened.p2.x).toBeCloseTo(original.p2.x, 8);
    expect(reopened.p2.y).toBeCloseTo(original.p2.y, 8);
    expect(dimensionMeasurement(reopened)).toBeCloseTo(dimensionMeasurement(original));
    expect(dimensionText(reopened)).toBe(dimensionText(original));
    expect(arrowheads(reopened)).toHaveLength(1);
    expect(arcs(reopened)).toHaveLength(1);
  });
});
