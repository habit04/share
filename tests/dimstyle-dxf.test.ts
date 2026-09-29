import { describe, it, expect } from 'vitest';
import { writeDxf, readDxf, DIMSTYLE_APP } from '../src/io/dxf';
import { DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import type { DimensionEntity } from '../src/core/entities';
import { STANDARD_DIMSTYLE, ISO25_DIMSTYLE, namedDimStyles, resolveDimStyle, withDimStyle, dimVarList, dimVarValue, type DimStyle } from '../src/core/dimension';

const layers = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }];

const OPEN_TOL: DimStyle = {
  ...STANDARD_DIMSTYLE,
  name: 'Mech-Open',
  arrow: 'open',
  arrow2: 'dot',
  tolerance: 'deviation',
  tolPlus: 0.01,
  tolMinus: 0.02,
  tolDecimals: 3,
  tolScale: 0.7,
  textVertical: 'above',
  textColor: 2,
  dimLineColor: 1,
  extLineColor: 3,
  suppressTrailingZeros: true,
};
const ARCH_ALT: DimStyle = {
  ...STANDARD_DIMSTYLE,
  name: 'Arch-Alt',
  arrow: 'arch-tick',
  dimLineExtend: 0.1,
  altUnits: true,
  altFactor: 25.4,
  altDecimals: 1,
  altLunit: 2,
  altPost: '[<> mm]',
  altPlacement: 'below',
  textAlign: 'horizontal',
  textJustify: 'ext1',
  post: '<>"',
};
const ISO_BASIC: DimStyle = {
  ...ISO25_DIMSTYLE,
  name: 'ISO-Basic',
  arrow: 'closed-blank',
  tolerance: 'basic',
  fit: 'arrows',
  suppressExt1: true,
  suppressDimLine2: true,
  linearFactor: 2,
  round: 0.5,
};

const dim = (id: string, style: DimStyle, extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id,
  type: 'dimension',
  layer: '0',
  color: 'ByLayer',
  kind: 'linear',
  p1: { x: 0, y: 0 },
  p2: { x: 4, y: 0 },
  linePoint: { x: 2, y: 1 },
  rotation: 0,
  style,
  ...extra,
});

function drawing(): DrawingState {
  let s: DrawingState = {
    entities: [dim('a', OPEN_TOL, { textRotation: Math.PI / 6 }), dim('b', ARCH_ALT, { kind: 'aligned', oblique: Math.PI / 3 }), dim('c', ISO_BASIC, { textRotation: 0, oblique: 0 })],
    layers,
    blocks: {},
    currentLayer: '0',
    header: { ...DEFAULT_HEADER, dimStyle: OPEN_TOL },
  };
  for (const st of [OPEN_TOL, ARCH_ALT, ISO_BASIC]) s = withDimStyle(s, st, false);
  return s;
}

const byName = (list: DimStyle[], name: string) => list.find((s) => s.name === name)!;

describe('dimension styles in DXF', () => {
  it('writes one DIMSTYLE record per named style with the arrow XDATA', () => {
    const out = writeDxf(drawing());
    const records = out.match(/\r\n0\r\nDIMSTYLE\r\n/g) ?? [];
    expect(records.length).toBe(4); // Standard + three named styles
    expect(out).toContain(`1001\r\n${DIMSTYLE_APP}\r\n1000\r\nDIMBLK1\r\n1000\r\n_OPEN\r\n1000\r\nDIMBLK2\r\n1000\r\n_DOT\r\n`);
    expect(out).toContain(`2\r\n${DIMSTYLE_APP}\r\n`); // registered APPID
    // Header variables of the current style.
    expect(out).toContain('9\r\n$DIMBLK1\r\n1\r\n_OPEN\r\n');
    expect(out).toContain('9\r\n$DIMBLK2\r\n1\r\n_DOT\r\n');
    expect(out).toContain('9\r\n$DIMSAH\r\n70\r\n1\r\n');
    expect(out).toContain('9\r\n$DIMTOL\r\n70\r\n1\r\n');
    expect(out).toContain('9\r\n$DIMLIM\r\n70\r\n0\r\n');
    expect(out).toContain('9\r\n$DIMTAD\r\n70\r\n1\r\n');
    expect(out).toContain('9\r\n$DIMCLRT\r\n70\r\n2\r\n');
    expect(out).toContain('9\r\n$DIMZIN\r\n70\r\n8\r\n');
    // Groups 53 / 52 in degrees; an explicit 0 is written as 360.
    expect(out).toMatch(/\r\n53\r\n30(\.0+)?\r\n/);
    expect(out).toMatch(/\r\n52\r\n60(\.0+)?\r\n/);
    expect(out).toMatch(/\r\n53\r\n360(\.0+)?\r\n/);
  });

  it('round-trips three named styles, the current style and the dimension angles', () => {
    const src = drawing();
    const back = readDxf(writeDxf(src));
    const named = namedDimStyles(back);
    for (const st of [OPEN_TOL, ARCH_ALT, ISO_BASIC]) {
      const got = byName(named, st.name);
      expect(got, st.name).toBeDefined();
      expect(resolveDimStyle(got)).toEqual(resolveDimStyle(st));
    }
    // The current style's variables match one for one.
    expect(back.header!.dimStyle.name).toBe('Mech-Open');
    const want = dimVarList(OPEN_TOL);
    const got = dimVarList(back.header!.dimStyle);
    expect(got).toEqual(want);
    // Dimensions keep their style and angles.
    const dims = back.entities.filter((e): e is DimensionEntity => e.type === 'dimension');
    expect(dims.map((d) => d.style.name)).toEqual(['Mech-Open', 'Arch-Alt', 'ISO-Basic']);
    expect(resolveDimStyle(dims[2]!.style).tolerance).toBe('basic');
    expect(dims[0]!.textRotation).toBeCloseTo(Math.PI / 6);
    expect(dims[1]!.kind).toBe('aligned');
    expect(dims[1]!.oblique).toBeCloseTo(Math.PI / 3);
    expect(Math.cos(dims[2]!.textRotation!)).toBeCloseTo(1);
    expect(Math.cos(dims[2]!.oblique!)).toBeCloseTo(1);
    expect(dims[1]!.textRotation).toBeUndefined();
  });

  it('writes styles used only by dimensions and survives a second round trip unchanged', () => {
    const orphan: DimStyle = { ...STANDARD_DIMSTYLE, name: 'Orphan', arrow: 'none', decimals: 1 };
    const src: DrawingState = { entities: [dim('x', orphan)], layers, blocks: {}, currentLayer: '0' };
    const once = readDxf(writeDxf(src));
    expect(resolveDimStyle(byName(namedDimStyles(once), 'Orphan'))).toEqual(resolveDimStyle(orphan));
    const twice = readDxf(writeDxf(once));
    expect(namedDimStyles(twice).map((s) => resolveDimStyle(s))).toEqual(namedDimStyles(once).map((s) => resolveDimStyle(s)));
  });

  it('reads arrow blocks of other programs from 342-344 handles and header $DIMBLK', () => {
    const lines = [
      '0', 'SECTION', '2', 'HEADER',
      '9', '$DIMSTYLE', '2', 'Other',
      '9', '$DIMBLK', '1', '_ARCHTICK',
      '9', '$DIMSAH', '70', '0',
      '9', '$DIMTXT', '40', '0.25',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'TABLES',
      '0', 'TABLE', '2', 'DIMSTYLE', '70', '1',
      '0', 'DIMSTYLE', '105', '30', '2', 'Other', '70', '0', '140', '0.2', '41', '0.1', '173', '1', '343', 'A1', '344', 'A2',
      '0', 'ENDTAB',
      '0', 'TABLE', '2', 'BLOCK_RECORD', '70', '2',
      '0', 'BLOCK_RECORD', '5', 'A1', '2', '_OPEN',
      '0', 'BLOCK_RECORD', '5', 'A2', '2', '_DOTSMALL',
      '0', 'ENDTAB',
      '0', 'ENDSEC',
      '0', 'EOF',
    ];
    const back = readDxf(lines.join('\n'));
    const rec = byName(namedDimStyles(back), 'Other');
    expect(resolveDimStyle(rec)).toMatchObject({ arrow: 'open', arrow2: 'dot-small', textHeight: 0.2, arrowSize: 0.1 });
    // The header overrides the record: DIMSAH off, both arrows from $DIMBLK, DIMTXT 0.25.
    expect(resolveDimStyle(back.header!.dimStyle)).toMatchObject({ arrow: 'arch-tick', arrow2: 'arch-tick', textHeight: 0.25, arrowSize: 0.1 });
    expect(dimVarValue(back.header!.dimStyle, 'DIMBLK')).toBe('_ARCHTICK');
  });

  it('keeps plain drawings free of dimension style meta', () => {
    const back = readDxf(writeDxf({ entities: [], layers, blocks: {}, currentLayer: '0' }));
    expect(back.meta).toBeUndefined();
    expect(back.header!.dimStyle.name).toBe('Standard');
  });
});
