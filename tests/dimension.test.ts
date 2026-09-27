import { describe, it, expect } from 'vitest';
import type { DimensionEntity, Entity, TextEntity } from '../src/core/entities';
import { dimensionParts, entityBounds, gripPoints, moveGrip, textWidth } from '../src/core/entities';
import { STANDARD_DIMSTYLE, ISO25_DIMSTYLE, dimensionMeasurement, dimensionText, dimensionGeometry } from '../src/core/dimension';
import { Drawing } from '../src/core/document';
import { writeDxf, readDxf } from '../src/io/dxf';
import { fakeContext, drive } from './fake-context';
import { dimLinearTool, dimAlignedTool, dimRadiusTool, dimDiameterTool, dimAngularTool } from '../src/tools/dimension';

const lookup = () => undefined;
const base = { id: 'd1', layer: 'DIM', color: 'ByLayer' as const, type: 'dimension' as const, style: STANDARD_DIMSTYLE };

describe('dimension geometry', () => {
  const linear: DimensionEntity = { ...base, kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 4, y: 1 }, linePoint: { x: 2, y: 3 }, rotation: 0 };

  it('measures along the dimension direction and formats text with DIMDEC', () => {
    expect(dimensionMeasurement(linear)).toBeCloseTo(4);
    expect(dimensionText(linear)).toBe('4.0000');
    expect(dimensionText({ ...linear, rotation: Math.PI / 2 })).toBe('1.0000');
    expect(dimensionText({ ...linear, text: 'L=<>' })).toBe('L=4.0000');
    expect(dimensionText({ ...linear, text: ' ' })).toBe('');
    expect(dimensionText({ ...linear, style: ISO25_DIMSTYLE })).toBe('4.00');
  });

  it('builds extension lines, a broken dimension line, two arrowheads and centred text', () => {
    const parts = dimensionGeometry(linear, textWidth);
    const lines = parts.filter((p) => p.type === 'line');
    const arrows = parts.filter((p) => p.type === 'polyline' && p.filled);
    const text = parts.find((p): p is TextEntity => p.type === 'text')!;
    expect(arrows).toHaveLength(2);
    expect(text.text).toBe('4.0000');
    expect(text.align).toBe('center');
    // extension lines start DIMEXO above the origins and end DIMEXE past the dimension line at y = 3
    const ext = lines.filter((l) => Math.abs(l.a.x - l.b.x) < 1e-9);
    expect(ext).toHaveLength(2);
    for (const l of ext) {
      const lo = Math.min(l.a.y, l.b.y);
      const hi = Math.max(l.a.y, l.b.y);
      expect(hi).toBeCloseTo(3 + STANDARD_DIMSTYLE.extExtend);
      expect(lo).toBeCloseTo(l.a.x < 1 ? STANDARD_DIMSTYLE.extOffset : 1 + STANDARD_DIMSTYLE.extOffset);
    }
    // dimension line pieces on y = 3, broken around the text
    const dimLine = lines.filter((l) => Math.abs(l.a.y - 3) < 1e-9 && Math.abs(l.b.y - 3) < 1e-9);
    expect(dimLine).toHaveLength(2);
    const covered = dimLine.reduce((s, l) => s + Math.abs(l.b.x - l.a.x), 0);
    expect(covered).toBeLessThan(4);
    expect(covered).toBeGreaterThan(4 - textWidth('4.0000', 0.18) - 2 * STANDARD_DIMSTYLE.textGap - 1e-9);
    // arrow tips sit at the ends of the dimension line
    const tips = arrows.map((a) => (a.type === 'polyline' ? a.points[0]! : { x: 0, y: 0 }));
    expect(tips.map((t) => t.x).sort((a, b) => a - b)).toEqual([0, 4]);
  });

  it('flips text so it reads left to right', () => {
    const rev: DimensionEntity = { ...linear, p1: { x: 4, y: 0 }, p2: { x: 0, y: 0 }, rotation: Math.PI };
    const text = dimensionGeometry(rev, textWidth).find((p): p is TextEntity => p.type === 'text')!;
    expect(Math.abs(Math.sin(text.rotation))).toBeLessThan(1e-9);
    expect(Math.cos(text.rotation)).toBeCloseTo(1);
  });

  it('puts arrows outside when the points are too close', () => {
    const tiny: DimensionEntity = { ...linear, p2: { x: 0.1, y: 0 }, linePoint: { x: 0, y: 1 } };
    const parts = dimensionGeometry(tiny, textWidth);
    const arrows = parts.filter((p) => p.type === 'polyline');
    // tips at the ends; bodies point away from the gap
    const [a, b] = arrows as unknown as Array<{ points: { x: number }[] }>;
    expect(a!.points[1]!.x).toBeLessThan(a!.points[0]!.x);
    expect(b!.points[1]!.x).toBeGreaterThan(b!.points[0]!.x);
  });

  it('aligned dimensions measure point to point', () => {
    const al: DimensionEntity = { ...base, kind: 'aligned', p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 }, linePoint: { x: -1, y: 3 }, rotation: 0 };
    expect(dimensionText(al)).toBe('5.0000');
    const text = dimensionGeometry(al, textWidth).find((p): p is TextEntity => p.type === 'text')!;
    expect(text.rotation).toBeCloseTo(Math.atan2(4, 3));
  });

  it('radius and diameter dimensions use R and %%c prefixes and a centre mark when outside', () => {
    const r: DimensionEntity = { ...base, kind: 'radius', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 }, linePoint: { x: 1, y: 0.5 }, rotation: 0 };
    expect(dimensionText(r)).toBe('R2.0000');
    const inside = dimensionGeometry(r, textWidth);
    expect(inside.filter((p) => p.type === 'polyline')).toHaveLength(1);
    const d: DimensionEntity = { ...r, kind: 'diameter', linePoint: { x: 4, y: 1 } };
    expect(dimensionText(d)).toBe('%%c4.0000');
    const outside = dimensionGeometry(d, textWidth);
    // leader + landing + 2 centre-mark lines
    expect(outside.filter((p) => p.type === 'line').length).toBe(4);
    expect(outside.find((p) => p.type === 'text')!.type).toBe('text');
  });

  it('angular dimensions draw an arc and degrees text', () => {
    const a: DimensionEntity = { ...base, kind: 'angular', p1: { x: 2, y: 0 }, p2: { x: 0, y: 2 }, center: { x: 0, y: 0 }, linePoint: { x: 1, y: 1 }, rotation: 0 };
    expect(dimensionText(a)).toBe('90%%d');
    const parts = dimensionGeometry(a, textWidth);
    const arcs = parts.filter((p) => p.type === 'arc');
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    expect(parts.filter((p) => p.type === 'polyline')).toHaveLength(2);
    // the arc passes by linePoint: radius sqrt(2)
    if (arcs[0]!.type === 'arc') expect(arcs[0]!.radius).toBeCloseTo(Math.SQRT2);
  });

  it('bounds, grips and grip editing cover dimensions', () => {
    const b = entityBounds(linear, lookup)!;
    expect(b.max.y).toBeGreaterThan(3);
    expect(b.min.y).toBeLessThanOrEqual(0.1);
    const grips = gripPoints(linear);
    expect(grips.length).toBe(4);
    const moved = moveGrip(linear, 2, { x: 2, y: 5 }) as DimensionEntity;
    expect(moved.linePoint.y).toBe(5);
    const textMoved = moveGrip(linear, 3, { x: 3, y: 4 }) as DimensionEntity;
    expect(textMoved.textPosition).toEqual({ x: 3, y: 4 });
    expect(dimensionParts(linear)).toBe(dimensionParts(linear)); // cached
  });
});

describe('dimension DXF round trip', () => {
  const dims: DimensionEntity[] = [
    { ...base, id: 'lin', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 4, y: 1 }, linePoint: { x: 2, y: 3 }, rotation: 0 },
    { ...base, id: 'ver', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 4, y: 1 }, linePoint: { x: -2, y: 0.5 }, rotation: Math.PI / 2, text: 'H=<>' },
    { ...base, id: 'ali', kind: 'aligned', p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 }, linePoint: { x: -1, y: 3 }, rotation: 0 },
    { ...base, id: 'rad', kind: 'radius', p1: { x: 10, y: 10 }, p2: { x: 12, y: 10 }, linePoint: { x: 13, y: 11 }, rotation: 0 },
    { ...base, id: 'dia', kind: 'diameter', p1: { x: 10, y: 10 }, p2: { x: 12, y: 10 }, linePoint: { x: 11, y: 10.2 }, rotation: 0 },
    { ...base, id: 'ang', kind: 'angular', p1: { x: 2, y: 0 }, p2: { x: 0, y: 2 }, center: { x: 0, y: 0 }, linePoint: { x: 1, y: 1 }, rotation: 0, textPosition: { x: 1.2, y: 1.2 } },
  ];

  it('writes DIMENSION entities with anonymous *D blocks and reads them back', () => {
    const d = new Drawing();
    d.addLayer({ name: 'DIM', color: 3, visible: true, locked: false, lineWeight: 0.25 });
    d.addEntities(dims);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('\r\nDIMENSION\r\n');
    expect(text).toContain('*D1');
    expect(text).toContain('AcDbRotatedDimension');
    expect(text).toContain('AcDbAlignedDimension');
    expect(text).toContain('AcDbRadialDimension');
    expect(text).toContain('AcDbDiametricDimension');
    expect(text).toContain('AcDb3PointAngularDimension');
    expect(text).toContain('\r\nSOLID\r\n'); // arrowheads in the *D block
    const back = readDxf(text);
    expect(Object.keys(back.blocks).some((n) => n.startsWith('*D'))).toBe(false); // pictures are regenerated
    const got = back.entities.filter((e): e is DimensionEntity => e.type === 'dimension');
    expect(got.map((e) => e.kind)).toEqual(['linear', 'linear', 'aligned', 'radius', 'diameter', 'angular']);
    for (let i = 0; i < dims.length; i += 1) {
      const a = dims[i]!;
      const b = got[i]!;
      expect(b.p1.x).toBeCloseTo(a.p1.x);
      // radial dimensions re-derive their circle point from the leader direction; the radius is what matters
      if (a.kind === 'radius' || a.kind === 'diameter') expect(dimensionMeasurement(b)).toBeCloseTo(dimensionMeasurement(a));
      else expect(b.p2.y).toBeCloseTo(a.p2.y);
      expect(dimensionText(b)).toBe(dimensionText(a));
      expect(b.style.textHeight).toBeCloseTo(STANDARD_DIMSTYLE.textHeight);
    }
    expect(got[1]!.rotation).toBeCloseTo(Math.PI / 2);
    expect(got[1]!.text).toBe('H=<>');
    expect(got[5]!.center!.x).toBeCloseTo(0);
    expect(got[5]!.textPosition!.x).toBeCloseTo(1.2);
    // radial: the leader location survives
    expect(got[3]!.linePoint.x).toBeCloseTo(dims[3]!.linePoint.x, 3);
  });

  it('keeps dimension style variables in the header', () => {
    const d = new Drawing();
    d.setHeader({ dimStyle: { ...ISO25_DIMSTYLE } });
    d.addEntities([{ ...dims[0]!, style: ISO25_DIMSTYLE }]);
    const back = readDxf(writeDxf(d.snapshot));
    expect(back.header?.dimStyle.name).toBe('ISO-25');
    expect(back.header?.dimStyle.arrowSize).toBeCloseTo(2.5);
    const dim = back.entities[0] as DimensionEntity;
    expect(dim.style.decimals).toBe(2);
  });
});

describe('dimension tools', () => {
  it('DIMLINEAR picks horizontal or vertical from the dimension line location', () => {
    const ctx = fakeContext();
    drive(dimLinearTool(), ctx, [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 2, y: 3 }]);
    expect(ctx.finished).toBe(true);
    const d = ctx.doc.entities[0] as DimensionEntity;
    expect(d.type).toBe('dimension');
    expect(d.kind).toBe('linear');
    expect(d.rotation).toBe(0);
    expect(ctx.logs.some((l) => l.includes('Dimension text = 4.0000'))).toBe(true);
    expect(ctx.prompts[0]).toBe('Specify first extension line origin or <select object>:');

    const ctx2 = fakeContext();
    drive(dimLinearTool(), ctx2, [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 6, y: 0.5 }]);
    expect((ctx2.doc.entities[0] as DimensionEntity).rotation).toBeCloseTo(Math.PI / 2);
  });

  it('DIMLINEAR Text and Rotated options override the text and angle', () => {
    const ctx = fakeContext();
    drive(dimLinearTool(), ctx, [{ x: 0, y: 0 }, { x: 4, y: 0 }, 'T', 'TYP <>', 'R', '30', { x: 2, y: 2 }]);
    const d = ctx.doc.entities[0] as DimensionEntity;
    expect(d.text).toBe('TYP <>');
    expect(d.rotation).toBeCloseTo(Math.PI / 6);
    expect(dimensionText(d)).toBe(`TYP ${(4 * Math.cos(Math.PI / 6)).toFixed(4)}`);
  });

  it('DIMLINEAR <select object> dimensions a picked line; Enter repeats prompt wording', () => {
    const ctx = fakeContext();
    const line: Entity = { id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 1, y: 1 }, b: { x: 5, y: 1 } };
    ctx.doc.addEntities([line]);
    drive(dimLinearTool(), ctx, ['', { x: 3, y: 1 }, { x: 3, y: 3 }]);
    const d = ctx.doc.entities.find((e) => e.type === 'dimension') as DimensionEntity;
    expect(d.p1).toEqual({ x: 1, y: 1 });
    expect(d.p2).toEqual({ x: 5, y: 1 });
    expect(ctx.prompts).toContain('Select object to dimension:');
  });

  it('DIMALIGNED, DIMRADIUS, DIMDIAMETER and DIMANGULAR create their kinds', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities([
      { id: 'c', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 10, y: 10 }, radius: 2 },
      { id: 'a', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
      { id: 'b', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 0, y: 4 } },
    ]);
    drive(dimAlignedTool(), ctx, [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: -1, y: 3 }]);
    drive(dimRadiusTool(), ctx, [{ x: 12, y: 10 }, { x: 13, y: 11 }]);
    drive(dimDiameterTool(), ctx, [{ x: 12, y: 10 }, { x: 11, y: 10.2 }]);
    drive(dimAngularTool(), ctx, [{ x: 3, y: 0 }, { x: 0, y: 3 }, { x: 1, y: 1 }]);
    const kinds = ctx.doc.entities.filter((e): e is DimensionEntity => e.type === 'dimension').map((e) => e.kind);
    expect(kinds).toEqual(['aligned', 'radius', 'diameter', 'angular']);
    const ang = ctx.doc.entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.kind === 'angular')!;
    expect(ang.center!.x).toBeCloseTo(0);
    expect(dimensionText(ang)).toBe('90%%d');
    const rad = ctx.doc.entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.kind === 'radius')!;
    expect(dimensionText(rad)).toBe('R2.0000');
    // Angular via vertex prompt
    drive(dimAngularTool(), ctx, ['', { x: 5, y: 5 }, { x: 8, y: 5 }, { x: 5, y: 8 }, { x: 7, y: 7 }]);
    const ang2 = ctx.doc.entities[ctx.doc.entities.length - 1] as DimensionEntity;
    expect(ang2.kind).toBe('angular');
    expect(ang2.center).toEqual({ x: 5, y: 5 });
  });
});
