/**
 * DWG import fidelity through the LibreDWG payload: layouts and viewports, text styles, named
 * dimension styles, custom linetypes, true colours, ByBlock colours (block colour inheritance) and
 * layer flags, checked on the committed DWG fixtures against their DXF equivalent, and on payloads
 * shaped like LibreDWG's output for what the fixtures do not contain. What the reader cannot see
 * is listed in the import report as "not supported yet".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertDwg, toImportPayload, type DwgImportPayload } from '../src/io/dwg';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { explodeInsert, type InsertEntity, type DimensionEntity } from '../src/core/entities';
import { resolveColor, trueColorCss } from '../src/render/draw';
import { aciToCss } from '../src/render/palette';
import { namedDimStyles, dimensionText } from '../src/core/dimension';
import { textStylesOf } from '../src/io/encoding';
import type { DrawingState } from '../src/core/document';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload, payloadFromDatabase } from '../scripts/dwg-reader.mjs';

const fixtures = join(__dirname, '..', 'fixtures');
const dwg = async (f: string) => convertDwg((await readDwgPayload(readFileSync(join(fixtures, f)), 'dwg')).payload, f);

describe('DWG fixtures against their DXF equivalent', () => {
  it('layouts, dimension styles and layers match the DXF saved from the same drawing', async () => {
    const { state } = await dwg('example_2000.dwg');
    const dxf = readDxf(readFileSync(join(fixtures, 'example_2000.dxf'), 'latin1'));
    const layouts = (s: DrawingState) => s.layouts?.map((l) => ({ name: l.name, paper: l.paper.id, units: l.paper.units, orientation: l.paper.orientation, viewports: l.viewports.length, entities: l.entities.length }));
    expect(layouts(state)).toEqual(layouts(dxf));
    expect(layouts(state)?.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    expect(state.layouts![0]!.margins.left).toBeCloseTo(dxf.layouts![0]!.margins.left, 3);
    expect(namedDimStyles(state).map((d) => d.name)).toEqual(namedDimStyles(dxf).map((d) => d.name));
    const iso = namedDimStyles(state).find((d) => d.name === 'ISO-25')!;
    const isoDxf = namedDimStyles(dxf).find((d) => d.name === 'ISO-25')!;
    for (const k of ['textHeight', 'arrowSize', 'extOffset', 'extExtend', 'textGap', 'decimals'] as const) expect(iso[k], k).toBeCloseTo(isoDxf[k] as number, 6);
    const dimStyles = (s: DrawingState) => s.entities.filter((e): e is DimensionEntity => e.type === 'dimension').map((d) => d.style.name);
    expect(dimStyles(state)).toEqual(dimStyles(dxf));
    const flags = (s: DrawingState) => s.layers.map((l) => [l.name.replace(/^\*/, ''), l.color, l.locked, !!l.frozen, l.plot !== false]);
    expect(flags(state)).toEqual(flags(dxf));
  }, 60000);

  for (const f of ['example_r14.dwg', 'example_2018.dwg']) {
    it(`${f}: layouts from the LAYOUT objects, the paper from their limits, the rest reported`, async () => {
      const { state, report } = await dwg(f);
      expect(state.layouts?.map((l) => [l.name, l.paper.id, l.pristine])).toEqual([
        ['Layout1', 'letter', true],
        ['Layout2', 'letter', true],
      ]);
      expect(namedDimStyles(state).map((d) => d.name)).toContain('ISO-25');
      expect(state.layers.every((l) => l.name === 'ADSK_SYSTEM_LIGHTS' || l.name === '*ADSK_SYSTEM_LIGHTS' || !l.locked)).toBe(true);
      expect(report?.counts.LAYOUT).toEqual({ unsupported: 2 });
      expect(report?.items.find((i) => i.type === 'LAYOUT')?.reason).toMatch(/page setup .* not exposed by the DWG reader/);
      expect(report?.counts.WIPEOUT).toEqual({ dropped: 2 });
      expect(report?.items.filter((i) => i.type === 'POLYLINE3D').some((i) => i.reason.includes('XY projection'))).toBe(true);
      expect(importReportOf(state)).toBe(report);
      // and the layouts survive our DXF writer / reader
      expect(readDxf(writeDxf(state)).layouts?.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    }, 60000);
  }
});

/** A payload shaped like LibreDWG's (see scripts/dwg-reader.mjs payloadFromDatabase). */
function payload(extra: Partial<DwgImportPayload> = {}): DwgImportPayload {
  const ent = (type: string, handle: string, more: Record<string, unknown>) => ({ type, handle, ownerBlockRecordSoftId: '1F', layer: '0', colorIndex: 256, lineType: '', lineweight: 29, lineTypeScale: 1, isVisible: true, transparency: 0, transparencyType: 0, ...more });
  return {
    header: { INSUNITS: 4, DIMSTYLE: 'Standard' },
    layers: [
      { name: '0', colorIndex: 7, color: 0xffffff, off: false, frozen: false, locked: true, lineweight: 31, lineType: 'Continuous', standardFlag: 16, plotFlag: 1 },
      { name: 'RGB', colorIndex: 256, color: 0x336699, off: false, frozen: false, locked: true, lineweight: 31, lineType: 'BORDER2X', standardFlag: 16, plotFlag: 1 },
      { name: 'L1', colorIndex: 1, color: 0xffffff, off: false, frozen: false, locked: true, lineweight: 31, lineType: 'Continuous', standardFlag: 20, plotFlag: 1 },
      { name: 'NOPLOT', colorIndex: 8, color: 0xffffff, off: false, frozen: false, locked: true, lineweight: 31, lineType: 'Continuous', standardFlag: 16, plotFlag: 0 },
    ],
    entities: [
      ent('LINE', '100', { layer: '0', colorIndex: 1, color: 0xff8800, startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 10, y: 0, z: 0 } }),
      ent('INSERT', '101', { layer: 'L1', colorIndex: 3, name: 'SYM', insertionPoint: { x: 0, y: 0, z: 0 }, xScale: 1, yScale: 1, rotation: 0 }),
      ent('INSERT', '102', { layer: 'RGB', colorIndex: 256, name: 'SYM', insertionPoint: { x: 0, y: 10, z: 0 }, xScale: 1, yScale: 1, rotation: 0 }),
      ent('DIMENSION', '103', { layer: '0', styleName: 'MECH', dimensionType: 1, definitionPoint: { x: 0, y: -5 }, subDefinitionPoint1: { x: 0, y: 0 }, subDefinitionPoint2: { x: 10, y: 0 }, textPoint: { x: 5, y: -5 } }),
      ent('CIRCLE', '104', { layer: '0', center: { x: 1, y: 1, z: 0 }, radius: -3 }),
      ent('LINE', '105', { layer: '0', startPoint: { x: NaN, y: 0, z: 0 }, endPoint: { x: 1, y: 0, z: 0 } }),
      ent('VIEWPORT', '200', { layer: '0', ownerBlockRecordSoftId: '50' }),
    ] as unknown as DwgImportPayload['entities'],
    blocks: [
      { name: '*Model_Space', basePoint: { x: 0, y: 0 }, entities: [], description: '', handle: '1F', flags: 0 },
      {
        name: 'SYM',
        basePoint: { x: 0, y: 0 },
        description: '',
        handle: 'B1',
        flags: 0,
        entities: [
          ent('LINE', 'B2', { layer: '0', colorIndex: 0, startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } }),
          ent('LINE', 'B3', { layer: '0', colorIndex: 256, startPoint: { x: 0, y: 1 }, endPoint: { x: 1, y: 1 } }),
          ent('CIRCLE', 'B4', { layer: '0', colorIndex: 5, center: { x: 0, y: 0 }, radius: 1 }),
        ] as unknown as DwgImportPayload['entities'],
      },
      {
        name: '*Paper_Space',
        basePoint: { x: 0, y: 0 },
        description: '',
        handle: '50',
        flags: 0,
        entities: [
          ent('VIEWPORT', '200', { layer: '0', viewportId: 1, viewportCenter: { x: 133, y: 101 }, width: 300, height: 220, displayCenter: { x: 133, y: 101 }, viewHeight: 220, statusBitFlags: 32800 }),
          ent('VIEWPORT', '201', { layer: 'VP', viewportId: 2, viewportCenter: { x: 100, y: 80 }, width: 160, height: 100, displayCenter: { x: 5, y: 2 }, viewHeight: 50, statusBitFlags: 32800 | 16384, clippingBoundaryId: '2F0' }),
          ent('TEXT', '202', { layer: '0', startPoint: { x: 10, y: 10 }, text: 'TITLE', textHeight: 5, rotation: 0 }),
        ] as unknown as DwgImportPayload['entities'],
      },
    ],
    styles: [
      { name: 'Standard', standardFlag: 0, fixedTextHeight: 0, widthFactor: 1, obliqueAngle: 0, textGenerationFlag: 0, font: 'txt', bigFont: '' },
      { name: 'NOTES', standardFlag: 0, fixedTextHeight: 0, widthFactor: 0.8, obliqueAngle: Math.PI / 12, textGenerationFlag: 2, font: 'romans.shx', bigFont: '' },
      { name: 'SHAPES', standardFlag: 1, font: 'ltypeshp.shx' },
    ],
    dimStyles: [
      { name: 'Standard', DIMTXT: 0.18, DIMASZ: 0.18 },
      { name: 'MECH', DIMTXT: 3.5, DIMASZ: 2.5, DIMDEC: 1, DIMCLRD: { index: 1, rgb: 0 } },
    ],
    linetypes: [
      { name: 'ByBlock', pattern: [] },
      { name: 'Continuous', pattern: [] },
      { name: 'BORDER2X', description: 'Border (2x)', pattern: [{ elementLength: 12, elementTypeFlag: 0 }, { elementLength: -3, elementTypeFlag: 0 }, { elementLength: 4, elementTypeFlag: 0 }, { elementLength: -3, elementTypeFlag: 0 }] },
      { name: 'GAS_LINE', description: 'Gas line ----GAS----', pattern: [{ elementLength: 12.7, elementTypeFlag: 0 }, { elementLength: -5.08, elementTypeFlag: 2 }, { elementLength: -3.8, elementTypeFlag: 0 }] },
    ],
    layouts: [
      { name: 'Model', tabOrder: 0, blockHandle: '1F', minLimit: { x: 0, y: 0 }, maxLimit: { x: 12, y: 9 } },
      { name: 'Wiring', tabOrder: 1, blockHandle: '50', minLimit: { x: -7.5, y: -7.5 }, maxLimit: { x: 412.5, y: 289.5 } },
    ],
    ...extra,
  };
}

describe('DWG payload properties', () => {
  const { state, report } = convertDwg(payload(), 'synthetic.dwg');
  const lookup = (n: string) => state.blocks[n];

  it('true colours on entities and layers', () => {
    expect(state.entities[0]).toMatchObject({ type: 'line', color: 1, trueColor: 0xff8800 });
    expect(state.layers.find((l) => l.name === 'RGB')).toMatchObject({ color: 7, trueColor: 0x336699 });
    expect(resolveColor(state.entities[0]!, state.layers)).toBe(trueColorCss(0xff8800));
  });

  it('ByBlock (0) is kept distinct from ByLayer (256) and block content inherits the insert colour', () => {
    expect(state.blocks.SYM!.entities.map((e) => e.color)).toEqual([0, 'ByLayer', 5]);
    const green = explodeInsert(state.entities[1] as InsertEntity, lookup).map((e) => resolveColor(e, state.layers));
    expect(green).toEqual([aciToCss(3), aciToCss(1), aciToCss(5)]); // ByBlock -> insert green; layer-0 ByLayer -> L1 red
    const rgb = explodeInsert(state.entities[2] as InsertEntity, lookup).map((e) => resolveColor(e, state.layers));
    expect(rgb).toEqual([trueColorCss(0x336699), trueColorCss(0x336699), aciToCss(5)]); // ByLayer insert on a true-colour layer
  });

  it('layer lock and plot flags come from the layer flags', () => {
    const L = (n: string) => state.layers.find((l) => l.name === n)!;
    expect(L('0').locked).toBe(false);
    expect(L('L1').locked).toBe(true);
    expect(L('NOPLOT').plot).toBe(false);
    expect(L('0').plot).toBeUndefined();
  });

  it('custom linetypes, with complex elements reported', () => {
    expect(state.header?.linetypes).toEqual([
      { name: 'BORDER2X', description: 'Border (2x)', pattern: [12, -3, 4, -3] },
      { name: 'GAS_LINE', description: 'Gas line ----GAS----', pattern: [12.7, -5.08, -3.8] },
    ]);
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'LTYPE', action: 'simplified', reason: expect.stringMatching(/GAS_LINE: its embedded text/) }));
  });

  it('text styles (oblique in degrees, shape files skipped)', () => {
    const styles = textStylesOf(state);
    expect(Object.keys(styles).sort()).toEqual(['NOTES', 'Standard']);
    expect(styles.NOTES).toMatchObject({ font: 'romans.shx', widthFactor: 0.8, generation: 2 });
    expect(styles.NOTES!.oblique).toBeCloseTo(15, 9);
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'STYLE', action: 'unsupported' }));
  });

  it('named dimension styles, used by the dimensions that name them', () => {
    const mech = namedDimStyles(state).find((d) => d.name === 'MECH')!;
    expect(mech).toMatchObject({ textHeight: 3.5, arrowSize: 2.5, decimals: 1, dimLineColor: 1 });
    const dim = state.entities.find((e): e is DimensionEntity => e.type === 'dimension')!;
    expect(dim.style.name).toBe('MECH');
    expect(dim.style.textHeight).toBe(3.5);
  });

  it('layouts with paper-space entities and floating viewports', () => {
    expect(state.layouts).toHaveLength(1);
    const lay = state.layouts![0]!;
    expect(lay.name).toBe('Wiring');
    expect(lay.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'landscape' });
    expect(lay.margins.left).toBeCloseTo(7.5, 9);
    expect(lay.entities.map((e) => (e.type === 'text' ? [e.text, e.position.x, e.position.y] : e.type))).toEqual([['TITLE', 17.5, 17.5]]);
    expect(lay.viewports).toHaveLength(1);
    const vp = lay.viewports[0]!;
    expect(vp).toMatchObject({ center: { x: 107.5, y: 87.5 }, width: 160, height: 100, layer: 'VP', on: true });
    expect(vp.view).toEqual({ center: { x: 5, y: 2 }, scale: 2, locked: true });
    expect(state.layers.some((l) => l.name === 'VP')).toBe(true);
    // Paper-space entities are not duplicated in model space.
    expect(state.entities.some((e) => e.type === 'text')).toBe(false);
  });

  it('reports what the DWG reader does not expose, and the invalid objects', () => {
    expect(report?.format).toBe('DWG');
    expect(report?.sourcePath).toBe('synthetic.dwg');
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', action: 'unsupported', reason: expect.stringMatching(/frozen in individual viewports .* 1 viewport/) }));
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', handle: '201', action: 'simplified', reason: expect.stringMatching(/clipping boundary/) }));
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'LAYOUT', action: 'unsupported', where: 'layout "Wiring"' }));
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'CIRCLE', handle: '104', action: 'dropped', reason: expect.stringMatching(/negative radius/) }));
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'LINE', handle: '105', action: 'dropped', reason: expect.stringMatching(/a\.x is not a finite number/) }));
    expect(state.entities.some((e) => e.type === 'circle')).toBe(false);
  });

  it('everything survives the DXF writer and reader', () => {
    const back = readDxf(writeDxf(state));
    expect(back.entities[0]).toMatchObject({ trueColor: 0xff8800 });
    expect(back.layers.find((l) => l.name === 'RGB')?.trueColor).toBe(0x336699);
    expect(back.blocks.SYM!.entities.map((e) => e.color)).toEqual([0, 'ByLayer', 5]);
    expect(back.header?.linetypes.map((l) => l.name)).toEqual(['BORDER2X', 'GAS_LINE']);
    expect(Object.keys(textStylesOf(back)).sort()).toEqual(['NOTES', 'Standard']);
    expect(namedDimStyles(back).some((d) => d.name === 'MECH')).toBe(true);
    expect(back.layouts?.[0]?.viewports[0]?.view.scale).toBeCloseTo(2, 9);
    expect(back.layouts?.[0]?.entities).toHaveLength(1);
  });

  it('older payloads without the table data still convert (nothing reported about them)', () => {
    const { state: old, report: r } = convertDwg(payload({ styles: undefined, dimStyles: undefined, linetypes: undefined, layouts: undefined }));
    expect(old.layouts).toBeUndefined();
    expect(old.header?.linetypes).toEqual([]);
    expect(r?.items.some((i) => i.type === 'LAYOUT' || i.type === 'LTYPE')).toBe(false);
  });
});

describe('DWG payload twins carry the table data', () => {
  it('bounds malformed DWG precision settings and reports the normalization', () => {
    const p = payload();
    p.header = { ...p.header, DIMDEC: 9999, DIMADEC: Infinity, DIMALTD: 9999, DIMTDEC: 9999, LUPREC: 9999, AUPREC: 9999 };
    const result = convertDwg(p);
    expect(result.state.header!.units).toMatchObject({ luprec: 8, auprec: 8 });
    expect(result.report?.items).toContainEqual(expect.objectContaining({ type: 'HEADER', reason: expect.stringContaining('DIMDEC precision') }));
    const dimension = result.state.entities.find((e): e is DimensionEntity => e.type === 'dimension')!;
    expect(() => dimensionText({ ...dimension, style: result.state.header!.dimStyle })).not.toThrow();
  });

  it('rejects unsafe inline MTEXT factors with entity context', () => {
    const p = payload();
    p.entities = [{ type: 'MTEXT', handle: 'F2', layer: 'NOTES', text: '\\W1e60x;\\W1e60x;BAD', textHeight: 1, rectWidth: 10, attachmentPoint: 1, insertionPoint: { x: 0, y: 0, z: 0 } }] as unknown as DwgImportPayload['entities'];
    const result = convertDwg(p);
    expect(result.state.entities).toHaveLength(0);
    expect(result.report?.items).toContainEqual(expect.objectContaining({ type: 'MTEXT', handle: 'F2', layer: 'NOTES', where: 'model space', action: 'dropped', reason: expect.stringContaining('MTEXT formatting') }));
  });

  it('preserves exposed frozen layer handles and planar twist while reporting clipping loss', () => {
    const p = payload();
    p.layers[0]!.handle = 'A1';
    const vp = p.blocks.find((b) => b.name === '*Paper_Space')!.entities.find((e) => e.handle === '201')! as unknown as Record<string, unknown>;
    vp.frozenLayerIds = ['A1'];
    vp.viewTwistAngle = 0.25;
    const result = convertDwg(p);
    expect(result.state.layouts![0]!.viewports[0]!.frozenLayers).toEqual(['0']);
    expect(result.state.layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(0.25, 12);
    expect(result.report?.items.some((i) => i.type === 'VIEWPORT' && /untwisted/.test(i.reason))).toBe(false);
    expect(result.report?.items.some((i) => i.type === 'VIEWPORT' && i.reason.includes('show every layer'))).toBe(false);
    expect(readDxf(writeDxf(result.state)).layouts![0]!.viewports[0]!.frozenLayers).toEqual(['0']);
  });

  it('preserves exposed page settings and records unsupported device/style data', () => {
    const p = payload();
    p.layouts!.find((l) => l.name === 'Wiring')!.plotSettings = { paperWidth: 297, paperHeight: 420, plotPaperUnit: 1, plotRotation: 1, marginLeft: 5, marginBottom: 6, marginRight: 7, marginTop: 8, printScaleNominator: 1, printScaleDenominator: 2, configName: 'MyPlotter.pc3', currentStyleSheet: 'custom.ctb' };
    const result = convertDwg(p);
    expect(result.state.layouts![0]).toMatchObject({ paper: { id: 'a3', orientation: 'landscape' }, margins: { left: 5, bottom: 6, right: 7, top: 8 }, plotScale: '1:2' });
    expect(result.report?.items).toContainEqual(expect.objectContaining({ type: 'LAYOUT', reason: expect.stringContaining('plot device and external plot style') }));
  });

  it('bounds DWG record counts, strings and nested metadata', () => {
    expect(() => convertDwg({ ...payload(), entities: Array(250_001).fill({ type: 'LINE' }) })).toThrow(/record limit/);
    expect(() => convertDwg({ ...payload(), header: { NOTE: 'x'.repeat(1_048_577) } })).toThrow(/string length limit/);
    let nested: unknown = 'x';
    for (let i = 0; i < 66; i += 1) nested = { child: nested };
    expect(() => convertDwg({ ...payload(), header: { NOTE: nested } })).toThrow(/nesting/);
  });

  it('reports omitted object metadata and conservative XDATA reader limits', () => {
    const result = convertDwg({ ...payload(), omittedObjectTypes: { XRECORD: 4, FIELD: 2 } });
    expect(result.report?.items).toContainEqual(expect.objectContaining({ type: 'XRECORD', action: 'dropped', reason: expect.stringContaining('4 object metadata') }));
    expect(result.report?.items).toContainEqual(expect.objectContaining({ type: 'XDATA', action: 'unsupported', reason: expect.stringContaining('cannot be guaranteed') }));
  });

  it('the desktop and the browser reader build the same payload with styles, dimension styles, linetypes and layouts', () => {
    const db = {
      header: {},
      entities: [],
      tables: {
        LAYER: { entries: [{ name: '0', colorIndex: 256, color: 0x123456, off: false, frozen: false, locked: true, lineweight: 31, lineType: 'Continuous', standardFlag: 16, plotFlag: 1 }] },
        BLOCK_RECORD: { entries: [] },
        STYLE: { entries: [{ name: 'NOTES', standardFlag: 0, fixedTextHeight: 0, widthFactor: 0.8, obliqueAngle: 0.1, textGenerationFlag: 0, font: 'romans.shx', bigFont: '', handle: '40' }] },
        DIMSTYLE: { entries: [{ name: 'MECH', DIMTXT: 3.5, handle: '41' }] },
        LTYPE: { entries: [{ name: 'BORDER2X', description: 'B', standardFlag: 0, numberOfLineTypes: 2, totalPatternLength: 15, pattern: [{ elementLength: 12, elementTypeFlag: 0, scale: 1 }, { elementLength: -3, elementTypeFlag: 0 }] }] },
      },
      objects: { LAYOUT: [{ layoutName: 'Layout1', tabOrder: 1, paperSpaceTableId: '50', minLimit: { x: 0, y: 0 }, maxLimit: { x: 10, y: 5 }, handle: '51' }] },
    };
    const node = payloadFromDatabase(db, 'R_2018');
    const browser = toImportPayload(db as unknown as Parameters<typeof toImportPayload>[0], 'R_2018');
    expect(node).toEqual(browser);
    expect(node.layers[0]).toMatchObject({ color: 0x123456, standardFlag: 16, plotFlag: 1 });
    expect(node.styles).toEqual([{ name: 'NOTES', handle: '40', standardFlag: 0, fixedTextHeight: 0, widthFactor: 0.8, obliqueAngle: 0.1, textGenerationFlag: 0, font: 'romans.shx', bigFont: '' }]);
    expect(node.linetypes[0].pattern).toEqual([{ elementLength: 12, elementTypeFlag: 0 }, { elementLength: -3, elementTypeFlag: 0 }]);
    expect(node.layouts).toEqual([{ name: 'Layout1', tabOrder: 1, blockHandle: '50', minLimit: { x: 0, y: 0 }, maxLimit: { x: 10, y: 5 } }]);
    expect(node.dimStyles[0]).toMatchObject({ name: 'MECH', DIMTXT: 3.5 });
  });
});
