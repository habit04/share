/**
 * Interchange fixtures (tests/fixtures/interchange/): the R2000 files and r2018-table.dxf were
 * written by hand from the public DXF reference, laid out the way AutoCAD 2000 (AC1015) and
 * AutoCAD 2018 (AC1032) save them; r2018-dimensions.dxf, r2018-image-inches.dxf,
 * r2018-mtext.dxf and r2018-truecolor-linetypes.dxf are genuine AutoCAD 2027 R2018 saves that
 * replaced hand-authored originals in the 2026-10-21 fixture swap (see
 * tests/fixtures/interchange/PROVENANCE.md). None comes from JCad's writer. Each fixture is
 * checked after import (the bytes decoded as the app decodes them, then readDxf) and again
 * after a writeDxf -> readDxf round trip.
 *
 * Every describe block starts with what must survive and what docs/SUPPORT-MATRIX.md says is
 * lost; losses the matrix documents are asserted as losses. Where the reader or writer drops
 * something the matrix says is kept, the expectation is an it.todo with a one-line reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { readTableStyle } from '../src/io/dxf/read-annotations';
import type { Obj } from '../src/io/dxf/groups';
import { decodeDxfBytes, textStyleOf, textStylesOf } from '../src/io/encoding';
import { importReportOf } from '../src/io/import-report';
import type { DrawingState } from '../src/core/document';
import type { Entity, InsertEntity, DimensionEntity, MTextEntity, HatchEntity, PolylineEntity, SplineEntity, EllipseEntity, TableEntity, ImageEntity, TextEntity, LineEntity, CircleEntity, ArcEntity } from '../src/core/entities';
import { explodeInsert, splineCurve, dimensionParts } from '../src/core/entities';
import { namedDimStyles, dimensionMeasurement, dimensionText, dimensionTextLayout } from '../src/core/dimension';
import { parseMText, mtextLayout, type MTextItem } from '../src/core/mtext';
import { nurbsPoint, nurbsPoints } from '../src/core/spline';
import { loopPolygon, pointInLoops } from '../src/core/hatch';
import { tableGeometry } from '../src/core/table';
import { formatLength } from '../src/core/units';
import type { Point } from '../src/core/geometry';
import { resolveColor, trueColorCss } from '../src/render/draw';
import { aciToCss } from '../src/render/palette';

// ---------------------------------------------------------------- helpers

interface Fixture {
  imported: DrawingState;
  written: string;
  roundTripped: DrawingState;
}

const dir = join(__dirname, 'fixtures', 'interchange');

function fixture(name: string): Fixture {
  // AC1015 text is decoded in its $DWGCODEPAGE, AC1032 as UTF-8 (io/encoding.ts), as the app does.
  const imported = readDxf(decodeDxfBytes(readFileSync(join(dir, name))).text);
  const written = writeDxf(imported);
  return { imported, written, roundTripped: readDxf(written) };
}

const both = (f: Fixture): Array<[string, DrawingState]> => [
  ['after import', f.imported],
  ['after a writeDxf -> readDxf round trip', f.roundTripped],
];

const ofType = <T extends Entity>(list: readonly Entity[], type: T['type']): T[] => list.filter((e): e is T => e.type === type);
const layerOf = (s: DrawingState, name: string) => s.layers.find((l) => l.name === name);
const close = (a: number | undefined, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);
const closePt = (p: Point | undefined, x: number, y: number, digits = 6) => {
  expect(p).toBeDefined();
  close(p!.x, x, digits);
  close(p!.y, y, digits);
};
const rad = (deg: number) => (deg * Math.PI) / 180;
const textOf = (items: readonly MTextItem[]) => items.map((it) => (it.kind === 'text' ? it.text : `${it.top}|${it.bottom}`)).join('');

/** The group pairs of every object of one kind in DXF text (to check what the writer put in the file). */
function records(dxf: string, kind: string): Array<Array<[number, string]>> {
  const lines = dxf.split(/\r\n|\n/);
  const out: Array<Array<[number, string]>> = [];
  let cur: Array<[number, string]> | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    const value = lines[i + 1]!;
    if (code === 0) {
      cur = value === kind ? [] : null;
      if (cur) out.push(cur);
    } else cur?.push([code, value]);
  }
  return out;
}
const group = (rec: ReadonlyArray<[number, string]> | undefined, code: number): string | undefined => rec?.find(([c]) => c === code)?.[1];

// ---------------------------------------------------------------- layouts, viewports, title block

/*
 * Survives: units; layer colours, lineweights (Default -3 reads as 0.25), no-plot flag, linetype;
 * the HIDDEN linetype pattern; text style ROMANS; layouts in tab order with paper, margins, plot
 * scale, plot style and the lineweight flag; viewports (centre moved from AutoCAD's plot origin to
 * the sheet corner, size, view centre, scale, frozen layer, display lock, off); the title block
 * INSERT and its ATTRIB values, a per-insert hidden ATTRIB, invisible and constant ATTDEFs;
 * paper-space MTEXT with code-page 1252 characters and \U+ escapes.
 * Lost (matrix: "A drawing always opens in the Model tab"): the active layout ($TILEMODE 0).
 */
describe('r2000-layouts-titleblock.dxf: layouts, paper-space viewports, title block INSERT with ATTRIBs (AC1015)', () => {
  const f = fixture('r2000-layouts-titleblock.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const [a3, detail] = s.layouts ?? [];

    it('has no import losses; units, layers, linetype and text style', () => {
      expect(importReportOf(s)?.items).toContainEqual(expect.objectContaining({ type: 'STYLE', action: 'unsupported', reason: expect.stringContaining('stroke font') }));
      expect(s.header?.units).toMatchObject({ insunits: 4, lunits: 2, luprec: 1 });
      expect(layerOf(s, '0')).toMatchObject({ color: 7, lineWeight: 0.25 });
      expect(layerOf(s, 'TITLE')).toMatchObject({ color: 7, lineWeight: 0.5 });
      expect(layerOf(s, 'VPORTS')).toMatchObject({ color: 8, plot: false });
      expect(layerOf(s, 'EQUIPMENT')).toMatchObject({ color: 3, lineWeight: 0.35 });
      expect(layerOf(s, 'HIDDEN')).toMatchObject({ color: 1, linetype: 'HIDDEN', lineWeight: 0.18 });
      expect(s.header?.linetypes).toEqual([{ name: 'HIDDEN', description: 'Hidden __ __ __ __ __ __ __ __ __ __ __ __ __ __', pattern: [6.35, -3.175] }]);
      expect(textStylesOf(s).ROMANS).toMatchObject({ font: 'romans.shx', widthFactor: 0.9 });
      expect(s.entities.map((e) => e.type)).toEqual(['polyline', 'line', 'circle', 'text']);
    });

    it('layouts in tab order with paper, margins, plot scale, plot style and lineweight flag', () => {
      expect(s.layouts?.map((l) => l.name)).toEqual(['A3 Sheet', 'Detail']);
      expect(a3!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'landscape' });
      expect(a3!.margins).toEqual({ left: 7.5, bottom: 20, right: 7.5, top: 20 });
      expect(a3!).toMatchObject({ plotScale: '1:1', plotStyle: 'monochrome' });
      expect(a3!.plotLineweights).not.toBe(false);
      expect(detail!.paper).toMatchObject({ id: 'a4', units: 'mm', orientation: 'portrait' });
      expect(detail!.margins).toEqual({ left: 5, bottom: 5, right: 5, top: 5 });
      expect(detail!).toMatchObject({ plotScale: '1:2', plotStyle: 'color', plotLineweights: false });
    });

    it('A3 Sheet viewports: 1:50 with a layer frozen in it, 1:10 display-locked; paper origin at the sheet corner', () => {
      const [main, zoom] = a3!.viewports;
      expect(a3!.viewports).toHaveLength(2);
      // AutoCAD's paper 0,0 is the corner of the printable area: + margins (7.5, 20).
      closePt(main!.center, 147.5, 160);
      expect(main).toMatchObject({ width: 260, height: 210, layer: 'VPORTS', on: true, frozenLayers: ['ANNO-DETAIL'] });
      closePt(main!.view.center, 2600, 1500);
      close(main!.view.scale, 1 / 50);
      expect(main!.view.locked).toBeFalsy();
      closePt(zoom!.center, 347.5, 200);
      expect(zoom).toMatchObject({ width: 110, height: 100, on: true });
      expect(zoom!.frozenLayers).toBeUndefined();
      closePt(zoom!.view.center, 1200, 800);
      close(zoom!.view.scale, 1 / 10);
      expect(zoom!.view.locked).toBe(true);
    });

    it('Detail viewports: 1:5 on, a second one off; paper-space TEXT from *Paper_Space0', () => {
      const [on, off] = detail!.viewports;
      closePt(on!.center, 105, 155);
      close(on!.view.scale, 1 / 5);
      expect(on!.on).toBe(true);
      closePt(off!.center, 105, 30);
      expect(off!.on).toBe(false);
      const t = ofType<TextEntity>(detail!.entities, 'text')[0]!;
      expect(t).toMatchObject({ text: 'DETAIL A - TERMINAL STRIP', height: 5, layer: 'TITLE' });
      closePt(t.position, 25, 275);
      expect(textStyleOf(t)).toBe('ROMANS');
    });

    it('title block INSERT: ATTRIB values, REV hidden on this insert, DRAWN invisible, COMPANY constant', () => {
      const ins = ofType<InsertEntity>(a3!.entities, 'insert')[0]!;
      expect(ins).toMatchObject({ block: 'TITLEBLOCK', layer: 'TITLE', scale: 1, rotation: 0, hiddenAttributes: ['REV'] });
      closePt(ins.position, 7.5, 20);
      expect(ins.attributes).toEqual({ TITLE: 'MOTOR CONTROL CENTRE', DWGNO: 'E-101', REV: 'B', DRAWN: 'J. ROD' });
      const def = s.blocks.TITLEBLOCK!;
      expect(def.attributes.map((a) => [a.tag, a.prompt, a.default, !!a.invisible])).toEqual([
        ['TITLE', 'Drawing title', 'UNTITLED', false],
        ['DWGNO', 'Drawing number', '', false],
        ['REV', 'Revision', 'A', false],
        ['DRAWN', 'Drawn by', '', true],
        ['COMPANY', '', 'JCAD ELECTRICAL', false],
      ]);
      expect(def.attributes[4]).toMatchObject({ constant: true });
      expect(def.attributes[0]).toMatchObject({ align: 'center', height: 5, position: { x: 345, y: 30 } });
      // Shown: the block's own text, then TITLE, DWGNO and the constant COMPANY (REV and DRAWN are not).
      const shown = ofType<TextEntity>(explodeInsert(ins, (n) => s.blocks[n]), 'text');
      expect(shown.map((t) => t.text)).toEqual(['DWG NO.', 'MOTOR CONTROL CENTRE', 'E-101', 'JCAD ELECTRICAL']);
      closePt(shown[1]!.position, 352.5, 50);
    });

    it('paper-space MTEXT: code page 1252 (degree, plus-minus, multiplication) and \\U+2300 decoded', () => {
      const m = ofType<MTextEntity>(a3!.entities, 'mtext')[0]!;
      expect(m.text).toBe('NOTES:\n1. ALL DIMENSIONS IN mm.\n2. CABLE \u2300 16 mm, BEND RADIUS 6\u00d7\u2300\n3. AMBIENT 40\u00b0C \u00b15');
      expect(m).toMatchObject({ height: 2.5, width: 120, attachment: 1 });
      closePt(m.position, 17.5, 270);
      expect(textStyleOf(m)).toBe('ROMANS');
    });
  });

  it('lost as the matrix says: saved with a layout active ($TILEMODE 0), it opens in the Model tab', () => {
    expect(f.imported.space).toBeUndefined();
    expect(f.roundTripped.space).toBeUndefined();
  });
});

// ---------------------------------------------------------------- dimensions (R2018)

/*
 * Survives: the current style from $DIMSTYLE + header $DIM*; named styles with their DIM* values,
 * arrowheads named by DIMBLK / DIMBLK1 / DIMBLK2 handles (DIMSAH), tolerances, DIM colours; the
 * arrowhead blocks; linear (with DIMTEDIT 53 and DIMEDIT 52), aligned, radius, diameter (text
 * override, moved text), angular 2-line and 3-point, and XY ordinate with their definition points and styles;
 * DIMDSEP, DIMTXSTY, DIMLWD / DIMLWE, DIMTZIN and per-dimension DSTYLE overrides.
 * Lost (matrix): arrowheads written in JCAD_DIMSTYLE
 * XDATA rather than as handles; 2-line angular written as 3-point; other XDATA (ACAD_DSTYLE_*).
 */
describe('r2018-dimensions.dxf: named DIMSTYLEs with XDATA, DIMENSIONs with their *D blocks (AC1032)', () => {
  const f = fixture('r2018-dimensions.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const dims = ofType<DimensionEntity>(s.entities, 'dimension');
    const style = (name: string) => namedDimStyles(s).find((d) => d.name === name);

    it('the current style ISO-25 from $DIMSTYLE and the header $DIM* variables', () => {
      expect(s.header?.dimStyle).toMatchObject({
        name: 'ISO-25',
        textHeight: 2.5,
        arrowSize: 2.5,
        extOffset: 0.625,
        extExtend: 1.25,
        textGap: 0.625,
        decimals: 2,
        textVertical: 'above',
        textAlign: 'aligned',
        suppressTrailingZeros: true,
        dimLineInside: true,
      });
    });

    it('named styles: ISO-25, ARCH-TICK (DIMBLK by handle), MECH-TOL (tolerances, DIMSAH arrows by handle, colours)', () => {
      expect(namedDimStyles(s).map((d) => d.name)).toEqual(['Standard', 'ARCH-TICK', 'ISO-25', 'MECH-TOL']);
      expect(style('ISO-25')).toMatchObject({ textHeight: 2.5, arrowSize: 2.5, baselineSpacing: 3.75, centerMark: 2.5, altFactor: 0.0394, altDecimals: 3, tolDecimals: 2, suppressTrailingZeros: true });
      expect(style('ISO-25')!.arrow ?? 'closed-filled').toBe('closed-filled');
      expect(style('ARCH-TICK')).toMatchObject({ arrow: 'arch-tick', arrowSize: 3, textHeight: 3.5, dimLineExtend: 2, decimals: 0, extOffset: 1.5, extExtend: 2, textGap: 1 });
      expect(style('MECH-TOL')).toMatchObject({
        tolerance: 'deviation',
        tolPlus: 0.1,
        tolMinus: 0.05,
        tolScale: 0.7,
        suppressExt1: true,
        dimLineColor: 1,
        extLineColor: 5,
        textColor: 3,
        arrow: 'oblique',
        arrow2: 'dot',
      });
    });

    it('arrowhead blocks stay blocks; the anonymous *D pictures do not', () => {
      expect(Object.keys(s.blocks).sort()).toEqual(['_ArchTick', '_Dot', '_Oblique']);
      expect(textStylesOf(s).ISOCP).toMatchObject({ font: 'isocp.shx' });
    });

    it('nine dimensions with their kinds and styles, including the native X ordinate', () => {
      expect(dims.map((d) => [d.kind, d.style.name, d.layer])).toEqual([
        ['linear', 'ISO-25', 'DIMS'],
        ['linear', 'ARCH-TICK', 'DIMS'],
        ['aligned', 'ISO-25', 'DIMS'],
        ['radius', 'ISO-25', 'DIMS'],
        ['diameter', 'MECH-TOL', 'DIMS'],
        ['angular', 'ISO-25', 'DIMS'],
        ['angular', 'MECH-TOL', 'DIMS'],
        ['ordinate', 'ISO-25', 'DIMS'],
        ['linear', 'ISO-25', 'DIMS'],
      ]);
      // Styles are resolved by name: the dimension carries the named record, not the header copy.
      expect(dims[1]!.style.arrow).toBe('arch-tick');
      expect(dims[4]!.style.tolerance).toBe('deviation');
    });

    it('linear: horizontal with the DIMTEDIT text angle (53), vertical with the DIMEDIT oblique angle (52)', () => {
      const [h, v] = dims;
      closePt(h!.p1, 0, 0);
      closePt(h!.p2, 100, 0);
      closePt(h!.linePoint, 100, -15);
      close(h!.rotation, 0);
      close(h!.textRotation, rad(15));
      close(dimensionMeasurement(h!), 100);
      expect(dimensionText(h!)).toBe('100');
      closePt(v!.p1, 100, 0);
      closePt(v!.p2, 100, 60);
      close(v!.rotation, Math.PI / 2);
      close(v!.oblique, rad(30));
      // The dimension line is the vertical through x = 115 (the defining point slides along it).
      close(v!.linePoint.x, 115);
      close(dimensionMeasurement(v!), 60);
      expect(dimensionText(v!)).toBe('60');
    });

    it('aligned, radius and diameter (text override "2X <>", user-positioned text)', () => {
      const al = dims[2]!;
      closePt(al.p1, 0, 60);
      closePt(al.p2, 60, 100);
      closePt(al.linePoint, 54.45299803774771, 108.32050294337844);
      close(dimensionMeasurement(al), Math.sqrt(60 * 60 + 40 * 40));
      const r = dims[3]!;
      closePt(r.p1, 200, 30);
      closePt(r.p2, 218.008005337287, 47.34104217664675);
      // The genuine file stores the leader endpoint on the arc at AutoCAD's picked angle and the
      // text point (11/21) it computed; the synthetic hand-placed both at idealized 45-degree spots.
      closePt(r.linePoint, 227, 55.99999999999994, 5);
      close(dimensionMeasurement(r), 25);
      expect(dimensionText(r)).toBe('R25');
      const dia = dims[4]!;
      closePt(dia.p1, 200, 100);
      expect(dia.text).toBe('2X <>');
      closePt(dia.textPosition, 230, 117.32050807568876);
      close(dimensionMeasurement(dia), 40);
      // The chord stays on the 30-degree line through the centre (either end may define it).
      const u = { x: Math.cos(rad(30)), y: Math.sin(rad(30)) };
      close((dia.p2.x - 200) * u.y - (dia.p2.y - 100) * u.x, 0, 5);
      expect(dimensionTextLayout(dia).main).toBe('2X %%c40');
    });

    it('angular between two lines and by three points', () => {
      const a2 = dims[5]!;
      closePt(a2.center, 300, 0);
      // AutoCAD stores the two lines' endpoints in its own order (p1 = the 60-degree line's end);
      // the synthetic stored them in the opposite order. Same lines, same angle.
      closePt(a2.p1, 330, 51.96152422706632);
      closePt(a2.p2, 360, 0);
      closePt(a2.linePoint, 337.5877048314363, 13.68080573302674);
      close(dimensionMeasurement(a2), Math.PI / 3);
      expect(dimensionText(a2)).toBe('60%%d');
      const a3 = dims[6]!;
      closePt(a3.center, 400, 0);
      closePt(a3.p1, 450, 0);
      closePt(a3.p2, 400, 50);
      closePt(a3.linePoint, 425.980762113533, 14.99999999999997);
      close(dimensionMeasurement(a3), Math.PI / 2);
    });

    it('the dimension carrying DSTYLE overrides keeps its geometry and its named style', () => {
      const d = dims[8]!;
      closePt(d.p1, 0, 120);
      closePt(d.p2, 60, 120);
      closePt(d.linePoint, 60, 130);
      expect(d.style.name).toBe('ISO-25');
    });

    it('the ordinate keeps native group 10 datum, group 13 feature, group 14 endpoint and X coordinate', () => {
      const d = dims[7]!;
      expect(d.kind).toBe('ordinate'); expect(d.ordinateAxis).toBe('x'); close(d.ordinateRotation, 0);
      closePt(d.p1, 0, 0); closePt(d.p2, 100, 60); closePt(d.linePoint, 100, 80);
      close(dimensionMeasurement(d), 100); expect(dimensionText(d)).toBe('100'); expect(d.textPosition).toBeUndefined();
    });
  });

  it('writes the ordinate with its native subclass and flags without adding a dropped-object report', () => {
    for (const [, s] of both(f)) expect(importReportOf(s)?.items.filter((i) => i.action === 'dropped') ?? []).toEqual([]);
    const [rec] = records(f.written, 'DIMENSION').filter((r) => r.some(([c, v]) => c === 100 && v === 'AcDbOrdinateDimension'));
    expect(rec).toBeDefined(); expect(Number(group(rec, 70))).toBe(102);
    expect([10, 20, 13, 23, 14, 24, 42].map((code) => Number(group(rec, code)))).toEqual([0, 0, 100, 60, 100, 80, 100]);
    expect(Number(group(rec, 51)) % 360).toBe(0);
    expect(importReportOf(f.roundTripped)?.items.every((i) => i.action === 'unsupported' || i.action === 'kept')).toBe(true);
  });

  it('writes arrowheads through JCAD_DIMSTYLE and angular geometry as three points while preserving source style XDATA', () => {
    const arch = records(f.written, 'DIMSTYLE').find((r) => group(r, 2) === 'ARCH-TICK')!;
    expect(arch.some(([c]) => c === 342 || c === 343 || c === 344)).toBe(false);
    expect(arch).toContainEqual([1001, 'JCAD_DIMSTYLE']);
    expect(arch).toContainEqual([1000, '_ARCHTICK']);
    expect(f.written).not.toContain('AcDb2LineAngularDimension');
    expect(f.written.match(/AcDb3PointAngularDimension/g)).toHaveLength(2);
    expect(f.written).toContain('ACAD_DSTYLE_DIMJAG');
    expect(f.written).toContain('ACAD_DSTYLE_DIMTALN');
  });

  // The reader gaps below were closed by porting PR #2 (codex/electrical-review-fixes 2f89b0e).
  it('ISO-25 keeps DIMDSEP 44 (group 278, decimal comma): the aligned dimension reads "72,11"', () => {
    for (const [, s] of both(f)) {
      const d = ofType<DimensionEntity>(s.entities, 'dimension')[2]!;
      expect(d.style.decimalSeparator).toBe(44);
      expect(dimensionText(d)).toBe('72,11');
    }
    expect(group(records(f.written, 'DIMSTYLE').find((r) => group(r, 2) === 'ISO-25'), 278)).toBe('44');
  });
  it('ISO-25 keeps DIMTXSTY (group 340 -> text style ISOCP), draws its text in it and writes it back', () => {
    for (const [, s] of both(f)) {
      const d = ofType<DimensionEntity>(s.entities, 'dimension')[2]!;
      expect(d.style.textStyle).toBe('ISOCP');
      const texts = dimensionParts(d).filter((p) => p.type === 'text');
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.every((p) => textStyleOf(p) === 'ISOCP')).toBe(true);
    }
    const isocp = records(f.written, 'STYLE').find((r) => group(r, 2) === 'ISOCP');
    expect(group(records(f.written, 'DIMSTYLE').find((r) => group(r, 2) === 'ISO-25'), 340)).toBe(group(isocp, 5));
  });
  it('ARCH-TICK keeps DIMLWD 0.18 / DIMLWE 0.13 (groups 371 / 372) for its dimension and extension lines', () => {
    for (const [, s] of both(f)) expect(namedDimStyles(s).find((d) => d.name === 'ARCH-TICK')).toMatchObject({ dimLineWeight: 0.18, extLineWeight: 0.13 });
    const rec = records(f.written, 'DIMSTYLE').find((r) => group(r, 2) === 'ARCH-TICK');
    expect([group(rec, 371), group(rec, 372)]).toEqual(['18', '13']);
  });
  it('MECH-TOL tolerances follow DIMTZIN (group 284, 0 here): the diameter tolerance reads +0,10 / -0,05', () => {
    for (const [, s] of both(f)) {
      const d = ofType<DimensionEntity>(s.entities, 'dimension')[4]!;
      expect(d.style.toleranceZeroSuppression).toBe(0);
      expect(dimensionTextLayout(d)).toMatchObject({ upper: '+0,10', lower: '-0,05' });
    }
  });
  it('the last linear dimension applies its DSTYLE overrides (ACAD XDATA: DIMTXT 5, DIMDEC 0) and keeps them on save', () => {
    for (const [, s] of both(f)) expect(ofType<DimensionEntity>(s.entities, 'dimension')[8]!.style).toMatchObject({ name: 'ISO-25', textHeight: 5, decimals: 0 });
    const dims = records(f.written, 'DIMENSION');
    expect(dims.filter((r) => r.some(([c, v]) => c === 1000 && v === 'DSTYLE'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- dimensions (R2000, inches)

/*
 * Survives: inch units; the current style ELEC with DIMPOST, alternate units (DIMALT / DIMALTF /
 * DIMALTD / DIMAPOST) and decimals; linear text override, aligned, radius with moved text, angular
 * between two lines that do not meet (vertex at the intersection).
 * Lost (matrix: 2-line angular "read as angular"): written back as a 3-point angular whose vertex
 * is the computed intersection.
 */
describe('r2000-dimensions.dxf: inch drawing, DIMPOST and alternate units, text override (AC1015)', () => {
  const f = fixture('r2000-dimensions.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const dims = ofType<DimensionEntity>(s.entities, 'dimension');

    it('inch units and the current style ELEC with prefix / suffix and alternate millimetres', () => {
      expect(importReportOf(s)).toBeUndefined();
      expect(s.header?.units).toMatchObject({ insunits: 1, lunits: 2, luprec: 3 });
      expect(s.header?.dimStyle).toMatchObject({
        name: 'ELEC',
        textHeight: 0.125,
        arrowSize: 0.125,
        textGap: 0.0625,
        decimals: 3,
        post: '<>"',
        altUnits: true,
        altFactor: 25.4,
        altDecimals: 1,
        altPost: '[]mm',
        textVertical: 'above',
      });
      expect(namedDimStyles(s).map((d) => d.name)).toEqual(['Standard', 'ELEC']);
      expect(Object.keys(s.blocks)).toEqual([]);
    });

    it('linear with a text override, aligned on the chamfer, radius with moved text', () => {
      expect(dims.map((d) => [d.kind, d.style.name])).toEqual([
        ['linear', 'ELEC'],
        ['aligned', 'ELEC'],
        ['radius', 'ELEC'],
        ['angular', 'ELEC'],
      ]);
      const [lin, al, r] = dims;
      expect(lin!.text).toBe('<> TYP.');
      closePt(lin!.p2, 24, 0);
      closePt(lin!.linePoint, 24, -2);
      close(dimensionMeasurement(lin!), 24);
      closePt(al!.p1, 24, 32);
      closePt(al!.p2, 20, 36);
      closePt(al!.linePoint, 21.06066017177982, 37.06066017177982);
      close(dimensionMeasurement(al!), Math.sqrt(32));
      closePt(r!.p1, 12, 30);
      closePt(r!.textPosition, 9.5, 32.5);
      close(dimensionMeasurement(r!), 1.5);
      // DIMPOST <>" puts the inch mark after the value.
      expect(dimensionTextLayout(lin!).main.startsWith('24.000" TYP.')).toBe(true);
      expect(dimensionTextLayout(al!).main.startsWith('5.657"')).toBe(true);
      expect(dimensionTextLayout(r!).main.startsWith('R1.500"')).toBe(true);
    });

    it('angular between two lines that do not meet: the vertex is their intersection', () => {
      const a = dims[3]!;
      closePt(a.center, 0, 4);
      closePt(a.p1, 10, 4);
      closePt(a.p2, 8, 12);
      closePt(a.linePoint, 6.467156727579007, 6.678784026555629);
      close(dimensionMeasurement(a), Math.PI / 4);
    });
  });

  it('lost as the matrix says: the 2-line angular dimension is written as a 3-point angular at the intersection', () => {
    expect(f.written).not.toContain('AcDb2LineAngularDimension');
    const rec = records(f.written, 'DIMENSION').find((r) => r.some(([c, v]) => c === 100 && v === 'AcDb3PointAngularDimension'))!;
    // Vertex (15/25) is the computed intersection; the original leg start points (4,4) and (4,8) are gone.
    expect([Number(group(rec, 15)), Number(group(rec, 25))]).toEqual([0, 4]);
  });

  it('DIMAPOST "[]mm" uses the AutoCAD "[]" placeholder: the aligned dimension reads 5.657" [143.7mm]', () => {
    for (const [, s] of both(f)) expect(dimensionText(ofType<DimensionEntity>(s.entities, 'dimension')[1]!)).toBe('5.657" [143.7mm]');
  });
});

// ---------------------------------------------------------------- MTEXT (R2018)

/*
 * Survives: plain text of every paragraph; the formatted source (raw) verbatim, which keeps \f,
 * \C, \H, \L / \O, \p, \W, \Q, \T and stacks for display; a 250-character group 3 chunk plus
 * group 1; rotation by direction vector, attachment, line spacing, colour, style; UTF-8 text;
 * static columns (written as JCAD_MTEXT_COLUMNS XDATA).
 * Lost (matrix, "Fonts and text": the writer produces pure ASCII with \U+XXXX escapes): the
 * UTF-8 bytes become escapes in the saved AC1015 file (the text itself survives).
 */
describe('r2018-mtext.dxf: MTEXT formatting codes, stacked fractions, columns, long text (AC1032)', () => {
  const f = fixture('r2018-mtext.dxf');
  const RAW1 =
    '{\\fArial|b1|i0|c0|p34;MOTOR CONTROL}\\P{\\C1;Red text} and {\\C256;bylayer text}\\P\\H5;Big \\H0.5x;half\\P\\LUnderline\\l and \\OOverline\\o\\P\\pxqc;Centred paragraph';
  const BODY =
    'ALL CONTROL WIRING SHALL BE 1.5 MM2 STRANDED COPPER, 90 DEGREE C INSULATION, NUMBERED AT BOTH ENDS WITH HEAT-SHRINK MARKERS. POWER WIRING SHALL BE SIZED FOR THE BREAKER RATING. PROTECTIVE EARTH CONDUCTORS SHALL BE GREEN/YELLOW. SPARE TERMINALS: 20 PERCENT MINIMUM PER STRIP. ALL CABINETS SHALL BE IP54 OR BETTER AND SHALL CARRY THE PANEL NAMEPLATE.';
  const RAW5 = `{\\Fromans.shx|c0;\\W0.8;\\Q15;\\T1.1;SPECIFICATION:}\\P${BODY}`;

  describe.each(both(f))('%s', (_label, s) => {
    const m = ofType<MTextEntity>(s.entities, 'mtext');

    it('five MTEXT entities with font and external column display limitations reported', () => {
      expect(importReportOf(s)?.items).toContainEqual(expect.objectContaining({ type: 'MTEXT', reason: expect.stringContaining('column definitions') }));
      expect(m).toHaveLength(5);
    });

    it('paragraphs (\\P), font with bold (\\f), colours (\\C), heights (\\H), underline / overline, centred paragraph (\\pxqc)', () => {
      const m1 = m[0]!;
      expect(m1).toMatchObject({ text: 'MOTOR CONTROL\nRed text and bylayer text\nBig half\nUnderline and Overline\nCentred paragraph', height: 3.5, width: 120, attachment: 1, layer: 'NOTES' });
      expect(m1.raw).toBe(RAW1);
      closePt(m1.position, 10, 130);
      const p = parseMText(m1.raw!, m1.height);
      expect(p.map((q) => textOf(q.items))).toEqual(['MOTOR CONTROL', 'Red text and bylayer text', 'Big half', 'Underline and Overline', 'Centred paragraph']);
      expect(p[0]!.items[0]!.style.bold).toBe(true);
      expect(p[1]!.items.map((it) => it.style.color)).toEqual([1, undefined, undefined]);
      expect(p[2]!.items.map((it) => it.style.height)).toEqual([5, 2.5]);
      expect(p[3]!.items.map((it) => [it.style.underline, it.style.overline])).toEqual([
        [true, false],
        [false, false],
        [false, true],
      ]);
      expect(p[4]!.align).toBe('center');
    });

    it('stacked fractions: horizontal (/), tolerance (^) and diagonal (#)', () => {
      const m2 = m[1]!;
      expect(m2).toMatchObject({ text: 'PIPE 1 1/2" SCH 40\nGAP 3+0.05 -0.02\nRATIO 3/4', width: 0, attachment: 7 });
      const stacks = parseMText(m2.raw!, m2.height).map((q) => q.items.filter((it) => it.kind === 'stack'));
      expect(stacks.map((st) => st.map((it) => (it.kind === 'stack' ? [it.top, it.bottom, it.type] : null)))).toEqual([[['1', '2', '/']], [['+0.05', '-0.02', '^']], [['3', '4', '#']]]);
    });

    it('static columns: the column break (\\N) separates paragraphs and stays in the source', () => {
      const m3 = m[2]!;
      expect(m3.text).toBe('COLUMN ONE FIRST LINE\nCOLUMN ONE SECOND LINE\nCOLUMN TWO FIRST LINE\nCOLUMN TWO SECOND LINE');
      expect(m3.raw).toContain('\\N');
      // The genuine entity's reference width (group 41) is the TOTAL width 125 = 2x60 + 5;
      // the 60 column width lives in the embedded object (checklist r2018-mtext #11).
      // The synthetic carried 60 in both places.
      expect(m3.width).toBe(125);
    });

    it('rotated by its direction vector, middle centre, line spacing 1.5, SHX style, UTF-8 characters', () => {
      const m4 = m[3]!;
      expect(m4).toMatchObject({ text: '\u00d825 \u00b10,1\nCURRENT 4\u201320 mA\n\u03a9 \u2248 1.5 k\u03a9', attachment: 5, lineSpacing: 1.5, color: 5, width: 50, height: 2.5 });
      close(m4.rotation, Math.PI / 2);
      closePt(m4.position, 250, 70);
      expect(textStyleOf(m4)).toBe('ROMANS');
    });

    it('399 characters from a group 3 chunk and group 1, with \\F SHX font, \\W width, \\Q oblique and \\T tracking', () => {
      const m5 = m[4]!;
      expect(m5.raw).toBe(RAW5);
      expect(m5.text).toBe(`SPECIFICATION:\n${BODY}`);
      const first = parseMText(m5.raw!, m5.height)[0]!.items[0]!;
      expect(first.style.widthFactor).toBe(0.8);
      close(first.style.oblique, rad(15));
    });
  });

  it('keeps the source AC1032 version and writes its Unicode text as UTF-8', () => {
    expect(f.written).toContain('AC1032');
    expect(f.written).toContain('Ø25 ±0,1');
  });

  it('MTEXT static columns (R2018 embedded object: 2 columns 60 wide, gutter 5) are kept, and each column is laid out at its offset', () => {
    for (const [, s] of both(f)) {
      const m = ofType<MTextEntity>(s.entities, 'mtext')[2]!;
      // No per-column heights in the genuine file (group 46 carries only the defined height 20,
      // which the heights follow; checklist r2018-mtext #13). The synthetic pinned [20, 20].
      expect(m.columns).toMatchObject({ type: 1, count: 2, width: 60, gutter: 5, heights: [] });
      const parts = mtextLayout(m, (t, h) => t.length * h * 0.1);
      const origins = [...new Set(parts.filter((t) => t.text === 'COLUMN').map((t) => t.position.x))];
      expect(origins[1]! - origins[0]!).toBeCloseTo(65);
    }
    // The established column interchange is retained alongside source metadata.
    expect(f.written).toContain('\r\n1001\r\nJCAD_MTEXT_COLUMNS\r\n');
    expect(records(f.written, 'APPID').map((r) => group(r, 2))).toContain('JCAD_MTEXT_COLUMNS');
  });
});

/*
 * MTEXT columns in the R2018 embedded object, the three kinds AutoCAD writes (group layout as the
 * independent ezdxf library reads and writes it): 71 type, 72 count, 44 width, 45 gutter, 73 auto
 * height, 74 reversed flow, 46 heights. Dynamic columns with auto height - AutoCAD's default for new
 * columns - are saved with a count of 0, taken from the total width (42).
 */
describe('MTEXT columns in the R2018 embedded object: static, dynamic auto height, dynamic manual height, reversed flow', () => {
  const mtext = (y: number, embedded: Array<[number, string | number]>) =>
    [[0, 'MTEXT'], [8, '0'], [100, 'AcDbMText'], [10, 0], [20, y], [40, 2.5], [41, 40], [46, 20], [71, 1], [1, 'ONE\\NTWO\\NTHREE'], [101, 'Embedded Object'], [70, 1], [10, 1], [20, 0], [11, 0], [21, y], [40, 40], [41, 20], ...embedded];
  const dxf = [
    [0, 'SECTION'], [2, 'ENTITIES'],
    ...mtext(0, [[42, 170], [43, 30], [71, 1], [72, 3], [44, 50], [45, 10], [73, 0], [74, 0]]),
    ...mtext(100, [[42, 130], [43, 20], [71, 2], [72, 0], [44, 40], [45, 5], [73, 1], [74, 0]]),
    ...mtext(200, [[42, 130], [43, 20], [71, 2], [72, 3], [44, 40], [45, 5], [73, 0], [74, 0], [46, 20], [46, 15], [46, 10]]),
    ...mtext(300, [[42, 130], [43, 20], [71, 1], [72, 3], [44, 40], [45, 5], [73, 0], [74, 1]]),
    [0, 'ENDSEC'], [0, 'EOF'],
  ].map(([c, v]) => `${c}\n${v}`).join('\n');

  it('keeps each kind, its auto-height and reversed-flow flags, also after a round trip', () => {
    const read = readDxf(dxf);
    for (const s of [read, readDxf(writeDxf(read))]) {
      const cols = ofType<MTextEntity>(s.entities, 'mtext').map((m) => m.columns);
      expect(cols).toEqual([
        { type: 1, count: 3, width: 50, gutter: 10, autoHeight: false, reversed: false, heights: [] },
        { type: 2, count: 3, width: 40, gutter: 5, autoHeight: true, reversed: false, heights: [] },
        { type: 2, count: 3, width: 40, gutter: 5, autoHeight: false, reversed: false, heights: [20, 15, 10] },
        { type: 1, count: 3, width: 40, gutter: 5, autoHeight: false, reversed: true, heights: [] },
      ]);
    }
    // Auto height does not reverse the columns: the first one stays on the left.
    const auto = ofType<MTextEntity>(read.entities, 'mtext')[1]!;
    const xs = (m: MTextEntity, word: string) => mtextLayout(m, (t, h) => t.length * h * 0.6).find((t) => t.text === word)!.position.x;
    expect(xs(auto, 'ONE')).toBeLessThan(xs(auto, 'THREE'));
    const reversed = ofType<MTextEntity>(read.entities, 'mtext')[3]!;
    expect(xs(reversed, 'ONE')).toBeGreaterThan(xs(reversed, 'THREE'));
  });
});

// ---------------------------------------------------------------- HATCH, LWPOLYLINE, SPLINE, ELLIPSE

/*
 * Survives: HATCH pattern name, scale and angle fitted to the stored definition lines, boundary
 * loops (polyline loops with bulges, line / arc edges as bulged polylines), SOLID with an island;
 * LWPOLYLINE bulges, constant width (43) and vertex start/end widths (40/41); SPLINE fit points, end tangents, knots, control
 * points and weights; ELLIPSE axes, ratio and parameters; entity lineweights.
 * Lost (matrix): the hatch's link to its boundary object.
 */
describe('r2000-hatch-curves.dxf: HATCH (ANSI31 with bulges, SOLID with island), LWPOLYLINE, SPLINE, ELLIPSE (AC1015)', () => {
  const f = fixture('r2000-hatch-curves.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const hatches = ofType<HatchEntity>(s.entities, 'hatch');
    const polys = ofType<PolylineEntity>(s.entities, 'polyline');
    const splines = ofType<SplineEntity>(s.entities, 'spline');
    const ellipses = ofType<EllipseEntity>(s.entities, 'ellipse');

    it('entity order and vertex widths kept; source boundary-link losses are reported', () => {
      if (s === f.imported) {
        expect(importReportOf(s)?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', reason: expect.stringContaining('boundary links') }));
        expect(importReportOf(s)?.items.some((i) => i.reason.includes('per-vertex polyline widths'))).toBe(false);
        expect(importReportOf(s)?.items).toContainEqual(expect.objectContaining({ type: 'LWPOLYLINE', action: 'kept', reason: expect.stringContaining('typed object references') }));
      }
      else expect(importReportOf(s)?.items.every(item => item.action === 'kept')).toBe(true);
      expect(s.entities.map((e) => e.type)).toEqual(['polyline', 'hatch', 'hatch', 'polyline', 'circle', 'hatch', 'polyline', 'polyline', 'spline', 'spline', 'ellipse', 'ellipse']);
      expect(polys.find((e) => e.widths)?.widths).toEqual([{ start: 0, end: 0 }, { start: 6, end: 0 }, { start: 0, end: 0 }]);
    });

    it('ANSI31 at scale 10 inside the slot: a polyline loop with two half circles (bulge 1)', () => {
      const h = hatches[0]!;
      expect(h).toMatchObject({ pattern: 'ANSI31', solid: false, layer: 'HATCH', color: 'ByLayer', patternType: 1 });
      close(h.scale, 10);
      close(h.angle, 0);
      expect(h.patternLines).toBeUndefined();
      expect(h.loops).toHaveLength(1);
      expect(h.loops[0]!.points).toEqual([
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 30 },
        { x: 0, y: 30 },
      ]);
      expect(h.loops[0]!.bulges).toEqual([0, 1, 0, 1]);
    });

    it('ANSI31 at 30 degrees, scale 5, from line and arc edges (the arc becomes a bulge)', () => {
      const h = hatches[1]!;
      expect(h).toMatchObject({ pattern: 'ANSI31', color: 1 });
      close(h.angle, rad(30));
      close(h.scale, 5);
      const loop = h.loops[0]!;
      expect(loop.points).toHaveLength(4);
      [
        [100, 0],
        [140, 0],
        [140, 40],
        [100, 40],
      ].forEach(([x, y], i) => closePt(loop.points[i], x!, y!));
      loop.bulges!.forEach((b, i) => close(b, i === 1 ? 1 : 0));
    });

    it('SOLID with a circular island: two loops, even-odd fill leaves the circle open', () => {
      const h = hatches[2]!;
      expect(h).toMatchObject({ pattern: 'SOLID', solid: true, color: 3 });
      expect(h.loops).toHaveLength(2);
      const rings = h.loops.map(loopPolygon);
      expect(pointInLoops({ x: 10, y: 70 }, rings)).toBe(true);
      expect(pointInLoops({ x: 40, y: 85 }, rings)).toBe(false);
      expect(pointInLoops({ x: 40, y: 100 }, rings)).toBe(true);
      for (const p of rings[1]!) close(Math.hypot(p.x - 40, p.y - 85), 12, 6);
    });

    it('LWPOLYLINE with a 90-degree bulge, constant width 1.5 and lineweight 0.50', () => {
      const p = polys[2]!;
      expect(p).toMatchObject({ closed: false, width: 1.5, lineWeight: 0.5 });
      expect(p.points).toEqual([
        { x: 150, y: 60 },
        { x: 190, y: 60 },
        { x: 210, y: 80 },
        { x: 210, y: 110 },
      ]);
      close(p.bulges![1], Math.tan(rad(22.5)));
      expect(polys[0]!.bulges).toEqual([0, 1, 0, 1]);
    });

    it('SPLINE through four fit points with end tangents: fit data, knots and control polygon; the curve passes through the fit points', () => {
      const sp = splines[0]!;
      expect(sp).toMatchObject({ degree: 3, closed: false });
      expect(sp.fitPoints).toEqual([
        { x: 0, y: 200 },
        { x: 40, y: 230 },
        { x: 80, y: 190 },
        { x: 120, y: 220 },
      ]);
      closePt(sp.startTangent, Math.SQRT1_2, Math.SQRT1_2);
      closePt(sp.endTangent, 1, 0);
      expect(sp.knots).toHaveLength(10);
      close(sp.knots[4], 50);
      close(sp.knots[5], 106.5685424949238, 6);
      expect(sp.controlPoints).toHaveLength(6);
      closePt(sp.controlPoints[2], 43.9893546635, 258.2354569582);
      const c = splineCurve(sp)!;
      closePt(nurbsPoint(c, 50), 40, 230, 5);
      closePt(nurbsPoint(c, 106.5685424949238), 80, 190, 5);
      closePt(nurbsPoint(c, 156.5685424949238), 120, 220, 5);
    });

    it('rational SPLINE by control points: weights kept, the curve is an exact quarter circle', () => {
      const sp = splines[1]!;
      expect(sp).toMatchObject({ degree: 2, color: 6, knots: [0, 0, 0, 1, 1, 1] });
      expect(sp.fitPoints).toBeUndefined();
      close(sp.weights![1], Math.SQRT1_2);
      for (const p of nurbsPoints(splineCurve(sp)!, 8)) close(Math.hypot(p.x - 250, p.y), 50, 6);
    });

    it('ELLIPSE: full with a turned major axis; elliptical arc with parameters and lineweight', () => {
      const [full, arc] = ellipses;
      closePt(full!.center, 330, 80);
      closePt(full!.majorAxis, 34.64101615137755, 20);
      expect(full!.ratio).toBe(0.5);
      close(full!.startParam, 0);
      close(full!.endParam, 2 * Math.PI);
      expect(arc).toMatchObject({ center: { x: 330, y: 160 }, majorAxis: { x: 0, y: 30 }, ratio: 0.4, startParam: 0.5, endParam: 3.6, lineWeight: 0.3 });
    });
  });

  it('lost as the matrix says: per-vertex start / end widths (40 / 41) are not read', () => {
    const arrow = ofType<PolylineEntity>(f.imported.entities, 'polyline')[3]!;
    expect(arrow.points).toHaveLength(3);
    expect(arrow.width).toBeUndefined();
  });

  it('lost as the matrix says: the associative hatch keeps its own loops, not its link to the boundary polyline', () => {
    expect(ofType<HatchEntity>(f.imported.entities, 'hatch')[0]!.associative).toBe(true);
    const hatch = records(f.written, 'HATCH')[0]!;
    expect(group(hatch, 97)).toBe('0');
  });

  it('a hatch saved without its boundary link is written non-associative (71 = 0) with the same loops', () => {
    for (const h of records(f.written, 'HATCH')) expect(group(h, 71)).toBe('0');
    expect(ofType<HatchEntity>(f.roundTripped.entities, 'hatch')[0]!.associative).toBeUndefined();
    expect(ofType<HatchEntity>(f.roundTripped.entities, 'hatch')[0]!.loops).toEqual(ofType<HatchEntity>(f.imported.entities, 'hatch')[0]!.loops);
  });
});

// ---------------------------------------------------------------- true colours, lineweights, linetypes

/*
 * Survives: layer and entity true colours (420) with their ACI, layer lineweights, entity
 * lineweights (explicit, ByBlock -2; ByLayer -1 as inherit), linetype scale, layer linetypes,
 * off / frozen / locked / no-plot; complex linetype definitions and STYLE links; SOLID hatch colour.
 * Survives: colour-book names (430) and transparency (440, layer AcCmTransparency XDATA).
 * Display limit: embedded text/shapes remain a reported dash-only fallback.
 */
describe('r2018-truecolor-linetypes.dxf: true colours, colour book, transparency, lineweights, complex linetypes (AC1032)', () => {
  const f = fixture('r2018-truecolor-linetypes.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    it('layers: true colour with the nearest ACI, lineweights, linetypes, off / frozen / locked / no-plot', () => {
      expect(importReportOf(s)?.items.some((i) => i.type === 'STYLE')).toBe(true);
      expect(layerOf(s, '0')).toMatchObject({ color: 7, lineWeight: 0.25 });
      // AutoCAD writes its own nearest ACI beside each true colour in a genuine save
      // (checklist r2018-truecolor-linetypes #8/#10/#12/#13): PANEL-TC 150 (not 5),
      // WIRE-RED 12 (not 1), BOOK 104 (not 3), and the book colour is AutoCAD 2027's
      // PANTONE 355 C value 0x009639 (not the synthetic's 0x00a651).
      expect(layerOf(s, 'PANEL-TC')).toMatchObject({ color: 150, trueColor: 0x3399ff, lineWeight: 0.5 });
      expect(layerOf(s, 'WIRE-RED')).toMatchObject({ color: 12, trueColor: 0xc80000, lineWeight: 0.35, linetype: 'GAS_LINE' });
      expect(layerOf(s, 'BOOK')).toMatchObject({ color: 104, trueColor: 0x009639, lineWeight: 0.25 });
      expect(layerOf(s, 'FENCE')).toMatchObject({ color: 40, visible: false, lineWeight: 0.13, linetype: 'FENCELINE1' });
      expect(layerOf(s, 'NOPLOT')).toMatchObject({ color: 8, plot: false });
      expect(layerOf(s, 'ARCHIVE')).toMatchObject({ frozen: true, locked: true, visible: false });
      expect(s.header?.ltscale).toBe(2);
    });

    it('complex linetypes keep their native descriptors while displaying the dash fallback', () => {
      expect(s.header?.linetypes).toMatchObject([
        // AutoCAD truncated both descriptions to 47 chars (checklist #17, GAS_LINE);
        // the synthetic carried the full texts.
        { name: 'GAS_LINE', description: 'Gas line ----GAS----GAS----GAS----GAS----GAS---' },
        { name: 'FENCELINE1', description: 'Fenceline circle ----0-----0----0-----0----0---' },
      ]);
      // AutoCAD spelled both 6.35 dashes with the long double (GAS_LINE -6.349999999999999,
      // checklist #19; FENCELINE1 6.349999999999999), one ULP below the canonical double, and
      // JCad's writer canonicalises them on save - so the two legs' pattern doubles differ by
      // that single ULP and the patterns are asserted element-wise at 12 digits.
      const [gasPattern, fencePattern] = s.header!.linetypes.map((l) => l.pattern!);
      [12.7, -5.08, -6.35].forEach((v, i) => close(gasPattern[i], v, 12));
      [6.35, -2.54, -2.54, 25.4].forEach((v, i) => close(fencePattern[i], v, 12));
      expect(s.header!.linetypes[0]!.complex!.elements[1]).toMatchObject({ flags: 2, shapeNumber: 0,
        scale: 2.54, rotation: 0, offsetX: -2.54, offsetY: -1.27, text: 'GAS', style: { kind: 'text', name: 'Standard' } });
      expect(s.header!.linetypes[1]!.complex!.elements[1]).toMatchObject({ flags: 4, shapeNumber: 133,
        scale: 2.54, rotation: 0, offsetX: -2.54, offsetY: 0, style: { kind: 'shape' } });
      // The STYLE record of the shape file (flag 1) is not a text style.
      expect(Object.keys(textStylesOf(s))).toEqual(['Standard']);
      expect(textStylesOf(s).Standard).toMatchObject({ font: 'arial.ttf', family: 'Arial' });
    });

    it('entities: ByLayer takes the layer true colour; entity true colours, lineweights, linetype and its scale', () => {
      const [onLayer, orange, fence, noplot] = ofType<LineEntity>(s.entities, 'line');
      expect(resolveColor(onLayer!, s.layers)).toBe(trueColorCss(0x3399ff));
      expect(orange).toMatchObject({ color: 30, trueColor: 0xff8000, lineWeight: 0.7 });
      expect(resolveColor(orange!, s.layers)).toBe(trueColorCss(0xff8000));
      expect(fence).toMatchObject({ layer: '0', linetype: 'FENCELINE1', lineWeight: 0.13 });
      expect(noplot).toMatchObject({ layer: 'NOPLOT', color: 'ByLayer' });
      const wire = ofType<PolylineEntity>(s.entities, 'polyline')[0]!;
      expect(wire).toMatchObject({ layer: 'WIRE-RED', ltscale: 2 });
      expect(wire.linetype).toBeUndefined();
      expect(wire.lineWeight).toBeUndefined();
      expect(resolveColor(wire, s.layers)).toBe(trueColorCss(0xc80000));
      expect(ofType<CircleEntity>(s.entities, 'circle')[0]).toMatchObject({ layer: 'BOOK', lineWeight: -2 });
      expect(ofType<ArcEntity>(s.entities, 'arc')[0]).toMatchObject({ color: 5, trueColor: 0x0000ff });
      // A colour-book colour shows its RGB (420), more than the matrix promises.
      const book = ofType<TextEntity>(s.entities, 'text')[0]!;
      expect(book).toMatchObject({ color: 104, trueColor: 0x009639, text: 'PANTONE 355 C' });
      expect(ofType<HatchEntity>(s.entities, 'hatch')[0]).toMatchObject({ solid: true, color: 8, trueColor: 0x808080 });
    });
  });

  it('writes color-book identity, opacity and native complex linetype resources', () => {
    const identity = 'PANTONE+ Solid Coated$PANTONE 355 C';
    expect(group(records(f.written, 'TEXT')[0], 430)).toBe(identity);
    expect(group(records(f.written, 'LAYER').find((r) => group(r, 2) === 'BOOK'), 430)).toBe(identity);
    const fence = records(f.written, 'LAYER').find((r) => group(r, 2) === 'FENCE');
    expect(group(fence, 1001)).toBe('AcCmTransparency');
    expect(group(fence, 1071)).toBe('33554559');
    expect(group(records(f.written, 'ARC')[0], 440)).toBe('33554559');
    for (const [, state] of both(f)) {
      expect(layerOf(state, 'FENCE')?.transparency).toBe(127);
      expect(ofType<ArcEntity>(state.entities, 'arc')[0]?.transparency).toBe(127);
      expect(ofType<TextEntity>(state.entities, 'text')[0]?.colorName).toBe(identity);
    }
    const gas = records(f.written, 'LTYPE').find((r) => group(r, 2) === 'GAS_LINE')!;
    expect(gas.filter(([c]) => c === 49).map(([, v]) => Number(v))).toEqual([12.7, -5.08, -6.35]);
    expect(group(gas, 9)).toBe('GAS');
    expect(gas.filter(([c]) => c === 74).map(([, v]) => Number(v))).toEqual([0, 2, 0]);
    const styleHandle = group(gas, 340);
    expect(group(records(f.written, 'STYLE').find((record) => group(record, 5) === styleHandle), 2)).toBe('Standard');
    expect(f.written).toContain('ltypeshp.shx');
  });

  it('the Default layer lineweight (370 = -3) reads as 0.25 mm and is written back as an explicit 25', () => {
    const zero = records(f.written, 'LAYER').find((r) => group(r, 2) === '0');
    expect(group(zero, 370)).toBe('25');
  });
});

// ---------------------------------------------------------------- nested blocks, ByBlock / ByLayer, xrefs

/*
 * Survives: block definitions with ByBlock (0) colours, a ByBlock linetype and lineweight, layer-0
 * content; nested inserts three levels deep drawing in AutoCAD's colours under a ByLayer and an
 * explicit-colour insert; ByBlock linetype taken from the insert; attached and overlay xref
 * blocks with their paths, drawn as a named frame.
 * Lost: nothing the matrix lists (the "resolved" xref state flag 32 is recomputed by AutoCAD).
 */
describe('r2000-nested-blocks-xref.dxf: nested INSERTs with ByBlock / ByLayer colours, external references (AC1015)', () => {
  const f = fixture('r2000-nested-blocks-xref.dxf');
  const aci = (list: number[]) => list.map(aciToCss);

  describe.each(both(f))('%s', (_label, s) => {
    const lookup = (n: string) => s.blocks[n];
    const ins = ofType<InsertEntity>(s.entities, 'insert');
    const colours = (i: InsertEntity) => explodeInsert(i, lookup).map((e) => resolveColor(e, s.layers));

    it('block definitions keep ByBlock colours, the ByBlock linetype and lineweight', () => {
      expect(importReportOf(s)).toBeUndefined();
      const bolt = s.blocks.BOLT!.entities;
      expect(bolt.map((e) => [e.type, e.layer, e.color])).toEqual([
        ['circle', '0', 0],
        ['line', '0', 'ByLayer'],
        ['line', 'HARDWARE', 2],
      ]);
      expect(bolt[1]).toMatchObject({ linetype: 'ByBlock', lineWeight: -2 });
      expect(s.blocks.PLATE!.entities.map((e) => (e.type === 'insert' ? `${e.block}:${e.layer}:${e.color}` : `${e.type}:${e.color}`))).toEqual([
        'polyline:0',
        'BOLT:0:0',
        'BOLT:HARDWARE:ByLayer',
        'BOLT:0:4',
        'text:0',
      ]);
      expect(s.blocks.ASSY!.entities[1]).toMatchObject({ type: 'insert', block: 'PLATE', color: 6, scale: 0.5 });
      close((s.blocks.ASSY!.entities[1] as InsertEntity).rotation, Math.PI / 2);
    });

    it('three nesting levels under a ByLayer insert on a green layer draw in AutoCAD colours', () => {
      // PLATE (ByBlock): outline, BOLT ByBlock (circle, layer-0 line, yellow line), BOLT on HARDWARE,
      // BOLT cyan, text; then PLATE magenta (same content); then the layer-0 ByLayer base line.
      expect(colours(ins[0]!)).toEqual(aci([3, 3, 3, 2, 30, 30, 2, 4, 3, 2, 3, 6, 6, 3, 2, 30, 30, 2, 4, 3, 2, 6, 3]));
    });

    it('the same assembly inserted red: ByBlock content turns red, layer-0 ByLayer content keeps the insert layer colour', () => {
      expect(colours(ins[1]!)).toEqual(aci([1, 1, 3, 2, 30, 30, 2, 4, 3, 2, 1, 6, 6, 3, 2, 30, 30, 2, 4, 3, 2, 6, 3]));
    });

    it('a BOLT inserted with linetype DASHED and lineweight 0.50: the ByBlock line takes the linetype', () => {
      const bolt = ins[2]!;
      expect(bolt).toMatchObject({ layer: 'HARDWARE', linetype: 'DASHED', lineWeight: 0.5 });
      const parts = explodeInsert(bolt, lookup);
      expect(parts[1]!.linetype).toBe('DASHED');
      expect(parts.map((e) => resolveColor(e, s.layers))).toEqual(aci([30, 30, 2]));
      expect(s.header?.linetypes).toEqual([{ name: 'DASHED', description: 'Dashed __ __ __ __ __ __ __ __ __ __ __ __ __ _', pattern: [12.7, -6.35] }]);
    });

    it('external references: attached and overlay, paths kept, drawn as a named frame', () => {
      expect(s.blocks['SITE-PLAN']).toMatchObject({ xref: { path: '..\\xrefs\\site-plan.dwg' }, entities: [] });
      expect(s.blocks['SITE-PLAN']!.xref!.overlay).toBeUndefined();
      expect(s.blocks.TOPO).toMatchObject({ xref: { path: 'C:\\Survey\\topo-2026.dwg', overlay: true }, entities: [] });
      expect(ins[4]).toMatchObject({ block: 'TOPO', scale: 2, position: { x: 1000, y: 0 } });
      const frame = explodeInsert(ins[3]!, lookup);
      expect(frame.some((e) => e.type === 'text' && e.text.includes('SITE-PLAN'))).toBe(true);
      expect(layerOf(s, 'SITE-PLAN|WALLS')).toMatchObject({ color: 1 });
    });
  });

  it('xref BLOCK flags are written back as attach (4) and overlay (4 + 8)', () => {
    const flags = (name: string) => group(records(f.written, 'BLOCK').find((r) => group(r, 2) === name), 70);
    expect(flags('SITE-PLAN')).toBe('4');
    expect(flags('TOPO')).toBe('12');
  });

  it('the xref-dependent layer SITE-PLAN|WALLS keeps its LAYER flags 16 + 32 on save', () => {
    for (const [, s] of both(f)) expect(layerOf(s, 'SITE-PLAN|WALLS')!.xrefFlags).toBe(48);
    expect(group(records(f.written, 'LAYER').find((r) => group(r, 2) === 'SITE-PLAN|WALLS'), 70)).toBe('48');
  });
});

// ---------------------------------------------------------------- ACAD_TABLE (R2018)

/*
 * Survives: one native table (position, direction, row heights, column widths); cell text, the
 * merged title, formatted cell text, per-cell height and alignment overrides, the TABLESTYLE's
 * text heights, alignment and margins for the other cells; the *T1 picture is not kept as a block. Lost (matrix: "as INSERT + XDATA"): the table is written as an INSERT of an
 * anonymous block carrying the cells in JCAD_TABLE XDATA, not as ACAD_TABLE.
 */
describe('r2018-table.dxf: ACAD_TABLE with cells, merged title, table style (AC1032)', () => {
  const f = fixture('r2018-table.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const t = ofType<TableEntity>(s.entities, 'table')[0]!;

    it('one native table: insertion point, direction, row heights, column widths', () => {
      // Import-report predicate in the strict no-loss form the lead authorised for the genuine
      // template file (census-predicate ruling, 2026-10-21) — not a loosening: (1) nothing is
      // lost: no 'dropped' item (the report's lost disposition — not imported, lost on save)
      // and no 'simplified' item beyond the one sanctioned ACAD_TABLE editing note; (2) every
      // item that is not a 'kept' retention is (STYLE, unsupported) or that note. That is the
      // original census predicate applied to the non-retained subset: the template's kept
      // furniture (SCALE, VISUALSTYLE, XRECORD, ...) no longer trips it, and no new unsupported
      // or simplified class can enter. The note is pinned to exactly one occurrence by the
      // 'editing note exactly once' test below — an import-leg property: the round-trip report
      // carries no ACAD_TABLE item (the written carrier returns as an INSERT kept item).
      const items = importReportOf(s)?.items ?? [];
      const isEditingNote = (i: (typeof items)[number]) => i.type === 'ACAD_TABLE' && i.reason.includes('native table editing');
      expect(items.filter((i) => i.action === 'dropped' || (i.action === 'simplified' && !isEditingNote(i)))).toEqual([]);
      expect(items.every((i) => i.action === 'kept' || (i.type === 'STYLE' && i.action === 'unsupported') || isEditingNote(i))).toBe(true);
      expect(s.entities).toHaveLength(1);
      expect(t).toMatchObject({ layer: 'TABLES', rotation: 0, rowHeights: [9.666666666666668, 12.33333333333333, 7, 7], columnWidths: [40, 25, 25] });
      closePt(t.position, 10, 200);
    });

    it('cells: text, the merged title, formatted text kept, height and alignment overrides', () => {
      expect(t.cells.map((row) => row.map((c) => c.text))).toEqual([
        ['PANEL SCHEDULE', '', ''],
        ['CIRCUIT', 'LOAD (A)', 'BREAKER'],
        ['LIGHTING', '12,5', '16 A'],
        ['MOTOR M1', '8,2', '20 A'],
      ]);
      expect(t.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
      expect(t.cells[2]![2]!.raw).toBe('{\\fArial|b1|i0|c0|p34;16 A}');
      expect(t.cells[3]![2]!.raw).toBe('{\\C1;20 A}');
      expect(t.cells[3]![0]!.height).toBe(3);
      expect(t.cells[3]![1]!.attachment).toBe(6);
    });

    it('the anonymous *T1 picture block is not kept; the grid and cell texts come from the cell data', () => {
      expect(s.blocks['*T1']).toBeUndefined();
      const geo = tableGeometry(t);
      // Five horizontal lines (the title row is not split), four vertical (two stop under the title).
      expect(geo.lines).toHaveLength(9);
      expect(geo.texts.map((m) => m.text)).toEqual(['PANEL SCHEDULE', 'CIRCUIT', 'LOAD (A)', 'BREAKER', 'LIGHTING', '12,5', '16 A', 'MOTOR M1', '8,2', '20 A']);
      closePt(geo.texts[0]!.position, 55, 195.16666666666666);
      expect(geo.texts[7]!.height).toBe(3);
    });
  });

  it('the import report carries the ACAD_TABLE editing note exactly once (census-predicate ruling, 2026-10-21)', () => {
    // The one sanctioned simplification of the genuine file: reading its native table reports
    // once that native table editing is not modeled. Asserted on the import leg — the
    // round-tripped state's report carries no ACAD_TABLE item at all (the written JCAD_TABLE
    // carrier returns as an INSERT kept item), so the count is an import property.
    const notes = (importReportOf(f.imported)?.items ?? []).filter((i) => i.type === 'ACAD_TABLE' && i.reason.includes('native table editing'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.action).toBe('simplified');
  });

  it('lost as the matrix says: written as an INSERT of an anonymous block with JCAD_TABLE XDATA, not as ACAD_TABLE', () => {
    expect(records(f.written, 'ACAD_TABLE')).toHaveLength(0);
    const insert = records(f.written, 'INSERT').find((r) => r.some(([c, v]) => c === 1001 && v === 'JCAD_TABLE'));
    expect(group(insert, 2)).toMatch(/^\*U\d+$/);
  });

  it('cells without an override take the TABLESTYLE text height, alignment and margins (title 5, header 3.5, data 2.5 top centre, margins 1.5)', () => {
    for (const [, s] of both(f)) {
      const t = ofType<TableEntity>(s.entities, 'table')[0]!;
      expect(t.margin).toBe(1.5);
      expect(t.textHeight).toBe(2.5);
      expect(t.cells[0]![0]).toMatchObject({ height: 5, attachment: 5 });
      expect(t.cells[1]![0]).toMatchObject({ height: 3.5, attachment: 5 });
      expect(t.cells[2]![0]).toMatchObject({ height: 2.5, attachment: 2 });
      // A cell's own override wins.
      expect(t.cells[3]![0]!.height).toBe(3);
    }
  });
});

/*
 * The same TABLESTYLE reading against a table AutoCAD wrote (fixtures/example_2000.dxf, AC1015 from
 * a later AutoCAD): its "Standard" style has the cell styles 4.5 top centre, 6 middle centre, 4.5
 * middle centre, no version 280 before the title flag, margins 1.5; the table's title row is 11
 * high and the others 9 (AutoCAD sizes a row 4/3 of its text height plus both margins), so the
 * styles are data, title, header in that order.
 */
describe('fixtures/example_2000.dxf: an AutoCAD-written ACAD_TABLE takes its TABLESTYLE in AutoCAD order', () => {
  const s = readDxf(decodeDxfBytes(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'example_2000.dxf'))).text);
  const t = ofType<TableEntity>(s.entities, 'table')[0]!;

  it('title row 6 middle centre, header row 4.5 middle centre, data rows 4.5 top centre, margins 1.5', () => {
    expect(t.rowHeights.slice(0, 3)).toEqual([11, 9, 9]);
    expect(t.cells[0]![0]).toMatchObject({ text: 'test', height: 6, attachment: 5, span: { rows: 1, cols: 9 } });
    expect(t.cells[1]![0]).toMatchObject({ text: 'test', height: 4.5, attachment: 5 });
    expect(t.cells[2]![0]).toMatchObject({ text: 'xx', height: 4.5, attachment: 2 });
    expect(t.margin).toBe(1.5);
    expect(t.textHeight).toBe(4.5);
    // Each style's text fits its row the way AutoCAD sized them.
    for (const r of [0, 1, 2]) expect(t.rowHeights[r]).toBeCloseTo((t.cells[r]![0]!.height! * 4) / 3 + 2 * t.margin!, 6);
  });

  it('the title flag is the 280 after the margins, with or without the leading version 280', () => {
    const style = (version: boolean, title: number, header: number): Obj => ({
      kind: 'TABLESTYLE',
      groups: [
        { code: 100, value: 'AcDbTableStyle' },
        ...(version ? [{ code: 280, value: '0' }] : []),
        { code: 3, value: 'S' }, { code: 70, value: '0' }, { code: 71, value: '0' }, { code: 40, value: '1' }, { code: 41, value: '2' },
        { code: 280, value: String(title) }, { code: 281, value: String(header) },
        { code: 7, value: 'Standard' }, { code: 140, value: '2.5' }, { code: 170, value: '2' },
        { code: 7, value: 'Standard' }, { code: 140, value: '5' }, { code: 170, value: '5' },
        { code: 7, value: 'Standard' }, { code: 140, value: '3.5' }, { code: 170, value: '5' },
      ],
    });
    for (const version of [false, true]) {
      expect(readTableStyle(style(version, 1, 0))).toMatchObject({ titleSuppressed: true, headerSuppressed: false, marginX: 1, marginY: 2 });
      expect(readTableStyle(style(version, 0, 1))).toMatchObject({ titleSuppressed: false, headerSuppressed: true });
      expect(readTableStyle(style(version, 0, 0)).rows.map((r) => r.height)).toEqual([2.5, 5, 3.5]);
    }
  });
});

/*
 * write -> read -> write keeps everything the first write wrote, the fields this release added to
 * the reader and writer (DIMDSEP, DIMTXSTY, DIMLWD / DIMLWE, DIMTZIN, DSTYLE overrides, xref layer
 * flags, table styles, paper-space IMAGE names, MTEXT columns, 2D limits, plot style dictionary)
 * among them: the second write differs from the first at most in the last digits of computed
 * coordinates (10 decimals), and the third equals the second.
 */
describe('every committed DXF fixture: write -> read -> write reaches a fixed point', () => {
  const root = join(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'manifest.json'), 'utf8')) as { files: string[] };
  const files = manifest.files.filter((f) => f.endsWith('.dxf') && !f.includes('/broken/'));
  it.each(files)('%s', (file) => {
    const w1 = writeDxf(readDxf(decodeDxfBytes(readFileSync(join(root, file))).text));
    const w2 = writeDxf(readDxf(w1));
    expect(writeDxf(readDxf(w2))).toBe(w2);
    const a = w1.split('\r\n');
    const b = w2.split('\r\n');
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      const x = Number(a[i]);
      const y = Number(b[i]);
      expect(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x)), `${file} line ${i + 1}: ${a[i]} -> ${b[i]}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- IMAGE, inch drawing (R2018)

/*
 * Survives: $INSUNITS 1 with architectural units and precision, limits, LTSCALE; IMAGE path from
 * its IMAGEDEF (relative), insertion point, pixel vectors (rotation, scale), size, rectangular and
 * polygonal clips with the clip flag, display flags, brightness / contrast / fade; an inch layout
 * (plot paper units 0, rotated to landscape) with millimetre margins converted, a locked viewport
 * at 1/4" = 1'-0", and a paper-space image's placement and file name.
 * Lost: nothing the matrix lists.
 */
describe('r2018-image-inches.dxf: IMAGE + IMAGEDEF in model and paper space, $INSUNITS 1 (AC1032)', () => {
  const f = fixture('r2018-image-inches.dxf');

  describe.each(both(f))('%s', (_label, s) => {
    const images = ofType<ImageEntity>(s.entities, 'image');
    const layout = s.layouts?.[0];

    it('inch units with architectural format, limits and linetype scale', () => {
      expect(importReportOf(s)?.items).toContainEqual(expect.objectContaining({ type: 'RASTERVARIABLES', action: 'kept' }));
      expect(s.header?.units).toEqual({ insunits: 1, lunits: 4, luprec: 4, auprec: 0, aunits: 0 });
      expect(formatLength(30.5, s.header!.units)).toBe('2\'-6 1/2"');
      expect(s.header?.limits.max).toEqual({ x: 432, y: 288 });
      expect(s.header?.ltscale).toBe(12);
    });

    it('model-space images: one IMAGEDEF used twice, placement, pixel vectors, clips and adjustments', () => {
      expect(images).toHaveLength(2);
      const [photo, turned] = images;
      expect(photo).toMatchObject({
        path: '..\\photos\\panel-front.jpg',
        position: { x: 24, y: 12 },
        u: { x: 0.03, y: 0 },
        v: { x: 0, y: 0.03 },
        size: { x: 1600, y: 1200 },
        clip: [
          { x: 100.5, y: 50.5 },
          { x: 1400.5, y: 1100.5 },
        ],
        clipOn: true,
        flags: 7,
        brightness: 50,
        contrast: 50,
        fade: 0,
        layer: 'IMAGES',
      });
      expect(turned).toMatchObject({ path: '..\\photos\\panel-front.jpg', position: { x: 120, y: 0 }, u: { x: 0, y: 0.015 }, v: { x: -0.015, y: 0 }, clipOn: true, flags: 15, brightness: 70, contrast: 40, fade: 20 });
      expect(turned!.clip).toEqual([
        { x: -0.5, y: -0.5 },
        { x: 1599.5, y: -0.5 },
        { x: 1599.5, y: 600 },
        { x: 800, y: 1199.5 },
        { x: -0.5, y: -0.5 },
      ]);
    });

    it('layout ANSI B: inch paper turned to landscape, plotter margins, a locked 1/4" = 1\'-0" viewport', () => {
      expect(s.layouts?.map((l) => l.name)).toEqual(['ANSI B']);
      expect(layout!.paper).toMatchObject({ id: 'tabloid', units: 'in', orientation: 'landscape' });
      // The genuine save's margins are the DWG To PDF plotter's printable area (5/17/5/17 mm,
      // checklist r2018-image-inches #13), not the synthetic's uniform 0.25 in.
      expect(layout!.margins).toEqual({ left: 0.1968503937007874, bottom: 0.6692913385826772, right: 0.1968503937007874, top: 0.6692913385826772 });
      expect(layout!.plotStyle).toBe('monochrome');
      expect(layout!.viewports).toHaveLength(1);
      const vp = layout!.viewports[0]!;
      // Stored centre (8.25, 5.75) shifted by the genuine left/bottom margins (see above).
      closePt(vp.center, 8.446850393700787, 6.419291338582677);
      expect(vp).toMatchObject({ width: 15.5, height: 9.5, layer: 'VPORTS', on: true });
      closePt(vp.view.center, 66, 24);
      close(vp.view.scale, 0.25 / 12);
      expect(vp.view.locked).toBe(true);
    });

    it('the paper-space logo image keeps its placement and size', () => {
      const logo = ofType<ImageEntity>(layout!.entities, 'image')[0]!;
      expect(logo).toMatchObject({ layer: 'TITLE', u: { x: 0.005, y: 0 }, v: { x: 0, y: 0.005 }, size: { x: 400, y: 200 }, flags: 7 });
      // Stored position (14, 0.75) shifted by the genuine left/bottom margins (see above).
      closePt(logo.position, 14.196850393700787, 1.4192913385826773);
      expect(logo.clipOn).toBeUndefined();
    });
  });

  it('the paper-space IMAGE keeps its IMAGEDEF file name C:\\Standards\\jcad-logo.tif and saves it', () => {
    for (const [, s] of both(f)) expect(ofType<ImageEntity>(s.layouts![0]!.entities, 'image')[0]!.path).toBe('C:\\Standards\\jcad-logo.tif');
    expect(records(f.written, 'IMAGEDEF').map((r) => group(r, 1))).toContain('C:\\Standards\\jcad-logo.tif');
  });
});
