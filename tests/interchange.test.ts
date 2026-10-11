/**
 * Interchange fixtures written by hand from the DXF reference (not by JCad's writer):
 * tests/fixtures/interchange-reference.dxf and block-colors.dxf. Every expectation is checked
 * after import and again after a JCad write / read round trip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DrawingState } from '../src/core/document';
import type { Entity, InsertEntity, ArcEntity, PolylineEntity, TextEntity, MTextEntity, CircleEntity, LineEntity, DimensionEntity } from '../src/core/entities';
import { explodeInsert } from '../src/core/entities';
import { resolveColor, trueColorCss } from '../src/render/draw';
import { aciToCss } from '../src/render/palette';
import { importReportOf } from '../src/io/import-report';
import { textStylesOf } from '../src/io/encoding';
import { namedDimStyles } from '../src/core/dimension';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'latin1');
const imported = readDxf(fixture('interchange-reference.dxf'));
const roundTripped = readDxf(writeDxf(imported));

const byType = <T extends Entity>(s: DrawingState, type: T['type']) => s.entities.filter((e): e is T => e.type === type);
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

for (const [label, s] of [
  ['after import', imported],
  ['after a round trip', roundTripped],
] as const) {
  describe(`interchange reference file ${label}`, () => {
    it('has no import losses', () => {
      expect(importReportOf(s)).toBeUndefined();
    });

    it('header: units, current layer, linetype scale, current dimension style', () => {
      expect(s.header?.units.insunits).toBe(4);
      expect(s.currentLayer).toBe('WALLS');
      expect(s.header?.ltscale).toBe(2);
      expect(s.header?.dimStyle.name).toBe('MECH');
      expect(s.header?.dimStyle.textHeight).toBe(3.5);
    });

    it('layers: colours (ACI and true colour), lineweights, linetype, lock, off, no-plot', () => {
      const L = (n: string) => s.layers.find((l) => l.name === n)!;
      expect(L('0')).toMatchObject({ color: 7, lineWeight: 0.25, visible: true });
      expect(L('WALLS')).toMatchObject({ color: 1, lineWeight: 0.5 });
      expect(L('TRUE')).toMatchObject({ color: 3, trueColor: 0x336699 });
      expect(L('DASH')).toMatchObject({ color: 5, linetype: 'BORDER2X', locked: true });
      expect(L('VPORTS')).toMatchObject({ color: 8, visible: false, plot: false });
    });

    it('styles: custom linetype pattern, text style, named dimension style', () => {
      expect(s.header?.linetypes).toEqual([{ name: 'BORDER2X', description: 'Border (2x) __ . __ .', pattern: [12, -3, 4, -3] }]);
      const notes = textStylesOf(s).NOTES!;
      expect(notes).toMatchObject({ font: 'romans.shx', widthFactor: 0.8, oblique: 15 });
      const mech = namedDimStyles(s).find((d) => d.name === 'MECH')!;
      expect(mech).toMatchObject({ textHeight: 3.5, arrowSize: 2.5, decimals: 1 });
    });

    it('geometry of lines, circle, arc, bulged polyline, text and mtext', () => {
      const lines = byType<LineEntity>(s, 'line');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ layer: 'WALLS', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
      expect(lines[1]).toMatchObject({ layer: '0', color: 4, lineWeight: 0.35 });
      const circle = byType<CircleEntity>(s, 'circle')[0]!;
      expect(circle).toMatchObject({ layer: 'TRUE', center: { x: 50, y: 25 }, radius: 12.5 });
      const arc = byType<ArcEntity>(s, 'arc')[0]!;
      expect(arc).toMatchObject({ center: { x: 30, y: 30 }, radius: 5, color: 1, trueColor: 0xff0000 });
      close(arc.startAngle, 0);
      close(arc.endAngle, Math.PI / 2);
      const pl = byType<PolylineEntity>(s, 'polyline')[0]!;
      expect(pl).toMatchObject({ layer: 'DASH', closed: true, points: [{ x: 0, y: 100 }, { x: 10, y: 100 }, { x: 10, y: 110 }] });
      expect(pl.bulges).toEqual([0, 1, 0]);
      const text = byType<TextEntity>(s, 'text')[0]!;
      expect(text).toMatchObject({ text: 'MOTOR M1', height: 3.5, position: { x: 10, y: 60 }, style: 'NOTES', layer: 'WALLS' });
      const mt = byType<MTextEntity>(s, 'mtext')[0]!;
      expect(mt).toMatchObject({ text: 'Line one\nLine two', height: 2.5, width: 40, attachment: 1 });
    });

    it('dimension with its named style', () => {
      const d = byType<DimensionEntity>(s, 'dimension')[0]!;
      expect(d.kind).toBe('aligned');
      expect(d.style.name).toBe('MECH');
      expect(d.p1).toEqual({ x: 0, y: 0 });
      expect(d.p2).toEqual({ x: 100, y: 0 });
    });

    it('blocks, attributes and attribute definitions', () => {
      const tagbox = s.blocks.TAGBOX!;
      expect(tagbox.attributes.map((a) => [a.tag, a.prompt, a.default, a.invisible])).toEqual([
        ['TAG', 'Tag', 'X?', false],
        ['DESC', 'Description', '', true],
      ]);
      const ins = byType<InsertEntity>(s, 'insert');
      expect(ins[0]).toMatchObject({ block: 'TAGBOX', position: { x: 200, y: 0 }, attributes: { TAG: 'M1', DESC: 'Main motor' } });
      expect(ins[1]).toMatchObject({ block: 'FRAME', scale: 2, color: 6, layer: 'TRUE' });
    });

    it('colours of block content: ByBlock, ByLayer on layer 0, nested, true-colour layers', () => {
      const lookup = (n: string) => s.blocks[n];
      const ins = byType<InsertEntity>(s, 'insert');
      // TAGBOX on WALLS (ByLayer): ByBlock frame -> WALLS red, layer-0 circle -> WALLS red; the TAG attribute text.
      const tag = explodeInsert(ins[0]!, lookup).map((e) => resolveColor(e, s.layers));
      expect(tag.slice(0, 2)).toEqual([aciToCss(1), aciToCss(1)]);
      // FRAME on TRUE, magenta: explicit yellow line; nested ByBlock TAGBOX -> magenta frame;
      // its layer-0 ByLayer circle floats to the nested insert's layer, itself floating to TRUE (#336699).
      const frame = explodeInsert(ins[1]!, lookup).map((e) => resolveColor(e, s.layers));
      expect(frame.slice(0, 3)).toEqual([aciToCss(2), aciToCss(6), trueColorCss(0x336699)]);
    });

    it('layouts: paper, margins, viewports with scale, paper-space entities', () => {
      expect(s.layouts?.map((l) => l.name)).toEqual(['Layout1', 'Sheet2']);
      const [l1, l2] = s.layouts!;
      expect(l1!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'landscape' });
      expect(l1!.margins).toEqual({ left: 7.5, bottom: 7.5, right: 7.5, top: 7.5 });
      expect(l1!.viewports).toHaveLength(1);
      const vp = l1!.viewports[0]!;
      expect(vp).toMatchObject({ width: 200, height: 120, layer: 'VPORTS', on: true });
      expect(vp.view.center).toEqual({ x: 50, y: 25 });
      close(vp.view.scale, 2);
      // Paper-space content: AutoCAD's paper origin is the printable-area corner (margin offset).
      close(vp.center.x, 157.5);
      close(vp.center.y, 107.5);
      expect(l1!.entities.map((e) => (e.type === 'text' ? e.text : e.type))).toEqual(['TITLE']);
      expect(l2!.paper).toMatchObject({ id: 'a4', orientation: 'portrait' });
      expect(l2!.entities.map((e) => (e.type === 'text' ? e.text : e.type))).toEqual(['SHEET 2']);
      expect(l2!.viewports).toHaveLength(0);
    });
  });
}

describe('objects in their own plane (extrusion 0,0,-1, as MIRROR leaves them)', () => {
  const s = readDxf(fixture('unsupported-content.dxf'));
  it('a mirrored arc is placed in world coordinates', () => {
    const arc = s.entities.find((e): e is ArcEntity => e.type === 'arc')!;
    expect(arc.center).toEqual({ x: 20, y: 5 });
    close(arc.startAngle, Math.PI / 2);
    close(arc.endAngle, Math.PI);
    const back = readDxf(writeDxf(s)).entities.find((e): e is ArcEntity => e.type === 'arc')!;
    expect(back.center).toEqual({ x: 20, y: 5 });
    close(back.startAngle, Math.PI / 2);
  });
  it('mirrored circles and polylines flip, bulges change sign', () => {
    const dxf = (body: string) => `0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`;
    const c = readDxf(dxf('0\nCIRCLE\n8\n0\n10\n3\n20\n4\n40\n1\n230\n-1\n')).entities[0] as CircleEntity;
    expect(c.center).toEqual({ x: -3, y: 4 });
    const p = readDxf(dxf('0\nLWPOLYLINE\n8\n0\n90\n2\n70\n0\n10\n1\n20\n0\n42\n0.5\n10\n2\n20\n0\n230\n-1\n')).entities[0] as PolylineEntity;
    expect(p.points).toEqual([{ x: -1, y: 0 }, { x: -2, y: 0 }]);
    expect(p.bulges).toEqual([-0.5, 0]);
  });
  it('a mirrored block reference is placed, reversed and mirrored (not reported), and round-trips', () => {
    const blocks = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '8', '0', '2', 'B', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'B', '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0', '0', 'ENDBLK', '0', 'ENDSEC'].join('\n');
    const ins = ['0', 'INSERT', '8', '0', '2', 'B', '10', '10', '20', '5', '30', '0', '41', '2', '42', '2', '43', '1', '50', '30', '210', '0', '220', '0', '230', '-1'].join('\n');
    const s = readDxf(`${blocks}\n0\nSECTION\n2\nENTITIES\n${ins}\n0\nENDSEC\n0\nEOF\n`);
    const check = (st: DrawingState) => {
      const i = st.entities[0] as InsertEntity;
      expect(i.position).toEqual({ x: -10, y: 5 });
      close(i.rotation, -Math.PI / 6);
      expect(i.mirror).toBe(true);
      expect(i.scale).toBe(2);
      // The block's line from (0,0) to (1,0): in the mirrored plane it runs from (-10,5) towards -x, turned by -30 degrees.
      const line = explodeInsert(i, (n) => st.blocks[n])[0] as LineEntity;
      close(line.a.x, -10);
      close(line.a.y, 5);
      close(line.b.x, -10 - 2 * Math.cos(Math.PI / 6));
      close(line.b.y, 5 + 2 * Math.sin(Math.PI / 6));
    };
    check(s);
    expect(importReportOf(s)).toBeUndefined();
    check(readDxf(writeDxf(s)));
  });
});
