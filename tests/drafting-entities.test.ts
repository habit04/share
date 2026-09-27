import { describe, it, expect } from 'vitest';
import type { Entity, PolylineEntity, EllipseEntity, MTextEntity, XlineEntity } from '../src/core/entities';
import {
  bulgeArc,
  bulgeFromSweep,
  polylineVertices,
  polylineArea,
  polylineLength,
  entityBounds,
  distanceToEntity,
  gripPoints,
  moveGrip,
  mirrorEntityAcross,
  rotateEntity,
  scaleEntityBy,
  translateEntity,
  snapCandidates,
  ellipsePoint,
  mtextParts,
  textWidth,
  entityTypeName,
} from '../src/core/entities';
import { mtextLines, wrapParagraph, mtextFromDxf, mtextToDxf } from '../src/core/mtext';
import { Drawing } from '../src/core/document';
import { writeDxf, readDxf } from '../src/io/dxf';
import { strokeTextWidth, expandControlCodes } from '../src/render/hershey';

const lookup = () => undefined;
const props = { layer: '0', color: 'ByLayer' as const };

describe('polyline bulges and width', () => {
  it('derives arc centre and sweep from a bulge', () => {
    const arc = bulgeArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)!; // semicircle CCW -> passes below the chord
    expect(arc.radius).toBeCloseTo(1);
    expect(arc.center.x).toBeCloseTo(1);
    expect(arc.center.y).toBeCloseTo(0);
    expect(arc.sweep).toBeCloseTo(Math.PI);
    const verts = polylineVertices({ id: 'p', ...props, type: 'polyline', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulges: [1, 0] });
    expect(Math.min(...verts.map((v) => v.y))).toBeCloseTo(-1, 1);
    expect(bulgeArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 0)).toBeNull();
    expect(bulgeFromSweep(Math.PI)).toBeCloseTo(1);
  });

  it('computes area and length of a donut-style polyline like a circle', () => {
    const donut: PolylineEntity = { id: 'd', ...props, type: 'polyline', closed: true, points: [{ x: -1, y: 0 }, { x: 1, y: 0 }], bulges: [1, 1], width: 0.2 };
    expect(Math.abs(polylineArea(donut))).toBeCloseTo(Math.PI, 5);
    expect(polylineLength(donut)).toBeCloseTo(2 * Math.PI, 5);
    const b = entityBounds(donut, lookup)!;
    expect(b.max.x).toBeCloseTo(1.1, 5); // half width added
    // hit testing tolerates the width
    expect(distanceToEntity({ x: 1.08, y: 0 }, donut, lookup)).toBeCloseTo(0);
  });

  it('mirroring flips bulge sign, rotation keeps it', () => {
    const pl: PolylineEntity = { id: 'p', ...props, type: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], bulges: [0.5, 0] };
    const m = mirrorEntityAcross(pl, { x: 0, y: 0 }, { x: 1, y: 0 }) as PolylineEntity;
    expect(m.bulges).toEqual([-0.5, -0]);
    const r = rotateEntity(pl, { x: 0, y: 0 }, Math.PI / 2) as PolylineEntity;
    expect(r.bulges).toEqual([0.5, 0]);
    const s = scaleEntityBy({ ...pl, width: 0.5 }, { x: 0, y: 0 }, 2) as PolylineEntity;
    expect(s.width).toBe(1);
    expect(s.points[1]).toEqual({ x: 4, y: 0 });
  });

  it('snaps to arc-segment midpoints and centres', () => {
    const pl: PolylineEntity = { id: 'p', ...props, type: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], bulges: [1, 0] };
    const c = snapCandidates(pl, lookup);
    expect(c.find((x) => x.kind === 'center')?.point.x).toBeCloseTo(1);
    const mid = c.find((x) => x.kind === 'midpoint')!.point;
    expect(mid.y).toBeCloseTo(-1);
  });
});

describe('ellipse, point, xline, ray', () => {
  const ell: EllipseEntity = { id: 'e', ...props, type: 'ellipse', center: { x: 1, y: 1 }, majorAxis: { x: 2, y: 0 }, ratio: 0.5, startParam: 0, endParam: 2 * Math.PI };
  it('ellipse points, bounds, grips and quadrant snaps', () => {
    expect(ellipsePoint(ell, 0)).toEqual({ x: 3, y: 1 });
    expect(ellipsePoint(ell, Math.PI / 2).y).toBeCloseTo(2);
    const b = entityBounds(ell, lookup)!;
    expect(b.min.x).toBeCloseTo(-1);
    expect(b.max.y).toBeCloseTo(2);
    expect(gripPoints(ell)).toHaveLength(5);
    expect(snapCandidates(ell, lookup).filter((c) => c.kind === 'quadrant')).toHaveLength(4);
    expect(distanceToEntity({ x: 3.05, y: 1 }, ell, lookup)).toBeLessThan(0.06);
    const arc: EllipseEntity = { ...ell, startParam: 0, endParam: Math.PI };
    expect(snapCandidates(arc, lookup).filter((c) => c.kind === 'endpoint')).toHaveLength(2);
    const g2 = moveGrip(ell, 3, { x: 1, y: 1.4 }) as EllipseEntity;
    expect(g2.ratio).toBeCloseTo(0.2);
  });
  it('rotates and mirrors the major axis', () => {
    const r = rotateEntity(ell, { x: 1, y: 1 }, Math.PI / 2) as EllipseEntity;
    expect(r.majorAxis.x).toBeCloseTo(0);
    expect(r.majorAxis.y).toBeCloseTo(2);
    const m = mirrorEntityAcross(ell, { x: 0, y: 0 }, { x: 0, y: 1 }) as EllipseEntity;
    expect(m.center.x).toBeCloseTo(-1);
  });
  it('xline / ray distance and translation', () => {
    const xl: XlineEntity = { id: 'x', ...props, type: 'xline', base: { x: 0, y: 0 }, direction: { x: 1, y: 1 } };
    expect(distanceToEntity({ x: 100, y: 100 }, xl, lookup)).toBeCloseTo(0);
    expect(distanceToEntity({ x: -100, y: -100 }, xl, lookup)).toBeCloseTo(0);
    const ray: Entity = { ...xl, id: 'r', type: 'ray' };
    expect(distanceToEntity({ x: -1, y: -1 }, ray, lookup)).toBeCloseTo(Math.SQRT2);
    const t = translateEntity(ray, { x: 1, y: 0 });
    expect(t.type === 'ray' && t.base.x).toBe(1);
    expect(snapCandidates(ray, lookup)[0]!.kind).toBe('endpoint');
    const pt: Entity = { id: 'p', ...props, type: 'point', position: { x: 2, y: 3 } };
    expect(snapCandidates(pt, lookup)[0]!.kind).toBe('node');
    expect(entityTypeName(pt)).toBe('POINT');
  });
});

describe('mtext layout', () => {
  const measure = (t: string, h: number) => t.length * 0.8 * h; // deterministic stand-in font
  it('wraps words to the reference width and never splits a word', () => {
    expect(wrapParagraph('the quick brown fox', 3.3, 1, measure)).toEqual(['the', 'quick', 'brown', 'fox']);
    expect(wrapParagraph('the quick brown fox', 8, 1, measure)).toEqual(['the quick', 'brown fox']);
    expect(wrapParagraph('supercalifragilistic a', 2, 1, measure)).toEqual(['supercalifragilistic', 'a']);
    expect(mtextLines({ text: 'a\\Pb\nc', width: 0, height: 1 }, measure)).toEqual(['a', 'b', 'c']);
  });
  it('lays out lines from the attachment point with 5/3 spacing', () => {
    const m: MTextEntity = { id: 'm', ...props, type: 'mtext', position: { x: 10, y: 20 }, text: 'ab cd ef', height: 0.2, width: 0.5, rotation: 0, attachment: 1, lineSpacing: 1 };
    const parts = mtextParts(m);
    expect(parts.length).toBe(mtextLines(m, textWidth).length);
    expect(parts[0]!.position.y).toBeCloseTo(20 - 0.2);
    expect(parts[1]!.position.y).toBeCloseTo(20 - 0.2 - 0.2 * (5 / 3));
    expect(parts[0]!.align).toBe('left');
    // bottom-right attachment: last baseline at y = 20
    const br = mtextParts({ ...m, id: 'm2', attachment: 9 });
    expect(br[br.length - 1]!.position.y).toBeCloseTo(20);
    expect(br[0]!.align).toBe('right');
    expect(entityBounds(m, lookup)!.max.y).toBeCloseTo(20);
  });
  it('converts DXF formatting codes', () => {
    expect(mtextFromDxf('{\\fArial|b0;Hello}\\PWorld\\~x')).toBe('Hello\nWorld x');
    expect(mtextToDxf('a\nb')).toBe('a\\Pb');
  });
  it('expands %%c %%d %%p control codes in the stroke font', () => {
    expect(expandControlCodes('R%%c 45%%d %%p0.1 100%%%')).toBe('R⌀ 45° ±0.1 100%');
    expect(strokeTextWidth('%%c', 1)).toBeGreaterThan(0.5);
  });
});

describe('DXF round trip of the new entities', () => {
  it('keeps ellipse, point, xline, ray, mtext, polyline bulge/width, solid, linetype and lineweight', () => {
    const d = new Drawing();
    d.addLayer({ name: 'HID', color: 1, visible: true, locked: false, lineWeight: 0.5, linetype: 'HIDDEN' });
    const ents: Entity[] = [
      { id: 'e', layer: 'HID', color: 'ByLayer', type: 'ellipse', center: { x: 1, y: 1 }, majorAxis: { x: 2, y: 0.5 }, ratio: 0.4, startParam: 0.5, endParam: 3 },
      { id: 'p', ...props, type: 'point', position: { x: 2, y: 3 } },
      { id: 'x', ...props, type: 'xline', base: { x: 0, y: 0 }, direction: { x: 1, y: 1 } },
      { id: 'r', ...props, type: 'ray', base: { x: 5, y: 5 }, direction: { x: 0, y: -1 } },
      { id: 'm', ...props, type: 'mtext', position: { x: 10, y: 20 }, text: 'Hello\nWorld', height: 0.2, width: 3, rotation: 0.3, attachment: 5, lineSpacing: 1.5 },
      { id: 'pl', ...props, type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }], bulges: [0, 0.5, 0], width: 0.1, linetype: 'DASHED', lineWeight: 0.35, ltscale: 2 },
      { id: 's', ...props, type: 'polyline', closed: true, filled: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] },
      { id: 'l', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, linetype: 'CENTER', lineWeight: 0.7 },
    ];
    d.addEntities(ents);
    const text = writeDxf(d.snapshot);
    for (const k of ['ELLIPSE', 'POINT', 'XLINE', 'RAY', 'MTEXT', 'SOLID']) expect(text).toContain(`\r\n${k}\r\n`);
    // LTYPE table carries the used patterns
    expect(text).toContain('\r\nHIDDEN\r\n');
    expect(text).toContain('\r\nDASHED\r\n');
    expect(text).toContain('\r\nCENTER\r\n');
    const back = readDxf(text);
    const by = (t: Entity['type']) => back.entities.find((e) => e.type === t) as Entity;
    const e = by('ellipse') as EllipseEntity;
    expect(e.majorAxis).toEqual({ x: 2, y: 0.5 });
    expect(e.ratio).toBeCloseTo(0.4);
    expect(e.startParam).toBeCloseTo(0.5);
    expect(e.layer).toBe('HID');
    expect((by('point') as Extract<Entity, { type: 'point' }>).position).toEqual({ x: 2, y: 3 });
    const x = by('xline') as XlineEntity;
    expect(x.direction.x).toBeCloseTo(Math.SQRT1_2);
    expect((by('ray') as Extract<Entity, { type: 'ray' }>).direction.y).toBeCloseTo(-1);
    const m = by('mtext') as MTextEntity;
    expect(m.text).toBe('Hello\nWorld');
    expect(m.width).toBe(3);
    expect(m.attachment).toBe(5);
    expect(m.rotation).toBeCloseTo(0.3);
    expect(m.lineSpacing).toBeCloseTo(1.5);
    const pls = back.entities.filter((en): en is PolylineEntity => en.type === 'polyline');
    const pl = pls.find((p) => !p.filled)!;
    expect(pl.bulges).toEqual([0, 0.5, 0]);
    expect(pl.width).toBeCloseTo(0.1);
    expect(pl.linetype).toBe('DASHED');
    expect(pl.lineWeight).toBeCloseTo(0.35);
    expect(pl.ltscale).toBe(2);
    const solid = pls.find((p) => p.filled)!;
    expect(solid.points).toHaveLength(3);
    const l = by('line');
    expect(l.linetype).toBe('CENTER');
    expect(l.lineWeight).toBeCloseTo(0.7);
    expect(back.layers.find((la) => la.name === 'HID')?.linetype).toBe('HIDDEN');
    expect(back.layers.find((la) => la.name === 'HID')?.lineWeight).toBeCloseTo(0.5);
  });

  it('round-trips header variables: units, limits, ltscale, pdmode, views, celtype', () => {
    const d = new Drawing();
    d.setHeader({
      units: { lunits: 4, luprec: 3, insunits: 4, auprec: 2 },
      ltscale: 0.5,
      limits: { min: { x: -1, y: -2 }, max: { x: 30, y: 20 } },
      pdmode: 34,
      pdsize: 0.25,
      views: [{ name: 'PLAN', center: { x: 5, y: 6 }, height: 12 }],
      celtype: 'DASHED',
      celweight: 0.5,
    });
    const back = readDxf(writeDxf(d.snapshot));
    const h = back.header!;
    expect(h.units).toEqual({ lunits: 4, luprec: 3, insunits: 4, auprec: 2 });
    expect(h.ltscale).toBe(0.5);
    expect(h.limits).toEqual({ min: { x: -1, y: -2 }, max: { x: 30, y: 20 } });
    expect(h.pdmode).toBe(34);
    expect(h.pdsize).toBe(0.25);
    expect(h.views).toEqual([{ name: 'PLAN', center: { x: 5, y: 6 }, height: 12 }]);
    expect(h.celtype).toBe('DASHED');
    expect(h.celweight).toBeCloseTo(0.5);
  });

  it('applies the current entity linetype/lineweight to new objects only', () => {
    const d = new Drawing();
    d.setHeader({ celtype: 'HIDDEN', celweight: 0.3 });
    d.addEntities([{ id: 'a', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    d.addEntities([{ id: 'b', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }], false);
    expect(d.entity('a')?.linetype).toBe('HIDDEN');
    expect(d.entity('a')?.lineWeight).toBe(0.3);
    expect(d.entity('b')?.linetype).toBeUndefined();
  });

  it('reads a hand-written LTYPE table entry and custom pattern', () => {
    const dxf = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LTYPE', '0', 'LTYPE', '2', 'MYDASH', '3', 'mine', '72', '65', '73', '2', '40', '1.5', '49', '1', '74', '0', '49', '-0.5', '74', '0', '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '6', 'MYDASH', '370', '50', '10', '0', '20', '0', '11', '1', '21', '1', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const s = readDxf(dxf);
    expect(s.header?.linetypes).toEqual([{ name: 'MYDASH', description: 'mine', pattern: [1, -0.5] }]);
    expect(s.entities[0]!.linetype).toBe('MYDASH');
    expect(s.entities[0]!.lineWeight).toBeCloseTo(0.5);
    // and the writer keeps it
    expect(writeDxf(s)).toContain('\r\nMYDASH\r\n');
  });
});
