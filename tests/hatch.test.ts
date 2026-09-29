import { describe, it, expect } from 'vitest';
import type { HatchEntity, Entity, PolylineEntity } from '../src/core/entities';
import { hatchGeometry, hatchPatternLines, entityBounds, distanceToEntity, translateEntity, rotateEntity, scaleEntityBy, mirrorEntityAcross, entityTypeName, explodeCompound } from '../src/core/entities';
import { HATCH_PATTERNS, worldPatternLines, patternSegments, loopPolygon, pointInLoops, findPattern } from '../src/core/hatch';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, convertHatch, convertHatchEntity, type DwgImportPayload } from '../src/io/dwg';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { hatchTool, hatchEditTool, boundaryAt, loopFromEntity, annotDefaults } from '../src/tools/drafting-annot';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';

const props = { layer: '0', color: 'ByLayer' as const };
const lookup = () => undefined;
const square = (s: number, x = 0, y = 0) => ({ points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] });
const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({ id: 'h', ...props, type: 'hatch', pattern: 'ANSI31', solid: false, angle: 0, scale: 1, loops: [square(1)], ...over });

describe('hatch patterns (.pat semantics)', () => {
  it('defines the standard patterns', () => {
    for (const n of ['ANSI31', 'ANSI32', 'ANSI37', 'NET', 'DOTS', 'LINE', 'SOLID']) expect(findPattern(n)).toBeDefined();
    expect(findPattern('ansi31')!.lines[0]).toEqual({ angle: 45, origin: { x: 0, y: 0 }, offset: { x: 0, y: 0.125 }, dashes: [] });
    expect(HATCH_PATTERNS.ANSI37!.lines.map((l) => l.angle)).toEqual([45, 135]);
  });
  it('rotates and scales line families; offsets are in the line frame', () => {
    const [l] = worldPatternLines(findPattern('LINE')!, Math.PI / 2, 2, { x: 1, y: 1 });
    expect(l!.angle).toBeCloseTo(Math.PI / 2);
    // perpendicular spacing 0.125 * 2 along the rotated normal (-1, 0)
    expect(l!.offset.x).toBeCloseTo(-0.25);
    expect(l!.offset.y).toBeCloseTo(0);
    expect(l!.base).toEqual({ x: 1, y: 1 });
  });
  it('clips LINE to a unit square: 8 horizontal lines, each spanning the square', () => {
    const geo = patternSegments([loopPolygon(square(1))], worldPatternLines(findPattern('LINE')!, 0, 1));
    const inside = geo.segments.filter(([a]) => a.y > 1e-9 && a.y < 1 - 1e-9);
    expect(inside).toHaveLength(7);
    for (const [a, b] of inside) expect(Math.abs(b.x - a.x)).toBeCloseTo(1);
  });
  it('respects islands with the even-odd rule', () => {
    const outer = loopPolygon(square(4));
    const hole = loopPolygon(square(2, 1, 1));
    const geo = patternSegments([outer, hole], worldPatternLines(findPattern('LINE')!, 0, 1));
    const mid = geo.segments.filter(([a]) => Math.abs(a.y - 2) < 1e-9);
    expect(mid).toHaveLength(2); // left and right of the island
    expect(pointInLoops({ x: 2, y: 2 }, [outer, hole])).toBe(false);
    expect(pointInLoops({ x: 0.5, y: 2 }, [outer, hole])).toBe(true);
  });
  it('cuts dashes and dots (DOTS pattern)', () => {
    const geo = patternSegments([loopPolygon(square(1))], worldPatternLines(findPattern('DOTS')!, 0, 1));
    expect(geo.segments.length).toBeGreaterThan(100);
    expect(geo.segments.every(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-12)).toBe(true);
  });
  it('flags absurdly dense patterns instead of generating them', () => {
    const geo = patternSegments([loopPolygon(square(1000))], worldPatternLines(findPattern('ANSI31')!, 0, 0.0001));
    expect(geo.dense).toBe(true);
  });
});

describe('HATCH entity', () => {
  it('has bounds, pick behaviour, transforms and a type name', () => {
    const h = hatch();
    expect(entityBounds(h, lookup)).toEqual({ min: { x: 0, y: 0 }, max: { x: 1, y: 1 } });
    expect(entityTypeName(h)).toBe('HATCH');
    const solid = hatch({ pattern: 'SOLID', solid: true });
    expect(distanceToEntity({ x: 0.5, y: 0.5 }, solid, lookup)).toBe(0);
    expect(distanceToEntity({ x: 3, y: 0.5 }, solid, lookup)).toBeCloseTo(2);
    const moved = translateEntity(h, { x: 5, y: 0 }) as HatchEntity;
    expect(moved.loops[0]!.points[0]).toEqual({ x: 5, y: 0 });
    expect(moved.origin).toEqual({ x: 5, y: 0 });
    const rot = rotateEntity(h, { x: 0, y: 0 }, Math.PI / 4) as HatchEntity;
    expect(rot.angle).toBeCloseTo(Math.PI / 4);
    const sc = scaleEntityBy(h, { x: 0, y: 0 }, 3) as HatchEntity;
    expect(sc.scale).toBeCloseTo(3);
    // MIRRHATCH = 0: the pattern keeps its direction.
    const mir = mirrorEntityAcross(hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], bulges: [1, 1] }] }), { x: 0, y: 0 }, { x: 0, y: 1 }) as HatchEntity;
    expect(mir.angle).toBe(0);
    expect(mir.loops[0]!.bulges).toEqual([-1, -1]);
  });
  it('arc loops (bulges) are tessellated for clipping', () => {
    const circle = hatch({ loops: [{ points: [{ x: 1, y: 0 }, { x: -1, y: 0 }], bulges: [1, 1] }] });
    const geo = hatchGeometry(circle);
    expect(geo.polys[0]!.length).toBeGreaterThan(16);
    for (const [a, b] of geo.segments) {
      expect(Math.hypot(a.x, a.y)).toBeLessThan(1.001);
      expect(Math.hypot(b.x, b.y)).toBeLessThan(1.001);
    }
  });
  it('explodes a pattern hatch into lines and a solid one into filled boundaries', () => {
    expect(explodeCompound(hatch())!.every((e) => e.type === 'line')).toBe(true);
    const solid = explodeCompound(hatch({ pattern: 'SOLID', solid: true }))!;
    expect(solid[0]).toMatchObject({ type: 'polyline', filled: true, closed: true });
  });
});

describe('HATCH in DXF', () => {
  it('round-trips pattern, angle, scale, bulged polyline loops and islands', () => {
    const d = new Drawing();
    d.addEntities([
      hatch({ id: 'a', pattern: 'ANSI37', angle: Math.PI / 6, scale: 2, loops: [square(4), { points: [{ x: 1, y: 2 }, { x: 3, y: 2 }], bulges: [1, 1] }] }),
      hatch({ id: 'b', pattern: 'SOLID', solid: true, layer: 'FILL', color: 1 }),
      hatch({ id: 'c', pattern: 'NET', origin: { x: 0.05, y: 0.02 } }),
    ]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('\r\nHATCH\r\n');
    const back = readDxf(text).entities.filter((e): e is HatchEntity => e.type === 'hatch');
    expect(back).toHaveLength(3);
    const [a, b, c] = back as [HatchEntity, HatchEntity, HatchEntity];
    expect(a.pattern).toBe('ANSI37');
    expect(a.angle).toBeCloseTo(Math.PI / 6);
    expect(a.scale).toBeCloseTo(2);
    expect(a.loops).toHaveLength(2);
    expect(a.loops[1]!.bulges).toEqual([1, 1]);
    expect(b.solid).toBe(true);
    expect(b.layer).toBe('FILL');
    expect(c.origin!.x).toBeCloseTo(0.05);
    // Same pattern geometry after the round trip.
    expect(hatchGeometry(c).segments.length).toBe(hatchGeometry(hatch({ pattern: 'NET', origin: { x: 0.05, y: 0.02 } })).segments.length);
  });
  it('reads edge-defined boundaries (line / arc / clockwise arc) and custom pattern definition lines', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'HATCH', '8', 'H', '100', 'AcDbEntity', '100', 'AcDbHatch', '10', '0', '20', '0', '30', '0', '2', 'MYPAT', '70', '0', '71', '0', '91', '1',
      '92', '1', '93', '3',
      '72', '1', '10', '0', '20', '0', '11', '2', '21', '0',
      '72', '2', '10', '2', '20', '1', '40', '1', '50', '270', '51', '90', '73', '1',
      '72', '1', '10', '2', '20', '2', '11', '0', '21', '2',
      '97', '0',
      '75', '0', '76', '2', '52', '0', '41', '1', '77', '0', '78', '1',
      '53', '0', '43', '0', '44', '0', '45', '0', '46', '0.5', '79', '2', '49', '0.25', '49', '-0.1',
      '98', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const h = readDxf(dxf).entities[0] as HatchEntity;
    expect(h.type).toBe('hatch');
    expect(h.pattern).toBe('MYPAT');
    expect(h.patternLines).toHaveLength(1);
    expect(h.patternLines![0]!.dashes).toEqual([0.25, -0.1]);
    const poly = hatchGeometry(h).polys[0]!;
    expect(Math.max(...poly.map((p) => p.x))).toBeCloseTo(3, 3); // arc apex
    expect(hatchGeometry(h).segments.length).toBeGreaterThan(3);
    // Clockwise arc: stored with negated angles.
    // The same loop traversed the other way: the arc runs clockwise from the top (90) to the bottom (270),
    // stored as 360-90 = 270 and 360-270 = 90.
    const reversed = dxf
      .replace('72\n1\n10\n0\n20\n0\n11\n2\n21\n0', '72\n1\n10\n0\n20\n2\n11\n2\n21\n2')
      .replace('50\n270\n51\n90\n73\n1', '50\n270\n51\n90\n73\n0')
      .replace('72\n1\n10\n2\n20\n2\n11\n0\n21\n2', '72\n1\n10\n2\n20\n0\n11\n0\n21\n0');
    expect(reversed).not.toBe(dxf);
    const cw = readDxf(reversed).entities[0] as HatchEntity;
    expect(Math.max(...hatchGeometry(cw).polys[0]!.map((p) => p.x))).toBeCloseTo(3, 3);
    // Written back as a polyline loop with bulges and the definition lines.
    const again = readDxf(writeDxf({ ...new Drawing().snapshot, entities: [h] })).entities[0] as HatchEntity;
    expect(again.patternLines![0]!.offset.y).toBeCloseTo(0.5);
    expect(again.loops[0]!.bulges!.some((b) => Math.abs(b) > 0.1)).toBe(true);
  });
});

describe('HATCH from DWG', () => {
  const dwgHatch = (extra: Record<string, unknown>) => ({ type: 'HATCH', handle: 'H1', layer: 'FILL', colorIndex: 1, ...extra }) as never;
  it('converts to a real hatch entity with pattern, angle and scale', () => {
    const h = convertHatchEntity(
      dwgHatch({ solidFill: 0, patternName: 'ANSI31', patternAngle: Math.PI / 2, patternScale: 3, boundaryPaths: [{ boundaryPathTypeFlag: 7, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }] }),
    )!;
    expect(h).toMatchObject({ type: 'hatch', pattern: 'ANSI31', solid: false, scale: 3, layer: 'FILL', color: 1 });
    expect(h.angle).toBeCloseTo(Math.PI / 2);
    expect(hatchPatternLines(h)[0]!.angle).toBeCloseTo((3 * Math.PI) / 4);
  });
  it('convertDwg produces hatch entities and keeps the outline fallback for unusable boundaries', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: 'FILL', colorIndex: 1, off: false, frozen: false, locked: false, lineweight: 29 }],
      blocks: [],
      entities: [
        dwgHatch({ solidFill: 1, patternName: 'SOLID', boundaryPaths: [{ boundaryPathTypeFlag: 1, edges: [{ type: 2, center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 2 * Math.PI, isCCW: true }] }] }),
        dwgHatch({ handle: 'H2', solidFill: 0, patternName: 'ANSI31', boundaryPaths: [] }),
      ],
    };
    const { state, skipped } = convertDwg(payload);
    const h = state.entities[0] as HatchEntity;
    expect(h.type).toBe('hatch');
    expect(h.solid).toBe(true);
    expect(entityBounds(h, lookup)!.max.x).toBeCloseTo(1, 2);
    expect(skipped.HATCH).toBe(1);
    // The old outline conversion is still there for callers that want it.
    expect(convertHatch(dwgHatch({ solidFill: 1, boundaryPaths: [{ boundaryPathTypeFlag: 1, vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] }))[0]!.type).toBe('polyline');
  });
});

describe('HATCH and HATCHEDIT commands', () => {
  const rect = (id: string, x: number, y: number, s: number): PolylineEntity => ({ id, ...props, type: 'polyline', closed: true, points: square(s, x, y).points });
  it('finds the boundary and islands around an internal point', () => {
    const ents: Entity[] = [rect('o', 0, 0, 10), rect('i', 3, 3, 2), { id: 'c', ...props, type: 'circle', center: { x: 20, y: 0 }, radius: 1 }];
    const loops = boundaryAt(ents, { x: 1, y: 1 })!;
    expect(loops).toHaveLength(2);
    expect(boundaryAt(ents, { x: 4, y: 4 })).toHaveLength(1); // inside the island: the island itself
    expect(boundaryAt(ents, { x: 50, y: 50 })).toBeNull();
    expect(loopFromEntity(ents[2]!)!.bulges).toEqual([1, 1]);
  });
  it('-HATCH: Properties then an internal point', () => {
    const doc = new Drawing();
    doc.addEntities([rect('o', 0, 0, 10)]);
    const ctx = fakeContext(doc);
    drive(hatchTool(), ctx, ['P', 'NET', '2', '30', { x: 5, y: 5 }, '']);
    const h = doc.entities.find((e) => e.type === 'hatch') as HatchEntity;
    expect(h).toMatchObject({ pattern: 'NET', scale: 2, solid: false });
    expect(h.angle).toBeCloseTo(Math.PI / 6);
    expect(ctx.prompts[0]).toBe('Specify internal point or [Properties/Select objects/draW boundary/Origin]:');
    expect(ctx.prompts).toContain('Enter a pattern name or [?/Solid/User defined] <ANSI31>:');
    annotDefaults.hatchPattern = 'ANSI31';
    annotDefaults.hatchScale = 1;
    annotDefaults.hatchAngle = 0;
  });
  it('-HATCH: Select objects (closed polylines and circles), solid', () => {
    const doc = new Drawing();
    doc.addEntities([rect('o', 0, 0, 10), { id: 'c', ...props, type: 'circle', center: { x: 20, y: 0 }, radius: 1 }, { id: 'l', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    const ctx = fakeContext(doc);
    drive(hatchTool(), ctx, ['P', 'S', 'S', { select: ['o', 'c', 'l'] }, '']);
    const h = doc.entities.find((e) => e.type === 'hatch') as HatchEntity;
    expect(h.solid).toBe(true);
    expect(h.loops).toHaveLength(2);
    expect(ctx.logs.some((l) => l.includes('not closed'))).toBe(true);
    annotDefaults.hatchPattern = 'ANSI31';
  });
  it('-HATCH: draW boundary', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(hatchTool(), ctx, ['W', { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, '', '']);
    const h = doc.entities[0] as HatchEntity;
    expect(h.loops[0]!.points).toHaveLength(3);
  });
  it('HATCHEDIT changes the pattern, scale and angle; Properties palette names it', () => {
    const doc = new Drawing();
    doc.addEntities([hatch({ id: 'hx' })]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['hx']);
    drive(hatchEditTool(), ctx, ['', 'ANSI32', '0.5', '90']);
    const h = doc.entities[0] as HatchEntity;
    expect(h.pattern).toBe('ANSI32');
    expect(h.scale).toBe(0.5);
    expect(h.angle).toBeCloseTo(Math.PI / 2);
  });
  it('EXPLODE breaks a hatch into its pattern lines', () => {
    const doc = new Drawing();
    doc.addEntities([hatch({ id: 'hx' })]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['hx']);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities.length).toBeGreaterThan(5);
    expect(doc.entities.every((e) => e.type === 'line')).toBe(true);
  });
});
