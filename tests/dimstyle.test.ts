import { describe, it, expect } from 'vitest';
import type { DimensionEntity, TextEntity, Entity } from '../src/core/entities';
import { textWidth } from '../src/core/entities';
import {
  STANDARD_DIMSTYLE,
  ISO25_DIMSTYLE,
  DIM_ARROWS,
  arrowParts,
  dimensionGeometry,
  dimensionText,
  dimensionTextLayout,
  dimensionTextPoint,
  resolveDimStyle,
  suppressZeros,
  applyPost,
  namedDimStyles,
  findDimStyle,
  withDimStyle,
  withoutDimStyle,
  dimStyleUsage,
  dimStyleRecordPairs,
  dimStyleFromRecordPairs,
  dimVarValue,
  withDimVar,
  diffDimStyles,
  arrowBlockName,
  arrowFromBlockName,
  type DimArrow,
  type DimStyle,
} from '../src/core/dimension';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { chainDimension, dimBaselineTool, dimContinueTool, dimEditTool, dimTeditTool, dimstyleCommandTool, editDimensions, justifiedTextPosition, lastChainableDimension, registerDimStyleCommands } from '../src/tools/dimension';
import { dimStyleSample, splitPost, joinPost } from '../src/ui/dimstyle';
import type { Editor } from '../src/app/editor';

const base = { id: 'd1', layer: 'DIM', color: 'ByLayer' as const, type: 'dimension' as const };
const linear = (style: DimStyle, extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  ...base,
  style,
  kind: 'linear',
  p1: { x: 0, y: 0 },
  p2: { x: 4, y: 0 },
  linePoint: { x: 2, y: 2 },
  rotation: 0,
  ...extra,
});
const texts = (parts: Entity[]) => parts.filter((p): p is TextEntity => p.type === 'text');

describe('arrowheads', () => {
  const props = { id: 'a', layer: '0', color: 7 as const };
  const tip = { x: 0, y: 0 };
  const dir = { x: 1, y: 0 };

  it('draws every arrow type with its tip at the given point', () => {
    const shapes: Record<DimArrow, (p: Entity[]) => void> = {
      'closed-filled': (p) => {
        expect(p).toHaveLength(1);
        expect(p[0]!.type === 'polyline' && p[0]!.filled && p[0]!.closed).toBe(true);
      },
      'closed-blank': (p) => expect(p[0]!.type === 'polyline' && p[0]!.closed && !p[0]!.filled).toBe(true),
      closed: (p) => expect(p[0]!.type === 'polyline' && p[0]!.closed && !p[0]!.filled).toBe(true),
      open: (p) => {
        const pl = p[0]!;
        expect(pl.type === 'polyline' && !pl.closed && pl.points.length === 3).toBe(true);
        if (pl.type === 'polyline') expect(pl.points[1]).toEqual(tip);
      },
      oblique: (p) => {
        const l = p[0]!;
        expect(l.type).toBe('line');
        if (l.type === 'line') {
          // 45° tick centred on the tip, length DIMASZ
          expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBeCloseTo(1);
          expect(Math.abs((l.b.y - l.a.y) / (l.b.x - l.a.x))).toBeCloseTo(1);
          expect((l.a.x + l.b.x) / 2).toBeCloseTo(0);
        }
      },
      'arch-tick': (p) => expect(p[0]!.type === 'polyline' && (p[0]!.width ?? 0) > 0).toBe(true),
      dot: (p) => expect(p[0]!.type === 'circle' && p[0]!.filled && p[0]!.radius === 0.25).toBe(true),
      'dot-small': (p) => expect(p[0]!.type === 'circle' && p[0]!.filled && p[0]!.radius < 0.1).toBe(true),
      'dot-blank': (p) => expect(p[0]!.type === 'circle' && !p[0]!.filled).toBe(true),
      none: (p) => expect(p).toHaveLength(0),
    };
    for (const a of DIM_ARROWS) {
      const parts = arrowParts(a.id, tip, dir, 1, props) as Entity[];
      shapes[a.id](parts);
      // closed shapes put the tip first
      if (a.id.startsWith('closed')) expect((parts[0] as unknown as { points: unknown[] }).points[0]).toEqual(tip);
      // body behind the tip
      if (a.id === 'closed-filled') expect((parts[0] as unknown as { points: Array<{ x: number }> }).points[1]!.x).toBeLessThan(0);
    }
  });

  it('ticks slant the same way at both ends', () => {
    const [l1] = arrowParts('oblique', tip, { x: 1, y: 0 }, 1, props);
    const [l2] = arrowParts('oblique', tip, { x: -1, y: 0 }, 1, props);
    expect(l1).toEqual(l2);
  });

  it('uses the style arrows in the dimension and stops the line at blank arrowheads', () => {
    const style: DimStyle = { ...STANDARD_DIMSTYLE, arrow: 'closed-blank', arrow2: 'dot' };
    const parts = dimensionGeometry(linear(style), textWidth);
    expect(parts.filter((p) => p.type === 'polyline' && p.closed && !p.filled)).toHaveLength(1);
    expect(parts.filter((p) => p.type === 'circle' && p.filled)).toHaveLength(1);
    const dimLine = parts.filter((p) => p.type === 'line' && Math.abs(p.a.y - 2) < 1e-9 && Math.abs(p.b.y - 2) < 1e-9);
    const xs = dimLine.flatMap((l) => (l.type === 'line' ? [l.a.x, l.b.x] : []));
    expect(Math.min(...xs)).toBeCloseTo(STANDARD_DIMSTYLE.arrowSize); // backed off by the blank arrow
    expect(Math.max(...xs)).toBeCloseTo(4); // the dot does not back off
  });

  it('extends the dimension line past tick marks by DIMDLE and draws no arrows for none', () => {
    const style: DimStyle = { ...STANDARD_DIMSTYLE, arrow: 'arch-tick', dimLineExtend: 0.1 };
    const parts = dimensionGeometry(linear(style), textWidth);
    const xs = parts.filter((p) => p.type === 'line' && Math.abs(p.a.y - 2) < 1e-9 && Math.abs(p.b.y - 2) < 1e-9).flatMap((l) => (l.type === 'line' ? [l.a.x, l.b.x] : []));
    expect(Math.min(...xs)).toBeCloseTo(-0.1);
    expect(Math.max(...xs)).toBeCloseTo(4.1);
    const none = dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, arrow: 'none' }), textWidth);
    expect(none.filter((p) => p.type === 'polyline' || p.type === 'circle')).toHaveLength(0);
  });

  it('maps arrow types to AutoCAD block names and back', () => {
    for (const a of DIM_ARROWS) expect(arrowFromBlockName(arrowBlockName(a.id))).toBe(a.id);
    expect(arrowFromBlockName('_ArchTick')).toBe('arch-tick');
    expect(arrowFromBlockName('Oblique')).toBe('oblique');
  });
});

describe('lines, text placement and colours', () => {
  it('suppresses extension lines and halves of the dimension line', () => {
    const all = dimensionGeometry(linear(STANDARD_DIMSTYLE), textWidth);
    const ext = (parts: Entity[]) => parts.filter((p) => p.type === 'line' && Math.abs(p.a.x - p.b.x) < 1e-9);
    expect(ext(all)).toHaveLength(2);
    const s1 = dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, suppressExt1: true }), textWidth);
    expect(ext(s1)).toHaveLength(1);
    expect(ext(s1)[0]!.type === 'line' && (ext(s1)[0] as { a: { x: number } }).a.x).toBe(4);
    const d1 = dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, suppressDimLine1: true }), textWidth);
    expect(d1.filter((p) => p.type === 'polyline')).toHaveLength(1);
    const xs = d1.filter((p) => p.type === 'line' && Math.abs(p.a.y - 2) < 1e-9 && Math.abs(p.b.y - 2) < 1e-9).flatMap((l) => (l.type === 'line' ? [l.a.x, l.b.x] : []));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('places text above, below or outside the dimension line (DIMTAD) and keeps the line whole', () => {
    const at = (v: DimStyle['textVertical']) => {
      const parts = dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, textVertical: v }), textWidth);
      const t = texts(parts)[0]!;
      const lines = parts.filter((p) => p.type === 'line' && Math.abs(p.a.y - 2) < 1e-9 && Math.abs(p.b.y - 2) < 1e-9);
      return { y: t.position.y + t.height / 2, lines: lines.length };
    };
    const c = at('centered');
    expect(c.y).toBeCloseTo(2);
    expect(c.lines).toBe(2);
    const a = at('above');
    expect(a.y).toBeCloseTo(2 + 0.09 + 0.09);
    expect(a.lines).toBe(1);
    expect(at('below').y).toBeCloseTo(2 - 0.18);
    // outside = away from the measured points (they are below the line here)
    expect(at('outside').y).toBeCloseTo(2 + 0.18);
    expect(dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, textVertical: 'outside' }, { linePoint: { x: 2, y: -2 } }), textWidth).find((p) => p.type === 'text')!.type).toBe('text');
  });

  it('draws horizontal text on a vertical dimension when DIMTIH/DIMTOH are on', () => {
    const v = linear({ ...STANDARD_DIMSTYLE, textAlign: 'horizontal' }, { p2: { x: 0, y: 4 }, linePoint: { x: -2, y: 2 }, rotation: Math.PI / 2 });
    const t = texts(dimensionGeometry(v, textWidth))[0]!;
    expect(t.rotation).toBe(0);
    const aligned = texts(dimensionGeometry({ ...v, style: STANDARD_DIMSTYLE }, textWidth))[0]!;
    expect(aligned.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('justifies text at an extension line (DIMJUST) and applies DIMCLRT/DIMCLRD/DIMCLRE', () => {
    const style: DimStyle = { ...STANDARD_DIMSTYLE, textJustify: 'ext1', textColor: 1, dimLineColor: 3, extLineColor: 5 };
    const parts = dimensionGeometry(linear(style), textWidth);
    const t = texts(parts)[0]!;
    expect(t.position.x).toBeLessThan(2);
    expect(t.color).toBe(1);
    expect(parts.filter((p) => p.type === 'line' && p.color === 5)).toHaveLength(2);
    expect(parts.filter((p) => p.type === 'polyline').every((p) => p.color === 3)).toBe(true);
  });

  it('honours DIMEDIT oblique extension lines and a text rotation override', () => {
    const d = linear(STANDARD_DIMSTYLE, { oblique: Math.PI / 4, textRotation: Math.PI / 6 });
    const parts = dimensionGeometry(d, textWidth);
    const ext = parts.filter((p) => p.type === 'line' && Math.abs(Math.abs((p.b.y - p.a.y) / (p.b.x - p.a.x)) - 1) < 1e-6);
    expect(ext).toHaveLength(2);
    expect(texts(parts)[0]!.rotation).toBeCloseTo(Math.PI / 6);
    expect(dimensionText(d)).toBe('4.0000'); // the measurement does not change
  });
});

describe('dimension text: units, tolerances and alternate units', () => {
  it('formats DIMPOST, DIMRND, DIMLFAC and zero suppression', () => {
    expect(applyPost('4.00', ' mm')).toBe('4.00 mm');
    expect(applyPost('4.00', 'L=<> TYP')).toBe('L=4.00 TYP');
    expect(suppressZeros('0.5000', true, true)).toBe('.5');
    expect(suppressZeros('4.0000', false, true)).toBe('4');
    expect(suppressZeros('4\'-2"', true, true)).toBe('4\'-2"');
    expect(dimensionText(linear({ ...STANDARD_DIMSTYLE, post: '<>"' }))).toBe('4.0000"');
    expect(dimensionText(linear({ ...STANDARD_DIMSTYLE, round: 0.25, decimals: 2 }, { p2: { x: 4.13, y: 0 } }))).toBe('4.25');
    expect(dimensionText(linear({ ...STANDARD_DIMSTYLE, linearFactor: 2, decimals: 1 }))).toBe('8.0');
    expect(dimensionText(linear({ ...STANDARD_DIMSTYLE, lunit: 4, decimals: 4 }, { p2: { x: 30.5, y: 0 } }))).toBe('2\'-6 1/2"');
    expect(dimensionText(linear({ ...STANDARD_DIMSTYLE, lunit: 5, decimals: 3 }, { p2: { x: 2.375, y: 0 } }))).toBe('2 3/8');
  });

  it('formats symmetrical, deviation, limits and basic tolerances', () => {
    const tol = (t: DimStyle['tolerance'], extra: Partial<DimStyle> = {}) => ({ ...STANDARD_DIMSTYLE, decimals: 2, tolDecimals: 3, tolerance: t, tolPlus: 0.01, tolMinus: 0.02, ...extra });
    expect(dimensionText(linear(tol('symmetrical')))).toBe('4.00%%p0.010');
    const dev = dimensionTextLayout(linear(tol('deviation')));
    expect(dev).toMatchObject({ main: '4.00', upper: '+0.010', lower: '-0.020' });
    expect(dimensionText(linear(tol('deviation')))).toBe('4.00 +0.010/-0.020');
    // zero deviation shows no sign; a negative DIMTM makes the lower value positive
    expect(dimensionTextLayout(linear(tol('deviation', { tolMinus: 0 }))).lower).toBe('0.000');
    expect(dimensionTextLayout(linear(tol('deviation', { tolMinus: -0.005 }))).lower).toBe('+0.005');
    const lim = dimensionTextLayout(linear(tol('limits')));
    expect(lim).toMatchObject({ main: '', upper: '4.01', lower: '3.98' });
    expect(dimensionTextLayout(linear(tol('basic'))).box).toBe(true);
    // an override without <> drops the tolerance, one with <> keeps it
    expect(dimensionText(linear(tol('symmetrical'), { text: 'REF' }))).toBe('REF');
    expect(dimensionText(linear(tol('symmetrical'), { text: '(<>)' }))).toBe('(4.00%%p0.010)');
  });

  it('lays out deviation tolerances as stacked smaller text and boxes basic dimensions', () => {
    const style: DimStyle = { ...STANDARD_DIMSTYLE, tolerance: 'deviation', tolPlus: 0.01, tolMinus: 0.02, tolScale: 0.5 };
    const t = texts(dimensionGeometry(linear(style), textWidth));
    expect(t).toHaveLength(3);
    expect(t[1]!.height).toBeCloseTo(0.09);
    expect(t[1]!.align).toBe('left');
    expect(t[1]!.position.y).toBeGreaterThan(t[2]!.position.y);
    expect(new Set(t.map((x) => x.id)).size).toBe(3);
    const basic = dimensionGeometry(linear({ ...STANDARD_DIMSTYLE, tolerance: 'basic' }), textWidth);
    expect(basic.filter((p) => p.type === 'polyline' && p.closed && !p.filled && p.points.length === 4)).toHaveLength(1);
  });

  it('adds alternate units after or below the primary value', () => {
    const alt: DimStyle = { ...STANDARD_DIMSTYLE, altUnits: true, altFactor: 25.4, altDecimals: 1 };
    expect(dimensionText(linear(alt))).toBe('4.0000 [101.6]');
    expect(dimensionText(linear({ ...alt, altPost: '<> mm' }))).toBe('4.0000 101.6 mm');
    const below = linear({ ...alt, altPlacement: 'below' });
    expect(dimensionTextLayout(below)).toMatchObject({ main: '4.0000', altBelow: '[101.6]' });
    const t = texts(dimensionGeometry(below, textWidth));
    expect(t).toHaveLength(2);
    expect(t[1]!.position.y).toBeLessThan(t[0]!.position.y);
    // radius dimensions keep their prefix, angular ones get no alternate value
    expect(dimensionText({ ...linear(alt), kind: 'radius', p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 }, linePoint: { x: 0.5, y: 0 } })).toBe('R1.0000 [25.4]');
    expect(dimensionText({ ...linear(alt), kind: 'angular', center: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p2: { x: 0, y: 1 }, linePoint: { x: 1, y: 1 } })).toBe('90%%d');
    // the text point is the centre of the whole block
    const p = dimensionTextPoint(below, textWidth);
    expect(p.x).toBeCloseTo(2);
  });
});

describe('named styles in the drawing', () => {
  it('saves, finds, redefines and deletes styles through meta.dimStyles', () => {
    const d = new Drawing();
    expect(namedDimStyles(d.snapshot).map((s) => s.name)).toEqual(['Standard']);
    const arch: DimStyle = { ...STANDARD_DIMSTYLE, name: 'Arch', arrow: 'arch-tick', textVertical: 'above' };
    d.transact((s) => withDimStyle(s, arch));
    expect(findDimStyle(d.snapshot, 'arch')).toEqual(arch);
    d.addEntities([linear(arch)]);
    expect(dimStyleUsage(d.snapshot, 'ARCH')).toBe(1);
    // redefining updates the dimensions that use it
    const arch2 = { ...arch, textHeight: 0.25 };
    d.transact((s) => withDimStyle(s, arch2));
    expect((d.entities[0] as DimensionEntity).style.textHeight).toBe(0.25);
    expect(namedDimStyles(d.snapshot)).toHaveLength(2);
    // in use: cannot delete; unused: deleted; Standard never
    expect(withoutDimStyle(d.snapshot, 'Arch')).toBe(d.snapshot);
    d.removeEntities(['d1']);
    d.transact((s) => withoutDimStyle(s, 'arch'));
    expect(findDimStyle(d.snapshot, 'Arch')).toBeUndefined();
    expect(withoutDimStyle(d.snapshot, 'Standard')).toBe(d.snapshot);
    // undo brings it back (named styles travel with the undo history)
    d.undo();
    expect(findDimStyle(d.snapshot, 'Arch')).toBeDefined();
  });

  it('-DIMSTYLE Save / Restore / ? / Variables / Apply round-trip through meta', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    d.setHeader({ dimStyle: { ...STANDARD_DIMSTYLE, arrow: 'dot', textHeight: 0.125 } });
    drive(dimstyleCommandTool(), ctx, ['S', 'Mech']);
    expect(d.header.dimStyle.name).toBe('Mech');
    expect(findDimStyle(d.snapshot, 'MECH')).toMatchObject({ arrow: 'dot', textHeight: 0.125 });
    drive(dimstyleCommandTool('Restore Standard'), ctx, []);
    expect(d.header.dimStyle).toEqual(STANDARD_DIMSTYLE);
    drive(dimstyleCommandTool('Restore'), ctx, ['mech']);
    expect(d.header.dimStyle.name).toBe('Mech');
    expect(d.header.dimStyle.arrow).toBe('dot');
    ctx.logs.length = 0;
    drive(dimstyleCommandTool('?'), ctx, []);
    expect(ctx.logs.join('\n')).toMatch(/Mech {2}\(current\)/);
    ctx.logs.length = 0;
    drive(dimstyleCommandTool('Restore ~Standard'), ctx, []);
    expect(ctx.logs.join('\n')).toMatch(/DIMTXT/);
    expect(ctx.logs.join('\n')).toMatch(/DIMBLK1/);
    ctx.logs.length = 0;
    drive(dimstyleCommandTool('Variables Mech'), ctx, []);
    expect(ctx.logs.some((l) => /DIMTXT\s+0.1250/.test(l))).toBe(true);
    // Saving over another existing name asks first
    drive(dimstyleCommandTool(), ctx, ['Save', 'Standard', 'N']);
    expect(findDimStyle(d.snapshot, 'Standard')).toEqual(STANDARD_DIMSTYLE);
    // Apply
    d.addEntities([linear(STANDARD_DIMSTYLE)]);
    drive(dimstyleCommandTool('Apply'), ctx, [{ select: ['d1'] }]);
    expect((d.entity('d1') as DimensionEntity).style.name).toBe('Mech');
  });

  it('compares styles variable by variable', () => {
    const diff = diffDimStyles(STANDARD_DIMSTYLE, { ...STANDARD_DIMSTYLE, name: 'X', arrow: 'open', tolerance: 'limits' });
    expect(diff.map((x) => x.name).sort()).toEqual(['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLIM']);
    expect(diffDimStyles(STANDARD_DIMSTYLE, STANDARD_DIMSTYLE)).toEqual([]);
  });
});

describe('DIM* variables and DXF records', () => {
  it('reads and writes variables as DXF values', () => {
    let s: DimStyle = STANDARD_DIMSTYLE;
    s = withDimVar(s, 'DIMTAD', 1);
    expect(s.textVertical).toBe('above');
    s = withDimVar(s, 'DIMBLK', '_OBLIQUE');
    expect(resolveDimStyle(s)).toMatchObject({ arrow: 'oblique', arrow2: 'oblique' });
    s = withDimVar(s, 'DIMTP', 0.01);
    s = withDimVar(s, 'DIMTM', 0.01);
    s = withDimVar(s, 'DIMTOL', 1);
    expect(s.tolerance).toBe('symmetrical');
    s = withDimVar(s, 'DIMLIM', 1);
    expect(s.tolerance).toBe('limits');
    s = withDimVar(s, 'DIMLIM', 0);
    expect(s.tolerance).toBe('none');
    s = withDimVar(s, 'DIMCLRT', 2);
    expect(dimVarValue(s, 'DIMCLRT')).toBe(2);
    s = withDimVar(s, 'DIMPOST', '<> mm');
    expect(dimVarValue(s, 'DIMPOST')).toBe('<> mm');
    s = withDimVar(s, 'DIMTIH', 1);
    s = withDimVar(s, 'DIMTOH', 1);
    expect(s.textAlign).toBe('horizontal');
    expect(dimVarValue(s, 'DIMTIH')).toBe(1);
    expect(dimVarValue(STANDARD_DIMSTYLE, 'DIMDLI')).toBe(0.38);
  });

  it('round-trips a full style through DIMSTYLE record pairs', () => {
    const style: DimStyle = {
      ...ISO25_DIMSTYLE,
      name: 'Everything',
      baselineSpacing: 5,
      dimLineExtend: 1,
      suppressExt2: true,
      suppressDimLine1: true,
      textVertical: 'outside',
      textJustify: 'ext2',
      textAlign: 'iso',
      textColor: 3,
      dimLineColor: 1,
      fit: 'text',
      textInside: true,
      dimLineInside: false,
      post: '<> mm',
      round: 0.5,
      linearFactor: 2,
      altUnits: true,
      altFactor: 0.0394,
      altDecimals: 3,
      altLunit: 5,
      altPost: '<>"',
      tolerance: 'deviation',
      tolPlus: 0.1,
      tolMinus: 0.2,
      tolDecimals: 1,
      tolScale: 0.7,
    };
    const pairs = dimStyleRecordPairs(style);
    expect(pairs).toContainEqual([77, 2]);
    expect(pairs).toContainEqual([71, 1]);
    const back = dimStyleFromRecordPairs('Everything', pairs, STANDARD_DIMSTYLE);
    const { arrow: _a, arrow2: _b, altPlacement: _c, suppressLeadingZeros: _d, suppressTrailingZeros: _e, ...rest } = resolveDimStyle(style);
    expect(resolveDimStyle(back)).toMatchObject(rest);
  });
});

describe('DIMBASELINE / DIMCONTINUE', () => {
  const first = linear(STANDARD_DIMSTYLE, { id: 'base', p2: { x: 2, y: 0 }, linePoint: { x: 1, y: 1 } });

  it('steps baseline dimensions away by DIMDLI × DIMSCALE and keeps the first origin', () => {
    const b = chainDimension(first, 'baseline', first.p1, { x: 5, y: 0 }, { ...STANDARD_DIMSTYLE, scale: 2 }, 'n1');
    expect(b.p1).toEqual({ x: 0, y: 0 });
    expect(b.p2).toEqual({ x: 5, y: 0 });
    expect(b.linePoint.y).toBeCloseTo(1 + 0.38 * 2);
    // below the geometry the step goes down
    const under = { ...first, linePoint: { x: 1, y: -1 } };
    expect(chainDimension(under, 'baseline', under.p1, { x: 5, y: 0 }).linePoint.y).toBeCloseTo(-1.38);
  });

  it('continues from the second origin on the same dimension line', () => {
    const c = chainDimension(first, 'continue', first.p2, { x: 5, y: 0 });
    expect(c.p1).toEqual({ x: 2, y: 0 });
    expect(c.linePoint.y).toBe(1);
    expect(dimensionText(c)).toBe('3.0000');
  });

  it('chains angular dimensions around the vertex', () => {
    const ang: DimensionEntity = { ...base, style: STANDARD_DIMSTYLE, kind: 'angular', center: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p2: { x: 0, y: 1 }, linePoint: { x: 0.7, y: 0.7 }, rotation: 0 };
    const c = chainDimension(ang, 'continue', ang.p2, { x: -1, y: 0 });
    expect(dimensionText(c)).toBe('90%%d');
    expect(c.linePoint.x).toBeLessThan(0);
    const b = chainDimension(ang, 'baseline', ang.p1, { x: -1, y: 0.0001 });
    expect(Math.hypot(b.linePoint.x, b.linePoint.y)).toBeCloseTo(Math.hypot(0.7, 0.7) + 0.38);
    expect(b.linePoint.y).toBeGreaterThan(0);
  });

  it('runs as commands from the last dimension, with Undo', () => {
    const d = new Drawing();
    d.setHeader({ dimStyle: STANDARD_DIMSTYLE });
    d.addEntities([first]);
    const ctx = fakeContext(d);
    expect(lastChainableDimension(d)!.id).toBe('base');
    drive(dimBaselineTool(), ctx, [{ x: 4, y: 0 }, { x: 6, y: 0 }, 'U', { x: 7, y: 0 }]);
    const dims = d.entities.filter((e): e is DimensionEntity => e.type === 'dimension');
    expect(dims.map((x) => x.p2.x)).toEqual([2, 4, 7]);
    expect(dims[2]!.linePoint.y).toBeCloseTo(1 + 2 * 0.38);
    drive(dimContinueTool(), ctx, [{ x: 9, y: 0 }]);
    const cont = d.entities[d.entities.length - 1] as DimensionEntity;
    expect(cont.p1.x).toBe(7);
    expect(cont.linePoint.y).toBeCloseTo(dims[2]!.linePoint.y);
  });
});

describe('DIMTEDIT / DIMEDIT', () => {
  it('edits text position, rotation, override and oblique angle', () => {
    const d = linear(STANDARD_DIMSTYLE);
    const left = justifiedTextPosition(d, 'left')!;
    const right = justifiedTextPosition(d, 'right')!;
    expect(left.x).toBeLessThan(2);
    expect(right.x).toBeGreaterThan(2);
    expect(justifiedTextPosition(d, 'center')).toEqual({ x: 2, y: 2 });
    const [home] = editDimensions([{ ...d, textPosition: { x: 1, y: 1 }, textRotation: 1 }], { kind: 'home' });
    expect(home!.textPosition).toBeUndefined();
    expect(home!.textRotation).toBeUndefined();
    expect(editDimensions([d], { kind: 'new', text: 'L=<>' })[0]!.text).toBe('L=<>');
    expect(editDimensions([{ ...d, text: 'X' }], { kind: 'new', text: '' })[0]!.text).toBeUndefined();
    expect(editDimensions([d], { kind: 'oblique', angle: 1 })[0]!.oblique).toBe(1);
    expect(editDimensions([{ ...d, kind: 'radius' }], { kind: 'oblique', angle: 1 })).toHaveLength(0);
  });

  it('runs DIMTEDIT and DIMEDIT against the drawing', () => {
    const doc = new Drawing();
    const d = linear(STANDARD_DIMSTYLE);
    doc.addEntities([d]);
    const ctx = fakeContext(doc);
    drive(dimTeditTool(), ctx, [{ x: 2, y: 2 }, 'Angle', '30']);
    expect((doc.entity('d1') as DimensionEntity).textRotation).toBeCloseTo(Math.PI / 6);
    drive(dimTeditTool(), ctx, [{ x: 2, y: 2 }, { x: 3, y: 3 }]);
    expect((doc.entity('d1') as DimensionEntity).textPosition).toEqual({ x: 3, y: 3 });
    drive(dimEditTool(), ctx, ['New', '<> TYP', { select: ['d1'] }]);
    expect(dimensionText(doc.entity('d1') as DimensionEntity)).toBe('4.0000 TYP');
    drive(dimEditTool(), ctx, ['Oblique', { select: ['d1'] }, '60']);
    expect((doc.entity('d1') as DimensionEntity).oblique).toBeCloseTo(Math.PI / 3);
    drive(dimEditTool(), ctx, ['', { select: ['d1'] }]);
    expect((doc.entity('d1') as DimensionEntity).textPosition).toBeUndefined();
  });
});

describe('registration and the dialog helpers', () => {
  it('replaces DIMSTYLE and adds the chain/edit commands and missing DIM variables', () => {
    const commands = new Map<string, { name: string; aliases: string[] }>();
    commands.set('DIMTXT', { name: 'DIMTXT', aliases: [] });
    const editor = {
      commands,
      register: (def: { name: string; aliases: string[] }) => {
        commands.set(def.name.toUpperCase(), def);
        for (const a of def.aliases) commands.set(a.toUpperCase(), def);
      },
    } as unknown as Editor;
    registerDimStyleCommands(editor);
    for (const n of ['DIMSTYLE', 'D', 'DDIM', '-DIMSTYLE', 'DIMBASELINE', 'DBA', 'DIMCONTINUE', 'DCO', 'DIMTEDIT', 'DIMEDIT', 'DED', 'DIMTAD', 'DIMBLK', 'DIMTOL', 'DIMALT', 'DIMPOST']) expect(commands.has(n)).toBe(true);
    expect(commands.get('DIMTXT')!.aliases).toEqual([]); // existing variables are left alone
  });

  it('builds the preview sample and splits DIMPOST for the prefix/suffix fields', () => {
    const sample = dimStyleSample(ISO25_DIMSTYLE);
    expect(sample.filter((e) => e.type === 'dimension').map((e) => (e as DimensionEntity).kind)).toEqual(['linear', 'linear', 'aligned', 'radius', 'angular']);
    // scaled to the style: ISO text is 2.5 high, so the part is about 2.5/0.18 times larger
    const h = sample.find((e) => e.id === 's:h') as DimensionEntity;
    expect(h.p2.x).toBeCloseTo(3 * (2.5 / 0.18));
    expect(splitPost('<> mm')).toEqual({ prefix: '', suffix: ' mm' });
    expect(splitPost('M<>x')).toEqual({ prefix: 'M', suffix: 'x' });
    expect(splitPost(' mm')).toEqual({ prefix: '', suffix: ' mm' });
    expect(joinPost('', ' mm')).toBe(' mm');
    expect(joinPost('Ø', '')).toBe('Ø<>');
  });
});

describe('radial text alignment', () => {
  it('keeps radius text horizontal unless the style asks for aligned text', () => {
    const r: DimensionEntity = { ...base, style: STANDARD_DIMSTYLE, kind: 'radius', p1: { x: 0, y: 0 }, p2: { x: 2, y: 2 }, linePoint: { x: 1, y: 1 }, rotation: 0 };
    expect(texts(dimensionGeometry(r, textWidth))[0]!.rotation).toBe(0);
    const aligned = texts(dimensionGeometry({ ...r, style: { ...STANDARD_DIMSTYLE, textAlign: 'aligned' } }, textWidth))[0]!;
    expect(aligned.rotation).toBeCloseTo(Math.PI / 4);
  });
});
